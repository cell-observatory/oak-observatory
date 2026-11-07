/** Short, untrusted facts shared through the database and each machine's record log. */
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { useIndex, queryIndex } from './index/api';
import { write, tryLease, releaseLease } from './index/db';
import { RecordWriter } from './index/records';
import { machineHostTag } from './machine-usage';
import { fileProjectIdentity, readMountTable } from './sync-identity';
import { delegatedSessionPath, isDelegatedId } from './delegated-link';
import { isSafeSessionId } from './store';
import { resolveSessionId } from './session';
import * as fs from 'fs';

export function findingSession(env: NodeJS.ProcessEnv = process.env): string {
  let session = env.CLAUDE_OBSERVATORY_SESSION ?? env.CLAUDE_CHANGES_SESSION ?? env.CODEX_THREAD_ID;
  if (!session && isDelegatedId(env.OAK_DELEGATED)) {
    try { session = fs.readFileSync(delegatedSessionPath(env.OAK_DELEGATED), 'utf8').trim(); } catch { /* not linked yet */ }
  }
  session ??= resolveSessionId(process.cwd()) ?? undefined;
  if (!session || !isSafeSessionId(session)) throw new Error('name the posting session with --session <id> (or run in a linked agent session)');
  return session;
}

export function findingScope(cwd: string, files: readonly string[] = []): { repo: string; paths: string[] } {
  const id = fileProjectIdentity(cwd, { home: os.homedir(), shares: readMountTable() });
  if (!id.root || !id.key.startsWith('git:')) throw new Error('findings need a repository with an origin URL');
  const paths = files.map((file) => {
    const rel = path.relative(id.root!, path.resolve(cwd, file));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`finding path is outside the repository: ${file}`);
    return rel.split(path.sep).join('/');
  });
  return { repo: id.key.split('//')[0], paths: [...new Set(paths)] };
}

export function addFinding(text: string, opts: { cwd: string; paths?: string[]; session?: string }): { id: string } {
  if (!text.trim() || text.length > 4000) throw new Error('a finding needs 1 to 4000 characters');
  const scope = findingScope(opts.cwd, opts.paths);
  const session = opts.session ?? findingSession();
  if (!isSafeSessionId(session)) throw new Error('invalid posting session');
  const id = randomUUID(), machine = machineHostTag();
  const row = { id, session_id: session, created_ms: Date.now(), repo: scope.repo, paths: JSON.stringify(scope.paths), text };
  writeFinding('findings', machine, row);
  return { id };
}

function writeFinding(table: 'findings' | 'finding_resolutions', machine: string, row: Record<string, string | number>): void {
  const ix = useIndex();
  if (!ix.ok) throw new Error(ix.reason);
  let leased = false;
  try {
    if (!(leased = tryLease(ix.db))) throw new Error('the database is catching up; retry the finding');
    const writer = new RecordWriter(new Set([machine]));
    write(ix.db, () => {
      const cols = Object.keys(row);
      const changed = ix.db.prepare(`INSERT OR IGNORE INTO ${table} (machine_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(machine, ...Object.values(row)).changes;
      if (changed) writer.row(machine, table, row);
      writer.flush();
    });
  } finally {
    if (leased) releaseLease(ix.db);
    ix.close();
  }
}

export function resolveFinding(id: string, session = findingSession()): void {
  if (!isSafeSessionId(session)) throw new Error('invalid resolving session');
  const ix = useIndex();
  if (!ix.ok) throw new Error(ix.reason);
  let rows: { machine_id: string }[];
  try { rows = ix.db.prepare('SELECT machine_id FROM findings WHERE id = ?').all(id) as { machine_id: string }[]; }
  finally { ix.close(); }
  if (rows.length !== 1) throw new Error(rows.length ? 'finding id is ambiguous' : `no finding ${id}`);
  writeFinding('finding_resolutions', machineHostTag(), { finding_machine: rows[0].machine_id, finding_id: id, session_id: session, resolved_ms: Date.now() });
}

export interface FindingsBoard {
  count: number | null;
  rows: Record<string, unknown>[];
  freshness?: import('./index/query').QueryFreshness;
  error?: string;
}

/** Small read-only board for surfaces that already list agents. Null count means unavailable, never an invented zero. */
export function findingsBoard(): FindingsBoard {
  const q = queryIndex('findings', { limit: 100000 }, { budgetMs: 500 });
  if ('error' in q) return { count: null, rows: [], error: q.error.message };
  return { count: q.rowCount, rows: q.rows as Record<string, unknown>[], freshness: q.freshness };
}

/** JSON string quoting keeps line breaks, terminal escapes and apparent instructions visibly inside data. */
export const quoteFinding = (value: unknown): string => JSON.stringify(String(value ?? '')).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
