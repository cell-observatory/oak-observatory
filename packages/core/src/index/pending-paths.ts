/** The database catch-up publishes a bounded snapshot for capture, which never opens the database. */
import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { pendingPathsFile, pendingSourceStamp, HEADS_UP_MAX_AGE_MS, HEADS_UP_MAX_BYTES, type PendingPaths, type PendingPath } from '../edit-heads-up';
import { storeDir, logPath } from '../store';
import { delegatedDir } from '../delegated-link';

export function publishPendingPaths(db: DatabaseSync, now: number): void {
  const file = pendingPathsFile(), tmp = `${file}.${process.pid}.tmp`;
  try {
    const agents = db.prepare(`SELECT d.*, m.is_self FROM delegated d JOIN machines m USING(machine_id) WHERE d.session_id IS NOT NULL`).all() as any[];
    const machines = db.prepare('SELECT machine_id, saved_label FROM machines').all() as { machine_id: string; saved_label: string | null }[];
    const family: PendingPaths['family'] = agents.map(a => ({ machine: a.is_self && a.machine ? machines.find(m => m.saved_label === a.machine)?.machine_id ?? a.machine_id : a.machine_id,
      session: a.session_id, id: a.id, parent: a.parent, local: !!a.is_self }));
    for (const s of db.prepare(`SELECT s.machine_id, s.session_id, s.parent_session, m.is_self FROM sessions s JOIN machines m USING(machine_id) WHERE s.parent_session != ''`).all() as any[]) {
      family.push({ machine: s.machine_id, session: s.session_id, id: s.session_id, parent: s.parent_session, local: !!s.is_self });
    }
    const rows = db.prepare(`SELECT e.machine_id AS machine, e.session_id AS session, e.project_key AS repo, e.rel_path AS path,
      count(*) AS pending, min(e.ts) AS since, max(s.last_active_ms, s.capture_ms) AS activity,
      m.is_self AS local, coalesce(m.saved_label, m.label, m.machine_id) AS label, m.synced_through_ms AS published
      FROM edits e JOIN sessions s ON s.machine_id = e.machine_id AND s.session_id = e.session_id
      JOIN machines m ON m.machine_id = e.machine_id JOIN session_phase p ON p.machine_id = s.machine_id AND p.session_id = s.session_id
      LEFT JOIN session_live l ON l.machine_id = s.machine_id AND l.session_id = s.session_id
      WHERE e.status = 'pending' AND e.cleared_ms IS NULL AND s.archived_ms IS NULL AND s.origin != 'replica'
      AND coalesce(l.turn_open, 1) != 0
      AND (s.agent != 'codex' OR s.parent_session IS NOT NULL)
      AND e.project_key LIKE 'git:%' AND e.rel_path IS NOT NULL AND p.phase IN ('working', 'awaiting-input', 'awaiting-permission')
      GROUP BY e.machine_id, e.session_id, e.project_key, e.rel_path LIMIT 4001`).all() as any[];
    const paths: PendingPath[] = [];
    for (const r of rows) {
      const a = agents.find(a => a.machine_id === r.machine && a.session_id === r.session);
      if (a && (['done', 'gone', 'errored', 'queued'].includes(a.state) || a.ended_ms !== null || a.closed_ms !== null)) continue;
      if (r.local && a?.report) {
        try { const report = fs.statSync(a.report); if (report.isFile() && report.size > 0 && report.mtimeMs >= a.started_ms) continue; } catch { /* no report */ }
      }
      const observed = Math.min(now, r.activity, r.local ? now : r.published ?? 0);
      if (now - observed > HEADS_UP_MAX_AGE_MS || r.activity > now || (!r.local && r.published > now)) continue;
      const sourceFiles = r.local ? [logPath(r.session), path.join(storeDir(r.session), 'attention.json'), ...(a ? [path.join(delegatedDir(), `${a.id}.json`), ...(a.report ? [a.report] : [])] : [])] : [];
      paths.push({ repo: r.repo.split('//')[0], path: r.path, machine: r.machine, session: r.session, label: r.label,
        agent: a?.id ?? r.session, pending: r.pending, since: r.since, observed, local: !!r.local,
        sources: sourceFiles.map(file => ({ file, stamp: pendingSourceStamp(file) })) });
    }
    if (!paths.length || rows.length > 4000) { try { fs.unlinkSync(file); } catch { /* no pending paths */ } return; }
    const board: PendingPaths = { v: 1, at: now, paths, family };
    const json = JSON.stringify(board);
    if (Buffer.byteLength(json) > HEADS_UP_MAX_BYTES) { fs.unlinkSync(file); return; }
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(file); } catch { /* missing already */ }
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
