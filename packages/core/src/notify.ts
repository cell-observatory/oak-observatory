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
import { rootDir } from './store';
import { readPrefs, HAND_KINDS, type HandKind } from './prefs';
import { spawnTool } from './spawn';
import { sessionMeta, pendingQuestion, type PendingQuestion } from './observe';
import { waitedMs } from './capture';

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

export type Notifier = 'osc9' | 'notify-send' | 'gdbus' | 'osascript' | 'powershell' | 'none';

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

/** macOS without a terminal that posts: osascript, which every Mac ships. */
const macScript = (): Notifier => (fs.existsSync('/usr/bin/osascript') ? 'osascript' : 'none');

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

/** Which native notifier this process has. A PATH scan, not a memo: the terminal app lives for hours
 *  and a tool installed meanwhile should start working without a restart. On macOS a process in a
 *  terminal that posts OSC 9 uses the terminal; one with no terminal (an editor) uses osascript. */
export function desktopNotifier(): Notifier {
  if (process.platform === 'darwin') return osc9Terminal() && writeTty('') ? 'osc9' : macScript();
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
 *  script holds no double quote, which cmd.exe would strip. */
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const TOAST_SCRIPT =
  `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ` +
  `$e = [System.Security.SecurityElement]; $x = New-Object Windows.Data.Xml.Dom.XmlDocument; ` +
  `$x.LoadXml('<toast><visual><binding template=''ToastGeneric''><text>' + $e::Escape($env:OAK_TOAST_TITLE) + '</text><text>' + $e::Escape($env:OAK_TOAST_BODY) + '</text></binding></visual></toast>'); ` +
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OAK').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;

/** The argv a notifier takes — exported for the tests, which must never pop a real notification. */
export function notifierArgv(via: Notifier, title: string, body: string, opts: { sound?: boolean; urgent?: boolean } = {}): { file: string; args: string[]; env?: Record<string, string> } | null {
  switch (via) {
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
export function desktopNotify(title: string, body: string, opts: { sound?: boolean; urgent?: boolean } = {}): { sent: boolean; via: Notifier } {
  let via = desktopNotifier();
  if (via === 'osc9') {
    if (writeTty(osc9Seq(title, body))) return { sent: true, via };
    via = macScript(); // the terminal closed since the check
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
 * leftover and is reclaimed on the NEXT call — this one stays quiet rather than racing a live holder.
 */
export function dueDesktopNotify(session: string, kind: HandKind, ts: number, now = Date.now(), prefs = notifyPrefs()): boolean {
  if (!prefs.desktop || !prefs.kinds.includes(kind)) return false;
  const file = claimsPath();
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fs.mkdirSync(rootDir(), { recursive: true, mode: 0o700 });
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch {
    try {
      if (now - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock);
    } catch {
      /* the holder finished first */
    }
    return false;
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
    if (prev && typeof prev.ts === 'number' && prev.ts >= ts) return false;
    if (prev && typeof prev.at === 'number' && now - prev.at < prefs.cooldownSeconds * 1000 && HAND_RANK[kind] >= (HAND_RANK[prev.kind] ?? 9)) return false;
    for (const [k, v] of Object.entries(claims)) if (!v || typeof v.at !== 'number' || now - v.at > 86_400_000) delete claims[k];
    claims[session] = { ts, at: now, kind };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(claims), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
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
}

/** Announce a session's raised hand on the desktop if it is due. The composite every surface calls
 *  from the place it already toasts; the claim decides, the notifier fires, nothing waits. */
/** In-process memo: session → the hand ts this process already put to the claim. A surface calls
 *  `announceAttention` for every row on every tick; without this, each tick would take the lock and
 *  read the claim file once per waiting session for a question already answered. */
const announcedHere = new Map<string, number>();

export function announceAttention(row: HandRow, now = Date.now()): boolean {
  const a = row.attention;
  if (!a) return false;
  if ((announcedHere.get(row.id) ?? 0) >= a.ts) return false;
  announcedHere.set(row.id, a.ts);
  const prefs = notifyPrefs();
  if (!dueDesktopNotify(row.id, a.kind, a.ts, now, prefs)) return false;
  const name = row.title || `session ${row.id.slice(0, 8)}`;
  const who = row.agent && row.agent !== 'claude' ? `${row.agent} · ` : '';
  return desktopNotify(`OAK: ${name}`, `${who}${attentionLabel(a.kind)}${a.message ? ` — ${a.message}` : ''}`, { sound: prefs.sound, urgent: a.kind === 'permission' }).sent;
}

/** The sessions waiting on the reader, most urgent first, oldest first within a kind. `idle-done` rows
 *  come last and only when asked for — a finished turn is a quiet fact, not a hand. */
export type WithHand<T extends { attention: unknown }> = T & { attention: NonNullable<T['attention']> };

export function rankedHands<T extends { id: string; attention: { kind: HandKind; ts: number } | null }>(rows: readonly T[], includeDone = false): WithHand<T>[] {
  return rows
    .filter((r): r is WithHand<T> => !!r.attention && (includeDone || r.attention.kind !== 'idle-done'))
    .sort((a, b) => HAND_RANK[a.attention.kind] - HAND_RANK[b.attention.kind] || a.attention.ts - b.attention.ts);
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
}

export interface Inbox {
  hands: InboxRow[];
  /** The id `nextAttention` would jump to from nowhere — the top of the list. */
  next: string | null;
  generatedAt: number;
}

/** Every raised hand across this machine's sessions, ranked — what `oak inbox`, the terminal app's `i`
 *  overlay and both editors' "Needs you" groups render. */
export function attentionInbox(cwd: string, opts: { includeDone?: boolean; now?: number } = {}): Inbox {
  const now = opts.now ?? Date.now();
  const meta = sessionMeta(cwd);
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
  return { hands, next: nextAttention(meta.sessions, null), generatedAt: now };
}
