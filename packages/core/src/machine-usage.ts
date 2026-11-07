/**
 * Claude account usage read from saved machines.
 *
 * The 5-hour, weekly and per-model weekly shares belong to the ACCOUNT, so a machine that cannot measure
 * them itself (its account usage read fails, and no Claude session runs there to refresh them) can show the
 * reading another machine took of the same account, and the account's totals add up every machine's usage.
 *
 * THE USAGE PULL. A refresh runs `oak __usage-records --json` on each enabled saved machine over OAK's own ssh (`oak
 * usage --pull-machines`, detached, started by the same pollers as the account pull) at most every five minutes: that
 * machine's own usage rows (each message, its readings of the account's shares, its sessions' spend and its accounts)
 * written since the last pull, in pages, which go into the local index (index/usage.ts counts each message once, however
 * many machines hold it). Only usage crosses, never conversation text: the pull runs on the consent the saved machines'
 * readings always had. A machine whose record log oak sync already brings here, current, is not asked: its usage is in
 * the index with the rest of its records. An OAK there older than the pull answers `oak __usage-brief --json` instead
 * (its readings alone, as before), and so does every machine where this one has no index. Each machine's latest
 * readings, and why one gave none (`oak doctor` says so), are kept in a small cache under the store, which a process
 * with no index reads. A machine that does not answer keeps its last answer, which ages out as its shares fall behind
 * their windows. Each answer is dated against the time it arrived, so a machine whose clock is off has its stamps read by
 * this machine's clock. `"machineUsage": false` in prefs.json turns it all off: no refresh runs, and no other machine's
 * reading is taken.
 *
 * READS ARE CACHE-ONLY: no listing, paint or `--json` read waits on ssh. An answer counts only for the same
 * Claude account, which each side names by a hash of Claude Code's account id (`oauthAccount.accountUuid` in
 * its `.claude.json`), never by the id itself; a machine with no login of its own takes the one account its
 * saved machines name, and none when they name two. Which shares an answer supplies is decided in observe.ts.
 *
 * A brief from an OAK before the usage pull also carries what that machine measured of its own turns
 * (MachineUsageOwn), which this machine adds to its totals and estimates, as before the index, since no records of
 * that machine arrive (observe.ts measuredFromMachines, index/usage.ts usageTotals).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, scryptSync } from 'crypto';
import { rootDir } from './store';
import { claudeJsonPath } from './paths';
import { fileWithinLast, withinLast } from './stamp';
import { keptPrefs } from './sync-state';
import { spawnTool, noBackgroundChildren } from './spawn';
import { oakCliEntry } from './cli-entry';
import { findHerdrBin } from './herdr-install';
import { HIDDEN_SOURCE } from './hidden';
import { graphemeEnd } from './graphemes';
import type { Check } from './diagnose';

/** A refresh runs at most this often. */
const MACHINE_USAGE_REFRESH_MS = 5 * 60_000;
/** One kick per minute across every poller, so the window before the child takes its lock stays quiet. */
const CLAIM_MS = 60_000;
/** How long one machine's ssh and `oak usage --brief` may take. */
export const MACHINE_USAGE_ASK_MS = 30_000;
/** herdr's machine list, then every machine's ssh in parallel, then slack: past this the detached refresh
 *  exits whatever an inherited handle is doing, and its lock counts as stale. */
export function machineUsageDeadlineMs(): number {
  return 15_000 + MACHINE_USAGE_ASK_MS + 10_000;
}

/** One window's share as the machine that measured it reports it. `at` is when it was measured (epoch ms,
 *  that machine's clock); a share without it cannot be dated and is never used elsewhere. */
export interface MachineUsageWindow {
  pct: number;
  reset: number | null;
  at: number | null;
  /** Tokens counted in the window on that machine (`measured`), or, from a brief that counted none or an OAK before
   *  0.11.0, the estimate below. */
  tok: number | null;
  total: number | null;
  label?: string | null;
  measured?: boolean;
  /** The derived figures: the share times the estimated allowance, and that allowance. Absent before 0.11.0. */
  est?: { tok: number | null; total: number | null } | null;
}
/** The bill-cycle month as that machine's status line measures it (its own transcripts, plus what its saved
 *  machines of the account measured of their own turns: MachineUsageOwn), sent only while the cycle it was
 *  measured in is still running. */
export interface MachineUsageMonth {
  tok: number;
  total: number | null;
  reset: number | null;
  reads: number | null;
  cost: number | null;
  costTotal: number | null;
}
/** One window of what a machine's status line measured of its OWN turns (each message once, only the turns that ran
 *  under that machine's home): its tokens and cache reads, its spend (for the 5-hour and weekly windows what Claude
 *  Code reported for that machine's sessions, for the month list prices), and the window it was measured in, by the
 *  reset the scan anchored on (epoch ms). */
export interface MachineUsageOwnWindow {
  tok: number;
  reads: number | null;
  cost: number | null;
  reset: number;
}
/** What a machine measured of its own turns, which every machine of the account adds to its own to calibrate the
 *  estimates: one machine's figures are the turns that ran under its own home directory, so the sum counts a synced or
 *  forked transcript once, apart from turns that ran outside any home directory or under a home path two machines
 *  share, which each machine holding them counts (the status line's own()). */
export interface MachineUsageOwn {
  /** The first 12 hex digits of sha256 of the machine's host name and home directory (machineHostTag), so a machine
   *  saved under two targets, or this machine saved as one of its own, is added once. */
  host: string;
  /** When its status line's last scan measured them (epoch ms, that machine's clock). */
  at: number;
  five: MachineUsageOwnWindow | null;
  /** The week, with its own tokens and cache reads of the per-model cap's family. */
  week: (MachineUsageOwnWindow & { fable: number | null; fableReads: number | null }) | null;
  /** The bill cycle, which runs from `start` to `reset`. */
  month: (MachineUsageOwnWindow & { start: number }) | null;
}
/** What `oak usage --brief --json` prints: this machine's OWN Claude readings, never one it took from a saved
 *  machine, so readings are never relayed from machine to machine. */
export interface MachineUsageBrief {
  brief: 1;
  /** Claude Code's account id as claudeAccountTag hashes it; null where Claude Code has no login. */
  account: string | null;
  at: number;
  five: MachineUsageWindow | null;
  /** When its account read last answered with no 5h window (an account with no five-hour limit), and last answered with
   *  one (epoch ms, that machine's clock; null for none): every machine of the account weighs the newest of them
   *  (observe.ts noFiveHourLimitIfNewest). `five` is null while its own say there is no limit. Absent from an older OAK.
   *  For a machine the local index reads, its newest readings of each answer (index/usage.ts machineReadingEntries). */
  fiveNoneAt?: number | null;
  fiveSeenAt?: number | null;
  week: MachineUsageWindow | null;
  fable: MachineUsageWindow | null;
  month: MachineUsageMonth | null;
  /** What it measured of its own turns; null when its status line has measured none, and absent from an OAK older
   *  than this field, whose usage no machine can add to its own. `brief` stays 1: every OAK that reads briefs
   *  refuses any other, and so would read a newer machine's whole answer as no reading at all. */
  own?: MachineUsageOwn | null;
}
export interface MachineUsageEntry {
  /** herdr's label for the machine, which the readouts name, with its hidden characters dropped (plainLabel). */
  label: string;
  target: string;
  /** Its last answer; `brief.at` says when (that machine's clock). */
  brief: MachineUsageBrief;
  /** That machine's clock less this one's, from the refresh that brought `brief`: its `at` against the time the
   *  answer arrived here. It printed the brief during the ssh round trip, so the true difference lies between
   *  that and that plus `rttMs`; 0 when that range holds 0, since the clocks then agree as far as the round trip
   *  can tell. Its stamps are read as `stamp - skewMs`; 0 for an answer cached before. */
  skewMs: number;
  /** That refresh's ssh round trip (ms), the bound on skewMs; null for an answer cached before. */
  rttMs: number | null;
  /** For a window whose stamp an earlier refresh already brought, the clock difference that refresh read it with:
   *  that machine's clock may have fallen behind since (a virtual machine resumed from a pause), and a share
   *  measured before it moved forward by the whole lag when read less the new difference. */
  firstSkew?: Partial<Record<'five' | 'week' | 'fable', number>>;
  /** The machine as its usage records name it (machineHostTag), once a usage pull read them: what its records are filed
   *  under in the local index, and what tells whether oak sync brings them here already. */
  host?: string;
  /** Its last successful pull answered with readings only. Kept across failures; absent means unconfirmed or records. */
  briefOnly?: true;
}
/** What a machine's last refresh came to: 'ok', it answered with a reading; otherwise why it gave none.
 *  'unreachable': ssh could not connect or start; 'timeout': no answer within MACHINE_USAGE_ASK_MS; 'no-oak': no
 *  `oak` there; 'old-oak': an OAK there from before `__usage-brief`, which refuses it; 'not-reading': it printed
 *  something other than a reading (a shell startup file there that writes to stdout); 'failed': the command
 *  failed there for another reason; 'synced': it was not asked, since oak sync brings its records here, current. */
export type MachineUsageStatus = 'ok' | 'unreachable' | 'timeout' | 'no-oak' | 'old-oak' | 'not-reading' | 'failed' | 'synced';
const STATUSES: ReadonlySet<string> = new Set<MachineUsageStatus>(['ok', 'unreachable', 'timeout', 'no-oak', 'old-oak', 'not-reading', 'failed', 'synced']);
/** The last refresh's outcome for one machine it asked, answered or not. */
export interface MachineUsageOutcome {
  label: string;
  target: string;
  /** When the answer, or the want of one, came (this machine's clock). */
  at: number;
  status: MachineUsageStatus;
  /** One line of what ssh or the command there said, sanitized (oneLine); never more of its output. */
  detail?: string;
  /** True when its answer carried no figures of its own usage (MachineUsageBrief.own): an OAK there from before
   *  them. Set by the read that took the answer: a read by an OAK here from before them stored every answer
   *  without them, and that says nothing of the OAK there. */
  noOwn?: true;
  /** True when it answered with its readings alone, an OAK there from before the usage pull (`__usage-records`) or one
   *  whose index does not open: its shares are shown, and the totals add what it measured of its own turns. */
  briefOnly?: true;
}
export interface MachineUsageCache {
  version: 1;
  /** Last refresh, answered or not: the throttle's anchor. */
  attemptedAt: number;
  machines: MachineUsageEntry[];
  /** How each machine the last refresh asked answered; `oak doctor` reports them. */
  outcomes: MachineUsageOutcome[];
}
/** What `ask` resolves for one machine: what it printed, why it printed nothing usable (with at most one line of
 *  what ssh or that machine said, which the cache keeps sanitized), or null for no answer. */
export type MachineUsageAnswer = string | { status: Exclude<MachineUsageStatus, 'ok'>; detail?: string } | null;

export const machineUsageCachePath = (): string => path.join(rootDir(), 'remote-cache', 'machine-usage.json');
const lockPath = (): string => `${machineUsageCachePath()}.lock`;
const claimPath = (): string => `${machineUsageCachePath()}.kick`;

function statKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

let tagMemo: { key: string; tag: string | null; read: boolean } | null = null;

/** This machine's Claude account, as a 12-hex-digit hash of the account id Claude Code keeps for its login;
 *  null with no login. Re-read only when the file changes (it can be megabytes). The hash is scrypt's, with one salt for
 *  every OAK so that each machine signed in to an account names it alike; the id itself never leaves the machine. */
export function claudeAccountTag(): string | null {
  return accountMemo().tag;
}

/** No Claude Code login here: no `.claude.json`, or one that names no account. A file that could not be read or
 *  parsed (one caught mid-write) says nothing about the login, so it is not a signed-out machine. */
export function claudeSignedOut(): boolean {
  const m = accountMemo();
  return m.tag === null && m.read;
}

function accountMemo(): { tag: string | null; read: boolean } {
  const file = claudeJsonPath();
  const key = `${file}|${statKey(file)}`;
  if (tagMemo?.key === key) return tagMemo;
  let tag: string | null = null;
  let read = false;
  try {
    const id = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount?.accountUuid;
    read = true;
    if (typeof id === 'string' && id) tag = scryptSync(id, 'oak-claude-account', 6).toString('hex');
  } catch (error) {
    read = (error as NodeJS.ErrnoException).code === 'ENOENT'; // no Claude Code config here
  }
  tagMemo = { key, tag, read };
  return tagMemo;
}

let hostMemo: { key: string; tag: string } | null = null;

/** This machine, as the first 12 hex digits of sha256 of its host name and home directory: what a brief's own figures
 *  are added up by, so that one machine is never counted twice. Neither leaves the machine: only the hash does. */
export function machineHostTag(): string {
  const key = `${os.hostname()}\0${os.homedir()}`;
  if (hostMemo?.key !== key) hostMemo = { key, tag: createHash('sha256').update(key).digest('hex').slice(0, 12) };
  return hostMemo.tag;
}

const num = (v: unknown, min = 0): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : null);

/** What a label someone else typed (a saved machine's herdr label) shows without: the C0 and C1 controls (ESC,
 *  BEL, TAB), the bidirectional controls, which reorder the text around them (U+061C, U+200E, U+200F,
 *  U+202A-U+202E, U+2066-U+2069), the zero-width characters that hide inside it (U+200B, U+FEFF, U+2060-U+2064,
 *  U+206A-U+206F), the line and paragraph separators (U+2028, U+2029), the soft hyphen and the Khmer inherent vowels
 *  (U+00AD, U+17B4, U+17B5), the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the tag characters outside a
 *  flag (U+E0001, U+E0020-U+E007F): core's hidden.ts and its controls. The zero-width joiner (U+200D) and non-joiner
 *  (U+200C) stay: an emoji family or an Indic letter is built with the one, Persian and Indic words with the other,
 *  and neither reorders anything; so do the combining grapheme joiner, the Mongolian vowel separator and the
 *  variation selectors.
 *  One definition for core, the CLI and VS Code (its webviews take PLAIN_LABEL_SOURCE, with the `u` flag); the
 *  terminal app's sanitizeCell drops the same set from every cell, and the JetBrains plugin's plainLabel keeps the
 *  same class. */
const HIDDEN = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f]|${HIDDEN_SOURCE}`, 'gu');
export const PLAIN_LABEL_SOURCE = HIDDEN.source;
export function plainLabel(s: string): string {
  return String(s).replace(HIDDEN, '');
}

/** At most one line of what another machine or its ssh said, as the cache keeps it and doctor prints it: the
 *  first line with text, its terminal escape sequences (a colour) and hidden characters dropped, its runs of white
 *  space closed up, and no more than 200 characters of it. */
function oneLine(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const escapes = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;
  const line = s.split(/[\r\n]+/).map((l) => plainLabel(l.replace(escapes, '')).replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!line) return undefined;
  // 200 characters as a reader counts them: cut at 200 code points, a flag or an emoji family there lost its end. And
  // 400 code points at most, which only a character of hundreds of marks or joined emoji reaches: counted as one, a
  // letter with 100,000 accents was kept whole.
  let end = 0;
  for (let n = 0; n < 200 && end < line.length; n++) end = graphemeEnd(line, end);
  let cut = 0;
  for (let n = 0; n < 400 && cut < end; n++) cut += line.codePointAt(cut)! > 0xffff ? 2 : 1;
  return line.slice(0, cut);
}

function parseWindow(v: unknown): MachineUsageWindow | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  const pct = num(w.pct);
  if (pct === null) return null;
  // A label another machine sent is drawn in the editors' tooltips: a model name, or none.
  const label = typeof w.label === 'string' && /^[\w .+-]{1,40}$/.test(w.label) ? w.label : null;
  const est = w.est && typeof w.est === 'object' ? (w.est as Record<string, unknown>) : null;
  return { pct, reset: num(w.reset, 1), at: num(w.at, 1), tok: num(w.tok), total: num(w.total), label, measured: w.measured === true, est: est && { tok: num(est.tok), total: num(est.total) } };
}

/** A brief read from another machine, checked field by field; null when it is not one (an OAK there from before
 *  `__usage-brief` refuses the verb, and prints no reading). */
export function parseMachineUsageBrief(text: string): MachineUsageBrief | null {
  try {
    return toBrief(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A brief's own figures, checked field by field: a window without its tokens or the reset it was measured for is
 *  none, and figures without the machine's host hash or the time they were measured are none at all. */
function parseOwn(v: unknown): MachineUsageOwn | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const at = o ? num(o.at, 1) : null;
  if (!o || at === null || typeof o.host !== 'string' || !/^[0-9a-f]{12}$/.test(o.host)) return null;
  const win = (x: unknown): (MachineUsageOwnWindow & { w: Record<string, unknown> }) | null => {
    const w = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
    const tok = w ? num(w.tok) : null, reset = w ? num(w.reset, 1) : null;
    return w && tok !== null && reset !== null ? { tok, reads: num(w.reads), cost: num(w.cost), reset, w } : null;
  };
  const five = win(o.five), week = win(o.week), month = win(o.month);
  const start = month ? num(month.w.start, 1) : null;
  return {
    host: o.host,
    at,
    five: five && { tok: five.tok, reads: five.reads, cost: five.cost, reset: five.reset },
    week: week && { tok: week.tok, reads: week.reads, cost: week.cost, reset: week.reset, fable: num(week.w.fable), fableReads: num(week.w.fableReads) },
    month: month && start !== null && start < month.reset ? { tok: month.tok, reads: month.reads, cost: month.cost, reset: month.reset, start } : null,
  };
}

function toBrief(v: unknown): MachineUsageBrief | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.brief !== 1) return null;
  const at = num(o.at, 1);
  if (at === null) return null;
  const m = o.month && typeof o.month === 'object' ? (o.month as Record<string, unknown>) : null;
  const tok = m ? num(m.tok) : null;
  return {
    brief: 1,
    account: typeof o.account === 'string' && /^[0-9a-f]{12}$/.test(o.account) ? o.account : null,
    at,
    five: parseWindow(o.five),
    fiveNoneAt: num(o.fiveNoneAt, 1),
    fiveSeenAt: num(o.fiveSeenAt, 1),
    week: parseWindow(o.week),
    fable: parseWindow(o.fable),
    month: m && tok !== null ? { tok, total: num(m.total), reset: num(m.reset, 1), reads: num(m.reads), cost: num(m.cost), costTotal: num(m.costTotal) } : null,
    // Absent from an older OAK's brief, and kept absent: the read that takes it records so (noOwn), for `oak doctor`.
    ...('own' in o ? { own: parseOwn(o.own) } : {}),
  };
}

const WINDOWS = ['five', 'week', 'fable'] as const;

const EMPTY = (): MachineUsageCache => ({ version: 1, attemptedAt: 0, machines: [], outcomes: [] });
let memo: { key: string; cache: MachineUsageCache } | null = null;

/** The name a machine is shown by: its herdr label with the hidden characters dropped, or, where that leaves
 *  nothing, its ssh target the same way; '' when neither has anything to show. */
const shownLabel = (label: unknown, target: string): string => (typeof label === 'string' && label ? plainLabel(label) || plainLabel(target) : '');

/** The cache, re-read only when its file changes (one stat per call). Missing or torn reads as empty. */
export function readMachineUsage(): MachineUsageCache {
  const file = machineUsageCachePath();
  const key = `${file}|${statKey(file)}`;
  if (memo?.key === key) return memo.cache;
  let cache = EMPTY();
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && c.version === 1 && Array.isArray(c.machines)) {
      const machines: MachineUsageEntry[] = [];
      for (const e of c.machines) {
        const label = e && typeof e.target === 'string' ? shownLabel(e.label, e.target) : '';
        const brief = label ? toBrief(e.brief) : null;
        const firstSkew: NonNullable<MachineUsageEntry['firstSkew']> = {};
        for (const key of WINDOWS) if (typeof e.firstSkew?.[key] === 'number' && Number.isFinite(e.firstSkew[key])) firstSkew[key] = e.firstSkew[key];
        if (brief) machines.push({ label, target: e.target, brief, skewMs: typeof e.skewMs === 'number' && Number.isFinite(e.skewMs) ? e.skewMs : 0, rttMs: num(e.rttMs), ...(Object.keys(firstSkew).length ? { firstSkew } : {}),
          ...(e.briefOnly === true || (!e.host && Array.isArray(c.outcomes) && c.outcomes.some((o: MachineUsageOutcome) => o.target === e.target && o.status === 'ok' && o.briefOnly)) ? { briefOnly: true as const } : {}),
          ...(typeof e.host === 'string' && /^[0-9a-f]{12}$/.test(e.host) ? { host: e.host } : {}) });
      }
      const outcomes: MachineUsageOutcome[] = [];
      for (const o of Array.isArray(c.outcomes) ? c.outcomes : []) {
        const label = o && typeof o.target === 'string' ? shownLabel(o.label, o.target) : '';
        const detail = label ? oneLine(o.detail) : undefined;
        if (label && STATUSES.has(o.status) && num(o.at, 1) !== null) {
          outcomes.push({ label, target: o.target, at: o.at, status: o.status, ...(detail ? { detail } : {}), ...(o.noOwn === true ? { noOwn: true as const } : {}),
            ...(o.briefOnly === true ? { briefOnly: true as const } : {}) });
        }
      }
      cache = { version: 1, attemptedAt: num(c.attemptedAt) ?? 0, machines, outcomes };
    }
  } catch {
    /* none yet, or torn: no machine's reading, never an ssh */
  }
  memo = { key, cache };
  return cache;
}

function writeCache(cache: MachineUsageCache): void {
  const file = machineUsageCachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A refresh holds the lock: a live pid, or a lock too young to carry one yet. A lock older than a whole
 *  refresh is stale whoever holds it, and so is one dated after now (withinLast). */
function refreshRunning(): boolean {
  let at: number;
  try {
    at = fs.statSync(lockPath()).mtimeMs;
  } catch {
    return false;
  }
  if (!fileWithinLast(lockPath(), at, machineUsageDeadlineMs())) return false;
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
    return Date.now() - at < 5_000; // the owner may be between creating the lock and writing its pid
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

/** On unless prefs.json says `"machineUsage": false`, which stops the background ssh and these readings. */
export function machineUsageEnabled(): boolean {
  return keptPrefs().machineUsage !== false;
}

/** Due, and claimed for this caller: on, herdr is here (OAK's machines are herdr's, so without it there are
 *  none), nothing refreshed within the throttle, nobody refreshing, and no other poller kicked one in the
 *  last minute. The claim is what keeps many pollers to one refresh. A claim or attempt dated after now (a
 *  clock stepped back since) holds nothing (withinLast). */
export function claimMachineUsagePull(): boolean {
  try {
    try {
      if (fileWithinLast(claimPath(), fs.statSync(claimPath()).mtimeMs, CLAIM_MS)) return false; // the cheapest refusal first
    } catch {
      /* no claim standing */
    }
    if (!machineUsageEnabled()) return false;
    if (withinLast(readMachineUsage().attemptedAt, MACHINE_USAGE_REFRESH_MS) || refreshRunning() || !findHerdrBin()) return false;
    fs.mkdirSync(path.dirname(claimPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(claimPath(), String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false; // cannot claim ⇒ do not refresh — an unwritable store must not become an ssh storm
  }
}

/** Start a detached `oak usage --pull-machines --if-due` when one is due. `cli` is the oak CLI entry the CLI
 *  registered at startup; a process with none registered (an editor host, which starts the CLI itself) starts
 *  nothing here. Never blocks, never throws. */
export function kickMachineUsage(cli: string | undefined = oakCliEntry()): void {
  // The same pollers keep oak sync current: a due background run starts too (sync-kick.ts), whatever this setting says.
  (require('./sync-kick') as typeof import('./sync-kick')).kickSync(cli);
  try {
    if (!cli || noBackgroundChildren() || !claimMachineUsagePull()) return;
    const child = spawnTool(process.execPath, [cli, 'usage', '--pull-machines', '--if-due'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      /* the cached readings stand until the next poll */
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

/** A saved machine as herdr lists it. */
export interface UsageMachine {
  label: string;
  target: string;
  enabled: boolean;
}

/** How a refresh asks a machine: its usage records since a cursor (`oak __usage-records`), or, from an OAK there
 *  older than the usage pull or where this machine has no index to keep records in, its readings (`oak __usage-brief`). */
export interface MachineUsageAsk {
  verb: 'records' | 'brief';
  since: string | null;
}

/** The most pages of records one refresh asks one machine for; the rest waits for the next. */
const RECORD_PAGES = 20;
/** A machine whose record log oak sync wrote here within this long is current: its usage is in the index already. */
const RECORDS_CURRENT_MS = 15 * 60_000;

/** Whether oak sync keeps this machine's record log here, current (index/records.ts): its newest segment written in the
 *  last RECORDS_CURRENT_MS. */
function recordsCurrent(host: string): boolean {
  try {
    const dir = path.join(rootDir(), 'records', host);
    return fs.readdirSync(dir).some((n) => withinLast(fs.statSync(path.join(dir, n)).mtimeMs, RECORDS_CURRENT_MS));
  } catch {
    return false;
  }
}

/**
 * One bounded refresh: `list` reads the saved machines (null when it could not), and `ask` runs a machine's
 * `oak __usage-records --json` (or `oak __usage-brief --json`, MachineUsageAsk) and resolves its stdout, why it has none
 * (MachineUsageAnswer), or null when there was no answer. Machines saved with the same ssh target are one install, asked
 * once. A machine's usage records go into the local index, page by page from where the last pull ended, and its latest
 * readings, as the index holds them, into this cache (for a process with no index, which reads it). A machine whose
 * records oak sync brings here current is not asked. A machine that does not answer keeps its last entry; one no longer
 * saved, or disabled, is dropped. Each machine asked gets its outcome, and each answer the clock difference it shows.
 * Returns the cache it wrote, or null when it did not run (off, another refresh holds the lock, or one ran within the
 * throttle and this one is not forced).
 */
export async function refreshMachineUsage(
  list: () => Promise<UsageMachine[] | null>,
  ask: (m: UsageMachine, how: MachineUsageAsk) => Promise<MachineUsageAnswer>,
  opts: { force?: boolean } = {}
): Promise<MachineUsageCache | null> {
  try {
    if (!machineUsageEnabled() || !takeLock()) return null;
  } catch {
    return null; // an unwritable store: nothing to refresh into
  }
  try {
    const was = readMachineUsage();
    // Recheck under the lock: two pollers can both have read an overdue stamp.
    if (!opts.force && withinLast(was.attemptedAt, MACHINE_USAGE_REFRESH_MS)) return null;
    const machines = await list();
    // The switch again: turned off while herdr listed the machines (up to its timeout), no machine is asked.
    if (!machineUsageEnabled()) return null;
    // Records go into the local index; where there is none that opens (no node:sqlite with FTS5, a file a newer OAK wrote,
    // a damaged one), a machine's readings, as before.
    const ix = (require('./index/api') as typeof import('./index/api'));
    const records = ix.indexUsable();
    let entries = was.machines;
    let outcomes = was.outcomes;
    if (machines) {
      const seen = new Set<string>();
      const live = machines.filter((m) => m.enabled && m.target && !m.target.startsWith('-') && !seen.has(m.target) && seen.add(m.target));
      const answers = await Promise.all(live.map(async (m) => {
        const label = shownLabel(m.label, m.target);
        const last = was.machines.find((e) => e.target === m.target);
        // oak sync keeps its record log here, current: its usage and readings are in the index, and no ssh is asked.
        if (records && label && last?.host && recordsCurrent(last.host)) {
          const e = ix.indexedMachineEntry(last.host);
          return { m, label, entry: { ...(e ?? last), label, target: m.target, host: last.host, briefOnly: undefined } as MachineUsageEntry, at: Date.now(), status: 'synced' as const };
        }
        let answer: MachineUsageAnswer = null;
        let asked = Date.now();
        let at = asked;
        // Why the machine answered the usage pull with no records: it has no index that opens.
        let noIndex: string | null = null;
        if (records) {
          let since = last?.host ? ix.usagePullCursor(last.host) : null;
          let applied: { host: string; skewMs: number; rttMs: number } | null = null;
          // Every page of one pull arrives at the same time here, so a page never takes a later one's rows for older ones.
          const pulledAt = Date.now();
          for (let page = 0; page < RECORD_PAGES; page++) {
            asked = Date.now();
            try {
              answer = await ask(m, { verb: 'records', since });
            } catch {
              answer = null;
            }
            at = Date.now();
            const rec = typeof answer === 'string' ? ix.parseUsageRecords(answer) : null;
            if (!rec) break;
            if ('error' in rec) {
              noIndex = rec.error;
              answer = null;
              break;
            }
            // It answered during the round trip: its clock less this one's, as for a brief (below).
            const lo = rec.at - at;
            const skewMs = lo <= 0 && lo + (at - asked) >= 0 ? 0 : lo;
            if (!ix.indexApplyUsageRecords(rec, { label, skewMs, now: pulledAt })) break;
            applied = { host: rec.host, skewMs, rttMs: at - asked };
            since = rec.cursor;
            if (!rec.more) break;
          }
          if (applied && label) {
            const e = ix.indexedMachineEntry(applied.host);
            const entry: MachineUsageEntry = { ...(e ?? { brief: { brief: 1, account: null, at: applied.host ? Date.now() : 0, five: null, week: null, fable: null, month: null, own: null } }),
              label, target: m.target, host: applied.host, skewMs: applied.skewMs, rttMs: applied.rttMs } as MachineUsageEntry;
            return { m, label, entry, at, status: 'ok' as const };
          }
        }
        // An OAK there from before the usage pull refuses `__usage-records` (as an older one refuses `__usage-brief`), and
        // one with no index that opens answers it with why: its readings, then, which it does answer; and the readings
        // where this machine keeps no index.
        const briefOnly = records && (noIndex !== null || (!!answer && typeof answer === 'object' && answer.status === 'old-oak'));
        if (!records || briefOnly) {
          asked = Date.now();
          try {
            answer = await ask(m, { verb: 'brief', since: null });
          } catch {
            answer = null;
          }
          at = Date.now();
        }
        const brief = typeof answer === 'string' ? parseMachineUsageBrief(answer) : null;
        const status: MachineUsageStatus = brief ? 'ok' : typeof answer === 'string' ? 'not-reading' : answer?.status ?? 'failed';
        const detail = !brief && answer && typeof answer === 'object' ? oneLine(answer.detail) : brief && noIndex !== null ? oneLine(noIndex) : undefined;
        return { m, label, brief, at, rttMs: at - asked, status, detail, briefOnly: briefOnly && !!brief };
      }));
      entries = [];
      outcomes = [];
      for (const a of answers) {
        const { m, label, at, status } = a;
        if (!label) continue; // nothing to name it by
        if ('entry' in a) {
          if (a.entry) entries.push(a.entry);
          outcomes.push({ label, target: m.target, at, status });
          continue;
        }
        const { brief, rttMs, detail } = a;
        const last = was.machines.find((e) => e.target === m.target);
        // It printed the brief during the round trip, late in it (after ssh connected and its oak started), so its
        // clock's difference from this one is `brief.at - at`, or as much as the round trip more; none at all when
        // the clocks agree as far as the round trip can tell.
        if (brief) {
          const lo = brief.at - at;
          // A share an earlier refresh brought keeps the difference it was read with (MachineUsageEntry.firstSkew).
          const firstSkew: NonNullable<MachineUsageEntry['firstSkew']> = {};
          for (const key of WINDOWS) {
            const w = brief[key], was = last?.brief[key];
            if (last && w && was && w.at !== null && was.at === w.at) firstSkew[key] = last.firstSkew?.[key] ?? last.skewMs;
          }
          entries.push({ label, target: m.target, brief, ...(a.briefOnly ? { briefOnly: true as const } : {}), skewMs: lo <= 0 && lo + rttMs >= 0 ? 0 : lo, rttMs, ...(Object.keys(firstSkew).length ? { firstSkew } : {}) });
        } else if (last) entries.push({ ...last, label });
        outcomes.push({ label, target: m.target, at, status, ...(detail ? { detail } : {}), ...(brief && brief.own === undefined ? { noOwn: true as const } : {}),
          ...(a.briefOnly ? { briefOnly: true as const } : {}) });
      }
    }
    const next: MachineUsageCache = { version: 1, attemptedAt: Date.now(), machines: entries, outcomes };
    writeCache(next);
    return next;
  } catch {
    return null; // silent: the cached readings stand
  } finally {
    fs.rmSync(lockPath(), { force: true });
    memo = null;
  }
}

/**
 * `oak doctor`'s rows for the saved machines' usage readings, one for each machine the last refresh asked: whether
 * it answered, and where it gave no reading this machine can use, why and what to do about it. From the cache
 * alone: no ssh. None while the readings are off.
 */
export function diagnoseMachineUsage(now = Date.now()): Check[] {
  if (!machineUsageEnabled()) return [];
  const { relTime } = require('./format') as typeof import('./format'); // lazy: doctor alone needs it
  const c = readMachineUsage();
  const mine = claudeAccountTag();
  return c.outcomes.map((o): Check => {
    const row = { id: `machine-usage:${o.label}`, label: `Claude usage from ${o.label}` };
    const target = plainLabel(o.target);
    const e = c.machines.find((x) => x.target === o.target);
    const when = relTime(o.at, now);
    // A machine that gave no reading this time keeps the one it gave before.
    const kept = e ? `; OAK keeps the reading it gave at ${relTime(e.brief.at - e.skewMs, now)} until its shares fall out of their windows` : '';
    switch (o.status) {
      case 'ok': {
        const account = e?.brief.account === null ? '; it has no Claude Code login, so it gives no reading of the account'
          : mine && e && e.brief.account !== mine ? '; it is signed in to another Claude account, so its readings are not used here'
          : e && !e.brief.five && !e.brief.week && !e.brief.fable ? '; it has measured none of the account\'s shares itself (no Claude Code session or account read there), so it gives no reading' : '';
        const skew = e && Math.abs(e.skewMs) >= 60_000
          ? `; its clock runs ${Math.round(Math.abs(e.skewMs) / 60_000)} min ${e.skewMs > 0 ? 'ahead of' : 'behind'} this machine's, so OAK dates its readings by this machine's clock` : '';
        // An OAK there from before the usage pull, or one whose index does not open, sends no usage records: the totals and
        // estimates here add what it measured of its own turns instead, as before the index, while they hold none of its
        // records (index/usage.ts usageTotals). Said as information, with what brings its records; one that sends no figures
        // of its own either is warned below.
        if (e && !account && o.briefOnly && !o.noOwn) {
          // `detail`: why that machine has no index to answer the usage pull from (else, an OAK there from before it).
          return o.detail
            ? { ...row, level: 'ok', detail: `answered at ${when}${skew}; it has no local database that opens (${o.detail}), so it gives its readings and what it measured of its own usage, which the totals and estimates here add until it supplies message-level records, but not those records`,
              fix: `Run \`oak doctor\` on ${o.label}: its Local database row says why and what to do.` }
            : { ...row, level: 'ok', detail: `answered at ${when}${skew}; its OAK is older than this one and gives its readings and what it measured of its own usage, which the totals and estimates here add until it supplies message-level records, but not those records`,
              fix: `Update OAK on ${o.label}: run \`oak update\` there.` };
        }
        // An OAK from before the own figures: the estimates here leave its usage out, which only an update there mends.
        // Judged by the read that took the answer (noOwn): an older OAK here stored every answer without the figures, so
        // their absence from a stored answer blamed a machine already updated, until the next read.
        if (e && !account && o.noOwn && !e.host) {
          return { ...row, level: 'warn', detail: `answered at ${when}${skew}; its OAK is older than this one and does not report its own usage, so the token and dollar estimates here leave that machine's usage out`,
            fix: `Update OAK on ${o.label}: run \`oak update\` there.` };
        }
        return { ...row, level: 'ok', detail: `answered at ${when}${account}${skew}` };
      }
      case 'synced':
        return { ...row, level: 'ok', detail: `its usage arrives with oak sync (its record log), current at ${when}` };
      case 'unreachable':
        return { ...row, level: 'warn', detail: `could not be reached over ssh at ${when}${o.detail ? `: ${o.detail}` : ''}${kept}`,
          fix: `Check that \`ssh ${target}\` connects without asking for a password or about a host key: OAK's ssh runs in batch mode.` };
      case 'timeout':
        return { ...row, level: 'warn', detail: `no answer within ${MACHINE_USAGE_ASK_MS / 1000} s at ${when}${kept}`, fix: `Check that ${target} answers over ssh.` };
      case 'no-oak':
        return { ...row, level: 'warn', detail: `OAK was not found there at ${when}${kept}`, fix: `\`oak machine add ${o.label} ${target}\` installs OAK there.` };
      case 'old-oak':
        return { ...row, level: 'warn', detail: `its OAK is older than this one and refuses the usage read (asked at ${when})${kept}`,
          fix: `Update OAK on ${o.label}: run \`oak update\` there.` };
      case 'not-reading':
        return { ...row, level: 'warn', detail: `its answer at ${when} was not OAK's reading: something there printed to standard output before OAK did, such as a shell startup file (~/.bashrc, ~/.zshenv)${kept}`,
          fix: `Make the shell startup files on ${o.label} print nothing when the shell is not interactive.` };
      default:
        return { ...row, level: 'warn', detail: `\`oak __usage-brief\` failed there at ${when}${o.detail ? `: ${o.detail}` : ''}${kept}`, fix: `Run \`oak doctor\` on ${o.label}.` };
    }
  });
}
