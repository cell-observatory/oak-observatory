/**
 * oak sync: what each machine holds of the agents' state, and what it would pull from the others.
 *
 * Each saved machine (herdr's `oak machine list`) answers `oak __sync-inventory --json --user <name>` over OAK's
 * own ssh with an INVENTORY: the files of every data family it holds (Claude Code transcripts and their session
 * folders, auto memory, plans, skills, agents and commands; Codex rollouts), each with its size and time, the
 * small text files with a sha256, and the working directory each Claude project folder and Codex rollout names,
 * with its identity key (sync-identity.ts). The inventory reads nothing else: never `.claude.json`, never
 * settings beyond `cleanupPeriodDays`, never the per-process session files, shell snapshots, credentials, or
 * Codex's `auth.json`, `config.toml` and log or queue databases (`neverRead`). A machine whose user is not the
 * caller's (a lab machine that runs under a shared account) refuses before it reads anything at all.
 *
 * A PLAN (`planSync`) is computed from the inventories alone: for each machine, what it would pull from each of
 * the others. The design is pull-only, so no machine ever writes a peer. Nothing here writes anything.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { claudeConfigDir, claudeJsonPath } from './paths';
import { codexHome } from './codex';
import { mangleCwd } from './session';
import { machineHostTag } from './machine-usage';
import { identityKey, readMountTable, type SyncIdentity, type SyncShare } from './sync-identity';
import { readManifest, readTombstones, manifestKey, ownEvictedSessions, keptPrefs, type SyncTombstone } from './sync-state';
import { hiddenSessions, isSafeSessionId, rootDir } from './store';

export * from './sync-identity';

/** The inventory's wire version: an OAK that reads another version reads no inventory at all. */
export const SYNC_INVENTORY_VERSION = 1;
/** Bytes read from the head of a transcript or rollout to find the working directory it names. */
export const SYNC_HEAD_BYTES = 64 * 1024;
/** A text file larger than this is listed without a hash: no read is unbounded. */
export const SYNC_HASH_MAX_BYTES = 16 * 1024 * 1024;
/** Claude Code's own default for `cleanupPeriodDays`, which applies when settings.json sets none. */
export const CLAUDE_DEFAULT_RETENTION_DAYS = 30;
/** How far ahead of this machine's clock another machine's delete or restore may be dated and still count as dated;
 *  one later than that counts as made this long from now (a clock that is wrong would otherwise win forever). */
export const SYNC_TOMBSTONE_AHEAD_MS = 86_400_000;
/** How many of a project folder's newest transcripts are read for the working directory it names. */
const CWD_TRIES = 3;
/** How deep a walk of skills, plans, agents and commands goes. */
const WALK_DEPTH = 8;

/** One file a machine holds: its path relative to its family's root (always `/`-separated), size, modification time
 *  (epoch ms), a sha256 for the small text families (null for one larger than SYNC_HASH_MAX_BYTES), and, for a Codex
 *  rollout, the working directory its first record names. */
export interface SyncFile {
  name: string;
  size: number;
  mtime: number;
  sha256?: string | null;
  cwd?: string | null;
  /** The machine it came from (machineHostTag), for a file this machine pulled; absent for its own. */
  origin?: string;
  /** Its name on that machine, where a restore puts it back. */
  originName?: string;
  /** A text file's past hashes on that machine, oldest first: what a three-way merge finds its base in. */
  history?: string[];
  /** For a family that mirrors files whole (OAK's own session logs): what changes whenever the file is rewritten or
   *  grows on the machine that made it (SyncFamily.stamp); a copy elsewhere reports the stamp it was taken at. */
  stamp?: string;
  /** For a file of OAK's store (its log, hook events, comments and agent record; not its snapshots): the generation of
   *  the session folder it is in (sync-store.ts), which tells a folder made anew from the one it replaced. */
  gen?: string;
}

/** A Claude Code project folder and the working directory its sessions started in (null when no transcript there
 *  names one that mangles to the folder's name, such as a folder of copies made on another machine). */
export interface SyncProject {
  folder: string;
  cwd: string | null;
  /** A session that started on that machine names it, rather than only copies pulled from others (a folder sync made
   *  for a project with no place there). Only such a folder says where a checkout is on that machine. */
  own?: boolean;
  /** For a folder whose files all came from other machines, whose recorded directories name those machines' paths:
   *  the identity key they were pulled under (sync's manifest). */
  key?: string;
}

/** What `oak __sync-inventory` prints. `identities` maps each working directory the inventory names to its key. */
export interface SyncInventory {
  inventory: 1;
  shared?: false;
  /** When it was taken (epoch ms, that machine's clock). */
  at: number;
  /** machineHostTag: the first 12 hex digits of sha256 of the host name and home directory. */
  host: string;
  user: string;
  home: string;
  platform: string;
  /** `cleanupPeriodDays` from Claude Code's settings.json, or null where it sets none. */
  cleanupPeriodDays: number | null;
  projects: SyncProject[];
  identities: Record<string, SyncIdentity>;
  shares: SyncShare[];
  families: Record<string, SyncFile[]>;
  /** The names of Codex's own databases, listed and never opened (the log and queue databases not even listed). */
  codexSqlite: string[];
  /** That machine's sync settings and state, which decide what it would pull (planSync's policy). */
  sync?: SyncMachineState;
  /** The deliberate deletes it knows of (sync-state.ts SyncTombstone). */
  tombstones?: SyncTombstone[];
}

/** Where a family's files are kept: on every machine, on the machine that made them plus the backup target, on that
 *  machine alone (others fetch them when asked), or nowhere but where they are. */
export type SyncPlacement = 'everywhere' | 'backup' | 'on-demand' | 'off';
export const SYNC_PLACEMENTS: readonly SyncPlacement[] = ['everywhere', 'backup', 'on-demand', 'off'];

/** What a machine says of its own sync settings in its inventory. */
export interface SyncMachineState {
  /** Its settings name it the backup target, by its own name (namesThisMachine). */
  backup: boolean;
  /** Its placement overrides, by family id. */
  placements: Record<string, SyncPlacement>;
  /** The identity keys of the projects it does not sync. */
  excludeProjects: string[];
  /** `<family>/<name>` of each copy it fetched on demand. */
  cached: string[];
  /** The sessions deleted there (`oak sessions --delete`). */
  hidden: string[];
  /** The sessions of its own whose store it removed (`oak clean`, a dropped session) and does not hold now, with when:
   *  what tells the other machines that it cleaned them up, rather than lost them (sync-store.ts). */
  evicted: { id: string; at: number }[];
}

/** A machine that runs under another user's account answers this, having read nothing. */
export interface SyncRefusal {
  inventory: 1;
  shared: true;
}

export type SyncInventoryAnswer = SyncInventory | SyncRefusal;

/** How a family's copies are reconciled: append-only files by prefix and tail, small text files by a three-way
 *  merge, content-addressed files by copying what is missing and verifying it by its hash, and files one machine
 *  publishes and others only mirror (OAK's own session logs, which their machine rewrites) whole whenever they change. */
export type SyncStrategy = 'append' | 'text' | 'cas' | 'mirror';

/** What a family's `list` reads on the machine that holds it. */
export interface SyncListContext {
  claude: string;
  codex: string;
  home: string;
  /** The Claude project folders, read once per inventory however many families ask. */
  projects(): ClaudeProjectScan[];
  /** Whether a real path may be read at all (neverRead); `from` is the family's real root, for a path a symlink led to. */
  allowed(real: string, from?: string): boolean;
  /** The hash sync recorded for a file of this family, name, size and modification time, so an unchanged file is not
   *  read again; undefined when it has none. */
  known(family: string, name: string, size: number, mtime: number): string | undefined;
  /** The stamp sync recorded for a copy it took of another machine's file (SyncFile.stamp), while the copy is still
   *  the size and time it landed with; undefined otherwise. */
  stamp(family: string, name: string, size: number, mtime: number): string | undefined;
}

/** A data family: what it holds, where, how its copies are reconciled, and which names it accepts. A name a
 *  family does not accept is never planned, and never served to another machine. */
export interface SyncFamily {
  id: string;
  agent: 'claude' | 'codex' | 'oak';
  strategy: SyncStrategy;
  /** Where its files are kept by default (a machine's prefs.json `sync.families` overrides it). */
  placement: SyncPlacement;
  /** A name's first segment is a Claude project folder, which each machine maps to its own by identity. */
  projectScoped: boolean;
  /** Claude Code's retention sweep removes it once older than `cleanupPeriodDays`. */
  retention: boolean;
  /** The directory the names are relative to, on this machine. */
  root(): string;
  accepts(name: string): boolean;
  list(ctx: SyncListContext): SyncFile[];
  /** Where a peer's file lands here, for a family that keeps other machines' files apart (a replica namespace keyed by
   *  the machine that made them, since a session id can repeat across machines); null leaves it out, as a family does
   *  for this machine's own files (`origin` is `me`). Absent: under the same name, a Claude project folder mapped by
   *  identity. A family that lists the replicas it holds lets another machine restore from them. */
  target?(e: SyncFile, from: { host: string; label: string; origin: string; me: string }): string | null;
  /** Whether a peer's copy is to be fetched, against this machine's. Absent: by strategy. */
  wants?(here: SyncFile | undefined, peer: SyncFile): boolean;
  /** The session a name belongs to, for a family whose names carry one somewhere of their own: what a deliberate
   *  delete of that session skips (sessionOf). */
  session?(name: string): string | null;
  /** A mirrored file's stamp (SyncFile.stamp), from the open file's stat and descriptor. */
  stamp?(st: fs.Stats, fd: number): string;
  /** Take a whole fetched file in place of the engine's own write, for a family that must re-key or index what it
   *  takes in. The engine has fetched it and checked its hash; the family writes it. */
  receive?(body: Buffer, at: { name: string; to: string; from: string; origin: string }): void;
}

/** One project folder as the inventory reads it, before it is split into families. */
export interface ClaudeProjectScan {
  folder: string;
  cwd: string | null;
  own: boolean;
  key?: string;
  transcripts: SyncFile[];
  sessionFiles: SyncFile[];
  memory: SyncFile[];
}

/** A segment Windows can hold, refused on every platform so that no machine sends a Windows machine a name it cannot
 *  write: none of Windows' reserved characters (`<>:"|?*`) or the control characters, no device name (CON, PRN, AUX,
 *  NUL, COM or LPT with a digit or a superscript 1 to 3, CONIN$, CONOUT$; in any case, and with any extension: `nul.md`
 *  is the device too), and no trailing dot or space, which Windows drops (`plan.md.` would be `plan.md`). */
function windowsSafe(seg: string): boolean {
  if (/[<>:"|?*\u0000-\u001f]/.test(seg) || /[. ]$/.test(seg)) return false;
  return !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i.test(seg.split('.')[0].replace(/ +$/, ''));
}

/** A path relative to a family root that stays inside it: no empty, `.` or `..` segment, no hidden segment (which
 *  the listings skip too: a `.git` inside a skill, an editor's swap file, `.DS_Store`), no backslash, no drive, and
 *  no segment Windows cannot hold (windowsSafe). */
export function safeSyncName(name: string): boolean {
  if (typeof name !== 'string' || !name || name.length > 4096 || /[\0\\]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.startsWith('.') && windowsSafe(seg));
}

/** A Claude project folder or session directory name: what mangleCwd and Claude Code's session ids produce. */
const FOLDER = '[A-Za-z0-9][A-Za-z0-9_-]*|-[A-Za-z0-9_-]*';
const TRANSCRIPT_NAME = new RegExp(`^(?:${FOLDER})/[A-Za-z0-9_-]+\\.jsonl$`);
const SESSION_FILE_NAME = new RegExp(`^(?:${FOLDER})/[A-Za-z0-9_-]+/(?:subagents|tool-results)/.+$`);
const MEMORY_NAME = new RegExp(`^(?:${FOLDER})/memory/[^/]+\\.md$`);
const ROLLOUT_NAME = /^(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions(?:\/\d{4}\/\d{2}\/\d{2})?)\/rollout-[^/]+\.jsonl$/;

/** Is `real` (a resolved path) at or below `dir`? */
function under(real: string, dir: string): boolean {
  return real === dir || real.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** The real path of `p`, or `p` itself when it cannot be resolved. The native resolver: the JavaScript one stats each
 *  component of the path in turn, which was most of an inventory's time across thousands of session folders. */
function realOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * What sync never reads, not even to list: Claude Code's `.claude.json`, its settings files (settings.json is read
 * for `cleanupPeriodDays` alone, by `readCleanupPeriodDays`), its credentials, its per-process `sessions/` files and
 * `shell-snapshots/`; Codex's `auth.json`, `config.toml` and its log and queue databases; and the home's own
 * credential stores and OAK's backup keys (also in a relocated store), which a symlinked skill could otherwise lead
 * a walk into. Checked by real path, so a symlink does not lead around it. Also refused: the Claude config and Codex
 * directories themselves reached through a symlink from inside a family, which would list everything under them as
 * that family's files.
 */
export function neverRead(claude = claudeConfigDir(), codex = codexHome(), home = os.homedir()): (real: string, from?: string) => boolean {
  // Each path as given, through its directory's real path, and through its own: an entry that is itself a link (`~/.ssh`
  // kept in a dotfiles folder) is refused where it leads too, or a skill linked to it listed what lies there. Only links
  // are resolved, so nothing these paths hold is read, not even listed.
  const dirsOf = new Map<string, string[]>();
  const spell = (dir: string): string[] => {
    let v = dirsOf.get(dir);
    if (!v) dirsOf.set(dir, (v = [...new Set([path.resolve(dir), realOr(dir)])]));
    return v;
  };
  const inDir = (dir: string, names: string[]): string[] =>
    [...new Set(spell(dir).flatMap((d) => names.flatMap((n) => [path.join(d, n), realOr(path.join(d, n))])))];
  const json = claudeJsonPath();
  const keyDir = path.join(rootDir(), 'sync');
  const keyDirs = spell(keyDir);
  const realFiles = new Set([
    ...inDir(path.dirname(json), [path.basename(json)]),
    ...inDir(claude, ['settings.json', 'settings.local.json', '.credentials.json']),
    ...inDir(codex, ['auth.json', 'config.toml']),
    ...inDir(home, ['.netrc', '.git-credentials']),
    ...inDir(keyDir, ['key']),
  ]);
  // The local index (claude-observatory-index) is this machine's own and holds every machine's prompts and answers: a
  // machine builds its own from what it pulls, never copies another's.
  const realDirs = [...inDir(claude, ['sessions', 'shell-snapshots', 'claude-observatory-index']), ...inDir(home, ['.ssh', '.gnupg', '.aws'])];
  const roots = [...spell(claude), ...spell(codex)];
  const codexReal = spell(codex);
  return (real: string, from?: string): boolean => {
    if (realFiles.has(real) || realDirs.some((d) => under(real, d))) return true;
    if (keyDirs.includes(path.dirname(real)) && path.basename(real).startsWith('key.replaced-')) return true;
    if (codexReal.some((d) => path.dirname(real) === d) && /^(?:logs|queue)_.*\.sqlite/.test(path.basename(real))) return true;
    if (from === undefined) return false;
    // Reached through a symlink inside a family (`from` is the family's real root): one that leads to the config
    // directory, Codex's, or above either, or into either anywhere but the family's own folder.
    return roots.some((r) => under(r, real)) || (roots.some((r) => under(real, r)) && !under(real, from));
  };
}

/**
 * Where sync may read, write or remove a family's file on this machine: its real path, reached as the inventory's
 * walk reaches a file, or null where the walk would not go (neverRead). A symlink on the way is followed only where it
 * leads somewhere the walk follows one to, so a name a peer sends, or a delete it passes on, cannot lead through a
 * link inside a family (`skills/keys` to `~/.ssh`, a skill linked to the Claude folder) to what sync never touches. A
 * link that leads nowhere now is not followed either. The part of the name not there yet is made below the last
 * folder that was checked, and a link that is the file itself is written through, not replaced.
 */
export function syncLocalPath(fam: SyncFamily, name: string, refuse: (real: string, from?: string) => boolean = neverRead()): string | null {
  const rootReal = realOr(fam.root());
  if (refuse(rootReal)) return null;
  const segs = name.split('/');
  let real = rootReal;
  for (let i = 0; i < segs.length; i++) {
    // Resolved, as the walk resolves a link: where a link leads is checked, and nothing there is touched first.
    const next = path.join(real, segs[i]);
    let r: string;
    try {
      r = fs.realpathSync.native(next);
    } catch {
      try {
        fs.readlinkSync(next);
        return null; // a link that leads nowhere now
      } catch {
        /* not there yet */
      }
      const rest = path.join(real, ...segs.slice(i));
      return refuse(rest) ? null : rest;
    }
    if (r !== next ? refuse(r, rootReal) : refuse(r)) return null;
    real = r;
  }
  return real;
}

/** The working directory one record names: its own `cwd`, or a Codex `session_meta` payload's. */
function recordCwd(line: string): string | null {
  if (!line.includes('"cwd"')) return null;
  try {
    let o = JSON.parse(line);
    if (o?.type === 'session_meta') o = o.payload;
    return o && typeof o.cwd === 'string' && o.cwd ? o.cwd : null;
  } catch {
    return null; // a torn or foreign line
  }
}

/**
 * The working directory the first complete record of a transcript or rollout names (`cwd`, or a Codex
 * `session_meta` payload's). Read from the start in chunks that double from 4 KB, stopping at the first record
 * that names one, and never past SYNC_HEAD_BYTES: a first record longer than that names none.
 */
export function headCwd(file: string, max = SYNC_HEAD_BYTES): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    let buf = Buffer.alloc(0);
    let parsed = 0;
    let chunk = 4096;
    while (buf.length < max) {
      const part = Buffer.alloc(Math.min(chunk, max - buf.length));
      const got = fs.readSync(fd, part, 0, part.length, buf.length);
      if (got === 0) return recordCwd(buf.toString('utf8', parsed)); // the end: a last record with no newline is whole
      buf = Buffer.concat([buf, part.subarray(0, got)]);
      for (let nl = buf.indexOf(10, parsed); nl !== -1; nl = buf.indexOf(10, parsed)) {
        const cwd = recordCwd(buf.toString('utf8', parsed, nl));
        parsed = nl + 1;
        if (cwd) return cwd;
      }
      chunk *= 2;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** sha256 of a file of at most SYNC_HASH_MAX_BYTES, read in chunks; null for a larger one or one that cannot be read. */
export function sha256File(file: string, size: number): string | null {
  if (size > SYNC_HASH_MAX_BYTES) return null;
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** A file entry from a stat, or null for anything but a regular file. */
function fileEntry(name: string, st: fs.Stats): SyncFile | null {
  return st.isFile() ? { name, size: st.size, mtime: Math.floor(st.mtimeMs) } : null;
}

/**
 * Every regular file below `dir`, depth-first, as names relative to it joined by `/`. Hidden entries are skipped;
 * symlinks are followed (a skill linked from a checkout of its own) unless `allowed` refuses where they lead, and a
 * directory is entered once however many links lead to it.
 */
function walkFiles(dir: string, allowed: (real: string, from?: string) => boolean,
  opts: { depth?: number; skip?: (rel: string) => boolean; hash?: boolean; real?: string; known?: (rel: string, size: number, mtime: number) => string | undefined } = {}): SyncFile[] {
  const out: SyncFile[] = [];
  // `real`: the caller reached `dir` through no symlink and knows its real path, so it need not be resolved again.
  const rootReal = opts.real ?? realOr(dir);
  if (!allowed(rootReal)) return out;
  const seen = new Set<string>();
  const visit = (abs: string, real: string, rel: string, depth: number): void => {
    if (depth > (opts.depth ?? WALK_DEPTH) || seen.has(real)) return;
    seen.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (opts.skip?.(childRel)) continue;
      const childAbs = path.join(abs, e.name);
      let childReal = path.join(real, e.name);
      let st: fs.Stats;
      try {
        if (e.isSymbolicLink()) {
          childReal = fs.realpathSync.native(childAbs);
          if (!allowed(childReal, rootReal)) continue;
        } else if (!allowed(childReal)) continue;
        st = fs.statSync(childAbs);
      } catch {
        continue; // dangling, or raced away
      }
      if (st.isDirectory()) visit(childAbs, childReal, childRel, depth + 1);
      else {
        const f = fileEntry(childRel, st);
        if (!f) continue;
        if (opts.hash) f.sha256 = opts.known?.(childRel, f.size, f.mtime) ?? sha256File(childAbs, f.size);
        out.push(f);
      }
    }
  };
  visit(dir, rootReal, '', 0);
  return out;
}

/** The files of one directory (not below it) whose names match `re`, hashed when asked. */
function listDir(dir: string, re: RegExp, allowed: (real: string, from?: string) => boolean, prefix: string, hash = false,
  known?: (name: string, size: number, mtime: number) => string | undefined): SyncFile[] {
  const out: SyncFile[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    if (n.startsWith('.') || !re.test(n)) continue;
    const abs = path.join(dir, n);
    try {
      const real = fs.realpathSync.native(abs);
      if (!allowed(real)) continue;
      const f = fileEntry(`${prefix}${n}`, fs.statSync(abs));
      if (!f) continue;
      if (hash) f.sha256 = known?.(f.name, f.size, f.mtime) ?? sha256File(abs, f.size);
      out.push(f);
    } catch {
      /* raced away */
    }
  }
  return out;
}

/** Does `folder` name `cwd` the way Claude Code would: equal to its mangled form, or, for a name Claude Code shortened
 *  and hashed, its kept prefix with any hash (a build that hashes differently is not taken for a copy). */
export function folderNamesCwd(folder: string, cwd: string): boolean {
  const slug = mangleCwd(cwd);
  if (slug.length <= 200) return folder === slug;
  return folder.length > 201 && folder.startsWith(slug.slice(0, 201)) && /^[0-9a-z]+$/.test(folder.slice(201));
}

/**
 * Each Claude project folder: its transcripts, the files of its sessions' `subagents/` and `tool-results/`, its auto
 * memory, and the working directory its sessions started in, read from the newest transcripts (at most CWD_TRIES of
 * them, SYNC_HEAD_BYTES each) until one names a directory whose mangled name is the folder's. Transcripts Claude
 * Code set aside (`<session>.orphaned-…`) are not sessions and are skipped.
 */
function scanClaudeProjects(claude: string, allowed: (real: string, from?: string) => boolean, known?: SyncListContext['known'], pulled?: (name: string) => boolean,
  keyOf?: (name: string) => string | undefined): ClaudeProjectScan[] {
  const base = path.join(claude, 'projects');
  const out: ClaudeProjectScan[] = [];
  let folders: fs.Dirent[];
  try {
    folders = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  const folderRe = new RegExp(`^(?:${FOLDER})$`);
  for (const d of folders.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!folderRe.test(d.name)) continue;
    const dir = path.join(base, d.name);
    let entries: fs.Dirent[];
    let dirReal: string;
    try {
      dirReal = realOr(dir);
      if (!fs.statSync(dir).isDirectory() || !allowed(dirReal)) continue;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const scan: ClaudeProjectScan = { folder: d.name, cwd: null, own: false, transcripts: [], sessionFiles: [], memory: [] };
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.name.endsWith('.jsonl')) {
        if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(e.name)) continue; // set-aside copies carry a dot-separated suffix
        try {
          if (e.isSymbolicLink() && !allowed(realOr(abs), realOr(base))) continue;
          const f = fileEntry(`${d.name}/${e.name}`, fs.statSync(abs));
          if (f) scan.transcripts.push(f);
        } catch {
          /* raced away */
        }
      } else if (e.name === 'memory') {
        scan.memory.push(...listDir(abs, /\.md$/, allowed, `${d.name}/memory/`, true, known && ((n, size, mtime) => known('memory', n, size, mtime))));
      } else if (/^[A-Za-z0-9_-]+$/.test(e.name) && (e.isDirectory() || e.isSymbolicLink())) {
        // One listing per session folder, and only what it holds is walked: most sessions have neither folder, and
        // resolving two absent paths for each of thousands of sessions was most of an inventory's time.
        let subs: fs.Dirent[];
        try {
          if (e.isSymbolicLink() && !allowed(realOr(abs), realOr(base))) continue;
          subs = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of subs) {
          if ((sub.name !== 'subagents' && sub.name !== 'tool-results') || !(sub.isDirectory() || sub.isSymbolicLink())) continue;
          const plain = e.isDirectory() && sub.isDirectory();
          const files = walkFiles(path.join(abs, sub.name), allowed, { depth: 4, ...(plain ? { real: path.join(dirReal, e.name, sub.name) } : {}) });
          for (const f of files) scan.sessionFiles.push({ ...f, name: `${d.name}/${e.name}/${sub.name}/${f.name}` });
        }
      }
    }
    // The sessions that started here first: copies pulled from other machines name their paths, not this folder's.
    const byAge = [...scan.transcripts].sort((a, b) => b.mtime - a.mtime);
    const ownFirst = [...byAge.filter((t) => !pulled?.(t.name)).slice(0, CWD_TRIES), ...byAge.filter((t) => pulled?.(t.name)).slice(0, CWD_TRIES)];
    for (const t of ownFirst) {
      const cwd = headCwd(path.join(base, t.name));
      if (cwd && folderNamesCwd(d.name, cwd)) {
        scan.cwd = cwd;
        scan.own = !pulled?.(t.name);
        break;
      }
    }
    // A folder sync filled from other machines: its sessions' directories are theirs, its identity what sync recorded.
    if (!scan.cwd && keyOf) {
      const counts = new Map<string, number>();
      for (const t of [...scan.transcripts, ...scan.memory]) {
        const k = keyOf(t.name);
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (top) scan.key = top[0];
    }
    out.push(scan);
  }
  return out;
}

/** The families the planner and the fetch command know, by id. Another module adds its own with `registerSyncFamily`
 *  (OAK's own store, as content-addressed blobs and logs merged by record), and the inventory, the plan, the fetch
 *  command and the engine carry it with no change of their own. Returns what removes it again. */
const FAMILIES = new Map<string, SyncFamily>();

export function registerSyncFamily(f: SyncFamily): () => void {
  FAMILIES.set(f.id, f);
  return () => {
    if (FAMILIES.get(f.id) === f) FAMILIES.delete(f.id);
  };
}

export function syncFamilies(): SyncFamily[] {
  return [...FAMILIES.values()];
}

export function syncFamily(id: string): SyncFamily | undefined {
  return FAMILIES.get(id);
}

/** A family of text files below one directory of Claude Code's config (plans, skills, agents, commands). */
function claudeTextFamily(id: string, dir: string, retention: boolean, skip?: (rel: string) => boolean): SyncFamily {
  return {
    id,
    agent: 'claude',
    strategy: 'text',
    placement: 'everywhere',
    projectScoped: false,
    retention,
    root: () => path.join(claudeConfigDir(), dir),
    accepts: (name) => safeSyncName(name) && !skip?.(name),
    list: (ctx) => walkFiles(path.join(ctx.claude, dir), ctx.allowed, { skip, hash: true, known: (rel, size, mtime) => ctx.known(id, rel, size, mtime) }),
  };
}

registerSyncFamily({
  id: 'transcripts', agent: 'claude', strategy: 'append', placement: 'backup', projectScoped: true, retention: true,
  root: () => path.join(claudeConfigDir(), 'projects'),
  accepts: (name) => safeSyncName(name) && TRANSCRIPT_NAME.test(name),
  list: (ctx) => ctx.projects().flatMap((p) => p.transcripts),
});
registerSyncFamily({
  id: 'session-files', agent: 'claude', strategy: 'append', placement: 'backup', projectScoped: true, retention: true,
  root: () => path.join(claudeConfigDir(), 'projects'),
  accepts: (name) => safeSyncName(name) && SESSION_FILE_NAME.test(name),
  list: (ctx) => ctx.projects().flatMap((p) => p.sessionFiles),
});
registerSyncFamily({
  id: 'memory', agent: 'claude', strategy: 'text', placement: 'everywhere', projectScoped: true, retention: false,
  root: () => path.join(claudeConfigDir(), 'projects'),
  accepts: (name) => safeSyncName(name) && MEMORY_NAME.test(name),
  list: (ctx) => ctx.projects().flatMap((p) => p.memory),
});
// Claude Code sweeps old plans with the transcripts (its retention sweep), and leaves auto memory, skills, agents
// and commands alone. Skills it downloads from a claude.ai account (`skills/synced/`) are its to manage on each machine.
registerSyncFamily(claudeTextFamily('plans', 'plans', true));
registerSyncFamily(claudeTextFamily('skills', 'skills', false, (rel) => rel === 'synced' || rel.startsWith('synced/')));
registerSyncFamily(claudeTextFamily('agents', 'agents', false));
registerSyncFamily(claudeTextFamily('commands', 'commands', false));
registerSyncFamily({
  id: 'rollouts', agent: 'codex', strategy: 'append', placement: 'backup', projectScoped: false, retention: false,
  root: () => codexHome(),
  accepts: (name) => safeSyncName(name) && ROLLOUT_NAME.test(name),
  list: (ctx) => {
    const out: SyncFile[] = [];
    for (const top of ['sessions', 'archived_sessions']) {
      for (const f of walkFiles(path.join(ctx.codex, top), ctx.allowed, { depth: 4 })) {
        const name = `${top}/${f.name}`;
        if (!ROLLOUT_NAME.test(name)) continue;
        out.push({ ...f, name, cwd: headCwd(path.join(ctx.codex, name)) });
      }
    }
    return out;
  },
});

/** The name this machine's user goes by (its account, not the environment's USER), or null when it has none. */
export function localUserName(): string | null {
  try {
    const name = os.userInfo().username;
    if (name) return name;
  } catch {
    /* a uid with no account entry: fall back to what the login set */
  }
  return process.env.USER || process.env.LOGNAME || process.env.USERNAME || null;
}

/** `cleanupPeriodDays` from Claude Code's settings.json, and nothing else from it; null when it sets none (or none
 *  that is a number, or the file cannot be read). */
export function readCleanupPeriodDays(claude = claudeConfigDir()): number | null {
  try {
    const file = path.join(claude, 'settings.json');
    if (fs.statSync(file).size > 4 * 1024 * 1024) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.cleanupPeriodDays;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** The names of Codex's databases: listed, never opened, and the log and queue databases left out entirely. */
function codexSqliteNames(codex: string): string[] {
  try {
    return fs.readdirSync(codex).filter((n) => /\.sqlite$/.test(n) && !/^(?:logs|queue)_/.test(n)).sort();
  } catch {
    return [];
  }
}

/**
 * This machine's inventory, for a caller who runs as `user`. Anyone else (a lab machine under a shared account,
 * asked by one of its users) is refused before anything is read: the first thing done is to compare the names.
 */
export function syncInventory(opts: { user: string; now?: number }): SyncInventoryAnswer {
  const me = localUserName();
  if (!me || !opts.user || me !== opts.user) return { inventory: 1, shared: true };
  const claude = claudeConfigDir();
  const codex = codexHome();
  const home = os.homedir();
  const refuse = neverRead(claude, codex, home);
  // What sync recorded here (OAK's own store, only read): each pulled file's origin, each text file's past versions,
  // and the hashes of files unchanged since, which are not read again.
  const manifest = readManifest();
  const known = (family: string, name: string, size: number, mtime: number): string | undefined => {
    const rec = manifest.get(manifestKey(family, name));
    return rec && rec.size === size && rec.mtime === mtime ? rec.history?.[rec.history.length - 1] ?? rec.sha256 ?? undefined : undefined;
  };
  const stamp = (family: string, name: string, size: number, mtime: number): string | undefined => {
    const rec = manifest.get(manifestKey(family, name));
    return rec && rec.size === size && rec.mtime === mtime ? rec.stamp : undefined;
  };
  let scanned: ClaudeProjectScan[] | null = null;
  const ctx: SyncListContext = {
    claude,
    codex,
    home,
    projects: () => (scanned ??= scanClaudeProjects(claude, (real, from) => !refuse(real, from), known, (name) => !!manifest.get(manifestKey('transcripts', name))?.origin,
      (name) => manifest.get(manifestKey('transcripts', name))?.key ?? manifest.get(manifestKey('memory', name))?.key)),
    allowed: (real, from) => !refuse(real, from),
    known,
    stamp,
  };
  const families: Record<string, SyncFile[]> = {};
  // The simulator's sessions (`oak demo`) stay on the machine that ran them, which `oak demo --clean` then leaves with no
  // trace: none of their files is listed, so no machine pulls one, and no backup folder is written one.
  const { isDemoSession } = require('./demo') as typeof import('./demo');
  for (const f of syncFamilies()) {
    try {
      families[f.id] = f.list(ctx).filter((e) => !isDemoSession(sessionOf(f.id, e.name) ?? ''));
    } catch {
      families[f.id] = [];
    }
    for (const e of families[f.id]) {
      const rec = manifest.get(manifestKey(f.id, e.name));
      if (rec?.origin) {
        e.origin = rec.origin;
        if (rec.originName) e.originName = rec.originName;
      }
      if (f.strategy === 'text' && rec?.history?.length) e.history = rec.history;
    }
  }
  const projects = ctx.projects().map((p) => ({ folder: p.folder, cwd: p.cwd, own: p.own, ...(p.key ? { key: p.key } : {}) }));
  const shares = readMountTable();
  const identities: Record<string, SyncIdentity> = {};
  const cwds = new Set<string>([...projects.map((p) => p.cwd), ...(families.rollouts ?? []).map((r) => r.cwd)].filter((c): c is string => !!c));
  for (const cwd of cwds) identities[cwd] = identityKey(cwd, { home, shares });
  const settings = keptPrefs().sync ?? {};
  return {
    inventory: 1,
    at: opts.now ?? Date.now(),
    host: machineHostTag(),
    user: me,
    home,
    platform: process.platform,
    cleanupPeriodDays: readCleanupPeriodDays(claude),
    projects,
    identities,
    shares,
    families,
    codexSqlite: codexSqliteNames(codex),
    sync: {
      backup: settings.backup?.kind === 'machine' ? namesThisMachine(settings.backup.label) : false,
      placements: { ...(settings.families ?? {}) },
      excludeProjects: [...(settings.exclude?.projects ?? [])],
      cached: [...manifest.values()].filter((e) => e.cached).map((e) => `${e.family}/${e.name}`),
      hidden: [...hiddenSessions()],
      evicted: ownEvictedSessions(),
    },
    tombstones: readTombstones(),
  };
}

/** This machine's name in what sync prints: OAK_MACHINE_LABEL (a neutral name for captures), else its host name, as
 *  the terminal app names it. */
export const localSyncLabel = (): string => process.env.OAK_MACHINE_LABEL?.trim() || os.hostname();

/** Does `label` name this machine: its OAK_MACHINE_LABEL, or its host name, whole or before the first dot? How a
 *  machine knows that a backup setting names it. */
export function namesThisMachine(label: string): boolean {
  const l = label.toLowerCase();
  const host = os.hostname().toLowerCase();
  const own = process.env.OAK_MACHINE_LABEL?.trim().toLowerCase();
  return l === own || l === host || l === host.split('.')[0];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const SHA = /^[0-9a-f]{64}$/;
const HOST = /^[0-9a-f]{12}$/;
const STAMP = /^[\w:.-]{1,200}$/;
/** A session folder's generation (SyncFile.gen): 16 lower-case hex digits. */
export const SYNC_GEN = /^[0-9a-f]{16}$/;

/** An inventory read from another machine, checked field by field; null when it is not one. Entries a family does
 *  not accept (a path that leaves its root, a hidden or never-synced file, a name Windows cannot hold) are dropped
 *  here and counted. */
export function parseSyncInventory(text: string): { inventory: SyncInventoryAnswer; dropped: number } | null {
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.inventory !== SYNC_INVENTORY_VERSION) return null;
  if (o.shared === true) return { inventory: { inventory: 1, shared: true }, dropped: 0 };
  if (typeof o.host !== 'string' || !HOST.test(o.host) || typeof o.home !== 'string' || !isNum(o.at)) return null;
  let dropped = 0;
  const families: Record<string, SyncFile[]> = {};
  for (const fam of syncFamilies()) {
    const list = Array.isArray(o.families?.[fam.id]) ? o.families[fam.id] : [];
    const kept: SyncFile[] = [];
    for (const f of list) {
      if (!f || typeof f.name !== 'string' || !isNum(f.size) || !isNum(f.mtime) || !fam.accepts(f.name)) {
        dropped++;
        continue;
      }
      const e: SyncFile = { name: f.name, size: f.size, mtime: f.mtime };
      if (fam.strategy === 'text') e.sha256 = typeof f.sha256 === 'string' && SHA.test(f.sha256) ? f.sha256 : null;
      if (typeof f.cwd === 'string' && f.cwd) e.cwd = f.cwd;
      if (typeof f.origin === 'string' && HOST.test(f.origin)) {
        e.origin = f.origin;
        if (typeof f.originName === 'string' && fam.accepts(f.originName)) e.originName = f.originName;
      }
      if (fam.strategy === 'text' && Array.isArray(f.history)) {
        const h = f.history.filter((x: unknown): x is string => typeof x === 'string' && SHA.test(x)).slice(-64);
        if (h.length) e.history = h;
      }
      if (typeof f.stamp === 'string' && STAMP.test(f.stamp)) e.stamp = f.stamp;
      if (typeof f.gen === 'string' && SYNC_GEN.test(f.gen)) e.gen = f.gen;
      kept.push(e);
    }
    families[fam.id] = kept;
  }
  const projects: SyncProject[] = (Array.isArray(o.projects) ? o.projects : [])
    .filter((p: any) => p && typeof p.folder === 'string' && new RegExp(`^(?:${FOLDER})$`).test(p.folder))
    .map((p: any) => ({ folder: p.folder, cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : null, own: p.own !== false,
      ...(typeof p.key === 'string' && /^(?:git|home|share|path):/.test(p.key) ? { key: p.key } : {}) }));
  const identities: Record<string, SyncIdentity> = {};
  for (const [cwd, id] of Object.entries(o.identities && typeof o.identities === 'object' ? o.identities : {})) {
    const v = id as any;
    if (v && typeof v.key === 'string' && /^(?:git|home|share|path):/.test(v.key)) identities[cwd] = { key: v.key, ...(typeof v.root === 'string' ? { root: v.root } : {}) };
  }
  const shares: SyncShare[] = (Array.isArray(o.shares) ? o.shares : [])
    .filter((s: any) => s && ['server', 'share', 'mount', 'type'].every((k) => typeof s[k] === 'string'))
    .map((s: any) => ({ server: s.server, share: s.share, mount: s.mount, type: s.type }));
  const sy = o.sync && typeof o.sync === 'object' ? o.sync : null;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
  const placements: Record<string, SyncPlacement> = {};
  for (const [k, v] of Object.entries(sy?.placements && typeof sy.placements === 'object' ? sy.placements : {})) {
    if (SYNC_PLACEMENTS.includes(v as SyncPlacement)) placements[k] = v as SyncPlacement;
  }
  const tombstones: SyncTombstone[] = (Array.isArray(o.tombstones) ? o.tombstones : []).filter((t: any) => t && (t.kind === 'session' || t.kind === 'file')
    && typeof t.key === 'string' && typeof t.deleted === 'boolean' && isNum(t.at) && typeof t.host === 'string' && HOST.test(t.host)
    && (t.kind === 'file' || /^[A-Za-z0-9_-]+$/.test(t.key)))
    .map((t: any) => {
      const history = Array.isArray(t.history) ? t.history.filter((x: unknown): x is string => typeof x === 'string' && SHA.test(x)).slice(-64) : [];
      return { kind: t.kind, key: t.key, deleted: t.deleted, at: t.at, host: t.host, ...(typeof t.sha256 === 'string' && SHA.test(t.sha256) ? { sha256: t.sha256 } : {}),
        ...(t.kind === 'file' && history.length ? { history } : {}) };
    });
  return {
    dropped,
    inventory: {
      inventory: 1,
      at: o.at,
      host: o.host,
      user: typeof o.user === 'string' ? o.user : '',
      home: o.home,
      platform: typeof o.platform === 'string' ? o.platform : 'linux',
      cleanupPeriodDays: typeof o.cleanupPeriodDays === 'number' && Number.isFinite(o.cleanupPeriodDays) ? o.cleanupPeriodDays : null,
      projects,
      identities,
      shares,
      families,
      codexSqlite: (Array.isArray(o.codexSqlite) ? o.codexSqlite : []).filter((n: unknown) => typeof n === 'string'),
      ...(sy ? { sync: { backup: sy.backup === true, placements, excludeProjects: strings(sy.excludeProjects), cached: strings(sy.cached), hidden: strings(sy.hidden).filter((x) => /^[A-Za-z0-9_-]+$/.test(x)),
        evicted: (Array.isArray(sy.evicted) ? sy.evicted : []).filter((e: any) => e && typeof e.id === 'string' && isSafeSessionId(e.id) && isNum(e.at))
          .map((e: any) => ({ id: e.id, at: e.at })) } } : {}),
      tombstones,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------------------

/** Why a machine gave no inventory: `shared`, it runs under another user's account and refused; `disabled`, it is
 *  disabled in herdr and was not asked; `duplicate`, it is this machine or one already asked under another label;
 *  the rest as for the usage readings (machine-usage.ts MachineUsageStatus), with `not-inventory` for an answer
 *  that was not one. */
export type SyncMachineStatus = 'ok' | 'shared' | 'disabled' | 'excluded' | 'duplicate' | 'unreachable' | 'timeout' | 'no-oak' | 'old-oak' | 'not-inventory' | 'failed';

/** How a peer's command ended when it gave nothing usable. */
export type SyncAskFailure = { status: 'unreachable' | 'timeout' | 'no-oak' | 'old-oak' | 'failed'; detail?: string };

/** A running `__sync-fetch` (or a folder target's equivalent): what it prints, and how it ended. `stop` ends it early
 *  (a run past its time for the machine), so its stream ends and `done` settles. */
export interface SyncChannel {
  stream: AsyncIterable<Buffer>;
  done: Promise<SyncAskFailure | null>;
  stop?(): void;
}

/** One machine as sync asked it. */
export interface SyncNode {
  label: string;
  /** This machine. */
  local: boolean;
  status: SyncMachineStatus;
  detail?: string;
  inventory?: SyncInventory;
  /** Entries of its inventory dropped as not belonging to any family (a path outside the family's root, a name Windows
   *  cannot hold). */
  dropped?: number;
  /** Its ssh target, and how to run its fetch command with a request: the one way the engine reads its files. */
  target?: string;
  channel?: (request: string) => SyncChannel;
  /** This machine's role as the engine resolved it, over what its inventory says. */
  role?: { backup: boolean };
  /** Not a machine but a backup's copy of one (a backup folder, sync-folder.ts): it serves what it holds of that
   *  machine, plans nothing of its own, and is never asked for an inventory. From it this machine restores its own
   *  files and keeps current the copies it already holds, making no new one; it is never a source of text to merge. */
  passive?: boolean;
}

/** A file one machine would pull from another. `name` is the peer's, `to` this machine's (both relative to the
 *  family's root). `pull` extends or creates an append-only file; `copy` brings a text file this machine lacks, and
 *  `merge` one whose content differs. `bytes` is what would move. */
export interface SyncPlanItem {
  family: string;
  from: string;
  name: string;
  to: string;
  action: 'pull' | 'copy' | 'merge';
  reason: 'missing' | 'longer' | 'differs';
  bytes: number;
  size: number;
  localSize: number | null;
  /** Set for an append-only file this machine already has a shorter copy of: sizes alone are compared here, and the
   *  peer's copy must begin with this machine's bytes before its tail is pulled, which the pull verifies. */
  verify?: string;
  /** The machine whose file it is (machineHostTag): the one that made it, however many machines it passed through. */
  origin?: string;
  /** Its name there. */
  originName?: string;
  /** Its project has no place here, so it lands under the other machine's folder name, with why. */
  unmapped?: string;
  /** Its project's identity key, which the pull records for a folder whose files all come from other machines. */
  key?: string;
  /** A mirrored file's stamp on the machine it is pulled from (SyncFile.stamp), which the pull records. */
  stamp?: string;
}

/** A Claude project folder of a peer whose identity has no path on this machine, with the files this machine would pull
 *  of it. They land under the peer's own folder name (`lands`), where resuming one needs a checkout here, unless a
 *  folder of that name here holds another project, or the plan was asked to leave them out. */
export interface SyncUnmapped {
  from: string;
  folder: string;
  key: string | null;
  cwd: string | null;
  reason: string;
  lands: boolean;
  files: number;
  bytes: number;
}

/** A file whose copies look diverged, or that sits in an unexpected place here: never planned. */
export interface SyncDiverged {
  family: string;
  from: string;
  name: string;
  to: string;
  localSize: number;
  size: number;
  note: string;
}

export interface SyncTotals {
  files: number;
  bytes: number;
}

/** One machine's part of the plan: what it would pull from the others. */
export interface SyncPlanMachine {
  label: string;
  local: boolean;
  status: SyncMachineStatus;
  detail?: string;
  host?: string;
  /** A backup's copy of a machine (SyncNode.passive), which plans nothing. */
  passive?: true;
  /** The `cleanupPeriodDays` the plan applied, and whether that was Claude Code's default because none is set. */
  retentionDays?: number;
  retentionUnset?: boolean;
  /** It holds every machine's sessions, as the backup target. */
  backup?: boolean;
  pulls?: SyncPlanItem[];
  summary?: Record<string, SyncTotals>;
  /** What it would not pull, by why: older than its retention; another machine's session it holds only the index of
   *  (placement); deleted with `oak sessions --delete` somewhere; in a project it excludes; a family turned off; text
   *  too large to hash, which is neither merged nor copied. */
  skipped?: { retention: SyncTotals; placement: SyncTotals; deleted: SyncTotals; excluded: SyncTotals; off: SyncTotals; large: SyncTotals };
  unmapped?: SyncUnmapped[];
  diverged?: SyncDiverged[];
  warnings?: string[];
}

export interface SyncPlan {
  syncPlan: 1;
  /** When it was computed (epoch ms, this machine's clock). */
  at: number;
  /** A plan copies nothing; it shows what `oak sync now` would do. */
  dryRun: true;
  machines: SyncPlanMachine[];
}

/** How planSync reads the inventories. */
export interface SyncPlanOptions {
  /** A project folder with no place here lands under the other machine's folder name (SyncUnmapped.lands). */
  unmappedLands?: boolean;
  /** Each machine's own settings decide what it pulls: its placements (a session is held by the machine that made it,
   *  the backup target, and a machine that fetched it), its excluded projects, and the sessions deleted anywhere. */
  policy?: boolean;
  /** The sessions deleted, by id, in place of what the inventories say (the engine's merged tombstones). */
  deleted?: Set<string>;
}

/** The sessions deleted on any machine: the latest event for each among every inventory's tombstones, and a session
 *  a machine lists as deleted that no event names yet. Events dated too far ahead rank as a run records them
 *  (sync-engine.ts freshTombstones): one this machine recorded as made a day after it arrived by that record alone, one
 *  not recorded yet as made at most SYNC_TOMBSTONE_AHEAD_MS after `now`. */
export function deletedSessions(inventories: SyncInventory[], now = Date.now()): Set<string> {
  const id = (t: SyncTombstone, at: number): string => `${t.key}\0${at}\0${t.host}`;
  const recorded = new Set(inventories.flatMap((inv) => (inv.tombstones ?? []).flatMap((t) => (typeof t.sentAt === 'number' ? [id(t, t.sentAt)] : []))));
  const latest = new Map<string, SyncTombstone>();
  for (const inv of inventories) for (const t0 of inv.tombstones ?? []) {
    if (t0.kind !== 'session' || recorded.has(id(t0, t0.at))) continue;
    const t = { ...t0, at: Math.min(t0.at, now + SYNC_TOMBSTONE_AHEAD_MS) };
    const was = latest.get(t.key);
    if (!was || t.at > was.at || (t.at === was.at && t.host > was.host)) latest.set(t.key, t);
  }
  const out = new Set<string>();
  for (const [id, t] of latest) if (t.deleted) out.add(id);
  for (const inv of inventories) for (const id of inv.sync?.hidden ?? []) if (!latest.has(id)) out.add(id);
  return out;
}

/** The session a file belongs to: a transcript's or session file's id, or the id a rollout's name ends with. */
export function sessionOf(family: string, name: string): string | null {
  if (family === 'transcripts') return name.slice(name.indexOf('/') + 1, -'.jsonl'.length);
  if (family === 'session-files') return name.split('/')[1] ?? null;
  if (family === 'rollouts') return /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1] ?? null;
  return FAMILIES.get(family)?.session?.(name) ?? null;
}

/** Join a relative `/` path onto a directory of a machine of `platform`. */
function joinOn(platform: string, dir: string, rel: string): string {
  if (!rel || rel === '.') return dir;
  return platform === 'win32' ? path.win32.join(dir, ...rel.split('/')) : path.posix.join(dir, rel);
}

/** A git key's repository URL and the path below its main working tree. */
function splitGitKey(key: string): { url: string; sub: string } {
  const body = key.slice('git:'.length);
  const at = body.indexOf('//');
  return at < 0 ? { url: body, sub: '' } : { url: body.slice(0, at), sub: body.slice(at + 2) };
}

/** Where a peer's project folder lands on this machine: a local folder name, or why there is none. */
export type Landing = { folder: string; path: string | null } | { unmapped: string };

/**
 * Map peer project folders to this machine's (see the module comment of sync-identity.ts for the keys):
 * 1. a folder here whose working directory has the same key (of several, the one with the peer's own folder name);
 * 2. else a path derived from the key here: the home for `home:`, a checkout of the same repository known here (from
 *    a project folder or a Codex rollout) for `git:`, the same share mounted here for `share:`, and for `path:` the
 *    same absolute path, when a session here names it;
 * then the folder Claude Code gives that path. A folder whose working directory is unknown lands only in a folder of
 * the same name here.
 */
export function folderMapper(local: SyncInventory): (peer: SyncInventory, folder: string) => Landing {
  const folders = new Map(local.projects.map((p) => [p.folder, p]));
  const folderOfPath = new Map<string, string>();
  for (const p of local.projects) if (p.cwd) folderOfPath.set(p.cwd, p.folder);
  // Where this machine's own sessions ran says where its checkouts are; a copy pulled from another machine names that
  // machine's paths, and says nothing of this one's. A folder sync made for a project still takes more of its files.
  const own = new Set<string>([
    ...local.projects.filter((p) => p.cwd && p.own !== false).map((p) => p.cwd!),
    ...(local.families.rollouts ?? []).filter((r) => r.cwd && !r.origin).map((r) => r.cwd!),
  ]);
  const byKey = new Map<string, Set<string>>();
  const gitRoots = new Map<string, Set<string>>();
  for (const [cwd, id] of Object.entries(local.identities)) {
    if (!own.has(cwd) && !folderOfPath.has(cwd)) continue;
    if (!byKey.has(id.key)) byKey.set(id.key, new Set());
    byKey.get(id.key)!.add(cwd);
    if (own.has(cwd) && id.key.startsWith('git:') && id.root) {
      const { url } = splitGitKey(id.key);
      if (!gitRoots.has(url)) gitRoots.set(url, new Set());
      gitRoots.get(url)!.add(id.root);
    }
  }
  const folderFor = (p: string): string => folderOfPath.get(p) ?? mangleCwd(p);
  /** One path of several: the only one of this machine's own, else the one that gives the peer's own folder name,
   *  else none. */
  const pick = (paths: string[], peerFolder: string): string | null => {
    if (paths.length === 1) return paths[0];
    const mine = paths.filter((p) => own.has(p));
    return mine.length === 1 ? mine[0] : paths.find((p) => folderFor(p) === peerFolder) ?? null;
  };
  return (peer, peerFolder) => {
    const proj = peer.projects.find((p) => p.folder === peerFolder);
    const cwd = proj?.cwd ?? null;
    const key = cwd ? peer.identities[cwd]?.key ?? null : proj?.key ?? null;
    if (!key) return folders.has(peerFolder) ? { folder: peerFolder, path: folders.get(peerFolder)!.cwd } : { unmapped: 'no working directory is recorded for it' };
    const same = [...(byKey.get(key) ?? [])];
    // A folder here whose files all came from other machines, under this identity.
    const filled = local.projects.filter((p) => !p.cwd && p.key === key).map((p) => p.folder);
    if (same.length + filled.length) {
      if (!same.length) return filled.length === 1 || filled.includes(peerFolder) ? { folder: filled.includes(peerFolder) ? peerFolder : filled[0], path: null } : { unmapped: `${filled.length} folders here have this identity` };
      const p = pick(same, peerFolder);
      return p ? { folder: folderFor(p), path: p } : { unmapped: `${same.length} folders here have this identity` };
    }
    let derived: string | null = null;
    if (key.startsWith('home:')) {
      const rel = key.slice('home:'.length);
      derived = joinOn(local.platform, local.home, rel === '.' ? '' : rel);
    } else if (key.startsWith('git:')) {
      const { url, sub } = splitGitKey(key);
      const roots = [...(gitRoots.get(url) ?? [])];
      if (!roots.length) return { unmapped: 'no checkout of its repository is known here' };
      const candidates = roots.map((r) => joinOn(local.platform, r, sub));
      derived = pick(candidates, peerFolder);
      if (!derived) return { unmapped: `${roots.length} checkouts of its repository are known here` };
    } else if (key.startsWith('share:')) {
      const rest = key.slice('share:'.length);
      let best: SyncShare | null = null;
      for (const s of local.shares) {
        const at = `${s.server}/${s.share}`;
        if ((rest === at || rest.startsWith(`${at}/`)) && (!best || s.share.length > best.share.length)) best = s;
      }
      if (!best) return { unmapped: 'its network share is not mounted here' };
      derived = joinOn(local.platform, best.mount, rest.slice(`${best.server}/${best.share}`.length + 1));
    } else if (key.startsWith('path:')) {
      const abs = key.slice('path:'.length);
      if (!own.has(abs)) return { unmapped: 'its path is not known here' };
      derived = abs;
    }
    if (!derived) return { unmapped: 'its identity is not one this machine can place' };
    return { folder: folderFor(derived), path: derived };
  };
}

const DAY_MS = 86_400_000;

/**
 * For each inventoried machine, what it would pull from the others (see SyncPlanMachine). Sizes are compared and
 * nothing is hashed: an append-only file this machine holds a shorter copy of is planned with `verify: 'prefix'`.
 * A file older than this machine's own retention (`cleanupPeriodDays`, Claude Code's 30 days when unset) is never
 * planned, since Claude Code here would delete it and the next sync would bring it back. Where several machines hold
 * a longer copy of one file, the longest is planned; identical text from several, once. A session already here,
 * in whatever project folder, is extended where it is: one session is never two files here.
 */
export function planSync(nodes: SyncNode[], now = Date.now(), opts: SyncPlanOptions = {}): SyncPlan {
  const live = nodes.filter((n): n is SyncNode & { inventory: SyncInventory } => n.status === 'ok' && !!n.inventory);
  const deleted = opts.deleted ?? (opts.policy ? deletedSessions(live.map((n) => n.inventory), now) : new Set<string>());
  const machines: SyncPlanMachine[] = [];
  for (const node of nodes) {
    if (node.status !== 'ok' || !node.inventory || node.passive) {
      machines.push({ label: node.label, local: node.local, status: node.status, ...(node.detail ? { detail: node.detail } : {}),
        ...(node.passive && node.inventory ? { host: node.inventory.host, passive: true as const } : {}) });
      continue;
    }
    const me = node.inventory;
    const warnings: string[] = [];
    const retentionUnset = me.cleanupPeriodDays === null;
    const retentionDays = me.cleanupPeriodDays ?? CLAUDE_DEFAULT_RETENTION_DAYS;
    if (node.local && nodes.length === 1) warnings.push('there is no saved machine to sync with: `oak machine add <label> <ssh-target>` saves one');
    if (retentionUnset) warnings.push(`cleanupPeriodDays is not set on ${node.label}, so Claude Code there keeps transcripts and plans ${CLAUDE_DEFAULT_RETENTION_DAYS} days; older ones are not planned`);
    const cutoff = now - retentionDays * DAY_MS;
    const policy = opts.policy ? {
      placements: me.sync?.placements ?? {},
      backup: node.role?.backup ?? me.sync?.backup ?? false,
      cached: new Set(me.sync?.cached ?? []),
      excluded: me.sync?.excludeProjects ?? [],
    } : null;
    const mapFolder = folderMapper(me);
    const localFiles = new Map<string, Map<string, SyncFile>>();
    for (const fam of syncFamilies()) localFiles.set(fam.id, new Map((me.families[fam.id] ?? []).map((f) => [f.name, f])));
    const meProjects = new Map(me.projects.map((p) => [p.folder, p]));
    const localKey = (folder: string): string | null => {
      const proj = meProjects.get(folder);
      return proj?.cwd ? me.identities[proj.cwd]?.key ?? null : proj?.key ?? null;
    };
    // A session's transcript, and a rollout, wherever they are here: a session already here is extended where it is.
    const sessionsHere = new Map<string, string>();
    for (const t of me.families.transcripts ?? []) sessionsHere.set(t.name.slice(t.name.indexOf('/') + 1), t.name);
    const rolloutsHere = new Map<string, string>();
    for (const r of me.families.rollouts ?? []) rolloutsHere.set(r.name.slice(r.name.lastIndexOf('/') + 1), r.name);
    const best = new Map<string, SyncPlanItem>();
    /** Text files missing here that a plan item already brings. */
    const copies = new Set<string>();
    /** The time of each mirrored file's planned copy. */
    const newest = new Map<string, number>();
    const diverged: SyncDiverged[] = [];
    const unmapped = new Map<string, SyncUnmapped>();
    const zero = (): SyncTotals => ({ files: 0, bytes: 0 });
    const skipped = { retention: zero(), placement: zero(), deleted: zero(), excluded: zero(), off: zero(), large: zero() };
    const skip = (why: keyof typeof skipped, e: SyncFile): void => {
      skipped[why].files++;
      skipped[why].bytes += e.size;
    };
    for (const peer of live) {
      if (peer === node) continue;
      const them = peer.inventory;
      const landings = new Map<string, Landing>();
      const landing = (folder: string): Landing => {
        let l = landings.get(folder);
        if (!l) landings.set(folder, (l = mapFolder(them, folder)));
        return l;
      };
      const parentMtime = new Map((them.families.transcripts ?? []).map((t) => [t.name.slice(0, -'.jsonl'.length), t.mtime]));
      const themProjects = new Map(them.projects.map((p) => [p.folder, p]));
      const projectKey = (fam: SyncFamily, e: SyncFile): string | null => {
        if (fam.projectScoped) {
          const folder = e.name.slice(0, e.name.indexOf('/'));
          const proj = themProjects.get(folder);
          return proj?.cwd ? them.identities[proj.cwd]?.key ?? null : proj?.key ?? null;
        }
        return e.cwd ? them.identities[e.cwd]?.key ?? null : null;
      };
      for (const fam of syncFamilies()) {
        const placement = policy ? policy.placements[fam.id] ?? fam.placement : 'everywhere';
        for (const e of them.families[fam.id] ?? []) {
          if (!fam.accepts(e.name)) continue;
          if (placement === 'off') {
            skip('off', e);
            continue;
          }
          const session = sessionOf(fam.id, e.name);
          if (session && deleted.has(session)) {
            skip('deleted', e);
            continue;
          }
          if (policy?.excluded.length) {
            const key = projectKey(fam, e);
            if (key && policy.excluded.some((x) => key === x || key.startsWith(`${x}/`))) {
              skip('excluded', e);
              continue;
            }
          }
          let to = e.name;
          /** Its project has no place here: counted below, once the file is one this machine would pull. */
          let lost: { k: string; u: SyncUnmapped } | null = null;
          if (fam.target) {
            const t = fam.target(e, { host: them.host, label: peer.label, origin: e.origin ?? them.host, me: me.host });
            if (t === null) continue;
            to = t;
          } else if (fam.projectScoped) {
            const folder = e.name.slice(0, e.name.indexOf('/'));
            const l = landing(folder);
            if ('unmapped' in l) {
              const proj = themProjects.get(folder);
              const key = projectKey(fam, e);
              // Under the peer's folder name, unless a folder of that name here is another project.
              const taken = key !== null && localKey(folder) !== null && localKey(folder) !== key;
              const lands = !!opts.unmappedLands && !taken;
              const k = `${peer.label}\0${folder}`;
              lost = { k, u: unmapped.get(k) ?? { from: peer.label, folder, key, cwd: proj?.cwd ?? null, reason: taken ? 'another project has a folder of that name here' : l.unmapped, lands, files: 0, bytes: 0 } };
            } else to = `${l.folder}${e.name.slice(folder.length)}`;
          }
          // This machine's own file comes back where it was; and one session is one file here: extended where it is.
          const ownName = (e.origin ?? them.host) === me.host ? e.originName : undefined;
          if (ownName && fam.accepts(ownName)) to = ownName;
          else if (fam.id === 'transcripts') to = sessionsHere.get(e.name.slice(e.name.indexOf('/') + 1)) ?? to;
          else if (fam.id === 'session-files' && session) {
            const t = sessionsHere.get(`${session}.jsonl`);
            if (t) to = `${t.slice(0, t.indexOf('/'))}${e.name.slice(e.name.indexOf('/'))}`;
          } else if (fam.id === 'rollouts') to = rolloutsHere.get(e.name.slice(e.name.lastIndexOf('/') + 1)) ?? to;
          if (!fam.accepts(to)) continue;
          const files = localFiles.get(fam.id)!;
          const here = files.get(to);
          // A backup's copy of another machine keeps current what this machine already holds of it, and makes no new
          // copy: what this machine holds of others comes from them (`oak sync fetch` excepted).
          if (peer.passive && !here && (e.origin ?? them.host) !== me.host) continue;
          // A session's files are held by the machine that made them, the backup, a machine that fetched them, and
          // any machine that already has a copy, which is kept current rather than left to diverge when resumed.
          if (policy && fam.strategy !== 'text' && placement !== 'everywhere') {
            const origin = e.origin ?? them.host;
            const keep = origin === me.host || !!here || policy.cached.has(`${fam.id}/${to}`) || (placement === 'backup' && policy.backup);
            if (!keep) {
              skip('placement', e);
              continue;
            }
          }
          if (fam.retention) {
            // Claude Code removes a session's folder with its transcript, so a session's files age with it.
            const parent = fam.id === 'session-files' ? e.name.split('/').slice(0, 2).join('/') : null;
            const age = (parent !== null ? parentMtime.get(parent) : undefined) ?? e.mtime;
            if (age < cutoff) {
              skip('retention', e);
              continue;
            }
          }
          // A project with no place here is named for what this machine would pull of it, and lands, if at all, under the
          // other machine's folder name; a session this machine keeps only the index of is no file that lands.
          if (lost) {
            lost.u.files++;
            lost.u.bytes += e.size;
            unmapped.set(lost.k, lost.u);
            if (!lost.u.lands) continue;
          }
          const lostReason = lost?.u.reason;
          const origin = e.origin ?? them.host;
          const pkey = fam.projectScoped ? projectKey(fam, e) : null;
          const originName = e.origin ? e.originName : e.name;
          const extra = { origin, ...(originName ? { originName } : {}), ...(lostReason && !ownName ? { unmapped: lostReason } : {}), ...(pkey ? { key: pkey } : {}), ...(e.stamp ? { stamp: e.stamp } : {}) };
          let item: SyncPlanItem | null = null;
          if (fam.wants || fam.strategy === 'mirror') {
            // Mirrored whole: whenever its size, time or hash differs from the copy here.
            const want = fam.wants ? fam.wants(here, e) : !here || here.size !== e.size || here.mtime !== e.mtime || (!!e.sha256 && here.sha256 !== e.sha256);
            if (want) {
              item = { family: fam.id, from: peer.label, name: e.name, to, action: 'pull', reason: here ? 'differs' : 'missing', bytes: e.size, size: e.size, localSize: here?.size ?? null, ...extra };
              // Of several machines' copies, the newest.
              const k = `${fam.id}\0${to}`;
              if (!best.has(k) || e.mtime > (newest.get(k) ?? 0)) {
                best.set(k, item);
                newest.set(k, e.mtime);
              }
            }
            continue;
          }
          if (fam.strategy === 'text') {
            // A backup's copy is never text to merge: it only puts back a file of this machine's own that is gone here.
            if (peer.passive && (here || origin !== me.host)) continue;
            // Text too large to hash (SYNC_HASH_MAX_BYTES) is neither merged nor copied: no read is unbounded.
            if (!e.sha256 || (here && !here.sha256)) {
              skip('large', e);
              continue;
            }
            const k = `${fam.id}\0${to}\0${e.sha256}`;
            if (best.has(k)) continue; // the same text from another machine
            // Missing here, the first version is copied and any other is merged into it.
            const copied = !here && copies.has(`${fam.id}\0${to}`);
            if (!here && !copied) item = { family: fam.id, from: peer.label, name: e.name, to, action: 'copy', reason: 'missing', bytes: e.size, size: e.size, localSize: null, ...extra };
            else if (copied || here!.sha256 !== e.sha256 || (here!.sha256 === null && here!.size !== e.size)) {
              item = { family: fam.id, from: peer.label, name: e.name, to, action: 'merge', reason: 'differs', bytes: e.size, size: e.size, localSize: here?.size ?? null, ...extra };
            }
            if (item) {
              best.set(k, item);
              copies.add(`${fam.id}\0${to}`);
            }
            continue;
          }
          if (!here) item = { family: fam.id, from: peer.label, name: e.name, to, action: 'pull', reason: 'missing', bytes: e.size, size: e.size, localSize: null, ...extra };
          else if (here.size < e.size) {
            item = { family: fam.id, from: peer.label, name: e.name, to, action: 'pull', reason: 'longer', bytes: e.size - here.size, size: e.size, localSize: here.size, verify: 'prefix', ...extra };
          } else if (here.size > e.size && !peer.passive) {
            diverged.push({ family: fam.id, from: peer.label, name: e.name, to, localSize: here.size, size: e.size,
              note: 'the copy here is larger: the peer would pull from it, unless the two have diverged, which only comparing their bytes shows' });
          }
          if (item) {
            const k = `${fam.id}\0${to}`;
            const was = best.get(k);
            if (!was || item.size > was.size) best.set(k, item);
          }
        }
      }
    }
    const pulls = [...best.values()].sort((a, b) => (a.family === b.family ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.family < b.family ? -1 : 1));
    const summary: Record<string, SyncTotals> = {};
    for (const fam of syncFamilies()) summary[fam.id] = { files: 0, bytes: 0 };
    for (const p of pulls) {
      summary[p.family].files++;
      summary[p.family].bytes += p.bytes;
    }
    const lost = [...unmapped.values()];
    const stay = lost.filter((u) => !u.lands).length;
    if (stay) warnings.push(`${stay} project folder${stay === 1 ? '' : 's'} on other machines ${stay === 1 ? 'has' : 'have'} no place on ${node.label}; ${stay === 1 ? 'its' : 'their'} files are not planned`);
    for (const peer of live) if (peer !== node && peer.dropped) warnings.push(`${peer.dropped} entr${peer.dropped === 1 ? 'y' : 'ies'} in ${peer.label}'s inventory named no file a family holds, or a name Windows cannot hold, and ${peer.dropped === 1 ? 'was' : 'were'} ignored`);
    machines.push({
      label: node.label,
      local: node.local,
      status: 'ok',
      host: me.host,
      retentionDays,
      retentionUnset,
      ...(policy ? { backup: policy.backup } : {}),
      pulls,
      summary,
      skipped,
      unmapped: lost.sort((a, b) => (a.from === b.from ? (a.folder < b.folder ? -1 : 1) : a.from < b.from ? -1 : 1)),
      diverged,
      warnings,
    });
  }
  return { syncPlan: 1, at: now, dryRun: true, machines };
}
