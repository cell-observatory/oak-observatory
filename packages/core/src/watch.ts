/**
 * The shared filesystem watcher: "something a live surface cares about changed".
 *
 * Both editors already do this, each in its own language, with numbers arrived at the hard way — a
 * 150 ms store debounce, a 700 ms transcript debounce, a 30 s cache of which project directories are
 * even relevant, and relevance filters that FAIL OPEN because a stale panel is worse than one extra
 * repaint. This is that behaviour as one zero-dependency module, so the CLI's live surfaces do not
 * become a third hand-rolled copy.
 *
 * Roots are supplied by the caller rather than derived here. The watcher knows about directories and
 * debounces; it knows nothing about sessions, transcripts, or which agent wrote them.
 *
 * PARITY NOTE: the JetBrains plugin has its own Kotlin StoreWatcher/TranscriptWatcher and cannot
 * consume this. That is not a gap today — this ships to the CLI, which has no JetBrains counterpart —
 * but the next change that puts NEW behaviour behind this module owes Kotlin the same change.
 */
import * as fs from 'fs';
import * as path from 'path';
import { rootDir, storeDir, allStoreSessionIds } from './store';
import { projectDir } from './session';
import { claudeConfigDir, canonPath } from './paths';
import { listRepoSiblings } from './fleet';

export type WatchKind = 'store' | 'activity';
export type WatchMode = 'native' | 'fanout' | 'poll';

export interface WatchRoot {
  dir: string;
  kind: WatchKind;
  /**
   * Is this reported filename worth a refresh?
   *
   * The value's SHAPE differs by mode, which is the trap: under a native recursive watch it is a
   * RELATIVE PATH (`s1/log.jsonl`), under a per-directory fanout it is a BARE NAME (`log.jsonl`), and
   * on macOS it can be null. Test with basename/endsWith, never equality against a whole path — the
   * obvious port of the editors' `name === 'log.jsonl'` filter matches nothing under recursion.
   */
  relevant: (reported: string | null, dir: string) => boolean;
  /** Which directories to register when native recursion is unavailable. Re-evaluated as the tree grows. */
  fanout?: (dir: string) => string[];
}

export interface WatcherOptions {
  roots: WatchRoot[];
  onChange: (kind: WatchKind, reason: 'event' | 'poll') => void;
  /** REQUIRED. Every degradation is announced — a watcher that quietly stopped watching is precisely
   *  the silent failure this module exists to prevent. */
  onDegrade: (dir: string, why: string) => void;
}

export interface WatchStat {
  dir: string;
  kind: WatchKind;
  mode: WatchMode;
  watchers: number;
}

/** Matches the editors, which agreed on these the expensive way. */
export const STORE_DEBOUNCE_MS = 150;
/** VS Code's number. JetBrains ships 300; the divergence is real, predates this module, and is not
 *  reconciled here — taking the slower of the two is the conservative direction for a poll loop. */
export const ACTIVITY_DEBOUNCE_MS = 700;
/** Both editors' poll fallback interval. */
export const POLL_MS = 2000;
/** How often a fanout re-discovers directories that appeared after start. */
export const REARM_MS = 2000;
/**
 * A circuit breaker, not a design cap. On Linux a fanout registers one watcher per directory; if a
 * store ever grows past this, degrading the whole root to polling is honest, whereas registering a
 * partial tree would look like it was working while missing most of it.
 */
export const MAX_WATCHERS = 512;

/**
 * Does `fs.watch(dir, {recursive:true})` use the OS's own recursive watcher?
 *
 * Gated on the PLATFORM, deliberately not on a try/catch. Node only throws for recursive watches on
 * platforms where it has no substitute; since v19.1 it silently swaps in `internal/fs/recursive_watch`
 * on Linux, which opens one `fs.watch` per FILE and emits a synthetic event per file while it walks
 * (measured: 11,401 handles and 11,400 startup events on an 11k-file store). So a try/catch waiting to
 * select the poll fallback never fires on the Node versions CI actually runs — it just quietly opens
 * thousands of handles. This predicate is the exact complement of Node's own condition, which makes
 * the substitute unreachable rather than merely unlikely.
 *
 * Exported so it can be asserted as a pure function: a runtime probe on a macOS CI machine cannot
 * catch a Linux-only trap, and this is the only instrument that can.
 */
export function nativeRecursive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

interface ArmedRoot {
  root: WatchRoot;
  mode: WatchMode;
  watchers: Map<string, fs.FSWatcher>;
  timer: NodeJS.Timeout | null;
  poll: NodeJS.Timeout | null;
  rearm: NodeJS.Timeout | null;
  lastStamp: string;
}

/** Cached because it costs a readdir per sibling, and it is consulted on every filesystem event. */
let relevantDirs: { at: number; dirs: Set<string> | null } | null = null;
const DIRS_TTL_MS = 30_000;

/**
 * The project directories whose transcripts belong to this workspace: its own, plus its worktree
 * siblings'. `null` means "could not tell", and every caller treats that as "everything is relevant" —
 * one extra refresh is cheap, a live view that quietly stops updating is not.
 */
function relevantProjectDirs(cwd: string, session: string): Set<string> | null {
  const now = Date.now();
  if (relevantDirs && now - relevantDirs.at < DIRS_TTL_MS) return relevantDirs.dirs;
  let dirs: Set<string> | null;
  try {
    dirs = new Set<string>([canonPath(path.resolve(projectDir(cwd)))]);
    for (const sib of listRepoSiblings(cwd, session)) dirs.add(canonPath(path.resolve(projectDir(sib.worktree))));
  } catch {
    dirs = null;
  }
  relevantDirs = { at: now, dirs };
  return dirs;
}

/**
 * The two roots a live Observatory surface watches: the review STORE (what was captured and how it was
 * judged) and the agents' ACTIVITY (transcripts, which grow on every tool call, subagent and to-do).
 *
 * Named for what changed rather than for one agent's file layout, so a future provider supplying its
 * own roots does not have to describe its files as "transcripts".
 */
export function observatoryRoots(opts: { cwd: string; session: string }): WatchRoot[] {
  const store: WatchRoot = {
    dir: rootDir(),
    kind: 'store',
    // Only the append-only logs matter. Everything else under the store root is noise, and three of
    // them are the READ path's own writes — changemap-cache, session-meta, usage-cursors and
    // stats-cache.json are all rewritten by the very views a refresh renders, so accepting them would
    // have a live surface refreshing because it refreshed.
    relevant: (reported) => reported !== null && (path.basename(reported) === 'log.jsonl' || path.basename(reported) === 'capture-events.jsonl' || ['attention.json', 'agent.json'].includes(path.basename(reported))),
    fanout: (dir) => [dir, ...allStoreSessionIds().map((id) => storeDir(id))],
  };
  const activity: WatchRoot = {
    dir: path.join(claudeConfigDir(), 'projects'),
    kind: 'activity',
    relevant: (reported, dir) => {
      if (reported === null) return true; // macOS can report a change without naming it — fail open
      if (!reported.endsWith('.jsonl')) return false;
      const dirs = relevantProjectDirs(opts.cwd, opts.session);
      if (!dirs) return true;
      const p = canonPath(path.resolve(dir, reported));
      // Containment, not equality: a session's subagent and workflow transcripts live NESTED under the
      // project dir, and those are exactly the writes that keep a live fleet's phase current.
      return [...dirs].some((d) => p === d || p.startsWith(d + path.sep));
    },
    fanout: (dir) => {
      const dirs = relevantProjectDirs(opts.cwd, opts.session);
      const out = [dir];
      for (const d of dirs ?? []) {
        out.push(d);
        // Two levels below a project dir: <project>/<session>/subagents, and the per-workflow dirs
        // beneath it, which is where most agent transcripts actually live.
        for (const sub of listDirs(d)) {
          out.push(sub);
          for (const nested of listDirs(sub)) {
            out.push(nested);
            for (const leaf of listDirs(nested)) out.push(leaf);
          }
        }
      }
      return out;
    },
  };
  const { codexHome } = require('./codex') as typeof import('./codex');
  // Only the codex directories that EXIST: on a Claude-only machine both are absent, and watching
  // them "degraded: ENOENT" on the status line of every OAK run (docs sweep, 2026-09-23).
  const codex = ['sessions', 'archived_sessions'].filter((name) => fs.existsSync(path.join(codexHome(), name))).map((name): WatchRoot => ({
    dir: path.join(codexHome(), name), kind: 'activity',
    relevant: (reported) => reported === null || reported.endsWith('.jsonl'),
    fanout: (dir) => { const out = [dir]; let level = [dir]; for (let depth = 0; depth < 4; depth++) { level = level.flatMap(listDirs); out.push(...level); } return out; },
  }));
  return [store, activity, ...codex];
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export function createWatcher(o: WatcherOptions): { close(): void; stats(): WatchStat[] } {
  const armed: ArmedRoot[] = [];
  let closed = false;

  const debounceFor = (k: WatchKind) => (k === 'store' ? STORE_DEBOUNCE_MS : ACTIVITY_DEBOUNCE_MS);

  const fire = (a: ArmedRoot, reason: 'event' | 'poll') => {
    if (closed) return;
    if (a.timer) clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      a.timer = null;
      if (!closed) o.onChange(a.root.kind, reason);
    }, debounceFor(a.root.kind));
    a.timer.unref?.();
  };

  /** A cheap fingerprint of a directory tree, for the poll fallback and the liveness check. */
  const stampOf = (dir: string, depth = 1): string => {
    const parts: string[] = [];
    const walk = (d: string, left: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (left > 0) walk(p, left - 1);
        } else {
          try {
            const st = fs.statSync(p);
            parts.push(`${p}:${st.mtimeMs}:${st.size}`);
          } catch {
            /* vanished between readdir and stat — the next tick sees it */
          }
        }
      }
    };
    walk(dir, depth);
    return parts.sort().join('|');
  };

  const toPoll = (a: ArmedRoot, why: string) => {
    if (a.mode === 'poll') return;
    for (const w of a.watchers.values()) {
      try {
        w.close();
      } catch {
        /* already gone */
      }
    }
    a.watchers.clear();
    a.mode = 'poll';
    o.onDegrade(a.root.dir, why);
    a.lastStamp = stampOf(a.root.dir);
    a.poll = setInterval(() => {
      if (closed) return;
      const s = stampOf(a.root.dir);
      if (s !== a.lastStamp) {
        a.lastStamp = s;
        fire(a, 'poll');
      }
    }, POLL_MS);
    a.poll.unref?.();
  };

  /**
   * The directory `fs.watch` is actually handed, resolved to its NATIVE long form.
   *
   * On Windows a path can reach here in 8.3 short form — `C:\\Users\\RUNNER~1\\AppData\\Local\\Temp` is
   * what `os.tmpdir()` returns on a GitHub runner — while the OS reports events using the long name.
   * libuv computes the event's path relative to the watched directory and asserts that the two share
   * a prefix (`!_wcsnicmp(filename, dir, dirlen)`, `src/win/fs-event.c`); a short-vs-long mismatch
   * fails that compare, and a libuv assertion is an `abort()`. No exception, nothing logged, the
   * process gone — in a tool people run to review edits before keeping them.
   *
   * `realpathSync.native` is what turns the short form into the long one. It is also the only variant
   * that does: the JS `realpathSync` resolves symlinks but leaves 8.3 names alone. Falls back to the
   * path as given, because a directory that cannot be resolved is one `fs.watch` is about to reject
   * anyway, and its own error is the better message.
   */
  const nativeDir = (dir: string): string => {
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return dir;
    }
  };

  const watchDir = (a: ArmedRoot, dirIn: string, recursive: boolean): boolean => {
    const dir = nativeDir(dirIn);
    const key = path.resolve(dir);
    if (a.watchers.has(key)) return true;
    if (a.watchers.size >= MAX_WATCHERS) {
      toPoll(a, `more than ${MAX_WATCHERS} directories to watch`);
      return false;
    }
    let w: fs.FSWatcher;
    try {
      w = fs.watch(dir, recursive ? { recursive: true } : undefined);
    } catch (e) {
      // Synchronous throw: a missing root on a fresh machine (the store dir is created by capture,
      // not by us), or a filesystem that cannot watch at all.
      toPoll(a, (e as NodeJS.ErrnoException)?.code ?? String(e));
      return false;
    }
    // An 'error' with no listener is an uncaught exception that takes the whole process down, and
    // Windows raises EPERM here whenever a watched directory is deleted.
    w.on('error', (e) => toPoll(a, (e as NodeJS.ErrnoException)?.code ?? String(e)));
    w.on('change', (_event, filename) => {
      const name = filename === null || filename === undefined ? null : String(filename);
      // In fanout mode a newly created session directory needs its own watcher, and it needs it NOW:
      // the writes that matter land inside it within milliseconds, long before any debounce expires.
      if (a.mode === 'fanout' && a.root.fanout) {
        for (const d of a.root.fanout(a.root.dir)) watchDir(a, d, false);
      }
      if (!a.root.relevant(name, dir)) return;
      fire(a, 'event');
    });
    a.watchers.set(key, w);
    return true;
  };

  for (const root of o.roots) {
    const a: ArmedRoot = { root, mode: 'native', watchers: new Map(), timer: null, poll: null, rearm: null, lastStamp: '' };
    armed.push(a);
    if (nativeRecursive()) {
      a.mode = 'native';
      watchDir(a, root.dir, true);
    } else {
      a.mode = 'fanout';
      const dirs = root.fanout ? root.fanout(root.dir) : [root.dir];
      for (const d of dirs) {
        if (a.mode !== 'fanout') break; // a degrade mid-loop must not keep registering
        watchDir(a, d, false);
      }
      // Directories created after start would otherwise never be watched: the fanout is re-evaluated
      // on every event above, and on this tick for the case where the parent produces no event at all.
      if (a.mode === 'fanout') {
        a.rearm = setInterval(() => {
          if (closed || a.mode !== 'fanout' || !root.fanout) return;
          for (const d of root.fanout(root.dir)) watchDir(a, d, false);
        }, REARM_MS);
        a.rearm.unref?.();
      }
    }
  }

  return {
    close() {
      closed = true;
      for (const a of armed) {
        for (const w of a.watchers.values()) {
          try {
            w.close();
          } catch {
            /* already gone */
          }
        }
        a.watchers.clear();
        if (a.timer) clearTimeout(a.timer);
        if (a.poll) clearInterval(a.poll);
        if (a.rearm) clearInterval(a.rearm);
      }
    },
    stats() {
      return armed.map((a) => ({ dir: a.root.dir, kind: a.root.kind, mode: a.mode, watchers: a.watchers.size }));
    },
  };
}
