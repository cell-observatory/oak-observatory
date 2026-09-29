/**
 * The terminal dashboard's frame, as a PURE function of state.
 *
 * Nothing here reads `process`, the clock, or the filesystem: `now` is injected and the colour depth
 * and glyph tier are arguments. That is what makes a frame a value you can assert line by line, at any
 * width, without a terminal — and it is why the CLI's own human renderers could not be reused, since
 * they decide their own colour at call time and can exit the process.
 *
 * The vocabulary it draws with is in ./tui/glyphs, chosen by measurement (see that file's header): no
 * box drawing, because it is missing from Menlo Bold; no braille, because it is missing from every
 * monospace font on macOS; and review states carried by SHAPE as well as colour, so accept and reject
 * never depend on hue.
 */
import { displayWidth, fitVisible, fuzzyMatch, highlightVisible, middleOut, sanitizeCell, trimTrailing, wrapVisible } from './textwidth';
import {
  resolveLayout, PANE_SPECS, TAB_SCREEN, BAR_ENTRIES, chromeBottom, statuslineWant,
  type Layout, type PaneBox, type PaneId,
} from './layout';
import { observatoryMasterRows, observatoryDetailRows, observatoryReplyRow } from './observatory-rows';
import type { ObservatoryState, ObservatorySelection } from './observatory';
import { relTime, compactTokens, compactDuration, agentKindLabel, mdInline, mdClassify, mdIsFence, mdIsTableRow, mdIsTableSep, realSessionTitle, type UsageLine } from '@oak-observatory/core';

/**
 * One prose line as ANSI markdown — the CLI's slice (core owns the tokenizer; this is the
 * terminal renderer): bold, italic, `code` tinted, per-line headings/bullets/quotes. Fences
 * render dim (line-based rendering carries no cross-line state on this screen — a code block's
 * body lines still read monospaced, which a terminal gives for free).
 */
function mdAnsiLine(line: string, depth: 'none' | string): string {
  if (depth === 'none') return line; // colour off = markers stay, exactly what a pipe wants
  if (mdIsFence(line)) return `\x1b[2m${line}\x1b[0m`;
  // Tables: agents emit them PRE-PADDED, so keeping each cell's own spacing
  // and restyling the pipes reads aligned in a terminal. The separator draws as a rule; a cell's
  // inline marks still render. No cross-line state — exactly the per-line contract of this fn.
  if (mdIsTableSep(line)) return `\x1b[2m${line.replace(/-/g, '─').replace(/\|/g, '┼').replace(/:/g, '─')}\x1b[0m`;
  if (mdIsTableRow(line)) {
    const cells = line.split('|').map((c) =>
      mdInline(c)
        .map((sp) => {
          let t = sp.t;
          if (sp.c) t = `\x1b[36m${t}\x1b[39m`;
          if (sp.b) t = `\x1b[1m${t}\x1b[22m`;
          if (sp.i) t = `\x1b[3m${t}\x1b[23m`;
          return t;
        })
        .join('')
    );
    return cells.join('\x1b[2m│\x1b[0m');
  }
  const cls = mdClassify(line);
  const spans = mdInline(cls.text)
    .map((sp) => {
      let t = sp.t;
      if (sp.c) t = `\x1b[36m${t}\x1b[39m`;
      if (sp.b) t = `\x1b[1m${t}\x1b[22m`;
      if (sp.i) t = `\x1b[3m${t}\x1b[23m`;
      return t;
    })
    .join('');
  if (cls.kind === 'h') return `\x1b[1m${spans}\x1b[22m`;
  if (cls.kind === 'bullet') return `${'  '.repeat(cls.depth)}• ${spans}`;
  if (cls.kind === 'quote') return `\x1b[2m│\x1b[0m ${spans}`;
  return spans;
}

/**
 * Inline-only markdown for text living INSIDE a dim row (a blob's one-line reasoning): block marks
 * have no line to own there, and the bold reset (SGR 22 clears dim too) re-asserts the dim so the
 * wrapper survives the span.
 */
function mdAnsiInlineDim(text: string, depth: 'none' | string, dim = true): string {
  if (depth === 'none') return text;
  return mdInline(text)
    .map((sp) => {
      let t = sp.t;
      if (sp.c) t = `\x1b[36m${t}\x1b[39m`;
      if (sp.b) t = `\x1b[1m${t}\x1b[22m${dim ? '\x1b[2m' : ''}`;
      if (sp.i) t = `\x1b[3m${t}\x1b[23m`;
      return t;
    })
    .join('');
}
import { Glyphs, ColorDepth, StateKey, AgentState, agentStateFace, agentStateOf, currentTheme, glyphs as defaultGlyphs, inks, paint, promptGround, surfaces, tint, sparkline, riskMark } from './glyphs';
import {
  buildMapTree,
  mapRows,
  renderMapRow,
  mapHeader,
  mapColumnHeader,
  mapConfirmLine,
  renderMapToolbar,
  MapNode,
} from './changemap';
import { boundPatch, renderRichDiff, tallyPatch } from './richdiff';
import { VIEW, resolveZoomedTree, leafPanes, type PaneNode, type ViewId, type Placement } from './tree';
import { usageText, type StatuslineData } from './statusline';
import { highlightShell, highlightSource } from './syntax';
import { REBINDABLE, SortKey, fileExt, fileCategory, isRegexQuery, FILE_CATEGORIES, FILE_CATEGORY_LABEL, type FileCategory } from '@oak-observatory/core';

export type ScreenId = 'edits' | 'claude' | 'map' | 'prompts' | 'tasks' | 'workflows' | 'agents' | 'feed' | 'audit' | 'observations' | 'processes' | 'sessions-nav' | 'session-detail';

/**
 * Every key the dashboard binds, under the NAME `tui/input`'s decoder emits for it.
 *
 * It lives beside the hint ladders below on purpose: what the frame ADVERTISES and what the runtime
 * ANSWERS are two halves of one promise, and they drifted apart three times. `e` was printed in the
 * key row and the help with no handler anywhere; `Tab` and `^D` were written in the runtime as the
 * bytes `'\t'` and `'\x04'` while the decoder hands over `tab` and `d`+ctrl, so those comparisons
 * could never be true. Reading the source would not have caught the last two — running the decoder
 * against this set does, which is what `dash: every advertised key is bound` now does on every run.
 */
export const KEY_BINDINGS: ReadonlySet<string> = new Set([
  // Marks: `'` sets, `` ` `` jumps. Not in REBINDABLE — they open a one-key capture for the mark's
  // NAME, and a rebind onto a letter would make that letter unusable as a name.
  "'", '`',
  // `P` jumps to a file; `N` is previous-match. Both are fixed, for the same reason the mark keys are.
  'P', 'N',
  // STRUCTURAL keys. Not rebindable, on purpose: several are the only way out of a mode, and a
  // settings screen that lets a reader lock themselves into a dashboard has handed them a footgun.
  // Six window keys over six panes — Map and Diff are separate panes (0.10.0).
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'tab', '<', ',', '>', '.', '_', '[', ']',
  'up', 'down', 'left', 'right', 'pgup', 'pgdn', 'enter', 'escape', 'backspace', 'delete', ' ',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  // Answering a confirmation. `r`/`f` answer the Claude-launch wall (`r` is also the refresh verb's
  // fallback below; `f` exists ONLY as that wall's answer).
  'y', 'Y', 'N', 'f',
  // ^C and ^D both arrive named, with `ctrl` set
  'c', 'd',
  // …plus every VERB, at its default key. Derived rather than listed, so a new action or a changed
  // default cannot leave this set behind — the drift these two halves are here to catch.
  ...REBINDABLE.map((r) => r.fallback),
]);

/**
 * The key row, widest first. Every tier is MEASURED against the budget rather than chosen by a
 * hand-written width threshold — a `cols >= 96` once selected a 100-column string fit to `cols - 1`,
 * so every width from 96 to 100 silently cut the last keys and the row read "q qui".
 */
/** The OBSERVATORY tab's own key hints — its session blobs and master/detail panes answer to different
 *  keys than the review dock, so its footer says so. Widest-that-fits, like KEY_HINTS. */
export const OBS_HINTS: readonly string[] = [
  '↑↓ session · ←→ pane · ↵/d/f pin · i reply · esc leave reply · h ↗herdr · r ⌕review · A archived · F1/F2 zoom · Tab OAK tab · ? keys',
  '↑↓ · ←→ · ↵ pin · i reply/esc leave · h/r · A archived · F1/F2 zoom · ?',
  '↑↓ · ↵ pin · i reply/esc leave · h/r · ?',
  'i reply · esc leave · ?',
];
export const HERDR_HINTS: readonly string[] = [
  "herdr's tab bar below starts agents · ctrl+b is herdr's prefix · ctrl+a n/p tabs · ctrl+q ×2 quit",
  "herdr's tab bar below starts agents · ctrl+b is herdr's prefix · ctrl+q ×2 quit",
  "herdr bar starts agents · ^B herdr · ^A n/p · ^Q ×2 quit",
  '^B herdr · ^A n/p · ^Q ×2 quit',
  '^A n/p · ^Q ×2 quit',
];
export const NATIVE_HINTS: readonly string[] = [
  'keys go to the program · ctrl+a n/p or 1-3 OAK tabs · ctrl+a q quit',
  'program keys · ^A n/p OAK · ^A q quit',
  '^A n/p · ^A q quit',
];
export const KEY_HINTS: readonly string[] = [
  'F2-F6 window (twice zooms) · 0-9 edit · Tab next tab · ↑↓ move · ←→ face · space fold · x mark · a keep · u undo · e $EDITOR · b sessions · o options · ? keys',
  'F2-F6 window · Tab · ↑↓ · ←→ · space fold · a/u · e · o · ?',
  '? keys · ^C^C quit',
];

export const SCREENS: { id: ScreenId; label: string }[] = [
  // N15: the one review surface, labelled like the editors' Review tab. The internal id stays
  // 'edits' — it keys cursor/scroll/tab state everywhere and renaming it would break nothing FOR
  // the user while touching dozens of sites.
  { id: 'edits', label: 'Review' },
  { id: 'map', label: 'Map' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'workflows', label: 'Flows' },
  { id: 'agents', label: 'Agents' },
  { id: 'audit', label: 'Audit' },
];

export interface DashState {
  /** The `views --json` payload, or null while the first build is still running. */
  views: Record<string, unknown> | null;
  /** The observatory's selected worker, when a reader has scoped to one. When set (with a tree tab
   *  active), `ask()` fetches THIS session + root instead of the terminal's, so Tasks/Workflows/Processes
   *  show the worker's work — while the repo-wide Workers list, which does not depend on the session, is
   *  unaffected. Null = unscoped (the terminal's own session, as today). */
  scopeWorker?: ObservatorySelection | null;
  observatory?: ObservatoryState;
  /** Set while the reviewed session is read from ANOTHER machine (its label): the Review panes say
   *  where they are reading from, and name the failure (`error`) when that machine does not answer,
   *  rather than a "building…" that never ends. Absent for this machine's sessions. */
  reviewMachine?: { label: string; error?: string };
  /** The reviewed session's facts from its own machine; never the Observatory's local catalog. */
  reviewSession?: Record<string, unknown>;
  /** Set while the reviewed session is on neither this machine nor any saved machine known to hold it:
   *  what the Review panes say instead of reading this machine's store for a session it does not have. */
  reviewFinding?: string;
  /** BSP leaf requesting conversation rows; omitted by single-pane callers. */
  observatoryPane?: string;
  /** Shift+A includes archived sessions (no live pane and no pending edits). */
  allSessions?: boolean;
  /** How the `agents` producer draws: `mini` is the compact sidebar — active agents,
   *  a status dot and a name, nothing else — and undefined is the full Workers board (every agent, its
   *  subagents nested, grouped by agent kind). */
  workersMode?: 'mini';
  /** Per-tree-pane scroll offset (pane id → first visible row), so each pane in a tree tab scrolls
   *  independently, the way each dock pane keeps its own cursor. Clamped on read against the pane's
   *  row count, so a stale offset can never scroll past the end. MAX_SAFE_INTEGER follows a pinned
   *  conversation's tail, including when its initial async load has not returned yet. */
  treeScroll?: Record<string, number>;
  /** The active NATIVE tab's screen — ANSI-styled grid lines from the PTY emulator, computed by the
   *  runtime before each paint (renderDashFrame is pure and cannot spawn). Null on a non-native tab. */
  nativeGrid?: readonly string[] | null;
  /** A one-line status for the native tab (spawning · exited · "node-pty not installed"). */
  nativeNote?: string | null;
  screen: ScreenId;
  cursor: number;
  scroll: number;
  session: string;
  sessionTitle: string;
  filter: string;
  status: string;
  /** A transient, RIGHT-ALIGNED note on the status row — "copied 214 chars to clipboard" — shown
   *  until `until` (compared against `now`, so a snapshot renders itself). The left status is the
   *  durable message; the toast is the confirmation that fades. */
  toast?: { text: string; until: number } | null;
  /** Captured child stderr. Shown, never discarded. */
  error: string | null;
  /** A pending question. `under` names a change-map path when the action is scoped to a whole file or
   *  folder rather than to an id set — the count in `label` is what the reader is answering about. */
  confirm: {
    verb: 'keep' | 'undo' | 'redo' | 'resolve' | 'kill' | 'delete';
    ids: number[];
    under?: string;
    /** True when the question is about the WHOLE session rather than an id set or a path — the map
     *  toolbar's Keep all / Undo all. */
    all?: boolean;
    /** The session the action targets, when it is NOT the one under review — the observatory blob's
     *  resolve/kill act on the SELECTED session, not the terminal's own. */
    session?: string;
    /** delete: how many edits still pending review the question named; the delete purges no more than that. */
    pending?: number;
    /** delete: the newest edit id of the listing that count came from; a pending edit newer than it is refused. */
    seenThrough?: number;
    label: string;
  } | null;
  /** Injected: relTime's reference point, so a snapshot compares one render against itself. */
  now: number;
  /** 'native' | 'fanout' | 'poll' — surfaced, because a degraded watcher must not look healthy. */
  watcherMode: string;
  /** Which change-map folders the reader has opened, by path. */
  open: ReadonlySet<string>;
  /** When set, Traces shows only the edits this prompt produced. The editors scope the edit list to
   *  the selected prompt the same way — a prompt is the unit of work, and reviewing one means
   *  reviewing what it changed, not everything the session ever did. */
  promptScope?: { index: number; ids: ReadonlySet<number> } | null;
  /** A full-body overlay — the diff view, or a picker. Rendered instead of the list.
   *  `cursor` is present only for a picker, where a row can be chosen. */
  overlay: { title: string; lines: readonly string[]; scroll: number; cursor?: number; perm?: boolean } | null;
  /** True while the reader is typing a filter. Distinct from a non-empty `filter`, because the
   *  prompt has to appear the moment the mode opens — an invisible mode that eats keystrokes is
   *  indistinguishable from a frozen dashboard. */
  filterOpen?: boolean;
  /** Narrow the file panes (change map + Traces) to these bare extensions ('ts','py') — the filter
   *  control's extension picker. Empty = every extension. */
  filterExts?: readonly string[];
  /** Narrow the file panes to these type buckets (code/tests/config/docs/styles/other) — the filter
   *  control's file-type picker. Empty = every type. */
  filterCats?: readonly string[];
  /** Open while the reader is choosing filter options (type / extension), with the row cursor. The
   *  `filter` query itself reads as a regex automatically when it carries regex syntax. */
  filterMenu?: { cursor: number } | null;
  /** Digits typed so far toward an edit id, or null. Shown before it acts: this jumps the selection
   *  in a tool where the selection is what `u` reverts, so the reader sees the number they are about
   *  to commit to. Same rule as the filter — a mode that eats keystrokes invisibly is a frozen UI. */
  goto?: string | null;
  /** The three-window layout. Absent renders the original single screen, which is what the
   *  non-TTY one-shot and every existing snapshot still use.
   *
   *  With tabs, this is an ACCESSOR onto `tabs[activeTab].panes` rather than storage of its own —
   *  which is what let real tabs land without touching the ~28 sites that read and rebuild it. */
  panes?: PaneState | null;
  /** The open tabs, left to right. Absent keeps the pre-tab single-workspace behaviour, so every
   *  existing snapshot and the non-TTY one-shot render exactly as before. */
  tabs?: readonly TabState[];
  /** Index into `tabs`. */
  activeTab?: number;
  /** The tab the pointer is resting on, or null. Drives the model tooltip and NOTHING else — a
   *  fact reachable only by hovering would be a fact a `--no-mouse` reader cannot have. */
  hoverTab?: number | null;
  /** The selected edit's diff, for Detail's Diff face. Fetched on demand, never on the poll.
   *  The RAW patch is kept, not pre-rendered lines: the pane re-renders it at whatever width the
   *  layout resolves to, so a resize reflows the diff instead of leaving it fitted to the old one. */
  diffPatch?: string;
  /** `verb` is the tool the agent used — Edit, Write, MultiEdit — and heads the rendered diff. */
  /** `session` names the session the patch was fetched for: a mutation must never act on a diff
   *  that belongs to another one. */
  diffMeta?: { id: number; path: string; added: number; removed: number; verb?: string; session?: string };
  /** How Traces is ordered. Persisted (`prefs.sort`), so it is read back on the first frame rather
   *  than resetting to `recent` every launch. */
  sort?: SortKey;
  /** True while the Diff face leaves long lines long and pans across them instead of wrapping.
   *  Runtime only, unlike `sort` — deliberately, because wrapping is this product's default and
   *  nothing is ever truncated; panning is a per-patch choice, not a setting. */
  noWrap?: boolean;
  /** Edit ids the reader has MARKED, for acting on several at once. Runtime only and per-session: a
   *  mark set that survived a restart would have the reader keep a selection they made yesterday and
   *  cannot see. Empty means "act on the row under the cursor", which is what a/u always did. */
  marked?: ReadonlySet<number>;
  /** Syntax colour on the diff's context lines. Off unless the reader turned it on — the one setting
   *  whose cost is on the render path. */
  syntax?: boolean;
  /** The standing find on the Diff face, so its matches can be MARKED rather than only scrolled to.
   *  Cleared with the find itself — a highlight that outlived the search would mark a patch nobody
   *  searched. */
  findNeedle?: string;
  /** The reader's own keymap, key → action. Present so the frame can NAME a key without hard-coding
   *  a letter: the session bar advertised "s to switch" and went on saying it after `s` became sort,
   *  and would have lied to anyone who rebound it in any case. Absent falls back to the defaults. */
  keys?: ReadonlyMap<string, string>;
  /** Horizontal pan on the Diff face, in columns, while `noWrap` is on.
   *
   *  Its OWN number, not the pane's `scroll`: that one is the vertical position, and a single field
   *  driving both axes means paging down also slides the text sideways, with no way to be at line 200
   *  column 0. Panning off the end of a line must never be able to hide content that no key can bring
   *  back — this product does not truncate — so this is clamped to the widest line on screen. */
  panX?: number;
  /** The ABS path under the MAP pane's cursor — file or folder — derived on every sync, never stored
   *  by hand. The map is the NAVIGATOR: whatever node is selected there
   *  scopes the Traces list to its subtree; the root (or a summary row) means unscoped. */
  mapScope?: string;
  /** A selection kept AFTER the drag released (both surfaces): painted with the same reverse
   *  video the live drag uses, cleared by the next keypress or click. `a` precedes `b`; `clip` is the
   *  text area of the pane it was made in, which it is held to. */
  selSpan?: { a: { row: number; col: number }; b: { row: number; col: number }; clip?: { x0: number; x1: number; y0: number; y1: number } } | null;
  /** The usage row's data (three-line chrome): core.usageLine, refetched by the runtime
   *  on its own cadence. undefined = not fetched yet; null = the fetch failed. */
  usage?: UsageLine | null;
  /** BOTH providers' 5h/wk/mo windows, for the bottom status readout (item 4, 2026-09-16). */
  usageBoth?: import('@oak-observatory/core').UsageBrief | null;

  ambientSince?: number;
  /** Sessions that FINISHED (active→idle) while not under review, un-cleared until the reader
   *  looks at them — the herdr seen-bit: done ≠ idle. Runtime state, like a cursor. */
  doneUnseen?: ReadonlySet<string>;
  /** Patches for the edits whose feed bubbles are open, keyed by edit id. Fetched on demand by the
   *  runtime (the same backend.diff the Diff pane uses) and held here so the renderer stays pure. */
  editPreviews?: Readonly<Record<number, string>>;
  /** The session recap (core.recapOf) and WHERE it came from — an unlabelled recap reads as a
   *  considered summary when it may be the session's title or the last thing the agent said. */
  recap?: string;
  recapSource?: string;
  /** The workspace label the nav bar shows (~-abbreviated cwd) — identity belongs in the nav, once. */
  cwdLabel?: string;
}

/** Per-pane reader state. Each pane carries its OWN cursor: with three lists on screen there are
 *  three cursors and only one of them is what `a`/`u` will act on. In a tool that reverts code,
 *  getting that wrong is a data-loss bug, so the selection is never shared between panes. */
export interface PaneState {
  minimized: ReadonlySet<PaneId>;
  /** Panes this tab does not have at all (review has no Agent/Dashboards). Absent, not folded. */
  hidden?: ReadonlySet<PaneId>;
  zoom: PaneId | null;
  focus: PaneId;
  tab: Readonly<Partial<Record<PaneId, number>>>;
  cursor: Readonly<Partial<Record<PaneId, number>>>;
  scroll: Readonly<Partial<Record<PaneId, number>>>;
  /** Widths the reader set by dragging a seam. Empty until they do. */
  sizes?: Readonly<Partial<Record<PaneId, number>>>;
}

/**
 * What a tab is.
 *
 * A DOCK tab owns a `PaneState` — `{minimized, zoom, focus, tab, cursor, scroll, sizes}`, exactly
 * `LayoutRequest` plus per-pane cursor and scroll. Switching tabs swaps which one feeds
 * `resolveLayout`, so a dock tab is state multiplexing and the dock engine is untouched.
 *
 * A tab MAY instead carry a `root`: an explicit BSP arrangement the dock engine cannot express —
 * observatory's four simultaneous panes, a reader-created split, a native-CLI tab. Reproducing
 * `resolveLayout`'s ~250 lines of dock policy inside a tree BYTE-FOR-BYTE was measured and rejected,
 * so the tree does not replace it; `root` is OPTIONAL. Absent, the dock engine renders `panes` exactly
 * as before. Present, `resolveTree`/`renderTreeFrame` render the tree. Only one is consulted per tab,
 * so the two cannot disagree and the surface that already works does not move.
 */
export type TabKind = 'panes' | 'native';

export interface TabState {
  id: string;
  kind: TabKind;
  /** Reader-set name; null means auto-named and renders DIM, so a deliberate name stands out. */
  name: string | null;
  /** AUTO-TITLE: the session's own title when the tab is linked to one — a
   *  native tab named after the work running in it, the agent tab suffixed with what it drives. Set
   *  by the app from the sessions payload; never persisted. */
  autoTitle?: string | null;
  /** The workspace. For `native` tabs this is still present but unused — a tab kind that changes
   *  the render path must not also change the state shape, or every accessor grows a branch. */
  panes: PaneState;
  /** Review pins the session it reviews; Observatory does not pin one. */
  session?: string;

  agent?: string;
  /** The attached session's model, already friendly (`Opus 5`). What hover reveals; absent means
   *  the tab has no session and therefore shows NO tooltip rather than an empty one. */
  model?: string | null;
  /** The attached session's phase and liveness, for the tab's state glyph. Filled by the runtime
   *  from the same payload the Workers panel reads, so a tab and a worker row cannot disagree. */
  phase?: string;
  active?: boolean;
  /** An explicit BSP arrangement. Absent -> the dock engine renders `panes` (the surface is untouched).
   *  Present -> `renderTreeFrame` renders the tree — observatory's four panes, a reader split, a native
   *  tab. `panes` stays present but unconsulted for rendering, so no accessor grows a branch. */
  root?: PaneNode;
  /** The focused tree pane's id when `root` is set — the tree's analogue of `panes.focus`. */
  treeFocus?: string;
  /** When set (a pane id), that pane fills the whole tree body — the tree's zoom, toggled by the
   *  leader's `z`. Cleared by any structural change (close/split). */
  treeZoom?: string | null;
  /** A `native` tab's command line — the CLI it runs under a PTY (`['bash']`, `['claude','--resume',id]`).
   *  Spawned lazily by the runtime; the tab shows an empty state until then, and "exited" after. */
  command?: readonly string[];
  /** Session link and child process for a local native tab. */
  link?: string;
  pid?: number | null;
}

export interface FrameOpts {
  cols: number;
  rows: number;
  color: ColorDepth | boolean;
  glyphs?: Glyphs;
}

/** One body line, the edit ids it resolves to, and what it points at. */
export interface DashRow {
  cells: string;
  ids: number[];
  /** A stable identity, so a live refresh can keep the same thing selected as rows move. */
  key: string;
  /** For the map: the tree path this row can open or close. */
  openPath?: string;
  /** A continuation of the row above — the same subject, not a new one. The cursor skips it, so
   *  j/k moves between EDITS rather than between lines. */
  cont?: boolean;
  /** The worker this row selects, for the observatory's worker→scope. Present on Workers rows (and
   *  their subagent children, pointing at the parent worker); a click reads it to set the scope.
   *  `agentId` marks a spawn-subagent row in the DETAIL pane: a click drives the whole SESSION's live
   *  feed (which carries that spawn's activity), not a per-spawn feed — it is the discriminator that
   *  routes the click, not a separate drive target. */
  scope?: ObservatorySelection & { agentId?: string };
  /** Clickable action buttons on this row — the session blob's feed/review/resolve/kill.
   *  `x`/`w` are offsets into `cells`, so paint and hit-test read the same geometry. */
  buttons?: { action: string; x: number; w: number }[];
  /** Where this row's text is, when it is not the whole row: its first and last column in `cells`, or
   *  null for a row with none. A boxed prompt's sides and edges are drawn, not written, so a drag bands
   *  and copies the words inside, as a Review pane's drag leaves its pane's box out. */
  copy?: [number, number] | null;
}

/** The rule between the panes and the bottom chrome. Same shape the Agent screen's footer uses,
 *  so the two surfaces cannot drift apart one dash at a time. */
export function chromeDivider(cols: number, g: Glyphs, depth: ColorDepth): string {
  const line = g.rule.repeat(Math.max(0, cols));
  return depth === 'none' ? fitVisible(line, cols) : `\x1b[2m${fitVisible(line, cols)}\x1b[0m`;
}

/**
 * A session's runtime state → the SHIPPED statusline's data model (`StatuslineData`), the bridge the
 * shell statusline (statusline.ts, byte-identical to `~/.claude/statusline.sh`) renders from. The
 * terminal app's OWN bottom bar is the compact per-provider readout now (see `statuslineFor`), but
 * this mapping stays the single, tested place that turns `state.usage` + the session row into the
 * shipped statusline — used by the shell-parity tests and available to anything that wants to draw
 * Claude Code's own statusline for a session. Where a datum is genuinely absent, the caller's
 * placeholder says so rather than a zero pretending to be a measurement.
 */
export function statuslineDataFor(state: DashState): StatuslineData {
  const u = state.usage;
  const rows0 = view<{ sessions?: Record<string, unknown>[] }>(state, 'sessions')?.sessions;
  const sess = state.reviewMachine && state.reviewSession?.id === state.session ? state.reviewSession
    : Array.isArray(rows0) ? rows0.find((s) => String(s?.id ?? '') === state.session) : undefined;
  const d = new Date(state.now);
  const two = (n: number) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const data: StatuslineData = {
    now: state.now,
    clock: `${two(d.getHours())}:${two(d.getMinutes())}`,
    date: `${MON[d.getMonth()]} ${two(d.getDate())}`,
    branch: u?.branch || undefined,
    cwdLabel: state.cwdLabel || undefined,
    title: realSessionTitle(str(sess?.title)) || state.sessionTitle || undefined,
    model: str(sess?.model) || undefined,
    effort: str(sess?.effort) || undefined,
    thinking: u?.thinking ?? undefined,
    outputStyle: u?.outputStyle || undefined,
    tokensIn: u?.tokensIn ?? undefined,
    tokensOut: u?.tokensOut ?? undefined,
    tokensCacheRead: u?.tokensCacheRead ?? undefined,
    durationMs: num(sess?.durationMs) || undefined,
    // ctx PREFERS the session's own usage (`u.ctx`) — the exact figure claude's own status line shows



    // whose session has no statusline/usage figure yet.
    ctxPct: u?.ctx?.pct ?? null,
    ctxUsed: u?.ctx?.tokens ?? null,
    ctxSize: u?.ctx?.size ?? null,
    fivePct: u?.fiveHourPct ?? null,
    fiveResetMs: u?.fiveReset ?? null,
    fiveEst: u?.fiveTokens ?? null,
    fiveTotal: u?.fiveTotal ?? null,
    fiveMeasured: u?.localWindows?.find((w) => /5h/i.test(w.label))?.tokens ?? null,
    weekPct: u?.weekPct ?? null,
    weekResetMs: u?.weekReset ?? null,
    weekEst: u?.weekTokens ?? null,
    weekTotal: u?.weekTotal ?? null,
    weekMeasured: u?.localWindows?.find((w) => /wk|week|7d/i.test(w.label))?.tokens ?? null,
    fablePct: u?.fablePct ?? null,
    fableResetMs: u?.fableReset ?? null,
    fableLabel: u?.fableLabel ?? null,
    fableEst: u?.fableTokens ?? null,
    fableTotal: u?.fableTotal ?? null,
    fableReads: u?.fableReads ?? null,
  };
  if (u?.fiveMeasuredAll) data.fiveMeasured = u.fiveMeasuredAll;
  if (u?.weekMeasuredAll) data.weekMeasured = u.weekMeasuredAll;
  data.usageScope = u?.usageScope ?? 'here';
  if (u?.rollingLimits === false && u?.cost) {
    data.fiveCost = u.cost.five;
    data.weekCost = u.cost.week;
  }
  if (u?.weekCost) data.weekCost = u.weekCost;
  data.weekCostTotal = u?.weekCostTotal ?? null;
  data.monthCost = u?.monthCost ?? null;
  data.monthCostTotal = u?.monthCostTotal ?? null;
  data.monthTokens = u?.monthTokens ?? null;
  data.monthTokensTotal = u?.monthTokensTotal ?? null;
  data.monthResetMs = u?.monthReset ?? null;
  data.monthReads = u?.monthReads ?? null;
  data.fiveReads = u?.fiveReads ?? null;
  data.weekReads = u?.weekReads ?? null;
  data.noWindows = u?.rollingLimits === false;
  data.promo = u?.promo ?? null;
  const uu = u as {
    creditBalance?: number | null;
    creditsUnlimited?: boolean;
    spendLimit?: number | null;
    spendUsed?: number | null;
    usageFrom?: 'claude' | 'codex';
  } | null | undefined;
  if (uu?.spendLimit) {
    data.spendLimit = uu.spendLimit;
    data.spendUsed = uu.spendUsed ?? null;
  }
  data.usageFrom = uu?.usageFrom;
  if (uu?.creditsUnlimited) data.creditsUnlimited = true;
  else if (uu?.creditBalance !== undefined && uu?.creditBalance !== null) data.credits = uu.creditBalance;
  const age = u?.cachedAtMs ? state.now - u.cachedAtMs : 0;
  if (u?.statuslineCache && age > ((u as { staleMs?: number }).staleMs ?? 300_000)) data.staleAgeMs = age;
  return data;
}

/**
 * The terminal app's bottom status bar: the compact per-provider usage readout (see the function
 * below). Kept for the doc trail — the rich shipped-statusline rendering moved to the shell + the
 * `statuslineDataFor` bridge above.
 */
export function statuslineFor(state: DashState, cols: number, g: Glyphs, depth: ColorDepth, want: number): string[] {
  if (want <= 0) return [];
  // The bottom bar is the compact per-provider usage readout now: claude and gpt,
  // each `5h · wk · mo` in the same painted style as the shell statusline's quota gauges. The identity
  // and session detail this row used to carry live in the tab bar and the session header; the ctx
  // window it also carried moved to the Agent tab's prompt box. `usageBoth` is BOTH providers at once
  // (state.usage is only the active session's), refreshed on the same 60s throttle.
  const themed = currentTheme() !== 'default';
  const b = state.usageBoth;
  const grey = (t: string): string => (depth === 'none' ? t : `\x1b[2m${t}\x1b[0m`);
  const orange = (t: string): string => (depth === 'none' ? t : `\x1b[38;5;215m${t}\x1b[0m`);
  // gpt's icon + label are BLUE, the way claude's are orange — its own colour, not
  // the default white/grey the windows use.
  const blue = (t: string): string => (depth === 'none' ? t : `\x1b[38;5;39m${t}\x1b[0m`);
  const sep = ` ${grey('·')} `;
  const fit = (s: string): string => fitVisible(pad(sanitizeCell(s), cols), cols);
  const pad2 = (lines: string[]): string[] => {
    if (lines.length >= want) return lines.slice(0, want);
    while (lines.length < want) lines.unshift(fit(''));
    return lines;
  };
  if (!b) return pad2([fit(grey('usage —'))]);
  // ONE combined readout now: claude and gpt
  // together on a SINGLE line, as BAR-LESS `5h: N% reset` chips, so both providers fit a line the
  // gauge bars never could. Both editors' status bars carry that chip shape and this exact order —
  // `5h · wk · mo` (VS Code `setWin`/`claudeWin`, JetBrains `UsageWidget.apply`). The account's
  // per-model weekly cap is not a chip on any of the three; the editors name it in
  // their status-bar tooltips and Stats panels. When the line overruns the terminal it does NOT grow
  // the chrome — it compacts, dropping the reset times first (the percentages are the point), then
  // fit-truncates as a last resort. So the block is exactly one row at every width; the old fixed
  // 3-line statusline's leftover blank space is gone.
  // A window with no share AND no token count is DROPPED, not shown as `label —` (a plan without
  // the window has nothing to show there — codex's prolite plan reports no 5-hour window, only
  // weekly). The editors already hide such a window (VS Code's setWin, JB's chunk); this matches them.
  const win3 = (w: { five: import('@oak-observatory/core').BriefWindow; week: import('@oak-observatory/core').BriefWindow; month: import('@oak-observatory/core').BriefWindow }, compact: boolean): string => {
    const chips: string[] = [];
    const add = (label: string, x: import('@oak-observatory/core').BriefWindow): void => {
      if (x.pct != null || x.tok != null) chips.push(usageText(label, x, depth, themed, state.now, !compact));
    };
    add('5h', w.five);
    add('wk', w.week);
    add('mo', w.month);
    return chips.join(sep);
  };
  // No Claude window to show: none carries a share or a token count — `win3`'s own rule. A plan with no
  // quota (Enterprise, API) still measures the month's tokens, and dropping the whole group for it
  // whenever gpt had data hid them.
  const noClaude = [b.claude.five, b.claude.week, b.claude.month].every((x) => x.pct == null && x.tok == null);
  // Claude leads when it has data, OR when there is no gpt data either — then it carries the "install
  // the statusline" hint. A codex-only machine with gpt numbers is never nagged about a statusline it
  // does not use (the whole point of the second provider). The two providers are divided by a bar.
  const build = (compact: boolean): string => {
    const parts: string[] = [];
    if (!noClaude || !b.gpt) {
      const c = win3(b.claude, compact);
      // The install hint only without a cache: a window reset leaves an installed status line with nothing to show yet.
      parts.push(c ? `${orange('✳ claude')} ${c}` : `${orange('✳ claude')} ${grey(state.usage?.statuslineCache ? '—' : 'run oak statusline')}`);
    }
    if (b.gpt) parts.push(`${blue('⬡ gpt')} ${win3(b.gpt, compact)}`);
    return parts.join(`  ${grey('|')}  `);
  };
  const full = build(false);
  const line = displayWidth(full) <= cols ? full : build(true); // drop reset times to keep it one line
  return pad2([fit(line)]);
}

/** The status row with its transient toast flush right — or just the status when none is live.
 *  Both fitted by display width; on a frame too narrow for both, the toast wins (it is the newer
 *  fact and the shorter one). */
export function statusWithToast(left: string, state: DashState, cols: number): string {
  const toast = state.toast && state.now < state.toast.until ? state.toast.text : '';
  if (!toast) return fitVisible(left, cols);
  const tw = displayWidth(toast);
  if (tw + 2 >= cols) return fitVisible(toast, cols);
  const leftFit = fitVisible(left, cols - tw - 2);
  return leftFit + ' '.repeat(Math.max(1, cols - displayWidth(leftFit) - tw)) + toast;
}

/**
 * Where the selected row WENT after a live refresh rebuilt the list.
 *
 * `key` is each row's stable identity — declared on DashRow for exactly this, and this is the
 * function that finally honours it. Position is not an identity: a refreshed payload re-sorts by
 * recency, files gain and lose header rows, and the row at any INDEX is routinely a different
 * subject than it was one tick ago. A cursor that survives the swap as a bare index lands on that
 * different subject, and everything keyed off "the selected row" — the Detail diff above all —
 * silently re-picks. Falls back to the clamped old index when the row is genuinely gone (resolved
 * away, filtered out), which is the same answer clampCursor gives.
 */
export function reanchorIndex(prev: readonly DashRow[], at: number, next: readonly DashRow[]): number {
  const key = prev[at]?.key;
  if (key !== undefined) {
    const kept = next.findIndex((r) => r.key === key);
    if (kept >= 0) return kept;
  }
  return Math.min(Math.max(0, at), Math.max(0, next.length - 1));
}

/** What the Detail pane should do about the traces selection — the decision `syncDetailDiff`
 *  executes, pure so the pin can be asserted without a runtime. */
export type DiffFollow =
  | { act: 'keep' } // the selection did not change — nothing to do
  | { act: 'pin' } // zoomed on a diff whose row vanished — hold the face; esc or a new pick releases
  | { act: 'clear' } // nothing selected — the map is the honest face
  | { act: 'fetch'; id: number }; // a newly selected edit — go get its diff

/**
 * Follow the traces selection with the Detail diff — without ever un-choosing a zoom.
 *
 * The drill-in gesture zooms Detail onto an edit's diff, and the drill-in itself triggers a views
 * refresh. When that refresh rebuilt the rows, the old index could land on a non-edit row, compute
 * "nothing selected", and demote the zoomed Detail back to the map — a fullscreen diff that
 * flashed and reverted. Two rules close it: the cursor re-anchors by key across every swap
 * (`reanchorIndex`), and while Detail is ZOOMED on a diff, losing the row PINS the face instead of
 * clearing it — the zoom is a mode the reader chose, and only esc or picking another row ends it.
 */
export function followTracesDiff(
  rows: readonly DashRow[],
  cursor: number,
  picked: boolean,
  zoomedOnDetail: boolean,
  wanted: number
): DiffFollow {
  const row = picked ? rows[cursor] : undefined;
  const id = row && row.ids.length === 1 ? row.ids[0] : -1;
  if (id === wanted) return { act: 'keep' };
  if (id < 0) return zoomedOnDetail && wanted >= 0 ? { act: 'pin' } : { act: 'clear' };
  return { act: 'fetch', id };
}

/**
 * A row's human name, or a NAMED fallback — never a bare identifier.
 *
 * Every dashboard here answers "what is this thing", and an id answers it for nobody: the Tasks pane
 * listed nineteen rows of `a3f21c...` because it read `content`/`title`, which the plan harness stopped
 * emitting when tasks gained `subject`. The editors were already right — VS Code reads `t.subject` and
 * JetBrains reads it with a `task #N` fallback — so this was the terminal drifting away from them, and
 * the fallback below is deliberately the shape JetBrains uses.
 *
 * `what` names the KIND, so an unnamed row still says what it is rather than showing a digest. The id
 * is trimmed because a 40-hex sha in a pane column is noise wearing the costume of information.
 */
function named(candidates: readonly (string | undefined)[], what: string, id: string): string {
  for (const c of candidates) if (c && c.trim()) return c.trim();
  const short = id.length > 8 ? id.slice(0, 8) : id;
  return short ? `${what} ${short}` : `(unnamed ${what})`;
}

function view<T>(state: DashState, name: string): T | null {
  const v = state.views?.[name];
  return v === undefined || v === null ? null : (v as T);
}
/** The current session's agent kind ('claude' | 'codex' | an adapter id), from the same row —
 *  what decides which adapter a hooks-only session drives (a codex transcript must never spawn
 *  the claude adapter just because hooks captured it). Empty when the row has not loaded. */
export function sessionAgent(state: DashState): string {
  const rows = view<{ sessions?: { id?: unknown; agent?: unknown }[] }>(state, 'sessions')?.sessions;
  const row = Array.isArray(rows) ? rows.find((s) => String(s?.id ?? '') === state.session) : undefined;
  return typeof row?.agent === 'string' ? row.agent : '';
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** The basename plus its immediate folder — enough to identify a file without ellipsising a path. */
/**
 * A path shortened to what identifies it, without ever losing a segment the reader needs.
 *
 * This used to keep only the last two segments at EVERY width, so `packages/core/src/dashframe.ts`
 * and `packages/cli/src/dashframe.ts` both rendered as `src/dashframe.ts` — two different files,
 * indistinguishable, in a tool whose job is deciding whether to revert one of them.
 *
 * It now drops only the ABSOLUTE prefix (everything up to and including the workspace root, which is
 * the same for every row and therefore identifies nothing) and returns the rest whole. Panes wrap it.
 */
function tail(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return p;
  // An absolute path carries a machine-specific head. Keep from the first segment that varies —
  // in practice the repo directory — rather than a fixed count from the end.
  if (/^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) {
    const marker = parts.findIndex((x) => x === 'packages' || x === 'src' || x === 'docs' || x === 'scripts' || x === 'test');
    if (marker > 0) return parts.slice(marker - 1).join('/');
    return parts.slice(-3).join('/');
  }
  return parts.join('/');
}

/** Just the filename — the last path segment. The Traces pane leads with this;
 *  its caller falls back to the full `tail` when two file groups share a basename, so
 *  the disambiguation `tail` exists for is never actually lost. */
function base(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Pad to a DISPLAY width — `padEnd` counts escape bytes and would over-pad every tinted cell. */
function pad(s: string, w: number): string {
  const gap = w - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/**
 * The Prompts row's one action cell — its label and its GEOMETRY, in one place.
 *
 * The renderer draws from this and the mouse resolves clicks through it, which is the only way the
 * glyph and the pointer agree about where "review" is — the same contract `mapRowActions` keeps for
 * the change map's per-row buttons. The x is fixed: every column before the cell is fixed-width
 * (`#NNNN ` 6 · relTime 8+1 · count 4 · ` edits  ` 8), so the cell cannot drift with content.
 */
const PROMPT_ACT = '[review]';
const PROMPT_ACT_ON = '▸review ';
const PROMPT_ACT_X = 27;
export function promptRowActions(inner: number): { action: 'review'; x: number; w: number }[] {
  // Too narrow to draw the cell AND any title after it → the cell is not drawn, so it is not clickable.
  if (inner < PROMPT_ACT_X + displayWidth(PROMPT_ACT) + 9) return [];
  return [{ action: 'review', x: PROMPT_ACT_X, w: displayWidth(PROMPT_ACT) }];
}

function statusGlyph(s: string, g: Glyphs): string {
  return s === 'kept' ? g.kept : s === 'undone' ? g.undone : g.pending;
}

/**
 * A session blob's status glyph, ANIMATED when the session is live. A spinner while it
 * works, a slower pulse while it is blocked on a human, the static face otherwise. It cycles off `now`,
 * so the runtime's animation tick makes it move; a coarser `now` (the row memo) just slows the cycle, it
 * never breaks it. The ASCII tier gets a spinner it can actually draw.
 */
export function animGlyph(st: AgentState, now: number, g: Glyphs, depth: ColorDepth): string {
  const rich = g.rule !== '-';
  const pick = (frames: readonly string[], ms: number, key: StateKey): string => {
    const gl = frames[Math.floor(Math.max(0, now) / ms) % frames.length];
    return depth === 'none' ? gl : tint(gl, key, depth);
  };
  if (st === 'working') return pick(rich ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'] : ['|', '/', '-', '\\'], 120, 'live');
  if (st === 'blocked') return pick(rich ? ['◐', '◓', '◑', '◒'] : ['*', '+', 'x', '+'], 380, 'pending');
  const face = agentStateFace(st, g);
  return depth === 'none' ? face.glyph : tint(face.glyph, face.key, depth);
}

/**
 * The rows for a screen, and what each one means for keep/undo.
 *
 * Selection semantics are defined per screen rather than assumed: rows are not all the same kind of
 * thing, and a key that means "one edit" on one screen and "every edit in the session" on another is
 * how a reviewer destroys work they meant to keep.
 */
/**
 * ONE FRAME BUILDS THE SAME ROWS EIGHT TIMES, so it builds them once.
 *
 * `rowsFor` enumerates EVERY row of the session — 2,730 of them for the 546-file session this product
 * is sized against — and a pane draws about 43. That would be tolerable once. It is not once: measured
 * at **8 calls per frame**, because `paneVisible` and `paneRowCount` each need the list for every pane,
 * and the frame is re-rendered on every keystroke. 0.75 ms × 8 on a session that big.
 *
 * Keyed on what this function actually READS — the payload, the screen, the filter, the sort, the
 * prompt scope, the open folders, and the width. Not on `cursor` or `scroll`, which is the whole point:
 * moving the selection and scrolling are the two things a reader does continuously, and neither changes
 * a single row. `views`, `promptScope` and `open` are compared by IDENTITY, which is sound because the
 * app replaces all three rather than mutating them (`state.open = new Set(state.open)`).
 *
 * Small and fixed rather than unbounded: the callers differ by screen and width, so a handful of
 * entries covers a frame, and a Map that grew per keystroke would be the leak this is meant to avoid.
 */
const rowsMemo = new Map<string, { views: unknown; scope: unknown; open: unknown; rows: DashRow[] }>();
/** A stable token per glyph SET, for the key. The sets are shared constants, so identity is the right
 *  comparison; this only turns that identity into something a string key can hold. */
const glyphIds = new WeakMap<Glyphs, number>();
let glyphSeq = 0;
const glyphId = (g: Glyphs): number => {
  let id = glyphIds.get(g);
  if (id === undefined) glyphIds.set(g, (id = ++glyphSeq));
  return id;
};

export function rowsFor(state: DashState, cols = 100, g: Glyphs = defaultGlyphs(), depth: ColorDepth = 'none'): DashRow[] {
  // The detail memo is isolated from master animation buckets AND unrelated views object churn.
  if (state.screen === 'session-detail') return observatoryDetailRows(state, cols, g, depth);
  if (state.screen === 'sessions-nav') return observatoryMasterRows(state, cols, g, depth);
  // `now` is in the key, bucketed to the SECOND. Rows carry ages — `relTime` renders "5s ago" — so a
  // memo that ignored it would freeze every timestamp on screen, which is a correctness bug dressed as
  // a speed-up. One second is `relTime`'s own finest granularity, so this is the coarsest bucket that
  // cannot be seen: keystrokes within a second are free, and the rebuild happens exactly when a
  // rendered age would have changed anyway.
  // Only width-dependent producers include cols. Observatory's master and conversation pane
  // returned above: the detail has a separate session/cursor memo, never this clock bucket.
  const colsKey = state.screen === "map" || state.screen === "prompts" || state.screen === "claude" ? cols : 0;
  const key = `${state.screen}\u001f${colsKey}\u001f${depth}\u001f${glyphId(g)}\u001f${state.filter}\u001f${state.sort ?? ''}\u001f${state.mapScope ?? ''}\u001f${state.workersMode ?? ''}\u001f${state.allSessions ? 'all' : ''}\u001f${Math.floor(state.now / 1000)}`;
  const hit = rowsMemo.get(key);
  if (hit && hit.views === state.views && hit.scope === state.promptScope && hit.open === state.open)
    return hit.rows;
  const rows = rowsForUncached(state, cols, g, depth);
  // Bounded: one entry per (screen, width, depth, filter, sort) a frame actually asks for. A filter
  // being typed churns the key, so the map is cleared rather than grown past a frame's worth.
  if (rowsMemo.size > 24) rowsMemo.clear();
  rowsMemo.set(key, { views: state.views, scope: state.promptScope, open: state.open, rows });
  return rows;
}

function rowsForUncached(state: DashState, cols = 100, g: Glyphs = defaultGlyphs(), depth: ColorDepth = 'none'): DashRow[] {
  const f = state.filter.toLowerCase();
  /**
   * FZF'S RULE, not `includes`: `pcsi` finds `packages/core/src/index.ts`.
   *
   * Every filtered pane goes through this one predicate, so the Traces list, the change map, the
   * prompts, the actions and the processes all narrow the same way — a filter that meant one thing on
   * one pane and another next door would be worse than no filter. `fuzzyMatch` tries a contiguous hit
   * FIRST, so a literal query like `.ts` behaves exactly as it always did and never loses to a
   * scattered match.
   */
  // The query matches fuzzily (scattered letters) by default, and as a case-insensitive regex the
  // moment it carries regex syntax — there is no mode to toggle. A pattern that looks like a regex but
  // does not compile falls back to fuzzy, so a half-typed `(` still narrows rather than emptying.
  let rx: RegExp | null = null;
  if (state.filter && isRegexQuery(state.filter)) {
    try {
      rx = new RegExp(state.filter, 'i');
    } catch {
      rx = null; // fall back to fuzzy
    }
  }
  const keep = (s: string) => (rx ? rx.test(s) : !f || fuzzyMatch(s, f) !== null);
  // The file-type / extension narrowing (the filter control's pickers), for the file panes only.
  const extsSet = new Set(state.filterExts ?? []);
  const catsSet = new Set(state.filterCats ?? []);
  const fileSpecOk = (rel: string) =>
    (extsSet.size === 0 || extsSet.has(fileExt(rel))) && (catsSet.size === 0 || catsSet.has(fileCategory(rel)));
  const rows: DashRow[] = [];

  if (state.screen === 'edits') {
    /**
     * GROUPED BY FILE, like the editors' trees.
     *
     * Every edit used to print its own full path, so a file touched eight times produced eight
     * identical headers and the pane read as a wall of repeated paths — `packages/cli/src/index.ts`
     * three times in one screenful, with the actual edits scattered between the copies. One header
     * per file now carries the path and what that file is waiting on; its edits nest beneath it.
     *
     * File order is the reader's, via `state.sort`. The default is the payload's first appearance —
     * newest-first, as the list already arrives — so the pane still reads chronologically at the top
     * rather than re-sorting under anyone who has not asked for it.
     */
    const scope = state.promptScope;
    const byFile = new Map<string, { label: string; edits: Record<string, unknown>[] }>();
    // Chains that go nowhere (created then deleted, or put back) are not rows — they are one footer
    // row below, whose ids are all of them, so the ordinary `a` keeps the lot.
    const cancelledIds: number[] = [];
    let cancelledUnits = 0;
    for (const e of arr(view<{ edits?: unknown[] }>(state, 'list')?.edits)) {
      const file = str(e.file);
      if (!keep(file)) continue;
      if (scope && !scope.ids.has(num(e.id))) continue;
      // The MAP is the navigator: a file or folder picked in Detail's map
      // region scopes this list to it. A folder matches its subtree; esc clears. Path-prefix on the
      // rendered rel/abs, boundary-checked so `src/util` never swallows `src/utils`.
      if (state.mapScope) {
        const s = state.mapScope;
        if (!(file === s || file.startsWith(s.endsWith('/') ? s : `${s}/`))) continue;
      }
      if (e.cancelled === true) {
        // Only the PENDING ones are still a decision, so only they earn a place in the footer's
        // count and in the ids `a` dismisses; an already-decided chain just leaves the list. (The
        // payload carries `members` on exactly those, which is what makes this one test.)
        const members = Array.isArray(e.members) ? e.members : [];
        if (members.length) {
          cancelledUnits++;
          for (const m of members) cancelledIds.push(num(m));
        }
        continue;
      }
      const label = str(e.rel) || tail(file);
      let g0 = byFile.get(file);
      if (!g0) byFile.set(file, (g0 = { label, edits: [] }));
      g0.edits.push(e);
    }
    /**
     * …and here is where that choice is applied, to the FILE groups rather than to the edits.
     *
     * A session is read one file at a time — the edits inside a file are its history and stay in id
     * order, so "next edit" means the same thing under every ordering. Only the order the files come
     * at the reader changes: `time` puts the most recently edited on top (the default), `name` sorts
     * the paths A→Z.
     */
    const newestOf = (grp: { edits: Record<string, unknown>[] }): number =>
      grp.edits.reduce((m, e) => Math.max(m, num(e.ts)), 0);
    const groups = [...byFile.entries()].filter(([file]) => fileSpecOk(file));
    const byPath = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    // Four directions, mirroring core.compareBySort (the file panes and the map order the same way).
    if (state.sort === 'name') groups.sort(byPath);
    else if (state.sort === 'name-desc') groups.sort((a, b) => byPath(b, a));
    else if (state.sort === 'time-asc') groups.sort((a, b) => newestOf(a[1]) - newestOf(b[1]) || byPath(a, b));
    else groups.sort((a, b) => newestOf(b[1]) - newestOf(a[1]) || byPath(a, b)); // 'time' (default)
    // The header leads with the FILENAME — but only where it is unambiguous. Two
    // groups sharing a basename (two `index.ts`) both keep their full path, the exact case `tail`
    // guards, so shortening never makes two different files read as one.
    const baseCount = new Map<string, number>();
    for (const [file] of groups) baseCount.set(base(file), (baseCount.get(base(file)) ?? 0) + 1);
    const shownLabel = (file: string, label: string): string => ((baseCount.get(base(file)) ?? 0) > 1 ? label : base(file));
    for (const [file, grp] of groups) {
      const pending = grp.edits.filter((e) => str(e.status) === 'pending').length;
      // The file's own state: still waiting if ANY of its edits is, else settled. One glyph, one
      // meaning — the same rule a folder row on the change map follows.
      const fileKey: 'pending' | 'kept' = pending ? 'pending' : 'kept';
      const n = grp.edits.length;
      /**
       * COLLAPSED BY DEFAULT — the change map's own open-set idiom (`state.open`, stable keys,
       * replaced never mutated), applied to file groups. A 69-edit file used to paint 69 rows; it
       * is one header row now until the reader opens it. The key namespace is `edits:` so a file
       * group and a map folder can never collide in the one set.
       *
       * A FOLDED header carries what the open list would have shown — the aggregates a reader
       * decides from (net churn, freshest age) — because a summary that loses information is a
       * cut, and this product wraps instead of cutting.
       */
      const openKey = `edits:${file}`;
      const open = state.open.has(openKey);
      const added = grp.edits.reduce((s, e) => s + num(e.added), 0);
      const removed = grp.edits.reduce((s, e) => s + num(e.removed), 0);
      const newest = grp.edits.reduce((m, e) => Math.max(m, num(e.ts)), 0);
      const count =
        `${n} edit${n === 1 ? '' : 's'}${pending ? ` · ${pending} pending` : ''}` +
        (open ? '' : ` · +${added} −${removed} · ${relTime(newest, state.now)}`);
      // TWO LINES per file: the filename leads, and its counts/±/age ride the line below, dim, indented
      // under it. Both rows address EVERY edit in the file, so `a`/`u` and the fold toggle work on either.
      rows.push({
        ids: grp.edits.map((e) => num(e.id)),
        key: `f${file}`,
        openPath: openKey,
        cells: `${tint(open ? g.open : g.closed, 'undone', depth)} ${tint(statusGlyph(pending ? 'pending' : 'kept', g), fileKey, depth)} ${shownLabel(file, grp.label)}`,
      });
      rows.push({
        ids: grp.edits.map((e) => num(e.id)),
        key: `f${file}:m`,
        openPath: openKey,
        cont: true,
        cells: `     ${tint(count, 'undone', depth)}`,
      });
      if (!open) continue;
      for (const e of grp.edits) {
        const id = num(e.id);
        // Colour is for recognition — the eye finds the pending rows without reading. Meaning still
        // rests on the glyph, so this is all still legible with colour off.
        const st = str(e.status);
        const stateKey: 'pending' | 'kept' | 'undone' = st === 'kept' ? 'kept' : st === 'undone' ? 'undone' : 'pending';
        // Resolved rows dim WHOLE (parity with both editors' greyed Review rows) — pending work is
        // the only thing that shouts; the glyph still names which kind of resolved.
        const dim = stateKey !== 'pending';
        const delta = dim
          ? pad(`${tint(`+${num(e.added)}`, 'undone', depth)} ${tint(`−${num(e.removed)}`, 'undone', depth)}`, 12)
          : pad(`${tint(`+${num(e.added)}`, 'kept', depth)} ${tint(`−${num(e.removed)}`, 'risk', depth)}`, 12);

        // the reader acts, not explained after undo refuses. Without this, the row rendered as an
        // ordinary create — the exact conflation the flag exists to prevent.
        const partial = e.partial === true ? ` ${tint('review-only', 'pending', depth)}` : e.provenance === 'snapshot' ? ` ${tint('snapshot interval', 'pending', depth)}` : '';
        const model = e.model ? ` ${str(e.model)}` : '';
        rows.push({
          ids: [id],
          key: `e${id}`,
          // Indented under its file, and carrying the glyph itself: a nested row still has to say
          // whether IT is pending, because the header only says whether ANY of them is.
          cells: `   ${tint(statusGlyph(st, g), stateKey, depth)} ${tint(`#${String(id).padEnd(5)}`, dim ? 'undone' : 'accent', depth)} ${relTime(num(e.ts), state.now).padEnd(12)} ${delta}${partial}${model}`,
          cont: true,
        });
      }
    }
    // The cancelled-out footer. It is a ROW, not a note, and its ids are every cancelled record —
    // so `a` on it dismisses them all through the verb the reader already knows, with no new key.
    if (cancelledUnits) {
      const label = `${cancelledUnits} cancelled-out chain${cancelledUnits === 1 ? '' : 's'} — created then deleted, or put back: nothing to review (a dismisses)`;
      rows.push({
        ids: cancelledIds,
        key: 'cancelled',
        cells: `${tint(g.kept, 'undone', depth)} ${tint(label, 'undone', depth)}`,
      });
    }
  } else if (state.screen === 'map') {
    const cm = view<{ files?: unknown[]; summary?: { root?: unknown } }>(state, 'changemap');
    // summary.root is what resolves an outside-workspace rel to its REAL anchor; an older payload
    // without it degrades to the anonymous bucket rather than guessing.
    // The extension/type pickers narrow the map at the FILE level (before the tree is built, so empty
    // folders fall away); the query (fuzzy or regex) still narrows the built rows by their label.
    const mapFiles = (arr(cm?.files) as { rel?: string; file?: string }[]).filter((ff) =>
      fileSpecOk(str(ff.rel) || str(ff.file) || '')
    );
    const tree = buildMapTree(mapFiles as never, str(cm?.summary?.root) || undefined, state.sort);
    for (const r of mapRows(tree, state.open)) {
      if (!keep(r.label)) continue;
      const painted = renderMapRow(r, cols, g, depth, state.now);
      rows.push({ ids: [], key: `m${r.node.path}`, openPath: r.node.path, cells: painted[0] });
      // A wrapped name stays part of the SAME row: `cont` keeps the cursor stepping between entries.
      for (let ci = 1; ci < painted.length; ci++) {
        rows.push({ ids: [], key: `m${r.node.path}:${ci}`, openPath: r.node.path, cells: painted[ci], cont: true });
      }
    }
  } else if (state.screen === 'prompts') {
    // Newest first: the most recent ask is the one being reviewed, so making the reader scroll to
    // the end to reach it inverts the common case. `slice()` first — the view's array is shared.
    for (const p of arr(view<{ prompts?: unknown[] }>(state, 'prompts')?.prompts).slice().reverse()) {
      // The FULL ask, not the 64-cap title: it wraps below, so the whole thing is readable rather than
      // a sentence cut mid-word. Title is the fallback for a prompt with no text.
      const title = str(p.text) || str(p.title);
      if (!keep(title)) continue;
      const ids = Array.isArray(p.editIds) ? (p.editIds as number[]) : [];
      // The ask under review says so ON THE ROW, through the same channel marked rows use — the
      // cursor highlight cannot carry this, because it walks away the moment focus does. The action
      // cell is drawn by the SAME function the mouse resolves clicks through (promptRowActions), so
      // the glyph and the pointer cannot disagree about where "review" is.
      const reviewing = state.promptScope?.index === num(p.index);
      const act = promptRowActions(cols).length
        ? `${reviewing ? tint(PROMPT_ACT_ON, 'live', depth) : tint(PROMPT_ACT, 'undone', depth)} `
        : '';
      // TWO LINES per ask. Row one is the METADATA and carries the review action
      // (its click column is fixed at PROMPT_ACT_X, so it must stay on this row); row two onward is the
      // ask text, wrapped and indented — never clipped.
      const key = `p${str(p.id) || num(p.index)}`;
      const meta =
        `${tint(`#${num(p.index)}`.padEnd(5), 'accent', depth)} ${relTime(num(p.ts), state.now).padEnd(12)} ` +
        `${String(num(p.edits)).padStart(4)} ${num(p.edits) === 1 ? 'edit ' : 'edits'}  ${act}`;
      rows.push({ ids, key, cells: meta });
      const paint = (t: string) => (reviewing ? tint(t, 'accent', depth) : t);
      // KEEP the ask's own line breaks: split on newlines and wrap each source line, rather
      // than collapsing all whitespace — a code block or paragraphs in a prompt keep their shape.
      const wrapped = (title.trim() || '(empty)').split('\n').flatMap((ln) => wrapVisible(ln, Math.max(8, cols - 2)));
      for (let i = 0; i < wrapped.length; i++) {
        rows.push({ ids, key: `${key}:t${i}`, cells: `  ${paint(wrapped[i])}`, cont: true });
      }
    }
    } else if (state.screen === 'claude') {
    // The agent's own window: row one is who is working and on what; the rows beneath are a LIVE
    // TAIL of the session feed — Claude's activity as it lands, newest at the bottom, followed
    // automatically unless the reader is inside the pane (app.ts followClaudeTail). Overlong lines
    // wrap at render (paneVisible), never clip. The `F1 again` invitation rides the last row only
    // when the tail is quiet — a live pane spends its rows on the work.
    const sess = arr(view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions).find((s) => str(s.id) === state.session) as
      | Record<string, unknown>
      | undefined;
    const self = arr(view<{ agents?: unknown[] }>(state, 'multitask')?.agents).find((a) => a.self === true) as
      | Record<string, unknown>
      | undefined;
    if (!sess && !self) {
      // Distinguish "no data yet" from "measured zero": with neither payload there is nothing honest
      // to draw, and the empty-state path (which names the missing view) handles it.
    } else {
      // THE SAME BLOBS THE OBSERVATORY'S CONVERSATION DRAWS (agentBlob), details and all, not just
      // the blob name. One definition, so a tool call
      // cannot look like two different things in one product — targets on the head row, the tally of
      // what changed, the agent's own reasoning, shell calls drawn as shell calls, and the change itself
      // in the Diff pane's bands.
      const feedEntries = arr(view<{ entries?: unknown[] }>(state, 'feed')?.entries);
      let shown = 0;
      let paneRunTs = -1;
      let paneRun = -1;
      const paneThought = new Map<string, string>();
      for (let i = 0; i < feedEntries.length; i++) {
        const e = feedEntries[i] as Record<string, unknown>;
        const label = str(e.label);
        if (!label) continue;
        const kind = str(e.kind);
        if (kind === 'prompt') {
          // The user's own ask — on a grey band, the way the agent CLI paints user turns. The ask's
          // OWN line breaks are kept: each source line is its own banded row and soft-wraps at
          // render like every other row (never clipped). The first line carries the "❯ you #N" prefix.
          const t0 = num(e.ts);
          const stamp = cols >= 70 && t0 ? relTime(t0, state.now).padEnd(12) : '';
          // The same ground the Observatory's conversation paints its prompts on, through the theme.
          const bg = promptGround(depth);
          // The band fills the ENTIRE row, not just the text: pad each source line to the render width so the colour
          // runs edge to edge. A line already at/over the width keeps soft-wrapping (never clipped) —
          // the fill only pads the slack.
          const band = (t: string, k: number) => {
            const w = displayWidth(t);
            const filled = bg && w < cols ? t + ' '.repeat(cols - w) : t;
            rows.push({ ids: [], key: k === 0 ? `clf${i}` : `clf${i}:p${k}`, cells: bg ? `${bg}${filled}\x1b[0m` : filled, ...(k ? { cont: true } : {}) });
          };
          const src = str(e.promptText).split('\n');
          band(`${stamp}❯ you ${label}  ${src[0] ?? ''}`, 0);
          for (let k = 1; k < src.length; k++) band(src[k], k);
          shown++;
          continue;
        }
        if (kind !== 'action' && kind !== 'permission') {
          // Prose and raw output are not blobs — they are the words themselves. A 'reasoning' row
          // carries the agent's words in `reasoning` (labelled said/thinking); older payloads put a
          // one-liner in the label. Wrapped, never clipped, and it primes the blobs' dedupe so the
          // call that follows does not repeat the paragraph above it.
          const t0 = num(e.ts);
          const stamp = cols >= 70 && t0 ? relTime(t0, state.now).padEnd(12) : '';
          const detail = str(e.detail);
          const words = kind === 'reasoning' ? str(e.reasoning) : '';
          const head = words ? `${label} — ` : label;
          const text = `${stamp}${head}${words ? mdAnsiInlineDim(words.replace(/\s+/g, ' '), depth, e.reasoningKind === 'thinking') : ''}${detail ? `  ${(depth === 'none' ? '[' + detail + ']' : '\x1b[2m[' + detail + ']\x1b[22m')}` : ''}`;
          const wrapped = wrapVisible(text, Math.max(8, cols - 2));
          const cut = middleOut(wrapped, e.reasoningKind === 'thinking' ? THOUGHT_ROWS : wrapped.length);
          const parts = [...cut.head, ...(cut.hidden ? [`${g.fold} +${cut.hidden} more rows — F1 again ${g.wrap} the conversation`] : []), ...cut.tail];
          parts.forEach((part, k) => {
            const cells = depth === 'none' || (kind === 'reasoning' && e.reasoningKind !== 'thinking') ? part : `\x1b[2m${part}\x1b[0m`;
            rows.push(k === 0 ? { ids: [], key: `clf${i}`, cells } : { ids: [], key: `clf${i}:${k}`, cells, cont: true });
          });
          if (words) paneThought.set(detail, words);
          shown++;
          continue;
        }
        const ts = num(e.ts);
        paneRun = ts === paneRunTs ? paneRun + 1 : 0;
        paneRunTs = ts;
        const key = `agent:${ts}:${paneRun}`;
        const b = agentBlob(state, e, {
          g, depth, width: Math.max(20, cols - 2), open: !state.open.has(key), lastThought: paneThought.get(str(e.detail)),
          thoughtRows: THOUGHT_ROWS, more: `F1 again ${g.wrap} the conversation`,
        });
        paneThought.set(str(e.detail), b.thought);
        const eid = num(e.editId);
        b.rows.forEach((cells, j) => {
          // The HEAD row carries the blob's identity — its key folds it, its ids let the review verbs
          // reach the edit behind it. Body rows are continuations and own neither.
          rows.push(j === 0 ? { ids: eid ? [eid] : [], key, cells } : { ids: [], key: `${key}:${j}`, cells, cont: true });
        });
        shown++;
      }
      // No pinned last-message rows any more — the transcript itself ends with
      // what the agent said, and the pinned copy repeated it.
      if (!shown) {
        // OUR panel for every session kind: F1-again opens the drive
        // surface — leaving it never stops the agent. The native handover survives as `r`, and only
        // where it means anything: a hook-observed Claude session with a transcript to resume.
        const f1 = `F1 again ${g.wrap} conversation · h ${g.wrap} herdr`;
        rows.push({
          ids: [],
          key: 'cl3',
          cells: depth === 'none' ? f1 : `\x1b[2m${f1}\x1b[0m`,
        });
      }
    }
  } else if (state.screen === 'tasks') {
    // Tasks ride inside `multitask`, joined to changemap's per-task rollup for the review counts. The
    // editors do the same join; building from changemap.tasks instead would show a different, much
    // shorter list, because that one is scoped to strict in-progress spans that produced edits.
    const roll = new Map<string, Record<string, unknown>>();
    for (const r of arr(view<{ rollupByTask?: unknown[] }>(state, 'changemap')?.rollupByTask)) {
      roll.set(str(r.taskId), r);
    }
    for (const t of arr(view<{ tasks?: unknown[] }>(state, 'multitask')?.tasks)) {
      // `subject` FIRST: that is what the plan harness emits today. `content` and `title` are the
      // older spellings, kept so an archived session still reads correctly rather than turning into a
      // wall of digests the moment it is opened.
      const label = named([str(t.subject), str(t.content), str(t.title)], 'task', str(t.id) || str(t.taskId));
      if (!keep(label)) continue;
      const id = str(t.taskId);
      const r = roll.get(id) ?? {};
      const st = str(t.status);
      const key: 'kept' | 'live' | 'pending' = st === 'completed' ? 'kept' : st === 'in_progress' ? 'live' : 'pending';
      const mark = st === 'completed' ? g.kept : st === 'in_progress' ? g.open : g.closed;
      rows.push({
        ids: [],
        key: `t${id}`,
        cells: `${tint(mark, key, depth)} ${tint(st.padEnd(12), key, depth)} ${String(num(r.edits)).padStart(4)} ${num(r.edits) === 1 ? 'edit ' : 'edits'}  ${tint(`+${num(r.added)}`, 'kept', depth)} ${tint(`−${num(r.removed)}`, 'risk', depth)}  ${label}`,
      });
    }
  } else if (state.screen === 'workflows') {
    // The SAME breakdown both editors render from this payload (extension.ts renderWorkflows): a run
    // header, its metrics, then per-phase headings with the agents that belong to them. All of it was
    // already on the wire — `multitask.workflows` is the full WorkflowRun[] — and the terminal was
    // showing one flat line built from `w.phase`, a field WorkflowRun does not have, so the column
    // was always empty and fell back to a bare running/done that the glyph already said.
    for (const w of arr(view<{ workflows?: unknown[] }>(state, 'multitask')?.workflows)) {
      // Description first, then name — what the editors show as `w.description || w.name`.
      const label = named([str(w.description), str(w.name)], 'workflow', str(w.id));
      if (!keep(label)) continue;
      const live = w.running === true;
      const wk: StateKey = live ? 'live' : 'kept';
      const groups = arr(w.phaseGroups);
      const agents = arr(w.agents);
      const summary = groups.map((p) => `${str(p.title)} ${num(p.done)}/${num(p.total)}`).join(' · ');
      rows.push({
        ids: [],
        key: `w${str(w.id)}`,
        cells: `${live ? tint(g.closed, 'live', depth) : ' '} ${tint((live ? 'running' : 'done').padEnd(8), wk, depth)} ${summary ? `${tint(summary, 'agent', depth)}  ` : ''}${tail(label)}`,
      });
      // Metrics ride their own row so the run's description keeps the full width of its line — the
      // editors split them the same way, and this file's standing rule is to wrap, never truncate.
      // Field order matches the editors' metrics line: sparkline · ±lines · agents · tok · dur · edits.
      const wspark = Array.isArray(w.sparkline) ? sparkline(w.sparkline as number[], g) : '';
      rows.push({
        ids: [],
        key: `w${str(w.id)}m`,
        cont: true,
        cells: `     ${wspark ? `${tint(pad(wspark, 10), wk, depth)} ` : ''}${tint(`+${num(w.added)}`, 'kept', depth)} ${tint(`−${num(w.removed)}`, 'risk', depth)}  ${tint(
          [
            `${num(w.agentCount) || agents.length} agents`,
            `${compactTokens(num(w.tokens))} tok`,
            compactDuration(num(w.durationMs)),
            // w.edits — the run's OWN tool-call count, which is what both editors show. The old row
            // took this from changemap.rollupByWorkflow instead, so the terminal and the editors
            // reported different numbers for the same run.
            `${num(w.edits)} edit${num(w.edits) === 1 ? '' : 's'}`,
          ].join(' · '),
          'undone',
          depth
        )}`,
      });
      // The run's NAME, when the description is something else. Both are real identifiers — the
      // description is the readable one and the name is the one that appears in a script and in the
      // journal — so the editors show the name underneath rather than making you pick (VS Code's
      // `mt-wsub`). Only when they differ; repeating one string twice is noise.
      if (str(w.description) && str(w.name) && str(w.description) !== str(w.name)) {
        rows.push({ ids: [], key: `w${str(w.id)}n`, cont: true, cells: `     ${tint(str(w.name), 'undone', depth)}` });
      }
      // Agents grouped under their declared phase, then whatever is left under `other`. On a LIVE run
      // the phases come from the script meta while the agents may still carry journal keys, so the
      // `other` bucket is the common case, not an edge one. The heading appears ONLY when phases were
      // declared — a run with none shows a plain agent list, not a lone "other".
      const placed = new Set<number>();
      const agentRow = (a: Record<string, unknown>, i: number): void => {
        const done = a.done === true;
        const ak: StateKey = done ? 'kept' : 'live';
        const sid = str(a.agentId).replace(/^v\d+:/, '').slice(0, 6);
        // A DERIVED label is marked with `~` and never asserted — on a running workflow the label is
        // guessed from the agent's prompt, and the runner's real labels only land at completion.
        const lbl = str(a.label) ? `${str(a.label)}${a.labelDerived === true ? '~' : ''}` : `${str(a.agentType) || 'agent'}${sid ? ` ${sid}` : ''}`;
        // Model and effort only when stated. An unknown effort is left OUT rather than guessed: the
        // default differs by build and by model, so a placeholder would be fiction. Everything after
        // the label is what the editors' agent rows carry, in their order:
        // sparkline · ±lines · model · effort · tok · dur · edits.
        const aspark = Array.isArray(a.sparkline) ? sparkline(a.sparkline as number[], g) : '';
        // ±lines only when there ARE any — PyCharm's rule, and the one the Fleet's nested subagent
        // rows in this file already follow. A run of `+0 −0` down the column reads as a finding.
        const ad = num(a.added) || num(a.removed)
          ? `${tint(`+${num(a.added)}`, 'kept', depth)} ${tint(`−${num(a.removed)}`, 'risk', depth)}  `
          : '';
        const extras = [
          str(a.model),
          str(a.effort),
          `${compactTokens(num(a.tokens))} tok`,
          compactDuration(num(a.durationMs)),
          `${num(a.edits)} edit${num(a.edits) === 1 ? '' : 's'}`,
        ]
          .filter(Boolean)
          .join(' · ');
        rows.push({
          ids: [],
          key: `w${str(w.id)}a${str(a.agentId) || i}`,
          cont: true,
          cells: `       ${tint(done ? g.kept : g.closed, ak, depth)} ${tint(pad(lbl, 22), ak, depth)} ${aspark ? `${tint(pad(aspark, 10), ak, depth)} ` : ''}${ad}${tint(extras, 'undone', depth)}`,
        });
      };
      for (const [gi, p] of groups.entries()) {
        rows.push({
          ids: [],
          key: `w${str(w.id)}p${gi}`,
          cont: true,
          cells: `     ${tint(`${str(p.title)} ${num(p.done)}/${num(p.total)}`, 'agent', depth)}`,
        });
        agents.forEach((a, i) => {
          if (str(a.phase) !== str(p.title)) return;
          placed.add(i);
          agentRow(a, i);
        });
      }
      const rest = agents.map((a, i) => [a, i] as const).filter(([, i]) => !placed.has(i));
      if (rest.length && groups.length) {
        rows.push({ ids: [], key: `w${str(w.id)}pother`, cont: true, cells: `     ${tint('other', 'agent', depth)}` });
      }
      for (const [a, i] of rest) agentRow(a, i);
    }
  } else if (state.screen === 'agents') {
    // MODEL and EFFORT are not on the agent — they are per-session, and the editors join the two to
    // show them. Same join here, so Fleet says the same thing in all three front ends.
    const byId = new Map<string, Record<string, unknown>>();
    for (const x of arr(view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions)) byId.set(str(x.id), x);
    // THE HERDR-STYLE SIDEBAR: active agents only — a self-marker, a status dot and a
    // short name, nothing else. Clicking one scopes the board beside it, the same as a Workers row.
    if (state.workersMode === 'mini') {
      const ORDER0: AgentState[] = ['blocked', 'working', 'done', 'errored', 'idle', 'unknown'];
      const mini: { st: AgentState; cells: string; key: string; scope: { session: string; root: string; label: string } }[] = [];
      for (const a of arr(view<{ agents?: unknown[] }>(state, 'multitask')?.agents)) {
        const label = named([str(a.gitBranch), str(a.worktree)], 'session', str(a.session));
        if (!keep(label)) continue;
        const st = agentStateOf(str(a.phase), { unseen: state.doneUnseen?.has(str(a.session)) });
        const face = agentStateFace(st, g);
        const dot = depth === 'none' ? face.glyph : tint(face.glyph, face.key, depth);
        mini.push({ st, key: `m${str(a.session)}`, scope: { session: str(a.session), root: str(a.worktree), label }, cells: `${a.self ? tint(g.bar, 'accent', depth) : ' '}${dot} ${tail(label)}` });
      }
      const seenMini = new Set(arr(view<{ agents?: unknown[] }>(state, 'multitask')?.agents).map((a) => str(a.session)));
      for (const x of arr(view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions)) {
        const id = str(x.id);
        if (!id || seenMini.has(id)) continue;
        const st = agentStateOf(str(x.phase), { unseen: state.doneUnseen?.has(id), waiting: handOf(x) !== null });
        if (st === 'idle' || st === 'unknown') continue; // the rail is who needs you, not the whole history
        const label = named([str(x.title), str(x.workspace)], 'session', id);
        if (!keep(label)) continue;
        mini.push({ st, key: `mx${id}`, scope: { session: id, root: str(x.workspace), label }, cells: ` ${depth === 'none' ? agentStateFace(st, g).glyph : tint(agentStateFace(st, g).glyph, agentStateFace(st, g).key, depth)} ${tail(label)}` });
      }
      mini.sort((p, q) => ORDER0.indexOf(p.st) - ORDER0.indexOf(q.st));
      for (const m of mini) rows.push({ ids: [], key: m.key, scope: m.scope, cells: m.cells });
      return rows;
    }
    // GROUP BY AGENT: the
    // group is the session's own `agent` kind, joined from the sessions view.
    const agentOf = (a: Record<string, unknown>): string => agentKindLabel(str((byId.get(str(a.session)) ?? {}).agent) || 'claude');
    let lastAgent = '';
    const agentHeader = (name: string): void => {
      if (name === lastAgent) return;
      lastAgent = name;
      rows.push({
        ids: [],
        key: `agent:${name}`,
        cells: depth === 'none' ? `── ${name} ──` : `\x1b[2m${g.rule}${g.rule}\x1b[0m ${tint(name, 'accent', depth)}`,
      });
    };
    // ONE Workers board: every agent, its subagents nested, sorted by agent kind so
    // the header groups hold together.
    const fleet = arr(view<{ agents?: unknown[] }>(state, 'multitask')?.agents).filter((a) =>
      keep(named([str(a.gitBranch), str(a.worktree)], 'session', str(a.session)))
    );
    fleet.sort((a, b) => { const pa = agentOf(a), pb = agentOf(b); return pa < pb ? -1 : pa > pb ? 1 : 0; });
    for (const a of fleet) {
      agentHeader(agentOf(a));
      const label = named([str(a.gitBranch), str(a.worktree)], 'session', str(a.session));
      const d = (a.diff ?? {}) as Record<string, unknown>;
      // The payload's sparkline is a NUMBER ARRAY. Coercing it to a string drew nothing at all, which
      // is exactly what shipped: an empty column that looked like "no activity".
      const spark = Array.isArray(a.sparkline) ? sparkline(a.sparkline as number[], g) : '';
      // A heuristic phase is dimmed rather than marked, so a guess never reads as a fact.
      const phase = str(a.phase);
      // ONE READING for every agent on this surface — the same `agentStateOf` the strip and the
      // prompt box use. The inline map this replaces had no `blocked` and no seen bit: an agent
      // waiting on a human read as a word in amber, and one that finished while you were elsewhere
      // read exactly like one you had already dealt with.
      const st = agentStateOf(phase, { unseen: state.doneUnseen?.has(str(a.session)) });
      const face = agentStateFace(st, g);
      const pk = face.key;
      // A heuristic phase is DIMMED rather than marked, so a guess never reads as a fact.
      const heur = str(a.phaseConfidence) === 'heuristic';
      const shown = depth === 'none'
        ? `${face.glyph} ${face.label}`
        : `${heur ? '\x1b[2m' : ''}${tint(`${face.glyph} ${face.label}`, pk, depth)}`;
      const delta = pad(`${tint(`+${num(d.added)}`, 'kept', depth)} ${tint(`−${num(d.removed)}`, 'risk', depth)}`, 14);
      // What the editors put beside the sparkline: what it cost and how long it ran. Both are on the
      // agent already; the terminal simply was not showing them.
      const meta = byId.get(str(a.session)) ?? {};
      // Everything a reader weighs an agent by, on its row: its edit count beside its
      // ±lines, then what it cost (tokens · time) and what ran it (model · effort).
      const cost = [
        num(a.edits) ? `${num(a.edits)} edit${num(a.edits) === 1 ? '' : 's'}` : '',
        num(a.tokens) ? `${compactTokens(num(a.tokens))} tok` : '',
        num(a.durationMs) ? compactDuration(num(a.durationMs)) : '',
        str(meta.model),
        str(meta.effort),
      ].filter(Boolean).join(' · ');
      rows.push({
        ids: [],
        key: `a${str(a.session)}`,
        scope: { session: str(a.session), root: str(a.worktree), label },
        cells: `${a.self ? tint(g.bar, 'accent', depth) : ' '} ${shown}${' '.repeat(Math.max(0, 16 - displayWidth(`${face.glyph} ${face.label}`)))} ${delta} ${tint(spark.padEnd(10), pk, depth)} ${tail(label)}${cost ? `  ${tint(cost, 'undone', depth)}` : ''}`,
      });
      // SUBAGENTS NEST, as they do in the editors — an agent's work is not separable from the agents it
      // spawned, and a flat list of forty rows hides which parent each belongs to. Indented and marked
      // `cont` so the cursor steps between AGENTS, not into their children: `a`/`u` act on a selection,
      // and a child row is not a separate unit of review.
      for (const sub of arr(a.subagents)) {
        const sp = str(sub.phase);
        const sk: StateKey = sp === 'working' ? 'live' : sp === 'done' ? 'kept' : 'undone';
        const what = named([str(sub.description), str(sub.currentTask), str(sub.agentType)], 'subagent', str(sub.agentId));
        const sd = num(sub.added) || num(sub.removed)
          ? `${tint(`+${num(sub.added)}`, 'kept', depth)} ${tint(`−${num(sub.removed)}`, 'risk', depth)}`
          : '';
        // A subagent shows the SAME metrics as its parent now: its ±lines, then edits,
        // tokens and wall-clock, dim so the role and name stay the ink the eye lands on.
        const sCost = [
          num(sub.edits) ? `${num(sub.edits)} edit${num(sub.edits) === 1 ? '' : 's'}` : '',
          num(sub.tokens) ? `${compactTokens(num(sub.tokens))} tok` : '',
          num(sub.durationMs) ? compactDuration(num(sub.durationMs)) : '',
        ].filter(Boolean).join(' · ');
        rows.push({
          ids: [],
          key: `a${str(a.session)}s${str(sub.agentId)}`,
          cont: true,
          scope: { session: str(a.session), root: str(a.worktree), label },
          // `agentType` is the ROLE the spawn was given — 'Explore', 'fork', 'general-purpose' —
          // not a kind of agent. Same field, honest word.
          cells: `     ${tint(g.wrap, sk, depth)} ${tint(sp.padEnd(10), sk, depth)} ${str(sub.agentType).padEnd(10)} ${what}${sd ? `  ${sd}` : ''}${sCost ? `  ${tint(sCost, 'undone', depth)}` : ''}`,
        });
      }
    }
    // EVERY AGENT, not just this repo's worktrees.
    //
    // This listed `multitask.agents` — the sibling worktrees of the repo you are standing in — which
    // is the fleet, not the machine. An agent working in another project was invisible here, and the
    // question "who needs me" is not scoped to one checkout. Session rows carry their own phase now
    // (bounded to the recently-active ones, because an old conversation is idle by definition), so
    // the rest of them can be listed beside the fleet.
    const listed = new Set(arr(view<{ agents?: unknown[] }>(state, 'multitask')?.agents).map((a) => str(a.session)));
    const elsewhere: { st: AgentState; cells: string; key: string; agentGroup: string }[] = [];
    for (const x of arr(view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions)) {
      const id = str(x.id);
      if (!id || listed.has(id)) continue;
      const ph = str(x.phase);
      const unseen = state.doneUnseen?.has(id);
      const hand = handOf(x);
      // A SHORT-CIRCUIT, not the rule. No phase and not unseen reads as 'unknown', which the drop
      // below removes anyway — this only spares ~90 sessions the label and tint work on a machine
      // with a long history. Mutation testing says so out loud: removing either line alone changes
      // nothing, and removing both is what the test catches. A raised hand always lists.
      if (!ph && !unseen && !hand) continue;
      const st = agentStateOf(ph, { unseen, waiting: hand !== null });
      if (st === 'idle' || st === 'unknown') continue;
      const face = agentStateFace(st, g);
      const label = named([str(x.title), str(x.workspace)], 'session', id);
      if (!keep(label)) continue;
      const heur = str(x.phaseConfidence) === 'heuristic';
      const shownSt = depth === 'none'
        ? `${face.glyph} ${face.label}`
        : `${heur ? '\x1b[2m' : ''}${tint(`${face.glyph} ${face.label}`, face.key, depth)}`;
      const churn = num(x.added) || num(x.removed)
        ? pad(`${tint(`+${num(x.added)}`, 'kept', depth)} ${tint(`−${num(x.removed)}`, 'risk', depth)}`, 14)
        : ' '.repeat(14);
      // The raised hand, said in full (2026-09-15): what kind of wait, on what, for how long — the
      // exact hook state, so "blocked" is never left as a bare word.
      const handMeta = hand
        ? tint(`${g.pending} ${hand.kind}${hand.message ? ` · ${hand.message}` : ''} · ${compactDuration(Math.max(0, state.now - hand.ts))}`, 'agent', depth)
        : '';
      const meta = [
        handMeta,
        num(x.pending) ? `${num(x.pending)} pending` : '',
        str(x.model),
        relTime(num(x.lastActiveMs), state.now),
      ].filter(Boolean).join(' · ');
      elsewhere.push({
        st,
        agentGroup: agentKindLabel(str(x.agent)),
        key: `ax${id}`,
        cells: `  ${shownSt}${' '.repeat(Math.max(0, 16 - displayWidth(`${face.glyph} ${face.label}`)))} ${churn} ${' '.repeat(10)} ${tail(label)}${meta ? `  ${tint(meta, 'undone', depth)}` : ''}`,
      });
    }
    // BY AGENT FIRST (so the header groups hold together), then WHAT NEEDS YOU: within an agent a list
    // ordered by recency buries the one agent that stopped and waited behind nine that are fine.
    const ORDER: AgentState[] = ['blocked', 'working', 'done', 'errored', 'idle', 'unknown'];
    elsewhere.sort((p, q) => (p.agentGroup < q.agentGroup ? -1 : p.agentGroup > q.agentGroup ? 1 : ORDER.indexOf(p.st) - ORDER.indexOf(q.st)));
    for (const r of elsewhere) {
      agentHeader(r.agentGroup);
      rows.push({ ids: [], key: r.key, cells: r.cells });
    }
  } else if (state.screen === 'feed') {
    for (const en of arr(view<{ entries?: unknown[] }>(state, 'feed')?.entries)) {
      const label = str(en.label) || str(en.text);
      if (!keep(label)) continue;

      // they are the rows a hook-observed session could never have, and the reason to look.
      const shown = str(en.kind) === 'permission' ? tint(label, 'pending', depth) : label;
      rows.push({ ids: [], key: `f${num(en.ts)}${label.slice(0, 12)}`, cells: `${relTime(num(en.ts), state.now).padEnd(12)} ${shown}` });
    }
  } else if (state.screen === 'observations') {
    const ob = view<{ runs?: unknown[]; nextSteps?: unknown[] }>(state, 'observations');
    for (const r of arr(ob?.runs)) {
      const rel = str(r.rel) || str(r.file);
      if (!keep(rel)) continue;
      const st = str(r.status);
      rows.push({
        ids: Array.isArray(r.edits) ? (r.edits as number[]) : [],
        key: `ob${rel}`,
        cells: `${statusGlyph(st, g)} ${String(num(r.count)).padStart(3)}× ${tint(`+${num(r.added)}`, 'kept', depth)} ${tint(`−${num(r.removed)}`, 'risk', depth)}  ${tail(rel)}`,
      });
    }
    for (const n of arr(ob?.nextSteps)) {
      const t = typeof n === 'string' ? n : str((n as Record<string, unknown>).text);
      if (!t || !keep(t)) continue;
      rows.push({ ids: [], key: `ns${t.slice(0, 24)}`, cells: `${tint(g.closed, 'pending', depth)} ${t}` });
    }
  } else if (state.screen === 'processes') {
    const pr = view<{ processes?: unknown[] }>(state, 'processes');
    for (const x of arr(pr?.processes)) {
      const cmd = str(x.command) || str(x.cmd) || str(x.id);
      if (!keep(cmd)) continue;
      const st = str(x.status) || str(x.state);
      rows.push({ ids: [], key: `pr${str(x.id) || cmd.slice(0, 16)}`, cells: `${statusGlyph(st, g)} ${st.padEnd(10)} ${cmd}` });
    }
  } else if (state.screen === 'audit') {
    const risk = view<{ risky?: unknown[]; outsideWrites?: unknown[] }>(state, 'risk');
    const eg = view<{ channels?: unknown[] }>(state, 'egress');
    for (const r of arr(risk?.risky)) {
      const target = str(r.target);
      if (!keep(target)) continue;
      const lvl = str(r.level).toUpperCase();
      rows.push({ ids: [], key: `r${num(r.ts)}${target.slice(0, 12)}`, cells: `${tint(lvl === 'HIGH' ? '!!!' : '!!', 'risk', depth)} ${lvl.padEnd(6)} ${str(r.tool).padEnd(8)} ${target}` });
    }
    for (const w of arr(risk?.outsideWrites)) {
      const file = str(w.file);
      if (!keep(file)) continue;
      rows.push({ ids: [], key: `o${file}`, cells: `${tint('!!', 'risk', depth)} WRITE  ${String(num(w.count)).padStart(3)}×    ${tail(file)}` });
    }
    for (const c of arr(eg?.channels)) {
      const target = str(c.target);
      if (!keep(target)) continue;
      rows.push({ ids: [], key: `g${target}`, cells: `${tint('>', 'egress', depth)}  ${str(c.scope).padEnd(7)} ${str(c.kind).padEnd(6)} ${target}` });
    }
  }
  return rows;
}

/**
 * The edit ids the current selection resolves to.
 *
 * `'one'` is the row under the cursor; `'all'` is every row the screen currently lists, which respects
 * the active filter — so "accept everything" means what is on screen, not what is in the session.
 * Screens whose rows are observations rather than edits return nothing, and the caller says why.
 */
export function selectionIds(state: DashState, scope: 'one' | 'all'): number[] {
  const rows = rowsFor(state);
  if (scope === 'one') return rows[state.cursor] ? [...rows[state.cursor].ids] : [];
  const out = new Set<number>();
  for (const r of rows) for (const id of r.ids) out.add(id);
  return [...out];
}

/**
 * The very top row: which session everything below is about, and that it can be changed.
 *
 * It leads the frame for the same reason it leads the editors' Timeline window — every count, row and
 * verb underneath is scoped to this one session, so a reader who has not noticed which one is selected
 * can misread the entire screen. The marker says it opens; the session key and a click both do.
 */
/** The key currently bound to `action` — the reader's, or the default when no keymap was handed over. */
function keyFor(state: DashState, action: string): string {
  if (state.keys) for (const [k, a] of state.keys) if (a === action) return k;
  return REBINDABLE.find((r) => r.action === action)?.fallback ?? '?';
}

function sessionBar(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): string {
  const list = view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions;
  const n = Array.isArray(list) ? list.length : 0;
  const { title: name, id: shortId, machine } = sessionChipText(state);
  const idCell = !shortId ? '' : depth === 'none' ? `  ${shortId}` : `  \x1b[2m${shortId}\x1b[0m`;
  const left = `🔬 ${tint(name, 'accent', depth)}${idCell}${machineCell(machine, depth)} ${g.open}`;
  const right = n > 1 ? `${n} sessions · ${keyFor(state, 'session')} to switch` : '';
  const gap = Math.max(1, cols - displayWidth(left) - displayWidth(right) - 1);
  return fitVisible(`${left}${' '.repeat(gap)}${depth === 'none' ? right : `\x1b[2m${right}\x1b[0m`}`, cols);
}

/**
 * How wide the session chip is — the part of the top row that opens the picker when clicked.
 *
 * Exported so the mouse and the renderer measure it the same way. The counters share this row now,
 * and they are a readout, not a control: without this the whole row would be one click target and a
 * reader aiming at "3 conflicts" would get the session picker.
 */
/**
 * The session chip's text — the title, and the ID BESIDE IT.
 *
 * A title is derived from the session's first ask, so several sessions genuinely read the same; the
 * id is the only thing that is always unique, and it is what you type at the CLI to name this
 * session. It was visible only when a session had NO title, which is exactly backwards: the rows
 * that need it are the ones that already look like each other. Dim, because it is how you address a
 * session rather than how you recognise one.
 *
 * One definition for the text and its width, so the clickable region and what is drawn cannot
 * disagree — that region opens the picker, and a hit-test off by the id's width sends a click on the
 * title somewhere else.
 */
function sessionChipText(state: DashState): { title: string; id: string; machine: string } {
  const short = state.session.slice(0, 8);
  const title = state.sessionTitle || short;
  // The machine a session is reviewed ON when that is not this one: every keep and undo below runs
  // there, against its files, so which machine is as much a part of "which session" as the id is.
  return { title, id: state.sessionTitle && short !== state.sessionTitle ? short : '', machine: state.reviewMachine?.label ?? '' };
}

/** The chip's `on <machine>` part — the palette's egress hue, "off this machine", as in the picker. */
function machineCell(machine: string, depth: ColorDepth): string {
  return machine ? `  ${tint(`on ${machine}`, 'egress', depth)}` : '';
}

export function sessionChipWidth(state: DashState, g: Glyphs = defaultGlyphs()): number {
  const { title, id, machine } = sessionChipText(state);
  return displayWidth(`🔬 ${title}${id ? `  ${id}` : ''}${machine ? `  on ${machine}` : ''} ${g.open}`);
}

/**
 * The session and the attention counts, on ONE row: whose work this is on the left, and what about
 * it should stop you on the right.
 *
 * They were two rows. Both are single short strings, and a terminal has far fewer rows than columns —
 * so the second row cost the windows below a line of content to say something that fits in the space
 * the first one was already padding with blanks.
 */
function sessionRow(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): string {
  const { title: name, id: shortId, machine } = sessionChipText(state);
  const idCell = !shortId ? '' : depth === 'none' ? `  ${shortId}` : `  \x1b[2m${shortId}\x1b[0m`;
  const left = `🔬 ${tint(name, 'accent', depth)}${idCell}${machineCell(machine, depth)} ${g.open}`;
  const leftW = sessionChipWidth(state, g);
  // The counters get whatever the session name did not take, and choose their own tier inside it, so
  // a long session title shortens the labels rather than pushing a count off the end.
  const room = Math.max(0, cols - leftW - 2);
  // A backwards scan, not `/\s+$/`: that shape re-tries the match from every position, so a long run
  // of trailing spaces is quadratic — and this runs on a row rebuilt every keystroke.
  const right = trimTrailing(attention(state, room, g, depth), (c: string) => c === ' ' || c === '\t');
  const gap = Math.max(1, cols - leftW - displayWidth(right) - 1);
  return fitVisible(`${left}${' '.repeat(gap)}${right}`, cols);
}

/** Where the session row's right-aligned COUNTERS begin, from the same layout sessionRow draws —
 *  the agent navbar splits its click on this column: the selector side opens the picker, the
 *  counters side jumps to the REVIEW tab (the counters are review's numbers).
 *  `cols` is the row's own width (the box's INNER width on the boxed tier). No counters → the
 *  whole row is the selector. */
export function sessionRowCountersX(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): number {
  const leftW = sessionChipWidth(state, g);
  const room = Math.max(0, cols - leftW - 2);
  const right = trimTrailing(attention(state, room, g, depth), (c: string) => c === ' ' || c === '\t');
  const w = displayWidth(right);
  return w ? Math.max(leftW, cols - w - 1) : cols;
}

function depthOf(color: ColorDepth | boolean): ColorDepth {
  return color === true ? '256' : color === false ? 'none' : color;
}

/**
 * The attention header: the counts that decide whether to stop, on EVERY screen.
 *
 * Budgeted rather than clipped — at a narrow width the labels shorten instead of the last two counts
 * silently disappearing, which is what happened when this was a plain join.
 */

/** A session row's raised hand — the hooks' exact wait — or null for nothing / a finished turn. */
export function handOf(x: Record<string, unknown>): { kind: 'permission' | 'question' | 'input'; message: string; ts: number } | null {
  const a = x.attention as { kind?: unknown; message?: unknown; ts?: unknown } | null | undefined;
  if (!a || typeof a !== 'object') return null;
  if (a.kind !== 'permission' && a.kind !== 'question' && a.kind !== 'input') return null;
  return { kind: a.kind, message: typeof a.message === 'string' ? a.message : '', ts: typeof a.ts === 'number' ? a.ts : 0 };
}

function attention(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): string {
  const cmView = view<{ summary?: Record<string, unknown> }>(state, 'changemap');
  const cm = cmView?.summary ?? {};
  // Who needs you, first and in every tier (2026-09-15): the count of sessions whose hand is up.
  const hands = arr(view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions).filter((x) => handOf(x as Record<string, unknown>) !== null).length;
  const risk = view<{ high?: unknown; count?: unknown }>(state, 'risk');
  const eg = view<{ remote?: unknown }>(state, 'egress');
  const mtView = view<{ summary?: Record<string, unknown> }>(state, 'multitask');
  const mt = mtView?.summary ?? {};
  // A count from a view not in hand — not read yet, or unreadable (another machine that cannot be
  // reached) — is unknown, not zero: "0 pending" stated as fact beside panes naming the failure.
  const count = (from: unknown, v: unknown): string => (from == null ? '—' : String(num(v)));
  // Every tier is MEASURED, never guessed at from a width threshold. Sharing a row with the session
  // name means the room left over depends on the session's title, so a hand-picked `cols >= 92` would
  // cut a count on exactly the sessions whose names are longest.
  const tier = (labels: boolean, all: boolean): string => {
    const bits = [
      hands ? tint(`${g.pending} ${hands}${labels ? ' need you' : 'w'}`, 'agent', depth) : '',
      tint(`${g.pending} ${count(cmView, cm.pending)}${labels ? ' pending' : ''}`, 'pending', depth),
      all ? tint(`${g.kept} ${count(cmView, cm.kept)}${labels ? ' kept' : ''}`, 'kept', depth) : '',
      tint(`${riskMark(num(risk?.high), num(risk?.count))} ${count(risk, risk?.high)}${labels ? ' high risk' : ''}`, 'risk', depth),
      all ? tint(`> ${count(eg, eg?.remote)}${labels ? ' remote' : ''}`, 'egress', depth) : '',
      all ? tint(`${g.closed} ${count(mtView, mt.active)}${labels ? ' active' : ''}`, 'live', depth) : '',
      state.doneUnseen?.size ? tint(`${g.kept} ${state.doneUnseen.size}${labels ? ' done' : 'd'}`, 'kept', depth) : '',
      `${count(mtView, mt.conflicts)}${labels ? ` conflict${num(mt.conflicts) === 1 ? '' : 's'}` : 'c'}`,
    ].filter(Boolean);
    return bits.join('  ');
  };
  // Labels go before counts do, and the last thing standing is pending, high risk and conflicts —
  // the three that decide whether to stop. A cut number is worse than an absent one: "334 conflicts"
  // clipped to "33" is not a smaller truth, it is a false one.
  const fits = [tier(true, true), tier(false, true), tier(false, false)].find((s) => displayWidth(s) <= cols);
  return fits ?? '';
}

function navRow(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): string {
  const tabs = SCREENS.map((s, i) => {
    const label = cols >= 88 ? `${i + 1} ${s.label}` : String(i + 1);
    return s.id === state.screen ? `\x1b[7m ${label} \x1b[0m` : ` ${label} `;
  });
  const plain = SCREENS.map((s, i) => (cols >= 88 ? ` ${i + 1} ${s.label} ` : ` ${i + 1} `)).join('');
  const mode = state.watcherMode === 'poll' ? `  watcher: poll` : '';
  return fitVisible((depth === 'none' ? plain : tabs.join('')) + mode, cols);
}

/**
 * Render exactly `rows` lines, each at most `cols` display columns.
 *
 * The last cell of the last row is never written: on most terminals printing there triggers auto-wrap
 * and scrolls the alternate screen, shifting the whole frame up by one on every repaint.
 */

// ---------------------------------------------------------------------------
// The three-window composition.
// ---------------------------------------------------------------------------

/** A pane's counter, tiered and dropped WHOLE rather than clipped — a cut counter in the chrome is
 *  the same defect as a cut path in the body. */
/**
 * The newest ask and whether it is still being answered — `ask #7 answering…  fix the wrap budget`.
 *
 * Pinned rather than scrolled on both surfaces: it is the question the whole
 * screen is an answer to, and as a feed row it slid away the moment the agent did anything. Widest
 * form first, so a narrow pane keeps the part that matters (that it is still running).
 */
export function askLine(state: DashState): string[] {
  const asks = arr(view<{ prompts?: unknown[] }>(state, 'prompts')?.prompts);
  const last = asks[asks.length - 1] as Record<string, unknown> | undefined;
  if (!last) return [];
  const live = num(last.endTs) === 0;
  const when = live ? 'answering…' : relTime(num(last.ts), state.now);
  const id = `ask #${num(last.index)}`;
  const title = str(last.title).replace(/\s+/g, ' ');
  return [`${id} ${when}  ${title}`, `${id} ${when}`, when];
}

function paneCounter(state: DashState, id: PaneId): string[] {
  const n = (name: string, key: string): number => {
    const v = view<Record<string, unknown[]>>(state, name);
    return Array.isArray(v?.[key]) ? (v![key] as unknown[]).length : 0;
  };
  if (id === 'traces') {
    const sc = state.promptScope;
    // The SCOPED count has to follow the same rule as the unscoped one below: `sc.ids` is the ask's
    // whole mutation set (it drives keep/undo, so it keeps every cancelled member), which read as
    // "2 edits" over a pane drawing one row and a footer.
    if (sc) {
      const shown = arr(view<{ edits?: unknown[] }>(state, 'list')?.edits).filter(
        (e) => e.cancelled !== true && sc.ids.has(num(e.id))
      ).length;
      return [`prompt #${sc.index} · ${shown} edit${shown === 1 ? '' : 's'} · esc clears`, `#${sc.index} · ${shown}`, `#${sc.index}`];
    }
    // The rows this pane LISTS: cancelled-out chains are accounted for in its footer, not as rows,
    // so counting them here would put "4 edits" over a pane showing two.
    const c = arr(view<{ edits?: unknown[] }>(state, 'list')?.edits).filter((e) => e.cancelled !== true).length;
    // This list is ignore-FILTERED, so when it drops rows it has to say so — otherwise "12 edits"
    // over a session that made 400 is indistinguishable from a session that made 12. The hidden
    // count rides the widest tiers and falls away first, like every other secondary number here.
    return c ? [`${c.toLocaleString('en-US')} edit${c === 1 ? '' : 's'}`, `${c}`] : [];
  }
  if (id === 'prompts') {
    const c = n('prompts', 'prompts');
    return c ? [`${c} asked`, `${c}`] : [];
  }
  if (id === 'claude') {
    // THE ASK, PINNED. As a feed row it scrolled away the moment the agent did
    // anything — and it is the question every row beneath it is answering. The pending count keeps
    // the narrow tiers: it is the safety-relevant number, and it survives minimizing.
    const summary = view<{ summary?: { pending?: number } }>(state, 'changemap')?.summary;
    const p = typeof summary?.pending === 'number' ? summary.pending : 0;
    const count = p ? [`${p} pending`, `${p}`] : [];
    const ask = askLine(state);
    return [...ask.map((a) => (p ? `${a}  ·  ${p} pending` : a)), ...ask, ...count];
  }
  if (id === 'dashboards') {
    const a = n('multitask', 'agents');
    // The risky-action count arrived here with Observations and Actions. It is the safety-critical
    // number on this pane, so it rides every tier that has room for anything at all — a pane does
    // not drop its alarm to save four columns.
    const risky = n('risk', 'risky') + n('risk', 'outsideWrites') + n('egress', 'channels');
    const wide = [a ? `${a} agents` : null, risky ? `${risky} actions` : null].filter(Boolean).join(' · ');
    const tight = [a ? `${a}` : null, risky ? `!${risky}` : null].filter(Boolean).join(' ');
    return wide ? [wide, tight] : [];
  }
  return [];
}

/**
 * OSC 52 payloads are BOUNDED, because over the limit they fail SILENTLY (tmux's documented
 * ceiling is 74,994 bytes; several terminals are lower) — moved here from the runtime so the
 * decision below and its tests share the one constant.
 */
export const OSC52_MAX = 74_994 - 16;

/**
 * The clipboard DECISION, pure: within the OSC 52 ceiling → the escape (works locally
 * and remotely alike). Past it on a LOCAL terminal → the platform's own tools, first present
 * wins. Past it remotely → refuse loudly: the native tools would write the REMOTE machine's
 * clipboard — the wrong one — and truncating is worse than refusing. The runtime spawns; this
 * function only ever decides, which is what makes the ladder testable without a clipboard.
 *
 * INSIDE TMUX the escape is not a path at all: tmux's default `set-clipboard external` means tmux
 * sets the outer clipboard for its OWN copies but IGNORES OSC 52 from applications inside panes —
 * the escape dies in tmux while the toast says "copied" (measured live, 2026-08-19: tmux 3.7b,
 * set-clipboard external, allow-passthrough off — the passthrough envelope is swallowed too). The
 * one door tmux itself holds open is `tmux load-buffer -w -`: the text lands in the tmux paste
 * buffer (prefix ] pastes it, always) AND tmux forwards it to the outer terminal's clipboard,
 * which `external` explicitly permits. So tmux leads whenever $TMUX is set, at any size; the
 * runtime falls through to the ordinary ladder if the spawn fails (a tmux too old for `-w`).
 */
export function clipboardPlan(
  payloadBase64Len: number,
  opts: { remote: boolean; platform: NodeJS.Platform; tmux?: boolean }
): { via: 'tmux' } | { via: 'osc52' } | { via: 'tools'; tools: readonly (readonly [string, readonly string[]])[] } | { via: 'refuse' } {
  if (opts.tmux) return { via: 'tmux' };
  if (payloadBase64Len <= OSC52_MAX) return { via: 'osc52' };
  if (opts.remote) return { via: 'refuse' };
  return {
    via: 'tools',
    tools: opts.platform === 'darwin'
      ? [['pbcopy', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['pbcopy', []]],
  };
}

/** Word-boundary caret moves for the prompt editor (readline's own rule: skip separators, then the
 *  word), pure so the chords that ride them — opt/ctrl+arrows, opt+backspace, ctrl+w, alt+d — are
 *  testable without a terminal. Newlines count as separators, so word motion crosses lines the way
 *  every native input does. */
export function wordLeftAt(buf: string, at: number): number {
  let i = Math.max(0, Math.min(at, buf.length));
  while (i > 0 && /[\s]/.test(buf[i - 1])) i--;
  while (i > 0 && !/[\s]/.test(buf[i - 1])) i--;
  return i;
}
export function wordRightAt(buf: string, at: number): number {
  let i = Math.max(0, Math.min(at, buf.length));
  while (i < buf.length && /[\s]/.test(buf[i])) i++;
  while (i < buf.length && !/[\s]/.test(buf[i])) i++;
  return i;
}

/**
 * The PASTE decision (the ^V half of the OS pair, 2026-08-19), pure and symmetric with the copy
 * ladder above: inside tmux the paste buffer is what the app's own copies fill (`save-buffer`);
 * on a local terminal the platform's read tools; remote without tmux is an honest HINT — the
 * remote machine's tools would read the wrong clipboard, and the terminal's own paste (cmd+V /
 * ctrl+shift+V, arriving as a bracketed paste) is the only thing that can carry the right one.
 */
export function pastePlan(opts: { tmux: boolean; remote: boolean; platform: NodeJS.Platform }):
  | { via: 'tmux' }
  | { via: 'tools'; tools: readonly (readonly [string, readonly string[]])[] }
  | { via: 'hint' } {
  if (opts.tmux) return { via: 'tmux' };
  if (opts.remote) return { via: 'hint' };
  return {
    via: 'tools',
    tools: opts.platform === 'darwin'
      ? [['pbpaste', []]]
      : [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['pbpaste', []]],
  };
}

/**
 * The seen-bit transition, pure: which sessions flipped active→idle while NOT under
 * review (they turn `done`), and which came back to life (`done` clears — it is a FINISHED
 * state, not a memory). Returns null when nothing changed, so the runtime can keep the Set's
 * identity stable for the memos. A session's FIRST appearance never counts as finishing.
 */
export function seenTransitions(
  prevRows: readonly { id?: unknown; active?: unknown }[],
  nextRows: readonly { id?: unknown; active?: unknown }[],
  doneUnseen: ReadonlySet<string> | undefined,
  currentSession: string
): ReadonlySet<string> | null {
  const prevActive = new Map(prevRows.map((r) => [String(r.id ?? ''), r.active === true]));
  const done = new Set(doneUnseen ?? []);
  let changed = false;
  for (const r of nextRows) {
    const id = String(r.id ?? '');
    if (!id) continue;
    if (r.active === true && done.has(id)) {
      done.delete(id);
      changed = true;
    } else if (r.active !== true && prevActive.get(id) === true && id !== currentSession) {
      done.add(id);
      changed = true;
    }
  }
  return changed ? done : null;
}

/** The dim title-band coat unfocused panes wear — shared with the Agent screen's region headers
 *  (divider parity), so the two surfaces cannot drift apart one hex code at a time. */
const titleBandDim = (depth: ColorDepth): string => {
  // Through the PALETTE now, not two hex codes. These were the only backgrounds in the frame, and
  // being hard-coded they ignored the theme entirely — a reader on the light palette got a dark band
  // across every pane, and the mono palette had no effect on the one thing that was actually painted.
  if (depth === 'none') return '';
  const g = surfaces().raised;
  const t = inks().muted;
  const bg = depth === '16' ? '' : depth === 'truecolor' ? `\x1b[48;2;${g.rgb}m` : `\x1b[48;5;${g.c256}m`;
  const fg = depth === 'truecolor' ? `\x1b[38;2;${t.rgb}m` : depth === '256' ? `\x1b[38;5;${t.c256}m` : `\x1b[${t.c16}m`;
  return `${bg}${fg}`;
};

/** The band a FOCUSED pane wears: the selection ground, at full text weight. Same palette as every
 *  other surface, so a theme reaches it — see `titleBandDim` for what these two used to be. */
const focusBand = (depth: ColorDepth): string => {
  if (depth === 'none') return '';
  if (depth === '16') return '\x1b[7m';
  const g = surfaces().selection;
  const t = inks().text;
  return depth === 'truecolor'
    ? `\x1b[48;2;${g.rgb}m\x1b[38;2;${t.rgb}m`
    : `\x1b[48;5;${g.c256}m\x1b[38;5;${t.c256}m`;
};

/** The title row: focus marker, jump key, name, an ASCII rule to the counter, then the counter.
 *  The rule is what makes each pane's horizontal EXTENT visible with no colour at all. */
function paneTitle(state: DashState, box: PaneBox, g: Glyphs, depth: ColorDepth): string {
  const spec = PANE_SPECS.find((p) => p.id === box.id)!;
  const w = box.rect.w;
  // btop's panels read cleanly because every one is a closed shape with its name set into the edge.
  // It gets that from box-drawing, which this product cannot use — the set is missing from Menlo
  // Bold, VS Code's default macOS terminal font, so a bolded frame turns to tofu. The same clarity
  // comes from three channels that need no glyph: a filled title BAND across the pane's full width,
  // the name bracketed so it reads as a label rather than as content, and the rule running out to
  // the counter so the pane's extent is visible even with colour off.
  const chip = BAR_ENTRIES.find((e) => e.pane === box.id);
  // No `>` focus marker — the focus band / coral border is the signal.
  const head = ` F${chip?.key ?? spec.n} ${chip?.title ?? spec.title} `;
  let line = head;
  for (const c of [...paneCounter(state, box.id), '']) {
    const suffix = c ? `  ${c} ` : '';
    const fill = w - displayWidth(head) - displayWidth(suffix);
    if (fill >= 1) {
      line = head + g.rule.repeat(fill) + suffix;
      break;
    }
  }
  const fitted = fitVisible(pad(line, w), w);
  if (depth === 'none') return fitted;
  // Focused: a solid band, so the active pane is unmistakable at a glance. Unfocused: a dimmer band
  // rather than plain text — every pane keeps a visible edge, which is what makes the grid read as
  // panels instead of columns of text that happen to sit side by side.
  const bg = box.focused ? focusBand(depth) : titleBandDim(depth);
  return `${bg}${fitted}\x1b[0m`;
}

/** The tab strip, drawn FROM the spans the layout computed so a click lands where the label is. */
/**
 * Row 0: the top-level tabs, with the Workers rollup right-aligned on the SAME row.
 *
 * Selection follows `paneTabs` exactly — a filled ground with the brackets kept at every depth, so
 * a --no-color terminal and every plain-text harness can still say which tab is up.
 *
 * HOVER prints the hovered tab's model in the gap between the tabs and the rollup, rather than in a
 * floating overlay. An overlay would need clipping, z-order against the selection painter, and a
 * row it does not have; the gap is already empty, already on the row the pointer is on, and costs
 * no geometry. The hovered tab wears a `raised` ground so the pairing is unambiguous.
 */
/** The fixed outer workspaces keep their names as the selected session changes. */
export function tabParts(t: TabState | undefined, i: number, _g: Glyphs): { dot: string; body: string; key: StateKey } {
  return { dot: '', body: t?.name ?? String(i + 1), key: 'accent' };
}

/** The same numbered label is measured by the layout and drawn by the strip. */
export function tabLabel(t: TabState | undefined, i: number, g: Glyphs): string {
  return tabParts(t, i, g).body;
}

function tabStrip(state: DashState, lay: Layout, cols: number, g: Glyphs, depth: ColorDepth): string {
  const tabs = state.tabs ?? [];
  if (!tabs.length) return '';
  const cells: string[] = [];
  let at = 0;
  const put = (x: number, text: string) => {
    if (x > at) cells.push(' '.repeat(x - at));
    cells.push(text);
    at = x + displayWidth(text.replace(/\x1b\[[0-9;]*m/g, ''));
  };
  const { pre, post } = lay.tabbarMore;
  if (pre) put(pre.x, paint(`-${pre.hidden} `, { fg: 'faint' }, depth));
  for (const s of lay.tabbar) {
    const label = tabLabel(tabs[s.index], s.index, g);
    const padding = Math.max(0, s.w - displayWidth(label));
    const left = Math.floor(padding / 2);
    const cell = ' '.repeat(left) + label + ' '.repeat(padding - left);
    // herdr uses label+4 cells (minimum eight), a one-cell gap, and panel ink on an accent
    // ground for the active tab. Reverse the themed ink/ground to use those same colours.
    if (s.selected) {
      put(s.x, depth === 'none'
        ? `[${cell.slice(1, -1)}]`
        : `\x1b[7m${paint(cell, { fg: 'accent', bg: 'panel' }, depth)}\x1b[27m`);
    } else {
      put(s.x, paint(cell, { fg: state.hoverTab === s.index ? 'muted' : 'faint', bg: 'raised' }, depth));
    }
  }
  if (post) put(post.x, paint(` +${post.hidden}`, { fg: 'faint' }, depth));
  // The model of whatever is under the pointer. A tab with no session shows NOTHING — not an empty
  // box, not an em dash — because the absence is the honest answer and a placeholder reads as data.
  const hov = state.hoverTab != null ? tabs[state.hoverTab] : null;
  if (hov?.model) put(at + 2, paint(hov.model, { fg: 'faint' }, depth));

  const rollup = workersRollup(state, g, depth);
  const plain = cells.join('').replace(/\x1b\[[0-9;]*m/g, '');
  const rollW = displayWidth(rollup.replace(/\x1b\[[0-9;]*m/g, ''));
  // Tabs win the row when it is narrow: the rollup is dropped whole rather than overlapping a tab.
  if (rollup && displayWidth(plain) + rollW + 1 <= cols)
    return cells.join('') + ' '.repeat(cols - displayWidth(plain) - rollW) + rollup;
  return cells.join('');
}

/** The tab bar: a single row of padded tabs (the active one a filled block), no rules above or below
 * One row when there are tabs,
 *  none otherwise — the chrome ladder reserves exactly this (CHROME_TOP + 1). The tabs sit on row 0,
 *  so the click/hover hit-test reads the tab row from `chrome.top`. */
function tabBar(state: DashState, lay: Layout, cols: number, g: Glyphs, depth: ColorDepth): string[] {
  if (!lay.tabbar.length) return [];
  // Fitted like every row below it: the strip always draws the selected tab whole, and under about 15
  // columns that alone is wider than the terminal.
  return [fitVisible(tabStrip(state, lay, cols, g, depth), cols)];
}

/** `▸2  ?1  ◆1` — working, blocked, done-unseen, machine-wide. Degrades to counts, then to nothing. */
function workersRollup(state: DashState, g: Glyphs, depth: ColorDepth): string {
  const rows = arr(view<{ agents?: unknown[] }>(state, 'multitask')?.agents) as { phase?: string; active?: boolean; self?: boolean }[];
  if (!rows.length) return '';
  let working = 0, blocked = 0, done = 0;
  for (const a of rows) {
    const st = agentStateOf(String(a.phase ?? ''), { active: a.active === true });
    if (st === 'blocked') blocked++;
    else if (st === 'working') working++;
    else done++;
  }
  // The ink comes from the state's own face, never from a second table here — one definition of what
  // "blocked" looks like, shared with every other surface that draws a worker.
  const part = (n: number, st: AgentState) => {
    if (!n) return '';
    const f = agentStateFace(st, g);
    return paint(`${f.glyph}${n}`, { fg: f.key }, depth);
  };
  return [part(working, 'working'), part(blocked, 'blocked'), part(done, 'done')].filter(Boolean).join('  ');
}

function paneTabs(box: PaneBox, g: Glyphs, depth: ColorDepth): string {
  const cells: string[] = [];
  let at = box.body.x;
  const put = (x: number, text: string) => {
    if (x > at) cells.push(' '.repeat(x - at));
    cells.push(text);
    at = x + displayWidth(text.replace(/\x1b\[[0-9;]*m/g, ''));
  };
  const { pre, post } = box.tabMore;
  if (pre) put(pre.x, paint(`-${pre.hidden} `, { fg: 'faint' }, depth));
  // FILLED CHIPS, not bracketed text (herdr's tab bar, src/ui/tabs.rs: an active tab is a ground,
  // not a pair of brackets). Brackets are a label ABOUT the selection; a ground IS the selection, and
  // it is the difference between a strip that reads as tabs and one that reads as a row of words.
  //
  // The BRACKETS SURVIVE at 'none'. They are the whole signal without colour, and a --no-color
  // terminal must still be able to say which tab is up.
  for (const s of box.tabSpans) {
    // BRACKETS AT EVERY DEPTH, with the ground ON TOP rather than instead. herdr can carry the
    // selection with a ground alone because it has no no-colour tier; we do, and this product's rule
    // is that meaning never rests on hue. Dropping them at truecolor also made the selection
    // invisible to every plain-text reading — including the harness that drives this strip.
    const label = s.selected ? `[${s.label}]` : ` ${s.label} `;
    put(
      s.x,
      s.selected
        ? paint(label, { fg: box.focused ? 'accent' : 'text', bg: box.focused ? 'selection' : 'raised' }, depth)
        : paint(label, { fg: 'faint' }, depth)
    );
  }
  if (post) put(post.x, paint(` +${post.hidden}`, { fg: 'faint' }, depth));
  const line = cells.join('');
  return fitVisible(pad(line, box.body.w), box.body.w);
}

/**
 * The visible body lines of one pane, each tagged with the LOGICAL row it belongs to.
 *
 * Two rules that cost real defects to learn:
 *
 * `scroll` and `cursor` are ROW indices, never visual-line indices. A wrapped row occupies several
 * lines, so the two counts diverge — and when the runtime clamped a row cursor against a visual-line
 * offset (sized to the whole terminal rather than to the pane), j/k walked the selection off the pane
 * and a click landed on a different edit than the one under the pointer. In a tool that reverts code,
 * acting on the wrong row is the worst thing this can do.
 *
 * Only the VISIBLE window is wrapped. Wrapping the whole list on every frame made the frame 15-18x
 * more expensive on a real session, for lines nobody can see.
 */
/**
 * Which face a pane is showing. Detail has no tab strip — an edit selected means its diff, nothing
 * selected means the change map — so it is resolved from the SELECTION. Asking the reader to pick
 * would be asking them to restate what they already said.
 *
 * Exported because `paneVisible`, `paneRowCount` and `paneListRows` must all agree. They did not
 * before: `paneRowCount` read the tab table where `paneVisible` read the selection, so Detail
 * reported zero rows for a face that was rendering fine, and its cursor and scroll were pinned to 0
 * on every frame.
 */
export function paneScreenOf(state: DashState, box: PaneBox): string {
  // Map and Diff are separate PANES now — the table simply answers.
  return TAB_SCREEN[box.id][box.selTab] ?? TAB_SCREEN[box.id][0];
}



/**
 * The rich diff for the current selection, rendered ONCE per (patch, width, depth).
 *
 * `paneVisible` needs the lines and `paneRowCount` needs their count, on the same frame, at the same
 * width. Rendering twice would double the cost of the most expensive face on screen — a real diff
 * runs to thousands of lines with a per-character intra-line pass — so the second caller gets the
 * first one's answer. One entry is enough: there is exactly one Detail pane.
 */
// ONE ENTRY PER DEPTH, because the callers alternate: the paint renders at the terminal's depth
// while the scroll clamp (`detailDiffMax`) counts at 'none' — a single shared slot made each caller
// evict the other, so every keystroke re-rendered the most expensive face on screen twice. Two slots
// end the war; a count taken at 'none' stays valid at any depth because colour never changes line
// COUNTS, only their contents.
const richMemo = new Map<ColorDepth, { key: string; lines: string[] }>();
function richDiffFor(state: DashState, inner: number, g: Glyphs, depth: ColorDepth): string[] {
  const patch = state.diffPatch ?? '';
  const m = state.diffMeta;
  // Nothing selected draws NOTHING. The renderer heads every patch with `● Verb(path)`, and with no
  // patch and no edit that header came out as a bare `● Edit()` over an empty pane — a phantom edit
  // on a session that had none (2026-09-22). The pane's own decor line says what to do instead.
  if (!patch && !m) return [];
  // panX and noWrap are KEYED: they change how many lines come back — panning keeps every source
  // line on one row where wrapping split it across several — so a count taken under one is wrong
  // under the other, and the memo would hand the stale one to the clamp.
  const pan = state.noWrap ? Math.max(0, state.panX ?? 0) : 0;
  // SYNTAX is in the key: it changes every row this returns, and leaving it out meant toggling the
  // setting redrew nothing until some other input happened to change.
  const key = [m?.id ?? -1, inner, m?.verb ?? '', pan, state.syntax !== false ? 'syn' : 'plain', patch.length, patch].join('\u001f');
  const hit = richMemo.get(depth);
  if (hit && hit.key === key) return hit.lines;
  const lines = renderRichDiff(patch, {
    cols: inner,
    color: depth,
    glyphs: g,
    syntax: state.syntax !== false,
    // The tool the agent actually used. Defaulting every edit to one verb told the reader a file was
    // updated when it had been created.
    verb: m?.verb || 'Edit',
    path: m?.path,
    added: m?.added,
    removed: m?.removed,
    // 0 means "wrap", which is the default and what every other surface does.
    panX: pan,
  });
  // A stale patch's entries die with the key mismatch; two depths is the whole population, so the
  // map never grows past the pair of callers that exist.
  richMemo.set(depth, { key, lines });
  return lines;
}

/**
 * Fixed lines a pane draws ABOVE its scrolling list — a hint, a legend. They do not scroll and they
 * are not selectable, so they are not rows; but they do consume body height, which is why
 * `paneListRows` subtracts them. Counting them as rows is how a list's last entry becomes
 * unreachable: the cursor can reach it and the viewport cannot show it.
 */
function decorLines(state: DashState, box: PaneBox, screen: string, inner: number, g: Glyphs, depth: ColorDepth): string[] {
  const out: string[] = [];
  // A scoped Traces list SAYS so — rows hidden by the map cursor would otherwise read as edits that
  // were never captured, which is the one impression this product must never give.
  if (box.id === 'traces' && screen === 'edits' && state.mapScope) {
    const label = `scoped to ${state.mapScope.split(/[\\/]/).pop() ?? state.mapScope} (map) — map cursor to root shows all`;
    for (const part of wrapVisible(label, Math.max(1, inner - 2))) {
      out.push(depth === 'none' ? ` ${part}` : `\x1b[2m ${part}\x1b[0m`);
    }
  }
  // Only on the DIFF face, and only when there is no diff. On the map it was an instruction to do
  // something else, printed above the thing the reader had just asked to see.
  // An empty list with a live ignore file explains itself, on the pane the reader is looking at.
  if (box.id === 'detail' && screen === 'diff' && !state.diffPatch) {
    for (const part of wrapVisible('select an edit in Traces to see its diff', Math.max(1, inner - 2))) {
      out.push(depth === 'none' ? ` ${part}` : `\x1b[2m ${part}\x1b[0m`);
    }
  }
  if (screen === 'map' && state.views !== null) {
    const tree = buildMapTree(arr(view<{ files?: unknown[] }>(state, 'changemap')?.files) as never, undefined, state.sort);
    // ONE row: the map's heading, the session-wide actions beside it, or — while one of them has
    // asked something — the question itself, full width. They are mutually exclusive by nature (the
    // buttons are inert while a confirmation stands), and sharing the heading's row costs the ledger
    // nothing: a toolbar of its own spent a third of the map's body in the default layout.
    //
    // `A`/`U` reached none of this from here: the map's rows carry no edit ids, so the
    // everything-verbs resolved to an empty set and did nothing at all.
    out.push(
      mapOwnsConfirm(state)
        ? mapConfirmLine(state.confirm!, inner, depth)
        : renderMapToolbar(tree as MapNode, inner, depth, g.rule !== "-", state.sort, filterSummary(state))
    );
    // The column headings, from the same layout the rows use, so a label can never sit over the
    // wrong number.
    out.push(mapColumnHeader(inner, g, depth));
  }
  return out;
}

/**
 * Is this question the MAP's to ask?
 *
 * Path-scoped, session-scoped and the finishing verb are all raised from the map's own buttons, so
 * the map draws them and the status row must not repeat the same sentence at the other end of the
 * screen. An id-set question (Traces, Prompts) is not the map's and keeps the status row.
 */
export function mapOwnsConfirm(state: DashState): boolean {
  const q = state.confirm;
  return !!q && (q.under !== undefined || q.all === true || q.verb === 'resolve');
}

/** Where the map's decor lines sit, by index, for a hit-test that must agree with the renderer. */
export const MAP_DECOR = { header: 0, actions: 0, columns: 1 } as const;

/** Body rows a pane's LIST may use: its height, less the fixed lines drawn above it. */
export function paneListRows(state: DashState, box: PaneBox, g: Glyphs = defaultGlyphs()): number {
  const screen = paneScreenOf(state, box);
  if (screen === 'diff') return box.body.h;
  const inner = Math.max(1, box.body.w - 1);
  return Math.max(1, box.body.h - decorLines(state, box, screen, inner, g, 'none').length);
}

export function paneVisible(
  state: DashState,
  box: PaneBox,
  g: Glyphs = defaultGlyphs(),
  depth: ColorDepth = 'none'
): { text: string; row: number }[] {
  const w = box.body.w;
  const h = box.body.h;
  const inner = Math.max(1, w - 1); // one column is the cursor gutter
  const screen = paneScreenOf(state, box);
  const out: { text: string; row: number }[] = [];
  const wrapWidth = Math.max(1, inner - 3);

  const push = (text: string, row: number) => {
    if (displayWidth(text) <= inner) {
      out.push({ text, row });
      return;
    }
    // Wrap ONCE, at one width, and never rejoin: wrapping to the full width and re-wrapping the
    // remainder welded a hard-broken token back together with a space, so `…handler.md` rendered as
    // `…handle` + `r.md` — a path that does not exist and the reader cannot tell is wrong.
    //
    // The LEADING INDENT is held out of the wrap and put back. Nesting is carried by that indent —
    // it is how a workflow's per-phase agents, and Fleet's subagents, read as belonging to the row
    // above them — and `wrapVisible` splits on spaces, so the indent arrived as a run of empty words
    // and was silently collapsed. An indented row that wrapped came back flush against the margin,
    // where it reads as a top-level row: not a lost space, a lost relationship.
    const indent = /^ */.exec(text)?.[0] ?? '';
    const parts = wrapVisible(text.slice(indent.length), Math.max(1, wrapWidth - indent.length));
    out.push({ text: `${indent}${parts[0] ?? ''}`, row });
    for (const part of parts.slice(1)) out.push({ text: `  ${g.wrap}${part}`, row });
  };

  if (state.views === null) {
    const away = state.reviewMachine;
    if (state.reviewFinding) push(`  ${state.reviewFinding}`, -1);
    else if (!away) out.push({ text: '  building…', row: -1 });
    else push(away.error ? `  ${away.error}` : `  reading this session's review from ${away.label}…`, -1);
    return out;
  }

  if (screen === 'diff') {
    const rich = richDiffFor(state, inner, g, depth);
    // Nothing selected: the pane's decor says what to do. It is computed for every face (the row
    // budget subtracts it) but was only ever DRAWN on the list faces, so the diff face sat blank.
    if (!rich.length) {
      for (const text of decorLines(state, box, screen, inner, g, depth)) out.push({ text, row: -1 });
      return out;
    }
    // A diff is READ, not picked from: every line is tagged -1 so no cursor band lands on one. The
    // pane scrolls instead, which is what `panes.scroll.detail` is for.
    const from = Math.max(0, Math.min(state.panes?.scroll?.detail ?? 0, Math.max(0, rich.length - 1)));
    // A standing find MARKS its matches, and does so only on the rows actually drawn — the highlighter
    // walks a line's escapes, so paying for it on a 4,000-line patch to style the 30 on screen would be
    // a per-keystroke cost for nothing. Applied AFTER the memo, deliberately: the memo is keyed on the
    // patch and the width, and folding a needle into it would evict the whole render on every keypress
    // of a search.
    for (let i = from; i < rich.length && out.length < h; i++) {
      let text = rich[i];
      // SYNTAX first, FIND second. A find mark is reverse-video and composes over any foreground; doing
      // it the other way round would have the tokenizer walk escapes the highlighter had just inserted.
      // Context lines only, and identified by what they carry rather than by re-parsing the patch: an
      // added or removed line arrives already wearing its band, and `\x1b[` at the head is exactly what
      // says so. Restricting it here — on the drawn rows — is what keeps a 4,000-line patch costing
      // the same as a 40-line one.
      // The test is for a BACKGROUND specifically: a banded row opens with `\x1b[48…`. Testing for
      // any escape let a row that had lost its band (foreground-only bytes from a pre-coloured
      // patch) through to the tokenizer, which then chewed the embedded escape into literal
      // `[31m` text on screen.
      // NOT on the diff face: `renderRichDiff` colours its own code now, and running the tokenizer
      // over a string that already carries escapes chews them into literal `[38;2;…m` text.
      if (state.syntax && depth !== 'none' && screen !== 'diff' && !/^\x1b\[48[;5]/.test(text)) {
        text = highlightSource(text, depth);
      }
      if (state.findNeedle) text = highlightVisible(text, state.findNeedle);
      out.push({ text, row: -1 });
    }
    return out;
  }

  // NEVER POSITIONED IS NOT "POSITIONED AT THE TOP".
  //
  // The Agent pane is a live tail — its rows run oldest to newest — and an absent scroll meant row
  // zero, so it opened on the oldest activity in the session and stayed there. That is the correct
  // reading for a reader who scrolled up on purpose, and the wrong one for a pane nobody has
  // touched yet; the two were indistinguishable because both read as 0. An UNSET scroll on a tail
  // pane starts at the end.
  const stored = state.panes?.scroll?.[box.id];
  const tailPane = box.id === 'claude';
  const sub: DashState = {
    ...state,
    screen: screen as ScreenId,
    cursor: state.panes?.cursor?.[box.id] ?? 0,
    scroll: stored ?? (tailPane ? Math.max(0, paneRowCount(state, box, g) - paneListRows(state, box)) : 0),
  };
  for (const text of decorLines(state, box, screen, inner, g, depth)) out.push({ text, row: -1 });
  const rows = rowsFor(sub, inner, g, depth);
  if (!rows.length) {
    /**
     * AN EMPTY PANE SAYS WHAT TO DO NEXT, not only that it is empty.
     *
     * "nothing on Traces" is true and useless: it reads the same whether Claude has not edited
     * anything yet or the reader has a filter standing that hides every row, and those need different
     * next actions. The pane is the only place anyone is looking, so it is where the answer goes.
     *
     * The pre-payload case is NOT here: `views === null` never reaches this branch, because the panes
     * already draw "building…" while the first read is in flight. A third message for it would be
     * unreachable code that reads like a covered case.
     */
    const spec = PANE_SPECS.find((p) => p.id === box.id)!;
    // The TAB, not the pane. "nothing on Dashboards" is the same sentence whether Workers is empty,
    // Tasks is empty, or Processes is — and a reader looking at Workers wants to know about Workers.
    const tabIdx = state.panes?.tab?.[box.id] ?? 0;
    const title = spec.tabs.length ? (spec.tabs[tabIdx] ?? spec.title) : spec.title;
    /**
     * "EMPTY" AND "NEVER ASKED FOR" ARE DIFFERENT ANSWERS, and this pane used to give the same one to
     * both. The allow-list in app.ts decides which views a screen requests; a screen missing from it
     * gets a payload without its view and renders an honest-looking nothing — the failure that file's
     * own comment calls out as forbidden. Naming the absent view turns a shrug into a lead.
     */
    const feeds: Record<string, string> = {
      agents: 'multitask', workflows: 'multitask', tasks: 'multitask',
      'sessions-nav': state.allSessions ? 'sessions' : 'multitask',
      'session-detail': state.allSessions ? 'sessions' : 'multitask',
      prompts: 'prompts', feed: 'feed', observations: 'observations',
      processes: 'processes', edits: 'list', audit: 'risk',
      claude: 'sessions',
    };
    const feed = feeds[screen];
    const missing = feed !== undefined && view(state, feed) === null;
    const why = state.filter
      ? `nothing on ${title} matching /${state.filter} — esc clears the filter`
      : missing
          ? `${title} has no data to draw: the “${feed}” view did not arrive in this refresh`
          : screen === 'workflows'
            ? 'no Workflow-tool runs in this session — plain subagent fan-outs appear on Workers'
            : `nothing on ${title} yet — it fills in as the agent works`;
    for (const part of wrapVisible(why, Math.max(1, inner - 2))) {
      out.push({ text: depth === 'none' ? `  ${part}` : `\x1b[2m  ${part}\x1b[0m`, row: -1 });
    }
    return out;
  }
  const from = Math.max(0, Math.min(sub.scroll, Math.max(0, rows.length - 1)));
  /**
   * A STICKY FILE HEADER while the pane is scrolled into a file's edits.
   *
   * Traces groups by file, and a file with forty edits scrolls its own header off the top — so the
   * reader is looking at "#231 +4 −1" rows with nothing on screen saying which file they belong to,
   * in a tool whose next keystroke reverts one of them. The path is exactly the thing you lose while
   * scrolling, so it is pinned: the nearest header at or above the first visible row, drawn once at
   * the top and skipped in the body so it never appears twice.
   */
  let sticky = -1;
  if (screen === 'edits' && from > 0) {
    // The FILENAME header, never its metrics continuation (`f…:m`, `cont`) — both keys start with `f`,
    // and pinning the metrics line would strand the reader with counts and no path.
    for (let r = from; r >= 0; r--) {
      if (rows[r].key?.startsWith('f') && !rows[r].cont) { sticky = r; break; }
    }
    if (sticky >= 0 && sticky < from) {
      out.push({ text: depth === 'none' ? rows[sticky].cells : `\x1b[2m${rows[sticky].cells}\x1b[0m`, row: -1 });
    }
  }
  for (let r = from; r < rows.length && out.length < h; r++) {
    // A MARKED row says so, on the row itself. A selection set the reader cannot see is a set they
    // will act on by accident — and `a` acting on six files instead of the one under the cursor is
    // exactly the surprise this product exists to prevent.
    const row = rows[r];
    const isMarked = state.marked?.size && row.ids.length > 0 && row.ids.every((id) => state.marked!.has(id));
    push(isMarked ? `${g.marked ?? '*'}${row.cells.replace(/^ /, '')}` : row.cells, r);
  }
  return out;
}

/**
 * How many LOGICAL rows this pane's face has — what the cursor, or the scroll, is bounded by.
 *
 * For the Diff face that is VISUAL lines, because a diff is scrolled rather than picked from. It
 * resolves the face through `paneScreenOf` for the same reason `paneVisible` does: reading the tab
 * table here while the renderer read the selection is what made Detail report zero rows for a face
 * that was drawing correctly, which pinned its scroll at the top forever.
 */
export function paneRowCount(state: DashState, box: PaneBox, g: Glyphs = defaultGlyphs()): number {
  const screen = paneScreenOf(state, box);
  if (screen === 'diff') return richDiffFor(state, Math.max(1, box.body.w - 1), g, 'none').length;
  if (state.views === null) return 0;
  const sub: DashState = { ...state, screen: screen as ScreenId };
  return rowsFor(sub, Math.max(1, box.body.w - 1), g).length;
}

/** How many rows of an edit's patch an expanded bubble shows before handing off to the review. A
 *  BOUND, not a truncation: the row below says how many more there are and where they live. */
const PREVIEW_ROWS = 10;
/** Rows of reasoning a blob shows before folding. Three is what the references settled on: enough
 *  to see what the agent was after, short enough that six calls do not bury the work. */
const THOUGHT_ROWS = 3;


/**
 * Is the CURRENT session working right now — by either signal we have: the sessions view's own active
 * flag or the multitask self row's phase. One derivation, used by the status blob and the runtime's
 * ambient-timer stamping, so "running" can never mean two different things.
 */
export function sessionActive(state: DashState): boolean {
  const sess = arr(view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions).find((v) => str((v as Record<string, unknown>).id) === state.session) as
    | Record<string, unknown>
    | undefined;
  const self = arr(view<{ agents?: unknown[] }>(state, 'multitask')?.agents).find((a) => (a as Record<string, unknown>).self === true) as
    | Record<string, unknown>
    | undefined;
  return sess?.active === true || str(self?.phase) === 'working';
}

/**
 * ONE feed entry, drawn as a blob — the head row that names the verb, what it acted on and how it
 * ended, plus (while open) what the agent said, what the tool noted, and what it changed.
 *
 * Shared by the Observatory's conversation and the dashboard's Claude pane on purpose. It was once
 * written twice, and the copies drifted: one grew targets, tallies, thinking, shell styling and banded
 * previews while the other went on printing a tool name and a timestamp. One definition is the only
 * thing that keeps two surfaces of the same product from disagreeing about what a tool call looks like.
 *
 * Rows come back with NO left margin — row 0 is the head, right-aligned within `o.width`, and body
 * rows are indented two. A caller that wants a gutter adds it, because only the caller knows
 * whether one is already there.
 */
/**
 * The blob key and the edit behind every action/permission row of a feed.
 *
 * The SAME keys both renderers assign, derived without rendering anything — so fetching the patch a
 * blob will need does not depend on which surface happens to be up. It used to run off the Agent
 * screen's own geometry, which is why the dashboard's Agent pane drew head rows with no change
 * under them: nothing had asked for the patches.
 */
export function feedBlobKeys(state: DashState): { key: string; editId?: number }[] {
  const entries = arr(view<{ entries?: unknown[] }>(state, 'feed')?.entries);
  const out: { key: string; editId?: number }[] = [];
  let runTs = -1;
  let run = -1;
  for (const raw of entries) {
    const e = raw as Record<string, unknown>;
    if (!str(e.label)) continue;
    const kind = str(e.kind);
    if (kind !== 'action' && kind !== 'permission') continue;
    const ts = num(e.ts);
    run = ts === runTs ? run + 1 : 0;
    runTs = ts;
    // The FETCH key uses the display id too (editId ?? previewId), so a row the strict pass could not
    // attribute still has its diff fetched and shown; keep/undo keys stay strict (built at blobs.push).
    const fetchId = num(e.editId) || num(e.previewId);
    out.push({ key: `agent:${ts}:${run}`, ...(fetchId ? { editId: fetchId } : {}) });
  }
  return out;
}

export function agentBlob(
  state: DashState,
  e: Record<string, unknown>,
  o: {
    g: Glyphs;
    depth: ColorDepth;
    width: number;
    open: boolean;
    lastThought?: string;
    /** Rows of reasoning before it folds. Absent = show it whole (a surface that scrolls). */
    thoughtRows?: number;
    /** Where the rest is, for a caller that DOES bound. Required in spirit: a count with no way to
     *  reach what it counted is the silent skip this project treats as a defect. */
    more?: string;
    /** Draw the whole blob as a herdr-style BOX: the identity on the top edge, the
     *  body inside `│…│`, a foot — like every pane. Off = the flat rail form. */
    box?: boolean;
  }
): { rows: string[]; thought: string; moreRow?: number } {
  const { g, depth } = o;
  const isOpen = o.open;
  let lastThought = o.lastThought ?? '';
  let moreIdx = -1; // the fold-hint row's index within `rows` — the click target for the full diff
  const out: string[] = [];
  // Box mode: the identity rides the box's top edge instead of a content row — set in the head block,
  // read at the return.
  let boxTitle = '';
  let boxRight = '';
  const label = str(e.label);
  const detail = str(e.detail);
  const kind = str(e.kind);
  const wrapW = Math.max(8, o.width - 2);
  // Foreign bytes: an agent's own escapes must not reach a NO_COLOR terminal, and SGR conceal must
  // never hide text anywhere.
  const scrub = (l: string) => (depth === 'none' ? l.replace(/\x1b\[[0-9;]*m/g, '') : l.replace(/\x1b\[8m/g, ''));
  const wrapAt = (l: string) => (displayWidth(l) <= o.width ? [l] : wrapVisible(l, wrapW));
  /**
   * ONE RAIL DOWN THE WHOLE BODY, so a blob reads as a block rather than as a head row followed by
   * unattached lines.
   *
   * Claude Code gets the same effect from a two-cell gutter and an elbow — `  ⎿  ` — with every
   * wrapped continuation aligned under the content at column five. We cannot draw that elbow: the
   * font census rules the box-drawing set out (it is absent from Menlo Bold, VS Code's default macOS
   * terminal font), and `▐` is the one bar measured present everywhere. A continuous rail is also
   * the stronger signal for us, because these bodies are long — every bubble opens expanded — and a
   * marker on the first row alone would stop tying the tenth row to anything.
   *
   * Content therefore lands at a FIXED column whatever the row is: reasoning, a tool's note, output
   * and a diff all align, where before each kind picked its own indent.
   */
  // In a box the LEFT BORDER is the rail — a second `▐` inside it would be a double margin, so the box
  // form drops it and the body sits one column in from `│`.
  const rail = o.box ? '' : depth === 'none' ? `  ${g.bar} ` : `  \x1b[2m${g.bar}\x1b[0m `;
  const bodyW = Math.max(8, wrapW - 2);
  const dimRow = (t: string) => (depth === 'none' ? `${rail}${t}` : `${rail}\x1b[2m${t}\x1b[0m`);
      // A COLLAPSED one-line blob (the feed-wall redesign): twig, accent verb, dim
      // target, and a status mark that carries ok/fail/pending by SHAPE. The detail (output,
      // full command) lives behind the twig — folded, never truncated.
      // EXPANDED by default. The open-set therefore marks what the reader has COLLAPSED —
      // the inverse of the observatory's lists, because here the detail is the point and the
      // fold is the exception.
      const twig = isOpen ? g.open : g.closed;
      // The mark is the row's STATE, so it follows `ok` wherever the row sets one. A permission
      // hardcoded to 'pending' wore the unanswered mark forever — including on the answer itself,
      // which is a settled fact. An ask nothing ever answered still shows pending, which is the
      // one thing that mark is genuinely for.
      const mark =
        e.ok === false
          ? depth === 'none' ? g.undone : tint(g.undone, 'risk', depth)
          : e.ok === true
            ? depth === 'none' ? g.kept : tint(g.kept, 'kept', depth)
            : kind === 'permission'
              ? depth === 'none' ? g.pending : tint(g.pending, 'pending', depth)
              : depth === 'none' ? g.kept : tint(g.kept, 'kept', depth);
      const clean = scrub(label);
      const sp = clean.indexOf(' ');
      const verb = sp > 0 ? clean.slice(0, sp) : clean;
      const rest = sp > 0 ? clean.slice(sp) : '';
      // THE TARGET RIDES THE HEAD ROW. It used to be pushed to a line of its own, which cost a row
      // per call and left the COLLAPSED row — the one that most needs it — reading `> Edit +`.
      const target = scrub(str(e.target));
      // A SHELL CALL IS DRAWN AS A SHELL CALL. `Bash  npm test` spends the head row's most
      // valuable column on the word "Bash", which the `$` says in one character and says better —
      // every agent CLI surveyed leads a shell call with its command, not with the tool's name.
      // The kind comes from core's own category, never from matching the tool name against a list
      // of spellings.
      const isExec = str(e.category) === 'exec' && !!target;
      // The DIFF uses the display id (editId ?? previewId) so an edit the strict pass could not attribute
      // still shows its change; the row's keep/undo `ids` (built by the caller) stay on the strict editId.
      const eid = num(e.editId) || num(e.previewId);
      const prev = eid ? state.editPreviews?.[eid] : undefined;
      // The one outcome fact this screen can state without inventing it: the patch is already in
      // hand. Duration and exit code are NOT recorded, so no row claims them.
      const tally = prev ? tallyPatch(prev) : null;
      const left = isExec ? `${twig} $ ${target}` : `${twig} ${clean}${target ? `  ${target}` : ''}`;
      const leftPainted =
        depth === 'none'
          ? left
          : isExec
            ? `${twig} ${tint('$', 'accent', depth)} ${highlightShell(target, depth)}`
            : `${twig} ${tint(verb, 'accent', depth)}\x1b[2m${rest}\x1b[0m${target ? `  \x1b[2m${target}\x1b[0m` : ''}`;
      const count = tally ? `+${tally.add} -${tally.del}` : '';
      const countPainted =
        !tally || depth === 'none'
          ? count
          : `${tint(`+${tally.add}`, 'kept', depth)} ${tint(`-${tally.del}`, 'risk', depth)}`;
      // WHEN, as the RIGHTMOST column. Rightmost rather than beside the tally so
      // it lines up down the pane whatever the tally's width — a timestamp that wanders is one
      // nobody reads. `relTime` tops out at "12mo ago", so eight columns holds every form of it.
      const at = num(e.ts);
      const stamp = at && o.width >= 56 ? relTime(at, state.now).padStart(12) : '';
      const right = [count, mark, stamp].filter(Boolean).join('  ');
      const rightPainted = [
        count ? countPainted : '',
        mark,
        stamp ? (depth === 'none' ? stamp : `\x1b[2m${stamp}\x1b[0m`) : '',
      ].filter(Boolean).join('  ');
      // Right-aligned when it fits, its own row when it does not. A deep path plus a tally can
      // genuinely exceed the pane, and this project does not ellipsise content to make a column
      // line up.
      //
      // The LEADING SPACE is not cosmetic: it is the column the blob cursor overwrites with its
      // marker, which is the only way a `--color none` terminal can show which row is selected.
      // Pushing the row without it silently un-selected every head row.
      const budget = o.width;
      // In box mode the identity is the box's TITLE (verb/target, no twig — the box is the container)
      // and the counts ride its right edge, like a pane. PAINTED, and rendered with `edgePainted` so the
      // box glyphs dim but the verb accent, the +N/−N and the ✓ keep their colour.
      // The flat (non-box) form keeps the head as its own row.
      boxTitle =
        depth === 'none'
          ? isExec
            ? `$ ${target}`
            : `${clean}${target ? `  ${target}` : ''}`
          : isExec
            ? `${tint('$', 'accent', depth)} ${highlightShell(target, depth)}`
            : `${tint(verb, 'accent', depth)}\x1b[2m${rest}\x1b[0m${target ? `  \x1b[2m${target}\x1b[0m` : ''}`;
      boxRight = rightPainted;
      if (!o.box) {
        const gap = budget - displayWidth(left) - displayWidth(right);
        if (gap >= 2) out.push(`${leftPainted}${' '.repeat(gap)}${rightPainted}`);
        else {
          for (const part of wrapAt(leftPainted)) out.push(part);
          out.push(`${' '.repeat(Math.max(0, budget - displayWidth(right)))}${rightPainted}`);
        }
      }
      // A boxed blob carries its identity in the box TITLE, which fitVisible truncates when it runs
      // long. This screen is a FEED that must show EVERYTHING — so whenever the
      // title cannot hold the target, the FULL thing also rides the body on expand, wrapped, for
      // EVERY blob kind. A shell call renders its real `cmd` (the un-flattened command core carries,
      // newlines and all — `target` is the one-line form, itself capped at 300); everything else
      // renders its whole target. Only when boxed, open, and it would truncate — a short one is
      // never drawn twice.
      const cmdWhole = isExec ? str(e.cmd) || target : '';
      // A multiline command FITS the title once flattened — but the flattening is itself the loss
      // (three commands read as one). Lost newlines open the body exactly like a width overflow.
      if (o.box && isOpen && (displayWidth(target) > o.width - 18 || cmdWhole.includes('\n'))) {
        if (isExec) {
          for (const line of cmdWhole.split('\n')) for (const part of wrapVisible(highlightShell(line, depth), wrapW)) out.push(part);
        } else {
          for (const part of wrapVisible(scrub(target), wrapW)) out.push(dimRow(part));
        }
      }
      // WHAT THE AGENT SAID OR THOUGHT FIRST. It is carried forward per message by the transcript parser, so
      // consecutive calls from one message share it — shown only where it CHANGES, or every row
      // repeats the paragraph above it. Labelled by which it actually is: prose was addressed to
      // the reader, a thinking block was not, and calling one the other misrepresents both.
      const think = scrub(str(e.reasoning));
      if (isOpen && think && think !== lastThought) {
        const label = str(e.reasoningKind) === 'thinking' ? 'thinking' : 'said';
        // Markdown, like the CLI — inline spans only: the row is a one-line
        // collapse, so block marks (headings, bullets) have no line to own.
        const rows = wrapVisible(`${label} — ${mdAnsiInlineDim(think.replace(/\s+/g, ' '), depth)}`, Math.max(8, wrapW - 2));
        if (!o.thoughtRows || rows.length <= o.thoughtRows) {
          for (const part of rows) out.push(dimRow(part));
        } else {
          const cutT = middleOut(rows, o.thoughtRows);
          for (const part of cutT.head) out.push(dimRow(part));
          if (cutT.hidden) {
            out.push(dimRow(`${g.fold} +${cutT.hidden} more row${cutT.hidden === 1 ? '' : 's'}${o.more ? ` — ${o.more}` : ''}`));
          }
          for (const part of cutT.tail) out.push(dimRow(part));
        }
      }
      if (think) lastThought = think;
      // The tool's own note — a shell command's description, a search's path — behind the rail
      // when it belongs to a shell call, so a command and its context read as one terminal block.
      const note = scrub(str(e.note));
      if (isOpen && note) {
        for (const part of wrapVisible(note, bodyW)) out.push(dimRow(part));
      }
      if (isOpen && detail) {
        for (const part of wrapVisible(scrub(detail), bodyW)) out.push(dimRow(part));
      }
      // THE CHANGE ITSELF, in the same bands the Diff pane draws. The patch is
      // fetched once per edit by `wantPreview`; this renderer stays pure and draws only what is
      // already in state, so a bubble with no patch yet simply shows its detail.
      if (isOpen && prev) {
        // BOUNDED BEFORE RENDERING, and bounded in the unit the fold marker reports. Every bubble
        // opens expanded on this screen, and rendering each one's whole patch to show ten rows of
        // it measured quadratic in bubbles open — 8 seconds to rebuild the head with 32 open. It
        // is cut to PREVIEW_ROWS *source* lines, so the "+N lines" below is exact rather than an
        // estimate of rendered rows the reader cannot count.
        const cut = boundPatch(prev, PREVIEW_ROWS);
        const lines = renderRichDiff(cut.patch, {
          // The body sits three columns in, so the band must be that much narrower to end where
          // the head row's status mark does. `richdiff`'s own contract is that the band reaches
          // the pane edge; a band that stops short of it draws the ragged margin that note warns
          // about, and one that overruns puts the rows out of alignment with their own header.
          cols: Math.max(20, bodyW),
          color: depth,
          glyphs: g,
          // Head the change with its path: the
          // `● Verb(path)` line names the file the bands belong to, wrapped rather than clipped, so a
          // diff is never an unlabelled patch. `added`/`removed` are withheld, so richdiff draws the
          // path line without a second ± summary the head row already carries.
          header: true,
          verb,
          path: str(e.target),
          hunks: 'elide',
          // A Write shows the file it wrote, coloured the way an editor would colour it — the
          // green band over every row of a new file says only "this is new", which the row above
          // already said.
          newFile: 'source',
          syntax: state.syntax !== false,
        });
        for (const l of lines) out.push(`${rail}${l}`);
        if (cut.hidden) {
          // The row is a BUTTON — the head
          // build records its line so the click opens the whole patch as the overlay.
          moreIdx = out.length;
          const more = `${g.fold} +${cut.hidden} line${cut.hidden === 1 ? '' : 's'} · click here for the full diff`;
          out.push(dimRow(more));
        }
      }
  // Boxed: the whole blob in a herdr-style outline, identity on the top edge, counts
  // on the right, body inside — every activity reads as its own block, like the panes.
  // Boxing puts a top edge ABOVE the content, so the hint's index shifts by one row.
  return {
    rows: o.box ? boxAround(boxTitle, out, o.width, false, g, depth, boxRight, true) : out,
    thought: lastThought,
    ...(moreIdx >= 0 ? { moreRow: o.box ? moreIdx + 1 : moreIdx } : {}),
  };
}
/** Shared live/transcript text grammar: shell rows, dim thought, markdown tables. A user's prompt is
 *  not text in this grammar: its box is drawn by the conversation (observatory-rows), so an agent
 *  line that begins with `> ` is the agent's own blockquote. */
export function agentTextRows(l0: string, rightW: number, depth: ColorDepth): string[] {
  const l = depth === 'none' ? l0.replace(/\x1b\[[0-9;]*m/g, '') : l0.replace(/\x1b\[8m/g, '');
  const wrapW = Math.max(8, rightW - 4);
  // A COMMAND LINE, drawn as one: the prompt marker dim, the command itself at full weight —
  // it is the thing the reader is watching for, and dimming it with the chrome hid it.
  if (l.startsWith('\u0001$ ')) {
    const cmd = l.slice(3);
    if (depth === 'none') return [`$ ${cmd}`];
    return [`\x1b[2m$\x1b[0m ${tint(cmd, 'accent', depth)}`];
  }
  // THINKING: dim, labelled, and bounded to the same rows a historical blob gives it, so the
  // agent's own words never bury the work it did.
  if (l.startsWith('\u0002')) {
    const dimmed = (t: string) => (depth === 'none' ? t : `\x1b[2m${t}\x1b[0m`);
    // Whole: this screen scrolls, and `driveThought` already caps what it accumulates.
    return wrapVisible(`thinking — ${l.slice(1)}`, wrapW).map(dimmed);
  }
  // VERBATIM rows — a diff preview or a tool's own output, tagged at the source (driveToolContent
  // / the [edit] loop). They are returned untouched so the prose-markdown pass below never rewrites
  // them: a backtick, a `- x` listing line or a `|` table pipe is the agent's literal byte here, not
  // markdown to restyle (the richdiff/output rows already carry their own colour).
  if (l.startsWith('\u0004')) return [l.slice(1)];
  if (/^\[(tool|edit|agent|codex|claude)/.test(l) || l.startsWith('session ') || l.startsWith('— turn ended')) {
    if (depth === 'none') return [l];
    const sp = l.indexOf(']');
    return [sp > 0 ? `${tint(l.slice(0, sp + 1), 'accent', depth)}\x1b[2m${l.slice(sp + 1)}\x1b[0m` : `\x1b[2m${l}\x1b[0m`];
  }
  // The agent's PROSE — rendered as the CLI renders it, not raw markdown.
  return [mdAnsiLine(l, depth)];
}

/** Body lines for one pane: exactly `box.body.h` of them, each exactly `box.rect.w` wide. */
function paneBody(state: DashState, box: PaneBox, g: Glyphs, depth: ColorDepth): string[] {
  const w = box.body.w;
  const h = box.body.h;
  const fit = (t: string) => fitVisible(pad(sanitizeCell(t), w), w);
  const gut = (mark: string, t: string) => fit(`${mark}${t}`);
  const cursorRow = state.panes?.cursor?.[box.id] ?? -1;
  // A two-line edit highlights BOTH lines: they are one subject, and banding only the first makes
  // the stats line look like it belongs to the edit below it. SAME SUBJECT ONLY (the ids must
  // match): `cont` alone also marks every nested Review row, so with the cursor resting on edit
  // rows (N16 stepping) a bare cont test banded the NEXT edit too — two edits highlighted, verbs
  // acting on one.
  const screen = paneScreenOf(state, box);
  const rowsNow = state.views === null || screen === 'diff' ? [] : rowsFor({ ...state, screen: screen as ScreenId }, Math.max(1, box.body.w - 1), g);
  // Same subject = same ids AND the continuation's key DERIVES from the cursor row's (`m<path>:0`
  // continues `m<path>`, `w<id>n` continues `w<id>`). The ids test alone conflated two different
  // ROW KINDS: a single-edit file's open header (`f<file>`, ids [id]) and its nested edit row
  // (`e<id>`, ids [id]) matched, so the cursor on the header banded the edit row too — two rows
  // marked, one subject claimed, and the nesting invisible at depth 'none' (the e2e catch).
  const sameSubject = (a?: { ids?: readonly number[]; key?: string }, b?: { ids?: readonly number[]; key?: string }) =>
    !!a?.ids && !!b?.ids && a.ids.length === b.ids.length && a.ids.every((x, i) => x === b.ids![i]) &&
    !!a?.key && !!b?.key && a.key.startsWith(b.key);
  const inCursor = (r: number) =>
    r === cursorRow || (r === cursorRow + 1 && rowsNow[r]?.cont === true && sameSubject(rowsNow[r], rowsNow[cursorRow]));
  const vis = paneVisible(state, box, g, depth);
  const out: string[] = [];
  for (let i = 0; i < h; i++) {
    const v = vis[i];
    if (!v) {
      out.push(fit(''));
      continue;
    }
    const on = v.row >= 0 && inCursor(v.row);
    // NO ARROW when there is colour. The selection used to be stated twice — a `>` in the gutter AND
    // a band — and two marks for one fact is one mark of noise on every list on screen. The marker is
    // what is left when colour is gone, so it survives at depth 'none' and only there — and only in
    // the FOCUSED pane: monochrome must follow the same one-selection rule as every colour depth.
    const line = gut(on && depth === 'none' && box.focused ? '>' : ' ', v.text);
    if (!on || depth === 'none') {
      out.push(line);
      continue;
    }
    // ONE selection on screen, ever: only the FOCUSED pane's cursor row highlights. The unfocused
    // faint band was tried (as "context") and read as a second selected item both times a user
    // looked at it — the cursor position persists per pane regardless, so nothing is lost.
    if (box.focused) {
      out.push(`\x1b[7m${line}\x1b[0m`);
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Detail's navbar: which edit is shown, its position in the list, and the keys that move between
 * them. Without it the centre is a diff with no address — the reader can see the change but not
 * where they are in the review, which is the question a review tool exists to answer.
 */
export type NavAction = 'keep' | 'undo' | 'prev' | 'next';

export interface NavButton {
  action: NavAction;
  label: string;
  x: number;
  w: number;
  /** False when the button cannot act — nothing selected, or the edit is already resolved. */
  live: boolean;
}

/**
 * The Diff/Map swap lives on the WINDOW BAR, not in this action bar — Detail contributes two chips
 * there, one per face, each with its own function key (see `BAR_ENTRIES`). A second swap inside the
 * pane would be the same control drawn twice, costing width on the row that carries Keep and Undo.
 */

/**
 * The Detail navbar's buttons, laid out once so the renderer and the mouse read the SAME geometry.
 * Recomputing them at the click site is how a button ends up drawn in one place and clickable in
 * another, with nothing on screen to reveal the drift.
 *
 * Buttons are dropped whole, widest-first, when the pane is too narrow — never clipped to a stub
 * that still looks pressable. The keys keep working at every width, so a dropped button costs
 * discoverability, not capability.
 */
export function detailNavButtons(box: PaneBox, state: DashState, g: Glyphs = defaultGlyphs()): NavButton[] {
  const m = state.diffMeta;
  const live = !!m;
  // With nothing selected there is nothing to keep or undo, so those two are ABSENT rather than
  // drawn-but-dim: without colour a dim button and a live one render identically, and a button that
  // looks pressable and silently refuses is worse than one that was never offered. prev/next stay,
  // and stay LIVE — they step the review on, and from nothing picked they pick an end of the list
  // (with groups folded by default, "nothing picked yet" is every session's first frame).
  const all: { action: NavAction; label: string; live: boolean }[] = live
    ? [
        { action: 'keep', label: `${g.kept} Keep`, live },
        { action: 'undo', label: `${g.undone} Undo`, live },
        { action: 'prev', label: '‹ prev', live: true },
        { action: 'next', label: 'next ›', live: true },
      ]
    : [
        { action: 'prev', label: '‹ prev', live: true },
        { action: 'next', label: 'next ›', live: true },
      ];
  // Reserve room for the edit's identity on the left; buttons sit to the right of it.
  const idText = m ? ` ✦ #${m.id}  +${m.added} −${m.removed} ` : ' ';
  for (let drop = 0; drop <= all.length; drop++) {
    const shown = all.slice(0, all.length - drop);
    const need = shown.reduce((n, b) => n + displayWidth(b.label) + 3, 0);
    if (displayWidth(idText) + need + 1 > box.body.w) continue;
    let x = box.body.x + box.body.w - need - 1;
    return shown.map((b) => {
      const w = displayWidth(b.label) + 2;
      const at = x + 1;
      x += w + 1;
      return { ...b, x: at, w };
    });
  }
  return [];
}

/**
 * The edit the review moves to from `curId` — the NEXT (or previous) edit in review order, seen
 * THROUGH folded groups: a folded header's `ids` are its members, so the sequence is every edit the
 * pane addresses, not just the rows on screen. Stepping ROWS instead is the bug this replaces —
 * with groups folded by default the cursor stepped header to header, `followTracesDiff` saw a
 * multi-id row and CLEARED the diff, and the prev/next buttons read as dead in every real session.
 *
 * From nothing picked (curId < 0, or an id the current rows no longer carry) it picks the end the
 * step enters from: `next` → the first edit, `prev` → the last. At a boundary it returns `curId`
 * itself — the caller can then SAY "already at the last edit" instead of silently refetching.
 * Returns -1 only when there are no edits at all.
 */
export function stepReviewId(rows: readonly DashRow[], curId: number, dir: 1 | -1): number {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const r of rows) for (const id of r.ids) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  if (!ids.length) return -1;
  const at = curId >= 0 ? ids.indexOf(curId) : -1;
  if (at < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  const to = at + dir;
  return to < 0 || to >= ids.length ? curId : ids[to];
}

function detailNav(state: DashState, box: PaneBox, g: Glyphs, depth: ColorDepth): string {
  const w = box.body.w;
  const m = state.diffMeta;
  const btns = detailNavButtons(box, state, g);

  const rows = state.views === null ? [] : rowsFor({ ...state, screen: 'edits' }, 40, g);
  const ids: number[] = [];
  for (const r of rows) for (const id of r.ids) if (!ids.includes(id)) ids.push(id);
  const at = m ? ids.indexOf(m.id) : -1;
  const left = m
    ? ` ${tint(`✦ #${m.id}`, 'accent', depth)}  ${tint(`+${m.added}`, 'kept', depth)} ${tint(`−${m.removed}`, 'risk', depth)}${at >= 0 ? `  ${at + 1}/${ids.length}` : ''} `
    : ' ';

  // Assemble by absolute column so what is drawn lands exactly where `detailNavButtons` says.
  const cells: string[] = [left];
  let cur = box.body.x + displayWidth(left.replace(/\x1b\[[0-9;]*m/g, ''));
  for (const b of btns) {
    if (b.x > cur) { cells.push(' '.repeat(b.x - cur)); cur = b.x; }
    const face = ` ${b.label} `;
    cells.push(
      depth === 'none'
        ? face
        : b.live
          ? `${b.action === 'keep' ? '\x1b[48;2;28;70;36m' : b.action === 'undo' ? '\x1b[48;2;86;30;30m' : '\x1b[48;2;54;58;70m'}\x1b[97m${face}\x1b[0m`
          : `\x1b[2m${face}\x1b[0m`
    );
    cur += b.w;
  }
  return fitVisible(pad(cells.join(''), w), w);
}

/** Compose one pane into its full box: title row, tab row, body. */
function paneLines(state: DashState, box: PaneBox, g: Glyphs, depth: ColorDepth): string[] {
  // Boxed: the title becomes the box top (with the counter set into the right edge), the nav/tab/body
  // rows are the box body (`makeBox` insets them by the border), and `boxAround` adds the │ sides and
  // the └──┘ foot. Same total height as the band version — the geometry reserved the foot row.
  if (g.boxes) {
    const spec = PANE_SPECS.find((p) => p.id === box.id)!;
    const chip = BAR_ENTRIES.find((e) => e.pane === box.id);
    const title = `F${chip?.key ?? spec.n} ${chip?.title ?? spec.title}`;
    const inner: string[] = [];
    if (box.navRow >= 0) inner.push(detailNav(state, box, g, depth));
    if (box.tabSpans.length) inner.push(paneTabs(box, g, depth));
    inner.push(...paneBody(state, box, g, depth));
    return boxAround(title, inner, box.rect.w, box.focused, g, depth, paneCounter(state, box.id)[0] ?? '');
  }
  const head = [paneTitle(state, box, g, depth)];
  // Driven by the GEOMETRY, never by the pane's name. Deciding here that Detail draws an action bar,
  // while `makeBox` did not reserve a row for it, is what made every button undrawable-on: the
  // hit-tester called that row body, and the pane composed one line taller than its own box.
  if (box.navRow >= 0) head.push(detailNav(state, box, g, depth));
  // No tabs means no tab row — spending a line on an empty strip cost every tab-less pane a row of
  // content and drew a blank band under its title.
  if (box.tabSpans.length) head.push(paneTabs(box, g, depth));
  return [...head, ...paneBody(state, box, g, depth)];
}

/** The window bar: every pane, open or not, with its jump key and its minimize twig. */
function windowBar(lay: Layout, cols: number, g: Glyphs, depth: ColorDepth): string {
  const cells: string[] = [];
  let at = 0;
  for (const chip of lay.bar) {
    if (chip.x > at) { cells.push(' '.repeat(chip.x - at)); at = chip.x; }
    const twig = chip.open ? g.open : g.closed;
    // The chip's OWN key and title — Detail contributes two of these, one per face, and they are the
    // two things a reader navigates by.
    const text = `F${chip.key} ${twig}${chip.title}`;
    cells.push(chip.focused ? tint(text, 'accent', depth) : chip.open ? text : depth === 'none' ? text : `\x1b[2m${text}\x1b[0m`);
    at = chip.x + chip.w;
  }
  let line = cells.join('');
  if (lay.zoom) {
    // A zoom that is not announced leaves "why can I only see one thing" with no answer on screen.
    const spec = PANE_SPECS.find((p) => p.id === lay.zoom)!;
    const flag = `ZOOM ${spec.title}`;
    const gap = cols - at - displayWidth(flag) - 1;
    if (gap > 0) line += ' '.repeat(gap) + tint(flag, 'pending', depth);
  }
  return fitVisible(pad(line, cols), cols);
}

/**
 * The status row, when Detail is zoomed to the whole terminal: which edit is on screen, and where it
 * lives. Full screen is where the surrounding list is GONE, so the one line that still has room has
 * to carry the edit's identity — otherwise the reader is looking at a diff with no address.
 *
 * A measured ladder, not a `fitVisible` cut. A path trimmed to fit is a path that does not exist,
 * and this one names the file a keystroke away from being reverted.
 */
function zoomedEditBar(state: DashState, lay: Layout, cols: number, depth: ColorDepth): string | null {
  if (lay.zoom !== 'detail') return null;
  const m = state.diffMeta;
  if (!m) return null;
  const id = tint(`edit #${m.id}`, 'accent', depth);
  const plain = tail(m.path);
  const cand = [`${id} · ${m.path}`, `${id} · ${plain}`, `${id}`];
  return cand.find((s) => displayWidth(s) <= cols) ?? `edit #${m.id}`;
}

/** Render the four-window frame. Same contract as `renderDashFrame`: exactly `rows` lines, every
 *  one within the column budget. */
function renderPanes(state: DashState, opts: FrameOpts, lay: Layout, g: Glyphs, depth: ColorDepth): string[] {
  const { cols, rows } = opts;
  // The window bar LEADS. It is the frame's table of contents — every region, its jump key, whether
  // it is open — and a table of contents printed under two rows of session state is one the reader
  // has to hunt for.
  const out: string[] = [
    ...(tabBar(state, lay, cols, g, depth)),
    windowBar(lay, cols, g, depth),
    // The session navbar as its own BOX when the layout reserved the rows for it (lay.navBox) —
    // the same treatment the Agent screen got, same single-source rule: the
    // renderer boxes ONLY when the resolved layout says the chrome is that tall.
    ...(lay.navBox
      // A box is two columns wide at least: at one column its walls alone overran the terminal.
      ? boxAround('session', [sessionRow(state, Math.max(20, cols - 2), g, depth)], cols, false, g, depth).map((l) => fitVisible(l, cols))
      : [sessionRow(state, cols, g, depth)]),
  ];

  const grid: string[] = [];
  // The horizontal band is the COLUMN docks only, decided by DOCK rather than by naming panes — a
  // hand-kept id list is how the first top-dock pane got swept into the band and composed side-by-side
  // with Traces, leaving the whole column band unrendered.
  const dockOf = (id: PaneId) => PANE_SPECS.find((p) => p.id === id)!.dock;
  const band = lay.boxes.filter((b) => dockOf(b.id) !== 'top' && dockOf(b.id) !== 'bottom').sort((a, b) => a.rect.x - b.rect.x);
  const tops = lay.boxes.filter((b) => dockOf(b.id) === 'top').sort((a, b) => a.rect.y - b.rect.y);
  const rendered = new Map<PaneId, string[]>();
  for (const b of lay.boxes) rendered.set(b.id, paneLines(state, b, g, depth));

  // The top dock is drawn ABOVE the column band, full width, in y order (Claude strip, then Prompts).
  for (const top of tops) for (let y = 0; y < top.rect.h; y++) grid.push(rendered.get(top.id)![y] ?? pad('', cols));
  // The seam is the panel edge: dim enough not to compete with content, present enough to divide.
  // With boxes each pane draws its own │ edges, so the column seam is a plain space (a `▐` between
  // two box walls would be a third vertical line). Same width either way — the column geometry holds.
  const seam = g.boxes ? ' ' : depth === 'none' ? g.bar : `\x1b[38;2;72;78;92m${g.bar}\x1b[0m`;
  // The band composes by COLUMN, and a column may STACK panes (Map above Diff, 0.10.0): boxes that
  // share an x render in y order with one seam ROW between them. Joining raw boxes by x put the
  // second stacked pane beside its partner as a phantom third column, which `fitVisible` then
  // silently truncated — a whole pane gone with nothing saying so.
  const columns: PaneBox[][] = [];
  for (const b of band) {
    const last = columns[columns.length - 1];
    if (last && last[0].rect.x === b.rect.x) last.push(b);
    else columns.push([b]);
  }
  for (const c of columns) c.sort((a, b) => a.rect.y - b.rect.y);
  const cellFor = (bs: readonly PaneBox[], y: number, w: number): string => {
    let off = y;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (off < b.rect.h) return rendered.get(b.id)![off] ?? pad('', w);
      off -= b.rect.h;
      if (i < bs.length - 1) {
        // The seam row between stacked panes — the grab handle the resolver placed, drawn as the
        // same rule the pane titles use so its extent is visible with no colour at all.
        if (off === 0) return g.boxes ? pad('', w) : depth === 'none' ? g.rule.repeat(w) : `\x1b[2m${g.rule.repeat(w)}\x1b[0m`;
        off -= 1;
      }
    }
    return pad('', w);
  };
  for (let y = 0; y < lay.colH; y++) {
    grid.push(columns.map((c) => cellFor(c, y, c[0].rect.w)).join(seam));
  }
  const dash = lay.boxes.find((b) => b.id === 'dashboards');
  if (dash) for (let y = 0; y < dash.rect.h; y++) grid.push(rendered.get('dashboards')![y] ?? pad('', cols));

  // One row MORE than the chrome ladder reserves: the status row is drawn only when it has
  // something to say (renderPanes), and the band claims it the rest of the time.
  const bodyH = Math.max(0, rows - lay.chrome.top - chromeBottom(rows) + 1);
  for (let i = 0; i < bodyH; i++) out.push(fitVisible(grid[i] ?? '', cols));

  // Refusal is loud: a pane the reader has a key for that this size cannot hold says what it costs.
  const blocked = lay.blocked
    .map((b) => `${PANE_SPECS.find((p) => p.id === b.pane)!.title} needs ${b.need ? `${b.need} cols` : `${b.needRows} body rows`}`)
    .join(' · ');
  // A map-owned question is drawn IN the map — but only when the map is actually
  // on screen. If the pane is not open at this size, the question comes back here rather than being
  // asked nowhere at all.
  const mapShown = lay.boxes.some((b) => paneScreenOf(state, b) === 'map');
  const status = state.confirm && !(mapShown && mapOwnsConfirm(state))
    ? tint(`${state.confirm.verb}${state.confirm.ids.length ? ` ${state.confirm.ids.length} edit(s)` : ''} — ${state.confirm.label}?  [y/n]`, 'pending', depth)
    : state.error
      ? tint(`! ${state.error}`, 'risk', depth)
      : state.goto
        ? tint(`go to edit #${state.goto}_`, 'accent', depth)
        : blocked
          ? tint(`at this size: ${blocked}`, 'undone', depth)
          : zoomedEditBar(state, lay, cols, depth) ??
            // 'ready' is the IDLE SENTINEL, not a message. Printing it spent a row of the frame
            // telling the reader that nothing had happened.
            (state.status === 'ready' ? '' : state.status);
  // The shared bottom chrome (divider · status · statusline · keys). The status row reclaims its line
  // from the band when it speaks — bottomChrome's splice, so the divider is never eaten.
  return bottomChrome(state, out, cols, rows, status, dockKeys(state, cols), g, depth);
}

/**
 * Tree ViewId -> the ScreenId its body rows come from. `workers` is the `agents` producer, `actions`
 * the `audit` one, `agent` the `claude` strip; the rest match by name. `diff` has no `rowsFor` producer
 * (it renders through the rich-diff path, not the row list) and is not reachable from the observatory
 * tree — mapped `null` so a future review-as-tree handles it deliberately rather than by accident.
 */
export const VIEW_SCREEN: Record<ViewId, ScreenId | null> = {
  workers: 'agents',
  // The sidebar renders the SAME `agents` producer in a minimal mode (`treePaneRows` passes it).
  'agents-mini': 'agents',
  // The master/detail pair — each its own producer, both reading `multitask` (see `feeds`).
  'sessions-nav': 'sessions-nav',
  'session-detail': 'session-detail',
  tasks: 'tasks',
  workflows: 'workflows',
  processes: 'processes',
  feed: 'feed',
  observations: 'observations',
  actions: 'audit',
  prompts: 'prompts',
  edits: 'edits',
  map: 'map',
  diff: null,
  agent: 'claude',
};

/** The title band for a TREE pane — the same three colourless channels `paneTitle` uses (a filled
 *  band, the bracketed-by-position name, a rule out to the edge) but sourced from the view's own spec,
 *  because a tree pane has no `PaneId` and no F-key to look up. */
function treeTitle(view: ViewId, focused: boolean, w: number, g: Glyphs, depth: ColorDepth, note?: string): string {
  // The focused pane's title is CORAL (matching the coral box border) — no `>` marker;
  // the colour is the focus signal, and at NO_COLOR the collapsed strip is a whole-width solid rule.
  const head = ` ${VIEW[view].title}${note ? ` · ${note}` : ''} `;
  const line = head + g.rule.repeat(Math.max(0, w - displayWidth(head)));
  const fitted = fitVisible(pad(line, w), w);
  if (depth === 'none') return fitted;
  return focused ? `${focusBand(depth)}${tint(fitted, 'accent', depth)}\x1b[0m` : `${titleBandDim(depth)}${fitted}\x1b[0m`;
}

/** One tree pane's rows: its title band, then its body from the SAME producer the dashboards pane
 *  uses, fitted to the box. No scroll or cursor yet — those are per-pane state the tree tab does not
 *  carry until the runtime wires it (a later milestone); the top rows that fit are shown. */
/** The data rows a tree pane shows for `view` at inner column width `w` — the ONE place that maps a
 *  ViewId to its screen and asks the (memoized) row producer. treePaneLines (paint), treeScrollBy
 *  (wheel), and the worker-scope click all read it, so a scrolled click and its painted row can never
 *  disagree about which worker sits where. */
export function treePaneRows(state: DashState, view: ViewId, w: number, g: Glyphs, depth: ColorDepth, paneId = 'obs-detail'): DashRow[] {
  const screen = VIEW_SCREEN[view];
  if (screen === null || (state.views === null && view !== 'sessions-nav' && view !== 'session-detail')) return [];
  // The sidebar draws the `agents` producer in `mini` mode; the full Workers pane draws it whole.
  const workersMode = view === 'agents-mini' ? 'mini' : undefined;
  return rowsFor({ ...state, screen, workersMode, observatoryPane: paneId } as DashState, Math.max(1, w - 1), g, depth);
}

/** The leaf pane ids whose view has NO rows — the auto-hide set. Computed the ONE way by both the
 *  renderer (renderTreeBody) and the hit-test (treeGeom), so a collapsed pane's rect is identical in
 *  each and a click still lands where the glyph is. `rowsFor` is memoised AND (for the width-independent
 *  tree producers) width-normalised in its key, so this probe and the pane's own render share one build
 *  — even in box mode, where the pane renders two columns narrower. */
export function emptyLeaves(state: DashState, root: PaneNode, cols: number, g: Glyphs, depth: ColorDepth): Set<string> {
  const empty = new Set<string>();
  for (const { id, view } of leafPanes(root)) {
    // The conversation detail is never empty (its header alone is rows) and is the one producer whose
    // build is expensive — 780 ms on a 4,100-event session, paid a second time per paint here (TUI
    // sweep, 2026-09-23). It is not probed. Neither is the master: it always has a machine's header, or
    // says it is connecting, and at the full width asked here it was a second build every frame.
    if (view === 'session-detail' || view === 'sessions-nav') continue;
    if (treePaneRows(state, view, cols, g, depth, id).length === 0) empty.add(id);
  }
  return empty;
}

/**
 * A tree pane as a full herdr-style BOX: `┌─ Title ─┐` top with the title inline, `│…│` sides, a
 * `└──┘` foot. Borders draw NON-BOLD (Menlo regular has box-drawing; its BOLD face does not — the
 * census), coral when the pane is focused, faint otherwise. Reached only when `g.boxes` is on.
 */
/**
 * The ONE box primitive: a solid outline around `body`, `w` wide and `body.length + 2` tall — a
 * `┌─ title ─┐` top with the title set into the edge, `│…│` sides, a `└──┘` foot. Each body line is
 * fit to the inner width. Borders draw NON-BOLD (so Menlo's regular box-drawing renders even in VS
 * Code — only its BOLD face drops them), coral when `focused`, faint otherwise. Tree panes, dock
 * panes, the agent regions and the tab bar all wrap through this, so every outline is one weight.
 */
export function boxAround(title: string, body: readonly string[], w: number, focused: boolean, g: Glyphs, depth: ColorDepth, right = '', edgePainted = false, bg = ''): string[] {
  const iw = Math.max(0, w - 2);
  // Fill the WHOLE box (border + interior) with a background when one is asked for (the user-prompt
  // bubble, so it stands out). Re-assert `bg` after every inner reset, or the border's own `\x1b[0m`
  // would clear the fill mid-row. Default '' → byte-identical to every existing caller.
  const paint = (row: string): string => (bg && depth !== 'none' ? `${bg}${row.split('\x1b[0m').join(`\x1b[0m${bg}`)}\x1b[0m` : row);
  const border = (s: string): string => (depth === 'none' ? s : focused ? tint(s, 'accent', depth) : `\x1b[2m${s}\x1b[0m`);
  const v = border(g.box.v);
  let top: string;
  if (edgePainted && depth !== 'none') {
    // The title and the right label carry their OWN colours — a blob's verb accent, its +N/−N in green
    // and red, its ✓ — so wrapping the whole top edge in the border's dim (as the default does) FLATTENS
    // them, which is exactly the "boxed blobs lost their colours" report. Paint only the box GLYPHS dim
    // and set the already-coloured labels between them; the title is fit to the room they leave.
    const footW = right ? 3 + displayWidth(right) : 1; // ` right ┐`  |  `┐`
    const t = fitVisible(title, Math.max(0, w - 4 - footW)); // 4 = ┌─ + the two flanking spaces
    const fill = Math.max(0, w - (4 + displayWidth(t)) - footW);
    const footPainted = right ? ` ${right} ${border(g.box.tr)}` : border(g.box.tr);
    top = `${border(g.box.tl + g.box.h)} ${t} ${border(g.box.h.repeat(fill))}${footPainted}`;
  } else {
    // A right-hand label (a pane's counter) rides the top edge, set into the border before the ┐.
    const foot = right ? ` ${right} ${g.box.tr}` : g.box.tr;
    // Fit the TITLE so the foot always survives: a title wider than the box otherwise overflows and the
    // fitVisible below truncates the ┐ (and the right label) clean off the edge — which is exactly the
    // "blob boxes lost their right side" bug on a no-colour terminal. The colour path
    // above already reserves it; this makes the monochrome path do the same.
    const t = fitVisible(title, Math.max(0, w - 4 - displayWidth(foot)));
    const head = `${g.box.tl}${g.box.h} ${t} `;
    const fill = Math.max(0, w - displayWidth(head) - displayWidth(foot));
    top = border(fitVisible(pad(head + g.box.h.repeat(fill) + foot, w), w));
  }
  const rows = body.map((l) => `${v}${fitVisible(pad(l, iw), iw)}${v}`);
  const bottom = border(g.box.bl + g.box.h.repeat(Math.max(0, w - 2)) + g.box.br);
  return [top, ...rows, bottom].map(paint);
}

/** Transcript height shared by painting, scrolling and hit testing; the reply row stays fixed. */
export function treePaneBodyHeight(state: DashState, pl: Placement, g: Glyphs): number {
  const boxed = pl.view !== 'sessions-nav' && g.boxes && pl.rect.w >= 4 && pl.rect.h >= 3;
  const reply = pl.view === 'session-detail' && observatoryReplyRow(state, pl.id, pl.rect.w, 'none') !== undefined ? 1 : 0;
  return Math.max(0, pl.rect.h - (boxed ? 2 : 1) - reply);
}

/**
 * The screen rows of a tree pane whose text is not the whole row (`DashRow.copy`), each with its first
 * and last text column, or null when it holds none; `at` is the pane's text area (a drag's clip), which
 * also bounds a row drawn wider than it. The rows, width and scroll treePaneLines draws, so a drag's
 * band and copy leave out exactly what was drawn.
 */
export function treePaneTextRows(state: DashState, pl: Placement, g: Glyphs, depth: ColorDepth, at: { x0: number; x1: number; y0: number }): Map<number, [number, number] | null> {
  const boxed = pl.view !== 'sessions-nav' && g.boxes && pl.rect.w >= 4 && pl.rect.h >= 3;
  const bodyH = treePaneBodyHeight(state, pl, g);
  const rows = treePaneRows(state, pl.view, boxed ? pl.rect.w - 2 : pl.rect.w, g, depth, pl.id);
  const scroll = Math.max(0, Math.min(state.treeScroll?.[pl.id] ?? 0, Math.max(0, rows.length - bodyH)));
  // With more rows below, the last line is `↓ newest`, not a row.
  const shown = rows.length - scroll > bodyH ? bodyH - 1 : bodyH;
  const out = new Map<number, [number, number] | null>();
  for (let i = 0; i < shown; i++) {
    const copy = rows[scroll + i]?.copy;
    if (copy !== undefined) out.set(at.y0 + i, copy && [at.x0 + copy[0], Math.min(at.x0 + copy[1], at.x1)]);
  }
  return out;
}

function treePaneBox(state: DashState, pl: Placement, g: Glyphs, depth: ColorDepth): string[] {
  const iw = pl.rect.w - 2; // between the │ │
  const bodyH = treePaneBodyHeight(state, pl, g);
  const rows = treePaneRows(state, pl.view, iw, g, depth, pl.id);
  const scroll = Math.max(0, Math.min(state.treeScroll?.[pl.id] ?? 0, Math.max(0, rows.length - bodyH)));
  // The master names that a selection is ACTIVE and how to drop it. On its narrow title the label would
  // truncate — and it is redundant, since the accent-tinted row and the detail's own header already say
  // WHICH session — so `sessions-nav` shows just the escape hatch; the legacy boards keep the label.
  const note = !state.scopeWorker
    ? undefined
    : pl.view === 'sessions-nav'
      ? 'esc clears'
      : pl.view === 'workers' || pl.view === 'agents-mini'
        ? `selected: ${state.scopeWorker.label} (esc clears)`
        : undefined;
  // No `>` focus marker — the coral border already says which pane is focused.
  const title = `${VIEW[pl.view].title}${note ? ` · ${note}` : ''}`;
  const body: string[] = [];
  for (let i = 0; i < bodyH; i++) body.push(sanitizeCell(` ${rows[scroll + i]?.cells ?? ''}`));
  const hidden = rows.length - scroll - bodyH;
  if (hidden > 0 && bodyH > 0) {
    const more = pl.view === 'session-detail' ? '  ↓ newest · End' : `  ${g.fold} +${hidden} more`;
    body[bodyH - 1] = depth === 'none' ? more : `\x1b[2m${more}\x1b[0m`;
  }
  const reply = pl.view === 'session-detail' ? observatoryReplyRow(state, pl.id, iw - 1, depth) : undefined;
  if (reply !== undefined && pl.rect.h > 2) body.push(` ${reply}`);
  return boxAround(title, body, pl.rect.w, pl.focused, g, depth);
}

function treePaneLines(state: DashState, pl: Placement, g: Glyphs, depth: ColorDepth): string[] {
  const w = pl.rect.w;
  // The MASTER (sessions-nav) drops its pane box: each blob is its own box now, so a
  // box around the boxes was redundant chrome — and it ate two columns off a 25% pane. Every OTHER tree
  // pane keeps its herdr-style box when boxes are on and it can hold one (top + bottom + a content row).
  const borderless = pl.view === 'sessions-nav';
  if (!borderless && g.boxes && w >= 4 && pl.rect.h >= 3) return treePaneBox(state, pl, g, depth);
  const bodyH = treePaneBodyHeight(state, pl, g);
  const rows = treePaneRows(state, pl.view, w, g, depth, pl.id);
  // Each pane scrolls independently; the offset is clamped so a stale value can never run past the end.
  const scroll = Math.max(0, Math.min(state.treeScroll?.[pl.id] ?? 0, Math.max(0, rows.length - bodyH)));
  const body: string[] = [];
  for (let i = 0; i < bodyH; i++) body.push(fitVisible(pad(sanitizeCell(` ${rows[scroll + i]?.cells ?? ''}`), w), w));
  // Rows past the bottom are NAMED, not hidden silently — the same rule every list here follows.
  const hidden = rows.length - scroll - bodyH;
  if (hidden > 0 && bodyH > 0) {
    const more = pl.view === 'session-detail' ? '  ↓ newest · End' : `  ${g.fold} +${hidden} more`;
    body[bodyH - 1] = fitVisible(pad(depth === 'none' ? more : `\x1b[2m${more}\x1b[0m`, w), w);
  }
  const reply = pl.view === 'session-detail' ? observatoryReplyRow(state, pl.id, w - 1, depth) : undefined;
  if (reply !== undefined && pl.rect.h > 1) body.push(fitVisible(pad(` ${reply}`, w), w));
  // The Workers pane names the active scope and how to clear it, so a scoped view can never look like
  // "this worker has no tasks" when it is really the whole observatory narrowed to one session.
  // The master names that a selection is ACTIVE and how to drop it. On its narrow title the label would
  // truncate — and it is redundant, since the accent-tinted row and the detail's own header already say
  // WHICH session — so `sessions-nav` shows just the escape hatch; the legacy boards keep the label.
  const note = !state.scopeWorker
    ? undefined
    : pl.view === 'sessions-nav'
      ? 'esc clears'
      : pl.view === 'workers' || pl.view === 'agents-mini'
        ? `selected: ${state.scopeWorker.label} (esc clears)`
        : undefined;
  return [treeTitle(pl.view, pl.focused, w, g, depth, note), ...body];
}

/**
 * Render a tree tab's BODY region — the rows between the shared chrome, exactly the slice `renderPanes`
 * produces for a dock tab (renderDashFrame wraps both the same way). Each leaf is a titled box whose
 * body comes from the existing producers; boxes compose left to right per row, a vertical seam between
 * side-by-side neighbours. A horizontal seam needs no drawing — it is a row no box covers.
 */
export function renderTreeBody(
  state: DashState,
  root: PaneNode,
  cols: number,
  bodyH: number,
  focus: string | undefined,
  g: Glyphs,
  depth: ColorDepth,
  zoom?: string | null
): string[] {
  // Auto-hide: a leaf with no rows collapses to its title strip and its sibling takes the space. The
  // SAME set the hit-test computes (treeGeom), so a click and a glyph never disagree about a pane's rect.
  const empty = emptyLeaves(state, root, cols, g, depth);
  // Zoom lives in the resolver (resolveZoomedTree), shared with the hit-test so the two never drift.
  const placements = resolveZoomedTree(root, { x: 0, y: 0, w: cols, h: bodyH }, focus, zoom, empty).placements;
  const lines = new Map<string, string[]>();
  for (const pl of placements) lines.set(pl.id, treePaneLines(state, pl, g, depth));
  // With boxes on, each pane draws its own │ edges, so the seam between them is just a space — a
  // `▐` there would be a third vertical line between two box walls.
  const seamCell = depth === 'none' || g.boxes ? ' ' : `\x1b[2m${g.bar}\x1b[0m`;
  // Sort by x ONCE, not per row: the placements never move between rows, and filter() keeps their order.
  const byX = [...placements].sort((a, b) => a.rect.x - b.rect.x);
  const out: string[] = [];
  for (let y = 0; y < bodyH; y++) {
    const here = byX.filter((p) => y >= p.rect.y && y < p.rect.y + p.rect.h);
    if (!here.length) {
      out.push(fitVisible('', cols));
      continue;
    }
    let row = ' '.repeat(here[0].rect.x);
    here.forEach((p, k) => {
      row += lines.get(p.id)![y - p.rect.y] ?? '';
      if (k < here.length - 1) {
        const gap = Math.max(0, here[k + 1].rect.x - (p.rect.x + p.rect.w));
        for (let s = 0; s < gap; s++) row += seamCell;
      }
    });
    out.push(fitVisible(row, cols));
  }
  return out;
}

/**
 * The shared bottom chrome every tab frame ends with. The status row reclaims its line from the body
 * when it has something to say, then divider · status · statusline · keys. The caller supplies the
 * already-computed `status` and `keys` — the only parts that differ per tab kind — and this appends the
 * rest onto `out`, returning `out.slice(0, rows)`. renderPanes/renderTreeFrame/renderNativeFrame all
 * spelled this out by hand, byte-for-byte, before — which is how a fix to one could miss the others.
 */
function bottomChrome(state: DashState, out: string[], cols: number, rows: number, status: string, keys: string, g: Glyphs, depth: ColorDepth): string[] {
  const statusRow = statusWithToast(status, state, cols);
  const speaks = statusRow.trim().length > 0;
  if (speaks) out.splice(out.length - 1, 1);
  out.push(chromeDivider(cols, g, depth));
  if (speaks) out.push(statusRow);
  for (const line of statuslineFor(state, cols, g, depth, statuslineWant(rows))) out.push(line);
  out.push(fitVisible(depth === 'none' ? keys : `\x1b[2m${keys}\x1b[0m`, cols - 1));
  return out.slice(0, rows);
}

/** The dock/tree key-hints string: the filter input while filtering, else the go-to prompt, else the
 *  widest hint row that fits. Shared by renderPanes and renderTreeFrame. */
function dockKeys(state: DashState, cols: number): string {
  // The observatory tab draws its OWN ladder (session blobs, not dock windows).
  const onObs = (state.tabs as { id?: string }[] | undefined)?.[state.activeTab ?? 0]?.id === 'observatory';
  const hints = onObs ? OBS_HINTS : KEY_HINTS;
  return state.filterOpen || state.filter
    ? `/${state.filter}${state.filterOpen ? '_' : ''}`
    : state.goto
      ? '↵ select · esc cancel'
      : hints.find((s) => displayWidth(s) <= cols - 1) ?? '?';
}

/**
 * The full frame for a TREE tab: the persistent tab bar, the tree body, and the same bottom chrome
 * (divider · status · statusline · keys) every tab shares. It drops the window bar and session row —
 * those name the six DOCK panes a tree tab does not have — giving the body those rows, the direction
 * the chrome redesign takes for every tab. Sums to exactly `rows`, so switching tabs never jumps the
 * persistent chrome.
 */
/** A tree tab's status line — confirm wall, error, go-to prompt, else the plain status (empty when
 *  `ready`). Extracted so the renderer and the hit-test (`treeReclaimsRow`) agree on when it speaks. */
export function treeStatusText(state: DashState, depth: ColorDepth): string {
  return state.confirm
    ? tint(
        `${state.confirm.verb}${state.confirm.ids.length ? ` ${state.confirm.ids.length} edit(s)` : ''} — ${state.confirm.label}?  [y/n]`,
        'pending',
        depth
      )
    : state.error
      ? tint(`! ${state.error}`, 'risk', depth)
      : state.goto
        ? tint(`go to edit #${state.goto}_`, 'accent', depth)
        : state.status === 'ready'
          ? ''
          : state.status;
}

/** Does a tree tab's bottom chrome RECLAIM the last body row for the status line? The renderer shaves
 *  the tree by this row so the bottom auto-hidden strip is not the one eaten — and the HIT-TEST
 *  (`treeGeom`) MUST shave the identical row, or a click lands one row off whenever the status speaks. */
export function treeReclaimsRow(state: DashState, cols: number, depth: ColorDepth): boolean {
  return statusWithToast(treeStatusText(state, depth), state, cols).trim().length > 0;
}

function renderTreeFrame(
  state: DashState,
  opts: FrameOpts,
  root: PaneNode,
  focus: string | undefined,
  zoom: string | null | undefined,
  lay: Layout,
  g: Glyphs,
  depth: ColorDepth
): string[] {
  const { cols, rows } = opts;
  const out: string[] = tabBar(state, lay, cols, g, depth);
  // Status is dock-simple here (no `blocked`/zoomed-edit case); the shared tail does the rest.
  const status = treeStatusText(state, depth);
  // The shared tail RECLAIMS the last body row for the status line when it speaks. A tree's bottom
  // pane can be a 1-row auto-hidden strip, which would land on that row and vanish — so resolve the
  // tree in one fewer row when status speaks, then pad a blank reclaim row for the tail to eat. The
  // hit-test (treeGeom) shaves the SAME row via `treeReclaimsRow`, or a click lands one row off.
  const bodyH = Math.max(0, rows - out.length - chromeBottom(rows) + 1);
  const treeBodyH = Math.max(0, bodyH - (treeReclaimsRow(state, cols, depth) ? 1 : 0));
  const bodyLines = renderTreeBody(state, root, cols, treeBodyH, focus, g, depth, zoom);
  while (bodyLines.length < bodyH) bodyLines.push(fitVisible('', cols));
  for (const line of bodyLines) out.push(line);
  return bottomChrome(state, out, cols, rows, status, dockKeys(state, cols), g, depth);
}

/**
 * The full frame for a NATIVE tab: the persistent tab bar, the PTY program's screen (`state.nativeGrid`
 * — already `cols`-wide ANSI-styled cells, computed by the runtime), and the shared bottom chrome. A
 * note stands in while the session is spawning, after it exits, or when passthrough is unavailable.
 */
function renderNativeFrame(state: DashState, opts: FrameOpts, lay: Layout, g: Glyphs, depth: ColorDepth): string[] {
  const { cols, rows } = opts;
  const out: string[] = tabBar(state, lay, cols, g, depth);
  const bodyH = Math.max(0, rows - out.length - chromeBottom(rows) + 1);
  const grid = state.nativeGrid ?? [];
  for (let i = 0; i < bodyH; i++) out.push(fitVisible(grid[i] ?? '', cols));
  const status = state.nativeNote ? tint(state.nativeNote, 'accent', depth) : state.status === 'ready' ? '' : state.status;
  const hints = state.tabs?.[state.activeTab ?? 0]?.id === 'herdr' ? (process.env.TMUX ? HERDR_HINTS.map(hint => hint.replace('ctrl+b is', 'ctrl+b ctrl+b is').replace('^B herdr', '^B ^B herdr')) : HERDR_HINTS) : NATIVE_HINTS;
  const keys = hints.find(s => displayWidth(s) <= cols - 1) ?? '?';
  return bottomChrome(state, out, cols, rows, status, keys, g, depth);
}

// The filter control's picker — the file-type buckets and extensions actually PRESENT in the change
// map, so it never offers a filter that would empty the pane. There is no regex row: the `/` query
// reads itself as a regex the moment it carries regex syntax. It renders through the ordinary overlay
// path (title + lines + a cursor), so the reverse-video highlight and scrolling carry it for free.
export type FilterMenuKind = 'cat' | 'ext' | 'head';
export interface FilterMenuItem {
  kind: FilterMenuKind;
  id: string;
  label: string;
  on: boolean;
}

export function filterMenuItems(state: DashState): FilterMenuItem[] {
  const files = arr(view<{ files?: unknown[] }>(state, 'changemap')?.files) as { rel?: unknown; file?: unknown }[];
  const rels = files.map((ff) => str(ff.rel) || str(ff.file)).filter(Boolean);
  const catsPresent = FILE_CATEGORIES.filter((c) => rels.some((r) => fileCategory(r) === c));
  const extsPresent = [...new Set(rels.map((r) => fileExt(r)).filter(Boolean))].sort();
  const cats = new Set(state.filterCats ?? []);
  const exts = new Set(state.filterExts ?? []);
  const items: FilterMenuItem[] = [];
  if (catsPresent.length) {
    items.push({ kind: 'head', id: '', label: 'File type', on: false });
    for (const c of catsPresent) items.push({ kind: 'cat', id: c, label: FILE_CATEGORY_LABEL[c], on: cats.has(c) });
  }
  if (extsPresent.length) {
    items.push({ kind: 'head', id: '', label: 'Extension', on: false });
    for (const e of extsPresent) items.push({ kind: 'ext', id: e, label: `.${e}`, on: exts.has(e) });
  }
  return items;
}

// ASCII checkboxes, not a glyph tier's tick: the marker has to read the same on the terminal that
// only has box-drawing as it does on one with the full set, and the row's own reverse-video cursor
// is what marks the selection.
export function filterMenuLines(items: FilterMenuItem[], depth: ColorDepth): string[] {
  return items.map((it) =>
    it.kind === 'head' ? tint(`  ${it.label}`, 'undone', depth) : `  ${it.on ? '[x]' : '[ ]'} ${it.label}`
  );
}

// The first selectable row (a head is never the cursor's home) — where the cursor opens, and where a
// wrap lands when stepping past either end.
export function filterMenuFirst(items: FilterMenuItem[]): number {
  const i = items.findIndex((it) => it.kind !== 'head');
  return i < 0 ? 0 : i;
}

// A one-line readout of everything the filter narrows by — the query (shown `/…/` when it is being
// read as a regex, `"…"` when literal, so the mode is visible without a toggle), then the type
// buckets and extensions. Empty when nothing is filtering. This is what the header and the picker
// title print so "what filter is applied" is always on screen.
export function filterSummary(state: DashState): string {
  const bits: string[] = [];
  const q = (state.filter ?? '').trim();
  if (q) bits.push(isRegexQuery(q) ? `/${q}/` : `"${q}"`);
  for (const c of state.filterCats ?? []) bits.push(FILE_CATEGORY_LABEL[c as FileCategory] ?? c);
  for (const e of state.filterExts ?? []) bits.push(`.${e}`);
  return bits.join(', ');
}

export function renderDashFrame(state: DashState, opts: FrameOpts): string[] {
  const { cols, rows } = opts;
  const depth = depthOf(opts.color);
  const g = opts.glyphs ?? defaultGlyphs();
  const lay = state.panes
    ? resolveLayout({
        cols, rows,
        minimized: state.panes.minimized,
        hidden: state.panes.hidden,
        boxes: g.boxes,
        navBox: g.boxes, // the boxed session navbar rides the same tier switch everywhere
        zoom: state.panes.zoom,
        focus: state.panes.focus,
        tab: state.panes.tab,
        sizes: state.panes.sizes,
        // The tab bar has to be resolved HERE too, not only at the runtime's own `layout()` call —
        // this is the render path every snapshot, probe and one-shot goes through, and a tab bar
        // that appears only in the live app is a tab bar nothing can test.
        tabs: state.tabs?.map((t, i) => tabLabel(t, i, g)),
        activeTab: state.activeTab,
      })
    : null;
  // A tree tab renders its own arrangement; an overlay (help, a picker) still wins as a layer over
  // any tab. `lay` is still resolved (a tree tab keeps `panes`), so the persistent tab bar and chrome
  // heights come from the same place every tab's do.
  const activeTab = state.tabs?.[state.activeTab ?? 0];
  // Every tab renderer needs a resolved layout and no overlay on top; the arrangement is chosen by
  // the tab (a tree by its `root`, a passthrough by its `kind`, otherwise the docked panes).
  if (lay && !state.overlay) {
    if (activeTab?.root) return renderTreeFrame(state, opts, activeTab.root, activeTab.treeFocus, activeTab.treeZoom, lay, g, depth);
    if (activeTab?.kind === 'native') return renderNativeFrame(state, opts, lay, g, depth);
    return renderPanes(state, opts, lay, g, depth);
  }
  // An overlay is a layer OVER the windows, not a different product. Painting the retired
  // eight-screen nav here told the reader their windows had vanished the moment they pressed `s`.
  // The window bar leads, exactly as it does in the pane frame — but the legacy screen nav does NOT,
  // because it is a tab strip rather than a map of the frame, and that frame's own lead is its
  // session line.
  const out: string[] = lay
    ? [
        ...(tabBar(state, lay, cols, g, depth)),
        windowBar(lay, cols, g, depth),
        ...(lay.navBox
      ? boxAround('session', [sessionRow(state, Math.max(20, cols - 2), g, depth)], cols, false, g, depth)
      : [sessionRow(state, cols, g, depth)]),
      ]
    : [sessionBar(state, cols, g, depth), attention(state, cols, g, depth), navRow(state, cols, g, depth)];

  // Derived from the chrome actually emitted above, not from a constant: the pane frame carries two
  // top rows and the legacy one carries three, and a hard-coded 5 leaves the taller of them a line
  // short of filling the terminal.
  const bodyRows = Math.max(0, rows - out.length - chromeBottom(rows));
  if (state.overlay) {
    // The diff takes the whole body. Its lines already carry the CLI's own colouring, so they are
    // width-fitted but never re-styled — what is shown is exactly what `diff <id>` prints.
    const o = state.overlay;
    out.push(fitVisible(tint(o.title, 'accent', depth), cols));
    // Expand to visual lines first: a diff line wider than the terminal WRAPS onto a continuation
    // that reclaims the full width. Fitting it cut the tail off silently, and a diff you cannot read
    // to the end is a diff you cannot review. Only the visible window is expanded.
    const slice: string[] = [];
    // Which LOGICAL row each visual line came from. The cursor indexes `o.lines`, but this array is
    // the WRAPPED expansion of them — so comparing the cursor against a position in it drifts by one
    // for every wrap above it, and the highlight lands on a row the reader did not select. It only
    // ever bit pickers (the diff overlay has no cursor) and only when something wrapped, which is why
    // it survived: a picker row that fits is its own visual line and the two indexes agree.
    const owner: number[] = [];
    for (let r = o.scroll; r < o.lines.length && slice.length < bodyRows - 1; r++) {
      const raw = o.lines[r] ?? '';
      if (displayWidth(raw) <= cols) { slice.push(raw); owner.push(r); continue; }
      const parts = wrapVisible(raw, Math.max(1, cols - 2));
      slice.push(parts[0] ?? '');
      owner.push(r);
      for (const part of parts.slice(1)) { slice.push(`${g.wrap}${part}`); owner.push(r); }
    }
    for (let i = 0; i < bodyRows - 1; i++) {
      const line = slice[i] ?? '';
      // Every visual line of the selected row is marked, so a wrapped selection reads as one block.
      const picked = o.cursor !== undefined && owner[i] === o.cursor;
      // Without colour the cursor REPLACES the row's leading space rather than being prepended:
      // prepending shifts every column right by one and collides with the marker a picker row may
      // already carry (the current session's own '>'), so two different meanings share a glyph AND
      // the columns stop lining up.
      const marked = picked ? (depth === 'none' ? `>${line.slice(1)}` : `\x1b[7m${line}\x1b[0m`) : line;
      out.push(fitVisible(marked, cols));
    }
  } else if (state.views === null) {
    out.push(fitVisible('  building the session view…', cols));
    for (let i = 1; i < bodyRows; i++) out.push(fitVisible('', cols));
  } else {
    // The map draws its own legend row; every other screen spends the line on data.
    let all = rowsFor(state, cols, g, depth);
    let header: string | null = null;
    if (state.screen === 'map') {
      const tree = buildMapTree(arr(view<{ files?: unknown[] }>(state, 'changemap')?.files) as never, undefined, state.sort);
      header = mapHeader(tree as MapNode, cols, g, state.sort, filterSummary(state));
    }
    const avail = header ? bodyRows - 1 : bodyRows;
    if (header) out.push(header);
    const start = Math.min(state.scroll, Math.max(0, all.length - avail));
    const slice = all.slice(start, start + avail);
    for (let i = 0; i < avail; i++) {
      const r = slice[i];
      if (!r) {
        out.push(fitVisible('', cols));
        continue;
      }
      const selected = start + i === state.cursor;
      const text = sanitizeCell(r.cells);
      out.push(fitVisible(selected && depth !== 'none' ? `\x1b[7m ${text}\x1b[0m` : selected ? `>${text}` : ` ${text}`, cols));
    }
    if (all.length === 0 && bodyRows > 0) {
      out[3] = fitVisible(
        state.screen === 'feed'
          ? '  no feed subject selected — pick an agent or workflow, then press 7'
          : '  nothing on this screen for this session',
        cols
      );
    }
  }

  const statusText = state.confirm
    ? tint(`${state.confirm.verb}${state.confirm.ids.length ? ` ${state.confirm.ids.length} edit(s)` : ''} — ${state.confirm.label}?  [y/n]`, 'pending', depth)
    : state.error
      ? tint(`! ${state.error}`, 'risk', depth)
      : state.status;
  out.push(chromeDivider(cols, g, depth));
  out.push(statusWithToast(statusText, state, cols));
  for (const line of statuslineFor(state, cols, g, depth, statuslineWant(rows))) out.push(line);
  // Pick the widest hint that MEASURES within the budget rather than guessing a threshold: a
  // hand-written `cols >= 96` selected a 100-column string fit to `cols - 1`, so every width from
  // 96 to 100 silently cut the last keys ("q qui"). The budget is the only honest threshold.
  const budget = cols - 1;
  // The SAME ladder the pane frame uses. This path had its own copy, which still advertised the
  // window keys as digits long after the digits had been given to edits — so opening any overlay
  // replaced the key row with instructions for a keymap that no longer existed.
  const keys = state.filterOpen || state.filter
    ? `/${state.filter}${state.filterOpen ? '_' : ''}`
    : KEY_HINTS.find((s) => displayWidth(s) <= budget) ?? '?';
  out.push(fitVisible(depth === 'none' ? keys : `\x1b[2m${keys}\x1b[0m`, budget));
  return out.slice(0, rows);
}
