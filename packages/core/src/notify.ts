/**
 * Raised hands, announced where the reader is: desktop notifications, the ranked "needs you" inbox,
 * and the next-hand jump every surface shares.
 *
 * The STATE is exact — the hooks write attention.json (capture.ts) — so nothing here reads a screen.
 * What this module adds is the RULE for announcing it once per machine: three surfaces can be open at
 * once (the terminal app, VS Code, JetBrains) and each already toasts in-app once per raised hand;
 * the OS notification must fire ONCE, from whichever surface sees the transition first, so the claim
 * lives in a file every process can see, taken under an exclusive-create lock. The cooldown is per
 * session: a hand that goes up, down and up again inside it stays quiet unless the new wait is more
 * urgent — an input wait followed by a permission prompt still announces.
 *
 * Nothing here ever answers a prompt. Announcing is the whole job; the answer stays in the agent's
 * own terminal (or, for a driven session, the Feed tab).
 */
import * as fs from 'fs';
import * as path from 'path';
import { rootDir, isSafeSessionId } from './store';
import { fileWithinLast, withinLast } from './stamp';
import { readPrefs, HAND_KINDS, type HandKind } from './prefs';
import { spawnTool } from './spawn';
import { sessionMeta, pendingQuestion, type PendingQuestion, type SessionMeta } from './observe';
import { waitedMs, readAttention } from './capture';
import { oakCliEntry } from './cli-entry';
import { codexAutoReview } from './codex';

export { HAND_KINDS, type HandKind };

/** Urgency order: what to jump to first when several sessions wait at once. */
export const HAND_RANK: Record<HandKind, number> = { permission: 0, question: 1, input: 2, 'idle-done': 3 };

/** The one wording every surface uses for a raised hand. */
export function attentionLabel(kind: HandKind): string {
  return kind === 'question'
    ? 'has a question for you'
    : kind === 'permission'
      ? 'needs your permission'
      : kind === 'input'
        ? 'is waiting for your input'
        : 'finished its turn';
}

export interface NotifyPrefs {
  desktop: boolean;
  sound: boolean;
  kinds: HandKind[];
  cooldownSeconds: number;
}

/** Desktop announcements are ON by default for the three waits and OFF for a finished turn — a turn
 *  ending is the quiet state every surface shows; a prompt the agent cannot pass is the one worth a
 *  notification. */
export const DEFAULT_NOTIFY_KINDS: HandKind[] = ['permission', 'question', 'input'];

export function notifyPrefs(p = readPrefs()): NotifyPrefs {
  const n = p.notify ?? {};
  return {
    desktop: n.desktop ?? true,
    sound: n.sound ?? false,
    kinds: n.kinds ?? DEFAULT_NOTIFY_KINDS,
    cooldownSeconds: n.cooldownSeconds ?? 30,
  };
}

export type Notifier = 'osc9' | 'notify-send' | 'gdbus' | 'terminal-notifier' | 'osascript' | 'powershell' | 'none';

/**
 * Does the terminal this process runs in turn OSC 9 into a desktop notification of its own? iTerm2,
 * Ghostty, WezTerm and kitty do, and the notification then carries the TERMINAL's name and icon, and a
 * click brings the terminal forward (iTerm2, Ghostty and kitty to the tab that wrote it). On macOS that
 * replaces osascript, whose notifications belong to Script Editor and whose click opens Script Editor.
 *
 * Anything between the process and the terminal swallows the sequence: tmux, screen, zellij, a herdr
 * pane (herdr 0.9.1 was measured dropping a pane's OSC 9 and 777) and a tab of OAK's own terminal app
 * (OAK_TAB). A pane inherits the outer terminal's TERM_PROGRAM, so those are ruled out first, and so
 * is Alacritty, which posts nothing and sets no TERM_PROGRAM of its own. TERM_PROGRAM names the
 * terminal; kitty sets none (KITTY_WINDOW_ID), and over ssh only iTerm2's LC_TERMINAL survives.
 */
export function osc9Terminal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TMUX || env.STY || env.ZELLIJ || env.HERDR_ENV || env.OAK_TAB || env.ALACRITTY_WINDOW_ID) return false;
  const term = env.TERM_PROGRAM || (env.KITTY_WINDOW_ID ? 'kitty' : env.LC_TERMINAL);
  return term === 'iTerm.app' || term === 'iTerm2' || term === 'ghostty' || term === 'WezTerm' || term === 'kitty';
}

/** The OSC 9 notification: one line, `<title>: <body>`. Control characters become spaces, so no
 *  text can end the sequence early or smuggle another one in. */
export function osc9Seq(title: string, body: string): string {
  return `\x1b]9;${`${title}: ${body}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}\x07`;
}

/** Write to this process's controlling terminal. False when it has none (an editor's extension host,
 *  a process the editor spawned) or the terminal has gone. */
function writeTty(seq: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync('/dev/tty', fs.constants.O_WRONLY);
    fs.writeSync(fd, seq);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function onPath(name: string): boolean {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    try {
      if (fs.statSync(path.join(d, name)).isFile()) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** Where Homebrew installs terminal-notifier on Apple silicon and on Intel. An app launched from the
 *  Dock (an editor, and so its extension host) can run without either on PATH. */
let tnFallbackDirs = ['/opt/homebrew/bin', '/usr/local/bin'];

/** For the tests: the directories searched after PATH (undefined restores Homebrew's). */
export function setTerminalNotifierDirs(dirs: string[] | undefined): void {
  tnFallbackDirs = dirs ?? ['/opt/homebrew/bin', '/usr/local/bin'];
}

/** terminal-notifier's absolute path: PATH first, then Homebrew's directories. Null when it is not
 *  installed. The post spawns this path and `oak doctor` asks the same question, so the two agree. */
export function terminalNotifierPath(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const d of [...(env.PATH ?? '').split(path.delimiter), ...tnFallbackDirs]) {
    if (!d || !path.isAbsolute(d)) continue;
    const file = path.join(d, 'terminal-notifier');
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** macOS without a terminal that posts (an editor, a herdr pane): terminal-notifier when it is
 *  installed, else osascript, which every Mac ships but whose notifications macOS files under Script
 *  Editor, so a click opens Script Editor. terminal-notifier's own click runs `oak focus` and brings the
 *  terminal forward. */
const macNotifier = (): Notifier => (terminalNotifierPath() ? 'terminal-notifier' : fs.existsSync('/usr/bin/osascript') ? 'osascript' : 'none');

/** Which native notifier this process has. A PATH scan, not a memo: the terminal app lives for hours
 *  and a tool installed meanwhile should start working without a restart. On macOS a process in a
 *  terminal that posts OSC 9 uses the terminal; any other uses `macNotifier`. */
export function desktopNotifier(): Notifier {
  if (process.platform === 'darwin') return osc9Terminal() && writeTty('') ? 'osc9' : macNotifier();
  if (process.platform === 'win32') return 'powershell';
  if (onPath('notify-send')) return 'notify-send';
  // libnotify is often absent on a headless-installed desktop; the session bus is not. gdbus speaks
  // the same org.freedesktop.Notifications call notify-send would make.
  if (onPath('gdbus') && (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return 'gdbus';
  return 'none';
}

/** An AppleScript string literal. */
const asStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A WinRT toast from PowerShell — the only notifier Windows ships without a module install. The title and
 *  body are text a model wrote, so they never become PowerShell source: they travel in the environment
 *  (OAK_TOAST_TITLE, OAK_TOAST_BODY) and PowerShell XML-escapes them itself. Spliced into a single-quoted
 *  literal, a curly quote (which PowerShell also reads as a quote) ended it and ran what followed. The
 *  script holds no double quote, which cmd.exe would strip.
 *
 *  The notifier is Windows PowerShell's own app id, the one its Start-menu shortcut registers: Windows shows
 *  a desktop app's toast only for an id a shortcut or an `HKCU\Software\Classes\AppUserModelId` key
 *  registers, and nothing registered the 'OAK' id this used before, so those toasts could be dropped. The
 *  toast is headed "Windows PowerShell"; its first line still names OAK. */
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const TOAST_SCRIPT =
  `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ` +
  `$e = [System.Security.SecurityElement]; $x = New-Object Windows.Data.Xml.Dom.XmlDocument; ` +
  `$x.LoadXml('<toast><visual><binding template=''ToastGeneric''><text>' + $e::Escape($env:OAK_TOAST_TITLE) + '</text><text>' + $e::Escape($env:OAK_TOAST_BODY) + '</text></binding></visual></toast>'); ` +
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;

/** A POSIX shell word: terminal-notifier runs `-execute` through /bin/sh. */
const shWord = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** terminal-notifier reads its options as macOS user defaults, which parse a value that looks like a
 *  property list (`(a, b)`, `{…}`, `<…>`, `"…"`) or an option (`-x`) as one. A zero-width space in front
 *  keeps any text a plain string. */
const tnText = (s: string): string => (/^[\s\-[({<"'\\]/.test(s) ? `\u200b${s}` : s);

export interface NotifyOptions {
  sound?: boolean;
  urgent?: boolean;
  /** The session the notification is about: terminal-notifier groups by it, so a newer notification
   *  replaces an older one, and a click runs `oak focus --session <it>`. */
  session?: string;
  /** For the tests: the environment whose __CFBundleIdentifier names the app to bring forward and whose
   *  CLAUDE_CONFIG_DIR a click keeps, and the oak CLI entry a click runs. */
  env?: NodeJS.ProcessEnv;
  cli?: string;
}

/** The argv a notifier takes — exported for the tests, which must never pop a real notification. */
export function notifierArgv(via: Notifier, title: string, body: string, opts: NotifyOptions = {}): { file: string; args: string[]; env?: Record<string, string> } | null {
  switch (via) {
    case 'terminal-notifier': {
      // The app that started this process (iTerm2 sets com.googlecode.iterm2, and a herdr server
      // keeps the value of the terminal it was started from) is the one a click brings forward.
      const env = opts.env ?? process.env;
      const app = env.__CFBundleIdentifier;
      const cli = opts.cli ?? oakCliEntry();
      const session = opts.session && isSafeSessionId(opts.session) ? opts.session : undefined;
      return {
        // By absolute path: the spawn looks a bare name up on PATH, which the scan went past.
        file: terminalNotifierPath(env) ?? 'terminal-notifier',
        args: [
          '-title', tnText(title), '-message', tnText(body),
          ...(session ? ['-group', `oak-${session}`] : []),
          ...(app && /^[A-Za-z0-9.-]+$/.test(app) ? ['-activate', app] : []),
          // Absolute paths: the click runs in terminal-notifier's own environment, without the shell's PATH
          // and without a relocated CLAUDE_CONFIG_DIR, which decides where `oak focus` finds the app.
          ...(session && cli ? ['-execute', `${env.CLAUDE_CONFIG_DIR ? `export CLAUDE_CONFIG_DIR=${shWord(env.CLAUDE_CONFIG_DIR)}; ` : ''}exec ${shWord(process.execPath)} ${shWord(cli)} focus --session ${shWord(session)}`] : []),
          ...(opts.sound ? ['-sound', 'Glass'] : []),
        ],
      };
    }
    case 'notify-send':
      return { file: 'notify-send', args: ['-a', 'OAK', '-u', opts.urgent ? 'critical' : 'normal', ...(opts.sound ? ['-h', 'string:sound-name:message-new-instant'] : []), title, body] };
    case 'gdbus':
      return {
        file: 'gdbus',
        args: [
          'call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
          '--method', 'org.freedesktop.Notifications.Notify', 'OAK', '0', '', title, body, '[]', opts.urgent ? "{'urgency': <byte 2>}" : '{}', '8000',
        ],
      };
    case 'osascript':
      return { file: '/usr/bin/osascript', args: ['-e', `display notification ${asStr(body)} with title ${asStr(title)}${opts.sound ? ' sound name "Glass"' : ''}`] };
    case 'powershell':
      // Without the control characters XML forbids: one made LoadXml throw, and the toast never showed.
      return { file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT],
        env: { OAK_TOAST_TITLE: title.replace(XML_FORBIDDEN, ''), OAK_TOAST_BODY: body.replace(XML_FORBIDDEN, '') } };
    default:
      return null;
  }
}

/** Pop one desktop notification, detached: the caller is a paint tick or a hook, and neither waits.
 *  Never throws — a notifier that is missing or fails is a missing convenience, not an error. A
 *  terminal notification leaves sound and urgency to the terminal's own settings. */
export function desktopNotify(title: string, body: string, opts: NotifyOptions = {}): { sent: boolean; via: Notifier } {
  let via = desktopNotifier();
  if (via === 'osc9') {
    if (writeTty(osc9Seq(title, body))) return { sent: true, via };
    via = macNotifier(); // the terminal closed since the check
  }
  const spec = notifierArgv(via, title, body, opts);
  if (!spec) return { sent: false, via };
  try {
    // Straight to the notifier, never through cmd.exe, and its text in the environment where it asks for it.
    const child = spawnTool(spec.file, spec.args, { detached: true, stdio: 'ignore', windowsHide: true, direct: true, ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}) });
    child.on('error', () => {
      /* the tool vanished between the scan and the spawn */
    });
    child.unref();
    return { sent: true, via };
  } catch {
    return { sent: false, via };
  }
}

interface ClaimRec {
  ts: number;
  at: number;
  kind: HandKind;
}

function claimsPath(): string {
  return path.join(rootDir(), 'notify-claims.json');
}

/**
 * May THIS process announce this hand? True at most once per machine per raised hand (keyed by the
 * hand's ts), never inside the cooldown unless the new wait is more urgent, and never for a kind the
 * reader turned off. The decision is recorded before it is returned, under an exclusive-create lock,
 * so two surfaces reading the same tick cannot both say yes. A lock older than ten seconds is a crash
 * leftover and is reclaimed on the NEXT call — this one stays quiet rather than racing a live holder. A lock or a
 * claim dated ahead of this clock (stepped back since) holds nothing: until the clock caught up, the lock muted every
 * hand and the claim every new one of its kind.
 */
export function dueDesktopNotify(session: string, kind: HandKind, ts: number, now = Date.now(), prefs = notifyPrefs()): boolean {
  return claimDesktopNotify(session, kind, ts, now, prefs) === 'claimed';
}

/** dueDesktopNotify's answer, telling a lock another surface held (`busy`: this hand was not decided, and is asked again
 *  on that surface's next look) from one that is not due. */
function claimDesktopNotify(session: string, kind: HandKind, ts: number, now: number, prefs: NotifyPrefs): 'claimed' | 'not-due' | 'busy' {
  if (!prefs.desktop || !prefs.kinds.includes(kind)) return 'not-due';
  const file = claimsPath();
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fs.mkdirSync(rootDir(), { recursive: true, mode: 0o700 });
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch {
    try {
      if (!fileWithinLast(lock, fs.statSync(lock).mtimeMs, 10_000, now)) fs.unlinkSync(lock);
    } catch {
      /* the holder finished first */
    }
    return 'busy';
  }
  try {
    let claims: Record<string, ClaimRec> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object') claims = raw as Record<string, ClaimRec>;
    } catch {
      /* first claim ever, or an unreadable file — start over */
    }
    const prev = claims[session];
    if (prev && typeof prev.ts === 'number' && prev.ts >= ts) return 'not-due';
    if (prev && typeof prev.at === 'number' && withinLast(prev.at, prefs.cooldownSeconds * 1000, now) && HAND_RANK[kind] >= (HAND_RANK[prev.kind] ?? 9)) return 'not-due';
    for (const [k, v] of Object.entries(claims)) if (!v || typeof v.at !== 'number' || now - v.at > 86_400_000) delete claims[k];
    claims[session] = { ts, at: now, kind };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(claims), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return 'claimed';
  } catch {
    return 'not-due';
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

export interface HandRow {
  id: string;
  title?: string | null;
  agent?: string;
  attention: { kind: HandKind; message: string; ts: number } | null;
  /** Another machine's hand (an inbox row's `host`, and `machine`, the label this machine knows it by): claimed under
   *  that machine's id, since a session id can repeat across machines, and announced naming the machine. */
  host?: string;
  machine?: string;
}

/** The key a hand is claimed and remembered under: its session, and for another machine's, that machine too. */
const handKey = (row: { id: string; host?: string }): string => (row.host ? `${row.id}@${row.host}` : row.id);

/** In-process memo: session → the hand ts this process already put to the claim. A surface calls
 *  `announceAttention` for every row on every tick; without this, each tick would take the lock and
 *  read the claim file once per waiting session for a question already answered. */
const announcedHere = new Map<string, number>();

/** How long a permission prompt the person answers must stand before the desktop hears of it: one
 *  answered within it was answered by someone already at the agent's terminal. The hand itself rises
 *  at once on every surface; only the desktop notification waits. Claude Code's prompts and Codex's
 *  take the same wait, unless Codex's Auto-review answers them (`AUTO_REVIEW_WAIT_MS`). */
export const PERMISSION_GRACE_MS = 5000;

/** How long a permission prompt in a Codex session under Auto-review (`approvals_reviewer =
 *  "auto_review"`) must stand before the desktop hears of it. Codex runs its PermissionRequest hook
 *  before the reviewer decides, and the hand comes down only when the approved call reports its result,
 *  so the hand says nothing about whether the person is needed. The reviewer allows or denies the call
 *  itself, and Codex gives it 90 seconds before it denies the call as timed out; it hands a prompt to
 *  the person only when the review cannot finish (the transcript overflows the reviewer's input budget)
 *  or policy excludes the action's category from review, both inside those 90 seconds. A prompt Codex
 *  hands to the person is therefore announced up to 90 seconds late. A prompt still up after them was
 *  handed to the person; or its call is still running (a long command reports its result when it
 *  ends); or its call was a command still running when its `yield_time_ms` passed, which reports its
 *  result only through a later `write_stdin` poll, and never for a server that keeps running; or it
 *  was denied and its turn runs on (a denied call reports no result to lower it). Such a prompt is
 *  announced when the wait ends, although nobody needs to answer it. A review usually ends within a few
 *  seconds, well inside that wait, and a prompt still up after it is most often a yielded command. */
export const AUTO_REVIEW_WAIT_MS = 90_000;

/** How long a permission prompt in this session must stand before it is announced. */
export function permissionWaitMs(session?: string): number {
  return session && codexAutoReview(session) ? AUTO_REVIEW_WAIT_MS : PERMISSION_GRACE_MS;
}

/** Milliseconds before this hand may be announced: the rest of the session's permission wait for a
 *  permission prompt, 0 for any other kind or a prompt already old enough. Never more than the wait,
 *  whatever the clock. */
export function announceDelayMs(a: { kind: HandKind; ts: number }, now = Date.now(), session?: string): number {
  if (a.kind !== 'permission') return 0;
  const wait = permissionWaitMs(session);
  return Math.min(wait, Math.max(0, a.ts + wait - now));
}

/** Is `a` still the hand this session holds up, as the hooks last wrote it? A prompt that was answered
 *  was lowered, and a new one carries a new ts. */
export function handStillUp(session: string, a: { kind: HandKind; ts: number }): boolean {
  const now = readAttention(session);
  return !!now && now.kind === a.kind && now.ts === a.ts;
}

/** Pop a hand up in a surface's own window (`show`) when the desktop would hear of it: at once for any kind
 *  but a permission prompt, and for a permission prompt once its wait is over, if it still stands. The hand
 *  shows in the surface's lists at once; only the pop waits. The timer never holds the process open. Another machine's
 *  hand (`host`) pops at once: its record log brought it no sooner than an oak sync run, and whether it still stands is
 *  that machine's to say. */
export function whenHandDue(session: string, a: { kind: HandKind; ts: number }, show: () => void, now = Date.now(), host?: string): void {
  if (host) return show();
  const delay = announceDelayMs(a, now, session);
  if (delay <= 0) return show();
  setTimeout(() => {
    if (handStillUp(session, a)) show();
  }, delay).unref();
}

/** How often `announceWhenDue` looks at the hand while it waits. */
const WAIT_POLL_MS = 1000;

/**
 * Announce a hand from a process that ends when this returns (`oak notify --session`): a permission
 * prompt's wait is sat out here, looking about every second whether the hand is still up and giving up
 * as soon as it is not, and the prompt is posted only if it is still up when the wait ends. The wait is
 * read once, and capped whatever the clock, so a prompt stamped ahead of this machine's clock still
 * posts after it. `sleep` is for the tests.
 */
export async function announceWhenDue(row: HandRow, sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  const a = row.attention;
  if (!a) return false;
  if (a.kind === 'permission' && !row.host) {
    const wait = permissionWaitMs(row.id);
    for (let left = Math.min(wait, Math.max(0, a.ts + wait - Date.now())); left > 0; left -= WAIT_POLL_MS) {
      if (!handStillUp(row.id, a)) return false;
      await sleep(Math.min(left, WAIT_POLL_MS));
    }
    if (!handStillUp(row.id, a)) return false;
  }
  // The claims lock another surface holds while it decides is waited out, briefly: this process decides once, and ends.
  for (let tries = 0; tries < 20; tries++) {
    const sent = postHand(row, a, Date.now());
    if (sent !== 'busy') return sent;
    await sleep(100);
  }
  return false;
}

/** Announce a session's raised hand on the desktop if it is due. The composite every surface calls
 *  from the place it already toasts; the claim decides, the notifier fires, nothing waits. True when
 *  it posted now; a permission prompt inside its grace returns false and is posted later if it stands,
 *  and `later` then hears whether it was. */
export function announceAttention(row: HandRow, now = Date.now(), later?: (sent: boolean) => void): boolean {
  const a = row.attention;
  if (!a) return false;
  const key = handKey(row);
  if ((announcedHere.get(key) ?? 0) >= a.ts) return false;
  announcedHere.set(key, a.ts);
  // A young permission prompt is looked at again when its grace ends, and announced only if it still
  // stands. The timer never holds the process open: a surface that closes meanwhile leaves the hand to
  // the others, and a one-shot caller (`oak notify --session`) waits out the grace itself. Another machine's hand is
  // announced at once (whenHandDue).
  const delay = row.host ? 0 : announceDelayMs(a, now, row.id);
  // A claim another surface held the lock for decided nothing: this hand is looked at again on this surface's next pass.
  const post = (at: number): boolean => {
    const sent = postHand(row, a, at);
    if (sent === 'busy') announcedHere.delete(key);
    return sent === true;
  };
  if (delay > 0) {
    setTimeout(() => {
      const sent = handStillUp(row.id, a) && post(Date.now());
      later?.(sent);
    }, delay).unref();
    return false;
  }
  return post(now);
}

function postHand(row: HandRow, a: NonNullable<HandRow['attention']>, now: number): boolean | 'busy' {
  const prefs = notifyPrefs();
  const claim = claimDesktopNotify(handKey(row), a.kind, a.ts, now, prefs);
  if (claim !== 'claimed') return claim === 'busy' ? 'busy' : false;
  const name = row.title || `session ${row.id.slice(0, 8)}`;
  const who = row.agent && row.agent !== 'claude' ? `${row.agent} · ` : '';
  // Another machine's hand names that machine, and a click focuses nothing here (`oak focus` finds this machine's panes).
  const where = row.host ? ` · on ${row.machine || row.host}` : '';
  return desktopNotify(`OAK: ${name}`, `${who}${attentionLabel(a.kind)}${a.message ? ` — ${a.message}` : ''}${where}`,
    { sound: prefs.sound, urgent: a.kind === 'permission', ...(row.host ? {} : { session: row.id }) }).sent;
}

/** The sessions waiting on the reader, most urgent first, oldest first within a kind. `idle-done` rows
 *  come last and only when asked for — a finished turn is a quiet fact, not a hand. */
export type WithHand<T extends { attention: unknown }> = T & { attention: NonNullable<T['attention']> };

export function rankedHands<T extends { id: string; attention: { kind: HandKind; ts: number } | null }>(rows: readonly T[], includeDone = false): WithHand<T>[] {
  return rows
    .filter((r): r is WithHand<T> => !!r.attention && (includeDone || r.attention.kind !== 'idle-done'))
    .sort((a, b) => byHand(a.attention, b.attention));
}

/** The next session to look at: the most urgent hand, or — when `after` is itself a raised hand — the
 *  one after it in the ranking, wrapping. Null when nobody is waiting. */
export function nextAttention(rows: readonly { id: string; attention: { kind: HandKind; ts: number } | null }[], after: string | null): string | null {
  const hands = rankedHands(rows);
  if (!hands.length) return null;
  const i = after ? hands.findIndex((r) => r.id === after) : -1;
  return hands[(i + 1) % hands.length].id;
}

export interface InboxRow {
  id: string;
  title: string | null;
  agent: string;
  workspace: string;
  machine: string;
  kind: HandKind;
  message: string;
  ts: number;
  /** How long this hand has been up (0 for a finished turn). */
  waitingMs: number;
  /** Time this session spent waiting on the reader in the last day, including the standing wait. */
  waitedTodayMs: number;
  /** The unanswered AskUserQuestion, when the hand is a question and the transcript is in reach. */
  question: PendingQuestion | null;
  current: boolean;
  /** Another machine's hand, as its record log brought it (oak sync): `synced`, `machine` the label this machine knows that
   *  machine by, and `host` its id. Absent on this machine's own. A question there has no `question` here: what it asks
   *  is read from its transcript, on that machine. */
  origin?: 'synced';
  host?: string;
  /** How fresh another machine's hand is: when oak sync last brought that machine's records here (this machine's clock),
   *  and when that machine last wrote them (its clock). The hand stood when that machine last wrote. */
  syncedAt?: number | null;
  publishedAt?: number | null;
}

/** What a jump to the next hand says when none is waiting on this machine: another machine's hands (`elsewhere`, those
 *  still waiting, a turn's end aside) are answered on their machine, so the jump never goes there, and this says where
 *  they are listed (`listedIn`, as each surface names its list). */
export function nobodyWaitingHere(elsewhere: number, listedIn: string): string {
  return elsewhere > 0 ? `nobody here is waiting on you · ${elsewhere} on other machine${elsewhere === 1 ? '' : 's'}: ${listedIn} lists ${elsewhere === 1 ? 'it' : 'them'}` : 'nobody is waiting on you';
}

/** The inbox's order: most urgent first, oldest first within a kind (rankedHands). */
export function byHand(a: { kind: HandKind; ts: number }, b: { kind: HandKind; ts: number }): number {
  return HAND_RANK[a.kind] - HAND_RANK[b.kind] || a.ts - b.ts;
}

export interface Inbox {
  hands: InboxRow[];
  /** The id `nextAttention` would jump to from nowhere — the top of the list. */
  next: string | null;
  generatedAt: number;
  /** oak sync's open conflicts (sync-state.ts): another machine's copy of a file, kept beside this machine's until the
   *  person resolves it by editing their file or deleting the copy. */
  sync: SyncInboxRow[];
}

export interface SyncInboxRow {
  id: string;
  family: string;
  /** This machine's file, relative to its family's folder. */
  name: string;
  from: string;
  /** Where the other machine's copy is kept. */
  copy: string;
  at: number;
  reason: string;
  /** This machine's file, absolute (null where sync would not reach it): what a surface opens beside the copy. */
  file: string | null;
}

/** Every raised hand across this machine's sessions, ranked — what `oak inbox`, the terminal app's `i`
 *  overlay and both editors' "Needs you" groups render. `meta` is the session listing to rank, when the caller already
 *  has it (the local index's); else it is listed here. */
export function attentionInbox(cwd: string, opts: { includeDone?: boolean; now?: number; meta?: SessionMeta } = {}): Inbox {
  const now = opts.now ?? Date.now();
  const meta = opts.meta ?? sessionMeta(cwd);
  const hands = rankedHands(meta.sessions, opts.includeDone ?? true).map((r): InboxRow => {
    const a = r.attention;
    let question: PendingQuestion | null = null;
    if (a.kind === 'question') {
      try {
        question = pendingQuestion(cwd, r.id);
      } catch {
        question = null;
      }
    }
    return {
      id: r.id,
      title: r.title,
      agent: r.agent,
      workspace: r.workspace,
      machine: r.machine,
      kind: a.kind,
      message: a.message,
      ts: a.ts,
      waitingMs: a.kind === 'idle-done' ? 0 : Math.max(0, now - a.ts),
      waitedTodayMs: waitedMs(r.id, now - 86_400_000, now),
      question,
      current: r.current,
    };
  });
  const sync = (require('./sync-engine') as typeof import('./sync-engine')).openSyncConflicts()
    .map((x): SyncInboxRow => ({ id: x.id, family: x.family, name: x.name, from: x.from, copy: x.copy, at: x.at, reason: x.reason, file: x.file }));
  return { hands, next: nextAttention(meta.sessions, null), generatedAt: now, sync };
}
