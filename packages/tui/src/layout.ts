/**
 * Where the windows go.
 *
 * The terminal mirrors the editors: **Prompts** on top, **Traces** left, **Dashboards** along the
 * bottom, docked around a centre. In an editor that centre is the code, because the code is the
 * object under review. A terminal has no buffer, but it has the same object in the only form review
 * needs — the before-and-after — so the centre is **Detail**: the selected edit's diff, or the
 * session's change map when nothing is selected.
 *
 * There is no right-hand sidebar. Observations and Actions used to live there as two stacked
 * sections; they are Dashboards tabs now. A third column cost Detail 30 columns of diff on every
 * terminal narrower than 98, which is most of them, to show two lists that are read after the diff
 * rather than beside it.
 *
 * Everything here is a pure function of `(cols, rows, minimized, zoom, focus, tab)`. No terminal, no
 * clock, no filesystem. That is what lets a 60-column degradation be asserted line by line in a unit
 * test instead of being discovered by a reader whose window was too small.
 *
 * Three rules earned their place by measurement rather than taste:
 *
 * **Zoom folds into minimize.** `zoom: X` means "every other pane is minimized". One code path serves
 * zoom, hand-minimize, and forced degradation, so all three are tested at once and zoom works for all
 * four panes rather than the two a centre-special-case would have covered.
 *
 * **The latch.** Shrinking the terminal may force a pane closed; growing it never re-opens one. This
 * is `ColumnLayout.dividerProportion`'s rule, already shipped and tested in both JetBrains surfaces,
 * ported here. Without it, growing an 80-column window from 27 to 28 rows *shrinks* Traces from 20
 * rows to 14 — the panel lurches while the reader is dragging the edge. The runtime owns `minimized`
 * and folds `forced` into it; only the reader takes a pane back out.
 *
 * **Refusal is loud.** A pane that will not fit lands in `blocked` with the number it would take, and
 * that reaches the status row. A layout that silently drops a window is a silent failure, and this
 * product does not have those.
 */

import { displayWidth } from './textwidth';

export type PaneId = 'claude' | 'prompts' | 'traces' | 'map' | 'detail' | 'dashboards';
export type Dock = 'top' | 'left' | 'centre' | 'bottom';
/** `wide` is both columns; `stack` is one; `dock-only` is neither, leaving Prompts and Dashboards. */
export type LayoutMode = 'wide' | 'stack' | 'dock-only';

export interface PaneSpec {
  id: PaneId;
  /**
   * The function key that reaches this pane — see `BAR_ENTRIES`, the authority. Pressing a pane's
   * key when it is already showing zooms it, and again puts it back — except the Agent pane, whose
   * second press opens the Agent screen (see BAR_ENTRIES).
   *
   * The digits are not available for this — they name EDITS, and an edit id is the thing a reviewer
   * says out loud ("undo 122"), so it outranks a window shortcut for the shorter key.
   */
  n: number;
  title: string;
  dock: Dock;
  /** Preferred extent along the dock's axis: COLUMNS for left/centre/right, ROWS for bottom. */
  want: number;
  /** Below this the pane cannot render honestly and is minimized instead. Same unit as `want`. */
  min: number;
  /** Who gives way first when space runs out. Lowest yields first; the focused pane is last. */
  yield: number;
  /**
   * This pane draws an action bar directly under its title, and the geometry has to KNOW that.
   * Detail's navbar used to be pushed in by the renderer alone, so `hitTest` called that row body:
   * every button was drawn where nothing was clickable, each body click landed one row off, and the
   * pane composed one line taller than its box, which the compositor dropped off the bottom.
   */
  nav?: boolean;
  /** The internal tab strip, mirroring the editors' views. */
  tabs: readonly string[];
  /** Which tab opens first, when the reader has not chosen one. Index into `tabs`; 0 if absent. */
  defaultTab?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TabSpan {
  index: number;
  label: string;
  x: number;
  w: number;
  selected: boolean;
}

export interface PaneBox {
  id: PaneId;
  focused: boolean;
  selTab: number;
  /** The whole box: title row, tab row, body. */
  rect: Rect;
  titleRow: number;
  /** The action-bar row, or -1. Renderer and hit-tester both read THIS rather than each deciding. */
  navRow: number;
  tabsRow: number;
  /** Where each drawn tab sits. The renderer draws FROM these; it must never recompute them, or the
   *  mouse and the paint disagree and clicks land on the wrong tab. */
  tabSpans: readonly TabSpan[];
  /** Tabs the strip could not draw, named as a count. Chrome overflows by dropping whole tabs. */
  tabMore: {
    pre: { x: number; w: number; hidden: number } | null;
    post: { x: number; w: number; hidden: number } | null;
  };
  /** Content area, title and tab rows excluded. */
  body: Rect;
}

export interface BarChip {
  pane: PaneId;
  /** The function key that jumps here. Not an index: two chips can point at one pane. */
  key: number;
  /** What the chip is called. */
  title: string;
  x: number;
  w: number;
  /** The one cell that toggles minimize. The rest of the chip focuses. */
  twigX: number;
  open: boolean;
  focused: boolean;
}

export interface Layout {
  mode: LayoutMode;
  cols: number;
  rows: number;
  bodyH: number;
  colH: number;
  dashH: number;
  /** Only OPEN panes. A minimized pane has no box — it lives on `bar`, keeping its counter. */
  boxes: readonly PaneBox[];
  bar: readonly BarChip[];
  /** What had to give, in words. */
  notes: readonly string[];
  /** Panes this resolve forced closed. The runtime latches these into `minimized`. */
  forced: readonly PaneId[];
  /** Panes the reader has a key for that this size cannot hold, and what it would take. */
  blocked: readonly { pane: PaneId; need?: number; needRows?: number }[];
  /**
   * The draggable boundaries. A vertical seam sits at column `x` across the column band; a
   * horizontal one sits at row `y` across the full width.
   *
   * `target` is the pane a drag actually resizes, and it is NOT always the pane on the left. The
   * centre is a flex pane whose width is computed as the remainder, so writing a size for it is
   * silently discarded — dragging the Traces|Detail seam therefore has to resize TRACES. `sign`
   * carries the direction: +1 when moving the pointer along the axis grows the target, -1 when it
   * shrinks it.
   */
  seams: readonly {
    axis: 'v' | 'h';
    x: number;
    y: number;
    /** Column bounds for an 'h' seam that does NOT span the frame — the Map|Diff seam lives inside
     *  the centre column, and grabbing that row over Traces must stay a Traces click. Absent means
     *  the historical whole-row seam (the strips). */
    x0?: number;
    x1?: number;
    left: PaneId;
    right: PaneId;
    target: PaneId;
    sign: 1 | -1;
  }[];
  zoom: PaneId | null;
  focus: PaneId;
  chrome: { top: number; bottom: number };
  /** The session navbar is boxed — 3 chrome rows instead of 1; the hit-test derives its span. */
  navBox: boolean;
  /**
   * Where each tab sits on row 0. Empty when there are no tabs.
   *
   * It lives HERE, in the resolved layout, for the reason `tabSpans` already does: the renderer and
   * the hit test must read the same geometry or a click lands on a neighbouring tab. Two calls to
   * `tabSpansFor` with independently-computed budgets is exactly how that drifts.
   */
  tabbar: readonly TabSpan[];
  /** Tabs the row could not draw, named as a count — the same overflow vocabulary a pane's own tab
   *  strip uses. Without these a narrow terminal silently loses a tab, which reads as the tab having
   *  been closed rather than scrolled off. */
  tabbarMore: PaneBox['tabMore'];
}

export interface LayoutRequest {
  cols: number;
  rows: number;
  minimized: ReadonlySet<PaneId>;
  /**
   * Panes this TAB does not have at all — force-minimized AND kept off the window bar, so they are
   * absent rather than folded. `minimized` says "closed, reopen with its F-key"; `hidden` says "not
   * part of this workspace" (review has no Agent/Dashboards; the agent tab has its own surface).
   */
  hidden?: ReadonlySet<PaneId>;
  /** Draw each pane inside a solid box border. When set, `makeBox` insets every pane's `body` by the
   *  border (one cell each side, one row for the foot) so the renderer can wrap it in `boxAround`. */
  boxes?: boolean;
  zoom?: PaneId | null;
  focus: PaneId;
  tab?: Readonly<Partial<Record<PaneId, number>>>;
  /**
   * Widths the reader set by dragging a seam, overriding `want` for those panes. They ride the same
   * share/clamp path as the defaults — a second sizing route would drift from the tested one — and
   * they are still floored at `min`, so a drag can never produce a pane that cannot render honestly.
   */
  sizes?: Readonly<Partial<Record<PaneId, number>>>;
  /**
   * The tab labels, left to right. Absent or empty keeps the pre-tab TWO-row top chrome, so every
   * existing snapshot and the non-TTY one-shot resolve byte-identically — the tab bar costs a row
   * only where there are tabs to put on it.
   */
  tabs?: readonly string[];
  /** Box the session navbar (boxed glyph tier): the top chrome grows by two rows, and the renderer
   *  and hit-test both read the resolved layout — never a second source of truth. */
  navBox?: boolean;
  activeTab?: number;
}

/**
 * window bar · session-and-attention row.
 *
 * The window bar leads. It is the only row that names every region and carries its jump key, so it
 * is the frame's table of contents — and a table of contents printed third, under two rows of
 * session state, is one the reader has to go looking for.
 *
 * Two rows, not three: the session name and the attention counts are both short strings, and a
 * terminal is far shorter than it is wide. Giving each its own row spent a line of every window
 * below on whitespace the other one was already padding.
 */
/**
 * The cursor column every pane body row is drawn behind — the `>` marker at depth none, a blank
 * otherwise. It shifts EVERY painted cell one column right of the layout its renderer computed, so
 * any hit-test that resolves a click to a cell must subtract it. Named, because it was a bare `- 1`
 * in the one place that remembered and absent in the two that did not.
 */
export const PANE_GUTTER = 1;

export const CHROME_TOP = 2;

/**
 * Columns held back on the tab row for the Workers rollup (`▸2  ?1  ◆1`).
 *
 * Workers must be visible in EVERY tab, and a full-width strip of its own would take top chrome from
 * 3 rows to 4 — worse than the layout it replaced. herdr solves it the same way: status segments
 * right-align onto the tab row, and tabs win the row when it gets narrow.
 */
export const WORKERS_ROLLUP_W = 14;
/** The floor: divider · status · gauges · keys. Kept as a const because three call sites and a
 *  handful of tests still speak in terms of "the smallest bottom chrome there is". */
export const CHROME_BOTTOM = 4;

/**
 * How many rows the bottom chrome takes at this height.
 *
 * The bottom chrome is divider · status · statusline · keys. The statusline USED to be the shipped
 * three-line block (clock/branch/dir · model · gauges), which degraded on short terminals by dropping
 * lines longest-first. It is now a SINGLE combined usage readout that compacts to fit rather than growing,
 * so the block is a flat four rows at every height — no ladder, and the two rows the old block spent
 * at tall heights go back to the body. The divider, status row and key hints are never dropped.
 */
export function chromeBottom(_rows: number): number {
  return CHROME_BOTTOM; // divider · status · one-line usage readout · keys
}
/** How many statusline lines the readout draws — one now (it compacts instead of wrapping). */
export function statuslineWant(rows: number): number {
  return chromeBottom(rows) - 3; // minus divider · status · keys → 1
}
/** The column band never gives the bottom dock rows below this, by DEFAULT. */
export const COL_FLOOR = 16;
/** …but a reader who drags the seam may take it this low. Their instruction outranks our default. */
export const DRAG_COL_FLOOR = 6;

/**
 * Every tab here has a row producer behind it. The editors' windows carry a few views the terminal
 * cannot draw yet (File History, Stats), and listing them would buy a strip that matches the IDE
 * screenshot at the cost of tabs that open onto nothing — a hole the reader finds by clicking. They
 * are absent until they render; the docs say which, rather than the strip implying otherwise.
 */
export const PANE_SPECS: readonly PaneSpec[] = [
  // DECLARATION ORDER IS WINDOW-BAR ORDER, and the bar reads left to right as F1..F6. The keys number
  // the regions in the order a review moves through them — who is doing the work, what was asked, what
  // it changed, what else is going on — and Detail is last because it is what the others point at.
  //
  // Claude leads: the agent's own window — a status row (model, liveness, pending count, the last
  // ask), a LIVE TAIL of the session feed beneath it, and the door back into the conversation
  // (F1 again opens the Agent SCREEN — the drive surface; `r` keeps the native `claude --resume`
  // handover for hook-observed Claude sessions). `min` 4 is the smallest honest live pane:
  // title + status + two tail rows; `want` 10 gives the tail room without displacing a workspace.
  // Titled 'Agent', not 'Claude': the strip shows whichever agent the
  // session ran — hook-observed Claude or an ACP-driven one. The internal id stays 'claude';
  // renaming code identity is churn with zero reader value.
  { id: 'claude', n: 1, dock: 'top', title: 'Agent', min: 4, want: 10, yield: 0, tabs: [] },
  // Prompts sits ABOVE Traces in the left column now — a sub-split of the left cell, mirroring Map over Diff on the
  // right. `dock: 'left'` puts it in the band (not the top strips); like Map its width is the column's
  // and its height is the split, so `want` is inert (0), and its `min` never claims column width because
  // it is not in `COLUMNS`.
  { id: 'prompts', n: 2, dock: 'left', title: 'Prompts', min: 3, want: 0, yield: 0, tabs: [] },
  // ONE list (labelled Review, like the editors); opening a prompt scopes it to the picked ask (esc clears).
  // Titled for the WINDOW, not its contents: the editors call this Observatory Traces, and a reader
  // moving between the terminal and an IDE should not have to learn two names for one thing.
  // min 36, not 30: the left column now stacks MAP over Traces, and Map needs 36
  // columns for its own table — so the column, and every drag of its seam, must reserve Map's width too.
  { id: 'traces', n: 3, dock: 'left', title: 'Traces', min: 36, want: 42, yield: 3, tabs: [] },
  // The MAP: a REAL pane above Diff in the centre column (two separate
  // panels with their own chrome and their own keys, never two faces of one window; the face swap
  // was an auto-revert bug factory). It shares the centre column's WIDTH — `min` matches Diff's for
  // that reason — and its HEIGHT is the split: 20% of the column by default, dragged at the seam
  // like every other seam. It navigates: the node under its cursor scopes the Traces list.
  { id: 'map', n: 4, dock: 'centre', title: 'Map', min: 36, want: 0, yield: 4, tabs: [] },
  // The DIFF: the selected edit, rendered rich, below the map. `nav` buys the action row (Keep,
  // Undo, prev/next) that acts on the edit being shown.
  { id: 'detail', n: 5, dock: 'centre', title: 'Diff', min: 36, want: 0, yield: 4, nav: true, tabs: [] },
  // Everything that is not the edit under review. Observations and Actions arrived here when the
  // right-hand sidebar went. Ordered by what a review reaches for: who did the work and under what
  // plan, then what was observed and what was run, then the machinery.
  {
    id: 'dashboards', n: 6, dock: 'bottom', title: 'Dashboards', min: 7, want: 10, yield: 2,
    // WORKERS, not "Fleet" and not "Agents". One word per concept: an AGENT is
    // the product that ran the session (claude, codex); a WORKER is a session doing work — the same
    // entity seen as an actor rather than as a record. "Fleet" named the collection and left the row
    // unnamed, which is how one word ended up meaning five things.
    tabs: ['Workers', 'Workflows', 'Tasks', 'Observations', 'Actions', 'Processes'],
  },
];


/**
 * The window bar, chip by chip — and the function key that jumps to each.
 *
 * One chip per pane, one function key each.
 *
 * One documented exception to "a pane's key pressed again zooms it": the Claude strip has nothing to
 * zoom into, so F1 again LAUNCHES Claude instead — the drill-in gesture, applied to the pane whose
 * drill-in is the agent itself.
 */
export interface BarEntry {
  key: number;
  pane: PaneId;
  title: string;
}
export const BAR_ENTRIES: readonly BarEntry[] = [
  { key: 1, pane: 'claude', title: 'Agent' },
  { key: 2, pane: 'prompts', title: 'Prompts' },
  { key: 3, pane: 'traces', title: 'Traces' },
  { key: 4, pane: 'map', title: 'Map' },
  { key: 5, pane: 'detail', title: 'Diff' },
  { key: 6, pane: 'dashboards', title: 'Dashboards' },
];

/**
 * Which screen produces a pane's rows. Panes with no tab strip take the first entry, except Detail,
 * which the renderer resolves from the selection.
 *
 * File History is gone: it had no "active editor" to follow in a terminal, so it could only ever
 * mirror whatever was already selected in the list beside it.
 */
export const TAB_SCREEN: Record<PaneId, readonly string[]> = {
  claude: ['claude'],
  prompts: ['prompts'],
  traces: ['edits'],
  map: ['map'],
  // Two real panes now: Diff shows the selected edit, Map navigates — the
  // face machinery this table once fed is gone.
  detail: ['diff'],
  dashboards: ['agents', 'workflows', 'tasks', 'observations', 'audit'],
};

const BY_ID: Record<PaneId, PaneSpec> = Object.fromEntries(PANE_SPECS.map((p) => [p.id, p])) as Record<PaneId, PaneSpec>;
const COLUMNS: readonly PaneId[] = ['traces', 'detail'];
/** The vertical floors of the centre split: a map window that can still show a tree (title + three
 *  rows), and a diff that can still show a hunk (title + action bar + three patch rows). Kept at
 *  the honest minimum on purpose: at a 34-row terminal with default strip heights the band is 10
 *  rows, and folding a whole pane the reader asked to be omnipresent is a worse trade than a short
 *  diff they can re-balance at the seam. Below the sum plus the seam row, the split yields and
 *  Diff takes the whole cell (the note says so). */
const MAP_MIN_ROWS = 4;
const DIFF_MIN_ROWS = 5;
/** The vertical floors of the LEFT split — Prompts over Traces, mirroring Map over Diff on the right
 * Prompts shows its ask in a title + two rows; Traces keeps the edit list readable.
 *  Below the sum plus the seam row the split yields and Traces takes the whole left cell. */
const PROMPT_MIN_ROWS = 3;
const TRACES_MIN_ROWS = 5;
/** Prompt and Map default to the SAME height, so the two columns' top panes line up;
 *  the reader drags each column's seam independently from there. A shared ratio is what keeps them equal
 *  by default without linking the two seams. */
const TOP_ROW_RATIO = 0.35;
/** The left column (Map+Traces after the swap) takes ~30% by default, so the Diff+Prompts column on the
 *  right gets ~70% — the diff is what a review reads. A drag on the column seam still
 *  overrides it. */
const LEFT_COL_RATIO = 0.3;

/** Widths for a set of panes: start at `min`, grow proportionally toward `want`, largest-remainder. */
function share(total: number, mins: number[], wants: number[]): number[] {
  const spanTotal = wants.reduce((a, w, i) => a + (w - mins[i]), 0);
  const room = total - mins.reduce((a, b) => a + b, 0);
  if (spanTotal <= 0 || room <= 0) return mins.slice();
  const t = Math.min(1, room / spanTotal);
  const exact = mins.map((m, i) => m + t * (wants[i] - m));
  const out = exact.map((v) => Math.floor(v));
  let used = out.reduce((a, b) => a + b, 0);
  const rema = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  let k = 0;
  while (used < total && k < rema.length * 8) {
    out[rema[k % rema.length].i]++;
    used++;
    k++;
  }
  return out;
}

const needCols = (ids: readonly PaneId[]): number =>
  ids.reduce((a, id) => a + BY_ID[id].min, 0) + Math.max(0, ids.length - 1);

export function resolveLayout(req: LayoutRequest): Layout {
  const { cols, rows, focus } = req;
  const zoom = req.zoom ?? null;
  const useBoxes = req.boxes ?? false; // each pane gets a solid box border; makeBox insets its body
  const notes: string[] = [];
  const forced: PaneId[] = [];
  // A zoom IS a minimize of everything else. One path, so zoom is correct for all four panes.
  const min = new Set<PaneId>(zoom ? PANE_SPECS.filter((p) => p.id !== zoom).map((p) => p.id) : req.minimized);
  // A hidden pane is always minimized (it never gets a box) and, below, never gets a bar chip either.
  if (req.hidden) for (const h of req.hidden) min.add(h);
  // The tab bar costs row 0 — and ONLY where there are tabs, so a caller that passes none resolves
  // byte-identically to every layout this engine produced before tabs existed.
  const tabLabels = req.tabs ?? [];
  // The session navbar is a BOX on the boxed glyph tier (the agent screen got it
  // first): top edge + selector row + bottom edge = 3 rows where the flat row took 1. Opt-in via the
  // request so every existing caller (and every layout test) resolves byte-identically without it.
  const navRows = req.navBox ? 3 : 1;
  const top = CHROME_TOP - 1 + navRows + (tabLabels.length ? 1 : 0); // window bar + navbar (+ tab strip: one row, no rules)
  // Reserve the right end of the tab row for the Workers rollup, which rides the SAME row rather
  // than taking chrome from 3 rows to 4 (the reason it is not a strip of its own). Outer cells use
  // herdr's four columns of padding, one-column gaps, and minimum width of eight.
  const tabFit = tabLabels.length
    ? tabSpansFor(tabLabels, 0, Math.max(0, cols - WORKERS_ROLLUP_W), req.activeTab ?? 0, 4, 1, 8)
    : null;
  const tabbar = tabFit?.spans ?? [];
  const tabbarMore = { pre: tabFit?.pre ?? null, post: tabFit?.post ?? null };
  // One row MORE than the chrome ladder reserves: the status row is drawn only when it has
  // something to say (renderPanes), and the band claims it the rest of the time.
  const bodyH = Math.max(0, rows - top - chromeBottom(rows) + 1);

  let open = COLUMNS.filter((id) => !min.has(id));
  // The focused pane is never the victim while another column could go instead: at 60 columns you
  // want the list you are acting on, not a diff of something you can no longer select.
  const victims = open.filter((id) => id !== focus).sort((a, b) => BY_ID[a].yield - BY_ID[b].yield);
  while (open.length > 1 && needCols(open) > cols) {
    const v = victims.shift() ?? open.find((id) => id !== focus) ?? open[0];
    open = open.filter((id) => id !== v);
    min.add(v);
    forced.push(v);
    notes.push(`${BY_ID[v].title} minimized: ${cols} columns cannot hold it and still leave ${BY_ID.detail.min} for Detail`);
  }
  const mode: LayoutMode = open.length >= 2 ? 'wide' : open.length === 1 ? 'stack' : 'dock-only';
  if (open.length === 1 && cols < BY_ID[open[0]].min) {
    notes.push(`${cols} columns is under the ${BY_ID[open[0]].min} ${BY_ID[open[0]].title} wants; rows wrap`);
  }

  // The TOP band is carved first: Prompts sits under the session selector and above everything the
  // prompt caused. It yields before the bottom dock (yield 0) because the bottom dock is a summary
  // and the prompt is the question the whole screen is answering.
  // Prompts is NOT a top strip anymore — it stacks OVER Traces in the LEFT column, mirroring Map over Diff on the
  // right. So no top-strip rows are carved here; the split happens in the column loop below, and a ZOOM
  // on Prompts is served by the full-extent fallback at the end of this function.
  const topH = 0;

  let dashOpen = zoom === 'dashboards' || !min.has('dashboards');
  let dashH = 0;
  if (open.length === 0) {
    dashH = dashOpen ? bodyH : 0;
  } else if (dashOpen) {
    // COL_FLOOR keeps the DEFAULT layout from starving the column band for a summary pane. A drag is
    // an explicit request, not a default, so a reader-set height may go past it — down to a floor
    // that still leaves the band readable. Refusing a direct instruction reads as the drag being broken.
    const floor = req.sizes?.dashboards !== undefined ? DRAG_COL_FLOOR : COL_FLOOR;
    const room = bodyH - topH - floor;
    if (room < BY_ID.dashboards.min) {
      dashOpen = false;
      min.add('dashboards');
      forced.push('dashboards');
      notes.push(`Dashboards minimized: it needs ${COL_FLOOR + BY_ID.dashboards.min} body rows; this terminal has ${bodyH - topH}`);
    } else {
      dashH = Math.min(Math.max(BY_ID.dashboards.min, req.sizes?.dashboards ?? BY_ID.dashboards.want), room);
    }
  }
  // The Claude strip is carved LAST, above Prompts on screen but below everything in priority: it is
  // a status readout, and every other window is a workspace. When rows run short it goes first —
  // before Prompts, before Dashboards — and folded it keeps its chip and the F1 launch
  // gesture, so nothing is lost but two rows of summary.
  let clH = 0;
  const clOpen = zoom === 'claude' || (!min.has('claude') && zoom === null);
  if (clOpen && open.length) {
    const room = bodyH - COL_FLOOR - topH - dashH;
    if (room < BY_ID.claude.min) {
      min.add('claude');
      forced.push('claude');
      notes.push(`Agent minimized: it needs ${COL_FLOOR + topH + dashH + BY_ID.claude.min} body rows; this terminal has ${bodyH}`);
    } else {
      // Floored at `min` like the Dashboards dock: a drag can shrink the strip, never crush it to a
      // row that cannot hold its status line.
      clH = Math.min(Math.max(BY_ID.claude.min, req.sizes?.claude ?? BY_ID.claude.want), room);
    }
  } else if (zoom === 'claude') {
    clH = bodyH;
  }

  const colH = bodyH - dashH - topH - clH;

  const boxes: PaneBox[] = [];
  if (clH > 0) boxes.push(makeBox('claude', 0, top, cols, clH, focus === 'claude', 0, useBoxes));
  const y0 = top + clH; // topH is gone (Prompts moved into the left column); the band starts under Claude
  if (open.length && colH > 0) {
    const avail = cols - (open.length - 1); // one seam column between adjacent panes
    let widths: number[];
    if (open.length === 1) {
      widths = [avail];
    } else if (open.includes('detail')) {
      // Sides take what they want up to the point Detail still has its minimum; Detail absorbs the
      // rest. The centre is the thing being read, so it is the one that grows with the window.
      const sides = open.filter((id) => id !== 'detail');
      const target = avail - BY_ID.detail.min;
      const wantOf = (id: PaneId) => Math.max(BY_ID[id].min, req.sizes?.[id] ?? (id === 'traces' ? Math.round(avail * LEFT_COL_RATIO) : BY_ID[id].want));
      const sw = share(
        Math.min(target, sides.reduce((a, id) => a + wantOf(id), 0)),
        sides.map((id) => BY_ID[id].min),
        sides.map((id) => wantOf(id))
      );
      const map: Partial<Record<PaneId, number>> = {};
      sides.forEach((id, i) => (map[id] = sw[i]));
      map.detail = avail - sw.reduce((a, b) => a + b, 0);
      widths = open.map((id) => map[id] as number);
    } else {
      const sw = share(
        avail,
        open.map((id) => BY_ID[id].min),
        open.map((id) => Math.max(BY_ID[id].min, req.sizes?.[id] ?? BY_ID[id].want))
      );
      sw[Math.max(0, open.indexOf(focus))] += avail - sw.reduce((a, b) => a + b, 0);
      widths = sw;
    }
    let x = 0;
    open.forEach((id, i) => {
      if (id === 'detail' && !min.has('prompts') && zoom === null && colH >= PROMPT_MIN_ROWS + 1 + DIFF_MIN_ROWS) {
        // SWAPPED: Prompts now rides the RIGHT cell over Diff — the ask beside the
        // change it produced — while Map moves to the left over Traces. The reader's dragged height wins
        // inside floors that keep both halves usable; the default gives the top a third and Diff the rest.
        const promptsH = Math.min(colH - 1 - DIFF_MIN_ROWS, Math.max(PROMPT_MIN_ROWS, req.sizes?.prompts ?? Math.round(colH * TOP_ROW_RATIO)));
        boxes.push(makeBox('prompts', x, y0, widths[i], promptsH, focus === 'prompts', 0, useBoxes));
        boxes.push(makeBox('detail', x, y0 + promptsH + 1, widths[i], colH - promptsH - 1, focus === 'detail', req.tab?.detail ?? 0, useBoxes));
      } else if (id === 'traces' && !min.has('map') && zoom === null && colH >= MAP_MIN_ROWS + 1 + TRACES_MIN_ROWS) {
        // The LEFT cell now holds Map above Traces (swap prompts/map) — the navigator
        // over the list it steers. A dragged height wins inside floors.
        const mapH = Math.min(colH - 1 - TRACES_MIN_ROWS, Math.max(MAP_MIN_ROWS, req.sizes?.map ?? Math.round(colH * TOP_ROW_RATIO)));
        boxes.push(makeBox('map', x, y0, widths[i], mapH, focus === 'map', 0, useBoxes));
        boxes.push(makeBox('traces', x, y0 + mapH + 1, widths[i], colH - mapH - 1, focus === 'traces', req.tab?.traces ?? 0, useBoxes));
      } else {
        if (id === 'detail' && !min.has('prompts') && zoom === null) {
          notes.push(`Prompts folded: the split needs ${PROMPT_MIN_ROWS + 1 + DIFF_MIN_ROWS} band rows; this terminal has ${colH}`);
        }
        if (id === 'traces' && !min.has('map') && zoom === null) {
          notes.push(`Map folded: the split needs ${MAP_MIN_ROWS + 1 + TRACES_MIN_ROWS} band rows; this terminal has ${colH}`);
        }
        boxes.push(makeBox(id, x, y0, widths[i], colH, focus === id, req.tab?.[id] ?? BY_ID[id].defaultTab ?? 0, useBoxes));
      }
      x += widths[i] + 1;
    });
  }
  if (dashH > 0) {
    boxes.push(makeBox('dashboards', 0, y0 + colH, cols, dashH, focus === 'dashboards', req.tab?.dashboards ?? BY_ID.dashboards.defaultTab ?? 0, useBoxes));
  }
  if (zoom === 'prompts' && !boxes.length) boxes.push(makeBox('prompts', 0, top, cols, bodyH, true, 0, useBoxes));
  // Zooming the Map: it rides the centre CELL rather than the COLUMNS list, so the band above
  // skipped it — the zoom must still produce a full-extent box like every other pane's.
  if (zoom === 'map' && !boxes.length) boxes.push(makeBox('map', 0, top, cols, bodyH, true, 0, useBoxes));
  // Zooming the Claude strip when the column band is already gone must still produce a box — a zoom
  // that renders NOTHING is a blank terminal, which is how an unlisted pane fails here (measured: the
  // first cut of this pane returned boxes:[] for exactly this call).
  if (zoom === 'claude' && !boxes.length) boxes.push(makeBox('claude', 0, top, cols, bodyH, true, 0, useBoxes));

  // Every pane keeps a chip whether or not it has a box, so a minimized pane never leaves the bar.
  const bar: BarChip[] = [];
  let bx = 0;
  for (const e of BAR_ENTRIES) {
    if (req.hidden?.has(e.pane)) continue; // a hidden pane is absent, not folded onto the bar
    const w = 3 + 1 + displayWidth(e.title); // "Fn " + twig + title
    bar.push({
      pane: e.pane,
      key: e.key,
      title: e.title,
      x: bx,
      w,
      twigX: bx + 3,
      open: boxes.some((b) => b.id === e.pane),
      focused: focus === e.pane,
    });
    bx += w + 3;
  }

  // `blocked` is for panes the SIZE refused, never for panes the reader closed on purpose. Under a
  // zoom every other pane is absent by request, so reporting what each would cost turns the status
  // row into noise and buries whatever it was actually saying.
  const blocked: { pane: PaneId; need?: number; needRows?: number }[] = [];
  if (!zoom) {
    for (const id of COLUMNS) {
      if (boxes.some((b) => b.id === id)) continue;
      const n = needCols([...open, id]);
      if (n > cols) blocked.push({ pane: id, need: n });
    }
    // A hidden pane is absent by design (Review hides Dashboards); it never asks for rows — the note
    // masked keep/undo conflict messages on the status line at 80×24 (TUI sweep, 2026-09-23).
    if (!req.hidden?.has('dashboards') && !boxes.some((b) => b.id === 'dashboards') && bodyH - COL_FLOOR < BY_ID.dashboards.min && open.length) {
      blocked.push({ pane: 'dashboards', needRows: COL_FLOOR + BY_ID.dashboards.min });
    }
    // The TOP dock refuses loudly too. This was a real gap before the Claude strip arrived: a short
    // terminal force-minimized Prompts with a note that nothing rendered, so F2 focused a boxless pane
    // in silence. `blocked` is what the status row reads, so Prompts reports there when rows — not the
    // reader — are what closed it.
    //
    // The CLAUDE strip is deliberately exempt. `blocked` exists because a folded pane's function is
    // otherwise LOST; folded Claude loses nothing a status line could restore — the chip stays on the
    // bar, and F1 still focuses it and launches the agent. Reporting it would park
    // "Claude needs 32 body rows" on the status row of every ~34-row terminal permanently, hiding the
    // messages that row exists to carry (mutation results, errors, "nothing selected").
    if (!boxes.some((b) => b.id === 'prompts') && bodyH - COL_FLOOR < BY_ID.prompts.min && open.length) {
      blocked.push({ pane: 'prompts', needRows: COL_FLOOR + BY_ID.prompts.min });
    }
  }

  // "Not the column band" is decided by DOCK, never by a hand-kept list of ids — the list is exactly
  // how a new dock pane ends up composed side-by-side with Traces (the failure renderPanes records
  // for the Prompts dock).
  // Map is EXCLUDED here: it shares Diff's x, and the vertical-seam builder below pairs
  // neighbours by column — a stacked pane would fabricate a zero-width seam inside the cell.
  // Its own seam is HORIZONTAL, pushed after this block.
  const band = boxes.filter((b) => b.id !== 'map' && b.id !== 'prompts' && BY_ID[b.id].dock !== 'top' && BY_ID[b.id].dock !== 'bottom').sort((a, b) => a.rect.x - b.rect.x);
  const seams: Layout['seams'][number][] = band.slice(0, -1).map((b, i) => {
    const right = band[i + 1].id;
    // Resize whichever side is NOT the flex centre; dragging toward a right-hand target shrinks it.
    const target = b.id === 'detail' ? right : b.id;
    return { axis: 'v' as const, x: b.rect.x + b.rect.w, y: -1, left: b.id, right, target, sign: (target === b.id ? 1 : -1) as 1 | -1 };
  });
  const topBox = boxes.find((bx) => bx.id === 'prompts');
  const dashBox = boxes.find((bx) => bx.id === 'dashboards');
  // Prompts is no longer a full-width strip — its seam is now the horizontal Prompts|Traces seam bounded
  // to the LEFT column, pushed below with the Map|Diff seam.
  if (dashBox && band.length) {
    // The dock grows UPWARD, so moving the pointer down shrinks it.
    seams.push({ axis: 'h', x: -1, y: dashBox.rect.y - 1, left: band[0].id, right: 'dashboards', target: 'dashboards', sign: -1 });
  }
  const clBox = boxes.find((bx) => bx.id === 'claude');
  if (clBox && (topBox || band.length)) {
    // Same rule as the Prompts seam: the strip's LAST row is the grab row (the row below is the next
    // pane's clickable title). Target claude, growing downward.
    seams.push({ axis: 'h', x: -1, y: clBox.rect.y + clBox.rect.h - 1, left: 'claude', right: topBox ? 'prompts' : band[0].id, target: 'claude', sign: 1 });
  }
  {
    // One horizontal seam INSIDE each split column — between its top pane and the one stacked below —
    // targeting the TOP (the bottom is the cell's flex remainder). GENERIC over which panes those are, so
    // swapping prompts/map needs no change here: it pairs by column, whatever fills it.
    const byCol = new Map<number, PaneBox[]>();
    for (const b of boxes) {
      if (b.id === 'dashboards' || b.id === 'claude') continue; // full-width strips, not band columns
      const col = byCol.get(b.rect.x) ?? [];
      col.push(b);
      byCol.set(b.rect.x, col);
    }
    for (const col of byCol.values()) {
      if (col.length !== 2) continue; // only a SPLIT column has an inside seam
      col.sort((a, b) => a.rect.y - b.rect.y);
      const [top, bot] = col;
      seams.push({
        axis: 'h', x: -1, x0: top.rect.x, x1: top.rect.x + top.rect.w,
        y: top.rect.y + top.rect.h, left: top.id, right: bot.id, target: top.id, sign: 1,
      });
    }
  }

  return {
    mode, cols, rows, bodyH, colH, dashH, boxes, bar, notes, forced, blocked, zoom, focus, seams,
    chrome: { top, bottom: chromeBottom(rows) },
    navBox: !!req.navBox,
    tabbar,
    tabbarMore,
  };
}

/**
 * Where each tab of a strip sits, and what could not be drawn.
 *
 * Extracted from the pane geometry so the Agent screen's own Dashboards strip is laid out by the
 * SAME code. Two implementations of this would
 * be two ways for a click to land on a different tab than the one under the pointer, which is the
 * exact failure `tabSpans` exists to prevent.
 *
 * Overflow drops WHOLE tabs and names the count — a clipped tab name is the same defect class as a
 * clipped path — and scrolls so the selected tab is always among those drawn.
 */
export function tabSpansFor(
  tabs: readonly string[],
  x0: number,
  budget: number,
  selTab: number,
  padding = 2,
  gap = 0,
  minWidth = 0
): { spans: TabSpan[]; pre: PaneBox['tabMore']['pre']; post: PaneBox['tabMore']['post']; sel: number } {
  // Outer tabs follow herdr's padded cells and one-column gaps; pane tabs keep their compact cells.
  const cellW = (i: number) => Math.max(minWidth, displayWidth(tabs[i]) + padding);
  const sel = Math.max(0, Math.min(tabs.length - 1, selTab));
  let from = 0;
  let spans: TabSpan[] = [];
  let pre: PaneBox['tabMore']['pre'] = null;
  let post: PaneBox['tabMore']['post'] = null;
  if (!tabs.length) return { spans, pre, post, sel: 0 };
  for (;;) {
    const preW = from > 0 ? String(from).length + 2 : 0;
    let used = preW;
    let to = from;
    const trial: number[] = [];
    while (to < tabs.length) {
      const tailW = to + 1 < tabs.length ? String(tabs.length - to - 1).length + 2 + gap : 0;
      if (used + cellW(to) + tailW > budget) break;
      trial.push(to);
      used += cellW(to) + (to + 1 < tabs.length ? gap : 0);
      to++;
    }
    if (to > from && to > sel && from <= sel) {
      let tx = x0;
      if (from > 0) {
        pre = { x: tx, w: String(from).length + 2, hidden: from };
        tx += pre.w;
      }
      spans = trial.map((i) => {
        const s: TabSpan = { index: i, label: tabs[i], x: tx, w: cellW(i), selected: i === sel };
        tx += s.w + gap;
        return s;
      });
      if (to < tabs.length) post = { x: tx, w: String(tabs.length - to).length + 2, hidden: tabs.length - to };
      break;
    }
    if (from >= tabs.length - 1) {
      // Last resort: only the selected tab fits. It STILL has to say what it dropped — a strip that
      // shows one of eight tabs and reports nothing is a silent failure, and the reader has no way to
      // learn the other seven exist. Precise counts if both markers fit; one combined count if only
      // one does; nothing at all only when the width cannot hold even ` +N`.
      let tx = x0;
      const before = sel;
      const after = tabs.length - sel - 1;
      const preW2 = before ? String(before).length + 2 : 0;
      const postW = after ? String(after).length + 2 : 0;
      const bothW = String(tabs.length - 1).length + 2;
      if (preW2 + cellW(sel) + postW <= budget) {
        if (before) { pre = { x: tx, w: preW2, hidden: before }; tx += preW2; }
        spans = [{ index: sel, label: tabs[sel], x: tx, w: cellW(sel), selected: true }];
        if (after) post = { x: tx + cellW(sel), w: postW, hidden: after };
      } else if (cellW(sel) + bothW <= budget) {
        spans = [{ index: sel, label: tabs[sel], x: tx, w: cellW(sel), selected: true }];
        post = { x: tx + cellW(sel), w: bothW, hidden: tabs.length - 1 };
      } else {
        spans = [{ index: sel, label: tabs[sel], x: tx, w: cellW(sel), selected: true }];
      }
      break;
    }
    from++;
  }
  return { spans, pre, post, sel };
}

/** Is (col,row) on this seam? One expression, shared by the pane grid and the Agent screen, so a
 *  grab band cannot mean two different things on two surfaces. */
export function onSeam(
  sm: { axis: 'v' | 'h'; x: number; y: number; x0?: number; x1?: number },
  col: number,
  row: number,
  bandTop: number,
  bandH: number,
  cols: number
): boolean {
  return sm.axis === 'v'
    ? Math.abs(col - sm.x) <= 1 && row >= bandTop && row < bandTop + bandH
    : row === sm.y && (sm.x0 === undefined || (col >= sm.x0 && col < (sm.x1 ?? cols)));
}

function makeBox(id: PaneId, x: number, y: number, w: number, h: number, focused: boolean, selTab: number, boxes = false): PaneBox {
  const p = BY_ID[id];
  // With boxes on, a solid border rings the pane: the content (`body`) sits one cell inside on the
  // left/right, the title row IS the box top, and the box BOTTOM costs one row (`footer`). Without
  // boxes the title/tab rows are bands and the body is full-bleed — byte-identical to before.
  const footer = boxes ? 1 : 0;
  const bx = boxes ? x + 1 : x;
  const bw = boxes ? Math.max(0, w - 2) : w;
  const x0 = x + 1;
  const budget = x + w - x0 - footer;
  if (!p.tabs.length) {
    // No tab strip. An action bar, if the pane has one, takes the row under the title — and it is
    // accounted for HERE so that `navRow`, the body offset and the composed line count all come from
    // one number. Deciding it in the renderer instead is what made every Detail button undrawable-on
    // and unclickable at once.
    //
    // The Diff pane's bar: Keep, Undo, prev and next act on the one edit being shown. The Map is a
    // separate pane now and simply has no `nav` in its spec — no face plumbing required.
    const navRow = p.nav ? y + 1 : -1;
    const chrome = navRow >= 0 ? 2 : 1;
    return {
      id, focused, selTab: 0,
      rect: { x, y, w, h },
      titleRow: y,
      navRow,
      tabsRow: -1,
      tabSpans: [],
      tabMore: { pre: null, post: null },
      body: { x: bx, y: y + chrome, w: bw, h: Math.max(0, h - chrome - footer) },
    };
  }
  const CHROME_ROWS = 2; // one title row, one tab row
  const { spans, pre, post, sel } = tabSpansFor(p.tabs, x0, budget, selTab);

  return {
    id, focused, selTab: sel,
    rect: { x, y, w, h },
    titleRow: y,
    navRow: -1,
    tabsRow: y + 1,
    tabSpans: spans,
    tabMore: { pre, post },
    body: { x: bx, y: y + CHROME_ROWS, w: bw, h: Math.max(0, h - CHROME_ROWS - footer) },
  };
}

export type Hit =
  | { t: 'chrome'; part: 'session' | 'attention' | 'windowbar' | 'status' | 'usage' | 'keys' | 'tabbar' | 'workers' }
  | { t: 'windowbar'; pane: PaneId; part: 'chip' | 'twig' }
  /** A top-level tab on row 0. `index` addresses `state.tabs`, not a pane's internal strip. */
  | { t: 'tabbar'; index: number }
  | { t: 'tab'; pane: PaneId; index: number }
  | { t: 'tabscroll'; pane: PaneId; dir: -1 | 1 }
  | { t: 'title'; pane: PaneId }
  /** A pane's action bar. The caller resolves the column through the same button list the renderer
   *  laid out, so a button is clickable in exactly the cells it was drawn in. */
  | { t: 'nav'; pane: PaneId }
  | { t: 'body'; pane: PaneId; row: number; col: number }
  | { t: 'seam'; index: number; left: PaneId; right: PaneId }
  | null;

/**
 * What is under the cursor. Pure, so the mouse can be tested without a terminal — and it reads the
 * SAME geometry the renderer drew from, which is the only way a click and a glyph agree.
 */
export function hitTest(layout: Layout, col: number, row: number): Hit {
  // Rows shift down by one when there is a tab bar, and `chrome.top` is what says so — NOT a
  // constant, because the no-tabs layout must keep resolving and hit-testing exactly as it did
  // before tabs existed. Reading the resolved layout is also what keeps the mouse and the renderer
  // agreeing about which row is which.
  const tabRow = layout.tabbar.length ? 0 : -1; // the tab strip is a single row (no top/bottom rules)
  const navRows = layout.navBox ? 3 : 1; // boxed navbar: edge + selector row + edge
  const sessTop = layout.chrome.top - navRows;
  const barRow = sessTop - 1;
  if (row === tabRow) {
    const { pre, post } = layout.tabbarMore;
    // The markers are AFFORDANCES, not decoration: clicking one reaches the tab it is counting,
    // which is the nearest hidden neighbour on that side.
    if (pre && col >= pre.x && col < pre.x + pre.w) return { t: 'tabbar', index: Math.max(0, layout.tabbar[0].index - 1) };
    if (post && col >= post.x && col < post.x + post.w) return { t: 'tabbar', index: layout.tabbar[layout.tabbar.length - 1].index + 1 };
    for (const s of layout.tabbar) if (col >= s.x && col < s.x + s.w) return { t: 'tabbar', index: s.index };
    // The right end of this row belongs to the Workers rollup, which navigates rather than filters.
    if (col >= layout.cols - WORKERS_ROLLUP_W) return { t: 'chrome', part: 'workers' };
    return { t: 'chrome', part: 'tabbar' };
  }
  if (row === barRow) {
    for (const b of layout.bar) {
      if (col >= b.x && col < b.x + b.w) return { t: 'windowbar', pane: b.pane, part: col === b.twigX ? 'twig' : 'chip' };
    }
    return { t: 'chrome', part: 'windowbar' };
  }
  // The session chip and the attention counts share this row. Which half was clicked is a question
  // about the session's NAME width, which this pure function has no way to know — the caller resolves
  // it through `sessionChipWidth`, the same measure the renderer laid the row out with.
  if (row >= sessTop && row < layout.chrome.top) return { t: 'chrome', part: 'session' };
  if (row === layout.rows - 3) return { t: 'chrome', part: 'status' };
  if (row === layout.rows - 2) return { t: 'chrome', part: 'usage' };
  if (row === layout.rows - 1) return { t: 'chrome', part: 'keys' };
  // The band starts below EVERY top-dock box, summed — not below "the prompts box", which was true
  // only while the top dock held exactly one pane. With two, the single-pane version offsets every
  // vertical-seam grab by the height of the strip it forgot.
  const bandTop = layout.chrome.top + layout.boxes.filter((b) => BY_ID[b.id].dock === 'top').reduce((a, b) => a + b.rect.h, 0);
  for (let i = 0; i < layout.seams.length; i++) {
    const sm = layout.seams[i];
    const hit =
      sm.axis === 'v'
        ? Math.abs(col - sm.x) <= 1 && row >= bandTop && row < bandTop + layout.colH
        : row === sm.y && (sm.x0 === undefined || (col >= sm.x0 && col < (sm.x1 ?? layout.cols)));
    if (hit) return { t: 'seam', index: i, left: sm.left, right: sm.right };
  }
  for (const b of layout.boxes) {
    const r = b.rect;
    if (col < r.x || col >= r.x + r.w || row < r.y || row >= r.y + r.h) continue;
    if (row === b.tabsRow) {
      for (const s of b.tabSpans) if (col >= s.x && col < s.x + s.w) return { t: 'tab', pane: b.id, index: s.index };
      const { pre, post } = b.tabMore;
      if (pre && col >= pre.x && col < pre.x + pre.w) return { t: 'tabscroll', pane: b.id, dir: -1 };
      if (post && col >= post.x && col < post.x + post.w) return { t: 'tabscroll', pane: b.id, dir: 1 };
      return { t: 'title', pane: b.id };
    }
    if (row === b.titleRow) return { t: 'title', pane: b.id };
    // Before the body test, always: the action bar sits between the two, and calling its row `body`
    // is exactly the bug that made every Detail button unclickable.
    if (row === b.navRow) return { t: 'nav', pane: b.id };
    if (row >= b.body.y && row < b.body.y + b.body.h) {
      return { t: 'body', pane: b.id, row: row - b.body.y, col: col - b.body.x };
    }
    return { t: 'title', pane: b.id };
  }
  return null;
}

/**
 * What is minimized before the reader has said anything. Consulted ONCE, at startup — it is a step
 * function, which is right for a first paint and wrong for a resize (see the latch, in the header).
 */
export function defaultMinimized(cols: number, rows: number): Set<PaneId> {
  const out = new Set<PaneId>();
  // One row MORE than the chrome ladder reserves: the status row is drawn only when it has
  // something to say (renderPanes), and the band claims it the rest of the time.
  const bodyH = Math.max(0, rows - CHROME_TOP - chromeBottom(rows) + 1);
  if (bodyH - COL_FLOOR < BY_ID.dashboards.min) out.add('dashboards');
  // The Claude strip starts closed unless the terminal can hold EVERYTHING else at its preferred
  // size and still spare its rows — it is the lowest-priority window, and a first paint that opens
  // it by folding a workspace would invert that. Same step-function shape as the rest. With min 4,
  // prompts.want 6, dashboards.want 10 and COL_FLOOR 16 this folds below 36 body rows (a 40-row
  // terminal) — acceptable: the seam, `<`/`>`, zoom and F1 all reopen it larger on demand.
  const dashRows = out.has('dashboards') ? 0 : BY_ID.dashboards.want;
  if (bodyH - COL_FLOOR - BY_ID.prompts.want - dashRows < BY_ID.claude.min) out.add('claude');
  // Detail yields before Traces at startup: with one column left, the list you act ON is worth more
  // than a diff of something you can no longer select.
  if (needCols(COLUMNS) > cols) out.add('detail');
  return out;
}


/**
 * Fold a resolve's forced closures into the reader's own minimized set — the latch.
 *
 * Shrinking the terminal may force a pane closed; growing it never re-opens one, because a pane
 * springing back while the reader is mid-drag is a lurch they did not ask for. Only the reader
 * clears it (`m`, a jump key, or `=`).
 *
 * This is exported because the runtime and its test must exercise the SAME code. A test that folds
 * `forced` in with its own two lines is asserting its own simulation, and would keep passing if the
 * runtime stopped latching entirely.
 */
export function latchMinimized(prev: ReadonlySet<PaneId>, lay: Layout): Set<PaneId> {
  const next = new Set(prev);
  for (const id of lay.forced) next.add(id);
  return next;
}
