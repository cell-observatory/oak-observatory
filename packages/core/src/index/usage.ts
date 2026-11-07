/**
 * Usage from the index: the account's windows and what every machine used in them, each message once.
 *
 * `usage_messages` holds one row per assistant message (Claude Code's message id, a Codex turn's usage id) from every
 * machine whose records the index holds, at its largest snapshot (ingest.ts). A window's total is one query over it, so
 * a message is counted once however many machines hold a copy of its transcript, and work on separate machines adds up.
 * Tokens are input + output + cache creation, cache reads apart, as Claude Code counts them.
 *
 * Whose rows a window counts, as the status line has always counted them: every row this machine wrote, and every other
 * machine's row billed to this machine's Claude account (its tag, a hash of Claude Code's account id), or, where this
 * machine has no Claude Code login, to the one account the other machines name.
 */
import * as fs from 'fs';
import type { DatabaseSync } from 'node:sqlite';
import { machineHostTag, claudeAccountTag, claudeSignedOut, plainLabel, readMachineUsage, type MachineUsageEntry } from '../machine-usage';
import { billDay, readPrefs } from '../prefs';
import { claudeJsonPath } from '../paths';
import { relTime } from '../format';
import { getMeta, setMeta, write } from './db';
import { priceUsage } from '../pricing';

/** GPT's bill cycle and calibration week, from the database's deduplicated rows. The time range
 *  uses usage_messages_window; grouping by model/provider also preserves unknown hosted prices. */
export function codexWindowTotals(db: DatabaseSync, monthStart: number, weekStart: number, now: number) {
  const account = (require('../codex') as typeof import('../codex')).codexAccountId() ?? codexAccountOf(db);
  const rows = db.prepare(`SELECT machine_id, model, provider,
    total(CASE WHEN ts >= ? THEN input + output + cache_create ELSE 0 END) AS moTok,
    total(CASE WHEN ts >= ? THEN cache_read ELSE 0 END) AS moReads,
    total(CASE WHEN ts >= ? THEN cost ELSE 0 END) AS moUsd,
    total(CASE WHEN ts >= ? THEN input + output + cache_create ELSE 0 END) AS weekTok
    FROM usage_messages WHERE agent = 'codex' AND ts >= ? AND ts <= ?
      AND (? IS NULL OR account IS NULL OR account = ?)
    GROUP BY machine_id, model, provider`).all(monthStart, monthStart, monthStart, weekStart,
      Math.min(monthStart, weekStart), now, account, account) as
      { machine_id: string; model: string; provider: string | null; moTok: number; moReads: number; moUsd: number; weekTok: number }[];
  const labels = new Map((db.prepare('SELECT machine_id, coalesce(saved_label, label, machine_id) AS label FROM machines').all() as
    { machine_id: string; label: string }[]).map((r) => [r.machine_id, r.label]));
  const totals = { moTok: 0, moReads: 0, moUsd: 0, moUsdKnown: true, weekTok: 0, measuredMachines: '', budgetScope: '', localEquivalent: false, usageFreshness: usageFreshness(db, now) };
  for (const r of rows) {
    totals.moTok += r.moTok; totals.moReads += r.moReads; totals.moUsd += r.moUsd; totals.weekTok += r.weekTok;
    const model = r.provider && r.provider !== 'openai' ? `provider:${r.provider}/${r.model}` : r.model;
    if ((r.moTok > 0 || r.moReads > 0) && !['ollama', 'lmstudio', 'ollama-launch'].includes(r.provider ?? '') &&
      !priceUsage(model, { input: r.moTok, output: 0, cacheWrite: 0, cacheRead: r.moReads }).known) totals.moUsdKnown = false;
  }
  const machines = [...new Set(rows.map((r) => r.machine_id))].sort();
  totals.measuredMachines = machines.map((id) => plainLabel(labels.get(id) ?? id)).join(', ') || 'no machines yet';
  totals.budgetScope = `database:${account ?? ''}:${[...labels.keys()].sort().join(',')}`;
  // A database that knows no machine but this one counts exactly what a local reading counts, so a budget remembered
  // from local readings (as before 0.11) still stands in for a week with no sample.
  const self = new Set(selfIds(db));
  totals.localEquivalent = [...labels.keys()].every((id) => self.has(id));
  totals.moUsd = Math.round(totals.moUsd * 1e8) / 1e8;
  return totals;
}

export const FIVE_HOURS_MS = 5 * 3600_000;
export const WEEK_MS = 7 * 86400_000;

/** One window: from `start` to `end` (epoch ms, end excluded), and the reset that ends it when the account reported one. */
export interface UsageWindowSpan {
  start: number;
  end: number;
  reset: number | null;
}

/** What the rows counted in a window add up to. `tokens` is input + output + cache creation; `cost` the list price
 *  (pricing.ts); `spend` what Claude Code itself reported for its sessions in the window (the status line's ledger).
 *  `others` is the part from machines other than this one, with which machines. A saved machine that answers only with its
 *  readings adds what it measured of its own turns (usageTotals addBriefOnly) to `tokens`, `cacheRead`, `topTier` and
 *  `spend` (the month's to `cost`), and to `others`, never to `messages`, `input`, `output` or `cacheCreate`. */
export interface UsageWindowTotals extends UsageWindowSpan {
  messages: number;
  tokens: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /** Of `cacheCreate`, the writes kept an hour (priced at the 1-hour rate); the rest were kept five minutes, or their
   *  record does not say (priced at the 5-minute rate). */
  cacheCreate1h: number;
  cost: number;
  /** How many of `messages` have an approximate `cost`: a model no price row lists exactly, or writes with no split. */
  approx: number;
  spend: number;
  /** The per-model weekly cap's family (fable, mythos): its tokens and cache reads in the window. */
  topTier: { tokens: number; cacheRead: number };
  others: { tokens: number; cacheRead: number; cost: number; spend: number; topTier: { tokens: number; cacheRead: number }; machines: string[] };
}

/** What `oak usage --json` adds as `usageTotals`: the account's 5-hour, weekly and bill-cycle windows from the index. */
export interface UsageTotals {
  /** The account counted (UsageTotals' rule above), or null when none is known here (every machine's rows then count). */
  account: string | null;
  /** True when that account is not this machine's own (it has no Claude Code login): the one the other machines name. */
  unmatched: boolean;
  five: UsageWindowTotals;
  week: UsageWindowTotals;
  /** The bill cycle (prefs.json `billDay`, else the day Claude Code's subscription renews, else the calendar month). */
  month: UsageWindowTotals;
  /** The machines whose rows the index holds: this one first, each with when its records last arrived here; then each
   *  saved machine that answers only with its readings, whose own figures a window adds (`briefOnly`, usageTotals). */
  machines: { machine: string; label: string | null; self: boolean; syncedAt: number | null; briefOnly?: true }[];
}

/** Every id this machine's catch-ups filed rows under (its host tag can change: macOS renames the host). */
export function selfIds(db: DatabaseSync): string[] {
  const ids = new Set((db.prepare('SELECT machine_id FROM machines WHERE is_self = 1').all() as { machine_id: string }[]).map((m) => m.machine_id));
  ids.add(machineHostTag());
  return [...ids];
}

/** What `oak usage` needs of Claude Code's `.claude.json` (its account tag, whether it has no login, the day its
 *  subscription renews), kept in the index by the file's stamp: the file can be megabytes, and a status line starts
 *  `oak usage` on every render. Read again only when the file changes. */
function claudeLogin(db: DatabaseSync): { account: string | null; signedOut: boolean; day: number | null } {
  const file = claudeJsonPath();
  let stamp = '-';
  try {
    const st = fs.statSync(file);
    stamp = `${file}|${st.ino}|${st.size}|${st.mtimeMs}`;
  } catch {
    stamp = `${file}|-`;
  }
  try {
    const kept = JSON.parse(getMeta(db, 'claude_login') ?? 'null') as { stamp: string; account: string | null; signedOut: boolean; day: number | null } | null;
    if (kept?.stamp === stamp) return kept;
  } catch {
    /* read below */
  }
  const prefs = readPrefs();
  // The subscription's day whatever prefs.json says, which billDayOf reads first: a bill day set there and later cleared
  // leaves this as it was.
  const fresh = { stamp, account: claudeAccountTag(), signedOut: claudeSignedOut(), day: billDay({ ...prefs, billDay: undefined }) };
  try {
    write(db, () => setMeta(db, 'claude_login', JSON.stringify(fresh)));
  } catch {
    /* kept next time */
  }
  return fresh;
}

/** The bill day: prefs.json's, else the day Claude Code's subscription renews (claudeLogin), else none (the 1st). */
function billDayOf(db: DatabaseSync): number | null {
  return (require('../account-billing') as typeof import('../account-billing')).accountBillDay('claude', db) ?? claudeLogin(db).day;
}

/** The Codex account this machine is signed in to, as its records say (the hash OAK's quota read keeps): a breakdown
 *  counts other machines' Codex rows of it. */
export function codexAccountOf(db: DatabaseSync): string | null {
  const self = selfIds(db);
  const own = (db.prepare(`SELECT account FROM accounts WHERE agent = 'codex' AND machine_id IN (${self.map(() => '?').join(', ')}) ORDER BY last_ms DESC LIMIT 1`)
    .get(...self) as { account: string } | undefined)?.account;
  if (own) return own;
  const named = db.prepare("SELECT DISTINCT account FROM accounts WHERE agent = 'codex'").all() as { account: string }[];
  return named.length === 1 ? named[0].account : null;
}

/** The Claude account a window counts, and whether it is this machine's own. */
export function countedAccount(db: DatabaseSync): { account: string | null; unmatched: boolean } {
  const login = claudeLogin(db);
  const mine = login.account;
  if (mine !== null || !login.signedOut) return { account: mine, unmatched: false };
  const named = (db.prepare("SELECT DISTINCT account FROM accounts WHERE agent = 'claude'").all() as { account: string }[]).map((a) => a.account);
  return named.length === 1 ? { account: named[0], unmatched: true } : { account: null, unmatched: false };
}

/** The bill cycle `now` falls in (UTC), on the bill day, clamped to a short month's last day as card billing does; the
 *  calendar month without one. The same cycle the status line measures. */
export function billCycle(now = Date.now(), day: number | null = billDay()): UsageWindowSpan {
  const bd = day || 1;
  const at = (y: number, m: number): number => Date.UTC(y, m, Math.min(bd, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()));
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const here = at(y, m);
  return now >= here ? { start: here, end: at(y, m + 1), reset: at(y, m + 1) } : { start: at(y, m - 1), end: here, reset: here };
}

/** The 5-hour and weekly windows a reset places: [reset - period, reset). With no reset (an ended 5-hour window, a plan
 *  with no rolling windows), the last five hours, and the last week from the hour (the status line's own windows). */
export function rollingWindow(periodMs: number, reset: number | null, now = Date.now()): UsageWindowSpan {
  if (reset !== null && reset > now - periodMs) return { start: reset - periodMs, end: reset, reset };
  const start = periodMs === WEEK_MS ? Math.floor((now - periodMs) / 3600_000) * 3600_000 : now - periodMs;
  return { start, end: now + 1, reset: null };
}

const ZERO = { messages: 0, tokens: 0, input: 0, output: 0, cacheCreate: 0, cacheCreate1h: 0, cacheRead: 0, cost: 0, approx: 0, top: 0, topRead: 0 };

/** Dollars to the hundredth of a cent, as a window carries them. */
const money = (v: number): number => Math.round(v * 10000) / 10000;

const DAY_MS = 86_400_000;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The totals of the rows a window counts (`self`: this machine's ids; `account`: the account counted). Its whole UTC days
 *  are summed from the daily rollup and the hours at either end from the messages: a month holds tens of thousands of
 *  messages and a few hundred day rows, and every status line render asks for it. */
export function windowTotals(db: DatabaseSync, agent: string, span: UsageWindowSpan, account: string | null, self: readonly string[]): UsageWindowTotals {
  const marks = self.map(() => '?').join(', ');
  const counted = account === null ? '1 = 1' : `(machine_id IN (${marks}) OR account = ?)`;
  const args = account === null ? [] : [...self, account];
  const from = Math.ceil(span.start / DAY_MS) * DAY_MS;
  const to = Math.max(from, Math.floor(span.end / DAY_MS) * DAY_MS);
  const sums = (messages: string): string => `machine_id IN (${marks}) AS own, machine_id AS machine, ${messages} AS messages, total(input + output + cache_create) AS tokens,
      total(input) AS input, total(output) AS output, total(cache_create) AS cacheCreate, total(cache_create_1h) AS cacheCreate1h, total(cache_read) AS cacheRead,
      total(cost) AS cost, total(cost_approx) AS approx,
      total(CASE WHEN top_tier = 1 THEN input + output + cache_create ELSE 0 END) AS top, total(CASE WHEN top_tier = 1 THEN cache_read ELSE 0 END) AS topRead`;
  const rows = [
    ...db.prepare(`SELECT ${sums('count(*)')} FROM usage_messages WHERE agent = ? AND ((ts >= ? AND ts < ?) OR (ts >= ? AND ts < ?)) AND ${counted} GROUP BY machine_id`)
      .all(...self, agent, span.start, Math.min(from, span.end), Math.max(to, span.start), span.end, ...args),
    ...(to > from ? db.prepare(`SELECT ${sums('total(messages)')} FROM usage_daily WHERE agent = ? AND day >= ? AND day < ? AND ${counted} GROUP BY machine_id`)
      .all(...self, agent, utcDay(from), utcDay(to), ...args) : []),
  ] as (typeof ZERO & { own: number; machine: string })[];
  const spend = db.prepare(`SELECT machine_id IN (${marks}) AS own, machine_id AS machine, total(delta) AS spend FROM usage_spend
    WHERE reported_ms >= ? AND reported_ms < ? AND ${counted} GROUP BY machine_id`).all(...self, span.start, span.end, ...args) as { own: number; machine: string; spend: number }[];
  const all = { ...ZERO };
  const others = { ...ZERO };
  const machines = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(ZERO) as (keyof typeof ZERO)[]) {
      all[k] += r[k];
      if (!r.own) others[k] += r[k];
    }
    if (!r.own) machines.add(r.machine);
  }
  let spendAll = 0;
  let spendOthers = 0;
  for (const s of spend) {
    spendAll += s.spend;
    if (!s.own) {
      spendOthers += s.spend;
      machines.add(s.machine);
    }
  }
  return {
    ...span, messages: all.messages, tokens: all.tokens, input: all.input, output: all.output, cacheCreate: all.cacheCreate, cacheCreate1h: all.cacheCreate1h,
    cacheRead: all.cacheRead, cost: money(all.cost), approx: all.approx, spend: money(spendAll), topTier: { tokens: all.top, cacheRead: all.topRead },
    others: { tokens: others.tokens, cacheRead: others.cacheRead, cost: money(others.cost), spend: money(spendOthers), topTier: { tokens: others.top, cacheRead: others.topRead },
      machines: [...machines].sort() },
  };
}

/** The machines whose rows the index holds, this one first. */
export function usageMachines(db: DatabaseSync, self: readonly string[]): UsageTotals['machines'] {
  const mine = new Set(self);
  return (db.prepare(`SELECT m.machine_id, coalesce(m.saved_label, m.label) AS label, m.is_self,
    nullif(max(coalesce(m.synced_through_ms, 0), coalesce(p.updated_ms, 0)), 0) AS synced_through_ms
    FROM machines m LEFT JOIN ingest_state p ON p.source = 'usage-pull:' || m.machine_id ORDER BY m.is_self DESC, m.machine_id`).all() as
    { machine_id: string; label: string | null; is_self: number; synced_through_ms: number | null }[])
    .map((m) => ({ machine: m.machine_id, label: mine.has(m.machine_id) ? null : m.label, self: mine.has(m.machine_id), syncedAt: m.synced_through_ms }));
}

/** A pull runs at most every five minutes while something polls (machine-usage.ts), so an answer is stale only past three. */
const USAGE_STALE_MS = 15 * 60_000;

/** When other machines' usage arrived, separate from the age of an account quota reading, in this machine's clock time
 *  as every other stamp OAK shows. Cache-only. */
export function usageFreshness(db: DatabaseSync, now = Date.now()): string {
  const cache = readMachineUsage();
  const known = new Set<string>();
  const stamp = (label: string, at: number | null, notes: string[]): string =>
    `${plainLabel(label)} ${at ? relTime(at, now) : 'not received'}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  const parts = usageMachines(db, selfIds(db)).filter((m) => !m.self).map((m) => {
    const e = cache.machines.find((e) => (e.host ?? e.brief.own?.host) === m.machine);
    if (e) known.add(e.target);
    const outcome = cache.outcomes.find((o) => o.target === e?.target);
    const notes = [];
    if (getMeta(db, `usage_pull_partial:${m.machine}`) === '1') notes.push('partial pull');
    if (m.syncedAt && now - m.syncedAt > USAGE_STALE_MS) notes.push('stale');
    if (outcome && !['ok', 'synced'].includes(outcome.status)) notes.push(outcome.status);
    return stamp(m.label ?? m.machine, m.syncedAt, notes);
  });
  for (const o of cache.outcomes) {
    if (known.has(o.target)) continue;
    const e = cache.machines.find((e) => e.target === o.target);
    const at = e?.briefOnly ? e.brief.at - e.skewMs : null;
    const notes = e?.briefOnly ? ['readings only'] : [];
    if (at && now - at > USAGE_STALE_MS) notes.push('stale');
    if (!['ok', 'synced'].includes(o.status)) notes.push(o.status);
    parts.push(stamp(o.label, at, notes));
  }
  return parts.length ? `Usage received: ${parts.join(' · ')}` : '';
}

/** The account's windows, placed by the resets the caller's readout shows (usageLine), and what each holds; with `briefs`
 *  (the saved machines' cached answers), what a machine that answers only with its readings measured of its own turns. */
export function usageTotals(db: DatabaseSync, opts: { fiveReset: number | null; weekReset: number | null; now?: number; briefs?: readonly MachineUsageEntry[] }): UsageTotals {
  const now = opts.now ?? Date.now();
  const self = selfIds(db);
  const { account, unmatched } = countedAccount(db);
  const t: UsageTotals = {
    account,
    unmatched,
    five: windowTotals(db, 'claude', rollingWindow(FIVE_HOURS_MS, opts.fiveReset, now), account, self),
    week: windowTotals(db, 'claude', rollingWindow(WEEK_MS, opts.weekReset, now), account, self),
    month: windowTotals(db, 'claude', billCycle(now, billDayOf(db)), account, self),
    machines: usageMachines(db, self),
  };
  if (opts.briefs?.length) addBriefOnly(db, t, opts.briefs, self, now);
  return t;
}

/**
 * A saved machine that answers only with its readings (machine-usage.ts briefOnly: an OAK there from before the usage
 * pull, or one whose index does not open) sends no records, so the index holds none of its usage: what it measured of its
 * own turns (MachineUsageBrief.own) is added to the windows it shares with this one, as before the index (observe.ts
 * measuredFromMachines: the account counted, this machine's windows and bill cycle, measured inside them, each machine
 * once), to the window and to its `others`: its tokens and cache reads, the per-model cap's family in the week, the spend
 * Claude Code reported for its sessions in the 5-hour and weekly windows, and the month at list price. A machine whose
 * pull has supplied records (even an empty page), or whose record log has arrived with oak sync, is counted by its
 * rows alone. Row attribution cannot establish this capability: copied transcripts may all be filed under one host.
 */
function addBriefOnly(db: DatabaseSync, t: UsageTotals, briefs: readonly MachineUsageEntry[], self: readonly string[], now: number): void {
  const mine = new Set(self);
  const records = db.prepare(`SELECT 1 FROM machines m LEFT JOIN ingest_state p ON p.source = 'usage-pull:' || m.machine_id
    WHERE m.machine_id = ? AND (p.source IS NOT NULL OR m.synced_through_ms IS NOT NULL)`);
  const only = briefs.filter((e) => e.briefOnly && !e.host && e.brief.own && !mine.has(e.brief.own.host) && !records.get(e.brief.own.host));
  if (!only.length) return;
  const m = (require('../observe') as typeof import('../observe')).measuredFromMachines([...only], () => t.account, { start: t.month.start, reset: t.month.end },
    t.five.reset, t.week.reset, now);
  if (!m) return;
  const add = (w: UsageWindowTotals, x: { tok: number; reads: number; cost: number; hosts: string; fable?: number; fableReads?: number } | null, listPrice: boolean): void => {
    if (!x) return;
    for (const s of [w, w.others]) {
      s.tokens += x.tok;
      s.cacheRead += x.reads;
      if (listPrice) s.cost = money(s.cost + x.cost);
      else s.spend = money(s.spend + x.cost);
      s.topTier.tokens += x.fable ?? 0;
      s.topTier.cacheRead += x.fableReads ?? 0;
    }
    w.others.machines = [...new Set([...w.others.machines, ...x.hosts.split(',')])].sort();
  };
  add(t.five, m.five, false);
  add(t.week, m.week, false);
  add(t.month, m.month, true);
  const counted = new Set([m.five, m.week, m.month].flatMap((x) => (x ? x.hosts.split(',') : [])));
  for (const e of only) {
    const host = e.brief.own!.host;
    if (counted.has(host) && !t.machines.some((x) => x.machine === host)) t.machines.push({ machine: host, label: e.label, self: false, syncedAt: null, briefOnly: true });
  }
}

/**
 * The freshest reading of a window the account reported (`usage_readings`), measured inside the window its reset names:
 * what places a window when no readout says where it is (`oak query usage`, `oak usage --window`). The weekly windows run
 * on a fixed schedule, so a past weekly reset is rolled forward by whole weeks; a 5-hour reset that has passed ended its
 * window, and no 5-hour window runs until a reading names the next. Nor does one while the Claude account has no
 * five-hour limit, as the readouts decide it, by its answers on every machine (observe.ts noFiveHourLimitIfNewest,
 * UsageLine.fiveNoneAt), never by a share.
 */
export function latestReset(db: DatabaseSync, agent: string, kind: 'five' | 'week', now = Date.now()): number | null {
  if (agent === 'claude' && kind === 'five' && (require('../observe') as typeof import('../observe')).usageLine(process.cwd(), '').fiveNoneAt !== null) return null;
  const period = kind === 'five' ? FIVE_HOURS_MS : WEEK_MS;
  const self = selfIds(db);
  const account = agent === 'codex' ? (require('../codex') as typeof import('../codex')).codexAccountId() ?? codexAccountOf(db) : countedAccount(db).account;
  const marks = self.map(() => '?').join(', ');
  const row = db.prepare(`SELECT reset_ms FROM usage_readings WHERE agent = ? AND kind = ? AND reset_ms IS NOT NULL
    AND (machine_id IN (${marks})${account === null ? '' : ' OR account = ?'}) ORDER BY measured_ms DESC LIMIT 1`)
    .get(agent, kind, ...self, ...(account === null ? [] : [account])) as { reset_ms: number } | undefined;
  if (!row) return null;
  let reset = row.reset_ms;
  if (reset > now) return reset;
  if (kind === 'five') return null;
  reset += Math.ceil((now - reset) / period) * period;
  return reset === now ? reset + period : reset;
}

/** A named window, placed: the account's 5-hour and weekly windows (by their latest reading), the bill cycle, the
 *  calendar month (UTC), the last day, or everything. */
export function namedWindow(db: DatabaseSync, name: string, agent: string, now = Date.now()): UsageWindowSpan | null {
  switch (name) {
    case '5h':
      return rollingWindow(FIVE_HOURS_MS, latestReset(db, agent, 'five', now), now);
    case 'week':
      return rollingWindow(WEEK_MS, latestReset(db, agent, 'week', now), now);
    case 'bill':
      return billCycle(now, agent === 'codex' ? (require('../account-billing') as typeof import('../account-billing')).accountBillDay('codex', db) ?? null : billDayOf(db));
    case 'month': {
      const d = new Date(now);
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      return { start, end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), reset: null };
    }
    case 'day':
      return { start: now - 86400_000, end: now + 1, reset: null };
    case 'all':
      return { start: 0, end: now + 1, reset: null };
    default:
      return null;
  }
}

export const USAGE_WINDOWS = ['5h', 'week', 'bill', 'month', 'day', 'all'] as const;
export const USAGE_GROUPS = ['machine', 'model', 'session', 'day', 'agent', 'account'] as const;

/** Past this long, a breakdown that needs no session reads the daily rollup (`usage_daily`), whole days at a time. */
export const DAILY_AFTER_MS = 35 * 86400_000;

/** The SQL of a usage breakdown: one row per group, its tokens (input + output + cache creation), their parts, cache reads
 *  apart, list-price cost, messages, and first and last message; a session's with its own beside them. `account` and `self` restrict it to the rows the
 *  account's windows count (UsageTotals). A span longer than DAILY_AFTER_MS, grouped by anything but session, is read
 *  from the daily rollup, in whole UTC days (its first and last message are then those days). */
export function usageBreakdownSql(by: (typeof USAGE_GROUPS)[number], span: { start: number; end: number },
  opts: { agent?: string; machine?: readonly string[]; account?: string | null; codexAccount?: string | null; self?: readonly string[]; limit: number }): { sql: string; args: (string | number)[] } {
  const daily = span.end - span.start > DAILY_AFTER_MS && by !== 'session';
  const t = daily ? 'd' : 'u';
  const key = by === 'day' ? (daily ? 'd.day' : "strftime('%Y-%m-%d', u.ts / 1000, 'unixepoch')") : by === 'session' ? "u.machine_id || '/' || u.session_id"
    : by === 'machine' ? `${t}.machine_id` : by === 'model' ? `${t}.model` : by === 'agent' ? `${t}.agent` : `coalesce(${t}.account, '')`;
  const group = by === 'session' ? 'u.machine_id, u.session_id' : key;
  const where: string[] = daily ? ["d.day >= strftime('%Y-%m-%d', ? / 1000, 'unixepoch')", "d.day <= strftime('%Y-%m-%d', (? - 1) / 1000, 'unixepoch')"] : ['u.ts >= ?', 'u.ts < ?'];
  const args: (string | number)[] = [span.start, span.end];
  if (opts.agent) { where.push(`${t}.agent = ?`); args.push(opts.agent); }
  if (opts.machine) { where.push(`${t}.machine_id IN (${opts.machine.map(() => '?').join(', ')})`); args.push(...opts.machine); }
  if (opts.account !== undefined && opts.account !== null && opts.self) {
    // Each agent's rows by its own account: the Claude account counted, and the Codex account this machine is signed in to.
    where.push(`(${t}.machine_id IN (${opts.self.map(() => '?').join(', ')}) OR (${t}.agent = 'claude' AND ${t}.account = ?) OR (${t}.agent = 'codex' AND ${t}.account = ?))`);
    args.push(...opts.self, opts.account, opts.codexAccount ?? '');
  }
  // A session's row counts every agent it started (their transcripts' messages name it): `agents` says how many, and the
  // `own_` figures its own turns alone, null where a message's agent is unknown (a record from an OAK before schema 6).
  const own = (v: string): string => `CASE WHEN count(u.worker) = count(*) THEN total(CASE WHEN u.worker = '' THEN ${v} ELSE 0 END) END`;
  const extra = by === 'session' ? `, u.machine_id AS machine, u.session_id AS session, (SELECT s.title FROM sessions s WHERE s.machine_id = u.machine_id AND s.session_id = u.session_id) AS title,
      count(DISTINCT nullif(u.worker, '')) AS agents, ${own('u.input + u.output + u.cache_create')} AS own_tokens, ${own('u.cache_read')} AS own_cache_read,
      round(${own('u.cost')}, 4) AS own_cost`
    : by === 'machine' ? `, (SELECT coalesce(m.saved_label, m.label) FROM machines m WHERE m.machine_id = ${t}.machine_id) AS label` : '';
  const sums = daily
    ? 'total(d.messages) AS messages, total(d.input + d.output + d.cache_create) AS tokens, total(d.input) AS input, total(d.output) AS output, total(d.cache_create) AS cache_create, total(d.cache_create_1h) AS cache_create_1h, total(d.cache_read) AS cache_read, round(total(d.cost), 4) AS cost, total(d.cost_approx) AS cost_approx, min(d.day) AS first_day, max(d.day) AS last_day'
    : 'count(*) AS messages, total(u.input + u.output + u.cache_create) AS tokens, total(u.input) AS input, total(u.output) AS output, total(u.cache_create) AS cache_create, total(u.cache_create_1h) AS cache_create_1h, total(u.cache_read) AS cache_read, round(total(u.cost), 4) AS cost, total(u.cost_approx) AS cost_approx, min(u.ts) AS first_ts, max(u.ts) AS last_ts';
  return {
    sql: `SELECT ${key} AS key${extra}, ${sums} FROM ${daily ? 'usage_daily d' : 'usage_messages u'} WHERE ${where.join(' AND ')} GROUP BY ${group} ORDER BY ${by === 'day' ? 'key' : 'tokens DESC, key'} LIMIT ?`,
    args: [...args, opts.limit],
  };
}

/** Each other machine's latest reading of each Claude window (`usage_readings`), shaped as the readouts take a saved
 *  machine's (machine-usage.ts MachineUsageEntry): its 5-hour, weekly and per-model shares, each with when that machine
 *  measured it (its clock) and its window's reset, the estimate and budget its status line projected, and its bill-cycle
 *  month; and when the account last answered it with no five-hour window and with one (`fiveNoneAt`, `fiveSeenAt`); named
 *  by the label the machine is known by here, with its clock's difference from this one where a usage pull measured it.
 *  The readout's own rules (the freshest share measured inside the latest window, this machine's live share first; the
 *  newest answer for whether the account has a five-hour limit) then choose among them (observe.ts fillFromMachines). */
export function machineReadingEntries(db: DatabaseSync): MachineUsageEntry[] {
  const self = new Set(selfIds(db));
  // An index seek for each machine's latest reading of each kind, never a scan: the readings are kept as history (ingest.ts
  // USAGE_HISTORY_MS) and this runs on every readout, where a scan of three machines' year of readings took 0.2 s. The
  // machines are the readings' own, stepped through the primary key; the answers (kind `limit`, which only the Claude
  // account's cache writes) are found through an index of their own, `usage_readings_answers`.
  const ids = (db.prepare(`WITH RECURSIVE m(id) AS (SELECT min(machine_id) FROM usage_readings
      UNION ALL SELECT (SELECT min(machine_id) FROM usage_readings WHERE machine_id > m.id) FROM m WHERE m.id IS NOT NULL) SELECT id FROM m WHERE id IS NOT NULL`)
    .all() as { id: string }[]).map((x) => x.id).filter((id) => !self.has(id));
  const cols = 'kind, no_limit, label, account, pct, reset_ms, start_ms, measured_ms, tokens, budget, reads, cost, cost_budget';
  const share = db.prepare(`SELECT ${cols} FROM usage_readings WHERE machine_id = ? AND agent = 'claude' AND kind = ? ORDER BY measured_ms DESC LIMIT 1`);
  const answer = db.prepare(`SELECT ${cols} FROM usage_readings WHERE kind = 'limit' AND machine_id = ? AND no_limit = ? ORDER BY measured_ms DESC LIMIT 1`);
  const named = db.prepare('SELECT coalesce(saved_label, label) AS label, skew_ms FROM machines WHERE machine_id = ?');
  const by = new Map<string, MachineUsageEntry>();
  for (const id of ids) {
    const rows = [...['five', 'week', 'model', 'month'].map((k) => share.get(id, k)), answer.get(id, 0), answer.get(id, 1)].filter(Boolean) as {
      kind: string; no_limit: number; label: string; account: string | null; pct: number | null; reset_ms: number | null; start_ms: number | null; measured_ms: number;
      tokens: number | null; budget: number | null; reads: number | null; cost: number | null; cost_budget: number | null }[];
    if (!rows.length) continue;
    const m = named.get(id) as { label: string | null; skew_ms: number | null } | undefined;
    const e: MachineUsageEntry = { label: plainLabel(m?.label || id) || id, target: '', skewMs: m?.skew_ms ?? 0, rttMs: null, host: id,
      brief: { brief: 1, account: null, at: 0, five: null, week: null, fable: null, month: null, own: null } };
    by.set(id, e);
    const b = e.brief;
    for (const r of rows) {
      if (r.measured_ms >= b.at) {
        b.at = r.measured_ms;
        b.account = r.account && /^[0-9a-f]{12}$/.test(r.account) ? r.account : b.account;
      }
      const w = r.pct === null ? null : { pct: r.pct, reset: r.reset_ms, at: r.measured_ms, tok: r.tokens, total: r.budget };
      // The account's answers on its five-hour limit (kind `limit`): the newest with no 5h window and the newest with one,
      // the two times that machine's brief carries.
      if (r.kind === 'limit') {
        if (r.no_limit === 1) b.fiveNoneAt = r.measured_ms;
        else b.fiveSeenAt = r.measured_ms;
      } else if (r.kind === 'five') b.five = w;
      else if (r.kind === 'week') b.week = w;
      else if (r.kind === 'model') b.fable = w && { ...w, label: /^[\w .+-]{1,40}$/.test(r.label) ? r.label : null };
      else if (r.kind === 'month' && r.tokens !== null) b.month = { tok: r.tokens, total: r.budget, reset: r.reset_ms, reads: r.reads, cost: r.cost, costTotal: r.cost_budget };
    }
  }
  // A machine whose readings name no account (none measured yet) is still signed in to one, which its records say.
  const signedIn = db.prepare("SELECT account FROM accounts WHERE machine_id = ? AND agent = 'claude' ORDER BY last_ms DESC LIMIT 1");
  for (const [m, e] of by) {
    if (e.brief.account !== null) continue;
    const acct = (signedIn.get(m) as { account: string } | undefined)?.account;
    if (acct && /^[0-9a-f]{12}$/.test(acct)) e.brief.account = acct;
  }
  return [...by.values()];
}

/** What the other machines whose rows a window counts measured in it (UsageWindowTotals.others), in the shape the status
 *  line and the readouts' tooltips take it (observe.ts UsageLine.machineMeasured): per window, their tokens, cache
 *  reads and spend (the month's at list price), the window, and which machines; null when no other machine counts. */
export function othersMeasured(t: UsageTotals): UsageLineMeasured {
  const names = new Map(t.machines.map((m) => [m.machine, m.label ?? m.machine]));
  const hosts = (w: UsageWindowTotals): string => [...w.others.machines].sort().join(',');
  const any = (w: UsageWindowTotals): boolean => w.others.machines.length > 0;
  if (!any(t.five) && !any(t.week) && !any(t.month)) return null;
  const all = new Set([...t.five.others.machines, ...t.week.others.machines, ...t.month.others.machines]);
  return {
    five: any(t.five) && t.five.reset !== null ? { tok: t.five.others.tokens, reads: t.five.others.cacheRead, cost: t.five.others.spend, reset: t.five.reset, hosts: hosts(t.five) } : null,
    week: any(t.week) && t.week.reset !== null ? { tok: t.week.others.tokens, reads: t.week.others.cacheRead, cost: t.week.others.spend, fable: t.week.others.topTier.tokens,
      fableReads: t.week.others.topTier.cacheRead, reset: t.week.reset, hosts: hosts(t.week) } : null,
    month: any(t.month) ? { tok: t.month.others.tokens, reads: t.month.others.cacheRead, cost: t.month.others.cost, start: t.month.start, reset: t.month.end, hosts: hosts(t.month) } : null,
    machines: [...all].sort().map((h) => plainLabel(names.get(h) ?? h)).join(', '),
  };
}

type UsageLineMeasured = {
  five: { tok: number; reads: number; cost: number; reset: number; hosts: string } | null;
  week: { tok: number; reads: number; cost: number; fable: number; fableReads: number; reset: number; hosts: string } | null;
  month: { tok: number; reads: number; cost: number; start: number; reset: number; hosts: string } | null;
  machines: string;
} | null;

/** Whether the index holds any other machine's usage: what the readout takes from it, rather than from the saved
 *  machines' briefs, only then. */
export function holdsOtherUsage(db: DatabaseSync): boolean {
  const self = selfIds(db);
  return !!db.prepare(`SELECT 1 FROM usage_messages WHERE machine_id NOT IN (${self.map(() => '?').join(', ')}) LIMIT 1`).get(...self);
}
