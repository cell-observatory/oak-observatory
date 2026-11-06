/**
 * The local index's SQLite: Node's built-in `node:sqlite`, so the index adds no native dependency. It is loaded only
 * when the index is first asked for, never when core loads: the capture hook never opens SQLite, and an editor host
 * whose Node has no `node:sqlite` (VS Code's, for one) loads core as before and reads without the index.
 *
 * The index needs FTS5. Node 22.13 to 22.15 ship a SQLite without it (22.16 is the first 22.x with it), no Node 23
 * release ships one with it, and 24 and later all do (INDEX_NODES). A Node built against the system's SQLite has
 * whatever that one has, so it is probed rather than assumed from the version.
 * When `node:sqlite` is missing, or its SQLite has no FTS5, the index is unavailable: every caller keeps the path it
 * had before the index existed, and nothing fails.
 *
 * Node 22 prints an ExperimentalWarning the first time `node:sqlite` is loaded. The terminal app shares its terminal
 * with stderr, where that line would land on its frame, so exactly that warning is dropped while the module loads.
 * Every other warning still prints.
 */
import type * as Sqlite from 'node:sqlite';

/** The oldest Node whose bundled SQLite has FTS5 (22.13 to 22.15 do not). */
export const INDEX_NODE_FLOOR = '22.16.0';

/** The Node releases that run the index, as their own builds decide it (probed on 22.13, 22.15, 22.16 and 22.23, on
 *  every 23 release, and on the first and latest 24, 25 and 26): 22.16 and the 22 releases after it, and 24 and later.
 *  No 23 release does: its SQLite has no FTS5, that of 23.11 (the first 23 with StatementSync.columns) included.
 *  `engines` in the CLI's package.json and the install checks say the same. */
export const INDEX_NODES = 'Node.js 22 (22.16 or newer) or 24 or newer';

/** Whether a Node release runs the index, by its version (`v24.1.0` or `24.1.0`; INDEX_NODES): what the install
 *  checks and `oak machine add` ask of a Node they cannot probe. Kept beside the index's location, which loads nothing
 *  that reads SQLite, for the capture hooks' kick. */
export { nodeRunsIndex } from './location';

export interface IndexRuntime {
  ok: true;
  sqlite: typeof Sqlite;
  /** The SQLite library's version, as `sqlite_version()` answers. */
  sqliteVersion: string;
  /** `DatabaseSync.setAuthorizer` (Node 24.10 and later): raw SQL is checked by SQLite's authorizer, not only by keyword. */
  authorizer: boolean;
}

export interface IndexUnavailable {
  ok: false;
  /** Why, in a sentence a person can act on. */
  reason: string;
  /** The file was written by a newer OAK, which this one leaves alone: an update, not a newer Node, is what helps. */
  newer?: true;
  /** This Node can run the index, but its file could not be opened (not one written by a newer OAK). */
  damaged?: boolean;
}

let memo: IndexRuntime | IndexUnavailable | null = null;

/** Load `id` while dropping only SQLite's ExperimentalWarning, which Node 22 emits as the module loads. */
function requireQuietly<T>(id: string): T {
  const emit = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]): void {
    const opt = rest[0];
    const type = typeof opt === 'string' ? opt : opt && typeof opt === 'object' ? (opt as { type?: unknown }).type : undefined;
    const name = typeof warning === 'object' && warning ? warning.name : type;
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if ((type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && /\bSQLite\b/.test(text)) return;
    return (emit as (...a: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return require(id) as T;
  } finally {
    process.emitWarning = emit;
  }
}

/** Whether this Node can run the index, and its SQLite when it can. Probed once per process. */
export function indexRuntime(): IndexRuntime | IndexUnavailable {
  if (memo) return memo;
  if (process.env.OAK_INDEX === 'off') return { ok: false, reason: 'the database is turned off (OAK_INDEX=off)' };
  let sqlite: typeof Sqlite;
  try {
    sqlite = requireQuietly<typeof Sqlite>(process.env.OAK_INDEX_TEST_MODULE || 'node:sqlite');
  } catch {
    return (memo = { ok: false, reason: `this Node (${process.version}) has no node:sqlite; the database needs ${INDEX_NODES}` });
  }
  let sqliteVersion = '';
  try {
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      sqliteVersion = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: unknown }).v);
      db.exec("CREATE VIRTUAL TABLE probe USING fts5(a, tokenize='unicode61 remove_diacritics 2'); INSERT INTO probe(probe, rank) VALUES ('secure-delete', 1); INSERT INTO probe(a) VALUES ('oak probe')");
      const hit = db.prepare("SELECT count(*) AS n FROM probe WHERE probe MATCH 'probe'").get() as { n: number };
      if (hit.n !== 1) throw new Error('FTS5 did not find its own row');
    } finally {
      db.close();
    }
  } catch (e) {
    return (memo = {
      ok: false,
      reason: `the SQLite in this Node (${process.version}${sqliteVersion ? `, SQLite ${sqliteVersion}` : ''}) has no full-text search (FTS5): ${String((e as Error)?.message || e)}; the database needs ${INDEX_NODES}`,
    });
  }
  // A Node built against the system's SQLite can have FTS5 where its release's own has none, with the node:sqlite of
  // its release: one before 22.16 (or before 23.11 on 23) has no StatementSync.columns, which every query reads with.
  if (typeof (sqlite.StatementSync?.prototype as { columns?: unknown } | undefined)?.columns !== 'function') {
    return (memo = { ok: false, reason: `the node:sqlite in this Node (${process.version}) is older than the database reads with (no StatementSync.columns); the database needs ${INDEX_NODES}` });
  }
  const authorizer = typeof (sqlite.DatabaseSync.prototype as { setAuthorizer?: unknown }).setAuthorizer === 'function';
  return (memo = { ok: true, sqlite, sqliteVersion, authorizer });
}

/** Forget the probe (tests switch OAK_INDEX in-process). */
export function resetIndexRuntime(): void {
  memo = null;
}
