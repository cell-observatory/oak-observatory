/**
 * oak sync's engine: `oak sync now`, `oak sync fetch`, `oak sync status`, the fetch command other machines run
 * here, and the settings, backup target and placement policy they share. sync.ts takes the inventories and
 * computes the plan; this file carries a plan out.
 *
 * PULL ONLY. A machine writes its own disk and nothing else. It reads its peers over OAK's own ssh with two
 * hidden commands: `oak __sync-inventory` (sync.ts), which a run asks to catch that machine's own local index up first
 * (`--publish`: the one write it asks, to that machine's own record log, never a plan's), and `oak __sync-fetch`, which streams the
 * files a request names (serveSyncFetch), each behind a header line, in one round trip per machine for every
 * family. A request for an append-only file names the size this machine holds and the hash of those bytes; the
 * peer sends only what follows when its own first bytes hash the same, and its whole file otherwise, which this
 * machine keeps as a conflict copy and never in Claude Code's folders. A tail is cut at its last complete line.
 * Every file is written beside its target and renamed over it, so a run killed mid-write leaves the old file or the
 * new one, never a torn one; the temporary files a killed run left are removed by the next. What a write replaces
 * goes to the trash first, and every write goes to the audit log (sync-state.ts).
 *
 * PLACEMENT. Each data family has a placement (`everywhere`, `backup`, `on-demand` or `off`; SyncFamily.placement,
 * overridden per machine in prefs.json `sync.families`). Small text the agents read from local disk (memory,
 * plans, skills, agents, commands) is `everywhere`, merged three ways against the last version the machines
 * shared. Sessions are `backup`: a session's files stay on the machine that made them, plus the backup target
 * (prefs.json `sync.backup`), which pulls every machine's; any other machine holds the index (every peer's
 * inventory, `sync/index/`) and fetches a session when asked (`oak sync fetch`), keeping it as an evictable copy.
 * A machine always pulls its own sessions back from wherever they are, which is how one that was wiped is restored
 * from its backup.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  syncInventory, parseSyncInventory, planSync, syncFamily, syncFamilies, neverRead, syncLocalPath, folderMapper, localUserName, sessionOf,
  CLAUDE_DEFAULT_RETENTION_DAYS, localSyncLabel, SYNC_HASH_MAX_BYTES, SYNC_TOMBSTONE_AHEAD_MS,
  type SyncInventory, type SyncNode, type SyncPlanItem, type SyncFamily, type SyncFile, type SyncPlacement, type SyncChannel,
  type SyncAskFailure, type SyncMachineStatus,
} from './sync';
import * as state from './sync-state';
import { SYNC_RUN_STALE_MS } from './sync-state';
import { claudeConfigDir } from './paths';
import { threeWayMerge } from './merge';
import { hiddenSessions, hideSession, unhideSession, storeMoveHolder, rootDir } from './store';
import { plainLabel, machineHostTag } from './machine-usage';
import { SYNC_AUTO_MS, readSyncBackoff, syncBackedOff } from './sync-kick';
import { upkeepStoreReplicas, noteLandedGenerations } from './sync-store';
import { readSyncKey, keyFingerprint } from './sync-crypto';
import type { HerdrMachine } from './herdr';
import type { Check } from './diagnose';

export const SYNC_FETCH_VERSION = 1;
/** The on-demand copies a machine keeps, in megabytes, unless prefs.json `sync.cacheMB` says otherwise. */
export const SYNC_CACHE_MB = 2048;
/** The most bytes one run asks one machine for; what is left is pulled by the next run. */
export const SYNC_RUN_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** The longest one run reads from one machine. A machine that sends slower than that is stopped there: what it sent
 *  of a session lands up to its last complete line, and the rest waits for the next run. */
export const SYNC_PEER_BUDGET_MS = 10 * 60_000;
/** A session file written here this recently, by anything but sync, belongs to a session running here: no tail lands
 *  on it (requestItem). */
export const SYNC_ACTIVE_MS = 60_000;

/** Where the backup is: a saved machine (by its label here), or a folder (by its path on this machine). Only the
 *  machine kind is carried out in this release; a folder target registers its own kind (registerSyncBackupKind). */
export type SyncBackupSetting = { kind: 'machine'; label: string } | { kind: 'folder'; path: string };

export interface SyncSettings {
  backup: SyncBackupSetting | null;
  /** Placement overrides by family id. */
  families: Record<string, SyncPlacement>;
  excludeMachines: string[];
  excludeProjects: string[];
  cacheMB: number;
  /** Whether the background run (kicked by the capture hooks and the pollers) may run. */
  auto: boolean;
}

/** prefs.json `sync`, as prefs.ts validated it, put back from oak sync's copy when an older OAK dropped it (keptPrefs). */
export function syncSettings(prefs = state.keptPrefs()): SyncSettings {
  const s = prefs.sync ?? {};
  return {
    backup: s.backup ?? null,
    families: { ...(s.families ?? {}) },
    excludeMachines: [...(s.exclude?.machines ?? [])],
    excludeProjects: [...(s.exclude?.projects ?? [])],
    cacheMB: s.cacheMB ?? SYNC_CACHE_MB,
    auto: s.auto !== false,
  };
}

/** What deleting a session purges and what `oak sessions --undelete` brings back, as `oak sessions --delete` says it,
 *  for the surfaces' confirmations: its edits for good, or, with a backup folder set (which keeps its copy of the
 *  session's store), here only, and the next `oak sync now` after an undelete brings back what of them it holds. */
export function deleteWords(settings: Pick<SyncSettings, 'backup'> = syncSettings()): { folder: boolean; purged: string; after: string } {
  return settings.backup?.kind === 'folder'
    ? { folder: true, purged: 'here (the backup folder keeps its copy)', after: 'and the next oak sync now brings back what of its edits the backup folder holds' }
    : { folder: false, purged: 'for good', after: 'without its edits' };
}

/** A family's placement on this machine: its override, else its default. Text families are everywhere or off. */
export function placementOf(fam: SyncFamily, families: Record<string, SyncPlacement>): SyncPlacement {
  const p = families[fam.id] ?? fam.placement;
  return fam.strategy === 'text' && p !== 'off' ? 'everywhere' : p;
}

// ---------------------------------------------------------------------------------------------------------------
// The backup target
// ---------------------------------------------------------------------------------------------------------------

/** What a backup setting means on this run: whether this machine is the backup (it then pulls every machine's
 *  content), and the node that serves the backup's copies to this machine, when one was reached. A backup that is no
 *  machine (a folder, sync-folder.ts) brings `nodes`, its copy of each machine it holds (SyncNode.passive), which a run
 *  pulls from as from that machine, and `push`, which writes this machine's own files to it once the run has pulled. */
export interface SyncBackupRole {
  kind: SyncBackupSetting['kind'];
  label: string;
  self: boolean;
  node: SyncNode | null;
  nodes?: SyncNode[];
  push?(run: SyncBackupPush): Promise<SyncBackupPushResult>;
  /** Why it could not be read, or used, this run: said loudly, as the backup's line in the run. */
  error?: string;
  /** When `error` is a backup folder's record under this machine's name that this machine may not use: `unclaimed`
   *  (never written here: a reinstall, or another machine of this name) or `other` (another machine writes it).
   *  `oak sync setup --restore` takes it over. */
  record?: 'unclaimed' | 'other';
  /** What of it could not be read, though the rest could (another machine's record there): errors of the backup's line. */
  errors?: string[];
  warnings?: string[];
}

export interface SyncBackupContext {
  nodes: SyncNode[];
  local: SyncInventory;
  /** A plan: the backup is read and nothing is written, here or there. */
  readOnly?: boolean;
}

/** What a push is given: this machine's inventory as the push starts (with what the run put back, and the deletes and
 *  evictions it learned), its placements, and the run's time. */
export interface SyncBackupPush {
  me: SyncInventory;
  placements: Record<string, SyncPlacement>;
  now: number;
}

export interface SyncBackupPushResult {
  pushed: { files: number; bytes: number };
  pending: { files: number; bytes: number };
  errors: string[];
  warnings: string[];
}

type BackupResolver = (setting: SyncBackupSetting, ctx: SyncBackupContext) => SyncBackupRole | null;
const BACKUP_KINDS = new Map<string, BackupResolver>();

/** Add a kind of backup target. The pull logic sees only the role a kind resolves to: whether this machine is the
 *  backup, and a node (an inventory and a way to fetch from it) to restore from. A folder target adds itself here. */
export function registerSyncBackupKind(kind: string, resolve: BackupResolver): void {
  BACKUP_KINDS.set(kind, resolve);
}

registerSyncBackupKind('machine', (setting, ctx) => {
  if (setting.kind !== 'machine') return null;
  const named = ctx.nodes.find((n) => !n.local && n.label === setting.label);
  const self = (require('./sync') as typeof import('./sync')).namesThisMachine(setting.label) || named?.inventory?.host === ctx.local.host;
  return { kind: 'machine', label: setting.label, self, node: !self && named?.status === 'ok' ? named : null };
});

export function resolveSyncBackup(setting: SyncBackupSetting | null, ctx: SyncBackupContext): SyncBackupRole | null {
  return setting ? BACKUP_KINDS.get(setting.kind)?.(setting, ctx) ?? null : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The transport: herdr's machines, and a peer's two read-only commands
// ---------------------------------------------------------------------------------------------------------------

/** What the engine needs from the CLI: herdr's saved machines (null with no herdr here), and a saved machine's
 *  `__sync-inventory` and `__sync-fetch` over OAK's ssh. Tests and a folder target supply their own. */
export interface SyncTransport {
  machines(): Promise<HerdrMachine[] | null>;
  inventory(target: string, user: string): Promise<{ text: string } | SyncAskFailure>;
  fetch(target: string, user: string, request: string): SyncChannel;
}

/**
 * This machine and every enabled saved machine (only those `machines` names, when given; never one prefs.json
 * excludes), each with its inventory or why it has none. Machines saved under one ssh target are asked once, in
 * parallel; one whose inventory comes from this machine, or from a machine already asked under another label, is a
 * duplicate. Throws, for the caller to say, when herdr's list cannot be read or names no such machine.
 */
export async function collectSyncNodes(transport: SyncTransport, opts: { machines?: string[]; exclude?: string[]; user: string }): Promise<SyncNode[]> {
  const local = syncInventory({ user: opts.user });
  if (!('families' in local)) throw new Error('this machine refused its own inventory');
  const nodes: SyncNode[] = [{ label: localSyncLabel(), local: true, status: 'ok', inventory: local }];
  const wanted = opts.machines ?? [];
  const machines = await transport.machines();
  if (!machines) {
    if (wanted.length) throw new Error('herdr is not installed on this machine — run `oak doctor --fix` first');
    return nodes;
  }
  for (const w of wanted) if (!machines.some((m) => m.label === w || m.id === w)) throw new Error(`no saved machine "${w}" — see \`oak machine list\``);
  const chosen = wanted.length ? machines.filter((m) => wanted.includes(m.label) || wanted.includes(m.id)) : machines;
  const seenTargets = new Set<string>();
  const asks: Promise<SyncNode>[] = [];
  for (const m of chosen) {
    const label = plainLabel(m.label) || plainLabel(m.target);
    if (opts.exclude?.includes(m.label) && !wanted.length) {
      asks.push(Promise.resolve({ label, local: false, status: 'excluded' as const, detail: 'excluded from sync here (`oak sync include` brings it back)' }));
      continue;
    }
    if (!m.enabled) {
      asks.push(Promise.resolve({ label, local: false, status: 'disabled' as const, detail: 'disabled in herdr, so it was not asked' }));
      continue;
    }
    if (!m.target || m.target.startsWith('-')) {
      asks.push(Promise.resolve({ label, local: false, status: 'failed' as const, detail: 'its ssh target is not one OAK runs' }));
      continue;
    }
    if (seenTargets.has(m.target)) {
      asks.push(Promise.resolve({ label, local: false, status: 'duplicate' as const, detail: 'saved under the same ssh target as another machine, which was asked once' }));
      continue;
    }
    seenTargets.add(m.target);
    const target = m.target;
    asks.push(transport.inventory(target, opts.user).then((a): SyncNode => {
      if (!('text' in a)) return { label, local: false, status: a.status, ...(a.detail ? { detail: a.detail } : {}) };
      const parsed = parseSyncInventory(a.text);
      if (!parsed) return { label, local: false, status: 'not-inventory', detail: 'its answer was not an inventory: something there printed to standard output before OAK did, such as a shell startup file' };
      if (!('families' in parsed.inventory)) return { label, local: false, status: 'shared', detail: 'it runs under another user\'s account, so it listed nothing' };
      return { label, local: false, status: 'ok', inventory: parsed.inventory, dropped: parsed.dropped, target, channel: (req) => transport.fetch(target, opts.user, req) };
    }));
  }
  const answered = await Promise.all(asks);
  const hosts = new Map<string, string>([[local.host, 'this machine']]);
  for (const n of answered) {
    if (n.status === 'ok' && n.inventory) {
      const same = hosts.get(n.inventory.host);
      if (same) {
        // Its inventory stays with it: a backup label that names this machine is known by its host.
        nodes.push({ label: n.label, local: false, status: 'duplicate', detail: same === 'this machine' ? 'this is the machine running sync' : `the same machine as ${same}`, inventory: n.inventory });
        continue;
      }
      hosts.set(n.inventory.host, n.label);
    }
    nodes.push(n);
  }
  return nodes;
}

// ---------------------------------------------------------------------------------------------------------------
// The fetch command (a peer's side): only reads
// ---------------------------------------------------------------------------------------------------------------

/** One file a fetch asks for: by its family and name on the machine asked. For an append-only file, `offset` is the
 *  size the asking machine holds and `sha256` the hash of those bytes. */
export interface SyncFetchItem {
  family: string;
  name: string;
  offset?: number;
  sha256?: string | null;
}

/** The header before each answer's bytes. `tail`: the asker's bytes are this file's first `offset` bytes, and the
 *  `length` bytes after them follow. `whole`: the whole file follows, `sha256` its hash (a text or content-addressed
 *  file, or an append-only one the asker lacks). `diverged`: the asker's bytes are not this file's first ones, and
 *  the whole file follows. `shorter`: this file holds fewer bytes than the asker's. `missing`, `refused`: nothing. */
export interface SyncFrameHeader {
  i: number;
  status: 'tail' | 'whole' | 'diverged' | 'shorter' | 'missing' | 'refused';
  size?: number;
  mtime?: number;
  offset?: number;
  length?: number;
  sha256?: string | null;
}

const CHUNK = 1024 * 1024;

/** A file a fetch answers from: its size and time when it was opened, and its bytes from a position. A machine's own
 *  file, or a backup's copy of one (sync-folder.ts). */
export interface SyncFetchSource {
  size: number;
  mtime: number;
  read(buf: Buffer, off: number, len: number, pos: number): number;
  close(): void;
}

/**
 * The frames that answer `items`, each a header line (SyncFrameHeader) and its bytes, from the sources `open` gives
 * (or why there is none). The hash of a prefix and the bytes after it are read from one source, so a file renamed over
 * meanwhile answers whole from either version. `skip`, when given, decides whether an error before an answer's header
 * was sent (opening the source, or reading a file read whole, below SYNC_HASH_MAX_BYTES) refuses that item alone;
 * otherwise, and once bytes have been sent, the error ends the answer.
 */
export async function* syncFetchFrames(items: SyncFetchItem[], open: (fam: SyncFamily, name: string) => SyncFetchSource | 'missing' | 'refused',
  skip?: (i: number, error: unknown) => boolean): AsyncGenerator<Buffer> {
  const header = (h: SyncFrameHeader): Buffer => Buffer.from(JSON.stringify(h) + '\n');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const fam = it && typeof it.family === 'string' ? syncFamily(it.family) : undefined;
    if (!fam || typeof it.name !== 'string' || !fam.accepts(it.name)) {
      yield header({ i, status: 'refused' });
      continue;
    }
    let src: SyncFetchSource | 'missing' | 'refused';
    try {
      src = open(fam, it.name);
    } catch (e) {
      if (!skip?.(i, e)) throw e;
      src = 'refused';
    }
    if (src === 'missing' || src === 'refused') {
      yield header({ i, status: src });
      continue;
    }
    try {
      const size = src.size;
      const mtime = src.mtime;
      const send = async function* (from: number): AsyncGenerator<Buffer> {
        const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, size - from)));
        for (let pos = from; pos < size;) {
          const n = src.read(buf, 0, Math.min(buf.length, size - pos), pos);
          if (n === 0) throw new Error('the file shrank while it was sent');
          yield Buffer.from(buf.subarray(0, n));
          pos += n;
        }
      };
      const offset = fam.strategy === 'append' && Number.isInteger(it.offset) && (it.offset as number) > 0 ? (it.offset as number) : 0;
      if (offset > 0) {
        if (size < offset) {
          yield header({ i, status: 'shorter', size, mtime });
          continue;
        }
        const h = createHash('sha256');
        const buf = Buffer.alloc(CHUNK);
        for (let pos = 0; pos < offset;) {
          const n = src.read(buf, 0, Math.min(buf.length, offset - pos), pos);
          if (n === 0) break;
          h.update(buf.subarray(0, n));
          pos += n;
        }
        if (h.digest('hex') === it.sha256) {
          yield header({ i, status: 'tail', size, mtime, offset, length: size - offset });
          yield* send(offset);
        } else {
          yield header({ i, status: 'diverged', size, mtime, offset: 0, length: size });
          yield* send(0);
        }
        continue;
      }
      if (fam.strategy === 'append' || size > SYNC_HASH_MAX_BYTES) {
        // An append-only file, and any too large to hold at once (a content-addressed blob), streams; the asker hashes
        // what arrives.
        yield header({ i, status: 'whole', size, mtime, offset: 0, length: size });
        yield* send(0);
        continue;
      }
      // A small file: read once, hashed, sent.
      const body = Buffer.alloc(size);
      try {
        for (let pos = 0; pos < size;) {
          const n = src.read(body, pos, size - pos, pos);
          if (n === 0) throw new Error('the file shrank while it was sent');
          pos += n;
        }
      } catch (e) {
        if (!skip?.(i, e)) throw e;
        yield header({ i, status: 'refused' });
        continue;
      }
      yield header({ i, status: 'whole', size, mtime, offset: 0, length: size, sha256: state.sha256(body) });
      yield body;
    } finally {
      src.close();
    }
  }
}

/**
 * `oak __sync-fetch --user <name>`: stream the files `request` names (`{ fetch: 1, items: SyncFetchItem[] }`), each
 * as a header line (SyncFrameHeader) and its bytes (syncFetchFrames). The user is compared before anything is read, as
 * the inventory does: another account gets `{"shared":true}` and nothing else. A name its family does not accept, or a
 * real path sync never reads (neverRead), is refused.
 */
export async function serveSyncFetch(requestText: string, user: string, write: (b: Buffer) => Promise<void>): Promise<void> {
  const me = localUserName();
  if (!me || !user || me !== user) {
    await write(Buffer.from('{"shared":true}\n'));
    return;
  }
  let request: { fetch?: unknown; items?: unknown };
  try {
    request = JSON.parse(requestText);
  } catch {
    request = {};
  }
  const items = request.fetch === SYNC_FETCH_VERSION && Array.isArray(request.items) ? (request.items as SyncFetchItem[]) : [];
  const refuse = neverRead();
  const { isDemoSession } = require('./demo') as typeof import('./demo');
  const open = (fam: SyncFamily, name: string): SyncFetchSource | 'missing' | 'refused' => {
    // The simulator's sessions are never listed, so never sent either, whoever asks (syncInventory).
    if (isDemoSession(sessionOf(fam.id, name) ?? '')) return 'missing';
    const root = fam.root();
    const abs = path.join(root, ...name.split('/'));
    let fd: number;
    let st: fs.Stats;
    try {
      const real = fs.realpathSync.native(abs);
      let rootReal = root;
      try {
        rootReal = fs.realpathSync.native(root);
      } catch {
        /* the family's folder is gone: the file is too */
      }
      if (refuse(real, rootReal)) return 'refused';
      fd = fs.openSync(abs, 'r');
      st = fs.fstatSync(fd);
      if (!st.isFile()) {
        fs.closeSync(fd);
        return 'refused';
      }
    } catch {
      return 'missing';
    }
    return { size: st.size, mtime: Math.floor(st.mtimeMs), read: (buf, off, len, pos) => fs.readSync(fd, buf, off, len, pos), close: () => fs.closeSync(fd) };
  };
  for await (const b of syncFetchFrames(items, open)) await write(b);
}

/** Reads a fetch's answer: its header lines and the bytes after each, handed on as they arrive. */
export class SyncFrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private header: SyncFrameHeader | null = null;
  private left = 0;
  /** `{"shared":true}`: the machine runs under another account. */
  shared = false;
  constructor(private readonly on: { header(h: SyncFrameHeader): void; body(i: number, chunk: Buffer): void; end(i: number): void }) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.header) {
        if (!this.left) {
          const i = this.header.i;
          this.header = null;
          this.on.end(i);
          continue;
        }
        if (!this.buf.length) return;
        const take = Math.min(this.left, this.buf.length);
        this.on.body(this.header.i, this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        this.left -= take;
        continue;
      }
      const nl = this.buf.indexOf(10);
      if (nl < 0) {
        if (this.buf.length > 64 * 1024) throw new Error('a fetch header longer than 64 KB');
        return;
      }
      const line = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 1);
      const h = JSON.parse(line);
      if (h && h.shared === true) {
        this.shared = true;
        continue;
      }
      if (!h || typeof h.i !== 'number' || typeof h.status !== 'string') throw new Error('not a fetch answer');
      this.header = h as SyncFrameHeader;
      this.left = typeof h.length === 'number' && h.length > 0 ? h.length : 0;
      this.on.header(this.header);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Carrying out a plan
// ---------------------------------------------------------------------------------------------------------------

/** The local path of a family's file. */
export const familyPath = (fam: SyncFamily, name: string): string => path.join(fam.root(), ...name.split('/'));

/** sha256 of a whole file, read in chunks. */
function hashFile(file: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** Bytes that are not text: a NUL in the first 8 KB, the test capture uses. */
const binary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);

/** One write sync made or declined, as `oak sync now --json` and `oak sync fetch --json` report it. */
export interface SyncDone {
  family: string;
  from: string;
  name: string;
  to: string;
  /** `create`: a file this machine lacked; `append`: a longer copy's tail; `copy`, `merge`, `replace` (a fast-forward
   *  to another machine's newer text); `conflict`: kept as a conflict copy; `skipped`: changed here while it was
   *  fetched, or nothing complete to add, and left for the next run. */
  action: 'create' | 'append' | 'copy' | 'merge' | 'replace' | 'conflict' | 'skipped';
  bytes: number;
  detail?: string;
}

/** Per machine, what a run did. */
export interface SyncMachineRun {
  label: string;
  host?: string;
  status: SyncMachineStatus | 'busy';
  detail?: string;
  pulled: { files: number; bytes: number };
  conflicts: number;
  pending: { files: number; bytes: number };
  errors: string[];
  /** For a backup that is no machine: what this machine wrote to it. */
  pushed?: { files: number; bytes: number };
  /** For a backup folder that refused its record under this machine's name (SyncBackupRole.record). */
  record?: 'unclaimed' | 'other';
}

/** What `oak sync now --json` prints (schema `syncNow: 1`). */
export interface SyncNowResult {
  syncNow: 1;
  at: number;
  durationMs: number;
  /** `ok`, everything planned was pulled; `partial`, something was not (see `machines[].errors` and `pending`);
   *  `busy`, another run holds this machine's lock; `not-due`, a background run found the last one too recent;
   *  `off`, the background run is turned off. */
  status: 'ok' | 'partial' | 'busy' | 'not-due' | 'off';
  backup: { kind: string; label: string; self: boolean } | null;
  machines: SyncMachineRun[];
  done: SyncDone[];
  tombstones: { recorded: number; applied: number };
  warnings: string[];
}

/**
 * A run that pulled nothing because every machine it asked failed: none could be reached or read, or each that
 * answered had errors. `oak sync now` exits 1 then. A run with nothing due, nothing to pull, or no machine to ask
 * (each disabled, excluded, the same as another, or another account's) is no failure, nor one that pulled anything.
 */
export function syncNowFailed(r: SyncNowResult): boolean {
  if (r.status !== 'partial' || r.done.some((d) => d.action !== 'conflict' && d.action !== 'skipped')) return false;
  const asked = r.machines.filter((m) => !['disabled', 'excluded', 'duplicate', 'shared'].includes(m.status));
  return asked.length > 0 && asked.every((m) => m.status !== 'ok' || m.errors.length > 0);
}

/** A file's tombstone key: its family and name, a project-scoped one by its project's identity key, so the machines
 *  that hold it in folders of other names match it. */
function fileTombKey(fam: SyncFamily, name: string, inv: SyncInventory): string {
  if (!fam.projectScoped) return `${fam.id}:${name}`;
  const folder = name.slice(0, name.indexOf('/'));
  const proj = inv.projects.find((p) => p.folder === folder);
  const key = proj?.cwd ? inv.identities[proj.cwd]?.key : proj?.key;
  return `${fam.id}:${key ?? `folder:${folder}`}:${name.slice(folder.length + 1)}`;
}

/** Whether `h` is a version a deleted file had where it was deleted: the last one, or one before it. */
const deletedVersion = (t: state.SyncTombstone, h: string): boolean => t.sha256 === h || !!t.history?.includes(h);

/** The name a file tombstone key has here, or null when it names nothing this machine can place. */
function tombName(key: string, inv: SyncInventory): { fam: SyncFamily; name: string } | null {
  const famId = key.slice(0, key.indexOf(':'));
  const fam = syncFamily(famId);
  if (!fam) return null;
  const rest = key.slice(famId.length + 1);
  if (!fam.projectScoped) return fam.accepts(rest) ? { fam, name: rest } : null;
  const sep = rest.lastIndexOf(':');
  const id = rest.slice(0, sep);
  const tail = rest.slice(sep + 1);
  const folders = id.startsWith('folder:') ? [id.slice('folder:'.length)]
    : inv.projects.filter((p) => (p.cwd ? inv.identities[p.cwd]?.key : p.key) === id).map((p) => p.folder);
  if (folders.length !== 1) return null;
  const name = `${folders[0]}/${tail}`;
  return fam.accepts(name) ? { fam, name } : null;
}

/** What one run keeps between its steps. */
interface RunContext {
  me: SyncInventory;
  manifest: state.SyncManifest;
  conflicts: state.SyncConflict[];
  tombs: Map<string, state.SyncTombstone>;
  done: SyncDone[];
  warnings: string[];
  now: number;
  /** What sync never reads or writes here (neverRead), resolved once per run. */
  refuse: ReturnType<typeof neverRead>;
  /** The diverged copies a person dismissed (sync-state.ts SyncDismissal). */
  dismissed: state.SyncDismissal[];
}

/** A family's file here, reached only as the inventory would reach it (syncLocalPath); throws where it is not, for the
 *  item's error. */
function localPath(ctx: RunContext, fam: SyncFamily, name: string): string {
  const p = syncLocalPath(fam, name, ctx.refuse);
  if (!p) throw new Error('it is reached here through a link sync does not follow, so it is neither read nor written');
  return p;
}

/** Give a file the times `ms` (epoch ms) as `Math.floor(stat.mtimeMs)` reads them back, which is how an inventory
 *  compares them. Half a millisecond past: Node 22 truncates the fraction of the seconds `utimesSync` is given, so a
 *  whole millisecond read back one short about half the time (Node 24 does not). */
function setTimes(file: string, ms: number): void {
  const t = (ms + 0.5) / 1000;
  fs.utimesSync(file, t, t);
}

/** Write a file assembled at `tmp` over `target` once `target` still is what the request was made against (`expect`;
 *  null for a file that was not there). Returns what landed, as it was before the rename: a write that follows it at
 *  once is not taken for part of it. `before`, when given, is told what lands just before it does. */
function landFile(tmp: string, target: string, expect: { size: number; mtime: number } | null, mtime: number | null, mode: number,
  before?: (landed: fs.Stats) => void): fs.Stats | 'changed' {
  let now: fs.Stats | null = null;
  try {
    now = fs.statSync(target);
  } catch {
    now = null;
  }
  const same = expect ? now !== null && now.size === expect.size && Math.floor(now.mtimeMs) === expect.mtime : now === null;
  if (!same) {
    fs.rmSync(tmp, { force: true });
    return 'changed';
  }
  fs.chmodSync(tmp, mode);
  if (mtime !== null) setTimes(tmp, mtime);
  const landed = fs.statSync(tmp);
  before?.(landed);
  fs.renameSync(tmp, target);
  return landed;
}

/** Whether the file at `a` is, byte for byte, the start of the file at `b`. */
function startOf(a: string, b: string): boolean {
  let fa: number | null = null;
  let fb: number | null = null;
  try {
    fa = fs.openSync(a, 'r');
    fb = fs.openSync(b, 'r');
    const size = fs.fstatSync(fa).size;
    if (size > fs.fstatSync(fb).size) return false;
    const x = Buffer.alloc(Math.min(CHUNK, Math.max(1, size)));
    const y = Buffer.alloc(x.length);
    for (let pos = 0; pos < size;) {
      const n = Math.min(x.length, size - pos);
      if (fs.readSync(fa, x, 0, n, pos) !== n || fs.readSync(fb, y, 0, n, pos) !== n || !x.subarray(0, n).equals(y.subarray(0, n))) return false;
      pos += n;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fa !== null) fs.closeSync(fa);
    if (fb !== null) fs.closeSync(fb);
  }
}

/** A temporary file beside `target`, named so a later run knows it as sync's (state.tempName: short, so a target
 *  whose name nears the file system's limit still has one). Its folder is made only now: a run with nothing to write
 *  makes none. */
function tempBeside(target: string): { fd: number; tmp: string } {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(target), state.tempName());
  state.noteInflight(tmp);
  return { fd: fs.openSync(tmp, 'w', 0o600), tmp };
}

/**
 * Raise a conflict: keep the other machine's copy (`body`, or the file at `from`) under `sync/conflicts/`, once per
 * version of it, and record it for `oak sync status` and the inbox.
 */
function raiseConflict(ctx: RunContext, fam: SyncFamily, to: string, peer: SyncNode, copy: { body?: Buffer; file?: string; sha256: string | null; size: number },
  localSha256: string | null, reason: state.SyncConflict['reason']): void {
  const host = peer.inventory!.host;
  const was = ctx.conflicts.find((c) => c.family === fam.id && c.name === to && c.host === host);
  if (was && was.peerSha256 === copy.sha256 && was.peerSize === copy.size && fs.existsSync(was.copy)) {
    if (copy.file) fs.rmSync(copy.file, { force: true });
    return;
  }
  const dest = state.conflictCopyPath(peer.label, fam.id, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (copy.file) fs.renameSync(copy.file, dest);
  else state.writeAtomic(dest, copy.body ?? Buffer.alloc(0));
  const conflict: state.SyncConflict = {
    id: state.sha256(`${fam.id}\0${to}\0${host}`).slice(0, 12), family: fam.id, name: to, from: peer.label, host, at: ctx.now,
    peerSha256: copy.sha256, peerSize: copy.size, copy: dest, localSha256, reason,
  };
  ctx.conflicts = [...ctx.conflicts.filter((c) => c.id !== conflict.id), conflict];
  state.audit({ op: 'conflict', family: fam.id, name: to, from: peer.label, bytes: copy.size, sha256: copy.sha256, detail: reason });
  ctx.done.push({ family: fam.id, from: peer.label, name: to, to: path.relative(state.syncDir(), dest), action: 'conflict', bytes: copy.size, detail: reason });
}

/** A text file's history here, with its present hash last. */
function historyWith(rec: state.SyncManifestEntry | undefined, ...hashes: string[]): string[] {
  const out = [...(rec?.history ?? [])];
  for (const h of hashes) if (out[out.length - 1] !== h) out.push(h);
  return out.slice(-state.SYNC_HISTORY_MAX);
}

/** Record a file sync wrote, as `st` (what landed) says it is, in the run's manifest and at once on disk: a run that is
 *  killed before it writes the manifest whole still knows where each file it landed came from. */
function recordWrite(ctx: RunContext, fam: SyncFamily, to: string, sha: string | null, fields: Partial<state.SyncManifestEntry>, st: fs.Stats): void {
  const key = state.manifestKey(fam.id, to);
  const was = ctx.manifest.get(key);
  const entry: state.SyncManifestEntry = { ...was, ...fields, family: fam.id, name: to, size: st.size, mtime: Math.floor(st.mtimeMs), sha256: sha };
  ctx.manifest.set(key, entry);
  state.appendManifest(entry);
}

/** A copy's record once it changed here: this machine's own, for good, and no longer an on-demand copy to evict. */
function changedHere(e: state.SyncManifestEntry): state.SyncManifestEntry {
  const { cached: _c, ...own } = e;
  void _c;
  return { ...own, changed: true };
}

/**
 * Merge another machine's text `R` into this machine's copy of `to`: copy it where there is none (unless this
 * machine deleted that very version), take it where this machine's is one it already had (a fast-forward), keep this
 * machine's where it already had theirs, and otherwise merge the two three ways against the newest version both
 * histories share. With no such version, text that is not text, or lines both changed, the other copy is kept as a
 * conflict copy and this machine's file is left as it is. Never the newer one wins.
 *
 * A version can come back (an edit undone, on either machine), so a hash seen twice in one history names two moments,
 * and says nothing of which came first: such evidence is not taken, and where none other decides, the other copy is
 * kept as a conflict copy rather than one machine's change being dropped unseen.
 */
function applyText(ctx: RunContext, fam: SyncFamily, item: SyncPlanItem, peer: SyncNode, R: Buffer, peerHistory: string[]): void {
  const target = localPath(ctx, fam, item.to);
  const key = state.manifestKey(fam.id, item.to);
  const rec = ctx.manifest.get(key);
  const hR = state.putObject(R);
  // The file as it is read: the result lands only over that, so a change made here meanwhile is never overwritten.
  let L: Buffer | null = null;
  let seen: fs.Stats | null = null;
  try {
    const fd = fs.openSync(target, 'r');
    try {
      seen = fs.fstatSync(fd);
      if (seen.isFile()) L = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    L = null;
    seen = null;
  }
  if (seen && !L) throw new Error('something that is not a file has its name here');
  const write = (data: Buffer, action: SyncDone['action'], hist: string[]): void => {
    const { fd, tmp } = tempBeside(target);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const trash = L ? state.toTrash(fam.id, item.to, target, ctx.now) : null;
    const landed = landFile(tmp, target, seen ? { size: seen.size, mtime: Math.floor(seen.mtimeMs) } : null, null, seen ? seen.mode & 0o777 : 0o600);
    if (landed === 'changed') {
      ctx.done.push({ family: fam.id, from: peer.label, name: item.name, to: item.to, action: 'skipped', bytes: 0, detail: 'it changed here while it was merged; the next run takes it from there' });
      return;
    }
    const h = state.sha256(data);
    recordWrite(ctx, fam, item.to, h, { history: hist, ...(item.key ? { key: item.key } : {}) }, landed);
    state.audit({ op: action === 'copy' ? 'copy' : action === 'merge' ? 'merge' : 'replace', family: fam.id, name: item.to, from: peer.label, bytes: data.length, sha256: h, ...(trash ? { trash } : {}) });
    ctx.done.push({ family: fam.id, from: peer.label, name: item.name, to: item.to, action, bytes: data.length });
  };
  if (!L || !seen) {
    const t = ctx.tombs.get(`file\0${fileTombKey(fam, item.to, ctx.me)}`);
    if (t?.deleted && deletedVersion(t, hR)) return; // deleted here, and this is a version it had then
    write(R, 'copy', historyWith(rec, hR));
    return;
  }
  const hL = state.sha256(L);
  const mine = historyWith(rec, hL);
  if (hL === hR) {
    if (rec?.history?.[rec.history.length - 1] !== hL) recordWrite(ctx, fam, item.to, hL, { history: mine }, seen);
    return;
  }
  const theirs = peerHistory[peerHistory.length - 1] === hR ? peerHistory : [...peerHistory, hR];
  const twice = (h: string, list: string[]): boolean => list.indexOf(h) !== list.lastIndexOf(h);
  const rBefore = mine.slice(0, -1).includes(hR);
  const lBefore = theirs.slice(0, -1).includes(hL);
  // Theirs is a version this machine had before its own; this machine's, one they had before theirs.
  const rOlder = rBefore && !twice(hR, theirs);
  const lOlder = lBefore && !twice(hL, mine);
  if (rOlder && !lOlder) return;
  state.putObject(L);
  if (lOlder && !rOlder) {
    write(R, 'replace', [...mine, hR]);
    return;
  }
  // No version either had before the other's: merge against the newest both had, unless it too came back.
  let base: string | null = null;
  if (!rBefore && !lBefore) {
    const common = new Set(theirs);
    for (let k = mine.length - 1; k >= 0 && !base; k--) if (common.has(mine[k])) base = mine[k];
    if (base && (twice(base, mine) || twice(base, theirs))) base = null;
  }
  const baseBuf = base ? state.readObject(base) : null;
  if (baseBuf && !binary(L) && !binary(R) && !binary(baseBuf)) {
    // Merged line by line as bytes (latin1 maps each byte to one character and back): a file in another encoding than
    // UTF-8 comes out byte for byte, where decoding it as UTF-8 would replace what it cannot read.
    const merged = threeWayMerge(baseBuf.toString('latin1'), L.toString('latin1'), R.toString('latin1'));
    if (merged !== null) {
      const M = Buffer.from(merged, 'latin1');
      state.putObject(M);
      write(M, 'merge', [...mine, hR, state.sha256(M)]);
      return;
    }
  }
  raiseConflict(ctx, fam, item.to, peer, { body: R, sha256: hR, size: R.length }, hL, !base ? 'no-base' : !baseBuf || binary(L) || binary(R) ? 'binary' : 'overlap');
}

/** Where one append-only answer is being written, while its bytes arrive. */
interface AppendSink {
  item: SyncPlanItem;
  fam: SyncFamily;
  header: SyncFrameHeader;
  /** The file here it lands on (syncLocalPath). */
  target: string;
  fd: number;
  tmp: string;
  /** The hash of what is written, and its state at the last complete line. */
  hash: ReturnType<typeof createHash>;
  atLine: ReturnType<typeof createHash> | null;
  /** Bytes written, and where the last complete line ends. */
  written: number;
  lineEnd: number;
  /** The bytes that were here before (a `tail`), and the stat the request was made against. */
  kept: number;
  expect: { size: number; mtime: number } | null;
  /** Cut at the last complete line (JSONL), or kept whole (a tool's output file). */
  cut: boolean;
  diverged: boolean;
}

function sinkWrite(s: AppendSink, chunk: Buffer): void {
  fs.writeSync(s.fd, chunk);
  if (s.cut) {
    const nl = chunk.lastIndexOf(10);
    if (nl >= 0) {
      s.hash.update(chunk.subarray(0, nl + 1));
      s.atLine = s.hash.copy();
      s.hash.update(chunk.subarray(nl + 1));
      s.lineEnd = s.written + nl + 1;
    } else s.hash.update(chunk);
  } else s.hash.update(chunk);
  s.written += chunk.length;
}

/** Open a sink for an append-only answer: the conflict folder for a diverged copy, else beside the target, with this
 *  machine's bytes copied in first for a tail. */
function openAppendSink(ctx: RunContext, item: SyncPlanItem, fam: SyncFamily, header: SyncFrameHeader, expect: { size: number; mtime: number } | null, target: string): AppendSink {
  const diverged = header.status === 'diverged';
  let fd: number, tmp: string;
  if (diverged) {
    tmp = path.join(state.syncDir(), 'conflicts', state.tempName());
    fs.mkdirSync(path.dirname(tmp), { recursive: true, mode: 0o700 });
    state.noteInflight(tmp);
    fd = fs.openSync(tmp, 'w', 0o600);
  } else ({ fd, tmp } = tempBeside(target));
  const s: AppendSink = { item, fam, header, target, fd, tmp, hash: createHash('sha256'), atLine: null, written: 0, lineEnd: 0, kept: 0, expect, cut: !diverged && item.to.endsWith('.jsonl'), diverged };
  if (header.status === 'tail') {
    // This machine's bytes first, hashed as they are copied; the tail is cut after them.
    const src = fs.openSync(target, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      for (let n; (n = fs.readSync(src, buf, 0, buf.length, null)) > 0;) {
        fs.writeSync(fd, buf.subarray(0, n));
        s.hash.update(buf.subarray(0, n));
        s.kept += n;
      }
    } finally {
      fs.closeSync(src);
    }
    s.written = s.kept;
    s.lineEnd = s.kept;
    s.atLine = s.hash.copy();
  }
  return s;
}

/** Finish an append-only answer: land it (cut at its last complete line), keep it as a conflict copy, or drop it. */
function closeAppendSink(ctx: RunContext, s: AppendSink, peer: SyncNode, complete: boolean, run: SyncMachineRun): void {
  fs.fsyncSync(s.fd);
  fs.closeSync(s.fd);
  const target = s.target;
  if (!complete) {
    fs.rmSync(s.tmp, { force: true });
    return;
  }
  if (s.fam.strategy === 'cas' || s.fam.strategy === 'mirror') {
    const sha = s.hash.digest('hex');
    if ((s.fam.strategy === 'cas' && path.basename(s.item.to) !== sha) || (s.header.sha256 && s.header.sha256 !== sha)) {
      fs.rmSync(s.tmp, { force: true });
      run.errors.push(`${s.item.name}: its bytes do not hash to ${s.fam.strategy === 'cas' ? 'its name' : 'their hash'}`);
      return;
    }
    if (s.fam.strategy === 'cas' && fs.existsSync(target)) {
      fs.rmSync(s.tmp, { force: true }); // a blob is its name: never replaced
      return;
    }
    // A mirrored file is replaced whole, the copy it replaces to the trash first, its machine's time kept: what says
    // next time whether it changed. Only over what was here when it was asked for: one written here since is left.
    if (s.fam.strategy === 'mirror') {
      let now: fs.Stats | null = null;
      try {
        now = fs.statSync(target);
      } catch {
        now = null;
      }
      const same = s.expect ? now !== null && now.size === s.expect.size && Math.floor(now.mtimeMs) === s.expect.mtime : now === null;
      if (!same) {
        fs.rmSync(s.tmp, { force: true });
        ctx.done.push({ family: s.fam.id, from: peer.label, name: s.item.name, to: s.item.to, action: 'skipped', bytes: 0, detail: 'it changed here while it was fetched' });
        return;
      }
    }
    // The copy it replaces goes to the trash, unless all of it is the start of the new one (a log that only grew): that
    // copy holds nothing the new one lacks, and kept each run, it filled the trash with a whole copy of every growing log.
    const replaced = s.fam.strategy === 'mirror' && fs.existsSync(target);
    const trash = replaced && !startOf(target, s.tmp) ? state.toTrash(s.fam.id, s.item.to, target, ctx.now) : null;
    if (typeof s.header.mtime === 'number' && s.fam.strategy === 'mirror') setTimes(s.tmp, s.header.mtime);
    fs.chmodSync(s.tmp, 0o600);
    const landed = fs.statSync(s.tmp);
    // A copy of this machine's own file (a restore) is its own again, as an append-only file it creates is. Where it came
    // from is what an on-demand copy is evicted by (evictCache). Recorded before it lands: a run stopped between the two
    // left a file sync put here that it did not know as its own, and a restore never goes on in a session that holds
    // one (sync-store.ts restoringSession).
    const origin = s.item.origin ?? peer.inventory!.host;
    const was = ctx.manifest.get(state.manifestKey(s.fam.id, s.item.to));
    recordWrite(ctx, s.fam, s.item.to, sha, { ...(origin !== ctx.me.host ? { origin, originLabel: peer.label, ...(s.item.originName ? { originName: s.item.originName } : {}) } : {}),
      ...(s.item.stamp ? { stamp: s.item.stamp } : {}), ...(was?.cached ? { usedAt: ctx.now } : {}), source: { host: peer.inventory!.host, name: s.item.name } }, landed);
    fs.renameSync(s.tmp, target);
    const action = replaced ? 'replace' : 'create';
    state.audit({ op: action, family: s.fam.id, name: s.item.to, from: peer.label, bytes: s.written, sha256: sha, ...(trash ? { trash } : {}) });
    ctx.done.push({ family: s.fam.id, from: peer.label, name: s.item.name, to: s.item.to, action, bytes: s.written });
    return;
  }
  if (s.diverged) {
    raiseConflict(ctx, s.fam, s.item.to, peer, { file: s.tmp, sha256: s.hash.digest('hex'), size: s.written }, s.expect ? ctx.manifest.get(state.manifestKey(s.fam.id, s.item.to))?.sha256 ?? null : null, 'diverged');
    return;
  }
  const end = s.cut ? s.lineEnd : s.written;
  if (end <= s.kept) {
    fs.rmSync(s.tmp, { force: true });
    if (s.written > s.kept) ctx.done.push({ family: s.fam.id, from: peer.label, name: s.item.name, to: s.item.to, action: 'skipped', bytes: 0, detail: 'no complete line yet' });
    return;
  }
  if (end < s.written) fs.truncateSync(s.tmp, end);
  const sha = (s.cut ? s.atLine ?? s.hash : s.hash).digest('hex');
  let mode = 0o600;
  if (s.expect) {
    try {
      mode = fs.statSync(target).mode & 0o777;
    } catch {
      /* gone: landFile says so */
    }
  }
  // The other machine's time when this copy is now all of its file; otherwise the time it is written.
  const whole = end === s.header.size;
  // A file this machine creates comes from the machine that made it; one it extends keeps the origin it had (none,
  // for its own session continued elsewhere). Recorded just before it lands, as a mirrored file is.
  const origin = s.header.status === 'tail' ? undefined : s.item.origin ?? peer.inventory!.host;
  const was = ctx.manifest.get(state.manifestKey(s.fam.id, s.item.to));
  const landed = landFile(s.tmp, target, s.expect, whole && typeof s.header.mtime === 'number' ? s.header.mtime : null, mode, (st) => recordWrite(ctx, s.fam, s.item.to, sha, {
    ...(origin && origin !== ctx.me.host ? { origin, originLabel: peer.label, ...(s.item.originName ? { originName: s.item.originName } : {}) } : {}),
    ...(was?.cached ? { usedAt: ctx.now } : {}),
    ...(s.item.key ? { key: s.item.key } : {}),
    source: { host: peer.inventory!.host, name: s.item.name },
  }, st));
  if (landed === 'changed') {
    ctx.done.push({ family: s.fam.id, from: peer.label, name: s.item.name, to: s.item.to, action: 'skipped', bytes: 0, detail: 'it changed here while it was fetched' });
    return;
  }
  const bytes = end - s.kept;
  state.audit({ op: s.header.status === 'tail' ? 'append' : 'create', family: s.fam.id, name: s.item.to, from: peer.label, bytes, sha256: sha });
  ctx.done.push({ family: s.fam.id, from: peer.label, name: s.item.name, to: s.item.to, action: s.header.status === 'tail' ? 'append' : 'create', bytes });
}

/**
 * Whether a text file gone from here more likely went with its folder than was deleted: a link on its way that leads
 * nowhere now (a cloud folder or a share that is not there), its project's folder gone whole, the deepest of its
 * folders still here left with nothing in it (a mount point with nothing mounted), or a cloud drive's placeholder
 * (`.<name>.icloud`) where it was.
 */
function unavailableHere(fam: SyncFamily, name: string): boolean {
  const segs = name.split('/');
  let dir = fam.root();
  let whole = true;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = path.join(dir, segs[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch {
      if (i === 0 && fam.projectScoped) return true;
      whole = false;
      break;
    }
    if (st.isSymbolicLink() && !fs.existsSync(next)) return true;
    dir = next;
  }
  if (whole && fs.existsSync(path.join(dir, `.${segs[segs.length - 1]}.icloud`))) return true;
  try {
    return !fs.readdirSync(dir).some((n) => !n.startsWith('.'));
  } catch {
    return true;
  }
}

/**
 * Note what changed here since the last run: a text file new or edited (its version is kept as an object, the base
 * of a later merge), a text file a person removed (a tombstone, so the other machines remove theirs), and sessions
 * deleted or restored with `oak sessions --delete` and `--undelete`. A file Claude Code's retention sweep removed (a
 * plan older than `cleanupPeriodDays`) is no deliberate delete. Nor is a family that vanished whole, or lost more
 * than half its files at once, as a folder on an unmounted share or a cloud drive does, nor a file that went with its
 * folder (unavailableHere): that is a warning, and no tombstone.
 */
function observeHere(ctx: RunContext, retentionDays: number): state.SyncTombstone[] {
  const out: state.SyncTombstone[] = [];
  const latest = state.latestTombstones(state.readTombstones());
  for (const fam of syncFamilies()) {
    if (fam.strategy !== 'text') continue;
    const here = new Map((ctx.me.families[fam.id] ?? []).map((f) => [f.name, f]));
    for (const f of here.values()) {
      // A file this machine deleted that is here again (made anew, or an edit made elsewhere that came back) is
      // restored on every machine: the latest event for it wins there.
      const was = latest.get(`file\0${fileTombKey(fam, f.name, ctx.me)}`);
      if (was?.deleted && was.host === ctx.me.host) out.push({ kind: 'file', key: was.key, deleted: false, at: ctx.now, host: ctx.me.host });
      if (!f.sha256) continue;
      const key = state.manifestKey(fam.id, f.name);
      const rec = ctx.manifest.get(key);
      if (rec?.history?.[rec.history.length - 1] === f.sha256 && rec.size === f.size) continue;
      try {
        state.putObject(fs.readFileSync(familyPath(fam, f.name)));
      } catch {
        continue;
      }
      ctx.manifest.set(key, { ...rec, family: fam.id, name: f.name, size: f.size, mtime: f.mtime, sha256: f.sha256, history: historyWith(rec, f.sha256) });
    }
    const gone = [...ctx.manifest.values()].filter((r) => r.family === fam.id && !here.has(r.name));
    if (!gone.length) continue;
    const known = [...ctx.manifest.values()].filter((r) => r.family === fam.id).length;
    const rootThere = fs.existsSync(fam.root());
    if (!rootThere || (gone.length > 3 && gone.length * 2 > known)) {
      ctx.warnings.push(`${gone.length} of ${known} ${fam.id} files are gone here at once${rootThere ? '' : ` (${fam.root()} is missing)`}; no delete is passed on, in case their folder is only unavailable`);
      continue;
    }
    // Claude Code's sweep is forgotten; a file that went with its folder is kept in mind, in case it comes back.
    const swept = (r: state.SyncManifestEntry): boolean => fam.retention && r.mtime < ctx.now - retentionDays * 86_400_000;
    const away = new Set(gone.filter((r) => !swept(r) && unavailableHere(fam, r.name)));
    if (away.size) ctx.warnings.push(`${away.size} ${fam.id} file${away.size === 1 ? ' is' : 's are'} gone here with ${away.size === 1 ? 'its' : 'their'} folder (missing, empty, or a link that leads nowhere); no delete is passed on, in case it is only unavailable`);
    for (const r of gone) {
      if (away.has(r)) continue;
      ctx.manifest.delete(state.manifestKey(fam.id, r.name));
      if (swept(r)) continue;
      const sha = r.history?.[r.history.length - 1] ?? r.sha256 ?? null;
      out.push({ kind: 'file', key: fileTombKey(fam, r.name, ctx.me), deleted: true, at: ctx.now, host: ctx.me.host, sha256: sha, ...(r.history?.length ? { history: r.history } : {}) });
    }
  }
  out.push(...sessionEvents(ctx.now, ctx.me.host));
  return out;
}

/** The sessions deleted (`oak sessions --delete`) or put back (`--undelete`) here since a run here last looked. */
function sessionEvents(now: number, host: string): state.SyncTombstone[] {
  const seen = new Set(state.readSeen().hidden);
  const hidden = hiddenSessions();
  const out: state.SyncTombstone[] = [];
  for (const id of hidden) if (!seen.has(id)) out.push({ kind: 'session', key: id, deleted: true, at: now, host });
  for (const id of seen) if (!hidden.has(id)) out.push({ kind: 'session', key: id, deleted: false, at: now, host });
  return out;
}

/**
 * Record this machine's session deletes and undeletes when another machine's run asks for its inventory (`oak
 * __sync-inventory --publish`), as a run here records them first (observeHere): a machine that runs no `oak sync now` of
 * its own (it saves no machine to pull from) passes them on all the same. Writes nothing when there is nothing to record,
 * and never beside a run here, which records them itself, or while the store is being moved (as a run refuses then).
 */
export function recordSessionDeletes(now = Date.now()): void {
  const host = machineHostTag();
  if (!sessionEvents(now, host).length || !state.takeSyncLock(SYNC_RUN_STALE_MS)) return;
  try {
    if (storeMoveHolder()) return;
    const events = sessionEvents(now, host);
    if (!events.length) return;
    state.addTombstones(events);
    state.writeAtomic(state.seenPath(), JSON.stringify({ hidden: [...hiddenSessions()] }));
  } finally {
    state.releaseSyncLock();
  }
}

/** A time as a person reads it, or the bare number for one past what a date can hold (a peer's own claim). */
const when = (ms: number): string => (Number.isNaN(new Date(ms).getTime()) ? `${ms} ms` : new Date(ms).toISOString());

/**
 * The deletes and restores the other machines report that this one has not recorded yet. One dated more than a day
 * ahead of this machine's clock (SYNC_TOMBSTONE_AHEAD_MS: that machine's clock is wrong) is recorded as made a day
 * from now, and known by the time it carried (`sentAt`), so it is not taken in again: as dated, it would outrank
 * every later change, here and on each machine this one passes it to, until its time came.
 */
function freshTombstones(ctx: RunContext, nodes: SyncNode[], stored: state.SyncTombstone[]): state.SyncTombstone[] {
  const id = (t: state.SyncTombstone, at: number): string => `${t.kind}\0${t.key}\0${at}\0${t.host}`;
  const known = new Set(stored.flatMap((t) => [id(t, t.at), ...(typeof t.sentAt === 'number' ? [id(t, t.sentAt)] : [])]));
  const latest = ctx.now + SYNC_TOMBSTONE_AHEAD_MS;
  const out: state.SyncTombstone[] = [];
  for (const t of nodes.flatMap((n) => (!n.local && n.inventory?.tombstones) || [])) {
    if (known.has(id(t, t.at))) continue;
    known.add(id(t, t.at));
    if (t.at <= latest) {
      out.push(t);
      continue;
    }
    ctx.warnings.push(`a ${t.deleted ? 'delete' : 'restore'} made on another machine (${t.host}) is dated ${when(t.at)}, more than a day ahead of this machine's clock: it counts as made a day from now; check that machine's clock`);
    out.push({ ...t, at: latest, sentAt: t.at });
  }
  return out;
}

/** Apply the deliberate deletes every machine reported, the latest event for each winning: hide or show sessions,
 *  and remove a text file here when it is still the version that was removed there (to the trash first). A session this
 *  machine deleted itself and no longer remembers deleting (no run here saw it hidden: its store was lost, or OAK was
 *  reinstalled, and its transcript stayed) is hidden again, as the machines that recorded the delete hold it. */
function applyTombstones(ctx: RunContext): number {
  let applied = 0;
  const hidden = hiddenSessions();
  const seen = new Set(state.readSeen().hidden);
  for (const t of ctx.tombs.values()) {
    const forgotten = t.host === ctx.me.host && t.kind === 'session' && t.deleted && !seen.has(t.key);
    if (t.host === ctx.me.host && !forgotten) continue;
    // One delete that cannot be applied here (a read-only folder) is said, and the run goes on.
    try {
      if (t.kind === 'session') {
        if (t.deleted && !hidden.has(t.key)) {
          try {
            hideSession(t.key);
            state.audit({ op: 'hide', name: t.key, detail: forgotten ? 'deleted here before, as the other machines recorded it' : `deleted on another machine (${t.host})` });
            applied++;
          } catch {
            /* not a session id this machine accepts */
          }
        } else if (!t.deleted && hidden.has(t.key)) {
          unhideSession(t.key);
          state.audit({ op: 'unhide', name: t.key, detail: `restored on another machine (${t.host})` });
          applied++;
        }
        continue;
      }
      if (!t.deleted) continue;
      const where = tombName(t.key, ctx.me);
      // A name that leads through a link sync does not follow is no file sync keeps here.
      const file = where && syncLocalPath(where.fam, where.name, ctx.refuse);
      if (!where || !file) continue;
      let sha: string;
      try {
        sha = hashFile(file);
      } catch {
        continue; // not here
      }
      if (!deletedVersion(t, sha)) continue; // edited here apart: the edit stays
      const trash = state.toTrash(where.fam.id, where.name, file, ctx.now);
      fs.rmSync(file, { force: true });
      ctx.manifest.delete(state.manifestKey(where.fam.id, where.name));
      state.audit({ op: 'delete', family: where.fam.id, name: where.name, sha256: sha, ...(trash ? { trash } : {}), detail: `removed on another machine (${t.host})` });
      applied++;
    } catch (e) {
      ctx.warnings.push(`a delete made on another machine (${t.host}) was not applied here: ${t.key}: ${String((e as Error)?.message || e)}`);
    }
  }
  fs.mkdirSync(state.syncDir(), { recursive: true, mode: 0o700 });
  state.writeAtomic(state.seenPath(), JSON.stringify({ hidden: [...hiddenSessions()] }));
  return applied;
}

/**
 * Close the conflicts a person resolved: one whose copy they deleted (this machine's version stands), and a text
 * conflict whose file here they changed since (their edit is the merge). Either way the other machine's version
 * joins this file's history, so the next run takes this machine's as the newer, and the other machine takes it too.
 */
function closeResolved(ctx: Pick<RunContext, 'conflicts' | 'manifest' | 'dismissed' | 'refuse'>): void {
  const open: state.SyncConflict[] = [];
  for (const c of ctx.conflicts) {
    const fam = syncFamily(c.family);
    const copyGone = !fs.existsSync(c.copy);
    const file = fam ? syncLocalPath(fam, c.name, ctx.refuse) : null;
    let edited = false;
    if (fam?.strategy === 'text' && !copyGone && file) {
      try {
        edited = hashFile(file) !== c.localSha256;
      } catch {
        edited = true;
      }
    }
    if (!copyGone && !edited) {
      open.push(c);
      continue;
    }
    if (fam?.strategy === 'text' && c.peerSha256) {
      const key = state.manifestKey(fam.id, c.name);
      const rec = ctx.manifest.get(key);
      let hNow: string | null = null;
      try {
        hNow = file ? hashFile(file) : null;
      } catch {
        hNow = null;
      }
      const hist = (rec?.history ?? []).filter((h) => h !== hNow);
      if (!hist.includes(c.peerSha256)) hist.push(c.peerSha256);
      if (hNow) hist.push(hNow);
      if (rec || hNow) ctx.manifest.set(key, { ...(rec ?? { family: fam.id, name: c.name, size: 0, mtime: 0 }), history: hist.slice(-state.SYNC_HISTORY_MAX) });
    }
    // A diverged session's copy deleted: this machine's stands, and that version is not fetched again.
    if (copyGone && fam && fam.strategy === 'append') ctx.dismissed.push({ family: c.family, name: c.name, host: c.host, size: c.peerSize });
    state.audit({ op: 'conflict', family: c.family, name: c.name, from: c.from, detail: copyGone ? 'resolved: its copy was deleted' : 'resolved: the file here was edited' });
  }
  ctx.conflicts = open;
}

/** An open conflict, with this machine's file of it (null where sync would not reach it): what `oak sync status` and
 *  `oak inbox` list, and what a surface opens beside the other machine's copy. */
export type SyncOpenConflict = state.SyncConflict & { file: string | null };

export function openSyncConflicts(): SyncOpenConflict[] {
  const list = state.readConflicts();
  const refuse = list.length ? neverRead() : null;
  return list.map((c) => {
    const fam = syncFamily(c.family);
    return { ...c, file: fam && refuse ? syncLocalPath(fam, c.name, refuse) : null };
  });
}

/** What `oak sync resolve <conflict> --json` prints (schema `syncResolve: 1`). */
export interface SyncResolveResult {
  syncResolve: 1;
  id: string;
  family: string;
  name: string;
  from: string;
  /** Where the other machine's copy went: sync's trash, or null when it was gone already. */
  trash: string | null;
  /** The conflicts this closed: this one, and any other resolved meanwhile (a text file edited here since). */
  closed: string[];
}

/**
 * `oak sync resolve <conflict>`: keep this machine's file by deleting the other machine's copy, into sync's trash,
 * and close the conflict now, as the next run would (closeResolved). Under the run's lock, so never during a run, and
 * never while the store moves.
 */
export function resolveSyncConflict(id: string, now = Date.now()): SyncResolveResult {
  if (!state.takeSyncLock(SYNC_RUN_STALE_MS)) throw new Error('another oak sync is running on this machine: resolve it once that run ends');
  refuseWhileStoreMoves();
  try {
    const conflicts = state.readConflicts();
    const c = conflicts.find((x) => x.id === id);
    if (!c) throw new Error(`no open conflict ${id}: \`oak sync status\` lists them`);
    let trash: string | null = null;
    if (fs.existsSync(c.copy)) {
      trash = state.moveToTrash(c.family, c.name, c.copy, now);
      state.audit({ op: 'delete', family: c.family, name: c.name, from: c.from, trash, detail: 'the conflict copy, deleted with oak sync resolve' });
    }
    const ctx = { conflicts, manifest: state.readManifest(), dismissed: state.readDismissals(), refuse: neverRead() };
    closeResolved(ctx);
    state.writeManifest(ctx.manifest);
    state.writeConflicts(ctx.conflicts);
    state.writeDismissals(ctx.dismissed);
    const open = new Set(ctx.conflicts.map((x) => x.id));
    return { syncResolve: 1, id, family: c.family, name: c.name, from: c.from, trash, closed: conflicts.filter((x) => !open.has(x.id)).map((x) => x.id) };
  } finally {
    state.releaseSyncLock();
  }
}

/** The status `oak sync status` reads, as the last run left it. */
export interface SyncStatusFile {
  at: number;
  durationMs: number;
  status: SyncNowResult['status'];
  machines: (SyncMachineRun & { lastOkAt?: number })[];
  warnings: string[];
  /** The run stopped before it finished, and why (herdr's list unreadable, a store that cannot be written). */
  error?: string;
}

const statusPath = (): string => path.join(state.syncDir(), 'status.json');
const backoffPath = (): string => path.join(state.syncDir(), 'backoff.json');

/** Say in the status file that a background run stopped, and why: what `oak sync status` and `oak doctor` read, and
 *  all such a run can tell anyone. It counts as a run, so the next is not due for SYNC_AUTO_MS, nor before the backoff
 *  its failure raised (sync-kick.ts syncBackoffMs) has passed; the machines keep what the last run said of them. */
function noteStopped(now: number, started: number, error: string): void {
  try {
    const last = readSyncStatusFile();
    state.writeAtomic(statusPath(), JSON.stringify({
      at: now, durationMs: Date.now() - started, status: 'partial', warnings: [`the run stopped: ${error}`], machines: last?.machines ?? [], error,
    } satisfies SyncStatusFile));
  } catch {
    /* the store cannot be written either: the caller says it */
  }
}

export function readSyncStatusFile(): SyncStatusFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(statusPath(), 'utf8'));
    return v && typeof v.at === 'number' && Array.isArray(v.machines) ? (v as SyncStatusFile) : null;
  } catch {
    return null;
  }
}

/** What is asked of a machine for one plan item, and the file here it lands on as the request found it. */
type ItemRequest = { req: SyncFetchItem; expect: { size: number; mtime: number } | null; target: string };

/** The request item for one plan item, and the file here it lands on: an append-only file names the bytes this
 *  machine holds and their hash. `skip` instead, with why, for an append-only file written here in the last
 *  SYNC_ACTIVE_MS by anything but sync: a session running on this machine, which a tail landed now could race (its
 *  next line written between sync's last look and its rename). Throws for an item that cannot be asked for, which
 *  fails alone. */
function requestItem(ctx: RunContext, fam: SyncFamily, item: SyncPlanItem): ItemRequest | { skip: string } {
  const target = localPath(ctx, fam, item.to);
  if (fam.strategy !== 'append') {
    // A mirrored file lands only over what was here when it was asked for (nothing, or this copy): a capture that
    // made it here meanwhile is never replaced.
    let expect: { size: number; mtime: number } | null = null;
    try {
      const st = fs.statSync(target);
      expect = { size: st.size, mtime: Math.floor(st.mtimeMs) };
    } catch {
      expect = null;
    }
    return { req: { family: fam.id, name: item.name }, expect, target };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return { req: { family: fam.id, name: item.name, offset: 0 }, expect: null, target };
  }
  const key = state.manifestKey(fam.id, item.to);
  const rec = ctx.manifest.get(key);
  const mtime = Math.floor(st.mtimeMs);
  // As sync last left or read it (its manifest record), it was not written here since, however recent its time.
  const asLeft = rec !== undefined && rec.size === st.size && rec.mtime === mtime;
  if (!asLeft && Math.abs(Date.now() - st.mtimeMs) < SYNC_ACTIVE_MS) {
    return { skip: 'written here in the last minute, by a session running on this machine: a later run takes it once it has been still a minute' };
  }
  let sha = asLeft ? rec.sha256 ?? null : null;
  if (!sha) {
    sha = hashFile(target);
    // A copy written here since sync left it (a session resumed on this machine) is marked so: recorded as it is now,
    // it would read as sync left it, and evictCache would take it for an unchanged copy and remove what was added here.
    const was = rec && !asLeft && (rec.cached || rec.origin) ? changedHere(rec) : rec;
    ctx.manifest.set(key, { ...was, family: fam.id, name: item.to, size: st.size, mtime, sha256: sha });
  }
  return { req: { family: fam.id, name: item.name, offset: st.size, sha256: sha }, expect: { size: st.size, mtime }, target };
}

/** The most bytes an answer may carry for an item: what its inventory listed, and as much again or 64 MB more, what a
 *  file still being written may have grown by since. A peer that sends more is not read any further. */
const answerRoom = (item: SyncPlanItem): number => item.size + Math.max(item.size, 64 * 1024 * 1024);

/** Fetch `items` from `peer` in one round trip, and apply each answer as it arrives. A machine is read for at most
 *  SYNC_PEER_BUDGET_MS, then stopped; every item whose answer did not arrive whole is pending. */
async function pullFrom(ctx: RunContext, peer: SyncNode, items: SyncPlanItem[], run: SyncMachineRun): Promise<void> {
  if (!peer.channel) return;
  const reqs: ({ item: SyncPlanItem; fam: SyncFamily } & ItemRequest)[] = [];
  for (const item of items) {
    const fam = syncFamily(item.family)!;
    try {
      const r = requestItem(ctx, fam, item);
      if ('skip' in r) ctx.done.push({ family: fam.id, from: peer.label, name: item.name, to: item.to, action: 'skipped', bytes: 0, detail: r.skip });
      else reqs.push({ item, fam, ...r });
    } catch (e) {
      run.errors.push(`${item.name}: ${String((e as Error)?.message || e)}`);
    }
  }
  if (!reqs.length) return;
  const histories = new Map<string, string[]>();
  for (const f of syncFamilies()) if (f.strategy === 'text') for (const e of peer.inventory?.families[f.id] ?? []) histories.set(`${f.id}\0${e.name}`, e.history ?? []);
  const channel = peer.channel(JSON.stringify({ fetch: SYNC_FETCH_VERSION, items: reqs.map((r) => r.req) }));
  // A machine that sends slowly, however steadily, holds this machine's lock no longer than the budget.
  let overBudget = false;
  const budget = setTimeout(() => {
    overBudget = true;
    channel.stop?.();
  }, SYNC_PEER_BUDGET_MS);
  let sink: AppendSink | null = null;
  let text: { i: number; chunks: Buffer[]; header: SyncFrameHeader } | null = null;
  /** The items whose answers arrived whole, applied or failed. */
  const finished = new Set<number>();
  /** The item whose bytes are being dropped: its write could not start. */
  let dropping: number | null = null;
  const failed = (i: number, e: unknown): void => {
    run.errors.push(`${reqs[i]?.item.name ?? i}: ${String((e as Error)?.message || e)}`);
  };
  const reader = new SyncFrameReader({
    header: (h) => {
      const r = reqs[h.i];
      if (!r) throw new Error('an answer for no item asked');
      if (typeof h.length === 'number' && h.length > answerRoom(r.item)) throw new Error(`${r.item.name}: ${h.length} bytes were sent for a file its inventory listed at ${r.item.size}`);
      try {
        onHeader(h, r);
      } catch (e) {
        failed(h.i, e);
        sink = null;
        text = null;
        dropping = h.i;
      }
    },
    body: (i, chunk) => {
      if (dropping === i) return;
      if (sink) sinkWrite(sink, chunk);
      else if (text) text.chunks.push(Buffer.from(chunk));
      if (Date.now() - touched > 10_000) {
        touched = Date.now();
        state.touchSyncLock();
      }
    },
    end: (i) => {
      finished.add(i);
      if (dropping === i) {
        dropping = null;
        return;
      }
      try {
        onEnd(i);
      } catch (e) {
        failed(i, e);
      }
    },
  });
  let touched = Date.now();
  function onHeader(h: SyncFrameHeader, r: (typeof reqs)[number]): void {
      // What the answer may be: a tail only of a file this machine holds, from where its bytes end; a whole file for one
      // it holds never replaces it, and is kept as a conflict copy, as a diverged one is; text comes whole.
      let status = h.status;
      if (r.fam.strategy === 'append') {
        if (status === 'tail' && (!r.expect || h.offset !== r.req.offset)) throw new Error(`bytes from ${h.offset} on were sent for a file asked from ${r.req.offset ?? 0}`);
        if (status === 'whole' && (r.req.offset ?? 0) > 0) status = 'diverged';
      } else if (status === 'tail' || status === 'diverged' || status === 'shorter') throw new Error(`"${status}" was sent for a file asked whole`);
      // Append-only, content-addressed and mirrored files stream to disk beside their target; text, and a file a
      // family takes in itself, is held in memory (text larger than SYNC_HASH_MAX_BYTES is never planned).
      if (status === 'tail' || status === 'diverged' || (status === 'whole' && !r.fam.receive && r.fam.strategy !== 'text')) {
        sink = openAppendSink(ctx, r.item, r.fam, status === h.status ? h : { ...h, status }, r.expect, r.target);
      } else if (status === 'whole') {
        text = { i: h.i, chunks: [], header: h };
      } else if (status === 'shorter') {
        ctx.done.push({ family: r.fam.id, from: peer.label, name: r.item.name, to: r.item.to, action: 'skipped', bytes: 0, detail: 'it is shorter there now than here: cut or rewritten there since its inventory' });
      } else {
        run.errors.push(`${r.item.name}: ${status === 'missing' ? 'gone there since its inventory' : 'refused there'}`);
      }
  }
  function onEnd(i: number): void {
      const r = reqs[i];
      if (sink) {
        const s = sink;
        sink = null;
        closeAppendSink(ctx, s, peer, true, run);
      } else if (text) {
        const body = Buffer.concat(text.chunks);
        const sha = text.header.sha256;
        text = null;
        if (sha && state.sha256(body) !== sha) {
          run.errors.push(`${r.item.name}: its bytes did not match their hash`);
          return;
        }
        if (r.fam.receive) {
          try {
            r.fam.receive(body, { name: r.item.name, to: r.item.to, from: peer.label, origin: r.item.origin ?? peer.inventory!.host });
            ctx.done.push({ family: r.fam.id, from: peer.label, name: r.item.name, to: r.item.to, action: 'create', bytes: body.length });
          } catch (e) {
            run.errors.push(`${r.item.name}: ${String((e as Error)?.message || e)}`);
          }
        } else applyText(ctx, r.fam, r.item, peer, body, histories.get(`${r.fam.id}\0${r.item.name}`) ?? []);
      }
  }
  try {
    for await (const chunk of channel.stream) {
      if (overBudget) break;
      reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (e) {
    if (!overBudget) run.errors.push(`the fetch broke off: ${String((e as Error)?.message || e)}`);
  } finally {
    clearTimeout(budget);
  }
  // An answer cut off. Stopped at the budget, what it holds of an append-only JSONL file lands up to its last complete
  // line, so a file too large for one run's budget comes over in several; otherwise none of it lands (a content-
  // addressed or mirrored file is whole or nothing).
  let landed: { i: number; bytes: number } | null = null;
  if (sink) {
    const s: AppendSink = sink;
    sink = null;
    const n = ctx.done.length;
    closeAppendSink(ctx, s, peer, overBudget && s.fam.strategy === 'append' && s.cut && s.lineEnd > s.kept, run);
    const d = ctx.done[n];
    if (d?.action === 'skipped') finished.add(s.header.i); // pending once, as the run counts a skipped file
    else if (d) landed = { i: s.header.i, bytes: d.bytes };
  }
  if (overBudget) run.errors.push(`stopped after ${SYNC_PEER_BUDGET_MS / 60_000} minutes, the longest one run reads from one machine: it sent too slowly, and the rest waits for the next run`);
  const ended = await channel.done;
  if (reader.shared) {
    run.status = 'shared';
    run.detail = 'it runs under another user\'s account, so it sent nothing';
  } else if (ended && !overBudget) {
    run.status = ended.status;
    if (ended.detail) run.detail = ended.detail;
  }
  for (let i = 0; i < reqs.length; i++) {
    if (finished.has(i)) continue;
    run.pending.files++;
    run.pending.bytes += Math.max(0, reqs[i].item.bytes - (landed?.i === i ? landed.bytes : 0));
  }
}

/** Remove on-demand copies past the cache's size, least recently used first: only one unchanged since it was fetched,
 *  and only while the machine it came from, in an inventory this run read (`index`), still lists it at least as long
 *  as its own or the backup's copy, not one it too fetched on demand and may evict, so no evicted copy was the last
 *  one. An evicted copy goes to no trash: the trash would keep what the cap is there to free. */
function evictCache(ctx: RunContext, capMB: number, index: Map<string, SyncInventory>): number {
  // A copy changed here is never evicted (SyncManifestEntry.changed).
  const cached = [...ctx.manifest.values()].filter((e) => e.cached && !e.changed);
  let total = 0;
  const live: { e: state.SyncManifestEntry; fam: SyncFamily; size: number; file: string }[] = [];
  for (const e of cached) {
    const fam = syncFamily(e.family);
    const file = fam && syncLocalPath(fam, e.name, ctx.refuse);
    if (!fam || !file) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      ctx.manifest.delete(state.manifestKey(e.family, e.name));
      continue;
    }
    // Changed here since it was fetched (a resumed session), or another machine's other version of it is held as a
    // conflict copy (an earlier build recorded a resumed copy as sync left it): this machine's own now, never evicted.
    if (st.size !== e.size || Math.floor(st.mtimeMs) !== e.mtime || ctx.conflicts.some((c) => c.family === e.family && c.name === e.name)) {
      ctx.manifest.set(state.manifestKey(e.family, e.name), { ...changedHere(e), size: st.size, mtime: Math.floor(st.mtimeMs), sha256: null });
      continue;
    }
    total += st.size;
    live.push({ e, fam, size: st.size, file });
  }
  let evicted = 0;
  const cap = capMB * 1024 * 1024;
  for (const { e, fam, size, file } of live.sort((a, b) => (a.e.usedAt ?? 0) - (b.e.usedAt ?? 0))) {
    if (total <= cap) break;
    const src = e.source ? index.get(e.source.host) : undefined;
    const held = !!src?.families[fam.id]?.some((f) => f.name === e.source!.name && f.size >= size) && !src.sync?.cached.includes(`${fam.id}/${e.source!.name}`);
    if (!held) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      ctx.warnings.push(`the on-demand copy ${e.name} could not be evicted: ${String((err as Error)?.message || err)}`);
      continue;
    }
    ctx.manifest.delete(state.manifestKey(e.family, e.name));
    state.audit({ op: 'evict', family: e.family, name: e.name, bytes: size, detail: `held by ${e.source!.host}` });
    total -= size;
    evicted++;
  }
  return evicted;
}

/** A run, or `oak sync fetch`, that took its lock while OAK's store is being moved lets it go again and refuses: what it
 *  pulled would land where the move is taking the store from. The move takes its own lock and then looks for this one,
 *  as a run takes its own and then looks for the move's, so whichever comes second sees the other (store.ts moveStore);
 *  nothing is written, here or in the status file, which is in the store too. */
function refuseWhileStoreMoves(): void {
  const moving = storeMoveHolder();
  if (!moving) return;
  state.releaseSyncLock();
  throw new Error(`OAK's store is being moved (${moving}), and oak sync writes there: try again once the move finishes`);
}

/**
 * `oak sync now`: pull from every enabled saved machine (only those `machines` names) what this machine's
 * placement says it holds, carrying out its part of the plan (planSync with this machine's policy). One run at a
 * time per machine (`sync/now.lock`); a background run (`ifDue`) returns at once when the last one is under
 * SYNC_AUTO_MS old, while the background runs back off after failures (sync-kick.ts syncBackoffMs), or when the
 * background run is turned off. A first run with neither a saved machine to sync with nor a backup folder set is not
 * kept as the last run, so it sets nothing up. Throws only for what the caller must say (herdr's list unreadable, a
 * machine not saved).
 */
export async function syncNow(transport: SyncTransport, opts: { machines?: string[]; ifDue?: boolean; now?: number } = {}): Promise<SyncNowResult> {
  const started = Date.now();
  const now = opts.now ?? started;
  const settings = syncSettings();
  const empty = (status: SyncNowResult['status']): SyncNowResult => ({ syncNow: 1, at: now, durationMs: 0, status, backup: null, machines: [], done: [], tombstones: { recorded: 0, applied: 0 }, warnings: [] });
  if (opts.ifDue && !settings.auto) return empty('off');
  if (!state.takeSyncLock(SYNC_RUN_STALE_MS)) return empty('busy');
  refuseWhileStoreMoves();
  try {
    state.clearInflight();
    const last = readSyncStatusFile();
    if (opts.ifDue && last && Math.abs(now - last.at) < SYNC_AUTO_MS) return empty('not-due');
    // An interrupted or limited run proves nothing about a lost part of a record log.
    const surveyFile = path.join(state.syncDir(), 'records-survey.json');
    fs.rmSync(surveyFile, { force: true });
    if (opts.ifDue) {
      // After failures in a row the background run waits longer each time. This one counts as failed until it ends
      // well, so a run killed before it can say why (out of memory, a crash) holds the next one off too.
      const backoff = readSyncBackoff();
      if (syncBackedOff(now, backoff)) return empty('not-due');
      state.writeAtomic(backoffPath(), JSON.stringify({ at: now, failures: (backoff?.failures ?? 0) + 1 }));
    }
    const user = localUserName();
    if (!user) throw new Error('could not tell which user this machine runs as, which every machine must answer for');
    const saved = await transport.machines();
    let recordsListed = true;
    const nodes = await collectSyncNodes({ machines: async () => saved,
      inventory: async (target, user) => {
        const answer = await transport.inventory(target, user);
        // The parser fills absent families with empty lists; an older OAK that never listed records proves no absence.
        try { if (!('text' in answer) || !Array.isArray(JSON.parse(answer.text)?.families?.['oak-records'])) recordsListed = false; }
        catch { recordsListed = false; }
        return answer;
      },
      fetch: (target, user, req) => transport.fetch(target, user, req),
    }, { machines: opts.machines, exclude: settings.excludeMachines, user });
    const local = nodes[0];
    const me = local.inventory!;
    const ctx: RunContext = { me, manifest: state.readManifest(), conflicts: state.readConflicts(), tombs: new Map(), done: [], warnings: [], now, refuse: neverRead(), dismissed: state.readDismissals() };
    const retentionDays = me.cleanupPeriodDays ?? CLAUDE_DEFAULT_RETENTION_DAYS;
    // Index everywhere: every machine's inventory is kept here, which is what lists and searches them all.
    const index = new Map<string, SyncInventory>();
    for (const n of nodes) {
      if (n.local || n.status !== 'ok' || !n.inventory) continue;
      state.writeIndex(n.inventory.host, n.label, n.inventory);
      index.set(n.inventory.host, n.inventory);
    }
    // The backup role, resolved here. A backup folder brings its copy of each machine it holds (passive nodes): this
    // machine's own files come back from it, and the deletes recorded there count, as any machine's do.
    const role = resolveSyncBackup(settings.backup, { nodes, local: me });
    local.role = { backup: role?.self === true };
    if (settings.backup && !role) ctx.warnings.push(`the backup target "${settings.backup.kind}" is not one this build carries out`);
    if (role?.kind === 'machine' && !role.self && !nodes.some((n) => !n.local && n.label === role.label)) {
      ctx.warnings.push(`the backup "${role.label}" is no saved machine here and not this machine's name, so no machine keeps every session`);
    }
    ctx.warnings.push(...(role?.warnings ?? []));
    const passive = (role?.nodes ?? []).filter((n) => n.passive && n.status === 'ok' && n.inventory);
    nodes.push(...passive);
    // Deliberate deletes: this machine's since the last run, and every machine's, the latest for each winning.
    const recorded = observeHere(ctx, retentionDays);
    state.addTombstones(recorded);
    state.addTombstones(freshTombstones(ctx, nodes, state.readTombstones()));
    ctx.tombs = state.latestTombstones(state.readTombstones());
    const applied = applyTombstones(ctx);
    closeResolved(ctx);
    // OAK's own store: the copies of sessions their machine cleaned up, or that were deleted, are let go before the plan.
    const upkeep = upkeepStoreReplicas({ nodes, tombs: ctx.tombs, manifest: ctx.manifest, now, warnings: ctx.warnings });
    if (upkeep.evicted.length) ctx.warnings.push(`${upkeep.evicted.length} cop${upkeep.evicted.length === 1 ? 'y' : 'ies'} of OAK sessions their machine cleaned up ${upkeep.evicted.length === 1 ? 'was' : 'were'} let go (to the trash)`);
    if (upkeep.earlier.length) {
      ctx.warnings.push(`${upkeep.earlier.length} OAK session${upkeep.earlier.length === 1 ? '\'s folder was' : 's\' folders were'} made anew on ${upkeep.earlier.length === 1 ? 'its' : 'their'} machine: the copy held here is kept as ${upkeep.earlier.length === 1 ? 'its' : 'their'} earlier history (${upkeep.earlier.slice(0, 3).join(', ')}${upkeep.earlier.length > 3 ? ', …' : ''})`);
      // Those copies are under other names now: the plan reads this machine as it is, so none is kept current as before.
      const again = syncInventory({ user });
      if ('families' in again) local.inventory = ctx.me = again;
    }
    // This machine's part of the plan, by its own policy.
    const deletedHere = new Set([...ctx.tombs.values()].filter((t) => t.kind === 'session' && t.deleted).map((t) => t.key));
    const plan = planSync(nodes, now, { unmappedLands: true, policy: true, deleted: deletedHere }).machines[0];
    ctx.warnings.push(...(plan.warnings ?? []));
    const runOf = (n: SyncNode): SyncMachineRun => ({
      label: n.label, ...(n.inventory ? { host: n.inventory.host } : {}), status: n.status, ...(n.detail ? { detail: n.detail } : {}),
      pulled: { files: 0, bytes: 0 }, conflicts: 0, pending: { files: 0, bytes: 0 }, errors: [],
    });
    const machines: SyncMachineRun[] = nodes.filter((n) => !n.local && !n.passive).map(runOf);
    // A backup that is no machine has one line of its own: what came back from it, and what this machine wrote to it.
    const backupRun: SyncMachineRun | null = role && (role.nodes || role.push || role.error)
      ? { label: `backup (${role.label})`, status: role.error ? 'failed' : 'ok', ...(role.error ? { detail: role.error } : {}), ...(role.record ? { record: role.record } : {}),
        pulled: { files: 0, bytes: 0 }, conflicts: 0, pending: { files: 0, bytes: 0 }, errors: [...(role.errors ?? [])] }
      : null;
    const passiveRuns = new Map(passive.map((n) => [n.label, runOf(n)]));
    // Skip what an open conflict already holds for the same copy, or a person dismissed: a diverged transcript is
    // fetched once per version. A dismissal ends once that machine's copy is another size: a new version, raised anew.
    const hostOf = (label: string): string | undefined => nodes.find((n) => n.label === label)?.inventory?.host;
    const dismissed = (p: SyncPlanItem): boolean => ctx.dismissed.some((d) => d.family === p.family && d.name === p.to && d.host === hostOf(p.from) && d.size === p.size);
    const pulls = (plan.pulls ?? []).filter((p) => {
      const fam = syncFamily(p.family)!;
      const c = ctx.conflicts.find((x) => x.family === p.family && x.name === p.to && x.host === hostOf(p.from));
      return !(c && fam.strategy === 'append' && c.peerSize === p.size && fs.existsSync(c.copy)) && !dismissed(p);
    });
    const asked = new Set(nodes.filter((n) => !n.local && !n.passive && n.status === 'ok').map((n) => n.inventory!.host));
    ctx.dismissed = ctx.dismissed.filter((d) => !asked.has(d.host) || (plan.pulls ?? []).some((p) => p.family === d.family && p.to === d.name && hostOf(p.from) === d.host && p.size === d.size));
    for (const n of nodes) {
      if (n.local || n.status !== 'ok') continue;
      const run = passiveRuns.get(n.label) ?? machines.find((m) => m.label === n.label)!;
      const mine = pulls.filter((p) => p.from === n.label);
      let budget = SYNC_RUN_MAX_BYTES;
      const now1: SyncPlanItem[] = [];
      for (const p of mine) {
        if (p.bytes > budget && now1.length) {
          run.pending.files++;
          run.pending.bytes += p.bytes;
          continue;
        }
        budget -= p.bytes;
        now1.push(p);
      }
      if (!now1.length) continue;
      const before = ctx.done.length;
      try {
        await pullFrom(ctx, n, now1, run);
      } catch (e) {
        run.errors.push(String((e as Error)?.message || e));
      }
      for (const d of ctx.done.slice(before)) {
        if (d.action === 'conflict') run.conflicts++;
        else if (d.action !== 'skipped') {
          run.pulled.files++;
          run.pulled.bytes += d.bytes;
        } else {
          run.pending.files++;
        }
      }
    }
    // Each session folder a file of OAK's store landed in carries the generation of the copy it came from.
    noteLandedGenerations(ctx.done, (label) => nodes.find((n) => n.label === label)?.inventory);
    if (backupRun) {
      for (const r of passiveRuns.values()) {
        backupRun.pulled.files += r.pulled.files;
        backupRun.pulled.bytes += r.pulled.bytes;
        backupRun.conflicts += r.conflicts;
        backupRun.pending.files += r.pending.files;
        backupRun.pending.bytes += r.pending.bytes;
        backupRun.errors.push(...r.errors.map((e) => `${r.label}: ${e}`));
        if (r.status !== 'ok') {
          backupRun.status = r.status;
          backupRun.detail = r.detail ?? backupRun.detail;
        }
      }
    }
    const evicted = evictCache(ctx, settings.cacheMB, index);
    if (evicted) ctx.warnings.push(`${evicted} on-demand cop${evicted === 1 ? 'y was' : 'ies were'} evicted to keep the cache under ${settings.cacheMB} MB`);
    state.writeManifest(ctx.manifest);
    state.writeConflicts(ctx.conflicts);
    state.writeDismissals(ctx.dismissed);
    try {
      state.pruneTrash(now);
      state.pruneObjects(ctx.manifest);
    } catch (e) {
      ctx.warnings.push(`sync's old trash and merge bases could not all be removed: ${String((e as Error)?.message || e)}`);
    }
    // Last, this machine's own files to a backup that is no machine: what it holds now, restored files included.
    if (backupRun && role?.push && !role.error) {
      try {
        // Taken again when the run changed anything here: the run's first inventory lacks what it put back, and a machine
        // reinstalled would otherwise write its empty first one over the record of what it deleted and cleaned up.
        const fresh = ctx.done.length || recorded.length || applied || upkeep.evicted.length || upkeep.deleted.length ? syncInventory({ user }) : me;
        if (!('families' in fresh)) throw new Error('this machine refused its own inventory');
        const pushed = await role.push({ me: fresh, placements: settings.families, now });
        backupRun.pushed = pushed.pushed;
        backupRun.pending.files += pushed.pending.files;
        backupRun.pending.bytes += pushed.pending.bytes;
        backupRun.errors.push(...pushed.errors);
        ctx.warnings.push(...pushed.warnings);
      } catch (e) {
        backupRun.status = 'failed';
        // The file system's refusal (a share mounted read-only, a full disk) is said with what to do.
        const err = e as NodeJS.ErrnoException;
        backupRun.detail = err?.code ? `this machine's files could not be written there: ${err.message}. Free space there, or make it writable for this machine` : String(err?.message || e);
      }
    }
    if (backupRun) machines.push(backupRun);
    const status: SyncNowResult['status'] = machines.some((m) => m.errors.length || m.pending.files || !['ok', 'disabled', 'excluded', 'duplicate', 'shared'].includes(m.status)) ? 'partial' : 'ok';
    // The status file is what sets sync up here (the background runs and `oak doctor`'s rows wait for it). A first run
    // with neither a saved machine to sync with nor a backup folder leaves none: the background would inventory this
    // machine for nobody. A backup folder alone sets it up. A saved machine that could not be reached this time counts;
    // one disabled, excluded, another account's, or this machine itself under another label does not.
    const setsUp = !!last || !!backupRun || nodes.some((n) => !n.local && !['disabled', 'excluded', 'duplicate', 'shared'].includes(n.status));
    if (!setsUp) ctx.warnings.push('this run does not set sync up here, so nothing runs in the background until a run has a saved machine to sync with or a backup folder set');
    const result: SyncNowResult = {
      syncNow: 1, at: now, durationMs: Date.now() - started, status,
      backup: role ? { kind: role.kind, label: role.label, self: role.self } : settings.backup ? { kind: settings.backup.kind, label: 'label' in settings.backup ? settings.backup.label : settings.backup.path, self: false } : null,
      machines, done: ctx.done, tombstones: { recorded: recorded.length, applied }, warnings: ctx.warnings,
    };
    const lastOk = new Map((last?.machines ?? []).map((m) => [m.label, m.lastOkAt]));
    if (setsUp) {
      state.writeAtomic(statusPath(), JSON.stringify({
        at: now, durationMs: result.durationMs, status, warnings: ctx.warnings,
        machines: machines.map((m) => ({ ...m, ...(m.status === 'ok' && !m.errors.length ? { lastOkAt: now } : lastOk.get(m.label) ? { lastOkAt: lastOk.get(m.label) } : {}) })),
      } satisfies SyncStatusFile));
    }
    // Every saved machine and the backup answered, without a dropped inventory entry or an unfinished transfer.
    // Keep what they held before the push: a copy there must be read back before the index can give up waiting for it.
    if (saved !== null && recordsListed && !opts.machines?.length && status === 'ok'
      && nodes.every((n) => (n.status === 'ok' || n.status === 'duplicate') && !n.dropped)
      && (!settings.backup || (role && !role.error && !role.errors?.length && (role.self || role.node || role.nodes)))) {
      const names = [...new Set(nodes.filter((n) => !n.local).flatMap((n) => (n.inventory?.families['oak-records'] ?? []).map((f) => f.name)))];
      state.writeAtomic(surveyFile, JSON.stringify({ at: started, backup: settings.backup, names }));
    }
    fs.rmSync(backoffPath(), { force: true }); // it ended well: the background runs are due at their usual pace again
    return result;
  } catch (e) {
    // A run in the background (`ifDue`) has no one to tell but the status file; one in the foreground says it itself.
    if (opts.ifDue) noteStopped(now, started, String((e as Error)?.message || e));
    throw e;
  } finally {
    state.clearInflight(); // every file it wrote was renamed into place or removed: what is left is a failed write's
    state.releaseSyncLock();
  }
}

/** What `oak sync status --json` prints (schema `syncStatus: 1`): from the store alone, no ssh. */
export interface SyncStatusResult {
  syncStatus: 1;
  /** A run with a saved machine to sync with, or with a backup folder set, has happened here (its status file): the
   *  background run kicks, and `oak doctor` shows sync's rows, only once one has. */
  setUp: boolean;
  auto: boolean;
  running: boolean;
  last: SyncStatusFile | null;
  backup: SyncBackupSetting | null;
  placements: Record<string, SyncPlacement>;
  exclude: { machines: string[]; projects: string[] };
  conflicts: SyncOpenConflict[];
  /** The other machines' inventories kept here: who they are, when, and how much they hold. */
  index: { label: string; host: string; savedAt: number; files: number; bytes: number }[];
  cache: { files: number; bytes: number; capMB: number };
  /** The backup folder's key here: whether there is one, and its fingerprint (sync-crypto.ts), or why it cannot be read. */
  key: { present: boolean; fingerprint?: string; error?: string };
}

export function syncStatus(): SyncStatusResult {
  const settings = syncSettings();
  const placements: Record<string, SyncPlacement> = {};
  for (const f of syncFamilies()) placements[f.id] = placementOf(f, settings.families);
  const manifest = state.readManifest();
  const cached = [...manifest.values()].filter((e) => e.cached);
  return {
    syncStatus: 1,
    setUp: fs.existsSync(statusPath()),
    auto: settings.auto,
    running: state.syncLockHeld(SYNC_RUN_STALE_MS),
    last: readSyncStatusFile(),
    backup: settings.backup,
    placements,
    exclude: { machines: settings.excludeMachines, projects: settings.excludeProjects },
    conflicts: openSyncConflicts(),
    index: state.readIndex().map((x) => {
      const inv = x.inventory as SyncInventory;
      const files = Object.values(inv?.families ?? {}).flat();
      return { label: x.label, host: x.host, savedAt: x.savedAt, files: files.length, bytes: files.reduce((s, f) => s + (f?.size ?? 0), 0) };
    }),
    cache: { files: cached.length, bytes: cached.reduce((s, e) => s + e.size, 0), capMB: settings.cacheMB },
    key: keyState(),
  };
}

/** The backup key here, as status and doctor say it: never the key itself. */
function keyState(): SyncStatusResult['key'] {
  try {
    const key = readSyncKey();
    return key ? { present: true, fingerprint: keyFingerprint(key) } : { present: false };
  } catch (e) {
    return { present: false, error: String((e as Error)?.message || e) };
  }
}

/** What `oak sync fetch <session> --json` prints (schema `syncFetch: 1`). */
export interface SyncFetchResult {
  syncFetch: 1;
  session: string;
  /** The machine it came from, or null when nothing was fetched: it was here already, or no machine that holds it
   *  gave it. */
  from: string | null;
  done: SyncDone[];
  /** The machines tried, in order (its origin first, then the backup), and why each that gave nothing did not. */
  tried: { label: string; status: string; detail?: string }[];
  /** Where it now is here: a transcript or rollout path, or for a session of OAK's store alone, its edit log here. */
  path: string | null;
}

/** The families `oak sync fetch` brings a session's files of, and which of them names where the session is. */
const FETCH_MAIN = ['transcripts', 'rollouts', 'oak-log'];

/**
 * `oak sync fetch <session>`: bring one session's files (a Claude Code transcript with its session folder, or a
 * Codex rollout, and OAK's own store of it: its edit log, the content snapshots its edits name, its comments and hook
 * events) from the machine that made it, or the backup, or any other machine the index lists it on, into its place here,
 * as an on-demand copy (`cached` in the manifest, evicted past the cache's size). Another machine's store session lands
 * as its replica (sync-store.ts). From the index: no inventory is asked, only the fetch; a backup folder's copy of a
 * machine is tried after the machines themselves. Already here and as long as anywhere: nothing to do.
 */
export async function syncFetchSession(transport: SyncTransport, session: string, opts: { now?: number } = {}): Promise<SyncFetchResult> {
  const now = opts.now ?? Date.now();
  const result: SyncFetchResult = { syncFetch: 1, session, from: null, done: [], tried: [], path: null };
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error(`not a session id: ${session}`);
  const user = localUserName();
  if (!user) throw new Error('could not tell which user this machine runs as');
  const me = syncInventory({ user });
  if (!('families' in me)) throw new Error('this machine refused its own inventory');
  const settings = syncSettings();
  const machines = (await transport.machines()) ?? [];
  const index: { label: string; inventory: SyncInventory; node?: SyncNode }[] = state.readIndex().flatMap((x) => {
    const parsed = parseSyncInventory(JSON.stringify(x.inventory));
    return parsed && 'families' in parsed.inventory ? [{ label: x.label, inventory: parsed.inventory }] : [];
  });
  // A backup folder's copy of each machine it holds, tried after the machines themselves.
  const role = settings.backup?.kind === 'folder' ? resolveSyncBackup(settings.backup, { nodes: [], local: me }) : null;
  for (const n of role?.nodes ?? []) if (n.passive && n.inventory) index.push({ label: n.label, inventory: n.inventory, node: n });
  const holds = (inv: SyncInventory): { fam: SyncFamily; f: SyncFile }[] => syncFamilies().flatMap((fam) =>
    (inv.families[fam.id] ?? []).filter((f) => sessionOf(fam.id, f.name) === session).map((f) => ({ fam, f })));
  const holders = index.filter((x) => holds(x.inventory).length);
  if (!holders.length) {
    if (role?.error) throw new Error(`no machine's inventory lists session ${session}, and the backup folder could not be read: ${role.error}`);
    throw new Error(`no machine's inventory lists session ${session} — run \`oak sync now\` to refresh the inventories`);
  }
  // Its origin first (a machine that lists it as its own, not a copy it pulled), then the backup machine, then the backup
  // folder's copies, then any other machine that holds it.
  const rank = (x: (typeof holders)[number]): number => {
    if (x.node) return 2;
    if (holds(x.inventory).some((h) => !h.f.origin)) return 0;
    if (settings.backup?.kind === 'machine' && settings.backup.label === x.label) return 1;
    return 3;
  };
  const longest = (x: (typeof holders)[number]): number => Math.max(...holds(x.inventory).map((h) => h.f.size));
  const ordered = [...holders].sort((a, b) => rank(a) - rank(b) || longest(b) - longest(a));
  const ctx: RunContext = { me, manifest: state.readManifest(), conflicts: state.readConflicts(), tombs: new Map(), done: [], warnings: [], now, refuse: neverRead(), dismissed: [] };
  const here = new Map<string, SyncFile>();
  for (const fam of syncFamilies()) for (const f of me.families[fam.id] ?? []) here.set(`${fam.id}\0${f.name}`, f);
  if (!state.takeSyncLock(SYNC_RUN_STALE_MS)) throw new Error('a sync is running on this machine; try again when it ends');
  refuseWhileStoreMoves();
  try {
    state.clearInflight();
    for (const x of ordered) {
      let node: SyncNode;
      if (x.node) node = x.node;
      else {
        const m = machines.find((s) => plainLabel(s.label) === x.label && s.enabled);
        if (!m) {
          result.tried.push({ label: x.label, status: 'not-saved', detail: 'no longer an enabled saved machine' });
          continue;
        }
        node = { label: x.label, local: false, status: 'ok', inventory: x.inventory, target: m.target, channel: (req) => transport.fetch(m.target, user, req) };
      }
      const mapFolder = folderMapper(me);
      const items: SyncPlanItem[] = [];
      for (const { fam, f } of holds(x.inventory)) {
        const origin = f.origin ?? x.inventory.host;
        let to = f.name;
        // The identity of its project, recorded with the copy as a run records it: a folder here that holds only
        // copies is known by it, so the next machine that fetches from this one places them in its own folder.
        let key: string | undefined;
        if (fam.target) {
          const t = fam.target(f, { host: x.inventory.host, label: x.label, origin, me: me.host });
          if (t === null) continue;
          to = t;
        } else if (fam.projectScoped) {
          const folder = f.name.slice(0, f.name.indexOf('/'));
          const proj = x.inventory.projects.find((p) => p.folder === folder);
          key = (proj?.cwd ? x.inventory.identities[proj.cwd]?.key : proj?.key) ?? undefined;
          const l = mapFolder(x.inventory, folder);
          to = 'unmapped' in l ? f.name : `${l.folder}${f.name.slice(folder.length)}`;
        }
        const ownName = origin === me.host ? f.originName : undefined;
        if (ownName && fam.accepts(ownName)) to = ownName;
        if (!fam.accepts(to)) continue;
        const originName = f.origin ? f.originName : f.name;
        const mine = here.get(`${fam.id}\0${to}`);
        let have = mine?.size ?? -1;
        if (!mine) {
          try {
            const p = syncLocalPath(fam, to, ctx.refuse);
            if (p) have = fs.statSync(p).size;
          } catch {
            have = -1;
          }
        }
        const want = fam.wants ? fam.wants(mine, f) : have < f.size;
        if (!want) continue;
        items.push({ family: fam.id, from: x.label, name: f.name, to, action: 'pull', reason: have < 0 ? 'missing' : 'longer',
          bytes: fam.wants || fam.strategy !== 'append' ? f.size : f.size - Math.max(0, have), size: f.size, localSize: have < 0 ? null : have, origin,
          ...(originName ? { originName } : {}), ...(key ? { key } : {}), ...(f.stamp ? { stamp: f.stamp } : {}) });
      }
      const run: SyncMachineRun = { label: x.label, host: x.inventory.host, status: 'ok', pulled: { files: 0, bytes: 0 }, conflicts: 0, pending: { files: 0, bytes: 0 }, errors: [] };
      if (items.length) await pullFrom(ctx, node, items, run);
      if (run.status !== 'ok' || run.errors.length) {
        result.tried.push({ label: x.label, status: run.status, ...(run.detail || run.errors.length ? { detail: run.detail ?? run.errors[0] } : {}) });
        continue;
      }
      // The machine it came from only when something did: one that held nothing this machine lacks gave nothing.
      result.from = ctx.done.some((d) => d.from === x.label && (d.action === 'create' || d.action === 'append' || d.action === 'replace')) ? x.label : null;
      result.tried.push({ label: x.label, status: 'ok' });
      for (const d of ctx.done) {
        if (d.action !== 'create' && d.action !== 'append' && d.action !== 'replace') continue;
        const key = state.manifestKey(d.family, d.to);
        const e = ctx.manifest.get(key);
        if (e && e.origin && e.origin !== me.host && !e.changed) ctx.manifest.set(key, { ...e, cached: true, usedAt: now });
      }
      const main = FETCH_MAIN.map((id) => items.find((i) => i.family === id)).find(Boolean) ?? items[0];
      const fam = main ? syncFamily(main.family)! : null;
      result.path = fam && main ? familyPath(fam, main.to) : null;
      break;
    }
    noteLandedGenerations(ctx.done, (label) => ordered.find((x) => x.label === label)?.inventory);
    if (!result.path) {
      // Already here, whole: where it is.
      for (const id of [...FETCH_MAIN].reverse()) {
        const fam = syncFamily(id);
        const f = fam && holds(me).find((h) => h.fam.id === id);
        if (fam && f) result.path = familyPath(fam, f.f.name);
      }
    }
    result.done = ctx.done;
    // No copy is evicted here: the index may be days old, and the machine it names may no longer hold what it lists.
    // The next run evicts, by the inventories it reads.
    state.writeManifest(ctx.manifest);
    state.writeConflicts(ctx.conflicts);
    return result;
  } finally {
    state.clearInflight();
    state.releaseSyncLock();
  }
}

/** `oak doctor`'s rows for sync, once it has been used here (its status file, which the background run waits for
 *  too): Claude Code's retention, which sync follows, its last run and the conflicts left open, and for a backup folder,
 *  whether this machine holds its key. Before: with a machine saved here (`savedMachines`, from herdr's list) and no
 *  choice made, a suggestion to run `oak sync setup`; with none, nothing, since a machine that does not sync needs no
 *  advice on it. From the store, prefs.json and settings.json alone: no ssh, and the backup folder is not read. */
export function diagnoseSync(now = Date.now(), opts: { savedMachines?: number } = {}): Check[] {
  const last = readSyncStatusFile();
  const settings = syncSettings();
  // oak sync's settings lost from prefs.json, which keptPrefs reads from its copy until an upkeep writes them back, and
  // the restore that did: said for a week, by when that OAK has been quit or updated, or it drops them again.
  const lost = state.keptPrefsLost();
  const restore = state.keptPrefsRestore();
  const fixKept = 'Quit or update that OAK: a terminal app started before the update (quit it and run `oak` again), a VS Code window not reloaded since (Developer: Reload Window), or another `oak` on your PATH (the "`oak` in a login shell" row names it).';
  const settingsRow: Check[] = lost.length
    ? [{ id: 'sync-settings', label: 'oak sync settings', level: 'warn', detail: state.keptPrefsWords(lost, true), fix: fixKept }]
    : restore && Math.abs(now - restore.at) < 7 * 86_400_000
      ? [{ id: 'sync-settings', label: 'oak sync settings', level: 'warn',
        detail: `${state.keptPrefsWords(restore.keys)}, at ${(require('./format') as typeof import('./format')).relTime(restore.at, now)}`, fix: fixKept }]
      : [];
  const keyRow = (): Check[] => {
    if (settings.backup?.kind !== 'folder') return [];
    const k = keyState();
    return [k.present
      ? { id: 'sync-backup', label: 'oak sync backup folder', level: 'ok', detail: `${settings.backup.path}, encrypted with the key ${k.fingerprint} kept here` }
      : { id: 'sync-backup', label: 'oak sync backup folder', level: 'warn', detail: `${settings.backup.path} is the backup, but nothing is written there or read from it: ${k.error ?? 'this machine has no key for it'}`,
        // A key file that holds no key is copied over only with --replace (sync-crypto.ts writeSyncKey).
        fix: `Copy the key from a machine that has it: \`oak sync key --from <machine>${k.error ? ' --replace' : ''}\` (or \`oak sync key --import${k.error ? ' --replace' : ''}\`).` }];
  };
  // This machine's record log, which the backup and the other machines keep a copy of: a segment the local index
  // published in it is gone (OAK 0.10's `oak clean` removed the folder, or a hand did). The next catch-up writes it again
  // from the index.
  const logRow = (): Check[] => {
    if (!settings.backup && !last) return [];
    if (!(require('./index/api') as typeof import('./index/api')).ownRecordLogGone()) return [];
    return [{ id: 'sync-records', label: 'oak sync record log', level: 'warn',
      detail: `${path.join(rootDir(), 'records', machineHostTag())} has lost what the local database published in it, so the backup and the other machines miss what the database derived of this machine's sessions (the archive among it) until it is written again`,
      fix: 'Run `oak sessions`: its catch-up writes the log again from the local database, and the next `oak sync now` sends it on.' }];
  };
  const partialLogs = (require('./index/api') as typeof import('./index/api')).partialRecordLogChecks();
  if (!last) {
    const n = opts.savedMachines ?? 0;
    const suggest: Check[] = !settings.backup && !state.keptPrefs().sync?.setupAt && n > 0
      ? [{ id: 'sync-setup', label: 'oak sync', level: 'ok', detail: `not set up here; ${n} saved machine${n === 1 ? '' : 's'} could share memory, plans, skills and sessions with this one`,
        fix: 'Run `oak sync setup` to choose where sessions are backed up and preview a first run.' }]
      : [];
    return [...settingsRow, ...suggest, ...keyRow(), ...logRow(), ...partialLogs];
  }
  const rows: Check[] = [...settingsRow];
  const days = (require('./sync') as typeof import('./sync')).readCleanupPeriodDays();
  rows.push(days === null
    ? { id: 'sync-retention', label: 'Claude Code transcript retention', level: 'warn',
      detail: `cleanupPeriodDays is not set, so Claude Code deletes transcripts and plans after ${CLAUDE_DEFAULT_RETENTION_DAYS} days, and oak sync pulls none older than that`,
      fix: `Set "cleanupPeriodDays": 3650 in Claude Code's settings.json (${path.join(claudeConfigDir(), 'settings.json')}) to keep them ten years.` }
    : { id: 'sync-retention', label: 'Claude Code transcript retention', level: 'ok', detail: `cleanupPeriodDays is ${days}` });
  const st = { last, conflicts: state.readConflicts() };
  const { relTime } = require('./format') as typeof import('./format');
  const bad = st.last.machines.filter((m) => !['ok', 'disabled', 'excluded', 'duplicate', 'shared'].includes(m.status) || m.errors.length);
  const stopped = typeof st.last.error === 'string' ? st.last.error : null;
  rows.push({
    id: 'sync', label: 'oak sync', level: stopped || bad.length || st.conflicts.length ? 'warn' : 'ok',
    detail: `last run ${relTime(st.last.at, now)}${stopped ? `, which stopped: ${stopped}` : ''}${bad.length ? `; ${bad.map((m) => `${m.label}: ${m.detail ?? m.errors[0] ?? m.status}`).join('; ')}` : ''}${st.conflicts.length ? `; ${st.conflicts.length} conflict${st.conflicts.length === 1 ? '' : 's'} open` : ''}`,
    ...(stopped || bad.length || st.conflicts.length ? { fix: st.conflicts.length ? 'Run `oak sync status` to see each conflict copy, and resolve it by editing your file or deleting the copy (`oak sync resolve <id>`).' : stopped ? 'Run `oak sync status` to see why it stopped.' : 'Run `oak sync status` for each machine\'s reason, or `oak sync plan` to ask the machines again.' } : {}),
  });
  rows.push(...keyRow(), ...logRow(), ...partialLogs);
  return rows;
}
