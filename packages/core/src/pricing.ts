// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Cell Observatory
/**
 * API list prices per million tokens, for the usage breakdown's ~$ figures.
 *
 * These are ESTIMATES by construction: subscription accounts are not billed per token, and the
 * only authoritative per-session figure is the one Claude Code computes itself
 * (`cost.total_cost_usd`, kept in the statusline spend ledger — 8 days). The table exists for
 * what the ledger cannot answer: history older than the ledger, per-model splits, and codex,
 * none of which report a price of their own. Rates verified 2026-11-03 against the public
 * Anthropic/OpenAI rate cards; a model no row lists uses its family's nearest row and is flagged
 * `approx` so no surface presents a guess as a reading.
 *
 * The dated plan-limit promotion table lives here too (mirror: the statusline installer embeds
 * the same rows in `packages/cli/statusline/install-statusline.sh` — that script is self-contained
 * by design; keep the two in sync).
 */

import { createHash } from 'crypto';

export interface RateTier {
  /** USD per 1M tokens. `write` is the 5-minute cache-write rate, `write1h` the 1-hour one; `read` the cache-read rate. */
  input: number;
  output: number;
  write: number;
  write1h: number;
  read: number;
}

export interface ModelRate extends RateTier {
  /** The long-context tier: a request whose prompt (input, cache reads and cache writes) is over `over` tokens is
   *  priced at it as a whole. */
  long?: RateTier & { over: number };
  /** Fast mode's input and output rates; the cache rates keep their multipliers on top. */
  fast?: { input: number; output: number };
  /** US-only inference (`inference_geo: "us"`) costs 1.1x on every category: Claude 4.6 and later. */
  geo?: boolean;
  /** True when the id matched no row and was priced from its family's nearest row. */
  approx?: boolean;
}

// Claude rows, given as the rate card lists them: input / 5-minute write / 1-hour write / cache read / output.
const claude = (input: number, write: number, write1h: number, read: number, output: number, more: Partial<ModelRate> = {}): ModelRate =>
  ({ input, output, write, write1h, read, ...more });
const OPUS_45 = claude(5, 6.25, 10, 0.5, 25);
const OPUS_4 = claude(15, 18.75, 30, 1.5, 75);
const SONNET_4 = claude(3, 3.75, 6, 0.3, 15);
const CLAUDE_RATES: [string, ModelRate][] = [
  ['claude-fable-5-1', claude(10, 12.5, 20, 0.25, 50, { geo: true })],
  ['claude-fable-5', claude(10, 12.5, 20, 1, 50, { geo: true })],
  ['claude-mythos-5-1', claude(10, 12.5, 20, 0.25, 50, { geo: true })],
  ['claude-mythos-5', claude(10, 12.5, 20, 1, 50, { geo: true })],
  ['claude-opus-5-5', claude(4, 5, 8, 0.2, 20, { geo: true, fast: { input: 8, output: 40 } })],
  ['claude-opus-5', { ...OPUS_45, geo: true, fast: { input: 10, output: 50 } }],
  ['claude-opus-4-8', { ...OPUS_45, geo: true, fast: { input: 10, output: 50 } }],
  ['claude-opus-4-7', { ...OPUS_45, geo: true }],
  ['claude-opus-4-6', { ...OPUS_45, geo: true }],
  ['claude-opus-4-5', OPUS_45],
  ['claude-opus-4-1', OPUS_4],
  ['claude-opus-4', OPUS_4],
  ['claude-sonnet-5-5', claude(2, 2.5, 4, 0.1, 10, { geo: true })],
  ['claude-sonnet-5', claude(2, 2.5, 4, 0.2, 10, { geo: true })],
  ['claude-sonnet-4-6', { ...SONNET_4, geo: true }],
  ['claude-sonnet-4-5', SONNET_4],
  ['claude-sonnet-4', SONNET_4],
  ['claude-haiku-5-5', claude(0.1, 0.125, 0.2, 0.01, 0.5, { geo: true, long: { over: 100_000, ...claude(0.5, 0.625, 1, 0.05, 2.5) } })],
  ['claude-haiku-4-5', claude(1, 1.25, 2, 0.1, 5)],
  ['claude-3-5-sonnet', SONNET_4],
  ['claude-3-5-haiku', claude(0.8, 1, 1.6, 0.08, 4)],
];

// OpenAI rows, given as the rate card lists them: input / cached input / output, and the same over 272K tokens of
// prompt. OpenAI charges no cache write. The -pro models have no cached price, so a cached token costs the input rate.
const gpt = (input: number, read: number, output: number, long?: [number, number, number]): ModelRate => ({
  input, output, write: 0, write1h: 0, read,
  ...(long && { long: { over: 272_000, input: long[0], output: long[2], write: 0, write1h: 0, read: long[1] } }),
});
const GPT_RATES: [string, ModelRate][] = [
  ['gpt-6-astra', gpt(10, 1, 50, [20, 2, 75])],
  ['gpt-6.1-sol', gpt(2, 0.1, 10, [4, 0.2, 15])],
  ['gpt-6.1-terra', gpt(1, 0.05, 5, [2, 0.1, 7.5])],
  ['gpt-6-sol', gpt(2, 0.2, 10, [4, 0.4, 15])],
  ['gpt-6-luna', gpt(0.1, 0.01, 0.5, [0.2, 0.02, 0.75])],
  ['gpt-5.6-sol', gpt(4, 0.4, 20, [8, 0.8, 30])],
  ['gpt-5.6-terra', gpt(2, 0.2, 12, [4, 0.4, 18])],
  ['gpt-5.6-luna', gpt(0.2, 0.02, 1.2, [0.4, 0.04, 1.8])],
  ['gpt-5.5-pro', gpt(30, 30, 180, [60, 60, 270])],
  ['gpt-5.5', gpt(5, 0.5, 30, [10, 1, 45])],
  ['gpt-5.4-pro', gpt(30, 30, 180, [60, 60, 270])],
  ['gpt-5.4-mini', gpt(0.75, 0.075, 4.5)],
  ['gpt-5.4-nano', gpt(0.2, 0.02, 1.25)],
  ['gpt-5.4', gpt(2.5, 0.25, 15, [5, 0.5, 22.5])],
  ['gpt-5.2-pro', gpt(21, 21, 168)],
  ['gpt-5.2-codex', gpt(1.75, 0.175, 14)],
  ['gpt-5.2', gpt(1.75, 0.175, 14)],
  ['gpt-5.1', gpt(1.25, 0.125, 10)],
  ['gpt-5-pro', gpt(15, 15, 120)],
  ['gpt-5-mini', gpt(0.25, 0.025, 2)],
  ['gpt-5-nano', gpt(0.05, 0.005, 0.4)],
  ['gpt-5', gpt(1.25, 0.125, 10)],
];

// Other providers' models, priced only when the provider that billed them is known. Codex records its provider (`model_provider`), and usage reaches this file as
// `provider:<id>/<model>`, so a model id is priced only under the provider named here: the same
// Laguna id served by Ollama (local) or by another gateway stays unpriced. Exact ids only, no
// family fallback. None of these providers charges a cache write.
const PROVIDER_RATES: Record<string, [string, ModelRate][]> = {
  // OpenRouter, read 2026-09-29 from https://openrouter.ai/api/v1/models (the data behind each
  // model page, openrouter.ai/<id>). Ids are OpenRouter's lowercase slugs.
  openrouter: [
    ['poolside/laguna-s-2.1', { input: 0.09, output: 0.18, write: 0, write1h: 0, read: 0.009 }],
    ['poolside/laguna-xs-2.1', { input: 0.06, output: 0.12, write: 0, write1h: 0, read: 0.03 }],
    ['thinkingmachines/inkling', { input: 1, output: 4.05, write: 0, write1h: 0, read: 0.17 }],
    ['thinkingmachines/inkling-small', { input: 0.45, output: 1.2, write: 0, write1h: 0, read: 0.1 }],
  ],
};

const UNPRICED: ModelRate = { input: 0, output: 0, write: 0, write1h: 0, read: 0, approx: true };
/** A known price of nothing: OpenRouter's `:free` variants. Unlike UNPRICED, it is not approx. */
const FREE: ModelRate = { input: 0, output: 0, write: 0, write1h: 0, read: 0 };

/** Which price table priced a figure: a digest of the tables and of the rules below (bump RULES when a rule
 *  changes). The index stores it per message and prices again every row an older table priced. */
const RULES = 3;
export const PRICE_VERSION = createHash('sha256').update(JSON.stringify([RULES, CLAUDE_RATES, GPT_RATES, PROVIDER_RATES])).digest('hex').slice(0, 12);

// A Claude id's family and version: `claude-opus-4-5-20251101`, Bedrock's `us.anthropic.claude-opus-4-5-…-v1:0`,
// Vertex's `claude-opus-4-5@…`, a display name `Opus 4.5` and the older `claude-3-5-haiku` all read as one.
// A version part is one or two digits, so a date never reads as a minor version.
const CLAUDE_FAMILY = /(fable|mythos|opus|sonnet|haiku)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?/;
const CLAUDE_OLD = /(\d)(?:-(\d))?-(sonnet|haiku|opus)/;
type Ver = [number, number];
const cmpVer = (a: Ver, b: Ver) => a[0] - b[0] || a[1] - b[1];
function claudeVersion(norm: string): { family: string; v: Ver | null } | null {
  const o = CLAUDE_OLD.exec(norm);
  if (o) return { family: o[3], v: [+o[1], +(o[2] ?? 0)] };
  const f = CLAUDE_FAMILY.exec(norm);
  return f ? { family: f[1], v: f[2] ? [+f[2], +(f[3] ?? 0)] : null } : null;
}
// `gpt-5.4-mini` reads as version 5.4 with the suffix `-mini`.
function gptVersion(m: string): { v: Ver; suffix: string } | null {
  const g = /^gpt-(\d+)(?:\.(\d+))?(.*)$/.exec(m.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
  return g ? { v: [+g[1], +(g[2] ?? 0)], suffix: g[3] } : null;
}
// Each family's rows, newest first.
const CLAUDE_ROWS = CLAUDE_RATES.map(([id, rate]) => ({ ...claudeVersion(id)!, rate })).sort((a, b) => cmpVer(b.v!, a.v!));
const GPT_ROWS = GPT_RATES.map(([id, rate]) => ({ ...gptVersion(id)!, rate })).sort((a, b) => cmpVer(b.v, a.v));
const exact = (table: [string, ModelRate][], m: string) =>
  table.find(([id]) => m === id || (m.startsWith(id + '-') && /^\d{4}-\d{2}-\d{2}$/.test(m.slice(id.length + 1))))?.[1];

/** Rate for a model id or display name. An id whose version no row lists is priced from its family's newest row
 *  at or below that version (or its oldest, for an older one) and flagged approx: a newer model never reads as an
 *  exact price of an older one. */
export function modelRate(model: string): ModelRate {
  // A context tag (`claude-opus-4-8[1m]`) names the same model.
  const m = (model || '').toLowerCase().trim().replace(/\[[^\]]*\]$/, '');
  const via = /^provider:([^/]+)\/(.+)$/.exec(m);
  const hosted = via && Object.hasOwn(PROVIDER_RATES, via[1]) ? PROVIDER_RATES[via[1]].find(([id]) => id === via[2]) : undefined;
  if (hosted) return hosted[1];
  // OpenRouter serves a `<model>:free` variant of some models at no charge.
  if (via?.[1] === 'openrouter' && via[2].endsWith(':free')) return FREE;
  if (via) return UNPRICED;
  const listed = exact(GPT_RATES, m) ?? exact(CLAUDE_RATES, m);
  if (listed) return listed;
  // Spaces, dots and `@` become dashes ("Opus 4.8" → "opus-4-8").
  const c = claudeVersion(m.replace(/[\s.@]+/g, '-'));
  const rows = c ? CLAUDE_ROWS.filter((x) => x.family === c.family) : [];
  const same = c?.v && rows.find((x) => cmpVer(x.v!, c.v!) === 0);
  if (same) return same.rate;
  // Only an id in Anthropic's namespace takes a family's price on a guess; a gateway's or another provider's does not.
  const anthropic = !m.startsWith('provider:') && (m.includes('claude') || /^(opus|sonnet|haiku|fable)/.test(m));
  if (rows.length && anthropic) {
    const v = c!.v;
    return { ...(rows.find((x) => !v || cmpVer(x.v!, v) <= 0) ?? rows[rows.length - 1]).rate, approx: true };
  }
  // gpt-oss is OpenAI's open-weight model, usually run locally: like any local model it has no price here,
  // only under a provider's table above.
  if (m.startsWith('provider:') || m.startsWith('gpt-oss') || !/^(gpt|o[134]|codex|claude|opus|sonnet|haiku|fable)/.test(m)) return UNPRICED;
  if (/^(gpt|o[134]|codex)/.test(m)) {
    // `codex*` (e.g. codex's own `codex-auto-review` turns) and o-series ids are OpenAI calls under an opaque name:
    // priced from the gpt-5 row, approx, instead of blanking the whole GPT bucket.
    const g = gptVersion(m);
    const hit = g && (GPT_ROWS.find((x) => x.suffix === g.suffix && cmpVer(x.v, g.v) <= 0)
      ?? GPT_ROWS.find((x) => x.suffix === '' && cmpVer(x.v, g.v) === 0) ?? GPT_ROWS.find((x) => x.suffix === '' && cmpVer(x.v, g.v) <= 0));
    return { ...(hit ? hit.rate : GPT_RATES[GPT_RATES.length - 1][1]), approx: true };
  }
  return { ...OPUS_45, approx: true };
}

export interface UsageSplit {
  input: number;
  output: number;
  /** Every cache write, of either lifetime. */
  cacheWrite: number;
  cacheRead: number;
  /** The part of `cacheWrite` kept for 1 hour. Absent where the record does not split it: then every write is priced
   *  at the 5-minute rate and the figure is approx. */
  cacheWrite1h?: number | null;
  /** The request's `speed` ("fast") and `inference_geo` ("us"), where the record states them. */
  speed?: string | null;
  geo?: string | null;
}

/** ~USD for one request's usage under one model, at API list prices. A long-context tier applies to the request as a
 *  whole, so a sum of requests must be priced request by request. */
export function priceUsage(model: string, u: UsageSplit): { usd: number; approx: boolean; known: boolean } {
  const base = modelRate(model);
  const r = base.long && u.input + u.cacheRead + u.cacheWrite > base.long.over ? base.long : base;
  const w1h = Math.min(u.cacheWrite, Math.max(0, u.cacheWrite1h ?? 0));
  // Fast mode scales the input rate, and the cache rates with it, and the output rate.
  const fi = u.speed === 'fast' && base.fast ? base.fast.input / base.input : 1;
  const fo = u.speed === 'fast' && base.fast ? base.fast.output / base.output : 1;
  const geo = u.geo === 'us' && base.geo ? 1.1 : 1;
  const usd = geo * (fi * (u.input * r.input + (u.cacheWrite - w1h) * r.write + w1h * r.write1h + u.cacheRead * r.read) +
    fo * u.output * r.output) / 1_000_000;
  // A split with NO tokens (e.g. a `<synthetic>` transcript line) has nothing to price, so its
  // rate being unknown must not mark the bucket's dollars unavailable — one zero-token line used to
  // flip a whole week's $ to "—". `known` only reports a real unpriceable spend.
  const hasTokens = u.input + u.output + u.cacheWrite + u.cacheRead > 0;
  const unsplit = u.cacheWrite > 0 && u.cacheWrite1h == null && r.write1h !== r.write;
  return { usd, approx: !!base.approx || unsplit, known: !hasTokens || r.input + r.output + r.read + r.write > 0 || base === FREE };
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
