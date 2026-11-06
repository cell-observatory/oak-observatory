/**
 * oak sync's backup folder (prefs.json `sync.backup = { kind: 'folder', path }`, set per machine): a folder every
 * machine can reach (a network share, a NAS, an external disk) that holds an encrypted copy of each machine's own files.
 * It may be readable by others: everything in it is sealed on the client with the key only the user's machines hold
 * (sync-crypto.ts), and the key is never written there.
 *
 * Layout, every name lower-case, no links:
 * - `oak-backup`: the marker, `{"oakBackup":1,"keyCheck":…}`, a known text sealed under the key, which tells the right key
 *   from a wrong one before anything else is read.
 * - `machines/<keyed name of the machine>/`: each machine's record, written by that machine alone: numbered parts
 *   (`seg-<n>`, one per run that changed something) and, every FOLDER_SEGMENTS_PER_SNAPSHOT parts, a whole one
 *   (`snap-<n>`), each sealed whole. A part names each file the machine holds (its family, name, size, time, and the
 *   objects its bytes are), the files it no longer holds, and the machine's inventory without its files (its projects,
 *   identities, deletes and evictions). `tmp/` holds the machine's half-written files.
 * - `objects/<2>/<keyed name>`: a sealed object of FOLDER_LOOSE_MIN bytes or more; `packs/<2>/<keyed name>`: smaller
 *   objects sealed one by one and packed together, about FOLDER_PACK_TARGET bytes a pack, since a file made on a share
 *   can cost milliseconds. An object is named by an HMAC of its content's hash: the same content has one name from any
 *   machine, and two machines that write it at once write the same thing.
 *
 * A file is cut into FOLDER_CHUNK pieces at fixed offsets, and the last, partial piece into what each run added, so a
 * transcript that grows writes only what it grew by. Every write is a temporary file, flushed, then renamed; a part of
 * the record is written last, so a run killed part way leaves the folder as it was, with objects nothing names yet.
 * Nothing is ever removed from `objects/` or `packs/` in this release: what a machine no longer holds stays there,
 * sealed, until a later release collects it.
 *
 * Reading: each machine's record is the newest whole part and the numbered parts after it, which must follow on with
 * no gap; what this machine read before is kept locally (`sync/folder/<id>/`), so a part is read once, and a record
 * that went back to an earlier part is an error. A part, an object or the marker that does not open, or opens to
 * other content than its name says, is an error that is said and never used.
 *
 * In a run, the folder's copy of each machine is a passive node (SyncNode.passive) the engine pulls from as from that
 * machine: this machine restores its own files from its copy (a machine reinstalled with its key restores everything),
 * and keeps current what it holds of others while they are off. Once the run has pulled, this machine writes its own
 * files there (pushToFolder).
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import {
  syncFamilies, syncLocalPath, neverRead, parseSyncInventory, localSyncLabel, deletedSessions, SYNC_GEN,
  type SyncFamily, type SyncFile, type SyncInventory, type SyncNode, type SyncChannel, type SyncAskFailure,
} from './sync';
import {
  registerSyncBackupKind, placementOf, syncFetchFrames, SYNC_FETCH_VERSION, SYNC_RUN_MAX_BYTES, SYNC_PEER_BUDGET_MS,
  type SyncFetchItem, type SyncFetchSource, type SyncBackupPush, type SyncBackupPushResult, type SyncBackupRole,
} from './sync-engine';
import * as state from './sync-state';
import { readSyncKey, folderKeys, keyedName, objectName, seal, unseal, SyncSealError, SEAL_OVERHEAD, type FolderKeys } from './sync-crypto';
import { noteFolderEvictions, restoringSession, parseStoreName, markSessionGeneration, ownGeneration } from './sync-store';
import { rootDir, earlierGenerationId } from './store';
import { expandHome } from './prefs';

export const FOLDER_FORMAT = 1;
/** Files are cut at multiples of this. */
export const FOLDER_CHUNK = 4 * 1024 * 1024;
/** An object this large or larger is a file of its own; smaller ones are packed. */
export const FOLDER_LOOSE_MIN = 1024 * 1024;
/** A pack is written once it holds this much. */
export const FOLDER_PACK_TARGET = 32 * 1024 * 1024;
/** A whole part is written after this many numbered ones. */
export const FOLDER_SEGMENTS_PER_SNAPSHOT = 32;
/** The partial last piece of a file is kept as what each run added, up to this many pieces; then it is one again. */
export const FOLDER_PIECES_MAX = 64;
/** A file served from the folder up to this size is checked whole before any of it is sent. */
const FOLDER_CHECK_WHOLE = 64 * 1024 * 1024;
const MARKER = 'oak-backup';
const KEYCHECK = 'oak-sync backup key check';
const AAD_KEYCHECK = 'oak-sync\0keycheck';
const HOST = /^[0-9a-f]{12}$/;
const NAME = /^[0-9a-f]{64}$/;
const WRITER = /^[0-9a-f]{32}$/;

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const msg = (e: unknown): string => String((e as Error)?.message || e);
/** The largest part of a record read, and the largest marker: a file there larger than either is no file OAK wrote. */
const PART_MAX = 256 * 1024 * 1024;
const MARKER_MAX = 64 * 1024;

/** Open a file of the folder to read it, refusing anything but a plain file before reading a byte: a pipe that someone
 *  who can write the folder put there would block the open, and the run, for ever; a link is not followed. */
function openRegular(file: string, what: string): number {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw new SyncSealError(`${what} is not a file OAK wrote (a pipe, a device, a folder): the folder was altered`);
  }
  return fd;
}

/** Read a file of the folder whole, refusing one larger than `max` before any of it is read (one that someone who can
 *  write the folder put there would otherwise be held in memory whole). */
function readBounded(file: string, max: number, what: string): Buffer {
  const fd = openRegular(file, what);
  try {
    const size = fs.fstatSync(fd).size;
    if (size > max) throw new SyncSealError(`${what} is ${size} bytes, larger than OAK writes: the folder was altered`);
    const buf = Buffer.alloc(size);
    readFull(fd, buf, size, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** The folder's own directory at `dir`, made where it is missing; a link where one should be is refused, so no write
 *  of OAK's is led out of the folder by one. */
function ownDir(dir: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    try {
      fs.mkdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; // another machine made it first
    }
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SyncSealError(`${dir} is not a folder OAK made (a link, or a file): the folder was altered, and nothing is written there`);
}

/** A piece of a file: the hash of its bytes and their length, and for a packed piece, its pack and where its sealed
 *  bytes start there. */
type Chunk = [string, number] | [string, number, string, number];

/** One file a machine holds, as its record in the folder names it. */
export interface FolderEntry {
  f: string;
  n: string;
  size: number;
  mtime: number;
  /** The whole file's sha256: for a text file (which a restore must be able to compare) and a content-addressed one. */
  sha?: string;
  stamp?: string;
  cwd?: string;
  /** For a file of OAK's store: the generation of the session folder it was written from (SyncFile.gen). */
  gen?: string;
  c: Chunk[];
}

/** A machine's inventory without its files, as its record keeps it. */
type FolderMeta = Omit<SyncInventory, 'families' | 'inventory'> & { label: string };

interface MachineState {
  mid: string;
  host: string;
  /** The last part of its record applied, and the whole part that started it. */
  seq: number;
  snap: number;
  at: number;
  meta: FolderMeta | null;
  files: Map<string, FolderEntry>;
  /** The writer id of the machine that wrote its last part (readWriterId), sealed with the part; null for a part written
   *  before writers were (0.11.0's first builds). */
  writer: string | null;
}

export interface OpenFolder {
  dir: string;
  keys: FolderKeys;
  /** What this machine's own record of the folder is kept under: from the marker, which is the folder's alone. */
  id: string;
}

export type FolderCheck = { ok: true; folder: OpenFolder }
  | { ok: false; code: 'missing' | 'not-backup' | 'no-key' | 'wrong-key' | 'key-inside' | 'not-empty'; error: string };

const entryKey = (family: string, name: string): string => `${family}\0${name}`;
const pad = (n: number): string => String(n).padStart(12, '0');
const objectPath = (f: OpenFolder, objectId: string): string => path.join(f.dir, 'objects', objectId.slice(0, 2), objectId);
const packPath = (f: OpenFolder, packId: string): string => path.join(f.dir, 'packs', packId.slice(0, 2), packId);
const machineId = (f: OpenFolder, host: string): string => keyedName(f.keys, `machine\0${host}`);
const localDir = (f: OpenFolder): string => path.join(state.syncDir(), 'folder', f.id);

/** The backup folder of a setting, as an absolute path. */
export const backupFolderPath = (p: string): string => path.resolve(expandHome(p));

function readMarker(dir: string): { keyCheck: string } | null {
  let text: string;
  try {
    text = readBounded(path.join(dir, MARKER), MARKER_MAX, 'the backup folder\'s marker').toString('utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    o = null; // not JSON: no marker OAK wrote
  }
  if (!o || o.oakBackup !== FOLDER_FORMAT || typeof o.keyCheck !== 'string') throw new SyncSealError(`${path.join(dir, MARKER)} is not an OAK backup's marker, or one a newer OAK made`);
  return { keyCheck: o.keyCheck };
}

/** Whether this machine's key would be inside `dir` (a store moved onto the backup folder): never allowed. */
function keyInside(dir: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const d = real(dir);
  const k = real(state.syncDir());
  return k === d || k.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** Open the backup folder at `p` with this machine's key: it must be there, hold an OAK backup, and open with the key. */
export function openBackupFolder(p: string, key: Buffer | null = readSyncKey()): FolderCheck {
  const dir = backupFolderPath(p);
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return { ok: false, code: 'missing', error: `the backup folder ${dir} is not there (is its share or disk mounted?)` };
  }
  if (!st.isDirectory()) return { ok: false, code: 'missing', error: `${dir} is not a folder` };
  const marker = readMarker(dir);
  if (!marker) return { ok: false, code: 'not-backup', error: `${dir} holds no OAK backup: \`oak sync backup --folder ${dir}\` makes one there` };
  if (!key) return { ok: false, code: 'no-key', error: `this machine has no backup key, so it cannot read ${dir}: copy it from a machine that has it (\`oak sync key --from <machine>\`), or \`oak sync key --import\`` };
  if (keyInside(dir)) return { ok: false, code: 'key-inside', error: `this machine's backup key would be inside ${dir}, where the backup is: move OAK's store elsewhere first` };
  const keys = folderKeys(key);
  let check: Buffer;
  try {
    check = unseal(keys, Buffer.from(marker.keyCheck, 'base64'), AAD_KEYCHECK, 'the backup folder\'s marker');
  } catch {
    return { ok: false, code: 'wrong-key', error: `this machine's backup key does not open ${dir}: the backup was made with another key (compare \`oak sync key\` on the machine that made it), or its marker was altered` };
  }
  if (check.toString('utf8') !== KEYCHECK) return { ok: false, code: 'wrong-key', error: `the marker of ${dir} opens to something unexpected: it was altered` };
  return { ok: true, folder: { dir, keys, id: createHash('sha256').update(marker.keyCheck).digest('hex').slice(0, 16) } };
}

/**
 * Make `p` a backup folder sealed under `key`: a folder that is not there yet (its parent must be: a share that is not
 * mounted is not made on the disk beneath it), or one that is empty, gets the marker; one that holds a backup already
 * must open with the key. A folder with anything else in it is refused, so the backup never mixes with other files.
 */
export function initBackupFolder(p: string, key: Buffer): { check: FolderCheck; created: boolean } {
  const dir = backupFolderPath(p);
  let created = false;
  if (!fs.existsSync(dir)) {
    if (!fs.existsSync(path.dirname(dir))) return { check: { ok: false, code: 'missing', error: `${path.dirname(dir)} is not there (is its share or disk mounted?)` }, created };
    fs.mkdirSync(dir);
    created = true;
  } else if (!fs.statSync(dir).isDirectory()) return { check: { ok: false, code: 'missing', error: `${dir} is not a folder` }, created };
  if (keyInside(dir)) return { check: { ok: false, code: 'key-inside', error: `this machine's backup key would be inside ${dir}: choose a folder outside OAK's store` }, created };
  if (!readMarker(dir)) {
    // A marker an earlier setup did not finish writing is no other file: it goes.
    const leftover = (n: string): boolean => new RegExp(`^${MARKER}\\.[0-9a-f]{12}\\.tmp$`).test(n);
    for (const n of fs.readdirSync(dir)) if (leftover(n)) fs.rmSync(path.join(dir, n), { force: true });
    const other = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
    if (other.length) return { check: { ok: false, code: 'not-empty', error: `${dir} is not empty and holds no OAK backup: choose an empty folder, or one that holds an OAK backup` }, created };
    const keyCheck = seal(folderKeys(key), Buffer.from(KEYCHECK), AAD_KEYCHECK).toString('base64');
    const tmp = path.join(dir, `${MARKER}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify({ oakBackup: FOLDER_FORMAT, keyCheck }) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path.join(dir, MARKER));
  }
  return { check: openBackupFolder(dir, key), created };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the records
// ---------------------------------------------------------------------------------------------------------------

function readPart(f: OpenFolder, mid: string, name: string): any {
  const sealed = readBounded(path.join(f.dir, 'machines', mid, name), PART_MAX, `part ${name} of a machine's record in the backup`);
  const plain = unseal(f.keys, sealed, `oak-sync\0manifest\0${mid}\0${name}`, `part ${name} of a machine's record in the backup`);
  let o: any;
  try {
    o = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new SyncSealError(`part ${name} of a machine's record in the backup is not one`);
  }
  const [, kind, seq] = /^(snap|seg)-(\d{12})$/.exec(name) ?? [];
  if (!o || o.v !== FOLDER_FORMAT || o.kind !== kind || o.seq !== Number(seq) || typeof o.host !== 'string' || !HOST.test(o.host) || machineId(f, o.host) !== mid) {
    throw new SyncSealError(`part ${name} of a machine's record in the backup does not belong where it is: the folder was altered`);
  }
  return o;
}

const validEntry = (e: any): e is FolderEntry => !!e && typeof e.f === 'string' && typeof e.n === 'string' && Number.isInteger(e.size) && e.size >= 0 && typeof e.mtime === 'number'
  && Array.isArray(e.c) && e.c.every((c: any) => Array.isArray(c) && typeof c[0] === 'string' && /^[0-9a-f]{64}$/.test(c[0]) && Number.isInteger(c[1]) && c[1] >= 0
    && (c.length === 2 || (c.length === 4 && NAME.test(c[2]) && Number.isInteger(c[3]) && c[3] >= 0)))
  && e.c.reduce((s: number, c: Chunk) => s + c[1], 0) === e.size;

/** A file as a part of a record writes it, short: its pieces name their pack by its place in the part's `packs`, and
 *  their hash as '' where it is the file's own (a content snapshot's name, or a text file's hash when one piece holds
 *  it); `h` is left out where it is the file's name. */
interface WireEntry {
  f: string;
  n: string;
  s: number;
  m: number;
  h?: string;
  t?: string;
  w?: string;
  g?: string;
  c: (string | number)[][];
}

const baseHash = (n: string): string | undefined => {
  const b = n.slice(n.lastIndexOf('/') + 1);
  return NAME.test(b) ? b : undefined;
};

export function encodeEntries(entries: Iterable<FolderEntry>): { packs: string[]; files: WireEntry[] } {
  const packs: string[] = [];
  const at = new Map<string, number>();
  const files: WireEntry[] = [];
  for (const e of entries) {
    const named = e.sha !== undefined && e.sha === baseHash(e.n);
    const own = e.sha;
    const c = e.c.map((ch): (string | number)[] => {
      const h = own !== undefined && ch[0] === own ? '' : ch[0];
      if (ch.length === 2) return [h, ch[1]];
      let i = at.get(ch[2]);
      if (i === undefined) {
        i = packs.length;
        packs.push(ch[2]);
        at.set(ch[2], i);
      }
      return [h, ch[1], i, ch[3]];
    });
    files.push({ f: e.f, n: e.n, s: e.size, m: e.mtime, ...(e.sha && !named ? { h: e.sha } : {}), ...(e.stamp ? { t: e.stamp } : {}), ...(e.cwd ? { w: e.cwd } : {}), ...(e.gen ? { g: e.gen } : {}), c });
  }
  return { packs, files };
}

/** The files a part names, as FolderEntry; anything malformed is left out. */
export function decodeEntries(packs: unknown, files: unknown): FolderEntry[] {
  const table = Array.isArray(packs) ? packs : [];
  const out: FolderEntry[] = [];
  for (const w of Array.isArray(files) ? files : []) {
    if (!w || typeof w.n !== 'string') continue;
    const sha = typeof w.h === 'string' ? w.h : baseHash(w.n);
    const c = Array.isArray(w.c) ? w.c.map((x: any): Chunk | null => {
      if (!Array.isArray(x)) return null;
      const h = x[0] === '' ? sha : x[0];
      if (typeof h !== 'string') return null;
      if (x.length === 2) return [h, x[1]];
      const pack = table[x[2]];
      return typeof pack === 'string' ? [h, x[1], pack, x[3]] : null;
    }) : [];
    const e = { f: w.f, n: w.n, size: w.s, mtime: w.m, ...(sha ? { sha } : {}), ...(typeof w.t === 'string' ? { stamp: w.t } : {}), ...(typeof w.w === 'string' ? { cwd: w.w } : {}),
      ...(typeof w.g === 'string' && SYNC_GEN.test(w.g) ? { gen: w.g } : {}), c };
    if (!c.includes(null) && validEntry(e)) out.push(e);
  }
  return out;
}

function applyPart(ms: MachineState, o: any): void {
  if (o.kind === 'snap') {
    ms.files = new Map();
    for (const e of decodeEntries(o.packs, o.files)) ms.files.set(entryKey(e.f, e.n), e);
    ms.snap = o.seq;
  } else {
    for (const d of Array.isArray(o.del) ? o.del : []) if (Array.isArray(d)) ms.files.delete(entryKey(String(d[0]), String(d[1])));
    for (const e of decodeEntries(o.packs, o.put)) ms.files.set(entryKey(e.f, e.n), e);
  }
  if (o.meta && typeof o.meta === 'object') ms.meta = o.meta as FolderMeta;
  ms.seq = o.seq;
  ms.host = o.host;
  ms.at = typeof o.at === 'number' ? o.at : ms.at;
  ms.writer = typeof o.writer === 'string' && WRITER.test(o.writer) ? o.writer : null;
}

interface MachineCache {
  snap: number;
  seq: number;
  /** Each part read: its size and time, so one changed since is read again. */
  parts: Record<string, [number, number]>;
  host: string;
  at: number;
  meta: FolderMeta | null;
  writer?: string | null;
  /** The files, as a part writes them (encodeEntries). */
  packs: string[];
  files: WireEntry[];
}

/** What of a machine's record still opens: the newest whole part that opens, and every numbered part after it that
 *  does, in order, one that is missing or does not open skipped. What a machine writes its own record whole again from
 *  when it cannot be read whole (a part lost or altered), so that what it names of files not here stays named. */
function salvageMachine(f: OpenFolder, mid: string, host: string): MachineState {
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(f.dir, 'machines', mid));
  } catch {
    /* nothing there */
  }
  const numbers = (kind: string): number[] => names.map((n) => new RegExp(`^${kind}-(\\d{12})$`).exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
  const ms: MachineState = { mid, host, seq: 0, snap: 0, at: 0, meta: null, files: new Map(), writer: null };
  const snaps = numbers('snap');
  for (let i = snaps.length - 1; i >= 0; i--) {
    try {
      applyPart(ms, readPart(f, mid, `snap-${pad(snaps[i])}`));
      break;
    } catch {
      /* an older whole part, then */
    }
  }
  for (const n of numbers('seg')) {
    if (n <= ms.snap) continue;
    try {
      applyPart(ms, readPart(f, mid, `seg-${pad(n)}`));
    } catch {
      /* lost or altered: what it said is not used */
    }
  }
  ms.host = host;
  return ms;
}

/** The highest part a machine's record has in the folder, whether or not it reads. */
function highestPart(f: OpenFolder, mid: string): number {
  try {
    return Math.max(0, ...fs.readdirSync(path.join(f.dir, 'machines', mid)).map((n) => /^(?:snap|seg)-(\d{12})$/.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])));
  } catch {
    return 0;
  }
}

/** A machine's record that went back to an earlier part than this machine read. Its machine writes it whole again
 *  (pushToFolder's `recover`); every other machine says so until it has. */
class RecordWentBack extends SyncSealError {
  constructor(readonly cached: number, readonly top: number) {
    super(`a machine's record in the backup went back from part ${cached} to ${top}: the folder was changed outside OAK, or put back from an older copy`);
  }
}

function readCache(f: OpenFolder, mid: string): MachineCache | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(localDir(f), `${mid}.json`), 'utf8'));
    return c && typeof c.seq === 'number' && typeof c.snap === 'number' && Array.isArray(c.files) ? c : null;
  } catch {
    return null;
  }
}

function writeCache(f: OpenFolder, ms: MachineState, parts: Record<string, [number, number]>): void {
  const c: MachineCache = { snap: ms.snap, seq: ms.seq, parts, host: ms.host, at: ms.at, meta: ms.meta, writer: ms.writer, ...encodeEntries(ms.files.values()) };
  state.writeAtomic(path.join(localDir(f), `${ms.mid}.json`), JSON.stringify(c));
}

/** A machine's record: the newest whole part and the numbered parts after it, from what this machine read before where
 *  nothing changed. Throws SyncSealError for a record with a gap, one that went back (RecordWentBack, unless
 *  `wentBack` takes it as it is now), or a part that does not open. */
function readMachine(f: OpenFolder, mid: string, write: boolean, wentBack = false): MachineState {
  const mdir = path.join(f.dir, 'machines', mid);
  for (let attempt = 0; ; attempt++) {
    let names: string[];
    try {
      names = fs.readdirSync(mdir);
    } catch {
      names = [];
    }
    const stats = (n: string): [number, number] | null => {
      try {
        const st = fs.statSync(path.join(mdir, n));
        return [st.size, Math.floor(st.mtimeMs)];
      } catch {
        return null;
      }
    };
    const snaps = names.filter((n) => /^snap-\d{12}$/.test(n)).map((n) => Number(n.slice(5))).sort((a, b) => a - b);
    const segs = names.filter((n) => /^seg-\d{12}$/.test(n)).map((n) => Number(n.slice(4))).sort((a, b) => a - b);
    const snap = snaps.length ? snaps[snaps.length - 1] : 0;
    const chain = segs.filter((n) => n > snap);
    const top = chain.length ? chain[chain.length - 1] : snap;
    try {
      for (let i = 0; i < chain.length; i++) {
        if (chain[i] !== snap + 1 + i) throw new SyncSealError(`part ${snap + 1 + i} of a machine's record is missing from the backup: the folder was changed outside OAK`);
      }
      const cache = wentBack ? null : readCache(f, mid);
      if (cache && cache.seq > top) throw new RecordWentBack(cache.seq, top);
      const parts: Record<string, [number, number]> = {};
      let ms: MachineState;
      let from: number;
      const usable = cache && cache.snap === snap && cache.seq >= snap
        && Object.entries(cache.parts).every(([n, s]) => {
          const now = stats(n);
          return now !== null && now[0] === s[0] && now[1] === s[1];
        });
      if (usable) {
        ms = { mid, host: cache.host, seq: cache.seq, snap: cache.snap, at: cache.at, meta: cache.meta, files: new Map(decodeEntries(cache.packs, cache.files).map((e) => [entryKey(e.f, e.n), e])),
          writer: typeof cache.writer === 'string' && WRITER.test(cache.writer) ? cache.writer : null };
        Object.assign(parts, cache.parts);
        from = cache.seq + 1;
      } else {
        ms = { mid, host: '', seq: 0, snap: 0, at: 0, meta: null, files: new Map(), writer: null };
        if (snap) {
          const name = `snap-${pad(snap)}`;
          applyPart(ms, readPart(f, mid, name));
          const s = stats(name);
          if (s) parts[name] = s;
        }
        from = snap + 1;
      }
      let read = !usable;
      for (let n = from; n <= top; n++) {
        const name = `seg-${pad(n)}`;
        applyPart(ms, readPart(f, mid, name));
        const s = stats(name);
        if (s) parts[name] = s;
        read = true;
      }
      if (write && read && ms.host) writeCache(f, ms, parts);
      return ms;
    } catch (e) {
      // A part removed by the machine that compacted its record while this was reading it: once more, from a new listing.
      if (attempt === 0 && (e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new SyncSealError(`a part of a machine's record went missing from the backup while it was read`);
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Whose record it is
// ---------------------------------------------------------------------------------------------------------------

const writerPath = (): string => path.join(state.syncDir(), 'writer');

/** This machine's writer id (`sync/writer`, mode 0600, made at its first push to a backup folder), or null before it:
 *  each part of its record carries it, sealed with the part. A record is named by the host name and home folder, which
 *  two machines can share (two Macs left with their default names and one user, two VMs made from one image), and a
 *  machine reinstalled has none until it takes its record over (`oak sync setup --restore`). */
export function readWriterId(): string | null {
  try {
    const w = fs.readFileSync(writerPath(), 'utf8').trim();
    return WRITER.test(w) ? w : null;
  } catch {
    return null;
  }
}

/** Whether this machine wrote the record `mid` of this folder before (its push state for it is here). */
function pushedHere(f: OpenFolder, mid: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(localDir(f), 'push.json'), 'utf8'))?.mid === mid;
  } catch {
    return false;
  }
}

/** The highest part of the record `mid` this machine wrote in this folder, or was about to (`wrote.json`, written before
 *  the part itself); null before it wrote one with this build. */
function wroteHere(f: OpenFolder, mid: string): number | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(localDir(f), 'wrote.json'), 'utf8'));
    return v?.mid === mid && Number.isInteger(v.seq) ? v.seq : null;
  } catch {
    return null;
  }
}

/** Who last wrote a record, as a person reads it: when, under what label, from what home folder. */
function lastWrite(ms: MachineState): string {
  const at = Number.isNaN(new Date(ms.at).getTime()) ? `${ms.at} ms` : new Date(ms.at).toISOString();
  return `last written ${at} by ${ms.meta?.label || 'a machine'}${ms.meta?.home ? ` (home ${ms.meta.home})` : ''}`;
}

/**
 * Whether this machine may read its own record of the folder and write it: there is none yet (its first push makes it
 * this machine's), or its last part carries this machine's writer id and is no later than the last this machine wrote
 * (wroteHere), or it was written before parts carried one and this machine wrote it (its push state is here). Otherwise
 * nothing is restored from it or written to it, every run: `unclaimed`, this machine has never written one (a machine
 * reinstalled, or another machine of the same host name and home), which `oak sync setup --restore` takes over;
 * `other`, another machine's writer wrote it, or another machine with a copy of this one's writer id.
 */
function writerCheck(f: OpenFolder, ms: MachineState | undefined, mid: string): { ok: true } | { ok: false; code: 'unclaimed' | 'other'; error: string } {
  if (!ms) return { ok: true };
  const mine = readWriterId();
  const wrote = wroteHere(f, mid);
  if (ms.writer ? ms.writer === mine && (wrote === null || ms.seq <= wrote) : pushedHere(f, mid)) return { ok: true };
  if (mine && ms.writer === mine) {
    return { ok: false, code: 'other', error: `the backup folder's record under this machine's name holds a part this machine did not write, with this machine's writer id: part ${ms.seq}, ${lastWrite(ms)}. Another machine has a copy of this machine's sync state (a VM made from its image, a home folder copied onto it). Nothing is restored from the folder or written to it: give one of the two machines another host name, since the folder names each machine by its host name and home folder; or, if this machine's own sync state was put back from an older copy, \`oak sync setup --restore\` takes the record over` };
  }
  if (!mine) {
    return { ok: false, code: 'unclaimed', error: `the backup folder holds a record under this machine's name (its host name and home folder) that this machine has not written: ${lastWrite(ms)}. If this machine is a reinstall of that one, \`oak sync setup --restore\` (or \`oak sync setup\` on a terminal) takes the record over and restores from it; if it is another machine, give it another host name, since the folder names each machine by its host name and home folder. Until then nothing is restored from the folder or written to it` };
  }
  return { ok: false, code: 'other', error: `another machine with this machine's host name and home folder writes the backup folder's record under that name: ${lastWrite(ms)}. Nothing is restored from the folder or written to it: give one of the two machines another host name, since the folder names each machine by its host name and home folder; or, if this machine replaced that one, \`oak sync setup --restore\` takes the record over` };
}

/** The record under this machine's name in the folder, as far as it reads, or undefined for none. */
function ownRecord(f: OpenFolder, host: string): MachineState | undefined {
  const mid = machineId(f, host);
  if (!highestPart(f, mid)) return undefined;
  try {
    return readMachine(f, mid, false, true);
  } catch {
    return salvageMachine(f, mid, host);
  }
}

/** Whose the folder's record under this machine's name is, for `oak sync setup`: `none` there yet, `mine`, or one this
 *  machine may not use (writerCheck's `unclaimed` and `other`), with who last wrote it. */
export function backupRecordOwner(f: OpenFolder, host: string): { state: 'none' | 'mine' | 'unclaimed' | 'other'; lastWrite?: string } {
  const ms = ownRecord(f, host);
  if (!ms) return { state: 'none' };
  const check = writerCheck(f, ms, machineId(f, host));
  return { state: check.ok ? 'mine' : check.code, lastWrite: lastWrite(ms) };
}

/** Take the folder's record under this machine's name as this machine's (`oak sync setup --restore`: this machine is a
 *  reinstall of the one that wrote it, or replaced it): its writer id becomes this machine's, and this machine's push
 *  state starts over, so the next run restores from the record and writes it on. */
export function claimBackupRecord(f: OpenFolder, host: string): void {
  const ms = ownRecord(f, host);
  if (!ms) return;
  state.writeAtomic(writerPath(), `${ms.writer ?? readWriterId() ?? randomBytes(16).toString('hex')}\n`, 0o600);
  state.writeAtomic(path.join(localDir(f), 'push.json'), JSON.stringify({ mid: machineId(f, host), meta: null, files: {} } satisfies PushState));
  state.writeAtomic(path.join(localDir(f), 'wrote.json'), JSON.stringify({ mid: machineId(f, host), seq: ms.seq }));
}

/** Every machine's record in the folder, by its keyed name; a record that cannot be read is an error of its own
 *  (`errors`, by the same name), and the rest are read. */
function readMachines(f: OpenFolder, write: boolean, errors: Map<string, unknown>): Map<string, MachineState> {
  const out = new Map<string, MachineState>();
  let mids: string[] = [];
  try {
    mids = fs.readdirSync(path.join(f.dir, 'machines')).filter((n) => NAME.test(n)).sort();
  } catch {
    /* nothing written yet */
  }
  for (const mid of mids) {
    try {
      const ms = readMachine(f, mid, write);
      if (ms.host) out.set(mid, ms);
    } catch (e) {
      errors.set(mid, e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Serving a machine's copy, as a fetch does
// ---------------------------------------------------------------------------------------------------------------

/** One file of a machine's copy, read piece by piece, each opened and checked against its hash as it is read. */
class FolderSource implements SyncFetchSource {
  size: number;
  mtime: number;
  private starts: number[] = [];
  private at = -1;
  private plain: Buffer | null = null;
  constructor(private f: OpenFolder, private e: FolderEntry, private packs: Map<string, number>) {
    this.size = e.size;
    this.mtime = e.mtime;
    let o = 0;
    for (const c of e.c) {
      this.starts.push(o);
      o += c[1];
    }
  }
  read(buf: Buffer, off: number, len: number, pos: number): number {
    if (pos >= this.size || len <= 0) return 0;
    let k = this.at >= 0 && pos >= this.starts[this.at] ? this.at : 0;
    while (k + 1 < this.starts.length && this.starts[k + 1] <= pos) k++;
    if (k !== this.at || !this.plain) {
      this.plain = readChunk(this.f, this.e.c[k], this.packs, `${this.e.f} ${this.e.n}`);
      this.at = k;
    }
    const start = pos - this.starts[k];
    const n = Math.min(len, this.plain.length - start);
    this.plain.copy(buf, off, start, start + n);
    return n;
  }
  close(): void {
    this.plain = null;
  }
}

function readFull(fd: number, buf: Buffer, len: number, pos: number): void {
  for (let got = 0; got < len;) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) throw new Error('it ended early');
    got += n;
  }
}

/** One piece of a file: its sealed bytes found, opened, and checked against its hash. */
function readChunk(f: OpenFolder, c: Chunk, packs: Map<string, number>, what: string): Buffer {
  const [sha, len] = c;
  const name = objectName(f.keys, sha);
  let sealed: Buffer;
  try {
    if (c.length === 4) {
      let fd = packs.get(c[2]);
      if (fd === undefined) {
        fd = openRegular(packPath(f, c[2]), `a pack of ${what}`);
        packs.set(c[2], fd);
      }
      sealed = Buffer.alloc(len + SEAL_OVERHEAD);
      readFull(fd, sealed, sealed.length, c[3]);
    } else sealed = readBounded(objectPath(f, name), len + SEAL_OVERHEAD, `a piece of ${what}`);
  } catch (e) {
    throw new SyncSealError(`a piece of ${what} is missing from the backup folder, or cut short (${msg(e)})`);
  }
  const plain = unseal(f.keys, sealed, `oak-sync\0object\0${name}`, `a piece of ${what} in the backup`);
  if (plain.length !== len || sha256(plain) !== sha) throw new SyncSealError(`a piece of ${what} in the backup holds other content than its name says: the folder was altered`);
  return plain;
}

/** A fetch from the folder's copy of a machine: the frames a machine's `__sync-fetch` would send, read from the folder.
 *  A file that fails its check before any of it was sent is refused alone; every such failure is said as the channel
 *  ends (`done`), so the run reports it, and none of it lands. */
function folderChannel(f: OpenFolder, ms: MachineState, request: string): SyncChannel {
  let items: SyncFetchItem[] = [];
  try {
    const r = JSON.parse(request);
    if (r && r.fetch === SYNC_FETCH_VERSION && Array.isArray(r.items)) items = r.items;
  } catch {
    /* no items */
  }
  const failures: string[] = [];
  const packs = new Map<string, number>();
  let stopped = false;
  let settle!: (v: SyncAskFailure | null) => void;
  const done = new Promise<SyncAskFailure | null>((resolve) => { settle = resolve; });
  // A file up to FOLDER_CHECK_WHOLE is read and checked whole before any of it is sent, so one that fails its check is
  // refused alone, whatever its family; a larger one is checked piece by piece as it streams, and a piece that fails
  // ends the answer there.
  const open = (fam: SyncFamily, name: string): SyncFetchSource | 'missing' | 'refused' => {
    const e = ms.files.get(entryKey(fam.id, name));
    if (!e) return 'missing';
    const src = new FolderSource(f, e, packs);
    if (e.size > FOLDER_CHECK_WHOLE) return src;
    const body = Buffer.alloc(e.size);
    for (let pos = 0; pos < e.size;) {
      const n = src.read(body, pos, e.size - pos, pos);
      if (n === 0) throw new SyncSealError(`${fam.id} ${name} in the backup is shorter than its record says`);
      pos += n;
    }
    return { size: e.size, mtime: e.mtime, read: (buf, off, len, pos) => body.copy(buf, off, pos, Math.min(e.size, pos + len)), close: () => undefined };
  };
  const skip = (i: number, error: unknown): boolean => {
    if (!(error instanceof SyncSealError)) return false;
    failures.push(`${items[i]?.name ?? i}: ${error.message}`);
    return true;
  };
  async function* stream(): AsyncGenerator<Buffer> {
    // Every read is synchronous: the event loop gets a turn now and then, so the run's time for this copy, and a signal
    // to stop, are seen while it streams.
    let turn = Date.now();
    try {
      for await (const b of syncFetchFrames(items, open, skip)) {
        if (stopped) return;
        yield b;
        if (Date.now() - turn > 50) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          turn = Date.now();
        }
      }
    } catch (e) {
      failures.push(msg(e));
      throw e;
    } finally {
      for (const fd of packs.values()) fs.closeSync(fd);
      packs.clear();
      settle(failures.length ? { status: 'failed', detail: `the backup folder's copy failed its check, and none of it was used: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? ` (and ${failures.length - 3} more)` : ''}` } : null);
    }
  }
  return { stream: stream(), done, stop: () => { stopped = true; } };
}

/** The folder's copy of a machine, as a node the engine pulls from; null for a record with no inventory yet. Its
 *  inventory is checked as another machine's is (parseSyncInventory), and each file by its family. */
function passiveNode(f: OpenFolder, ms: MachineState, label: string): SyncNode | null {
  if (!ms.meta) return null;
  const { label: _l, ...meta } = ms.meta;
  void _l;
  const parsed = parseSyncInventory(JSON.stringify({ ...meta, inventory: 1, at: ms.at || ms.meta.at, host: ms.host, families: {}, codexSqlite: [] }));
  if (!parsed || !('families' in parsed.inventory)) return null;
  const inv = parsed.inventory;
  let dropped = 0;
  const fams = new Map(syncFamilies().map((fam) => [fam.id, fam]));
  for (const e of ms.files.values()) {
    const fam = fams.get(e.f);
    if (!fam || !fam.accepts(e.n)) {
      dropped++;
      continue;
    }
    const sf: SyncFile = { name: e.n, size: e.size, mtime: e.mtime };
    if (fam.strategy === 'text') sf.sha256 = typeof e.sha === 'string' && NAME.test(e.sha) ? e.sha : null;
    if (typeof e.cwd === 'string' && e.cwd) sf.cwd = e.cwd;
    if (typeof e.stamp === 'string' && /^[\w:.-]{1,200}$/.test(e.stamp)) sf.stamp = e.stamp;
    if (e.gen) sf.gen = e.gen;
    (inv.families[e.f] ??= []).push(sf);
  }
  return { label, local: false, status: 'ok', passive: true, inventory: inv, dropped, channel: (req) => folderChannel(f, ms, req) };
}

// ---------------------------------------------------------------------------------------------------------------
// Writing this machine's record
// ---------------------------------------------------------------------------------------------------------------

/** Writes objects and packs to the folder, each content once: what any machine's record already names is not written
 *  again. */
class FolderWriter {
  private known = new Map<string, Chunk>();
  private pack: Buffer[] = [];
  private packSize = 0;
  private pending: Chunk[] = [];
  readonly tmp: string;
  constructor(private f: OpenFolder, mid: string, machines: Iterable<MachineState>) {
    for (const ms of machines) for (const e of ms.files.values()) for (const c of e.c) if (!this.known.has(c[0])) this.known.set(c[0], c);
    this.tmp = path.join(f.dir, 'machines', mid, 'tmp');
  }

  /** Remove what a run of this machine that was killed left half written (its own folder alone). One the share will not
   *  let go of is left: nothing names it. */
  clearTmp(): void {
    ownDir(path.dirname(path.dirname(this.tmp)));
    ownDir(path.dirname(this.tmp));
    ownDir(this.tmp);
    for (const n of fs.readdirSync(this.tmp)) {
      if (!/^[0-9a-f]+\.tmp$/.test(n)) continue;
      try {
        fs.rmSync(path.join(this.tmp, n), { force: true });
      } catch {
        /* left for a later run */
      }
    }
  }

  /** Write `data` at `dest`: a temporary file, flushed, renamed. Another machine that wrote the same name first wrote the
   *  same content (a name is its content's), so a rename refused over it is no error. */
  writeShared(dest: string, data: Buffer, unique = false): void {
    if (unique && fs.existsSync(dest)) throw new Error(`${path.basename(dest)} is already in the backup: another machine writes under this machine's name (the same host name and home)`);
    // Each folder on the way, from the top: a link is refused before anything is made through it.
    const dirs: string[] = [];
    for (let d = path.dirname(dest); d.length > this.f.dir.length; d = path.dirname(d)) dirs.unshift(d);
    for (const d of dirs) ownDir(d);
    const tmp = path.join(this.tmp, `${randomBytes(8).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
      for (let off = 0; off < data.length;) off += fs.writeSync(fd, data, off, data.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, dest);
    } catch (e) {
      if (!unique && fs.existsSync(dest)) fs.rmSync(tmp, { force: true });
      else throw e;
    }
  }

  /** Which objects and packs were found in the folder this run, as large as the pieces they hold need. */
  private there = new Map<string, number>();

  /** Whether the folder still holds the object a known piece names: an object lost, or cut short, is written again rather
   *  than named by another file. Each file is looked at once a run. */
  present(c: Chunk): boolean {
    const file = c.length === 4 ? packPath(this.f, c[2]) : objectPath(this.f, objectName(this.f.keys, c[0]));
    if (c.length === 4 && c[2] === '') return true; // in the pack being filled
    let size = this.there.get(file);
    if (size === undefined) {
      try {
        const st = fs.lstatSync(file);
        size = st.isFile() ? st.size : -1;
      } catch {
        size = -1;
      }
      this.there.set(file, size);
    }
    return c.length === 4 ? size >= c[3] + c[1] + SEAL_OVERHEAD : size === c[1] + SEAL_OVERHEAD;
  }

  /** The piece for `plain`: one the folder holds already, or a new object (bytes written counted). */
  put(plain: Buffer, sha = sha256(plain)): { chunk: Chunk; bytes: number } {
    const known = this.known.get(sha);
    if (known && this.present(known)) return { chunk: known, bytes: 0 };
    const name = objectName(this.f.keys, sha);
    const aad = `oak-sync\0object\0${name}`;
    if (plain.length >= FOLDER_LOOSE_MIN) {
      const dest = objectPath(this.f, name);
      const c: Chunk = [sha, plain.length];
      if (!this.present(c)) {
        // One of the same name that is not whole (cut short, or not OAK's) is replaced.
        if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
        this.writeShared(dest, seal(this.f.keys, plain, aad));
        this.there.set(dest, plain.length + SEAL_OVERHEAD);
      }
      this.known.set(sha, c);
      return { chunk: c, bytes: plain.length };
    }
    const sealed = seal(this.f.keys, plain, aad);
    const c: Chunk = [sha, plain.length, '', this.packSize];
    this.pack.push(sealed);
    this.packSize += sealed.length;
    this.pending.push(c);
    this.known.set(sha, c);
    if (this.packSize >= FOLDER_PACK_TARGET) this.flush();
    return { chunk: c, bytes: plain.length };
  }

  /** Write the pack of the small objects put since the last, and name it in each of their pieces. */
  flush(): void {
    if (!this.pending.length) return;
    const body = Buffer.concat(this.pack);
    const name = keyedName(this.f.keys, `pack\0${sha256(body)}`);
    this.writeShared(packPath(this.f, name), body);
    for (const c of this.pending) (c as [string, number, string, number])[2] = name;
    this.pack = [];
    this.packSize = 0;
    this.pending = [];
  }

  /** Forget the objects put since the last flush, for a run that stops before writing them (nothing names them). */
  discard(): void {
    for (const c of this.pending) this.known.delete(c[0]);
    this.pack = [];
    this.packSize = 0;
    this.pending = [];
  }

  /**
   * One file, cut at FOLDER_CHUNK offsets. Its last, partial piece keeps the pieces it had where the file only grew
   * since (each checked against the bytes now there), and adds what it grew by. Null when the file changed while it was
   * read: the next run takes it.
   */
  file(fam: SyncFamily, e: SyncFile, file: string, prev: FolderEntry | undefined): { entry: FolderEntry; bytes: number } | null {
    const fd = fs.openSync(file, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error('it is not a file');
      const size = st.size;
      const fullEnd = Math.floor(size / FOLDER_CHUNK) * FOLDER_CHUNK;
      const whole = fam.strategy === 'text' || fam.strategy === 'cas' ? createHash('sha256') : null;
      const chunks: Chunk[] = [];
      let bytes = 0;
      const prevStarts: number[] = [];
      for (let o = 0, k = 0; prev && k < prev.c.length; k++) {
        prevStarts.push(o);
        o += prev.c[k][1];
      }
      let same = !!prev && fam.strategy !== 'cas';
      const buf = Buffer.alloc(Math.min(FOLDER_CHUNK, Math.max(1, fullEnd)));
      for (let pos = 0; pos < fullEnd; pos += FOLDER_CHUNK) {
        readFull(fd, buf, FOLDER_CHUNK, pos);
        whole?.update(buf);
        const sha = sha256(buf);
        const k = pos / FOLDER_CHUNK;
        if (same && !(prev!.c[k] && prevStarts[k] === pos && prev!.c[k][1] === FOLDER_CHUNK && prev!.c[k][0] === sha)) same = false;
        const r = this.put(buf, sha);
        bytes += r.bytes;
        chunks.push(r.chunk);
      }
      if (size > fullEnd) {
        const tail = Buffer.alloc(size - fullEnd);
        readFull(fd, tail, tail.length, fullEnd);
        whole?.update(tail);
        let pieces: Chunk[] | null = null;
        if (same && prev && prev.size >= fullEnd && prev.size <= size) {
          const first = prevStarts.findIndex((o) => o >= fullEnd);
          const kept = first < 0 ? [] : prev.c.slice(first);
          const full = first < 0 ? prev.c.length : first;
          if (full === fullEnd / FOLDER_CHUNK && (first < 0 ? prev.size === fullEnd : prevStarts[first] === fullEnd)
            && kept.every((c, j) => sha256(tail.subarray(prevStarts[first + j] - fullEnd, prevStarts[first + j] - fullEnd + c[1])) === c[0] && this.present(c))) pieces = kept;
        }
        if (pieces && pieces.length < FOLDER_PIECES_MAX) {
          chunks.push(...pieces);
          if (size > prev!.size) {
            const r = this.put(tail.subarray(prev!.size - fullEnd));
            bytes += r.bytes;
            chunks.push(r.chunk);
          }
        } else {
          const r = this.put(tail);
          bytes += r.bytes;
          chunks.push(r.chunk);
        }
      }
      const after = fs.fstatSync(fd);
      if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) return null;
      const sha = whole?.digest('hex');
      if (fam.strategy === 'cas' && sha !== path.basename(e.name)) throw new Error('its bytes do not hash to its name, so it is not backed up');
      const entry: FolderEntry = {
        f: fam.id, n: e.name, size, mtime: Math.floor(st.mtimeMs), c: chunks,
        ...(sha ? { sha } : {}), ...(fam.stamp ? { stamp: fam.stamp(st, fd) } : {}), ...(e.cwd ? { cwd: e.cwd } : {}), ...(e.gen ? { gen: e.gen } : {}),
      };
      return { entry, bytes };
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** What this machine knows of what it last wrote to the folder: per file, its size, time and stamp then, so an
 *  unchanged file is not read again; and the hash of the inventory it wrote last. */
interface PushState {
  mid: string;
  meta: string | null;
  files: Record<string, [number, number, string?]>;
}

function readPushState(f: OpenFolder, mid: string): PushState {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(localDir(f), 'push.json'), 'utf8'));
    if (v && v.mid === mid && v.files && typeof v.files === 'object') return v;
  } catch {
    /* none yet */
  }
  return { mid, meta: null, files: {} };
}

/** A machine's inventory without its files, and without the time it was taken, which every run changes. */
function metaOf(me: SyncInventory): FolderMeta {
  const { families: _f, inventory: _i, ...rest } = me;
  void _f;
  void _i;
  return { ...rest, label: localSyncLabel() };
}

/** Whether the file at `file` begins with what a record's entry names: each of its pieces, read where it lies, hashes as
 *  the entry says. */
function startsWithEntry(file: string, e: FolderEntry): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return false;
  }
  try {
    if (fs.fstatSync(fd).size < e.size) return false;
    let pos = 0;
    for (const c of e.c) {
      const buf = Buffer.alloc(c[1]);
      readFull(fd, buf, c[1], pos);
      if (sha256(buf) !== c[0]) return false;
      pos += c[1];
    }
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The sessions of this machine's own whose folder here is a new generation of the one the record holds (sync-store.ts),
 * with the name each one's earlier history is kept under. The folder is the record's when the record's files of it were
 * written from the folder's generation; or, where the two differ or the record's name none (written before generations
 * were), when each log and events file the record holds of the session is the start of the one here, unchanged or only
 * grown since: those sessions go to `adopted` with the folder's generation, which their files are written with again. A
 * folder a run is putting back is the record's (adopted with the record's generation once its log is back), and so is
 * that of a session deleted on purpose (`oak sessions --delete`, here or on another machine): a delete stays one, and
 * its captured edits are not kept as an earlier history. So is one cleaned up here and made again before a run saw it,
 * which goes on from the generation of the one cleaned up (sync-store.ts ownGeneration). Anything else is the folder a
 * capture made anew, whose log starts over.
 */
function newGenerations(own: MachineState, me: SyncInventory, fams: Map<string, SyncFamily>, pushed: PushState['files'],
  refuse: ReturnType<typeof neverRead>, genNow: (sid: string) => string | null, adopted: Map<string, string>): Map<string, string> {
  const recorded = new Map<string, string | null>();
  const anchors = new Map<string, FolderEntry[]>();
  for (const e of own.files.values()) {
    if (e.f === 'oak-blobs' || fams.get(e.f)?.agent !== 'oak') continue;
    const p = parseStoreName(e.n);
    if (!p || p.kind === 'replica') continue;
    if (e.gen || !recorded.has(p.sid)) recorded.set(p.sid, e.gen ?? null);
    if (p.kind === 'own' && (e.f === 'oak-log' || e.f === 'oak-events')) anchors.set(p.sid, [...(anchors.get(p.sid) ?? []), e]);
  }
  const here = new Map<string, Map<string, SyncFile>>();
  for (const id of ['oak-log', 'oak-meta', 'oak-events']) {
    for (const e of me.families[id] ?? []) {
      const p = e.origin ? null : parseStoreName(e.name);
      if (p?.kind === 'own') here.set(p.sid, (here.get(p.sid) ?? new Map()).set(e.name, e));
    }
  }
  const out = new Map<string, string>();
  const deleted = deletedSessions([me]);
  for (const [sid, files] of here) {
    if (!recorded.has(sid)) continue;
    const was = recorded.get(sid)!;
    const gen = genNow(sid);
    if ((was && was === gen) || deleted.has(sid)) continue;
    if (restoringSession(sid)) {
      // What is back of it is the record's, and keeps the record's generation once the record's log of it is back too:
      // until then a capture that starts a log in it makes a new generation.
      if (was && (fs.existsSync(path.join(rootDir(), sid, 'log.jsonl')) || !anchors.get(sid)?.some((a) => a.f === 'oak-log'))) adopted.set(sid, was);
      continue;
    }
    const grown = (anchors.get(sid) ?? []).every((a) => {
      const now = files.get(a.n);
      const last = pushed[entryKey(a.f, a.n)];
      if (now && last && a.size === last[0] && now.size === last[0] && now.mtime === last[1] && (last[2] ?? '') === (now.stamp ?? '')) return true;
      const file = syncLocalPath(fams.get(a.f)!, a.n, refuse);
      return !!file && startsWithEntry(file, a);
    });
    if (grown) {
      if (gen) adopted.set(sid, gen);
    } else out.set(sid, earlierGenerationId(sid, was ?? randomBytes(8).toString('hex')));
  }
  return out;
}

/**
 * Write this machine's own files to the folder: what changed since it last wrote them, as objects, then one part of its
 * record naming them, the files it no longer holds, and its inventory. Files other machines made (copies it pulled, the
 * replicas it holds) are theirs to write. A family turned off here is left as it was there. A family that lost more than
 * half its files at once, or whose folder is gone, passes no removal on (an unmounted folder is no delete), except of
 * sessions removed here on purpose. At most SYNC_RUN_MAX_BYTES and SYNC_PEER_BUDGET_MS a run; the rest is pending.
 * Nothing changed: nothing is written, the folder not even touched.
 */
export async function pushToFolder(f: OpenFolder, run: SyncBackupPush, machines: Map<string, MachineState>, limits: { bytes?: number; ms?: number; part?: number } = {},
  recover: { from: number } | null = null): Promise<SyncBackupPushResult> {
  const result: SyncBackupPushResult = { pushed: { files: 0, bytes: 0 }, pending: { files: 0, bytes: 0 }, errors: [], warnings: [] };
  const host = run.me.host;
  const mid = machineId(f, host);
  const own: MachineState = machines.get(mid) ?? { mid, host, seq: 0, snap: 0, at: 0, meta: null, files: new Map(), writer: null };
  // After a record went back, nothing this machine wrote since is taken as there: every file is read again, and each
  // object it names is checked to be there (FolderWriter.put).
  const ps = recover ? { mid, meta: null, files: {} } : readPushState(f, mid);
  const w = new FolderWriter(f, mid, machines.values());
  w.clearTmp();
  const next = new Map(own.files);
  const nextFiles: PushState['files'] = { ...ps.files };
  const put: FolderEntry[] = [];
  const del: [string, string][] = [];
  const refuse = neverRead();
  const fams = new Map(syncFamilies().map((fam) => [fam.id, fam]));
  // Each session folder's generation as it is now, not as the run's first inventory found it: a folder lost and made anew
  // while the run pulled is another generation, whatever that inventory names it.
  const gens = new Map<string, string | null>();
  const genNow = (sid: string): string | null => {
    if (!gens.has(sid)) gens.set(sid, ownGeneration(sid).gen);
    return gens.get(sid)!;
  };
  // Each session folder made anew here since the record named it (its store lost with no cleanup, then captured into):
  // the record's files of the session stay, as its earlier history (earlierGenerationId), and the folder's are written
  // as the session's. Keys of the record this push leaves to that history (`gone`).
  const gone = new Set<string>();
  const adopted = new Map<string, string>();
  const anew = newGenerations(own, run.me, fams, nextFiles, refuse, genNow, adopted);
  if (anew.size) {
    for (const [key, e] of own.files) {
      const p = fams.get(e.f)?.agent === 'oak' ? parseStoreName(e.n) : null;
      const to = p && p.kind !== 'replica' ? anew.get(p.sid) : undefined;
      if (!to) continue;
      const moved: FolderEntry = { ...e, n: p!.kind === 'old-comments' ? `changemap-cache/${to}/comments.json` : `${to}/${p!.rest}` };
      gone.add(key);
      next.delete(key);
      delete nextFiles[key];
      del.push([e.f, e.n]);
      next.set(entryKey(e.f, moved.n), moved);
      put.push(moved);
    }
  }
  for (const [sid, to] of anew) {
    state.audit({ op: 'earlier', name: to, detail: `in the backup folder ${f.dir}: what it held of session ${sid} before its folder was made anew here` });
    result.warnings.push(`session ${sid}'s folder was made anew here: the backup keeps what it held of it before as session ${to}, its earlier history, which the next run brings back here`);
  }
  const started = Date.now();
  let budget = limits.bytes ?? SYNC_RUN_MAX_BYTES;
  const budgetMs = limits.ms ?? SYNC_PEER_BUDGET_MS;
  let touched = Date.now();
  let turn = Date.now();
  const seen = new Set<string>();
  for (const fam of syncFamilies()) {
    if (placementOf(fam, run.placements) === 'off') continue;
    for (const e of run.me.families[fam.id] ?? []) {
      if (e.origin) continue;
      const key = entryKey(fam.id, e.name);
      seen.add(key);
      const prev = gone.has(key) ? undefined : own.files.get(key);
      const was = nextFiles[key];
      if (prev && was && was[0] === e.size && was[1] === e.mtime && (was[2] ?? '') === (e.stamp ?? '')) continue;
      if (prev && fam.strategy === 'cas' && prev.size === e.size) continue; // a blob is its name
      if (budget <= 0 || Date.now() - started > budgetMs) {
        result.pending.files++;
        result.pending.bytes += e.size;
        continue;
      }
      const file = syncLocalPath(fam, e.name, refuse);
      if (!file) continue;
      // A file of OAK's store is written under its folder's generation as it is now.
      const p = fam.agent === 'oak' && fam.strategy !== 'cas' ? parseStoreName(e.name) : null;
      const g = p && p.kind !== 'replica' ? genNow(p.sid) : undefined;
      try {
        const out = w.file(fam, g === undefined || g === (e.gen ?? null) ? e : { ...e, gen: g ?? undefined }, file, prev);
        if (!out) {
          result.pending.files++;
          result.pending.bytes += e.size;
          continue;
        }
        next.set(key, out.entry);
        put.push(out.entry);
        if (fam.strategy !== 'cas') nextFiles[key] = out.entry.stamp ? [out.entry.size, out.entry.mtime, out.entry.stamp] : [out.entry.size, out.entry.mtime];
        result.pushed.files++;
        result.pushed.bytes += out.bytes;
        budget -= out.bytes;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // gone since the inventory
        result.errors.push(`${fam.id} ${e.name}: ${msg(err)}`);
      }
      if (Date.now() - touched > 10_000) {
        touched = Date.now();
        state.touchSyncLock();
      }
      // Every write is synchronous: the event loop gets a turn now and then, so a signal to stop is seen meanwhile (the
      // run is then stopped where it is, and the folder is as it was: no part of the record was written yet).
      if (Date.now() - turn > 50) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        turn = Date.now();
      }
    }
  }
  // What goes from the record: only what went on purpose. A session this machine cleaned up (its eviction list), and a
  // snapshot of a session used here whose log names it no more (the store collected it, or an ignore sweep dropped
  // it). Anything else gone here stays, the backup's to keep: a file lost, one not put back yet (a restore takes more
  // than one run when it is large), one Claude Code's retention swept, a folder not mounted. A run puts back what is
  // still wanted here, and a deliberate delete is a delete everywhere (its tombstone), which an undelete reverses.
  const evicted = new Set((run.me.sync?.evicted ?? []).map((e) => e.id));
  const logNames = new Map<string, Set<string> | null>();
  const named = (sid: string): Set<string> | null => {
    if (!logNames.has(sid)) {
      let names: Set<string> | null = null;
      try {
        names = new Set();
        for (const line of fs.readFileSync(path.join(rootDir(), sid, 'log.jsonl'), 'utf8').split('\n')) {
          if (!line.includes('Blob')) continue;
          try {
            const r = JSON.parse(line);
            if (typeof r?.beforeBlob === 'string') names.add(r.beforeBlob);
            if (typeof r?.afterBlob === 'string') names.add(r.afterBlob);
          } catch {
            /* a torn line names nothing */
          }
        }
      } catch {
        names = null; // no log: nothing says what was collected
      }
      logNames.set(sid, names);
    }
    return logNames.get(sid)!;
  };
  for (const e of own.files.values()) {
    const key = entryKey(e.f, e.n);
    const fam = fams.get(e.f);
    if (seen.has(key) || gone.has(key) || !fam || fam.agent !== 'oak') continue;
    const sid = fam.session?.(e.n);
    if (!sid) continue;
    let drop = evicted.has(sid);
    if (!drop && fam.strategy === 'cas' && fs.existsSync(path.join(rootDir(), sid)) && !restoringSession(sid)) {
      const names = named(sid);
      drop = !!names && !names.has(path.basename(e.n));
    }
    // Comments where they were kept until 0.11.0, which comments.ts has carried into the session's own file: kept, a
    // restore brought the old file back beside the new, and with it every comment removed since.
    if (!drop && parseStoreName(e.n)?.kind === 'old-comments' && fs.existsSync(path.join(rootDir(), sid, 'comments.json'))) drop = true;
    if (!drop) continue;
    const p = syncLocalPath(fam, e.n, refuse);
    if (p && fs.existsSync(p)) continue; // here after all
    next.delete(key);
    delete nextFiles[key];
    del.push([e.f, e.n]);
  }
  // A session the record named with another generation, or none, whose folder here holds what the record does and only
  // grew since: the record names it with the folder's generation from now on, and so does its folder (a folder a run
  // left half put back carries the record's), whether or not this push has anything to write.
  if (adopted.size) {
    for (const [key, e] of next) {
      const p = e.f === 'oak-blobs' || gone.has(key) ? null : parseStoreName(e.n);
      const gen = p && p.kind !== 'replica' ? adopted.get(p.sid) : undefined;
      if (!gen || e.gen === gen) continue;
      const named: FolderEntry = { ...e, gen };
      next.set(key, named);
      put.push(named);
    }
    for (const [sid, gen] of adopted) markSessionGeneration(sid, gen);
  }
  const meta = metaOf(run.me);
  const { at: _at, ...stable } = meta;
  void _at;
  const metaHash = sha256(JSON.stringify(stable));
  const metaChanged = metaHash !== ps.meta || !own.meta;
  if (!put.length && !del.length && !metaChanged && !recover) {
    w.discard();
    return result;
  }
  w.flush();
  // This machine's writer id, made at its first push: every part carries it (writerCheck).
  let writer = readWriterId();
  if (!writer) {
    writer = randomBytes(16).toString('hex');
    state.writeAtomic(writerPath(), `${writer}\n`, 0o600);
  }
  // Numbered on from the highest part any machine may have read, so none takes the record for one that went back. Noted
  // here before it is written: a part above the last this machine wrote is another machine's (writerCheck).
  const seq = Math.max(own.seq, recover?.from ?? 0) + 1;
  state.writeAtomic(path.join(localDir(f), 'wrote.json'), JSON.stringify({ mid, seq }));
  const mdir = path.join(f.dir, 'machines', mid);
  // No part larger than a reader takes (PART_MAX). Written, it was read by no other machine, nor by this one reinstalled,
  // whose first run then wrote its record whole again without what that part named.
  const partMax = limits.part ?? PART_MAX;
  const writePart = (name: string, body: unknown): void => {
    const sealed = seal(f.keys, Buffer.from(JSON.stringify(body)), `oak-sync\0manifest\0${mid}\0${name}`);
    if (sealed.length > partMax) throw new SyncSealError(`this machine's record in the backup has outgrown what one part of it may hold (${sealed.length} bytes, past ${partMax}), so nothing more is written there`);
    w.writeShared(path.join(mdir, name), sealed, true);
  };
  const wirePut = encodeEntries(put);
  const after: MachineState = { mid, host, seq, snap: own.snap, at: run.now, meta: metaChanged ? meta : own.meta, files: next, writer };
  if (recover) {
    // Whole, so the record reads from this part alone, whatever went missing below it.
    writePart(`snap-${pad(seq)}`, { v: FOLDER_FORMAT, kind: 'snap', seq, host, at: run.now, writer, meta: after.meta, ...encodeEntries(next.values()) });
    after.snap = seq;
  } else writePart(`seg-${pad(seq)}`, { v: FOLDER_FORMAT, kind: 'seg', seq, host, at: run.now, writer, packs: wirePut.packs, put: wirePut.files, del, ...(metaChanged ? { meta } : {}) });
  // Every so many parts, a whole one, and the parts before the one before it go: a reader that started on the previous
  // whole part still finds every part after it.
  if (recover || seq - own.snap >= FOLDER_SEGMENTS_PER_SNAPSHOT) {
    try {
      if (!recover) writePart(`snap-${pad(seq)}`, { v: FOLDER_FORMAT, kind: 'snap', seq, host, at: run.now, writer, meta: after.meta, ...encodeEntries(next.values()) });
      after.snap = seq;
      const names = fs.readdirSync(mdir);
      const snaps = names.filter((n) => /^snap-\d{12}$/.test(n)).map((n) => Number(n.slice(5))).sort((a, b) => b - a);
      const keepFrom = snaps[1] ?? 0;
      for (const n of names) {
        const m = /^(snap|seg)-(\d{12})$/.exec(n);
        if (!m) continue;
        const k = Number(m[2]);
        if ((m[1] === 'snap' && k < keepFrom) || (m[1] === 'seg' && k <= keepFrom)) fs.rmSync(path.join(mdir, n), { force: true });
      }
    } catch (e) {
      result.warnings.push(`the backup's record of this machine could not be compacted: ${msg(e)}`);
    }
  }
  machines.set(mid, after);
  try {
    const parts: Record<string, [number, number]> = {};
    for (const n of fs.readdirSync(mdir)) {
      const m = /^(snap|seg)-(\d{12})$/.exec(n);
      if (!m || Number(m[2]) < after.snap || (m[1] === 'snap' && Number(m[2]) !== after.snap)) continue;
      const st = fs.statSync(path.join(mdir, n));
      parts[n] = [st.size, Math.floor(st.mtimeMs)];
    }
    writeCache(f, after, parts);
  } catch {
    /* read again next time */
  }
  state.writeAtomic(path.join(localDir(f), 'push.json'), JSON.stringify({ mid, meta: metaHash, files: nextFiles } satisfies PushState));
  state.audit({ op: 'backup', name: f.dir, bytes: result.pushed.bytes, detail: `${result.pushed.files} file${result.pushed.files === 1 ? '' : 's'} written, ${del.length} removed; part ${seq} of this machine's record` });
  // Each session folder this part named carries the generation the record names it by, from now on: a later rewrite of
  // its log (a clear, an ignore sweep) keeps the folder's generation. The last entry that names a session is the record's.
  const marks = new Map<string, string>();
  for (const e of put) {
    const p = e.gen && e.f !== 'oak-blobs' ? parseStoreName(e.n) : null;
    if (p?.kind === 'own') marks.set(p.sid, e.gen!);
  }
  for (const [sid, gen] of marks) markSessionGeneration(sid, gen);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// The backup kind
// ---------------------------------------------------------------------------------------------------------------

/** The folder's copy of each machine, labelled `backup:<its label>`, and its record of this machine's evictions. */
export function folderNodes(f: OpenFolder, machines: Map<string, MachineState>): SyncNode[] {
  const labels = new Set<string>();
  const out: SyncNode[] = [];
  for (const ms of machines.values()) {
    let label = `backup:${ms.meta?.label || ms.host}`;
    const hostId = ms.host;
    if (labels.has(label)) label = `${label}-${hostId.slice(0, 6)}`;
    labels.add(label);
    const n = passiveNode(f, ms, label);
    if (n) out.push(n);
  }
  return out;
}

registerSyncBackupKind('folder', (setting, ctx): SyncBackupRole | null => {
  if (setting.kind !== 'folder') return null;
  const base: SyncBackupRole = { kind: 'folder', label: backupFolderPath(setting.path), self: false, node: null };
  let opened: FolderCheck;
  try {
    opened = openBackupFolder(setting.path);
  } catch (e) {
    return { ...base, error: msg(e) };
  }
  if (!opened.ok) return { ...base, error: opened.error };
  const f = opened.folder;
  const errors = new Map<string, unknown>();
  const machines = readMachines(f, !ctx.readOnly, errors);
  const mid = machineId(f, ctx.local.host);
  // This machine's own record that cannot be read (it went back to an older copy, a part was lost or altered) is written
  // whole again from what is here and what of the record still opens, numbered on from the highest part any machine may
  // have read: it is this machine's alone to write, and nothing of what could not be read is used. The run says so as
  // an error. A plan only says it.
  let recover: { from: number; reason: string } | null = null;
  const own = errors.get(mid);
  if (own && !ctx.readOnly) {
    let start: MachineState | null = null;
    if (own instanceof RecordWentBack) {
      try {
        start = readMachine(f, mid, true, true);
      } catch {
        start = null;
      }
    }
    machines.set(mid, start?.host ? start : salvageMachine(f, mid, ctx.local.host));
    errors.delete(mid);
    recover = { from: Math.max(own instanceof RecordWentBack ? own.cached : 0, highestPart(f, mid), readCache(f, mid)?.seq ?? 0), reason: msg(own) };
  }
  if (errors.has(mid)) return { ...base, error: msg(errors.get(mid)) };
  // A record under this machine's name that another machine writes, or that this machine has not taken over (a
  // reinstall), is neither restored from nor written: said every run, with what to do.
  const writer = writerCheck(f, machines.get(mid), mid);
  if (!writer.ok) return { ...base, error: writer.error, record: writer.code };
  // The sessions this machine removed on purpose, as its record there says: never put back here, even by a machine
  // reinstalled since, which has no list of its own yet.
  noteFolderEvictions(machines.get(mid)?.meta?.sync?.evicted ?? [], !ctx.readOnly);
  // A machine with no record there yet is new to the folder: its first push writes one, which is then its own (writerCheck).
  // A reinstall is the record under its name it has not written, which writerCheck refuses with the way to take it over.
  const warnings = !machines.has(mid) && machines.size > 0
    ? [`the backup folder holds no record of this machine yet (it is known there by its host name and home folder): ${ctx.readOnly ? 'its first run writes one' : 'this run writes its first'}, which is this machine's from then on`]
    : [];
  return {
    ...base,
    nodes: folderNodes(f, machines),
    ...(errors.size || recover ? { errors: [...[...errors.values()].map(msg), ...(recover ? [`this machine's record could not be read (${recover.reason}); it is written whole again from what of it still reads and what is here`] : [])] } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(ctx.readOnly ? {} : { push: (run: SyncBackupPush) => pushToFolder(f, run, machines, {}, recover) }),
  };
});
