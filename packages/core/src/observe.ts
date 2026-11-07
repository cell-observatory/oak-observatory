/**
 * Observations layer (zero-token): correlate each captured edit with Claude's ACTUAL reasoning from
 * the session transcript, plus cheap heuristic change-summaries, issue-flags, and next-step
 * suggestions. No model calls — the transcript already contains Claude's words.
 */
import { userPrompt, transcriptForSession } from './asks';
import { workspaceDirectoryExists } from './workspace-window';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffArrays } from 'diff';
import { EditRecord, EditStatus, readLog, blobText as storeBlobText, logPath, maxOf, listSessions, SessionInfo, allStoreSessionIds, rootDir, isSafeSessionId, hasInflightCapture, hasBlob, storeBytes, storeDir, hiddenSessions, hideSession, removeSession, withFileMutation, FileBusyError, outsideStoreMoves, isReservedStoreDir, storeIndexHooks, earlierGenerationOf } from './store';
import { lineDelta, plainTitle } from './format';
import { spawnToolSync } from './spawn';
import { graphemeHead } from './graphemes';
import { contentGet, contentNote, flushPairDeltas, pairDelta, pairKeyOf, derivedInventory } from './derived';
import { projectDir, resolveSessionId, listWorkspaces, isBridgePointer, isMirroredTranscript, workspaceLabel, SESSION_BUSY_MS } from './session';
import { readAttention, readTabLink, captureMutex } from './capture';
import { claudeConfigDir, canonPath } from './paths';
import { agentPhaseDetail } from './actions';
import { cachedAnalysis } from './analyze';
import { cachedByFiles, readLines } from './fscache';
import { transcriptFacts } from './derived-transcript';
import { reviewEdits, visibleEdits } from './groups';
import { activeWorkers, ActiveWorker } from './subagents';
// NOTE: metrics.ts imports `findTranscript` from this module, so this pair is CIRCULAR. It is safe only
// because both directions are used at CALL time, never at module-init time — nothing here runs during
// load. `test/core.test.js` requires each module first in a child process to keep that true.
import { sessionUsage, sessionVitals } from './metrics';
import { captureEventsPath, readCaptureEvents } from './capture-events';
import { findCodexRollout, readCodexAgentMeta, readCodexRollout, codexSessionTitle, codexTurnOpen, codexTitleInputs } from './codex';
import { codexSessionSources, type CodexSessionSource } from './codex';
import { codexTranscriptFile, codexPromptText, isCodexTranscriptFile, codexDerivedTurnOpen } from './codex-events';
import { remoteSessionTitle } from './remote-titles';
import { pidAlive } from './daemon';

/** Locate the Claude Code transcript jsonl for a session, walking up from cwd (like resolveSessionId). */
export function findTranscript(cwd: string, sessionId: string): string | null {
  return derivedInventory(`transcript:${rootDir()}:${cwd}:${sessionId}`, () => findTranscriptInInventory(cwd, sessionId));
}

function findTranscriptInInventory(cwd: string, sessionId: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const p = path.join(projectDir(dir), `${sessionId}.jsonl`);
    if (fs.existsSync(p) && !isMirroredTranscript(p).mirrored && !isBridgePointer(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) { const source = findCodexRollout(sessionId); return source && !isMirroredTranscript(source).mirrored ? codexTranscriptFile(source) : null; }
    dir = parent;
  }
}

/**
 * Every session id that has a TRANSCRIPT under this workspace, newest first.
 *
 * The store is not the census. A session gets a store directory the first time the capture hook fires,
 * so a conversation that only asked, read and ran things never gets one — and every listing built from
 * `listSessions()` alone simply could not see it. Measured on this repo: 50 transcripts, 31 store
 * directories, so 19 real conversations were missing from the picker with nothing on screen to say so.
 *
 * THIS directory's project folder only — deliberately not `findTranscript`'s walk up the tree. That
 * walk exists so a session started in a SUBDIRECTORY still resolves, and walking up from a workspace
 * root reaches its ancestors, which are other people's workspaces: enumerating those took this repo's
 * listing from 44 rows to 85, most of them conversations that have nothing to do with it.
 */
export function transcriptSessionIds(cwd: string): string[] {
  const dir = projectDir(path.resolve(cwd));
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no transcripts for this workspace yet
  }
  const out: { id: string; ms: number }[] = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const id = n.slice(0, -6);
    if (!isSafeSessionId(id) || isMirroredTranscript(path.join(dir, n)).mirrored || isBridgePointer(path.join(dir, n))) continue;
    let ms = 0;
    try {
      ms = fs.statSync(path.join(dir, n)).mtimeMs;
    } catch {
      /* unreadable — it still identifies a session, and sorts last */
    }
    out.push({ id, ms });
  }
  return out.sort((a, b) => b.ms - a.ms).map((x) => x.id);
}

/** The file-editing tools that appear as tool_uses in the transcript (parseToolUses queues these);
 *  a store record with any other tool (e.g. Bash) has no transcript counterpart to correlate. */
const CORRELATED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

interface ToolUse {
  file: string;
  reasoning: string;
  /** ms epoch of the tool_use line — the key the correlation matches on. */
  ts: number;
  /** The tool_use id, when the transcript carries one. Reserved for an EXACT join: capture does not
   *  record an id on the edit yet, so nothing matches on this today. */
  id: string;
}

/** Edit/Write/MultiEdit/NotebookEdit tool_uses in transcript order, each with its message's text. */
function parseToolUses(transcriptPath: string): ToolUse[] {
  return transcriptFacts(transcriptPath).reasoning.uses.map((use) => ({ ...use, file: path.resolve(use.file) }));
}

export interface ReasoningFacts { lastReasoning: string; uses: ToolUse[] }

/** Unlike the main action timeline, historical reasoning includes legacy inlined sidechains. */
export function foldReasoningFacts(facts: ReasoningFacts, o: any): void {
  if (o?.type === 'api-request-blob') return;
  const msg = o.message;
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
  // NOTE: sidechain (subagent) messages are deliberately NOT skipped here. The capture hooks fire
  // for subagent edits too (same session store), so if a legacy transcript inlines them
  // (isSidechain:true) their tool_uses must stay in the queues. Current Claude Code writes sidechains
  // to separate subagents/*.jsonl files — which this parser is now pointed at as well, so a
  // subagent's edit takes ITS OWN agent's words instead of the orchestrator's.
  let text = '';
  let think = '';
  for (const b of msg.content) {
    if (b && b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text.trim();
    else if (b && b.type === 'thinking') {
      const th = typeof b.thinking === 'string' ? b.thinking : typeof b.text === 'string' ? b.text : '';
      if (th) think += (think ? '\n' : '') + th.trim();
    }
  }
  const reasoning = text || think; // prefer the visible explanation; fall back to thinking
  if (reasoning) facts.lastReasoning = reasoning;
  const ts = toEpochMs(o.timestamp ?? o.ts) ?? 0;
  for (const b of msg.content) {
    if (b && b.type === 'tool_use' && CORRELATED_TOOLS.has(b.name)) {
      const f = b.input && (b.input.file_path || b.input.notebook_path);
      if (typeof f === 'string')
        facts.uses.push({ file: f, reasoning: facts.lastReasoning, ts, id: typeof b.id === 'string' ? b.id : '' });
    }
  }
}

/** Map edit id -> Claude's reasoning text, correlating store edits to transcript tool_uses per file. */
export function reasoningByEdit(cwd: string, sessionId: string): Map<number, string> {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return new Map<number, string>();
  // Depends on the transcript (tool_uses) AND the store log (the cursor walk) — keyed on both files'
  // (mtime,size), so a new capture or a review op invalidates it. Read-only result, shared as-is.
  return cachedByFiles('reasoningByEdit', [...explainingTranscripts(transcript), logPath(sessionId)], () =>
    reasoningByEditUncached(transcript, sessionId)
  );
}

/** How far before an edit's commit its tool_use may sit. The hook writes the record moments after the
 *  call, so this is generous rather than tight — but bounded, so an unrelated edit hours earlier in the
 *  same file can never lend its words. */
const REASONING_WINDOW_MS = 10 * 60_000;
/** A tool_use may be stamped slightly AFTER the commit when clocks or buffering disagree. */
const REASONING_SLACK_MS = 2_000;

/** Every transcript that can explain an edit in this session: the main chain plus each subagent's own
 *  file. Computed from the transcript path rather than imported from subagents.ts, which imports this
 *  module (a value import back would close a runtime cycle). */
function explainingTranscripts(transcript: string): string[] {
  const out = [transcript];
  const subDir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) if (n.endsWith('.jsonl')) out.push(path.join(dir, n));
  };
  walk(subDir);
  let runs: string[] = [];
  try {
    runs = fs.readdirSync(path.join(subDir, 'workflows'));
  } catch {
    /* no workflow runs */
  }
  for (const r of runs) walk(path.join(subDir, 'workflows', r));
  return out;
}

/**
 * Correlate store edits to the words that explain them.
 *
 * Matching is by TIME, per file, across every transcript that could have produced the edit — the main
 * chain and each subagent's own file. The previous approach walked a per-file positional cursor over
 * the main transcript alone, which broke twice over: a subagent's edits have no main-chain tool_use, so
 * they either went unexplained or consumed an entry belonging to the orchestrator (attributing one
 * author's words to another's work); and any gap — a file also touched by a `prettier --write`, a
 * filtered record — shifted every later edit in that file, so one miss cascaded through the session.
 *
 * A nearest-in-time match costs at most the single edit it gets wrong, and it reads the author's own
 * transcript. Each tool_use is consumed once, so two edits never claim the same sentence.
 */
function reasoningByEditUncached(transcript: string, sessionId: string): Map<number, string> {
  const map = new Map<number, string>();
  const byFile = new Map<string, ToolUse[]>();
  for (const file of explainingTranscripts(transcript)) {
    for (const e of parseToolUses(file)) {
      const list = byFile.get(e.file);
      if (list) list.push(e);
      else byFile.set(e.file, [e]);
    }
  }
  for (const list of byFile.values()) list.sort((a, b) => a.ts - b.ts);
  const used = new Set<ToolUse>();

  for (const rec of readLog(sessionId)) {
    // A Bash record (a file changed by `prettier --write`, `eslint --fix`) has no tool_use to match.
    if (!CORRELATED_TOOLS.has(rec.tool)) continue;
    const list = byFile.get(path.resolve(rec.file));
    if (!list || !list.length) continue;
    let best: ToolUse | null = null;
    // Time matching needs both sides to HAVE a time. A legacy transcript (or a test fixture) whose
    // tool_uses carry no timestamp would otherwise see every candidate tie at 0 and hand the newest
    // entry to the oldest edit — so those fall through to the positional order they were written in.
    if (rec.ts) {
      // The tool_use always PRECEDES the commit the hook writes, so a candidate at-or-before the edit
      // is the right one and the latest such candidate is the nearest. Only if none exists do we allow
      // the small slack for clock/buffering skew — otherwise a later edit's explanation, which sits
      // just inside that slack, would outrank the correct earlier one.
      for (const e of list) {
        if (used.has(e) || !e.reasoning || !e.ts) continue;
        if (e.ts > rec.ts) break; // sorted: everything after is later still
        if (rec.ts - e.ts > REASONING_WINDOW_MS) continue;
        best = e;
      }
      if (!best) {
        for (const e of list) {
          if (used.has(e) || !e.reasoning || !e.ts) continue;
          if (e.ts > rec.ts + REASONING_SLACK_MS) break;
          if (e.ts > rec.ts) best = e;
        }
      }
    }
    if (!best) best = list.find((e) => !used.has(e) && e.reasoning && !e.ts) ?? null;
    if (!best) continue;
    used.add(best);
    map.set(rec.id, best.reasoning);
  }
  return map;
}

/**
 * Claude's OWN tracked to-dos (its latest `TodoWrite`) plus the last assistant summary, pulled from
 * the transcript — zero token. This is the most grounded "next steps" source we have: it's the plan
 * Claude was literally working from, already sitting in the cached session.
 */
export interface TranscriptInsights {
  todos: { content: string; status: string }[]; // from the latest non-empty TodoWrite in the session
  lastSummary: string | null; // last assistant text block (what Claude said it just did)
  title: string | null; // Claude Code's latest auto session title (the `ai-title` entries) — a recap line
  customTitle: string | null; // the name a person gave the session (the newest `custom-title`; an empty one clears it)
  bridgeSessionId: string | null; // the Remote Control session it ran as (the newest `bridge-session` record)
  firstUserPrompt: string | null; // first real user message (non-sidechain, text — never a tool_result/command wrapper)
}
export function transcriptInsights(cwd: string, sessionId: string): TranscriptInsights {
  const empty: TranscriptInsights = { todos: [], lastSummary: null, title: null, customTitle: null, bridgeSessionId: null, firstUserPrompt: null };
  const p = findTranscript(cwd, sessionId);
  if (!p) return empty;
  return transcriptInsightsAt(p);
}

/** Insights from an already resolved transcript, including sessions in another workspace. */
export function transcriptInsightsAt(p: string): TranscriptInsights {
  // Memoized per (mtime,size) — several views consult the same insights per refresh. Read-only result.
  return transcriptFacts(p).insights;
}

export function listSessionsWithTitles(cwd: string): (SessionInfo & { title: string | null })[] {
  const rows = listSessions();
  const seen = new Set(rows.map((s) => s.id));
  // Sessions with a transcript here but NO store directory. One is created the first time the capture
  // hook fires, so a conversation that only asked, read and ran things never gets one — and listing
  // the store alone dropped it silently. They carry zero counts, which is the truth: nothing was
  // captured. Recency comes from the transcript, since there is no log to stat.
  for (const id of transcriptSessionIds(cwd)) {
    if (seen.has(id)) continue;
    seen.add(id);
    let lastMs = 0;
    try {
      lastMs = fs.statSync(findTranscript(cwd, id) ?? '').mtimeMs;
    } catch {
      /* unreadable — it still identifies a session, and sorts last */
    }
    rows.push({ id, edits: 0, pending: 0, lastMs });
  }
  rows.sort((a, b) => b.lastMs - a.lastMs);
  const hidden = hiddenSessions();
  return rows.filter((s) => !hidden.has(s.id)).map((s) => {
    let title: string | null = null;
    try {
      title = normalizeSessionTitle(preferredSessionTitle(transcriptInsights(cwd, s.id)) ?? '');
    } catch {
      /* unreadable transcript — the id still identifies the session */
    }
    return { ...s, title };
  });
}

/**
 * A session's name before any row shaping — ONE precedence for every surface that names a session:
 *  1. the name a person gave it (`custom-title`: `/rename`, or a rename made on claude.ai or the Claude
 *     app over Remote Control, which Claude Code writes back into the transcript) — local and immediate;
 *  2. the title claude.ai holds for its Remote Control session — what the Claude app shows. Claude Code
 *     keeps it on the server only, so it comes from the cached read (remote-titles.ts), never a fetch;
 *  3. Claude Code's own `ai-title`;
 *  4. the first real prompt.
 * `fastSessionTitle` applies the same order on a byte budget. One line of plain text (`plainTitle`);
 * null when none exists.
 */
export function preferredSessionTitle(
  ins: Pick<TranscriptInsights, 'customTitle' | 'title' | 'firstUserPrompt'> & { bridgeSessionId?: string | null }
): string | null {
  return plainTitle(ins.customTitle ?? remoteSessionTitle(ins.bridgeSessionId) ?? ins.title ?? ins.firstUserPrompt ?? '') || null;
}

/**
 * The name a session's own views show: the change map's summary (the terminal's session chip, the
 * JetBrains Stats header) and the VS Code Stats header. A Codex session is named as its list row names
 * it (`codexSessionTitle`): read the Claude way, its derived transcript offered Codex's injected
 * context as the first prompt, so those views showed `# AGENTS.md instructions …` or a whole prompt.
 */
export function sessionViewTitle(cwd: string, session: string, insights?: TranscriptInsights): string | null {
  const transcript = findTranscript(cwd, session);
  if (transcript && isCodexTranscriptFile(transcript)) return codexSessionTitle(findCodexRollout(session) ?? '', session);
  return preferredSessionTitle(insights ?? transcriptInsights(cwd, session));
}

/** Keep list rows SHORT but informative: ai-titles already are, but the first-PROMPT fallback can be a
 *  whole pasted brief — take its first sentence, then hard-cap at 64, cut where a character ends (a cut
 *  inside a family emoji showed `👨‍👩‍�…`). Hover surfaces show it uncapped. */
export function normalizeSessionTitle(raw: string): string | null {
  let title = plainTitle(raw);
  if (!title) return null;
  const sentence = /^(.*?[.?!])(?:\s|$)/.exec(title);
  if (sentence && sentence[1].length >= 12) title = sentence[1]; // a bare "Hi." is no title
  if (title.length > 64) title = graphemeHead(title, 63).trimEnd() + '…';
  return title;
}

// --- fast session listing: the session selector + the Overview's Sessions tab ---

/** What every picker calls the machine it is running on. One constant, so the terminal, VS Code and
 *  JetBrains cannot each invent their own wording for the same fact. */
export const THIS_MACHINE = 'this machine';

/** What a listed row reads until its session has a name of its own. Display text for session lists
 *  and pickers only: it names nothing else. A herdr tab is never renamed to it, and any real title
 *  (a pane's own, the change map's) outranks it. `realSessionTitle` tells the two apart. */
export const UNTITLED_SESSION_TITLES = { claude: 'New Claude session', codex: 'New Codex session' } as const;

/** What a row reads for its workspace when nothing on disk says where its session ran. One label, so
 *  no surface shows a blank workspace in one row and a name in another for the same fact. */
export const UNKNOWN_WORKSPACE = 'Unknown workspace';

/** A listed row's title when it names the session; null when it is blank or only a placeholder. */
export function realSessionTitle(title: string | null | undefined): string | null {
  if (typeof title !== 'string' || !title.trim()) return null;
  return title === UNTITLED_SESSION_TITLES.claude || title === UNTITLED_SESSION_TITLES.codex ? null : title;
}

/**
 * One session's name as its row in `sessionMeta` gives it, found by id alone: `codexSessionTitle` of
 * its rollout, else `fastSessionTitle` of its transcript. Null while it has no name (`realSessionTitle`)
 * or has no row here: deleted from the pickers, or only a mirrored copy or a bridge pointer. The name a
 * herdr tab takes when its session names it (herdr-tabs.ts `syncSessionTab`).
 */
export function listedSessionTitle(id: string): string | null {
  if (!isSafeSessionId(id) || hiddenSessions().has(id)) return null;
  const rollout = findCodexRollout(id);
  if (rollout) return isMirroredTranscript(rollout).mirrored ? null : realSessionTitle(codexSessionTitle(rollout, id));
  const transcript = transcriptForSession(id);
  if (!transcript || isMirroredTranscript(transcript).mirrored || isBridgePointer(transcript)) return null;
  return realSessionTitle(fastSessionTitle(transcript, id));
}

const TURN_TAIL_CHUNK = 64 * 1024;
const TURN_TAIL_LIMIT = 8 * 1024 * 1024;
/** What a turn is in each agent's session file: Claude's user and assistant records (not the system,
 *  bridge-session, cost-state, last-prompt or mode lines a resume appends, nor meta stubs, nor the
 *  `<synthetic>` reply Claude Code stamps when it resumes a cut-off turn); Codex's response items
 *  (messages, reasoning, tool calls and their output), not its session_meta, turn_context, world_state or
 *  the thread_settings_applied a reattach writes. */
const TURN_OF = {
  claude: (o: any): boolean => (o?.type === 'user' || o?.type === 'assistant') && o.isMeta !== true && o.message?.model !== '<synthetic>',
  codex: (o: any): boolean => o?.type === 'response_item',
};

/**
 * When a session last took a turn: the timestamp of the newest turn record in its file, read back from
 * the end in 64 KB steps. A resume appends bookkeeping with a fresh timestamp and a fresh mtime while
 * nobody takes a turn (herdr restoring a two-day-old Claude session at startup made it
 * the "most recently active" session, and Review opened on it instead of the one being worked on). 0 when
 * the whole file holds no turn; null when that is unknown: the file cannot be read, or its last 8 MB hold
 * no turn. Memoized per file stamp. Each step searches only its own bytes for a line break, so a line
 * longer than a step costs its length once.
 */
export function lastTurnMs(file: string, agent: keyof typeof TURN_OF): number | null {
  return cachedByFiles(`last-turn-${agent}`, [file], (): number | null => {
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch { return null; }
    try {
      const size = fs.fstatSync(fd).size;
      let end = size;
      // The start of the line cut at `end`, read in earlier steps, in file order: it runs on to a line break.
      let pieces: Buffer[] = [];
      while (end > 0 && size - end < TURN_TAIL_LIMIT) {
        const start = Math.max(0, end - TURN_TAIL_CHUNK);
        const chunk = Buffer.alloc(end - start);
        fs.readSync(fd, chunk, 0, chunk.length, start);
        // The first line of the step may begin before `start`: only what follows its line break is whole.
        const cut = start > 0 ? chunk.indexOf(0x0a) : -1;
        if (start > 0 && cut === -1) { pieces.unshift(chunk); end = start; continue; }
        const lines = Buffer.concat([chunk.subarray(cut + 1), ...pieces]).toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('"timestamp"')) continue;
          let o: any;
          try { o = JSON.parse(lines[i]); } catch { continue; }
          if (!TURN_OF[agent](o)) continue;
          const ts = Date.parse(o.timestamp);
          if (ts > 0) return ts;
        }
        pieces = start > 0 ? [chunk.subarray(0, cut)] : [];
        end = start;
      }
      return end > 0 ? null : 0;
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  });
}

export interface SessionMetaRow {
  id: string;
  /** Which workspace this session belongs to, as a readable label (`~`, `Github-myrepo`), or
   *  UNKNOWN_WORKSPACE when nothing on disk records it — never blank. Sessions from every workspace
   *  are offered, so the row has to SAY which one — the previous listing mixed ancestor-directory
   *  sessions in with this repo's and named none of them. */
  workspace: string;
  /** Absolute cwd, separate from the display label; availability checked on this machine. */
  workspacePath?: string;
  workspaceExists?: boolean;
  /** Where the conversation lives: `local`, a real transcript on this machine (mirrored copies and bridge pointers are
   *  not listed at all); `synced`, another machine's session as its records hold it, in the listing of every machine
   *  (`oak sessions --json --synced`). */
  origin: 'local' | 'synced';
  /** WHICH MACHINE this session lives on, ready to render: [THIS_MACHINE]. Present on every row, in its
   *  own field, so no picker has to infer it and none of them can disagree about the answer. */
  machine: string;
  /** Human-readable name in preferredSessionTitle's order (a rename, the claude.ai Remote Control title,
   *  the latest ai-title, the first user prompt), normalized; a Codex row's is `codexSessionTitle`'s. A
   *  listed row with no name reads its agent's UNTITLED_SESSION_TITLES placeholder, which
   *  `realSessionTitle` reports as no name. */
  title: string | null;
  /** Conversation recency: the TRANSCRIPT's mtime (a review click on the store must not resurrect a
   *  dead session), falling back to log.jsonl mtime for a transcript that vanished. */
  lastActiveMs: number;
  /** When the session last took a TURN: the newest user or assistant record (a Codex response item),
   *  which bookkeeping a resume appends never moves (`lastTurnMs`). Null when it never took one; absent
   *  when that is unknown (a file past the reader's reach), where callers fall back to `lastActiveMs`. */
  lastTurnMs?: number | null;

  liveMs: number;
  /** What the agent is waiting on RIGHT NOW, if anything — from the Notification/Stop hooks
   *  (cleared the moment a tool runs again), upgraded to `question` when the transcript tail
   *  holds an unanswered AskUserQuestion. Null = nothing waiting. `idle-done` is the quiet
   *  "turn finished, your move" state; surfaces show it but never toast it. */
  attention: { kind: 'permission' | 'input' | 'question' | 'idle-done'; message: string; ts: number } | null;
  /** The terminal app's native tab this session runs in (`<tab>@<pid>`, from tab.json), when one
   *  launched it — the auto-title's link. Null for every other session. */
  tab: string | null;
  /** True for the session `resolveSessionId(cwd)` currently answers with. */
  current: boolean;
  /** What the session did to this workspace, in the terms the log itself carries: how many edits were
   *  captured, how many still await review, and how many distinct files they touched. Zeros for a
   *  session with no store — a conversation that only asked and read changed nothing, which is a fact,
   *  not a gap. Line deltas are deliberately absent: they live in the content blobs, and reading two per
   *  edit is exactly the cost this listing exists to avoid. */
  edits: number;
  pending: number;
  files: number;
  /** Lines added / removed across the session's captured edits (sidecar-cached — see SessionCounts). */
  added: number;
  removed: number;
  /** The newest record id in the session's log when this row was counted (0 with no store). A delete
   *  confirmed from this row passes it as `seenThrough`, so an edit captured after the row is refused. */
  lastEdit: number;
  /** NEW tokens the conversation produced — uncached input + generated output — and its wall-clock
   *  span. Both ride sessionUsage's persisted byte cursor, so a finished session is a stat and the
   *  live one is a delta parse. */
  tokens: number;
  /** Cache traffic (cacheRead + cacheCreation), counted SEPARATELY and never folded into `tokens`.
   *  `cacheRead` is the whole prompt re-read every turn, so adding it made the same context count
   *  once per turn: it was 98.8% of the old blended figure, which reported 372.2M for a session that
   *  produced 901k. The two reconcile — `tokens + cached` is exactly that old number — so this hides
   *  nothing; it just stops one of them impersonating the other. */
  cached: number;
  durationMs: number;
  /** The session store's on-disk footprint in bytes (log + blobs), so every picker that lists a session
   *  can show what it costs to keep — the same figure the TUI's session blobs show. Cached on the store's
   *  shape (stat-keyed), so a listed-but-idle session pays a stat, not a walk. 0 when it has no store. */
  storeBytes: number;
  /** The store DIRECTORY on disk, so an out-of-process client (JetBrains) can reveal it in the OS file
   *  manager without replicating core's path-mangling. In-process clients (VS Code, the TUI) call
   *  `storeDir(id)` directly instead. Deterministic from the id — a string op, no I/O. */
  storePath: string;
  /** The model serving the session's latest turn ('' when no turn exists yet) and the reasoning effort
   *  it declared ('' when it never declared one — unset is reported as unknown, never guessed, because
   *  the default differs by build and model). */
  model: string;
  effort: string;


  agent: string;
  /**
   * WHAT THIS AGENT IS DOING, for the sessions recent enough for the question to mean anything.
   *
   * Absent means "not asked", which for an old session is the same as idle — a conversation nobody
   * has touched in hours is not blocked on you. Bounded on purpose: this reads each transcript's
   * tail (~2 ms), and a machine with a hundred sessions would otherwise pay for ninety answers
   * nobody can act on.
   *
   * It exists so a surface can tell a session that FINISHED from one WAITING ON A HUMAN. Every
   * cross-session list had to collapse those together, because the only phase in any payload was the
   * current session's.
   */
  phase?: string;
  /** How confident `phase` is: 'high' when a structural marker said so, 'heuristic' when it was
   *  inferred from staleness. A renderer dims the guess rather than presenting it as a fact. */
  phaseConfidence?: string;
  /**
   * The workers this session spawned that are still at it (`activeWorkers`): working, or waiting on a person,
   * each with its title, phase, model, edits, tokens and last write. Empty when none is, and for a session whose
   * agent keeps no subagent transcripts (Codex). A finished worker is left out; the Workers list keeps it.
   */
  activeWorkers: ActiveWorker[];
  /** A Codex session's last turn is still running: its rollout's last `task_started` has no `task_complete`
   *  or `turn_aborted` after it (`codexDerivedTurnOpen`, else `codexTurnOpen`). Asked when `phase` is; absent
   *  for a Claude session and when the rollout cannot say. `paneAgentState` reads it, with `lastActiveMs`, the
   *  rollout's mtime. */
  turnOpen?: boolean;
}

/** How long a session stays worth asking about. Past this it is idle by definition, and reading its
 *  transcript to be told so is work nobody can act on. */
const PHASE_WINDOW_MS = 2 * 60 * 60 * 1000;

function phaseOf(transcript: string, lastActiveMs: number, id: string): { phase?: string; phaseConfidence?: string } {
  if (!transcript || Date.now() - lastActiveMs > PHASE_WINDOW_MS) return {};
  try {
    const d = agentPhaseDetail(transcript, id);
    return { phase: d.phase, phaseConfidence: d.confidence };
  } catch {
    return {}; // a torn transcript is not a phase — absent, never guessed
  }
}

/** `turnOpen` for a Codex row, on `phaseOf`'s terms: what the rollout's derivation, which this listing has just run,
 *  read of its turn; else read back from the rollout's end (a derivation from before it kept the turn). */
function turnOf(rollout: string | undefined, lastActiveMs: number): { turnOpen?: boolean } {
  if (!rollout || Date.now() - lastActiveMs > PHASE_WINDOW_MS) return {};
  const open = codexDerivedTurnOpen(rollout) ?? codexTurnOpen(rollout);
  return open === null ? {} : { turnOpen: open };
}

/** A listed session's running workers, asking only the ones the local index did not find finished (`live`), and none
 *  where no folder of workers is beside its transcript. */
function workersOf(transcript: string, id: string, live: ListingLive): ActiveWorker[] {
  const known = live.workers(id);
  return known === null ? [] : activeWorkers(transcript, id, Date.now(), known);
}

export interface SessionMeta {
  active: string | null;
  /** This machine's sessions grouped by workspace, editor root first; newest in each group. */
  sessions: SessionMetaRow[];
  /** Other machines' raised hands as their record logs brought them (`oak sessions --json`, from the local index; absent
   *  when there are none): every surface lists them, labelled with their machine, and announces them. */
  syncedHands?: import('./notify').InboxRow[];
}

/**
 * The cheap session list both pickers and the Sessions tab render. Deliberately carries NO pending or
 * edit counts: computing them meant a full `readLog` of every session in the store per open (2.2 MB of
 * JSONL on a mature machine), and recency plus name is what the switch decision actually needs. Titles
 * come from a BOUNDED transcript scan (tail for the latest ai-title, head for the first prompt) behind
 * an on-disk sidecar keyed to the transcript's (mtime,size), so even a cold CLI spawn answers in stats.
 */
/**
 * How long a conversation must have been quiet before "it is finished" is a safe thing to assume.
 *
 * A DAY, not the five minutes the phase heuristic uses to call a session `done`. That heuristic decides
 * how to draw a badge; this one decides whether to recursively delete a session's edit history and undo
 * snapshots, and the two do not deserve the same clock. `current` protects only ONE session — it is the
 * newest transcript in the project dir — so with several Claude sessions open in a repo (which the whole
 * Fleet view exists for) every other one is a candidate the moment it goes quiet. Five minutes of quiet
 * is a user thinking about their next prompt; a day is a session they have moved on from.
 */
export const REAP_QUIET_MS = 24 * 60 * 60_000;

/**
 * How long a conversation must be dead before it counts as ABANDONED rather than merely quiet.
 *
 * A session with unreviewed edits is not finished — but one nobody has spoken to in a fortnight is never
 * going to be reviewed either, and it is the bulk of what accumulates. Two weeks is chosen to be
 * conservative about what it discards: on the store this was built against it clears 11 sessions while
 * dropping 108 unreviewed edits, where a one-week threshold would drop 792.
 */
export const REAP_STALE_MS = 14 * 24 * 60 * 60_000;

export interface ReapCandidate {
  id: string;
  title: string | null;
  /** Transcript mtime — CONVERSATION recency, not store-write recency. See the note below. */
  lastActiveMs: number;
  edits: number;
  /** Unreviewed edits that would be DISCARDED with it. Always 0 for a `finished` candidate. */
  pending: number;
  /** `finished` = nothing left to review. `abandoned` = still had pending edits, but nobody came back. */
  reason: 'finished' | 'abandoned';
}

/**
 * Sessions in `cwd` whose review is finished and whose data is safe to discard.
 *
 * Every clause is a refusal, and each one is load-bearing:
 *  - not `current` — never the session the user is working in;
 *  - `pending === 0` — nothing left to review, which is the whole definition of finished here;
 *  - quiet for REAP_QUIET_MS — a session with no pending edits *yet* is not a finished one;
 *  - no in-flight capture — the one liveness signal no timestamp can give us (see hasInflightCapture).
 *
 * Staleness is measured on `lastActiveMs` (transcript mtime), never on the store log's mtime. Accepting
 * a batch of old edits writes the log, so a log-mtime clock would make reviewing a dead session look
 * like reviving it — and, worse for a reaper, a long live conversation that made all its edits early
 * looks ANCIENT by that clock. The list is cheap: sessionMeta is sidecar-cached, one stat per session.
 */
export function reapableSessions(cwd: string, now: number = Date.now(), staleMs: number = REAP_STALE_MS): ReapCandidate[] {
  // THIS workspace only, by exact match. sessionMeta's own provenance rail is `findTranscript`, which
  // WALKS UP to the filesystem root — so a session started in an ancestor directory (~, ~/Github, a
  // monorepo root, all ordinary launch dirs) resolves here and would be reaped from a subdirectory.
  // Listing such a session is fine; deleting it is not, so the destructive path narrows the rule.
  const here = projectDir(cwd);
  return sessionMeta(cwd, null, { includeEmpty: true })
    .sessions.filter((r) => {
      const t = findTranscript(cwd, r.id);
      if (!t || path.dirname(path.resolve(t)) !== path.resolve(here)) return false;
      if (r.current || hasInflightCapture(r.id)) return false;
      const quiet = now - r.lastActiveMs;
      // Two ways to be done with a session, and they need different clocks. FINISHED: nothing left to
      // review — a day of quiet is enough. ABANDONED: it still has unreviewed edits, but the conversation
      // has been dead for a fortnight and nobody is coming back. Without the second clause almost nothing
      // qualifies on a real store: most old sessions were simply never reviewed to the end.
      return r.pending === 0 ? quiet > REAP_QUIET_MS : quiet > staleMs;
    })
    .map((r) => ({
      id: r.id,
      title: r.title,
      lastActiveMs: r.lastActiveMs,
      edits: r.edits,
      pending: r.pending,
      reason: r.pending === 0 ? ('finished' as const) : ('abandoned' as const),
    }));
}

/** A pending AskUserQuestion in the transcript TAIL: a tool_use with no tool_result yet. The
 *  payload is structured (question/header/options with descriptions), so surfaces can render the
 *  real choices — read-only, because the owning terminal holds stdin. */
export interface PendingQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

const QUESTION_TAIL_BYTES = 256 * 1024;

function pendingQuestionInTail(transcript: string): PendingQuestion | null {
  let tail = '';
  try {
    const fd = fs.openSync(transcript, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - QUESTION_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString('utf8', 0, n);
      if (start > 0) tail = tail.slice(tail.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const uses = new Map<string, PendingQuestion>();
  const answered = new Set<string>();
  for (const line of tail.split('\n')) {
    if (!line.includes('AskUserQuestion') && !line.includes('tool_result')) continue;
    let o: { type?: string; message?: { content?: unknown } } | undefined;
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    if (o?.type === 'api-request-blob') continue;
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as { type?: string; name?: string; id?: string; tool_use_id?: string; input?: { questions?: unknown[] } }[]) {
      if (c?.type === 'tool_use' && c.name === 'AskUserQuestion' && c.id) {
        const q = (c.input?.questions as { question?: string; header?: string; multiSelect?: boolean; options?: { label?: string; description?: string }[] }[] | undefined)?.[0];
        if (q) {
          uses.set(c.id, {
            question: String(q.question ?? ''),
            header: String(q.header ?? ''),
            multiSelect: q.multiSelect === true,
            options: (q.options ?? []).map((op) => ({ label: String(op?.label ?? ''), description: String(op?.description ?? '') })),
          });
        }
      } else if (c?.type === 'tool_result' && c.tool_use_id) {
        answered.add(c.tool_use_id);
      }
    }
  }
  let out: PendingQuestion | null = null;
  for (const [id, q] of uses) if (!answered.has(id)) out = q; // the LAST unanswered ask stands
  return out;
}

/** The session's pending question, if one is waiting — for the surfaces that render its options. */
export function pendingQuestion(cwd: string, sessionId: string): PendingQuestion | null {
  const t = findTranscript(cwd, sessionId);
  return t ? pendingQuestionInTail(t) : null;
}

/** The row's attention state: the hook-recorded wait, upgraded to `question` when the tail holds
 *  an unanswered AskUserQuestion (only probed while a wait is actually recorded — the tail read
 *  is bounded but not free, and a session with no hand raised needs no scan). `live`: the wait as the local index
 *  read it when it caught up, in place of the file. */
function attentionOf(id: string, transcript: string | null, live?: ListingLive): SessionMetaRow['attention'] {
  const a = live ? live.attention(id) : readAttention(id);
  return a ? withPendingQuestion(a, transcript) : null;
}

/** A recorded wait as the surfaces read it: an input or permission wait whose transcript's tail holds an unanswered
 *  AskUserQuestion is that `question`, named by its header or its text. The index publishes it so (ingest.ts
 *  ingestAttention), and another machine reads it as this one does. */
export function withPendingQuestion(a: NonNullable<SessionMetaRow['attention']>, transcript: string | null): NonNullable<SessionMetaRow['attention']> {
  if ((a.kind === 'input' || a.kind === 'permission') && transcript) {
    const q = pendingQuestionInTail(transcript);
    if (q) return { kind: 'question', message: q.header || q.question, ts: a.ts };
  }
  return a;
}

/**
 * The Claude Code sessions running on this machine right now, by id. Claude Code keeps one record per
 * running process at `<config>/sessions/<pid>.json` (`{pid, sessionId, cwd, …}`), rewrites it as the
 * session changes and deletes it at exit; a record whose process has died is not evidence. Empty when
 * the directory is absent (nothing running, or a Claude Code that predates it).
 */
function runningClaudeSessions(): Set<string> {
  const dir = path.join(claudeConfigDir(), 'sessions');
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { pid?: unknown; sessionId?: unknown };
      if (typeof r.sessionId === 'string' && typeof r.pid === 'number' && pidAlive(r.pid)) out.add(r.sessionId);
    } catch {
      /* a torn record is not evidence */
    }
  }
  return out;
}

/** Whether the model produced anything in this conversation: an assistant record that is not Claude
 *  Code's `<synthetic>` stand-in (an API error, a usage limit, "No response requested." after an
 *  interrupt). Only a row with no edits and no tokens asks, so an ordinary conversation never pays
 *  for the read. */
function hasModelTurn(transcript: string): boolean {
  try {
    return readLines(transcript).some((line) => {
      if (!line.includes('"assistant"')) return false;
      try {
        const o = JSON.parse(line);
        if (o?.type === 'api-request-blob') return false;
        const m = o?.message;
        return m?.role === 'assistant' && m.model !== '<synthetic>';
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * What the session listing reads of a transcript's or a rollout's head, asked through one seam. The listing reads the
 * files (each answer has its own sidecar); the local index answers from what it recorded at the same file stamp, so a
 * listing it serves reads none of them again (index/ingest.ts).
 */
export interface ListingProbe {
  /** `isMirroredTranscript`. */
  mirrored(file: string): { mirrored: boolean; recordedCwd?: string };
  /** `isBridgePointer`. */
  bridge(file: string): boolean;
  /** `codexSessionSources`. */
  codexSources(): CodexSessionSource[];
}

export const LIVE_LISTING_PROBE: ListingProbe = {
  mirrored: isMirroredTranscript,
  bridge: isBridgePointer,
  codexSources: () => codexSessionSources(),
};

/** A Claude transcript the listing considers: its session id, its file, and the label of the project folder it is in. */
export interface ListingTranscript {
  id: string;
  file: string;
  label: string;
}

/** Where a session's conversation was found: its transcript (a Codex session's derived one), the workspace and working
 *  directory it recorded, and for a Codex session its rollout and whether it is an Auto-review thread. */
export interface ListingFound {
  file: string;
  workspace: string;
  cwd?: string;
  source?: string;
  review?: boolean;
}

export interface ListingDiscovery {
  byId: Map<string, ListingFound>;
  /** Ids whose every transcript here is a mirrored copy or a bridge pointer. */
  excluded: Set<string>;
}

/** A workspace label for a recorded directory, or UNKNOWN_WORKSPACE when none is recorded: never blank. */
export function listingWorkspace(dir: string | null | undefined): string {
  return (dir ? workspaceLabel(dir) : '') || UNKNOWN_WORKSPACE;
}

/** Every Claude transcript, in the listing's order: project folders by label, then each folder's names. */
export function listingTranscripts(): ListingTranscript[] {
  const out: ListingTranscript[] = [];
  for (const w of listWorkspaces()) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(w.dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      if (isSafeSessionId(id)) out.push({ id, file: path.join(w.dir, n), label: w.label });
    }
  }
  return out;
}

/**
 * Which conversation each session id names. Every workspace's transcripts are indexed by id, so a row can name where it
 * came from: the listing used to gate on `findTranscript`, which WALKS UP the tree, so sessions belonging to `~` and
 * other ancestors were offered as if they were this repo's, 13 of 63 on the repo that found this, with nothing on the
 * row to say otherwise. The first project folder (by label) whose copy is neither mirrored nor a bridge pointer wins; an
 * id whose every copy is one is excluded. Codex's rollouts follow, newest first, so an archived copy loses.
 */
export function discoverListing(transcripts: Iterable<ListingTranscript>, codex: Iterable<CodexSessionSource>, probe: ListingProbe = LIVE_LISTING_PROBE): ListingDiscovery {
  const byId = new Map<string, ListingFound>();
  const excluded = new Set<string>();
  for (const t of transcripts) {
    if (byId.has(t.id)) continue;
    const provenance = probe.mirrored(t.file);
    if (provenance.mirrored || probe.bridge(t.file)) { excluded.add(t.id); continue; }
    const sessionCwd = provenance.recordedCwd;
    byId.set(t.id, { file: t.file, workspace: sessionCwd ? workspaceLabel(sessionCwd) : t.label, cwd: sessionCwd });
  }
  const codexIds = new Set<string>();
  for (const source of codex) {
    if (codexIds.has(source.id)) continue; // newest rollout wins when an archived copy also exists
    const file = codexTranscriptFile(source.file); if (!file) continue;
    codexIds.add(source.id);
    byId.set(source.id, { file, workspace: listingWorkspace(source.cwd), cwd: source.cwd, source: source.file, review: source.review });
  }
  return { byId, excluded };
}

/**
 * What the listing derives for one session from its files on disk, before anything about this moment is added (its
 * attention, tab, phase and workers, whether it is current, pinned or running, whether it was deleted). These are the
 * facts the local index keeps per session and serves the listing from while the files they came from are unchanged.
 */
export interface SessionListingFacts {
  id: string;
  /** `transcript`: a conversation file is here (a Claude transcript, or a Codex rollout's derived one). `meta`: only the
   *  Codex hook metadata names the session. */
  shape: 'transcript' | 'meta';
  agent: 'claude' | 'codex';
  workspace: string;
  /** The working directory it recorded, which decides whether its workspace group is the caller's. */
  cwd?: string;
  transcript: string | null;
  /** The rollout the listing found it by (`ListingFound.source`). */
  source?: string;
  /** Its rollout, however found: a Codex row is titled from it. */
  rollout?: string;
  review: boolean;
  /** A Claude row's title parts (`sessionTitleParts`). The Remote Control title they may name is looked up when the row
   *  is listed, as `fastSessionTitle` does, never kept. */
  titleParts?: SessionTitleParts | null;
  /** A Codex row's title, null when it has none. */
  title?: string | null;
  /** The files that title was read from besides the rollout and Codex's thread names (`codexTitleInputs`). */
  titleInputs?: string[];
  lastActiveMs: number;
  /** `lastTurnMs`'s answer; null when it cannot say. */
  lastTurn: number | null;
  /** capture-events.jsonl's modification time, 0 without one: the activity clock a hook moves mid-turn. */
  captureMs: number;
  counts: SessionCounts;
  tokens: number;
  cached: number;
  durationMs: number;
  storeBytes: number;
  model: string;
  effort: string;
  /** Whether the model produced a turn (`hasModelTurn`): asked only of a session with no edits, tokens or cache traffic,
   *  the one the listing would otherwise leave out. */
  modelTurn: boolean;
}

/** A listed row's title from its facts: the rollout's for a Codex session, else the transcript's parts in
 *  `preferredSessionTitle`'s order (as `fastSessionTitle` reads them), else the agent's placeholder. */
function factsTitle(f: SessionListingFacts): string {
  if (f.shape === 'meta' || f.rollout) return f.title || UNTITLED_SESSION_TITLES.codex;
  const p = f.titleParts;
  const title = p ? normalizeSessionTitle(preferredSessionTitle({ customTitle: p.rename, bridgeSessionId: p.bridge, title: p.aiTitle, firstUserPrompt: p.prompt }) ?? '') : null;
  return title || UNTITLED_SESSION_TITLES.claude;
}

/**
 * One session's listing facts, or null when the listing never shows it: every transcript of it is a mirrored copy or a
 * bridge pointer, its rollout is a mirrored copy, nothing on disk holds its conversation and no Codex hook named it, it
 * is a throwaway Codex run whose temp workspace and rollout are gone, or no file dates it. `cwd` only locates a
 * transcript a walk up from it would find, which every workspace's index already holds.
 */
export function listingFacts(id: string, disc: ListingDiscovery, cwd: string = os.homedir()): SessionListingFacts | null {
  const found = disc.byId.get(id);
  if (!found && disc.excluded.has(id)) return null;
  const rawCodex = found?.source ?? findCodexRollout(id);
  const rolloutOrigin = rawCodex ? isMirroredTranscript(rawCodex) : null;
  if (rolloutOrigin?.mirrored) return null;
  const review = found?.review === true;
  const transcript = found?.file ?? findTranscript(cwd, id);
  const titleInputs = new Set<string>();
  const titled = (read: () => string | null): string | null => {
    const t = codexTitleInputs(read);
    for (const f of t.files) titleInputs.add(f);
    return t.value;
  };
  // The earlier history of a session whose store folder was made anew (oak sync, sync-store.ts), listed as that: from its
  // own store alone (a Codex session's agent record names its workspace), so the local index, which reads each session
  // from its own files, lists it as this listing does.
  const of = transcript ? null : earlierGenerationOf(id);
  if (of && fs.existsSync(logPath(id))) {
    const meta = readCodexAgentMeta(id);
    let lastActiveMs = 0;
    try {
      lastActiveMs = fs.statSync(logPath(id)).mtimeMs;
    } catch {
      return null;
    }
    return {
      id, shape: 'meta', agent: meta ? 'codex' : 'claude', workspace: listingWorkspace(meta?.cwd), ...(meta?.cwd ? { cwd: meta.cwd } : {}), transcript: null,
      review: false, title: `earlier history of session ${of}`, lastActiveMs, lastTurn: null, captureMs: 0, counts: sessionCounts(id), tokens: 0, cached: 0,
      durationMs: 0, storeBytes: storeBytes(id), model: meta?.model ?? '', effort: '', modelTurn: false,
    };
  }
  if (!transcript) {
    // Codex hook metadata keeps a captured session discoverable before its rollout is available.
    const codexMeta = readCodexAgentMeta(id);
    if (!codexMeta) return null; // truly nothing to open
    // Drop a dead throwaway codex session: one whose recorded workspace is a temp dir AND whose
    // raw rollout is gone (a scratch `codex exec` from a probe/review — no conversation to resume).
    // Scoped to temp roots so a real project is never hidden, and only when the rollout is truly
    // gone: a real codex session run in /tmp keeps its rollout (findCodexRollout finds it) and stays.
    if (typeof codexMeta.cwd === 'string' && codexMeta.cwd) {
      const cw = path.resolve(codexMeta.cwd);
      const tmp = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders'].some((r) => cw.startsWith(path.resolve(r) + path.sep));
      if (tmp && !findCodexRollout(id)) return null;
    }
    let title: string | null = null;
    let lastActiveMs = 0;
    try {
      const events = readCaptureEvents(id, ['turn_start']);
      for (const event of events) {
        const prompt = (event.payload as { prompt?: string })?.prompt;
        if (typeof prompt === 'string') { title = plainTitle(codexPromptText(prompt) ?? '') || null; if (title) break; }
      }
      title = titled(() => codexSessionTitle(rawCodex || '', id)) || title;
      lastActiveMs = fs.statSync(captureEventsPath(id)).mtimeMs;
    } catch {
      /* a torn sidecar still identifies the session */
    }
    try {
      lastActiveMs = Math.max(lastActiveMs, fs.statSync(logPath(id)).mtimeMs);
    } catch {
      /* no log — an editless drive; the sidecar mtime stands */
    }
    let workspace = listingWorkspace(codexMeta.cwd);
    let lastTurn: number | null = null;
    let tokens = 0;
    let cached = 0;
    let model = codexMeta.model ?? '';
    let effort = '';
    let rollout: string | null = null;
    // The agent-meta cwd is the fallback workspace when the rollout can't be resolved (describeSession
    // uses it too); without it a codex session row shows a blank workspace chip on every surface.
    if (!workspace && codexMeta.cwd) workspace = workspaceLabel(codexMeta.cwd);
    try {
      rollout = findCodexRollout(id);
      if (rollout) {
        lastTurn = lastTurnMs(rollout, 'codex');
        const r = readCodexRollout(rollout);
        model = r.model || model;
        effort = r.effort || '';
        if (!workspace && r.cwd) workspace = workspaceLabel(r.cwd);
        title = titled(() => codexSessionTitle(rollout!, id)) || title;
        if (r.tokens) {
          // Same field semantics the Claude rows hold: `tokens` is NEW work (uncached input +
          // output), cache traffic counts separately and never impersonates it.
          tokens = Math.max(0, r.tokens.input - r.tokens.cacheRead) + r.tokens.output;
          cached = r.tokens.cacheRead + r.tokens.cacheWrite;
        }
        lastActiveMs = Math.max(lastActiveMs, (() => { try { return fs.statSync(rollout!).mtimeMs; } catch { return 0; } })());
      }
    } catch {
      /* a rollout is enrichment; the session lists without it */
    }
    if (!lastActiveMs) return null;
    const counts = sessionCounts(id);
    return {
      id, shape: 'meta', agent: 'codex', workspace, cwd: codexMeta.cwd, transcript: null, ...(rollout ? { rollout } : {}), review,
      title, ...(titleInputs.size ? { titleInputs: [...titleInputs] } : {}), lastActiveMs, lastTurn, captureMs: 0, counts, tokens, cached,
      durationMs: 0, storeBytes: storeBytes(id), model, effort, modelTurn: false,
    };
  }
  // A rollout the source scan passed over (a launch with no prompt, a temp workspace since removed)
  // still records its workspace in its session_meta.
  const workspace = found?.workspace ?? listingWorkspace(rolloutOrigin?.recordedCwd ?? readCodexAgentMeta(id)?.cwd);
  let lastActiveMs = 0;
  try {
    lastActiveMs = fs.statSync(found?.source ?? transcript).mtimeMs;
  } catch {
    try {
      lastActiveMs = fs.statSync(logPath(id)).mtimeMs;
    } catch {
      /* neither file — skip the row below */
    }
  }
  if (!lastActiveMs) return null;
  // TWO clocks, on purpose. `lastActiveMs` is the CONVERSATION clock (transcript mtime) — the
  // reaper and the fold rule key on it, and folding the log in would make reviewing a dead
  // session look like reviving it (the reapableSessions rule). `liveMs` is the ACTIVITY clock:
  // a driven session's freshest evidence is its sidecar (appended per streamed chunk) or its
  // store log (hook captures land mid-turn) — transcript-only liveness flapped working agents
  // inactive between message boundaries, and the ● marks, ambient status,
  // and the head re-arm read this one.
  // Sidecar only — NOT the log file's mtime: keep/undo rewrites the log, so counting it made
  // REVIEWING a session read as the agent working.
  // Mid-turn hook captures still register through the transcript itself here.
  let captureMs = 0;
  try {
    captureMs = fs.statSync(captureEventsPath(id)).mtimeMs;
  } catch {
    /* no sidecar — the conversation clock stands */
  }
  // Tokens/duration and model/effort share ONE incremental cursor over the transcript, so asking for
  // both costs a single delta parse — and nothing at all for a session whose transcript has not moved.
  let tokens = 0;
  let durationMs = 0;
  let cached = 0;
  let model = '';
  let effort = '';
  try {
    // Cost this session from ITS OWN transcript, not from a lookup rooted at the caller's cwd —
    // `transcript` above is the exact file, found by scanning every workspace.
    const u = sessionUsage(cwd, id, transcript);
    tokens = u.total;
    // Cache traffic is COUNTED SEPARATELY, never folded into the headline. The two reconcile by
    // construction — `tokens + cached` is exactly the old blended figure — so nothing is hidden,
    // it is just no longer the case that 98.8% of "tokens" is the same context restated.
    cached = u.cacheRead + u.cacheCreation;
    durationMs = u.durationMs;
    const v = sessionVitals(cwd, id, transcript);
    model = v.model?.label ?? ''; // the display label ('Opus 4.8'), so renderers stay thin
    effort = v.effort?.level ?? '';
  } catch {
    /* an unreadable transcript still identifies a session — report the row without its vitals */
  }
  const counts = sessionCounts(id);
  const codex = !!rawCodex;
  return {
    id,
    shape: 'transcript',
    // A rollout makes it Codex's, as it already does for the title: a Codex session driven over ACP
    // has a rollout and a store but no hook metadata, and was listed as `claude`.
    agent: rawCodex || readCodexAgentMeta(id) ? 'codex' : 'claude',
    workspace,
    cwd: found?.cwd ?? readCodexAgentMeta(id)?.cwd,
    transcript,
    ...(found?.source ? { source: found.source } : {}),
    ...(rawCodex ? { rollout: rawCodex } : {}),
    review,
    ...(codex ? { title: titled(() => codexSessionTitle(rawCodex, id)), ...(titleInputs.size ? { titleInputs: [...titleInputs] } : {}) } : { titleParts: sessionTitleParts(transcript, id) }),
    lastActiveMs,
    lastTurn: lastTurnMs(rawCodex ?? transcript, rawCodex ? 'codex' : 'claude'),
    captureMs,
    counts,
    tokens,
    cached,
    durationMs,
    storeBytes: storeBytes(id),
    model,
    effort,
    modelTurn: counts.edits > 0 || tokens > 0 || cached > 0 || hasModelTurn(transcript),
  };
}

/**
 * This machine's sessions, grouped by workspace. A session in which nothing happened is left out unless
 * it may still be running (the rule is spelled out where it is applied); `includeEmpty` keeps those
 * too, for the reaper, to which they are the most finished sessions of all. A Codex Auto-review thread
 * is left out unless it is `reviewing` (named with `--session`); `includeReviews` keeps them all.
 */
export function sessionMeta(cwd: string, reviewing?: string | null, opts: { includeEmpty?: boolean; includeReviews?: boolean } = {}): SessionMeta {
  const disc = discoverListing(listingTranscripts(), codexSessionSources());
  // The store first, then every session with a TRANSCRIPT here. A store directory appears the first time the capture
  // hook fires, so a conversation that only asked, read and ran things has none — and listing the store alone hid it
  // completely. This used to be patched for exactly two ids, the active one and the pinned one, which is the same hole
  // with two exceptions cut in it. An Auto-review thread that will not be listed costs nothing to leave out.
  return composeSessionMeta(cwd, reviewing, opts, [...allStoreSessionIds(), ...disc.byId.keys()], (id) =>
    disc.byId.get(id)?.review && !opts.includeReviews && id !== reviewing ? null : listingFacts(id, disc, cwd));
}

/**
 * What the local index read of a session's store and its workers when it last caught up (index/listing.ts), which a
 * listing it serves reads instead of the files: the raised hand and the native tab's link as they stood then, and the
 * workers found finished then, which only a write to their own transcript (one the catch-up sees) can bring back.
 */
export interface ListingLive {
  attention(id: string): { kind: 'permission' | 'input' | 'question' | 'idle-done'; message: string; ts: number } | null;
  tab(id: string): string | null;
  /** Each worker found finished, by its transcript's name, with the stamp (mtime:size) it was judged at; null where no
   *  folder of workers is beside the session's transcript; undefined where the index has not read them yet. */
  workers(id: string): ReadonlyMap<string, string> | null | undefined;
}

/**
 * The listing composed from each session's facts (`listingFacts`, or the local index's copy of them) and what is true of
 * it right now: deleted from the pickers, its attention, herdr tab, phase and workers, whether it is this workspace's
 * current session, the one being reviewed, or one Claude Code lists as running. `ids` is every candidate; the current
 * and the reviewed session are asked for as well. `live` is what the local index read of the sessions' stores and
 * workers: with it, only a worker that may be running is asked anything.
 */
export function composeSessionMeta(
  cwd: string,
  reviewing: string | null | undefined,
  opts: { includeEmpty?: boolean; includeReviews?: boolean },
  ids: Iterable<string>,
  factsOf: (id: string) => SessionListingFacts | null,
  live?: ListingLive,
): SessionMeta {
  const active = (() => {
    try {
      return resolveSessionId(cwd);
    } catch {
      return null;
    }
  })();
  const rows: SessionMetaRow[] = [];
  const seen = new Set<string>();
  const hidden = hiddenSessions();
  // A session in which NOTHING HAPPENED is not listed: no captured edit, no tokens, and no turn the
  // model produced — Claude Code opened and closed at the prompt, a `/model` or `/login` and nothing
  // more, a prompt answered only by an API error, a Codex launch with no prompt. Listed, such rows buried
  // the sessions worth reviewing under titles like "New Claude session · 0 tok". A session that
  // may still be RUNNING stays, so a new one shows before its first reply: the current or pinned one,
  // one Claude Code lists as running, a raised hand, a Codex turn in flight, or activity within
  // SESSION_BUSY_MS.
  const running = runningClaudeSessions();
  const now = Date.now();
  const listed = (row: SessionMetaRow, f: SessionListingFacts): boolean =>
    opts.includeEmpty === true || row.edits > 0 || row.tokens > 0 || row.cached > 0 ||
    row.current || row.id === reviewing || running.has(row.id) ||
    (row.attention !== null && row.attention.kind !== 'idle-done') || row.phase === 'working' ||
    now - Math.max(row.lastActiveMs, row.liveMs) <= SESSION_BUSY_MS ||
    (f.transcript !== null && f.modelTurn);
  const cwds = new Map<string, string | undefined>();
  const workspaceDirectories = new Map<string, boolean | undefined>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (hidden.has(id)) return; // the user deleted this session — keep it out of every picker
    const f = factsOf(id);
    if (!f) return;
    // Auto-review runs each approval as a thread of its own, titled after the session it reviews, so on a
    // machine that uses it they can outnumber the sessions they review and push them out of view.
    if (f.review && !opts.includeReviews && id !== reviewing) return;
    const row: SessionMetaRow = f.shape === 'meta' ? {
      id,
      workspace: f.workspace,
      origin: 'local',
      machine: THIS_MACHINE,
      title: factsTitle(f),
      lastActiveMs: f.lastActiveMs,
      ...(f.lastTurn === null ? {} : { lastTurnMs: f.lastTurn || null }),
      liveMs: f.lastActiveMs,
      attention: attentionOf(id, null, live),
      tab: live ? live.tab(id) : readTabLink(id),
      current: id === active,
      ...f.counts,
      tokens: f.tokens,
      cached: f.cached,
      durationMs: 0,
      storeBytes: f.storeBytes,
      storePath: storeDir(id),
      model: f.model,
      effort: f.effort,
      agent: f.agent,
      activeWorkers: [],
    } : {
      id,
      workspace: f.workspace,
      origin: 'local',
      machine: THIS_MACHINE,
      title: factsTitle(f),
      lastActiveMs: f.lastActiveMs,
      ...(f.lastTurn === null ? {} : { lastTurnMs: f.lastTurn || null }),
      liveMs: Math.max(f.lastActiveMs, f.captureMs),
      attention: attentionOf(id, f.transcript, live),
      tab: live ? live.tab(id) : readTabLink(id),
      current: id === active,
      ...f.counts,
      tokens: f.tokens,
      cached: f.cached,
      durationMs: f.durationMs,
      storeBytes: f.storeBytes,
      storePath: storeDir(id),
      model: f.model,
      effort: f.effort,
      agent: f.agent,
      ...phaseOf(f.transcript!, f.lastActiveMs, id),
      activeWorkers: live ? workersOf(f.transcript!, id, live) : activeWorkers(f.transcript!, id),
      // The rollout the listing found, whose mtime `lastActiveMs` is.
      ...turnOf(f.source, f.lastActiveMs),
    };
    if (listed(row, f)) {
      row.workspacePath = f.cwd;
      if (f.cwd && !workspaceDirectories.has(f.cwd)) workspaceDirectories.set(f.cwd, workspaceDirectoryExists(f.cwd));
      row.workspaceExists = f.cwd ? workspaceDirectories.get(f.cwd) : undefined;
      rows.push(row);
      cwds.set(id, f.cwd);
    }
  };
  for (const id of ids) push(id);
  if (active) push(active);
  if (reviewing) push(reviewing);
  // Order once in core. Both editors and the CLI render these workspace groups verbatim.
  const groups = new Map<string, { current: boolean; last: number }>();
  for (const row of rows) {
    const sessionCwd = cwds.get(row.id);
    const current = row.current || (!!sessionCwd && canonPath(sessionCwd) === canonPath(path.resolve(cwd)));
    const group = groups.get(row.workspace);
    groups.set(row.workspace, { current: current || !!group?.current, last: Math.max(row.lastActiveMs, group?.last ?? 0) });
  }
  // The id settles a tie in time, so the order is the same however the candidates were enumerated (a directory's
  // own order, or the local index's).
  rows.sort((a, b) => {
    const ag = groups.get(a.workspace)!, bg = groups.get(b.workspace)!;
    return Number(bg.current) - Number(ag.current) || bg.last - ag.last || a.workspace.localeCompare(b.workspace) || b.lastActiveMs - a.lastActiveMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return { active, sessions: rows };
}

/** A session's review numbers, cached beside its title. */
export interface SessionCounts {
  edits: number;
  pending: number;
  files: number;
  /**
   * Lines this session added / removed across every captured edit.
   *
   * These DO cost content-blob reads — two per edit, the one thing this listing was built to avoid. A
   * live log grows constantly, so caching the total alone still re-paid the whole sum on every refresh:
   * +0.17 s a tick at 1,732 edits, +0.71 s at 7,914, worse the longer the session ran.
   *
   * What makes it cheap is a per-BLOB-PAIR delta cache (see deltaCache): the sum is recomputed in full
   * every time, but from map lookups instead of blob reads. A running total was tried first and rejected
   * — it cannot be validated. One entry written wrong (observed: a sum of 0 over 2,800 edits) is
   * inherited by every later pass, and nothing can notice, because there is nothing to check it against.
   * A blob pair is CONTENT, so a cache keyed by it is either a hit on the same bytes or a miss.
   */
  added: number;
  removed: number;
  /**
   * The newest record id in the session's log when these counts were taken (0 with no store). A delete
   * confirmed from these counts passes it back as `seenThrough`, so an edit captured after them is
   * refused even when it joined a review unit `pending` already counted (see deleteSession).
   */
  lastEdit: number;
}

// 7: added `lastEdit`, the newest record id the counts saw; 6: chains that cancel out are not counted
// (a file created then deleted is not an edit to review); 5: counts are over DISPLAY units (same-code
// collapsed), matching the change map; 4: line deltas moved to the per-blob-pair cache (deltaCache);
// 2: added `files`.
const COUNTS_SIDECAR_VERSION = 8;

/**
 * A session's captured-edit counts, cached in the same sidecar the title uses and keyed to the LOG's
 * mtime:size — so a listing pays one `stat` per session and re-reads only the logs that changed since.
 *
 * The counts exist because a session row is only useful next to what the session did: a fleet row would
 * never show a name alone. Reading them from the log is what the sidecar makes cheap; reading them from
 * the transcript would not be, which is why nothing here parses one.
 */
export function sessionCounts(sessionId: string): SessionCounts {
  const empty: SessionCounts = { edits: 0, pending: 0, files: 0, added: 0, removed: 0, lastEdit: 0 };
  let stamp = '';
  try {
    const st = fs.statSync(logPath(sessionId));
    stamp = `${COUNTS_SIDECAR_VERSION}|${st.mtimeMs}:${st.size}`;
  } catch {
    return empty; // no store — the session captured nothing
  }
  const sidecar = path.join(rootDir(), 'session-meta', `${sessionId}.json`);
  type Side = {
    stamp?: string;
    title?: string | null;
    counts?: SessionCounts;
    countsStamp?: string;
  };
  let side: Side = {};
  try {
    side = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (side && side.countsStamp === stamp && side.counts) return side.counts;
  } catch {
    /* absent or unreadable — count */
  }
  // The DISPLAY units, not the raw records — `reviewEdits` applies the same same-code collapse the
  // change map draws. Counting raw records here made the Sessions row and the Overview's summary bar
  // disagree about the same session under the same word: 5,198 pending against 3,609, and +939,803
  // against +355,905, because 1,589 records collapsed away. One product, one meaning for "pending".
  // …and not the chains that CANCEL OUT: a file created and then deleted is not an edit anybody can
  // review, and the review list, the change map and this row have to mean the same thing by "pending".
  // `lastEdit` first, over every record: a delete checks its `seenThrough` against every pending record,
  // one inside a chain that cancels out included, and an edit captured while the units below are counted
  // must come out newer than it, so that a delete confirmed from these counts refuses that edit.
  const counts = { ...empty };
  for (const r of readLog(sessionId)) if (r.id > counts.lastEdit) counts.lastEdit = r.id;
  const log = visibleEdits(sessionId);
  const files = new Set<string>();
  for (const r of log) {
    counts.edits++;
    if (r.status === 'pending') counts.pending++;
    files.add(r.file);
  }
  counts.files = files.size;
  // The sum is computed IN FULL every time, from a per-blob-pair cache. Full means a wrong number can
  // never outlive one log change; content-keyed means the cache cannot be wrong in the first place.
  const deltas = deltaCache(sessionId);
  for (const r of log) {
    const d = deltas.get(r);
    counts.added += d.added;
    counts.removed += d.removed;
  }
  deltas.flush();
  // The stamp above covers the LOG only, but `added`/`removed` are derived from BLOBS. A record whose
  // snapshot is missing (observed at ~4.7% of reads mid-rewrite — see writeStaging) yields a wrong sum,
  // and a finished session's log never changes again, so persisting it here would make that number
  // permanent — exactly the inherited-forever failure the per-pair cache was chosen to avoid. Serve
  // this pass, cache nothing, and recompute next time when the blob may be back.
  if (!deltas.complete()) return counts;
  try {
    fs.mkdirSync(path.dirname(sidecar), { recursive: true, mode: 0o700 });
    const tmp = `${sidecar}.${process.pid}.tmp`;
    // Merge, never replace: the title half of this file is keyed to the TRANSCRIPT and must survive a
    // log-only change (and the other way round).
    fs.writeFileSync(tmp, JSON.stringify({ ...side, counts, countsStamp: stamp }), { mode: 0o600 });
    fs.renameSync(tmp, sidecar);
  } catch {
    /* a cache we could not write is a cache we recompute — never an error */
  }
  return counts;
}

/** A share of a session's captured edits: review units, how many of them still await review, and their lines. */
export interface UnitTotals {
  edits: number;
  pending: number;
  added: number;
  removed: number;
}

const callUnits = new Map<string, { stamp: string; units: Map<string, UnitTotals> }>();

/**
 * The session's review units (the ones sessionCounts counts) summed by the tool call that made each one's latest
 * edit, which the capture hook records as the record's `toolCallId`, so a worker's own calls find its share of the
 * session's edits. A unit recorded without a call id is nobody's. Remembered against the log's stamp for the life
 * of the process, once every unit's lines could be counted.
 */
export function unitsByCall(sessionId: string): Map<string, UnitTotals> {
  let stamp: string;
  try {
    const st = fs.statSync(logPath(sessionId));
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return new Map(); // no store: the session captured nothing
  }
  const key = `${rootDir()}\u0000${sessionId}`;
  const hit = callUnits.get(key);
  if (hit?.stamp === stamp) return hit.units;
  const units = new Map<string, UnitTotals>();
  const deltas = deltaCache(sessionId);
  for (const r of visibleEdits(sessionId)) {
    if (!r.toolCallId) continue;
    let u = units.get(r.toolCallId);
    if (!u) units.set(r.toolCallId, (u = { edits: 0, pending: 0, added: 0, removed: 0 }));
    const d = deltas.get(r);
    u.edits++;
    if (r.status === 'pending') u.pending++;
    u.added += d.added;
    u.removed += d.removed;
  }
  deltas.flush();
  if (deltas.complete()) {
    if (callUnits.size >= 64) callUnits.clear();
    callUnits.set(key, { stamp, units });
  }
  return units;
}

/**
 * How long a delete waits for a capture in progress. VS Code's extension host and the terminal app call
 * deleteSession on their own thread, so a capture that holds the mutex longer is a refusal to retry, not a
 * frozen editor: the default 5 s blocked that thread for all of it.
 */
const DELETE_WAIT_MS = 500;

/**
 * Remove a session from Observatory: hide it from every picker AND purge its stored edits/blobs.
 * The agent's own transcript or rollout is left untouched (deleting Claude Code's or Codex's files
 * is not ours to do); the hidden list is what keeps the session out of the listings regardless.
 *
 * The purge is for good, unless oak sync's backup folder keeps a copy of the session's store (deleteWords):
 * `unhideSession` (`oak sessions --undelete`) puts the session back in the pickers, never its edits, which only
 * the next `oak sync now` brings back from that folder. An edit still pending review loses its before-snapshot
 * with it, so the agent's change on disk can no longer be undone here. A session that holds any is therefore refused
 * unless the caller's confirmation named them: `confirmedPending` is the count it showed (the CLI's
 * `--force` passes Infinity), and a delete that finds more pending than that is refused.
 * The count is of review units, as the dialog's is, so an edit that rewrites a change the
 * dialog already counted joins that change and leaves the count as it was. `seenThrough` closes that
 * gap: it is the newest record id of the listing the count came from (`SessionCounts.lastEdit`), and a
 * delete that finds a pending record newer than it is refused too, so no edit captured after that
 * listing is purged unseen. A caller that passes no `seenThrough` (an older editor) gets the count check
 * alone. The checks and the purge hold the session's capture mutex, so no capture lands between them.
 */
export function deleteSession(sessionId: string, opts: { confirmedPending?: number; seenThrough?: number } = {}): void {
  // A folder the store keeps for itself (oak sync's) is no session: hiding it would send its delete to every machine.
  if (isReservedStoreDir(sessionId)) throw new Error(`${sessionId} is no session but a folder OAK's store keeps for itself, so it was not deleted`);
  const confirmed = typeof opts.confirmedPending === 'number' && opts.confirmedPending >= 0 ? opts.confirmedPending : 0;
  const seenThrough = typeof opts.seenThrough === 'number' && Number.isFinite(opts.seenThrough) ? opts.seenThrough : Infinity;
  try {
    // The capture mutex is named for the store once any move is over: named before the wait, a delete that waited out a
    // move locked the session where the store had been, beside a capture locking it where the store went.
    outsideStoreMoves(() => withFileMutation(captureMutex(sessionId), () => deleteSessionLocked(sessionId, confirmed, seenThrough), DELETE_WAIT_MS));
  } catch (e) {
    if (e instanceof FileBusyError) throw new Error(`${sessionId} is recording an edit right now, so it was not deleted; try again in a moment`);
    throw e;
  }
}

function deleteSessionLocked(sessionId: string, confirmed: number, seenThrough: number): void {
  // A pending edit needs a pending record, and the log is cheap to read; the display count (sidecar-cached,
  // a whole derivation when it cannot be cached) is asked only when one exists. Editors call this in-process.
  const log = readLog(sessionId);
  const pending = !log.some((r) => r.status === 'pending') ? 0 : sessionCounts(sessionId).pending;
  if (pending > confirmed) {
    const edits = `${pending} edit${pending === 1 ? '' : 's'} pending review`;
    throw new Error(confirmed
      ? `${sessionId} has ${edits}, more than the ${confirmed} this delete confirmed; deleting the session would purge the rest unseen, so it was not deleted`
      : `${sessionId} has ${edits}; deleting the session would purge ${pending === 1 ? 'it' : 'them'} ${(require('./sync-engine') as typeof import('./sync-engine')).deleteWords().purged}, so it was not deleted`);
  }
  const unseen = log.filter((r) => r.status === 'pending' && r.id > seenThrough).length;
  if (unseen)
    throw new Error(`${sessionId} captured ${unseen === 1 ? 'an edit' : `${unseen} edits`} after the listing this delete was confirmed from, still pending review; deleting the session would purge ${unseen === 1 ? 'it' : 'them'} unseen, so it was not deleted`);
  hideSession(sessionId);
  // A deliberate delete, which oak sync carries as one (a tombstone), not a cleanup: an undelete can bring it back.
  try { removeSession(sessionId, { evict: false }); } catch { /* no store dir (a transcript-only session) — hiding is enough */ }
  // Forgotten in the local index at once, its full-text entries with it, and in this machine's record log, from whichever
  // surface deleted it (the terminal app and VS Code delete in place). Nothing happens where the index is unavailable:
  // the next catch-up by a CLI purges it.
  try { storeIndexHooks()?.forget(sessionId); } catch { /* the next catch-up purges it */ }
}

/** Bump when the stored shape changes. */
const DELTA_CACHE_VERSION = 1;

/**
 * A session's line deltas, cached per BLOB PAIR on disk.
 *
 * The key is `<beforeSha>:<afterSha>` — the content itself — so an entry is either a hit on exactly
 * those bytes or a miss. That is the whole reason this shape was chosen over a running total: a total
 * is a derived number with nothing to check it against, and one bad write is inherited forever. Blobs
 * are immutable and content-addressed, so a hit here is exact by construction, and identical edits
 * across records collapse onto one entry (within this session — the file is per session).
 *
 * Lives beside the session's other derived copies so dropping a session reaps it too.
 */
function deltaCache(sessionId: string): { get(r: EditRecord): { added: number; removed: number }; flush(): void; complete(): boolean } {
  const file = isSafeSessionId(sessionId)
    ? path.join(rootDir(), 'changemap-cache', sessionId, 'deltas.json')
    : null;
  const map = new Map<string, [number, number]>();
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; pairs?: Record<string, [number, number]> };
      if (j && j.version === DELTA_CACHE_VERSION && j.pairs) for (const [k, v] of Object.entries(j.pairs)) map.set(k, v);
    } catch {
      /* absent or unreadable — recompute */
    }
  }
  const keep = new Map<string, [number, number]>();
  let dirty = false;
  let complete = true; // false once any record's blobs could not be read
  return {
    complete: () => complete,
    get(r) {
      const key = pairKeyOf(r.beforeBlob, r.afterBlob);
      const cached = map.get(key) ?? pairDelta(sessionId, key);
      if (cached) {
        keep.set(key, cached); // retained: this pass used it
        return { added: cached[0], removed: cached[1] };
      }
      const d = lineDelta(sessionId, r);
      const v: [number, number] = [d.added, d.removed];
      // A blob that cannot be READ is not the same as an edit with no blob. `blobText` returns '' for a
      // GC'd snapshot so rendering degrades instead of crashing — which means lineDelta happily reports
      // "the whole file was removed" and we would file that under the INTACT sha. Content-keying makes a
      // hit exact only when the content was actually there; nothing would ever heal this entry, because
      // the key never changes. Same guard placementStore already applies to the same hazard.
      if (hasBlob(sessionId, r.beforeBlob) && hasBlob(sessionId, r.afterBlob)) {
        keep.set(key, v);
        dirty = true;
      } else {
        complete = false; // this pass's SUM is a guess; the caller must not persist it (see sessionCounts)
      }
      return { added: v[0], removed: v[1] };
    },
    flush() {
      // The FILE is written by the shared store now, pruned by log membership rather than by what
      // this pass happened to touch — `lineDelta` writes the same entries, and two passes pruning to
      // their own reference sets would delete each other's work on every poll.
      if (!dirty && keep.size === map.size) return;
      const live = new Set<string>();
      try {
        for (const r of readLog(sessionId)) live.add(pairKeyOf(r.beforeBlob, r.afterBlob));
      } catch {
        /* an unreadable log prunes nothing */
      }
      flushPairDeltas(sessionId, live);
    },
  };
}

// 2: a pasted-only first prompt (`<pasted_content>`) is a title now (2026-09-22).
// 4: the sidecar holds the title's PARTS — a rename (`custom-title`) outranks the ai-title, and the
//    Remote Control title between them is looked up at read time, never cached here (2026-09-24).
// 5: a prompt title loses its markdown heading markers on EVERY line, which only a rescan can do: a
//    v4 part has its lines already joined (2026-09-24).
// 6: a prompt title cut at 64 ends where a character does; a v5 part could end inside an emoji (2026-10-17).
const TITLE_SIDECAR_VERSION = 7;
const TITLE_TAIL_SCAN = 4 * 1024 * 1024; // title records ride near the end; latest wins
const TITLE_HEAD_SCAN = 256 * 1024; // the first user prompt sits near the top

/** What a session's name is made from, as the bounded scan finds it. The newest rename (null when none
 *  or cleared), the newest ai-title, the first real prompt (read only when there is no ai-title — it
 *  would never win), and the Remote Control session id whose claude.ai title outranks the last two. */
export interface SessionTitleParts {
  rename: string | null;
  aiTitle: string | null;
  prompt: string | null;
  bridge: string | null;
}

/**
 * A session's display title from a BOUNDED transcript scan, in `preferredSessionTitle`'s order. The
 * scan's parts are cached in an on-disk sidecar (`<store>/session-meta/<id>.json`, keyed to the
 * transcript's mtime:size — the usage-cursors pattern); the Remote Control title comes from its own
 * cache at every call, so a changed server title shows without a rescan.
 */
export function fastSessionTitle(transcriptPath: string, sessionId: string): string | null {
  const p = sessionTitleParts(transcriptPath, sessionId);
  if (!p) return null;
  return normalizeSessionTitle(
    preferredSessionTitle({ customTitle: p.rename, bridgeSessionId: p.bridge, title: p.aiTitle, firstUserPrompt: p.prompt }) ?? ''
  );
}

/** The scan's parts for one transcript, sidecar-cached; null when the transcript cannot be read. */
export function sessionTitleParts(transcriptPath: string, sessionId: string): SessionTitleParts | null {
  let stamp = '';
  try {
    const st = fs.statSync(transcriptPath);
    stamp = `${TITLE_SIDECAR_VERSION}|${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  // The id reaches here from a pinned setting or a --session flag, so it is not trusted to be a single
  // path segment: without this, `../../evil` would resolve OUTSIDE the store and then be written to.
  if (!isSafeSessionId(sessionId)) return scanTitleParts(transcriptPath);
  const sidecar = path.join(rootDir(), 'session-meta', `${sessionId}.json`);
  try {
    const hit = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as { stamp: string; parts?: SessionTitleParts };
    if (hit && hit.stamp === stamp && hit.parts) return hit.parts;
  } catch {
    /* absent or unreadable — scan */
  }
  const parts = scanTitleParts(transcriptPath);
  if (!parts) return null;
  try {
    fs.mkdirSync(path.dirname(sidecar), { recursive: true, mode: 0o700 });
    const tmp = `${sidecar}.${process.pid}.tmp`;
    // Merge: the counts half of this file is keyed to the LOG and must survive a transcript-only change.
    // A pre-v4 `title` is dropped: it is not what this build would show.
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    } catch {
      /* first write */
    }
    delete prev.title;
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, stamp, parts }), { mode: 0o600 });
    fs.renameSync(tmp, sidecar); // atomic — a concurrent reader sees old-or-new, never a torn file
  } catch {
    /* sidecar is best-effort */
  }
  return parts;
}

function scanTitleParts(transcriptPath: string): SessionTitleParts | null {
  let fd: number;
  let size = 0;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    size = fs.fstatSync(fd).size;
  } catch {
    return null;
  }
  const parts: SessionTitleParts = { rename: null, aiTitle: null, prompt: null, bridge: null };
  try {
    // Tail: the LATEST records win, so walk the last chunk's lines backwards. A rename outranks the
    // rest wherever it sits — Claude Code re-appends its metadata as custom-title THEN ai-title, so the
    // newest ai-title line usually comes after the newest rename. The newest custom-title decides alone:
    // an empty one is a cleared rename, and no older one counts.
    const tailLen = Math.min(size, TITLE_TAIL_SCAN);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const tailLines = tail.toString('utf8').split('\n');
    if (tailLen < size) tailLines.shift(); // first line may be partial
    let renameSeen = false;
    for (let i = tailLines.length - 1; i >= 0 && !(renameSeen && parts.aiTitle !== null && parts.bridge !== null); i--) {
      const t = tailLines[i];
      const rename = !renameSeen && t.indexOf('"custom-title"') !== -1;
      const ai = parts.aiTitle === null && t.indexOf('"ai-title"') !== -1;
      const bridge = parts.bridge === null && t.indexOf('"bridge-session"') !== -1;
      if (!rename && !ai && !bridge) continue;
      try {
        const o = JSON.parse(t);
        if (rename && o && o.type === 'custom-title') {
          renameSeen = true;
          if (typeof o.customTitle === 'string' && o.customTitle.trim()) {
            parts.rename = o.customTitle.trim();
            return parts; // nothing outranks it
          }
        } else if (ai && o && o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
          parts.aiTitle = o.aiTitle.trim();
        } else if (bridge && o && o.type === 'bridge-session' && typeof o.bridgeSessionId === 'string' && o.bridgeSessionId) {
          parts.bridge = o.bridgeSessionId;
        }
      } catch {
        /* partial line */
      }
    }
    if (parts.aiTitle !== null) return parts;
    // Head: the first REAL user prompt (same filters as transcriptInsights), kept only as long as a
    // row can show it.
    const headLen = Math.min(size, TITLE_HEAD_SCAN);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    for (const line of head.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o: any;
      try {
        o = JSON.parse(t);
      } catch {
        continue; // the last line may be cut by the byte budget
      }
      const clean = userPrompt(o, false);
      if (clean) {
        parts.prompt = normalizeSessionTitle(clean);
        break;
      }
    }
    return parts;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The pid of the AGENT process running a session — its `claude --resume <id>` / `codex … <id>` — so the
 * observatory can stop an agent it did NOT spawn.
 * The session id (a uuid) rides the agent's own command line, which is what makes this possible without
 * the agents recording anything. SAFE BY CONSTRUCTION: it returns a pid ONLY when exactly one process
 * matches — never guessing which of several to kill — and it excludes this dashboard's own surfaces (the
 * `oak` binary, the `tui`, the capture hook, an `-acp` adapter) and this very process, so a
 * kill can never turn on the observatory itself. Returns null on any ambiguity or if `ps` is unavailable.
 */
export function findAgentPid(sessionId: string): number | null {
  if (!isSafeSessionId(sessionId)) return null;
  let out = '';
  try {
    // Through the project's ONE launcher, like every other child process here (the spawn-hygiene gate).
    const r = spawnToolSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 3000 });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    out = r.stdout;
  } catch {
    return null; // no ps (or it failed) — we simply cannot find it, and we do not pretend to
  }
  const self = process.pid;
  const hits: number[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === self || !cmd.includes(sessionId)) continue;
    if (/observatory|capture\.(js|ts)\b|-acp\b|(?:^|\s|\/)tui(?:\s|$)/.test(cmd)) continue; // our own surfaces
    if (/(?:^|\s|\/)(claude|codex)(?:\s|$)/.test(cmd)) hits.push(pid); // the agent binary itself
  }
  return hits.length === 1 ? hits[0] : null; // exactly one, or refuse — a kill must never guess its target
}

export function newInsightFacts(): TranscriptInsights {
  return { todos: [], lastSummary: null, title: null, customTitle: null, bridgeSessionId: null, firstUserPrompt: null };
}

export function foldInsightFacts(facts: TranscriptInsights, o: any): void {
  if (o?.type === 'api-request-blob') return;
  // Claude Code writes an `ai-title` entry whenever it (re)titles the session — keep the latest.
  if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
    facts.title = o.aiTitle.trim();
    return;
  }
  // …and a `custom-title` entry when a person renames it (`/rename`, or claude.ai / the Claude app).
  // The newest one decides, and an empty one is how a rename is cleared.
  if (o.type === 'custom-title') {
    facts.customTitle = typeof o.customTitle === 'string' && o.customTitle.trim() ? o.customTitle.trim() : null;
    return;
  }
  // …and a `bridge-session` entry for the Remote Control session it runs as, whose claude.ai title
  // names it on the phone. The newest id is the live one.
  if (o.type === 'bridge-session') {
    if (typeof o.bridgeSessionId === 'string' && o.bridgeSessionId) facts.bridgeSessionId = o.bridgeSessionId;
    return;
  }
  const msg = o.message;
  // First REAL user prompt — the fallback session title for sessions without to-dos. String or
  // text-block content both occur; skip sidechains, tool_result-only turns, and the harness's
  // command/caveat wrappers (`<command-name>…`, `Caveat: …`) — those aren't what the user asked.
  // A compaction summary is likewise excluded: it's a synthesized user turn ("This session is being
  // continued from a previous conversation…"), so on a compacted session it would otherwise become
  // the session title and the session picker's label.
  if (facts.firstUserPrompt === null) {
    const clean = userPrompt(o, false);
    if (clean) facts.firstUserPrompt = clean;
  }
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
  // Skip inlined sidechain (subagent) turns: a subagent's report/TodoWrite is not "what Claude
  // said it just did" in the main conversation. (Current Claude Code stores sidechains in
  // separate files; this guards legacy transcripts.)
  if (o.isSidechain === true) return;
  for (const b of msg.content) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) facts.lastSummary = b.text.trim();
    if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
      const list = b.input.todos
        .filter((td: any) => td && typeof td.content === 'string')
        .map((td: any) => ({ content: String(td.content).trim(), status: String(td.status || '') }));
      if (list.length) facts.todos = list; // keep the LATEST non-empty list — it supersedes earlier ones
    }
  }
}

// --- context sources: what shaped this session ---

/** Where a piece of the session's context came from. */
export type ContextSourceKind = 'claude-md' | 'memory' | 'plan' | 'skill' | 'compact-summary';

export interface ContextSource {
  kind: ContextSourceKind;
  /** Display label, e.g. `CLAUDE.md (global)`, `skill: dataviz`, `plan: refactor-auth.md`. */
  label: string;
  /** The file to open when the row is clicked; null for sources that aren't a file. */
  path: string | null;
  /** How we know: the transcript recorded it, or the file simply exists where the harness loads it
   *  from. The distinction is the point — see `ContextSourcesReport.note`. */
  evidence: 'transcript' | 'file-present';
  detail: string | null;
  /** Transcript evidence only: how many times it appeared. */
  count: number;
  /** First transcript evidence (ms epoch); 0 for file-present rows. */
  ts: number;
}

export interface ContextSourcesReport {
  sources: ContextSource[];
  /** Rendered verbatim by both editors as the section's caveat. */
  note: string;
}

const CONTEXT_NOTE =
  'Detectable sources only — instruction files are injected into the system prompt, which transcripts never record.';

/**
 * What shaped this session: the skills it invoked, the plans it wrote, the memory it read, whether it
 * was resumed from a compaction, and which instruction files are present where the harness loads them.
 *
 * Two tiers of evidence, kept explicit rather than blurred: `transcript` rows are things the session
 * demonstrably did, `file-present` rows are files that exist in a location Claude Code auto-loads —
 * because current builds inject CLAUDE.md and memory system-prompt-side, leaving no transcript trace.
 * Claiming those as observed facts would be a lie; omitting them would hide the biggest influence on
 * the session. So they're listed, and labelled as what they are.
 */
export function contextSources(cwd: string, sessionId: string): ContextSourcesReport {
  const p = findTranscript(cwd, sessionId);
  // Memoize only the transcript fold: cachedByFiles declines to cache when any input path can't be
  // stat'd, so stamping the (often absent) instruction files here would disable caching entirely.
  const fromTranscript = p ? cachedByFiles('contextSources', [p], () => contextSourcesUncached(p)) : [];
  const seen = new Set(fromTranscript.map((s) => s.path).filter(Boolean) as string[]);
  const present: ContextSource[] = [];
  const addPresent = (file: string, kind: ContextSourceKind, label: string): void => {
    if (seen.has(file)) return; // transcript evidence already covers it — don't list it twice
    let ok = false;
    try {
      ok = fs.existsSync(file);
    } catch {
      ok = false;
    }
    if (!ok) return;
    seen.add(file);
    present.push({ kind, label, path: file, evidence: 'file-present', detail: 'auto-loaded — injection not recorded per-session', count: 0, ts: 0 });
  };
  addPresent(path.join(cwd, 'CLAUDE.md'), 'claude-md', 'CLAUDE.md (project)');
  addPresent(path.join(claudeConfigDir(), 'CLAUDE.md'), 'claude-md', 'CLAUDE.md (global)');
  addPresent(path.join(projectDir(cwd), 'memory', 'MEMORY.md'), 'memory', 'MEMORY.md (memory index)');

  const order: Record<ContextSourceKind, number> = { 'claude-md': 0, memory: 1, plan: 2, skill: 3, 'compact-summary': 4 };
  const sources = [...fromTranscript, ...present].sort(
    (a, b) => order[a.kind] - order[b.kind] || b.count - a.count || a.label.localeCompare(b.label)
  );
  return { sources, note: CONTEXT_NOTE };
}

/** The transcript half of `contextSources` — one pass, parsed locally (importing parseActions here
 *  would close a cycle: actions.ts already imports findTranscript from this module). */
function contextSourcesUncached(transcriptPath: string): ContextSource[] {
  let lines: string[];
  try {
    lines = readLines(transcriptPath);
  } catch {
    return [];
  }
  const plansDir = path.join(claudeConfigDir(), 'plans');
  const configDir = claudeConfigDir();
  const byKey = new Map<string, ContextSource>();
  // A file that was both read and written must say so — reporting only whichever came first would
  // describe a plan the session actively maintained as merely "read".
  const touch = new Map<string, { read: boolean; wrote: boolean }>();
  const add = (key: string, src: Omit<ContextSource, 'count'>): void => {
    const hit = byKey.get(key);
    if (hit) {
      hit.count++;
      if (src.ts && (!hit.ts || src.ts < hit.ts)) hit.ts = src.ts;
      return;
    }
    byKey.set(key, { ...src, count: 1 });
  };
  const addFile = (key: string, src: Omit<ContextSource, 'count' | 'detail'>, wrote: boolean): void => {
    const flags = touch.get(key) ?? { read: false, wrote: false };
    if (wrote) flags.wrote = true;
    else flags.read = true;
    touch.set(key, flags);
    add(key, { ...src, detail: null });
  };
  const under = (file: string, dir: string): boolean => {
    const rel = path.relative(dir, file);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.isSidechain === true) continue;
    const ts = toEpochMs(o.timestamp ?? o.ts) ?? 0;
    // Resumed from a compaction: everything before the boundary reaches this session as a summary.
    if (o.isCompactSummary === true) {
      add('compact-summary', {
        kind: 'compact-summary',
        label: 'resumed from a compaction summary',
        path: null,
        evidence: 'transcript',
        detail: 'earlier turns arrived as a summary, not their original text',
        ts,
      });
      continue;
    }
    if (o?.type === 'api-request-blob') continue;
    const msg = o.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      if (b.name === 'Skill') {
        const skill = typeof input.skill === 'string' ? input.skill : typeof input.command === 'string' ? input.command : '';
        if (skill) add('skill:' + skill, { kind: 'skill', label: `skill: ${skill}`, path: null, evidence: 'transcript', detail: 'instructions loaded into the session', ts });
        continue;
      }
      const file = typeof input.file_path === 'string' ? input.file_path : '';
      if (!file) continue;
      const wrote = b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'NotebookEdit';
      if (under(file, plansDir)) {
        addFile('plan:' + file, { kind: 'plan', label: `plan: ${path.basename(file)}`, path: file, evidence: 'transcript', ts }, wrote);
      } else if (under(file, configDir) && /\bmemory\b/.test(file)) {
        addFile('memory:' + file, { kind: 'memory', label: `memory: ${path.basename(file)}`, path: file, evidence: 'transcript', ts }, wrote);
      } else if (path.basename(file) === 'CLAUDE.md') {
        addFile('claude-md:' + file, { kind: 'claude-md', label: `CLAUDE.md (${path.basename(path.dirname(file))})`, path: file, evidence: 'transcript', ts }, wrote);
      }
    }
  }
  for (const [key, flags] of touch) {
    const s = byKey.get(key);
    if (s) s.detail = flags.read && flags.wrote ? 'read and written this session' : flags.wrote ? 'written this session' : 'read this session';
  }
  return [...byKey.values()];
}

/** Pull a "Next steps / TODO / Follow-ups" bullet section out of Claude's recap (last summary). */
function recapNextSteps(summary: string): string[] {
  // Linear: a SINGLE character class for the leading markdown noise (#, *, whitespace). The previous
  // `\s*\**\s*` had two whitespace matchers around an empty-matching `\**`, which backtracks O(n²) on
  // a line of many spaces — and `summary` is Claude-transcript text (a prompt-injected line could hang
  // the review UI). One quantifier over a char class can't backtrack catastrophically.
  const heading = /^[#*\s]*(next steps?|to-?dos?|follow[- ]?ups?|remaining|still to do)\b/i;
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)/;
  const out: string[] = [];
  let capturing = false;
  for (const raw of summary.split('\n')) {
    // Native trimEnd (linear) — `/\s+$/.replace` retries from every index and is O(n^2) when a long
    // whitespace run is followed by a non-space char (the same ReDoS class as the heading regex).
    const line = raw.trimEnd();
    if (heading.test(line.trim())) {
      capturing = true;
      continue;
    }
    if (!capturing) continue;
    const m = bullet.exec(line);
    if (m) {
      const t = m[1]
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // strip markdown links, keep text
        .trim();
      if (t.length >= 3 && t.length <= 140) out.push(t);
    } else if (line.trim() !== '') {
      capturing = false; // a non-blank, non-bullet line ends the section
    }
  }
  return out;
}

/** The still-open next steps Claude tracked this session: its latest to-do list plus any "Next steps"
 *  bullets from its recap (last summary) — all mined from the transcript, zero token. */
export function transcriptSuggestions(cwd: string, sessionId: string): string[] {
  const ins = transcriptInsights(cwd, sessionId);
  const out: string[] = ins.todos
    .filter((td) => td.status !== 'completed')
    .map((td) => (td.status === 'in_progress' ? `▸ ${td.content}` : td.content));
  const seen = new Set(out.map((s) => s.replace(/^▸\s*/, '').toLowerCase()));
  if (ins.lastSummary) {
    for (const step of recapNextSteps(ins.lastSummary)) {
      const key = step.toLowerCase();
      if (!seen.has(key)) {
        out.push(step);
        seen.add(key);
      }
    }
  }
  return out.slice(0, 6);
}

// --- heuristic summary + flags (zero-token) ---

function blobText(sessionId: string, sha: string | null): string | null {
  if (sha === null) return null;
  try {
    return storeBlobText(sessionId, sha);
  } catch {
    return null; // a GC'd blob is a missing input, not a crash in the Observations tree
  }
}

function addedLines(before: string, after: string): string[] {
  const tok = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) || [];
  const out: string[] = [];
  // Loop, never out.push(...p.value): a whole-file Write of a >65k-line file would blow the arg limit.
  for (const p of diffArrays(tok(before), tok(after))) {
    if (p.added) for (const v of p.value) out.push(v);
  }
  return out;
}

export interface Flag {
  level: 'info' | 'warn';
  message: string;
}

/** One-line change summary for an edit (created/deleted/±lines). */
export function summarize(sessionId: string, rec: EditRecord): string {
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  const base = path.basename(rec.file);
  if (before === null) return `created ${base}`;
  if (after === null) return `deleted ${base}`;
  const add = addedLines(before, after).length;
  const rem = addedLines(after, before).length; // "added" in reverse = removed
  return `edited ${base} (+${add} −${rem})`;
}

/** Cheap issue flags for an edit (scans added lines + the whole session's file set).
 *  Pass `log` (the session's readLog result) when calling per-edit in a loop to avoid re-reading
 *  the log file for every edit; omitted, it is read on demand (backward compatible). */
/** The BLOB-derived half of `flagsFor`, memoized on the two blob hashes.
 *
 *  Blobs are content-addressed and immutable, so this pair always yields the same answer. It is worth
 *  caching because the change map calls flagsFor once per edit on every build, and each call ran two
 *  full array diffs — at ~1,100 edits that was the single largest cost in the build. Deliberately only
 *  the blob half: the "no test file changed" flag below depends on the session's FILE SET, which grows
 *  as the session runs, so caching the whole result would freeze a flag that is supposed to flip.
 *
 *  What is cached is the VERDICTS, not the added text. Holding the text kept every distinct blob pair
 *  of a session resident — 803 MB on a 7.9k-record session, inside the editor's extension host — while
 *  both callers re-ran their regexes over it on every call, so even a fully warm memo cost 2.1 s per
 *  pass. The scans read nothing but the immutable pair, so they belong on this side of the cache. */
interface FlagInputs {
  /** `TODO|FIXME|XXX|HACK` — the flag's set. */
  todoFlag: boolean;
  /** `TODO|FIXME` only. A STRICT SUBSET of todoFlag's pattern, which is why these cannot share one
   *  boolean: an edit adding only `XXX` earns the flag, but must not earn a follow-up next step. */
  todoStep: boolean;
  debug: boolean;
  secret: boolean;
  removed: number;
}
const flagBlobMemo = new Map<string, FlagInputs | null>();
const FLAG_MEMO_CAP = 20000;

function flagInputs(sessionId: string, rec: EditRecord): FlagInputs | null {
  const key = `${rec.beforeBlob ?? ''}\u0000${rec.afterBlob ?? ''}`;
  const hit = flagBlobMemo.get(key);
  if (hit !== undefined) return hit;
  // …and the same answer from the LAST process. This was the single largest cost in a change-map
  // rebuild — `flagsFor` measured 71 % of a 4.9 s build on a 978-record session, nearly all of it
  // `addedLines` re-diffing blobs whose bytes had not moved since the previous poll. The memo above
  // is content-keyed and correct; it simply never survived exit, and the read commands are spawned.
  //
  // `null` is a REAL answer here (the file was deleted), so absence is `undefined`: a store that
  // conflated the two would re-diff every deletion forever.
  const pk = pairKeyOf(rec.beforeBlob, rec.afterBlob);
  const kept = contentGet<FlagInputs | null>(sessionId, 'flags', pk);
  if (kept !== undefined) {
    flagBlobMemo.set(key, kept);
    return kept;
  }
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  let value: FlagInputs | null = null; // null = the file was deleted; the caller answers that without diffing
  if (after !== null) {
    const addedText = addedLines(before ?? '', after).join('');
    value = {
      todoFlag: /\b(TODO|FIXME|XXX|HACK)\b/.test(addedText),
      todoStep: /\b(TODO|FIXME)\b/.test(addedText),
      // The trailing \b used to apply to every branch, which made two of them unreachable: `!` and `(`
      // are non-word characters, so a boundary after them needs a WORD character next — and Rust's
      // macro is always written `dbg!(…)`, while a no-argument `print()` ends the same way. `dbg!`
      // could never match in any form. Boundaries now sit only where a branch ends in a word
      // character, so `debuggerish` and `sprint(` are still correctly ignored.
      debug: /\b(?:console\.log|debugger)\b|\bprint\(|\bdbg!/.test(addedText),
      secret: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"`]/i.test(addedText),
      removed: before !== null ? addedLines(after, before).length : 0,
    };
  }
  if (flagBlobMemo.size >= FLAG_MEMO_CAP) flagBlobMemo.clear();
  flagBlobMemo.set(key, value);
  // Only an INTACT pair is published, the same guard `lineDelta` applies to the same hazard: a blob
  // that cannot be read yields '' from `blobText`, and filing that under the healthy sha would hand
  // every later process a "the whole file was removed" answer that nothing could ever heal, because
  // the key never changes.
  if (hasBlob(sessionId, rec.beforeBlob) && hasBlob(sessionId, rec.afterBlob)) {
    contentNote(sessionId, 'flags', pk, value);
  }
  return value;
}

/** The distinct test-pattern files in a log, derived ONCE per log array.
 *
 *  flagsFor's no-test-sibling check needs only this list, but it rebuilt the full file Set per record —
 *  and buildChangeMap calls flagsFor per edit, which made map builds quadratic: measured n^1.8, 1.58s
 *  warm at 12k edits with 83.6% of the build inside this function. Keyed on ARRAY IDENTITY because every
 *  hot caller (buildChangeMap, the CLI summary loop, the editors' cachedLog) passes one stable array per
 *  pass; a caller that passes fresh copies simply falls back to paying per call, never to a wrong answer. */
const testFilesMemo = new WeakMap<readonly EditRecord[], string[]>();
function testFilesOf(log: readonly EditRecord[]): string[] {
  let t = testFilesMemo.get(log);
  if (!t) {
    const seen = new Set<string>();
    for (const r of log) if (/\.(test|spec)\.|_test\.|test_/.test(r.file)) seen.add(r.file);
    t = [...seen];
    testFilesMemo.set(log, t);
  }
  return t;
}

export function flagsFor(sessionId: string, rec: EditRecord, log?: EditRecord[]): Flag[] {
  const flags: Flag[] = [];
  const blob = flagInputs(sessionId, rec);
  if (blob === null) return [{ level: 'warn', message: 'file deleted' }];
  if (blob.todoFlag) flags.push({ level: 'info', message: 'adds a TODO/FIXME' });
  if (blob.debug) flags.push({ level: 'warn', message: 'adds a debug statement' });
  if (blob.secret) flags.push({ level: 'warn', message: 'possible hard-coded secret' });
  const removed = blob.removed;
  if (removed > 30) flags.push({ level: 'warn', message: `large deletion (−${removed} lines)` });
  // source file with no test sibling touched anywhere in the session
  if (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(rec.file) && !/\.(test|spec)\.|_test\.|test_/.test(rec.file)) {
    const stem = path.basename(rec.file).replace(/\.[^.]+$/, '');
    const hasTest = testFilesOf(log ?? readLog(sessionId)).some((f) => f.includes(stem));
    if (!hasTest) flags.push({ level: 'info', message: 'no test file changed for this source' });
  }
  return flags;
}

/** How many GENERATED follow-ups accompany Claude's own to-dos. They are one template per source file,
 *  so an uncapped list buries the handful of steps a human actually wrote. */
const HEURISTIC_STEP_CAP = 8;

/** Session-level heuristic next-steps (zero-token). */
export function heuristicSuggestions(sessionId: string): string[] {
  // DISPLAY units minus the chains that cancel out, so this agrees with the panels it advises about
  // — telling someone to review 652 edits that no panel will show them is worse than saying nothing.
  const log = visibleEdits(sessionId);
  const out: string[] = [];
  const pending = log.filter((r) => r.status === 'pending').length;
  if (pending) out.push(`${pending} edit(s) still pending review — Accept or Revert them.`);
  const files = new Set(log.map((r) => r.file));
  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx|py|go|rs)$/.test(f) || /\.(test|spec)\.|_test\.|test_/.test(f)) continue;
    const stem = path.basename(f).replace(/\.[^.]+$/, '');
    const hasTest = [...files].some((g) => /\.(test|spec)\.|_test\.|test_/.test(g) && g.includes(stem));
    if (!hasTest) out.push(`Add or update tests for ${path.basename(f)}.`);
  }
  // Rides flagInputs' blob-pair memo — the previous version re-read both blobs and re-diffed every
  // record on every Observations render (O(edits) blob reads + line diffs for an already-memoized answer).
  const todoFiles = log.filter((r) => {
    const blob = flagInputs(sessionId, r);
    return blob !== null && blob.todoStep;
  });
  for (const r of todoFiles) out.push(`Follow up on the TODO/FIXME added in ${path.basename(r.file)}.`);
  if (out.length === 0) out.push('No obvious follow-ups from these heuristics.');
  return out;
}

// --- Observations view-model (0.8.0): timeline-style coalesced runs + per-edit reasoning + recap ---

/** One edit inside a coalesced run — its ±lines, review status, and Claude's reasoning for it. */
export interface ObservationEdit {
  id: number;
  ts: number;
  added: number;
  removed: number;
  status: EditStatus;
  reasoning: string | null; // Claude's own words for this edit (reasoningByEdit), null when uncorrelated
}

/** A run of adjacent same-file edits — the timeline's ×N unit, with a combined delta. */
export interface ObservationRun {
  file: string; // absolute path
  rel: string; // root-relative, forward slashes
  count: number; // edits in the run (the ×N)
  added: number; // combined + across the run
  removed: number; // combined − across the run
  status: EditStatus; // worst-unreviewed-wins rollup (pending > undone > kept)
  edits: ObservationEdit[]; // members in chronological order (expand for per-edit Keep/Undo)
}

export interface Observations {
  recap: string; // session recap — see `recapSource` for where it came from
  /** WHERE the recap came from, because the three sources mean different things and were previously
   *  swapped silently: 'analysis' is a line Claude generated on request, 'title' is Claude Code's own
   *  auto-title, 'summary' is the last thing the assistant happened to say — presenting that last one
   *  unlabelled reads as a considered recap when it is just the tail of the transcript. '' when none. */
  recapSource: 'analysis' | 'title' | 'summary' | '';
  runs: ObservationRun[]; // most-recent activity first
  nextSteps: string[]; // still-open to-dos + heuristic follow-ups
  context: ContextSourcesReport; // what shaped this session (skills, plans, memory, instruction files)
}

/** Worst-unreviewed-wins status for a run (mirrors changemap.fileStatus, inlined to avoid a cycle). */
function runStatus(edits: ObservationEdit[]): EditStatus {
  if (edits.some((e) => e.status === 'pending')) return 'pending';
  if (edits.some((e) => e.status === 'undone')) return 'undone';
  return 'kept';
}

/**
 * The Observations view-model (zero token): the session's edits as a chronological timeline where
 * adjacent same-file edits coalesce into ×N runs (combined delta), each edit carrying Claude's own
 * reasoning, under a session recap with the still-open next steps at the end. Runs are ordered by
 * most-recent activity. Assembled ONCE here so the CLI `observations --json` and both editors render
 * the same payload. `root` sets the display-relative paths (defaults to cwd).
 */
/**
 * The session recap and where it came from — ONE definition, shared by every surface.
 *
 * Core previously used `title ?? lastSummary` while the CLI and VS Code used
 * `cachedAnalysis('recap') ?? title`, so the same session read "Plan mode is active…" in one editor
 * and "No recap yet" in the other, and a generated recap survived a restart in only one of them.
 *
 * Takes `insights` already in hand rather than a cwd, so a caller that has them pays for the
 * transcript parse once — and so a surface wanting only the recap need not build the whole
 * Observations model, which also walks every edit for reasoning, flags and file memory (~0.8 s of a
 * 5.9 s `observe --json` on a 7.9k-record session).
 */
export function recapOf(
  sessionId: string,
  insights: TranscriptInsights
): { recap: string; recapSource: Observations['recapSource'] } {
  const analysis = cachedAnalysis(sessionId, 'recap')?.text?.trim() || '';
  return {
    recap: analysis || insights.title || insights.lastSummary || '',
    recapSource: analysis ? 'analysis' : insights.title ? 'title' : insights.lastSummary ? 'summary' : '',
  };
}

export function buildObservations(cwd: string, sessionId: string, opts: { root?: string } = {}): Observations {
  const root = opts.root ?? cwd;
  const relOf = (file: string): string => path.relative(root, file).split(path.sep).join('/');
  const log = readLog(sessionId);
  const reasoning = reasoningByEdit(cwd, sessionId);
  const insights = transcriptInsights(cwd, sessionId);
  const { recap, recapSource } = recapOf(sessionId, insights);
  // Claude's OWN open to-dos come first and are never what gets cut — they were being sliced to 6
  // while the generated half ran unbounded (58 rows, 55 of them one template, one per source file).
  // The heuristic half is capped, and says how many it dropped rather than trailing off silently.
  const fromTranscript = transcriptSuggestions(cwd, sessionId);
  const heuristic = heuristicSuggestions(sessionId).filter((h) => !fromTranscript.includes(h));
  const shown = heuristic.slice(0, HEURISTIC_STEP_CAP);
  const hidden = heuristic.length - shown.length;
  const nextSteps = [
    ...new Set([...fromTranscript, ...shown]),
    ...(hidden > 0 ? [`… ${hidden} more heuristic follow-up${hidden === 1 ? '' : 's'} not shown.`] : []),
  ];

  // Walk the log in chronological (capture) order, merging consecutive same-file edits into one run.
  const runs: ObservationRun[] = [];
  for (const rec of log) {
    const d = lineDelta(sessionId, rec);
    const edit: ObservationEdit = {
      id: rec.id,
      ts: rec.ts,
      added: d.added,
      removed: d.removed,
      status: rec.status,
      reasoning: reasoning.get(rec.id) ?? null,
    };
    const last = runs[runs.length - 1];
    if (last && last.file === rec.file) {
      last.edits.push(edit);
      last.count++;
      last.added += d.added;
      last.removed += d.removed;
    } else {
      runs.push({ file: rec.file, rel: relOf(rec.file), count: 1, added: d.added, removed: d.removed, status: rec.status, edits: [edit] });
    }
  }
  for (const r of runs) r.status = runStatus(r.edits);
  // Most-recent activity first: the run's newest member ts (falls back to id order for ts-less records).
  const runTs = (r: ObservationRun): number => maxOf(r.edits.map((e) => e.ts || e.id));
  runs.sort((a, b) => runTs(b) - runTs(a));
  return { recap, recapSource, runs, nextSteps, context: contextSources(cwd, sessionId) };
}

// --- usage readout (context fill + rough 5h/week plan usage) for the sidebar status line ---

export interface UsageLine {
  ctx: { tokens: number; size: number; pct: number } | null; // context-window fill
  fiveHourPct: number | null; // 5-hour plan usage
  weekPct: number | null; // 7-day plan usage
  fiveReset: number | null; // reset time for the 5h window, epoch ms
  weekReset: number | null; // reset time for the 7-day window, epoch ms
  /** The per-model weekly cap the account reports (the desktop app's "Fable" row) — share,
   *  reset (epoch ms) and the model's display name. Null until the account API supplied one. */
  fablePct: number | null;
  fableReset: number | null;
  fableLabel: string | null;
  /** ~tokens used / projected 100% budget / cache reads for the fable cap — union-measured and
   *  calibrated by the statusline scan, same canon as the 5h/weekly figures. */
  fableTokens: number | null;
  fableTotal: number | null;
  fableReads: number | null;
  fiveTokens: number | null; // ~estimated tokens used in the 5h window
  weekTokens: number | null; // ~estimated tokens used in the 7-day window
  statuslineCache: boolean; // whether statusline-last.json was found — false ⇒ claude-statusline
  //                           isn't installed/writing on this host, so the 5h/week bars can't fill
  cachedAtMs: number | null; // statusline-last.json mtime, epoch ms — only the terminal TUI runs the
  //                            statusLine, so panel-only sessions leave the cache (and 5h/week) stale
  /**
   * Whether this account's plan reports rolling-window limits at all.
   *
   * Claude Code sends `rate_limits.*` ONLY for Claude.ai subscription plans (Pro/Max/Team). An
   * Enterprise or API account never receives it, so the 5h and weekly bars can never fill — and an
   * empty bar reads as "you have used none of your quota" when the truth is "this plan has no rolling
   * quota". `null` means nothing has reported either way yet (no status-line cache).
   *
   * Note what this does NOT claim: it says the plan reports no rolling windows, not that the account is
   * Enterprise specifically. API-key use produces the same signal, and there is nothing in the payload
   * that distinguishes them — so the UI must not label it "Enterprise".
   */
  rollingLimits: boolean | null;
  /**
   * When this Claude account last answered that it has no five-hour limit (epoch ms), while that answer is the newest:
   * an account usage answer that carries the weekly window and no 5h window (`five_hour` null or missing, or its
   * utilization null), as a verified Ultra account gives, at least as new as the newest answer that carried a 5h window,
   * on this machine or another machine of the same account (its brief, or its readings in the local index). Only these
   * answers decide it, never a share. While it is set, every surface hides the 5h readout, and fiveHourPct, fiveReset and
   * the 5h token and dollar figures are null.
   * Null while the newest answer carried a 5h window, or none has said otherwise.
   */
  fiveNoneAt: number | null;
  /**
   * The rest of what the SHIPPED statusline draws (0.10.0). The dashboard renders that statusline
   * verbatim, so it needs the same inputs — and the statusline is the only thing that HAS them:
   * they arrive in Claude Code's per-turn payload, which reaches no other surface. It persists
   * them into its cache; this reads them back. All optional: absent means the cache predates the
   * field (or no statusline is installed), and the row degrades to that segment's placeholder
   * rather than inventing a value.
   */
  branch: string | null; // the git branch the session is working in
  thinking: boolean | null; // extended thinking on for this turn
  outputStyle: string | null; // '' / 'default' render as nothing
  tokensIn: number | null; // ↑ input
  tokensOut: number | null; // ↓ output
  tokensCacheRead: number | null; // ↺ cache reads
  /** The rendered session with every agent it started (`oak usage`'s sessionTreeTokens, as the status line last drew
   *  it); null when it started none. */
  tokensTree: { agents: number; input: number; output: number; cacheRead: number } | null;
  /** The projected 100% budgets behind the ~est/total suffixes. Computed inside the statusline's
   *  own self-calibrating scan and previously thrown away — persisted now so the dashboard can
   *  print the same denominator instead of a bare estimate. */
  fiveTotal: number | null;
  weekTotal: number | null;
  /**
   * MEASURED tokens for the rolling windows, summed across the machines this account works on.
   *
   * The database supplies the union; without it these retain the status line's measurements.
   */
  fiveMeasuredAll: number | null;
  weekMeasuredAll: number | null;
  usageScope: string;
  /** Measured token totals per rolling window, replacing the 5h/weekly bars on a plan that has no
   *  windows. Populated only when `rollingLimits === false`. Deliberately no percentage — there is no
   *  quota to divide by, and inventing a denominator would be the same wrong-by-plausible answer the
   *  empty bars already gave.
   *
   *  A LIST rather than fixed fields, because there are two sources with different windows: the status
   *  line measures 5h/7d (it anchors on the same clocks it draws), and this module's own fallback
   *  measures 24h/7d from `computeStats`. Whichever answers, the label travels with the number, so a
   *  row can never be drawn under a window it was not measured over. */
  localWindows: { label: string; tokens: number }[] | null;
  /** Schema version of the statusline cache that produced this line. Absent means a status line
   *  older than 0.10.0 is installed: it writes a cache without the token split, the branch, the
   *  think state, the plan totals or the spend ledger — and nothing else could tell you that. */
  statuslineVersion?: number | null;
  /** Provider of the unprefixed windows: the active or requested session's, defaulting to Claude.
   *  Both accounts are also available under the CLI's claude* and gpt* fields. */
  usageFrom?: 'claude' | 'codex';
  /** When other machines' usage arrived, for the account estimates' tooltip. */
  usageFreshness?: string;
  /** Credit left on a codex account that reports one, and whether the plan is uncapped. `unlimited`
   *  is a different fact from a zero balance and never renders as `$0`. */
  creditBalance?: number | null;
  creditsUnlimited?: boolean;
  /** A configured spend cap and how much of it has gone, where the account reports one (codex's
   *  `spend_control_reached`). Reported beside the rate windows, so it is its own fact. */
  spendLimit?: number | null;
  spendUsed?: number | null;
  /** Dollars spent, as CLAUDE CODE ITSELF reports them (`cost.total_cost_usd` on the statusline
   *  payload — its own client-side estimate, which it says may differ from the bill). We do not
   *  price tokens ourselves: a second estimate from a table we maintain would disagree with the
   *  number the reader already sees in their own client, and one of them would be wrong.
   *
   *  `session` is this session's spend; `five`/`week` sum the per-session figures the statusline
   *  has recorded inside each window. Null when nothing has reported a cost yet. */
  cost: { session: number | null; five: number | null; week: number | null } | null;
  /** Window spend and projected $ budgets from the statusline cache (2026-09-03): spend is a
   *  DELTA of cumulative ledger snapshots (a long session's total no longer lands in one window)
   *  and already account-wide; totals calibrate like the token budgets. Unlike `cost` above these
   *  are safe beside a quota bar, and every $ on any surface is an estimate, labeled so. */
  fiveCost: number | null;
  weekCost: number | null;
  fiveCostTotal: number | null;
  weekCostTotal: number | null;
  /** 30-day spend and its projected budget (four weekly cycles) — the one $ pair every
   *  surface shows; for enterprise the total is absent (no quota to project from). */
  monthCost: number | null;
  monthCostTotal: number | null;
  /** The month's spend as Claude Code reported it, session by session (the status line's ledger), on a plan with no
   *  rolling windows (pay-as-you-go API, Enterprise): a charge, where `monthCost` is an estimate. Null otherwise. */
  monthSpend: number | null;
  /** ~30-day token pair: account-wide used and the projected budget (four weekly cycles). */
  monthTokens: number | null;
  monthTokensTotal: number | null;
  /** End of the current bill cycle, epoch MILLISECONDS (null: rolling window). */
  monthReset: number | null;
  /** Cache READS inside the cycle (charged at a tenth of input; kept beside the quota unit,
   *  never inside it — the maxed-week ceilings validated the unit as Claude counts it). */
  monthReads: number | null;
  fiveReads: number | null;
  weekReads: number | null;
  /** The live plan-limit promotion the statusline knows about: label + date span, e.g.
   *  {label:"+50%", dates:"5/13-9/13"}. The budgets shown already INCLUDE its extra tokens. */
  promo: { label: string; dates: string } | null;
  /** The saved machine whose reading of the same Claude account a window shows (machine-usage.ts), by its
   *  herdr label; null when the window is this machine's own reading. */
  fiveMachine: string | null;
  weekMachine: string | null;
  fableMachine: string | null;
  monthMachine: string | null;
  /** What the readouts print to name them: '' when every window shown is this machine's own, the machine's
   *  label when every one came from it, else each machine with its windows (`build-box: 5h wk`). The Stats
   *  panels print this one: they show every window. */
  machineNote: string;
  /** machineNote over the windows the status bars show (wk, mo), which leave the per-model cap to their
   *  tooltips: a bar names no window it does not show, so a cap alone from a saved machine names none there. */
  machineBarNote: string;
  /** machineNote over the windows the status bars' tooltips show (wk, the per-model cap, mo): no bar shows the
   *  5-hour window, in its text or its tooltip. */
  machineTipNote: string;
  /** True when a saved machine's reading is shown although this machine has no Claude Code login to match its
   *  account against: it stands for the one account the saved machines name, and the tooltips say so. */
  machineUnmatched: boolean;
  /** When the oldest window shown from a saved machine was measured there (epoch ms, read by this machine's
   *  clock: that machine's stamp less its clock's difference from this one); null when every window shown is
   *  this machine's own. A machine that stops answering keeps its last reading, so this, not this machine's
   *  cache time, says how old a reading named by machineNote is. */
  machineAt: number | null;
  /** machineAt over the windows machineTipNote names. */
  machineTipAt: number | null;
  /**
   * What the saved machines of this account measured of their own turns, which the status line adds to this machine's
   * own when it calibrates the token and dollar estimates and sums the month (fillFromMachines). The shares are the
   * account's, so a machine that calibrated on its own transcripts alone credited every other machine's usage to its
   * own few turns. Per window: the tokens, cache reads and spend of each machine whose figures count (the same account,
   * this machine's window, fresh; the week with the per-model cap's family), that window (`reset`, epoch ms; the month
   * by its bill cycle, `start` to `reset`), and which machines it holds (`hosts`, their sorted host hashes: the status
   * line starts its smoothing over when they number more than any calibration held). `machines` names them for the
   * readouts (`build-box, lab-box`). Null when none counts.
   */
  machineMeasured: {
    five: { tok: number; reads: number; cost: number; reset: number; hosts: string } | null;
    week: { tok: number; reads: number; cost: number; fable: number; fableReads: number; reset: number; hosts: string } | null;
    month: { tok: number; reads: number; cost: number; start: number; reset: number; hosts: string } | null;
    machines: string;
  } | null;
}

/** Statusline cache older than this ⇒ the UI should surface its age and the terminal remedy. */
export const USAGE_STALE_MS = 5 * 60 * 1000;

/** Bytes read from the transcript's END when estimating context fill from its latest usage line —
 *  generous enough to clear a large trailing tool_result, yet a tiny slice of a 20-56MB file. */
const USAGE_TAIL_BYTES = 2 * 1024 * 1024;

/** Claude Code sends `resets_at` as either epoch seconds (a number) or an ISO string → epoch ms. */
/** Claude Code 2.1.263 stopped sending resets_at (the percentages still arrive; current versions send
 *  it again, and this stays the fallback for the versions that do not), so a cached or remote reset
 *  anchor can be PAST — roll it forward by whole periods at read time, like the
 *  statusline script does: exact for the periodic weekly windows. A 5-hour window starts only with
 *  the first message after the last one ended, so a passed 5-hour anchor is rolled only for a share
 *  measured after it with no reset of its own (usageReading). Writers keep the original anchor, so
 *  the estimate never compounds. */
function rollFwd(ms: number | null, periodMs: number): number | null {
  if (ms === null) return null;
  const now = Date.now();
  if (ms > now) return ms;
  return ms + (Math.floor((now - ms) / periodMs) + 1) * periodMs;
}

/** Roll a MONTHLY anchor (a bill-cycle boundary) forward to its next future occurrence — by whole
 *  CALENDAR months, so a "resets on the 14th" cycle lands on the 14th rather than drifting by a fixed
 *  30-day period. The month reset is the only usage window not covered by the fixed-period `rollFwd`
 *  (the period is not constant), and before this it was left un-rolled: a stale cache kept a past
 *  anchor, which the editors' `resets in` math renders as "now" instead of the next boundary. */
function rollFwdMonth(ms: number | null): number | null {
  if (ms === null) return null;
  const now = Date.now();
  if (ms > now) return ms;
  const d = new Date(ms);
  for (let guard = 0; d.getTime() <= now && guard < 1200; guard++) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000; // >1e12 already ms
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

/** When this machine's shares were measured (epoch seconds; absent for a cache written before the stamps),
 *  and whether the bill cycle its month figures were measured in has ended. */
interface UsageStamps {
  five?: number;
  week?: number;
  fable?: number;
  monthEnded: boolean;
  /** What this machine's status line last measured of its own turns, with when and in which windows (the brief sends
   *  it for the saved machines to add up); absent from a cache that records no such measurement. */
  own?: Omit<import('./machine-usage').MachineUsageOwn, 'host'>;
  /** When this machine's account read last answered with no 5h window, and last answered with one (five_none_at and
   *  five_seen_at in the cache), which noFiveHourLimitIfNewest weighs. */
  fiveNone?: number;
  fiveSeen?: number;
}

/** The status line's usage row (its last line): context fill + 5h/week plan usage. Source of truth is
 *  the exact per-turn values claude-statusline persisted to `statusline-last.json`; if that's absent we
 *  fall back to a context estimate from the session transcript's latest usage (5h/week stay null). Where this
 *  machine has no current share of the Claude account, a saved machine's reading of it fills in
 *  (fillFromMachines). */
export function usageLine(cwd: string, sessionId: string): UsageLine {
  const { out, at } = usageReading(cwd, sessionId);
  if (out.usageFrom !== 'codex') {
    fillFromMachines(out, at);
    fillAccountTotals(out);
  }
  return out;
}

/** Account estimates use the same measured union and sample on every machine. A database without
 *  any usage yet leaves the existing status line reading in place while its first build runs. */
function fillAccountTotals(out: UsageLine): void {
  if (process.env.OAK_INDEX === 'off') return;
  const ix = require('./index/api') as typeof import('./index/api');
  const database = ix.openIndexReadOnly();
  if (!database.ok) return;
  let t: ReturnType<typeof ix.indexedUsageTotals>;
  let previousWeek: number | null = null;
  {
    try {
      out.usageFreshness = ix.usageFreshness(database.db);
      if (!database.db.prepare("SELECT 1 FROM usage_messages WHERE agent = 'claude' LIMIT 1").get()) return;
      const account = ix.countedAccount(database.db).account;
      for (const kind of ['week'] as const) {
        const row = database.db.prepare(`SELECT pct, reset_ms, label FROM usage_readings
          WHERE agent = 'claude' AND kind = ? AND (? IS NULL OR account = ?) AND measured_ms <= ?
          AND reset_ms > ? AND pct IS NOT NULL ORDER BY measured_ms DESC, machine_id DESC LIMIT 1`)
          .get(kind, account, account, Date.now(), Date.now()) as { pct: number; reset_ms: number; label: string } | undefined;
        if (!row) continue;
        out.weekPct = row.pct; out.weekReset = row.reset_ms;
      }
      if (!out.weekPct) {
        const last = database.db.prepare(`SELECT pct, reset_ms, measured_ms FROM usage_readings WHERE agent = 'claude' AND kind = 'week'
          AND (? IS NULL OR account = ?) AND pct > 0 AND reset_ms IS NOT NULL AND measured_ms BETWEEN ? AND ?
          ORDER BY measured_ms DESC, machine_id DESC LIMIT 1`).get(account, account, Date.now() - 35 * 86400_000, Date.now()) as
          { pct: number; reset_ms: number; measured_ms: number } | undefined;
        if (last) {
          const old = ix.windowTotals(database.db, 'claude', { start: last.reset_ms - 7 * 86400_000,
            end: Math.min(last.measured_ms + 1, last.reset_ms), reset: last.reset_ms }, account, ix.selfIds(database.db));
          if (old.tokens > 0) previousWeek = Math.round(old.tokens * 100 / last.pct);
        }
      }
    } finally { database.close(); }
  }
  t = ix.indexedUsageTotals({ fiveReset: out.fiveReset, weekReset: out.weekReset });
  if (!t) return;
  const budget = (tokens: number, pct: number | null): number | null => pct !== null && pct > 0 && tokens > 0 ? Math.round(tokens * 100 / pct) : null;
  out.fiveTokens = out.fiveMeasuredAll = t.five.tokens; out.fiveReads = t.five.cacheRead; out.fiveCost = t.five.spend;
  out.weekTokens = out.weekMeasuredAll = t.week.tokens; out.weekReads = t.week.cacheRead; out.weekCost = t.week.spend;
  out.cost = { session: out.cost?.session ?? null, five: t.five.spend || null, week: t.week.spend || null };
  out.fiveTotal = budget(t.five.tokens, out.fiveHourPct);
  out.weekTotal = budget(t.week.tokens, out.weekPct) ?? previousWeek;
  out.fiveCostTotal = out.fiveHourPct && t.five.spend ? t.five.spend * 100 / out.fiveHourPct : null;
  out.weekCostTotal = out.weekPct && t.week.spend ? t.week.spend * 100 / out.weekPct : null;
  out.fableTokens = t.week.topTier.tokens; out.fableReads = t.week.topTier.cacheRead;
  out.fableTotal = budget(t.week.topTier.tokens, out.fablePct);
  const weeks = (t.month.end - t.month.start) / (7 * 86400_000);
  out.monthTokens = t.month.tokens; out.monthReads = t.month.cacheRead; out.monthCost = t.month.cost;
  out.monthSpend = t.month.spend; out.monthReset = t.month.end;
  out.monthTokensTotal = out.weekTotal === null ? null : Math.round(out.weekTotal * weeks);
  out.monthCostTotal = out.monthTokensTotal && t.month.tokens > 0 ? t.month.cost * out.monthTokensTotal / t.month.tokens : null;
  out.machineMeasured = ix.othersMeasured(t);
  out.usageScope = 'account database';
  if (out.fiveNoneAt !== null) {
    out.fiveTokens = out.fiveMeasuredAll = out.fiveReads = out.fiveTotal = out.fiveCost = out.fiveCostTotal = null;
    out.cost.five = null;
  }
}

/** usageLine from this machine's own readings alone, with when its shares were measured. `judged` false keeps a
 *  share measured before its window (machineUsageBrief: the machine reading it judges that by its own clock). */
function usageReading(cwd: string, sessionId: string, judged = true): { out: UsageLine; at: UsageStamps } {
  const out: UsageLine = {
    ctx: null,
    usageFrom: 'claude',
    fiveHourPct: null,
    weekPct: null,
    fiveReset: null,
    weekReset: null,
    fablePct: null,
    fableReset: null,
    fableLabel: null,
    fableTokens: null,
    fableTotal: null,
    fableReads: null,
    fiveTokens: null,
    weekTokens: null,
    statuslineCache: false,
    cachedAtMs: null,
    rollingLimits: null,
    fiveNoneAt: null,
    localWindows: null,
    cost: null,
    fiveCost: null,
    weekCost: null,
    fiveCostTotal: null,
    weekCostTotal: null,
    monthCost: null,
    monthCostTotal: null,
    monthSpend: null,
    monthTokens: null,
    monthTokensTotal: null,
    monthReset: null,
    monthReads: null,
    fiveReads: null,
    weekReads: null,
    promo: null,
    branch: null,
    thinking: null,
    outputStyle: null,
    tokensIn: null,
    tokensOut: null,
    tokensCacheRead: null,
    tokensTree: null,
    fiveTotal: null,
    weekTotal: null,
    fiveMeasuredAll: null,
    weekMeasuredAll: null,
    usageScope: 'here',
    fiveMachine: null,
    weekMachine: null,
    fableMachine: null,
    monthMachine: null,
    machineNote: '',
    machineBarNote: '',
    machineTipNote: '',
    machineUnmatched: false,
    machineAt: null,
    machineTipAt: null,
    machineMeasured: null,
  };
  // Choose the runtime before loading any account cache; fallback after filling Claude fields
  // cannot undo cross-provider contamination. Tokens and context use this session's exact source.
  const cx = require('./codex') as typeof import('./codex');
  const rawCodex = cx.findCodexRollout(sessionId);
  const isCodex = !!rawCodex || !!cx.readCodexAgentMeta(sessionId);
  if (isCodex) {
    out.usageFrom = 'codex';
    if (!rawCodex) return { out, at: { monthEnded: false } };
    const cu = cx.codexUsageLive(rawCodex);
    out.cachedAtMs = cu.snapshotMs;
    out.fiveHourPct = cu.fivePct; out.weekPct = cu.weekPct;
    out.fiveReset = cu.fiveReset; out.weekReset = cu.weekReset;
    out.rollingLimits = cu.fivePct !== null || cu.weekPct !== null;
    out.creditBalance = cu.creditBalance; out.creditsUnlimited = cu.creditsUnlimited;
    out.spendLimit = cu.spendLimit;
    out.spendUsed = cu.spendLimit !== null && cu.spendRemainingPct !== null ? cu.spendLimit * (1-cu.spendRemainingPct/100) : null;
    if (cu.ctxTokens !== null && cu.ctxSize) out.ctx = { tokens: cu.ctxTokens, size: cu.ctxSize, pct: Math.min(100,100*cu.ctxTokens/cu.ctxSize) };
    if (cu.tokens) { out.tokensIn = cu.tokens.input; out.tokensOut = cu.tokens.output; out.tokensCacheRead = cu.tokens.cacheRead; }
    const g = cx.gptUsagePanel(sessionId);
    if (g) {
      out.usageFreshness = g.usageFreshness;
      out.weekTokens = g.weekTok;
      out.monthTokens = g.monthTok; out.monthReads = g.monthReads;
      out.monthCost = g.monthCost; out.monthReset = g.monthReset;
      const provider = (require('./codex-events') as typeof import('./codex-events')).codexUsageState(rawCodex)?.provider;
      if (!provider || provider === 'openai') {
        out.fiveHourPct = g.fivePct; out.fiveReset = g.fiveReset;
        out.weekPct = g.weekPct; out.weekReset = g.weekReset;
        out.rollingLimits = g.fivePct !== null || g.weekPct !== null;
      }
    }
    return { out, at: { monthEnded: false } };
  }
  const fin = (v: unknown): v is number => typeof v === 'number' && isFinite(v); // reject NaN from a corrupt cache
  const cachePath = path.join(claudeConfigDir(), 'statusline-last.json');
  // When each share was measured (epoch seconds): the status line and the account pull stamp five_at,
  // week_at and fable_at when a fresh share arrives. A cache written before fable_at existed dates its
  // Fable share by its last pull, which is never earlier than the share.
  let measuredAt: { five?: number; week?: number; fable?: number } = {};
  let own: UsageStamps['own'];
  // When the account last answered with no 5h window, and with one (epoch seconds; noFiveHourLimitIfNewest).
  let answers: Pick<UsageStamps, 'fiveNone' | 'fiveSeen'> = {};
  try {
    const last = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    measuredAt = { five: fin(last.five_at) ? last.five_at : undefined, week: fin(last.week_at) ? last.week_at : undefined, fable: fin(last.fable_at) ? last.fable_at : fin(last.api_ts) ? last.api_ts : undefined };
    answers = { ...(fin(last.five_none_at) ? { fiveNone: last.five_none_at } : {}), ...(fin(last.five_seen_at) ? { fiveSeen: last.five_seen_at } : {}) };
    out.statuslineCache = true; // the cache exists and parsed — statusline is installed & writing
    out.cachedAtMs = fs.statSync(cachePath).mtimeMs;
    if (fin(last.ctx_pct)) {
      const size = fin(last.ctx_size) && last.ctx_size > 0 ? last.ctx_size : 200000;
      // ctx_used can be a stuck 0 (newer Claude Code builds stopped sending the context_window
      // token totals, so the statusline persists 0 while the percentage is real) — trust it only
      // when positive, otherwise derive tokens from the percentage so the bar never reads "0/1M".
      const tokens =
        fin(last.ctx_used) && last.ctx_used > 0 ? last.ctx_used : Math.round((last.ctx_pct / 100) * size);
      out.ctx = { tokens, size, pct: Math.min(100, last.ctx_pct) };
    }
    if (fin(last.five_pct)) out.fiveHourPct = Math.min(100, last.five_pct);
    if (fin(last.week_pct)) out.weekPct = Math.min(100, last.week_pct);
    // Raw anchors are rolled forward once below.
    out.fiveReset = toEpochMs(last.five_reset);
    out.weekReset = toEpochMs(last.week_reset);
    if (fin(last.fable_pct) || last.fable_pct === 0) out.fablePct = Math.min(100, Number(last.fable_pct));
    out.fableReset = toEpochMs(last.fable_reset);
    if (typeof last.fable_label === 'string' && last.fable_label) out.fableLabel = last.fable_label;
    if (fin(last.fable_tok)) out.fableTokens = last.fable_tok;
    if (fin(last.fable_tok_total)) out.fableTotal = last.fable_tok_total;
    if (fin(last.fable_reads)) out.fableReads = last.fable_reads;
    // The rest of the shipped statusline's inputs (0.10.0). Each is guarded on its own: a cache
    // written by an older statusline simply lacks the key, and its segment renders as the
    // statusline's own placeholder rather than as a zero pretending to be a measurement.
    // Which schema wrote this cache. Absent = an older statusline is installed and never wrote the
    // fields below it; the surfaces say so rather than drawing blanks.
    out.statuslineVersion = typeof last.v === 'number' ? last.v : null;
    if (typeof last.branch === 'string' && last.branch) out.branch = last.branch;
    if (typeof last.thinking === 'boolean') out.thinking = last.thinking;
    if (typeof last.output_style === 'string' && last.output_style) out.outputStyle = last.output_style;
    if (fin(last.tok_in) && last.tok_in > 0) out.tokensIn = last.tok_in;
    if (fin(last.tok_out) && last.tok_out > 0) out.tokensOut = last.tok_out;
    if (fin(last.tok_cache) && last.tok_cache > 0) out.tokensCacheRead = last.tok_cache;
    const tree = last.tok_tree;
    if (tree && typeof tree === 'object' && fin(tree.agents) && tree.agents > 0)
      out.tokensTree = { agents: tree.agents, input: fin(tree.input) ? tree.input : 0, output: fin(tree.output) ? tree.output : 0, cacheRead: fin(tree.cacheRead) ? tree.cacheRead : 0 };
    if (fin(last.five_total) && last.five_total > 0) out.fiveTotal = last.five_total;

    // but only from a v3 statusline, and only when the reading was taken INSIDE the current
    // window. Older statuslines counted every transcript line of every synced-in transcript
    // (2.5-3x high, measured, and double-counting the moment machines are added up), and a
    // measurement from before the window opened counts tokens that have already rolled out.
    const measV3 = typeof last.v === 'number' && last.v >= 3;
    // What the status line's last scan measured of this machine's own turns, with when it ran and the windows it counted
    // them in (seconds in the cache): what the saved machines add to their own (machineUsageBrief). Only from a scan that
    // recorded both: figures that cannot be placed in a window are added to none.
    const sec = (v: unknown): number | null => (fin(v) && v > 0 ? v * 1000 : null);
    const ownAt = measV3 ? sec(last.meas_at) : null;
    if (ownAt !== null) {
      const n = (v: unknown): number | null => (fin(v) && v >= 0 ? v : null);
      const win = (tok: unknown, reads: unknown, cost: unknown, reset: number | null): { tok: number; reads: number | null; cost: number | null; reset: number } | null => {
        const t = n(tok);
        return t !== null && reset !== null ? { tok: t, reads: n(reads), cost: n(cost), reset } : null;
      };
      const week = win(last.week_meas, last.week_reads_own, last.week_cost_own, sec(last.week_meas_reset));
      const month = win(last.month_meas, last.month_reads_own, last.month_cost_own, sec(last.month_meas_end));
      const start = sec(last.month_meas_start);
      own = {
        at: ownAt,
        five: win(last.five_meas, last.five_reads_own, last.five_cost_own, sec(last.five_meas_reset)),
        week: week && { ...week, fable: n(last.fable_meas), fableReads: n(last.fable_reads_own) },
        month: month && start !== null && start < month.reset ? { ...month, start } : null,
      };
    }
    const takenInside = (resetMs: number | null, windowMs: number): boolean =>
      out.cachedAtMs !== null &&
      out.cachedAtMs >= (resetMs !== null ? rollFwd(resetMs, windowMs)! - windowMs : Date.now() - windowMs);
    if (fin(last.five_cost) && last.five_cost > 0) out.fiveCost = last.five_cost;
    if (fin(last.week_cost) && last.week_cost > 0) out.weekCost = last.week_cost;
    if (fin(last.five_cost_total) && last.five_cost_total > 0) out.fiveCostTotal = last.five_cost_total;
    if (fin(last.week_cost_total) && last.week_cost_total > 0) out.weekCostTotal = last.week_cost_total;
    if (fin(last.month_cost) && last.month_cost > 0) out.monthCost = last.month_cost;
    if (fin(last.month_cost_total) && last.month_cost_total > 0) out.monthCostTotal = last.month_cost_total;
    // A month the statusline MEASURED at zero (a v3 cache that wrote the cycle's budget and reset beside
    // it: a new bill cycle with no turns yet) is 0, which reads 0%; read as "no data", it hid the month.
    // A cache that never measured the month leaves it unknown.
    const monthMeasured = measV3 && fin(last.month_tok_total) && last.month_tok_total > 0 && fin(last.month_reset) && last.month_reset > 0;
    if (fin(last.month_tok) && (last.month_tok > 0 || (last.month_tok === 0 && monthMeasured))) out.monthTokens = last.month_tok;
    if (fin(last.month_tok_total) && last.month_tok_total > 0) out.monthTokensTotal = last.month_tok_total;
    if (fin(last.month_reset) && last.month_reset > 0) out.monthReset = toEpochMs(last.month_reset);
    if (fin(last.month_reads) && last.month_reads > 0) out.monthReads = last.month_reads;
    if (fin(last.five_reads) && last.five_reads > 0) out.fiveReads = last.five_reads;
    if (fin(last.week_reads) && last.week_reads > 0) out.weekReads = last.week_reads;
    if (typeof last.promo === 'string' && last.promo) {
      const [plabel, ...prest] = String(last.promo).split(':');
      if (plabel) out.promo = { label: plabel, dates: prest.join(' ') };
    }
    if (measV3 && fin(last.five_meas) && last.five_meas > 0 && takenInside(out.fiveReset, 5 * 3600_000))
      out.fiveMeasuredAll = last.five_meas;
    if (measV3 && fin(last.week_meas) && last.week_meas > 0 && takenInside(out.weekReset, 7 * 86400_000))
      out.weekMeasuredAll = last.week_meas;
    if (fin(last.week_total) && last.week_total > 0) out.weekTotal = last.week_total;
    if (fin(last.five_tok) && last.five_tok > 0) out.fiveTokens = last.five_tok;
    if (fin(last.week_tok) && last.week_tok > 0) out.weekTokens = last.week_tok;
    // The status line has written a reading. If it carried no rolling percentages, this plan does not
    // have them — the statusline keeps the last known-good across a turn that omits rate_limits, so a
    // subscription account cannot flicker into this branch BETWEEN turns. It can land here transiently
    // on the very first turn of a brand-new cache (rate_limits arrive only with the first API response);
    // the next percentaged write heals it, and the merge semantics make that state permanent.
    out.rollingLimits = out.fiveHourPct !== null || out.weekPct !== null;
    // Prefer the status line's own measurement. It scans the same transcripts, but anchors its windows
    // on the reset clocks it draws — so taking its numbers is what keeps this panel and that line from
    // reporting two different totals for one account, which is the whole point of reading its cache.
    if (out.rollingLimits === false) {
      // v3-only, like the aggregate above: an older statusline's totals are the 2.5-3x figures,
      // and leaving them out here lets the deduped computeStats fallback below answer instead.
      const w: { label: string; tokens: number }[] = [];
      if (measV3 && fin(last.five_meas) && last.five_meas > 0) w.push({ label: '5h', tokens: last.five_meas });
      if (measV3 && fin(last.week_meas) && last.week_meas > 0) w.push({ label: 'wk', tokens: last.week_meas }); // "wk", as the status line itself prints it
      if (w.length) out.localWindows = w;
      if (fin(last.month_spend) && last.month_spend > 0) out.monthSpend = last.month_spend;
      // SPEND, as the client that computes it reported it. `cost.total_cost_usd` is Claude Code's
      // own per-session estimate; the statusline records each session's latest figure with the
      // moment it arrived, so a window total is a sum of REPORTED numbers rather than a second
      // estimate of our own that would disagree with the one the reader already sees.
      const sess = fin(last.cost_usd) && last.cost_usd > 0 ? last.cost_usd : null;
      const ledger = last.costs && typeof last.costs === 'object' ? (last.costs as Record<string, { usd?: unknown; at?: unknown }>) : null;
      if (sess !== null || ledger) {
        const nowS = Date.now() / 1000;
        const sum = (sinceS: number): number | null => {
          if (!ledger) return null;
          let t = 0;
          let any = false;
          for (const e of Object.values(ledger)) {
            const at = Number(e?.at) || 0;
            const usd = Number(e?.usd) || 0;
            if (at >= sinceS && usd > 0) {
              t += usd;
              any = true;
            }
          }
          return any ? t : null;
        };
        out.cost = { session: sess, five: sum(nowS - 5 * 3600), week: sum(nowS - 7 * 86400) };
      }
    }
  } catch {
    /* no statusline cache yet (or corrupt JSON) — fall back to a transcript estimate below */
  }
  // A panel-only session never runs the statusLine, so the cache (and its ctx) can be arbitrarily
  // old while the transcript is live — prefer the transcript's ctx whenever it is newer. When a
  // terminal session is open the statusline rewrites the cache every render, so its exact values
  // still win. 5h/week always come from the cache: they have no other source.
  // Only on a plan with no rolling windows, so a Pro/Max account pays nothing for a readout it will
  // Fallback only: an older status line writes no measured totals, and this panel should still say
  // something true rather than nothing. ~51ms cold / ~7ms warm over this machine's transcripts.
  if (out.rollingLimits === false && out.localWindows === null) {
    try {
      const w = require('./stats').computeStats(undefined, undefined, /* claudeOnly */ true) as import('./stats').StatsResult;
      out.localWindows = [
        { label: '24h', tokens: w.windows.day.tokens },
        { label: 'wk', tokens: w.windows.week.tokens },
      ];

    } catch {
      /* a stats scan that fails is not a reason to lose the rest of the usage line */
    }
  }
  const transcript = findTranscript(cwd, sessionId);
  let transcriptNewer = false;
  if (transcript && out.cachedAtMs !== null) {
    try {
      transcriptNewer = fs.statSync(transcript).mtimeMs > out.cachedAtMs;
    } catch {
      /* transcript vanished between find and stat */
    }
  }
  if (!out.ctx || transcriptNewer) {
    if (transcript) {
      try {
        // Only the LATEST usage-bearing line matters, and it sits at the very end of the transcript
        // (the final assistant turn). Read a BOUNDED tail from EOF — never the whole 20-56MB file —
        // then scan it backwards for the first usage hit. If the last usage line happens to sit beyond
        // the tail window we keep the prior ctx (same as finding no usage line), rather than read it all.
        let latest: any = null;
        let tail = '';
        const fd = fs.openSync(transcript, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          const start = Math.max(0, size - USAGE_TAIL_BYTES);
          const buf = Buffer.alloc(size - start);
          const n = fs.readSync(fd, buf, 0, buf.length, start);
          tail = buf.toString('utf8', 0, n);
          if (start > 0) tail = tail.slice(tail.indexOf('\n') + 1); // started mid-file: drop the partial line
        } finally {
          fs.closeSync(fd);
        }
        const lines = tail.split('\n');
        for (let i = lines.length - 1; i >= 0 && !latest; i--) {
          const t = lines[i].trim();
          if (!t || !t.includes('"usage"')) continue;
          let o: any;
          try {
            o = JSON.parse(t);
          } catch {
            continue;
          }
          if (o?.type === 'api-request-blob' || o?.isSidechain === true) continue; // a subagent's usage is not the main-chain context
          const u = o?.message?.usage;
          if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) latest = u;
        }
        if (latest) {
          const tokens =
            (latest.input_tokens || 0) +
            (latest.cache_read_input_tokens || 0) +
            (latest.cache_creation_input_tokens || 0);
          const size = tokens > 200000 ? 1000000 : 200000; // 1M-context sessions auto-detected
          out.ctx = { tokens, size, pct: Math.min(100, (tokens / size) * 100) };
        }
      } catch {
        /* unreadable transcript */
      }
    }
  }
  // AN ENDED 5-HOUR WINDOW IS OVER. A 5-hour window starts only with the first message after the last one ended, so a
  // passed 5-hour reset rolled forward by whole periods named a window that may not exist: after a night with no use,
  // a countdown of 48 minutes for a window that had begun a minute before and ran five hours. Once the reset has passed
  // and nothing reports a newer window, the share is 0 and there is no reset. Its token estimate, measured tokens and
  // cache reads were the ended window's, so they go too. One share still rolls the anchor forward: a share above 0
  // measured after it, whose own reset is unknown (from a Claude Code that sends no resets_at, as 2.1.263 did). So does
  // a cache without the stamp (an older status line), as before. A brief is judged by the machine that reads it, by its
  // own clock, so a share measured before a reset that passed less than USAGE_STALE_MS ago is left to it: by a clock
  // running fast here, its window may still run. The weekly windows are a fixed schedule and always roll.
  const now = Date.now();
  if (out.fiveReset !== null && out.fiveReset <= now) {
    const at5 = measuredAt.five;
    if (at5 === undefined || (out.fiveHourPct !== null && out.fiveHourPct > 0
      && (at5 * 1000 > out.fiveReset || (!judged && now - out.fiveReset < USAGE_STALE_MS)))) {
      out.fiveReset = rollFwd(out.fiveReset, 5 * 3600_000);
    } else {
      out.fiveReset = null;
      if (out.rollingLimits) { out.fiveHourPct = 0; out.fiveTokens = null; out.fiveMeasuredAll = null; out.fiveReads = null; }
    }
  }
  out.weekReset = rollFwd(out.weekReset, 7 * 86400_000);
  out.fableReset = rollFwd(out.fableReset, 7 * 86400_000);
  const monthEnded = out.monthReset !== null && out.monthReset <= Date.now(); // before it rolls to the next cycle's end
  out.monthReset = rollFwdMonth(out.monthReset);
  // A share measured before its window began is the last window's: after a reset, until a session or the
  // account pull brings a fresh one, the window has no share rather than last week's (a cache kept the old
  // week's share for hours after the reset). Its token estimate restates the share, so it goes too. A cache
  // without the stamp (an older status line) keeps its share.
  const before = (at: number | undefined, reset: number | null, periodMs: number): boolean =>
    judged && at !== undefined && reset !== null && at * 1000 < reset - periodMs;
  if (before(measuredAt.five, out.fiveReset, 5 * 3600_000)) { out.fiveHourPct = null; out.fiveTokens = null; }
  if (before(measuredAt.week, out.weekReset, 7 * 86400_000)) { out.weekPct = null; out.weekTokens = null; }
  if (before(measuredAt.fable, out.fableReset, 7 * 86400_000)) { out.fablePct = null; out.fableTokens = null; }
  return { out, at: { ...measuredAt, monthEnded, ...(own ? { own } : {}), ...answers } };
}

/**
 * NO FIVE-HOUR LIMIT (UsageLine.fiveNoneAt). Only the account's usage answers decide it, never a share: a session's
 * share can come from before the answer, and a response can carry 5h figures whatever the account. The newest answer
 * with no 5h window (five_none_at, which OAK's account pull and the status line's own pull record) is weighed against the
 * newest that carried one (five_seen_at): this machine's, and each other machine's of the same account in `machines`
 * (its brief's fiveNoneAt and fiveSeenAt, which for a machine the local index reads are its newest `limit` readings,
 * index/usage.ts machineReadingEntries; read less that machine's clock difference, and set aside when more than
 * USAGE_STALE_MS ahead of this clock, as its shares are). While the newest no-limit answer is at least as new, the 5h
 * readout is hidden, whatever share there is, and this returns true.
 */
function noFiveHourLimitIfNewest(out: UsageLine, at: UsageStamps, machines: import('./machine-usage').MachineUsageEntry[], account: () => string | null, now: number): boolean {
  let none = at.fiveNone !== undefined ? at.fiveNone * 1000 : null;
  let seen = at.fiveSeen !== undefined ? at.fiveSeen * 1000 : null;
  const newer = (t: number | null, than: number | null): boolean => t !== null && (than === null || t > than);
  for (const e of machines) {
    const read = (v: number | null | undefined): number | null => (typeof v === 'number' && v - e.skewMs <= now + USAGE_STALE_MS ? v - e.skewMs : null);
    const n = read(e.brief.fiveNoneAt), s = read(e.brief.fiveSeenAt);
    // This machine's account last, as pick() reads it: only for an answer that would move either time.
    if (!newer(n, none) && !newer(s, seen)) continue;
    if (e.brief.account === null || e.brief.account !== account()) continue;
    if (newer(n, none)) none = n;
    if (newer(s, seen)) seen = s;
  }
  if (none === null || newer(seen, none)) return false;
  out.fiveNoneAt = none;
  out.fiveHourPct = null; out.fiveReset = null; out.fiveTokens = null; out.fiveTotal = null; out.fiveMeasuredAll = null; out.fiveReads = null;
  out.fiveCost = null; out.fiveCostTotal = null;
  return true;
}

/**
 * Fill this machine's Claude readout from saved machines' readings of the same account (machine-usage.ts), or,
 * where this machine has no Claude Code login to match, of the one account the saved machines name.
 *
 * The 5-hour, weekly and per-model weekly shares are the account's, so each window takes the freshest share
 * measured inside its current window: this machine's own while it is live (measured within USAGE_STALE_MS),
 * otherwise the newest of its own and every same-account machine's. A live share here is never displaced by a
 * fresher one of the same window, so two machines that both measure do not trade the readout back and forth
 * between them. Not the largest share: a share can drop within a window (a plan upgrade, an early reset, a
 * promotion that raises the limit), and the larger one would then stand for the rest of the window. The latest
 * week comes first, though: a share of a later weekly window replaces this machine's, live or not (two weekly resets
 * name the same week when they are less than half a week apart), and this machine's 5-hour window once it has ended
 * (usageReading) is no window, below any running one. The 5-hour windows are not ranked by their resets, which can be
 * estimates (usageReading). Another machine's share needs the time it was measured and
 * its window's reset, without which it cannot be shown to belong to this window. That time is its machine's
 * clock's, so it is read less that clock's difference from this one (MachineUsageEntry.skewMs): a clock minutes
 * fast hid a fresh share as undated, and one minutes off either way placed a share measured near a reset in the
 * wrong window. Its token estimate and budget come with it, since they restate it.
 *
 * The month a machine shows is its status line's sum of each machine's own turns in the bill cycle
 * (measuredFromMachines), and its budget is projected from that machine's weekly figures, so two machines' months
 * are never added here: it is taken whole from the machine whose weekly share is shown.
 */
function fillFromMachines(out: UsageLine, at: UsageStamps): void {
  const mu = require('./machine-usage') as typeof import('./machine-usage');
  const cached = mu.readMachineUsage().machines;
  const ix = require('./index/api') as typeof import('./index/api');
  // The common case, decided by one stat and one listing: no saved machine's reading cached, and no other machine's
  // record log here. Then the switch.
  const shared = (cached.length > 0 || ix.recordHosts().some((h) => h !== mu.machineHostTag())) && mu.machineUsageEnabled();
  // The other machines' readings and usage: from the local index, which holds every machine's records (oak sync's, and
  // the usage pulls'), and, where this process has no index (an editor whose Node has no node:sqlite), from the saved
  // machines' readings their cache file keeps. A machine the index knows is read from the index.
  const view = shared ? ix.indexedUsageView({ fiveReset: out.fiveReset, weekReset: out.weekReset }) : null;
  // A machine the last refresh no longer lists (taken off herdr's list, or turned off) lends no reading, as before the
  // index; one whose record log oak sync keeps here does.
  const listed = new Set(shared ? [...cached.map((e) => e.host).filter((h): h is string => !!h), ...ix.recordHosts()] : []);
  const fromIndex = view ? view.entries.filter((e) => e.host && listed.has(e.host)) : [];
  const machines = shared ? [...fromIndex, ...cached.filter((e) => !fromIndex.some((x) => (e.host ? x.host === e.host : x.label === e.label)))] : [];
  // This machine's account, read only when another machine's share could stand in (the file can be megabytes).
  // With no Claude Code login here there is nothing to match, so the readings stand for the one account the saved
  // machines name, and for none when they name two: which of two accounts is this person's cannot be told here,
  // and taking each window from the freshest machine would mix the two accounts in one readout. A `.claude.json`
  // that could not be read is not a missing login: this machine may well be signed in to another account.
  let me: string | null | undefined;
  let unmatched = false;
  const account = (): string | null => {
    if (me !== undefined) return me;
    me = mu.claudeAccountTag();
    if (me === null && mu.claudeSignedOut()) {
      const named = new Set(machines.map((e) => e.brief.account).filter((a): a is string => a !== null));
      if (named.size === 1) {
        me = [...named][0];
        unmatched = true;
      }
    }
    return me;
  };
  const now = Date.now();
  // Whether the account has a five-hour limit comes first, from its answers here and on the other machines (their briefs,
  // and the readings the index holds of the machines it reads), and with none of them too: while it has none, no
  // machine's 5h share stands in.
  const noLimit = noFiveHourLimitIfNewest(out, at, machines, account, now);
  if (!shared) return;
  // Its reset, which that machine rolled forward by its own clock, as the next one here: never more than a period
  // away, since the window it ends began at most a period ago. A clock running fast there rolled it a period early.
  const next = (ms: number, periodMs: number): number => {
    const r = rollFwd(ms, periodMs)!;
    return r - (Math.ceil((r - now) / periodMs) - 1) * periodMs;
  };
  type Pick = { e: import('./machine-usage').MachineUsageEntry; w: import('./machine-usage').MachineUsageWindow; at: number; r: number };
  // `r` ends a later window than `than`: half a period or more after it. Only the weekly windows are ranked so: they run
  // on a fixed schedule, so a weekly reset rolled forward is exact, where a 5-hour reset rolled forward for a share with no
  // reset of its own is an estimate (usageReading), up to a period off: ranked as a later window, a saved machine's
  // estimate replaced this machine's live share. A share with no reset names no window to rank.
  const later = (r: number | null, than: number | null, periodMs: number): boolean =>
    periodMs === 7 * 86400_000 && r !== null && than !== null && r - than >= periodMs / 2;
  const pick = (key: 'five' | 'week' | 'fable', periodMs: number, pct: number | null, stamp: number | undefined, reset: number | null): Pick | null => {
    // This machine's share, dated by its stamp, or by the cache's own time for a cache written before the stamps, in
    // the window its reset names. Its 5-hour window once it has ended (usageReading: a share of 0 with no reset) is no
    // window, below any running one. Any other share with no reset (a status line that has never known one) is of a
    // window this machine cannot place: it is ranked by when it was measured, as before the windows were ranked.
    const here = pct === null || (key === 'five' && pct === 0 && reset === null) ? null : stamp !== undefined ? stamp * 1000 : out.cachedAtMs;
    const live = here !== null && now - here <= USAGE_STALE_MS;
    let best: Pick | null = null;
    for (const e of machines) {
      const w = e.brief[key];
      if (!w || w.at === null || w.reset === null) continue; // undated: no time it was measured, or no window to place it in
      const at = w.at - (e.firstSkew?.[key] ?? e.skewMs); // by this machine's clock, as the refresh that first brought it read it
      if (at > now + USAGE_STALE_MS) continue; // still ahead: its clock has moved since it answered
      const r = next(w.reset, periodMs);
      if (at < r - periodMs) continue; // measured before its current window
      // The latest week, then the freshest share in it: over this machine's (live, only a later week), then the rest.
      if (here !== null && !later(r, reset, periodMs) && (later(reset, r, periodMs) || live || at <= here)) continue;
      if (best && !later(r, best.r, periodMs) && (later(best.r, r, periodMs) || at <= best.at)) continue;
      if (e.brief.account === null || e.brief.account !== account()) continue; // another account's, or one it cannot name, or one of two
      best = { e, w, at, r };
    }
    return best;
  };
  // What the saved machines measured of their own turns, for this machine's own windows: the status line scans those,
  // whatever a saved machine's share below replaces in the readout.
  // What the other machines measured: the index's totals where it holds their usage (records, each message once, and the
  // own figures of a machine that answers only with its readings), else what their briefs say they measured of their own
  // turns (no index here, or no other machine's usage in it). While the account has no five-hour limit there is no
  // 5-hour window to measure in: the index placed its totals by the reset this machine held before the answers were weighed.
  const measured = view?.totals ? ix.othersMeasured(view.totals) : measuredFromMachines(machines, account, at.own?.month ?? null, out.fiveReset, out.weekReset, now);
  out.machineMeasured = noLimit && measured?.five ? (measured.week || measured.month ? { ...measured, five: null } : null) : measured;
  const five = noLimit ? null : pick('five', 5 * 3600_000, out.fiveHourPct, at.five, out.fiveReset);
  if (five) {
    out.fiveHourPct = Math.min(100, five.w.pct); out.fiveReset = next(five.w.reset!, 5 * 3600_000);
    out.fiveTokens = five.w.est ? five.w.est.tok : five.w.tok; out.fiveTotal = five.w.total; out.fiveMachine = five.e.label;
  }
  const week = pick('week', 7 * 86400_000, out.weekPct, at.week, out.weekReset);
  if (week) {
    out.weekPct = Math.min(100, week.w.pct); out.weekReset = next(week.w.reset!, 7 * 86400_000);
    out.weekTokens = week.w.est ? week.w.est.tok : week.w.tok; out.weekTotal = week.w.total; out.weekMachine = week.e.label;
    const m = week.e.brief.month;
    // A month whose bill cycle has ended since that machine measured it is the last cycle's: its answer may be
    // days old (a machine that does not answer keeps its last one), so the cycle is checked here as well as there.
    if (m && !(m.reset !== null && m.reset <= now)) {
      out.monthTokens = m.tok; out.monthTokensTotal = m.total; out.monthReset = rollFwdMonth(m.reset);
      out.monthReads = m.reads; out.monthCost = m.cost; out.monthCostTotal = m.costTotal; out.monthMachine = week.e.label;
    }
  }
  const fable = pick('fable', 7 * 86400_000, out.fablePct, at.fable, out.fableReset);
  if (fable) {
    out.fablePct = Math.min(100, fable.w.pct); out.fableReset = next(fable.w.reset!, 7 * 86400_000);
    out.fableLabel = fable.w.label ?? out.fableLabel; out.fableTokens = fable.w.est ? fable.w.est.tok : fable.w.tok; out.fableTotal = fable.w.total;
    out.fableMachine = fable.e.label;
  }
  if (five || week || fable) out.rollingLimits = true; // the account reports rolling windows
  // Each window shown, with the machine it came from (null: this one's) and whether the status bars show it. No bar
  // shows the 5-hour window, nor its tooltip; the Stats panels do.
  const shown: [string, string | null, boolean][] = [];
  if (out.fiveHourPct !== null) shown.push(['5h', out.fiveMachine, false]);
  if (out.weekPct !== null) shown.push(['wk', out.weekMachine, true]);
  if (out.fablePct !== null) shown.push([(out.fableLabel || 'fable').toLowerCase(), out.fableMachine, false]);
  if (out.monthTokens !== null) shown.push(['mo', out.monthMachine, true]);
  if (!shown.some((s) => s[1] !== null)) return;
  out.machineUnmatched = unmatched;
  out.machineAt = Math.min(...[five, week, fable].filter((p): p is Pick => p !== null).map((p) => p.at));
  const tipAt = [week, fable].filter((p): p is Pick => p !== null).map((p) => p.at);
  out.machineTipAt = tipAt.length ? Math.min(...tipAt) : null;
  const note = (windows: typeof shown): string => {
    const from = windows.filter((s) => s[1] !== null);
    const by = new Map<string, string[]>();
    for (const [label, machine] of from) by.set(machine!, [...(by.get(machine!) ?? []), label]);
    return by.size === 1 && from.length === windows.length ? from[0][1]!
      : [...by].map(([machine, labels]) => `${machine}: ${labels.join(' ')}`).join('; ');
  };
  out.machineNote = note(shown);
  out.machineBarNote = note(shown.filter((s) => s[2]));
  out.machineTipNote = note(shown.filter((s) => s[0] !== '5h'));
}

/**
 * THE ACCOUNT ACROSS ITS MACHINES (2026-10-27): what the saved machines of this account measured of their own turns,
 * per window, which the status line adds to this machine's own when it calibrates the token and dollar estimates
 * against the account's shares and sums the month (UsageLine.machineMeasured). A machine's figures count for a window
 * when they are of the same account (`account`, fillFromMachines' rule), of the window this machine is in (the 5-hour and
 * weekly by a reset under half a period from this machine's, the month by the same bill cycle, start and end), and fresh:
 * measured inside that window, by this machine's clock (the stamp less that machine's clock difference) and not more
 * than USAGE_STALE_MS ahead of it. Each machine counts once, by its host hash, from the freshest of its entries, and
 * this machine never (saved as one of its own). An older OAK's brief carries no figures and adds nothing (`oak doctor`
 * says so). Each machine's figures are the turns that ran under its own home directory, so the sum counts a synced
 * transcript once, apart from turns that ran outside any home directory or under a home path two machines share, which
 * each machine holding them counts (the status line's own()). `cycle` is the bill cycle this machine measures (epoch
 * ms). The local index adds the figures of the machines that answer it only with their readings the same way
 * (index/usage.ts usageTotals).
 */
export function measuredFromMachines(
  machines: import('./machine-usage').MachineUsageEntry[],
  account: () => string | null,
  cycle: { start: number; reset: number } | null,
  fiveReset: number | null,
  weekReset: number | null,
  now: number
): UsageLine['machineMeasured'] {
  const mu = require('./machine-usage') as typeof import('./machine-usage');
  const counted = new Set<string>([mu.machineHostTag()]);
  const used = new Set<import('./machine-usage').MachineUsageEntry>();
  const five = { tok: 0, reads: 0, cost: 0, hosts: [] as string[] };
  const week = { tok: 0, reads: 0, cost: 0, fable: 0, fableReads: 0, hosts: [] as string[] };
  const month = { tok: 0, reads: 0, cost: 0, hosts: [] as string[] };
  // The freshest entry first, so a machine saved under two targets counts by its latest figures.
  for (const e of [...machines].sort((a, b) => (b.brief.own?.at ?? 0) - (a.brief.own?.at ?? 0))) {
    const o = e.brief.own;
    if (!o || counted.has(o.host) || e.brief.account === null) continue;
    const at = o.at - e.skewMs;
    if (at > now + USAGE_STALE_MS) continue;
    const inside = (w: { reset: number } | null, reset: number | null, periodMs: number): boolean =>
      !!w && reset !== null && Math.abs(w.reset - reset) < periodMs / 2 && at >= reset - periodMs;
    const f = inside(o.five, fiveReset, 5 * 3600_000) ? o.five : null;
    const w = inside(o.week, weekReset, 7 * 86400_000) ? o.week : null;
    const m = o.month && cycle && o.month.start === cycle.start && o.month.reset === cycle.reset && at >= cycle.start ? o.month : null;
    // This machine's account last, as pick() reads it: it is read from a file that can be megabytes, on every call of a
    // process the status line starts each render, and figures that count for none of these windows (an idle machine's,
    // from before them) need no read of it.
    if ((!f && !w && !m) || e.brief.account !== account()) continue;
    counted.add(o.host);
    used.add(e);
    if (f) { five.tok += f.tok; five.reads += f.reads ?? 0; five.cost += f.cost ?? 0; five.hosts.push(o.host); }
    if (w) {
      week.tok += w.tok; week.reads += w.reads ?? 0; week.cost += w.cost ?? 0;
      week.fable += w.fable ?? 0; week.fableReads += w.fableReads ?? 0; week.hosts.push(o.host);
    }
    if (m) { month.tok += m.tok; month.reads += m.reads ?? 0; month.cost += m.cost ?? 0; month.hosts.push(o.host); }
  }
  if (!used.size) return null;
  const hosts = (h: string[]): string => [...h].sort().join(',');
  return {
    five: five.hosts.length && fiveReset !== null ? { ...five, reset: fiveReset, hosts: hosts(five.hosts) } : null,
    week: week.hosts.length && weekReset !== null ? { ...week, reset: weekReset, hosts: hosts(week.hosts) } : null,
    month: month.hosts.length && cycle ? { ...month, start: cycle.start, reset: cycle.reset, hosts: hosts(month.hosts) } : null,
    machines: machines.filter((e) => used.has(e)).map((e) => e.label).join(', '),
  };
}

/** What `oak usage --brief --json` prints for another machine to read (machine-usage.ts): this machine's own
 *  Claude shares with when each was measured, and its month while the cycle it was measured in runs. Never a
 *  reading taken from a saved machine, so no reading is relayed onward. Whether a share was measured inside its
 *  window is left to the machine that reads it, which dates the stamps by its own clock: judged by a clock
 *  minutes slow here, a share measured just after a reset was dropped as the last window's. A 5-hour window that
 *  has ended here goes as a share of 0 with no reset (usageReading), which that machine places in no window. It also
 *  sends what this machine measured of its own turns (`own`, null when its status line has measured none), which that
 *  machine adds to its own only for the windows they share, and when this machine's account read last answered with no
 *  5h window and with one, which that machine weighs with its own (noFiveHourLimitIfNewest); while this machine's own
 *  answers say the account has no five-hour limit, it sends no 5h share. */
export function machineUsageBrief(cwd: string): import('./machine-usage').MachineUsageBrief {
  const { out: u, at } = usageReading(cwd, '', false);
  const ms = (s: number | undefined): number | null => (s !== undefined ? Math.round(s * 1000) : null);
  const mu = require('./machine-usage') as typeof import('./machine-usage');
  noFiveHourLimitIfNewest(u, at, [], () => null, Date.now());
  // A window's `tok` is the tokens the status line counted in it on this machine, where it counted them inside the
  // window; the share times the estimated allowance moves whenever that estimate does, so it is never the headline.
  // It goes as `est`, beside the allowance it was derived from, and stands in `tok` only where nothing was counted
  // (`measured` false), for the readers before 0.11.0.
  const win = (meas: number | null, est: number | null, total: number | null) =>
    ({ tok: meas ?? est, total, measured: meas !== null, est: { tok: est, total } });
  return {
    brief: 1,
    account: mu.claudeAccountTag(),
    at: Date.now(),
    five: u.fiveHourPct !== null ? { pct: u.fiveHourPct, reset: u.fiveReset, at: ms(at.five), ...win(u.fiveMeasuredAll, u.fiveTokens, u.fiveTotal) } : null,
    fiveNoneAt: ms(at.fiveNone),
    fiveSeenAt: ms(at.fiveSeen),
    week: u.weekPct !== null ? { pct: u.weekPct, reset: u.weekReset, at: ms(at.week), ...win(u.weekMeasuredAll, u.weekTokens, u.weekTotal) } : null,
    fable: u.fablePct !== null ? { pct: u.fablePct, reset: u.fableReset, at: ms(at.fable), ...win(null, u.fableTokens, u.fableTotal), label: u.fableLabel } : null,
    month: u.monthTokens !== null && !at.monthEnded
      ? { tok: u.monthTokens, total: u.monthTokensTotal, reset: u.monthReset, reads: u.monthReads, cost: u.monthCost, costTotal: u.monthCostTotal } : null,
    own: at.own ? { host: mu.machineHostTag(), ...at.own } : null,
  };
}

/** A dollar figure as the Claude Code status line writes it (its `money`): $1.2k, $123, $12, $1.2. That line
 *  formats with C's printf, which truncates for %d and rounds an exact half to the even digit, where toFixed
 *  rounds it up; this does as printf does, so a bar and the status line never show two figures for one sum. */
export function usdText(v: number): string {
  const fix = (x: number, d: number): string => {
    const s = x.toFixed(d);
    const tie = /^50*$/.test(x.toFixed(100).split('.')[1].slice(d));
    return tie && /[13579]$/.test(s) ? (Number(s) - 10 ** -d).toFixed(d) : s;
  };
  if (v >= 1000) return `$${fix(v / 1000, 1)}k`;
  if (v >= 100) return `$${Math.trunc(v)}`;
  return `$${fix(v, v >= 10 ? 0 : 1)}`;
}

/** The month's dollar figure the status bars show after the month's reset, as the status line shows it: the
 *  charge Claude Code reported on a plan with no rolling windows, else the list-price estimate with `~`.
 *  Null with no reading, so a bar leaves the figure out rather than show a stale or zero one. */
export function monthUsd(u: { monthCost?: number | null; monthSpend?: number | null; rollingLimits?: boolean | null }): string | null {
  if (u.rollingLimits === false && u.monthSpend != null && u.monthSpend > 0) return usdText(u.monthSpend);
  return u.monthCost != null && u.monthCost > 0 ? `~${usdText(u.monthCost)}` : null;
}

/** One usage window for the compact per-provider readout: a share (null when not measured), its reset
 *  instant, and — for a token-only window like gpt's month — a raw token count instead of a share.
 *  A month carries its dollar figure (`monthUsd`) as well. */
export interface BriefWindow {
  pct: number | null;
  resetMs: number | null;
  tok?: number | null;
  usd?: string | null;
}
export interface UsageBrief {
  /** `machine` names the saved machine(s) these windows came from, as UsageLine.machineBarNote; '' for this one. */
  claude: { five: BriefWindow; week: BriefWindow; month: BriefWindow; machine: string; usageFreshness?: string };
  /** Absent when this machine has no codex/gpt usage at all. */
  gpt: { five: BriefWindow; week: BriefWindow; month: BriefWindow; measuredMachines?: string; usageSource?: string; usageFreshness?: string } | null;
}

/** BOTH providers' 5h / week / month windows at once, for the terminal app's status readout (which
 *  shows claude and gpt side by side, unlike `usageLine`, which reports only the active session's
 *  provider). Claude comes from the account/statusline path (`usageLine` with no session takes it,
 *  since provider detection is per-session), gpt from `gptUsagePanel`. Neither provider exposes a
 *  monthly QUOTA percentage, so BOTH months are a synthesized share (tokens / a projected budget):
 *  claude's from the statusline's bill-cycle estimate, gpt's from `gptUsagePanel` back-deriving the
 *  same way (weekly fill → monthly budget). `month.tok` still carries the raw count for the label. */
export function usageBrief(cwd: string): UsageBrief {
  const u = usageLine(cwd, '');
  const claudeMonthPct = u.monthTokens != null && u.monthTokensTotal != null && u.monthTokensTotal > 0
    ? Math.min(100, (u.monthTokens / u.monthTokensTotal) * 100) : null;
  const g = (require('./codex') as typeof import('./codex')).gptUsagePanel();
  // gpt's month % is estimated the SAME way as claude's — tokens over a projected budget
  // (gptUsagePanel back-derives monthTokTotal from the weekly fill, mirroring the statusline). This
  // line is claude's, with the gpt fields: when the budget is known, the month reads as a percentage.
  const gptMonthPct = g && g.monthTok != null && g.monthTokTotal != null && g.monthTokTotal > 0
    ? Math.min(100, (g.monthTok / g.monthTokTotal) * 100) : null;
  return {
    claude: {
      five: { pct: u.fiveHourPct, resetMs: u.fiveReset },
      week: { pct: u.weekPct, resetMs: u.weekReset },
      month: { pct: claudeMonthPct, resetMs: u.monthReset ?? null, tok: u.monthTokens ?? null, usd: monthUsd(u) },
      machine: u.machineBarNote, usageFreshness: u.usageFreshness,
    },
    gpt: g ? {
      five: { pct: g.fivePct, resetMs: g.fiveReset },
      week: { pct: g.weekPct, resetMs: g.weekReset },
      month: { pct: gptMonthPct, resetMs: g.monthReset ?? null, tok: g.monthTok, usd: monthUsd(g) },
      measuredMachines: g.measuredMachines, usageSource: g.usageSource, usageFreshness: g.usageFreshness,
    } : null,
  };
}
