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
}

export interface AgentBreakdown {
  agent: 'claude' | 'codex';
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
  for (const b of best.values()) {
    let key: string;
    if (by === 'week') key = weekKey(b.tsMs, weekAnchorMs);
    else if (by === 'month') key = monthKey(b.tsMs, billDay);
    else if (by === 'model') key = b.model || '(unknown model)';
    else {
      key = path.basename(b.file, '.jsonl');
      sessLabel.set(key, path.basename(path.dirname(b.file)));
    }
    accInto(map, key, b.t, b.model);
  }
  const labelOf = (k: string): string =>
    by === 'week' ? `week of ${k}` : by === 'session' ? `${k.slice(0, 8)}… (${sessLabel.get(k) ?? ''})` : k;
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
    by === 'week' ? `week of ${k}` : by === 'session' ? `${k.slice(0, 28)}… (${sessLabel.get(k) ?? ''})` : k;
  return finish('codex', sinceMs, map, labelOf);
}
