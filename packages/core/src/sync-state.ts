/**
 * oak sync's own state, in the store's `sync/` folder. Nothing here is Claude Code's or Codex's: it is what a
 * machine knows about the copies it pulled, kept so that unchanged files cost nothing, merges have a base, every
 * write can be traced, and what was overwritten can be brought back.
 *
 * - `manifest.jsonl`: one record per file sync has seen here (SyncManifestEntry): its size, modification time and
 *   hash as sync last left or saw it, the machine it came from, and for small text files the hashes it has had
 *   here, oldest first, which is how a three-way merge finds its base.
 * - `objects/<sha256>`: content-addressed copies of those text versions, the merge bases.
 * - `audit.jsonl`: an append-only line for every write sync makes, and why.
 * - `trash/<YYYY-MM-DD>/<family>/<name>`: what a write replaced or a delete removed, kept SYNC_TRASH_DAYS (a
 *   second copy of a name the same day under `<family>.1`, and so on).
 * - `conflicts/<machine>/<family>/<name>`: another machine's copy that could not be merged, and
 *   `conflicts.json`, the open ones; `dismissed.json`, the diverged copies a person dismissed by deleting theirs.
 * - `tombstones.jsonl`: deliberate deletes (a session deleted with `oak sessions --delete`, a skill or plan
 *   removed), which other machines apply; a retention sweep is never one.
 * - `index/<host>.json`: each other machine's last inventory, which lets this one list everything.
 * - `records-survey.json`: the record segments every saved machine and the backup listed in a complete run. A partial
 *   index read can stop waiting for a lost segment only when this later survey says none holds it or another base.
 * - `evicted.jsonl`: the OAK store sessions this machine removed (`oak clean`, a dropped session; store.ts writes the line
 *   as it removes one), and the copies of other machines' sessions it let go because their machine cleaned them up
 *   (sync-store.ts): neither is pulled again.
 * - `replicas/<host>/<session>/`: the copies this machine holds of other machines' OAK store sessions (sync-store.ts).
 * - `key`: the key of the encrypted backup folder (sync-crypto.ts), and `folder/`, what this machine knows of that
 *   folder (sync-folder.ts). The key is never written to the folder.
 * - `status.json`: the last run, per machine. `now.lock` and `inflight.jsonl` keep one run at a time and let the
 *   next run clean up after one that was killed; `backoff.json` holds the background runs off after failures in a
 *   row (sync-kick.ts).
 * - `settings.json`: a copy of oak sync's settings and `machineUsage` from prefs.json (keptPrefs), which an OAK older than
 *   0.11.0 drops when it rewrites that file.
 * - `blobs/README`: what keeps OAK 0.10's `oak clean` off this folder (store.ts keepFromOldClean).
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { rootDir, keepOwnFoldersFromOldClean, keepFromOldClean, withPrefsMutation } from './store';
import { prefsPath, parsePrefs, PREFS_FORMAT_KEY, PREFS_FORMAT, type Prefs } from './prefs';
import { graphemeHead } from './graphemes';

export const SYNC_TRASH_DAYS = 30;
/** A text file keeps at most this many past hashes; a common ancestor further back is not found, and its merge
 *  becomes a conflict instead. */
export const SYNC_HISTORY_MAX = 32;

export const syncDir = (): string => path.join(rootDir(), 'sync');
const at = (...p: string[]): string => path.join(syncDir(), ...p);

/** The name of a temporary file a run writes beside its target: short whatever the target's name (one near the file
 *  system's 255-byte limit leaves no room for a suffix), and of the form clearInflight removes. */
export const tempName = (): string => `.oak-sync-${randomBytes(6).toString('hex')}.tmp`;

/** Write a file whole or not at all: a temporary file beside it, flushed, then renamed over it. The temporary file is
 *  named after the first 64 characters of the file's name, so a long name still leaves room for its suffix. */
export function writeAtomic(file: string, data: string | Buffer, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `${graphemeHead(path.basename(file), 64)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** What sync knows of one file here. `name` is relative to its family's root, as in an inventory. */
export interface SyncManifestEntry {
  family: string;
  name: string;
  size: number;
  mtime: number;
  /** sha256 of the whole file at `size`: for an append-only file, what a peer's prefix is checked against. */
  sha256?: string | null;
  /** The machine it came from (machineHostTag), that machine's label here, and its name there; absent for this
   *  machine's own. */
  origin?: string;
  originLabel?: string;
  originName?: string;
  /** A text file's past hashes here, oldest first, the last of them its hash when sync last saw it. */
  history?: string[];
  /** Fetched on demand: a copy this machine may evict, since its origin or the backup holds it. */
  cached?: true;
  /** A copy changed here after it was copied (a session resumed on this machine): this machine's own from then on, for
   *  good, and never evicted, whatever sync records of it later. */
  changed?: true;
  /** When it was last fetched or refreshed (epoch ms). */
  usedAt?: number;
  /** The machine and name it was last pulled from: what eviction checks still holds a copy. */
  source?: { host: string; name: string };
  /** The identity key of the project it was pulled under, for a folder whose files all come from other machines. */
  key?: string;
  /** A mirrored copy's stamp on the machine it came from (SyncFile.stamp), as it landed. */
  stamp?: string;
}

export type SyncManifest = Map<string, SyncManifestEntry>;
export const manifestKey = (family: string, name: string): string => `${family}\0${name}`;

/** The manifest, or an empty one; a torn line is skipped. */
export function readManifest(): SyncManifest {
  const out: SyncManifest = new Map();
  let text = '';
  try {
    text = fs.readFileSync(at('manifest.jsonl'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as SyncManifestEntry;
      if (e && typeof e.family === 'string' && typeof e.name === 'string' && typeof e.size === 'number') out.set(manifestKey(e.family, e.name), e);
    } catch {
      /* torn */
    }
  }
  return out;
}

export function writeManifest(m: SyncManifest): void {
  writeAtomic(at('manifest.jsonl'), [...m.values()].map((e) => JSON.stringify(e)).join('\n') + (m.size ? '\n' : ''));
}

/** Add one file's record to the manifest as soon as the file has landed: a run killed before it writes the manifest
 *  whole (writeManifest) still knows where that file came from. The last record for a file is the one read. */
export function appendManifest(e: SyncManifestEntry): void {
  fs.mkdirSync(syncDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(at('manifest.jsonl'), JSON.stringify(e) + '\n', { mode: 0o600 });
}

/** Store `data` as an object, named by its hash. */
export function putObject(data: Buffer): string {
  const objectId = sha256(data);
  const file = at('objects', objectId.slice(0, 2), objectId);
  if (!fs.existsSync(file)) writeAtomic(file, data);
  return objectId;
}

export function readObject(objectId: string): Buffer | null {
  if (!/^[0-9a-f]{64}$/.test(objectId)) return null;
  try {
    const b = fs.readFileSync(at('objects', objectId.slice(0, 2), objectId));
    return sha256(b) === objectId ? b : null;
  } catch {
    return null;
  }
}

/** Remove the objects no manifest history names. */
export function pruneObjects(m: SyncManifest): void {
  const keep = new Set<string>();
  for (const e of m.values()) for (const h of e.history ?? []) keep.add(h);
  let shards: string[];
  try {
    shards = fs.readdirSync(at('objects'));
  } catch {
    return;
  }
  for (const s of shards) {
    let names: string[];
    try {
      names = fs.readdirSync(at('objects', s));
    } catch {
      continue;
    }
    for (const n of names) if (!keep.has(n)) fs.rmSync(at('objects', s, n), { force: true });
  }
}

/** One line in the audit log. */
export interface SyncAuditLine {
  at: number;
  op: 'create' | 'append' | 'copy' | 'merge' | 'replace' | 'delete' | 'conflict' | 'hide' | 'unhide' | 'evict' | 'backup' | 'earlier';
  family?: string;
  name?: string;
  from?: string;
  bytes?: number;
  sha256?: string | null;
  trash?: string;
  detail?: string;
}

export function audit(line: Omit<SyncAuditLine, 'at'> & { at?: number }): void {
  fs.mkdirSync(syncDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(at('audit.jsonl'), JSON.stringify({ at: Date.now(), ...line }) + '\n', { mode: 0o600 });
}

const day = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Copy a file's bytes into today's trash before it is overwritten or removed; the trash path, or null when there
 *  was no file. A name already in today's trash goes under a numbered family folder (`<family>.1`), so no earlier
 *  version is lost and the name keeps its length. */
export function toTrash(family: string, name: string, file: string, now = Date.now()): string | null {
  if (!fs.existsSync(file)) return null;
  let dest = at('trash', day(now), family, ...name.split('/'));
  for (let n = 1; fs.existsSync(dest); n++) dest = at('trash', day(now), `${family}.${n}`, ...name.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.copyFileSync(file, dest);
  return dest;
}

/** Move a file into today's trash, as toTrash files a copy: for what is let go whole (a replica of a session its machine
 *  cleaned up), which a copy would hold twice. Copied and removed where a rename cannot reach the trash. */
export function moveToTrash(family: string, name: string, file: string, now = Date.now()): string {
  let dest = at('trash', day(now), family, ...name.split('/'));
  for (let n = 1; fs.existsSync(dest); n++) dest = at('trash', day(now), `${family}.${n}`, ...name.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(file, dest);
  } catch {
    fs.copyFileSync(file, dest);
    fs.rmSync(file, { force: true });
  }
  return dest;
}

/** Remove trash older than SYNC_TRASH_DAYS. */
export function pruneTrash(now = Date.now()): void {
  let days: string[];
  try {
    days = fs.readdirSync(at('trash'));
  } catch {
    return;
  }
  const cutoff = day(now - SYNC_TRASH_DAYS * 86_400_000);
  for (const d of days) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) fs.rmSync(at('trash', d), { recursive: true, force: true });
}

/** A copy from another machine that could not be merged with this machine's, kept for the person to resolve. */
export interface SyncConflict {
  id: string;
  family: string;
  /** This machine's file, relative to the family's root. */
  name: string;
  from: string;
  host: string;
  at: number;
  /** The other machine's copy, as it was when the conflict was raised, and where it is kept here. */
  peerSha256: string | null;
  peerSize: number;
  copy: string;
  /** This machine's copy then. */
  localSha256: string | null;
  reason: 'diverged' | 'no-base' | 'overlap' | 'binary';
}

export const conflictCopyPath = (label: string, family: string, name: string): string =>
  at('conflicts', label.replace(/[^A-Za-z0-9._-]/g, '_') || 'machine', family, ...name.split('/'));

export function readConflicts(): SyncConflict[] {
  try {
    const v = JSON.parse(fs.readFileSync(at('conflicts.json'), 'utf8'));
    return Array.isArray(v) ? v.filter((c) => c && typeof c.id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeConflicts(list: SyncConflict[]): void {
  writeAtomic(at('conflicts.json'), JSON.stringify(list));
}

/** Another machine's diverged copy of an append-only file whose conflict copy a person deleted, so this machine's
 *  stands: not fetched again, nor raised again, while that machine's copy is still this size. */
export interface SyncDismissal {
  family: string;
  name: string;
  host: string;
  size: number;
}

export function readDismissals(): SyncDismissal[] {
  try {
    const v = JSON.parse(fs.readFileSync(at('dismissed.json'), 'utf8'));
    return Array.isArray(v) ? v.filter((d) => d && typeof d.family === 'string' && typeof d.name === 'string' && typeof d.host === 'string' && typeof d.size === 'number') : [];
  } catch {
    return [];
  }
}

export function writeDismissals(list: SyncDismissal[]): void {
  if (!list.length && !fs.existsSync(at('dismissed.json'))) return;
  writeAtomic(at('dismissed.json'), JSON.stringify(list));
}

/** A deliberate delete, or its reversal: a session hidden with `oak sessions --delete` (and shown again with
 *  `--undelete`), or a text file a person removed. The latest event for a key wins on every machine. */
export interface SyncTombstone {
  kind: 'session' | 'file';
  /** The session id, or `<family>/<name>` for a file. */
  key: string;
  deleted: boolean;
  at: number;
  /** The machine it happened on (machineHostTag). */
  host: string;
  /** For a file: its hash when it was removed, and the versions it had here before, oldest first. Another machine
   *  removes its copy only when it is one of them: a copy edited apart is kept, and one that missed the last edits
   *  goes too, rather than bringing the file back with its old text. */
  sha256?: string | null;
  history?: string[];
  /** For another machine's event dated more than a day ahead of this machine's clock when it arrived (that machine's
   *  clock is wrong): the time it carried. `at` is then a day after it arrived, so it cannot outrank every later
   *  change until its own time comes. */
  sentAt?: number;
}

export function readTombstones(): SyncTombstone[] {
  try {
    return fs.readFileSync(at('tombstones.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        const t = JSON.parse(l);
        return t && (t.kind === 'session' || t.kind === 'file') && typeof t.key === 'string' && typeof t.at === 'number' ? [t as SyncTombstone] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function addTombstones(list: SyncTombstone[]): void {
  if (!list.length) return;
  fs.mkdirSync(syncDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(at('tombstones.jsonl'), list.map((t) => JSON.stringify(t) + '\n').join(''), { mode: 0o600 });
}

/** The latest event for each key. */
export function latestTombstones(list: SyncTombstone[]): Map<string, SyncTombstone> {
  const out = new Map<string, SyncTombstone>();
  for (const t of list) {
    const k = `${t.kind}\0${t.key}`;
    const was = out.get(k);
    if (!was || t.at > was.at || (t.at === was.at && t.host > was.host)) out.set(k, t);
  }
  return out;
}

/** What a previous run saw of this machine's deleted sessions, so a run records only what changed since. A session seen
 *  there that is no longer deleted was put back here since (`oak sessions --undelete`), which no tombstone says until the
 *  next run records it. */
export const seenPath = (): string => at('seen.json');
export function readSeen(): { hidden: string[] } {
  try {
    const v = JSON.parse(fs.readFileSync(seenPath(), 'utf8'));
    return { hidden: Array.isArray(v.hidden) ? v.hidden.filter((x: unknown) => typeof x === 'string') : [] };
  } catch {
    return { hidden: [] };
  }
}

/** Another machine's last inventory, kept as the index. */
export function writeIndex(host: string, label: string, inventory: unknown): void {
  if (!/^[0-9a-f]{12}$/.test(host)) return;
  writeAtomic(at('index', `${host}.json`), JSON.stringify({ label, savedAt: Date.now(), inventory }));
}

export function readIndex(): { host: string; label: string; savedAt: number; inventory: unknown }[] {
  let names: string[];
  try {
    names = fs.readdirSync(at('index'));
  } catch {
    return [];
  }
  const out: { host: string; label: string; savedAt: number; inventory: unknown }[] = [];
  for (const n of names) {
    if (!/^[0-9a-f]{12}\.json$/.test(n)) continue;
    try {
      const v = JSON.parse(fs.readFileSync(at('index', n), 'utf8'));
      out.push({ host: path.basename(n, '.json'), label: String(v.label ?? ''), savedAt: Number(v.savedAt) || 0, inventory: v.inventory });
    } catch {
      /* torn */
    }
  }
  return out;
}

/** The temporary files a run is writing beside their targets, so the next run removes any a killed run left. */
export function noteInflight(tmp: string): void {
  fs.mkdirSync(syncDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(at('inflight.jsonl'), JSON.stringify(tmp) + '\n', { mode: 0o600 });
}

/** Remove what a killed run left half written, and forget the list. Run under the lock, before anything else. */
export function clearInflight(): string[] {
  let text: string;
  try {
    text = fs.readFileSync(at('inflight.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const l of text.split('\n')) {
    try {
      const p = JSON.parse(l);
      // tempName's form, and the longer `.<name>.oak-sync-<pid>.tmp` an earlier build of this release wrote.
      if (typeof p === 'string' && /\.oak-sync-[0-9a-f]+\.tmp$/.test(p) && fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        removed.push(p);
      }
    } catch {
      /* torn */
    }
  }
  fs.rmSync(at('inflight.jsonl'), { force: true });
  return removed;
}

/** A run's lock is stale past this, whoever holds it. Here, not in the sync engine, so a store move looks for a run
 *  without it: a capture hook's bundle carries the store's code, and none of the engine's. */
export const SYNC_RUN_STALE_MS = 30 * 60_000;

/** The lock that keeps one `oak sync now` at a time on this machine: a live pid, or a lock too young to carry one.
 *  A lock older than `staleMs` is stale whoever holds it. A stale lock is broken by one run at a time, under a
 *  token of its own, and only once that run has seen it is still stale: two runs that both found it stale would
 *  otherwise each remove it, the second removing the lock the first had just taken, and both run. */
export function takeSyncLock(staleMs: number): boolean {
  const file = at('now.lock');
  fs.mkdirSync(syncDir(), { recursive: true, mode: 0o700 });
  keepOwnFoldersFromOldClean();
  keptPrefs(true);
  const tryTake = (): boolean => {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  if (tryTake()) return true;
  if (syncLockHeld(staleMs)) return false;
  const token = at('now.lock.break');
  try {
    fs.closeSync(fs.openSync(token, 'wx', 0o600));
  } catch {
    // Another run is breaking it; or one was killed doing so, whose token is old.
    try {
      if (Date.now() - fs.statSync(token).mtimeMs > 60_000) fs.rmSync(token, { force: true });
    } catch {
      /* gone already */
    }
    return false;
  }
  try {
    if (syncLockHeld(staleMs)) return false;
    fs.rmSync(file, { force: true }); // a killed or hung owner's
    return tryTake();
  } finally {
    fs.rmSync(token, { force: true });
  }
}

export function syncLockHeld(staleMs: number): boolean {
  const file = at('now.lock');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (Date.now() - st.mtimeMs > staleMs || st.mtimeMs - Date.now() > 60_000) return false;
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  } catch {
    return Date.now() - st.mtimeMs < 5_000; // between creating the lock and writing its pid
  }
}

/** Mark this run's lock alive: a run that moves bytes for longer than the stale time is not taken for a dead one. */
export function touchSyncLock(): void {
  try {
    const now = new Date();
    fs.utimesSync(at('now.lock'), now, now);
  } catch {
    /* gone: the next run takes it */
  }
}

export function releaseSyncLock(): void {
  try {
    const { pid } = JSON.parse(fs.readFileSync(at('now.lock'), 'utf8'));
    if (pid === process.pid) fs.rmSync(at('now.lock'), { force: true });
  } catch {
    /* gone already */
  }
}

/** One line of `evicted.jsonl`, which is only ever appended to (the store's removeSession appends too, under no lock of
 *  sync's): an OAK store session removed here (no `origin`: this machine's own, removed by `oak clean` or a dropped
 *  session; store.ts writes it), or another machine's whose copy this machine let go (`origin`). `back` cancels the
 *  latest before it: the session is held again (made anew here, or held again by its machine). */
export interface SyncEviction {
  id: string;
  at: number;
  origin?: string;
  back?: true;
  /** For this machine's own session: the generation of the folder removed (store.ts sessionGeneration). */
  gen?: string;
}

/** The path store.ts appends to as it removes a session: kept in step with noteStoreEviction there. */
const evictionsPath = (): string => at('evicted.jsonl');

export function readEvictions(): SyncEviction[] {
  let text: string;
  try {
    text = fs.readFileSync(evictionsPath(), 'utf8');
  } catch {
    return [];
  }
  const out: SyncEviction[] = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (e && typeof e.id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(e.id) && e.id !== '.' && e.id !== '..' && typeof e.at === 'number'
        && (e.origin === undefined || (typeof e.origin === 'string' && /^[0-9a-f]{12}$/.test(e.origin)))) {
        out.push({ id: e.id, at: e.at, ...(e.origin ? { origin: e.origin } : {}), ...(e.back === true ? { back: true as const } : {}),
          ...(typeof e.gen === 'string' && /^[0-9a-f]{16}$/.test(e.gen) ? { gen: e.gen } : {}) });
      }
    } catch {
      /* torn */
    }
  }
  return out;
}

/** What the list says now, the latest line for each session winning (by its time, then by its place in the file: a
 *  removal appended while a run was deciding is newer than what the run then appends): this machine's own sessions it
 *  removed, and the copies (`<origin>/<id>`) it let go, each with when; and the generation of each own session's folder
 *  removed, where its line names one (`gens`). */
export function currentEvictions(list = readEvictions()): { own: Map<string, number>; copies: Map<string, number>; gens: Map<string, string> } {
  const latest = new Map<string, SyncEviction>();
  for (const e of list) {
    const k = e.origin ? `${e.origin}/${e.id}` : `\0${e.id}`;
    const was = latest.get(k);
    if (!was || e.at >= was.at) latest.set(k, e);
  }
  const own = new Map<string, number>();
  const copies = new Map<string, number>();
  const gens = new Map<string, string>();
  for (const [k, e] of latest) {
    if (e.back) continue;
    if (e.origin) copies.set(k, e.at);
    else {
      own.set(e.id, e.at);
      if (e.gen) gens.set(e.id, e.gen);
    }
  }
  return { own, copies, gens };
}

export function addEvictions(list: SyncEviction[]): void {
  if (!list.length) return;
  fs.mkdirSync(syncDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(evictionsPath(), list.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
}

/** This machine's own sessions it removed and does not hold now, with when: what its inventory says
 *  (SyncMachineState.evicted). A copy of one newer than that is a later life of it, which no machine takes for cleaned up;
 *  a run records it (`back`). */
export function ownEvictedSessions(): { id: string; at: number }[] {
  return [...currentEvictions().own].filter(([id]) => !fs.existsSync(path.join(rootDir(), id))).map(([id, at]) => ({ id, at }));
}

// ---------------------------------------------------------------------------------------------------------------
// oak sync's copy of its settings
// ---------------------------------------------------------------------------------------------------------------

/** The settings of prefs.json that an OAK older than 0.11.0 drops when it rewrites the file (it writes back only the
 *  keys it knows): oak sync's, and `machineUsage`. One left running beside this one (a terminal app, a VS Code window not
 *  reloaded since the update, the old CLI) stopped the backup without a word, and synced an excluded project again. */
const KEPT_PREFS = ['sync', 'machineUsage'] as const;
const settingsCopyPath = (): string => at('settings.json');

/** prefs.json as it is: what it holds (null for a file that is not a JSON object, {} for none), its text, and whether an
 *  OAK older than 0.11.0 wrote it last: it lacks the mark every later OAK writes (prefs.ts PREFS_FORMAT_KEY), which such
 *  an OAK drops with every other key it does not know. A person's edit leaves the mark where it is. */
function readPrefsFile(): { raw: Record<string, unknown> | null; text: string | null; older: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(prefsPath(), 'utf8');
  } catch (e) {
    return { raw: (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null, text: null, older: false };
  }
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? { raw: v as Record<string, unknown>, text, older: v[PREFS_FORMAT_KEY] === undefined } : { raw: null, text, older: false };
  } catch {
    return { raw: null, text, older: false };
  }
}

/** `settings.json`: those settings as prefs.json last held them (a key absent there is absent here), and the last time
 *  one was put back in prefs.json: when, which of them, and when an `oak` command run in a terminal said so. */
interface SettingsCopy {
  sync?: unknown;
  machineUsage?: unknown;
  restoredAt?: number;
  restored?: string[];
  toldAt?: number;
}

function readSettingsCopy(): SettingsCopy | null {
  try {
    const v = JSON.parse(fs.readFileSync(settingsCopyPath(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SettingsCopy) : null;
  } catch {
    return null;
  }
}

function writeSettingsCopy(copy: SettingsCopy): void {
  keepFromOldClean(syncDir());
  writeAtomic(settingsCopyPath(), JSON.stringify(copy) + '\n');
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What the copy puts back in prefs.json `raw`, which an older OAK wrote: each setting it dropped. One the file holds
 *  (written there since, by hand or by an OAK that knows it) stands as the file holds it. */
function dropped(raw: Record<string, unknown>, copy: SettingsCopy | null): Record<string, unknown> {
  const back: Record<string, unknown> = {};
  for (const k of KEPT_PREFS) if (raw[k] === undefined && copy?.[k] !== undefined) back[k] = copy[k];
  return back;
}

/** Make the copy hold `kept`'s settings (absent keys absent), keeping its record of the last restore, or recording one
 *  of `restored` now. */
function keepSettings(copy: SettingsCopy | null, kept: Record<string, unknown>, restored: readonly string[] = []): void {
  if (!restored.length && copy && KEPT_PREFS.every((k) => sameJson(copy[k], kept[k]))) return;
  const next: SettingsCopy = restored.length ? { restoredAt: Date.now(), restored: [...restored], toldAt: copy?.toldAt }
    : copy?.restoredAt ? { restoredAt: copy.restoredAt, restored: copy.restored, toldAt: copy.toldAt } : {};
  for (const k of KEPT_PREFS) if (kept[k] !== undefined) next[k] = kept[k];
  writeSettingsCopy(next);
}

/** For writePrefs, over a prefs.json an older OAK wrote: each kept setting the copy holds that `out` lacks (the file
 *  dropped it, so the writer did not set it) goes into `out` from the copy. Returns those, which noteKeptPrefs records.
 *  Never throws. */
export function keptOverOlder(out: Record<string, unknown>): string[] {
  try {
    const back = dropped(out, readSettingsCopy());
    Object.assign(out, back);
    return Object.keys(back);
  } catch {
    return [];
  }
}

/** After writePrefs wrote prefs.json as `out`, which carries the mark: the copy follows it, and records the restore of
 *  `restored` (keptOverOlder). Never throws. */
export function noteKeptPrefs(out: Record<string, unknown>, restored: readonly string[] = []): void {
  try {
    const copy = readSettingsCopy();
    if (!copy && !restored.length && KEPT_PREFS.every((k) => out[k] === undefined)) return;
    keepSettings(copy, out, restored);
  } catch {
    /* the copy follows the file at the next upkeep (keptPrefs) */
  }
}

/** Replace `file` with `next` unless it no longer holds `text`, under keptPrefs' lock shared with writePrefs. */
function replaceIfUnchanged(file: string, text: string | null, next: string): boolean {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, next);
    let now: string | null = null;
    try {
      now = fs.readFileSync(file, 'utf8');
    } catch {
      /* gone: nothing to put them back in */
    }
    if (now === null || now !== text) return false;
    fs.renameSync(tmp, file);
    return true;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * prefs.json as readPrefs reads it, with oak sync's settings and `machineUsage` kept: where an older OAK wrote the file
 * last (readPrefsFile), each of them it lacks is read from the copy (dropped), and one it holds (put there since) is its
 * own. Every reader of those settings reads through here; a file that is not JSON is read as no preferences, as readPrefs
 * reads it. Writes nothing, so a read-only command (`oak sync plan`, `oak sync status`) stays one. `upkeep`, from what
 * writes OAK's state anyway (an index catch-up, a sync run, the terminal app's launch): the copy follows a file a later
 * OAK wrote, as the person left it, and an older OAK's file is written back marked, with what it dropped, the restore
 * kept for `oak doctor` and for the next `oak` command run in a terminal to say (takeKeptPrefsNotice).
 */
export function keptPrefs(upkeep = false): Prefs {
  if (upkeep) {
    try {
      // A quiet upkeep must not even change its folder's time by making and removing a lock. Check for work first;
      // when there is any, read everything again under the lock shared with writePrefs.
      const { raw, older } = readPrefsFile();
      const copy = raw ? readSettingsCopy() : null;
      const needed = raw && (older ? Object.keys(dropped(raw, copy)).length || KEPT_PREFS.some((k) => raw[k] !== undefined)
        : (copy || KEPT_PREFS.some((k) => raw[k] !== undefined)) && (!copy || KEPT_PREFS.some((k) => !sameJson(copy[k], raw[k]))));
      if (needed) return withPrefsMutation(prefsPath(), () => keptPrefsLocked(true), 0);
    } catch {
      /* a busy or unwritable file: read the settings without writing them back */
    }
  }
  return keptPrefsLocked(false);
}

function keptPrefsLocked(upkeep: boolean): Prefs {
  const file = prefsPath();
  const was = readPrefsFile();
  let raw = was.raw;
  if (!raw) return {};
  try {
    if (!was.older) {
      if (upkeep) {
        const copy = readSettingsCopy();
        if (copy || KEPT_PREFS.some((k) => raw![k] !== undefined)) keepSettings(copy, raw);
      }
    } else {
      const copy = fs.existsSync(settingsCopyPath()) ? readSettingsCopy() : null;
      const back = dropped(raw, copy);
      const out: Record<string, unknown> = { [PREFS_FORMAT_KEY]: PREFS_FORMAT, ...raw, ...back };
      // Written back where it changes a setting or the copy, unless prefs.json changed since it was read here.
      if (upkeep && (Object.keys(back).length || KEPT_PREFS.some((k) => raw![k] !== undefined)) && replaceIfUnchanged(file, was.text, JSON.stringify(out, null, 2) + '\n')) {
        keepSettings(copy, out, Object.keys(back));
      }
      raw = out;
    }
  } catch {
    /* a store or a prefs.json that cannot be written: the settings as the file holds them */
  }
  return parsePrefs(raw);
}

/** The settings an older OAK dropped from prefs.json that the copy holds (keptPrefs reads them from it until an upkeep
 *  writes them back): what `oak doctor` says before a restore. */
export function keptPrefsLost(): string[] {
  const { raw, older } = readPrefsFile();
  return raw && older ? Object.keys(dropped(raw, readSettingsCopy())) : [];
}

/** The last time keptPrefs or writePrefs put the settings back in prefs.json, and which of them. */
export function keptPrefsRestore(): { at: number; keys: string[] } | null {
  const copy = readSettingsCopy();
  if (!copy || typeof copy.restoredAt !== 'number') return null;
  return { at: copy.restoredAt, keys: Array.isArray(copy.restored) ? copy.restored : [] };
}

/** What a restore of the settings says, on every surface that says it: what came back, from where, and why; `pending`,
 *  before an upkeep wrote them back (keptPrefsLost). */
export function keptPrefsWords(keys: readonly string[], pending = false): string {
  const what = keys.includes('sync') && keys.includes('machineUsage') ? 'oak sync\'s settings and "machineUsage"'
    : keys.includes('machineUsage') ? '"machineUsage"' : 'oak sync\'s settings';
  const them = keys.includes('sync') ? 'them' : 'it';
  const why = 'an OAK older than 0.11.0 rewrote the file with only the settings it knows';
  return pending
    ? `prefs.json has lost ${what}, so OAK reads ${them} from oak sync's copy (${settingsCopyPath()}) until the next sync run, or listing with the local database on, writes ${them} back: ${why}`
    : `prefs.json had lost ${what}, so OAK put ${them} back from oak sync's copy (${settingsCopyPath()}): ${why}`;
}

/** The restore not said yet, once: the line an `oak` command run in a terminal prints after its own output, or the
 *  terminal app on its first status row. Null when there is none. */
export function takeKeptPrefsNotice(): string | null {
  try {
    const copy = readSettingsCopy();
    if (!copy || typeof copy.restoredAt !== 'number' || (copy.toldAt ?? 0) >= copy.restoredAt) return null;
    writeSettingsCopy({ ...copy, toldAt: Date.now() });
    return keptPrefsWords(Array.isArray(copy.restored) ? copy.restored : []);
  } catch {
    return null;
  }
}
