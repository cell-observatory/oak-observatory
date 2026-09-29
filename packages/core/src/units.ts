/**
 * REVIEW UNITS — what a person is actually asked to accept or revert.
 *
 * The unit used to be a *record*: one captured tool call, a whole-file before/after snapshot pair.
 * `groups.ts` merged records by chaining their blobs between ADJACENT pairs, which misses the shape
 * agents produce constantly — revise a region, go elsewhere, come back to it. The first of those two
 * edits then owns no line on disk (a later one rewrote them) yet still asks for its own decision. That
 * phantom row is what this module removes.
 *
 * Widening the adjacent merge transitively was measured and rejected: closure over a record chain is
 * governed by coverage, so a long session collapses a whole file into one 3,000-member unit, and since
 * a unit is attributed to its newest member, every earlier ask reports zero edits.
 *
 * Deriving units positionally from a net diff (baseline vs current) was also rejected, for a reason
 * that is easy to miss and decisive: **every diff surface in this product renders a blob PAIR.**
 * `Diffs.show` reads `readBlob(rec.beforeBlob)` / `readBlob(rec.afterBlob)` (jetbrains ui/Diffs.kt),
 * and VS Code's `openDiff` builds its two URIs the same way. Neither has a "render exactly these hunks"
 * path. A unit whose members are not CONTIGUOUS in the file's chain has no exact pair to show — the row
 * would claim a change the diff you open does not contain.
 *
 * So a unit is a **contiguous span of one file's records**, chosen so that:
 *
 *   - edits to the same code land in one span (the reported complaint),
 *   - `(span-first.beforeBlob, span-last.afterBlob)` is exactly that unit's change, so every existing
 *     diff surface keeps working untouched,
 *   - and the span is bounded by the file's own chain rather than by the session's length.
 *
 * The walk is: split a file's records into runs that are genuinely consecutive, find the same-code
 * components inside each run, then widen each component to its covering span and merge spans that
 * interleave. Nothing is stored; the log is the state.
 */
import { diffArrays } from 'diff';
import { EditRecord, EditStatus, blobText as storeBlobText, logPath, readLog } from './store';
import { canonPath } from './paths';
import { cachedByFiles } from './fscache';
import { contentGet, contentNote, fileMark, flushContent, pairKeyOf, persisted } from './derived';
import { tokenizeLines } from './merge';
import { askBoundaries, windowOf } from './asks';
import { detectScopes, familyOf, scopeAt } from './scopes';

/** A review unit: one decision a person is asked to make. */
export interface ReviewUnit {
  file: string;
  /** Ascending record ids, CONTIGUOUS in this file's chain. `keep`/`undo` act on exactly these. */
  recordIds: number[];
  /** This chain CANCELS OUT — it ends on the content it started from, so there is nothing to review
   *  (a file created then deleted, an edit put back). Surfaces keep these out of the row list and
   *  account for them in one footer instead: a row that costs a decision and says nothing is the
   *  thing `capture.ts` already refuses to record for a single edit. */
  cancelled?: boolean;
}

function blobText(session: string, sha: string | null): string {
  if (!sha) return '';
  try {
    return storeBlobText(session, sha);
  } catch {
    return '';
  }
}

/**
 * What one record did, from ONE diff of its own two snapshots:
 *  - `afterAdded`    — indices in `after` it produced,
 *  - `beforeChanged` — indices in `before` it removed or replaced (plus the anchor of a pure insertion),
 *  - `keep`          — before-index → after-index for every line that SURVIVED it.
 *
 * All three come from a single `diffArrays` pass on purpose: computing them separately runs the
 * identical Myers alignment over the identical pair of arrays twice, which `ranges.ts` already
 * measured at 35% of its loop.
 */
interface HopShape {
  afterAdded: Set<number>;
  beforeChanged: Set<number>;
  /** before-index → after-index for every surviving line. RUN-ENCODED and looked up by binary search:
   *  a Map per hop held ~8KB for a 3,000-line file, and a session of 8,000 hops could never keep them
   *  all — while the walk only ever asks it about a member's few tracked lines. */
  keep: KeepMap;
  /** The innermost scope every produced line sits in, or null — derived ONCE, beside the diff, because
   *  it needs the after-text this hop is otherwise the last reader of. */
  scope: string | null;
  /** The exact bytes of a pure deletion's / pure insertion's block, when the hop is one and the block
   *  is small enough to keep; otherwise `blockText` re-reads the blob on demand. */
  blockS?: string;
  blockE?: string;
}

interface KeepMap {
  get(line: number): number | undefined;
}

/** `k` is triples [beforeStart, afterStart, len], ascending by beforeStart — the unchanged parts of
 *  one Myers alignment, which is exactly what a keep-map is. */
function keepOf(k: number[]): KeepMap {
  const n = Math.floor(k.length / 3);
  return {
    get(line) {
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const bs = k[mid * 3];
        if (line < bs) hi = mid - 1;
        else if (line >= bs + k[mid * 3 + 2]) lo = mid + 1;
        else return k[mid * 3 + 1] + (line - bs);
      }
      return undefined;
    },
  };
}

/** A sorted set of line indices as [start, len, start, len, …] — a changed region is a few runs,
 *  never a list of every line. */
function encodeRuns(set: Set<number>): number[] {
  const s = [...set].sort((x, y) => x - y);
  const out: number[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(s[i], j - i + 1);
    i = j + 1;
  }
  return out;
}

function decodeRuns(runs: number[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + 1 < runs.length; i += 2) for (let k = 0; k < runs[i + 1]; k++) out.add(runs[i] + k);
  return out;
}

/** The persisted hop — what the content store keeps under `pairKeyOf(before, after)`, so a pair
 *  derived by ANY earlier process (a poll, an editor host, `list`) answers the next one. `f` is the
 *  scope detector's family for the record's file: the scope name was read with that detector, and a
 *  pair reached through a differently-named file must not inherit it. */
interface HopRec {
  f: string;
  a: number[];
  b: number[];
  k: number[];
  s: string | null;
  bs?: string;
  be?: string;
}

/** A pure block bigger than this is not persisted — `blockText` re-reads the blob for it instead. */
const BLOCK_KEEP_MAX = 32 * 1024;

const hopMemo = new Map<string, HopShape>();
// Runs, not maps: a hop is a few hundred bytes now, so the cap is about count, not memory.
const HOP_MEMO_CAP = 20000;

function remember(key: string, value: HopShape): HopShape {
  if (hopMemo.size >= HOP_MEMO_CAP) hopMemo.clear();
  hopMemo.set(key, value);
  return value;
}

function joinLines(tok: string[], lines: Set<number>): string {
  return [...lines].sort((x, y) => x - y).map((i) => tok[i]).join('');
}

/**
 * One record's hop: in-process memo, then the persisted content store, then the diff itself.
 *
 * MEASURED 2026-09-16 on a live 8,745-record session: `oak sessions --json` took 15 s on EVERY poll
 * while the agent worked — each new record invalidated the units cache and the recompute re-read
 * 779 MB of blobs and re-ran scope detection over every one of them (10 of the 15 s). A blob pair's
 * diff never changes, so a hop derived once is derived forever; a recompute pays only for the pair no
 * process has seen — the record that just landed.
 */
function hopShape(session: string, file: string, beforeSha: string | null, afterSha: string | null): HopShape {
  const key = `${session}|${beforeSha ?? ''}|${afterSha ?? ''}`;
  const hit = hopMemo.get(key);
  if (hit) return hit;
  const family = familyOf(file) ?? '';
  const pk = pairKeyOf(beforeSha, afterSha);
  const rec = contentGet<HopRec>(session, 'hops', pk);
  if (rec && rec.f === family && Array.isArray(rec.a) && Array.isArray(rec.b) && Array.isArray(rec.k)) {
    return remember(key, {
      afterAdded: decodeRuns(rec.a),
      beforeChanged: decodeRuns(rec.b),
      keep: keepOf(rec.k),
      scope: typeof rec.s === 'string' ? rec.s : null,
      ...(typeof rec.bs === 'string' ? { blockS: rec.bs } : {}),
      ...(typeof rec.be === 'string' ? { blockE: rec.be } : {}),
    });
  }
  const b = tokenizeLines(blobText(session, beforeSha));
  const a = tokenizeLines(blobText(session, afterSha));
  const afterAdded = new Set<number>();
  const beforeChanged = new Set<number>();
  const k: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const part of diffArrays(b, a)) {
    if (part.added) {
      for (let i = 0; i < part.value.length; i++) afterAdded.add(ai + i);
      beforeChanged.add(bi); // a pure insertion anchors on the before-side line it sits at
      ai += part.value.length;
    } else if (part.removed) {
      for (let i = 0; i < part.value.length; i++) beforeChanged.add(bi + i);
      bi += part.value.length;
    } else {
      k.push(bi, ai, part.value.length);
      ai += part.value.length;
      bi += part.value.length;
    }
  }
  const value: HopShape = { afterAdded, beforeChanged, keep: keepOf(k), scope: scopeNameOf(session, file, afterSha, afterAdded) };
  // The pure-hop block, kept beside the shape while small: it is what move detection compares, and
  // reading it later means reading the whole blob again.
  if (afterAdded.size === 0 && beforeChanged.size > 0) {
    const t = joinLines(b, beforeChanged);
    if (t.length <= BLOCK_KEEP_MAX) value.blockS = t;
  } else if (afterAdded.size > 0 && beforeChanged.size === 1) {
    const t = joinLines(a, afterAdded);
    if (t.length <= BLOCK_KEEP_MAX) value.blockE = t;
  }
  contentNote<HopRec>(session, 'hops', pk, {
    f: family,
    a: encodeRuns(afterAdded),
    b: encodeRuns(beforeChanged),
    k,
    s: value.scope,
    ...(value.blockS !== undefined ? { bs: value.blockS } : {}),
    ...(value.blockE !== undefined ? { be: value.blockE } : {}),
  });
  return remember(key, value);
}

/**
 * The innermost function or class this record changed, by name — or null when the language is outside
 * the detector's table, the change sits at top level, or it spans more than one scope.
 *
 * Spanning several scopes answers null on purpose: "this record edited `parse` and `load`" is not a
 * same-function signal, and picking one of them would merge on a coin flip.
 */
// Content-addressed like hopMemo, and for the same reason: `detectScopes` walks EVERY line of the
// after-text (7 regexes/line for brace languages), and running it per record per cold derivation was
// measured at 1.5s for 1000 edits to a 3000-line .ts file — ~6× the whole rest of the walk. A blob's
// scopes never change, so one scan per blob is the honest cost.
const scopeMemo = new Map<string, ReturnType<typeof detectScopes>>();
const SCOPE_MEMO_CAP = 4000;

function scopesForBlob(session: string, sha: string | null, file: string): ReturnType<typeof detectScopes> {
  const key = `${session}${sha ?? ''}${file}`;
  const hit = scopeMemo.get(key);
  if (hit) return hit;
  const spans = detectScopes(blobText(session, sha), file);
  if (scopeMemo.size >= SCOPE_MEMO_CAP) scopeMemo.clear();
  scopeMemo.set(key, spans);
  return spans;
}

/**
 * The exact bytes of a pure insertion's or deletion's block, memoized per hop.
 *
 * `tokenizeLines(blobText(...))` splits the WHOLE file to keep a handful of lines, and both branches
 * that need it are the common shape rather than the rare one: a create has no before-side and a
 * delete has no after-side, so on a Bash-heavy session 94% of records took them — measured at 3,276
 * calls re-splitting 1.8 million lines on EVERY derivation. The block itself is small and is fixed by
 * (blob, changed-line set), which the hop key already identifies; only the strings are kept, never
 * the tokenized files.
 */
const blockMemo = new Map<string, string>();
const BLOCK_MEMO_CAP = 20000; // block text, not file text — entries are lines, not megabytes

function blockText(session: string, sha: string | null, lines: Set<number>, side: 's' | 'e'): string {
  const key = `${session}|${sha ?? ''}|${side}|${lines.size}`;
  const hit = blockMemo.get(key);
  if (hit !== undefined) return hit;
  const tok = tokenizeLines(blobText(session, sha));
  const text = [...lines].sort((x, y) => x - y).map((i) => tok[i]).join('');
  if (blockMemo.size >= BLOCK_MEMO_CAP) blockMemo.clear();
  blockMemo.set(key, text);
  return text;
}

function scopeNameOf(session: string, file: string, afterSha: string | null, afterAdded: Set<number>): string | null {
  if (!afterAdded.size) return null;
  const spans = scopesForBlob(session, afterSha, file);
  if (!spans.length) return null;
  let name: string | null = null;
  for (const line of afterAdded) {
    const hit = scopeAt(spans, line);
    if (!hit) return null; // part of the change is outside any scope — not a clean "same function"
    if (name === null) name = hit.name;
    else if (name !== hit.name) return null;
  }
  return name;
}

function intersects(a: Set<number>, b: Set<number>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) return true;
  return false;
}

/**
 * Split a file's records into runs that are genuinely consecutive.
 *
 * A run breaks when the chain breaks (`e.afterBlob !== f.beforeBlob` — a state we did not produce
 * intervened), and ALSO when a record of any OTHER status sits between them by id. The second rule is
 * not belt-and-braces: `undoEdit` writes a record's `beforeBlob` back verbatim, so a file's content can
 * legitimately revisit an earlier state, and blob equality alone would let a pending run bridge over a
 * kept or undone record — making a span revert rewrite content whose decision was already made, with
 * no status flip to show for it.
 */
function runsOf(all: EditRecord[], mine: EditRecord[], boundaries: number[]): EditRecord[][] {
  const runs: EditRecord[][] = [];
  let cur: EditRecord[] = [];
  // `all` is id-sorted and `mine` is a subsequence of it, so "was anything of another status between
  // these two" is an index comparison rather than a scan. Doing it as a scan was quadratic: 2,000
  // records in one file cost 4M comparisons for a question answered by `idx(f) - idx(e) === 1`.
  const idx = new Map(all.map((r, i) => [r.id, i]));
  for (const rec of mine) {
    const prev = cur[cur.length - 1];
    const chained = prev && prev.afterBlob !== null && rec.beforeBlob !== null && prev.afterBlob === rec.beforeBlob;
    const interleaved = prev && (idx.get(rec.id) as number) - (idx.get(prev.id) as number) !== 1;
    // A unit never spans two asks. Without this, one revisited line chains the whole file into a single
    // decision — measured: a 400-line file where the agent returns to a line once every 100 edits
    // collapses 200 edits into ONE unit, because interleaving spans merge transitively. It is also
    // what keeps prompt attribution honest: a unit belongs to exactly one ask, so no earlier ask can
    // report zero edits for work it caused.
    const sameTurn = prev && windowOf(boundaries, prev.ts) === windowOf(boundaries, rec.ts) &&
      (!prev.promptId || !rec.promptId || prev.promptId === rec.promptId);
    const sameModel = !prev || (!prev.model || !rec.model || prev.model === rec.model) &&
      (!prev.runtime || !rec.runtime || prev.runtime === rec.runtime);
    if (!prev || !chained || interleaved || !sameTurn || !sameModel) {
      if (cur.length) runs.push(cur);
      cur = [rec];
      continue;
    }
    cur.push(rec);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** Same-code components inside one run, as sets of record ids. */
function componentsOf(session: string, run: EditRecord[]): number[][] {
  const parent = new Map<number, number>();
  for (const r of run) parent.set(r.id, r.id);
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    while (parent.get(x) !== root) {
      const next = parent.get(x) as number;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent.set(find(a), find(b));
  };

  // Walk forward, carrying every earlier member's SURVIVING produced lines in the run's current
  // coordinates. When a member rewrites lines an earlier one produced, they are the same code — the
  // adjacent case is exactly today's rule, and the non-adjacent case is the one it was missing.
  // "Same function" is the second half of the rule, and it is matched by NAME rather than by line
  // range. A range would have to be carried across every later hop to stay meaningful; a name survives
  // the code moving, which is what makes two edits to `parse()` one decision even when the second one
  // shifted the first one's lines. Two same-named functions in one file would over-merge — rare within
  // a single file and a single ask, and the honest failure direction: one decision instead of two.
  const scopeOf = new Map<number, string>();
  const tracked = new Map<number, Set<number>>();
  // MOVE detection, the third signal: a hop that only DELETES a block and a hop that only INSERTS the
  // identical block are one decision — the block moved. Neither signal above can connect them: a pure
  // deletion produces no lines to carry (it is never tracked), and a pure insertion rewrites no line
  // an earlier member produced (its beforeChanged is just the anchor). Equality is content-exact but
  // ROTATION-tolerant: when a block's boundary line also appears beside it (a docblock's `/**`, a
  // brace, a blank line), Myers attributes a slid window — measured on this repo's own store, a moved
  // 12-line comment was deleted as `body + the NEXT comment's /**` and inserted as `/** + body` — and
  // the two windows are exact rotations of one another. `(y+y).includes(x)` at equal length is the
  // classic rotation test; a rotation that is not literally a move still merges two hops into one
  // honest decision, the failure direction this walk already prefers. Bounded to this run, which is
  // already chained, same-file, same-ask; pure hops are rare, so the lists stay tiny.
  const pureDeletes: { text: string; id: number }[] = [];
  const pureInserts: { text: string; id: number }[] = [];
  // Both sides are TERMINATED before comparing (an unterminated final line gains its `\n`): the
  // rotation identity is cyclic, so the junction between "end" and "start" needs its separator — with
  // it stripped, every real rotation fails at exactly that junction — and terminating also makes a
  // block moved to or from EOF (whose last line has no `\n`) compare equal to its mid-file form.
  const term = (s: string): string => (s.endsWith('\n') ? s : s + '\n');
  const sameBlock = (x: string, y: string): boolean => {
    const a = term(x);
    const b = term(y);
    return a === b || (a.length === b.length && (b + b).includes(a));
  };
  for (const rec of run) {
    const hop = hopShape(session, rec.file, rec.beforeBlob, rec.afterBlob);
    const { afterAdded, beforeChanged, keep } = hop;
    for (const [id, lines] of tracked) if (intersects(lines, beforeChanged)) union(id, rec.id);

    if (afterAdded.size === 0 && beforeChanged.size > 0) {
      // Pure deletion. tokenizeLines keeps terminators, so the join IS the block's exact bytes.
      const text = hop.blockS ?? blockText(session, rec.beforeBlob, beforeChanged, 's');
      if (text.trim()) {
        for (const p of pureInserts) if (sameBlock(text, p.text)) union(p.id, rec.id);
        pureDeletes.push({ text, id: rec.id });
      }
    } else if (afterAdded.size > 0 && beforeChanged.size === 1) {
      // Pure single-block insertion, proven by shape alone: every added part contributes one anchor
      // to beforeChanged and every removed part contributes its lines, so ONE entry beside added
      // lines means one insertion point and zero removals — no second tokenize needed to know it.
      const text = hop.blockE ?? blockText(session, rec.afterBlob, afterAdded, 'e');
      if (text.trim()) {
        for (const p of pureDeletes) if (sameBlock(p.text, text)) union(p.id, rec.id);
        pureInserts.push({ text, id: rec.id });
      }
    }

    // The scope this record changed, read from its OWN after-text so no coordinate mapping is needed —
    // derived once with the hop and carried in it.
    const name = hop.scope;
    if (name) {
      for (const [id, other] of scopeOf) if (other === name) union(id, rec.id);
      scopeOf.set(rec.id, name);
    }
    // Carry the survivors across this hop; lines this record rewrote simply stop existing.
    //
    // A member whose lines have ALL died is dropped rather than carried as an empty set. That is not
    // tidiness — it is what keeps the walk linear. Every hop maps every live member's set, so carrying
    // exhausted members makes the walk quadratic in the run length: measured on 2,000 edits to one
    // file, keeping them cost 431 ms against 174 ms for the engine this replaces. A member with no
    // surviving lines can never be unioned with again (the test is an intersection with its lines), so
    // dropping it cannot change a single grouping decision.
    for (const [id, lines] of tracked) {
      const next = new Set<number>();
      for (const l of lines) {
        const to = keep.get(l);
        if (to !== undefined) next.add(to);
      }
      if (next.size) tracked.set(id, next);
      else tracked.delete(id);
    }
    if (afterAdded.size) tracked.set(rec.id, new Set(afterAdded));
  }

  const byRoot = new Map<number, number[]>();
  for (const rec of run) {
    const root = find(rec.id);
    const arr = byRoot.get(root);
    if (arr) arr.push(rec.id);
    else byRoot.set(root, [rec.id]);
  }
  return [...byRoot.values()].map((ids) => ids.sort((a, b) => a - b));
}

/**
 * Widen each component to its covering span and merge spans that interleave.
 *
 * This is what keeps a unit's `(first.beforeBlob, last.afterBlob)` an EXACT description of it. When one
 * record sits inside another component's span — an edit elsewhere in the file between two edits to the
 * same code — it joins that decision rather than being stranded inside a diff that already contains it.
 * Components whose spans do not interleave stay separate, so two independent fixes in one file remain
 * independently reviewable.
 */
function spansOf(components: number[][], run: EditRecord[]): number[][] {
  const order = run.map((r) => r.id);
  const pos = new Map(order.map((id, i) => [id, i]));
  const ranges = components
    .map((ids) => ({
      lo: Math.min(...ids.map((i) => pos.get(i) as number)),
      hi: Math.max(...ids.map((i) => pos.get(i) as number)),
    }))
    .sort((a, b) => a.lo - b.lo);

  const out: number[][] = [];
  let cur = ranges[0];
  for (let i = 1; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.lo <= cur.hi) {
      if (r.hi > cur.hi) cur = { ...cur, hi: r.hi };
      continue;
    }
    out.push(order.slice(cur.lo, cur.hi + 1));
    cur = r;
  }
  if (cur) out.push(order.slice(cur.lo, cur.hi + 1));
  return out;
}

/**
 * Fold the chains the per-ask walk cannot see: spans that meet where the FILE DOES NOT EXIST, and
 * spans that CANCEL OUT by returning to their own starting content.
 *
 * Both exist because a unit never spans two asks (one revisited line would otherwise chain a whole
 * file into a single decision), and both describe a chain that is one story for the reader:
 *
 *   - **Absence is not a state anyone can review.** A junction where the file is gone has no
 *     before/after to show — `null` is not content — so a delete and the re-create that follows it
 *     are one decision, and the merged `(first.beforeBlob, last.afterBlob)` pair is the real change.
 *     Splitting them produced the reported bug: a row claiming "+0 −133" for a file that still
 *     exists, followed by one claiming "+133 −0" for a file that was never created.
 *   - **A chain whose end content is byte-identical to its start is NOT A CHANGE** — the file is
 *     exactly as Claude found it — and showing it as two contradictory rows asks the reader to
 *     decide twice about nothing. Blobs are content-addressed, so sha equality IS content equality.
 *
 * Deliberately narrow: absence merges only across a null junction, and the cancel walk merges only a
 * span that returns to its OWN starting content, so neither chains transitively the way a general
 * cross-ask merge would.
 *
 * Two costs, both of them real, both stated where they are paid:
 *  - **Attribution.** A merged unit's representative is its newest member, so the earlier ask stops
 *    naming it. Every id stays in `recordIds`, so keep/undo act on the whole chain and the ledger
 *    loses nothing.
 *  - **Rewind reach.** A unit is the smallest thing that can be reverted, so "rewind to before ask N"
 *    reverts a unit that STARTED in ask N−1 when the file was absent at the boundary — otherwise the
 *    file would land on content neither ask produced. `checkpointScope` counts those records as
 *    `fromEarlier` and every confirmation names them (`prompts.ts`).
 */
function foldChains(all: EditRecord[], spans: number[][]): { ids: number[]; cancelled: boolean }[] {
  const byId = new Map(all.map((r) => [r.id, r]));
  const first = (s: number[]) => byId.get(s[0]) as EditRecord;
  const last = (s: number[]) => byId.get(s[s.length - 1]) as EditRecord;
  /** "The file was not there" — including the records older stores and fixtures wrote with no blob
   *  field at all. Every comparison below goes through this or `key`, or an absent field reads as
   *  content that cannot match anything, including another absent field. */
  const absent = (sha: string | null | undefined) => (sha ?? null) === null;
  /** Content key: one bucket for every spelling of "not there". Blob shas are hex, so the sentinel
   *  cannot collide with one. */
  const key = (sha: string | null | undefined) => sha ?? ' none';
  /**
   * A span carrying NO content on either side of any member — the blob-less records some fixtures
   * and older stores hold. It has nothing to say and nothing to cancel, so it neither absorbs nor is
   * absorbed; letting it join would chain every one of them into a bogus unit.
   *
   * This is deliberately NOT "the span nets to nothing". A create→delete cycle also nets to nothing
   * and used to be treated as inert here, which stranded its cancelling partner: on a real session
   * every file with an alternating delete/create chain kept its FIRST and LAST record as two
   * contradictory rows, because the walk refused to cross the net-empty cycles between them.
   */
  const inert = (s: number[]) =>
    s.every((id) => {
      const r = byId.get(id) as EditRecord;
      return absent(r.beforeBlob) && absent(r.afterBlob);
    });
  /**
   * A unit that ends on the content it started from is nothing to review however it got there —
   * including the create-then-delete the per-ask walk already merged on its own.
   *
   * An INERT span is not that claim: "cancels out" says the file is exactly as Claude found it, and a
   * record with no content on either side is evidence of nothing. Marking those cancelled hid them
   * from every row list and from the change map — a record the store cannot describe is exactly the
   * thing to show, not to swallow.
   */
  const cancels = (ids: number[]) => !inert(ids) && key(first(ids).beforeBlob) === key(last(ids).afterBlob);
  if (spans.length < 2) return spans.map((ids) => ({ ids, cancelled: cancels(ids) }));
  // Position in the FILE's own record order, all statuses — the same index `runsOf` compares.
  const pos = new Map(all.map((r, i) => [r.id, i]));
  /**
   * NEIGHBOURS in the file's record order. Without this a chain bridged over kept and undone
   * records — which is exactly what `runsOf` refuses, and what makes `recordIds` "contiguous in this
   * file's chain" true rather than aspirational.
   */
  const adjacent = (a: number[], b: number[]): boolean =>
    (pos.get(first(b).id) as number) - (pos.get(last(a).id) as number) === 1;

  // PASS 1 — absence is not a boundary. Merged before the cancel walk so the walk compares CONTENT
  // junctions only, which is the only kind a reader could be asked to decide about.
  const ordered: number[][] = [];
  for (const span of [...spans].sort((a, b) => a[0] - b[0])) {
    const prev = ordered[ordered.length - 1];
    if (
      prev &&
      absent(last(prev).afterBlob) &&
      absent(first(span).beforeBlob) &&
      adjacent(prev, span) &&
      !inert(prev) &&
      !inert(span)
    ) {
      // push, not concat: on a file that flickers thousands of times this accumulator IS the whole
      // file, and rebuilding it per merge copied 92M elements at 19,200 spans. `spansOf` allocates
      // each span fresh, so growing the first one in place is safe.
      for (const id of span) prev.push(id);
      continue;
    }
    ordered.push(span);
  }

  // PASS 2 — the cancel walk over what is left.
  const joins = (a: number[], b: number[]): boolean =>
    key(last(a).afterBlob) === key(first(b).beforeBlob) && adjacent(a, b);
  /** First position STRICTLY after `k` in an ascending list.
   *
   *  Not quite the shortest cancelling extent, and deliberately so: a span that already goes nowhere
   *  on its own is skipped and absorbed into the longer chain around it (measured on random corpora
   *  at ~1 merge in 3). Every such unit is cancelled either way, so this only makes one Dismiss
   *  coarser — and stopping at `k` itself would make a self-cancelling span end every chain, which is
   *  the stranding this whole function was rewritten to remove. */
  const nextAfter = (arr: number[] | undefined, k: number): number => {
    if (!arr) return -1;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] > k) hi = mid;
      else lo = mid + 1;
    }
    return lo < arr.length ? arr[lo] : -1;
  };

  const out: { ids: number[]; cancelled: boolean }[] = [];
  let i = 0;
  while (i < ordered.length) {
    if (inert(ordered[i])) {
      // Nothing to cancel and nothing to chain to: a record with no content on either side is
      // evidence of nothing, so it neither absorbs nor is absorbed — and it is NOT claimed to cancel
      // out, or the one thing the store cannot describe would be the one thing no surface shows.
      out.push({ ids: ordered[i], cancelled: false });
      i++;
      continue;
    }
    // The maximal unbroken chain starting here. Everything below is scoped to it, which is what
    // keeps this LINEAR: the old forward scan re-walked the whole file per start (measured 1.2 s at
    // 8,000 spans — the same quadratic shape `runsOf` rejected for the same question).
    let end = i;
    while (end + 1 < ordered.length && !inert(ordered[end + 1]) && joins(ordered[end], ordered[end + 1])) end++;
    const afterAt = new Map<string, number[]>();
    for (let k = i; k <= end; k++) {
      const k2 = key(last(ordered[k]).afterBlob);
      const arr = afterAt.get(k2);
      if (arr) arr.push(k);
      else afterAt.set(k2, [k]);
    }
    let k = i;
    while (k <= end) {
      // `afterAt` only holds positions in [i, end], so a hit is always inside this chain.
      const j = nextAfter(afterAt.get(key(first(ordered[k]).beforeBlob)), k);
      if (j < 0) {
        // No partner — but a span can still go nowhere on its own (a create→delete cycle reaches
        // this line now that it is no longer treated as inert), and reporting it as a change would
        // put back the "+0 −0" row every surface was taught to hide.
        out.push({ ids: ordered[k], cancelled: cancels(ordered[k]) });
        k++;
      } else {
        out.push({ ids: ordered.slice(k, j + 1).flat(), cancelled: true });
        k = j + 1;
      }
    }
    i = end + 1;
  }
  return out;
}

function computeUnits(session: string, status: EditStatus): ReviewUnit[] {
  const log = readLog(session);
  const byFileAll = new Map<string, EditRecord[]>();
  for (const r of log) {
    const key = canonPath(r.file);
    const arr = byFileAll.get(key);
    if (arr) arr.push(r);
    else byFileAll.set(key, [r]);
  }
  // Empty when there is no transcript beside the store, which means one unbounded window — the same
  // answer this had before turns existed, rather than refusing to group.
  const boundaries = askBoundaries(session);
  const out: ReviewUnit[] = [];
  for (const [file, all] of byFileAll) {
    all.sort((a, b) => a.id - b.id);
    const mine = all.filter((r) => r.status === status);
    if (!mine.length) continue;
    const spans: number[][] = [];
    for (const run of runsOf(all, mine, boundaries)) {
      for (const span of spansOf(componentsOf(session, run), run)) spans.push(span);
    }
    // …then fold the chains the per-ask walk above cannot see: those that meet where the file does
    // not exist, and those that cancel out.
    for (const span of foldChains(all, spans)) {
      out.push(span.cancelled ? { file, recordIds: span.ids, cancelled: true } : { file, recordIds: span.ids });
    }
  }
  // Persist what this pass derived NOW, not only at exit: the terminal app's warm `views --serve`
  // child and an editor host live for hours, and every other process would otherwise pay for the
  // same hops again until they quit. Pruned to the log's pairs, exactly like the exit flush.
  const live = new Set<string>();
  for (const r of log) live.add(pairKeyOf(r.beforeBlob, r.afterBlob));
  flushContent(session, 'hops', live);
  return out;
}

/** The one FILE the unit split is derived from. The transcript is an input too, but not by its bytes
 *  — see `unitKey`. */
function unitStamps(session: string): string[] {
  return [logPath(session)];
}

/**
 * What the split actually depends on in the transcript: the ASK BOUNDARIES, not the transcript's size
 * and mtime.
 *
 * Stamping the transcript file re-derived every unit in the session on every APPEND to it — and a
 * transcript grows with each message, not each ask. Measured on a live 3,468-record session: ~200 ms
 * of core work per message, ~10 times a minute during active work, none of which could change the
 * answer. Boundaries are memoized on the transcript in `asks.ts`, so this costs a stat when nothing
 * moved; a new ask changes the signature and invalidates as it must.
 */
function unitKey(session: string, status: EditStatus): string {
  const b = askBoundaries(session);
  return `units:${status}:${b.length}:${b.length ? b[b.length - 1] : 0}`;
}

/**
 * Every review unit for a session at one status. Memoized on `log.jsonl` + the ask boundaries —
 * IN PROCESS and ON DISK.
 *
 * The in-process half was right and useless on its own: the read commands are spawned, so a
 * dashboard poll is a fresh process and the memo is always empty. Measured on a 978-record session,
 * this split cost 4.5s on EVERY poll (three statuses, each a full walk), and nothing about the
 * answer had changed. The disk half is keyed by exactly the same two inputs, so it invalidates in
 * exactly the same places; it simply survives exit.
 */
export function reviewUnits(session: string, status: EditStatus = 'pending'): ReviewUnit[] {
  return cachedByFiles(unitKey(session, status), unitStamps(session), () =>
    persisted(session, `units-${status}`, `${unitKey(session, status)}|${fileMark(logPath(session))}`, () =>
      computeUnits(session, status)
    )
  );
}

/** repId → ascending member ids — the shape the grouping layer has always returned. */
export function unitGroups(session: string, status: EditStatus = 'pending'): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const u of reviewUnits(session, status)) {
    if (!u.recordIds.length) continue;
    out.set(u.recordIds[u.recordIds.length - 1], u.recordIds.slice());
  }
  return out;
}

/**
 * The units that CANCEL OUT — rep id → its members. Surfaces list none of these as rows: they show
 * one footer naming the count, whose Dismiss keeps every member at once. Derived from the same
 * memoized `reviewUnits`, so this adds no third walk of the log.
 */
export function cancelledGroups(session: string, status: EditStatus = 'pending'): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const u of reviewUnits(session, status)) {
    if (u.cancelled && u.recordIds.length) out.set(u.recordIds[u.recordIds.length - 1], u.recordIds.slice());
  }
  return out;
}

/**
 * Every record id inside a cancelled chain, at ANY status — the set a surface hides.
 *
 * `cancelledGroups` answers the *pending* question ("what does Dismiss act on"), and that is the
 * wrong set for hiding: dismissing marks the records `kept`, and resolved records are listed raw, so
 * one click on a footer offering ~1,400 chains would bring all of them straight back as greyed rows.
 * A chain that goes nowhere is nothing to look at whatever was decided about it.
 */
export function cancelledMemberIds(session: string, status?: EditStatus): Set<number> {
  return cachedByFiles(`${unitKey(session, status ?? 'pending')}:cancelledIds:${status ?? 'all'}`, unitStamps(session), () => {
    const out = new Set<number>();
    // One status when the caller only ever sees one — the placement and nav paths read PENDING
    // records exclusively, and deriving the other two there would put a whole extra walk of the log
    // on a path that runs per keystroke burst.
    for (const s of status ? [status] : (['pending', 'kept', 'undone'] as EditStatus[])) {
      for (const u of reviewUnits(session, s)) {
        if (u.cancelled) for (const id of u.recordIds) out.add(id);
      }
    }
    return out;
  });
}

/** Every grouped id → its unit's members, across all three statuses. */
export function unitMembersIndex(session: string): Map<number, number[]> {
  return cachedByFiles(`${unitKey(session, 'pending')}:unitIndex`, unitStamps(session), () => {
    const index = new Map<number, number[]>();
    for (const status of ['pending', 'kept', 'undone'] as EditStatus[]) {
      for (const members of unitGroups(session, status).values()) {
        if (members.length < 2) continue; // a lone record is its own unit; `?? [id]` covers it
        for (const id of members) index.set(id, members);
      }
    }
    return index;
  });
}

/**
 * DEPENDENCIES between units — line-range ancestry, not adjacency.
 *
 * Unit B depends on unit A when a member of B rewrote a line A produced. This is the same
 * surviving-line bookkeeping `componentsOf` runs inside one run, applied FILE-WIDE across records of
 * EVERY status, at unit granularity: each unit's produced lines are carried through every later hop's
 * coordinate map, and a hop whose before-side change intersects a carried set draws a DIRECT edge
 * from the editing unit to the touched one. The touched lines leave their old owner's set — their
 * replacements belong to the editing unit — so an ancestry chain yields C→B and B→A, never C→A.
 * Ask boundaries deliberately do NOT clear the carry: units never merge across asks, and this edge
 * is exactly how the cross-ask relationship stays visible. An external write does clear it — nothing
 * is attributable across content we did not produce.
 *
 * Undo is where the edge earns its keep: undoing a depended-on unit three-way-merges against content
 * a later unit rewrote, so the merge already refuses. The edge lets that refusal NAME the dependent
 * and offer the closure as one action (see undo.ts).
 */
export function unitDeps(session: string): Map<number, number[]> {
  return cachedByFiles('unitDeps', unitStamps(session), () => {
    const repOf = repIndex(session);
    const byFile = new Map<string, EditRecord[]>();
    for (const r of readLog(session)) {
      const key = canonPath(r.file);
      const arr = byFile.get(key);
      if (arr) arr.push(r);
      else byFile.set(key, [r]);
    }
    const deps = new Map<number, Set<number>>();
    for (const recs of byFile.values()) {
      recs.sort((a, b) => a.id - b.id);
      const carried = new Map<number, Set<number>>(); // rep → its surviving produced lines, current coords
      let prev: EditRecord | undefined;
      for (const r of recs) {
        const chained =
          prev && prev.afterBlob !== null && r.beforeBlob !== null && prev.afterBlob === r.beforeBlob;
        if (prev && !chained) carried.clear();
        prev = r;
        const unit = repOf(r.id);
        const shape = hopShape(session, r.file, r.beforeBlob, r.afterBlob);
        for (const [owner, lines] of carried) {
          if (owner !== unit && intersects(lines, shape.beforeChanged)) {
            let set = deps.get(unit);
            if (!set) deps.set(unit, (set = new Set()));
            set.add(owner);
          }
        }
        // Translate every carried set through this hop; a set with no survivors is DONE — dropping
        // it is the same pruning that keeps componentsOf linear.
        for (const [owner, lines] of carried) {
          const next = new Set<number>();
          for (const line of lines) {
            const to = shape.keep.get(line);
            if (to !== undefined) next.add(to);
          }
          if (next.size) carried.set(owner, next);
          else carried.delete(owner);
        }
        const own = carried.get(unit) ?? new Set<number>();
        for (const line of shape.afterAdded) own.add(line);
        if (own.size) carried.set(unit, own);
      }
    }
    const out = new Map<number, number[]>();
    for (const [unit, set] of deps) out.set(unit, [...set].sort((a, b) => a - b));
    return out;
  });
}

/** Reps whose units DIRECTLY depend on the unit containing `id`, ascending. Any status filtering is
 *  the caller's — a refusal cares about non-undone dependents, a display might not. */
export function unitDependents(session: string, id: number): number[] {
  const rep = repIndex(session)(id);
  const out: number[] = [];
  for (const [unit, ds] of unitDeps(session)) {
    if (ds.includes(rep)) out.push(unit);
  }
  return out.sort((a, b) => a - b);
}

/** id → its unit's rep (the newest member), across all statuses; a lone record is its own rep. */
function repIndex(session: string): (id: number) => number {
  const index = unitMembersIndex(session);
  return (id: number): number => {
    const members = index.get(id);
    return members ? members[members.length - 1] : id;
  };
}
