/**
 * The characters a terminal or a browser draws as nothing that still act on the text around them: the bidirectional
 * controls, which reorder what comes after them (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069); the
 * zero-width space and no-break space, the word joiner, the invisible operators and the deprecated format characters
 * (U+200B, U+FEFF, U+2060-U+2064, U+206A-U+206F), which only hide in it; the line and paragraph separators
 * (U+2028, U+2029), which JavaScript reads as line breaks where a terminal draws a blank (`// note⟨U+2028⟩run()`
 * runs `run()`); the soft hyphen and the Khmer inherent vowels (U+00AD, U+17B4, U+17B5), drawn as nothing within a
 * line; the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), drawn as a blank,
 * which JavaScript takes into a name (`let ⟨U+3164⟩ = 1` declares one); and the tag characters (U+E0001,
 * U+E0020-U+E007F), which spell out text no one sees (a known way to hide words in a prompt), except in the three
 * flags they finish, England's, Scotland's and Wales's (🏴, the tags `gbeng`, `gbsct` or `gbwls`, then U+E007F). After
 * 🏴 any other tags draw as a black flag, the words they spell hidden behind it, so they are shown too. The zero-width
 * joiner and non-joiner are not among them: an emoji family, a flag or an Indic letter is built with the one, Persian
 * and Indic words are written with the other, and neither reorders anything. Nor are the combining grapheme joiner and
 * the Mongolian vowel separator (U+034F, U+180E), which Hebrew's points and Mongolian words are written with, or the
 * variation selectors (U+180B-U+180D, U+180F, U+FE00-U+FE0F, U+E0100-U+E01EF), which choose how the character before
 * them is drawn.
 *
 * In a title or a label they are dropped (the terminal app's sanitizeCell, plainLabel). In the text of a file, where a
 * reviewer who cannot see them reads code that runs differently from how it reads (Trojan Source, CVE-2021-42574),
 * each is shown as a mark that names it instead (revealHidden), and so is a joiner or non-joiner with only ASCII text
 * beside it, where no emoji, Indic conjunct or Persian word puts one: it hides in an identifier or a string, in the
 * middle (`is⟨U+200D⟩admin` is not `isadmin`) or at the end (`isAdmin⟨U+200D⟩` is a second name, which reads as the
 * first). So is a combining grapheme joiner, a vowel separator or a variation selector there (`isAdmin⟨U+FE0F⟩` is a
 * second name too), and a variation selector after another one, which chooses nothing: a run of them spells out text
 * no one sees, one byte each, after an emoji as well.
 *
 * Zero imports: the terminal app's textwidth.ts loads this module alone.
 */

/** England's, Scotland's and Wales's flags: 🏴, the tags `gb` and `eng`, `sct` or `wls`, and U+E007F. */
const TAG_FLAG = '\\ud83c\\udff4\\udb40\\udc67\\udb40\\udc62(?:\\udb40\\udc65\\udb40\\udc6e\\udb40\\udc67|\\udb40\\udc73\\udb40\\udc63\\udb40\\udc74|\\udb40\\udc77\\udb40\\udc6c\\udb40\\udc73)\\udb40\\udc7f';
const TAG = '[\\udb40\\udc20-\\udb40\\udc7e]';

/** Those characters as a RegExp source, for the webviews too, with the `u` flag (without it the source does not
 *  compile: the tag characters are pairs of UTF-16 units, read as one character only with it). A tag character is one
 *  unless it is in one of those flags: looking back from it, at most five tags to a 🏴 that starts one. At most five,
 *  so the look back is as short at the end of a long run of tags as at its start: looking back over the whole run,
 *  4,000 tags in a row took 25 ms, and 16,000 took 0.4 s. */
export const HIDDEN_SOURCE = '(?:[\\u00ad\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u200b\\u200e\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\u3164\\ufeff\\uffa0]'
  + `|\\udb40\\udc01|[\\udb40\\udc20-\\udb40\\udc7f](?<!(?=${TAG_FLAG})\\ud83c\\udff4(?:${TAG}(?:${TAG}(?:${TAG}(?:${TAG}${TAG}?)?)?)?)?[\\udb40\\udc20-\\udb40\\udc7f]))`;

/** The zero-width joiner and non-joiner, the combining grapheme joiner, the Mongolian vowel separator and the variation
 *  selectors, which a file's text shows only where ASCII text alone is beside them (with the `u` flag). */
export const JOINER_SOURCE = '[\\u034f\\u180b-\\u180f\\u200c\\u200d\\ufe00-\\ufe0f\\udb40\\udd00-\\udb40\\uddef]';

/** A variation selector, which a file's text shows after another one too. */
const SELECTOR = /^[\u180b-\u180d\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]$/u;

/** An ASCII character, which no emoji, Indic letter or Persian word is written in. */
export const ASCII_SOURCE = '[\\u0000-\\u007f]';

const ALWAYS = new RegExp(`^${HIDDEN_SOURCE}$`, 'u');
const ASCII = new RegExp(`^${ASCII_SOURCE}$`);
/** Whether a joiner's neighbour, or the start or end of the text (`''`), leaves it joining nothing. */
const plain = (ch: string): boolean => ch === '' || ASCII.test(ch);
/** A run of hidden characters and joiners: a joiner is judged by the characters on either side of its run, so that two
 *  joiners in a row inside an identifier hide no better than one. */
const RUN = new RegExp(`(?:${HIDDEN_SOURCE}|${JOINER_SOURCE})+`, 'gu');

/** How one of them shows in a file's text: `⟨U+202E⟩`. */
export function hiddenMark(ch: string): string {
  return `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;
}

/** The marks themselves, to style them where they are drawn. */
export const HIDDEN_MARK_SOURCE = '⟨U\\+(?:00AD|034F|061C|115F|1160|17B[45]|180[B-F]|200[B-F]|202[89A-E]|206[0-46-9A-F]|3164|FE0[0-9A-F]|FEFF|FFA0|E00(?:01|[2-7][0-9A-F])|E01[0-9A-E][0-9A-F])⟩';

/** A run as a file's text shows it: each character of HIDDEN_SOURCE as its mark, each joiner as its mark when the run
 *  has ASCII text alone on either side, and a variation selector after another one or after a hidden character, which
 *  it chooses nothing for; `wrap` styles a mark. */
function shown(run: string, joinsNothing: boolean, wrap: (mark: string) => string): string {
  let out = '', prev = '';
  for (const ch of run) {
    out += ALWAYS.test(ch) || joinsNothing || (SELECTOR.test(ch) && (SELECTOR.test(prev) || ALWAYS.test(prev))) ? wrap(hiddenMark(ch)) : ch;
    prev = ch;
  }
  return out;
}

/** A file's text with each of them shown as its mark, dimmed (SGR 2, which leaves the line's colour on) for a
 *  terminal when `dim` is set. */
export function revealHidden(s: string, dim = false): string {
  const wrap = (mark: string) => (dim ? `\x1b[2m${mark}\x1b[22m` : mark);
  return s.replace(RUN, (run: string, at: number) => shown(run, plain(s[at - 1] ?? '') && plain(s[at + run.length] ?? ''), wrap));
}

/** revealHidden for HTML whose text is escaped and whose tags hold no text of the file (a highlighter's spans): a run's
 *  neighbours are the characters of text on either side of it, across the tags between. `wrap` makes each mark's HTML. */
export function revealHiddenHtml(html: string, wrap: (mark: string) => string): string {
  // Escaped text holds no `<` or `>` of its own, so each is a tag's.
  const before = (at: number): string => {
    let i = at;
    while (i > 0 && html[i - 1] === '>') {
      const open = html.lastIndexOf('<', i - 1);
      if (open < 0) return '';
      i = open;
    }
    return html[i - 1] ?? '';
  };
  const after = (at: number): string => {
    let j = at;
    while (html[j] === '<') {
      const close = html.indexOf('>', j);
      if (close < 0) return '';
      j = close + 1;
    }
    return html[j] ?? '';
  };
  return html.replace(RUN, (run: string, at: number) => shown(run, plain(before(at)) && plain(after(at + run.length)), wrap));
}
