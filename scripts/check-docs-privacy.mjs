#!/usr/bin/env node
/**
 * Refuse to ship documentation that leaks a real session.
 *
 * Everything this project publishes — the site, the READMEs, DEMO.md, ARCHITECTURE.md — quotes real
 * command output, and the easiest way to produce that output is to run the command against the session
 * you happen to be in. That is exactly how a maintainer's home path, a real session id, and a verbatim
 * transcript excerpt ended up in a published walkthrough. The rule is simple: quoted output must come
 * from `oak demo`, whose session is synthetic and disposable.
 *
 * Run: node scripts/check-docs-privacy.mjs   (exit 1 on any finding; part of `npm test`)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Anything published from docs/ counts, at any depth — the devcontainer recipe and the mock sources
 *  ship with the site exactly as the pages do. Source files are excluded on purpose: a path in a code
 *  comment explains a code path. */
const TEXT = /\.(html|md|sh|json|js|txt|ya?ml|svg)$/i;
function walk(dir, re = TEXT, out = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, re, out);
    else if (re.test(entry)) out.push(rel);
  }
  return out;
}
const FILES = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  ...walk('docs'),
  ...['cli', 'vscode', 'jetbrains', 'herdr-plugin'].map((p) => join('packages', p, 'README.md')),
  join('packages', 'cli', 'statusline', 'README.md'), // ships in the npm tarball
];
/** Tests and fixtures are public too. They are full of placeholder paths (`/home/user`, `/tmp/x`) and
 *  hashes, so only the rules that name a real machine or session apply to them. */
const TEST_DIRS = ['test', 'packages/core/test', 'packages/tui/test', 'packages/vscode/test', 'packages/jetbrains/src/test'];
const TESTS = TEST_DIRS.filter((d) => existsSync(join(ROOT, d))).flatMap((d) => walk(d, /\.(c?js|mjs|ts|kt|sh|jsonl?|txt|md)$/i));

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const machineNames = [hostname(), '\x6eova', '\x6eebula'].filter(Boolean);
const RULES = [
  {
    id: 'machine-name',
    re: new RegExp(`(?<![a-z0-9_-])(?:${machineNames.map(escapeRegex).join('|')})(?![a-z0-9_-])`, 'gi'),
    why: 'a real machine name belongs to private working state — regenerate with OAK_MACHINE_LABEL=workstation',
  },
  {
    id: 'home-path',
    // A real absolute home directory. `~/…`, `/Users/you/…` and `$HOME/…` are the documented forms.
    re: /\/(?:Users|home)\/(?!(?:you|user|me)\b)[a-z0-9][a-z0-9._-]*/gi,
    why: 'an absolute home path names a real machine and its owner — write ~/… or /Users/you/… instead',
  },
  {
    id: 'machine-temp',
    // A scratch directory on someone's machine. Structural, not keyword-based: `mktemp -d` output looks
    // nothing like "claude" and is exactly what the remediation below produces, so anything under a temp
    // root is suspect unless it is one of the two sanctioned literals the docs use as examples.
    re: /\/(?:private\/)?(?:tmp|var\/folders)\/(?!obs-demo\b|your-temp-dir\b)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g,
    why: 'that is a scratch directory on a real machine — write /tmp/obs-demo/… or run the demo there',
  },
  {
    id: 'session-link',
    re: /claude\.ai\/code\/session|Claude-Session:/g,
    why: 'a Claude session URL or trailer identifies a private working session',
  },
  {
    id: 'transcript-path',
    re: /\.claude\/projects\/-[A-Za-z0-9-]+/g,
    why: 'a mangled project path points at a real transcript directory',
  },
  {
    // Plan and memory files are private working state in exactly the way a transcript is, and this
    // check did not look for them: a real `~/.claude/plans/<name>.md` path reached a committed doc and
    // a source comment as an example of a long filename, carrying the plan's generated name with it.
    id: 'plan-or-memory-path',
    re: /\.claude\/(?:plans|memory)\b/g,
    why: 'a plan or memory path is private working state — use a neutral example filename',
  },
  {
    id: 'real-session-id',
    // Claude Code session ids are v4 UUIDs and Codex's are v7, so any version is matched. Demo
    // sessions are `demo-xxxxxxxx`, which is the only kind of id that belongs in published output.
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    why: 'that is a real Claude Code or Codex session id — quote a demo session (demo-xxxxxxxx) instead',
  },
  {
    id: 'session-id-prefix',
    // The dashboard and both editors DISPLAY a session by its first 8 hex characters, so that is the
    // form a leak actually takes — a full UUID is what nobody pastes. The published README shipped
    // a live session as "🔬 <8 hex>" with its live counts beside it (the prefix is deliberately not
    // reproduced here) and the UUID rule above matched nothing. Anchored to the shapes that mean "session" so an ordinary 8-hex string — a colour, a
    // short commit — is not a false alarm.
    re: /(?:🔬\s*|session\s+|--session\s+)(?!demo-)\b[0-9a-f]{8}\b/gi,
    why: 'that is a real session id as the product displays it — use the demo session (demo-xxxxxxxx)',
  },
  {
    id: 'long-agent-id',
    // Subagent ids are 17 hex chars; the demo's are readable (`demosub1`).
    re: /\b[0-9a-f]{17,}\b/g,
    why: 'that looks like a real subagent id from a live session — use the demo session’s ids',
  },
];

const TEST_RULES = [
  ...RULES.filter((r) => ['machine-name', 'session-link', 'transcript-path'].includes(r.id)),
  {
    id: 'real-session-id',
    // Tests need UUID-shaped ids and write them zero-padded (`00000000-0000-4000-8000-00000000dead`).
    // A random v4 UUID contains `0000` about once in 6,000, so one without it is taken for a real session.
    re: /\b(?![0-9a-f-]*0000)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    why: 'that looks like a real Claude Code or Codex session id — write a zero-padded placeholder (00000000-0000-4000-8000-…)',
  },
];

let findings = 0;
for (const [rel, rules] of [...FILES.map((f) => [f, RULES]), ...TESTS.map((f) => [f, TEST_RULES])]) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue; // a file listed but absent (a redirect stub replaced it, say) is not a leak
  }
  const lines = text.split('\n');
  for (const rule of rules) {
    lines.forEach((line, i) => {
      // A `privacy-ok` comment documents a deliberate exception. It counts on the line itself or the
      // line above, because a continued shell line has nowhere to put a trailing comment.
      if (/privacy-ok/.test(line) || (i > 0 && /privacy-ok/.test(lines[i - 1]))) return;
      const hits = line.match(rule.re);
      if (!hits) return;
      findings++;
      console.error(`${rel}:${i + 1}  [${rule.id}]  ${hits[0]}\n    ${rule.why}`);
    });
  }
}

if (findings) {
  console.error(
    `\n✗ ${findings} privacy finding(s) in published files and tests.\n` +
      '  Regenerate the affected output from the demo session:\n' +
      '    export CLAUDE_CONFIG_DIR=$(mktemp -d) && cd "$(mktemp -d)"\n' +
      '    oak demo --fast && oak <command>\n' +
      '    oak demo --clean\n'
  );
  process.exit(1);
}
console.log(`✓ no session leaks in ${FILES.length} published file(s) and ${TESTS.length} test file(s)`);
