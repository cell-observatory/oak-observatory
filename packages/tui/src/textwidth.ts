/**
 * Terminal display width, and the sanitizer that makes untrusted text safe to put in a frame.
 *
 * `String.length` is the wrong ruler for anything a terminal draws: `'\x1b[32m✓ ok\x1b[0m'.length` is 13
 * and occupies 4 columns; `'漢字テスト'.length` is 5 and occupies 10. Every padded column, every clip and
 * every "does this line fit" check in a colored or non-Latin frame is wrong without measuring properly,
 * and nothing in this repo measured properly before — the only wrapper (`wrapText` in the CLI) counts
 * characters, which is fine for the plain ASCII it was written for and wrong for a dashboard.
 *
 * Zero imports on purpose: this is a leaf primitive, used by the pure frame renderer, which must stay
 * testable without a terminal.
 */

/** SGR — the colour/attribute escapes (`ESC [ … m`). The one class safe to keep inside a frame,
 *  because it moves no cursor and erases nothing. */
const SGR = /\x1b\[[0-9;:]*m/g;

/** Every OTHER escape: CSI with a non-`m` final byte (cursor moves, erases, scroll regions), plus the
 *  string-introducer families (OSC/DCS/APC/PM/SOS) up to their terminator, plus lone two-byte escapes.
 *
 *  The CSI final-byte class deliberately omits lowercase `m` and nothing else — `A-La-ln-z` rather than
 *  `A-Za-z`. Uppercase `M` is "delete lines" and must still be stripped; only lowercase `m` is SGR. */
const NON_SGR =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b\[[0-9;:?<>!]*[A-Za-ln-z@`{|}~]|\x1b[()][\x20-\x7e]|\x1b[@-Z\\-_]/g;

/** Remove SGR sequences, leaving the visible characters. */
export function stripSgr(s: string): string {
  return s.replace(SGR, '');
}

/**
 * Delete everything from UNTRUSTED cell text that could move the cursor, erase the screen, or drive the
 * terminal — keeping SGR, which is only colour.
 *
 * This is not hypothetical plumbing: transcript-derived values reach a frame raw. `oneLine` in actions
 * collapses whitespace on Bash targets, but a `file_path`-derived target gets no treatment at all, and
 * egress's host pattern does not exclude ESC. A planted `ESC[2J ESC[1;1H` inside a tool argument would
 * therefore clear the dashboard and redraw over it. Confirmed reachable by a planted control rather
 * than observed in real data — the code path is what matters, not whether anyone has done it yet.
 *
 * C0 controls (including CR, which would return the cursor to column 0 mid-row) become spaces rather
 * than vanishing, so a value's visible width never silently shrinks; TAB is included, because its width
 * depends on the terminal's tab stops and is therefore unmeasurable here.
 */
export function sanitizeCell(s: string): string {
  // Split on SGR (the capturing group puts the matches at odd indices) so colour survives verbatim
  // while every span between it is scrubbed completely — including any bare ESC that is not part of a
  // sequence, which a blanket control-character pass would otherwise leave behind to swallow the next
  // character, and which stripping ESC first would turn into visible `[32m` litter.
  return s
    .split(/(\x1b\[[0-9;:]*m)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : // eslint-disable-next-line no-control-regex
          part.replace(NON_SGR, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    )
    .join('');
}

/**
 * Columns one code point occupies. 0 for combining marks and zero-width joiners/spaces, 2 for East
 * Asian Wide and Fullwidth (CJK, Hangul, kana, fullwidth forms) and for the emoji planes, 1 otherwise.
 *
 * The ranges below are the standard Unicode East_Asian_Width W/F blocks plus the common combining
 * blocks. They are deliberately not the complete tables: a terminal's own idea of a width can differ
 * (emoji presentation and regional-indicator pairs vary by emulator), and this exists to keep frames
 * inside their column budget, not to be a Unicode reference. Anything unlisted counts as 1, which is
 * the safe direction — an over-narrow estimate can wrap a line, an over-wide one cannot.
 */
function charWidth(cp: number): number {
  if (cp === 0x200b || cp === 0x200d || cp === 0xfeff) return 0; // ZWSP / ZWJ / BOM
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0e31 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f)
  )
    return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo initial
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, Hangul compat, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji + pictographs
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions
  )
    return 2;
  return 1;
}

/** Columns this string occupies on a terminal, ignoring SGR. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripSgr(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * Pad or clip to exactly `cols` display columns.
 *
 * Never cuts an escape in half, and re-closes with `ESC[0m` when the input left an attribute open —
 * a clipped colour that is never reset bleeds into the rest of the row and, on the last row, into the
 * user's shell after the dashboard exits.
 */
export function fitVisible(s: string, cols: number): string {
  if (cols <= 0) return '';
  let out = '';
  let w = 0;
  let sawSgr = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      SGR.lastIndex = i;
      const m = SGR.exec(s);
      if (m && m.index === i) {
        out += m[0];
        sawSgr = true;
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > cols) break; // a wide char that would straddle the edge is dropped whole
    out += ch;
    w += cw;
    i += ch.length;
  }
  if (sawSgr && !out.endsWith('\x1b[0m')) out += '\x1b[0m'; // only when something is still open
  return out + ' '.repeat(cols - w);
}

/**
 * Wrap to `cols` display columns, breaking at spaces where possible.
 *
 * Wraps rather than ellipsizes: this project's standing rule is that content text is never truncated
 * with an ellipsis, because a path or a message that trails off is a claim the reader cannot check.
 */
/**
 * Keep the head AND the tail of a list of lines within a row budget, saying how many are hidden.
 *
 * Head-only truncation is the wrong shape for command output: when something fails the reason is in
 * the LAST rows, so keeping the first N hides exactly the lines a reader opened the row to see. The
 * marker itself costs a row and therefore comes out of the budget — a fold that overran the budget
 * it was enforcing would defeat the point.
 */
export function middleOut(lines: string[], budget: number): { head: string[]; tail: string[]; hidden: number } {
  if (budget <= 0) return { head: [], tail: [], hidden: lines.length };
  if (lines.length <= budget) return { head: lines, tail: [], hidden: 0 };
  const room = Math.max(1, budget - 1);
  const headN = Math.ceil(room / 2);
  const tailN = room - headN;
  return {
    head: lines.slice(0, headN),
    tail: tailN ? lines.slice(lines.length - tailN) : [],
    hidden: lines.length - headN - tailN,
  };
}

/** Compact the active SGR state instead of replaying an ever-growing escape history. */
function rememberSgr(state: Map<string, string>, escape: string): void {
  const parts = escape.slice(2, -1).split(';');
  for (let i = 0; i < parts.length; i++) {
    const code = Number(parts[i].split(':')[0] || 0);
    let value = parts[i] || '0', key = String(code);
    if (code === 0) { state.clear(); state.set('reset', '0'); continue; }
    if (code === 38 || code === 48 || code === 58) {
      if (!parts[i].includes(':')) {
        const count = parts[i + 1] === '2' ? 4 : parts[i + 1] === '5' ? 2 : 0;
        value = parts.slice(i, i + count + 1).join(';'); i += count;
      }
    }
    if ((code >= 30 && code <= 39) || (code >= 90 && code <= 97)) key = 'fg';
    else if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107)) key = 'bg';
    else if (code === 58 || code === 59) key = 'underline-color';
    else if (code === 22) { state.delete('1'); state.delete('2'); }
    else if (code === 3 || code === 23) key = 'italic';
    else if (code === 4 || code === 21 || code === 24) key = 'underline';
    else if (code === 5 || code === 6 || code === 25) key = 'blink';
    else if (code === 7 || code === 27) key = 'reverse';
    else if (code === 8 || code === 28) key = 'conceal';
    else if (code === 9 || code === 29) key = 'strike';
    else if (code >= 10 && code <= 19) key = 'font';
    state.set(key, value);
  }
}

export function wrapVisible(s: string, cols: number): string[] {
  if (cols <= 0) return [''];
  const lines: string[] = [], styles = new Map<string, string>();
  let line = '', width = 0;
  const replay = () => styles.size ? '\x1b[' + [...styles.values()].join(';') + 'm' : '';
  const emit = () => {
    lines.push(line + (styles.size && !line.endsWith('\x1b[0m') ? '\x1b[0m' : ''));
    line = replay(); width = 0;
  };
  for (const word of s.split(' ')) {
    const wordWidth = displayWidth(word);
    if (width && width + 1 + wordWidth <= cols) { line += ' '; width++; }
    else if (width && wordWidth) emit();
    // Consume SOURCE code points exactly once. A row boundary closes and reopens only the active
    // style, including styles inherited from earlier words; it never replays the escape history.
    for (let i = 0; i < word.length;) {
      if (word[i] === '\x1b') {
        SGR.lastIndex = i;
        const escape = SGR.exec(word);
        if (escape && escape.index === i) {
          line += escape[0]; rememberSgr(styles, escape[0]); i += escape[0].length;
          continue;
        }
      }
      const ch = String.fromCodePoint(word.codePointAt(i)!);
      const cw = charWidth(ch.codePointAt(0)!);
      if (width && width + cw > cols) emit();
      line += ch; width += cw; i += ch.length;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}


/**
 * Subsequence match — fzf's rule, which twenty years of muscle memory now expects: `pcsi` finds
 * `packages/core/src/index.ts`.
 *
 * A plain `includes` still wins when it hits, so a literal query like `.ts` behaves exactly as it did
 * and never loses to a scattered match. Case-insensitive both ways. Returns the matched INDEXES so a
 * caller can highlight them; null when there is no match at all.
 *
 * Pure and index-based on purpose: the caller owns rendering, and highlighting has to compose with
 * `fitVisible`/`wrapVisible` rather than inject escapes this function knows nothing about.
 */
export function fuzzyMatch(haystack: string, needle: string): number[] | null {
  if (!needle) return [];
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  // Contiguous first: it is both the common case and the better match.
  const at = h.indexOf(n);
  if (at >= 0) return Array.from({ length: n.length }, (_, i) => at + i);
  const out: number[] = [];
  let i = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, i);
    if (found < 0) return null;
    out.push(found);
    i = found + 1;
  }
  return out;
}


/**
 * The window `[from, from+width)` of a string, measured in DISPLAY columns.
 *
 * Used only by the horizontal-pan mode, where wrapping is off by the reader's own choice — so this
 * is a viewport, not a truncation: every column is reachable by panning. Wide characters that would
 * straddle either edge are dropped rather than half-drawn, which is what a terminal does anyway.
 */
/**
 * Mark every occurrence of `needle` in `s` with reverse video, WITHOUT disturbing the colour already
 * there.
 *
 * The lines this runs over are the rich diff's own output: added/removed banding plus a per-character
 * intra-line pass, so they are dense with SGR. Two things follow. The needle has to be found in the
 * VISIBLE text — `\x1b[38;5;71m` contains "m" and "5", and a naive `indexOf` would mark escape bytes
 * and split a sequence in half, which does not render as a wrong colour but as garbage on the row.
 * And the mark has to be `7m`/`27m` — reverse on, reverse off — rather than a colour, because a colour
 * would have to be un-set to something, and there is no "the colour it was before" to go back to.
 *
 * Each run of text BETWEEN escapes is wrapped independently, so a reset in the middle of a match
 * cannot swallow the highlight for the rest of it.
 */
/**
 * Drop trailing characters matching `drop`, without a regex.
 *
 * `/ +$/` and friends look harmless and are the textbook polynomial-backtracking shape: the engine
 * retries the match from every position, so a long run of the dropped character costs O(n²). These run
 * over rendered rows and over transcript-derived text, which is not input this product chooses. A
 * backwards scan is linear and says the same thing.
 */
export function trimTrailing(s: string, drop: (ch: string) => boolean): string {
  let end = s.length;
  while (end > 0 && drop(s[end - 1])) end--;
  return end === s.length ? s : s.slice(0, end);
}

export function highlightVisible(s: string, needle: string): string {
  if (!needle) return s;
  const ESC = /\x1b\[[0-9;]*m/g;
  // Tokenise into escapes and text, keeping order.
  const parts: { esc: boolean; text: string }[] = [];
  let at = 0;
  for (const m of s.matchAll(ESC)) {
    if (m.index! > at) parts.push({ esc: false, text: s.slice(at, m.index) });
    parts.push({ esc: true, text: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < s.length) parts.push({ esc: false, text: s.slice(at) });

  const visible = parts.filter((p) => !p.esc).map((p) => p.text).join('');
  const hay = visible.toLowerCase();
  const n = needle.toLowerCase();
  // A MASK, not a list of spans scanned per character. `spans.some(...)` inside the character loop is
  // O(characters x matches), which is fine on a short line and is not what this runs on: measured at
  // 0.43ms for 200 matches and 39.9ms for 3,200 — and a one-character needle on a wide terminal is an
  // ordinary thing to type. At 45 drawn rows that was ~19ms of a keystroke. The mask is O(characters +
  // matches) and gives the same answer.
  let found = false;
  const mask = new Uint8Array(visible.length);
  for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length)) {
    found = true;
    for (let k = i; k < i + n.length && k < mask.length; k++) mask[k] = 1;
  }
  if (!found) return s;

  let col = 0;
  let out = '';
  for (const p of parts) {
    if (p.esc) { out += p.text; continue; }
    let piece = '';
    for (const ch of p.text) {
      piece += mask[col] ? `\x1b[7m${ch}\x1b[27m` : ch;
      col += 1;
    }
    out += piece;
  }
  return out;
}

export function sliceVisible(s: string, from: number, width: number): string {
  if (width <= 0) return '';
  let col = 0;
  let out = '';
  for (const ch of s) {
    const w = displayWidth(ch);
    if (col + w > from + width) break;
    if (col >= from) out += ch;
    col += w;
  }
  return out;
}

/**
 * Wrap the display-column range [from, to] (inclusive, in CELLS) of `s` in reverse video, composing
 * with whatever SGR the line already carries — the drag-selection highlight. A wide glyph is
 * included whenever any of its cells falls in the range: half a CJK character is not a thing a
 * terminal can select.
 */
export function reverseVisibleSpan(s: string, from: number, to: number, sgr?: string): string {
  if (to < from) return s;
  // `sgr`: an explicit selection colour derived from the terminal's real background
  // (OSC 11) replaces reverse video where the caller has one — same run-length discipline.
  const OPEN = sgr ?? '\x1b[7m';
  const CLOSE = sgr ? '\x1b[0m' : '\x1b[27m';
  const ESC = /\x1b\[[0-9;]*m/g;
  const parts: { esc: boolean; text: string }[] = [];
  let at = 0;
  for (const m of s.matchAll(ESC)) {
    if (m.index! > at) parts.push({ esc: false, text: s.slice(at, m.index) });
    parts.push({ esc: true, text: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < s.length) parts.push({ esc: false, text: s.slice(at) });
  // RUN-LENGTH, not per-char: wrapping every overlapped cell individually multiplied the frame's
  // bytes ~8× during a full-screen drag (measured 250 KB/paint), and TTY writes are blocking — a
  // slow SSH link backpressured the key loop mid-drag. One OPEN opens the run; an embedded
  // SGR inside it (a reset would cancel reverse) is followed by a re-open; one `\x1b[27m` closes.
  let col = 0;
  let out = '';
  let inRun = false;
  for (const p of parts) {
    if (p.esc) {
      out += p.text;
      if (inRun) out += OPEN; // the embedded sequence may have reset attributes — reassert
      continue;
    }
    for (const ch of p.text) {
      const w = displayWidth(ch);
      const overlaps = col <= to && col + w - 1 >= from;
      if (overlaps && !inRun) {
        out += OPEN;
        inRun = true;
      } else if (!overlaps && inRun) {
        out += CLOSE;
        inRun = false;
      }
      out += ch;
      col += w;
    }
  }
  if (inRun) out += CLOSE;
  return out;
}

/** A pane's text columns, and the rows that say where their own text is (a boxed prompt's words sit
 *  inside its borders): `[first, last]`, or null for a row with none. Keyed by painted row. */
export type SpanClip = { x0: number; x1: number; rows?: ReadonlyMap<number, readonly [number, number] | null> };

/** The columns a span (`a` before `b`) covers on painted row `r`, or null when the row holds no text.
 *  The drag's band and its copy both read it, so what is banded is what is copied. */
export function spanCols(r: number, a: { row: number; col: number }, b: { row: number; col: number }, clip?: SpanClip): [number, number] | null {
  const text = clip?.rows?.get(r);
  if (text === null) return null;
  return [
    r === a.row ? Math.max(a.col, text?.[0] ?? 0) : text?.[0] ?? clip?.x0 ?? 0,
    r === b.row ? Math.min(b.col, text?.[1] ?? Number.MAX_SAFE_INTEGER) : text?.[1] ?? clip?.x1 ?? Number.MAX_SAFE_INTEGER,
  ];
}

/**
 * The text of a character-precise LINEAR span across painted lines — what a terminal drag selects:
 * the anchor line from its column to the end, whole lines between, the release line up to and
 * including its column. Anchor and release arrive in whichever order the drag went; this
 * normalises. Columns are display cells, so wide glyphs slice correctly. Lines are expected
 * PLAIN (SGR already stripped); trailing whitespace per line is trimmed, exactly as the painted
 * frame's right edge is padding, not content.
 *
 * `clip` holds the span to ONE pane's text columns, as herdr's selection stays in the pane it began
 * in: rows are cut to [x0, x1], so a pane beside it never rides along on the rows between. The empty
 * rows a drag runs past below a pane's last text are dropped too, as herdr's copy drops them. A row
 * that says where its own text is (`clip.rows`) is cut to that, so a boxed prompt copies as its words.
 */
export function sliceSpan(
  lines: readonly string[],
  anchor: { row: number; col: number },
  release: { row: number; col: number },
  clip?: SpanClip
): string {
  const fwd = anchor.row < release.row || (anchor.row === release.row && anchor.col <= release.col);
  const a = fwd ? anchor : release;
  const b = fwd ? release : anchor;
  const out: string[] = [];
  for (let r = Math.max(0, a.row); r <= b.row && r < lines.length; r++) {
    const cols = spanCols(r, a, b, clip);
    if (!cols) continue;
    const [from, to] = cols;
    const line = lines[r] ?? '';
    // OVERLAP-inclusive, the same rule the highlight uses: a wide glyph whose second cell is the
    // anchor is selected on screen, and the copy must agree with what the reader saw (strict
    // `col >= from` slicing dropped exactly that glyph).
    let piece = '';
    let col = 0;
    for (const ch of line) {
      const w = displayWidth(ch);
      if (col > to) break;
      if (col + w - 1 >= from) piece += ch;
      col += w;
    }
    out.push(piece.trimEnd());
  }
  if (clip) while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
