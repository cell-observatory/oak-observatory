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
import { storeDir, ensureStore, appendSkip, clearAbandonedToolStaging } from './store';
import { handleHookPayload, noteToolCall, HookPayload } from './capture';
import { appendCaptureEvent } from './capture-events';
import { priceUsage } from './pricing';
import { codexPromptText, codexTranscriptFile, codexUsageDeltas } from './codex-events';
import { cachedByFiles, readLines } from './fscache';
import { plainTitle } from './format';
import { canonPath } from './paths';

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

/** Write-if-changed: this runs on every hook event, and identical content must cost one read, not a write. */
function upsertAgentMeta(session: string, p: CodexHookPayload): void {
  const existing = readCodexAgentMeta(session);
  const next: CodexAgentMeta = {
    agent: 'codex',
    cwd: p.cwd || existing?.cwd,
    provider: p.model_provider || existing?.provider,
    transcriptPath: p.transcript_path || existing?.transcriptPath,
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
  try {
    fs.writeFileSync(agentMetaPath(session), JSON.stringify(next));
  } catch {
    /* capture must never block an edit over metadata */
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
    {
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
    if (ev === 'UserPromptSubmit' || ev === 'Stop' || (ev === 'SessionStart' && p.source === 'resume')) {
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
      const { writeAttention, toolCallKey } = require('./capture') as typeof import('./capture');
      writeAttention(session, { kind: 'permission', message: String(p.tool_name ?? 'tool'), ts: Date.now() }, toolCallKey(p));
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
    handleCodexHookPayload(JSON.parse(raw) as CodexHookPayload, performance.timeOrigin);
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
  const source = meta?.source as { subagent?: { other?: unknown } } | undefined;
  if (meta && (meta.thread_source === 'guardian_review' || source?.subagent?.other === 'guardian')) {
    if (!followReview) return null;
    const parent = meta.parent_thread_id;
    const reviewed = typeof parent === 'string' && parent !== id
      ? codexTitle(codexSessionSources().find((s) => s.id === parent)?.file ?? '', parent, false) : null;
    return reviewed ? `Auto-review: ${reviewed}` : 'Auto-review';
  }
  // Codex's memory-writing agent runs as an EPHEMERAL thread in `<CODEX_HOME>/memories`: it writes no
  // rollout, so only its hooks report it, from that folder. Its one prompt is Codex's template
  // ("## Memory Writing Agent: Phase 2 (Consolidation)" and 50 KB more), which names nothing.
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : readCodexAgentMeta(id)?.cwd;
  if (cwd && canonPath(path.resolve(cwd)) === canonPath(path.join(codexHome(), 'memories'))) return CODEX_MEMORY_TITLE;
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

/** A long derived title's first phrase: through its first sentence end (a `.`, `?` or `!` before a space,
 *  as a Claude row cuts its first prompt) or up to its first clause break (` — `, `: `, `; `), whichever
 *  comes first and keeps 12 characters and two words (brief headings written as goal sentences made
 *  Codex titles less useful). A whole phrase, never an ellipsis: a title of 64 characters or fewer
 *  (a list row's length) stays whole, and so does one with no break. */
function firstPhrase(text: string): string {
  if (text.length <= 64) return text;
  const cuts = [/^(.*?[.?!])(?=\s)/.exec(text)?.[1], /^(.*?)\s*(?:\s[—–]\s|:\s|;\s)/.exec(text)?.[1]]
    .map((c) => c?.trim()).filter((c): c is string => !!c && c.length >= 12 && /\s/.test(c)); // a phrase, not a lone `file.ts`
  return cuts.sort((a, b) => a.length - b.length)[0] ?? text;
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
  return (prompt.slice(0, 4096).match(MARKDOWN_REF) ?? []).find(briefOf) ?? null; // the prompt names its brief up front
}

/** A markdown document's title: its first line when that is a heading, without the `#`s and without a
 *  leading "Task:" / "Task (…):" label. */
function markdownTitle(text: string): string | null {
  const first = text.trimStart().split(/\r?\n/, 1)[0]; // trimStart also drops a byte-order mark
  const heading = /^#{1,6}[ \t]+(.*)$/.exec(first)?.[1].replace(/(?:^|[ \t])#+[ \t]*$/, '');
  return heading?.replace(/^task(?:\s*\([^)]*\))?\s*:/i, '').replace(/\s+/g, ' ').trim() || null;
}

/** A brief's title, from its first 8 KiB on this machine; cached on the file's stamp, so an edit shows. */
function briefTitle(file: string): string | null {
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

interface CodexSessionMeta { id?: string; session_id?: string; cwd?: string; parent_thread_id?: unknown; thread_source?: unknown; source?: unknown }
/**
 * A rollout's head, read once per file stamp: its session_meta, whether a user message appears, and
 * whether the WHOLE file fit in the buffer. A rollout that fit entirely yet carries no user message is
 * an empty stub (a launch that died before its first turn — a failed sandbox, an app-server probe);
 * listing it as a session is noise. A large file has content by definition. Null when unreadable.
 */
function codexRolloutHead(file: string): { meta: CodexSessionMeta | null; userMsg: boolean; whole: boolean } | null {
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

export interface CodexSessionSource { id: string; cwd: string; file: string; mtimeMs: number; archived: boolean }
// resolveSessionId calls this once per unresolved store session (via describeSession), so without a
// memo a store of N sessions × M rollouts walks the codex tree N times — the dominant per-invocation
// cost before any work begins (measured 118ms→583ms as rollouts grow). A short TTL collapses a burst
// of calls to one walk while a long-lived process still sees a new session within the window; the key
// includes codexHome() so a CODEX_HOME change (tests, relocation) invalidates immediately.
let sourcesMemo: { at: number; home: string; val: CodexSessionSource[] } | null = null;
export function codexSessionSources(): CodexSessionSource[] {
  const home = codexHome();
  const now = Date.now();
  if (sourcesMemo && sourcesMemo.home === home && now - sourcesMemo.at < 1000) return sourcesMemo.val;
  const tmpRoots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders'].map((r) => path.resolve(r) + path.sep);
  const out: CodexSessionSource[] = [];
  for (const file of recentCodexRollouts(Number.MAX_SAFE_INTEGER)) {
    try {
      const head = codexRolloutHead(file);
      const meta = head?.meta;
      const id = meta?.id ?? meta?.session_id;
      if (!head || typeof id !== 'string' || typeof meta?.cwd !== 'string') continue;
      if (head.whole && !head.userMsg) continue;                       // empty stub — no conversation
      const cwd = meta.cwd;
      if ((require('./session') as typeof import('./session')).isMirroredTranscript(file).mirrored) continue;
      // Hide a throwaway run whose temp-dir workspace is gone (a /tmp scratch from a probe or an old
      // review). Scoped to temp roots so a real project on an unmounted drive is never dropped.
      if (tmpRoots.some((r) => path.resolve(cwd).startsWith(r)) && !fs.existsSync(cwd)) continue;
      out.push({ id, cwd, file,
        mtimeMs: fs.statSync(file).mtimeMs, archived: file.startsWith(path.join(codexHome(), 'archived_sessions') + path.sep) });
    } catch { /* raced with deletion */ }
  }
  sourcesMemo = { at: now, home, val: out };
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
 * byte-for-byte.
 */
function upsertStateTables(content: string, entries: { key: string; hash: string }[], owned: Set<string>): string {
  const lines = content.length ? content.split('\n') : [];
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
    .map(({ key, hash }) => `[hooks.state."${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]\ntrusted_hash = "${hash}"`)
    .join('\n\n');
  return `${out}${out.length ? '\n\n' : ''}${tables}\n`;
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

export interface CodexHooksStatus {
  hooksJsonPath: string;
  installed: boolean;
  installedCommand: string | null;
  foreignGroups: number;
  /** 'trusted' = every event's state table matches our replicated hash; 'partial'/'missing' are the
   *  silent-skip danger zones and render as warnings, because codex will NOT say why hooks are off. */
  trust: 'trusted' | 'partial' | 'missing' | 'no-config';
  disabled?: boolean;
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
        if ((CODEX_HOOK_EVENTS as readonly string[]).includes(ev) && state?.enabled !== false && state?.trusted_hash === hash) have += 1;
      }
      trust = !disabled && have === want ? 'trusted' : have > 0 ? 'partial' : 'missing';
    } catch (e) {
      trust = 'no-config'; configError = String((e as Error).message);
    }
  }
  return { hooksJsonPath: file, installed, installedCommand, foreignGroups, trust, disabled, configError };
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

/** Cache one cumulative event series per file set; window boundaries never create new cache kinds.
 * Exact timestamp queries stay cheap even when a rolling seven-day fallback moves every poll. */
export function codexCycleUsage(cycleStartMs: number, weekStartMs: number, endMs = Infinity): { moTok: number; moReads: number; moUsd: number; moUsdKnown: boolean; weekTok: number } {
  const files = recentCodexRollouts(Number.MAX_SAFE_INTEGER);
  const series = cachedByFiles('codex-cycle-events-v3', files, () => {
    const seen = new Set<string>();
    const events = files.flatMap((file) => codexUsageDeltas(file)).filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id); return true;
    }).sort((a, b) => a.ts - b.ts);
    let tok = 0, reads = 0, usd = 0, unknown = 0;
    return events.map((d) => {
      const price = priceUsage(d.provider && d.provider !== 'openai' ? `provider:${d.provider}/${d.model}` : d.model, d.usage);
      tok += d.usage.input + d.usage.output + d.usage.cacheWrite;
      reads += d.usage.cacheRead; usd += price.usd; unknown += price.known ? 0 : 1;
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
}

export function gptUsagePanel(session?: string, now = Date.now()): GptUsagePanel | null {
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
  if (quota) {
    fivePct = quota.fivePct; fiveReset = quota.fiveReset;
    weekPct = quota.weekPct; weekReset = quota.weekReset;
  }
  if (fiveReset !== null && fiveReset <= now) { fivePct = null; fiveReset = null; }
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
  const cyc = codexCycleUsage(monthStart, weekStart, now);
  if (fivePct === null && weekPct === null && ctxPct === null && cyc.moTok <= 0) return null;
  // MONTH budget, estimated the SAME way claude's statusline does (install-statusline.sh:886 —
  // `tk30 = t7 * mdays/7`, and the month % = month_tok / month_tok_total): project a calibrated
  // shorter window across the cycle. gpt exposes no monthly quota %, so we back-derive the WEEKLY
  // budget from its own reported fill — tokens measured this week ÷ the fraction of the week used
  // (weekPct/100), the single-sample form of claude's tokens-per-percent calibration — then scale it
  // to the month by days. `monthTok / monthTokTotal` in `usageBrief` then reads as a % exactly like
  // claude's `monthTokens / monthTokensTotal`. Both inputs must be real (recent local weekly tokens +
  // a live weekly %) or the budget stays unknown, the same honest gap claude leaves uncalibrated.
  const weekTotal = weekPct !== null && weekPct > 0 && cyc.weekTok > 0 ? Math.round(cyc.weekTok / (weekPct / 100)) : null;
  const monthDays = Math.max(1, Math.round((monthReset - monthStart) / 86400_000));
  const monthTokTotal = weekTotal !== null ? Math.round((weekTotal * monthDays) / 7) : null;
  const monthCostTotal = null;
  return {
    fivePct, fiveReset, weekPct, weekReset,
    ctxPct, ctxTokens: live.ctxTokens, ctxSize: live.ctxSize,
    weekTok: cyc.weekTok > 0 ? cyc.weekTok : null,
    weekTotal,
    monthStart, monthReset,
    monthTok: cyc.moTok > 0 ? cyc.moTok : null,
    monthTokTotal,
    monthReads: cyc.moReads > 0 ? cyc.moReads : null,
    // Show the PRICED SUBSET: the sum of the events we could price (cloud/OpenAI turns), even when
    // the month also holds unpriceable ones. An unpriceable event is a local model (ollama/lmstudio),
    // whose real API cost is $0, so excluding it from the dollar figure is accurate — not a gap. Only a
    // month with NO priced spend at all (moUsd === 0) stays unavailable. Before this, one local turn
    // flipped the whole GPT month's $ to "—" beside real cloud spend.
    monthCost: cyc.moUsd > 0 ? cyc.moUsd : null,
    monthCostTotal,
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
        const w = rl[key] as { used_percent?: unknown; window_minutes?: unknown; window_duration_mins?: unknown; resets_at?: unknown } | null | undefined;
        if (!w) continue;
        const mins = numOrNull(w.window_minutes) ?? numOrNull(w.window_duration_mins);
        const pct = numOrNull(w.used_percent);
        const at = resetMs(w.resets_at);
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

/** `codexUsage` with rolled-over windows dropped: a window whose `resets_at` has passed refilled
 *  at that boundary, so its recorded percentage is no longer true — showing it would claim spent
 *  quota that is back. A window with a percentage but no reset timestamp is kept (nothing proves
 *  it stale). For surfaces that render "current" quota, like the IDE status bars. */
export function codexUsageLive(file?: string): CodexUsage {
  const u = { ...codexUsage(file) };
  const now = Date.now();
  if (u.fiveReset !== null && u.fiveReset <= now) { u.fivePct = null; u.fiveReset = null; }
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
