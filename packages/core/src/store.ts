/**
 * Git-free, content-addressed snapshot store for Claude Observatory.
 *
 * Layout:  ~/.claude/claude-observatory/<session_id>/
 *   log.jsonl            append-only: EditRecord lines + status-op lines (`{op:"status",id,status}`)
 *   blobs/<sha256>       whole-file snapshots, content-addressed (deduped)
 *   staging/<pathHash>   transient "before" snapshot between PreToolUse and PostToolUse
 *
 * The log is strictly append-only — status changes are appended as ops and folded in on read, so a
 * front-end updating a status never rewrites the file and so cannot race-drop a record the capture
 * hook appends concurrently.
 *
 * Pure local filesystem — no network, no model calls, zero tokens.
 */
import * as fs from 'fs';
import { cachedByFiles, readText } from './fscache';
import * as path from 'path';
import * as crypto from 'crypto';
import { claudeConfigDir, canonPath } from './paths';
import { ignoreContextFor, ignoreStamp } from './ignore';
import { readPrefs, expandHome, prefsPath } from './prefs';

/**
 * Loop-based min/max over a numeric array — the call-stack-safe replacement for `Math.min(...xs)` /
 * `Math.max(...xs)`, which spread the entire array as call arguments and throw `RangeError` once it
 * exceeds the engine's argument cap (~65-125k elements). Empty input yields Math's identity value
 * (Infinity / -Infinity), so an existing `xs.length ? minOf(xs) : fallback` guard keeps its fallback.
 */
export function minOf(nums: number[]): number {
  let m = Infinity;
  for (const n of nums) if (n < m) m = n;
  return m;
}
export function maxOf(nums: number[]): number {
  let m = -Infinity;
  for (const n of nums) if (n > m) m = n;
  return m;
}

export type EditStatus = 'pending' | 'kept' | 'undone';

export interface EditRecord {
  /** Monotonic per-session integer id — short and typeable for `diff <id>` / `undo <id>`. */
  id: number;
  /**
   * Collision-proof per-record token (pid + hrtime + counter), decoupled from the small display `id`.
   * Two capture processes that both fail the best-effort append lock can append the same display `id`;
   * `uid` never collides, so readLog can deterministically reconcile a duplicate display id (§2.7).
   * `appendLog` stamps one on every new record. Optional because records written before this field
   * existed (and synthetic/derived records) lack it — reconciliation keys on append order, so a missing
   * `uid` is tolerated.
   */
  uid?: string;
  /** ms epoch when the edit was committed (PostToolUse). */
  ts: number;
  /** Edit | Write | MultiEdit | NotebookEdit */
  tool: string;
  /** Absolute path of the edited file. */
  file: string;
  /** sha256 of the file BEFORE the edit, or null if the file did not exist (new-file Write). */
  beforeBlob: string | null;
  /** sha256 of the file AFTER the edit, or null if the edit deleted the file. */
  afterBlob: string | null;
  status: EditStatus;
  /**
   * Which prompt caused this edit. On the hooks path it is the harness's own `prompt_id` (Claude
   * Code ≥2.1.196 — absent before the first user input and on older builds, and absence is
   * tolerated like `uid`'s). On the ACP path it is the drive's per-prompt counter. Optional:
   * records from before this field simply lack it.
   */
  promptId?: string;
  /** Where this record came from. Absent means 'hook' — every record predating the ACP path. */
  source?: 'hook' | 'acp';
  /** The ACP session this record was ingested from, for records with source 'acp'. */
  acpSessionId?: string;
  /**
   * True when the ACP agent sent only the NEW content of the file (`oldText` absent from the typed
   * diff). LOAD-BEARING, not descriptive: such a record stores `beforeBlob: null` — which on its
   * own means "the file did not exist", a shape whose undo DELETES the file. `partial` says the
   * before-state is UNKNOWN rather than known-absent, so undo refuses with the stated reason and
   * the record stays review-only. This is the lower-fidelity ACP tier made visible.
   */
  partial?: true;
  toolCallId?: string;
  nativeTurnId?: string;
  runtime?: string;
  provider?: string;
  model?: string;
  /** Exact tool evidence or a disk interval that may include other writers. */
  provenance?: 'tool' | 'snapshot';
  attribution?: 'correlated' | 'interval' | 'ambiguous';
  /** The captured content is binary (a PDF, an image, a compiled asset), so it has no line diff — the
   *  review surfaces show a byte-size summary instead. The blob store holds the exact bytes either way;
   *  this is a render hint, and the diff renderers also detect a binary blob defensively. */
  binary?: true;
  captureStartMs?: number;
  uncertainty?: string;
  beforeState?: 'present' | 'absent' | 'unknown';
}

/** Transient record written by PreToolUse, consumed by PostToolUse. */
export interface StagingRecord {
  file: string;
  tool: string;
  beforeBlob: string | null;
  ts?: number;
  toolCallId?: string;
  ambiguous?: boolean;
  /**
   * The after-snapshot, once PostToolUse has written it but BEFORE it has appended the record.
   *
   * In that window the blob is referenced by nothing: not the log (no record yet) and not the staging
   * record (which only knew the before side). A maintenance pass in between — `clean`, or the GC that
   * `clearResolved`/`clearResolvedIds` run — collected it, and the append then wrote a record pointing
   * at a blob that no longer existed: `lineDelta` silently reported the edit as a pure deletion and
   * `undo` threw ENOENT. Publishing it here first makes gcSessionCore treat it as live, exactly as it
   * already does for `beforeBlob`. Absent until PostToolUse gets that far.
   */
  afterBlob?: string | null;
}

/**
 * WHERE THE STORE LIVES — the one seam every other path derives from.
 *
 * `prefs.storeDir` wins, then the default beside the Claude config. Memoized for the life of the
 * process: this is called on the capture hook's hot path and by every read, and re-reading prefs.json
 * each time would put a file read in front of every store operation. `writePrefs` clears it, so a
 * change made in-process (the options window) takes effect immediately; a different process picks it
 * up when it starts, which is exactly when it reads its preferences anyway.
 */
let rootMemo: { under: string; dir: string } | null = null;
export function rootDir(): string {
  // KEYED ON THE CONFIG DIR, not memoized outright. `CLAUDE_CONFIG_DIR` can change inside one
  // process — the test suite does it between cases, and a caller may point the CLI elsewhere — and an
  // unkeyed memo answered with the previous config dir's store for the rest of the process. The key
  // costs an env read and a join, never a file read, so the hot path is unchanged.
  const under = claudeConfigDir();
  if (rootMemo && rootMemo.under === under) return rootMemo.dir;
  let chosen = '';
  try {
    chosen = readPrefs(path.join(under, 'claude-observatory', 'prefs.json')).storeDir ?? '';
  } catch {
    /* an unreadable prefs file means "no preference", never a broken store */
  }
  const dir = chosen ? expandHome(chosen) : path.join(under, 'claude-observatory');
  rootMemo = { under, dir };
  return dir;
}

/** Forget the memoized root — `writePrefs` calls this, so a location set in-process takes effect at once. */
export function clearRootMemo(): void {
  rootMemo = null;
}

/**
 * Move the store to `to`, and report what happened.
 *
 * A setting that changed where NEW data goes while leaving the old data behind would strand a
 * session's history somewhere the product no longer looks — so the move is part of the setting, not
 * a follow-up chore. Refuses rather than merges when the target already holds a store: two stores
 * merged by filename would interleave two machines' sessions with no way to tell them apart.
 */
export function moveStore(to: string): { moved: true; from: string; to: string } | { error: string } {
  const from = rootDir();
  const dest = expandHome(to);
  if (path.resolve(dest) === path.resolve(from)) return { error: 'the store is already there' };
  // Never move a store INTO itself — `mv a a/b` is a filesystem no-op at best and a loop at worst.
  if (path.resolve(dest).startsWith(path.resolve(from) + path.sep)) {
    return { error: 'that is inside the current store — pick a directory outside it' };
  }
  try {
    // `prefs.json` does not count as store data — see the note below. Ignoring it here is what makes
    // "put it back where it was" work: the default location always holds the preferences file.
    if (fs.existsSync(dest) && fs.readdirSync(dest).some((f) => f !== 'prefs.json')) {
      return { error: `${dest} is not empty — pick an empty or new directory, so two stores are never merged` };
    }
  } catch (e) {
    return { error: `cannot read ${dest}: ${String((e as Error)?.message || e)}` };
  }
  /**
   * THE PREFERENCES ARE NOT STORE DATA, but they live in the same directory.
   *
   * `prefsPath()` is `<claude config>/claude-observatory/prefs.json` and the DEFAULT store root is
   * that same directory — so moving the store renamed the preferences file away with it, and the
   * `writePrefs` that recorded the new location then wrote a fresh file containing only `storeDir`.
   * Every other setting — keybindings, colours, the configured machines — was silently destroyed by
   * the act of choosing where to keep data. Reproduced before this was written: one configured
   * machine went in, and `remotes` reported none afterwards.
   *
   * So the file is carried across by hand: read before, restored after, and the copy that travelled
   * inside the store removed so there is never a second one to disagree with.
   */
  const prefsFile = prefsPath();
  let carried: Buffer | null = null;
  if (path.dirname(prefsFile) === path.resolve(from)) {
    try {
      carried = fs.readFileSync(prefsFile);
    } catch {
      /* no preferences yet — nothing to carry */
    }
  }
  if (!fs.existsSync(from)) {
    // Nothing to move: honour the setting and create the new home. Not an error — a fresh install
    // choosing its location before capturing anything is the easiest case, not a failure.
    try {
      fs.mkdirSync(dest, { recursive: true });
      return { moved: true, from, to: dest };
    } catch (e) {
      return { error: `cannot create ${dest}: ${String((e as Error)?.message || e)}` };
    }
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(from, dest);
  } catch {
    // Across filesystems rename fails with EXDEV; copy, verify, then remove. The original is deleted
    // only after the copy is on disk, so an interrupted move leaves the store readable at one end or
    // the other — never half at each.
    try {
      fs.cpSync(from, dest, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    } catch (e) {
      return { error: `could not move the store: ${String((e as Error)?.message || e)}` };
    }
  }
  if (carried) {
    try {
      fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
      fs.writeFileSync(prefsFile, carried);
      const travelled = path.join(dest, 'prefs.json');
      if (path.resolve(travelled) !== path.resolve(prefsFile)) fs.rmSync(travelled, { force: true });
    } catch {
      /* best-effort: the store moved, and the settings are recoverable from the moved copy */
    }
  }
  clearRootMemo();
  return { moved: true, from, to: dest };
}

/**
 * A store session id must be a single, safe path segment (real ids are Claude Code UUIDs). This is
 * the guard against a crafted `--session`/`--drop` value escaping the store via `..` — the sink is a
 * recursive, forced rmSync in removeSession. `..`/`.` are rejected explicitly (they pass the class).
 */
export function isSafeSessionId(id: string): boolean {
  return typeof id === 'string' && id !== '.' && id !== '..' && /^[A-Za-z0-9._-]{1,128}$/.test(id);
}

export function storeDir(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  return path.join(rootDir(), sessionId);
}

function blobsDir(sessionId: string): string {
  return path.join(storeDir(sessionId), 'blobs');
}

const storeBytesCache = new Map<string, { key: string; bytes: number }>();
/**
 * Total on-disk bytes a session's store occupies: the append-only log, every content snapshot (blobs),
 * and any transient staging. This is what holding a session's pending edits COSTS in storage — shown in
 * the session picker so a reader can see it grow over time. 0 for a session with no
 * store (a conversation that only asked and read changed nothing on disk).
 *
 * Cached on the store's shape — the log's size+mtime and the blobs and staging dir mtimes — so a re-list
 * is a few stats when nothing changed and a full walk runs only after the store actually changed. Blobs
 * are immutable and content-addressed, so their mtime moving is exactly "a snapshot was added or reaped".
 * The total is kept in the session's `session-meta` sidecar as well as in memory: every `oak sessions`
 * is a fresh process, and re-stating every blob of every session cost 77 ms of a 537 ms listing on one
 * real store (13,575 blobs).
 */
export function storeBytes(sessionId: string): number {
  let dir: string;
  try {
    dir = storeDir(sessionId);
  } catch {
    return 0; // an invalid id has no store
  }
  try {
    const logStat = fs.statSync(path.join(dir, 'log.jsonl'));
    const mtimeOf = (sub: string): number => {
      try {
        return fs.statSync(path.join(dir, sub)).mtimeMs;
      } catch {
        return 0; // no such dir yet — the log alone is the store
      }
    };
    const key = `${logStat.size}:${logStat.mtimeMs}:${mtimeOf('blobs')}:${mtimeOf('staging')}`;
    const hit = storeBytesCache.get(sessionId);
    if (hit && hit.key === key) return hit.bytes;
    const sidecar = path.join(rootDir(), 'session-meta', `${sessionId}.json`);
    let side: Record<string, unknown> = {};
    try {
      const j = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) side = j;
      const kept = side.storeBytes as { key?: unknown; bytes?: unknown } | undefined;
      if (kept && kept.key === key && typeof kept.bytes === 'number' && Number.isFinite(kept.bytes)) {
        storeBytesCache.set(sessionId, { key, bytes: kept.bytes });
        return kept.bytes;
      }
    } catch {
      /* absent or unreadable — walk */
    }
    let bytes = logStat.size;
    for (const sub of ['blobs', 'staging']) {
      try {
        const d = path.join(dir, sub);
        for (const f of fs.readdirSync(d)) {
          try {
            bytes += fs.statSync(path.join(d, f)).size;
          } catch {
            /* a blob reaped mid-walk — skip it */
          }
        }
      } catch {
        /* the subdir does not exist — nothing to add */
      }
    }
    storeBytesCache.set(sessionId, { key, bytes });
    try {
      fs.mkdirSync(path.dirname(sidecar), { recursive: true, mode: 0o700 });
      const tmp = `${sidecar}.${process.pid}.tmp`;
      // Merge, never replace: the sidecar's title and counts halves have keys of their own.
      fs.writeFileSync(tmp, JSON.stringify({ ...side, storeBytes: { key, bytes } }), { mode: 0o600 });
      fs.renameSync(tmp, sidecar);
    } catch {
      /* a total we could not keep is a total we walk again — never an error */
    }
    return bytes;
  } catch {
    return 0; // no log.jsonl — a transcript-only session with nothing captured
  }
}

/**
 * Is this snapshot still on disk? A `stat`, never a read.
 *
 * Readers deliberately treat a missing blob as empty text (`blobText`, `tree.readText`) so a GC'd
 * snapshot degrades instead of crashing. That is right for rendering and WRONG for anything that
 * persists the result: the derived value gets stored under the intact SHA and is then indistinguishable
 * from an honest one, forever. Anything caching a blob-derived value asks this first.
 */
export function hasBlob(sessionId: string, sha: string | null): boolean {
  if (!sha) return true; // no snapshot recorded is a legitimate state, not a missing one
  try {
    return fs.existsSync(path.join(blobsDir(sessionId), sha));
  } catch {
    return false;
  }
}

function stagingDir(sessionId: string): string {
  return path.join(storeDir(sessionId), 'staging');
}

export function logPath(sessionId: string): string {
  return path.join(storeDir(sessionId), 'log.jsonl');
}

// --- advisory lock: serializes log-MUTATING ops so the one rewrite path (clearResolved) and GC can
// never race a concurrent capture append. Reads stay lock-free (append-only + torn-line tolerance).

const LOCK_STALE_MS = 10_000; // break only after this age AND evidence that the owner is dead
/** Past this age a lock is abandoned whatever its pid says. No live holder gets here: both agents kill
 *  a hook after 600 s (Claude Code's default hook timeout, and the one OAK writes for Codex), and the
 *  CLI's own mutations take seconds. A pid that still answers is then a different process that reused
 *  the number, another user's (EPERM), or one in another pid namespace. Trusting it wedged the session
 *  for good: every capture dropped its edit and every keep or undo said the store was busy. */
const LOCK_ABANDONED_MS = 15 * 60_000;
const APPEND_LOCK_BUDGET_MS = 2000; // bounded wait; never mutate without ownership
const MAINT_LOCK_BUDGET_MS = 5000; // maintenance (clearResolved / gc) can afford to wait longer

export class StoreBusyError extends Error {
  constructor() { super('Observatory store is busy; operation was not performed'); }
}

// Synchronous sleep without a busy-loop: wait on an unshared word that is never notified.
const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
  try {
    Atomics.wait(SLEEP_WORD, 0, 0, Math.max(0, ms));
  } catch {
    /* SharedArrayBuffer/Atomics unavailable — skip the backoff */
  }
}

function lockPath(sessionId: string): string {
  return path.join(storeDir(sessionId), '.lock');
}

/** This machine's monotonic clock in ms: shared by every process on it, never stepped with the wall
 *  clock, and (on Linux and macOS) still while the machine sleeps. */
const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** What a lock or claim file holds: the owner's pid (read by waiters), a token its release checks, and
 *  the owner's monotonic clock when it took the file. */
function lockToken(): string {
  return `${process.pid}:${crypto.randomUUID()}:${monotonicMs()}`;
}

/**
 * A lock file as a waiter finds it: 'gone' once it was released after our failed create, null while
 * its holder may still be working, else its stat — it may be broken. A lock is broken only when its
 * owner is not provably alive and it is older than the stale horizon, or, whatever its pid says, once
 * it is older than any live holder can be (a reused pid answers too).
 *
 * Its age is the smaller of the file's age by the wall clock and by the owner's monotonic stamp. The
 * wall age alone let a waiter break a live holder's lock after a suspend or a clock step while it was
 * held, or when a file server's clock lags this host's. The stamp is this machine's
 * monotonic clock, so it ages neither way; one from another boot or machine can only read younger,
 * which delays a break (by at most the horizon), never hastens one. Locks shared between machines
 * still depend on the file's wall-clock age: their pids cannot be checked here either.
 *
 * The pid is guarded: Number('') === 0 and process.kill(0, 0) signals OUR OWN group (always "alive"),
 * and a non-numeric pid throws ERR_INVALID_ARG_TYPE (not ESRCH), so a 0-byte or garbage lock left by
 * a crash between the create and the write read as a live owner forever.
 */
function staleLock(p: string): fs.Stats | 'gone' | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return 'gone';
  }
  let ownerAlive = false, takenMs = NaN;
  try {
    const [pid, , taken] = fs.readFileSync(p, 'utf8').split(':').map(Number);
    takenMs = taken;
    if (Number.isSafeInteger(pid) && pid > 0) { process.kill(pid, 0); ownerAlive = true; }
  } catch (e) { ownerAlive = (e as NodeJS.ErrnoException).code === 'EPERM'; }
  const wallMs = Date.now() - st.mtimeMs, monoMs = monotonicMs() - takenMs;
  const ageMs = monoMs >= 0 ? Math.min(wallMs, monoMs) : wallMs; // NaN (no stamp) fails the test
  return (ageMs > LOCK_STALE_MS && !ownerAlive) || ageMs > LOCK_ABANDONED_MS ? st : null;
}

/**
 * Remove the stale lock `judged` from `p`, and never a lock someone took since.
 *
 * Judging a lock and removing it are two steps. Two waiters that judged the same dead holder's lock
 * both unlinked "it": the second unlink removed the lock the first had just taken, and both went in —
 * two capture appends computed the same record id (21 runs in 40 with eight appenders, measured
 * 2026-09-26; none in 100 since). Renaming the lock aside does not close that on its own: a waiter
 * that renamed away a FRESH lock cannot put it back without a moment in which a third can take the
 * name. So removals are serialized instead: an O_EXCL claim beside the lock, held for three syscalls,
 * and the lock is unlinked only while it is still the file that was judged (same inode, same mtime —
 * a fresh lock is never stale by age). Returns true when the create should be retried at once.
 *
 * A claim is removed only by the waiter that made it. One whose breaker died holding it is judged by
 * the lock's own rule and then left where it is: removing it was the same judge-then-unlink, and a
 * waiter that judged it removed the fresh claim a third had just made, so two broke the lock (duplicate
 * record ids in 4 of 100 trials with 16 appenders, 2026-09-27). The next claim (`.break.1`, …) takes over.
 */
function breakStaleLock(p: string, judged: fs.Stats): boolean {
  const token = lockToken();
  for (let n = 0; ; n++) {
    const claim = n ? `${p}.break.${n}` : `${p}.break`;
    try {
      fs.writeFileSync(claim, token, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      const held = (e as NodeJS.ErrnoException).code === 'EEXIST' ? staleLock(claim) : null;
      if (held && held !== 'gone') continue; // its breaker died holding it
      return false; // another waiter is breaking the lock
    }
    try {
      const now = fs.statSync(p);
      if (now.ino !== judged.ino || now.mtimeMs !== judged.mtimeMs) return false; // taken since it was judged
      fs.unlinkSync(p);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT'; // already free; an unremovable lock waits
    } finally {
      releaseLockFile(claim, token);
    }
  }
}

/** How long an unbroken run of EPERM on Windows is taken for a lock release in progress (takeLockFile). */
const EPERM_RELEASE_MS = 1000;

/**
 * Create the lock file `p` holding `token` (O_EXCL), waiting while someone else holds it; false once
 * `deadline` passes. Only EEXIST is waited on: any other create error — a missing or unwritable
 * directory, a full disk — is thrown at once, because waiting cannot change it. Both locks used to
 * spin on it without sleeping for their whole budget (2–15 s of a core) and then report "busy".
 *
 * Except EPERM on Windows, which deletes a file only when its last handle closes: a lock released
 * while another handle has it open (a waiter reading its owner, an antivirus scan) stays "delete
 * pending" until then, and creating it meanwhile fails with EPERM. That is a release in progress, so it
 * is waited out (an undo on the windows-latest runner reverted its file and then could not record it) —
 * for EPERM_RELEASE_MS at most, and never past the deadline: Windows refuses an unwritable lock
 * directory with the same EPERM, and waiting out the caller's whole budget on it cost a capture hook 15 s.
 */
function takeLockFile(p: string, token: string, deadline: number): boolean {
  let refusedSince: number | undefined;
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(p, 'wx', 0o600); // wx = O_CREAT|O_EXCL: fails if the lock already exists
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') {
        refusedSince ??= Date.now();
        if (Date.now() < deadline && Date.now() - refusedSince < EPERM_RELEASE_MS) {
          sleepMs(25);
          continue;
        }
      } else refusedSince = undefined;
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const stale = staleLock(p);
      if (stale === 'gone') {
        // Released between our create and its stat: the lock is free, so take it. Refusing here
        // turned an ordinary handover into "store is busy", dropping a capture or a keep.
        if (Date.now() < deadline) continue;
      } else if (stale && breakStaleLock(p, stale)) continue;
      if (Date.now() >= deadline) return false;
      sleepMs(25);
      continue;
    }
    try {
      fs.writeSync(fd, token); // the owner's pid (read by waiters) and the token its release checks
    } catch (e) {
      fs.closeSync(fd);
      try { fs.unlinkSync(p); } catch { /* ours, created a moment ago */ }
      throw e;
    }
    fs.closeSync(fd);
    return true;
  }
}

/** Remove `p` only while it still holds `token`: a lock broken as abandoned belongs to its new holder. */
function releaseLockFile(p: string, token: string): void {
  try { if (fs.readFileSync(p, 'utf8') === token) fs.unlinkSync(p); } catch { /* already broken/removed */ }
}

/**
 * Acquire an exclusive advisory lock for a session (O_EXCL create of `.lock`). Return a release
 * function, or null after the bounded wait; the caller refuses the mutation if acquisition fails.
 */
function acquireLock(sessionId: string, budgetMs: number): (() => void) | null {
  const p = lockPath(sessionId);
  const token = lockToken();
  try {
    if (!takeLockFile(p, token, Date.now() + budgetMs)) return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // no storeDir — refuse the mutation
    throw e;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseLockFile(p, token);
  };
}

/** Run `fn` only while holding the session lock. */
function withLock<T>(sessionId: string, budgetMs: number, fn: () => T): T {
  const release = acquireLock(sessionId, budgetMs);
  if (!release) throw new StoreBusyError();
  try {
    return fn();
  } finally {
    if (release) release();
  }
}

export function ensureStore(sessionId: string): void {
  // 0700 dirs / 0600 files: the store holds whole-file snapshots (often of secret-bearing files) and
  // is designed to run on shared/SSH/devcontainer hosts — it must not be world/group-readable.
  fs.mkdirSync(blobsDir(sessionId), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stagingDir(sessionId), { recursive: true, mode: 0o700 });
  // Tighten pre-existing dirs too (older installs created them at the 0755 default).
  for (const d of [rootDir(), storeDir(sessionId)]) {
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* best-effort */
    }
  }
}

/** Stable short key for a file path, used to name its staging record. */
export function pathKey(absFile: string): string {
  return crypto.createHash('sha256').update(absFile).digest('hex').slice(0, 16);
}

/** Write bytes to a content-addressed blob (idempotent). Returns the sha256 hex. */
/** The blob id of EMPTY content. Derived from the same hash `writeBlob` uses, so the two can never
 *  drift apart into a constant that silently stops matching. */
export const EMPTY_BLOB = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export function writeBlob(sessionId: string, content: Buffer): string {
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const dest = path.join(blobsDir(sessionId), sha);
  if (!fs.existsSync(dest)) {
    // tmp + atomic rename: a concurrent reader never sees a half-written blob, and a crash mid-write
    // leaves a `.tmp-*` (ignored by GC + reads) instead of a truncated file at the real sha path.
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try {
      fs.renameSync(tmp, dest);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* lost the race to an identical-content writer — dest already exists */
      }
    }
  }
  return sha;
}

export function readBlob(sessionId: string, sha: string): Buffer {
  return fs.readFileSync(path.join(blobsDir(sessionId), sha));
}

/**
 * A blob decoded as UTF-8 text, shared across callers.
 *
 * Four modules each had their own `blobText` helper doing `readBlob(...).toString('utf8')`, and the
 * change-map path walks the same before/after pair through all four: 3,514 reads of 392 blobs for
 * 39 MiB of unique bytes in one cold run. Text, not Buffer, deliberately — a shared Buffer is mutable
 * and the undo/capture paths hand theirs straight to writers, so they keep the raw uncached read.
 */
export function blobText(sessionId: string, sha: string): string {
  return readText(path.join(blobsDir(sessionId), sha));
}

// --- staging (transient before-snapshot) ---

export function writeStaging(sessionId: string, key: string, rec: StagingRecord): void {
  // ATOMIC — tmp + rename, like writeBlob. A staging record is what tells the GC that a blob written but
  // not yet logged is still live, and a plain write truncates before it fills: a concurrent
  // `gcSessionCore` that reads the file mid-write gets zero bytes, `JSON.parse` throws, and the catch
  // treats the record as absent — collecting BOTH the before and after blobs of an edit that is about to
  // be committed. Measured on this machine, ~4.7% of reads during a rewrite saw an empty file, and the
  // resulting record points at blobs that no longer exist: `lineDelta` then reports a pure deletion and
  // `undoEdit` throws. pid-scoped so two captures cannot collide on the temp name.
  const dest = path.join(stagingDir(sessionId), `${key}.json`);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, dest); // a reader sees old-or-new, never a torn file
}

export function readStaging(sessionId: string, key: string): StagingRecord | null {
  const p = path.join(stagingDir(sessionId), `${key}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as StagingRecord;
  } catch {
    return null;
  }
}

/**
 * How long this before-snapshot has been waiting for its PostToolUse, or null when there is none.
 *
 * A Bash tree walk defers to an edit that is still in flight, because that call's own Post will
 * record the change with the right tool name. But nothing reaps an ABANDONED staging record — an
 * interrupted edit leaves one behind — and deferring to it forever would mean every later change to
 * that file went unrecorded, silently, which is far worse than the duplicate row the deferral
 * prevents. Age is what tells the two apart: an edit's Pre and Post are milliseconds apart.
 */
/**
 * The most recent record for one file, or null when the log holds none.
 *
 * Reads the log's TAIL rather than the whole file: this runs inside every Edit/Write commit, and the
 * question it answers ("has this change already been captured by the Bash walk that is running
 * alongside me") only ever concerns the last few appends.
 */
export function lastRecordFor(sessionId: string, file: string): EditRecord | null {
  const want = canonPath(file);
  const log = readLog(sessionId);
  for (let i = log.length - 1; i >= 0; i--) {
    if (canonPath(log[i].file) === want) return log[i];
  }
  return null;
}

export function deleteStaging(sessionId: string, key: string): void {
  const p = path.join(stagingDir(sessionId), `${key}.json`);
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

// --- Bash capture manifest: before-snapshots of every candidate file for one Bash command ---

/** abs file path → before-blob sha (null = the file did not exist before the command). */
export interface BashManifest {
  files: Record<string, string | null>;
  ts: number;
  /** The directory this snapshot walked. A Post that diffs its walk against a manifest of a
   *  DIFFERENT root invents changes wholesale, so the root is part of the manifest's identity. */
  root?: string;
  toolCallId?: string;
  excluded?: string[];
  complete?: boolean;
}

/** A GC lease is never eligible for a Bash Post. Its owner releases only this token. */
export function writeSnapshotLease(sessionId: string, files: Record<string, string | null>): string {
  ensureStore(sessionId);
  const token = `__lease__${crypto.randomUUID()}`;
  const dest = path.join(stagingDir(sessionId), `${token}.json`);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ files, pid: process.pid, ts: Date.now() }), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return token;
}

export function releaseSnapshotLease(sessionId: string, token: string): void {
  if (!/^__lease__[a-zA-Z0-9-]+$/.test(token)) return;
  try { fs.unlinkSync(path.join(stagingDir(sessionId), `${token}.json`)); } catch { /* already released */ }
}

/** Keep a consumed manifest visible to GC until the capture append has committed. */
export function claimBashManifest(sessionId: string, root: string, toolCallId?: string): { manifest: BashManifest; release(): void } | null {
  return withBashPreLock(sessionId, () => {
    const hit = findBashManifest(sessionId, root, toolCallId);
    if (!hit) return null;
    const token = `__lease__${crypto.randomUUID()}`;
    try { fs.renameSync(hit.path, path.join(stagingDir(sessionId), `${token}.json`)); }
    catch { return null; }
    const lease = path.join(stagingDir(sessionId), `${token}.json`);
    const tmp = `${lease}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...hit.m, pid: process.pid }), { mode: 0o600 }); fs.renameSync(tmp, lease);
    return { manifest: hit.m, release: () => releaseSnapshotLease(sessionId, token) };
  });
}

/**
 * ONE FILE PER PRE, not one per session.
 *
 * A single `__bash__.json` was written by every Pre and deleted by every Post, which is correct only
 * while Bash calls never overlap — and they overlap constantly (any backgrounded command runs
 * alongside the next foreground one). A repo-root walk diffed against a subtree snapshot reports
 * every file outside that subtree as CREATED; the mirror image reports them DELETED; and the
 * partner's Post then found no manifest at all and silently captured nothing. One file
 * (`.gitignore`) alternated created/deleted sixteen times without being touched once.
 *
 * Measured on the session that reported it, counting records that sit in a chain returning to the
 * content it started from: 3,050 of 3,378, with 3,211 of those records written by Bash. (An earlier
 * count of the same session, taken mid-session under a stricter "identical triple" definition, read
 * 2,073 of 3,337 — the two measure different things, so both are stated rather than reconciled.)
 *
 * So each Pre writes its own manifest, and each Post consumes the OLDEST one whose root matches its
 * own cwd — pairing that is exact across different roots and FIFO within one root (where both
 * snapshots are of the same tree anyway, so the diff stays a real diff of that tree).
 */
const BASH_MANIFEST_PREFIX = '__bash__';

/** Roots are compared as strings, so they must be spelled one way: `canonPath` fixes the drive
 *  letter (#43) and this drops a trailing separator, the other way two hook events for one command
 *  have been seen to disagree. A mismatch would strand the snapshot and capture nothing.
 *
 *  Trimmed by scanning, not by `/[\\/]+$/`: that regex backtracks polynomially on a path of many
 *  separators, and this input arrives from a hook payload (CodeQL flags it as a ReDoS). One pass
 *  from the end is linear and says the same thing. */
function normalizeRoot(root: string | undefined): string | undefined {
  if (root === undefined) return undefined;
  const r = canonPath(root);
  let end = r.length;
  while (end > 1 && (r[end - 1] === '/' || r[end - 1] === '\\')) end--;
  return r.slice(0, end);
}

function manifestFiles(sessionId: string): string[] {
  try {
    return fs
      .readdirSync(stagingDir(sessionId))
      .filter((n) => n.startsWith(BASH_MANIFEST_PREFIX) && n.endsWith('.json'))
      .sort(); // the token starts with the timestamp, so lexical order IS oldest-first
  } catch {
    return [];
  }
}

/**
 * Drop manifests whose Post never ran (interrupted command, crashed hook): each one pins a blob for
 * every candidate file in its tree and keeps `hasInflightCapture` true, which excludes the session
 * from reaping forever.
 *
 * A DAY, not minutes: the horizon must sit far above the longest a Bash tool call can legitimately
 * run (Claude Code's own ceiling is 10 minutes and users raise it), or a still-running command's
 * snapshot is deleted out from under its Post and that command captures nothing, silently.
 */
export function reapStaleManifests(sessionId: string, maxAgeMs = 24 * 60 * 60 * 1000): void {
  const now = Date.now();
  let names: string[] = manifestFiles(sessionId);
  // …plus any abandoned temp from a writer that died mid-rename. `manifestFiles` matches `.json`
  // only, so these were invisible to every reaper — and `hasInflightCapture` counts ANY staging
  // entry, so one stray temp kept a finished session out of the collector forever.
  try {
    const all = fs.readdirSync(stagingDir(sessionId));
    // Any leftover temp from a writer that died mid-rename — a bash manifest OR a typed-staging
    // `<key>.json.<pid>.tmp` (writeStaging) — is matched by neither `manifestFiles` (.json only) nor
    // the typed-Pre retention rule, yet `hasInflightCapture` counts ANY staging entry, so one stray
    // temp kept a finished session out of the collector forever. The age + owner-liveness guard below
    // only clears genuinely abandoned ones.
    names = names.concat(all.filter((n) => n.endsWith('.tmp') || n.startsWith('__lease__')));
  } catch {
    /* no staging dir — nothing to reap */
  }
  for (const name of names) {
    const p = path.join(stagingDir(sessionId), name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
        let live = false;
        try { const owner = JSON.parse(fs.readFileSync(p,'utf8')).pid; if (typeof owner === 'number' && owner > 0) { process.kill(owner,0); live = true; } } catch (e) { live = (e as NodeJS.ErrnoException).code === 'EPERM'; }
        if (!live) fs.unlinkSync(p);
      }
    } catch {
      /* raced with another hook — fine either way */
    }
  }
  // A typed Pre has no durable runtime-owner liveness or failure signal. Its age cannot prove
  // completion: retain it until the matching Post or explicit removal of the session.
}

/**
 * Clear a session's PreToolUse before-snapshots at turn end (the `Stop` hook). A denied, failed, or
 * interrupted Edit fires Pre but never Post, leaving its snapshot staged. Because a tool_use_id now
 * suffixes the staging key, a SECOND edit to that file gets a different key, so `handlePre`'s
 * overlap scan finds the abandoned entry and marks BOTH records `ambiguous` — for the rest of the
 * session every edit of that file becomes review-only (Undo refuses) and `hasInflightCapture` never
 * clears, so the session is never reapable. `Stop` is the terminal signal the conservative
 * "never infer completion from age" rule was waiting for: no tool call outlives the turn, so at Stop
 * any remaining Pre snapshot is abandoned and safe to drop. Next turn's edits capture cleanly. Bash
 * manifests (`__bash__…`) and leases (`__lease__…`) own their own lifecycle and are left untouched.
 * (The narrower within-turn window — a failed edit then a retry of the SAME file in the SAME turn —
 * still needs the tool's own terminal hook; this is the cross-turn backstop.)
 */
export function clearAbandonedToolStaging(sessionId: string): void {
  let names: string[];
  try { names = fs.readdirSync(stagingDir(sessionId)); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('__')) continue;
    try { deleteStaging(sessionId, name.slice(0, -5)); } catch { /* raced with a hook — fine */ }
  }
}

/** Write this Pre's own manifest; returns its token, which its Post does not need (it pairs by root)
 *  but which keeps the filename unique across concurrent hook processes. */
export function writeBashManifest(sessionId: string, m: BashManifest): string {
  reapStaleManifests(sessionId);
  const token = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dest = path.join(stagingDir(sessionId), `${BASH_MANIFEST_PREFIX}${token}.json`);
  // tmp + rename, like every other store write: a concurrent Post reads this directory unlocked, and
  // a half-written manifest is a snapshot that says files do not exist.
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...m, root: normalizeRoot(m.root) }), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return token;
}

/**
 * Advance OTHER pending snapshots past what this Post just recorded.
 *
 * Two commands overlapping in the same directory both hold a snapshot from before the change, so
 * both of their Posts would record it — the same edit twice, and the second one is unresolvable
 * (undo of the earlier row conflicts with the later one and only `--force` clears it). Neither
 * pairing order nor exact Pre→Post matching helps, because both windows genuinely contain the
 * change. Moving the baseline does: once a change is in the log, every other pending snapshot of
 * that tree is updated to the state that was recorded, so nobody records it again.
 *
 * Scoped by CONTAINMENT, not by an equal root: a walk of `<repo>` covers `<repo>/packages/core`, so
 * a subdirectory command that records a change must advance the repo-root snapshot too — matching
 * roots exactly left it holding the pre-change content, and the repo-root Post recorded the same
 * change again (this repo does it all day: gradle in `packages/jetbrains` beside npm at the root).
 * A file is only ADDED to a snapshot whose tree contains it: writing a key for a file outside that
 * tree would make its own Post walk, never see it, and report it DELETED — the exact phantom this
 * whole mechanism exists to stop. Removing a key is safe anywhere, so deletions are not restricted.
 */
export function advancePendingManifests(sessionId: string, seen: Map<string, string | null>): void {
  if (!seen.size) return;
  // Under the same lock the Pre takes to publish its snapshot. This is a read-modify-write over a
  // file other hook processes are writing: unsynchronized, two Posts advancing one manifest lost an
  // update in 20 of 20 forced rounds at a realistic 4,000-key manifest — and a lost advance is a
  // stale baseline, which is the duplicate row this function exists to prevent.
  withBashPreLock(sessionId, () => advanceUnlocked(sessionId, seen));
}

function advanceUnlocked(sessionId: string, seen: Map<string, string | null>): void {
  for (const name of manifestFiles(sessionId)) {
    const p = path.join(stagingDir(sessionId), name);
    try {
      const m = JSON.parse(fs.readFileSync(p, 'utf8')) as BashManifest;
      if (!m || !m.files) continue;
      let touched = false;
      for (const [file, after] of seen) {
        const known = Object.prototype.hasOwnProperty.call(m.files, file);
        if (after === null) {
          if (!known) continue;
          delete m.files[file];
          touched = true;
          continue;
        }
        // A rootless manifest (an older build's) never gains a key: its tree is unknown, and a
        // duplicate row is a far smaller failure than an invented deletion.
        if (!known && !(m.root !== undefined && isUnderPath(file, m.root))) continue;
        if (m.files[file] === after) continue;
        m.files[file] = after;
        touched = true;
      }
      if (!touched) continue;
      // The manifest may have been CONSUMED by its own Post while this ran; renaming onto its path
      // would resurrect a spent snapshot, and the next command would diff against it.
      if (!fs.existsSync(p)) continue;
      // pid-scoped, like every other writer here (`writeStaging`, `clearResolved`): a shared temp
      // name lets one advancer rename another's half-written file into place.
      const tmp = `${p}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch {
      /* unreadable or raced — the reap and the parse guard handle it */
    }
  }
}

/** The oldest pending manifest taken of `root` (any root when undefined), with its path so a caller
 *  can consume it. Unparseable files are dropped as they are met — never diff against half a
 *  snapshot. */
function findBashManifest(sessionId: string, root: string | undefined, toolCallId?: string): { path: string; m: BashManifest } | null {
  const want = normalizeRoot(root);
  for (const name of manifestFiles(sessionId)) {
    const p = path.join(stagingDir(sessionId), name);
    let m: BashManifest;
    try {
      m = JSON.parse(fs.readFileSync(p, 'utf8')) as BashManifest;
    } catch {
      // Only delete one that is OLD. A fresh unparseable file is a write in flight, and deleting it
      // costs its owner every record of that command.
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > 60_000) fs.unlinkSync(p);
      } catch {
        /* gone already */
      }
      continue;
    }
    if (m.root !== undefined && want !== undefined && m.root !== want) continue; // another command's tree
    if (toolCallId !== undefined && m.toolCallId !== toolCallId) continue;
    if (toolCallId === undefined && m.toolCallId !== undefined) continue;
    // A ROOTLESS manifest is a previous build's shared `__bash__.json`, and it matched everything —
    // including a Post in a subdirectory, whose walk then reported every file outside that directory
    // as deleted (the very mass-phantom shape described above, arriving on the first command after an
    // upgrade; it even sorts first, so it was always consumed first). Only honour one when the caller
    // has no root of its own to compare it against; the next Pre clears it either way.
    if (m.root === undefined && want !== undefined) continue;
    return { path: p, m };
  }
  return null;
}

/** Peek: is a snapshot pending for this tree? Does NOT consume — `takeBashManifest` is the one a
 *  Post uses. */
export function readBashManifest(sessionId: string, root?: string): BashManifest | null {
  return findBashManifest(sessionId, root)?.m ?? null;
}

/**
 * The manifest this Post should diff against: the oldest one taken of the SAME root, consumed as it
 * is read. A manifest with no root (an older build's) matches anything — honouring it once beats
 * dropping a real capture.
 */
export function takeBashManifest(sessionId: string, root: string | undefined): BashManifest | null {
  const hit = findBashManifest(sessionId, root);
  if (!hit) return null;
  try {
    fs.unlinkSync(hit.path);
  } catch {
    return null; // another Post owns it; this consumer has no baseline
  }
  return hit.m;
}

/**
 * Drop the pending manifests this command owns: its own tree, plus any ROOTLESS one (an older
 * build's, which would otherwise match anybody). Scoped on purpose — the refuse-to-walk path calls
 * this, and wiping every manifest there destroyed a concurrent command's snapshot, so that command
 * captured nothing at all and said nothing about it.
 */
export function deleteBashManifest(sessionId: string, root?: string): void {
  const want = normalizeRoot(root);
  for (const name of manifestFiles(sessionId)) {
    const p = path.join(stagingDir(sessionId), name);
    if (want !== undefined) {
      try {
        const m = JSON.parse(fs.readFileSync(p, 'utf8')) as BashManifest;
        if (m && m.root !== undefined && m.root !== want) continue; // someone else's tree — not ours to clear
      } catch {
        /* unparseable — clearing it is the safe direction */
      }
    }
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

// --- bash stat cache (memo for the whole-tree Bash walk; consumed by capture.ts) ---

export interface BashStatEntry {
  k: string; // `${mtimeMs}:${size}` at last read
  h?: string; // content blob sha; ABSENT ⇒ binary/oversized verdict (negative results cached too)
}
export interface BashStatCache {
  v: 1;
  wroteMs: number; // when this cache was written — drives the racily-clean re-hash epsilon
  files: Record<string, BashStatEntry>;
}

// Lives in the storeDir ROOT: staging/*.json is JSON-parsed as StagingRecords by gcSessionCore,
// and removeSession reaps the whole dir, so no separate lifecycle is needed.
const BASH_STATCACHE = 'statcache.json';

export function readBashStatCache(sessionId: string): BashStatCache {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(storeDir(sessionId), BASH_STATCACHE), 'utf8'));
    if (c && c.v === 1 && c.files && typeof c.files === 'object') return c as BashStatCache;
  } catch {
    /* absent or corrupt — cold cache */
  }
  return { v: 1, wroteMs: 0, files: {} };
}

export function writeBashStatCache(sessionId: string, cache: BashStatCache): void {
  cache.wroteMs = Date.now();
  const dest = path.join(storeDir(sessionId), BASH_STATCACHE);
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(tmp, dest); // atomic: a concurrent reader sees old-or-new, never a torn file
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
  }
}

/** Blob names present right now — one readdir beats a per-cached-file existsSync by ~10x. */
export function blobPresence(sessionId: string): Set<string> {
  try {
    return new Set(fs.readdirSync(blobsDir(sessionId)));
  } catch {
    return new Set();
  }
}

/**
 * Session lock for the Bash Pre walk: holding it across snapshot+manifest-write means a concurrent
 * GC (clearResolved/clean, which takes the same lock) can never collect just-written before-blobs
 * in the gap before the manifest lands. NOTE appendLog takes this same lock — never append inside.
 */
export function withBashPreLock<T>(sessionId: string, fn: () => T): T {
  return withLock(sessionId, APPEND_LOCK_BUDGET_MS, fn);
}

// --- log (append-only, source of truth) ---

interface StatusOp {
  op: 'status';
  id: number;
  status: EditStatus;
  ts: number;
}

/** A real edit that capture could not snapshot (too large / binary / Bash tree too large). Recorded
 *  so the CLI/editors can tell the user "N change(s) weren't captured" instead of failing silently. */
export interface SkipOp {
  op: 'skip';
  file: string; // absolute path, or a short marker like '<bash-tree>' for a truncated Bash walk
  reason: string;
  ts: number;
}

/**
 * Read the log, folding append-only status ops onto their edit records (in file order).
 *
 * The parse is memoized per (mtime,size) of log.jsonl — with many edits it is called a dozen times per
 * change-map build, and it was the one parser without a memo. Each call returns fresh SHALLOW COPIES of
 * the cached records, so a caller that mutates a record (or the array) can never poison the cache or a
 * concurrent caller.
 */
export function readLog(sessionId: string): EditRecord[] {
  const p = logPath(sessionId);
  if (!fs.existsSync(p)) return [];
  // canonPath on the COPY: existing stores written before #43's fix hold drive-letter case twins for
  // one file — normalizing here makes every reader (grouping, counts, trees) see one file without
  // rewriting history on disk. The parse cache stays raw; only the caller's copy is healed.
  return cachedByFiles('readLog', [p], () => parseLogFile(p)).map((r) => ({ ...r, file: canonPath(r.file) }));
}

/** The log WITHOUT the #43 drive-case heal — raw path strings exactly as captured. The phantom repair
 *  and the undo phantom guard need the RAW case to PROVE a pair is a capture artifact: the healed
 *  copies agree by construction, so they cannot discriminate a phantom from a genuine
 *  create→delete→re-create chain on one consistent path. Same memoized parse; fresh shallow copies. */
export function readLogRaw(sessionId: string): EditRecord[] {
  const p = logPath(sessionId);
  if (!fs.existsSync(p)) return [];
  return cachedByFiles('readLog', [p], () => parseLogFile(p)).map((r) => ({ ...r }));
}

function parseLogFile(p: string): EditRecord[] {
  const records: EditRecord[] = [];
  const byId = new Map<number, EditRecord>();
  const usedIds = new Set<number>();
  let maxId = 0;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj: EditRecord | StatusOp | SkipOp;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // skip a partially-written line
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    // Any line with an `op` is a control op, not an edit record: fold 'status', ignore the rest
    // (e.g. 'skip' markers, read separately by readSkips).
    if ((obj as { op?: string }).op) {
      if ((obj as { op?: string }).op === 'capture-evidence') {
        const evidence = obj as unknown as { id: number; uid?: string; beforeBlob: string | null; tool: string; toolCallId?: string; beforeState: 'present' | 'absent' };
        const rec = byId.get(evidence.id);
        if (rec && rec.uid === evidence.uid) { rec.beforeBlob = evidence.beforeBlob; rec.tool = evidence.tool; rec.toolCallId = evidence.toolCallId;
          rec.beforeState = evidence.beforeState; rec.source = 'hook'; rec.provenance = 'tool'; rec.attribution = 'correlated'; delete rec.partial; }
      }
      if ((obj as StatusOp).op === 'status') {
        const rec = byId.get((obj as StatusOp).id);
        if (rec) rec.status = (obj as StatusOp).status;
      }
      continue;
    }
    const rec = obj as EditRecord;
    if (!Number.isSafeInteger(rec.id) || rec.id <= 0 || typeof rec.file !== 'string') continue;
    // §2.7 reconciliation: a residual unlocked append (two writers that both failed the lock) can put
    // two records on disk with the SAME display id. Deterministically re-key the LATER one (append
    // order) to a fresh id above every id seen so far, so byId / the status fold / undo targeting each
    // resolve to a distinct record. Depends only on records at-or-before this one, so effective ids are
    // stable across future appends (and `nextId`, reading this reconciled log, won't re-collide).
    if (usedIds.has(rec.id)) rec.id = maxId + 1;
    usedIds.add(rec.id);
    if (rec.id > maxId) maxId = rec.id;
    records.push(rec);
    byId.set(rec.id, rec);
  }
  return records;
}

/**
 * For each id in [ids]: the status it held immediately BEFORE it LAST became 'undone' — what a redo
 * restores. Folded from the same line walk as [parseLogFile] (including the §2.7 duplicate re-key,
 * or a status op after a reconciled collision would mis-attribute): the record line's own baked
 * status seeds the timeline, every status op advances it, and the value just before the latest
 * transition INTO 'undone' is the answer. Ids with no visible transition (a log rewritten by clean,
 * a record line baked 'undone') answer 'pending' — with the history gone there is no decision to
 * restore. One pass however many ids, so bulk redo stays O(log), not O(ids × log).
 */
export function statusesBeforeUndone(sessionId: string, ids: Iterable<number>): Map<number, EditStatus> {
  const want = new Set(ids);
  const out = new Map<number, EditStatus>();
  const fill = () => {
    for (const id of want) if (!out.has(id)) out.set(id, 'pending');
    return out;
  };
  if (!want.size) return out;
  const p = logPath(sessionId);
  if (!fs.existsSync(p)) return fill();
  const cur = new Map<number, EditStatus>();
  const usedIds = new Set<number>();
  let maxId = 0;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj: { op?: string; id?: number; status?: EditStatus };
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if (obj.op) {
      if (obj.op === 'status' && typeof obj.id === 'number' && obj.status) {
        const id = obj.id;
        if (obj.status === 'undone' && want.has(id) && cur.get(id) !== 'undone') {
          out.set(id, cur.get(id) ?? 'pending'); // latest transition wins — keep overwriting
        }
        cur.set(id, obj.status);
      }
      continue;
    }
    if (typeof obj.id !== 'number') continue;
    let id = obj.id;
    if (usedIds.has(id)) id = maxId + 1; // §2.7 mirror — see parseLogFile
    usedIds.add(id);
    if (id > maxId) maxId = id;
    cur.set(id, obj.status ?? 'pending');
    if (obj.status === 'undone' && want.has(id)) out.delete(id); // baked-undone: history discarded
  }
  return fill();
}

/** Attach a later hook's before-snapshot to its ACP twin without adding a second edit. */
export function enrichCaptureFromHook(session: string, id: number, evidence: { file: string; beforeBlob: string | null; afterBlob: string | null; tool: string; toolCallId?: string }): boolean {
  return withBashPreLock(session, () => {
    const rec = findRecord(session,id);
    if (!rec || rec.source !== 'acp' || rec.status === 'undone' || rec.file !== evidence.file || rec.afterBlob !== evidence.afterBlob) return false;
    if (rec.toolCallId && evidence.toolCallId && rec.toolCallId !== evidence.toolCallId) return false;
    fs.appendFileSync(logPath(session),JSON.stringify({ op:'capture-evidence',id,uid:rec.uid,beforeBlob:evidence.beforeBlob,
      tool:evidence.tool,toolCallId:evidence.toolCallId,beforeState:evidence.beforeBlob === null ? 'absent' : 'present' })+'\n',{mode:0o600});
    return true;
  });
}

const contentionSkipDir = (session: string): string => path.join(storeDir(session), 'capture-skips');

function contentionSkips(session: string): { path: string; op: SkipOp }[] {
  const dir = contentionSkipDir(session);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: { path: string; op: SkipOp }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const op = JSON.parse(fs.readFileSync(file, 'utf8')) as SkipOp;
      if (op?.op === 'skip' && typeof op.file === 'string' && typeof op.reason === 'string' && Number.isFinite(op.ts)) out.push({ path: file, op });
    } catch { /* only complete, atomically published diagnostics are readable */ }
  }
  return out;
}

/** A capture failure must remain visible even while maintenance owns the log. */
export function appendSkip(sessionId: string, file: string, reason: string): void {
  ensureStore(sessionId);
  const op: SkipOp = { op: 'skip', file, reason, ts: Date.now() };
  try {
    withLock(sessionId, APPEND_LOCK_BUDGET_MS, () =>
      fs.appendFileSync(logPath(sessionId), JSON.stringify(op) + '\n', { mode: 0o600 })
    );
  } catch (e) {
    if (!(e instanceof StoreBusyError)) throw e;
    // Separate immutable files cannot be overwritten by a concurrent log rewrite. No successful
    // edit is claimed; integrity reports the gap and existing staging continues to retain bytes.
    const dir = contentionSkipDir(sessionId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dest = path.join(dir, `${crypto.randomUUID()}.json`), tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(op), { mode: 0o600 });
    fs.renameSync(tmp, dest);
    // Keep a diagnostic-only session discoverable; opening for append never truncates the log.
    fs.closeSync(fs.openSync(logPath(sessionId), 'a', 0o600));
  }
}

/**
 * The raw control-op lines a log rewrite must CARRY OVER, verbatim and in order.
 *
 * `clearResolved`/`clearResolvedIds` rebuild the log from `readLog`, which returns edit records only —
 * every `op` line is dropped on the floor. That silently erased the session's `skip` markers, the one
 * record that a real edit went uncaptured (the whole point of SkipOp: surface the gap instead of
 * swallowing it). A scoped clear of one folder erased skips for unrelated files too.
 *
 * 'status' ops are deliberately NOT carried: they are already folded into the records being rewritten,
 * so re-emitting them would grow the log without changing what it means. Anything else — skips, and any
 * op type added later — survives, which is the safe default for a rewrite that cannot know what it is
 * discarding.
 */
function retainedOpLines(sessionId: string): string[] {
  const p = logPath(sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.op && o.op !== 'status') out.push(t);
    } catch {
      /* torn line — not a record we can vouch for */
    }
  }
  return out;
}

/**
 * One journaled REVIEWER operation: a bulk status flip with each record's BEFORE-status. Appended by
 * `setStatusMany` in the same write as the flips it describes; `oplog` lists and reverts them — the
 * reviewer's own actions get the same auditability as the agent's. NO top-level `id` on this line:
 * an op line carrying both `id` and `file` would parse as an EditRecord in the JetBrains
 * StoreReader (its port-fidelity test pins the rule). 'clear' is reserved — a log rewrite discards
 * the records themselves, so there is nothing a revert could restore.
 */
export interface BatchOp {
  op: 'batch';
  kind: 'keep' | 'undo' | 'redo' | 'clear';
  ids: number[];
  prev: Record<string, EditStatus>;
  ts: number;
}

/** A [BatchOp] as `oplog` presents it: parsed, labeled, newest first. */
export interface OperationEntry {
  kind: BatchOp['kind'];
  ids: number[];
  prev: Record<string, EditStatus>;
  ts: number;
  label: string; // "kept 12 edit(s)" — the human line oplog prints
}

const OP_LABEL: Record<BatchOp['kind'], string> = {
  keep: 'kept',
  undo: 'reverted',
  redo: 're-applied',
  clear: 'cleared',
};

/** The journaled reviewer operations, NEWEST first. An empty store answers an empty list, never an error. */
export function readOperations(sessionId: string): OperationEntry[] {
  const p = logPath(sessionId);
  if (!fs.existsSync(p)) return [];
  const out: OperationEntry[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.indexOf('"batch"') === -1) continue;
    try {
      const o = JSON.parse(t) as Partial<BatchOp>;
      if (o.op !== 'batch' || !o.kind || !Array.isArray(o.ids) || !o.ids.length) continue;
      out.push({
        kind: o.kind,
        ids: o.ids,
        prev: o.prev ?? {},
        ts: o.ts ?? 0,
        label: `${OP_LABEL[o.kind] ?? o.kind} ${o.ids.length} edit(s)`,
      });
    } catch {
      /* torn line — not an op we can vouch for */
    }
  }
  return out.reverse();
}

/** An attribution override (`assign`): these RECORD ids belong to prompt [prompt]; absent prompt =
 *  clear. Like every op line: NO top-level `id`, survives rewrites via retainedOpLines. */
export interface ScopeOp {
  op: 'scope';
  ids: number[];
  prompt?: string;
  ts: number;
}

/** Append an attribution override for `ids` (raw record ids). `promptId` null clears them. */
export function appendScopeOverride(sessionId: string, ids: number[], promptId: string | null): void {
  if (!ids.length) return;
  const op: ScopeOp = { op: 'scope', ids, ...(promptId ? { prompt: promptId } : {}), ts: Date.now() };
  withLock(sessionId, APPEND_LOCK_BUDGET_MS, () =>
    fs.appendFileSync(logPath(sessionId), JSON.stringify(op) + '\n', { mode: 0o600 })
  );
}

/** Raw record id → its overriding prompt id, LAST op wins (a clear removes the entry). Memoized on
 *  the log like every derived fact. */
export function readScopeOverrides(sessionId: string): Map<number, string> {
  return cachedByFiles('scopeOverrides', [logPath(sessionId)], () => {
    const out = new Map<number, string>();
    const p = logPath(sessionId);
    if (!fs.existsSync(p)) return out;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.indexOf('"scope"') === -1) continue;
      try {
        const o = JSON.parse(t) as Partial<ScopeOp>;
        if (o.op !== 'scope' || !Array.isArray(o.ids)) continue;
        for (const id of o.ids) {
          if (typeof id !== 'number') continue;
          if (typeof o.prompt === 'string' && o.prompt) out.set(id, o.prompt);
          else out.delete(id);
        }
      } catch {
        /* torn line — not an op we can vouch for */
      }
    }
    return out;
  });
}

/** The 'skip' markers in a session's log (dropped, untracked changes). */
export function readSkips(sessionId: string): SkipOp[] {
  const p = logPath(sessionId);
  const out: SkipOp[] = contentionSkips(sessionId).map(({ op }) => op);
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.indexOf('"skip"') === -1) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.op === 'skip') out.push(o as SkipOp);
    } catch {
      /* skip a partial line */
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Next display id = max existing (reconciled) id + 1. `appendLog` calls this INSIDE the append lock so
 * two concurrent writers can't read the same max and collide (§2.7); the fallback reads the reconciled
 * log, so a re-keyed duplicate id is counted too and a subsequent append can't re-collide with it.
 *
 * Fast path: appends allocate max+1, so a clean log's ids are strictly increasing and the LAST record's
 * id is the reconciled max — a bounded tail read answers in O(64 KB) instead of parsing the whole log
 * on every capture (which made the capture hot path O(N²) over a session's lifetime). The tail is
 * trusted only when it holds ≥2 edit records in strictly increasing order; a duplicate in the tail (an
 * unlocked §2.7 collision) or a tiny file falls back to the full reconciled read.
 */
export function nextId(sessionId: string): number {
  const p = logPath(sessionId);
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {
    return 1;
  }
  const TAIL = 64 * 1024;
  if (size > TAIL) {
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(TAIL);
      const n = fs.readSync(fd, buf, 0, TAIL, size - TAIL);
      fs.closeSync(fd);
      const lines = buf.toString('utf8', 0, n).split('\n').slice(1); // first line may be partial
      const ids: number[] = [];
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t);
          if (o && !o.op && typeof o.id === 'number') ids.push(o.id);
        } catch {
          /* partial line */
        }
      }
      if (ids.length >= 2 && ids.every((v, i) => i === 0 || v > ids[i - 1])) return ids[ids.length - 1] + 1;
    } catch {
      /* fall through to the full read */
    }
  }
  const log = readLog(sessionId);
  return log.reduce((m, r) => Math.max(m, r.id), 0) + 1;
}

// Per-process monotonic counter for uid: guarantees distinct uids even if two calls read the same
// hrtime tick within this process. pid distinguishes separate capture processes.
let uidCounter = 0;

/** Collision-proof per-record token: pid + high-res monotonic clock + a per-process counter. Two
 *  separate capture processes that both fail the append lock still get distinct uids (§2.7). */
function makeUid(): string {
  return `${process.pid.toString(36)}-${process.hrtime.bigint().toString(36)}-${(uidCounter++).toString(36)}`;
}

/**
 * Append a new edit record; returns it with the store-allocated `id` + `uid`.
 *
 * §2.7 single-writer hazard: the display `id` is allocated INSIDE the lock (folding `nextId` into the
 * locked append) so a concurrent writer can't read the same max and collide — the common-case fix.
 * Each record also carries a collision-proof `uid`; duplicate display IDs from historical
 * unlocked writers are reconciled deterministically on read (readLog). The store owns id allocation: any `id` on the input object is ignored.
 */
export function appendLog(sessionId: string, rec: Omit<EditRecord, 'id' | 'uid'>): EditRecord {
  return withLock(sessionId, APPEND_LOCK_BUDGET_MS, () => {
    const full: EditRecord = { ...rec, id: nextId(sessionId), uid: makeUid() };
    fs.appendFileSync(logPath(sessionId), JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  });
}

/**
 * Change one record's status by APPENDING a status op (never rewrites the file), then return the
 * updated record (or null if the id doesn't exist). Append-only = safe against a concurrent
 * capture-hook append.
 */
export function setStatus(sessionId: string, id: number, status: EditStatus): EditRecord | null {
  const rec = findRecord(sessionId, id);
  if (!rec) return null;
  if (rec.status === status) return rec; // no-op: don't append a redundant status op (avoids log bloat)
  const op: StatusOp = { op: 'status', id, status, ts: Date.now() };
  withLock(sessionId, APPEND_LOCK_BUDGET_MS, () =>
    fs.appendFileSync(logPath(sessionId), JSON.stringify(op) + '\n', { mode: 0o600 })
  );
  rec.status = status;
  return rec;
}

/**
 * Memoize one derived FACT about a session on disk, keyed to a stamp the caller owns.
 *
 * Every editor surface runs in fresh CLI processes a few seconds apart, so an in-process memo never
 * survives to the next tick; anything derived from a finished session's files was therefore recomputed
 * forever. Facts share one file per session (`<root>/session-meta/<id>.json`) with a stamp per field, so
 * a change to one input never invalidates a fact derived from another.
 */
export function sidecarMemo<T>(sessionId: string, field: string, stamp: string, compute: () => T): T {
  if (!stamp || !isSafeSessionId(sessionId)) return compute(); // nothing stable to key on
  const p = path.join(rootDir(), 'session-meta', `${sessionId}.json`);
  let side: Record<string, unknown> = {};
  try {
    // readText, not readFileSync: this file is re-read once per memoized FIELD (45 times for one
    // session in a single Overview pass), and it is rewritten through tmp+rename — so the inode in
    // the content stamp invalidates it the instant a write lands.
    side = JSON.parse(readText(p));
    if (side && side[`${field}Stamp`] === stamp && side[field] !== undefined) return side[field] as T;
  } catch {
    /* absent or unreadable — compute */
  }
  const value = compute();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    // Merge, never replace: the other fields in this file are keyed to other inputs.
    // 0600/0700 like the rest of the store (SECURITY.md) — this file carries titles and plan text.
    fs.writeFileSync(tmp, JSON.stringify({ ...side, [field]: value, [`${field}Stamp`]: stamp }), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    /* a cache we could not write is a cache we recompute — never an error */
  }
  return value;
}

/**
 * Set the status of MANY edits at once — one parse, one lock, one append.
 *
 * The per-edit [setStatus] is O(log) each time: it resolves the record through `readLog`, whose memo the
 * append it then performs immediately invalidates. Looping it over a bulk scope is therefore quadratic,
 * and at real scale that is not a slow path but a broken one — accepting 26,000 pending edits took eight
 * minutes before this existed, against a few milliseconds now. Every bulk verb (Accept All, accept a
 * file, a folder, a task, a prompt) must come through here.
 *
 * Returns the ids that actually changed; an edit already in [status] is skipped rather than re-stated,
 * which is what keeps the log from doubling on a second Accept All.
 */
export function setStatusMany(sessionId: string, ids: Iterable<number>, status: EditStatus, budgetMs = MAINT_LOCK_BUDGET_MS): number[] {
  const want = new Set(ids);
  if (!want.size) return [];
  const changedRecs = readLog(sessionId).filter((r) => want.has(r.id) && r.status !== status);
  if (!changedRecs.length) return [];
  const changed = changedRecs.map((r) => r.id);
  const ts = Date.now();
  // ≥2 records is a bulk action a reviewer may want back: journal it as a `batch` op carrying each
  // record's BEFORE-status, in the SAME append (atomic under the one lock). A single flip journals
  // nothing — it is cheap to reverse by hand. Reverting an op flows back through here, so the revert
  // is journaled too and `oplog --revert-last` twice lands where it started.
  const OP_KIND: Record<EditStatus, BatchOp['kind']> = { kept: 'keep', undone: 'undo', pending: 'redo' };
  const opObj: BatchOp = {
    op: 'batch',
    kind: OP_KIND[status],
    ids: changed,
    prev: Object.fromEntries(changedRecs.map((r) => [r.id, r.status])),
    ts,
  };
  const journal = changed.length >= 2 ? JSON.stringify(opObj) + '\n' : '';
  const payload =
    journal + changed.map((id) => JSON.stringify({ op: 'status', id, status, ts })).join('\n') + '\n';
  withLock(sessionId, budgetMs, () =>
    fs.appendFileSync(logPath(sessionId), payload, { mode: 0o600 })
  );
  return changed;
}

export function findRecord(sessionId: string, id: number): EditRecord | null {
  return readLog(sessionId).find((r) => r.id === id) ?? null;
}

export interface SessionInfo {
  id: string;
  edits: number;
  pending: number;
  lastMs: number; // mtime of log.jsonl (last activity)
}

/** All sessions in the store, newest activity first. */
export function listSessions(): SessionInfo[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(rootDir());
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const id of ids) {
    if (!isSafeSessionId(id)) continue; // skip stray/foreign entries (also keeps storeDir from throwing)
    const lp = logPath(id);
    if (!fs.existsSync(lp)) continue;
    let lastMs = 0;
    try {
      lastMs = fs.statSync(lp).mtimeMs;
    } catch {
      /* ignore */
    }
    const log = readLog(id);
    out.push({ id, edits: log.length, pending: log.filter((r) => r.status === 'pending').length, lastMs });
  }
  return out.sort((a, b) => b.lastMs - a.lastMs);
}

/**
 * Delete blobs in a session not referenced by any log record — the actual GC (no lock; callers hold
 * it). Crucially it also treats blobs referenced by IN-FLIGHT captures as live: a `staging/<key>.json`
 * before-snapshot and every sha in the `__bash__.json` manifest belong to a PreToolUse whose
 * PostToolUse hasn't appended its record yet. Ignoring them would delete a blob the imminent edit
 * needs, leaving a permanently non-undoable record pointing at a missing blob.
 */
function gcSessionCore(sessionId: string): { removed: number; bytes: number } {
  // A snapshot whose command never came back pins a blob for every candidate file in its tree AND
  // keeps the session looking mid-capture forever (so `clean --completed` can never reclaim it).
  // Reaping only when a NEW Bash command runs never reaches a session that has gone quiet — which is
  // exactly the session this collector is here for.
  reapStaleManifests(sessionId);
  const referenced = new Set<string>();
  for (const r of readLog(sessionId)) {
    if (r.beforeBlob) referenced.add(r.beforeBlob);
    if (r.afterBlob) referenced.add(r.afterBlob);
  }
  // In-flight before-snapshots not yet committed to the log.
  const sdir = stagingDir(sessionId);
  let staged: string[];
  try {
    staged = fs.readdirSync(sdir);
  } catch {
    staged = [];
  }
  for (const name of staged) {
    // EVERY pending Bash snapshot, not one well-known name: each Pre now writes its own manifest
    // (overlapping commands used to overwrite each other's), and a blob only a pending manifest
    // references is exactly the before-side an in-flight command is about to record against.
    if ((name.startsWith(BASH_MANIFEST_PREFIX) || name.startsWith('__lease__')) && name.endsWith('.json')) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(sdir, name), 'utf8')) as BashManifest;
        if (m && m.files) for (const sha of Object.values(m.files)) if (sha) referenced.add(sha);
      } catch {
        return { removed: 0, bytes: 0 }; // uncertain lease: preserve blobs until staging is resolved
      }
    } else if (name.endsWith('.json')) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(sdir, name), 'utf8')) as StagingRecord;
        // BOTH sides: the after-blob is published here by PostToolUse before it appends the record,
        // and is otherwise unreferenced for that whole window (see StagingRecord.afterBlob).
        if (rec && rec.beforeBlob) referenced.add(rec.beforeBlob);
        if (rec && rec.afterBlob) referenced.add(rec.afterBlob);
      } catch {
        return { removed: 0, bytes: 0 }; // fail closed around an unreadable capture baseline
      }
    }
  }
  const dir = path.join(storeDir(sessionId), 'blobs');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: 0, bytes: 0 };
  }
  let removed = 0;
  let bytes = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue; // only blob files are GC candidates (skip in-flight .tmp-*)
    if (referenced.has(name)) continue;
    const p = path.join(dir, name);
    try {
      bytes += fs.statSync(p).size;
      fs.unlinkSync(p);
      removed++;
    } catch {
      /* ignore */
    }
  }
  return { removed, bytes };
}

/** Delete blobs in a session not referenced by any log record (or in-flight capture). Freed count + bytes. */
export function gcSession(sessionId: string): { removed: number; bytes: number } {
  return withLock(sessionId, MAINT_LOCK_BUDGET_MS, () => gcSessionCore(sessionId));
}

/** Every session dir present in the store — INCLUDING log-less stub dirs that listSessions skips
 *  (whole-tree Bash snapshots from sessions that never edited). `clean` iterates THIS so those
 *  dirs are reclaimable; every other consumer keeps the listSessions view. */
/** Directories under the store root that are CACHES, not sessions. `clean` walks the root looking for
 *  reclaimable session husks; without this list it finds these, sees no log.jsonl, and deletes the very
 *  caches this release's speed depends on — reporting them to the reader as "pruned stub sessions". */
// Store-root directories that are NOT sessions and must never be handed to gcSession/pruneEmptySession
// (they hold no session shape, so the stub-pruner would delete them as "empty"): the cross-file mutex
// locks, the derived codex transcript cache (honours its own .lock), the cross-machine usage cache, and
// the per-agent drive prefs (agent-prefs-<agent>, matched by prefix below).
const RESERVED_STORE_DIRS = new Set([
  'changemap-cache', 'session-meta', 'usage-cursors', '.file-locks', 'runtime-transcripts', 'remote-cache',
]);
/** A store-root entry that is a reserved non-session directory (exact name or a known prefix). */
function isReservedStoreDir(id: string): boolean {
  return RESERVED_STORE_DIRS.has(id) || id.startsWith('agent-prefs-') || id.startsWith('.');
}

export function allStoreSessionIds(): string[] {
  try {
    return fs.readdirSync(rootDir()).filter((id) => {
      if (isReservedStoreDir(id)) return false;
      if (!isSafeSessionId(id)) return false;
      try {
        return fs.statSync(path.join(rootDir(), id)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Remove a session dir that holds no reviewable state: no log.jsonl, empty staging, no blobs left
 * after GC. This reclaims stub-session husks; a live capture is protected by its staging entries
 * (pre-snapshot or bash manifest), and any blob surviving gcSession means a live reference — keep.
 */
export function pruneEmptySession(sessionId: string): boolean {
  try {
    if (isReservedStoreDir(sessionId)) return false; // not a session — never GC via the stub-pruner
    if (fs.existsSync(logPath(sessionId))) return false; // has (or had) review state — keep
    if (hasInflightCapture(sessionId)) return false;
    // Hook lifecycle evidence and historical journals remain review state even without edits.
    try {
      if (fs.readdirSync(storeDir(sessionId)).some((f) => f === 'capture-events.jsonl' || (f.startsWith('acp-') && f.endsWith('.jsonl')))) return false;
    } catch {
      /* unreadable dir — fall through to the existing checks */
    }
    const bdir = blobsDir(sessionId);
    if (fs.existsSync(bdir) && fs.readdirSync(bdir).length > 0) return false; // live-referenced blobs
    removeSession(sessionId);
    return true;
  } catch {
    return false;
  }
}

/**
 * True while a capture is mid-flight for this session — a pre-snapshot or a bash manifest is staged.
 *
 * The honest "do not touch this session" signal, and the one thing a clock cannot tell you: a hook
 * writes staging BEFORE the tool runs and clears it after, so a session can look quiet by every
 * timestamp we have while an edit is in the air. Every reaper checks it.
 */
export function hasInflightCapture(sessionId: string): boolean {
  try {
    const sdir = stagingDir(sessionId);
    return fs.existsSync(sdir) && fs.readdirSync(sdir).length > 0;
  } catch {
    return false;
  }
}

/**
 * RESOLVE a session: accept every pending edit, then drop the resolved records.
 *
 * The two halves already exist as separate verbs, and doing them by hand is the common way to finish
 * with a session — accept what is left, then stop carrying its history. Composed here so both editors
 * and the CLI perform the identical sequence, and so "resolved" means one thing.
 *
 * Files on disk are NOT touched: accepting is a review verdict, never a write. This keeps the session
 * itself — use `removeSession` to delete it outright.
 */
export function resolveSession(sessionId: string): { accepted: number; cleared: number } {
  const pending = readLog(sessionId)
    .filter((r) => r.status === 'pending')
    .map((r) => r.id);
  // Accept FIRST: clearResolved only drops records that already carry a verdict, so the other order
  // would clear the previously-resolved ones and leave everything just accepted still in the log.
  const accepted = pending.length ? setStatusMany(sessionId, pending, 'kept').length : 0;
  const cleared = clearResolved(sessionId);
  return { accepted, cleared };
}

/**
 * Repair issue #43's phantom pairs: a pending CREATE record (null → A) and a pending DELETE record
 * (A → null) for the same file under two drive-letter cases. Both are capture artifacts of one Bash
 * walk keyed against another walk's case — the file was never touched. Provable strictly: the pair
 * must differ in RAW path case (a legitimate create-then-delete carries one consistent path, and is
 * kept), share the exact blob, and both still be pending. Drops both records of each pair.
 */
export function repairCasePhantoms(sessionId: string): { pairs: number; ids: number[] } {
  // readLogRaw, not parseLogFile directly: it carries the missing-log guard, so `clean --phantoms`
  // on a session that never captured (or a wrong cwd) reports zero pairs instead of dying on ENOENT.
  const raw = readLogRaw(sessionId);
  const creates = raw.filter((r) => r.status === 'pending' && r.beforeBlob === null && r.afterBlob !== null);
  const deletes = raw.filter((r) => r.status === 'pending' && r.afterBlob === null && r.beforeBlob !== null);
  const doomed: number[] = [];
  const usedDel = new Set<number>();
  for (const c of creates) {
    const d = deletes.find(
      (x) => !usedDel.has(x.id) && x.beforeBlob === c.afterBlob && x.file !== c.file && canonPath(x.file) === canonPath(c.file)
    );
    if (!d) continue;
    usedDel.add(d.id);
    doomed.push(c.id, d.id);
  }
  if (doomed.length) dropRecords(sessionId, doomed);
  return { pairs: doomed.length / 2, ids: doomed.sort((a, b) => a - b) };
}

/** Drop an explicit record set from the log REGARDLESS of status — the repair path's primitive. The
 *  rewrite discipline matches clearResolved: locked, tmp-then-rename, control ops preserved. */
function dropRecords(sessionId: string, ids: number[]): void {
  const dead = new Set(ids);
  withLock(sessionId, APPEND_LOCK_BUDGET_MS, () => {
    const p = logPath(sessionId);
    const kept: string[] = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (typeof o.id === 'number' && !('op' in o) && dead.has(o.id)) continue; // the record itself
        if (o.op === 'status' && dead.has(o.id)) continue; // and its status ops
      } catch {
        /* keep unparseable lines — never widen a repair into data loss */
      }
      kept.push(t);
    }
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(tmp, p);
  });
}

/**
 * What `.observatoryignore` has removed from this session, cumulatively.
 *
 * Written as a control op so it survives every later rewrite (see [retainedOpLines]) and so the
 * capture hook can report it WITHOUT writing to stdout — a hard rule at the top of capture.ts,
 * because anything that hook prints lands in the model's context.
 */
export interface SweptOp {
  op: 'swept';
  /** Records removed, across every sweep this session has had. */
  dropped: number;
  /** Distinct files those records covered. Summed the same way; a file can only be swept once,
   *  because after the first sweep nothing under it is ever recorded again. */
  files: number;
  /** When the last sweep ran. */
  ts: number;
}

/** The session's sweep record, or null when `.observatoryignore` has never removed anything here. */
export function readSweep(sessionId: string): SweptOp | null {
  const p = logPath(sessionId);
  if (!fs.existsSync(p)) return null;
  let out: SweptOp | null = null;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.indexOf('"swept"') === -1) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.op === 'swept') out = o as SweptOp; // last wins: the op is rewritten, not appended to
    } catch {
      /* skip a partial line */
    }
  }
  return out;
}

/**
 * Remove every record `.observatoryignore` now covers. THIS DELETES REVIEW HISTORY.
 *
 * One mode: a matching path is never recorded. Records captured BEFORE a rule existed are the one
 * case that rule cannot reach on its own, so they are swept here — automatically, which is the
 * behaviour that was chosen over leaving them and offering a command. There is no undo: the blobs go
 * with the records, so this is deliberately the only place in the product where the answer to "can I
 * get it back" is no.
 *
 * Guardrails, in the order they matter:
 *   - it NEVER runs from a read path. `readLog` is called dozens of times per refresh by several
 *     processes at once, and a read that rewrites the store would race every other reader.
 *   - it does nothing at all when nothing matches — no rewrite, no rename, no mtime move. That is
 *     what lets a caller invoke it speculatively.
 *   - it takes the same lock, temp-file and GC as `clearResolved`, so a concurrent capture append
 *     cannot be clobbered by the rename.
 *   - a `skip` marker for a now-ignored file goes too. Leaving it would keep reporting "1 change was
 *     not captured" naming the very path the reader asked never to be recorded.
 */
export function dropIgnored(sessionId: string): { dropped: number; files: string[] } {
  // A fully ignored first edit has no store or log to sweep. Do not turn that normal absence
  // into a lock failure and a capture-gap diagnostic for a path the user excluded.
  if (!fs.existsSync(logPath(sessionId))) return { dropped: 0, files: [] };
  return withLock(sessionId, MAINT_LOCK_BUDGET_MS, () => {
    const p = logPath(sessionId);
    if (!fs.existsSync(p)) return { dropped: 0, files: [] };
    const log = readLog(sessionId);
    const skips = readSkips(sessionId);
    if (!log.length && !skips.length) return { dropped: 0, files: [] };
    // Primed over every path this session touched, so `decide` is memoized per file and each
    // directory's ancestor chain is walked once.
    const ctx = ignoreContextFor([...log.map((r) => r.file), ...skips.map((s) => s.file)]);
    if (!ctx.active) return { dropped: 0, files: [] }; // no rules anywhere — nothing can match
    const dead = log.filter((r) => ctx.ignored(r.file));
    // A marker whose `file` is a short sentinel like '<bash-tree>' is not a path; `ignored` would
    // resolve it against the cwd and could match by accident, so only real absolute paths are judged.
    const deadSkips = skips.filter((s) => path.isAbsolute(s.file) && ctx.ignored(s.file));
    if (!dead.length && !deadSkips.length) return { dropped: 0, files: [] };

    const files = [...new Set(dead.map((r) => r.file))].sort();
    const drop = new Set(dead.map((r) => r.id));
    const keep = log.filter((r) => !drop.has(r.id));
    const deadSkipSet = new Set(deadSkips.map((s) => `${s.ts}\u0000${s.file}`));
    const prior = readSweep(sessionId);
    const swept: SweptOp = {
      op: 'swept',
      dropped: (prior?.dropped ?? 0) + dead.length,
      files: (prior?.files ?? 0) + files.length,
      ts: Date.now(),
    };
    // Carried ops, minus the two kinds this sweep is replacing: the skips it just retired, and the
    // previous `swept` line (one cumulative op, not one per sweep — otherwise a session that sweeps
    // on every ignore-file edit grows a log entry each time and readSweep gets slower forever).
    const ops = retainedOpLines(sessionId).filter((line) => {
      try {
        const o = JSON.parse(line);
        if (o?.op === 'swept') return false;
        if (o?.op === 'skip') return !deadSkipSet.has(`${o.ts}\u0000${o.file}`);
      } catch {
        /* an unparseable op line is carried, like everywhere else here */
      }
      return true;
    });
    const lines = [...ops, JSON.stringify(swept), ...keep.map((r) => JSON.stringify(r))];
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
    for (const entry of contentionSkips(sessionId)) {
      if (path.isAbsolute(entry.op.file) && ctx.ignored(entry.op.file)) {
        try { fs.unlinkSync(entry.path); } catch { /* another sweep already removed it */ }
      }
    }
    gcSessionCore(sessionId); // the dropped records' blobs are now unreferenced (already locked)
    return { dropped: dead.length, files };
  });
}

/**
 * The sweep's gate: has any rule that could govern this session changed since it last ran?
 *
 * `dirs` is the session's distinct edited directories, kept in the sidecar and grown by the capture
 * hook. Stamping the ignore files reachable from ALL of them — not just the path being captured — is
 * what closes the hole the cheap version has: a rule added in one directory the session edits must
 * take effect on the next capture in ANY of them, not only in the one it was written for.
 */
export function ignoreSweepState(sessionId: string): { stamp: string; dirs: string[] } {
  const f = sweepStatePath(sessionId);
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      stamp: typeof d?.stamp === 'string' ? d.stamp : '',
      dirs: Array.isArray(d?.dirs) ? d.dirs.filter((x: unknown) => typeof x === 'string') : [],
    };
  } catch {
    return { stamp: '', dirs: [] }; // absent or corrupt — both mean "sweep, then record the truth"
  }
}

function sweepStatePath(sessionId: string): string {
  return path.join(storeDir(sessionId), 'ignore-sweep.json');
}

/**
 * Only the DEEPEST directories. A shallower one's ancestor chain is a subset of a deeper one's, so
 * stamping the deeper path already stats every ignore file the shallower path could see — and this
 * list is walked on every capture, so carrying a redundant entry costs a stat per edit forever.
 *
 * Linear after the sort: in lexicographic order every path under `d` sorts immediately after it, so
 * `d` is redundant exactly when its successor is beneath it.
 */
function prunedDirs(dirs: readonly string[]): string[] {
  const sorted = [...new Set(dirs)].sort();
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i + 1];
    if (next !== undefined && next.startsWith(sorted[i] + path.sep)) continue;
    out.push(sorted[i]);
  }
  return out;
}

/**
 * Run the sweep IF the rules moved. Returns what it dropped, or null when there was nothing to do.
 *
 * Called from the capture hook after its append, with the directory of the file just captured.
 *
 * MEASURED, not reasoned about: 2.1 ms per capture on a synthetic 390-directory session (the shape of
 * the largest real store on this machine), 2.7 ms with a rule file in play — two stats per distinct
 * directory in the union of the ancestor chains. A median session's few dozen directories cost a
 * fraction of that. The hook it sits on already reads the edited file, hashes it, writes a blob and
 * takes a lock, and Claude's edits are seconds apart, so this is affordable where the correct answer
 * is what matters: the cheap version — stamping only the captured path's own chain — silently misses
 * a rule written for a directory the current edit is not under, which is the common case.
 */
export function sweepIgnoredIfChanged(
  sessionId: string,
  editedDirs: string | readonly string[]
): { dropped: number; files: string[] } | null {
  // One directory or many. Tolerating both is not politeness: the only caller is inside
  // `handleHookPayload`'s blanket catch, so a TypeError here would disable the sweep with nothing
  // said anywhere — and a sweep that silently stops running is invisible until history piles up.
  const given = typeof editedDirs === 'string' ? [editedDirs] : editedDirs;
  const prev = ignoreSweepState(sessionId);
  // Every directory the capture actually touched, not just the one it was invoked from. A Bash walk
  // records at any depth beneath cwd, and stamping cwd alone left the gate blind to a rule written
  // BELOW it: the rule refused new captures at once while the records it covered stayed forever.
  const fresh = given.map((d) => canonPath(d)).filter((d) => !prev.dirs.includes(d));
  const dirs = fresh.length ? prunedDirs([...prev.dirs, ...fresh]) : prev.dirs;
  // A probe path per directory: `ignoreContextFor` keys its work on each path's PARENT, so the
  // trailing segment is never read and only has to be non-empty.
  const ctx = ignoreContextFor(dirs.map((d) => path.join(d, 'probe')));
  const stamp = ignoreStamp(ctx);
  if (stamp === prev.stamp) {
    if (dirs.length !== prev.dirs.length) writeSweepState(sessionId, { stamp, dirs });
    return null;
  }
  const res = ctx.active ? dropIgnored(sessionId) : { dropped: 0, files: [] };
  writeSweepState(sessionId, { stamp, dirs });
  return res.dropped ? res : null;
}

function writeSweepState(sessionId: string, s: { stamp: string; dirs: string[] }): void {
  try {
    const f = sweepStatePath(sessionId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch {
    // Best-effort. A sidecar that cannot be written means the sweep re-runs next time and finds
    // nothing, which costs a stat sweep — never a wrong answer.
  }
}

/** Remove an entire session directory from the store. */
export function removeSession(sessionId: string): void {
  const dir = storeDir(sessionId); // throws on an invalid/traversing id
  const root = path.resolve(rootDir());
  const resolved = path.resolve(dir);
  // Defense in depth: never rm -rf anything that isn't a direct child of the store root.
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`refusing to remove ${resolved}: outside the store`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // The derived caches hold the session's own content — its prompt text, its title, its file list — so
  // they go with it. Anything that deletes a session (clean --drop/--all/--older-than, demo --clean,
  // uninstall --purge-store, both editors' Drop action) comes through here, so this is the one place
  // that has to remember them.
  fs.rmSync(path.join(root, 'changemap-cache', sessionId), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'session-meta', `${sessionId}.json`), { force: true });
}

/**
 * A durable list of sessions the user chose to remove from every picker. `removeSession` clears
 * Observatory's OWN store data, but a session whose transcript/rollout still exists on disk (the
 * agent's own file, which is not ours to delete) would reappear in the listings the moment it is
 * re-scanned. This list is what keeps a deleted session gone: every session enumeration filters it.
 */
function hiddenSessionsPath(): string { return path.join(rootDir(), 'hidden-sessions.json'); }

export function hiddenSessions(): Set<string> {
  try {
    const arr = JSON.parse(fs.readFileSync(hiddenSessionsPath(), 'utf8'));
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}

export function isSessionHidden(sessionId: string): boolean {
  return hiddenSessions().has(sessionId);
}

function writeHidden(ids: Set<string>): void {
  const p = hiddenSessionsPath();
  fs.mkdirSync(rootDir(), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...ids]), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function hideSession(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  const ids = hiddenSessions();
  if (ids.has(sessionId)) return;
  ids.add(sessionId);
  writeHidden(ids);
}

export function unhideSession(sessionId: string): void {
  const ids = hiddenSessions();
  if (ids.delete(sessionId)) writeHidden(ids);
}

/** True when `file` is the scope path itself (exact file) or lives beneath it (folder prefix). The one
 *  rule shared by every `--under` operation, so file-scope and folder-scope match identically. Both
 *  operands are drive-case-canonicalized (#43): records are served canonical, but the scope may arrive
 *  from an editor or shell that lower-cases the Windows drive letter. */
export function isUnderPath(file: string, scope: string): boolean {
  const f = canonPath(file);
  const s = canonPath(scope);
  return f === s || f.startsWith(s.endsWith(path.sep) ? s : s + path.sep);
}

/**
 * Drop resolved (kept + undone) edits, keeping every pending one — rewrites the log to just the
 * kept records and GCs the now-orphaned blobs. Returns how many resolved edits were removed.
 * With `under` set, only resolved edits at-or-beneath that path are dropped (scoped Clear for a file
 * or folder); pending edits and resolved edits outside the scope are preserved.
 */
export function clearResolved(sessionId: string, under?: string): number {
  // Whole read→rewrite→rename→GC runs under the lock so a concurrent capture appendLog (which also
  // takes the lock) can't be silently clobbered by the rename.
  return withLock(sessionId, MAINT_LOCK_BUDGET_MS, () => {
    const log = readLog(sessionId);
    const inScope = (r: EditRecord) => !under || isUnderPath(r.file, under);
    const keep = log.filter((r) => r.status === 'pending' || !inScope(r));
    const removed = log.length - keep.length;
    if (removed === 0) return 0;
    const lp = logPath(sessionId);
    const tmp = `${lp}.${process.pid}.tmp`; // pid-scoped: two rewrites can't share a temp file
    // Op lines FIRST so the tail stays all-records for nextId's bounded tail read.
    const lines = [...retainedOpLines(sessionId), ...keep.map((r) => JSON.stringify(r))];
    fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
    fs.renameSync(tmp, lp);
    gcSessionCore(sessionId); // reclaim blobs referenced only by the removed edits (already locked)
    return removed;
  });
}

/**
 * Drop resolved (kept + undone) edits whose id is in `ids`, keeping every pending one — the id-scoped
 * counterpart to `clearResolved`, so a task's strict-span edit set (taskEditIds) can be cleared
 * without touching edits outside it. Pending edits in the set, and every edit outside it, are preserved.
 * Returns the count + the ids actually dropped.
 */
export function clearResolvedIds(sessionId: string, ids: number[]): { cleared: number; ids: number[] } {
  const want = new Set(ids);
  return withLock(sessionId, MAINT_LOCK_BUDGET_MS, () => {
    const log = readLog(sessionId);
    const dropped = log.filter((r) => want.has(r.id) && r.status !== 'pending').map((r) => r.id);
    if (dropped.length === 0) return { cleared: 0, ids: [] };
    const drop = new Set(dropped);
    const keep = log.filter((r) => !drop.has(r.id));
    const lp = logPath(sessionId);
    const tmp = `${lp}.${process.pid}.tmp`; // pid-scoped: two rewrites can't share a temp file
    // Op lines FIRST so the tail stays all-records for nextId's bounded tail read.
    const lines = [...retainedOpLines(sessionId), ...keep.map((r) => JSON.stringify(r))];
    fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
    fs.renameSync(tmp, lp);
    gcSessionCore(sessionId); // reclaim blobs referenced only by the removed edits (already locked)
    return { cleared: dropped.length, ids: dropped };
  });
}

/** What `withFileMutation` throws when another Observatory operation holds the file past the budget. */
export class FileBusyError extends Error {
  constructor() { super('Another Observatory operation is modifying this file; retry when it finishes'); }
}

/** Serialize Observatory mutations of one physical file across all sessions. External writers
 * are still detected by content comparison; an advisory lock cannot establish model authorship. */
export function withFileMutation<T>(file: string, action: () => T, budgetMs = 5000): T {
  let physical = canonPath(path.resolve(file));
  try { physical = canonPath(fs.realpathSync(physical)); }
  catch { try { physical = path.join(fs.realpathSync(path.dirname(physical)),path.basename(physical)); } catch {} }
  const dir=path.join(rootDir(),'.file-locks'); fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=path.join(dir,pathKey(physical)), token=lockToken();
  // The same lock rules as the session lock (takeLockFile): a missing or unwritable lock directory
  // throws at once (on Windows, whose EPERM can also be a release in progress, within about a second),
  // a stale lock is broken without ever removing one taken since.
  if (!takeLockFile(lock, token, Date.now() + budgetMs)) throw new FileBusyError();
  try { return action(); }
  finally { releaseLockFile(lock, token); }
}

/** Legacy snapshot creations lacked proof of absence. Such records must remain review-only. */
export function uncertainCreation(r: EditRecord): boolean {
  return r.beforeBlob === null && r.beforeState !== 'absent' && (r.source === 'acp' || ['Bash','Shell'].includes(r.tool));
}
