/**
 * File classification and the shared filter/sort semantics for the change map and the Traces list.
 *
 * One place so the TUI, the VS Code extension, and the JetBrains plugin all bucket a path the same
 * way and apply the same filter — the paths flow to every front-end as change-map JSON, and each
 * enriches its rows (`ext`, `category`) from here, so the six category labels and the regex/extension
 * matching never drift between surfaces.
 */
import type { SortKey } from './prefs';

/** The six buckets the "filter by file type" control offers. `code` is the default for a recognized
 *  source extension; `other` is the catch-all (binaries, images, data, unknowns). */
export type FileCategory = 'code' | 'tests' | 'config' | 'docs' | 'styles' | 'other';
export const FILE_CATEGORIES: FileCategory[] = ['code', 'tests', 'config', 'docs', 'styles', 'other'];

/** Human labels for the categories (front-ends render these). */
export const FILE_CATEGORY_LABEL: Record<FileCategory, string> = {
  code: 'Code',
  tests: 'Tests',
  config: 'Config',
  docs: 'Docs',
  styles: 'Styles',
  other: 'Other',
};

/** The lowercased extension of a path WITHOUT the dot (`ts`, `py`, `''` for none). The basename after
 *  the last dot; a leading-dot dotfile (`.gitignore`) has no extension, it IS the name. */
export function fileExt(rel: string): string {
  const base = rel.slice(rel.replace(/\\/g, '/').lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or a leading-dot dotfile (dot at 0)
  return base.slice(dot + 1).toLowerCase();
}

const STYLE_EXTS = new Set(['css', 'scss', 'sass', 'less', 'styl', 'pcss']);
const DOC_EXTS = new Set(['md', 'mdx', 'rst', 'txt', 'adoc', 'org']);
const DOC_NAMES = new Set(['license', 'readme', 'changelog', 'authors', 'notice', 'contributing', 'codeowners']);
const CONFIG_EXTS = new Set([
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'lock', 'editorconfig', 'gitignore', 'gitattributes', 'dockerignore', 'npmrc', 'nvmrc', 'plist',
]);
const CONFIG_NAMES = new Set(['dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'brewfile', 'justfile', 'vagrantfile']);
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'clj', 'cljs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'cs', 'fs', 'swift', 'm', 'mm',
  'php', 'pl', 'pm', 'lua', 'r', 'dart', 'ex', 'exs', 'erl', 'hrl', 'hs', 'ml', 'mli',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'proto', 'graphql', 'gql', 'gradle', 'cmake',
  'jl', 'nim', 'zig', 'v', 'sol', 'tf', 'hcl',
]);

const TEST_PATH = /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|__snapshots__)(\/|$)/i;
const TEST_NAME = /(\.|_|-)(test|spec)\.[a-z0-9]+$|test\.[a-z0-9]+$/i;

/** `test_foo.py`: a `test_` at the start of a name, or after `_`, before its extension. What
 *  `(^|[/_])test_[^/]*\.[a-z0-9]+$` matched, found without rescanning the rest from every `_test_`. */
function testPrefixed(base: string): boolean {
  const ext = /\.[a-z0-9]+$/i.exec(base);
  if (!ext) return false;
  return /(^|_)test_/i.test(base.slice(base.lastIndexOf('/', ext.index) + 1, ext.index));
}

/** Classify a workspace-relative path into one of the six buckets. Tests win over the code they test
 *  (a `.test.ts` is a test, not code); the order below encodes that precedence. */
export function fileCategory(rel: string): FileCategory {
  const path = rel.replace(/\\/g, '/');
  const origBase = path.slice(path.lastIndexOf('/') + 1);
  const base = origBase.toLowerCase();
  const ext = fileExt(path);
  // Tests first — by directory (…/tests/…, __tests__/) or by name. The `test` must sit on a word
  // boundary: `foo.test.ts`, `foo_test.py`, `test.ts` are tests; `latest.ts`, `contest.py`, `attest.go`,
  // `protest.rs` are NOT (the earlier unanchored /test\./ and /test$/ matched them). camelCase
  // `FooTest.kt` / `FooTests.java` is matched on the ORIGINAL case (a capital T after a lowercase/digit).
  if (TEST_PATH.test(path) || TEST_NAME.test(base) || testPrefixed(base)
      || /(^|[._-])test\.[a-z0-9]+$/.test(base)
      || /(^|[._-])test$/.test(base.replace(/\.[a-z0-9]+$/, ''))
      || /[a-z0-9]Tests?\.[A-Za-z0-9]+$/.test(origBase)) return 'tests';
  if (ext && STYLE_EXTS.has(ext)) return 'styles';
  if ((ext && DOC_EXTS.has(ext)) || DOC_NAMES.has(base.replace(/\.[a-z0-9]+$/, '')) || DOC_NAMES.has(base)) return 'docs';
  if ((ext && CONFIG_EXTS.has(ext)) || CONFIG_NAMES.has(base) || /\.config\.[a-z0-9]+$/.test(base) || /^\.[a-z].*rc$/.test(base) || base.startsWith('.env')) return 'config';
  if (ext && CODE_EXTS.has(ext)) return 'code';
  return 'other';
}

/** The filter the new control holds. Every field is optional and ANDed: a row must match the query
 *  (if any), belong to one of `exts` (if any), and one of `categories` (if any). */
export interface FileFilter {
  query?: string; // matched as a regex when it carries regex syntax (see isRegexQuery), else a substring
  exts?: string[]; // bare extensions without the dot, lowercased ('ts', 'py')
  categories?: FileCategory[];
}

/** Whether `pattern` compiles as a regex. */
export function regexValid(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

// The regex metacharacters that mark a query as a PATTERN rather than a literal — deliberately
// EXCLUDING `.` and `/`, which are in every ordinary path fragment (`index.ts`, `src/models`) and
// would turn a plain filename search into an accidental regex. Any of these present ⇒ regex mode.
const REGEX_SIGNAL = /[\^$*+?()[\]{}|\\]/;

/** Whether a query should be read as a regex — true when it carries regex syntax. The filter has no
 *  manual mode; this is how it decides. A front-end can use it to badge the field as a live pattern. */
export function isRegexQuery(query: string): boolean {
  return REGEX_SIGNAL.test(query.trim());
}

/** Match a path's text against the query. A query that carries regex syntax is a case-insensitive
 *  REGEX; anything else is a case-insensitive substring. A pattern that looks like a regex but does
 *  not compile falls back to substring — a half-typed `(` still narrows rather than emptying the list. */
export function queryMatches(rel: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const hay = rel.toLowerCase();
  if (isRegexQuery(q)) {
    try {
      return new RegExp(q, 'i').test(rel);
    } catch {
      return hay.includes(q.toLowerCase());
    }
  }
  return hay.includes(q.toLowerCase());
}

/** The whole predicate: query AND extension AND category, each dimension skipped when empty. `ext`/
 *  `category` are passed in (the rows already carry them) so this stays a pure string check. */
export function matchesFileFilter(rel: string, ext: string, category: FileCategory, spec: FileFilter | null | undefined): boolean {
  if (!spec) return true;
  if (spec.query && !queryMatches(rel, spec.query)) return false;
  if (spec.exts && spec.exts.length && !spec.exts.includes(ext)) return false;
  if (spec.categories && spec.categories.length && !spec.categories.includes(category)) return false;
  return true;
}

/** True when a spec would narrow anything — so a front-end can show the control as "active". */
export function filterActive(spec: FileFilter | null | undefined): boolean {
  return !!spec && (!!spec.query?.trim() || !!spec.exts?.length || !!spec.categories?.length);
}

/** The comparator behind the sort control. Four directions: `time` newest edited first, `time-asc`
 *  oldest first, `name` path A→Z, `name-desc` path Z→A. Rows carry `rel` and `maxTs` already; a name
 *  sort still breaks maxTs ties by path so the order is total and stable. */
export function compareBySort<T extends { rel: string; maxTs: number }>(key: SortKey): (a: T, b: T) => number {
  switch (key) {
    case 'name':
      return (a, b) => a.rel.localeCompare(b.rel);
    case 'name-desc':
      return (a, b) => b.rel.localeCompare(a.rel);
    case 'time-asc':
      return (a, b) => a.maxTs - b.maxTs || a.rel.localeCompare(b.rel);
    default: // 'time'
      return (a, b) => b.maxTs - a.maxTs || a.rel.localeCompare(b.rel);
  }
}
