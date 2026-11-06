/**
 * Writing rows: the upsert every table's writer prepares, and the values it binds fitted to the columns' types.
 */
import type { DatabaseSync } from 'node:sqlite';
import { graphemeHead } from '../graphemes';

/** INSERT … ON CONFLICT DO UPDATE for `cols` (the key columns first). */
export function upsertSql(table: string, keys: readonly string[], cols: readonly string[]): string {
  const sets = cols.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`);
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${keys.join(', ')}) DO ${sets.length ? `UPDATE SET ${sets.join(', ')}` : 'NOTHING'}`;
}

/** Each table's columns: their type, and whether they take no NULL. Read once per database. */
const columnsMemo = new WeakMap<DatabaseSync, Map<string, Map<string, { type: string; notNull: boolean }>>>();

function columnTypes(db: DatabaseSync, table: string): Map<string, { type: string; notNull: boolean }> {
  let byTable = columnsMemo.get(db);
  if (!byTable) columnsMemo.set(db, (byTable = new Map()));
  let cols = byTable.get(table);
  if (!cols) {
    cols = new Map((db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string; type: string; notnull: number }[])
      .map((c) => [c.name, { type: c.type.toUpperCase(), notNull: c.notnull === 1 }]));
    byTable.set(table, cols);
  }
  return cols;
}

/**
 * A row's values fitted to its columns' types, where a value's meaning allows it. Every table is STRICT, which refuses a
 * fractional number in an INTEGER column, a true or false anywhere, and text in a number column: one such value in a
 * source file (a writer's fractional timestamp) kept its whole session out of the index, read after read. A fractional
 * time, count or size is rounded; true and false are 1 and 0; a number given as text is the number; a number or a
 * structure in a text column is its text; a missing value in a column that takes none is that type's zero. Anything
 * else (text that is no number, for a number) is refused, with the column named.
 */
export function fitRow(db: DatabaseSync, table: string, cols: readonly string[], values: readonly unknown[]): (string | number | null)[] {
  const types = columnTypes(db, table);
  return values.map((v, i) => {
    const col = types.get(cols[i]);
    if (!col) return v as string | number | null;
    const zero = col.notNull ? (col.type === 'TEXT' ? '' : 0) : null;
    if (v === null || v === undefined) return zero;
    if (typeof v === 'bigint') v = Number(v);
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (col.type === 'TEXT') return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v);
    let n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(v) ? Number(v) : NaN;
    if (Number.isNaN(n) && typeof v !== 'number') throw new Error(`${table}.${cols[i]} cannot hold ${graphemeHead(JSON.stringify(v) ?? '', 60)}`);
    if (!Number.isFinite(n)) return zero;
    if (col.type === 'INTEGER') {
      n = Math.round(n);
      if (!Number.isSafeInteger(n)) return zero;
    }
    return n;
  });
}
