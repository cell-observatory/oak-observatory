import * as fs from 'fs';
import * as path from 'path';
import { repoRoot, commonDir } from './session';
import { spawnToolSync } from './spawn';
import type { Check } from './diagnose';

export interface AgentGitState {
  files: number; added: number; removed: number; ahead: number; behind: number; merged: boolean;
  dirty: boolean; readMs: number; durationMs: number; calls: number; error?: string;
}
export interface AgentWorktree {
  path: string; repository: string; branch: string | null; base: string; baseBranch: string | null;
  state?: AgentGitState;
  removedMs?: number;
}
export function parseAgentWorktree(text: string): AgentWorktree | undefined {
  try {
    const w = JSON.parse(text);
    return w && typeof w.path === 'string' && typeof w.repository === 'string' && typeof w.base === 'string' ? w : undefined;
  } catch { return undefined; }
}

function git(cwd: string, args: string[], timeout = 1000): string {
  const r = spawnToolSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd, ...args],
    { encoding: 'utf8', timeout, maxBuffer: 256 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  // The spawn error first: a command past its timeout has often written a warning already (Windows' CRLF note on every
  // diff), which named the failure in its place (Windows CI 2026-11-09).
  if (r.error || r.status !== 0) throw new Error(`agent worktree: ${String(r.error?.message || r.stderr || 'git failed').trim()}`);
  return String(r.stdout);
}
export function checkAgentRepository(cwd: string): string {
  const root = repoRoot(cwd);
  if (!root) throw new Error('agent start --worktree needs an existing Git repository');
  git(root, ['rev-parse', '--verify', 'HEAD']);
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=normal']).trim())
    throw new Error('agent start --worktree needs a clean repository; review and save its changes first');
  return root;
}
function branchAt(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim().replace(/^HEAD$/, '') || null;
}
export function createAgentWorktree(cwd: string, id: string, base = 'HEAD'): AgentWorktree {
  const root = checkAgentRepository(cwd);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('invalid worktree id');
  const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
  const baseBranch = base === 'HEAD' ? branchAt(root) : git(root, ['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', base]).trim().replace(/^refs\/heads\//, '') || null;
  const target = path.join(path.dirname(root), id);
  if (fs.existsSync(target)) throw new Error(`agent worktree already exists: ${target}`);
  git(root, ['worktree', 'add', '-b', `oak/${id}`, '--', target, commit], 10000);
  return { path: target, repository: root, branch: `oak/${id}`, base: commit, baseBranch };
}
export function detectAgentWorktree(cwd: string): AgentWorktree | undefined {
  const root = repoRoot(cwd);
  if (!root || !fs.statSync(path.join(root, '.git')).isFile()) return undefined;
  const common = commonDir(root);
  if (!common) return undefined;
  const repository = path.dirname(common);
  const baseBranch = branchAt(repository);
  const base = git(root, ['merge-base', 'HEAD', baseBranch ?? 'HEAD']).trim();
  return { path: root, repository, branch: branchAt(root), base, baseBranch };
}

/** Only Git reads the index and changed paths. Six bounded commands, 256 KiB each, with a 1.5 s total deadline (a third
 * of it a command). The caller persists the timestamp and reads at most one stale worktree per refresh, once per 30
 * seconds. A removal reads with a longer deadline. */
export function readAgentWorktree(w: AgentWorktree, now = Date.now(), budgetMs = 1500): AgentGitState {
  const start = Date.now();
  const state: AgentGitState = { files: 0, added: 0, removed: 0, ahead: 0, behind: 0, merged: false, dirty: false, readMs: now, durationMs: 0, calls: 0 };
  const run = (args: string[]) => {
    const left = budgetMs - (Date.now() - start);
    if (left <= 0) throw new Error(`worktree read exceeded ${budgetMs} ms`);
    state.calls++;
    return git(w.path, args, Math.min(Math.floor(budgetMs / 3), left));
  };
  try {
    const target = w.baseBranch || w.base;
    const status = run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    state.dirty = status.length > 0;
    const untracked = status.split('\0').filter(s => s.startsWith('?? '));
    // numstat includes committed and uncommitted changes since the recorded base; binary files count as files.
    const diff = run(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', w.base, '--']);
    const parts = diff.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
      if (!m) continue;
      state.files++; state.added += Number(m[1]) || 0; state.removed += Number(m[2]) || 0;
      if (!m[3]) i += 2; // rename paths are separate NUL-delimited fields
    }
    state.files += untracked.length;
    let bytes = 0;
    for (const entry of untracked) {
      const file = path.join(w.path, entry.slice(3));
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      bytes += stat.size;
      if (bytes > 1024 * 1024 || Date.now() - start > budgetMs) throw new Error('untracked diff exceeds the bounded worktree read');
      const content = fs.readFileSync(file);
      if (!content.includes(0)) state.added += content.toString('utf8').split('\n').length - (content.length === 0 || content[content.length - 1] === 10 ? 1 : 0);
    }
    const counts = run(['rev-list', '--left-right', '--count', `${target}...HEAD`, '--']).trim().split(/\s+/).map(Number);
    [state.behind, state.ahead] = counts;
    // A clean descendant already in the base branch is merged. Cherry-picked work also qualifies when trees agree.
    state.merged = !state.dirty && (state.ahead === 0 || run(['diff', '--no-ext-diff', '--no-textconv', '--name-only', target, 'HEAD', '--']).length === 0);
  } catch (e) { state.error = String((e as Error).message); state.merged = false; }
  state.durationMs = Date.now() - start;
  return state;
}
export function agentWorktreeSummary(w?: AgentWorktree): string | null {
  const s = w?.state;
  if (!w) return null;
  if (w.removedMs) return 'worktree removed';
  if (!s) return 'worktree not read yet';
  if (s.error) return 'worktree state unavailable';
  return `${s.files} file${s.files === 1 ? '' : 's'} · +${s.added} −${s.removed} · ${s.merged ? 'merged' : 'not merged'}`;
}
export function removeAgentWorktree(w: AgentWorktree): void {
  if (w.removedMs) return;
  // Only a worktree OAK made, on its `oak/<id>` branch. An agent started inside the user's own worktree records that
  // tree too, and removing it would take its ignored files (a local .env) with it.
  if (!w.branch?.startsWith('oak/')) throw new Error(`${w.path} is not a worktree OAK made (branch ${w.branch ?? 'detached'}); remove it with git yourself if you mean to`);
  // A removal waits on Git as this file's other one-off Git commands do (10 s), not as a refresh does: a status in a large
  // tree, or on a slow machine, takes longer than a refresh allows. A read that fails says so, not that the tree has work.
  const state = readAgentWorktree(w, Date.now(), 10000);
  if (state.error && !state.dirty) throw new Error(`could not read the worktree before removal (${state.error}); nothing was removed`);
  if (state.dirty || !state.merged) throw new Error('worktree must be clean and merged before removal; review its changes in OAK first');
  git(w.repository, ['worktree', 'remove', '--', w.path], 10000);
  w.removedMs = Date.now();
  // The agent's own branch goes with its worktree. `-d` refuses a branch that is not merged into HEAD, which then stays.
  if (w.branch?.startsWith('oak/')) {
    try { git(w.repository, ['branch', '-d', '--', w.branch], 10000); } catch { /* not merged into HEAD: kept */ }
  }
}
export function orphanedAgentWorktrees(cwd = process.cwd()): { id: string; path: string }[] {
  const { listDelegatedRecords } = require('./delegated') as typeof import('./delegated');
  const rows = listDelegatedRecords().filter(r => !r.machine);
  const repositories = [...new Set([repoRoot(cwd), ...rows.map(r => r.worktree?.repository)].filter((x): x is string => !!x))].slice(0, 16);
  const out: { id: string; path: string }[] = [];
  for (const repo of repositories) {
    try {
      // A one-off listing waits on Git as a removal does (10 s). With the default 1 s, a listing that ran longer on a
      // slow Windows runner timed out, and read as no worktrees at all (2026-11-10).
      for (const block of git(repo, ['worktree', 'list', '--porcelain'], 10000).split('\n\n')) {
        const p = /^worktree (.+)$/m.exec(block)?.[1];
        if (!p || p === repo) continue;
        const row = rows.find(r => r.worktree?.path === p);
        // Only a worktree OAK made (its `oak/<id>` branch) is OAK's to call orphaned, recorded for an agent or not: the
        // user's own worktrees, on their branches or detached, are never named, even when an agent started in one.
        const oakId = /^branch refs\/heads\/oak\/(.+)$/m.exec(block)?.[1];
        if (oakId && (!row || ((row.state === 'gone' || row.closedMs !== null) && row.worktree?.state?.merged && !row.worktree.state.error)))
          out.push({ id: row?.id ?? oakId ?? path.basename(p), path: p });
      }
    } catch { /* a missing repository has no discoverable worktrees */ }
  }
  return out;
}
export function diagnoseAgentWorktrees(cwd = process.cwd()): Check {
  const trees = orphanedAgentWorktrees(cwd);
  return { id: 'agent-worktrees', label: 'Orphaned agent worktrees', level: trees.length ? 'warn' : 'ok',
    detail: trees.length ? trees.map(w => `${w.id}: ${w.path}`).join('; ') : 'No orphaned worktrees found in the current or recorded repositories.',
    ...(trees.length ? { fix: trees.map(w => `oak agent close --remove-worktree ${w.id}`).join('; ') } : {}) };
}

/** An orphan has no row to close. Resolve it only among the current repository's registered worktrees. */
export function closeOrphanAgentWorktree(id: string, cwd = process.cwd()): AgentWorktree {
  const matches = orphanedAgentWorktrees(cwd).filter(w => w.id === id);
  if (matches.length !== 1) throw new Error(`no unique orphaned worktree "${id}" in this repository; oak doctor lists them`);
  const tree = detectAgentWorktree(matches[0].path);
  if (!tree) throw new Error('the orphaned worktree is no longer registered');
  removeAgentWorktree(tree);
  return tree;
}
