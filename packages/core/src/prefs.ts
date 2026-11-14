/**
 * The reader's own settings, on disk.
 *
 * One file, `<claude config dir>/claude-observatory/prefs.json`, holding only what a reader has
 * ACTUALLY changed. An absent key means "follow the environment", which is why nothing here writes
 * defaults out: a prefs file full of the values the product would have picked anyway is a file that
 * silently freezes today's defaults into every future version, and the reader never asked for that.
 *
 * Every value is validated on read. This file can be hand-edited, can be older than the build reading
 * it, and can be newer — so an unknown colour name or a rebind to a key that no longer exists must
 * degrade to the default rather than break the dashboard on its first paint. `read()` never throws.
 * A save keeps what this build cannot read, for the build that can (`writePrefs`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeConfigDir, claudeJsonPath } from './paths';

export type ColorPref = 'auto' | 'truecolor' | '256' | '16' | 'none';
export type GlyphPref = 'auto' | 'ascii' | 'safe' | 'block';

/**
 * Every rebindable verb.
 *
 * Structural keys are deliberately absent: F1–F6, the arrows, Tab, Enter, Escape, Space and the
 * digits are the frame's navigation, several are the only way out of a mode, and a reader who
 * rebinds their way into a dashboard they cannot leave has been handed a footgun by a settings
 * screen. The options window says as much rather than offering a field that quietly refuses.
 */
export const REBINDABLE = [
  { action: 'keep', label: 'Keep the selection', fallback: 'a' },
  { action: 'undo', label: 'Undo the selection', fallback: 'u' },
  { action: 'keepAll', label: 'Keep everything listed', fallback: 'A' },
  // `D` (discard everything listed), because `U` is redo: undo and redo share the letter, as they do
  // in Helix and Kakoune. Undo-all was `U` until 0.11.0.
  { action: 'undoAll', label: 'Undo everything listed', fallback: 'D' },
  // Redo was `^R`, which both agents use for history search; a plain letter beside `u` is also
  // rebindable, where a ctrl chord was not.
  { action: 'redo', label: 'Redo the selection', fallback: 'U' },
  { action: 'next', label: 'Next edit', fallback: 'n' },
  { action: 'prev', label: 'Previous edit', fallback: 'p' },
  { action: 'editor', label: 'Open in the terminal editor', fallback: 'e' },
  { action: 'copy', label: 'Copy the path, or the diff', fallback: 'y' },
  { action: 'wrap', label: 'Wrap long diff lines, or scroll them', fallback: 'w' },
  // `s` for sort and `b` for the session picker, which is a SWAP: sort was `S` beside session's `s`.
  // Same objection as `o`-not-`M` below, and worse here, because `a`/`A` and `u`/`U` teach the reader a
  // rule — lowercase acts on the selection, uppercase on everything listed — that `s`/`S` then broke,
  // since sorting a list and leaving it are not the same verb in two scopes. Sort is the one a reader
  // reaches for while reading, so it takes the home-row letter; the picker becomes `b`, for browse.
  { action: 'sort', label: 'Sort the list', fallback: 's' },
  { action: 'fold', label: 'Fold or unfold every file in the list', fallback: 'F' },
  // `x` for mark, not `space`: space already folds a change-map folder, and one key doing two things
  // depending on which pane has focus is the ambiguity this keymap keeps removing elsewhere.
  { action: 'mark', label: 'Mark the row for a bulk keep or undo', fallback: 'x' },
  { action: 'filter', label: 'Filter', fallback: '/' },
  // The filter PICKER — regex on/off, and the file-type / extension buckets — beside `/`, its query
  // box, the way the editors put the funnel button beside their search field. `/` types a query;
  // `\` opens what that query means and what file kinds it runs over.
  { action: 'filter-menu', label: 'Filter options (regex, file type, extension)', fallback: '\\' },
  { action: 'refresh', label: 'Refresh', fallback: 'r' },
  { action: 'session', label: 'Browse sessions', fallback: 'b' },
  // `o`, not `M`: `m` already minimizes the focused window, and one letter running two different
  // verbs by case alone is a keymap the reader has to squint at — the key row showed `m min` and
  // `M options` side by side and they read as the same key twice.
  { action: 'options', label: 'Options', fallback: 'o' },
  // The raised-hand pair: `i` opens the inbox of every session waiting
  // on the reader; `h` jumps straight to the next hand — permission before question before input,
  // oldest first. `h` is free (this keymap never took vim's h/l; the arrows are prev/next tab) and a
  // hand is what it goes to.
  { action: 'inbox', label: 'Needs you — every raised hand', fallback: 'i' },
  { action: 'nextHand', label: 'Jump to the next session waiting on you', fallback: 'h' },
  { action: 'minimize', label: 'Minimize the focused window', fallback: 'm' },
  { action: 'zoom', label: 'Zoom the focused window', fallback: 'z' },
  { action: 'reset', label: 'Reset the layout', fallback: '=' },
  { action: 'help', label: 'Keys', fallback: '?' },
] as const;

export type Action = (typeof REBINDABLE)[number]['action'];

/**
 * Keys no verb may be rebound to, because the frame answers them before the keymap is read.
 *
 * Space and the digits are structural (fold, and an edit's id); `:` opens the command palette; `'` and
 * `` ` `` set and jump to marks. The letters and `|` `-` are the Observatory tab's own keys, and a
 * Review verb on one of them would give that letter two meanings across the two tabs (`R` resolves a
 * session there and `X` stops its agent, so neither may mean anything on Review). The options window
 * refuses them, and a prefs file that names one (hand-edited, or saved by an older build) keeps it out of
 * the live keymap: `blockedKeys` carries it until the reader chooses another key.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  ' ', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', "'", '`',
  'c', 'd', 'f', 't', 'v', 'B', 'H', 'J', 'K', 'L', 'R', 'W', 'X', '|', '-',
]);

/** What a session can be waiting on (attention.json's kinds plus the transcript-derived `question`).
 *  Lives here, beside the preference that filters them, so prefs never imports the notifier. */
export const HAND_KINDS = ['permission', 'question', 'input', 'idle-done'] as const;
export type HandKind = (typeof HAND_KINDS)[number];

export interface Prefs {
  /** The terminal editor: what `e` runs. Overrides `$VISUAL`/`$EDITOR`. Empty means "use the environment". */
  editor?: string;
  /** The GUI editor: what W opens a window or a file in. Empty means Auto (resolveGuiEditor). */
  guiEditor?: string;
  /** Day-of-month the subscription bills on (1-31; Anthropic bills on the signup anniversary and
   *  no payload carries the date, so the user states it once). Absent: calendar months (the 1st).
   *  Days past a month's end clamp to its last day, the way card billing does. */
  billDay?: number;
  /** Day-of-month the GPT/codex subscription bills on (1-31), separate from `billDay` because the two
   *  accounts renew on different days and no codex payload carries the date. Absent: calendar months. */
  gptBillDay?: number;
  accountBilling?: import('./account-billing').AccountBilling;
  color?: ColorPref;
  glyphs?: GlyphPref;
  mouse?: boolean;
  /** Seconds between polls. Floored on read — a zero would spin the CPU on a background window. */
  refreshSeconds?: number;
  /** Which window has focus when the dashboard opens. */
  startFocus?: StartFocus;
  /** How the change map and Traces list are ordered. Absent means `time` (most recently edited first). */
  sort?: SortKey;
  /** Syntax colour on a diff's CONTEXT lines. Off by default and the only setting that is: it is the
   *  one feature whose cost lands on a frame that re-renders per keystroke, so it is opt-in and
   *  measured rather than assumed free. */
  syntax?: boolean;
  /** Named colour palette. Absent means `default` — the palette this product has always used, so a
   *  reader who never opens the setting sees no change. Validated on read against the build's own
   *  list, because a theme name from a newer version must degrade to the default, not to a blank UI. */
  theme?: string;
  /**
   * The TUI's per-tab workspace, so a layout survives a restart.
   *
   * Keyed by tab ID rather than by position: a build that adds or reorders tabs must not hand one
   * tab's dragged widths to another. An id this build does not have is simply ignored.
   *
   * `version` gates the whole record — a shape change IGNORES older entries rather than migrating
   * them, because a half-understood layout is what puts a reader in front of a blank frame. Every
   * field is re-validated on read for the same reason; this file is hand-editable.
   */
  layout?: {
    version: number;
    /** The tab that was up, by id. Unknown ids fall back to the first tab. */
    active?: string;
    tabs?: Record<
      string,
      {
        minimized?: string[];
        zoom?: string | null;
        focus?: string;
        sizes?: Record<string, number>;
        /** A TREE tab's persisted arrangement. `root` is stored opaque and VALIDATED on read by the
         *  TUI (`parseTree`) — a bad tree falls back to the default, never a blank frame. */
        root?: unknown;
        treeFocus?: string;
        treeZoom?: string | null;
      }
    >;
  };
  /** Why a just-entered value was refused, for the settings screen to show. Never persisted:
   *  `writePrefs` stores only real settings, and this is a message about one that did not become one. */
  __reject?: string;
  /** action -> the single key that runs it. Only actions in `REBINDABLE` are honoured. */
  keys?: Partial<Record<Action, string>>;
  /** Rebinds the file holds onto a key now in `RESERVED_KEYS` (an older build allowed them). Never
   *  live, so the action keeps its default key, but written back as they were read: the file keeps
   *  the reader's choice until they pick another key in the options window, which names the problem. */
  blockedKeys?: Partial<Record<Action, string>>;
  /** Desktop notifications for raised hands (2026-09-15). Absent means ON for permission / question /
   *  input, OFF for a finished turn, no sound, a 30-second per-session cooldown. Every field is
   *  optional so the stored file carries only what the reader changed. */
  notify?: {
    desktop?: boolean;
    sound?: boolean;
    kinds?: HandKind[];
    cooldownSeconds?: number;
  };
  /** Where the observatory keeps its store — the log, the blobs and the derived caches. Absolute, or
   *  `~`-prefixed. Absent means the default beside your Claude config. Changing it MOVES what is
   *  already there; a setting that silently stranded a session's history would be worse than none. */
  storeDir?: string;
  /** Read Remote Control session titles from claude.ai so sessions carry the names the Claude app and
   *  claude.ai show (an automatic network read; see SECURITY.md). Absent means ON; `false` turns it off. */
  remoteTitles?: boolean;
  /** Read the Claude account's usage from saved machines over ssh in the background (machine-usage.ts; see
   *  SECURITY.md). Absent means ON; `false` turns it off, and the readouts show this machine's readings only. */
  machineUsage?: boolean;
  /** oak sync on this machine (sync-engine.ts), each field set by `oak sync …` or by hand. */
  sync?: SyncPrefs;
  /** What `oak agent start --brief` starts each CLI with, unless a flag says otherwise (delegated.ts); set by hand. */
  agents?: { claude?: AgentStartPrefs; codex?: AgentStartPrefs };
}

/** One CLI's defaults for `oak agent start`: Claude Code's agent type and permission mode, Codex's sandbox, the model
 *  and effort, and further arguments to pass on. */
export interface AgentStartPrefs {
  agentType?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  args?: string[];
  writableRoots?: string[];
}

/** prefs.json `agents`, each field checked on its own. */
function parseAgentPrefs(v: unknown): Prefs['agents'] | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: NonNullable<Prefs['agents']> = {};
  for (const kind of ['claude', 'codex'] as const) {
    const d = (v as Record<string, unknown>)[kind];
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const o: AgentStartPrefs = {};
    for (const k of ['agentType', 'permissionMode', 'model', 'effort', 'sandbox'] as const) {
      const x = (d as Record<string, unknown>)[k];
      if (typeof x === 'string' && x.trim()) o[k] = x.trim();
    }
    const args = (d as Record<string, unknown>).args;
    if (Array.isArray(args) && args.every((x) => typeof x === 'string')) o.args = args as string[];
    const roots = (d as Record<string, unknown>).writableRoots;
    if (Array.isArray(roots) && roots.every((x) => typeof x === 'string')) o.writableRoots = roots as string[];
    if (Object.keys(o).length) out[kind] = o;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Where a sync family's files are kept (sync.ts SyncPlacement). */
export type SyncPlacementPref = 'everywhere' | 'backup' | 'on-demand' | 'off';

export interface SyncPrefs {
  /** The backup target: a saved machine by its label here, or a folder by its path on this machine. */
  backup?: { kind: 'machine'; label: string } | { kind: 'folder'; path: string };
  /** Placement overrides by family id (`transcripts`, `memory`, …). */
  families?: Record<string, SyncPlacementPref>;
  /** Machines (labels) and projects (identity keys) this machine does not pull from or for. */
  exclude?: { machines?: string[]; projects?: string[] };
  /** The size of the on-demand cache, in megabytes. */
  cacheMB?: number;
  /** `false` stops the background run the capture hooks and the pollers kick. */
  auto?: boolean;
  /** When `oak sync setup` last ran here (epoch ms), whatever was chosen: `oak doctor` stops suggesting it. */
  setupAt?: number;
}

/** prefs.json `sync`, each field checked on its own: one bad field is dropped, never the rest. */
function parseSyncPrefs(v: unknown): SyncPrefs | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const d = v as Record<string, unknown>;
  const out: SyncPrefs = {};
  const b = d.backup as Record<string, unknown> | undefined;
  if (b && b.kind === 'machine' && typeof b.label === 'string' && b.label.trim()) out.backup = { kind: 'machine', label: b.label.trim() };
  else if (b && b.kind === 'folder' && typeof b.path === 'string' && b.path.trim()) out.backup = { kind: 'folder', path: b.path.trim() };
  if (d.families && typeof d.families === 'object' && !Array.isArray(d.families)) {
    const f: Record<string, SyncPlacementPref> = {};
    for (const [k, p] of Object.entries(d.families as Record<string, unknown>)) {
      if (/^[a-z][a-z0-9-]*$/.test(k) && (['everywhere', 'backup', 'on-demand', 'off'] as unknown[]).includes(p)) f[k] = p as SyncPlacementPref;
    }
    if (Object.keys(f).length) out.families = f;
  }
  const strings = (x: unknown): string[] => (Array.isArray(x) ? [...new Set(x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))] : []);
  const ex = d.exclude as Record<string, unknown> | undefined;
  if (ex && typeof ex === 'object') {
    const machines = strings(ex.machines), projects = strings(ex.projects);
    if (machines.length || projects.length) out.exclude = { ...(machines.length ? { machines } : {}), ...(projects.length ? { projects } : {}) };
  }
  if (typeof d.cacheMB === 'number' && Number.isFinite(d.cacheMB) && d.cacheMB >= 0) out.cacheMB = Math.floor(d.cacheMB);
  if (typeof d.auto === 'boolean') out.auto = d.auto;
  if (typeof d.setupAt === 'number' && Number.isFinite(d.setupAt) && d.setupAt > 0) out.setupAt = d.setupAt;
  return Object.keys(out).length ? out : undefined;
}

export function prefsPath(dir = claudeConfigDir()): string {
  return path.join(dir, 'claude-observatory', 'prefs.json');
}

/** The key every prefs.json this build writes carries. An OAK older than 0.11.0 writes back only the settings it knows,
 *  so a prefs.json without it is one such an OAK rewrote: oak sync's settings and `machineUsage`, which that OAK drops,
 *  are then read from oak sync's copy of them (sync-state.ts keptPrefs). */
export const PREFS_FORMAT_KEY = 'prefsFormat';
export const PREFS_FORMAT = 2;

/** Absolute, or the home (`~`, `~/…`). See `Prefs.storeDir` for why a relative path is refused: `~name/…` is one too,
 *  since only the home is expanded, so it was kept in each process's working folder, an agent's project among them. */
export function isAbsoluteStorePath(p: string): boolean {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') || path.isAbsolute(p);
}

/** Expand a leading `~` to the home directory. Everything downstream wants a real path. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Validate a store location the reader typed, or say why it cannot be one. */
export function parseStorePath(line: string): { dir: string } | { error: string } {
  const v = line.trim();
  if (!v) return { error: 'nothing to set — give an absolute path, or ~/somewhere' };
  if (!isAbsoluteStorePath(v)) {
    return { error: `“${v}” is relative — the capture hook, the CLI and both editors start in different directories, so a relative store would scatter one session across several` };
  }
  return { dir: v };
}

/** An editor the options window can offer, and the EXACT command that runs it. */
export interface EditorChoice {
  command: string;
  label: string;
}

/**
 * The editors worth offering, each declaring the ONE fact a launcher must know: whether it takes the
 * terminal over.
 *
 * `tty` editors (vim, helix, nano…) run IN the terminal — the TUI suspends, hands the screen over,
 * and waits for them to exit. `gui` editors open their own window and return: the launcher spawns
 * them detached and never blinks. This kind used to be encoded as a `-w` wait flag on the GUI
 * commands so the suspend-and-wait flow had something to wait for; with the detached flow there is
 * nothing to wait for, and the flag's only effect was an idle helper process per open — so the
 * commands are bare again, and because the options row shows the command in full, what you read is
 * exactly what runs.
 *
 * Nothing is offered unless its binary is present on this machine.
 */
/** The JetBrains IDE launchers. Each opens a file at a line with `--line N <file>` (IntelliJ's CommandLineProcessor), and
 *  a saved machine's project through JetBrains Gateway. */
const JETBRAINS_BINS = ['idea', 'idea64', 'pycharm', 'webstorm', 'goland', 'clion', 'rider', 'phpstorm', 'rubymine', 'rustrover', 'datagrip'];
const KNOWN_EDITORS: readonly { bin: string; command: string; label: string; kind: 'gui' | 'tty' }[] = [
  { bin: 'nvim', command: 'nvim', label: 'Neovim', kind: 'tty' },
  { bin: 'vim', command: 'vim', label: 'Vim', kind: 'tty' },
  { bin: 'hx', command: 'hx', label: 'Helix', kind: 'tty' },
  { bin: 'helix', command: 'helix', label: 'Helix', kind: 'tty' },
  { bin: 'kak', command: 'kak', label: 'Kakoune', kind: 'tty' },
  { bin: 'micro', command: 'micro', label: 'micro', kind: 'tty' },
  { bin: 'nano', command: 'nano', label: 'nano', kind: 'tty' },
  { bin: 'emacs', command: 'emacs -nw', label: 'Emacs, in this terminal', kind: 'tty' },
  { bin: 'vi', command: 'vi', label: 'vi', kind: 'tty' },
  { bin: 'code', command: 'code', label: 'VS Code', kind: 'gui' },
  { bin: 'code-insiders', command: 'code-insiders', label: 'VS Code Insiders', kind: 'gui' },
  { bin: 'cursor', command: 'cursor', label: 'Cursor', kind: 'gui' },
  { bin: 'windsurf', command: 'windsurf', label: 'Windsurf', kind: 'gui' },
  ...JETBRAINS_BINS.map(bin => ({ bin, command: bin, label: bin, kind: 'gui' as const })),
  { bin: 'zed', command: 'zed', label: 'Zed', kind: 'gui' },
  { bin: 'subl', command: 'subl', label: 'Sublime Text', kind: 'gui' },
  { bin: 'mate', command: 'mate', label: 'TextMate', kind: 'gui' },
];

/**
 * Whether a configured editor command is a GUI program (fork-and-return) or a terminal one
 * (takes the screen over). Keyed on the BINARY — the first word, path and Windows extension
 * stripped — so a legacy persisted `code -w`, a `$VISUAL` of `/usr/local/bin/zed`, and a Windows
 * `code.cmd` all resolve to the editor they name.
 *
 * Unknown commands are `tty`: suspend-and-wait is CORRECT for a terminal editor and merely flashes
 * for a GUI one, while guessing `gui` for a terminal editor would spawn vim detached from the
 * screen it needs — a hang with no error.
 */
export function editorKind(command: string): 'gui' | 'tty' {
  const base = editorBin(command);
  return KNOWN_EDITORS.find((e) => e.bin === base)?.kind ?? 'tty';
}

/** The editor a command names: its first word, path and Windows extension stripped. */
export function editorBin(command: string): string {
  const first = (command.trim().split(/\s+/)[0] ?? '').replace(/\\/g, '/');
  return first
    .slice(first.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, '');
}

/** Where a non-interactive ssh finds the remote's `oak`, and the programs a remote command runs. Such a
 *  shell sources no profile, so its PATH is the system's alone: `oak machine add` installs to
 *  ~/.local/bin, and npm or Homebrew globals land in /opt/homebrew/bin (Apple silicon) or /usr/local/bin. ~/bin
 *  follows ~/.local/bin, as a Debian or Ubuntu login profile orders them: an editor command kept there (an AppImage
 *  Cursor's) was found by a login shell and not by an `oak update` over ssh (2026-11-09). */
export const MACHINE_PATH = '$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH';

/** The environment for an ssh to a saved machine: an ssh_config SendEnv wildcard must not export this
 *  machine's store or agent identity, and no ssh asks anything in a dialog. With no terminal to ask on
 *  (on macOS and Linux, the ssh of `--machine` and `oak update` runs apart from the terminal), ssh asks
 *  through the desktop's askpass program wherever a display is set, and so does the ssh of a jump host,
 *  which inherits this environment but none of OAK's options: a dialog on every background read. `never`
 *  (OpenSSH 8.4 and newer) refuses the question instead, and a question on a terminal is still asked there. */
export function machineSshEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (key.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEX_THREAD_ID',
      'CLAUDE_OBSERVATORY_SESSION', 'CLAUDE_CHANGES_SESSION', 'HERDR_SOCKET_PATH', 'XDG_CONFIG_HOME'].includes(key)) delete out[key];
  }
  out.SSH_ASKPASS_REQUIRE = 'never';
  return out;
}

/**
 * `-o ControlMaster=no` when the person's ssh config would make an ssh to a target the master of a shared
 * connection that is not kept in the background (ControlMaster on, ControlPersist off), read from what
 * `ssh -G <target>` printed: the configuration ssh would use, without connecting. OAK stops such an ssh
 * when its caller gives up (the terminal app's deadlines, an editor's, ctrl+c), and every session sharing
 * a master ends with it. With ControlPersist the master runs in the background, so stopping the ssh is
 * safe, and it keeps sharing. When `ssh -G` printed none (it failed, or ran past its 5 s: it runs the
 * config's `Match exec` commands), the option is added anyway: `ControlMaster=no` still uses a master that
 * is already open, and otherwise connects directly. Both OAK's own ssh (the CLI) and herdr's for a saved
 * machine (herdr.ts) are decided here.
 */
export function sshMuxOptions(printed: { status: number | null; stdout?: string | null }): string[] {
  const said = (key: string): string | undefined => new RegExp(`^${key} (\\S+)`, 'm').exec(printed.status === 0 ? String(printed.stdout ?? '') : '')?.[1].toLowerCase();
  const master = said('controlmaster');
  return printed.status !== 0 || (master && master !== 'false' && master !== 'no' && (said('controlpersist') ?? 'no') === 'no') ? ['-o', 'ControlMaster=no'] : [];
}

/** Whether a command names a JetBrains IDE launcher. */
export function isJetBrainsEditor(command: string): boolean {
  return JETBRAINS_BINS.includes(editorBin(command));
}

/** VS Code and its forks, which open a file at a line with `--goto <file>:<line>` (VS Code's CLI: `goto`, "file:line[:character]"). */
const GOTO_EDITORS = new Set(['code', 'code-insiders', 'cursor', 'windsurf']);

/** The arguments that open `file` at `line` in a GUI editor here, after the editor's own words: `--goto file:line` for VS
 *  Code and its forks, `--line N file` for a JetBrains IDE, and the file alone for the rest and when there is no line. */
export function guiEditorFileArgs(editor: string, file: string, line?: number): string[] {
  if (!line || line < 1) return [file];
  if (GOTO_EDITORS.has(editorBin(editor))) return ['--goto', `${file}:${line}`];
  if (isJetBrainsEditor(editor)) return ['--line', String(line), file];
  return [file];
}

/** The refusal when W has no GUI editor to run: none resolved, or a terminal editor in the GUI editor setting. */
export const GUI_EDITOR_REFUSAL = 'W needs a GUI editor — set GUI editor under o (prefs.guiEditor) to code, cursor, a JetBrains IDE or another GUI editor';

/** Where resolveGuiEditor found the editor, as the status row and the options window say it. */
export type GuiEditorSource = 'setting' | 'editor' | 'VISUAL' | 'EDITOR' | 'terminal' | 'path';
export const GUI_EDITOR_SOURCE: Readonly<Record<GuiEditorSource, string>> = {
  setting: 'the GUI editor setting',
  editor: 'the terminal editor setting',
  VISUAL: '$VISUAL',
  EDITOR: '$EDITOR',
  terminal: "this terminal's editor",
  path: 'the first GUI editor on PATH',
};

/**
 * The GUI editor whose integrated terminal this process runs in, or '' when it is not one (or cannot be told). VS Code
 * sets TERM_PROGRAM=vscode in every integrated terminal (its workbench hard-codes it, and its forks inherit it). Which
 * fork: Cursor sets CURSOR_TRACE_ID and Windsurf WINDSURF_TRACE_ID, and VS Code's git extension puts
 * VSCODE_GIT_ASKPASS_MAIN, a path inside the running app, into the terminal, so a fork's path names it. Claude Code
 * and syncable-cli tell them apart by the same variables. Any other TERM_PROGRAM (a multiplexer started inside, iTerm)
 * is not an editor's terminal, whatever leaked into its environment.
 */
export function integratedTerminalEditor(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TERM_PROGRAM !== 'vscode') return '';
  const askpass = (env.VSCODE_GIT_ASKPASS_MAIN ?? '').toLowerCase();
  if (env.CURSOR_TRACE_ID || askpass.includes('cursor')) return 'cursor';
  if (env.WINDSURF_TRACE_ID || askpass.includes('windsurf')) return 'windsurf';
  return 'code';
}

/**
 * What W opens in, first match wins: the GUI editor setting (a terminal editor there is refused, not skipped); then
 * prefs.editor, $VISUAL and $EDITOR, the first that is a GUI editor; then the GUI editor whose integrated terminal
 * this is, when its command is on PATH; then the first GUI editor on PATH, in KNOWN_EDITORS order (`detected` is
 * detectEditors()). Null when none: the caller refuses with GUI_EDITOR_REFUSAL.
 */
export function resolveGuiEditor(
  p: Pick<Prefs, 'editor' | 'guiEditor'>,
  env: NodeJS.ProcessEnv,
  detected: readonly EditorChoice[]
): { command: string; source: GuiEditorSource } | null {
  const set = p.guiEditor?.trim();
  if (set) return editorKind(set) === 'gui' ? { command: set, source: 'setting' } : null;
  for (const [source, value] of [['editor', p.editor], ['VISUAL', env.VISUAL], ['EDITOR', env.EDITOR]] as const) {
    const command = value?.trim();
    if (command && editorKind(command) === 'gui') return { command, source };
  }
  const own = integratedTerminalEditor(env);
  if (own && detected.some((e) => e.command === own)) return { command: own, source: 'terminal' };
  const first = detected.find((e) => editorKind(e.command) === 'gui');
  return first ? { command: first.command, source: 'path' } : null;
}

/** The editors that open a file on another machine through VS Code's Remote-SSH authority. */
const REMOTE_SSH_EDITORS = new Set(['code', 'code-insiders', 'cursor']);

/**
 * How this machine's editor opens a file that lives on a saved machine (a session reviewed there), or
 * null when it cannot. A KNOWN terminal editor ('tty') runs on that machine over `ssh -t`; VS Code and
 * Cursor ('gui') open it from here through their own Remote-SSH. Any other GUI editor, and a command
 * this table does not know, cannot: running an unknown command over ssh could start a GUI program on a
 * machine with no display. A terminal editor opens files, not folders.
 */
export function remoteEditorKind(editor: string, dir = false): 'gui' | 'tty' | null {
  const base = editorBin(editor);
  if (REMOTE_SSH_EDITORS.has(base)) return 'gui';
  return !dir && KNOWN_EDITORS.find((e) => e.bin === base)?.kind === 'tty' ? 'tty' : null;
}

/**
 * The command that opens `file` on the saved machine at ssh `target` (see remoteEditorKind), or null.
 * The terminal editor runs under the PATH `--machine` gives a remote command, as one string for the
 * remote shell with each word single-quoted, so a path with spaces or quotes arrives whole. It is named
 * by its base name (editorBin), since this machine's path to it (`/opt/homebrew/bin/nvim`,
 * `C:\tools\nvim.exe`) means nothing there. For VS Code
 * and Cursor, `--goto` makes a path without an extension a file rather than a folder, and a folder
 * ends in `/`.
 */
export function remoteEditorLaunch(
  editor: string,
  target: string,
  file: string,
  dir = false
): { command: string; args: string[]; kind: 'gui' | 'tty' } | null {
  const parts = editor.trim().split(/\s+/).filter(Boolean);
  const kind = remoteEditorKind(editor, dir);
  if (!kind || !parts.length || !target || target.startsWith('-')) return null;
  if (kind === 'gui') {
    const at = dir ? [file.endsWith('/') ? file : file + '/'] : ['--goto', file];
    return { command: parts[0], args: [...parts.slice(1), '--remote', `ssh-remote+${target}`, ...at], kind };
  }
  const quote = (w: string): string => `'${w.replace(/'/g, `'\\''`)}'`;
  return { command: 'ssh', args: ['-t', target, `env PATH="${MACHINE_PATH}" ${[editorBin(editor), ...parts.slice(1), file].map(quote).join(' ')}`], kind };
}

/**
 * Which of them are actually on this machine, in `KNOWN_EDITORS` order.
 *
 * Every input is injectable so this can be asserted without a filesystem — the Windows branch in
 * particular has no other way to be tested from macOS, and it is the branch most likely to be wrong
 * (`code` there is `code.cmd`, which an extension-less probe never finds).
 */
export function detectEditors(
  opts: { path?: string; pathext?: string; win?: boolean; isExec?: (p: string) => boolean } = {}
): EditorChoice[] {
  const win = opts.win ?? process.platform === 'win32';
  const dirs = (opts.path ?? process.env.PATH ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts = win
    ? (opts.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const isExec =
    opts.isExec ??
    ((p: string) => {
      try {
        // A DIRECTORY named `code` on the PATH is not an editor. statSync first would double the
        // syscalls for the common miss, so the cheap access check gates it.
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const out: EditorChoice[] = [];
  const seenLabel = new Set<string>();
  for (const e of KNOWN_EDITORS) {
    // One entry per EDITOR, not per binary: `hx` and `helix` are the same program, and offering both
    // makes the reader step past a duplicate to reach the next real choice.
    if (seenLabel.has(e.label)) continue;
    // Cursor's agent puts a `cursor` of its own on PATH (isCursorAgentShim), which is not the editor.
    const found = dirs.some((d) => exts.some((x) => isExec(path.join(d, e.bin + x)) && !(e.bin === 'cursor' && !win && isCursorAgentShim(path.join(d, e.bin + x)))));
    if (!found) continue;
    seenLabel.add(e.label);
    out.push({ command: e.command, label: e.label });
  }
  return out;
}

/** Cursor's agent CLI installs a `cursor` script in ~/.local/bin that runs the next `cursor` on PATH and, with none,
 *  exits 1 ("No Cursor IDE installation found"). It is not the editor: an `--install-extension` through it failed
 *  wherever the editor's own command was not on PATH (2026-11-09), and W ran it in the editor's place. */
export function isCursorAgentShim(file: string): boolean {
  try {
    return fs.statSync(file).size < 16384 && fs.readFileSync(file, 'utf8').includes('No Cursor IDE installation found');
  } catch {
    return false;
  }
}

/** Where an installed Cursor keeps its own command when that is not on PATH: the macOS app bundle, and the usual
 *  Linux install folders. */
export function cursorInstalls(home = os.homedir()): string[] {
  return process.platform === 'darwin'
    ? ['/Applications', path.join(home, 'Applications')].map((root) => path.join(root, 'Cursor.app', 'Contents', 'Resources', 'app', 'bin', 'cursor'))
    : ['/usr/share/cursor/bin/cursor', '/usr/bin/cursor', '/snap/bin/cursor', path.join(home, '.local', 'bin', 'cursor')];
}

/** The Cursor editor's own command, outside Windows: the first `cursor` on PATH that is not the agent's shim, else an
 *  installed Cursor's (cursorInstalls), else null when only the agent's is here, or none. */
export function cursorEditorCli(pathVar = process.env.PATH ?? '', installs = cursorInstalls()): string | null {
  const runnable = (p: string) => {
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() && !isCursorAgentShim(p); } catch { return false; }
  };
  return [...pathVar.split(':').filter(Boolean).map((d) => path.join(d, 'cursor')), ...installs].find(runnable) ?? null;
}

/** What a detected command is called, for the row that names it. Empty for anything hand-typed. */
export function editorLabel(command: string, editors: readonly EditorChoice[]): string {
  return editors.find((e) => e.command === command)?.label ?? '';
}

export type StartFocus = 'claude' | 'traces' | 'prompts' | 'detail' | 'dashboards';
/** How the change map and the Traces list are ordered. `time` = most recently edited first (the
 *  default); `name` = path A→Z. (Superseded the earlier recent/path/churn set — those migrate on read.) */
// The change map / Traces order — four choices, a direction each way on two axes: `time` newest
// first (the default), `time-asc` oldest first, `name` A→Z, `name-desc` Z→A.
export type SortKey = 'time' | 'time-asc' | 'name' | 'name-desc';
export const SORT_KEYS: SortKey[] = ['time', 'time-asc', 'name', 'name-desc'];
/** Human labels for the sort dropdown, one per key. */
export const SORT_LABEL: Record<SortKey, string> = {
  time: 'Time (newest first)',
  'time-asc': 'Time (oldest first)',
  name: 'Name (A→Z)',
  'name-desc': 'Name (Z→A)',
};
/** Map a stored value — including the pre-2026-08 `recent`/`path`/`churn` and the two-key era — to a
 *  current key. Unknown → undefined (the reader falls back to the default). */
export function normalizeSort(v: unknown): SortKey | undefined {
  if (v === 'name' || v === 'path') return 'name';
  if (v === 'name-desc') return 'name-desc';
  if (v === 'time-asc') return 'time-asc';
  if (v === 'time' || v === 'recent' || v === 'churn') return 'time';
  return undefined;
}

/** The palettes this build ships. Named here rather than in the renderer so the settings layer can
 *  validate a hand-edited value without importing the terminal. */
export const THEME_NAMES = ['default', 'colorblind', 'light', 'mono'];

const COLORS: ColorPref[] = ['auto', 'truecolor', '256', '16', 'none'];
export const START_FOCUS: StartFocus[] = ['traces', 'prompts', 'detail', 'dashboards', 'claude'];
const GLYPHS: GlyphPref[] = ['auto', 'ascii', 'safe', 'block'];

/**
 * Read and VALIDATE. Never throws, and never returns a value the rest of the product cannot use: a
 * missing file, a truncated one, a hand-edited string where a number belongs, and a rebind onto a
 * key the decoder never emits all resolve to the same thing as "not set".
 */
export function readPrefs(file = prefsPath()): Prefs {
  let raw: unknown;
  try {
    // A byte order mark that an editor put first is not JSON: read past it, or the next write drops every setting.
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {}; // absent or unparseable — both mean "no preferences", and neither is an error
  }
  return parsePrefs(raw);
}

/** The settings in a parsed prefs.json, validated as `readPrefs` describes. */
export function parsePrefs(raw: unknown): Prefs {
  const d = (raw ?? {}) as Record<string, unknown>;
  const out: Prefs = {};
  if (typeof d.editor === 'string' && d.editor.trim()) out.editor = d.editor.trim();
  if (typeof d.guiEditor === 'string' && d.guiEditor.trim()) out.guiEditor = d.guiEditor.trim();
  if (typeof d.color === 'string' && (COLORS as string[]).includes(d.color)) out.color = d.color as ColorPref;
  if (typeof d.glyphs === 'string' && (GLYPHS as string[]).includes(d.glyphs)) out.glyphs = d.glyphs as GlyphPref;
  if (typeof d.mouse === 'boolean') out.mouse = d.mouse;
  // Absolute or `~` only. A RELATIVE store path would resolve against whatever directory the process
  // happens to start in — the capture hook, the CLI and two editors all differ — so one setting would
  // scatter a session's history across several stores and none of them would look wrong.
  if (typeof d.storeDir === 'string' && d.storeDir.trim() && isAbsoluteStorePath(d.storeDir.trim())) {
    out.storeDir = d.storeDir.trim();
  }
  if (typeof d.startFocus === 'string' && (START_FOCUS as string[]).includes(d.startFocus)) out.startFocus = d.startFocus as StartFocus;
  { const s = normalizeSort(d.sort); if (s) out.sort = s; }
  // Validated against a list core owns, so this module stays free of the renderer. The tui package
  // exports the palettes; the NAMES are the contract, and they live here beside every other setting.
  if (typeof d.theme === 'string' && (THEME_NAMES as string[]).includes(d.theme)) out.theme = d.theme;
  // ABSENT means ON (2026-08-15): every consumer reads this as `syntax !== false`, so the default
  // needs no stored value — and storing one would break the 'only non-defaults are written' rule.
  if (typeof d.syntax === 'boolean') out.syntax = d.syntax;
  if (typeof d.remoteTitles === 'boolean') out.remoteTitles = d.remoteTitles;
  if (typeof d.machineUsage === 'boolean') out.machineUsage = d.machineUsage;
  const sync = parseSyncPrefs(d.sync);
  if (sync) out.sync = sync;
  const agents = parseAgentPrefs(d.agents);
  if (agents) out.agents = agents;
  // Notifications: each field validated on its own, unknown kinds dropped — a kind name from a newer
  // build must not make the whole setting vanish, nor an unknown one reach the announcer.
  if (d.notify && typeof d.notify === 'object' && !Array.isArray(d.notify)) {
    const n = d.notify as Record<string, unknown>;
    const nv: NonNullable<Prefs['notify']> = {};
    if (typeof n.desktop === 'boolean') nv.desktop = n.desktop;
    if (typeof n.sound === 'boolean') nv.sound = n.sound;
    if (Array.isArray(n.kinds)) nv.kinds = n.kinds.filter((k): k is HandKind => typeof k === 'string' && (HAND_KINDS as readonly string[]).includes(k));
    if (typeof n.cooldownSeconds === 'number' && Number.isFinite(n.cooldownSeconds) && n.cooldownSeconds >= 0) nv.cooldownSeconds = Math.floor(n.cooldownSeconds);
    if (Object.keys(nv).length) out.notify = nv;
  }
  // THE LAYOUT IS VALIDATED, NEVER TRUSTED. A wrong version, a non-object, a size that is not a
  // finite number — each drops the whole record back to the built-in arrangement. The failure this
  // guards against is not a wrong width; it is a hand-edited or older-build prefs file blanking the
  // frame, which is the one setting that can make the product unusable.
  const lay = d.layout as Record<string, unknown> | undefined;
  if (lay && typeof lay === 'object' && lay.version === LAYOUT_VERSION) {
    const tabs: NonNullable<Prefs['layout']>['tabs'] = {};
    const src = (lay.tabs ?? {}) as Record<string, Record<string, unknown>>;
    for (const [id, t] of Object.entries(src)) {
      if (!t || typeof t !== 'object') continue;
      const one: NonNullable<NonNullable<Prefs['layout']>['tabs']>[string] = {};
      if (Array.isArray(t.minimized)) one.minimized = t.minimized.filter((x): x is string => typeof x === 'string');
      if (typeof t.zoom === 'string' || t.zoom === null) one.zoom = t.zoom as string | null;
      if (typeof t.focus === 'string') one.focus = t.focus;
      // The tree's own state. `root` is kept opaque here — its STRUCTURE is validated by the TUI on
      // restore (`parseTree`), which is the layer that knows which views exist in this build.
      if (t.root && typeof t.root === 'object') one.root = t.root;
      if (typeof t.treeFocus === 'string') one.treeFocus = t.treeFocus;
      if (typeof t.treeZoom === 'string' || t.treeZoom === null) one.treeZoom = t.treeZoom as string | null;
      if (t.sizes && typeof t.sizes === 'object') {
        const sizes: Record<string, number> = {};
        for (const [k, v] of Object.entries(t.sizes as Record<string, unknown>)) {
          // A stored width is a REQUEST, and the resolver floors it at the pane's own minimum. What
          // it must never be is NaN or negative, which would propagate into every rect on the frame.
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) sizes[k] = Math.floor(v);
        }
        if (Object.keys(sizes).length) one.sizes = sizes;
      }
      if (Object.keys(one).length) tabs[id] = one;
    }
    const active = typeof lay.active === 'string' ? lay.active : undefined;
    if (active || Object.keys(tabs).length) out.layout = { version: LAYOUT_VERSION, active, tabs };
  }
  if (typeof d.billDay === 'number' && Number.isFinite(d.billDay) && d.billDay >= 1 && d.billDay <= 31) {
    // --bill-day wrote this and nothing ever read it back — the read and
    // write whitelists below both omitted it, so the whole prefs tier of the ladder was dead.
    out.billDay = Math.trunc(d.billDay);
  }
  if (typeof d.gptBillDay === 'number' && Number.isFinite(d.gptBillDay) && d.gptBillDay >= 1 && d.gptBillDay <= 31) {
    out.gptBillDay = Math.trunc(d.gptBillDay);
  }
  if (d.accountBilling) out.accountBilling = parseAccountBilling(d.accountBilling);
  if (typeof d.refreshSeconds === 'number' && Number.isFinite(d.refreshSeconds)) {
    // Floored at one second. A zero or a negative would poll as fast as the loop can spawn, and this
    // dashboard shells out to a child process per refresh.
    out.refreshSeconds = Math.max(1, Math.min(3600, Math.round(d.refreshSeconds)));
  }
  if (d.keys && typeof d.keys === 'object') {
    const keys: Partial<Record<Action, string>> = {};
    const blocked: Partial<Record<Action, string>> = {};
    const known = new Set<string>(REBINDABLE.map((r) => r.action));
    for (const [k, v] of Object.entries(d.keys as Record<string, unknown>)) {
      // One printable character, and an action this build knows. A multi-character "binding" would
      // never match a decoded key, so accepting it would produce a verb that silently stopped working.
      if (!known.has(k) || typeof v !== 'string' || [...v].length !== 1 || v < ' ') continue;
      // A reserved key is not live, but it is the reader's saved choice: kept aside, not dropped, so the
      // next write does not delete it before the reader has been told.
      if (RESERVED_KEYS.has(v)) blocked[k as Action] = v;
      else keys[k as Action] = v;
    }
    if (Object.keys(keys).length) out.keys = keys;
    if (Object.keys(blocked).length) out.blockedKeys = blocked;
  }
  return out;
}

/**
 * Write, atomically, keeping only what differs from the defaults.
 *
 * Temp-then-rename, like every other writer here: a crash mid-write must never leave a truncated
 * prefs file, because the next start would read it as "no preferences" and silently discard
 * everything the reader had set.
 */
/**
 * The stored layout's shape version. BUMP IT on any shape change rather than writing a migration:
 * an older record is ignored and the reader gets the built-in arrangement, which is a visible,
 * recoverable outcome. A half-understood layout is not.
 */
// 2: the observatory tree was restructured (Workflows/Processes stacked as auto-hiding strips rather
//    than Workflows beside Tasks), so a v1 record's saved root would pin the old arrangement.
// 4 (2026-08-17): the observatory tree gained a left agents sidebar and folded the two Workers windows
// back into one (grouped by provider); the review dock moved Prompts over Traces. Each restructures the
// persisted tree, so an older layout must be discarded rather than restored over the new defaults.
// 5 (2026-08-18): the observatory tree became a two-pane MASTER/DETAIL over sessions — the left lists
// every session by title, the right shows the selected session's spawn-agents and tasks; the Workers
// board, standalone Tasks/Workflows panes and Processes are gone. A v4 root would pin the old four-way
// split, so it must be discarded.
// 6 (2026-08-18): the review dock swapped Prompts and Map (Map+Traces left, Prompts+Diff right) and
// defaults the left column to 30%. A v5 record's persisted column/row sizes were dragged against the old
// arrangement, so they must be discarded for the new default to show.
// 7 (2026-08-18): the observatory master widened to 0.45 as its sessions became boxed 3-line BLOBS with a
// button row. A v6 record pins the old 0.32, too narrow for the buttons — discard it.
// 8 (2026-08-18): the blob buttons became ICONS, so the master narrowed to 0.25. A v7 record pins 0.45.
export const LAYOUT_VERSION = 8;

export function parseAccountBilling(value: unknown): import('./account-billing').AccountBilling {
  const out: import('./account-billing').AccountBilling = {};
  for (const agent of ['claude', 'codex'] as const) {
    const v = (value as import('./account-billing').AccountBilling | undefined)?.[agent];
    if (v && Number.isInteger(v.day) && v.day >= 0 && v.day <= 31 && Number.isSafeInteger(v.at) && v.at >= 0 &&
      typeof v.account === 'string' && /^(?:[a-f0-9]{12}|[a-f0-9]{16})?$/.test(v.account)) out[agent] = v;
  }
  return out;
}

let accountBillDayReader: ((agent: 'claude' | 'codex') => number | undefined) | undefined;
/** Account reads register this after loading the database; capture only needs local preferences. */
export function setAccountBillDayReader(read: NonNullable<typeof accountBillDayReader>): void { accountBillDayReader = read; }

/** The bill day the month figures anchor to: the user's stated prefs.billDay, else the day of
 *  `oauthAccount.subscriptionCreatedAt` from Claude Code's own .claude.json (anniversary
 *  billing renews on that day-of-month), else null (callers fall back to calendar months). */
export function billDay(prefs: Prefs = readPrefs()): number | null {
  if (arguments.length === 0) {
    const shared = accountBillDayReader?.('claude');
    if (shared !== undefined) return shared || null;
  }
  if (typeof prefs.billDay === 'number' && prefs.billDay >= 1 && prefs.billDay <= 31) return Math.trunc(prefs.billDay);
  try {
    const cj = JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf8'));
    const at = Date.parse(cj?.oauthAccount?.subscriptionCreatedAt ?? '');
    if (isFinite(at)) return new Date(at).getUTCDate();
  } catch {
    /* no account cache on this machine */
  }
  return null;
}

/** The bill day the GPT/codex month anchors to — `prefs.gptBillDay` only (no codex payload carries
 *  the subscription date, unlike claude's .claude.json), else null (calendar months). */
export function gptBillDay(prefs: Prefs = readPrefs()): number | null {
  if (arguments.length === 0) {
    const shared = accountBillDayReader?.('codex');
    if (shared !== undefined) return shared || null;
  }
  if (typeof prefs.gptBillDay === 'number' && prefs.gptBillDay >= 1 && prefs.gptBillDay <= 31) return Math.trunc(prefs.gptBillDay);
  return null;
}

/** The notification kinds an absent `notify.kinds` means (notify.ts DEFAULT_NOTIFY_KINDS), and the fields `notify` has. */
const DEFAULT_KINDS: readonly HandKind[] = ['permission', 'question', 'input'];
const NOTIFY_FIELDS: readonly (keyof NonNullable<Prefs['notify']>)[] = ['desktop', 'sound', 'kinds', 'cooldownSeconds'];

export function writePrefs(p: Prefs, file = prefsPath()): void {
  // The upkeep that restores settings an older OAK dropped uses this same lock through its comparison and rename.
  (require('./store') as typeof import('./store')).withPrefsMutation(file, () => writePrefsLocked(p, file));
}

function writePrefsLocked(p: Prefs, file: string): void {
  // What the file holds now. A file that does not parse (a hand edit half done) is left as it is, and the caller says so:
  // read as no preferences, it was replaced by the caller's settings alone.
  let raw: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('prefs.json is not valid JSON, so it was left as it is');
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  }
  const clean: Prefs = {};
  const agents = parseAgentPrefs(p.agents);
  if (agents) clean.agents = agents;
  if (p.editor && p.editor.trim()) clean.editor = p.editor.trim();
  if (p.guiEditor && p.guiEditor.trim()) clean.guiEditor = p.guiEditor.trim();
  if (p.color && p.color !== 'auto') clean.color = p.color;
  if (p.glyphs && p.glyphs !== 'auto') clean.glyphs = p.glyphs;
  if (p.mouse === false) clean.mouse = false;
  if (p.refreshSeconds && p.refreshSeconds !== 3) clean.refreshSeconds = p.refreshSeconds;
  if (typeof p.billDay === 'number' && p.billDay >= 1 && p.billDay <= 31) clean.billDay = Math.trunc(p.billDay);
  if (typeof p.gptBillDay === 'number' && p.gptBillDay >= 1 && p.gptBillDay <= 31) clean.gptBillDay = Math.trunc(p.gptBillDay);
  if (p.accountBilling) clean.accountBilling = parseAccountBilling(p.accountBilling);
  if (p.startFocus && p.startFocus !== 'traces') clean.startFocus = p.startFocus;
  if (p.sort && p.sort !== 'time') clean.sort = p.sort;
  if (p.theme && p.theme !== 'default') clean.theme = p.theme;
  // Only the NON-default is written, and for this setting the non-default is 'off'.
  if (p.syntax === false) clean.syntax = false;
  if (p.remoteTitles === false) clean.remoteTitles = false; // on is the default, so only off is stored
  if (p.machineUsage === false) clean.machineUsage = false; // likewise
  const sync = parseSyncPrefs(p.sync);
  if (sync) clean.sync = sync;
  // Notifications: only what differs from the defaults (on · no sound · the three waits · 30s).
  if (p.notify) {
    const n: NonNullable<Prefs['notify']> = {};
    if (p.notify.desktop === false) n.desktop = false;
    if (p.notify.sound === true) n.sound = true;
    if (p.notify.kinds && [...p.notify.kinds].sort().join() !== [...DEFAULT_KINDS].sort().join()) n.kinds = [...p.notify.kinds];
    if (typeof p.notify.cooldownSeconds === 'number' && p.notify.cooldownSeconds !== 30) n.cooldownSeconds = p.notify.cooldownSeconds;
    if (Object.keys(n).length) clean.notify = n;
  }
  // The layout is written whole or not at all: a partial record would read back as "this tab was
  // never customised" for whatever it omitted, which is indistinguishable from a reset.
  if (p.layout && (p.layout.active || Object.keys(p.layout.tabs ?? {}).length)) {
    clean.layout = { version: LAYOUT_VERSION, active: p.layout.active, tabs: p.layout.tabs };
  }
  if (p.storeDir && p.storeDir.trim()) clean.storeDir = p.storeDir.trim();
  // `__reject` is deliberately absent: it is a message about a value that did NOT become a setting.
  const keys: Partial<Record<Action, string>> = {};
  for (const r of REBINDABLE) {
    const v = p.keys?.[r.action];
    if (v && v !== r.fallback) keys[r.action] = v;
    // A blocked rebind is written back until the reader binds the action again (or resets).
    else if (!v && p.blockedKeys?.[r.action]) keys[r.action] = p.blockedKeys[r.action];
  }
  // A binding this build cannot read (an action a newer build added, a key it does not take) keeps what the file gives
  // it, unless the caller binds that action.
  const read = parsePrefs(raw);
  const fileKeys = raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys) ? (raw.keys as Record<string, unknown>) : {};
  for (const [action, key] of Object.entries(fileKeys)) {
    const bound = (by?: Partial<Record<Action, string>>): boolean => by?.[action as Action] !== undefined;
    if (!bound(read.keys) && !bound(read.blockedKeys) && !bound(p.keys) && !bound(p.blockedKeys)) (keys as Record<string, unknown>)[action] = key;
  }
  if (Object.keys(keys).length) clean.keys = keys;
  // A setting the caller left as this build reads it is written back as the file has it. Rebuilt from what this build
  // understands, every save dropped a key a newer build wrote, and a value this build cannot read (a palette it lacks).
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const out: Record<string, unknown> = { [PREFS_FORMAT_KEY]: PREFS_FORMAT, ...clean };
  for (const [k, v] of Object.entries(raw)) {
    // `keys` is read into two settings: the live rebinds, and those held on a reserved key.
    const left = k === 'keys' ? same(p.keys, read.keys) && same(p.blockedKeys, read.blockedKeys) : same(p[k as keyof Prefs], read[k as keyof Prefs]);
    if (left) out[k] = v;
  }
  // `notify` by the same rule, field by field: changing one of its fields dropped a field a newer build added, a value this
  // build cannot read, and a kind it does not have. A kind it does not have stays beside the kinds the caller chose.
  const fileNotify = raw.notify && typeof raw.notify === 'object' && !Array.isArray(raw.notify) ? (raw.notify as Record<string, unknown>) : null;
  if (fileNotify && !same(p.notify, read.notify)) {
    const n: Record<string, unknown> = { ...clean.notify };
    for (const [k, v] of Object.entries(fileNotify)) {
      const field = k as keyof NonNullable<Prefs['notify']>;
      if (!NOTIFY_FIELDS.includes(field) || same(p.notify?.[field], read.notify?.[field])) n[k] = v;
      else if (field === 'kinds' && Array.isArray(v)) {
        const unknown = v.filter((x) => !(HAND_KINDS as readonly unknown[]).includes(x));
        if (unknown.length) n.kinds = [...(p.notify?.kinds ?? DEFAULT_KINDS), ...unknown];
      }
    }
    if (Object.keys(n).length) out.notify = n;
    else delete out.notify;
  }
  // `sync` by the same rule, field by field, and a level down in `families` and `exclude`: changing one setting with
  // `oak sync …` dropped a field a newer build added (a backup kind's own fields, a list it keeps) and a placement this
  // build cannot read. A backup is replaced whole.
  const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const fileSync = rec(raw.sync);
  if (fileSync && !same(p.sync, read.sync)) {
    const s: Record<string, unknown> = { ...clean.sync };
    const was = (read.sync ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(fileSync)) {
      if (same(s[k], was[k])) s[k] = v;
      else if ((k === 'families' || k === 'exclude') && rec(v)) {
        const inner: Record<string, unknown> = { ...rec(s[k]) };
        const wasInner = rec(was[k]) ?? {};
        for (const [k2, v2] of Object.entries(rec(v)!)) if (same(inner[k2], wasInner[k2])) inner[k2] = v2;
        if (Object.keys(inner).length) s[k] = inner;
        else delete s[k];
      }
    }
    if (Object.keys(s).length) out.sync = s;
    else delete out.sync;
  }
  // Over a prefs.json an older OAK rewrote (no PREFS_FORMAT_KEY), oak sync's settings and `machineUsage` that it dropped,
  // and so the caller did not set, are written from oak sync's copy (sync-state.ts keptOverOlder; late-required, as the
  // store is).
  let restored: readonly string[] = [];
  if (file === prefsPath() && text !== undefined && raw[PREFS_FORMAT_KEY] === undefined) {
    try {
      restored = (require('./sync-state') as { keptOverOlder(out: Record<string, unknown>): string[] }).keptOverOlder(out);
    } catch {
      /* written as the caller asked */
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, file);
  // `rootDir()` memoizes the store location for a turn of the event loop, so a storeDir written here
  // has to invalidate it or the options window would save a setting this process ignores until then.
  // Late-required to keep this module free of a store import at load time.
  try {
    (require('./store') as { clearRootMemo(): void }).clearRootMemo();
  } catch {
    /* store not loaded in this process — nothing memoized to clear */
  }
  // oak sync keeps a copy of `sync` and `machineUsage` (sync-state.ts keptPrefs), which brings them back when an OAK older
  // than 0.11.0 rewrites this file without them: it follows every write here.
  if (file === prefsPath()) {
    try {
      (require('./sync-state') as { noteKeptPrefs(out: Record<string, unknown>, restored?: readonly string[]): void }).noteKeptPrefs(out, restored);
    } catch {
      /* the copy follows the file at the next read (keptPrefs) */
    }
  }
}

/**
 * The full key -> action map, defaults folded with the reader's rebinds.
 *
 * A rebind that COLLIDES with another action's key wins for itself and leaves the loser unbound —
 * reported by `keyConflicts`, so the options window can say so instead of the reader discovering it
 * by pressing a key that stopped working.
 */
export function keymap(p: Prefs): Map<string, Action> {
  const out = new Map<string, Action>();
  // Defaults FIRST, then the reader's rebinds over the top. One pass in declaration order gave the
  // contested key to whichever action happened to be declared last — so rebinding Keep onto `u` left
  // `u` still running Undo, and the setting the reader had just made appeared to do nothing.
  for (const r of REBINDABLE) if (!p.keys?.[r.action]) out.set(r.fallback, r.action);
  for (const r of REBINDABLE) {
    const k = p.keys?.[r.action];
    if (k) out.set(k, r.action);
  }
  return out;
}

/** Actions whose key is claimed by another action, and by which — empty when the map is clean. */
export function keyConflicts(p: Prefs): { action: Action; key: string; takenBy: Action }[] {
  // Resolved against the SAME map the runtime dispatches through, rather than by re-deriving the
  // precedence here — a conflict report that disagrees with the dispatcher is worse than none.
  const map = keymap(p);
  const out: { action: Action; key: string; takenBy: Action }[] = [];
  for (const r of REBINDABLE) {
    const key = p.keys?.[r.action] ?? r.fallback;
    const winner = map.get(key);
    if (winner && winner !== r.action) out.push({ action: r.action, key, takenBy: winner });
  }
  return out;
}
