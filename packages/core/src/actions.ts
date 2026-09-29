/**
 * Action timeline (zero-token): the full, typed stream of EVERY tool call Claude made this session —
 * not just the file edits the store captures. Reads, searches, shell commands, web fetches, subagent
 * spawns, and to-do updates are all mined from the Claude Code session transcript (the same file
 * observe.ts already parses for reasoning), correlated with their tool_result for success/failure.
 *
 * This is what turns Claude Observatory from an *edit* review layer into a *session* observatory: the
 * store answers "what did Claude change?"; this answers "what did Claude DO?".
 *
 * No model calls — the transcript already contains every tool_use and its result.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readLog, readBlob, findRecord, EditRecord , minOf, maxOf, sidecarMemo } from './store';
import { findTranscript } from './observe';
import { findSubagentsDir } from './subagents';
import { scoreCommand, CommandRisk } from './risk';
import { readLines } from './fscache';
import { taskId } from './changemap';
import { transcriptFacts } from './derived-transcript';
import { derivedInventory } from './derived';

/** Coarse action kind, drives the timeline's icon + grouping + which rows the UI can dim/filter. */
export type ActionCategory =
  | 'edit' // Edit | Write | MultiEdit | NotebookEdit  (mutates a file — links to a store EditRecord)
  | 'exec' // Bash                                     (runs a shell command — may also mutate files)
  | 'read' // Read | NotebookRead                      (reads a file)
  | 'search' // Grep | Glob                            (searches the codebase)
  | 'web' // WebFetch | WebSearch                      (touches the network — see egress, 0.6.0)
  | 'agent' // Task | Agent                            (spawns a subagent — see subagents, 0.7.0)
  | 'todo' // TodoWrite                                (updates the plan checklist)
  | 'mcp' // mcp__<server>__<tool>                     (an external MCP tool)
  | 'meta' // AskUserQuestion | ExitPlanMode | ToolSearch | Skill (harness/UX, not codebase work)
  | 'compact' // a context compaction the harness performed (not a tool call — see CompactionEvent)
  | 'other';

export interface ActionRecord {
  /** ms epoch of the tool_use's transcript line (0 if the line carried no timestamp). */
  ts: number;
  /** The tool name exactly as Claude Code recorded it (Bash, Read, Grep, WebFetch, Agent, mcp__x__y…). */
  tool: string;
  category: ActionCategory;
  /** One-line human-readable target: file path, shell command, search pattern, url, query, subagent task… */
  target: string;
  /** Secondary context when the tool has one (Bash description, Agent subagent_type, Grep path…). */
  detail?: string;
  /** A shell call's FULL command (bounded at 24 lines / 2000 chars) — `target` is one flattened line
   *  by design, and the whole thing must be readable on expand. Bash only. */
  cmd?: string;
  /** false only when the correlated tool_result reported is_error (or the command failed). */
  ok: boolean;
  isError: boolean;
  /** Claude's reasoning (the assistant text/thinking that preceded this call), carried forward per message. */
  reasoning?: string;
  /** WHICH of the two `reasoning` is: 'thinking' for an actual thinking block, 'text' for prose the
   *  agent wrote to the reader. A surface that labels one as the other is lying about what it is
   *  showing, and the two read very differently — prose is addressed to you, thinking is not. */
  reasoningKind?: 'text' | 'thinking';
  /** For file-edit actions: the store EditRecord id this call produced, so the timeline can offer diff/keep/undo. */
  editId?: number;
  /** DISPLAY-ONLY store id for the diff, set (by the feed) only when `editId` is null because this edit
   *  interleaved with a subagent's on the same file. Never used for keep/undo — see FeedEntry.previewId. */
  previewId?: number;
  /** For shell (Bash) actions: a risk score when the command is destructive / privileged / touches secrets. */
  risk?: CommandRisk;
  /** The tool_use id (correlates to its tool_result). */
  toolUseId?: string;
  /** For 'compact' rows: what the harness dropped and when. */
  compact?: CompactionEvent;
  /** For the plan tools (TodoWrite · TaskCreate · TaskUpdate) only: the facts a counter needs, verbatim.
   *  [target] is a DISPLAY string — one line, clipped at 160 characters — so identity must never be
   *  derived from it: a to-do longer than that would hash to something no task ever equals. */
  plan?: PlanFacts;
}

/** What a plan call did, unabbreviated. [subject] is a to-do's own text (the in-progress item for a
 *  TodoWrite, the subject for a TaskCreate); [taskId] and [status] are what a TaskUpdate carries, and a
 *  TaskUpdate that changes neither status nor subject reports neither. */
export interface PlanFacts {
  subject?: string;
  taskId?: string;
  status?: string;
}

/** The plan facts for one call, or undefined when the tool does not touch the plan. */
function planFactsOf(tool: string, input: any): PlanFacts | undefined {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'TodoWrite' && Array.isArray(i.todos)) {
    const inProg = i.todos.find((t: any) => t && t.status === 'in_progress');
    const subject = inProg && typeof inProg.content === 'string' ? inProg.content.trim() : '';
    return subject ? { subject, status: 'in_progress' } : undefined; // nothing in progress names no task
  }
  if (tool === 'TaskCreate' && typeof i.subject === 'string' && i.subject.trim())
    return { subject: i.subject.trim(), status: 'created' };
  if (tool === 'TaskUpdate' && i.taskId != null) {
    const facts: PlanFacts = { taskId: String(i.taskId) };
    if (typeof i.status === 'string' && i.status) facts.status = i.status;
    if (typeof i.subject === 'string' && i.subject.trim()) facts.subject = i.subject.trim();
    return facts;
  }
  return undefined;
}

/** One context compaction: the harness summarized the conversation so far and continued on the summary.
 *  Structural, from the transcript's own `compact_boundary` record — no estimation. */
export interface CompactionEvent {
  ts: number;
  /** 'auto' (hit the context limit) or 'manual' (/compact) — passed through verbatim. */
  trigger: string;
  /** Context size just before / just after the compaction. */
  preTokens: number;
  postTokens: number;
  /** What THIS compaction dropped (pre − post). Deliberately not `cumulativeDroppedTokens`, which is a
   *  running session total — a real two-compaction session records 986k then 1.97M, so rendering the
   *  cumulative figure as one event's drop overstates the later ones. */
  droppedTokens: number;
  /** The session-cumulative drop as the harness recorded it (for a "dropped so far" readout). */
  cumulativeDropped: number;
  /** How long the summarization itself took. */
  durationMs: number;
}

/** A `compact_boundary` line → its event, or null for any other record. Shared with metrics.ts, whose
 *  incremental cursor detects the same lines without re-reading the transcript this parser walks. */
export function parseCompactLine(o: any): CompactionEvent | null {
  if (!o || o.type !== 'system' || o.subtype !== 'compact_boundary') return null;
  const md = o.compactMetadata || {};
  const fin = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);
  const preTokens = fin(md.preTokens);
  const postTokens = fin(md.postTokens);
  return {
    ts: toMs(o.timestamp ?? o.ts),
    trigger: typeof md.trigger === 'string' ? md.trigger : '',
    preTokens,
    postTokens,
    droppedTokens: Math.max(0, preTokens - postTokens),
    cumulativeDropped: fin(md.cumulativeDroppedTokens),
    durationMs: fin(md.durationMs),
  };
}

/** The one-line summary every surface shows for a compaction — built ONCE here so the CLI, the Actions
 *  timeline, the Overview ribbon and both editors' panels can never word it differently.
 *  e.g. `auto · 1M→14k · 986k dropped · 2m 5s`. */
export function compactLabel(ce: CompactionEvent): string {
  const tok = (n: number): string => {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  };
  const parts = [ce.trigger || 'compact', `${tok(ce.preTokens)}→${tok(ce.postTokens)}`];
  if (ce.droppedTokens > 0) parts.push(`${tok(ce.droppedTokens)} dropped`);
  if (ce.durationMs > 0) {
    const s = ce.durationMs / 1000;
    parts.push(s < 60 ? `${s.toFixed(s < 10 ? 1 : 0).replace(/\.0$/, '')}s` : `${Math.floor(s / 60)}m${Math.round(s % 60) ? ` ${Math.round(s % 60)}s` : ''}`);
  }
  return parts.join(' · ');
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/** Map a tool name to its coarse category. */
export function categoryOf(tool: string): ActionCategory {
  if (tool.startsWith('mcp__')) return 'mcp';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  switch (tool) {
    case 'Bash':
      return 'exec';
    case 'Read':
    case 'NotebookRead':
      return 'read';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Task':
    case 'Agent':
      return 'agent';
    case 'TodoWrite':
    // The newer task system (numbered tasks with statuses) — same planning surface, same category.
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return 'todo';
    case 'AskUserQuestion':
    case 'ExitPlanMode':
    case 'ToolSearch':
    case 'Skill':
      return 'meta';
    default:
      return 'other';
  }
}

/** Collapse to a single trimmed line so a multi-line command/target renders in one row. */
function oneLine(s: string, max = 300): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Best human-readable "what did this call act on" for a tool_use, plus optional secondary detail. */
export function targetOf(tool: string, input: any): { target: string; detail?: string; cmd?: string } {
  const i = input && typeof input === 'object' ? input : {};
  // file_path / notebook_path are unambiguously a file; `path` is NOT (Grep/LS use it for a search dir),
  // so it is handled by the pattern/fallback branches below, not treated as the file target.
  const f = i.file_path || i.notebook_path;
  if (typeof f === 'string' && f) return { target: f, detail: undefined };
  if (tool === 'Bash' && typeof i.command === 'string') {
    const cmd = String(i.command);
    const head = oneLine(cmd);
    const desc = typeof i.description === 'string' ? i.description : undefined;
    // The head row is ONE line by design — but the command must be READABLE whole on expand. It rides its
    // own `cmd` field, BOUNDED (a giant heredoc must not bloat every poll's payload) and saying
    // exactly how much it withheld. Its own field, never folded into `detail`: detail is the human
    // description on every surface, and the two must stay separable.
    const lines = cmd.trimEnd().split('\n');
    const MAX_LINES = 24;
    const MAX_CHARS = 2000;
    let kept = lines.slice(0, MAX_LINES).join('\n');
    if (kept.length > MAX_CHARS) kept = kept.slice(0, MAX_CHARS - 1) + '…';
    const hidden = lines.length - Math.min(lines.length, MAX_LINES);
    const body = hidden > 0 ? `${kept}\n… +${hidden} more line${hidden === 1 ? '' : 's'} (the transcript has it whole)` : kept;
    return { target: head, detail: desc, cmd: body };
  }
  if ((tool === 'Task' || tool === 'Agent')) {
    const desc = typeof i.description === 'string' ? i.description : typeof i.prompt === 'string' ? oneLine(i.prompt, 120) : '';
    return { target: desc || '(subagent)', detail: typeof i.subagent_type === 'string' ? i.subagent_type : undefined };
  }
  if (typeof i.pattern === 'string') return { target: i.pattern, detail: typeof i.path === 'string' ? i.path : typeof i.glob === 'string' ? i.glob : undefined };
  if (typeof i.url === 'string') return { target: i.url };
  if (typeof i.query === 'string') return { target: oneLine(i.query, 160) };
  if (tool === 'TodoWrite' && Array.isArray(i.todos)) {
    const inProg = i.todos.find((t: any) => t && t.status === 'in_progress');
    const active = inProg && typeof inProg.content === 'string' ? inProg.content : '';
    return { target: active ? oneLine(active, 160) : `${i.todos.length} to-do(s)`, detail: `${i.todos.length} item(s)` };
  }
  if (typeof i.skill === 'string') return { target: i.skill };
  if (tool === 'AskUserQuestion' && Array.isArray(i.questions) && i.questions[0] && typeof i.questions[0].question === 'string')
    return { target: oneLine(i.questions[0].question, 160), detail: i.questions.length > 1 ? `${i.questions.length} questions` : undefined };
  // Fallback: the first non-empty string field, else the tool name.
  for (const [, v] of Object.entries(i)) if (typeof v === 'string' && v.trim()) return { target: oneLine(v, 160) };
  return { target: '' };
}

/** Parse ISO (or epoch) timestamp → ms epoch, 0 when absent/unparseable. */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * Parse ONE transcript file (main session OR a subagent's subagents/*.jsonl) into its typed action
 * stream, in chronological order, each correlated with its tool_result (ok/isError). No store linkage
 * here — that's the caller's job (only the main session's edits map to store EditRecords). Zero token.
 *
 * `includeSidechain`: the main session skips inlined sidechain (subagent) turns so they don't
 * double-count; a subagent file is ENTIRELY sidechain records, so parsing it passes `true`.
 */
export function parseTranscriptActions(transcriptPath: string, opts?: { includeSidechain?: boolean }): ActionRecord[] {
  const includeSidechain = opts?.includeSidechain ?? false;
  // Attribution mutates records; the persisted facts never contain store-dependent edit IDs.
  return transcriptFacts(transcriptPath, includeSidechain).actions.actions.map((a) => ({ ...a }));
}

/** One assistant message's own words: its prose to the reader, or its thinking — as a record of its
 *  own rather than only the `reasoning` a later tool call carries forward. The feed lists these so a
 *  reply that called no tool (the answer that closes a turn) is a row and not a lost message. */
export interface ProseRecord {
  /** ms epoch of the message's transcript line (0 if it carried no timestamp). */
  ts: number;
  kind: 'text' | 'thinking';
  /** The message's text blocks joined (or its thinking blocks) — the exact string its tool calls
   *  carry as `reasoning`, so a renderer that prints reasoning only where it CHANGES never repeats
   *  this record under the call that follows it. */
  text: string;
}

export interface ActionFacts {
  actions: ActionRecord[];
  resultErr: Map<string, boolean>;
  byId: Map<string, number[]>;
  lastReasoning: string;
  lastReasoningKind: 'text' | 'thinking';
  proseIndex: ProseIndex[];
}

export function newActionFacts(): ActionFacts {
  return { actions: [], resultErr: new Map(), byId: new Map(), lastReasoning: '', lastReasoningKind: 'text', proseIndex: [] };
}

/** A prose row's location in the source, with no copy of its body in the shared facts. */
export interface ProseIndex {
  ts: number;
  kind: 'text' | 'thinking';
  offset: number;
  length: number;
}

/** The same join rule for carried reasoning and prose read from an indexed line. */
function assistantWords(o: any): { text: string; think: string } {
  let text = '', think = '';
  if (o?.message?.role !== 'assistant' || !Array.isArray(o.message.content)) return { text, think };
  for (const b of o.message.content) {
    if (b && b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text.trim();
    else if (b && b.type === 'thinking') {
      const th = typeof b.thinking === 'string' ? b.thinking : typeof b.text === 'string' ? b.text : '';
      if (th) think += (think ? '\n' : '') + th.trim();
    }
  }
  return { text, think };
}

/** Read only the selected source lines; two kinds from one message share a single read/parse. */
export function readTranscriptProse(transcriptPath: string, index: ProseIndex[]): ProseRecord[] {
  if (!index.length) return [];
  let fd: number;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return []; }
  try {
    const lines = new Map<number, ReturnType<typeof assistantWords>>();
    return index.map((p) => {
      let words = lines.get(p.offset);
      if (!words) {
        const buf = Buffer.alloc(p.length);
        let got = 0;
        while (got < buf.length) {
          const n = fs.readSync(fd, buf, got, buf.length - got, p.offset + got);
          if (!n) break;
          got += n;
        }
        try { words = assistantWords(JSON.parse(buf.subarray(0, got).toString('utf8'))); }
        catch { words = { text: '', think: '' }; }
        lines.set(p.offset, words);
      }
      return { ts: p.ts, kind: p.kind, text: p.kind === 'thinking' ? words.think : words.text };
    });
  } finally { fs.closeSync(fd); }
}

/** Fold one record; pending calls and reasoning survive complete-line cursor boundaries. */
export function foldActionFacts(state: ActionFacts, o: any, includeSidechain: boolean, offset: number, length: number): void {
  const { actions, resultErr, byId } = state;
  let { lastReasoning, lastReasoningKind } = state;
  // A compaction is a harness event, not a tool call: its record carries no `message` at all, so it
  // must be read BEFORE the message gate below. It earns a timeline row because losing context is
  // the single most consequential thing that happens to a session — everything above the boundary
  // was summarized away, which is why later turns can "forget" earlier work.
  if (o.isSidechain !== true || includeSidechain) {
    const ce = parseCompactLine(o);
    if (ce) {
      actions.push({
        ts: ce.ts,
        // Not a tool name: every surface prints `tool` verbatim, and "CompactBoundary" in that slot
        // reads as though Claude called it. The harness did this TO the session.
        tool: 'Compaction',
        category: 'compact',
        target: compactLabel(ce),
        detail: 'context compacted — earlier turns summarized',
        ok: true,
        isError: false,
        compact: ce,
      });
      return;
    }
  }

  const msg = o.message;
  if (!msg || !Array.isArray(msg.content)) return;

  // A subagent's own tool calls live in separate subagents/*.jsonl files (0.7.0); a legacy transcript
  // that inlines them (isSidechain) would double-count, so skip those unless we're parsing the
  // subagent file itself.
  if (o.isSidechain === true && !includeSidechain) return;

  if (msg.role === 'user') {
    for (const b of msg.content) {
      if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        resultErr.set(b.tool_use_id, !!b.is_error);
        for (const index of byId.get(b.tool_use_id) ?? []) {
          actions[index].isError = !!b.is_error;
          actions[index].ok = !b.is_error;
        }
      }
    }
    return;
  }
  if (msg.role !== 'assistant') return;

  // Carry the message's reasoning forward (Claude often explains in one message, acts in the next).
  const { text, think } = assistantWords(o);
  const reasoning = text || think;
  if (reasoning) {
    lastReasoning = reasoning;
    lastReasoningKind = text ? 'text' : 'thinking';
  }

  state.lastReasoning = lastReasoning;
  state.lastReasoningKind = lastReasoningKind;
  const ts = toMs(o.timestamp ?? o.ts);
  // The message's OWN words, as records: thinking first (it precedes the prose in the message, and in
  // time), then what it said. A reply with no tool call after it was otherwise on no surface.
  if (think) state.proseIndex.push({ ts, kind: 'thinking', offset, length });
  if (text) state.proseIndex.push({ ts, kind: 'text', offset, length });
  for (const b of msg.content) {
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
    const { target, detail, cmd } = targetOf(b.name, b.input);
    // Score the FULL command (not the truncated display target) for shell actions.
    const risk = b.name === 'Bash' && b.input && typeof b.input.command === 'string' ? scoreCommand(b.input.command) : null;
    const id = typeof b.id === 'string' ? b.id : undefined;
    if (id) byId.set(id, [...(byId.get(id) ?? []), actions.length]);
    actions.push({
      ts,
      tool: b.name,
      category: categoryOf(b.name),
      target,
      detail,
      cmd,
      plan: planFactsOf(b.name, b.input),
      ok: !(id && resultErr.get(id)),
      isError: id ? resultErr.get(id) ?? false : false,
      reasoning: lastReasoning || undefined,
      reasoningKind: lastReasoning ? lastReasoningKind : undefined,
      risk: risk ?? undefined,
      toolUseId: typeof b.id === 'string' ? b.id : undefined,
    });
  }
}

/**
 * Every tool call Claude made this session, in transcript (chronological) order, each correlated with
 * its result (ok/isError) and — for file-edit tools — the store EditRecord it produced. Zero token.
 */
/**
 * Boundary-crossing COUNTS for a session — how many distinct outside-the-worktree reads and writes its
 * transcript records — memoized on the transcript's (mtime,size) in the session-meta sidecar.
 *
 * This exists because the fleet needs exactly two integers per sibling and was paying a full transcript
 * parse for them: `parseActions` per sibling inside every ~3s tick measured 458MB of I/O and 88% of the
 * multitask view's CPU, ~97% of it siblings whose transcripts had not changed in days. The counts are a
 * pure function of (transcript content, worktree root) — `outsideReads`/`outsideWrites` read only each
 * action's category and target against the root — so the same stamp discipline the risk memo uses
 * (fleet.ts) makes a hit exact. `linkEditIds` is deliberately skipped: edit-id linkage cannot change
 * which paths lie outside the root.
 */
export function outsideCounts(cwd: string, sessionId: string): { reads: number; writes: number } {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return { reads: 0, writes: 0 };
  let stamp = '';
  try {
    const st = fs.statSync(transcript);
    // cwd is in the stamp because the SAME session replayed against a different root changes what
    // counts as "outside" — not a tick-to-tick concern, but stamps are cheap and wrong hits are not.
    stamp = `1|${st.mtimeMs}:${st.size}|${cwd}`;
  } catch {
    /* unreadable — compute without a cache */
  }
  // Lazy requires: egress/risk import the ActionRecord type from THIS module, so a top-level value
  // import back at them would be a require cycle whose safety depends on declaration order forever.
  const { outsideReads } = require('./egress') as typeof import('./egress');
  const { outsideWrites } = require('./risk') as typeof import('./risk');
  return sidecarMemo(sessionId, 'outside', stamp, () => {
    const actions = parseTranscriptActions(transcript, { includeSidechain: false });
    return { reads: outsideReads(actions, cwd).length, writes: outsideWrites(actions, cwd).length };
  });
}

export function parseActions(cwd: string, sessionId: string): ActionRecord[] {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return [];
  const actions = parseTranscriptActions(transcript, { includeSidechain: false });
  linkEditIds(cwd, sessionId, actions);
  return actions;
}

/** One file-editing author for honest editId attribution: the main chain (`agentId: null`) or a
 *  subagent. `edits` are that author's edit ActionRecords (any file) — mutated in place to get `editId`. */
export interface EditAttributionAuthor {
  agentId: string | null;
  edits: ActionRecord[];
}

/** [min, max] ts across a set of edit actions — this author's action-window on some file. */
function editWindow(acts: ActionRecord[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of acts) {
    if (a.ts < lo) lo = a.ts;
    if (a.ts > hi) hi = a.ts;
  }
  return [lo, hi];
}

/** Do any two of these ts-windows overlap (touching endpoints count)? Sweep after sorting by start. */
function windowsOverlap(windows: [number, number][]): boolean {
  const sorted = windows.slice().sort((a, b) => a[0] - b[0]);
  let maxEnd = -Infinity;
  for (const [lo, hi] of sorted) {
    if (lo <= maxEnd) return true;
    if (hi > maxEnd) maxEnd = hi;
  }
  return false;
}

/**
 * Attach store EditRecord ids to transcript edit actions across the main chain + subagents — HONESTLY
 * (§6). The store has no author column and same-file subagent + main-chain edits all land under one
 * parent session, so attribution is reconstructed post-hoc by (file, ts-window) alignment:
 *  - a file with a SINGLE author → positional linking of its store records (no ambiguity, common case);
 *  - MULTIPLE authors with DISJOINT windows → each subagent claims the records inside its window and
 *    the main chain claims the rest (a record outside every subagent window is main-chain's, §6.2);
 *  - MULTIPLE authors with OVERLAPPING/interleaved windows → the records CANNOT be partitioned, so
 *    BOTH sides are left null (→ unassigned, §6.3) — never positionally cross-attributed.
 * Mutates each author's `edits` (their `editId`). Bash actions carry no `editId` (no 1:1 store row).
 */
export function attributeEditIds(sessionId: string, authors: EditAttributionAuthor[]): void {
  const recsByFile = new Map<string, EditRecord[]>(); // resolved file -> its store edit records, append order
  for (const rec of readLog(sessionId)) {
    if (!EDIT_TOOLS.has(rec.tool)) continue; // only the 4 file tools have a 1:1 transcript tool_use
    const key = path.resolve(rec.file);
    if (!recsByFile.has(key)) recsByFile.set(key, []);
    recsByFile.get(key)!.push(rec);
  }
  if (recsByFile.size === 0) return;

  // Each author's edit actions, grouped by resolved file (transcript order).
  const perAuthor = authors.map((author) => {
    const byFile = new Map<string, ActionRecord[]>();
    for (const a of author.edits) {
      if (a.category !== 'edit') continue;
      const key = path.resolve(a.target);
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(a);
    }
    return { agentId: author.agentId, byFile };
  });

  for (const [file, recs] of recsByFile) {
    const fileAuthors = perAuthor
      .map((a) => ({ agentId: a.agentId, acts: a.byFile.get(file) }))
      .filter((a): a is { agentId: string | null; acts: ActionRecord[] } => !!a.acts && a.acts.length > 0);
    if (fileAuthors.length === 0) continue; // no transcript edit action for this file — leave null

    // Single author: positional over ALL of the file's store records (the common, unambiguous case).
    if (fileAuthors.length === 1) {
      const acts = fileAuthors[0].acts;
      for (let i = 0; i < recs.length && i < acts.length; i++) acts[i].editId = recs[i].id;
      continue;
    }

    // Multiple authors touched this file: partition by ts-window, or bail to null on any overlap.
    // BY DESIGN (0.8.0 stabilization review): genuinely interleaved same-file work stays unattributed on
    // BOTH sides rather than guessed — the null folds into the main-chain display bucket, and the strict-task
    // dimension is total regardless, so nothing disappears from the Overview. Pinned by a core test.
    const windows = fileAuthors.map((a) => editWindow(a.acts));
    if (windowsOverlap(windows)) continue; // interleaved/ambiguous → BOTH sides null (§6.3)

    const claimed = new Set<EditRecord>();
    fileAuthors.forEach((a, idx) => {
      if (a.agentId === null) return; // the main chain claims the leftovers below (§6.2)
      const [lo, hi] = windows[idx];
      const inWin = recs.filter((r) => r.ts >= lo && r.ts <= hi); // this subagent's window claims these
      for (let i = 0; i < inWin.length && i < a.acts.length; i++) {
        a.acts[i].editId = inWin[i].id;
        claimed.add(inWin[i]);
      }
    });
    const main = fileAuthors.find((a) => a.agentId === null);
    if (main) {
      const rest = recs.filter((r) => !claimed.has(r)); // records in no subagent window are main-chain's
      for (let i = 0; i < rest.length && i < main.acts.length; i++) main.acts[i].editId = rest[i].id;
    }
  }
}

/** Every subagent's parsed action stream (for editId windowing), from <subagents>/agent-*.jsonl. */
function subagentEditStreams(cwd: string, sessionId: string): EditAttributionAuthor[] {
  const dir = findSubagentsDir(cwd, sessionId);
  if (!dir) return [];
  let files: string[];
  try {
    files = derivedInventory(`action-subagents:${dir}`, () => fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')));
  } catch {
    return [];
  }
  return files.map((f) => ({
    agentId: f.replace(/^agent-/, '').replace(/\.jsonl$/, ''),
    edits: parseTranscriptActions(path.join(dir, f), { includeSidechain: true }),
  }));
}

/**
 * Link the MAIN chain's file-edit actions to their store EditRecord ids — subagent-aware (§6): a store
 * record inside a subagent's action window for that file belongs to the subagent, so the main chain
 * must not consume it, and an interleaved same-file overlap leaves both sides null (unassigned).
 */
export function linkEditIds(cwd: string, sessionId: string, actions: ActionRecord[]): void {
  attributeEditIds(sessionId, [{ agentId: null, edits: actions }, ...subagentEditStreams(cwd, sessionId)]);
}

// --- category grouping (the Actions view is grouped by kind; curated by default) ---

/** Display order for the category groups — high-signal kinds first. */
export const CATEGORY_ORDER: ActionCategory[] = ['edit', 'exec', 'web', 'agent', 'mcp', 'todo', 'compact', 'search', 'read', 'meta', 'other'];

/** Human labels for each category group header. */
export const CATEGORY_LABEL: Record<ActionCategory, string> = {
  edit: 'Edits',
  exec: 'Commands',
  read: 'Reads',
  search: 'Searches',
  web: 'Web',
  agent: 'Subagents',
  todo: 'To-dos',
  mcp: 'MCP',
  meta: 'Meta',
  compact: 'Compactions',
  other: 'Other',
};

/** Shown by default (the rest hide behind "show all"); errors always surface regardless of category. */
export const CURATED_CATEGORIES: ReadonlySet<ActionCategory> = new Set<ActionCategory>(['edit', 'exec', 'web', 'agent', 'mcp', 'todo', 'compact']);

export interface ActionGroup {
  category: ActionCategory;
  label: string;
  /** Total actions of this kind in the session. */
  count: number;
  /** How many of them errored. */
  errors: number;
  /** The rows to render: the whole category when shown, else only its errored rows (curated mode). */
  actions: ActionRecord[];
}

/**
 * Group actions by category in display order. Curated (default): high-signal categories show in full,
 * noisy ones (reads/searches/meta/other) contribute only their errored rows so a failure is never
 * hidden. `showAll` renders every category in full.
 */
export function buildActionGroups(actions: ActionRecord[], opts?: { showAll?: boolean }): ActionGroup[] {
  const showAll = opts?.showAll ?? false;
  const byCat = new Map<ActionCategory, ActionRecord[]>();
  for (const a of actions) {
    if (!byCat.has(a.category)) byCat.set(a.category, []);
    byCat.get(a.category)!.push(a);
  }
  const groups: ActionGroup[] = [];
  for (const cat of CATEGORY_ORDER) {
    const list = byCat.get(cat);
    if (!list || list.length === 0) continue;
    const errors = list.filter((a) => a.isError).length;
    const curated = showAll || CURATED_CATEGORIES.has(cat);
    const shown = curated ? list : list.filter((a) => a.isError); // noisy category: only failures leak through
    if (shown.length === 0) continue;
    groups.push({ category: cat, label: CATEGORY_LABEL[cat], count: list.length, errors, actions: shown });
  }
  return groups;
}

export interface ActionSummary {
  total: number;
  byCategory: Record<string, number>;
  errors: number;
  firstTs: number;
  lastTs: number;
}

/** Cheap headline counts for the timeline header / status. */
export function summarizeActions(actions: ActionRecord[]): ActionSummary {
  const byCategory: Record<string, number> = {};
  let errors = 0;
  for (const a of actions) {
    byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
    if (a.isError) errors++;
  }
  const ts = actions.map((a) => a.ts).filter((n) => n > 0);
  return {
    total: actions.length,
    byCategory,
    errors,
    firstTs: ts.length ? minOf(ts) : 0,
    lastTs: ts.length ? maxOf(ts) : 0,
  };
}

// --- live phase (0.8.0) ------------------------------------------------------------------------
// What is the agent in a transcript doing RIGHT NOW? A bounded, structural, zero-token read of only
// the transcript's TAIL (never the whole 20-34MB file) — it inspects just the trailing tool_use /
// tool_result / end_turn. Boundary-tolerant by construction: starting mid-file, it drops its first
// (partial) line, and a tool_result whose tool_use precedes the window is a harmless no-op delete.
// Some states have no structural marker (a harness permission prompt writes NOTHING to the transcript;
// there is no session-end record) and are inferred from staleness — surfaced via `confidence` as a
// labeled heuristic, never asserted as certain.

/** The live states a watcher surfaces. `awaiting-permission`/`idle`/`done` are staleness heuristics. */
export type Phase = 'working' | 'awaiting-input' | 'awaiting-permission' | 'idle' | 'errored' | 'done';
export type PhaseConfidence = 'high' | 'heuristic';
export interface PhaseResult {
  phase: Phase;
  /** 'high' = structural (pending AskUserQuestion, an error result, an active tool_use); 'heuristic' =
   *  staleness-derived (awaiting-permission / idle / done have no structural marker — inferred by mtime). */
  confidence: PhaseConfidence;
}

/** Tool_uses that block on the USER, not a tool_result — a pending one means the agent awaits input. */
const INPUT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** How many trailing bytes to read for the classification (the trailing records are tiny). */
const PHASE_TAIL_BYTES = 64 * 1024;
/** A tool_use awaiting its result with no append for this long reads as a (heuristic) permission block. */
const PERMISSION_STALE_MS = 10_000;
/** A completed turn with no append for this long reads as `done` (vs a recently-`idle` pause). */
const DONE_STALE_MS = 5 * 60_000;
/** A child agent transcript written within this window marks the session as actively working with
 *  HIGH confidence; older-but-under-DONE_STALE_MS child writes still count as working, heuristically
 *  (a child mid-long-turn appends nothing for minutes — same bound the main classifier uses). */
const CHILD_ACTIVE_MS = 30_000;

/** Newest mtime across the session's CHILD agent transcripts — subagents/*.jsonl plus every
 *  subagents/workflows/<wf>/*.jsonl — 0 when none. Background agents and workflow fleets keep
 *  working while the MAIN transcript idles (the spawning turn ended long ago), so the phase clock
 *  must include them or a live 50-agent run reads as `done` and gets filtered by "Active only". */
function newestChildActivityMs(transcriptPath: string): number {
  const subDir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let newest = 0;
  const scan = (dir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const m = fs.statSync(path.join(dir, name)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* file vanished between readdir and stat */
      }
    }
  };
  scan(subDir);
  let wfs: string[] = [];
  try {
    wfs = fs.readdirSync(path.join(subDir, 'workflows'));
  } catch {
    /* no workflow runs */
  }
  for (const wf of wfs) scan(path.join(subDir, 'workflows', wf));
  return newest;
}

/**
 * What is the agent in this transcript doing right now? Structural + zero-token — see the section note.
 * `agentPhase` returns just the label; `agentPhaseDetail` also reports whether it's a staleness heuristic.
 */
export function agentPhaseDetail(transcriptPath: string): PhaseResult {
  const idle: PhaseResult = { phase: 'idle', confidence: 'heuristic' }; // neutral fallback (no transcript)
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return idle;
  }
  const objs: any[] = [];
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - PHASE_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8', 0, n);
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // started mid-file: drop the partial line
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        objs.push(JSON.parse(t));
      } catch {
        // tolerate partial/non-JSON lines (schema evolves)
      }
    }
  } catch {
    return idle;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  // Walk the tail in order: track tool_uses still awaiting a result, and the kind of the trailing event.
  const pending = new Map<string, string>(); // tool_use_id -> tool name (no tool_result seen after it)
  let lastKind: 'result' | 'assistant_end' | 'none' = 'none';
  let lastResultErr = false;
  let nativeTurn: 'working' | 'done' | null = null;
  for (const o of objs) {
    if (o?.runtime === 'codex' && o.type === 'system') {
      if (o.subtype === 'task_started') { nativeTurn = 'working'; pending.clear(); lastKind = 'none'; }
      if (o.subtype === 'task_complete' || o.subtype === 'turn_aborted') {
        nativeTurn = 'done'; pending.clear(); lastKind = 'none';
      }
      continue;
    }
    if (o?.usageOnly) continue;
    const msg = o && o.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    if (msg.role === 'assistant') {
      let hadToolUse = false;
      for (const b of msg.content) {
        if (b && b.type === 'tool_use' && typeof b.name === 'string') {
          hadToolUse = true;
          if (typeof b.id === 'string') pending.set(b.id, b.name);
        }
      }
      if (!hadToolUse) lastKind = 'assistant_end'; // spoke and stopped (no tool call) => turn complete
    } else if (msg.role === 'user') {
      for (const b of msg.content) {
        if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          pending.delete(b.tool_use_id); // a tool_use before the window just no-ops (boundary-tolerant)
          lastKind = 'result';
          lastResultErr = !!b.is_error;
        }
      }
    }
  }

  // The activity clock spans the MAIN transcript and every child agent transcript: while a background
  // agent or workflow fleet churns, the session is alive no matter how stale the main file is. This is
  // also what keeps a turn with an async Agent tool_use pending from misreading as awaiting-permission.
  const childMs = newestChildActivityMs(transcriptPath);
  const age = Date.now() - Math.max(mtimeMs, childMs);
  const childAge = childMs > 0 ? Date.now() - childMs : Infinity;
  // Codex supplies explicit turn boundaries; quota events and old unfinished calls do not
  // override a terminal boundary. Claude continues to use its existing structural heuristics.
  if (nativeTurn === 'done' && childAge >= DONE_STALE_MS) return { phase: 'done', confidence: 'high' };
  // 1. A pending tool_use that blocks on the user => awaiting-input (structural).
  for (const name of pending.values()) {
    if (INPUT_TOOLS.has(name)) return { phase: 'awaiting-input', confidence: 'high' };
  }
  // 2. A pending (non-blocking) tool_use => the tool is running, OR the agent is blocked on a harness
  //    permission prompt (which writes NO transcript record) — disambiguated only by staleness (heuristic).
  if (pending.size > 0) {
    return age > PERMISSION_STALE_MS
      ? { phase: 'awaiting-permission', confidence: 'heuristic' }
      : { phase: 'working', confidence: 'high' };
  }
  // 3. No pending tool_use.
  //    a. A trailing error result => errored (structural).
  if (lastKind === 'result' && lastResultErr) return { phase: 'errored', confidence: 'high' };
  if (nativeTurn === 'working') return { phase: 'working', confidence: 'high' };
  //    b. A trailing (non-error) tool_result means the turn is UNFINISHED — a conversation can't end on a
  //       tool_result; it always obligates an assistant follow-up. So the agent is mid-turn (generating the
  //       next step), NOT idle. Fresh => working (structural, same as an active tool_use); long-stale =>
  //       the turn was abandoned mid-flight (crash/kill/interrupt) => done. This is what keeps the live
  //       session reading "working" between tool calls instead of flickering to idle after each result.
  if (lastKind === 'result') return age > DONE_STALE_MS ? { phase: 'done', confidence: 'heuristic' } : { phase: 'working', confidence: 'high' };
  //    c. The turn is COMPLETE (assistant spoke and stopped, or nothing in view) — but child agents
  //       still writing mean the session is working THROUGH its delegated agents, not resting.
  if (childAge < DONE_STALE_MS) {
    return { phase: 'working', confidence: childAge < CHILD_ACTIVE_MS ? 'high' : 'heuristic' };
  }
  //       Otherwise: recently => idle, long-stale => done (both staleness heuristics — there's no
  //       session-end record).
  return age > DONE_STALE_MS ? { phase: 'done', confidence: 'heuristic' } : idle;
}

/** The live phase of the agent in a transcript (label only; use `agentPhaseDetail` for confidence). */
export function agentPhase(transcriptPath: string): Phase {
  return agentPhaseDetail(transcriptPath).phase;
}

// --- chat-context assembler (0.8.0) ------------------------------------------------------------
// The single, zero-token backend for "chat about this action / edit / subagent / task" — assembles a
// ready-to-paste prompt (previously duplicated in both editors) so an editor just: build ← copy →
// hand to the user's Claude. It reads the store + transcript ONLY — never spawns a process, never
// calls a model (it must NOT touch analyze.ts's `claude -p`). This is also the review-context primitive.

/** How much of a shell command's result to carry (a Bash dump can be huge — the prompt stays paste-able). */
const RESULT_CONTEXT_MAX = 4000;

/** The tool_result text for one tool_use_id, from the transcript (for the exec command+result context).
 *  Handles both string and content-array result shapes; truncates a large output. Zero token, no spawn. */
function toolResultText(transcriptPath: string, toolUseId: string): string | null {
  let lines: string[];
  try {
    lines = readLines(transcriptPath);
  } catch {
    return null;
  }
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = o.message;
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b && b.type === 'tool_result' && b.tool_use_id === toolUseId) {
        const text =
          typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c: any) => (c && typeof c.text === 'string' ? c.text : '')).join('')
              : '';
        const trimmed = text.trim();
        return trimmed.length > RESULT_CONTEXT_MAX ? trimmed.slice(0, RESULT_CONTEXT_MAX) + '\n…(truncated)' : trimmed;
      }
    }
  }
  return null;
}

/** The todo CONTENT whose stable taskId matches, scanned from the transcript's TodoWrite entries, so the
 *  framing names the task instead of its opaque hash. null when no todo hashes to it. Zero token. */
function taskContentFor(transcriptPath: string, wantTaskId: string): string | null {
  let lines: string[];
  try {
    lines = readLines(transcriptPath);
  } catch {
    return null;
  }
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = o.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
        for (const td of b.input.todos) {
          if (td && typeof td.content === 'string') {
            const content = td.content.trim();
            if (content && taskId(content, 0) === wantTaskId) return content; // firstSeenTs is not hashed
          }
        }
      }
    }
  }
  return null;
}

/** A subagent's human label (agentType/description) from its meta.json sidecar; the raw id when absent. */
function subagentLabel(cwd: string, sessionId: string, agentId: string): string {
  const dir = findSubagentsDir(cwd, sessionId);
  if (dir) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'));
      const type = o && typeof o.agentType === 'string' ? o.agentType : '';
      const desc = o && typeof o.description === 'string' ? o.description : '';
      const label = [type, desc].filter(Boolean).join(': ');
      if (label) return label;
    } catch {
      /* no sidecar (async_launched spawns often lack one) — fall back to the id */
    }
  }
  return agentId;
}

/** What a chat-context prompt can be built about: one action/edit (by `toolUseId` — stable per-action —
 *  or store `editId`), optionally framed by the `agentId`/`taskId` it belonged to. `agentId`/`taskId`
 *  can also stand alone to ask about a whole subagent or task. */
export interface ChatContextRef {
  toolUseId?: string;
  editId?: number;
  agentId?: string;
  taskId?: string;
}

/**
 * Assemble a ready-to-paste, ZERO-TOKEN chat prompt about one action / edit / subagent / task (§2.6/§7):
 * the target/file, Claude's OWN reasoning for that call, the before/after blobs (edit, from the store) or
 * command+result (exec, from the transcript), plus task/subagent framing ("part of task X run by subagent
 * Y"). Reads plain files only — NEVER spawns a process or calls a model (must not touch analyze.ts). This
 * is the single backend both editors call in place of their duplicated prompt builders.
 *
 * Deviation from the blueprint's `(session, ref)` shorthand: takes `cwd` first, matching the module's
 * `(cwd, sessionId, …)` convention — the transcript and subagent files are located from `cwd` (same
 * reason S4's `subagentTodos` added `cwd`). CLI/editors pass their working dir.
 */
export function assembleChatContext(cwd: string, session: string, ref: ChatContextRef): string {
  const parts: string[] = [];

  // Resolve the primary action/edit (if any) from the transcript's typed action stream (whole-file
  // parse + editId linking — pure fs reads, no spawn). Empty when there's no transcript; a store-only
  // editId ref still works below via findRecord.
  const actions = parseActions(cwd, session);
  let action: ActionRecord | undefined;
  if (ref.toolUseId) action = actions.find((a) => a.toolUseId === ref.toolUseId);
  else if (ref.editId != null) action = actions.find((a) => a.editId === ref.editId);

  // The store record for before/after blobs: an explicit editId, else the resolved action's editId.
  const editId = ref.editId != null ? ref.editId : action?.editId;
  const rec = editId != null ? findRecord(session, editId) : null;

  const transcript = findTranscript(cwd, session);

  // --- header: what this is about (primary action/edit, else a whole subagent/task, else the session) ---
  if (action) {
    parts.push(`I'm reviewing a ${action.tool} action Claude Code took in this session: ${action.target}`);
  } else if (rec) {
    parts.push(`I'm reviewing an edit Claude Code made to \`${rec.file}\` (edit #${rec.id}, ${rec.tool}).`);
  } else if (ref.agentId) {
    parts.push(`I'm reviewing the work of subagent ${subagentLabel(cwd, session, ref.agentId)} in this Claude Code session.`);
  } else if (ref.taskId) {
    const content = transcript ? taskContentFor(transcript, ref.taskId) : null;
    parts.push(`I'm reviewing the task "${content ?? ref.taskId}" in this Claude Code session.`);
  } else {
    parts.push(`I'm reviewing this Claude Code session.`);
  }

  // --- Claude's OWN reasoning for the call (the assistant text/thinking that preceded it) ---
  if (action?.reasoning) parts.push(`Claude's own reasoning for this:\n${action.reasoning}`);

  // --- the evidence: before/after (edit, from the store) or command+result (exec, from the transcript) ---
  if (rec) {
    const before = rec.beforeBlob ? readBlob(session, rec.beforeBlob).toString('utf8') : '(new file)';
    const after = rec.afterBlob ? readBlob(session, rec.afterBlob).toString('utf8') : '(deleted)';
    parts.push(`--- before ---\n${before}\n--- after ---\n${after}`);
  } else if (action && action.category === 'exec') {
    const result = action.toolUseId && transcript ? toolResultText(transcript, action.toolUseId) : null;
    parts.push(`--- command ---\n${action.target}\n--- result ---\n${result ?? '(no result captured)'}`);
  }

  // --- task / subagent framing (supplementary — only when the prompt is about a primary action/edit) ---
  if (action || rec) {
    const framing: string[] = [];
    if (ref.taskId) {
      const content = transcript ? taskContentFor(transcript, ref.taskId) : null;
      framing.push(`part of task "${content ?? ref.taskId}"`);
    }
    if (ref.agentId) framing.push(`run by subagent ${subagentLabel(cwd, session, ref.agentId)}`);
    if (framing.length) parts.push(`For context, this action was ${framing.join(' ')}.`);
  }

  parts.push(`Please explain what this does and whether it looks correct.`);
  return parts.join('\n\n');
}
