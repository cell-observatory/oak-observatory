import type { DatabaseSync } from 'node:sqlite';
import { readPrefs, billDay, setAccountBillDayReader, type Prefs } from './prefs';
import { machineHostTag, claudeAccountTag } from './machine-usage';
import { codexAccountId } from './codex';

export interface BillDaySetting { day: number; at: number; account: string }
export type AccountBilling = Partial<Record<'claude' | 'codex', BillDaySetting>>;
type BillRow = { machine_id: string; agent: string; account: string; day: number; updated_ms: number };

/** Local settings to publish with usage records. Legacy preferences rank below an explicit new setting;
 *  a subscription anniversary inferred from Claude ranks below either. Zero explicitly selects calendar months. */
export function localBillDays(prefs: Prefs = readPrefs()): BillRow[] {
  const rows: BillRow[] = [];
  for (const agent of ['claude', 'codex'] as const) {
    const saved = prefs.accountBilling?.[agent];
    const legacy = agent === 'claude' ? prefs.billDay : prefs.gptBillDay;
    if (agent === 'codex' && !saved && legacy == null) continue;
    const account = (agent === 'claude' ? claudeAccountTag() : codexAccountId()) ?? '';
    const setting = saved && saved.account === account && (legacy ?? 0) === saved.day ? saved : null;
    const inferred = agent === 'claude' ? billDay({}) : null;
    const day = setting?.day ?? legacy ?? inferred;
    if (day != null) rows.push({ machine_id: machineHostTag(), agent, account, day,
      updated_ms: setting?.at ?? (legacy == null ? -1 : 0) });
  }
  return rows;
}

/** Resolve one account's setting identically on every machine. Last explicit write wins; equal times
 *  (including legacy preferences) break ties by machine id. An unsigned machine takes one unambiguous account. */
export function accountBillDay(agent: 'claude' | 'codex', db?: DatabaseSync): number | undefined {
  const local = localBillDays();
  let rows: BillRow[] = [];
  const opened = db ? null : (require('./index/db') as typeof import('./index/db')).openIndexReadOnly();
  try {
    const source = db ?? (opened?.ok ? opened.db : null);
    if (source) rows = source.prepare('SELECT machine_id, agent, account, day, updated_ms FROM account_bill_days WHERE agent = ?').all(agent) as BillRow[];
  } catch { /* database unavailable: the local setting still applies */ }
  finally { if (opened?.ok) opened.close(); }
  const own = local.filter((r) => r.agent === agent);
  rows = [...rows.filter((r) => !own.some((o) => o.machine_id === r.machine_id && o.account === r.account)), ...own];
  let account = (agent === 'claude' ? claudeAccountTag() : codexAccountId()) ?? '';
  if (!account) {
    const named = [...new Set(rows.map((r) => r.account).filter(Boolean))];
    if (named.length > 1) return own[0]?.day;
    account = named[0] ?? '';
  }
  const candidates = rows.filter((r) => r.account === account || r.account === '');
  candidates.sort((a, b) => b.updated_ms - a.updated_ms || (a.machine_id < b.machine_id ? 1 : a.machine_id > b.machine_id ? -1 : 0));
  return candidates[0]?.day;
}

export function setAccountBillDay(agent: 'claude' | 'codex', day: number): void {
  if (!Number.isInteger(day) || day < 0 || day > 31) throw new Error('bill day must be 0–31');
  const prefs = readPrefs();
  const key = agent === 'claude' ? 'billDay' : 'gptBillDay';
  if (day) prefs[key] = day; else delete prefs[key];
  prefs.accountBilling = { ...prefs.accountBilling, [agent]: { day, at: Date.now(),
    account: (agent === 'claude' ? claudeAccountTag() : codexAccountId()) ?? '' } };
  (require('./prefs') as typeof import('./prefs')).writePrefs(prefs);
}

setAccountBillDayReader((agent) => accountBillDay(agent));
