/**
 * The change map, in character cells.
 *
 * Three forms were measured against the real data before this one was chosen.
 *
 * A TREEMAP does not survive. A 100x14 viewport is 1,400 cells; a readable label needs about ten
 * contiguous cells on one row; at 3,957 files that is under one cell each. Neither `ncdu` nor `dust` —
 * the closest prior art for showing a file tree by size in text — draws one either.
 *
 * A GLOBAL TOP-N LEDGER lies by omission. On a real 3,957-file session the top twenty rows cover 18.2%
 * of the churn while looking like the whole story; half the churn needs 109 files and 95% needs 1,218.
 *
 * The existing flat `modules[]` is not a grouping at all: its label is the immediate parent directory,
 * so that same session has five buckets for 3,957 files, with labels up to 92 characters.
 *
 * So: a ROLLED PREFIX TREE — `ncdu`'s scope-and-rescale with `dust`'s roll-up. Aggregation is by path
 * prefix, never by rank, which means every file stays reachable by walking down, and whatever is not
 * shown is always represented by a visible ancestor row carrying its own churn. Nothing is silently
 * dropped, which is the property a top-N list cannot offer.
 *
 * The form also surfaced something a flat ledger had buried: on that session 3,950 of 3,957 files, and
 * 99.98% of all churn, are OUTSIDE the workspace — the agent's own harness directories. The tree says
 * so in one row.
 */
import * as os from 'os';
import * as path from 'path';
import { displayWidth, fitVisible } from './textwidth';
import { Glyphs, ColorDepth, churn, riskMark, tint } from './glyphs';
import { relTime, type SortKey } from '@oak-observatory/core';

/** The subset of a `changemap --json` file row this module needs. */
export interface MapFile {
  rel?: string;
  file?: string;
  added?: number;
  removed?: number;
  cnt?: number;
  pending?: number;
  kept?: number;
  undone?: number;
  risk?: number;
  maxTs?: number; // most-recent edit time — drives the "N min ago" column + the time sort
}

export interface MapNode {
  /** Path segment as displayed. */
  name: string;
  /** Full path from the root, '/'-joined — the stable identity for selection and folding. */
  path: string;
  depth: number;
  isFile: boolean;
  churn: number;
  /** Lines added and removed beneath this node, kept APART. `churn` is their sum and stays for the
   *  bar's magnitude, but a reviewer deciding whether to revert needs to know which way a file moved:
   *  +900 −4 and +4 −900 are the same churn and are not remotely the same change. */
  added: number;
  removed: number;
  files: number;
  edits: number;
  pending: number;
  kept: number;
  undone: number;
  risk: number;
  maxTs: number; // freshest edit time beneath this node (or the file's own) — the "N min ago" value
  children: MapNode[];
  /** The REAL absolute path, present on every anchored outside-workspace node (file and folder
   *  alike). Inside-workspace nodes have none — their `path` is workspace-relative and the
   *  consumer joins it to the root. This is what `e` (open in editor) and `--under` scoping use. */
  abs?: string;
}

const empty = (name: string, path: string, depth: number, isFile: boolean): MapNode => ({
  name, path, depth, isFile,
  churn: 0, added: 0, removed: 0, files: 0, edits: 0, pending: 0, kept: 0, undone: 0, risk: 0, maxTs: 0,
  children: [],
});

/** The bucket for outside-workspace files when the payload carries no root to resolve them with —
 *  an older CLI's payload. With a root, outside files get their REAL top-level anchors instead. */
export const OUTSIDE = '(outside the workspace)';

/**
 * Build the tree from a `changemap --json` `files[]` array.
 *
 * `root` is the workspace the payload's `rel` paths are relative to (summary.root). A file OUTSIDE
 * it used to collapse into one anonymous OUTSIDE row; it now groups under its REAL top-level anchor
 * — `~/.claude`, another repo's `~/Github`, `/etc` — displayed home-abbreviated with real names all
 * the way down, each anchor an ordinary folder node that is CLOSED by default. The anti-spam
 * property the old bucket bought (harness directories must not bury the user's code under thousands
 * of rows) now lives in the collapse, not in anonymity. Every outside node carries the full real
 * path in `abs`, which is what lets `e` open it and `--under` scope it.
 */
export function buildMapTree(files: readonly MapFile[], root?: string, sort: SortKey = 'time'): MapNode {
  let home = '';
  try {
    home = os.homedir();
  } catch {
    /* no home — the absolute-anchor branch still applies */
  }
  const tree = empty('', '', -1, false);
  /** Each node's children by `name\u0000inside-or-out` — the same identity the scan tested, at O(1).
   *  Inside and outside nodes never merge under one name (see below), so the flag is part of the key. */
  const index = new Map<MapNode, Map<string, MapNode>>();
  for (const f of files) {
    // `rel` is the workspace-relative path and is the ONLY path field to reason with: the payload's
    // `file` is the basename, so any startsWith(root) test against it is false for every row and
    // silently buckets the entire session as outside the workspace.
    const rel = String(f.rel ?? '');
    const outside = !rel || rel.startsWith('..');
    let segments: string[];
    /** Real absolute path per segment depth — set only on anchored outside nodes. */
    let absAt: string[] = [];
    if (!outside) {
      segments = rel.split(/[/\\]/).filter(Boolean);
    } else if (!root || !rel) {
      segments = [OUTSIDE]; // no root in the payload — the honest degraded form, never a guess
    } else {
      const abs = path.resolve(root, rel);
      const realParts = abs.split(/[/\\]/).filter(Boolean);
      const underHome = home && (abs === home || abs.startsWith(home + path.sep));
      if (underHome) {
        const below = abs.slice(home.length).split(/[/\\]/).filter(Boolean);
        segments = ['~', ...below];
      } else {
        const prefix = abs.startsWith('/') ? '/' : '';
        segments = [prefix + (realParts[0] ?? ''), ...realParts.slice(1)];
      }
      // Real paths per depth, derived by WALKING UP from the absolute path itself — string
      // concatenation got Windows drive anchors wrong ('C:' alone is drive-RELATIVE, not a
      // directory) and lost UNC roots entirely; dirname cannot.
      absAt = new Array(segments.length);
      let cursor = abs;
      for (let i = segments.length - 1; i >= 0; i--) {
        absAt[i] = cursor;
        cursor = path.dirname(cursor);
      }
    }
    if (!segments.length) continue;

    const add = (n: MapNode) => {
      n.churn += (f.added ?? 0) + (f.removed ?? 0);
      n.added += f.added ?? 0;
      n.removed += f.removed ?? 0;
      n.edits += f.cnt ?? 0;
      n.pending += f.pending ?? 0;
      n.kept += f.kept ?? 0;
      n.undone += f.undone ?? 0;
      n.risk += f.risk ?? 0;
      if ((f.maxTs ?? 0) > n.maxTs) n.maxTs = f.maxTs ?? 0;
    };
    add(tree);
    tree.files++;

    let cur = tree;
    segments.forEach((seg, i) => {
      const last = i === segments.length - 1;
      const p = segments.slice(0, i + 1).join('/');
      // Inside and outside nodes never merge, even under one name: a workspace directory literally
      // called `~` sharing a node with the home anchor would inherit `abs = $HOME` — and keep/undo
      // on the workspace-looking row would scope `--under` the reader's home directory.
      // A MAP, not a linear scan of the siblings. The scan was quadratic in how many files share a
      // directory, and it used to be harmless because every outside file collapsed into one bucket;
      // anchoring them at real paths (this release) gave them real siblings, and a single agent
      // scratchpad directory with a few thousand files in it took the map build from milliseconds to
      // over a second — once per second, because the row memo keys on the wall clock.
      const key = `${seg}\u0000${absAt.length > 0 ? '1' : '0'}`;
      const kids = index.get(cur) ?? new Map<string, MapNode>();
      if (!index.has(cur)) index.set(cur, kids);
      let next = kids.get(key);
      if (!next) {
        // Anchored outside leaves ARE files now (the old anonymous bucket was never one).
        next = empty(seg, p, i, last && (!outside || absAt.length > 0));
        cur.children.push(next);
        kids.set(key, next);
      }
      if (absAt.length) next.abs = absAt[i]; // the real path, at every depth of the anchor chain
      add(next);
      // A directory counts DISTINCT files beneath it; a file row counts itself once.
      next.files++;
      cur = next;
    });
  }
  sortTree(tree, sort);
  return tree;
}

function sortTree(n: MapNode, key: SortKey): void {
  // Four directions, matching core.compareBySort — but keyed off the node NAME (the map shows folder
  // names, not full paths), with maxTs breaking name ties so folders read the same across a re-sort.
  if (key === 'name') n.children.sort((a, b) => a.name.localeCompare(b.name));
  else if (key === 'name-desc') n.children.sort((a, b) => b.name.localeCompare(a.name));
  else if (key === 'time-asc') n.children.sort((a, b) => (a.maxTs || 0) - (b.maxTs || 0) || a.name.localeCompare(b.name));
  else n.children.sort((a, b) => (b.maxTs || 0) - (a.maxTs || 0) || a.name.localeCompare(b.name)); // 'time' (default)
  for (const c of n.children) sortTree(c, key);
}

/**
 * Collapse chains of single-child directories into one row (`packages/core/src` rather than three
 * rows), which is what `dust` does and what keeps the tree shallow enough to read. Capped, so a deeply
 * nested single chain cannot produce a label wider than the column.
 */
function collapsedLabel(n: MapNode, cap = 40): { label: string; node: MapNode } {
  let cur = n;
  let label = n.name;
  while (cur.children.length === 1 && !cur.children[0].isFile) {
    const next = cur.children[0];
    if (displayWidth(`${label}/${next.name}`) > cap) break;
    label = `${label}/${next.name}`;
    cur = next;
  }
  return { label, node: cur };
}

export interface MapRow {
  node: MapNode;
  label: string;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  /** This row's churn against the largest of its SIBLINGS, 0..1 — the bar's length. Normalised per
   *  level rather than globally, so descending into a small folder still shows its internal shape
   *  instead of a row of one-cell stubs. */
  share: number;
}

/**
 * Flatten to display rows, honouring which paths the reader has opened.
 *
 * A directory is shown expanded only if its path is in `open`; everything else contributes exactly one
 * row carrying its whole subtree's totals. That is what makes the residual visible rather than lost.
 */
export function mapRows(tree: MapNode, open: ReadonlySet<string>, max = 500): MapRow[] {
  const out: MapRow[] = [];
  const walk = (n: MapNode, depth: number) => {
    const top = Math.max(1, ...n.children.map((c) => c.churn));
    for (const child of n.children) {
      if (out.length >= max) return;
      const { label, node } = collapsedLabel(child);
      const expandable = node.children.length > 0;
      const expanded = expandable && open.has(node.path);
      out.push({ node, label, depth, expandable, expanded, share: child.churn / top });
      if (expanded) walk(node, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** A per-row action, and the exact cells it occupies. */
export interface MapAction {
  action: 'keep' | 'undo' | 'redo';
  label: string;
  /** Column offset WITHIN the row, so a caller adds its pane's own x. */
  x: number;
  w: number;
}

/**
 * What each column of a map row costs, and which of them this width can afford.
 *
 * Laid out ONCE, here, because the renderer draws from it and the mouse resolves clicks through it.
 * Recomputing the button cells at the click site is how an action ends up drawn in one place and
 * pressable in another — and this action reverts files on disk, so the cost of that drift is a
 * folder the reader never meant to touch.
 *
 * Columns drop WHOLE, cheapest first, and the name keeps whatever is left. Nothing is ever clipped:
 * a `+1.2k` cut to `+1.` is not a smaller number, it is a wrong one.
 */
export interface MapColumns {
  delta: number;
  review: number;
  count: number;
  actions: number;
  risk: number;
  name: number;
}

/**
 * The row buttons, in two sets — ICONS at both widths: ✓ keeps, ✗ undoes, ↺ redoes (a check mark
 * to accept, x to reject, the undo icon to redo) — the ✗ matches the `undone`
 * STATE glyph, and the curved arrow that used to mean undo now means "put it back". The wide set
 * keeps breathing room so the target stays generous; the narrow set drops the padding. The words
 * live in the footer keymap and in every confirmation — a mutation still ASKS in words before
 * acting, so an icon is never the last thing between a click and a revert. Brackets stay in both,
 * because a button that is only a background colour disappears at `--color none`.
 */
const ACT_WIDE = { keep: '[ ✓ ]', undo: '[ ✗ ]', redo: '[ ↺ ]' } as const;
const ACT_NARROW = { keep: '[✓]', undo: '[✗]', redo: '[↺]' } as const;
/**
 * Column widths, in the order they are given up.
 *
 * There is no bar. A proportional meter answers "which of these is biggest", which is what SORTING
 * already answers — the rows are churn-ranked — and it spent up to 27 columns doing it, next to
 * numbers that say the same thing exactly. The numbers stayed.
 */
const W_DELTA = 16; // 7 + space + 7 + space — 7 so the word `removed` fits over its column
const W_REVIEW = 11; // 5 + space + 4 + space
const W_COUNT = 6;
const W_ACT_WIDE = 1 + displayWidth(ACT_WIDE.keep) + 1 + displayWidth(ACT_WIDE.undo);
const W_ACT_NARROW = 1 + displayWidth(ACT_NARROW.keep) + displayWidth(ACT_NARROW.undo);
const W_RISK = 3;

export function mapColumns(cols: number, depth = 0): MapColumns {
  // indent + twig + the space before the name + the space AFTER it. Counting the trailing separator
  // is not optional book-keeping: one uncounted column puts EVERY row one over its pane, and the pane
  // then wraps each of them onto a continuation line that says nothing.
  const prefix = 2 * (depth + 1) + 3;
  // Ordered by what a reviewer gives up last: the name, then the actions that act on it, then how
  // much changed, then how much of it is still pending, then the counts, then risk.
  const tiers: Omit<MapColumns, 'name'>[] = [
    { delta: W_DELTA, review: W_REVIEW, count: W_COUNT, actions: W_ACT_WIDE, risk: W_RISK },
    { delta: W_DELTA, review: W_REVIEW, count: W_COUNT, actions: W_ACT_NARROW, risk: W_RISK },
    { delta: W_DELTA, review: W_REVIEW, count: 0, actions: W_ACT_NARROW, risk: W_RISK },
    { delta: W_DELTA, review: 0, count: 0, actions: W_ACT_NARROW, risk: 0 },
    { delta: 0, review: 0, count: 0, actions: W_ACT_NARROW, risk: 0 },
    { delta: 0, review: 0, count: 0, actions: 0, risk: 0 },
  ];
  const MIN_NAME = 10;
  for (const t of tiers) {
    const used = t.delta + t.review + t.count + t.actions + t.risk;
    if (prefix + MIN_NAME + used <= cols) return { ...t, name: cols - prefix - used };
  }
  const last = tiers[tiers.length - 1];
  return { ...last, name: Math.max(8, cols - prefix) };
}

/**
 * The column headings, aligned to the cells beneath them.
 *
 * Built from the SAME `mapColumns` the rows are, so a label can never sit over the wrong column.
 * Without it every number was a bare figure with a glyph stuck to it, and the reader had to infer
 * from context whether `1018?` was pending edits, files, or something else again.
 */
export function mapColumnHeader(cols: number, g: Glyphs, depth: ColorDepth = 'none'): string {
  const c = mapColumns(cols, 0);
  const prefix = 2 + 2; // one level of indent, twig, space — the shallowest row's own prefix
  // THE ICON LEGEND rides the header's empty name
  // cell, dim like the rest of the row — always in view above the buttons it explains, and dropped
  // whole when a narrow map cannot afford it (a clipped legend teaches the wrong glyph).
  const legend = '✓ keep · ✗ undo · ↺ redo · ⚑ resolve';
  const nameCell = displayWidth(legend) <= c.name ? pad(legend, c.name + 1) : pad('', c.name + 1);
  const head =
    ' '.repeat(prefix) +
    nameCell +
    (c.delta ? `${'added'.padStart(7)} ${'removed'.padStart(7)} ` : '') +
    (c.review ? `${'pend'.padStart(5)} ${'kept'.padStart(4)} ` : '') +
    (c.count ? 'files'.padStart(c.count) : '') +
    ' '.repeat(c.actions) +
    ' '.repeat(c.risk);
  return fitVisible(depth === 'none' ? head : `\x1b[2m${head}\x1b[0m`, cols);
}

/**
 * The buttons THIS row offers, where they sit — or `[]` when the width cannot afford them.
 *
 * A row offers only what it can actually do. The dead grey `✓` a resolved row used to carry was a
 * button that did nothing when pressed, and a reader who presses one of those stops trusting the
 * live ones too. Pending rows keep and undo; a row with nothing pending but something reverted
 * beneath it offers the one verb left, which is putting it back.
 */
export function mapRowActions(row: MapRow, cols: number): MapAction[] {
  const c = mapColumns(cols, row.depth);
  if (!c.actions) return [];
  const wide = c.actions >= W_ACT_WIDE;
  const set = wide ? ACT_WIDE : ACT_NARROW;
  const gap = wide ? 1 : 0;
  // `base` is the actions column; buttons start ONE cell in, so none sits flush against the count
  // beside it. Right-aligning against `x0` instead of `base` pushed the single-button case one cell
  // into the risk column, and the row then measured one wider than the pane and wrapped in half.
  const base = cols - c.risk - c.actions;
  const x0 = base + 1;
  const n = row.node;
  if (n.pending) {
    const kw = displayWidth(set.keep);
    return [
      { action: 'keep', label: set.keep, x: x0, w: kw },
      { action: 'undo', label: set.undo, x: x0 + kw + gap, w: displayWidth(set.undo) },
    ];
  }
  if (n.undone) {
    const w = displayWidth(set.redo);
    return [{ action: 'redo', label: set.redo, x: base + c.actions - w, w }];
  }
  return [];
}

/** The colour a live button wears. Kept beside the labels so the paint and the hit-test read as one
 *  thing — they are laid out by `mapRowActions` and only tinted here. */
const ACT_BG: Record<MapAction['action'], string> = {
  keep: '\x1b[48;2;28;70;36m',
  undo: '\x1b[48;2;86;30;30m',
  redo: '\x1b[48;2;38;50;78m',
};

/** Paint one row's buttons into exactly `c.actions` cells — blanks where the row offers nothing. */
function paintActions(row: MapRow, cols: number, depth: ColorDepth): string {
  const c = mapColumns(cols, row.depth);
  if (!c.actions) return '';
  const x0 = cols - c.risk - c.actions;
  let out = '';
  let at = 0;
  for (const a of mapRowActions(row, cols)) {
    const off = a.x - x0;
    if (off > at) out += ' '.repeat(off - at);
    out += depth === 'none' ? a.label : `${ACT_BG[a.action]}\x1b[97m${a.label}\x1b[0m`;
    at = off + a.w;
  }
  return out + ' '.repeat(Math.max(0, c.actions - at));
}

/** A session-wide button above the ledger, and the exact cells it occupies. */
export interface MapToolbarButton {
  action: 'keep-all' | 'undo-all' | 'resolve';
  label: string;
  x: number;
  w: number;
}

const TOOL_BG: Record<MapToolbarButton['action'], string> = {
  'keep-all': '\x1b[48;2;28;70;36m',
  'undo-all': '\x1b[48;2;86;30;30m',
  resolve: '\x1b[48;2;52;52;60m',
};

/**
 * The whole-session actions, laid out once for the renderer and the mouse.
 *
 * They carry their COUNT, because "keep all" over 4 edits and over 900 are different decisions and
 * the button is the last place the number can still change the answer. A button appears only when it
 * has something to act on: no pending edits means no Keep all to press.
 */
export function mapToolbar(tree: MapNode, cols: number, rich = true): MapToolbarButton[] {
  // ICONS, not words — the standard vocabulary: ✓ keeps, ✗ undoes (the reject
  // mark, matching the `undone` state glyph — a session blob's ✕ still means kill), ⚑ resolves. The
  // count rides inside the button, the words live in the footer keymap — and every mutation still
  // CONFIRMS in words before acting, so an icon can never be the last thing standing between a
  // click and a destructive verb.
  const wanted: { action: MapToolbarButton['action']; label: string }[] = [];
  if (tree.pending) {
    wanted.push({ action: 'keep-all', label: `[ ${rich ? '✓' : '+'} ${tree.pending} ]` });
    wanted.push({ action: 'undo-all', label: `[ ${rich ? '✗' : 'x'} ${tree.pending} ]` });
  }
  if (tree.pending || tree.kept || tree.undone) wanted.push({ action: 'resolve', label: `[ ${rich ? '⚑' : '*'} ]` });
  // They share the heading's row, RIGHT-aligned, and give way to it: the map is short in the default
  // layout, and a toolbar of its own spent a third of the ledger's rows on three words. What does not
  // fit is dropped from the end — the finishing verb first, because keeping and undoing are the ones
  // a reader reaches for — and a button is never drawn as a fragment of itself.
  const reserved = displayWidth(mapHeaderText(tree)) + 2;
  for (let n = wanted.length; n > 0; n--) {
    const set = wanted.slice(0, n);
    const total = set.reduce((s, b) => s + displayWidth(b.label), 0) + 2 * (n - 1);
    if (reserved + total > cols) continue;
    let x = cols - total;
    return set.map((b) => {
      const w = displayWidth(b.label);
      const at = x;
      x += w + 2;
      return { ...b, x: at, w };
    });
  }
  return [];
}

/** Draw the toolbar from `mapToolbar`'s own geometry — one layout, so a button cannot be drawn in
 *  one place and pressable in another. `sort`/`filter` are the standing sort mode and the active
 *  filter summary — the TUI's stand-in for the editors' labelled sort/filter buttons; they fill the
 *  gap between the heading and the right-aligned bulk buttons, so a readout never pushes a button off
 *  the row (buttons are actions and win; the readout gives way to whatever room is left). */
export function renderMapToolbar(tree: MapNode, cols: number, depth: ColorDepth, rich = true, sort?: SortKey, filter?: string): string {
  const base = mapHeaderText(tree);
  // The readout is the tail `mapHeaderText` appends for sort/filter — derived here so the pane header
  // and the full-screen one read identically. Button geometry still keys off the bare `base`, so the
  // buttons keep their places and the readout only uses the room left before them.
  const readout = mapHeaderText(tree, sort, filter).slice(base.length);
  const btns = mapToolbar(tree, cols, rich);
  if (!btns.length) return fitVisible(base + readout, cols);
  let line = base;
  let at = displayWidth(base);
  // Drop the readout into the gap before the first button, truncated to whatever fits there.
  if (readout && btns[0].x > at) {
    const shown = readout.slice(0, Math.max(0, btns[0].x - at));
    line += shown;
    at += displayWidth(shown);
  }
  for (const b of btns) {
    if (b.x > at) {
      line += ' '.repeat(b.x - at);
      at = b.x;
    }
    line += depth === 'none' ? b.label : `${TOOL_BG[b.action]}\x1b[97m${b.label}\x1b[0m`;
    at += b.w;
  }
  return fitVisible(line, cols);
}

/** One answer to the pending question, and the cells it occupies. */
export interface MapConfirmButton {
  answer: 'y' | 'n';
  label: string;
  x: number;
  w: number;
}

const ANS_YES = '[ y — yes ]';
const ANS_NO = '[ n — no ]';

/**
 * Where the two answers sit — right-aligned, so their position does not move with the length of the
 * question. A reader who clicked `[ Undo all ]` answers with the mouse they already have in hand;
 * `y`/`n` still work and the labels say so.
 *
 * Empty when the row is too narrow to hold them whole, and the line then falls back to naming the
 * keys in text — a half-drawn button is a button that lies about where it can be pressed.
 */
export function mapConfirmButtons(cols: number): MapConfirmButton[] {
  const wy = displayWidth(ANS_YES);
  const wn = displayWidth(ANS_NO);
  const total = wy + 1 + wn;
  if (cols < total + 12) return [];
  const x = cols - total - 1;
  return [
    { answer: 'y', label: ANS_YES, x, w: wy },
    { answer: 'n', label: ANS_NO, x: x + wy + 1, w: wn },
  ];
}

/**
 * The pending question, drawn in the map itself — on the TOOLBAR'S own row.
 *
 * A y/n on the bottom status row is a modal answered thirty rows away from the button that raised
 * it: the reader presses `[ Undo all ]`, sees nothing happen where they clicked, and presses it
 * again. Taking the toolbar's row puts the answer exactly where the question was asked, and keeps
 * the map's fixed rows at a constant height — a fourth decor line was clipped outright by a short
 * pane, which is the one place a confirmation must never go.
 */
export function mapConfirmLine(
  q: { verb: string; ids: number[]; label: string; count?: string },
  cols: number,
  depth: ColorDepth
): string {
  // The question is REPHRASED to fit, never cut: "undo — every pending edit in this" tells the
  // reader nothing about what they are agreeing to, and this repo's standing rule is that content
  // text is wrapped or shortened, never ellipsised. The short form keeps the verb and the count —
  // the two things that decide the answer.
  const long = `  ${q.verb}${q.ids.length ? ` ${q.ids.length} edit(s)` : ''} — ${q.label}?`;
  // The SHORT form keeps the two things that decide the answer: the verb and how many. The count
  // comes from the label when the caller put one there ('12 edit(s) under …'), so a narrow pane asks
  // 'keep 12?' rather than the useless 'keep?'.
  const n = q.count || (/^(\d+)/.exec(q.label)?.[1] ?? (q.ids.length ? String(q.ids.length) : ''));
  const short = `  ${q.verb}${n ? ` ${n}` : ''}?`;
  const btns = mapConfirmButtons(cols);
  if (!btns.length) {
    const text = `${long}  [y] yes  [n] no`;
    const fits = displayWidth(text) <= cols ? text : `${short}  [y/n]`;
    return fitVisible(depth === 'none' ? fits : tint(fits, 'pending', depth), cols);
  }
  const room = btns[0].x - 1;
  const marker = '\u25b6 '; // a solid arrow into the question — it is asking YOU, right here
  // The verb strings carry the ledger's own two-space indent; the marker replaces it here.
  const body = (displayWidth(marker + long) <= room ? long : short).replace(/^\s+/, '');
  const headText = marker + body;
  const lead = fitVisible(headText, room);
  if (depth === 'none') {
    let plainLine = lead + ' '.repeat(Math.max(0, btns[0].x - displayWidth(lead)));
    let at0 = btns[0].x;
    for (const b of btns) {
      if (b.x > at0) {
        plainLine += ' '.repeat(b.x - at0);
        at0 = b.x;
      }
      plainLine += b.label;
      at0 += b.w;
    }
    return fitVisible(plainLine, cols);
  }
  // The BAR: one background run across the whole row, so nothing on this line reads as ordinary
  // chrome. The answers sit on it in their own colours.
  const BAR = depth === 'truecolor' ? '\x1b[48;2;92;62;16m' : depth === '256' ? '\x1b[48;5;58m' : '\x1b[43m';
  const TEXT = depth === '16' ? '\x1b[30m' : '\x1b[97m';
  let line = `${BAR}${TEXT}${lead}`;
  let at = displayWidth(lead);
  for (const b of btns) {
    if (b.x > at) {
      line += ' '.repeat(b.x - at);
      at = b.x;
    }
    const on = b.answer === 'y' ? '\x1b[48;2;28;70;36m' : '\x1b[48;2;120;40;40m';
    line += `${depth === '16' ? (b.answer === 'y' ? '\x1b[42m' : '\x1b[41m') : on}\x1b[97m${b.label}${BAR}${TEXT}`;
    at += b.w;
  }
  line += ' '.repeat(Math.max(0, cols - at));
  return fitVisible(`${line}\x1b[0m`, cols);
}

/**
 * Render one row.
 *
 * Columns are laid out from the RIGHT — risk, actions, count, meter, review, delta — and the name
 * absorbs whatever is left. That is what lets the same renderer serve 60 and 200 columns without a
 * separate narrow layout, and it is why nothing here ellipsises: the name column is sized to fit,
 * not the name clipped to the column.
 */
export function renderMapRow(row: MapRow, cols: number, g: Glyphs, depth: ColorDepth, now = 0): string[] {
  const n = row.node;
  const c = mapColumns(cols, row.depth);
  // "N min ago", dim, to the LEFT of the name. Width-neutral: it steals from the name column, so every
  // right-aligned column (and the action hit-test that keys off them) keeps its absolute position. Hidden
  // when the name would fall below its floor, so a narrow pane keeps the path readable.
  const TW = 12; // widest relTime ("Aug 31 14:32"); short values right-pad to align the column
  // Only when the path keeps a comfortable width after the column — so a narrow split pane (the
  // Traces·Diff map) drops the age and stays readable, while the wide observatory map face shows it.
  const showTime = now > 0 && n.maxTs > 0 && c.name - (TW + 1) >= 18;
  const nameW = showTime ? c.name - (TW + 1) : c.name;
  const timeCell = showTime ? `${tint(relTime(n.maxTs, now).padStart(TW), 'undone', depth)} ` : '';
  const riskCol = c.risk ? riskMark(0, n.risk).padStart(c.risk) : '';
  const countCol = c.count ? `${n.isFile ? n.edits : n.files}${n.isFile ? 'e' : 'f'}`.padStart(c.count) : '';
  // Added and removed, apart. `churn` is still what sizes the bar; it is not what a reviewer reads.
  const deltaCol = c.delta
    ? `${tint(`+${churn(n.added)}`.padStart(7), 'kept', depth)} ${tint(`−${churn(n.removed)}`.padStart(7), 'risk', depth)} `
    : '';
  // Pending and accepted as NUMBERS, not only as a bar fill: "how much is left to review here" is
  // the question this map exists to answer, and a proportion cannot answer it.
  // The SAME glyphs the edit list marks a row with, not the meter's fill characters: `966#` beside a
  // `#`-filled bar reads as part of the bar, and the reader has to consult a legend to learn it is a
  // count. `?` and `✓` already mean pending and kept everywhere else on screen.
  const reviewCol = c.review
    ? `${tint(`${n.pending}${g.pending}`.padStart(5), 'pending', depth)} ${tint(`${n.kept}${g.kept}`.padStart(4), 'kept', depth)} `
    : '';
  const twig = row.expandable ? (row.expanded ? g.open : g.closed) : n.isFile ? ' ' : g.fold;
  const indent = '  '.repeat(row.depth + 1);
  // The name is CONTENT, so it is never cut. When it does not fit, the row keeps its first part and
  // the caller draws the rest on continuation lines — a folder called `dash-review-findings.md`
  // clipped to `dash-review-fin` is a name the reader cannot match against anything.
  const parts = displayWidth(row.label) <= nameW ? [row.label] : hardWrapName(row.label, nameW);
  const name = pad(parts[0], nameW);
  const risk = c.risk ? (n.risk > 0 ? tint(riskCol, 'risk', depth) : riskCol) : '';
  const acts = paintActions(row, cols, depth);
  const first = `${indent}${twig} ${timeCell}${name} ${deltaCol}${reviewCol}${countCol}${acts}${risk}`;
  if (parts.length === 1) return [first];
  // Continuations reclaim the width the numbers occupied: there is nothing to align them with.
  const contIndent = `${indent}  ${showTime ? ' '.repeat(TW + 1) : ''}${g.wrap}`;
  return [first, ...parts.slice(1).map((t) => fitVisible(`${contIndent}${t}`, cols))];
}

/** Break a name at exactly `w` columns, keeping every character. Paths have no spaces to break on. */
function hardWrapName(s: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of s) {
    if (displayWidth(line + ch) > w) { out.push(line); line = ''; }
    line += ch;
  }
  out.push(line);
  return out;
}

function pad(s: string, w: number): string {
  const gap = w - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/**
 * The summary line above the ledger.
 *
 * It no longer says "churn", and it no longer explains a meter's fills, because there is no meter.
 * Every row states its own `added`/`removed`/`pend`/`kept` under a heading that names each one — a
 * legend exists to decode a symbol, and a number under its own label needs no decoding.
 */
// Compact per-key label for the narrow header (the options window spells them out in full).
const SORT_SHORT: Record<SortKey, string> = { time: 'newest', 'time-asc': 'oldest', name: 'A→Z', 'name-desc': 'Z→A' };

export function mapHeaderText(tree: MapNode, sort?: SortKey, filter?: string): string {
  // The header carries the standing sort mode and any active filter — the TUI's answer to the
  // editors' sort/filter buttons showing their own state, since here they are keys (`s` and `\`).
  const bits = [`  CHANGE MAP  ${tree.files} file${tree.files === 1 ? '' : 's'} · ${tree.edits} edit${tree.edits === 1 ? '' : 's'}`];
  if (sort) bits.push(`sort: ${SORT_SHORT[sort] ?? sort}`);
  if (filter) bits.push(`filter: ${filter}`);
  return bits.join(' · ');
}

export function mapHeader(tree: MapNode, cols: number, g: Glyphs, sort?: SortKey, filter?: string): string {
  void g;
  return fitVisible(mapHeaderText(tree, sort, filter), cols);
}
