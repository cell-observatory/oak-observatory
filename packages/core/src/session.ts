/**
 * Resolve the active Claude Code session id for a given working directory.
 *
 * Claude Code stores per-project transcripts at ~/.claude/projects/<mangled-cwd>/<session_id>.jsonl
 * where <mangled-cwd> is the ABSOLUTE launch cwd with every non-alphanumeric char replaced by '-'.
 * Verified: /Users/dev/Github -> -Users-dev-Github  (leading '/' becomes a leading '-').
 *
 * The newest .jsonl in that dir that holds a real conversation (see hasAssistantRecord) is the
 * current session. Capture never needs this (the hook payload supplies session_id directly) — it
 * exists for the CLI and the VS Code sidebar.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { createHash } from 'crypto';
import { claudeConfigDir, canonPath } from './paths';

/**
 * How recently a session's transcript must have moved for it to count as MID-FLIGHT. Shared by both
 * editors so neither can decide on its own what "the user is busy" means: interrupting a live Claude
 * session with an unsolicited offer is the one thing a first-run prompt must never do.
 */
export const SESSION_BUSY_MS = 5 * 60_000;

/** Claude Code caps a project dir name at this many characters (2.1.x). */
const SLUG_MAX = 200;

/**
 * Mangle an absolute path the same way Claude Code names its project dirs: every non-alphanumeric char
 * becomes '-', and a name longer than SLUG_MAX keeps its first SLUG_MAX chars plus `-` and a base-36
 * hash of the path (Claude Code 2.1.x: `Math.abs(<31-multiplier string hash>).toString(36)`).
 */
export function mangleCwd(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= SLUG_MAX) return slug;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${slug.slice(0, SLUG_MAX)}-${Math.abs(hash).toString(36)}`;
}

/** Whether `folder` is the project dir name Claude Code gives `cwd`. A shortened name is matched on its
 *  kept prefix and accepts any hash, so a build that hashes differently is not taken for a mirror. */
function namesProject(folder: string, cwd: string): boolean {
  const slug = mangleCwd(cwd);
  if (slug.length <= SLUG_MAX) return folder === slug;
  return folder.length > SLUG_MAX + 1 && folder.startsWith(slug.slice(0, SLUG_MAX + 1)) && /^[0-9a-z]+$/.test(folder.slice(SLUG_MAX + 1));
}

// projectDir (and everything built on it: resolveSessionId, findTranscript, the store) resolves
// under claudeConfigDir(), the same CLAUDE_CONFIG_DIR-aware base that stats.transcriptFiles and
// usageLine use — so relocating the config dir (e.g. onto a mounted devcontainer volume) moves
// session resolution, the store, and usage together instead of splitting them across two roots.
export function projectDir(cwd: string): string {
  return path.join(claudeConfigDir(), 'projects', mangleCwd(cwd));
}

/**
 * Newest REAL session id in a specific project dir, or null if none / the dir doesn't exist.
 * Local commands (/effort, /model), interrupted commands, and bridge-session records write
 * transcript .jsonl files that never gain an assistant record; those stubs must not win the
 * newest-mtime race over the real session (they often carry a real cwd line, so the fleet.ts
 * firstCwdLine guard cannot screen them). When NO candidate has an assistant record yet (a
 * brand-new project whose first turn is still in flight), fall back to the newest as before.
 */
function newestSessionIn(dir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates: { id: string; mtime: number; file: string }[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (isMirroredTranscript(file).mirrored || isBridgePointer(file)) continue;
    candidates.push({ id: name.slice(0, -'.jsonl'.length), mtime, file });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    if (hasAssistantRecord(c.file)) return c.id;
  }
  return candidates[0].id;
}

/**
 * Every workspace that has a project directory, as `{slug, label}`, plus where its transcripts live.
 *
 * The slug is `mangleCwd`'s output — every non-alphanumeric byte replaced by `-` — which is LOSSY and
 * cannot be inverted: `~/my-repo` and `~/my/repo` mangle to the same string. So nothing here pretends
 * to reconstruct a path. The label is derived for READING: the home directory's own slug becomes `~`,
 * and anything beneath it drops that prefix. What is displayed is therefore always a suffix of the
 * truth, never a guess at it.
 */
export interface WorkspaceDir {
  slug: string;
  label: string;
  dir: string;
}

/**
 * The workspace a session was launched in, found from the session id ALONE.
 *
 * `findTranscript` walks UP from a cwd, which answers "is this session mine?" and cannot answer "where
 * does this session live?" — from anywhere outside the workspace it returns null. That gap is what
 * emptied the terminal's Fleet, Prompts and session titles at once: all three are transcript-derived,
 * so a dashboard opened outside the repo (or pointed at another workspace's session by the picker) had
 * no transcript to read, while Traces kept working because it reads the store by id. One cause, three
 * symptoms, and no error anywhere — the panes just rendered empty.
 *
 * Scans the project dirs, which is a readdir over a directory that already exists for the picker, and
 * takes the cwd from the transcript's own first line: append-only, so it is a fact about the session
 * rather than an inference. Null when nothing on this machine holds it — a remote session, or a
 * transcript that has not been written yet — and every caller must treat that as "use the default".
 */
function claudeSessionTranscript(sessionId: string): string | null {
  if (!sessionId) return null;
  const base = path.join(claudeConfigDir(), 'projects');
  let names: string[]; try { names = fs.readdirSync(base); } catch { return null; }
  for (const slug of names) {
    const file = path.join(base, slug, `${sessionId}.jsonl`);
    try { if (fs.statSync(file).isFile() && !isMirroredTranscript(file).mirrored && !isBridgePointer(file)) return file; } catch {}
  }
  return null;
}
export function sessionWorkspace(sessionId: string): string | null {
  return sessionId ? describeSession(sessionId).cwd : null;
}

export function listWorkspaces(): WorkspaceDir[] {
  const base = path.join(claudeConfigDir(), 'projects');
  let names: string[] = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const homeSlug = mangleCwd(os.homedir());
  const out: WorkspaceDir[] = [];
  for (const slug of names) {
    const dir = path.join(base, slug);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let label: string;
    if (slug === homeSlug) label = '~';
    else if (slug.startsWith(homeSlug + '-')) label = slug.slice(homeSlug.length + 1);
    else label = slug.replace(/^-/, '');
    if (!label) label = slug || '(root)'; // a slug that reduces to nothing still needs a name
    out.push({ slug, label, dir });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A transcript that is only a BRIDGE POINTER — a session whose conversation lives on Claude Code's
 * bridge rather than on this machine.
 *
 * Claude Code writes these as a single line: `{type:"bridge-session", sessionId, bridgeSessionId,
 * lastSequenceNum}` and nothing else, typically ~146 bytes against a real transcript's megabytes.
 * `newestSessionIn` already knows they exist — it refuses to let one win the newest-mtime race — but
 * nothing NAMED them, so every listing that widened beyond the store started reporting them as
 * ordinary local sessions with "no edits". They are not empty; their content is elsewhere, and a
 * reader who opens one finds nothing with no explanation.
 *
 * Detected by reading the FIRST line only. A real transcript's first line is a summary/user record,
 * so this costs one small read and never scans a large file.
 */
export function bridgeInfo(transcriptPath: string): { bridgeSessionId: string; lastSequenceNum: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.toString('utf8', 0, n).split('\n', 1)[0];
    if (!first.includes('"bridge-session"')) return null;
    const o = JSON.parse(first) as Record<string, unknown>;
    if (o.type !== 'bridge-session') return null;
    return {
      bridgeSessionId: String(o.bridgeSessionId ?? ''),
      lastSequenceNum: Number(o.lastSequenceNum ?? 0) || 0,
    };
  } catch {
    return null; // unparseable first line — treat it as an ordinary transcript, not a bridge
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Newest Claude Code session id for `cwd`, or null if none found. Walks up parent directories so a
 * CLI/sidebar invoked from a subdirectory still finds the session for the dir Claude was launched in
 * (returns the nearest ancestor that has one).
 */
export function resolveSessionId(cwd: string): string | null {
  const cx = require('./codex') as typeof import('./codex');
  const store = require('./store') as typeof import('./store');
  const hidden = store.hiddenSessions(); // a deleted session is never auto-resolved as the active one
  const candidates = cx.codexSessionSources().filter((x) => !x.archived && !hidden.has(x.id)).map((x) => ({ id: x.id, cwd: canonPath(x.cwd), ts: x.mtimeMs }));
  let dir = canonPath(path.resolve(cwd));
  for (;;) {
    const s = newestSessionIn(projectDir(dir));
    const mine = candidates.filter((x) => x.cwd === dir);
    if (s && !hidden.has(s)) { try { mine.push({ id: s, cwd: dir, ts: fs.statSync(path.join(projectDir(dir), `${s}.jsonl`)).mtimeMs }); } catch {} }
    if (mine.length) return mine.sort((a,b) => b.ts-a.ts)[0].id;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The newest session on this MACHINE, across every workspace. Same demotion rule as
 * [newestSessionIn]: a transcript with no assistant record yet loses to one that has some. The
 * assistant probe reads file heads, so it is bounded to the newest few dozen candidates.
 */
export function newestSessionGlobal(): string | null {
  const base = path.join(claudeConfigDir(), 'projects');
  let slugs: string[];
  try {
    slugs = fs.readdirSync(base);
  } catch {
    return null;
  }
  const candidates: { id: string; mtime: number; file: string }[] = [];
  for (const slug of slugs) {
    const dir = path.join(base, slug);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        if (isMirroredTranscript(file).mirrored || isBridgePointer(file)) continue;
        candidates.push({ id: name.slice(0, -'.jsonl'.length), mtime: fs.statSync(file).mtimeMs, file });
      } catch {
        /* raced away */
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  const hidden = (require('./store') as typeof import('./store')).hiddenSessions();
  const visible = candidates.filter((c) => !hidden.has(c.id)); // a deleted session is never auto-selected
  if (!visible.length) return null;
  for (const c of visible.slice(0, 25)) {
    if (hasAssistantRecord(c.file)) return c.id;
  }
  return visible[0].id;
}

/**
 * The terminal front door's DEFAULT session. Inside a repo, the workspace rules: that repo's newest
 * session, exactly as every CLI verb resolves. OUTSIDE any repo — a shell at $HOME, the Desktop —
 * there is no workspace to scope to, and the walk-up used to land on whatever stale session was
 * once launched from an ancestor directory; "open the observatory" from nowhere means "show me what
 * Claude is doing NOW", so the machine-wide newest wins there.
 */
export function defaultTuiSession(cwd: string): string | null {
  return repoRoot(cwd) ? resolveSessionId(cwd) : newestSessionGlobal() ?? resolveSessionId(cwd);
}

/**
 * Walk up from `cwd` to the nearest ancestor directory that holds a `.git` entry (file OR dir),
 * mirroring resolveSessionId's parent walk. Returns that directory (the repo/worktree root) or
 * null if none is found. The transcript `cwd` is Claude's launch cwd, frequently a subdirectory
 * (e.g. packages/foo) that has no `.git` of its own — so this walk-up is required before resolving
 * the shared common git dir.
 */
export function repoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A git dir is a bare repository iff its config says so — the honest signal for the bare guard. */
function isBareGitDir(gitDir: string): boolean {
  try {
    return /^\s*bare\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Git-free repo-identity key for `cwd`: the realpath of the shared common git directory, which is
 * identical across a main working tree and all its linked worktrees, so sessions launched from
 * sibling worktrees of one logical repo resolve to the SAME key. Reads only the plain files git
 * writes — never the git binary.
 *
 * From repoRoot(cwd), read `<root>/.git`:
 *   - a DIRECTORY -> a main working tree; key = realpath(<root>/.git).
 *   - a FILE      -> a linked worktree holding `gitdir: <admindir>`. Read `<admindir>/commondir`;
 *                    if relative (observed `../..`) resolve against <admindir>, else use as-is;
 *                    key = realpath(that).
 * realpath collapses symlinks (/tmp vs /private/tmp, /var vs /private/var) so both sides match.
 * Returns null for: no repo root, unreadable/missing (pruned) worktree admin files, or a bare
 * repository — no conventional main working tree to correlate (the honest guard).
 */
export function commonDir(cwd: string): string | null {
  const root = repoRoot(cwd);
  if (root === null) return null;
  const gitPath = path.join(root, '.git');
  let st: fs.Stats;
  try {
    st = fs.statSync(gitPath);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    // Main working tree: `.git` is a directory (never bare — bare repos have no `.git` child).
    try {
      return fs.realpathSync(gitPath);
    } catch {
      return null;
    }
  }
  // `.git` is a file: a linked worktree pointing at its admin dir via `gitdir: <admindir>`.
  let admindir: string;
  try {
    const m = fs.readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const raw = m[1].trim();
    admindir = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  } catch {
    return null;
  }
  let key: string;
  try {
    // `commondir` (not `gitdir`) points back at the shared repo; relative unless configured absolute.
    const raw = fs.readFileSync(path.join(admindir, 'commondir'), 'utf8').trim();
    const common = path.isAbsolute(raw) ? raw : path.resolve(admindir, raw);
    key = fs.realpathSync(common);
  } catch {
    return null; // missing / pruned worktree admin dir
  }
  return isBareGitDir(key) ? null : key;
}

// The module caches below memoize stable / append-only facts, but a long-lived editor host that
// scans many sessions would grow them without bound — so cap them (insertion-order eviction) like
// fscache. An evicted entry simply re-derives on its next lookup (these are pure memoizations).
const SESSION_CACHE_CAP = 128;
function boundCache<K>(c: { size: number; keys(): IterableIterator<K>; delete(k: K): boolean }): void {
  while (c.size >= SESSION_CACHE_CAP) {
    const oldest = c.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    c.delete(oldest);
  }
}

// Cache the repo key by sessionId so grouping survives a worktree being pruned after first
// resolution (commonDir needs the live `.git` on disk). Only successful resolutions are cached —
// a transient miss (worktree not yet on disk) can be retried.
const repoKeyCache = new Map<string, string>();

/** commonDir(cwd) memoized by sessionId. Returns null when the cwd's repo can't be resolved. */
export function repoKeyForSession(sessionId: string, cwd: string): string | null {
  const hit = repoKeyCache.get(sessionId);
  if (hit !== undefined) return hit;
  const key = commonDir(cwd);
  if (key !== null) {
    boundCache(repoKeyCache);
    repoKeyCache.set(sessionId, key);
  }
  return key;
}

export interface FirstCwdLine {
  cwd: string;
  sessionId: string | null;
  gitBranch: string | null;
}

function parseCwdLine(line: string): FirstCwdLine | null {
  if (!line) return null;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // tolerate non-JSON / partial lines (schema evolves)
  }
  if (o?.type === 'session_meta') o = o.payload;
  if (o && typeof o.cwd === 'string' && o.cwd) {
    return {
      cwd: o.cwd,
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
      gitBranch: typeof o.gitBranch === 'string' ? o.gitBranch : null,
    };
  }
  return null;
}

// A transcript's first cwd-bearing line is immutable once written (transcripts are append-only), so
// cache successful resolutions by path. Only successes are cached — a still-growing brand-new file
// can be re-scanned next call.
const firstCwdCache = new Map<string, FirstCwdLine>();

/**
 * Scan a transcript for the FIRST line that actually carries `cwd` (Claude's launch cwd), skipping
 * leading queue-operation/metadata lines that have none — line 0 is NOT guaranteed to bear it, and
 * the first cwd line is not always the first `type:user`. Returns {cwd, sessionId, gitBranch} or
 * null. Reads incrementally (not a fixed prefix) so a large leading queue-operation line can't hide
 * the cwd line behind a byte cap — a real 20MB self-session's first cwd line sits ~380KB in. Bounded
 * by MAX_SCAN so a live refresh never loads a whole 20-34MB transcript.
 */
export function firstCwdLine(transcriptPath: string): FirstCwdLine | null {
  const cached = firstCwdCache.get(transcriptPath);
  if (cached) return cached;
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const CHUNK = 256 * 1024;
    const MAX_SCAN = 32 * 1024 * 1024; // generous — the cwd line is near the top; bounds a pathological file
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8'); // handle multibyte split across chunk boundaries
    let offset = 0;
    let carry = '';
    while (offset < MAX_SCAN) {
      const n = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (n === 0) break; // EOF
      offset += n;
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const hit = parseCwdLine(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
        if (hit) {
          boundCache(firstCwdCache);
          firstCwdCache.set(transcriptPath, hit);
          return hit;
        }
      }
      if (n < CHUNK) break; // short read => EOF
    }
    const tail = parseCwdLine(carry + decoder.end()); // final line with no trailing newline
    if (tail) {
      boundCache(firstCwdCache);
      firstCwdCache.set(transcriptPath, tail);
      return tail;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Positive results are sticky (transcripts are append-only: once a session has replied it stays
// real forever). A negative is keyed on (mtimeMs,size) so a still-growing brand-new transcript is
// re-scanned when it changes, while a dead stub costs one stat() per lookup.
const assistantSeen = new Set<string>();
const assistantNegKey = new Map<string, string>();

/** True iff a parsed transcript line is an actual assistant record (not pasted look-alike text). */
function isAssistantLine(line: string): boolean {
  // Substring prefilter, then parse-confirm: a user record can EMBED the literal '"type":"assistant"'
  // in pasted content — only a record whose own type field is 'assistant' counts.
  if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) return false;
  try {
    return JSON.parse(line)?.type === 'assistant';
  } catch {
    return false; // partial/corrupt line — a real record will parse on a later scan
  }
}

/**
 * True iff the transcript contains at least one `type:"assistant"` record — the discriminator
 * between a real session and a command-only/bridge stub. A real session gains its assistant record
 * when the first reply starts streaming, BEFORE any capture hook can fire (the tool_use assistant
 * message precedes Pre/PostToolUse), so filtering on this can never hide a session that has edits.
 * Scanning mirrors firstCwdLine: incremental chunked read, bounded by MAX_SCAN.
 */
export function hasAssistantRecord(transcriptPath: string): boolean {
  if (assistantSeen.has(transcriptPath)) return true;
  let st: fs.Stats;
  try {
    st = fs.statSync(transcriptPath);
  } catch {
    return false;
  }
  const negKey = `${st.mtimeMs}:${st.size}`;
  if (assistantNegKey.get(transcriptPath) === negKey) return false;
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return false;
  }
  try {
    const CHUNK = 256 * 1024;
    const MAX_SCAN = 32 * 1024 * 1024; // same bound as firstCwdLine — never load a whole 20-56MB file
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8');
    let offset = 0;
    let carry = '';
    while (offset < MAX_SCAN) {
      const n = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (n === 0) break; // EOF
      offset += n;
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (isAssistantLine(line)) {
          boundCache(assistantSeen);
          assistantSeen.add(transcriptPath);
          return true;
        }
      }
      if (n < CHUNK) break; // short read => EOF
    }
    if (isAssistantLine(carry + decoder.end())) {
      boundCache(assistantSeen);
      assistantSeen.add(transcriptPath);
      return true;
    }
    boundCache(assistantNegKey);
    assistantNegKey.set(transcriptPath, negKey);
    return false;
  } finally {
    fs.closeSync(fd);
  }
}


interface TranscriptProvenance { cwd?: string; bridge: boolean; ino: number; size: number; mtime: number; version: 1 }
const provenanceCache = new Map<string, TranscriptProvenance>();
/** Persist the immutable launch identity: a finished session must not reread its body on every
 * CLI invocation. Append-only growth retains a known cwd; a pointer is rechecked when it grows
 * because it can gain a local reply. Replacements and truncation invalidate the sidecar. */
function transcriptProvenance(file: string): TranscriptProvenance {
  const empty: TranscriptProvenance = { bridge: false, ino: 0, size: 0, mtime: 0, version: 1 };
  let st: fs.Stats; try { st = fs.statSync(file); } catch { return empty; }
  const store = (require('./store') as typeof import('./store')).rootDir();
  const sidecar = path.join(store, 'session-meta', 'provenance', createHash('sha256').update(path.resolve(file)).digest('hex') + '.json');
  let old = provenanceCache.get(sidecar);
  if (!old) { try { old = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {} }
  if (old?.version === 1 && old.ino === st.ino &&
      ((old.size === st.size && old.mtime === st.mtimeMs) || (old.cwd && !old.bridge && st.size > old.size))) return old;
  if (old && (old.ino !== st.ino || st.size <= old.size)) { firstCwdCache.delete(file); assistantSeen.delete(file); assistantNegKey.delete(file); }
  const value: TranscriptProvenance = { version: 1, ino: st.ino, size: st.size, mtime: st.mtimeMs,
    cwd: firstCwdLine(file)?.cwd, bridge: bridgeInfo(file) !== null && !hasAssistantRecord(file) };
  boundCache(provenanceCache); provenanceCache.set(sidecar, value);
  try {
    fs.mkdirSync(path.dirname(sidecar), { recursive: true, mode: 0o700 });
    const tmp = `${sidecar}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, sidecar);
  } catch { /* read-only stores still get the in-memory result */ }
  return value;
}

/** A copied transcript cannot establish local ownership. A mismatched Claude project slug is
 * decisive even when the recorded directory exists here. A missing cwd alone is NOT proof: local
 * worktrees can be pruned or drives unmounted. Foreign platform home roots, when absent here, are
 * additional evidence (including rollouts, which have no mangled project folder).
 */
export function isMirroredTranscript(transcriptPath: string): { mirrored: boolean; recordedCwd?: string } {
  const recordedCwd = transcriptProvenance(transcriptPath).cwd;
  if (!recordedCwd) return { mirrored: false };
  const parent = path.dirname(transcriptPath);
  const project = path.basename(path.dirname(parent)) === 'projects';
  const mismatch = project && !namesProject(path.basename(parent), recordedCwd)
    && !namesProject(path.basename(parent), canonPath(recordedCwd));
  const foreignHome = process.platform === 'darwin' ? /^\/home\//.test(recordedCwd)
    : process.platform === 'win32' ? /^\/(?:Users|home)\//.test(recordedCwd)
    : /^\/Users\//.test(recordedCwd);
  const foreignDrive = process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(recordedCwd);
  return { mirrored: mismatch || ((foreignHome || foreignDrive) && !fs.existsSync(recordedCwd)), recordedCwd };
}

/** Bridge metadata can precede a real local conversation. Only a pointer WITHOUT an assistant
 * reply is excluded; bookkeeping records (cost-state/mode) do not make a conversation local. */
export function isBridgePointer(transcriptPath: string): boolean {
  return transcriptProvenance(transcriptPath).bridge;
}

/** Readable, unambiguous workspace label, shared by every session consumer. Home-shortened and
 *  forward-slashed, like every other path the product shows (risk.ts outsideWrites); Windows showed `~\work`. */
export function workspaceLabel(cwd: string): string {
  const home = os.homedir();
  return cwd === home ? '~' : cwd.startsWith(home + path.sep) ? '~' + cwd.slice(home.length).split(path.sep).join('/') : cwd;
}

export interface SessionDescriptor {
  session: string;
  runtime: string;
  nativeSessionId: string;
  cwd: string | null;
  provider: string | null;
  model: string | null;
  machine: string;
  transcript: string | null;
  continuation: { agentId: string; nativeSessionId: string };
}

/** Runtime identity is explicit metadata, independent of the selected model's name. */
export function describeSession(session: string): SessionDescriptor {
  if (!session) return { session:'', runtime:'unknown', nativeSessionId:'', cwd:null, provider:null, model:null, machine:os.hostname(), transcript:null,
    continuation:{agentId:'unknown',nativeSessionId:''} };
  const cx = require('./codex') as typeof import('./codex');
  const meta = cx.readCodexAgentMeta(session);
  const candidate = cx.findCodexRollout(session);
  const raw = candidate && !isMirroredTranscript(candidate).mirrored ? candidate : null;
  const source = raw ? cx.codexSessionSources().find((x) => x.file === raw) : undefined;
  const runtime = meta || raw ? 'codex' : 'claude';
  const rollout = raw ? cx.readCodexRollout(raw) : undefined;
  const claudePath = /^claude(?:-acp)?$/.test(runtime) ? claudeSessionTranscript(session) : null;
  const nativeSessionId = source?.id || session;
  return { session, runtime, nativeSessionId, cwd: source?.cwd || meta?.cwd || (claudePath ? firstCwdLine(claudePath)?.cwd : null) || null,
    provider: rollout?.provider || meta?.provider || null, model: rollout?.model || meta?.model || null, machine: os.hostname(), transcript: raw ?? claudePath,
    continuation: { agentId: runtime, nativeSessionId: nativeSessionId } };
}

export function resolveSessionContinuation(session: string, requestedAgent?: string): { agentId: string; nativeSessionId?: string; cwd?: string; error?: string } {
  const d = describeSession(session);
  const family = (id: string): string => id === 'codex-acp' ? 'codex' : id === 'claude-acp' ? 'claude' : id;
  // An unknown id resolves to a default (claude) runtime with no evidence behind it — a transcript,
  // rollout, or recorded workspace. Report that as "not found" rather than the misleading
  // "belongs to claude; cannot be resumed through <agent>" a typo'd --resume would otherwise get.
  if (!d.transcript && !d.cwd) return { agentId: requestedAgent || d.runtime,
    error: `No session ${session} found (no transcript, rollout, or recorded workspace). Check the id, or start a new conversation.` };
  if (requestedAgent && family(requestedAgent) !== family(d.runtime)) return { agentId: requestedAgent,
    error: `Session ${session} belongs to ${d.runtime}; it cannot be resumed through ${requestedAgent}. Start a new conversation explicitly to switch runtimes.` };
  return { agentId: requestedAgent || d.runtime, nativeSessionId: d.nativeSessionId, ...(d.cwd ? { cwd: d.cwd } : {}) };
}

export function nativeSessionCommand(session: string): { command: string; args: string[]; cwd?: string; error?: string } {
  const d = describeSession(session);
  if (/^codex(?:-acp)?$/.test(d.runtime)) return { command: 'codex', args: ['resume', d.nativeSessionId], ...(d.cwd ? { cwd: d.cwd } : {}) };
  if (/^claude(?:-acp)?$/.test(d.runtime)) return { command: 'claude', args: ['--resume', d.nativeSessionId], ...(d.cwd ? { cwd: d.cwd } : {}) };
  return { command: '', args: [], error: `Native terminal continuation is unavailable for ${d.runtime}; continue it in Observatory.` };
}
