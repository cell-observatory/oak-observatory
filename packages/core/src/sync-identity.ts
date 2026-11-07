/**
 * Project identity across machines, for oak sync.
 *
 * Claude Code names a project folder after the absolute path its sessions started in, so one repository is
 * `-home-you-src-app` on Linux and `-Users-you-src-app` on a Mac, and a share mounted at `/groups/lab` on one
 * machine is `/Volumes/lab` on another. Sync needs a name for "the same project" that does not depend on where
 * each machine keeps it. A working directory's identity key is, in this order:
 *
 * - `git:<host>/<path>`: the normalized origin URL of the git repository that holds it (scp-like and URL forms
 *   alike, the host lower-cased, credentials, port and `.git` dropped), followed by `//<path>` when the directory
 *   lies below the repository's main working tree. Read from the files git writes, never by running git, and only
 *   for a directory that exists on that machine: a deleted worktree inside a repository is not that repository.
 * - `home:<path>`: its path relative to the home directory (`home:.` for the home itself).
 * - `share:<server>/<share>/<path>`: a CIFS, SMB or NFS share found in the mount table, with the path inside it.
 * - `path:<absolute>`: none of the above.
 *
 * Home comes before share on purpose: a home directory that is itself an NFS export would otherwise give every
 * session there a share key, which a Mac with a local home could never match.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnToolSync } from './spawn';

/** A network file system this machine has mounted. `share` is the path on the server, without slashes at its ends. */
export interface SyncShare {
  server: string;
  share: string;
  mount: string;
  type: string;
}

/** What a working directory is, as sync names it. `root` is the main working tree of a git key's repository. */
export interface SyncIdentity {
  key: string;
  root?: string;
}

/** The file systems whose mounts name a share another machine can mount too. */
const NETWORK_TYPES = new Set(['cifs', 'smb3', 'smbfs', 'nfs', 'nfs4']);

/**
 * The origin URL as an identity: `<host>/<path>`, or null for one that names no server (a local path, which means
 * nothing on another machine). `git@github.com:Org/App.git`, `https://user:token@GitHub.com/Org/App` and
 * `ssh://git@github.com:22/Org/App.git/` are all `github.com/Org/App`. The path keeps its case: hosts other than
 * GitHub tell `App` from `app`.
 */
export function normalizeGitUrl(raw: string): string | null {
  // A query or fragment runs from the first `?` or `#` after the last line break. Found by search, since a pattern
  // for it backtracked quadratically on a long run of `#`.
  const text = raw.trim();
  const lastLine = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'), text.lastIndexOf('\u2028'), text.lastIndexOf('\u2029')) + 1;
  const query = text.slice(lastLine).search(/[?#]/);
  const url = query < 0 ? text : text.slice(0, lastLine + query);
  if (!url) return null;
  let host: string;
  let rest: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    if (scheme[1].toLowerCase() === 'file') return null;
    const body = url.slice(scheme[0].length);
    const slash = body.indexOf('/');
    const authority = slash < 0 ? body : body.slice(0, slash);
    rest = slash < 0 ? '' : body.slice(slash + 1);
    // user[:password]@host[:port]: the credentials and the port are how one person reaches it, not what it is. An
    // IPv6 host is bracketed, and its own colons are not a port.
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const v6 = /^\[([^\]]*)\]/.exec(hostPort);
    host = v6 ? v6[1] : hostPort.replace(/:\d*$/, '');
  } else {
    // scp-like `[user@]host:path`. A single letter before the colon is a Windows drive, which git reads as a path.
    const scp = /^(?:[^@/]+@)?([^:/]{2,}|\[[^\]]+\]):(.*)$/.exec(url);
    if (!scp) return null;
    host = scp[1].replace(/^\[|\]$/g, '');
    rest = scp[2];
  }
  host = host.toLowerCase();
  rest = rest.replace(/\/+/g, '/').replace(/^\/|\/$/g, '').replace(/\.git$/i, '').replace(/\/$/, '');
  if (!host || !rest) return null;
  return `${host}/${rest}`;
}

/** `[remote "origin"] url` from a git config file's text: the first one, with git's quoting and comments read. */
export function originUrlFromConfig(text: string): string | null {
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      // Section names are case-insensitive; a subsection (the remote's name) is not.
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin';
      continue;
    }
    if (!inOrigin) continue;
    // After `=`, white space is the gap and the value starts at its first other character: a value that could
    // start inside the gap backtracked quadratically on a long run of tabs.
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(\S.*|)$/.exec(line);
    if (!kv || kv[1].toLowerCase() !== 'url') continue;
    let value = '';
    let quoted = false;
    const v = kv[2];
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (ch === '\\' && i + 1 < v.length) {
        const next = v[++i];
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      } else if (ch === '"') quoted = !quoted;
      else if (!quoted && (ch === '#' || ch === ';')) break;
      else value += ch;
    }
    value = value.trim();
    if (value) return value;
  }
  return null;
}

/** Read at most `max` bytes of a small file as text, or null. */
function readSmall(file: string, max = 1024 * 1024): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The git identity of an existing directory: its origin URL (normalized), the repository's main working tree,
 * and the directory's path below it. Linked worktrees answer for their repository, with their own path below the
 * main working tree (`.claude/worktrees/x`); a worktree outside it, a submodule or a bare repository's worktree
 * answers relative to its own top. Null outside a repository, for a repository without an origin, and for a
 * directory that does not exist here.
 */
export function gitIdentity(cwd: string): { url: string; root: string; sub: string; worktreeRoot: string } | null {
  let real: string;
  try {
    real = fs.realpathSync.native(cwd);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null; // not on this machine: never identified by a repository that happens to contain its path
  }
  let top = real;
  let dotgit: fs.Stats | null = null;
  for (;;) {
    try {
      dotgit = fs.statSync(path.join(top, '.git'));
      break;
    } catch {
      const up = path.dirname(top);
      if (up === top) return null;
      top = up;
    }
  }
  let gitDir = path.join(top, '.git');
  if (!dotgit.isDirectory()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readSmall(gitDir, 64 * 1024) ?? '');
    if (!pointer) return null;
    gitDir = path.resolve(top, pointer[1].trim());
  }
  // A linked worktree's admin directory names the repository's own git directory in `commondir`.
  const common = readSmall(path.join(gitDir, 'commondir'), 64 * 1024)?.trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  const config = readSmall(path.join(commonDir, 'config'));
  const origin = config === null ? null : originUrlFromConfig(config);
  const url = origin === null ? null : normalizeGitUrl(origin);
  if (!url) return null;
  let realRoot = top;
  if (path.basename(commonDir) === '.git') {
    try {
      const main = fs.realpathSync.native(path.dirname(commonDir));
      const below = path.relative(main, real);
      if (!below.startsWith('..') && !path.isAbsolute(below)) realRoot = main;
    } catch {
      /* the main working tree is gone: the worktree answers for itself */
    }
  }
  const sub = path.relative(realRoot, real).split(path.sep).join('/');
  // The root as the session's own path spells it (a home reached through a symlink stays `/home/you`), since a
  // path derived from it must name the project folder Claude Code would: its real path only when the two differ
  // inside the repository.
  const logical = path.resolve(cwd);
  const tail = sub ? path.sep + sub.split('/').join(path.sep) : '';
  const root = !tail ? logical : logical.endsWith(tail) ? logical.slice(0, -tail.length) : realRoot;
  const worktreeTail = path.relative(top, real);
  const worktreeRoot = worktreeTail && logical.endsWith(path.sep + worktreeTail) ? logical.slice(0, -worktreeTail.length - 1) : worktreeTail ? top : logical;
  return { url, root, sub, worktreeRoot };
}

/** File paths use the current worktree's root, even when sync groups a nested worktree below the main checkout. */
export function fileProjectIdentity(cwd: string, ctx: Parameters<typeof identityKey>[1]): SyncIdentity {
  const git = gitIdentity(cwd);
  return git ? { key: `git:${git.url}${git.sub ? `//${git.sub}` : ''}`, root: git.worktreeRoot } : identityKey(cwd, ctx);
}

/** Undo the octal escapes the kernel writes into /proc/mounts (`\040` for a space). */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

/** A mount's source as a server and the share on it, or null for one that names no server. */
function shareOf(source: string, type: string): { server: string; share: string } | null {
  if (type === 'nfs' || type === 'nfs4') {
    const m = /^(\[[^\]]+\]|[^:]+):(.*)$/.exec(source);
    if (!m) return null;
    const share = m[2].replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return { server: m[1].replace(/^\[|\]$/g, '').toLowerCase(), share };
  }
  const m = /^(?:\/\/|\\\\)([^/\\]+)[/\\](.*)$/.exec(source);
  if (!m) return null;
  // macOS writes `//user@server/share` (and `//domain;user@server/share`), with percent escapes in the share.
  const server = m[1].slice(m[1].lastIndexOf('@') + 1).toLowerCase();
  let share = m[2].replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (type === 'smbfs') {
    try {
      share = decodeURIComponent(share);
    } catch {
      /* not percent-encoded after all */
    }
  }
  return server && share ? { server, share } : null;
}

/**
 * The network shares in a mount table: Linux's /proc/mounts (`source mountpoint type options 0 0`), or what
 * macOS's `mount` prints (`source on mountpoint (type, options)`).
 */
export function parseMountTable(text: string, format: 'linux' | 'mac'): SyncShare[] {
  const out: SyncShare[] = [];
  for (const line of text.split('\n')) {
    let source: string, mount: string, type: string;
    if (format === 'linux') {
      const f = line.trim().split(/\s+/);
      if (f.length < 3) continue;
      [source, mount, type] = [unescapeMount(f[0]), unescapeMount(f[1]), f[2]];
    } else {
      // The source runs to the first ` on ` after its first character. A source that could also run to a later one
      // backtracked quadratically on a line with many.
      const m = /^(.(?:(?! on ).)*) on (.+) \(([A-Za-z0-9]+)[,)]/.exec(line.trim());
      if (!m) continue;
      [source, mount, type] = [m[1], m[2], m[3]];
    }
    type = type.toLowerCase();
    if (!NETWORK_TYPES.has(type)) continue;
    const s = shareOf(source, type);
    // A trailing separator is dropped. The look-behind lets the match start only at the first of a run, which keeps it linear.
    if (s && mount.startsWith('/')) out.push({ ...s, mount: mount.length > 1 ? mount.replace(/(?<!\/)\/+$/, '') : mount, type });
  }
  return out;
}

/** This machine's network shares: /proc/mounts on Linux, `mount` on macOS (bounded to 5 s), none elsewhere. */
export function readMountTable(platform: NodeJS.Platform = process.platform): SyncShare[] {
  try {
    if (platform === 'linux') return parseMountTable(fs.readFileSync('/proc/mounts', 'utf8'), 'linux');
    if (platform === 'darwin') {
      const r = spawnToolSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5000, direct: true });
      return r.status === 0 ? parseMountTable(String(r.stdout), 'mac') : [];
    }
  } catch {
    /* no mount table to read: no shares */
  }
  return [];
}

/** `a` is `b` or lies below it, compared as the strings a machine reported (its own separator). */
function within(a: string, b: string, sep: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * The identity key of a working directory on THIS machine (see the module comment): git for an existing
 * directory in a repository with an origin, else its path under `home`, else a network share in `shares`,
 * else the absolute path.
 */
export function identityKey(cwd: string, ctx: { home: string; shares: readonly SyncShare[]; sep?: string }): SyncIdentity {
  const sep = ctx.sep ?? path.sep;
  const git = gitIdentity(cwd);
  if (git) return { key: `git:${git.url}${git.sub ? `//${git.sub}` : ''}`, root: git.root };
  // A trailing separator is dropped. The look-behind lets the match start only at the first of a run, which keeps it linear.
  const home = ctx.home.length > 1 ? ctx.home.replace(/(?<![\\/])[\\/]+$/, '') : ctx.home;
  if (home && within(cwd, home, sep)) {
    const rel = cwd.slice(home.length).split(sep).filter(Boolean).join('/');
    return { key: `home:${rel || '.'}` };
  }
  const unc = /^\\\\([^\\]+)\\([^\\]+)((?:\\.*)?)$/.exec(cwd);
  if (unc) {
    const rel = unc[3].split('\\').filter(Boolean).join('/');
    return { key: `share:${unc[1].toLowerCase()}/${unc[2]}${rel ? `/${rel}` : ''}` };
  }
  let best: SyncShare | null = null;
  for (const s of ctx.shares) if (within(cwd, s.mount, '/') && (!best || s.mount.length > best.mount.length)) best = s;
  if (best) {
    const rel = cwd.slice(best.mount.length).split('/').filter(Boolean).join('/');
    return { key: `share:${best.server}/${best.share}${rel ? `/${rel}` : ''}` };
  }
  return { key: `path:${cwd}` };
}
