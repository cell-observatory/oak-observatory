/** Shared, append-only transcript facts: action metadata and carried reasoning, summaries, tasks,
 *  and prose byte locations. Prose is indexed, not stored again; raw tool results remain in the transcript. */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { serialize, deserialize } from 'v8';
import { deflateRawSync, inflateRawSync } from 'zlib';
import { isSafeSessionId, logPath, rootDir } from './store';
import { newActionFacts, foldActionFacts, ActionFacts } from './actions';
import { newTaskFacts, foldTaskFacts, TaskFacts, TaskSnap } from './tasks';
import { newInsightFacts, foldInsightFacts, TranscriptInsights, ReasoningFacts, foldReasoningFacts } from './observe';
import { foldTodoFacts, pruneStaleMaps } from './changemap';
import { newSubagentFacts, foldSubagentFacts, SubagentFacts } from './subagents';
import { newProcessFacts, foldProcessFacts, ProcessFacts } from './processes';

// Bump whenever any of the constituent folds changes its stored shape or interpretation. The version
// is part of the cache FILE NAME, so `pruneStaleMaps` can reclaim the generation a bump supersedes.
export const TRANSCRIPT_FACTS_VERSION = 11; // 9: subagent facts keep each background task's completion notice (`ended`); 10: every id in a notice, the latest enqueue, and each agent's last turn (`vitals.lastTurnTs`); 11: a meta user record is a turn
const VERSION = TRANSCRIPT_FACTS_VERSION;
const GUARD_BYTES = 128;
// Two guards proved only that the first and last 128 bytes of the parsed region survived, so an
// in-place rewrite of the INTERIOR followed by an append passed as a pure append and the obsolete
// facts were republished. Sampling the region at a fixed number of strides costs
// GUARD_WINDOWS × GUARD_BYTES = 512 bytes per verification whatever the transcript's size, and
// catches every rewrite this side of a very large region whose edit falls between two samples.
// Exact detection means rereading the region — O(size) on the poll path — unless a writer publishes a
// generation counter, and neither Claude Code nor Codex does.
const GUARD_WINDOWS = 4;
const CHUNK_BYTES = 64 * 1024;
// A large parent's facts and its child inventory must coexist until attribution reuses the parent.
// The 32 MiB limit evicted that parent mid-batch and decoded its 14 MiB cache repeatedly.
const MEMORY_BYTES = 64 * 1024 * 1024;
export interface TranscriptFacts {
  actions: ActionFacts;
  subagents: SubagentFacts;
  processes: ProcessFacts;
  tasks: TaskFacts;
  todos: TaskSnap[];
  insights: TranscriptInsights;
  reasoning: ReasoningFacts;
}
interface Cursor {
  version: number;
  transcript: string;
  includeSidechain: boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  cursor: number;
  guards: string;
  facts: TranscriptFacts;
}
interface Entry { cursor: Cursor; value: TranscriptFacts; bytes: number }
const memory = new Map<string, Entry>();
let memoryBytes = 0;
let uncached = 0;

/** Internal verification seam: the very same folds, starting from byte zero with no cache I/O. */
export function withoutTranscriptFactsCache<T>(compute: () => T): T {
  uncached++;
  try { return compute(); } finally { uncached--; }
}
export function clearTranscriptFactsMemory(): void { memory.clear(); memoryBytes = 0; }

function emptyFacts(): TranscriptFacts {
  return { subagents: newSubagentFacts(), processes: newProcessFacts(), actions: newActionFacts(), tasks: newTaskFacts(), todos: [], insights: newInsightFacts(), reasoning: { lastReasoning: '', uses: [] } };
}
function fold(facts: TranscriptFacts, line: Buffer, includeSidechain: boolean, offset: number): void {
  let o: any;
  try { o = JSON.parse(line.toString('utf8')); } catch { return; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return;
  foldSubagentFacts(facts.subagents, o);
  foldProcessFacts(facts.processes, o);
  foldActionFacts(facts.actions, o, includeSidechain, offset, line.length);
  foldTaskFacts(facts.tasks, o);
  foldTodoFacts(facts.todos, o);
  foldInsightFacts(facts.insights, o);
  foldReasoningFacts(facts.reasoning, o);
}

/** The folds' own source text, hashed into the cache key. Editing a fold and rebuilding used to be a
 *  silent no-op against any session whose facts were already cached: the cursor sits at EOF, so the
 *  persisted answer is returned and the new code never runs. Keying by the
 *  fold text makes that impossible, with no version bump to remember. It covers the fold bodies, not
 *  the helpers they call — those still need TRANSCRIPT_FACTS_VERSION. Two builds of the SAME source
 *  (tsc's dist and esbuild's bundles) stamp differently, because esbuild drops comments, rewrites
 *  quotes and renames collided identifiers; they then keep one cache generation each rather than
 *  invalidating each other's, which would re-derive the whole transcript on every alternation. */
const FOLD_STAMP = createHash('sha256').update([
  foldSubagentFacts, foldProcessFacts, foldActionFacts, foldTaskFacts, foldTodoFacts, foldInsightFacts, foldReasoningFacts, fold,
].map((fn) => fn.toString()).join('\u0000')).digest('hex').slice(0, 16);

function cacheSlot(transcript: string, includeSidechain: boolean): { file: string; log: string } | null {
  // Main, subagent, and workflow transcripts all belong to the enclosing session's store.
  const parts = transcript.split(path.sep);
  const subagents = parts.lastIndexOf('subagents');
  const workflows = parts.lastIndexOf('workflows');
  const session = subagents > 0 ? parts[subagents - 1]
    : workflows > 0 ? parts[workflows - 1] : path.basename(transcript, '.jsonl');
  if (!isSafeSessionId(session)) return null;
  const log = logPath(session);
  if (!fs.existsSync(log)) return null;
  const key = createHash('sha256').update(`${VERSION}\u0000${FOLD_STAMP}\u0000${transcript}\u0000${includeSidechain}`).digest('hex');
  // The version rides the NAME as well as the key: a bump used to leave the whole previous
  // generation addressed by nothing, and the only sweeper matched map payloads only — 471 dead
  // files / 47.6 MB on one real store. `pruneStaleMaps` reads it back.
  return { file: path.join(rootDir(), 'changemap-cache', session, `transcript-facts-v${VERSION}-${key}.json`), log };
}
function identity(st: fs.Stats): string { return `${st.dev}:${st.ino}`; }
function sameSource(c: Cursor, st: fs.Stats): boolean {
  return c.dev === st.dev && c.ino === st.ino && c.size === st.size && c.mtimeMs === st.mtimeMs && c.ctimeMs === st.ctimeMs;
}
function guard(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (!n) break;
    got += n;
  }
  return buf.subarray(0, got);
}
/** GUARD_WINDOWS evenly spaced samples of the region already folded into these facts, the first at
 *  byte zero and the last ending at the cursor. Any of them changing means the region was rewritten,
 *  not appended to, and the facts derived from it are obsolete. */
function guards(fd: number, cursor: number): string {
  const length = Math.min(GUARD_BYTES, cursor);
  const stride = GUARD_WINDOWS > 1 ? Math.max(0, cursor - length) / (GUARD_WINDOWS - 1) : 0;
  const h = createHash('sha256').update(`${cursor}\u0000${length}`);
  for (let i = 0; i < GUARD_WINDOWS; i++) h.update(guard(fd, Math.round(i * stride), length));
  return h.digest('hex');
}
function validFacts(f: TranscriptFacts): boolean {
  return !!f && f.subagents?.spawns instanceof Map && f.subagents.meta instanceof Map && f.subagents.ended instanceof Map &&
    Array.isArray(f.subagents.todos) && typeof f.subagents.vitals?.firstTs === 'number' && typeof f.subagents.vitals.lastTurnTs === 'number' &&
    f.processes?.byToolUse instanceof Map && f.processes.byId instanceof Map &&
    f.processes.stopped instanceof Map && Array.isArray(f.processes.pendingEnd) &&
    typeof f.processes.lastRecordTs === 'number' && Array.isArray(f.actions?.actions) && f.actions.resultErr instanceof Map &&
    f.actions.byId instanceof Map && typeof f.actions.lastReasoning === 'string' && Array.isArray(f.actions.proseIndex) &&
    f.actions.proseIndex.every(p => p && Number.isFinite(p.ts) && (p.kind === 'text' || p.kind === 'thinking') &&
      Number.isSafeInteger(p.offset) && p.offset >= 0 && Number.isSafeInteger(p.length) && p.length > 0) &&
    f.tasks?.state instanceof Map && f.tasks.pendingCreate instanceof Map &&
    f.tasks.pendingNames instanceof Map && f.tasks.known instanceof Map &&
    Array.isArray(f.tasks.snaps) && Array.isArray(f.tasks.namings) && Array.isArray(f.todos) &&
    Array.isArray(f.insights?.todos) && Array.isArray(f.reasoning?.uses);
}
function load(file: string, transcript: string, includeSidechain: boolean): { cursor: Cursor; bytes: number } | null {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof record.data !== 'string' || typeof record.sha256 !== 'string') return null;
    const data = Buffer.from(record.data, 'base64');
    if (createHash('sha256').update(data).digest('hex') !== record.sha256) return null;
    // V8's versioned encoding retains Maps and explicit undefined properties. An incompatible
    // runtime throws here and rebuilds, just like a parser schema change does.
    const raw = inflateRawSync(data);
    const c: Cursor = deserialize(raw);
    if (c.version !== VERSION || c.transcript !== transcript || c.includeSidechain !== includeSidechain ||
      !Number.isSafeInteger(c.cursor) || c.cursor < 0 || !Number.isSafeInteger(c.size) || c.size < c.cursor ||
      typeof c.guards !== 'string' || !validFacts(c.facts)) return null;
    return { cursor: c, bytes: raw.length };
  } catch { return null; }
}
/** Sessions whose superseded facts generations were already reclaimed this process — prune is O(dir). */
const prunedThisRun = new Set<string>();
function save(slot: { file: string; log: string }, lease: string, data: Buffer): void {
  const live = () => { try { return identity(fs.statSync(slot.log)) === lease; } catch { return false; } };
  if (!live()) return;
  const dir = path.dirname(slot.file);
  const tmp = `${slot.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!live()) return;
    fs.writeFileSync(tmp, JSON.stringify({ sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx' });
    if (!live()) return;
    fs.renameSync(tmp, slot.file);
    // A drop racing the write wins. Never publish content after its store was removed/recreated.
    if (!live()) fs.rmSync(slot.file, { force: true });
    // Reclaim superseded generations while this session's cache dir is already open — once per session
    // per process (a bump or a legacy name otherwise strands one file per transcript until a manual
    // `oak clean`; 59.7 MB dead on one real store). Best-effort.
    else {
      const session = path.basename(dir);
      if (!prunedThisRun.has(session)) { prunedThisRun.add(session); try { pruneStaleMaps(session); } catch { /* a scan next time */ } }
    }
  } catch { /* cache failure costs a scan, never an unavailable view */ }
  finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* absent */ }
    if (!live()) { try { fs.rmdirSync(dir); } catch { /* only remove an empty directory */ } }
  }
}
function remember(key: string, entry: Entry): void {
  const old = memory.get(key);
  if (old) { memoryBytes -= old.bytes; memory.delete(key); }
  // Serialized size estimates retained facts; evict instead of accumulating every visited session.
  if (entry.bytes > MEMORY_BYTES) return;
  while (memoryBytes + entry.bytes > MEMORY_BYTES || memory.size >= 1024) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memoryBytes -= memory.get(oldest)!.bytes; memory.delete(oldest);
  }
  memory.set(key, entry); memoryBytes += entry.bytes;
}

export function transcriptFacts(file: string, includeSidechain = false): TranscriptFacts {
  let transcript: string, st: fs.Stats;
  try { transcript = fs.realpathSync(file); st = fs.statSync(transcript); } catch { return emptyFacts(); }
  if (!st.isFile()) return emptyFacts();
  const key = `${rootDir()}\0${transcript}\0${includeSidechain}`;
  const hit = uncached ? undefined : memory.get(key);
  if (hit && sameSource(hit.cursor, st)) {
    memory.delete(key); memory.set(key, hit);
    return hit.value;
  }
  const slot = uncached ? null : cacheSlot(transcript, includeSidechain);
  let lease = '';
  try { if (slot) lease = identity(fs.statSync(slot.log)); } catch { /* dropped */ }
  const loaded = !hit && slot ? load(slot.file, transcript, includeSidechain) : null;
  let c = hit?.cursor ?? loaded?.cursor ?? null;
  let fd: number;
  try { fd = fs.openSync(transcript, 'r'); } catch { return emptyFacts(); }
  try {
    st = fs.fstatSync(fd);
    if (c) {
      if (c.dev !== st.dev || c.ino !== st.ino || st.size < c.size ||
        (st.size === c.size && !sameSource(c, st)) || guards(fd, c.cursor) !== c.guards) c = null;
    }
    const unchanged = c !== null && sameSource(c, st);
    if (c && unchanged && c.cursor === st.size) {
      remember(key, { cursor: c, value: c.facts, bytes: hit?.bytes ?? (loaded?.bytes ?? 0) * 2 });
      return c.facts;
    }
    if (!c) c = { version: VERSION, transcript, includeSidechain, dev: st.dev, ino: st.ino,
      size: 0, mtimeMs: 0, ctimeMs: 0, cursor: 0, guards: '', facts: emptyFacts() };
    let position = c.cursor;
    let pending: Buffer[] = [];
    const chunk = Buffer.alloc(CHUNK_BYTES);
    while (position < st.size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, st.size - position), position);
      if (!n) break;
      let start = 0;
      for (let i = 0; i < n; i++) {
        if (chunk[i] !== 10) continue;
        const part = chunk.subarray(start, i);
        fold(c.facts, pending.length ? Buffer.concat([...pending, part]) : part, includeSidechain, c.cursor);
        pending = []; start = i + 1; c.cursor = position + start;
      }
      if (start < n) pending.push(Buffer.from(chunk.subarray(start, n)));
      position += n;
    }
    Object.assign(c, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, guards: guards(fd, c.cursor) });
    const data = serialize(c);
    // Do not stamp a partial read or a concurrently replaced/rewritten file as a successful scan.
    let stable = position === st.size && sameSource(c, fs.fstatSync(fd));
    try { stable = stable && sameSource(c, fs.statSync(transcript)); } catch { stable = false; }
    if (slot && lease && stable && !unchanged) save(slot, lease, deflateRawSync(data, { level: 1 }));
    let value = c.facts;
    // A valid newline-less final record participates in this answer only. Reparse it exactly once
    // after completion; split UTF-8 bytes and partially written JSON never enter persisted state.
    if (pending.length) {
      value = deserialize(serialize(c.facts));
      fold(value, Buffer.concat(pending), includeSidechain, c.cursor);
    }
    if (!uncached && stable) remember(key, { cursor: c, value, bytes: data.length * 2 });
    return value;
  } catch {
    // An unreadable source has always produced empty derivations. Discard a partially advanced memo.
    const entry = memory.get(key);
    if (entry) { memoryBytes -= entry.bytes; memory.delete(key); }
    return emptyFacts();
  } finally { fs.closeSync(fd); }
}
