/**
 * A transcript-backed conversation stream for the shared conversation renderer.
 *
 * Claude transcripts and Codex's derived transcripts share the message/tool envelope. The action
 * parser remains the authority for tool classification, result status and edit attribution; this
 * adapter adds the conversational records around that action stream (prompts, prose, thought,
 * usage and turn boundaries). Incremental reads keep numeric byte cursors for the three consumers;
 * the preceding turn is silently replayed to restore state before emitting appended JSONL records.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ActionRecord, categoryOf, attributeEditIds, targetOf } from './actions';
import { num, toMs, transcriptForSession, userPrompt } from './asks';
import { findCodexRollout } from './codex';
import { StringDecoder } from 'string_decoder';
import { createHash } from 'crypto';
import { findSubagentsDir } from './subagents';
import { hookPermissionEntries } from './feed';
import { findTranscript } from './observe';
import { firstCwdLine } from './session';
import { EditRecord, readLog, rootDir, isSafeSessionId, logPath } from './store';

type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';
interface ToolUpdate {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: { path: string; line?: number }[];
  content?: { type: 'content'; content: { type: 'text'; text: string } }[];
  editId?: number;
}

export interface UserPromptUpdate {
  sessionUpdate: 'user_prompt';
  content: { type: 'text'; text: string };
  promptId?: string;
}

export interface TurnEndUpdate {
  sessionUpdate: 'turn_end';
  stopReason: string;
  edits: number;
  ts: number;
  records: { id: number; file: string; partial: boolean }[];
}

/** Transcript tool calls may carry their attributed store record for the detail renderer. */
export type ConversationUpdate =
  | { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'; content: { type: 'text'; text: string } }
  | ({ sessionUpdate: 'tool_call'; title: string } & ToolUpdate)
  | ({ sessionUpdate: 'tool_call_update' } & ToolUpdate)
  | { sessionUpdate: 'plan'; entries: { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { sessionUpdate: 'usage_update'; used: number; size: number }
  | UserPromptUpdate
  | TurnEndUpdate;

export interface ConversationEvent {
  ts: number;
  update: ConversationUpdate;
}

export interface ConversationOptions {
  root?: string;
  /** Turns, not events: an INITIAL read answers the last `limit` turns (default [DEFAULT_TURN_LIMIT]).
   *  An incremental `since` read ignores it and delivers every appended record. */
  limit?: number;
  since?: number;
  /** Optional cross-process identity for readers without a captured-store checkpoint. */
  source?: string;
  includeSource?: boolean;
}

export interface ConversationResult {
  events: ConversationEvent[];
  /** Turns delivered in `events` — `truncated` says whether older ones exist above the window. */
  turns: number;
  agent: 'claude' | 'codex' | string;
  transcriptPath: string | null;
  cursor: number | null;
  /** Bytes of transcript before the first delivered record, i.e. what the turn window cut (0 when the
   *  whole transcript is included, and 0 on an incremental read, which cuts nothing). */
  truncated: number;
  /** The transcript was REPLACED, not appended to: everything the consumer holds for this session is
   *  obsolete. `events` is a fresh bounded window from the new source — replace, never append. */
  reset?: boolean;
  source?: string;
}

const DEFAULT_TURN_LIMIT = 50;
const TEXT_LINE_LIMIT = 8192;
const THOUGHT_LIMIT = 2000;

interface InternalEvent extends ConversationEvent {
  turn: number;
  offset?: number;
}

interface ReadRange {
  start: number;
  cursor: number;
}

/** Read only complete JSONL records. A torn tail remains behind the returned cursor for the retry. */
function readRange(file: string, since: number): ReadRange | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  let start = Number.isSafeInteger(since) && since >= 0 && since <= st.size ? since : 0;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    // A caller-provided cursor need not be one we returned. Drop its partial first record instead of
    // interpreting a suffix as JSON; returned cursors are already newline boundaries and skip this.
    if (start > 0) {
      const previous = Buffer.alloc(1);
      fs.readSync(fd, previous, 0, 1, start - 1);
      if (previous[0] !== 0x0a) {
        const probe = Buffer.alloc(Math.min(64 * 1024, st.size - start));
        const n = fs.readSync(fd, probe, 0, probe.length, start);
        const nl = probe.subarray(0, n).indexOf(0x0a);
        if (nl < 0) return { start, cursor: start };
        start += nl + 1;
      }
    }
    // Locate the last complete line without allocating the whole suffix. Forward parsing below
    // streams fixed-size chunks and releases each source line as soon as its updates are built.
    let end = st.size;
    if (end > start) {
      const last = Buffer.alloc(1);
      if (fs.readSync(fd, last, 0, 1, end - 1) === 1 && last[0] === 0x0a) return { start, cursor: end };
    }
    while (end > start) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, end - start));
      end -= buffer.length;
      const n = fs.readSync(fd, buffer, 0, buffer.length, end);
      const nl = buffer.subarray(0, n).lastIndexOf(0x0a);
      if (nl >= 0) return { start, cursor: end + nl + 1 };
    }
    return { start, cursor: start };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already gone */
    }
  }
}

function* rangeLines(file: string, range: ReadRange): Generator<string> {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let position = range.start, carry = '';
  try {
    while (position < range.cursor) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, range.cursor - position), position);
      if (!n) break;
      position += n;
      carry += decoder.write(buffer.subarray(0, n));
      let start = 0, end: number;
      while ((end = carry.indexOf('\n', start)) >= 0) {
        yield carry.slice(start, end);
        start = end + 1;
      }
      carry = carry.slice(start);
    }
  } finally { fs.closeSync(fd); }
}

/** Backwards JSONL walk. Keep bytes until a whole line is available, including split UTF-8.
 * Tool results can cross prompt boundaries: continue to their calls before cutting the suffix. */
function turnStartBefore(file: string, cursor: number, limit = 1): number {
  const fd = fs.openSync(file, 'r');
  try {
    let position = cursor;
    let partial = Buffer.alloc(0);
    let prompts = 0;
    let boundary = cursor;
    let complete = false;
    const needed = new Set<string>();
    while (position > 0) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, position));
      position -= chunk.length;
      if (fs.readSync(fd, chunk, 0, chunk.length, position) !== chunk.length) return 0;
      const bytes = Buffer.concat([chunk, partial]);
      let end = bytes.length;
      while (end > 0) {
        const previous = bytes.lastIndexOf(0x0a, end - 1);
        if (previous < 0 && position > 0) break;
        if (complete) {
          const text = bytes.toString('utf8', previous + 1, end);
          try {
            const row = JSON.parse(text);
            if (row && !Array.isArray(row) && row.isSidechain !== true) {
              const blocks = row.message?.content;
              if (Array.isArray(blocks)) for (const block of blocks) {
                if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') needed.add(block.tool_use_id);
                if (block?.type === 'tool_use' && typeof block.id === 'string') needed.delete(block.id);
              }
              if (userPrompt(row) !== null) {
                prompts++;
                if (prompts >= limit) {
                  boundary = position + previous + 1;
                  if (!needed.size) return boundary;
                }
              }
            }
          } catch { /* malformed complete records cannot hide an earlier prompt */ }
        }
        complete = true; // the first fragment is the torn tail, never a complete record
        end = previous;
      }
      partial = bytes.subarray(0, Math.max(0, end));
    }
    return 0;
  } finally { fs.closeSync(fd); }
}

interface ResumeState {
  active: { turn: number; promptTs: number; lastTs: number; lastOffset: number; stopReason: string; pending: string[]; lastWasAnswer: boolean } | null;
  nextTurn: number;
  lastTurn: number;
  tools: [string, ActionRecord][];
  planIds: string[];
  seenUsage: string[];
}
interface Checkpoint {
  version: 1;
  guard: string;
  file: string;
  root: string;
  ino: number;
  size: number;
  mtimeMs: number;
  cursor: number;
  state: ResumeState;
}
const checkpoints = new Map<string, Checkpoint>();
function checkpointPath(session: string): string | null {
  return isSafeSessionId(session) ? path.join(rootDir(), 'changemap-cache', session, 'conversation.json') : null;
}
/** Fixed-size prefix + cursor guards reject rewritten files while keeping append work bounded. */
function cursorGuard(file: string, cursor: number): string {
  const fd = fs.openSync(file, 'r');
  const size = Math.min(64, cursor);
  const buffer = Buffer.alloc(size * 2);
  try {
    fs.readSync(fd, buffer, 0, size, 0);
    fs.readSync(fd, buffer, size, size, cursor - size);
    return buffer.toString('base64');
  } finally { fs.closeSync(fd); }
}
/** The resumable checkpoint for `cursor`, or WHY there is none. A missing checkpoint (a cold process,
 *  an uncaptured session) is not the same as a transcript that was rewritten under a live cursor: the
 *  first can continue from the byte position, the second has no continuation at all. Only evidence
 *  sets `replaced` — a cursor past EOF, or a checkpoint whose guards no longer match the source. */
function resume(file: string, session: string, cursor: number): { hit: Checkpoint | null; replaced: boolean } {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { hit: null, replaced: false }; }
  // A cursor this reader returned always pointed at a record boundary inside the file it came from.
  if (cursor > size) return { hit: null, replaced: true };
  const cache = checkpointPath(session);
  let hit = checkpoints.get(file);
  if (!hit && cache) {
    try { hit = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* cold or torn cache */ }
  }
  if (!hit || hit.version !== 1 || hit.file !== file || hit.cursor !== cursor || !hit.state
    || !Array.isArray(hit.state.tools) || !Array.isArray(hit.state.planIds) || !Array.isArray(hit.state.seenUsage)
    || (hit.state.active && !Array.isArray(hit.state.active.pending))) return { hit: null, replaced: false };
  const st = fs.statSync(file);
  if (st.ino !== hit.ino || st.size < hit.size || (st.size === hit.size && st.mtimeMs !== hit.mtimeMs)
    || hit.guard !== cursorGuard(file, cursor)) return { hit: null, replaced: true };
  return { hit, replaced: false };
}
function checkpoint(file: string, session: string, root: string, cursor: number, state: ResumeState): void {
  const st = fs.statSync(file);
  const value: Checkpoint = { version: 1, guard: cursorGuard(file, cursor), file, root, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, cursor, state };
  if (checkpoints.size >= 8) checkpoints.delete(checkpoints.keys().next().value!);
  checkpoints.set(file, value);
  const cache = checkpointPath(session);
  // Dropped/uncaptured sessions must not be resurrected by a read.
  if (!cache || !fs.existsSync(logPath(session))) return;
  try {
    fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
    const tmp = `${cache}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, cache);
  } catch { /* the numeric cursor still works by replaying its preceding turn */ }
}

/** Attribution is positional across the entire main chain, including earlier turns. Read compact
 * edit facts only when a captured session needs them; never retain historical prose/tool output.
 * attributeEditIds remains the authority for subagent overlap and unassigned records. */
function editActions(file: string, session: string, includeSidechain = false): ActionRecord[] {
  const stat = fs.statSync(file);
  const cache = isSafeSessionId(session) ? path.join(rootDir(), 'changemap-cache', session, `conversation-edits-${createHash('sha256').update(file).digest('hex').slice(0, 16)}.json`) : null;
  let out: ActionRecord[] = [], cursor = 0;
  if (cache) try {
    const old = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (old.version === 1 && old.file === file && old.ino === stat.ino && old.size <= stat.size
      && (old.size !== stat.size || old.mtimeMs === stat.mtimeMs) && Array.isArray(old.actions)
      && Number.isSafeInteger(old.cursor) && old.cursor >= 0 && old.cursor <= old.size && old.guard === cursorGuard(file, old.cursor)) {
      out = old.actions;
      cursor = old.cursor;
    }
  } catch { /* absent or invalid: rebuild the compact index */ }
  let position = cursor;
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(64 * 1024);
  let carry = '';
  try {
    let n: number;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      position += n;
      carry += decoder.write(buffer.subarray(0, n));
      let start = 0, end: number;
      while ((end = carry.indexOf('\n', start)) >= 0) {
        const line = carry.slice(start, end);
        start = end + 1;
        if (!/"name"\s*:\s*"(?:Edit|Write|MultiEdit|NotebookEdit|apply_patch)"/.test(line) && !line.includes('\\u')) continue;
        try {
          const row = JSON.parse(line);
          if (!row || (!includeSidechain && row.isSidechain === true) || row.message?.role !== 'assistant' || !Array.isArray(row.message.content)) continue;
          for (const block of row.message.content) if (block?.type === 'tool_use' && typeof block.name === 'string' && categoryOf(block.name) === 'edit')
            out.push(actionFromBlock(block, toMs(row.timestamp ?? row.ts)));
        } catch { /* torn or non-object record */ }
      }
      cursor += Buffer.byteLength(carry.slice(0, start));
      carry = carry.slice(start);
    }
  } finally { fs.closeSync(fd); }
  if (cache && fs.existsSync(logPath(session))) try {
    fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
    const tmp = `${cache}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, file, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, cursor, guard: cursorGuard(file, cursor), actions: out }), { mode: 0o600 });
    fs.renameSync(tmp, cache);
  } catch { /* exact attribution still works without persistence */ }
  return out;
}

function boundText(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.length > TEXT_LINE_LIMIT
        ? `${line.slice(0, TEXT_LINE_LIMIT)} …(+${Math.round((line.length - TEXT_LINE_LIMIT) / 1024)}k chars)`
        : line
    )
    .join('\n');
}

function boundThought(text: string): string {
  const one = text.replace(/\s+/g, ' ');
  return one.length > THOUGHT_LIMIT ? `${one.slice(0, THOUGHT_LIMIT)}…` : one;
}

function toolKind(a: ActionRecord): ToolKind {
  switch (a.category) {
    case 'edit':
      return 'edit';
    case 'exec':
      return 'execute';
    case 'read':
      return 'read';
    case 'search':
      return 'search';
    case 'web':
      return 'fetch';
    default:
      return 'other';
  }
}

function actionFromBlock(block: any, ts: number): ActionRecord {
  const tool = String(block?.name ?? 'tool');
  const { target, detail, cmd } = targetOf(tool, block?.input);
  const input = block?.input;
  const subject = (tool === 'TaskCreate' || (tool === 'TaskUpdate' && input?.taskId != null))
    && typeof input?.subject === 'string' ? input.subject.trim() : '';
  return {
    ts,
    tool,
    category: categoryOf(tool),
    target,
    detail,
    cmd,
    ok: true,
    isError: false,
    plan: subject ? { subject, status: tool === 'TaskCreate' ? 'created' : input?.status } : undefined,
    toolUseId: typeof block?.id === 'string' ? block.id : undefined,
  };
}

function titleOf(a: ActionRecord): string {
  return a.target ? `${a.tool} ${a.target}` : a.tool;
}

function resultContent(content: unknown): { type: 'content'; content: { type: 'text'; text: string } }[] {
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block && typeof block.content === 'string') texts.push(block.content);
    }
  }
  return texts
    .map((text) => boundText(text))
    .filter(Boolean)
    .map((text) => ({ type: 'content' as const, content: { type: 'text' as const, text } }));
}

function planEntries(input: any, a: ActionRecord): { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }[] {
  if (Array.isArray(input?.todos)) {
    return input.todos
      .filter((todo: any) => todo && typeof todo.content === 'string' && todo.content.trim())
      .map((todo: any) => ({
        content: todo.content.trim(),
        priority: todo.priority === 'high' || todo.priority === 'low' ? todo.priority : 'medium',
        status: todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
      }));
  }
  if (!a.plan?.subject) return [];
  const status = a.plan.status === 'completed' || a.plan.status === 'in_progress' ? a.plan.status : 'pending';
  return [{ content: a.plan.subject, priority: 'medium', status }];
}

function editRecords(session: string): EditRecord[] {
  try {
    return readLog(session);
  } catch {
    return [];
  }
}

function agentName(session: string): string {
  return findCodexRollout(session) ? 'codex' : 'claude';
}

// The hook pairing the feed uses: one function, so the two surfaces cannot disagree about an answer.
interface PermissionRow { ts: number; kind: string; label: string; target?: string; ok?: boolean }

/** Adapt permission sidecar rows without reading the conversation again. */
function permissionEvents(root: string, session: string, minTs: number, maxTs: number, turnForTs: (ts: number) => number): InternalEvent[] {
  let rows: PermissionRow[] = [];
  try {
    rows = hookPermissionEntries(session);
  } catch {
    return [];
  }
  const out: InternalEvent[] = [];
  const pending = new Map<string, string[]>();
  let serial = 0;
  for (const row of rows) {
    if (row.ts < minTs || row.ts > maxTs) continue;
    const target = row.target || 'tool call';
    if (row.label === 'permission asked') {
      const id = `permission-${row.ts}-${serial++}`;
      const queue = pending.get(target) ?? [];
      queue.push(id);
      pending.set(target, queue);
      out.push({
        ts: row.ts,
        turn: turnForTs(row.ts),
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: `permission asked: ${target}`,
          kind: 'other',
          status: row.ok === true ? 'completed' : 'pending',
          rawInput: { permission: true, target },
        },
      });
      continue;
    }
    if (!row.label.startsWith('permission answered:')) continue;
    const queue = pending.get(target) ?? [];
    const id = queue.shift() ?? `permission-${row.ts}-${serial++}`;
    out.push({
      ts: row.ts,
      turn: turnForTs(row.ts),
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        title: row.label,
        kind: 'other',
        status: 'completed',
      },
    });
  }
  return out;
}

function buildConversation(session: string, opts: ConversationOptions): ConversationResult {
  const transcript = (opts.root ? findTranscript(opts.root, session) : null) ?? transcriptForSession(session);
  if (!transcript) return { events: [], turns: 0, agent: agentName(session), transcriptPath: null, cursor: null, truncated: 0 };
  const since = Number.isSafeInteger(opts.since) && (opts.since ?? 0) >= 0 ? opts.since! : 0;
  const state = since > 0 ? resume(transcript, session, since) : null;
  // A rewritten transcript is a different conversation: the bytes past `since` continue nothing the
  // consumer holds. Answer the fresh bounded window and SAY so, so the aggregate is replaced rather
  // than a new answer being appended under the previous prompt.
  if (state?.replaced) return { ...buildConversation(session, { ...opts, since: 0 }), reset: true };
  const saved = state?.hit ?? null;
  const root = opts.root ?? saved?.root ?? firstCwdLine(transcript)?.cwd ?? process.cwd();
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit!)) : DEFAULT_TURN_LIMIT;
  const start = since > 0 ? since : turnStartBefore(transcript, fs.statSync(transcript).size, limit);
  let range = readRange(transcript, start);
  if (!range) return { events: [], turns: 0, agent: agentName(session), transcriptPath: transcript, cursor: null, truncated: 0 };
  if (range.cursor === range.start) return { events: [], turns: 0, agent: agentName(session), transcriptPath: transcript, cursor: range.cursor, truncated: since > 0 ? 0 : range.start };
  const emittedSince = since > 0 ? range.start : 0;
  if (emittedSince > 0 && !saved) {
    const before = turnStartBefore(transcript, emittedSince);
    if (before < emittedSince) range = readRange(transcript, before) ?? range;
  }

  const localActions: ActionRecord[] = [];
  const toolEvents = new Map<string, InternalEvent>();
  const tools = new Map<string, ActionRecord>(saved?.state.tools);
  const planIds = new Set<string>(saved?.state.planIds);
  const seenUsage = new Set<string>(saved?.state.seenUsage);
  const records = editRecords(session);
  const agent = agentName(session);
  const events: InternalEvent[] = [];
  const promptStarts: { turn: number; ts: number }[] = [];
  let nextTurn = saved?.state.nextTurn ?? 0;
  let active: (Omit<NonNullable<ResumeState['active']>, 'pending'> & { pending: Set<string> }) | null = saved?.state.active ? { ...saved.state.active, pending: new Set(saved.state.active.pending) } : null;
  let lastTurn = saved?.state.lastTurn ?? -1;
  let offset = range.start;
  let eventOffset = offset;
  let replaying = offset < emittedSince;

  const currentTurn = (): number => active?.turn ?? lastTurn;
  const push = (ts: number, update: ConversationUpdate): InternalEvent => {
    const e = { ts, turn: currentTurn(), update, offset: eventOffset };
    events.push(e);
    return e;
  };
  const finish = (ts: number, stopReason: string, beforeTs?: number, sourceOffset = eventOffset): void => {
    if (!active) return;
    const at = ts || active.lastTs || active.promptTs;
    const own = records.filter((r) => r.ts >= active!.promptTs && r.ts < (beforeTs ?? at));
    events.push({
      ts: at,
      turn: active.turn,
      offset: sourceOffset,
      update: {
        sessionUpdate: 'turn_end',
        stopReason,
        edits: own.length,
        ts: at,
        records: own.map((r) => ({ id: r.id, file: r.file, partial: r.partial === true })),
      },
    });
    lastTurn = active.turn;
    active = null;
  };

  for (const line of rangeLines(transcript, range)) {
    eventOffset = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
    if (replaying && eventOffset >= emittedSince) {
      // Reproduce the prior read's inferred Claude completion before processing new records.
      if (agent === 'claude' && active && active.lastWasAnswer && active.pending.size === 0) finish(active.lastTs, active.stopReason, undefined, active.lastOffset);
      replaying = false;
    }
    const text = line.trim();
    if (!text) continue;
    let o: any;
    try {
      o = JSON.parse(text);
    } catch {
      continue;
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o) || o.isSidechain === true) continue;
    const ts = toMs(o.timestamp ?? o.ts);
    const prompt = userPrompt(o);
    if (prompt !== null) {
      if (active) finish(active.lastTs, active.stopReason || 'end_turn', ts || active.lastTs);
      const turn = nextTurn++;
      lastTurn = turn;
      active = { turn, promptTs: ts, lastTs: ts, lastOffset: eventOffset, stopReason: 'end_turn', pending: new Set(), lastWasAnswer: false };
      promptStarts.push({ turn, ts });
      const promptId = typeof o.uuid === 'string' ? o.uuid : typeof o.nativeTurnId === 'string' ? o.nativeTurnId : undefined;
      events.push({
        ts,
        turn,
        offset: eventOffset,
        update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: prompt }, ...(promptId ? { promptId } : {}) },
      });
    }

    const message = o.message;
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      if (active) { active.lastTs = ts || active.lastTs; active.lastOffset = eventOffset; }
      let answerOnLine = false;
      for (const block of message.content) {
        if (block?.type === 'thinking') {
          const thought = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
          if (thought) push(ts, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: boundThought(thought) } });
          continue;
        }
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          answerOnLine = true;
          push(ts, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: boundText(block.text) } });
          continue;
        }
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const id = typeof block.id === 'string' ? block.id : `tool-${ts}-${localActions.length}`;
        const a = actionFromBlock(block, ts);
        localActions.push(a);
        tools.set(id, a);
        active?.pending.add(id);
        if (a.category === 'todo') {
          planIds.add(id);
          const entries = planEntries(block.input, a);
          if (entries.length) push(ts, { sessionUpdate: 'plan', entries });
          continue;
        }
        const update: Extract<ConversationUpdate, { sessionUpdate: 'tool_call' }> = {
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: titleOf(a),
          kind: toolKind(a),
          status: 'pending',
          rawInput: block.input ?? {},
          ...(typeof a.editId === 'number' ? { editId: a.editId } : {}),
        };
        toolEvents.set(id, push(ts, update));
      }
      if (active) active.lastWasAnswer = answerOnLine && active.pending.size === 0;

      const usage = message.usage;
      if (usage && typeof usage === 'object') {
        const key = typeof message.id === 'string' ? message.id : `usage-${ts}-${events.length}`;
        if (!seenUsage.has(key)) {
          seenUsage.add(key);
          const input = num(usage.input_tokens);
          const cacheRead = num(usage.cache_read_input_tokens);
          const cacheCreation = num(usage.cache_creation_input_tokens);
          const explicitUsed = num(o.contextTokens ?? o.context_tokens ?? usage.context_tokens);
          const used = explicitUsed || input + cacheRead + cacheCreation;
          const explicitSize = num(o.modelContextWindow ?? o.model_context_window ?? message.modelContextWindow ?? message.model_context_window);
          const size = explicitSize || (used > 200_000 ? 1_000_000 : 200_000);
          push(ts, { sessionUpdate: 'usage_update', used, size });
        }
      }

      const stop = String(message.stop_reason ?? o.stopReason ?? o.stop_reason ?? '');
      if (active && stop && stop !== 'tool_use' && stop !== 'pause_turn') {
        active.stopReason = stop;
        finish(ts, stop);
      }
    } else if (message?.role === 'user' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const id = block.tool_use_id;
        active?.pending.delete(id);
        if (planIds.has(id)) continue;
        const a = tools.get(id);
        const failed = block.is_error === true || a?.isError === true;
        const content = resultContent(block.content);
        push(ts, {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          ...(a ? { title: titleOf(a), kind: toolKind(a) } : {}),
          status: failed ? 'failed' : 'completed',
          ...(content.length ? { content } : {}),
        });
        if (active) active.lastWasAnswer = false;
      }
    }

    if (o.subtype === 'task_complete') finish(ts, 'end_turn');
    else if (o.subtype === 'turn_aborted') finish(ts, 'cancelled');
  }

  if (records.length && (since === 0 || localActions.some(a => a.category === 'edit'))) {
    // Prime compact facts on the initial read, even if this window has no edit calls. A later
    // two-kilobyte append with an edit must not be the first request that scans its old history.
    const edits = editActions(transcript, session);
    try {
      const dir = findSubagentsDir(root, session);
      const authors = dir ? fs.readdirSync(dir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl')).map(f => ({
        agentId: f.replace(/^agent-/, '').replace(/\.jsonl$/, ''), edits: editActions(path.join(dir, f), session, true),
      })) : [];
      attributeEditIds(session, [{ agentId: null, edits }, ...authors]);
    } catch { /* a torn store leaves ids absent */ }
    const ids = new Map(edits.map(a => [a.toolUseId, a.editId]));
    for (const a of localActions) a.editId = ids.get(a.toolUseId);
  }
  for (const a of localActions) {
    if (typeof a.editId !== 'number' || !a.toolUseId) continue;
    const e = toolEvents.get(a.toolUseId);
    if (e?.update.sessionUpdate === 'tool_call') e.update.editId = a.editId;
  }
  // Claude's final prose is a structural end even on transcript versions that omit stop_reason.
  // A pending tool result is deliberately not: the agent can still be working beyond this cursor.
  if (agent === 'claude' && active && active.lastWasAnswer && active.pending.size === 0) finish(active.lastTs, active.stopReason || 'end_turn', undefined, active.lastOffset);

  checkpoint(transcript, session, root, range.cursor, { active: active ? { ...active, pending: [...active.pending] } : null,
    nextTurn, lastTurn, tools: [...tools], planIds: [...planIds], seenUsage: [...seenUsage] });
  // The turn window bounds an INITIAL read only. An incremental read delivers every appended record:
  // the cursor advances past everything read, so a consumer that was hidden while more than `limit`
  // turns arrived would append the newest ones to its history and lose the middle permanently.
  const firstTurn = Math.max(0, nextTurn - limit);
  let selected = events.filter((e) => (emittedSince > 0 || e.turn < 0 || e.turn >= firstTurn) && (e.offset ?? 0) >= emittedSince);
  const turns = selected.filter(e => e.update.sessionUpdate === 'user_prompt').length;
  const firstTs = selected.length ? selected.reduce((m, e) => (e.ts > 0 ? Math.min(m, e.ts) : m), Infinity) : Infinity;
  const lastTs = selected.length ? selected.reduce((m, e) => Math.max(m, e.ts), 0) : 0;
  const turnForTs = (ts: number): number => {
    let turn = promptStarts.length ? promptStarts[0].turn : -1;
    for (const p of promptStarts) {
      if (p.ts > ts) break;
      turn = p.turn;
    }
    return turn;
  };
  if (emittedSince === 0 && Number.isFinite(firstTs) && lastTs > 0) {
    selected = [...selected, ...permissionEvents(root, session, firstTs, lastTs, turnForTs)].sort((a, b) => a.ts - b.ts);
  }
  return {
    events: selected.map(({ ts, update }) => ({ ts, update })),
    turns,
    agent,
    transcriptPath: transcript,
    cursor: range.cursor,
    truncated: emittedSince > 0 ? 0 : range.start,
  };
}

/** Opaque to callers; checks the file identity and fixed-size guards around a byte cursor. */
function conversationSource(file: string, cursor: number): string {
  const st = fs.statSync(file);
  return require('crypto').createHash('sha256').update(JSON.stringify([file, st.ino, st.birthtimeMs, cursorGuard(file, cursor)])).digest('hex');
}
export function conversationEvents(session: string, opts: ConversationOptions = {}): ConversationResult {
  let reset = false;
  if (opts.source && opts.since !== undefined) {
    const file = (opts.root ? findTranscript(opts.root, session) : null) ?? transcriptForSession(session);
    reset = !!file && (opts.since > fs.statSync(file).size || conversationSource(file, opts.since) !== opts.source);
  }
  const result = buildConversation(session, reset ? { ...opts, since: 0 } : opts);
  if (reset) result.reset = true;
  if (opts.includeSource && result.transcriptPath && result.cursor !== null)
    result.source = conversationSource(result.transcriptPath, result.cursor);
  return result;
}

/** Read only complete records appended after `cursor`; the returned cursor is ready for the next call.
 *  Every appended record is delivered, however many turns accumulated. A `reset` result means the
 *  source was replaced: its events are a fresh window, and the consumer must replace, never append. */
export function conversationTail(session: string, cursor: number): ConversationResult {
  return buildConversation(session, { since: cursor });
}
