/**
 * Subagent tracking (zero-token): the nested action timeline of every subagent Claude spawned this
 * session. Current Claude Code writes each subagent's turns to its OWN transcript at
 * ~/.claude/projects/<proj>/<session>/subagents/agent-<agentId>.jsonl (self-describing: `agentId`,
 * `sessionId` = parent, `isSidechain: true`) — so a subagent's work is invisible in the main-chain
 * transcript the rest of the observatory parses.
 *
 * This reads those files with the SAME action parser the main session uses (parseTranscriptActions),
 * and correlates each one back to the `Agent`/`Task` tool_use that spawned it via the spawn's
 * tool_result `toolUseResult` block — which conveniently also carries per-subagent metrics
 * (totalDurationMs / totalTokens / totalToolUseCount) straight from Claude Code. No model calls.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findTranscript } from './observe';
import { sidecarMemo } from './store';
import { parseTranscriptActions, ActionRecord, ActionSummary, summarizeActions, agentPhaseDetail, Phase, PhaseConfidence, attributeEditIds, EditAttributionAuthor } from './actions';
import { sessionTaskRows, taskIdForSubject, SessionTaskRow } from './tasks';
import { friendlyModel } from './format';
import { derivedInventory } from './derived';
import { transcriptFacts } from './derived-transcript';

/** Spawn + result metadata for one subagent, mined from the parent transcript's Agent/Task result. */
interface SubagentMeta {
  agentType?: string; // e.g. "code-reviewer" (toolUseResult.agentType, else the spawn's subagent_type)
  description?: string; // the spawn's short description (input.description)
  status?: string; // "completed" | … (toolUseResult.status)
  durationMs?: number; // toolUseResult.totalDurationMs — wall-clock the subagent ran
  tokens?: number; // toolUseResult.totalTokens
  toolUseCount?: number; // toolUseResult.totalToolUseCount
  ts: number; // spawn time (the Agent/Task tool_use's ms epoch)
  toolUseId?: string; // the spawning Agent/Task tool_use id
}

export interface SubagentInfo {
  /** The subagent's own id (from the agent-<id>.jsonl filename / its records). */
  agentId: string;
  agentType?: string;
  description?: string;
  status?: string;
  /** Spawn time (ms epoch), or the first subagent line when the spawn couldn't be correlated. */
  ts: number;
  durationMs?: number;
  tokens?: number;
  toolUseCount?: number;
  toolUseId?: string;
  /** Nesting depth in the agent tree, from the agent-<id>.meta.json sidecar (undefined when no sidecar). */
  spawnDepth?: number;
  /** The subagent's own typed action stream (reads, edits, bash, web, nested spawns…). */
  actions: ActionRecord[];
  /** How many of those actions edited a file. */
  edits: number;
  /** Headline counts for the subagent's actions (total / byCategory / errors). */
  summary: ActionSummary;
  /** Live phase from a bounded tail read of the subagent's OWN transcript — so an async_launched
   *  subagent (null status, never transitions) still shows what it's doing now, not a stuck status. */
  phase: Phase;
  /** 'high' = structural; 'heuristic' = staleness-inferred (awaiting-permission/idle/done have no
   *  transcript marker). Renderers dim/qualify heuristic phases instead of asserting them as truth. */
  phaseConfidence: PhaseConfidence;
  /** True while the subagent is still active (phase working/awaiting-*), false once idle/done/errored. */
  running: boolean;
  /** Launched in the background: its end is its completion notice in the parent session (workerPhase). */
  background?: boolean;
  /** The subagent's latest TodoWrite (its own plan). */
  todos: { content: string; status: string }[];
  /** The todo the subagent is currently on (in_progress); null when none is — honest, never guessed. */
  currentTask: string | null;
}

/** Fields from an `agent-<id>.meta.json` sidecar (Claude Code 2.1.20x) — a label source when the parent
 *  transcript's spawn/result can't be correlated (async_launched subagents often have no result). */
interface SubagentSidecar {
  agentType?: string;
  description?: string;
  spawnDepth?: number;
  toolUseId?: string;
  /** `background` for an agent launched with run_in_background (Claude Code 2.x). */
  requestShape?: string;
}

/** Read an `agent-<id>.meta.json` sidecar, or null when absent/unparseable (the parent meta still applies). */
function readSidecar(metaPath: string): SubagentSidecar | null {
  let o: any;
  try {
    o = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  return {
    agentType: typeof o.agentType === 'string' ? o.agentType : undefined,
    description: typeof o.description === 'string' ? o.description : undefined,
    spawnDepth: typeof o.spawnDepth === 'number' && isFinite(o.spawnDepth) ? o.spawnDepth : undefined,
    toolUseId: typeof o.toolUseId === 'string' ? o.toolUseId : undefined,
    requestShape: typeof o.requestShape === 'string' ? o.requestShape : undefined,
  };
}

export interface SubagentTodos {
  todos: { content: string; status: string }[];
  /** The todo currently in_progress; null when none is (honest — never falls back to a guess). */
  currentTask: string | null;
}

/** Extract the latest non-empty TodoWrite (the subagent's own plan) from an agent-<id>.jsonl. */
function todosFromTranscript(agentTranscriptPath: string): SubagentTodos {
  const todos = subagentFacts(agentTranscriptPath, true).todos.map((todo) => ({ ...todo }));
  const inProg = todos.find((td) => td.status === 'in_progress');
  return { todos, currentTask: inProg ? inProg.content : null };
}

/**
 * A subagent's latest TodoWrite (its own plan) + the todo it's currently on. `transcriptInsights` is
 * main-chain only; this reads the subagent's OWN agent-<id>.jsonl. Empty when the subagent has no file.
 */
export function subagentTodos(cwd: string, sessionId: string, agentId: string): SubagentTodos {
  const dir = findSubagentsDir(cwd, sessionId);
  if (!dir) return { todos: [], currentTask: null };
  return todosFromTranscript(path.join(dir, `agent-${agentId}.jsonl`));
}

/** A subagent's OWN vitals, read straight from its agent-<id>.jsonl: the model + reasoning effort it last
 *  declared, its token usage, and its wall-clock span. `sessionVitals`/`sessionUsage` cannot answer this —
 *  they skip `isSidechain` records to keep a subagent's cost out of the SESSION's, and a subagent's own
 *  transcript is ENTIRELY sidechain, so they come back empty/zero. And an `async_launched` spawn's
 *  `toolUseResult` carries no totals at all, so for those this is the ONLY place its tokens exist.
 *  The shared cursor folds this alongside the todos/action passes. */
function vitalsFromTranscript(agentTranscriptPath: string): { model: string; effort: string; durationMs: number; tokens: number; tokensIn: number; tokensOut: number; tokensCacheRead: number; lastTurnTs: number } {
  const v = subagentFacts(agentTranscriptPath, true).vitals;
  return {
    model: v.model ? friendlyModel(v.model) : '',
    effort: v.effort,
    durationMs: v.lastTs > v.firstTs ? v.lastTs - v.firstTs : 0,
    tokens: v.tokensIn + v.tokensOut + v.tokensCacheCreate,
    tokensIn: v.tokensIn,
    tokensOut: v.tokensOut,
    tokensCacheRead: v.tokensCacheRead,
    lastTurnTs: v.lastTurnTs,
  };
}

/** Parse ISO/epoch timestamp → ms epoch, 0 when absent. (Local copy so subagents.ts stays standalone.) */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

function fin(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

/** The subagents/ dir for a session, or null. Derived from the main transcript's project dir:
 *  <proj>/<session>.jsonl  ⇒  <proj>/<session>/subagents/. */
export function findSubagentsDir(cwd: string, sessionId: string): string | null {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return null;
  const dir = path.join(path.dirname(transcript), sessionId, 'subagents');
  return derivedInventory(`subagents-directory:${dir}`, () => {
    try {
      return fs.statSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  });
}

/** Map agentId → its spawn + result metadata, from a single pass over the parent transcript. */
function subagentMeta(transcriptPath: string): Map<string, SubagentMeta> {
  return transcriptFacts(transcriptPath).subagents.meta;
}

export interface SubagentFacts {
  spawns: Map<string, { description?: string; subagentType?: string; ts: number }>;
  meta: Map<string, SubagentMeta>;
  todos: SubagentTodos['todos'];
  /** `lastTurnTs`: its newest turn (a user or assistant record; a meta user record counts, as it resumes an agent). */
  vitals: { model: string; effort: string; tokensIn: number; tokensOut: number; tokensCacheRead: number; tokensCacheCreate: number; firstTs: number; lastTs: number; lastTurnTs: number };
  /** Each background task's latest completion notice, by task id (an agent's is its agentId): the harness's
   *  own status word and when the task ended (its enqueue). */
  ended: Map<string, { status: string; ts: number }>;
}
export function newSubagentFacts(): SubagentFacts {
  return { spawns: new Map(), meta: new Map(), todos: [], ended: new Map(),
    vitals: { model: '', effort: '', tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheCreate: 0, firstTs: 0, lastTs: 0, lastTurnTs: 0 } };
}

/** One tagged value out of a <task-notification> block: the first `<name>` that is closed. indexOf, not
 *  a lazy `<name>([\s\S]*?)</name>`, which read to the end of the text from every unclosed opener. */
function notificationTag(text: string, name: string): string {
  const open = text.indexOf(`<${name}>`);
  const close = open < 0 ? -1 : text.indexOf(`</${name}>`, open + name.length + 2);
  return close < 0 ? '' : text.slice(open + name.length + 2, close).trim();
}

/** Spawn/result joins and each agent's own todos/usage advance with the shared record cursor. */
function foldSubagentMeta(facts: SubagentFacts, o: any): void {
  const { spawns, meta: out } = facts;
  const ts = toMs(o.timestamp ?? o.ts);
  // A background task's completion notice: the harness logs it as a `queue-operation` (enqueued when the
  // task ended, removed when a turn consumed it) and as a `queued_command` attachment.
  const notice = typeof o.content === 'string' ? o.content
    : o.attachment?.type === 'queued_command' && typeof o.attachment.prompt === 'string' ? o.attachment.prompt : '';
  if (notice.includes('<task-notification>')) {
    // Its header names the task, or every agent a session's end cut off; the agent's own words follow in
    // <summary> and <result>, and are never read as ids.
    const cut = notice.search(/<(?:status|summary|result)>/);
    const status = notificationTag(notice, 'status') || 'completed';
    const head = cut >= 0 ? notice.slice(0, cut) : notice;
    // Each <task-id>…</task-id> in turn, by indexOf as notificationTag does.
    for (let at = head.indexOf('<task-id>'); at >= 0; ) {
      const end = head.indexOf('</task-id>', at + 9);
      if (end < 0) break;
      const id = head.slice(at + 9, end).trim();
      // An enqueue is a new end: a finished agent can be resumed (SendMessage) and notify again.
      // The removal and the attachment are later copies of the same notice, so they only fill a gap.
      if (id && ((o.operation === 'enqueue' && ts > 0) || !facts.ended.has(id))) facts.ended.set(id, { status, ts });
      at = head.indexOf('<task-id>', end + 10);
    }
    return;
  }
  const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  // Record every Agent/Task spawn so its description/type can be attached once the result names the agentId.
  for (const b of content) {
    if (b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string') {
      const i = b.input && typeof b.input === 'object' ? b.input : {};
      spawns.set(b.id, {
        description: typeof i.description === 'string' ? i.description : undefined,
        subagentType: typeof i.subagent_type === 'string' ? i.subagent_type : undefined,
        ts,
      });
    }
  }
  // The tool_result for a spawn carries a `toolUseResult` object naming the agentId + its metrics.
  const tur = o.toolUseResult;
  if (tur && typeof tur === 'object' && typeof tur.agentId === 'string') {
    let toolUseId: string | undefined;
    for (const b of content) if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') toolUseId = b.tool_use_id;
    const spawn = toolUseId ? spawns.get(toolUseId) : undefined;
    out.set(tur.agentId, {
      agentType: typeof tur.agentType === 'string' ? tur.agentType : spawn?.subagentType,
      description: spawn?.description,
      status: typeof tur.status === 'string' ? tur.status : undefined,
      durationMs: fin(tur.totalDurationMs),
      tokens: fin(tur.totalTokens),
      toolUseCount: fin(tur.totalToolUseCount),
      ts: spawn?.ts ?? ts,
      toolUseId,
    });
  }
}

export function foldSubagentFacts(facts: SubagentFacts, o: any): void {
  foldSubagentMeta(facts, o);
  const { vitals } = facts;
  const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  for (const b of content) {
    if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
      const list = b.input.todos.filter((td: any) => td && typeof td.content === 'string')
        .map((td: any) => ({ content: td.content.trim(), status: String(td.status || '') }));
      if (list.length) facts.todos = list;
    }
  }
  if (typeof o.message?.model === 'string' && o.message.model) vitals.model = o.message.model;
  if (typeof o.effort === 'string' && o.effort) vitals.effort = o.effort;
  const usage = o.message?.usage;
  if (usage) {
    vitals.tokensIn += usage.input_tokens || 0;
    vitals.tokensOut += usage.output_tokens || 0;
    vitals.tokensCacheRead += usage.cache_read_input_tokens || 0;
    vitals.tokensCacheCreate += usage.cache_creation_input_tokens || 0;
  }
  const timestamp = toMs(o.timestamp);
  if (timestamp) {
    if (!vitals.firstTs) vitals.firstTs = timestamp;
    vitals.lastTs = timestamp;
    // A user record counts even when it is meta: Claude Code resumes a finished agent (SendMessage, a child's
    // notice) with a meta prompt, well before its first reply (a median 10 s, up to four minutes).
    if ((o.type === 'user' || (o.type === 'assistant' && o.isMeta !== true)) && o.message?.model !== '<synthetic>') vitals.lastTurnTs = timestamp;
  }
}

/** When a background agent, its parent and the session's other agents have all been silent this long with
 *  no completion notice, the session ended under it (actions.ts's DONE_STALE_MS). */
const ORPHAN_STALE_MS = 5 * 60_000;
/** A turn in an agent's own transcript this long after its notice means it was resumed (its last
 *  record lands tens of milliseconds before the notice; the earliest resume on record came 5.5 s after). */
const RESUME_GRACE_MS = 2_000;

/**
 * A worker's phase. A BACKGROUND agent is finished once its parent session logs the harness's completion
 * notice for it, and running until then (the tail of its own transcript read a pause
 * between two steps as idle, and a long one as done, so the Workers list lost agents that were still
 * working). A turn after its latest notice is a resume, which runs until the next notice. A failed, killed
 * or stopped one reads as errored. Its transcript still says whether it works or waits on the person. With
 * no notice it is done only when it, its parent and the session's other agents (`newestAgentWriteMs`) have
 * all been silent past ORPHAN_STALE_MS. A foreground agent keeps the tail's reading.
 */
function workerPhase(jsonlPath: string, parent: string | null, background: boolean, ended: { status: string; ts: number } | undefined,
  lastTurnTs: number, newestAgentWriteMs: number): { phase: Phase; phaseConfidence: PhaseConfidence; running: boolean } {
  if (background && ended && !(ended.ts > 0 && lastTurnTs > ended.ts + RESUME_GRACE_MS)) {
    return { phase: /fail|error|kill|stop/i.test(ended.status) ? 'errored' : 'done', phaseConfidence: 'high', running: false };
  }
  const { phase, confidence } = derivedInventory(`phase:${jsonlPath}`, () => agentPhaseDetail(jsonlPath));
  // A failed tool call is a step, not the end: the agent reads the error and goes on.
  if (!background || (phase !== 'idle' && phase !== 'done' && phase !== 'errored')) {
    return { phase, phaseConfidence: confidence, running: phase === 'working' || phase === 'awaiting-input' || phase === 'awaiting-permission' };
  }
  const silent = (ms: number): boolean => Date.now() - ms > ORPHAN_STALE_MS;
  const written = (file: string | null): number => {
    if (!file) return 0;
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
  };
  if (silent(written(jsonlPath)) && silent(written(parent)) && silent(newestAgentWriteMs)) return { phase: 'done', phaseConfidence: 'heuristic', running: false };
  return { phase: 'working', phaseConfidence: 'heuristic', running: true };
}

/** When any of these agent transcripts was last written: the session's agents' own activity. */
function newestWrite(dir: string, files: readonly string[]): number {
  let newest = 0;
  for (const f of files) {
    try { newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* vanished mid-scan */ }
  }
  return newest;
}

function subagentFacts(transcriptPath: string, includeSidechain = false): SubagentFacts {
  return transcriptFacts(transcriptPath, includeSidechain).subagents;
}

/**
 * Every subagent spawned in this session, each with its own action timeline + metrics, spawn-time
 * ordered. Empty when the session has no subagents/ dir (no subagents ran). Zero token.
 */
export function parseSubagents(cwd: string, sessionId: string): SubagentInfo[] {
  const { readCaptureEvents } = require('./capture-events') as typeof import('./capture-events');
  const native = new Map<string, SubagentInfo>();
  for (const e of readCaptureEvents(sessionId, ['subagent'])) {
    const p = e.payload as { phase?: string; context?: { agentId?: string; agentType?: string; id?: string } };
    const agentId = p.context?.agentId ?? p.context?.id; if (!agentId) continue;
    const previous = native.get(agentId);
    const { findCodexRollout } = require('./codex') as typeof import('./codex');
    const raw = findCodexRollout(agentId);
    const derived = raw ? (require('./codex-events') as typeof import('./codex-events')).codexTranscriptFile(raw) : null;
    const actions = derived ? parseTranscriptActions(derived, { includeSidechain: true }) : [];
    const stopped = p.phase === 'stop';
    native.set(agentId, { agentId, agentType: p.context?.agentType ?? previous?.agentType,
      ts: previous?.ts ?? e.ts, ...(stopped && previous ? { durationMs: Math.max(0,e.ts-previous.ts) } : {}),
      status: stopped ? 'completed' : undefined, actions, edits: actions.filter((a) => a.category === 'edit').length,
      summary: summarizeActions(actions), phase: stopped ? 'done' : Date.now()-e.ts < 60000 ? 'working' : 'idle',
      phaseConfidence: stopped ? 'high' : 'heuristic', running: !stopped && Date.now()-e.ts < 60000, todos: [], currentTask: null });
  }
  const dir = findSubagentsDir(cwd, sessionId);
  if (!dir) return [...native.values()];
  let files: string[];
  try {
    files = derivedInventory(`action-subagents:${dir}`, () => fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')));
  } catch {
    return [];
  }
  const transcript = findTranscript(cwd, sessionId);
  const facts = transcript ? subagentFacts(transcript) : undefined;
  const meta = facts?.meta ?? new Map<string, SubagentMeta>();
  const out: SubagentInfo[] = [...native.values()];
  const agentsWritten = newestWrite(dir, files);
  for (const f of files) {
    const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const jsonlPath = path.join(dir, f);
    const actions = parseTranscriptActions(jsonlPath, { includeSidechain: true });
    const m = meta.get(agentId);
    const sidecar = readSidecar(path.join(dir, `agent-${agentId}.meta.json`)); // fills gaps the parent lacks
    // Sidecar-memoized per (agent transcript mtime,size): the tick re-parsed every subagent transcript
    // for its todo list on every refresh — 28 files / 31MB on a real live session, 100-215ms per tick,
    // the largest non-inherent cost the 0.9.0 profile found — when a FINISHED agent's file never moves.
    let tStamp = '';
    try {
      const st = fs.statSync(jsonlPath);
      tStamp = `1|${st.mtimeMs}:${st.size}`;
    } catch {
      /* unreadable — compute uncached */
    }
    const { todos, currentTask } = sidecarMemo(sessionId, `todos:${agentId}`, tStamp, () => todosFromTranscript(jsonlPath));
    // A background agent's own status is `async_launched` for good: its end is the parent's completion
    // notice (workerPhase). Detail (not the bare label) so consumers can tell a structural phase from a
    // staleness heuristic instead of asserting it as truth.
    const background = m?.status === 'async_launched' || sidecar?.requestShape === 'background';
    const state = workerPhase(jsonlPath, transcript, background, facts?.ended?.get(agentId), subagentFacts(jsonlPath, true).vitals.lastTurnTs, agentsWritten);
    const firstTs = actions.find((a) => a.ts > 0)?.ts ?? 0;
    out.push({
      agentId,
      agentType: m?.agentType ?? sidecar?.agentType,
      description: m?.description ?? sidecar?.description,
      status: m?.status,
      ts: m?.ts || firstTs,
      durationMs: m?.durationMs,
      tokens: m?.tokens,
      toolUseCount: m?.toolUseCount,
      toolUseId: m?.toolUseId ?? sidecar?.toolUseId,
      spawnDepth: sidecar?.spawnDepth,
      actions,
      edits: actions.filter((a) => a.category === 'edit').length,
      summary: summarizeActions(actions),
      ...state,
      background,
      todos,
      currentTask,
    });
  }
  // §6: honestly attribute store edit ids across the main chain + every subagent (ts-window
  // partitioned; interleaved same-file overlaps stay unassigned, never cross-attributed). Mutates each
  // subagent's actions' editId in place — so SubagentInfo.actions now carries the attributed editIds
  // (previously a no-op: parseTranscriptActions never linked, so every subagent editId was undefined).
  const mainActions = transcript ? parseTranscriptActions(transcript, { includeSidechain: false }) : [];
  const authors: EditAttributionAuthor[] = [
    { agentId: null, edits: mainActions },
    ...out.map((s) => ({ agentId: s.agentId, edits: s.actions })),
  ];
  attributeEditIds(sessionId, authors);
  // Spawn order (a subagent with no correlated spawn ts sinks last, which is fine — it's the exception).
  out.sort((a, b) => a.ts - b.ts || a.agentId.localeCompare(b.agentId));
  return out;
}

/** What a fleet row needs to draw a subagent: identity, plan, and live phase — never its action list. */
export interface SubagentDigest {
  agentId: string;
  agentType?: string;
  description?: string;
  todos: SubagentInfo['todos'];
  currentTask: SubagentInfo['currentTask'];
  phase: SubagentInfo['phase'];
  phaseConfidence: SubagentInfo['phaseConfidence'];
  running: boolean;
  /** Launched in the background: its end is its completion notice in the parent session (workerPhase). */
  background?: boolean;
  /** Spawn time (ms epoch) — the Agent/Task tool_use that created this subagent. Carried so a list can
   *  order most-recently-spawned first and show its age, not just guess from directory order. */
  ts?: number;
  /** What the subagent cost — its own tokens and wall-clock, from its result block. Carried so the
   *  Workers tab can show a subagent the same metrics as its parent. */
  durationMs?: number;
  tokens?: number;
  /** The ↑ input · ↓ output · ↺ cache-read split the statusline prints, kept SEPARATE
   *  — summed from the subagent's own transcript. `tokens` above is the one-number total for surfaces that
   *  show one; these are for surfaces that show the split. */
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  /** The model + reasoning effort the SUBAGENT itself ran on, read from its own transcript — a spawn can
   *  use a different model than its parent. Blank when its transcript never declared one. */
  model?: string;
  effort?: string;
}

/**
 * The subagent rows for the fleet, without the cost of their action lists.
 *
 * [parseSubagents] parses every subagent transcript in full and then attributes store edit ids across
 * them — necessary when a caller wants the actions, and pure waste when it only wants to draw a row.
 * A repo with dozens of siblings paid that on every refresh tick. The identity and plan of a subagent
 * are fixed once its transcript stops changing, so they are memoized against the directory's state;
 * the PHASE never is — it is derived from how long ago the file was last written, and a frozen copy
 * would report a working agent as done.
 */
export function subagentDigests(cwd: string, sessionId: string): SubagentDigest[] {
  const dir = findSubagentsDir(cwd, sessionId);
  if (!dir) return [];
  let files: string[];
  try {
    files = derivedInventory(`action-subagents:${dir}`, () => fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))).slice().sort();
  } catch {
    return [];
  }
  const parts: string[] = [];
  const stampByFile = new Map<string, string>(); // per-file stamp, for the per-agent vitals memo below
  const transcript = findTranscript(cwd, sessionId);
  if (transcript) {
    try {
      const st = fs.statSync(transcript);
      parts.push(`parent:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`);
    } catch { /* absent parent metadata */ }
  }
  let agentsWritten = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      const p = `${f}:${st.mtimeMs}:${st.size}`;
      parts.push(p);
      stampByFile.set(f, p);
      agentsWritten = Math.max(agentsWritten, st.mtimeMs);
    } catch {
      /* vanished mid-scan — its absence is part of the stamp */
    }
    const sidecar = f.replace(/\.jsonl$/, '.meta.json');
    try {
      const st = fs.statSync(path.join(dir, sidecar));
      parts.push(`${sidecar}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`);
    } catch { /* absent sidecar */ }
  }
  // Version prefix — bumped when the digest's SHAPE or its per-transcript extraction changes, so a sidecar
  // cached under the old logic is discarded rather than served stale. 6: parent results and metadata
  // sidecars can change the labels/totals while every subagent transcript stays unchanged. 7: `background`.
  // 8: each agent's latest notice and last turn, so a hit never decodes the parent's facts. 9: a
  // meta user record is a turn.
  const stamp = parts.length ? `9|${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)}` : '';
  const stable = sidecarMemo(sessionId, 'subagentDigests', stamp, () => {
    const ended = transcript ? subagentFacts(transcript).ended : undefined;
    return parseSubagents(cwd, sessionId).map((s) => {
      const file = `agent-${s.agentId}.jsonl`;
      // PER-AGENT memo (like todos/actions): the outer stamp flips whenever ANY subagent appends, so
      // without this a live session re-parses EVERY spawn transcript's usage each rebuild. Keyed on that
      // one file's stamp, so an unchanged spawn's vitals are served from its sidecar and only the active
      // one re-reads. `v5|` version so a change to the extraction discards the old per-agent cache too.
      const v = sidecarMemo(sessionId, `subVitals:${s.agentId}`, `v7|${stampByFile.get(file) ?? ''}`, () =>
        vitalsFromTranscript(path.join(dir, file))
      );
      return {
        agentId: s.agentId,
        agentType: s.agentType,
        description: s.description,
        background: s.background,
        todos: s.todos,
        currentTask: s.currentTask,
        ts: s.ts,
        // Prefer Claude Code's own `toolUseResult` totals; fall back to the subagent's transcript when it
        // has none — an async_launched spawn reports 0 there but did real work.
        durationMs: s.durationMs || v.durationMs,
        tokens: s.tokens || v.tokens,
        tokensIn: v.tokensIn,
        tokensOut: v.tokensOut,
        tokensCacheRead: v.tokensCacheRead,
        model: v.model,
        effort: v.effort,
        ended: ended?.get(s.agentId) ?? null,
        lastTurnTs: v.lastTurnTs,
      };
    });
  });
  // Phase is asked of the file every time, never remembered; a background agent's end is its notice.
  return stable.map(({ ended, lastTurnTs, ...s }) => ({ ...s,
    ...workerPhase(path.join(dir, `agent-${s.agentId}.jsonl`), transcript, !!s.background, ended ?? undefined, lastTurnTs ?? 0, agentsWritten) }));
}

export interface SubagentsSummary {
  count: number;
  totalActions: number;
  totalEdits: number;
  totalDurationMs: number;
  totalTokens: number;
  errors: number;
}

/** The Tasks tab's rows across BOTH task generations: the legacy numbered list (TaskCreate/TaskUpdate
 *  + ~/.claude/tasks files) UNIONED with one row per background Agent run — the newer harness's task
 *  system, which writes agent transcripts + task-notifications instead of numbered task files, and
 *  which previously left the tab permanently empty. Subject = the spawn description; status tracks the
 *  agent's LIVE phase (in_progress while running, errored passes through); activeForm = the agent's own
 *  in-progress todo (honest: null when it declared none). Lives here, not tasks.ts, because tasks.ts
 *  must not import subagents (subagents → actions → changemap → tasks would close a cycle). The two
 *  generations never coexist in practice; when they do, the numbered list leads. */
export function allSessionTaskRows(cwd: string, sessionId: string): SessionTaskRow[] {
  const spawnOrder = parseSubagents(cwd, sessionId).slice().sort((a, b) => a.ts - b.ts);
  const agents = spawnOrder.map((s, i): SessionTaskRow => {
    const subject = (s.description || '').trim() || `${s.agentType || 'agent'} ${s.agentId.slice(0, 8)}`;
    return {
      id: `a${i + 1}`, // spawn-order display key ("#a1") — distinct on sight from the legacy numeric ids
      subject,
      description: [s.agentType, s.currentTask].filter(Boolean).join(' — '),
      status: s.running ? 'in_progress' : s.phase === 'errored' ? 'errored' : 'completed',
      activeForm: s.running ? s.currentTask : null,
      blocks: [],
      blockedBy: [],
      taskId: taskIdForSubject(subject),
    };
  });
  agents.reverse(); // newest spawn first, matching the legacy rows' newest-first order
  return [...sessionTaskRows(cwd, sessionId), ...agents];
}

/** Headline rollup across all subagents (for the Actions "Subagents" group header + `metrics`). */
export function summarizeSubagents(subs: SubagentInfo[]): SubagentsSummary {
  return {
    count: subs.length,
    totalActions: subs.reduce((n, s) => n + s.summary.total, 0),
    totalEdits: subs.reduce((n, s) => n + s.edits, 0),
    totalDurationMs: subs.reduce((n, s) => n + (s.durationMs ?? 0), 0),
    totalTokens: subs.reduce((n, s) => n + (s.tokens ?? 0), 0),
    errors: subs.reduce((n, s) => n + s.summary.errors, 0),
  };
}

/** What SPAWNED an agent — the two storage locations, named as one idea. */
export type SpawnKind = 'subagent' | 'workflow-agent';

/**
 * EVERY AGENT A SESSION SPAWNED, as one list.
 *
 * A session records spawns in two disjoint places — `subagents/agent-<id>.jsonl` for a direct
 * Task/Agent spawn, and `subagents/workflows/wf_<id>/agent-<id>.jsonl` for a workflow run's fan-out —
 * and `parseSubagents` deliberately skips the second. That split is a STORAGE fact, not something a
 * reader should have to know: both are "an agent this session started", and asking a surface to hold
 * two disjoint lists of the same idea is where the logical bugs come from.
 *
 * The one thing the merge must NOT flatten is where the edit count comes from — see `editSource`.
 */
export interface SpawnedAgent {
  agentId: string;
  kind: SpawnKind;
  /** The `wf_<id>` this belongs to; absent for a direct subagent. */
  runId?: string;
  /** Its human label: a subagent's description, or a workflow runner's per-agent label. */
  label: string | null;
  /** True when the label was DERIVED rather than declared (a live run's prompt-derived label).
   *  Renderers mark it; they never assert it. */
  labelDerived: boolean;
  agentType: string | null;
  ts: number;
  durationMs: number;
  tokens: number;
  /** Tool calls that edited a file. */
  edits: number;
  /**
   * WHERE `edits` COMES FROM, because the two kinds are not equally trustworthy:
   *
   *   'store'       the store attributed these edits to this agent (`rollupBySubagent`). They are
   *                 real records — reviewable, keep/undo-able, and they appear in the change map.
   *   'self-report' counted from the agent's OWN Edit/Write/MultiEdit inputs, because the store
   *                 cannot attribute workflow agents. They are what the agent SAID it did.
   *
   * Presenting the two as one number would be the conflation this whole unification exists to avoid.
   */
  editSource: 'store' | 'self-report';
  /** Finished — a subagent's terminal status, or a workflow journal's recorded result. */
  done: boolean;
  /** Nesting depth in the agent tree, when the sidecar recorded one. */
  spawnDepth?: number;
  /** Which phase of its run it belongs to — workflow agents only. */
  phase?: string | null;
}

/**
 * Both spawn sources, merged, newest-spawn first.
 *
 * ADDITIVE: `parseSubagents` and `parseWorkflows` stay exactly as they are and remain the readers.
 * This is the view a navigator wants; nothing existing has to migrate to get it.
 */
export function spawnedAgents(cwd: string, sessionId: string): SpawnedAgent[] {
  const out: SpawnedAgent[] = [];
  for (const s of parseSubagents(cwd, sessionId)) {
    out.push({
      agentId: s.agentId,
      kind: 'subagent',
      label: s.description ?? null,
      labelDerived: false,
      agentType: s.agentType ?? null,
      ts: s.ts,
      durationMs: s.durationMs ?? 0,
      tokens: s.tokens ?? 0,
      edits: s.edits,
      editSource: 'store',
      // A subagent's status is its own terminal word; anything that is not explicitly unfinished
      // reads as done only when the transcript said so.
      done: s.status === 'completed' || s.status === 'done',
      ...(s.spawnDepth === undefined ? {} : { spawnDepth: s.spawnDepth }),
    });
  }
  // Imported lazily: workflows.ts already imports from this module, and a top-level import here
  // would close the cycle.
  const { parseWorkflows } = require('./workflows') as typeof import('./workflows');
  for (const run of parseWorkflows(cwd, sessionId)) {
    for (const a of run.agents) {
      out.push({
        agentId: a.agentId,
        kind: 'workflow-agent',
        runId: run.id,
        label: a.label,
        labelDerived: a.labelDerived,
        agentType: a.agentType,
        ts: run.startedTs,
        durationMs: a.durationMs,
        tokens: a.tokens,
        edits: a.edits,
        editSource: 'self-report',
        done: a.done,
        phase: a.phase,
      });
    }
  }
  return out.sort((x, y) => y.ts - x.ts);
}
