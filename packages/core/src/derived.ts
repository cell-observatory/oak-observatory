/**
 * Derived answers that outlive the process.
 *
 * The read commands are SPAWNED — a dashboard poll is a fresh node every few seconds — so every
 * in-process memo in this package starts empty and every derivation runs again. That is invisible on
 * a small session and dominant on a real one: measured on a 978-record session, `list` cost 8.3s on
 * EVERY poll, of which 4.5s was the review-unit split and 3.2s was per-record line deltas — both
 * already memoized, both correctly keyed, and both thrown away at exit.
 *
 * This is the missing half: the same answers, under the same keys, written beside the session's other
 * derived copies so dropping a session reaps them too.
 *
 * Two rules keep it honest:
 *
 * 1. A STAMP, never a timestamp. An entry is returned only when the stamp of its inputs matches
 *    exactly — the caller decides what those inputs are, because only the caller knows. A cache that
 *    guesses at freshness is worse than no cache, because it is wrong silently.
 * 2. BEST EFFORT, never load-bearing. Every read and write is wrapped: an unreadable, truncated or
 *    half-written file must cost a recomputation, never an error. Nothing here is the source of
 *    truth for anything.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isSafeSessionId, logPath, readLog, rootDir } from './store';

/** Bump when a stored SHAPE changes; entries of another version are ignored, never migrated. */
const DERIVED_VERSION = 1;

function derivedPath(session: string, name: string): string | null {
  // `isSafeSessionId` is the same gate the map cache uses: a session id reaches this from a payload,
  // and a path segment is not the place to find that out.
  if (!isSafeSessionId(session) || !/^[a-z0-9-]+$/.test(name)) return null;
  return path.join(rootDir(), 'changemap-cache', session, `${name}.json`);
}

/**
 * `compute()`, but read from disk when the stamp still matches.
 *
 * `stamp` must cover EVERY input the answer depends on. The callers here already know theirs — the
 * review-unit split is keyed on the store log plus the ask-boundary signature, deliberately not on
 * the transcript's bytes (a transcript grows with each message, not each ask).
 */
export function persisted<T>(session: string, name: string, stamp: string, compute: () => T, valid?: (value: unknown) => boolean): T {
  const file = derivedPath(session, name);
  if (!file) return compute();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; stamp?: string; value?: unknown };
    if (j && j.version === DERIVED_VERSION && j.stamp === stamp && j.value !== undefined && (!valid || valid(j.value))) return j.value as T;
  } catch {
    /* absent, truncated or from another version — recompute */
  }
  const value = compute();
  // A DROPPED SESSION IS NEVER RESURRECTED. `clean --drop` removes the store and its derived caches
  // together — deliberately, because these files hold the session's own content — and any read that
  // follows would otherwise recreate the directory behind it. Reading a session that no longer
  // exists is legitimate (it answers "nothing"); writing a cache for one is not.
  if (!fs.existsSync(logPath(session))) return value;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // tmp + rename: a reader must never see a half-written answer, and two writers must not
    // interleave into one file. The pid keeps concurrent polls off each other's temporary.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: DERIVED_VERSION, stamp, value }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* best effort — a session whose cache cannot be written simply recomputes */
  }
  return value;
}

/** The mtime+size of a file, or '' when it cannot be stat'd — the shape every stamp here composes. */
export function fileMark(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

/**
 * CONTENT-KEYED STORES: derived answers about a pair of blobs, kept across processes.
 *
 * Keyed by `<beforeSha>:<afterSha>` — the content itself — so an entry is either a hit on exactly
 * those bytes or a miss; blobs are immutable and content-addressed, which makes a hit exact by
 * construction and collapses identical edits across records onto one entry.
 *
 * Two live here, both measured on the real 978-record session:
 *
 *   deltas — added/removed line counts. 3.2 s per `list`, every poll, before it was kept.
 *   flags  — the risk-flag inputs (TODO/debug/secret markers and the removed-line count) that
 *            `flagsFor` derives per edit. 3.5 s of a 4.9 s change-map rebuild — 71 % of it — because
 *            `flagInputs` diffed every record's blobs again in every process.
 *
 * ONE OWNER PER FILE, on purpose. The change-map pass had `deltas` to itself and pruned on flush to
 * whatever IT had referenced; a second reader writing the same file under that policy would have each
 * pass quietly deleting the other's entries every poll. Pruning is by LOG MEMBERSHIP instead — which
 * is what the prune was always for (`clean --resolved` drops records, and their entries must not
 * outlive them forever) and is a fact about the store rather than about who happened to read it.
 */
// `hops` (2026-09-16): one record's diff shape + scope name + pure-block bytes, keyed by its blob
// pair — the units split re-derived every one of them per cold pass (measured 15 s on an 8,745-record
// session, on every poll while the agent worked).
const STORE_VERSION = { deltas: 1, flags: 1, hops: 1 } as const;
export type ContentStore = keyof typeof STORE_VERSION;

type Slot = { map: Map<string, unknown>; dirty: boolean };

/**
 * Pairs the DISPLAY holds that the log does not: `reviewEdits` collapses a pending unit into one
 * synthetic record whose pair is (first member's before, last member's after), which no raw record
 * carries. Every flush pruned to the log's pairs, so `sessionCounts` diffed those ~44 pairs on EVERY
 * pass of an 8,700-record session, noted them, and watched the flush prune them again (measured
 * 2026-09-16: 830 ms per listing, forever). The display layer REPLACES this set each time it derives
 * the collapsed records — replaces, never accumulates, so a record that is gone takes its entry with
 * it on the next flush exactly as before. Keyed like the slots: root + session.
 */
const liveExtra = new Map<string, Set<string>>();

export function markLive(session: string, keys: Iterable<string>): void {
  liveExtra.set(`${rootDir()}\u0000${session}`, new Set(keys));
}
const stores = new Map<string, Slot>();

/** Keyed by ROOT + session + store, never by session alone. The store root moves with
 *  CLAUDE_CONFIG_DIR, so one process can legitimately hold two different stores that use the same
 *  session id — the test suite does exactly that — and a session-only key hands the second one the
 *  first one's answers and reports its own cache as already clean. */
function slotKey(session: string, name: ContentStore): string {
  return `${rootDir()}\u0000${session}\u0000${name}`;
}

export function pairKeyOf(before: string | null | undefined, after: string | null | undefined): string {
  return `${before ?? '-'}:${after ?? '-'}`;
}

function slotOf(session: string, name: ContentStore): Slot {
  const k = slotKey(session, name);
  const hit = stores.get(k);
  if (hit) return hit;
  const entry: Slot = { map: new Map<string, unknown>(), dirty: false };
  const file = derivedPath(session, name);
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; pairs?: Record<string, unknown> };
      if (j && j.version === STORE_VERSION[name] && j.pairs) for (const [kk, v] of Object.entries(j.pairs)) entry.map.set(kk, v);
    } catch {
      /* absent or unreadable — recompute */
    }
  }
  stores.set(k, entry);
  return entry;
}

/** What the last process worked out for these bytes, or undefined. `null` is a real answer for some
 *  stores (a deleted file has no flag inputs), so absence is `undefined` and never `null`. */
export function contentGet<V>(session: string, name: ContentStore, key: string): V | undefined {
  const v = slotOf(session, name).map.get(key);
  return v === undefined ? undefined : (v as V);
}

export function contentNote<V>(session: string, name: ContentStore, key: string, value: V): void {
  const e = slotOf(session, name);
  e.map.set(key, value);
  e.dirty = true;
  armExitFlush(session);
}

/** The delta store, named — every caller predates the generalisation and reads better this way. */
export function pairDelta(session: string, key: string): [number, number] | undefined {
  return contentGet<[number, number]>(session, 'deltas', key);
}

export function notePairDelta(session: string, key: string, value: [number, number]): void {
  contentNote(session, 'deltas', key, value);
}

/**
 * Write what this process learned when it ends, whoever learned it.
 *
 * The flush belonged to the change-map pass, so a command that did not run that pass — `list` is
 * the common one — recomputed every delta, noted them, and exited without writing any of it down.
 * The work is the same work whichever command paid for it, so the WRITE belongs to the process.
 * Registered once per session, on the first thing learned, so a run that learns nothing adds no hook.
 */
const armed = new Map<string, string>();
let exitHooked = false;
function armExitFlush(session: string): void {
  const k = `${rootDir()}\u0000${session}`;
  if (armed.has(k)) return;
  armed.set(k, session);
  // ONE exit hook for the whole process, not one per session: a cold `--json` batch touches dozens of
  // sessions, and a `process.once('exit')` apiece tripped Node's MaxListenersExceededWarning onto the
  // command's stderr — noise for a `--json` consumer. The hook flushes every
  // armed session.
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => {
    for (const session of armed.values()) {
      const live = new Set<string>();
      try {
        for (const r of readLog(session)) live.add(pairKeyOf(r.beforeBlob, r.afterBlob));
      } catch {
        /* an unreadable log prunes nothing */
      }
      for (const name of Object.keys(STORE_VERSION) as ContentStore[]) flushContent(session, name, live);
    }
  });
}

/**
 * Write one store, keeping only the pairs the log still holds.
 *
 * A DROPPED SESSION IS NEVER RESURRECTED. `clean --drop` removes the store and its derived caches
 * together — deliberately, because these files hold the session's own content — and a flush running
 * afterwards would recreate the directory behind it. So the store's own log is the licence to write:
 * gone means the caller has been dropped, and the right thing to leave behind is nothing.
 */
export function flushContent(session: string, name: ContentStore, live: Set<string>): void {
  const e = stores.get(slotKey(session, name));
  const file = derivedPath(session, name);
  if (!e || !file) return;
  if (!fs.existsSync(logPath(session))) {
    stores.delete(slotKey(session, name));
    return;
  }
  const extra = liveExtra.get(`${rootDir()}\u0000${session}`);
  const keep = live.size ? new Map([...e.map].filter(([k]) => live.has(k) || (extra?.has(k) ?? false))) : e.map;
  // Write when something was LEARNED or something must be DROPPED. Gating on `dirty` alone meant a
  // pass that hit every pair in memory — the common case once the cache is warm — never reaped the
  // entries of records `clean --resolved` had removed, and they leaked forever.
  if (!e.dirty && keep.size === e.map.size) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION[name], pairs: Object.fromEntries(keep) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    // The in-process map follows the file, or the next flush would re-add what this one just reaped.
    e.map = keep;
    e.dirty = false;
  } catch {
    /* best effort */
  }
}

/** The delta store's flush, named — `observe`'s change-map pass calls this explicitly. */
export function flushPairDeltas(session: string, live: Set<string>): void {
  flushContent(session, 'deltas', live);
}

// A view batch deliberately uses one inventory, including when it asks for many sibling stamps.
// Outside a batch every lookup is fresh; a long-lived host must start a new scope for each request.
let inventory: Map<string, unknown> | null = null;
export function withDerivedInventory<T>(build: () => T): T {
  if (inventory) return build();
  inventory = new Map();
  try { return build(); } finally { inventory = null; }
}
export function derivedInventory<T>(key: string, read: () => T): T {
  if (!inventory) return read();
  if (!inventory.has(key)) inventory.set(key, read());
  return inventory.get(key) as T;
}
