// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cell Observatory
/**
 * THE STATUS LINE'S CACHE LOCK, for OAK's own writes to `statusline-last.json` (the account pull). Every render of the
 * status line rewrites the whole cache from the copy it read just before, under `<cache>.lock`; a writer that does not
 * take the lock races those renders, and whichever renamed last put back what the other had just recorded. So this is
 * the same lock by the same protocol, step for step the line's `_lock`, `_aside` and `_unlock`
 * (packages/cli/statusline/install-statusline.sh), and the two must change together.
 *
 * The lock is a directory, which mkdir makes or finds taken in one step everywhere. Its holder marks it with a token, a
 * directory inside named `<second taken>.<pid>.<random>`, and holds the lock only once its token is the lock's only
 * entry. A token 5 s old, or 5 s ahead of the clock, is a holder that died: a waiter removes that token by its name and
 * then the lock only if it is empty, so a lock taken since, which holds its taker's token, is never removed. A lock with
 * no token for 5 s by its own mtime goes the same way, and a stale lock that cannot be removed is renamed aside. A writer
 * waits about a second (50 tries 20 ms apart, never past 2 s, without blocking the event loop) and, without the lock,
 * writes nothing. It reads the cache inside the lock, writes its own temporary file (`<cache>.tmp.<pid>`, the name the
 * line's sweep removes when one is left behind), and renames it only while its token is still there.
 */

import * as fs from 'fs';
import * as path from 'path';

/** bash's `"$lock"/*`: the lock's entries but the dot-entries a glob leaves out; none once the lock is gone. */
function entries(lock: string): string[] {
  try { return fs.readdirSync(lock).filter((n) => !n.startsWith('.')); } catch { return []; }
}
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** `rmdir A B`: each in turn, whatever the one before did. False when either is still there. */
function rmdirs(...dirs: string[]): boolean {
  let ok = true;
  for (const d of dirs) { try { fs.rmdirSync(d); } catch { ok = false; } }
  return ok;
}
const epoch = (): number => Math.floor(Date.now() / 1000);
const stale = (t: number, e: number): boolean => e - t >= 5 || t - e >= 5;
const random = (): number => Math.floor(Math.random() * 32768); // bash's $RANDOM

/** _aside: a stale lock that cannot be removed (another user's token, or an entry that is no token) is renamed aside
 *  and removed as far as it can be; the line's sweep removes what is left once it is two minutes old. */
function aside(lock: string): void {
  const x = `${lock}.${process.pid}.${random()}`;
  try { fs.renameSync(lock, x); } catch { return; }
  try { fs.rmSync(x, { recursive: true, force: true }); } catch { /* another user's entries stay */ }
}

/** _lock: the path of this writer's token once it holds `<cache>.lock`, else null. */
async function takeLock(cachePath: string): Promise<string | null> {
  const l = `${cachePath}.lock`;
  try { fs.accessSync(path.dirname(cachePath), fs.constants.W_OK); } catch { return null; }
  const s = Date.now();
  for (let i = 0; i < 50 && Date.now() - s < 2000; i++) {
    let made = true;
    try { fs.mkdirSync(l); } catch { made = false; }
    if (made) {
      const name = `${epoch()}.${process.pid}.${random()}`;
      const tok = path.join(l, name);
      let marked = true;
      try { fs.mkdirSync(tok); } catch { marked = false; }
      if (marked) { const e = entries(l); if (e.length === 1 && e[0] === name) return tok; }
      rmdirs(tok, l);
      continue;
    }
    if (!isDir(l)) continue;
    const e = epoch();
    const names = entries(l);
    if (names.length) {
      for (const n of names) {
        const p = path.join(l, n);
        const lead = n.split('.')[0];
        if (stale(/^[0-9]+$/.test(lead) ? Number(lead) : 0, e) && !rmdirs(p, l) && fs.existsSync(p)) aside(l);
      }
    } else {
      let t: number | null = null;
      try { t = Math.floor(fs.lstatSync(l).mtimeMs / 1000); } catch { /* gone meanwhile */ }
      if (t !== null && stale(t, e) && !rmdirs(l) && isDir(l) && !entries(l).length) aside(l);
    }
    if (isDir(l)) await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

/**
 * Rewrite the status line's cache as a render does, under its lock. `merge` gets the cache as it is now, read inside
 * the lock ({} when there is none or it does not parse), and returns what to write, or null for nothing. 'busy': no lock
 * within about a second, so nothing is written, as a render skips its write. 'lost': the lock was taken from this writer
 * (stopped 5 s inside it) before the rename, so its write is dropped. A write that fails throws. Either way the lock is
 * released and no temporary file is left.
 */
export async function rewriteStatuslineCache(
  cachePath: string,
  merge: (cache: Record<string, unknown>) => Record<string, unknown> | null
): Promise<'written' | 'unchanged' | 'busy' | 'lost'> {
  const tok = await takeLock(cachePath);
  if (!tok) return 'busy';
  const tmp = `${cachePath}.tmp.${process.pid}`;
  let pending = false;
  try {
    let cache: Record<string, unknown> = {};
    try {
      const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (j && typeof j === 'object') cache = j as Record<string, unknown>;
    } catch {
      /* first write — the merge starts from an empty cache */
    }
    const next = merge(cache);
    if (!next) return 'unchanged';
    pending = true;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    // The line's `_commit`: on Windows a rename onto a file another program has open fails with EPERM, and a render reads
    // the cache with jq or python outside the lock, so the rename is tried again 20 ms apart, for about a second, while
    // the token is still there.
    for (let i = 0; ; i++) {
      if (!isDir(tok)) return 'lost';
      try {
        fs.renameSync(tmp, cachePath);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= 49 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    pending = false;
    return 'written';
  } finally {
    if (pending) { try { fs.unlinkSync(tmp); } catch { /* never made */ } }
    rmdirs(tok, path.dirname(tok)); // _unlock: the token, then the lock if that leaves it empty
  }
}
