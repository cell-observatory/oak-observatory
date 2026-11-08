/**
 * Opening the index and writing to it.
 *
 * - The file is created 0600 in a 0700 folder before SQLite opens it, so the write-ahead log and shared-memory files
 *   SQLite makes beside it take the same mode. `PRAGMA secure_delete` zeroes what a delete frees.
 * - Every write runs in `BEGIN IMMEDIATE` with a busy timeout: a deferred BEGIN that later needs the write lock fails
 *   with SQLITE_BUSY rather than waiting (826 of 1,600 transactions did, with 16 writers). Writers keep each
 *   transaction small (ingest.ts: at most 5,000 rows or about 50 ms) so a reader never waits long.
 * - One process at a time catches the index up: it holds the lease, a row that names it and expires, which a process
 *   that has died, or stopped renewing, loses. Any other reader answers from what is there and says so (`caughtUp`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { indexRuntime, type IndexUnavailable } from './runtime';
import { indexFile, indexFiles } from './location';
import { migrate, needsMigration, IndexTooNewError, tableColumns, SCHEMA_VERSION, INGEST_VERSION } from './schema';
import { pidAlive } from '../daemon';

/** How long a writer waits for another's transaction before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;
/** How long a catch-up's lease lasts without renewal. */
export const LEASE_MS = 30_000;

export interface IndexHandle {
  ok: true;
  db: DatabaseSync;
  file: string;
  close(): void;
}

export type OpenResult = IndexHandle | IndexUnavailable;

/** Make the folder 0700 and the file 0600 before SQLite opens it. */
function prepareFile(file: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* not ours to change (a shared parent); the file's own mode still holds */
  }
  try {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/**
 * Open this store's index for reading and writing, creating and migrating it as needed. Unavailable (never a throw)
 * when this Node cannot run it, when the file was written by a newer OAK, or when it cannot be opened at all.
 */
export function openIndex(file: string = indexFile()): OpenResult {
  const rt = indexRuntime();
  if (!rt.ok) return rt;
  let db: DatabaseSync | null = null;
  try {
    prepareFile(file);
    db = new rt.sqlite.DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS } as never);
    // Node before 22.16 ignores the timeout option (22.13 to 22.15 fail at once); the pragma holds on every release.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Changing journal mode can return SQLITE_BUSY without calling SQLite's busy handler (another opener holds a
    // reserved lock). Retry that transition too, sharing one timeout even when SQLite itself waits on an attempt.
    const deadline = performance.now() + BUSY_TIMEOUT_MS;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.ceil(deadline - performance.now()))}`);
      try {
        db.exec('PRAGMA journal_mode = WAL');
        break;
      } catch (e) {
        const remaining = deadline - performance.now();
        if ((Number((e as { errcode?: number })?.errcode) & 0xff) !== 5 || remaining <= 0) throw e;
        Atomics.wait(pause, 0, 0, Math.min(10, remaining));
      }
    }
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA secure_delete = ON');
    db.exec('PRAGMA temp_store = MEMORY');
    const handle = db;
    // The write lock only when there is something to migrate: a reader never waits for another process's transaction
    // (a catch-up's) just to learn the file is current. A file a newer OAK wrote (its schema or its facts) throws here.
    if (needsMigration(handle)) write(handle, () => migrate(handle));
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        if ((fs.statSync(f).mode & 0o077) !== 0) fs.chmodSync(f, 0o600);
      } catch {
        /* not there (yet) */
      }
    }
    return { ok: true, db, file, close: () => { try { handle.close(); } catch { /* already closed */ } } };
  } catch (e) {
    try {
      db?.close();
    } catch {
      /* the open itself failed */
    }
    if (e instanceof IndexTooNewError) return { ok: false, reason: e.message, newer: true };
    return { ok: false, ...(isCorrupt(e) ? { damaged: true } : {}), reason: `the database at ${file} could not be opened: ${String((e as Error)?.message || e)}` };
  }
}

/**
 * Open this store's index to read it as the last catch-up left it, for a process that never writes it (VS Code's
 * extension host, whose catch-ups run in the CLI): read-only, `query_only`, no migration and no catch-up. Unavailable
 * where this Node cannot run the index, where there is no index yet, and where the file's schema or facts are not this
 * build's (an older file is migrated by the next catch-up; a newer one belongs to a newer OAK).
 */
export function openIndexReadOnly(file: string = indexFile()): OpenResult {
  const rt = indexRuntime();
  if (!rt.ok) return rt;
  if (!fs.existsSync(file)) return { ok: false, reason: `there is no database at ${file} yet` };
  let db: DatabaseSync | null = null;
  try {
    db = new rt.sqlite.DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS } as never);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA query_only = 1');
    const at = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const ingest = Number((db.prepare("SELECT value FROM meta WHERE key = 'ingest_version'").get() as { value: string } | undefined)?.value ?? 0);
    if (at !== SCHEMA_VERSION || ingest !== INGEST_VERSION) throw new Error(`its schema ${at} and facts ${ingest} are not this build's (${SCHEMA_VERSION}, ${INGEST_VERSION})`);
    const handle = db;
    return { ok: true, db, file, close: () => { try { handle.close(); } catch { /* already closed */ } } };
  } catch (e) {
    try {
      db?.close();
    } catch {
      /* the open itself failed */
    }
    return { ok: false, reason: `the database at ${file} could not be read: ${String((e as Error)?.message || e)}` };
  }
}

/** SQLite said the file is damaged or no database at all (SQLITE_CORRUPT, SQLITE_NOTADB), not that it is busy, full or
 *  out of reach. */
export function isCorrupt(e: unknown): boolean {
  const code = Number((e as { errcode?: unknown } | null)?.errcode) & 0xff;
  return code === 11 || code === 26;
}

/** Run `fn` in one write transaction (BEGIN IMMEDIATE), rolled back if it throws. */
export function write<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction is already gone */
    }
    throw e;
  }
}

/** This process's lease holder name. */
export const LEASE_HOLDER = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

/**
 * Take the catch-up lease if nobody holds it: a holder that is this process, an expired one, or one whose process is
 * gone does not count. False at once when another live process holds it: the caller answers from what is there.
 */
export function tryLease(db: DatabaseSync, now = Date.now(), holder = LEASE_HOLDER): boolean {
  try {
    return write(db, () => {
      const row = db.prepare('SELECT holder, pid, until_ms FROM lease WHERE id = 1').get() as { holder: string | null; pid: number | null; until_ms: number | null } | undefined;
      if (row?.holder && row.holder !== holder && (row.until_ms ?? 0) >= now && row.pid !== null && pidAlive(row.pid)) return false;
      db.prepare('UPDATE lease SET holder = ?, pid = ?, until_ms = ? WHERE id = 1').run(holder, process.pid, now + LEASE_MS);
      return true;
    });
  } catch {
    return false; // busy past the timeout: someone is writing; read what is there
  }
}

/** Extend a lease this process holds; false when it was lost (expired and taken). */
export function renewLease(db: DatabaseSync, now = Date.now(), holder = LEASE_HOLDER): boolean {
  try {
    const r = db.prepare('UPDATE lease SET until_ms = ? WHERE id = 1 AND holder = ?').run(now + LEASE_MS, holder);
    return Number(r.changes) === 1;
  } catch {
    return false;
  }
}

export function releaseLease(db: DatabaseSync, holder = LEASE_HOLDER): void {
  try {
    db.prepare('UPDATE lease SET holder = NULL, pid = NULL, until_ms = NULL WHERE id = 1 AND holder = ?').run(holder);
  } catch {
    /* it expires */
  }
}

/** Ask the process that holds the lease to hand it over at its next session: OAK's own cleanup, which must record a
 *  session before it removes it, asks rather than wait out a whole build. The request lapses at `until`. */
export function wantLease(db: DatabaseSync, until: number, holder = LEASE_HOLDER): void {
  try {
    write(db, () => setMeta(db, 'lease_wanted', `${holder} ${until}`));
  } catch {
    /* busy: the caller still waits for the lease */
  }
}

/** Whether another process has asked for the lease (`wantLease`) and its request has not lapsed. */
export function leaseWanted(db: DatabaseSync, now = Date.now(), holder = LEASE_HOLDER): boolean {
  try {
    const [who, until] = (getMeta(db, 'lease_wanted') ?? '').split(' ');
    return !!who && who !== holder && Number(until) > now;
  } catch {
    return false;
  }
}

export function unwantLease(db: DatabaseSync, holder = LEASE_HOLDER): void {
  try {
    db.prepare("DELETE FROM meta WHERE key = 'lease_wanted' AND value LIKE ?").run(`${holder} %`);
  } catch {
    /* it lapses */
  }
}

/** The holder of the lease right now, if a live one does. */
export function leaseHolder(db: DatabaseSync, now = Date.now()): { pid: number; untilMs: number } | null {
  try {
    const row = db.prepare('SELECT holder, pid, until_ms FROM lease WHERE id = 1').get() as { holder: string | null; pid: number | null; until_ms: number | null } | undefined;
    if (!row?.holder || (row.until_ms ?? 0) < now || row.pid === null || !pidAlive(row.pid)) return null;
    return { pid: row.pid, untilMs: row.until_ms ?? 0 };
  } catch {
    return null;
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** After a deliberate delete: copy the write-ahead log into the file, whose freed pages secure_delete zeroes, and empty
 *  it. Otherwise the pages the session was written in stay in the log until they are overwritten, for as long as any
 *  process (the terminal app's worker, an editor) keeps the index open. Best effort: a reader inside a transaction
 *  holds the log until it ends, and the next delete or close truncates it. */
export function forgetInLog(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* busy: the next checkpoint copies it */
  }
}

/** The rows of the sessions `ids` name, as a WHERE term and its one argument: `session_id = ?` for one session, a JSON
 *  list for several, so that each table is scanned once for all of them (no index leads with the session). */
export function ofSessions(ids: readonly string[]): [string, string] {
  return ids.length === 1 ? ['session_id = ?', ids[0]] : ['session_id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)];
}

/** A deliberate delete reaches every index file in the folder, not only the current one: a superseded format's file is
 *  kept until `oak clean` removes it, and held the session's text until then. Each file's own tables that name a
 *  session lose its rows (their full-text entries go with them, by that file's triggers); `machine`, another machine's
 *  delete (its record log forgot the sessions), only that machine's rows. Best effort: a file that cannot be opened is
 *  left as it was. */
export function forgetElsewhere(ids: readonly string[], current: string = indexFile(), machine?: string): void {
  const rt = indexRuntime();
  if (!rt.ok || !ids.length) return;
  for (const f of indexFiles()) {
    if (f.file === current) continue;
    let db: DatabaseSync | null = null;
    try {
      const other = (db = new rt.sqlite.DatabaseSync(f.file, { timeout: BUSY_TIMEOUT_MS } as never));
      other.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      other.exec('PRAGMA secure_delete = ON');
      const tables = (other.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((t) => ({ name: t.name, cols: tableColumns(other, t.name) })).filter((t) => t.cols.includes('session_id'));
      const [where, arg] = ofSessions(ids);
      write(other, () => {
        for (const t of tables) {
          if (machine === undefined) other.prepare(`DELETE FROM "${t.name}" WHERE ${where}`).run(arg);
          else if (t.cols.includes('machine_id')) other.prepare(`DELETE FROM "${t.name}" WHERE machine_id = ? AND ${where}`).run(machine, arg);
        }
      });
      forgetInLog(other);
    } catch {
      /* left as it was */
    } finally {
      try {
        db?.close();
      } catch {
        /* closed */
      }
    }
  }
}

/** `PRAGMA data_version`: changes whenever another connection commits to the file, so a long-lived reader knows when
 *  to ask again without watching any file. */
export function dataVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
}
