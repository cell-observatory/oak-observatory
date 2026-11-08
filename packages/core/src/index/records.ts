/**
 * The record log: the rows this machine's index extracts from the content it holds, published as an append-only log in
 * OAK's store (`records/<machine>/`), which oak sync carries to every machine and to the backup folder. Every machine's
 * index applies every other machine's log, so each one answers for all of them, and keeps their records after the
 * content is gone. A machine's own log is the archive's truth: a new index file (a new format, or the store moved) is
 * rebuilt from the content on disk and the logs, so a session whose files are gone keeps its rows.
 *
 * What is in it: sessions, asks with their answers, edit metadata (never blob content), tool calls, workers and workflow
 * runs, review comments, raised hands and waits, plans, memories and skills, the agents OAK started from a brief, and
 * usage (messages, readings, spend and accounts). Each line is
 * one record, keyed so that replay is idempotent:
 *
 *   {"t":"batch","at":<ms>,"v":1,"label":"…","platform":"…"}   one append, with when (that machine's clock)
 *   {"t":"<table>","r":{…}}                                    a row, its columns less the machine (the log's)
 *   {"t":"<table>","d":{…}}                                    a row removed, by its key
 *   {"t":"<table>","clear":"<session>"}                        every row of a session in that table removed
 *   {"t":"purge","s":"<session>"}                              a session forgotten on purpose
 *
 * A record later in a log is newer than one before it: only the machine that writes a log writes it. Rows are keyed by
 * the machine whose log they came from.
 *
 * Segments: `<13-digit ms>-<8 hex>.jsonl`, never renamed. A local `.writer` receipt identifies the writer lifetime and
 * the exact append it owns. Only that append can be extended; rotation and publishing sync inventory close it with a final seal
 * naming its byte length. A restored prefix or an old unsealed segment may be read, but cannot be compacted away merely
 * because the reader reached local EOF.
 *
 * COMPACTION writes a base (`-base.jsonl`): a padded header with its body length, writer and coverage count (`parts`),
 * then `cover` records naming the complete segments it replaces (and their inherited coverage), current rows and purges.
 * `from` remains the history's lower bound; bases without `parts`, from earlier development builds, use that interval
 * alone. New bases cover only verified members, never an unseen segment whose clock put its name inside that interval.
 * A machine holds every uncovered segment until it can read and compact it whole, including pre-reinstall history.
 *
 * A base's writer identifies its later appends across clock changes. Unrelated history is replayed before that base,
 * so it fills the archive without overwriting the base's rows. Disconnected bases have no provable order: an index
 * keeps its selected base until another replaces it or continues that writer; a fresh index uses name order to choose.
 * Purges survive compaction explicitly, without depending on oak sync's separate tombstones.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { rootDir, withFileMutation, keepFromOldClean } from '../store';
import { localSyncLabel } from '../sync';

/** The store-root folder that holds every machine's record log (store.ts RESERVED_STORE_DIRS keeps `oak clean` off it, and
 *  keepFromOldClean OAK 0.10's). */
export const RECORDS_DIR = 'records';
/** What each append's batch line says the records mean. A reader applies a log of a newer format no further. */
export const RECORD_FORMAT = 1;
/** Past this, the next append starts a new segment. */
export const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** A base's first line is padded to this, so it is written last, over a placeholder, once its length is known. */
const BASE_HEADER_BYTES = 512;

export const RECORD_HOST = /^[0-9a-f]{12}$/;
/** The simulator's own sessions (`oak demo`, demo.ts: `demo-<8 hex>`), which stay on the machine that ran them; and the
 *  same in SQL's GLOB. */
export const DEMO_SESSION = /^demo-[0-9a-f]{8}$/;
export const DEMO_GLOB = `demo-${'[0-9a-f]'.repeat(8)}`;
const SEGMENT_NAME = /^(\d{13})-([0-9a-f]{8})(-base)?\.jsonl$/;

/** A table a record can fill: its key (less the machine) and the columns a record leaves out (this machine's own). */
export interface RecordTable {
  keys: readonly string[];
  omit: readonly string[];
}

const LOCAL = ['machine_id', 'synced_ms'];
const USAGE_LOCAL = [...LOCAL, 'seq'];

export const RECORD_TABLES: Readonly<Record<string, RecordTable>> = {
  sessions: { keys: ['session_id'], omit: [...LOCAL, 'listed', 'inputs', 'facts', 'facts_transcript', 'title_inputs', 'archive_hint', 'updated_ms'] },
  prompts: { keys: ['session_id', 'idx'], omit: LOCAL },
  actions: { keys: ['session_id', 'seq'], omit: LOCAL },
  agents: { keys: ['session_id', 'agent_id'], omit: LOCAL },
  workflow_runs: { keys: ['session_id', 'run_id'], omit: LOCAL },
  edits: { keys: ['session_id', 'id'], omit: LOCAL },
  edit_ops: { keys: ['session_id', 'seq'], omit: LOCAL },
  capture_gaps: { keys: ['session_id', 'seq'], omit: LOCAL },
  units: { keys: ['session_id', 'rep_id'], omit: LOCAL },
  comments: { keys: ['session_id', 'comment_id'], omit: LOCAL },
  attention: { keys: ['session_id'], omit: LOCAL },
  waits: { keys: ['session_id', 'start_ms'], omit: LOCAL },
  blobs: { keys: ['session_id', 'sha'], omit: LOCAL },
  edit_facts: { keys: ['before_blob', 'after_blob'], omit: LOCAL },
  notes: { keys: ['kind', 'path'], omit: LOCAL },
  delegated: { keys: ['id'], omit: [...LOCAL, 'stamp'] },
  findings: { keys: ['id'], omit: LOCAL },
  finding_resolutions: { keys: ['finding_machine', 'finding_id'], omit: LOCAL },
  usage_messages: { keys: ['message_id'], omit: USAGE_LOCAL },
  usage_readings: { keys: ['agent', 'kind', 'measured_ms'], omit: USAGE_LOCAL },
  usage_spend: { keys: ['session_id', 'reported_ms'], omit: USAGE_LOCAL },
  account_bill_days: { keys: ['agent', 'account'], omit: USAGE_LOCAL },
  accounts: { keys: ['account', 'agent'], omit: USAGE_LOCAL },
};

/** The tables whose rows a usage pull carries (usage.ts): no conversation text. */
export const USAGE_RECORD_TABLES = ['usage_messages', 'usage_readings', 'usage_spend', 'accounts', 'account_bill_days'] as const;

export function recordsRoot(): string {
  return path.join(rootDir(), RECORDS_DIR);
}

/** One segment of a machine's log. */
export interface Segment {
  name: string;
  file: string;
  size: number;
  base: boolean;
  stamp?: string;
}

/** A machine's segments, oldest first. */
export function segments(host: string, root: string = recordsRoot()): Segment[] {
  const dir = path.join(root, host);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Segment[] = [];
  for (const name of names) {
    const m = SEGMENT_NAME.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({ name, file, size: st.size, base: !!m[3], stamp: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const writerCache = new Map<string, { stamp: string; writer?: string }>();

/** The writer lifetime stamped at the start of a segment; old development logs have none. */
function segmentWriter(s: Segment): string | undefined {
  const cached = writerCache.get(s.file);
  if (s.stamp && cached?.stamp === s.stamp) return cached.writer;
  const remember = (writer?: string): string | undefined => {
    if (writerCache.size > 1024) writerCache.clear();
    if (s.stamp) writerCache.set(s.file, { stamp: s.stamp, writer });
    return writer;
  };
  if (s.base) return remember(baseHeader(s.file)?.writer);
  let fd: number;
  try { fd = fs.openSync(s.file, 'r'); } catch { return undefined; }
  try {
    const buf = Buffer.alloc(128);
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, got).indexOf(10);
    if (nl < 0) return remember();
    const h = JSON.parse(buf.toString('utf8', 0, nl));
    return remember(h.t === 'writer' && typeof h.id === 'string' ? h.id : undefined);
  } catch { return undefined; } finally { fs.closeSync(fd); }
}

/** The machines whose logs this store holds. */
export function recordHosts(root: string = recordsRoot()): string[] {
  try {
    return fs.readdirSync(root).filter((h) => RECORD_HOST.test(h)).sort();
  } catch {
    return [];
  }
}

/** A base's first line, when it can be read: how many bytes follow it when the base is whole, where the history it holds
 *  begins (`from`; none: every segment before it), and the machine's label and platform as a batch line carries them. */
export function baseHeader(file: string): { bytes: number; headerBytes: number; at: number; from?: string; writer?: string; parts?: number; label?: string; platform?: string } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(BASE_HEADER_BYTES);
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, got).indexOf(0x0a);
    if (nl < 0) return null;
    const h = JSON.parse(buf.toString('utf8', 0, nl)) as { t?: unknown; bytes?: unknown; at?: unknown; from?: unknown; writer?: unknown; parts?: unknown; label?: unknown; platform?: unknown };
    if (h.t !== 'base' || typeof h.bytes !== 'number') return null;
    return { bytes: h.bytes, headerBytes: nl + 1, at: typeof h.at === 'number' ? h.at : 0, ...(typeof h.from === 'string' ? { from: h.from } : {}),
      ...(typeof h.parts === 'number' ? { parts: h.parts } : {}), ...(typeof h.writer === 'string' ? { writer: h.writer } : {}), ...(typeof h.label === 'string' ? { label: h.label } : {}), ...(typeof h.platform === 'string' ? { platform: h.platform } : {}) };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The newest base of a machine's log that is here whole, or null: what a reader reads it from (each segment before it
 *  that it covers, coverage says, is not read). */
export function wholeBase(segs: readonly Segment[], preferred?: string | null): Segment | null {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (!s.base) continue;
    const h = baseHeader(s.file);
    if (h && s.size === h.headerBytes + h.bytes) {
      // Disconnected writer lifetimes have no trustworthy clock order. Keep an already selected base unless this
      // one replaces it or continues its writer; a new index uses the deterministic filename order as its tie-break.
      if (preferred && preferred !== s.name) {
        const old = segs.find((s) => s.name === preferred);
        const held = old && wholeBase([old]);
        if (held && h.writer && segmentWriter(held) !== h.writer && !covers(coverage(segs), held.name)) return held;
      }
      return s;
    }
  }
  return null;
}

/** A whole base's explicit covered members, or an older development base's `from` interval. */
export interface Coverage {
  base: string;
  from?: string;
  segments?: ReadonlySet<string>;
  legacy?: Coverage[];
}

const coverageCache = new Map<string, { stamp: string; value: Coverage }>();

/** What the bases of a machine's log here whole cover, oldest first. */
export function coverage(segs: readonly Segment[]): Coverage[] {
  const out: Coverage[] = [];
  for (const s of segs) {
    if (!s.base) continue;
    const cached = coverageCache.get(s.file);
    if (s.stamp && cached?.stamp === s.stamp) { out.push(cached.value); continue; }
    const h = baseHeader(s.file);
    if (!h || s.size !== h.headerBytes + h.bytes) continue;
    const c: Coverage = { base: s.name, ...(h.from !== undefined ? { from: h.from } : {}) };
    if (h.parts !== undefined) {
      const names = new Set<string>();
      c.segments = names;
      c.legacy = [];
      let n = 0;
      for (const { rec } of readRecordLog([{ seg: s, from: h.headerBytes }])) {
        if (n === h.parts) break;
        if (rec.t !== 'cover') break;
        if (typeof rec.s === 'string') names.add(rec.s);
        else if (typeof rec.base === 'string') c.legacy.push({ base: rec.base, ...(typeof rec.from === 'string' ? { from: rec.from } : {}) });
        else break;
        n++;
      }
      if (n !== h.parts) continue;
    }
    out.push(c);
    if (coverageCache.size > 256) coverageCache.clear();
    if (s.stamp) coverageCache.set(s.file, { stamp: s.stamp, value: c });
  }
  return out;
}

/** Whether a whole base explicitly replaces this segment, or inherits an older base's coverage of it. */
export function covers(cov: readonly Coverage[], name: string): boolean {
  return cov.some((c) => c.segments ? c.segments.has(name) || covers(c.legacy ?? [], name)
    : name < c.base && (c.from === undefined || name >= c.from));
}

/** A name for the next segment: later than every segment there, whatever the clock says (one set back would otherwise
 *  name a segment before a base, which would take it for one it covers). */
function nextName(segs: readonly Segment[], base = false): string {
  const last = segs.length ? Number(SEGMENT_NAME.exec(segs[segs.length - 1].name)![1]) : 0;
  const ms = Math.max(Date.now(), last + 1);
  return `${String(ms).padStart(13, '0')}-${randomBytes(4).toString('hex')}${base ? '-base' : ''}.jsonl`;
}

/** The record's own columns: the row less what stays with this machine. */
export function recordRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const spec = RECORD_TABLES[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!spec.omit.includes(k)) out[k] = v;
  return out;
}

/**
 * What one catch-up publishes: lines gathered per machine while a transaction is open, appended to that machine's log
 * before the transaction commits (`flush`), so nothing the index holds goes unpublished. A record appended for a
 * transaction that then failed is harmless: replay is idempotent, and the next catch-up publishes the rows again.
 * Only this machine's own rows are published (`self`, every id its catch-ups have filed rows under).
 */
export class RecordWriter {
  private pending = new Map<string, string[]>();

  constructor(readonly self: ReadonlySet<string>) {}

  owns(machine: string): boolean {
    return this.self.has(machine);
  }

  private push(machine: string, rec: { t: string; r?: Record<string, unknown>; d?: Record<string, unknown>; clear?: string; s?: string }): void {
    if (!this.self.has(machine)) return;
    // The simulator's own sessions (`oak demo`, demo.ts: `demo-<8 hex>`) stay on the machine that ran them.
    const session = rec.r?.session_id ?? rec.d?.session_id ?? rec.clear ?? rec.s;
    if (typeof session === 'string' && DEMO_SESSION.test(session)) return;
    let list = this.pending.get(machine);
    if (!list) this.pending.set(machine, (list = []));
    list.push(JSON.stringify(rec));
  }

  row(machine: string, table: string, row: Record<string, unknown>): void {
    this.push(machine, { t: table, r: recordRow(table, row) });
  }

  delete(machine: string, table: string, key: Record<string, unknown>): void {
    this.push(machine, { t: table, d: key });
  }

  clear(machine: string, table: string, session: string): void {
    this.push(machine, { t: table, clear: session });
  }

  purge(machine: string, session: string): void {
    this.push(machine, { t: 'purge', s: session });
  }

  get size(): number {
    let n = 0;
    for (const l of this.pending.values()) n += l.length;
    return n;
  }

  discard(): void {
    this.pending.clear();
  }

  /** Append what is pending, each machine's to its own log, under that log's lock. `appended` hears where each append
   *  went. Throws when a log cannot be written, before anything else is lost: the caller's transaction rolls back. */
  flush(appended?: (host: string, segment: string, from: number, to: number) => void): void {
    for (const [host, lines] of this.pending) {
      if (!lines.length) continue;
      const text = JSON.stringify({ t: 'batch', at: Date.now(), v: RECORD_FORMAT, label: localSyncLabel(), platform: process.platform }) + '\n' + lines.join('\n') + '\n';
      appendRecords(host, text, appended);
    }
    this.pending.clear();
  }
}

/** Local append receipt, never synced: only these bytes may be extended or sealed by this writer. */
interface WriterState { id: string; segment?: string; bytes?: number }

function writerState(host: string): WriterState | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(recordsRoot(), host, '.writer'), 'utf8'));
    return typeof v.id === 'string' && /^[0-9a-f]{16}$/.test(v.id) ? v : null;
  } catch {
    return null;
  }
}

function saveWriter(host: string, state: WriterState): void {
  const file = path.join(recordsRoot(), host, '.writer');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** An immutable segment has a final seal naming the byte offset before it. A complete-line prefix has no seal. */
export function sealedSegment(s: Segment, end?: number): boolean {
  let fd: number;
  try { fd = fs.openSync(s.file, 'r'); } catch { return false; }
  try {
    const from = Math.max(0, s.size - 128);
    const buf = Buffer.alloc(s.size - from);
    const got = fs.readSync(fd, buf, 0, buf.length, from);
    if (got !== buf.length || buf[got - 1] !== 10) return false;
    const start = buf.lastIndexOf(10, got - 2) + 1;
    const rec = JSON.parse(buf.toString('utf8', start, got - 1));
    return rec.t === 'seal' && rec.bytes === from + start && (end === undefined || rec.bytes === end);
  } catch { return false; } finally { fs.closeSync(fd); }
}

/** Segments whose final size is known independently of a received copy's EOF. */
export function completeSegments(host: string, segs: readonly Segment[]): Set<string> {
  const w = writerState(host);
  return new Set(segs.filter((s) => s.base ? wholeBase([s]) !== null
    : (w?.segment === s.name && w.bytes === s.size) || sealedSegment(s)).map((s) => s.name));
}

function sealSegment(s: Segment): number {
  const text = JSON.stringify({ t: 'seal', bytes: s.size }) + '\n';
  fs.appendFileSync(s.file, text, { mode: 0o600 });
  return s.size + Buffer.byteLength(text);
}

/** Close the local writer's active segment before publishing it to sync. Received copies are never sealed here. */
export function sealRecords(host: string): void {
  const dir = path.join(recordsRoot(), host);
  if (!writerState(host)?.segment) return;
  withFileMutation(dir, () => {
    const w = writerState(host);
    if (!w?.segment) return;
    const s = segments(host).find((s) => s.name === w.segment);
    if (s && s.size === w.bytes && !s.base) sealSegment(s);
    saveWriter(host, { id: w.id });
  }, 10_000);
}

/** Append `text` (whole lines) to a machine's log, starting a new segment past SEGMENT_MAX_BYTES or after a base. */
function appendRecords(host: string, text: string, appended?: (host: string, segment: string, from: number, to: number) => void): void {
  const dir = path.join(recordsRoot(), host);
  withFileMutation(dir, () => {
    keepFromOldClean(recordsRoot());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const segs = segments(host);
    const w = writerState(host) ?? { id: (segs.length ? segmentWriter(segs[segs.length - 1]) : undefined) ?? randomBytes(8).toString('hex') };
    const active = segs.find((s) => s.name === w.segment && s.size === w.bytes && !s.base);
    if (active && active.size >= SEGMENT_MAX_BYTES) {
      const end = sealSegment(active);
      appended?.(host, active.name, active.size, end);
    }
    const seg = active && active.size < SEGMENT_MAX_BYTES ? active : { name: nextName(segs), size: 0 };
    const file = path.join(dir, seg.name);
    if (!seg.size) text = JSON.stringify({ t: 'writer', id: w.id }) + '\n' + text;
    fs.appendFileSync(file, text, { mode: 0o600 });
    const size = seg.size + Buffer.byteLength(text);
    saveWriter(host, { id: w.id, segment: seg.name, bytes: size });
    appended?.(host, seg.name, seg.size, size);
  }, 10_000);
}

/** Every byte of a machine's log here, and how much of it a base holds. */
export function logBytes(host: string): { total: number; base: number } {
  let total = 0;
  let base = 0;
  for (const s of segments(host)) {
    total += s.size;
    if (s.base) base = s.size;
  }
  return { total, base };
}

/**
 * Compact a machine's own log: write a base holding every row the index has for it (`dump` yields them, already as
 * record lines, oldest table first), whose history begins at `from` (undefined: every segment before it), then remove
 * every segment before the base that it covers. Under the log's lock, so no append runs meanwhile; the caller holds the
 * index's catch-up lease, so the rows do not move either. Returns the base's name and size, or null when nothing was
 * written.
 */
export function writeBase(host: string, from: string | undefined, dump: (write: (line: string) => void) => void): { name: string; bytes: number; removed: number } | null {
  const dir = path.join(recordsRoot(), host);
  return withFileMutation(dir, () => {
    keepFromOldClean(recordsRoot());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const before = segments(host);
    const complete = completeSegments(host, before);
    const replaced = before.filter((s) => complete.has(s.name) && (from === undefined || s.name >= from));
    const names = new Set(replaced.map((s) => s.name));
    const legacy: Coverage[] = [];
    for (const c of coverage(replaced)) {
      if (c.segments) {
        for (const n of c.segments) names.add(n);
        legacy.push(...c.legacy ?? []);
      } else legacy.push(c);
    }
    const parts = names.size + legacy.length;
    const writer = writerState(host)?.id ?? randomBytes(8).toString('hex');
    const name = nextName(before, true);
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    let at = BASE_HEADER_BYTES;
    try {
      const chunk: string[] = [];
      let pending = 0;
      const out = (): void => {
        if (!chunk.length) return;
        const buf = Buffer.from(chunk.join(''), 'utf8');
        fs.writeSync(fd, buf, 0, buf.length, at);
        at += buf.length;
        chunk.length = 0;
        pending = 0;
      };
      const line = (text: string): void => {
        chunk.push(text, '\n');
        pending += text.length;
        if (pending > 1024 * 1024) out();
      };
      // Exact membership prevents an unseen segment, even one named inside `from`'s clock range, being covered.
      for (const n of names) line(JSON.stringify({ t: 'cover', s: n }));
      for (const c of legacy) line(JSON.stringify({ t: 'cover', base: c.base, from: c.from }));
      dump(line);
      out();
      const head = JSON.stringify({ t: 'base', bytes: at - BASE_HEADER_BYTES, at: Date.now(), v: RECORD_FORMAT, label: localSyncLabel(), platform: process.platform, from, writer, parts });
      if (Buffer.byteLength(head) >= BASE_HEADER_BYTES) throw new Error('the base header does not fit');
      fs.writeSync(fd, head.padEnd(BASE_HEADER_BYTES - 1, ' ') + '\n', 0, 'utf8');
      fs.fsyncSync(fd);
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.closeSync(fd);
    fs.renameSync(tmp, path.join(dir, name));
    saveWriter(host, { id: writer });
    let removed = 0;
    for (const s of replaced) {
      try {
        fs.rmSync(s.file, { force: true });
        removed++;
      } catch {
        /* the next compaction removes it */
      }
    }
    return { name, bytes: at, removed };
  }, 30_000);
}

/** Remove this machine's copies of another machine's segments that a base it holds whole covers. The base holds every
 *  row they held that is still that machine's; what is gone from it went on purpose there (a forgotten session). */
export function dropCovered(host: string): number {
  const segs = segments(host);
  const cov = coverage(segs);
  let n = 0;
  for (const s of segs) {
    if (!covers(cov, s.name)) continue;
    try {
      fs.rmSync(s.file, { force: true });
      n++;
    } catch {
      /* the next catch-up */
    }
  }
  return n;
}

/** One record read from a log, with where it ends (what a cursor records). */
export interface LogRecord {
  segment: string;
  end: number;
  rec: Record<string, unknown>;
}

/** How far an index has read a machine's log: the base it read it from (null: none yet), and in each segment since, the
 *  byte it read to. Per segment, since oak sync can land them in any order: a later segment before an earlier one ends,
 *  or a base after segments it covers. `partial` while a read of it stopped part way (ingest.ts applyRecordLogs): until
 *  it is read to its end, this index lacks some of what the log holds. */
export interface LogState {
  base: string | null;
  read: Record<string, number>;
  partial?: true;
}

/** Where a segment's records begin: past a base's header. */
function startOf(s: Segment): number {
  return s.base ? baseHeader(s.file)?.headerBytes ?? s.size : 0;
}

/**
 * What an index reads next of a machine's log (`state`: what it has read). A base newer than the one it read from, here
 * whole, replaces everything it read (`reset`): it is read from its start, with every segment no base covers, before it
 * (the log its machine kept before it was set up again) or after it. Otherwise each segment no base covers is read from
 * where it was read to, in writer order (unrelated history before the selected base); when a segment has bytes left
 * to read before one that has been read since (it
 * landed after it), the later ones are read again after it, so that each row ends as the newest record left it. A base
 * that is not here whole, and every segment a whole base covers, is never read.
 */
export function logPlan(host: string, state: LogState | null): { reset: Segment | null; steps: { seg: Segment; from: number }[] } {
  const segs = segments(host);
  const cov = coverage(segs);
  const base = wholeBase(segs, state?.base);
  const reset = base && base.name !== state?.base ? base : null;
  const read = reset ? {} : state?.read ?? {};
  const live = segs.filter((s) => (!s.base || cov.some((c) => c.base === s.name)) && !covers(cov, s.name));
  const writer = base ? segmentWriter(base) : undefined;
  if (base && writer) {
    // Unrelated restored history fills the archive first. Only this base's writer may supersede its rows, even when
    // an earlier lifetime's clock put its filenames after the base. The same ordering is used on incremental replay.
    const rank = (s: Segment): number => s.name === base.name ? 1 : segmentWriter(s) === writer && s.name > base.name ? 2 : 0;
    const ranks = new Map(live.map((s) => [s.name, rank(s)]));
    live.sort((a, b) => ranks.get(a.name)! - ranks.get(b.name)! || a.name.localeCompare(b.name));
  }
  const steps: { seg: Segment; from: number }[] = [];
  let again = false;
  const starts = live.map(startOf);
  let lastRead = -1;
  for (let i = 0; i < live.length; i++) if ((read[live[i].name] ?? starts[i]) > starts[i]) lastRead = i;
  for (let i = 0; i < live.length; i++) {
    const s = live[i];
    const done = read[s.name] ?? starts[i];
    if (again) steps.push({ seg: s, from: starts[i] });
    else if (s.size > done && !(s.size - done < 128 && sealedSegment(s, done))) {
      steps.push({ seg: s, from: done });
      again = i < lastRead;
    }
  }
  return { reset, steps };
}

/** The whole lines of the planned segments, in order, each from where the plan starts it: a line still being written
 *  waits for its newline. A catch-up out of time stops reading and is not caught up (ingest.ts applyRecordLogs). */
export function* readRecordLog(steps: readonly { seg: Segment; from: number }[]): Generator<LogRecord> {
  for (const { seg: s, from } of steps) {
    let offset = from;
    if (offset >= s.size) continue;
    let fd: number;
    try {
      fd = fs.openSync(s.file, 'r');
    } catch {
      continue;
    }
    try {
      while (offset < s.size) {
        const len = Math.min(8 * 1024 * 1024, s.size - offset);
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, offset);
        const nl = buf.subarray(0, got).lastIndexOf(0x0a);
        if (nl < 0) break; // a line still being written (or one longer than a read: not one a writer makes)
        let at = 0;
        while (at <= nl) {
          const e = buf.indexOf(0x0a, at);
          const line = buf.toString('utf8', at, e);
          at = e + 1;
          if (!line.trim()) continue;
          let rec: Record<string, unknown>;
          try {
            rec = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue; // a torn line: never one a writer leaves, skipped
          }
          if (rec && typeof rec === 'object') yield { segment: s.name, end: offset + at, rec };
        }
        offset += nl + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** Bytes of a machine's log an index has yet to read (logPlan): what a first build has to read. */
export function unreadBytes(host: string, state: LogState | null): number {
  return logPlan(host, state).steps.reduce((n, x) => n + Math.max(0, x.seg.size - x.from), 0);
}

/** The index's statement for one table's record, by the columns both the record and the table have. */
export function recordColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[]).map((c) => c.name));
}
