/**
 * Two per-process caches over on-disk files, both revalidated by stat on every lookup:
 *
 *   1. `cachedByFiles` — memoized derived VALUES, one entry per (kind, file set).
 *   2. `readText` / `readLines` — the shared RAW TEXT the derivations in (1) are computed from,
 *      byte-budgeted and LRU-evicted. Strictly beneath (1); see the section header further down for
 *      why the order cannot be reversed.
 *
 * Why: one Overview refresh derives several views (change-map, multitask, observations) that each
 * re-read and re-parse the SAME multi-megabyte transcripts — a single `buildChangeMap` used to parse
 * the main transcript ~6 times (actions, subagents, insights, todo snapshots, reasoning, workflows),
 * and the per-sibling fleet views repeat that per agent. Memoizing the pure parsers collapses that to
 * one parse per file per process, which is what makes the Overview load fast on big sessions.
 *
 * Safety: an entry is valid only while its file's (mtimeMs, size) both match, so a long-lived host
 * (the VS Code extension calls core in-process) revalidates on every call and never serves a parse of
 * a file that has since changed. A one-shot CLI process gets pure wins. Derivations that depend on TWO
 * files (e.g. reasoning correlation = transcript × store log) key on both. Entries are capped per kind
 * (insertion-order eviction) so an editor host scanning many sessions can't grow unbounded.
 *
 * Contract for callers: the cached value is returned BY REFERENCE — compute() results must be treated
 * as immutable by every consumer, or the caller must hand out copies (see parseTranscriptActions,
 * whose action records are mutated by attribution and therefore copied per call).
 */
import * as fs from 'fs';

interface Entry {
  stamp: string;
  value: unknown;
}

/** Per kind. Sized for the real worst case: ONE session's own subagent transcripts (a big workflow run
 *  leaves 150+ under subagents/), times the fleet siblings an Overview refresh walks. The old cap of
 *  128 sat just under a single such session's file count, so each pass evicted the entries the next
 *  pass needed and the hit rate collapsed to ~0 — the cache cost stats without ever paying out. */
const CACHE_CAP = 1024;
const caches = new Map<string, Map<string, Entry>>();

/** (mtimeMs:size) for one file, or null when it can't be stat'd (then we never cache). */
function stampOf(p: string): string | null {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    return ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '') ? 'absent' : null;
  }
}

/**
 * Memoize `compute()` against the current (mtimeMs, size) of `paths`. Any stat failure, or any file
 * changing, recomputes; the kind string namespaces independent derivations of the same file.
 */
export function cachedByFiles<T>(kind: string, paths: string[], compute: () => T): T {
  const stamps: string[] = [];
  for (const p of paths) {
    const s = stampOf(p);
    if (s === null) return compute(); // unstat-able input → never cache (result may embed the failure)
    stamps.push(s);
  }
  const key = JSON.stringify(paths); // one entry per file SET — a changed file replaces, never accumulates
  const stamp = stamps.join(' ');
  let cache = caches.get(kind);
  if (!cache) {
    cache = new Map();
    caches.set(kind, cache);
  }
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) {
    // Re-insert so eviction is least-RECENTLY-USED, not merely oldest-inserted: without this a working
    // set slightly larger than the cap evicts exactly the entries still in use.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value as T;
  }
  const value = compute();
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { stamp, value });
  return value;
}

// ---------------------------------------------------------------------------------------------
// Shared raw-text layer — strictly BENEATH the derivation memo above.
// ---------------------------------------------------------------------------------------------
//
// `cachedByFiles` memoizes derived VALUES per kind, and it works: a second call for the same kind
// never touches the file. What it cannot collapse is the FIRST call of each kind, and there are a
// dozen kinds derived from the same transcript. Measured on one cold `views changemap`: 5,458 whole-
// file reads over 2,085 paths delivering 1,739 MiB for 482 MiB of unique bytes — 3.61x — with the
// five biggest transcripts read 6-9 times each because `todoSnaps`, `taskMine`, `subagentMeta`,
// `processes`, `actions`, `promptAsks`, `transcriptInsights` … each legitimately miss once and each
// does its own `readFileSync(...).split('\n')`.
//
// So the fix is a level down: read a file once, split it once, and let every derivation share that.
//
// Ordering matters and is load-bearing. This layer must be called FROM inside `compute()`, never the
// other way round: a `cachedByFiles` hit must not even stat the file, several read sites are not
// wrapped in any memo (parseToolUses), and kinds key on file SETS that include files they never read.
//
// MEMORY. A transcript costs more than its on-disk size once V8 holds it — a single curly quote in
// the first KB forces the whole multi-MiB string to two-byte storage. Measured marginal hold over six
// real transcripts (151 MiB on disk, 158 M chars): 2.4 bytes per character. So the budget below is
// denominated in RETAINED bytes charged at 2/char, not in file bytes; being ~20% optimistic is fine
// for a cap whose job is to stop unbounded growth, and the end-to-end peak RSS is measured, not
// inferred (see TEXT_BUDGET_BYTES). Eviction is least-recently-used. Unbounded is not an option: it
// holds every session an editor host ever visits.
//
// NOT for the tail/head peek sites. `agentPhaseDetail`, `scanTitle`, `firstCwdLine`, the usage-tail
// reader and friends deliberately read a bounded SLICE of a file they must never read whole; 81 files
// worth 290 MiB are only ever peeked at. Routing those through here would read — and retain — all of it.

/**
 * Retained UTF-16 bytes.
 *
 * Chosen by measuring the real cold `views changemap`, not by reasoning about it. Sweeping the budget
 * against read amplification and kernel peak RSS (5 runs each, paired against the unpatched build):
 *
 *     budget    delivered    amp    peak RSS    wall
 *     none      1738.9 MiB   3.61x   825 MiB    5.73 s   ← today
 *      32 MiB   1450.8       3.01    908        5.62
 *      96 MiB    956.7       1.99    785        5.11
 *     192 MiB    485.4       1.008   751        4.61     ← here
 *     256 MiB    485.2       1.007   789        4.57
 *  unbounded     485.2       1.007  1272        4.61
 *
 * 192 MiB is where amplification reaches 1.0 — every file read exactly once — and it costs LESS peak
 * RSS than the unpatched build, because the transient decode garbage it stops producing outweighs the
 * text it retains. Below it the working set thrashes (the five biggest transcripts alone are ~100 MiB
 * on disk and each is wanted by 6-9 derivations); above it nothing more is gained and the cap stops
 * protecting anything — unbounded holds every session an editor host ever visits and lands at 1.27 GiB.
 */
const TEXT_BUDGET_DEFAULT = 192 * 1024 * 1024;

/** The retained-bytes budget, read live so a constrained host can shrink it (`OAK_TEXT_BUDGET_BYTES`)
 *  and a test can force the oversized-file path without a 192 MiB fixture. An unset or unparseable
 *  value keeps the measured default. */
function textBudget(): number {
  const e = Number(process.env.OAK_TEXT_BUDGET_BYTES);
  return Number.isFinite(e) && e > 0 ? e : TEXT_BUDGET_DEFAULT;
}

/**
 * What one cached line costs beyond the parent string: an array slot plus a V8 sliced-string header.
 * Measured 28 B/line holding the split of a 21 MiB transcript (5,946 long lines — V8 slices reference
 * the parent instead of copying). Charged well above that on purpose: the split of a file with a
 * million SHORT lines is mostly headers, and the budget has to see that array rather than its (tiny)
 * text. Over-charging costs cache hits; under-charging costs memory, which is the one this project has
 * already been bitten by.
 */
const LINE_OVERHEAD_BYTES = 72;

interface TextEntry {
  stamp: string;
  text: string;
  /** Materialized lazily by readLines and then shared. Sliced strings retain `text`, so the two can
   *  never be evicted independently — they are one entry with one cost. */
  lines: string[] | null;
  cost: number;
}

/** Insertion order IS the LRU order (re-inserted on every hit), like `caches` above. */
const textCache = new Map<string, TextEntry>();
let textHeld = 0;

/**
 * ONE oversized file — bigger than the whole budget by itself — held in its own slot rather than
 * discarded.
 *
 * The budget's "one file bigger than the whole budget → never retained" rule silently reopened the
 * 6-9x re-read it exists to close the moment a single transcript outgrew it: a live 102 MiB session
 * retains ~204 MiB at 2 B/char, over the 192 MiB cap, so `readLines` fell back to reading and
 * splitting it afresh for every derivation (measured: feed --json did 1,157 MiB of I/O, the main
 * transcript 8x). A session only ever grows, so this is the common case, not the tail.
 *
 * Exactly one such file is held — the most-recently read — so the extra hold is bounded at
 * (budget + the one active transcript), which is the working set a TUI/editor mines at a time. A
 * second oversized file (a fleet sibling as big) evicts the first; the normal LRU cache is untouched
 * by it, and its own entries never evict this slot.
 */
let bigPath: string | null = null;
let bigEntry: TextEntry | null = null;

/**
 * (mtimeMs:size:ino) for one file, or null when it can't be stat'd.
 *
 * `ino` is here and not in `stampOf` because this layer caches raw CONTENT, and content is what a
 * same-size rewrite changes invisibly: the store rewrites `log.jsonl` and every `session-meta/*.json`
 * through tmp+rename, which lands a NEW inode even when mtime granularity is coarse enough to hide
 * the write. Two extra characters in the key, and the whole class of stale-content bugs is gone.
 */
function contentStampOf(p: string): string | null {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Make room for `cost`, then insert. Evicting BEFORE inserting is what keeps a fresh entry from
 *  evicting itself when it alone nearly fills the budget. */
function admit(p: string, stamp: string, text: string, lines: string[] | null): TextEntry {
  const cost = 2 * text.length + (lines ? LINE_OVERHEAD_BYTES * lines.length : 0);
  const entry: TextEntry = { stamp, text, lines, cost };
  const prev = textCache.get(p);
  if (prev) {
    textHeld -= prev.cost;
    textCache.delete(p);
  }
  if (cost > textBudget()) {
    // Bigger than the whole budget: keep it in the single oversized slot (see bigEntry) instead of
    // discarding, so the several derivations of one command share one read. Replaces any prior
    // oversized file; never enters the normal cache or charges its budget.
    bigPath = p;
    bigEntry = entry;
    return entry;
  }
  for (const [k, e] of textCache) {
    if (textHeld + cost <= textBudget()) break;
    textCache.delete(k);
    textHeld -= e.cost;
  }
  textCache.set(p, entry);
  textHeld += cost;
  return entry;
}

/** Move an entry to the MRU end. */
function touch(p: string, e: TextEntry): void {
  textCache.delete(p);
  textCache.set(p, e);
}

/**
 * The whole file as UTF-8 text, read at most once per (path, mtimeMs, size, ino) per process.
 *
 * Throws exactly what `fs.readFileSync` throws — every call site here already has the try/catch that
 * behavior depends on. The returned string is SHARED; strings are immutable, so that is free.
 */
export function readText(p: string): string {
  const before = contentStampOf(p);
  if (before !== null) {
    const hit = textCache.get(p);
    if (hit && hit.stamp === before) {
      touch(p, hit);
      return hit.text;
    }
    if (bigEntry && bigPath === p && bigEntry.stamp === before) return bigEntry.text;
  }
  const text = fs.readFileSync(p, 'utf8');
  if (before === null) return text; // unstampable → readable but not cacheable
  // Re-stat AFTER the read and refuse to cache if the file moved under it, so what an entry holds is
  // exactly the file state its stamp names. This is insurance, not a fix for an observed bug: a torn
  // read of a GROWING transcript is already unreachable, because the entry is keyed on the pre-read
  // stamp and every later lookup stats the larger file and misses. I could not construct a case where
  // dropping this check serves wrong bytes (the no-re-stat mutant passes the same probe); what it does
  // buy is that the budget never retains a snapshot that was never a real file state.
  if (contentStampOf(p) !== before) return text;
  return admit(p, before, text, null).text;
}

/**
 * `readText(p).split('\n')` with the split shared too — the shape every transcript parser wants.
 *
 * CONTRACT: the array is returned BY REFERENCE and must be treated as immutable, exactly like a
 * `cachedByFiles` value. Every call site iterates it read-only.
 */
export function readLines(p: string): string[] {
  const before = contentStampOf(p);
  if (before !== null) {
    const hit = textCache.get(p);
    if (hit && hit.stamp === before) {
      touch(p, hit);
      if (hit.lines) return hit.lines;
      // Text was cached by readText; materialize the split once and re-charge for the array.
      const lines = hit.text.split('\n');
      return admit(p, before, hit.text, lines).lines!;
    }
    if (bigEntry && bigPath === p && bigEntry.stamp === before) {
      if (bigEntry.lines) return bigEntry.lines;
      // The oversized slot held text only (a readText hit); split once and keep it on the slot so the
      // remaining derivations of this command share the array too.
      bigEntry.lines = bigEntry.text.split('\n');
      bigEntry.cost = 2 * bigEntry.text.length + LINE_OVERHEAD_BYTES * bigEntry.lines.length;
      return bigEntry.lines;
    }
  }
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split('\n');
  if (before === null) return lines;
  if (contentStampOf(p) !== before) return lines;
  return admit(p, before, text, lines).lines!;
}

/** Drop every cached entry (tests re-point CLAUDE_CONFIG_DIR at fresh fixtures within one process,
 *  and a long-lived host — the VS Code extension — calls this on deactivate to release the text). */
export function clearFsCache(): void {
  caches.clear();
  textCache.clear();
  textHeld = 0;
  bigPath = null;
  bigEntry = null;
}
