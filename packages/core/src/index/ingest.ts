/**
 * Catching the index up with the files on disk: this machine's Claude Code transcripts (with their subagents), Codex
 * rollouts, OAK's store (each session's log, capture events, attention, comments and blob inventory), the sessions
 * deleted on purpose, plans, memories and skills, and the copies of other machines' logs that oak sync keeps under
 * `sync/replicas/`, each marked with the machine it came from.
 *
 * How:
 * - One pass of directory listings and stats finds what changed since the last catch-up, by each file's stamp (device,
 *   inode, size and modification time). Nothing unchanged is read.
 * - Whatever did change is derived with core's own readers, so the index can never disagree with the views about what
 *   a file says: the session listing's facts (`listingFacts`), the search's fold (`foldSearchDocs`), the log's fold
 *   with its re-keying (`readLog`), and the transcript facts behind actions, subagents and workflow runs.
 * - A transcript is append-only, so its asks and answers are folded from a byte cursor kept beside a hash of the
 *   file's head and of the bytes just before the cursor. A new inode, a shorter file or either hash changing means the
 *   file was replaced or rewritten, and its rows are rebuilt from the start. The rows and the cursor are written in
 *   one transaction, so a catch-up killed midway resumes where its last commit left it, with nothing twice.
 * - Each transaction holds at most 5,000 rows or about 50 ms of work.
 * - Newest sessions first, so a first build that runs out of time (or is stopped) has the ones that matter.
 *
 * What the index keeps is not lost when its source goes. A session whose files are all gone (cleaned by OAK, swept by
 * Claude Code's retention, deleted by hand) is ARCHIVED: it keeps every row, marked with when and why. Only a deliberate
 * delete (`oak sessions --delete`, or oak sync's tombstone for one made on another machine) purges a session's rows,
 * its full-text entries with them.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { claudeConfigDir } from '../paths';
import { graphemeHead } from '../graphemes';
import { rootDir, allStoreSessionIds, logPath, storeDir, hiddenSessions, readLogFile, readOperations, readSkips, isSafeSessionId, isReservedStoreDir, keepOwnFoldersFromOldClean, type EditRecord } from '../store';
import { listWorkspaces, isMirroredTranscript } from '../session';
import {
  discoverListing, listingFacts, normalizeSessionTitle, preferredSessionTitle, sessionCounts, withPendingQuestion, type ListingTranscript, type SessionListingFacts,
} from '../observe';
import { announceDelayMs } from '../notify';
import { codexHome, codexSessionSources, codexRolloutHead, codexTurnOpen, codexUsage, type CodexRolloutHead } from '../codex';
import { codexDerivedTurnOpen, codexUnsettledReads, codexUsageDeltas } from '../codex-events';
import { foldSearchDocs, type SearchDoc } from '../search';
import { PromptReader, PromptReaderState } from '../asks';
import { sessionPrompts, promptId } from '../prompts';
import { parseActions } from '../actions';
import { parseSubagents, finishedWorkerStamps } from '../subagents';
import { parseWorkflows } from '../workflows';
import { reviewEdits, groupMembers } from '../groups';
import { cancelledMemberIds } from '../units';
import { lineDelta } from '../format';
import { readComments } from '../comments';
import { readAttention, readTabLink } from '../capture';
import { machineHostTag, claudeAccountTag } from '../machine-usage';
import { fileProjectIdentity, readMountTable, type SyncShare } from '../sync-identity';
import { publishPendingPaths } from './pending-paths';
import { readManifest, readTombstones, readSeen, manifestKey, syncDir, keptPrefs, syncLockHeld, SYNC_RUN_STALE_MS, type SyncManifestEntry } from '../sync-state';
import { readCleanupPeriodDays, CLAUDE_DEFAULT_RETENTION_DAYS } from '../sync';
import { write, tryLease, renewLease, releaseLease, leaseHolder, dataVersion, getMeta, setMeta, forgetInLog, forgetElsewhere, ofSessions, leaseWanted, wantLease, unwantLease, LEASE_MS } from './db';
import { SESSION_TABLES, INGEST_VERSION, WORKERS_NONE } from './schema';
import { upsertSql, fitRow } from './rows';
import { RecordWriter, recordRow, segments, recordHosts, readRecordLog, logPlan, dropCovered, unreadBytes, logBytes, writeBase, recordColumns, wholeBase, baseHeader, completeSegments, RECORD_TABLES, RECORD_FORMAT, USAGE_RECORD_TABLES, DEMO_SESSION, DEMO_GLOB, type LogState } from './records';
import { priceUsage, PRICE_VERSION } from '../pricing';
import { delegatedDir, isDelegatedId, readDelegated } from '../delegated';

/** The most rows one transaction writes. */
export const TX_ROWS = 5000;
/** About how long one transaction holds the write lock before it commits and lets others in. */
export const TX_MS = 50;
/** How much of a transcript's head, and of the bytes before its cursor, are hashed to tell an append from a rewrite. */
const GUARD_BYTES = 4096;
/** The most transcript bytes one read takes in: a cursor advances in chunks, each committed with its rows. */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** The most text a note keeps (plans, memories and skills are small; a pasted log is not). */
const NOTE_CAP = 256 * 1024;
/** The most transcript lines folded into one transaction. */
const FOLD_LINES = 1000;
/** How many of a transcript's most recent message ids keep what was folded of them across catch-ups. Only an answer
 *  still being written can gain lines after a catch-up, and each kept message holds its whole texts: 64 of them made
 *  this state 13% of an index (44 MB for 2 GB of transcripts, measured). */
const SEEN_KEEP = 4;
/** A worker's transcript is re-read while its session was written within this long: an older one is finished. */
const WORK_WINDOW_MS = 24 * 60 * 60_000;

/** Part of every session's stamp, so a bump of INGEST_VERSION (schema.ts) re-derives every session's facts. */
const FACTS_CODE = `v${INGEST_VERSION}`;

interface Stamp {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** A file's stats, or null when it is not there. Most of the files a catch-up looks at are not (a session with no store,
 *  no subagents), and an exception per absent file was most of a warm catch-up's time. */
function stat(file: string): fs.Stats | null {
  try {
    return fs.statSync(file, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

const stampOf = (st: fs.Stats | null): string => (st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}` : '-');

/** What one session holds on this machine, by the stamps of its files. */
interface SessionSources {
  id: string;
  transcripts: { t: ListingTranscript; st: fs.Stats }[];
  rollouts: { file: string; st: fs.Stats }[];
  /** Its store folder exists. */
  store: boolean;
  files: Record<string, fs.Stats | null>;
  /** The newest modification time among its files: the order a build takes sessions in. */
  newest: number;
  /** The folder beside each of its transcripts that holds its workers' files (`<project>/<id>/`), when there is one. */
  sides: Map<string, fs.Stats>;
  /** Its store's link to the terminal app's native tab (`tab.json`), which no listing fact depends on. */
  tab: fs.Stats | null;
}

const STORE_FILES = ['log.jsonl', 'capture-events.jsonl', 'agent.json', 'attention.json', 'attention-log.jsonl', 'blobs', 'staging', 'capture-skips'] as const;

/** A rollout's session id from its name (`rollout-<time>-<uuid>.jsonl`), as Codex names every rollout. */
const ROLLOUT_ID = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Everything a catch-up compares, from listings and stats alone. */
interface Discovery {
  sessions: Map<string, SessionSources>;
  hidden: Set<string>;
  /** Codex's thread names (`session_index.jsonl`), which title its sessions. */
  codexIndex: string;
  notes: { kind: 'plan' | 'memory' | 'skill'; file: string; project: string | null; st: fs.Stats }[];
  replicas: { origin: string; session: string; file: string; st: fs.Stats }[];
  /** The delegated agents' records (delegated.ts), each with the stamp of its record and its session link. */
  delegated: { id: string; stamp: string }[];
}

function walkFiles(dir: string, depth: number, accept: (name: string) => boolean, out: { file: string; st: fs.Stats }[]): void {
  if (depth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, depth - 1, accept, out);
    else if (e.isFile() && accept(e.name)) {
      const st = stat(full);
      if (st) out.push({ file: full, st });
    }
  }
}

/** A rollout's head facts, from the index's record of it while its stamp is unchanged (only a rollout whose name does
 *  not carry its id is ever read for it). */
function rolloutHeadCached(db: DatabaseSync, file: string, st: fs.Stats): CodexRolloutHead | null {
  const key = `rollout-head:${file}`;
  const row = db.prepare('SELECT ino, size, mtime_ms, state FROM ingest_state WHERE source = ?').get(key) as { ino: number; size: number; mtime_ms: number; state: string } | undefined;
  if (row && row.ino === st.ino && row.size === st.size && row.mtime_ms === st.mtimeMs) {
    try {
      return JSON.parse(row.state) as CodexRolloutHead | null;
    } catch {
      /* re-read */
    }
  }
  const head = codexRolloutHead(file);
  db.prepare(`INSERT INTO ingest_state (source, kind, machine_id, ino, size, mtime_ms, state, updated_ms) VALUES (?, 'rollout-head', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET ino = excluded.ino, size = excluded.size, mtime_ms = excluded.mtime_ms, state = excluded.state, updated_ms = excluded.updated_ms`)
    .run(key, machineHostTag(), st.ino, st.size, st.mtimeMs, JSON.stringify(head), Date.now());
  return head;
}

/** Everything a catch-up compares, from listings and stats alone. With `only`, those sessions alone are looked at (OAK's
 *  cleanup records what it is about to remove, from an editor too, where a walk of every file would hold its host up). */
function discover(db: DatabaseSync, only?: Set<string>): Discovery {
  const sessions = new Map<string, SessionSources>();
  const of = (id: string): SessionSources => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { id, transcripts: [], rollouts: [], store: false, files: {}, newest: 0, sides: new Map(), tab: null }));
    return s;
  };
  for (const w of listWorkspaces()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(w.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    for (const e of entries) {
      const n = e.name;
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      if (!isSafeSessionId(id) || (only && !only.has(id))) continue;
      const file = path.join(w.dir, n);
      const st = stat(file);
      if (!st || !st.isFile()) continue;
      const s = of(id);
      s.transcripts.push({ t: { id, file, label: w.label }, st });
      s.newest = Math.max(s.newest, st.mtimeMs);
      // Only a folder that is there is stat'ed: most sessions have none.
      if (dirs.has(id)) {
        const side = stat(path.join(w.dir, id));
        if (side) s.sides.set(file, side);
      }
    }
  }
  const rollouts: { file: string; st: fs.Stats }[] = [];
  const isJsonl = (n: string): boolean => n.endsWith('.jsonl');
  walkFiles(path.join(codexHome(), 'sessions'), 5, isJsonl, rollouts);
  walkFiles(path.join(codexHome(), 'archived_sessions'), 5, isJsonl, rollouts);
  rollouts.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const place = (): void => {
    for (const r of rollouts) {
      const named = ROLLOUT_ID.exec(path.basename(r.file))?.[1];
      const head = named ? null : rolloutHeadCached(db, r.file, r.st);
      if (only && named && !only.has(named)) continue;
      const id = named ?? (head?.meta?.id ?? head?.meta?.session_id);
      if (typeof id !== 'string' || !isSafeSessionId(id) || (only && !only.has(id))) continue;
      const s = of(id);
      s.rollouts.push(r);
      s.newest = Math.max(s.newest, r.st.mtimeMs);
    }
  };
  // The write lock only where a rollout's name does not carry its id (its head is read and recorded): a catch-up that
  // finds nothing changed takes none (catchUp, nothingToDo).
  if (rollouts.some((r) => !ROLLOUT_ID.test(path.basename(r.file)))) write(db, place);
  else place();
  for (const id of only ? [...only].filter((x) => !isReservedStoreDir(x) && fs.existsSync(storeDir(x))) : allStoreSessionIds()) {
    const s = of(id);
    s.store = true;
    const dir = storeDir(id);
    let names: Set<string>;
    try {
      names = new Set(fs.readdirSync(dir));
    } catch {
      names = new Set();
    }
    for (const f of STORE_FILES) {
      const st = names.has(f) ? stat(path.join(dir, f)) : null;
      s.files[f] = st;
      if (st && f !== 'blobs' && f !== 'staging') s.newest = Math.max(s.newest, st.mtimeMs);
    }
    // Comments: where this build keeps them and where an earlier one did.
    s.files['comments'] = names.has('comments.json') ? stat(path.join(dir, 'comments.json')) : stat(path.join(rootDir(), 'changemap-cache', id, 'comments.json'));
    s.tab = names.has('tab.json') ? stat(path.join(dir, 'tab.json')) : null;
    // A folder that holds none of a session's own files (only a cache a reader left) is no evidence the session is here.
    if (!Object.values(s.files).some(Boolean) && !s.transcripts.length && !s.rollouts.length) sessions.delete(id);
    else if (!Object.values(s.files).some(Boolean)) s.store = false;
  }
  const notes: Discovery['notes'] = [];
  const replicas: Discovery['replicas'] = [];
  if (only) return { sessions, hidden: hiddenSessions(), codexIndex: stampOf(stat(path.join(codexHome(), 'session_index.jsonl'))), notes, replicas, delegated: [] };
  const claude = claudeConfigDir();
  const md = (n: string): boolean => n.endsWith('.md');
  const plans: { file: string; st: fs.Stats }[] = [];
  walkFiles(path.join(claude, 'plans'), 8, md, plans);
  for (const p of plans) notes.push({ kind: 'plan', file: p.file, project: null, st: p.st });
  const skills: { file: string; st: fs.Stats }[] = [];
  walkFiles(path.join(claude, 'skills'), 8, md, skills);
  for (const p of skills) if (!path.relative(path.join(claude, 'skills'), p.file).startsWith(`synced${path.sep}`)) notes.push({ kind: 'skill', file: p.file, project: null, st: p.st });
  for (const w of listWorkspaces()) {
    const mem: { file: string; st: fs.Stats }[] = [];
    walkFiles(path.join(w.dir, 'memory'), 0, md, mem);
    for (const p of mem) notes.push({ kind: 'memory', file: p.file, project: w.label, st: p.st });
  }
  const rdir = path.join(syncDir(), 'replicas');
  let origins: string[] = [];
  try {
    origins = fs.readdirSync(rdir);
  } catch {
    /* no replicas here */
  }
  for (const origin of origins) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(origin)) continue;
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(path.join(rdir, origin));
    } catch {
      continue;
    }
    for (const session of ids) {
      // The simulator's sessions (`oak demo`) are never another machine's here, though oak sync may have copied them.
      if (!isSafeSessionId(session) || DEMO_SESSION.test(session)) continue;
      const file = path.join(rdir, origin, session, 'log.jsonl');
      const st = stat(file);
      if (st) replicas.push({ origin, session, file, st });
    }
  }
  const delegated: Discovery['delegated'] = [];
  let records: string[] = [];
  try {
    records = fs.readdirSync(delegatedDir());
  } catch {
    /* none started here */
  }
  for (const n of records) {
    if (!n.endsWith('.json') || !isDelegatedId(n.slice(0, -5))) continue;
    const id = n.slice(0, -5);
    delegated.push({ id, stamp: `${stampOf(stat(path.join(delegatedDir(), n)))}|${stampOf(stat(path.join(delegatedDir(), `${id}.session`)))}` });
  }
  return { sessions, hidden: hiddenSessions(), codexIndex: stampOf(stat(path.join(codexHome(), 'session_index.jsonl'))), notes, replicas, delegated };
}

/** The stamp the listing's facts for a session were derived at: every file they read, a Codex title's other files
 *  (`titleInputs`, from the facts derived last) included. */
function factsStamp(s: SessionSources, codexIndex: string, titleInputs: readonly string[] = []): string {
  const h = createHash('sha256').update(FACTS_CODE);
  for (const file of titleInputs) h.update(`\u0000i${file}\u0001${stampOf(stat(file))}`);
  for (const t of s.transcripts) h.update(`\u0000t${t.t.file}\u0001${stampOf(t.st)}`);
  for (const r of s.rollouts) h.update(`\u0000r${r.file}\u0001${stampOf(r.st)}`);
  for (const f of ['log.jsonl', 'capture-events.jsonl', 'agent.json', 'blobs', 'staging'] as const) h.update(`\u0000${f}\u0001${stampOf(s.files[f] ?? null)}`);
  if (s.rollouts.length || s.files['agent.json']) h.update(`\u0000codex-index\u0001${codexIndex}`);
  return h.digest('hex').slice(0, 24);
}

/** A row to write and the columns it fills, in order. */
type Row = Record<string, string | number | null>;

/** What a catch-up is doing: the database, the clock it keeps, and what it found. */
interface Run {
  db: DatabaseSync;
  me: string;
  now: number;
  deadline: number;
  problems: string[];
  shares: SyncShare[] | null;
  /** Rows written in the open transaction, and when it opened. */
  txRows: number;
  txAt: number;
  inTx: boolean;
  manifest: ReturnType<typeof readManifest> | null;
  afterBatch?: () => void;
  /** This machine's record log: what the open transaction publishes, appended before it commits (records.ts). */
  pub: RecordWriter;
  /** The usage write sequence (`meta.usage_seq`): each usage row this machine writes takes the next one. */
  useq: number | null;
  /** This machine's Claude account (machine-usage.ts claudeAccountTag), read once per catch-up. */
  account?: string | null;
  /** The usage rows the open transaction changed, published as they stand when it commits: a message written over
   *  several lines is published once, at its largest snapshot. */
  usagePub: Map<string, { machine: string; values: (string | number | null)[] }>;
  /** When the first permission prompt left unpublished in its wait (ingestAttention) becomes due here. */
  handsDueAt?: number;
  /** Which sessions this machine's store holds (storeHere), asked once a catch-up. */
  storeHere: Map<string, boolean>;
  /** Each prompt left so: its session and the hand's `ts`. */
  handsDue?: { id: string; ts: number }[];
  /** The sessions another machine's log forgot that this pass applied (a purge record, or a base without them), by that
   *  machine: forgotten in the folder's other index files and out of the write-ahead log once the logs are applied. */
  forgotten: Map<string, Set<string>>;
}

/** An attention unit's state while its permission prompt waits to be published: the next pass publishes it once due. */
const DEFERRED = 'deferred:';

/** A run of the catch-up's writers on `db`, publishing this machine's own rows (every machine id its catch-ups filed
 *  rows under: the machines it records as itself). */
function newRun(db: DatabaseSync, opts: { now: number; deadline: number; problems: string[]; afterBatch?: () => void }): Run {
  const self = new Set((db.prepare('SELECT machine_id FROM machines WHERE is_self = 1').all() as { machine_id: string }[]).map((m) => m.machine_id));
  self.add(machineHostTag());
  return { db, me: machineHostTag(), now: opts.now, deadline: opts.deadline, problems: opts.problems, shares: null, txRows: 0, txAt: 0, inTx: false, manifest: null,
    afterBatch: opts.afterBatch, pub: new RecordWriter(self), useq: null, usagePub: new Map(), storeHere: new Map(), forgotten: new Map() };
}

function begin(r: Run): void {
  if (r.inTx) return;
  r.db.exec('BEGIN IMMEDIATE');
  r.inTx = true;
  r.txRows = 0;
  r.txAt = Date.now();
  // The write sequence as the index holds it now, inside the write lock: another process's catch-up (one that took a
  // lapsed lease over) may have moved it, and two writes must never share one.
  r.useq = null;
}

/** Renew the catch-up lease; a holder that lost it (stalled past it, and another process took it over) winds down. */
function keepLease(r: Run): void {
  if (!renewLease(r.db)) r.deadline = 0;
}

/** Commit, after appending what the transaction publishes to the record log: a record the index holds is in the log
 *  first, so none is left unpublished by a process stopped between the two. */
function commit(r: Run): void {
  if (!r.inTx) return;
  if (r.useq !== null) setMeta(r.db, 'usage_seq', String(r.useq));
  for (const [, u] of r.usagePub) pubValues(r, 'usage_messages', u.machine, USAGE_COLS, u.values);
  r.usagePub.clear();
  if (r.pub.size) r.pub.flush((host, segment, from, to) => advanceOwnCursor(r.db, host, segment, from, to));
  r.db.exec('COMMIT');
  r.inTx = false;
}

/** This index applied its own append (it holds those rows already): it has read that segment past it, when it had read
 *  it to where the append began. Otherwise something else appended meanwhile, which the next catch-up reads, this too. */
function advanceOwnCursor(db: DatabaseSync, host: string, segment: string, from: number, to: number): void {
  const st = logState(db, host) ?? { base: null, read: {} };
  if ((st.read[segment] ?? 0) !== from) return;
  st.read[segment] = to;
  setLogState(db, host, st);
}

/** How far this index has read a machine's record log (records.ts LogState). */
export function logState(db: DatabaseSync, host: string): LogState | null {
  const row = db.prepare('SELECT state FROM ingest_state WHERE source = ?').get(`records:${host}`) as { state: string | null } | undefined;
  try {
    const v = row?.state ? (JSON.parse(row.state) as LogState) : null;
    return v && typeof v === 'object' && v.read && typeof v.read === 'object' ? { base: typeof v.base === 'string' ? v.base : null, read: { ...v.read }, ...(v.partial === true ? { partial: true as const } : {}) } : null;
  } catch {
    return null;
  }
}

function setLogState(db: DatabaseSync, host: string, st: LogState): void {
  db.prepare(upsertSql('ingest_state', ['source'], ['source', 'kind', 'machine_id', 'cursor', 'state', 'updated_ms']))
    .run(`records:${host}`, 'records', host, 0, JSON.stringify(st), Date.now());
}

/** Commit when this transaction has held enough; a unit of work calls it only where its rows and its stamp agree. */
function breathe(r: Run): void {
  if (r.inTx && (r.txRows >= TX_ROWS || Date.now() - r.txAt >= TX_MS)) {
    commit(r);
    keepLease(r);
  }
}

function count(r: Run, n = 1): void {
  r.txRows += n;
}

function rollback(r: Run): void {
  r.pub.discard();
  r.usagePub.clear();
  r.useq = null;
  if (!r.inTx) return;
  try {
    r.db.exec('ROLLBACK');
  } catch {
    /* already gone */
  }
  r.inTx = false;
}

/** The next usage write sequence (see Run.useq). */
function nextSeq(r: Run): number {
  if (r.useq === null) r.useq = Number(getMeta(r.db, 'usage_seq') ?? 0);
  return ++r.useq;
}

/** Publish a row this run wrote, from the values it wrote (`cols` and `values` as bound), when the machine it is filed
 *  under is this one. */
function pubValues(r: Run, table: string, machine: string, cols: readonly string[], values: readonly (string | number | null)[]): void {
  if (!r.pub.owns(machine)) return;
  const row: Record<string, unknown> = {};
  cols.forEach((c, i) => { row[c] = values[i]; });
  r.pub.row(machine, table, row);
}

/** Publish a row as the index holds it now (after an update of some of its columns), read back by its key. A prompt's
 *  ask and answer are read as bytes: node:sqlite on Node 22 returns a text holding a NUL cut there. */
function pubStored(r: Run, table: string, machine: string, key: Record<string, string | number | null>): void {
  if (!r.pub.owns(machine)) return;
  const names = Object.keys(key);
  const cols = table === 'prompts' ? '*, CAST(text AS BLOB) AS text, CAST(response AS BLOB) AS response' : '*';
  const row = r.db.prepare(`SELECT ${cols} FROM ${table} WHERE machine_id = ? AND ${names.map((k) => `${k} = ?`).join(' AND ')}`)
    .get(machine, ...names.map((k) => key[k])) as Record<string, unknown> | undefined;
  if (!row) return;
  for (const [k, v] of Object.entries(row)) if (v instanceof Uint8Array) row[k] = utf8(v);
  r.pub.row(machine, table, row);
}

/** How often a row that changes with every turn (a running session's own row, the answer still being written) is
 *  published again: what changed between is published by the next, or by the catch-up that finds it waiting
 *  (`publishWaiting`), so a log does not grow by a copy of an answer per read. */
export const PUBLISH_MS = 60_000;

/** A session row's columns that move with every turn: a change of only these waits for PUBLISH_MS. */
const SESSION_VOLATILE = new Set(['last_active_ms', 'last_turn_ms', 'capture_ms', 'tokens', 'cached', 'duration_ms', 'store_bytes', 'edits', 'pending', 'files',
  'added', 'removed', 'last_edit_id', 'gaps']);

interface PubState {
  /** The session row as last published: a hash of its steady columns, and when. */
  h?: string;
  at?: number;
  /** The newest ask as last published: its index, a hash of it, and when. */
  pi?: number;
  ph?: string;
  pat?: number;
}

function pubState(r: Run, machine: string, id: string): PubState {
  try {
    return JSON.parse((r.db.prepare('SELECT state FROM ingest_state WHERE source = ?').get(`pub:${machine}:${id}`) as { state: string } | undefined)?.state ?? '{}') as PubState;
  } catch {
    return {};
  }
}

function setPubState(r: Run, machine: string, id: string, st: PubState, waiting: boolean): void {
  r.db.prepare(upsertSql('ingest_state', ['source'], ['source', 'kind', 'machine_id', 'session_id', 'state', 'updated_ms']))
    .run(`pub:${machine}:${id}`, waiting ? 'pub-waiting' : 'pub', machine, id, JSON.stringify(st), r.now);
}

/**
 * Publish a session's own row and its newest ask, each when it changed: at once for a change of what a session is (its
 * title, model, workspace, archive), at most every PUBLISH_MS for one that moves with every turn, and whatever has
 * waited longer than that when `force` (the catch-up that finds it waiting, and OAK's cleanup before it removes a
 * session). Older asks are published as they close (ingestPrompts).
 */
function publishSession(r: Run, machine: string, id: string, force = false): void {
  if (!r.pub.owns(machine)) return;
  const row = r.db.prepare('SELECT * FROM sessions WHERE machine_id = ? AND session_id = ?').get(machine, id) as Record<string, unknown> | undefined;
  if (!row) return;
  const st = pubState(r, machine, id);
  const out = recordRow('sessions', row);
  const steady = createHash('sha256').update(JSON.stringify(Object.entries(out).filter(([k]) => !SESSION_VOLATILE.has(k)))).digest('hex').slice(0, 16);
  const all = createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 16);
  let waiting = false;
  const due = (at: number | undefined): boolean => force || at === undefined || r.now - at >= PUBLISH_MS;
  begin(r);
  if (st.h !== `${steady}:${all}`) {
    if (st.h?.split(':')[0] !== steady || due(st.at)) {
      r.pub.row(machine, 'sessions', row);
      st.h = `${steady}:${all}`;
      st.at = r.now;
    } else waiting = true;
  }
  const last = r.db.prepare('SELECT idx, CAST(text AS BLOB) AS t, CAST(response AS BLOB) AS a, end_ts FROM prompts WHERE machine_id = ? AND session_id = ? ORDER BY idx DESC LIMIT 1')
    .get(machine, id) as { idx: number; t: Uint8Array; a: Uint8Array; end_ts: number } | undefined;
  if (last) {
    const h = createHash('sha256').update(last.t).update('\u0000').update(last.a).update(`\u0000${last.end_ts}`).digest('hex').slice(0, 16);
    if (st.pi !== last.idx || st.ph !== h) {
      if (st.pi !== last.idx || due(st.pat)) {
        pubStored(r, 'prompts', machine, { session_id: id, idx: last.idx });
        st.pi = last.idx;
        st.ph = h;
        st.pat = r.now;
      } else waiting = true;
    }
  }
  setPubState(r, machine, id, st, waiting);
  count(r);
}

/** What waited longer than PUBLISH_MS to be published (publishSession), published now. */
function publishWaiting(r: Run, only?: Set<string>): void {
  const rows = r.db.prepare("SELECT machine_id, session_id FROM ingest_state WHERE kind = 'pub-waiting' AND updated_ms <= ?").all(only ? Number.MAX_SAFE_INTEGER : r.now - PUBLISH_MS) as { machine_id: string; session_id: string }[];
  for (const w of rows) {
    if (only && !only.has(w.session_id)) continue;
    publishSession(r, w.machine_id, w.session_id, true);
    breathe(r);
  }
  commit(r);
}

interface StateRow {
  source: string;
  dev: number | null;
  ino: number | null;
  size: number | null;
  mtime_ms: number | null;
  cursor: number;
  head_sha: string | null;
  anchor_sha: string | null;
  state: string | null;
}

function getState(r: Run, source: string): StateRow | undefined {
  return r.db.prepare('SELECT source, dev, ino, size, mtime_ms, cursor, head_sha, anchor_sha, state FROM ingest_state WHERE source = ?').get(source) as StateRow | undefined;
}

function putState(r: Run, row: { source: string; kind: string; machine: string; session: string | null; st?: Stamp | null; cursor?: number; head?: string | null; anchor?: string | null; state?: string | null }): void {
  r.db.prepare(upsertSql('ingest_state', ['source'], ['source', 'kind', 'machine_id', 'session_id', 'dev', 'ino', 'size', 'mtime_ms', 'cursor', 'head_sha', 'anchor_sha', 'state', 'updated_ms']))
    .run(row.source, row.kind, row.machine, row.session, row.st?.dev ?? null, row.st?.ino ?? null, row.st?.size ?? null, row.st?.mtimeMs ?? null, row.cursor ?? 0, row.head ?? null, row.anchor ?? null, row.state ?? null, r.now);
  count(r);
}

/** A stamp-only unit is current when its recorded stamp is the file's. */
function current(row: StateRow | undefined, stamp: string): boolean {
  return row?.state === stamp;
}

/** `length` bytes of a file from `at`, or fewer where it ends. */
function readAt(fd: number, at: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, at + got);
    if (!n) break;
    got += n;
  }
  return buf.subarray(0, got);
}

function hashRange(fd: number, at: number, length: number): string {
  return createHash('sha256').update(readAt(fd, at, length)).digest('hex').slice(0, 32);
}

/** A text column read as bytes (`CAST(x AS BLOB)`), as a string. */
export function utf8(bytes: Uint8Array | string | null): string {
  if (bytes === null) return '';
  return typeof bytes === 'string' ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/** The prompts row's `nul`: whether node:sqlite on Node 22 would return the ask or its answer cut at a NUL character. */
function hasNul(text: string, response: string): number {
  return text.includes('\u0000') || response.includes('\u0000') ? 1 : 0;
}

/** The guards of a cursor: a hash of the file's head and one of the bytes just before the cursor. */
function guards(fd: number, cursor: number): { head: string; anchor: string } {
  const head = hashRange(fd, 0, Math.min(GUARD_BYTES, cursor));
  const from = Math.max(0, cursor - GUARD_BYTES);
  return { head, anchor: hashRange(fd, from, cursor - from) };
}

// --- sessions -----------------------------------------------------------------------------------------------------

const SESSION_COLS = [
  'machine_id', 'session_id', 'agent', 'origin', 'listed', 'review', 'title', 'first_prompt', 'workspace', 'cwd', 'project_key',
  'transcript_path', 'rollout_path', 'first_ms', 'last_active_ms', 'last_turn_ms', 'capture_ms', 'tokens', 'cached', 'duration_ms',
  'model', 'effort', 'edits', 'pending', 'files', 'added', 'removed', 'last_edit_id', 'gaps', 'store_bytes', 'hidden',
  'archived_ms', 'archived_reason', 'archive_hint', 'inputs', 'facts', 'facts_transcript', 'title_inputs', 'updated_ms', 'parent_session',
] as const;

/** A session row's columns that only its conversation (a transcript, or a Codex rollout) tells. */
const CONVERSATION_COLS = ['agent', 'review', 'title', 'first_prompt', 'workspace', 'cwd', 'project_key', 'transcript_path', 'rollout_path', 'last_turn_ms',
  'tokens', 'cached', 'duration_ms', 'model', 'effort', 'parent_session'] as const;

/** The identity key of a working directory (`git:…`, `home:…`, `share:…`, `path:…`), as oak sync keys projects. */
function projectKey(r: Run, cwd: string | undefined | null): { key: string | null; root: string | null } {
  if (!cwd) return { key: null, root: null };
  try {
    r.shares ??= readMountTable();
    const id = fileProjectIdentity(cwd, { home: os.homedir(), shares: r.shares });
    return { key: id.key, root: id.root ?? null };
  } catch {
    return { key: null, root: null };
  }
}

/** Which machine a session's conversation came from: the one oak sync pulled its transcript or rollout from, else this
 *  one. */
function originOf(r: Run, f: SessionListingFacts | null): string | null {
  const file = f?.rollout ?? f?.transcript;
  return file ? fileOrigin(r, file) : null;
}

/** The machine a session here is a copy of: every transcript and rollout of it is as oak sync landed it from another
 *  machine (the manifest names that machine, with the hash, size and time it landed at), and it has no store here. One
 *  changed here since (a session resumed here) is this machine's own, as oak sync takes it. Null for a session of this
 *  machine's own. */
function copyOrigin(r: Run, s: SessionSources): string | null {
  if (s.store) return null;
  const from = [...s.transcripts.map((x) => ({ file: x.t.file, st: x.st })), ...s.rollouts].map(({ file, st }) => {
    const e = manifestEntry(r, file);
    return e?.origin && e.origin !== r.me && e.sha256 && e.size === st.size && e.mtime === Math.floor(st.mtimeMs) ? e.origin : null;
  });
  return from.length && from.every(Boolean) ? from[0] : null;
}

/** The machine oak sync pulled a transcript or rollout here from (its manifest says), or null for this machine's own. */
function fileOrigin(r: Run, file: string): string | null {
  const entry = manifestEntry(r, file);
  return entry?.origin && entry.origin !== r.me ? entry.origin : null;
}

/** Whether this machine's capture recorded anything of the session, filed under `machine`: its edits, capture gaps,
 *  waits, review comments or the asks its hooks saw, which no other machine's records hold. */
function capturedHere(r: Run, id: string, machine: string): boolean {
  const of = (table: string, more = ''): string => `SELECT 1 FROM ${table} WHERE machine_id = ?1 AND session_id = ?2${more}`;
  return r.db.prepare(`${['edits', 'capture_gaps', 'waits', 'comments'].map((t) => of(t)).join(' UNION ALL ')} UNION ALL ${of('prompts', " AND source = 'hooks'")} LIMIT 1`)
    .get({ '?1': machine, '?2': id }) !== undefined; // Node 22.16 binds numbered parameters by name
}

/** oak sync's manifest entry of a transcript or rollout here, if it has one. */
function manifestEntry(r: Run, file: string): SyncManifestEntry | null {
  r.manifest ??= readManifest();
  const claudeRoot = path.join(claudeConfigDir(), 'projects');
  const rel = (root: string): string | null => {
    const x = path.relative(root, file);
    return x && !x.startsWith('..') && !path.isAbsolute(x) ? x.split(path.sep).join('/') : null;
  };
  const asTranscript = rel(claudeRoot);
  const asRollout = rel(codexHome());
  return (asTranscript && r.manifest.get(manifestKey('transcripts', asTranscript))) || (asRollout && r.manifest.get(manifestKey('rollouts', asRollout))) || null;
}

function factsTitleOf(f: SessionListingFacts): string | null {
  if (f.shape === 'meta' || f.rollout) return f.title ?? null;
  const p = f.titleParts;
  return p ? normalizeSessionTitle(preferredSessionTitle({ customTitle: p.rename, bridgeSessionId: p.bridge, title: p.aiTitle, firstUserPrompt: p.prompt }) ?? '') : null;
}

function writeSession(r: Run, s: SessionSources, codexIndex: string, filedUnder: string | null): { machine: string; facts: SessionListingFacts | null; copy?: true } {
  const unsettled = codexUnsettledReads;
  const sources = codexSessionSources({
    rollouts: () => s.rollouts.map((x) => ({ file: x.file, mtimeMs: x.st.mtimeMs })),
    head: codexRolloutHead,
    mirrored: (file) => isMirroredTranscript(file).mirrored,
  });
  const disc = discoverListing(s.transcripts.map((x) => x.t), sources);
  const f = listingFacts(s.id, disc, os.homedir());
  if (codexUnsettledReads !== unsettled) throw new Error('Codex transcript conversion is still in progress');
  // A writer may have appended after discovery, or while these facts were read. Keep the session due, for Claude
  // transcripts too, rather than certify a mixture of reads as the snapshot discovery stamped.
  if (s.transcripts.some((x) => stampOf(stat(x.t.file)) !== stampOf(x.st)) || s.rollouts.some((x) => stampOf(stat(x.file)) !== stampOf(x.st))) {
    throw new Error('Session transcript changed while reading its listing');
  }
  // A copy oak sync pulled here from a machine that names its directory differently, which the listing leaves out: that
  // machine's session, which its records describe. Nothing of it is filed here (keepCopy), so nothing of it is published
  // as this machine's own. Never one this machine's capture recorded (a copy resumed here): oak sync records a file as it
  // last left it, a tail the other machine wrote included, so its manifest cannot tell such a session from a copy.
  const from = !f && (filedUnder === null || r.pub.owns(filedUnder)) && !capturedHere(r, s.id, filedUnder ?? r.me) ? copyOrigin(r, s) : null;
  if (from) return { machine: from, facts: null, copy: true };
  const stamp = factsStamp(s, codexIndex, f?.titleInputs);
  // Filed once, under the machine its conversation came from (oak sync's manifest says which), and kept there: every
  // row of a session shares its key, so a session is never filed twice.
  const origin = filedUnder === null ? originOf(r, f) : filedUnder === r.me ? null : filedUnder;
  const machine = filedUnder ?? origin ?? r.me;
  const prev = r.db.prepare(`SELECT archive_hint, first_ms, ${CONVERSATION_COLS.join(', ')} FROM sessions WHERE machine_id = ? AND session_id = ?`).get(machine, s.id) as
    (Row & { archive_hint: string | null; first_ms: number | null }) | undefined;
  const pk = projectKey(r, f?.cwd);
  const rollout = f?.rollout ?? s.rollouts[0]?.file;
  const meta = rollout ? codexRolloutHead(rollout)?.meta : null;
  const parent = meta?.parent_thread_id ?? (meta?.source as { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } } | undefined)?.subagent?.thread_spawn?.parent_thread_id;
  const rootKnown = meta && parent == null && !(meta.source as { subagent?: unknown } | undefined)?.subagent
    && meta.source !== 'subagent' && !['subagent', 'guardian_review'].includes(String(meta.thread_source));
  const counts = f?.counts ?? (s.store ? sessionCounts(s.id) : null);
  const firstMs = Math.min(...[...s.transcripts.map((t) => t.st.birthtimeMs || t.st.mtimeMs), ...s.rollouts.map((x) => x.st.birthtimeMs || x.st.mtimeMs)].filter((x) => x > 0), prev?.first_ms ?? Infinity);
  const row: Row = {
    machine_id: machine,
    session_id: s.id,
    parent_session: typeof parent === 'string' && isSafeSessionId(parent) && parent !== s.id ? parent : rootKnown || f?.agent === 'claude' ? '' : null,
    agent: f?.agent ?? (s.rollouts.length || s.files['agent.json'] ? 'codex' : 'claude'),
    origin: origin ? 'pulled' : 'local',
    // Listed as the old listing lists: a session it discovers (a transcript, or a rollout its Codex scan takes) or one
    // with a store here. A rollout the scan passes over (no prompt yet, a temp workspace since removed) is neither,
    // though listingFacts, asked for it by id, would describe it.
    listed: f && (disc.byId.has(s.id) || s.store) ? 1 : 0,
    review: f?.review ? 1 : 0,
    title: f ? factsTitleOf(f) : null,
    first_prompt: f?.titleParts?.prompt ?? null,
    workspace: f?.workspace ?? '',
    cwd: f?.cwd ?? null,
    project_key: pk.key,
    transcript_path: f?.transcript ?? s.transcripts[0]?.t.file ?? null,
    rollout_path: f?.rollout ?? s.rollouts[0]?.file ?? null,
    first_ms: Number.isFinite(firstMs) ? Math.round(firstMs) : null,
    last_active_ms: Math.round(f?.lastActiveMs ?? s.newest),
    last_turn_ms: f?.lastTurn ?? null,
    capture_ms: Math.round(f?.captureMs ?? 0),
    tokens: f?.tokens ?? 0,
    cached: f?.cached ?? 0,
    duration_ms: f?.durationMs ?? 0,
    model: f?.model ?? '',
    effort: f?.effort ?? '',
    edits: counts?.edits ?? 0,
    pending: counts?.pending ?? 0,
    files: counts?.files ?? 0,
    added: counts?.added ?? 0,
    removed: counts?.removed ?? 0,
    last_edit_id: counts?.lastEdit ?? 0,
    gaps: 0,
    store_bytes: f?.storeBytes ?? 0,
    hidden: 0,
    archived_ms: null,
    archived_reason: null,
    archive_hint: prev?.archive_hint ?? null,
    inputs: stamp,
    facts: f ? JSON.stringify(f) : null,
    facts_transcript: f?.transcript ?? null,
    title_inputs: f?.titleInputs?.length ? JSON.stringify(f.titleInputs) : null,
    updated_ms: r.now,
  };
  // Its conversation has gone while its store stays (Claude Code's retention swept the transcript): what only the
  // conversation could tell is kept as it was, never blanked.
  if (!f && prev) for (const c of CONVERSATION_COLS) row[c] = prev[c] ?? row[c];
  // The write lock is taken here, after the files are read: begun before them, it was held for the whole parse of a
  // large transcript (1.2 s for 150 MB), and every other writer waited.
  begin(r);
  r.db.prepare(upsertSql('sessions', ['machine_id', 'session_id'], SESSION_COLS)).run(...fitRow(r.db, 'sessions', SESSION_COLS, SESSION_COLS.map((c) => row[c] ?? null)));
  count(r);
  // What changes while a session runs, for the phase view.
  let turnOpen: number | null = null;
  if (f?.rollout && r.now - f.lastActiveMs <= 2 * 60 * 60_000) {
    try {
      const open = codexDerivedTurnOpen(f.rollout) ?? codexTurnOpen(f.rollout);
      turnOpen = open === null ? null : open ? 1 : 0;
    } catch {
      /* the rollout cannot say */
    }
  }
  const LIVE_COLS = ['machine_id', 'session_id', 'observed_ms', 'transcript_mtime', 'capture_mtime', 'turn_open'];
  r.db.prepare(upsertSql('session_live', ['machine_id', 'session_id'], LIVE_COLS))
    .run(...fitRow(r.db, 'session_live', LIVE_COLS, [machine, s.id, r.now, f ? f.lastActiveMs : null, f?.captureMs || null, turnOpen]));
  count(r);
  return { machine, facts: f };
}

/** A copy of another machine's session (writeSession): its stamp is kept, so a catch-up passes it over until its files
 *  change. The rows an earlier build filed of it under this machine go (its session row and live row: a copy derives no
 *  facts, so nothing else), and so does the row this machine's record log published of it, which the other machines
 *  took for one of this machine's sessions. Its usage stays: each message is one row, whichever machine holds it. */
function keepCopy(r: Run, id: string, origin: string, stamp: string, filedUnder: string | null): void {
  begin(r);
  if (filedUnder !== null && r.pub.owns(filedUnder)) {
    for (const table of ['sessions', 'session_live']) r.db.prepare(`DELETE FROM ${table} WHERE machine_id = ? AND session_id = ?`).run(filedUnder, id);
    r.db.prepare('DELETE FROM ingest_state WHERE machine_id = ? AND session_id = ?').run(filedUnder, id);
    r.pub.delete(filedUnder, 'sessions', { session_id: id });
  }
  putState(r, { source: `copy:${id}`, kind: 'copy', machine: origin, session: id, state: stamp });
}

// --- prompts (asks and answers) -----------------------------------------------------------------------------------

/** What a transcript's cursor keeps besides its offset: the texts folded of its most recent messages, so an answer
 *  whose lines straddle two catch-ups is folded as one pass over the whole file would fold it. */
interface PromptsState {
  version: number;
  file: string;
  prompts?: PromptReaderState;
  seen: [string, string[]][];
  /** Every whole line of the file at this stamp was folded. False while a catch-up is part way through it (one stopped
   *  there resumes from the cursor, even though the file's stamp has not changed). */
  done?: boolean;
  /** While a file is read again from the start: what the index held of each ask before (its index, a hash of the row),
   *  what the end of the pass publishes the differences from. */
  prior?: Record<string, string>;
}

const PROMPT_COLS = ['machine_id', 'session_id', 'idx', 'prompt_id', 'ts', 'end_ts', 'text', 'response', 'source', 'nul'] as const;

/** Each ask of a session with a hash of its row: what tells a reading of a file again from what the index held. */
function promptHashes(r: Run, machine: string, id: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const x of r.db.prepare('SELECT idx, prompt_id, ts, end_ts, CAST(text AS BLOB) AS t, CAST(response AS BLOB) AS a, source FROM prompts WHERE machine_id = ? AND session_id = ?')
    .all(machine, id) as { idx: number; prompt_id: string | null; ts: number; end_ts: number; t: Uint8Array; a: Uint8Array; source: string }[]) {
    out.set(String(x.idx), createHash('sha256').update(`${x.prompt_id ?? ''}\u0000${x.ts}\u0000${x.end_ts}\u0000${x.source}\u0000`).update(x.t).update('\u0000').update(x.a).digest('hex').slice(0, 16));
  }
  return out;
}

/** Mark a session's own row and newest ask as having changed since they were last published (publishSession), in the
 *  transaction that changed them: a catch-up stopped before it publishes them leaves them waiting, for the next. */
function markWaiting(r: Run, machine: string, id: string): void {
  if (!r.pub.owns(machine)) return;
  r.db.prepare(`INSERT INTO ingest_state (source, kind, machine_id, session_id, state, updated_ms) VALUES (?, 'pub-waiting', ?, ?, '{}', ?)
    ON CONFLICT(source) DO UPDATE SET kind = 'pub-waiting', updated_ms = excluded.updated_ms`).run(`pub:${machine}:${id}`, machine, id, r.now);
}

/** Fold a transcript's asks and answers into `prompts` from its cursor; a replaced or rewritten file starts over. A line
 *  still being written (no newline yet) waits for the next catch-up, as the search's own index waits for it. */
function ingestPrompts(r: Run, machine: string, id: string, transcript: string): void {
  const source = `prompts:${machine}:${id}`;
  const prev = getState(r, source);
  let fd: number;
  try {
    fd = fs.openSync(transcript, 'r');
  } catch {
    return; // gone since the listing looked: the next catch-up decides what that means
  }
  try {
    const st = fs.fstatSync(fd);
    let state: PromptsState | null = null;
    try {
      state = prev?.state ? (JSON.parse(prev.state) as PromptsState) : null;
    } catch {
      state = null;
    }
    if (prev && state?.version === INGEST_VERSION && state.file === transcript && state.done && prev.dev === st.dev && prev.ino === st.ino && prev.size === st.size && prev.mtime_ms === st.mtimeMs) return;
    let cursor = prev?.cursor ?? 0;
    let restart = !prev || !state || state.version !== INGEST_VERSION || state.file !== transcript || prev.dev !== st.dev || prev.ino !== st.ino || st.size < cursor;
    if (!restart && cursor > 0) {
      const g = guards(fd, cursor);
      restart = g.head !== prev!.head_sha || g.anchor !== prev!.anchor_sha;
    }
    const seen = new Map<string, string[]>(restart ? [] : state!.seen);
    const prompts = new PromptReader(restart ? undefined : state?.prompts);
    // Read again from the start (a new index, or the file replaced): what the index held is published again only where
    // the new reading differs from it, once the whole file is read (a new index reads this machine's own log back first,
    // so reading the files again publishes nothing twice). Until then, `prior` keeps what it held.
    let prior: Record<string, string> | undefined = restart ? undefined : state?.prior;
    if (restart) {
      cursor = 0;
      begin(r);
      prior = Object.fromEntries(promptHashes(r, machine, id));
      count(r, Number(r.db.prepare('DELETE FROM prompts WHERE machine_id = ? AND session_id = ?').run(machine, id).changes));
    }
    // The newest ask: the prose that follows it in the file joins it.
    // Read as bytes: node:sqlite on Node 22 returns a text cut at a NUL character, and the answer this fold extends would
    // lose what follows one.
    const tail = restart ? undefined : (r.db.prepare('SELECT idx, ts, CAST(text AS BLOB) AS text, CAST(response AS BLOB) AS response FROM prompts WHERE machine_id = ? AND session_id = ? ORDER BY idx DESC LIMIT 1')
      .get(machine, id) as { idx: number; ts: number; text: Uint8Array; response: Uint8Array } | undefined);
    let last = tail ? { idx: tail.idx, ts: tail.ts, text: utf8(tail.text), response: utf8(tail.response) } : null;
    const ins = r.db.prepare(upsertSql('prompts', ['machine_id', 'session_id', 'idx'], PROMPT_COLS));
    const setResponse = r.db.prepare('UPDATE prompts SET response = ?, nul = ? WHERE machine_id = ? AND session_id = ? AND idx = ?');
    const setEnd = r.db.prepare('UPDATE prompts SET end_ts = ? WHERE machine_id = ? AND session_id = ? AND idx = ?');
    while (cursor < st.size) {
      // Whole lines: one longer than a chunk (an ask carrying a large pasted image) is read on to its end, as the
      // search's own fold reads it. Folded in pieces, it parsed as nothing, and its answer joined the ask before it.
      const parts = [readAt(fd, cursor, Math.min(CHUNK_BYTES, st.size - cursor))];
      let read = parts[0].length;
      let end = parts[0].lastIndexOf(0x0a);
      while (end < 0 && cursor + read < st.size) {
        const more = readAt(fd, cursor + read, Math.min(CHUNK_BYTES, st.size - cursor - read));
        if (!more.length) break;
        parts.push(more);
        const nl = more.lastIndexOf(0x0a);
        if (nl >= 0) end = read + nl;
        read += more.length;
      }
      if (end < 0) break; // a line still being written
      const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      // Folded FOLD_LINES lines at a time, each batch committed with the cursor after it: a transaction stays small,
      // and a catch-up stopped anywhere resumes at a line it has wholly folded.
      let from = 0;
      while (from <= end) {
        let to = from;
        for (let lines = 0; lines < FOLD_LINES && to <= end; lines++) {
          const nl = buf.indexOf(0x0a, to);
          to = nl < 0 || nl > end ? end + 1 : nl + 1;
        }
        const docs: SearchDoc[] = last ? [{ ts: last.ts, prompt: last.text, response: last.response }] : [];
        const had = docs.length;
        foldSearchDocs(buf.toString('utf8', from, to), docs, seen, prompts);
        begin(r);
        if (last && docs[0].response !== last.response) {
          setResponse.run(docs[0].response, hasNul(last.text, docs[0].response), machine, id, last.idx);
          count(r);
          last.response = docs[0].response;
        }
        // An ask closes when the next one begins: published then, whole. The newest is published by publishSession.
        const closed: number[] = [];
        for (let i = had; i < docs.length; i++) {
          const d = docs[i];
          if (last) {
            setEnd.run(fitRow(r.db, 'prompts', ['end_ts'], [d.ts])[0], machine, id, last.idx);
            closed.push(last.idx);
          }
          const idx = last ? last.idx + 1 : 0;
          ins.run(...fitRow(r.db, 'prompts', PROMPT_COLS, [machine, id, idx, d.ts ? promptId(d.ts, d.prompt) : null, d.ts, 0, d.prompt, d.response, transcript, hasNul(d.prompt, d.response)]));
          count(r, 2);
          last = { idx, ts: d.ts, text: d.prompt, response: d.response };
        }
        if (!prior) for (const idx of closed) pubStored(r, 'prompts', machine, { session_id: id, idx });
        markWaiting(r, machine, id);
        cursor += to - from;
        const g = guards(fd, cursor);
        putState(r, { source, kind: 'prompts', machine, session: id, st, cursor, head: g.head, anchor: g.anchor,
          state: JSON.stringify({ version: INGEST_VERSION, file: transcript, prompts: prompts.state(), seen: [...seen.entries()].slice(-SEEN_KEEP), done: false, ...(prior ? { prior } : {}) } satisfies PromptsState) });
        breathe(r);
        r.afterBatch?.();
        from = to;
      }
    }
    // Done with this stamp, even when no whole line was added, so an unchanged file is not opened again.
    const g = guards(fd, cursor);
    begin(r);
    if (prior && r.pub.owns(machine)) {
      // Read again whole: each ask published where it differs from what the index held, and each one gone said so.
      const now = promptHashes(r, machine, id);
      // The newest ask is publishSession's to publish, as it grows.
      const newest = last ? String(last.idx) : null;
      for (const [idx, h] of now) if (prior[idx] !== h && idx !== newest) pubStored(r, 'prompts', machine, { session_id: id, idx: Number(idx) });
      for (const idx of Object.keys(prior)) if (!now.has(idx)) r.pub.delete(machine, 'prompts', { session_id: id, idx: Number(idx) });
      count(r, now.size);
    }
    putState(r, { source, kind: 'prompts', machine, session: id, st, cursor, head: g.head, anchor: g.anchor,
      state: JSON.stringify({ version: INGEST_VERSION, file: transcript, prompts: prompts.state(), seen: [...seen.entries()].slice(-SEEN_KEEP), done: true } satisfies PromptsState) });
  } finally {
    fs.closeSync(fd);
  }
}

/** A session with no transcript here (driven, or a Codex session whose rollout is gone) has the asks its hooks
 *  recorded, with no answers, as the search reads them. Rows folded from a transcript that has since gone stay. */
function ingestHookPrompts(r: Run, machine: string, id: string): void {
  const fromFile = (r.db.prepare("SELECT count(*) AS n FROM prompts WHERE machine_id = ? AND session_id = ? AND source != 'hooks'").get(machine, id) as { n: number }).n;
  if (fromFile > 0) return;
  let asks: { ts: number; text: string }[] = [];
  try {
    asks = sessionPrompts(os.homedir(), id);
  } catch {
    asks = [];
  }
  begin(r);
  r.db.prepare('DELETE FROM prompts WHERE machine_id = ? AND session_id = ?').run(machine, id);
  r.pub.clear(machine, 'prompts', id);
  const ins = r.db.prepare(upsertSql('prompts', ['machine_id', 'session_id', 'idx'], PROMPT_COLS));
  asks.forEach((a, i) => {
    const values = fitRow(r.db, 'prompts', PROMPT_COLS, [machine, id, i, a.ts ? promptId(a.ts, a.text) : null, a.ts, i + 1 < asks.length ? asks[i + 1].ts : 0, a.text, '', 'hooks', hasNul(a.text, '')]);
    ins.run(...values);
    pubValues(r, 'prompts', machine, PROMPT_COLS, values);
    count(r);
  });
}

// --- what a session did: actions, workers, workflow runs -----------------------------------------------------------

const AGENT_COLS = ['machine_id', 'session_id', 'agent_id', 'kind', 'run_id', 'tool_use_id', 'agent_type', 'description', 'label', 'status', 'first_ts',
  'last_ts', 'model', 'tokens', 'actions', 'edits', 'transcript_path', 'record'] as const;
const RUN_COLS = ['machine_id', 'session_id', 'run_id', 'name', 'description', 'status', 'started_ts', 'last_ts', 'agents', 'record'] as const;
const ACTION_COLS = ['machine_id', 'session_id', 'seq', 'tool_use_id', 'ts', 'tool', 'category', 'target', 'path_abs', 'project_key', 'rel_path', 'is_error', 'edit_id'] as const;

/** Rows `table` should hold for one session: insert what is new, update what changed, and remove what the source no
 *  longer has (the source is still there; a rewrite superseded those rows). Compares whole rows, so an unchanged row
 *  costs a read and nothing more. */
function syncRows(r: Run, table: string, keys: readonly string[], cols: readonly string[], machine: string, id: string, rows: Row[], remove = true, scope = '1 = 1'): void {
  const keyOf = (row: Row): string => keys.map((k) => String(row[k])).join('\u0000');
  const have = new Map<string, string>();
  for (const row of r.db.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE machine_id = ? AND session_id = ? AND ${scope}`).all(machine, id) as Row[]) {
    have.set(keyOf(row), JSON.stringify(cols.map((c) => row[c] ?? null)));
  }
  const up = r.db.prepare(upsertSql(table, keys, cols));
  const want = new Set<string>();
  begin(r);
  for (const row of rows) {
    const v = fitRow(r.db, table, cols, cols.map((c) => row[c] ?? null));
    const k = keys.map((key) => String(v[cols.indexOf(key)])).join('\u0000');
    want.add(k);
    if (have.get(k) === JSON.stringify(v)) continue;
    up.run(...v);
    pubValues(r, table, machine, cols, v);
    count(r);
    if (r.txRows >= TX_ROWS) { commit(r); keepLease(r); begin(r); }
  }
  if (!remove) return;
  const del = r.db.prepare(`DELETE FROM ${table} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`);
  for (const k of have.keys()) {
    if (want.has(k)) continue;
    const key = k.split('\u0000').map((x, i) => (keys[i] === 'seq' || keys[i] === 'rep_id' || keys[i] === 'id' || keys[i] === 'idx' ? Number(x) : x));
    del.run(...key);
    r.pub.delete(machine, table, Object.fromEntries(keys.filter((n) => n !== 'machine_id').map((n) => [n, key[keys.indexOf(n)]])));
    count(r);
  }
}

function relOf(root: string | null, file: string | null | undefined): string | null {
  if (!root || !file || !path.isAbsolute(file)) return null;
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
}

function ingestWork(r: Run, machine: string, id: string, f: SessionListingFacts): void {
  // The views find a session's transcript by walking up from a directory, so they are asked from the one it recorded.
  const home = f.cwd ?? os.homedir();
  const root = projectKey(r, f.cwd);
  let actions: ReturnType<typeof parseActions> = [];
  try {
    actions = parseActions(home, id);
  } catch (e) {
    r.problems.push(`actions of ${id}: ${String((e as Error)?.message || e)}`);
  }
  // All three read before the first write: the write lock is not held while the files are parsed.
  let subs: ReturnType<typeof parseSubagents> = [];
  try {
    subs = parseSubagents(home, id);
  } catch (e) {
    r.problems.push(`workers of ${id}: ${String((e as Error)?.message || e)}`);
  }
  let runs: ReturnType<typeof parseWorkflows> = [];
  try {
    runs = parseWorkflows(home, id);
  } catch (e) {
    r.problems.push(`workflow runs of ${id}: ${String((e as Error)?.message || e)}`);
  }
  const fileOf = (a: (typeof actions)[number]): string | null =>
    (a.category === 'edit' || a.category === 'read') && path.isAbsolute(a.target) ? a.target : null;
  syncRows(r, 'actions', ['machine_id', 'session_id', 'seq'], ACTION_COLS, machine, id, actions.map((a, seq): Row => {
    const file = fileOf(a);
    return {
      machine_id: machine, session_id: id, seq, tool_use_id: a.toolUseId ?? null, ts: a.ts || 0, tool: a.tool, category: a.category,
      target: a.target ?? '', path_abs: file, project_key: file && relOf(root.root, file) ? root.key : null, rel_path: relOf(root.root, file),
      is_error: a.isError ? 1 : 0, edit_id: a.editId ?? null,
    };
  }));
  const agentRows: Row[] = subs.map((a) => {
    const { actions: acts, summary, todos, ...rest } = a;
    void summary;
    void todos;
    return {
      machine_id: machine, session_id: id, agent_id: a.agentId, kind: 'subagent', run_id: null, tool_use_id: a.toolUseId ?? null,
      agent_type: a.agentType ?? null, description: a.description ?? null, label: a.description ?? a.currentTask ?? null, status: a.status ?? null,
      first_ts: a.ts || null, last_ts: a.durationMs ? a.ts + a.durationMs : a.ts || null, model: null, tokens: a.tokens ?? 0, actions: acts.length,
      edits: a.edits, transcript_path: null, record: JSON.stringify(rest),
    };
  });
  for (const run of runs) {
    for (const ag of run.agents) {
      const a = ag as unknown as Record<string, unknown>;
      const agentId = String(a.agentId ?? a.id ?? '');
      if (!agentId) continue;
      agentRows.push({
        machine_id: machine, session_id: id, agent_id: `${run.id}/${agentId}`, kind: 'workflow-agent', run_id: run.id, tool_use_id: null,
        agent_type: typeof a.agentType === 'string' ? a.agentType : null, description: typeof a.description === 'string' ? a.description : null,
        label: typeof a.label === 'string' ? a.label : typeof a.description === 'string' ? a.description : null,
        status: typeof a.status === 'string' ? a.status : null, first_ts: typeof a.startTs === 'number' ? a.startTs : null,
        last_ts: typeof a.lastTs === 'number' ? a.lastTs : null, model: typeof a.model === 'string' ? a.model : null,
        tokens: typeof a.tokens === 'number' ? a.tokens : 0, actions: 0, edits: typeof a.edits === 'number' ? a.edits : 0,
        transcript_path: typeof a.transcript === 'string' ? a.transcript : null, record: JSON.stringify(a),
      });
    }
  }
  syncRows(r, 'agents', ['machine_id', 'session_id', 'agent_id'], AGENT_COLS, machine, id, agentRows);
  syncRows(r, 'workflow_runs', ['machine_id', 'session_id', 'run_id'], RUN_COLS, machine, id, runs.map((w): Row => {
    const { agents, phaseGroups, sparkline, ...rest } = w;
    void phaseGroups;
    void sparkline;
    return {
      machine_id: machine, session_id: id, run_id: w.id, name: w.name, description: w.description ?? null, status: w.running ? 'running' : 'done',
      started_ts: w.startedTs || null, last_ts: w.lastTs || null, agents: agents.length, record: JSON.stringify(rest),
    };
  }));
}

// --- the store: edits and what is derived from them ----------------------------------------------------------------

const EDIT_COLS = ['machine_id', 'session_id', 'id', 'uid', 'ts', 'tool', 'file', 'project_key', 'rel_path', 'ext', 'before_blob', 'after_blob', 'status',
  'prompt_id', 'native_turn_id', 'tool_call_id', 'source', 'runtime', 'model', 'provenance', 'attribution', 'partial', 'binary', 'before_state',
  'cleared_ms', 'record'] as const;

function editRow(machine: string, id: string, rec: EditRecord, root: { key: string | null; root: string | null }): Row {
  const rel = relOf(root.root, rec.file);
  return {
    machine_id: machine, session_id: id, id: rec.id, uid: rec.uid ?? null, ts: rec.ts, tool: rec.tool, file: rec.file,
    project_key: rel ? root.key : null, rel_path: rel, ext: path.extname(rec.file).toLowerCase() || null,
    before_blob: rec.beforeBlob, after_blob: rec.afterBlob, status: rec.status, prompt_id: rec.promptId ?? null,
    native_turn_id: rec.nativeTurnId ?? null, tool_call_id: rec.toolCallId ?? null, source: rec.source ?? 'hook', runtime: rec.runtime ?? null,
    model: rec.model ?? null, provenance: rec.provenance ?? null, attribution: rec.attribution ?? null, partial: rec.partial ? 1 : 0,
    binary: rec.binary ? 1 : 0, before_state: rec.beforeState ?? null, cleared_ms: null, record: JSON.stringify(rec),
  };
}

/**
 * A log's records into `edits`. A record the log no longer holds (OAK's cleanup dropped it, or the whole store went) is
 * kept and marked cleared, never deleted: the index keeps what a session did after the session is cleaned up.
 */
function writeEdits(r: Run, machine: string, id: string, records: EditRecord[] | null, root: { key: string | null; root: string | null }): void {
  const have = new Map<number, { json: string; cleared: number | null; uid: string | null; ts: number; file: string }>();
  let lowest = 0;
  for (const row of r.db.prepare('SELECT id, uid, ts, file, record, cleared_ms FROM edits WHERE machine_id = ? AND session_id = ?').all(machine, id) as { id: number; uid: string | null; ts: number; file: string; record: string; cleared_ms: number | null }[]) {
    have.set(row.id, { json: row.record, cleared: row.cleared_ms, uid: row.uid, ts: row.ts, file: row.file });
    lowest = Math.min(lowest, row.id);
  }
  const up = r.db.prepare(upsertSql('edits', ['machine_id', 'session_id', 'id'], EDIT_COLS));
  const rekey = r.db.prepare('UPDATE edits SET id = ?, cleared_ms = coalesce(cleared_ms, ?) WHERE machine_id = ? AND session_id = ? AND id = ?');
  begin(r);
  const live = new Set<number>();
  for (const rec of records ?? []) {
    live.add(rec.id);
    let prev = have.get(rec.id);
    if (prev && (prev.uid && rec.uid ? prev.uid !== rec.uid : prev.ts !== rec.ts || prev.file !== rec.file)) {
      // Another record held this id: an earlier store of the session (removed by `oak clean`, then begun again at 1
      // when the session went on). It stays, cleared, under an id below every id a log gives.
      rekey.run(--lowest, r.now, machine, id, rec.id);
      r.pub.delete(machine, 'edits', { session_id: id, id: rec.id });
      pubStored(r, 'edits', machine, { session_id: id, id: lowest });
      have.delete(rec.id);
      prev = undefined;
      count(r);
    }
    const row = editRow(machine, id, rec, root);
    if (prev && prev.cleared === null && prev.json === row.record) continue;
    const values = fitRow(r.db, 'edits', EDIT_COLS, EDIT_COLS.map((c) => row[c] ?? null));
    up.run(...values);
    pubValues(r, 'edits', machine, EDIT_COLS, values);
    count(r);
    if (r.txRows >= TX_ROWS) { commit(r); keepLease(r); begin(r); }
  }
  const clear = r.db.prepare('UPDATE edits SET cleared_ms = ? WHERE machine_id = ? AND session_id = ? AND id = ? AND cleared_ms IS NULL');
  for (const [eid, prev] of have) {
    if (live.has(eid) || prev.cleared !== null) continue;
    clear.run(r.now, machine, id, eid);
    pubStored(r, 'edits', machine, { session_id: id, id: eid });
    count(r);
  }
}

/**
 * A session's store begun again (`oak clean` removed it, and the session went on): the new store numbers its records,
 * operations and capture gaps from the start, so what the earlier store recorded moves out of their way, under keys
 * below every key a store gives, rather than being overwritten. Its records stay cleared, and its review units, its
 * operations and its gaps name them by the keys they moved to. Told apart by the store folder's identity (its device,
 * inode and birth time: a folder removed and made again can take the same inode back at once), unless the folder holds
 * the same store (sameStore): a store moved by copy (`oak store --move` to another file system, and any move to the
 * default location) is a new folder of the same log.
 */
function keepEarlierGeneration(r: Run, machine: string, id: string, records: EditRecord[]): void {
  const dir = stat(storeDir(id));
  if (!dir) return;
  const now = `${dir.dev}:${dir.ino}:${dir.birthtimeMs}`;
  const source = `gen:${machine}:${id}`;
  const was = getState(r, source)?.state ?? null;
  begin(r);
  if (was !== null && was !== now && !sameStore(r, machine, id, records)) {
    const idMap = new Map<number, number>();
    let lowest = Math.min(0, (r.db.prepare('SELECT min(id) AS n FROM edits WHERE machine_id = ? AND session_id = ?').get(machine, id) as { n: number | null }).n ?? 0);
    for (const e of r.db.prepare('SELECT id FROM edits WHERE machine_id = ? AND session_id = ? AND id > 0 ORDER BY id').all(machine, id) as { id: number }[]) idMap.set(e.id, --lowest);
    const mapIds = (json: string): string => {
      try {
        return JSON.stringify((JSON.parse(json) as unknown[]).map((x) => (typeof x === 'number' ? idMap.get(x) ?? x : x)));
      } catch {
        return json;
      }
    };
    const rekey = r.db.prepare('UPDATE edits SET id = ?, cleared_ms = coalesce(cleared_ms, ?) WHERE machine_id = ? AND session_id = ? AND id = ?');
    for (const [from, to] of idMap) rekey.run(to, r.now, machine, id, from);
    for (const table of ['edit_ops', 'capture_gaps'] as const) {
      let low = Math.min(0, (r.db.prepare(`SELECT min(seq) AS n FROM ${table} WHERE machine_id = ? AND session_id = ?`).get(machine, id) as { n: number | null }).n ?? 0);
      for (const row of r.db.prepare(`SELECT seq FROM ${table} WHERE machine_id = ? AND session_id = ? AND seq >= 0 ORDER BY seq`).all(machine, id) as { seq: number }[]) {
        r.db.prepare(`UPDATE ${table} SET seq = ? WHERE machine_id = ? AND session_id = ? AND seq = ?`).run(--low, machine, id, row.seq);
      }
    }
    for (const op of r.db.prepare('SELECT seq, ids FROM edit_ops WHERE machine_id = ? AND session_id = ? AND seq < 0').all(machine, id) as { seq: number; ids: string }[]) {
      r.db.prepare('UPDATE edit_ops SET ids = ? WHERE machine_id = ? AND session_id = ? AND seq = ?').run(mapIds(op.ids), machine, id, op.seq);
    }
    for (const u of r.db.prepare('SELECT rep_id, members FROM units WHERE machine_id = ? AND session_id = ? AND rep_id > 0').all(machine, id) as { rep_id: number; members: string }[]) {
      const to = idMap.get(u.rep_id);
      if (to === undefined) continue;
      r.db.prepare('UPDATE units SET rep_id = ?, members = ? WHERE machine_id = ? AND session_id = ? AND rep_id = ?').run(to, mapIds(u.members), machine, id, u.rep_id);
    }
    // Published again whole: their keys moved.
    if (r.pub.owns(machine)) {
      for (const table of ['edits', 'edit_ops', 'capture_gaps', 'units'] as const) {
        r.pub.clear(machine, table, id);
        for (const row of r.db.prepare(`SELECT * FROM ${table} WHERE machine_id = ? AND session_id = ?`).all(machine, id) as Record<string, unknown>[]) r.pub.row(machine, table, row);
      }
    }
    count(r, idMap.size + 1);
  }
  if (was !== now) putState(r, { source, kind: 'gen', machine, session: id, state: now });
}

/** Whether a session's log holds the records the index holds of it, at their ids (by uid, else time and file), at least
 *  one of them: the same store in another folder. A store begun again gives those ids to other records. */
function sameStore(r: Run, machine: string, id: string, records: EditRecord[]): boolean {
  const byId = new Map(records.map((x) => [x.id, x]));
  let matched = 0;
  for (const row of r.db.prepare('SELECT id, uid, ts, file FROM edits WHERE machine_id = ? AND session_id = ? AND id > 0').all(machine, id) as { id: number; uid: string | null; ts: number; file: string }[]) {
    const rec = byId.get(row.id);
    if (!rec) continue;
    if (row.uid && rec.uid ? row.uid !== rec.uid : row.ts !== rec.ts || row.file !== rec.file) return false;
    matched++;
  }
  return matched > 0;
}

function ingestLog(r: Run, machine: string, id: string, f: SessionListingFacts | null): void {
  const root = projectKey(r, f?.cwd ?? null);
  if (!fs.existsSync(logPath(id))) {
    writeEdits(r, machine, id, null, root);
    return;
  }
  // readLog: the same fold every view reads (status ops applied, a duplicate id re-keyed, the drive case healed).
  const records = readLogFile(logPath(id));
  keepEarlierGeneration(r, machine, id, records);
  writeEdits(r, machine, id, records, root);
  // What this store holds (keys from 0); an earlier store's rows, kept below zero (keepEarlierGeneration), are not its to drop.
  syncRows(r, 'edit_ops', ['machine_id', 'session_id', 'seq'], ['machine_id', 'session_id', 'seq', 'ts', 'kind', 'ids', 'label'], machine, id,
    readOperations(id).map((o, seq): Row => ({ machine_id: machine, session_id: id, seq, ts: o.ts, kind: o.kind, ids: JSON.stringify(o.ids), label: o.label })), true, 'seq >= 0');
  syncRows(r, 'capture_gaps', ['machine_id', 'session_id', 'seq'], ['machine_id', 'session_id', 'seq', 'ts', 'file', 'reason'], machine, id,
    readSkips(id).map((g, seq): Row => ({ machine_id: machine, session_id: id, seq, ts: g.ts || 0, file: g.file, reason: g.reason })), true, 'seq >= 0');
  // Units and line counts read the blobs, which only this machine holds: computed here, where they are.
  const cancelled = cancelledMemberIds(id);
  const units: Row[] = [];
  for (const rep of reviewEdits(id)) {
    const d = lineDelta(id, rep);
    units.push({
      machine_id: machine, session_id: id, rep_id: rep.id, members: JSON.stringify(groupMembers(id, rep.id)), file: rep.file, status: rep.status,
      cancelled: cancelled.has(rep.id) ? 1 : 0, added: d.added, removed: d.removed,
    });
  }
  syncRows(r, 'units', ['machine_id', 'session_id', 'rep_id'], ['machine_id', 'session_id', 'rep_id', 'members', 'file', 'status', 'cancelled', 'added', 'removed'], machine, id, units, true, 'rep_id > 0');
  const facts = r.db.prepare('INSERT INTO edit_facts (machine_id, before_blob, after_blob, added, removed) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
  const known = r.db.prepare('SELECT 1 FROM edit_facts WHERE machine_id = ? AND before_blob = ? AND after_blob = ?');
  const blobDir = path.join(storeDir(id), 'blobs');
  // A record with no snapshot named (null, or a field a writer left out) has nothing to look for.
  const has = (sha: string | null | undefined): boolean => sha == null || (typeof sha === 'string' && fs.existsSync(path.join(blobDir, sha)));
  begin(r);
  for (const rec of records) {
    if (rec.binary || !has(rec.beforeBlob) || !has(rec.afterBlob)) continue;
    if (known.get(machine, rec.beforeBlob ?? '', rec.afterBlob ?? '')) continue;
    const d = lineDelta(id, rec);
    facts.run(machine, rec.beforeBlob ?? '', rec.afterBlob ?? '', d.added, d.removed);
    pubValues(r, 'edit_facts', machine, ['before_blob', 'after_blob', 'added', 'removed'], [rec.beforeBlob ?? '', rec.afterBlob ?? '', d.added, d.removed]);
    count(r);
    if (r.txRows >= TX_ROWS) { commit(r); keepLease(r); begin(r); }
  }
  r.db.prepare('UPDATE sessions SET gaps = (SELECT count(*) FROM capture_gaps g WHERE g.machine_id = sessions.machine_id AND g.session_id = sessions.session_id) WHERE machine_id = ? AND session_id = ?')
    .run(machine, id);
}

/** The blobs a session holds: a sha that has gone stays listed, as not present. */
function ingestBlobs(r: Run, machine: string, id: string): void {
  const dir = path.join(storeDir(id), 'blobs');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{64}$/.test(n));
  } catch {
    names = [];
  }
  const have = new Map<string, { size: number; present: number }>();
  for (const row of r.db.prepare('SELECT sha, size, present FROM blobs WHERE machine_id = ? AND session_id = ?').all(machine, id) as { sha: string; size: number; present: number }[]) {
    have.set(row.sha, { size: row.size, present: row.present });
  }
  const up = r.db.prepare(upsertSql('blobs', ['machine_id', 'session_id', 'sha'], ['machine_id', 'session_id', 'sha', 'size', 'present']));
  begin(r);
  const seen = new Set<string>();
  for (const sha of names) {
    seen.add(sha);
    const prev = have.get(sha);
    if (prev?.present === 1) continue; // content-addressed: same name, same bytes
    const st = stat(path.join(dir, sha));
    if (!st) continue;
    up.run(machine, id, sha, st.size, 1);
    pubValues(r, 'blobs', machine, ['session_id', 'sha', 'size', 'present'], [id, sha, st.size, 1]);
    count(r);
    if (r.txRows >= TX_ROWS) { commit(r); keepLease(r); begin(r); }
  }
  const gone = r.db.prepare('UPDATE blobs SET present = 0 WHERE machine_id = ? AND session_id = ? AND sha = ?');
  for (const [sha, prev] of have) {
    if (seen.has(sha) || prev.present !== 1) continue;
    gone.run(machine, id, sha);
    pubValues(r, 'blobs', machine, ['session_id', 'sha', 'size', 'present'], [id, sha, prev.size, 0]);
    count(r);
  }
}

/** The raised hand, and the link to the terminal app's native tab: what the listing reads of a session's store right
 *  now, read here so a listing served from the index reads neither file. The hand is kept as the surfaces read it (a
 *  question its transcript holds unanswered, observe.ts withPendingQuestion). A hand raised or lowered on this machine is
 *  published, so the other machines' inboxes list it; a permission prompt only once it has stood its wait here (5 s, or
 *  Codex Auto-review's 90 s: notify.ts announceDelayMs), as this machine announces it, so a prompt answered at once, or
 *  by the reviewer, never reaches another machine. Returns false while one waits to be published (`deferred` on the
 *  next pass, which publishes it once due); true once the hand is settled. */
function ingestAttention(r: Run, machine: string, id: string, transcript: string | null, deferred: boolean): boolean {
  const raw = readAttention(id);
  const a = raw && withPendingQuestion(raw, transcript);
  const tab = readTabLink(id);
  let settled = true;
  begin(r);
  const prev = r.db.prepare('SELECT kind, message, ts, synced_ms FROM attention WHERE machine_id = ? AND session_id = ?').get(machine, id) as
    { kind: string; message: string; ts: number; synced_ms: number | null } | undefined;
  if (!a) {
    // A hand this machine recorded comes down; one another machine's records brought (a session pulled here, filed under
    // that machine) is that machine's to lower.
    if (prev && prev.synced_ms === null) {
      r.db.prepare('DELETE FROM attention WHERE machine_id = ? AND session_id = ?').run(machine, id);
      r.pub.delete(machine, 'attention', { session_id: id });
    }
  } else {
    const cols = ['machine_id', 'session_id', 'kind', 'message', 'ts', 'observed_ms', 'synced_ms'];
    const values = fitRow(r.db, 'attention', cols, [machine, id, a.kind, a.message ?? '', a.ts, r.now, null]);
    r.db.prepare(upsertSql('attention', ['machine_id', 'session_id'], cols)).run(...values);
    const changed = !prev || prev.synced_ms !== null || prev.kind !== a.kind || prev.message !== (a.message ?? '') || prev.ts !== a.ts;
    if (changed || deferred) {
      const wait = r.pub.owns(machine) ? announceDelayMs(a, r.now, id) : 0;
      if (wait > 0) {
        settled = false;
        r.handsDueAt = Math.min(r.handsDueAt ?? Infinity, r.now + wait);
        (r.handsDue ??= []).push({ id, ts: a.ts });
      } else pubValues(r, 'attention', machine, cols, values);
    }
  }
  r.db.prepare(upsertSql('session_live', ['machine_id', 'session_id'], ['machine_id', 'session_id', 'observed_ms', 'tab'])).run(machine, id, r.now, tab);
  count(r, 2);
  return settled;
}

/** The session's workers found finished (subagents.ts finishedWorkerStamps), which the listing need not ask again;
 *  WORKERS_NONE where no folder of workers is beside its transcript (`stamp` none or -), whose listing asks nothing. */
function ingestWorkers(r: Run, machine: string, id: string, transcript: string | null, stamp: string): void {
  const done = transcript && stamp !== '-' && stamp !== 'none' ? finishedWorkerStamps(transcript, id, r.now) : null;
  begin(r);
  r.db.prepare(upsertSql('session_live', ['machine_id', 'session_id'], ['machine_id', 'session_id', 'observed_ms', 'workers'])).run(machine, id, r.now, done ? JSON.stringify(done) : WORKERS_NONE);
  count(r);
}

/** The attention ledger (`attention-log.jsonl`, append-only): each hand raised and lowered, as a wait. */
function ingestWaits(r: Run, machine: string, id: string): void {
  const file = path.join(storeDir(id), 'attention-log.jsonl');
  const source = `waits:${machine}:${id}`;
  const prev = getState(r, source);
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const st = fs.fstatSync(fd);
    let cursor = prev?.cursor ?? 0;
    let restart = !prev || prev.dev !== st.dev || prev.ino !== st.ino || st.size < cursor;
    if (!restart && cursor > 0) {
      const g = guards(fd, cursor);
      restart = g.head !== prev!.head_sha || g.anchor !== prev!.anchor_sha;
    }
    begin(r);
    if (restart) {
      cursor = 0;
      r.db.prepare('DELETE FROM waits WHERE machine_id = ? AND session_id = ?').run(machine, id);
    }
    const len = st.size - cursor;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, cursor + got);
        if (!n) break;
        got += n;
      }
      const end = buf.lastIndexOf(0x0a, got - 1);
      if (end >= 0) {
        const up = r.db.prepare('INSERT INTO waits (machine_id, session_id, start_ms, end_ms, kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT(machine_id, session_id, start_ms) DO UPDATE SET end_ms = coalesce(excluded.end_ms, waits.end_ms), kind = excluded.kind');
        for (const line of buf.toString('utf8', 0, end + 1).split('\n')) {
          if (!line) continue;
          let e: { ev?: string; kind?: string; t?: number; since?: number };
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          const cols = ['machine_id', 'session_id', 'start_ms', 'end_ms', 'kind'];
          let values: (string | number | null)[];
          if (e.ev === 'up' && typeof e.t === 'number') values = fitRow(r.db, 'waits', cols, [machine, id, e.t, null, String(e.kind ?? '')]);
          else if (e.ev === 'down' && typeof e.t === 'number' && typeof e.since === 'number') values = fitRow(r.db, 'waits', cols, [machine, id, e.since, e.t, String(e.kind ?? '')]);
          else continue;
          up.run(...values);
          pubStored(r, 'waits', machine, { session_id: id, start_ms: values[2] });
          count(r);
        }
        cursor += end + 1;
      }
    }
    const g = guards(fd, cursor);
    putState(r, { source, kind: 'waits', machine, session: id, st, cursor, head: g.head, anchor: g.anchor });
  } finally {
    fs.closeSync(fd);
  }
}

const COMMENT_COLS = ['machine_id', 'session_id', 'comment_id', 'unit', 'pair', 'file', 'line', 'text', 'created_ms', 'sent_ms'] as const;

/** A session's review comments; one a person removed goes (it was taken back, not lost). Only one that the comments
 *  file of the same store held at the last catch-up and no longer holds was removed by a person: a file that went (its
 *  store cleaned) or a new store's (begun when the session went on) removed nothing, and the earlier comments stay. */
function ingestComments(r: Run, machine: string, id: string, present: boolean): void {
  const list = present ? readComments(id) : [];
  const source = `comments:${machine}:${id}`;
  // The store folder's identity: a folder removed and made again can take the same inode (ext4 gives it back at once),
  // so its birth time is part of it.
  const dir = stat(storeDir(id));
  const store = dir ? `${dir.dev}:${dir.ino}:${dir.birthtimeMs}` : '';
  let before: string[] = [];
  try {
    const prev = JSON.parse(getState(r, source)?.state ?? '{}') as { store?: string; ids?: string[] };
    if (prev.store === store && Array.isArray(prev.ids)) before = prev.ids;
  } catch {
    before = [];
  }
  syncRows(r, 'comments', ['machine_id', 'session_id', 'comment_id'], COMMENT_COLS, machine, id, list.map((c): Row => ({
    machine_id: machine, session_id: id, comment_id: c.id, unit: c.unit, pair: c.pair, file: c.file, line: c.line, text: c.text,
    created_ms: c.createdAt ?? null, sent_ms: c.sentAt ?? null,
  })), false);
  const now = new Set(list.map((c) => c.id));
  const del = r.db.prepare('DELETE FROM comments WHERE machine_id = ? AND session_id = ? AND comment_id = ?');
  if (present) for (const cid of before) if (!now.has(cid)) { del.run(machine, id, cid); r.pub.delete(machine, 'comments', { session_id: id, comment_id: cid }); count(r); }
  putState(r, { source, kind: 'comments', machine, session: id, state: JSON.stringify({ store, ids: [...now] }) });
}

// --- usage --------------------------------------------------------------------------------------------------------

const USAGE_COLS = ['message_id', 'agent', 'machine_id', 'session_id', 'account', 'model', 'ts', 'input', 'output', 'cache_create', 'cache_read', 'cost',
  'top_tier', 'seq', 'synced_ms', 'cache_create_1h', 'provider', 'speed', 'geo', 'priced', 'cost_approx', 'worker'] as const;

/** What a message records beyond its tokens (schema version 6), which a record from an OAK before it does not carry: such
 *  a record leaves them unknown, never the values of the snapshot it replaces, and its row unpriced (`priced` ''). A row
 *  priced by a table other than this machine's is priced again here (repriceUsage). */
export const USAGE_DETAIL = ['cache_create_1h', 'provider', 'speed', 'geo', 'priced', 'cost_approx', 'worker'] as const;

/** The units a message's snapshots are ranked by: input + output + cache creation, the tokens Claude Code counts (cache
 *  reads apart), as the status line ranks them. */
const UNIT = (t: string): string => `${t}.input + ${t}.output + ${t}.cache_create`;

/** When a message's stored row gives way to another snapshot of it: a larger one, or an equal one written earlier, or an
 *  equal one that brings what a row written before schema version 6 lacks (its provider, its writes by lifetime). A row
 *  a forget left without its session (keepUsageOf) also takes the session back from a snapshot as large that names it,
 *  of the same machine: the session is listed again (put back with `--undelete`, or indexed again from a transcript
 *  `--purge-store` left). Never another machine's: this machine's log would then leave the message out, and a machine that
 *  counted it from that log would lose it. */
const USAGE_TAKES = `${UNIT('excluded')} > ${UNIT('usage_messages')} OR (${UNIT('excluded')} = ${UNIT('usage_messages')} AND excluded.ts < usage_messages.ts)
  OR (usage_messages.session_id = '' AND excluded.session_id <> '' AND excluded.machine_id = usage_messages.machine_id
    AND ${UNIT('excluded')} >= ${UNIT('usage_messages')})
  OR (${UNIT('excluded')} = ${UNIT('usage_messages')} AND usage_messages.provider IS NULL AND excluded.provider IS NOT NULL)`;

/** Write a message's usage at its largest snapshot, between two equal ones the earlier (a fork's copy carries the time
 *  the message was first written). The same message from another file, or from another machine's copy of it, is the
 *  same row: a message is counted once however many files and machines hold it. True when it wrote. */
const USAGE_UPSERT = `INSERT INTO usage_messages (${USAGE_COLS.join(', ')}) VALUES (${USAGE_COLS.map(() => '?').join(', ')})
  ON CONFLICT(message_id) DO UPDATE SET ${USAGE_COLS.filter((c) => c !== 'message_id').map((c) => (c === 'account' ? 'account = coalesce(excluded.account, usage_messages.account)' : `${c} = excluded.${c}`)).join(', ')}
  WHERE ${USAGE_TAKES}`;

/** One message's usage as a line reports it. */
export interface UsageMessage {
  id: string;
  agent: 'claude' | 'codex';
  session: string;
  model: string;
  ts: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /** Of `cacheCreate`, the writes kept an hour; null where the line records no split. */
  cacheCreate1h?: number | null;
  /** Claude's fast mode and US-only inference, where the line records them. */
  speed?: string | null;
  geo?: string | null;
  /** The agent whose transcript it came from (its file's name), '' for the session's own turns. */
  worker?: string;
}

/** The per-model weekly cap's family (the account's "Fable" row), which the status line splits out the same way. */
export const TOP_TIER = /fable|mythos/i;

/** A message's list-price cost at today's prices (pricing.ts), and whether it is approximate: Codex's turns are priced
 *  under the provider that served them. */
function usageCost(agent: string, model: string, provider: string | null, t: { input: number; output: number; cacheCreate: number; cacheCreate1h: number | null;
  cacheRead: number; speed: string | null; geo: string | null }): { usd: number; approx: boolean } {
  const m = agent === 'codex' && provider && provider !== 'openai' ? `provider:${provider}/${model}` : model;
  return priceUsage(m, { input: t.input, output: t.output, cacheWrite: t.cacheCreate, cacheWrite1h: t.cacheCreate1h, cacheRead: t.cacheRead, speed: t.speed, geo: t.geo });
}

/** The upsert, prepared once per connection: it runs once per line that reports usage, and preparing it (its triggers'
 *  programs with it) cost more than running it. */
const usageUpserts = new WeakMap<DatabaseSync, StatementSync>();

function writeUsage(r: Run, machine: string, u: UsageMessage, account: string | null, provider: string | null = null): boolean {
  const detail = { ...u, cacheCreate1h: u.cacheCreate1h ?? null, speed: u.speed ?? null, geo: u.geo ?? null };
  const cost = usageCost(u.agent, u.model, provider, detail);
  const values = fitRow(r.db, 'usage_messages', USAGE_COLS, [u.id, u.agent, machine, u.session, account, u.model, u.ts, u.input, u.output, u.cacheCreate, u.cacheRead,
    cost.usd, TOP_TIER.test(u.model) ? 1 : 0, r.pub.owns(machine) ? nextSeq(r) : 0, null, detail.cacheCreate1h, u.agent === 'codex' ? provider ?? 'openai' : '', detail.speed,
    detail.geo, PRICE_VERSION, cost.approx ? 1 : 0, u.worker ?? '']);
  let upsert = usageUpserts.get(r.db);
  if (!upsert) usageUpserts.set(r.db, (upsert = r.db.prepare(USAGE_UPSERT)));
  const changed = Number(upsert.run(...values).changes) > 0;
  if (changed) {
    if (r.pub.owns(machine)) r.usagePub.set(u.id, { machine, values });
    count(r);
  }
  return changed;
}

const num0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** What a message's usage counts toward the largest snapshot (UNIT): input, output and cache creation. */
const units = (u: UsageMessage): number => u.input + u.output + u.cacheCreate;

/** A usage line's figures, or null for a line that reports none (no `message.usage`, no time, nothing counted). Read as
 *  the status line reads it: the line's own `message.usage`, whatever kind of line, timed by its `timestamp`. */
export function usageOfLine(o: unknown, session: string, fallbackId: string): UsageMessage | null {
  const rec = o as { type?: string; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } } | null;
  if (rec?.type === 'api-request-blob') return null;
  const u = rec?.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const ts = typeof rec!.timestamp === 'string' ? Date.parse(rec!.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const input = num0(u.input_tokens), output = num0(u.output_tokens), cacheCreate = num0(u.cache_creation_input_tokens), cacheRead = num0(u.cache_read_input_tokens);
  if (input + output + cacheCreate + cacheRead === 0) return null;
  const id = typeof rec!.message!.id === 'string' && rec!.message!.id ? rec!.message!.id : fallbackId;
  // The writes by how long they are kept (`cache_creation`), where the line splits them: those kept an hour cost more.
  const split = u.cache_creation && typeof u.cache_creation === 'object' ? (u.cache_creation as Record<string, unknown>) : null;
  const text = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 ? v : null);
  return { id, agent: 'claude', session, model: typeof rec!.message!.model === 'string' ? rec!.message!.model : '', ts, input, output, cacheCreate, cacheRead,
    cacheCreate1h: split ? Math.min(cacheCreate, num0(split.ephemeral_1h_input_tokens)) : null, speed: text(u.speed), geo: text(u.inference_geo) };
}

const USAGE_NEEDLE = Buffer.from('"usage"');

/**
 * A Claude Code transcript's usage (a session's own, or one of its workers'), from its cursor: each line that reports a
 * message's usage, at its largest snapshot. A replaced or rewritten file is read from the start again, which writes
 * nothing twice (a message is its row). A line still being written waits for its newline. `deleted`: a session deleted
 * before this index knew it (deletedUsage), whose rows name no session, read from a cursor of its own. `worker`: the file
 * is one of the session's workers', whose rows name it (UsageMessage.worker).
 */
function ingestUsageFile(r: Run, machine: string, id: string, file: string, account: string | null, deleted = false, worker = false): void {
  const source = `${deleted ? 'deleted-usage' : 'usage'}:${file}`;
  const prev = getState(r, source);
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const st = fs.fstatSync(fd);
    if (prev?.state === 'done' && prev.dev === st.dev && prev.ino === st.ino && prev.size === st.size && prev.mtime_ms === st.mtimeMs) return;
    let cursor = prev?.cursor ?? 0;
    let restart = !prev || prev.dev !== st.dev || prev.ino !== st.ino || st.size < cursor;
    if (!restart && cursor > 0) {
      const g = guards(fd, cursor);
      restart = g.head !== prev!.head_sha || g.anchor !== prev!.anchor_sha;
    }
    if (restart) cursor = 0;
    const name = path.basename(file, '.jsonl');
    while (cursor < st.size) {
      const parts = [readAt(fd, cursor, Math.min(CHUNK_BYTES, st.size - cursor))];
      let read = parts[0].length;
      let end = parts[0].lastIndexOf(0x0a);
      while (end < 0 && cursor + read < st.size) {
        const more = readAt(fd, cursor + read, Math.min(CHUNK_BYTES, st.size - cursor - read));
        if (!more.length) break;
        parts.push(more);
        const nl = more.lastIndexOf(0x0a);
        if (nl >= 0) end = read + nl;
        read += more.length;
      }
      if (end < 0) break; // a line still being written
      const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      begin(r);
      // Only the lines that name a usage are parsed: most of a transcript is tool output. A message Claude Code writes as
      // several lines while it streams is written once per read, at the snapshot writeUsage would keep of them.
      const best = new Map<string, UsageMessage>();
      for (let at = buf.indexOf(USAGE_NEEDLE); at >= 0 && at <= end;) {
        const start = buf.lastIndexOf(0x0a, at) + 1;
        const stop = buf.indexOf(0x0a, at);
        let o: unknown;
        try {
          o = JSON.parse(buf.toString('utf8', start, stop));
        } catch {
          o = null;
        }
        const u = o ? usageOfLine(o, deleted ? '' : id, `${id}/${name}@${cursor + start}`) : null;
        const was = u ? best.get(u.id) : undefined;
        if (u && (!was || units(u) > units(was) || (units(u) === units(was) && u.ts < was.ts))) best.set(u.id, u);
        at = buf.indexOf(USAGE_NEEDLE, stop + 1);
      }
      for (const u of best.values()) {
        writeUsage(r, machine, worker ? { ...u, worker: name } : u, account);
        if (r.txRows >= TX_ROWS) { commit(r); keepLease(r); begin(r); }
      }
      cursor += end + 1;
      const g = guards(fd, cursor);
      putState(r, { source, kind: 'usage', machine, session: id, st, cursor, head: g.head, anchor: g.anchor, state: 'reading' });
      breathe(r);
      r.afterBatch?.();
    }
    const g = guards(fd, cursor);
    begin(r);
    putState(r, { source, kind: 'usage', machine, session: id, st, cursor, head: g.head, anchor: g.anchor, state: 'done' });
  } finally {
    fs.closeSync(fd);
  }
}

/** The worker transcripts beside a session's transcript (`<project>/<id>/subagents/…`), whose turns the account pays for
 *  as it pays for the session's own. */
function workerTranscripts(transcript: string, id: string): string[] {
  const files: { file: string; st: fs.Stats }[] = [];
  walkFiles(path.join(path.dirname(transcript), id, 'subagents'), 3, (n) => n.endsWith('.jsonl'), files);
  return files.map((f) => f.file);
}

/** The Codex account OAK cached the last time it read the account's quota (codex-account.ts), by the hash it keeps; read
 *  from that cache alone (never Codex's login), and null without one. */
function cachedCodexAccount(): string | null {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), 'codex-account-usage.json'), 'utf8')) as { version?: unknown; source?: unknown; account?: unknown };
    return q?.version === 1 && q.source === 'app-server' && typeof q.account === 'string' && /^[0-9a-f]{8,64}$/.test(q.account) ? q.account : null;
  } catch {
    return null;
  }
}

/** A Codex rollout's usage (its turns' usage events, as the feed derives them) and the newest quota reading it records;
 *  `deleted` as ingestUsageFile takes it. */
function ingestCodexUsage(r: Run, machine: string, id: string, rollout: string, deleted = false): void {
  let deltas: ReturnType<typeof codexUsageDeltas>;
  try {
    deltas = codexUsageDeltas(rollout);
  } catch (e) {
    r.problems.push(`usage of ${id}: ${String((e as Error)?.message || e)}`);
    return;
  }
  // The events are derived append-only: those written before are skipped while the last one written is still where it was.
  const source = `${deleted ? 'deleted-codex-usage' : 'codex-usage'}:${rollout}`;
  const prev = getState(r, source);
  const from = prev && prev.cursor > 0 && prev.cursor <= deltas.length && deltas[prev.cursor - 1]?.id === prev.state ? prev.cursor : 0;
  const account = cachedCodexAccount();
  begin(r);
  for (let i = from; i < deltas.length; i++) {
    const d = deltas[i];
    writeUsage(r, machine, { id: `codex:${d.id}`, agent: 'codex', session: deleted ? '' : id, model: d.model, ts: d.ts, input: d.usage.input, output: d.usage.output,
      cacheCreate: d.usage.cacheWrite, cacheRead: d.usage.cacheRead }, account, d.provider);
    if (r.txRows >= TX_ROWS) { commit(r); keepLease(r); begin(r); }
  }
  putState(r, { source, kind: 'codex-usage', machine, session: id, cursor: deltas.length, state: deltas[deltas.length - 1]?.id ?? null });
  try {
    const q = codexUsage(rollout);
    if (q.snapshotMs) {
      if (q.fivePct !== null) writeReading(r, { agent: 'codex', kind: 'five', measured_ms: q.snapshotMs, pct: q.fivePct, reset_ms: q.fiveReset, source: 'rollout' });
      if (q.weekPct !== null) writeReading(r, { agent: 'codex', kind: 'week', measured_ms: q.snapshotMs, pct: q.weekPct, reset_ms: q.weekReset, source: 'rollout' });
    }
  } catch {
    /* a rollout that records no quota */
  }
}

const READING_COLS = ['machine_id', 'agent', 'kind', 'measured_ms', 'no_limit', 'label', 'account', 'pct', 'reset_ms', 'start_ms', 'tokens', 'budget', 'reads', 'cost',
  'cost_budget', 'source', 'seq', 'synced_ms'] as const;

type Reading = Partial<Record<(typeof READING_COLS)[number], string | number | null>> & { agent: string; kind: string; measured_ms: number; source: string };

/** One of the account's shares as this machine read it, kept once per time it was measured (a reading that has not moved
 *  writes nothing). */
function writeReading(r: Run, x: Reading): void {
  const values = fitRow(r.db, 'usage_readings', READING_COLS, READING_COLS.map((c) => (c === 'machine_id' ? r.me : c === 'seq' ? 0 : c === 'synced_ms' ? null : x[c] ?? null)));
  const steady = READING_COLS.filter((c) => c !== 'seq');
  const changed = Number(r.db.prepare(`${upsertSql('usage_readings', ['machine_id', 'agent', 'kind', 'measured_ms'], READING_COLS)}
    WHERE ${steady.map((c) => `usage_readings.${c} IS NOT excluded.${c}`).join(' OR ')}`).run(...values).changes) > 0;
  if (!changed) return;
  const seq = nextSeq(r);
  r.db.prepare('UPDATE usage_readings SET seq = ? WHERE machine_id = ? AND agent = ? AND kind = ? AND measured_ms = ?').run(seq, r.me, x.agent, x.kind, values[3]);
  values[READING_COLS.indexOf('seq')] = seq;
  pubValues(r, 'usage_readings', r.me, READING_COLS, values);
  count(r);
}

/** A time the status line's cache holds: epoch seconds, epoch milliseconds or an ISO string, as epoch milliseconds. */
function cacheMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v > 1e12 ? v : v * 1000);
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * What this machine's caches say of the accounts: the shares the status line last read of the Claude account (with the
 * estimates and budgets it projected, and the bill-cycle month), the spend Claude Code reported for each session (its
 * ledger), the Codex account's shares as OAK last pulled them, and which accounts this machine is signed in to. Each
 * reading is kept with when it was measured: a share with no time it was measured is no reading (it cannot be placed in
 * a window).
 */
function ingestUsageMachine(r: Run, account: string | null): void {
  for (const row of (require('../account-billing') as typeof import('../account-billing')).localBillDays()) {
    const was = r.db.prepare('SELECT day, updated_ms FROM account_bill_days WHERE machine_id = ? AND agent = ? AND account = ?')
      .get(row.machine_id, row.agent, row.account) as { day: number; updated_ms: number } | undefined;
    if (was?.day === row.day && was.updated_ms === row.updated_ms) continue;
    begin(r);
    const cols = ['machine_id', 'agent', 'account', 'day', 'updated_ms', 'seq', 'synced_ms'];
    const values = [row.machine_id, row.agent, row.account, row.day, row.updated_ms, nextSeq(r), null];
    r.db.prepare(upsertSql('account_bill_days', ['machine_id', 'agent', 'account'], cols)).run(...values);
    pubValues(r, 'account_bill_days', r.me, cols, values);
    count(r);
  }
  const file = path.join(claudeConfigDir(), 'statusline-last.json');
  let c: Record<string, unknown> | null = null;
  let mtime = 0;
  try {
    c = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    mtime = Math.round(fs.statSync(file).mtimeMs);
  } catch {
    c = null;
  }
  begin(r);
  if (c && typeof c === 'object') {
    const at = (k: string): number | null => cacheMs(c![k]);
    const base = { agent: 'claude', account, source: 'statusline' };
    if (fin(c.five_pct) !== null && at('five_at')) {
      writeReading(r, { ...base, kind: 'five', measured_ms: at('five_at')!, pct: fin(c.five_pct), reset_ms: cacheMs(c.five_reset), tokens: fin(c.five_tok), budget: fin(c.five_total), reads: fin(c.five_reads) });
    }
    // The account's answers on its five-hour limit (accountUsage.ts, and the status line's own pull): when it last answered
    // with no 5h window (`five_none_at`) and when it last answered with one (`five_seen_at`), each a reading of kind
    // `limit` (`no_limit` 1 and 0), which every machine weighs as it weighs the same two times in this machine's brief
    // (observe.ts noFiveHourLimitIfNewest). Read as the brief reads them (epoch seconds, to ms); the same second is no
    // limit there, so it is kept once, as no limit. No share is such a reading.
    const answer = (k: string): number | null => {
      const v = fin(c![k]);
      const ms = v === null ? null : Math.round(v * 1000);
      return ms !== null && ms >= 1 && Number.isSafeInteger(ms) ? ms : null;
    };
    const noneAt = answer('five_none_at');
    const seenAt = answer('five_seen_at');
    if (seenAt !== null && seenAt !== noneAt) writeReading(r, { ...base, kind: 'limit', measured_ms: seenAt, no_limit: 0 });
    if (noneAt !== null) writeReading(r, { ...base, kind: 'limit', measured_ms: noneAt, no_limit: 1 });
    if (fin(c.week_pct) !== null && at('week_at')) {
      writeReading(r, { ...base, kind: 'week', measured_ms: at('week_at')!, pct: fin(c.week_pct), reset_ms: cacheMs(c.week_reset), tokens: fin(c.week_tok), budget: fin(c.week_total), reads: fin(c.week_reads) });
    }
    const fableAt = at('fable_at') ?? at('api_ts');
    if (fin(c.fable_pct) !== null && fableAt) {
      writeReading(r, { ...base, kind: 'model', measured_ms: fableAt, label: typeof c.fable_label === 'string' ? c.fable_label : '', pct: fin(c.fable_pct), reset_ms: cacheMs(c.fable_reset),
        tokens: fin(c.fable_tok), budget: fin(c.fable_tok_total), reads: fin(c.fable_reads) });
    }
    // The bill-cycle month the status line measured and projected, while its cycle runs.
    const monthEnd = cacheMs(c.month_reset);
    if (fin(c.month_tok) !== null && monthEnd && monthEnd > r.now) {
      writeReading(r, { ...base, kind: 'month', measured_ms: at('meas_at') ?? mtime, reset_ms: monthEnd, start_ms: cacheMs(c.month_meas_start), tokens: fin(c.month_tok),
        budget: fin(c.month_tok_total), reads: fin(c.month_reads), cost: fin(c.month_cost), cost_budget: fin(c.month_cost_total) });
    }
    // The spend ledger: each session's spend as Claude Code reported it, the latest report of each. A report kept is each
    // one's cumulative spend and what it added since that session's report before it; one that added nothing (the
    // status line reports at every render) is not kept.
    const ledger = c.costs && typeof c.costs === 'object' ? (c.costs as Record<string, { usd?: unknown; at?: unknown }>) : {};
    const SPEND_COLS = ['machine_id', 'session_id', 'reported_ms', 'usd', 'delta', 'account', 'seq', 'synced_ms'];
    for (const [sid, e] of Object.entries(ledger)) {
      const usd = fin(e?.usd);
      const when = cacheMs(e?.at);
      if (usd === null || !when || !isSafeSessionId(sid)) continue;
      if (r.db.prepare('SELECT 1 FROM usage_spend WHERE machine_id = ? AND session_id = ? AND reported_ms = ?').get(r.me, sid, when)) continue;
      const before = (r.db.prepare('SELECT usd FROM usage_spend WHERE machine_id = ? AND session_id = ? AND reported_ms < ? ORDER BY reported_ms DESC LIMIT 1').get(r.me, sid, when) as { usd: number } | undefined)?.usd;
      if (before === usd) continue;
      const was = before ?? 0;
      const values = fitRow(r.db, 'usage_spend', SPEND_COLS, [r.me, sid, when, usd, usd >= was ? usd - was : usd, account, nextSeq(r), null]);
      r.db.prepare(upsertSql('usage_spend', ['machine_id', 'session_id', 'reported_ms'], SPEND_COLS)).run(...values);
      pubValues(r, 'usage_spend', r.me, SPEND_COLS, values);
      count(r);
    }
  }
  // The Codex account's shares as OAK's own pull cached them (codex-account.ts): read from the cache, never from Codex.
  try {
    const q = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), 'codex-account-usage.json'), 'utf8')) as Record<string, unknown>;
    const when = fin(q.snapshotMs);
    if (q.version === 1 && q.source === 'app-server' && when && when > 0) {
      const acct = typeof q.account === 'string' ? q.account : null;
      if (fin(q.fivePct) !== null) writeReading(r, { agent: 'codex', kind: 'five', measured_ms: when, account: acct, pct: fin(q.fivePct), reset_ms: fin(q.fiveReset), source: 'app-server' });
      if (fin(q.weekPct) !== null) writeReading(r, { agent: 'codex', kind: 'week', measured_ms: when, account: acct, pct: fin(q.weekPct), reset_ms: fin(q.weekReset), source: 'app-server' });
    }
  } catch {
    /* no Codex quota pulled here */
  }
  // The accounts this machine is signed in to, with when it was first and last seen on each (an hour at a time).
  const ACCOUNT_COLS = ['account', 'agent', 'machine_id', 'first_ms', 'last_ms', 'seq', 'synced_ms'];
  for (const [acct, agent] of [[account, 'claude'], [cachedCodexAccount(), 'codex']] as const) {
    if (!acct) continue;
    const was = r.db.prepare('SELECT first_ms, last_ms FROM accounts WHERE account = ? AND agent = ? AND machine_id = ?').get(acct, agent, r.me) as { first_ms: number; last_ms: number } | undefined;
    if (was && r.now - was.last_ms < 3600_000) continue;
    const values = fitRow(r.db, 'accounts', ACCOUNT_COLS, [acct, agent, r.me, was?.first_ms ?? r.now, r.now, nextSeq(r), null]);
    r.db.prepare(upsertSql('accounts', ['account', 'agent', 'machine_id'], ACCOUNT_COLS)).run(...values);
    pubValues(r, 'accounts', r.me, ACCOUNT_COLS, values);
    count(r);
  }
}

/** The usage of one session's files: its transcripts and their workers', or its rollouts (`deleted`: deletedUsage). */
function ingestUsage(r: Run, machine: string, s: SessionSources, deleted = false): void {
  r.account ??= claudeAccountTag();
  for (const t of s.transcripts) {
    ingestUsageFile(r, machine, s.id, t.t.file, r.account, deleted);
    commit(r);
    for (const w of workerTranscripts(t.t.file, s.id)) {
      ingestUsageFile(r, machine, s.id, w, r.account, deleted, true);
      commit(r);
    }
  }
  for (const x of s.rollouts) {
    ingestCodexUsage(r, machine, s.id, x.file, deleted);
    commit(r);
  }
}

/** The sessions deleted here (hidden) before this index knew them: with OAK 0.10.0, which kept their transcripts, or
 *  where no index could hear of the delete. One this index forgot itself (its tombstone) or holds is none. Their usage
 *  counts toward the account's, as the status line's own scan counts it, without the session (deletedUsage). */
function deletedUnknown(db: DatabaseSync, d: Discovery): SessionSources[] {
  const here = [...d.hidden].map((id) => d.sessions.get(id)).filter((s): s is SessionSources => !!s && !DEMO_SESSION.test(s.id) && (s.transcripts.length > 0 || s.rollouts.length > 0));
  if (!here.length) return [];
  const ids = JSON.stringify(here.map((s) => s.id));
  const known = new Set((db.prepare('SELECT session_id FROM sessions WHERE session_id IN (SELECT value FROM json_each(?1)) UNION SELECT session_id FROM tombstones WHERE session_id IN (SELECT value FROM json_each(?1))')
    .all({ '?1': ids }) as { session_id: string }[]).map((x) => x.session_id));
  return here.filter((s) => !known.has(s.id));
}

// --- notes, replicas, machines ------------------------------------------------------------------------------------

function noteTitle(text: string, file: string): string {
  const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(graphemeHead(text, 4096));
  return (m?.[1] ?? path.basename(file, '.md')).replace(/\s+/g, ' ').trim();
}

const NOTE_COLS = ['machine_id', 'kind', 'path', 'project', 'title', 'text', 'size', 'mtime_ms', 'sha', 'archived_ms'] as const;

function ingestNotes(r: Run, notes: Discovery['notes']): void {
  const have = new Map<string, { mtime: number; size: number; archived: number | null }>();
  for (const row of r.db.prepare('SELECT kind, path, size, mtime_ms, archived_ms FROM notes WHERE machine_id = ?').all(r.me) as { kind: string; path: string; size: number; mtime_ms: number; archived_ms: number | null }[]) {
    have.set(`${row.kind}\u0000${row.path}`, { mtime: row.mtime_ms, size: row.size, archived: row.archived_ms });
  }
  const up = r.db.prepare(upsertSql('notes', ['machine_id', 'kind', 'path'], NOTE_COLS));
  const seen = new Set<string>();
  begin(r);
  for (const n of notes) {
    const key = `${n.kind}\u0000${n.file}`;
    seen.add(key);
    const prev = have.get(key);
    if (prev && prev.archived === null && prev.size === n.st.size && prev.mtime === n.st.mtimeMs) continue;
    let text = '';
    try {
      const fd = fs.openSync(n.file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(NOTE_CAP, n.st.size));
        const got = fs.readSync(fd, buf, 0, buf.length, 0);
        text = buf.toString('utf8', 0, got);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const values = fitRow(r.db, 'notes', NOTE_COLS, [r.me, n.kind, n.file, n.project, noteTitle(text, n.file), text, n.st.size, n.st.mtimeMs, createHash('sha256').update(text).digest('hex'), null]);
    up.run(...values);
    pubValues(r, 'notes', r.me, NOTE_COLS, values);
    count(r);
    breathe(r);
    begin(r);
  }
  // A plan swept by Claude Code's retention, or a memory removed: kept, as archived.
  const gone = r.db.prepare('UPDATE notes SET archived_ms = ? WHERE machine_id = ? AND kind = ? AND path = ? AND archived_ms IS NULL');
  for (const [key, prev] of have) {
    if (seen.has(key) || prev.archived !== null) continue;
    const [kind, file] = key.split('\u0000');
    gone.run(r.now, r.me, kind, file);
    pubStored(r, 'notes', r.me, { kind, path: file });
    count(r);
  }
}

const DELEGATED_COLS = ['machine_id', 'id', 'title', 'brief', 'cwd', 'out', 'report', 'kind', 'agent_type', 'model', 'effort', 'sandbox', 'machine', 'workspace',
  'tab', 'pane', 'session_id', 'parent', 'started_ms', 'ended_ms', 'closed_ms', 'state', 'since_ms', 'error', 'stamp', 'worktree_json'] as const;

/** The delegated agents' records: each one whose files changed, read again; each one removed, dropped. */
function ingestDelegated(r: Run, found: Discovery['delegated']): void {
  const have = new Map((r.db.prepare('SELECT id, stamp FROM delegated WHERE machine_id = ?').all(r.me) as { id: string; stamp: string }[]).map((x) => [x.id, x.stamp]));
  const up = r.db.prepare(upsertSql('delegated', ['machine_id', 'id'], DELEGATED_COLS));
  begin(r);
  for (const { id, stamp } of found) {
    const prev = have.get(id);
    have.delete(id);
    if (prev === stamp) continue;
    const a = readDelegated(id);
    if (!a) continue;
    const values = fitRow(r.db, 'delegated', DELEGATED_COLS, [r.me, a.id, a.title, a.brief, a.cwd, a.out, a.report, a.kind, a.agentType, a.model, a.effort, a.sandbox,
      a.machine, a.workspace, a.tab, a.pane, a.session, a.parent, a.startedMs, a.endedMs, a.closedMs, a.state, a.since, a.error ?? null, stamp, a.worktree ? JSON.stringify(a.worktree) : null]);
    up.run(...values);
    pubValues(r, 'delegated', r.me, DELEGATED_COLS, values);
    count(r);
  }
  const gone = r.db.prepare('DELETE FROM delegated WHERE machine_id = ? AND id = ?');
  for (const id of have.keys()) {
    gone.run(r.me, id);
    r.pub.delete(r.me, 'delegated', { id });
    count(r);
  }
}

/** Another machine's session log, as oak sync keeps a copy of it: its records, marked with that machine. */
function ingestReplica(r: Run, rep: Discovery['replicas'][number]): void {
  const source = `replica:${rep.origin}:${rep.session}`;
  const stamp = stampOf(rep.st);
  if (current(getState(r, source), stamp)) return;
  // That machine's record log holds the session (records.ts), with what only its store can tell (line counts, review
  // units, project paths): the copy of its log adds nothing to it.
  const origin = (r.db.prepare('SELECT origin FROM sessions WHERE machine_id = ? AND session_id = ?').get(rep.origin, rep.session) as { origin: string } | undefined)?.origin;
  if (origin === 'synced') return;
  // A session whose conversation oak sync pulled here keeps the row its files gave (written as a replica's, it left the
  // listings until the next catch-up). One this machine also captured itself (resumed here) holds its own store's
  // records under that key, which the copy of the other machine's log never replaces.
  const pulled = origin === 'pulled';
  if (pulled && storeHere(r, rep.session)) {
    begin(r);
    putState(r, { source, kind: 'replica', machine: rep.origin, session: rep.session, st: rep.st, state: stamp });
    return;
  }
  const records = readLogFile(rep.file);
  begin(r);
  r.db.prepare(upsertSql('machines', ['machine_id'], ['machine_id', 'is_self'])).run(rep.origin, 0);
  let last = 0;
  let pending = 0;
  const files = new Set<string>();
  for (const rec of records) {
    last = Math.max(last, rec.ts);
    if (rec.status === 'pending') pending++;
    files.add(rec.file);
  }
  const row: Row = {
    machine_id: rep.origin, session_id: rep.session, agent: 'claude', origin: 'replica', listed: 0, review: 0, title: null, first_prompt: null,
    workspace: '', cwd: null, project_key: null, transcript_path: null, rollout_path: null, first_ms: null, last_active_ms: Math.round(last || rep.st.mtimeMs),
    last_turn_ms: null, capture_ms: 0, tokens: 0, cached: 0, duration_ms: 0, model: '', effort: '', edits: records.length, pending, files: files.size,
    added: 0, removed: 0, last_edit_id: records.reduce((m, x) => Math.max(m, x.id), 0), gaps: 0, store_bytes: 0, hidden: 0, archived_ms: null,
    archived_reason: null, archive_hint: null, inputs: stamp, facts: null, updated_ms: r.now,
  };
  if (!pulled) r.db.prepare(upsertSql('sessions', ['machine_id', 'session_id'], SESSION_COLS)).run(...fitRow(r.db, 'sessions', SESSION_COLS, SESSION_COLS.map((c) => row[c] ?? null)));
  count(r);
  writeEdits(r, rep.origin, rep.session, records, { key: null, root: null });
  putState(r, { source, kind: 'replica', machine: rep.origin, session: rep.session, st: rep.st, state: stamp });
}

/** Whether this machine's store holds a session of this id (its capture recorded it here), asked once a catch-up. */
function storeHere(r: Run, id: string): boolean {
  let v = r.storeHere.get(id);
  if (v === undefined) r.storeHere.set(id, (v = isSafeSessionId(id) && fs.existsSync(storeDir(id))));
  return v;
}

// --- the record logs ------------------------------------------------------------------------------------------------

/** Tables a record names a session in: what a purge or a clear removes. */
const SESSION_RECORD_TABLES = Object.keys(RECORD_TABLES).filter((t) => RECORD_TABLES[t].keys.includes('session_id') || t === 'sessions' || t === 'usage_messages');

/** The tables whose rows a machine extracts from a session's conversation: where this machine reads a copy of that
 *  conversation itself (one oak sync pulled here), its own reading of it stands, and the other machine's record of the
 *  same rows waits until that copy is gone. */
const CONVERSATION_TABLES = new Set(['sessions', 'prompts', 'actions', 'agents', 'workflow_runs']);

/** The tables whose rows a machine reads from a session's store: where this machine pulled a session's conversation and
 *  then captured it itself (resumed here), its own store's rows under that key stand, and the other machine's record of
 *  its own store waits until this machine's store of the session is gone (attention keeps its own rule, applyRecord). */
const STORE_TABLES = new Set(['edits', 'edit_ops', 'capture_gaps', 'units', 'comments', 'waits', 'blobs']);

const recordSql = new WeakMap<DatabaseSync, Map<string, { sql: string; cols: string[] }>>();

/** The upsert for one table's records with these columns (those the table has), keyed by the machine and the record's
 *  key. A message keeps its largest snapshot, as when it is read from a file. */
function recordUpsert(db: DatabaseSync, table: string, given: string[], own = false): { sql: string; cols: string[] } {
  let byKey = recordSql.get(db);
  if (!byKey) recordSql.set(db, (byKey = new Map()));
  const k = `${table}\u0000${given.join(',')}\u0000${own}`;
  let hit = byKey.get(k);
  if (hit) return hit;
  const have = recordColumns(db, table);
  const cols = ['machine_id', ...given.filter((c) => have.has(c) && c !== 'machine_id' && c !== 'synced_ms'), 'synced_ms'];
  if (table === 'sessions') for (const c of ['updated_ms', 'listed']) if (!cols.includes(c)) cols.push(c);
  // A message's details a record does not carry are unknown (USAGE_DETAIL).
  if (table === 'usage_messages') for (const c of USAGE_DETAIL) if (have.has(c) && !cols.includes(c)) cols.splice(cols.length - 1, 0, c);
  const keys = table === 'usage_messages' ? ['message_id'] : ['machine_id', ...RECORD_TABLES[table].keys];
  let sql = upsertSql(table, keys, cols);
  // This machine's own session read back over a row its files gave: whether the listing shows it is the files' to say
  // (the record does not carry it), and a replay never hides it.
  if (table === 'sessions' && own) sql = sql.replace('listed = excluded.listed', 'listed = sessions.listed');
  if (table === 'usage_messages') sql += ` WHERE ${USAGE_TAKES}`;
  if (table === 'account_bill_days') sql += ' WHERE excluded.updated_ms >= account_bill_days.updated_ms';
  // Another machine's hand never replaces one this machine raised on the same row (applyRecord).
  if (table === 'attention' && !own) sql += ' WHERE attention.synced_ms IS NOT NULL';
  hit = { sql, cols };
  byKey.set(k, hit);
  return hit;
}

function noteForgotten(r: Run, host: string, ids: Iterable<string>): void {
  let set = r.forgotten.get(host);
  if (!set) r.forgotten.set(host, (set = new Set()));
  for (const id of ids) set.add(id);
}

/** Apply one record of `host`'s log. `own`: this machine's own log, read back into an index that lacks it (a new file):
 *  its rows are its own again, as they were when published. */
function applyRecord(r: Run, host: string, own: boolean, rec: Record<string, unknown>, pulled: () => Set<string>): void {
  const t = rec.t;
  if (t === 'batch' || t === 'base') {
    if (!own && typeof rec.at === 'number') {
      const label = typeof rec.label === 'string' ? graphemeHead(rec.label, 200) : null;
      // `label` is the name the machine gives itself, as its latest batch says it; the label this machine saved it under is
      // `saved_label` (noteSavedLabels).
      r.db.prepare(`INSERT INTO machines (machine_id, label, is_self, platform, synced_through_ms, last_seen_ms) VALUES (?, ?, 0, ?, ?, ?)
        ON CONFLICT(machine_id) DO UPDATE SET label = coalesce(excluded.label, machines.label), platform = coalesce(excluded.platform, machines.platform),
        synced_through_ms = max(coalesce(machines.synced_through_ms, 0), excluded.synced_through_ms), last_seen_ms = excluded.last_seen_ms`)
        .run(host, label, typeof rec.platform === 'string' ? rec.platform : null, Math.round(rec.at), r.now);
    }
    return;
  }
  if (t === 'purge' && typeof rec.s === 'string') {
    let removed = 0;
    for (const table of SESSION_RECORD_TABLES) if (!USAGE_ROWS.has(table)) removed += Number(r.db.prepare(`DELETE FROM ${table} WHERE machine_id = ? AND session_id = ?`).run(host, rec.s).changes);
    if (own && removed) setMeta(r.db, 'records_compact', '1');
    keepUsageOf(r.db, rec.s, host);
    if (!own) {
      r.db.prepare(upsertSql('tombstones', ['machine_id', 'session_id'], ['machine_id', 'session_id', 'deleted_ms', 'source', 'purged_ms'])).run(host, rec.s, r.now, 'deleted there', r.now);
      noteForgotten(r, host, [rec.s]);
    }
    count(r);
    return;
  }
  if (typeof t !== 'string' || !Object.hasOwn(RECORD_TABLES, t)) return; // a kind a newer OAK writes: not this one's to read
  const spec = RECORD_TABLES[t];
  const session = typeof rec.clear === 'string' ? rec.clear : rec.r && typeof rec.r === 'object' ? (rec.r as Record<string, unknown>).session_id : rec.d && typeof rec.d === 'object' ? (rec.d as Record<string, unknown>).session_id : undefined;
  // The simulator's sessions stay on the machine that ran them: a base an earlier build compacted may hold them, and none
  // is read.
  if (typeof session === 'string' && DEMO_SESSION.test(session)) return;
  if (!own && CONVERSATION_TABLES.has(t) && typeof session === 'string' && pulled().has(session)) return;
  if (!own && STORE_TABLES.has(t) && typeof session === 'string' && pulled().has(session) && storeHere(r, session)) return;
  // A hand this machine raised itself (a session pulled here and resumed here, filed under the machine it came from) is
  // this machine's to lower: another machine's records of that session's hand never touch it (`synced_ms` null).
  const theirs = !own && t === 'attention' ? ' AND synced_ms IS NOT NULL' : '';
  if (typeof rec.clear === 'string') {
    r.db.prepare(`DELETE FROM ${t} WHERE machine_id = ? AND session_id = ?${theirs}`).run(host, rec.clear);
  } else if (rec.d && typeof rec.d === 'object') {
    const key = rec.d as Record<string, unknown>;
    if (!spec.keys.every((k) => k in key)) return;
    r.db.prepare(`DELETE FROM ${t} WHERE machine_id = ? AND ${spec.keys.map((k) => `${k} = ?`).join(' AND ')}${theirs}`).run(host, ...spec.keys.map((k) => key[k] as string | number));
  } else if (rec.r && typeof rec.r === 'object') {
    const row = rec.r as Record<string, unknown>;
    if (!spec.keys.every((k) => k in row)) return;
    // This machine's own usage read back takes a write sequence of its own, as each write here does: the usage pull pages
    // by it, and rows that shared one would be cut off at a page's end.
    const seq = own && (USAGE_RECORD_TABLES as readonly string[]).includes(t) ? nextSeq(r) : null;
    const { sql, cols } = recordUpsert(r.db, t, seq === null ? Object.keys(row) : [...Object.keys(row).filter((c) => c !== 'seq'), 'seq'], own);
    const values = cols.map((c) => (c === 'seq' && seq !== null ? seq : c === 'machine_id' ? host : c === 'synced_ms' ? (own ? null : r.now) : c === 'updated_ms' ? r.now
      : c === 'listed' ? (own ? row.listed ?? 0 : 0) : c === 'origin' && !own ? 'synced' : row[c]));
    r.db.prepare(sql).run(...fitRow(r.db, t, cols, values));
  } else return;
  count(r);
}

/**
 * Apply the record logs this store holds, each from where this index last read it: every other machine's (its rows keyed
 * by that machine and marked with when they arrived), and this machine's own where this index lacks it (a new index file
 * reads its own log back, so the archive outlives the file). A machine's log read from a base on (its compaction) puts
 * the base's rows in place of every row of that machine it applied before. Stops at the deadline; the rest waits.
 * Returns whether it read everything.
 */
function applyRecordLogs(r: Run): boolean {
  let all = true;
  for (const host of recordHosts()) {
    const own = r.pub.owns(host);
    if (!own) dropCovered(host);
    let pulledMemo: Set<string> | null = null;
    const pulled = (): Set<string> => (pulledMemo ??= new Set((r.db.prepare("SELECT session_id FROM sessions WHERE machine_id = ? AND origin = 'pulled' AND archived_ms IS NULL")
      .all(host) as { session_id: string }[]).map((x) => x.session_id)));
    const was = logState(r.db, host);
    const plan = logPlan(host, was);
    // A base is read from after its first line, which names the machine as a batch line does: applied when the base is
    // read from its start, and where the index has no row for that machine yet (one that read a base before it did this).
    const base = own ? null : plan.reset ?? (r.db.prepare('SELECT 1 FROM machines WHERE machine_id = ?').get(host) ? null : wholeBase(segments(host)));
    // The sessions of that machine's this index held before a base replaced them, kept until the base is read whole, in
    // this catch-up or a later one: one the base no longer holds went on purpose there (a forgotten session's rows are
    // gone from it), as a purge record says of one.
    const heldKey = `records-reset:${host}`;
    const heldBefore = r.db.prepare('SELECT state FROM ingest_state WHERE source = ?').get(heldKey) as { state: string | null } | undefined;
    if (!plan.reset && !plan.steps.length && !base && !heldBefore && !(was?.partial && readWhole(host, was))) continue;
    const st: LogState = plan.reset ? { base: plan.reset.name, read: {} } : { base: was?.base ?? null, read: { ...(was?.read ?? {}) }, ...(was?.partial ? { partial: true as const } : {}) };
    // Where each planned segment is read from, recorded first: a catch-up stopped part way reads on from there, a segment
    // read again (one before it landed late) included. Partial until it is read to its end.
    for (const x of plan.steps) st.read[x.seg.name] = x.from;
    if (plan.steps.length) st.partial = true;
    let newer = false;
    const held = (): string[] => (r.db.prepare('SELECT DISTINCT session_id FROM sessions WHERE machine_id = ? AND synced_ms IS NOT NULL').all(host) as { session_id: string }[]).map((x) => x.session_id);
    try {
      begin(r);
      // A base: every row of that machine applied before gives way to it (its own rows stay: they are this machine's).
      if (plan.reset && !own) {
        // With those of a base before it that was not read whole yet.
        const kept = new Set([...(JSON.parse(heldBefore?.state ?? '[]') as string[]), ...held()]);
        r.db.prepare(upsertSql('ingest_state', ['source'], ['source', 'kind', 'machine_id', 'cursor', 'state', 'updated_ms'])).run(heldKey, 'records-reset', host, 0, JSON.stringify([...kept]), r.now);
        for (const table of Object.keys(RECORD_TABLES)) r.db.prepare(`DELETE FROM ${table} WHERE machine_id = ? AND synced_ms IS NOT NULL`).run(host);
      }
      const header = base ? baseHeader(base.file) : null;
      if (header) applyRecord(r, host, own, { t: 'base', at: header.at, label: header.label, platform: header.platform }, pulled);
      for (const item of readRecordLog(plan.steps)) {
        if (item.rec.t === 'batch' && typeof item.rec.v === 'number' && item.rec.v > RECORD_FORMAT) {
          newer = true;
          break;
        }
        applyRecord(r, host, own, item.rec, pulled);
        st.read[item.segment] = item.end;
        if (r.txRows >= TX_ROWS || Date.now() - r.txAt >= TX_MS) {
          setLogState(r.db, host, st);
          commit(r);
          keepLease(r);
          if (Date.now() > r.deadline) {
            all = false;
            break;
          }
          begin(r);
        }
      }
      // Partial until the log is read whole: a segment it was reading that is gone (lost, or landing part by part) keeps
      // its name here, and so does the base.
      const whole = all && !newer && readWhole(host, st);
      if (whole) delete st.partial;
      begin(r);
      setLogState(r.db, host, st);
      // Only once the base is read whole: before, the sessions it holds further on are not here yet.
      const reset = whole ? (r.db.prepare('SELECT state FROM ingest_state WHERE source = ?').get(heldKey) as { state: string | null } | undefined) : undefined;
      if (reset) r.db.prepare('DELETE FROM ingest_state WHERE source = ?').run(heldKey);
      commit(r);
      if (reset) {
        const after = new Set(held());
        noteForgotten(r, host, (JSON.parse(reset.state ?? '[]') as string[]).filter((id) => !after.has(id)));
      }
    } catch (e) {
      rollback(r);
      all = false;
      r.problems.push(`the record log of machine ${host}: ${String((e as Error)?.message || e)}`);
    }
    if (newer) r.problems.push(`machine ${host} writes its records in a newer format than this OAK reads: update OAK here (\`oak update\`)`);
    if (!all) break;
  }
  return all;
}

/** oak sync's last run (sync-engine.ts readSyncStatusFile): each machine it asked, by the label this machine saved it
 *  under and, where it was reached, its id. */
function syncRunStatus(): { at: number; machines: { label: string; host?: string }[] } | null {
  try {
    return (require('../sync-engine') as typeof import('../sync-engine')).readSyncStatusFile();
  } catch {
    return null;
  }
}

/** The label this machine saved each other machine under (herdr's list, which `--machine` takes), as oak sync's last run
 *  reached it, kept as that machine's `saved_label`; one the run did not reach keeps the label it had. A machine whose
 *  records have not named it yet is named by it too. Once per run. */
function noteSavedLabels(r: Run): void {
  const status = syncRunStatus();
  if (!status || getMeta(r.db, 'saved_labels_at') === String(status.at)) return;
  begin(r);
  const up = r.db.prepare('UPDATE machines SET saved_label = ?, label = coalesce(label, ?) WHERE machine_id = ? AND is_self = 0');
  for (const m of status.machines) if (typeof m.host === 'string' && m.label) up.run(graphemeHead(m.label, 200), graphemeHead(m.label, 200), m.host);
  setMeta(r.db, 'saved_labels_at', String(status.at));
  commit(r);
}

/** Whether this index has read a machine's log whole: the base it read is here whole, and every segment it read is here
 *  and read to its end. */
function readWhole(host: string, st: LogState): boolean {
  const segs = segments(host);
  if (st.base !== null && wholeBase(segs, st.base)?.name !== st.base) return false;
  const here = new Set(segs.map((x) => x.name));
  if (Object.keys(st.read).some((k) => !here.has(k))) return false;
  return unreadBytes(host, st) === 0;
}

/** The parts a stopped read can no longer find here. A base landing in parts is still here, and still waits. */
export function missingRecordParts(host: string, st: LogState): string[] {
  const here = new Set(segments(host).map((s) => s.name));
  return [...new Set([...(st.base ? [st.base] : []), ...Object.keys(st.read)])].filter((n) => !here.has(n));
}

/** Only a complete sync survey taken after this checkpoint can say a missing part has no copy to come back from.
 *  Any other part held elsewhere but absent here might be a base replacing it, so that too must come back first. */
function partialLogLost(db: DatabaseSync, host: string): boolean {
  const st = logState(db, host);
  if (!st?.partial || !missingRecordParts(host, st).length) return false;
  if (syncLockHeld(SYNC_RUN_STALE_MS)) return false;
  const plan = logPlan(host, st);
  if (plan.reset || plan.steps.length) return false;
  const segs = segments(host);
  if (segs.some((s) => s.base && wholeBase([s]) === null)) return false;
  try {
    const survey = JSON.parse(fs.readFileSync(path.join(syncDir(), 'records-survey.json'), 'utf8'));
    const row = db.prepare('SELECT updated_ms FROM ingest_state WHERE source = ?').get(`records:${host}`) as { updated_ms: number };
    const settings = (require('../sync-engine') as typeof import('../sync-engine')).syncSettings();
    if (typeof survey.at !== 'number' || survey.at <= row.updated_ms || survey.at > Date.now()
      || JSON.stringify(survey.backup) !== JSON.stringify(settings.backup) || !Array.isArray(survey.names)) return false;
    const here = new Set(segs.map((s) => `records/${host}/${s.name}`));
    return survey.names.every((n: unknown) => typeof n === 'string' && (!n.startsWith(`records/${host}/`) || here.has(n)));
  } catch {
    return false;
  }
}

/** Whether a compaction of this machine's own log `host` waits for it to be read whole, with nothing here left to read
 *  of it: a segment it was reading is gone, and oak sync brings it back from another machine or the backup. Nothing a
 *  catch-up could do meanwhile. */
function compactionWaits(db: DatabaseSync, host: string): boolean {
  const st = logState(db, host);
  if (!st?.partial) return st !== null && historyFrom(host, st) === null;
  const plan = logPlan(host, st);
  return !plan.reset && !plan.steps.length;
}

/** Bytes of the record logs this index has yet to read. */
function unreadLogBytes(db: DatabaseSync): number {
  let n = 0;
  for (const host of recordHosts()) n += unreadBytes(host, logState(db, host));
  return n;
}

/** A log this size or more, past twice what its last base holds, is compacted. */
const COMPACT_MIN_BYTES = 32 * 1024 * 1024;

/** Whether a segment of this machine's own log that this index read whole or wrote is no longer here, while the index
 *  holds rows of that machine's: nothing but a compaction (which records its base in their place) removes one, so the
 *  log was lost (OAK 0.10's `oak clean` removed the folder, or a hand did), and only this index holds what it carried.
 *  Not while this index had read the log only in part (a new index file reading it back): what it had not read is only in
 *  the log, which oak sync brings back from another machine or the backup, and a log written again from the index would
 *  cover it there too. Nor where the log holds a whole base newer than the one this index read: another index file over
 *  this store (the store reached by another path, an older format's file still in use) compacted it, and the next
 *  catch-up reads that base as this machine's own. */
export function ownLogLost(db: DatabaseSync, self: Iterable<string>): boolean {
  for (const host of self) {
    const st = logState(db, host);
    if (!st || st.partial) continue;
    const segs = segments(host);
    const here = new Set(segs.map((x) => x.name));
    if (![st.base, ...Object.keys(st.read)].some((n) => n && !here.has(n))) continue;
    const base = wholeBase(segs);
    if (base && base.name !== st.base && (st.base === null || base.name > st.base)) continue;
    if (db.prepare('SELECT 1 FROM sessions WHERE machine_id = ? AND synced_ms IS NULL LIMIT 1').get(host)) return true;
  }
  return false;
}

/** Where the history of a base written from this index begins: the oldest part of the log the index read (from a base it
 *  read, where that base's history began), never earlier. A machine set up again begins its log anew, and the log it kept
 *  before is no part of what its index read until oak sync brings it back: a base that covered that log would have every
 *  machine let go of it, and forget each session it held, where they and the backup are all that hold it. Undefined:
 *  every segment before the base; null: the index read none of the log. */
function historyFrom(host: string, st: LogState | null): string | undefined | null {
  const first = [...(st?.base ? [st.base] : []), ...Object.keys(st?.read ?? {})].sort()[0];
  if (first === undefined) return null;
  const segs = segments(host);
  const seg = first.endsWith('-base.jsonl') ? segs.find((s) => s.name === first) : undefined;
  const h = seg ? baseHeader(seg.file) : null;
  let from = h ? h.from : first;
  const complete = completeSegments(host, segs);
  for (let i = 0; i < segs.length; i++) {
    if (complete.has(segs[i].name) || (from !== undefined && segs[i].name < from)) continue;
    // Rows read from an unclosed prefix must not become authoritative base rows either. Wait for its final length.
    if (!segs[i].base && (st?.read[segs[i].name] ?? 0) > 0) return null;
    // An incomplete base has supplied no rows: the verified suffix beyond it may still be compacted.
    if (i + 1 === segs.length) return null;
    from = segs[i + 1].name;
  }
  return from;
}

/**
 * Compact this machine's own logs that grew past twice their last base (and at least COMPACT_MIN_BYTES), or that hold a
 * session forgotten since (`records_compact`): each becomes one base of the rows the index holds for it now, every
 * forgotten session's gone from it. Only by a catch-up that left nothing behind, and only a log the index has read to
 * its end: the base is written from the index, and what the index had not read yet would be lost with the segments it
 * replaces. Written in one write transaction, so the rows it reads are one snapshot, and no other process's catch-up
 * or delete (each appends to the log inside its own transaction, before it commits) runs between the snapshot and the
 * segments' removal.
 */
function compactRecords(r: Run, complete: boolean): void {
  const forced = getMeta(r.db, 'records_compact') === '1';
  let skipped = !complete;
  for (const host of complete ? r.pub.self : []) {
    const size = logBytes(host);
    // A log gone while this index holds what it published of it (OAK 0.10's `oak clean` removed the folder, before the
    // file that now keeps it there; or a hand did) is written again whole, from the index, as the catch-up asks. An index
    // that never published one (a new file) writes nothing here: oak sync brings this machine's log back where another
    // machine or the backup holds it.
    const gone = !size.total && forced && ownLogLost(r.db, [host]);
    if (!size.total && !gone) continue;
    if (!forced && (size.total < COMPACT_MIN_BYTES || size.total < 2 * size.base)) continue;
    try {
      write(r.db, () => {
        // Only from an index that read the log whole: a base covers the segments before it, on every machine, from where
        // the history the index read begins.
        const st = logState(r.db, host);
        if (unreadBytes(host, st) > 0 || st?.partial) {
          skipped = true;
          return;
        }
        const from = historyFrom(host, st);
        if (from === null) { skipped = true; return; }
        const out = writeBase(host, from, (line) => {
          // Purges survive the base without sync's separate tombstones, including after an index rebuild. Keep the
          // latest decision in the log and the index's deletes; a session explicitly put back has rows again.
          const purged = new Set<string>();
          for (const { rec } of readRecordLog(logPlan(host, null).steps)) {
            if (rec.t === 'purge' && typeof rec.s === 'string') purged.add(rec.s);
            else if (rec.t === 'sessions' && rec.r && typeof rec.r === 'object') purged.delete((rec.r as { session_id: string }).session_id);
          }
          for (const row of r.db.prepare('SELECT session_id FROM tombstones WHERE machine_id = ?').all(host) as { session_id: string }[]) purged.add(row.session_id);
          for (const table of Object.keys(RECORD_TABLES)) {
            const cols = table === 'prompts' ? '*, CAST(text AS BLOB) AS text, CAST(response AS BLOB) AS response' : '*';
            for (const row of r.db.prepare(`SELECT ${cols} FROM ${table} WHERE machine_id = ? AND synced_ms IS NULL`).iterate(host) as Iterable<Record<string, unknown>>) {
              // The simulator's sessions stay on this machine, in a base as in every segment (RecordWriter).
              if (typeof row.session_id === 'string' && DEMO_SESSION.test(row.session_id)) continue;
              for (const [k, v] of Object.entries(row)) if (v instanceof Uint8Array) row[k] = utf8(v);
              line(JSON.stringify({ t: table, r: recordRow(table, row) }));
            }
          }
          const held = r.db.prepare('SELECT 1 FROM sessions WHERE machine_id = ? AND session_id = ?');
          for (const id of purged) if (!DEMO_SESSION.test(id) && !held.get(host, id)) line(JSON.stringify({ t: 'purge', s: id }));
        });
        if (out) setLogState(r.db, host, { base: out.name, read: { [out.name]: out.bytes } });
      });
    } catch (e) {
      r.problems.push(`the record log could not be compacted: ${String((e as Error)?.message || e)}`);
      return;
    }
  }
  if (forced && !skipped) write(r.db, () => setMeta(r.db, 'records_compact', '0'));
}

// --- deliberate deletes and the archive ---------------------------------------------------------------------------

/** Every row of a session, or of several at once, their full-text entries with them (the external-content triggers delete
 *  those), and what the index recorded of their files: a deliberate delete forgets the session. */
export function purgeSession(db: DatabaseSync, ids: string | readonly string[], source: string, now = Date.now(), pub?: RecordWriter): number {
  const list = typeof ids === 'string' ? [ids] : [...new Set(ids)];
  if (!list.length) return 0;
  const [where, arg] = ofSessions(list);
  const demo = list.filter((id) => DEMO_SESSION.test(id));
  let n = 0;
  const machines = new Map<string, string[]>();
  for (const x of db.prepare(`SELECT DISTINCT session_id, machine_id FROM sessions WHERE ${where}`).all(arg) as { session_id: string; machine_id: string }[]) {
    machines.set(x.session_id, [...(machines.get(x.session_id) ?? []), x.machine_id]);
  }
  for (const table of SESSION_TABLES) if (!USAGE_ROWS.has(table)) n += Number(db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(arg).changes);
  // The simulator's turns were never billed: its usage goes with it.
  if (demo.length) {
    const [demoWhere, demoArg] = ofSessions(demo);
    for (const table of USAGE_ROWS) n += Number(db.prepare(`DELETE FROM ${table} WHERE ${demoWhere}`).run(demoArg).changes);
  }
  if (demo.length < list.length) keepUsageOf(db, list.filter((id) => !DEMO_SESSION.test(id)));
  db.prepare(`DELETE FROM ingest_state WHERE ${where}`).run(arg);
  // When the purge was written, after every purge before it: the usage pull sends purges from where its last pull ended,
  // and a time taken when a catch-up began could fall before one written meanwhile.
  const purgedAt = Math.max(Date.now(), ((db.prepare('SELECT max(purged_ms) AS t FROM tombstones').get() as { t: number | null }).t ?? 0) + 1);
  const tombstone = db.prepare(upsertSql('tombstones', ['machine_id', 'session_id'], ['machine_id', 'session_id', 'deleted_ms', 'source', 'purged_ms']));
  let compact = false;
  for (const id of list) {
    for (const m of machines.get(id) ?? [machineHostTag()]) {
      tombstone.run(m, id, now, source, purgedAt);
      // This machine's log forgets it too: a purge record now, and its rows out of the log at the next compaction, which
      // this one asks for (compactRecords). The simulator's sessions are in no segment or base, so there is nothing to ask.
      if (pub?.owns(m) && !DEMO_SESSION.test(id)) {
        pub.purge(m, id);
        compact = true;
      }
    }
  }
  if (compact) setMeta(db, 'records_compact', '1');
  return n;
}

/** The usage tables a session's rows are in. */
const USAGE_ROWS: ReadonlySet<string> = new Set(['usage_messages', 'usage_spend']);

/** A session deleted on purpose leaves the account's usage as it was: the account was billed for its turns, and the
 *  status line's estimate calibrates on all of them. Its usage stays, without the session (`machine`: only that
 *  machine's rows). A spend report kept at the very time of another such report is dropped. */
function keepUsageOf(db: DatabaseSync, ids: string | readonly string[], machine?: string): void {
  const [of, arg] = ofSessions(typeof ids === 'string' ? [ids] : ids);
  const where = machine === undefined ? of : `machine_id = ? AND ${of}`;
  const args = machine === undefined ? [arg] : [machine, arg];
  db.prepare(`UPDATE usage_messages SET session_id = '' WHERE ${where}`).run(...args);
  db.prepare(`UPDATE OR IGNORE usage_spend SET session_id = '' WHERE ${where}`).run(...args);
  db.prepare(`DELETE FROM usage_spend WHERE ${where}`).run(...args);
}

/** A deliberate delete (`oak sessions --delete`, made here; the demo's cleanup and `oak uninstall --purge-store`, of the
 *  sessions they remove): the sessions forgotten in the index at once, their full-text entries with them, and in this
 *  machine's record log, in one transaction. */
export function forgetSession(db: DatabaseSync, ids: string | readonly string[], source: string): void {
  const r = newRun(db, { now: Date.now(), deadline: Infinity, problems: [] });
  try {
    begin(r);
    purgeSession(db, ids, source, r.now, r.pub);
    commit(r);
  } catch (e) {
    rollback(r);
    throw e;
  }
}

/** The sessions deleted on purpose: here (`oak sessions --delete`) or, by oak sync's tombstones, on another machine. One
 *  put back here since the last run (`--undelete`: that run saw it deleted, and it is no longer) is no delete, though
 *  the tombstones say so until the next run records the undelete, which outranks them: it is listed again at once, as
 *  the files list it. */
function deliberateDeletes(hidden: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of hidden) out.set(id, 'deleted here');
  const last = new Map<string, { deleted: boolean; host: string }>();
  for (const t of readTombstones()) if (t.kind === 'session') last.set(t.key, { deleted: t.deleted, host: t.host });
  const seen = new Set(readSeen().hidden);
  for (const [id, t] of last) if (t.deleted && !out.has(id) && !seen.has(id)) out.set(id, `deleted on ${t.host}`);
  return out;
}

/** Why a session whose files are all gone went: OAK's own cleanup said so before it removed them; else Claude Code's
 *  retention sweep, when the session was older than the period it keeps; else something else removed them. */
function archiveReason(hint: string | null, lastActiveMs: number, now: number, retentionDays: number): 'cleaned' | 'retention' | 'missing' {
  if (hint === 'cleaned') return 'cleaned';
  return now - lastActiveMs > retentionDays * 86_400_000 ? 'retention' : 'missing';
}

// --- the catch-up ---------------------------------------------------------------------------------------------------

export interface CatchUpOptions {
  /** Stop after about this long and leave the rest for the next catch-up (Infinity: all of it). */
  budgetMs?: number;
  /** Do nothing, and answer not caught up, when more than this many transcript bytes would be read: a first build that
   *  large is a background job (`oak __index-build`), never a reader's wait. */
  inlineBytes?: number;
  /** Only these sessions (a cleanup catches up what it is about to remove). */
  only?: Set<string>;
  /** Re-read a session's tool calls and workers at most this often while its transcript keeps changing. Each read
   *  parses the whole transcript (a session with no OAK store keeps no parse cache), which made every listing of a
   *  growing 164 MB session take 1.3 s more; the listings do not read those rows, so they pass this. */
  workRefreshMs?: number;
  now?: number;
  /** Test seams: called after each session's work is committed, and after each batch of a transcript is folded (its
   *  transaction may still be open). */
  afterUnit?: (session: string) => void;
  afterBatch?: () => void;
}

export interface CatchUpResult {
  /** Everything on disk is in the index. */
  caughtUp: boolean;
  /** This call held the lease and worked (false: another process is catching up). */
  ran: boolean;
  /** Sessions brought up to date, and sessions left for later. */
  updated: number;
  left: number;
  archived: number;
  purged: number;
  /** Transcript bytes the work would have read, when it was left to a background build. */
  deferredBytes?: number;
  /** When a permission prompt this pass left unpublished in its wait becomes due (ingestAttention): a later pass then
   *  publishes it. */
  handsDueAt?: number;
  /** Each prompt left so: its session and the hand's `ts` (notify.ts handStillUp says whether it is still up). */
  handsDue?: { id: string; ts: number }[];
  ms: number;
  problems: string[];
}

interface Work {
  s: SessionSources;
  stamp: string;
  facts: boolean;
  /** It was archived and its files are here again: every unit is derived again, even where its stamp is unchanged (the
   *  archive cleared its edits, marked its blobs gone and dropped its raised hand). */
  revive: boolean;
  /** The transcript bytes it will read: what a first build is estimated by. */
  bytes: number;
  stored: { machine: string; inputs: string } | null;
}

/** The stamp of a session's worker transcripts as activeWorkers lists them (`subagents/agent-*.jsonl`), or `none` when
 *  there is no such folder. */
function workerFilesStamp(dir: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 'none';
  }
  const h = createHash('sha256');
  for (const n of names.sort()) if (n.startsWith('agent-') && n.endsWith('.jsonl')) h.update(`${n}\u0001${stampOf(stat(path.join(dir, n)))}\u0000`);
  return h.digest('hex').slice(0, 24);
}

/** The stamps a session's other units were last brought up to date at: only the units that apply to it (a transcript's
 *  work or else its hooks' asks; the store's units where it has a store, else only the log, whose records it keeps as
 *  cleared once; the usage of every transcript and rollout it has). */
function unitStamps(s: SessionSources, transcript: string | null, now: number): Record<string, string> {
  const f = s.files;
  const out: Record<string, string> = { log: `${stampOf(f['log.jsonl'] ?? null)}|${stampOf(f['capture-skips'] ?? null)}` };
  if (s.store) {
    out.blobs = stampOf(f['blobs'] ?? null);
    out.waits = stampOf(f['attention-log.jsonl'] ?? null);
    out.comments = stampOf(f['comments'] ?? null);
  }
  // What the listing reads of a session right now, for every session: a store that went takes its hand and tab with it.
  // The transcript too, whose unanswered question names the hand (ingestAttention).
  out.attention = `${stampOf(f['attention.json'] ?? null)}|${stampOf(s.tab)}`;
  const recent = now - s.newest <= WORK_WINDOW_MS;
  if (!transcript) out.hooks = `${stampOf(f['capture-events.jsonl'] ?? null)}|${stampOf(f['log.jsonl'] ?? null)}`;
  else {
    // A worker's transcript changes while its parent's may not; a session written within a day has each one read.
    const side = path.join(path.dirname(transcript), s.id);
    const known = s.transcripts.find((x) => x.t.file === transcript);
    const sideSt = known ? s.sides.get(transcript) ?? null : stat(side);
    const tst = stampOf(known ? known.st : stat(transcript));
    out.attention += `|${tst}`;
    const h = createHash('sha256').update(tst).update(stampOf(sideSt));
    if (recent && (!known || s.sides.has(transcript))) {
      const files: { file: string; st: fs.Stats }[] = [];
      walkFiles(side, 3, (n) => n.endsWith('.jsonl') || n.endsWith('.json'), files);
      for (const x of files) h.update(`${x.file}\u0001${stampOf(x.st)}`);
    }
    out.work = h.digest('hex').slice(0, 24);
    // The workers the listing asks (activeWorkers): every agent transcript in its folder, whatever the session's age.
    out.workers = sideSt ? workerFilesStamp(path.join(side, 'subagents')) : '-';
  }
  if (s.transcripts.length || s.rollouts.length) {
    // Usage: every transcript of the session with its workers' (read again while the session ran within a day), and
    // every rollout.
    const u = createHash('sha256');
    for (const t of s.transcripts) {
      u.update(`\u0000${t.t.file}\u0001${stampOf(t.st)}\u0001${stampOf(s.sides.get(t.t.file) ?? null)}`);
      if (recent && s.sides.has(t.t.file)) {
        const files: { file: string; st: fs.Stats }[] = [];
        walkFiles(path.join(path.dirname(t.t.file), s.id, 'subagents'), 3, (n) => n.endsWith('.jsonl'), files);
        for (const x of files) u.update(`${x.file}\u0001${stampOf(x.st)}`);
      }
    }
    for (const x of s.rollouts) u.update(`\u0000${x.file}\u0001${stampOf(x.st)}`);
    out.usage = u.digest('hex').slice(0, 24);
  }
  return out;
}

/** The sessions the index could not bring up to date (meta `failed_sessions`), each with why, for `oak doctor`: the index
 *  says it is not caught up while any is listed. */
export interface FailedSession {
  id: string;
  problem: string;
  at: number;
}

/** Keep the failures of this catch-up, and forget those of sessions it brought up to date since, or whose files are gone
 *  (`present`: the sessions on disk, when the catch-up looked at all of them). */
function recordFailures(db: DatabaseSync, failed: Map<string, string>, done: Set<string>, present: Set<string> | null, now: number): void {
  let list: FailedSession[] = [];
  try {
    list = JSON.parse(getMeta(db, 'failed_sessions') ?? '[]') as FailedSession[];
  } catch {
    list = [];
  }
  const next = list.filter((x) => !done.has(x.id) && !failed.has(x.id) && (!present || present.has(x.id)));
  for (const [id, problem] of failed) next.push({ id, problem: graphemeHead(problem, 500), at: now });
  if (next.length === list.length && next.every((x, i) => x.id === list[i].id && x.problem === list[i].problem)) return;
  write(db, () => setMeta(db, 'failed_sessions', JSON.stringify(next.slice(-50))));
}

/** The sessions the index last failed to bring up to date (recordFailures). */
export function failedSessions(db: DatabaseSync): FailedSession[] {
  try {
    const v = JSON.parse(getMeta(db, 'failed_sessions') ?? '[]');
    return Array.isArray(v) ? (v as FailedSession[]) : [];
  } catch {
    return [];
  }
}

/** What the status line cache holds that ingestUsageMachine reads: the cache itself is written on every render (its
 *  own time first), these change once per reply at most. */
const USAGE_CACHE_KEYS = ['five_pct', 'five_at', 'five_reset', 'five_tok', 'five_total', 'five_reads', 'week_pct', 'week_at', 'week_reset', 'week_tok',
  'week_total', 'week_reads', 'fable_pct', 'fable_at', 'fable_reset', 'fable_label', 'fable_tok', 'fable_tok_total', 'fable_reads', 'api_ts', 'month_tok',
  'month_reset', 'month_meas_start', 'month_tok_total', 'month_reads', 'month_cost', 'month_cost_total', 'meas_at', 'costs', 'five_none_at', 'five_seen_at'];

/** The stamp of what the machine's usage readings come from (ingestUsageMachine): the status line cache's fields it
 *  reads (the cache's own time when it records no measurement time of the month), the Codex usage cache, and the hour
 *  (the accounts are seen again hourly). */
function usageMachineStamp(now: number): string {
  const file = path.join(claudeConfigDir(), 'statusline-last.json');
  let fields = '-';
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    // The spend ledger by each session's spend alone: its report time moves at every render.
    const costs = c.costs && typeof c.costs === 'object' ? Object.entries(c.costs as Record<string, { usd?: unknown }>).map(([k, v]) => [k, v?.usd ?? null]) : null;
    fields = JSON.stringify(USAGE_CACHE_KEYS.map((k) => (k === 'costs' ? costs : c[k] ?? null))) + (c.meas_at === undefined ? stampOf(stat(file)) : '');
  } catch {
    /* none, or one being written: '-' */
  }
  let codex = '-';
  try {
    codex = fs.readFileSync(path.join(claudeConfigDir(), 'codex-account-usage.json'), 'utf8');
  } catch {
    /* no Codex quota pulled here */
  }
  return createHash('sha256').update(`${JSON.stringify((require('../account-billing') as typeof import('../account-billing')).localBillDays())}\u0000${fields}\u0000${codex}\u0000${Math.floor(now / 3_600_000)}`).digest('hex').slice(0, 32);
}

/**
 * Bring the index up to date with the files on disk, newest sessions first, and with the record logs: other machines'
 * rows, and this machine's own where the index lacks them. Holds the catch-up lease while it works; when another live
 * process holds it, returns at once with `ran: false` and `caughtUp: false`. A catch-up of everything that finds nothing
 * to do (`nothingToDo`) answers caught up without the lease and writes nothing, so `PRAGMA data_version` moves only when
 * a catch-up changed the index.
 */
export function catchUp(db: DatabaseSync, opts: CatchUpOptions = {}): CatchUpResult {
  const t0 = Date.now();
  const now = opts.now ?? t0;
  const result: CatchUpResult = { caughtUp: false, ran: false, updated: 0, left: 0, archived: 0, purged: 0, ms: 0, problems: [] };
  let found: Discovery | null = null;
  let seen = -1;
  keepOwnFoldersFromOldClean();
  // oak sync's settings, written back to prefs.json where an older OAK dropped them (sync-state.ts keptPrefs).
  if (!opts.only) keptPrefs(true);
  // Not while another process catches up: it may be part way through rows it writes in more than one transaction (a
  // base's reset), which a reader must not take for whole.
  if (!opts.only && !leaseHolder(db)) {
    try {
      seen = dataVersion(db);
      found = discover(db);
      if (nothingToDo(db, found, now, opts.workRefreshMs) && dataVersion(db) === seen && !leaseHolder(db)) {
        result.caughtUp = true;
        result.ran = true;
        result.ms = Date.now() - t0;
        return result;
      }
    } catch {
      found = null; // the catch-up below looks again, and says what went wrong
    }
  }
  if (!tryLease(db, now)) {
    result.ms = Date.now() - t0;
    return result;
  }
  result.ran = true;
  const r = newRun(db, { now, deadline: t0 + (opts.budgetMs ?? Infinity), problems: result.problems, afterBatch: opts.afterBatch });
  // Sessions that failed (any unit: the index is then behind the files), and those brought wholly up to date.
  const failed = new Map<string, string>();
  const done = new Set<string>();
  try {
    // Another process that caught up between that look and the lease may have indexed what it did not see (a session
    // begun meanwhile), which it would take for gone: looked at again.
    const d = found && dataVersion(db) === seen ? found : discover(db, opts.only);
    write(db, () => {
      db.prepare(upsertSql('machines', ['machine_id'], ['machine_id', 'label', 'is_self', 'home', 'platform', 'last_seen_ms']))
        .run(r.me, 'this machine', 1, os.homedir(), process.platform, now);
    });
    // Deliberate deletes first, so nothing deleted is derived again.
    const deletes = deliberateDeletes(d.hidden);
    const purged: string[] = [];
    begin(r);
    const indexed = new Set((db.prepare('SELECT DISTINCT session_id FROM sessions').all() as { session_id: string }[]).map((x) => x.session_id));
    for (const [id, why] of deletes) {
      if (opts.only && !opts.only.has(id)) continue;
      if (!indexed.has(id)) continue;
      purgeSession(db, id, why, now, r.pub);
      purged.push(id);
      result.purged++;
    }
    // A session put back (`oak sessions --undelete`) is no longer one to forget.
    for (const row of db.prepare('SELECT session_id FROM tombstones').all() as { session_id: string }[]) {
      if (!deletes.has(row.session_id)) db.prepare('DELETE FROM tombstones WHERE session_id = ?').run(row.session_id);
    }
    commit(r);
    if (purged.length) {
      forgetInLog(db);
      forgetElsewhere(purged);
    }
    // The record logs: every other machine's rows, and this machine's own where the index lacks them. A reader leaves a
    // first read of logs this large to the background build, as it leaves a first build of the files.
    const logBytes = opts.only ? 0 : unreadLogBytes(db);
    if (opts.inlineBytes !== undefined && logBytes > opts.inlineBytes) {
      result.left = 1;
      result.deferredBytes = logBytes;
      return result;
    }
    if (!opts.only) for (const host of r.pub.self) if (partialLogLost(db, host)) {
      write(db, () => {
        const st = logState(db, host)!;
        delete st.partial;
        setLogState(db, host, st);
        setMeta(db, 'records_compact', '1');
      });
    }
    // An index that holds this machine's rows from before it kept a record log (or whose log is gone) publishes them whole,
    // by a compaction at the end of this catch-up: otherwise a new index file would lose what only this one holds. So does
    // one that published a segment no longer here (ownLogLost), whatever was appended since.
    if (!opts.only && ((![...r.pub.self].some((h) => segments(h).length) && db.prepare('SELECT 1 FROM sessions WHERE machine_id = ? LIMIT 1').get(r.me)) || ownLogLost(db, r.pub.self))) {
      write(db, () => setMeta(db, 'records_compact', '1'));
    }
    if (!opts.only && !applyRecordLogs(r)) result.left++;
    // What another machine's log forgot is forgotten here as a delete here forgets it: in every index file in the folder,
    // full-text entries with the rows, and out of the write-ahead log.
    if (r.forgotten.size) {
      forgetInLog(db);
      for (const [host, ids] of r.forgotten) if (ids.size) forgetElsewhere([...ids], undefined, host);
      r.forgotten.clear();
    }
    // A session deleted on purpose that a log brought back is forgotten again, as above. A base covers only the history its
    // machine read (records.ts), so the log a machine set up again kept before is read with its new one, and can hold a
    // session deleted there since; so can another machine's log that has not heard of a delete made here.
    if (!opts.only && deletes.size) {
      const [where, arg] = ofSessions([...deletes.keys()]);
      const back = (db.prepare(`SELECT DISTINCT session_id FROM sessions WHERE ${where}`).all(arg) as { session_id: string }[]).map((x) => x.session_id);
      if (back.length) {
        begin(r);
        for (const id of back) purgeSession(db, id, deletes.get(id)!, now, r.pub);
        commit(r);
        forgetInLog(db);
        forgetElsewhere(back);
        result.purged += back.filter((id) => !purged.includes(id)).length;
      }
    }
    // What the last catch-up recorded of each session: its stamp, and the two things its facts name that the next stamp
    // covers (read from their own columns: parsing every session's facts on every read cost more than the rest).
    const stored = new Map<string, { machine: string; inputs: string; transcript: string | null; titleInputs: string[]; archived: boolean }>();
    for (const row of db.prepare("SELECT machine_id, session_id, inputs, facts_transcript, title_inputs, archived_ms FROM sessions WHERE origin IN ('local', 'pulled')").all() as { machine_id: string; session_id: string; inputs: string; facts_transcript: string | null; title_inputs: string | null; archived_ms: number | null }[]) {
      let titleInputs: string[] = [];
      try {
        titleInputs = row.title_inputs ? (JSON.parse(row.title_inputs) as string[]) : [];
      } catch {
        titleInputs = [];
      }
      stored.set(row.session_id, { machine: row.machine_id, inputs: row.inputs, transcript: row.facts_transcript, titleInputs, archived: row.archived_ms !== null });
    }
    const states = new Map<string, string | null>();
    const statesAt = new Map<string, number>();
    for (const row of db.prepare("SELECT source, state, updated_ms FROM ingest_state WHERE kind IN ('unit', 'copy')").all() as { source: string; state: string | null; updated_ms: number }[]) {
      states.set(row.source, row.state);
      statesAt.set(row.source, row.updated_ms);
    }
    const cursorOf = db.prepare('SELECT cursor FROM ingest_state WHERE source = ?');
    const work: Work[] = [];
    let bytes = 0;
    for (const s of d.sessions.values()) {
      if (deletes.has(s.id)) continue;
      if (opts.only && !opts.only.has(s.id)) continue;
      const prev = stored.get(s.id);
      const stamp = factsStamp(s, d.codexIndex, prev?.titleInputs);
      // A copy of another machine's session, as it was (keepCopy).
      if (!prev && states.get(`copy:${s.id}`) === stamp) continue;
      const revive = prev?.archived === true;
      const facts = !prev || prev.inputs !== stamp || revive;
      const transcript = facts ? (s.transcripts[0]?.t.file ?? null) : prev?.transcript ?? null;
      const stamps = unitStamps(s, transcript, now);
      const machine = prev?.machine ?? r.me;
      const stale = Object.entries(stamps).some(([k, v]) => states.get(`unit:${k}:${machine}:${s.id}`) !== v);
      if (!facts && !stale) continue;
      let need = 0;
      if (transcript) {
        const st = s.transcripts.find((x) => x.t.file === transcript)?.st;
        const done = (cursorOf.get(`prompts:${machine}:${s.id}`) as { cursor: number } | undefined)?.cursor ?? 0;
        need = Math.max(0, (st?.size ?? 0) - done);
      }
      // The usage of every transcript is read from its own cursor.
      if (states.get(`unit:usage:${machine}:${s.id}`) !== stamps.usage) {
        for (const t of s.transcripts) need += Math.max(0, t.st.size - ((cursorOf.get(`usage:${t.t.file}`) as { cursor: number } | undefined)?.cursor ?? 0));
      }
      bytes += need;
      work.push({ s, stamp, facts, revive, bytes: need, stored: prev ? { machine: prev.machine, inputs: prev.inputs } : null });
    }
    if (opts.inlineBytes !== undefined && bytes > opts.inlineBytes) {
      result.left = work.length || 1;
      result.deferredBytes = bytes;
      return result;
    }
    work.sort((a, b) => b.s.newest - a.s.newest || (a.s.id < b.s.id ? -1 : 1));
    const unitDone = db.prepare(upsertSql('ingest_state', ['source'], ['source', 'kind', 'machine_id', 'session_id', 'state', 'updated_ms']));
    const codexIndex = d.codexIndex;
    for (let i = 0; i < work.length; i++) {
      const w = work[i];
      // Out of time, or OAK's cleanup has asked for the lease (it records the sessions it removes first): the rest
      // waits for the next catch-up.
      if (Date.now() > r.deadline || (!opts.only && leaseWanted(db))) {
        result.left += work.length - i;
        break;
      }
      let machine = w.stored?.machine ?? r.me;
      try {
        let f: SessionListingFacts | null = null;
        if (!w.facts) {
          // Unchanged facts, while another unit of the session changed: its facts as recorded.
          const row = db.prepare('SELECT facts FROM sessions WHERE machine_id = ? AND session_id = ?').get(machine, w.s.id) as { facts: string | null } | undefined;
          try {
            f = row?.facts ? (JSON.parse(row.facts) as SessionListingFacts) : null;
          } catch {
            f = null;
          }
        }
        if (w.facts) {
          const wrote = writeSession(r, w.s, codexIndex, w.stored?.machine ?? null);
          if (wrote.copy) {
            keepCopy(r, w.s.id, wrote.machine, w.stamp, w.stored?.machine ?? null);
            commit(r);
            done.add(w.s.id);
            continue;
          }
          ({ machine, facts: f } = wrote);
          markWaiting(r, machine, w.s.id);
          commit(r);
        }
        const stamps = unitStamps(w.s, f?.transcript ?? null, now);
        const unitOk = (k: string): void => {
          begin(r);
          unitDone.run(`unit:${k}:${machine}:${w.s.id}`, 'unit', machine, w.s.id, stamps[k], now);
          count(r);
          commit(r);
          keepLease(r);
        };
        const due = (k: string): boolean => k in stamps && (w.revive || states.get(`unit:${k}:${machine}:${w.s.id}`) !== stamps[k]);
        if (f?.transcript) {
          if (due('work') || w.facts) {
            ingestPrompts(r, machine, w.s.id, f.transcript);
            commit(r);
          }
          // Its tool calls and workers: at most every `workRefreshMs` when the caller set one, else whenever they changed.
          // Left due, a later catch-up reads them.
          const readRecently = opts.workRefreshMs !== undefined && !w.revive && now - (statesAt.get(`unit:work:${machine}:${w.s.id}`) ?? -Infinity) < opts.workRefreshMs;
          if (due('work') && !readRecently) {
            ingestWork(r, machine, w.s.id, f);
            commit(r);
            unitOk('work');
          }
        } else if (due('hooks')) {
          ingestHookPrompts(r, machine, w.s.id);
          commit(r);
          unitOk('hooks');
        }
        if (due('usage')) { ingestUsage(r, machine, w.s); commit(r); unitOk('usage'); }
        if (w.s.store) {
          if (due('log')) { ingestLog(r, machine, w.s.id, f); commit(r); unitOk('log'); }
          if (due('blobs')) { ingestBlobs(r, machine, w.s.id); commit(r); unitOk('blobs'); }
          if (due('waits')) { ingestWaits(r, machine, w.s.id); commit(r); unitOk('waits'); }
          if (due('comments')) { ingestComments(r, machine, w.s.id, !!w.s.files['comments']); commit(r); unitOk('comments'); }
        } else if (due('log')) {
          // The store went (cleaned): its records stay, marked cleared.
          ingestLog(r, machine, w.s.id, f);
          commit(r);
          unitOk('log');
        }
        if (due('attention')) {
          // A permission prompt still inside its wait is published on a later pass (the unit stays due, marked deferred).
          const deferred = states.get(`unit:attention:${machine}:${w.s.id}`)?.startsWith(DEFERRED) ?? false;
          const settled = ingestAttention(r, machine, w.s.id, f?.transcript ?? null, deferred);
          commit(r);
          if (settled) unitOk('attention');
          else {
            begin(r);
            unitDone.run(`unit:attention:${machine}:${w.s.id}`, 'unit', machine, w.s.id, `${DEFERRED}${stamps.attention}`, now);
            commit(r);
          }
        }
        if (due('workers')) { ingestWorkers(r, machine, w.s.id, f?.transcript ?? null, stamps.workers); commit(r); unitOk('workers'); }
        publishSession(r, machine, w.s.id, !!opts.only);
        commit(r);
        result.updated++;
        done.add(w.s.id);
        opts.afterUnit?.(w.s.id);
      } catch (e) {
        rollback(r);
        const msg = String((e as Error)?.message || e);
        failed.set(w.s.id, msg);
        result.problems.push(`${w.s.id}: ${msg}`);
      }
    }
    if (!opts.only) {
      // The usage of the sessions deleted here before this index knew them, read again as their files change.
      for (const s of deletedUnknown(db, d)) {
        const stamp = unitStamps(s, null, now).usage;
        if (states.get(`unit:deleted-usage:${r.me}:${s.id}`) === stamp) continue;
        if (Date.now() > r.deadline) {
          result.left++;
          break;
        }
        try {
          ingestUsage(r, r.me, s, true);
          begin(r);
          unitDone.run(`unit:deleted-usage:${r.me}:${s.id}`, 'unit', r.me, s.id, stamp, now);
          commit(r);
        } catch (e) {
          rollback(r);
          result.problems.push(`usage of ${s.id} (deleted): ${String((e as Error)?.message || e)}`);
        }
      }
      // This machine's usage readings, spend and accounts, from its caches.
      const usageStamp = usageMachineStamp(now);
      if (states.get(`unit:usage-machine:${r.me}`) !== usageStamp) {
        try {
          r.account ??= claudeAccountTag();
          ingestUsageMachine(r, r.account);
          begin(r);
          unitDone.run(`unit:usage-machine:${r.me}`, 'unit', r.me, null, usageStamp, now);
          commit(r);
        } catch (e) {
          rollback(r);
          result.problems.push(`usage readings: ${String((e as Error)?.message || e)}`);
        }
      }
      // Sessions whose files are all gone: archived, never removed.
      const retention = readCleanupPeriodDays() ?? CLAUDE_DEFAULT_RETENTION_DAYS;
      begin(r);
      // This machine's sessions and the copies oak sync pulled here (the latter filed under the machine they came from).
      const gone = db.prepare('UPDATE sessions SET archived_ms = ?, archived_reason = ? WHERE machine_id = ? AND session_id = ?');
      const removed: string[] = [];
      for (const row of db.prepare("SELECT machine_id, session_id, origin, last_active_ms, archive_hint FROM sessions WHERE origin IN ('local', 'pulled') AND archived_ms IS NULL").all() as { machine_id: string; session_id: string; origin: string; last_active_ms: number; archive_hint: string | null }[]) {
        if (d.sessions.has(row.session_id)) continue;
        // The simulator's session, removed (`oak demo --clean`, from a surface whose Node had no index to tell): forgotten,
        // as its cleanup forgets it where it can, never archived.
        if (DEMO_SESSION.test(row.session_id)) {
          purgeSession(db, row.session_id, 'demo removed', now, r.pub);
          removed.push(row.session_id);
          continue;
        }
        const why = archiveReason(row.archive_hint, row.last_active_ms, now, retention);
        // Another machine's session whose copy here went before Claude Code's retention here would have swept it (an
        // on-demand copy evicted, one removed by hand), of which this machine kept no store (it was never resumed here,
        // keepEarlierGeneration): that machine's again, as its records describe it, never archived here; its records of
        // the conversation, passed over while the copy was here, are taken again.
        if (row.origin === 'pulled' && why !== 'retention' && getState(r, `gen:${row.machine_id}:${row.session_id}`) === undefined) {
          db.prepare("UPDATE sessions SET origin = 'synced', listed = 0, synced_ms = ? WHERE machine_id = ? AND session_id = ?").run(now, row.machine_id, row.session_id);
          db.prepare('DELETE FROM attention WHERE machine_id = ? AND session_id = ? AND synced_ms IS NULL').run(row.machine_id, row.session_id);
          continue;
        }
        gone.run(now, why, row.machine_id, row.session_id);
        // Its edits went with its store, and its snapshots: in this machine's record log too, from which the other machines
        // and a new index file here read them (unpublished, they read the edits as pending and the snapshots as held).
        const cleared = db.prepare('SELECT id FROM edits WHERE machine_id = ? AND session_id = ? AND cleared_ms IS NULL').all(row.machine_id, row.session_id) as { id: number }[];
        db.prepare('UPDATE edits SET cleared_ms = ? WHERE machine_id = ? AND session_id = ? AND cleared_ms IS NULL').run(now, row.machine_id, row.session_id);
        for (const e of cleared) pubStored(r, 'edits', row.machine_id, { session_id: row.session_id, id: e.id });
        const held = db.prepare('SELECT sha FROM blobs WHERE machine_id = ? AND session_id = ? AND present = 1').all(row.machine_id, row.session_id) as { sha: string }[];
        db.prepare('UPDATE blobs SET present = 0 WHERE machine_id = ? AND session_id = ?').run(row.machine_id, row.session_id);
        for (const b of held) pubStored(r, 'blobs', row.machine_id, { session_id: row.session_id, sha: b.sha });
        // The hand it held here comes down (another machine's, which its records brought, is that machine's to lower).
        if (db.prepare('DELETE FROM attention WHERE machine_id = ? AND session_id = ? AND synced_ms IS NULL').run(row.machine_id, row.session_id).changes) {
          r.pub.delete(row.machine_id, 'attention', { session_id: row.session_id });
        }
        publishSession(r, row.machine_id, row.session_id, true);
        result.archived++;
      }
      // The simulator's sessions an earlier build kept: those its cleanup archived, other machines' that its catch-up read
      // from their logs, and the copies of their stores oak sync brought here. Forgotten as well, and this machine's log is
      // compacted once, so that no base it wrote keeps them. Once in each index: no build since archives them, and nothing
      // files them again (applyRecord, discover). Only an index a 0.11.0 development build wrote holds them: this, its meta
      // key and nothingToDo's check of it can go once no machine runs one.
      if (getMeta(db, 'demo_archive_swept') !== '1') {
        for (const row of db.prepare('SELECT DISTINCT session_id FROM sessions WHERE session_id GLOB ?').all(DEMO_GLOB) as { session_id: string }[]) {
          if (!DEMO_SESSION.test(row.session_id) || d.sessions.has(row.session_id)) continue;
          purgeSession(db, row.session_id, 'demo removed', now, r.pub);
          setMeta(db, 'records_compact', '1');
          removed.push(row.session_id);
        }
        setMeta(db, 'demo_archive_swept', '1');
      }
      // A copy of another machine's session whose files are gone (oak sync evicted it): nothing is left to pass over.
      for (const source of states.keys()) if (source.startsWith('copy:') && !d.sessions.has(source.slice(5))) db.prepare('DELETE FROM ingest_state WHERE source = ?').run(source);
      commit(r);
      if (removed.length) {
        forgetInLog(db);
        forgetElsewhere(removed);
      }
      ingestNotes(r, d.notes);
      commit(r);
      ingestDelegated(r, d.delegated);
      commit(r);
      for (const rep of d.replicas) {
        if (deletes.has(rep.session)) continue;
        try {
          ingestReplica(r, rep);
          commit(r);
        } catch (e) {
          rollback(r);
          result.problems.push(`replica ${rep.origin}/${rep.session}: ${String((e as Error)?.message || e)}`);
        }
      }
      noteSavedLabels(r);
    }
    // What waited to be published (publishSession) and has waited long enough; a cleanup publishes its sessions' now.
    publishWaiting(r, opts.only);
    if (!opts.only) {
      compactRecords(r, result.left === 0 && !failed.size);
      pruneUsageHistory(r);
      write(db, () => repriceUsage(db));
      if (result.left === 0 && !failed.size) {
        write(db, () => {
          setMeta(db, 'caught_up_ms', String(now));
          if (!getMeta(db, 'first_build_ms')) setMeta(db, 'first_build_ms', String(Date.now()));
        });
      }
    }
    recordFailures(db, failed, done, opts.only ? null : new Set(d.sessions.keys()), now);
    // Caught up only when nothing was left and no session failed: a session that cannot be read is said, never passed over.
    result.caughtUp = result.left === 0 && failed.size === 0 && !failedSessions(db).some((x) => !opts.only || opts.only.has(x.id));
    if (!opts.only && result.caughtUp) publishPendingPaths(db, now);
    if (r.handsDueAt !== undefined) result.handsDueAt = r.handsDueAt;
    if (r.handsDue) result.handsDue = r.handsDue;
  } catch (e) {
    rollback(r);
    result.problems.push(String((e as Error)?.message || e));
  } finally {
    releaseLease(db);
    result.ms = Date.now() - t0;
  }
  return result;
}

/** How long a catch-up that finds nothing to do may go without one that records it ran (`caught_up_ms`, the machine's
 *  own row): what asks how lately the index was whole (`indexedAt`, and `oak usage`'s totals, which start a background
 *  catch-up once that is USAGE_SWEEP_MS old, so this stays below it) sees no older a time while anything reads it. */
export const QUIET_MS = 30_000;

/**
 * Whether a catch-up of everything would change nothing, asked read-only of each of its steps in turn (catchUp): the last
 * one that ran is recent and failed nothing; no deliberate delete, record log, session, usage reading, archive, note,
 * replica, publication, compaction or pruning is due. A session's tool calls and workers read within `workRefreshMs` are
 * current, as the catch-up it stands for would leave them. Any doubt is work, done under the lease.
 */
function nothingToDo(db: DatabaseSync, d: Discovery, now: number, workRefreshMs?: number): boolean {
  const at = Number(getMeta(db, 'caught_up_ms') ?? 0);
  if (!at || now < at || now - at >= QUIET_MS || !getMeta(db, 'first_build_ms') || failedSessions(db).length) return false;
  if (now - Number(getMeta(db, 'usage_pruned_ms') ?? 0) >= 86_400_000) return false;
  if (getMeta(db, 'usage_priced') !== PRICE_VERSION) return false;
  // The demo an earlier build archived is looked for once in each index, by the first full catch-up (catchUp).
  if (getMeta(db, 'demo_archive_swept') !== '1') return false;
  const me = machineHostTag();
  if (!db.prepare('SELECT 1 FROM machines WHERE machine_id = ? AND is_self = 1').get(me)) return false;
  const self = new Set((db.prepare('SELECT machine_id FROM machines WHERE is_self = 1').all() as { machine_id: string }[]).map((m) => m.machine_id));
  // Deliberate deletes, and sessions put back.
  const deletes = deliberateDeletes(d.hidden);
  const holds = db.prepare('SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1');
  for (const id of deletes.keys()) if (holds.get(id)) return false;
  for (const row of db.prepare('SELECT session_id FROM tombstones').all() as { session_id: string }[]) if (!deletes.has(row.session_id)) return false;
  // The record logs, and a machine that the index has no row for yet.
  const named = db.prepare('SELECT 1 FROM machines WHERE machine_id = ?');
  for (const host of recordHosts()) {
    const st = logState(db, host);
    const plan = logPlan(host, st);
    if (plan.reset || plan.steps.length) return false;
    // A read that stopped on the log's last record: read whole, which the catch-up records.
    if (st?.partial && readWhole(host, st)) return false;
    if (!self.has(host) && !named.get(host) && wholeBase(segments(host))) return false;
  }
  if (![...self].some((h) => segments(h).length) && db.prepare('SELECT 1 FROM sessions WHERE machine_id = ? LIMIT 1').get(me)) return false;
  if (ownLogLost(db, new Set([...self, me]))) return false;
  if ([...self].some((host) => partialLogLost(db, host))) return false;
  // A compaction asked for (a delete) is work, unless each log of this machine's it would compact waits to be read whole
  // first (compactionWaits).
  if (getMeta(db, 'records_compact') === '1') {
    const logs = [...self].filter((h) => logBytes(h).total > 0);
    if (!logs.length || !logs.every((h) => compactionWaits(db, h))) return false;
  }
  // Every session's facts and units, as the catch-up stamps them.
  const stored = new Map<string, { machine: string; inputs: string; transcript: string | null; titleInputs: string[]; archived: boolean }>();
  for (const row of db.prepare("SELECT machine_id, session_id, inputs, facts_transcript, title_inputs, archived_ms FROM sessions WHERE origin IN ('local', 'pulled')").all() as { machine_id: string; session_id: string; inputs: string; facts_transcript: string | null; title_inputs: string | null; archived_ms: number | null }[]) {
    let titleInputs: string[] = [];
    try {
      titleInputs = row.title_inputs ? (JSON.parse(row.title_inputs) as string[]) : [];
    } catch {
      return false;
    }
    stored.set(row.session_id, { machine: row.machine_id, inputs: row.inputs, transcript: row.facts_transcript, titleInputs, archived: row.archived_ms !== null });
  }
  const states = new Map<string, string | null>();
  const statesAt = new Map<string, number>();
  for (const row of db.prepare("SELECT source, state, updated_ms FROM ingest_state WHERE kind IN ('unit', 'copy')").all() as { source: string; state: string | null; updated_ms: number }[]) {
    states.set(row.source, row.state);
    statesAt.set(row.source, row.updated_ms);
  }
  for (const s of d.sessions.values()) {
    if (deletes.has(s.id)) continue;
    const prev = stored.get(s.id);
    if (!prev && states.get(`copy:${s.id}`) === factsStamp(s, d.codexIndex)) continue; // a copy of another machine's, as it was
    if (!prev || prev.archived || prev.inputs !== factsStamp(s, d.codexIndex, prev.titleInputs)) return false;
    for (const [k, v] of Object.entries(unitStamps(s, prev.transcript, now))) {
      const key = `unit:${k}:${prev.machine}:${s.id}`;
      if (states.get(key) === v) continue;
      if (k === 'work' && workRefreshMs !== undefined && now - (statesAt.get(key) ?? -Infinity) < workRefreshMs) continue;
      return false;
    }
  }
  // A session whose files are all gone is archived.
  for (const [id, prev] of stored) if (!prev.archived && !d.sessions.has(id)) return false;
  if (states.get(`unit:usage-machine:${me}`) !== usageMachineStamp(now)) return false;
  for (const s of deletedUnknown(db, d)) if (states.get(`unit:deleted-usage:${me}:${s.id}`) !== unitStamps(s, null, now).usage) return false;
  // The labels of an oak sync run since (noteSavedLabels).
  const run = syncRunStatus();
  if (run && getMeta(db, 'saved_labels_at') !== String(run.at)) return false;
  // Plans, memories and skills.
  const notes = new Map<string, { size: number; mtime: number; archived: number | null }>();
  for (const row of db.prepare('SELECT kind, path, size, mtime_ms, archived_ms FROM notes WHERE machine_id = ?').all(me) as { kind: string; path: string; size: number; mtime_ms: number; archived_ms: number | null }[]) {
    notes.set(`${row.kind}\u0000${row.path}`, { size: row.size, mtime: row.mtime_ms, archived: row.archived_ms });
  }
  const seen = new Set<string>();
  for (const n of d.notes) {
    const key = `${n.kind}\u0000${n.file}`;
    seen.add(key);
    const prev = notes.get(key);
    if (!prev || prev.archived !== null || prev.size !== n.st.size || prev.mtime !== n.st.mtimeMs) return false;
  }
  for (const [key, prev] of notes) if (prev.archived === null && !seen.has(key)) return false;
  // The delegated agents' records.
  const delegated = new Map((db.prepare('SELECT id, stamp FROM delegated WHERE machine_id = ?').all(me) as { id: string; stamp: string }[]).map((x) => [x.id, x.stamp]));
  if (delegated.size !== d.delegated.length || d.delegated.some((x) => delegated.get(x.id) !== x.stamp)) return false;
  // The copies of other machines' logs (a replica the record log already holds is never read).
  const replicaState = db.prepare('SELECT state FROM ingest_state WHERE source = ?');
  const synced = db.prepare("SELECT 1 FROM sessions WHERE machine_id = ? AND session_id = ? AND origin = 'synced'");
  for (const rep of d.replicas) {
    if (deletes.has(rep.session)) continue;
    if (!current(replicaState.get(`replica:${rep.origin}:${rep.session}`) as StateRow | undefined, stampOf(rep.st)) && !synced.get(rep.origin, rep.session)) return false;
  }
  // What waits to be published, and this machine's log grown past a compaction.
  if (db.prepare("SELECT 1 FROM ingest_state WHERE kind = 'pub-waiting' AND updated_ms <= ? LIMIT 1").get(now - PUBLISH_MS)) return false;
  for (const host of self) {
    const size = logBytes(host);
    if (size.total && size.total >= COMPACT_MIN_BYTES && size.total >= 2 * size.base && !compactionWaits(db, host)) return false;
  }
  return true;
}

/** How long the account readings and the spend reports are kept whole: the longest window counted (a bill cycle) and a
 *  margin. Each is written once per reply, so kept whole they would grow with every turn of every session, on every
 *  machine. Older, they stay as the account's usage over time at a coarser grain: one reading of each machine, agent,
 *  kind and hour (the hour's last), and one spend report of each session and day (the day's last, carrying what the
 *  day's reports added). Each keeps the latest, which the freshest-reading rule and the next report's delta read. */
export const USAGE_HISTORY_MS = 35 * 86_400_000;

/** Downsample what USAGE_HISTORY_MS no longer keeps whole, at most once a day, by whole hours and whole UTC days before
 *  the cut. Every machine applies the same rule to every machine's rows, so nothing is published for it; this machine's
 *  own leave its log at its next compaction. The answers on the five-hour limit keep the hour's last of each answer, so
 *  the newest of each, which the status line cache still names, is never deleted and written again. A spend day folds
 *  its reports into its last, so a span of whole days sums to the same spend. A day that took another machine's rows in
 *  the last day waits for a later prune, by when a log read again is whole; a usage pull leaves alone the days this index
 *  already holds (applyUsageRecords). */
function pruneUsageHistory(r: Run): void {
  if (r.now - Number(getMeta(r.db, 'usage_pruned_ms') ?? 0) < 86_400_000) return;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const cutHour = Math.floor((r.now - USAGE_HISTORY_MS) / HOUR) * HOUR;
  const cutDay = Math.floor((r.now - USAGE_HISTORY_MS) / DAY) * DAY;
  const sameDay = `x.machine_id = usage_spend.machine_id AND x.session_id = usage_spend.session_id
    AND x.reported_ms >= usage_spend.reported_ms / ${DAY} * ${DAY} AND x.reported_ms < (usage_spend.reported_ms / ${DAY} + 1) * ${DAY}`;
  const settled = `NOT EXISTS (SELECT 1 FROM usage_spend x WHERE ${sameDay} AND x.synced_ms > ?)`;
  write(r.db, () => {
    r.db.prepare(`DELETE FROM usage_readings WHERE measured_ms < ? AND EXISTS (SELECT 1 FROM usage_readings x WHERE x.machine_id = usage_readings.machine_id
      AND x.agent = usage_readings.agent AND x.kind = usage_readings.kind AND x.no_limit = usage_readings.no_limit AND x.measured_ms > usage_readings.measured_ms
      AND x.measured_ms < (usage_readings.measured_ms / ${HOUR} + 1) * ${HOUR})`).run(cutHour);
    r.db.prepare(`UPDATE usage_spend SET delta = (SELECT total(x.delta) FROM usage_spend x WHERE ${sameDay}) WHERE reported_ms < ?
      AND NOT EXISTS (SELECT 1 FROM usage_spend x WHERE ${sameDay} AND x.reported_ms > usage_spend.reported_ms)
      AND EXISTS (SELECT 1 FROM usage_spend x WHERE ${sameDay} AND x.reported_ms < usage_spend.reported_ms) AND ${settled}`).run(cutDay, r.now - DAY);
    r.db.prepare(`DELETE FROM usage_spend WHERE reported_ms < ? AND EXISTS (SELECT 1 FROM usage_spend x WHERE ${sameDay} AND x.reported_ms > usage_spend.reported_ms)
      AND ${settled}`).run(cutDay, r.now - DAY);
    setMeta(r.db, 'usage_pruned_ms', String(r.now));
  });
}

/** Price again, at today's list prices, every message a price table other than this one priced, and those none has yet
 *  (another machine's, as its record or usage pull brought it): the cost and whether it is approximate change, the tokens
 *  never do, and `usage_daily` follows by its trigger. The spend Claude Code reported (usage_spend) is never touched.
 *  Inside the caller's transaction, a batch at a time (a row priced leaves the query); the number of rows priced. */
export function repriceUsage(db: DatabaseSync): number {
  const next = db.prepare(`SELECT message_id, agent, model, provider, input, output, cache_create, cache_create_1h, cache_read, speed, geo FROM usage_messages
    WHERE priced < ? OR priced > ? LIMIT 2000`);
  const set = db.prepare('UPDATE usage_messages SET cost = ?, cost_approx = ?, priced = ? WHERE message_id = ?');
  let n = 0;
  for (;;) {
    const rows = next.all(PRICE_VERSION, PRICE_VERSION) as { message_id: string; agent: string; model: string; provider: string | null; input: number; output: number;
      cache_create: number; cache_create_1h: number | null; cache_read: number; speed: string | null; geo: string | null }[];
    if (!rows.length) break;
    for (const x of rows) {
      const c = usageCost(x.agent, x.model, x.provider, { input: x.input, output: x.output, cacheCreate: x.cache_create, cacheCreate1h: x.cache_create_1h,
        cacheRead: x.cache_read, speed: x.speed, geo: x.geo });
      set.run(c.usd, c.approx ? 1 : 0, PRICE_VERSION, x.message_id);
    }
    n += rows.length;
  }
  if (getMeta(db, 'usage_priced') !== PRICE_VERSION) setMeta(db, 'usage_priced', PRICE_VERSION);
  return n;
}

/** How long OAK's cleanup waits for the catch-up lease before it removes sessions. */
export const CLEANUP_WAIT_MS = 30_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Before OAK's own cleanup removes sessions or clears records (`oak clean`, an editor's Drop or Clear): bring them up to
 * date, so what they did is in the index and in this machine's record log before their files go, and note that the
 * cleanup is why they will be gone (their archive reason, `cleaned`).
 */
export function beforeCleanup(db: DatabaseSync, ids: Iterable<string>, opts: { archive: boolean; waitMs?: number }): CatchUpResult {
  const only = new Set([...ids].filter(isSafeSessionId));
  let res = catchUp(db, { only });
  if (!res.ran && only.size) {
    // Another process is catching up (a build can take minutes): ask it to hand the lease over at its next session,
    // and wait for it. Without the lease, what these sessions did since the index last read them would go unrecorded.
    // Only while a live process holds it: a lease that could not be taken with nobody holding it (a full disk) is not
    // one to wait for.
    const until = Date.now() + (opts.waitMs ?? CLEANUP_WAIT_MS);
    let held = leaseHolder(db) !== null;
    if (held) {
      wantLease(db, until + LEASE_MS);
      try {
        while (!res.ran && held && Date.now() < until) {
          sleep(50);
          res = catchUp(db, { only });
          held = res.ran || leaseHolder(db) !== null;
        }
      } finally {
        unwantLease(db);
      }
    }
    const what = `what ${only.size === 1 ? 'this session' : 'these sessions'} did since the database last read ${only.size === 1 ? 'it' : 'them'} is not in its archive`;
    if (!res.ran) res.problems.push(held ? `another process kept the local database busy for ${Math.round((opts.waitMs ?? CLEANUP_WAIT_MS) / 1000)} s: ${what}` : `the local database could not be written: ${what}`);
  }
  if (opts.archive && only.size) {
    write(db, () => {
      const hint = db.prepare("UPDATE sessions SET archive_hint = 'cleaned' WHERE session_id = ? AND origin = 'local'");
      for (const id of only) hint.run(id);
    });
  }
  return res;
}

/**
 * The usage `oak usage` reads, brought up to date at the cost of a status line's render: the named session's transcripts
 * with their workers' (or its rollouts), and this machine's usage readings, spend and accounts, and nothing else (the
 * rest of the index catches up on its own reads and in the background). Only while no other process holds the catch-up
 * lease: `ran` false says the index was read as it was.
 */
export function catchUpUsage(db: DatabaseSync, opts: { session?: string | null; transcript?: string | null; rollout?: string | null; now?: number } = {}): { ran: boolean; problems: string[] } {
  const now = opts.now ?? Date.now();
  const problems: string[] = [];
  const stamp = usageMachineStamp(now);
  // A session deleted on purpose is read no more, as by every catch-up: its usage up to the delete stays without it.
  if (opts.session && deliberateDeletes(hiddenSessions()).has(opts.session)) opts = { ...opts, session: null, transcript: null, rollout: null };
  // Nothing new since the last call, as between two replies, when a status line renders many times: no lease, no write.
  if (usageCurrent(db, opts, stamp, now)) return { ran: true, problems };
  if (!tryLease(db, now)) return { ran: false, problems };
  const r = newRun(db, { now, deadline: Infinity, problems });
  try {
    r.account = claudeAccountTag();
    if (!db.prepare('SELECT 1 FROM machines WHERE machine_id = ? AND is_self = 1').get(r.me)) {
      write(db, () => db.prepare(upsertSql('machines', ['machine_id'], ['machine_id', 'label', 'is_self', 'home', 'platform', 'last_seen_ms']))
        .run(r.me, 'this machine', 1, os.homedir(), process.platform, now));
    }
    const id = opts.session && isSafeSessionId(opts.session) ? opts.session : null;
    if (id) {
      const filed = (db.prepare("SELECT machine_id FROM sessions WHERE session_id = ? AND origin IN ('local', 'pulled') ORDER BY origin DESC LIMIT 1").get(id) as { machine_id: string } | undefined)?.machine_id ?? r.me;
      const s: SessionSources = { id, transcripts: [], rollouts: [], store: false, files: {}, newest: 0, sides: new Map(), tab: null };
      const t = opts.transcript ? stat(opts.transcript) : null;
      if (t && opts.transcript) s.transcripts.push({ t: { id, file: opts.transcript, label: '' }, st: t });
      const x = opts.rollout ? stat(opts.rollout) : null;
      if (x && opts.rollout) s.rollouts.push({ file: opts.rollout, st: x });
      ingestUsage(r, filed, s);
      commit(r);
    }
    const was = db.prepare('SELECT state FROM ingest_state WHERE source = ?').get(`unit:usage-machine:${r.me}`) as { state: string } | undefined;
    if (was?.state !== stamp) {
      ingestUsageMachine(r, r.account);
      begin(r);
      db.prepare(upsertSql('ingest_state', ['source'], ['source', 'kind', 'machine_id', 'session_id', 'state', 'updated_ms'])).run(`unit:usage-machine:${r.me}`, 'unit', r.me, null, stamp, now);
      commit(r);
    }
    // A new price table reprices what the windows sum before they are read (repriceUsage).
    if (getMeta(db, 'usage_priced') !== PRICE_VERSION) write(db, () => repriceUsage(db));
    publishWaiting(r);
  } catch (e) {
    rollback(r);
    problems.push(String((e as Error)?.message || e));
  } finally {
    releaseLease(db);
  }
  return { ran: true, problems };
}

/** Whether catchUpUsage has nothing to do: this machine is recorded, its usage caches are as they were read last, the
 *  session's transcripts (its workers' too) were read to their end as they are now, and nothing waits to be published.
 *  A Codex rollout is always read (its cursor is no byte offset). Reads only. */
function usageCurrent(db: DatabaseSync, opts: { session?: string | null; transcript?: string | null; rollout?: string | null }, stamp: string, now: number): boolean {
  const me = machineHostTag();
  if (opts.rollout || !db.prepare('SELECT 1 FROM machines WHERE machine_id = ? AND is_self = 1').get(me)) return false;
  if ((db.prepare('SELECT state FROM ingest_state WHERE source = ?').get(`unit:usage-machine:${me}`) as { state: string | null } | undefined)?.state !== stamp) return false;
  const id = opts.session && isSafeSessionId(opts.session) ? opts.session : null;
  const files = id && opts.transcript ? [opts.transcript, ...workerTranscripts(opts.transcript, id)] : [];
  const read = db.prepare('SELECT dev, ino, size, mtime_ms, state FROM ingest_state WHERE source = ?');
  for (const file of files) {
    const st = stat(file);
    const prev = read.get(`usage:${file}`) as { dev: number; ino: number; size: number; mtime_ms: number; state: string | null } | undefined;
    if (!st || !prev || prev.state !== 'done' || prev.dev !== st.dev || prev.ino !== st.ino || prev.size !== st.size || prev.mtime_ms !== st.mtimeMs) return false;
  }
  if (getMeta(db, 'usage_priced') !== PRICE_VERSION) return false;
  return !db.prepare("SELECT 1 FROM ingest_state WHERE kind = 'pub-waiting' AND updated_ms <= ? LIMIT 1").get(now - PUBLISH_MS);
}

// --- the usage pull -------------------------------------------------------------------------------------------------

/** What `oak __usage-records` answers (a saved machine's usage pull reads it over ssh): this machine's own usage rows
 *  changed since a cursor, in pages. Only usage, never conversation text: the pull runs with the consent the saved
 *  machines' usage readings always had, for a machine that does not sync. */
export interface UsageRecords {
  usageRecords: 1;
  /** The machine (machineHostTag) and every id its rows are filed under. */
  host: string;
  hosts: string[];
  at: number;
  /** Where the next pull starts: `<epoch>:<seq>:<purged ms>`. The epoch names this index file: a new one (rebuilt)
   *  numbers its writes again, so a cursor of another epoch starts over. */
  cursor: string;
  more: boolean;
  messages: Record<string, unknown>[];
  readings: Record<string, unknown>[];
  spend: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  billDays?: Record<string, unknown>[];
  /** Sessions forgotten on purpose here since the cursor: their usage goes there too. */
  purged: { session: string; at: number }[];
}

/** This index's epoch (UsageRecords.cursor), made the first time it is asked. */
function usageEpoch(db: DatabaseSync): string {
  let e = getMeta(db, 'usage_epoch');
  if (!e) {
    e = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const made = e;
    write(db, () => setMeta(db, 'usage_epoch', made));
  }
  return e;
}

/** This machine's own usage rows written after `since` (UsageRecords.cursor), at most `limit` of each kind: read in one
 *  snapshot, so a write made meanwhile is either in this page or after its cursor. */
export function usageRecordsSince(db: DatabaseSync, since: string | null, limit = 20_000): UsageRecords {
  const epoch = usageEpoch(db);
  const [e, s, p] = (since ?? '').split(':');
  const fresh = e !== epoch;
  const seq = fresh ? -1 : Number(s) || 0;
  const purgedAt = fresh ? 0 : Number(p) || 0;
  const self = (db.prepare('SELECT machine_id FROM machines WHERE is_self = 1').all() as { machine_id: string }[]).map((m) => m.machine_id);
  if (!self.includes(machineHostTag())) self.push(machineHostTag());
  const marks = self.map(() => '?').join(', ');
  db.exec('BEGIN');
  try {
    // Never the simulator's usage, which was never billed (as its sessions never leave in the record log).
    const raw = USAGE_RECORD_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} WHERE machine_id IN (${marks}) AND synced_ms IS NULL AND seq > ?
      ${table === 'usage_messages' || table === 'usage_spend' ? 'AND session_id NOT GLOB ?' : ''} ORDER BY seq LIMIT ?`)
      .all(...self, seq, ...(table === 'usage_messages' || table === 'usage_spend' ? [DEMO_GLOB] : []), limit + 1) as Record<string, unknown>[]);
    // A kind cut at the limit says how far this page goes: its last row's write. Every kind not cut is wholly through it.
    const cut = raw.filter((x) => x.length > limit);
    for (const x of raw) x.splice(limit);
    const through = cut.length ? Math.min(...cut.map((x) => Number(x[x.length - 1].seq))) : Math.max(seq, Number(getMeta(db, 'usage_seq') ?? 0));
    const purged = (db.prepare(`SELECT session_id, purged_ms FROM tombstones WHERE machine_id IN (${marks}) AND purged_ms > ? ORDER BY purged_ms`).all(...self, purgedAt) as
      { session_id: string; purged_ms: number }[]).map((t) => ({ session: t.session_id, at: t.purged_ms }));
    const purgedThrough = purged.reduce((m, t) => Math.max(m, t.at), purgedAt);
    const [messages, readings, spend, accounts, billDays] = raw.map((rows, i) => rows.map((row) => recordRow(USAGE_RECORD_TABLES[i], row)));
    return { usageRecords: 1, host: machineHostTag(), hosts: self, at: Date.now(), cursor: `${epoch}:${through}:${purgedThrough}`, more: cut.length > 0,
      messages, readings, spend, accounts, billDays, purged };
  } finally {
    db.exec('COMMIT');
  }
}

/**
 * Apply a saved machine's usage pull (UsageRecords) to this index: its rows filed under it (each message once, at its
 * largest snapshot, whichever machine's copy arrived first), marked with when they arrived, its sessions forgotten there
 * forgotten here, and the machine named by the label this machine knows it by, with its clock's difference from this one.
 * Never this machine's own rows (an answer this machine gave itself, saved under another name, changes nothing).
 */
export function applyUsageRecords(db: DatabaseSync, a: UsageRecords, opts: { label: string; skewMs: number; now?: number }): number {
  const now = opts.now ?? Date.now();
  const self = new Set((db.prepare('SELECT machine_id FROM machines WHERE is_self = 1').all() as { machine_id: string }[]).map((m) => m.machine_id));
  self.add(machineHostTag());
  if (!RECORD_HOST_ID.test(a.host) || self.has(a.host)) return 0;
  const hosts = new Set((a.hosts ?? [a.host]).filter((h) => RECORD_HOST_ID.test(h) && !self.has(h)));
  hosts.add(a.host);
  let n = 0;
  // A spend report older than the history cut is of a day this index downsamples itself (pruneUsageHistory), which the
  // machine that sent it may have folded into its last report already: a day this index held before this pull (its rows
  // arrived at another time than `now`, which every page of one pull shares) keeps its own reports, so it is never
  // counted twice.
  const DAY = 86_400_000;
  const cutDay = Math.floor((now - USAGE_HISTORY_MS) / DAY) * DAY;
  const dayHeld = db.prepare('SELECT 1 FROM usage_spend WHERE machine_id = ? AND session_id = ? AND reported_ms >= ? AND reported_ms < ? AND (synced_ms IS NULL OR synced_ms <> ?) LIMIT 1');
  write(db, () => {
    for (const h of hosts) {
      // The label it was pulled by is the one this machine saved it under; its own name, until its records give it.
      db.prepare(`INSERT INTO machines (machine_id, label, saved_label, is_self, skew_ms, last_seen_ms) VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(machine_id) DO UPDATE SET label = coalesce(machines.label, excluded.label), saved_label = excluded.saved_label, skew_ms = excluded.skew_ms,
        last_seen_ms = excluded.last_seen_ms`).run(h, graphemeHead(opts.label, 200), graphemeHead(opts.label, 200), Math.round(opts.skewMs), now);
    }
    const put = (table: string, rows: Record<string, unknown>[]): void => {
      for (const row of rows ?? []) {
        if (!row || typeof row !== 'object') continue;
        const machine = typeof row.machine_id === 'string' && hosts.has(row.machine_id) ? row.machine_id : a.host;
        const { machine_id: _m, seq: _s, synced_ms: _y, ...rest } = row;
        void _m; void _s; void _y;
        if (!RECORD_TABLES[table].keys.every((k) => k in rest)) continue;
        if (typeof rest.session_id === 'string' && DEMO_SESSION.test(rest.session_id)) continue; // an earlier OAK sent the simulator's
        if (table === 'usage_spend' && typeof rest.reported_ms === 'number' && rest.reported_ms < cutDay && typeof rest.session_id === 'string') {
          const day = Math.floor(rest.reported_ms / DAY) * DAY;
          if (dayHeld.get(machine, rest.session_id, day, day + DAY, now)) continue;
        }
        const { sql, cols } = recordUpsert(db, table, Object.keys(rest));
        db.prepare(sql).run(...fitRow(db, table, cols, cols.map((c) => (c === 'machine_id' ? machine : c === 'synced_ms' ? now : rest[c]))));
        n++;
      }
    };
    put('usage_messages', a.messages);
    put('usage_readings', a.readings);
    put('usage_spend', a.spend);
    put('accounts', a.accounts);
    put('account_bill_days', a.billDays ?? []);
    for (const p of a.purged ?? []) {
      if (typeof p?.session !== 'string' || !isSafeSessionId(p.session)) continue;
      for (const h of hosts) keepUsageOf(db, p.session, h);
    }
    repriceUsage(db);
    setMeta(db, `usage_pull_partial:${a.host}`, a.more ? '1' : '0');
    // Where the next pull of that machine starts, with what this one applied: a pull stopped part way resumes there.
    if (typeof a.cursor === 'string' && a.cursor.length < 200) {
      db.prepare(upsertSql('ingest_state', ['source'], ['source', 'kind', 'machine_id', 'state', 'updated_ms'])).run(`usage-pull:${a.host}`, 'usage-pull', a.host, a.cursor, now);
    }
  });
  return n;
}

/** Where the next usage pull of a machine starts (applyUsageRecords), or null to start from its beginning. */
export function usagePullCursor(db: DatabaseSync, host: string): string | null {
  return (db.prepare('SELECT state FROM ingest_state WHERE source = ?').get(`usage-pull:${host}`) as { state: string | null } | undefined)?.state ?? null;
}

const RECORD_HOST_ID = /^[0-9a-f]{12}$/;
