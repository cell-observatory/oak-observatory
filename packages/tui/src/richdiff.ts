/**
 * The edit, rendered the way the agent's own tools render it.
 *
 *   ● Update(packages/core/src/dashframe.ts)
 *     Added 11 lines, removed 4 lines
 *     373      out.push(fitVisible(statusText, cols));
 *     376 +    // Pick the widest hint that MEASURES within the budget
 *     378 -    : cols >= 96
 *
 * Three things here are deliberate and each cost something to get right.
 *
 * **The band is the signal, not the marker.** An added line is a full-width background run, so the
 * eye reads the shape of a change before reading a single character. A `+` in column one carries the
 * same information but only once you are already reading the line. The band therefore extends to the
 * right edge of the pane — a band that stops at the end of the text draws a ragged margin that reads
 * as noise.
 *
 * **Syntax colour is a SECOND channel layered on the first**, so it may only ever touch the
 * foreground. Tinting a background inside an added line would make two encodings fight over one
 * cell, and the reader cannot tell which won. Add/remove owns the background; syntax owns the text.
 *
 * **Both channels must survive losing colour.** At `depth === 'none'` the bands are gone, so the
 * `+`/`-` marker is what remains and it is always present — never replaced by the band, only
 * reinforced by it. A monochrome terminal loses the shape and keeps the meaning.
 */

import { displayWidth, fitVisible, sanitizeCell, sliceVisible, wrapVisible } from './textwidth';
import { ColorDepth, Glyphs, glyphs as defaultGlyphs } from './glyphs';
import { diffWordsWithSpace } from 'diff';
import { blockStateAfter, highlightSource } from './syntax';

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** Half-open [start, end) character ranges within `text` that actually changed. */
  spans?: [number, number][];
  /** Line number in the file AFTER the edit; null for a removed line or a hunk header. */
  n: number | null;
  text: string;
}

export interface RichDiffOpts {
  /** Colour the code the way an editor would. This REVERSES the note kept below
   *  since 2026-08-14 — the two channels do not actually compete: the band is a BACKGROUND and the
   *  syntax hues are a FOREGROUND, so a changed line can carry both. */
  syntax?: boolean;
  /** Draw the `● Verb(path)` header. Off for previews that sit under a row already naming the
   *  file — two headers in a row is noise, and an unnamed one renders as empty parens. */
  header?: boolean;
  /** What to do with `@@ -373,6 +373,8 @@` rows.
   *
   *  'show' (default) draws them, which is right in the review pane where the reader is navigating a
   *  whole file. In a transcript PREVIEW the ranges are noise that costs a row of a ten-row budget —
   *  the line numbers are already in the gutter — so 'elide' drops the leading one entirely and
   *  reduces the rest to a fold glyph, the way every agent CLI surveyed marks a gap. */
  hunks?: 'show' | 'elide';
  /** How to draw a patch that CREATES the file.
   *
   *  'bands' (default) is the review pane's reading: every line is an addition, so every line is
   *  banded green. 'source' is the transcript's — a new file is not a wall of additions, it is a
   *  file, and a band that covers all of it carries no information while an editor's own colouring
   *  carries all of it. Only a real creation (`@@ -0,0`) takes the second path; a patch that merely
   *  removes nothing is still a diff. */
  newFile?: 'bands' | 'source';
  cols: number;
  color: ColorDepth;
  glyphs?: Glyphs;
  /** Header verb — 'Update', 'Create', 'Delete'. */
  verb?: string;
  /** The path, shown WHOLE. A path the reader cannot read is a path they cannot review. */
  path?: string;
  added?: number;
  removed?: number;
  /**
   * Horizontal pan, in columns. When > 0 each source line stays ONE row and is shifted left by this
   * much instead of wrapping.
   *
   * This is not truncation by another name: wrapping remains the default, nothing is dropped, and the
   * reader chose to pan. It exists because on a wide patch column alignment is easier to read than
   * reflowed lines — the trade `delta` and `bat` both offer.
   */
  panX?: number;
}

/**
 * Backgrounds. Bright enough to BE the signal (the diff highlights text rather than
 * changing its colour) while the default foreground stays readable on top of them — the first
 * palette was so close to a dark terminal's own background that the band vanished and the syntax
 * hues on top read as the diff's encoding.
 *
 * Each kind has TWO tones: the line band, and a brighter one marking the characters that actually
 * changed. That second tone is the whole point of a review diff — `cols - 1` becoming `cols - 2`
 * should show you the `1`/`2`, not two full-width stripes you have to compare by eye.
 */
const BAND = {
  add: { rgb: '24;66;32', c256: 22, hot: '38;112;50', hot256: 28 }, // green band, brighter green
  del: { rgb: '80;28;28', c256: 52, hot: '140;42;42', hot256: 88 }, // red band, brighter red
};

/**
 * Pair each removed line with the added line that replaced it, and mark the spans that differ.
 *
 * Only 1:1 replacements are paired. A hunk that removes three lines and adds one has no honest
 * pairing, and inventing one would highlight spans that never corresponded — worse than no
 * highlighting, because it asserts a relationship the reader would trust.
 */
export function markIntraline(lines: DiffLine[]): DiffLine[] {
  const out = lines.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i].kind !== 'del') { i++; continue; }
    let d = i;
    while (d < out.length && out[d].kind === 'del') d++;
    let a = d;
    while (a < out.length && out[a].kind === 'add') a++;
    const dels = d - i;
    const adds = a - d;
    // Pair only when the runs are the SAME length, and pair positionally. A hunk that removes three
    // lines and adds one has no honest correspondence, and inventing one would highlight spans that
    // never matched — worse than no highlighting, because the reader would trust it.
    if (dels > 0 && dels === adds) {
      for (let k = 0; k < dels; k++) mark(out, i + k, d + k);
    }
    i = a > i ? a : i + 1;
  }
  return out;
}

function mark(out: DiffLine[], di: number, ai: number): void {
  const a = out[di].text;
  const b = out[ai].text;
  if (a === b || (!a.trim() && !b.trim())) return;
  const delSpans: [number, number][] = [];
  const addSpans: [number, number][] = [];
  let da = 0;
  let db = 0;
  for (const part of diffWordsWithSpace(a, b)) {
    const len = part.value.length;
    if (part.added) { addSpans.push([db, db + len]); db += len; }
    else if (part.removed) { delSpans.push([da, da + len]); da += len; }
    else { da += len; db += len; }
  }
  // If nearly everything differs, marking is noise rather than signal — leave the plain bands.
  const changed = delSpans.reduce((n, [x, y]) => n + (y - x), 0) + addSpans.reduce((n, [x, y]) => n + (y - x), 0);
  if (changed > (a.length + b.length) * 0.6) return;
  out[di] = { ...out[di], spans: delSpans };
  out[ai] = { ...out[ai], spans: addSpans };
}

/** Parse a unified patch into typed lines carrying post-edit line numbers.
 *
 *  SGR is stripped from the head of every line before the prefix tests. A caller that hands over an
 *  ALREADY-COLOURED patch (core's `coloredDiff(…, true)`, whose job is to print) would otherwise
 *  have every changed line classified as context — no bands, header lines leaking through, and the
 *  gutter numbering everything. That shipped once; the classifier now cannot be fooled by it, and
 *  the escapes are dropped rather than honoured because this renderer paints its own colour. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let n = 0;
  // File headers come BEFORE the first hunk. After it, a `---` is a removed line whose text starts
  // with `--` and a `+++` is an added line starting with `++` — skipping those deleted real content
  // from every SQL, Lua and Haskell diff this renderer has ever drawn, and made a replacement read
  // as a bare insert.
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const raw = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (
      !inHunk &&
      (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('Index:') || raw.startsWith('==='))
    ) {
      continue; // the header is re-rendered from real data, not echoed
    }
    if (raw.startsWith('@@')) {
      inHunk = true;
      const m = raw.match(/\+(\d+)/);
      n = m ? Number(m[1]) : n;
      out.push({ kind: 'hunk', n: null, text: raw });
      continue;
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', n: n++, text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ kind: 'del', n: null, text: raw.slice(1) });
    else out.push({ kind: 'ctx', n: n++, text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  while (out.length && out[out.length - 1].kind === 'ctx' && out[out.length - 1].text === '') out.pop();
  return out;
}

/**
 * Read `:comment`'s argument. `12: note` anchors the note to line 12 of the file after the edit, as the
 * editors' gutter and the CLI's `--line` do; any other text is a note on the whole edit. The line must be
 * one the diff numbers — an added or context line of this edit — so a note never lands where the reader
 * cannot see it (`3 tests fail` became "tests fail" on line 3, and line 9999 of a
 * 20-line edit was taken).
 */
export function commentAnchor(typed: string, patch: string): { line: number; text: string } | { error: string } {
  const m = /^(\d+):\s+(\S[\s\S]*)$/.exec(typed);
  if (!m) return { line: 0, text: typed };
  const line = Number(m[1]);
  const shown = parsePatch(patch).flatMap((l) => (l.n === null ? [] : [l.n]));
  if (shown.includes(line)) return { line, text: m[2] };
  // The numbered lines as ranges, `10–14, 40–52`, so the reader can pick one.
  const ranges: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    let j = i;
    while (j + 1 < shown.length && shown[j + 1] === shown[j] + 1) j++;
    ranges.push(i === j ? String(shown[i]) : `${shown[i]}–${shown[j]}`);
    i = j;
  }
  return { error: ranges.length ? `line ${line} is not in this edit's diff, which shows lines ${ranges.join(', ')}` : `this edit's diff has no line ${line} to comment on` };
}

/**
 * Walk a patch's lines, saying for each whether it is CONTENT or one of the headers around it.
 *
 * Shares `parsePatch`'s `inHunk` rule for a reason: after the first `@@`, a `---` is a removed line
 * whose text begins `--`. Treating it as a header there is how a SQL or Lua diff silently loses
 * content, and any counter built on the naive test inherits that bug.
 */
function eachPatchLine(patch: string, fn: (raw: string, meta: boolean) => void): void {
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const raw = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (raw.startsWith('@@')) {
      inHunk = true;
      fn(raw, true);
      continue;
    }
    const header =
      !inHunk &&
      (raw.startsWith('---') ||
        raw.startsWith('+++') ||
        raw.startsWith('Index:') ||
        raw.startsWith('===') ||
        raw.startsWith('diff ') ||
        raw.startsWith('index '));
    fn(raw, header);
  }
}

/** True when the patch CREATES the file. Unified diffs spell that exactly one way: `@@ -0,0 +1,N @@`
 *  — one hunk, starting at old line 0, of old length 0. */
export function isCreation(patch: string): boolean {
  let hunks = 0;
  let fromNothing = false;
  eachPatchLine(patch, (raw) => {
    if (!raw.startsWith('@@')) return;
    hunks++;
    if (/^@@ -0,0 /.test(raw)) fromNothing = true;
  });
  return hunks === 1 && fromNothing;
}

/** How many lines a patch adds and removes — the `+2 -1` a head row can state without guessing. */
export function tallyPatch(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  eachPatchLine(patch, (raw, meta) => {
    if (meta) return;
    if (raw.startsWith('+')) add++;
    else if (raw.startsWith('-')) del++;
  });
  return { add, del };
}

/**
 * Cut a patch to its first `keep` CONTENT lines, keeping the `@@` headers that make it renderable.
 *
 * Bounding by SOURCE lines rather than by rendered rows is what lets the fold marker state an exact
 * `+N lines`: a count of rendered rows is a number the reader cannot check, because wrapping means
 * rows and lines are not the same thing.
 */
export function boundPatch(patch: string, keep: number): { patch: string; hidden: number } {
  const kept: string[] = [];
  let shown = 0;
  let total = 0;
  eachPatchLine(patch, (raw, meta) => {
    if (meta) {
      if (shown < keep) kept.push(raw);
      return;
    }
    total++;
    if (shown < keep) {
      kept.push(raw);
      shown++;
    }
  });
  // A trailing `@@` kept for a hunk that got no content lines would render as a gap marker to
  // nowhere.
  while (kept.length && kept[kept.length - 1].startsWith('@@')) kept.pop();
  return { patch: kept.join('\n'), hidden: Math.max(0, total - shown) };
}

/**
 * Render the whole thing. Pure: no clock, no filesystem, no terminal — the frame is a value, so a
 * band's width and a wrapped continuation can both be asserted in a unit test.
 */
export function renderRichDiff(patch: string, opts: RichDiffOpts): string[] {
  const { cols, color: depth } = opts;
  const g = opts.glyphs ?? defaultGlyphs();
  const lines = markIntraline(parsePatch(patch));
  const out: string[] = [];

  // Header: the verb and the WHOLE path, wrapped if it must be, never abbreviated.
  const verb = opts.verb ?? 'Update';
  const head = `● ${verb}(${opts.path ?? ''})`;
  if (opts.header !== false) {
    for (const part of wrapVisible(head, cols)) {
      out.push(depth === 'none' ? fitVisible(part, cols) : fitVisible(`\x1b[1m${part}\x1b[0m`, cols));
    }
  }
  if (opts.header !== false && (opts.added !== undefined || opts.removed !== undefined)) {
    const a = opts.added ?? 0;
    const r = opts.removed ?? 0;
    const sum = `  ${g.wrap} Added ${a} line${a === 1 ? '' : 's'}, removed ${r} line${r === 1 ? '' : 's'}`;
    out.push(depth === 'none' ? fitVisible(sum, cols) : fitVisible(`\x1b[2m${sum}\x1b[0m`, cols));
  }

  // Decided ONCE per render, not per row: the question is about the patch, not about the line.
  const asSource = opts.newFile === 'source' && isCreation(patch);
  // Docblock state is threaded ONLY in source mode. There the rows are a whole file in order, so
  // `/**` on one row genuinely means the next row is inside a comment. In a DIFF they are not
  // contiguous — a hunk boundary or a removed line breaks the run — and carrying the state across
  // one would paint live code as prose, which is the exact failure this module refuses to risk.
  let inBlock = false;
  let afterLine = false;

  const gutter = Math.max(3, String(lines.reduce((mx, l) => Math.max(mx, l.n ?? 0), 0)).length);
  const bodyW = Math.max(1, cols - gutter - 2); // gutter + space + marker

  for (const l of lines) {
    if (l.kind === 'hunk') {
      if (opts.hunks === 'elide') {
        // The FIRST hunk marks no gap — there is nothing above it to be separated from.
        if (out.length) out.push(depth === 'none' ? g.fold : `\x1b[2m${g.fold}\x1b[0m`);
        continue;
      }
      out.push(fitVisible(depth === 'none' ? l.text : `\x1b[36m${l.text}\x1b[0m`, cols));
      continue;
    }
    // In source mode an added line IS the file's content, so it takes the unbanded, syntax-coloured
    // path a context line takes — and loses the '+' marker, which would be claiming a change against
    // a version that never existed.
    const kind = asSource && l.kind === 'add' ? 'ctx' : l.kind;
    const mark = kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
    const num = (l.n === null ? '' : String(l.n)).padStart(gutter);
    // Content WRAPS: a diff line cut at the pane edge is content silently lost, and a reader cannot
    // reconstruct it from anywhere else on screen.
    //
    // HARD wrap, not word wrap. Word wrapping splits on spaces, which silently ate the leading
    // indentation of every wrapped line — `  return x` rendered as `return x`. In code that is a
    // fidelity bug and in Python it is a semantic one, so a diff must reproduce its bytes exactly and
    // break wherever the width runs out.
    const panned = opts.panX ? sliceVisible(sanitizeCell(l.text), opts.panX, bodyW) : null;
    const parts =
      panned !== null ? [panned] : displayWidth(l.text) <= bodyW ? [l.text] : hardWrap(sanitizeCell(l.text), bodyW);
    if (asSource) afterLine = blockStateAfter(l.text, inBlock);
    parts.forEach((part, i) => {
      const n = i === 0 ? num : ' '.repeat(gutter);
      const m = i === 0 ? mark : ' ';
      const plain = `${n} ${m}${part}`;
      if (depth === 'none' || kind === 'ctx') {
        // A context line has no band, so the foreground is the only channel it has.
        const lit = opts.syntax && depth !== 'none' ? `${dim(n, depth)} ${m}${highlightSource(part, depth, asSource && inBlock)}` : plain;
        out.push(fitVisible(pad(lit, cols), cols));
        return;
      }
      // The band runs the full width, so the shape of the change is legible before the text is.
      const band = BAND[kind === 'add' ? 'add' : 'del'];
      const bg = depth === 'truecolor' ? `\x1b[48;2;${band.rgb}m` : depth === '256' ? `\x1b[48;5;${band.c256}m` : kind === 'add' ? '\x1b[42m' : '\x1b[41m';
      // Paint the changed characters in the brighter tone, on top of the line band. Offsets are into
      // the ORIGINAL text, so they are shifted by where this wrapped part began.
      //
      // The TEXT on a changed line took the DEFAULT foreground from 2026-08-14 until 2026-08-15,
      // when code became coloured like code everywhere, as it looks in an editor. The original objection was that
      // syntax made the foreground the louder channel; what actually made it loud was applying it
      // to a line whose band had been LOST. With the band intact the two channels are independent —
      // background says added/removed, foreground says what the code is — and the intraline marking
      // still composes on top, because `hot` now walks escapes instead of counting them as columns.
      const offset = parts.slice(0, i).reduce((acc, q) => acc + q.length, 0);
      // Syntax FIRST (foreground), then the intraline band walks it (background). `offset` counts
      // visible characters, which is what the spans are measured in, so highlighting must not shift
      // them — `hot` copies escapes without advancing that count.
      const painted = opts.syntax ? highlightSource(part, depth, asSource && inBlock) : part;
      const body = `${dim(n, depth)} ${m}${l.spans && l.spans.length ? hot(painted, l.spans, offset, band, depth, kind === 'add') : painted}`;
      out.push(`${bg}${fitVisible(pad(stripReset(body), cols), cols)}\x1b[0m`);
    });
    if (asSource) inBlock = afterLine;
  }
  return out;
}

/** Re-band just the changed spans of one (possibly wrapped) part of a line. */
function hot(part: string, spans: [number, number][], offset: number, band: { rgb: string; c256: number; hot: string; hot256: number }, depth: ColorDepth, add: boolean): string {
  // At 16 colours there is no brighter pair — 48;5 codes here painted HALF the line in sequences a
  // strict 16-colour terminal ignores, so the band dropped out exactly where the change was. The
  // basic band re-asserts instead, and the whole line stays banded; the marker carries the rest.
  const base = depth === 'truecolor' ? `\x1b[48;2;${band.rgb}m` : depth === '256' ? `\x1b[48;5;${band.c256}m` : add ? '\x1b[42m' : '\x1b[41m';
  const bright = depth === 'truecolor' ? `\x1b[48;2;${band.hot}m` : depth === '256' ? `\x1b[48;5;${band.hot256}m` : base;
  let out = '';
  // ESCAPE-AWARE. The text may already carry syntax colour (a FOREGROUND run); those bytes occupy
  // no column, so they are copied verbatim and never advance the position the spans are measured
  // in. Counting them would slide the intraline marking off the characters that changed.
  let vis = 0;
  let cur = '';
  for (let k = 0; k < part.length; ) {
    if (part[k] === '\x1b') {
      const esc = /^\x1b\[[0-9;]*m/.exec(part.slice(k));
      if (esc) {
        out += esc[0];
        k += esc[0].length;
        continue;
      }
    }
    const abs = offset + vis;
    const want = spans.some(([a, b]) => abs >= a && abs < b) ? bright : base;
    if (want !== cur) {
      out += want;
      cur = want;
    }
    out += part[k];
    k++;
    vis++;
  }
  return out + base;
}

const dim = (s: string, depth: ColorDepth) => (depth === 'none' ? s : `\x1b[2m${s}\x1b[22m`);
/** Drop full resets so they cannot cancel the band mid-line; attribute-scoped resets are kept. */
const stripReset = (s: string) => s.replace(/\x1b\[0m/g, '\x1b[39m');

/** Break at exactly `w` columns, preserving every character including leading whitespace. */
function hardWrap(s: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of s) {
    if (displayWidth(line + ch) > w) {
      out.push(line);
      line = '';
    }
    line += ch;
  }
  out.push(line);
  return out;
}

function pad(s: string, w: number): string {
  const gap = w - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
