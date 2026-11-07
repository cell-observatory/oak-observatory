/**
 * Where the local index lives: `claude-observatory-index/index-v<format>-<key>.sqlite` beside the store's config (in
 * the Claude config folder, where a store move is coordinated too), with `<key>` the first 16 hex digits of a sha256 of
 * the store's folder. Never inside the store's own folder, which can move: `oak clean` deletes a store-root folder it
 * does not know, a store moved onto a network share would put SQLite's write-ahead log where it is unsafe, and a move
 * would copy a database while it is open.
 *
 * The format is in the file's name: an OAK that changes the schema in a way a migration cannot builds a new file from
 * the sources, carrying over only what the sources no longer hold (archive.ts), and `oak clean` reclaims the old file
 * once that is done.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { claudeConfigDir } from '../paths';
import { rootDir } from '../store';
import { spawnTool, noBackgroundChildren } from '../spawn';
import { oakCliEntry } from '../cli-entry';

/** The index file's format. A change no `user_version` migration can make bumps it, and a new file is built. */
export const INDEX_FORMAT = 1;

export function indexDir(): string {
  return path.join(claudeConfigDir(), 'claude-observatory-index');
}

/** Whether OAK supports a Node release to run the index, by its version (`v24.1.0` or `24.1.0`; runtime.ts INDEX_NODES):
 *  24 and later. Here, by its version alone, so the capture hooks' kick loads nothing that reads SQLite. */
export function nodeRunsIndex(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  return major >= 24;
}

/** How often a background build may be started. */
const KICK_MS = 60_000;

/** How long a build that could not open the index holds the next one off (`backOffIndexBuild`): the claim is dated this
 *  far ahead, and a kick within it starts nothing. */
export const KICK_BACKOFF_MS = 60 * 60_000;

/** The claim every kick shares, beside the index: when one was last started, or how long builds are held off. */
function kickClaim(): string {
  return path.join(indexDir(), 'build.kick');
}

/** Start `oak __index-build` detached, at most once a minute (`build.kick` beside the index is the claim every caller
 *  shares: a reader whose catch-up was left undone, the usage readout, a machine asked to publish, and the capture
 *  hooks), never under OAK_NO_BACKGROUND or OAK_INDEX=off, nor from a Node that cannot run the index, nor while a build
 *  that could not open the index holds the next off (KICK_BACKOFF_MS). One stat when none is due, and nothing else
 *  loaded. `hook`: the capture hooks' kick, which publishes what they recorded to this machine's record log for the
 *  other machines, so it starts nothing until oak sync has run here (`sync/status.json`), as their background sync. */
export function kickIndexBuild(cli: string | undefined = oakCliEntry(), opts: { hook?: boolean; now?: boolean } = {}): boolean {
  try {
    if (!cli || noBackgroundChildren() || process.env.OAK_INDEX === 'off' || !nodeRunsIndex(process.version)) return false;
    const claim = kickClaim();
    try {
      // Within a minute of the last start, or inside a backoff (a claim dated ahead, no further than the backoff: one
      // further ahead than that is a clock that was stepped back). `now` (a hook that moved a hand) is held off by a
      // backoff alone: the build a minute's claim stands for may have read the hand before it moved, and one running
      // then takes the new claim for another pass (`claimTouchedSince`).
      const age = Date.now() - fs.statSync(claim).mtimeMs;
      if (age < KICK_MS && age > -KICK_BACKOFF_MS - KICK_MS && (!opts.now || age < 0)) return false;
    } catch {
      /* never kicked */
    }
    if (opts.hook && !fs.existsSync(path.join(rootDir(), 'sync', 'status.json'))) return false;
    fs.mkdirSync(indexDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(claim, String(process.pid), { mode: 0o600 });
    const child = spawnTool(process.execPath, [cli, '__index-build'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      /* the next kick tries again */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Whether a kick claimed a build after `since` (and not into a backoff): a build that began at `since` then takes
 *  another pass, for what the kick was for. */
export function claimTouchedSince(since: number): boolean {
  try {
    const at = fs.statSync(kickClaim()).mtimeMs;
    return at > since && at <= Date.now();
  } catch {
    return false;
  }
}

/** A build that could not open the index (this Node cannot run it, a newer OAK wrote it, its file is damaged): the next
 *  kick waits KICK_BACKOFF_MS, rather than one doomed process a minute while the hooks fire. */
export function backOffIndexBuild(): void {
  try {
    const claim = kickClaim();
    fs.mkdirSync(indexDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(claim, String(process.pid), { mode: 0o600 });
    const until = new Date(Date.now() + KICK_BACKOFF_MS);
    fs.utimesSync(claim, until, until);
  } catch {
    /* the next kick tries again */
  }
}

/** The store a file of the index belongs to: 16 hex digits of the sha256 of its folder. */
export function storeKey(root: string = rootDir()): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
}

export function indexFile(format: number = INDEX_FORMAT, root: string = rootDir()): string {
  return path.join(indexDir(), `index-v${format}-${storeKey(root)}.sqlite`);
}

/** One index file in the folder, with SQLite's own files beside it. */
export interface IndexFileInfo {
  file: string;
  format: number;
  key: string;
  bytes: number;
  mtimeMs: number;
  /** The file this OAK opens for the store it uses now. */
  current: boolean;
}

const NAME = /^index-v(\d+)-([0-9a-f]{16})\.sqlite$/;

/** Every index file in the folder, newest first; SQLite's `-wal` and `-shm` files count toward each one's bytes. */
export function indexFiles(): IndexFileInfo[] {
  const dir = indexDir();
  const current = indexFile();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: IndexFileInfo[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    let bytes = 0;
    let mtimeMs = 0;
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        const st = fs.statSync(f);
        bytes += st.size;
        if (f === file) mtimeMs = st.mtimeMs;
      } catch {
        /* SQLite's side files come and go */
      }
    }
    out.push({ file, format: Number(m[1]), key: m[2], bytes, mtimeMs, current: file === current });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Remove an index file with its side files; true when nothing of it is left. */
export function removeIndexFile(file: string): boolean {
  let ok = true;
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}
