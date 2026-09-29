/**
 * The bundled statusline, drawn by the dashboard.
 *
 * The product ships a statusline (`packages/cli/statusline/install-statusline.sh`, which writes
 * `~/.claude/statusline.sh`) that Claude Code renders under every turn. The dashboard used to
 * render its own approximation of the third line and nothing else, so the same session read two
 * different ways depending on which surface you looked at. This module is the SAME statusline,
 * built from the same numbers, so the two cannot disagree.
 *
 * Everything here is a byte-for-byte port of the shell's own helpers, and the fidelity is the
 * point — each of these was measured against the real script's output, and each difference was
 * visible on screen:
 *
 *   - `uc` thresholds the TRUNCATED integer, so 49.6% is still green.
 *   - `bar` rounds a truncated percentage — 6.3% rules ZERO cells, not one — and marks the
 *     share with an UNDERLINE under the figures rather than a block beside them: the first pct%
 *     of CELLS are underlined and coloured, the rest dim and plain.
 *   - `human` TRUNCATES (1.19M → `1.1M`, 1.0M → `1M`), unlike core's compactTokens.
 *   - `untilStr` is `3d 11h` / `10h 42m` / `45m` / `now`, unlike core's compactDuration.
 *   - the ctx percentage truncates; the 5h/week percentages round.
 *
 * COLOUR: with the default theme these emit the script's own 16-colour codes at
 * every depth, so the row is identical. A theme the reader has EXPLICITLY chosen outranks that —
 * colorblind, light and mono re-tint through the palette, because an accessibility choice is an
 * instruction, not a preference to be overridden by a fidelity goal.
 */
import { displayWidth, fitVisible } from './textwidth';
import { ColorDepth, StateKey, tint } from './glyphs';

const DIM = '\x1b[2m';
const R = '\x1b[0m';
/** Both runs are U+2588; only the SGR differs. Forced, not taken from the glyph tier: `g.ramp[7]`
 *  is `#` in the safe/ascii sets and the bar would look nothing like the shipped one. */
const BLOCK = '█';

/** What the statusline is drawn from. Every field is optional: the row degrades to the script's own
 *  placeholders rather than inventing a number, exactly as the script does. */
export interface StatuslineData {
  now: number;
  clock?: string; // 'HH:MM' — injected, so a frame is a pure value
  date?: string; // '%b %d'
  branch?: string;
  cwdLabel?: string;
  title?: string;
  model?: string;
  effort?: string;
  thinking?: boolean;
  outputStyle?: string;
  /** ↑ input · ↓ output · ↺ cache reads — the split the script prints, not a single total. */
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  durationMs?: number;
  ctxPct?: number | null;
  ctxUsed?: number | null;
  ctxSize?: number | null;
  fivePct?: number | null;
  fiveResetMs?: number | null;
  /** The per-model weekly cap the account reports (the desktop app's "Fable" row): share, reset,
   *  and the model's display name — drawn as its own segment, share + countdown only. */
  fablePct?: number | null;
  fableResetMs?: number | null;
  fableLabel?: string | null;
  fableEst?: number | null;
  fableTotal?: number | null;
  fableReads?: number | null;
  fiveEst?: number | null;
  fiveTotal?: number | null;
  fiveCostTotal?: number | null;
  monthCost?: number | null;
  monthCostTotal?: number | null;
  monthTokens?: number | null;
  monthTokensTotal?: number | null;
  monthResetMs?: number | null;
  monthReads?: number | null;
  fiveReads?: number | null;
  weekReads?: number | null;
  noWindows?: boolean;
  weekCostTotal?: number | null;
  promo?: { label: string; dates: string } | null;
  fiveMeasured?: number | null;
  weekPct?: number | null;
  weekResetMs?: number | null;
  weekEst?: number | null;
  weekTotal?: number | null;
  weekMeasured?: number | null;
  /** Whose measurements these are: 'here', or 'N machines'. Rendered beside them, because a token
   *  total that cannot say whose it is reads as the account's when it may be one laptop's. */
  usageScope?: string;
  /** Dollars, as the client reported them. Rendered INSTEAD of the quota windows on a plan that has
   *  none — Enterprise and API keys report no rate limits, so those two bars can never fill, and an
   *  empty bar reads as "you have used nothing". */
  fiveCost?: number | null;
  weekCost?: number | null;
  /** Credit left on an account that reports a balance (codex does). `unlimited` says the plan has
   *  no ceiling — never rendered as `$0`, which would mean the opposite. */
  credits?: number | null;
  creditsUnlimited?: boolean;
  /** A spend cap and what has gone from it, where the account reports one. */
  spendUsed?: number | null;
  spendLimit?: number | null;
  /** Whose reporting these windows came from — 'codex' when Claude Code's own cache had nothing
   *  to say. Two clients measure two accounts, and a bar that cannot say whose it is invites the
   *  reader to plan against the wrong one. */
  usageFrom?: 'claude' | 'codex';
  /** How old the statusline's cache is, when it is old enough to matter. A frozen number that does
   *  not say it is frozen is the one thing worse than no number: the reader plans against a quota
   *  that moved hours ago. This can never contradict the shipped script, because a running script
   *  writes a fresh cache — a stale one means the script is NOT running. */
  staleAgeMs?: number | null;
}

/** `$0.42` · `$12.40` · `$1.2k`. Two decimals under $100, none above — a bill is read at a glance,
 *  and cents past ten dollars are noise. */
export function usd(n: number): string {
  const v = Math.max(0, n || 0);
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return `$${Math.round(v)}`;
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

/** The script's `human`: TRUNCATING compaction. 1_190_000 → `1.1M`, 1_000_000 → `1M`, 127_900 → `127k`. */
export function human(n: number): string {
  const v = Math.trunc(n) || 0;
  if (v >= 1_000_000) {
    const d = Math.trunc((v % 1_000_000) / 100_000);
    return d === 0 ? `${Math.trunc(v / 1_000_000)}M` : `${Math.trunc(v / 1_000_000)}.${d}M`;
  }
  if (v >= 1000) return `${Math.trunc(v / 1000)}k`;
  return `${v}`;
}

/** The script's `dur_str`: `1h04m` / `4m` / `30s`. */
export function durStr(ms: number): string {
  const s = Math.trunc(ms / 1000);
  if (s >= 3600) return `${Math.trunc(s / 3600)}h${String(Math.trunc((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.trunc(s / 60)}m`;
  return `${s}s`;
}

/** The script's `until_str`: `3d 11h` / `10h 42m` / `45m` / `now`. */
export function untilStr(resetMs: number, nowMs: number): string {
  const d = Math.trunc((resetMs - nowMs) / 1000);
  if (d <= 0) return 'now';
  if (d >= 86400) return `${Math.trunc(d / 86400)}d ${Math.trunc((d % 86400) / 3600)}h`;
  if (d >= 3600) return `${Math.trunc(d / 3600)}h ${Math.trunc((d % 3600) / 60)}m`;
  return `${Math.trunc(d / 60)}m`;
}

/** The script's `uc`, thresholding the TRUNCATED percentage — or the theme's own hue when the
 *  reader has chosen one. `themed` carries the palette key so both paths agree on meaning. */
function usageColor(pct: number, depth: ColorDepth, themed: boolean): { open: string; key: StateKey } {
  const p = Math.trunc(pct) || 0;
  const key: StateKey = p >= 80 ? 'risk' : p >= 50 ? 'pending' : 'kept';
  if (!themed) return { open: p >= 80 ? '\x1b[31m' : p >= 50 ? '\x1b[33m' : '\x1b[32m', key };
  // tint() closes its own run, so take just the opening sequence for the same one-run structure.
  return { open: tint('\0', key, depth).split('\0')[0], key };
}

/** The script's `bar`: the figures with a RULE under them — a `width`-cell field holding the
 *  figures LEFT-aligned, whose first pct% of CELLS are underlined and in the usage colour while
 *  the rest is dim and plain. Nothing is painted: no background, no block glyphs; the rule is the
 *  bar, and the figures stay legible end to end (after a painted field read as
 *  a slab and its fill edge cut numbers in half).
 *
 *  LEFT-ALIGNED IS LOAD-BEARING. Right-aligned figures put the rule under the blank padding: at
 *  37% of a 22-cell field the whole rule sat in the gap and stopped before the first digit, which
 *  is a gauge pointing at nothing.
 *
 *  EVERY BAR IS THE SAME LENGTH: `width` is the widest figures in the whole
 *  render, measured by `statuslineFieldWidth` before anything is drawn. A width smaller than the
 *  text cannot truncate a number — the field grows instead. An empty text still draws a bare rule,
 *  so a window whose estimate has not calibrated yet shows its share rather than vanishing.
 *
 *  THE RULE CARRIES THE USAGE COLOUR up to the share and goes GREY past it, and so do the figures
 *  it runs under. NO SGR 58: a coloured underline is the only way to hold a grey digit over a
 *  coloured rule, and it was tried — tmux stores it, but it does not reach a real screen here (the
 *  rule came out grey twice, observed live), and an underline with no SGR 58 takes the cell's
 *  FOREGROUND. The rule keeps the colour. The caps are always the usage colour: they
 *  mark the bar's extent, not its fill.
 *
 *  THE RULE SPANS THE WHOLE FIELD, CAPS INCLUDED. The caps are underlined too:
 *  ▏ and ▕ are drawn at the LEFT and RIGHT EDGE of their cell, so an un-underlined cap leaves seven
 *  eighths of a cell of bare ground between it and the rule — the small gap that made the bar look
 *  broken at both ends. The rule is also ONE HUE throughout: the usage colour at full strength up to
 *  the share and DIMMED past it, so it reads as one line that fills rather than as a coloured stub
 *  beside a grey one. That is what frees the figures to sit CENTRED — the gauge is read off where
 *  the colour drops, not off where the text starts. */
function bar(pct: number, text: string, open: string, width = 0): string {
  const p = Math.min(100, Math.max(0, Math.trunc(pct) || 0));
  const t = [...text];
  const w = text ? Math.max(width, t.length + 2) : Math.max(width, 8);
  const left = text ? Math.trunc((w - t.length) / 2) : 0;
  const cells = text ? [...' '.repeat(left), ...t, ...' '.repeat(w - t.length - left)] : [...' '.repeat(w)];
  let f = Math.trunc((p * w + 50) / 100);
  if (f > w) f = w;
  return `${open}${UL}${CAPL}${cells.slice(0, f).join('')}${GY}${cells.slice(f).join('')}${open}${CAPR}${R}`;
}

/** The figures past the share are GREY — a 256-colour foreground, NOT the DIM attribute, which
 *  also dims the rule drawn under them. */
const GY = '\x1b[38;5;245m';

/** SGR 4 and the two caps. The rule under the figures is the bar; the caps are its ends. */
const UL = '\x1b[4m';
const CAPL = '▏';
const CAPR = '▕';

/** The one field width a render uses everywhere: the widest figures in it, one trailing space
 *  before the share, and a floor of ten so an all-uncalibrated row draws rules, not slivers. */
function fieldWidthOf(texts: readonly string[]): number {
  return Math.max(10, texts.reduce((m, t) => Math.max(m, [...t].length), 0) + 2);
}

/** Line 2 opens with `ctx` and line 3 with its first window; the two bars only line up in a column
 *  if those labels are padded to one width. Only the FIRST segment of line 3 is
 *  padded — the rest sit after a divider, with nothing above them to align with. */
const padLabel = (label: string, width: number): string => label + ' '.repeat(Math.max(0, width - [...label].length));

const dim = (t: string, depth: ColorDepth): string => (depth === 'none' ? t : `${DIM}${t}${R}`);
// Solid white for the reset countdowns, light orange for money, light yellow for a promotion
// — the things a reader hunts for on a dense gauge row.
const wht = (t: string, depth: ColorDepth): string => (depth === 'none' ? t : `\x1b[97m${t}${R}`);
const lorange = (t: string, depth: ColorDepth): string => (depth === 'none' ? t : `\x1b[38;5;215m${t}${R}`);
const yel = (t: string, depth: ColorDepth): string => (depth === 'none' ? t : `\x1b[93m${t}${R}`);

/** One gauge: `label <painted field> pct%` plus its suffixes. Shared by the ctx gauge on line 2 and
 *  every quota gauge on line 3, so the two lines cannot drift apart. */
function segment(
  label: string,
  pct: number,
  pctText: string,
  barText: string,
  suffix: string,
  plainTail: string,
  depth: ColorDepth,
  themed: boolean,
  width: number,
  labelWidth = 0
): string {
  if (depth === 'none') {
    // NO COLOUR MEANS NO FILL TO PAINT WITH — a painted field whose filled half is
    // indistinguishable from its empty one is a gauge that reports nothing. So mono keeps the row
    // it always had, to the byte: the bracketed block bar with the figures BESIDE it (`plainTail`,
    // which carries the separators the colour path folds into the field).
    const f = Math.min(8, Math.max(0, Math.trunc((Math.trunc(pct) * 8 + 50) / 100)));
    return `${padLabel(label, labelWidth)} [${BLOCK.repeat(f)}${' '.repeat(8 - f)}] ${pctText}%${suffix}${plainTail}`;
  }
  const { open } = usageColor(pct, depth, themed);
  // The script's structure exactly: label, the capped and ruled field, then the share — each run
  // closed where the script closes it, because the bytes are the contract this module exists to keep.
  return `${open}${padLabel(label, labelWidth)}${R} ${bar(pct, barText, open, width)} ${open}${pctText}%${R}${suffix}`;
}

/** Line 1 — when and where: clock · date | branch | dir | title. The session title closes this
 *  line rather than opening line 2: it names the same thing the path does, and
 *  line 2 wants its head for the ctx gauge. */
export function statuslineIdentity(d: StatuslineData, depth: ColorDepth): string {
  const bits = [`${d.clock ?? ''} ${dim('·', depth)} ${d.date ?? ''}`.trim()];
  if (d.branch) bits.push(d.branch);
  if (d.cwdLabel) bits.push(d.cwdLabel);
  if (d.title) bits.push(d.title);
  return bits.join(` ${dim('|', depth)} `);
}

/** Line 2 — the session: ctx | model · effort · think · style · ↑↓↺ · ◷. The context gauge opens
 *  it — it is the number read most often, and it belongs beside the model whose
 *  window it fills; the title it displaced now closes line 1. */
export function statuslineSession(d: StatuslineData, depth: ColorDepth, _themed: boolean, _width = 0, _labelWidth = 0): string {
  const sep = ` ${dim('·', depth)} `;
  // ctx no longer OPENS line 2 — it closes it below as a compact `used/total pct%`
  // figure. Every element after the model prepends ` · `, exactly as the shell's `$l2tail` does (a bare
  // effort with no model therefore leads with a separator, byte-for-byte). width/label/themed became
  // unused with the bar gone, kept in the signature for the row assembler that calls this.
  let out = d.model ?? '';
  if (d.effort) out += `${sep}${d.effort}`;
  if (d.thinking) out += `${sep}think`;
  if (d.outputStyle && !/^(default)$/i.test(d.outputStyle)) out += `${sep}${d.outputStyle}`;
  if (d.tokensIn !== undefined && d.tokensIn !== null) {
    // Dim glyph, plain number, NO space between them — the script's own spacing.
    out += `${sep}${dim('↑', depth)}${human(d.tokensIn)} ${dim('↓', depth)}${human(d.tokensOut ?? 0)} ${dim('↺', depth)}${human(d.tokensCacheRead ?? 0)}`;
  }
  if (d.durationMs !== undefined && d.durationMs !== null && d.durationMs >= 1000) {
    out += `${sep}${dim('◷', depth)}${durStr(d.durationMs)}`;
  }
  if (d.ctxPct !== undefined && d.ctxPct !== null && d.ctxSize != null) {
    // Threshold-COLOURED, not plain — the same green/amber/red the quota gauges use, matching the shell's `uc "$ctx"`.
    const open = depth === 'none' ? '' : usageColor(d.ctxPct, depth, _themed).open;
    out += `${sep}${open}${human(d.ctxUsed ?? 0)}/${human(d.ctxSize)} ${Math.trunc(d.ctxPct)}%${depth === 'none' ? '' : R}`;
  }
  return out;
}

/** The context gauge, as line 2 opens with it — and as the dashboard's fallback row draws it when
 *  there is no quota cache to fill the rest. The share TRUNCATES, unlike the windows. */
export function ctxSegment(d: StatuslineData, depth: ColorDepth, themed: boolean, width = 0, labelWidth = 0): string {
  if (d.ctxPct === undefined || d.ctxPct === null) return dim('ctx —', depth);
  const abs = d.ctxSize != null ? `${human(d.ctxUsed ?? 0)}/${human(d.ctxSize)}` : '';
  const cr = d.tokensCacheRead ? `+${human(d.tokensCacheRead)}↺` : '';
  const tail = (d.ctxSize != null ? ` ${dim(`· ${abs}`, depth)}` : '') + (cr ? ` ${dim(cr, depth)}` : '');
  return segment('ctx', d.ctxPct, `${Math.trunc(d.ctxPct)}`, ctxFigures(d), '', tail, depth, themed, width, labelWidth);
}

/** The figures the ctx gauge prints on its bar — separately, because the shared field width must
 *  be measured across line 2 and line 3 together before either is drawn. */
function ctxFigures(d: StatuslineData): string {
  if (d.ctxPct === undefined || d.ctxPct === null) return '';
  const abs = d.ctxSize != null ? `${human(d.ctxUsed ?? 0)}/${human(d.ctxSize)}` : '';
  const cr = d.tokensCacheRead ? `+${human(d.tokensCacheRead)}↺` : '';
  return [abs, cr].filter(Boolean).join(' ');
}

/** A standalone gauge chip — `label <bar> pct%`, optionally ` · <until>` — for surfaces OUTSIDE the
 *  three statusline rows: the Agent tab's ctx gauge (top-right of the prompt box) and the TUI's own
 *  compact per-provider usage readout. Same painted field and thresholds as the quota gauges, by
 *  design. A null share reads
 *  as `label —`. */
export function gaugeChip(label: string, pct: number | null, depth: ColorDepth, themed: boolean, resetMs?: number | null, width = 0, now = Date.now()): string {
  if (pct === undefined || pct === null) return dim(`${label} —`, depth);
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const u = resetMs != null && resetMs > 0 ? untilStr(resetMs, now) : '';
  // The reset rides `suffix` (shown in BOTH the colour and mono paths, once); `plainTail` stays empty —
  // there are no in-bar figures here to echo after the bar in mono, so passing it would double the reset.
  const suffix = u ? ` ${dim('·', depth)} ${wht(u, depth)}` : '';
  return segment(label, p, `${p}`, '', suffix, '', depth, themed, width, 0);
}

/** One window of the compact per-provider usage readout (the terminal app's bottom bar since
 *  2026-09-16): a share draws the painted gauge; a token-only month (gpt's, which has no reported
 *  allowance) draws `mo <count> · reset`; an unmeasured window is a dim `label —`. */
/** A BAR-LESS usage chip — `label: N% reset` (or `label: 12.3k reset` for a token-only window, or
 *  `label —` when empty), threshold-coloured like the gauge. This is the terminal app's one-line
 *  bottom readout format, matching the editors' status bars. `withReset` false drops the reset stamp
 *  — the first thing shed when the combined claude+gpt line must compact to fit a narrow terminal. */
export function usageText(
  label: string,
  w: { pct: number | null; resetMs: number | null; tok?: number | null } | undefined,
  depth: ColorDepth,
  themed: boolean,
  now = Date.now(),
  withReset = true
): string {
  if (!w || (w.pct === null && (w.tok === null || w.tok === undefined))) return dim(`${label} —`, depth);
  const u = withReset && w.resetMs != null && w.resetMs > 0 ? ` ${wht(untilStr(w.resetMs, now), depth)}` : '';
  if (w.pct !== null && w.pct !== undefined) {
    const p = Math.max(0, Math.min(100, Math.round(w.pct)));
    const val = depth === 'none' ? `${p}%` : `${usageColor(p, depth, themed).open}${p}%${R}`;
    return `${dim(`${label}:`, depth)} ${val}${u}`;
  }
  return `${dim(`${label}:`, depth)} ${human(w.tok as number)}${u}`;
}

export function usageChip(
  label: string,
  w: { pct: number | null; resetMs: number | null; tok?: number | null } | undefined,
  depth: ColorDepth,
  themed: boolean,
  now = Date.now()
): string {
  if (!w) return dim(`${label} —`, depth);
  if (w.pct !== null && w.pct !== undefined) return gaugeChip(label, w.pct, depth, themed, w.resetMs, 0, now);
  if (w.tok !== null && w.tok !== undefined) {
    const u = w.resetMs != null && w.resetMs > 0 ? untilStr(w.resetMs, now) : '';
    const body = `${dim(label, depth)} ${human(w.tok)}`;
    return u ? `${body} ${dim('·', depth)} ${wht(u, depth)}` : body;
  }
  return dim(`${label} —`, depth);
}

/** What a render measures ONCE and hands to both lines: the field width every bar shares (the ctx
 *  gauge on line 2 included, so the two lines carry bars of the same length) and the label width
 *  that puts line 2's `ctx` and line 3's first window in the same column. Cheap: it builds the
 *  segments' figures and labels and throws the rest away. */
export function statuslineMetrics(d: StatuslineData, depth: ColorDepth): { field: number; label: number } {
  const texts: string[] = [];
  const labels: string[] = [];
  statuslineGauges(d, depth, false, true, 0, texts, labels);
  // labels[0] is the ctx gauge (always collected first); labels[1] is line 3's opening window.
  const first = labels[1] ?? '';
  return { field: fieldWidthOf(texts), label: Math.max(3, [...first].length) };
}

/** Line 3 — the quota gauges: 5h | fable | wk | mo, each `label <bar> pct%` with its own suffixes.
 *  `withCtx` puts the context gauge back at the head, for the two places that draw this row ALONE:
 *  the dashboard's no-cache fallback, and a frame so short that line 2 never gets drawn. */
export function statuslineGauges(
  d: StatuslineData,
  depth: ColorDepth,
  themed: boolean,
  withCtx = false,
  width = 0,
  collect?: string[],
  collectLabels?: string[],
  labelWidth = 0
): string {
  const parts: string[] = [];
  const plain = depth === 'none';
  // TWO PASSES, because every bar is the same length and that length is the widest figures in the
  // render — not knowable until the last segment is built. A gauge is recorded here and stands in
  // the joined row as a \u0001-delimited index; the substitution below paints it once the width is
  // known. `collect` is the measuring pass: it takes the figures and skips the painting.
  const pending: { pct: number; args: Parameters<typeof segment> }[] = [];
  const seg = (label: string, pct: number, pctText: string, barText: string, suffix: string, plainTail = ''): string => {
    collect?.push(barText);
    collectLabels?.push(label);
    // Only the first segment is padded into line with the ctx gauge above it.
    const lw = pending.length === 0 && !withCtx ? labelWidth : 0;
    if (plain) return segment(label, pct, pctText, barText, suffix, plainTail, depth, themed, width, lw);
    pending.push({ pct, args: [label, pct, pctText, barText, suffix, plainTail, depth, themed, width, lw] });
    return `\u0001${pending.length - 1}\u0001`;
  };
  if (withCtx) {
    collect?.push(ctxFigures(d));
    collectLabels?.push('ctx');
    if (!collect) parts.push(ctxSegment(d, depth, themed, width, labelWidth));
  }
  const window = (
    label: string,
    pct: number | null | undefined,
    resetMs: number | null | undefined,
    est: number | null | undefined,
    total: number | null | undefined,
    measured: number | null | undefined,
    cost?: number | null
  ): string => {
    // MONEY FIRST when there is no quota to draw. It is the client's own estimate of its own
    // spend — said as an estimate, because it is one, and because Claude Code says so itself.
    if ((pct === undefined || pct === null) && cost !== undefined && cost !== null) {
      return `${dim(label, depth)} ~${usd(cost)}`;
    }
    if (pct !== undefined && pct !== null) {
      let s = resetMs ? ` ${dim('·', depth)}${wht(untilStr(resetMs, d.now), depth)}` : '';
      // USED OUT OF TOTAL — the script's own grammar, and the reason this module exists. A bare
      // token count answers "how much have I spent" and drops the only part that says how much is
      // LEFT, which is what a quota window is for. Making the cross-machine aggregate REPLACE this
      // form (rather than feed it) is what lost the denominator, and it put the dashboard's line
      // out of step with the statusline the product installs.
      //
      // The denominator is derived when the cache lacks it: the script computes its 100% budget as
      // `tokens-per-percent × 100`, and `est / pct × 100` is that same quantity, exactly — not an
      // approximation of it. An older installed statusline writes no `five_total`, so without this
      // the window would read `~20.6M` with nothing to compare it against.
      // The two halves of a fraction must count the same thing. `five_total` is projected from
      // THIS machine's tokens over an account-wide percentage, so on two machines it is half the
      // real budget — and pairing it with a cross-machine numerator printed `~10M/10M` under a bar
      // reading 50%. When the numerator is the aggregate, the denominator is derived from the
      // aggregate too; the same algebra, applied to the same population.
      //
      // Below 1% the projection multiplies noise by a hundred or more (the shipped script only
      // calibrates above its own noise floor), so no budget is claimed there at all.
      // ONE set of numbers on every surface: the calibrated account
      // est/total is canonical; the measured-derived denominator is only the no-estimate fallback.
      const aggregated0 = !(est && total) && !!(measured && d.usageScope && d.usageScope !== 'here');
      const basis = aggregated0 ? measured : est;
      const budget = est && total
        ? total
        : (basis && pct >= 1 ? Math.round(((basis ?? 0) / pct) * 100) : null);
      // Across machines, the SUM is the better numerator — it is added up from what each machine
      // recorded, where the projection divides one machine's tokens by an account-wide percentage.
      // On one machine the projection is the account-wide figure and the sum is not, so it stands.
      const aggregated = aggregated0;
      const used = aggregated ? measured : (est ?? measured);
      // The routine scope suffix ("across 2 machines") is DROPPED from the row (it is
      // too wordy for a gauge) — the aggregation still happens and `oak usage --json` still says
      // whose tokens these are. A PROBLEM note survives the trim: an incomplete gather must say
      // so rather than under-report silently, so the parenthetical ("1 unreachable") stays.
      let bt = '';
      let tail = '';
      // ALWAYS used/total where a budget is known — a window at 0% reads
      // ~0/59.5M, never a blank. `used` and `budget` are projections from the same
      // tokens-per-percent, so the pair restates pct exactly; substituting a MEASURED numerator
      // over this projected budget (tried and reverted the same day) printed ~4M/59.5M — 6.7% —
      // beside a bar the account put at 0%.
      if (budget) {
        bt = `~${human(used ?? 0)}/${human(budget)}`;
        tail += ` ${dim(bt, depth)}`;
      } else if (used) {
        bt = `~${human(used)}`;
        tail += ` ${dim(bt, depth)}`;
      }
      const wreads = label === '5h' ? d.fiveReads : label === 'wk' ? d.weekReads : null;
      if (wreads) {
        bt = `${bt ? `${bt} ` : ''}+${human(wreads)}↺`;
        tail += ` ${dim(`+${human(wreads)}↺`, depth)}`;
      }

      return seg(label, pct, `${Math.round(pct)}`, bt, s, tail); // the windows ROUND
    }
    // A plan with no rolling quota — or a percentage whose token budget nobody can know: the
    // MEASURED tokens, never an invented bar, and never without saying whose they are.
    if (measured) {
      return `${dim(label, depth)} ${human(measured)} ${dim('tok', depth)}`;
    }
    return dim(`${label} —`, depth);
  };
  // Enterprise/API (no rolling quota): the 5h/wk slots say nothing such an account can use —
  // the month segment below is its whole readout.
  if (!d.noWindows) parts.push(window('5h', d.fivePct, d.fiveResetMs, d.fiveEst, d.fiveTotal, d.fiveMeasured, d.fiveCost));
  // The per-model weekly cap (the account API's "Fable" row), BEFORE the whole-week segment it
  // narrows: same grammar as its neighbours — bar, share, countdown, ~est/total from its own
  // union measurement + calibration, and its cache reads. Only when the account reports one.
  if (!d.noWindows && typeof d.fablePct === 'number' && isFinite(d.fablePct)) {
    const fs = d.fableResetMs && d.fableResetMs > d.now ? ` ${dim('·', depth)}${wht(untilStr(d.fableResetMs, d.now), depth)}` : '';
    let fbt = '';
    let ftail = '';
    if (d.fableTotal) {
      fbt = `~${human(d.fableEst ?? 0)}/${human(d.fableTotal)}`;
      ftail += ` ${dim(fbt, depth)}`;
    } else if (d.fableEst) {
      fbt = `~${human(d.fableEst)}`;
      ftail += ` ${dim(fbt, depth)}`;
    }
    if (d.fableReads) {
      fbt = `${fbt ? `${fbt} ` : ''}+${human(d.fableReads)}↺`;
      ftail += ` ${dim(`+${human(d.fableReads)}↺`, depth)}`;
    }
    parts.push(seg((d.fableLabel || 'fable').toLowerCase(), d.fablePct, `${Math.round(d.fablePct)}`, fbt, fs, ftail));
  }
  if (!d.noWindows) parts.push(window('wk', d.weekPct, d.weekResetMs, d.weekEst, d.weekTotal, d.weekMeasured, d.weekCost));
  // ONE dollar pair, MONTHLY, in its OWN segment: 30 days of spend against
  // four weekly cycles of budget (spend alone for plans with no quota to project from), plus the
  // live promotion with its dates — money and promos read apart from the quota bars.
  {
    const mo: string[] = [];
    let moHead = '';
    if (d.monthTokens && d.monthTokensTotal) {
      // A quota-shaped month: the same bar grammar as the 5h/wk segments.
      const p30 = Math.min(100, Math.round((d.monthTokens / d.monthTokensTotal) * 100));
      const mr = d.monthResetMs && d.monthResetMs > d.now ? ` ${dim('·', depth)}${wht(untilStr(d.monthResetMs, d.now), depth)}` : '';
      const rd = d.monthReads ? ` +${human(d.monthReads)}↺` : '';
      const moTail = ` ${dim(`~${human(d.monthTokens)}/${human(d.monthTokensTotal)}`, depth)}${d.monthReads ? ` ${dim(`+${human(d.monthReads)}↺`, depth)}` : ''}`;
      moHead = seg('mo', p30, `${p30}`, `~${human(d.monthTokens)}/${human(d.monthTokensTotal)}${rd}`, mr, moTail);
    } else if (d.monthTokens) {
      mo.push(dim(`~${human(d.monthTokens)} tok`, depth));
    }
    if (d.monthCost) mo.push(lorange(`~${usd(d.monthCost)}${d.monthCostTotal ? `/~${usd(d.monthCostTotal)}` : ''}`, depth));
    // The money and promo are their OWN segment, never a tail on the mo bar: they already read
    // apart from the quota bars, and riding along made mo the one segment too wide to wrap on a
    // narrow window.
    if (moHead) parts.push(moHead);
    let seg30 = mo.length ? mo.join(` ${dim('·', depth)} `) : '';
    if (seg30 && !moHead) seg30 = `${dim('mo', depth)} ${seg30}`;
    if (d.promo?.label) seg30 = `${seg30 ? `${seg30} ` : ''}${yel(`${d.promo.label}${d.promo.dates ? ` ${d.promo.dates}` : ''}`, depth)}`;
    if (seg30) parts.push(seg30);
  }
  // CREDIT, where the account reports one. It answers a different question from the windows — they
  // say how much of a rate is spent, this says how much is left to spend at all — so it sits beside
  // them rather than replacing either.
  // A SPEND CAP, in the used-out-of-total grammar every other window here uses.
  if (d.spendLimit) {
    parts.push(`${dim('spend', depth)} ${dim(d.spendUsed != null ? `~${usd(d.spendUsed)}/${usd(d.spendLimit)}` : `cap ${usd(d.spendLimit)}`, depth)}`);
  }
  if (d.creditsUnlimited) parts.push(`${dim('credits', depth)} ${dim('unlimited', depth)}`);
  else if (d.credits !== undefined && d.credits !== null) parts.push(`${dim('credits', depth)} ${usd(d.credits)}`);
  // WHOSE account these windows describe. Only said when it is not the default reporter, because a
  // reader with one client does not need telling every render which one it is.
  if (d.usageFrom === 'codex') parts.push(dim('codex', depth));
  if (d.staleAgeMs) parts.push(dim(`${durStr(d.staleAgeMs)} old`, depth));
  // NO DIVIDER between the gauges: every segment already opens with its own
  // label and closes with its caps and share, so a pipe between them was one more thing to read.
  const row = parts.join('  ');
  if (collect) return '';
  // PASS 2 — paint every recorded gauge at the one width. When the caller did not hand one down
  // (the dashboard\'s standalone fallback row), this row measures itself.
  const w = width || fieldWidthOf(pending.map((p) => p.args[3]));
  return row.replace(/\u0001(\d+)\u0001/g, (_m, i) => {
    const a = pending[Number(i)].args;
    return segment(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], w, a[9]);
  });
}

/**
 * The whole statusline, longest-first: as many of the three lines as `rows` allows. The ladder
 * drops line 1 before line 2 and line 2 before the gauges — the dashboard's own top bar already
 * carries the session and the cwd, so the clock/branch line is the one a short terminal misses
 * least, and the gauges are what nobody can reconstruct by looking.
 */
export function statuslineRows(d: StatuslineData, cols: number, depth: ColorDepth, themed: boolean, want: number): string[] {
  // The ctx gauge lives on line 2. At `want` 1 that line is never drawn, so the quota row takes it
  // back rather than letting the most-read number fall off a short frame entirely.
  // ONE width for every bar in the frame, measured across line 2 and line 3 together — and one
  // label width, so the ctx gauge and the first quota window start in the same column.
  const m = statuslineMetrics(d, depth);
  const all = [
    statuslineIdentity(d, depth),
    statuslineSession(d, depth, themed, m.field, m.label),
    statuslineGauges(d, depth, themed, want === 1, m.field, undefined, undefined, m.label),
  ];
  const kept = all.slice(Math.max(0, all.length - Math.max(0, want)));
  return kept.map((l) => fitVisible(l + ' '.repeat(Math.max(0, cols - displayWidth(l))), cols));
}
