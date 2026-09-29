// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cell Observatory
/**
 * Direct account-usage pull — the same endpoint the Claude desktop app reads.
 *
 * This is what keeps the 5h/weekly/fable numbers live WITHOUT an open claude session (the
 * panel used to say "keep an idle claude terminal open"): every `oak usage` poll kicks a
 * detached `oak usage --pull-account` when the statusline cache has gone quiet, and this module
 * does ONE bounded fetch and merges the result into the cache every reader already trusts —
 * the terminal statusline, the TUI, and both editors keep their single source.
 *
 * Credentials: the credentials file, else the macOS keychain item Claude Code writes (the first
 * keychain read may ask once — "Always Allow" makes it permanent). Silent on any failure: no
 * credentials simply leaves the cache to the next live claude render.
 */

import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { spawnToolSync, spawnTool } from './spawn';
import { withFileMutation } from './store';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
// Claude Code's own OAuth token endpoint and PUBLIC client id (both read out of the shipped
// binary, 2026-09-09). Refreshing here is what claude itself does when its access token lapses;
// the rotated credentials are written back in the same shape, so claude's own login chain keeps
// working. Without this, a machine that has not run a claude session for some hours holds only
// an expired access token — the measured macOS keychain failure ("keychain-token-expired").
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

interface OauthCreds {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [k: string]: unknown;
}
interface CredsBlob {
  claudeAiOauth?: OauthCreds;
  [k: string]: unknown;
}

/** One-line outcome journal for the last pull attempt — the puller is a detached, stdio-less
 *  child, and without this a failure is indistinguishable from never running (measured on the
 *  Mac, 2026-09-09: kicks fired every minute, the cache never moved, nothing said why). */
function logPull(cfg: string, why: string): void {
  try {
    fs.writeFileSync(
      path.join(cfg, 'statusline-last.json.pull-log'),
      JSON.stringify({ at: Math.floor(Date.now() / 1000), why, exec: process.execPath }),
      { mode: 0o600 }
    );
  } catch {
    /* diagnostics never block the pull */
  }
}

/** Epoch ms before which no pull should be attempted — set after a rate-limit/server refusal so the
 *  endpoint is not hammered every ~60s (the detached pull otherwise retries at the claim cadence and
 *  burns a node + codex app-server child each time). A plain marker file, no cache read-merge race. */
function pullBackoffUntil(cfg: string): number {
  try { const n = Number(fs.readFileSync(path.join(cfg, 'statusline-last.json.pull-retry'), 'utf8')); return Number.isFinite(n) ? n : 0; }
  catch { return 0; }
}
function setPullBackoff(cfg: string, ms: number): void {
  try { fs.writeFileSync(path.join(cfg, 'statusline-last.json.pull-retry'), String(Date.now() + ms), { mode: 0o600 }); } catch { /* best effort */ }
}

/** The credentials blob + where it lives, so a refresh can write the rotation BACK there. */
function readCreds(cfg: string): { blob: CredsBlob; source: 'file' | 'keychain'; account: string | null } | null {
  const fp = path.join(cfg, '.credentials.json');
  try {
    const blob = JSON.parse(fs.readFileSync(fp, 'utf8')) as CredsBlob;
    if (blob && typeof blob === 'object') return { blob, source: 'file', account: null };
  } catch {
    /* no file — try the keychain below */
  }
  if (process.platform === 'darwin') {
    try {
      const r = spawnToolSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8',
        timeout: 8000,
      });
      if (r.status === 0) {
        const blob = JSON.parse(String(r.stdout || '')) as CredsBlob;
        let account: string | null = null;
        try {
          const attrs = spawnToolSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
            encoding: 'utf8',
            timeout: 8000,
          });
          const m = /"acct"<blob>="([^"]*)"/.exec(String(attrs.stdout || ''));
          if (m) account = m[1];
        } catch {
          /* account attr is only needed for the write-back; try without */
        }
        return { blob, source: 'keychain', account };
      }
      logPull(cfg, `keychain-status-${r.status}${r.stderr ? `:${String(r.stderr).trim().slice(0, 80)}` : ''}`);
      return null;
    } catch (e) {
      logPull(cfg, `keychain-threw:${String((e as Error)?.message ?? e).slice(0, 80)}`);
      return null;
    }
  }
  logPull(cfg, 'no-credentials-file');
  return null;
}

function persistCreds(cfg: string, src: { source: 'file' | 'keychain'; account: string | null }, blob: CredsBlob): boolean {
  if (src.source === 'file') {
    try {
      // Atomic write-back: this file holds the ONLY copy of the rotated refresh token, so a crash
      // between a truncate and the write would strand claude's own login. Write a fresh 0600 temp and
      // rename onto the target (the rename, not the writeFileSync mode, is what makes it 0600 — mode is
      // ignored when an existing file is overwritten in place). realpathSync resolves a symlinked
      // credentials file so we replace the real file and keep the link.
      const fp = path.join(cfg, '.credentials.json');
      let target = fp;
      try { target = fs.realpathSync(fp); } catch { /* absent or not a link — write fp directly */ }
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
      fs.renameSync(tmp, target);
      return true;
    } catch {
      return false;
    }
  }
  try {
    // -U updates the existing item in place, same service + account claude reads. The blob carries the
    // refresh token, so it goes on stdin to `security -i` (hex, via -X), never as an argument any local
    // user can read in `ps`. Claude Code writes its own item the same way, and like it, falls back to
    // arguments only for a line longer than the 4032 bytes `security -i` reads.
    const hex = Buffer.from(JSON.stringify(blob), 'utf8').toString('hex');
    if (!/^[0-9a-f]+$/.test(hex)) return false; // hex by construction: never anything a command line could read as more
    const line = `add-generic-password -U -a "${src.account ?? ''}" -s "Claude Code-credentials" -X "${hex}"\n`;
    const r = line.length <= 4032
      ? spawnToolSync('security', ['-i'], { input: line, encoding: 'utf8', timeout: 8000 })
      : spawnToolSync('security', ['add-generic-password', '-U', '-a', src.account ?? '', '-s', 'Claude Code-credentials', '-X', hex], { encoding: 'utf8', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Refresh an expired access token the way claude does, and write the rotation back. */
async function refreshOauth(
  cfg: string,
  src: { blob: CredsBlob; source: 'file' | 'keychain'; account: string | null }
): Promise<string | null> {
  const c = src.blob.claudeAiOauth;
  if (!c?.refreshToken) {
    logPull(cfg, 'refresh-no-refresh-token');
    return null;
  }
  try {
    const res = await fetch(process.env.OAK_OAUTH_TOKEN_URL || TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logPull(cfg, `refresh-http-${res.status}`);
      if (res.status === 429 || res.status === 503 || res.status === 529) setPullBackoff(cfg, 5 * 60_000);
      return null;
    }
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!j.access_token) {
      logPull(cfg, 'refresh-no-access-in-answer');
      return null;
    }
    const updated: CredsBlob = {
      ...src.blob,
      claudeAiOauth: {
        ...c,
        accessToken: j.access_token,
        ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
        expiresAt: Date.now() + Math.max(60, j.expires_in ?? 3600) * 1000,
      },
    };
    // Claude Code refreshes under a lock OAK cannot take. If it rotated the refresh token while this
    // request was in flight, its write is the newer one: keep it rather than overwrite it. (Only a
    // token we positively read counts; an unreadable store still gets the write-back below.)
    const stored = readCreds(cfg);
    if (stored && stored.blob.claudeAiOauth?.refreshToken !== c.refreshToken) {
      logPull(cfg, 'refresh-kept-newer-write');
      return j.access_token;
    }
    // Persist BEFORE using: a rotated refresh token that is not written back would strand
    // claude's own login chain. A failed persist is journalled loudly; the fresh access token
    // still serves this one pull.
    if (!persistCreds(cfg, src, updated)) logPull(cfg, 'refresh-persist-FAILED');
    else logPull(cfg, 'refresh-ok');
    return j.access_token;
  } catch (e) {
    logPull(cfg, `refresh-threw:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    return null;
  }
}

async function accessToken(cfg: string, src = readCreds(cfg)): Promise<string | null> {
  if (!src) return null;
  const c = src.blob.claudeAiOauth;
  if (!c?.accessToken) {
    logPull(cfg, 'creds-without-oauth');
    return null;
  }
  // A minute of slack: a token about to lapse mid-flight is as good as lapsed.
  if ((c.expiresAt ?? 0) > Date.now() + 60_000) return String(c.accessToken);
  return refreshOauth(cfg, src);
}

/** The claude.ai access token for OAK's other account read (Remote Control titles): this same
 *  read-and-refresh path, never a second copy of it. `loggedIn` is false when this machine holds no
 *  claude.ai login at all, so the caller can tell "nothing to read" from "the login needs renewing". */
export async function claudeAccessToken(): Promise<{ token: string | null; loggedIn: boolean }> {
  const cfg = claudeConfigDir();
  const src = readCreds(cfg);
  return { token: await accessToken(cfg, src), loggedIn: !!src?.blob.claudeAiOauth?.accessToken };
}

interface ApiWindow {
  utilization?: number | null;
  resets_at?: string | number | null;
}
interface ApiLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | number | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}
export interface AccountUsageApi {
  five_hour?: ApiWindow | null;
  seven_day?: ApiWindow | null;
  limits?: ApiLimit[] | null;
}

function epochSec(v: string | number | null | undefined): number | null {
  if (typeof v === 'number' && isFinite(v) && v > 0) return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return isNaN(t) ? null : Math.round(t / 1000);
  }
  return null;
}

/**
 * The pure merge, tested directly: the API payload onto the cache object. Only the fields the
 * account actually answers are touched — everything else in the cache (session context, ledger,
 * calibration inputs, schema version) passes through untouched. Returns null when the payload
 * carries no rolling windows at all (Enterprise/API keys), so the caller writes nothing.
 */
export function applyAccountUsage(
  cache: Record<string, unknown>,
  api: AccountUsageApi,
  nowSec = Math.floor(Date.now() / 1000)
): Record<string, unknown> | null {
  const p5 = api.five_hour?.utilization;
  const p7 = api.seven_day?.utilization;
  const r5 = epochSec(api.five_hour?.resets_at);
  const r7 = epochSec(api.seven_day?.resets_at);
  if (p5 == null && p7 == null && r5 == null && r7 == null) return null;
  const out: Record<string, unknown> = { ...cache };
  if (typeof p5 === 'number' && isFinite(p5)) { out.five_pct = p5; out.five_at = nowSec; }
  if (typeof p7 === 'number' && isFinite(p7)) { out.week_pct = p7; out.week_at = nowSec; }
  if (r5 !== null) out.five_reset = r5;
  if (r7 !== null) out.week_reset = r7;
  const fb = (api.limits ?? []).find((l) => l?.kind === 'weekly_scoped');
  if (fb && typeof fb.percent === 'number') {
    out.fable_pct = fb.percent;
    out.fable_at = nowSec;
    const fr = epochSec(fb.resets_at);
    if (fr !== null) out.fable_reset = fr;
    const lbl = fb.scope?.model?.display_name;
    if (typeof lbl === 'string' && lbl) out.fable_label = lbl;
  }
  // ts is what the staleness banner keys on: the 5h/week figures ARE fresh now. The context
  // fields stay whatever they were — the editors read ctx live from the transcript anyway.
  out.ts = nowSec;
  out.api_ts = nowSec; // shares the statusline's own fetch budget — no double pulls
  return out;
}

/** One bounded pull-and-merge. True = the cache was refreshed. */
export async function pullAccountUsage(): Promise<boolean> {
  const cfg = claudeConfigDir();
  if (Date.now() < pullBackoffUntil(cfg)) { logPull(cfg, 'backoff'); return false; } // honor a recent 429
  const tok = await accessToken(cfg);
  if (!tok) return false; // accessToken already journalled why
  let api: AccountUsageApi;
  try {
    const res = await fetch(process.env.OAK_USAGE_API_URL || API_URL, {
      headers: { Authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      logPull(cfg, `http-${res.status}`);
      if (res.status === 429 || res.status === 503 || res.status === 529) setPullBackoff(cfg, 5 * 60_000);
      return false;
    }
    api = (await res.json()) as AccountUsageApi;
  } catch (e) {
    logPull(cfg, `fetch:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    return false;
  }
  const cachePath = path.join(cfg, 'statusline-last.json');
  let cache: Record<string, unknown> = {};
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (j && typeof j === 'object') cache = j as Record<string, unknown>;
  } catch {
    /* first write — the merge starts from an empty cache */
  }
  const merged = applyAccountUsage(cache, api);
  if (!merged) {
    logPull(cfg, 'no-windows-in-answer');
    return false;
  }
  // Old versions labelled historical Codex snapshots with the CURRENT login's fingerprint.
  // That cannot establish event ownership after an account switch. Remove those exports on
  // refresh; native rollouts need trustworthy account provenance before quota can be shared.
  for (const key of ['gpt_ts', 'gpt_account', 'gpt_five_pct', 'gpt_five_reset', 'gpt_week_pct', 'gpt_week_reset']) delete merged[key];
  try {
    const tmp = `${cachePath}.pull.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
    fs.renameSync(tmp, cachePath);
    logPull(cfg, 'ok');
    return true;
  } catch (e) {
    logPull(cfg, `write:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    return false;
  }
}

/** Independent provider reads: Codex quota refresh does not require a Claude subscription. */
export async function pullProviderAccountUsage(): Promise<boolean> {
  const { pullCodexAccountUsage } = require('./codex-account') as typeof import('./codex-account');
  const results = await Promise.allSettled([pullAccountUsage(), pullCodexAccountUsage()]);
  return results.some(r => r.status === 'fulfilled' && r.value);
}

/**
 * The cross-process claim is due when the cache is quiet for
 * `maxAgeMs` (or absent), and at most one puller per `claimMs` across every surface that polls.
 */
export function dueAccountUsagePull(maxAgeMs = 60_000, claimMs = 45_000): boolean {
  try {
    return withFileMutation(path.join(claudeConfigDir(), 'statusline-last.json.pulling'), () => claimAccountUsagePull(maxAgeMs, claimMs));
  } catch { return false; }
}

/**
 * Cross-process claim for the detached statusline MONTH refresh. The bill-cycle month (claude tokens
 * + cost) is scanned only by the statusline script, so a machine used through the editors — which
 * never run the statusline — shows a stale/zero month. `cmdUsage` kicks the script itself, throttled
 * here to at most one spawn per `claimMs` across every poller (and the statusline's own re-entrant
 * `oak usage` calls see the fresh claim and skip, so there is no spawn loop).
 */
export function dueMonthRefresh(claimMs = 5 * 60_000): boolean {
  try {
    const marker = path.join(claudeConfigDir(), 'statusline-last.json.month-refresh');
    try { if (Date.now() - fs.statSync(marker).mtimeMs < claimMs) return false; } catch { /* no claim standing */ }
    fs.mkdirSync(claudeConfigDir(), { recursive: true });
    fs.writeFileSync(marker, String(process.pid), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * Kick the installed statusline (detached, throttled) to refresh the bill-cycle month cache, fed a
 * minimal payload. Called by every surface that shows usage but does not itself run the statusline —
 * the editors and the TUI read usage in-host, so without this a machine used only through them shows a
 * stale/zero month. The script self-throttles the actual scan and `dueMonthRefresh` caps this to one
 * spawn per interval, so it never blocks the caller or loops. `cwd` scopes the transcript scan.
 */
export function kickMonthRefresh(cwd: string): void {
  try {
    const script = path.join(claudeConfigDir(), 'statusline.sh');
    if (!fs.existsSync(script) || !dueMonthRefresh()) return;
    // The payload names the workspace, not the process's directory: on Windows the process starts at
    // home, elsewhere in the caller's directory (see spawnTool).
    const child = spawnTool('bash', [script], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    try { child.stdin?.end(JSON.stringify({ cwd })); } catch { /* no stdin to write */ }
    child.unref();
  } catch { /* best-effort — the month stays stale until the next poll */ }
}

function claimAccountUsagePull(maxAgeMs: number, claimMs: number): boolean {
  if (Date.now() < pullBackoffUntil(claudeConfigDir())) return false; // a recent 429 — don't even spawn
  const cachePath = path.join(claudeConfigDir(), 'statusline-last.json');
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { ts?: number };
    if (typeof j?.ts === 'number' && Date.now() - j.ts * 1000 < maxAgeMs) {
      const { codexAccountId } = require('./codex') as typeof import('./codex');
      const { cachedCodexAccountQuota } = require('./codex-account') as typeof import('./codex-account');
      if (!codexAccountId() || cachedCodexAccountQuota(Date.now(), maxAgeMs)) return false;
    }
  } catch {
    /* no cache yet — due */
  }
  const marker = `${cachePath}.pulling`;
  try {
    const st = fs.statSync(marker);
    if (Date.now() - st.mtimeMs < claimMs) return false; // someone else is on it
  } catch {
    /* no claim standing */
  }
  try {
    fs.mkdirSync(claudeConfigDir(), { recursive: true });
    fs.writeFileSync(marker, String(process.pid), { mode: 0o600 });
  } catch {
    return false; // cannot claim ⇒ do not pull — an unwritable dir must not become a fetch storm
  }
  return true;
}
