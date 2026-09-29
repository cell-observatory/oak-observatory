/**
 * SCOPE detection — the "same function" half of a review unit.
 *
 * Two edits to the same function are one thing to review even when they touch different lines of it, so
 * the unit walk needs to know which function a change fell in. `classes.ts` already answers that for
 * classes with regex + brace/indent matching; this generalises the same approach to functions rather
 * than introducing a second, cleverer mechanism beside it.
 *
 * **Tree-sitter is deliberately not used.** Core's only runtime dependency is `diff` — that is
 * load-bearing, because the CLI is spawned per refresh against a 30 s budget and the JetBrains plugin
 * would need the same grammars again to agree about what a unit is. Git makes the same trade at the
 * same fidelity: its hunk headers come from ~25 per-language `xfuncname` regexes and have labelled
 * review hunks for decades. (Patterns here are written from scratch; git's are GPLv2.)
 *
 * **Failing must not look like succeeding.** When nothing matches, the answer is `null` and the caller
 * names the unit by its line range instead — visibly positional, impossible to mistake for a detected
 * function. No fallback ever wears a guessed name, and the table below is the honest coverage list.
 */

export interface ScopeSpan {
  name: string;
  kind: 'class' | 'function';
  start: number; // 0-based first line of the declaration
  end: number; // 0-based last line, inclusive
}

/** Which family of syntax a path belongs to. Unknown extensions get no scopes, and say so by `null`. */
export function familyOf(file: string): 'py' | 'brace' | null {
  const ext = (file.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase();
  if (ext === 'py' || ext === 'pyi') return 'py';
  if (
    [
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', // TS/JS
      'go', 'rs', 'java', 'kt', 'kts', 'cs', 'swift', 'scala', // other brace languages
      'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', // C family
      'php', 'dart',
    ].includes(ext)
  )
    return 'brace';
  return null;
}

function findOpenBrace(lines: string[], from: number): number {
  for (let i = from; i < Math.min(lines.length, from + 6); i++) if (lines[i].includes('{')) return i;
  return -1;
}

/** Naive brace matcher (ignores braces in strings/comments — acceptable for grouping). */
function matchBrace(lines: string[], openLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = openLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
        if (started && depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/** The end of an indentation-delimited block opened at `i`. */
function matchIndent(lines: string[], i: number, indent: number): number {
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    const ind = lines[j].length - lines[j].trimStart().length;
    if (ind <= indent) break;
    end = j;
  }
  return end;
}

// Python: `def name(`, `async def name(`, `class Name`. A trailing comment is allowed and `\s` eats a
// CR on CRLF files.
const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_][\w]*)\s*(?:\([^)]*\)\s*)?:/;

// Brace languages. Each alternative names its own capture group so one pass can label the match.
const BRACE_PATTERNS: { re: RegExp; kind: ScopeSpan['kind'] }[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  // Go `func Name(` / `func (r *T) Name(`; Rust `fn name(`; TS/JS `function name(`.
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/, kind: 'function' },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*[(<]/, kind: 'function' },
  { re: /^\s*(?:pub\s+(?:\([^)]*\)\s*)?)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_][\w]*)\s*[(<]/, kind: 'function' },
  // `const name = (…) =>` / `= async (…) =>` / `= function(`
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\(|<)/, kind: 'function' },
  // Java/Kotlin/C#/Swift/C-family methods and free functions: modifiers, a return type, then `name(`.
  // Anchored on the modifier/type prefix so it cannot match a bare call like `doThing(x);`.
  { re: /^\s*(?:@[\w.]+\s+)*(?:public|private|protected|internal|static|final|override|open|suspend|inline|virtual|abstract|synchronized|native|fun|def|sub)\s+(?:[\w<>\[\],.?*&: ]+\s+)?([A-Za-z_$][\w$]*)\s*\(/, kind: 'function' },
  // A bare class method — `bar(x: number) {` — which TS/JS write with no modifier at all. This is the
  // one pattern that could swallow ordinary code, so it is anchored to a line that ENDS in `{`: a call
  // statement (`doThing(x);`) never does, and `findOpenBrace`'s six-line lookahead cannot rescue it.
  // Control structures still reach it (`if (x) {`), so the captured name is checked against KEYWORDS.
  { re: /^\s*(?:(?:public|private|protected|static|async|get|set|readonly|override)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+?)?\s*\{\s*$/, kind: 'function' },
];

/** Words that look like a method name at the start of a line but open a control structure. Checked
 *  after the match rather than inside the pattern: a negative lookahead has to be threaded past every
 *  optional modifier, and gets silently wrong the moment one is added. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'try', 'finally', 'return', 'with',
  'function', 'class', 'struct', 'enum', 'interface', 'namespace', 'module', 'using', 'match', 'when', 'unless', 'loop',
]);

/**
 * Class and function spans in one file's text. `file` decides which syntax is tried; an extension this
 * does not know returns [], which the caller must render as "no scope" rather than "no change".
 */
export function detectScopes(text: string, file: string): ScopeSpan[] {
  const family = familyOf(file);
  if (!family) return [];
  const lines = text.split('\n');
  const out: ScopeSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (family === 'py') {
      const d = PY_DEF.exec(line);
      if (d) {
        out.push({ name: d[2], kind: 'function', start: i, end: matchIndent(lines, i, d[1].length) });
        continue;
      }
      const c = PY_CLASS.exec(line);
      if (c) out.push({ name: c[2], kind: 'class', start: i, end: matchIndent(lines, i, c[1].length) });
      continue;
    }
    for (const { re, kind } of BRACE_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      if (KEYWORDS.has(m[1])) break; // `if (…) {` is not a function called `if`
      const open = findOpenBrace(lines, i);
      if (open < 0) break; // a declaration with no body within reach — a prototype, or a wrapped signature
      const end = matchBrace(lines, open);
      if (end >= i) out.push({ name: m[1], kind, start: i, end });
      break; // first pattern wins; `class` is tried before the method form for a reason
    }
  }
  return out;
}

/**
 * The innermost scope containing `line`, or null.
 *
 * Smallest span wins, which is what makes "same function" mean the method rather than the class it sits
 * in. That is also the trap: fold class detection and function detection together without this and every
 * method edit silently re-labels from its class to its method, changing what groups with what.
 */
export function scopeAt(spans: ScopeSpan[], line: number): ScopeSpan | null {
  let best: ScopeSpan | null = null;
  for (const s of spans) {
    if (line >= s.start && line <= s.end) {
      if (!best || s.end - s.start < best.end - best.start) best = s;
    }
  }
  return best;
}
