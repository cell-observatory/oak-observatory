/**
 * The terminal's visual vocabulary: which characters may be drawn, and which colours mean what.
 *
 * Both answers were measured rather than chosen, and both inverted the usual advice.
 *
 * GLYPHS. A census of every monospace font on a stock Mac — SF Mono, SF Mono Terminal, SFNSMono,
 * Menlo, Monaco — found:
 *   - Braille (U+2800–28FF), the usual recommendation for sub-cell plots, is present in NONE of them.
 *     The system falls back to AppleBraille, which is 13.5% wider than the cell, so every braille plot
 *     silently breaks the grid it was drawn to fit.
 *   - The entire box-drawing set is missing from **Menlo Bold** — and Menlo is VS Code's default
 *     terminal font on macOS. A bolded frame becomes tofu. So this product draws no boxes; a rule is a
 *     tinted blank row, which needs no glyph at all.
 *   - `⧗` (the hourglass this code used for "pending") is in none of them either.
 *
 * So the default tier is small on purpose. A re-census (fontTools, upright faces only — we never emit
 * ESC[3m — with an 'A' positive control and a PUA negative control per face) sharpened this:
 *
 *   glyph  Menlo  MenloBold  Monaco  CourierNew  Andale
 *   ? + x    y        y         y        y         y     <- the ASCII tier: universal
 *   █ › ·    y        y         y        y         y
 *   ✓ ✗ ▸ ▾  y        y         N        N         N     <- Menlo only
 *   ▐        y        y         N        y         y
 *   ─        y        N         y        y         y     <- why no boxes: it is BOLD that loses them
 *
 * Menlo is first in VS Code's macOS chain, so the default tier renders correctly there, bold included.
 * It is NOT universal: a reader who has set Monaco, Courier New or Andale gets a fallback face for
 * ✓ ✗ ▸ ▾, and those fall back at the wrong advance width. That reader sets OBSERVATORY_GLYPHS=ascii.
 * The earlier version of this comment claimed these were "verified present in every one of those
 * fonts" and named Monaco; that was false, and the table above is the measurement that corrects it.
 *
 * Block eighths are the single deliberate exception, because there is no width-safe sub-cell ramp and
 * a sparkline needs eight levels.
 *
 * COLOUR. Six semantic hues cannot be told apart by a dichromat — a search of the 256-colour cube found
 * at most four mutually separable hues at a comfortable distance. The product's three most important
 * states are pending, kept and undone, and they always appear TOGETHER in the same meter, so they do
 * not need three hues: they need internal separation. They are therefore one hue's LIGHTNESS ramp,
 * which is immune to colour blindness by construction and survives a monochrome terminal for free.
 * Every state also carries a distinct SHAPE, so accept and reject never depend on colour at all.
 */

export type GlyphTier = 'safe' | 'block' | 'ascii';

export interface Glyphs {
  /** Tree twigs. */
  closed: string;
  open: string;
  /** The vertical rule beside a quoted block — the one width-safe bar that survives Menlo Bold. */
  bar: string;
  /** A wrapped line's continuation marker (`↳` is absent from SF Mono). */
  wrap: string;
  /** A folded/elided row (`⋯` is absent from SF Mono). */
  fold: string;
  /** A row the reader has MARKED for a bulk keep/undo. Shape-distinct from every review-state glyph:
   *  a mark is about the reader's selection, not about what happened to the edit. */
  marked: string;
  /** Review states. Shape-distinct, so the meaning never rests on hue. */
  pending: string;
  kept: string;
  undone: string;
  /** Status dots for the tab strip — herdr-style: filled = live, hollow = idle, fisheye = blocked.
   *  Same Geometric-Shapes block as `marked` (◆), which the Menlo census already clears; the census
   *  script covers these three too. */
  dot: { live: string; idle: string; blocked: string };
  /** The eight-level ramp for sparklines, coarsest first. */
  ramp: string[];
  /** Meter fill characters, used only when colour is unavailable. */
  fill: { pending: string; kept: string; undone: string; empty: string };
  /** The pane title-row fill. ASCII in every tier: width 1 in every locale, present in every font.
   *  This is what makes a pane's horizontal extent visible with no colour at all. */
  rule: string;
  /** Box-drawing frame — herdr-style pane borders. Present in Menlo REGULAR but NOT Menlo Bold (the
   *  census table above), so these are drawn NON-BOLD wherever they appear; the ASCII tier uses +/-/|. */
  box: { h: string; v: string; tl: string; tr: string; bl: string; br: string };
  /** Whether tree panes DRAW full boxes (herdr borders). Off by default — Menlo Bold has no box glyphs
   *  and even the regular-Menlo corners are not yet census-confirmed; OBSERVATORY_BOXES=1 turns it on,
   *  and a macOS font census flips the default once the corners are verified. */
  boxes: boolean;
}

const SAFE: Glyphs = {
  closed: '▸',
  open: '▾',
  bar: '▐',
  wrap: '▸',
  fold: '~',
  // One column wide in every font this set is chosen for — the same constraint `bar` documents.
  marked: '◆',
  pending: '?',
  kept: '✓',
  undone: '✗',
  dot: { live: '●', idle: '○', blocked: '◉' },
  ramp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  fill: { pending: '#', kept: '=', undone: '-', empty: ' ' },
  // Solid, not dashed. Box-drawing `─`, same glyph
  // the borders use, so every horizontal rule in the app is one continuous solid line. The ascii tier
  // keeps `-` (─ is not in its universal set).
  rule: '─',
  box: { h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘' },
  boxes: false,
};

const ASCII: Glyphs = {
  closed: '>',
  open: 'v',
  bar: '|',
  wrap: '>',
  fold: '~',
  marked: '*',
  pending: '?',
  kept: '+',
  undone: 'x',
  dot: { live: '*', idle: 'o', blocked: '@' },
  ramp: ['.', '.', ':', ':', '-', '=', '+', '#'],
  fill: { pending: '#', kept: '=', undone: '-', empty: ' ' },
  rule: '-',
  box: { h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+' },
  boxes: false,
};

/**
 * Which tier to draw with.
 *
 * `LANG=C`/`POSIX` forces ASCII: that is the environment declaring it has no UTF-8, and guessing
 * otherwise produces mojibake rather than a diagnosable failure.
 */
export function glyphTier(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): GlyphTier {
  const forced = env.OBSERVATORY_GLYPHS;
  if (forced === 'safe' || forced === 'block' || forced === 'ascii') return forced;
  // Windows sets no LC_ALL/LANG, so the locale test below cannot speak for it and everything fell
  // through to `block`. Windows Terminal draws the shading blocks correctly; ConHost with a raster
  // font draws them as replacement boxes, which is worse than the safe set it can draw.
  if (platform === 'win32') return env.WT_SESSION || env.WT_PROFILE_ID ? 'block' : 'safe';
  const lang = `${env.LC_ALL || env.LC_CTYPE || env.LANG || ''}`;
  if (/^(C|POSIX)$/i.test(lang) || (lang && !/utf-?8/i.test(lang))) return 'ascii';
  return 'block';
}

/**
 * One set per (tier, boxes), built once and SHARED, so never mutate one. `rowsFor` keys its memo on
 * the set's identity, and a new object per call made every caller that takes the default set (the
 * cursor clamp, on every keystroke) miss that memo and rebuild the whole row list.
 */
const glyphSets = new Map<string, Glyphs>();

export function glyphs(tier: GlyphTier = glyphTier()): Glyphs {
  // Boxes are ON by default: every pane, the tab bar and the prompt box wear a solid outline.
  // They are drawn NON-BOLD, so Menlo's regular box-drawing renders even in VS Code
  // (the census found only Menlo BOLD drops them); the ascii tier boxes with +/-/|. OBSERVATORY_BOXES=0
  // opts out for a terminal forced to a bold-only font.
  const boxes = process.env.OBSERVATORY_BOXES !== '0';
  const key = `${tier}:${boxes}`;
  const known = glyphSets.get(key);
  if (known) return known;
  // 'safe' and 'block' differ only in the ramp: block eighths are universally present but
  // East-Asian-ambiguous, so a terminal configured to draw ambiguous characters double-wide would
  // desync a sparkline. 'safe' trades the ramp's resolution for that guarantee.
  const base = tier === 'ascii' ? ASCII : tier === 'safe' ? { ...SAFE, ramp: ASCII.ramp } : SAFE;
  const set = { ...base, boxes };
  glyphSets.set(key, set);
  return set;
}

export type StateKey = 'pending' | 'kept' | 'undone' | 'risk' | 'egress' | 'live' | 'accent' | 'agent';

/**
 * The SAME colours both editors already use, so one product looks like one product wherever it is
 * read — VS Code's webview `PAL` and JetBrains' `NavTint` agree on these hex values, and now so does
 * the terminal.
 *
 * Hue is for recognition, never for meaning. Six semantic hues cannot be told apart by a dichromat —
 * a search of the 256-colour cube found at most four mutually separable at a comfortable distance —
 * so every state ALSO carries a distinct shape (see `Glyphs`), pending/kept/undone additionally
 * differ in luminance, and the meter's fill characters differ even with colour off entirely. Take the
 * colour away and accept, reject and pending are still three different things.
 */
export type Swatch = { rgb: string; c256: number; c16: number; dim: boolean };
export type Palette = Record<StateKey, Swatch>;

/**
 * SURFACES — the missing half of this palette.
 *
 * Everything above is a FOREGROUND. Eight hues and two hard-coded title bands is the whole visual
 * vocabulary the frame had, which is why panes read as columns of text that happen to sit beside each
 * other rather than as panels. Every terminal UI that reads well — btop, k9s, and herdr, whose
 * `Palette` (src/app/state.rs) is a semantic layer over Catppuccin — separates GROUND from INK and
 * gives the ground three or four steps.
 *
 *   panel     the chrome's ground: title bands, tab strips, overlays
 *   raised    one step up: an inactive chip, a resting control
 *   sunken    one step down: separators, the space between things
 *   activeRow the row a pane considers current
 *   selection the row the cursor is on
 *
 * Per THEME, not global: the light palette exists because the default hues wash out on white ground,
 * and a dark panel painted under it would be worse than no panel at all.
 */
export type SurfaceKey = 'panel' | 'raised' | 'sunken' | 'activeRow' | 'selection';
/** Ink that is not a STATE: the three text weights every row is built from. */
export type InkKey = StateKey | 'text' | 'muted' | 'faint';
export type Ground = { rgb: string; c256: number };
export type Surfaces = Record<SurfaceKey, Ground>;
export type Inks = Record<'text' | 'muted' | 'faint', Swatch>;

const DARK_SURFACES: Surfaces = {
  panel: { rgb: '26;29;36', c256: 234 },
  raised: { rgb: '38;42;51', c256: 236 },
  sunken: { rgb: '20;22;27', c256: 233 },
  activeRow: { rgb: '31;34;41', c256: 235 },
  selection: { rgb: '45;50;61', c256: 238 },
};
const LIGHT_SURFACES: Surfaces = {
  panel: { rgb: '238;240;244', c256: 254 },
  raised: { rgb: '226;230;236', c256: 253 },
  sunken: { rgb: '245;246;248', c256: 255 },
  activeRow: { rgb: '232;235;240', c256: 252 },
  selection: { rgb: '216;221;230', c256: 251 },
};
const DARK_INKS: Inks = {
  text: { rgb: '215;218;224', c256: 252, c16: 37, dim: false },
  muted: { rgb: '154;160;170', c256: 246, c16: 37, dim: false },
  faint: { rgb: '110;117;130', c256: 243, c16: 37, dim: true },
};
const LIGHT_INKS: Inks = {
  text: { rgb: '28;32;39', c256: 236, c16: 30, dim: false },
  muted: { rgb: '93;100;112', c256: 242, c16: 37, dim: false },
  faint: { rgb: '140;148;160', c256: 246, c16: 37, dim: true },
};

const PALETTE: Palette = {
  pending: { rgb: '217;164;65', c256: 179, c16: 33, dim: false }, // #d9a441 amber
  kept: { rgb: '63;185;80', c256: 71, c16: 32, dim: false }, // #3fb950 green
  undone: { rgb: '154;160;170', c256: 246, c16: 37, dim: true }, // #9aa0aa grey
  risk: { rgb: '229;83;75', c256: 203, c16: 31, dim: false }, // #e5534b red
  egress: { rgb: '154;106;194', c256: 140, c16: 35, dim: false }, // #9a6ac2 purple
  live: { rgb: '76;139;245', c256: 75, c16: 36, dim: false }, // #4c8bf5 blue
  accent: { rgb: '204;120;92', c256: 173, c16: 33, dim: false }, // #cc785c the brand coral
  agent: { rgb: '217;130;43', c256: 172, c16: 33, dim: false }, // #d9822b attention orange
};

export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

/**
 * How much colour this terminal has.
 *
 * `NO_COLOR` is honoured before anything else — it is an explicit instruction from the environment,
 * and a tool that renders states by hue alone has to obey it or become unreadable.
 */
export function colorDepth(
  env: NodeJS.ProcessEnv = process.env,
  isTTY = true,
  platform: string = process.platform
): ColorDepth {
  if (!isTTY) return 'none';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.TERM === 'dumb') return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) return 'truecolor';
  if (/-256(color)?\b/.test(env.TERM ?? '')) return '256';
  // WINDOWS SETS NO `TERM`. Falling through to the `env.TERM ? … : 'none'` line below meant every
  // native Windows terminal — Windows Terminal, ConHost, PowerShell — rendered the whole app in no
  // colour at all, while WSL (which does set TERM) was fine. Windows Terminal advertises itself with
  // WT_SESSION and does truecolor; ConHost has understood VT sequences since Windows 10 1511 and Node
  // turns VT processing on for a TTY, so 16 colours is the honest floor rather than none.
  if (platform === 'win32') {
    if (env.WT_SESSION || env.WT_PROFILE_ID) return 'truecolor';
    if (env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.ANSICON) return '256';
    return '16';
  }
  return env.TERM ? '16' : 'none';
}

/**
 * The named palettes, and the one in force.
 *
 * Every tool in this class themes — btop ships them, k9s has skins, yazi and joshuto read theme files
 * — and this had eight hard-coded colours and no setting at all. `default` is the palette above,
 * unchanged, because a theme setting must not silently restyle anyone who never asked for one.
 *
 * The active palette is module state rather than a `tint()` parameter for one reason: `tint` has
 * roughly a hundred call sites across the frame, the change map and the options screen, and threading
 * a theme through all of them would be a large diff whose only purpose is to avoid one setter. It is
 * set once at startup and again on save — see `applyTheme` in the app.
 */
export const THEMES: Record<string, Palette> = {
  default: PALETTE,
  // Deuteranopia/protanopia-safe: the red/green pair carries the review verdict, and it is the pair
  // most colour-blind readers cannot separate. Blue vs orange survives both, and `undone` stays grey.
  colorblind: {
    ...PALETTE,
    kept: { rgb: '58;134;255', c256: 33, c16: 36, dim: false },
    risk: { rgb: '245;138;7', c256: 208, c16: 33, dim: false },
    pending: { rgb: '255;209;102', c256: 221, c16: 33, dim: false },
  },
  // For LIGHT terminal backgrounds: the default hues are tuned for dark ground and wash
  // out on white — these are the same meanings at print-weight luminance. Auto-selected at startup
  // from the terminal's own OSC 11 answer when no theme is chosen; an explicit pref always wins.
  light: {
    pending: { rgb: '154;103;0', c256: 130, c16: 33, dim: false }, // #9a6700
    kept: { rgb: '26;127;55', c256: 28, c16: 32, dim: false }, // #1a7f37
    undone: { rgb: '110;119;129', c256: 244, c16: 37, dim: true }, // #6e7781
    risk: { rgb: '207;34;46', c256: 160, c16: 31, dim: false }, // #cf222e
    egress: { rgb: '130;80;223', c256: 98, c16: 35, dim: false }, // #8250df
    live: { rgb: '9;105;218', c256: 26, c16: 36, dim: false }, // #0969da
    accent: { rgb: '188;82;52', c256: 130, c16: 33, dim: false }, // the coral, darkened for paper
    agent: { rgb: '154;82;0', c256: 130, c16: 33, dim: false },
  },
  // One hue, varied by weight. For terminals whose own theme fights a coloured UI, and for anyone who
  // wants the diff to be the only coloured thing on screen.
  mono: Object.fromEntries(
    (Object.keys(PALETTE) as StateKey[]).map((k) => [
      k,
      { rgb: '200;200;200', c256: 250, c16: 37, dim: PALETTE[k].dim },
    ])
  ) as Palette,
};
export const THEME_NAMES = Object.keys(THEMES);

/** Grounds and text weights per theme. Only `light` genuinely differs: colourblind changes hues, not
 *  ground, and mono's greys are already neutral. */
const THEME_SURFACES: Record<string, { surfaces: Surfaces; inks: Inks }> = {
  default: { surfaces: DARK_SURFACES, inks: DARK_INKS },
  colorblind: { surfaces: DARK_SURFACES, inks: DARK_INKS },
  light: { surfaces: LIGHT_SURFACES, inks: LIGHT_INKS },
  mono: { surfaces: DARK_SURFACES, inks: DARK_INKS },
};

let activePalette: Palette = PALETTE;
let activeSurfaces = THEME_SURFACES.default;

/** Choose the palette every later `tint` uses. An unknown name falls back rather than throwing: this
 *  runs on the first paint, and a hand-edited prefs file must not be able to blank the screen. */
export function setTheme(name: string | undefined): void {
  activePalette = (name && THEMES[name]) || PALETTE;
  activeThemeName = activePalette === PALETTE ? 'default' : (name as string);
  activeSurfaces = THEME_SURFACES[activeThemeName] ?? THEME_SURFACES.default;
}

/** Which palette is live, by name. The statusline draws the SHIPPED bytes under the default and
 *  re-tints under a palette the reader CHOSE — an accessibility choice outranks byte-fidelity —
 *  so it needs to know which of the two it is in. */
let activeThemeName = 'default';
export const currentTheme = (): string => activeThemeName;

/** Wrap `s` in this state's colour at the given depth. At 'none' the text is returned untouched. */
export function tint(s: string, state: StateKey, depth: ColorDepth): string {
  if (depth === 'none') return s;
  const p = activePalette[state];
  const open =
    depth === 'truecolor' ? `\x1b[38;2;${p.rgb}m` : depth === '256' ? `\x1b[38;5;${p.c256}m` : `\x1b[${p.c16}m`;
  return `${p.dim && depth === '16' ? '\x1b[2m' : ''}${open}${s}\x1b[0m`;
}

/**
 * WHAT AN AGENT IS DOING, as one reading.
 *
 * Core already distinguishes six phases (`Phase` in actions.ts) and every surface collapsed them
 * differently: the agent strip mapped everything that was not `working` or `done` to grey, so an
 * agent BLOCKED ON A HUMAN — the one state that needs somebody — looked exactly like one that had
 * finished. herdr's sidebar (src/ui/status.rs) settled on five, and the one it has that we did not
 * surface is precisely that one.
 *
 * `done` vs `idle` is the READ-RECEIPT axis, orthogonal to the phase: both are finished, and the
 * difference is whether you have looked at it yet. We adopted that bit from herdr (`doneUnseen`);
 * this is where it finally becomes a state rather than a badge.
 */
export type AgentState = 'blocked' | 'working' | 'done' | 'idle' | 'errored' | 'unknown';

export function agentStateOf(phase: string, o: { active?: boolean; unseen?: boolean; waiting?: boolean } = {}): AgentState {
  if (phase === 'errored') return 'errored';
  // BLOCKED IS STRUCTURAL. Both awaiting-* phases mean a human is the next step, and core marks the
  // tool-driven one `high` confidence — it is not a staleness guess like idle. `waiting` is the
  // EXACT form of the same fact (2026-09-15): the hooks' raised hand — a permission prompt, a
  // question, an input wait — recorded by the agent itself, so it outranks any phase reading.
  if (o.waiting || phase === 'awaiting-input' || phase === 'awaiting-permission') return 'blocked';
  if (phase === 'working' || o.active) return 'working';
  if (o.unseen) return 'done';
  if (phase === 'idle' || phase === 'done') return 'idle';
  return 'unknown';
}

/**
 * The glyph, label and hue for a state — shape FIRST, so colour is reinforcement and never the
 * signal. Every glyph here is width-1 in every tier and already font-verified.
 *
 * `marked` is borrowed for `done`, and the borrowing is deliberate rather than careless: that shape
 * means "the reader selected this" on surfaces that list EDITS, and the surfaces that list AGENTS
 * have no marks on them. Nothing draws both.
 */
export function agentStateFace(st: AgentState, g: Glyphs): { glyph: string; label: string; key: StateKey } {
  switch (st) {
    case 'blocked': return { glyph: g.pending, label: 'blocked', key: 'agent' };
    case 'working': return { glyph: g.closed, label: 'working', key: 'live' };
    case 'done': return { glyph: g.marked, label: 'done', key: 'kept' };
    case 'idle': return { glyph: g.kept, label: 'idle', key: 'undone' };
    case 'errored': return { glyph: g.undone, label: 'errored', key: 'risk' };
    default: return { glyph: g.fold, label: 'unknown', key: 'undone' };
  }
}

/** The ground and ink tables in force — exported so a renderer can ask what a surface IS rather than
 *  hard-coding an escape, which is how two title bands ended up un-themeable. */
export const surfaces = (): Surfaces => activeSurfaces.surfaces;
export const inks = (): Inks => activeSurfaces.inks;

/**
 * The ground a user's own prompt sits on: the grey the claude and codex CLIs paint behind the user's
 * turns. It opens a span; the caller pads what it covers (a pane's row, or the inside of the
 * Observatory's prompt box) and closes it with a reset.
 *
 * The theme's `raised` ground under its `text` ink, so the light palette gets a light band. The ink is
 * explicit because a terminal's default foreground belongs to the terminal, not to the theme: a light
 * band under a light default would be unreadable. Sixteen colours use bright black, the one grey every
 * 16-colour scheme defines. No colour means no ground; the prompt's own marker or box carries it.
 */
export function promptGround(depth: ColorDepth): string {
  if (depth === 'none') return '';
  if (depth === '16') return '\x1b[100m';
  const g = activeSurfaces.surfaces.raised;
  const t = activeSurfaces.inks.text;
  return depth === 'truecolor' ? `\x1b[48;2;${g.rgb}m\x1b[38;2;${t.rgb}m` : `\x1b[48;5;${g.c256}m\x1b[38;5;${t.c256}m`;
}

/**
 * Paint text with a ground, an ink, or both.
 *
 * CLOSES PER CHANNEL, which is the whole reason this exists beside `tint`. `tint` ends with
 * `\x1b[0m` — a full reset — so a tinted word inside a background ended the background for the rest
 * of the row; every banded row in this frame is built by hand for exactly that reason. Foreground
 * closes with 39 and background with 49, so these nest in any order.
 *
 * SIXTEEN COLOURS HAVE NO GROUND WORTH USING. A background there is one of eight fixed colours that
 * fights whatever the terminal's own theme is, so the ground degrades to REVERSE VIDEO for the two
 * surfaces that carry meaning (the current row, the selected one) and to nothing for the three that
 * are only depth. Shape and weight still carry everything they carried before.
 */
export function paint(s: string, o: { fg?: InkKey; bg?: SurfaceKey }, depth: ColorDepth): string {
  if (depth === 'none' || (!o.fg && !o.bg)) return s;
  let open = '';
  let close = '';
  if (o.bg) {
    if (depth === '16') {
      if (o.bg === 'selection' || o.bg === 'activeRow') { open += '\x1b[7m'; close = '\x1b[27m' + close; }
    } else {
      const g = activeSurfaces.surfaces[o.bg];
      open += depth === 'truecolor' ? `\x1b[48;2;${g.rgb}m` : `\x1b[48;5;${g.c256}m`;
      close = '\x1b[49m' + close;
    }
  }
  if (o.fg) {
    const w: Swatch =
      o.fg === 'text' || o.fg === 'muted' || o.fg === 'faint' ? activeSurfaces.inks[o.fg] : activePalette[o.fg];
    open += depth === 'truecolor' ? `\x1b[38;2;${w.rgb}m` : depth === '256' ? `\x1b[38;5;${w.c256}m` : `\x1b[${w.c16}m`;
    close = '\x1b[39m' + close;
    if (w.dim && depth === '16') { open = '\x1b[2m' + open; close = close + '\x1b[22m'; }
  }
  return `${open}${s}${close}`;
}

/**
 * A composition meter: one bar whose LENGTH carries magnitude and whose FILL carries the mix.
 *
 * htop's memory meter, with two rules that matter here. A non-zero class never rounds to zero cells —
 * largest-remainder with a floor of one — because a single pending edit inside a 900-line folder
 * disappearing would make the meter claim the folder is fully reviewed. And when colour is off the
 * classes are still distinguishable, by fill character.
 */
export type MeterKey = 'pending' | 'kept' | 'undone';

export function meter(
  parts: Record<MeterKey, number>,
  cells: number,
  g: Glyphs,
  depth: ColorDepth
): string {
  const total = parts.pending + parts.kept + parts.undone;
  if (cells <= 0) return '';
  if (total <= 0) return g.fill.empty.repeat(cells);
  const order: MeterKey[] = ['pending', 'kept', 'undone'];
  const exact = order.map((k) => (parts[k] / total) * cells);
  const floors = exact.map((v, i) => (parts[order[i]] > 0 ? Math.max(1, Math.floor(v)) : 0));
  let used = floors.reduce((a, b) => a + b, 0);
  // Largest-remainder, then trim from the biggest share if the floors overshot a narrow bar.
  const rema = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  let ri = 0;
  while (used < cells && rema.length) {
    floors[rema[ri % rema.length].i]++;
    used++;
    ri++;
  }
  while (used > cells) {
    const big = floors.indexOf(Math.max(...floors));
    if (floors[big] <= 1) break;
    floors[big]--;
    used--;
  }
  return order
    .map((k, i) => (floors[i] > 0 ? tint(g.fill[k].repeat(floors[i]), k, depth) : ''))
    .join('');
}

/** A sparkline from a numeric series, scaled to its own maximum. */
export function sparkline(series: readonly number[], g: Glyphs): string {
  if (!series.length) return '';
  const max = Math.max(...series);
  if (!(max > 0)) return g.ramp[0].repeat(series.length);
  return series.map((v) => g.ramp[Math.min(g.ramp.length - 1, Math.round((v / max) * (g.ramp.length - 1)))]).join('');
}

/** Compact churn: 1608000 -> "1608k", 4800 -> "4.8k". Never wider than 5 cells. */
export function churn(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** Risk as a one-channel ramp: no glyph risk, three levels, readable without colour. */
export function riskMark(high: number, total: number): string {
  if (high > 0) return '!!!';
  if (total > 2) return '!!';
  if (total > 0) return '!';
  return '·';
}
