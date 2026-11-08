/**
 * The local index: one SQLite file per store on this machine (location.ts), built and kept current from the files OAK
 * and the agents write (ingest.ts), and read through named queries and guarded SQL (query.ts, sql.ts). It is a cache of
 * those files, never their replacement: deleting it loses nothing the files still hold, and the next read rebuilds it.
 * Only the archive (sessions whose files are gone) lives nowhere else, which is why a new index file carries it over
 * from the previous one (archive.ts).
 *
 * This module is the index's whole surface for the CLI and the other front ends.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { indexRuntime, INDEX_NODE_FLOOR, INDEX_NODES, type IndexUnavailable } from './runtime';
import { indexFile, indexFiles, kickIndexBuild, INDEX_FORMAT } from './location';
import { openIndex, openIndexReadOnly, leaseHolder, getMeta, dataVersion, forgetInLog, forgetElsewhere, isCorrupt } from './db';
import { syncedSessionRows, syncedSessionRow, syncedHands, indexedMachineListings, indexedMachineSearch as searchMachineRecords, indexedSessionMeta, type MachineListing } from './listing';
import { catchUp, beforeCleanup, forgetSession, catchUpUsage, failedSessions, usageRecordsSince, applyUsageRecords, usagePullCursor as ingestPullCursor, logState, ownLogLost, missingRecordParts, type CatchUpResult, type UsageRecords } from './ingest';
import { codexAccountOf, codexWindowTotals, usageTotals, machineReadingEntries, holdsOtherUsage, type UsageTotals } from './usage';
import { segments, recordHosts, logPlan, wholeBase, RecordWriter, sealRecords } from './records';
import { machineHostTag } from '../machine-usage';
import { carryArchive, reclaimableIndexFiles } from './archive';
import { runNamedQuery, queryFailure, QueryError, freshness, type QueryAnswer, type QueryFailure } from './query';
import { runSqlInChild, type SqlResult } from './sql';
import { oakCliEntry } from '../cli-entry';
import { logPath, setStoreIndexHooks, hiddenSessions, rootDir } from '../store';
import { identityKey, readMountTable } from '../sync-identity';
import type { Check } from '../diagnose';
import { canonPath } from '../paths';

export { INDEX_NODE_FLOOR, INDEX_NODES, nodeRunsIndex, indexRuntime, resetIndexRuntime } from './runtime';
export { INDEX_FORMAT, indexDir, indexFile, indexFiles, removeIndexFile, storeKey, kickIndexBuild, backOffIndexBuild, claimTouchedSince } from './location';
export { SCHEMA_VERSION, INGEST_VERSION, SESSION_TABLES } from './schema';
export { QUERY_CONTRACT_VERSION, NAMED_QUERIES, QueryError, queryFailure, failureExitCode, parseTime, ftsQuery } from './query';
export type { QueryAnswer, QueryFailure, QueryFreshness, QueryErrorCode } from './query';
export { runGuardedSql, runSqlInChild, sqlChildWatchdog, checkSqlKeywords, checkOneStatement, sqlWords } from './sql';
export type { SqlRequest, SqlResult } from './sql';
export { reclaimableIndexFiles, carryArchive } from './archive';
export { catchUp, purgeSession, catchUpUsage, failedSessions, usageOfLine, usageRecordsSince, applyUsageRecords, TOP_TIER, PUBLISH_MS, QUIET_MS, TX_ROWS, TX_MS } from './ingest';
export { fitRow } from './rows';
export type { CatchUpResult, CatchUpOptions, FailedSession, UsageMessage, UsageRecords } from './ingest';
export { usageFreshness, codexWindowTotals, usageTotals, windowTotals, rollingWindow, billCycle, namedWindow, latestReset, countedAccount, selfIds, usageBreakdownSql, machineReadingEntries, othersMeasured, USAGE_WINDOWS, USAGE_GROUPS, FIVE_HOURS_MS, WEEK_MS } from './usage';
export type { UsageTotals, UsageWindowTotals, UsageWindowSpan } from './usage';
export { RECORDS_DIR, RECORD_FORMAT, RECORD_TABLES, USAGE_RECORD_TABLES, SEGMENT_MAX_BYTES, RECORD_HOST, recordsRoot, segments, recordHosts, wholeBase, baseHeader, readRecordLog, dropCovered } from './records';
export { openIndex, openIndexReadOnly, tryLease, releaseLease, dataVersion, LEASE_HOLDER, write as indexWrite } from './db';
export { indexedSessionMeta, indexedSearch, indexedInbox, indexedMachineListings, syncedHands, listingDifference, recordShadow } from './listing';
export type { MachineListing } from './listing';

/** How the CLI uses the index: `off` lists the old way; `shadow` lists the old way and records where the index would
 *  have differed; `on` (the default) serves the listings from the index when it is caught up. */
export function indexMode(): 'off' | 'shadow' | 'on' {
  const v = process.env.OAK_INDEX;
  return v === 'off' ? 'off' : v === 'shadow' ? 'shadow' : 'on';
}

export interface IndexSession {
  ok: true;
  db: DatabaseSync;
  file: string;
  catchUp: CatchUpResult;
  close(): void;
}

/** A reader's catch-up: at most this long, and none at all when more than this much would be read (a first build that
 *  large belongs to the detached `oak __index-build`). */
export const READ_BUDGET_MS = 2000;
export const READ_INLINE_BYTES = 64 * 1024 * 1024;
/** How often a listing's catch-up re-reads a changing session's tool calls and workers, which no listing shows. */
export const LISTING_WORK_REFRESH_MS = 30_000;

/**
 * Open this store's index and catch it up for a read: the archive is carried into a new file first, then the catch-up
 * runs within `budgetMs`. When the catch-up is left undone (another process holds it, or there is too much for a
 * reader to wait for), `catchUp.caughtUp` is false and, if `kick` is set, a detached build is started.
 */
export function useIndex(opts: { budgetMs?: number; inlineBytes?: number; kick?: boolean; workRefreshMs?: number } = {}): IndexSession | IndexUnavailable {
  const opened = openIndex();
  if (!opened.ok) return opened;
  const { db, file } = opened;
  try {
    const carried = carryArchive(db, file);
    const res = catchUp(db, { budgetMs: opts.budgetMs ?? READ_BUDGET_MS, inlineBytes: opts.inlineBytes ?? READ_INLINE_BYTES, workRefreshMs: opts.workRefreshMs });
    if (carried.problem) res.problems.push(carried.problem);
    if (!res.caughtUp && opts.kick && (res.deferredBytes !== undefined || res.left > 0)) kickIndexBuild();
    return { ok: true, db, file, catchUp: res, close: opened.close };
  } catch (e) {
    opened.close();
    return { ok: false, reason: `the database could not be read: ${String((e as Error)?.message || e)}` };
  }
}

/** The whole catch-up with no budget: what the detached `oak __index-build` runs. */
export function buildIndex(): CatchUpResult | IndexUnavailable {
  const opened = openIndex();
  if (!opened.ok) return opened;
  try {
    const carried = carryArchive(opened.db, opened.file);
    const res = catchUp(opened.db, {});
    if (carried.problem) res.problems.push(carried.problem);
    return res;
  } finally {
    opened.close();
  }
}

/** How long a machine answering another's `oak sync now` catches its index up first (`oak __sync-inventory --publish`):
 *  what it holds then is in its record log before its inventory lists that log, so the run that asked takes it. */
export const SYNC_PUBLISH_MS = 5000;

/** Catch this machine's index up within `budgetMs`, which publishes its records (`oak __sync-inventory --publish`).
 *  Fails nothing: an index that cannot be read here publishes nothing, and the inventory is answered as before.
 *  What it leaves (a first build larger than a reader reads at once, or more than the budget) is started in the
 *  background (`oak __index-build`, never under OAK_NO_BACKGROUND), so a later run takes it. */
export function publishRecords(budgetMs = SYNC_PUBLISH_MS): CatchUpResult | null {
  if (indexMode() === 'off') return null;
  // The agents started here from a brief, derived now, so the rows the run takes say what they are doing now.
  try { (require('../delegated') as typeof import('../delegated')).refreshDelegated(); } catch { /* their rows as last derived */ }
  const ix = useIndex({ budgetMs, kick: true });
  if (!ix.ok) return null;
  ix.close();
  try { sealRecords(machineHostTag()); } catch { /* a later run can close it; an unsealed copy remains readable */ }
  return ix.catchUp;
}

/** Run a named query, catching the index up first: the answer, or the failure, in the JSON contract. */
export function queryIndex(name: string, params: Record<string, unknown>, opts: { arrays?: boolean; kick?: boolean; budgetMs?: number } = {}): QueryAnswer | QueryFailure {
  const ix = useIndex({ kick: opts.kick, budgetMs: opts.budgetMs });
  if (!ix.ok) return { v: 1, error: { code: 'index_unavailable', message: ix.reason } };
  try {
    return runNamedQuery(ix.db, name, params, { caughtUp: ix.catchUp.caughtUp, arrays: opts.arrays, problems: ix.catchUp.problems });
  } catch (e) {
    return queryFailure(e);
  } finally {
    ix.close();
  }
}

/** Run one guarded read (`oak query sql`): the index is caught up here, the statement runs in a child killed at the
 *  deadline. */
export function querySql(sql: string, opts: { params?: (string | number | null)[]; limit?: number; arrays?: boolean; deadlineMs?: number; kick?: boolean; entry?: string; budgetMs?: number } = {}): QueryAnswer | QueryFailure {
  const t0 = Date.now();
  const entry = opts.entry ?? oakCliEntry();
  if (!entry) return { v: 1, error: { code: 'index_unavailable', message: 'raw SQL runs through the oak CLI, which is not known in this process' } };
  const ix = useIndex({ kick: opts.kick, budgetMs: opts.budgetMs });
  if (!ix.ok) return { v: 1, error: { code: 'index_unavailable', message: ix.reason } };
  const limit = opts.limit ?? 1000;
  let fresh;
  try {
    fresh = freshness(ix.db, ix.catchUp.caughtUp);
  } finally {
    ix.close();
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) return queryFailure(new QueryError('bad_param', 'limit must be a whole number from 1 to 100000'));
  const res: SqlResult = runSqlInChild({ file: ix.file, sql, params: opts.params, limit, arrays: opts.arrays }, { entry, deadlineMs: opts.deadlineMs ?? 10_000 });
  if (!res.ok) return { v: 1, error: { code: res.code, message: res.message } };
  return {
    v: 1, query: 'sql', params: { sql, ...(opts.params?.length ? { params: opts.params } : {}), limit }, columns: res.columns, rows: res.rows as QueryAnswer['rows'],
    rowCount: res.rows.length, truncated: res.truncated, freshness: fresh, elapsedMs: Date.now() - t0,
    problems: [...ix.catchUp.problems, ...(res.guard === 'keywords' ? [`this Node (${process.version}) has no SQLite authorizer; a keyword check guards raw SQL`] : []),
      ...(res.cutAtBytes ? [`the rows were cut at ${Math.round(res.cutAtBytes / 1048576)} MB of JSON; ask for fewer rows or columns`] : [])],
  };
}

/** Sessions this process recorded before a cleanup (indexBeforeCleanup), with their log as it then was: a cleanup that
 *  removes many sessions records them at once (`oak clean`), and core's own record of each as it goes (store.ts) then has
 *  nothing to add, while the log is as it was then. */
const recordedBeforeCleanup = new Map<string, { at: number; archive: boolean; log: string }>();
const RECORDED_FRESH_MS = 10_000;

/** A session log's identity: where it is, and its size, time and inode (or that it is not there). */
function logIdentity(id: string): string {
  try {
    const file = logPath(id);
    try {
      const st = fs.statSync(file);
      return `${file}|${st.size}:${st.mtimeMs}:${st.ino}`;
    } catch {
      return `${file}|-`;
    }
  } catch {
    return '-';
  }
}

/** Before OAK's cleanup removes sessions or clears records: catch the index up on them (and publish what they did to this
 *  machine's record log), and note why they will go. Does nothing (and fails nothing) when the index is unavailable, as
 *  where an editor's Node has no node:sqlite: what the log already holds then stands, and what the session did since the
 *  last catch-up is lost with its files. Returns what kept it from recording them, for the caller to say: the cleanup
 *  goes on, and the index archives what it last saw. */
export function indexBeforeCleanup(ids: Iterable<string>, opts: { archive: boolean; waitMs?: number }): string[] {
  const now = Date.now();
  const due = [...ids].filter((id) => {
    const was = recordedBeforeCleanup.get(id);
    return !was || now - was.at > RECORDED_FRESH_MS || (opts.archive && !was.archive) || was.log !== logIdentity(id);
  });
  if (!due.length) return [];
  const opened = openIndex();
  if (!opened.ok) return [];
  try {
    carryArchive(opened.db, opened.file);
    const problems = beforeCleanup(opened.db, due, opts).problems;
    for (const id of due) recordedBeforeCleanup.set(id, { at: Date.now(), archive: opts.archive, log: logIdentity(id) });
    return problems;
  } catch (e) {
    return [`the local database could not record the sessions before they were removed: ${String((e as Error)?.message || e)}`];
  } finally {
    opened.close();
  }
}

/** The saved machines' last answers (machine-usage.ts), whose own figures the totals add for a machine that answers only
 *  with its readings (usage.ts usageTotals); none while `"machineUsage": false` turns their readings off. */
function savedBriefs(): import('../machine-usage').MachineUsageEntry[] {
  const mu = require('../machine-usage') as typeof import('../machine-usage');
  return mu.machineUsageEnabled() ? mu.readMachineUsage().machines : [];
}

/** How stale the index may be before `oak usage` starts a background catch-up of everything (its own covers only the
 *  session it is asked about and this machine's usage caches). */
export const USAGE_SWEEP_MS = 60_000;

/** How lately a catch-up of everything must have finished for `oak usage`'s totals to say they are whole (`caughtUp`). */
export const TOTALS_FRESH_MS = 15 * 60_000;

/** What the usage readout (observe.ts usageLine) takes from the index, in one open: the other machines' latest readings of
 *  the Claude account, and the account's windows placed by this machine's own resets. Null where the index is
 *  unavailable (the readout then takes the saved machines' readings from their cache file, as before the index). Reads
 *  what the index holds: never a catch-up (VS Code calls it in-process). */
export function indexedUsageView(opts: { fiveReset: number | null; weekReset: number | null; now?: number }): { entries: import('../machine-usage').MachineUsageEntry[]; totals: UsageTotals | null } | null {
  const opened = openIndex();
  if (!opened.ok) return null;
  try {
    // The totals only where they add another machine's usage (they read this machine's login, which nothing else here
    // needs then); otherwise the saved machines' briefs say what they measured, as before the index.
    return { entries: machineReadingEntries(opened.db), totals: holdsOtherUsage(opened.db) ? usageTotals(opened.db, { ...opts, briefs: savedBriefs() }) : null };
  } catch {
    return null;
  } finally {
    opened.close();
  }
}

/** `oak usage`'s totals: the account's usage windows from the index (usage.ts), placed by the resets a readout shows,
 *  once the index has caught up on what they need now, in the same open: the session's usage files and this machine's
 *  usage caches (catchUpUsage, which writes nothing when nothing changed, as between replies), with a background
 *  catch-up of the rest once the index is more than USAGE_SWEEP_MS behind. Null where the index is unavailable. */
export function indexedUsageTotals(opts: { fiveReset: number | null; weekReset: number | null; now?: number; session?: string | null; transcript?: string | null;
  rollout?: string | null }): (UsageTotals & { caughtUp: boolean; indexedAt: number | null }) | null {
  const opened = openIndex();
  if (!opened.ok) return null;
  try {
    carryArchive(opened.db, opened.file);
    catchUpUsage(opened.db, { session: opts.session, transcript: opts.transcript, rollout: opts.rollout });
    const at = getMeta(opened.db, 'caught_up_ms');
    if (Date.now() - Number(at ?? 0) > USAGE_SWEEP_MS) kickIndexBuild();
    // Whole only once a catch-up of everything has finished lately, with no session failing: before the first (a machine
    // just updated, its build still running) the windows hold the sessions read so far.
    const caughtUp = at !== null && Date.now() - Number(at) <= TOTALS_FRESH_MS && !failedSessions(opened.db).length;
    return { ...usageTotals(opened.db, { ...opts, briefs: savedBriefs() }), caughtUp, indexedAt: at ? Number(at) : null };
  } catch {
    return null;
  } finally {
    opened.close();
  }
}

export interface IndexStatus {
  available: boolean;
  reason?: string;
  /** Unavailable because a newer OAK wrote the file, which this one leaves alone. */
  newer?: boolean;
  node: string;
  sqlite?: string;
  /** The oldest Node release that runs the index. Not every later one does (no 23 release does): `nodes` says which. */
  floor: string;
  /** The Node releases that run the index, as a person reads them (INDEX_NODES). */
  nodes: string;
  file: string;
  format: number;
  bytes: number;
  sessions?: number;
  archived?: number;
  indexedAt?: number | null;
  firstBuildAt?: number | null;
  building?: { pid: number } | null;
  dataVersion?: number;
  /** Superseded index files `oak clean` would remove. */
  reclaimable: string[];
  /** This Node can run the index, but its file cannot be opened or read. */
  damaged?: boolean;
  /** Sessions the index could not bring up to date, with why: while any is listed, the index is not caught up, and the
   *  listings read the files. */
  failed?: { id: string; problem: string; at: number }[];
}

/** What `oak doctor` and `oak query --status` say about the index, without catching it up. */
export function indexStatus(): IndexStatus {
  const rt = indexRuntime();
  const file = indexFile();
  const info = indexFiles().find((f) => f.file === file);
  const base: IndexStatus = { available: rt.ok, node: process.version, floor: INDEX_NODE_FLOOR, nodes: INDEX_NODES, file, format: INDEX_FORMAT, bytes: info?.bytes ?? 0, reclaimable: [] };
  if (!rt.ok) return { ...base, reason: rt.reason };
  base.sqlite = rt.sqliteVersion;
  base.reclaimable = reclaimableIndexFiles();
  if (!info) return base;
  const opened = openIndex(file);
  if (!opened.ok) return { ...base, available: false, reason: opened.reason, ...(opened.newer ? { newer: true } : {}), ...(opened.damaged ? { damaged: true } : {}) };
  try {
    const db = opened.db;
    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const at = getMeta(db, 'caught_up_ms');
    const first = getMeta(db, 'first_build_ms');
    return {
      ...base,
      sessions: n('SELECT count(*) AS n FROM sessions WHERE archived_ms IS NULL'),
      archived: n('SELECT count(*) AS n FROM sessions WHERE archived_ms IS NOT NULL'),
      indexedAt: at ? Number(at) : null,
      firstBuildAt: first ? Number(first) : null,
      building: leaseHolder(db),
      dataVersion: dataVersion(db),
      failed: failedSessions(db),
    };
  } catch (e) {
    // A file that opens but cannot be read (pages overwritten): said, never thrown, so `oak doctor` still answers.
    return { ...base, available: false, ...(isCorrupt(e) ? { damaged: true } : {}), reason: `the database at ${file} could not be read: ${String((e as Error)?.message || e)}` };
  } finally {
    opened.close();
  }
}

/** A deliberate delete (`oak sessions --delete`): forget the session in the index now, its full-text entries with it,
 *  rather than at the next catch-up. So do the demo's cleanup and `oak uninstall --purge-store`, of the sessions they
 *  remove. Where the index cannot be opened (a damaged file, a newer OAK's, no index on this Node), this machine's
 *  record log, which a new index reads back, still gets the purges, if there is one; the answer is then why the index
 *  could not be opened, and null otherwise. */
export function indexForget(ids: string | readonly string[]): string | null {
  const list = typeof ids === 'string' ? [ids] : [...ids];
  if (!list.length) return null;
  const opened = openIndex();
  if (!opened.ok) {
    const me = machineHostTag();
    if (recordHosts().includes(me)) {
      try {
        const log = new RecordWriter(new Set([me]));
        for (const id of list) log.purge(me, id);
        log.flush();
      } catch {
        /* a log that cannot be written: the reason below is said */
      }
    }
    return opened.reason;
  }
  try {
    forgetSession(opened.db, list, 'deleted here');
    forgetInLog(opened.db);
  } catch {
    /* the next catch-up purges it */
  } finally {
    opened.close();
  }
  forgetElsewhere(list, opened.file);
  return null;
}

/** `oak doctor`'s row for the index. */
export function diagnoseIndex(now = Date.now()): Check {
  const st = indexStatus();
  if (!st.available) {
    const off = process.env.OAK_INDEX === 'off';
    // A newer Node helps only where this Node is what stops the index: not a file a newer OAK wrote, nor one that cannot
    // be opened. A damaged file is moved aside; anything else (a busy or unwritable file) is said in the detail.
    const fix = off ? null
      : st.newer ? 'Update OAK (`oak update`): a newer OAK on this machine wrote the database, and this one leaves it alone.'
      : st.damaged ? `Move ${st.file} aside; the next listing builds a new database from the files on disk and from the record logs, which bring back the sessions kept after their files were removed.`
      : !indexRuntime().ok ? `Install ${INDEX_NODES} (this is ${process.version}).`
      : null;
    return {
      id: 'index', label: 'Local database', level: off ? 'ok' : 'warn',
      detail: `${st.reason}; listings and search read the files directly, which is slower${off ? '' : ', and `oak query` has nothing to answer from'}`,
      ...(fix ? { fix } : {}),
    };
  }
  const { relTime } = require('../format') as typeof import('../format');
  const parts = [
    st.indexedAt ? `caught up ${relTime(st.indexedAt, now)}` : 'not built yet (the next listing builds it)',
    `${st.sessions ?? 0} session${st.sessions === 1 ? '' : 's'}${st.archived ? `, ${st.archived} archived` : ''}`,
    `${(st.bytes / 1048576).toFixed(1)} MB at ${st.file}`,
    `SQLite ${st.sqlite}`,
  ];
  if (st.building) parts.push(`a build is running (pid ${st.building.pid})`);
  if (st.reclaimable.length) parts.push(`\`oak clean\` removes ${st.reclaimable.length} superseded database file${st.reclaimable.length === 1 ? '' : 's'}`);
  if (st.failed?.length) {
    // A session that cannot be read keeps the index behind its files: said, never passed over as caught up.
    const n = st.failed.length;
    parts.push(`${n} session${n === 1 ? '' : 's'} could not be added to the database (${st.failed[0].id}: ${st.failed[0].problem}), so listings read the files directly`);
    return { id: 'index', label: 'Local database', level: 'warn', detail: parts.join('; '),
      fix: 'Run `oak query --status` for each session and why; a session whose file holds a value the database cannot keep stays out of it until that file changes.' };
  }
  return { id: 'index', label: 'Local database', level: 'ok', detail: parts.join('; ') };
}

/** Whether this machine's own record log lost a segment the local index published in it, while the index holds that
 *  machine's rows (ingest.ts ownLogLost): `oak doctor` says so where a backup is in use (sync-engine.ts diagnoseSync).
 *  The next catch-up writes it again from the index. False wherever the index cannot be read. */
export function ownRecordLogGone(): boolean {
  if (indexMode() === 'off') return false;
  const opened = openIndexReadOnly();
  if (!opened.ok) return false;
  try {
    const self = (opened.db.prepare('SELECT machine_id FROM machines WHERE is_self = 1').all() as { machine_id: string }[]).map((m) => m.machine_id);
    return ownLogLost(opened.db, new Set([...self, machineHostTag()]));
  } catch {
    return false;
  } finally {
    opened.close();
  }
}

/** Own logs whose incomplete read waits for a missing segment: doctor can name each without starting a catch-up. */
export function partialRecordLogChecks(): Check[] {
  if (indexMode() === 'off') return [];
  const opened = openIndexReadOnly();
  if (!opened.ok) return [];
  try {
    const self = opened.db.prepare('SELECT machine_id FROM machines WHERE is_self = 1').all() as { machine_id: string }[];
    return self.flatMap(({ machine_id: host }): Check[] => {
      const st = logState(opened.db, host);
      const missing = st?.partial ? [...missingRecordParts(host, st), ...segments(host).filter((s) => s.base && !wholeBase([s])).map((s) => s.name)] : [];
      if (!missing.length) return [];
      return [{ id: `sync-records-partial:${host}`, label: 'oak sync record log', level: 'warn',
        detail: `${path.join(rootDir(), 'records', host)} was read only in part; missing or incomplete: ${missing.join(', ')}. Compaction waits, so deleted sessions can still have text in this log.`,
        fix: 'Run `oak sync now` with every saved machine and the backup available, then `oak sessions`. Sync brings back the missing parts; if none holds a copy, the listing compacts what remains.' }];
    });
  } catch {
    return [];
  } finally {
    opened.close();
  }
}

// The store records a session in the index before OAK's cleanup removes it, and forgets one deleted on purpose, from
// whichever surface does it (store.ts), wherever this module is loaded: the CLI and the editors, never the capture hook.
setStoreIndexHooks({
  beforeCleanup: (ids, opts) => {
    indexBeforeCleanup(ids, opts);
  },
  forget: (id) => indexForget(id),
});

/** What `oak __usage-records` prints: this machine's own usage since a cursor (ingest.ts usageRecordsSince), from an index
 *  caught up as a listing would catch it up. A failure says why there is none (no index here). */
export function indexUsageRecords(since: string | null): UsageRecords | { usageRecords: 1; error: string } {
  const ix = useIndex({ kick: true });
  if (!ix.ok) return { usageRecords: 1, error: ix.reason };
  try {
    return usageRecordsSince(ix.db, since);
  } catch (e) {
    return { usageRecords: 1, error: String((e as Error)?.message || e) };
  } finally {
    ix.close();
  }
}

/** Whether this machine's index opens now (a usage pull applies into it): false without node:sqlite, and for a file a
 *  newer OAK wrote or one that is damaged. */
export function indexUsable(): boolean {
  const opened = openIndex();
  if (opened.ok) opened.close();
  return opened.ok;
}

/** A saved machine's usage pull answer, checked: null when the text is none (an older OAK, something else printed). */
export function parseUsageRecords(text: string): UsageRecords | { usageRecords: 1; error: string } | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (!v || v.usageRecords !== 1) return null;
    if (typeof v.error === 'string') return { usageRecords: 1, error: v.error };
    if (typeof v.host !== 'string' || typeof v.cursor !== 'string' || !Array.isArray(v.messages)) return null;
    const list = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter((r) => r && typeof r === 'object') as Record<string, unknown>[] : []);
    return { usageRecords: 1, host: v.host, hosts: Array.isArray(v.hosts) ? v.hosts.filter((h): h is string => typeof h === 'string') : [v.host], at: Number(v.at) || 0,
      cursor: v.cursor, more: v.more === true, messages: list(v.messages), readings: list(v.readings), spend: list(v.spend), accounts: list(v.accounts), billDays: list(v.billDays),
      purged: Array.isArray(v.purged) ? (v.purged as { session: string; at: number }[]) : [] };
  } catch {
    return null;
  }
}

/** Apply a usage pull's answer to this machine's index (ingest.ts applyUsageRecords); false where there is no index. */
export function indexApplyUsageRecords(a: UsageRecords, opts: { label: string; skewMs: number; now?: number }): boolean {
  const opened = openIndex();
  if (!opened.ok) return false;
  try {
    applyUsageRecords(opened.db, a, opts);
    return true;
  } catch {
    return false;
  } finally {
    opened.close();
  }
}

/** One saved machine's readings as this index holds them (usage.ts machineReadingEntries), for the saved machines' cache
 *  file, which a process with no index reads (machine-usage.ts). */
export function indexedMachineEntry(host: string): import('../machine-usage').MachineUsageEntry | null {
  const opened = openIndex();
  if (!opened.ok) return null;
  try {
    const e = machineReadingEntries(opened.db).find((x) => x.host === host);
    if (e) return e;
    // No reading measured there yet: the account it is signed in to, which its records say, and no window.
    const acct = (opened.db.prepare("SELECT account FROM accounts WHERE machine_id = ? AND agent = 'claude' ORDER BY last_ms DESC LIMIT 1").get(host) as { account: string } | undefined)?.account;
    return acct && /^[0-9a-f]{12}$/.test(acct)
      ? { label: host, target: '', skewMs: 0, rttMs: null, host, brief: { brief: 1, account: acct, at: 0, five: null, week: null, fable: null, month: null, own: null } }
      : null;
  } catch {
    return null;
  } finally {
    opened.close();
  }
}

/** Where the next usage pull of a machine starts; null where there is no index, or it was never pulled. */
export function usagePullCursor(host: string): string | null {
  const opened = openIndex();
  if (!opened.ok) return null;
  try {
    return ingestPullCursor(opened.db, host);
  } catch {
    return null;
  } finally {
    opened.close();
  }
}

/** How recently oak sync must have read a machine (its last run reaching it, ok) for its sessions to be listed from the
 *  local index rather than over ssh: two of its background runs. */
export const MACHINE_SESSIONS_FRESH_MS = 10 * 60_000;
/** A session active this recently may be running: its phase and workers are live, which records do not carry (its raised
 *  hand they do), so a machine with one is listed over ssh. The listing's own window for asking a session's phase. */
const LIVE_WINDOW_MS = 2 * 60 * 60_000;

/** A raised hand older than this no longer marks its machine as live: one whose session ended without lowering it (no
 *  SessionEnd) would keep that machine off the index until the session is archived. */
const HAND_WINDOW_MS = 24 * 60 * 60_000;

/** The newest write to `host`'s own transcripts and rollouts, as the last oak sync run that read it saw them, on that
 *  machine's clock with when that inventory was taken, and when it was kept here; by its file's stamp. */
const newestWrites = new Map<string, { stamp: string; newest: number; at: number; savedAt: number } | null>();
function newestWrite(host: string): { newest: number; at: number; savedAt: number } | null {
  const file = path.join((require('../sync-state') as typeof import('../sync-state')).syncDir(), 'index', `${host}.json`);
  let stamp: string;
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const memo = newestWrites.get(host);
  if (memo !== undefined && memo?.stamp === stamp) return memo;
  let out: { stamp: string; newest: number; at: number; savedAt: number } | null = null;
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as { savedAt?: unknown; inventory?: import('../sync').SyncInventory };
    const inv = kept.inventory;
    if (inv && typeof inv.at === 'number' && typeof kept.savedAt === 'number') {
      let newest = 0;
      // Its own files: a copy it keeps of another machine's session (`origin`) is that machine's work, not its own.
      for (const family of ['transcripts', 'rollouts']) for (const f of inv.families?.[family] ?? []) if (!f.origin && f.mtime > newest) newest = f.mtime;
      out = { stamp, newest, at: inv.at, savedAt: kept.savedAt };
    }
  } catch {
    out = null;
  }
  newestWrites.set(host, out);
  return out;
}

/** Whether the last oak sync run that read `host` saw one of its transcripts or rollouts written within LIVE_WINDOW_MS of
 *  now: that machine publishes its records from its own catch-ups, which can lag behind its files, and its inventory
 *  (each file's time on its clock, and when it was taken on the same clock) does not. True where there is none. */
function filesRecentlyWritten(host: string, now: number): boolean {
  const seen = newestWrite(host);
  if (!seen) return true;
  return seen.newest > 0 && seen.at - seen.newest + (now - seen.savedAt) <= LIVE_WINDOW_MS;
}

/**
 * `oak sessions --json --machine <label>` from the local index: the sessions that machine's record log holds, newest
 * first, in the listing's own shape (what that machine's `oak sessions --json` prints, less what only it can see now:
 * its current session, the phase of a session with no hand up, and running workers; a raised hand is the one its records
 * brought, and the phase follows it), with when its records arrived (`syncedAt`, the oak sync
 * run that last read it) and when it last published (`publishedAt`, that machine's clock). Only when those records are
 * current: oak sync reached that machine in the last MACHINE_SESSIONS_FRESH_MS and the index has read all of them, and
 * nothing there may be running: none of its sessions was active in the last two hours, as its records say and as the
 * files that run saw there say (filesRecentlyWritten), and none waits with a hand raised in the last day. Otherwise null,
 * and the caller
 * asks the machine over ssh. Its sessions oak sync brought here are listed too, as that machine lists them, and so is
 * `reviewing` (`--session`) when it is one of its sessions, whatever it is, as that machine lists it.
 */
export function indexedMachineSessions(label: string, now = Date.now(), reviewing: string | null = null): (import('../observe').SessionMeta & { fromIndex: true; host: string; syncedAt: number; publishedAt: number | null }) | null {
  if (indexMode() === 'off') return null;
  const fresh = freshlySynced(label, now);
  if (!fresh || filesRecentlyWritten(fresh.host, now)) return null;
  const ix = useIndex({ kick: true, workRefreshMs: LISTING_WORK_REFRESH_MS });
  if (!ix.ok) return null;
  try {
    if (!ix.catchUp.caughtUp) return null;
    // As that machine lists them (none of them running, none waiting on a person).
    const live = ix.db.prepare(`SELECT 1 FROM sessions s WHERE s.machine_id = ? AND s.origin IN ('synced', 'pulled') AND s.archived_ms IS NULL AND s.review = 0
      AND (max(s.last_active_ms, s.capture_ms) >= ? OR EXISTS (SELECT 1 FROM waits w WHERE w.machine_id = s.machine_id AND w.session_id = s.session_id AND w.end_ms IS NULL
      AND w.start_ms >= ?)) LIMIT 1`)
      .get(fresh.host, now - LIVE_WINDOW_MS, now - HAND_WINDOW_MS);
    if (live) return null;
    const published = (ix.db.prepare('SELECT synced_through_ms FROM machines WHERE machine_id = ?').get(fresh.host) as { synced_through_ms: number | null } | undefined)?.synced_through_ms ?? null;
    const { THIS_MACHINE } = require('../observe') as typeof import('../observe');
    return {
      active: null,
      sessions: syncedSessionRows(ix.db, fresh.host, true, reviewing).map((r) => syncedSessionRow(r, 'local', THIS_MACHINE)),
      fromIndex: true,
      host: fresh.host,
      syncedAt: fresh.at,
      publishedAt: published,
    };
  } catch {
    return null;
  } finally {
    ix.close();
  }
}

/** The saved machine an oak sync run read whole (`lastOkAt`: every pull from it done) in the last
 *  MACHINE_SESSIONS_FRESH_MS by `label`, whose records are here: its host and when that run began; else null. A later run
 *  that stopped, or reached it and failed a pull, leaves that time where it was. */
function freshlySynced(label: string, now: number): { host: string; at: number } | null {
  const status = (require('../sync-engine') as typeof import('../sync-engine')).readSyncStatusFile();
  const m = status?.machines.find((x) => x.label === label && typeof x.host === 'string');
  const at = m?.lastOkAt;
  if (!m?.host || typeof at !== 'number' || now - at > MACHINE_SESSIONS_FRESH_MS || !segments(m.host).length) return null;
  return { host: m.host, at };
}

/**
 * The agents a saved machine started from a brief, as its record log holds them (oak sync brought it): its own rows of
 * the `delegated` table, each as that machine last derived it (it derives them again before each oak sync run reads
 * it, publishRecords). Only when oak sync read it in the last MACHINE_SESSIONS_FRESH_MS and the index has read all of
 * its records; otherwise null, and the caller asks the machine over ssh.
 */
export function indexedMachineDelegated(label: string, now = Date.now()): { host: string; syncedAt: number; agents: import('../delegated').DelegatedAgent[] } | null {
  if (indexMode() === 'off') return null;
  const fresh = freshlySynced(label, now);
  if (!fresh) return null;
  const ix = useIndex({ kick: true });
  if (!ix.ok) return null;
  try {
    if (!ix.catchUp.caughtUp) return null;
    const { delegatedFromRow } = require('../delegated') as typeof import('../delegated');
    const rows = ix.db.prepare('SELECT * FROM delegated WHERE machine_id = ? ORDER BY started_ms DESC, id').all(fresh.host) as Record<string, unknown>[];
    return { host: fresh.host, syncedAt: fresh.at, agents: rows.map(delegatedFromRow) };
  } catch {
    return null;
  } finally {
    ix.close();
  }
}

/**
 * `oak search --machine <label>` from the local index: that machine's conversations searched from its records, as it
 * ranks them itself (listing.ts indexedMachineSearch), with when its records arrived (`syncedAt`). Only when oak sync read
 * it in the last MACHINE_SESSIONS_FRESH_MS and the index has read all of its records; otherwise null, and the caller asks
 * the machine over ssh. An ask typed there since that machine last published its records is not found until it publishes
 * them (at its next catch-up) and oak sync brings them.
 */
export function indexedMachineSearch(label: string, query: string, opts: { limit?: number; sinceMs?: number; perSession?: boolean } = {}, now = Date.now()):
  (import('../search').SearchResult & { fromIndex: true; host: string; syncedAt: number }) | null {
  if (indexMode() === 'off') return null;
  const fresh = freshlySynced(label, now);
  if (!fresh) return null;
  const ix = useIndex({ kick: true, workRefreshMs: LISTING_WORK_REFRESH_MS });
  if (!ix.ok) return null;
  try {
    if (!ix.catchUp.caughtUp) return null;
    return { ...searchMachineRecords(ix.db, fresh.host, query, opts), fromIndex: true, host: fresh.host, syncedAt: fresh.at };
  } catch {
    return null;
  } finally {
    ix.close();
  }
}

/**
 * `newestSessionGlobal`'s answer from the local index as the last catch-up left it: this machine's newest Claude
 * transcript (no mirrored copy, bridge pointer or deleted session), the newest of the 25 newest that holds an assistant
 * record, else the newest. Null when there is none; undefined where the index cannot be read here, and the caller walks
 * the transcripts as before. The terminal app's "a newer session is live" hint asks it outside any workspace.
 */
export function indexedNewestSession(): string | null | undefined {
  if (indexMode() === 'off') return undefined;
  const opened = openIndexReadOnly();
  if (!opened.ok) return undefined;
  try {
    // A deleted session is never chosen, even before the next catch-up forgets it.
    const hidden = hiddenSessions();
    const rows = (opened.db.prepare(`SELECT session_id, transcript_path FROM sessions WHERE origin IN ('local', 'pulled') AND archived_ms IS NULL AND listed = 1 AND facts IS NOT NULL
      AND agent = 'claude' AND rollout_path IS NULL AND transcript_path IS NOT NULL ORDER BY last_active_ms DESC, session_id LIMIT ?`).all(25 + hidden.size) as { session_id: string; transcript_path: string }[])
      .filter((r) => !hidden.has(r.session_id)).slice(0, 25);
    if (!rows.length) return null;
    const { hasAssistantRecord } = require('../session') as typeof import('../session');
    return (rows.find((r) => hasAssistantRecord(r.transcript_path)) ?? rows[0]).session_id;
  } catch {
    return undefined;
  } finally {
    opened.close();
  }
}

/**
 * This machine's session's asks and the answers to them as the local index keeps them, archived or not: what `oak
 * prompts` lists once the session's transcript is gone. Each ask carries the edits whose time falls in its window and the
 * tool calls made in it, as the index holds them; what only the transcript told (tokens, tasks, workers) is not kept.
 * Read as the last catch-up left it (openIndexReadOnly): a catch-up here would derive the store's Codex rollouts beside
 * the `oak sessions` the same refresh runs. Null where there is no index here, or it holds no ask of this session.
 */
export function indexedSessionPrompts(sessionId: string): { prompts: import('../prompts').SessionPrompt[]; responses: Map<string, string> } | null {
  if (indexMode() === 'off') return null;
  const ix = openIndexReadOnly();
  if (!ix.ok) return null;
  try {
    const self = 'machine_id IN (SELECT machine_id FROM machines WHERE is_self = 1) AND session_id = ?';
    const rows = ix.db.prepare(`SELECT idx, prompt_id, ts, end_ts, CAST(text AS BLOB) AS text, CAST(response AS BLOB) AS response FROM prompts WHERE ${self} ORDER BY idx`)
      .all(sessionId) as { idx: number; prompt_id: string | null; ts: number; end_ts: number; text: Uint8Array; response: Uint8Array }[];
    if (!rows.length) return null;
    const edits = ix.db.prepare(`SELECT id, ts, file, status FROM edits WHERE ${self} AND cleared_ms IS NULL`).all(sessionId) as { id: number; ts: number; file: string; status: string }[];
    const actions = ix.db.prepare(`SELECT ts, is_error FROM actions WHERE ${self}`).all(sessionId) as { ts: number; is_error: number }[];
    const { promptId } = require('../prompts') as typeof import('../prompts');
    const { graphemeHead } = require('../graphemes') as typeof import('../graphemes');
    const utf8 = (b: Uint8Array): string => Buffer.from(b).toString('utf8');
    const responses = new Map<string, string>();
    const prompts = rows.map((r) => {
      const ask = utf8(r.text);
      const id = r.prompt_id ?? promptId(r.ts, ask);
      responses.set(id, utf8(r.response));
      const inWindow = (ts: number): boolean => ts >= r.ts && (!r.end_ts || ts < r.end_ts);
      const mine = edits.filter((e) => inWindow(e.ts));
      const calls = actions.filter((a) => inWindow(a.ts));
      return {
        id, index: r.idx + 1, ts: r.ts, endTs: r.end_ts, text: ask, title: ask.length > 96 ? graphemeHead(ask, 95) + '…' : ask,
        editIds: mine.map((e) => e.id), edits: mine.length, added: 0, removed: 0,
        pending: mine.filter((e) => e.status === 'pending').length, kept: mine.filter((e) => e.status === 'kept').length,
        undone: mine.filter((e) => e.status !== 'pending' && e.status !== 'kept').length,
        files: new Set(mine.map((e) => e.file)).size, folders: new Set(mine.map((e) => path.dirname(e.file))).size,
        tokens: 0, tasks: 0, actions: calls.length, errors: calls.filter((a) => a.is_error).length,
        agents: [], workflows: [], processes: [], compactions: 0, durationMs: r.end_ts ? r.end_ts - r.ts : 0,
      };
    });
    return { prompts, responses };
  } catch {
    return null;
  } finally {
    ix.close();
  }
}

/** This machine's session listing composed from the index as the last catch-up left it (listing.ts indexedSessionMeta),
 *  for a host that never writes the index (VS Code's): what `oak sessions --json` lists while nothing changed since. Null
 *  where the index cannot be read here, and the caller lists the old way. */
export function readIndexedListing(cwd: string, reviewing?: string | null, opts: { includeEmpty?: boolean; includeReviews?: boolean } = {}): import('../observe').SessionMeta | null {
  if (indexMode() === 'off') return null;
  const opened = openIndexReadOnly();
  if (!opened.ok) return null;
  try {
    return indexedSessionMeta(opened.db, cwd, reviewing, opts);
  } catch {
    return null;
  } finally {
    opened.close();
  }
}

/** Each Codex rollout the index holds a session of this machine by (its own, or one oak sync pulled here), by its path
 *  (canonPath), with that session's id and the folder it ran in: what tells an editor whether a rollout's write concerns
 *  its workspace. */
export function indexedRollouts(db: DatabaseSync): Map<string, { id: string; cwd: string | null }> {
  const out = new Map<string, { id: string; cwd: string | null }>();
  for (const r of db.prepare("SELECT rollout_path, session_id, cwd FROM sessions WHERE rollout_path IS NOT NULL AND origin IN ('local', 'pulled')").all() as { rollout_path: string; session_id: string; cwd: string | null }[]) {
    out.set(canonPath(r.rollout_path), { id: r.session_id, cwd: r.cwd });
  }
  return out;
}

/** Every other machine's sessions this index holds from its records, by label (listing.ts indexedMachineListings), from
 *  an index already open: `oak sessions --json --synced` and the in-process readers share it. */
export function machineListings(db: DatabaseSync): MachineListing[] {
  if (indexMode() === 'off') return [];
  return indexedMachineListings(db, (require('../sync-engine') as typeof import('../sync-engine')).readSyncStatusFile());
}

/** Another machine's session of this repository, as its records hold it here: read-only (it is reviewed on its own
 *  machine). */
export interface RepoSessionElsewhere {
  id: string;
  title: string | null;
  agent: string;
  model: string;
  workspace: string;
  lastMs: number;
  edits: number;
  pending: number;
  /** The label this machine knows its machine by (`--machine` takes a saved one), and that machine's id. */
  machine: string;
  host: string;
  readOnly: true;
}

/** Other machines' sessions of the git repository `cwd` is in (its identity key, a subfolder's included), as their records
 *  hold them in the local index once it is caught up (none archived, no Auto-review thread), newest first, each machine
 *  with when oak sync last brought its records: what `oak siblings --repo` lists beside this machine's own. Empty outside
 *  a repository, and where there is no index. */
export function repoSessionsElsewhere(cwd: string): { machine: string; host: string; syncedAt: number | null; sessions: RepoSessionElsewhere[] }[] {
  if (indexMode() === 'off') return [];
  let key: string;
  try {
    key = identityKey(cwd, { home: os.homedir(), shares: readMountTable() }).key;
  } catch {
    return [];
  }
  if (!key.startsWith('git:')) return [];
  const repo = key.split('//')[0];
  const ix = useIndex({});
  if (!ix.ok) return [];
  try {
    const rows = ix.db.prepare(`SELECT s.machine_id AS host, coalesce(m.saved_label, m.label, s.machine_id) AS machine, max(s.synced_ms) OVER (PARTITION BY s.machine_id) AS landed,
        s.session_id AS id, s.title, s.agent, s.model, s.workspace, s.last_active_ms AS lastMs, s.edits, s.pending
      FROM sessions s LEFT JOIN machines m ON m.machine_id = s.machine_id
      WHERE s.origin = 'synced' AND s.archived_ms IS NULL AND s.review = 0 AND coalesce(m.is_self, 0) = 0 AND (s.project_key = ? OR substr(s.project_key, 1, ?) = ?)
      ORDER BY s.last_active_ms DESC, s.session_id`).all(repo, repo.length + 2, `${repo}//`) as unknown as (Omit<RepoSessionElsewhere, 'readOnly'> & { landed: number | null })[];
    const status = (require('../sync-engine') as typeof import('../sync-engine')).readSyncStatusFile();
    const out = new Map<string, { machine: string; host: string; syncedAt: number | null; sessions: RepoSessionElsewhere[] }>();
    for (const { landed, ...r } of rows) {
      let m = out.get(r.host);
      if (!m) {
        const run = status?.machines.find((x) => x.host === r.host);
        out.set(r.host, (m = { machine: r.machine, host: r.host, syncedAt: run?.lastOkAt ?? landed ?? null, sessions: [] }));
      }
      m.sessions.push({ ...r, readOnly: true });
    }
    return [...out.values()];
  } catch {
    return [];
  } finally {
    ix.close();
  }
}

/** Other machines' raised hands as their records brought them (listing.ts syncedHands), from the index as the last
 *  catch-up left it: what `oak sessions --json` adds as `syncedHands`, so every surface that polls the listing lists and
 *  announces them, and what `oak notify --watch` announces. Empty where there is no index. */
export function readSyncedHands(now = Date.now(), includeDone = true): import('../notify').InboxRow[] {
  if (indexMode() === 'off') return [];
  const opened = openIndexReadOnly();
  if (!opened.ok) return [];
  try {
    return syncedHands(opened.db, now, includeDone, (require('../sync-engine') as typeof import('../sync-engine')).readSyncStatusFile());
  } catch {
    return []; // an index this build does not read yet (its next catch-up migrates it)
  } finally {
    opened.close();
  }
}

/** The same, for a host that reads the index in-process and never writes it (VS Code's extension host): from the index as
 *  the last catch-up left it (openIndexReadOnly). Null where that cannot be read (no node:sqlite with FTS5, no index yet,
 *  one this build does not read), and where another machine's record log holds what the index has not read yet (an oak
 *  sync run brought it since): the caller asks the CLI (`oak sessions --json --synced`), which catches the index up
 *  first. */
export function readMachineListings(): MachineListing[] | null {
  if (indexMode() === 'off') return null;
  const opened = openIndexReadOnly();
  if (!opened.ok) return null;
  try {
    const self = new Set((opened.db.prepare('SELECT machine_id FROM machines WHERE is_self = 1').all() as { machine_id: string }[]).map((m) => m.machine_id));
    for (const host of recordHosts()) {
      if (self.has(host)) continue;
      const plan = logPlan(host, logState(opened.db, host));
      if (plan.reset || plan.steps.length) return null;
    }
    return machineListings(opened.db);
  } catch {
    return null;
  } finally {
    opened.close();
  }
}

(require('../codex') as typeof import('../codex')).setGptDatabaseReader(() => {
  const ix = openIndex();
  if (!ix.ok) return null;
  try {
    carryArchive(ix.db, ix.file);
    const codex = require('../codex') as typeof import('../codex');
    catchUpUsage(ix.db);
    for (const rollout of codex.recentCodexRollouts()) {
      const meta = codex.codexRolloutHead(rollout)?.meta;
      const session = meta?.id ?? meta?.session_id;
      if (typeof session === 'string') catchUpUsage(ix.db, { session, rollout });
    }
    if (Date.now() - Number(getMeta(ix.db, 'caught_up_ms') ?? 0) > USAGE_SWEEP_MS) kickIndexBuild();
    return { db: ix.db, account: codexAccountOf(ix.db), close: ix.close, cycle: (month, week, now) => codexWindowTotals(ix.db, month, week, now) };
  } catch { ix.close(); return null; }
});
