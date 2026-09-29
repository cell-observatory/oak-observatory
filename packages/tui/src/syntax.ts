/**
 * Syntax colour for a diff's CONTEXT lines.
 *
 * Last of the terminal features on purpose, and the only one that ships off by default, because it is
 * the only one whose cost lands on the render path — and this frame re-renders on every keystroke.
 * Three decisions keep it affordable and keep it from fighting the thing it sits inside:
 *
 * 1. CONTEXT LINES ONLY. An added or removed line already carries colour that means something — the
 *    add/remove band, plus the brighter intra-line tone marking the characters that actually changed.
 *    That is the review signal, and it is the whole point of a review diff. Painting a keyword blue on
 *    top of it would put two colour languages on one row and cost the reader the one that matters.
 *    Context lines carry no band, so this is additive rather than competing.
 *
 * 2. PER DRAWN ROW, never per patch line. The caller applies this to the ~40 rows on screen, so a
 *    4,000-line patch costs the same as a 40-line one. Tokenising inside the diff renderer instead
 *    would put the whole patch through it on every cache miss.
 *
 * 3. NOT A PARSER, and it never tries to be — the same rule `markIntraline` follows next door. It
 *    marks four things that are unambiguous enough to be worth colouring and cheap enough to be free:
 *    line comments, quoted strings, numbers, and a small shared keyword set. Anything it is unsure of
 *    it leaves alone, because a wrong highlight in a review tool is worse than none: it makes the
 *    reader doubt what else on the row is being shown to them accurately.
 */
import { ColorDepth } from './glyphs';

/** Deliberately muted. These sit UNDER the review colours in the visual hierarchy — context is what
 *  you read past to reach the change, and anything loud here competes with the band beside it. */
const HUE = {
  comment: { rgb: '106;115;125', c256: 245, c16: 37 },
  string: { rgb: '152;195;121', c256: 108, c16: 32 },
  number: { rgb: '209;154;102', c256: 173, c16: 33 },
  keyword: { rgb: '150;140;200', c256: 104, c16: 35 },
  /** A capitalised identifier — a type, a class, a constructor. */
  type: { rgb: '229;192;123', c256: 180, c16: 36 },
  /** An identifier immediately followed by `(` — a call, or the definition of one. */
  call: { rgb: '97;175;239', c256: 75, c16: 34 },
} as const;

type Hue = keyof typeof HUE;

function open(h: Hue, depth: ColorDepth): string {
  const p = HUE[h];
  return depth === 'truecolor' ? `\x1b[38;2;${p.rgb}m` : depth === '256' ? `\x1b[38;5;${p.c256}m` : `\x1b[${p.c16}m`;
}

/**
 * One keyword set across languages rather than one per language.
 *
 * The alternative is detecting the language from the file extension and carrying a table per language,
 * which is a lot of surface for a context line. These words are keywords in most of what anyone reviews
 * here and are not ordinary identifiers in the rest, so the false-positive rate is low and the failure
 * mode when it does miss is simply "not coloured".
 */
const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'break', 'continue',
  'class', 'extends', 'implements', 'interface', 'type', 'enum', 'import', 'export', 'from', 'as',
  'new', 'this', 'super', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False',
  'fun', 'val', 'object', 'when', 'null', 'true', 'false', 'public', 'private', 'protected', 'static',
  'void', 'struct', 'impl', 'trait', 'match', 'mut', 'pub', 'fn', 'use',
]);

/**
 * Colour one line of source. Returns it unchanged at `none`, and unchanged for anything it is not
 * confident about.
 *
 * The scan is single-pass and left-to-right: a comment swallows the rest of the line, a quote swallows
 * to its matching close, and only what is left is considered for numbers and keywords. That ordering is
 * what stops `// const x` colouring `const` inside a comment.
 */
/**
 * Whether a BLOCK COMMENT is still open after this line.
 *
 * Per-line highlighting cannot see a docblock's middle rows — `* @param x` is just an identifier
 * after a star — so a caller with CONTIGUOUS lines (a whole file, not a diff) threads this through
 * and gets the docblock coloured like an editor colours it. A caller whose lines are not contiguous
 * must not: guessing the state across a hunk boundary would paint code as prose.
 */
export function blockStateAfter(line: string, was: boolean): boolean {
  let open = was;
  for (let i = 0; i < line.length - 1; i++) {
    if (!open && line[i] === '/' && line[i + 1] === '*') { open = true; i++; }
    else if (open && line[i] === '*' && line[i + 1] === '/') { open = false; i++; }
  }
  return open;
}

export function highlightSource(line: string, depth: ColorDepth, inBlock = false): string {
  if (depth === 'none' || !line) return line;
  const R = '\x1b[39m'; // default FOREGROUND only — this runs inside a line that may carry a background
  let out = '';
  let i = 0;
  // Already inside a docblock: everything up to a closing `*/` is comment, and what follows is code.
  if (inBlock) {
    const end = line.indexOf('*/');
    if (end < 0) return `${open('comment', depth)}${line}${R}`;
    out = `${open('comment', depth)}${line.slice(0, end + 2)}${R}`;
    i = end + 2;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    // A line comment takes everything after it, so it is checked first.
    const c = /^(\/\/|#(?!!)|--\s)/.exec(rest);
    if (c) return `${out}${open('comment', depth)}${line.slice(i)}${R}`;
    // A BLOCK comment. Closed on this line, it is a span; left open, it takes the rest — and the
    // caller's `blockStateAfter` carries that to the next row.
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end < 0) return `${out}${open('comment', depth)}${rest}${R}`;
      out += `${open('comment', depth)}${rest.slice(0, end + 2)}${R}`;
      i += end + 2;
      continue;
    }
    const q = /^(['"`])/.exec(rest);
    if (q) {
      const quote = q[1];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) j += line[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, line.length);
      out += `${open('string', depth)}${line.slice(i, end)}${R}`;
      i = end;
      continue;
    }
    const w = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (w) {
      const t = w[0];
      // Three more things an editor separates and this can tell without parsing: a KEYWORD, a name
      // being CALLED (an identifier hard against an open paren is a call or the definition of one),
      // and a TYPE (capitalised — the convention every language here shares). Everything else is an
      // ordinary identifier and stays plain, which is still the majority of any line.
      const hue: Hue | null = KEYWORDS.has(t)
        ? 'keyword'
        : rest[t.length] === '('
          ? 'call'
          : /^[A-Z]/.test(t) && /[a-z]/.test(t)
            ? 'type'
            : null;
      out += hue ? `${open(hue, depth)}${t}${R}` : t;
      i += t.length;
      continue;
    }
    // A number, but not one glued to an identifier — `x2` is a name, not a name and a number.
    const n = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (n) {
      out += `${open('number', depth)}${n[0]}${R}`;
      i += n[0].length;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

/**
 * Colour one SHELL command line.
 *
 * The same rule as `highlightSource` and for the same reason: mark only what is unambiguous. A
 * command line has four things worth separating and nothing else worth risking — the program being
 * run, its flags, its quoted strings, and the operators that join one command to the next.
 * Everything else is an argument and stays plain, because an argument mis-coloured as a flag is a
 * lie about what the agent ran, in a surface whose whole job is to say what the agent ran.
 *
 * The palette is `highlightSource`'s, deliberately: a reader is looking at commands and code in the
 * same column, and two colour languages there would cost them both.
 */
export function highlightShell(line: string, depth: ColorDepth): string {
  if (depth === 'none' || !line) return line;
  const R = '\x1b[39m';
  let out = '';
  let i = 0;
  // The word in program position: the first of the line, and the first after every operator that
  // starts a new command. `npm test | tee log` runs two programs and should read as two.
  let program = true;
  while (i < line.length) {
    const rest = line.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) { out += ws[0]; i += ws[0].length; continue; }
    const op = /^(\|\||&&|>>|[|;&()<>])/.exec(rest);
    if (op) {
      out += `${open('comment', depth)}${op[0]}${R}`;
      i += op[0].length;
      program = true;
      continue;
    }
    const q = /^(['"])/.exec(rest);
    if (q) {
      const quote = q[1];
      let j = 1;
      while (j < rest.length && rest[j] !== quote) j += rest[j] === '\\' ? 2 : 1;
      const tok = rest.slice(0, Math.min(j + 1, rest.length));
      out += `${open('string', depth)}${tok}${R}`;
      i += tok.length;
      program = false;
      continue;
    }
    const word = /^[^\s|;&()<>'"]+/.exec(rest);
    if (!word) { out += line[i]; i += 1; continue; }
    const t = word[0];
    // `FOO=bar cmd` — an assignment is not the program, so program position survives it.
    const assignment = program && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
    if (program && !assignment) { out += `${open('keyword', depth)}${t}${R}`; program = false; }
    else if (!program && t.startsWith('-')) out += `${open('number', depth)}${t}${R}`;
    else out += t;
    i += t.length;
  }
  return out;
}
