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
import * as os from 'os';
import * as path from 'path';
import { isatty, ReadStream } from 'tty';
import { StringDecoder } from 'string_decoder';
import { createNativeInput, translateNativeMouse, type NativeInputPart, type NativeKeyEvent } from './native-input';
import { routeNativeHostReply } from './native';
import { selectAndPin, observatoryReply, observatorySelection, observatorySessions, hasActiveWorker, sessionMachine, listedMachine, newestAnywhere, pickerSessionRows, syncConflictResolution, syncInUse, type ObservatorySelection, type SyncView } from './observatory';
import { createObservatory } from './observatory-runtime';
import { commentAnchor, firstChangedLine } from './richdiff';
// helpLines() is module-level so a test can read it; it cannot reach the `core` handle the app is
// constructed with, so it takes the keymap straight from the settings layer.
import { keymap as coreKeymap, herdrPrefixFrom, OAK_TAB_KEYS, type OakPrefixKey, type OakTabKey } from '@oak-observatory/core';
import { fuzzyMatch, wrapVisible } from './textwidth';
import { pointerSeq, pointerForTreeHit, pointerForDockHit, dropZone, type PointerShape } from './pointer';
// The rendering half of this package. `core` stays a PARAMETER — it is the data layer, and
// injecting it is what lets the app be driven against a fixture store in tests.
import {
  BAR_ENTRIES,
  PANE_SPECS,
  TAB_SCREEN,
  APP_PREF_KEYS,
  type AppPrefKey,
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
  optionRowLines,
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
  selectedText,
  charCount,
  spanCols,
  spanEnds,
  stripSgr,
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
  TAB_KEYS,
  herdrPrefixHints,
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
  overlayListRows,
  overlayScroll,
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
/** The focus server's reconnect: the first wait after a disconnect, and the longest a run of failures doubles it to. */
const FOCUS_RETRY_MS = 3_000;
const FOCUS_RETRY_MAX_MS = 60_000;
/** The keys a reader HOLDS DOWN — movement, and the two that edit text. See `repeatActs`. */
/** The rebindable verbs the Observatory answers too, with the meaning they have on Review. */
const OBSERVATORY_SHARED: ReadonlySet<string> = new Set(['help', 'options', 'filter', 'session', 'inbox', 'nextHand', 'refresh']);
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
    const inline = args.find((a) => a.startsWith(name + '=')); // `--root=dir`, as the CLI reads it
    if (inline !== undefined) return inline.slice(name.length + 1) || null;
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
  /** Where that frame's bottom rows begin (the status row when it speaks, else the usage bar) and its status text
   *  whole, which the row cuts at the terminal's edge (FrameOpts.bottom). Null under an overlay. */
  let lastBottom: { first: number; status: string } | null = null;
  /** An armed text selection: a left press on a body cell that may become a drag-to-copy. Columns
   *  ride along because the copy is CHARACTER-precise — the span runs cell to cell, like the
   *  terminal's own selection, not row to row. On a tree tab (the Observatory) the selection is held
   *  to the text area of the pane it began in (`clip`, frame cells), and the press's own click
   *  (`click`) waits for a release that never moved. That pane (`pane`) says which of its rows hold
   *  text in only some of their cells: a boxed prompt's borders are neither banded nor copied. */
  let textDrag: {
    startRow: number; lastRow: number; startCol: number; lastCol: number; moved: boolean;
    clip?: { x0: number; x1: number; y0: number; y1: number }; click?: () => void; pane?: string;
    /** On the bottom rows, which move when the status row comes or goes. */
    bottom?: true;
  } | null = null;
  /** Who has the mouse button pressed last, until its release: OAK (its tab bar, the rows under a native tab's
   *  screen, and every other tab) or the program on a native tab. Its motion and its release go there. */
  let buttonHeld: 'oak' | 'program' | null = null;
  /** Where the program last had the button it holds: its press's code and the cell, in the program's own rows. */
  let programAt: { code: number; col: number; row: number } | null = null;
  /** The button let go in the program while still down (letProgramGo): until it comes up, its motion and release are
   *  no one's, so the program never sees a drag after its release. A press of that button ends it (its release was
   *  lost), and so does motion with no button held; another button's press does not. */
  let programLetGo: number | null = null;
  /** Send the program a mouse report, keeping where its held button is. */
  const toProgram = (sess: NativeSession, bytes: Buffer): void => {
    sess.write(bytes);
    const r = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(bytes.toString('latin1'));
    if (!r) return;
    const code = Number(r[1]), at = { col: Number(r[2]), row: Number(r[3]) };
    if (r[4] === 'm' || (code & 35) === 35) programAt = null; // its release, or motion with no button held
    else if (!(code & 96)) programAt = { code, ...at }; // a press
    else if (programAt && !(code & 64)) programAt = { ...programAt, ...at }; // the held button's motion
  };
  /** The program's held button let go where it last was: the reader left its tab, or pressed on OAK's rows or tab bar,
   *  with the button still down. herdr kept such a selection up, and a program reading the mouse its button down. */
  const letProgramGo = (sess: NativeSession | undefined): void => {
    if (programAt && sess && !sess.ended) sess.write(Buffer.from(`\x1b[<${programAt.code};${programAt.col};${programAt.row}m`));
    programLetGo = programAt ? programAt.code & 3 : null;
    programAt = null;
  };
  /** A drag's span, normalized so `a` precedes `b` (spanEnds, which the copy reads too): the live-drag paint and the
   *  kept selection. */
  const normSpan = (td: { startRow: number; startCol: number; lastRow: number; lastCol: number }) =>
    spanEnds({ row: td.startRow, col: td.startCol }, { row: td.lastRow, col: td.lastCol });
  /** What the status row says while a drag on a dock tab selects (onMouse). It goes when the drag ends, however it
   *  ends: it stood beside the toast that said what was copied. */
  const SELECTING = 'selecting — release to copy';
  const endTextDrag = (): void => {
    textDrag = null;
    if (state.status === SELECTING) state.status = 'ready';
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
  /** With no session to review (a first run, or a workspace with none of its own), what the status and the Review panes
   *  say. The Observatory lists every session all the same; in a workspace (a repository, or --root), other workspaces'
   *  sessions may be there. */
  const noSessionStatus = (): string =>
    `no agent session${flag('--root') || core.repoRoot(cwd) ? ' in this workspace' : ''} yet — start one in the herdr tab; the Observatory lists every session`;
  const noSessionReview = (): string => `no session to review — ${keyForAction('session')} picks one, or select one in the Observatory`;

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
      tabNames: tabs.map((t, i) => tabParts(t, i, glyphs).body),
      activeTab: active,
      ...over,
    };
  }

  /** Save the keys `sets` names (APP_PREF_KEYS) as `next` has them, over prefs.json as it is now, so every other key
   *  stays as the file has it. Written whole, the copy read at start undid what the file was given while the app ran,
   *  at the next tab switch: a switch turned off (`oak titles --off`, `"machineUsage": false`) came back on, and a
   *  store `oak store --move` moved was looked for where it had been. */
  function writeOwn(next: import('@oak-observatory/core').Prefs, sets: readonly AppPrefKey[]): void {
    // A file that does not parse (a hand edit half done) is left as it is: `writePrefs` refuses it, and the caller says so.
    const now = core.readPrefs();
    for (const k of sets) {
      if (next[k] === undefined) delete now[k];
      else Object.assign(now, { [k]: next[k] });
    }
    core.writePrefs(now);
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
      writeOwn(prefs, ['layout']);
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

  /** herdr's prefix, pressed on the herdr tab and held back from the client until the next key says whose
   *  it is: OAK's (`m`, `M`, when herdr leaves them unbound) or herdr's, which then gets both unchanged. */
  let prefixHeld: Buffer | null = null;
  /** A ctrl+q pressed on the herdr tab, held while it may be the first of OAK's quit: a second one quits, and
   *  anything else the reader does there sends it on to the program first, as the quit window ending does. */
  let quitHeld: { bytes: Buffer; timer: NodeJS.Timeout } | null = null;
  const dropQuitHeld = (): void => {
    if (quitHeld) clearTimeout(quitHeld.timer);
    quitHeld = null;
  };
  /** The OAK tab (not herdr's) the reader was last on: herdr's prefix then `m` goes back to it. */
  let lastOakTab = -1;
  /** Each tab's `/` filter while another tab is up, by tab id. */
  const tabFilters = new Map<string, string>();
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
      state.status = 'answer the pending question first — y or n';
      return schedulePaint();
    }
    if (tabs[i].id === 'herdr') {
      nativeFailed.delete('herdr');
      const old = nativeSessions.get('herdr');
      if (old?.ended) { nativeSessions.delete('herdr'); old.close(); }
    }
    // A button still down: the program holding it gets its release where it last had it, and the rest of that gesture
    // is OAK's, which takes nothing from it. OAK's own selection ends here, held or kept: let go, or copied again with
    // ctrl+c, on the next tab, it took that tab's text.
    if (buttonHeld === 'program') letProgramGo(nativeSessions.get(tabs[active]?.id));
    if (buttonHeld) buttonHeld = 'oak';
    endTextDrag();
    state.selSpan = null;
    nativeSessions.get(tabs[active]?.id)?.setHostActive?.(false);
    // The `/` filter belongs to the tab it was typed on: one typed on the Observatory narrowed Review's
    // lists too. A filter still being typed ends with the switch (its key row would sit on another tab).
    tabFilters.set(tabs[active]?.id ?? '', state.filter);
    prefixHeld = null; // a prefix held for herdr is not carried to another tab or a new client
    dropQuitHeld(); // nor is a ctrl+q held there: OAK's quit stays armed, and the program left never gets it
    filterOpen = false;
    state.filterOpen = false;
    state.filter = tabFilters.get(tabs[i].id) ?? '';
    // The OAK tab being left, the one the app opened on included: herdr's prefix then `m` returns to it.
    if (tabs[active]?.kind !== 'native') lastOakTab = active;
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

  /**
   * ONE RULE for the list overlays (the inbox, search results, the view picker, the help, the row menu):
   * ↑↓ or j/k move, Enter chooses, Esc or q closes, and every other key is swallowed. Some closed on any
   * other key, j and k included, and the options window ignored q. The overlays that TYPE (the palette,
   * the session picker, the help's own filter) close on Esc only, since q is text there.
   */
  const listKey = <E extends { key: string; ctrl?: boolean; alt?: boolean }>(ev: E): E =>
    ev.ctrl || ev.alt ? { ...ev, key: '' } : ev.key === 'j' ? { ...ev, key: 'down' } : ev.key === 'k' ? { ...ev, key: 'up' } : ev;

  // ---- Needs you: the raised-hand inbox and the next-hand jump ----
  // The hooks record what every session waits on (attention.json); the sessions payload carries it as
  // `attention`. `i` lists every hand, most urgent first; `h` jumps to the next one; a new hand toasts
  // once (keyed by its ts, the editors' rule) and asks core to announce it on the desktop — core's
  // claim file makes that fire once per machine however many surfaces are open.
  type HandKind = import('@oak-observatory/core').HandKind;
  type HandRowLite = { id: string; title?: string; agent?: string; attention: { kind: HandKind; message: string; ts: number }; host?: string; machine?: string };
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
    const listing = state.views?.sessions as { sessions?: unknown[]; syncedHands?: unknown[] } | undefined;
    const rows = (listing?.sessions ?? []) as { id: string; attention: { kind: HandKind; message: string; ts: number } | null }[];
    // Other machines' hands, as the listing carries them from their records, each on the machine it waits on.
    return [...core.rankedHands(rows, true) as unknown as HandRowLite[], ...syncedHandRows(listing?.syncedHands)].sort((a, b) => core.byHand(a.attention, b.attention));
  }
  /** The listing's `syncedHands` (core InboxRow) as hand rows. */
  function syncedHandRows(list: unknown): HandRowLite[] {
    return (Array.isArray(list) ? list as import('@oak-observatory/core').InboxRow[] : []).filter((h) => typeof h?.id === 'string' && typeof h.host === 'string' && typeof h.ts === 'number')
      .map((h) => ({ id: h.id, title: h.title ?? undefined, agent: h.agent, attention: { kind: h.kind, message: h.message, ts: h.ts }, host: h.host, machine: h.machine }));
  }
  /** A hand row's key in the inbox: its session, and another machine's with that machine (an id can repeat across them). */
  const handKey = (r: HandRowLite): string => (r.host ? `${r.id}@${r.host}` : r.id);

  // ---- oak sync: what its last run left, for the Observatory's machine rows, the inbox and the options ----
  // `oak sync status --json`, read at start and then only when one of sync's own files moved (its status, conflicts, run
  // lock and key, and prefs.json) or the day changed (its clock times then carry the date): five stats on each poll, and
  // a child only when the stamp moved.
  let syncStamp = '';
  let syncReading = false;
  function readSyncStatus(force = false): void {
    if (syncReading || !backend) return;
    const dir = path.join(core.rootDir(), 'sync');
    const stamp = [path.join(dir, 'status.json'), path.join(dir, 'conflicts.json'), path.join(dir, 'now.lock'), path.join(dir, 'key'), core.prefsPath()].map((f) => {
      try {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    }).join('|') + `|${new Date().toDateString()}`;
    if (!force && stamp === syncStamp) return;
    syncStamp = stamp;
    syncReading = true;
    void backend.run(['sync', 'status', '--json'], undefined, { timeoutMs: 30_000 }).then((out) => {
      const v = JSON.parse(out) as SyncView;
      if (v?.syncStatus !== 1) return;
      state.sync = v;
      if (inboxOpen) renderInbox();
      schedulePaint();
    }).catch(() => { /* an older CLI, or an answer that is not JSON: what was read before stands */ }).finally(() => { syncReading = false; });
  }
  /** The inbox's id for one of oak sync's open conflicts: no session id has a colon. */
  const SYNC_ROW = 'sync:';
  /** The sync conflict the inbox opened (its id), and which of its two ways out the cursor is on. */
  let conflictOpen: string | null = null;
  let conflictCursor = 0;

  function renderInbox(): void {
    if (conflictOpen !== null) return renderConflict();
    const rows = handRows();
    // oak sync's open conflicts follow the hands: a hand is an agent waiting now.
    const conflicts = syncInUse(state.sync) ? state.sync.conflicts : [];
    inboxIds = [...rows.map(handKey), ...conflicts.map((c) => `${SYNC_ROW}${c.id}`)];
    if (!inboxIds.length) {
      inboxOpen = false;
      state.overlay = null;
      state.status = 'nobody is waiting on you';
      return schedulePaint();
    }
    inboxCursor = Math.min(inboxCursor, inboxIds.length - 1);
    const now = Date.now();
    const lines = rows.map((r, i) => {
      const a = r.attention;
      const done = a.kind === 'idle-done';
      const wait = done ? '' : ` · ${core.compactDuration(Math.max(0, now - a.ts))}`;
      const who = r.agent && r.agent !== 'claude' ? `[${r.agent}] ` : '';
      const name = r.title || `session ${r.id.slice(0, 8)}`;
      // Another machine's hand says which: Enter opens it there.
      const where = r.host ? ` · on ${r.machine || r.host}` : '';
      return `${i === inboxCursor ? '> ' : '  '}${done ? '  ' : `${glyphs.pending} `}${(done ? 'done' : a.kind).padEnd(10)} ${who}${name}${a.message ? ` — ${a.message}` : ''}${wait}${where}`;
    });
    conflicts.forEach((c, j) => lines.push(`${rows.length + j === inboxCursor ? '> ' : '  '}${glyphs.pending} ${'conflict'.padEnd(10)} ${c.family} ${c.name} from ${c.from} — ${syncConflictResolution(c.reason)}`));
    const waiting = rows.filter((r) => r.attention.kind !== 'idle-done').length;
    const syncing = conflicts.length ? ` · ${conflicts.length} sync conflict${conflicts.length === 1 ? '' : 's'}` : '';
    state.overlay = { title: `needs you — ${waiting} waiting${syncing} · ↑↓ choose · ↵ open · esc`, lines, scroll: 0, cursor: inboxCursor };
    schedulePaint();
  }
  /** One open conflict, chosen in the inbox: its two copies and the two ways out `oak inbox` names, open both copies in
   *  the reader's editor, or delete the other machine's copy so this machine's stands (`oak sync resolve`). */
  function renderConflict(): void {
    const c = state.sync?.conflicts.find((x) => x.id === conflictOpen);
    if (!c) {
      conflictOpen = null;
      state.status = 'that conflict is resolved';
      return renderInbox();
    }
    const choices = ['open both copies in your editor', `delete ${c.from}'s copy, so yours stands`];
    state.overlay = {
      title: 'sync conflict — ↑↓ choose · ↵ do it · esc back',
      lines: [
        ...choices.map((t, i) => `${i === conflictCursor ? '> ' : '  '}${t}`),
        '',
        `  ${c.family} ${c.name}, from ${c.from} (${c.reason}): ${syncConflictResolution(c.reason)}`,
        `  yours: ${c.file ?? 'not where sync reaches it here'}`,
        `  ${c.from}'s copy: ${c.copy}`,
      ],
      scroll: 0,
      cursor: conflictCursor,
    };
    schedulePaint();
  }
  function conflictKey(ev: { key: string }): void {
    if (ev.key === 'down' || ev.key === 'up') {
      conflictCursor = ev.key === 'down' ? 1 : 0;
      return renderConflict();
    }
    if (ev.key === 'enter') {
      const c = state.sync?.conflicts.find((x) => x.id === conflictOpen);
      if (!c) return renderConflict();
      inboxOpen = false;
      conflictOpen = null;
      state.overlay = null;
      if (conflictCursor === 0) {
        // The copy deleted by hand since the last run is a conflict resolved, which the next run closes.
        if (!fs.existsSync(c.copy)) {
          state.status = `${c.from}'s copy of ${c.name} is gone: the conflict is resolved`;
          readSyncStatus(true);
          return schedulePaint();
        }
        return openInEditorHere([c.file, c.copy].filter((f): f is string => !!f));
      }
      state.confirm = { verb: 'keep yours', ids: [], conflict: c.id, label: `delete ${c.from}'s copy of ${c.family} ${c.name} (it goes to sync's trash)` };
      return schedulePaint();
    }
    if (ev.key !== 'escape' && ev.key !== 'q') return;
    conflictOpen = null;
    renderInbox();
  }
  /** `oak sync resolve`: the other machine's copy goes to sync's trash, this machine's file stands, and the conflict
   *  closes at once. */
  function applySyncResolve(id: string): void {
    const c = state.sync?.conflicts.find((x) => x.id === id);
    state.status = `deleting ${c ? `${c.from}'s copy of ${c.name}` : 'the copy'}…`;
    schedulePaint();
    void backend!.run(['sync', 'resolve', id, '--json']).then((out) => {
      let r: { syncResolve?: number; name?: string; from?: string; trash?: string | null } | null = null;
      try {
        r = JSON.parse(out);
      } catch {
        /* the CLI's own words, below */
      }
      state.status = r?.syncResolve === 1 ? `resolved: ${r.from}'s copy of ${r.name} ${r.trash ? 'is in sync\'s trash' : 'was gone already'}, and yours stands`
        : `could not resolve it: ${out.trim().split('\n')[0].replace(/^oak: /, '')}`;
      readSyncStatus(true);
      schedulePaint();
    });
  }
  function openInbox(): void {
    if (state.confirm) {
      state.status = 'answer the pending question first — y or n';
      return schedulePaint();
    }
    inboxCursor = 0;
    conflictOpen = null;
    inboxOpen = true;
    renderInbox();
  }
  function inboxKey(ev: { key: string; ctrl?: boolean; alt?: boolean }): void {
    ev = listKey(ev);
    if (conflictOpen !== null) return conflictKey(ev);
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
      if (id?.startsWith(SYNC_ROW)) {
        conflictOpen = id.slice(SYNC_ROW.length);
        conflictCursor = 0;
        return renderConflict();
      }
      inboxOpen = false;
      state.overlay = null;
      return id ? jumpToHand(id) : schedulePaint();
    }
    if (ev.key !== 'escape' && ev.key !== 'q') return;
    inboxOpen = false;
    state.overlay = null;
    schedulePaint();
  }
  function jumpNextHand(): void {
    // This machine's own: another machine's hand is opened from the inbox, on that machine.
    const id = core.nextAttention(handRows().filter((r) => !r.host), state.session);
    if (!id) {
      state.status = core.nobodyWaitingHere(handRows().filter((r) => r.host && r.attention.kind !== 'idle-done').length, keyForAction('inbox'));
      return schedulePaint();
    }
    jumpToHand(id);
  }
  /** Switch the observatory to a raised hand and say what it waits on — through the session picker's
   *  own Enter (guards included), so an unsafe or remote row is refused exactly the same way. */
  function jumpToHand(key: string): void {
    const row = handRows().find((r) => handKey(r) === key);
    const id = row?.id ?? key;
    // Another machine's hand: its session, read and reviewed on that machine through `--machine`, which takes a machine
    // saved here (the label it is saved under). One whose records came through another machine is answered there.
    if (row?.host && !(state.observatory?.machines ?? []).some((m) => !m.local && m.label === row.machine)) {
      state.status = `${row.title || `session ${id.slice(0, 8)}`} ${core.attentionLabel(row.attention.kind)} · on ${row.machine || row.host}, which is not saved here (oak machine add): it is answered there`;
      return schedulePaint();
    }
    if (state.session !== id || row?.host) choosePicked(id, row?.host ? row.machine || row.host : undefined);
    if (row) state.status = `${row.title || `session ${id.slice(0, 8)}`} ${core.attentionLabel(row.attention.kind)}${row.attention.message ? ` — ${row.attention.message}` : ''}${row.host ? ` · on ${row.machine || row.host}` : ''}`;
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

  // ---- The `:` palette: every command, and find anything — sessions, tabs, workspaces and actions ----
  // One index, typed-to-narrow with the same scattered-letters match every filtered pane uses. Enter
  // does what the row IS: a session switches to it, a tab raises it, a workspace opens the session
  // picker narrowed to it, an action does what its key does, a command runs. A typed command name
  // (`status`, `comment 12: note`) puts that command first, so `:` then a command then Enter runs it,
  // as the command line it replaced did.
  type PaletteItem = { kind: 'session' | 'tab' | 'workspace' | 'action' | 'command' | 'search'; label: string; detail: string; run: () => void };
  /** The palette's commands: the fixed ones, and the review-comment ones that take text. */
  const TEXT_COMMANDS: Readonly<Record<string, string>> = {
    comment: 'comment on the edit whose diff is shown — comment [<line>:] <note>',
    'send-comments': 'draft every unsent review comment into the reply box',
    quote: "quote the agent's last reply into the reply box",
    ignore: 'apply .observatoryignore to the reviewed session — counts, then asks before dropping',
  };
  const isCommand = (name: string): boolean => Object.hasOwn(COMMANDS, name) || Object.hasOwn(TEXT_COMMANDS, name) || name === 'comments';
  /** A text box's backspace: its last character as a reader counts them goes whole. `slice(0, -1)` took one UTF-16
   *  unit, so a pasted emoji lost half of its surrogate pair, or a family its last member and left the joiner. */
  const backspaced = (s: string): string => core.graphemeHead(s, s.length - 1);
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
    // on Review, and on the Observatory the ones both tabs share plus the Observatory's own (on the
    // Observatory "Keep the selection" once pressed `a`, which asked to accept every edit and clear the store).
    const tabId = tabs[active]?.id;
    for (const r of core.REBINDABLE) {
      if (tabId === 'observatory' ? !OBSERVATORY_SHARED.has(r.action) : tabId !== 'review' && !['session', 'options', 'help'].includes(r.action)) continue;
      // A rebind can leave an action with no key (another action took it): the row then runs the action
      // itself, where pressing keyForAction's '?' opened the help instead.
      const bound = [...coreKeymap(prefs)].some(([, a]) => a === r.action);
      const key = bound ? keyForAction(r.action) : '';
      items.push({ kind: 'action', label: r.label, detail: key, run: () => onKey({ key, ctrl: false, alt: false, ...(bound ? {} : { action: r.action }) }) });
    }
    if (tabId === 'observatory') {
      const obs: [string, string, () => void][] = [
        ['Review this session', '⌕ review', () => { const sc = state.scopeWorker; const sn = sc?.session || tabs.find((t) => t.id === 'review')?.session || state.session; reviewSession(sn, sc || undefined); }],
        ['Reply to the pinned conversation', 'c', () => void observatoryKey('c')],
        ["Go to the session's herdr pane", 't', () => void observatoryKey('t')],
        ['Pin the selected conversation', 'enter', () => void observatoryKey('enter')],
        ['Resolve the session: keep its pending edits and clear its store', 'R', () => void observatoryKey('R')],
        ["Stop the session's agent", 'X', () => void observatoryKey('X')],
        ['Show or hide archived sessions', 'B', () => void observatoryKey('B')],
        ['Choose what the focused pane shows', 'v', () => paneOp('view')],
        ['Split the focused pane side by side', '|', () => paneOp('|')],
        ['Split the focused pane stacked', '-', () => paneOp('-')],
        ['Close the focused pane', '', () => paneOp('close')],
        ['Focus the next pane', '', () => paneOp('cycle')],
        ['Zoom the focused pane', keyForAction('zoom'), () => paneOp('zoom')],
        ['Swap the focused pane with the one to its left', 'H', () => paneOp('H')],
        ['Swap the focused pane with the one below', 'J', () => paneOp('J')],
        ['Swap the focused pane with the one above', 'K', () => paneOp('K')],
        ['Swap the focused pane with the one to its right', 'L', () => paneOp('L')],
      ];
      for (const [label, detail, run] of obs) items.push({ kind: 'action', label, detail, run });
    }
    for (const [name, c] of Object.entries(COMMANDS)) if (name !== '?') items.push({ kind: 'command', label: name, detail: c.what, run: () => runCommand(name) });
    for (const [name, what] of Object.entries(TEXT_COMMANDS)) {
      // `comment` needs its note: choosing the row types the command and waits for the rest.
      items.push({ kind: 'command', label: name, detail: what, run: name === 'comment'
        ? () => { paletteOpen = true; paletteFilter = 'comment '; renderPalette(); } : () => runCommand(name) });
    }
    return items;
  }
  function renderPalette(): void {
    const f = paletteFilter.trim().replace(/^:/, '');
    const word = f.split(/\s+/)[0] ?? '';
    // A typed command runs as typed, arguments and all: it leads the list, where Enter takes it. What else the
    // words find follows it (a command's own row once, as the typed one): a session titled "Status page" was
    // hidden behind `status` taking the whole list.
    const typed: PaletteItem[] = word && isCommand(word)
      ? [{ kind: 'command', label: f, detail: '↵ runs it', run: () => runCommand(f) }] : [];
    paletteShown = [...typed, ...paletteItems.filter((it) => !(typed.length && it.kind === 'command' && it.label === f)
      && (!f || fuzzyMatch(`${it.label} ${it.detail} ${it.kind}`, f) !== null))];
    // With words typed, the last row searches every CONVERSATION for them — the
    // asks and answers behind the sessions, not just their titles.
    if (f.length >= 2) paletteShown.push({ kind: 'search', label: `search conversations for “${f}”`, detail: 'asks and answers, every session', run: () => runConversationSearch(f) });
    paletteCursor = Math.max(0, Math.min(paletteCursor, paletteShown.length - 1));
    const lines = paletteShown.map((it, i) => `${i === paletteCursor ? '> ' : '  '}${it.kind.padEnd(9)} ${it.label}${it.detail ? `  \x1b[2m${it.detail}\x1b[0m` : ''}`);
    state.overlay = {
      title: `: ${paletteFilter}▏  · a command, or type to find · ↑↓ · ↵ runs · esc`,
      lines: lines.length ? lines : ['  nothing matches'],
      scroll: Math.max(0, paletteCursor - 10),
      cursor: paletteCursor,
    };
    schedulePaint();
  }
  function openPalette(): void {
    if (state.confirm) {
      state.status = 'answer the pending question first — y or n';
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
      paletteFilter = backspaced(paletteFilter);
      return renderPalette();
    }
    if (ev.ctrl && !ev.alt && ev.key === 'v') return pasteFromClipboard();
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
    // esc closes; it takes typing, so q is text here. Every other key is the palette's and does nothing.
    if (ev.key !== 'escape') return;
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
    state.overlay = { title: placeholder, lines: ['  one moment — the first search prepares the search cache'], scroll: 0 };
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
          state.status = `search for “${q}” finished: ${hits.length} matching ask${hits.length === 1 ? '' : 's'} (: to search again)`;
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
  function searchKey(ev: { key: string; ctrl?: boolean; alt?: boolean }): void {
    ev = listKey(ev);
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
    if (ev.key !== 'escape' && ev.key !== 'q') return;
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
    // A zoomed Diff shows the edit the reader opened, and nothing is picked at launch (`picked`), so a
    // saved zoom on it restored a screen holding one hint and every other pane hidden. It is not kept.
    if (out.zoom === 'detail') out.zoom = null;
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

  // Paint with F1 available. Only a confirmed pane context removes it; inherited editor markers
  // and an unreachable server leave it available. No client starts while that decision is pending.
  let paneContextPending = Boolean(process.env.HERDR_PANE_ID);
  const paneContext = core.herdrPaneContext();
  const tabs: TabState[] = [
    { id: 'herdr', kind: 'native', name: 'herdr', command: [core.findHerdrBin() || core.herdrInstallPath(require('os').homedir(), process.platform)], panes: mkPanes() },
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

  /** herdr's keys as the herdr client this app runs reads its config: the client applies the prefix, and before 0.9.2
   *  a list of prefixes is a parse error that leaves it on its defaults. Its version is asked once. */
  let herdrClientVersion: string | null | undefined;
  const herdrConfig = (): import('@oak-observatory/core').HerdrPrefix => {
    if (herdrClientVersion === undefined) {
      const bin = tabs.find((t) => t.id === 'herdr')?.command?.[0] ?? core.findHerdrBin();
      let out = '';
      try { if (bin) out = String(core.spawnToolSync(bin, ['--version'], { encoding: 'utf8', timeout: 2000 }).stdout ?? ''); } catch { /* not known: the newest herdr's reading */ }
      herdrClientVersion = core.parseHerdrVersion(out);
    }
    return core.herdrPrefix(process.env, herdrClientVersion ?? undefined);
  };

  // A rebind saved onto a key the frame now keeps for itself (an older build allowed it) is not live:
  // said on the first status row of each launch until the reader chooses another key, so the reader
  // learns why the key does something else now. What to do comes first: a narrow terminal cuts the row.
  const blocked = Object.entries(prefs.blockedKeys ?? {});
  const blockedNotice = blocked.length
    ? `Options (${keyForAction('options')}): choose ${blocked.length === 1 ? 'another key' : 'other keys'} for ${blocked.map(([a]) => core.REBINDABLE.find((r) => r.action === a)?.label ?? a).join(', ')} — the frame now keeps your saved ${blocked.map(([, k]) => (k === ' ' ? 'space' : k)).join(', ')}`
    : null;
  // A status a key or click wrote, or any new one, is an ANSWER: for STATUS_HOLD_MS it outranks the rows
  // that otherwise stand on the status line (an error, the size note, the zoomed edit's bar). Under them,
  // `e`'s answer on a zoomed Diff was drawn nowhere, and the key looked dead (DashState.statusUntil).
  const STATUS_HOLD_MS = 5000;
  // oak sync's settings put back in prefs.json from its copy (core keptPrefs, run here first): said once, on the first
  // status row, as `oak` says it after a command, whose line this app's screen would take with it. What to do first.
  // Taken only where that row shows it: an app someone answers to, with no rebind to ask about first; else the next
  // `oak` command run in a terminal says it, and `oak doctor` does.
  const keptNotice = (() => {
    try {
      core.keptPrefs(true);
      if (once || blockedNotice || !process.stdin.isTTY || !process.stdout.isTTY) return null;
      const text = core.takeKeptPrefsNotice();
      return text ? `Quit or update that older OAK (\`oak doctor\` says where it may be running): ${text}` : null;
    } catch {
      return null;
    }
  })();
  const delegateNotice = (() => {
    if (once || !process.stdin.isTTY || !process.stdout.isTTY || blockedNotice || keptNotice) return null;
    try { return core.takeAgentSetupNotice(cwd); } catch { return null; }
  })();
  const launchNotice = blockedNotice ?? keptNotice ?? delegateNotice;
  let statusText = launchNotice ?? 'starting…';
  let inputTurn = false;
  let holdTimer: NodeJS.Timeout | null = null;
  // A new error written after the answer is the newer news: it ends the hold (the same one again, as a
  // failing read repeats it every tick, does not). A decision's own failure (actionFailed) always ends
  // it, and outlives the re-read that decision forces for as long as an answer holds.
  let errorText: string | null = null;
  let errorHeldUntil = 0;
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
    get status(): string {
      return statusText;
    },
    set status(text: string) {
      // `--once` paints one frame nobody answers to: its size note and error stay on top there.
      if (!once && (text !== statusText || inputTurn)) state.statusUntil = Date.now() + STATUS_HOLD_MS;
      // Said after a toast, it takes a row too narrow for both (statusWithToast): a new text, or a key's answer said again
      // (a quit hint re-armed, `y` with still nothing to copy); not the idle `ready` said again, as closing the help says it.
      if (!once && (text !== statusText || (inputTurn && text !== 'ready'))) state.statusAt = Date.now();
      statusText = text;
    },
    get error(): string | null {
      return errorText;
    },
    set error(text: string | null) {
      if (text && text !== errorText) state.statusUntil = 0;
      errorText = text;
    },
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
  const applyPaneContext = (context: import('@oak-observatory/core').HerdrPaneContext): void => {
    paneContextPending = false;
    if (!context.nested) return;
    const selected = tabs[active]?.id;
    const previous = tabs[lastOakTab]?.id;
    const at = tabs.findIndex(t => t.id === 'herdr');
    if (at >= 0) tabs.splice(at, 1);
    active = tabs.findIndex(t => t.id === selected);
    if (active < 0) active = tabs.findIndex(t => t.id === 'observatory');
    lastOakTab = tabs.findIndex(t => t.id === previous);
    state.hoverTab = null;
  };

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
    // The frame reads each saved machine through herdr, apart from the terminal (`herdr --machine`): ctrl+c,
    // a hangup or a deadline's SIGTERM stops those reads too, then ends this process as the signal would
    // have. Windows runs no read apart (execFileTool), and has no SIGQUIT.
    if (process.platform !== 'win32') {
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
        process.once(sig, () => { core.stopDetachedChildren(); process.kill(process.pid, sig); });
      }
    }
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
      applyPaneContext(await paneContext);
      let views: Record<string, unknown> | null = null;
      // Read-only: a one-shot prints a frame. It used to tidy herdr's tabs on the way (made a btop tab,
      // renamed and moved tabs, typed into a pane) on this machine and every saved one.
      const observatory = createObservatory(core, state, { cwd, changed() {}, status(message) { state.status = message; }, watch: false, timers: false, readOnly: true,
        workersVisible: () => !!tabs[active]?.root && leafPanes(tabs[active].root!).some(p => p.view === 'workers' || p.view === 'sessions-nav') });
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
        // No session to read (a workspace with none of its own): the frame lists every session all the same, as the live
        // app does, and its Review panes say there is nothing to review.
        if (!target) {
          listing ??= await sessionsOnce(core, cwd).catch(() => null);
          state.reviewFinding = noSessionReview();
        }
        // The listing already read is this frame's catalog: it is not read twice.
        const names = machine ? [...new Set([...onceViews, 'sessions'])] : listing ? onceViews.filter((v) => v !== 'sessions') : onceViews;
        views = await createOnce(core, cwd, target, names, machine, machine ? observatorySelection(state, target).root : undefined);
        if (machine && views) {
          state.reviewSession = (views.sessions as { sessions?: Record<string, unknown>[] } | undefined)?.sessions?.find(row => row.id === target);
          state.views = { ...views, sessions: listing?.sessions ?? await createOnce(core, cwd, target, ['sessions']).then(p => p?.sessions) };
        } else state.views = views && listing ? { ...views, sessions: listing.sessions } : views ?? (listing ? { sessions: listing.sessions } : null);
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
        // A Codex pane whose state hangs on its screen reads as the live app reads it, now that the listing is in.
        if (tabs[active]?.id === 'observatory') await observatory.readScreens();
      } catch (error) {
        state.error = String((error as Error).message || error);
        if (state.reviewMachine) state.reviewMachine.error = state.error;
        process.exitCode = 1;
      } finally { observatory.close(); }
      state.now = Date.now();
      state.status = state.error || (views ? `${target.slice(0, 8)} · one frame (--once)` : target ? 'no view data for this session' : noSessionStatus());
      for (const line of renderDashFrame(state, { cols, rows, color: colorDepth, glyphs })) {
        out.write(line + '\n');
      }
    })();
    return;
  }

  let restored = false;
  let filterOpen = false;
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
  /** Until the next try, after a disconnect or a try that failed: doubled by each failure, to a minute, and back to the
   *  first once one connects. A reconnect that failed (the server it starts not up yet where the store went) was never
   *  tried again, so focus requests went nowhere until the app restarted. */
  let focusWaitMs = FOCUS_RETRY_MS;
  let focusFailing = false;
  async function connectFocus(): Promise<void> {
    const result = await core.ensureDaemon({ client: 'tui-focus', repairOutdated: true });
    if (focusClosed) { result.client?.close(); return; }
    const again = (): void => {
      if (focusClosed) return;
      focusRetry = setTimeout(() => { void connectFocus(); }, focusWaitMs);
      focusRetry.unref();
    };
    if (!result.client) {
      if (!focusFailing) { state.status = result.why; schedulePaint(); } // said once, not at every try
      focusFailing = true;
      again();
      focusWaitMs = Math.min(focusWaitMs * 2, FOCUS_RETRY_MAX_MS);
      return;
    }
    focusFailing = false;
    focusWaitMs = FOCUS_RETRY_MS;
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
      again();
    });
    try { await client.request({ op: 'watch' }); }
    catch (e) { state.status = `focus endpoint: ${String(e)}`; schedulePaint(); }
  }
  if (!once && !args.includes('--no-server') && !process.env.OAK_NO_SERVER && !core.noBackgroundChildren()) void connectFocus();
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
    if (lastBottom && row >= lastBottom.first) return setPointer('text'); // the bottom rows select as a pane's text does
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
   *  keyboard move (H/J/K/L on the Observatory). Null when nothing lies that way. */
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

  // ---- The view picker for a pane: after a split, or v on the focused pane ----
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
  function viewPickerKey(ev: { key: string; ctrl?: boolean; alt?: boolean }): void {
    ev = listKey(ev);
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
    if (ev.key !== 'escape' && ev.key !== 'q') return;
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
  /** Find-in-diff's buffer, and whether it owns the keyboard. */
  let diffFind = '';
  let diffFindOpen = false;
  /** The options window's own state, or null when it is closed. Declared HERE, beside the rest of
   *  the runtime's state, because `paint` reads it — and `paint` runs once during setup, before any
   *  declaration further down the function body has initialised. A `let` down beside its handlers
   *  read beautifully and crashed the first frame with a temporal-dead-zone error. */
  let options: { cursor: number; scroll: number; capture: null | { id: string; kind: 'text' | 'key'; buf: string }; id?: string } | null = null;
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
    // A saved machine's herdr command (an Observatory read, a tab name) runs apart from the terminal, so
    // neither a hangup nor this exit reaches it: stopped here, or it ran on after the app. A reply being sent
    // there is the exception (keepOnExit): it finishes after the app has gone, as a send from VS Code does.
    core.stopDetachedChildren();
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

  /** When the terminal last came back from a child (resumeTerminal). */
  let resumedAt = 0;
  process.on('exit', () => {
    restore();
    // Node 22.16 aborts in ResetStdio when tcsetattr sees a hung-up terminal. After restoring, close only
    // former terminal descriptors that are no longer TTYs; live terminals and redirected output stay open.
    if (process.platform !== 'win32') for (const [fd, stream] of [process.stdin, process.stdout, process.stderr].entries()) {
      if (stream.isTTY && !isatty(fd)) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  });
  // SIGTERM, SIGHUP and SIGQUIT do NOT run 'exit' handlers, so each needs its own. SIGINT is handled
  // both ways: raw mode stops the tty driver turning ^C into a signal (so the decoder reads 0x03), but
  // an explicitly sent SIGINT still arrives here.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      // While a child has the terminal ($EDITOR, a saved machine's editor over `ssh -t`, still connecting or
      // asking for a passphrase), ctrl+c and ctrl+\ are the child's: the terminal signals its whole job, this
      // app included, and the app ended under the child it had handed the terminal to. The child's end can be
      // handled before this app's own copy of the signal, so the second after the terminal came back counts too.
      if ((sig === 'SIGINT' || sig === 'SIGQUIT') && (out.suspended() || Date.now() - resumedAt < 1000)) return;
      restore();
      process.exit(0);
    });
  }
  // A closed terminal can fail the read on stdin (EIO) before its SIGHUP arrives: the same hangup, not a crash.
  // A write to it fails the same way, which the CLI's handler on stdout takes as a hangup too. (This path runs only
  // with a terminal on stdin.)
  process.stdin.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EIO') throw e;
    restore();
    process.exit(0);
  });
  // Or the read ends: a hung-up terminal reads as the end of input. With no SIGHUP (the app in a session of its own)
  // and no paint to fail its write (a paint that changes nothing writes nothing), this is all that says it has gone.
  // A ctrl+d at a prompt read with the terminal not raw ends the read too, on a terminal still there, and a stdin that
  // never was a terminal (a pipe, under a test that sets isTTY) ends without one.
  process.stdin.on('end', () => {
    if (!(process.stdin instanceof ReadStream) || isatty(0)) return;
    restore();
    process.exit(0);
  });
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
  /** The rows the terminal shows as `paint` last wrote them, and the cursor it left. Null after anything that may have
   *  disturbed the screen — a resize, a child's turn on the terminal, the window regaining focus (a terminal's "clear
   *  buffer") — so the next paint writes every row. */
  let onScreen: { lines: string[]; cursor: string } | null = null;
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
  const QUIT_WINDOW_MS = 2000;

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
        if (!core.noBackgroundChildren() && core.dueAccountUsagePull()) {
          const pull = core.spawnTool(process.execPath, [process.argv[1], 'usage', '--pull-account', '--json'], { detached: true, stdio: 'ignore' });
          pull.on('error', () => { /* retain the last usable cache */ });
          pull.unref();
        }
        core.kickMonthRefresh(cwd); // the bill-cycle month is scanned only by the statusline — keep it live here too
        core.kickRemoteTitles(); // Remote Control titles from claude.ai: detached, throttled, never on this paint
        core.kickMachineUsage(); // the saved machines' readings of the Claude account, the same way
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
      anchorOptions(rows);
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
        lines: renderOptions(rows, options.cursor, frameCols, options.scroll, overlayRows(), glyphs, colorDepth),
        scroll: 0,
      };
    }
    updateNativeGrid();
    syncWindowTitle();
    lastBottom = null;
    const lines = renderDashFrame(state, { cols: frameCols, rows: frameRows, color: colorDepth, glyphs, bottom: (first, status) => { lastBottom = { first, status }; } });
    // The frame after the hold ends puts the standing row back.
    if (state.statusUntil && state.statusUntil > state.now && !holdTimer) {
      holdTimer = setTimeout(() => { holdTimer = null; schedulePaint(); }, state.statusUntil - state.now + 1);
      holdTimer.unref?.();
    }
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
    //
    // Only the rows that differ from what the terminal shows are written, and nothing at all when no row and no
    // cursor differs: rewriting all of them on every refresh tick and live update, most of them unchanged, made
    // the whole window flash (2026-11-05, iTerm2).
    const prev = onScreen;
    let rowsBuf = '';
    for (let i = 0; i < shown.length; i++) if (prev?.lines[i] !== shown[i]) rowsBuf += `\x1b[${i + 1};1H\x1b[K` + shown[i];
    // A NATIVE tab shows the program's OWN cursor: placed where its emulator has it, only while the
    // program shows it, and only while nothing of OAK's is drawn over the tab. A program whose caret
    // IS the terminal cursor (Claude Code's prompt) had no cursor at all inside OAK (2026-09-23).
    const nativeTab = tabs[active];
    const nativeSess = nativeTab?.kind === 'native' ? nativeSessions.get(nativeTab.id) : undefined;
    // `cursor` is optional on the session: a stand-in without an emulator simply keeps the cursor hidden.
    const cur = nativeSess && !nativeSess.ended && !state.overlay && !state.confirm ? nativeSess.cursor?.() : undefined;
    let cursor = '';
    if (cur) {
      const top = layout().tabbar.length ? 1 : 0; // the single-row tab bar above the program's screen
      const bodyH = Math.max(0, frameRows - top - chromeBottom(frameRows) + 1);
      if (cur.visible && cur.y >= 0 && cur.y < bodyH && cur.x >= 0 && cur.x < frameCols)
        cursor = `\x1b[${top + cur.y + 1};${cur.x + 1}H` + CURSOR_SHOW;
    }
    if (prev && !rowsBuf && prev.cursor === cursor) return;
    const written = out.write('\x1b[?2026h' + CURSOR_HIDE + '\x1b[H' + rowsBuf + cursor + '\x1b[?2026l');
    onScreen = written ? { lines: shown, cursor } : null;
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

  /** How a copy went, as a toast on the status row: what it copied, for 2.5 s, or for 8 s why nothing was copied. A
   *  refusal stood on the status row while the session was open, beside every later copy's toast, and on the herdr tab
   *  over herdr's last row. An empty text says nothing: herdr announces its own copies. */
  const copyToast = (text: string, ms = 2500): void => {
    if (!text) return;
    state.toast = { text, until: Date.now() + ms, at: Date.now() };
    const t = setTimeout(() => schedulePaint(), ms + 100);
    t.unref?.();
    schedulePaint();
  };
  const copyRefused = (text: string): void => copyToast(text, 8000);

  const refreshSize = (): void => {
    // Re-reading process.stdout.columns is a NO-OP: getWindowSize() returns the cached pair and only
    // _refreshSize() issues the syscall. Calling it also emits 'resize' itself, which covers both the
    // normal path and a terminal that never delivers SIGWINCH.
    try {
      (process.stdout as unknown as { _refreshSize?: () => void })._refreshSize?.();
    } catch {
      /* not available on this platform — the 'resize' listener below still applies */
    }
    const size = `${frameCols}x${frameRows}`;
    frameCols = process.stdout.columns || frameCols;
    frameRows = process.stdout.rows || frameRows;
    // A kept selection is coordinates into the OLD frame — after a resize they band whatever
    // reflowed underneath. The copy already happened at release; drop the ghost.
    state.selSpan = null;
    // So is one still held: it would copy what reflowed under it. It is dropped, and its release copies nothing; a
    // selection already drawn says so.
    if (textDrag && `${frameCols}x${frameRows}` !== size) {
      if (textDrag.moved) copyRefused('nothing copied: the terminal changed size during the selection');
      endTextDrag();
    }
  };
  process.stdout.on('resize', () => {
    onScreen = null; // the terminal reflows or clears its screen to the new size, whatever size that is
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
        // Throttled to every 30s. Outside a repo the machine-wide newest comes from the local index, as the
        // worker's last catch-up left it: walking every transcript for it (readdir + stat of every session) on
        // every 3-second tick was a measurable drag, and every 30 s still the TUI's largest scan.
        if (!flag('--session') && !process.env.CLAUDE_OBSERVATORY_SESSION && !process.env.CLAUDE_CHANGES_SESSION && Date.now() - newerSessionCheckedAt > 30_000) {
          newerSessionCheckedAt = Date.now();
          // The SAME scope the launch default used (core.defaultTuiSession): inside a repo, that
          // workspace's newest; outside any repo, the machine-wide newest (the walk only where the index
          // cannot be read here).
          const named = Boolean(flag('--root'));
          const anywhere = named || core.repoRoot(cwd) ? undefined : core.indexedNewestSession();
          const newest = anywhere === undefined ? core.defaultTuiSession(cwd, named) : anywhere ?? core.resolveSessionId(cwd);
          if (newest && newest !== state.session && newest !== newerSessionHinted && tookTurnSinceLaunch(newest)) {
            newerSessionHinted = newest;
            state.status = `a newer session is live — press ${keyForAction('session')} to switch`;
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
          // once per machine however many surfaces are open. idle-done stays quiet. A permission prompt
          // toasts only once it has stood for the desktop's wait (core.whenHandDue), as in both editors.
          // Other machines' hands too, as their records brought them: each once, naming its machine.
          const synced = syncedHandRows((payload.sessions as { syncedHands?: unknown } | undefined)?.syncedHands);
          for (const r of [...nextRows, ...synced] as { id?: unknown; title?: unknown; agent?: unknown; attention?: unknown; host?: string; machine?: string }[]) {
            const a = r.attention as { kind: HandKind; message: string; ts: number } | null | undefined;
            const id = typeof r.id === 'string' ? r.id : '';
            if (!id || !a || typeof a.ts !== 'number' || a.kind === 'idle-done') continue;
            const key = r.host ? `${id}@${r.host}` : id;
            if ((handToasted.get(key) ?? 0) >= a.ts) continue;
            handToasted.set(key, a.ts);
            const name = typeof r.title === 'string' && r.title ? r.title : `session ${id.slice(0, 8)}`;
            core.whenHandDue(id, a, () => {
              state.toast = {
                // The same keys on both OAK tabs; `h` jumps to this machine's own.
                text: `${name}${r.host ? ` on ${r.machine || r.host}` : ''} ${core.attentionLabel(a.kind)}${a.message ? ` — ${a.message}` : ''} · ${r.host ? '' : `${keyForAction('nextHand')} jumps there · `}${keyForAction('inbox')} lists every hand`,
                until: Date.now() + 8000,
                at: Date.now(),
              };
              schedulePaint();
            }, Date.now(), r.host);
            core.announceAttention({ id, title: name, agent: typeof r.agent === 'string' ? r.agent : '', attention: a, ...(r.host ? { host: r.host, machine: r.machine } : {}) });
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
        // Only when this read brought no problem: clearing and then re-setting the same standing problem
        // counted as a new error and cut every key's answer short.
        if (!err && Date.now() >= errorHeldUntil) state.error = null;
        if (state.status === 'starting…') state.status = 'ready';
        // A refresh is done once a read lands: its "refreshing…" stood on the status row long after.
        if (state.status === 'refreshing…') state.status = 'refreshed';
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
      // The launch's notice (a saved key, oak sync's settings put back) is said first, over this as over the first run's own status.
      const notice = launchNotice && state.status === launchNotice ? launchNotice : null;
      if (active === ri) {
        choosePicked(found.session, label);
        adoptOpen = true; // its own switch is not the reader's choice: a machine answering later may still outrank it
      } else {
        sessionMachines.set(found.session, label);
        tabs[ri].session = found.session;
      }
      state.status = notice ?? `Review is on ${title}${label ? ` on ${label}` : ''}, active more recently`;
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
    readSyncStatus();
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
      // Nothing resolved at launch (a first run, or a workspace with no session of its own): there is no
      // session to read, so a `views` request would only fail. Adopt the first session this machine gets
      // — the launch default's own scope — through the same switch the picker uses; until then say what
      // is missing, every poll.
      const first = core.defaultTuiSession(cwd, Boolean(flag('--root')));
      // Deferred: the launch's own first read runs before the picker's state below it is declared, and
      // `oak tui --root <dir>` from a directory with no session of its own crashed on it at startup.
      if (first && core.isSafeSessionId(first) && !state.overlay) return void queueMicrotask(() => choosePicked(first));
      // Review has nothing to read and says so. The Observatory still lists every session: the listing
      // needs no session, and this poll reads it as a session's own `views` read would.
      state.reviewFinding = noSessionReview();
      void observatory?.refreshSessions();
      // The launch's notice (a saved key, oak sync's settings put back) is said first; this one follows once anything replaces it.
      if (!launchNotice || state.status !== launchNotice) state.status = noSessionStatus();
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

  /** A decision failed: the error the reader must see, kept through the re-read the decision forces. */
  const actionFailed = (err: string | null): void => {
    state.error = err;
    state.statusUntil = 0;
    state.errorAt = Date.now(); // newer than a toast, it takes a row too narrow for both (statusWithToast)
    errorHeldUntil = Date.now() + STATUS_HOLD_MS;
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
    if (!r.ok) actionFailed(r.err);
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
    if (r.ok && typeof unrecorded === 'string') actionFailed(unrecorded);
    ask(true); // a mutation always forces a fresh read; stale counts must not outlive the action
    schedulePaint();
  };

  const applyUnder = (verb: 'keep' | 'undo' | 'redo', under: string, after?: string): void => {
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
    const session = state.session;
    void backend!.mutateUnder(verb, scope, session, machine).then(reportMutation(verb, 0)).then(() => sayAfter(after, session));
  };

  const applyMutation = (verb: 'keep' | 'undo' | 'redo', ids: number[], after?: string): void => {
    if (!reviewReady()) return;
    state.status = `${verb}ing ${ids.length} edit(s)…`;
    schedulePaint();
    // Through `reportMutation`, like the scoped path: it inlined a copy of that function's body, so
    // the "one place, one wording" its doc comment promises was true of the rarer caller only, and
    // every keyboard keep/undo/redo took the copy that had drifted.
    // The marks are SPENT here. Leaving them standing means the next `a` silently re-acts on edits the
    // reader already dealt with, and the set is not on screen once its rows have gone.
    state.marked = new Set<number>();
    const session = state.session;
    void backend!.mutate(verb, ids, session, reviewMachine(session)).then(reportMutation(verb, ids.length)).then(() => sayAfter(after, session));
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
    applyAnswer(q, yes);
    // A notice that arrived while the question stood (askSweep) is said after the answer.
    sayAfter(q.after);
  };
  /** A notice a question held back (askSweep), after the status its answer set. Work a yes starts says it again after
   *  its own result, which replaces that status, unless the reader has moved to another session since (`session`, the one
   *  it ran on), whose status reportMutation leaves standing. */
  const sayAfter = (after: string | undefined, session = state.session): void => {
    if (!after || session !== state.session || state.status.endsWith(after)) return;
    state.status = `${state.status} · ${after}`;
    schedulePaint();
  };
  const applyAnswer = (q: NonNullable<DashState['confirm']>, yes: boolean): void => {
    // A refresh that would sweep asks first; no still refreshes, and drops nothing.
    if (q.verb === 'refresh') {
      if (yes) return applySweep(q.session ?? state.session, q.machine, q.after);
      state.status = `refreshing… · kept the ${q.pending ?? 0} now-ignored edit(s)`;
      ask(true);
      return schedulePaint();
    }
    if (q.verb === 'reset' && yes) {
      saveOptions({}, APP_PREF_KEYS); // all of the app's own keys, whoever set them last; the others stay as the file has them
      state.status = 'every option is back to its default';
      return schedulePaint();
    }
    if (!yes) {
      state.status = 'cancelled';
      // The delete confirm REPLACED the picker's rows with its explanation — put the list back so
      // `n` returns to exactly the picker (filter and all) the reader pressed the key from.
      if (q.verb === 'delete' && pickerOpen) return renderSessionPicker();
      return schedulePaint();
    }
    if (q.verb === 'delete') return applyDeleteSession(q.session ?? '', q.pending ?? 0, q.seenThrough);
    if (q.verb === 'keep yours') return applySyncResolve(q.conflict ?? '');
    if (q.verb === 'take over') return applySyncRestore();
    if (q.verb === 'resolve') return applyResolve(q.session ?? state.session, q.after);
    if (q.verb === 'kill') return applyKill(q.session ?? state.session);
    if (q.verb === 'reset') return schedulePaint();
    if (q.all && (q.verb === 'keep' || q.verb === 'undo')) return applyAll(q.verb, q.after);
    if (q.under) return applyUnder(q.verb, q.under, q.after);
    return applyMutation(q.verb, q.ids as number[], q.after);
  };

  const applyAll = (verb: 'keep' | 'undo', after?: string): void => {
    if (!reviewReady()) return;
    state.status = `${verb}ing every pending edit…`;
    schedulePaint();
    const session = state.session;
    void backend!.mutateAll(verb, session, reviewMachine(session)).then(reportMutation(verb, 0)).then(() => sayAfter(after, session));
  };

  /** The refresh's ignore sweep, once confirmed: where the session's store is, then a forced re-read. */
  const applySweep = (session: string, machine?: string, after?: string): void => {
    const droppedNote = (dropped: number) => dropped > 0 ? `refreshing… · dropped ${dropped} now-ignored edit${dropped === 1 ? '' : 's'}` : 'refreshing…';
    if (machine) {
      state.status = 'refreshing…';
      void backend!.run(['ignore', '--session', session, '--json'], machine).then((out) => {
        let dropped: number | null = null;
        try { dropped = Number(JSON.parse(out).droppedNow) || 0; } catch { /* reported below */ }
        state.status = dropped === null
          ? `could not apply .observatoryignore on ${machine}: ${out.trim().split('\n').pop()?.replace(/^oak: /, '') || 'no answer'}`
          : droppedNote(dropped);
        ask(true);
        schedulePaint();
        sayAfter(after);
      });
      return schedulePaint();
    }
    let dropped = 0;
    try { dropped = core.dropIgnored(session).dropped; } catch { /* a torn store still refreshes */ }
    state.status = droppedNote(dropped);
    ask(true);
    schedulePaint();
  };

  /**
   * Refresh, applying a newly-added `.observatoryignore` to the reviewed session: counts first and asks
   * before dropping anything. Both the refresh key and `:ignore` come here.
   */
  const refreshAsking = (): void => {
    // A user-CLICKED Refresh is the safe place to apply a newly-added `.observatoryignore`.
    // Adding the file fires no capture hook, so the sweep that drops now-ignored records (capture.ts,
    // the WRITE path) never runs, and a plain refresh — a read — left them. The sweep cannot be
    // undone, so the refresh counts first and asks when it would drop anything; only HERE, never on
    // the auto-refresh tick, which must not rewrite the store under concurrent readers.
    // On the Observatory, the reviewed session is the one the Review tab shows: `state.session` there can
    // still be the launch session, which Review has since moved off.
    const igSes = (tabs[active]?.id === 'observatory' && tabs.find((t) => t.id === 'review')?.session) || state.scopeWorker?.session || state.session;
    // A session reviewed on another machine keeps its store there, so the count and the sweep run
    // there too: run here they found no store and did nothing, silently.
    const igMachine = igSes ? reviewMachine(igSes) : undefined;
    const askSweep = (would: number, late = false): void => {
      const covered = `${would} recorded edit${would === 1 ? '' : 's'} in ${igSes.slice(0, 8)}${igMachine ? ` on ${igMachine}` : ''}`;
      // Another machine's count can answer after the reader has moved on: to another question, into text being
      // typed, or to the herdr tab, whose keys are the program's. A question raised then took the next key for
      // its answer (a y meant for a keep-all, or typed into a search, dropped the records) or was not drawn at
      // all. The refresh then drops nothing, and says how many edits it kept and how to drop them.
      if (would > 0 && late && (state.confirm || state.overlay || options || filterOpen || diffFindOpen || markPending
        || claudeAsk || focusedReplyPane() || tabs[active]?.kind === 'native')) {
        state.status = `refreshed without dropping · .observatoryignore covers ${covered}, kept — ${keyForAction('refresh')} on Review asks to drop ${would === 1 ? 'it' : 'them'}`;
        // A standing question holds the status row until it is answered; its answer says this after its own.
        if (state.confirm) state.confirm.after = state.status;
        ask(true);
        return schedulePaint();
      }
      if (would > 0) {
        state.confirm = { verb: 'refresh', ids: [], session: igSes, machine: igMachine, pending: would,
          label: `drop the ${covered} that .observatoryignore covers (cannot be undone; n keeps them)` };
        return schedulePaint();
      }
      state.status = 'refreshing…';
      ask(true);
      schedulePaint();
    };
    if (igSes && igMachine) {
      state.status = 'refreshing…';
      void backend!.run(['ignore', '--dry-run', '--session', igSes, '--json'], igMachine).then((out) => {
        let j: { wouldDrop?: unknown } | null = null;
        try { j = JSON.parse(out) as { wouldDrop?: unknown }; } catch { /* not JSON: the CLI's own words, below */ }
        const would = j?.wouldDrop;
        if (typeof would === 'number' && Number.isInteger(would) && would >= 0) return askSweep(would, true);
        // No count is an error, never 0: an older build there ignores --dry-run and would have swept.
        // The refresh still re-reads; it drops nothing.
        state.status = `could not count what .observatoryignore covers on ${igMachine}: ${
          (!j && out.trim().split('\n').pop()?.replace(/^oak: /, '')) || `update OAK on ${igMachine}`} · refreshed without dropping`;
        ask(true);
        schedulePaint();
      });
      return schedulePaint();
    }
    let would = 0;
    if (igSes) { try { would = core.countIgnored(igSes); } catch { /* a torn store still refreshes */ } }
    return askSweep(would);
  };

  const applyResolve = (session: string = state.session, after?: string): void => {
    if (!reviewReady()) return;
    state.status = 'resolving the session…';
    schedulePaint();
    void backend!.resolveAll(session, reviewMachine(session)).then((r) => {
      const j = (r.json ?? {}) as Record<string, unknown>;
      if (!r.ok) actionFailed(r.err);
      else state.status = `resolved: accepted ${Number(j.accepted ?? 0)} pending, cleared ${Number(j.cleared ?? 0)} record(s)`;
      ask(true); // the map is now empty of what it just resolved; stale counts must not outlive it
      schedulePaint();
      sayAfter(after);
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
   * hides it from every enumeration AND purges its stored edits here — the agent's own transcript/rollout
   * on disk is left untouched, and `oak sessions --undelete <id>` lists the session again: without its edits, or with
   * a backup folder set, with what of them the folder holds once the next `oak sync now` brings it back (core.deleteWords).
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
      const next = core.defaultTuiSession(cwd, Boolean(flag('--root')));
      if (next && next !== id) state.session = next;
    }
    // Any tab pinned to the deleted session loses its pin and follows the terminal's session, so no tab is
    // left reviewing a session that no longer appears in any menu.
    for (const t of tabs) if (t.session === id) t.session = state.session;
    const said = core.deleteWords();
    state.status = `deleted ${id.slice(0, 8)} and purged its edits — oak sessions --undelete ${id} lists it again, ${said.folder ? said.after : 'without them'}`;
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
    // The zoomed edit was the old session's: its zoom left standing showed the new session an empty Diff
    // with every other pane hidden.
    for (const t of tabs) if (t.panes?.zoom === 'detail') t.panes = { ...t.panes, zoom: null };
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
      state.status = `Detail is showing a diff — press F5 for Traces to ${verb} an edit`;
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
    onScreen = null; // the alternate screen starts blank, and a child had the terminal before a resume
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
    resumedAt = Date.now();
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
    const picked = state.scopeWorker?.session === sessionId ? state.scopeWorker : undefined;
    pinSession(sessionId, picked?.machineId, pinLeaf, picked);
  }

  /** The conversation leaf the last pin filled; a master click fills it again (see pinSession). */
  let pinLeaf: string | undefined;
  /** All conversation entry points share this transition. Changing the master selection alone
   * never calls it. Each detail leaf keeps its own pin and scroll when the reader splits it: the
   * pin fills the focused conversation leaf, else `leaf` when it is one, else the first. A row of the session's
   * worker group the reader picked in the master (`within`: a worker, or the group's summary or a header) stays
   * picked: a worker opens its own log. */
  function pinSession(sessionId: string, machineId?: string, leaf?: string, within?: Pick<ObservatorySelection, 'agentId' | 'workers' | 'processId'>): void {
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
    const next = selectAndPin(state, sessionId, paneId, machineId, within);
    state.scopeWorker = next.scopeWorker && (within?.agentId || within?.workers)
      ? { ...next.scopeWorker, agentId: within.agentId, workers: within.workers } : next.scopeWorker;
    state.observatory = next.observatory;
    state.treeScroll = next.treeScroll;
    // Review follows the pin: switching to it — its tab, its key, `r` — shows this session, read on
    // the machine the pinned row names.
    targetReview(sessionId, next.scopeWorker ?? undefined);
    pinLeaf = paneId;
    observatory?.load(paneId);
    state.status = within?.agentId ? `worker ${within.agentId} · live log · Tab to Review` : `pinned ${state.scopeWorker?.label} · t herdr · Tab to Review`;
    schedulePaint();
  }

  function jumpHerdr(selection: ObservatorySelection): void {
    if (state.confirm) return;
    void observatory?.focus(selection).then(() => switchTab(tabs.findIndex(t => t.id === 'herdr')))
      .catch(error => { state.status = String(error.message || error); schedulePaint(); });
  }


  function viewSubagent(sessionId: string, agentId: string, machineId?: string): void {
    pinSession(sessionId, machineId, pinLeaf, { agentId });
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
      // windowsHide: false — the launcher hides a child's window on Windows, and this one is a window to show.
      const child = core.spawnTool(cmd, [dir], { stdio: 'ignore', detached: true, windowsHide: false });
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
    // A standing question keeps the tab (switchTab), and Review's session with it: `V`'s late answer moved Review to
    // another session and emptied the tab on screen until the next read, then the switch was refused.
    if (state.confirm) {
      state.status = 'answer the pending question first — y or n';
      return schedulePaint();
    }
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

  /** Whether the master draws the worker group of the session `sel` names: once its last worker has finished, a row of
   *  it the reader had picked is gone, and the keys act on the session the mark falls back to. */
  function workerGroupDrawn(sel: ObservatorySelection): boolean {
    return hasActiveWorker(observatorySessions({ ...state, allSessions: true }).find((s) => s.session === sel.session && s.machineId === sel.machineId)?.meta);
  }

  /** Open (`open`) the Observatory master's worker group whose summary is picked, or close the group of any of its
   *  rows that is picked; true when that changed it. Closing leaves the summary picked. */
  function workerFold(open: boolean): boolean {
    const picked = state.scopeWorker;
    if (!picked || !(picked.workers || picked.agentId) || (open && picked.workers !== 'all') || !workerGroupDrawn(picked)) return false;
    const fold = `workers:${picked.machineId}:${picked.session}`;
    if (state.open.has(fold) === open) return false;
    toggleOpenKey(fold);
    state.scopeWorker = { ...picked, agentId: undefined, workers: 'all' };
    return true;
  }

  /**
   * The real path a change-map row names: `abs` for an outside node, the workspace root joined to the
   * relative path otherwise, and whether it is a folder. Null for a row that is not a map node.
   */
  function mapRowTarget(row: { openPath?: string }): { path: string; dir: boolean } | { refuse: string } | null {
    if (row.openPath === undefined || row.openPath.startsWith('edits:')) return null;
    const tree = mapTree();
    const node = tree ? mapRows(tree, state.open).find((r) => r.node.path === row.openPath)?.node : null;
    if (!node) return null;
    // The legacy anonymous bucket (an older CLI's payload, no root to resolve with) names no real
    // path — joining its label to the workspace would hand the editor a directory that does not
    // exist. Refuse with the reason, per the no-silent-no-op rule this key follows.
    if (node.name === OUTSIDE && node.abs === undefined) {
      return { refuse: 'this row is the anonymous outside-workspace bucket (older CLI payload) — it names no real path' };
    }
    const cmv = view(state, 'changemap') as { summary?: { root?: unknown } } | null;
    const root = typeof cmv?.summary?.root === 'string' ? (cmv.summary.root as string) : cwd;
    return { path: node.abs ?? (node.path ? path.join(root, node.path) : ''), dir: !node.isFile };
  }

  let openingWorkspace = false;
  let workspaceGroupSelection: ObservatorySelection | undefined;
  async function openWorkspaceWindow(selection?: ObservatorySelection): Promise<void> {
    if (openingWorkspace) { state.status = 'a workspace window is already opening'; schedulePaint(); return; }
    openingWorkspace = true;
    try {
      if (!selection) throw new Error('select a session or a group naming one workspace');
      const machine = state.observatory?.machines.find(m => m.id === selection.machineId);
      if (!machine && selection.machineId && selection.machineId !== 'unresolved') throw new Error('the session’s machine is no longer listed; refresh Observatory');
      const away = machine && !machine.local ? machine.label : undefined;
      let meta = observatorySessions({ ...state, allSessions: true }).find(s => s.session === selection.session && s.machineId === selection.machineId)?.meta;
      let folder = meta?.workspacePath || selection.root;
      if (away && (!folder || meta?.workspaceExists === undefined)) {
        // --session: the CLI answers a bare listing of a machine oak sync keeps from the local index, whose rows carry the
        // `~/…` display path and no workspaceExists; asked for one session, the machine itself answers.
        const listing = JSON.parse(await backend!.run(['sessions', '--json', '--session', selection.session], away));
        meta = listing.sessions?.find((r: { id: string }) => r.id === selection.session);
        folder = meta?.workspacePath || folder;
      }
      if (!folder || (!path.isAbsolute(folder) && !path.posix.isAbsolute(folder))) throw new Error('this session has no workspace');
      const exists = away ? meta?.workspaceExists : core.workspaceDirectoryExists(folder);
      if (exists === false) throw new Error(`workspace folder is missing or unavailable${away ? ` on ${away}` : ''}: ${folder}`);
      if (exists !== true) throw new Error(`could not verify the workspace folder on ${away}; refresh its listing or update OAK there`);
      await launchGuiEditor({ away, session: selection.session, folder, workspace: true });
    } catch (e) { state.status = String((e as Error).message || e); }
    finally { openingWorkspace = false; schedulePaint(); }
  }

  /**
   * The GUI editor W runs: the GUI editor setting, else the terminal editor setting, $VISUAL or $EDITOR when it is a GUI
   * editor, else the editor whose integrated terminal this is, else the first GUI editor on PATH (core.resolveGuiEditor).
   * Throws the refusal naming the setting when there is none, or when the setting names a terminal editor.
   */
  function guiEditor(): NonNullable<ReturnType<Core['resolveGuiEditor']>> {
    const gui = core.resolveGuiEditor(prefs, process.env, detectedEditors);
    if (!gui) throw new Error(core.GUI_EDITOR_REFUSAL);
    return gui;
  }

  /**
   * Run the GUI editor on a session's workspace `folder` (the Observatory's W), or on `file` at `line` (Review's W).
   * A session on a saved machine (`away`) opens there: VS Code and Cursor through Remote-SSH from here, a JetBrains IDE
   * through Gateway on the session's project. Over SSH with no display, the status row prints the command to run on the
   * machine with the editor. The status row names the command that ran and where the GUI editor came from. Throws what
   * it cannot do, for the caller's status row.
   */
  async function launchGuiEditor(o: { away?: string; session: string; folder?: string; file?: string; line?: number; workspace?: boolean }): Promise<void> {
    const gui = guiEditor();
    const ed = gui.command;
    const parts = ed.split(/\s+/).filter(Boolean);
    const from = `GUI editor ${core.editorBin(ed)}, from ${core.GUI_EDITOR_SOURCE[gui.source]}`;
    // Window reuse belongs to the editor: never force a new window or reuse an unrelated one.
    const args = parts.slice(1).filter(a => !['-n', '--new-window', '-r', '--reuse-window', '-w', '--wait'].includes(a));
    // What the editor opens there: the folder, or the file with its line in Remote-SSH's `--goto file:line`.
    const where = o.file ? (o.line ? `${o.file}:${o.line}` : o.file) : o.folder ?? '';
    let launch = { command: parts[0], args: [...args, ...(o.file ? core.guiEditorFileArgs(ed, o.file, o.line) : [o.folder ?? ''])] };
    let after = '';
    // A Gateway link goes through the system's URL opener, which exits non-zero when nothing handles the link.
    let gatewayLink = false;
    if (o.away) {
      const away = o.away;
      state.status = o.file ? `opening ${path.basename(o.file)} on ${away}…` : `opening workspace on ${away}…`; schedulePaint();
      const binary = core.findHerdrBin();
      if (!binary) throw new Error('herdr is not installed on this machine');
      const matches = (await core.herdrMachines({ binary, timeoutMs: 15000 })).filter(m => m.label === away || m.id === away);
      if (matches.length !== 1 || !matches[0].enabled || !matches[0].target) throw new Error(`saved machine ${away} has no unique enabled SSH target`);
      const target = matches[0].target;
      const remote = core.remoteEditorLaunch([parts[0], ...args].join(' '), target, where, !o.file);
      if (remote) launch = remote;
      else if (core.isJetBrainsEditor(ed)) {
        // Gateway opens a project, not a file: Review's W opens the session's project, and says where the edit is.
        let folder = o.folder;
        if (!folder) folder = JSON.parse(await backend!.run(['sessions', '--json', '--session', o.session], away)).sessions?.find((r: { id: string }) => r.id === o.session)?.workspacePath;
        if (!folder) throw new Error(`this session has no workspace on ${away} for JetBrains Gateway to open`);
        const info = JSON.parse(await backend!.run(['editor-review', 'info', '--session', o.session, '--editor', 'jetbrains', '--json'], away));
        const connection = JSON.parse(await backend!.run(['editor-review', 'connection', '--target', target, '--json']));
        const enc = encodeURIComponent;
        const link = connection.host && connection.user && Number.isInteger(connection.port) && connection.port > 0 && connection.port <= 65535 && info.idePath?.startsWith('/') && folder.startsWith('/')
          ? `jetbrains-gateway://connect#idePath=${enc(info.idePath)}&projectPath=${enc(folder)}&host=${enc(connection.host)}&port=${connection.port}&user=${enc(connection.user)}&type=ssh&deploy=false` : null;
        if (!link) throw new Error(`Open JetBrains Gateway → SSH → New Connection on the machine with the editor; use ${target} and open ${folder}`);
        launch = { command: process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open',
          args: process.platform === 'win32' ? ['url.dll,FileProtocolHandler', link] : [link] };
        gatewayLink = true;
        if (o.file) {
          const rel = path.posix.relative(folder, o.file);
          after = `; Gateway opens the project, the edit is at ${rel && !rel.startsWith('..') ? rel : o.file}${o.line ? `:${o.line}` : ''}`;
        }
      } else throw new Error(`${parts[0]} cannot open ${o.file ? 'a file' : 'a remote workspace'} on ${away}; set code, cursor or a JetBrains IDE as the GUI editor under ${keyForAction('options')} (prefs.guiEditor)`);
    }
    if (!o.away && (process.env.SSH_CONNECTION || process.env.SSH_TTY)) {
      const host = process.env.SSH_CONNECTION?.split(/\s+/)[2] || os.hostname();
      const target = `${os.userInfo().username}@${host}`;
      const remote = core.remoteEditorLaunch(core.editorBin(ed), target, where, !o.file);
      if (!remote) throw new Error(`Open JetBrains Gateway → SSH → New Connection on the machine with the editor; use ${target} and open ${o.folder ?? where}`);
      launch = remote;
    }
    if (o.workspace) {
      const editor = core.isJetBrainsEditor(ed) ? 'jetbrains' : core.editorBin(ed).startsWith('cursor') ? 'cursor' : 'vscode';
      if (o.away) {
        const result = JSON.parse(await backend!.run(['editor-review', 'prepare', '--session', o.session, '--editor', editor, '--action', 'workspace', '--json'], o.away));
        if (!result.request || result.workspace !== o.folder) throw new Error('The workspace handoff was not written for this folder; refresh its session listing');
      } else core.writeEditorReviewRequest({ editor, session: o.session, workspace: o.folder!, action: 'workspace' });
    }
    const quote = (word: string) => /^[a-zA-Z0-9_./:@+=,-]+$/.test(word) ? word : process.platform === 'win32' ? `'${word.replace(/'/g, "''")}'` : `'${word.replace(/'/g, "'\\''")}'`;
    const ran = (process.platform === 'win32' ? '& ' : '') + [launch.command, ...launch.args].map(quote).join(' ');
    const noGui = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY) || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
    // Which editor and why first: the command can be long enough for the status row to cut it.
    if (noGui) { state.status = `${from}${after}. Run on the machine with the editor: ${ran}`; return; }
    await new Promise<void>((resolve) => {
      const child = core.spawnTool(launch.command, launch.args, { stdio: 'ignore', cwd, detached: true, windowsHide: false });
      child.once('error', (e: Error) => { state.status = `Could not run ${ran}: ${e.message}. Run on the machine with the editor: ${ran}`; resolve(); });
      child.once('spawn', () => { state.status = `${from}${after} — ran ${ran}`; child.unref(); resolve(); });
      if (gatewayLink) child.once('exit', (code: number | null) => {
        if (!code) return;
        state.status = `Could not open the Gateway link (is JetBrains Gateway or Toolbox installed?): ${ran}`; schedulePaint();
      });
    });
  }

  /**
   * Review's W: the focused selection (as `e` picks it) in the GUI editor, at the selected edit's first changed line —
   * from the Diff on screen when it shows that edit, else fetched. A file header or a Map row opens with no line.
   */
  let openingGuiFile = false;
  async function openSelectionInGuiEditor(): Promise<void> {
    if (openingGuiFile) return;
    const row = rowsOf()[state.cursor];
    const onDiff = state.panes?.focus === 'detail';
    let target = onDiff ? '' : selectedPath(row);
    let id = !onDiff && row?.key.startsWith('e') && row.ids.length === 1 ? row.ids[0] : undefined;
    let mapDir = false;
    if (!onDiff && !target && row) {
      const map = mapRowTarget(row);
      if (map && 'refuse' in map) { state.status = map.refuse; return schedulePaint(); }
      if (map) { target = map.path; mapDir = map.dir; }
    }
    if (!target && state.diffMeta?.path) { target = state.diffMeta.path; id = state.diffMeta.id; }
    if (!target) { state.status = 'select an edit first — there is no file here to open'; return schedulePaint(); }
    openingGuiFile = true;
    try {
      const session = state.session;
      const machine = reviewMachine(session);
      let line = 0;
      if (id !== undefined) {
        const patch = state.diffMeta?.id === id && state.diffPatch !== undefined ? state.diffPatch : await backend!.diff(id, session, machine);
        line = firstChangedLine(patch);
      }
      await launchGuiEditor(mapDir ? { away: machine, session, folder: target } : { away: machine, session, file: target, line });
    } catch (e) { state.status = String((e as Error).message || e); }
    finally { openingGuiFile = false; schedulePaint(); }
  }

  function openInEditor(): void {
    const row = rowsOf()[state.cursor];
    // The FOCUSED pane's selection names the file; the diff on screen does only when the Diff pane has
    // focus, or when the row names no file (a Prompts row). The diff used to win everywhere, so once an
    // edit's diff was open, `e` on another Map row opened the diff's file again.
    const onDiff = state.panes?.focus === 'detail';
    let target = onDiff ? '' : selectedPath(row);
    let mapDir = false; // a map FOLDER — openable only by editors that accept a directory
    if (!onDiff && !target && row) {
      // A change-map row. Folders are offered too (VS Code and friends open one); the tty branch
      // below says why not rather than silently no-opping.
      const map = mapRowTarget(row);
      if (map && 'refuse' in map) {
        state.status = map.refuse;
        return schedulePaint();
      }
      if (map) {
        target = map.path;
        mapDir = map.dir;
      }
    }
    if (!target) target = state.diffMeta?.path || '';
    if (!target) {
      state.status = 'select an edit first — there is no file here to open';
      return schedulePaint();
    }
    // The READER'S OWN SETTING FIRST, then the environment. This read only the environment, so the
    // options window's editor row was decorative: you could pick one, it persisted to prefs.json, and
    // `e` still answered "no $EDITOR set". The row's own help has always promised this precedence
    // ("Blank follows $VISUAL then $EDITOR") — the key never honoured it.
    const ed = prefs.editor?.trim() || process.env.VISUAL || process.env.EDITOR;
    if (!ed) {
      // Name the fix that is one keystroke away before the one that needs a shell restart.
      state.status = `no editor set — press ${keyForAction('options')} and pick one under Terminal editor, or export $EDITOR`;
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
    // A session reviewed on another machine names paths on THAT machine; an editor here would open
    // an empty buffer at a path that does not exist (and create it on save). It opens there instead.
    const away = reviewMachine(state.session);
    if (away) return void openOnMachine(away, ed, target, mapDir);
    launchEditorHere(ed, [target]);
  }

  /**
   * Run the reader's editor here on `targets`. A GUI editor opens its own window and returns. Suspending this terminal
   * for a fork-and-return child is one full flash of the alternate screen for nothing — so it is spawned DETACHED, the
   * dashboard never blinks, and the status row says where the files went. Terminal editors get the real terminal,
   * inherited, and this process waits (below).
   */
  function launchEditorHere(ed: string, targets: string[]): void {
    // Split on whitespace so `EDITOR="code -w"` works. No shell: a path with a space in it must not
    // become two arguments, and these come from the store rather than from the reader.
    const parts = ed.split(/\s+/).filter(Boolean);
    if (core.editorKind(ed) === 'gui') {
      let win;
      try {
        // windowsHide: false — the editor's window is the point; the launcher would start it hidden on Windows.
        win = core.spawnTool(parts[0], [...parts.slice(1), ...targets], { stdio: 'ignore', cwd, detached: true, windowsHide: false });
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
      // windowsHide: false — an editor not known to be a GUI one is run here and waited on, and may still be one
      // (notepad): started hidden on Windows, it would hold the app with no window to close.
      child = core.spawnTool(parts[0], [...parts.slice(1), ...targets], { stdio: 'inherit', cwd, windowsHide: false });
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
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resumeTerminal();
      if (failed) {
        state.status = failed; // the spawn never happened; 'close' says nothing about it
      } else if (code || signal) {
        // A non-zero exit is not a crash of ours, but it is not "back from" either — the reader's
        // editor refused, and the file may be unsaved. Nor is one that ctrl+c stopped (the app stays).
        state.status = `${parts[0]} ${signal ? `was stopped (${signal})` : `exited ${code}`}`;
      } else {
        state.status = `back from ${parts[0]}`;
      }
      schedulePaint();
    });
  }

  /** Open `files` in the reader's editor here: the options window's editor first, then $VISUAL and $EDITOR, as `e` does. */
  function openInEditorHere(files: string[]): void {
    const ed = prefs.editor?.trim() || process.env.VISUAL || process.env.EDITOR;
    if (!ed) {
      state.status = `no editor set — press ${keyForAction('options')} and pick one under Terminal editor, or export $EDITOR`;
      return schedulePaint();
    }
    launchEditorHere(ed, files);
  }

  /**
   * `e` on a session reviewed on a saved machine: the file opens where it lives. A terminal editor runs
   * there over `ssh -t`, with this terminal handed over as the local launcher hands it; VS Code and
   * Cursor open it from here through their own Remote-SSH (core.remoteEditorLaunch). The ssh target is
   * herdr's saved machine, the one `--machine` reaches. Every outcome, the command that ran included,
   * lands on the status row. One at a time: a second `e` (or key autorepeat) while the first is still
   * reading the machine list would start a second editor on this one terminal.
   */
  let openingOnMachine = false;
  async function openOnMachine(label: string, ed: string, file: string, dir: boolean): Promise<void> {
    if (openingOnMachine) return;
    openingOnMachine = true;
    try {
      await launchOnMachine(label, ed, file, dir);
    } finally {
      openingOnMachine = false;
    }
  }

  /** openOnMachine's one launch: settles once a terminal editor there has given this terminal back. */
  async function launchOnMachine(label: string, ed: string, file: string, dir: boolean): Promise<void> {
    const bin = ed.trim().split(/\s+/)[0];
    const refuse = `${bin} cannot open a file on ${label} — a terminal editor such as nvim, vim or hx runs there over ssh, and code or cursor open it through Remote-SSH: pick one under ${keyForAction('options')}, or run oak attach ${label}`;
    if (!core.remoteEditorKind(ed, dir)) {
      state.status = refuse;
      return schedulePaint();
    }
    state.status = `opening ${path.basename(file)} on ${label}…`;
    schedulePaint();
    let target = '';
    try {
      const herdr = core.findHerdrBin();
      if (!herdr) throw new Error('herdr is not installed on this machine');
      const matches = (await core.herdrMachines({ binary: herdr, timeoutMs: 15000 })).filter((x) => x.label === label || x.id === label);
      // As `--machine` refuses it: two saved machines answer to this name, and either could be meant.
      if (matches.length > 1) throw new Error(`ambiguous saved machine "${label}" — give it a unique label in herdr`);
      const m = matches[0];
      if (!m) throw new Error(`no saved machine "${label}" (oak machine list)`);
      if (!m.enabled) throw new Error(`saved machine "${label}" is disabled in herdr`);
      target = m.target;
    } catch (e) {
      state.status = `could not open ${path.basename(file)} on ${label}: ${String((e as Error)?.message || e)}`;
      return schedulePaint();
    }
    const launch = core.remoteEditorLaunch(ed, target, file, dir);
    if (!launch) {
      state.status = `could not open ${path.basename(file)} on ${label}: invalid ssh target "${target}"`;
      return schedulePaint();
    }
    const ran = [launch.command, ...launch.args].join(' ');
    if (launch.kind === 'gui') {
      let win;
      try {
        win = core.spawnTool(launch.command, launch.args, { stdio: 'ignore', cwd, detached: true, windowsHide: false }); // a window to show
      } catch (e) {
        state.status = `could not run ${ran}: ${String((e as Error)?.message || e)}`;
        return schedulePaint();
      }
      win.on('error', (e: Error) => {
        state.status = `could not run ${ran}: ${e.message}`;
        schedulePaint();
      });
      win.unref();
      state.status = `opened ${path.basename(file)} on ${label} in ${bin} — ran ${ran}`;
      return schedulePaint();
    }
    suspendTerminal();
    let child;
    try {
      // `direct`: ssh is a real executable, and the Windows shell route would drop the command's quotes.
      child = core.spawnTool(launch.command, launch.args, { stdio: 'inherit', cwd, direct: true, env: core.machineSshEnv() });
    } catch (e) {
      resumeTerminal();
      state.status = `could not run ${ran}: ${String((e as Error)?.message || e)}`;
      return schedulePaint();
    }
    let failed = '';
    child.on('error', (e: Error) => {
      failed = `could not run ${ran}: ${e.message}`;
      resumeTerminal();
      state.status = failed;
      schedulePaint();
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resumeTerminal();
      // ssh exits 255 when it cannot connect, and otherwise with the editor's own status. ctrl+c while it
      // connects or asks for a passphrase stops it, and the app stays.
      state.status = failed || (signal ? `${bin} on ${label} was stopped (${signal}) — ran ${ran}`
        : code ? `${bin} on ${label} exited ${code} — ran ${ran}` : `back from ${bin} on ${label} — ran ${ran}`);
      schedulePaint();
    });
    await new Promise((resolve) => child.once('close', resolve).once('error', resolve));
  }

  /**
   * `r` on the Agent pane: hand the WHOLE terminal to `claude --resume <session>`, in the session's own workspace.
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
   * Exiting Claude (`/exit`, ctrl+c) returns instantly, and `r` relaunches `--resume` just as
   * fast, so the loop is cheap. A true in-place toggle means owning Claude under a PTY and swapping
   * screens — a real feature with a native-dependency decision (node-pty vs the zero-native-deps
   * rule), queued for 0.10 rather than faked here.
   */
  function launchClaude(fork: boolean): void {
    const ws = sessionRoot();
    if (!ws) {
      // Refuse, loudly. This session's transcript is not under any workspace this machine can see —
      // resuming it from some other directory would hand a writer the wrong tree.
      state.status = `this session's workspace is not on this machine — resuming needs it to run Claude there`;
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
    // The poll lists this machine's sessions every tick unless Review is reading another machine's, or there is no
    // session to read: then a store write lists them again here, as it starts a session's own read.
    processesVisible: () => tabs[active]?.id === 'observatory',
    // The Observatory Sessions tree also renders fleet states and queued workers.
    workersVisible: () => {
      const tab = tabs[active];
      return !!tab?.root && treeGeom(tab.root).tl.placements.some(p => p.view === 'workers' || p.view === 'sessions-nav');
    },
    visibleProcesses: paneId => {
      const tab = tabs[active];
      if (tab?.id !== 'observatory' || !tab.root) return [];
      const pl = treeGeom(tab.root).tl.placements.find(p => p.id === paneId);
      if (!pl) return [];
      const boxed = pl.view !== 'sessions-nav' && glyphs.boxes && pl.rect.w >= 4 && pl.rect.h >= 3;
      const rows = treePaneRows(state, pl.view, pl.rect.w - (boxed ? 2 : 0), glyphs, colorDepth, pl.id);
      const height = treePaneBodyHeight(state, pl, glyphs);
      const scroll = Math.max(0, Math.min(state.treeScroll?.[paneId] ?? 0, Math.max(0, rows.length - height)));
      return rows.slice(scroll, scroll + height).flatMap(row => row.scope?.processId ? [row.scope.processId] : []);
    },
    catalogFresh: () => !state.reviewMachine && !!state.session,
    catalog: (sessions) => { localCatalog = sessions; } });
  void observatory.start().catch(() => undefined).then(() => { searched = true; machinesChanged(); schedulePaint(); });
  enterTerminal();
  out.write('\x1b]11;?\x07'); // ask the terminal its background — the reply event above consumes it
  refreshSize();
  paint(); // immediately, before any data: a blank terminal for several seconds reads as hung
  // An undecided check (the process table too slow to read) is asked again a few times, the herdr tab still starting no
  // client meanwhile, before the app settles on it; a decided one applies at once. A herdr that does not answer in time
  // is decided (outside herdr) and cached, so no later check waits on it again.
  const settlePane = (context: import('@oak-observatory/core').HerdrPaneContext, tries = 0): void => {
    if (restored) return;
    if (context.unknown && tries < 4) {
      setTimeout(() => { void core.herdrPaneContext().then(next => settlePane(next, tries + 1)); }, 500 * 2 ** tries);
      return;
    }
    applyPaneContext(context);
    ask();
    schedulePaint();
  };
  void paneContext.then(context => settlePane(context));
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

  /** One input event, with what it writes to the status line counted as an answer (`inputTurn`). */
  const onInput = (ev: InputEvent | NativeKeyEvent): void => {
    inputTurn = ev.t === 'key' || (ev.t === 'mouse' && ev.kind === 'down');
    try {
      onEvent(ev);
    } finally {
      inputTurn = false;
    }
  };
  const onEvent = (ev: InputEvent | NativeKeyEvent): void => {
    if (ev.t === 'key' && 'event' in ev && (ev.event === 'release' || ev.super || ev.hyper || ev.meta)) return;
    // Acting in the Review tab settles what it reviews: the launch no longer moves it (adoptNewestAnywhere).
    // Leaving it is not acting in it: quit, the tab-switch keys (Tab, shift+Tab, ctrl+n/ctrl+p,
    // alt+<digit>, F1 to F3), the tab bar and a click's release are exempt.
    if (tabs[active]?.id === 'review'
      && !(ev.t === 'key' && ((ev.ctrl && ['q', 'n', 'p'].includes(ev.key)) || (ev.alt && /^[1-9]$/.test(ev.key))
        || (!ev.ctrl && !ev.alt && (ev.key === 'tab' || ev.key === 'backtab')) || !!tabKeyOf(ev)))
      && (ev.t === 'key' || ev.t === 'paste' || (ev.t === 'mouse' && ev.kind !== 'move' && ev.kind !== 'up' && hitTest(layout(), ev.col, ev.row)?.t !== 'tabbar'))) adoptOpen = false;
    // Global quit also bypasses typing walls such as the palette and view picker. An AUTO-REPEAT is
    // the same press still held down, never a second one: holding ctrl+q armed the confirmation and
    // then answered it with its own repeat, so one press exited and took an unsent draft with it
    // Legacy events carry no `event` field and are presses by construction.
    if (ev.t === 'key' && ev.ctrl && !ev.alt && !ev.shift && ev.key === 'q') {
      if (!('event' in ev) || ev.event === 'press') requestQuit('ctrl+q');
      return;
    }
    // OAK's tab keys, F1 to F3, from every tab and over every overlay below, each of which owns the rest of the keyboard.
    // An auto-repeat is the same press still held down: it raises nothing again.
    if (ev.t === 'key') {
      const tab = tabKeyOf(ev);
      if (tab) {
        if (!('event' in ev) || ev.event === 'press') tabKeyPressed(tab);
        return;
      }
    }
    // ^C quits from over these overlays too, as it does from every other mode.
    if (ev.t === 'key' && ev.ctrl && !ev.alt && ev.key === 'c' && (searchOpen || viewPickOpen || paletteOpen || inboxOpen)) return onKey(ev);
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
    // The window regaining focus repaints every row, so a terminal's "clear buffer" heals. Before the routing below:
    // on a native tab the report goes on to the program too.
    if (part.events.some(ev => ev.t === 'focus' && ev.focused)) { onScreen = null; schedulePaint(); }
    const tab = tabs[active];
    const sess = tab?.kind === 'native' ? nativeSessions.get(tab.id) : undefined;
    // A held button's motion and release go wherever its press went (buttonHeld). A release, the next press, or motion
    // with no button held ends the hold. That motion means the release was let go outside the window: OAK takes it as
    // the release of a selection of its own (onMouse), and the program gets it only where any motion would reach it.
    const first = part.events[0];
    const mouse = first?.t === 'mouse' ? first : undefined;
    const lost = mouse?.kind === 'move' && mouse.button === 3;
    const holder = mouse?.kind === 'up' || (mouse?.kind === 'move' && !(lost && buttonHeld === 'program')) ? buttonHeld : null;
    const programWasHolding = buttonHeld === 'program';
    if (mouse?.kind === 'up' || mouse?.kind === 'down' || lost) buttonHeld = null;
    if ((mouse?.kind === 'down' && mouse.button === programLetGo) || lost) programLetGo = null;
    const key = part.events.find(ev => ev.t === 'key');
    // ctrl+q is OAK's on every tab (unless herdr's prefix is ctrl+q: herdrPrefixPart). ctrl+a is the program's (line start in both agents): OAK has no
    // leader of its own, and on the herdr tab it listens on herdr's prefix instead.
    const ownKey = key?.t === 'key' && key.ctrl && !key.alt && !key.shift &&
      !('super' in key && (key.super || key.hyper || key.meta)) && key.key === 'q';
    // On the herdr tab OAK's tab keys go first, as a click on its tab bar does; then a held ctrl+q (its second press
    // quits; anything else sends it on), then herdr's prefix, then a first ctrl+q, which arms the quit and is held. The
    // program's own motion and release reach it wherever they are let go (holder).
    const heldByProgram = holder === 'program';
    if (sess && !sess.ended && !state.overlay && tab.id === 'herdr'
      && (herdrTabKeyPart(part) || (quitHeld && herdrQuitPart(part, sess, heldByProgram)) || herdrPrefixPart(part, sess, heldByProgram)
        || (ownKey && herdrQuitPart(part, sess, heldByProgram)))) return;
    if (sess && !sess.ended && !state.overlay && !ownKey) {
      // Only actual mouse events need coordinates. In particular a pasted escape sequence is text.
      if (!mouse) { sess.write(part.bytes); return; }
      // A selection on OAK's bottom rows holds the pointer until its release, wherever it goes: its motion over the
      // program's screen must not reach the program as a drag it never saw begin.
      if (holder === 'oak') { for (const ev of part.events) onInput(ev); return; }
      // A drag in the program's screen let go over OAK's rows ends in the program, on the nearest row of its screen that
      // OAK shows: herdr kept such a selection highlighted and copied nothing, and a program reading the mouse got a press
      // with no release.
      if (heldByProgram) {
        for (const mousePart of translateNativeMouse(part.bytes, ...nativeBodyRows(), undefined, true).parts) if (mousePart.target === 'pty') toProgram(sess, mousePart.bytes);
        return;
      }
      if (programLetGo !== null && (mouse.kind === 'move' || mouse.kind === 'up') && mouse.button === programLetGo) {
        if (mouse.kind === 'up') programLetGo = null;
        return;
      }
      // A press while a selection of OAK's is armed means its release was lost: the selection is dropped, as onMouse
      // drops it, and the press goes where any press goes, as the wheel does.
      if (textDrag && mouse.kind === 'down') {
        textDrag = null;
        schedulePaint();
      }
      const translated = translateNativeMouse(part.bytes, ...nativeBodyRows());
      const reaches = translated.parts.some((p) => p.target === 'pty');
      // Two buttons at once: a press on OAK's rows or tab bar while the program holds a button lets go of that one first,
      // and the rest of that button's gesture is no one's (programLetGo).
      if (mouse.kind === 'down' && programWasHolding && !reaches) letProgramGo(sess);
      for (const mousePart of translated.parts) {
        if (mousePart.target === 'chrome') { for (const ev of part.events) onInput(ev); }
        else toProgram(sess, mousePart.bytes);
      }
      if (mouse.kind === 'down') buttonHeld = reaches ? 'program' : 'oak';
      return;
    }
    if (mouse?.kind === 'down') buttonHeld = 'oak';
    for (const ev of part.events) onInput(ev);
  };
  /** The rows of a native tab's program that the last frame showed: below the single-row tab bar, above OAK's divider.
   *  A status row that speaks takes the program's last row, under the divider (bottomChrome), and what the reader sees
   *  there is OAK's. */
  const nativeBodyRows = (): [top: number, body: number] => {
    const lay = layout();
    const top = lay.tabbar.length ? 1 : 0;
    const body = Math.max(0, lay.rows - top - lay.chrome.bottom + 1);
    return [top, lastBottom ? Math.max(0, Math.min(body, lastBottom.first - 1 - top)) : body];
  };
  /** Whether a part with a mouse report in it reaches the program's screen: a click on OAK's tab bar, or on
   *  the rows under the program's screen, never does; the motion and release of a button the program holds (`held`)
   *  always do. */
  const reachesProgram = (part: NativeInputPart, held = false): boolean =>
    translateNativeMouse(part.bytes, ...nativeBodyRows(), undefined, held).parts.some((p) => p.target === 'pty' && p.bytes.length > 0);

  process.stdin.on('data', (buf: Buffer) => {
    // A verb run on the terminal (runOnTerminal) has its last words on screen until Enter.
    if (holdForEnter) {
      // Enter, or ctrl+d / ctrl+c: each means "back to OAK" here (raw mode reads them as keys).
      if (buf.includes(13) || buf.includes(10) || buf.includes(4) || buf.includes(3)) holdForEnter();
      return;
    }
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    // Route each key in order: herdr's prefix and its following CSI-u key can share or span reads, and a
    // native key after the prefix's tab switch belongs to the newly active tab.
    for (const part of input.push(buf)) routeInput(part);
    if (input.pending() === '\x1b') {
      escTimer = setTimeout(() => {
        escTimer = null;
        for (const part of input.flush()) routeInput(part);
      }, 50);
      escTimer.unref?.();
    }
  });

  /** The lines an overlay's list gets under its title, measured from the frame's own chrome. */
  const overlayRows = (): number => overlayListRows(state, layout(), frameCols, frameRows, glyphs);
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

  /** Advance a tree tab's focus to the next VISIBLE pane (fold/zoom-aware, via treeGeom). Run by the
   *  palette's “Focus the next pane” row. */
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
    workspaceGroupSelection = undefined;
    const root = tabs[active]?.root;
    if (!root) return;
    const master = () => treeGeom(root).tl.placements.find((p) => p.view === 'sessions-nav');
    // Each session once, in painted order, with the rows of its entry: its first listing and the rows
    // right after it. A fold that lists the session again further down is not part of its entry. Each of its
    // worker group's rows drawn under it (its summary, a state's header, a worker) is an entry of its own, so the
    // arrows pick it as they pick a session.
    const entryKey = (sc: ObservatorySelection | string): string => typeof sc === 'string' ? sc : `${sc.machineId}:${sc.session}:${sc.workers ?? ''}:${sc.agentId ?? ''}`;
    const sessionsIn = (rows: DashRow[]) => {
      const uniq: (ObservatorySelection | string)[] = [];
      const span = new Map<string, [number, number]>();
      rows.forEach((r, i) => {
        const sc = r.scope ?? (r.openPath?.startsWith('done:') && !r.cont ? r.openPath : undefined);
        if (!sc) return;
        const key = entryKey(sc);
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
    const at = (sc: ObservatorySelection | string): number => uniq.findIndex((s) => entryKey(s) === entryKey(sc));
    // A picked row of a worker group that is no longer drawn (its worker finished, or its group closed): the
    // arrows go on from its session.
    let cur = state.observatoryFold ? at(state.observatoryFold) : state.scopeWorker ? at(state.scopeWorker) : -1;
    if (cur < 0 && state.scopeWorker) cur = at({ ...state.scopeWorker, agentId: undefined, workers: undefined });
    // From no selection, `down` lands on the first row and `up` on the last — the natural first step.
    const start = cur < 0 ? (dir > 0 ? -1 : uniq.length) : cur;
    const pick = uniq[Math.max(0, Math.min(uniq.length - 1, start + dir))];
    state.observatoryFold = typeof pick === 'string' ? pick : undefined;
    state.scopeWorker = typeof pick === 'string' ? null : pick;
    // Review follows the cursor as it follows a pin: the session the Observatory
    // shows is the one the Review tab opens on, read on the machine its row names.
    if (typeof pick !== 'string' && tabs[active]?.id === 'observatory') targetReview(pick.session, pick);
    state.status = typeof pick === 'string' ? 'Done sessions — Enter opens or closes them' : pick.workers === 'all' ? `${pick.label} · its workers — Enter opens or closes them` : `${pick.label} — Enter pins its conversation`;
    // Measure only now: a status that speaks takes the tree's last row, and the selection decides which
    // rows exist (a selected session surfaces under its machine while its fold is closed).
    pl = master() ?? pl;
    const rows = treePaneRows(state, pl.view, pl.rect.w, glyphs, colorDepth, pl.id);
    // Keep the pick visible: its pane line, title and metrics line inside the pane body, above the
    // `+N more` hint that takes the body's last row while rows remain below. Moving up brings the
    // workspace and machine headers directly above it into view too, so the pick shows whose it is.
    const bodyH = Math.max(1, pl.rect.h - 1);
    const [first, last] = sessionsIn(rows).span.get(entryKey(pick)) ?? [0, 0];
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
    if (tab?.id === 'herdr' && paneContextPending) {
      state.nativeGrid = null;
      state.nativeNote = null;
      return;
    }
    if (tab?.kind !== 'native') {
      state.nativeGrid = null;
      state.nativeNote = null;
      // Off a remote tab: detach, so the server stops pushing rows nobody paints. The program runs on.
      return;
    }
    const herdrKeys = tab.id === 'herdr' ? herdrConfig() : undefined;
    state.herdrPrefix = herdrKeys?.label;
    // No way back by key when herdr's prefix is one this reader cannot follow from every terminal (ctrl+shift on a letter
    // needs the kitty keyboard protocol): the hint says to click instead.
    state.herdrBack = herdrKeys ? (herdrKeys.prefix ? herdrKeys.oak[0] ?? null : null) : undefined;
    state.herdrTabs = herdrKeys ? core.OAK_TAB_KEYS.filter((k) => !herdrKeys.tabTaken[k]) : undefined;
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
      if (nativeFailed.has(tab.id)) return fail(launchFailed);
      // The session's root when it exists on this machine (a synced session's root may not — see spawnCwd).
      const ws = spawnCwd(sessionRoot());
      // OAK_TAB names this tab (+ our pid, so a restarted app never inherits an old link); the agent's
      // hooks inherit it and record which session runs here — the auto-title's link.
      // The herdr tab's client auto-starts the server when none runs, and a server born inside a
      // Claude Code session carries that session's identity into every pane (see
      // core's stripSessionIdentity) — so the identity is dropped from the spawn, not passed on.
      const identityStrip = tab.id === 'herdr'
        ? Object.fromEntries(Object.keys(process.env).filter((k) => core.isSessionIdentityKey(k)
          || ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV'].includes(k)).map((k) => [k, undefined]))
        : {};
      const spawned = spawnNative(cmd[0], cmd.slice(1), lay.cols, bodyH, ws, tab.name ?? cmd[0], { ...identityStrip, OAK_TAB: `${tab.id}@${process.pid}` });
      if (!spawned) {
        nativeFailed.add(tab.id); // don't retry the spawn on every paint
        return fail(launchFailed);
      }
      spawned.onUpdate(() => schedulePaint());
      // Background panes and covered screens stay quiet; the writer also gates terminal handovers.
      spawned.onBell?.(() => {
        if (tabs[active]?.id === tab.id && !state.overlay && !state.confirm) out.write('\x07');
      });
      // What herdr copies as OSC 52 (its own selection, or what a program in its pane wrote) goes on through OAK's own
      // door, to the terminal OAK runs in. herdr shows that it copied, so OAK adds no toast; it says only a copy it
      // cannot make.
      spawned.onClipboard?.((text) => copyText(text, ''));
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
    state.nativeNote = sess.ended ? `${tab.name ?? 'the program'} exited — Tab or ctrl+n goes to OAK's tabs` : null;
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
  /** One copy process at a time on each path, tmux's buffer and the system's tools: while one runs the newest copy
   *  waits, and an older one waiting is dropped, since only the newest would stay on the clipboard. A program in herdr's
   *  pane that writes the clipboard on every change started a process for every write. A process that has not finished
   *  in ten seconds holds its path no longer: it is stopped (`stop`, which a copy sets for the process it runs), a toast
   *  says that nothing was copied, and what it does after is not heard. Failing late, it ran the next tool with its older
   *  text after a newer copy. */
  const copying: Record<'tmux' | 'tools', { busy: boolean; next: ((done: () => void) => void) | null; stop: (() => void) | null }> = {
    tmux: { busy: false, next: null, stop: null },
    tools: { busy: false, next: null, stop: null },
  };
  const oneCopyAtATime = (via: 'tmux' | 'tools', run: (done: () => void) => void): void => {
    const lane = copying[via];
    if (lane.busy) {
      lane.next = run;
      return;
    }
    lane.busy = true;
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(stuck);
      lane.busy = false;
      const next = lane.next;
      lane.next = null;
      if (next) oneCopyAtATime(via, next);
    };
    const stuck = setTimeout(() => {
      lane.stop?.();
      done();
    }, 10_000);
    stuck.unref?.();
    run(done);
  };
  /** What a copy says when the ten-second release stopped its process: nothing reached the clipboard. herdr said that it
   *  copied, so a copy of herdr's is named. */
  const copyStopped = (cmd: string, doneMsg: string, refuseTail: string): void =>
    copyRefused(`${doneMsg ? 'nothing copied' : "herdr's copy did not reach the clipboard"}: ${cmd} did not finish in 10 s${refuseTail}`);
  /**
   * The ONE clipboard door (adopted from herdr). Within the OSC 52 ceiling: the escape,
   * which works locally and remotely alike. Past it, on a LOCAL terminal: pipe to the platform's
   * own tool (wl-copy → xclip → pbcopy — first present wins), because the ceiling exists only for
   * the escape. Past it remotely, or with no tool: the same loud refusal as ever — never truncate.
   * An empty `doneMsg` is a copy herdr made: herdr says so itself, so OAK adds no toast, and a refusal names herdr's copy.
   */
  const copyText = (text: string, doneMsg: string, refuseTail = ''): void => {
    const payload = Buffer.from(text, 'utf8').toString('base64');
    const plan = clipboardPlan(payload.length, { remote: REMOTE_CLIPBOARD, platform: process.platform, tmux: !!process.env.TMUX });
    if (plan.via !== 'tmux') return copyVia(plan, text, payload, doneMsg, refuseTail);
    // THROUGH tmux, never past it: under the default `set-clipboard external` tmux IGNORES an
    // inner application's OSC 52 — the escape died in tmux while the toast said "copied"
    // (verified live). `load-buffer -w` is tmux's own door: the paste buffer gets
    // the text unconditionally (prefix ] pastes), and tmux forwards it to the outer terminal's
    // clipboard — its OWN copies are exactly what `external` permits. A failed spawn (a tmux too
    // old for `-w`) falls back to the ordinary ladder.
    oneCopyAtATime('tmux', (done) => {
      const fallback = (): void => {
        const p = clipboardPlan(payload.length, { remote: REMOTE_CLIPBOARD, platform: process.platform });
        if (p.via !== 'tmux') copyVia(p, text, payload, doneMsg, refuseTail); // tmux can't recur: the flag is off
        done();
      };
      let child;
      try {
        child = core.spawnTool('tmux', ['load-buffer', '-w', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
      } catch {
        return fallback();
      }
      // A failed spawn can report both an error and an exit: the first decides. Stopped, it decides nothing.
      let settled = false;
      copying.tmux.stop = () => {
        settled = true;
        child.kill();
        copyStopped('tmux', doneMsg, refuseTail);
      };
      child.on('error', () => {
        if (settled) return;
        settled = true;
        fallback();
      });
      child.stdin!.on('error', () => { /* the exit code decides; a dead pipe is not news */ });
      child.on('exit', (code: number | null) => {
        if (settled) return;
        settled = true;
        if (code !== 0) return fallback();
        copyToast(doneMsg && `${doneMsg} via tmux`);
        done();
      });
      child.stdin!.end(text);
    });
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
      return copyToast(doneMsg);
    }
    // Too large for OSC 52. herdr's copy is named: nothing OAK selected was.
    const tooLarge = `${doneMsg ? 'too large to copy through the terminal' : "herdr's copy is too large for the terminal"} (${Math.round(payload.length / 1024)}KB, limit ~73KB)`;
    if (plan.via === 'tools') {
      const tools = plan.tools;
      return oneCopyAtATime('tools', (done) => {
        // The tools that ran and failed (with no display to copy to, say) are named: installing one would not help. One
        // that is not installed is named to install (on X11, xclip where wl-copy has no Wayland display); pbcopy is macOS's.
        const failed: string[] = [], missing: string[] = [];
        const tryTool = (i: number): void => {
          if (i >= tools.length) {
            copyRefused(`${tooLarge}${failed.length ? `, and ${failed.join(' and ')} failed` : ''}${missing.length ? ` — install ${missing.join(' or ')} for big copies` : ''}${refuseTail}`);
            return done();
          }
          const [cmd, args] = tools[i];
          const absent = (): void => {
            if (cmd !== 'pbcopy') missing.push(cmd);
            tryTool(i + 1);
          };
          let child;
          try {
            child = core.spawnTool(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
          } catch {
            return absent();
          }
          let settled = false;
          copying.tools.stop = () => {
            settled = true;
            child.kill();
            copyStopped(cmd, doneMsg, refuseTail);
          };
          child.on('error', () => {
            if (settled) return;
            settled = true;
            absent();
          });
          // A fast-exiting tool (wl-copy with no Wayland session) EPIPEs the pending write — an
          // unhandled stream error is an uncaughtException that kills the whole review (proven by
          // the re-review's positive control). The exit handler already advances the ladder.
          child.stdin!.on('error', () => { /* the exit code decides; a dead pipe is not news */ });
          child.on('exit', (code: number | null) => {
            if (settled) return;
            settled = true;
            if (code !== 0) {
              failed.push(cmd);
              return tryTool(i + 1);
            }
            copyToast(doneMsg && `${doneMsg} via ${cmd}`);
            done();
          });
          child.stdin!.end(text);
        };
        tryTool(0);
      });
    }
    copyRefused(`${tooLarge}${doneMsg ? ' — select less' : ''}${refuseTail}`);
  };

  /** Route pasted text to whoever owns the keyboard — the Observatory's reply box when it has focus
   *  (a prompt is the most-pasted string in this product), the filter when one is open, DISCARDED otherwise:
   *  in raw mode a paste is indistinguishable from typing, and this keymap binds single letters to
   *  destructive verbs. One door for the terminal's bracketed paste AND the app's own ^V. */
  const routePaste = (raw: string): void => {
    const replyPane = focusedReplyPane();
    // One line of text, as each of the boxes below takes.
    const line = (): string => raw.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    if (replyPane) {
      const reply = state.observatory!.details[replyPane].reply!;
      const text = line();
      observatory?.editReply(replyPane, reply.text.slice(0, reply.caret) + text + reply.text.slice(reply.caret), reply.caret + text.length);
    } else if (filterOpen) {
      state.filter += raw.replace(/[\r\n]/g, '');
      clampCursor();
      schedulePaint();
    } else if (state.overlay && pickerFilter !== null && !state.confirm) {
      // The session picker's search box.
      pickerFilter += line();
      pickerTyped();
    } else if (paletteOpen) {
      paletteFilter += line();
      paletteCursor = 0;
      renderPalette();
    } else if (state.overlay && helpFilter !== null) {
      helpFilter += line();
      rerenderHelp();
    } else if (diffFindOpen) {
      diffFind += line();
      state.status = `find in diff: ${diffFind}`;
      schedulePaint();
    }
  };
  /** Whether anything on screen takes text a paste would go into (routePaste's list). */
  const takesPaste = (): boolean => !!focusedReplyPane() || filterOpen || !!(state.overlay && pickerFilter !== null && !state.confirm)
    || paletteOpen || !!(state.overlay && helpFilter !== null) || diffFindOpen;

  /** How much of a clipboard ^V will take. A runaway buffer pasted into the prompt would wrap
   *  megabytes per paint; half a MB is far past any real prompt and still instant. */
  const PASTE_MAX = 512 * 1024;

  /** The OS-paste chord (^V), read through the SAME ladder the copy writes: the tmux buffer inside
   *  tmux, the platform's own tools on a local terminal — and an honest pointer at the terminal's
   *  own paste where neither can reach the right clipboard (remote, no tmux: the machine's tools
   *  would read the REMOTE clipboard, which is not the one the reader means). */
  const pasteFromClipboard = (): void => {
    // Only what takes text takes a paste. Elsewhere the paste went nowhere while the status
    // row said "pasted N chars".
    if (!takesPaste()) {
      state.status = `nothing here takes a paste — ^V pastes into the filter (${keyForAction('filter')}), a search box or a reply box`;
      return schedulePaint();
    }
    const deliver = (text: string): void => {
      if (!text) {
        state.status = 'nothing to paste';
        return schedulePaint();
      }
      const cut = text.length > PASTE_MAX;
      // Cut where a character ends: cut at a UTF-16 index, the paste could end in half of an emoji's surrogate pair.
      routePaste(cut ? core.graphemeHead(text, PASTE_MAX) : text);
      state.status = cut ? `pasted the first ${Math.round(PASTE_MAX / 1024)}KB — the clipboard held more` : `pasted ${charCount(text)}`;
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
        // Decoded as one stream: decoded read by read, a character whose bytes two reads split came out as U+FFFDs.
        const utf8 = new StringDecoder('utf8');
        child.stdout!.on('data', (d: Buffer) => {
          if (out.length <= PASTE_MAX) out += utf8.write(d);
        });
        child.on('error', () => tryTool(i + 1));
        child.on('exit', (code: number | null) => {
          if (code === 0) deliver(out + utf8.end());
          else tryTool(i + 1);
        });
      };
      tryTool(0);
    };
    run(pastePlan({ tmux: !!process.env.TMUX, remote: REMOTE_CLIPBOARD, platform: process.platform }));
  };

  const copySpan = (a: { row: number; col: number }, b: { row: number; col: number }, clip?: SpanClip): void => {
    // Every colour form the row passes (sanitizeCell), the colon-separated one too.
    const plain = lastPainted.map(stripSgr);
    // The status row is cut at the terminal's edge, never wrapped: the bottom rows keep one height, which the panes
    // and herdr's screen are sized by. A selection from its text to that edge takes the rest of the status too.
    const text = selectedText(plain, a, b, clip, lastBottom, frameCols);
    // A drag entirely in right-edge padding selects nothing — writing '' would CLEAR the reader's
    // clipboard under a "copied 0 chars" toast, which is worse than saying so.
    if (!text) return copyRefused('nothing under that selection — it was all padding');
    // One door for every copy (see copyText): OSC 52 within bounds, the platform's own tool past
    // them on a local terminal — and the same honest refusal where neither can work.
    copyText(text, `copied ${charCount(text)} to clipboard`);
  };

  // `button` is on the wire and always has been — 0 left, 1 middle, 2 right — it simply was not in
  // this signature, so the right button arrived and was handled as a left click.
  function onMouse(ev: { kind: string; row: number; col: number; button?: number }): void {
    // A PRESS while a selection is still armed means its release was lost and no button-less motion said
    // so (a terminal that does not report any-motion, a release let go outside the window). Drop it
    // without acting — no copy, no late click — and take the press as itself: the stale press's click
    // fired under the next click, and a seam drag copied text nobody selected.
    if (textDrag && ev.kind === 'down') endTextDrag();
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
          if (!textDrag.click) state.status = SELECTING; // not on a tree tab (above)
          schedulePaint();
        }
        return;
      }
      if (released) {
        const td = textDrag;
        endTextDrag();
        if (td.moved) {
          // The span OUTLIVES the release: kept and painted until the next key or click,
          // stored normalized so the paint pass never re-derives direction, held to its pane. A tree
          // pane's selection (the one whose press waits to be a click) clears on release instead, as
          // herdr's does: those panes are live, a kept band would sit over whatever scrolled under it,
          // and the toast already says what was copied.
          if (!td.click) state.selSpan = { ...normSpan(td), ...(td.clip ? { clip: td.clip } : {}) };
          // The bottom rows moved under a selection held on them: the status row went (a toast ran out, or herdr's
          // prefix note went with the press), so the selection now lies on the divider or another row, which nobody
          // selected. Nothing is copied, and a toast says so.
          if (td.bottom && (!lastBottom || Math.min(td.startRow, td.lastRow) < lastBottom.first)) {
            return copyRefused('nothing copied: the rows under the selection moved before its release');
          }
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
      const overUsage = ev.row === frameRows - 2;
      if (overUsage !== !!state.hoverUsage) {
        state.hoverUsage = overUsage;
        schedulePaint();
      }
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
    // THE BOTTOM ROWS (the status row, the usage bar, the key row) lie outside every pane, on every tab: a left press
    // there arms a selection held to them, as a pane's is held to its own. Its click, a release that never moved,
    // does what a click there always did, which is nothing; and while it is held it leaves the status row alone,
    // since that row may be what is being selected.
    if ((ev.button ?? 0) === 0 && lastBottom && ev.row >= lastBottom.first) {
      const clip = { x0: 0, x1: frameCols - 1, y0: lastBottom.first, y1: lastPainted.length - 1 };
      const col = Math.max(clip.x0, Math.min(clip.x1, ev.col));
      textDrag = { startRow: ev.row, lastRow: ev.row, startCol: col, lastCol: col, moved: false, clip, click: () => {}, bottom: true };
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
            if (picked) workspaceGroupSelection = undefined;
            const openPath = clickedRow?.openPath;
            if (btn?.action === 'workspace-window' && clickedRow?.workspaceWindow) {
              const target = clickedRow.workspaceWindow;
              act = () => { void openWorkspaceWindow(target); };
            } else if (clickedRow?.workspaceWindow) {
              const target = clickedRow.workspaceWindow;
              act = () => { workspaceGroupSelection = target; state.status = `${target.root} — W opens its workspace window`; };
            } else if (btn && picked) {
              act = () => blobAction(btn.action, picked.session, picked.label, picked);
            } else if (openPath) {
              // A session's worker summary is picked as it opens or closes, so the arrows go on from it.
              act = () => {
                toggleOpenKey(openPath);
                if (th.view === 'sessions-nav') {
                  state.observatoryFold = openPath.startsWith('done:') ? openPath : undefined;
                  if (state.observatoryFold) state.scopeWorker = null;
                  else if (picked) state.scopeWorker = picked;
                }
              };
            } else if (picked?.processId) {
              act = () => pinSession(picked.session, picked.machineId, wp?.id, picked);
            } else if (picked?.agentId && th.view !== 'sessions-nav') {
              // Open this worker's own log in the Observatory detail, on the machine its row names.
              const agentId = picked.agentId;
              act = () => viewSubagent(picked.session, agentId, picked.machineId);
            } else if (picked && th.view === 'sessions-nav') {
              // ONE click on a master session — its pane line, title or stat line — pins its
              // conversation; one on a worker's rows under it pins it too, and picks that worker. The first
              // click used to select only. The arrow keys still
              // preview without pinning; Enter pins what they previewed. In a split view the click
              // fills the conversation leaf the reader focused, else the one the last pin filled.
              const chosen = leafPanes(treeTab.root).some((p) => p.id === focusBefore && p.view === 'session-detail');
              act = () => { state.observatoryFold = undefined; pinSession(picked.session, picked.machineId, chosen ? focusBefore : pinLeaf, picked); };
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
    // A native tab draws none of the dock's windows: below its tab bar lie the program's screen and OAK's divider and
    // bottom rows, of which only the bottom rows (above) take a press. The windows' hit-test would answer for a divider
    // that covers the program's last row.
    if (tabs[active]?.kind === 'native' && ev.row >= nativeBodyRows()[0]) return;

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
      if (row?.ids.length === 1) offer('editor', 'Open in the terminal editor');
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
    sync: syncEnv(),
    // What the GUI editor row's Auto runs now: the resolution without the row's own value.
    gui: core.resolveGuiEditor({ editor: prefs.editor }, process.env, detectedEditors),
  });
  const optRows = () => optionRows(prefs, optEnv());

  /** This workspace's project, by the identity key `oak sync exclude <folder>` gives it: read once, it reads git's files. */
  let syncProject: { key: string; folder: string } | undefined | null = null;
  /** The options window's SYNC section: only while sync is in use here or a machine is saved, so a machine that has
   *  neither is shown nothing new. */
  function syncEnv(): import('./options').OptionEnv['sync'] {
    const machines = (state.observatory?.machines ?? []).filter((m) => !m.local).map((m) => core.plainLabel(m.label));
    if (!syncInUse(state.sync) && !machines.length) return undefined;
    if (syncProject === null) {
      try {
        syncProject = { key: core.identityKey(cwd, { home: os.homedir(), shares: core.readMountTable() }).key, folder: cwd };
      } catch {
        syncProject = undefined;
      }
    }
    return { status: state.sync ?? null, machines, project: syncProject, now: Date.now() };
  }
  /** The `oak sync now` this window started, while it runs: Enter on the Sync now row stops it, with the ssh it started. */
  let syncRun: AbortController | null = null;
  /** One SYNC row's work, through the CLI: setup on the terminal, taking the folder's record over (once asked), a run
   *  (or stopping it), the last run whole, or including or excluding a machine or project. Every outcome is said. */
  function syncOption(id: string): void {
    if (id === 'sync.setup') {
      return runOnTerminal(['sync', 'setup'], (code) => {
        state.status = code === 0 ? 'back from oak sync setup' : `oak sync setup ${code === null ? 'did not finish' : `exited ${code}`}`;
        readSyncStatus(true);
      });
    }
    if (id === 'sync.now' && syncRun) {
      syncRun.abort();
      state.status = 'stopping oak sync now…';
      return schedulePaint();
    }
    if (id === 'sync.now' || id === 'sync.last') {
      // The window closes now, so the answer, an overlay of its own, is not cleared with it when it lands first.
      options = null;
      optionsShown = false;
      state.overlay = null;
      if (id === 'sync.last') return runVerb('oak sync status', ['sync', 'status']);
      state.status = `running oak sync now… (${keyForAction('options')}, then Enter on Sync now, stops it)`;
      schedulePaint();
      const run = (syncRun = new AbortController());
      return runVerb('oak sync now', ['sync', 'now'], run.signal, () => {
        if (syncRun === run) syncRun = null;
        readSyncStatus(true);
      });
    }
    if (id === 'sync.restore') {
      // Asked first, as the editors ask: the record may be another machine's that writes it still.
      state.confirm = { verb: 'take over', ids: [], label: 'the backup folder\'s record of this machine, as a reinstall' };
      return schedulePaint();
    }
    const [args, doing] = id === 'sync.project' && syncProject
        ? [['sync', state.sync?.exclude.projects.includes(syncProject.key) ? 'include' : 'exclude', syncProject.folder, '--json'], 'changing which projects sync']
        : id.startsWith('sync.project:')
          ? [['sync', 'include', id.slice('sync.project:'.length), '--json'], 'including the project again']
          : id.startsWith('sync.machine:')
            ? [['sync', state.sync?.exclude.machines.includes(id.slice('sync.machine:'.length)) ? 'include' : 'exclude', id.slice('sync.machine:'.length), '--json'], 'changing which machines sync']
            : [null, ''];
    if (!args) return;
    runSyncVerb(args, doing, () => `${args[1] === 'include' ? 'syncing' : 'not syncing'} ${args[2]}${args[1] === 'include' ? ' again' : ' any more'}`);
  }

  /** `oak sync setup --folder <the backup folder> --restore`: the reader said this machine is a reinstall. */
  function applySyncRestore(): void {
    const folder = state.sync?.backup?.kind === 'folder' ? state.sync.backup.path : null;
    if (!folder) {
      state.status = 'the backup is no folder now: nothing to take over';
      return schedulePaint();
    }
    runSyncVerb(['sync', 'setup', '--folder', folder, '--restore', '--json'], 'taking the backup folder\'s record over',
      (j) => {
        const record = j.record as { claimed?: boolean; state?: string } | undefined;
        return record?.claimed ? 'this machine took the folder\'s record over: Sync now restores its sessions from it'
          : record?.state === 'mine' ? 'the folder\'s record is this machine\'s already' : 'the folder holds no record of this machine to take over';
      });
  }

  /** One of sync's `--json` verbs: what it is doing on the status row, then what it did (`said`), or the CLI's own words. */
  function runSyncVerb(args: string[], doing: string, said: (j: Record<string, unknown>) => string): void {
    state.status = `${doing}…`;
    schedulePaint();
    void backend!.run(args).then((out) => {
      let j: Record<string, unknown> | null = null;
      try {
        j = JSON.parse(out);
      } catch {
        /* the CLI's own words, below */
      }
      state.status = !j ? `could not: ${out.trim().split('\n')[0].replace(/^oak: /, '')}` : typeof j.error === 'string' ? `could not: ${j.error}` : said(j);
      readSyncStatus(true);
      schedulePaint();
    });
  }

  /**
   * Hand the terminal to one of this CLI's verbs that asks its own questions (`oak sync setup`), as `e` hands it to a
   * terminal editor, then hold its last words on screen until Enter, which the dashboard would paint over at once.
   */
  let holdForEnter: (() => void) | null = null;
  function runOnTerminal(args: string[], done: (code: number | null) => void): void {
    suspendTerminal();
    let child;
    try {
      child = core.spawnTool(process.execPath, [process.argv[1], ...args], { stdio: 'inherit', cwd, env: { ...process.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' } });
    } catch (e) {
      resumeTerminal();
      state.status = `could not run oak ${args.join(' ')}: ${String((e as Error)?.message || e)}`;
      return schedulePaint();
    }
    let ended = false;
    const end = (code: number | null, failed = ''): void => {
      if (ended) return;
      ended = true;
      // Through the gate, opened for this one line: the child has exited, and the terminal is not taken back yet.
      out.resume();
      out.write(`\n${failed ? `${failed}\n` : ''}Press Enter to go back to OAK. `);
      out.suspend();
      holdForEnter = () => {
        holdForEnter = null;
        resumeTerminal();
        done(code);
        if (failed) state.status = failed;
        schedulePaint();
      };
      // Raw, so ctrl+d is a key here and not the end of input: read with the terminal not raw, ctrl+d ended stdin for good
      // and the prompt could never be answered (review 2026-11-05).
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
    };
    child.on('error', (e: Error) => end(null, `could not run oak ${args.join(' ')}: ${e.message}`));
    child.on('close', (code: number | null) => end(code));
  }

  /** The window's cursor is an index into its rows, which change under it (oak sync's come and go with its status and
   *  the saved machines): it stays on the row it was on, by its id, or, when that row went, moves to the one above it,
   *  so a key never acts on a row the reader did not choose. */
  function anchorOptions(rows: ReturnType<typeof optRows>): void {
    if (!options) return;
    if (options.id !== undefined && rows[options.cursor]?.id !== options.id) {
      const at = rows.findIndex((r) => r.id === options!.id);
      const sel = selectableRows(rows);
      options.cursor = at >= 0 ? at : (sel.filter((i) => i < options!.cursor).pop() ?? sel[0] ?? 0);
      options.scroll = Math.min(options.scroll, options.cursor);
    }
    options.id = rows[options.cursor]?.id;
  }

  function openOptions(): void {
    const rows = optRows();
    options = { cursor: selectableRows(rows)[0] ?? 0, scroll: 0, capture: null };
    state.status = 'options — ←→ change · enter edit · esc close';
    schedulePaint();
  }

  /** Persist, then re-apply the ones that change how this session already looks. `sets` are the keys saved
   *  (writeOwn): those `next` changes, unless the caller names them. */
  function saveOptions(next: import('@oak-observatory/core').Prefs,
    sets: readonly AppPrefKey[] = APP_PREF_KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(prefs[k]))): void {
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
      writeOwn(prefs, sets);
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
    // A standing question (the reset's) is answered by the confirm wall, not by the window under it.
    if (!options || state.confirm) return false;
    const rows = optRows();
    anchorOptions(rows);
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
          // Said as "store moved", one prefs.json could not record hid that it still names where the store was.
          if (res.unrecorded) {
            state.status = `store moved to ${res.to}, but its location was not saved, so OAK looks for it where it was — ${res.unrecorded}`;
            return (schedulePaint(), true);
          }
          // The move recorded the new location in prefs.json (while captures waited for it); this copy follows it.
          const next = { ...prefs };
          if (want) next.storeDir = parsed.dir;
          else delete next.storeDir;
          prefs = next;
          state.status = `store moved to ${res.to}${res.left ? ` — ${res.left}` : ''}${res.missed ? ` — ${core.missedDuringMove(res.missed)}` : ''}`;
          ask();
          return (schedulePaint(), true);
        }
        saveOptions(setOption(prefs, cap.id, cap.buf));
        return true;
      }
      if (ev.key === 'backspace' || ev.key === 'delete') { cap.buf = backspaced(cap.buf); return (schedulePaint(), true); }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) { cap.buf += ev.key; return (schedulePaint(), true); }
      return true;
    }

    if (ev.key === 'escape' || (!ev.ctrl && !ev.alt && ev.key === 'q') || (ev.key.length === 1 && keys().get(ev.key) === 'options')) {
      options = null;
      state.status = 'ready';
      return (schedulePaint(), true);
    }
    const at = sel.indexOf(options.cursor);
    // The view FOLLOWS the cursor. Without this the list scrolled never, so every row past the
    // seventeenth — which is all of the KEYS section — could be selected and could not be seen.
    const follow = () => {
      // By the lines each row draws (a detail of several lines, a wrapped help), so the selected row never falls off
      // the bottom of the window, however tall the rows above it are.
      const budget = Math.max(1, overlayRows());
      const drawn = (from: number): number => {
        let n = 0;
        for (let i = from; i <= options!.cursor; i++) n += optionRowLines(rows[i], i === options!.cursor, i === from, frameCols, glyphs, colorDepth).length;
        return n;
      };
      if (options!.cursor < options!.scroll) options!.scroll = options!.cursor;
      while (options!.scroll < options!.cursor && drawn(options!.scroll) > budget) options!.scroll++;
      if (options!.scroll < 0) options!.scroll = 0;
    };
    if (ev.key === 'down') { options.cursor = sel[Math.min(sel.length - 1, at + 1)]; options.id = rows[options.cursor]?.id; follow(); return (schedulePaint(), true); }
    if (ev.key === 'up') { options.cursor = sel[Math.max(0, at - 1)]; options.id = rows[options.cursor]?.id; follow(); return (schedulePaint(), true); }
    if (ev.key === 'pgdn') { options.cursor = sel[Math.min(sel.length - 1, at + 5)]; options.id = rows[options.cursor]?.id; follow(); return (schedulePaint(), true); }
    if (ev.key === 'pgup') { options.cursor = sel[Math.max(0, at - 5)]; options.id = rows[options.cursor]?.id; follow(); return (schedulePaint(), true); }
    const row = rows[options.cursor];
    if (!row) return true;
    // The SYNC rows run the CLI, which keeps sync's settings in prefs.json: nothing here saves them.
    if (row.id.startsWith('sync.')) {
      if (ev.key === 'enter' || (row.kind === 'toggle' && (ev.key === 'left' || ev.key === 'right'))) syncOption(row.id);
      return true;
    }
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
        const seed = row.id === 'editor' ? prefs.editor ?? '' : row.id === 'guiEditor' ? prefs.guiEditor ?? '' : row.id === 'storeDir' ? prefs.storeDir ?? '' : '';
        options.capture = { id: row.id, kind: 'text', buf: seed };
      } else
if (row.kind === 'key') options.capture = { id: row.id, kind: 'key', buf: '' };
      else if (row.kind === 'toggle') saveOptions(applyOption(prefs, row.id, 1));
      else if (row.id === 'reset') {
        // Irreversible in one key, so it asks: the file goes, and with it every rebind and the layout.
        state.confirm = { verb: 'reset', ids: [], label: 'reset every option to its default — keys, layout, editor, theme and the store location (the store itself is not moved)' };
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
    // Only a session that waits for its owner: with none at all, the read this would start changes the facts again.
    if (state.reviewFinding && state.session) ask();
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
    const all = helpLines(prefs, herdrConfig());
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
      state.status = 'answer the pending question first — y or n';
      return schedulePaint();
    }
    pickerFilter = '';
    pickerOpen = true;
    pickerState = 'all';
    pickerOlder = false;
    renderSessionPicker();
  }

  /**
   * The picker's search box matches names on every keystroke, and what was SAID in each session through
   * `oak search` on this machine and on every saved machine (`--machine`), all at once. That part waits
   * for the typing to pause, so a word typed quickly is one search per machine rather than one per letter,
   * and it never holds a keystroke: each answer arrives later and repaints the open picker in place.
   * One search per machine runs at a time — a newer query waits for it, replacing any query already
   * waiting — and an answer for text no longer in the box is kept out of the list. Each machine answers
   * with its sessions' best hits, up to PICKER_SEARCH_LIMIT of them, and the box says when it had more.
   */
  const PICKER_SEARCH_DEBOUNCE_MS = 275;
  const PICKER_SEARCH_TIMEOUT_MS = 30_000;
  const PICKER_SEARCH_LIMIT = 200;
  /** Per machine ('' is this one): the query in flight (and how to stop it) and the one waiting behind it,
   *  the query last answered, its first hit's excerpt per session and whether the limit cut it, or why
   *  that answer failed. */
  const pickerText = new Map<string, { inflight: string | null; abort?: AbortController; queued: string | null; query: string | null; hits: Map<string, string>; cut?: boolean; error?: string }>();
  let pickerSearchTimer: ReturnType<typeof setTimeout> | undefined;
  /** The picker is closing, by any path: a search its typing scheduled never starts, and for one still
   *  running OAK stops waiting, stops its process here and the ssh that process runs, and drops its
   *  answer. So a reopened picker never runs a second search to a machine alongside the first. A saved
   *  machine's own search is not signalled through ssh, and may still finish there. */
  function cancelPickerSearch(): void {
    clearTimeout(pickerSearchTimer);
    pickerSearchTimer = undefined;
    for (const m of pickerText.values()) m.abort?.abort();
    pickerText.clear();
  }
  // Quitting stops them too: every way out of the app goes through process.exit.
  process.on('exit', cancelPickerSearch);
  /** Each machine's answer for exactly `q`, the text now in the box: an answer for older text is never
   *  shown under newer text. */
  function pickerAnswered(q: string): [string, NonNullable<ReturnType<typeof pickerText.get>>][] {
    return q ? [...pickerText].filter(([, m]) => m.query === q) : [];
  }
  /** The text in the search box changed: names now, what was said once the typing pauses. */
  function pickerTyped(): void {
    clearTimeout(pickerSearchTimer);
    pickerSearchTimer = undefined;
    const q = (pickerFilter ?? '').trim();
    if (q) {
      pickerSearchTimer = setTimeout(() => {
        pickerSearchTimer = undefined;
        if ((pickerFilter ?? '').trim() === q) searchPickerText(q);
      }, PICKER_SEARCH_DEBOUNCE_MS);
    }
    renderSessionPicker();
  }
  function searchPickerText(q: string): void {
    if (!backend) return;
    // The saved machines whose sessions the picker can list; one that cannot list them already has its note.
    const remotes = (state.observatory?.machines ?? []).filter((m) => !m.local && !m.sessionsError).map((m) => m.label);
    for (const machine of ['', ...remotes]) {
      let m = pickerText.get(machine);
      if (!m) pickerText.set(machine, (m = { inflight: null, queued: null, query: null, hits: new Map() }));
      if (m.inflight !== null) m.queued = q;
      else if (m.query !== q || m.error) runPickerSearch(machine, m, q);
    }
    if (pickerOpen && !state.confirm) renderSessionPicker(true);
  }
  function runPickerSearch(machine: string, m: NonNullable<ReturnType<typeof pickerText.get>>, q: string): void {
    m.inflight = q;
    const abort = (m.abort = new AbortController());
    // `--query=`: one argv value, so a query that starts with a dash is still the query. `--per-session`:
    // one session's many matching asks take one of the limit's places, not all of them.
    void backend!.run(['search', '--json', `--query=${q}`, '--per-session', '--limit', String(PICKER_SEARCH_LIMIT)], machine || undefined,
      { timeoutMs: PICKER_SEARCH_TIMEOUT_MS, signal: abort.signal }).then((out) => {
      if (pickerText.get(machine) !== m) return; // cancelled with the picker that asked
      m.inflight = null;
      m.abort = undefined;
      m.query = q;
      m.hits = new Map();
      m.cut = false;
      m.error = undefined;
      try {
        const res = JSON.parse(out) as { hits?: { session?: unknown; snippet?: unknown }[]; matched?: unknown };
        const hits = res.hits;
        if (!Array.isArray(hits)) throw new Error('no hits in the answer');
        // Cut at the limit: a build that counts its matches says so; an older one does not count, and
        // ignores `--per-session` too, so a full answer may have left some out.
        m.cut = typeof res.matched === 'number' ? res.matched > hits.length : hits.length >= PICKER_SEARCH_LIMIT;
        // Ranked best first, so a session's first hit is its best excerpt.
        for (const h of hits) if (typeof h.session === 'string' && !m.hits.has(h.session)) m.hits.set(h.session, String(h.snippet ?? ''));
      } catch {
        m.error = out.trim().split('\n')[0]?.replace(/^oak: /, '') || 'no answer';
      }
      const next = m.queued;
      m.queued = null;
      if (next !== null && next !== q && (pickerFilter ?? '').trim() === next) runPickerSearch(machine, m, next);
      if (pickerOpen && !state.confirm) renderSessionPicker(true);
    });
  }
  /** One line of a hit's excerpt in `room` columns: from a word shortly before the first matching word,
   *  cut at a word boundary — never an ellipsis, and none of the control characters a transcript holds. */
  function saidLine(snippet: string, q: string, room: number): string {
    const text = snippet.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/^…|…$/g, '').replace(/\s+/g, ' ').trim();
    const term = q.toLowerCase().split(/\s+/)[0] ?? '';
    const at = term ? text.toLowerCase().indexOf(term) : -1;
    // The excerpt starts at its beginning when the matching word fits there, else a few words before it.
    const from = at > 12 && at + term.length > room ? text.lastIndexOf(' ', at - 12) + 1 : 0;
    return wrapVisible(text.slice(from), Math.max(1, room))[0] ?? '';
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
    // No session to name (a workspace with none of its own): `--session ''` is refused, and the listing failed.
    void backend!.run(['views', '--views', 'sessions', '--json', ...(state.session ? ['--session', state.session] : [])]).then((out) => {
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
      cancelPickerSearch();
      state.overlay = null;
      state.status = 'no sessions found — this machine has no Claude Code transcripts yet';
      return schedulePaint();
    }
    const f = (pickerFilter ?? '').toLowerCase();
    const named = (x: Record<string, unknown>): boolean => `${x.title ?? ''} ${x.id} ${x.workspace ?? ''} ${x.machine ?? ''}`.toLowerCase().includes(f);
    // What was SAID: each machine's answer for the text now in the box, by row. Rows that match only
    // this way follow the name matches, in the same order, each with an excerpt of its hit.
    // The text as typed, as each search was asked for it: case is the search's own business.
    const q = (pickerFilter ?? '').trim();
    const answered = pickerAnswered(q);
    const said = new Map<string, string>();
    for (const [machine, m] of answered) for (const [id, snippet] of m.hits) said.set(`${machine}\u0000${id}`, snippet);
    const saidOnly = f ? all.filter((x) => !isNote(x) && !named(x) && said.has(pickerKey(x))) : [];
    const saidOf = new Map(saidOnly.map((x) => [x, said.get(pickerKey(x))!]));
    // A machine whose search failed says so where its rows would be, as one that cannot list them does.
    const searchFailed = answered.filter(([, m]) => m.error).map(([machine, m]): Record<string, unknown> => ({ id: `!search${machine}`, machine: machine || core.THIS_MACHINE,
      error: m.error, note: `could not search ${machine ? `${machine}'s` : "this machine's"} conversations — ${m.error}` }));
    const searching = !!q && (pickerSearchTimer !== undefined || [...pickerText.values()].some((m) => m.inflight === q || m.queued === q));
    // A machine with more matches than its answer held says so: the list is not everything that matched.
    const cut = answered.filter(([, m]) => m.cut && !m.error).map(([machine]) => machine || 'this machine');
    const textList = f ? [...all.filter((x) => isNote(x) || named(x)), ...saidOnly, ...searchFailed] : all;
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
    // An excerpt needs room beside its row: columns give way for it the way they do for a narrow terminal.
    const saidW = shownList.some((x) => saidOf.has(x)) ? 2 + 30 : 0;
    const widthOf = (): number => saidW +
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
      const lit = quiet && colorDepth !== 'none' ? `\x1b[2m${row}\x1b[0m` : row;
      const snippet = saidOf.get(x);
      if (snippet === undefined) return lit;
      const room = frameCols - 1 - displayWidth(row) - 2 - 'said '.length;
      return room > 0 ? `${lit}  ${tint(`said ${saidLine(snippet, q, room)}`, 'accent', colorDepth)}` : lit;
    });
    // …and one row for everything older than a week, which choosing EXPANDS rather than opens.
    if (older.length) {
      const note = `   ${glyphs.closed} ${older.length} session${older.length === 1 ? '' : 's'} older than a week — enter shows them`;
      lines.push(colorDepth === 'none' ? note : `\x1b[2m${note}\x1b[0m`);
      pickerIds.push(OLDER_ROW);
      pickerRows.push({ id: OLDER_ROW });
    }
    if (!lines.length) {
      lines.push(searching ? `  no name matches “${pickerFilter}” — searching what was said…` : `  nothing matches “${pickerFilter}” — backspace to widen it`);
      pickerIds = [];
      pickerRows = [];
    }
    // Never an empty tail standing in for "still asking": a configured machine that has not answered
    // yet reads exactly like one with no sessions unless the list says which (its note row, above).
    const kept = before ? pickerRows.findIndex((r) => pickerKey(r) === pickerKey(before)) : -1;
    const at = kept >= 0 ? kept : Math.max(0, pickerRows.findIndex(inEffect));
    // The cursor row on screen: rows can arrive above it, and a picker opened on a session far down a
    // long list must still show it. Counted under the search box, a line the picker always draws and the
    // measure leaves out while another overlay, or none, is up: the picker opened with its row one line below.
    const scroll = overlayScroll(lines, at, prevScroll, Math.max(1, overlayRows() - (state.overlay?.head === undefined ? 1 : 0)), frameCols);
    state.overlay = {
      // Two halves, separated once: WHAT you are looking at, then WHAT the keys do. The old line
      // interleaved a count, a state name, three phase counts and four key hints in one run of
      // words, so a reader had to parse the whole thing to find either.
      title: [
        `sessions · ${tableRows.length}`,
        `[${pickerState}]`,
        `working ${phaseCount.working} · done ${phaseCount.done} · idle ${phaseCount.idle}`,
        pickerOlder ? 'incl. older' : '',
        '—',
        'tab state · type to search · enter opens · ^D deletes · esc closes',
      ].filter(Boolean).join('  '),
      // The search box: always there, and what it is matching said in it.
      head: `search ${pickerFilter ?? ''}▏  ${
        !q ? (colorDepth === 'none' ? 'names, and what was said in each session' : '\x1b[2mnames, and what was said in each session\x1b[0m')
        : searching ? `searching… ${[...new Set([...pickerText].filter(([, m]) => m.inflight !== null).map(([machine]) => machine || 'this machine'))].join(', ')}`.trimEnd()
        : [saidOnly.length ? `${saidOnly.length} more by what was said` : '', cut.length ? `more matches on ${cut.join(', ')} than shown — refine the search` : ''].filter(Boolean).join(' · ')}`,
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
    cancelPickerSearch(); // the picker is closing
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
   * names the edits still pending review that go with it, and says what `--undelete` brings back: the
   * session, and its edits only from a backup folder (core.deleteWords). The list returns on y or n.
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
    const said = core.deleteWords();
    const lines = [
      `  Delete “${title}”  (${id.slice(0, 8)})?`,
      '',
      `  It disappears from every Observatory session menu and its stored edits are purged ${said.purged}.`,
      '  The transcript on disk is NOT deleted — only Observatory’s record of the session.',
      ...(pending ? ['', `  ${pending === 1 ? '1 of those edits is' : `${pending} of those edits are`} still pending review: the purge drops ${pending === 1 ? 'its before-snapshot' : 'their before-snapshots'},`,
        `  so OAK can no longer undo ${pending === 1 ? 'that change' : 'those changes'}${said.folder ? ' here, unless the backup folder brings them back' : ''}.`] : []),
      '',
      `  oak sessions --undelete ${id} lists the session again, ${said.after}.`,
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
    cancelPickerSearch(); // …and the picker's searches with it
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
    const viewH = overlayRows();
    const scroll = cur >= viewH ? cur - viewH + 1 : 0;
    state.filterMenu = { cursor: cur };
    // The title carries what is currently applied, so the picker doubles as the "what filter is on"
    // readout while it is open (`/` sets the query, which shows here `/…/` when it is a live regex).
    const applied = filterSummary(state);
    const title = applied
      ? `filter: ${applied} — space toggles · c clears · ${keyForAction('filter-menu')} or esc closes`
      : `filter — space toggles a bucket · c clears · ${keyForAction('filter-menu')} or esc closes, then ${keyForAction('filter')} types the query`;
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
    // The key that opened it closes it, the reader's own when rebound.
    if (ev.key === 'escape' || ev.key === 'enter' || ev.key === 'q' || ev.key === '\\' || (!ev.ctrl && !ev.alt && keys().get(ev.key) === 'filter-menu')) {
      closeFilterMenu();
      return true;
    }
    const plain = !ev.ctrl && !ev.alt;
    if (ev.key === 'up' || ev.key === 'down' || ev.key === 'pgup' || ev.key === 'pgdn' || (plain && (ev.key === 'j' || ev.key === 'k'))) {
      const dir = ev.key === 'down' || ev.key === 'pgdn' || ev.key === 'j' ? 1 : -1;
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
    // Not the bare `oak ignore` verb: that sweeps the launch directory's session without asking. This is
    // the refresh's sweep, on the reviewed session where its store is, counted and confirmed first.
    if (name === 'ignore') return refreshAsking();
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
      let added: ReturnType<typeof core.addComment>;
      try {
        added = core.addComment(state.session, { unit: id, line: lineNo, text });
      } catch (e) {
        // A comment the store could not take is said, never shown as added (the CLI fails the same way).
        state.status = `the comment was not saved: ${String((e as Error)?.message || e)}`;
        return schedulePaint();
      }
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
      state.status = `no command “${name}” — try: ${[...Object.keys(COMMANDS).filter((c) => c !== '?'), ...Object.keys(TEXT_COMMANDS)].join(', ')}`;
      return schedulePaint();
    }
    // `rest` is deliberately DROPPED, not forwarded — see COMMANDS. Say so rather than ignoring it
    // silently, or `:store --move /tmp/x` looks like it worked.
    state.status = rest.length ? `${name} takes no arguments here — running the plain form…` : `running ${name}…`;
    schedulePaint();
    runVerb(name, cmd.args());
  }

  /** Run one of this CLI's verbs and show its answer: its first line on the status row, all of it in an overlay. `signal`
   *  stops it (said as stopped), and `done` follows the answer. */
  function runVerb(name: string, args: string[], signal?: AbortSignal, done?: () => void): void {
    void backend!.run(args, undefined, signal ? { signal } : undefined).then((out) => {
      done?.();
      if (signal?.aborted) {
        state.status = `${name}: stopped`;
        return schedulePaint();
      }
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

  /** Where the overlay on screen stops scrolling, for the lines and size it was measured at (see move). */
  let overlayEnd: { lines: readonly string[]; budget: number; cols: number; scroll: number } | null = null;
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
        const scroll = overlayScroll(o.lines, cur, o.scroll, overlayRows(), frameCols);
        state.overlay = { ...o, cursor: cur, scroll };
      } else {
        // The overlay viewport as drawn, in the lines the renderer draws: a fixed rows-6 left the last
        // lines of every scrolled overlay unreachable under the boxed session row, and so did counting
        // a line wide enough to wrap as one. Measured once per overlay and size: every key measured each
        // of its lines again, a cost that grew with the overlay.
        const budget = overlayRows();
        if (overlayEnd?.lines !== o.lines || overlayEnd.budget !== budget || overlayEnd.cols !== frameCols) {
          overlayEnd = { lines: o.lines, budget, cols: frameCols, scroll: overlayScroll(o.lines, o.lines.length - 1, 0, budget, frameCols) };
        }
        state.overlay = { ...o, scroll: Math.min(overlayEnd.scroll, Math.max(0, o.scroll + delta)) };
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
    quitArmedUntil = Date.now() + QUIT_WINDOW_MS;
    state.status = `press ${chord} again to exit`;
    schedulePaint();
  }

  /** The Observatory's pane operations (they were the ctrl+a leader's): zoom, close, split, swap and the
   *  view picker, on the focused pane of the tree tab. Shared by the keys and the palette. */
  function paneOp(op: 'zoom' | 'close' | 'cycle' | '|' | '-' | 'view' | 'H' | 'J' | 'K' | 'L'): void {
    const tab = tabs[active];
    if (!tab?.root) {
      state.status = 'pane operations are on the Observatory tab';
      return schedulePaint();
    }
    const focus = tab.treeFocus ?? firstLeafId(tab.root);
    if (op === 'zoom') {
      tab.treeZoom = tab.treeZoom === focus ? null : focus;
      state.status = tab.treeZoom ? `zoomed — ${keyForAction('zoom')} restores` : 'ready';
      return schedulePaint();
    }
    if (op === 'cycle') return cycleTreeFocus(tab);
    if (op === 'close') {
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
    if (op === '|' || op === '-') {
      // A split starts with its own unpinned conversation header; Enter gives it an independent pin.
      const newId = `split-${nextSplitId++}`;
      tab.root = splitPane(tab.root, focus, op === '|' ? 'h' : 'v', newId, 'session-detail');
      tab.treeFocus = newId;
      tab.treeZoom = null;
      state.status = 'pane split — v changes what it shows · “close pane” in the : palette closes it';
      ask();
      return openViewPicker(newId);
    }
    if (op === 'view') return openViewPicker(focus);
    // Move the focused pane by keyboard: swap it with the neighbour that way — the same tree op the
    // title drag's middle-drop applies.
    const dir = op === 'H' ? 'left' : op === 'L' ? 'right' : op === 'K' ? 'up' : 'down';
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

  /** Pin the session in herdr's focused pane in the Observatory (herdr's prefix, then `M`). It is the way back to
   *  OAK's tabs when herdr's config binds `m`, so a pane with nothing to pin goes there too, with the reason. */
  function pinHerdrFocused(): void {
    void observatory?.current().then(selection => pinSession(selection.session, selection.machineId))
      .catch(error => { toOakTab(); state.status = String(error.message || error); schedulePaint(); });
  }

  /** Open Review on the session in herdr's focused pane (herdr's prefix, then `V`) the way `oak focus --tab review` opens
   *  it: no machine named, so Review reads the session where OAK's herdr snapshots show it running, this machine's pane
   *  first. A pane with no session goes to OAK's tabs, with the reason, as `M` does. */
  function reviewHerdrFocused(): void {
    void observatory?.current().then(selection => reviewSession(selection.session))
      .catch(error => { toOakTab(); state.status = String(error.message || error); schedulePaint(); });
  }

  /** The tab key (f1 to f3, `TAB_KEYS`) a key event is, if it is one: with shift, ctrl, alt, super, hyper or meta it is
   *  another key, which goes where that key goes. */
  const tabKeyOf = (ev: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; super?: boolean; hyper?: boolean; meta?: boolean }): OakTabKey | undefined =>
    !ev.ctrl && !ev.alt && !ev.shift && !ev.super && !ev.hyper && !ev.meta && Object.hasOwn(TAB_KEYS, ev.key) ? ev.key as OakTabKey : undefined;

  /**
   * F1, F2 and F3: herdr, the Observatory and Review, from every tab and over every overlay. What is open closes first, as
   * esc would close it: an overlay, a picker, the palette, the options window, find in the diff, a one-key wait. A box
   * holding text you typed (the palette, the session picker's search, the help's filter, find in the diff, an options
   * entry) closes too, and its text goes with it. One thing holds the key back and says so on the status row: a question
   * standing, which no tab switch leaves behind. The `/` filter keeps its text on its tab and the reply box its draft.
   * Inside a herdr pane there is no herdr tab, and F1 says so.
   */
  function tabKeyPressed(key: OakTabKey): void {
    const i = tabs.findIndex((t) => t.id === TAB_KEYS[key]);
    if (i < 0) {
      state.status = "F1: no herdr tab here — OAK runs in a herdr pane, and herdr's own keys move between its tabs";
      return schedulePaint();
    }
    if (state.confirm) {
      state.status = 'answer the pending question first — y or n';
      return schedulePaint();
    }
    // What was open closes, and the status it wrote ("find in diff: …", a mark's or the resume's question) with it;
    // with nothing open the status stands, as a tab switch leaves it.
    const open = closeOverlay() || !!options || diffFindOpen || !!markPending || !!claudeAsk;
    paletteOpen = viewPickOpen = inboxOpen = searchOpen = false;
    options = null;
    if (diffFindOpen) { diffFindOpen = false; clearFind(); }
    markPending = null;
    claudeAsk = null;
    state.goto = null;
    if (open) state.status = 'ready';
    if (i !== active) return switchTab(i);
    schedulePaint();
  }

  /** OAK's tab keys on the herdr tab, before herdr or the program sees them, as a click on OAK's tab bar is (a ctrl+q
   *  held there is dropped with them, and the quit stays armed). Not one herdr's config binds (`tabTaken`, its prefix
   *  among them), which goes on to herdr; and while herdr's prefix waits for its key, `herdrPrefixPart` decides. Their
   *  auto-repeat and release are OAK's too, so F1 on its own tab reaches no one. Returns true when it took the part. */
  function herdrTabKeyPart(part: NativeInputPart): boolean {
    if (prefixHeld) return false;
    const ev = part.events.length === 1 && part.events[0].t === 'key' ? part.events[0] as Partial<NativeKeyEvent> & { key: string } : undefined;
    const key = ev && tabKeyOf(ev);
    if (!key || herdrConfig().tabTaken[key]) return false;
    if (!ev.event || ev.event === 'press') tabKeyPressed(key);
    return true;
  }

  /** The OAK tab herdr's prefix then `m` returns to: the last one used, else the Observatory. */
  function toOakTab(): void {
    const i = lastOakTab >= 0 && lastOakTab < tabs.length && tabs[lastOakTab].kind !== 'native' ? lastOakTab
      : tabs.findIndex((t) => t.kind !== 'native');
    if (i >= 0) switchTab(i);
  }

  /**
   * herdr's prefix on the herdr tab. OAK sees each key before the client does; the prefix is held until the
   * next key says whose it is. `m`, `M` and `V`, and the tab keys F1 to F3, are OAK's when herdr leaves them
   * unbound (defaults and the reader's config.toml both counted); any other key goes to herdr with the prefix
   * in front, unchanged, so herdr's own bindings, and the prefix pressed twice, work exactly as they do without OAK.
   * Returns true when the part was taken here. `herdrHolds`: the part is the motion or release of a button herdr
   * holds, which reaches herdr wherever it is let go.
   */
  function herdrPrefixPart(part: NativeInputPart, sess: NativeSession, herdrHolds = false): boolean {
    const ev = part.events.length === 1 && part.events[0].t === 'key' ? part.events[0] : undefined;
    const kitty = ev && 'event' in ev ? ev as NativeKeyEvent : undefined;
    const chord = !!kitty && !!(kitty.super || kitty.hyper || kitty.meta);
    // A super chord can be the prefix itself (super+b, which herdr reads from a terminal with the kitty protocol).
    if (!prefixHeld && (!ev || (kitty && kitty.event !== 'press'))) return false; // mouse, paste, releases
    const cfg = herdrConfig();
    if (prefixHeld) {
      // A release, an auto-repeat, or a modifier pressed on its own (kitty's report-all-keys flag, which herdr
      // asks the terminal for when a pane's program does: shift on its way to M) is still the prefix being pressed.
      if (kitty && (kitty.event === 'release' || kitty.event === 'repeat' || modifierOnly(kitty))) {
        prefixHeld = Buffer.concat([prefixHeld, part.bytes]);
        return true;
      }
      // Pointer motion, the wheel and focus changes (OAK turns on 1003 and 1004 for this tab) say nothing about
      // whose the prefix is: they go on to herdr and the prefix stays held. Keys, clicks and pastes decide.
      if (passesThrough(part)) return false;
      const held = prefixHeld;
      prefixHeld = null;
      // A click herdr never receives (OAK's tab bar, the rows under herdr's screen) drops the prefix with it. Sent
      // on alone, it left herdr waiting in prefix mode, and the next key typed on its tab ran as a herdr command. The
      // release of herdr's own drag let go there does reach herdr, and the prefix goes on before it.
      if (part.events.some((e) => e.t === 'mouse') && !reachesProgram(part, herdrHolds)) {
        state.status = 'ready';
        return false;
      }
      // ctrl+q as OAK's quit reads it (herdrQuitPart): with shift, super, hyper or meta it is another key, and herdr's.
      if (ev && ev.ctrl && !ev.alt && !ev.shift && !chord && ev.key === 'q') {
        // A prefix of ctrl+q pressed twice is herdr's literal prefix, as every other prefix is: OAK's quit is
        // then on its own tabs. Otherwise ctrl+q is OAK's quit, and the prefix before it is dropped.
        if (cfg.prefixes.some((k) => k.ctrl && !k.alt && !k.shift && !k.super && !k.hyper && k.key === 'q')) {
          sess.write(held);
          sess.write(part.bytes);
          state.status = 'ready';
          schedulePaint();
          return true;
        }
        return false;
      }
      const mine = ev && !chord && !ev.ctrl && !ev.alt && (cfg.oak as string[]).includes(ev.key) ? ev.key : null;
      state.status = 'ready';
      if (mine === 'm') { toOakTab(); return true; }
      // M pins herdr's focused session, which goes to OAK's tabs too, so it is the way back when herdr took m; V opens
      // Review on it, the same way.
      if (mine === 'M') { pinHerdrFocused(); return true; }
      if (mine === 'V') { reviewHerdrFocused(); return true; }
      // A tab key is OAK's after the prefix as before it, and the prefix goes with it, as with m, unless herdr's config binds
      // it there.
      const tab = ev && tabKeyOf(ev);
      if (tab && !cfg.taken[tab]) { tabKeyPressed(tab); return true; }
      sess.write(held);
      schedulePaint();
      return false; // the key itself follows the prefix through the normal route
    }
    const p = pressedPrefix(part, cfg);
    if (!p) return false;
    prefixHeld = Buffer.from(part.bytes);
    // The way back from here: m, M or V, which OAK takes after any prefix it caught, a tab key, or a click when herdr's
    // config binds them all. The widest wording that fits the row, so a narrow terminal drops a part rather than cutting one.
    const hints = herdrPrefixHints(core.herdrKeyLabel(p), cfg.oak, core.OAK_TAB_KEYS.filter((k) => !cfg.taken[k]));
    state.status = hints.find((s) => displayWidth(s) <= frameCols - 1) ?? hints[hints.length - 1];
    schedulePaint();
    return true;
  }

  /** The herdr prefix a part presses, if it presses one: any of those herdr's config lists. Without the kitty
   *  protocol a ctrl chord is one C0 byte, which the decoder names as some other key (ctrl+space as ctrl+`,
   *  ctrl+h as backspace): the prefix is matched on the bytes it sends. */
  function pressedPrefix(part: NativeInputPart, cfg = herdrConfig()): import('@oak-observatory/core').HerdrKey | undefined {
    const ev = part.events.length === 1 && part.events[0].t === 'key' ? part.events[0] : undefined;
    const kitty = ev && 'event' in ev ? ev as NativeKeyEvent : undefined;
    // herdr reads `meta` in its config as alt, and no key with the kitty protocol's own meta.
    if (!ev || (kitty && (kitty.event !== 'press' || kitty.meta))) return undefined;
    // A letter with shift is its capital, as herdr reads both (the kitty protocol reports ctrl+shift+a as `a` with shift, or
    // as `A`), and a capital letter is the letter with shift: ctrl+shift+b is not the prefix ctrl+b. Shift on any other key
    // is part of the key, as it is for herdr: ctrl+shift+space is not ctrl+space, nor shift+f5 f5. shift+tab is backtab.
    const key = ev.shift && /^[a-z]$/.test(ev.key) ? ev.key.toUpperCase() : ev.key;
    const shift = /^[A-Za-z]$/.test(key) || key === 'backtab' ? null : ev.shift;
    // A shifted symbol as the kitty protocol reports it with the alternate keys herdr asks for (alt+! is 49:33;4u, ctrl+_ is
    // 45:95;6u) is, as herdr reads it, that symbol without shift too.
    const shifted = kitty && ev.shift ? Number(/^\x1b\[\d+:(\d+)/.exec(part.bytes.toString('latin1'))?.[1]) : NaN;
    const symbol = shifted > 0 && shifted <= 0x10ffff ? String.fromCodePoint(shifted) : undefined;
    return cfg.prefixes.find((k) => {
      const legacy = kitty ? null : core.legacyKeyBytes(k);
      if (legacy !== null) return part.bytes.equals(Buffer.from(legacy));
      if (!!ev.ctrl !== !!k.ctrl || !!ev.alt !== !!k.alt || !!kitty?.super !== !!k.super || !!kitty?.hyper !== !!k.hyper) return false;
      return (key === k.key && (shift === null || shift === !!k.shift)) || (symbol !== undefined && symbol === k.key && !k.shift);
    });
  }

  /** A kitty report of a modifier on its own (57441-57454, shift to level-5 shift): the flag that reports every
   *  key, which herdr asks the terminal for when a pane's program does, sends one on the way to a chord. */
  const modifierOnly = (kitty: NativeKeyEvent): boolean => /^[\u{e061}-\u{e06e}]$/u.test(kitty.key);
  /** Pointer motion, the wheel and focus changes, which decide nothing about a key held on the herdr tab. */
  const passesThrough = (part: NativeInputPart): boolean => part.events.length > 0
    && part.events.every((e) => e.t === 'focus' || (e.t === 'mouse' && (e.kind === 'move' || e.kind === 'wheel-up' || e.kind === 'wheel-down')));

  /**
   * ctrl+q on the herdr tab, where it is OAK's quit pressed twice, and a key of the program's pressed once
   * (emacs's quoted-insert, zsh's push-line). The first press arms the quit and is held; a second one within
   * the quit window quits. A key, click or paste for the program sends the held ctrl+q on before it, and the
   * window ending sends it on too; herdr's prefix waits for the key after it, so prefix then ctrl+q is the
   * second press. A click on OAK's own rows sends nothing: the ctrl+q stays held and the quit armed. Returns true
   * when it took the part. `herdrHolds` as for herdrPrefixPart.
   */
  function herdrQuitPart(part: NativeInputPart, sess: NativeSession, herdrHolds = false): boolean {
    const ev = part.events.length === 1 && part.events[0].t === 'key' ? part.events[0] : undefined;
    const kitty = ev && 'event' in ev ? ev as NativeKeyEvent : undefined;
    const q = !!ev && ev.ctrl && !ev.alt && !ev.shift && ev.key === 'q' && !(kitty && (kitty.super || kitty.hyper || kitty.meta));
    if (!quitHeld) {
      if (!q || (kitty && kitty.event !== 'press')) return false;
      requestQuit('ctrl+q'); // a quit armed on another tab (ctrl+c on Review) ends here
      const held = Buffer.from(part.bytes);
      const timer = setTimeout(() => {
        if (quitHeld?.timer !== timer) return;
        quitHeld = null;
        if (sess.ended || tabs[active]?.kind !== 'native') return;
        sess.write(held);
        if (state.status === 'press ctrl+q again to exit') state.status = 'ready';
        schedulePaint();
      }, QUIT_WINDOW_MS);
      timer.unref?.();
      quitHeld = { bytes: held, timer };
      return true;
    }
    // Its own repeat or release, or a modifier on its own, is still the held press.
    if (kitty && ((q && kitty.event !== 'press') || modifierOnly(kitty))) {
      quitHeld.bytes = Buffer.concat([quitHeld.bytes, part.bytes]);
      return true;
    }
    if (passesThrough(part)) return false;
    // herdr's prefix decides with the key after it: ctrl+q there is this quit's second press (the prefix is
    // dropped, as before a first one), and any other key sends this ctrl+q on ahead of the prefix. The prefix
    // pressed again once held is such a key (herdr's literal prefix): the ctrl+q goes on ahead of both.
    if (!prefixHeld && pressedPrefix(part)) return false;
    // A click the program never receives (OAK's tab bar, the rows under herdr's screen) decides nothing either: the
    // ctrl+q stays held for the key after it, and the quit stays armed.
    if (part.events.some((e) => e.t === 'mouse') && !reachesProgram(part, herdrHolds)) return false;
    const held = quitHeld.bytes;
    dropQuitHeld();
    if (q) {
      if (quitArmedUntil > Date.now()) { requestQuit('ctrl+q'); return true; }
      // The window ended a moment before its timer ran: the first goes on to the program, and this one starts over.
      sess.write(held);
      return herdrQuitPart(part, sess, herdrHolds);
    }
    quitArmedUntil = 0;
    if (state.status === 'press ctrl+q again to exit') { state.status = 'ready'; schedulePaint(); }
    sess.write(held);
    return false; // the part itself follows through the normal route
  }

  /**
   * The Observatory's own keys, on its session list and conversation panes. Returns false for a key it
   * does not own. Each of these letters means nothing on Review (RESERVED_KEYS in core keeps a rebind
   * off them), so one letter never means two things across the two tabs. Shared by the keyboard and the
   * palette's Observatory rows.
   */
  function observatoryKey(key: string): boolean {
    const tab = tabs[active];
    if (tab?.id !== 'observatory' || !tab.root) return false;
    const focused = leafPanes(tab.root).find(p => p.id === tab.treeFocus);
    const detail = focused?.view === 'session-detail' ? state.observatory?.details[focused.id] : undefined;
    const selection = detail?.selection || state.scopeWorker;
    // With nothing selected these act on the reviewed session: the Review tab's, which the launch rule may
    // have moved to a saved machine while `state.session` stayed the launch session.
    const reviewed = (): string => tabs.find((t) => t.id === 'review')?.session || state.session;
    const session = selection?.session || reviewed();
    const label = selection?.label || session.slice(0, 8);
    if (selection?.agentId && (key === 'R' || key === 'X' || key === 't')) {
      state.status = 'Worker log · select the parent session for its herdr pane or session actions'; schedulePaint(); return true;
    }
    switch (key) {
      case 'W': void openWorkspaceWindow(detail?.selection || workspaceGroupSelection || selection || undefined); return true;
      case 'c': {
        const pane = focused?.view === 'session-detail' ? focused : leafPanes(tab.root).find(p => p.view === 'session-detail');
        if (pane) { tab.treeFocus = pane.id; observatory?.focusReply(pane.id); }
        else state.status = 'Pin a session to reply';
        schedulePaint();
        return true;
      }
      case 't':
        if (selection) jumpHerdr(selection);
        else { state.status = 'select a session to go to its herdr pane'; schedulePaint(); }
        return true;
      case 'd': case 'f': case 'enter':
        // Enter on a session's worker summary opens or closes its group; anything else picked, it pins.
        if (key === 'enter' && state.scopeWorker?.workers === 'all' && workerGroupDrawn(state.scopeWorker)) { toggleOpenKey(`workers:${state.scopeWorker.machineId}:${state.scopeWorker.session}`); return true; }
        if (state.scopeWorker?.session) openConversation(state.scopeWorker.session);
        else pinSession(reviewed(), reviewMachineId(reviewed()));
        return true;
      // Both ask first, and esc (or n) cancels: the blob's resolve and stop buttons, from the keyboard.
      case 'R': blobAction('resolve', session, label, selection || undefined); return true;
      case 'X': blobAction('kill', session, label, selection || undefined); return true;
      case 'B':
        // Changes retention, not identity. A pinned conversation survives the filter.
        state.allSessions = !state.allSessions;
        state.scopeWorker = null;
        state.status = state.allSessions ? 'show archived sessions' : 'hide archived · live panes and unresolved edits';
        schedulePaint();
        return true;
      case 'v': paneOp('view'); return true;
      case '|': case '-': case 'H': case 'J': case 'K': case 'L': paneOp(key); return true;
    }
    if (keys().get(key) === 'zoom') { paneOp('zoom'); return true; }
    return false;
  }

  function focusedReplyPane(): string | undefined {
    const tab = tabs[active];
    if (tab?.id !== 'observatory' || state.overlay || state.confirm || filterOpen || diffFindOpen) return;
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
    // A character at a time, as the row draws it: an emoji built from several, or a letter and its accents, is stepped
    // over and deleted whole. A caret inside one left the row without it, which never fits either side of the caret.
    const left = caret - core.graphemeHead(text, caret - 1).length;
    const right = core.graphemeEnd(text, caret) - caret;
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
    if (filterOpen || diffFindOpen || helpFilter !== null || options?.capture) return true;
    return (ev.key === 'j' || ev.key === 'k') && !keys().get(ev.key);
  }

  function onKey(ev: { key: string; ctrl: boolean; alt: boolean; shift?: boolean; event?: 'press' | 'repeat' | 'release'; action?: import('@oak-observatory/core').Action }): void {
    // ^C arrives as a NAMED key with `ctrl` set — `{key:'c'}` — never as the raw byte. A `case '\x04'`
    // in the verb switch was therefore dead. ^D used to be folded in here too and quit alongside it;
    // it is a pager key now (see the ctrl layer below), because in vim, less and everything that
    // borrows from them ^D is half-page-down, and quitting on it ended the review of whoever scrolled
    // a long diff the way they scroll everything else. ^C alone keeps the quit — that one is universal.
    const ch = ev.ctrl && ev.key === 'c' ? '\x03' : ev.key;
    const replyPane = focusedReplyPane();
    // The reply box types. ^C, and the tab-switch chords (ctrl+n/ctrl+p, alt+<digit>), still leave it.
    const switchChord = (ev.ctrl && !ev.alt && (ev.key === 'n' || ev.key === 'p')) || (ev.alt && !ev.ctrl && /^[1-9]$/.test(ev.key));
    if (replyPane && ch !== '\x03' && !switchChord) return replyKey(replyPane, ev);
    if (ev.event === 'repeat' && !repeatActs(ev)) return;
    // esc during a pane drag cancels it — the pane stays where it was.
    if (paneDrag && ev.key === 'escape') {
      paneDrag = null;
      setPointer('grab');
      state.status = 'move cancelled';
      return schedulePaint();
    }
    // TAB SWITCHING sits above every screen's own handler: the tab bar is chrome that every OAK tab
    // shows, so the key that moves between tabs cannot belong to one of them. Tab and shift+Tab are the
    // plain keys (in the switch below, so a typing wall keeps them); `ctrl+n`/`ctrl+p` and `alt+<digit>`
    // are the chords. On the herdr tab every key is the program's: herdr's prefix then `m` comes back.
    // The digits stay free of a bare binding because a bare digit names an EDIT in this product.
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
    // On a NATIVE tab, keys belong to the program (routed raw in the stdin handler). Once it has EXITED
    // they fall through to here instead — swallow them, or k/u/j would act on the dashboard behind the
    // dead grid. The tab-switch chords above, and Tab / shift+Tab here, still work.
    // An overlay painted OVER a native tab still owns the keyboard (switching
    // tabs with help/options open dead-locked every key — esc could not close, ^C could not arm,
    // and the pty was blocked by the overlay gate too).
    if (tabs[active]?.kind === 'native' && !state.overlay) {
      if (!ev.ctrl && !ev.alt && (ev.key === 'tab' || ev.key === 'backtab') && tabs.length > 1) {
        return switchTab((active + (ev.key === 'tab' ? 1 : tabs.length - 1)) % tabs.length);
      }
      return;
    }
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
        helpFilter = backspaced(helpFilter);
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
    // ←/→ move focus between the two panes; the letters are `observatoryKey`'s. Gated to the observatory
    // tab so these keys keep their meaning everywhere else.
    if (
      !state.overlay && !state.confirm && !filterOpen && !diffFindOpen && !ev.ctrl && !ev.alt &&
      tabs[active]?.id === 'observatory'
    ) {
      const focused = leafPanes(tabs[active].root!).find(p => p.id === tabs[active].treeFocus);
      const onMaster = focused?.view === 'sessions-nav';
      // F4, F5, … are the panes in order (F1 to F3 are OAK's tabs, taken before this).
      const fkey = /^f([1-9][0-9]*)$/.exec(ev.key);
      if (fkey) {
        const panes = leafPanes(tabs[active].root!);
        const pane = panes[Number(fkey[1]) - 4];
        if (pane) {
          const tab = tabs[active];
          if (tab.treeFocus === pane.id) tab.treeZoom = tab.treeZoom === pane.id ? null : pane.id;
          else { tab.treeFocus = pane.id; tab.treeZoom = null; }
          saveLayout(); schedulePaint();
        } else {
          // Said rather than swallowed: a key past the last pane looked dead.
          state.status = `no pane ${ev.key.toUpperCase()} here — ${panes.length === 1 ? 'F4 focuses the only pane' : `F4–F${panes.length + 3} focus the ${panes.length} panes`}`;
          schedulePaint();
        }
        return;
      }
      if (ev.key === 'end' && focused?.view === 'session-detail') return newestConversation(focused.id);
      if (ev.key === 'up' || ev.key === 'down' || ev.key === 'pgup' || ev.key === 'pgdn') {
        const step = ev.key === 'pgdn' ? 10 : ev.key === 'pgup' ? -10 : ev.key === 'down' ? 1 : -1;
        if (onMaster && (ev.key === 'up' || ev.key === 'down')) navObservatory(step as 1 | -1);
        else treeScrollBy(tabs[active].treeFocus ?? '', step);
        return;
      }
      // On the master, → opens the worker group whose summary is picked, and ← closes the group of any row of it that
      // is picked, leaving its summary picked. Otherwise they move between the panes.
      if (onMaster && state.observatoryFold && ['left', 'right', 'enter'].includes(ev.key)) {
        const fold = state.observatoryFold;
        if (ev.key === 'enter' || state.open.has(fold) !== (ev.key === 'right')) toggleOpenKey(fold);
        return;
      }
      if (onMaster && (ev.key === 'left' || ev.key === 'right') && workerFold(ev.key === 'right')) return;
      if (ev.key === 'left') { tabs[active].treeFocus = 'obs-sessions'; return schedulePaint(); }
      if (ev.key === 'right') { tabs[active].treeFocus = 'obs-detail'; return schedulePaint(); }
      if (observatoryKey(ev.key)) return;
      // Every other key: only the ones both OAK tabs share reach the handlers below. The rest are
      // swallowed, never Review's verbs acting on a dock this tab does not draw (typing 12 and Enter
      // pinned a session and left "go to edit #12" in the status row).
      const act = ev.action ?? keys().get(ch);
      // j and k scroll here as they do everywhere (the switch below turns them into ↓ and ↑) while
      // no rebind gives them a verb.
      if ((ch === 'j' || ch === 'k') && !act) return void onKey({ ...ev, key: ch === 'j' ? 'down' : 'up' });
      if (ev.key === 'escape' || ev.key === 'tab' || ev.key === 'backtab' || ch === ':' || (act && OBSERVATORY_SHARED.has(act))) { /* below */ }
      else return;
    }
    // ^C still quits from inside the options window; everything else there belongs to it.
    if (ch !== '\x03' && optionsKey(ev)) return;
    // Escape and ^C are reachable from EVERY mode — including with a filter open, where the old
    // handler swallowed them as filter text and left no way out at all.
    if (ev.key === 'escape') {
      /**
       * THE TEXT WALLS COME FIRST, because this ladder RETURNS.
       *
       * Find-in-diff has its own escape handler further down, and it was unreachable whenever an
       * earlier rung matched — which the last rung, "unselect", does as soon as anything is selected.
       * So with an edit picked, esc unselected the edit and left the prompt OPEN, its status row
       * overwritten by the unselect message, so nothing on screen said the next letters were still
       * going into the find instead of running as keys.
       *
       * It looked fine from a test that opened the prompt without selecting anything first: with
       * nothing picked the ladder falls off the end and reaches the wall's own handler.
       *
       * A standing question comes before all of them: esc is its "no" (the
       * first esc under "stop the running agent?" cleared the selection and left the question up).
       */
      if (state.confirm) return answerConfirm(false);
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
        workspaceGroupSelection = undefined;
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
        state.status = `no mark ‘${name}’ — set one with '${name} first`;
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
        diffFind = backspaced(diffFind);
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

    // An open filter consumes typing. Escape (handled above) clears and closes it; Enter keeps the
    // filter and hands the keyboard back so the reader can act on what they narrowed to.
    if (filterOpen) {
      if (ev.key === 'enter') {
        filterOpen = false;
        state.filterOpen = false;
        return schedulePaint();
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        state.filter = backspaced(state.filter);
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
        pickerFilter = backspaced(pickerFilter);
        return pickerTyped();
      }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        pickerFilter += ev.key;
        return pickerTyped();
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
      if (ch === 'q' || ch === '?' || ev.key === 'enter' || (plain && keys().get(ch) === 'help')) return void closeOverlay();
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
    // F4..F7 are Review's window bar, left to right (BAR_ENTRIES; F1 to F3 are OAK's tabs, taken before this).
    // Map and Diff have a key each, so F6 means "the map" and F7 means "this diff" rather than "the centre,
    // and then find the swap". Pressing the key for what is ALREADY showing zooms it, and again puts it back —
    // the same second-press-drills-in gesture the edit list uses, so full screen costs no new key and no timer.
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
    if (/^f[0-9]+$/.test(ev.key)) {
      state.status = `${ev.key.toUpperCase()} is not a window key — F4 to F7 focus Prompts, Traces, Map and Diff`;
      return schedulePaint();
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
        state.status = state.panX ? `panned ${state.panX} columns — ←→ to pan, ${keyForAction('wrap')} to wrap` : 'at the left edge';
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
     * PgDn/PgUp already move, so ^F and PgDn agree). Anything else is SWALLOWED by the return at the
     * end, which is the whole point — an unbound chord must do nothing, not something. ^R (redo until
     * 0.11.0, now `U`) and ^O (the palette, now `:`) are among them: both agents use them for history
     * and transcript, so on OAK's tabs they do nothing rather than something else.
     */
    if (ev.ctrl) {
      if (ev.key === 'd') return move(5);
      if (ev.key === 'u') return move(-5);
      if (ev.key === 'f') return move(10);
      if (ev.key === 'b') return move(-10);
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
    // reads. Structural keys (F1-F9, arrows, Tab, Enter, Esc, Space, digits) are handled above and are
    // deliberately not rebindable: several of them are the only way out of a mode.
    const verb = ev.action ?? keys().get(ch) ?? null;
    switch (verb ?? ch) {
      // VIM MOVEMENT, bound but kept off the key row, which promises arrows because that is what a
      // reader who has never used vi will try; the `?` help lists both. Every tool in this class binds
      // j/k, and a vim user pressing them into a dead keymap concludes the app is broken.
      // `:` opens the palette, which is also the command line: it lists sessions, tabs and actions, and a
      // typed command (`status`, `comment 12: note`) runs.
      case ':':
        return openPalette();
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
          ? `${marked.size} edit(s) marked — ${keyForAction('keep')}/${keyForAction('undo')} act on all of them, esc clears`
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
          : "no marks yet — set one with ' then a letter";
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
        // One per file: a header's counts line carries its openPath too, and counting it said "4 files" for two.
        const headers = rowsOf('edits', 'traces').filter((r) => r.openPath?.startsWith('edits:') && !r.cont);
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
          ? `long lines pan sideways — ←→ to pan, ${keyForAction('wrap')} to wrap again`
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
        // reader is sitting on when they want the path. Its key carries that path. A Map row names its
        // own path, as it does for `e`, rather than the diff that happens to be open.
        const map = row && !onDiff ? mapRowTarget(row) : null;
        const text = onDiff ? state.diffPatch ?? '' : selectedPath(row) || (map ? ('path' in map ? map.path : '') : state.diffMeta?.path || '');
        if (!text) {
          // The legacy anonymous Map row says why, as `e` does, rather than the generic note.
          state.status = map && 'refuse' in map ? map.refuse : 'nothing here to copy — select an edit, or open its diff';
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
      // Through `move`, so they land where the arrows would: on the first or last row the arrows stop
      // on. `G` set the cursor to the list's last line, which is a file header's counts line, and the
      // selection was drawn on that line with its header left unmarked.
      case 'g':
        return move(-1e9);
      case 'G':
        return move(1e9);
      // `case '\x03'` used to sit here too, and was dead: `ch === '\x03'` already returned 200 lines
      // above, at the only place ^C can reach. Two spellings of one key, one of them unreachable.
      // 'quit' left the keymap with its `q` binding: ^C twice is the one exit.
      // `case '\t'` here was dead: the decoder names this key `tab` (tui/input.ts CTRL_NAME), and
      // `ch` is that name, so the comparison could never be true. `enter` next door was right, which
      // is what made the bug invisible — one key in the table spelled as a byte, the rest as names.
      case 'tab': {
        // Cycle TABS, not panes. Pane focus
        // moves by the arrow keys and the F-keys now, and by the palette's “Focus the next pane” for the full
        // BSP rotation; a bare tab is the one gesture every terminal reader means as "next tab".
        if (tabs.length > 1) switchTab((active + 1) % tabs.length);
        return;
      }
      case 'backtab':
        if (tabs.length > 1) switchTab((active + tabs.length - 1) % tabs.length);
        return;
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
      case 'E': // e and E both open the terminal editor, unless a rebind gave E a verb of its own (dispatched above)
        return openInEditor();
      case 'W':
        return void openSelectionInGuiEditor();
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
      case 'redo':
        return mutateScope('redo', 'one');
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
      case 'refresh':
        return refreshAsking();
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
        state.overlay = { title: 'keys  —  esc or ? to close', lines: helpLines(prefs, herdrConfig()), scroll: 0 };
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
export function helpLines(prefs: import('@oak-observatory/core').Prefs, herdr: import('@oak-observatory/core').HerdrPrefix = herdrPrefixFrom('')): string[] {
  const km = coreKeymap(prefs);
  /** The reader's key for an action; `—` when a rebind left it with none (keyConflicts says why). */
  const k = (action: string): string => {
    for (const [key, a] of km) if (a === action) return key;
    return '—';
  };
  /**
   * Rows built from the reader's OWN keymap.
   *
   * This screen used to hard-code its letters, which is how it came to advertise "1-6 screens"
   * for a build that had none — and once keys became rebindable, a hard-coded list is a list
   * that lies to exactly the reader who customised it.
   */
  const boundRows = (rows: readonly (readonly [string, string])[]): string[] =>
    rows.map(([action, what]) => `    ${k(action).padEnd(14)} ${what}`);
  const p = herdr.label;
  const prefixRow = (key: OakPrefixKey, what: string): string =>
    herdr.taken[key] ? `    ${`${p} ${key}`.padEnd(19)} your herdr config binds it (${herdr.taken[key]}), so it is herdr's`
      : `    ${`${p} ${key}`.padEnd(19)} ${what}`;
  // The tab keys that leave the herdr tab, F2 and F3, where herdr's config leaves them to OAK.
  const away = (['f2', 'f3'] as const).filter((k) => !herdr.tabTaken[k]).map((k) => k.toUpperCase()).join(' or ');
  // A prefix OAK follows only through the kitty keyboard protocol (ctrl+shift+a, super+b) leaves the herdr tab by a tab key or
  // a click from any other terminal, as the key row says; one OAK does not follow at all, or after which herdr's config binds
  // m, M and V, only by those, as the key row and the status row say.
  const click = (why: string): string => `    ${"click OAK's tab bar".padEnd(19)} from the herdr tab, back to OAK's tabs: ${why}`;
  const prefixRows = !herdr.prefixes.length ? [click(`OAK does not follow herdr's prefix (${p})`)]
    : [prefixRow('m', 'from the herdr tab, back to the OAK tab you were last on'),
      prefixRow('M', "from the herdr tab, pin its focused pane's session in the Observatory"),
      prefixRow('V', "from the herdr tab, open Review on its focused pane's session"),
      ...(!herdr.oak.length ? [click(`your herdr config binds m, M and V${away ? `; ${away} leaves it too` : ''}`)] : herdr.prefix ? []
        : [`                        (${herdr.oak.length > 1 ? `${herdr.oak.length === 2 ? 'both' : 'all three'} ` : ''}only from a terminal that reports keys with the kitty keyboard protocol;`,
          `                        from any other, ${away ? `${away}, or a click on OAK's tab bar, leaves` : "click OAK's tab bar to leave"} the herdr tab)`])];
  return [
      '  TABS',
      "    herdr               the native herdr client; herdr's tab bar starts agents. Every key there but F1 to F3",
      `                        is the program's, or herdr's after its prefix (${p}, read from herdr's config)`,
      '    Observatory         machine → workspace → agent pane → session → Workers; pinned conversation beside it',
      '    Review              captured edits and keep/undo',
      '    F1 / F2 / F3        herdr / Observatory / Review, from every tab and over every overlay, which closes first;',
      "                        on the herdr tab before herdr or the program sees them, with herdr's prefix or without,",
      "                        unless herdr's config binds the key. A box you typed in closes and drops the text (the",
      '                        palette, the session picker or help search, find in the diff, an options entry); a',
      '                        standing question keeps them until you answer it',
      ...Object.entries(herdr.tabTaken).map(([k, why]) => `                        ${k.toUpperCase()}: your herdr config binds it (${why}), so on the herdr tab it is herdr's`),
      ...OAK_TAB_KEYS.filter((k) => herdr.taken[k]).map((k) => `                        ${p} ${k.toUpperCase()}: your herdr config binds it (${herdr.taken[k]}), so it is herdr's`),
      '    Tab / shift+Tab     next / previous tab, from Observatory and Review (ctrl+n / ctrl+p and alt+1-3 too)',
      ...prefixRows,
      `                        after ${p} every other key is herdr's own${herdr.detach ? `: ${herdr.detach} detaches its client,` : ','} and`,
      `                        ${p} pressed twice sends it to the program. Inside a herdr pane (oak attach)`,
      '                        herdr keeps its prefix, and Tab / shift+Tab and F2 / F3 switch OAK tabs.',
      "    ctrl+q twice        quit OAK from any tab (repeat within two seconds to confirm); when herdr's",
      "                        prefix is ctrl+q, that is herdr's on its tab and OAK quits from its own tabs.",
      '                        Pressed once on the herdr tab, ctrl+q reaches the program when the two seconds',
      '                        pass, or before the next key you press there',
      '    drag a bottom row   copy the status row, the usage bar or the key row, on any tab. A drag in a',
      "                        status cut at the terminal's edge that reaches that edge, or goes on past",
      '                        the row, copies the rest of the status too',
      '',
      '  OBSERVATORY',
      '    ↑/↓ or j/k          select a session: the detail header and the Review tab follow it',
      "                        (its workers row, and an open group's headers and workers, are stops too)",
      '    Enter / d / f       pin the selected conversation; browsing keeps the pin',
      "                        (Enter on a session's workers row opens or closes its group of workers)",
      '    click a session     pin its conversation — its pane line, title or stats line',
      "                        (a click on its workers row opens or closes it; one on a worker opens its live log)",
      '    c / esc             focus / leave the pinned reply box; Enter sends through herdr',
      '                        blocked sessions, and working ones with a question waiting, need an answer',
      '                        in herdr; no pane disables replies',
      "    t                   go to the session's herdr pane",
      '    W                   open this workspace window in your GUI editor (one machine and workspace)',
      '    R                   resolve the session: keep its pending edits and clear its store (asks first)',
      "    X                   stop the session's running agent (asks first; esc or n cancels either)",
      '    B                   show or hide archived sessions (no pane, no pending edits and no worker at it)',
      '    buttons             ↗ herdr · ⌕ review · ⚑ resolve · ■ stop, under the session title',
      '    F4, F5, …           focus a pane; press again to zoom, again to restore',
      '    ←/→                 focus master / detail; wheel or PgUp/PgDn scroll each pane',
      "                        (on a session's workers row, → opens its group and ← closes it)",
      '    End / ↓ newest      jump to the newest message and follow the conversation',
      '    click a fold        expand thinking, action boxes, Workers or Tasks',
      '    drag across text    copy it; the selection stays in its pane and copies on release',
      `    ${`${k('inbox')} ${k('nextHand')} ${k('refresh')} ${k('session')} ${k('filter')}`.padEnd(19)} the inbox, the next hand, refresh, sessions and the filter, as on Review`,
      '',
      '  OBSERVATORY PANES',
      `    ${`${k('zoom')} / v`.padEnd(19)} zoom the focused pane / choose what it shows`,
      '    | / -               split the focused pane side by side / stacked, then choose what it shows',
      '    H J K L             swap the focused pane with its neighbour left / below / above / right',
      '    :  close pane       close the focused pane; the palette lists every pane operation',
      '    drag a pane by its TITLE onto another: the middle swaps them, an edge places it beside;',
      '    drag a rule to resize. The mouse pointer shows what a spot does (kitty, Ghostty, foot,',
      '    xterm; inside tmux: set -g allow-passthrough on).',
      '',
      '  REVIEW WINDOWS',
      '    F4 / F5             focus Prompts / Traces',
      '    F6 / F7             focus Map / Diff; a second press zooms',
      `    ${`${k('minimize')} / ${k('zoom')}`.padEnd(19)} minimize / zoom the focused window; drag seams to resize`,
      `    ${`< / > / ${k('reset')}`.padEnd(19)} shrink / grow the focused window / reset the layout (, . and _ too)`,
      '    drag across a body  copy characters (OSC 52)',
      '',
      '  THE DETAIL NAVBAR  (click a button, or use the key)',
      `    Keep / Undo    ${k('keep')} / ${k('undo')} — act on the edit Detail is SHOWING`,
      `    prev / next    ${k('prev')} / ${k('next')} — step the review one edit at a time, from any window`,
      '                   (with a find standing on the Diff face they repeat it instead, and',
      '                    N goes back a match; esc or moving the selection ends the find)',
      '',
      '  MOVING',
      '    ↑↓ or j/k       move the selection in the FOCUSED window; on Detail, scroll the diff',
      '    PgUp / PgDn     move ten              g / G   first / last row',
      `    ← / →           pan a long diff line while long lines pan (${k('wrap')})`,
      '    0-9 then enter  go to an edit by its id (esc cancels, backspace deletes)',
      '    space           fold or unfold a change-map folder, or a Traces file group',
      `    ${k('fold').padEnd(15)} fold or unfold every file group in the Traces list at once`,
      '    enter           open — a folder on Map, otherwise the edit full screen',
      '    esc             back — closes a zoom, a prompt scope, a filter or an overlay',
      '',
      '  REVIEWING  (these act on the focused window only)',
      ...boundRows([
        ['keep', 'keep the selection — on the Map, everything under the row'],
        ['undo', 'undo the selection — on the Map, everything under the row'],
        ['redo', 'redo the selection (an undone edit)'],
        ['keepAll', 'keep everything the window lists — on the Map, the whole SESSION'],
        ['undoAll', 'undo everything the window lists — on the Map, the whole SESSION'],
      ]),
      '    (a single edit is kept, undone or redone at once; a row or marks covering more ask',
      '     first, with the real count. The Map draws its own icon buttons: [ ✓ ] keeps',
      '     and [ ✗ ] undoes on every pending row, [ ↺ ] redoes a reverted one, and the heading',
      '     carries [ ✓ N ] keep-all · [ ✗ N ] undo-all · [ ⚑ ] resolve — the question they',
      '     raise is answered in the map itself, by key or by clicking [ y ] / [ n ])',
      '    y / n          answer a confirmation while one is standing (that question is a wall:',
      '                   it takes every key until you answer; esc is no)',
      '',
      '  CTRL  (a fixed layer)',
      '    ^D / ^U        half a page down / up          ^F / ^B   a whole page',
      '    ^Z             suspend (fg brings it back)    ^C        copy a drag selection, else quit',
      '    ^V             paste into the reply box, a filter, the palette or a search box',
      "    Other ctrl chords do nothing on OAK's tabs (ctrl+a, ctrl+r and ctrl+o among them); on the",
      '    herdr tab they reach the program.',
      '',
      '    P              go to a file — a picker, not a filter: it takes you there and leaves the',
      '                   list alone (the filter narrows; this jumps)',
      '',
      '  MARKS  (vim’s `m` is taken — it minimizes a window — so both jump keys do the work)',
      "    ' then a letter   set a mark on the selected edit",
      '    ` then a letter   go back to it. Marks follow the EDIT, so a re-sort or a filter cannot',
      '                      leave one pointing at a different file. They last for this session.',
      '',
      '  THE LIST',
      ...boundRows([
        ['mark', 'mark or unmark this row — then keep and undo act on every marked edit at once, and esc clears'],
        ['sort', 'order the list by time (newest first) or by name — cycles, and says which is in force'],
        ['wrap', 'wrap long diff lines, or leave them long and pan across with ← →'],
        ['filter', 'filter this tab — scattered letters (pcsi finds packages/core/src/index.ts), or a regex the moment it has regex syntax'],
        ['filter-menu', 'filter options: the file-type / extension buckets to show, and what filter is applied'],
      ]),
      '',
      '  SESSION AND APP',
      ...boundRows([
        ['session', 'choose a session, here or on a saved machine — type to search names and what was said in each'],
        ['inbox', 'needs you — every session waiting on you, the other machines\' too as oak sync brought them, most urgent first, then oak sync\'s open conflicts; enter jumps to a session (another machine\'s is read there), or opens a conflict'],
        ['nextHand', 'jump to the next session waiting on you on this machine (permission, then question, then input)'],
        ['refresh', 'refresh; asks first when .observatoryignore now covers recorded edits, which it drops'],
        ['copy', 'copy the selected path — or the diff, when the Diff face is focused'],
      ]),
      // E opens the terminal editor too, unless a rebind gave E a verb of its own.
      `    ${(km.get('E') ? k('editor') : `${k('editor')} / E`).padEnd(14)} open the selection in the terminal editor (GUI editors detach; terminal ones take over until exit; a saved machine's file opens there, over ssh or Remote-SSH)`,
      `    W              open the selection in the GUI editor, at the edit's line when an edit is selected (${k('options')} sets it; a saved machine's file opens through Remote-SSH, a JetBrains IDE's project through Gateway)`,
      ...boundRows([
        ['options', 'options (editor, display, store, sync, keys)'],
        ['help', 'these keys'],
      ]),
      '    :              the palette: type a command (status, doctor, store, ignore, version, help,',
      '                   comment [<line>:] <note>, send-comments, quote) and Enter runs it; or type to',
      '                   find sessions, tabs, workspaces and actions (scattered letters work)',
      '',
      '  OVERLAYS  ↑↓ or j/k move, Enter chooses, esc or q closes; the palette, the session picker and',
      '  the help filter type, so q is text there: esc closes them, as F1 to F3 do.',
      '',
      "  ctrl+q twice quits on every tab (OAK's own when herdr's prefix is ctrl+q); ctrl+c twice shares its confirmation.",
      '',
      '  Every verb key above is READ FROM YOUR OWN KEYMAP, so a rebind shows here the moment you',
      '  make it, and the options window rebinds them. It refuses the keys the frame keeps for',
      "  itself — Space, the digits, : ' ` and the Observatory's own c d f t v B H J K L R W X | -;",
      '  F-keys, arrows, Tab, Enter and Esc are never offered, because they are how you leave a mode.',
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
