/**
 * The archive across index files. Archived sessions, and what only the index holds of sessions that are not archived
 * (records `oak clean --resolved` dropped from a log, review comments, a conversation whose file has gone while its
 * session's store stays), are what the files on disk no longer hold, so a new index file (a new format, or the store
 * moved) cannot rebuild them from the sources. Before the new file is written to, their rows are copied from the
 * previous one (by the columns both files have), with the deliberate-delete tombstones, archived notes, and the line
 * counts their edits name. The copy is verified by counting, and recorded in the new file; the previous file is kept,
 * and `oak clean` removes it only once the file that copied it says the copy was verified.
 *
 * The archive's source of truth is now this machine's record log (records.ts), which a new index file reads back. This
 * copy predates the log, and stays until a release has published every archive to one.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { indexRuntime } from './runtime';
import { indexFiles, INDEX_FORMAT } from './location';
import { getMeta, setMeta, write } from './db';
import { SESSION_TABLES, tableColumns } from './schema';
import { TX_ROWS } from './ingest';

export interface CarryResult {
  from: string | null;
  sessions: number;
  rows: number;
  verified: boolean;
  problem?: string;
}

/** The index file a new one carries the archive from: the newest other file of the same store (an earlier format), else
 *  the newest of another store (the store moved). Never a file of a newer format: that is a newer OAK's, still in use,
 *  which this one leaves alone. */
export function previousIndexFile(current: string): string | null {
  const key = /-([0-9a-f]{16})\.sqlite$/.exec(path.basename(current))?.[1];
  const others = indexFiles().filter((f) => f.file !== current && f.format <= INDEX_FORMAT);
  return (others.find((f) => f.key === key) ?? others[0])?.file ?? null;
}

/** Copy the archive from the previous index file into `db` (the file at `current`), once. */
export function carryArchive(db: DatabaseSync, current: string, from: string | null = previousIndexFile(current)): CarryResult {
  const done = getMeta(db, 'archive_carried_from');
  if (done !== null) return { from: done || null, sessions: 0, rows: 0, verified: getMeta(db, 'archive_carry_verified') === '1' };
  if (!from || !fs.existsSync(from)) {
    write(db, () => {
      setMeta(db, 'archive_carried_from', '');
      setMeta(db, 'archive_carry_verified', '1');
    });
    return { from: null, sessions: 0, rows: 0, verified: true };
  }
  const rt = indexRuntime();
  if (!rt.ok) return { from, sessions: 0, rows: 0, verified: false, problem: rt.reason };
  let prev: DatabaseSync;
  try {
    prev = new rt.sqlite.DatabaseSync(from, { readOnly: true } as never);
  } catch (e) {
    return { from, sessions: 0, rows: 0, verified: false, problem: `could not open ${from}: ${String((e as Error)?.message || e)}` };
  }
  try {
    const has = (table: string): boolean => !!prev.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!has('sessions')) throw new Error('it holds no sessions table');
    const archived = prev.prepare('SELECT machine_id, session_id FROM sessions WHERE archived_ms IS NOT NULL').all() as { machine_id: string; session_id: string }[];
    let rows = 0;
    const checks: { table: string; where: string; args: (string | number)[]; n: number }[] = [];
    const copy = (table: string, where: string, args: (string | number)[]): void => {
      if (!has(table)) return;
      const theirs = new Set(tableColumns(prev, table));
      const cols = tableColumns(db, table).filter((c) => theirs.has(c));
      if (!cols.length) return;
      const src = prev.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE ${where}`).all(...args) as Record<string, unknown>[];
      checks.push({ table, where, args, n: src.length });
      const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (let i = 0; i < src.length; i += TX_ROWS) {
        write(db, () => {
          for (const row of src.slice(i, i + TX_ROWS)) {
            ins.run(...cols.map((c) => row[c] as never));
            rows++;
          }
        });
      }
    };
    for (const s of archived) for (const table of SESSION_TABLES) copy(table, 'machine_id = ? AND session_id = ?', [s.machine_id, s.session_id]);
    // What only the index holds of sessions that are not archived, which a new file cannot rebuild from the files: the
    // records `oak clean --resolved` dropped from a log, review comments (a store begun again keeps its earlier ones only
    // here), and what was read of a conversation whose file has gone while its session's store stays.
    copy('edits', 'cleared_ms IS NOT NULL', []);
    copy('comments', '1 = 1', []);
    const sessionCols = new Set(tableColumns(prev, 'sessions'));
    if (sessionCols.has('facts_transcript') && sessionCols.has('transcript_path')) {
      const gone = (prev.prepare("SELECT machine_id, session_id, coalesce(facts_transcript, transcript_path) AS file FROM sessions WHERE archived_ms IS NULL AND origin != 'replica'")
        .all() as { machine_id: string; session_id: string; file: string | null }[]).filter((s) => s.file && !fs.existsSync(s.file));
      for (const s of gone) for (const table of ['sessions', 'prompts', 'actions', 'agents', 'workflow_runs']) copy(table, 'machine_id = ? AND session_id = ?', [s.machine_id, s.session_id]);
    }
    copy('tombstones', '1 = 1', []);
    copy('notes', 'archived_ms IS NOT NULL', []);
    if (has('edit_facts') && has('edits')) {
      const pairs = prev.prepare(`SELECT DISTINCT f.machine_id, f.before_blob, f.after_blob FROM edit_facts f JOIN edits e
        ON e.machine_id = f.machine_id AND coalesce(e.before_blob, '') = f.before_blob AND coalesce(e.after_blob, '') = f.after_blob
        JOIN sessions s ON s.machine_id = e.machine_id AND s.session_id = e.session_id WHERE s.archived_ms IS NOT NULL OR e.cleared_ms IS NOT NULL`).all() as { machine_id: string; before_blob: string; after_blob: string }[];
      for (const p of pairs) copy('edit_facts', 'machine_id = ? AND before_blob = ? AND after_blob = ?', [p.machine_id, p.before_blob, p.after_blob]);
    }
    // Verified when every row read is in the new file (a row already there, written by a catch-up first, counts).
    const verified = checks.every((c) => (db.prepare(`SELECT count(*) AS n FROM ${c.table} WHERE ${c.where}`).get(...c.args) as { n: number }).n >= c.n);
    write(db, () => {
      setMeta(db, 'archive_carried_from', from);
      setMeta(db, 'archive_carry_verified', verified ? '1' : '0');
      setMeta(db, 'archive_carried_sessions', String(archived.length));
      setMeta(db, 'archive_carried_rows', String(rows));
    });
    return { from, sessions: archived.length, rows, verified };
  } catch (e) {
    return { from, sessions: 0, rows: 0, verified: false, problem: `could not carry the archive from ${from}: ${String((e as Error)?.message || e)}` };
  } finally {
    prev.close();
  }
}

/** Index files `oak clean` may remove: superseded ones whose archive a newer file carried and verified. Never the
 *  current one, never one nothing has carried from (it may hold the only copy of its archive), and never one of a newer
 *  format than this OAK's (a newer OAK's, still in use). */
export function reclaimableIndexFiles(): string[] {
  const files = indexFiles();
  const rt = indexRuntime();
  if (!rt.ok) return [];
  const carried = new Set<string>();
  for (const f of files) {
    let db: DatabaseSync | null = null;
    try {
      db = new rt.sqlite.DatabaseSync(f.file, { readOnly: true } as never);
      const row = (key: string): string | null => (db!.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
      const from = row('archive_carried_from');
      if (from && row('archive_carry_verified') === '1') carried.add(from);
    } catch {
      /* unreadable: it vouches for nothing */
    } finally {
      try {
        db?.close();
      } catch {
        /* closed */
      }
    }
  }
  return files.filter((f) => !f.current && f.format <= INDEX_FORMAT && carried.has(f.file)).map((f) => f.file);
}
