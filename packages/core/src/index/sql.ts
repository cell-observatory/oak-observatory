/**
 * Read-only SQL over the index (`oak query sql`), guarded in layers, because a read-only connection is not a sandbox:
 * on one, ATTACH still opens another database and VACUUM INTO still writes a copy of this one.
 *
 * 1. The statement runs in a CHILD process, killed with SIGKILL at the deadline. node:sqlite has no interrupt, and a
 *    timer in the same process never fires while a query runs (one ran 59.8 s past it). The child also ends itself a
 *    second after the deadline, from a worker thread's timer, which does fire: a parent killed while it waited (an
 *    editor cancelling the CLI) left a runaway query spinning with no one to stop it.
 * 2. The connection is read-only and `PRAGMA query_only` is set, which refuses every write; VACUUM INTO then fails
 *    before it copies anything, though SQLite still creates its empty target file (checked on SQLite 3.51 and 3.53),
 *    which is one reason the next two guards refuse such a statement before it runs.
 * 3. One statement only: `prepare` compiles the first and ignores the rest, so the text after it (`sourceSQL` ends where
 *    it does) must be nothing but spaces, semicolons and comments.
 * 4. A statement that returns no columns is refused: ATTACH, DETACH, VACUUM, a pragma that sets something.
 * 5. With Node 24.10 or newer, SQLite's authorizer allows reading and nothing else (SQLite never consults it for
 *    VACUUM, which guards 2 and 4 stop). A keyword check runs on every Node, and stands in for the authorizer on older
 *    ones: the statement must start SELECT, WITH, VALUES or EXPLAIN and name no statement that changes anything.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { indexRuntime } from './runtime';
import { BUSY_TIMEOUT_MS } from './db';
import { QueryError } from './query';
import { spawnToolSync } from '../spawn';

export interface SqlRequest {
  file: string;
  sql: string;
  params?: SQLInputValue[];
  limit: number;
  arrays?: boolean;
  /** The parent's deadline: the child ends itself a second after it (sqlChildWatchdog). */
  deadlineMs?: number;
  /** The most bytes of JSON the rows may come to (MAX_RESULT_BYTES unless a test sets less). */
  maxBytes?: number;
}

/** How long after the deadline the child ends itself, should the parent that was to stop it be gone. */
const WATCHDOG_GRACE_MS = 1000;
/** The most an answer's rows come to, as JSON: past it they are cut, as the row limit cuts them. Uncut, 100,000 rows of
 *  8 KB took the child to 1.5 GB and ended in a string too long to build, answered as "nothing usable". */
export const MAX_RESULT_BYTES = 128 * 1024 * 1024;
/** The longest text or blob a statement may build (SQLite's length limit, on a Node that can set it): three 900 MB
 *  zeroblobs in one row took the child to 7 GB before its deadline. */
const MAX_VALUE_BYTES = 64 * 1024 * 1024;

/**
 * In the child: SIGKILL this process `deadlineMs` (plus a grace) from now, from a worker thread, whose timer fires while
 * the main thread is held in a SQLite step. Unreferenced, so a query that ends in time exits at once.
 */
export function sqlChildWatchdog(deadlineMs: number): void {
  const ms = Math.ceil(deadlineMs) + WATCHDOG_GRACE_MS;
  const { Worker } = require('worker_threads') as typeof import('worker_threads');
  const w = new Worker(`setTimeout(() => process.kill(${process.pid}, 'SIGKILL'), ${ms});`, { eval: true });
  w.unref();
}

export type SqlResult =
  | { ok: true; columns: string[]; rows: unknown[]; truncated: boolean; guard: 'authorizer' | 'keywords'; cutAtBytes?: number }
  | { ok: false; code: 'unsafe_sql' | 'sql_error' | 'index_unavailable' | 'timeout'; message: string };

/** The text with its comments, string literals and quoted names blanked out, so a keyword inside one is not read. */
export function sqlWords(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) { j = sql.length; break; }
        if (close !== ']' && sql[k + 1] === close) { j = k + 2; continue; } // a doubled quote is the quote itself
        j = k + 1;
        break;
      }
      out += c === "'" ? " '' " : ' x ';
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const FIRST = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN']);
const NEVER = new Set(['ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'REINDEX', 'ANALYZE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);

/** The keyword check that stands in for the authorizer: throws `unsafe_sql` naming what it refused. */
export function checkSqlKeywords(sql: string): void {
  const text = sqlWords(sql);
  const words: string[] = text.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g) ?? [];
  if (!words.length || !FIRST.has(words[0])) throw new QueryError('unsafe_sql', 'only a read (SELECT, WITH, VALUES or EXPLAIN) can run');
  for (const w of words) if (NEVER.has(w)) throw new QueryError('unsafe_sql', `${w} is refused: only reads can run`);
  // REPLACE the statement (never `replace(` the function) and loading an extension.
  if (/\bREPLACE\b(?!\s*\()/i.test(text)) throw new QueryError('unsafe_sql', 'REPLACE is refused: only reads can run');
  if (/\bLOAD_EXTENSION\s*\(/i.test(text)) throw new QueryError('unsafe_sql', 'load_extension is refused');
}

/** The text after the first statement must be nothing but spaces, semicolons and comments. */
export function checkOneStatement(sql: string, compiled: string): void {
  const at = sql.indexOf(compiled);
  const rest = at >= 0 ? sql.slice(at + compiled.length) : sql.slice(compiled.length);
  if (sqlWords(rest).replace(/[\s;]/g, '') !== '') throw new QueryError('unsafe_sql', 'one statement only: the text after the first statement was refused');
}

/** Which guards run: all of them, always, for `oak query sql`. A test turns one or more off, in-process only, to show
 *  that each of the others holds on its own; the child's request carries no such switch. */
export interface SqlGuards {
  keywords?: boolean;
  authorizer?: boolean;
  queryOnly?: boolean;
  oneStatement?: boolean;
  zeroColumns?: boolean;
}

/** Run one guarded read against the index file: what the child process does. */
export function runGuardedSql(req: SqlRequest, guards: SqlGuards = {}): SqlResult {
  const on = (g: keyof SqlGuards): boolean => guards[g] !== false;
  const rt = indexRuntime();
  if (!rt.ok) return { ok: false, code: 'index_unavailable', message: rt.reason };
  let db: DatabaseSync | null = null;
  try {
    if (on('keywords')) checkSqlKeywords(req.sql);
    db = new rt.sqlite.DatabaseSync(req.file, { readOnly: true, timeout: BUSY_TIMEOUT_MS, limits: { length: MAX_VALUE_BYTES } } as never);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (on('queryOnly')) db.exec('PRAGMA query_only = 1');
    let guard: 'authorizer' | 'keywords' = 'keywords';
    if (rt.authorizer && on('authorizer')) {
      const c = rt.sqlite.constants as unknown as Record<string, number>;
      const allowed = new Set([c.SQLITE_SELECT, c.SQLITE_READ, c.SQLITE_FUNCTION, c.SQLITE_RECURSIVE]);
      (db as unknown as { setAuthorizer(fn: (action: number, a1: string | null, a2: string | null) => number): void }).setAuthorizer((action, _a1, a2) =>
        allowed.has(action) && !(action === c.SQLITE_FUNCTION && /^load_extension$/i.test(a2 ?? '')) ? c.SQLITE_OK : c.SQLITE_DENY);
      guard = 'authorizer';
    }
    let stmt;
    try {
      stmt = db.prepare(req.sql);
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      return /not authorized/i.test(msg) ? { ok: false, code: 'unsafe_sql', message: `refused: ${msg}` } : { ok: false, code: 'sql_error', message: msg };
    }
    if (on('oneStatement')) checkOneStatement(req.sql, stmt.sourceSQL);
    const columns = stmt.columns().map((x) => x.name);
    if (!columns.length && on('zeroColumns')) return { ok: false, code: 'unsafe_sql', message: 'a statement that returns no columns is refused (only reads can run)' };
    const rows: unknown[] = [];
    let truncated = false;
    let bytes = 0;
    const maxBytes = req.maxBytes ?? MAX_RESULT_BYTES;
    const params = req.params ?? [];
    for (const row of stmt.iterate(...params) as Iterable<Record<string, unknown>>) {
      if (rows.length >= req.limit) {
        truncated = true;
        break;
      }
      const vals = columns.map((name) => {
        const v = row[name];
        return v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? v.toString() : v;
      });
      const out = req.arrays ? vals : Object.fromEntries(columns.map((name, i) => [name, vals[i]]));
      bytes += JSON.stringify(out).length;
      if (bytes > maxBytes) return { ok: true, columns, rows, truncated: true, guard, cutAtBytes: maxBytes };
      rows.push(out);
    }
    return { ok: true, columns, rows, truncated, guard };
  } catch (e) {
    if (e instanceof QueryError) return { ok: false, code: e.code === 'unsafe_sql' ? 'unsafe_sql' : 'sql_error', message: e.message };
    return { ok: false, code: 'sql_error', message: String((e as Error)?.message || e) };
  } finally {
    try {
      db?.close();
    } catch {
      /* closed */
    }
  }
}

/** Run a guarded read in a child process (`entry` is the oak CLI, which answers `__query-sql`), killed at the deadline. */
export function runSqlInChild(req: SqlRequest, opts: { entry: string; deadlineMs: number }): SqlResult {
  const r = spawnToolSync(process.execPath, [opts.entry, '__query-sql'], {
    input: JSON.stringify({ ...req, deadlineMs: opts.deadlineMs } satisfies SqlRequest),
    encoding: 'utf8',
    timeout: opts.deadlineMs,
    killSignal: 'SIGKILL',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, OAK_NO_BACKGROUND: '1' },
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL') {
    return { ok: false, code: 'timeout', message: `the query ran past its ${opts.deadlineMs} ms deadline and was stopped` };
  }
  if (r.error) return { ok: false, code: 'sql_error', message: `the query's process failed: ${r.error.message}` };
  try {
    return JSON.parse(r.stdout) as SqlResult;
  } catch {
    return { ok: false, code: 'sql_error', message: `the query's process answered nothing usable${r.stderr ? `: ${r.stderr.trim().split('\n').pop()}` : ''}` };
  }
}
