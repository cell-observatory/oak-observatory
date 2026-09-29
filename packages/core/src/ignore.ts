/**
 * `.observatoryignore` — which edits this tool bothers you about.
 *
 * Every edit Claude makes is captured, including the ones nobody reviews: lockfiles, `dist/`,
 * snapshots, generated clients. This is the control, and it is deliberately `.gitignore`-shaped
 * because that is the syntax every user already knows.
 *
 * ONE MODE: a path that matches is NEVER RECORDED. Not captured, so not listed, not counted, and
 * not revertible — there is nothing to revert. That makes this file the only place in the product
 * where a typo costs data rather than visibility, which is why `ignore --check` names the rule that
 * decided and why `deadRules` reports a rule that can never fire.
 *
 * NESTED, nearest wins. A `.observatoryignore` in any directory governs its subtree, and its
 * patterns are relative to ITS OWN directory — the same rule git uses. That is what makes this
 * module need no "workspace root" parameter: the walk from the filesystem root down to a file's
 * directory picks up every governing file on the way, wherever the workspace happens to start, so
 * `reviewEdits(session)` and the capture hook can both ask without threading a cwd through eleven
 * call sites (each of which would silently lose the filter by forgetting).
 *
 * GIT'S SEMANTICS, INCLUDING THE FAMOUS GOTCHA. An excluded directory ends the descent, so
 * `dist/` followed by `!dist/manifest.json` does NOT re-include the manifest — exactly as in git.
 * Deviating would surprise everyone who knows the format; instead `ignore --check` names the rule
 * that decided, so the gotcha is diagnosable rather than mysterious. (`dist/*` + `!dist/manifest.json`
 * is the working form, in git and here.)
 *
 * Zero dependencies. capture.ts must stay fs/path/crypto-only and the CLI package has no runtime
 * dependencies at all, so the matcher is ours rather than a glob library's.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';

export const IGNORE_FILE = '.observatoryignore';

/**
 * The per-checkout, NOT-committed list — this tool's `$GIT_DIR/info/exclude`.
 *
 * git documents three tiers and they are three different intentions: patterns everyone should share
 * go in the tracked file, patterns "specific to a particular repository but which do not need to be
 * shared" go in `$GIT_DIR/info/exclude`, and patterns a user wants everywhere go in the global one.
 * Without this middle tier the only way to hide something in one checkout is to commit that decision
 * into a repo other people work in.
 */
export const REPO_PRIVATE_IGNORE = '.git/info/observatoryignore';

/** One compiled pattern line. `source`/`line`/`pattern` exist so `ignore --check` can name what decided. */
export interface IgnoreRule {
  /** Matches a path relative to the rule's base directory, forward-slashed, no leading slash. */
  re: RegExp;
  /** `!` prefix — re-includes rather than excludes. */
  negated: boolean;
  /** Trailing `/` — matches directories only. */
  dirOnly: boolean;
  /** The `.observatoryignore` this came from. */
  source: string;
  /** 1-based line number within that file. */
  line: number;
  /** The pattern text as written. */
  pattern: string;
}

/** The rules from one `.observatoryignore`, plus the directory their patterns are relative to. */
export interface IgnoreLayer {
  /** Absolute, forward-slashed directory. Patterns are relative to it; it governs its subtree. */
  base: string;
  /** Empty base semantics: match at any depth (the personal `~/.claude/.observatoryignore` layer). */
  anywhere: boolean;
  rules: IgnoreRule[];
}

export interface IgnoreDecision {
  /** True when the path is excluded — which means it is never recorded. */
  ignored: boolean;
  /** The rule that decided, or null when nothing matched. */
  rule: IgnoreRule | null;
  /** The path the deciding rule actually matched — the file itself, or the excluded ANCESTOR
   *  directory that ended the descent. Naming it is the difference between "why was this skipped?"
   *  and a mystery. */
  matched: string | null;
}

export interface IgnoreContext {
  /** Every `.observatoryignore` actually read, absolute and sorted. Feed this to `cachedByFiles` so
   *  editing one invalidates whatever was derived under it. */
  readonly files: string[];
  /** True when any rule was found at all — lets callers skip the per-path work entirely. */
  readonly active: boolean;
  /** Every layer loaded so far, weakest first — what [deadRules] walks. */
  readonly layers: readonly IgnoreLayer[];
  decide(file: string, isDir?: boolean): IgnoreDecision;
  /** Excluded, and therefore never recorded. Pass `isDir` for a directory — a `dist/` rule is
   *  directory-only and will not match the path as a file. */
  ignored(file: string, isDir?: boolean): boolean;
}

const slash = (p: string): string => p.replace(/\\/g, '/');

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/**
 * Translate one gitignore pattern into a regex over a base-relative, forward-slashed path.
 *
 * `*` and `?` never cross a separator; `**` does. A pattern containing a slash anywhere but its end
 * is anchored to the base directory, otherwise it matches at any depth — git's rule, and the reason
 * `*.log` works everywhere while `src/*.log` does not.
 */
function compile(pattern: string, anywhere: boolean): RegExp | null {
  let body = '';
  let i = 0;
  const p = pattern;
  // Anchored when a '/' appears anywhere except as the final character, or when it leads.
  const inner = p.endsWith('/') ? p.slice(0, -1) : p;
  const anchored = !anywhere && (inner.startsWith('/') || inner.includes('/'));
  if (p.startsWith('/')) i = 1;
  for (; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) {
      body += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    if (c === '/') {
      if (i === p.length - 1) break; // trailing '/' is dirOnly, not part of the match
      body += '/';
      continue;
    }
    if (c === '*') {
      // '**' spans separators; a lone '*' does not.
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          body += '(?:.*/)?'; // 'a/**/b' also matches 'a/b'
        } else if (i === p.length - 1) {
          body += '.*';
        } else {
          body += '.*';
        }
      } else {
        body += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      body += '[^/]';
      continue;
    }
    if (c === '[') {
      // A character class, passed through with its negation spelled git's way ('!' or '^').
      const close = p.indexOf(']', i + 2);
      if (close === -1) {
        body += '\\[';
        continue;
      }
      let cls = p.slice(i + 1, close);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      body += '[' + cls + ']';
      i = close;
      continue;
    }
    body += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (!body) return null;
  const prefix = anchored ? '' : '(?:.*/)?';
  try {
    return new RegExp('^' + prefix + body + '$');
  } catch {
    return null; // a malformed character class must never take the process down
  }
}

/**
 * Parse one `.observatoryignore`'s text into rules, in file order.
 *
 * Exported for tests: the matcher's edge cases are where a hand-rolled gitignore usually fails, and
 * they are worth asserting without touching the filesystem.
 */
export function parseIgnoreFile(text: string, source: string, anywhere = false): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    // A comment is just a comment. An earlier draft gave `# capture: off` a meaning here, switching
    // later patterns from hiding to refusing; with one mode there is nothing for it to switch, so it
    // reads as the ordinary comment git has always treated it as.
    if (/^\s*#/.test(raw)) continue;
    // Trailing whitespace is not part of a pattern unless escaped; leading whitespace never is.
    let line = raw.replace(/^\s+/, '').replace(/(?<!\\)\s+$/, '');
    if (!line) continue;
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    else if (line.startsWith('\\!')) line = line.slice(1);
    if (!line) continue;
    const dirOnly = line.endsWith('/');
    const re = compile(line, anywhere);
    if (!re) continue;
    rules.push({ re, negated, dirOnly, source, line: n + 1, pattern: raw.trim() });
  }
  return rules;
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

/** Parsed files, keyed by path, revalidated against (mtime,size) on every use — so the parse is
 *  reused across contexts while an edit to the file is still picked up immediately. */
const parseCache = new Map<string, { stamp: string; rules: IgnoreRule[] }>();

function stampOf(p: string): string | null {
  // `throwIfNoEntry: false` rather than try/catch for the MISSING case: measured 4x faster across
  // ~100 probes, and this runs once per directory on the path of every edited file. It is kept.
  //
  // The try/catch is for a different errno, and is not optional. `throwIfNoEntry` suppresses ENOENT
  // and nothing else — so when a component of the path is a FILE rather than a directory, this throws
  // ENOTDIR. That is not a hypothetical: walking up from `dist/x.js` where `dist` is a file stats
  // `dist/.git/info/observatoryignore`, and the ignore rules have to answer for exactly that path in
  // order to say whether `dist` matches as a file.
  //
  // It was invisible on macOS, which reports the case as ENOENT and therefore suppresses it, and
  // failed on Linux, which reports ENOTDIR. The existing `dist/` test covers it and is green on a Mac
  // either way; CI is what has to catch this, and did. Empty catch on purpose: every failure here
  // means "no usable ignore file at this path", which is exactly what null says.
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(p, { throwIfNoEntry: false });
  } catch {
    return null;
  }
  return st && st.isFile() ? `${st.mtimeMs}:${st.size}` : null;
}

/**
 * A fingerprint of the rules a context actually consulted: every file it read, with its (mtime,size).
 *
 * [files] is the TRUE input set — an ignore file that appears, disappears, or is edited all move this
 * string, and a file that was never on any consulted path never enters it. That is what lets the
 * capture hook answer "have the rules changed since the last sweep?" with a handful of stats instead
 * of a re-derivation.
 *
 * Its resolution is the filesystem's: a rewrite inside the same millisecond that leaves the size
 * unchanged is invisible. Every other stamp in this product carries the same exposure, and the sweep
 * it gates is idempotent, so the cost of a miss is a delay rather than a wrong answer.
 */
export function ignoreStamp(ctx: IgnoreContext): string {
  return ctx.files.map((f) => `${f}:${stampOf(f) ?? '-'}`).join('\n');
}

/** Ignore files that EXIST but could not be read, path -> errno. Surfaced by [ignoreProblems]; the
 *  alternative is a rule file that silently stops applying. */
const unreadable = new Map<string, string>();

/** Every `.observatoryignore` that is present but unreadable, as sentences. Empty is the normal case. */
export function ignoreProblems(): string[] {
  return [...unreadable].map(([f, why]) => `${f} could not be read (${why}) — its rules are NOT in force`);
}

function loadFile(file: string, anywhere: boolean): IgnoreRule[] | null {
  const stamp = stampOf(file);
  if (stamp === null) return null;
  const hit = parseCache.get(file);
  if (hit && hit.stamp === stamp) return hit.rules;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // PRESENT BUT UNREADABLE is not ABSENT. `stampOf` already proved the file exists (its directory
    // was readable), so a failure here is a permissions problem, and returning null would make a file
    // full of rules — including `# capture: off` ones — behave exactly like no file at all. Silently
    // deciding to start recording what a file says never to record is the worst direction this can
    // fail in, so it is recorded and surfaced rather than swallowed.
    unreadable.set(file, String((e as NodeJS.ErrnoException)?.code || (e as Error)?.message || e));
    return null;
  }
  unreadable.delete(file);
  const rules = parseIgnoreFile(text, file, anywhere);
  parseCache.set(file, { stamp, rules });
  return rules;
}

/** Everything a directory contributes: the layers in force inside it, and whether it is already
 *  excluded (which settles every path beneath it without another lookup). */
interface DirState {
  layers: IgnoreLayer[];
  /** Set when this directory, or one of its ancestors, is excluded. */
  excluded: IgnoreDecision | null;
}

const NOT_IGNORED: IgnoreDecision = { ignored: false, rule: null, matched: null };

/**
 * A fresh matcher. Every directory is re-stat'd as it is consulted (cheap — see [stampOf]), so a
 * newly created, edited or deleted `.observatoryignore` takes effect at once and [files] is always
 * the true set of inputs the answers depend on.
 */

export function ignoreContext(opts?: { home?: string | null; gitignore?: boolean }): IgnoreContext {
  const byDir = new Map<string, IgnoreLayer[]>();
  // One decision per distinct (path, isDir) within a context. A session's log holds many edits per
  // file — 7,922 records over 3,957 files on the largest store here — and every one of them asks the
  // same question, so without this the filter re-walks the same ancestor chain thousands of times.
  const decided = new Map<string, IgnoreDecision>();
  const dirStates = new Map<string, DirState>();
  const files: string[] = [];
  let active = false;

  // The personal layer, outermost and weakest: noise rules that should not have to be committed
  // into someone else's repo. Its patterns match at ANY depth — a global list is `*.log` and
  // `node_modules/`, and anchoring those to `~/.claude` would make every one of them dead.
  let homeLayer: IgnoreLayer | null = null;
  const homeFile = opts?.home === undefined ? path.join(claudeConfigDir(), IGNORE_FILE) : opts.home;
  if (homeFile) {
    const rules = loadFile(homeFile, true);
    if (rules && rules.length) {
      homeLayer = { base: '', anywhere: true, rules };
      files.push(slash(homeFile));
      active = true;
    }
  }

  /**
   * The layers a single directory contributes, weakest first: its per-checkout private list, then
   * its shared `.observatoryignore`. Both are anchored to this directory.
   *
   * Order matches git's precedence — a per-directory file overrides `$GIT_DIR/info/exclude` — and the
   * private one only ever exists at a repository root, so checking for it at every level costs one
   * stat per directory and finds it exactly where a reader would put it.
   */
  function layersFor(dir: string): IgnoreLayer[] {
    const hit = byDir.get(dir);
    if (hit !== undefined) return hit;
    const base = dir.replace(/\/$/, '');
    const out: IgnoreLayer[] = [];
    // With `gitignore`, each directory's `.gitignore` is the weakest layer it contributes — what git
    // itself would not track is not what a person reviews, and it is where the bulk of a checkout
    // lives (a JetBrains cache dir carried 4,427 of the 4,970 files that overflowed the Bash walk on
    // this repo, 2026-09-23). Only the Bash tree walk asks for it; every other reader keeps the
    // observatory rules alone.
    for (const name of [...(opts?.gitignore ? ['.gitignore'] : []), REPO_PRIVATE_IGNORE, IGNORE_FILE]) {
      const file = base + '/' + name;
      const rules = loadFile(file, false);
      if (rules && rules.length) {
        out.push({ base, anywhere: false, rules });
        files.push(slash(file));
        active = true;
      }
    }
    byDir.set(dir, out);
    return out;
  }

  /** The deepest rule matching `abs`, searching layers deep→shallow and, within a layer, last→first
   *  — so a deeper file overrides a shallower one and a later line overrides an earlier one. */
  function matchAt(abs: string, isDir: boolean, layers: IgnoreLayer[]): IgnoreRule | null {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      let rel: string;
      if (layer.anywhere) {
        rel = abs.replace(/^\/+/, '');
      } else {
        if (abs !== layer.base && !abs.startsWith(layer.base + '/')) continue;
        rel = abs.slice(layer.base.length + 1);
        if (!rel) continue; // the base directory itself is never matched by its own file
      }
      for (let r = layer.rules.length - 1; r >= 0; r--) {
        const rule = layer.rules[r];
        if (rule.dirOnly && !isDir) continue;
        if (rule.re.test(rel)) return rule;
      }
    }
    return null;
  }

  function decide(file: string, isDir = false): IgnoreDecision {
    // The separator is written as an ESCAPE, never as a raw byte: a shell heredoc put two real 0x00
    // bytes here, which makes grep treat this 546-line module as binary and return zero hits for it,
    // while looking completely normal in an editor.
    const memoKey = (isDir ? 'd' : 'f') + '\u0000' + file;
    const hit = decided.get(memoKey);
    if (hit) return hit;
    const value = decideUncached(file, isDir);
    decided.set(memoKey, value);
    return value;
  }

  /**
   * A directory's layers, and whether it is already excluded — memoized, and built from its PARENT's
   * state so each level of the tree is walked once no matter how many files sit under it.
   *
   * This is the same descent git performs (the first excluded ancestor ends it, which is why a
   * negation cannot re-include a file beneath an excluded directory), just amortized: the earlier
   * form re-walked the whole chain for every file, which on a 7,922-edit session over 390 directories
   * meant thousands of repeats of ~390 distinct walks.
   */
  function stateForDir(dir: string): DirState {
    const hit = dirStates.get(dir);
    if (hit) return hit;
    const cut = dir.lastIndexOf('/');
    const parent = cut > 0 ? dir.slice(0, cut) : null;
    const base: DirState = parent !== null
      ? stateForDir(parent)
      : { layers: homeLayer ? [homeLayer] : [], excluded: null };
    const own = layersFor(dir);
    const layers = own.length ? [...base.layers, ...own] : base.layers;
    let excluded = base.excluded;
    // A directory is never judged by the ignore file it CONTAINS (matchAt skips a layer whose base is
    // the path itself), so including `own` here is safe and keeps one list per directory.
    if (!excluded && parent !== null && layers.length) {
      const rule = matchAt(dir, true, layers);
      if (rule && !rule.negated) excluded = { ignored: true, rule, matched: dir };
    }
    const st: DirState = { layers, excluded };
    dirStates.set(dir, st);
    return st;
  }

  function decideUncached(file: string, isDir: boolean): IgnoreDecision {
    const abs = slash(path.resolve(file));
    const cut = abs.lastIndexOf('/');
    const dir = cut > 0 ? abs.slice(0, cut) : '/';
    const st = stateForDir(dir);
    if (st.excluded) return st.excluded; // an excluded ancestor settles it — no later rule can reach in
    if (!st.layers.length) return NOT_IGNORED;
    const rule = matchAt(abs, isDir, st.layers);
    if (!rule) return NOT_IGNORED;
    // A NEGATED match is still a match, and the rule is kept rather than thrown away: it is the rule
    // doing the work, and `ignore --check -v` reports it exactly as `git check-ignore -v` does —
    // "matching an exclude pattern usually means the path is excluded, but if the pattern begins with
    // '!' ... matching it means the path is NOT excluded". Diffed against real git: without this the
    // two outputs disagreed on precisely the re-included path.
    return { ignored: !rule.negated, rule, matched: abs };
  }

  return {
    get files() {
      return [...files].sort();
    },
    get active() {
      return active;
    },
    get layers() {
      // Deduped by base+source: a layer is pushed once per directory it governs, and the same file
      // must not be linted twice because two files under it were asked about.
      const seen = new Set();
      const out = [];
      for (const st of dirStates.values()) {
        for (const l of st.layers) {
          const k = l.base + '\u0000' + (l.rules[0]?.source ?? '');
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(l);
        }
      }
      return out;
    },
    decide,
    ignored: (f, isDir) => decide(f, isDir).ignored,
  };
}

/**
 * A context primed over `paths` — every governing `.observatoryignore` already stat'd, so [files]
 * is complete before any derivation runs and can be used as a cache stamp.
 */
export function ignoreContextFor(paths: readonly string[], opts?: { home?: string | null }): IgnoreContext {
  const ctx = ignoreContext(opts);
  const seen = new Set<string>();
  // Dedupe on the RAW string, before any normalizing. The display path calls this with every file a
  // session edited, and normalizing each one was the whole cost: measured on a 7,922-edit /
  // 390-directory session, `path.resolve` per path cost 4.5 ms while the filesystem work it was
  // there to guard — one stat per distinct directory — cost 0.35 ms.
  //
  // It also never scans a path twice looking for a separator: one `lastIndexOf`, falling back to
  // '\\' only when there is no '/'. That halved this loop (1.45 ms → 0.68 ms on the session above) —
  // `Math.max` of both scans every character of every path for a separator that, off Windows, is
  // never there. A run-check against the previous directory was tried here too and REMOVED: skipping
  // the substring allocation with `startsWith` cost 2.12 ms, three times what it saved, because it
  // compares the whole ~70-character directory on every record.
  for (const p of paths) {
    if (!p) continue;
    let cut = p.lastIndexOf('/');
    if (cut < 0) cut = p.lastIndexOf('\\');
    const dir = cut > 0 ? p.slice(0, cut) : p;
    if (seen.has(dir)) continue;
    seen.add(dir);
    ctx.decide(p);
  }
  return ctx;
}

/** The default personal-layer path, for docs and `ignore --check`. */
export function homeIgnorePath(): string {
  return path.join(claudeConfigDir(), IGNORE_FILE);
}

/** A rule that cannot ever fire, and what to write instead. */
export interface DeadRule {
  rule: IgnoreRule;
  /** The earlier rule that makes it unreachable. */
  shadowedBy: IgnoreRule;
  /** The directory prefix that is excluded, so nothing under it is ever consulted. */
  under: string;
  /** The working form, in the reader's own terms. */
  fix: string;
}

/**
 * Rules that can never fire — the diagnostic git does not have.
 *
 * `git check-ignore -v` names the rule that WON. It never says that the line you actually wrote is
 * dead: given `dist/` then `!dist/manifest.json`, it reports `dist/` and simply never mentions line
 * 2. The reader is left to work out that their negation was unreachable, and that specific confusion
 * is one of the most-asked git questions there is.
 *
 * Why the rule exists at all is worth recording, because it looks like an oversight and is not. Git
 * relaxed it in v2.7.0 (2016) and reverted 32 days later, then tried again and reverted that too:
 * excluded directories are never descended, and that pruning is load-bearing for untracked-file
 * listing and sparse checkout. We have no such coupling — this matcher works from a known list of
 * edited paths, not a tree walk — so we could diverge. We deliberately do not: these files are
 * nested, and Junio Hamano's other argument does bind us, that relaxing makes `dist/` + `!dist/x`
 * behave differently depending on whether it was written in one file or split across two. Matching
 * git and REPORTING the dead rule gets the familiarity without the mystery.
 *
 * Deliberately narrow: this catches the case where a negation sits under a directory an earlier rule
 * excludes, which is the one people hit. It is not a general reachability analysis.
 */
export function deadRules(ctx: IgnoreContext): DeadRule[] {
  const out: DeadRule[] = [];
  for (const layer of ctx.layers) {
    for (let i = 0; i < layer.rules.length; i++) {
      const rule = layer.rules[i];
      if (!rule.negated) continue;
      // The literal ANCESTOR directory of the pattern: everything before its last slash, truncated at
      // the first wildcard. A negation dies only when a directory ABOVE it is excluded — its own
      // basename does not count, which is why a pattern with no slash can never be dead this way.
      // (`*.tmp` then `!build.tmp` is a perfectly good pair, and an earlier draft flagged it.)
      const pat = rule.pattern.replace(/^!/, '').replace(/\/$/, '');
      const lastSlash = pat.lastIndexOf('/');
      if (lastSlash <= 0) continue; // no ancestor to be excluded by
      const head = pat.slice(0, lastSlash).replace(/^\//, '');
      const wild = head.search(/[*?[]/);
      const literal = wild < 0 ? head : head.slice(0, head.lastIndexOf('/', wild) + 1).replace(/\/$/, '');
      if (!literal) continue;
      // Every ancestor directory of that prefix, checked against the rules BEFORE this one — the same
      // descent `decide` performs, which is what makes the answer agree with the matcher.
      const parts = literal.split('/');
      for (let d = 0; d < parts.length; d++) {
        const dir = parts.slice(0, d + 1).join('/');
        let shadow: IgnoreRule | null = null;
        for (let r = i - 1; r >= 0; r--) {
          const prev = layer.rules[r];
          if (prev.negated) continue;
          if (prev.re.test(dir)) { shadow = prev; break; }
        }
        if (shadow) {
          out.push({
            rule,
            shadowedBy: shadow,
            under: dir,
            fix: `${dir}/*`,
          });
          break;
        }
      }
    }
  }
  return out;
}
