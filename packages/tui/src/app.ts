/**
 * `dash` — the terminal dashboard.
 *
 * Five windows over one session — Claude, Prompts, Traces and Dashboards docked around Detail — with the same
 * review operations the editors have. Everything that can be a value is one: the frame comes from
 * `renderDashFrame`, a pure function, and this file is only the runtime around it — terminal
 * setup, key decoding, and the guarantee that the terminal is handed back intact no matter how the
 * process ends.
 *
 * The restore path is the part worth being paranoid about. A dashboard that exits leaving the alternate
 * screen active, the cursor hidden, or stdin in raw mode leaves the user with a shell that echoes
 * nothing and looks broken, with no hint that this program did it.
 */
import { chromeBottom } from './layout';
import * as fs from 'fs';
import * as path from 'path';
import { createNativeInput, translateNativeMouse, type NativeInputPart, type NativeKeyEvent } from './native-input';
import { routeNativeHostReply } from './native';
import { selectAndPin, observatoryReply, observatorySelection, sessionMachine, listedMachine, newestAnywhere, pickerSessionRows, type ObservatorySelection } from './observatory';
import { createObservatory } from './observatory-runtime';
import { commentAnchor } from './richdiff';
// helpLines() is module-level so a test can read it; it cannot reach the `core` handle the app is
// constructed with, so it takes the keymap straight from the settings layer.
import { keymap as coreKeymap } from '@oak-observatory/core';
import { fuzzyMatch } from './textwidth';
import { pointerSeq, pointerForTreeHit, pointerForDockHit, dropZone, type PointerShape } from './pointer';
// The rendering half of this package. `core` stays a PARAMETER — it is the data layer, and
// injecting it is what lets the app be driven against a fixture store in tests.
import {
  BAR_ENTRIES,
  PANE_SPECS,
  TAB_SCREEN,
  applyOption,
  buildMapTree,
  OUTSIDE,
  colorDepth as detectColorDepth,
  createGatedWriter,
  defaultMinimized,
  feedBlobKeys,
  detailNavButtons,
  displayWidth,
  filterMenuItems,
  filterMenuLines,
  filterMenuFirst,
  filterSummary,
  type FilterMenuItem,
  followTracesDiff,
  glyphTier,
  glyphs as glyphSet,
  hitTest,
  latchMinimized,
  PANE_GUTTER,
  mapRowActions,
  mapToolbar,
  mapConfirmButtons,
  mapOwnsConfirm,
  MAP_DECOR,
  mapRows,
  optionRows,
  paneListRows,
  paneRowCount,
  paneScreenOf,
  paneVisible,
  promptRowActions,
  reanchorIndex,
  renderDashFrame,
  renderOptions,
  resolveLayout,
  renderRichDiff,
  reverseVisibleSpan,
  rowsFor,
  sliceSpan,
  spanCols,
  type SpanClip,
  stepReviewId,
  selectableRows,
  selectionIds,
  clipboardPlan,
  pastePlan,
  seenTransitions,
  sessionActive,
  sessionRowCountersX,
  setOption,
  tint,
  setTheme,
  OBSERVATORY_TREE,
  leafViews,
  VIEW_SCREEN,
  treePaneRows,
  treePaneBodyHeight,
  treePaneTextRows,
  observatoryReplyRow,
  emptyLeaves,
  treeReclaimsRow,
  tabLabel,
  tabParts,
  resolveTree,
  resolveZoomedTree,
  hitTreeBody,
  setRatioAt,
  splitPane,
  closePane,
  swapPanes,
  movePane,
  setPaneView,
  leafPanes,
  VIEW,
  type ViewId,
  paneCount,
  firstLeafId,
  leafIds,
  parseTree,
  nativeAvailable,
  spawnNative,
  spawnCwd,
} from './index';
import type {
  Layout,
  ColorDepth,
  DashState,
  PaneId,
  PaneBox,
  PaneState,
  TabState,
  DashRow,
  InputEvent,
  PaneNode,
  NativeSession,
} from './index';


type Core = typeof import('@oak-observatory/core');
type Backend = import('./backend').Backend;

/**
 * The keys this runtime binds live in core, as `KEY_BINDINGS`, beside the hint strings that
 * advertise them — what the frame promises and what this file answers are two halves of one
 * contract, and a test that cannot see both halves cannot check it. Every `case` below must appear
 * in that set under the name the decoder emits.
 */

/** Which views each screen needs. Asking for only these keeps a payload that reached 11.7 MB on a real
 *  session down to what is actually being rendered. */
const BASE = ['changemap', 'risk', 'egress', 'multitask', 'sessions'];
const VIEWS_FOR: Record<string, string[]> = {
  edits: [...BASE, 'list'],
  map: BASE,
  prompts: [...BASE, 'prompts'],
  tasks: BASE,
  workflows: BASE,
  agents: BASE,
  feed: [...BASE, 'feed'],
  audit: BASE,
  // The pane model added these two screens; without an entry here `viewsForLayoutOf` never asks for
  // the view, the payload arrives without it, and the pane renders an honest-looking "(0)". A missing
  // allow-list entry and a genuinely empty result are indistinguishable on screen, which is exactly
  // the failure this product forbids.
  observations: [...BASE, 'observations'],
  processes: [...BASE, 'processes'],
  // The Claude strip reads only views BASE already carries (sessions · multitask · changemap) plus
  // the prompts list for the newest ask. Review's PATCHES ride their own debounced spawn (`review
  // --prompt` needs a prompt id, and `views` hands ONE argument list to every view it batches — so
  // threading the id through would retarget the others and respawn the whole batch per selection).
  claude: [...BASE, 'prompts', 'feed'],
};

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
/** OSC 2: the terminal's window title. Set to `oak · <active tab>` while the app runs (tmux shows it
 *  as the pane title; with `set-titles` the outer window too), cleared on exit. */
const TITLE_RESET = '\x1b]2;\x07';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';
/** SGR extended mouse reporting (1006) plus button-event tracking (1002). 1006 matters: the legacy
 *  encoding cannot express a column past 223, so a wide terminal silently reports the wrong cell. */
/**
 * 1003, not 1002: **1002 reports motion only while a button is held**, which is a drag. Free motion
 * — hover — needs any-event tracking, and hover is what reveals a tab's model.
 *
 * 1003 costs nothing 1002 had not already spent. The usual objection is that it steals the
 * terminal's native click-drag text selection, but 1002 took that when drag-to-copy landed; readers
 * already shift-bypass. What it DOES cost is volume: one report per cell crossed, so `onMouse` must
 * return without repainting unless the HIT TARGET changed (see the hover handler). Without that
 * rule, every mouse movement anywhere over the terminal repaints the frame.
 */
const MOUSE_ON = '\x1b[?1003h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
const FOCUS_ON = '\x1b[?1004h';
const FOCUS_OFF = '\x1b[?1004l';
/** The keys a reader HOLDS DOWN — movement, and the two that edit text. See `repeatActs`. */
const HELD_KEYS = new Set(['up', 'down', 'left', 'right', 'pgup', 'pgdn', 'home', 'end', 'tab', 'backtab', 'backspace', 'delete']);
/** The two overlays whose rows answer a choice: the right-click row menu and `P`'s go-to-file list. Their state
 *  (`rowMenu`, `jumpRows`) acts only while that overlay is the one open: a command's answer that replaced the
 *  row menu left its keys live in the next overlay, where `u` undid an edit behind the help. */
const ROW_MENU_TITLE = 'this row  —  ↑↓ move · enter run · esc close';
const JUMP_TITLE = 'go to file  —  ↑↓ move · enter open · esc cancel';

/**
 * OSC 52 payloads are BOUNDED, because over the limit they fail SILENTLY.
 *
 * A terminal that receives an OSC-52 longer than it will buffer drops the whole sequence — no
 * error, no reply, nothing this end can observe. tmux's documented ceiling is 74,994 bytes and
 * several terminals are lower. Unbounded, a 4,000-line patch encoded past every one of them while
 * the status line still said "copied the diff (4000 lines)", and the reader pasted whatever was on
 * their clipboard BEFORE — which is a worse outcome than not offering the copy at all, because
 * nothing tells them it did not happen.
 *
 * So an oversized copy is refused, loudly, and names a way that does work. No truncation: half a
 * patch on the clipboard looks like a whole one.
 */
// OSC52_MAX moved to frame.ts beside clipboardPlan — one constant for the decision and its tests.

/**
 * What to poll, keyed on the resolved LAYOUT rather than on one screen. A minimized pane genuinely
 * stops being fetched, so closing a window makes the poll cheaper instead of merely quieter. The
 * measured payloads make this load-bearing: `changemap` alone is 1.39 MB on a real session.
 */
function viewsForLayoutOf(core: Core, lay: Layout): string[] {
  const want = new Set(BASE);
  for (const box of lay.boxes) {
    const screen = TAB_SCREEN[box.id][box.selTab] ?? TAB_SCREEN[box.id][0];
    for (const v of VIEWS_FOR[screen] ?? []) want.add(v);
  }
  return [...want];
}

export function runTui(core: Core, args: string[], resolveSession: (a: string[]) => string | { session: string; elsewhere: boolean }): void {
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const once = args.includes('--once');
  // The reader's saved settings. A FLAG still wins over a preference, and the environment still wins
  // over both where it is an instruction rather than a default (NO_COLOR): the precedence is
  // flag > preference > environment, and it is applied here once rather than at each use.
  let prefs = core.readPrefs();
  // Before the first paint, not after: applying the theme later would flash the default palette on
  // startup for anyone who had chosen another one.
  setTheme(prefs.theme);
  const keys = (): Map<string, import('@oak-observatory/core').Action> => core.keymap(prefs);
  // Mouse tracking takes click-drag away from the terminal's own text selection, which is how people
  // copy things. `--no-mouse` turns it off for a session; most terminals also restore selection while
  // shift is held.
  let mouse = !args.includes('--no-mouse') && prefs.mouse !== false;
  // NO_COLOR is an explicit instruction from the environment; a surface that carries meaning in hue
  // has to obey it. `--no-color` remains as the per-invocation override.
  let colorDepth: ColorDepth = args.includes('--no-color')
    ? 'none'
    : process.env.NO_COLOR
      ? 'none'
      : prefs.color && prefs.color !== 'auto'
        ? prefs.color
        : detectColorDepth(process.env, Boolean(process.stdout.isTTY));
  let glyphs = glyphSet(prefs.glyphs && prefs.glyphs !== 'auto' ? prefs.glyphs : glyphTier(process.env));
  // `||`, never `??`: a TTY can report `columns === 0`, which `??` would pass straight through as a
  // real width. (`??` also cannot be mixed with `||` without parentheses.)
  /** How often the poll re-reads the store: `--tick <s>` for this run, else the saved "Refresh every"
   *  (3 s by default). Both were documented and neither was read. */
  const refreshMs = (): number => Math.min(3600, Math.max(1, Number(flag('--tick')) || prefs.refreshSeconds || 3)) * 1000;
  const cols = Number(flag('--cols')) || process.stdout.columns || 100;
  const rows = Number(flag('--rows')) || process.stdout.rows || 30;
  const cwd = flag('--root') || process.cwd();
  /** The newest session already hinted about, so the status line says each newcomer ONCE. */
  let newerSessionHinted: string | null = null;
  let newerSessionCheckedAt = 0;
  /** The frame as last painted — what drag-to-copy extracts from, so the copied text is exactly
   *  what was on screen when the reader selected it. */
  let lastPainted: string[] = [];
  /** An armed text selection: a left press on a body cell that may become a drag-to-copy. Columns
   *  ride along because the copy is CHARACTER-precise — the span runs cell to cell, like the
   *  terminal's own selection, not row to row. On a tree tab (the Observatory) the selection is held
   *  to the text area of the pane it began in (`clip`, frame cells), and the press's own click
   *  (`click`) waits for a release that never moved. That pane (`pane`) says which of its rows hold
   *  text in only some of their cells: a boxed prompt's borders are neither banded nor copied. */
  let textDrag: {
    startRow: number; lastRow: number; startCol: number; lastCol: number; moved: boolean;
    clip?: { x0: number; x1: number; y0: number; y1: number }; click?: () => void; pane?: string;
  } | null = null;
  /** A drag's span, normalized so `a` precedes `b` — ONE implementation for the live-drag paint
   *  and the kept selection (two inline copies of the direction ternary had already crept in). */
  const normSpan = (td: { startRow: number; startCol: number; lastRow: number; lastCol: number }) => {
    const fwd = td.startRow < td.lastRow || (td.startRow === td.lastRow && td.startCol <= td.lastCol);
    return fwd
      ? { a: { row: td.startRow, col: td.startCol }, b: { row: td.lastRow, col: td.lastCol } }
      : { a: { row: td.lastRow, col: td.lastCol }, b: { row: td.startRow, col: td.startCol } };
  };
  /** A drag's clip with, in a tree pane, the rows it draws now that hold text in only some of their
   *  cells: ONE reading for the band and the copy. */
  const dragClip = (td: NonNullable<typeof textDrag>): SpanClip | undefined => {
    const root = td.pane && td.clip ? tabs[active]?.root : undefined;
    const pl = root ? treeGeom(root).tl.placements.find((p) => p.id === td.pane) : undefined;
    return pl && td.clip ? { ...td.clip, rows: treePaneTextRows(state, pl, glyphs, colorDepth, td.clip) } : td.clip;
  };

  const resolved = resolveSession(args);
  const session = typeof resolved === 'string' ? resolved : resolved.session;
  // The launch session is no newcomer. Review moves off it (a pin, a pick, the newest session on a saved
  // machine), and the hint must still name only a session that starts after launch.
  newerSessionHinted = session || null;
  const launchedAt = Date.now();
  /** Whether a session took a turn since this app started, by its own agent's rule. One that only reopened
   *  (herdr restoring its pane after launch) is no newcomer; an unknown turn counts, as before. */
  const tookTurnSinceLaunch = (id: string): boolean => {
    const d = core.describeSession(id);
    const turn = d.transcript ? core.lastTurnMs(d.transcript, d.runtime === 'codex' ? 'codex' : 'claude') : null;
    return turn === null || turn > launchedAt;
  };
  /** No session and no workspace named (`--session`, either session variable, `--root`), outside any repo:
   *  Review opens on the most recently active session on any machine (adoptNewestAnywhere; the one-shot frame applies
   *  the same rule). */
  const reviewNewestAnywhere = !flag('--session') && !flag('--root') && !process.env.CLAUDE_OBSERVATORY_SESSION
    && !process.env.CLAUDE_CHANGES_SESSION && !core.repoRoot(cwd);

  /**
   * The ONE place a layout request is built.
   *
   * Every `resolveLayout` call has to agree about the tab bar, because the tab bar costs a chrome
   * row: a call that omits `tabs` resolves a frame one row taller than the one on screen and then
   * makes decisions — which panes fit, which are forced closed — for a layout nobody is looking at.
   * That is not theoretical; it is the bug that made `m` appear dead (the minimize handler resolved
   * a 2-row chrome, decided Dashboards still would not fit, and produced no visible change).
   *
   * `over` is for callers asking a HYPOTHETICAL — "what would the frame be if I minimized this?" —
   * which is the only legitimate reason to differ from the live state.
   */
  function layoutReq(over: Partial<Parameters<typeof resolveLayout>[0]> = {}): Parameters<typeof resolveLayout>[0] {
    return {
      cols: frameCols,
      rows: frameRows,
      minimized: state.panes!.minimized,
      hidden: state.panes!.hidden,
      boxes: glyphs.boxes,
      navBox: glyphs.boxes, // the session navbar is a box on the boxed tier
      zoom: state.panes!.zoom,
      focus: state.panes!.focus,
      tab: state.panes!.tab,
      sizes: state.panes!.sizes,
      tabs: tabs.map((t, i) => tabLabel(t, i, glyphs)),
      activeTab: active,
      ...over,
    };
  }

  /**
   * Persist every tab's workspace.
   *
   * Called on the DELIBERATE layout gestures — a tab switch and the release of a seam drag — rather
   * than on every state change: a drag emits a size per pointer cell, and writing the prefs file at
   * that rate would turn a resize into hundreds of disk writes.
   *
   * A failed save is reported, never swallowed. The reader who arranges a layout and finds it gone
   * next launch is owed the reason at the moment it failed.
   */
  function saveLayout(): void {
    try {
      const out: NonNullable<typeof prefs.layout>['tabs'] = {};
      for (const t of tabs) {
        out[t.id] = {
          minimized: [...t.panes.minimized],
          zoom: t.panes.zoom,
          focus: t.panes.focus,
          sizes: { ...(t.panes.sizes ?? {}) } as Record<string, number>,
          // A tree tab persists its arrangement (reader splits and dragged ratios survive a restart),
          // plus its focus and zoom. Validated on the way back in by `restoredTree`/`parseTree`.
          ...(t.root ? { root: t.root as unknown, treeFocus: t.treeFocus, treeZoom: t.treeZoom } : {}),
        };
      }
      prefs = { ...prefs, layout: { version: core.LAYOUT_VERSION, active: tabs[active].id, tabs: out } };
      core.writePrefs(prefs);
    } catch (e) {
      state.status = `layout not saved: ${(e as Error).message}`;
    }
  }

  /**
   * Fill each tab's model, phase and liveness from the poll it just received.
   *
   * Read from the SESSIONS payload, which is where `friendlyModel` has already been applied — the
   * tab must not carry a second opinion about what model is running, or hovering a tab and reading
   * the statusline would give two different answers about the same session.
   *
   * A tab with no session, or a session the payload does not describe, keeps `model: null` and shows
   * NO tooltip. Absence is the honest answer; a guessed default would be a lie a reader cannot see
   * through.
   */
  function refreshTabFacts(payload: Record<string, unknown>): void {
    const rows = ((payload.sessions as { sessions?: unknown[] } | null)?.sessions ?? []) as {
      id?: string;
      model?: string;
      phase?: string;
      active?: boolean;
      agent?: string;
      title?: string | null;
      tab?: string | null;
    }[];
    for (const t of tabs) {
      if (!t.session) {
        t.model = null;
        continue;
      }
      const row = state.reviewMachine && state.reviewSession?.id === t.session ? state.reviewSession
        : rows.find((r) => r.id === t.session);
      t.model = typeof row?.model === 'string' && row.model ? row.model : null;
      // The CLI/agent the tab observes or drives — the herdr-style sublabel (`review · claude`). Only
      // when the payload names one; absence shows the tab name alone rather than a guessed agent.
      t.agent = typeof row?.agent === 'string' && row.agent ? row.agent : undefined;
      t.phase = typeof row?.phase === 'string' ? row.phase : undefined;
      // The SAME derivation the session strip uses (`sess?.active === true || phase === 'working'`).
      // The sessions payload carries no `active` field today, so in practice the phase decides it —
      // but reading the field as well keeps one definition rather than two that agree by accident.
      t.active = row?.active === true || t.phase === 'working';
    }
  }

  /**
   * Switch tabs. The workspace comes with it — each tab keeps its own minimize set, focus, dragged
   * sizes, cursors and scroll, so returning to a tab finds it exactly as it was left.
   *
   * The SESSION rides along (0.10.0 per-tab session): Review pins the session it reviews, the agent
   * tab the one it drives, observatory pins none (keeps the current). Retargeting the session used to
   * be refused here for keep/undo safety — a mutation reads state.session at APPLY time — so the wall
   * below is what makes it safe: a pending keep/undo is answered before the session can move.
   */
  function switchTab(i: number): void {
    if (i === active || i < 0 || i >= tabs.length) return;
    if (state.confirm) {
      state.status = 'answer the pending keep/undo first — y or n';
      return schedulePaint();
    }
    if (tabs[i].id === 'herdr') {
      nativeFailed.delete('herdr');
      const old = nativeSessions.get('herdr');
      if (old?.ended) { nativeSessions.delete('herdr'); old.close(); }
    }
    nativeSessions.get(tabs[active]?.id)?.setHostActive?.(false);
    state.activeTab = i;
    nativeSessions.get(tabs[active]?.id)?.setHostActive?.(true, [2004, 1004, ...(mouse ? [1003, 1006] : [])]);
    state.hoverTab = null;
    if (tabs[i].session && tabs[i].session !== state.session) {
      state.session = tabs[i].session!;
      forgetSessionSelection();
      // Switching to a tab bound to a DIFFERENT session: clear the session-scoped globals so the new
      // tab shows a clean load, not the previous session's views/usage/title held over until the fetch
      // lands (the picker already nulls these on switch; switchTab did not,
      // so a tab switch read as "stale/broken" for the ~seconds the new build took).
      state.views = null;
      state.usage = undefined;
      state.sessionTitle = '';
    }
    saveLayout();
    // ASK, because `ask()` derives the view list from `layout()` and the new tab holds different
    // panes. Without it the tab renders against whatever the previous tab happened to fetch, and
    // fills in only on the next poll — up to `refreshSeconds` of a blank or stale workspace, which
    // reads as the tab being broken rather than merely late.
    ask();
    // No status message: the tab bar already says which tab is up, and overwriting the status row
    // would discard whatever it was carrying (a mutation result, an error, a blocked-pane note).
    schedulePaint();
  }

  /** Detach the herdr client while retaining the outer tabs. */
  function closeNativeTab(id: string): void {
    const client = nativeSessions.get(id);
    client?.setHostActive?.(false);
    nativeSessions.delete(id);
    nativeFailed.delete(id);
    if (tabs[active]?.id === id) switchTab(tabs.findIndex(t => t.id === 'observatory'));
    try { client?.close(); } catch { /* already detached */ }
    schedulePaint();
  }

  // ---- Needs you: the raised-hand inbox and the next-hand jump ----
  // The hooks record what every session waits on (attention.json); the sessions payload carries it as
  // `attention`. `i` lists every hand, most urgent first; `h` jumps to the next one; a new hand toasts
  // once (keyed by its ts, the editors' rule) and asks core to announce it on the desktop — core's
  // claim file makes that fire once per machine however many surfaces are open.
  type HandKind = import('@oak-observatory/core').HandKind;
  type HandRowLite = { id: string; title?: string; agent?: string; attention: { kind: HandKind; message: string; ts: number } };
  let inboxOpen = false;
  let inboxIds: string[] = [];
  let inboxCursor = 0;
  const handToasted = new Map<string, number>();
  /** The reader's OWN key for an action (the toast names it; a rebind must show there too). */
  const keyForAction = (action: string): string => {
    for (const [k, a] of coreKeymap(prefs)) if (a === action) return k;
    return '?';
  };
  function handRows(): HandRowLite[] {
    const rows = ((state.views?.sessions as { sessions?: unknown[] } | undefined)?.sessions ?? []) as { id: string; attention: { kind: HandKind; message: string; ts: number } | null }[];
    return core.rankedHands(rows, true) as unknown as HandRowLite[];
  }
  function renderInbox(): void {
    const rows = handRows();
    inboxIds = rows.map((r) => r.id);
    if (!rows.length) {
      inboxOpen = false;
      state.overlay = null;
      state.status = 'nobody is waiting on you';
      return schedulePaint();
    }
    inboxCursor = Math.min(inboxCursor, rows.length - 1);
    const now = Date.now();
    const lines = rows.map((r, i) => {
      const a = r.attention;
      const done = a.kind === 'idle-done';
      const wait = done ? '' : ` · ${core.compactDuration(Math.max(0, now - a.ts))}`;
      const who = r.agent && r.agent !== 'claude' ? `[${r.agent}] ` : '';
      const name = r.title || `session ${r.id.slice(0, 8)}`;
      return `${i === inboxCursor ? '> ' : '  '}${done ? '  ' : `${glyphs.pending} `}${(done ? 'done' : a.kind).padEnd(10)} ${who}${name}${a.message ? ` — ${a.message}` : ''}${wait}`;
    });
    const waiting = rows.filter((r) => r.attention.kind !== 'idle-done').length;
    state.overlay = { title: `needs you — ${waiting} waiting · ↑↓ choose · ↵ open · esc`, lines, scroll: 0, cursor: inboxCursor };
    schedulePaint();
  }
  function openInbox(): void {
    if (state.confirm) {
      state.status = 'answer the pending keep/undo first — y or n';
      return schedulePaint();
    }
    inboxCursor = 0;
    inboxOpen = true;
    renderInbox();
  }
  function inboxKey(ev: { key: string }): void {
    if (ev.key === 'down') {
      inboxCursor = Math.min(inboxIds.length - 1, inboxCursor + 1);
      return renderInbox();
    }
    if (ev.key === 'up') {
      inboxCursor = Math.max(0, inboxCursor - 1);
      return renderInbox();
    }
    if (ev.key === 'enter') {
      const id = inboxIds[inboxCursor];
      inboxOpen = false;
      state.overlay = null;
      return id ? jumpToHand(id) : schedulePaint();
    }
    inboxOpen = false;
    state.overlay = null;
    schedulePaint();
  }
  function jumpNextHand(): void {
    const id = core.nextAttention(handRows(), state.session);
    if (!id) {
      state.status = 'nobody is waiting on you';
      return schedulePaint();
    }
    jumpToHand(id);
  }
  /** Switch the observatory to a raised hand and say what it waits on — through the session picker's
   *  own Enter (guards included), so an unsafe or remote row is refused exactly the same way. */
  function jumpToHand(id: string): void {
    const row = handRows().find((r) => r.id === id);
    if (state.session !== id) choosePicked(id);
    if (row) state.status = `${row.title || `session ${id.slice(0, 8)}`} ${core.attentionLabel(row.attention.kind)}${row.attention.message ? ` — ${row.attention.message}` : ''}`;
    schedulePaint();
  }

  // ---- The window title follows the active tab ----
  let lastWindowTitle = '';
  function syncWindowTitle(): void {
    if (!interactive) return;
    const t = tabs[active];
    const title = t ? `oak · ${tabParts(t, active, glyphs).body}` : 'oak';
    if (title === lastWindowTitle) return;
    lastWindowTitle = title;
    // OSC 2 with a BEL terminator; control characters stripped so a title can never smuggle one.
    out.write(`\x1b]2;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}\x07`);
  }

  // ---- Find anything: the ctrl+o palette over sessions, tabs, workspaces and actions ----
  // One index, typed-to-narrow with the same scattered-letters match every filtered pane uses. Enter
  // does what the row IS: a session switches to it, a tab raises it, a workspace opens the session
  // picker narrowed to it, an action presses its key — the palette can never do something the
  // keyboard cannot.
  type PaletteItem = { kind: 'session' | 'tab' | 'workspace' | 'action' | 'search'; label: string; detail: string; run: () => void };
  let paletteOpen = false;
  let paletteFilter = '';
  let paletteCursor = 0;
  let paletteItems: PaletteItem[] = [];
  let paletteShown: PaletteItem[] = [];
  function paletteBuild(): PaletteItem[] {
    const items: PaletteItem[] = [];
    const rows = (state.views?.sessions as { sessions?: Record<string, unknown>[] } | undefined)?.sessions ?? [];
    const now = Date.now();
    // Every saved machine's sessions too, as the session picker lists them, each reviewed on its own.
    for (const x of pickerSessionRows(state, rows)) {
      const id = String(x.id ?? '');
      if (!id || typeof x.note === 'string') continue;
      const a = x.attention as { kind?: string } | null | undefined;
      const hand = a && a.kind && a.kind !== 'idle-done' ? `${glyphs.pending} ${a.kind} · ` : '';
      const agent = x.agent && x.agent !== 'claude' ? `[${String(x.agent)}] ` : '';
      const when = Number(x.lastActiveMs) ? core.relTime(Number(x.lastActiveMs), now) : '';
      const owner = String(x.owner ?? '');
      items.push({ kind: 'session', label: `${hand}${agent}${String(x.title || id)}`, detail: [owner, String(x.workspace ?? ''), when].filter(Boolean).join(' · '), run: () => choosePicked(id, owner) });
    }
    tabs.forEach((t, i) => items.push({ kind: 'tab', label: tabLabel(t, i, glyphs), detail: `tab ${i + 1}`, run: () => switchTab(i) }));
    const seen = new Set<string>();
    for (const x of rows) {
      const w = String(x.workspace ?? '');
      if (!w || seen.has(w)) continue;
      seen.add(w);
      const n = rows.filter((y) => String(y.workspace ?? '') === w).length;
      items.push({
        kind: 'workspace',
        label: w,
        detail: `${n} session${n === 1 ? '' : 's'}`,
        run: () => {
          openSessionPicker();
          pickerFilter = w;
          renderSessionPicker();
        },
      });
    }
    // An action row presses its key, so it is offered only where that key means the action: Review's verbs
    // on Review, and elsewhere only the ones every tab shares (on the
    // Observatory "Keep the selection" pressed `a`, which asks to accept every edit and clear the store).
    const onReview = tabs[active]?.id === 'review';
    const shared = ['session', 'options', 'help', ...(tabs[active]?.id === 'observatory' ? ['filter'] : [])];
    for (const r of core.REBINDABLE) {
      if (!onReview && !shared.includes(r.action)) continue;
      const key = keyForAction(r.action);
      items.push({ kind: 'action', label: r.label, detail: key, run: () => onKey({ key, ctrl: false, alt: false }) });
    }
    return items;
  }
  function renderPalette(): void {
    const f = paletteFilter.trim();
    paletteShown = paletteItems.filter((it) => !f || fuzzyMatch(`${it.label} ${it.detail} ${it.kind}`, f) !== null);
    // With words typed, the last row searches every CONVERSATION for them — the
    // asks and answers behind the sessions, not just their titles.
    if (f.length >= 2) paletteShown.push({ kind: 'search', label: `search conversations for “${f}”`, detail: 'asks and answers, every session', run: () => runConversationSearch(f) });
    paletteCursor = Math.max(0, Math.min(paletteCursor, paletteShown.length - 1));
    const lines = paletteShown.map((it, i) => `${i === paletteCursor ? '> ' : '  '}${it.kind.padEnd(9)} ${it.label}${it.detail ? `  \x1b[2m${it.detail}\x1b[0m` : ''}`);
    state.overlay = {
      title: `find — ${paletteFilter}▏  · type to narrow · ↑↓ · ↵ opens · esc`,
      lines: lines.length ? lines : ['  nothing matches'],
      scroll: Math.max(0, paletteCursor - 10),
      cursor: paletteCursor,
    };
    schedulePaint();
  }
  function openPalette(): void {
    if (state.confirm) {
      state.status = 'answer the pending keep/undo first — y or n';
      return schedulePaint();
    }
    paletteFilter = '';
    paletteCursor = 0;
    paletteItems = paletteBuild();
    paletteOpen = true;
    renderPalette();
  }
  function paletteKey(ev: { key: string; ctrl?: boolean; alt?: boolean }): void {
    if (ev.key === 'down') {
      paletteCursor++;
      return renderPalette();
    }
    if (ev.key === 'up') {
      paletteCursor--;
      return renderPalette();
    }
    if (ev.key === 'backspace') {
      paletteFilter = paletteFilter.slice(0, -1);
      return renderPalette();
    }
    if (ev.key === 'enter') {
      const it = paletteShown[paletteCursor];
      paletteOpen = false;
      state.overlay = null;
      if (it) it.run();
      else schedulePaint();
      return;
    }
    if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
      paletteFilter += ev.key;
      paletteCursor = 0;
      return renderPalette();
    }
    // esc, or any chord: close.
    paletteOpen = false;
    state.overlay = null;
    schedulePaint();
  }

  // ---- Conversation search results: the palette's last row, answered by `oak search` ----
  type SearchHitLite = { session: string; title: string | null; agent: string; ts: number; prompt: string; snippet: string; where: string };
  let searchOpen = false;
  let searchHits: SearchHitLite[] = [];
  let searchCursor = 0;
  let searchQuery = '';
  function runConversationSearch(q: string): void {
    paletteOpen = false;
    const placeholder = `searching every conversation for “${q}”…`;
    state.overlay = { title: placeholder, lines: ['  one moment — the first search builds the index'], scroll: 0 };
    schedulePaint();
    // The answer replaces only its own placeholder, and through closeOverlay: an overlay the reader opened
    // meanwhile is theirs, and taking it down directly left its modes (the help's filter, the picker, a row
    // menu's keys) live in the next one.
    const ours = (): boolean => state.overlay?.title === placeholder;
    // Through the CLI as a child, like every other read: the query is one argv VALUE (`--query <text>`,
    // never a leading dash, never a shell string), and a scan of a 600 MB history cannot freeze the keyboard.
    if (!backend) return;
    void backend
      .run(['search', '--json', '--query', q, '--limit', '40'])
      .then((out) => {
        let parsed: { hits?: SearchHitLite[] } | null = null;
        try {
          parsed = JSON.parse(out) as { hits?: SearchHitLite[] };
        } catch {
          parsed = null;
        }
        const hits = Array.isArray(parsed?.hits) ? parsed!.hits! : [];
        if (!ours()) {
          state.status = `search for “${q}” finished: ${hits.length} matching ask${hits.length === 1 ? '' : 's'} (ctrl+o to search again)`;
          return schedulePaint();
        }
        closeOverlay();
        searchHits = hits;
        searchQuery = q;
        searchCursor = 0;
        searchOpen = true;
        renderSearchResults();
      })
      .catch((e: unknown) => {
        if (ours()) closeOverlay();
        state.status = `search failed: ${String((e as Error)?.message ?? e)}`;
        schedulePaint();
      });
  }
  function renderSearchResults(): void {
    if (!searchHits.length) {
      searchOpen = false;
      closeOverlay();
      state.status = `nothing matches “${searchQuery}” in any conversation`;
      return schedulePaint();
    }
    // Two rows per hit — the session and when, then the excerpt — so the cursor addresses row pairs.
    const lines: string[] = [];
    searchHits.forEach((h, i) => {
      const who = h.agent && h.agent !== 'claude' ? `[${h.agent}] ` : '';
      lines.push(`${i === searchCursor ? '> ' : '  '}${who}${h.title || `session ${h.session.slice(0, 8)}`}  \x1b[2m${core.relTime(h.ts)} · ${h.where === 'prompt' ? 'ask' : 'answer'}\x1b[0m`);
      lines.push(`      ${h.snippet}`);
    });
    state.overlay = { title: `“${searchQuery}” — ${searchHits.length} matching ask${searchHits.length === 1 ? '' : 's'} · ↑↓ · ↵ opens the session · esc`, lines, scroll: Math.max(0, searchCursor * 2 - 10), cursor: searchCursor * 2 };
    schedulePaint();
  }
  function searchKey(ev: { key: string }): void {
    if (ev.key === 'down') {
      searchCursor = Math.min(searchHits.length - 1, searchCursor + 1);
      return renderSearchResults();
    }
    if (ev.key === 'up') {
      searchCursor = Math.max(0, searchCursor - 1);
      return renderSearchResults();
    }
    if (ev.key === 'enter') {
      const h = searchHits[searchCursor];
      searchOpen = false;
      state.overlay = null;
      if (h) {
        if (state.session !== h.session) choosePicked(h.session);
        state.status = `${core.relTime(h.ts)} — ${h.prompt}`;
      }
      return schedulePaint();
    }
    searchOpen = false;
    state.overlay = null;
    schedulePaint();
  }


  /**
   * The tabs, and why each is the pane set it is.
   *
   * A tab is a workspace: one `PaneState`, which the layout engine already consumes. There is no
   * per-tab geometry engine and no layout tree — see `TabState` in frame.ts for the measurement
   * that decided it.
   */
  const mkPanes = (over: Partial<PaneState> = {}): PaneState => ({
    minimized: defaultMinimized(cols, rows),
    zoom: null,
    // From the reader's settings. (`startFace` is gone: Map and Diff are both always on screen
    // since the pane split, so the option changed nothing — a settings row that does nothing is
    // worse than no row. Stored values are simply ignored by the prefs reader now.)
    focus: prefs.startFocus ?? 'traces',
    tab: {},
    cursor: {},
    scroll: {},
    sizes: {},
    ...over,
  });

  const ALL_PANES: readonly PaneId[] = ['claude', 'prompts', 'traces', 'map', 'detail', 'dashboards'];
  const isPane = (s: string): s is PaneId => (ALL_PANES as readonly string[]).includes(s);

  /**
   * Apply a stored workspace over a tab's defaults.
   *
   * Every value is re-checked against THIS build's pane list, not just against the schema: prefs
   * validation cannot know that `detail` was renamed or removed, and a saved size must never
   * resurrect a pane this build no longer has — the rule pane widths already followed before tabs.
   * Anything unrecognised is dropped and the default stands.
   */
  const restoredPanes = (id: string, base: PaneState): PaneState => {
    const s = prefs.layout?.tabs?.[id];
    if (!s) return base;
    const out: PaneState = { ...base };
    if (s.minimized) out.minimized = new Set(s.minimized.filter(isPane));
    if (s.zoom !== undefined) out.zoom = typeof s.zoom === 'string' && isPane(s.zoom) ? s.zoom : null;
    if (s.focus && isPane(s.focus)) out.focus = s.focus;
    if (s.sizes) {
      const sizes: Partial<Record<PaneId, number>> = {};
      for (const [k, v] of Object.entries(s.sizes)) if (isPane(k) && typeof v === 'number') sizes[k] = v;
      out.sizes = sizes;
    }
    // A BAD LAYOUT DEGRADES TO THE DEFAULTS, NEVER TO A BLANK SCREEN.
    //
    // Every pane minimized resolves to zero boxes — a frame of chrome around nothing, with no note
    // and nothing in `blocked` (the resolver is right not to complain: the reader closed these on
    // purpose). That was always reachable by hand, but it used to die with the process. Persisting
    // it would bring the empty frame back at every launch, with no way out that is visible ON the
    // empty frame. So a stored workspace that renders nothing is discarded and the default stands.
    if (!resolveLayout({ cols, rows, minimized: out.minimized, hidden: out.hidden, zoom: out.zoom, focus: out.focus, tab: {} }).boxes.length) {
      return base;
    }
    return out;
  };

  /** Restore a tree tab's saved arrangement, VALIDATED — a bad tree (unknown view, ratio outside
   *  (0,1), duplicate id, malformed split) falls back to the default, and a focus/zoom naming a pane
   *  the tree no longer has is dropped. It can never restore a blank or broken frame. */
  const restoredTree = (id: string, dflt: PaneNode, dfltFocus: string): { root: PaneNode; treeFocus: string; treeZoom: string | null } => {
    const saved = prefs.layout?.tabs?.[id];
    let root: PaneNode = (saved?.root ? parseTree(saved.root) : null) ?? dflt;
    for (const leaf of leafPanes(root)) {
      if (leaf.view === 'feed' || leaf.view === 'agent') root = setPaneView(root, leaf.id, 'session-detail');
    }
    const ids = new Set(leafIds(root));
    const treeFocus = saved?.treeFocus && ids.has(saved.treeFocus) ? saved.treeFocus : ids.has(dfltFocus) ? dfltFocus : firstLeafId(root);
    const treeZoom = saved?.treeZoom && ids.has(saved.treeZoom) ? saved.treeZoom : null;
    return { root, treeFocus, treeZoom };
  };
  const obsTree = restoredTree('observatory', OBSERVATORY_TREE, 'obs-sessions');

  // INSIDE a herdr pane (the attach model: `oak attach` puts OAK in a pane of the host session) there is
  // no herdr tab at all — herdr IS the host, its own keys move between its tabs, and a tab that could
  // only show a note saying so was a dead tab the reader had to skip.
  // From a plain terminal the herdr tab spawns the real client.
  const nestedInHerdr = Boolean(process.env.HERDR_PANE_ID);
  const tabs: TabState[] = [
    ...(nestedInHerdr ? [] : [{ id: 'herdr', kind: 'native', name: 'herdr', command: [core.findHerdrBin() || core.herdrInstallPath(require('os').homedir(), process.platform)], panes: mkPanes() } as TabState]),
    {
      // Default landing tab. The herdr client spawns only when the reader switches to its tab.
      id: 'observatory',
      kind: 'panes',
      name: 'observatory',
      panes: restoredPanes('observatory', mkPanes({
        minimized: new Set(ALL_PANES.filter((p) => p !== 'dashboards')),
        focus: 'dashboards',
      })),
      // The BSP tree owns the machine/session master and independently pinned conversations.
      // `panes` remains the dock fallback and supplies shared tab-bar geometry.
      root: obsTree.root,
      treeFocus: obsTree.treeFocus,
      treeZoom: obsTree.treeZoom,
    },
    {
      // Prompts, Traces, Diff and Map — the review surface. Dashboards and the Agent strip fold, so
      // the whole frame is the thing being decided on.
      id: 'review',
      kind: 'panes',
      name: 'review',
      panes: restoredPanes('review', mkPanes({ hidden: new Set<PaneId>(['claude', 'dashboards']), minimized: new Set<PaneId>(['claude', 'dashboards']), focus: 'traces' })),
      session,
    },
  ];
  // By ID, never by index: restoring position 2 into a build whose tabs moved lands the reader
  // somewhere they never left. An id this build does not have falls back to the first tab.
  //
  // `--tab <id>` outranks the stored one — an explicit instruction on this launch beats a preference
  // from the last. It is also what lets a one-shot render name the tab it wants, so a headless check
  // can assert the review workspace without driving keystrokes into it.
  const wantTab = flag('--tab');
  if (wantTab && !tabs.some((t) => t.id === wantTab)) {
    // Loud, not silent: a misspelled tab that quietly opened the default would read as the flag
    // being ignored, which is the same symptom as the flag not existing.
    process.stderr.write(`unknown tab '${wantTab}' — have ${tabs.map((t) => t.id).join(', ')}\n`);
  }
  let active = wantTab ? tabs.findIndex(t => t.id === wantTab) : tabs.findIndex(t => t.id === prefs.layout?.active);
  if (active < 0) active = tabs.findIndex(t => t.id === 'observatory');
  // A first run — no agent session on this machine yet — opens on the herdr tab, the one that starts
  // one; the views poll adopts the first session that appears (see ask()).
  if (!session && !wantTab && tabs.some(t => t.id === 'herdr')) active = tabs.findIndex(t => t.id === 'herdr');

  const state: DashState = {
    views: null,
    screen: 'edits',
    cursor: 0,
    scroll: 0,
    session,
    sessionTitle: '',
    filter: '',
    // The STORED order, applied on the first frame. Reading it only when `S` is pressed would make a
    // persisted setting one that does nothing until you change it again.
    sort: prefs.sort ?? 'time',
    marked: new Set<number>(),
    // `!== false`, NOT `=== true`. Core states the contract at prefs.ts: absent means ON, and it
    // stores nothing for a default. Reading it as `=== true` turned absent into an explicit false,
    // which every frame consumer then read back as `state.syntax !== false` → false: no syntax

    // coloured normally. That asymmetry is exactly what a reader sees as "the blobs have no
    // highlighting but the transcript does".
    syntax: prefs.syntax !== false,
    // The reader's keymap, so the frame can name a key instead of hard-coding a letter. Refreshed on
    // every save below, or a rebind made in the options window would not reach the surfaces that
    // advertise it until the next launch.
    keys: keys(),
    status: 'starting…',
    error: null,
    confirm: null,
    now: Date.now(),
    watcherMode: 'native',
    open: new Set<string>(),
    promptScope: null,
    scopeWorker: null,
    overlay: null,
    // `panes` is an ACCESSOR onto the active tab, not storage. Declared inline because a spread
    // would EVALUATE the getter and copy its value, silently turning tabs back into one workspace.
    // Every existing `state.panes = {...state.panes, x}` site keeps working and now writes through
    // to whichever tab is up.
    get panes(): PaneState {
      return tabs[active].panes;
    },
    set panes(v: PaneState | null | undefined) {
      if (v) tabs[active].panes = v;
    },
    get tabs(): readonly TabState[] {
      return tabs;
    },
    get activeTab(): number {
      return active;
    },
    set activeTab(i: number) {
      active = Math.max(0, Math.min(i, tabs.length - 1));
    },
    hoverTab: null,
    goto: null,
  };
  // EVERY terminal byte this runtime emits goes through this gate — the one bare
  // `process.stdout.write` in the file is the sink below (a source-level test holds that line).
  // While the terminal is handed to a child, async completions may update state but not paint;
  // see writer.ts for the failure this prevents. The exit path (`restore`) stays outside the gate
  // on purpose: it must hand back a working terminal no matter when it runs.
  const out = createGatedWriter((seq) => process.stdout.write(seq));

  /** The launch session when `--session` named one this machine does not hold (the CLI checked, and let
   *  it through because saved machines exist). Review never reads this machine's store for it: it waits
   *  for a saved machine's catalog to list it, and says so when none does. */
  const elsewhere = new Set(typeof resolved !== 'string' && resolved.elsewhere ? [session] : []);
  /** Whether THIS machine holds a session: its own transcript or rollout (core never counts another
   *  machine's sync mirror as one) or its store. Asked only when a saved machine's catalog lists the id,
   *  and cached, because a Codex lookup that misses walks every rollout shard; a miss is asked again
   *  after a while, since a session can start here. */
  const heldHere = new Map<string, { held: boolean; at: number }>();
  const holdsHere = (id: string): boolean => {
    if (!id || !core.isSafeSessionId(id)) return false;
    const hit = heldHere.get(id);
    if (hit && (hit.held || Date.now() - hit.at < 15_000)) return hit.held;
    let held: boolean;
    try {
      held = Boolean(core.describeSession(id).transcript) || fs.existsSync(core.storeDir(id));
    } catch {
      held = true; // cannot tell: it stays this machine's, as it was before any catalog was consulted
    }
    heldHere.set(id, { held, at: Date.now() });
    return held;
  };
  /** Why a session this machine does not hold is not reviewable: no saved machine lists it, naming the
   *  ones asked and any that could not answer — never an empty review that reads as "no edits". */
  const nowhere = (id: string): string => {
    const remotes = (state.observatory?.machines ?? []).filter((m) => !m.local);
    const asked = remotes.filter((m) => m.sessions).map((m) => m.label);
    // The reason is the remote CLI's own message: without its `oak: ` prefix, which would sit mid-sentence.
    const failed = remotes.filter((m) => m.sessionsError).map((m) => `${m.label} could not be asked: ${m.sessionsError!.replace(/^oak: /, '')}`);
    if (state.observatory?.machineError) failed.push(`the saved machines could not be read: ${state.observatory.machineError}`);
    return `no session "${id}" on this machine${asked.length ? ` or on ${asked.join(', ')}` : ''}${failed.length ? ` (${failed.join('; ')})` : ''} — \`oak sessions\` lists this machine's sessions, \`oak sessions --machine <label>\` another's`;
  };

  // Non-interactive: one frame, plain, exit 0. `--once` is how CI and a pipe use this at all, and the
  // check must include stdin — `isTTY()` elsewhere in this CLI looks only at stdout, and a piped stdin
  // means `setRawMode` does not exist and would throw a TypeError instead of explaining itself.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !once;
  if (!interactive) {
    const onceViews = (
      // NOT `layoutReq()`: this runs before the live frame exists (`frameCols` is still in its
      // temporal dead zone), and a one-shot has no resize state to borrow. It still has to carry
      // `tabs`, because the tab bar costs a chrome row and this resolve decides which VIEWS to
      // fetch — omitting it fetched views for panes the printed frame did not have room for.
      tabs[active]?.id === 'observatory' ? ['sessions'] : viewsForLayoutOf(core, resolveLayout({
        cols, rows,
        minimized: state.panes!.minimized,
        zoom: null,
        focus: state.panes!.focus,
        tab: {},
        tabs: tabs.map((t, i) => tabLabel(t, i, glyphs)),
        activeTab: active,
      }))
    );
    void (async () => {
      let views: Record<string, unknown> | null = null;
      // Read-only: a one-shot prints a frame. It used to tidy herdr's tabs on the way (made a btop tab,
      // renamed and moved tabs, typed into a pane) on this machine and every saved one.
      const observatory = createObservatory(core, state, { cwd, changed() {}, status(message) { state.status = message; }, watch: false, timers: false, readOnly: true });
      let target = session;
      try {
        await observatory.start();
        // The live app's launch rule (adoptNewestAnywhere): with nothing named and outside any repo, Review
        // shows the most recently active session on any machine, this one included. This machine's listing,
        // read for it, is the frame's catalog below too.
        let newer: ReturnType<typeof newestAnywhere>;
        let listing: Record<string, unknown> | null = null;
        if (reviewNewestAnywhere && tabs[active]?.id === 'review') {
          // With no launch session it is read without one, so this machine's Codex sessions count too.
          listing = await (session ? createOnce(core, cwd, session, ['sessions']) : sessionsOnce(core, cwd)).catch(() => null);
          newer = newestAnywhere(state, (listing?.sessions as { sessions?: Record<string, unknown>[] } | undefined)?.sessions, session);
          if (newer) target = state.session = newer.session;
        }
        // The machine whose pane runs it; for a session with no pane that this machine does not hold,
        // the saved machine whose own catalog lists it. A session the rule chose is read where it chose it.
        const found = newer ? newer.machine : sessionMachine(state, target);
        const listed = newer || found || !target ? undefined : listedMachine(state, target);
        const owner = found ?? (listed && (elsewhere.has(target) || !holdsHere(target)) ? listed : undefined);
        if (!owner && elsewhere.has(target)) {
          // Named explicitly and held nowhere: fail as loudly as the CLI does for a typo, not with a frame.
          process.stderr.write(`oak: ${nowhere(target)}\n`);
          process.exitCode = 1;
          return;
        }
        const machine = tabs[active]?.id !== 'observatory' && owner && !owner.local ? owner.label : undefined;
        if (machine) state.reviewMachine = { label: machine };
        // The listing already read is this frame's catalog: it is not read twice.
        const names = machine ? [...new Set([...onceViews, 'sessions'])] : listing ? onceViews.filter((v) => v !== 'sessions') : onceViews;
        views = await createOnce(core, cwd, target, names, machine, machine ? observatorySelection(state, target).root : undefined);
        if (machine && views) {
          state.reviewSession = (views.sessions as { sessions?: Record<string, unknown>[] } | undefined)?.sessions?.find(row => row.id === target);
          state.views = { ...views, sessions: listing?.sessions ?? await createOnce(core, cwd, target, ['sessions']).then(p => p?.sessions) };
        } else state.views = views && listing ? { ...views, sessions: listing.sessions } : views;
        // The header names the session as the live frame does: its map's title, or its own machine's.
        state.sessionTitle = (views?.changemap as { summary?: { title?: string } } | null | undefined)?.summary?.title
          || (machine && core.realSessionTitle(String(state.reviewSession?.title ?? ''))) || '';
        refreshTabFacts(state.views || {});
        if (tabs[active]?.id === 'observatory' && target && flag('--session')) {
          const pinned = selectAndPin(state, target);
          state.scopeWorker = pinned.scopeWorker;
          state.observatory = pinned.observatory;
          // …including the end sentinel, which is what opens a pinned conversation at its NEWEST
          // event. Dropping it printed the top of the transcript and offered `↓ newest` to a frame
          // nobody can press a key in. The rows exist by the paint below, so
          // the renderer resolves the sentinel against them.
          state.treeScroll = pinned.treeScroll;
          await Promise.all(Object.keys(state.observatory?.details || {}).map(paneId => observatory.load(paneId)));
          // …and the workers, tasks and edit previews the load reads after it. The frame used to print
          // before they landed, so every one-shot conversation read "Workers · 0".
          await observatory.refreshWorkers();
        }
      } catch (error) {
        state.error = String((error as Error).message || error);
        if (state.reviewMachine) state.reviewMachine.error = state.error;
        process.exitCode = 1;
      } finally { observatory.close(); }
      state.now = Date.now();
      state.status = state.error || (views ? `${target.slice(0, 8)} · one frame (--once)` : target ? 'no view data for this session' : 'no agent session yet — start one in the herdr tab; the Observatory lists every session');
      for (const line of renderDashFrame(state, { cols, rows, color: colorDepth, glyphs })) {
        out.write(line + '\n');
      }
    })();
    return;
  }

  let restored = false;
  let filterOpen = false;
  /** The leader (ctrl+a) is armed: the NEXT key is a pane/tab command, not itself. A mode, shown in the
   *  status row, always left by esc — never one a reader can get stuck in. */
  let leaderArmed = false;
  /** Ids for reader-created split panes — monotonic so two splits never collide. Seeded past every
   *  `split-N` a restored layout already holds: starting at 1 after a restart made the next split a
   *  duplicate `split-1`, and a tree with two leaves of one id fails to parse on the launch after
   *  that, which reset the whole layout (TUI sweep, 2026-09-23). Seeded once the tabs exist. */
  let nextSplitId = 1;
  /** Native sessions, one per native tab (by tab id), spawned lazily on the tab's first paint. Declared
   *  HERE (before `restore`, which closes them on exit) so an early exit never hits a dead-zone ref. */
  const nativeSessions = new Map<string, NativeSession>();

  // The endpoint only routes explicit focus requests from the herdr plugin or CLI.
  let daemon: import('@oak-observatory/core').DaemonClient | null = null;
  let focusRetry: NodeJS.Timeout | undefined;
  let focusClosed = false;
  async function connectFocus(): Promise<void> {
    const result = await core.ensureDaemon({ client: 'tui-focus', repairOutdated: true });
    if (focusClosed) { result.client?.close(); return; }
    if (!result.client) { state.status = result.why; schedulePaint(); return; }
    const client = daemon = result.client;
    client.on(ev => {
      if (ev.event !== 'focus') return;
      if (state.confirm) { state.status = 'Finish the pending review confirmation before changing focus'; schedulePaint(); return; }
      if (ev.tab === 'review') reviewSession(ev.session);
      else if (ev.tab === 'herdr') switchTab(tabs.findIndex(t => t.id === 'herdr'));
      else pinSession(ev.session);
    });
    client.onClose(() => {
      daemon = null;
      if (!focusClosed) { focusRetry = setTimeout(() => { void connectFocus(); }, 3000); focusRetry.unref(); }
    });
    try { await client.request({ op: 'watch' }); }
    catch (e) { state.status = `focus endpoint: ${String(e)}`; schedulePaint(); }
  }
  if (!once && !args.includes('--no-server') && !process.env.OAK_NO_SERVER) void connectFocus();
  /** Native tabs whose spawn FAILED (bad command) — cached so a paint does not re-fork a PTY forever. */
  const nativeFailed = new Set<string>();
  /** A pane being DRAGGED by its title: where the press was, whether the
   *  pointer has moved since, and where it would land — the pane under it and the zone (its middle
   *  swaps, an edge places beside). Release applies; esc cancels. */
  let paneDrag: { id: string; startCol: number; startRow: number; moved: boolean; target: string | null; zone: 'swap' | 'left' | 'right' | 'top' | 'bottom' | null } | null = null;
  /** The pointer shape last written (OSC 22) — written only when it changes, so a sweep
   *  across a pane costs nothing, and reset to `default` on exit and whenever a native tab (whose
   *  program owns the pointer) is up. */
  let pointerShape: PointerShape = 'default';
  const setPointer = (shape: PointerShape): void => {
    if (shape === pointerShape) return;
    pointerShape = shape;
    out.write(pointerSeq(shape, !!process.env.TMUX));
  };
  /** What the pointer is over → its shape. Called on free motion; every hit-test here is the SAME
   *  geometry the click handlers use, so the arrow appears exactly where a drag would work. */
  function syncPointer(col: number, row: number): void {
    const tab = tabs[active];
    if (!tab || tab.kind === 'native' || state.overlay || state.confirm || paneDrag) return;
    if (tab.root) {
      const { tl, topRows, bodyH } = treeGeom(tab.root);
      if (row < topRows) return setPointer(hitTest(layout(), col, row)?.t === 'tabbar' ? 'pointer' : 'default');
      if (row >= topRows + bodyH) return setPointer('default');
      return setPointer(pointerForTreeHit(hitTreeBody(tl, col, row - topRows)));
    }
    const lay = layout();
    const hit = hitTest(lay, col, row);
    setPointer(pointerForDockHit(hit, hit?.t === 'seam' ? lay.seams[hit.index]?.axis : undefined));
  }
  /** The pane beside `id` in `dir` — nearest edge first, widest overlap breaking ties — for the
   *  keyboard move (ctrl+a H/J/K/L). Null when nothing lies that way. */
  function neighbourPane(root: PaneNode, id: string, dir: 'left' | 'right' | 'up' | 'down'): string | null {
    const { tl } = treeGeom(root);
    const me = tl.placements.find((p) => p.id === id);
    if (!me) return null;
    const R = me.rect;
    let best: { id: string; dist: number; overlap: number } | null = null;
    for (const p of tl.placements) {
      if (p.id === id) continue;
      const r = p.rect;
      const beyond = dir === 'left' ? r.x + r.w <= R.x : dir === 'right' ? r.x >= R.x + R.w : dir === 'up' ? r.y + r.h <= R.y : r.y >= R.y + R.h;
      if (!beyond) continue;
      const overlap =
        dir === 'left' || dir === 'right'
          ? Math.min(R.y + R.h, r.y + r.h) - Math.max(R.y, r.y)
          : Math.min(R.x + R.w, r.x + r.w) - Math.max(R.x, r.x);
      if (overlap <= 0) continue;
      const dist = dir === 'left' ? R.x - (r.x + r.w) : dir === 'right' ? r.x - (R.x + R.w) : dir === 'up' ? R.y - (r.y + r.h) : r.y - (R.y + R.h);
      if (!best || dist < best.dist || (dist === best.dist && overlap > best.overlap)) best = { id: p.id, dist, overlap };
    }
    return best?.id ?? null;
  }

  // ---- The view picker for a pane: after a split, or ctrl+a v on the focused pane ----
  let viewPickOpen = false;
  let viewPickFor = '';
  let viewPickCursor = 0;
  for (const tab of tabs) {
    if (!tab.root) continue;
    for (const id of leafIds(tab.root)) {
      const m = /^split-(\d+)$/.exec(id);
      if (m) nextSplitId = Math.max(nextSplitId, Number(m[1]) + 1);
    }
  }
  const VIEW_CHOICES: ViewId[] = (Object.keys(VIEW) as ViewId[]).filter(v => v !== 'feed' && v !== 'agent');
  function currentViewOf(paneId: string): ViewId | undefined {
    const root = tabs[active]?.root;
    return root ? leafPanes(root).find((p) => p.id === paneId)?.view : undefined;
  }
  function renderViewPicker(): void {
    const cur = currentViewOf(viewPickFor);
    state.overlay = {
      title: 'what should this pane show? — ↑↓ choose · ↵ pick · esc keeps it',
      lines: VIEW_CHOICES.map((v, i) => `${i === viewPickCursor ? '> ' : '  '}${VIEW[v].title.padEnd(14)}${v === cur ? ' (now)' : ''}`),
      scroll: 0,
      cursor: viewPickCursor,
    };
    schedulePaint();
  }
  function openViewPicker(paneId: string): void {
    viewPickFor = paneId;
    viewPickCursor = Math.max(0, VIEW_CHOICES.indexOf(currentViewOf(paneId) as ViewId));
    viewPickOpen = true;
    renderViewPicker();
  }
  function viewPickerKey(ev: { key: string }): void {
    if (ev.key === 'down') {
      viewPickCursor = Math.min(VIEW_CHOICES.length - 1, viewPickCursor + 1);
      return renderViewPicker();
    }
    if (ev.key === 'up') {
      viewPickCursor = Math.max(0, viewPickCursor - 1);
      return renderViewPicker();
    }
    if (ev.key === 'enter') {
      const tab = tabs[active];
      const v = VIEW_CHOICES[viewPickCursor];
      viewPickOpen = false;
      state.overlay = null;
      if (tab?.root && v) {
        tab.root = setPaneView(tab.root, viewPickFor, v);
        if (v !== 'session-detail' && state.observatory?.details[viewPickFor]) {
          const details = { ...state.observatory.details };
          delete details[viewPickFor];
          state.observatory = { ...state.observatory, details };
        }
        saveLayout();
        state.status = `pane shows ${VIEW[v].title}`;
        ask();
      }
      return schedulePaint();
    }
    viewPickOpen = false;
    state.overlay = null;
    schedulePaint();
  }

  let drag: {
    /** True when this drag resizes an AGENT-screen window: the sizes live in their own map,
     *  keyed by region, because the Agent screen's windows are not panes. */
    agent?: boolean;
    target: PaneId;
    axis: 'v' | 'h';
    sign: 1 | -1;
    start: number;
    startExtent: number;
    /** True while this is only a POSSIBLE drag: the press landed on a pane's own top edge, which is
     *  also a focus target. It becomes a real resize on the first motion and a plain click if the
     *  button comes up without any. A dock's title row is where a reader reaches to resize it — the
     *  one-row seam above it is invisible, and "I cannot resize this" is what that costs. */
    pending?: boolean;
    /** A TREE-tab seam drag: the split to resize (by `path`) and its extent along the drag axis, so a
     *  pointer position becomes a `ratio`. `target` is an ignored placeholder for these. */
    tree?: { path: readonly number[]; axisStart: number; axisExtent: number };
  } | null = null;
  /** True once the reader has actually chosen an edit — moved the cursor, clicked a row, or typed an
   *  id. Until then the dashboard opens on the change map with nothing selected, which is the view
   *  that answers "what happened here" before you have picked anything to answer it about. */
  let picked = false;
  /** Command mode's buffer, and whether it owns the keyboard. */
  let cmdBuf = '';
  let cmdOpen = false;
  /** Find-in-diff's buffer, and whether it owns the keyboard. */
  let diffFind = '';
  let diffFindOpen = false;
  /** The options window's own state, or null when it is closed. Declared HERE, beside the rest of
   *  the runtime's state, because `paint` reads it — and `paint` runs once during setup, before any
   *  declaration further down the function body has initialised. A `let` down beside its handlers
   *  read beautifully and crashed the first frame with a temporal-dead-zone error. */
  let options: { cursor: number; scroll: number; capture: null | { id: string; kind: 'text' | 'key'; buf: string } } | null = null;
  /** Whether the overlay currently on screen is the OPTIONS window — so the paint knows whose layer
   *  to take down, and never clears a picker that happens to be open instead. */
  let optionsShown = false;
  let backend: Backend | null = null;
  let observatory: ReturnType<typeof createObservatory> | undefined;
  let tick: NodeJS.Timeout | null = null;
  let animTick: NodeJS.Timeout | null = null; // the session master's blob animation (observatory only)
  let repaintTimer: NodeJS.Timeout | null = null;

  /**
   * Hand the terminal back. Idempotent, and wired to every exit path there is.
   *
   * `writeSync` on fd 1 because the stream object may already be torn down inside an 'exit' handler,
   * and wrapped because on a hangup this very write is what raises EPIPE.
   */
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (tick) clearInterval(tick);
    if (animTick) clearInterval(animTick);
    if (repaintTimer) clearTimeout(repaintTimer);
    backend?.close();
    observatory?.close();
    // LOCAL passthrough children die with us — no PTY of ours outlives the tab that opened it. A
    // SERVER-owned tab's `close()` is a detach: its program keeps running, which is the point.
    for (const s of nativeSessions.values()) {
      try {
        s.setHostActive?.(false, undefined, data => { fs.writeSync(1, data); });
        s.close();
      } catch {
        /* already gone */
      }
    }
    try {
      focusClosed = true;
      if (focusRetry) clearTimeout(focusRetry);
      daemon?.close();
    } catch {
      /* already gone */
    }
    try {
      if (process.stdin.isTTY) {
        process.stdin.removeAllListeners('data');
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    } catch {
      /* nothing left to restore */
    }
    try {
      fs.writeSync(1, (pointerShape !== 'default' ? pointerSeq('default', !!process.env.TMUX) : '') + (lastWindowTitle ? TITLE_RESET : '') + PASTE_OFF + MOUSE_OFF + FOCUS_OFF + CURSOR_SHOW + ALT_OFF);
    } catch {
      /* the pipe is gone; the terminal state went with it */
    }
  };

  process.on('exit', restore);
  // SIGTERM, SIGHUP and SIGQUIT do NOT run 'exit' handlers, so each needs its own. SIGINT is handled
  // both ways: raw mode stops the tty driver turning ^C into a signal (so the decoder reads 0x03), but
  // an explicitly sent SIGINT still arrives here.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      restore();
      process.exit(0);
    });
  }
  process.on('uncaughtException', (e) => {
    restore(); // restore FIRST, so the error is readable in a working terminal
    process.stderr.write(`dash: ${e?.stack || e}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    restore();
    process.stderr.write(`dash: ${String(e)}\n`);
    process.exit(1);
  });

  let frameCols = cols;
  let frameRows = rows;
  let dirty = true;
  const REPAINT_FLOOR_MS = 60; // ~16 fps; TTY writes are blocking, so this is a budget on the key loop

  // Declared before `paint`, which calls syncDetailDiff on the first frame. These are `let`, so they
  // sit in a temporal dead zone until this line runs — and `syncDetailDiff` is a hoisted function
  // declaration, callable earlier. That combination crashed the interactive launch on frame one,
  // while `--once` never noticed because it renders without going through `paint`.
  let diffTimer: NodeJS.Timeout | null = null;
  let diffWanted = -1;
  let lastUsageFetch = 0;
  /** The first ^C of the quit chord, still fresh: a second before this expires exits. */
  let quitArmedUntil = 0;

  let jumpArmed = false;
  /** The selection SGR derived from the terminal's OSC 11 background answer; null = reverse video. */
  let selSgr: string | null = null;

  /**
   * Ask for the change behind every bubble the Agent screen is SHOWING.
   *
   * The fetch used to hang off the toggle gesture, which was right while bubbles defaulted to
   * closed: you opened one, and opening it asked. Expanding them all by default left that trigger
   * behind — so every bubble rendered open with nothing under it, and the only way to see a change
   * was to click a bubble, which now CLOSES it. Expanded and empty is not expanded.
   *
   * Bounded three ways: only the Agent screen, only bubbles that made an edit, and at most a few
   * per pass. `wantPreview` is idempotent per edit (it returns early once the patch is in state),
   * so a steady screen settles after one or two passes and then asks for nothing at all.
   */
  /** What the last prime pass saw. IDENTITIES, not contents: each of these is REPLACED rather than
   *  mutated when it changes (the open-set, the views payload, the preview map all follow that rule
   *  elsewhere in this file), so a reference compare is exact and costs nothing. */
  let primeSeen: { session: string; views: unknown; open: unknown; previews: unknown } | null = null;
  function primeAgentPreviews(): void {
    // BOTH surfaces need them now: the dashboard's Agent pane draws the same blobs as the Agent
    // screen, and a blob with no patch cached shows its head row and nothing else.
    if (!backend) return;
    // The GUARD COMES FIRST. Nothing that decides which previews are wanted can change without one
    // of these four references changing, so in the steady state this is four compares per paint and
    // the blob builder is never entered at all. Building the blobs to decide whether to build the
    // blobs is the shape that made this expensive.
    if (
      primeSeen &&
      primeSeen.session === state.session &&
      primeSeen.views === state.views &&
      primeSeen.open === state.open &&
      primeSeen.previews === (state.editPreviews ?? null)
    ) {
      return;
    }
    primeSeen = { session: state.session, views: state.views, open: state.open, previews: state.editPreviews ?? null };
    const blobs = feedBlobKeys(state);
    let asked = 0;
    for (const b of blobs) {
      if (asked >= 6) break; // a burst of in-process diffs is still work; the rest arrive next pass
      if (!b.editId || state.open.has(b.key)) continue; // collapsed bubbles need nothing
      if (state.editPreviews?.[b.editId] !== undefined) continue;
      wantPreview(b.editId);
      asked++;
    }
    if (asked >= 6) primeSeen = null; // more to fetch — let the next paint continue where this left off
  }

  const paint = (): void => {
    // Suspended is a gate here as well as in the writer: skipping the whole render, not just the
    // final write, keeps `lastPainted` frozen on the frame the reader last SAW — which is the frame
    // a drag-to-copy on resume must slice from.
    if (restored || out.suspended()) return;
    state.now = Date.now();
    primeAgentPreviews();
    if (state.usage === undefined || state.now - lastUsageFetch > 60_000) {
      lastUsageFetch = state.now;
      try {
        // This reader runs in-process, so it needs the same provider refresh as `oak usage`.
        // Keep account I/O outside the paint loop; the next poll consumes the published cache.
        if (core.dueAccountUsagePull()) {
          const pull = core.spawnTool(process.execPath, [process.argv[1], 'usage', '--pull-account', '--json'], { detached: true, stdio: 'ignore' });
          pull.on('error', () => { /* retain the last usable cache */ });
          pull.unref();
        }
        core.kickMonthRefresh(cwd); // the bill-cycle month is scanned only by the statusline — keep it live here too
        core.kickRemoteTitles(); // Remote Control titles from claude.ai: detached, throttled, never on this paint
      } catch { /* an unavailable account refresh does not prevent local usage rendering */ }
      try {
        state.usage = core.usageLine(cwd, state.session);
      } catch {
        state.usage = null; // fetched and failed — said by the row, never retried per paint
      }
      try {
        // BOTH providers for the status readout, which shows claude and gpt side by side (the row
        // above is the active session's provider only — this is the whole-machine picture).
        state.usageBoth = core.usageBrief(cwd);
      } catch {
        state.usageBoth = null;
      }
    }
    state.watcherMode = backend?.watcherMode() ?? 'native';
    // The notice claims only an IDLE status slot. Unconditional, it rewrote state.status on EVERY
    // paint once the skew armed — so from that moment `find 2/5`, `agent ended — the transcript
    // stays…` and every other answer the app gives lived for one frame and vanished (probe find).
    // It re-surfaces whenever the status returns to `ready`, which every action ends on.
    if (backend?.updateSkew() && !state.error && state.status === 'ready') {
      state.status = 'the CLI was updated — restart oak tui to pick up the new build';
    }
    // The focused pane's cursor lives in `state.cursor` so every existing helper keeps working; it is
    // mirrored into the per-pane maps here, at the one place that cannot be forgotten.
    if (state.panes) { syncPane(); syncDetailDiff(); }
    // The options window is a LAYER, painted through the same overlay slot the pickers use, so there
    // is one modal mechanism in this runtime rather than two that drift apart.
    //
    // The mirroring runs BOTH ways. It used to be write-only: closing the window set `options` to
    // null but left the overlay it had painted standing, so the window stayed on screen and `esc`
    // — which the window's own title advertises as "esc close" — appeared to do nothing. The second
    // press then fell through to onKey's generic closeOverlay and cleared the leftover. Two presses
    // to close a window that says one.
    if (!options && optionsShown) {
      state.overlay = null;
      optionsShown = false;
    }
    if (options) {
      optionsShown = true;
      const rows = optRows();
      const cap = options.capture;
      state.overlay = {
        title: cap
          ? cap.kind === 'key'
            ? 'press the key you want  —  esc keeps the current one'
            : `${rows[options.cursor]?.label ?? 'value'}: ${cap.buf}_   —  enter saves · esc cancels`
          // A measured ladder, never a cut: the widest form that FITS. The path used to ride here and
          // was chopped by the fitter at any ordinary width, which is exactly what this product
          // refuses to do to a path. It has its own row now, at the foot of the list.
          : ([
              'options  —  ↑↓ move · ←→ change · enter edit · esc close',
              'options  —  ↑↓ · ←→ · enter · esc',
              'options',
            ].find((t) => displayWidth(t) <= frameCols - 1) ?? 'options'),
        lines: renderOptions(rows, options.cursor, frameCols, options.scroll, Math.max(1, frameRows - 6), glyphs, colorDepth),
        scroll: 0,
      };
    }
    updateNativeGrid();
    syncWindowTitle();
    const lines = renderDashFrame(state, { cols: frameCols, rows: frameRows, color: colorDepth, glyphs });
    lastPainted = lines; // drag-to-copy reads the frame the reader actually selected from
    // The live drag highlight decorates the OUTPUT only — never `lastPainted`, whose whole job is
    // to stay the clean text the release will slice. Reverse video over the span, composed with
    // whatever colour each line already carries.
    let shown = lines;
    // A RELEASED selection persists: same reverse video, until a key or click clears it.
    const liveSpan = textDrag?.moved ? normSpan(textDrag) : state.selSpan ?? null;
    if (liveSpan) {
      const { a, b } = liveSpan;
      // A pane selection bands its own pane only, and in it only the cells the copy takes.
      const clip = textDrag?.moved ? dragClip(textDrag) : state.selSpan?.clip;
      shown = lines.map((line, r) => {
        const cols = r < a.row || r > b.row ? null : spanCols(r, a, b, clip);
        // The OSC-11-derived selection colour where the terminal answered (truecolor only);
        // reverse video everywhere else — the depth that cannot mix keeps the depth-proof mark.
        return cols ? reverseVisibleSpan(line, cols[0], cols[1], colorDepth === 'truecolor' && selSgr ? selSgr : undefined) : line;
      });
    }
    // Home, then clear each line as it is written. Never \x1b[2J: erasing the whole screen before
    // drawing is what makes a repaint flicker.
    //
    // The whole frame is wrapped in SYNCHRONIZED OUTPUT (DEC 2026) and drawn with the cursor HIDDEN,
    // re-shown only at the end. On the Agent screen the real cursor is SHOWN at the composer caret, so before
    // this every streaming repaint let that visible cursor sweep down each row's `\x1b[i;1H` — a
    // cursor flashing across the window. `?2026h`/`l` make the terminal show the frame atomically (a
    // no-op on terminals that don't support it), and CURSOR_HIDE at the top keeps the sweep invisible
    // even there; the caret is restored last, inside the same atomic frame.
    let buf = '\x1b[?2026h' + CURSOR_HIDE + '\x1b[H';
    for (let i = 0; i < shown.length; i++) buf += `\x1b[${i + 1};1H\x1b[K` + shown[i];
    // A NATIVE tab shows the program's OWN cursor: placed where its emulator has it, only while the
    // program shows it, and only while nothing of OAK's is drawn over the tab. A program whose caret
    // IS the terminal cursor (Claude Code's prompt) had no cursor at all inside OAK (2026-09-23).
    const nativeTab = tabs[active];
    const nativeSess = nativeTab?.kind === 'native' ? nativeSessions.get(nativeTab.id) : undefined;
    // `cursor` is optional on the session: a stand-in without an emulator simply keeps the cursor hidden.
    const cur = nativeSess && !nativeSess.ended && !state.overlay && !state.confirm ? nativeSess.cursor?.() : undefined;
    if (cur) {
      const top = layout().tabbar.length ? 1 : 0; // the single-row tab bar above the program's screen
      const bodyH = Math.max(0, frameRows - top - chromeBottom(frameRows) + 1);
      if (cur.visible && cur.y >= 0 && cur.y < bodyH && cur.x >= 0 && cur.x < frameCols)
        buf += `\x1b[${top + cur.y + 1};${cur.x + 1}H` + CURSOR_SHOW;
    }
    buf += '\x1b[?2026l';
    out.write(buf);
  };

  const schedulePaint = (): void => {
    dirty = true;
    if (repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      // While the terminal belongs to a child, leave `dirty` STANDING instead of consuming it —
      // `resumeTerminal` ends with one full paint, and that frame must know there is work to show.
      if (out.suspended()) return;
      if (dirty) {
        dirty = false;
        paint();
      }
    }, REPAINT_FLOOR_MS);
    repaintTimer.unref?.();
  };

  const refreshSize = (): void => {
    // Re-reading process.stdout.columns is a NO-OP: getWindowSize() returns the cached pair and only
    // _refreshSize() issues the syscall. Calling it also emits 'resize' itself, which covers both the
    // normal path and a terminal that never delivers SIGWINCH.
    try {
      (process.stdout as unknown as { _refreshSize?: () => void })._refreshSize?.();
    } catch {
      /* not available on this platform — the 'resize' listener below still applies */
    }
    frameCols = process.stdout.columns || frameCols;
    frameRows = process.stdout.rows || frameRows;
    // A kept selection is coordinates into the OLD frame — after a resize they band whatever
    // reflowed underneath. The copy already happened at release; drop the ghost.
    state.selSpan = null;
  };
  process.stdout.on('resize', () => {
    refreshSize();
    schedulePaint();
  });

  /** This machine's session catalog as last read. A review read from another machine carries none
   *  (see ask), and the Observatory's catalog must stay this machine's across it. */
  let localCatalog: unknown;
  const startBackend = (): void => {
    // Close the outgoing one FIRST. Without this, toggling "Show ignored edits" left the previous
    // backend fully alive — its filesystem watcher still firing and its `onData` listener still
    // writing into the same `state` — so the next store write made both spawn `views`, and the stale
    // one's payload (computed under the OPPOSITE filter setting) landed on screen. Measured: one
    // store event produced children from every backend ever created, one leak per toggle, and the
    // header flipped between "5 files · 5 edits" and "…· 1 hidden by .observatoryignore" while the
    // setting sat unchanged. Worse than the flicker: a scoped confirm counts rows from whatever
    // payload is showing while the verb runs under the CURRENT setting, so "1 edit(s) under …" could
    // revert two files, one of them never displayed.
    backend?.close();
    backend = require('./backend').createBackend({
      core,
      cwd,
      session,
      onDegrade: (why: string) => {
        state.status = why; // never silent
        schedulePaint();
      },
    }) as Backend;
    // Registered HERE, not once at startup: toggling "Show ignored edits" builds a new backend, and a
    // listener attached to the old one would leave the dashboard on its last frame forever.
    backend.onData((raw, err, startedAt, fetchedFor, machine) => {
      // A payload built for a session we have since switched AWAY from must not land. A slow build for
      // the old session that finishes after the switch would repaint the old views over the new — and,
      // because the new build is itself slow, leave them there for its whole duration, which reads as
      // "the switch did nothing". Drop it; the in-flight request for the new
      // session is what paints. A late error still surfaces, and the frame still repaints.
      if (fetchedFor && state.session && fetchedFor !== state.session) {
        if (err) state.error = err;
        clampCursor();
        schedulePaint();
        return;
      }
      // The same session can move machines while a read is in flight. Its previous owner must
      // not repaint the new owner's review (or turn a late failure into a new routing decision).
      if (machine !== (tabs[active]?.id === 'observatory' ? undefined : reviewMachine(state.session))) return;
      // Keep the remote session's status facts separately from this machine's Observatory catalog.
      if (machine && raw) state.reviewSession = (raw.sessions as { sessions?: Record<string, unknown>[] } | undefined)
        ?.sessions?.find(row => row.id === fetchedFor);
      // A review read from another machine lands beside THIS machine's session catalog, and its
      // failure is named in the Review panes while they have nothing else to show.
      if (!machine && raw && raw.sessions !== undefined) {
        localCatalog = raw.sessions;
        observatory?.sessionsRead(raw.sessions, startedAt);
        queueAdopt();
      }
      const catalog = state.views?.sessions ?? localCatalog;
      const payload = machine && raw ? { ...raw, sessions: catalog } : raw;
      if (machine) state.reviewMachine = { label: machine, ...(payload || !err ? {} : { error: err.replace(/^oak: /, '') }) };
      // From the PAYLOAD, not from this process: every view is built by a spawned child, so the
      // matcher that discovers an unreadable ignore file lives there. Reading our own copy here was
      // reading a map nothing in this process ever populates — the report never fired.
      const igProblems = payload && Array.isArray((payload as Record<string, unknown>).__ignoreProblems)
        ? ((payload as Record<string, unknown>).__ignoreProblems as string[])
        : [];
      if (igProblems.length) state.status = igProblems[0];
      if (payload) {
        // A long-lived dashboard resolves its session ONCE at launch; sessions started after that
        // would go unnoticed forever. When the reader did not pin one with --session, say — once per
        // newcomer — that a newer session is live. Never auto-switch: yanking the store out from
        // under an open review would lose the reader's place mid-decision.
        // Throttled to every 30s: outside a repo this is a machine-wide transcript scan (readdir +
        // stat of every session), and running it on every 3-second tick was a measurable drag.
        if (!args.includes('--session') && !process.env.CLAUDE_OBSERVATORY_SESSION && !process.env.CLAUDE_CHANGES_SESSION && Date.now() - newerSessionCheckedAt > 30_000) {
          newerSessionCheckedAt = Date.now();
          // The SAME scope the launch default used (core.defaultTuiSession): inside a repo, that
          // workspace's newest; outside any repo, the machine-wide newest.
          const newest = core.defaultTuiSession(cwd);
          if (newest && newest !== state.session && newest !== newerSessionHinted && tookTurnSinceLaunch(newest)) {
            newerSessionHinted = newest;
            state.status = 'a newer session is live — press b to switch';
          }
        }
        const follow = claudeAtTail(); // sampled against the frame the reader was actually looking at
        // The traces rows as the reader last saw them, BEFORE the swap replaces them — selection is
        // identity, not position, and the old rows are where the selected key still lives.
        const tracesBox = state.panes ? layout().boxes.find((b) => b.id === 'traces') : null;
        const tracesScreen = tracesBox ? paneScreenOf(state, tracesBox) : 'edits';
        const prevTraces = state.panes ? rowsOf(tracesScreen, 'traces') : null;
        // The SEEN bit (adopted from herdr): a session whose agent went active→idle while
        // it was NOT the one under review wears `done` until the reader looks at it. Runtime
        // state on purpose — like a cursor, it describes THIS sitting, not the store.
        {
          const prevRows = (state.views?.sessions as { sessions?: { id?: unknown; active?: unknown }[] } | undefined)?.sessions ?? [];
          const nextRows = (payload.sessions as { sessions?: { id?: unknown; active?: unknown }[] } | undefined)?.sessions ?? [];
          const done = seenTransitions(prevRows, nextRows, state.doneUnseen, state.session);
          if (done) state.doneUnseen = done;
          // RAISED HANDS: toast once per hand — keyed by the attention ts,
          // the editors' rule — and hand the desktop announcement to core, whose claim file fires it
          // once per machine however many surfaces are open. idle-done stays quiet.
          for (const r of nextRows as { id?: unknown; title?: unknown; agent?: unknown; attention?: unknown }[]) {
            const a = r.attention as { kind: HandKind; message: string; ts: number } | null | undefined;
            const id = typeof r.id === 'string' ? r.id : '';
            if (!id || !a || typeof a.ts !== 'number' || a.kind === 'idle-done') continue;
            if ((handToasted.get(id) ?? 0) >= a.ts) continue;
            handToasted.set(id, a.ts);
            const name = typeof r.title === 'string' && r.title ? r.title : `session ${id.slice(0, 8)}`;
            state.toast = {
              // The Observatory takes `i` for the reply box and `h` for the selected session's pane, so
              // there the keys are named as the Review tab's.
              text: `${name} ${core.attentionLabel(a.kind)}${a.message ? ` — ${a.message}` : ''} · ${tabs[active]?.id === 'observatory' ? 'on Review, ' : ''}${keyForAction('nextHand')} jumps there · ${keyForAction('inbox')} lists every hand`,
              until: Date.now() + 8000,
            };
            core.announceAttention({ id, title: name, agent: typeof r.agent === 'string' ? r.agent : '', attention: a });
          }
        }
        // The recap the feed view now carries — rendered above the prompt, labelled by source.
        const fv = payload.feed as { recap?: unknown; recapSource?: unknown } | null;
        state.recap = typeof fv?.recap === 'string' ? fv.recap : '';
        state.recapSource = typeof fv?.recapSource === 'string' ? fv.recapSource : '';
        state.views = payload;
        void observatory?.publishStore();
        // The status blob's AMBIENT timer: stamp the idle→active edge, clear on quiet. Edge-stamped
        // here — the one place fresh session facts land — so the clock is monotonic across polls,
        // not a sawtooth off individual event timestamps.
        if (sessionActive(state)) state.ambientSince ??= Date.now();
        else state.ambientSince = undefined;
        // A read that BEGAN BEFORE a write cannot contain it. Rather than show the reader the state
        // they just changed away from, the change is re-applied on top and kept until an answer taken
        // after the write finally arrives. ("It was gone for a sec then came back again.")
        const unconfirmed = pendingLocal.filter((m) => startedAt < m.at);
        pendingLocal = unconfirmed;
        for (const m of unconfirmed) applyLocally(m.ids, m.to);
        const cm = payload.changemap as { summary?: { title?: string } } | null;
        // Another machine's session keeps the name its own catalog gives it when the map has none (an
        // older OAK there titles a forwarded map from the ssh login's directory, which finds nothing).
        state.sessionTitle = cm?.summary?.title || (machine && core.realSessionTitle(String(state.reviewSession?.title ?? ''))) || '';
        refreshTabFacts(payload);
        state.error = null;
        if (state.status === 'starting…') state.status = 'ready';
        // Re-anchor the TRACES cursor by row key across the swap (reanchorIndex says why). Traces
        // is the pane whose cursor drives the Detail diff, so an index left pointing at a
        // different row did not just move a highlight — it re-picked the selection and demoted
        // the face the reader had drilled into.
        if (prevTraces && state.panes) {
          const at = reanchorIndex(prevTraces, state.panes.cursor.traces ?? 0, rowsOf(tracesScreen, 'traces'));
          state.panes = { ...state.panes, cursor: { ...state.panes.cursor, traces: at } };
          if (state.panes.focus === 'traces') state.cursor = at;
        }
        if (follow) followClaudeTail();
      }
      // Once, not twice: with nothing on screen yet, the Review panes already say it (reviewMachine).
      if (err && !(machine && !state.views)) state.error = err;
      clampCursor();
      schedulePaint();
    });
  };
  startBackend();

  /**
   * Bound the cursor to the FOCUSED PANE's own row count and scroll it within the PANE's body.
   * Clamping a pane's cursor against the whole terminal's height let j/k walk the selection past the
   * bottom of a 19-row window, so the highlighted row and the row `a`/`u` would act on were different
   * rows. `scroll` is a ROW index, matching `paneVisible`.
   */
  /**
   * The Claude pane is a LIVE TAIL: whenever fresh views land it re-pins to its newest row, so the
   * session's activity reads bottom-up like any tail. A reader INSIDE the pane keeps their place —
   * unless they sit on the LAST row, which is the follow position: `G` (or any walk to the bottom)
   * genuinely re-latches, exactly as the help and DEMO say. `claudeAtTail()` samples the OLD rows
   * before a refresh swaps them, because "was the reader at the bottom" is a fact about the frame
   * they were looking at, not the one that just arrived.
   */
  const claudeAtTail = (): boolean => {
    if (!state.panes || state.panes.focus !== 'claude') return true; // unfocused always follows
    // A cursor that was never SET is not a reader who chose the top row. It starts undefined, and
    // the live cursor starts at 0, so focusing the pane and touching nothing looked exactly like
    // deliberately scrolling to the oldest entry — and the pane then never followed again.
    if (state.panes.cursor.claude === undefined) return true;
    const box = layout().boxes.find((b) => b.id === 'claude');
    if (!box) return true;
    const rows = paneRowCount(state, box);
    return !rows || state.cursor >= rows - 1;
  };

  const followClaudeTail = (): void => {
    if (!state.panes) return;
    const box = layout().boxes.find((b) => b.id === 'claude');
    if (!box) return;
    const rows = paneRowCount(state, box);
    if (!rows) return;
    state.panes = {
      ...state.panes,
      // SCROLL follows; the CURSOR moves only when the reader is IN the pane. An unfocused pane
      // paints its persisted cursor as a faint band, so dragging it to the newest row every refresh
      // put a moving "second selection" on screen beside whatever the reader actually clicked.
      cursor: state.panes.focus === 'claude' ? { ...state.panes.cursor, claude: rows - 1 } : state.panes.cursor,
      scroll: { ...state.panes.scroll, claude: Math.max(0, rows - paneListRows(state, box)) },
    };
    if (state.panes.focus === 'claude') state.cursor = rows - 1; // the live cursor is the focused one
  };

  /** True when the focused pane is a SCROLLER — a diff is read top to bottom, not picked from — so
   *  there is no cursor to clamp and `scroll` is bounded by the viewport instead. */
  const scrollerBox = (): PaneBox | null => {
    if (!state.panes) return null;
    const box = layout().boxes.find((b) => b.id === state.panes!.focus);
    return box && paneScreenOf(state, box) === 'diff' ? box : null;
  };

  const clampCursor = (): void => {
    const box = state.panes ? layout().boxes.find((b) => b.id === state.panes!.focus) : null;
    const sc = scrollerBox();
    if (sc) {
      // Bounded by the LAST FULL SCREEN, not by the line count: stopping at `n - 1` would let the
      // reader scroll a long diff until one line was left above an empty pane.
      const max = Math.max(0, paneRowCount(state, sc) - sc.body.h);
      state.cursor = 0;
      state.scroll = Math.min(max, Math.max(0, state.scroll));
      return;
    }
    const n = box ? paneRowCount(state, box) : state.views ? rowsFor(state).length : 0;
    if (state.cursor >= n) state.cursor = Math.max(0, n - 1);
    if (state.cursor < 0) state.cursor = 0;
    // The viewport is the pane's body LESS whatever fixed lines it draws above the list (a hint, the
    // map's legend). Counting those as list rows made the bottom entry unreachable: the cursor could
    // reach it and the viewport could not show it.
    const body = Math.max(1, box ? paneListRows(state, box) : frameRows - 5);
    if (state.cursor < state.scroll) state.scroll = state.cursor;
    if (state.cursor >= state.scroll + body) state.scroll = state.cursor - body + 1;
    if (state.scroll > state.cursor) state.scroll = state.cursor;
    if (state.scroll < 0) state.scroll = 0;
  };

  /**
   * The workspace the SESSION belongs to — not the directory this terminal happens to be in.
   *
   * The fleet is derived by correlating the repo's git worktrees, and `views` resolves that from
   * `--root`, defaulting to `process.cwd()`. So a dashboard launched anywhere but inside the
   * workspace — or pointed at a session from a different one via the picker — showed an EMPTY Fleet
   * while every other pane worked, because the rest read the store by session id and only this one
   * reads the filesystem. Measured on one session: 40 agents from inside the repo, 0 from `/tmp`.
   *
   * The session's real cwd is recorded in the first line of its own transcript, which is append-only,
   * so this is a fact about the session rather than a guess. Cached by core. When it cannot be
   * resolved — a remote session, a transcript not on this machine — `--root` is omitted and the old
   * cwd default applies, which is no worse than before.
   */
  const sessionRoot = (): string | null => {
    try {
      return core.sessionWorkspace(state.session);
    } catch {
      return null;
    }
  };

  /**
   * The saved machine a session is reviewed ON — read there and decided there — or undefined for
   * this one. It is where the session's herdr pane runs, by the Observatory's own mapping
   * (`sessionMachine`): the capture hooks write the store beside the agent, and keep/undo revert the
   * files beside it. Remembered per session, so a machine that stops answering keeps its sessions
   * pointed at it (their Review names the failure) instead of falling back to an empty read of this
   * machine's store; a pane on this machine clears it, and an Observatory row or a picker row pins it
   * (`targetReview`, `choosePicked`; '' pins this machine). With no pane and nothing pinned, a session
   * this machine does not hold is reviewed on the saved machine whose own catalog lists it. Only the
   * machine's LABEL crosses: the CLI's `--machine` does the rest.
   */
  const sessionMachines = new Map<string, string>();
  /** Set once the Observatory's first discovery has settled — every saved machine asked for its catalog. */
  let searched = false;
  const reviewMachine = (session: string): string | undefined => {
    if (!session) return undefined;
    const found = sessionMachine(state, session);
    if (found?.local) {
      sessionMachines.delete(session);
      elsewhere.delete(session); // a pane here runs it: it is this machine's now
    } else if (found) sessionMachines.set(session, found.label);
    else if (!sessionMachines.has(session)) {
      const listed = listedMachine(state, session);
      if (listed && (elsewhere.has(session) || !holdsHere(session))) sessionMachines.set(session, listed.label);
    }
    return sessionMachines.get(session) || undefined;
  };

  /** The Observatory's id for the machine a session is reviewed on, for a pin that names none. */
  const reviewMachineId = (session: string): string | undefined => {
    const label = reviewMachine(session);
    return label ? state.observatory?.machines.find((m) => m.label === label)?.id : undefined;
  };

  /**
   * A launch that named no session or workspace, outside any repo, reviews the most recently active session
   * on any machine, this one included (Review used to open on this machine's own newest
   * Claude session while the work ran on a saved machine). Review starts on
   * the launch default (this machine's newest Claude session); this machine's listing (every agent) and each
   * saved machine's catalog, weighed once each as they first answer, can move it. Only until the reader
   * chooses a session or acts in the Review tab, and only until every saved machine has answered once, so a
   * review in progress never moves. Never inside a payload or catalog callback: a switch there would let that
   * callback go on painting the old session's rows under the new one's header, so the hooks
   * queue it (`queueAdopt`). With no launch session nothing else reads this machine's listing, so the rule
   * reads it (every agent, no session named) and decides nothing until it has answered or failed.
   */
  let adoptOpen = reviewNewestAnywhere;
  let adoptQueued = false;
  /** Listings the rule has weighed (saved machines by id, this machine's as `localWeighed`): a refresh of
   *  theirs never moves Review again. */
  const adoptWeighed = new Set<string>();
  let localWeighed = false;
  let localAwaited = !session && reviewNewestAnywhere;
  function queueAdopt(): void {
    if (!adoptOpen || adoptQueued) return;
    adoptQueued = true;
    queueMicrotask(() => { adoptQueued = false; adoptNewestAnywhere(); });
  }
  function adoptNewestAnywhere(): void {
    if (!adoptOpen || localAwaited) return;
    const ri = tabs.findIndex((t) => t.id === 'review');
    const current = (ri >= 0 ? tabs[ri].session : undefined) ?? state.session;
    const local = (localCatalog as { sessions?: Record<string, unknown>[] } | undefined)?.sessions;
    const found = newestAnywhere(state, local, current, (m) => (m ? !adoptWeighed.has(m.id) : !localWeighed));
    if (found !== undefined) {
      if (local) localWeighed = true;
      for (const m of state.observatory?.machines ?? []) if (!m.local && (m.sessions || m.sessionsError)) adoptWeighed.add(m.id);
    }
    if (found && ri >= 0 && !(active === ri && (state.overlay || state.confirm))) {
      const label = found.machine?.label ?? ''; // '' pins this machine
      const row = (found.machine ? found.machine.sessions?.sessions : local)?.find((r) => r.id === found.session);
      const title = core.realSessionTitle(String(row?.title ?? '')) || found.session.slice(0, 8);
      if (active === ri) {
        choosePicked(found.session, label);
        adoptOpen = true; // its own switch is not the reader's choice: a machine answering later may still outrank it
      } else {
        sessionMachines.set(found.session, label);
        tabs[ri].session = found.session;
      }
      state.status = `Review is on ${title}${label ? ` on ${label}` : ''}, active more recently`;
      schedulePaint();
    }
    // Decided once every saved machine has answered and the session Review is on could be weighed.
    if (searched && found !== undefined && (state.observatory?.machines ?? []).every((m) => m.local || m.sessions || m.sessionsError)) adoptOpen = false;
  }
  if (localAwaited) {
    void backend!.run(['sessions', '--json']).then((out) => {
      const listed = JSON.parse(out) as { sessions?: unknown };
      if (Array.isArray(listed?.sessions) && !Array.isArray((localCatalog as { sessions?: unknown } | undefined)?.sessions)) localCatalog = listed;
    }).catch(() => undefined).finally(() => { localAwaited = false; queueAdopt(); });
  }

  /** Ask for a fresh read. Pass `force` after a WRITE: an identical read already in flight was
   *  taken before it, so coalescing the two shows the reader the state they just changed away
   *  from. */
  const ask = (force = false): void => {
    const root = sessionRoot();
    const names = new Set(tabs[active]?.id === 'observatory' ? ['sessions'] : viewsForLayoutOf(core, layout()));
    // Observatory reads conversations/workers on demand and only polls the session catalog.
    // A custom tree leaf still adds the views it actually renders.
    // `tabs[active].root` is the TREE root; the store `root` above is a different thing (a workspace).
    const treeRoot = tabs[active]?.root;
    if (treeRoot) {
      for (const v of leafViews(treeRoot)) {
        const screen = VIEW_SCREEN[v];
        for (const view of (screen && VIEWS_FOR[screen]) || []) names.add(view);
      }
    }
    // Master browsing never retargets a views fetch. Each pinned leaf reads its own conversation
    // and worker/task facts; legacy tree boards keep their selected-worker scoping.
    const scoped = treeRoot && tabs[active]?.id !== 'observatory' && state.scopeWorker;
    const fetchSession = scoped ? state.scopeWorker!.session : state.session;
    if (!fetchSession) {
      // Nothing resolved at launch (a first run): there is no session to read, so a `views` request
      // would only fail. Adopt the first session this machine gets — the launch default's own scope —
      // through the same switch the picker uses; until then say what is missing, every poll.
      const first = core.defaultTuiSession(cwd);
      // Deferred: the launch's own first read runs before the picker's state below it is declared, and
      // `oak tui --root <dir>` from a directory with no session of its own crashed on it at startup.
      if (first && core.isSafeSessionId(first) && !state.overlay) return void queueMicrotask(() => choosePicked(first));
      state.status = 'no agent session yet — start one in the herdr tab; the Observatory lists every session';
      return schedulePaint();
    }
    // A session on another machine is reviewed THERE. Not on the Observatory tab, whose catalog is this
    // machine's. Remote session metadata is kept separately; it cannot replace that catalog.
    const machine = tabs[active]?.id === 'observatory' ? undefined : reviewMachine(fetchSession);
    // A launch session this machine does not hold, before any saved machine has listed it: reading
    // here would paint an empty review of a session that is not here. Say where it is being looked for,
    // then — once every saved machine has answered — that none holds it.
    state.reviewFinding = !machine && tabs[active]?.id !== 'observatory' && elsewhere.has(fetchSession)
      ? (!searched || (state.observatory?.machines ?? []).some((m) => !m.local && !m.sessions && !m.sessionsError)
        ? `looking for this session on ${(state.observatory?.machines ?? []).filter((m) => !m.local).map((m) => m.label).join(', ') || 'the saved machines'}…`
        : nowhere(fetchSession))
      : undefined;
    if (state.reviewFinding) {
      state.views = null;
      state.reviewMachine = undefined;
      return schedulePaint();
    }
    if (machine) names.add('sessions');
    if (state.reviewMachine?.label !== machine) {
      state.views = null;
      state.reviewSession = undefined;
      state.diffPatch = undefined;
      state.diffMeta = undefined;
      state.marked = new Set();
      state.confirm = null;
      pendingLocal = [];
    }
    state.reviewMachine = machine
      ? { label: machine, error: state.reviewMachine?.label === machine ? state.reviewMachine.error : undefined }
      : undefined;
    // A remote workspace comes from its pane, never a transcript copy on this machine.
    const fetchRoot = machine ? observatorySelection(state, fetchSession).root
      : (scoped && state.scopeWorker!.root) || root || '';
    const extra = fetchRoot ? ['--root', fetchRoot] : [];
    backend!.request([...names], fetchSession, extra, force, machine);
  };

  /** Only decide on rows read from the current owner, including between periodic polls. */
  const reviewReady = (): boolean => {
    if (reviewMachine(state.session) === state.reviewMachine?.label && state.views !== null) return true;
    ask(true);
    state.status = 'waiting for the current review before deciding';
    schedulePaint();
    return false;
  };

  /**
   * The screen the FOCUSED pane is showing, through the same resolver the renderer uses.
   *
   * `state.screen` is not that. It is a leftover from the single-screen product, it is only updated
   * on some focus changes, and it cannot name Detail's faces at all — so anything that reads it to
   * decide what the reader is looking at is reading a different pane's list. Two live defects came
   * out of exactly that: the arrows stepped the map's cursor over the edit list's rows, and focusing
   * Detail cleared the face the reader had just chosen.
   */
  const focusedScreen = (): string => {
    if (!state.panes) return state.screen;
    const box = layout().boxes.find((b) => b.id === state.panes!.focus);
    return box ? paneScreenOf(state, box) : state.screen;
  };

  /**
   * The rows of one pane, computed at the width that pane is DRAWN at.
   *
   * `rowsFor` defaults to 100 columns, which is a rendering width, not a neutral one: the change
   * map wraps a long folder name onto continuation rows, so a Detail pane 78 columns wide has a
   * different row LIST from the same data at 100. Every keyboard resolver that used the default was
   * therefore indexing a list the reader was not looking at — Enter folded the wrong node, and rows
   * past the first wrap were unreachable. The mouse path always passed the real width; the keyboard
   * path did not.
   */
  const rowsOf = (screen?: string, pane?: PaneId): DashRow[] => {
    const id = pane ?? state.panes?.focus;
    const box = id ? layout().boxes.find((b) => b.id === id) : undefined;
    return rowsFor(
      { ...state, screen: (screen ?? focusedScreen()) as typeof state.screen },
      Math.max(1, (box?.rect.w ?? frameCols) - 1),
      glyphs,
    );
  };

  /** Which of Detail's two faces is on screen, resolved through the SAME function the renderer uses. */
  const detailShows = (): 'diff' | 'map' | null => {
    const box = state.panes ? layout().boxes.find((b) => b.id === 'detail') : null;
    return box ? (paneScreenOf(state, box) as 'diff' | 'map') : null;
  };

  /**
   * The change-map node a DISPLAY row index points at.
   *
   * Resolved by PATH, not by position. `rowsFor` emits one display row per rendered line — a name too
   * wide for the pane occupies several — while `mapRows` emits one entry per node, so the two index
   * spaces diverge the moment any name wraps. Indexing the tree with a display index therefore acted
   * on a different file than the one under the cursor, and in this tool that means reverting
   * something nobody pointed at. `openPath` is on the display row precisely so this never has to
   * count.
   */
  /** The change-map tree for the CURRENT payload, with the root that anchors outside paths.
   *  MEMOIZED on the views object's identity: `syncDetailDiff` derives the map scope on every sync,
   *  and rebuilding the whole tree per keystroke is a per-keystroke cost for a structure that only
   *  changes when a payload lands. */
  let mapTreeMemo: { views: unknown; tree: ReturnType<typeof buildMapTree> | null } | null = null;
  const mapTree = (): ReturnType<typeof buildMapTree> | null => {
    if (mapTreeMemo && mapTreeMemo.views === state.views) return mapTreeMemo.tree;
    const cmv = view(state, 'changemap') as { files?: unknown[]; summary?: { root?: unknown } } | null;
    const root = typeof cmv?.summary?.root === 'string' ? (cmv.summary.root as string) : undefined;
    const tree = Array.isArray(cmv?.files) ? buildMapTree(cmv.files as never, root) : null;
    mapTreeMemo = { views: state.views, tree };
    return tree;
  };

  const mapNodeAt = (
    rowIndex: number
  ): { path: string; pending: number; isFile: boolean; undone: number; abs?: string } | null => {
    const box = layout().boxes.find((b) => b.id === 'map');
    const rows = rowsFor(
      { ...state, screen: 'map' },
      Math.max(1, (box?.rect.w ?? frameCols) - 1),
      glyphs
    );
    const path = rows[rowIndex]?.openPath;
    if (path === undefined) return null;
    const tree = mapTree();
    if (!tree) return null;
    const hit = mapRows(tree, state.open).find((r) => r.node.path === path);
    return hit
      ? { path: hit.node.path, pending: hit.node.pending, isFile: hit.node.isFile, undone: hit.node.undone, abs: hit.node.abs }
      : null;
  };

  /** The change-map node under the MAP pane's cursor, with the totals its actions need. (The map
   *  cursor moved to `cursor.map` with the pane split — `cursor.detail` was the stale read.) */
  const selectedMapNode = () => mapNodeAt(state.panes?.cursor?.map ?? 0);

  /**
   * The Keep/Undo cell under a click on the map, or null.
   *
   * Resolved through `mapRowActions` — the same function that laid the cells out — at the same width
   * the row was rendered at. Recomputing the columns here is how an action ends up drawn on one row
   * and pressable on another, and this one reverts a whole folder.
   */
  const mapActionAt = (
    box: PaneBox,
    rowIndex: number,
    col: number
  ): { action: 'keep' | 'undo' | 'redo'; node: { path: string; pending: number; isFile: boolean; undone: number } } | null => {
    const node = mapNodeAt(rowIndex);
    if (!node) return null;
    const tree = mapTree();
    const row = tree ? mapRows(tree, state.open).find((r) => r.node.path === node.path) : null;
    if (!row) return null;
    const inner = Math.max(1, box.body.w - 1);
    const local = col - box.body.x - PANE_GUTTER;
    const hit = mapRowActions(row, inner).find((a) => local >= a.x && local < a.x + a.w);
    return hit ? { action: hit.action, node } : null;
  };

  /**
   * The [review] cell under a click on a Prompts row, or null — resolved through `promptRowActions`,
   * the same function that laid the cell out, at the same width. Same contract as `mapActionAt`: one
   * function owns the geometry, so the glyph and the pointer cannot disagree.
   */
  const promptActionAt = (box: PaneBox, col: number): boolean => {
    const inner = Math.max(1, box.body.w - 1);
    const local = col - box.body.x - 1; // the cursor gutter is column 0 of every body row
    return promptRowActions(inner).some((a) => local >= a.x && local < a.x + a.w);
  };


  /**
   * Report a finished mutation the same way whatever its scope was — one place, one wording.
   *
   * REFUSALS are named, not folded into the count. `undoScope` returns three separate numbers —
   * `undone`, `conflicts` and `errors` — and an engine refusal (the #43 phantom guard, an unlink
   * that fails) lands in `errors` with its reason in `firstError`. Reporting only the first two
   * turns "every edit here refused, and here is why" into a bare "undo: 0 edit(s)", which reads as
   * "there was nothing to do".
   */
  /**
   * What we have changed but not yet seen confirmed, and WHEN.
   *
   * A read that started before the write lands after it and carries the store as it was — the
   * accepted rows come straight back, which is exactly what "it was gone for a sec then came back"
   * is. The overlay is re-applied to every payload that predates the write, and dropped by the
   * first one taken after it (which already contains the change).
   */
  let pendingLocal: { at: number; ids: number[]; to: 'kept' | 'undone' | 'pending' }[] = [];

  /** Flip the ids the CLI just reported, in the payload the frame is drawing from. Structure is
   *  untouched — only a status, and the counts derived from it. */
  const applyLocally = (ids: number[], to: 'kept' | 'undone' | 'pending'): void => {
    if (!ids.length || !state.views) return;
    const want = new Set(ids);
    const cm = (state.views as Record<string, unknown>).changemap as
      | { summary?: Record<string, number>; edits?: { id: number; status: string; rel?: string }[]; files?: Record<string, unknown>[] }
      | undefined;
    if (!cm?.edits) return;
    // Per FILE, so the map rows and the summary move together with the rows they describe.
    const movedByRel = new Map<string, number>();
    let moved = 0;
    for (const e of cm.edits) {
      if (!want.has(e.id) || e.status === to) continue;
      if (e.status === 'pending') {
        moved++;
        movedByRel.set(e.rel ?? '', (movedByRel.get(e.rel ?? '') ?? 0) + 1);
      }
      e.status = to;
    }
    if (!moved) return;
    if (cm.summary) {
      cm.summary.pending = Math.max(0, (cm.summary.pending ?? 0) - moved);
      cm.summary[to] = (cm.summary[to] ?? 0) + moved;
    }
    for (const f of cm.files ?? []) {
      const n = movedByRel.get(String(f.rel ?? ''));
      if (!n) continue;
      f.pending = Math.max(0, (Number(f.pending) || 0) - n);
      f[to] = (Number(f[to]) || 0) + n;
    }
    // The payload object is REPLACED, not mutated in place: every memo in the renderer keys on its
    // identity, and a mutated-in-place payload would redraw the old rows.
    state.views = { ...state.views };
  };

  const reportMutation = (verb: string, asked: number, session = state.session, machine = reviewMachine(session)) => (r: { ok: boolean; json: unknown; err: string | null }) => {
    if (session !== state.session || machine !== reviewMachine(state.session)) {
      ask(true); // completed on the old owner; never apply those ids to the current rows
      return schedulePaint();
    }
    const j = (r.json ?? {}) as Record<string, unknown>;
    // The ids the CLI actually changed — never the ids we asked about.
    const done = Array.isArray(j.ids) ? (j.ids as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : [];
    // Files rewritten whose status the store could not record: shown as the error it is, and never
    // painted as decided — the next read shows what the store holds.
    const unrecorded = (j.unrecorded as { message?: unknown } | undefined)?.message;
    if (r.ok && done.length && typeof unrecorded !== 'string') {
      const to = verb === 'undo' ? 'undone' : verb === 'redo' ? 'pending' : 'kept';
      applyLocally(done, to);
      // Remembered until a read taken AFTER this write confirms it.
      pendingLocal.push({ at: Date.now(), ids: done, to });
    }
    if (!r.ok) state.error = r.err;
    else if (typeof j.status === 'string') {
      // The single-unit verbs answer the engine's own result — its message IS the report, and a
      // refusal arrives named (dependents, closure) rather than as a count.
      const msg = typeof j.message === 'string' ? j.message : '';
      state.status = j.status === 'conflict' ? `conflict — ${msg.split('. ')[0]}` : msg || `${verb}: done`;
    } else {
      const n = Number(j.kept ?? j.undone ?? j.redone ?? asked) || 0;
      const conflicts = Number(j.conflicts ?? 0) || 0;
      const errors = Number(j.errors ?? 0) || 0;
      const first = typeof j.firstError === 'string' ? j.firstError : '';
      // The first conflict's NAMING sentence only — the CLI-flavoured remedy tail stays off the
      // status row (`u` on the named unit is one keystroke away here).
      const conflictName = (typeof j.firstConflict === 'string' ? j.firstConflict : '').split('. ')[0];
      const parts = [`${verb}: ${n} edit(s)`];
      if (conflicts)
        parts.push(
          conflictName
            ? `${conflicts} conflict(s) — ${conflictName}`
            : `${conflicts} conflict(s) left — act on them one at a time to force`
        );
      if (errors) parts.push(`${errors} refused${first ? ` — ${first}` : ''}`);
      state.status = parts.join(' · ');
    }
    if (r.ok && typeof unrecorded === 'string') state.error = unrecorded;
    ask(true); // a mutation always forces a fresh read; stale counts must not outlive the action
    schedulePaint();
  };

  const applyUnder = (verb: 'keep' | 'undo' | 'redo', under: string): void => {
    if (!reviewReady()) return;
    state.status = `${verb}ing everything under ${under}…`;
    schedulePaint();
    const machine = reviewMachine(state.session);
    // A workspace-relative node resolves against the CLI's cwd, and on another machine that is its
    // home directory: anchor it to the workspace the map was built from, a path on that machine.
    const root = (view(state, 'changemap') as { summary?: { root?: unknown } } | null)?.summary?.root;
    if (machine && !path.posix.isAbsolute(under) && (typeof root !== 'string' || !path.posix.isAbsolute(root))) {
      state.status = 'cannot decide this folder until its remote workspace is known';
      return schedulePaint();
    }
    const scope = machine && typeof root === 'string' && !path.posix.isAbsolute(under) ? path.posix.join(root, under) : under;
    void backend!.mutateUnder(verb, scope, state.session, machine).then(reportMutation(verb, 0));
  };

  const applyMutation = (verb: 'keep' | 'undo' | 'redo', ids: number[]): void => {
    if (!reviewReady()) return;
    state.status = `${verb}ing ${ids.length} edit(s)…`;
    schedulePaint();
    // Through `reportMutation`, like the scoped path: it inlined a copy of that function's body, so
    // the "one place, one wording" its doc comment promises was true of the rarer caller only, and
    // every keyboard keep/undo/redo took the copy that had drifted.
    // The marks are SPENT here. Leaving them standing means the next `a` silently re-acts on edits the
    // reader already dealt with, and the set is not on screen once its rows have gone.
    state.marked = new Set<number>();
    void backend!.mutate(verb, ids, state.session, reviewMachine(state.session)).then(reportMutation(verb, ids.length));
  };

  /**
   * Keep or undo everything beneath one change-map node.
   *
   * `--under <path>` is the CLI's own file-or-folder scope, so this spends ONE process and shares the
   * exact rule the editors' folder Accept uses. It always asks first with the real count: a folder
   * row can stand for hundreds of edits, and the number is the only thing that tells the reader
   * whether they are about to revert one file or a package.
   */
  const mutateUnder = (
    verb: 'keep' | 'undo' | 'redo',
    node: { path: string; pending: number; isFile: boolean; undone: number; abs?: string }
  ): void => {
    // The legacy anonymous bucket is a LABEL, not a path (older on-disk caches only). Sending it as
    // `--under` resolves to <cwd>/(outside the workspace), matches nothing, and reports "0 edit(s)"
    // after a confirmed yes — the exact silent no-op the confirmation exists to prevent.
    if (node.path === OUTSIDE) {
      state.status = 'these edits are outside the workspace — open one and act on it directly';
      return schedulePaint();
    }
    // `redo` acts on what was UNDONE beneath the node; keep and undo act on what is still pending.
    // Asking about the wrong count is how a reader agrees to a number that has nothing to do with
    // what is about to happen.
    const n = verb === 'redo' ? node.undone : node.pending;
    if (!n) {
      state.status = `nothing to ${verb} under ${node.path}`;
      return schedulePaint();
    }
    state.confirm = {
      verb,
      ids: [],
      // An outside-workspace node scopes by its REAL absolute path — undoScope matches records'
      // absolute files, so this is the shape that actually selects them. Inside nodes keep the
      // workspace-relative path the CLI resolves against its cwd, exactly as before.
      under: node.abs ?? node.path,
      label: `${n} edit(s) under ${node.isFile ? '' : 'everything in '}${node.path}`,
    };
    schedulePaint();
  };

  /**
   * Keep or undo EVERYTHING in the session — the change map's toolbar, and what `A`/`U` mean there.
   *
   * The map's rows carry no edit ids (they stand for files and folders, not edits), so the id-set
   * path resolved to an empty set and both keys did nothing at all from this window. `--all` is the
   * CLI's own session scope, and it always asks first with the real count.
   */
  const mutateAll = (verb: 'keep' | 'undo'): void => {
    const tree = mapTree();
    if (!tree) {
      state.status = 'the change map has not been read yet';
      return schedulePaint();
    }
    if (!tree.pending) {
      // Nothing pending: offer the verb that IS available rather than refusing with a dead message.
      if (tree.kept || tree.undone) return confirmResolve();
      state.status = 'nothing pending in this session';
      return schedulePaint();
    }
    state.confirm = { verb, ids: [], all: true, label: `${tree.pending} pending edit(s) — everything in this session` };
    schedulePaint();
  };

  /** The finishing verb: accept what is left, then stop carrying the session's resolved history. */
  const confirmResolve = (): void => {
    const tree = mapTree();
    const pend = tree?.pending ?? 0;
    state.confirm = {
      verb: 'resolve',
      ids: [],
      label: pend
        ? `accept the ${pend} pending edit(s) and clear this session's history`
        : "clear this session's resolved history",
    };
    schedulePaint();
  };

  /**
   * Answer the standing question — from the key OR from the map's own [ y ] / [ n ] buttons.
   *
   * One path, because a mouse answer and a keyboard answer that disagree about what `y` does is a
   * bug in a tool that reverts files. A path scope is not an id set, and neither is a session
   * scope: sending `ids` (empty, for either) would exit 0 having done nothing and report
   * "keep: 0 edit(s)" — a confirmed action that silently did not happen, which is the worst
   * outcome a y/n prompt can produce.
   */
  const answerConfirm = (yes: boolean): void => {
    const q = state.confirm;
    if (!q) return;
    state.confirm = null;
    if (!yes) {
      state.status = 'cancelled';
      // The delete confirm REPLACED the picker's rows with its explanation — put the list back so
      // `n` returns to exactly the picker (filter and all) the reader pressed the key from.
      if (q.verb === 'delete' && pickerOpen) return renderSessionPicker();
      return schedulePaint();
    }
    if (q.verb === 'delete') return applyDeleteSession(q.session ?? '', q.pending ?? 0, q.seenThrough);
    if (q.verb === 'resolve') return applyResolve(q.session ?? state.session);
    if (q.verb === 'kill') return applyKill(q.session ?? state.session);
    if (q.all && (q.verb === 'keep' || q.verb === 'undo')) return applyAll(q.verb);
    if (q.under) return applyUnder(q.verb, q.under);
    return applyMutation(q.verb, q.ids as number[]);
  };

  const applyAll = (verb: 'keep' | 'undo'): void => {
    if (!reviewReady()) return;
    state.status = `${verb}ing every pending edit…`;
    schedulePaint();
    void backend!.mutateAll(verb, state.session, reviewMachine(state.session)).then(reportMutation(verb, 0));
  };

  const applyResolve = (session: string = state.session): void => {
    if (!reviewReady()) return;
    state.status = 'resolving the session…';
    schedulePaint();
    void backend!.resolveAll(session, reviewMachine(session)).then((r) => {
      const j = (r.json ?? {}) as Record<string, unknown>;
      if (!r.ok) state.error = r.err;
      else state.status = `resolved: accepted ${Number(j.accepted ?? 0)} pending, cleared ${Number(j.cleared ?? 0)} record(s)`;
      ask(true); // the map is now empty of what it just resolved; stale counts must not outlive it
      schedulePaint();
    });
  };


  const applyKill = (session: string): void => {
    // Any running agent: the agent's `claude --resume <id>` carries the session id, so
    // core finds its pid (only when exactly one matches, never guessing) and we send it a SIGTERM.
    const pid = core.findAgentPid(session);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        state.status = `stopped the agent (pid ${pid}) — SIGTERM sent`;
      } catch (e) {
        state.status = `could not stop pid ${pid}: ${String((e as Error)?.message || e)}`;
      }
      ask(true);
      return schedulePaint();
    }
    state.status = `no single running agent found for ${session.slice(0, 8)} — nothing to stop`;
    schedulePaint();
  };

  /**
   * DELETE a session from Observatory. `core.deleteSession`
   * hides it from every enumeration AND purges its stored edits for good — the agent's own transcript/rollout
   * on disk is left untouched, and `oak sessions --undelete <id>` lists the session again, without its edits.
   * In-process, the same call the CLI verb runs, so the picker and the standalone command can never disagree
   * about what "delete" removes. `confirmedPending` is how many edits still pending review the confirmation
   * named and `seenThrough` the newest edit id of the listing it counted from (the row's `lastEdit`): core
   * refuses when more are pending or when a pending edit is newer, so no edit captured after that listing is
   * purged unseen, even one that joined a change the count included.
   */
  const applyDeleteSession = (id: string, confirmedPending: number, seenThrough?: number): void => {
    if (!id) return schedulePaint();
    try {
      core.deleteSession(id, { confirmedPending, seenThrough });
    } catch (e) {
      state.error = `could not delete ${id.slice(0, 8)}: ${String((e as Error)?.message || e)}`;
      return pickerOpen ? renderSessionPicker() : schedulePaint();
    }
    // Immediate: drop the row from the cached list so it vanishes NOW, before the forced re-fetch
    // lands. `renderSessionPicker` reads straight from this array, so splicing here is what makes the
    // row disappear the instant the reader confirms rather than one poll later.
    const sv = state.views?.sessions as { sessions?: Record<string, unknown>[] } | undefined;
    if (sv?.sessions) sv.sessions = sv.sessions.filter((s) => String(s.id) !== id);
    // If the session in effect is the one just deleted, move to the newest one still visible — the core
    // resolver already skips hidden sessions ("a deleted session is never auto-selected"), so this is the
    // same fallback the terminal front door uses.
    if (state.session === id) {
      const next = core.defaultTuiSession(cwd);
      if (next && next !== id) state.session = next;
    }
    // Any tab pinned to the deleted session loses its pin and follows the terminal's session, so no tab is
    // left reviewing a session that no longer appears in any menu.
    for (const t of tabs) if (t.session === id) t.session = state.session;
    state.status = `deleted ${id.slice(0, 8)} and purged its edits — oak sessions --undelete ${id} lists it again, without them`;
    if (pickerOpen) renderSessionPicker();
    else schedulePaint();
    ask(true); // re-fetch the authoritative session list (every enumeration filters hidden sessions)
  };

  /**
   * Everything a keep/undo could act on is scoped to ONE session — the diff on screen, the row the
   * reader picked, the marks. A session switch that left them standing let `u` on the Diff face send
   * `undo #5` to the NEW session, whose #5 is some other file (TUI sweep, 2026-09-23: reviewed A,
   * zoomed edit #5, picked B, pressed u → B's #5 reverted, no confirm). Edit ids are per session and
   * low ones collide in every session, so nothing is carried across.
   */
  function forgetSessionSelection(): void {
    state.promptScope = null; // a prompt's edit ids name edits of the session it was chosen in
    state.diffPatch = undefined;
    state.diffMeta = undefined;
    diffWanted = -1;
    picked = false;
    state.marked = new Set();
  }

  const mutateScope = (verb: 'keep' | 'undo' | 'redo', scope: 'one' | 'all'): void => {
    // `state.screen` cannot represent the Diff face, so focusPane leaves it on whatever the previous
    // window showed. Without this guard, pressing `a`/`u` with Detail focused silently kept or UNDID
    // an edit in the Traces list — a row the reader was not looking at, in a tool that reverts code.
    // The navbar's Keep/Undo act on the edit Detail is SHOWING. Detail's face is the diff, so the
    // guard below would refuse — but here the target is unambiguous, so resolve it directly.
    if (scope === 'one' && state.diffMeta && state.panes?.focus === 'detail' && detailShows() === 'diff') {
      // Belt and braces: a diff fetched for another session never becomes a mutation in this one.
      if (state.diffMeta.session && state.diffMeta.session !== state.session) {
        state.status = 'the diff on screen belongs to another session — select an edit in Traces first';
        return schedulePaint();
      }
      return applyMutation(verb, [state.diffMeta.id]);
    }
    // On the MAP the cursor is on a FILE OR FOLDER, and keep/undo act on its whole subtree. The
    // pane split moved the map out of Detail, and the old `detailShows() === 'map'` test here
    // could never be true again — keyboard keep/undo from the Map was dead, mouse-only.
    if (scope === 'one' && state.panes?.focus === 'map') {
      const node = selectedMapNode();
      if (node) return mutateUnder(verb, node);
    }
    // `A`/`U` on the map mean the whole SESSION — see `mutateAll`. Redo has no everything-key.
    if (scope === 'all' && verb !== 'redo' && state.panes?.focus === 'map') return mutateAll(verb);
    // The focused pane's box, which CAN be absent: a minimized window has none, and neither does one
    // the current size cannot fit. The `!` that used to stand here was a lie, and `paneScreenOf` then
    // dereferenced undefined — so `m` followed by `a` killed the dashboard outright, as did pressing
    // `a` with Prompts or Dashboards focused at any height under ~24 rows, where they fold onto the
    // bar by default. Every other `boxes.find` in this file already guards; this was the one that did
    // not, and the crash reached a keystroke that reverts code.
    const focusedBox = state.panes ? layout().boxes.find((b) => b.id === state.panes!.focus) : undefined;
    if (state.panes && !focusedBox) {
      const spec = PANE_SPECS.find((p) => p.id === state.panes!.focus);
      state.status = `${spec?.title ?? 'that window'} is not open at this size — press its key to restore it, or = to reset the layout`;
      return schedulePaint();
    }
    if (focusedBox && paneScreenOf(state, focusedBox) === 'diff') {
      state.status = `Detail is showing a diff — press F3 for Traces to ${verb} an edit`;
      return schedulePaint();
    }
    // The FOCUSED pane's screen, not `state.screen` — acting on a list the reader is not looking at
    // is the worst thing a tool that reverts code can do.
    const screen = focusedScreen() as typeof state.screen;
    // A MARKED set wins over the cursor for the single-row scope: marking six files and pressing `a`
    // is the whole point of marking, and acting on the one row under the cursor instead would revert
    // the reader's intent silently. `A`/`U` still mean "everything this window lists" — a mark set is
    // a narrowing, and having the everything-verb honour it would leave no way to say "all of them".
    const marks = [...(state.marked ?? [])];
    const ids = scope === 'one' && marks.length ? marks : selectionIds({ ...state, screen }, scope);
    if (ids.length === 0) {
      // Never a silent no-op: say WHY this screen cannot resolve an edit set.
      state.status =
        screen === 'audit' || screen === 'feed' || screen === 'agents'
          ? `${screen} rows are observations, not edits — use Traces or Prompts to ${verb}`
          : 'nothing selected';
      schedulePaint();
      return;
    }
    if (scope === 'all' || ids.length > 1) {
      const what = scope === 'all' ? 'every row listed' : marks.length ? `the ${marks.length} marked edit(s)` : 'this selection';
      state.confirm = { verb, ids, label: `${what} on ${screen}` };
      schedulePaint();
      return;
    }
    applyMutation(verb, ids);
  };

  /**
   * Hand the terminal to a CHILD, then take it back.
   *
   * Not `restore()`: that one is the exit path — it is idempotent-by-latch, closes the backend and
   * kills the timers, so calling it here would leave a dashboard that never repaints again. This
   * pair touches only the modes a child program needs owned: raw mode, the alternate screen, mouse
   * and paste reporting.
   */
  const enterTerminal = (): void => {
    out.write(ALT_ON + CURSOR_HIDE + PASTE_ON + MOUSE_OFF + (mouse ? MOUSE_ON : '') + FOCUS_ON);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
  };
  const suspendTerminal = (): void => {
    // Remembered across the handover so `resumeTerminal` can say what MOVED while the reader was in
    // $EDITOR — Claude keeps working, and coming back to a changed list with nothing saying so means
    // re-reading the whole pane to find out whether it is the one you left.
    for (const s of nativeSessions.values()) s.setHostActive?.(false);
    awayPending = pendingCount();
    if (tick) clearInterval(tick);
    tick = null;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      /* already gone; the child will find out */
    }
    out.write((pointerShape !== 'default' ? pointerSeq('default', !!process.env.TMUX) : '') + (lastWindowTitle ? TITLE_RESET : '') + PASTE_OFF + MOUSE_OFF + FOCUS_OFF + CURSOR_SHOW + ALT_OFF);
    // LAST, after the mode reset above has gone out: from here until `resumeTerminal`, the terminal
    // belongs to the child, and anything this runtime would paint lands on the child's screen. The
    // interval is already cleared, but the in-flight work it started is not — a views payload, the
    // debounced diff fetch, a resize — and each of those ends in schedulePaint. The gate is what
    // makes their completions update state silently instead of corrupting the handover.
    out.suspend();
  };
  /** The pending count when the terminal was handed to a child, so coming back can say what moved. */
  let awayPending: number | null = null;

  const resumeTerminal = (): void => {
    // Open the gate BEFORE `enterTerminal`, whose mode sequences are the first bytes of taking the
    // terminal back. Everything dropped during the suspension left `dirty` standing, so the single
    // `paint()` at the end of this function is the one full frame that catches the screen up.
    out.resume();
    enterTerminal();
    refreshSize(); // the child may have been resized, or resized the window itself
    // A failed spawn fires BOTH 'error' and 'close', and each resumes — without this clear the
    // first interval leaks and the dashboard polls (and spawns a CLI) at double rate forever.
    if (tick) clearInterval(tick);
    tick = setInterval(() => {
      ask();
      schedulePaint();
    }, refreshMs());
    tick.unref?.();
    ask();
    // …and said on the way back in, once the refresh above has landed a fresh payload to compare with.
    const before = awayPending;
    awayPending = null;
    if (before !== null) {
      setTimeout(() => {
        const now = pendingCount();
        if (now !== before) {
          state.status = `back — ${now > before ? `${now - before} new edit(s) while you were away` : `${before - now} fewer pending`}`;
          schedulePaint();
        }
      }, 400);
    }
    paint();
  };

  /** Pending edits in the payload right now, or null when nothing has arrived yet. */
  function pendingCount(): number {
    const list =
      (state.views?.list as { edits?: { status?: string; cancelled?: boolean }[] } | undefined)?.edits ?? [];
    // Cancelled chains are not rows in the pane, so they are not in its counter either — the payload
    // flags them exactly so every renderer can agree on what "pending" means.
    return list.filter((e) => e?.status === 'pending' && e?.cancelled !== true).length;
  }

  /**
   * Open the selected file in `$EDITOR`. Advertised in the key row and the help since this command
   * shipped, and bound to nothing at all until now.
   *
   * The child gets the real terminal, inherited, and this process waits: `$EDITOR` is usually a
   * full-screen program, and handing it a pipe would leave the reader looking at a frozen dashboard
   * while vim waited for input it could not receive.
   */
  function openConversation(sessionId: string): void {
    pinSession(sessionId, state.scopeWorker?.session === sessionId ? state.scopeWorker.machineId : undefined);
  }

  /** The conversation leaf the last pin filled; a master click fills it again (see pinSession). */
  let pinLeaf: string | undefined;
  /** All conversation entry points share this transition. Changing the master selection alone
   * never calls it. Each detail leaf keeps its own pin and scroll when the reader splits it: the
   * pin fills the focused conversation leaf, else `leaf` when it is one, else the first. */
  function pinSession(sessionId: string, machineId?: string, leaf?: string): void {
    if (!sessionId || state.confirm) return;
    const tab = tabs.find(t => t.id === 'observatory')!;
    const detailLeaf = (id?: string) => leafPanes(tab.root!).find(p => p.id === id && p.view === 'session-detail');
    let paneId = (detailLeaf(tab.treeFocus) ?? detailLeaf(leaf) ?? leafPanes(tab.root!).find(p => p.view === 'session-detail'))?.id;
    if (!paneId) {
      // A direct jump still opens its conversation after the reader closed the default detail.
      paneId = leafIds(tab.root!).includes('obs-detail') ? `split-${nextSplitId++}` : 'obs-detail';
      tab.root = splitPane(tab.root!, firstLeafId(tab.root!), 'h', paneId, 'session-detail');
      tab.treeZoom = null;
      saveLayout();
    }
    switchTab(tabs.indexOf(tab));
    const next = selectAndPin(state, sessionId, paneId, machineId);
    state.scopeWorker = next.scopeWorker;
    state.observatory = next.observatory;
    state.treeScroll = next.treeScroll;
    // Review follows the pin: switching to it — its tab, its key, `r` — shows this session, read on
    // the machine the pinned row names.
    targetReview(sessionId, next.scopeWorker ?? undefined);
    pinLeaf = paneId;
    observatory?.load(paneId);
    state.status = `pinned ${state.scopeWorker?.label} · h herdr · r review`;
    schedulePaint();
  }

  function jumpHerdr(selection: ObservatorySelection): void {
    if (state.confirm) return;
    void observatory?.focus(selection).then(() => switchTab(tabs.findIndex(t => t.id === 'herdr')))
      .catch(error => { state.status = String(error.message || error); schedulePaint(); });
  }


  function viewSubagent(sessionId: string, _agentId: string): void {
    openConversation(sessionId);
  }

  /** Reveal a session's store folder on disk — the blob's store size is clickable.
   *  Opens the OS file manager (open · xdg-open · explorer)
   *  detached AND prints the path: the path is the guaranteed feedback, since a headless box over SSH has
   *  no file manager to open (a remote dev box is exactly that). */
  function revealStore(session: string): void {
    if (!session) return;
    const dir = core.storeDir(session);
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try {
      const child = core.spawnTool(cmd, [dir], { stdio: 'ignore', detached: true });
      child.on('error', () => {}); // best-effort — the path below is the guaranteed feedback, never silent
      child.unref();
    } catch { /* no file manager (headless/SSH) — the path still shows */ }
    state.status = `store: ${dir}`;
    schedulePaint();
  }

  /** Point the Review tab at a session without switching to it. The Observatory row it came from
   *  names the machine the session runs on; a store-only row (`unresolved`) names none and leaves
   *  what the panes last said. */
  function targetReview(session: string, selection?: ObservatorySelection): number {
    const ri = tabs.findIndex((t) => t.id === 'review');
    if (ri < 0 || !session) return -1;
    adoptOpen = false; // the reader chose what Review shows

    const from = selection?.machineId ? state.observatory?.machines.find((m) => m.id === selection.machineId) : undefined;
    if (from?.local) sessionMachines.delete(session);
    else if (from) sessionMachines.set(session, from.label);
    tabs[ri].session = session;
    return ri;
  }

  /** Open a session's REVIEW tab, scoped to it — the session blob's `review` button. */
  function reviewSession(session: string, selection?: ObservatorySelection): void {
    const ri = tabs.findIndex((t) => t.id === 'review');
    if (ri < 0 || active === ri || !session) return;
    targetReview(session, selection);
    state.views = null;
    switchTab(ri); // → state.session, ask() refetches the review for this session
  }

  /**
   * Dispatch a session blob's button. `feed` drives it (its live feed + prompt);
   * `review` opens the review tab on it; `resolve` accepts every pending edit and clears its store (asks
   * first — it is destructive to the review state, though never to the files); `kill` stops its agent
   * (asks first). Shared by the mouse (a button click) and the keyboard (f/r/a/x on the selection).
   */
  function blobAction(action: string, session: string, label: string, selection?: ObservatorySelection): void {
    if (!session) return;
    if (action === 'feed') return pinSession(session, selection?.machineId ?? reviewMachineId(session));
    if (action === 'herdr') return jumpHerdr(selection || observatorySelection(state, session));
    if (action.startsWith('conversation-diff:')) {
      const id = Number(action.slice('conversation-diff:'.length));
      void backend?.diff(id, session, reviewMachine(session)).then(patch => {
        state.overlay = { title: `${label} · edit #${id} · esc closes`, scroll: 0,
          lines: renderRichDiff(patch, { cols: Math.max(20, frameCols - 6), color: colorDepth, glyphs }) };
        schedulePaint();
      }).catch(error => { state.status = String(error.message || error); schedulePaint(); });
      return;
    }
    if (action === 'review') return reviewSession(session, selection);
    if (action === 'store') return revealStore(session);
    // An irreversible verb names where it acts: a session reviewed on another machine says so,
    // and its agent runs there, beyond this machine's reach.
    const on = action === 'resolve' || action === 'kill' ? reviewMachine(session) : undefined;
    if (action === 'resolve') {
      state.confirm = { verb: 'resolve', ids: [], session, label: `accept every pending edit in ${label}${on ? ` on ${on}` : ''} and clear its store` };
      return schedulePaint();
    }
    if (action === 'kill') {
      if (on) {
        state.status = `${label} runs on ${on}: stop its agent there, in its herdr pane`;
        return schedulePaint();
      }
      state.confirm = { verb: 'kill', ids: [], session, label: `stop the running agent for ${label}` };
      return schedulePaint();
    }
  }



  /** Fetch the patch behind a feed bubble the reader just opened, once per edit. The renderer
   *  stays pure: it draws `state.editPreviews` and nothing else. */
  function wantPreview(editId: number): void {
    if (!editId || state.editPreviews?.[editId] !== undefined) return;
    void backend
      ?.diff(editId, state.session, reviewMachine(state.session))
      .then((patch) => {
        if (!patch) return;
        state.editPreviews = { ...state.editPreviews, [editId]: patch };
        schedulePaint();
      })
      .catch(() => {
        /* an edit whose blobs are gone simply shows its detail without a preview */
      });
  }

  /** Toggle one open-set key (the shared fold idiom — `agent:` blobs here, `edits:`/paths on the
   *  main lists). The Set is REPLACED, not mutated: memo identities key on it. */
  function toggleOpenKey(key: string): void {
    const open = new Set(state.open);
    if (open.has(key)) open.delete(key);
    else open.add(key);
    state.open = open;
    schedulePaint();
  }

  function openInEditor(): void {
    const row = rowsOf()[state.cursor];
    let target = state.diffMeta?.path || selectedPath(row);
    let mapDir = false; // a map FOLDER — openable only by editors that accept a directory
    if (!target && row?.openPath !== undefined && !row.openPath.startsWith('edits:')) {
      // A change-map row. Files open at their real absolute path — `abs` for an outside node, the
      // workspace root joined to the relative path otherwise. Folders are offered too (VS Code and
      // friends open one); the tty branch below says why not rather than silently no-opping.
      const tree = mapTree();
      const node = tree ? mapRows(tree, state.open).find((r) => r.node.path === row.openPath)?.node : null;
      // The legacy anonymous bucket (an older CLI's payload, no root to resolve with) names no real
      // path — joining its label to the workspace would hand the editor a directory that does not
      // exist. Refuse with the reason, per the no-silent-no-op rule this key follows.
      if (node && node.name === OUTSIDE && node.abs === undefined) {
        state.status = 'this row is the anonymous outside-workspace bucket (older CLI payload) — no real path to open';
        return schedulePaint();
      }
      if (node) {
        const cmv = view(state, 'changemap') as { summary?: { root?: unknown } } | null;
        const root = typeof cmv?.summary?.root === 'string' ? (cmv.summary.root as string) : cwd;
        target = node.abs ?? (node.path ? path.join(root, node.path) : '');
        mapDir = !node.isFile;
      }
    }
    if (!target) {
      state.status = 'select an edit first — there is no file here to open';
      return schedulePaint();
    }
    // A session reviewed on another machine names paths on THAT machine; an editor here would open
    // an empty buffer at a path that does not exist (and create it on save).
    const away = reviewMachine(state.session);
    if (away) {
      state.status = `${target} is on ${away} — open it there (oak attach ${away})`;
      return schedulePaint();
    }
    // The READER'S OWN SETTING FIRST, then the environment. This read only the environment, so the
    // options window's editor row was decorative: you could pick one, it persisted to prefs.json, and
    // `e` still answered "no $EDITOR set". The row's own help has always promised this precedence
    // ("Blank follows $VISUAL then $EDITOR") — the key never honoured it.
    const ed = prefs.editor?.trim() || process.env.VISUAL || process.env.EDITOR;
    if (!ed) {
      // Name the fix that is one keystroke away before the one that needs a shell restart.
      state.status = 'no editor set — press o and pick one under EDITOR, or export $EDITOR';
      return schedulePaint();
    }
    // Split on whitespace so `EDITOR="code -w"` works. No shell: a path with a space in it must not
    // become two arguments, and this one comes from the store rather than from the reader.
    const parts = ed.split(/\s+/).filter(Boolean);
    const kind = core.editorKind(ed);
    // A folder only makes sense to an editor that opens one. Saying which fix is nearer beats a
    // silent no-op — the standing rule this whole key follows.
    if (mapDir && kind !== 'gui') {
      state.status = `${parts[0]} opens files, not folders — pick a file row, or set a GUI editor under o`;
      return schedulePaint();
    }
    // A GUI editor opens its own window and returns. Suspending this terminal for a fork-and-return
    // child is one full flash of the alternate screen for nothing — so it is spawned DETACHED, the
    // dashboard never blinks, and the status row says where the file went. Terminal editors get the
    // real terminal, inherited, and this process waits (below).
    if (kind === 'gui') {
      let win;
      try {
        win = core.spawnTool(parts[0], [...parts.slice(1), target], { stdio: 'ignore', cwd, detached: true });
      } catch (e) {
        state.status = `could not run $EDITOR (${ed}): ${String((e as Error)?.message || e)}`;
        return schedulePaint();
      }
      // ENOENT arrives async on 'error'. The success line below is already on screen by then, and
      // this replaces it — the honest order for a spawn we deliberately do not wait on.
      win.on('error', (e: Error) => {
        state.status = `could not run $EDITOR (${ed}): ${e.message}`;
        schedulePaint();
      });
      win.unref();
      state.status = `opened in ${parts[0]}`;
      return schedulePaint();
    }
    suspendTerminal();
    let child;
    try {
      child = core.spawnTool(parts[0], [...parts.slice(1), target], { stdio: 'inherit', cwd });
    } catch (e) {
      resumeTerminal();
      state.status = `could not run $EDITOR (${ed}): ${String((e as Error)?.message || e)}`;
      return schedulePaint();
    }
    // Node emits BOTH 'error' and 'close' for a spawn that never started, and 'close' arrived last —
    // so the ENOENT was written to `state.error` and then the close handler overwrote the line with
    // "back from code", reporting success for an editor that does not exist. Remember the failure and
    // let it win.
    let failed = '';
    child.on('error', (e: Error) => {
      failed = `could not run $EDITOR (${ed}): ${e.message}`;
      resumeTerminal();
      state.status = failed;
      schedulePaint();
    });
    child.on('close', (code: number | null) => {
      resumeTerminal();
      if (failed) {
        state.status = failed; // the spawn never happened; 'close' says nothing about it
      } else if (code) {
        // A non-zero exit is not a crash of ours, but it is not "back from" either — the reader's
        // editor refused, and the file may be unsaved.
        state.status = `${parts[0]} exited ${code}`;
      } else {
        state.status = `back from ${parts[0]}`;
      }
      schedulePaint();
    });
  }

  /**
   * F1 again: hand the WHOLE terminal to `claude --resume <session>`, in the session's own workspace.
   *
   * The same suspend → spawn(stdio:'inherit') → resume pair `openInEditor` and ^Z use — Claude Code is
   * a full-screen program and gets the real terminal, so typing there is 100% the real CLI: colours,
   * mouse, slash commands, paste, resize. `resumeTerminal` already reports what moved while away,
   * which matters more here than for $EDITOR, because what moved is exactly what Claude just did.
   *
   * Two refusals happen BEFORE any terminal handover, so failing leaves the dashboard exactly where
   * it was:
   *  - no workspace on this machine → refuse. Falling back to the terminal's cwd would launch a
   *    WRITER in the wrong tree, which is strictly worse than not launching.
   *  - the session is LIVE → ask first (the wall below). Resuming a live session opens a second
   *    writer on the same transcript; `--fork-session` is the safe variant, and the reader chooses.
   */
  let claudeAsk: { live: boolean } | null = null;
  function openClaude(): void {
    openConversation(state.session);
  }

  /** The native terminal handover, now behind its own explicit key (`r` on the Agent pane). */
  function openClaudeNative(): void {
    // Liveness off the payload already on screen — core stamped both fields with its one 60s rule,
    // so this costs no spawn. If NEITHER field arrived, ask anyway and say so: "probably fine" is not
    // a thing this product prints.
    const sess = ((view(state, 'sessions') as { sessions?: Record<string, unknown>[] } | null)?.sessions ?? []).find(
      (s) => String(s.id) === state.session
    );
    const self = ((view(state, 'multitask') as { agents?: Record<string, unknown>[] } | null)?.agents ?? []).find(
      (a) => a.self === true
    );
    const live = sess?.active === true || String(self?.phase ?? '') === 'working';
    const known = sess !== undefined || self !== undefined;
    if (live || !known) {
      claudeAsk = { live };
      state.status = live
        ? 'this session is LIVE — Claude is writing its transcript now.  [r] resume anyway (two writers) · [f] fork a copy · [esc] cancel'
        : 'could not tell if this session is live.  [r] resume · [f] fork a copy · [esc] cancel';
      return schedulePaint();
    }
    launchClaude(false);
  }

  /**
   * KNOWN LIMIT, deliberate for now: while Claude owns the terminal there is no key that returns to
   * the observatory — the handoff is stdio-inherit, so OUR process cannot see keystrokes at all.
   * Exiting Claude (`/exit`, ctrl+c) returns instantly, and F1-F1 relaunches `--resume` just as
   * fast, so the loop is cheap. A true in-place toggle means owning Claude under a PTY and swapping
   * screens — a real feature with a native-dependency decision (node-pty vs the zero-native-deps
   * rule), queued for 0.10 rather than faked here.
   */
  function launchClaude(fork: boolean): void {
    const ws = sessionRoot();
    if (!ws) {
      // Refuse, loudly. This session's transcript is not under any workspace this machine can see —
      // resuming it from some other directory would hand a writer the wrong tree.
      state.status = `this session's workspace is not on this machine — F1 needs it to run Claude there`;
      return schedulePaint();
    }
    const native = core.nativeSessionCommand(state.session);
    if (native.error) { state.status = native.error; schedulePaint(); return; }
    if (fork && native.command !== 'claude') { state.status = 'Fork this Codex conversation in its native CLI before opening it here'; schedulePaint(); return; }
    const bin = native.command === 'claude' ? core.resolveClaudeBin() : native.command;
    const cliArgs = [...native.args, ...(fork ? ['--fork-session'] : [])];
    suspendTerminal();
    let child;
    try {
      child = core.spawnTool(bin, cliArgs, { stdio: 'inherit', cwd: ws });
    } catch (e) {
      resumeTerminal();
      state.status = `could not run ${native.command} (${bin}): ${String((e as Error)?.message || e)} — set $CLAUDE_BIN or install the Claude Code CLI`;
      return schedulePaint();
    }
    // Node emits BOTH 'error' and 'close' for a spawn that never started, and 'close' arrives last —
    // remember the failure and let it win, or an ENOENT is overwritten by "back from Claude".
    let failed = '';
    child.on('error', (e: Error) => {
      failed = `could not run ${native.command} (${bin}): ${e.message} — set $CLAUDE_BIN or install the Claude Code CLI`;
      resumeTerminal();
      state.status = failed;
      schedulePaint();
    });
    child.on('close', (code: number | null) => {
      resumeTerminal();
      if (failed) {
        state.status = failed; // the spawn never happened; 'close' says nothing about it
      } else if (code) {
        state.status = `agent exited ${code}`;
      } else {
        state.status = `back from ${native.command}`;
      }
      schedulePaint();
    });
  }

  /** The file a row points at, for the rows that point at one. */
  function rowFile(row: { ids: number[] } | undefined): string {
    if (!row || row.ids.length !== 1) return '';
    const edits = (view(state, 'list') as { edits?: Record<string, unknown>[] } | null)?.edits ?? [];
    const e = edits.find((x) => Number(x.id) === row.ids[0]);
    return String(e?.file ?? '');
  }

  /**
   * The file the SELECTED ROW is about — edit row or file header.
   *
   * `rowFile` answers only for a single-edit row, deliberately: a header addresses every edit in its
   * file, and the verbs that act on ids must not treat it as one. But "which file is this row about"
   * has an obvious answer for a header too, and once Traces grouped by file the header became the row
   * a reader is usually sitting on — so `e` answered "select an edit first" while a path was on
   * screen in front of them. One resolver, so `e` and `y` can never disagree about it.
   */
  function selectedPath(row: { ids: number[]; key?: string } | undefined): string {
    const single = rowFile(row);
    if (single) return single;
    if (row?.key?.startsWith('f') && row.ids.length !== 1) return row.key.slice(1);
    return '';
  }

  // --- terminal setup ---------------------------------------------------------------------------
  observatory = createObservatory(core, state, { cwd, changed: () => { machinesChanged(); schedulePaint(); },
    status(message) { state.status = message; schedulePaint(); },
    // The poll lists this machine's sessions every tick unless Review is reading another machine's.
    catalogFresh: () => !state.reviewMachine });
  void observatory.start().catch(() => undefined).then(() => { searched = true; machinesChanged(); schedulePaint(); });
  enterTerminal();
  out.write('\x1b]11;?\x07'); // ask the terminal its background — the reply event above consumes it
  refreshSize();
  paint(); // immediately, before any data: a blank terminal for several seconds reads as hung
  ask();
  tick = setInterval(() => {
    ask();
    schedulePaint(); // relTime stamps keep advancing even when nothing on disk moved
  }, refreshMs());
  tick.unref?.();

  // The session master ANIMATES its live blobs, and the Agent tab's status blob

  // reader's agent in another terminal). This ~150ms tick only repaints while one of those two
  // surfaces is up AND something is actually working or blocked — so an idle dashboard, or any
  // other tab, pays nothing. `schedulePaint` advances `state.now`, which spinner and timer cycle off.
  animTick = setInterval(() => {
    if (state.overlay) return;
    if (tabs[active]?.id !== 'observatory') return;
    const live = state.observatory?.machines.some(m => m.snapshot?.panes.some(p => p.agent_status === 'working' || p.agent_status === 'blocked'));
    if (live) schedulePaint();
  }, 150);
  animTick.unref?.();

  // --- input ---------------------------------------------------------------------------------
  // Decoding is core's incremental decoder, not a per-chunk scan. The terminal splits sequences
  // wherever it likes and sends more than keystrokes — mouse reports, paste wrappers, and unsolicited
  // replies to capability queries. Measured against the old scanner: a background-colour reply arrived
  // as two dozen keys including `1`, a split arrow arrived as `A` (keep everything), and a split paste
  // containing `U` arrived as bulk undo. Over 3,000 randomised split points the scanner leaked a
  // destructive key 886 times; the decoder leaks none.
  const input = createNativeInput();
  let escTimer: NodeJS.Timeout | null = null;

  const onEvent = (ev: InputEvent | NativeKeyEvent): void => {
    if (ev.t === 'key' && 'event' in ev && (ev.event === 'release' || ev.super || ev.hyper || ev.meta)) return;
    // Acting in the Review tab settles what it reviews: the launch no longer moves it (adoptNewestAnywhere).
    // Leaving it is not acting in it: the leader and the key after it, quit, the other tab-switch keys
    // (ctrl+n/ctrl+p, alt+<digit>), the tab bar and a click's release are exempt.
    if (tabs[active]?.id === 'review' && !leaderArmed
      && !(ev.t === 'key' && ((ev.ctrl && ['a', 'q', 'n', 'p'].includes(ev.key)) || (ev.alt && /^[1-9]$/.test(ev.key))))
      && (ev.t === 'key' || ev.t === 'paste' || (ev.t === 'mouse' && ev.kind !== 'move' && ev.kind !== 'up' && hitTest(layout(), ev.col, ev.row)?.t !== 'tabbar'))) adoptOpen = false;
    // Global quit also bypasses typing walls such as the palette and view picker. An AUTO-REPEAT is
    // the same press still held down, never a second one: holding ctrl+q armed the confirmation and
    // then answered it with its own repeat, so one press exited and took an unsent draft with it
    // Legacy events carry no `event` field and are presses by construction.
    if (ev.t === 'key' && ev.ctrl && !ev.alt && !ev.shift && ev.key === 'q') {
      if (!('event' in ev) || ev.event === 'press') requestQuit('ctrl+q');
      return;
    }
    // The conversation-search results own input the same way while they are up.
    if (searchOpen) {
      if (ev.t === 'key') return searchKey(ev);
      if (ev.t === 'mouse') {
        if (ev.kind === 'down') {
          searchOpen = false;
          state.overlay = null;
          schedulePaint();
        }
        return;
      }
    }
    // The view picker owns input the same way while it is up.
    if (viewPickOpen) {
      if (ev.t === 'key') return viewPickerKey(ev);
      if (ev.t === 'mouse') {
        if (ev.kind === 'down') {
          viewPickOpen = false;
          state.overlay = null;
          schedulePaint();
        }
        return;
      }
    }
    // The find-anything palette owns input the same way while it is up.
    if (paletteOpen) {
      if (ev.t === 'key') return paletteKey(ev);
      if (ev.t === 'mouse') {
        if (ev.kind === 'down') {
          paletteOpen = false;
          state.overlay = null;
          schedulePaint();
        }
        return;
      }
    }
    // The needs-you inbox owns input the same way while it is up.
    if (inboxOpen) {
      if (ev.t === 'key') return inboxKey(ev);
      if (ev.t === 'mouse') {
        if (ev.kind === 'down') {
          inboxOpen = false;
          state.overlay = null;
          schedulePaint();
        }
        return;
      }
    }
    if (ev.t === 'reply') {
      // The background-colour answer (OSC 11), asked for at startup: it derives the SELECTION
      // colour (mix the real ground 28% toward black/white by relative luminance — theme-proof on
      // any terminal, herdr adoption) and, when no theme is chosen, picks the light palette.
      const m = /\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(ev.raw ?? '');
      if (m) {
        const chan = (h: string): number => Math.round((parseInt(h, 16) / (Math.pow(16, h.length) - 1)) * 255);
        const [r, gC, b] = [chan(m[1]), chan(m[2]), chan(m[3])];
        const lum = (0.2126 * r + 0.7152 * gC + 0.0722 * b) / 255;
        const toward = lum > 0.5 ? 0 : 255;
        const mix = (v: number): number => Math.round(v + (toward - v) * 0.28);
        const fg = lum > 0.5 ? '0;0;0' : '255;255;255';
        selSgr = `\x1b[48;2;${mix(r)};${mix(gC)};${mix(b)}m\x1b[38;2;${fg}m`;
        if (!prefs.theme && lum > 0.5) setTheme('light'); // a light terminal, no chosen theme
        schedulePaint(); // the first frame already painted dark — swap palettes NOW, not at the tick
      }
      return;
    }
    if (ev.t === 'focus') return; // never keys, by construction
    if (ev.t === 'paste') {
      routePaste(ev.text);
      return;
    }
    if (ev.t === 'mouse') return onMouse(ev);
    onKey(ev);
  };

  const routeInput = (part: NativeInputPart): void => {
    if (routeNativeHostReply(part.bytes)) return;
    const tab = tabs[active];
    const sess = tab?.kind === 'native' ? nativeSessions.get(tab.id) : undefined;
    const key = part.events.find(ev => ev.t === 'key');
    const ownKey = key?.t === 'key' && key.ctrl && !key.alt && !key.shift &&
      !('super' in key && (key.super || key.hyper || key.meta)) && (key.key === 'a' || key.key === 'q');
    if (sess && !sess.ended && !state.overlay && !leaderArmed && !ownKey) {
      // Only actual mouse events need coordinates. In particular a pasted escape sequence is text.
      if (part.events[0]?.t !== 'mouse') { sess.write(part.bytes); return; }
      const lay = layout();
      const topRows = lay.tabbar.length ? 1 : 0; // single-row tab bar (no rules)
      const bodyRows = Math.max(0, lay.rows - topRows - lay.chrome.bottom + 1);
      const translated = translateNativeMouse(part.bytes, topRows, bodyRows);
      for (const mousePart of translated.parts) {
        if (mousePart.target === 'chrome') { for (const ev of part.events) onEvent(ev); }
        else sess.write(mousePart.bytes);
      }
      return;
    }
    for (const ev of part.events) onEvent(ev);
  };

  process.stdin.on('data', (buf: Buffer) => {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    // Route each key in order: ctrl+a and its following CSI-u key can share or span reads, and a
    // native key after the leader's tab switch belongs to the newly active tab.
    for (const part of input.push(buf)) routeInput(part);
    if (input.pending() === '\x1b') {
      escTimer = setTimeout(() => {
        escTimer = null;
        for (const part of input.flush()) routeInput(part);
      }, 50);
      escTimer.unref?.();
    }
  });

  /** The layout this frame is using. Resolved from the same inputs the renderer resolves from, so a
   *  click and a glyph can never disagree about where a pane is. */
  function layout(): Layout {
    const l = resolveLayout(layoutReq());
    // The latch: shrinking may force a pane closed, growing never re-opens it behind the reader.
    // `latchMinimized` is shared with the test, so the test cannot pass against a runtime that
    // stopped latching.
    if (l.forced.length) {
      state.panes = { ...state.panes!, minimized: latchMinimized(state.panes!.minimized, l) };
    }
    return l;
  }

  /**
   * The tree layout the current frame is using, for a tab that carries a `root`. Resolved from the
   * SAME cols and chrome the renderer resolves from (via `layout()`), so a click and a glyph agree —
   * exactly the guarantee `layout()` gives dock tabs. `bodyH` mirrors `renderTreeFrame`: the terminal
   * height less the tab bar and the bottom chrome. `topRows` is the offset a body row sits below.
   */
  function treeGeom(root: PaneNode): { tl: ReturnType<typeof resolveTree>; topRows: number; cols: number; bodyH: number } {
    const lay = layout();
    const topRows = lay.tabbar.length ? 1 : 0; // single-row tab bar (no rules)
    // The renderer (renderTreeFrame) shaves ONE row for the status line when it speaks; the hit-test
    // MUST shave the identical row via the SAME predicate, or a click lands one row off the glyph
    // (the seam under the pointer, the bottom auto-hidden strip) whenever the status has something to say.
    const bodyH = Math.max(
      0,
      lay.rows - topRows - lay.chrome.bottom + 1 - (treeReclaimsRow(state, lay.cols, colorDepth) ? 1 : 0)
    );
    // Zoom lives in the resolver (resolveZoomedTree), so the hit-test and the renderer share ONE
    // collapse — a click can no longer land on a pane the zoom isn't showing there.
    // The SAME auto-hide set the renderer computes, so a collapsed pane's rect (and thus the hit-test)
    // matches the glyphs on screen exactly.
    const empty = emptyLeaves(state, root, lay.cols, glyphs, colorDepth);
    const tl = resolveZoomedTree(root, { x: 0, y: 0, w: lay.cols, h: bodyH }, tabs[active]?.treeFocus, tabs[active]?.treeZoom, empty);
    return { tl, topRows, cols: lay.cols, bodyH };
  }

  /** Advance a tree tab's focus to the next VISIBLE pane (fold/zoom-aware, via treeGeom). Shared by the
   *  leader's `tab` command and the top-level Tab key. */
  function cycleTreeFocus(tab: TabState): void {
    if (!tab.root) return;
    const ids = treeGeom(tab.root).tl.placements.map((p) => p.id);
    if (!ids.length) return;
    const at = Math.max(0, ids.indexOf(tab.treeFocus ?? ''));
    tab.treeFocus = ids[(at + 1) % ids.length];
    schedulePaint();
  }

  /** Scroll one tree pane, clamped to its OWN row count so it can never run past the end (the render
   *  clamps too — this keeps the stored value honest so scrolling back up responds immediately). */
  function treeScrollBy(paneId: string, delta: number): void {
    const root = tabs[active]?.root;
    if (!root || !paneId) return;
    const { tl } = treeGeom(root);
    const pl = tl.placements.find((p) => p.id === paneId);
    if (!pl) return;
    const boxed = pl.view !== 'sessions-nav' && glyphs.boxes && pl.rect.w >= 4 && pl.rect.h >= 3;
    const bodyH = treePaneBodyHeight(state, pl, glyphs);
    const rows = treePaneRows(state, pl.view, pl.rect.w - (boxed ? 2 : 0), glyphs, colorDepth, pl.id);
    const max = Math.max(0, rows.length - bodyH);
    const cur = Math.max(0, Math.min(state.treeScroll?.[paneId] ?? 0, max));
    const next = Math.max(0, Math.min(cur + delta, max));
    const scroll = pl.view === 'session-detail' && next === max ? Number.MAX_SAFE_INTEGER : next;
    if (scroll !== state.treeScroll?.[paneId]) {
      state.treeScroll = { ...state.treeScroll, [paneId]: scroll };
      schedulePaint();
    }
  }

  function newestConversation(paneId: string): void {
    state.treeScroll = { ...state.treeScroll, [paneId]: Number.MAX_SAFE_INTEGER };
    schedulePaint();
  }

  /** Arrow-key nav for the observatory master. Moves the SELECTION up/down through the session list —
   *  which drives the detail beside it — and scrolls the master so the pick stays in view. The row order
   *  and the scopes come from the master's OWN producer, so keyboard and mouse can never disagree. */
  function navObservatory(dir: 1 | -1): void {
    const root = tabs[active]?.root;
    if (!root) return;
    const master = () => treeGeom(root).tl.placements.find((p) => p.view === 'sessions-nav');
    // Each session once, in painted order, with the rows of its entry: its first listing and the rows
    // right after it. A fold that lists the session again further down is not part of its entry.
    const sessionsIn = (rows: DashRow[]) => {
      const uniq: ObservatorySelection[] = [];
      const span = new Map<string, [number, number]>();
      rows.forEach((r, i) => {
        const sc = r.scope;
        if (!sc) return;
        const key = `${sc.machineId}:${sc.session}`;
        const seen = span.get(key);
        if (!seen) { uniq.push(sc); span.set(key, [i, i]); }
        else if (seen[1] === i - 1) seen[1] = i;
      });
      return { uniq, span };
    };
    let pl = master();
    if (!pl) return;
    const { uniq } = sessionsIn(treePaneRows(state, pl.view, pl.rect.w, glyphs, colorDepth, pl.id));
    if (!uniq.length) return;
    const cur = state.scopeWorker ? uniq.findIndex((s) => s.session === state.scopeWorker!.session && s.machineId === state.scopeWorker!.machineId) : -1;
    // From no selection, `down` lands on the first row and `up` on the last — the natural first step.
    const start = cur < 0 ? (dir > 0 ? -1 : uniq.length) : cur;
    const pick = uniq[Math.max(0, Math.min(uniq.length - 1, start + dir))];
    state.scopeWorker = pick;
    // Review follows the cursor as it follows a pin: the session the Observatory
    // shows is the one the Review tab opens on, read on the machine its row names.
    if (tabs[active]?.id === 'observatory') targetReview(pick.session, pick);
    state.status = `${pick.label} — Enter pins its conversation`;
    // Measure only now: a status that speaks takes the tree's last row, and the selection decides which
    // rows exist (a selected session surfaces under its machine while its fold is closed).
    pl = master() ?? pl;
    const rows = treePaneRows(state, pl.view, pl.rect.w, glyphs, colorDepth, pl.id);
    // Keep the pick visible: its pane line, title and metrics line inside the pane body, above the
    // `+N more` hint that takes the body's last row while rows remain below. Moving up brings the
    // workspace and machine headers directly above it into view too, so the pick shows whose it is.
    const bodyH = Math.max(1, pl.rect.h - 1);
    const [first, last] = sessionsIn(rows).span.get(`${pick.machineId}:${pick.session}`) ?? [0, 0];
    let top = first;
    while (top > 0 && !rows[top - 1].scope) top--;
    let scroll = Math.max(0, Math.min(state.treeScroll?.[pl.id] ?? 0, Math.max(0, rows.length - bodyH)));
    if (first < scroll || (dir < 0 && top < scroll)) scroll = Math.min(first, Math.max(top, last - bodyH + 2));
    else if (last >= scroll + bodyH - 1) scroll = Math.min(first, last - bodyH + 2);
    scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - bodyH)));
    state.treeScroll = { ...state.treeScroll, [pl.id]: scroll };
    schedulePaint();
  }

  /** Compute the active native tab's screen BEFORE the pure renderer runs — spawn the PTY lazily, size
   *  it to the body, and hand renderDashFrame the styled grid. Cleared on any non-native tab. */
  function updateNativeGrid(): void {
    const tab = tabs[active];
    if (tab?.kind !== 'native') {
      state.nativeGrid = null;
      state.nativeNote = null;
      // Off a remote tab: detach, so the server stops pushing rows nobody paints. The program runs on.
      return;
    }
    // The program in a native tab owns the pointer — ours steps back to the arrow while it is up.
    if (pointerShape !== 'default') setPointer('default');
    const fail = (note: string): void => {
      state.nativeGrid = null;
      state.nativeNote = note;
    };
    const lay = layout();
    const topRows = lay.tabbar.length ? 1 : 0; // single-row tab bar (no rules)
    const bodyH = Math.max(0, lay.rows - topRows - lay.chrome.bottom + 1);
    let sess = nativeSessions.get(tab.id);
    const cmd = tab.command && tab.command.length ? [...tab.command] : [process.env.SHELL || 'bash'];
    const launchFailed = `could not launch ${cmd[0]}${tab.id === 'herdr' ? ' — run oak doctor --fix' : ''}`;
    // A child that died within moments with nothing of its own on screen never really started (its exec
    // failed — herdr not installed, say): the screen holds at most node-pty's `execvp(3) failed.` and
    // "exited", never what to do. One that printed its own reason (a herdr that
    // refused to start) keeps its screen, which says why (a generic note used to hide it).
    const ownWords = (s: NativeSession): boolean => s.grid(lay.cols, bodyH, colorDepth)
      .some((line) => { const text = line.replace(/\x1b\[[0-9;:]*m/g, '').trim(); return text !== '' && !/^\w+\(\d\) failed\./.test(text); });
    if (sess && nativeFailed.has(tab.id) && !ownWords(sess)) return fail(launchFailed);
    if (!sess) {
      if (!nativeAvailable()) return fail('node-pty is not installed — passthrough is unavailable on this machine');
      // OAK is already running inside a herdr pane (the tmux-attach model): herdr refuses to nest, so
      // do not spawn a second one in the herdr tab. herdr IS the host session here — its own keys drive it.
      if (tab.id === 'herdr' && process.env.HERDR_PANE_ID) return fail("you're already inside herdr — it is the host session here; press ctrl+b to move between its tabs and panes. OAK's Observatory and Review tabs (above) are what this window is for.");
      if (nativeFailed.has(tab.id)) return fail(launchFailed);
      // The session's root when it exists on this machine (a synced session's root may not — see spawnCwd).
      const ws = spawnCwd(sessionRoot());
      // OAK_TAB names this tab (+ our pid, so a restarted app never inherits an old link); the agent's
      // hooks inherit it and record which session runs here — the auto-title's link.
      // The herdr tab's client auto-starts the server when none runs, and a server born inside a
      // Claude Code session carries that session's identity into every pane (see
      // core's stripSessionIdentity) — so the identity is dropped from the spawn, not passed on.
      const identityStrip = tab.id === 'herdr'
        ? Object.fromEntries(Object.keys(process.env).filter((k) => core.isSessionIdentityKey(k)).map((k) => [k, undefined]))
        : {};
      const spawned = spawnNative(cmd[0], cmd.slice(1), lay.cols, bodyH, ws, tab.name ?? cmd[0], { ...identityStrip, OAK_TAB: `${tab.id}@${process.pid}` });
      if (!spawned) {
        nativeFailed.add(tab.id); // don't retry the spawn on every paint
        return fail(launchFailed);
      }
      spawned.onUpdate(() => schedulePaint());
      // A detached client returns to Observatory; the fixed herdr tab remains available. A child
      // that dies almost immediately never
      // really started — a bad command whose exec failed (node-pty forks, then the exec 127s) — so that
      // keeps the tab and shows the launch-failure note instead of flashing a tab open and shut.
      const spawnedAt = Date.now();
      spawned.onExit(() => {
        if (Date.now() - spawnedAt < 750) { nativeFailed.add(tab.id); schedulePaint(); }
        else closeNativeTab(tab.id);
      });
      nativeSessions.set(tab.id, spawned);
      sess = spawned;
    }
    sess.setHostActive?.(true, [2004, 1004, ...(mouse ? [1003, 1006] : [])]);
    sess.resize(lay.cols, bodyH);
    state.nativeGrid = sess.grid(lay.cols, bodyH, colorDepth);
    state.nativeNote = sess.ended ? `${tab.name ?? 'the program'} exited — ctrl+a then n/p leaves` : null;
  }

  /** The screen behind the focused pane's selected tab. */
  const paneScreen = (id: PaneId): string => {
    const t = state.panes!.tab[id] ?? 0;
    return TAB_SCREEN[id][t] ?? TAB_SCREEN[id][0];
  };

  /** Mirror the focused pane's cursor into the per-pane maps, so every pane keeps its OWN selection.
   *  Three lists on screen means three cursors, and only the focused one is what a keep/undo acts on. */
  function syncPane(): void {
    const f = state.panes!.focus;
    state.panes = {
      ...state.panes!,
      cursor: { ...state.panes!.cursor, [f]: state.cursor },
      scroll: { ...state.panes!.scroll, [f]: state.scroll },
    };
  }

  /** Move focus, restoring the pane if it was minimized, and swap in that pane's own selection. */
  function focusPane(id: PaneId): void {
    syncPane();
    const m = new Set(state.panes!.minimized);
    m.delete(id); // pressing a window's key restores it — the key is how you get it back
    state.panes = { ...state.panes!, minimized: m, focus: id };
    state.cursor = state.panes!.cursor[id] ?? 0;
    state.scroll = state.panes!.scroll[id] ?? 0;
    const sc = paneScreen(id);
    if (sc !== 'diff') state.screen = sc as typeof state.screen;
    // An explicit restore the carve then refuses must SAY so: the resolve latches the pane straight
    // back into `minimized`, and without this line the key silently does nothing. The note names the
    // exact row arithmetic, which is the only actionable answer ("make the terminal taller").
    const l = layout();
    if (l.forced.includes(id)) {
      const title = PANE_SPECS.find((p) => p.id === id)!.title;
      const note = l.notes.find((n) => n.startsWith(title));
      if (note) state.status = note;
    }
    ask();
    schedulePaint();
  }

  /** Zoom a pane to the whole body, or put it back. `zoom` folds into minimize inside `resolveLayout`,
   *  so full screen is not a second layout path — it is the same one with everything else closed. */
  function toggleZoom(id: PaneId): void {
    const on = state.panes!.zoom === id;
    state.panes = { ...state.panes!, zoom: on ? null : id, focus: id };
    state.status = on ? 'ready' : `${PANE_SPECS.find((p) => p.id === id)!.title} full screen — esc back`;
    ask();
    schedulePaint();
  }

  /**
   * Select the edit the reader typed the id of, wherever it is in the list, and show its diff.
   *
   * Resolved against the ROWS rather than against the payload: the row is what the cursor indexes,
   * and an id that is filtered or prompt-scoped out of view has no row to land on. Saying so beats
   * moving a cursor the reader cannot see.
   */
  /** Make edit `want` visible: when its row is hidden inside a FOLDED file group (the default
   *  state now), open that group first. Returns the row index in the refreshed rows, or -1. */
  function revealEdit(want: number): number {
    let rows = rowsOf('edits', 'traces');
    let at = rows.findIndex((r) => r.ids.length === 1 && r.ids[0] === want);
    if (at >= 0) return at;
    // Not visible — is it a member of a folded header? Opening the fold is what the reader meant.
    const header = rows.find((r) => r.openPath?.startsWith('edits:') && r.ids.includes(want));
    if (!header?.openPath) return -1;
    state.open = new Set([...state.open, header.openPath]);
    rows = rowsOf('edits', 'traces');
    at = rows.findIndex((r) => r.ids.length === 1 && r.ids[0] === want);
    return at;
  }

  /** Select edit `want` — reveal it (opening its fold), move the traces cursor onto it, and sync
   *  the diff. The tail of the `0-9` jump, shared with the prev/next buttons. */
  function jumpToEdit(want: number): void {
    if (state.panes && state.panes.focus !== 'traces') focusPane('traces');
    const at = revealEdit(want);
    if (at < 0) {
      state.status = `no edit #${want} in view${state.filter ? ` — /${state.filter} is filtering` : ''}${state.promptScope ? ' — a prompt scope is active, esc clears it' : ''}`;
      return schedulePaint();
    }
    state.cursor = at;
    picked = true;
    state.status = `edit #${want}`;
    clampCursor();
    syncPane();
    syncDetailDiff();
    schedulePaint();
  }

  function gotoEdit(): void {
    const want = Number(state.goto);
    state.goto = null;
    if (!Number.isFinite(want)) return schedulePaint();
    jumpToEdit(want);
  }

  /** Copy the dragged CHARACTER span to the system clipboard via OSC 52 — the terminal-native path
   *  Claude Code's own UI uses, working over SSH and tmux alike. Plain text only: escapes stripped
   *  before slicing, so columns are display cells; the span is anchor-cell to release-cell
   *  inclusive, exactly like the terminal's own selection. */
  /** Whether this terminal's clipboard is somewhere OSC 52 can't be beaten: over SSH/WSL the
   *  native tools write the REMOTE machine's clipboard — the wrong one — so the escape stays the
   *  only honest path there and oversize stays a refusal. */
  const REMOTE_CLIPBOARD = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.WSL_DISTRO_NAME || process.env.WSLENV);
  /**
   * The ONE clipboard door (adopted from herdr). Within the OSC 52 ceiling: the escape,
   * which works locally and remotely alike. Past it, on a LOCAL terminal: pipe to the platform's
   * own tool (wl-copy → xclip → pbcopy — first present wins), because the ceiling exists only for
   * the escape. Past it remotely, or with no tool: the same loud refusal as ever — never truncate.
   */
  const copyText = (text: string, doneMsg: string, refuseTail = ''): void => {
    const payload = Buffer.from(text, 'utf8').toString('base64');
    const plan = clipboardPlan(payload.length, { remote: REMOTE_CLIPBOARD, platform: process.platform, tmux: !!process.env.TMUX });
    if (plan.via === 'tmux') {
      // THROUGH tmux, never past it: under the default `set-clipboard external` tmux IGNORES an
      // inner application's OSC 52 — the escape died in tmux while the toast said "copied"
      // (verified live). `load-buffer -w` is tmux's own door: the paste buffer gets
      // the text unconditionally (prefix ] pastes), and tmux forwards it to the outer terminal's
      // clipboard — its OWN copies are exactly what `external` permits. A failed spawn (a tmux too
      // old for `-w`) falls back to the ordinary ladder.
      const fallback = (): void => {
        const p = clipboardPlan(payload.length, { remote: REMOTE_CLIPBOARD, platform: process.platform });
        if (p.via !== 'tmux') copyVia(p, text, payload, doneMsg, refuseTail); // tmux can't recur: the flag is off
      };
      let child;
      try {
        child = core.spawnTool('tmux', ['load-buffer', '-w', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
      } catch {
        return fallback();
      }
      child.on('error', fallback);
      child.stdin!.on('error', () => { /* the exit code decides; a dead pipe is not news */ });
      child.on('exit', (code: number | null) => {
        if (code === 0) {
          state.toast = { text: `${doneMsg} via tmux`, until: Date.now() + 2500 };
          const t = setTimeout(() => schedulePaint(), 2600);
          t.unref?.();
          schedulePaint();
        } else fallback();
      });
      child.stdin!.end(text);
      return;
    }
    return copyVia(plan, text, payload, doneMsg, refuseTail);
  };

  /** The non-tmux rungs of the one clipboard door — the escape within its ceiling, the platform's
   *  own tools past it locally, the loud refusal where neither can work. Split from copyText so the
   *  tmux rung can fall through here without recursing into its own detection. */
  const copyVia = (
    plan: Exclude<ReturnType<typeof clipboardPlan>, { via: 'tmux' }>,
    text: string,
    payload: string,
    doneMsg: string,
    refuseTail = ''
  ): void => {
    if (plan.via === 'osc52') {
      out.write(`\x1b]52;c;${payload}\x07`);
      state.toast = { text: doneMsg, until: Date.now() + 2500 };
      const t = setTimeout(() => schedulePaint(), 2600);
      t.unref?.();
      return schedulePaint();
    }
    if (plan.via === 'tools') {
      const tools = plan.tools;
      const tryTool = (i: number): void => {
        if (i >= tools.length) {
          state.status = `too large to copy through the terminal (${Math.round(payload.length / 1024)}KB, limit ~73KB) — install wl-copy or xclip for big copies${refuseTail}`;
          return schedulePaint();
        }
        const [cmd, args] = tools[i];
        let child;
        try {
          child = core.spawnTool(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        } catch {
          return tryTool(i + 1);
        }
        child.on('error', () => tryTool(i + 1));
        // A fast-exiting tool (wl-copy with no Wayland session) EPIPEs the pending write — an
        // unhandled stream error is an uncaughtException that kills the whole review (proven by
        // the re-review's positive control). The exit handler already advances the ladder.
        child.stdin!.on('error', () => { /* the exit code decides; a dead pipe is not news */ });
        child.on('exit', (code: number | null) => {
          if (code === 0) {
            state.toast = { text: `${doneMsg} via ${cmd}`, until: Date.now() + 2500 };
            const t = setTimeout(() => schedulePaint(), 2600);
            t.unref?.();
            schedulePaint();
          } else tryTool(i + 1);
        });
        child.stdin!.end(text);
      };
      return tryTool(0);
    }
    state.status = `too large to copy through the terminal (${Math.round(payload.length / 1024)}KB, limit ~73KB) — select less${refuseTail}`;
    schedulePaint();
  };

  /** Route pasted text to whoever owns the keyboard — the Observatory's reply box when it has focus
   *  (a prompt is the most-pasted string in this product), the filter when one is open, DISCARDED otherwise:
   *  in raw mode a paste is indistinguishable from typing, and this keymap binds single letters to
   *  destructive verbs. One door for the terminal's bracketed paste AND the app's own ^V. */
  const routePaste = (raw: string): void => {
    const replyPane = focusedReplyPane();
    if (replyPane) {
      const reply = state.observatory!.details[replyPane].reply!;
      const text = raw.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
      observatory?.editReply(replyPane, reply.text.slice(0, reply.caret) + text + reply.text.slice(reply.caret), reply.caret + text.length);
    } else if (filterOpen) {
      state.filter += raw.replace(/[\r\n]/g, '');
      clampCursor();
      schedulePaint();
    }
  };

  /** How much of a clipboard ^V will take. A runaway buffer pasted into the prompt would wrap
   *  megabytes per paint; half a MB is far past any real prompt and still instant. */
  const PASTE_MAX = 512 * 1024;

  /** The OS-paste chord (^V), read through the SAME ladder the copy writes: the tmux buffer inside
   *  tmux, the platform's own tools on a local terminal — and an honest pointer at the terminal's
   *  own paste where neither can reach the right clipboard (remote, no tmux: the machine's tools
   *  would read the REMOTE clipboard, which is not the one the reader means). */
  const pasteFromClipboard = (): void => {
    const deliver = (text: string): void => {
      if (!text) {
        state.status = 'nothing to paste';
        return schedulePaint();
      }
      const cut = text.length > PASTE_MAX;
      routePaste(cut ? text.slice(0, PASTE_MAX) : text);
      state.status = cut ? `pasted the first ${Math.round(PASTE_MAX / 1024)}KB — the clipboard held more` : `pasted ${text.length} chars`;
      schedulePaint();
    };
    const run = (plan: ReturnType<typeof pastePlan>): void => {
      if (plan.via === 'hint') {
        state.status = "clipboard is on the other machine — paste with cmd+V / ctrl+shift+V";
        return schedulePaint();
      }
      const ladder = plan.via === 'tmux' ? ([['tmux', ['save-buffer', '-']]] as const) : plan.tools;
      const tryTool = (i: number): void => {
        if (i >= ladder.length) {
          // The tmux rung exhausted (an empty buffer errors) falls to the non-tmux plan; the tools
          // rung exhausted is the end of the road.
          if (plan.via === 'tmux') return run(pastePlan({ tmux: false, remote: REMOTE_CLIPBOARD, platform: process.platform }));
          state.status = "nothing to paste — use cmd+V / ctrl+shift+V";
          return schedulePaint();
        }
        const [cmd, args] = ladder[i];
        let child;
        try {
          child = core.spawnTool(cmd, [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
          return tryTool(i + 1);
        }
        let out = '';
        child.stdout!.on('data', (d: Buffer) => {
          if (out.length <= PASTE_MAX) out += d.toString('utf8');
        });
        child.on('error', () => tryTool(i + 1));
        child.on('exit', (code: number | null) => {
          if (code === 0) deliver(out);
          else tryTool(i + 1);
        });
      };
      tryTool(0);
    };
    run(pastePlan({ tmux: !!process.env.TMUX, remote: REMOTE_CLIPBOARD, platform: process.platform }));
  };

  const copySpan = (a: { row: number; col: number }, b: { row: number; col: number }, clip?: SpanClip): void => {
    const plain = lastPainted.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const text = sliceSpan(plain, a, b, clip);
    // A drag entirely in right-edge padding selects nothing — writing '' would CLEAR the reader's
    // clipboard under a "copied 0 chars" toast, which is worse than saying so.
    if (!text) {
      state.status = 'nothing under that selection — it was all padding';
      return schedulePaint();
    }
    // One door for every copy (see copyText): OSC 52 within bounds, the platform's own tool past
    // them on a local terminal — and the same honest refusal where neither can work.
    copyText(text, `copied ${text.length} chars to clipboard`);
  };

  // `button` is on the wire and always has been — 0 left, 1 middle, 2 right — it simply was not in
  // this signature, so the right button arrived and was handled as a left click.
  function onMouse(ev: { kind: string; row: number; col: number; button?: number }): void {
    // A PRESS while a selection is still armed means its release was lost and no button-less motion said
    // so (a terminal that does not report any-motion, a release let go outside the window). Drop it
    // without acting — no copy, no late click — and take the press as itself: the stale press's click
    // fired under the next click, and a seam drag copied text nobody selected.
    if (textDrag && ev.kind === 'down') textDrag = null;
    // An armed text selection owns move/up until the button comes up. Checked before the seam drag
    // for the same reason the seam drag is checked before hit-testing: motion leaves the start cell
    // immediately. On a dock tab the press's own click has ALREADY done its work (selection is instant
    // there); a tree pane's click waits here for a release that never moved (`click`).
    if (textDrag) {
      // Any-motion tracking reports which button is held; none (3) while a drag is armed means its
      // release never arrived (let go outside the window, say). End the drag there, as a release would,
      // rather than drag a phantom selection after the pointer and leave a pane's click unanswered.
      const released = ev.kind === 'up' || (ev.kind === 'move' && ev.button === 3);
      if (ev.kind === 'move' && !released) {
        // A pane selection follows the pointer only as far as its pane's text area, as herdr's does.
        const clip = textDrag.clip;
        const row = clip ? Math.max(clip.y0, Math.min(clip.y1, ev.row)) : ev.row;
        const col = clip ? Math.max(clip.x0, Math.min(clip.x1, ev.col)) : ev.col;
        if (row !== textDrag.startRow || col !== textDrag.startCol) textDrag.moved = true;
        textDrag.lastRow = row;
        textDrag.lastCol = col;
        // The highlight (painted over the span by `paint`) is the live feedback; the status line
        // still says what release will do, without pretending to count characters mid-drag. Not on
        // a tree tab: a status that starts speaking takes a row from the panes, and a conversation
        // following its tail slid one line under the anchor mid-drag. The band says it there, as in herdr.
        if (textDrag.moved) {
          if (!textDrag.click) state.status = 'selecting — release to copy'; // not on a tree tab (above)
          schedulePaint();
        }
        return;
      }
      if (released) {
        const td = textDrag;
        textDrag = null;
        if (td.moved) {
          // The span OUTLIVES the release: kept and painted until the next key or click,
          // stored normalized so the paint pass never re-derives direction, held to its pane. A tree
          // pane's selection (the one whose press waits to be a click) clears on release instead, as
          // herdr's does: those panes are live, a kept band would sit over whatever scrolled under it,
          // and the toast already says what was copied.
          if (!td.click) state.selSpan = { ...normSpan(td), ...(td.clip ? { clip: td.clip } : {}) };
          return copySpan({ row: td.startRow, col: td.startCol }, { row: td.lastRow, col: td.lastCol }, dragClip(td));
        }
        if (td.click) return td.click();
        return;
      }
    }
    // A PANE drag (by its title) owns the mouse the same way: motion names the drop target, release
    // applies it — swap on the middle, place beside on an edge — through the pure tree ops.
    if (paneDrag) {
      const tab = tabs[active];
      const root = tab?.root;
      if (ev.kind === 'up') {
        const pd = paneDrag;
        paneDrag = null;
        setPointer('grab');
        if (pd.moved && pd.target && pd.zone && root) {
          tab.root = pd.zone === 'swap' ? swapPanes(root, pd.id, pd.target) : movePane(root, pd.id, pd.target, pd.zone);
          tab.treeFocus = pd.id;
          tab.treeZoom = null;
          saveLayout();
          state.status = pd.zone === 'swap' ? 'panes swapped' : `pane moved to the ${pd.zone} of its neighbour`;
        } else state.status = 'ready';
        return schedulePaint();
      }
      if (ev.kind === 'move' && root) {
        if (!paneDrag.moved && ev.col === paneDrag.startCol && ev.row === paneDrag.startRow) return;
        paneDrag.moved = true;
        setPointer('grabbing');
        const { tl, topRows } = treeGeom(root);
        const th = hitTreeBody(tl, ev.col, ev.row - topRows);
        const over = th?.kind === 'pane' && th.id !== paneDrag.id ? tl.placements.find((p) => p.id === th.id) : undefined;
        if (over) {
          const zone = dropZone((ev.col - over.rect.x) / Math.max(1, over.rect.w), (ev.row - topRows - over.rect.y) / Math.max(1, over.rect.h));
          paneDrag.target = over.id;
          paneDrag.zone = zone;
          state.status = `${zone === 'swap' ? 'swap with' : `drop ${zone} of`} ${VIEW[over.view].title} — release to drop · esc cancels`;
        } else {
          paneDrag.target = null;
          paneDrag.zone = null;
          state.status = 'drag onto another pane — its middle swaps, an edge places beside · esc cancels';
        }
        return schedulePaint();
      }
      return;
    }
    // A drag in progress owns the mouse until the button comes up. Checked FIRST: once the pointer
    // is moving it will leave the seam column almost immediately, and re-hit-testing every motion
    // event would drop the drag the moment it started working.
    if (drag) {
      if (ev.kind === 'up') {
        // A press that never moved is a CLICK, not a zero-pixel resize: the top edge focuses.
        const wasPending = drag.pending;
        const target = drag.target;
        drag = null;
        if (wasPending) return focusPane(target);
        saveLayout();
        state.status = 'ready';
        schedulePaint();
        return;
      }
      // `'drag'` used to be the other half of this condition and could never be true: MouseKind is
      // down | up | move | wheel-up | wheel-down, and a drag arrives as `move` with a button held.
      if (ev.kind === 'move') {
        const at = drag.axis === 'v' ? ev.col : ev.row;
        if (drag.pending) {
          if (at === drag.start) return; // still a click until the pointer actually moves
          drag = { ...drag, pending: false };
          state.status = `resizing ${PANE_SPECS.find((x) => x.id === drag!.target)!.title} — release to keep, = to reset`;
        }
        return dragTo(at);
      }
      return;
    }
    // FREE MOTION — the pointer moving with nothing held (SGR button 3). Reached only when no drag
    // and no selection is armed, because both own the mouse while they are live.
    //
    // The repaint is gated on the hovered TAB changing, not on the pointer moving: 1003 fires once
    // per cell crossed, so a sweep across a 200-column terminal is ~200 events and an ungated paint
    // would redraw the frame for every one of them. Parsing and dropping the rest is free.
    if (ev.kind === 'move') {
      if (ev.button !== 3) return; // a drag whose owner has already gone; not a hover
      // THE POINTER'S SHAPE: a resize arrow on a divider, a hand on a pane title, an
      // I-beam over text, an arrow-hand on a tab. One hit-test per motion event (~0.06 ms), one
      // OSC 22 write per CHANGE — a sweep across a pane writes nothing.
      syncPointer(ev.col, ev.row);
      // ROW 0 FIRST, before anything else touches the layout. Two reasons, both measured:
      //
      //  - `layout()` is not a read. It LATCHES forced-minimized panes, writing `state.panes` and
      //    allocating a Set and an object each time — once per cell crossed would be a state
      //    mutation per mouse pixel.
      //  - `resolveLayout` costs 0.059 ms, so a sweep across a 200-column terminal is ~11.7 ms of
      //    layout work to answer a question only row 0 can say yes to.
      //
      // Off row 0 the answer is always "no tab", which needs no geometry at all.
      if (ev.row !== 0 || !state.tabs?.length) {
        if (state.hoverTab === null) return; // the common case: no work, no paint, no allocation
        state.hoverTab = null;
        return schedulePaint();
      }
      const hit = hitTest(layout(), ev.col, ev.row);
      const over = hit?.t === 'tabbar' ? hit.index : null;
      if (over === state.hoverTab) return;
      state.hoverTab = over;
      return schedulePaint();
    }
    if (ev.kind === 'wheel-up' || ev.kind === 'wheel-down') {
      // A tree tab scrolls the pane UNDER THE POINTER (focus follows, so the keyboard lands there).
      const wtroot = tabs[active]?.root;
      if (wtroot && !state.overlay) {
        const { tl, topRows, bodyH } = treeGeom(wtroot);
        if (ev.row >= topRows && ev.row < topRows + bodyH) {
          const th = hitTreeBody(tl, ev.col, ev.row - topRows);
          if (th?.kind === 'pane') {
            tabs[active].treeFocus = th.id;
            treeScrollBy(th.id, ev.kind === 'wheel-up' ? -3 : 3);
          }
        }
        return;
      }
      // The pane UNDER THE POINTER, not the focused one. Scrolling a window you are not pointing at
      // is the behaviour nobody expects from a wheel, and this app usually has four windows open.
      // Focus follows the scroll so the keyboard lands where the eye already is.
      if (!state.overlay) {
        const box = layout().boxes.find(
          (b) => ev.row >= b.rect.y && ev.row < b.rect.y + b.rect.h && ev.col >= b.rect.x && ev.col < b.rect.x + b.rect.w
        );
        if (box && box.id !== state.panes?.focus) focusPane(box.id);
      }
      // ONE row per notch in a SELECTION list — a step of 3 jumped the cursor over rows (the
      // reported "wheel skips edits"). The Diff pane is a viewport, not a selection, so it keeps
      // the fast 3; `paneScreenOf` is what decides, exactly as the scroller path does.
      const under = state.overlay ? null : layout().boxes.find(
        (b) => ev.row >= b.rect.y && ev.row < b.rect.y + b.rect.h && ev.col >= b.rect.x && ev.col < b.rect.x + b.rect.w
      );
      const step = under && paneScreenOf(state, under) === 'diff' ? 3 : 1;
      return move((ev.kind === 'wheel-up' ? -1 : 1) * step);
    }
    if (ev.kind !== 'down') return;
    // A click clears a kept selection — before whatever else the press does.
    if (state.selSpan) {
      state.selSpan = null;
      schedulePaint();
    }
    if (state.overlay) {
      if (ev.row === 0) return void closeOverlay();
      return;
    }
    // Every mouse target comes out of the SAME hit-test the renderer drew from. Recomputing geometry
    // here is how a click and a glyph drift apart, and the reader has no way to tell that happened.
    // A TREE tab hit-tests against its OWN geometry (`treeGeom`), not the dock layout — which has no
    // boxes on this tab. Row 0 is the shared tab bar; the body between is the tree's; the bottom chrome
    // carries nothing clickable here yet.
    const treeTab = tabs[active];
    if (treeTab?.root) {
      const { tl, topRows, bodyH } = treeGeom(treeTab.root);
      if (ev.row < topRows) {
        const chit = hitTest(layout(), ev.col, ev.row);
        if (chit?.t === 'tabbar') return switchTab(chit.index);
        return;
      }
      if (ev.row >= topRows + bodyH) return;
      const th = hitTreeBody(tl, ev.col, ev.row - topRows);
      if (th?.kind === 'seam') {
        const sm = tl.seams.find((s) => s.path === th.path);
        if (sm) {
          drag = {
            target: 'traces',
            axis: th.axis,
            sign: 1,
            start: th.axis === 'v' ? ev.col : ev.row,
            startExtent: 0,
            // axisStart is in TERMINAL space to match `move()`'s raw ev.row/ev.col: a horizontal seam's
            // body-space region.y must add the tab-bar rows, or the divider drags `topRows` off.
            tree: { path: th.path, axisStart: th.axis === 'v' ? sm.region.x : sm.region.y + topRows, axisExtent: th.axis === 'v' ? sm.region.w : sm.region.h },
          };
          state.status = 'resizing — release to keep';
        }
        return;
      }
      if (th?.kind === 'pane') {
        const focusBefore = treeTab.treeFocus; // a master click fills the conversation leaf focused before it
        treeTab.treeFocus = th.id;
        if (th.titleRow) {
          // A press on the TITLE arms a pane drag: moving the pointer carries the
          // pane, release drops it on another pane; a press that never moves is a plain focus click.
          paneDrag = { id: th.id, startCol: ev.col, startRow: ev.row, moved: false, target: null, zone: null };
          return schedulePaint();
        }
        const wp = tl.placements.find((p) => p.id === th.id); // THIS pane, by id — a tree could hold two Workers
        // Match the RENDER exactly (treePaneLines): a boxed pane draws its body inside `rect.w-2` and
        // `rect.h-2`, a bare one inside `rect.w`/`rect.h-1`. Building the click's rows at the wrong width
        // or clamping its scroll by the wrong body height maps a click one row off — the bug behind the
        // blob buttons that only responded after another one was clicked.
        // sessions-nav renders BORDERLESS now (each blob is its own box — treePaneLines' `borderless`
        // branch), so its click geometry is the bare `+1` path; a stale `+2` here would map every blob
        // button one column off. Every other tree pane keeps its box.
        const boxed = !!wp && th.view !== 'sessions-nav' && glyphs.boxes && wp.rect.w >= 4 && wp.rect.h >= 3;
        // What the press does as a CLICK: resolved now, against the frame the reader aimed at, and run
        // by a release that never moved. A drag selects text instead, so it never pins, toggles or fires
        // the button it began on (copying in the Observatory works the same way it does in the
        // herdr tab).
        let act: (() => void) | undefined;
        // Clicking a worker — Workers board or the sidebar — selects it, and clicking a session in the
        // observatory MASTER pins it: the row carries its target. `esc` clears back to the reviewed
        // session. The Workers board's siblings (Tasks/Workflows) needed a re-fetch to follow; the
        // master/detail reads the SAME multitask payload already in hand, so selecting there is instant.
        if (th.view === 'workers' || th.view === 'agents-mini' || th.view === 'sessions-nav' || th.view === 'session-detail') {
          const wInner = wp ? (boxed ? wp.rect.w - 2 : wp.rect.w) : 0;
          const wrows = wp ? treePaneRows(state, th.view, wInner, glyphs, colorDepth, th.id) : [];
          // The visual row maps to a DIFFERENT data row once the pane is scrolled: treePaneLines
          // renders rows[scroll+i], so the click adds the same clamped offset or it selects the wrong worker.
          const wBodyH = wp ? treePaneBodyHeight(state, wp, glyphs) : 0;
          const wScroll = Math.max(0, Math.min(state.treeScroll?.[wp?.id ?? ''] ?? 0, Math.max(0, wrows.length - wBodyH)));
          if (th.view === 'session-detail' && th.row === wBodyH && observatoryReplyRow(state, th.id, wInner - 1, colorDepth) !== undefined) {
            act = () => observatory?.focusReply(th.id);
          } else if (th.row >= wBodyH) {
            // the box's foot: nothing to click
          } else if (wp && wrows.length - wScroll - wBodyH > 0 && th.row === wBodyH - 1) {
            // The overflow hint pages lists; conversations offer a jump back to the live tail.
            act = th.view === 'session-detail' ? () => newestConversation(wp.id) : () => treeScrollBy(wp.id, wBodyH - 1);
          } else {
            const clickedRow = wrows[wScroll + th.row];
            // A click on a blob BUTTON fires it, not a select. The ranges are offsets into the row cells;
            // the pane frames each row as `│ <cells>`, so a button's screen column is pane.x + 2 + range.x.
            const btn = clickedRow?.buttons?.find(
              (b) => wp !== undefined && ev.col >= wp.rect.x + (boxed ? 2 : 1) + b.x && ev.col < wp.rect.x + (boxed ? 2 : 1) + b.x + b.w
            );
            const picked = clickedRow?.scope;
            const openPath = clickedRow?.openPath;
            if (btn && picked) {
              act = () => blobAction(btn.action, picked.session, picked.label, picked);
            } else if (openPath) {
              act = () => toggleOpenKey(openPath);
            } else if (picked?.agentId) {
              // A DETAIL-pane spawn subagent row: open THAT spawn's own live feed, read-only. No drive —
              // viewSubagent ends any standing one, so viewing and driving never conflate (the reply-went-
              // unseen mismatch that made the earlier per-spawn DRIVE wrong).
              const agentId = picked.agentId;
              act = () => viewSubagent(picked.session, agentId);
            } else if (picked && th.view === 'sessions-nav') {
              // ONE click on a master session — its pane line, title or stat line — pins its
              // conversation. The first click used to select only. The arrow keys still
              // preview without pinning; Enter pins what they previewed. In a split view the click
              // fills the conversation leaf the reader focused, else the one the last pin filled.
              const chosen = leafPanes(treeTab.root).some((p) => p.id === focusBefore && p.view === 'session-detail');
              act = () => pinSession(picked.session, picked.machineId, chosen ? focusBefore : pinLeaf);
            } else if (picked && (picked.session !== state.scopeWorker?.session || picked.machineId !== state.scopeWorker?.machineId)) {
              act = () => {
                state.scopeWorker = picked;
                state.status = `scoped to ${picked.label}`;
                if (th.view !== 'session-detail') ask(true);
              };
            }
          }
        }
        const click = (): void => {
          act?.();
          schedulePaint();
        };
        // A LEFT press arms a text selection held to this pane's text area: inside a box's borders and
        // past the one-cell gutter every row is drawn with (treePaneBox, treePaneLines), so a copied line
        // starts at its first character. Other buttons act at once, as before.
        if ((ev.button ?? 0) === 0 && wp) {
          const inset = boxed ? 2 : 1;
          const clip = { x0: wp.rect.x + inset, x1: wp.rect.x + wp.rect.w - inset, y0: topRows + wp.rect.y + 1, y1: topRows + wp.rect.y + wp.rect.h - inset };
          const row = Math.max(clip.y0, Math.min(clip.y1, ev.row));
          const col = Math.max(clip.x0, Math.min(clip.x1, ev.col));
          textDrag = { startRow: row, lastRow: row, startCol: col, lastCol: col, moved: false, clip, click, pane: wp.id };
          return schedulePaint();
        }
        return click();
      }
      return;
    }

    const lay0 = layout();
    const hit = hitTest(lay0, ev.col, ev.row);
    if (!hit) return;

    /**
     * RIGHT-CLICK opens the row's verbs, the way k9s and lazygit do.
     *
     * Button 2 in the SGR protocol, which the decoder already reports — this needed no new event kind.
     * It selects the row first, then offers only what applies to it, so the menu can never act on
     * something other than what the reader pointed at. Everything it offers is a key that already
     * exists: this is a door, not a second implementation.
     */
    if (ev.button === 2 && hit.t === 'body') {
      if (hit.pane !== state.panes?.focus) focusPane(hit.pane);
      // Through `paneVisible`, exactly as the left-click path does: `hit.row` is a VISUAL line, and a
      // wrapped row above the pointer makes that a different edit than the one under it. A context
      // menu that acts on the wrong row is worse than no context menu.
      const rbox = layout().boxes.find((b) => b.id === hit.pane);
      if (!rbox) return;
      const rvis = paneVisible(state, rbox, glyphs, colorDepth)[hit.row];
      if (!rvis || rvis.row < 0) return;
      state.cursor = rvis.row;
      picked = true;
      clampCursor();
      syncPane();
      syncDetailDiff();
      const row = rowsOf()[state.cursor];
      const km = keys();
      const keyOf = (action: string): string => { for (const [k, a] of km) if (a === action) return k; return ''; };
      const items: [string, string][] = [];
      // Everything the menu offers is a key, so an action a rebind left without one has no row.
      const offer = (action: string, what: string): void => { const k = keyOf(action); if (k) items.push([k, what]); };
      if (row?.ids.length) {
        offer('keep', `Keep ${row.ids.length === 1 ? `edit #${row.ids[0]}` : `these ${row.ids.length} edits`}`);
        offer('undo', `Undo ${row.ids.length === 1 ? `edit #${row.ids[0]}` : `these ${row.ids.length} edits`}`);
        offer('mark', 'Mark for a bulk keep or undo');
      }
      if (selectedPath(row)) offer('copy', 'Copy the path');
      if (row?.ids.length === 1) offer('editor', 'Open in $EDITOR');
      if (!items.length) {
        state.status = 'nothing to do on this row';
        return schedulePaint();
      }
      state.overlay = {
        title: ROW_MENU_TITLE,
        lines: items.map(([k, what]) => `  ${k.padEnd(3)} ${what}`),
        scroll: 0,
        cursor: 0,
      };
      rowMenu = items.map(([k]) => k);
      return schedulePaint();
    }

    if (hit.t === 'seam') {
      const sm = lay0.seams[hit.index];
      const box = lay0.boxes.find((b) => b.id === sm.target);
      if (box) {
        drag = {
          target: sm.target,
          axis: sm.axis,
          sign: sm.sign,
          start: sm.axis === 'v' ? ev.col : ev.row,
          startExtent: sm.axis === 'v' ? box.rect.w : box.rect.h,
        };
        state.status = `resizing ${PANE_SPECS.find((x) => x.id === sm.target)!.title} — release to keep, = to reset`;
        schedulePaint();
      }
      return;
    }

    if (hit.t === 'chrome') {
      if (hit.part === 'session') {
        // The navbar splits by what is under the pointer, exactly as on the Agent screen: the
        // selector side opens the picker; the right-aligned counters are review's numbers, so
        // clicking them jumps to the REVIEW tab (a no-op when already there).
        const boxed = glyphs.boxes;
        const inner = boxed ? Math.max(20, frameCols - 2) : frameCols;
        const split = (boxed ? 1 : 0) + sessionRowCountersX(state, inner, glyphs, colorDepth);
        if (ev.col >= split) {
          const ri = tabs.findIndex((t) => t.id === 'review');
          if (ri >= 0 && ri !== active) return switchTab(ri);
          if (ri === active) return; // already reading review — the click has nothing to add
        }
        return openSessionPicker();
      }
      return;
    }
    if (hit.t === 'tabbar') return switchTab(hit.index);
    if (hit.t === 'windowbar') {
      if (hit.part === 'twig') {
        // The twig cell toggles minimize; the rest of the chip focuses. Two targets, one chip.
        const m = new Set(state.panes!.minimized);
        if (m.has(hit.pane)) m.delete(hit.pane);
        else m.add(hit.pane);
        state.panes = { ...state.panes!, minimized: m, zoom: null };
        ask();
        return schedulePaint();
      }
      // A face chip focuses Detail AND sets the face it names — clicking "Map" and landing on a diff
      // would make the bar a label rather than a control.

      return focusPane(hit.pane);
    }
    if (hit.t === 'nav') {
      // The action bar has its OWN hit kind now, because `makeBox` reserves its row. It used to be
      // guessed at here as "the title row plus one", which the hit-tester had already classified as
      // body — so this branch never ran and every button was dead to the mouse.
      const box = lay0.boxes.find((b) => b.id === hit.pane);
      const btn = box && detailNavButtons(box, state, glyphs).find((b) => ev.col >= b.x && ev.col < b.x + b.w);
      if (!btn) return focusPane(hit.pane);
      if (!btn.live) {
        state.status = 'select an edit in Traces first — there is nothing here to keep or undo';
        return schedulePaint();
      }
      if (btn.action === 'keep') return mutateScope('keep', 'one');
      if (btn.action === 'undo') return mutateScope('undo', 'one');
      // prev/next step the REVIEW — edit to edit, diving into folded groups — never the cursor row
      // by row. Stepping rows landed on folded multi-edit headers, `followTracesDiff` saw a
      // multi-id row and CLEARED the diff, and both buttons read as dead in any real session
      // (field report, 2026-08-14). From nothing picked they pick an end of the list.
      if (state.panes!.focus !== 'traces') focusPane('traces');
      const revRows = rowsOf('edits', 'traces');
      const onRow = picked ? revRows[state.cursor] : undefined;
      const curId = onRow && onRow.ids.length === 1 ? onRow.ids[0] : (state.diffMeta?.id ?? -1);
      const want = stepReviewId(revRows, curId, btn.action === 'next' ? 1 : -1);
      if (want < 0) {
        state.status = 'no edits to review yet';
        return schedulePaint();
      }
      if (want === curId) {
        state.status = btn.action === 'next' ? 'already at the last edit' : 'already at the first edit';
        return schedulePaint();
      }
      return jumpToEdit(want);
    }
    if (hit.t === 'title') {
      // A pane's title row IS its top edge, so pressing there arms the resize of the seam directly ABOVE
      // it — the one whose lower side (`right`) is this pane. This is why the Prompts|Traces split felt
      // un-resizable: that seam
      // targets `prompts`, so a `target === pane` lookup found nothing for a press on TRACES and fell
      // through to a plain focus. Matching by `right` makes Traces' title resize Prompts|Traces and
      // Detail's title resize Map|Diff — the gesture a reader reaches for — with the thin seam row still
      // grabbable too. Promoted on the first motion, released as a focus click if the pointer never
      // moves. `startExtent` is the TARGET pane's height, since that is the pane the drag grows.
      const sm = lay0.seams.find((s) => s.axis === 'h' && s.right === hit.pane);
      const box = sm && lay0.boxes.find((b) => b.id === sm.target);
      if (sm && box) {
        drag = { target: sm.target, axis: 'h', sign: sm.sign, start: ev.row, startExtent: box.rect.h, pending: true };
        return;
      }
      return focusPane(hit.pane);
    }
    if (hit.t === 'tabscroll') {
      const tabs = PANE_SPECS.find((x) => x.id === hit.pane)!.tabs;
      const at = state.panes!.tab[hit.pane] ?? 0;
      const next = Math.max(0, Math.min(tabs.length - 1, at + hit.dir));
      state.panes = { ...state.panes!, tab: { ...state.panes!.tab, [hit.pane]: next } };
      if (hit.pane === state.panes!.focus) { state.cursor = 0; state.scroll = 0; }
      ask();
      return schedulePaint();
    }
    if (hit.t === 'tab') {
      state.panes = { ...state.panes!, tab: { ...state.panes!.tab, [hit.pane]: hit.index } };
      if (hit.pane !== state.panes!.focus) return focusPane(hit.pane);
      state.cursor = 0;
      state.scroll = 0;
      const sc = paneScreen(hit.pane);
      if (sc !== 'diff') state.screen = sc as typeof state.screen;
      ask();
      return schedulePaint();
    }
    // A STANDING QUESTION OWNS THE MOUSE, exactly as it owns the keyboard. Without this, a click
    // anywhere kept running verbs underneath an unanswered y/n — and because the answers share the
    // map's heading row with the buttons that raised them, the second click of a double-click on
    // [ n — no ] landed on [ Keep all ] and armed a more destructive question in the same cell.
    if (state.confirm) {
      const box0 = hit.t === 'body' ? layout().boxes.find((b) => b.id === hit.pane) : undefined;
      if (hit.t === 'body' && box0 && paneScreenOf(state, box0) === 'map' && hit.row === MAP_DECOR.actions && mapOwnsConfirm(state)) {
        const local = ev.col - box0.body.x - PANE_GUTTER;
        // body.w, NOT rect.w: the renderer laid these buttons out at body.w−1 (frame.ts, pane
        // render). In the boxed tier rect is two border columns wider, and a rect-based map put
        // every right-aligned button two cells right of where it was drawn — a click on the left
        // half of [ y — yes ] silently missed (the ported stale-read-race probe caught it).
        const ans = mapConfirmButtons(Math.max(1, box0.body.w - 1)).find((t) => local >= t.x && local < t.x + t.w);
        if (ans) return answerConfirm(ans.answer === 'y');
      }
      state.status = 'answer the pending question first — y or n';
      return schedulePaint();
    }
    if (hit.t === 'body') {
      // THE MAP'S TOOLBAR, before anything else in the body: it is a fixed decor row, so it never
      // resolves to an edit row and would otherwise swallow the click silently.
      {
        const box0 = layout().boxes.find((b) => b.id === hit.pane);
        if (box0 && paneScreenOf(state, box0) === 'map' && hit.row === MAP_DECOR.actions) {
          const inner = Math.max(1, box0.body.w - 1); // body.w — the width the renderer used (see the confirm branch above)
          const local = ev.col - box0.body.x - PANE_GUTTER;
          // (A standing question never reaches here — the wall above owns the mouse.)
          const tree = mapTree();
          if (tree) {
            const btn = mapToolbar(tree, inner, glyphs.rule !== "-").find((t) => local >= t.x && local < t.x + t.w);
            if (btn) {
              if (hit.pane !== state.panes!.focus) focusPane(hit.pane);
              if (btn.action === 'resolve') return confirmResolve();
              return mutateAll(btn.action === 'keep-all' ? 'keep' : 'undo');
            }
          }
        }
      }
      // Arm a text selection: if the pointer MOVES before release, the visible span is copied to
      // the clipboard (OSC 52); a press that never moves stays a plain click — which acts instantly,
      // exactly as before.
      // Held to the pane it began in, past the one-cell gutter: a drag across side-by-side panes copied
      // a row of every pane beside it, interleaved.
      if ((ev.button ?? 0) === 0) {
        const body = layout().boxes.find((b) => b.id === hit.pane)?.body;
        const clip = body && { x0: body.x + PANE_GUTTER, x1: body.x + body.w - 1, y0: body.y, y1: body.y + body.h - 1 };
        const row = clip ? Math.max(clip.y0, Math.min(clip.y1, ev.row)) : ev.row;
        const col = clip ? Math.max(clip.x0, Math.min(clip.x1, ev.col)) : ev.col;
        textDrag = { startRow: row, lastRow: row, startCol: col, lastCol: col, moved: false, ...(clip ? { clip } : {}) };
      }
      // Focus AND act, in one click. Returning here meant the first click into a pane only moved
      // focus, so selecting took two clicks and expanding a folder took three — which reads exactly
      // like "I have to click the next item to open this one".
      if (hit.pane !== state.panes!.focus) focusPane(hit.pane);
      // Resolve the click through the SAME visual->row map the renderer drew from. Adding the scroll
      // offset to the clicked line number assumed one line per row, so any wrapped row above the
      // pointer shifted the selection onto a different edit than the one under it.
      const box = layout().boxes.find((b) => b.id === hit.pane);
      if (!box) return;
      const vis = paneVisible(state, box, glyphs, colorDepth);
      const v = vis[hit.row];
      if (!v || v.row < 0) return;
      const i = v.row;
      const wasOn = state.cursor; // captured BEFORE the click moves it, for the drill-in test below
      // The change map's own Keep/Undo cells, resolved through the SAME layout the row was drawn
      // from. Checked before the selection changes: clicking ✓ means "keep this row", not "select
      // this row and also keep it", and in a tool that reverts code those must not be the same click.
      if (paneScreenOf(state, box) === 'map') {
        const act = mapActionAt(box, i, ev.col);
        if (act) return mutateUnder(act.action, act.node);
      }
      // The Prompts row's [review] cell — same rule, same ordering: resolved through the function
      // that drew it, and checked before the click becomes a selection.
      if (paneScreenOf(state, box) === 'prompts' && promptActionAt(box, ev.col)) {
        const row0 = rowsOf()[i];
        if (row0?.ids.length) {
          const m = /^#(\d+)/.exec(row0.cells.replace(/\x1b\[[0-9;]*m/g, ''));
          state.cursor = i;
          clampCursor();
          syncPane();
          return openReview(m ? Number(m[1]) : 0, row0.ids);
        }
      }
      // A second click on the row already selected opens it — the drill-in gesture, without a
      // double-click timer that would make every single click feel late.
      if (hit.pane === 'traces') picked = true;
      state.cursor = i;
      clampCursor();
      syncPane();
      // A FOLDER opens on the first click. Toggling a fold shows more of what is already on screen
      // and costs nothing to undo, so making it wait for a second click bought no safety — unlike an
      // edit, where the second click is a real drill-in and worth the confirmation of aiming twice.
      const row = rowsOf()[i];
      if (row?.openPath !== undefined) return openSelected();
      if (wasOn === i) openSelected();
      schedulePaint();
    }
  }

  /**
   * Resize the pane left of the seam to follow the pointer.
   *
   * The width is written into `panes.sizes` and re-resolved, so the reader's number goes through the
   * same clamp as every default: it can never drive a pane below `min`, and it can never squeeze the
   * centre below the width at which a diff stops being a diff. `resolveLayout` is pure, so a drag is
   * just a value changing — there is no separate "dragging" render path to keep in step.
   */
  function dragTo(at: number): void {
    if (!drag || !state.panes) return;
    if (drag.tree) {
      // A tree seam moves its split's RATIO — the pointer position within the split's own extent. The
      // engine clamps to a sane band, so a drag can never collapse a child to nothing.
      const { path, axisStart, axisExtent } = drag.tree;
      const root = tabs[active]?.root;
      if (root) tabs[active].root = setRatioAt(root, path, (at - axisStart) / Math.max(1, axisExtent - 1));
      return schedulePaint();
    }
    const next = Math.max(1, drag.startExtent + (at - drag.start) * drag.sign);
    state.panes = { ...state.panes, sizes: { ...state.panes.sizes, [drag.target]: next } };
    clampCursor();
    ask();
    schedulePaint();
  }

  /**
   * Nudge the focused pane along ITS OWN axis, so `--no-mouse` can do everything a drag can.
   *
   * The axis is the pane's dock, not a fixed one: Prompts and Dashboards are horizontal docks whose
   * adjustable extent is HEIGHT, and looking only for a vertical seam meant the keyboard refused
   * them both — "that window has no seam to move" — for two panes the mouse could resize all along.
   */
  function nudgeSize(delta: number): void {
    if (!state.panes) return;
    const id: PaneId = state.panes.focus;
    const lay = layout();
    const axis: 'v' | 'h' = id === 'prompts' || id === 'dashboards' || id === 'claude' ? 'h' : 'v';
    // Detail is the flex centre: a size written for it is discarded, so nudge its neighbour instead
    // and invert, which keeps `<` meaning "the focused pane gets smaller" either way.
    const seam = lay.seams.find((sm) => sm.axis === axis && (sm.target === id || sm.left === id || sm.right === id));
    const target = id === 'detail' ? seam?.target ?? id : id;
    const box = lay.boxes.find((b) => b.id === target);
    if (!box || !seam) {
      state.status = `${PANE_SPECS.find((p) => p.id === id)!.title} has no seam to move at this size`;
      return schedulePaint();
    }
    const invert = target !== id ? -1 : 1;
    const extent = axis === 'v' ? box.rect.w : box.rect.h;
    state.panes = { ...state.panes, sizes: { ...state.panes.sizes, [target]: Math.max(1, extent + delta * invert) } };
    clampCursor();
    ask();
    schedulePaint();
  }



  /**
   * Put one ask under review: scope the Traces EDITS list to exactly its ids — same rows, same
   * keys, ↵ on a unit opens its net diff, esc clears. The editors keep a Review LIST whose diffs
   * open in the editor; in a terminal the filtered list IS that surface. (A dedicated Review tab
   * shipped briefly and was removed: it duplicated this list behind a second fetch cadence, and
   * rebuilding an entire ask's patches per refresh made a large session crawl.)
   */
  function openReview(index: number, ids: readonly number[]): void {
    state.promptScope = { index, ids: new Set(ids) };
    state.status = `prompt #${index} under review — esc clears`;
    focusPane('traces');
  }

  /** Enter / second click: open a map folder, else show the row's edit full screen. */
  function openSelected(): void {
    // The FOCUSED pane's rows. Reading `state.screen` here meant Enter on a change-map folder looked
    // up an EDIT row instead, found no `openPath`, and the folder never expanded.
    const row = rowsOf()[state.cursor];
    if (!row) return;
    // A prompt is a unit of work: opening one puts it UNDER REVIEW — the Traces Edits list scopes to
    // exactly that ask's rows, the terminal's equivalent of the editors' Review list. Focus follows,
    // or the reader would have to guess where the result went.
    if (state.panes && state.panes.focus === 'prompts') {
      const m = /^#(\d+)/.exec(row.cells.replace(/\x1b\[[0-9;]*m/g, ''));
      if (!row.ids.length) {
        // A silent no-op reads as a broken key. Say why there is nothing to open.
        state.status = `ask #${m ? m[1] : '?'} produced no edits — nothing to review`;
        return schedulePaint();
      }
      openReview(m ? Number(m[1]) : 0, row.ids);
      return;
    }
    if (row.openPath !== undefined) {
      const open = new Set(state.open);
      if (open.has(row.openPath)) open.delete(row.openPath);
      else open.add(row.openPath);
      state.open = open;
      schedulePaint();
      return;
    }
    // Opening an edit ZOOMS Detail rather than raising a separate full-screen reader. The overlay it
    // replaces re-printed the `diff` verb's piped output — no bands, no intra-line marks, no syntax,
    // no navbar and no address — which is a second diff renderer to keep in step with the first, and
    // the one the reader reached for when a diff was too long to read in the pane.
    if (row.ids.length === 1) {
      syncDetailDiff();
      state.panes = { ...state.panes!, zoom: 'detail', focus: 'detail', scroll: { ...state.panes!.scroll, detail: 0 } };
      state.scroll = 0;
      state.status = `edit #${row.ids[row.ids.length - 1]} full screen — esc back`;
      ask();
      schedulePaint();
    }
  }

  // --- the options window ------------------------------------------------------------------------
  /**
   * btop's settings screen, in this product's vocabulary: one list, headings for categories, the
   * value on the right, left/right to change it in place, and every change written the moment it is
   * made. No OK button — a settings screen with one has a state where what you see and what is saved
   * disagree, and the reader finds out by closing it.
   *
   * It REPLACED an app menu whose four entries were three reports and a link. Two of those facts
   * (where this reads from, which version) are rows here; the other two were a jump to a pane and an
   * update check, which the pane's own key and the status row already do.
   */
  /** Detected ONCE. `optRows` runs on every paint of the options window, and a PATH sweep per frame
   *  would stat a few hundred paths to answer a question whose answer cannot change mid-run. */
  const detectedEditors = core.detectEditors();
  const optEnv = () => ({
    editor: process.env.VISUAL || process.env.EDITOR,
    term: process.env.TERM,
    file: core.prefsPath(),
    editors: detectedEditors,
    // Resolved on every open, not captured once: a move performed from this very screen has to be
    // reflected the moment it happens.
    store: core.rootDir(),
  });
  const optRows = () => optionRows(prefs, optEnv());

  function openOptions(): void {
    const rows = optRows();
    options = { cursor: selectableRows(rows)[0] ?? 0, scroll: 0, capture: null };
    state.status = 'options — ←→ change · enter edit · esc close';
    schedulePaint();
  }

  /** Persist, then re-apply the ones that change how this session already looks. */
  function saveOptions(next: import('@oak-observatory/core').Prefs): void {
    // A value the settings layer refused comes back carrying its reason instead of being dropped on
    // the floor. Show it and keep the old setting; never write the marker to disk.
    if (next.__reject) {
      state.status = next.__reject;
      return schedulePaint();
    }
    prefs = next;
    state.keys = keys(); // a rebind reaches the frame's own prose on the same paint
    setTheme(prefs.theme); // …and a theme change reaches the very next paint, not the next launch
    state.syntax = prefs.syntax !== false;
    try {
      core.writePrefs(prefs);
    } catch (e) {
      // A settings screen that cannot save must SAY so. Silently keeping the value in memory would
      // have the reader set it once and find it gone at the next start with no explanation.
      // `state.status`, not `state.error`: the backend owns `error` and clears it on the next
      // successful payload, so a failed SAVE — which the reader must see, because their setting did
      // not persist — vanished within one refresh tick.
      state.status = `could not save preferences: ${String((e as Error)?.message || e)}`;
      return schedulePaint();
    }
    if (!args.includes('--no-color') && !process.env.NO_COLOR) {
      colorDepth = prefs.color && prefs.color !== 'auto' ? prefs.color : detectColorDepth(process.env, Boolean(process.stdout.isTTY));
    }
    glyphs = glyphSet(prefs.glyphs && prefs.glyphs !== 'auto' ? prefs.glyphs : glyphTier(process.env));
    const wantMouse = !args.includes('--no-mouse') && prefs.mouse !== false;
    if (wantMouse !== mouse) {
      mouse = wantMouse;
      out.write(mouse ? MOUSE_ON : MOUSE_OFF);
    }
    if (tick) {
      clearInterval(tick);
      tick = setInterval(() => { ask(); schedulePaint(); }, refreshMs());
      tick.unref?.();
    }
    schedulePaint();
  }

  /** Keys while the options window owns the keyboard. Returns true when it consumed the event. */
  function optionsKey(ev: { key: string; ctrl: boolean; alt: boolean }): boolean {
    if (!options) return false;
    const rows = optRows();
    const sel = selectableRows(rows);

    // A capture is a WALL, like the filter: it reads one key or one line and nothing escapes into the
    // verb switch, which in this app binds single letters to actions that revert files.
    if (options.capture) {
      const cap = options.capture;
      if (ev.key === 'escape') { options.capture = null; return (schedulePaint(), true); }
      if (cap.kind === 'key') {
        if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
          options.capture = null;
          saveOptions(setOption(prefs, cap.id, ev.key));
        } else {
          state.status = 'that is not a single printable key — press one, or esc to keep the current binding';
          options.capture = null;
          schedulePaint();
        }
        return true;
      }
      if (ev.key === 'enter') {
        options.capture = null;
        // The store row MOVES data — a real filesystem operation, so it cannot live in the pure
        // applier. Blank restores the default location, which is also a move.
        if (cap.id === 'storeDir') {
          const want = cap.buf.trim();
          const target = want || path.join(core.claudeConfigDir(), 'claude-observatory');
          const parsed = want ? core.parseStorePath(want) : { dir: target };
          if ('error' in parsed) {
            state.status = parsed.error;
            return (schedulePaint(), true);
          }
          const res = core.moveStore(parsed.dir);
          if ('error' in res) {
            state.status = `store not moved — ${res.error}`;
            return (schedulePaint(), true);
          }
          const next = { ...prefs };
          if (want) next.storeDir = parsed.dir;
          else delete next.storeDir;
          saveOptions(next);
          state.status = `store moved to ${res.to}`;
          ask();
          return (schedulePaint(), true);
        }
        saveOptions(setOption(prefs, cap.id, cap.buf));
        return true;
      }
      if (ev.key === 'backspace' || ev.key === 'delete') { cap.buf = cap.buf.slice(0, -1); return (schedulePaint(), true); }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) { cap.buf += ev.key; return (schedulePaint(), true); }
      return true;
    }

    if (ev.key === 'escape' || (ev.key.length === 1 && keys().get(ev.key) === 'options')) {
      options = null;
      state.status = 'ready';
      return (schedulePaint(), true);
    }
    const at = sel.indexOf(options.cursor);
    // The view FOLLOWS the cursor. Without this the list scrolled never, so every row past the
    // seventeenth — which is all of the KEYS section — could be selected and could not be seen.
    const follow = () => {
      const body = Math.max(1, frameRows - 5);
      // Each row can draw up to three lines (row, problem, help), so the window is bounded by the
      // worst case rather than by a row count that would let the selected row fall off the bottom.
      const visible = Math.max(1, Math.floor(body / 3));
      if (options!.cursor < options!.scroll) options!.scroll = options!.cursor;
      if (options!.cursor >= options!.scroll + visible) options!.scroll = options!.cursor - visible + 1;
      if (options!.scroll < 0) options!.scroll = 0;
    };
    if (ev.key === 'down') { options.cursor = sel[Math.min(sel.length - 1, at + 1)]; follow(); return (schedulePaint(), true); }
    if (ev.key === 'up') { options.cursor = sel[Math.max(0, at - 1)]; follow(); return (schedulePaint(), true); }
    if (ev.key === 'pgdn') { options.cursor = sel[Math.min(sel.length - 1, at + 5)]; follow(); return (schedulePaint(), true); }
    if (ev.key === 'pgup') { options.cursor = sel[Math.max(0, at - 5)]; follow(); return (schedulePaint(), true); }
    const row = rows[options.cursor];
    if (!row) return true;
    if (ev.key === 'left' || ev.key === 'right') {
      // `choices` is what makes a TEXT row steppable: the editor row offers what this machine has AND
      // still takes anything typed, so it is both. Stepping reads the same list the row rendered.
      if (row.kind === 'choice' || row.kind === 'toggle' || row.kind === 'number' || row.choices?.length) {
        saveOptions(applyOption(prefs, row.id, ev.key === 'right' ? 1 : -1, optEnv()));
      }
      return true;
    }
    if (ev.key === 'enter') {
      if (row.kind === 'text') {
        // Seeded from the row being edited, not from one hard-coded field: the remote rows are text
        // too, and starting them at the editor command would have the reader delete it every time.
        const seed = row.id === 'editor' ? prefs.editor ?? '' : row.id === 'storeDir' ? prefs.storeDir ?? '' : '';
        options.capture = { id: row.id, kind: 'text', buf: seed };
      } else
if (row.kind === 'key') options.capture = { id: row.id, kind: 'key', buf: '' };
      else if (row.kind === 'toggle') saveOptions(applyOption(prefs, row.id, 1));
      else if (row.id === 'reset') {
        saveOptions({});
        state.status = 'every option is back to its default';
      }
      return (schedulePaint(), true);
    }
    return true; // the window owns every other key while it is open
  }

  /** The session picker, opened from the top bar. Switching re-scopes the whole dashboard. */
  let pickerIds: string[] = [];
  /** True while the session picker is the overlay on screen — a saved machine's catalog that lands
   *  later must not repaint a picker the reader has already left. */
  let pickerOpen = false;
  /** The ROWS behind those ids, index for index — a picker row carries its machine (`owner` for a
   *  saved machine's session) and title, and the selection handler needs them to review a session
   *  where it lives and to refuse a row that is not a session. */
  let pickerRows: Record<string, unknown>[] = [];
  /** What the open picker was built from: the saved-machine list's failure and each saved machine's
   *  catalog, by identity. */
  let pickerSources: unknown[] = [];
  const pickerSourcesNow = (): unknown[] => [state.observatory?.machineError,
    ...(state.observatory?.machines ?? []).filter((m) => !m.local).flatMap((m) => [m.id, m.sessions, m.sessionsError])];
  /**
   * The Observatory's machine facts moved — a saved machine's catalog answered, failed or refreshed.
   * An open picker shows the new rows in place, the reader's highlighted row kept (never over a delete
   * question, whose explanation holds the overlay); a launch session waiting for its owner is read the
   * moment a catalog lists it, or told that none does.
   */
  function machinesChanged(): void {
    if (pickerOpen && !state.confirm) {
      const now = pickerSourcesNow();
      if (now.length !== pickerSources.length || now.some((x, i) => x !== pickerSources[i])) renderSessionPicker(true);
    }
    if (state.reviewFinding) ask();
    queueAdopt();
  }
  /** What the reader has typed to narrow the session picker. Null when the picker is closed. */
  let pickerFilter: string | null = null;

  /**
   * The session picker.
   *
   * It lists EVERY workspace, so each row names the one it came from — the old listing mixed
   * ancestor-directory sessions in with this repo's and named none of them. And it FILTERS, because
   * "every workspace" is 95 rows on this machine and scrolling a list that long to find one
   * conversation is not choosing, it is hunting.
   */
  let pickerState: 'all' | 'working' | 'done' | 'idle' = 'all';
  /** Whether the picker is showing sessions older than a week. */
  let pickerOlder = false;
  /** The fold row's id. Not a session — choosing it expands rather than opens. */
  const OLDER_ROW = '\u0000older';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  /** The help overlay's live filter: null = not filtering; '' = engaged, empty. */
  let helpFilter: string | null = null;
  const helpShowing = (): boolean => !!state.overlay && /esc or \? to close/.test(state.overlay.title);
  function rerenderHelp(): void {
    const all = helpLines(prefs);
    const q = (helpFilter ?? '').toLowerCase();
    const lines = q ? all.filter((l) => l.toLowerCase().includes(q)) : all;
    state.overlay = {
      title: helpFilter !== null
        ? `keys  —  /${helpFilter}_ filters (${lines.length} match${lines.length === 1 ? '' : 'es'}) · esc clears`
        : 'keys  —  esc or ? to close',
      lines: lines.length ? lines : ['  nothing matches — esc clears the filter'],
      scroll: 0,
    };
    schedulePaint();
  }
  function openSessionPicker(): void {
    if (state.confirm) {
      // The confirm wall sits above the picker wall by design — opening the picker over a
      // standing keep/undo would let a typed filter letter answer an invisible question with a
      // store mutation (re-review). Answer it first.
      state.status = 'answer the pending keep/undo first — y or n';
      return schedulePaint();
    }
    pickerFilter = '';
    pickerOpen = true;
    pickerState = 'all';
    pickerOlder = false;
    renderSessionPicker();
  }

  /**
   * Colour a picker row's machine cell by what it MEANS for reviewing that session.
   *
   * One palette, one meaning: `egress` is already "this left your machine", which is exactly what a
   * remote session is, so the chip and the picker cannot disagree about what purple says. A local
   * row is deliberately dim — it is the common case, and the common case should not shout.
   */
  const tintMachine = (padded: string, row: Record<string, unknown>): string => {
    if (row.error) return tint(padded, 'risk', colorDepth);
    if (row.owner) return tint(padded, 'egress', colorDepth);
    return colorDepth === 'none' ? padded : `\x1b[2m${padded}\x1b[0m`;
  };

  /** This machine's listing when none was read yet: a review launched onto another machine's session
   *  reads only there. The picker asks for it once, off the paint path, and its note says so meanwhile. */
  const localListing: { reading?: boolean; at?: number; error?: string } = {};
  function readLocalListing(): void {
    // Once at a time, and a failure is not re-asked on every keystroke that repaints the picker.
    if (localListing.reading || Date.now() - (localListing.at ?? 0) < 10_000) return;
    localListing.reading = true;
    localListing.at = Date.now();
    void backend!.run(['views', '--views', 'sessions', '--json', '--session', state.session]).then((out) => {
      localListing.reading = false;
      try {
        const listing = (JSON.parse(out) as { sessions?: { sessions?: unknown } }).sessions;
        if (!Array.isArray(listing?.sessions)) throw new Error('no sessions in the answer');
        localCatalog = listing;
        localListing.error = undefined;
      } catch {
        localListing.error = out.trim().split('\n')[0] || 'no answer';
      }
      if (pickerOpen && !state.confirm) renderSessionPicker(true);
    });
  }

  /** A picker row's identity across machines: the same id can be listed by two of them. */
  const pickerKey = (x: Record<string, unknown>): string => `${String(x.owner ?? '')}\u0000${String(x.id)}`;

  /**
   * `inPlace`: rebuild for new data (a saved machine's catalog landed) — the highlighted row and the
   * scroll stay where the reader left them. Otherwise the cursor starts on the session in effect.
   */
  function renderSessionPicker(inPlace = false): void {
    // This machine's own listing — the last one read here when a review elsewhere is on screen or a
    // switch is still loading — then every saved machine's, from the Observatory's per-machine catalog
    // (read off the paint path, throttled). A sync mirror of another machine's session is never in
    // this machine's listing: that machine's own catalog answers for it, or its row says it cannot.
    const here = (state.views?.sessions ?? localCatalog) as { sessions?: Record<string, unknown>[] } | undefined;
    if (!here) readLocalListing();
    const all = pickerSessionRows(state, here?.sessions ?? []);
    if (!here) all.unshift({ id: '!here', machine: core.THIS_MACHINE, error: localListing.error,
      note: localListing.error ? `could not list this machine's sessions — ${localListing.error}` : "this machine's sessions are being read…" });
    const before = inPlace && state.overlay?.cursor !== undefined ? pickerRows[state.overlay.cursor] : undefined;
    const prevScroll = inPlace ? state.overlay?.scroll ?? 0 : 0;
    pickerSources = pickerSourcesNow();
    // The session in effect is a session ON a machine: its id where Review reads it.
    const owner = reviewMachine(state.session) ?? '';
    const inEffect = (x: Record<string, unknown>): boolean => String(x.id) === state.session && String(x.owner ?? '') === owner;
    /** A saved machine's standing note (still answering, or unreachable) — never filtered away. */
    const isNote = (x: Record<string, unknown>): boolean => typeof x.note === 'string';
    if (!all.length) {
      pickerFilter = null;
      // With nothing to show, the picker is not open — take its overlay down too. Reached after the
      // LAST session is deleted (the confirm's explanation overlay would otherwise linger), as well as
      // on a machine that has no transcripts at all, where the overlay was already null.
      pickerOpen = false;
      state.overlay = null;
      state.status = 'no sessions found — this machine has no Claude Code transcripts yet';
      return schedulePaint();
    }
    const f = (pickerFilter ?? '').toLowerCase();
    const textList = f
      ? all.filter((x) => isNote(x) || `${x.title ?? ''} ${x.id} ${x.workspace ?? ''} ${x.machine ?? ''}`.toLowerCase().includes(f))
      : all;
    // The STATE chips (adopted from herdr): one key (tab) cycles all → working → done → idle,
    // narrowing to the sessions in that phase — `done` is the seen-bit set, so "what finished
    // while I was elsewhere" is one keystroke.
    const phaseOf = (x: Record<string, unknown>): 'working' | 'done' | 'idle' =>
      x.active === true ? 'working' : state.doneUnseen?.has(String(x.id)) ? 'done' : 'idle';
    const phaseCount = { working: 0, done: 0, idle: 0 } as Record<string, number>;
    for (const x of textList) if (!isNote(x)) phaseCount[phaseOf(x)]++;
    const list = pickerState === 'all' ? textList : textList.filter((x) => isNote(x) || phaseOf(x) === pickerState);
    // A WEEK'S WORTH BY DEFAULT. A machine that has been running agents for a
    // month lists ninety-odd sessions, and scrolling that to reach yesterday's work is hunting, not
    // choosing. The older ones are folded behind one row that says how many — and the session in
    // EFFECT is never folded away, whatever its age, because the picker must always be able to show
    // you where you are.
    const now = Date.now();
    const isOld = (x: Record<string, unknown>): boolean =>
      !pickerOlder &&
      !inEffect(x) &&
      Number(x.lastActiveMs) > 0 &&
      now - Number(x.lastActiveMs) > WEEK_MS;
    const older = list.filter(isOld);
    const shownList = older.length ? list.filter((x) => !isOld(x)) : list;
    pickerIds = shownList.map((x) => String(x.id));
    pickerRows = shownList as Record<string, unknown>[];
    // Columns sized from the DATA, so nothing is cut. The old picker sliced every title at 44
    // characters mid-word with no marker — 12 of 63 rows on this machine — which is the one thing
    // this product does not do to content.

    // WHICH MACHINE, as its own column. It used to be jammed onto the front of the workspace label
    // and truncated to fit — and a truncated machine name answers the question no better than no
    // machine name at all. Sized from the data, like every other column here.
    // Sized from the SESSION rows: a machine's note is a line of its own, not a row of this table.
    const tableRows = shownList.filter((x) => !isNote(x));
    const mcW = Math.max(1, ...tableRows.map((x) => String(x.machine ?? '').length));
    // How many rows share each title, so only the ambiguous ones get an id appended.
    const titleCounts = new Map<string, number>();
    for (const x of tableRows) {
      const t = String(x.title || '') || String(x.id).slice(0, 8);
      titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    }
    /** The agent + capture-tier badges: WHO ran the session, and how it is observed. Claude is the
     *  unmarked default (it is most rows); any other agent is named so a codex session cannot be
     *  mistaken for a Claude one — the model column then says WHICH model either ran (so
     *  every session menu tells agent + model at a glance). hooks-only stays unmarked; a
     *  driven session says so, because its fidelity is a different tier. */
    const handBadge = (x: Record<string, unknown>): string => {
      const a = x.attention as { kind?: string; ts?: number } | null | undefined;
      if (!a || !a.kind || a.kind === 'idle-done') return '';
      return `[${glyphs.pending} ${a.kind}${typeof a.ts === 'number' ? ` ${core.compactDuration(Math.max(0, Date.now() - a.ts))}` : ''}] `;
    };
    const badgeOf = (x: Record<string, unknown>): string =>
      handBadge(x) +
      (state.doneUnseen?.has(String(x.id)) ? '[done] ' : '') +
      (x.agent && x.agent !== 'claude' ? `[${String(x.agent)}] ` : '') +
      '';
    // Padded from the DATA and capped: a single very long title must not push every other row's
    // columns off to the right, and nothing is ever cut — a long one simply overflows its own row.
    // Every column sized from the DATA, so nothing is cut and nothing is padded to a guess.
    const dW = Math.max(1, ...tableRows.map((x) => String(Math.max(Number(x.added) || 0, Number(x.removed) || 0)).length + 1));
    const costW = Math.max(0, ...tableRows.map((x) => {
      const t = Number(x.tokens) ? `${core.compactTokens(Number(x.tokens))} tok` : '';
      const d = Number(x.durationMs) ? core.compactDuration(Number(x.durationMs)) : '';
      return [t, d].filter(Boolean).join(' · ').length;
    }));
    // MODEL ONLY: effort is a per-turn setting, not something you choose a
    // session by, and it cost a column on every row to say so.
    const brainW = Math.max(0, ...tableRows.map((x) => String(x.model || '').length));
    // The store's on-disk footprint. A saved machine's session reports its own (`storeBytes` in its
    // catalog): its store lives there, and a stat here would measure a stranger or nothing.
    // `core.storeBytes` is cached on the store's shape, so re-rendering as a filter narrows the list is
    // cheap. Computed once here, keyed by row, and read back in the row assembly.
    const sizes = new Map<Record<string, unknown>, string>(
      tableRows.map((x) => {
        if (x.error) return [x, ''];
        const b = x.owner ? Number(x.storeBytes) || 0 : core.storeBytes(String(x.id));
        return [x, b ? core.compactBytes(b) : ''];
      })
    );
    const storeW = Math.max(0, ...[...sizes.values()].map((s) => s.length));
    const titleW = Math.min(46, Math.max(1, ...tableRows.map((x) => {
      const t = String(x.title || '') || String(x.id).slice(0, 8);
      return t.length + badgeOf(x).length + ((titleCounts.get(t) ?? 0) > 1 ? 10 : 0);
    })));
    // WHAT FITS. Every optional column costs width, and a row wider than the terminal wraps — so the
    // narrow-terminal answer is to drop whole columns, cheapest-to-the-reader first, rather than let
    // the table re-flow. The order is what a reader chooses a session BY: the name and its age never
    // go; the workspace is the longest and least discriminating, so it goes first.
    const whenW = Math.max(1, ...tableRows.map((x) => core.relTime(Number(x.lastActiveMs) || 0).length));
    const keep = new Set(['machine', 'churn', 'cost', 'brain', 'store']);
    const widthOf = (): number =>
      1 + 1 + 1 + whenW + 2 + titleW +
      (keep.has('machine') ? 2 + mcW : 0) +
      (keep.has('churn') ? 2 + dW * 2 + 1 : 0) +
      2 + 13 +
      (keep.has('cost') ? 2 + costW : 0) +
      (keep.has('brain') ? 2 + brainW : 0) +
      (keep.has('store') && storeW ? 2 + storeW : 0);
    // One column is reserved: the selected row is drawn in reverse video across its full width, and a
    // row sized to exactly the terminal leaves no cell for the cursor glyph in the `--no-color` path.
    // The machine stays whenever the list mixes machines: without it, a session that is reviewed — and
    // whose files a keep or undo changes — on another machine reads exactly like one here.
    const mixed = tableRows.some((x) => x.owner);
    for (const drop of ['churn', 'brain', 'cost', 'store', ...(mixed ? [] : ['machine'])]) {
      if (widthOf() <= frameCols - 1) break;
      keep.delete(drop);
    }
    const lines = shownList.map((x) => {
      // A saved machine still answering, or unreachable: one line saying which, in its group's place.
      if (isNote(x)) {
        const note = `   ${x.error ? '!' : glyphs.pending} ${String(x.note)}`;
        return colorDepth === 'none' ? note : x.error ? tint(note, 'risk', colorDepth) : `\x1b[2m${note}\x1b[0m`;
      }
      const cur = inEffect(x) ? '*' : ' '; // '*' = the session in effect; '>' is the picker's cursor
      // NOTHING LEFT TO REVIEW = QUIET. A session with no pending edits is not a
      // session you need to open, so the whole row recedes rather than competing with the ones that
      // do. Dimmed as a WHOLE, which is why a quiet row skips the per-cell tints: a tint closes with
      // a reset, and a reset inside the row would end the dim at the first coloured cell and leave
      // the rest at full weight.
      const quiet = !(Number(x.pending) || 0) && !x.error;
      const plain = (t: string) => t;
      const paint = quiet ? plain : tint;
      // The machine carries MEANING, not just a name: purple is the palette's "off this machine",
      // the same hue the ⇅ egress chip uses, so a session you cannot review from here is obvious
      // before you press enter on it. Padded BEFORE tinting — `padEnd` counts escape bytes, so
      // tinting first makes every coloured cell short by the length of its escape sequence.
      const machine = quiet ? String(x.machine ?? '?').padEnd(mcW) : tintMachine(String(x.machine ?? '?').padEnd(mcW), x);
      const state_ = x.error
        ? 'unreachable'
        : Number(x.pending) || 0
          ? `${String(Number(x.pending) || 0).padStart(5)} pending`
          : '   no edits';
      const when = core.relTime(Number(x.lastActiveMs) || 0);
      // THE NAME LEADS. It is what a reader is scanning for — the machine and workspace are how they
      // narrow, not how they choose — and it used to sit last, past four columns of metadata.
      //
      // A title is derived from the session's first ask, so several sessions genuinely share one:
      // five rows here read "Check Claude effort environment variable". They are not duplicates and
      // must not be hidden, but they are indistinguishable, so a repeated title carries its short id.
      // Only repeats pay for it — tagging every row would add noise to the ones that never needed it.
      const title = String(x.title || '') || String(x.id).slice(0, 8);
      const badge = badgeOf(x);
      const shown = badge + ((titleCounts.get(title) ?? 0) > 1 ? `${title}  ${String(x.id).slice(0, 8)}` : title);
      // WHAT THE SESSION COST, the way the editors' session row shows it. Every field here was already
      // in this payload and none of it was displayed: choosing a session to review meant choosing on a
      // name and an age alone, with its size, spend and model one keystroke out of reach.
      //
      // Padded before tinting — `padEnd` counts escape bytes, so tinting first leaves every coloured
      // cell short by the length of its own escape sequence.
      const churn = Number(x.added) || Number(x.removed)
        ? `${paint(`+${Number(x.added) || 0}`.padStart(dW), 'kept', colorDepth)} ${paint(`−${Number(x.removed) || 0}`.padEnd(dW), 'risk', colorDepth)}`
        : ' '.repeat(dW * 2 + 1);
      const cost = [
        Number(x.tokens) ? `${core.compactTokens(Number(x.tokens))} tok` : '',
        Number(x.durationMs) ? core.compactDuration(Number(x.durationMs)) : '',
      ].filter(Boolean).join(' · ');
      const brain = String(x.model || '');
      // Assembled from the columns this width can afford, widest-to-narrowest in DROP order. A table
      // is the one thing the overlay must not wrap: it re-flows a row onto a second visual line, and
      // a two-line row in a list you are arrowing through costs the alignment that made it a table.
      // Nothing is cut mid-word either way — a column is present in full or not at all.
      // WHEN LEADS, greyed. It is the axis a reader actually scans this list on —
      // "the one from this morning" — and it was last, past six columns of metadata. Dim because it
      // orders the list rather than naming anything in it.
      const whenCell = when.padStart(whenW);
      const cells: string[] = [
        ` ${cur} ${quiet || colorDepth === 'none' ? whenCell : `\x1b[2m${whenCell}\x1b[0m`}`,
        shown.padEnd(titleW),
      ];
      if (keep.has('machine')) cells.push(machine);
      if (keep.has('churn')) cells.push(churn);
      cells.push(state_.padEnd(13));
      if (keep.has('cost')) cells.push(paint(cost.padEnd(costW), 'undone', colorDepth));
      if (keep.has('brain')) cells.push(paint(brain.padEnd(brainW), 'undone', colorDepth));
      if (keep.has('store') && storeW) cells.push(paint((sizes.get(x) ?? '').padStart(storeW), 'undone', colorDepth));
      const row = cells.join('  ');
      return quiet && colorDepth !== 'none' ? `\x1b[2m${row}\x1b[0m` : row;
    });
    // …and one row for everything older than a week, which choosing EXPANDS rather than opens.
    if (older.length) {
      const note = `   ${glyphs.closed} ${older.length} session${older.length === 1 ? '' : 's'} older than a week — enter shows them`;
      lines.push(colorDepth === 'none' ? note : `\x1b[2m${note}\x1b[0m`);
      pickerIds.push(OLDER_ROW);
      pickerRows.push({ id: OLDER_ROW });
    }
    if (!lines.length) {
      lines.push(`  nothing matches “${pickerFilter}” — backspace to widen it`);
      pickerIds = [];
      pickerRows = [];
    }
    // Never an empty tail standing in for "still asking": a configured machine that has not answered
    // yet reads exactly like one with no sessions unless the list says which (its note row, above).
    const kept = before ? pickerRows.findIndex((r) => pickerKey(r) === pickerKey(before)) : -1;
    const at = kept >= 0 ? kept : Math.max(0, pickerRows.findIndex(inEffect));
    // The cursor row on screen: rows can arrive above it, and a picker opened on a session far down a
    // long list must still show it.
    const view = Math.max(1, frameRows - 6);
    const scroll = Math.min(at, Math.max(prevScroll, at - view + 1));
    state.overlay = {
      // Two halves, separated once: WHAT you are looking at, then WHAT the keys do. The old line
      // interleaved a count, a state name, three phase counts and four key hints in one run of
      // words, so a reader had to parse the whole thing to find either.
      title: [
        `sessions · ${tableRows.length}`,
        `[${pickerState}]`,
        `working ${phaseCount.working} · done ${phaseCount.done} · idle ${phaseCount.idle}`,
        pickerFilter ? `filter ${pickerFilter}_` : '',
        pickerOlder ? 'incl. older' : '',
        '—',
        'tab state · type filters · enter opens · ^D deletes · esc closes',
      ].filter(Boolean).join('  '),
      lines,
      scroll,
      cursor: at,
    };
    schedulePaint();
  }
  /**
   * Enter inside one of the two OVERLAYS that are not the session picker.
   *
   * Separate from `choosePicked` on purpose: that function declares its own `picked` for a picker row,
   * which shadows the outer selection flag for its whole body — so the jump below could not set the
   * thing it exists to set. Two small handlers beat one that cannot say what it means.
   *
   * Returns true when it consumed the Enter.
   */
  function chooseOverlayAction(): boolean {
    const o = state.overlay;
    if (!o || o.cursor === undefined) return false;
    if (jumpRows && o.title === JUMP_TITLE) {
      const to = jumpRows[o.cursor];
      jumpRows = null;
      state.overlay = null;
      if (to !== undefined) {
        focusPane('traces');
        state.cursor = to;
        picked = true;
        clampCursor();
        syncPane();
        syncDetailDiff();
      }
      schedulePaint();
      return true;
    }
    if (rowMenu && o.title === ROW_MENU_TITLE) {
      // Everything the row menu offers is a key that already exists, so choosing simply presses it —
      // the menu can never do something the keyboard cannot.
      const key = rowMenu[o.cursor];
      rowMenu = null;
      state.overlay = null;
      if (key) onKey({ key, ctrl: false, alt: false });
      else schedulePaint();
      return true;
    }
    return false;
  }

  /** `forceOwner` rides with `forceId` from a list that names the machine (the palette): the saved
   *  machine the session is reviewed on, '' for this one; undefined leaves that to `reviewMachine`. */
  function choosePicked(forceId?: string, forceOwner?: string): void {
    adoptOpen = false; // a chosen session is never moved by the launch's newest-session rule
    pickerFilter = null;
    pickerOpen = false;
    const o = state.overlay;
    // `forceId` is the needs-you jump: the same switch, with every guard below, without a picker up.
    if (forceId === undefined && (!o || o.cursor === undefined)) return;
    const id = forceId ?? pickerIds[o!.cursor!];
    // The picked ROW, not the first with its id: two machines can list one session, and the row the
    // reader chose decides where it is reviewed — where every keep and undo will change files.
    const row = forceId === undefined ? pickerRows[o!.cursor!] : undefined;
    const owner = forceId === undefined ? String(row?.owner ?? '') : forceOwner;
    if (id === OLDER_ROW) {
      // Expand in place: the picker stays open, the cursor stays where it is, and the rows it was
      // hiding appear beneath. Closing and reopening to see them would lose the filter as well.
      pickerOlder = true;
      pickerFilter = pickerFilter ?? '';
      pickerOpen = true;
      return renderSessionPicker();
    }
    state.overlay = null;
    // A saved machine's note (still answering, or unreachable) is not a session: say what it says.
    if (typeof row?.note === 'string') {
      state.status = row.note;
      return schedulePaint();
    }
    if (!id || (id === state.session && (owner === undefined || owner === (reviewMachine(id) ?? '')))) {
      state.status = 'ready';
      return schedulePaint();
    }
    // `storeDir` THROWS on an id `isSafeSessionId` rejects, so nothing that is not a session id may
    // become the session in effect.
    if (!core.isSafeSessionId(id)) {
      state.status = `that row is not a session — ${String(row?.title || id)}`;
      return schedulePaint();
    }
    // Reviewed where its row came from: a saved machine's session is read and decided THERE, through
    // `--machine`, and this machine's own rows here ('' pins that against a stale remote memory).
    if (owner !== undefined) sessionMachines.set(id, owner);
    // Everything below the top bar is scoped to one session, so switching resets the view rather than
    // leaving a cursor pointing into the previous session's rows.
    // Pin it on the ACTIVE TAB too (per-tab session): Review's 🔬 retargets Review, the agent tab's
    // its own — and switchTab restores each tab's pick. The observatory tab has no session field, so a
    // pick there sets only the transient state.session, which is correct (it pins none).
    if (tabs[active].session !== undefined) tabs[active].session = id;
    state.session = id;
    forgetSessionSelection();
    if (state.doneUnseen?.has(id)) {
      const done = new Set(state.doneUnseen);
      done.delete(id); // looking at it IS the acknowledgement
      state.doneUnseen = done;
    }
    state.usage = undefined; // the usage row re-reads for the new session on the next paint
    state.views = null;
    state.cursor = 0;
    state.scroll = 0;
    state.sessionTitle = '';
    state.status = `switched to ${id.slice(0, 8)}${owner ? ` on ${owner}` : ''}`;
    ask();
    schedulePaint();
  }

  /**
   * Ask to DELETE the highlighted session — the picker's destructive row action, sitting beside
   * "enter opens". It raises the same `state.confirm` wall every other destructive
   * action here uses, so it OWNS the keyboard until answered (the confirm branch in `onKey` sits above
   * the picker's own typing wall): the reader answers y/n before a filter letter can reach anything.
   *
   * The confirm replaces the picker's body with a full, wrapping explanation so nothing about what
   * delete does is truncated onto a status line — it names the session, says the transcript is kept,
   * names the edits still pending review that go with it for good, and says what `--undelete` brings
   * back: the session, not its edits. The list returns on y or n.
   */
  function requestDeleteSession(): void {
    const o = state.overlay;
    if (!o || o.cursor === undefined) return;
    const id = pickerIds[o.cursor];
    if (!id || id === OLDER_ROW) {
      state.status = 'highlight a session first';
      return schedulePaint();
    }
    // The rows that are not deletable local sessions: a saved machine's note (`!name`, which
    // `isSafeSessionId` rejects and `deleteSession` would throw on), and a saved machine's session,
    // whose record is kept THERE — deleting here would purge a same-id store on this machine instead.
    const row = pickerRows[o.cursor];
    if (row?.owner && core.isSafeSessionId(id) && !row.note) {
      state.status = `that session is on ${String(row.owner)} — delete it there: oak sessions --delete ${id} --machine ${String(row.owner)}`;
      return schedulePaint();
    }
    if (!core.isSafeSessionId(id) || row?.error) {
      state.status = 'that row is not a local session this dashboard can delete';
      return schedulePaint();
    }
    const title = String(row?.title || '') || id.slice(0, 8);
    // An edit still pending review loses its before-snapshot in the purge, so the agent's change can no
    // longer be undone (this said "Restore it later"). The count is the listing's, the
    // one this row shows, and `lastEdit` the newest edit that listing saw; an edit captured since is refused
    // by the delete itself (applyDeleteSession).
    const pending = Math.max(0, Number(row?.pending) || 0);
    const seenThrough = typeof row?.lastEdit === 'number' ? row.lastEdit : undefined;
    const edits = `${pending} pending edit${pending === 1 ? '' : 's'}`;
    const lines = [
      `  Delete “${title}”  (${id.slice(0, 8)})?`,
      '',
      '  It disappears from every Observatory session menu and its stored edits are purged for good.',
      '  The transcript on disk is NOT deleted — only Observatory’s record of the session.',
      ...(pending ? ['', `  ${pending === 1 ? '1 of those edits is' : `${pending} of those edits are`} still pending review: the purge drops ${pending === 1 ? 'its before-snapshot' : 'their before-snapshots'},`,
        `  so OAK can no longer undo ${pending === 1 ? 'that change' : 'those changes'}.`] : []),
      '',
      `  oak sessions --undelete ${id} lists the session again, without its edits.`,
      '',
      pending ? `  y — delete and purge the ${edits}    n — cancel` : '  y — delete    n — cancel',
    ];
    // The picker's rows are swapped for the explanation, but its filter/state/open flags are left
    // untouched, so answering (y or n) can rebuild exactly the picker the reader came from.
    state.overlay = { title: 'delete session', lines, scroll: 0 };
    // `session` carries the target the way `kill`/`resolve` already do; the short label is all the
    // status line needs, because the body above carries the full consequence.
    state.confirm = { verb: 'delete', ids: [], session: id, pending, seenThrough,
      label: `“${title}” (${id.slice(0, 8)})${pending ? ` and purge its ${edits}` : ''}` };
    schedulePaint();
  }

  /**
   * Keep Detail's Diff face in step with the Traces selection.
   *
   * On demand, never on the poll: `cmdViews` hands ONE argument list to every view in a batch, so a
   * per-edit diff cannot ride alongside the other views without blanking them. Debounced, because
   * holding `j` would otherwise spawn one CLI per keypress.
   */
  const view = (st: typeof state, name: string): unknown =>
    st.views && typeof st.views === 'object' ? (st.views as Record<string, unknown>)[name] : null;
  function syncDetailDiff(): void {
    if (!state.panes) return;
    // The map is the NAVIGATOR: whatever node its cursor rests on scopes the
    // Traces list to that file or folder's subtree. Derived, never stored by hand — the root row and
    // the summary rows resolve to no node, which is exactly "unscoped".
    const mapNode = mapNodeAt(state.panes.cursor.map ?? 0);
    const scopeAbs = mapNode && mapNode.path !== '' && mapNode.abs ? mapNode.abs : undefined;
    if (state.mapScope !== scopeAbs) state.mapScope = scopeAbs;
    // Resolved from the TRACES pane's own list and cursor — never from `state.screen`/`state.cursor`,
    // which follow whichever window has focus. Reading those meant that merely focusing Detail
    // indexed the edit list with Detail's cursor, reported a "new selection", and cleared the face
    // the reader had just chosen: pressing F3 for the map landed on the diff, every time.
    // Nothing is selected until the reader SELECTS something. The dashboard used to fetch the newest
    // edit's diff on its very first paint, so it opened on one file's diff — and the session's change
    // map, which is what you want before you have picked anything, was a keystroke away and never the
    // thing you saw first. A cursor index cannot express this: `syncPane` writes 0 into the pane's
    // cursor on the first paint, so "index 0" and "nothing yet" are the same value.
    // The traces pane's ACTIVE tab, not a hardcoded 'edits' — on the Review tab the cursor walks
    // review rows, and indexing the edits list with it would fetch a different row's diff.
    const tracesBox = layout().boxes.find((b) => b.id === 'traces');
    const tracesScreen = tracesBox ? paneScreenOf(state, tracesBox) : 'edits';
    const rows = rowsOf(tracesScreen, 'traces');
    // The decision is pure (`followTracesDiff` — see its comment for the pin rule); this closure
    // only executes it. `pin` holds everything exactly as it stands: the zoomed diff face is a mode
    // the reader chose, and a refresh that lost their row must not un-choose it.
    const d = followTracesDiff(
      rows,
      state.panes.cursor.traces ?? 0,
      picked,
      state.panes.zoom === 'detail',
      diffWanted
    );
    if (d.act === 'keep' || d.act === 'pin') return;
    diffWanted = d.act === 'fetch' ? d.id : -1;
    if (d.act === 'clear') {
      state.diffPatch = undefined;
      state.diffMeta = undefined;
      return;
    }
    if (diffTimer) clearTimeout(diffTimer);
    diffTimer = setTimeout(() => {
      const want = diffWanted;
      void backend!.diff(want, state.session, reviewMachine(state.session)).then((text) => {
        if (want !== diffWanted) return; // the reader moved on; a late arrival must not overwrite
        const edits = (view(state, 'list') as { edits?: Record<string, unknown>[] } | null)?.edits ?? [];
        const e = edits.find((x) => Number(x.id) === want);
        state.diffPatch = text || '';
        state.diffMeta = {
          session: state.session,
          id: want,
          path: String(e?.file ?? ''),
          added: Number(e?.added ?? 0),
          removed: Number(e?.removed ?? 0),
          // The tool the agent actually used, which `list` already carries. Heading every edit with
          // one hard-coded verb said "Update" over a file that had just been created.
          verb: String(e?.tool ?? '') || 'Edit',
        };
        schedulePaint();
      });
    }, 90);
    diffTimer.unref?.();
  }

  function closeOverlay(): boolean {
    rowMenu = null; // the overlay is shared; a stale menu would answer the NEXT overlay's Enter
    jumpRows = null;
    if (!state.overlay) return false;
    pickerFilter = null; // one place every dismissal goes through, so the mode cannot outlive the overlay
    helpFilter = null;
    // …and the picker's open flag with it, so a deferred remote fetch that lands after the reader has
    // escaped cannot repaint an overlay they already dismissed.
    pickerOpen = false;
    // Reset the mode HERE, at the one place every dismissal goes through. Clearing it only in the
    // menu's own handlers left it set after an `esc`, so the next session picker's Enter dispatched
    // a menu action instead of switching session — the reader picks a session and gets "Update".
    state.overlay = null;
    state.filterMenu = null; // the picker marker never outlives its overlay, however it was dismissed
    // A delete confirm is the one confirmation raised OVER an overlay (from the session picker), so
    // dismissing that overlay must take its question down with it — otherwise `esc` closes the picker
    // and strands a `[y/n]` on the status line with nothing left to answer it. Only the delete verb
    // can be here: every other confirmation is raised with no overlay open (the picker refuses to open
    // over one), so this never discards a map/tree keep/undo.
    if (state.confirm?.verb === 'delete') state.confirm = null;
    state.status = 'ready';
    schedulePaint();
    return true;
  }

  /**
   * The filter PICKER — the file-type / extension buckets — rides the ordinary overlay path (title +
   * lines + a cursor) so it inherits the reverse-video selection and scrolling for free.
   * `state.filterMenu` is the marker that tells the key wall this overlay TOGGLES its rows rather than
   * scrolling a diff, and the lines are rebuilt from live state on every toggle so the `[x]` boxes
   * track what is in force. There is no regex row: the `/` query reads as a regex automatically. The
   * filter applies AS you toggle — no "apply" step — so `\`, esc, enter and q all simply close it.
   */
  function refreshFilterMenu(cursor: number): void {
    const items = filterMenuItems(state);
    const lines = filterMenuLines(items, colorDepth);
    const cur = Math.min(Math.max(0, cursor), Math.max(0, lines.length - 1));
    const viewH = Math.max(1, frameRows - 6);
    const scroll = cur >= viewH ? cur - viewH + 1 : 0;
    state.filterMenu = { cursor: cur };
    // The title carries what is currently applied, so the picker doubles as the "what filter is on"
    // readout while it is open (`/` sets the query, which shows here `/…/` when it is a live regex).
    const applied = filterSummary(state);
    const title = applied
      ? `filter: ${applied} — space toggles · c clears · \\ or esc closes`
      : 'filter — / to search · space toggles a bucket · c clears · \\ or esc closes';
    state.overlay = { title, lines, scroll, cursor: cur };
    schedulePaint();
  }
  function openFilterMenu(): void {
    const items = filterMenuItems(state);
    // Regex is always offered; the buckets/extensions come from the change map. With neither present
    // (no files yet) the menu would be a lone Regex row — still useful, so it opens regardless.
    refreshFilterMenu(filterMenuFirst(items));
  }
  function closeFilterMenu(): void {
    state.filterMenu = null;
    state.overlay = null;
    state.status = 'ready';
    schedulePaint();
  }
  function toggleFilterItem(it: FilterMenuItem | undefined, cursor: number): void {
    if (!it || it.kind === 'head') return;
    if (it.kind === 'cat') {
      const s = new Set(state.filterCats ?? []);
      if (s.has(it.id)) s.delete(it.id);
      else s.add(it.id);
      state.filterCats = [...s];
    } else if (it.kind === 'ext') {
      const s = new Set(state.filterExts ?? []);
      if (s.has(it.id)) s.delete(it.id);
      else s.add(it.id);
      state.filterExts = [...s];
    }
    clampCursor();
    syncPane();
    refreshFilterMenu(cursor);
  }
  // The picker's key wall: while it is open it owns the keyboard the way the session picker and the
  // text filter do, so a bare `s` or `u` cannot fall through to a verb that reverts files. ^C alone
  // is let past — it is the universal quit.
  function filterMenuKey(ev: { key: string; ctrl: boolean; alt: boolean }): boolean {
    if (!state.filterMenu || !state.overlay) return false;
    // A standing permission ask outranks the picker: this gate runs ABOVE the permission wall, so
    // without yielding here the ask's digits are swallowed and Esc closes the picker instead of
    // refusing. Paint has already replaced the picker overlay with the modal by now.
    if (ev.ctrl && ev.key === 'c') return false;
    const o = state.overlay;
    const items = filterMenuItems(state);
    const cur = o.cursor ?? 0;
    const selectable = (i: number): boolean => !!items[i] && items[i].kind !== 'head';
    if (ev.key === 'escape' || ev.key === 'enter' || ev.key === 'q' || ev.key === '\\') {
      closeFilterMenu();
      return true;
    }
    if (ev.key === 'up' || ev.key === 'down' || ev.key === 'pgup' || ev.key === 'pgdn') {
      const dir = ev.key === 'down' || ev.key === 'pgdn' ? 1 : -1;
      let next = cur;
      for (let step = 0; step < items.length; step++) {
        next = (next + dir + items.length) % items.length;
        if (selectable(next)) break;
      }
      refreshFilterMenu(next);
      return true;
    }
    if (ev.key === ' ' || ev.key === 'x') {
      toggleFilterItem(items[cur], cur);
      return true;
    }
    if (ev.key === 'c') {
      // Clear everything the filter narrows by — the query and both pickers — so `c` is one "show it
      // all again", not just the row under the cursor.
      state.filter = '';
      state.filterCats = [];
      state.filterExts = [];
      clampCursor();
      syncPane();
      refreshFilterMenu(cur);
      return true;
    }
    return true; // containment — no other key escapes the picker into the verb map
  }


  /**
   * Scroll the Diff face to the next line containing `needle`, wrapping at the end.
   *
   * Scrolls rather than highlights: the diff is already SGR-dense (added/removed banding, intraline
   * marks), and threading a second highlight through `renderRichDiff` risks composing badly with the
   * wrap it already does. Moving the viewport is the part that was actually missing.
   */
  function jumpToMatch(needle: string, dir: 1 | -1): void {
    if (!needle) {
      state.status = 'ready';
      return schedulePaint();
    }
    const lines = (state.diffPatch ?? '').split('\n');
    if (!lines.length) {
      state.status = 'no diff on screen to search';
      return schedulePaint();
    }
    const n = needle.toLowerCase();
    const from = state.scroll;
    // Searched over the PATCH's own lines, and the pane's scroll is in rendered rows — close enough
    // to land the match on screen, which is what "find" has to do; the reader takes it from there.
    let hit = -1;
    for (let i = 1; i <= lines.length; i++) {
      const at = (from + i * dir + lines.length * 2) % lines.length;
      if (lines[at].toLowerCase().includes(n)) {
        hit = at;
        break;
      }
    }
    if (hit < 0) {
      state.status = `“${needle}” is not in this diff`;
      return schedulePaint();
    }
    lastFind = needle;
    state.findNeedle = needle; // …and MARK them, not just scroll to them
    state.scroll = Math.max(0, hit - 2); // a couple of lines of lead-in, so the match is not the top row
    state.status = `“${needle}” — line ${hit + 1} of ${lines.length} · n / p for the next`;
    return schedulePaint();
  }
  /**
   * MARKS — `'a` to set one here, `` `a `` to come back.
   *
   * vim's pair is `m` to set and `'` to jump, and `m` is taken here: it minimizes the focused window,
   * and has since before this existed. So the two JUMP keys take both jobs — `'` sets, `` ` `` goes —
   * which keeps half the muscle memory (both are vim's mark keys, on adjacent physical keys) and
   * costs nothing that was already bound.
   *
   * A mark is a row's EDIT ID, not its index: sorting, filtering and Claude appending more edits all
   * move indices around, and a mark that quietly pointed at a different file after a re-sort would be
   * worse than no mark at all. Runtime only, like the mark SET — a jump target from yesterday's
   * session is not a thing anyone wants restored.
   */
  const marks = new Map<string, number>();
  /** Which mark key is being captured: `set` after `'`, `jump` after `` ` ``, else null. */
  let markPending: 'set' | 'jump' | null = null;

  /** The keys the right-click menu is currently offering, in the order it drew them. Null when no row
   *  menu is open — the overlay is shared with the pickers, and only this says which one it is. */
  let rowMenu: string[] | null = null;

  /** Traces row indexes the jump-to-file overlay is offering, in the order it drew them. */
  let jumpRows: number[] | null = null;

  /** The last find, so `n`/`p`/`N` can repeat it while the Diff face has focus. */
  let lastFind = '';

  /**
   * Forget the standing find, which is what hands `n`/`p` back to the review stepper.
   *
   * Called wherever the find stops describing what is on screen: a different selection (the patch under
   * it is not the one that was searched), a face or focus change, and `esc` out of the find prompt.
   * Without this the flag was one-way — set on the first successful find and never cleared — so the
   * Diff face silently kept `n`/`p` for the rest of the session.
   */
  function clearFind(): void {
    lastFind = '';
    state.findNeedle = undefined;
  }

  function runCommand(line: string): void {
    if (!line) {
      state.status = 'ready';
      return schedulePaint();
    }
    const [name, ...rest] = line.split(/\s+/).filter(Boolean);
    // Review comments take free text; local comments use core and remote comments use the CLI, so they
    // are handled before the fixed-arg COMMANDS table below (whose `rest` is dropped). `:comment` marks
    // up the edit whose diff is on screen; `:send-comments` batches every unsent one into the composer.
    if (name === 'comment') {
      if (!reviewReady()) return;
      const typed = line.slice(name.length).trim();
      if (!typed) {
        state.status = 'usage: :comment [<line>:] <note> — comments on the edit whose diff is shown; `12: note` anchors it to line 12';
        return schedulePaint();
      }
      const id = state.diffMeta?.id;
      if (id === undefined) {
        state.status = 'select an edit (its diff must be shown) before :comment';
        return schedulePaint();
      }
      // `:comment 12: note` anchors the note to line 12 of the edit, as the editors' gutter and the CLI's
      // --line do, and only to a line the diff shows; anything else is about the whole edit (commentAnchor).
      const anchor = commentAnchor(typed, state.diffPatch ?? '');
      if ('error' in anchor) {
        state.status = anchor.error;
        return schedulePaint();
      }
      const { line: lineNo, text } = anchor;
      const machine = reviewMachine(state.session);
      if (machine) {
        // Written where the session's store is, on the unit ids its panes show.
        state.status = `adding the comment on ${machine}…`;
        schedulePaint();
        void backend!.run(['comment', 'add', '--session', state.session, '--edit', String(id), ...(lineNo ? ['--line', String(lineNo)] : []), '--text=' + text, '--json'], machine).then((out) => {
          let added: { id?: unknown } | null = null;
          try {
            added = JSON.parse(out) as { id?: unknown };
          } catch {
            /* not JSON: the CLI's own words, below */
          }
          state.status = added?.id
            ? `comment added on #${id}${lineNo ? ` line ${lineNo}` : ''} on ${machine} · :send-comments drafts them`
            : out.trim().split('\n')[0].replace(/^oak: /, '') || `no pending edit #${id} to comment on`;
          schedulePaint();
        });
        return;
      }
      const added = core.addComment(state.session, { unit: id, line: lineNo, text });
      state.status = added
        ? `comment added on #${id}${lineNo ? ` line ${lineNo}` : ''} · ${core.pendingCommentCount(state.session)} pending · :send-comments drafts them`
        : `no pending edit #${id} to comment on`;
      return schedulePaint();
    }
    if (['quote', 'send-comments', 'comments'].includes(name)) {
      const session = state.session;
      /** Into the session's reply composer, never sent from here; `ids` are the comments it carries. */
      const draftReply = (text: string, ids: string[] | null): void => {
        openConversation(session);
        const paneId = leafPanes(tabs[active].root!).find(p => p.view === 'session-detail' && state.observatory?.details[p.id]?.selection.session === session)?.id;
        const reply = paneId ? observatoryReply(state, paneId) : null;
        if (!paneId || reply?.reason) { copyText(text, 'Draft copied — no available live pane'); return schedulePaint(); }
        const detail = state.observatory!.details[paneId];
        const draft = [detail.reply?.text, text].filter(Boolean).join('\n\n');
        observatory?.editReply(paneId, draft);
        if (ids) {
          const current = state.observatory!.details[paneId];
          state.observatory!.details[paneId] = { ...current, reply: { ...current.reply!, commentIds: [...new Set([...(current.reply?.commentIds ?? []), ...ids])] } };
        }
        tabs[active].treeFocus = paneId;
        state.status = 'Draft ready — edit it, then Enter sends';
        return schedulePaint();
      };
      const machine = reviewMachine(session);
      if (machine) {
        // The comments and the transcript are where the session is; so is the composition.
        state.status = `reading ${name === 'quote' ? 'the last reply' : 'the unsent review comments'} on ${machine}…`;
        schedulePaint();
        const where = observatorySelection(state, session).root;
        const argv = name === 'quote' ? ['quote', '--session', session, '--json']
          : ['comment', 'compose', '--session', session, '--json', ...(where ? ['--cwd', where] : [])];
        void backend!.run(argv, machine).then((out) => {
          if (state.session !== session || reviewMachine(session) !== machine) return;
          let j: { text?: unknown; ids?: unknown } | null = null;
          try {
            j = JSON.parse(out) as { text?: unknown; ids?: unknown };
          } catch {
            /* not JSON: the CLI's own words, below */
          }
          const text = typeof j?.text === 'string' ? j.text : '';
          if (!j || !text) {
            state.status = (!j && out.trim().split('\n')[0].replace(/^oak: /, '')) || (name === 'quote' ? 'Nothing to quote' : 'No unsent review comments');
            return schedulePaint();
          }
          draftReply(text, name === 'quote' ? null : Array.isArray(j.ids) ? j.ids.map(String) : []);
        });
        return;
      }
      const batch = name === 'quote' ? null : core.composeCommentPrompt(session, { cwd: sessionRoot() ?? cwd });
      const text = name === 'quote' ? core.quoteAgentOutput(session) : batch?.text;
      if (!text) { state.status = name === 'quote' ? 'Nothing to quote' : 'No unsent review comments'; return schedulePaint(); }
      return draftReply(text, batch ? batch.ids : null);
    }
    // hasOwn, not a bare index: COMMANDS is an object literal, so `:constructor`, `:toString` and
    // `:valueOf` all found something truthy on the prototype, walked past the refusal below, and threw
    // `cmd.args is not a function` out of the key handler.
    const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!cmd) {
      // Names the alternatives rather than only refusing — a prompt that says "no" and stops is a
      // prompt nobody uses twice.
      state.status = `no command “${name}” — try: ${Object.keys(COMMANDS).join(', ')}`;
      return schedulePaint();
    }
    // `rest` is deliberately DROPPED, not forwarded — see COMMANDS. Say so rather than ignoring it
    // silently, or `:store --move /tmp/x` looks like it worked.
    state.status = rest.length ? `${name} takes no arguments here — running the plain form…` : `running ${name}…`;
    schedulePaint();
    void backend!.run(cmd.args()).then((out) => {
      const first = out.trim().split('\n').filter(Boolean);
      state.status = first.length ? first[0].replace(/\x1b\[[0-9;]*m/g, '') : `${name}: nothing to report`;
      // The full answer goes to the overlay, because a status row is one line and these verbs answer
      // in paragraphs. Same overlay the help uses, so esc closes it the way esc closes everything.
      if (first.length > 1) {
        state.overlay = {
          title: `${name}  —  esc to close`,
          lines: out.split('\n').map((l) => '  ' + l.replace(/\x1b\[[0-9;]*m/g, '')),
          scroll: 0,
        };
      }
      ask();
      schedulePaint();
    });
  }

  function move(delta: number): void {
    if (!state.overlay && tabs[active]?.root) {
      // A tree tab has no dock cursor; the arrows / j·k scroll the focused pane instead.
      return treeScrollBy(tabs[active].treeFocus ?? '', delta < 0 ? -1 : 1);
    }
    if (state.overlay) {
      const o = state.overlay;
      if (o.cursor !== undefined) {
        // A picker moves its SELECTION, and the view follows it — scrolling a list you are choosing
        // from without moving the choice is the classic picker bug.
        const cur = Math.min(o.lines.length - 1, Math.max(0, o.cursor + delta));
        const view = Math.max(0, frameRows - 6);
        const scroll = cur < o.scroll ? cur : cur >= o.scroll + view ? cur - view + 1 : o.scroll;
        state.overlay = { ...o, cursor: cur, scroll };
      } else {
        // rows-6: the overlay viewport shrank with the three-line chrome — the old rows-5 clamp
        // left the last line of every scrolled overlay unreachable.
        const max = Math.max(0, o.lines.length - (frameRows - 6));
        state.overlay = { ...o, scroll: Math.min(max, Math.max(0, o.scroll + delta)) };
      }
      return schedulePaint();
    }
    // Detail's diff SCROLLS. It has no rows to step between — `paneRowCount` reports visual lines
    // here — so a delta moves the viewport and the cursor stays put.
    const sc = scrollerBox();
    if (sc) {
      const max = Math.max(0, paneRowCount(state, sc) - sc.body.h);
      state.scroll = Math.min(max, Math.max(0, state.scroll + delta));
      syncPane();
      return schedulePaint();
    }
    // Past the scroller branch, a move changes the SELECTION rather than scrolling the diff — so the
    // patch a standing find ran over is about to stop being the one on screen. (Above it is the Diff
    // face scrolling, which is exactly when the find must survive: that is what n/p repeat.)
    clearFind();
    // The FOCUSED pane's own rows, resolved through `paneScreenOf` — not `state.screen`, which lags
    // behind focus and cannot represent Detail's faces at all. Stepping the map's cursor over the
    // EDIT list's rows skipped every entry whose counterpart there was a continuation line, and ran
    // the cursor off the end of a much shorter list until it vanished.
    const rows = rowsOf();
    if (state.panes?.focus === 'traces') picked = true; // moving the edit cursor IS choosing one
    const step = delta === 0 ? 0 : delta > 0 ? 1 : -1;
    // What arrows STEP: in the Review list the edits are the targets and file headers are furniture
    // (edit rows carry key `e<id>` and are the `cont` ones — the old skip-cont rule walked HEADERS
    // and skipped every edit, the exact inversion of reviewing). Elsewhere continuation lines skip.
    const box = state.panes ? layout().boxes.find((b) => b.id === state.panes!.focus) : null;
    const editsList = (box ? paneScreenOf(state, box) : state.screen) === 'edits';
    const skip = (r?: { cont?: boolean; key?: string; openPath?: string }): boolean =>
      // …and the cancelled-out footer, which is a target too: it advertises `a` to dismiss, so a
      // cursor that could never land on it would be advertising a key the reader cannot press.
      // A FOLDED file header is a target for the same reason — it is the only row its file has, and
      // space/enter on it is how the file opens. An OPEN header goes back to being furniture: its
      // edits are on screen and they are what review steps between. ONE stop per folded file: the
      // header's counts line shares its key prefix and openPath but is `cont`, and without the cont
      // guard the cursor visited every folded file twice — and a mark aimed at "the next edit"
      // landed on the counts row, whose ids are the whole file, and was refused.
      editsList
        ? !(
            r?.key?.startsWith('e') ||
            r?.key === 'cancelled' ||
            (r?.key?.startsWith('f') && r?.openPath !== undefined && !state.open.has(r.openPath) && !r?.cont)
          )
        : !!r?.cont;
    let next = state.cursor + delta;
    while (rows[next] && skip(rows[next])) next += step;
    if (next < 0) next = 0;
    if (next >= rows.length) next = Math.max(0, rows.length - 1);
    while (next > 0 && skip(rows[next])) next--;
    while (next < rows.length - 1 && skip(rows[next])) next++;
    state.cursor = next;
    clampCursor();
    syncPane();
    syncDetailDiff();
    schedulePaint();
  }

  /** All quit gestures use the same confirmation window and terminal cleanup. */
  function requestQuit(chord: string): void {
    if (quitArmedUntil > Date.now()) {
      restore();
      return process.exit(0);
    }
    quitArmedUntil = Date.now() + 2000;
    state.status = `press ${chord} again to exit`;
    schedulePaint();
  }

  /** A leader command — the key pressed after ctrl+a. Tab ops work on any tab; pane ops need a tree. */
  function leaderCommand(ev: { key: string; ctrl: boolean; alt: boolean; shift?: boolean }): void {
    if (ev.key === 'escape') {
      state.status = 'ready';
      return schedulePaint();
    }
    // ctrl+a twice sends one ctrl+a to the program in a native tab, as herdr, tmux and screen do with their
    // prefix: Claude Code and Codex both use it for line start.
    if (ev.ctrl && !ev.alt && ev.key === 'a') {
      const t = tabs[active];
      const s = t?.kind === 'native' ? nativeSessions.get(t.id) : undefined;
      if (s && !s.ended) s.write(Buffer.from('\x01'));
      state.status = 'ready';
      return schedulePaint();
    }
    // A command is a plain key. `ctrl+a ctrl+k` is readline's "line start, then kill the line", and it
    // killed the herdr client.
    if (ev.ctrl || ev.alt) {
      state.status = tabs[active]?.kind === 'native' ? 'ctrl+a takes a plain key next · ctrl+a ctrl+a sends ctrl+a to the program' : 'ctrl+a takes a plain key next';
      return schedulePaint();
    }
    if (ev.key === 'q') return requestQuit('ctrl+a q');
    if (ev.key === 'n') return switchTab((active + 1) % tabs.length);
    if (ev.key === 'p') return switchTab((active - 1 + tabs.length) % tabs.length);
    if (ev.key === 'o' && tabs[active]?.id === 'herdr') {
      void observatory?.current().then(selection => pinSession(selection.session, selection.machineId))
        .catch(error => { state.status = String(error.message || error); schedulePaint(); });
      return;
    }
    if (/^[1-9]$/.test(ev.key)) {
      const i = Number(ev.key) - 1;
      if (i < tabs.length) return switchTab(i);
      state.status = `no tab ${ev.key} — ${tabs.length} open`;
      return schedulePaint();
    }
    if (ev.key === 'k') {

      // (quitting oak, switching away, closing the window: all of those merely detach).
      const t = tabs[active];
      if (!t || t.kind !== 'native') {
        state.status = 'ctrl+a k kills the program in a native tab';
        return schedulePaint();
      }
      const s = nativeSessions.get(t.id);
      if (s) s.close();
      else closeNativeTab(t.id);
      state.status = `killed ${t.name ?? 'the program'}`;
      return schedulePaint();
    }
    const tab = tabs[active];
    if (!tab?.root) {
      state.status = 'pane ops need a tree tab (observatory)';
      return schedulePaint();
    }
    const focus = tab.treeFocus ?? firstLeafId(tab.root);
    if (ev.key === 'z') {
      tab.treeZoom = tab.treeZoom === focus ? null : focus;
      state.status = tab.treeZoom ? 'zoomed — ctrl+a z restores' : 'ready';
      return schedulePaint();
    }
    if (ev.key === 'tab') return cycleTreeFocus(tab);
    if (ev.key === 'x') {
      if (paneCount(tab.root) <= 1) {
        state.status = 'cannot close the last pane';
        return schedulePaint();
      }
      tab.root = closePane(tab.root, focus);
      if (state.observatory?.details[focus]) {
        const details = { ...state.observatory.details };
        delete details[focus];
        state.observatory = { ...state.observatory, details };
      }
      tab.treeFocus = firstLeafId(tab.root);
      tab.treeZoom = null;
      state.status = 'pane closed';
      ask();
      return schedulePaint();
    }
    if (ev.key === '|' || ev.key === '-') {
      // A split starts with its own unpinned conversation header; Enter gives it an independent pin.
      const newId = `split-${nextSplitId++}`;
      tab.root = splitPane(tab.root, focus, ev.key === '|' ? 'h' : 'v', newId, 'session-detail');
      tab.treeFocus = newId;
      tab.treeZoom = null;
      state.status = 'pane split — ctrl+a x closes it · ctrl+a v changes what it shows';
      ask();
      return openViewPicker(newId);
    }
    if (ev.key === 'v') return openViewPicker(focus);
    if (ev.key === 'H' || ev.key === 'J' || ev.key === 'K' || ev.key === 'L') {
      // Move the focused pane by keyboard: swap it with the neighbour that way —
      // the same tree op the title drag's middle-drop applies.
      const dir = ev.key === 'H' ? 'left' : ev.key === 'L' ? 'right' : ev.key === 'K' ? 'up' : 'down';
      const nb = neighbourPane(tab.root, focus, dir);
      if (!nb) {
        state.status = `no pane ${dir === 'up' ? 'above' : dir === 'down' ? 'below' : `to the ${dir}`}`;
        return schedulePaint();
      }
      tab.root = swapPanes(tab.root, focus, nb);
      tab.treeZoom = null;
      saveLayout();
      state.status = 'panes swapped';
      return schedulePaint();
    }
    state.status = 'ready';
    return schedulePaint();
  }

  function focusedReplyPane(): string | undefined {
    const tab = tabs[active];
    if (tab?.id !== 'observatory' || state.overlay || state.confirm || filterOpen || cmdOpen || diffFindOpen) return;
    const pane = leafPanes(tab.root!).find(p => p.id === tab.treeFocus && p.view === 'session-detail');
    return pane && state.observatory?.details[pane.id]?.reply?.focused ? pane.id : undefined;
  }

  function replyKey(paneId: string, ev: { key: string; ctrl: boolean; alt: boolean }): void {
    if (ev.key === 'escape') { observatory?.focusReply(paneId, false); return; }
    if (ev.ctrl && ev.key === 'v') { pasteFromClipboard(); return; }
    if (ev.key === 'enter') {
      void observatory?.sendReply(paneId);
      // Follow the bubble immediately; rendering and clicks clamp to the same transcript height.
      newestConversation(paneId);
      return;
    }
    const { detail, reason } = observatoryReply(state, paneId);
    if (reason || !detail?.reply) return;
    let { text, caret } = detail.reply;
    const before = Array.from(text.slice(0, caret));
    const after = Array.from(text.slice(caret));
    const left = before.at(-1)?.length || 0;
    const right = after[0]?.length || 0;
    if (ev.key === 'left' && !ev.alt) caret -= left;
    else if (ev.key === 'right' && !ev.alt) caret += right;
    else if (ev.key === 'home' || (ev.ctrl && ev.key === 'a')) caret = 0;
    else if (ev.key === 'end' || (ev.ctrl && ev.key === 'e')) caret = text.length;
    else if (ev.key === 'backspace') { text = text.slice(0, caret - left) + text.slice(caret); caret -= left; }
    else if (ev.key === 'delete') text = text.slice(0, caret) + text.slice(caret + right);
    else if (!ev.ctrl && !ev.alt && Array.from(ev.key).length === 1) {
      text = text.slice(0, caret) + ev.key + text.slice(caret); caret += ev.key.length;
    } else return;
    observatory?.editReply(paneId, text, caret);
  }

  /**
   * May an AUTO-REPEAT of this key act? A kitty repeat (CSI-u `:2`) says the key is still down, not
   * that it was pressed again — and this keymap binds single letters to commands and mutations, so a
   * held key must act ONCE. Movement keys and the text-edit keys are the ones a reader deliberately
   * holds, the typing walls want every character they can get, and `j`/`k` count as movement only
   * while they carry no verb (bound, `k` keeps). Bytes bound for a native child never reach here:
   * `routeInput` writes them to the pty before these events are routed.
   */
  function repeatActs(ev: { key: string; ctrl: boolean; alt: boolean }): boolean {
    if (HELD_KEYS.has(ev.key)) return true;
    if (ev.ctrl || ev.alt) return false;
    if (filterOpen || cmdOpen || diffFindOpen || helpFilter !== null || options?.capture) return true;
    return (ev.key === 'j' || ev.key === 'k') && !keys().get(ev.key);
  }

  function onKey(ev: { key: string; ctrl: boolean; alt: boolean; shift?: boolean; event?: 'press' | 'repeat' | 'release' }): void {
    // ^C arrives as a NAMED key with `ctrl` set — `{key:'c'}` — never as the raw byte. A `case '\x04'`
    // in the verb switch was therefore dead. ^D used to be folded in here too and quit alongside it;
    // it is a pager key now (see the ctrl layer below), because in vim, less and everything that
    // borrows from them ^D is half-page-down, and quitting on it ended the review of whoever scrolled
    // a long diff the way they scroll everything else. ^C alone keeps the quit — that one is universal.
    const ch = ev.ctrl && ev.key === 'c' ? '\x03' : ev.key;
    const replyPane = focusedReplyPane();
    if (replyPane && ch !== '\x03' && !leaderArmed) return replyKey(replyPane, ev);
    if (ev.event === 'repeat' && !repeatActs(ev)) return;
    // The LEADER (ctrl+a): a tmux-style prefix for the full-BSP pane/tab ops. Armed = the next key is a
    // command; ^C still quits, esc always leaves. A MODE, shown in the status row — never a stuck one.
    if (leaderArmed && ch !== '\x03') {
      if (ev.event === 'repeat') return; // a held key is the same press, never the leader's command
      leaderArmed = false;
      return leaderCommand(ev);
    }
    // esc during a pane drag cancels it — the pane stays where it was.
    if (paneDrag && ev.key === 'escape') {
      paneDrag = null;
      setPointer('grab');
      state.status = 'move cancelled';
      return schedulePaint();
    }
    // ctrl+o: find anything. A fixed chord like the others, and never over another
    // overlay or a standing keep/undo.
    if (ev.ctrl && ev.key === 'o' && !state.confirm && !state.overlay) return openPalette();
    if (
      ev.ctrl && ev.key === 'a' && !state.confirm && !state.overlay
    ) {
      leaderArmed = true;
      state.status = `ctrl+a — |/- split · z zoom · x close · tab cycle · n/p·1-${tabs.length} tabs · q quit · ctrl+q ×2 quit · esc`;
      return schedulePaint();
    }
    // TAB SWITCHING IS GLOBAL, and sits above every screen's own handler: the tab bar is chrome that
    // every tab shows, so the key that moves between tabs cannot belong to one of them.
    //
    // `ctrl+n`/`ctrl+p` and `alt+<digit>` rather than the planned `ctrl+a` leader — those four
    // combinations are genuinely unbound here (only ^C ^F ^G ^X are taken), and a leader mode is a
    // mode a reader can get stuck in. The digits stay free of a bare binding because a bare digit
    // names an EDIT in this product, which is the thing a reviewer says out loud.
    if (!state.confirm && tabs.length > 1) {
      if (ev.ctrl && (ev.key === 'n' || ev.key === 'p')) {
        const d = ev.key === 'n' ? 1 : -1;
        return switchTab((active + d + tabs.length) % tabs.length);
      }
      if (ev.alt && /^[1-9]$/.test(ev.key)) {
        const i = Number(ev.key) - 1;
        // Out of range is a NO-OP with a reason, not a silent swallow: alt+7 on a three-tab frame
        // should say why nothing happened rather than look like a dropped keystroke.
        if (i < tabs.length) return switchTab(i);
        state.status = `no tab ${ev.key} — ${tabs.length} open`;
        return schedulePaint();
      }
    }
    // On a NATIVE tab, non-leader keys belong to the program (routed raw in the stdin handler). Once it
    // has EXITED they fall through to here instead — swallow them, or k/u/j would act on the dashboard
    // behind the dead grid. The leader (ctrl+a) and the tab-switches above still work.
    // An overlay painted OVER a native tab still owns the keyboard (switching
    // tabs with help/options open dead-locked every key — esc could not close, ^C could not arm,
    // and the pty was blocked by the overlay gate too).
    if (tabs[active]?.kind === 'native' && !state.overlay) return;
    // The filter picker is a typing-wall-style mode: while it is open it owns every key but ^C.
    if (ch !== '\x03' && filterMenuKey(ev)) return;
    // ^C with a SELECTION standing is the OS copy, never the quit. The drag already copied on release; this is the
    // chord muscle memory reaches for anyway. The selection is CONSUMED by the copy — a second ^C
    // is then the interrupt/quit it always was, so a stale highlight can never eat a real ^C twice.
    if (ch === '\x03' && state.selSpan) {
      const sp = state.selSpan;
      state.selSpan = null;
      copySpan(sp.a, sp.b, sp.clip);
      return;
    }
    // ^V is the OS paste: read the clipboard the same ladder the copy writes —
    // the tmux buffer inside tmux, the platform's own tools on a local terminal — and route it
    // exactly like a terminal paste (the reply box when it has focus, the filter when one is open).
    // Terminal-native paste (cmd+V / ctrl+shift+V → bracketed paste) works as before.
    if (ev.ctrl && ev.key === 'v') {
      pasteFromClipboard();
      return;
    }
    // Any key clears a kept selection — the clear never consumes the key itself.
    if (state.selSpan) {
      state.selSpan = null;
      schedulePaint();
    }

    // the filter first and disengages second; the overlay itself outlives both.
    // ^C is exempt like every other wall (the catch-all below swallowed it —
    // a filtered help overlay was the one mode where quit could not arm).
    if (ch !== '\x03' && state.overlay && helpFilter !== null) {
      if (ev.key === 'escape') {
        if (helpFilter) helpFilter = '';
        else helpFilter = null;
        return rerenderHelp();
      }
      if (ev.key === 'enter') {
        helpFilter = null;
        return rerenderHelp();
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        helpFilter = helpFilter.slice(0, -1);
        return rerenderHelp();
      }
      if (ev.key === 'up' || ev.key === 'down' || ev.key === 'pgup' || ev.key === 'pgdn') {
        return move(ev.key === 'down' ? 1 : ev.key === 'up' ? -1 : ev.key === 'pgdn' ? 10 : -10);
      }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        helpFilter += ev.key;
        return rerenderHelp();
      }
      return; // nothing else escapes while the filter types
    }
    // The jump key: a turn ended somewhere the reader was not looking — go there.
    if (ev.ctrl && ev.key === 'g' && jumpArmed) {
      // The Agent screen does not draw the dashboard's confirmations and swallows every key, so
      // jumping with one standing would strand it: invisible, unanswerable, and still live on the
      // way back. Same wall the session picker already stands behind.
      if (state.confirm) {
        state.status = 'answer the pending question first — y or n';
        return schedulePaint();
      }
      jumpArmed = false;
      state.toast = undefined;
      return openClaude();
    }
    // OBSERVATORY NAV: the arrow keys drive the whole tab. ↑/↓ move the session
    // SELECTION through the master (which drives the detail); when the detail holds focus they scroll it.
    // ←/→ move focus between the two panes. `d`/`↵` open the selected session's agent tab — its live feed
    // and prompt box (selection = `scopeWorker`, falling back to the reviewed session). Gated to the
    // observatory tab so these keys keep their meaning everywhere else.
    if (
      !state.overlay && !state.confirm && !filterOpen && !cmdOpen && !diffFindOpen && !ev.ctrl && !ev.alt &&
      tabs[active]?.id === 'observatory'
    ) {
      const focused = leafPanes(tabs[active].root!).find(p => p.id === tabs[active].treeFocus);
      const onMaster = focused?.view === 'sessions-nav';
      const fkey = /^f([1-9][0-9]*)$/.exec(ev.key);
      if (fkey) {
        const pane = leafPanes(tabs[active].root!)[Number(fkey[1]) - 1];
        if (pane) {
          const tab = tabs[active];
          if (tab.treeFocus === pane.id) tab.treeZoom = tab.treeZoom === pane.id ? null : pane.id;
          else { tab.treeFocus = pane.id; tab.treeZoom = null; }
          saveLayout(); schedulePaint();
        }
        return;
      }
      const detail = focused?.view === 'session-detail' ? state.observatory?.details[focused.id] : undefined;
      const selection = detail?.selection || state.scopeWorker;
      if (ev.key === 'i') {
        const pane = focused?.view === 'session-detail' ? focused : leafPanes(tabs[active].root!).find(p => p.view === 'session-detail');
        if (pane) { tabs[active].treeFocus = pane.id; observatory?.focusReply(pane.id); }
        else state.status = 'Pin a session to reply';
        return schedulePaint();
      }
      if (ev.key === 'h' && selection) { jumpHerdr(selection); return; }
      if (ev.key === 'end' && focused?.view === 'session-detail') return newestConversation(focused.id);
      if (ev.key === 'up' || ev.key === 'down' || ev.key === 'pgup' || ev.key === 'pgdn') {
        const step = ev.key === 'pgdn' ? 10 : ev.key === 'pgup' ? -10 : ev.key === 'down' ? 1 : -1;
        if (onMaster && (ev.key === 'up' || ev.key === 'down')) navObservatory(step as 1 | -1);
        else treeScrollBy(tabs[active].treeFocus ?? '', step);
        return;
      }
      if (ev.key === 'left') { tabs[active].treeFocus = 'obs-sessions'; return schedulePaint(); }
      if (ev.key === 'right') { tabs[active].treeFocus = 'obs-detail'; return schedulePaint(); }
      // With nothing selected these act on the reviewed session: the Review tab's, which the launch rule may
      // have moved to a saved machine while `state.session` stayed the launch session.
      const reviewed = (): string => tabs.find((t) => t.id === 'review')?.session || state.session;
      if (ev.key === 'd' || ev.key === 'enter') {
        if (state.scopeWorker?.session) openConversation(state.scopeWorker.session);
        else pinSession(reviewed(), reviewMachineId(reviewed()));
        return;
      }
      // The blob buttons from the keyboard: f feed · r review · a resolve · x kill — acting on the
      // SELECTED session (or the reviewed one when nothing is picked), the same as clicking them.
      if (ev.key === 'f' || ev.key === 'r' || ev.key === 'a' || ev.key === 'x') {
        const sc = selection;
        const session = sc?.session || reviewed();
        const label = sc?.label || session.slice(0, 8);
        const action = ev.key === 'f' ? 'feed' : ev.key === 'r' ? 'review' : ev.key === 'a' ? 'resolve' : 'kill';
        blobAction(action, session, label, sc || undefined);
        return;
      }
      // Shift+A changes retention, not identity. A pinned conversation survives the filter.
      if (ev.key === 'A') {
        state.allSessions = !state.allSessions;
        state.scopeWorker = null;
        state.status = state.allSessions ? 'show archived sessions' : 'hide archived · live panes and unresolved edits';
        return schedulePaint();
      }
    }
    // ^C still quits from inside the options window; everything else there belongs to it.
    if (ch !== '\x03' && optionsKey(ev)) return;
    // Escape and ^C are reachable from EVERY mode — including with a filter open, where the old
    // handler swallowed them as filter text and left no way out at all.
    if (ev.key === 'escape') {
      /**
       * THE TEXT WALLS COME FIRST, because this ladder RETURNS.
       *
       * Command mode and find-in-diff each have their own escape handler further down, and both were
       * unreachable whenever an earlier rung matched — which the last rung, "unselect", does as soon
       * as anything is selected. So with an edit picked, `:` followed by esc unselected the edit and
       * left the prompt OPEN, its status row overwritten by the unselect message, so nothing on
       * screen said the next letters were still going into a command instead of running as keys.
       *
       * It looked fine from a test that opened the prompt without selecting anything first: with
       * nothing picked the ladder falls off the end and reaches the wall's own handler.
       *
       * A standing question comes before all of them: esc is its "no" (the
       * first esc under "stop the running agent?" cleared the selection and left the question up).
       */
      if (state.confirm) return answerConfirm(false);
      if (cmdOpen) {
        cmdOpen = false;
        state.status = 'ready';
        return schedulePaint();
      }
      if (diffFindOpen) {
        diffFindOpen = false;
        clearFind(); // esc means "done searching", so n/p go back to stepping the review
        state.status = 'ready';
        return schedulePaint();
      }
      if (closeOverlay()) return;
      // A zoom is a mode, and esc is how every mode here ends. Without this the reader who opened an
      // edit full screen had to remember which key had zoomed it.
      if (state.panes?.zoom) {
        state.panes = { ...state.panes, zoom: null };
        state.status = 'ready';
        ask();
        return schedulePaint();
      }
      if (state.goto !== null && state.goto !== undefined) {
        state.goto = null;
        return schedulePaint();
      }
      // Only a TREE tab (observatory) clears the scope on esc — otherwise a scope left set from
      // observatory would swallow esc on Review before its own actions (promptScope, etc.).
      if (state.scopeWorker && tabs[active]?.root) {
        state.scopeWorker = null; // the panes widen back to the terminal's own session
        state.status = 'showing every worker again';
        ask(true);
        return schedulePaint();
      }
      if (state.promptScope) {
        state.promptScope = null; // the Edits list widens back to the whole session
        state.cursor = 0;
        state.scroll = 0;
        state.status = 'showing every edit again';
        clampCursor();
        return schedulePaint();
      }
      if (state.marked?.size) {
        state.marked = new Set<number>();
        state.status = 'marks cleared';
        return schedulePaint();
      }
      if (filterOpen) {
        filterOpen = false;
        state.filterOpen = false;
        state.filter = '';
        clampCursor();
        syncPane();
        return schedulePaint();
      }
      // Last rung: with no mode left to leave, esc UNSELECTS. (The old face-drop half of this rung
      // is gone with `startFace`: Map and Diff are both always on screen, so with a stale
      // `tab.detail` in prefs this rung used to fire "nothing selected" on the FIRST esc even with
      // nothing to clear.)
      if (picked) {
        picked = false;
        // Both halves of "nothing is selected", together: `diffWanted` is what syncDetailDiff
        // compares against, so leaving it on the old id would make the next sync a no-op and strand
        // the patch on screen.
        diffWanted = -1;
        state.diffPatch = undefined;
        state.diffMeta = undefined;
        state.status = 'nothing selected';
        return schedulePaint();
      }
    }
    if (ch === '\x03') return requestQuit('ctrl+c');

    // ------------------------------------------------------------------------------------------
    // MODAL GATES. Both of these swallow every key they do not themselves consume, and they come
    // BEFORE the jump table and the verb switch. This keymap binds single letters to destructive
    // verbs — `u` surgically reverts a file on disk — so any mode that reads text must be a wall,
    // not a filter. Falling through was the defect: typing "readme" after `/` ran r(efresh),
    // a(keep) and m(inimize), and a(keep) actually mutated the store.
    // ------------------------------------------------------------------------------------------

    // A pending confirmation owns the keyboard until it is answered. Enter must NOT fall through to
    // openSelected, or a diff opens underneath the prompt while the question is still on screen.
    if (state.confirm) {
      if (ch === 'y' || ch === 'Y') return answerConfirm(true);
      if (ch === 'n' || ch === 'N' || ch === 'q') return answerConfirm(false);
      return; // everything else is swallowed while the question stands
    }

    // The Claude-launch question is a wall like the others: it owns the keyboard until answered, it
    // was visible the moment it opened (the status row asked it), and every key it ADVERTISES is
    // bound — the A/U prompt once rendered [y/n] with neither key handled, and this class of wall is
    // how that stays fixed. Any other key cancels: the safe default for a question about opening a
    // second writer on a live transcript.
    if (claudeAsk) {
      claudeAsk = null;
      if (ev.key === 'r') return launchClaude(false);
      if (ev.key === 'f') return launchClaude(true);
      state.status = 'ready';
      return schedulePaint();
    }

    // `r` on the focused Claude pane: the native `claude --resume` terminal handover. Only for
    // hook-observed Claude sessions, the ones with a Claude CLI transcript to resume.
    if (ev.key === 'r' && !ev.ctrl && !ev.alt && state.panes?.focus === 'claude') {
      return openClaudeNative();
    }

    // A pending mark letter is a one-key wall, for the same reason the others are: the very next key
    // is a NAME, and letting it fall through would run `a` (keep) as the name of a mark.
    if (markPending) {
      const mode = markPending;
      markPending = null;
      if (ev.key === 'escape' || ev.key.length !== 1 || ev.ctrl || ev.alt) {
        state.status = 'ready';
        return schedulePaint();
      }
      const name = ev.key;
      if (mode === 'set') {
        const row = rowsOf()[state.cursor];
        const id = row?.ids.length === 1 ? row.ids[0] : undefined;
        if (id === undefined) {
          state.status = `mark ‘${name}’ needs a single edit — a file header stands for all of its edits`;
          return schedulePaint();
        }
        marks.set(name, id);
        state.status = `mark ‘${name}’ set on edit #${id}`;
        return schedulePaint();
      }
      const want = marks.get(name);
      if (want === undefined) {
        state.status = `no mark ‘${name}’ — set one with ’${name} first`;
        return schedulePaint();
      }
      // Through revealEdit: the marked edit may be inside a folded group (the default now), and a
      // jump the reader asked for is what opening that fold means.
      const at = revealEdit(want);
      if (at < 0) {
        state.status = `mark ‘${name}’ is on edit #${want}, which this window is not showing`;
        return schedulePaint();
      }
      focusPane('traces');
      state.cursor = at;
      picked = true;
      clampCursor();
      syncPane();
      syncDetailDiff();
      state.status = `mark ‘${name}’ — edit #${want}`;
      return schedulePaint();
    }

    // Find-in-diff is a wall too, for the same reason.
    if (diffFindOpen) {
      if (ev.key === 'escape') {
        diffFindOpen = false;
        clearFind(); // esc means "done searching", so n/p go back to stepping the review
        state.status = 'ready';
        return schedulePaint();
      }
      if (ev.key === 'enter') {
        diffFindOpen = false;
        return jumpToMatch(diffFind.trim(), 1);
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        diffFind = diffFind.slice(0, -1);
        state.status = `find in diff: ${diffFind}`;
        return schedulePaint();
      }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        diffFind += ev.key;
        state.status = `find in diff: ${diffFind}`;
        return schedulePaint();
      }
      return;
    }

    // Command mode is a WALL, like the filter and the confirmation: it reads one line and nothing
    // escapes into the verb switch, which in this app binds single letters to actions that revert
    // files.
    if (cmdOpen) {
      if (ev.key === 'escape') {
        cmdOpen = false;
        state.status = 'ready';
        return schedulePaint();
      }
      if (ev.key === 'enter') {
        cmdOpen = false;
        return runCommand(cmdBuf.trim());
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        cmdBuf = cmdBuf.slice(0, -1);
        state.status = `: ${cmdBuf}`;
        return schedulePaint();
      }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        cmdBuf += ev.key;
        state.status = `: ${cmdBuf}`;
        return schedulePaint();
      }
      return;
    }

    // An open filter consumes typing. Escape (handled above) clears and closes it; Enter keeps the
    // filter and hands the keyboard back so the reader can act on what they narrowed to.
    if (filterOpen) {
      if (ev.key === 'enter') {
        filterOpen = false;
        state.filterOpen = false;
        return schedulePaint();
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        state.filter = state.filter.slice(0, -1);
        clampCursor();
        syncPane();
        return schedulePaint();
      }
      // Printable, unmodified keys only — a stray ctrl/alt chord must not become filter text.
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        state.filter += ev.key;
        clampCursor();
        syncPane();
        return schedulePaint();
      }
      return; // and nothing else escapes into the verb switch
    }

    // The session picker TYPES. It is a wall like the filter and the options capture: this keymap
    // binds single letters to verbs that revert files, so a mode that reads text must consume every
    // key it does not itself act on rather than letting `s` or `u` fall through to the switch.
    if (state.overlay && pickerFilter !== null) {
      if (ev.key === 'tab') {
        const order = ['all', 'working', 'done', 'idle'] as const;
        pickerState = order[(order.indexOf(pickerState) + 1) % order.length];
        return renderSessionPicker();
      }
      if (ev.key === 'enter') return choosePicked();
      if (ev.key === 'escape') { pickerFilter = null; return void closeOverlay(); }
      if (ev.key === 'up' || ev.key === 'down' || ev.key === 'pgup' || ev.key === 'pgdn') {
        return move(ev.key === 'down' ? 1 : ev.key === 'up' ? -1 : ev.key === 'pgdn' ? 10 : -10);
      }
      // ^D deletes the highlighted session. A control combo, not a letter: this picker TYPES, so a bare
      // `d` belongs to the filter — a delete key that ate `d` could never filter for "docs". It raises a
      // confirm that then owns the keyboard (the confirm wall above this one), so nothing here fires
      // until it is answered.
      if (ev.ctrl && ev.key === 'd') return requestDeleteSession();
      if (ev.key === 'backspace' || ev.key === 'delete') {
        pickerFilter = pickerFilter.slice(0, -1);
        return renderSessionPicker();
      }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        pickerFilter += ev.key;
        return renderSessionPicker();
      }
      return; // nothing else escapes while the picker is open
    }
    if (state.overlay) {
      if (helpShowing() && ev.key === '/') {
        // A searchable keymap (adopted from herdr): the overlay is generated from the LIVE
        // bindings, and past a screenful a reader finds a key by typing, not scrolling.
        helpFilter = '';
        return void rerenderHelp();
      }
      if (ev.key === 'enter' && state.overlay.cursor !== undefined) {
        if (chooseOverlayAction()) return;
        return choosePicked();
      }
      const plain = !ev.ctrl && !ev.alt;
      // The row menu prints each row's key, and pressing it chooses that row, as Enter does, even
      // a key that would otherwise scroll or close, which a rebind can make it.
      if (rowMenu && plain && state.overlay.title === ROW_MENU_TITLE && rowMenu.includes(ch)) {
        rowMenu = null;
        state.overlay = null;
        return onKey({ key: ch, ctrl: false, alt: false });
      }
      // `?` toggles: the key that opened the help closes it. Only `q`/enter closing it meant the
      // advertised key appeared to do nothing on the second press.
      if (ch === 'q' || ch === '?' || ev.key === 'enter') return void closeOverlay();
      // Every other key is the overlay's too: the keys that scroll it do so here, and none reaches a verb
      // behind it (with the help open, `u` reverted an edit, and so did
      // a verb rebound to j, k, g or G). ctrl+z still suspends.
      const step = ev.key === 'up' || (plain && ch === 'k') ? -1 : ev.key === 'down' || (plain && ch === 'j') ? 1
        : ev.key === 'pgup' || (ev.ctrl && ev.key === 'b') ? -10 : ev.key === 'pgdn' || (ev.ctrl && ev.key === 'f') ? 10
        : ev.ctrl && ev.key === 'u' ? -5 : ev.ctrl && ev.key === 'd' ? 5
        : ev.key === 'home' || (plain && ch === 'g') ? -1e9 : ev.key === 'end' || (plain && ch === 'G') ? 1e9 : 0;
      if (step) return move(step);
      if (!(ev.ctrl && ev.key === 'z')) return;
    }
    // F1..F5 are the window bar, left to right. Detail answers to two of them, one per face, so F3
    // means "the map" and F4 means "this diff" rather than "the centre, and then find the swap".
    // Pressing the key for what is ALREADY showing zooms it, and again puts it back — the same
    // second-press-drills-in gesture the edit list uses, so full screen costs no new key and no timer.
    // ONE exception, documented on BAR_ENTRIES: the Claude strip has nothing to zoom into, so its
    // second press LAUNCHES Claude — the drill-in, applied to the pane whose drill-in is the agent.
    const fkey = BAR_ENTRIES.find((e) => ev.key === `f${e.key}`);
    if (fkey) {
      // A pane this tab hides has no window here (review has no Agent/Dashboards) — its F-key says so
      // rather than silently opening a pane the workspace deliberately dropped.
      if (state.panes!.hidden?.has(fkey.pane)) {
        state.status = `this workspace has no ${fkey.title}`;
        return schedulePaint();
      }
      const showing = state.panes!.focus === fkey.pane;
      if (showing && !state.overlay) {
        if (fkey.pane === 'claude') return openClaude();
        return toggleZoom(fkey.pane);
      }

      return focusPane(fkey.pane);
    }
    // Digits name an EDIT, not a window. They accumulate, because ids run well past 9, and the
    // number is shown before Enter commits to it — this moves the selection that `u` reverts.
    if (!state.overlay && /^[0-9]$/.test(ch)) {
      state.goto = (state.goto ?? '') + ch;
      return schedulePaint();
    }
    if (state.goto !== null && state.goto !== undefined) {
      if (ev.key === 'enter') return gotoEdit();
      if (ev.key === 'backspace' || ev.key === 'delete') {
        const next = state.goto.slice(0, -1);
        state.goto = next.length ? next : null;
        return schedulePaint();
      }
      // Any other key abandons the number and is then handled normally: a half-typed id that silently
      // swallowed the next verb would be a mode with no exit.
      state.goto = null;
    }
    // Arrows. The decoder has always emitted these and the README has always documented them; the
    // switch below only ever matched `j`/`k`, so every arrow key silently did nothing.
    if (ev.key === 'down') return move(1);
    if (ev.key === 'up') return move(-1);
    // `pgdn`/`pgup` — the decoder's own names (tui/input.ts CSI_TILDE). Spelled `pagedown`/`pageup`
    // here, these were the fourth and fifth keys bound to a string the decoder never emits.
    if (ev.key === 'pgdn') return move(10);
    if (ev.key === 'pgup') return move(-10);
    if (ev.key === 'right' || ev.key === 'left') {
      const f = state.panes?.focus;
      // PANNING takes the arrows while it is on, because that is the whole of what `w` offers: long
      // lines kept long and reached by moving sideways. Swapping the face here instead would leave the
      // mode with no way to see the right-hand end of a line, which is truncation with extra steps.
      if (f === 'detail' && state.noWrap) {
        const step = Math.max(1, Math.floor(frameCols / 4));
        const next = (state.panX ?? 0) + (ev.key === 'right' ? step : -step);
        // Clamped at 0 and at the widest line: past the end there is nothing to show, and a pan that
        // ran off into blank columns would look exactly like a diff that had lost its content.
        const widest = (state.diffPatch ?? '').split('\n').reduce((w, l) => Math.max(w, l.length), 0);
        state.panX = Math.max(0, Math.min(next, Math.max(0, widest - 8)));
        state.status = state.panX ? `panned ${state.panX} columns — ←→ to pan, w to wrap` : 'at the left edge';
        return schedulePaint();
      }
      if (f) {
        const tabs = PANE_SPECS.find((x) => x.id === f)!.tabs;
        if (tabs.length) {
          const at = state.panes!.tab[f] ?? 0;
          const next = (at + (ev.key === 'right' ? 1 : tabs.length - 1)) % tabs.length;
          state.panes = { ...state.panes!, tab: { ...state.panes!.tab, [f]: next } };
          state.cursor = 0;
          state.scroll = 0;
          const sc = paneScreen(f);
          if (sc !== 'diff') state.screen = sc as typeof state.screen;
          ask();
          return schedulePaint();
        }
      }
      return;
    }
    /**
     * CTRL CHORDS ARE THEIR OWN LAYER, and nothing falls out of it.
     *
     * This sits here, below every wall, so a chord acts only when no confirmation, filter, find or
     * command prompt is standing — the walls above already refuse to take a ctrl chord as text, and
     * before this they then let it drop straight through to the verb switch. Which was the bug: the
     * switch dispatches on `keys().get(ch)` where `ch` is the BARE letter, so every unbound chord ran
     * its plain key's verb. ^U reverted an edit, ^A kept one, ^E handed the terminal to $EDITOR, ^Y
     * copied and ^Q quit — ^U in particular being the kill-line reflex of every terminal there is.
     *
     * The paging set is vim's and every pager's: ^D/^U half, ^F/^B whole (a "page" is the ten rows
     * PgDn/PgUp already move, so ^F and PgDn agree). ^R is vim's redo. Anything else is SWALLOWED by
     * the return at the end, which is the whole point — an unbound chord must do nothing, not
     * something.
     */
    if (ev.ctrl) {
      if (ev.key === 'd') return move(5);
      if (ev.key === 'u') return move(-5);
      if (ev.key === 'f') return move(10);
      if (ev.key === 'b') return move(-10);
      if (ev.key === 'r') return mutateScope('redo', 'one');
      /**
       * ^Z — JOB CONTROL, which every terminal app is expected to honour and this one owns the whole
       * screen of. Raw mode means the driver never turns this into a signal for us, so it arrives as a
       * key and we raise it ourselves.
       *
       * The terminal has to be handed back FIRST — alternate screen off, raw mode off, mouse reporting
       * off — or the shell the reader lands in is drawing into our alternate buffer with echo disabled,
       * which looks exactly like a hung terminal. That is the same handover `e` already does for
       * $EDITOR, so it is the same pair of functions; the only new part is re-entering on SIGCONT,
       * which fires when the reader types `fg`.
       */
      if (ev.key === 'z') {
        suspendTerminal();
        process.once('SIGCONT', () => resumeTerminal());
        process.kill(process.pid, 'SIGTSTP');
        return;
      }
      return;
    }
    // An alt chord is never its plain letter's verb, the same rule as the ctrl layer above
    // (alt+u, or esc and u typed quickly, reverted an edit). alt+digit switched tabs above.
    if (ev.alt) return;
    // Verbs dispatch on the ACTION a key is bound to, not on the key itself — that indirection is
    // what makes the options window's rebinds real rather than a list of numbers it saves and nothing
    // reads. Structural keys (F1-F6, arrows, Tab, Enter, Esc, Space, digits) are handled above and are
    // deliberately not rebindable: several of them are the only way out of a mode.
    const verb = keys().get(ch) ?? null;
    switch (verb ?? ch) {
      // VIM MOVEMENT, bound but deliberately NOT advertised. The key row promises arrows, because
      // that is what a reader who has never used vi will try — but every tool in this class binds
      // j/k, and a vim user pressing them into a dead keymap concludes the app is broken. Both work;
      // only one is taught.
      case ':': {

        cmdBuf = '';
        cmdOpen = true;
        state.status = ': ';
        return schedulePaint();
      }
      /**
       * MARK / UNMARK the row under the cursor, for acting on several at once.
       *
       * The review workflow this app is for is "read six files, then accept them together", and until
       * now that meant six keeps and six confirmations. A file HEADER marks every edit in its file,
       * which is the same rule `a` on a header already follows — the mark set is ids, so the two
       * cannot disagree about what a row stands for.
       */
      case 'mark': {
        const row = rowsOf()[state.cursor];
        if (!row?.ids.length) {
          state.status = 'nothing to mark on this row';
          return schedulePaint();
        }
        const marked = new Set(state.marked ?? []);
        const already = row.ids.every((id) => marked.has(id));
        for (const id of row.ids) (already ? marked.delete(id) : marked.add(id));
        state.marked = marked;
        state.status = marked.size
          ? `${marked.size} edit(s) marked — a/u act on all of them, esc clears`
          : 'nothing marked';
        return schedulePaint();
      }
      case "'":
        markPending = 'set';
        state.status = "set mark: press a letter (esc cancels)";
        return schedulePaint();
      case '`':
        markPending = 'jump';
        state.status = marks.size
          ? `go to mark: ${[...marks.keys()].sort().join(' ')} (esc cancels)`
          : 'no marks yet — set one with ’ then a letter';
        return schedulePaint();
      case 'sort': {
        // Through applyOption, the same call the options window's Order row makes, rather than a third
        // copy of the order list beside SORT_KEYS and that row. The key and the row cycle one
        // implementation, so they cannot end up offering different orders in different places.
        const cycled = applyOption(prefs, 'sort', 1);
        const next = cycled.sort ?? 'time';
        saveOptions(cycled);
        state.sort = next;
        state.cursor = 0;
        state.scroll = 0;
        syncPane();
        state.status = `sorted by ${core.SORT_LABEL[next]}`;
        return schedulePaint();
      }
      case 'fold': {
        // The whole list at once — the per-file toggle is space/enter/click on a header. Cycles:
        // anything open closes everything, nothing open opens everything. Map folders keep their
        // own state untouched — the `edits:` key namespace is what makes the two independent
        // inside the one open-set.
        const headers = rowsOf('edits', 'traces').filter((r) => r.openPath?.startsWith('edits:'));
        if (!headers.length) {
          state.status = 'nothing to fold — the list has no file groups';
          return schedulePaint();
        }
        const anyOpen = headers.some((r) => state.open.has(r.openPath as string));
        const open = new Set([...state.open].filter((k) => !k.startsWith('edits:')));
        if (!anyOpen) for (const h of headers) open.add(h.openPath as string);
        state.open = open;
        state.status = anyOpen
          ? `folded ${headers.length} file(s) — space opens one`
          : `unfolded ${headers.length} file(s)`;
        clampCursor();
        syncPane();
        syncDetailDiff();
        return schedulePaint();
      }
      case 'wrap': {
        // Wrapping is the default and stays the default — this product never truncates content. The
        // toggle turns on HORIZONTAL SCROLLING instead, which is what `delta` and `bat` offer: on a
        // wide patch, alignment is easier to read than reflowed lines, and nothing is hidden because
        // the pane scrolls to it.
        state.noWrap = !state.noWrap;
        // Back to 0 on the way out, and on the way in. Leaving a pan behind means the next patch opens
        // already scrolled sideways, with its left column — where a diff's +/- markers live — off screen
        // for a reader who never panned this one.
        state.panX = 0;
        state.status = state.noWrap
          ? 'long lines pan sideways — ←→ to pan, w to wrap again'
          : 'long lines wrap again';
        return schedulePaint();
      }
      case 'copy': {
        // WHAT IS ON SCREEN, to the system clipboard, over OSC-52.
        //
        // OSC-52 rather than pbcopy/xclip for one reason that matters here: this app lists sessions
        // on other machines, and a reader reviewing over ssh has no local clipboard tool to shell
        // out to — the escape travels the wire and the TERMINAL does the copying. Terminals that do
        // not implement it ignore an unknown OSC, so the cost of trying is nothing.
        //
        // What gets copied follows what you are LOOKING at: the diff face copies the patch, anything
        // else copies the selected row's file path. Copying "the selection" from a pane whose
        // selection is a file means the path — that is the thing anyone pastes into a message.
        const onDiff = state.panes?.focus === 'detail';
        const row = rowsOf()[state.cursor];
        // A FILE HEADER addresses every edit in its file, so `rowFile` (which answers only for a
        // single-edit row, by design) returns nothing for it — and the header is exactly the row a
        // reader is sitting on when they want the path. Its key carries that path.
        const text = onDiff ? state.diffPatch ?? '' : selectedPath(row) || state.diffMeta?.path || '';
        if (!text) {
          state.status = 'nothing here to copy — select an edit, or open its diff';
          return schedulePaint();
        }
        // One door (copyText): OSC 52 within bounds; wl-copy/xclip/pbcopy past them locally; the
        // loud refusal elsewhere — still naming the CLI fallback for this exact diff.
        const what = onDiff ? `the diff (${text.split('\n').length} lines)` : text;
        const id = state.diffMeta?.id;
        copyText(text, `copied ${what}`, onDiff && id !== undefined ? ` — or: oak diff ${id}` : '');
        return;
      }
      case 'j':
        return void onKey({ ...ev, key: 'down' });
      case 'k':
        return void onKey({ ...ev, key: 'up' });
      // …and the jumps. `g`/`G` are universal, and a 2,000-row Traces pane without them means holding
      // a key for a page at a time.
      case 'g': {
        state.cursor = 0;
        state.scroll = 0;
        syncPane();
        return schedulePaint();
      }
      case 'G': {
        state.cursor = Math.max(0, rowsOf().length - 1);
        clampCursor();
        syncPane();
        return schedulePaint();
      }
      // `case '\x03'` used to sit here too, and was dead: `ch === '\x03'` already returned 200 lines
      // above, at the only place ^C can reach. Two spellings of one key, one of them unreachable.
      // 'quit' left the keymap with its `q` binding: ^C twice is the one exit.
      // `case '\t'` here was dead: the decoder names this key `tab` (tui/input.ts CTRL_NAME), and
      // `ch` is that name, so the comparison could never be true. `enter` next door was right, which
      // is what made the bug invisible — one key in the table spelled as a byte, the rest as names.
      case 'tab': {
        // Cycle TABS, not panes. Pane focus
        // moves by the arrow keys and the F-keys now, and by the leader (ctrl+a then tab) for the full
        // BSP rotation; a bare tab is the one gesture every terminal reader means as "next tab".
        if (tabs.length > 1) switchTab((active + 1) % tabs.length);
        return;
      }
      case 'minimize': {
        // Minimize/restore the focused pane. The dual of zoom, and the pane keeps its chip and its
        // counter on the window bar — a tool does not withdraw its alarm to save a row.
        const m = new Set(state.panes!.minimized);
        const f = state.panes!.focus;
        if (m.has(f)) m.delete(f);
        else m.add(f);
        state.panes = { ...state.panes!, minimized: m, zoom: null };
        const open = resolveLayout(layoutReq({ minimized: m, zoom: null, focus: f })).boxes;
        if (open.length && !open.some((b) => b.id === f)) return focusPane(open[0].id);
        ask();
        return schedulePaint();
      }
      case 'zoom':
        return toggleZoom(state.panes!.focus);
      case '<':
      case ',':
        return nudgeSize(-2);
      case '>':
      case '.':
        return nudgeSize(2);
      case 'reset':
      case '_':
        // One key back to the resolved default, btop's preset spirit.
        state.panes = { ...state.panes!, minimized: defaultMinimized(frameCols, frameRows), zoom: null, sizes: {} };
        state.status = 'layout reset';
        ask();
        return schedulePaint();
      case '[':
      case ']': {
        const f = state.panes!.focus;
        const tabs = PANE_SPECS.find((x) => x.id === f)!.tabs;
        // Three of the four panes have no strip, and `% 0` is NaN — which went straight into
        // `panes.tab` and made the pane render nothing at all until the layout was reset.
        if (!tabs.length) {
          state.status = `${PANE_SPECS.find((x) => x.id === f)!.title} has no tabs`;
          return schedulePaint();
        }
        const at = state.panes!.tab[f] ?? 0;
        const next = (at + (ch === ']' ? 1 : tabs.length - 1)) % tabs.length;
        state.panes = { ...state.panes!, tab: { ...state.panes!.tab, [f]: next } };
        state.cursor = 0;
        state.scroll = 0;
        const sc = paneScreen(f);
        if (sc !== 'diff') state.screen = sc as typeof state.screen;
        ask();
        return schedulePaint();
      }
      // `N` is next/previous MATCH, the pairing every tool with a find uses. It only ever means that:
      // with no find standing it says so rather than falling through to the review stepper, because
      // `n` and `N` doing two unrelated things depending on hidden state is the thing this fixes.
      /**
       * JUMP TO A PATH, rather than narrowing to it.
       *
       * The filter answers "show me only these"; this answers "take me there and leave the list
       * alone", which is the other half and the one a 546-file session actually needs. It reuses the
       * session picker's overlay machinery — a filtered list you arrow through and Enter — because a
       * second picker implementation is a second set of edge cases.
       */
      case 'P': {
        const rows = rowsOf('edits', 'traces').map((r, i) => ({ r, i })).filter(({ r }) => r.key?.startsWith('f'));
        if (!rows.length) {
          state.status = 'no files to jump to yet';
          return schedulePaint();
        }
        jumpRows = rows.map(({ i }) => i);
        state.overlay = {
          title: JUMP_TITLE,
          lines: rows.map(({ r }) => `  ${r.cells.trim()}`),
          scroll: 0,
          cursor: 0,
        };
        return schedulePaint();
      }
      case 'N':
        if (!lastFind) {
          state.status = 'no find to repeat — / filters the list, and the Diff face has its own find';
          return schedulePaint();
        }
        return jumpToMatch(lastFind, -1);
      case 'next':
      case 'prev': {
        // WITH A FIND STANDING on the Diff face, these repeat it — `n`/`p` mean "next match" in every
        // tool that has a find, and stepping to another edit would throw away the search you just ran.
        // Anywhere else they keep their review meaning, which is what the navbar advertises.
        //
        // `lastFind` is CLEARED when the reader leaves that state (see clearFind), so this branch is
        // reachable in both directions. It used to be set once and never unset: after a single
        // successful find, `n`/`p` meant "next match" on the Diff face for the rest of the session,
        // even after selecting a different edit with a different patch, and no key got the review
        // stepper back.
        if (lastFind && state.panes?.focus === 'detail') {
          return jumpToMatch(lastFind, verb === 'next' ? 1 : -1);
        }
        // Step the review one edit at a time from ANY window — the navbar advertises these, so they
        // must not require focusing Traces first.
        const f = state.panes?.focus;
        if (f && f !== 'traces') focusPane('traces');
        return move(verb === 'next' ? 1 : -1);
      }
      case 'editor':
        return openInEditor();
      case 'options':
        return openOptions();
      case 'keep':
        return mutateScope('keep', 'one');
      case 'undo':
        return mutateScope('undo', 'one');
      case 'keepAll':
        return mutateScope('keep', 'all');
      case 'undoAll':
        return mutateScope('undo', 'all');
      case ' ':
        // Space is the fold key everywhere a tree exists — and on a row that is not a folder it does
        // nothing rather than drilling in, because Enter already means "open this" and a space bar
        // that sometimes opens a diff is a space bar nobody presses twice.
        {
          const row = rowsOf()[state.cursor];
          if (row?.openPath === undefined) {
            state.status = 'space folds a change-map folder or a Traces file group — this row is neither';
            return schedulePaint();
          }
          return openSelected();
        }
      case 'enter':
        openSelected();
        return;
      case 'session':
        openSessionPicker();
        return;
      case 'inbox':
        openInbox();
        return;
      case 'nextHand':
        jumpNextHand();
        return;
      case 'refresh': {
        // A user-CLICKED Refresh is the safe place to apply a newly-added `.observatoryignore`.
        // Adding the file fires no capture hook, so the sweep that drops now-ignored records (capture.ts,
        // the WRITE path) never runs, and a plain refresh — a read — left them. `dropIgnored` is
        // self-gating (a no-op when nothing matches); only HERE, never on the auto-refresh tick, which
        // must not rewrite the store under concurrent readers. `ask(true)` forces the post-drop read.
        const igSes = state.scopeWorker?.session || state.session;
        const droppedNote = (dropped: number) => dropped > 0 ? `refreshing… · dropped ${dropped} now-ignored edit${dropped === 1 ? '' : 's'}` : 'refreshing…';
        // A session reviewed on another machine keeps its store there, so the sweep runs there too:
        // run here it found no store and did nothing, silently.
        const igMachine = igSes && tabs[active]?.id !== 'observatory' ? reviewMachine(igSes) : undefined;
        if (igSes && igMachine) {
          state.status = 'refreshing…';
          void backend!.run(['ignore', '--session', igSes, '--json'], igMachine).then((out) => {
            let dropped: number | null = null;
            try { dropped = Number(JSON.parse(out).droppedNow) || 0; } catch { /* reported below */ }
            state.status = dropped === null
              ? `could not apply .observatoryignore on ${igMachine}: ${out.trim().split('\n').pop()?.replace(/^oak: /, '') || 'no answer'}`
              : droppedNote(dropped);
            ask(true);
            schedulePaint();
          });
          return schedulePaint();
        }
        let dropped = 0;
        if (igSes) { try { dropped = core.dropIgnored(igSes).dropped; } catch { /* a torn store still refreshes */ } }
        state.status = droppedNote(dropped);
        ask(true);
        return schedulePaint();
      }
      case 'filter':
        // ON THE DIFF FACE, `/` searches the PATCH. Everywhere else it filters the list.
        //
        // The list filter cannot help inside a 341-line diff — it narrows rows, and the diff is one
        // row's contents. `delta`, `tig` and `lazygit` all search within the patch, and without it a
        // long edit can only be read by scrolling past what you are looking for.
        if (state.panes?.focus === 'detail') {
          diffFindOpen = true;
          diffFind = '';
          state.status = 'find in diff: ';
          return schedulePaint();
        }
        filterOpen = true;
        state.filterOpen = true;
        state.filter = '';
        return schedulePaint();
      case 'filter-menu':
        openFilterMenu();
        return;
      case 'help': {
        state.overlay = { title: 'keys  —  esc or ? to close', lines: helpLines(prefs), scroll: 0 };
        return schedulePaint();
      }
      default:
        return;
    }
  }
}


export const COMMANDS: Readonly<Record<string, { args: () => string[]; what: string }>> = {
  help: { args: () => ['help'], what: 'the CLI’s own help — every verb this build has' },
  // `?` is the key the frame advertises for help everywhere else, so it is the thing a reader types
  // into a prompt first. It answered "no command" until now.
  '?': { args: () => ['help'], what: 'the CLI’s own help — every verb this build has' },
  store: { args: () => ['store'], what: 'where the observatory keeps its data' },
  ignore: { args: () => ['ignore'], what: 'what .observatoryignore covers' },
  doctor: { args: () => ['doctor'], what: 'check the setup' },
  status: { args: () => ['status'], what: 'hooks, session and edit counts' },
  version: { args: () => ['version'], what: 'this build' },
};

/**
 * The `?` overlay's lines, built from the reader's OWN keymap.
 *
 * A function, and exported, so a test can read what this screen actually says. It used to be a literal
 * inside the key handler, reachable only by pressing `?` — which is how `sort` and `wrap` came to be
 * bound to keys that no surface in the product named. `keymapCoverage` in the core tests walks this
 * against REBINDABLE and fails on the next verb that ships without a door.
 */
export function helpLines(prefs: import('@oak-observatory/core').Prefs): string[] {
  const keys = () => coreKeymap(prefs);
  /**
   * Rows built from the reader's OWN keymap.
   *
   * This screen used to hard-code its letters, which is how it came to advertise "1-6 screens"
   * for a build that had none — and once keys became rebindable, a hard-coded list is a list
   * that lies to exactly the reader who customised it.
   */
  const boundRows = (rows: readonly (readonly [string, string])[]): string[] => {
    const km = keys();
    const keyFor = (action: string): string => {
      for (const [k, a] of km) if (a === action) return k;
      return '—'; // rebound onto a key another action won: keyConflicts already says so
    };
    return rows.map(([action, what]) => `    ${keyFor(action).padEnd(14)} ${what}`);
  };
  // A real help surface, not a one-line status. It listed "1-6 screens" — a keymap that never
  // existed in this build (there were eight, and now there are five windows), and `?` is the
  // key the frame itself advertises, so it is the one thing that must not be stale.
  return [
      '  TABS',
      '    herdr               the native herdr client; ctrl+b belongs to herdr',
      '    Observatory         machine → workspace → agent pane → session → Workers; pinned conversation beside it',
      '    Review              captured edits and keep/undo',
      "    ctrl+a n/p or 1-3   switch OAK tabs; herdr's tab bar starts agents; ctrl+a k detaches its client",
      '    ctrl+a o            from herdr, select and pin its focused session in Observatory',
      '    ctrl+a q            quit OAK (repeat within two seconds to confirm)',
      '    ctrl+a ctrl+a       send ctrl+a to the program (line start in Claude Code and Codex)',
      '    ctrl+q twice        quit OAK from any tab (repeat within two seconds to confirm)',
      '',
      '  OBSERVATORY',
      '    ↑/↓                 select a session: the detail header and the Review tab follow it',
      '    Enter / d / f       pin the selected conversation; browsing keeps the pin',
      '    click a session     pin its conversation — its pane line, title or stats line',
      '    i / esc             focus / leave the pinned reply box; Enter sends through herdr',
      '                        blocked sessions need an answer in herdr; no pane disables replies',
      '    h / r               jump to its herdr pane / scope Review to it',
      '    Shift+A             show or hide archived sessions (no pane and no pending edits)',
      '    F1, F2, …           focus a pane; press again to zoom, again to restore',
      '    ←/→                 focus master / detail; wheel or PgUp/PgDn scroll each pane',
      '    End / ↓ newest      jump to the newest message and follow the conversation',
      '    click a fold        expand thinking, action boxes, Workers or Tasks',
      '    drag across text    copy it; the selection stays in its pane and copies on release',
      '',
      '  REVIEW WINDOWS',
      '    F2 / F3             focus Prompts / Traces',
      '    F4 / F5 / F6        focus Map / Diff / Dashboards; a second press zooms',
      '    Tab                 next tab; [ ] selects a tab inside a review window',
      '    m / z               minimize / zoom; drag seams to resize',
      '    < / > / =           grow / shrink / reset the layout',
      '    drag across a body  copy characters (OSC 52)',
      '',
      '  PANES (on a tree tab such as the observatory: ctrl+a, then…)',
      '    | / -               split the focused pane side by side / stacked, then pick what it shows',
      '    v                   pick what the focused pane shows     x  close it     z  zoom it',
      '    H J K L             swap the focused pane with its neighbour left / below / above / right',
      '    tab                 focus the next pane',
      '    drag a pane by its TITLE onto another: the middle swaps them, an edge places it beside;',
      '    drag a rule to resize. The mouse pointer shows what a spot does (kitty, Ghostty, foot,',
      '    xterm; inside tmux: set -g allow-passthrough on).',
      '',
      '  THE DETAIL NAVBAR  (click a button, or use the key)',
      '    Keep / Undo    a / u — act on the edit Detail is SHOWING',
      '    prev / next    p / n — step the review one edit at a time, from any window',
      '                   (with a find standing on the Diff face they repeat it instead, and',
      '                    N goes back a match; esc or moving the selection ends the find)',
      '',
      '  MOVING',
      '    up / down       move the selection in the FOCUSED window; on Detail, scroll the diff',
      '    left / right    previous / next tab       PgUp / PgDn   move ten',
      '    0-9 then enter  go to an edit by its id (esc cancels, backspace deletes)',
      '    space           fold or unfold a change-map folder, or a Traces file group',
      '    F               fold or unfold every file group in the Traces list at once',
      '    enter           open — a folder on Map, otherwise the edit full screen',
      '    esc             back — closes a zoom, a prompt scope, a filter or an overlay',
      '    /               filter (esc clears and closes, enter keeps it)',
      '',
      '  REVIEWING  (these act on the focused window only)',
      ...boundRows([
        ['keep', 'keep the selection — on the Map, everything under the row'],
        ['undo', 'undo the selection — on the Map, everything under the row'],
        ['keepAll', 'keep everything the window lists — on the Map, the whole SESSION'],
        ['undoAll', 'undo everything the window lists — on the Map, the whole SESSION'],
      ]),
      '    (both ask first, with the real count. The Map draws its own icon buttons: [ ✓ ] keeps',
      '     and [ ✗ ] undoes on every pending row, [ ↺ ] redoes a reverted one, and the heading',
      '     carries [ ✓ N ] keep-all · [ ✗ N ] undo-all · [ ⚑ ] resolve — the question they',
      '     raise is answered in the map itself, by key or by clicking [ y ] / [ n ])',
      '    ^R             redo — vim’s own. Not rebindable: the ctrl chords are a fixed layer',
      '    y / n          answer a confirmation while one is standing (that question is a wall:',
      '                   it takes every key until you answer, so y means yes there and copy',
      '                   everywhere else)',
      '',
      '  CTRL  (a fixed layer — beyond these and the herdr leader above, other ctrl',
      '         chords do nothing, on purpose)',
      '    ^D / ^U        half a page down / up          ^F / ^B   a whole page',
      '    ^R             redo          ^Z   suspend (fg brings it back)          ^C   quit',
      '',
      '    P              go to a file — a picker, not a filter: it takes you there and leaves the',
      '                   list alone (the filter narrows; this jumps)',
      '',
      '  MARKS  (vim’s `m` is taken — it minimizes a window — so both jump keys do the work)',
      '    ’ then a letter   set a mark on the selected edit',
      '    ` then a letter   go back to it. Marks follow the EDIT, so a re-sort or a filter cannot',
      '                      leave one pointing at a different file. They last for this session.',
      '',
      '  MOVING',
      '    ↑↓ or j/k      move            g / G   first / last row',
      '    PgUp / PgDn    a page          /       filter (matches scattered letters: pcsi finds',
      '                                           packages/core/src/index.ts)',
      '',
      '  THE LIST',
      ...boundRows([
        ['mark', 'mark or unmark this row — then a / u act on every marked edit at once, and esc clears'],
        ['sort', 'order the list by time (newest first) or by name — cycles, and says which is in force'],
        ['wrap', 'wrap long diff lines, or leave them long and pan across with ← →'],
        ['filter', 'filter — scattered letters (pcsi finds packages/core/src/index.ts), or a regex the moment it has regex syntax'],
        ['filter-menu', 'filter options: the file-type / extension buckets to show, and what filter is applied'],
      ]),
      '',
      '  SESSION AND APP',
      ...boundRows([
        ['session', 'browse local sessions — type to filter'],
        ['inbox', 'needs you — every session waiting on you, most urgent first; enter jumps to it'],
        ['nextHand', 'jump to the next session waiting on you (permission, then question, then input)'],
        ['refresh', 'refresh'],
        ['copy', 'copy the selected path — or the diff, when the Diff face is focused'],
        ['editor', 'open the selection in $EDITOR (GUI editors detach; terminal ones take over until exit)'],
        ['options', 'options (editor, display, store, keys)'],
        ['help', 'these keys'],
      ]),
      '    ctrl+o              find anything — sessions, tabs, workspaces and actions in one list;',
      '                        type to narrow (scattered letters work), ↵ opens what the row is',
      '',
      '  ctrl+q twice quits on every tab; ctrl+c twice and ctrl+a q twice share its confirmation.',
      '',
      '  Every key in the two lists above is READ FROM YOUR OWN KEYMAP, so a rebind shows here',
      '  the moment you make it. They can all be rebound from the options window; the structural',
      '  keys cannot — F1-F6, the arrows, Tab, Enter, Esc, Space and the digits are how you leave',
      '  a mode, and a rebind that took one away would leave no way out.',
  ];
}

/** One-shot read for the non-interactive path: no watcher, no timers, no terminal state. */
function createOnce(core: Core, cwd: string, session: string, views: string[], machine?: string, root?: string): Promise<Record<string, unknown> | null> {
  // No session (a first run): `views --session ''` answers exit 0 with every view null and a
  // `__problems` note, which would read as "a payload". Nothing to fetch — say so instead.
  if (!session) return Promise.resolve(null);
  return cliJson(core, cwd, ['views', '--views', views.join(','), '--json', '--session', session, ...(root ? ['--root', root] : []), ...(machine ? ['--machine', machine] : [])], 'views');
}

/** This machine's session listing with no session named (`oak sessions --json`), shaped as a `views`
 *  payload's `sessions`. */
function sessionsOnce(core: Core, cwd: string): Promise<Record<string, unknown>> {
  return cliJson(core, cwd, ['sessions', '--json'], 'sessions').then((sessions) => ({ sessions }));
}

/** One of this CLI's own verbs in a child, answering one JSON object. */
function cliJson(core: Core, cwd: string, args: string[], verb: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = core.spawnTool(
      process.execPath,
      [process.argv[1], ...args],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' } }
    );
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    const errors: Buffer[] = [];
    child.stderr?.on('data', (d: Buffer) => errors.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const err = Buffer.concat(errors).toString('utf8').trim();
      if (code !== 0) return reject(new Error(err || `${verb} exited ${code ?? '?'}`));
      try {
        const out = Buffer.concat(chunks).toString('utf8');
        const value = JSON.parse(out);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid envelope');
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new Error(err || `${verb} returned invalid JSON`));
      }
    });
  });
}
