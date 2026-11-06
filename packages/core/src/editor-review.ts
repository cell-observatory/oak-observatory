import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { claudeConfigDir } from './paths';
import { isSafeSessionId } from './store';
import { SyncShare } from './sync-identity';

export interface EditorReviewRequest {
  editor: 'vscode' | 'cursor' | 'jetbrains';
  session: string;
  workspace: string;
  action: 'edit' | 'file' | 'all' | 'workspace';
  edit?: number;
  file?: string;
  prompt?: string;
}
const REQUEST_TTL = 10 * 60 * 1000;
function requestDir(): string { return path.join(claudeConfigDir(), 'editor-review'); }
function workspaceKey(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

/** A private, short-lived mailbox on the session's machine, independent of the editor's URI handler. */
export function writeEditorReviewRequest(request: EditorReviewRequest, now = Date.now()): EditorReviewRequest & { id: string; expiresAt: number } {
  if (!isSafeSessionId(request.session) || !path.isAbsolute(request.workspace) ||
      !['vscode', 'cursor', 'jetbrains'].includes(request.editor) || !['edit', 'file', 'all', 'workspace'].includes(request.action)) throw new Error('Invalid editor review request');
  const dir = requestDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value = { ...request, workspace: workspaceKey(request.workspace), id: randomUUID(), expiresAt: now + REQUEST_TTL };
  const file = path.join(dir, value.id + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(file + '.tmp', file);
  return value;
}

/** Atomic rename claims a request before returning it: two windows cannot consume the same request. */
export function consumeEditorReviewRequest(editor: string, workspace: string, now = Date.now()): (EditorReviewRequest & { id: string; expiresAt: number }) | null {
  const dir = requestDir();
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => /^[\da-f-]+\.json$/.test(f)).sort(); } catch { return null; }
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isFinite(r.expiresAt) || r.expiresAt <= now) { fs.unlinkSync(file); continue; }
      if (r.editor !== editor || r.workspace !== workspaceKey(workspace)) continue;
      if (!isSafeSessionId(r.session) || !['edit', 'file', 'all', 'workspace'].includes(r.action)) continue;
      const claimed = file + '.' + randomUUID() + '.claimed';
      fs.renameSync(file, claimed);
      fs.unlinkSync(claimed);
      return r;
    } catch { /* another window won, or an incomplete/invalid request */ }
  }
  return null;
}

export interface ReviewMachinePaths { home: string; hostname: string; user: string; shares: SyncShare[] }

/** Only mount evidence establishes equivalence; an identical local pathname never does. */
export function mapReviewPath(file: string, target: string, remote: ReviewMachinePaths, mounts: readonly SyncShare[]): string | null {
  if (!file.startsWith('/') || file.includes('\0') || file.split('/').some(p => p === '..' || p === '.')) return null;
  const host = target.replace(/^.*@/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const hosts = new Set([host, remote.hostname.toLowerCase()]);
  const below = (p: string, root: string): string | null => p === root ? '' : p.startsWith(root.replace(/\/$/, '') + '/') ? p.slice(root.replace(/\/$/, '').length + 1) : null;
  const candidates: { root: string; mount: string }[] = [];
  for (const m of mounts) {
    if (hosts.has(m.server.toLowerCase())) {
      if (m.type === 'nfs' || m.type === 'nfs4') candidates.push({ root: '/' + m.share, mount: m.mount });
      else if (m.share === remote.user || m.share === 'homes') candidates.push({ root: remote.home, mount: m.mount });
    }
    for (const r of remote.shares) {
      if (r.server.toLowerCase() === m.server.toLowerCase() && r.share === m.share) candidates.push({ root: r.mount, mount: m.mount });
    }
  }
  for (const c of candidates.sort((a, b) => b.root.length - a.root.length)) {
    const rel = below(file, c.root);
    if (rel !== null) return path.posix.join(c.mount, rel);
  }
  return null;
}
