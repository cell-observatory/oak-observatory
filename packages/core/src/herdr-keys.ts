/**
 * herdr's prefix key, read from herdr's own config, so the terminal app listens on the prefix the
 * reader already uses instead of adding a second one.
 *
 * On its herdr tab OAK sees every key before the herdr client does. After the prefix it keeps only the
 * keys it claims (`OAK_PREFIX_KEYS`) that herdr leaves unbound, defaults and the reader's own
 * config.toml both counted; every other key after the prefix, the prefix itself included, goes on to
 * herdr unchanged. OAK's tab keys (`OAK_TAB_KEYS`) are its own there too, with or without the prefix,
 * unless herdr's config binds them. The file is re-read when it changes, so a prefix changed and
 * reloaded in herdr is the prefix OAK listens on at the next key.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { herdrConfigDir } from './herdr-install';
import { compareVersions } from './semver';
// smol-toml publishes a CJS runtime alongside ESM declarations (codex.ts reads it the same way).
const { parse: parseToml } = require('smol-toml') as { parse(text: string): Record<string, unknown> };

/** A key as the terminal app's decoder names it. A capital letter is the letter with shift; `shift` is shift on any other
 *  key (ctrl+shift+space, shift+f5), which herdr reads as a key of its own. `super` and `hyper` reach a terminal app only
 *  from a terminal that reports keys with the kitty keyboard protocol. */
export interface HerdrKey {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  super?: boolean;
  hyper?: boolean;
}

/** herdr 0.9.1's prefix-mode defaults (`herdr --default-config`), as the key after the prefix. */
export const HERDR_DEFAULT_PREFIX_BINDINGS: Readonly<Record<string, string>> = {
  help: '?', settings: 's', detach: 'q', reload_config: 'R', open_notification_target: 'o', workspace_picker: 'w',
  goto: 'g', new_workspace: 'N', new_worktree: 'G', rename_workspace: 'W', close_workspace: 'D', new_tab: 'c',
  rename_tab: 'T', previous_tab: 'p', next_tab: 'n', close_tab: 'X', rename_pane: 'P', edit_scrollback: 'e',
  focus_pane_left: 'h', focus_pane_down: 'j', focus_pane_up: 'k', focus_pane_right: 'l', cycle_pane_next: 'tab',
  cycle_pane_previous: 'backtab', split_vertical: 'v', split_horizontal: '-', close_pane: 'x', zoom: 'z',
  resize_mode: 'r', toggle_sidebar: 'b',
};

/** herdr's other `[keys]` actions, unbound by default or bound outside the prefix, and two more names it reads (`herdr
 *  --default-config` and `herdr config check`, 0.9.1 to 0.9.3). `clear_pane` came in 0.9.2. herdr ignores any other key. */
const HERDR_OTHER_ACTIONS = ['open_worktree', 'remove_worktree', 'previous_workspace', 'next_workspace', 'previous_agent', 'next_agent',
  'focus_agent', 'remote_image_paste', 'move_tab_previous', 'move_tab_next', 'switch_tab', 'switch_workspace', 'clear_pane', 'last_pane',
  'resize_pane_left', 'resize_pane_down', 'resize_pane_up', 'resize_pane_right', 'navigate_workspace_up', 'navigate_workspace_down',
  'navigate_pane_left', 'navigate_pane_down', 'navigate_pane_up', 'navigate_pane_right', 'fullscreen', 'copy_mode'];

/** The modifiers and key names herdr reads in a key spec, in any case (`herdr config check`, 0.9.1 to 0.9.3). */
const HERDR_MODIFIERS = new Set(['ctrl', 'control', 'alt', 'option', 'meta', 'shift', 'cmd', 'command', 'super', 'hyper']);
const HERDR_KEY_NAMES = new Set(['up', 'down', 'left', 'right', 'enter', 'return', 'backspace', 'bs', 'esc', 'escape', 'tab', 'space',
  'minus', 'plus', 'comma', 'period', 'slash', 'backslash', 'ampersand', 'backtick', 'semicolon', 'colon', 'quote', 'double_quote',
  'double-quote', 'percent']);

/** Whether herdr reads a key spec at all: `+`-separated parts, none empty once trimmed, modifiers first, then one key, which
 *  is a single character, `f0` to `f255` or one of herdr's key names. herdr drops a prefix it cannot read (`ctrl+foo`, `C-b`);
 *  `parseHerdrKey` says which of the rest a terminal app can follow. */
export function herdrReadsKey(spec: string): boolean {
  const parts = spec.split('+').map((s) => s.trim());
  const key = parts.pop() ?? '';
  if (!key || parts.some((mod) => !HERDR_MODIFIERS.has(mod.toLowerCase()))) return false;
  const fn = /^f(\d+)$/i.exec(key);
  return [...key].length === 1 || HERDR_KEY_NAMES.has(key.toLowerCase()) || (fn !== null && Number(fn[1]) <= 255);
}

/** The keys OAK answers after herdr's prefix, when herdr leaves them unbound: `m` goes to OAK's tabs,
 *  `M` goes there with the focused herdr pane's session pinned in the Observatory, and `V` opens Review on
 *  that session (herdr's own defaults bind `R` and `r`, to reload_config and resize_mode). */
export const OAK_PREFIX_KEYS = ['m', 'M', 'V'] as const;
export type OakPrefixKey = (typeof OAK_PREFIX_KEYS)[number];

/** OAK's tab keys, as the decoder names them: F1 the herdr tab, F2 the Observatory, F3 Review. OAK takes them on every
 *  tab, the herdr tab included, with or without herdr's prefix before them, unless herdr's config binds them. */
export const OAK_TAB_KEYS = ['f1', 'f2', 'f3'] as const;
export type OakTabKey = (typeof OAK_TAB_KEYS)[number];

const PUNCT: Record<string, string> = {
  minus: '-', comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\', ampersand: '&', plus: '+', backtick: '`',
  semicolon: ';', colon: ':', equal: '=', equals: '=', space: ' ', question: '?', pipe: '|', quote: "'", double_quote: '"',
  'double-quote': '"', percent: '%',
};
const NAMED: Record<string, string> = { esc: 'escape', escape: 'escape', enter: 'enter', return: 'enter', tab: 'tab', backspace: 'backspace', bs: 'backspace' };
/** herdr's modifiers by the names its config takes: it reads `meta` and `option` as alt, and `cmd` and `command` as super. */
const MODIFIERS: Record<string, 'ctrl' | 'alt' | 'shift' | 'super' | 'hyper'> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', meta: 'alt', shift: 'shift', cmd: 'super', command: 'super', super: 'super', hyper: 'hyper',
};

/** One herdr key spec (`ctrl+b`, `shift+r`, `minus`, `f12`) as a decoded key, or null for one this reader
 *  does not follow (an arrow, f13 and above). A capital letter is the letter with shift, as herdr reads it:
 *  `ctrl+A` is ctrl+shift+a, `{ key: 'A', ctrl: true }`. Shift on any other key stays part of it, as it does for
 *  herdr: `ctrl+shift+space` is not `ctrl+space`, nor `shift+f5` `f5`. */
export function parseHerdrKey(spec: string): HerdrKey | null {
  if (spec.trim() === '+') return { key: '+' };
  const parts = spec.trim().split('+').map((s) => s.trim()).filter(Boolean);
  // `ctrl++` style: a trailing empty part means the key is `+` itself.
  if (spec.trim().endsWith('++')) parts.push('+');
  if (!parts.length) return null;
  const mods: Omit<HerdrKey, 'key'> = {};
  for (const mod of parts.slice(0, -1).map((m) => m.toLowerCase())) {
    if (!MODIFIERS[mod]) return null;
    mods[MODIFIERS[mod]] = true;
  }
  const raw = parts[parts.length - 1];
  const low = raw.toLowerCase();
  let key: string;
  if (low === 'tab' && mods.shift) { key = 'backtab'; delete mods.shift; }
  else if (NAMED[low]) key = NAMED[low];
  else if (PUNCT[low]) key = PUNCT[low];
  else if (/^f([1-9]|1[0-2])$/.test(low)) key = low;
  else if (/^[a-z]$/i.test(raw)) { key = mods.shift ? raw.toUpperCase() : raw; delete mods.shift; }
  else if ([...raw].length === 1) key = raw;
  else return null;
  return { key, ...mods };
}

/** super, as herdr prints it: `cmd` on macOS. */
const SUPER = process.platform === 'darwin' ? 'cmd' : 'super';

/** herdr's own name for a key (`ctrl+b`, `ctrl+shift+a` for `Ctrl+A`, `ctrl+shift+space`), the way its prefix row and its
 *  keybinds list print it, and so the way the key rows and the help name it: ctrl, alt, shift, super and hyper in that
 *  order, and a letter in lower case. */
export function herdrKeyLabel(k: HerdrKey): string {
  const capital = /^[A-Z]$/.test(k.key);
  const name = k.key === ' ' ? 'space' : k.key === 'escape' ? 'esc' : k.key === 'backtab' ? 'shift+tab' : capital ? k.key.toLowerCase() : k.key;
  return [k.ctrl && 'ctrl', k.alt && 'alt', (k.shift || capital) && 'shift', k.super && SUPER, k.hyper && 'hyper', name].filter(Boolean).join('+');
}

/** herdr's name for a key spec it reads; a key this reader does not follow (an arrow, f13) is named after its modifiers. */
function specLabel(spec: string): string {
  const parsed = parseHerdrKey(spec);
  if (parsed) return herdrKeyLabel(parsed);
  const parts = spec.split('+').map((s) => s.trim().toLowerCase());
  const named: HerdrKey = { key: parts.pop() ?? '' };
  for (const mod of parts) if (MODIFIERS[mod]) named[MODIFIERS[mod]] = true;
  return herdrKeyLabel(named);
}

/** The bytes herdr 0.9.1 to 0.9.3 read as tab, enter, backspace and esc from a terminal without the kitty keyboard protocol:
 *  never 0x08 or LF, which they read as ctrl+h and ctrl+j, and OAK's decoder as backspace and enter. */
const NAMED_BYTES: Record<string, string> = { tab: '\t', enter: '\r', backspace: '\x7f', escape: '\x1b' };

/**
 * The bytes a terminal WITHOUT the kitty keyboard protocol sends for a key, or null when it has no
 * fixed legacy form of its own (F-keys and shift+tab, digits under ctrl, shift on a key that is not a letter,
 * super and hyper, and a capital letter under ctrl, whose shift such a terminal drops: ctrl+shift+a sends 0x01,
 * as ctrl+a does, and ctrl+shift+space NUL, as ctrl+space does). Tab, enter, backspace and esc are the bytes
 * herdr reads as them (`NAMED_BYTES`), and alt on the first three puts ESC in front; herdr never reads a ctrl
 * chord of them from such a terminal, nor ESC ESC as alt+esc. A ctrl chord is the C0
 * control that shares the key's low five bits, where herdr reads that byte as the chord (ctrl+b is 0x02,
 * ctrl+] 0x1d, ctrl+\ 0x1c, ctrl+h 0x08); ctrl+space is NUL. alt puts ESC in front, except
 * before [ ] O P X ^ and _, where ESC opens a control sequence or string to herdr and to OAK alike (herdr 0.9.1
 * and 0.9.3 never read ESC P as alt+shift+p, and do read ESC Y as alt+shift+y). The legacy decoder names
 * several of these as other keys (NUL as ctrl+`, 0x08 as backspace), so the prefix is matched on these bytes.
 */
export function legacyKeyBytes(k: HerdrKey): string | null {
  if (k.shift || k.super || k.hyper) return null;
  if (Object.hasOwn(NAMED_BYTES, k.key)) return k.ctrl || (k.alt && k.key === 'escape') ? null : (k.alt ? '\x1b' : '') + NAMED_BYTES[k.key];
  if ([...k.key].length !== 1 || (k.alt && !k.ctrl && /^[[\]OPX^_]$/.test(k.key))) return null;
  let base = k.key;
  if (k.ctrl) {
    // The byte herdr reads as this chord (0.9.1 to 0.9.3): not 0x09, 0x0d, ESC or DEL, which it reads as tab, enter, esc and
    // backspace (ctrl+i, ctrl+m, ctrl+[, ctrl+?), nor NUL or 0x1f for ctrl+@ and ctrl+/, which it reads as ctrl+space and ctrl+_.
    const c = k.key === ' ' ? 0 : /^[a-hj-ln-z\\\]^_]$/.test(k.key) ? k.key.charCodeAt(0) & 0x1f : -1;
    if (c < 0) return null;
    base = String.fromCharCode(c);
    // OAK's input framer splits ESC from a following control byte other than \b \t \n \r (ESC, then ctrl+a): such a chord
    // never arrives as one key.
    if (k.alt && c !== 0x08 && c !== 0x0a) return null;
  }
  return (k.alt ? '\x1b' : '') + base;
}

export interface HerdrPrefix {
  /** The first of `prefixes` that this reader follows from any terminal, or null when herdr's config names none: the key
   *  row then names no key back to OAK's tabs. */
  prefix: HerdrKey | null;
  /** Every prefix this reader can follow. herdr 0.9.2 and later take a list (`prefix = ["ctrl+space", "ctrl+s"]`),
   *  and each of them enters its prefix mode. A prefix with no bytes of its own without the kitty keyboard protocol
   *  (`legacyKeyBytes`: ctrl on a capital letter, shift on another key, super, ctrl on tab, alt on esc) is followed only
   *  from a terminal that reports keys with that protocol, unless it is an F-key or shift+tab, matched on its escape
   *  sequence. */
  prefixes: HerdrKey[];
  /** The prefixes this reader follows from any terminal, for the hints ("ctrl+b", "ctrl+space or ctrl+s"), or every
   *  prefix herdr's config names when there is none; each named as herdr names it (`ctrl+shift+a` for `Ctrl+A`). */
  label: string;
  /** How herdr's detach is pressed (`ctrl+b q`), or null when herdr's config leaves it unbound, or binds it only in ways
   *  herdr disables. */
  detach: string | null;
  /** The OAK prefix keys herdr leaves unbound — the only letters OAK takes after the prefix. */
  oak: OakPrefixKey[];
  /** Why a key OAK would take after the prefix is herdr's there, for the help and the refusal: its letters, and its
   *  tab keys, which herdr's config can bind after the prefix too. */
  taken: Partial<Record<OakPrefixKey | OakTabKey, string>>;
  /** OAK's tab keys that herdr's config binds on their own, and to what (its prefix among them): on the herdr tab
   *  herdr keeps them. */
  tabTaken: Partial<Record<OakTabKey, string>>;
}

/** Read herdr's prefix and its prefix bindings from config.toml text (defaults where the text is silent), as the herdr
 *  client of `version` reads it (the herdr client applies the prefix), or the newest herdr when it is not known.
 *  The file is read as TOML, as herdr reads it: tables, dotted keys (`keys.prefix = …`), inline tables
 *  (`keys = { prefix = … }`), arrays written over several lines and `"""` strings all count. A file herdr cannot
 *  parse leaves herdr on its defaults ("config parse error, using defaults"), and so does a binding in `[keys]` of
 *  the wrong type; OAK then reads the defaults too. A type error anywhere else (outside `[keys]`, in a custom
 *  command's other fields or in the older `[keys.indexed]`) also leaves herdr on its defaults, but OAK does not
 *  check herdr's whole schema and reads `[keys]` as written. */
export function herdrPrefixFrom(toml: string, version?: string): HerdrPrefix {
  let keys: Record<string, unknown> = {};
  try {
    const table = parseToml(toml).keys;
    if (table && typeof table === 'object' && !Array.isArray(table)) keys = table as Record<string, unknown>;
  } catch { /* herdr's defaults */ }
  // A binding is a key spec or a list of them (herdr's BindingConfig); a list of prefixes came in 0.9.2, as did
  // clear_pane. One of herdr's actions, the prefix or a custom command's key written as anything else is a parse error,
  // as is a `command` that is not a list of tables: herdr then runs on its defaults. A key it does not know it ignores.
  const before092 = version !== undefined && compareVersions(version, '0.9.2') < 0;
  const actions = new Set([...Object.keys(HERDR_DEFAULT_PREFIX_BINDINGS), ...HERDR_OTHER_ACTIONS.filter((a) => !before092 || a !== 'clear_pane')]);
  const binding = (v: unknown): boolean => typeof v === 'string' || (Array.isArray(v) && v.every((s) => typeof s === 'string'));
  const isTable = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const typed = Object.entries(keys).every(([k, v]) =>
    k === 'prefix' ? (before092 ? typeof v === 'string' : binding(v))
      : k === 'command' ? Array.isArray(v) && v.every((c) => isTable(c) && (c.key === undefined || binding(c.key)))
      // remote_image_paste is one raw key, never a list ("invalid type: sequence, expected a string", 0.9.1 to 0.9.3).
      : k === 'remote_image_paste' ? typeof v === 'string'
      : !actions.has(k) || binding(v));
  if (!typed) keys = {};
  const specs = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  // herdr reads `prefix+` in lower case only: `PREFIX+m` is an invalid keybinding, which it disables (0.9.1 to 0.9.3).
  const afterPrefix = (spec: string): string | null => {
    const m = /^prefix\+(.+)$/.exec(spec.trim());
    if (!m) return null;
    // `prefix+1..9` and friends name a range of digits; none of them is a key OAK claims, and neither is a super chord.
    if (/\d\.\.\d/.test(m[1])) return null;
    const k = parseHerdrKey(m[1]);
    return k && !k.super && !k.hyper ? k.key : null;
  };
  const bound = new Map<string, string>(); // key after the prefix -> herdr action
  for (const [action, key] of Object.entries(HERDR_DEFAULT_PREFIX_BINDINGS)) if (!Object.hasOwn(keys, action)) bound.set(key, action);
  for (const [action, value] of Object.entries(keys)) {
    if (action === 'prefix' || action === 'command') continue;
    for (const spec of specs(value)) {
      const k = afterPrefix(spec);
      if (k) bound.set(k, action);
    }
  }
  // Custom commands: `[[keys.command]]` tables, written inline or not.
  const commands = Array.isArray(keys.command) ? keys.command : [];
  for (const command of commands) for (const spec of specs((command as { key?: unknown } | null)?.key)) {
    const k = afterPrefix(spec);
    if (k) bound.set(k, 'a custom command');
  }
  const taken: Partial<Record<OakPrefixKey | OakTabKey, string>> = {};
  for (const k of OAK_PREFIX_KEYS) if (bound.has(k)) taken[k] = bound.get(k)!;
  // herdr drops a prefix it cannot read, an empty one included, and with none left falls back to ctrl+b.
  const listed = specs(keys.prefix ?? 'ctrl+b').filter(herdrReadsKey);
  const written = listed.length ? listed : ['ctrl+b'];
  const prefixes = written.map(parseHerdrKey).filter((k): k is HerdrKey => k !== null);
  // A tab key herdr's config binds, as its prefix or to an action or custom command, herdr keeps on its tab: on its own
  // (`tabTaken`), or after the prefix (`taken`). With a modifier it is another key (shift+f2), which OAK never takes.
  const tabTaken: Partial<Record<OakTabKey, string>> = {};
  const bindsTab = (spec: string, why: string): void => {
    const after = /^prefix\+(.+)$/.exec(spec.trim())?.[1];
    const k = parseHerdrKey(after ?? spec);
    const tab = k && !k.ctrl && !k.alt && !k.shift && !k.super && !k.hyper ? OAK_TAB_KEYS.find((t) => t === k.key) : undefined;
    const into = after === undefined ? tabTaken : taken;
    if (tab && !into[tab]) into[tab] = why;
  };
  for (const spec of written) bindsTab(spec, 'its prefix');
  for (const [action, value] of Object.entries(keys)) if (action !== 'prefix' && action !== 'command') for (const spec of specs(value)) bindsTab(spec, action);
  for (const command of commands) for (const spec of specs((command as { key?: unknown } | null)?.key)) bindsTab(spec, 'a custom command');
  // The ones a terminal without the kitty keyboard protocol sends bytes of its own for (`legacyKeyBytes`), or an F-key or
  // shift+tab, matched on the escape sequence such a terminal sends for it (f5, ctrl+f5, shift+f5, shift+tab). herdr and OAK
  // see the others (ctrl+shift+a, ctrl+shift+space, ctrl+minus, ctrl+tab, alt+esc, alt+shift+tab, super+b) only from a
  // terminal that reports keys with the protocol: the key row names such a prefix as it names one this reader cannot follow
  // at all.
  const everywhere = prefixes.filter((k) => !k.super && !k.hyper
    && (legacyKeyBytes(k) !== null || /^f\d+$/.test(k.key) || (k.key === 'backtab' && !k.ctrl && !k.alt)));
  const label = (everywhere.length ? everywhere.map(herdrKeyLabel) : written.map(specLabel)).join(' or ');
  // herdr's detach, as the help names it: the first of its bindings herdr takes, after the (first) prefix or a key of its own.
  // herdr disables one it cannot read (`prefix+question`), a prefix after the prefix ("reserved keybinding") and a printable
  // key without the prefix ("unsafe direct keybinding"), 0.9.1 to 0.9.3; with none left, detach is unbound.
  const takes = (spec: string): boolean => {
    const after = /^prefix\+(.+)$/.exec(spec.trim())?.[1];
    if (!herdrReadsKey(after ?? spec)) return false;
    if (after !== undefined) return !written.some((w) => specLabel(w) === specLabel(after));
    const k = parseHerdrKey(spec);
    return !k || [...k.key].length > 1 || !!(k.ctrl || k.alt || k.super || k.hyper);
  };
  const detachSpec = Object.hasOwn(keys, 'detach') ? specs(keys.detach).find(takes) : 'prefix+q';
  let detach: string | null = null;
  if (detachSpec !== undefined) {
    const after = /^prefix\+(.+)$/.exec(detachSpec.trim())?.[1], first = everywhere[0] ?? prefixes[0];
    detach = after !== undefined ? `${first ? herdrKeyLabel(first) : label} ${specLabel(after)}` : specLabel(detachSpec);
  }
  return { prefix: everywhere[0] ?? null, prefixes, label, detach, oak: OAK_PREFIX_KEYS.filter((k) => !taken[k]), taken, tabTaken };
}

let cached: { file: string; mtimeMs: number; version?: string; value: HerdrPrefix } | null = null;

/** herdr's config file: `$HERDR_CONFIG_PATH`, else herdr's own config dir. */
export function herdrConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_CONFIG_PATH?.trim() || path.join(herdrConfigDir(os.homedir(), env), 'config.toml');
}

/** The reader's herdr prefix as the herdr client of `version` reads it, re-read only when the file changes (one stat
 *  per call). */
export function herdrPrefix(env: NodeJS.ProcessEnv = process.env, version?: string): HerdrPrefix {
  const file = herdrConfigFile(env);
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* no config: herdr's defaults */ }
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs && cached.version === version) return cached.value;
  let text = '';
  if (mtimeMs >= 0) { try { text = fs.readFileSync(file, 'utf8'); } catch { /* unreadable: defaults */ } }
  const value = herdrPrefixFrom(text, version);
  cached = { file, mtimeMs, version, value };
  return value;
}
