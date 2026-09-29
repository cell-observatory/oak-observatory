/**
 * Remote Control session titles — the names claude.ai and the Claude app show.
 *
 * With Remote Control on, Claude Code keeps each conversation's name on claude.ai: it sends a title it
 * derives from the conversation, a person may rename it there, and it never writes that name back
 * locally (only a rename returns, as a `custom-title` record). So the phone and OAK named one session
 * two different things. This module keeps the account's titles in a small cache
 * under the store, keyed by Remote Control session id; a transcript's `bridge-session` record links a
 * session to its entry.
 *
 * READS ARE CACHE-ONLY: no listing, paint or `--json` read touches the network. A refresh is one bounded
 * pass over the account's code-session list — detached (`oak titles --refresh`, kicked by the same
 * 60-second pollers that keep account usage live) or, in VS Code, in the extension host like the usage
 * pull. It is throttled, locked so refreshes never stack, and safe to SIGKILL: a dead owner's lock is
 * reclaimed. It sends the claude.ai OAuth token the usage pull already reads (the same read-and-refresh
 * path, never a copy of it) to api.anthropic.com. `oak titles --off` turns it off.
 */
import * as fs from 'fs';
import * as path from 'path';
import { rootDir } from './store';
import { readPrefs, prefsPath } from './prefs';
import { claudeAccessToken } from './accountUsage';
import { spawnTool } from './spawn';
import { oakCliEntry } from './cli-entry';
import { relTime } from './format';
import type { Check } from './diagnose';

const LIST_URL = 'https://api.anthropic.com/v1/code/sessions';
/** A refresh runs at most this often. Titles change when a session is renamed or re-titled — rarely. */
export const REMOTE_TITLES_REFRESH_MS = 5 * 60_000;
/** Every page (to DEEP_PAGES) at most this often; between full passes only the newest page, because
 *  the list is ordered by recent activity and the sessions whose titles can still change lead it. */
const DEEP_PASS_MS = 24 * 60 * 60_000;
const DEEP_PAGES = 10; // Claude Code's own list reads at most ten pages of a hundred
const REQUEST_TIMEOUT_MS = 15_000;
/** One kick per minute across every poller, so the window before the child takes its lock stays quiet. */
const CLAIM_MS = 60_000;

export type RemoteTitlesStatus = 'ok' | 'auth' | 'no-login' | 'error';

export interface RemoteTitlesCache {
  version: 1;
  /** Titles by Remote Control session id WITHOUT its `cse_` / `session_` prefix: the transcript and the
   *  list spell the same session with different prefixes. */
  titles: Record<string, string>;
  /** Last successful read, 0 when none has succeeded. */
  fetchedAt: number;
  /** Last complete pass over every page. */
  deepAt: number;
  /** Last attempt, successful or not — the throttle's anchor. */
  attemptedAt: number;
  status?: RemoteTitlesStatus;
  error?: string;
}

export const remoteTitlesCachePath = (): string => path.join(rootDir(), 'remote-cache', 'session-titles.json');
const lockPath = (): string => `${remoteTitlesCachePath()}.lock`;
const claimPath = (): string => `${remoteTitlesCachePath()}.kick`;

/** The id without its prefix — `cse_X` and `session_X` are one session. Null for anything else. */
export function bridgeTitleKey(id: string): string | null {
  const m = /^(?:cse|session)_([A-Za-z0-9_-]+)$/.exec(id);
  return m ? m[1] : null;
}

/** Claude Code's own list hides these placeholder names (pooled and warming sessions). */
function placeholderTitle(t: string): boolean {
  return t.includes('__CBU_POOLED__') || t === '__warming__' || t.startsWith('ditto:');
}

export function remoteTitlesEnabled(): boolean {
  return readPrefs().remoteTitles !== false;
}

export function readRemoteTitles(): RemoteTitlesCache {
  const empty: RemoteTitlesCache = { version: 1, titles: {}, fetchedAt: 0, deepAt: 0, attemptedAt: 0 };
  try {
    const c = JSON.parse(fs.readFileSync(remoteTitlesCachePath(), 'utf8')) as RemoteTitlesCache;
    if (c && c.version === 1 && c.titles && typeof c.titles === 'object' && !Array.isArray(c.titles)) {
      const titles: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.titles)) if (typeof v === 'string' && v) titles[k] = v;
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      return { ...empty, titles, fetchedAt: n(c.fetchedAt), deepAt: n(c.deepAt), attemptedAt: n(c.attemptedAt),
        ...(typeof c.status === 'string' ? { status: c.status } : {}), ...(typeof c.error === 'string' ? { error: c.error } : {}) };
    }
  } catch {
    /* missing or torn — no remote titles, never a network read */
  }
  return empty;
}

function statKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}
let memo: { key: string; enabled: boolean; titles: Record<string, string> } | null = null;

/**
 * The claude.ai title of a Remote Control session, from the cache only; null when it is off, unknown or
 * not a Remote Control id. Called once per listed row, so the cache and the preference are re-read only
 * when their files change (two stats per call).
 */
export function remoteSessionTitle(bridgeSessionId: string | null | undefined): string | null {
  const key = bridgeSessionId ? bridgeTitleKey(bridgeSessionId) : null;
  if (!key) return null;
  const file = remoteTitlesCachePath();
  const stamp = `${file}|${statKey(file)}|${statKey(prefsPath())}`;
  if (!memo || memo.key !== stamp) memo = { key: stamp, enabled: remoteTitlesEnabled(), titles: readRemoteTitles().titles };
  return memo.enabled ? memo.titles[key] ?? null : null;
}

function writeCache(cache: RemoteTitlesCache): void {
  const file = remoteTitlesCachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 }); // titles are conversation content
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A refresher holds the lock: a live pid, or a lock too young to carry one yet. A lock older than a
 *  whole refresh is stale whoever holds it — an in-host refresher's pid outlives its refresh. (File
 *  ages are wall-clock facts, so this reads the real clock, never an injected one.) */
function refreshRunning(): boolean {
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(lockPath()).mtimeMs;
  } catch {
    return false;
  }
  if (age > remoteTitlesDeadlineMs()) return false;
  try {
    const { pid } = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  } catch {
    return age < 5_000; // the owner may be between creating the lock and writing its pid
  }
}

function takeLock(): boolean {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(lockPath(), 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || refreshRunning()) return false;
    fs.rmSync(lockPath(), { force: true }); // a SIGKILLed or hung owner's lock
    try {
      fd = fs.openSync(lockPath(), 'wx', 0o600);
    } catch {
      return false;
    }
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  fs.closeSync(fd);
  return true;
}

/** How long a refresh may take in all: every page timing out, plus a token refresh and slack. The
 *  detached command exits at this deadline whatever an inherited handle is doing. */
export function remoteTitlesDeadlineMs(): number {
  return DEEP_PAGES * REQUEST_TIMEOUT_MS + 10_000;
}

/** Due, and claimed for this caller: on, not refreshed within the throttle, nobody refreshing, and no
 *  other poller kicked one in the last minute. The claim is what keeps many pollers to one refresh. */
export function claimRemoteTitlesRefresh(now = Date.now()): boolean {
  try {
    try {
      if (Date.now() - fs.statSync(claimPath()).mtimeMs < CLAIM_MS) return false; // the cheapest refusal first
    } catch {
      /* no claim standing */
    }
    if (!remoteTitlesEnabled()) return false;
    if (now - readRemoteTitles().attemptedAt < REMOTE_TITLES_REFRESH_MS || refreshRunning()) return false;
    fs.mkdirSync(path.dirname(claimPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(claimPath(), String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false; // cannot claim ⇒ do not refresh — an unwritable store must not become a fetch storm
  }
}

/** Start a detached `oak titles --refresh --if-due` when one is due. `cli` is the oak CLI entry the CLI
 *  registered at startup (`setOakCliEntry`; the terminal dashboard runs inside it); a process with none
 *  registered starts nothing. Never blocks, never throws. */
export function kickRemoteTitles(cli: string | undefined = oakCliEntry()): void {
  try {
    if (!cli || !claimRemoteTitlesRefresh()) return;
    const child = spawnTool(process.execPath, [cli, 'titles', '--refresh', '--if-due'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* the titles stay as cached until the next poll */
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

export interface RemoteTitlesRefreshOptions {
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** Injected in tests; the usage pull's read-and-refresh path otherwise. */
  token?: () => Promise<{ token: string | null; loggedIn: boolean }>;
  now?: () => number;
  /** Ignore the throttle (a person asked for it). The lock still holds. */
  force?: boolean;
}

/**
 * One bounded refresh. Returns the cache it wrote, or null when it did not run (off, another refresh
 * holds the lock, or one ran within the throttle). Failure keeps every cached title and records why:
 * `no-login` (no claude.ai login here), `auth` (the login was refused), `error` (network, server).
 */
export async function refreshRemoteTitles(opts: RemoteTitlesRefreshOptions = {}): Promise<RemoteTitlesCache | null> {
  try {
    if (!remoteTitlesEnabled() || !takeLock()) return null;
  } catch {
    return null; // an unwritable store: nothing to refresh into
  }
  const now = opts.now ?? Date.now;
  try {
    const cache = readRemoteTitles();
    // Recheck under the lock: two pollers can both have read an overdue stamp.
    if (!opts.force && now() - cache.attemptedAt < REMOTE_TITLES_REFRESH_MS) return null;
    const deep = !cache.deepAt || now() - cache.deepAt >= DEEP_PASS_MS;
    const got: Record<string, string> = {};
    let status: RemoteTitlesStatus = 'ok';
    let error: string | undefined;
    let complete = false;
    const auth = await (opts.token ?? claudeAccessToken)();
    if (!auth.token) {
      status = auth.loggedIn ? 'auth' : 'no-login';
      error = auth.loggedIn ? 'token refresh failed' : 'no credentials';
    } else {
      const doFetch = opts.fetch ?? fetch;
      const base = process.env.OAK_CODE_SESSIONS_URL || LIST_URL;
      let cursor: string | null = null;
      for (let page = 0; page < (deep ? DEEP_PAGES : 1); page++) {
        try {
          const url = `${base}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const res = await doFetch(url, {
            // The headers Claude Code's own session list sends.
            headers: {
              Authorization: `Bearer ${auth.token}`,
              'Content-Type': 'application/json',
              'anthropic-version': '2023-06-01',
              'anthropic-client-platform': 'claude_code_cli',
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!res.ok) {
            status = res.status === 401 || res.status === 403 ? 'auth' : 'error';
            error = `HTTP ${res.status}`;
            break;
          }
          const body = (await res.json()) as { data?: unknown; next_cursor?: unknown };
          if (!Array.isArray(body?.data)) {
            status = 'error';
            error = 'unexpected answer (no session list)';
            break;
          }
          for (const row of body.data as { id?: unknown; title?: unknown }[]) {
            const key = typeof row?.id === 'string' ? bridgeTitleKey(row.id) : null;
            const title = typeof row?.title === 'string' ? row.title.replace(/\s+/g, ' ').trim() : '';
            if (key && title && !placeholderTitle(title)) got[key] = title;
          }
          cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
          if (!cursor) {
            complete = true;
            break;
          }
        } catch (e) {
          status = 'error';
          error = String((e as Error)?.name === 'TimeoutError' ? 'timed out' : (e as Error)?.message || e).slice(0, 120);
          break;
        }
      }
    }
    const t = now();
    const ok = status === 'ok';
    const next: RemoteTitlesCache = {
      version: 1,
      // A complete pass is the whole account, so titles of deleted sessions drop out; anything less
      // merges, because a session beyond the pages read is not a session that stopped existing.
      titles: ok && deep && complete ? got : { ...cache.titles, ...got },
      fetchedAt: ok ? t : cache.fetchedAt,
      deepAt: ok && deep ? t : cache.deepAt,
      attemptedAt: t,
      status,
      ...(error ? { error } : {}),
    };
    writeCache(next);
    return next;
  } catch {
    return null; // silent for titles: the cached ones stand, and `oak doctor` reports the last outcome
  } finally {
    fs.rmSync(lockPath(), { force: true });
    memo = null;
  }
}

/** `oak doctor`'s row: whether the titles OAK shows can match claude.ai's, and when they last did. */
export function diagnoseRemoteTitles(now = Date.now()): Check {
  const row = { id: 'remote-titles', label: 'Remote Control titles (read from claude.ai)' };
  if (!remoteTitlesEnabled())
    return { ...row, level: 'ok', detail: 'off (prefs remoteTitles: false): sessions are named from their transcripts only' };
  const c = readRemoteTitles();
  const count = Object.keys(c.titles).length;
  const last = c.fetchedAt ? `last read ${relTime(c.fetchedAt, now)}, ${count} title(s) cached` : 'nothing read yet';
  if (!c.attemptedAt)
    return { ...row, level: 'ok', detail: 'never refreshed: the terminal dashboard, either editor or `oak usage` starts one within a minute; `oak titles --refresh` runs one now' };
  if (c.status === 'ok') return { ...row, level: 'ok', detail: last };
  if (c.status === 'no-login')
    return { ...row, level: 'ok', detail: `no claude.ai login on this machine, so there is nothing to read (${last})` };
  if (c.status === 'auth')
    return { ...row, level: 'warn', detail: `the claude.ai login needs renewing (${c.error ?? 'unauthorized'}) at ${relTime(c.attemptedAt, now)}; sessions keep their local titles (${last})`,
      fix: 'sign in again in Claude Code (/login), then run `oak titles --refresh`' };
  return { ...row, level: 'warn', detail: `the last refresh failed (${c.error ?? 'unknown error'}) at ${relTime(c.attemptedAt, now)}; sessions keep their cached titles (${last})`,
    fix: 'check the network, then run `oak titles --refresh`' };
}
