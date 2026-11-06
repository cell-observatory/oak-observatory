/**
 * The options window, as a value.
 *
 * btop's settings screen is the model: one scrollable list, categories as headings, the current value
 * on the right of each row, and left/right to change it in place. No sub-dialogs — a settings screen
 * that opens more settings screens is one the reader has to navigate rather than read.
 *
 * Everything here is pure. `optionRows` turns a `Prefs` into display rows; `applyOption` turns a row
 * and a direction into a NEW `Prefs`. The runtime owns the file and the keyboard, and this module
 * owns what the reader sees and what each keystroke means — which is what lets every degradation and
 * every edit be asserted without a terminal.
 */
import { displayWidth, fitVisible, wrapVisible } from './textwidth';
import { ColorDepth, Glyphs, tint } from './glyphs';
import { syncBackupLine, type SyncView } from './observatory';
import {
  Prefs,
  Action,
  DEFAULT_NOTIFY_KINDS,
  REBINDABLE,
  RESERVED_KEYS,
  keyConflicts,
  ColorPref,
  GlyphPref,
  START_FOCUS,
  SORT_KEYS,
  THEME_NAMES,
  EditorChoice,
  editorLabel,
  editorKind,
  GUI_EDITOR_SOURCE,
  GuiEditorSource,
  relTime,
} from '@oak-observatory/core';

/** The keys of prefs.json the terminal app sets: its layout, and what this window edits (the sort key steps one of
 *  them). It saves only these, over the file as it is then, so a key set elsewhere while it runs (`oak usage
 *  --bill-day`, `oak titles`, a hand edit) stays as set. Two of them are set elsewhere too: `storeDir` by `oak store
 *  --move` and the editors, and `sort` by VS Code; the app saves those only when it changes them itself. */
export const APP_PREF_KEYS = ['layout', 'editor', 'guiEditor', 'color', 'glyphs', 'mouse', 'refreshSeconds', 'startFocus', 'sort', 'syntax',
  'theme', 'notify', 'keys', 'blockedKeys', 'storeDir'] as const satisfies readonly (keyof Prefs)[];
export type AppPrefKey = (typeof APP_PREF_KEYS)[number];

/** What the runtime knows and this module cannot look up: the environment behind the fallbacks, and
 *  the editors found on this machine. Passed to `optionRows` AND `applyOption`, so the list ←→ steps
 *  through is by construction the list the row displays. */
export interface OptionEnv {
  editor?: string;
  term?: string;
  file?: string;
  editors?: readonly EditorChoice[];
  /** What the GUI editor's Auto resolves to here now (core's resolveGuiEditor without the setting), null when nothing
   *  does: W would refuse. */
  gui?: { command: string; source: GuiEditorSource } | null;
  /** The RESOLVED store root, as `rootDir()` reports it right now. Passed in rather than looked up
   *  because this module is pure — and shown even when unset, because "where is my data" is the
   *  question, and a row that only appears once you have changed it answers it for nobody. */
  store?: string;
  /** oak sync, while it is in use here or a machine is saved (otherwise the window has no SYNC section): the last
   *  `oak sync status --json` (null until it is read), the saved machines' labels, this workspace's project (its
   *  identity key and folder), and the time the run's clock times are said against. Its rows run the CLI. */
  sync?: { status: SyncView | null; machines: readonly string[]; project?: { key: string; folder: string }; now: number };
}

/**
 * The values the editor row cycles, in order: "follow the environment" first, then everything found on
 * this machine, then whatever the reader has typed if it is none of those.
 *
 * The typed value is appended rather than dropped because stepping off a custom command and back must
 * return it — a settings list that silently forgets what you configured is worse than one that cannot
 * step at all.
 */
export function editorChoices(p: Prefs, env: OptionEnv): string[] {
  const list = ['', ...(env.editors ?? []).map((e) => e.command)];
  if (p.editor && !list.includes(p.editor)) list.push(p.editor);
  return list;
}

/** The values the GUI editor row cycles: Auto (''), the GUI editors found here, then a typed command that is neither. */
export function guiEditorChoices(p: Prefs, env: OptionEnv): string[] {
  const list = ['', ...(env.editors ?? []).map((e) => e.command).filter((c) => editorKind(c) === 'gui')];
  if (p.guiEditor && !list.includes(p.guiEditor)) list.push(p.guiEditor);
  return list;
}

export type OptionKind =
  /** A heading. Not selectable, carries no value. */
  | 'heading'
  /** Cycles through a fixed list with left/right. */
  | 'choice'
  /** Off/on with left/right or enter. */
  | 'toggle'
  /** A number, stepped with left/right. */
  | 'number'
  /** Free text, typed after enter. */
  | 'text'
  /** A single key, captured after enter. */
  | 'key'
  /** Runs something; enter presses it. */
  | 'action';

export interface OptionRow {
  kind: OptionKind;
  /** Stable identity — what `applyOption` dispatches on. Empty for headings. */
  id: string;
  label: string;
  /** The current value, already formatted. Empty for headings. */
  value: string;
  /** One line saying what this does and what happens if it is wrong. */
  help: string;
  /** Set when this row's setting is broken — a duplicate keybinding, say. */
  problem?: string;
  /** The values ←→ steps through, when a row offers a list AND still takes a typed value. Present on
   *  the editor row: the choices are what this machine actually has, and enter still types anything. */
  choices?: string[];
  /** A line rendered under the row ALWAYS, not only when selected — unlike `help`. For the two rows
   *  whose value IS a path: "where does this keep my data" is answered by a path being on screen, and
   *  a path you have to select a row to see answers it for nobody. Deliberately rare; the selected-only
   *  rule exists because a list where every row explains itself is a wall of prose nobody reads. */
  detail?: string;
}

const COLORS: ColorPref[] = ['auto', 'truecolor', '256', '16', 'none'];
const GLYPHS: GlyphPref[] = ['auto', 'ascii', 'safe', 'block'];

/**
 * Every row of the options window, for a given `Prefs`.
 *
 * The environment is shown where it is what a value falls back to — an `editor` row reading `auto`
 * says nothing useful when `$EDITOR` is unset and the key it configures will refuse, so the row
 * reports what the fallback ACTUALLY resolves to right now.
 */
export function optionRows(p: Prefs, env: OptionEnv = {}): OptionRow[] {
  const conflicts = keyConflicts(p);
  const editors = env.editors ?? [];
  const named = p.editor ? editorLabel(p.editor, editors) : '';
  const rows: OptionRow[] = [
    // Where these are kept, FIRST and in full. A title bar is fitted to the terminal and fitting a
    // path means cutting one, which is the single thing this product never does to a path; and at the
    // foot of the list it sat below seventeen keybindings, where nobody would find it.
    ...(env.file
      // The path rides the HELP line, which is full width. The value column is a fixed 28 cells, and
      // a path fitted into 28 cells is a path that does not exist.
      ? ([{ kind: 'action', id: 'file', label: 'Saved in', value: 'prefs.json', help: env.file, detail: env.file }] as OptionRow[])
      : []),
    // WHERE THE DATA IS. Second, right under the settings file, because the two together are the
    // whole answer to "where does this thing keep things".
    ...(env.store
      ? ([{
          kind: 'text',
          id: 'storeDir',
          label: 'Store',
          value: p.storeDir ? 'moved' : 'default',
          // The path rides its OWN line, full width and always on: the value column is 28 cells and a
          // path fitted into 28 cells is a path that does not exist.
          detail: env.store,
          help: 'enter to move it — absolute, or ~/somewhere. Blank restores the default. The move takes your existing sessions with it.',
        }] as OptionRow[])
      : []),
    { kind: 'heading', id: '', label: 'EDITOR', value: '', help: '' },
    {
      kind: 'text',
      id: 'editor',
      label: 'Terminal editor',
      value: p.editor || (env.editor ? `${env.editor}  (from the environment)` : 'not set'),
      // The list is what THIS machine has. An editor the reader does not own is never offered, so a
      // choice made here can always be run — and the row shows the command rather than a friendly
      // name, because the flag is the part that matters and the part they would get wrong by hand.
      choices: editorChoices(p, env),
      help: named
        ? `${named}: the terminal editor \`e\` and E run. ←→ steps through the ${editors.length} editor(s) found here; enter types any command. Blank follows $VISUAL then $EDITOR.`
        : editors.length
          ? `The terminal editor \`e\` and E run. ←→ steps through the ${editors.length} editor(s) found here; enter types any command. Blank follows $VISUAL then $EDITOR. Terminal editors take the dashboard over until they exit; a GUI one here opens its own window.`
          : 'The terminal editor `e` and E run. Blank follows $VISUAL then $EDITOR. Arguments are allowed: `emacsclient -nw`.',
      problem: p.editor || env.editor ? undefined : 'nothing to run — `e` will refuse until this or $EDITOR is set',
    },
    {
      kind: 'text',
      id: 'guiEditor',
      label: 'GUI editor',
      value: p.guiEditor || (env.gui ? `auto: ${env.gui.command}` : 'auto'),
      choices: guiEditorChoices(p, env),
      help: `What W opens: the session's workspace window on the Observatory, the selected edit at its line on Review. ←→ steps through Auto and the GUI editors found here; enter types any command. Auto takes the terminal editor, $VISUAL or $EDITOR when it is a GUI editor, then the editor whose terminal this is, then the first GUI editor on PATH${env.gui ? ` (now ${env.gui.command}, from ${GUI_EDITOR_SOURCE[env.gui.source]})` : ''}.`,
      problem: p.guiEditor
        ? editorKind(p.guiEditor) === 'gui' ? undefined : `${p.guiEditor} is a terminal editor (or one OAK does not know) — W will refuse it; pick a GUI editor, or blank for Auto`
        : env.gui === null ? 'no GUI editor found — W will refuse until this is set' : undefined,
    },
    { kind: 'heading', id: '', label: 'DISPLAY', value: '', help: '' },
    {
      kind: 'choice',
      id: 'color',
      label: 'Colour',
      value: p.color ?? 'auto',
      help: `auto reads the terminal${env.term ? ` (this one says ${env.term})` : ''}. NO_COLOR in the environment always wins.`,
    },
    {
      kind: 'choice',
      id: 'theme',
      label: 'Theme',
      value: p.theme ?? 'default',
      help: 'colorblind swaps the red/green verdict pair for blue/orange. mono leaves the diff the only coloured thing.',
    },
    {
      kind: 'choice',
      id: 'glyphs',
      label: 'Glyph set',
      value: p.glyphs ?? 'auto',
      help: 'ascii is safe everywhere. block needs a font with the shading characters; auto measures.',
    },
    {
      kind: 'toggle',
      id: 'syntax',
      label: 'Syntax colour',
      value: p.syntax === false ? 'off' : 'on',
      help: 'Colours code the way an editor does — every line of a diff, added and removed included. The add/remove bands are the background and stay exactly as they are. On by default.',
    },
    {
      kind: 'toggle',
      id: 'mouse',
      label: 'Mouse',
      value: p.mouse === false ? 'off' : 'on',
      help: 'Off returns click-drag to the terminal for copying. Every mouse action has a key.',
    },
    {
      kind: 'number',
      id: 'refreshSeconds',
      label: 'Refresh every',
      value: `${p.refreshSeconds ?? 3}s`,
      help: 'How often the dashboard re-reads the store. Each refresh spawns a child process.',
    },
    {
      kind: 'choice',
      id: 'sort',
      label: 'Order the list by',
      value: p.sort ?? 'time',
      help: 'How the change map and Traces are ordered — cycles: time (newest first), time-asc (oldest), name (A→Z), name-desc (Z→A).',
    },
    { kind: 'heading', id: '', label: 'ON OPEN', value: '', help: '' },
    {
      kind: 'toggle',
      id: 'startFocus',
      label: 'Focus this window',
      value: p.startFocus ?? 'traces',
      help: 'Which window has the keyboard when the dashboard opens.',
    },
    { kind: 'heading', id: '', label: 'NOTIFICATIONS', value: '', help: '' },
    {
      kind: 'toggle',
      id: 'notify.desktop',
      label: 'Desktop notifications',
      value: p.notify?.desktop === false ? 'off' : 'on',
      help: 'A native notification when an agent raises its hand — a permission prompt, a question, an input wait. Once per machine, from whichever surface sees it first.',
    },
    {
      kind: 'toggle',
      id: 'notify.sound',
      label: 'Sound',
      value: p.notify?.sound ? 'on' : 'off',
      help: 'Play the system sound with the notification (one your terminal posts uses the terminal’s own sound).',
    },
    {
      kind: 'toggle',
      id: 'notify.done',
      label: 'Also when a turn finishes',
      value: (p.notify?.kinds ?? DEFAULT_NOTIFY_KINDS).includes('idle-done') ? 'on' : 'off',
      help: 'Announce a finished turn too. Off by default: the panels show it; a prompt the agent cannot pass is what deserves a notification.',
    },
    {
      kind: 'number',
      id: 'notify.cooldown',
      label: 'Cooldown',
      value: `${p.notify?.cooldownSeconds ?? 30}s`,
      help: 'A session that raises its hand again within this many seconds stays quiet — unless the new wait is more urgent. Steps by 5.',
    },
  ];
  if (env.sync) rows.push(...syncRows(env.sync));
  rows.push({ kind: 'heading', id: '', label: 'KEYS', value: '', help: '' });
  for (const r of REBINDABLE) {
    const c = conflicts.find((x) => x.action === r.action);
    const blocked = p.keys?.[r.action] ? undefined : p.blockedKeys?.[r.action];
    rows.push({
      kind: 'key',
      id: `key:${r.action}`,
      label: r.label,
      value: p.keys?.[r.action] ?? r.fallback,
      help: 'Enter, then press the key you want. Esc keeps the current one.',
      problem: c ? `also bound to ${c.takenBy} — that one wins, this action has no key`
        : blocked ? `your saved key ${blocked === ' ' ? 'space' : blocked} is now kept for the frame itself, so ${r.fallback} runs this until you choose another` : undefined,
    });
  }
  rows.push(
    { kind: 'heading', id: '', label: 'THIS BUILD', value: '', help: '' },
    {
      kind: 'action',
      id: 'reset',
      label: 'Reset every option',
      value: '',
      help: 'Back to the defaults for this window and the layout. Settings made outside it, such as the bill days and `oak titles --off`, are kept.',
    }
  );
  return rows;
}

/**
 * The SYNC section. Its truth is prefs.json, which only the CLI writes for sync: each row's work is a command the
 * runtime starts (`oak sync setup`, which asks on the terminal where sessions are backed up and where a folder's key
 * comes from; `--restore` when a run refused the folder's record under this machine's name; `oak sync now`; and
 * `oak sync include` or `exclude` for a saved machine or a project), and `applyOption` leaves them alone.
 */
function syncRows(s: NonNullable<OptionEnv['sync']>): OptionRow[] {
  const st = s.status;
  const b = st?.backup ?? null;
  const line = st ? syncBackupLine(st) : undefined;
  const failed = line && line.status !== 'ok' ? line.text ?? line.detail ?? line.status : undefined;
  const last = st?.last;
  const offMachines = new Set(st?.exclude.machines ?? []);
  const offProjects = new Set(st?.exclude.projects ?? []);
  const rows: OptionRow[] = [
    { kind: 'heading', id: '', label: 'SYNC', value: '', help: '' },
    {
      // The value a word, so it fits its column: what it names goes in the detail, which wraps.
      kind: 'action', id: 'sync.setup', label: 'Backup', value: !b ? 'none' : b.kind,
      detail: b?.kind === 'folder' && st
        ? [b.path, st.key.present ? `key ${st.key.fingerprint}` : `no key here${st.key.error ? `: ${st.key.error}` : ''}`, ...(failed ? [failed] : [])].join(' · ')
        : b?.kind === 'machine' ? b.label : failed,
      help: 'enter runs `oak sync setup` here: it asks where sessions are backed up (nowhere else, a saved machine, or an encrypted folder) and where a folder\'s key comes from',
    },
  ];
  if (line?.record) {
    rows.push({ kind: 'action', id: 'sync.restore', label: 'This machine is a reinstall', value: '',
      help: 'enter asks, then takes the folder\'s record under this machine\'s name over (`oak sync setup --restore`): the next run restores this machine\'s sessions from it' });
  }
  rows.push({
    kind: 'action', id: 'sync.now', label: 'Sync now', value: st?.running ? 'running…' : last ? last.status : 'not run yet',
    ...(last ? { detail: `last run ${relTime(last.at, s.now)}${last.error ? ` · it stopped: ${last.error}` : ''}` } : {}),
    help: 'enter runs `oak sync now`: it pulls what this machine keeps from the saved machines, and shows what the run did; enter again stops a run started here',
  });
  // The last run whole, in an overlay that scrolls: as many lines as it has, which no row of this window could hold.
  if (last) {
    const failing = last.machines.filter((m) => m.errors.length > 0 || !['ok', 'disabled', 'excluded', 'duplicate', 'shared'].includes(m.status)).length;
    const n = (k: number, one: string): string => `${k} ${one}${k === 1 ? '' : 's'}`;
    rows.push({ kind: 'action', id: 'sync.last', label: 'The last run', value: '',
      detail: [n(last.machines.length, 'machine'), ...(failing ? [`${failing} failed`] : []), ...(last.warnings.length ? [n(last.warnings.length, 'warning')] : [])].join(' · '),
      help: 'enter shows `oak sync status`: each machine\'s line, the conflicts and the warnings' });
  }
  const toggle = (id: string, label: string, on: boolean, what: string, detail?: string): OptionRow => ({
    kind: 'toggle', id, label, value: on ? 'on' : 'off', ...(detail ? { detail } : {}),
    help: `enter or ←→ runs \`oak sync ${on ? 'exclude' : 'include'} ${what}\``,
  });
  // Each saved machine, and any machine excluded here that is no longer saved, which can still be brought back.
  for (const m of new Set([...s.machines, ...offMachines])) rows.push(toggle(`sync.machine:${m}`, `Sync with ${m}`, !offMachines.has(m), m));
  if (s.project) rows.push(toggle('sync.project', 'Sync this project', !offProjects.has(s.project.key), s.project.folder, `${s.project.folder} (${s.project.key})`));
  for (const key of offProjects) if (key !== s.project?.key) rows.push(toggle(`sync.project:${key}`, 'Sync the project', false, key, key));
  return rows;
}

/** Rows the cursor can land on. Headings are skipped, so the cursor never sits on nothing. */
export function selectableRows(rows: readonly OptionRow[]): number[] {
  return rows.map((r, i) => (r.kind === 'heading' ? -1 : i)).filter((i) => i >= 0);
}

/**
 * Apply one left/right step to a row, returning NEW prefs.
 *
 * Text and key rows are not stepped — they are captured by the runtime, which then calls
 * `setOption`. Splitting it this way keeps every value change in one pure place regardless of
 * whether it arrived from an arrow or from a captured keystroke.
 */
export function applyOption(p: Prefs, id: string, dir: -1 | 1, env: OptionEnv = {}): Prefs {
  const next: Prefs = { ...p, keys: p.keys ? { ...p.keys } : undefined };
  const cycle = <T,>(list: T[], cur: T): T => list[(list.indexOf(cur) + (dir === 1 ? 1 : list.length - 1)) % list.length];
  if (id === 'editor') {
    // Off the same `editorChoices` the row displays, so the list you step through is the list you see.
    // '' is a real member — it is how you get back to following $VISUAL/$EDITOR without clearing a
    // text field — and it stores as ABSENT, which is what `writePrefs` means by "not set".
    const picked = cycle(editorChoices(p, env), p.editor ?? '');
    if (picked) next.editor = picked;
    else delete next.editor;
  } else if (id === 'guiEditor') {
    const picked = cycle(guiEditorChoices(p, env), p.guiEditor ?? '');
    if (picked) next.guiEditor = picked;
    else delete next.guiEditor;
  } else if (id === 'color') next.color = cycle(COLORS, p.color ?? 'auto');
  else if (id === 'glyphs') next.glyphs = cycle(GLYPHS, p.glyphs ?? 'auto');
  else if (id === 'sort') next.sort = cycle(SORT_KEYS, p.sort ?? 'time');
  else if (id === 'theme') next.theme = cycle(THEME_NAMES, p.theme ?? 'default');
  else if (id === 'mouse') next.mouse = !(p.mouse === false) ? false : true;
  // ABSENT means on, so the first toggle must turn it OFF rather than re-affirming the default.
  else if (id === 'syntax') next.syntax = p.syntax === false;
  else if (id === 'refreshSeconds') next.refreshSeconds = Math.max(1, Math.min(3600, (p.refreshSeconds ?? 3) + dir));
  // Notifications: each toggle flips its own field and leaves the others as they were, so a reader who
  // turned sound on does not lose it by later switching the desktop off and on.
  else if (id === 'notify.desktop') next.notify = { ...(p.notify ?? {}), desktop: p.notify?.desktop === false };
  else if (id === 'notify.sound') next.notify = { ...(p.notify ?? {}), sound: !p.notify?.sound };
  else if (id === 'notify.done') {
    const kinds = new Set(p.notify?.kinds ?? DEFAULT_NOTIFY_KINDS);
    if (kinds.has('idle-done')) kinds.delete('idle-done');
    else kinds.add('idle-done');
    next.notify = { ...(p.notify ?? {}), kinds: [...kinds] };
  } else if (id === 'notify.cooldown') next.notify = { ...(p.notify ?? {}), cooldownSeconds: Math.max(0, Math.min(3600, (p.notify?.cooldownSeconds ?? 30) + dir * 5)) };
  else if (id === 'startFocus') next.startFocus = cycle(START_FOCUS, p.startFocus ?? 'traces');
  else{}
  return next;
}

/** Set a captured value — the text of the editor row, or the key of a binding row. */
export function setOption(p: Prefs, id: string, value: string): Prefs {
  const next: Prefs = { ...p, keys: p.keys ? { ...p.keys } : {} };
  if (id === 'editor' || id === 'guiEditor') {
    if (value.trim()) next[id] = value.trim();
    else delete next[id];
    return next;
  }{}
  if (id.startsWith('key:')) {
    const action = id.slice(4) as Action;
    const fallback = REBINDABLE.find((r) => r.action === action)?.fallback;
    if (!value || [...value].length !== 1) return p; // unchanged: a non-key press cancels the capture
    // Space, the digits, `:` and the marks are the frame's own, and the Observatory's letters would give
    // one key two meanings across the tabs: refused, with the reason, rather than saved and never fired.
    if (RESERVED_KEYS.has(value)) {
      return { ...p, __reject: `${value === ' ' ? 'space' : value} is kept for the frame itself (space, the digits, : ' \` and the Observatory's c d f t v B H J K L R X | -) — choose another key` };
    }
    if (value === fallback) delete next.keys![action];
    else next.keys![action] = value;
    if (!Object.keys(next.keys!).length) delete next.keys;
    // A key chosen here replaces the saved one the frame had kept out of the keymap.
    if (next.blockedKeys?.[action]) {
      next.blockedKeys = { ...next.blockedKeys };
      delete next.blockedKeys[action];
      if (!Object.keys(next.blockedKeys).length) delete next.blockedKeys;
    }
    return next;
  }
  return p;
}

/**
 * Render the window body.
 *
 * Two columns — label left, value right — with the help text under the SELECTED row only. Showing
 * every row's help at once turns a settings list into a wall of prose nobody reads; showing none
 * leaves the reader guessing what a switch costs.
 */
export function renderOptions(
  rows: readonly OptionRow[],
  cursor: number,
  cols: number,
  scroll: number,
  height: number,
  g: Glyphs,
  depth: ColorDepth
): string[] {
  const out: string[] = [];
  for (let i = scroll; i < rows.length && out.length < height; i++) out.push(...optionRowLines(rows[i], i === cursor, out.length === 0, cols, g, depth));
  while (out.length < height) out.push(fitVisible('', cols));
  return out.slice(0, height);
}

/** The lines one row of the window draws (`first`: at the top of the window, where a heading needs no blank line
 *  above it). The runtime measures with it too, so the selected row is kept on screen however many lines rows draw. */
export function optionRowLines(r: OptionRow, on: boolean, first: boolean, cols: number, g: Glyphs, depth: ColorDepth): string[] {
  if (r.kind === 'heading') return [fitVisible(first ? ' ' : '', cols), fitVisible(`  ${tint(r.label, 'accent', depth)}`, cols)];
  const valueW = Math.min(28, Math.max(8, Math.floor(cols * 0.3)));
  const labelW = Math.max(10, cols - valueW - 6);
  // The value is padded to a fixed column so the whole list reads as a table; a ragged right edge
  // makes "which of these did I change" a scan rather than a glance. A label wider than its column (a long machine
  // name) wraps above the value rather than being cut.
  const parts = displayWidth(r.label) <= labelW ? [r.label] : wrapVisible(r.label, labelW);
  const lines = parts.map((p, i) => `  ${on && i === 0 ? g.closed : ' '} ${i < parts.length - 1 ? p : `${pad(p, labelW)} ${pad(r.value, valueW)}`}`);
  const out = lines.map((line) => (depth === 'none' || !on ? fitVisible(line, cols) : fitVisible(`\x1b[7m${line}\x1b[0m`, cols)));
  const dim = (seg: string): string => fitVisible(depth === 'none' ? `      ${seg}` : `      \x1b[2m${seg}\x1b[0m`, cols);
  // ALWAYS, not only when selected — see `detail`. Wrapped rather than fitted: this is a path, and
  // a cut path is the one thing this product never renders. A detail of several lines (the last sync run, a
  // machine a line) keeps them.
  if (r.detail) out.push(...r.detail.split('\n').flatMap((l) => wrapVisible(l, Math.max(8, cols - 6))).map(dim));
  // The problem and the help are wrapped too: a sentence cut at the window's edge says less than it should.
  if (r.problem) out.push(...wrapVisible(`! ${r.problem}`, Math.max(8, cols - 6)).map((seg) => fitVisible(`      ${tint(seg, 'risk', depth)}`, cols)));
  if (on && r.help) out.push(...wrapVisible(r.help, Math.max(8, cols - 6)).map(dim));
  return out;
}

function pad(s: string, w: number): string {
  const gap = w - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
