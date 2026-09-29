/**
 * Capture hook logic for Claude Observatory.
 *
 * Wired as PreToolUse + PostToolUse hooks (matcher: Edit|Write|MultiEdit|NotebookEdit|Bash), plus
 * PostToolUseFailure, the Post Claude Code sends instead when the tool fails.
 * For the four file tools it snapshots the WHOLE named file off disk before and after the edit.
 * For Bash (which names no file) it snapshots the whole candidate tree under cwd before the command
 * and diffs it after, recording one edit per changed/created/deleted file — so Bash-driven changes
 * are fully undoable too. The Bash walk is bounded (skips vendor/build dirs, caps the file count) and
 * degrades silently when a tree is too large; set CLAUDE_OBSERVATORY_NO_BASH=1 to opt out entirely.
 *
 * HARD RULES (preserve zero-token, non-blocking behavior):
 *   - never write to stdout (nothing must reach the model context)
 *   - never throw out of runCapture(); the caller always exit(0)
 *   - a capture failure degrades silently and never blocks or slows Claude's edit
 *
 * Zero external deps (fs/path/crypto only) so the hook process stays lean & fast; in particular
 * this module must NOT import the `diff`-based undo engine.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonPath } from './paths';
import { linkHerdrPane, kickTabSync } from './herdr-link';
import { ignoreContext } from './ignore';
import {
  storeDir,
  ensureStore,
  pathKey,
  writeBlob,
  writeStaging,
  readStaging,
  lastRecordFor,
  deleteStaging,
  writeBashManifest,
  claimBashManifest,
  writeSnapshotLease,
  releaseSnapshotLease,
  advancePendingManifests,
  deleteBashManifest,
  readBashStatCache,
  writeBashStatCache,
  blobPresence,
  withBashPreLock,
  isUnderPath,
  appendLog,
  appendSkip,
  sweepIgnoredIfChanged,
  readBlob,
  EMPTY_BLOB,
  type BashStatCache,
  type EditRecord,
  enrichCaptureFromHook,
  withFileMutation,
  clearAbandonedToolStaging,
} from './store';
import { blankLineOnlyChange } from './merge';

const MAX_BYTES = 5 * 1024 * 1024; // skip TEXT files larger than 5 MB
// A binary file (a PDF, an image, a compiled asset) is tracked too — the blob store is byte-safe, so
// the only thing that ever stopped it was the text-diff view, which now substitutes a size summary.
// The cap is higher because these are legitimately larger than source, but still bounded so one huge
// asset cannot balloon the store.
const BINARY_MAX_BYTES = 25 * 1024 * 1024;
const CAPTURED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Bash full-snapshot bounds — keep the per-command walk from ever hanging Claude on a huge tree.
const BASH_MAX_FILES = 4000;
const BASH_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.cache', '__pycache__', '.gradle', '.idea',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'vendor', 'coverage', '.terraform',
]);

/**
 * Commonly secret-bearing file names. The Bash capture path snapshots the WHOLE cwd tree, so without
 * this it would vacuum unrelated `.env`/keys/credentials into the store — never do that. (A deliberate
 * Edit/Write to such a file is still captured, so undo keeps working; those blobs are written 0600.)
 * Patterns are simple/linear — no nested quantifiers — so they can't backtrack catastrophically.
 */
function isSecretName(name: string): boolean {
  return (
    /^\.env(\.|$)/i.test(name) || // .env, .env.local, .env.production
    /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) || // private keys / keystores
    /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name) || // ssh private keys
    /^\.(npmrc|netrc|pgpass|git-credentials)$/i.test(name) || // token-bearing dotfiles
    /(^|[._-])(secret|secrets|credential|credentials)([._-]|$)/i.test(name)
  );
}

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  /** The harness's id for this tool call, when it sends one. Claude Code 2.1.x DOES include it (and
   *  Codex sends `exec-…`), so it suffixes the staging key for an exact edit→reasoning join instead of
   *  a nearest-in-time match. One consequence: two calls on the same file get distinct staging keys, so
   *  an abandoned Pre (denied/failed/interrupted, no Post) must be cleared at turn end — see
   *  clearAbandonedToolStaging — or it marks later edits of that file as overlapping. */
  tool_use_id?: string;
  /** Which prompt caused this tool call. Claude Code ≥2.1.196 delivers it as a common hook field;
   *  it is absent before the first user input and on older builds — absence is tolerated, and the
   *  record simply lacks `promptId` (the same contract `uid` established). */
  prompt_id?: string;
  tool_input?: { file_path?: string; notebook_path?: string; [k: string]: unknown };
  hook_event_name?: string;
  runtime?: string;
  provider?: string;
  model?: string;
  original_tool_name?: string;
  native_turn_id?: string;
}

function captureMetadata(payload: HookPayload): Partial<EditRecord> {
  return {
    ...(payload.tool_use_id ? { toolCallId: payload.tool_use_id } : {}),
    ...(payload.prompt_id ? { promptId: payload.prompt_id, nativeTurnId: payload.native_turn_id ?? payload.prompt_id } : {}),
    ...(payload.runtime ? { runtime: payload.runtime } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.model ? { model: payload.model } : {}),
  };
}

function stagingKey(file: string, payload: HookPayload): string {
  return pathKey(file) + (payload.tool_use_id ? `-${pathKey(payload.tool_use_id)}` : '');
}

type Snapshot =
  | { kind: 'missing' }
  | { kind: 'skip' }
  | { kind: 'text'; content: Buffer }
  | { kind: 'binary'; content: Buffer };

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Is a stored blob binary? Used to flag a Bash tree-diff record, whose hashes come from the walk and
 *  carry no kind of their own. Byte-safe (`readBlob` returns the raw Buffer). */
function blobIsBinary(session: string, sha: string | null | undefined): boolean {
  if (!sha) return false;
  try {
    return isBinary(readBlob(session, sha));
  } catch {
    return false;
  }
}

/**
 * Is the difference between these two snapshots nothing but blank lines?
 *
 * Fails CLOSED in every uncertain case — a create, a delete, an unreadable blob, or content that does
 * not round-trip as UTF-8 all answer `false` and get recorded. Dropping a change because we could not
 * check it would be the one outcome worse than recording a blank line.
 */
function blankLineOnly(session: string, beforeBlob: string | null, afterBlob: string | null): boolean {
  if (!beforeBlob || !afterBlob) return false; // a create or a delete is never "just whitespace"
  try {
    const b = readBlob(session, beforeBlob);
    const a = readBlob(session, afterBlob);
    // A file that does not survive a UTF-8 round-trip has no line model we can trust; `isBinary` only
    // screens for NUL, so Latin-1 and UTF-16 reach here.
    if (!Buffer.from(b.toString('utf8'), 'utf8').equals(b)) return false;
    if (!Buffer.from(a.toString('utf8'), 'utf8').equals(a)) return false;
    return blankLineOnlyChange(b.toString('utf8'), a.toString('utf8'));
  } catch {
    return false;
  }
}

function snapshot(file: string): Snapshot {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    return { kind: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'skip' };
  }
  if (!st.isFile()) return { kind: 'skip' };
  // A binary file may be up to the larger cap; text keeps the 5 MB one. The absolute cap is checked
  // before the read so an enormous file is never pulled into memory.
  if (st.size > BINARY_MAX_BYTES) return { kind: 'skip' };
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) return { kind: 'binary', content: buf };
  if (buf.length > MAX_BYTES) return { kind: 'skip' }; // a large TEXT file stays out (no size summary earns it)
  return { kind: 'text', content: buf };
}

function resolveFile(payload: HookPayload): string | null {
  const ti = payload.tool_input || {};
  const f = ti.file_path || ti.notebook_path;
  if (typeof f !== 'string' || !f) return null;
  const cwd = payload.cwd || process.cwd();
  // canonPath: hook events can disagree about drive-letter case on Windows (#43) — one key per file.
  const abs = canonPath(path.isAbsolute(f) ? f : path.resolve(cwd, f));
  // `.observatoryignore` — never recorded. HERE and not in handlePre, because this is the one funnel
  // BOTH handlers use and both already treat null as "nothing to do". Refusing in Pre alone would
  // leave Post with no staging record, sending it down the appendSkip branch to write an "edit not
  // captured — no before-snapshot" marker for a file the reader asked us to leave alone.
  if (ignoreContext().ignored(abs)) return null;
  return abs;
}

/**
 * The directories this hook event touched, for the ignore sweep's stamp.
 *
 * Deliberately NOT `resolveFile`: that returns null for an ignored path, and an ignored path is
 * exactly the case whose directory the sweep most needs, because that is where the new rule lives.
 *
 * For a Bash tool this returns the working directory ALONE, which is why `handlePostBash` reports the
 * directories it actually wrote into instead. The walk records files at ANY depth under cwd, so
 * stamping cwd alone left the gate blind to a `.observatoryignore` created BELOW it: the rule refused
 * new captures immediately while the records it covered stayed in the store forever, because the
 * stamp could never move. Reproduced end to end before this was written.
 */
function editedDirs(payload: HookPayload): string[] {
  const cwd = payload.cwd || process.cwd();
  const f = (payload.tool_input || {}).file_path || (payload.tool_input || {}).notebook_path;
  if (typeof f === 'string' && f) {
    return [path.dirname(canonPath(path.isAbsolute(f) ? f : path.resolve(cwd, f)))];
  }
  return [canonPath(cwd)];
}

function handlePre(session: string, payload: HookPayload): void {
  if (!CAPTURED_TOOLS.has(payload.tool_name || '')) return;
  const file = resolveFile(payload);
  if (!file) return;
  const key = stagingKey(file, payload);
  ensureStore(session);
  withBashPreLock(session, () => {
    if (payload.tool_use_id && readStaging(session, key)) return; // replayed Pre must retain its baseline
    const prior = readStaging(session, key);
    // A delayed or denied call looks identical until a terminal event establishes ownership.
    // Never infer completion from its age or discard the oldest before-state.
    if (prior && !payload.tool_use_id) {
      writeStaging(session, key, { ...prior, ambiguous: true }); return;
    }
    deleteStaging(session, key);
    const s = snapshot(file);
    if (s.kind === 'skip') return;
    let ambiguous = false;
    for (const name of fs.readdirSync(path.join(storeDir(session), 'staging'))) {
      if (!name.startsWith(pathKey(file)) || !name.endsWith('.json')) continue;
      const otherKey = name.slice(0, -5);
      const other = readStaging(session, otherKey);
      if (!other || other.file !== file) continue;
      ambiguous = true;
      writeStaging(session, otherKey, { ...other, ambiguous: true });
    }
    const beforeBlob = s.kind === 'missing' ? null : writeBlob(session, s.content);
    writeStaging(session, key, { file, tool: payload.original_tool_name || payload.tool_name || 'unknown', beforeBlob,
      ts: Date.now(), toolCallId: payload.tool_use_id, ...(ambiguous ? { ambiguous: true } : {}) });
  });
}

function handlePost(session: string, payload: HookPayload): void {
  if (!CAPTURED_TOOLS.has(payload.tool_name || '')) return;
  const file = resolveFile(payload);
  if (!file) return;
  const key = stagingKey(file, payload);
  const staging = readStaging(session, key);
  if (!staging) {
    // A real edit to a captured tool, but there's no before-snapshot: Pre skipped it (the file was
    // binary/oversized AT PRE-TIME) or PreToolUse never ran. We can't reconstruct the before, so the edit
    // isn't recorded — but it DID happen. Leave a marker (mirroring the post-time-skip branch below) so
    // `status` surfaces the gap instead of swallowing it silently. (no-silent-fail)
    appendSkip(session, file, 'edit not captured — no before-snapshot (file was oversized at pre-time, or PreToolUse did not run or did not finish)');
    return;
  }

  const s = snapshot(file);
  if (s.kind === 'skip') {
    // Pre snapshotted a before, but the file is now too large to record (over 25 MB even as a binary)
    // — this edit is real but untracked; leave a marker so `status` can surface it, not fail silently.
    appendSkip(session, file, 'file too large (>25MB) at commit — edit not captured');
    deleteStaging(session, key);
    return;
  }
  const afterBlob = withBashPreLock(session, () => {
    const sha = s.kind === 'missing' ? null : writeBlob(session, s.content);
    writeStaging(session, key, { ...staging, afterBlob: sha });
    return sha;
  });

  // No real change (e.g. a MultiEdit that netted out, or identical rewrite) — don't log a no-op.
  if (staging.beforeBlob === afterBlob) {
    deleteStaging(session, key);
    return;
  }

  // …nor a change that is only blank lines. Same rule, one step weaker: there is no decision for a
  // reviewer to make about an added or removed empty line, and an agent reformatting around an edit
  // produces them constantly. Recording one costs a row, a pending count and a click, and answers
  // nothing.
  if (blankLineOnly(session, staging.beforeBlob, afterBlob)) {
    deleteStaging(session, key);
    return;
  }

  // ALREADY RECORDED. A backgrounded Bash command's Post walks the tree in the middle of an edit and
  // logs what it finds, so both captures see one change — two rows, byte-identical, one attributed to
  // `Bash`, and undoing the first then refuses as a conflict with the second.
  //
  // The EDIT is the side that yields, never the walk: the walk's record is already in the log and its
  // snapshot is gone, so declining there loses the change outright when the edit turns out never to
  // land (PreToolUse fires before the permission prompt, and PostToolUse only on success — every
  // denied or failed edit leaves its staging record behind). Matching on the END STATE rather than on
  // the whole hop also covers the case where the command's walk recorded a WIDER transition than this
  // call did: appending the narrower one would break the file's chain.
  const lastForFile = lastRecordFor(session, file);
  if (lastForFile && lastForFile.status !== 'undone' && lastForFile.afterBlob === afterBlob &&
      lastForFile.ts >= (staging.ts ?? 0)) {
    if (lastForFile.source === 'acp' && !staging.ambiguous) enrichCaptureFromHook(session, lastForFile.id, { file, beforeBlob: staging.beforeBlob, afterBlob, tool: staging.tool, toolCallId: payload.tool_use_id });
    deleteStaging(session, key);
    return;
  }

  // Publish the after-blob on the staging record BEFORE appending. Until the record lands, nothing
  // else references this blob, and a concurrent GC (clean / clearResolved) would collect it — leaving
  // a committed edit pointing at a missing blob. gcSessionCore reads staging, so this closes the gap.
  if (afterBlob) writeStaging(session, key, { ...staging, afterBlob });

  appendLog(session, {
    ts: Date.now(),
    tool: staging.tool,
    file,
    beforeBlob: staging.beforeBlob,
    afterBlob,
    status: 'pending',
    source: 'hook',
    ...captureMetadata(payload),
    beforeState: staging.beforeBlob === null ? 'absent' : 'present',
    provenance: 'tool',
    attribution: staging.ambiguous ? 'ambiguous' : 'correlated',
    captureStartMs: staging.ts,
    ...(s.kind === 'binary' ? { binary: true as const } : {}),
    ...(staging.ambiguous ? { partial: true, uncertainty: 'Overlapping tool calls share this capture interval' } : {}),
  });
  // A Bash snapshot taken BEFORE this edit still holds the old content, so that command's Post would
  // diff this change out of its own tree and record it a second time — as `tool: "Bash"`, with the
  // duplicate that makes undoing the first refuse. Same baseline advance the Bash path does; it just
  // never covered the edits captured beside it.
  advancePendingManifests(session, new Map([[file, afterBlob]]));
  deleteStaging(session, key);
}

/** Drop a failed file tool's Pre snapshot without recording anything (see the PostToolUseFailure
 *  branch of handleHookPayloadUnlocked). */
function discardPre(session: string, payload: HookPayload): void {
  if (!CAPTURED_TOOLS.has(payload.tool_name || '')) return;
  const file = resolveFile(payload);
  if (file) deleteStaging(session, stagingKey(file, payload));
}

/** Walk files under root, skipping vendor/build dirs and symlinks. Returns false if it hit the file
 *  cap (truncated) — the caller then degrades rather than record a partial/incorrect diff. */
function walkCandidates(root: string, onFile: (abs: string) => void, excluded: string[] = []): boolean {
  const stack: string[] = [root];
  // COLLECT FIRST, HASH AFTER. `onFile` snapshots (hashes and writes a blob), and calling it during
  // the walk meant a tree that turned out to exceed the cap had already paid for 4,000 blobs it then
  // threw away — 157 MB of orphans on the first command in this repo, measured 2026-09-23 — before
  // the skip marker was even written. Paths are cheap; the work waits until the tree is known small.
  const files: string[] = [];
  // One matcher for the whole walk, so each directory's `.observatoryignore` (and, here only, its
  // `.gitignore`) is read once rather than once per file under it.
  const ignore = ignoreContext({ gitignore: true });
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      excluded.push(dir);
      continue; // unreadable dir — skip
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // An ignored directory is never descended — the same shape as BASH_SKIP_DIRS, so a rule on
        // `dist/` costs nothing rather than costing a walk of everything inside it.
        if (!BASH_SKIP_DIRS.has(e.name) && !ignore.ignored(full, true)) stack.push(full);
        else excluded.push(full);
      } else if (e.isFile()) {
        if (ignore.ignored(full)) { excluded.push(full); continue; }
        if (files.push(full) > BASH_MAX_FILES) {
          lastWalkOverflow = { root, heaviest: heaviestSubtree(root, files) };
          return false;
        }
      } else excluded.push(full);
    }
  }
  for (const f of files) onFile(f);
  return true;
}

/** Where the files were when the walk overflowed — the skip marker names the heaviest top-level
 *  directory so the person can put it in `.observatoryignore` instead of guessing. */
let lastWalkOverflow: { root: string; heaviest: string } | null = null;
function heaviestSubtree(root: string, files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const rel = path.relative(root, f);
    const top = rel.split(path.sep)[0] || '.';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  let best = '';
  let n = -1;
  for (const [dir, c] of counts) if (c > n) { best = dir; n = c; }
  return best;
}
/** The overflow note for a skip marker: which subtree the cap was hit in. */
function walkOverflowNote(): string {
  const o = lastWalkOverflow;
  lastWalkOverflow = null;
  return o && o.heaviest && o.heaviest !== '.' ? ` (most of them under ${o.heaviest}/ — add it to .observatoryignore to capture Bash edits here)` : '';
}

// git's "racily clean" rule: a same-size rewrite inside the same timestamp quantum as the cached
// stat is invisible to (mtimeMs,size). Re-hash any file whose mtime lands within this window of
// the cache's own write time — only files hot at cache-write time qualify, so the cost is ~zero.
const RACY_EPSILON_MS = 2000;

function statKey(st: fs.Stats): string {
  return `${st.mtimeMs}:${st.size}`;
}

/**
 * Content hash for a Bash-walk candidate via the stat cache: stat-only when (mtimeMs,size) is
 * unchanged AND the blob still exists (never trust cache presence as blob existence — routine GC
 * collects manifest-orphaned blobs, and a dangling beforeBlob would corrupt undo forever); read+
 * hash+blob only what changed. Negative verdicts (binary/oversized) are cached too — 2/3 of the
 * walked bytes are binaries the uncached path re-read on every single pass. Returns null for
 * vanished/non-file/binary/oversized candidates.
 */
function cachedSnapshotHash(session: string, abs: string, cache: BashStatCache, blobs: Set<string>): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const k = statKey(st);
  const hit = cache.files[abs];
  const racy = cache.wroteMs > 0 && Math.abs(st.mtimeMs - cache.wroteMs) < RACY_EPSILON_MS;
  if (hit && hit.k === k && !racy) {
    if (hit.h === undefined) return null; // known oversized/unreadable — skip without reading
    if (blobs.has(hit.h)) return hit.h; // GC-safe fast path
  }
  if (st.size > BINARY_MAX_BYTES) {
    cache.files[abs] = { k };
    return null;
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  // Binary is tracked now (up to the larger cap); only a large TEXT file stays out, because its
  // diff view would be a lossy decode with nothing a size summary earns it.
  if (!isBinary(buf) && buf.length > MAX_BYTES) {
    cache.files[abs] = { k };
    return null;
  }
  const h = writeBlob(session, buf);
  blobs.add(h);
  cache.files[abs] = { k, h };
  return h;
}

/** Forget the cached stats under `root` that a COMPLETE walk of it did not visit: deleted files, and
 *  files a rule now excludes. The cache used to only grow — once `.gitignore` was honoured, one
 *  session held 4,290 entries for a 520-file walk, parsed and rewritten twice per Bash command. */
function pruneStatCache(cache: BashStatCache, root: string, visited: { has(file: string): boolean }): void {
  for (const file of Object.keys(cache.files)) if (!visited.has(file) && isUnderPath(file, root)) delete cache.files[file];
}

/** Bash Pre: snapshot the before-content of every candidate file under cwd into a manifest.
 *  Runs under the session lock so concurrent GC can't collect fresh blobs before the manifest
 *  lands; appendSkip happens AFTER release (appendLog takes the same lock — never append inside). */
/**
 * A directory the Bash full-tree snapshot must NOT treat as a working tree.
 *
 * The walk records every file whose content differs across the command, which is the right model for
 * a project directory and completely wrong for `$HOME` or a filesystem root: a session that ran
 * `install neovim` from the home directory recorded 2,445 "edits" — `.Xauthority`,
 * `.CFUserTextEncoding`, `.bash_history`, shell state, caches — against ONE real Write. None of them
 * were changes the agent made; they were files that happened to move while a command ran, and the
 * session's review list was 99.8% noise. Sweeping a person's home directory into a snapshot store is
 * also the wrong thing to do on its own terms.
 *
 * Deliberately narrow: a project without a VCS marker is still a project, so the test is the specific
 * pair of places that are never one, not a positive test for project-ness.
 */
function unwalkableRoot(dir: string): string | null {
  if (dir === path.parse(dir).root) return 'the filesystem root';
  let home: string;
  try {
    home = canonPath(os.homedir());
  } catch {
    return null;
  }
  return dir === home ? 'your home directory' : null;
}

/**
 * Worktree snapshot used by native hook capture and deferred reconciliation: file → content sha
 * for each candidate under `root`, with recoverable blobs. An incomplete walk cannot prove absence;
 * uncertain before-state remains review-only.
 *
 * Same discipline as the Bash Pre it mirrors: the session lock (concurrent GC must not collect
 * fresh blobs), the stat cache (persisted either way — verdicts are facts), and the secrets guard.
 */
export interface WorktreeSnapshot {
  files: Map<string, string>;
  complete: boolean;
  excluded?: string[];
  root?: string;
  lease?: string;
}

/** A finished eligible walk cannot prove absence beneath an excluded or unreadable path. */
export function snapshotProvesAbsent(s: WorktreeSnapshot, file: string): boolean {
  if (!s.complete || !s.root || !s.excluded || s.files.has(file)) return false;
  const rel = path.relative(canonPath(s.root), canonPath(file));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return !s.excluded.some((p) => file === p || file.startsWith(p + path.sep));
}

function handlePreBash(session: string, payload: HookPayload): void {
  // Canonical drive-letter case for the tree every walk key derives from (#43): a Pre manifest keyed
  // C:\ against a Post walk keyed c:\ made every file a phantom create + delete pair.
  const cwd = payload.cwd ? canonPath(payload.cwd) : payload.cwd;
  if (!cwd) return;
  const refuse = unwalkableRoot(cwd);
  if (refuse) {
    ensureStore(session);
    // The manifest MUST be cleared before returning. `handlePostBash` no-ops only when there is no
    // manifest, so leaving a previous command's behind would have it diff that against a walk of the
    // very tree this branch exists to refuse — turning a guard into the bug it was written to stop.
    // OUR tree only: a refused $HOME command used to wipe every pending snapshot, so a repo command
    // running beside it captured nothing and never said so.
    // A marker, not silence: a real Bash command ran and its changes are genuinely not captured, and
    // that is exactly what SkipOp exists to say. Written once per command, like the truncation case,
    // and AFTER the lock is released (appendSkip takes the same one).
    appendSkip(session, '<bash-tree>', `Bash ran in ${refuse} — its tree is not snapshotted, so changes made by this command are not captured`);
    return;
  }
  ensureStore(session);
  const truncated = withBashPreLock(session, () => {
    // NOTE: no longer clears other manifests. Each Pre owns its own file and each Post consumes the
    // one taken of its own tree, because Bash calls overlap (any backgrounded command runs beside
    // the next one) and a shared manifest had them diffing against each other's snapshots.
    const cache = readBashStatCache(session);
    const blobs = blobPresence(session);
    const files: Record<string, string | null> = {};
    const excluded: string[] = [];
    const visited = new Set<string>();
    const ok = walkCandidates(cwd, (abs) => {
      if (isSecretName(path.basename(abs))) { excluded.push(abs); return; }
      visited.add(abs);
      const h = cachedSnapshotHash(session, abs, cache, blobs);
      if (h) files[abs] = h;
      else excluded.push(abs);
    }, excluded);
    if (ok) pruneStatCache(cache, cwd, visited);
    writeBashStatCache(session, cache); // verdicts are facts either way — persist even on truncation
    if (!ok) return true;
    writeBashManifest(session, { files, ts: Date.now(), root: cwd, excluded, complete: true, toolCallId: payload.tool_use_id });
    return false;
  });
  if (truncated) {
    // Tree too large to snapshot reliably — record one marker for the whole command rather than
    // half-capture (no manifest → Post no-ops).
    appendSkip(session, '<bash-tree>', `Bash working tree exceeds ${BASH_MAX_FILES} files — changes not captured${walkOverflowNote()}`);
  }
}

/** Bash Post: diff the tree against the manifest and log one edit per changed/created/deleted file.
 *  The walk hashes under the session lock and leases every changed blob before releasing it; the
 *  records are appended afterwards (appendLog takes the same lock). */
function handlePostBash(session: string, payload: HookPayload): string[] {
  // Canonical drive-letter case for the tree every walk key derives from (#43): a Pre manifest keyed
  // C:\ against a Post walk keyed c:\ made every file a phantom create + delete pair.
  const cwd = payload.cwd ? canonPath(payload.cwd) : payload.cwd;
  if (!cwd) return [];
  // OUR command's snapshot: the oldest one taken of this same tree, consumed as it is read. Taking
  // "the manifest" unconditionally is what let a subtree walk diff against a repo-root snapshot.
  const claim = claimBashManifest(session, cwd, payload.tool_use_id);
  if (!claim) return [];
  const manifest = claim.manifest;
  const afterLeases: string[] = [];
  try {
  const before = manifest.files;
  const cache = readBashStatCache(session);
  const blobs = blobPresence(session);
  /**
   * Empty-file appearances and disappearances this command produced.
   *
   * The Bash walk INFERS edits from a before/after tree diff, so it sees every side effect of a
   * command, not only what the agent meant to change. A file that goes from absent to zero bytes (or
   * back) is the degenerate case: there is no content, so the diff is empty, and the row renders as
   * "+0 −0" with nothing behind it. One real session — `install neovim`, run from the home directory
   * — produced 2,241 of these out of 2,446 records: postgres relation stubs from `initdb`, plus
   * `.Xauthority`, `.tig_history`, `btmp`. 91.6% of the review list was rows with nothing to review.
   *
   * Counted, not swallowed: one marker per command says how many there were. Edit / Write /
   * NotebookEdit are untouched — a zero-byte file Claude created ON PURPOSE is a real edit.
   */
  let emptyNoise = 0;
  /** Directories this command actually recorded into — what the ignore sweep must stamp. The walk
   *  reaches any depth under cwd, so cwd alone is not the answer (see `editedDirs`). */
  const wrote = new Set<string>();
  /** file → the content this command recorded for it, so every other pending snapshot of this tree
   *  can be advanced past it (see `advancePendingManifests`). */
  const recorded = new Map<string, string | null>();
  // The tree's after-state, hashed under ONE hold of the session lock — as the Pre does — with one GC
  // lease for every blob that changed, so a concurrent GC cannot collect an after-blob before its
  // record lands. Taking the lock once per file cost four syscalls a file: about 105 ms per command
  // near the 4,000-file cap. The records are appended after the lock is released (appendLog takes it).
  const after = new Map<string, string | null>();
  const ok = withBashPreLock(session, () => {
    const complete = walkCandidates(cwd, (abs) => {
      if (isSecretName(path.basename(abs))) return; // symmetric with Pre: secrets are out of scope
      after.set(abs, cachedSnapshotHash(session, abs, cache, blobs));
    });
    const changed: Record<string, string> = {};
    for (const [abs, sha] of after) if (sha && sha !== before[abs]) changed[abs] = sha;
    if (Object.keys(changed).length) afterLeases.push(writeSnapshotLease(session, changed));
    return complete;
  });
  for (const [abs, afterBlob] of after) {
    if (afterBlob === null) {
      if (before[abs]) appendSkip(session, abs, 'Bash result is unreadable, binary, or oversized; change not captured');
      continue;
    }
    const beforeBlob = Object.prototype.hasOwnProperty.call(before, abs) ? before[abs] : null;
    if (!(abs in before) && !snapshotProvesAbsent({ files: new Map(), root: cwd, complete: manifest.complete ?? false, excluded: manifest.excluded }, abs)) {
      appendSkip(session, abs, 'Bash before-state is excluded or unknown; refusing to infer file creation');
      continue;
    }
    if (beforeBlob === afterBlob) continue; // unchanged — no edit
    if (beforeBlob === null && afterBlob === EMPTY_BLOB) { emptyNoise++; continue; }
    if (blankLineOnly(session, beforeBlob, afterBlob)) continue; // blank-line churn is not a review unit
    wrote.add(path.dirname(abs));
    recorded.set(abs, afterBlob);
    // Attributed to the EDIT TOOL when one is mid-flight on this file (staging exists only between an
    // Edit/Write/MultiEdit's Pre and its Post). The walk is the capture that has to win — its snapshot
    // is consumed and cannot be replayed, so it never defers — but the row would otherwise blame
    // `Bash` for a change an edit tool made, purely because a backgrounded command's Post happened to
    // land first. That call's own Post then finds its end state already recorded and declines.
    const inflight = readStaging(session, pathKey(abs));
    appendLog(session, {
      ts: Date.now(),
      tool: inflight?.tool || 'Bash',
      file: abs,
      beforeBlob,
      afterBlob,
      status: 'pending',
      source: 'hook',
      ...captureMetadata(payload),
      beforeState: beforeBlob === null ? 'absent' : 'present',
      provenance: 'snapshot', attribution: 'interval', captureStartMs: manifest.ts,
      ...(blobIsBinary(session, afterBlob) || blobIsBinary(session, beforeBlob) ? { binary: true as const } : {}),
    });
  }
  // Deletions: present before, gone now. Only trust this when the post-walk wasn't truncated.
  if (ok) {
    for (const abs of Object.keys(before)) {
      if (after.has(abs) || before[abs] === null) continue;
      // STILL ON DISK — so this walk simply never visited it, and "deleted" would be a lie. The walk
      // does not reach everything under its root: it refuses to descend `BASH_SKIP_DIRS`, symlinked
      // directories and unreadable ones. A snapshot can hold such a key because a command running in
      // a SUBDIRECTORY recorded a change there and every pending snapshot containing that file was
      // advanced past it — so an ancestor's Post, whose own walk skips `build/`, would report the
      // file gone. The pair then chains into "file deleted", and undoing the real change refuses as
      // a conflict: the exact failure the advance exists to prevent. One stat per unseen key, and
      // only for keys a walk did not reach.
      if (snapshot(abs).kind !== 'missing') continue;
      if (before[abs] === EMPTY_BLOB) {
        emptyNoise++; // symmetric with the creation case: an empty file removed has nothing to review
        continue;
      }
      wrote.add(path.dirname(abs));
      recorded.set(abs, null);
      appendLog(session, {
        ts: Date.now(),
        tool: 'Bash',
        file: abs,
        beforeBlob: before[abs],
        afterBlob: null,
        status: 'pending',
        source: 'hook',
        ...captureMetadata(payload),
        beforeState: 'present',
        provenance: 'snapshot', attribution: 'interval', captureStartMs: manifest.ts,
        ...(blobIsBinary(session, before[abs]) ? { binary: true as const } : {}),
      });
    }
  }
  if (!ok) {
    // The walk stopped at the file cap, so "present before, gone now" cannot be told from "never
    // reached" — the deletion pass above is skipped. Say so: a command that removed a file and left
    // no record of it is exactly the silent miss this store refuses to ship.
    appendSkip(
      session,
      '<bash-tree>',
      `Bash working tree exceeds ${BASH_MAX_FILES} files — deletions by this command were not captured${walkOverflowNote()}`
    );
  }
  if (emptyNoise) {
    appendSkip(
      session,
      '<bash-empty>',
      `${emptyNoise} zero-byte file(s) appeared or vanished while this command ran — no content to review, so they were not recorded`
    );
  }
  if (ok) pruneStatCache(cache, cwd, after);
  writeBashStatCache(session, cache);
  // NOT deleteBashManifest: `takeBashManifest` already consumed OURS, and wiping the rest would
  // destroy the snapshot an overlapping command is about to diff against — the second half of the
  // shared-manifest bug (its partner then captured nothing at all, silently).
  //
  // Instead, move those snapshots' baseline past what this command just recorded, or the overlapping
  // Post records the SAME change again — two identical rows, the second of which makes undoing the
  // first refuse as a conflict.
  advancePendingManifests(session, recorded);
  return [...wrote];
  } finally {
    claim.release();
    for (const token of afterLeases) releaseSnapshotLease(session, token);
  }
}

/**
 * How long a hook waits for its session's capture mutex before it gives up and leaves a skip marker.
 * Only concurrent captures in ONE session ever wait (subagents share their parent's id). With 16 agents
 * capturing at once on a 3,936-file tree (measured 2026-09-26): 5 s dropped 11 captures in 12 runs, a
 * longer budget for Posts alone still dropped Pres, 10 s for every event dropped none in 8 runs but one
 * hook took 9.7 s, and 15 s dropped none in 14 runs. A lone agent's hooks never wait at all.
 */
const CAPTURE_MUTEX_BUDGET_MS = 15_000;

/** The session's capture mutex (a `withFileMutation` key): every edit record is appended under it. */
export const captureMutex = (session: string): string => path.join(storeDir(session), '__capture-operation');

/**
 * Record one hook payload — the EXACT logic the Pre/PostToolUse hooks run (staging, blobs, appendLog),
 * exposed so the demo simulator can drive the real pipeline in-process (its keep/undo/task ops then
 * work on genuinely captured edits). Never throws, never writes stdout. `eventMs` is when the hook
 * started (see noteToolCall); the hook process passes its own start.
 */
export function handleHookPayload(payload: HookPayload, eventMs = Date.now()): void {
  if (!payload.session_id) return;
  // Who is waiting on the reader is settled first: before any capture filtering (the Bash opt-out, the
  // captured-tool checks, the capture mutex), under a lock of its own, so a permission prompt never
  // queues behind another call's tree walk. The Codex adapter settles a tool call itself, on the call's
  // own payload, before it fans an apply_patch out into per-file payloads.
  if (!(TOOL_EVENTS.has(payload.hook_event_name ?? '') && payload.runtime === 'codex')) {
    try { noteAttention(payload, eventMs); } catch { /* attention is a convenience, never worth failing a hook over */ }
  }
  const run = () => handleHookPayloadUnlocked(payload);
  try {
    withFileMutation(captureMutex(payload.session_id), run, CAPTURE_MUTEX_BUDGET_MS);
  } catch (e) {
    // Retain staged bytes and report an incomplete capture; never rerun a partially executed
    // transaction without its mutex. appendSkip has independent durable storage on contention.
    try { appendSkip(payload.session_id, '<capture>', String((e as Error).message)); } catch {}
  }
}

/** The terminal app's native tab this session runs in. The app exports
 *  `OAK_TAB=<tab>@<pid>` into a `+` tab's PTY; the agent's hooks inherit it; the first hook records
 *  it here — the exact tab↔session link the auto-title and the tab's state dot read. Re-written when
 *  the tab differs (a conversation resumed in another tab moves with it); the pid in the id keeps a
 *  restarted app from inheriting an old link. */
function tabLinkPath(session: string): string {
  return path.join(storeDir(session), 'tab.json');
}
export function linkTab(session: string, kind?: 'codex', sessionStartSource?: string): void {
  linkHerdrPane(session, kind, sessionStartSource);
  const tab = process.env.OAK_TAB;
  if (!tab) return;
  try {
    if (readTabLink(session) === tab) return;
    fs.mkdirSync(storeDir(session), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tabLinkPath(session), JSON.stringify({ tab, at: Date.now() }), { mode: 0o600 });
  } catch {
    /* the link is a convenience */
  }
}
export function readTabLink(session: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(tabLinkPath(session), 'utf8')) as { tab?: unknown };
    return typeof j.tab === 'string' && j.tab ? j.tab : null;
  } catch {
    return null;
  }
}

/** Hook events that report one tool call. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

/** What one Claude Code hook says about who is waiting on the reader (codex.ts records the Codex twin). */
function noteAttention(payload: HookPayload, eventMs: number): void {
  const session = payload.session_id!;
  const ev = payload.hook_event_name;
  if (ev && TOOL_EVENTS.has(ev)) {
    noteToolCall(session, payload, eventMs);
  } else if (ev === 'Notification') {
    // Claude Code's own attention moments — "needs your permission to…", "waiting for your
    // input" — recorded per session so every surface can say WHO is waiting without polling
    // anything (multiple sessions need a way to raise a hand).
    // Classified by the STRUCTURED `notification_type` when Claude Code sends one (2.1.x), so a
    // reworded or localized message cannot misfile a wait; the prose regex is the fallback for a
    // build that omits the field, and for a type this code does not know (a future wait must
    // still raise a hand). Types that are not a wait at all — a sign-in, a quota resume, an
    // elicitation that already completed, a background agent finishing — leave the standing
    // state alone: none of them is the user's move (2026-09-15).
    const n = payload as { message?: unknown; notification_type?: unknown };
    const msg = String(n.message ?? '');
    const type = typeof n.notification_type === 'string' ? n.notification_type : '';
    const kind: AttentionState['kind'] | null =
      type === 'permission_prompt' ? 'permission'
      : NOT_A_WAIT.has(type) ? null
      : type === 'idle_prompt' || type === 'agent_needs_input' || type.startsWith('elicitation_') ? 'input'
      : /permission/i.test(msg) ? 'permission'
      : 'input';
    if (kind) writeAttention(session, { kind, message: msg, ts: Date.now() });
  } else if (ev === 'PermissionRequest') {
    // The structured twin of a permission Notification (2026-09-15): it names the TOOL the prompt
    // waits on — the same shape codex writes from its own PermissionRequest, so a toast can say
    // "waiting for you — Bash" on either agent — and the call, so that call's result lowers it.
    // Request-only, like codex: NOTHING goes to stdout (an empty reply is the documented "no
    // decision"); observation must never adjudicate.
    writeAttention(session, { kind: 'permission', message: String(payload.tool_name ?? 'tool'), ts: Date.now() }, toolCallKey(payload));
  } else if (ev === 'SessionEnd' || ev === 'UserPromptSubmit') {
    // SessionEnd: the session is over, and a hand still raised (a permission prompt, a question)
    // would otherwise stay up forever, the observatory saying it waits for the person.
    // UserPromptSubmit: the turn begins, and the prompt itself answers whatever the session waited
    // on (codex's UserPromptSubmit lowers the hand the same way).
    clearAttention(session);
  } else if (ev === 'Stop') {
    // The turn ended: done, waiting for the user. Quiet state — surfaces show it, never toast it.
    writeAttention(session, { kind: 'idle-done', message: '', ts: Date.now() });
  }
}

function handleHookPayloadUnlocked(payload: HookPayload): void {
  try {
    const session = payload.session_id;
    if (!session) return;
    linkTab(session);
    const isBash = payload.tool_name === 'Bash';
    if (isBash && process.env.CLAUDE_OBSERVATORY_NO_BASH) return; // opt-out escape hatch
    if (payload.hook_event_name === 'PreToolUse') {
      if (isBash) handlePreBash(session, payload);
      else handlePre(session, payload);
    } else if (payload.hook_event_name === 'UserPromptSubmit') {
      // A turn boundary: the session's title may have changed, so its herdr tab follows it (detached).
      // Silent on stdout — for THIS event Claude Code feeds a hook's stdout to the model as context.
      kickTabSync(session);
    } else if (payload.hook_event_name === 'Stop') {
      // A Pre whose tool was denied/failed/interrupted left a before-snapshot behind. No tool call
      // outlives the turn, so drop any abandoned Pre staging now — otherwise its id-suffixed key makes
      // every later edit of that file read as an overlapping tool call (ambiguous → review-only) and
      // keeps the session permanently un-reapable. See clearAbandonedToolStaging.
      clearAbandonedToolStaging(session);
      kickTabSync(session);
    } else if (payload.hook_event_name === 'PostToolUseFailure' && !isBash) {
      // A file tool that FAILED wrote nothing: it validates before it writes, and Claude Code's Edit
      // and Write throw "File content has changed since it was last read" when the file changed after
      // the model read it. So anything that differs from the Pre snapshot now is someone else's
      // change — typically a person fixing the same lines while the permission prompt was open — and
      // recording it as this call's edit let `oak undo` delete their work. The Pre snapshot is
      // dropped, so a retry in the same turn is one clean edit.
      discardPre(session, payload);
    } else if (payload.hook_event_name === 'PostToolUse' || payload.hook_event_name === 'PostToolUseFailure') {
      // PostToolUseFailure is Claude Code's Post for a tool that FAILED. For a Bash command (a
      // non-zero exit, an interrupt) whatever it changed before it failed is just as real, and its
      // Pre snapshot is claimed by this event or by nothing: unclaimed, the changes were never
      // recorded and the manifest lingered for a day, re-read by every later Post.
      // The directories the capture actually wrote into. A Bash walk reports its own, because only
      // it knows how deep beneath cwd the command reached.
      const touched = isBash ? handlePostBash(session, payload) : (handlePost(session, payload), editedDirs(payload));
      // Records written BEFORE a rule existed are the one case the refusal in `resolveFile` cannot
      // reach, so they are swept here. On the WRITE path deliberately: a read path is called dozens
      // of times per refresh by several processes at once, and a read that rewrites the store would
      // race every other reader. Gated on a stamp of the ignore files this session's directories can
      // see, so it rewrites once per rule change rather than once per edit — and it reports through a
      // control op, never through stdout (see the note at the top of this file).
      sweepIgnoredIfChanged(session, [...editedDirs(payload), ...touched]);
    }
  } catch (error) {
    // No hook output, but leave local evidence whenever the store permits it.
    try { if (payload.session_id) appendSkip(payload.session_id, '<capture>', `Capture failed: ${String((error as Error).message)}`); } catch { /* unavailable store */ }
  }
}

/**
 * Read the hook payload from stdin and record the edit. Never throws, never writes stdout.
 * The caller is responsible for exit(0).
 */
/** Notification types that are NOT a wait on the user: a hand must not go up for them, and one
 *  already up (a permission prompt still showing) must not come down. Anything else unknown falls
 *  through to the prose classifier above, so a wait type added later still raises a hand. */
const NOT_A_WAIT = new Set([
  'auth_success',
  'agent_completed',
  'elicitation_complete',
  'elicitation_response',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
]);

/** One tiny file per session: what the agent is waiting on right now. Written by the
 *  Notification/PermissionRequest/Stop hooks above, cleared the moment a tool runs again, the call a
 *  permission prompt waits on returns, or a new prompt lands (UserPromptSubmit). */
export interface AttentionState {
  kind: 'permission' | 'input' | 'idle-done';
  message: string;
  ts: number;
}

/** attention.json as stored: a permission prompt also keeps the calls it waits on (toolCallKey), more
 *  than one while prompts for parallel calls are up at once. Kept out of readAttention's answer. */
interface StoredAttention extends AttentionState {
  calls?: string[];
}

function attentionPath(session: string): string {
  return path.join(storeDir(session), 'attention.json');
}

/** How long a hook waits for another hook's change to attention.json. Each holds the lock for a read
 *  and a write, so only a stuck or crashed holder (broken as stale after LOCK_STALE_MS) is ever waited on. */
const ATTENTION_LOCK_BUDGET_MS = 2000;

/** Change one session's attention.json under a lock: every hook of every agent may change it at once,
 *  and a read-modify-write that raced another would lower the hand a newer prompt raised meanwhile. */
function withAttention(session: string, change: () => void): void {
  try {
    fs.mkdirSync(storeDir(session), { recursive: true, mode: 0o700 });
    withFileMutation(attentionPath(session), change, ATTENTION_LOCK_BUDGET_MS);
  } catch {
    /* attention is a convenience, never worth failing a hook over */
  }
}

/** Replace attention.json atomically, so a surface (or a hook's unlocked first look) never reads a torn file. */
function writeStored(session: string, a: StoredAttention): void {
  const file = attentionPath(session);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(a), { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}

/** Lower the standing hand: the ledger closes the wait, then the file goes. */
function lowerHand(session: string, a: StoredAttention | null): void {
  if (a && a.kind !== 'idle-done') ledgerAppend(session, { ev: 'down', kind: a.kind, since: a.ts, t: Date.now() });
  try { fs.unlinkSync(attentionPath(session)); } catch { /* gone meanwhile */ }
}

/** Object keys in sorted order at every depth, so two serializations of one input compare equal. */
const sortedKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortedKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys((v as Record<string, unknown>)[k])]))
  : v;

/**
 * One tool call, as its permission prompt and its result both name it. Neither agent puts the call's
 * id on PermissionRequest (Claude Code 2.1.283's input and Codex 0.156.1's `permission-request` schema
 * both lack `tool_use_id`), so the key is what both events carry: the turn (Codex `turn_id`, Claude
 * `prompt_id`), the tool and its input, key order aside — less a Bash call's `description`, which
 * Codex adds to the prompt (its approval reason) and not to the call.
 */
export function toolCallKey(p: { turn_id?: string; prompt_id?: string; tool_name?: string; tool_input?: unknown }): string {
  const input = p.tool_name === 'Bash' && p.tool_input && typeof p.tool_input === 'object' && !Array.isArray(p.tool_input)
    ? { ...(p.tool_input as Record<string, unknown>), description: undefined }
    : p.tool_input;
  const identity = JSON.stringify([p.turn_id ?? p.prompt_id ?? '', p.tool_name ?? '', sortedKeys(input ?? null)]);
  return crypto.createHash('sha1').update(identity).digest('hex').slice(0, 16);
}

/**
 * A tool call's hook, for attention, before any capture filtering — every tool Codex reports, and the
 * edit tools and Bash that Claude Code's capture hooks match. Its start is the agent acting again:
 * whatever it waited on is answered. Its result (PostToolUse, or PostToolUseFailure for a call that
 * failed) answers the permission prompt raised for that same call — never another's, never a question
 * — and shows a turn that had ended is running again (a Stop hook continued it; Codex can deliver a
 * command's result through a later poll that has no start of its own). `eventMs` is when the hook
 * started (the hook process's own start), and neither ever lowers a hand raised after it: a parallel
 * call's hook that ran late, or one that waited on a lock, is not progress past a newer prompt.
 */
export function noteToolCall(session: string, p: HookPayload & { turn_id?: string }, eventMs: number): void {
  if (p.hook_event_name === 'PreToolUse') {
    clearAttention(session, eventMs);
    return;
  }
  let key: string | undefined;
  const answered = (a: StoredAttention | null): boolean =>
    !!a && (a.kind === 'idle-done' ? a.ts <= eventMs : a.kind === 'permission' && !!a.calls?.includes((key ??= toolCallKey(p))));
  if (!answered(readStored(session))) return; // no hand, or not this call's: no lock taken
  withAttention(session, () => {
    const a = readStored(session);
    if (!answered(a)) return;
    const rest = a!.calls?.filter((k) => k !== key) ?? [];
    if (a!.kind === 'permission' && rest.length) writeStored(session, { ...a!, calls: rest });
    else lowerHand(session, a);
  });
}

/** The append-only ledger of waits: `up` when a hand goes up, `down` (with the `since` it went up)
 *  when it comes down — what "left waiting on you today" is summed from. Two lines per wait. */
function ledgerPath(session: string): string {
  return path.join(storeDir(session), 'attention-log.jsonl');
}
function ledgerAppend(session: string, e: { ev: 'up'; kind: string; t: number } | { ev: 'down'; kind: string; since: number; t: number }): void {
  try {
    fs.appendFileSync(ledgerPath(session), JSON.stringify(e) + '\n', { mode: 0o600 });
  } catch {
    /* the ledger is a convenience too */
  }
}

/** A message that is a bare tool name (`Bash`), as PermissionRequest reports, rather than prose. */
const isToolName = (s: string): boolean => !!s && !/\s/.test(s);

/** Raise (or restate) a hand. `call` is the permission prompt's call (toolCallKey), when the event names one. */
export function writeAttention(session: string, state: AttentionState, call?: string): void {
  withAttention(session, () => {
    const prev = readStored(session);
    const standing = prev && prev.kind !== 'idle-done' ? prev : null;
    let next: StoredAttention = state;
    if (state.kind !== 'idle-done') {
      // One prompt is one hand. A report that names no call (Notification never does), a standing hand
      // that names none, or the same call named again, is the SAME prompt; a different call's prompt is
      // a new hand, and the calls still standing stay with it (parallel calls can each have one up).
      const calls = [...(standing?.calls ?? []), ...(call && !standing?.calls?.includes(call) ? [call] : [])];
      if (standing && standing.kind === state.kind && (!call || !standing.calls?.length || standing.calls.includes(call))) {
        // The SAME wait reported twice — PermissionRequest and Notification both fire for one
        // prompt (2026-09-15). Keep the ORIGINAL ts: every surface announces once per ts, and a
        // fresh stamp here would toast the same prompt again. Keep the tool name over the prose
        // ("Bash" says more than "Claude needs your permission"), whichever arrived first.
        next = { kind: state.kind, message: isToolName(standing.message) && !isToolName(state.message) ? standing.message : state.message || standing.message, ts: standing.ts };
      } else {
        if (standing) ledgerAppend(session, { ev: 'down', kind: standing.kind, since: standing.ts, t: state.ts });
        ledgerAppend(session, { ev: 'up', kind: state.kind, t: state.ts });
      }
      if (state.kind === 'permission' && calls.length) next = { ...next, calls };
    } else if (standing) {
      ledgerAppend(session, { ev: 'down', kind: standing.kind, since: standing.ts, t: state.ts });
    }
    writeStored(session, next);
  });
}

/** Lower the hand. `eventMs`: a tool call's start lowers only a hand raised before it (noteToolCall);
 *  a prompt or a session's end lowers any. */
export function clearAttention(session: string, eventMs = Infinity): void {
  const standing = readStored(session);
  if (standing ? standing.ts > eventMs : !fs.existsSync(attentionPath(session))) return; // no lock taken
  withAttention(session, () => {
    const a = readStored(session);
    if (!a || a.ts <= eventMs) lowerHand(session, a);
  });
}

/** Milliseconds this session spent waiting on the reader since `sinceMs`: every closed wait in the
 *  ledger clipped to the window, plus the hand standing right now. */
export function waitedMs(session: string, sinceMs: number, now = Date.now()): number {
  let total = 0;
  try {
    for (const line of fs.readFileSync(ledgerPath(session), 'utf8').split('\n')) {
      if (!line) continue;
      let e: { ev?: string; t?: number; since?: number };
      try {
        e = JSON.parse(line) as typeof e;
      } catch {
        continue;
      }
      if (e.ev === 'down' && typeof e.t === 'number' && typeof e.since === 'number' && e.t >= sinceMs) total += Math.max(0, e.t - Math.max(e.since, sinceMs));
    }
  } catch {
    /* no ledger yet */
  }
  const a = readAttention(session);
  if (a && a.kind !== 'idle-done') total += Math.max(0, now - Math.max(a.ts, sinceMs));
  return total;
}

function readStored(session: string): StoredAttention | null {
  try {
    const raw = JSON.parse(fs.readFileSync(attentionPath(session), 'utf8')) as StoredAttention;
    if (raw && (raw.kind === 'permission' || raw.kind === 'input' || raw.kind === 'idle-done') && typeof raw.ts === 'number') {
      const calls = Array.isArray(raw.calls) ? raw.calls.filter((k): k is string => typeof k === 'string') : [];
      return { kind: raw.kind, message: String(raw.message ?? ''), ts: raw.ts, ...(calls.length ? { calls } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}

export function readAttention(session: string): AttentionState | null {
  const a = readStored(session);
  return a && { kind: a.kind, message: a.message, ts: a.ts };
}

export function runCapture(): void {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return;
    // The hook process's own start is when its event happened, however long it then waited (stdin, a lock).
    handleHookPayload(JSON.parse(raw) as HookPayload, performance.timeOrigin);
  } catch {
    // Silent by design: capture must never block, slow, or perturb an edit.
  }
}
