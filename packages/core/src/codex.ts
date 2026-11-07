// smol-toml publishes a CJS runtime alongside ESM declarations.
const { parse: parseToml } = require('smol-toml') as { parse(text: string): Record<string, unknown> };
import { codexUsageState } from './codex-events';
/**
 * Codex-native capture: hooks + rollout mining.
 *
 * codex (>= 0.147.0, `hooks` feature stable) ships a hook system that speaks Claude Code's payload
 * dialect on purpose — `session_id` / `cwd` / `hook_event_name` / `tool_name` / `tool_input` /
 * `tool_response`, with the shell tool literally renamed "Bash" for matcher compatibility. That is
 * the same contract `capture.ts` has parsed since 0.4, so this module is an ADAPTER, not a second
 * capture pipeline: codex events funnel into `handleHookPayload` (Bash and per-file staging reuse),
 * lifecycle events land in the hook lifecycle journal consumed by feed/observe readers, and everything codex volunteers beyond Claude's contract (`turn_id`, `model`,
 * `permission_mode`, `transcript_path` → the rollout file) is kept, not dropped.
 *
 * Two sources, one rule: EDITS come from hooks;
 * the ROLLOUT supplies what transcripts supply for Claude — prompts, prose, tokens (with the cache
 * split), model, the tool-call timeline. Rollout mining never creates edit records, so there is no
 * third voice in the dedupe conversation.
 *
 * Verified against a live 0.147.0 spike (isolated CODEX_HOME, real gpt-oss turns): payload shapes,
 * silent-skip-when-untrusted, rollout record shapes, and `originator` self-labeling ("claude-observatory"
 * for driven sessions, "codex_exec" for ambient ones).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { storeDir, ensureStore, appendSkip, clearAbandonedToolStaging, rootDir, captureOutsideMoves, isSafeSessionId } from './store';
import { handleHookPayload, noteToolCall, missedCapture, HookPayload } from './capture';
import { appendCaptureEvent } from './capture-events';
import { priceUsage } from './pricing';
import { codexPromptText, codexTranscriptFile, codexUsageDeltas } from './codex-events';
import { cachedByFiles, readLines } from './fscache';
import { plainTitle } from './format';
import { canonPath } from './paths';
import { graphemeHead } from './graphemes';

/** $CODEX_HOME override honored the way codex itself honors it (verified: sessions/config land there). */
export function codexHome(): string {
  const env = process.env.CODEX_HOME;
  return env && env.trim() ? env : path.join(os.homedir(), '.codex');
}

/** Hook vocabulary verified against Codex 0.153.4, including Interrupt. */
export const CODEX_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const;

export interface CodexHookPayload extends HookPayload {
  /** codex's turn id — its `prompt_id`. Threaded into records as `promptId`. */
  turn_id?: string;
  /** Absolute path of the rollout file — codex's transcript analog. */
  transcript_path?: string;
  model?: string;
  permission_mode?: string;
  tool_response?: unknown;
  prompt?: string;
  reason?: string;
  source?: string;
  subagent?: unknown;
  agent_id?: string;
  agent_type?: string;
  model_provider?: string;
}

// ---------------------------------------------------------------------------
// apply_patch parsing
// ---------------------------------------------------------------------------

export interface PatchEntry {
  op: 'update' | 'add' | 'delete';
  file: string;
  /** `*** Move to:` target when a rename accompanies an update. */
  moveTo?: string;
}

/**
 * Parse the FILE HEADERS of codex's apply_patch envelope ("*** Begin Patch" … "*** End Patch").
 * Hunk content is deliberately ignored: the Pre/Post staging machinery snapshots the real files on
 * disk, which is strictly more trustworthy than re-implementing their patch application.
 */
export function parseCodexPatch(text: string): PatchEntry[] {
  const entries: PatchEntry[] = [];
  let current: PatchEntry | null = null;
  for (const line of text.split('\n')) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line.trim());
    if (m) {
      current = { op: m[1].toLowerCase() as PatchEntry['op'], file: m[2].trim() };
      entries.push(current);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line.trim());
    if (mv && current) current.moveTo = mv[1].trim();
  }
  return entries;
}

/**
 * The patch text hides in different fields depending on the tool surface (`{patch}` on the wire we
 * measured; `{command: ["apply_patch", text]}` / `{command: text}` / `{input}` per the source's
 * block-message path). Tolerant on purpose — and a payload with NO recoverable patch text returns
 * null so the caller can leave a loud marker instead of silently capturing nothing.
 */
export function extractPatchText(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const t = toolInput as Record<string, unknown>;
  if (typeof t.patch === 'string' && t.patch.includes('*** Begin Patch')) return t.patch;
  if (typeof t.input === 'string' && t.input.includes('*** Begin Patch')) return t.input;
  if (typeof t.command === 'string' && t.command.includes('*** Begin Patch')) return t.command;
  if (Array.isArray(t.command)) {
    const hit = t.command.find((c) => typeof c === 'string' && c.includes('*** Begin Patch'));
    if (typeof hit === 'string') return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Agent meta (which sessions are codex's, and where their rollout lives)
// ---------------------------------------------------------------------------

export interface CodexAgentMeta {
  agent: 'codex';
  transcriptPath?: string;
  model?: string;
  permissionMode?: string;
  updated: number;
  cwd?: string;
  provider?: string;
}

function agentMetaPath(session: string): string {
  return path.join(storeDir(session), 'agent.json');
}

export function readCodexAgentMeta(session: string): CodexAgentMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(agentMetaPath(session), 'utf8'));
    return parsed && parsed.agent === 'codex' ? (parsed as CodexAgentMeta) : null;
  } catch {
    return null;
  }
}

/**
 * Is this the working folder of Codex's memory-writing agent? Codex runs that agent as an ephemeral thread
 * of its own, in `<CODEX_HOME>/memories` (`memories_v2` for its second memory format), inside the process of
 * the session that started it: its hooks carry that session's herdr pane, its own thread id, a `startup`
 * SessionStart and no transcript. It is never the pane's own session. Paths compare as written, then by
 * their real paths, so a symlinked CODEX_HOME (or macOS's /var for /private/var) still matches. Codex's
 * default home (`~/.codex`) counts as well, by HOME and by the account's own home folder: Codex runs each
 * hook with its own environment through the person's login shell (`$SHELL -lc`, Codex 0.156 to 0.160.1),
 * whose startup files can change CODEX_HOME or HOME before the hook reads them.
 */
export function isCodexMemoryCwd(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const at = canonPath(path.resolve(cwd));
  const dir = path.basename(at);
  // Only a folder of that name is compared, so a project's row costs no lookup.
  if (dir !== 'memories' && dir !== 'memories_v2') return false;
  const home = codexHome();
  const parentIs = (h: string | null) => h !== null && canonPath(path.resolve(h)) === path.dirname(at);
  if (parentIs(home) || parentIs(path.join(os.homedir(), '.codex')) || parentIs(accountCodexHome())) return true;
  const real = (p: string) => { try { return canonPath(fs.realpathSync.native(p)); } catch { return null; } };
  const memoriesReal = real(path.join(home, dir)); // a missing folder is no memory thread's; the cwd is resolved only when it exists
  return memoriesReal !== null && memoriesReal === real(at);
}

/** Codex's default home in the account's own home folder, which no environment changes; read once. */
let accountHome: string | null | undefined;
function accountCodexHome(): string | null {
  if (accountHome === undefined) {
    try { accountHome = path.join(os.userInfo().homedir, '.codex'); } catch { accountHome = null; /* an account with no home entry */ }
  }
  return accountHome;
}

/** A recorded Codex session that is the memory-writing agent's thread (see `isCodexMemoryCwd`). */
export function isCodexMemorySession(session: string): boolean {
  return isCodexMemoryCwd(readCodexAgentMeta(session)?.cwd);
}

/**
 * Does Codex's Auto-review, rather than the person, answer this session's permission prompts? Codex
 * sends a prompt to its guardian reviewer when the thread's `approvals_reviewer` is `auto_review` (or
 * the legacy `guardian_subagent`) and its approval policy is `on-request` or granular, and to the
 * person otherwise. The rollout records both in each turn's `turn_context` and in the
 * `thread_settings_applied` a change during a thread writes, so the last of those is the setting in
 * force. It is read from the end, since a long turn can put it megabytes back, no further back than
 * ROLLOUT_SCAN_BYTES, and memoized on the rollout's size: an unchanged rollout is not read again. The
 * rollout is the session's own (the root thread's): a subagent's hooks name the subagent's rollout,
 * which `upsertAgentMeta` never records.
 */
export function codexAutoReview(session: string): boolean {
  const file = readCodexAgentMeta(session)?.transcriptPath;
  if (!file) return false;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return false;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const memo = autoReviewMemo.get(file);
    if (memo && memo.size === size) return memo.auto;
    const s = lastApprovalSettings(fd, size);
    const policy = s?.approval_policy;
    const auto = !!s && (s.approvals_reviewer === 'auto_review' || s.approvals_reviewer === 'guardian_subagent')
      && (policy === 'on-request' || (!!policy && typeof policy === 'object' && 'granular' in policy));
    autoReviewMemo.set(file, { size, auto });
    return auto;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

const autoReviewMemo = new Map<string, { size: number; auto: boolean }>();
const REVIEWER_KEY = Buffer.from('"approvals_reviewer":"');

/** How far back from its end a rollout is searched. A turn's records sit well inside it; an older Codex
 *  that records no approval settings would otherwise be read whole, hundreds of megabytes, on every hand. */
export const ROLLOUT_SCAN_BYTES = 32 << 20;
const SCAN_CHUNK = 1 << 20;
const NL = Buffer.from('\n');
/** The longest rollout line read whole: a settings record is a few KB. */
const LINE_CAP = 4 << 20;

/** Where `needle` last starts in the file before `before`, no earlier than `floor`; -1 if nowhere. Read
 *  backwards in chunks that overlap by the needle's length, so a match across a chunk boundary is found. */
function lastIndexIn(fd: number, needle: Buffer, before: number, floor: number): number {
  for (let end = before; end > floor;) {
    const start = Math.max(floor, end - SCAN_CHUNK);
    const buf = Buffer.alloc(Math.min(before, end + needle.length - 1) - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const i = buf.lastIndexOf(needle);
    if (i >= 0) return start + i;
    end = start;
  }
  return -1;
}

/** The line holding byte `at`: where it starts, and its text up to LINE_CAP bytes. */
function lineAt(fd: number, at: number, size: number, floor: number): { from: number; text: string } {
  const from = lastIndexIn(fd, NL, at, floor) + 1;
  const line = Buffer.alloc(Math.min(size, from + LINE_CAP) - from);
  fs.readSync(fd, line, 0, line.length, from);
  const nl = line.indexOf(NL);
  return { from, text: line.subarray(0, nl < 0 ? line.length : nl).toString('utf8') };
}

/** The approval settings of the rollout's last `turn_context` or `thread_settings_applied` record. */
function lastApprovalSettings(fd: number, size: number): { approvals_reviewer?: unknown; approval_policy?: unknown } | null {
  const floor = Math.max(0, size - ROLLOUT_SCAN_BYTES);
  for (let before = size; before > floor;) {
    const at = lastIndexIn(fd, REVIEWER_KEY, before, floor);
    if (at < 0) return null;
    const { from, text } = lineAt(fd, at, size, floor);
    try {
      const o = JSON.parse(text);
      const p = o?.payload;
      if (o?.type === 'turn_context' && p) return p;
      if (o?.type === 'event_msg' && p?.type === 'thread_settings_applied' && p.thread_settings) return p.thread_settings;
    } catch {
      /* a torn last line, still being written: look further back */
    }
    before = from;
  }
  return null;
}

/** The `event_msg` records that bound a turn, as the rollout fixtures and the readers that already key on them
 *  (agentPhaseDetail, the conversation adapter) know them: true for its start, false for its two ends. Each holds
 *  one of the two needles; a line that holds one only inside a tool's output is not such a record. */
const TURN_BOUNDARY: Record<string, boolean> = { task_started: true, task_complete: false, turn_aborted: false };
const TURN_NEEDLES = [Buffer.from('"type":"task_'), Buffer.from('"type":"turn_aborted"')];

/**
 * The last turn boundary in the bytes from `floor` to `size` (true for a start, false for an end, undefined for none),
 * read back from the end a chunk at a time, and where the file's last line break ends (`floor` when there is none).
 * `lineStart`: a line begins at `floor`; otherwise the line cut there is not read. The first chunk is small, as a
 * finished turn's end is the last record or close to it; each one after doubles, up to SCAN_CHUNK.
 */
function lastTurnBoundary(fd: number, size: number, floor: number, lineStart: boolean): { boundary?: boolean; whole: number } {
  let whole = -1;
  // The start of the line cut at `end`, read in the step before: it runs on to a line break.
  let carry = Buffer.alloc(0);
  for (let end = size, step = 64 << 10; end > floor; step = Math.min(SCAN_CHUNK, step * 2)) {
    const start = Math.max(floor, end - step);
    const chunk = Buffer.alloc(end - start);
    fs.readSync(fd, chunk, 0, chunk.length, start);
    const block = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    if (whole < 0) {
      const nl = block.lastIndexOf(0x0a);
      if (nl >= 0) whole = start + nl + 1;
    }
    // Up to its first line break, a block holds the end of a line that began before it, unless a line begins there.
    const cut = start > floor || !lineStart;
    const first = cut ? block.indexOf(0x0a) : -1;
    for (let before = cut && first < 0 ? 0 : block.length; before > 0;) {
      const at = Math.max(...TURN_NEEDLES.map((needle) => block.lastIndexOf(needle, before - 1)));
      if (at <= first) break;
      const from = block.lastIndexOf(0x0a, at) + 1;
      const to = block.indexOf(0x0a, at);
      try {
        const o = JSON.parse(block.subarray(from, to < 0 ? block.length : to).toString('utf8'));
        const type = o?.type === 'event_msg' ? o.payload?.type : undefined;
        if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(TURN_BOUNDARY, type)) {
          return { boundary: TURN_BOUNDARY[type], whole: whole < 0 ? floor : whole };
        }
      } catch {
        /* a torn last line, still being written: look further back */
      }
      before = from;
    }
    carry = cut ? block.subarray(0, first < 0 ? block.length : first) : Buffer.alloc(0);
    end = start;
  }
  return { whole: whole < 0 ? floor : whole };
}

/** What the last read of each rollout found: its stamp, where its last whole line ended and the bytes before that. */
const turnScans = new Map<string, { ino: number; size: number; mtimeMs: number; whole: number; anchor: Buffer; open: boolean | null }>();

/** The bytes just before `at`: unchanged at a later read, the file was only appended to since. */
function anchorAt(fd: number, at: number): Buffer {
  const bytes = Buffer.alloc(Math.min(64, at));
  fs.readSync(fd, bytes, 0, bytes.length, at - bytes.length);
  return bytes;
}

/**
 * Whether the rollout's last turn is still running: its last turn boundary is a `task_started`, with no
 * `task_complete` or `turn_aborted` after it. Read back from the end until that boundary, no further than
 * ROLLOUT_SCAN_BYTES. Codex only appends to a rollout, so one read before is read again only from where its last
 * whole line ended: a long turn is not read whole on every listing. False for a rollout that holds no turn; null
 * when that is unknown: the file cannot be read, or its last boundary lies past the scan.
 */
export function codexTurnOpen(file: string): boolean | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { ino, size, mtimeMs } = fs.fstatSync(fd);
    const last = turnScans.get(file);
    if (last && last.ino === ino && last.size === size && last.mtimeMs === mtimeMs) return last.open;
    const window = Math.max(0, size - ROLLOUT_SCAN_BYTES);
    const grew = last && last.ino === ino && size > last.size && last.whole >= window && anchorAt(fd, last.whole).equals(last.anchor) ? last : undefined;
    const floor = grew ? grew.whole : window;
    const scan = lastTurnBoundary(fd, size, floor, !!grew || floor === 0);
    const open = scan.boundary ?? (grew ? grew.open : floor > 0 ? null : false);
    turnScans.delete(file);
    if (turnScans.size >= 1024) turnScans.delete(turnScans.keys().next().value!);
    turnScans.set(file, { ino, size, mtimeMs, whole: scan.whole, anchor: anchorAt(fd, scan.whole), open });
    return open;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Write-if-changed: this runs on every hook event, and identical content must cost one read, not a write. */
function upsertAgentMeta(session: string, p: CodexHookPayload): void {
  const existing = readCodexAgentMeta(session);
  const next: CodexAgentMeta = {
    agent: 'codex',
    cwd: p.cwd || existing?.cwd,
    provider: p.model_provider || existing?.provider,
    // A subagent's hooks name another rollout: its own, or on its SubagentStop its parent's, itself a
    // subagent's when subagents nest. Only the main agent's hooks name the session's.
    transcriptPath: (p.agent_id ? undefined : p.transcript_path) || existing?.transcriptPath,
    model: p.model || existing?.model,
    permissionMode: p.permission_mode || existing?.permissionMode,
    updated: existing?.updated ?? Date.now(),
  };
  if (
    existing &&
    existing.cwd === next.cwd && existing.provider === next.provider &&
    existing.transcriptPath === next.transcriptPath &&
    existing.model === next.model &&
    existing.permissionMode === next.permissionMode
  ) {
    return;
  }
  next.updated = Date.now();
  // tmp + rename, 0600 like the rest of the store: written in place, a reader (the listings, every hook of the session)
  // could find the file half written and read no Codex session at all, and a new file took the default mode.
  const file = agentMetaPath(session);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* capture must never block an edit over metadata */
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing was left */
    }
  }
}

// ---------------------------------------------------------------------------
// The hook adapter
// ---------------------------------------------------------------------------

/**
 * Synthesize one per-file Claude-shaped payload so `handleHookPayload` runs the EXACT staging,
 * blob, dedupe, ignore and no-silent-fail logic every other captured edit runs. `tool_name: 'Edit'`
 * because that is a CAPTURED_TOOL with `file_path` resolution; the record's tool column then names
 * the same operation vocabulary reviewers already know.
 */
function perFilePayload(p: CodexHookPayload, event: string, file: string): HookPayload {
  return {
    session_id: p.session_id,
    cwd: p.cwd,
    hook_event_name: event,
    tool_name: 'Edit',
    original_tool_name: 'apply_patch',
    runtime: 'codex', model: p.model, provider: p.model_provider ?? p.provider,
    tool_use_id: p.tool_use_id,
    prompt_id: p.turn_id,
    native_turn_id: p.native_turn_id,
    tool_input: { file_path: file },
  };
}

function patchFiles(p: CodexHookPayload): string[] | null {
  const text = extractPatchText(p.tool_input);
  if (text === null) return null;
  const files: string[] = [];
  for (const e of parseCodexPatch(text)) {
    files.push(e.file);
    if (e.moveTo) files.push(e.moveTo); // a rename changes TWO paths; disk truth records both sides
  }
  return files;
}

/**
 * Record one codex hook payload. Tool events funnel into the shipping capture machinery; lifecycle
 * events land in capture-events.jsonl for feed, observe and store retention. Never throws, never writes
 * stdout (a PermissionRequest hook's stdout would be read as a DECISION — observation must stay
 * mute). `eventMs` is when the hook started (capture.ts noteToolCall); the hook process passes its own.
 */
export function handleCodexHookPayload(p: CodexHookPayload, eventMs = Date.now()): void {
  try {
    const session = p.session_id;
    if (!session || !p.hook_event_name) return;
    ensureStore(session);
    upsertAgentMeta(session, p);
    // The memory-writing agent runs inside the pane's own session: linking it, or naming a tab after it,
    // took the pane's identity and its tab's name from that session (both tabs read "Codex memory update").
    const background = isCodexMemoryCwd(p.cwd);
    if (!background) {
      // The tab↔session link, same as claude's hooks (the app exports OAK_TAB into a native tab's PTY).
      const { linkTab } = require('./capture') as typeof import('./capture');
      linkTab(session, 'codex', p.hook_event_name === 'SessionStart' ? p.source || 'startup' : undefined);
    }
    p = { ...p, runtime: 'codex', model: p.model ?? readCodexAgentMeta(session)?.model, provider: p.model_provider ?? readCodexAgentMeta(session)?.provider };
    const nativeTurn = p.turn_id;
    const canonicalTurn = nativeTurn;
    p = { ...p, turn_id: canonicalTurn, native_turn_id: nativeTurn };
    const ev = p.hook_event_name;

    if (ev === 'PreToolUse' || ev === 'PostToolUse') {
      // Who is waiting on the reader, for EVERY tool and on the call's own payload — before the capture
      // below, which reads Bash and apply_patch only (and an apply_patch as per-file payloads).
      noteToolCall(session, p, eventMs);
      if (p.tool_name === 'Bash') {
        // codex's Bash payload IS Claude's Bash payload (verified live) — one adaptation: promptId.
        handleHookPayload({ ...p, prompt_id: p.turn_id });
        return;
      }
      if (p.tool_name === 'apply_patch') {
        const files = patchFiles(p);
        if (files === null) {
          // A real edit whose shape we could not read. Loud marker, never a silent miss.
          if (ev === 'PostToolUse') appendSkip(session, '<apply-patch>', 'apply_patch ran but its patch text was not recoverable from the hook payload — edit not captured');
          return;
        }
        for (const f of files) handleHookPayload(perFilePayload(p, ev, f));
        return;
      }
      // Read-only / unknown tools: nothing to capture.
      return;
    }

    // A turn boundary, or a thread resumed in a pane: its title may have changed, or the pane's tab may
    // not wear it yet, so the herdr tab follows it (detached, as Claude's hooks do).
    if (!background && (ev === 'UserPromptSubmit' || ev === 'Stop' || (ev === 'SessionStart' && p.source === 'resume'))) {
      (require('./herdr-link') as typeof import('./herdr-link')).kickTabSync(session);
    }
    if (ev === 'UserPromptSubmit') {
      const { clearAttention } = require('./capture') as typeof import('./capture'); clearAttention(session);
      // Hook lifecycle evidence supplies session titles, the feed's live rule and the
      // transcript-less observe rows work unchanged for ambient codex sessions.
      if (canonicalTurn === nativeTurn) appendCaptureEvent(session, 'turn_start', { promptId: p.turn_id, nativeTurnId: nativeTurn, prompt: p.prompt ?? '', model: p.model, runtime: 'codex' });
      return;
    }
    if (ev === 'PermissionRequest') {
      const { writeAttention, askOf } = require('./capture') as typeof import('./capture');
      writeAttention(session, { kind: 'permission', message: String(p.tool_name ?? 'tool'), ts: Date.now() }, askOf(p));
      // Request-only: codex reports the ask, never the answer, through this event. The feed's
      // pairing already tolerates an outcome that never arrives. NOTHING goes to stdout — an empty
      // reply is the documented "no decision" and observation must never become adjudication.
      appendCaptureEvent(session, 'permission_request', {
        toolCall: { toolCallId: p.tool_use_id ?? null, title: String(p.tool_name ?? 'tool') },
        options: [],
        codexToolInput: p.tool_input ?? null,
      });
      return;
    }
    if (ev === 'SessionStart' || ev === 'SessionEnd' || ev === 'Stop' || ev === 'Interrupt') {
      const { writeAttention, clearAttention } = require('./capture') as typeof import('./capture');
      if (ev === 'SessionStart') clearAttention(session);
      else writeAttention(session, { kind: 'idle-done', message: ev === 'Interrupt' ? 'interrupted' : '', ts: Date.now() });
      // The turn is over, so a Pre whose Post never came is abandoned: drop it, as Claude's Stop does,
      // or every later edit of that file reads as overlapping it (ambiguous, and undo refuses).
      if (ev === 'Stop') clearAbandonedToolStaging(session);
      appendCaptureEvent(session, 'agent_session', {
        phase: ev === 'SessionStart' ? 'start' : ev === 'SessionEnd' ? 'end' : 'stop',
        source: p.source,
        reason: p.reason,
        model: p.model,
      });
      return;
    }
    if (ev === 'PreCompact' || ev === 'PostCompact') {
      appendCaptureEvent(session, 'compact', { phase: ev === 'PreCompact' ? 'pre' : 'post' });
      return;
    }
    if (ev === 'SubagentStart' || ev === 'SubagentStop') {
      if (ev === 'SubagentStop') (require('./capture') as typeof import('./capture')).noteSubagentStop(session, p.agent_id);
      appendCaptureEvent(session, 'subagent', { phase: ev === 'SubagentStart' ? 'start' : 'stop', context: p.agent_id ? { agentId: p.agent_id, agentType: p.agent_type ?? null, parentSessionId: session } : p.subagent ?? null });
      return;
    }
  } catch {
    // Silent by design: capture must never block, slow, or perturb the agent.
  }
}

/** stdin → payload → record. The codex twin of `runCapture`; the caller owns exit(0). */
export function runCodexCapture(): void {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return;
    const payload = JSON.parse(raw) as CodexHookPayload;
    captureOutsideMoves(() => handleCodexHookPayload(payload, performance.timeOrigin), missedCapture(payload));
    if (payload.hook_event_name === 'PreToolUse' && payload.tool_name === 'apply_patch') {
      const files = patchFiles(payload);
      if (files) (require('./edit-heads-up') as typeof import('./edit-heads-up')).emitEditHeadsUp(payload.session_id, payload.cwd, files);
    }
  } catch {
    /* silent by design */
  }
}

// ---------------------------------------------------------------------------
// Rollout mining — codex's transcript analog
// ---------------------------------------------------------------------------

export interface CodexRolloutSummary {
  sessionId: string | null;
  /** "claude-observatory" for sessions our drive spawned; "codex_exec"/"codex" for ambient ones. */
  originator: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  provider: string | null;
  prompts: string[];
  lastAssistantMessage: string | null;
  toolCalls: { name: string; args: string }[];
  /** Observatory semantics: input + output + cacheCreation, EXCLUDING cache reads (the same rule the
   *  Claude usage cursor enforces); the split is kept alongside. codex's `input_tokens` includes its
   *  cached share on OpenAI-style backends, so the cached share is subtracted rather than assumed
   *  disjoint. Measured against gpt-oss (all cache fields zero); the subtraction is the documented
   *  OpenAI contract, restated here because no local backend can exercise it. */
  tokens: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  turns: number;
}

export function readCodexRollout(file: string): CodexRolloutSummary {
  return cachedByFiles('codex-summary-v3', [file], () => {
    const out: CodexRolloutSummary = { sessionId: null, originator: null, cwd: null, model: null, effort: null, provider: null,
      prompts: [], lastAssistantMessage: null, toolCalls: [], tokens: null, turns: 0 };
    const derived = codexTranscriptFile(file); if (!derived) return out;
    for (const line of readLines(derived)) {
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      out.sessionId = o.sessionId || out.sessionId; out.cwd = o.cwd || out.cwd; out.provider = o.provider || out.provider;
      out.model = o.message?.model || o.model || out.model; out.effort = o.message?.effort || out.effort;
      if (o.subtype === 'task_started') out.turns++;
      for (const b of o.message?.content ?? []) {
        if (b.type === 'text' && o.message.role === 'user') { const prompt = codexPromptText(b.text); if (prompt) out.prompts.push(prompt); }
        if (b.type === 'text' && o.message.role === 'assistant') out.lastAssistantMessage = b.text;
        if (b.type === 'tool_use') out.toolCalls.push({ name: b.originalName || b.name, args: JSON.stringify(b.input) });
      }
      if (o.usageOnly) {
        const u = o.message.usage;
        out.tokens ??= { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        out.tokens.input += u.input_tokens + u.cache_read_input_tokens; out.tokens.output += u.output_tokens;
        out.tokens.cacheRead += u.cache_read_input_tokens; out.tokens.cacheWrite += u.cache_creation_input_tokens;
        out.tokens.total += u.input_tokens + u.output_tokens + u.cache_creation_input_tokens;
      }
    }
    try { const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(derived), 'cursor.json'), 'utf8')); const c = saved.preview ?? saved; out.originator = c.originator || null; out.effort = c.effort || out.effort; out.model = c.model || out.model; out.provider = c.provider || out.provider; } catch {}
    return out;
  });
}

/** The files a Codex title was read from besides its own rollout and Codex's thread names (a brief its prompt hands its
 *  task to, the session an Auto-review thread reviews), collected while `codexTitleInputs` runs: the local index reads a
 *  title again when one of them changes. */
let titleReads: Set<string> | null = null;
export function codexTitleInputs<T>(read: () => T): { value: T; files: string[] } {
  const outer = titleReads;
  const mine = new Set<string>();
  titleReads = mine;
  try {
    return { value: read(), files: [...mine] };
  } finally {
    titleReads = outer;
    if (outer) for (const f of mine) outer.add(f);
  }
}

/** Codex 0.154 stores user-visible names in session_index.jsonl. The last record for an id
 * wins; key the cache to the INDEX too so a rename updates even if the rollout does not move.
 * The name, else the rollout's own title, else the first real prompt, then goes through `taskTitle`,
 * and comes out as one line of plain text (`plainTitle`). */
export function codexSessionTitle(file: string, id: string): string | null {
  return codexTitle(file, id, true);
}

function codexTitle(file: string, id: string, followReview: boolean): string | null {
  const index = path.join(codexHome(), 'session_index.jsonl');
  const titles = cachedByFiles('codex-thread-titles', [index], () => {
    const out = new Map<string, string>();
    try { for (const line of readLines(index)) {
      try { const r = JSON.parse(line); const name = r.thread_name ?? r.title;
        if (typeof r.id === 'string' && typeof name === 'string' && name.trim()) out.set(r.id, name.trim());
      } catch { /* torn index line */ }
    } } catch { /* older Codex has no index */ }
    return out;
  });
  const meta = codexRolloutHead(file)?.meta;
  // Codex's Auto-review sends each approval to a `guardian` subagent thread with a rollout of its own,
  // whose one prompt is Codex's assessment request wrapped around the reviewed session's transcript.
  // Its task is reviewing that session, so it is named after it (found among the listed rollouts: a
  // search of Codex's tree per row would repeat on every listing for a parent that is gone).
  if (meta && isReviewMeta(meta)) {
    if (!followReview) return null;
    const parent = meta.parent_thread_id;
    const parentFile = typeof parent === 'string' && parent !== id ? codexSessionSources().find((s) => s.id === parent)?.file ?? '' : '';
    if (parentFile) titleReads?.add(parentFile);
    const reviewed = typeof parent === 'string' && parent !== id ? codexTitle(parentFile, parent, false) : null;
    return reviewed ? `Auto-review: ${reviewed}` : 'Auto-review';
  }
  // Codex's memory-writing agent runs as an EPHEMERAL thread in `<CODEX_HOME>/memories`: it writes no
  // rollout, so only its hooks report it, from that folder. Its one prompt is Codex's template
  // ("## Memory Writing Agent: Phase 2 (Consolidation)" and 50 KB more), which names nothing.
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : readCodexAgentMeta(id)?.cwd;
  if (isCodexMemoryCwd(cwd)) return CODEX_MEMORY_TITLE;
  // Only a name that asks for something to be carried out can hand its task to a brief the prompt
  // names; every other name is kept at the cost of the index lookup alone.
  const named = titles.get(id);
  const state = named && !wordsOf(named).some((w) => CARRY_OUT.has(w)) ? null : titleState(file);
  const prompt = state?.firstPrompt || null;
  const given = named || state?.title || prompt;
  const title = taskTitle(given, prompt, typeof meta?.cwd === 'string' ? meta.cwd : null);
  const plain = title && (plainTitle(title) || null);
  // OAK derived it (a brief's heading, or the prompt itself) rather than Codex or the person naming it.
  const derived = title !== given || (!named && !state?.title);
  return plain && derived ? firstPhrase(plain) : plain;
}

/** A long derived title's first phrase. A phrase keeps 12 characters and two words (brief headings written
 *  as goal sentences made Codex titles less useful, and so did a first prompt's long first sentence). The
 *  first sentence (through a `.`, `?` or `!` before a space, as a Claude row cuts its first prompt) wins
 *  when it ends within 64 characters, so a leading clause such as "In packages/core" never stands alone.
 *  Otherwise the shortest phrase among the clause breaks (` — `, `: `, `; `, `, `) and that sentence. A
 *  whole phrase, never an ellipsis: a title of 64 characters or fewer (a list row's length) stays whole,
 *  and so does one with no break. */
function firstPhrase(text: string): string {
  if (text.length <= 64) return text;
  const phrase = (c: string | undefined): c is string => !!c && c.length >= 12 && /\s/.test(c); // a phrase, not a lone `file.ts`
  const sentence = /^(.*?[.?!])(?=\s)/.exec(text)?.[1]?.trim();
  if (phrase(sentence) && sentence.length <= 64) return sentence;
  // Prefixes grow with each break, so the first one that is a phrase is the shortest.
  let clause: string | undefined;
  for (const m of text.matchAll(/\s*(?:\s[—–]\s|[:;,]\s)/g)) {
    const c = text.slice(0, m.index).trim();
    if (phrase(c)) { clause = c; break; }
  }
  return [clause, sentence].filter(phrase).sort((a, b) => a.length - b.length)[0] ?? text;
}

/** What a Codex memory-writing thread is listed as, beside the guardian's "Auto-review". */
export const CODEX_MEMORY_TITLE = 'Codex memory update';

/** A rollout's own title and first prompt, cached on the rollout's stamp: an Auto-review row asks for
 *  its parent's, and re-reading the parent's cursor per row made a listing scale with both. */
function titleState(file: string): { title: string; firstPrompt: string } | null {
  try {
    return cachedByFiles('codex-title-state', [file], () => {
      const state = codexUsageState(file);
      if (!state) throw new Error('not derived'); // never cache a miss: the next call derives again
      return { title: state.title, firstPrompt: state.firstPrompt };
    });
  } catch {
    return null;
  }
}

// A title should say what the task is. Handing an agent a brief ("Read WIDGET-TASK.md … and carry it
// out") leaves Codex's name for the thread ("Execute WIDGET-TASK.md", "Complete widget task") and the
// prompt itself naming only the file the task is written in; the brief's own heading names the task.

/** A hand-off asks for a brief to be carried out; merely reading one ("Read README.md") is not one. */
const CARRY_OUT = new Set(['follow', 'execute', 'run', 'complete', 'carry', 'do', 'perform', 'implement']);
/** The words a hand-off is made of, besides the brief's own name. */
const HANDOFF_WORDS = new Set([...CARRY_OUT, 'read', 'out', 'and', 'then', 'the', 'a', 'an', 'in', 'it', 'this',
  'that', 'which', 'references', 'task', 'file', 'brief', 'instructions', 'current', 'directory', 'completely', 'exactly']);
/** A markdown file named in text: a bare name, or a relative, absolute, drive-letter or `~/` path, with
 *  either separator; never part of a URL. */
const MARKDOWN_REF = /(?<![^\s(\[`'"])(?:[A-Za-z]:[\\/])?(?:[\p{L}\p{N}_.~+@-]+[\\/]|[\\/])*[\p{L}\p{N}_.+@-]+\.(?:md|markdown)(?!\.?[\p{L}\p{N}_\\/-])/giu;
const wordsOf = (text: string): string[] => text.toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? [];

/** The words of `text` that are neither hand-off words nor words of `file`'s name. */
function ownWords(text: string, file: string | null): string[] {
  const name = new Set(file ? wordsOf(path.win32.basename(file)) : []);
  return wordsOf(text).filter((w) => !HANDOFF_WORDS.has(w) && !name.has(w));
}

/**
 * The brief a title only hands its task off to, or null. Its first sentence must ask for something to
 * be carried out, and once the files it names are set aside, keep no word beyond hand-off words and the
 * words of one brief's name: a brief it names itself, else one the prompt names (Codex's name for the
 * thread can keep a brief's words and drop the file, "Complete widget task"). A title with no word of
 * its own follows the prompt's own hand-off; one with a word of its own beyond the brief's name
 * ("Review WIDGET-TASK.md wording") says more than the brief's name.
 */
function handoffTarget(title: string, prompt: string | null): string | null {
  const line = title.trim().split(/\r?\n/, 1)[0];
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line;
  // A hand-off is one short sentence; a longer one says more, and would cost a scan on every listing.
  if (sentence.length > 512 || !wordsOf(sentence).some((w) => CARRY_OUT.has(w))) return null;
  const own = sentence.match(MARKDOWN_REF) ?? [];
  const rest = own.reduce((text, ref) => text.split(ref).join(' '), sentence);
  const briefOf = (ref: string): boolean => ownWords(rest, ref).length === 0;
  const hit = own.find(briefOf);
  if (hit || !prompt || prompt === title) return hit ?? null;
  if (!ownWords(rest, null).length) return handoffTarget(prompt, null);
  return (graphemeHead(prompt, 4096).match(MARKDOWN_REF) ?? []).find(briefOf) ?? null; // the prompt names its brief up front
}

/** A markdown document's title: its first line when that is a heading, without the `#`s and without a
 *  leading "Task:" / "Task (…):" label. Exported for tests. */
export function markdownTitle(text: string): string | null {
  const first = text.trimStart().split(/\r?\n/, 1)[0]; // trimStart also drops a byte-order mark
  // The lookahead pins the blank run to its full length: without it, a line that runs into a bare CR
  // retried every shorter run against the whole rest of the line (quadratic).
  const heading = /^#{1,6}[ \t]+(?![ \t])(.*)$/.exec(first)?.[1].replace(/(?:^|[ \t])#+[ \t]*$/, '');
  return heading?.replace(/^task(?:\s*\([^)]*\))?\s*:/i, '').replace(/\s+/g, ' ').trim() || null;
}

/** A brief's title, from its first 8 KiB on this machine; cached on the file's stamp, so an edit shows. */
function briefTitle(file: string): string | null {
  titleReads?.add(file);
  return cachedByFiles('codex-brief-title', [file], () => {
    try {
      if (!fs.statSync(file).isFile()) return null; // never open a FIFO, or a directory named *.md
      const fd = fs.openSync(file, 'r');
      try {
        const b = Buffer.alloc(8192);
        const n = fs.readSync(fd, b, 0, b.length, 0);
        return markdownTitle(b.toString('utf8', 0, n));
      } finally { fs.closeSync(fd); }
    } catch {
      return null;
    }
  });
}

/** Where a brief named in a session lives: `~/`, absolute, or relative to the session's workspace; an
 *  `@` mention names the same file. A network (UNC) path is never read. */
function briefPath(ref: string, cwd: string | null): string | null {
  const file = ref.replace(/^@/, '');
  if (/^[\\/]{2}/.test(file)) return null;
  if (/^~[\\/]/.test(file)) return path.join(os.homedir(), file.slice(2));
  if (path.isAbsolute(file)) return file;
  return cwd && path.isAbsolute(cwd) && !/^[\\/]{2}/.test(cwd) ? path.resolve(cwd, file) : null;
}

/**
 * The task a Codex title names. A brief pasted as the prompt is named by its heading, when that reads as
 * a title rather than a section label ("Context"); a title that only hands the task off to a brief is
 * named by that brief's heading. Anything else is kept, and so is a hand-off whose brief is gone or
 * whose heading only repeats the file's name.
 */
function taskTitle(title: string | null, prompt: string | null, cwd: string | null): string | null {
  if (!title) return null;
  const pasted = markdownTitle(title);
  if (pasted && ownWords(pasted, null).length >= 2) return pasted;
  const ref = handoffTarget(title, prompt);
  const file = ref ? briefPath(ref, cwd) : null;
  const heading = file ? briefTitle(file) : null;
  return heading && ownWords(heading, file).length ? heading : title;
}

export interface CodexSessionMeta { id?: string; session_id?: string; cwd?: string; parent_thread_id?: unknown; thread_source?: unknown; source?: unknown }

/** Does this session_meta record one of Auto-review's `guardian` threads: by the thread source newer
 *  Codex writes, or the subagent source it writes as well (the only one an older Codex wrote)? */
function isReviewMeta(meta: CodexSessionMeta): boolean {
  const source = meta.source as { subagent?: { other?: unknown } } | undefined;
  return meta.thread_source === 'guardian_review' || source?.subagent?.other === 'guardian';
}

/**
 * A rollout's head, read once per file stamp: its session_meta, whether a user message appears, and
 * whether the WHOLE file fit in the buffer. A rollout that fit entirely yet carries no user message is
 * an empty stub (a launch that died before its first turn — a failed sandbox, an app-server probe);
 * listing it as a session is noise. A large file has content by definition. Null when unreadable.
 */
/** What a rollout's head says (`codexRolloutHead`): its session_meta, whether a user message appears, and whether the whole
 *  file fit in the buffer. */
export interface CodexRolloutHead { meta: CodexSessionMeta | null; userMsg: boolean; whole: boolean }

export function codexRolloutHead(file: string): CodexRolloutHead | null {
  try {
    return cachedByFiles('codex-head', [file], () => {
      const fd = fs.openSync(file, 'r');
      try {
        const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, 0);
        let meta: CodexSessionMeta | null = null, userMsg = false;
        for (const line of b.toString('utf8', 0, n).split('\n')) {
          try {
            const o = JSON.parse(line); const p = o.payload ?? o;
            if (!meta && o.type === 'session_meta') meta = o.payload;
            if (p && (p.type === 'user_message' || (o.type === 'response_item' && p.type === 'message' && p.role === 'user'))) userMsg = true;
          } catch { /* torn line */ }
          if (meta && userMsg) break; // nothing later can change the answer; the listing reads every head
        }
        return { meta, userMsg, whole: n < b.length };
      } finally { fs.closeSync(fd); }
    });
  } catch {
    return null; // raced with deletion, or no rollout at all
  }
}

/** `review`: an Auto-review thread (`isReviewMeta`), read from the head the scan reads anyway. */
export interface CodexSessionSource { id: string; cwd: string; file: string; mtimeMs: number; archived: boolean; review: boolean }
// resolveSessionId calls this once per unresolved store session (via describeSession), so without a
// memo a store of N sessions × M rollouts walks the codex tree N times — the dominant per-invocation
// cost before any work begins (measured 118ms→583ms as rollouts grow). A short TTL collapses a burst
// of calls to one walk while a long-lived process still sees a new session within the window; the key
// includes codexHome() so a CODEX_HOME change (tests, relocation) invalidates immediately.
let sourcesMemo: { at: number; home: string; val: CodexSessionSource[] } | null = null;
/** What `codexSessionSources` reads, for a caller that already holds it: the rollouts newest first with their
 *  modification times, each one's head, and whether it is a mirrored copy (the local index answers all three from what
 *  it recorded at the file's stamp). */
export interface CodexSourceReader {
  rollouts(): { file: string; mtimeMs: number }[];
  head(file: string): CodexRolloutHead | null;
  mirrored(file: string): boolean;
}
/** A throwaway run's workspace that is gone: a temp-dir scratch from a probe or an old review, which the listings hide.
 *  Scoped to temp roots so a real project on an unmounted drive is never dropped. Asked when a listing is made, since
 *  the folder can go after the session was last read (the local index asks it again for the facts it holds). */
export function goneTempWorkspace(cwd: string): boolean {
  const tmpRoots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders'].map((r) => path.resolve(r) + path.sep);
  return tmpRoots.some((r) => path.resolve(cwd).startsWith(r)) && !fs.existsSync(cwd);
}

export function codexSessionSources(reader?: CodexSourceReader): CodexSessionSource[] {
  const home = codexHome();
  const now = Date.now();
  if (!reader && sourcesMemo && sourcesMemo.home === home && now - sourcesMemo.at < 1000) return sourcesMemo.val;
  const out: CodexSessionSource[] = [];
  const files = reader ? reader.rollouts() : recentCodexRollouts(Number.MAX_SAFE_INTEGER).map((file) => ({ file, mtimeMs: -1 }));
  for (const { file, mtimeMs } of files) {
    try {
      const head = reader ? reader.head(file) : codexRolloutHead(file);
      const meta = head?.meta;
      const id = meta?.id ?? meta?.session_id;
      if (!head || typeof id !== 'string' || typeof meta?.cwd !== 'string') continue;
      // An id no store path can take (a rollout written by hand, or damaged) is no session OAK can list: listed, the
      // first store lookup threw and took the whole listing with it.
      if (!isSafeSessionId(id)) continue;
      if (head.whole && !head.userMsg) continue;                       // empty stub — no conversation
      const cwd = meta.cwd;
      if (reader ? reader.mirrored(file) : (require('./session') as typeof import('./session')).isMirroredTranscript(file).mirrored) continue;
      if (goneTempWorkspace(cwd)) continue;
      out.push({ id, cwd, file,
        mtimeMs: mtimeMs >= 0 ? mtimeMs : fs.statSync(file).mtimeMs, archived: file.startsWith(path.join(codexHome(), 'archived_sessions') + path.sep), review: isReviewMeta(meta) });
    } catch { /* raced with deletion */ }
  }
  if (!reader) sourcesMemo = { at: now, home, val: out };
  return out;
}

/**
 * Every `.jsonl` name under codex's two trees, in the order a lookup prefers them: the live `sessions`
 * tree before `archived_sessions`, newest shard first within each. ONE walk per burst of lookups (the
 * window `codexSessionSources` uses), reading directories only: a listing looks up every NON-Codex
 * session id as well, and each of those misses used to walk and stat the whole tree again — 256 ms of a
 * 537 ms `oak sessions --json` on 51 rollouts, and 5 s of 5.6 s with 1,000 more.
 */
let rolloutNamesMemo: { at: number; home: string; names: string[]; files: string[]; foreign: boolean } | null = null;
/** The name Codex gives a rollout, which carries its session id (checked against every session_meta
 *  on two machines, 2026-09-26): `rollout-<timestamp>-<uuid>.jsonl`. */
const CODEX_ROLLOUT_NAME = /^rollout-.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
function rolloutNames(): { names: string[]; files: string[]; foreign: boolean } {
  const home = codexHome();
  const now = Date.now();
  if (rolloutNamesMemo && rolloutNamesMemo.home === home && now - rolloutNamesMemo.at < 1000) return rolloutNamesMemo;
  const names: string[] = [];
  const files: string[] = [];
  let foreign = false; // any name that does not carry its id, so only its head can say whose it is
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Newest shards first: the target is almost always today's directory.
    for (const e of entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))) {
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.jsonl')) { names.push(e.name); files.push(full); foreign ||= !CODEX_ROLLOUT_NAME.test(e.name); }
      let dirent = e.isDirectory();
      if (!dirent && e.isSymbolicLink()) try { dirent = fs.statSync(full).isDirectory(); } catch { /* dangling */ }
      if (dirent) walk(full, depth + 1);
    }
  };
  walk(path.join(home, 'sessions'), 0);
  walk(path.join(home, 'archived_sessions'), 0);
  rolloutNamesMemo = { at: now, home, names, files, foreign };
  return rolloutNamesMemo;
}

/**
 * Locate the rollout for a session: the hook-provided path first (exact), the sessions tree second
 * (the filename embeds the session id — verified shape `rollout-<ts>-<id>.jsonl` under YYYY/MM/DD).
 */
const rolloutPaths = new Map<string, string>();
export function findCodexRollout(session: string): string | null {
  if (!session) return null;
  const key = `${codexHome()}:${session}`;
  const cached = rolloutPaths.get(key);
  if (cached && fs.existsSync(cached)) return cached;
  const meta = readCodexAgentMeta(session);
  if (meta?.transcriptPath && fs.existsSync(meta.transcriptPath)) return meta.transcriptPath;
  const suffix = `-${session}.jsonl`;
  const tree = rolloutNames();
  const at = tree.names.findIndex((n) => n.endsWith(suffix));
  // When every name is Codex's own, a miss is final. The head scan reads every rollout, and a Claude
  // session is a miss every time: the statusline asks for one on each render.
  const result = (at >= 0 ? tree.files[at] : null)
    ?? (tree.foreign ? codexSessionSources().find((x) => x.id === session)?.file ?? null : null);
  if (result) { if (rolloutPaths.size > 2048) rolloutPaths.delete(rolloutPaths.keys().next().value!); rolloutPaths.set(key, result); }
  return result;
}

// ---------------------------------------------------------------------------
// Installer — the Orca manners on ~/.codex (the
// "never write another agent's config" rule is amended to "write it politely")
// ---------------------------------------------------------------------------

/** The dedicated per-layer hooks file — the politest write available: JSON (lossless round-trip),
 *  ours to upsert surgically, and codex's own preferred single-representation for a layer. */
export function codexHooksJsonPath(): string {
  return path.join(codexHome(), 'hooks.json');
}

export function codexConfigTomlPath(): string {
  return path.join(codexHome(), 'config.toml');
}

/** The snake_case labels codex uses in BOTH the state key and the trust identity
 *  (`hook_event_key_label` — NOT the TOML config key's PascalCase). Getting this wrong is invisible
 *  until a hook silently doesn't run, which is exactly how it was found: the first replication
 *  hashed PascalCase and the no-bypass oracle run captured nothing. */
const CODEX_EVENT_LABEL: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
  Interrupt: 'interrupt',
};

/**
 * codex's trust identity, replicated: sha256 over the canonical (key-sorted) JSON of the TOML-shaped
 * NormalizedHookIdentity — `{event_name: <snake_case label>, hooks: [normalized handler]}`. The
 * handler is hashed POST-normalization, which bakes in the effective timeout (600s default; 1s for
 * SessionEnd, whose cap is 3s) and the serde-default `async: false`; None-valued options are absent
 * (TOML cannot carry them). REPLICATION IS A HYPOTHESIS about a foreign binary: the install-time
 * positive control exists precisely because this hash must never be trusted on faith — a codex
 * upgrade that drifts it lands as a loud "hooks not firing", never a silent capture gap.
 */
export function codexHookHash(eventName: string, command: string): string {
  const identity = {
    event_name: CODEX_EVENT_LABEL[eventName] ?? eventName,
    hooks: [{ async: false, command, timeout: ['SessionEnd', 'Interrupt'].includes(eventName) ? 1 : 600, type: 'command' }],
  };
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) sorted[k] = canonical((v as Record<string, unknown>)[k]);
      return sorted;
    }
    return v;
  };
  const hex = crypto.createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
  return `sha256:${hex}`;
}

export function codexHookKey(hooksJsonPath: string, eventName: string, groupIndex: number): string {
  // Verified format: "{key_source}:{snake_case label}:{group_index}:{handler_index}" — key_source is
  // the source file's display path, handler_index 0 because we install exactly one handler per group.
  return `${hooksJsonPath}:${CODEX_EVENT_LABEL[eventName] ?? eventName}:${groupIndex}:0`;
}

interface CodexHooksFile {
  [key: string]: unknown;
  description?: string;
  hooks: Record<string, { matcher?: string; hooks: { type: string; command?: string; [k: string]: unknown }[] }[]>;
}

function readHooksJson(file: string): CodexHooksFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const hooks = parsed.hooks ?? {};
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
    if (Object.values(hooks).some((groups) => !Array.isArray(groups) || groups.some((g) => !g || !Array.isArray(g.hooks)))) return null;
    return { ...parsed, hooks };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null; // unreadable ≠ absent — refuse to guess
  }
  return { hooks: {} };
}

const STATE_HEADER_RE = /^\[hooks\.state\."(.*)"\]\s*$/;

function ownedStateKeys(parsed: CodexHooksFile, isOurs: (cmd: string) => boolean): Set<string> {
  const keys = new Set<string>();
  for (const [ev, groups] of Object.entries(parsed.hooks)) groups.forEach((g, gi) => g.hooks.forEach((h, hi) => {
    if (typeof h.command === 'string' && isOurs(h.command)) keys.add(codexHookKey(codexHooksJsonPath(), ev, gi).replace(/:0$/, `:${hi}`));
  }));
  try { const ledger = JSON.parse(fs.readFileSync(path.join(codexHome(), 'oak-hooks-ledger.json'), 'utf8'));
    if (ledger.file === codexHooksJsonPath() && typeof ledger.command === 'string' && isOurs(ledger.command) && Array.isArray(ledger.keys)) for (const k of ledger.keys) if (typeof k === 'string') {
      const match = /:([^:]+):(\d+):(\d+)$/.exec(k);
      if (!match || !k.startsWith(codexHooksJsonPath() + ':')) continue;
      const handler = match ? parsed.hooks[Object.keys(CODEX_EVENT_LABEL).find(ev => CODEX_EVENT_LABEL[ev] === match[1]) ?? match[1]]?.[Number(match[2])]?.hooks?.[Number(match[3])] : undefined;
      if (!handler || typeof handler.command === 'string' && isOurs(handler.command)) keys.add(k);
    }
  } catch { /* first installation */ }
  return keys;
}
function readConfig(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}
function atomicConfigWrite(file: string, text: string, expected?: string): void {
  if (expected !== undefined && readConfig(file) !== expected) throw new Error(`${file} changed during installation; retry after its writer finishes`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file);
}

/**
 * Surgical, append-only trust-state editing. config.toml is the user's file with the user's
 * comments: existing lines are NEVER rewritten — our stale state tables (matched by table header)
 * are removed as whole blocks, fresh ones appended at EOF. Anything else in the file survives
 * byte-for-byte. A table's `enabled` is the user's own switch (Codex writes it), so a fresh
 * table keeps the value its predecessor had: a reinstall never turns back on a hook the user turned off.
 */
function upsertStateTables(content: string, entries: { key: string; hash: string }[], owned: Set<string>): string {
  const states = (parseToml(content).hooks as { state?: Record<string, { enabled?: unknown }> } | undefined)?.state;
  // A byte order mark that opens the file stays first, also when the table after it is one of ours.
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = content.slice(bom.length);
  const lines = body.length ? body.split('\n') : [];
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[/.test(line);
    if (header) skipping = false;
    const m = STATE_HEADER_RE.exec(line.trim());
    if (m && owned.has(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))) {
      skipping = true;
      continue;
    }
    if (!skipping) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const out = kept.join('\n');
  const tables = entries
    .map(({ key, hash }) => {
      const enabled = states?.[key]?.enabled;
      return `[hooks.state."${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]\ntrusted_hash = "${hash}"` +
        (typeof enabled === 'boolean' ? `\nenabled = ${enabled}` : '');
    })
    .join('\n\n');
  return `${bom}${out}${out.length ? '\n\n' : ''}${tables}\n`;
}

export interface CodexInstallResult {
  hooksJson: 'created' | 'updated' | 'unchanged';
  statePath: string;
  stateWritten: boolean;
  /** Set when a pre-touch copy of config.toml was made this run. */
  backupPath?: string;
  foreignGroups: number;
  events: string[];
}

/**
 * Install (or refresh) our capture hooks for codex. One matcher-less group per event whose single
 * handler is our command; OUR groups are recognized by the command string (the same `isOurCommand`
 * idiom the Claude installer uses) and replaced in place — foreign groups are never touched,
 * reordered, or deduped. Trust state goes to config.toml as append-only tables (see above); the
 * installer reports configuration separately from observed lifecycle and edit evidence.
 * The optional test/codex-config-probe.js checks native trust without starting a model turn.
 */
export function installCodexHooks(command: string, isOurs: (cmd: string) => boolean): CodexInstallResult {
  const file = codexHooksJsonPath();
  const parsed = readHooksJson(file);
  if (parsed === null) throw new Error(`${file} is unreadable or malformed; installation left it unchanged`);
  const originalHooks = readConfig(file);
  const configPath = codexConfigTomlPath();
  const config = readConfig(configPath);
  const settings = parseToml(config); // validate TOML without rewriting foreign settings/comments
  if ((settings.features as {hooks?: boolean})?.hooks === false) throw new Error('Codex hooks are explicitly disabled in [features].hooks; enable them before installing capture');
  const owned = ownedStateKeys(parsed, isOurs);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let changed = false, foreignGroups = 0;
  const entries: { key: string; hash: string }[] = [];
  for (const ev of CODEX_HOOK_EVENTS) {
    const groups = parsed.hooks[ev] ?? [];
    let ownIndex = -1;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const mine = (h: { command?: unknown }) => typeof h.command === 'string' && isOurs(h.command);
      const foreign = g.hooks.filter((h) => !mine(h));
      const hasOurs = foreign.length !== g.hooks.length;
      if (foreign.length) foreignGroups++;
      if (hasOurs && !foreign.length && ownIndex < 0) ownIndex = i;
      else if (hasOurs) {
        // Removing our handler from a mixed group must not shift a FOREIGN handler that FOLLOWS it:
        // codex's trust keys embed the handler index (`…:<group>:<handler>`), so a shift silently
        // unbinds that foreign hook. Safe only when every one of ours is at the tail; otherwise we
        // refuse rather than break someone else's trust (their index is not ours to re-key).
        const firstOurs = g.hooks.findIndex(mine);
        const lastForeign = g.hooks.reduce((mx, h, j) => (mine(h) ? mx : j), -1);
        if (firstOurs < lastForeign) {
          throw new Error(`Codex ${ev} hook group interleaves the observatory handler before a foreign one; move the observatory handler to its own group first so the foreign hook's trust binding is preserved`);
        }
        groups[i] = { ...g, hooks: foreign }; changed = true;
      }
    }
    const ours = { hooks: [{ type: 'command', command }] };
    if (ownIndex < 0) { ownIndex = groups.length; groups.push(ours); changed = true; }
    else if (JSON.stringify(groups[ownIndex]) !== JSON.stringify(ours)) { groups[ownIndex] = ours; changed = true; }
    parsed.hooks[ev] = groups;
    const key = codexHookKey(file, ev, ownIndex); owned.add(key);
    entries.push({ key, hash: codexHookHash(ev, command) });
  }
  const nextConfig = upsertStateTables(config, entries, owned);
  parseToml(nextConfig);
  const stateWritten = nextConfig !== config;
  let backupPath: string | undefined;
  if (stateWritten && config) { backupPath = `${configPath}.bak`; fs.copyFileSync(configPath, backupPath); fs.chmodSync(backupPath, 0o600); }
  if (changed && originalHooks) { fs.copyFileSync(file, `${file}.bak`); fs.chmodSync(`${file}.bak`, 0o600); }
  const nextHooks = JSON.stringify(parsed, null, 2) + '\n';
  let hooksWritten = false, configWritten = false;
  try {
    if (changed) { atomicConfigWrite(file, nextHooks, originalHooks); hooksWritten = true; }
    if (stateWritten) { atomicConfigWrite(configPath, nextConfig, config); configWritten = true; }
    atomicConfigWrite(path.join(codexHome(), 'oak-hooks-ledger.json'), JSON.stringify({ version: 1, file, command, keys: entries.map((e) => e.key) }) + '\n');
  } catch (error) {
    // Roll back only bytes we still own. An external writer always wins over rollback.
    for (const [target, previous, written, didWrite] of [[file, originalHooks, nextHooks, hooksWritten], [configPath, config, nextConfig, configWritten]] as const) {
      if (!didWrite) continue;
      try { if (readConfig(target) === written) { if (previous) atomicConfigWrite(target, previous, written); else fs.unlinkSync(target); } } catch {}
    }
    throw error;
  }
  return { hooksJson: changed ? (originalHooks ? 'updated' : 'created') : 'unchanged', statePath: configPath,
    stateWritten, backupPath, foreignGroups, events: [...CODEX_HOOK_EVENTS] };
}

export interface CodexUninstallResult {
  hooksJson: 'removed' | 'pruned' | 'absent';
  stateRemoved: boolean;
}

export function uninstallCodexHooks(isOurs: (cmd: string) => boolean): CodexUninstallResult {
  const file = codexHooksJsonPath();
  const parsed = readHooksJson(file);
  if (!parsed) throw new Error(`${file} is unreadable or malformed; uninstall left it unchanged`);
  const owned = ownedStateKeys(parsed, isOurs);
  const configPath = codexConfigTomlPath(), config = readConfig(configPath), original = readConfig(file);
  parseToml(config);
  let foreign = 0;
  for (const [ev, groups] of Object.entries(parsed.hooks)) {
    parsed.hooks[ev] = groups.map((g) => {
      const hooks = g.hooks.filter((h) => !(typeof h.command === 'string' && isOurs(h.command)));
      foreign += hooks.length;
      return { ...g, hooks }; // retain indices: foreign trust identities include group positions
    });
  }
  for (const ev of Object.keys(parsed.hooks)) {
    while (parsed.hooks[ev].length && parsed.hooks[ev].at(-1)!.hooks.length === 0) parsed.hooks[ev].pop();
    if (!parsed.hooks[ev].length) delete parsed.hooks[ev];
  }
  let hooksJson: CodexUninstallResult['hooksJson'] = 'absent';
  if (original) {
    const metadata = Object.keys(parsed).some((k) => k !== 'hooks');
    if (!foreign && !metadata) { fs.unlinkSync(file); hooksJson = 'removed'; }
    else { atomicConfigWrite(file, JSON.stringify(parsed, null, 2) + '\n', original); hooksJson = 'pruned'; }
  }
  const next = upsertStateTables(config, [], owned);
  const stateRemoved = next !== config;
  if (stateRemoved) atomicConfigWrite(configPath, next, config);
  try { fs.unlinkSync(path.join(codexHome(), 'oak-hooks-ledger.json')); } catch {}
  return { hooksJson, stateRemoved };
}

/**
 * Remove the status line the bundled status line's installer configured in Codex's config.toml: the lines it
 * marks `# oak-statusline`, and the `[tui]` table it added when nothing of the person's is left in it. A
 * `[tui]` header of the installer's with keys the person added under it stays, as does any other line. A
 * byte order mark first stays first. True when the file changed.
 */
export function uninstallCodexStatusline(file: string = codexConfigTomlPath()): boolean {
  const text = readConfig(file);
  if (!text.includes('# oak-statusline')) return false;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = text.slice(bom.length).split('\n');
  const ours = (ln: string): boolean => ln.includes('# oak-statusline');
  // A CRLF file's lines keep their CR here (Windows' Python writes one in text mode): it is no part of a header,
  // and a line of it alone is blank, as the installer reads it.
  const header = (ln: string): boolean => /^\s*\[\s*tui\s*\]\s*(#.*)?$/.test(ln.replace(/\r$/, ''));
  const blank = (ln: string): boolean => ln === '' || ln === '\r';
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ours(lines[i])) { out.push(lines[i]); continue; }
    if (!header(lines[i])) continue;
    // The table runs to the next header: kept while anything of the person's is in it.
    let j = i + 1;
    while (j < lines.length && !/^\s*\[/.test(lines[j]) && (!lines[j].trim() || ours(lines[j]))) j++;
    if (j < lines.length && !/^\s*\[/.test(lines[j])) { out.push(lines[i]); continue; }
    // Dropped, with the blank line the installer put before it.
    if (out.length && blank(out[out.length - 1])) out.pop();
  }
  while (out.length && blank(out[out.length - 1])) out.pop();
  const next = bom + (out.length ? out.join('\n') + '\n' : '');
  if (next === text) return false;
  atomicConfigWrite(file, next, text);
  return true;
}

export interface CodexHooksStatus {
  hooksJsonPath: string;
  installed: boolean;
  installedCommand: string | null;
  foreignGroups: number;
  /** 'trusted' = every event's state table matches our replicated hash; 'partial'/'missing' are the
   *  silent-skip danger zones and render as warnings, because codex will NOT say why hooks are off. */
  trust: 'trusted' | 'partial' | 'missing' | 'no-config';
  disabled?: boolean;
  /** The events whose hook of ours the user turned off in Codex (`enabled = false` in its state table,
   *  Codex's own switch). Codex shows that itself, so it is not a trust problem, and OAK leaves it. */
  userDisabled: string[];
  configError?: string;
}

export function codexHooksStatus(isOurs: (cmd: string) => boolean): CodexHooksStatus {
  const file = codexHooksJsonPath();
  const parsed = readHooksJson(file);
  let installed = false;
  let installedCommand: string | null = null;
  let foreignGroups = 0;
  const ourIdx: Record<string, number> = {};
  if (parsed) {
    for (const ev of Object.keys(parsed.hooks)) {
      const groups = Array.isArray(parsed.hooks[ev]) ? parsed.hooks[ev] : [];
      const idx = groups.findIndex((g) => (Array.isArray(g.hooks) ? g.hooks : []).some((h) => typeof h.command === 'string' && isOurs(h.command)));
      if (idx >= 0) {
        installed = true;
        ourIdx[ev] = idx;
        const hit = groups[idx].hooks.find((h) => typeof h.command === 'string' && isOurs(h.command));
        installedCommand = (hit?.command as string) ?? installedCommand;
      }
      foreignGroups += groups.filter((_, i) => i !== idx).length;
    }
  }
  let trust: CodexHooksStatus['trust'] = 'no-config';
  let disabled = false, configError: string | undefined;
  const userDisabled: string[] = [];
  if (installed && installedCommand) {
    try {
      const config = fs.readFileSync(codexConfigTomlPath(), 'utf8');
      const settings = parseToml(config);
      disabled = (settings.features as {hooks?: boolean})?.hooks === false;
      const states = (settings.hooks as {state?: Record<string, {trusted_hash?: string; enabled?: boolean}>})?.state;
      let have = 0;
      const want = CODEX_HOOK_EVENTS.length;
      for (const [ev, idx] of Object.entries(ourIdx)) {
        const group = parsed!.hooks[ev][idx];
        const hi = group.hooks.findIndex(h => typeof h.command === 'string' && isOurs(h.command));
        const handler = group.hooks[hi];
        // The replicated hash describes the installer shape. A manually changed matcher,
        // timeout or handler type must not be called trusted using the old shape's hash.
        if (group.matcher !== undefined || handler.type !== 'command' || Object.keys(handler).some(k => !['type','command'].includes(k))) continue;
        const key = codexHookKey(file, ev, idx).replace(/:0$/, `:${hi}`);
        const state = states?.[key];
        const hash = codexHookHash(ev, handler.command!);
        if (!(CODEX_HOOK_EVENTS as readonly string[]).includes(ev)) continue;
        if (state?.trusted_hash === hash) have += 1;
        if (state?.enabled === false) userDisabled.push(ev);
      }
      trust = !disabled && have === want ? 'trusted' : have > 0 ? 'partial' : 'missing';
    } catch (e) {
      trust = 'no-config'; configError = String((e as Error).message);
    }
  }
  return { hooksJsonPath: file, installed, installedCommand, foreignGroups, trust, disabled, userDisabled, configError };
}

// ---------------------------------------------------------------------------------------------
// What codex reports about its OWN quota and spend
// ---------------------------------------------------------------------------------------------

/**
 * codex's rate-limit snapshot, as codex itself defines it.
 *
 * The field names are not guessed: they are the `RateLimitSnapshot`, `RateLimitWindow`,
 * `CreditsSnapshot` and `SpendControlLimitSnapshot` structs the shipped codex binary declares
 * (0.147.0), and the same shape appears verbatim on `payload.rate_limits` in its rollouts.
 *
 * Which window is which is READ, never assumed: `window_minutes` says so (300 = the 5-hour window,
 * 10080 = the weekly one), because codex calls them `primary`/`secondary` and an ordering
 * assumption would silently mislabel one account's quota as another's.
 */
export interface CodexUsage {
  /** 0-100, or null when this account has no such window (a local model, an unlimited plan). */
  fivePct: number | null;
  weekPct: number | null;
  /** ms epoch, or null. */
  fiveReset: number | null;
  weekReset: number | null;
  /** Dollars of credit left, when codex reports a balance. `unlimited` says the account has no
   *  ceiling — a different fact from a zero balance, and never rendered as `$0`. */
  creditBalance: number | null;
  creditsUnlimited: boolean;
  /** A spend control, when one is configured: the ceiling and how much of it is left. */
  spendLimit: number | null;
  spendRemainingPct: number | null;
  /** The token split this session spent, from codex's own `TokenUsage`. */
  tokens: { input: number; output: number; cacheRead: number; total: number } | null;
  /** The LAST turn's context: total tokens in context vs the model's window — codex reports
   *  both per turn (last_token_usage.total_tokens / model_context_window). Null until a turn. */
  ctxTokens: number | null;
  ctxSize: number | null;
  /** When the windowed snapshot was written (rollout mtime, ms) — freshest-wins across machines. */
  snapshotMs: number | null;
}

const EMPTY_CODEX_USAGE = (): CodexUsage => ({
  fivePct: null,
  weekPct: null,
  fiveReset: null,
  weekReset: null,
  creditBalance: null,
  creditsUnlimited: false,
  spendLimit: null,
  spendRemainingPct: null,
  tokens: null,
  ctxTokens: null,
  ctxSize: null,
  snapshotMs: null,
});

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `resets_at` may be epoch seconds or an ISO string, depending on codex's version. Both, or null. */
function resetMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Older codex wrote `resets_in_seconds` in place of `resets_at`: the seconds the window had left when the reading was
 *  taken, so it resets at the reading's own timestamp plus them, never at now plus them. Null when the window carries
 *  no such count, or the reading no timestamp: nothing then dates the reset (the rollout's mtime moves with every later
 *  line, and an ended window read from it opened again). */
function resetAfter(seconds: unknown, readAt: number | null): number | null {
  const s = numOrNull(seconds);
  return s === null || readAt === null ? null : Math.round(readAt + s * 1000);
}

/**
 * Read what codex last reported about the account's quota, credit and spend.
 *
 * codex writes a fresh `rate_limits` record on every turn that talks to its backend, so the LAST
 * one in the newest rollout is the current state. A local model reports every field null — which is
 * the truth for it, not a gap to fill in.
 *
 * `file` scans that rollout only; without it, the newest rollout under `$CODEX_HOME/sessions`.
 */
export function codexUsage(file?: string): CodexUsage {
  if (file) return codexUsageFile(file);
  // The NEWEST rollout can be a just-opened session carrying no rate_limits yet (measured live
  // 2026-09-09: a 1-line stub erased the whole gpt readout on the Mac). One `codex` launch must
  // not blank the windows — walk back to the newest rollout that actually carries them; the
  // newest file still answers for the token split when none carries windows at all.
  const recents = recentCodexRollouts(8);
  let first: CodexUsage | null = null;
  let windowed: CodexUsage | null = null;
  let ctx: CodexUsage | null = null;
  for (const f of recents) {
    const u = codexUsageFile(f);
    if (first === null) first = u;
    if (windowed === null && (u.fivePct !== null || u.weekPct !== null)) windowed = u;
    if (ctx === null && u.ctxTokens !== null && u.ctxSize !== null) ctx = u;
    if (windowed && ctx) break;
  }
  const base = windowed ?? first ?? EMPTY_CODEX_USAGE();
  // Context stays with the selected source. Per-session callers supply its exact rollout.
  return base;
}

/** Codex's built-in local providers (and the profile `ollama launch codex` writes): a turn they
 *  served costs nothing per token, so leaving it out of a dollar sum loses nothing. */
const LOCAL_CODEX_PROVIDERS = new Set(['ollama', 'lmstudio', 'ollama-launch']);

/** Cache one cumulative event series per file set; window boundaries never create new cache kinds.
 * Exact timestamp queries stay cheap even when a rolling seven-day fallback moves every poll.
 * `moUsdKnown` is false when the month holds a turn from a HOSTED provider OAK has no price for. */
export function codexCycleUsage(cycleStartMs: number, weekStartMs: number, endMs = Infinity): { moTok: number; moReads: number; moUsd: number; moUsdKnown: boolean; weekTok: number } {
  const files = recentCodexRollouts(Number.MAX_SAFE_INTEGER);
  const series = cachedByFiles('codex-cycle-events-v4', files, () => {
    const seen = new Set<string>();
    const events = files.flatMap((file) => codexUsageDeltas(file)).filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id); return true;
    }).sort((a, b) => a.ts - b.ts);
    let tok = 0, reads = 0, usd = 0, unknown = 0;
    return events.map((d) => {
      const price = priceUsage(d.provider && d.provider !== 'openai' ? `provider:${d.provider}/${d.model}` : d.model, d.usage);
      tok += d.usage.input + d.usage.output + d.usage.cacheWrite;
      reads += d.usage.cacheRead; usd += price.usd;
      unknown += price.known || LOCAL_CODEX_PROVIDERS.has(d.provider ?? '') ? 0 : 1;
      return { ts: d.ts, tok, reads, usd, unknown };
    });
  });
  const boundary = (ms: number, inclusive: boolean): number => {
    let lo = 0, hi = series.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (series[mid].ts < ms || (inclusive && series[mid].ts === ms)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const zero = { tok: 0, reads: 0, usd: 0, unknown: 0 };
  const end = boundary(endMs, true), total = series[end - 1] ?? zero;
  const month = series[Math.min(end, boundary(cycleStartMs, false)) - 1] ?? zero;
  const week = series[Math.min(end, boundary(weekStartMs, false)) - 1] ?? zero;
  return { moTok: total.tok - month.tok, moReads: total.reads - month.reads,
    moUsd: Math.max(0, total.usd - month.usd), moUsdKnown: total.unknown === month.unknown,
    weekTok: total.tok - week.tok };
}

/** A stable, non-reversible fingerprint of the codex account this machine is signed in to
 *  (`~/.codex/auth.json` → tokens.account_id, sha256'd — the raw id never leaves the machine).
 *  This identifies the current login only; it cannot establish which account produced a historical
 *  quota event. Never attach it to an unbound rollout snapshot. Null when not signed in here. */
export function codexAccountId(): string | null {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome(), 'auth.json'), 'utf8')) as { tokens?: { account_id?: unknown } };
    const id = auth?.tokens?.account_id;
    if (typeof id === 'string' && id) return crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
  } catch {
    /* not signed in / unreadable — no identity to assert */
  }
  return null;
}

/** Reported local quota snapshots and independently measured local usage. Native rollouts do not
 * bind quota events to an account, so current login fingerprints cannot authorize remote merges. */
export interface GptUsagePanel {
  fivePct: number | null;
  fiveReset: number | null;
  weekPct: number | null;
  weekReset: number | null;
  ctxPct: number | null;
  ctxTokens: number | null;
  ctxSize: number | null;
  weekTok: number | null;
  weekTotal: number | null;
  monthStart: number;
  monthReset: number;
  monthTok: number | null;
  monthTokTotal: number | null;
  monthReads: number | null;
  monthCost: number | null;
  monthCostTotal: number | null;
  usageSource: 'database' | 'local';
  measuredMachines: string;
  usageFreshness?: string;
}

/** The weekly budget gptUsagePanel last derived from a live sample, and when: `{ weekTotal, at }` in the store
 *  root (a file, which no store walker takes for a session). A week with no sample yet, as right after Codex's
 *  weekly reset until GPT is used again, has no fill to derive it from, and the month estimate vanished. */
const GPT_WEEK_BUDGET = 'gpt-week-budget.json';
/** How long a remembered budget stands in: a few weeks with no sample, then it is no longer the plan's. */
const GPT_WEEK_BUDGET_MS = 35 * 86400_000;

function rememberedGptWeekTotal(now: number, scope: string): number | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(rootDir(), GPT_WEEK_BUDGET), 'utf8'));
    const fresh = typeof m?.at === 'number' && now - m.at >= 0 && now - m.at < GPT_WEEK_BUDGET_MS;
    return fresh && (m.scope ?? 'local') === scope && typeof m.weekTotal === 'number' && m.weekTotal > 0 ? m.weekTotal : null;
  } catch {
    return null;
  }
}

/** Keep `weekTotal` as the remembered budget, replaced whole (a temporary file renamed over it). The same
 *  value is written again only once a day, since every refresh of a status readout derives it. */
function rememberGptWeekTotal(weekTotal: number, now: number, scope: string): void {
  const file = path.join(rootDir(), GPT_WEEK_BUDGET);
  try {
    const was = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (was?.scope === scope && was?.weekTotal === weekTotal && typeof was.at === 'number' && now - was.at >= 0 && now - was.at < 86400_000) return;
  } catch { /* none yet, or unreadable: written below */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ weekTotal, at: now, scope }));
    try { fs.renameSync(tmp, file); } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
  } catch { /* a read of the usage never fails over its estimate */ }
}

/** The newest reading on this machine, taken after `since` (ms; null: any), of a 5-hour window still running at `now`,
 *  or null: what an ended window in one rollout's last reading defers to. */
function newerRunningFive(since: number | null, now: number): { pct: number; reset: number } | null {
  let best: CodexUsage | null = null;
  for (const f of recentCodexRollouts(8)) {
    const u = codexUsageFile(f);
    if (u.fivePct === null || u.fiveReset === null || u.fiveReset <= now || u.snapshotMs === null) continue;
    if (since !== null && u.snapshotMs <= since) continue;
    if (best === null || u.snapshotMs > best.snapshotMs!) best = u;
  }
  return best ? { pct: best.fivePct!, reset: best.fiveReset! } : null;
}

type GptDatabase = {
  account: string | null;
  db: import('node:sqlite').DatabaseSync;
  cycle(monthStart: number, weekStart: number, now: number): ReturnType<typeof import('./index/usage').codexWindowTotals>;
  close(): void;
};
let gptDatabase: (() => GptDatabase | null) | undefined;
/** Registered by the database API, as store hooks are: capture loads Codex without loading the database builders. */
export function setGptDatabaseReader(read: () => GptDatabase | null): void { gptDatabase = read; }

export function gptUsagePanel(session?: string, now = Date.now()): GptUsagePanel | null {
  const database = process.env.OAK_INDEX === 'off' ? null : gptDatabase?.();
  try { return gptUsageFromDatabase(session, now, database ?? undefined); }
  finally { database?.close(); }
}

function gptUsageFromDatabase(session: string | undefined, now: number, database?: GptDatabase): GptUsagePanel | null {
  const db = database?.db;
  const source = session ? findCodexRollout(session) : null;
  const live = session ? (source ? codexUsage(source) : EMPTY_CODEX_USAGE()) : codexUsage();
  let fivePct = live.fivePct;
  let fiveReset = live.fiveReset;
  let weekPct = live.weekPct;
  let weekReset = live.weekReset;
  // Only an owned account/rateLimits/read response with a backend accountId may cross machines.
  // That bound evidence outranks unbound rollout history, even after switching accounts locally.
  const { cachedCodexAccountQuota } = require('./codex-account') as typeof import('./codex-account');
  let quota = cachedCodexAccountQuota(now);
  const account = codexAccountId() ?? database?.account ?? null;
  const quotaAt = quota?.snapshotMs ?? 0;
  if (db && account) {
    for (const kind of ['five', 'week'] as const) {
      const row = db.prepare(`SELECT pct, reset_ms, measured_ms FROM usage_readings WHERE agent = 'codex' AND kind = ?
        AND account = ? AND source = 'app-server' AND measured_ms <= ? ORDER BY measured_ms DESC, machine_id DESC LIMIT 1`)
        .get(kind, account, now + 5000) as { pct: number; reset_ms: number; measured_ms: number } | undefined;
      if (row && now - row.measured_ms <= 30 * 60_000 && row.measured_ms >= quotaAt) {
        quota ??= { version: 1, source: 'app-server', account, snapshotMs: row.measured_ms, fivePct, fiveReset, weekPct, weekReset };
        if (kind === 'week') { quota.weekPct = row.pct; quota.weekReset = row.reset_ms; }
        else { quota.fivePct = row.pct; quota.fiveReset = row.reset_ms; }
      }
    }
  }
  if (quota) {
    fivePct = quota.fivePct; fiveReset = quota.fiveReset;
    weekPct = quota.weekPct; weekReset = quota.weekReset;
  }
  // A 5-hour window whose reset has passed, with no newer reading, is over, as Claude's is (usageReading): its share
  // is 0 and it has no reset, so it keeps its slot at 0% with no countdown. A newer reading is looked for in every recent
  // rollout: the one read here is a named session's, or the one written last, and another session may have read the
  // quota since, in the next window. That reading stands. A plan with no 5-hour window reports none and shows none. A
  // weekly window refilled at its reset, so its last share goes.
  if (fiveReset !== null && fiveReset <= now) {
    const newer = quota ? null : newerRunningFive(live.snapshotMs, now);
    fivePct = newer ? newer.pct : 0; fiveReset = newer ? newer.reset : null;
  }
  if (weekReset !== null && weekReset <= now) { weekPct = null; weekReset = null; }
  const ctxPct = live.ctxTokens !== null && live.ctxSize ? Math.min(100, (live.ctxTokens / live.ctxSize) * 100) : null;
  // The gpt month is the BILL CYCLE when a gpt bill day is configured (the user's OpenAI subscription
  // renews on that day-of-month; codex sends no date, so it is stated once via `oak usage
  // --gpt-bill-day`), else the calendar month. Days past a short month's end clamp to its last day.
  const d = new Date(now);
  const bd = (require('./prefs') as typeof import('./prefs')).gptBillDay();
  let monthStart: number;
  let monthReset: number;
  if (bd && bd > 1) {
    const clampDay = (yy: number, mm: number): number => Math.min(bd, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate());
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    let sy = y;
    let sm = m; // this cycle opened on day-bd of THIS month if today is at/after it, else last month's
    if (d.getUTCDate() < clampDay(y, m)) {
      sm = m - 1;
      if (sm < 0) {
        sm = 11;
        sy -= 1;
      }
    }
    monthStart = Date.UTC(sy, sm, clampDay(sy, sm));
    let ry = sy;
    let rm = sm + 1;
    if (rm > 11) {
      rm = 0;
      ry += 1;
    }
    monthReset = Date.UTC(ry, rm, clampDay(ry, rm));
  } else {
    monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    monthReset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  const weekStart = weekReset !== null ? weekReset - 7 * 86400_000 : now - 7 * 86400_000;
  const cyc = database ? database.cycle(monthStart, weekStart, now)
    : { ...codexCycleUsage(monthStart, weekStart, now), measuredMachines: 'this machine alone', budgetScope: 'local', localEquivalent: true, usageFreshness: '' };
  // MONTH budget, estimated the SAME way claude's statusline does (install-statusline.sh:886 —
  // `tk30 = t7 * mdays/7`, and the month % = month_tok / month_tok_total): project a calibrated
  // shorter window across the cycle. gpt exposes no monthly quota %, so we back-derive the WEEKLY
  // budget from its own reported fill — tokens measured this week ÷ the fraction of the week used
  // (weekPct/100), the single-sample form of claude's tokens-per-percent calibration — then scale it
  // to the month by days. `monthTok / monthTokTotal` in `usageBrief` then reads as a % exactly like
  // claude's `monthTokens / monthTokensTotal`. Both inputs must be real (weekly database tokens +
  // a live weekly %) or the budget stays unknown, the same honest gap claude leaves uncalibrated. A week with no
  // sample yet (Codex's weekly reset, and no GPT use since) takes the budget the last sampled week gave, for
  // up to GPT_WEEK_BUDGET_MS; a fresh sample always wins and is remembered.
  const sampled = weekPct !== null && weekPct > 0 && cyc.weekTok > 0 ? Math.round(cyc.weekTok / (weekPct / 100)) : null;
  if (sampled !== null) rememberGptWeekTotal(sampled, now, cyc.budgetScope);
  let previous: number | null = null;
  if (sampled === null && db && account) {
    const last = db.prepare(`SELECT pct, reset_ms, measured_ms FROM usage_readings WHERE agent = 'codex' AND kind = 'week'
      AND source = 'app-server' AND account = ? AND pct > 0 AND reset_ms IS NOT NULL AND measured_ms BETWEEN ? AND ?
      ORDER BY measured_ms DESC, machine_id DESC LIMIT 1`).get(account, now - GPT_WEEK_BUDGET_MS, now) as
      { pct: number; reset_ms: number; measured_ms: number } | undefined;
    if (last) {
      const tokens = db.prepare(`SELECT total(input + output + cache_create) AS tokens FROM usage_messages
        WHERE agent = 'codex' AND ts >= ? AND ts <= ? AND (account IS NULL OR account = ?)`)
        .get(last.reset_ms - 7 * 86400_000, Math.min(last.measured_ms, last.reset_ms - 1), account) as { tokens: number };
      if (tokens.tokens > 0) previous = Math.round(tokens.tokens * 100 / last.pct);
    }
  }
  const weekTotal = sampled ?? previous ?? rememberedGptWeekTotal(now, cyc.budgetScope)
    ?? (cyc.localEquivalent && cyc.budgetScope !== 'local' ? rememberedGptWeekTotal(now, 'local') : null);
  // Nothing to show: no window has a share and the cycle holds no turns. A cycle measured at 0 beside a known budget
  // is a reading (0%), and keeps the panel when no window has a share, as Claude's month keeps its group.
  if (fivePct === null && weekPct === null && ctxPct === null && cyc.moTok <= 0 && !(cyc.moTok === 0 && weekTotal !== null)) return null;
  const monthDays = Math.max(1, Math.round((monthReset - monthStart) / 86400_000));
  const monthTokTotal = weekTotal !== null ? Math.round((weekTotal * monthDays) / 7) : null;
  const monthCostTotal = null;
  return {
    fivePct, fiveReset, weekPct, weekReset,
    ctxPct, ctxTokens: live.ctxTokens, ctxSize: live.ctxSize,
    weekTok: cyc.weekTok > 0 ? cyc.weekTok : null,
    weekTotal,
    monthStart, monthReset,
    // A cycle with no GPT turns yet is a measured 0 once its budget is known, and reads 0%; null hid the
    // month. Without a budget there is no share to show, so the month stays unknown.
    monthTok: cyc.moTok > 0 ? cyc.moTok : cyc.moTok === 0 && monthTokTotal !== null ? 0 : null,
    monthTokTotal,
    monthReads: cyc.moReads > 0 ? cyc.moReads : null,
    // Show the PRICED SUBSET: the sum of the events we could price (cloud/OpenAI turns), even when
    // the month also holds unpriceable LOCAL ones (ollama/lmstudio), whose real API cost is $0, so
    // excluding them from the dollar figure is accurate — not a gap. Before this, one local turn
    // flipped the whole GPT month's $ to "—" beside real cloud spend. An unpriced turn from a HOSTED
    // custom provider (an OpenRouter model missing from the price table) is real spend, so it makes
    // the month's $ unavailable rather than understated. A month with NO priced spend stays unavailable.
    monthCost: cyc.moUsd > 0 && cyc.moUsdKnown ? cyc.moUsd : null,
    monthCostTotal,
    usageSource: db ? 'database' : 'local', measuredMachines: cyc.measuredMachines,
    usageFreshness: cyc.usageFreshness,
  };
}

/** The newest `limit` rollouts under codex's sessions tree, newest first. */
export function recentCodexRollouts(limit = 8): string[] {
  const root = path.join(codexHome(), 'sessions');
  const all: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          all.push({ file: p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          /* raced with codex's own rotation */
        }
      }
    }
  };
  walk(root, 0);
  walk(path.join(codexHome(), 'archived_sessions'), 0);
  return all.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((x) => x.file);
}

function codexUsageFile(target: string): CodexUsage {
  const out = EMPTY_CODEX_USAGE();
  const state = codexUsageState(target); if (!state) return out;
  const p = { rate_limits: state.rateLimits };
    const rl = p.rate_limits as Record<string, unknown> | undefined;
    if (rl) {
      for (const key of ['primary', 'secondary']) {
        const w = rl[key] as { used_percent?: unknown; window_minutes?: unknown; window_duration_mins?: unknown; resets_at?: unknown; resets_in_seconds?: unknown } | null | undefined;
        if (!w) continue;
        const mins = numOrNull(w.window_minutes) ?? numOrNull(w.window_duration_mins);
        const pct = numOrNull(w.used_percent);
        const at = resetMs(w.resets_at) ?? resetAfter(w.resets_in_seconds, state.quotaTs);
        // Classify by the duration codex reports, never by which slot it occupies. Codex 0.154 added
        // a MONTHLY window (~43200 min) beside the 5-hour (300) and weekly (10080) ones; the old
        // ">= a day is weekly" rule swallowed the monthly's ~30-day reset into the weekly slot. Bound
        // the weekly band to roughly a week (1 day .. 2 weeks); anything longer is the monthly window,
        // which the weekly/5h readout does not track (codex month comes from the transcript scan).
        if (mins !== null && mins >= 1440 && mins < 20160) {
          out.weekPct = pct;
          out.weekReset = at;
        } else if (mins !== null && mins < 1440) {
          out.fivePct = pct;
          out.fiveReset = at;
        }
      }
      const cr = rl.credits as { has_credits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined;
      if (cr) {
        out.creditsUnlimited = cr.unlimited === true;
        out.creditBalance = cr.has_credits === false ? null : numOrNull(cr.balance);
      }
      const sc = rl.spend_control_reached as { limit?: unknown; remaining_percent?: unknown } | null | undefined;
      if (sc) {
        out.spendLimit = numOrNull(sc.limit);
        out.spendRemainingPct = numOrNull(sc.remaining_percent);
      }
    }
  out.ctxSize = state.modelWindow;
  out.ctxTokens = state.contextTokens;
  if (state.tokens) {
    const [input, output, cached] = state.tokens;
    out.tokens = { input: Math.max(0, input - cached), output, cacheRead: cached, total: input + output };
  }
  // File activity is not quota freshness: only the quota event timestamp supplies this stamp.
  out.snapshotMs = state.quotaTs;

  return out;
}

/** `codexUsage` with rolled-over windows dropped: a window whose reset has passed (its `resets_at`, or
 *  the reading's time plus its `resets_in_seconds`) refilled at that boundary, so its recorded
 *  percentage is no longer true — showing it would claim spent quota that is back. A 5-hour window
 *  whose reset has passed is over and reads 0 with no reset, as gptUsagePanel reads it. A window with
 *  a percentage but neither is kept (nothing proves it stale). For surfaces that render "current"
 *  quota, like the IDE status bars. */
export function codexUsageLive(file?: string): CodexUsage {
  const u = { ...codexUsage(file) };
  const now = Date.now();
  if (u.fiveReset !== null && u.fiveReset <= now) { u.fivePct = 0; u.fiveReset = null; }
  if (u.weekReset !== null && u.weekReset <= now) { u.weekPct = null; u.weekReset = null; }
  return u;
}

/** The newest rollout under codex's sessions tree, or null when it has none. */
export function newestCodexRollout(): string | null {
  const root = path.join(codexHome(), 'sessions');
  let best: { file: string; mtime: number } | null = null;
  const keep = (file: string, mtime: number): void => { if (!best || mtime > best.mtime) best = { file, mtime }; };
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return; // codex nests YYYY/MM/DD; anything deeper is not its layout
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          keep(p, st.mtimeMs);
        } catch {
          /* raced with codex's own rotation */
        }
      }
    }
  };
  walk(root, 0);
  return best ? (best as { file: string }).file : null;
}
