/** Model-free, account-bound quota reads from an owned Codex app-server connection.
 * Contract: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
 * The optional response.accountId is present in the installed 0.153.4 schema. Without it,
 * no account binding is inferred from auth.json or a historical transcript. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import type { ChildProcess } from 'child_process';
import { claudeConfigDir } from './paths';
import { codexAccountId } from './codex';
import { spawnTool } from './spawn';
import type { Check } from './diagnose';

export interface CodexAccountQuota {
  version: 1;
  source: 'app-server';
  account: string;
  snapshotMs: number;
  fivePct: number | null;
  fiveReset: number | null;
  weekPct: number | null;
  weekReset: number | null;
}
// Account caches stay beside statusline-last.json, independent of a relocated edit store.
export const codexAccountQuotaPath = (): string => path.join(claudeConfigDir(), 'codex-account-usage.json');
/** The last pull's outcome (`why` is 'ok' or the failure), as the Claude pull journals its own. */
const pullLogPath = (): string => `${codexAccountQuotaPath()}.pull-log`;
/** Epoch ms before which no pull starts: a failed read (an expired login, say) would otherwise start a
 *  `codex app-server` at every claim, about once a minute. */
const pullRetryPath = (): string => `${codexAccountQuotaPath()}.pull-retry`;
function logCodexPull(why: string): void {
  try {
    fs.writeFileSync(pullLogPath(), JSON.stringify({ at: Date.now(), why }), { mode: 0o600 });
    if (why !== 'ok') fs.writeFileSync(pullRetryPath(), String(Date.now() + 5 * 60_000), { mode: 0o600 });
  } catch { /* diagnostics never block the pull */ }
}

/** Validate local and remote caches with the same identity, shape, and freshness rules. */
export function validCodexAccountQuota(value: unknown, account: string | null, now = Date.now(), maxAgeMs = 30 * 60_000): value is CodexAccountQuota {
  if (!value || typeof value !== 'object' || !account) return false;
  const q = value as CodexAccountQuota;
  if (q.version !== 1 || q.source !== 'app-server' || q.account !== account || !Number.isFinite(q.snapshotMs) || q.snapshotMs > now + 5000 || now - q.snapshotMs > maxAgeMs) return false;
  for (const [pct, reset] of [[q.fivePct, q.fiveReset], [q.weekPct, q.weekReset]]) {
    if (pct !== null && (!Number.isFinite(pct) || pct < 0)) return false;
    if (reset !== null && (!Number.isFinite(reset) || reset <= 0)) return false;
  }
  // A window's reset cannot be further out than the window itself (+ a margin): a 5-hour window
  // resets within ~6h, a weekly within ~8 days. Codex 0.154's monthly window (43200 min, ~30-day
  // reset) written into the weekly slot by an older/not-yet-reloaded build is rejected HERE at read
  // time — so a stale cache or a running pre-fix editor cannot surface a 30-day "weekly" reset.
  if (q.fiveReset !== null && q.fiveReset > now + 6 * 3600_000) return false;
  if (q.weekReset !== null && q.weekReset > now + 8 * 86400_000) return false;
  return q.fivePct !== null || q.weekPct !== null;
}

export function cachedCodexAccountQuota(now = Date.now(), maxAgeMs = 30 * 60_000): CodexAccountQuota | null {
  try {
    const q: unknown = JSON.parse(fs.readFileSync(codexAccountQuotaPath(), 'utf8'));
    return validCodexAccountQuota(q, codexAccountId(), now, maxAgeMs) ? q : null;
  } catch { return null; }
}

/** Only the quota response's backend-supplied identity authorizes publication. */
export function parseCodexAccountQuota(result: unknown, expectedAccount: string, now = Date.now()): CodexAccountQuota | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { accountId?: unknown; rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> };
  if (typeof r.accountId !== 'string' || !r.accountId) return null;
  const account = createHash('sha256').update(r.accountId).digest('hex').slice(0, 16);
  if (account !== expectedAccount) return null;
  const bucket = (r.rateLimitsByLimitId ? r.rateLimitsByLimitId.codex : r.rateLimits) as Record<string, unknown> | undefined;
  if (!bucket || (bucket.limitId != null && bucket.limitId !== 'codex')) return null;
  const q: CodexAccountQuota = { version: 1, source: 'app-server', account, snapshotMs: now,
    fivePct: null, fiveReset: null, weekPct: null, weekReset: null };
  for (const key of ['primary', 'secondary']) {
    const w = bucket[key] as { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
    if (!w || !Number.isFinite(w.usedPercent) || !Number.isFinite(w.windowDurationMins) || !Number.isFinite(w.resetsAt)) continue;
    if (w.usedPercent! < 0 || w.windowDurationMins! <= 0 || w.resetsAt! * 1000 <= now) continue;
    // Bound the weekly band to ~a week (1 day .. 2 weeks). Codex 0.154 added a MONTHLY window
    // (~43200 min); the old ">= a day is weekly" rule put its ~30-day reset in the weekly slot.
    // Longer windows are the monthly one, which this quota does not track (month = transcript scan).
    if (w.windowDurationMins! >= 1440 && w.windowDurationMins! < 20160) { q.weekPct = w.usedPercent!; q.weekReset = w.resetsAt! * 1000; }
    else if (w.windowDurationMins! < 1440) { q.fivePct = w.usedPercent!; q.fiveReset = w.resetsAt! * 1000; }
  }
  return validCodexAccountQuota(q, expectedAccount, now) ? q : null;
}

/** A bounded read-only RPC exchange. Never creates a thread, starts a turn, or approves a request.
 *  `onFail` hears why a read returned nothing. */
export function readCodexAccountQuotaOverChild(child: ChildProcess, account: string, timeoutMs = 12_000, ownedGroup = false,
  onFail: (why: string) => void = () => {}): Promise<CodexAccountQuota | null> {
  if (child.exitCode !== null || child.signalCode !== null) { onFail('codex app-server had already exited'); return Promise.resolve(null); }
  return new Promise(resolve => {
    let buffer = '', bytes = 0, done = false, initialized = false, result: CodexAccountQuota | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (force: boolean): void => {
      try {
        if (ownedGroup && child.pid && process.platform !== 'win32') process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else if (ownedGroup && child.pid && process.platform === 'win32') {
          const killer = spawnTool('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
        } else child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch { /* already exited */ }
    };
    const finish = (value: CodexAccountQuota | null, why = ''): void => {
      if (done) return;
      done = true; result = value; clearTimeout(timer);
      if (!value) onFail(why);
      child.stdin?.end(); stop(false);
      killTimer = setTimeout(() => stop(true), 500); killTimer.unref();
    };
    const said = (error: unknown): string => String((error as { message?: unknown })?.message ?? JSON.stringify(error)).slice(0, 200);
    const timer = setTimeout(() => finish(null, `no answer within ${timeoutMs / 1000}s`), timeoutMs);
    child.once('close', () => { finish(null, 'codex app-server exited before answering'); clearTimeout(timer); clearTimeout(killTimer); resolve(result); });
    child.once('error', (e) => finish(null, `could not start codex app-server: ${said(e)}`));
    child.stdin?.on('error', (e) => finish(null, `codex app-server input: ${said(e)}`));
    child.stderr?.resume();
    const send = (message: object): void => { child.stdin?.write(JSON.stringify(message) + '\n'); };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
      if (done) return;
      bytes += Buffer.byteLength(data); if (bytes > 1024 * 1024) return finish(null, 'codex app-server answered more than 1 MB');
      buffer += data;
      for (let at; (at = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== 'object') continue;
        // Notifications are ignored. `account/updated` names no account (Codex 0.156.1 sends it for the
        // same login on every connection), so identity rests on the reply's accountId and the caller's
        // post-read login check.
        if (message.id === 1 && !initialized) {
          if (message.error || !message.result) return finish(null, `initialize failed: ${message.error ? said(message.error) : 'no result'}`);
          initialized = true;
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2 && initialized) {
          if (message.error) return finish(null, `account/rateLimits/read failed: ${said(message.error)}`);
          const quota = parseCodexAccountQuota(message.result, account);
          return finish(quota, 'the answer named another account, or no Codex rate limits');
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'oak_usage', version: '1' } } });
  });
}

export async function pullCodexAccountUsage(): Promise<boolean> {
  const account = codexAccountId();
  if (!account) return false;
  // The cost here is the `codex app-server` child. Quota windows move slowly, so skip the spawn while
  // the account-bound cache is still fresh — otherwise a stale CLAUDE cache (the usual pull trigger)
  // spawns a codex child every ~60s even though the codex quota has not moved.
  if (cachedCodexAccountQuota(Date.now(), 4 * 60_000)) return false;
  try { if (Date.now() < Number(fs.readFileSync(pullRetryPath(), 'utf8'))) return false; } catch { /* no backoff */ }
  try {
    const child = spawnTool(process.env.CODEX_PATH || 'codex', ['app-server'], {
      cwd: os.tmpdir(), env: { ...process.env }, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const quota = await readCodexAccountQuotaOverChild(child, account, 12_000, true, logCodexPull);
    if (!quota) return false;
    if (codexAccountId() !== account) { logCodexPull('the Codex login changed during the read'); return false; }
    fs.mkdirSync(claudeConfigDir(), { recursive: true, mode: 0o700 });
    const dest = codexAccountQuotaPath(), tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(quota), { mode: 0o600 }); fs.renameSync(tmp, dest);
    logCodexPull('ok');
    return true;
  } catch (e) { logCodexPull(`could not read the quota: ${String((e as Error)?.message ?? e).slice(0, 200)}`); return false; }
}

/** Doctor's word on the GPT quota bars: null while there is no Codex login or no read yet. A failed
 *  read otherwise leaves the bars blank with nothing saying why. */
export function diagnoseCodexQuota(now = Date.now()): Check | null {
  if (!codexAccountId()) return null;
  let last: { at?: unknown; why?: unknown };
  try { last = JSON.parse(fs.readFileSync(pullLogPath(), 'utf8')); } catch { return null; }
  const row = { id: 'codex-quota', label: 'Codex quota (the GPT usage bars)' };
  const { relTime } = require('./format') as typeof import('./format'); // lazy: format loads the store
  const when = typeof last.at === 'number' ? ` (${relTime(last.at, now)})` : '';
  if (last.why === 'ok') return { ...row, level: 'ok', detail: `last read from codex app-server${when}` };
  return { ...row, level: 'warn', detail: `the last read failed${when}: ${String(last.why)}; the GPT bars stay empty until one succeeds`,
    fix: 'if the Codex login expired (a 401 or "expired" above), run `codex login`; OAK retries within 5 minutes' };
}
