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
import {
  Prefs,
  Action,
  DEFAULT_NOTIFY_KINDS,
  REBINDABLE,
  keyConflicts,
  ColorPref,
  GlyphPref,
  START_FOCUS,
  SORT_KEYS,
  THEME_NAMES,
  EditorChoice,
  editorLabel,
} from '@oak-observatory/core';

/** What the runtime knows and this module cannot look up: the environment behind the fallbacks, and
 *  the editors found on this machine. Passed to `optionRows` AND `applyOption`, so the list ←→ steps
 *  through is by construction the list the row displays. */
export interface OptionEnv {
  editor?: string;
  term?: string;
  file?: string;
  editors?: readonly EditorChoice[];
  /** The RESOLVED store root, as `rootDir()` reports it right now. Passed in rather than looked up
   *  because this module is pure — and shown even when unset, because "where is my data" is the
   *  question, and a row that only appears once you have changed it answers it for nobody. */
  store?: string;
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
      label: 'Editor command',
      value: p.editor || (env.editor ? `${env.editor}  (from the environment)` : 'not set'),
      // The list is what THIS machine has. An editor the reader does not own is never offered, so a
      // choice made here can always be run — and the row shows the command rather than a friendly
      // name, because the flag is the part that matters and the part they would get wrong by hand.
      choices: editorChoices(p, env),
      help: named
        ? `${named}. ←→ steps through the ${editors.length} editor(s) found here; enter types any command. Blank follows $VISUAL then $EDITOR.`
        : editors.length
          ? `←→ steps through the ${editors.length} editor(s) found here; enter types any command. Blank follows $VISUAL then $EDITOR. GUI editors open their own window — \`e\` never blinks the dashboard; terminal editors take it over until they exit.`
          : 'What `e` runs. Blank follows $VISUAL then $EDITOR. Arguments are allowed: `emacsclient -nw`.',
      problem: p.editor || env.editor ? undefined : 'nothing to run — `e` will refuse until this or $EDITOR is set',
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
  rows.push({ kind: 'heading', id: '', label: 'KEYS', value: '', help: '' });
  for (const r of REBINDABLE) {
    const c = conflicts.find((x) => x.action === r.action);
    rows.push({
      kind: 'key',
      id: `key:${r.action}`,
      label: r.label,
      value: p.keys?.[r.action] ?? r.fallback,
      help: 'Enter, then press the key you want. Esc keeps the current one.',
      problem: c ? `also bound to ${c.takenBy} — that one wins, this action has no key` : undefined,
    });
  }
  rows.push(
    { kind: 'heading', id: '', label: 'THIS BUILD', value: '', help: '' },
    {
      kind: 'action',
      id: 'reset',
      label: 'Reset every option',
      value: '',
      help: 'Back to the defaults, and deletes the preferences file.',
    }
  );
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
  if (id === 'editor') {
    if (value.trim()) next.editor = value.trim();
    else delete next.editor;
    return next;
  }{}
  if (id.startsWith('key:')) {
    const action = id.slice(4) as Action;
    const fallback = REBINDABLE.find((r) => r.action === action)?.fallback;
    if (!value || [...value].length !== 1) return p; // unchanged: a non-key press cancels the capture
    if (value === fallback) delete next.keys![action];
    else next.keys![action] = value;
    if (!Object.keys(next.keys!).length) delete next.keys;
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
  const valueW = Math.min(28, Math.max(8, Math.floor(cols * 0.3)));
  const labelW = Math.max(10, cols - valueW - 6);
  for (let i = scroll; i < rows.length && out.length < height; i++) {
    const r = rows[i];
    if (r.kind === 'heading') {
      out.push(fitVisible(out.length ? '' : ' ', cols));
      if (out.length < height) out.push(fitVisible(`  ${tint(r.label, 'accent', depth)}`, cols));
      continue;
    }
    const on = i === cursor;
    // The value is padded to a fixed column so the whole list reads as a table; a ragged right edge
    // makes "which of these did I change" a scan rather than a glance.
    const label = pad(r.label, labelW);
    const value = r.value;
    const line = `  ${on ? g.closed : ' '} ${label} ${pad(value, valueW)}`;
    out.push(
      depth === 'none' || !on
        ? fitVisible(line, cols)
        : fitVisible(`\x1b[7m${line}\x1b[0m`, cols)
    );
    // ALWAYS, not only when selected — see `detail`. Wrapped rather than fitted: this is a path, and
    // a cut path is the one thing this product never renders.
    if (r.detail && out.length < height) {
      for (const seg of wrapVisible(r.detail, Math.max(8, cols - 6))) {
        if (out.length >= height) break;
        out.push(fitVisible(depth === 'none' ? `      ${seg}` : `      \x1b[2m${seg}\x1b[0m`, cols));
      }
    }
    if (r.problem && out.length < height) {
      out.push(fitVisible(`      ${tint(`! ${r.problem}`, 'risk', depth)}`, cols));
    }
    if (on && r.help && out.length < height) {
      out.push(fitVisible(depth === 'none' ? `      ${r.help}` : `      \x1b[2m${r.help}\x1b[0m`, cols));
    }
  }
  while (out.length < height) out.push(fitVisible('', cols));
  return out.slice(0, height);
}

function pad(s: string, w: number): string {
  const gap = w - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
