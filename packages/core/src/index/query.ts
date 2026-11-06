/**
 * `oak query`: the index's answers, by name or as read-only SQL, in one JSON contract (version 1):
 *
 *   { v, query, params, columns, rows, rowCount, truncated, freshness, elapsedMs, problems }
 *
 * `rows` are objects keyed by `columns` (or arrays in that order with `arrays`); `truncated` says the limit cut them;
 * `freshness` says how current the index was when it answered: when it was last caught up, whether this answer caught
 * it up, and each machine whose rows it holds. A failure is `{ v, error: { code, message } }`, `code` one of
 * `bad_query`, `bad_param`, `unsafe_sql`, `sql_error`, `index_unavailable` or `timeout`. Fields are added, never renamed.
 *
 * Named queries leave archived sessions (their files are gone; their rows are kept) out unless asked for with
 * `archived` or `all`, and mark each archived row with when and why.
 */
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { getMeta } from './db';
import { fileProjectIdentity, readMountTable } from '../sync-identity';
import { namedWindow, usageBreakdownSql, countedAccount, codexAccountOf, selfIds, USAGE_WINDOWS, USAGE_GROUPS } from './usage';

export const QUERY_CONTRACT_VERSION = 1;

export type QueryErrorCode = 'bad_query' | 'bad_param' | 'unsafe_sql' | 'sql_error' | 'index_unavailable' | 'timeout';

export interface QueryFreshness {
  /** When a catch-up last brought the index up to date (epoch ms), or null before the first. */
  indexedAt: number | null;
  /** This answer read an index caught up with the files on disk. */
  caughtUp: boolean;
  /** `label` is the name each machine gives itself; `savedLabel` the label this machine saved it under (`--machine`), when
   *  it saved one. `origin` is `replica` for another machine's rows (not the `sessions.origin` of a copy of an edit log). */
  sources: { machine: string; label: string | null; savedLabel?: string | null; origin: 'local' | 'replica'; throughTs: number | null; stale: boolean }[];
}

export interface QueryAnswer {
  v: 1;
  query: string;
  params: Record<string, unknown>;
  columns: string[];
  rows: (Record<string, unknown> | unknown[])[];
  rowCount: number;
  truncated: boolean;
  freshness: QueryFreshness;
  elapsedMs: number;
  problems: string[];
}

export interface QueryFailure {
  v: 1;
  error: { code: QueryErrorCode; message: string };
}

export class QueryError extends Error {
  constructor(readonly code: QueryErrorCode, message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

/** What a named query takes: each parameter's type and default. */
interface ParamSpec {
  type: 'string' | 'int' | 'bool' | 'time';
  default?: unknown;
  description: string;
}

interface NamedQuery {
  description: string;
  params: Record<string, ParamSpec>;
  /** What the parameters name that only the index can resolve (a usage window's bounds), added to them. */
  prepare?(db: DatabaseSync, p: Record<string, unknown>): Record<string, unknown>;
  build(p: Record<string, unknown>): { sql: string; args: (string | number | null)[] };
}

const LIMIT: ParamSpec = { type: 'int', default: 100, description: 'the most rows to return (1 to 100000)' };
const ARCHIVED: ParamSpec = { type: 'bool', default: false, description: 'include archived sessions (their files are gone), marked' };
const ALL: ParamSpec = { type: 'bool', default: false, description: 'include archived sessions and Auto-review threads' };
const MACHINE: ParamSpec = { type: 'string', description: 'only this machine (its id, "self", or the label a saved machine has here)' };
const SINCE: ParamSpec = { type: 'time', description: 'only since this time: epoch ms, an ISO date, or a duration back from now (30m, 12h, 7d)' };

/** The label this machine knows a row's machine by, after the row's own columns: the label it saved that machine under (the
 *  one `--machine` takes), else the name the machine gives itself, else its id; `this machine` for this one. */
const MACHINE_LABEL = (col: string): string => `(SELECT coalesce(ml.saved_label, ml.label, ${col}) FROM machines ml WHERE ml.machine_id = ${col}) AS machine_label`;

/** The archive columns every session-bound row carries. */
const ARCHIVE_COLS = `CASE WHEN s.archived_ms IS NULL THEN 0 ELSE 1 END AS archived, s.archived_ms, s.archived_reason`;

/** Archived sessions are left out unless asked for. */
const keepArchived = (p: Record<string, unknown>): boolean => p.archived === true || p.all === true;

function machineClause(col: string, p: Record<string, unknown>, args: (string | number | null)[]): string {
  if (typeof p.machine !== 'string' || !p.machine) return '';
  // Every id this machine's own catch-ups have filed under: its tag hashes the host name, which changes (macOS renames
  // the host with the network), and sessions indexed before keep the id they were filed under.
  if (p.machine === 'self') return ` AND ${col} IN (SELECT machine_id FROM machines WHERE is_self = 1)`;
  const ids = p.machineIds as string[];
  args.push(...ids);
  return ` AND ${col} IN (${ids.map(() => '?').join(', ')})`;
}

/** The machine ids `machine` names: `self` (every id this machine filed under, selfIds), an id the index holds, or the
 *  label this machine saved a machine under (its `saved_label`, which the other verbs' `--machine` takes), as every id
 *  that machine was filed under. Anything else is refused: an answer with no rows would read as a machine that did
 *  nothing. */
function machineIds(db: DatabaseSync, machine: string): string[] {
  if (machine === 'self') return selfIds(db);
  if (db.prepare('SELECT 1 FROM machines WHERE machine_id = ?').get(machine)) return [machine];
  const ids = (db.prepare('SELECT machine_id FROM machines WHERE saved_label = ? ORDER BY machine_id').all(machine) as { machine_id: string }[]).map((m) => m.machine_id);
  if (ids.length) return ids;
  throw new QueryError('bad_param', `machine is a machine's id, "self", or the label a saved machine has here, which "${machine}" is not: \`oak query sync\` lists each machine the database holds, by id (machine) and by that label (saved_label)`);
}

/** A git project key names the repository, then `//<folder>` when the session ran in a folder of it (sync-identity.ts
 *  identityKey: the repository's part never holds `//`); an edit's `rel_path` is its path from the repository's root
 *  either way. The repository's part of a key, in SQL and in TypeScript: what one file is matched and grouped by, so the
 *  edits of sessions started in different folders of one repository, and in clones of it at other paths, are one file's. */
const REPO_KEY = (col: string): string => `CASE WHEN instr(${col}, '//') > 0 THEN substr(${col}, 1, instr(${col}, '//') - 1) ELSE ${col} END`;
const repoOf = (key: string): string => key.split('//')[0];

/** An absolute path on this machine as the index keys an edit of it: the repository key and the path within it that one
 *  of this machine's sessions working in it gives it (its working directory's identity and root, as ingest.ts keys that
 *  session's edits), the deepest such root, of `project`'s repository when given. Null when none does. */
function projectPathOf(db: DatabaseSync, file: string, project: string | null): { key: string; rel: string } | null {
  const ctx = { home: os.homedir(), shares: readMountTable() };
  let best: { key: string; rel: string; root: string } | null = null;
  for (const { cwd } of db.prepare('SELECT DISTINCT cwd FROM sessions WHERE machine_id IN (SELECT machine_id FROM machines WHERE is_self = 1) AND cwd IS NOT NULL').all() as { cwd: string }[]) {
    let id: { key: string; root?: string | null };
    try {
      id = fileProjectIdentity(cwd, ctx);
    } catch {
      continue;
    }
    if (!id.root || (project !== null && repoOf(id.key) !== repoOf(project))) continue;
    const rel = path.relative(id.root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!best || id.root.length > best.root.length) best = { key: repoOf(id.key), rel: rel.split(path.sep).join('/'), root: id.root };
  }
  return best && { key: best.key, rel: best.rel };
}

/** An FTS5 query from plain words: each one quoted (so `-`, `:` and `"` are never syntax), all of them required, the
 *  last one also as a prefix. */
export function ftsQuery(text: string): string {
  const words = text.split(/\s+/).map((w) => w.replace(/"/g, '""')).filter(Boolean);
  if (!words.length) throw new QueryError('bad_param', 'the text to search for is empty');
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(' AND ');
}

export const NAMED_QUERIES: Record<string, NamedQuery> = {
  findings: {
    description: 'untrusted findings, newest first; repository-wide findings also match a path; resolved posts only with --all',
    params: { machine: MACHINE, session: { type: 'string', description: 'posting session' }, repo: { type: 'string', description: 'repository key (git:host/path)' },
      path: { type: 'string', description: 'path from the repository root, or an absolute local path' }, all: { type: 'bool', default: false, description: 'include resolved findings' }, limit: LIMIT },
    prepare(db, p) {
      if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) return p;
      const within = projectPathOf(db, p.path, typeof p.repo === 'string' ? p.repo : null);
      if (!within) throw new QueryError('bad_param', 'use --repo <repository key> and --path <path from its root>');
      return { ...p, path: within.rel, repo: within.key };
    },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = p.all === true ? '1 = 1' : 'r.resolved_ms IS NULL';
      where += machineClause('f.machine_id', p, args);
      if (typeof p.session === 'string') { where += ' AND f.session_id = ?'; args.push(p.session); }
      if (typeof p.repo === 'string') { where += ' AND f.repo = ?'; args.push(repoOf(p.repo)); }
      if (typeof p.path === 'string') { where += " AND (json_array_length(f.paths) = 0 OR EXISTS (SELECT 1 FROM json_each(f.paths) WHERE value = ?))"; args.push(p.path); }
      args.push(Number(p.limit) + 1);
      return { sql: `SELECT f.id, f.machine_id AS machine, f.session_id AS session, f.created_ms, f.repo, f.paths, f.text,
        r.resolved_ms IS NOT NULL AS resolved, r.resolved_ms, ${MACHINE_LABEL('f.machine_id')}, 'untrusted' AS trust
        FROM findings f LEFT JOIN (SELECT finding_machine, finding_id, min(resolved_ms) AS resolved_ms FROM finding_resolutions GROUP BY finding_machine, finding_id) r
        ON r.finding_machine = f.machine_id AND r.finding_id = f.id WHERE ${where} ORDER BY f.created_ms DESC, f.machine_id, f.id LIMIT ?`, args };
    },
  },
  sessions: {
    description: 'sessions, newest first: machine, workspace, title, activity, edits, tokens',
    params: {
      machine: MACHINE, workspace: { type: 'string', description: 'only this workspace label' }, project: { type: 'string', description: 'only this project key' },
      agent: { type: 'string', description: 'claude or codex' }, text: { type: 'string', description: 'words in the title or first prompt' }, since: SINCE,
      id: { type: 'string', description: 'only this session id' },
      limit: LIMIT, archived: ARCHIVED, all: ALL,
    },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = "s.origin != 'replica'";
      if (!keepArchived(p)) where += ' AND s.archived_ms IS NULL';
      if (p.all !== true) where += ' AND s.review = 0';
      where += machineClause('s.machine_id', p, args);
      if (typeof p.workspace === 'string') { where += ' AND s.workspace = ?'; args.push(p.workspace); }
      if (typeof p.project === 'string') { where += ' AND s.project_key = ?'; args.push(p.project); }
      if (typeof p.id === 'string') { where += ' AND s.session_id = ?'; args.push(p.id); }
      if (typeof p.agent === 'string') { where += ' AND s.agent = ?'; args.push(p.agent); }
      if (typeof p.since === 'number') { where += ' AND s.last_active_ms >= ?'; args.push(p.since); }
      if (typeof p.text === 'string') { where += ' AND s.rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH ?)'; args.push(ftsQuery(p.text)); }
      args.push(Number(p.limit) + 1);
      return {
        sql: `SELECT s.machine_id AS machine, s.session_id AS id, s.agent, s.origin, s.workspace, s.project_key, s.title, s.last_active_ms, s.last_turn_ms,
          s.model, s.effort, s.edits, s.pending, s.files, s.added, s.removed, s.tokens, s.cached, s.duration_ms, s.store_bytes, s.listed, ${ARCHIVE_COLS}, s.cwd,
          ${MACHINE_LABEL('s.machine_id')}
          FROM sessions s WHERE ${where} ORDER BY s.last_active_ms DESC, s.session_id LIMIT ?`,
        args,
      };
    },
  },
  edits: {
    description: 'captured edits, newest first, with their line counts',
    params: {
      machine: MACHINE, session: { type: 'string', description: 'only this session' }, file: { type: 'string', description: 'only this file (an absolute path)' },
      project: { type: 'string', description: 'only this project key' },
      path: { type: 'string', description: 'only this path from the repository\'s root (with project, whose repository it names), in every clone and from every folder of it; an absolute path on this machine is taken as its path within its repository' },
      status: { type: 'string', description: 'pending, kept or undone' }, since: SINCE, limit: LIMIT, archived: ARCHIVED, all: ALL,
    },
    // An absolute path is this machine's file: taken as its path within its repository, so it finds the file in every
    // clone, or refused with what to pass (it matched nothing, which read as no edit at all). This machine's edits of that
    // very file count too (`path_abs`), whatever repository a session working above it gave them (one nested in another).
    prepare(db, p) {
      if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) return p;
      const within = projectPathOf(db, p.path, typeof p.project === 'string' ? p.project : null);
      if (!within) {
        throw new QueryError('bad_param', `path is a file's path within its project (src/app.ts, with --project <key>; \`oak query sessions\` shows each session's project_key), or an absolute path inside a project this machine's sessions ran in${typeof p.project === 'string' ? ` (${p.project})` : ''}, which ${p.path} is not; --file <absolute path> matches that path exactly`);
      }
      return { ...p, path: within.rel, project: within.key, path_abs: p.path };
    },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = '1 = 1';
      if (!keepArchived(p)) where += ' AND s.archived_ms IS NULL AND e.cleared_ms IS NULL';
      where += machineClause('e.machine_id', p, args);
      if (typeof p.session === 'string') { where += ' AND e.session_id = ?'; args.push(p.session); }
      if (typeof p.file === 'string') { where += ' AND e.file = ?'; args.push(p.file); }
      if (typeof p.path === 'string') {
        // A path from the repository's root: the edits of that file from every folder of the repository (`project` names
        // it), and this machine's edits of the absolute path it was given.
        let match = 'e.rel_path = ?';
        args.push(p.path);
        if (typeof p.project === 'string') {
          // The repository's key, or one of a folder of it (`<key>//<folder>`): an equality and a range the index on
          // project_key seeks ('/' sorts just below '0').
          const repo = repoOf(p.project);
          match += ' AND (e.project_key = ? OR (e.project_key >= ? AND e.project_key < ?))';
          args.push(repo, `${repo}//`, `${repo}/0`);
        }
        if (typeof p.path_abs === 'string') { match = `(${match}) OR (e.file = ? AND e.machine_id IN (SELECT machine_id FROM machines WHERE is_self = 1))`; args.push(p.path_abs); }
        where += ` AND (${match})`;
      } else if (typeof p.project === 'string') { where += ' AND e.project_key = ?'; args.push(p.project); }
      if (typeof p.status === 'string') { where += ' AND e.status = ?'; args.push(p.status); }
      if (typeof p.since === 'number') { where += ' AND e.ts >= ?'; args.push(p.since); }
      args.push(Number(p.limit) + 1);
      return {
        sql: `SELECT e.machine_id AS machine, e.session_id AS session, e.id, e.uid, e.ts, e.tool, e.file, e.project_key, e.rel_path, e.status,
          f.added, f.removed, e.prompt_id, e.tool_call_id, e.cleared_ms,
          CASE WHEN s.archived_ms IS NULL AND e.cleared_ms IS NULL THEN 0 ELSE 1 END AS archived, coalesce(s.archived_ms, e.cleared_ms) AS archived_ms,
          coalesce(s.archived_reason, CASE WHEN e.cleared_ms IS NOT NULL THEN 'cleaned' END) AS archived_reason, ${MACHINE_LABEL('e.machine_id')}
          FROM edits e
          LEFT JOIN sessions s ON s.machine_id = e.machine_id AND s.session_id = e.session_id
          LEFT JOIN edit_facts f ON f.machine_id = e.machine_id AND f.before_blob = coalesce(e.before_blob, '') AND f.after_blob = coalesce(e.after_blob, '')
          WHERE ${where} ORDER BY e.ts DESC, e.machine_id, e.session_id, e.id DESC LIMIT ?`,
        args,
      };
    },
  },
  files: {
    description: 'files the edits touched, one row per path within its repository (a repository cloned at other paths on other machines, or edited from sessions in different folders of it, is one file, under the repository\'s project key; an edit outside any repository by its absolute path), with how many sessions and machines edited each, how many edits are pending, and the absolute path of one of its edits',
    params: { machine: MACHINE, project: { type: 'string', description: 'only this project key' }, status: { type: 'string', description: 'only edits with this status' }, since: SINCE, limit: LIMIT, archived: ARCHIVED, all: ALL },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = '1 = 1';
      if (!keepArchived(p)) where += ' AND s.archived_ms IS NULL AND e.cleared_ms IS NULL';
      where += machineClause('e.machine_id', p, args);
      if (typeof p.project === 'string') { where += ' AND e.project_key = ?'; args.push(p.project); }
      if (typeof p.status === 'string') { where += ' AND e.status = ?'; args.push(p.status); }
      if (typeof p.since === 'number') { where += ' AND e.ts >= ?'; args.push(p.since); }
      args.push(Number(p.limit) + 1);
      return {
        sql: `SELECT e.file, ${REPO_KEY('e.project_key')} AS project_key, e.rel_path, count(DISTINCT e.machine_id) AS machines, count(DISTINCT e.machine_id || '/' || e.session_id) AS sessions,
          count(*) AS edits, sum(e.status = 'pending') AS pending, max(e.ts) AS last_ts
          FROM edits e LEFT JOIN sessions s ON s.machine_id = e.machine_id AND s.session_id = e.session_id
          WHERE ${where} GROUP BY CASE WHEN e.project_key IS NOT NULL AND e.rel_path IS NOT NULL THEN ${REPO_KEY('e.project_key')} || char(0) || e.rel_path ELSE e.file END
          ORDER BY last_ts DESC, e.file LIMIT ?`,
        args,
      };
    },
  },
  prompts: {
    description: "a session's asks in order, each with the edits made while it was the current one",
    params: { session: { type: 'string', description: 'only this session' }, machine: MACHINE, since: SINCE, limit: LIMIT, archived: ARCHIVED, all: ALL },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = '1 = 1';
      if (!keepArchived(p)) where += ' AND s.archived_ms IS NULL';
      where += machineClause('p.machine_id', p, args);
      if (typeof p.session === 'string') { where += ' AND p.session_id = ?'; args.push(p.session); }
      if (typeof p.since === 'number') { where += ' AND p.ts >= ?'; args.push(p.since); }
      args.push(Number(p.limit) + 1);
      // An edit belongs to the ask whose window its time falls in, the temporal rule the prompt views apply first.
      return {
        sql: `SELECT p.machine_id AS machine, p.session_id AS session, p.idx, p.prompt_id AS id, p.ts, p.end_ts, p.text,
          (SELECT count(*) FROM edits e WHERE e.machine_id = p.machine_id AND e.session_id = p.session_id AND e.ts >= p.ts AND (p.end_ts = 0 OR e.ts < p.end_ts)) AS edits,
          (SELECT count(*) FROM edits e WHERE e.machine_id = p.machine_id AND e.session_id = p.session_id AND e.ts >= p.ts AND (p.end_ts = 0 OR e.ts < p.end_ts) AND e.status = 'pending' AND e.cleared_ms IS NULL) AS pending,
          ${ARCHIVE_COLS}, ${MACHINE_LABEL('p.machine_id')}
          FROM prompts p JOIN sessions s ON s.machine_id = p.machine_id AND s.session_id = p.session_id
          WHERE ${where} ORDER BY ${typeof p.session === 'string' ? 'p.idx' : 'p.ts DESC, p.machine_id, p.session_id, p.idx'} LIMIT ?`,
        args,
      };
    },
  },
  search: {
    description: 'asks and the answers to them, ranked (bm25, an ask weighted three times its answer): every word must appear, the last one as a prefix',
    params: { text: { type: 'string', description: 'the words to find (required)' }, machine: MACHINE, since: SINCE, limit: { ...LIMIT, default: 50 }, archived: ARCHIVED, all: ALL },
    build(p) {
      if (typeof p.text !== 'string' || !p.text.trim()) throw new QueryError('bad_param', 'search needs text: `oak query search --text "<words>"`');
      const args: (string | number | null)[] = [ftsQuery(p.text)];
      let where = 'prompts_fts MATCH ?';
      if (!keepArchived(p)) where += ' AND s.archived_ms IS NULL';
      if (p.all !== true) where += ' AND s.review = 0';
      where += machineClause('p.machine_id', p, args);
      if (typeof p.since === 'number') { where += ' AND p.ts >= ?'; args.push(p.since); }
      args.push(Number(p.limit) + 1);
      return {
        sql: `SELECT p.machine_id AS machine, p.session_id AS session, s.title, s.workspace, s.agent, p.idx, p.ts, p.text AS prompt,
          snippet(prompts_fts, -1, '[', ']', '…', 16) AS snippet, bm25(prompts_fts, 3.0, 1.0) AS score, ${ARCHIVE_COLS}, ${MACHINE_LABEL('p.machine_id')}
          FROM prompts_fts JOIN prompts p ON p.rowid = prompts_fts.rowid
          JOIN sessions s ON s.machine_id = p.machine_id AND s.session_id = p.session_id
          WHERE ${where} ORDER BY score, p.ts DESC LIMIT ?`,
        args,
      };
    },
  },
  workers: {
    description: "sessions' workers (subagents and workflow agents), newest first, with their session's phase",
    params: { machine: MACHINE, session: { type: 'string', description: 'only this session' }, since: SINCE, limit: LIMIT, archived: ARCHIVED, all: ALL },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = '1 = 1';
      if (!keepArchived(p)) where += ' AND s.archived_ms IS NULL';
      where += machineClause('a.machine_id', p, args);
      if (typeof p.session === 'string') { where += ' AND a.session_id = ?'; args.push(p.session); }
      if (typeof p.since === 'number') { where += ' AND coalesce(a.last_ts, a.first_ts, 0) >= ?'; args.push(p.since); }
      args.push(Number(p.limit) + 1);
      return {
        sql: `SELECT a.machine_id AS machine, a.session_id AS session, a.agent_id, a.kind, a.run_id, a.agent_type, a.label, a.status, a.first_ts, a.last_ts,
          a.tokens, a.actions, a.edits, ph.phase AS session_phase, s.title AS session_title, ${ARCHIVE_COLS}, ${MACHINE_LABEL('a.machine_id')}
          FROM agents a JOIN sessions s ON s.machine_id = a.machine_id AND s.session_id = a.session_id
          LEFT JOIN session_phase ph ON ph.machine_id = a.machine_id AND ph.session_id = a.session_id
          WHERE ${where} ORDER BY coalesce(a.last_ts, a.first_ts, 0) DESC, a.agent_id LIMIT ?`,
        args,
      };
    },
  },
  delegated: {
    description: "the agents OAK started from a brief (`oak agent start --brief`), newest first, each followed by its session's workers: state and since as last derived, kind, model and effort, machine, herdr tab, parent, and the session's tokens and list-price cost",
    params: {
      state: { type: 'string', description: 'only agents in this state: starting, working, waiting, blocked, done or gone' },
      kind: { type: 'string', description: 'claude or codex' }, id: { type: 'string', description: 'only this agent' },
      workers: { type: 'bool', default: true, description: "each agent's workers (its session's subagents) after it" },
      limit: LIMIT, all: { type: 'bool', default: false, description: 'include agents whose tab was closed' },
    },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = '1 = 1';
      if (p.all !== true) where += ' AND d.closed_ms IS NULL';
      if (typeof p.state === 'string') { where += ' AND d.state = ?'; args.push(p.state); }
      if (typeof p.kind === 'string') { where += ' AND d.kind = ?'; args.push(p.kind); }
      if (typeof p.id === 'string') { where += ' AND d.id = ?'; args.push(p.id); }
      // A session's usage, by the index usage_messages_session keeps (machine first): one lookup per agent.
      const usage = (expr: string): string => `(SELECT sum(${expr}) FROM usage_messages u WHERE u.machine_id IN (SELECT machine_id FROM machines) AND u.session_id = d.session_id)`;
      const agents = `SELECT d.started_ms AS group_ms, d.id AS group_id, 0 AS depth, d.id, d.kind, d.title, d.state, d.since_ms, d.parent, d.session_id,
          d.machine, coalesce(d.model, (SELECT s.model FROM sessions s WHERE s.session_id = d.session_id AND s.model != '' LIMIT 1)) AS model,
          coalesce(d.effort, (SELECT s.effort FROM sessions s WHERE s.session_id = d.session_id AND s.effort != '' LIMIT 1)) AS effort,
          d.agent_type, d.sandbox, d.workspace, d.tab, d.pane, d.cwd, d.out, d.report, d.brief, d.started_ms, d.ended_ms, d.closed_ms, d.error,
          ${usage('u.input + u.output + u.cache_create')} AS tokens, ${usage('u.cost')} AS cost
        FROM delegated d WHERE ${where}`;
      const workers = `SELECT d.started_ms, d.id, 1, a.agent_id, 'worker', coalesce(a.label, a.description, a.agent_type, a.agent_id), a.status, coalesce(a.last_ts, a.first_ts),
          d.id, a.session_id, d.machine, a.model, NULL, a.agent_type, NULL, d.workspace, d.tab, d.pane, d.cwd, NULL, NULL, NULL, a.first_ts, NULL, NULL, NULL, a.tokens, NULL
        FROM delegated d JOIN agents a ON a.session_id = d.session_id WHERE ${where}`;
      const both = p.workers === false ? agents : `${agents} UNION ALL ${workers}`;
      const all = p.workers === false ? args : [...args, ...args];
      all.push(Number(p.limit) + 1);
      return {
        sql: `SELECT id, kind, title, state, since_ms, parent, session_id, machine, model, effort, agent_type, sandbox, workspace, tab, pane, cwd, out, report, brief,
          started_ms, ended_ms, closed_ms, error, tokens, cost FROM (${both}) ORDER BY group_ms DESC, group_id, depth, started_ms, id LIMIT ?`,
        args: all,
      };
    },
  },
  sync: {
    description: 'each machine the database holds rows from: its sessions, archived sessions and edits, and how current they are',
    params: { limit: LIMIT },
    build(p) {
      return {
        sql: `SELECT m.machine_id AS machine, m.label, m.is_self, m.home, m.platform, m.last_seen_ms, m.synced_through_ms,
          (SELECT count(*) FROM sessions s WHERE s.machine_id = m.machine_id AND s.archived_ms IS NULL) AS sessions,
          (SELECT count(*) FROM sessions s WHERE s.machine_id = m.machine_id AND s.archived_ms IS NOT NULL) AS archived,
          (SELECT count(*) FROM edits e WHERE e.machine_id = m.machine_id) AS edits,
          (SELECT max(s.last_active_ms) FROM sessions s WHERE s.machine_id = m.machine_id) AS last_active_ms, m.saved_label
          FROM machines m ORDER BY m.is_self DESC, m.machine_id LIMIT ?`,
        args: [Number(p.limit) + 1],
      };
    },
  },
  usage: {
    description: 'tokens by machine, model, session, day, agent or account in a window, each message once however many machines hold it: input + output + cache creation (cache_create_1h of it kept an hour), cache reads apart, and the cost estimated at today\'s list prices (cost_approx: how many messages it prices approximately); by session, a session\'s row counts every agent it started (agents: how many), its own turns apart (own_tokens, own_cache_read, own_cost)',
    params: {
      window: { type: 'string', default: 'week', description: `the window: ${USAGE_WINDOWS.join(', ')} (5h and week are the account's, bill its bill cycle)` },
      by: { type: 'string', default: 'machine', description: `${USAGE_GROUPS.join(', ')} (a session with every agent it started)` },
      agent: { type: 'string', description: 'claude or codex (default: both)' }, machine: MACHINE,
      since: { type: 'time', description: 'from this time instead of the window: epoch ms, an ISO date, or a duration back from now (30m, 12h, 7d)' },
      until: { type: 'time', description: 'up to this time (with since)' },
      account: { type: 'string', default: 'self', description: "self: this machine's rows and other machines' rows of its accounts (its Claude account, as the account's windows count them, and its Codex account); all: every row" },
      limit: LIMIT,
    },
    prepare(db, p) {
      if (!(USAGE_GROUPS as readonly string[]).includes(String(p.by))) throw new QueryError('bad_param', `by is one of ${USAGE_GROUPS.join(', ')}, not "${String(p.by)}"`);
      if (p.account !== 'self' && p.account !== 'all') throw new QueryError('bad_param', `account is self or all, not "${String(p.account)}"`);
      let span = typeof p.since === 'number' ? { start: p.since, end: typeof p.until === 'number' ? p.until : Date.now() + 1, reset: null } : namedWindow(db, String(p.window), typeof p.agent === 'string' ? p.agent : 'claude');
      if (!span) throw new QueryError('bad_param', `window is one of ${USAGE_WINDOWS.join(', ')}, not "${String(p.window)}"`);
      if (typeof p.since !== 'number' && typeof p.until === 'number') span = { ...span, end: p.until };
      const counted = p.account === 'self' ? countedAccount(db).account : null;
      return { ...p, start: span.start, end: span.end, reset: span.reset, ...(counted !== null ? { countedAccount: counted, codexAccount: codexAccountOf(db), self: selfIds(db) } : {}) };
    },
    build(p) {
      return usageBreakdownSql(p.by as (typeof USAGE_GROUPS)[number], { start: Number(p.start), end: Number(p.end) }, {
        agent: typeof p.agent === 'string' ? p.agent : undefined, machine: Array.isArray(p.machineIds) ? (p.machineIds as string[]) : undefined,
        account: typeof p.countedAccount === 'string' ? p.countedAccount : null, codexAccount: typeof p.codexAccount === 'string' ? p.codexAccount : null,
        self: Array.isArray(p.self) ? (p.self as string[]) : undefined, limit: Number(p.limit) + 1,
      });
    },
  },
  readings: {
    description: "the accounts' shares as each machine read them (the 5-hour, weekly and per-model windows, and the bill-cycle month a status line projected), and the Claude account's answers on its five-hour limit, newest first",
    params: { agent: { type: 'string', description: 'claude or codex' }, kind: { type: 'string', description: 'five, week, model, month or limit' }, machine: MACHINE, since: SINCE, limit: LIMIT },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = '1 = 1';
      where += machineClause('r.machine_id', p, args);
      if (typeof p.agent === 'string') { where += ' AND r.agent = ?'; args.push(p.agent); }
      if (typeof p.kind === 'string') { where += ' AND r.kind = ?'; args.push(p.kind); }
      if (typeof p.since === 'number') { where += ' AND r.measured_ms >= ?'; args.push(p.since); }
      args.push(Number(p.limit) + 1);
      return {
        sql: `SELECT r.machine_id AS machine, coalesce(m.saved_label, m.label) AS machine_label, r.agent, r.kind, r.no_limit, r.label, r.account, r.pct, r.reset_ms, r.measured_ms, r.tokens, r.budget, r.reads,
          r.cost, r.cost_budget, r.source, r.synced_ms FROM usage_readings r LEFT JOIN machines m ON m.machine_id = r.machine_id
          WHERE ${where} ORDER BY r.measured_ms DESC, r.machine_id LIMIT ?`,
        args,
      };
    },
  },
  notes: {
    description: 'plans, memories and skills, newest first',
    params: { kind: { type: 'string', description: 'plan, memory or skill' }, text: { type: 'string', description: 'words in the title or text' }, machine: MACHINE, limit: LIMIT, archived: ARCHIVED, all: ALL },
    build(p) {
      const args: (string | number | null)[] = [];
      let where = '1 = 1';
      if (!keepArchived(p)) where += ' AND n.archived_ms IS NULL';
      where += machineClause('n.machine_id', p, args);
      if (typeof p.kind === 'string') { where += ' AND n.kind = ?'; args.push(p.kind); }
      if (typeof p.text === 'string') { where += ' AND n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)'; args.push(ftsQuery(p.text)); }
      args.push(Number(p.limit) + 1);
      return {
        sql: `SELECT n.machine_id AS machine, n.kind, n.path, n.project, n.title, n.size, n.mtime_ms, CASE WHEN n.archived_ms IS NULL THEN 0 ELSE 1 END AS archived, n.archived_ms,
          ${MACHINE_LABEL('n.machine_id')}
          FROM notes n WHERE ${where} ORDER BY n.mtime_ms DESC, n.path LIMIT ?`,
        args,
      };
    },
  },
};

/** Parse a time parameter: epoch ms, an ISO date, or a duration back from `now` (30m, 12h, 7d, 2w). */
export function parseTime(v: string, now = Date.now()): number {
  if (/^\d{10,}$/.test(v)) return Number(v);
  const d = /^(\d+)\s*(s|m|h|d|w)$/.exec(v);
  if (d) return now - Number(d[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[d[2] as 's' | 'm' | 'h' | 'd' | 'w'];
  const t = Date.parse(v);
  if (Number.isFinite(t)) return t;
  throw new QueryError('bad_param', `not a time: "${v}" (epoch ms, an ISO date, or 30m, 12h, 7d)`);
}

/** A named query's parameters from what was given, checked against its spec. */
export function queryParams(name: string, given: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const q = NAMED_QUERIES[name];
  if (!Object.prototype.hasOwnProperty.call(NAMED_QUERIES, name)) throw new QueryError('bad_query', `no query named "${name}" (named: ${[...Object.keys(NAMED_QUERIES), 'schema', 'sql'].join(', ')})`);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(given)) if (!Object.prototype.hasOwnProperty.call(q.params, k)) throw new QueryError('bad_param', `${name} takes no "${k}" (it takes ${Object.keys(q.params).join(', ')})`);
  for (const [k, spec] of Object.entries(q.params)) {
    const v = k in given ? given[k] : spec.default;
    if (v === undefined || v === null) continue;
    switch (spec.type) {
      case 'int': {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new QueryError('bad_param', `${k} must be a whole number from 1 to 100000, not "${String(v)}"`);
        out[k] = n;
        break;
      }
      case 'bool':
        if (v === true || v === 'true' || v === '1' || v === '') out[k] = true;
        else if (v === false || v === 'false' || v === '0') out[k] = false;
        else throw new QueryError('bad_param', `${k} is true or false, not "${String(v)}"`);
        break;
      case 'time':
        out[k] = typeof v === 'number' ? v : parseTime(String(v), now);
        break;
      default:
        if (typeof v !== 'string') throw new QueryError('bad_param', `${k} must be text`);
        out[k] = v;
    }
  }
  return out;
}

/** How current the index's answer is. */
export function freshness(db: DatabaseSync, caughtUp: boolean, now = Date.now()): QueryFreshness {
  const indexed = getMeta(db, 'caught_up_ms');
  const machines = db.prepare('SELECT machine_id, label, saved_label, is_self, last_seen_ms, synced_through_ms FROM machines ORDER BY is_self DESC, machine_id').all() as {
    machine_id: string; label: string | null; saved_label: string | null; is_self: number; last_seen_ms: number | null; synced_through_ms: number | null;
  }[];
  return {
    indexedAt: indexed ? Number(indexed) : null,
    caughtUp,
    sources: machines.map((m) => {
      const through = m.is_self ? (indexed ? Number(indexed) : null) : (m.synced_through_ms ?? m.last_seen_ms);
      return { machine: m.machine_id, label: m.label, savedLabel: m.saved_label, origin: m.is_self ? 'local' : 'replica', throughTs: through, stale: m.is_self ? !caughtUp : through === null || now - through > 24 * 3600_000 };
    }),
  };
}

/** Run a named query against an open index. */
export function runNamedQuery(db: DatabaseSync, name: string, given: Record<string, unknown>, opts: { caughtUp: boolean; arrays?: boolean; problems?: string[] }): QueryAnswer {
  const t0 = Date.now();
  if (name === 'schema') {
    if (Object.keys(given).length) throw new QueryError('bad_param', 'schema takes no parameters');
    return schemaAnswer(db, opts, t0);
  }
  const q = NAMED_QUERIES[name];
  let params = queryParams(name, given);
  if (typeof params.machine === 'string') params = { ...params, machineIds: machineIds(db, params.machine) };
  if (q.prepare) params = q.prepare(db, params);
  const { sql, args } = q.build(params);
  let rows: Record<string, unknown>[];
  let columns: string[];
  try {
    const stmt = db.prepare(sql);
    columns = stmt.columns().map((c) => c.name);
    rows = stmt.all(...args) as Record<string, unknown>[];
  } catch (e) {
    throw new QueryError('sql_error', String((e as Error)?.message || e));
  }
  const limit = typeof params.limit === 'number' ? params.limit : rows.length;
  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);
  return {
    v: 1, query: name, params: Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'self' && k !== 'machineIds')), columns, rows: opts.arrays ? rows.map((r) => columns.map((c) => r[c])) : rows, rowCount: rows.length, truncated,
    freshness: freshness(db, opts.caughtUp), elapsedMs: Date.now() - t0, problems: opts.problems ?? [],
  };
}

/** The tables, their columns, and the named queries with their parameters. */
function schemaAnswer(db: DatabaseSync, opts: { caughtUp: boolean; arrays?: boolean; problems?: string[] }, t0: number): QueryAnswer {
  const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name").all() as { name: string; type: string }[];
  const rows: Record<string, unknown>[] = [];
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as { name: string; type: string; pk: number }[]);
    rows.push({ kind: t.type === 'view' ? 'view' : t.name.endsWith('_fts') ? 'fts' : 'table', name: t.name, columns: cols.map((c) => `${c.name} ${c.type}${c.pk ? ' key' : ''}`.trim()).join(', '), description: null });
  }
  for (const [name, q] of Object.entries(NAMED_QUERIES)) {
    rows.push({ kind: 'query', name, columns: Object.entries(q.params).map(([k, s]) => `${k} (${s.type}${s.default !== undefined ? `, default ${JSON.stringify(s.default)}` : ''})`).join(', '), description: q.description });
  }
  rows.push({ kind: 'query', name: 'sql', columns: 'one read-only SELECT', description: 'any one read-only SELECT over these tables, in a child process killed at the deadline' });
  const columns = ['kind', 'name', 'columns', 'description'];
  return {
    v: 1, query: 'schema', params: {}, columns, rows: opts.arrays ? rows.map((r) => columns.map((c) => r[c])) : rows, rowCount: rows.length, truncated: false,
    freshness: freshness(db, opts.caughtUp), elapsedMs: Date.now() - t0, problems: opts.problems ?? [],
  };
}

export function queryFailure(e: unknown): QueryFailure {
  if (e instanceof QueryError) return { v: 1, error: { code: e.code, message: e.message } };
  return { v: 1, error: { code: 'sql_error', message: String((e as Error)?.message || e) } };
}

/** The exit status a failure leaves `oak query` with: 2 for a query that cannot run, 3 when there is no index, 124 at
 *  the deadline. */
export function failureExitCode(f: QueryFailure): number {
  return f.error.code === 'index_unavailable' ? 3 : f.error.code === 'timeout' ? 124 : 2;
}
