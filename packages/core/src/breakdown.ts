// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cell Observatory
/**
 * The detailed usage breakdown behind `oak usage --breakdown`: tokens and ~$
 * by week, month, model and session, for claude AND codex — the answer Claude's own `/usage`
 * gives, but for everything this machine can see, both agents, and priced.
 *
 * Claude's side scans the transcripts with the SAME rules the statusline scan earned the hard
 * way: per-message-id max-snapshot dedup spanning FILES (forks/resumes copy history), window
 * membership by line timestamp, machine-of-origin by the cwd's home root. Codex's side sums
 * per-event token deltas from its rollouts (the model active at each event), so a copied/forked
 * history and cumulative resets do not double-count. Dollars come from `priceUsage` (API list
 * prices — estimates, and marked so). Scope is THIS machine's disk; the caller says so.
 */

import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { graphemeHead } from './graphemes';
import { priceUsage, UsageSplit } from './pricing';
import { codexUsageDeltas } from './codex-events';
import { codexHome } from './codex';

export interface BreakdownBucket {
  key: string; // "2026-08-31" (week start) / "2026-08" (month) / model id / session file
  label: string;
  tokens: number; // input+output+cacheWrite — the plan-window unit
  cacheRead: number;
  usd: number; // ~$ at API list prices (incl. cache reads — the real compute value)
  usdKnown: boolean;
  usdApprox: boolean; // any part priced via a family fallback
  messages: number;
  /** By session: a worker transcript's row names the session that started it… */
  parent?: string;
  /** …and that session's row, its own, carries the figure with every agent of it listed here. */
  tree?: { agents: number; tokens: number; cacheRead: number; usd: number; usdKnown: boolean; usdApprox: boolean; messages: number };
}

export interface AgentBreakdown {
  agent: 'claude' | 'codex';
  usageSource?: 'database' | 'local';
  sinceMs: number;
  buckets: BreakdownBucket[];
  totals: { tokens: number; cacheRead: number; usd: number; usdApprox: boolean; usdKnown: boolean; messages: number };
}

export type BreakdownBy = 'week' | 'month' | 'model' | 'session';

const WEEK_MS = 7 * 86400_000;

/** Week bucket anchored to the account's weekly reset when known, else Monday 00:00 UTC. */
function weekKey(tsMs: number, anchorMs: number | null): string {
  if (anchorMs && anchorMs > 0) {
    const off = Math.floor((anchorMs - tsMs) / WEEK_MS) + 1;
    const start = anchorMs - off * WEEK_MS;
    return new Date(start).toISOString().slice(0, 10);
  }
  const d = new Date(tsMs);
  const day = (d.getUTCDay() + 6) % 7;
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  return new Date(start).toISOString().slice(0, 10);
}

/** Month bucket: the BILL CYCLE when a bill day is configured (anniversary billing — the cycle
 *  runs bill-day to bill-day, clamped to short months), else the calendar month. */
function monthKey(tsMs: number, billDay: number | null): string {
  if (!billDay || billDay <= 1) return new Date(tsMs).toISOString().slice(0, 7);
  const clamp = (y: number, m0: number): number => Math.min(billDay, new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate());
  const d = new Date(tsMs);
  let y = d.getUTCFullYear();
  let m0 = d.getUTCMonth();
  if (d.getUTCDate() < clamp(y, m0)) {
    m0 -= 1;
    if (m0 < 0) { m0 = 11; y -= 1; }
  }
  return new Date(Date.UTC(y, m0, clamp(y, m0))).toISOString().slice(0, 10);
}

interface Acc {
  tokens: number;
  cacheRead: number;
  usd: number;
  usdKnown: boolean;
  usdApprox: boolean;
  messages: number;
  parent?: string;
  tree?: BreakdownBucket['tree'];
}

function accInto(map: Map<string, Acc>, key: string, split: UsageSplit, model: string): void {
  const { usd, approx, known } = priceUsage(model, split);
  const a = map.get(key) ?? { tokens: 0, cacheRead: 0, usd: 0, usdKnown: true, usdApprox: false, messages: 0 };
  a.tokens += split.input + split.output + split.cacheWrite;
  a.cacheRead += split.cacheRead;
  a.usd += usd;
  a.usdKnown = a.usdKnown && known;
  a.usdApprox = a.usdApprox || approx;
  a.messages += 1;
  map.set(key, a);
}

function finish(agent: 'claude' | 'codex', sinceMs: number, map: Map<string, Acc>, labelOf: (k: string) => string): AgentBreakdown {
  const buckets = [...map.entries()]
    .map(([key, a]) => ({ key, label: labelOf(key), ...a }))
    .sort((x, y) => (x.key < y.key ? 1 : x.key > y.key ? -1 : 0));
  const totals = buckets.reduce(
    (t, b) => ({
      tokens: t.tokens + b.tokens,
      cacheRead: t.cacheRead + b.cacheRead,
      usd: t.usd + b.usd,
      usdKnown: t.usdKnown && b.usdKnown,
      usdApprox: t.usdApprox || b.usdApprox,
      messages: t.messages + b.messages,
    }),
    { tokens: 0, cacheRead: 0, usd: 0, usdKnown: true, usdApprox: false, messages: 0 }
  );
  return { agent, sinceMs, buckets, totals };
}

/**
 * Claude transcripts, deduped across files, bucketed.
 *
 * `weekAnchorMs`: the account's weekly reset (epoch ms) so week buckets match the real quota
 * cycles; null falls back to calendar weeks. `projectsDir` overrides for tests.
 */
export function claudeBreakdown(
  by: BreakdownBy,
  sinceMs: number,
  weekAnchorMs: number | null,
  projectsDir?: string,
  billDay: number | null = null
): AgentBreakdown {
  if (!projectsDir) {
    const stored = databaseBreakdown('claude', by, sinceMs, weekAnchorMs, billDay);
    if (stored) return stored;
  }
  const proj = projectsDir ?? path.join(claudeConfigDir(), 'projects');
  // Global dedup: the biggest snapshot per message id wins, wherever it appears; the bucket is
  // decided by that snapshot's own line (its timestamp/model/session), so a fork's copy never
  // moves history into the fork's week.
  const best = new Map<string, { t: UsageSplit; tsMs: number; model: string; file: string; unit: number }>();
  const walk = (dir: string): string[] => {
    const outp: string[] = [];
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return outp;
    }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) outp.push(...walk(fp));
      else if (e.isFile() && e.name.endsWith('.jsonl')) outp.push(fp);
    }
    return outp;
  };
  for (const fp of walk(proj)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(fp);
    } catch {
      continue;
    }
    if (st.mtimeMs < sinceMs) continue;
    let text: string;
    try {
      text = fs.readFileSync(fp, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type === 'api-request-blob') continue;
      const m = o?.message;
      const u = m?.usage;
      if (!u || typeof u !== 'object') continue;
      const tsMs = Date.parse(o?.timestamp ?? '');
      if (!isFinite(tsMs) || tsMs < sinceMs) continue;
      const split: UsageSplit = {
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheWrite: Number(u.cache_creation_input_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        // The writes kept an hour, where the line splits them by lifetime; fast mode and US-only inference where recorded.
        cacheWrite1h: u.cache_creation && typeof u.cache_creation === 'object' ? Number(u.cache_creation.ephemeral_1h_input_tokens) || 0 : null,
        speed: typeof u.speed === 'string' ? u.speed : null,
        geo: typeof u.inference_geo === 'string' ? u.inference_geo : null,
      };
      const unit = split.input + split.output + split.cacheWrite;
      const mid = typeof m.id === 'string' && m.id ? m.id : `${fp}:${tsMs}:${unit}`;
      const prev = best.get(mid);
      if (!prev || unit > prev.unit) {
        best.set(mid, { t: split, tsMs, model: String(m.model ?? ''), file: fp, unit });
      }
    }
  }
  const map = new Map<string, Acc>();
  const sessLabel = new Map<string, string>();
  const parentOf = new Map<string, string>();
  for (const b of best.values()) {
    let key: string;
    if (by === 'week') key = weekKey(b.tsMs, weekAnchorMs);
    else if (by === 'month') key = monthKey(b.tsMs, billDay);
    else if (by === 'model') key = b.model || '(unknown model)';
    else {
      key = path.basename(b.file, '.jsonl');
      // A worker's transcript (`<session>/subagents/…`) is a row of its own, named for the session that started it.
      const parts = path.relative(proj, b.file).split(path.sep);
      if (parts[2] === 'subagents') parentOf.set(key, parts[1]);
      sessLabel.set(key, parts[2] === 'subagents' ? `agent of ${graphemeHead(parts[1], 8)}…` : path.basename(path.dirname(b.file)));
    }
    accInto(map, key, b.t, b.model);
  }
  // A session's row is its own turns; one that started agents also carries the figure with them, so its own never reads as
  // the task's.
  for (const [key, parent] of parentOf) {
    const w = map.get(key)!;
    const p = map.get(parent);
    w.parent = parent;
    if (!p) continue;
    const t = (p.tree ??= { agents: 0, tokens: p.tokens, cacheRead: p.cacheRead, usd: p.usd, usdKnown: p.usdKnown, usdApprox: p.usdApprox, messages: p.messages });
    t.agents += 1;
    t.tokens += w.tokens;
    t.cacheRead += w.cacheRead;
    t.usd += w.usd;
    t.usdKnown &&= w.usdKnown;
    t.usdApprox ||= w.usdApprox;
    t.messages += w.messages;
  }
  const labelOf = (k: string): string =>
    by === 'week' ? `week of ${k}` : by === 'session' ? `${graphemeHead(k, 8)}… (${sessLabel.get(k) ?? ''})` : k;
  return finish('claude', sinceMs, map, labelOf);
}

/** Codex rollouts: one cumulative `total_token_usage` per session file, bucketed the same way. */
export function codexBreakdown(
  by: BreakdownBy,
  sinceMs: number,
  weekAnchorMs: number | null,
  sessionsDir?: string,
  billDay: number | null = null
): AgentBreakdown {
  if (!sessionsDir) {
    const stored = databaseBreakdown('codex', by, sinceMs, weekAnchorMs, billDay);
    if (stored) return stored;
  }
  // Walk both live and archived rollouts, via codexHome() (honours CODEX_HOME the way every other
  // codex reader does — an inline env read diverged on a whitespace-only value). Archived rollouts were
  // silently absent from the GPT usage breakdown while present in every other codex view.
  const roots = sessionsDir ? [sessionsDir] : [path.join(codexHome(), 'sessions'), path.join(codexHome(), 'archived_sessions')];
  const map = new Map<string, Acc>();
  const sessLabel = new Map<string, string>();
  const walk = (dir: string, depth: number): string[] => {
    const outp: string[] = [];
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return outp;
    }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory() && depth < 5) outp.push(...walk(fp, depth + 1));
      else if (e.isFile() && e.name.endsWith('.jsonl')) outp.push(fp);
    }
    return outp;
  };
  const seen = new Set<string>();
  for (const fp of roots.flatMap((r) => walk(r, 0))) {
    for (const d of codexUsageDeltas(fp)) {
      if (d.ts < sinceMs || seen.has(d.id)) continue;
      seen.add(d.id);
      let key: string;
      if (by === 'week') key = weekKey(d.ts, weekAnchorMs);
      else if (by === 'month') key = monthKey(d.ts, billDay);
      else if (by === 'model') key = d.model || '(unknown model)';
      else { key = path.basename(fp, '.jsonl'); sessLabel.set(key, new Date(d.ts).toISOString().slice(0,10)); }
      accInto(map, key, d.usage, d.provider && d.provider !== 'openai' ? `provider:${d.provider}/${d.model}` : d.model);
    }
  }
  const labelOf = (k: string): string =>
    by === 'week' ? `week of ${k}` : by === 'session' ? `${graphemeHead(k, 28)}… (${sessLabel.get(k) ?? ''})` : k;
  return finish('codex', sinceMs, map, labelOf);
}

function databaseBreakdown(agent: 'claude' | 'codex', by: BreakdownBy, since: number, week: number | null, bill: number | null): AgentBreakdown | null {
  if (process.env.OAK_INDEX === 'off') return null;
  const ix = require('./index/api') as typeof import('./index/api');
  const opened = ix.useIndex({ kick: true });
  if (!opened.ok) return null;
  try {
    const usage = require('./index/usage') as typeof import('./index/usage');
    const account = agent === 'claude' ? usage.countedAccount(opened.db).account
      : (require('./codex') as typeof import('./codex')).codexAccountId() ?? usage.codexAccountOf(opened.db);
    const map = new Map<string, Acc>();
    const parents = new Map<string, string>();
    const rows = opened.db.prepare(`SELECT * FROM usage_messages WHERE agent = ? AND ts >= ? AND ts <= ?
      AND (? IS NULL OR account IS NULL OR account = ?)`).all(agent, since, Date.now(), account, account);
    for (const r of rows) {
      const session = String(r.session_id), worker = r.worker ? String(r.worker) : null;
      const key = by === 'week' ? weekKey(Number(r.ts), week) : by === 'month' ? monthKey(Number(r.ts), bill)
        : by === 'model' ? String(r.model) : worker ?? session;
      if (by === 'session' && worker) parents.set(worker, session);
      const model = agent === 'codex' && r.provider && r.provider !== 'openai' ? `provider:${r.provider}/${r.model}` : String(r.model);
      accInto(map, key, { input: Number(r.input), output: Number(r.output), cacheWrite: Number(r.cache_create),
        cacheWrite1h: r.cache_create_1h == null ? null : Number(r.cache_create_1h), cacheRead: Number(r.cache_read),
        speed: r.speed as string | null, geo: r.geo as string | null }, model);
    }
    for (const [key, parent] of parents) {
      const w = map.get(key)!, p = map.get(parent);
      w.parent = parent;
      if (!p) continue;
      const tree = (p.tree ??= { agents: 0, tokens: p.tokens, cacheRead: p.cacheRead, usd: p.usd, usdKnown: p.usdKnown, usdApprox: p.usdApprox, messages: p.messages });
      tree.agents++; tree.tokens += w.tokens; tree.cacheRead += w.cacheRead; tree.usd += w.usd; tree.messages += w.messages;
      tree.usdKnown &&= w.usdKnown; tree.usdApprox ||= w.usdApprox;
    }
    const names = new Map((opened.db.prepare('SELECT session_id, cwd FROM sessions').all() as { session_id: string; cwd: string | null }[])
      .map((r) => [r.session_id, r.cwd ? path.basename(r.cwd) : 'session']));
    const label = (key: string): string => by === 'week' ? `week of ${key}` : by !== 'session' ? key
      : `${graphemeHead(key, agent === 'claude' ? 8 : 28)}… (${parents.has(key) ? `agent of ${graphemeHead(parents.get(key)!, 8)}…` : names.get(key) ?? 'session'})`;
    return { ...finish(agent, since, map, label), usageSource: 'database' };
  } finally { opened.close(); }
}
