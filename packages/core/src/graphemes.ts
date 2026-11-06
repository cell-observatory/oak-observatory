/**
 * Where a character ends, as a reader counts characters: a letter with the combining marks after it, an emoji with its
 * skin tone or variation selector, a keycap, a family or another sequence joined by zero-width joiners, a flag's two
 * regional indicators, a subdivision flag's tags. A cut anywhere else splits what is drawn as one glyph: a title cut at
 * 64 UTF-16 units showed `👨‍👩‍�…`, half a family and half of the next emoji's surrogate pair.
 *
 * Intl.Segmenter knows these rules, and ends the process (SIGSEGV) on a Node with no full ICU data (Fedora's and RHEL's
 * without nodejs-full-i18n), so they are written out here. They are Unicode's extended grapheme clusters (UAX #29) for
 * the characters above, not the rules for Hangul jamo, prepended marks, spacing marks that are not combining marks
 * (Thai's sara am) or Indic conjuncts, with one difference: a zero-width joiner joins the emoji after it to whatever
 * comes before the joiner, where UAX #29 joins only an emoji to an emoji. So no cut ends on a joiner that joins what
 * follows it. A letter after a joiner starts a character of its own, as in UAX #29: when a joiner joined everything
 * after it, a text with one between its letters was one character, which a row too narrow for it left out whole and a
 * title or an action's target cut down to `…`.
 *
 * Zero imports: the terminal app's textwidth.ts loads this module alone.
 */

/** A combining mark: an accent, a variation selector, the keycap's enclosing mark. */
const MARK = /\p{M}/uy;

/** A code point that belongs to the character before it: a combining mark, the zero-width joiner or non-joiner (which
 *  a Persian or Indic word keeps on the letter it follows), a skin-tone modifier or a tag character. */
function extending(s: string, i: number, cp: number): boolean {
  if (cp < 0x300) return false; // the first combining mark is U+0300: Latin text never reaches the regex
  if (cp === 0x200d || cp === 0x200c || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0020 && cp <= 0xe007f)) return true;
  // Nor do the symbol blocks (arrows to box drawing), the CJK ideographs, Yi, Hangul syllables and the emoji blocks,
  // which hold no mark (nearly every character of a CJK row asked the regex; the row took three times as long to fit,
  // and a pane's border, each ─ followed by another, twice as long as before).
  if ((cp >= 0x2100 && cp <= 0x2bff) || (cp >= 0x3400 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return false;
  MARK.lastIndex = i;
  return MARK.test(s);
}

const regional = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const control = (cp: number): boolean => cp < 0x20 || (cp >= 0x7f && cp < 0xa0);

/** What a zero-width joiner joins to the character before it: an emoji, or a symbol a joined sequence can hold (♀, ❤,
 *  ➡). The blocks that hold them rather than \p{Extended_Pictographic}, which reads ICU's emoji data. */
const pictographic = (cp: number): boolean =>
  (cp >= 0x1f000 && cp <= 0x1fbff && !regional(cp)) || (cp >= 0x2190 && cp <= 0x2bff) || cp === 0xa9 || cp === 0xae ||
  cp === 0x203c || cp === 0x2049 || cp === 0x2122 || cp === 0x2139 ||
  cp === 0x3030 || cp === 0x303d || cp === 0x3297 || cp === 0x3299;

/** The end (a UTF-16 index, exclusive) of the character that starts at `i`. */
export function graphemeEnd(s: string, i: number): number {
  if (i >= s.length) return s.length;
  const first = s.codePointAt(i)!;
  let j = i + (first > 0xffff ? 2 : 1);
  if (first === 0x0d) return s.charCodeAt(j) === 0x0a ? j + 1 : j; // a CRLF line break is one
  if (control(first)) return j;
  if (regional(first) && j < s.length && regional(s.codePointAt(j)!)) j += 2; // a flag
  let joined = first === 0x200d;
  while (j < s.length) {
    const cp = s.codePointAt(j)!;
    if (control(cp) || !(extending(s, j, cp) || (joined && pictographic(cp)))) break;
    joined = cp === 0x200d;
    j += cp > 0xffff ? 2 : 1;
  }
  return j;
}

/** The characters of `s`, each a string of one or more code points. */
export function graphemes(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    const end = graphemeEnd(s, i);
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/** Whether a character ends at UTF-16 index `i` (0 < i < s.length): graphemeEnd's rule, read from the code points on
 *  either side of `i` (and, between two regional indicators, from how many come before), so a cut deep in a long text
 *  steps back over one character instead of walking the text from its start. */
function boundaryAt(s: string, i: number): boolean {
  const unit = s.charCodeAt(i - 1);
  if (unit >= 0xd800 && unit <= 0xdbff && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff) return false; // a surrogate pair
  const cp = s.codePointAt(i)!;
  const pairEnd = unit >= 0xdc00 && unit <= 0xdfff && i >= 2 && s.charCodeAt(i - 2) >= 0xd800 && s.charCodeAt(i - 2) <= 0xdbff;
  const prev = pairEnd ? s.codePointAt(i - 2)! : unit;
  if (prev === 0x0d) return cp !== 0x0a;
  if (control(prev) || control(cp)) return true;
  if (extending(s, i, cp)) return false;
  if (prev === 0x200d) return !pictographic(cp);
  if (!regional(cp) || !regional(prev)) return true;
  let run = 0; // the regional indicators before `i`, which pair from the first
  for (let at = i; at >= 2 && regional(s.codePointAt(at - 2)!); at -= 2) run++;
  return run % 2 === 0;
}

/** `s.slice(0, max)` ending where a character does: the longest head of `s` at most `max` UTF-16 units long. */
export function graphemeHead(s: string, max: number): string {
  if (max >= s.length) return s;
  let at = Math.max(0, max);
  while (at > 0 && !boundaryAt(s, at)) at--;
  return s.slice(0, at);
}

/** `s.slice(-max)` starting where a character does: the longest tail of `s` at most `max` UTF-16 units long. */
export function graphemeTail(s: string, max: number): string {
  if (max >= s.length) return s;
  let at = s.length - Math.max(0, max);
  while (at < s.length && !boundaryAt(s, at)) at++;
  return s.slice(at);
}
