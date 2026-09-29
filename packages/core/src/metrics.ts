/**
 * Session metrics (zero-token): high-signal numbers rolled up from what the observatory already
 * parses — per-edit diff stats (±lines), action counts, per-subagent duration/tokens, and tool
 * latency (the gap between each tool_use and its tool_result, straight from transcript timestamps).
 *
 * Everything here is derived, never stored: edits from the store (lineDelta), actions from the action
 * timeline, subagents from their transcripts, latency from the main transcript. No model calls.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { maxOf, rootDir } from './store';
import { reviewEdits, visibleEdits } from './groups';
import { lineDelta, friendlyModel } from './format';
import { findTranscript } from './observe';
import { parseActions, summarizeActions, parseCompactLine, CompactionEvent } from './actions';
import { parseSubagents, summarizeSubagents, SubagentsSummary } from './subagents';
import { cachedByFiles, readLines } from './fscache';

export interface EditMetrics {
  count: number;
  added: number; // total lines added across all captured edits
  removed: number; // total lines removed
  pending: number;
  kept: number;
  undone: number;
}

export interface LatencyMetrics {
  count: number; // tool calls with a measurable latency
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface SessionMetrics {
  session: string;
  /** Wall-clock span of the session's actions (lastTs − firstTs), ms. */
  spanMs: number;
  actions: { total: number; errors: number; byCategory: Record<string, number> };
  edits: EditMetrics;
  subagents: SubagentsSummary;
  /** Per tool_use→tool_result gap: how long Claude's tools took this session. */
  toolLatency: LatencyMetrics;
}

/** Nearest-rank percentile of an unsorted numeric array (0 for empty). p in [0,1]. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** Parse ISO/epoch → ms epoch, 0 when absent. */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Usage fields must be finite numbers — a malformed line must not poison the sum (a string would turn
 *  the next `+=` into concatenation). */
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

/** Session-total token counters, split the way the API bills them (all from `message.usage`). */
export interface SessionTokens {
  /** False when no usage record is available; numeric zeros remain compatible with older clients. */
  available?: boolean;
  /**
   * Tokens PROCESSED ONCE: `input` + `output` + `cacheCreation`. The headline every surface prints
   * as "N tok".
   *
   * It excludes exactly one counter, `cacheRead` — the whole prompt read back on every turn, which
   * makes the same context count once per turn. It was 98.8% of the old blended total, which
   * reported 372.2M for a session whose real figure is single-digit millions.
   *
   * `cacheCreation` IS counted: those tokens were genuinely processed, just written to cache rather
   * than re-sent. Dropping it under-reported an agent as 7.7k where Claude Code showed 127.8k.
   *
   * **This definition is chosen to AGREE with Claude Code's own display**, because two tools
   * reporting different numbers for the same run is worse than either being slightly off — the
   * reader has no way to tell which to trust. Verified against a live run: ours 114.3k/127.3k/133.1k
   * vs Claude Code's 127.8k/137.3k/106.6k for the same agents.
   *
   * `cacheRead` and `cacheCreation` stay on this interface and the Stats panel breaks them out with
   * `hitPct`, so the cache mechanics are still visible — just counted separately.
   */
  total: number;
  /** Uncached `input_tokens` across the session's main-chain assistant turns. */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** cacheRead share of all context sent — cacheRead/(input+cacheRead+cacheCreation) as 0–100 — or
   *  null before any usage-bearing turn exists (so a fresh session renders "—", not a fake 0%). */
  hitPct: number | null;
}

/**
 * Session-total usage summed across the session's main-chain assistant messages (deduped by message
 * id, the same formula Stats/Workflows use, so a multi-block message isn't multiplied); `durationMs` =
 * wall-clock span of the transcript (last − first timestamp over every timestamped line). Zeros when
 * the transcript is absent/unreadable. Zero token, no model calls.
 *
 * Efficiency: transcripts are append-only JSONL, so this keeps a per-transcript CURSOR (byte offset +
 * running counters + seen ids) and each call parses only the bytes appended since the previous one —
 * an untouched file is a single stat(). The live stats panel refreshes on every transcript change,
 * where a full re-parse would be ~120ms on a 56MB session; the delta is microseconds. A shrunken file
 * (replaced/GC'd) discards the cursor and rescans from byte 0.
 */
export function sessionUsage(cwd: string, sessionId: string, at?: string): SessionTokens & { durationMs: number } {
  // `at` is the transcript's KNOWN path. A caller listing every workspace's sessions has already found
  // the file; without this it is re-resolved from `cwd`, and `findTranscript` only walks UP from there
  // — so every session belonging to a different workspace silently costs zero. That is how the session
  // picker came to print a blank token column for every row but the current repo's.
  const transcript = at ?? findTranscript(cwd, sessionId);
  if (!transcript) return emptyUsage();
  const adv = advanceCursor(transcript);
  if (!adv) return emptyUsage();
  const { cur, st } = adv;
  const snap = usageSnapshot(cur);
  // A complete-but-unterminated FINAL line (its '\n' not flushed yet, or a crash-cut file) is still
  // pending in the cursor — peek it into this snapshot without advancing, so any file state matches
  // a full scan exactly. It folds into the cursor for real once its newline lands.
  if (cur.offset < st.size && st.size - cur.offset <= TAIL_PEEK_MAX) peekTail(transcript, cur, st.size, snap);
  return snap;
}

/** Running per-transcript accumulator: totals for [0, offset) plus the message ids already counted.
 *  It also carries the session's "vitals" (model, effort, compactions, context-fill series) so those
 *  ride the SAME delta-parse — reading them costs no extra pass over the transcript. */
interface UsageCursor {
  mtimeMs: number;
  size: number;
  offset: number; // bytes consumed, always ending on a '\n' (a trailing partial line stays pending)
  seen: Set<string>;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  firstTs: number;
  lastTs: number;
  /** Main-chain model id → turns counted on it; insertion order = first seen. */
  models: Map<string, number>;
  /** Latest main-chain model id ('' when none) — what the session is running on NOW. */
  lastModel: string;
  /** Latest reasoning effort from the assistant record's own `effort` field (current builds). */
  effortRecord: string;
  /** Latest effort from a `/effort` command stub — the only source on builds that predate the field. */
  effortStub: string;
  compactions: CompactionEvent[];
}

const usageCursors = new Map<string, UsageCursor>(); // insertion order = LRU (touch re-inserts)
const USAGE_CURSOR_CAP = 32; // a fleet scan touches tens of transcripts; an evicted one just rescans
const TAIL_PEEK_MAX = 2 * 1024 * 1024; // a usage-bearing line is small; never re-read a huge pending tail

function newCursor(): UsageCursor {
  return {
    mtimeMs: 0,
    size: 0,
    offset: 0,
    seen: new Set(),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    firstTs: 0,
    lastTs: 0,
    models: new Map(),
    lastModel: '',
    effortRecord: '',
    effortStub: '',
    compactions: [],
  };
}

/** Advance (or create) this transcript's cursor to the file's current size, then hand it back with the
 *  stat that drove it. The shared step behind sessionUsage and sessionVitals: both read different facts
 *  out of the one delta-parse, so asking for vitals right after usage costs a single stat(). */
function advanceCursor(transcript: string): { cur: UsageCursor; st: fs.Stats } | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(transcript);
  } catch {
    return null;
  }
  let cur = usageCursors.get(transcript);
  // Nothing in memory yet — this is a one-shot CLI process (the status line runs one per prompt, the
  // JetBrains stats poll one per tick), where an in-memory cursor never survives to help. Pick up the
  // cursor the last process left on disk so a 50MB transcript is delta-parsed instead of re-read.
  if (!cur) cur = loadCursor(transcript);
  const startOffset = cur ? cur.offset : 0;
  if (!(cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size)) {
    // Reuse the cursor only while the file has strictly grown — a shrink means the transcript was
    // replaced, so start over. (A same-size mtime touch keeps the totals; there are no new bytes.)
    if (!cur || st.size < cur.offset) cur = newCursor();
    if (st.size > cur.offset) consumeDelta(transcript, cur, st.size);
    cur.mtimeMs = st.mtimeMs;
    cur.size = st.size;
  }
  touchCursor(transcript, cur);
  if (cur.offset !== startOffset) saveCursor(transcript, cur); // only when this call actually consumed bytes
  return { cur, st };
}

/** Where this transcript's persisted cursor lives — one file per transcript (they reach ~tens of KB on
 *  a long session, so a single shared map would grow unbounded across every session on the machine). */
function cursorPath(transcript: string): string {
  const key = crypto.createHash('sha256').update(path.resolve(transcript)).digest('hex').slice(0, 16);
  return path.join(rootDir(), 'usage-cursors', `${key}.json`);
}

/**
 * Drop a transcript's persisted usage cursor. The cursor is keyed by the transcript PATH, not the
 * session id, so `removeSession` (which only knows the id) cannot reach it — a caller that deletes a
 * transcript has to say so here, or the cursor outlives it as an orphan that nothing will ever read
 * again. `demo --clean` does exactly that, and repeats every time the demo is replayed.
 */
export function removeUsageCursor(transcript: string): void {
  try {
    fs.rmSync(cursorPath(transcript), { force: true });
  } catch {
    /* best effort — an orphaned cursor is inert, just untidy */
  }
}

/** Reap usage cursors whose transcript no longer exists.
 *
 *  Cursors are keyed by a HASH of the transcript path, so they are unreachable from a session id —
 *  `removeSession` cannot delete them, and they leaked forever. New cursors record their transcript
 *  (see StoredCursor.transcript); one whose recorded transcript is gone is dead weight. Old-format
 *  cursors carry no path at all, so the only honest signal left is age: reaped after 30 quiet days,
 *  which for a LIVE transcript merely costs one incremental re-scan on the next usage read. */
export function reapUsageCursors(now: number = Date.now()): { removed: number; bytes: number } {
  const out = { removed: 0, bytes: 0 };
  const dir = path.join(rootDir(), 'usage-cursors');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out; // no cursors yet
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    let dead = false;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as StoredCursor;
      if (typeof raw.transcript === 'string') dead = !fs.existsSync(raw.transcript);
      else dead = now - fs.statSync(p).mtimeMs > 30 * 24 * 3600_000; // path-less legacy: age is all there is
    } catch {
      dead = true; // unreadable is unusable — a cursor that cannot load only costs a re-scan anyway
    }
    if (!dead) continue;
    try {
      out.bytes += fs.statSync(p).size;
      fs.rmSync(p, { force: true });
      out.removed++;
    } catch {
      /* best effort */
    }
  }
  return out;
}

/** Cursor state as written to disk. `seen` must be persisted in FULL: duplicate message ids recur
 *  hundreds of lines apart in real transcripts (a resumed session re-emits earlier turns), so a
 *  last-id or fixed-window dedup would silently double-count those turns' tokens. */
interface StoredCursor {
  v: number;
  /** The transcript this cursor belongs to. The FILENAME is a one-way hash of this path, so without it
   *  stored, nothing could ever map a cursor back to its transcript — `removeSession` knows only the
   *  session id, and the GC had no way to tell a live cursor from one whose transcript is long gone
   *  (47 orphans, growing ~15KB per session forever). Additive: readers ignore it, old cursors lack it. */
  transcript?: string;
  mtimeMs: number;
  size: number;
  offset: number;
  seen: string[];
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  firstTs: number;
  lastTs: number;
  models: [string, number][];
  lastModel: string;
  effortRecord: string;
  effortStub: string;
  compactions: CompactionEvent[];
}

// 2: `total` stopped including the cache counters. This is a SEMANTICS change, not a shape change —
// the persisted cursors carry a running `total`, so without this bump every existing install would
// keep restoring the old blended figure from disk and never recompute it. The stale value is
// indistinguishable from a correct one, which is exactly what this counter exists to prevent.
const CURSOR_VERSION = 2;

function loadCursor(transcript: string): UsageCursor | undefined {
  let raw: StoredCursor;
  try {
    raw = JSON.parse(fs.readFileSync(cursorPath(transcript), 'utf8')) as StoredCursor;
  } catch {
    return undefined; // absent or unreadable — a full parse rebuilds it
  }
  if (!raw || raw.v !== CURSOR_VERSION || !Array.isArray(raw.seen)) return undefined;
  return {
    mtimeMs: raw.mtimeMs,
    size: raw.size,
    offset: raw.offset,
    seen: new Set(raw.seen),
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cacheRead,
    cacheCreation: raw.cacheCreation,
    firstTs: raw.firstTs,
    lastTs: raw.lastTs,
    models: new Map(raw.models || []),
    lastModel: raw.lastModel || '',
    effortRecord: raw.effortRecord || '',
    effortStub: raw.effortStub || '',
    compactions: raw.compactions || [],
  };
}

/** Best-effort persist — a failure here costs a re-parse next time, never a wrong answer. */
function saveCursor(transcript: string, cur: UsageCursor): void {
  const p = cursorPath(transcript);
  const stored: StoredCursor = {
    v: CURSOR_VERSION,
    transcript: path.resolve(transcript),
    mtimeMs: cur.mtimeMs,
    size: cur.size,
    offset: cur.offset,
    seen: [...cur.seen],
    input: cur.input,
    output: cur.output,
    cacheRead: cur.cacheRead,
    cacheCreation: cur.cacheCreation,
    firstTs: cur.firstTs,
    lastTs: cur.lastTs,
    models: [...cur.models.entries()],
    lastModel: cur.lastModel,
    effortRecord: cur.effortRecord,
    effortStub: cur.effortStub,
    compactions: cur.compactions,
  };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`; // pid-scoped: two CLI processes can't collide on the temp file
    fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(tmp, p); // atomic: a concurrent reader sees old-or-new, never a torn cursor
  } catch {
    /* cache is best-effort */
  }
}

function touchCursor(transcript: string, cur: UsageCursor): void {
  usageCursors.delete(transcript);
  usageCursors.set(transcript, cur);
  if (usageCursors.size > USAGE_CURSOR_CAP) {
    const oldest = usageCursors.keys().next().value;
    if (oldest !== undefined) usageCursors.delete(oldest);
  }
}

function emptyUsage(): SessionTokens & { durationMs: number } {
  return { available: false, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, hitPct: null, durationMs: 0 };
}

/** The cursor is mutable shared state — hand callers a fresh object, never a live reference. */
function usageSnapshot(cur: UsageCursor): SessionTokens & { durationMs: number } {
  const { input, output, cacheRead, cacheCreation } = cur;
  const ctxSent = input + cacheRead + cacheCreation;
  return {
    available: cur.seen.size > 0,
    total: input + output + cacheCreation, // tokens processed ONCE — see SessionTokens.total
    input,
    output,
    cacheRead,
    cacheCreation,
    hitPct: ctxSent > 0 ? (cur.cacheRead / ctxSent) * 100 : null,
    durationMs: cur.firstTs && cur.lastTs ? Math.max(0, cur.lastTs - cur.firstTs) : 0,
  };
}

/** Parse [cur.offset, end) and fold every COMPLETE line into the cursor. Bytes after the delta's last
 *  '\n' are left unconsumed (offset doesn't advance past them) — they re-read with the next append.
 *  A read failure consumes nothing; the next call retries the same range. */
function consumeDelta(transcript: string, cur: UsageCursor, end: number): void {
  let buf: Buffer;
  try {
    const fd = fs.openSync(transcript, 'r');
    try {
      buf = Buffer.alloc(end - cur.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, cur.offset);
      if (n < buf.length) buf = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  const nl = buf.lastIndexOf(0x0a); // '\n' — a safe cut: 0x0a never occurs inside a UTF-8 sequence
  if (nl === -1) return;
  const text = buf.toString('utf8', 0, nl + 1);
  cur.offset += nl + 1;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = toMs(o.timestamp ?? o.ts);
    if (ts > 0) {
      if (!cur.firstTs || ts < cur.firstTs) cur.firstTs = ts;
      if (ts > cur.lastTs) cur.lastTs = ts;
    }
    // Compaction boundaries carry no `message` — read them before the message gate below.
    const ce = o.isSidechain === true ? null : parseCompactLine(o);
    if (ce) {
      cur.compactions.push(ce);
      continue;
    }
    const m = o.message;
    if (!m || o.isSidechain === true) continue;
    if (m.role !== 'assistant') {
      // `/effort` writes its confirmation into the transcript as a command stub — the only record of
      // the session's effort level on builds older than the structural `effort` field below.
      if (m.role === 'user') {
        const stub = effortFromStub(m.content);
        if (stub) cur.effortStub = stub;
      }
      continue;
    }
    // One assistant message is split across lines sharing message.id + identical usage — count each id once.
    const id = typeof m.id === 'string' ? m.id : null;
    if (id !== null && cur.seen.has(id)) continue;
    if (id !== null) cur.seen.add(id);
    // Which model actually served this turn, and at what effort. Both are per-record: a session that
    // switched models (or effort) mid-flight reports the LATEST, with the full set kept for the chip.
    const model = typeof m.model === 'string' ? m.model : '';
    if (model && model !== '<synthetic>') {
      cur.models.set(model, (cur.models.get(model) || 0) + 1);
      cur.lastModel = model;
    }
    if (typeof o.effort === 'string' && o.effort) cur.effortRecord = o.effort;
    const u = m.usage || {};
    cur.input += num(u.input_tokens);
    cur.output += num(u.output_tokens);
    cur.cacheRead += num(u.cache_read_input_tokens);
    cur.cacheCreation += num(u.cache_creation_input_tokens);
  }
}

/** `<local-command-stdout>Set effort level to max (this session only): …</local-command-stdout>` → 'max'.
 *  Content is a plain string on these stubs, but tolerate the block-array shape too. */
function effortFromStub(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') text += b.text;
  }
  if (!text || !text.includes('Set effort level to ')) return '';
  const m = /Set effort level to (\w+)/.exec(text);
  return m ? m[1] : '';
}

/** Fold the pending (newline-less) tail line into ONE snapshot — never into the cursor, and never
 *  into `seen`, so it can't double-count when its '\n' finally lands and consumeDelta re-reads it. */
function peekTail(transcript: string, cur: UsageCursor, end: number, snap: SessionTokens & { durationMs: number }): void {
  let text: string;
  try {
    const fd = fs.openSync(transcript, 'r');
    try {
      const buf = Buffer.alloc(end - cur.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, cur.offset);
      text = buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  const t = text.trim();
  if (!t || t.includes('\n')) return; // more than the single pending line → let the next delta eat it
  let o: any;
  try {
    o = JSON.parse(t);
  } catch {
    return; // genuinely partial (mid-write) — not countable yet
  }
  const ts = toMs(o.timestamp ?? o.ts);
  if (ts > 0) {
    const first = cur.firstTs > 0 ? Math.min(cur.firstTs, ts) : ts;
    const last = Math.max(cur.lastTs, ts);
    snap.durationMs = Math.max(0, last - first);
  }
  const m = o.message;
  if (!m || m.role !== 'assistant' || o.isSidechain === true) return;
  const id = typeof m.id === 'string' ? m.id : null;
  if (id !== null && cur.seen.has(id)) return;
  const u = m.usage || {};
  snap.available = true;
  snap.input += num(u.input_tokens);
  snap.output += num(u.output_tokens);
  snap.cacheRead += num(u.cache_read_input_tokens);
  snap.cacheCreation += num(u.cache_creation_input_tokens);
  snap.total = snap.input + snap.output + snap.cacheCreation; // see SessionTokens.total
  const ctxSent = snap.input + snap.cacheRead + snap.cacheCreation;
  snap.hitPct = ctxSent > 0 ? (snap.cacheRead / ctxSent) * 100 : null;
}

/** One model the session ran on. */
export interface ModelUse {
  /** Raw id exactly as recorded, e.g. 'claude-opus-4-8'. */
  id: string;
  /** Short display label, e.g. 'Opus 4.8' (unknown ids pass through unchanged). */
  label: string;
  /** Assistant turns served by it. */
  turns: number;
}

/** What a session is actually running on, and how its context has fared — the facts shown beside the
 *  session title, plus the compaction history behind them. Everything here is structural (recorded by
 *  the harness, never inferred) and rides sessionUsage's cursor, so it costs no extra transcript pass. */
export interface SessionVitals {
  /** The model serving the session NOW (its latest main-chain turn); null before any turn exists. */
  model: ModelUse | null;
  /** Every model used, first-seen order — more than one means the session switched mid-flight. */
  models: ModelUse[];
  /** Reasoning effort when the session ever declared one; null otherwise — an unset effort is reported
   *  as unknown rather than guessed, since the default differs by build and model. `source` says
   *  whether it came from the assistant records themselves or an older `/effort` command stub. */
  effort: { level: string; source: 'record' | 'stub' } | null;
  /** Every context compaction, in transcript order. */
  compactions: CompactionEvent[];
}

/**
 * The session's model / effort / compaction / context-fill vitals. Shares sessionUsage's incremental
 * cursor: calling both back-to-back (as the stats panels do) parses the transcript once.
 */
export function sessionVitals(cwd: string, sessionId: string, at?: string): SessionVitals {
  const empty: SessionVitals = { model: null, models: [], effort: null, compactions: [] };
  const transcript = at ?? findTranscript(cwd, sessionId); // see sessionUsage — `at` is the known path
  if (!transcript) return empty;
  const adv = advanceCursor(transcript);
  if (!adv) return empty;
  const { cur } = adv;
  const level = cur.effortRecord || cur.effortStub;
  return {
    model: cur.lastModel ? { id: cur.lastModel, label: friendlyModel(cur.lastModel), turns: cur.models.get(cur.lastModel) || 0 } : null,
    models: [...cur.models.entries()].map(([id, turns]) => ({ id, label: friendlyModel(id), turns })),
    effort: level ? { level, source: cur.effortRecord ? 'record' : 'stub' } : null,
    // Fresh objects only — the cursor is mutable shared state that keeps accumulating.
    compactions: cur.compactions.map((c) => ({ ...c })),
  };
}

/** Tool-call latencies (ms) = each tool_result timestamp − its tool_use timestamp, matched by id. */
function toolLatencies(transcriptPath: string): number[] {
  // Memoized like every other whole-transcript parser: `metrics` is polled by both editors' panels,
  // and re-reading a 50MB transcript per refresh was the last unmemoized full scan in this module.
  return cachedByFiles('toolLatencies', [transcriptPath], () => toolLatenciesUncached(transcriptPath));
}

function toolLatenciesUncached(transcriptPath: string): number[] {
  let lines: string[];
  try {
    lines = readLines(transcriptPath);
  } catch {
    return [];
  }
  const useTs = new Map<string, number>(); // tool_use_id → tool_use ts
  const out: number[] = [];
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
    if (!msg || !Array.isArray(msg.content)) continue;
    const ts = toMs(o.timestamp ?? o.ts);
    for (const b of msg.content) {
      if (b && b.type === 'tool_use' && typeof b.id === 'string' && ts > 0) useTs.set(b.id, ts);
      else if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && ts > 0) {
        const started = useTs.get(b.tool_use_id);
        if (started && ts >= started) out.push(ts - started);
      }
    }
  }
  return out;
}

/** Roll up the session's metrics. `cwd` locates the transcript; falls back gracefully when absent. */
export function sessionMetrics(cwd: string, sessionId: string): SessionMetrics {
  // DISPLAY units (same-code collapsed), like the change map and the session listing — one meaning for
  // "edits" across the product. Counting raw records here made Stats disagree with the Overview.
  const log = visibleEdits(sessionId);
  const edits: EditMetrics = { count: log.length, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
  for (const r of log) {
    const d = lineDelta(sessionId, r);
    edits.added += d.added;
    edits.removed += d.removed;
    if (r.status === 'kept') edits.kept++;
    else if (r.status === 'undone') edits.undone++;
    else edits.pending++;
  }

  const actions = parseActions(cwd, sessionId);
  const aSum = summarizeActions(actions);
  const subs = summarizeSubagents(parseSubagents(cwd, sessionId));

  const transcript = findTranscript(cwd, sessionId);
  const lat = transcript ? toolLatencies(transcript) : [];
  const toolLatency: LatencyMetrics = {
    count: lat.length,
    medianMs: Math.round(percentile(lat, 0.5)),
    p95Ms: Math.round(percentile(lat, 0.95)),
    maxMs: lat.length ? maxOf(lat) : 0,
  };

  return {
    session: sessionId,
    spanMs: aSum.lastTs && aSum.firstTs ? Math.max(0, aSum.lastTs - aSum.firstTs) : 0,
    actions: { total: aSum.total, errors: aSum.errors, byCategory: aSum.byCategory },
    edits,
    subagents: subs,
    toolLatency,
  };
}

export type { SubagentsSummary };
