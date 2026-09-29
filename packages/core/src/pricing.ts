// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cell Observatory
/**
 * API list prices per million tokens, for the usage breakdown's ~$ figures.
 *
 * These are ESTIMATES by construction: subscription accounts are not billed per token, and the
 * only authoritative per-session figure is the one Claude Code computes itself
 * (`cost.total_cost_usd`, kept in the statusline spend ledger — 8 days). The table exists for
 * what the ledger cannot answer: history older than the ledger, per-model splits, and codex,
 * none of which report a price of their own. Rates verified 2026-09-03 against the public
 * Anthropic/OpenAI rate cards; an unknown model uses its family's nearest rate and is flagged
 * `approx` so no surface presents a guess as a reading.
 *
 * The dated plan-limit promotion table lives here too (mirror: the statusline installer embeds
 * the same rows in `packages/cli/statusline/install-statusline.sh` — that script is self-contained
 * by design; keep the two in sync).
 */

export interface ModelRate {
  /** USD per 1M tokens. `write` is the 5-minute cache-write rate; `read` the cache-read rate. */
  input: number;
  output: number;
  write: number;
  read: number;
  /** True when the model matched no table row and inherited a family fallback. */
  approx?: boolean;
}

// Ordered prefix table — first hit wins, MOST SPECIFIC FIRST (the retry below does a substring match,
// so a longer prefix like `claude-opus-4-5` must precede `claude-opus-4`, or the shorter one wins and
// mis-prices it). Opus 4.5+ dropped to the $5/$25 tier (same as Opus 5); only Opus 4.0/4.1 keep the
// old $15/$75. NOTE: Opus 4.7/4.8 list prices are assigned to that same post-4.5 tier — confirm
// against the current Anthropic rate card.
const CLAUDE_RATES: [string, ModelRate][] = [
  ['claude-fable-5', { input: 10, output: 50, write: 12.5, read: 0.25 }],
  ['claude-mythos-5', { input: 10, output: 50, write: 12.5, read: 0.25 }],
  ['claude-opus-5', { input: 5, output: 25, write: 6.25, read: 0.5 }],
  ['claude-sonnet-5', { input: 2, output: 10, write: 2.5, read: 0.2 }],
  ['claude-opus-4-8', { input: 5, output: 25, write: 6.25, read: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, write: 6.25, read: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, write: 6.25, read: 0.5 }],
  ['claude-opus-4-5', { input: 5, output: 25, write: 6.25, read: 0.5 }],
  ['claude-opus-4', { input: 15, output: 75, write: 18.75, read: 1.5 }],
  ['claude-sonnet-4', { input: 3, output: 15, write: 3.75, read: 0.3 }],
  ['claude-haiku-4', { input: 1, output: 5, write: 1.25, read: 0.1 }],
  ['claude-3-5-sonnet', { input: 3, output: 15, write: 3.75, read: 0.3 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, write: 1, read: 0.08 }],
];

const GPT_RATES: [string, ModelRate][] = [
  ['gpt-5.2-codex', { input: 1.75, output: 14, write: 0, read: 0.175 }],
  ['gpt-5.2', { input: 1.75, output: 14, write: 0, read: 0.175 }],
  ['gpt-5.1', { input: 1.25, output: 10, write: 0, read: 0.125 }],
  ['gpt-5', { input: 1.25, output: 10, write: 0, read: 0.125 }],
];

/** Rate for a model id/display name; falls back to the family's middle tier, flagged approx. */
export function modelRate(model: string): ModelRate {
  const m = (model || '').toLowerCase().trim();
  // `codex*` (e.g. codex's own `codex-auto-review` turns) are OpenAI/GPT calls under an opaque name —
  // family-price them like GPT so they carry an (approx) cost instead of blanking the whole GPT bucket.
  const table = m.startsWith('gpt') || m.startsWith('o') || m.startsWith('codex') ? GPT_RATES : CLAUDE_RATES;
  for (const [prefix, rate] of table) {
    if (m === prefix || (m.startsWith(prefix + '-') && /^\d{4}-\d{2}-\d{2}$/.test(m.slice(prefix.length + 1)))) return rate;
  }
  // Display names ("Fable 5", "Opus 4.8") and undashed dated ids ("claude-opus-4-8-20260115") reach
  // here. Normalize spaces AND dots to dashes ("Opus 4.8" → "opus-4-8"), then match the FULL bare
  // prefix as a substring. The table is most-specific-first, so "opus-4-8" hits the 4.8 row before the
  // "opus-4" catch-all; an Opus 4.0 id contains "opus-4" but not "opus-4-8", so it still lands on the
  // old-tier row. (The earlier 2-segment match collapsed every opus-4.x to "opus-4" and every 3-5-* to
  // "3-5", mis-pricing Opus 4.5+ as 4.0 and Sonnet 3.5 as Haiku 3.5.)
  const norm = m.replace(/\s+/g, '-').replace(/\./g, '-');
  for (const [prefix, rate] of CLAUDE_RATES) {
    if (norm.includes(prefix.replace('claude-', ''))) return rate;
  }
  if (m.startsWith('provider:') || !/^(gpt|o[134]|codex|claude|opus|sonnet|haiku|fable)/.test(m)) return { input: 0, output: 0, write: 0, read: 0, approx: true };
  const fb = /^(gpt|o[134]|codex)/.test(m) ? GPT_RATES[GPT_RATES.length - 1][1] : { input: 5, output: 25, write: 6.25, read: 0.5 };
  return { ...fb, approx: true };
}

export interface UsageSplit {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** ~USD for one usage split under one model, at API list prices. */
export function priceUsage(model: string, u: UsageSplit): { usd: number; approx: boolean; known: boolean } {
  const r = modelRate(model);
  const usd =
    (u.input * r.input + u.output * r.output + u.cacheWrite * r.write + u.cacheRead * r.read) / 1_000_000;
  // A split with NO tokens (e.g. a `<synthetic>` transcript line) has nothing to price, so its
  // rate being unknown must not mark the bucket's dollars unavailable — one zero-token line used to
  // flip a whole week's $ to "—". `known` only reports a real unpriceable spend.
  const hasTokens = u.input + u.output + u.cacheWrite + u.cacheRead > 0;
  return { usd, approx: !!r.approx, known: !hasTokens || r.input + r.output + r.read + r.write > 0 };
}

export interface PlanPromo {
  /** Epoch ms bounds, label shown on surfaces, and the multiplier that maps the boosted budget
   *  to the post-promo one (e.g. 1.25/1.5: +50% now, permanent +25% after). */
  startMs: number;
  endMs: number;
  label: string;
  postMultiplier: number;
}

/** Anthropic's dated plan-limit promotions. Mirrored in the statusline installer — keep in sync. */
export const PLAN_PROMOS: PlanPromo[] = [
  { startMs: 1778630400_000, endMs: 1789344000_000, label: '+50%', postMultiplier: 1.25 / 1.5 },
];

/** The promotion live at `atMs` (default now), or null. */
export function activePromo(atMs = Date.now()): PlanPromo | null {
  for (const p of PLAN_PROMOS) {
    if (p.startMs <= atMs && atMs < p.endMs) return p;
  }
  return null;
}
