/**
 * OAK's own store as oak sync families (sync.ts registerSyncFamily): each session's edit log, the content snapshots it
 * names, its comments and agent record, and its hook events, on every machine that should hold them.
 *
 * - `oak-log` (`<session>/log.jsonl`): mirrored whole, on every machine. A log has one writer, the machine that runs
 *   the session, but that machine rewrites it (a clear, an ignore sweep), so a copy is never extended by its tail: it is
 *   replaced whenever the log's stamp changes (its device, inode, size, time or first bytes; SyncFile.stamp), the copy
 *   it replaces to the trash first.
 * - `oak-blobs` (`<session>/blobs/<sha256>`): content-addressed, copied by name and checked by hash; on the machine that
 *   made them and the backup, and fetched on demand (`oak sync fetch`) anywhere else.
 * - `oak-meta` (`<session>/agent.json`, and the session's comments, in either place OAK keeps them:
 *   `changemap-cache/<session>/comments.json`, where comments.ts writes them, or `<session>/comments.json`, where they are
 *   moving): small files one machine writes whole, mirrored on every machine.
 * - `oak-events` (`<session>/capture-events.jsonl`, `<session>/attention-log.jsonl`): append-only, on the machine that
 *   made them and the backup.
 *
 * A session id can repeat across machines (one Claude Code session resumed on two of them), so another machine's
 * session never lands at `<store>/<id>`: its copy is a REPLICA under `sync/replicas/<machine>/<id>/`, keyed by the
 * machine that made it (the `target` hook). This machine's own sessions are never taken in as replicas: a copy of one
 * found elsewhere is put back where it was, and only while the session is not here at all, or holds only what sync put
 * back (a restore a run left unfinished), and was never removed here on purpose.
 *
 * Removing a session here (`oak clean`, a dropped session) records it in `sync/evicted.jsonl` (store.ts), so no copy
 * brings it back, and the inventory says so (SyncMachineState.evicted). A machine that sees, in an inventory read this
 * run from the machine that made it, that the session is gone there and was cleaned up, lets its own copy go too (to the
 * trash, with an audit line and an eviction record of its own); one gone there with no cleanup recorded may be lost, and
 * its copy, which may be the last, is kept. A deliberate delete (`oak sessions --delete`, a tombstone, no eviction)
 * removes every copy of the session; the machine that made it removes its store too, and an undelete there brings it
 * back from the backup folder, when one holds it.
 *
 * A session's folder can be lost with no cleanup (a store removed by hand, a crash, a machine reinstalled and used
 * before its first restore), and the next capture makes it again with a fresh log. That folder is a new GENERATION of
 * the session, and never replaces the history the copies hold of the one before it: each session folder carries a
 * generation id (store.ts SESSION_GENERATION_FILE), which a run writes when it first sees the folder or puts it back,
 * and a rewrite of the log (a clear, an ignore sweep) before it, and a capture never: a folder a capture made anew has
 * none, or another. A copy of an earlier generation is kept as a session of its own, `<session>_earlier-<generation>`
 * (earlierGenerationId), which the backup folder's record keeps too (sync-folder.ts), is put back like any session, is
 * listed as the earlier history of its session, and is never replaced again. A folder cleaned up here and made again
 * by a capture before a run saw it goes on from the generation of the one cleaned up (its eviction line names it): what
 * was cleaned up went on purpose, and is kept nowhere.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { rootDir, allStoreSessionIds, isSafeSessionId, isReservedStoreDir, earlierGenerationId, sessionGeneration, writeSessionGeneration, readLogFile, SESSION_GENERATION_FILE } from './store';
import { registerSyncFamily, safeSyncName, SYNC_GEN, type SyncFamily, type SyncFile, type SyncInventory, type SyncListContext, type SyncNode } from './sync';
import * as state from './sync-state';
import { machineHostTag } from './machine-usage';
import { segments, recordHosts, coverage, covers, sealRecords, type Coverage } from './index/records';

/** Where the copies of other machines' sessions are kept, relative to the store root. */
export const SYNC_REPLICAS = 'sync/replicas';
const HOST = /^[0-9a-f]{12}$/;
/** How much of a mirrored file's head its stamp hashes. */
const STAMP_HEAD = 4096;

/** A name of an OAK family, taken apart: this machine's own session file, a copy of another machine's, or the comments
 *  in the cache folder (`changemap-cache/<session>/comments.json`). `rest` is the file within the session. */
export interface StoreName {
  kind: 'own' | 'replica' | 'old-comments';
  origin?: string;
  sid: string;
  rest: string;
}

/** Which ids were found to be session folders: a run asks the same few hundred ids for every file of theirs. */
const sessionOkMemo = new Map<string, boolean>();

/** A session id that can be a store folder: safe as one path segment (Windows' rules included), and no folder the
 *  store keeps for itself. */
function sessionOk(s: string): boolean {
  let ok = sessionOkMemo.get(s);
  if (ok === undefined) {
    ok = isSafeSessionId(s) && !isReservedStoreDir(s) && safeSyncName(s);
    if (sessionOkMemo.size > 100_000) sessionOkMemo.clear();
    sessionOkMemo.set(s, ok);
  }
  return ok;
}

/** The files a session folder holds that sync carries, every one a plain name of safe characters. */
const REST = '(log\\.jsonl|agent\\.json|comments\\.json|capture-events\\.jsonl|attention-log\\.jsonl|blobs/[0-9a-f]{64})';
const OWN_NAME = new RegExp(`^([^/]+)/${REST}$`);
const REPLICA_NAME = new RegExp(`^sync/replicas/([0-9a-f]{12})/([^/]+)/${REST}$`);
const OLD_COMMENTS_NAME = /^changemap-cache\/([^/]+)\/comments\.json$/;

export function parseStoreName(name: string): StoreName | null {
  if (typeof name !== 'string' || name.length > 4096) return null;
  let m = REPLICA_NAME.exec(name);
  if (m) return sessionOk(m[2]) ? { kind: 'replica', origin: m[1], sid: m[2], rest: m[3] } : null;
  m = OLD_COMMENTS_NAME.exec(name);
  if (m) return sessionOk(m[1]) ? { kind: 'old-comments', sid: m[1], rest: 'comments.json' } : null;
  m = OWN_NAME.exec(name);
  return m && sessionOk(m[1]) ? { kind: 'own', sid: m[1], rest: m[2] } : null;
}

/** A mirrored file's stamp: its device, inode, size and time, and the hash of its first bytes, so that a log rewritten
 *  in place or renamed over (a clear) reads as changed whatever its size and time. */
export function storeStamp(st: fs.Stats, fd: number): string {
  const head = Buffer.alloc(Math.min(STAMP_HEAD, st.size));
  let got = 0;
  while (got < head.length) {
    const n = fs.readSync(fd, head, got, head.length - got, got);
    if (n === 0) break;
    got += n;
  }
  const h = createHash('sha256').update(head.subarray(0, got)).digest('hex').slice(0, 16);
  return `${st.dev}:${st.ino}:${st.size}:${Math.floor(st.mtimeMs)}:${h}`;
}

function stampFile(file: string, st: fs.Stats): string | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      return storeStamp(st, fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------------------------------------------

/** The generation of this machine's own session folder `sid` (store.ts sessionGeneration): one a capture made again
 *  after this machine cleaned it up, before a run saw it, goes on from the folder cleaned up. */
export function ownGeneration(sid: string): { gen: string | null; marked: boolean } {
  return sessionGeneration(path.join(rootDir(), sid), evictions().gens.get(sid) ?? null);
}

/** Give each of this machine's session folders that has none its generation, before a run plans: the hash of its log's
 *  first line, so a copy another machine took before it was marked names the same one, or a random one for a folder
 *  with no log yet. A folder a run is putting back is not marked here: the generation of what it came from is
 *  (noteLandedGenerations). Returns the sessions marked. */
export function markStoreGenerations(): string[] {
  const out: string[] = [];
  for (const sid of allStoreSessionIds()) {
    if (!sessionOk(sid)) continue;
    const dir = path.join(rootDir(), sid);
    if (fs.existsSync(path.join(dir, SESSION_GENERATION_FILE)) || restoringSession(sid)) continue;
    try {
      writeSessionGeneration(dir, ownGeneration(sid).gen ?? randomBytes(8).toString('hex'));
      out.push(sid);
    } catch {
      /* gone meanwhile, or not writable: the next run marks it */
    }
  }
  return out;
}

/** Mark this machine's session folder `sid` with `gen` where it has no generation yet: what a push does for each folder
 *  its record names from then on (sync-folder.ts). A folder gone is not made again for it. */
export function markSessionGeneration(sid: string, gen: string): void {
  const dir = path.join(rootDir(), sid);
  if (!sessionOk(sid) || !SYNC_GEN.test(gen) || fs.existsSync(path.join(dir, SESSION_GENERATION_FILE))) return;
  try {
    writeSessionGeneration(dir, gen);
  } catch {
    /* gone meanwhile, or not writable: the next run marks it */
  }
}

/** The generation each session of an inventory carries (SyncFile.gen), by the name its files have there up to the
 *  session (`<session>/`, `sync/replicas/<machine>/<session>/`, or the old comments' `changemap-cache/<session>/`, as
 *  the session's own folder). */
function generationsOf(inv: SyncInventory): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of STORE_FAMILY_IDS) {
    for (const e of inv.families[id] ?? []) {
      const p = e.gen ? parseStoreName(e.name) : null;
      if (!p) continue;
      out.set(p.kind === 'replica' ? `${SYNC_REPLICAS}/${p.origin}/${p.sid}/` : `${p.sid}/`, e.gen!);
    }
  }
  return out;
}

/**
 * After a run pulled: mark each session folder a file of OAK's store landed in with the generation of the copy it came
 * from, the copy its log came from where its log landed. A copy of another machine's session takes that machine's; a
 * session of this machine's own put back takes it only while it holds nothing but what sync put back, and only once
 * its log is back too (where the copy has one): a capture that made the folder, or started its log, meanwhile made a
 * new generation, which the next run keeps apart from the record's. `inventoryOf` gives the inventory of the machine
 * (or backup copy) a file came from.
 */
export function noteLandedGenerations(done: { family: string; from: string; name: string; to: string; action: string }[], inventoryOf: (label: string) => SyncInventory | undefined): void {
  resetStoreSyncMemo();
  const folders = new Map<string, { own: boolean; sid: string; from: string; name: string; log: boolean }>();
  for (const d of done) {
    if (!(STORE_FAMILY_IDS as readonly string[]).includes(d.family) || !['create', 'append', 'replace'].includes(d.action)) continue;
    const p = parseStoreName(d.to);
    if (!p || p.kind === 'old-comments') continue;
    const rel = p.kind === 'replica' ? `${SYNC_REPLICAS}/${p.origin}/${p.sid}` : p.sid;
    const log = d.family === 'oak-log';
    if (!folders.has(rel) || (log && !folders.get(rel)!.log)) folders.set(rel, { own: p.kind === 'own', sid: p.sid, from: d.from, name: d.name, log });
  }
  const gens = new Map<string, Map<string, string>>();
  for (const [rel, f] of folders) {
    const inv = inventoryOf(f.from);
    const src = parseStoreName(f.name);
    if (!inv || !src) continue;
    if (!gens.has(f.from)) gens.set(f.from, generationsOf(inv));
    const at = src.kind === 'replica' ? `${SYNC_REPLICAS}/${src.origin}/${src.sid}/` : `${src.sid}/`;
    const gen = gens.get(f.from)!.get(at);
    const dir = path.join(rootDir(), ...rel.split('/'));
    try {
      if (f.own) {
        const logBack = fs.existsSync(path.join(dir, 'log.jsonl')) || !(inv.families['oak-log'] ?? []).some((e) => e.name === `${at}log.jsonl`);
        if (gen && logBack && !fs.existsSync(path.join(dir, SESSION_GENERATION_FILE)) && restoringSession(f.sid)) writeSessionGeneration(dir, gen);
      } else if (gen) {
        if (sessionGeneration(dir).gen !== gen || !fs.existsSync(path.join(dir, SESSION_GENERATION_FILE))) writeSessionGeneration(dir, gen);
      } else fs.rmSync(path.join(dir, SESSION_GENERATION_FILE), { force: true }); // a copy that names none is no generation's
    } catch {
      /* gone meanwhile: the next landing marks it */
    }
  }
  resetStoreSyncMemo();
}

// ---------------------------------------------------------------------------------------------------------------
// Evictions
// ---------------------------------------------------------------------------------------------------------------

interface EvictionMemo {
  root: string;
  own: Map<string, number>;
  copies: Map<string, number>;
  /** The generation of each own session's folder cleaned up, where the list names one (ownGeneration). */
  gens: Map<string, string>;
  here: Map<string, boolean>;
  restoring: Map<string, boolean>;
  /** The snapshots each own session's log here names (namedHere). */
  named: Map<string, Set<string>>;
  manifest: state.SyncManifest | null;
}
let evictionMemo: EvictionMemo | null = null;
/** The memo as this turn of the event loop found it: a plan asks it for every file, and the store's root is looked up
 *  once a turn, as rootDir itself does. */
let evictionTurn: EvictionMemo | null = null;

/** What `sync/evicted.jsonl` holds, read once per store root until resetStoreSyncMemo (each run starts with one), and
 *  which sessions are in the store, asked once each. */
function evictions(): EvictionMemo {
  if (evictionTurn) return evictionTurn;
  const root = rootDir();
  if (evictionMemo?.root !== root) {
    const { own, copies, gens } = state.currentEvictions();
    evictionMemo = { root, own, copies, gens, here: new Map(), restoring: new Map(), named: new Map(), manifest: null };
  }
  const memo: EvictionMemo = evictionMemo;
  evictionTurn = memo;
  queueMicrotask(() => { evictionTurn = null; });
  return memo;
}

/** The snapshots this machine's own session's log names here, read once a run. */
function namedHere(sid: string): Set<string> {
  const ev = evictions();
  let v = ev.named.get(sid);
  if (v === undefined) {
    v = new Set();
    for (const r of readLogFile(path.join(ev.root, sid, 'log.jsonl'))) for (const sha of [r.beforeBlob, r.afterBlob]) if (typeof sha === 'string') v.add(sha);
    ev.named.set(sid, v);
  }
  return v;
}

/** Whether the store holds a session of this id, as this run first found it. */
function inStore(sid: string): boolean {
  const ev = evictions();
  let v = ev.here.get(sid);
  if (v === undefined) ev.here.set(sid, (v = fs.existsSync(path.join(ev.root, sid))));
  return v;
}

/**
 * Whether this machine's own session `sid` is being put back: in the store with nothing in it but what sync put back,
 * each file the size and time it landed with (the manifest), and no capture under way. A restore that a run left
 * unfinished (its time or bytes ran out, it was stopped) goes on the next run; a session used here since is its own
 * again, and nothing more comes back into it.
 */
export function restoringSession(sid: string): boolean {
  const ev = evictions();
  let v = ev.restoring.get(sid);
  if (v === undefined) ev.restoring.set(sid, (v = restoringNow(ev, sid)));
  return v;
}

function restoringNow(ev: EvictionMemo, sid: string): boolean {
  const dir = path.join(ev.root, sid);
  const manifest = (ev.manifest ??= state.readManifest());
  const asLanded = (fam: string, rest: string, file: string): boolean => {
    const rec = manifest.get(state.manifestKey(fam, `${sid}/${rest}`));
    if (!rec) return false;
    try {
      const st = fs.statSync(file);
      return st.size === rec.size && Math.floor(st.mtimeMs) === rec.mtime;
    } catch {
      return false;
    }
  };
  // The log first: a session that captured here has a log sync never wrote, and is answered at once.
  const log = path.join(dir, 'log.jsonl');
  if (fs.existsSync(log) && !asLanded('oak-log', 'log.jsonl', log)) return false;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const n of names) {
    if (n === 'staging') {
      try {
        if (fs.readdirSync(path.join(dir, n)).length) return false; // a capture under way
      } catch {
        /* not a folder: nothing staged */
      }
      continue;
    }
    if (n === 'blobs') {
      let blobs: string[] = [];
      try {
        blobs = fs.readdirSync(path.join(dir, n));
      } catch {
        /* none */
      }
      if (blobs.some((b) => !manifest.has(state.manifestKey('oak-blobs', `${sid}/blobs/${b}`)))) return false;
      continue;
    }
    const fam = familyOfRest(n);
    if (fam && !asLanded(fam, n, path.join(dir, n))) return false;
  }
  return true;
}

export function resetStoreSyncMemo(): void {
  evictionMemo = null;
  evictionTurn = null;
}

/** Sessions this machine removed on purpose, as the backup folder's record of it says (sync-folder.ts): never put back
 *  here, even on a machine reinstalled since, which has no list of its own yet. Kept for this run, and in the list
 *  (`persist`) for every later one, unless the session is here now. */
export function noteFolderEvictions(list: { id: string; at: number }[], persist: boolean): void {
  const ev = evictions();
  const add: state.SyncEviction[] = [];
  for (const { id, at } of list) {
    if (!sessionOk(id) || typeof at !== 'number' || ev.own.has(id) || fs.existsSync(path.join(rootDir(), id))) continue;
    ev.own.set(id, at);
    add.push({ id, at });
  }
  if (persist) state.addEvictions(add);
}

// ---------------------------------------------------------------------------------------------------------------
// The families
// ---------------------------------------------------------------------------------------------------------------

/** What one walk of the store found, by family: this machine's own session files, and the replicas it holds. */
type StoreScan = Map<string, SyncFile[]>;
const scans = new WeakMap<SyncListContext, StoreScan>();

/** Which family a file of a session folder belongs to, by its name in the folder. */
function familyOfRest(rest: string): string | null {
  if (rest === 'log.jsonl') return 'oak-log';
  if (rest === 'agent.json' || rest === 'comments.json') return 'oak-meta';
  if (rest === 'capture-events.jsonl' || rest === 'attention-log.jsonl') return 'oak-events';
  if (/^blobs\/[0-9a-f]{64}$/.test(rest)) return 'oak-blobs';
  return null;
}

const MIRRORED = new Set(['oak-log', 'oak-meta']);

/** Walk the store once for every OAK family: each session folder's files, the comments kept in the cache folder, and the
 *  replicas. Regular files only: nothing in the store is a link, and one that is would be followed nowhere. */
function scanStore(ctx: SyncListContext): StoreScan {
  const hit = scans.get(ctx);
  if (hit) return hit;
  const out: StoreScan = new Map([['oak-log', []], ['oak-blobs', []], ['oak-meta', []], ['oak-events', []]]);
  const root = rootDir();
  /** Each of this machine's session folders' generation, for the comments kept in the cache folder. */
  const ownGens = new Map<string, string | null>();
  const add = (file: string, name: string, replica: { origin: string; sid: string; rest: string } | null, gen: string | null): void => {
    const fam = familyOfRest(replica ? replica.rest : name.startsWith('changemap-cache/') ? 'comments.json' : name.slice(name.indexOf('/') + 1));
    if (!fam) return;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      return; // raced away
    }
    if (!st.isFile()) return;
    const e: SyncFile = { name, size: st.size, mtime: Math.floor(st.mtimeMs) };
    if (replica) {
      e.origin = replica.origin;
      e.originName = `${replica.sid}/${replica.rest}`;
    }
    if (MIRRORED.has(fam)) {
      const s = replica ? ctx.stamp(fam, name, e.size, e.mtime) ?? `copy:${e.size}:${e.mtime}` : stampFile(file, st);
      if (s) e.stamp = s;
    }
    if (gen && fam !== 'oak-blobs') e.gen = gen;
    out.get(fam)!.push(e);
  };
  /** One session folder: its own files, and its blobs. */
  const session = (dir: string, prefix: string, replica: { origin: string; sid: string } | null): string | null => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // The folder's generation, on the files that are no snapshot: read once, where there is one of them.
    const gen = !names.some((d) => d.isFile() && familyOfRest(d.name)) ? null : replica ? sessionGeneration(dir).gen : ownGeneration(path.basename(dir)).gen;
    for (const d of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (d.name === 'blobs' && d.isDirectory()) {
        let blobs: string[];
        try {
          blobs = fs.readdirSync(path.join(dir, 'blobs')).sort();
        } catch {
          continue;
        }
        for (const b of blobs) {
          if (!/^[0-9a-f]{64}$/.test(b)) continue;
          add(path.join(dir, 'blobs', b), `${prefix}blobs/${b}`, replica && { ...replica, rest: `blobs/${b}` }, null);
        }
      } else if (d.isFile() && familyOfRest(d.name)) add(path.join(dir, d.name), `${prefix}${d.name}`, replica && { ...replica, rest: d.name }, gen);
    }
    return gen;
  };
  for (const sid of allStoreSessionIds().sort()) if (sessionOk(sid)) ownGens.set(sid, session(path.join(root, sid), `${sid}/`, null));
  // Comments where comments.ts keeps them, in the cache folder.
  let cached: string[] = [];
  try {
    cached = fs.readdirSync(path.join(root, 'changemap-cache')).sort();
  } catch {
    /* none */
  }
  for (const sid of cached) if (sessionOk(sid)) add(path.join(root, 'changemap-cache', sid, 'comments.json'), `changemap-cache/${sid}/comments.json`, null, ownGens.get(sid) ?? null);
  const replicas = path.join(root, ...SYNC_REPLICAS.split('/'));
  let origins: string[] = [];
  try {
    origins = fs.readdirSync(replicas).filter((h) => HOST.test(h)).sort();
  } catch {
    /* none */
  }
  for (const origin of origins) {
    let sids: string[] = [];
    try {
      sids = fs.readdirSync(path.join(replicas, origin)).filter(sessionOk).sort();
    } catch {
      continue;
    }
    for (const sid of sids) session(path.join(replicas, origin, sid), `${SYNC_REPLICAS}/${origin}/${sid}/`, { origin, sid });
  }
  scans.set(ctx, out);
  return out;
}

function storeFamily(id: string, strategy: SyncFamily['strategy'], placement: SyncFamily['placement'], rests: (rest: string) => boolean, oldComments = false): SyncFamily {
  const accepts = (name: string): boolean => {
    const p = parseStoreName(name);
    if (!p) return false;
    return p.kind === 'old-comments' ? oldComments : rests(p.rest);
  };
  return {
    id,
    agent: 'oak',
    strategy,
    placement,
    projectScoped: false,
    retention: false,
    root: () => rootDir(),
    accepts,
    list: (ctx) => scanStore(ctx).get(id) ?? [],
    session: (name) => parseStoreName(name)?.sid ?? null,
    target: (e, from) => {
      const p = parseStoreName(e.name);
      if (!p) return null;
      const rest = p.kind === 'old-comments' ? 'comments.json' : p.rest;
      if (from.origin === from.me) {
        // This machine's own session, held elsewhere: put back where it was, and only while the session is not here at
        // all (a capture under that id since would be another session) and was never removed here on purpose.
        if (evictions().own.has(p.sid)) return null;
        const own = p.kind === 'replica' ? e.originName ?? `${p.sid}/${rest}` : e.name;
        if (!accepts(own) || parseStoreName(own)?.kind === 'replica') return null;
        // A session being put back takes what it still lacks, and nothing over what is back already. A snapshot its log
        // here names and its folder lacks comes back even once the session was used here since (a restore a run's budget
        // cut short, then a capture before the next run): it is the same bytes wherever it is kept, and without it the
        // edit that names it can be neither reviewed nor undone.
        const lacking = !fs.existsSync(path.join(rootDir(), ...own.split('/')));
        if (inStore(p.sid) && !(lacking && (restoringSession(p.sid) || (id === 'oak-blobs' && namedHere(p.sid).has(path.basename(own)))))) return null;
        return own;
      }
      if (evictions().copies.has(`${from.origin}/${p.sid}`)) return null;
      return `${SYNC_REPLICAS}/${from.origin}/${p.sid}/${rest}`;
    },
    ...(strategy === 'mirror' ? {
      // Replaced whole whenever the stamp on the machine it is pulled from differs from the one this copy landed with,
      // and never by an older copy (one another machine kept, or the backup folder's, while the machine that writes it
      // holds a newer one, which this copy already is): the newest copy anywhere stays, rather than two taking turns.
      wants: (here: SyncFile | undefined, peer: SyncFile): boolean => !here || (peer.mtime >= here.mtime
        && (here.stamp ?? `${here.size}:${here.mtime}`) !== (peer.stamp ?? `${peer.size}:${peer.mtime}`)),
      stamp: storeStamp,
    } : {}),
  };
}

export const STORE_FAMILY_IDS = ['oak-log', 'oak-blobs', 'oak-meta', 'oak-events'] as const;

registerSyncFamily(storeFamily('oak-log', 'mirror', 'everywhere', (r) => r === 'log.jsonl'));
registerSyncFamily(storeFamily('oak-blobs', 'cas', 'backup', (r) => /^blobs\/[0-9a-f]{64}$/.test(r)));
registerSyncFamily(storeFamily('oak-meta', 'mirror', 'everywhere', (r) => r === 'agent.json' || r === 'comments.json', true));
registerSyncFamily(storeFamily('oak-events', 'append', 'backup', (r) => r === 'capture-events.jsonl' || r === 'attention-log.jsonl'));

// ---------------------------------------------------------------------------------------------------------------
// The replicas a run keeps or lets go
// ---------------------------------------------------------------------------------------------------------------

/** Move the files of a session folder sync holds (`rel`, from the store's root: a replica, or what a run put back of this
 *  machine's own) to the trash, forget them in the manifest, and remove the folder. */
function removeCopy(manifest: state.SyncManifest, rel: string, now: number, detail: string): number {
  const dir = path.join(rootDir(), ...rel.split('/'));
  let bytes = 0;
  const walk = (abs: string, name: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs)) walk(path.join(abs, n), `${name}/${n}`);
      return;
    }
    const fam = familyOfRest(name.slice(rel.length + 1)) ?? 'oak-other';
    bytes += st.size;
    state.moveToTrash(fam, name, abs, now);
    manifest.delete(state.manifestKey(fam, name));
  };
  walk(dir, rel);
  fs.rmSync(dir, { recursive: true, force: true });
  state.audit({ op: 'evict', name: rel, bytes, detail });
  return bytes;
}

/** When the log a replica holds was written on its machine (a mirrored copy keeps that time), or 0 for none. */
function replicaLogTime(origin: string, sid: string): number {
  try {
    return Math.floor(fs.statSync(path.join(rootDir(), ...SYNC_REPLICAS.split('/'), origin, sid, 'log.jsonl')).mtimeMs);
  } catch {
    return 0;
  }
}

export interface StoreReplicaUpkeep {
  /** Copies let go because the machine that made the session cleaned it up. */
  evicted: string[];
  /** Copies removed because the session was deleted (a tombstone). */
  deleted: string[];
  /** Copies kept as the earlier history of their session (`<machine>/<session>`), whose machine made its folder anew. */
  earlier: string[];
}

/** The generation another machine's session has where each node lists it (`<machine>/<session>`): from the machine
 *  itself, answering this run (`fresh`; null where it names none), and the newest any other copy names (another
 *  machine's replica, the backup folder's record), with its log's time. */
function listedGenerations(nodes: SyncNode[]): Map<string, { fresh?: string | null; other?: { gen: string; mtime: number } }> {
  const out = new Map<string, { fresh?: string | null; other?: { gen: string; mtime: number } }>();
  for (const n of nodes) {
    if (n.local || n.status !== 'ok' || !n.inventory) continue;
    const host = n.inventory.host;
    const logs = new Map<string, number>();
    for (const e of n.inventory.families['oak-log'] ?? []) {
      const p = parseStoreName(e.name);
      if (p) logs.set(`${p.kind === 'replica' ? p.origin : e.origin ?? host}/${p.sid}`, e.mtime);
    }
    for (const id of ['oak-log', 'oak-meta', 'oak-events']) {
      for (const e of n.inventory.families[id] ?? []) {
        const p = parseStoreName(e.name);
        if (!p) continue;
        const origin = p.kind === 'replica' ? p.origin! : e.origin ?? host;
        const k = `${origin}/${p.sid}`;
        const v = out.get(k) ?? {};
        if (!n.passive && origin === host && p.kind !== 'replica') v.fresh = v.fresh ?? e.gen ?? null;
        else if (e.gen && logs.has(k) && (!v.other || logs.get(k)! > v.other.mtime)) v.other = { gen: e.gen, mtime: logs.get(k)! };
        out.set(k, v);
      }
    }
  }
  return out;
}

/**
 * Before a run plans: let go of the copies of sessions their machine cleaned up, and of deleted sessions.
 * - A machine that answered this run (a fresh inventory, never a backup's copy of one) and holds a session of its own
 *   again: a copy this machine let go of before is pulled again.
 * - A deleted session (the latest tombstone for it deletes it): every copy of it goes, to the trash, with no eviction
 *   record, so an undelete that brings the session back where it was made brings the copies back with it.
 * - A session gone from the machine that made it, which that machine's inventory lists as cleaned up there
 *   (SyncMachineState.evicted): the copy goes, to the trash, with an audit line and an eviction record, so no other
 *   machine's copy brings it back.
 * - Gone with no cleanup recorded there, or its machine not answering: the copy is kept. It may be the last one.
 * - Made anew there (another generation, listed by that machine, or newer by another copy): the copy is kept as the
 *   session's earlier history (earlierGenerationId), and the new one is pulled beside it.
 * And this machine's session folders that have no generation yet are given theirs (markStoreGenerations).
 */
export function upkeepStoreReplicas(opts: { nodes: SyncNode[]; tombs: Map<string, state.SyncTombstone>; manifest: state.SyncManifest; now: number; warnings: string[] }): StoreReplicaUpkeep {
  resetStoreSyncMemo();
  // Only an actual run closes local appends; inventory and plan remain read-only. Refresh the lengths in the
  // inventory collected before this upkeep, so the backup receives the final seal too.
  const meHere = machineHostTag();
  sealRecords(meHere);
  for (const e of opts.nodes.find((n) => n.local)?.inventory?.families['oak-records'] ?? []) {
    if (!e.name.startsWith(`records/${meHere}/`)) continue;
    try {
      const st = fs.statSync(path.join(rootDir(), e.name));
      e.size = st.size;
      e.mtime = Math.floor(st.mtimeMs);
    } catch { /* disappeared before the inventory was used */ }
  }
  // The run's manifest, which nothing has landed in yet this run: asking whether a folder is being put back read it
  // whole again, 240 ms for a backup machine's 100,000 files (30 MB), on every run that found a new session to mark.
  evictions().manifest = opts.manifest;
  markStoreGenerations();
  const out: StoreReplicaUpkeep = { evicted: [], deleted: [], earlier: [] };
  const fresh = new Map<string, { label: string; own: Set<string>; evicted: Map<string, number> }>();
  for (const n of opts.nodes) {
    if (n.local || n.passive || n.status !== 'ok' || !n.inventory) continue;
    const own = new Set<string>();
    for (const id of STORE_FAMILY_IDS) {
      for (const e of n.inventory.families[id] ?? []) {
        if (e.origin) continue;
        const p = parseStoreName(e.name);
        if (p && p.kind !== 'replica') own.add(p.sid);
      }
    }
    fresh.set(n.inventory.host, { label: n.label, own, evicted: new Map((n.inventory.sync?.evicted ?? []).map((e) => [e.id, e.at])) });
  }
  // The list is only appended to (store.ts appends as `oak clean` removes, under no lock of sync's): a copy let go whose
  // session its machine holds again is pulled again, and a session of this machine's own made again under the id of
  // one it removed is its own again, so a later loss of it is a loss and not a cleanup.
  // A session of this machine's own it removed is its own again too where a copy of it anywhere (another machine's, or
  // the backup folder's) is newer than the removal: it was made again here, and lost before a run saw it.
  const now = state.currentEvictions();
  const add: state.SyncEviction[] = [];
  for (const k of now.copies.keys()) {
    const [origin, id] = [k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)];
    if (fresh.get(origin)?.own.has(id)) add.push({ id, origin, at: opts.now, back: true });
  }
  const me = opts.nodes.find((n) => n.local)?.inventory?.host;
  const newer = new Set<string>();
  for (const n of opts.nodes) {
    if (n.local || n.status !== 'ok' || !n.inventory) continue;
    for (const e of n.inventory.families['oak-log'] ?? []) {
      if ((e.origin ?? n.inventory.host) !== me) continue;
      const sid = parseStoreName(e.name)?.sid;
      const at = sid ? now.own.get(sid) : undefined;
      if (sid && at !== undefined && e.mtime > at) newer.add(sid);
    }
  }
  // Its folder here again holding nothing but what a run put back is no session made again: it was cleaned up while that
  // run was putting it back, and the run made its folder again. The cleanup stands, and what came back goes to the trash.
  for (const id of now.own.keys()) {
    if (!newer.has(id) && fs.existsSync(path.join(rootDir(), id)) && restoringSession(id)) {
      try {
        removeCopy(opts.manifest, id, opts.now, 'cleaned up here while a run was putting it back');
        out.evicted.push(id);
      } catch (e) {
        opts.warnings.push(`what a run put back of session ${id}, cleaned up here meanwhile, could not be let go: ${String((e as Error)?.message || e)}`);
      }
      continue;
    }
    if (newer.has(id) || fs.existsSync(path.join(rootDir(), id))) add.push({ id, at: opts.now, back: true });
  }
  const base = path.join(rootDir(), ...SYNC_REPLICAS.split('/'));
  let origins: string[] = [];
  try {
    origins = fs.readdirSync(base).filter((h) => HOST.test(h)).sort();
  } catch {
    /* no replicas */
  }
  const listed = listedGenerations(opts.nodes);
  for (const origin of origins) {
    let sids: string[] = [];
    try {
      sids = fs.readdirSync(path.join(base, origin)).filter(sessionOk).sort();
    } catch {
      continue;
    }
    for (let sid of sids) {
      try {
        const tomb = opts.tombs.get(`session\0${sid}`);
        if (tomb?.deleted) {
          removeCopy(opts.manifest, `${SYNC_REPLICAS}/${origin}/${sid}`, opts.now, `the session was deleted (${tomb.host})`);
          out.deleted.push(`${origin}/${sid}`);
          continue;
        }
        // Its machine made the session's folder anew: what this copy holds is the history before that, kept apart as a
        // session of its own (an earlier copy kept under that name already goes to the trash), and never replaced.
        const was = sessionGeneration(path.join(base, origin, sid)).gen;
        const now = listed.get(`${origin}/${sid}`);
        if (was && (now?.fresh !== undefined ? !!now.fresh && now.fresh !== was
          : !!now?.other && now.other.gen !== was && now.other.mtime > replicaLogTime(origin, sid))) {
          const to = earlierGenerationId(sid, was);
          const rel = `${SYNC_REPLICAS}/${origin}/${sid}`, relTo = `${SYNC_REPLICAS}/${origin}/${to}`;
          if (fs.existsSync(path.join(base, origin, to))) removeCopy(opts.manifest, relTo, opts.now, `an older copy of the earlier history of ${sid}`);
          fs.renameSync(path.join(base, origin, sid), path.join(base, origin, to));
          for (const [k, e] of [...opts.manifest]) {
            if (!e.name.startsWith(`${rel}/`)) continue;
            opts.manifest.delete(k);
            const name = relTo + e.name.slice(rel.length);
            opts.manifest.set(state.manifestKey(e.family, name), { ...e, name, ...(e.originName?.startsWith(`${sid}/`) ? { originName: to + e.originName.slice(sid.length) } : {}) });
          }
          state.audit({ op: 'earlier', name: relTo, detail: `the earlier history of session ${sid}, whose folder its machine made anew` });
          out.earlier.push(`${origin}/${sid}`);
          sid = to;
        }
        const f = fresh.get(origin);
        const cleaned = f?.evicted.get(sid);
        // Its machine did not answer this run, still holds the session, or lost it with no cleanup recorded: kept. So is a
        // copy newer than the cleanup (its log written there after it): a later life of the session, maybe the last.
        if (!f || f.own.has(sid) || cleaned === undefined || replicaLogTime(origin, sid) > cleaned) continue;
        removeCopy(opts.manifest, `${SYNC_REPLICAS}/${origin}/${sid}`, opts.now, `cleaned up on ${f.label}`);
        add.push({ id: sid, origin, at: opts.now });
        out.evicted.push(`${origin}/${sid}`);
      } catch (e) {
        opts.warnings.push(`the copy of session ${sid} from ${origin} could not be let go: ${String((e as Error)?.message || e)}`);
      }
    }
  }
  state.addEvictions(add);
  resetStoreSyncMemo();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The record logs
// ---------------------------------------------------------------------------------------------------------------

/** A segment of a machine's record log, as its name in the store root says (index/records.ts). */
const RECORD_NAME = /^records\/([0-9a-f]{12})\/(\d{13}-[0-9a-f]{8}(?:-base)?\.jsonl)$/;

/** What the bases of each machine's log held whole here cover (records.ts coverage), read once per turn of the event
 *  loop (a plan asks for every segment of every machine). */
let coveredTurn: Map<string, Coverage[]> | null = null;

/** Whether a base of that machine's log that this machine holds whole covers the segment: that machine compacted it
 *  away, and it is never pulled again. A base covers only the history its machine held when it wrote it: the log a
 *  machine set up again kept before is pulled still. */
function recordCovered(host: string, segment: string): boolean {
  if (!coveredTurn) {
    coveredTurn = new Map();
    queueMicrotask(() => { coveredTurn = null; });
  }
  let cov = coveredTurn.get(host);
  if (cov === undefined) coveredTurn.set(host, (cov = coverage(segments(host))));
  return covers(cov, segment);
}

/**
 * `oak-records`: each machine's record log (index/records.ts), `records/<machine>/<segment>`: append-only segments, on
 * every machine and in the backup folder, so every machine's index holds every machine's records. Each machine writes
 * only its own log; another machine's segment is pulled as it grows, from that machine or from any machine that holds a
 * copy. A segment that a base held here whole covers is not pulled again (its machine compacted it away, and this machine
 * lets its own copy go, index/records.ts dropCovered). This machine's own segments come back where they are missing or
 * shorter: a restore stopped partway takes the rest next run, checked against the prefix it already holds.
 */
registerSyncFamily({
  id: 'oak-records',
  agent: 'oak',
  strategy: 'append',
  placement: 'everywhere',
  projectScoped: false,
  retention: false,
  root: () => rootDir(),
  accepts: (name) => typeof name === 'string' && RECORD_NAME.test(name),
  list: () => {
    const out: SyncFile[] = [];
    for (const host of recordHosts()) {
      for (const s of segments(host)) {
        let st: fs.Stats;
        try {
          st = fs.lstatSync(s.file);
        } catch {
          continue;
        }
        if (st.isFile()) out.push({ name: `records/${host}/${s.name}`, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
    }
    return out;
  },
  target: (e) => {
    const m = RECORD_NAME.exec(e.name);
    if (!m || recordCovered(m[1], m[2])) return null;
    return e.name;
  },
});
