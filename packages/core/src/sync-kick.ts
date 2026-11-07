/**
 * The background sync: a throttled, detached `oak sync now --quiet --if-due`, kicked by the capture hooks (Stop and
 * PostToolUse) and by the pollers that kick the saved machines' usage readings, VS Code's among them (it claims the kick
 * here and starts the CLI itself). No daemon and no port: a kick starts one short run, which pulls and exits.
 *
 * Cheap enough for every hook: one stat of a claim file in the common case, and nothing loaded but this module. A
 * kick starts nothing until a run with a saved machine to sync with, or with a backup folder set, has happened here (the
 * first such `oak sync now` is the opt-in), at most one kick per SYNC_KICK_MS across every hook and poller, and none
 * within SYNC_AUTO_MS of the last run, while the background runs back off after a failure (syncBackoffMs), or while
 * prefs.json says `"sync": { "auto": false }`. The run itself takes this machine's sync lock and checks again.
 */
import * as fs from 'fs';
import * as path from 'path';
import { rootDir } from './store';
import { keptPrefs } from './sync-state';
import { spawnTool, noBackgroundChildren } from './spawn';
import { oakCliEntry } from './cli-entry';

/** One kick at most this often, across every hook and poller. */
export const SYNC_KICK_MS = 60_000;
/** A background run is due at most this often. */
export const SYNC_AUTO_MS = 5 * 60_000;
/** The longest the background runs wait after failures in a row. */
export const SYNC_BACKOFF_MAX_MS = 60 * 60_000;

/** How long the background runs wait after `failures` failed in a row: SYNC_AUTO_MS, doubled for each failure after
 *  the first, at most SYNC_BACKOFF_MAX_MS (5, 10, 20, 40, then 60 minutes). */
export function syncBackoffMs(failures: number): number {
  return failures > 0 ? Math.min(SYNC_AUTO_MS * 2 ** Math.min(failures - 1, 16), SYNC_BACKOFF_MAX_MS) : 0;
}

/** `sync/backoff.json`: when the last background run started, and how many have failed in a row, that one included
 *  until it ends well. A run that stopped, or ended before it could say so (killed, out of memory), leaves it raised;
 *  one that ends well removes it. Null when there is none. */
export function readSyncBackoff(dir = path.join(rootDir(), 'sync')): { at: number; failures: number } | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'backoff.json'), 'utf8'));
    return Number.isFinite(v?.at) && Number.isInteger(v?.failures) && v.failures > 0 ? { at: v.at, failures: v.failures } : null;
  } catch {
    return null;
  }
}

/** Whether the failures before it hold a background run off at `now`. A start dated after now (a clock stepped back
 *  since) holds nothing past the backoff either way. */
export function syncBackedOff(now: number, backoff: { at: number; failures: number } | null): boolean {
  return !!backoff && Math.abs(now - backoff.at) < syncBackoffMs(backoff.failures);
}

/** Whether a background run is due, claimed for this caller: the claim file (`sync/kick`) holds every other hook and
 *  poller off for SYNC_KICK_MS. Never throws. */
export function claimSyncKick(): boolean {
  try {
    const dir = path.join(rootDir(), 'sync');
    const claim = path.join(dir, 'kick');
    try {
      if (Math.abs(Date.now() - fs.statSync(claim).mtimeMs) < SYNC_KICK_MS) return false; // the cheapest refusal first
    } catch {
      /* never kicked */
    }
    let last: number;
    try {
      last = Number(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).at);
    } catch {
      return false; // not set up here: the first run with a saved machine to sync with, or a backup folder, is the person's to start
    }
    if (Number.isFinite(last) && Math.abs(Date.now() - last) < SYNC_AUTO_MS) return false;
    if (syncBackedOff(Date.now(), readSyncBackoff(dir))) return false;
    if (keptPrefs().sync?.auto === false) return false; // as kept where an older OAK dropped it (sync-state.ts keptPrefs)
    fs.writeFileSync(claim, String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false; // a background sync must never fail what kicked it
  }
}

/** Start `oak sync now --quiet --if-due` detached when one is due (claimSyncKick). `cli` is the oak CLI entry the running
 *  bundle registered (cli-entry.ts); a process with none starts nothing. Never blocks, never throws, never prints. */
export function kickSync(cli: string | undefined = oakCliEntry()): void {
  try {
    if (!cli || noBackgroundChildren() || !claimSyncKick()) return;
    const child = spawnTool(process.execPath, [cli, 'sync', 'now', '--quiet', '--if-due'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      /* the next kick tries again */
    });
    child.unref();
  } catch {
    /* a background sync must never fail what kicked it */
  }
}
