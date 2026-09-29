/**
 * The BSP layout engine — per-tab pane arrangements the fixed-dock `resolveLayout` cannot express.
 *
 * WHY A SECOND ENGINE, AND WHY IT DOES NOT REPLACE THE FIRST (2026-08-16). `resolveLayout` is ~250
 * lines of DOCK POLICY (carve order, forced-minimize ladder by `yield`, flex-centre width sharing,
 * `blocked` reporting, seam target/sign). It is correct, tested, and it is what the review surface
 * renders through. Reproducing it byte-for-byte inside a tree is the swamp a prior attempt drowned in.
 *
 * So the tree is OPTIONAL, per tab. A tab with no `root` resolves through `resolveLayout` exactly as
 * before — review and agent keep their pixels, every snapshot passes. A tab WITH a `root` (observatory's
 * four panes, a reader-created split, a native-CLI tab) resolves here. Splitting a dock tab first
 * MATERIALISES its current arrangement into a `root`, then splits that — so the capability is whole
 * without moving the surface that already works.
 *
 * DIRECTION. `dir` names the ARRANGEMENT, not the divider:
 *   - `'h'` — children in a horizontal ROW, side by side, dividing WIDTH (a vertical rule between them;
 *             the `|` key makes one).
 *   - `'v'` — children in a vertical COLUMN, stacked, dividing HEIGHT (a horizontal rule between them;
 *             the `-` key makes one).
 * `ratio` is the FIRST child's share of the usable extent (after the one-cell seam), in (0,1).
 */

import type { Rect } from './layout';

/** A view is the CONTENT a pane holds — decoupled from pane IDENTITY, which is dynamic in a tree.
 *  `resolveLayout`'s six fixed panes conflated the two; here `edits` (the list) can appear in any
 *  pane, and two panes can hold two different views of one session. */
export type ViewId =
  | 'workers'
  // A minimal herdr-style sidebar: a compact list of the active agents and their
  // status, beside the full Workers board.
  | 'agents-mini'
  // The observatory's master/detail pair: `sessions-nav` is the left master — each
  // machine's sessions grouped by workspace, two lines each (status + title, then its metrics);
  // `session-detail` is the right detail — a pinned session's conversation, its Workers and Tasks.
  | 'sessions-nav'
  | 'session-detail'
  | 'tasks'
  | 'workflows'
  | 'processes'
  | 'feed'
  | 'observations'
  | 'actions'
  | 'prompts'
  | 'edits'
  | 'map'
  | 'diff'
  | 'agent';

export type PaneNode =
  | { kind: 'pane'; id: string; view: ViewId }
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number; first: PaneNode; second: PaneNode };

/** A pane's honest floor and its title. `minRows`/`minCols` mirror the fixed panes' `min` so a view
 *  that used to be a dock keeps the same smallest-usable size when it becomes a free pane. */
export interface ViewSpec {
  title: string;
  minRows: number;
  minCols: number;
  /** Draws an action bar under the title — the geometry must know, exactly as `PaneSpec.nav` does. */
  nav?: boolean;
}

export const VIEW: Record<ViewId, ViewSpec> = {
  workers: { title: 'Workers', minRows: 3, minCols: 24 },
  'agents-mini': { title: 'Agents', minRows: 3, minCols: 14 },
  'sessions-nav': { title: 'Sessions', minRows: 3, minCols: 22 },
  'session-detail': { title: 'Session', minRows: 4, minCols: 34 },
  tasks: { title: 'Tasks', minRows: 3, minCols: 20 },
  workflows: { title: 'Workflows', minRows: 3, minCols: 20 },
  processes: { title: 'Processes', minRows: 2, minCols: 20 },
  feed: { title: 'Feed', minRows: 3, minCols: 24 },
  observations: { title: 'Observations', minRows: 3, minCols: 24 },
  actions: { title: 'Actions', minRows: 3, minCols: 24 },
  prompts: { title: 'Prompts', minRows: 3, minCols: 24 },
  edits: { title: 'Traces', minRows: 3, minCols: 30 },
  map: { title: 'Map', minRows: 4, minCols: 36 },
  diff: { title: 'Diff', minRows: 5, minCols: 36, nav: true },
  agent: { title: 'Agent', minRows: 4, minCols: 30 },
};

/** A leaf, and the rectangle the carve gave it. */
export interface Placement {
  id: string;
  view: ViewId;
  rect: Rect;
  focused: boolean;
}

/** A draggable divider — one per surviving split. It carries its OWN bounds, so a tree seam hit-tests
 *  generically: a point is on the seam iff it lies in [x0,x1) × [y0,y1). (The dock engine's vertical
 *  seams instead assume the global band — the assumption a tree breaks the moment two splits stack.)
 *
 *  `axis` is the divider's orientation and the dimension a drag adjusts: `'v'` a vertical rule (from a
 *  side-by-side `'h'` split — drag left/right); `'h'` a horizontal rule (from a stacked `'v'` split —
 *  drag up/down). `path` is the route from the root to the split this resizes — 0 = first child, 1 =
 *  second — so a drag walks to that node and moves its `ratio`. */
export interface TreeSeam {
  axis: 'h' | 'v';
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  path: readonly number[];
  /** The split's whole rectangle — what a drag needs to turn a pointer position into a ratio: for a
   *  vertical divider, `(col - region.x) / (region.w - 1)`; for a horizontal one, the same in y. */
  region: Rect;
}

/** What a tree resolves to: one box per surviving leaf, one seam per surviving split, and a note for
 *  every pane a too-small region forced folded — never a silent disappearance. */
export interface TreeLayout {
  placements: Placement[];
  seams: TreeSeam[];
  notes: string[];
}

/** The smallest this subtree can be along one axis: SUM plus a seam along the split axis, MAX across
 *  it. Used to floor a split so neither child is crushed below what it can render. */
const NO_EMPTY: ReadonlySet<string> = new Set();

export function minExtent(node: PaneNode, axis: 'rows' | 'cols', empty: ReadonlySet<string> = NO_EMPTY): number {
  if (node.kind === 'pane') {
    // A collapsed (empty) pane is a 1-row title strip, so it must NOT drag the split's row-minimum up
    // to what a FULL pane would need — that mismatch is exactly what folded the second strip away.
    if (axis === 'rows' && empty.has(node.id)) return 1;
    return axis === 'rows' ? VIEW[node.view].minRows : VIEW[node.view].minCols;
  }
  const a = minExtent(node.first, axis, empty);
  const b = minExtent(node.second, axis, empty);
  // 'v' divides rows, 'h' divides cols. Along the split axis the children sit end to end with a seam;
  // across it they overlap and the tighter floor wins.
  const splitsThisAxis = (node.dir === 'v') === (axis === 'rows');
  return splitsThisAxis ? a + b + 1 : Math.max(a, b);
}

/** The first child's extent along the split axis: its ratio share, floored so BOTH children keep their
 *  minimum, and never past the usable extent. Returns the integer size of the FIRST child. */
function firstExtent(node: Extract<PaneNode, { kind: 'split' }>, total: number, empty: ReadonlySet<string> = NO_EMPTY): number {
  const axis = node.dir === 'v' ? 'rows' : 'cols';
  const avail = total - 1; // one cell for the seam between the two children
  if (avail <= 0) return 0;
  const minA = minExtent(node.first, axis, empty);
  const minB = minExtent(node.second, axis, empty);
  let a = Math.round(avail * node.ratio);
  // Honour both floors when they fit; when they cannot (the region is under the subtree's minimum),
  // keep the split proportional but clamped in-bounds rather than emitting a negative extent. Genuine
  // too-small handling (fold a pane) is a later milestone; this only guarantees valid rectangles.
  if (minA + minB <= avail) a = Math.max(minA, Math.min(a, avail - minB));
  else a = Math.max(0, Math.min(a, avail));
  return a;
}

/** Every leaf under a subtree is empty (no rows) — so the whole subtree can auto-collapse. */
function allLeavesEmpty(node: PaneNode, empty: ReadonlySet<string>): boolean {
  return node.kind === 'pane' ? empty.has(node.id) : allLeavesEmpty(node.first, empty) && allLeavesEmpty(node.second, empty);
}

/** Rows to show a subtree fully COLLAPSED — one title strip per leaf, plus the seams between stacked
 *  strips. A collapsed pane keeps only its labeled title row; its body auto-hides. */
function collapsedRows(node: PaneNode): number {
  if (node.kind === 'pane') return 1;
  return node.dir === 'v' ? collapsedRows(node.first) + collapsedRows(node.second) + 1 : Math.max(collapsedRows(node.first), collapsedRows(node.second));
}

/** Does the focused leaf live in this subtree? A fold keeps the side the reader is in, mirroring the
 *  dock engine's "the focused pane is never the victim". */
function holdsFocus(node: PaneNode, focus?: string): boolean {
  if (!focus) return false;
  if (node.kind === 'pane') return node.id === focus;
  return holdsFocus(node.first, focus) || holdsFocus(node.second, focus);
}

/** The views under a subtree, in order — for the fold note, and for the runtime's fetch list (a tree
 *  tab must ask the backend for exactly the views its leaves render). */
export function leafViews(node: PaneNode): ViewId[] {
  return node.kind === 'pane' ? [node.view] : [...leafViews(node.first), ...leafViews(node.second)];
}

/** Every leaf as (id, view), in order — so a caller can ask "which panes are empty?" and hand the set
 *  of ids back to `resolveTree` for auto-hide. */
export function leafPanes(node: PaneNode): { id: string; view: ViewId }[] {
  return node.kind === 'pane' ? [{ id: node.id, view: node.view }] : [...leafPanes(node.first), ...leafPanes(node.second)];
}

/**
 * Resolve a tree within a rectangle: a box per leaf, a seam per split, and a note per forced fold.
 *
 * Rectangles are disjoint and lie within `rect`; the one-cell seam between two children belongs to
 * neither. When a region is under a split's minimum, the split cannot show both children honestly, so
 * it FOLDS one — the side without focus — gives the whole region to the other, and says which panes it
 * hid. Nothing disappears in silence, which is the failure this product refuses everywhere else.
 */
export function resolveTree(node: PaneNode, rect: Rect, focus?: string, path: readonly number[] = [], empty: ReadonlySet<string> = NO_EMPTY): TreeLayout {
  if (node.kind === 'pane') {
    const notes: string[] = [];
    if (rect.h < VIEW[node.view].minRows || rect.w < VIEW[node.view].minCols) {
      notes.push(`${VIEW[node.view].title} is under its minimum size; its rows wrap`);
    }
    return { placements: [{ id: node.id, view: node.view, rect, focused: node.id === focus }], seams: [], notes };
  }
  const axis = node.dir === 'v' ? 'rows' : 'cols';
  const total = node.dir === 'v' ? rect.h : rect.w;
  if (total < minExtent(node, axis, empty)) {
    // The split cannot hold both children. Fold the side the reader is NOT in; with focus in neither,
    // keep the first. The folded subtree is named, never dropped silently.
    const keepSecond = holdsFocus(node.second, focus) && !holdsFocus(node.first, focus);
    const kept = keepSecond ? node.second : node.first;
    const dropped = keepSecond ? node.first : node.second;
    const sub = resolveTree(kept, rect, focus, [...path, keepSecond ? 1 : 0], empty);
    sub.notes.unshift(
      `${leafViews(dropped).map((v) => VIEW[v].title).join(', ')} folded: the split needs ${minExtent(node, axis, empty)} ${axis}, this region has ${total}`
    );
    return sub; // a folded split has no divider to drag
  }
  if (node.dir === 'v') {
    // AUTO-HIDE: when exactly one side is entirely empty, it collapses to its title strip(s) and the
    // other side takes the rest (floored at its minimum). Both-or-neither empty keeps the ratio, so
    // a populated split is byte-identical to before auto-hide existed.
    const fE = allLeavesEmpty(node.first, empty), sE = allLeavesEmpty(node.second, empty);
    const avail = rect.h - 1;
    let hA: number;
    if (fE === sE || avail <= 0) hA = firstExtent(node, rect.h, empty);
    else if (fE) hA = Math.max(1, Math.min(collapsedRows(node.first), avail - minExtent(node.second, 'rows', empty)));
    else hA = Math.min(avail, Math.max(minExtent(node.first, 'rows', empty), avail - collapsedRows(node.second)));
    const a = resolveTree(node.first, { x: rect.x, y: rect.y, w: rect.w, h: hA }, focus, [...path, 0], empty);
    const b = resolveTree(node.second, { x: rect.x, y: rect.y + hA + 1, w: rect.w, h: rect.h - 1 - hA }, focus, [...path, 1], empty);
    const sy = rect.y + hA;
    const seam: TreeSeam = { axis: 'h', x0: rect.x, x1: rect.x + rect.w, y0: sy, y1: sy + 1, path, region: rect };
    return { placements: [...a.placements, ...b.placements], seams: [seam, ...a.seams, ...b.seams], notes: [...a.notes, ...b.notes] };
  }
  const wA = firstExtent(node, rect.w, empty);
  const a = resolveTree(node.first, { x: rect.x, y: rect.y, w: wA, h: rect.h }, focus, [...path, 0], empty);
  const b = resolveTree(node.second, { x: rect.x + wA + 1, y: rect.y, w: rect.w - 1 - wA, h: rect.h }, focus, [...path, 1], empty);
  const sx = rect.x + wA;
  const seam: TreeSeam = { axis: 'v', x0: sx, x1: sx + 1, y0: rect.y, y1: rect.y + rect.h, path, region: rect };
  return { placements: [...a.placements, ...b.placements], seams: [seam, ...a.seams, ...b.seams], notes: [...a.notes, ...b.notes] };
}

/**
 * The leaf boxes alone — the tiling surface, kept so callers that only want placements (and the M1
 * test) need not thread seams and notes through.
 */
export function carve(node: PaneNode, rect: Rect, focus?: string): Placement[] {
  return resolveTree(node, rect, focus).placements;
}

/** Resolve a tree, applying ZOOM: when `zoom` names a pane, that pane fills the whole rect and the rest
 *  fold away (no seams). Both the renderer AND the hit-test call this, so "a click and a glyph never
 *  disagree" is a structural property of one function — not two hand-synced copies at two altitudes. */
export function resolveZoomedTree(node: PaneNode, rect: Rect, focus?: string, zoom?: string | null, empty: ReadonlySet<string> = NO_EMPTY): TreeLayout {
  const full = resolveTree(node, rect, focus, [], empty);
  if (!zoom) return full;
  const zp = full.placements.find((p) => p.id === zoom);
  return zp ? { ...full, placements: [{ ...zp, rect, focused: true }], seams: [] } : full;
}

/** What is under the cursor in a tree body — the tree's analogue of `hitTest`, but generic: a seam is
 *  hit by its OWN bounds (not the dock engine's global band), and a pane is named by its dynamic id.
 *  `row`/`col` are body-relative to the pane (title row excluded), so a click resolves to a producer
 *  row exactly as `hitTest`'s `t:'body'` does. Coordinates are in the tree region's own space — the
 *  caller subtracts the tab bar / chrome offset first. */
export type TreeHit =
  | { kind: 'seam'; path: readonly number[]; axis: 'h' | 'v' }
  | { kind: 'pane'; id: string; view: ViewId; titleRow: boolean; row: number; col: number }
  | null;

export function hitTreeBody(layout: TreeLayout, col: number, row: number): TreeHit {
  // Seams first: they occupy the one-cell gaps no placement covers. A single-column divider is too thin
  // to grab reliably — the reported "dragging to resize does nothing" — so the grab band is widened one
  // cell each side ALONG the seam's thin axis (a `v` seam grabs the columns flanking the gap, an `h` seam
  // the rows). Testing seams before panes means that band claims the neighbour's border cell, which reads
  // as part of the divider anyway; the long axis stays exact.
  for (const s of layout.seams) {
    const hit = s.axis === 'v'
      ? col >= s.x0 - 1 && col < s.x1 + 1 && row >= s.y0 && row < s.y1
      : row >= s.y0 - 1 && row < s.y1 + 1 && col >= s.x0 && col < s.x1;
    if (hit) return { kind: 'seam', path: s.path, axis: s.axis };
  }
  for (const p of layout.placements) {
    const r = p.rect;
    if (col < r.x || col >= r.x + r.w || row < r.y || row >= r.y + r.h) continue;
    return { kind: 'pane', id: p.id, view: p.view, titleRow: row === r.y, row: row - r.y - 1, col: col - r.x };
  }
  return null;
}

/** Walk a seam's `path` to the split it resizes and return a NEW tree with that split's `ratio` set —
 *  the tree's analogue of writing `state.panes.sizes[target]`. Pure: the caller swaps `tab.root`. The
 *  ratio is clamped to a sane band so a drag can never collapse a child to nothing. */
export function setRatioAt(root: PaneNode, path: readonly number[], ratio: number): PaneNode {
  const clamped = Math.max(0.05, Math.min(0.95, ratio));
  if (path.length === 0) {
    if (root.kind !== 'split') return root; // a path that no longer lands on a split is ignored, not crashed
    return { ...root, ratio: clamped };
  }
  if (root.kind !== 'split') return root;
  const [head, ...rest] = path;
  return head === 0
    ? { ...root, first: setRatioAt(root.first, rest, ratio) }
    : { ...root, second: setRatioAt(root.second, rest, ratio) };
}

/** Split the pane `targetId` in two: it keeps its view, a NEW pane (`newId`, `newView`) takes the
 *  other half. `dir:'h'` puts them side by side, `'v'` stacks them. Pure — the caller swaps `tab.root`. */
export function splitPane(node: PaneNode, targetId: string, dir: 'h' | 'v', newId: string, newView: ViewId): PaneNode {
  if (node.kind === 'pane') {
    if (node.id !== targetId) return node;
    return { kind: 'split', dir, ratio: 0.5, first: node, second: { kind: 'pane', id: newId, view: newView } };
  }
  return {
    ...node,
    first: splitPane(node.first, targetId, dir, newId, newView),
    second: splitPane(node.second, targetId, dir, newId, newView),
  };
}

/** Close the pane `targetId`: its parent split collapses to the sibling. A lone-pane root cannot be
 *  closed (returns unchanged — the caller checks `paneCount` first). Pure. */
export function closePane(node: PaneNode, targetId: string): PaneNode {
  if (node.kind === 'pane') return node;
  if (node.first.kind === 'pane' && node.first.id === targetId) return node.second;
  if (node.second.kind === 'pane' && node.second.id === targetId) return node.first;
  return { ...node, first: closePane(node.first, targetId), second: closePane(node.second, targetId) };
}

function findPane(node: PaneNode, id: string): Extract<PaneNode, { kind: 'pane' }> | null {
  if (node.kind === 'pane') return node.id === id ? node : null;
  return findPane(node.first, id) ?? findPane(node.second, id);
}

function mapLeaves(node: PaneNode, f: (leaf: Extract<PaneNode, { kind: 'pane' }>) => PaneNode): PaneNode {
  if (node.kind === 'pane') return f(node);
  return { ...node, first: mapLeaves(node.first, f), second: mapLeaves(node.second, f) };
}

/** Swap two leaves' PLACES — each keeps its id and view, only the positions trade. The drop-on-centre
 *  gesture and the keyboard move. Pure; a no-op unless both exist. */
export function swapPanes(node: PaneNode, a: string, b: string): PaneNode {
  if (a === b) return node;
  const pa = findPane(node, a);
  const pb = findPane(node, b);
  if (!pa || !pb) return node;
  return mapLeaves(node, (leaf) => (leaf.id === a ? pb : leaf.id === b ? pa : leaf));
}

/** Move leaf `id` to sit beside `targetId` on `side`: it leaves where it was (its old sibling absorbs
 *  the space, exactly as a close would) and the target splits to make room — left/right side by side,
 *  top/bottom stacked. The drop-on-edge gesture. Pure; a no-op when either pane is missing, they are
 *  the same, or the tree has nothing else to absorb the space. */
export function movePane(node: PaneNode, id: string, targetId: string, side: 'left' | 'right' | 'top' | 'bottom'): PaneNode {
  if (id === targetId) return node;
  const leaf = findPane(node, id);
  if (!leaf || !findPane(node, targetId) || paneCount(node) < 2) return node;
  const without = closePane(node, id);
  const dir: 'h' | 'v' = side === 'left' || side === 'right' ? 'h' : 'v';
  const leads = side === 'left' || side === 'top';
  return mapLeaves(without, (l) => (l.id === targetId ? { kind: 'split', dir, ratio: 0.5, first: leads ? leaf : l, second: leads ? l : leaf } : l));
}

/** Change what one pane shows, in place — the view picker's write. Pure. */
export function setPaneView(node: PaneNode, id: string, view: ViewId): PaneNode {
  return mapLeaves(node, (l) => (l.id === id ? { ...l, view } : l));
}

/** How many leaves the tree has — the caller refuses to close the last one. */
export function paneCount(node: PaneNode): number {
  return node.kind === 'pane' ? 1 : paneCount(node.first) + paneCount(node.second);
}

/** The first leaf's id, in tree order — where focus lands after a close removes the focused pane. */
export function firstLeafId(node: PaneNode): string {
  return node.kind === 'pane' ? node.id : firstLeafId(node.first);
}

/** Every pane id in the tree, in order — for callers that want the raw set (e.g. restore validation),
 *  where `firstLeafId`/`leafViews` deliberately collect only part. */
export function leafIds(node: PaneNode): string[] {
  return node.kind === 'pane' ? [node.id] : [...leafIds(node.first), ...leafIds(node.second)];
}

/** Validate an UNTRUSTED tree (from persisted prefs) and rebuild it CLEAN — dropping unknown fields,
 *  refusing an unknown view, a ratio outside (0,1), a malformed split. Returns null on any fault, so
 *  the caller falls back to the default rather than to a blank or broken frame — the persistence rule.
 *  Also enforces that every pane id is UNIQUE (a duplicate would make focus/scroll/hit ambiguous). */
export function parseTree(node: unknown): PaneNode | null {
  try {
    const t = build(node);
    if (!t) return null;
    const ids = new Set<string>();
    const unique = (n: PaneNode): boolean =>
      n.kind === 'pane' ? (ids.has(n.id) ? false : (ids.add(n.id), true)) : unique(n.first) && unique(n.second);
    return unique(t) ? t : null;
  } catch {
    return null; // deep recursion (RangeError) or anything else — the contract is null on ANY fault
  }
}

const KNOWN_VIEWS = new Set<string>(Object.keys(VIEW));
function build(node: unknown): PaneNode | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (n.kind === 'pane') {
    if (typeof n.id !== 'string' || typeof n.view !== 'string' || !KNOWN_VIEWS.has(n.view)) return null;
    return { kind: 'pane', id: n.id, view: n.view as ViewId };
  }
  if (n.kind === 'split') {
    if ((n.dir !== 'h' && n.dir !== 'v') || typeof n.ratio !== 'number' || !(n.ratio > 0 && n.ratio < 1)) return null;
    const first = build(n.first);
    const second = build(n.second);
    return first && second ? { kind: 'split', dir: n.dir, ratio: n.ratio, first, second } : null;
  }
  return null;
}

/** Machine / pane / session master, beside independently pinned conversation leaves. */
export const OBSERVATORY_TREE: PaneNode = {
  kind: 'split',
  dir: 'h',
  ratio: 0.30,
  first: { kind: 'pane', id: 'obs-sessions', view: 'sessions-nav' },
  second: { kind: 'pane', id: 'obs-detail', view: 'session-detail' },
};
