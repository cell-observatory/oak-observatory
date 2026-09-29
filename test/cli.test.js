const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const source = fs.readFileSync(path.join(root, 'packages/cli/src/index.ts'), 'utf8');
// Exercise the doctor command with its external diagnostics injected: no real PTY, socket,
// installation, or network is needed to check its output and dependency probes.
const doctorCode = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { cmdDoctor, ensureHerdrPin, cmdServer };'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'),
    XDG_CONFIG_HOME: path.join(home, 'config') };
  delete env.HERDR_PANE_ID; // the attach guard keys on it; keep tests independent of where they run
  return { home, env };
}

// Regular files work even where the sandbox denies Node's pipe socketpair.
function run(b, file, args, options = {}) {
  const stdout = path.join(b.home, 'stdout');
  const stderr = path.join(b.home, 'stderr');
  const out = fs.openSync(stdout, 'w');
  const err = fs.openSync(stderr, 'w');
  let result;
  try { result = cp.spawnSync(file, args, { cwd: b.home, env: b.env, timeout: 15000, ...options, stdio: ['ignore', out, err] }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  assert.equal(result.error, undefined);
  return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') };
}

test('CLI sessions: undelete restores only a full hidden id and rejects repeated or partial ids', t => {
  const b = fixture(t);
  const id = 'fixture-session-restore';
  const call = args => run(b, process.execPath, [cli, 'sessions', ...args]);
  assert.equal(call(['--delete', id]).status, 0);
  const partial = call(['--undelete', 'fixture']);
  assert.equal(partial.status, 1, partial.stdout);
  assert.match(partial.stderr, /fixture was not deleted/);
  const restored = call(['--undelete', id]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stdout, `restored ${id}\n`);
  const repeated = call(['--undelete', id]);
  assert.equal(repeated.status, 1, repeated.stdout);
  assert.match(repeated.stderr, /fixture-session-restore was not deleted/);
});

test('CLI sessions: undelete validates unsafe ids before touching the hidden list', t => {
  const b = fixture(t);
  const result = run(b, process.execPath, [cli, 'sessions', '--undelete', '../outside']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--undelete: invalid session id/);
  assert.equal(fs.existsSync(b.env.CLAUDE_CONFIG_DIR), false);
});

test('CLI sessions: successful JSON undelete retains its structured result', t => {
  const b = fixture(t);
  run(b, process.execPath, [cli, 'sessions', '--delete', 'fixture-json']);
  const result = run(b, process.execPath, [cli, 'sessions', '--undelete', 'fixture-json', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { undeleted: 'fixture-json' });
});

test('CLI sessions: delete purges edits pending review only with --force, and says undelete cannot bring them back', t => {
  const b = fixture(t), id = 'fixture-pending';
  const core = path.join(root, 'packages/core/dist');
  const seed = cp.spawnSync(process.execPath, ['-e', `const core=require(${JSON.stringify(core)});core.ensureStore('${id}');
core.appendLog('${id}',{ts:1,tool:'Edit',file:${JSON.stringify(path.join(b.home, 'fixture.txt'))},beforeBlob:core.writeBlob('${id}',Buffer.from('a')),afterBlob:core.writeBlob('${id}',Buffer.from('b')),status:'pending'});`],
  { env: b.env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const store = path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', id);
  const refused = run(b, process.execPath, [cli, 'sessions', '--delete', id]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /1 edit pending review; deleting the session purges that edit for good\. Review it first, or pass --force/);
  assert.ok(fs.existsSync(path.join(store, 'log.jsonl')), 'nothing was purged');
  const forced = run(b, process.execPath, [cli, 'sessions', '--delete', id, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /purged its captured edits .*puts it back in the pickers, without those edits/);
  assert.equal(fs.existsSync(store), false);
  // The JetBrains delete asks through this verb, naming with --force-pending the count its own dialog
  // showed, and with --seen-through the newest edit of the listing it counted from; without them, this
  // refusal stands.
  const jb = fs.readFileSync(path.join(root, 'packages/jetbrains/src/main/kotlin/com/cellobservatory/observatory/core/ObservatoryCli.kt'), 'utf8');
  assert.match(jb, /listOf\("sessions", "--delete", session\) \+ \(if \(confirmedPending > 0\) listOf\("--force-pending", confirmedPending\.toString\(\)\) else emptyList\(\)\) \+\s+\(if \(seenThrough != null\) listOf\("--seen-through", seenThrough\.toString\(\)\) else emptyList\(\)\) \+ "--json"/);
});

// The dialog counts review units, and an edit that rewrites a change it counted, in the same ask, joins that
// change without moving the count. --seen-through carries the newest edit of the
// listing the dialog counted from, and the delete refuses a pending edit newer than that.
test('CLI sessions: the listing names its newest edit, and --seen-through <edit> refuses an edit captured after it', t => {
  const b = fixture(t), id = 'fixture-seen', ws = path.join(b.home, 'work');
  const core = path.join(root, 'packages/core/dist');
  const edit = (steps) => cp.spawnSync(process.execPath, ['-e', `const core=require(${JSON.stringify(core)}), fs=require('fs');core.ensureStore('${id}');
for (const [file, before, after] of ${JSON.stringify(steps)}) { core.appendLog('${id}',{ts:Date.now(),tool:'Edit',file,status:'pending',promptId:'ask-1',
  beforeBlob:core.writeBlob('${id}',Buffer.from(before)),afterBlob:core.writeBlob('${id}',Buffer.from(after))}); fs.writeFileSync(file, after); }`],
  { env: b.env, encoding: 'utf8' });
  const project = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(ws); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), [
    { type: 'user', cwd: ws, sessionId: id, message: { role: 'user', content: 'Edit a and b' } },
    { type: 'assistant', cwd: ws, sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'Edited.' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const A = path.join(ws, 'a.py'), B = path.join(ws, 'b.py');
  assert.equal(edit([[A, 'x = 1\n', 'x = 2\n'], [B, 'def f():\n    return 1\n', 'def f():\n    return 2\n']]).status, 0);
  const listing = run(b, process.execPath, [cli, 'sessions', '--json'], { cwd: ws });
  const row = JSON.parse(listing.stdout).sessions.find((r) => r.id === id);
  assert.deepEqual([row?.pending, row?.lastEdit], [2, 2], 'the row the dialog reads: two changes, and the newest edit it counted');
  assert.equal(edit([[B, 'def f():\n    return 2\n', 'def f():\n    return 3\n']]).status, 0); // joins the change #2 started
  const store = path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', id);
  const late = run(b, process.execPath, [cli, 'sessions', '--delete', id, '--force-pending', '2', '--seen-through', String(row.lastEdit), '--json']);
  assert.equal(late.status, 1, late.stdout);
  assert.match(late.stderr, /fixture-seen captured an edit after the listing this delete was confirmed from, still pending review; deleting the session would purge it unseen, so it was not deleted/);
  for (const bad of [['--seen-through', 'latest'], ['--seen-through']]) {
    const r = run(b, process.execPath, [cli, 'sessions', '--delete', id, '--force-pending', '2', ...bad, '--json']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /--seen-through: expected the newest edit id of the listing the confirmation counted from, got "(latest)?"/);
  }
  assert.ok(fs.existsSync(path.join(store, 'log.jsonl')), 'nothing was purged');
  const named = run(b, process.execPath, [cli, 'sessions', '--delete', id, '--force-pending', '2', '--seen-through=3', '--json']);
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(JSON.parse(named.stdout), { deleted: id });
  assert.equal(fs.existsSync(store), false);
});

test('CLI sessions: --force-pending <n> deletes while no more than n edits are pending, and refuses past it', t => {
  const b = fixture(t), id = 'fixture-named';
  const core = path.join(root, 'packages/core/dist');
  const seed = (n) => cp.spawnSync(process.execPath, ['-e', `const core=require(${JSON.stringify(core)});core.ensureStore('${id}');
for (let i = 0; i < ${n}; i++) { const n = core.nextId('${id}'); core.appendLog('${id}',{id:n,ts:1,tool:'Edit',file:${JSON.stringify(b.home)}+'/f'+n+'.txt',beforeBlob:core.writeBlob('${id}',Buffer.from('a')),afterBlob:core.writeBlob('${id}',Buffer.from('b'+n)),status:'pending'}); }`],
  { env: b.env, encoding: 'utf8' });
  assert.equal(seed(3).status, 0);
  const store = path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', id);
  const past = run(b, process.execPath, [cli, 'sessions', '--delete', id, '--force-pending', '2', '--json']);
  assert.equal(past.status, 1, past.stdout);
  assert.match(past.stderr, /fixture-named has 3 edits pending review, more than the 2 this delete confirmed; deleting the session would purge the rest unseen, so it was not deleted/);
  assert.ok(fs.existsSync(path.join(store, 'log.jsonl')), 'nothing was purged');
  const bad = run(b, process.execPath, [cli, 'sessions', '--delete', id, '--force-pending', 'all']);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stderr, /--force-pending: expected the number of pending edits the confirmation named, got "all"/);
  const named = run(b, process.execPath, [cli, 'sessions', '--delete', id, '--force-pending=3', '--json']);
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(JSON.parse(named.stdout), { deleted: id });
  assert.equal(fs.existsSync(store), false);
});

test('CLI views --serve: each answer leads with the worker\'s own resident size', t => {
  // The terminal app reads it off the head of the line to retire a worker grown too big; measuring it
  // with `ps` spawned a process every 5 s per worker wherever /proc is absent.
  const b = fixture(t);
  const request = path.join(b.home, 'request'), answer = path.join(b.home, 'answer');
  fs.writeFileSync(request, JSON.stringify({ views: ['sessions'], args: [] }) + '\n');
  const input = fs.openSync(request, 'r'), output = fs.openSync(answer, 'w');
  let r;
  try { r = cp.spawnSync(process.execPath, [cli, 'views', '--serve'], { cwd: b.home, env: b.env, timeout: 30000, stdio: [input, output, 'ignore'] }); }
  finally { fs.closeSync(input); fs.closeSync(output); }
  assert.equal(r.status, 0);
  const line = fs.readFileSync(answer, 'utf8').split('\n')[0];
  assert.match(line, /^\{"__rss":\d+,"sessions":\{/);
  const { __rss } = JSON.parse(line);
  assert.ok(__rss > 10 * 1024 ** 2 && __rss < 8 * 1024 ** 3, `a resident size in bytes (${__rss})`);
});

test('CLI search: a hit is dated the way every other list dates it, not in the locale format', t => {
  const b = fixture(t), cwd = path.join(b.home, 'work'), id = 'fixture-search';
  const dir = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(cwd); fs.mkdirSync(dir, { recursive: true });
  const timestamp = '2025-03-04T12:00:00.000Z'; // another year: a date, whatever the machine's zone
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    { type: 'user', cwd, sessionId: id, timestamp, message: { role: 'user', content: 'Find the armadillo' } },
    { type: 'assistant', cwd, sessionId: id, timestamp, message: { id: 'fixture-answer', role: 'assistant', content: [{ type: 'text', text: 'Found it.' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = run(b, process.execPath, [cli, 'search', 'armadillo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture- · 2025-03-04/);
  assert.doesNotMatch(r.stdout, /\d\/\d+\/\d{4}|\b[AP]M\b/);
  // The terminal app's search palette dates its rows and its pick the same way.
  const tui = fs.readFileSync(path.join(root, 'packages/tui/src/app.ts'), 'utf8');
  assert.equal((tui.match(/core\.relTime\(h\.ts\)/g) || []).length, 2);
  assert.doesNotMatch(tui, /new Date\(h\.ts\)\.toLocaleString\(\)/);
});

test('CLI usage: GPT windows follow a Codex session only when it is named, and the statusline read skips them', t => {
  const b = fixture(t), now = Date.now(), elsewhere = path.join(b.home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const rollout = (id, cwd, fivePct, ageMs) => {
    const dir = path.join(b.env.CODEX_HOME, 'sessions', '2026', '01', '01');
    const file = path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`), ts = new Date(now - ageMs).toISOString();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, [
      { timestamp: ts, type: 'session_meta', payload: { id, cwd, model_provider: 'openai' } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: 'A fixture task' } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
        rate_limits: { primary: { used_percent: fivePct, window_minutes: 300, resets_at: Math.round((now + 3600000) / 1000) } } } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(file, (now - ageMs) / 1000, (now - ageMs) / 1000);
  };
  const here = '00000000-0000-4000-8000-00000000000a';
  rollout(here, b.home, 11, 60000); // this workspace's newest session, so the one `oak usage` resolves
  rollout('00000000-0000-4000-8000-00000000000b', elsewhere, 77, 1000); // the freshest snapshot
  const usage = (args, env = {}) => {
    const r = run(b, process.execPath, [cli, 'usage', ...args], { env: { ...b.env, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // The JetBrains status bar asks with no --session; VS Code's status bar and the terminal read unscoped.
  assert.equal(usage([]).gptFivePct, 77, 'no --session: the freshest snapshot, the same figure every status bar shows');
  assert.equal(usage(['--session', here]).gptFivePct, 11, 'a named Codex session: its own windows (both Stats panels)');
  const statusline = usage(['--session', 'fixture-claude'], { OAK_STATUSLINE: '1' });
  assert.equal(statusline.gptFivePct, null, 'the statusline reads only sessionTokens, so it skips the GPT panel');
  assert.equal(typeof statusline.sessionTokens, 'object');
});

for (const [label, pattern] of [
  ['session deletion', /^  sessions .*--delete <id>.*--undelete <id>/m],
  ['workspace listing help', /sessions \[--delete[^\n]*\n\s+this machine's sessions, grouped by workspace/],
  ['store housekeeping', /^  store .*--move <dir>.*--default/m],
  ['Review inbox keys', /Review tab: i opens the inbox, h jumps to the next session;\n\s+on Observatory, i replies and h focuses herdr/],
  ['pinned machine version', /add installs the version pinned in herdr\.lock[\s\S]*?newer local herdr is left alone/],
  ['attach with an optional machine', /^  attach \[machine\] +attach this terminal to herdr here, or on a saved machine/m],
  ['notify from a plain terminal', /--watch[^\n]*\n[^\n]*from a plain terminal with no editor open/],
]) {
  test(`CLI help: documents ${label}`, t => {
    const result = run(fixture(t), process.execPath, [cli, '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(pattern.test(result.stdout), `help documents ${label}`);
  });
}

test('CLI: a verb an earlier release shipped names its replacement; others stay unknown', t => {
  const b = fixture(t);
  for (const [verb, pointer] of [['remotes', /oak machine add <label> <ssh-target>/], ['drive', /oak agent start. and .oak prompt/], ['acp-fidelity', /oak integrity/]]) {
    const r = run(b, process.execPath, [cli, verb]);
    assert.equal(r.status, 1, verb);
    assert.ok(r.stderr.includes('`' + verb + '` was removed in 0.10.0; use'), r.stderr);
    assert.match(r.stderr, pointer, verb);
  }
  const unknown = run(b, process.execPath, [cli, 'frobnicate']);
  assert.match(unknown.stderr, /unknown command "frobnicate"/);
});

test('CLI attach: resolves the target, ensures an oak pane, then hands over to the remote herdr', { skip: process.platform === 'win32' && 'POSIX fake herdr' }, t => {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  b.env.PATH = bin + path.delimiter + b.env.PATH; // our fake herdr must win over any real one on PATH
  const log = path.join(b.home, 'herdr-argv.log');
  const identity = path.join(b.home, 'herdr-identity.log');
  const herdr = path.join(bin, 'herdr');
  // A fake herdr: record every argv line, and answer the three reads attach makes before it attaches.
  // The handoff also records which Claude Code session-identity keys reached it.
  fs.writeFileSync(herdr, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "' + log + '"',
    'if [ "$1" = "--remote" ]; then env | grep -E \'^(CLAUDECODE|CLAUDE_CODE_[A-Z_]*|AI_AGENT)=\' | cut -d= -f1 > "' + identity + '"; fi',
    'if [ "$1" = "machine" ] && [ "$2" = "list" ]; then',
    '  printf \'[{"label":"build-box","id":"n1","target":"build-box.example","session":"default","enabled":true}]\'',
    'elif [ "$1" = "--machine" ] && [ "$3" = "api" ]; then',
    '  printf \'{"result":{"snapshot":{"tabs":[],"focused_workspace_id":"w1"}}}\'',
    'elif [ "$1" = "--machine" ] && [ "$3" = "tab" ]; then',
    '  printf \'{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}\'',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  // Run from inside a Claude Code session: a herdr client handed this identity can start a server that
  // passes it to every pane, whose agents then run as child sessions. The person's own
  // CLAUDE_CODE_ setting is not identity, and stays.
  for (const key of Object.keys(b.env)) if (/^(CLAUDECODE|CLAUDE_CODE_|AI_AGENT)/.test(key)) delete b.env[key]; // this run's own
  Object.assign(b.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fixture-session', CLAUDE_CODE_CHILD_SESSION: '1', AI_AGENT: 'claude-code', CLAUDE_CODE_USE_BEDROCK: '1' });
  // Control: the fake's own record catches the keys when they do reach it.
  cp.spawnSync(herdr, ['--remote', 'control.invalid'], { env: b.env });
  assert.deepEqual(fs.readFileSync(identity, 'utf8').split('\n').filter(Boolean).sort(), ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_USE_BEDROCK']);
  fs.rmSync(identity);
  fs.rmSync(log);
  const result = run(b, process.execPath, [cli, 'attach', 'build-box']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /machine list --json/, 'resolves the machine from herdr');
  assert.match(argv, /--machine build-box api snapshot/, 'checks the remote for an existing oak pane');
  assert.match(argv, /--machine build-box tab create --label oak --workspace w1/, 'creates the oak pane when absent');
  assert.match(argv, /--machine build-box pane send-text p1 /, 'launches oak in the new pane');
  assert.match(argv, /--machine build-box tab focus t1/, 'focuses the oak tab so the attach lands on it');
  assert.match(argv, /--remote build-box\.example/, 'hands this terminal to the remote herdr');
  assert.equal(fs.readFileSync(identity, 'utf8'), 'CLAUDE_CODE_USE_BEDROCK\n', 'and hands it over without the session identity');
});

test('CLI attach: an unreachable herdr gets no "the oak tab is up" line', { skip: process.platform === 'win32' && 'POSIX fake herdr' }, t => {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  // No server answers: every herdr call fails without output, as with a dead or unreachable socket.
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\necho "server did not become ready" >&2\nexit 1\n', { mode: 0o755 });
  const result = run(b, process.execPath, [cli, 'attach']);
  assert.doesNotMatch(result.stdout, /the `oak` tab is up/);
  assert.match(result.stdout, /attaching to this machine — OAK could not be started there; run `oak` in a pane once attached/);
});

test('CLI agent start --machine: spawns the agent on the remote, then attaches to its OAK', { skip: process.platform === 'win32' && 'POSIX fake herdr' }, t => {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  b.env.PATH = bin + path.delimiter + b.env.PATH; // our fake herdr must win over any real one
  const log = path.join(b.home, 'herdr-argv.log');
  b.env.HERDR_FAKE_LOG = log;
  fs.copyFileSync(path.join(__dirname, 'fixtures/herdr-remote-stub.sh'), path.join(bin, 'herdr'));
  fs.chmodSync(path.join(bin, 'herdr'), 0o755);
  const result = run(b, process.execPath, [cli, 'agent', 'start', '--kind', 'claude', '--machine', 'build-box', '--cwd', '/repo']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /--machine build-box tab create --label claude --cwd \/repo/, 'opens a pane for the agent on the remote, in the given cwd');
  assert.match(argv, /--machine build-box agent start oak-claude-\S+ --kind claude --pane cp/, 'starts the agent in that pane');
  assert.match(argv, /--machine build-box tab create --label oak/, 'also ensures an oak review pane');
  assert.match(argv, /--machine build-box tab focus ot/, 'focuses the oak tab');
  assert.match(argv, /--remote build-box\.example/, 'then drops into the remote OAK');
});

test('CLI machine add: also installs the oak stack + capture hooks on the remote', { skip: process.platform === 'win32' && 'POSIX fake tools' }, t => {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  const log = path.join(b.home, 'machine-add.log');
  b.env.MACHINE_ADD_LOG = log;
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-add-tool-stub.sh'));
  for (const name of ['ssh', 'scp', 'herdr']) { fs.writeFileSync(path.join(bin, name), stub); fs.chmodSync(path.join(bin, name), 0o755); }
  const result = run(b, process.execPath, [cli, 'machine', 'add', 'testlbl', 'testtgt']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const l = fs.readFileSync(log, 'utf8');
  assert.match(l, /ssh .* node --version/, 'checks Node on the remote before installing oak');
  assert.match(l, /scp .*index\.js testtgt:\.local\/lib\/oak\/index\.js/, 'pushes the CLI bundle');
  assert.match(l, /scp .*capture\.js testtgt:\.local\/lib\/oak\/capture\.js/, 'pushes the capture bundle');
  assert.match(l, /ssh .*\.local\/bin\/oak/, 'writes the oak launcher on the remote PATH');
  assert.match(l, /ssh .*oak init/, 'installs the capture hooks on the remote');
  assert.match(l, /oak init --no-codex [^\n]*oak init --codex/, 'the unseen remote init installs codex hooks but never wires a codex model');
  assert.match(l, /herdr machine add testtgt --label testlbl/, 'still saves the machine in herdr');
});

test('CLI machine add: works from a machine that machine add provisioned (package.json beside index.js)', { skip: process.platform === 'win32' && 'POSIX fake tools' }, t => {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  b.env.MACHINE_ADD_LOG = path.join(b.home, 'machine-add.log');
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-add-tool-stub.sh'));
  for (const name of ['ssh', 'scp', 'herdr']) { fs.writeFileSync(path.join(bin, name), stub); fs.chmodSync(path.join(bin, name), 0o755); }
  // The layout machine add leaves on a remote: one flat directory, the manifest beside the bundle.
  const flat = path.join(b.home, 'remote-lib', 'oak');
  fs.mkdirSync(flat, { recursive: true });
  for (const f of ['cli.js', 'capture.js', 'THIRD_PARTY_NOTICES.md', 'index.js']) fs.copyFileSync(path.join(root, 'packages/cli/dist', f), path.join(flat, f));
  fs.cpSync(path.join(root, 'packages/cli/dist/herdr-plugin'), path.join(flat, 'herdr-plugin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'packages/cli/package.json'), path.join(flat, 'package.json'));
  const result = run(b, process.execPath, [path.join(flat, 'index.js'), 'machine', 'add', 'testlbl', 'testtgt']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(fs.readFileSync(b.env.MACHINE_ADD_LOG, 'utf8'), /scp .*remote-lib\/oak\/package\.json testtgt:\.local\/lib\/oak\/package\.json/);
});

// `oak init` asks ollama at its fixed address, 127.0.0.1:11434. The fake runs in its own process, because
// `run` blocks this one, on a free port that it reports through a file. The CLI under test runs with a
// preload that sends exactly that address to the fake, so an ollama or a second suite holding 11434
// changes nothing.
async function fakeOllama(t, b) {
  const ready = path.join(b.home, 'ollama-port');
  const child = cp.spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const srv = require('http').createServer((req, res) => res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest', size: 1, modified_at: '2026-09-01T00:00:00Z' }] })));
    srv.listen(0, '127.0.0.1', () => { fs.writeFileSync(${JSON.stringify(ready + '.tmp')}, String(srv.address().port)); fs.renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)}); });`], { stdio: 'ignore' });
  t.after(() => child.kill());
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 25));
  const redirect = path.join(b.home, 'ollama-redirect.cjs');
  fs.writeFileSync(redirect, `const http = require('http');
const get = http.get;
http.get = (url, ...rest) => get(String(url).replace('http://127.0.0.1:11434/', 'http://127.0.0.1:${fs.readFileSync(ready, 'utf8')}/'), ...rest);
`);
  return ['--require', redirect];
}

function codexFixture(t) {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // init only asks `which codex`
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  fs.mkdirSync(b.env.CODEX_HOME, { recursive: true });
  return { b, cfg: path.join(b.env.CODEX_HOME, 'config.toml') };
}

test('CLI init: a codex model chosen by a profile is left alone; a wired one keeps the hook backup and uninstall removes it', { skip: process.platform === 'win32' && 'POSIX fake codex' }, async t => {
  const original = '# mine\napproval_policy = "on-request"\n';
  const chosen = codexFixture(t);
  const ollama = await fakeOllama(t, chosen.b);
  fs.writeFileSync(chosen.cfg, original);
  fs.writeFileSync(path.join(chosen.b.env.CODEX_HOME, 'work.config.toml'), 'model = "gpt-5-codex"\n');
  let r = run(chosen.b, process.execPath, [...ollama, cli, 'init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex model: set by the profile file work\.config\.toml/);
  assert.doesNotMatch(fs.readFileSync(chosen.cfg, 'utf8'), /^model/m, 'the profile keeps its model; nothing is wired over it');

  const empty = codexFixture(t);
  fs.writeFileSync(empty.cfg, original);
  r = run(empty.b, process.execPath, [...ollama, cli, 'init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wired to your newest local model, llama3\.2:latest/);
  assert.match(fs.readFileSync(empty.cfg, 'utf8'), /^model = "llama3\.2:latest" # added by oak init/m);
  assert.equal(fs.readFileSync(empty.cfg + '.bak', 'utf8'), original, 'the backup the hook installer announced is still the original');
  r = run(empty.b, process.execPath, [cli, 'uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed the codex model lines oak init added \(llama3\.2:latest\)/);
  assert.equal(fs.readFileSync(empty.cfg, 'utf8'), original, 'uninstall leaves config.toml as it was before init');
});

function doctor(b, { platform = process.platform, report, spawn, binary = '/fake/herdr', identity, loginScope, version, dirname = path.join(root, 'packages/cli/dist') } = {}) {
  let output = '';
  const native = [];
  let exitCode;
  let repairs = 0;
  const core = {
    // The identity row asks herdr for `status` first and scans only when a server runs; the fake
    // answers what the test injects (default: nothing running, the quiet row).
    herdrServerLoginScope: loginScope ?? (() => ({ state: 'absent' })),
    herdrServerIdentityLeak: identity ?? (() => ({ state: 'absent' })),
    stripSessionIdentity: (env) => env,
    diagnose: () => [],
    readHerdrLock: () => ({ version: '0.9.1', protocol: 22, assets: { 'linux-x86_64': 'https://example.test/herdr-pinned' } }),
    herdrVersion: version ?? (async () => ({ version: '0.9.1', protocol: 22, compatible: true, running: false, warnings: [] })),
    herdrPlatformKey: () => 'linux-x86_64',
    probeHerdr: () => ({ bin: binary, version: '0.9.1', current: true }),
    findHerdrBin: () => binary,
    ensureHerdr: async () => { repairs++; return report; },
    diagnoseFocusServer: async () => ({ id: 'focus', label: 'focus', level: 'ok', detail: 'fixture' }),
    diagnoseRemoteTitles: () => ({ id: 'remote-titles', label: 'remote titles', level: 'ok', detail: 'fixture' }),
    diagnoseCodexQuota: () => null,
    diagnoseHerdrForwarding: async () => [],
    getUpdateChannel: () => 'stable',
    spawnToolSync: spawn || ((file, args) => run(b, file, args)),
  };
  const module = { exports: {} };
  vm.runInNewContext(doctorCode, {
    module, exports: module.exports, __dirname: dirname,
    require: name => name === '@oak-observatory/core' ? core : name === '@oak-observatory/tui'
      ? { diagnoseNativeSpawn: async (fix, opts) => { native.push(opts); return { id: 'pty', label: 'pty', level: 'ok', detail: 'fixture' }; } } : require(name),
    process: { platform, env: b.env, cwd: () => b.home,
      stdout: { isTTY: false, write: text => { output += text; } },
      exit: code => { exitCode = code; } },
  });
  return { async updateHerdr() {
    await module.exports.ensureHerdrPin();
    return { output, repairs };
  }, async run(args = []) {
    await module.exports.cmdDoctor(args);
    return { output, exitCode, repairs, native };
  } };
}

// The copy `oak machine add` pushes keeps package.json beside the CLI and has no node_modules: doctor says
// so rather than sending it to reinstall through npm.
test('CLI doctor: tells the PTY row when it runs from the copy `oak machine add` pushed', async t => {
  const b = fixture(t);
  const bundle = path.join(b.home, 'lib', 'oak');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'package.json'), '{"name":"oak-observatory"}');
  assert.deepEqual((await doctor(b, { dirname: bundle }).run(['--json'])).native.map((o) => o.bundle), [true]);
  assert.deepEqual((await doctor(b).run(['--json'])).native.map((o) => o.bundle), [false], 'control: an npm install keeps package.json above dist/');
});

for (const integration of ['claude: current (v10)', 'codex: outdated (v9 < v10)', 'claude: needs repair (v10)']) {
  test(`CLI doctor: missing python3 fails for installed ${integration}`, { skip: process.platform === 'win32' && 'POSIX fake PATH' }, async t => {
    const b = fixture(t);
    const bin = path.join(b.home, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync('/bin/sh', path.join(bin, 'sh'));
    b.env.PATH = bin;
    const herdr = path.join(bin, 'herdr');
    fs.writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' '${integration}'\n`, { mode: 0o755 });
    const result = await doctor(b, { binary: herdr }).run(['--json']);
    const row = JSON.parse(result.output).checks.find(c => c.id === 'python3');
    assert.ok(row, 'plain doctor includes a python3 row');
    assert.equal(row.level, 'fail');
    assert.equal(row.fix, "herdr's agent hooks need python3");
    assert.equal(result.repairs, 0, 'plain doctor stays read-only');
  });
}

test('CLI doctor: python3 on a fake PATH passes; absent integrations do not require it', { skip: process.platform === 'win32' && 'POSIX fake PATH' }, async t => {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync('/bin/sh', path.join(bin, 'sh'));
  b.env.PATH = bin;
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, '#!/bin/sh\nprintf "claude: not installed\\ncodex: not installed\\n"\n', { mode: 0o755 });
  let result = await doctor(b, { binary: herdr }).run(['--json']);
  assert.equal(JSON.parse(result.output).checks.find(c => c.id === 'python3')?.level, 'ok');
  assert.ok(JSON.parse(result.output).checks.some(c => c.id === 'remote-titles'), 'the report carries the Remote Control titles row');
  fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(herdr, '#!/bin/sh\necho "codex: current (v10)"\n', { mode: 0o755 });
  result = await doctor(b, { binary: herdr }).run(['--json']);
  assert.equal(JSON.parse(result.output).checks.find(c => c.id === 'python3')?.level, 'ok');
});

test("CLI doctor: Windows needs no python3, because herdr's hooks there are PowerShell", async t => {
  const calls = [];
  const result = await doctor(fixture(t), { platform: 'win32', spawn: (file, args) => {
    calls.push([file, ...args]);
    if (file === 'where.exe') return { status: 1, stdout: '' }; // no python of any name
    return { status: 0, stdout: 'codex: current (v10)\n' };
  } }).run(['--json']);
  const row = JSON.parse(result.output).checks.find(c => c.id === 'python3');
  assert.equal(row?.level, 'ok', 'an installed codex integration does not make python3 a requirement on Windows');
  assert.match(row.detail, /not needed on Windows.*PowerShell/);
  assert.ok(!calls.some(c => c[0] === 'where.exe' && /^python/.test(c[1])), 'and nothing looks for it');
});

test('CLI doctor: a herdr that speaks another protocol fails the herdr row, with the fix that works', async t => {
  const herdrRow = async (v, args = ['--json']) => {
    const { output } = await doctor(fixture(t), { version: async () => ({ warnings: [], ...v }), report: { version: '0.10.0', pinned: '0.9.1', bin: '/fake/herdr',
      upgraded: false, integrations: {}, warnings: [], pluginLinked: true, serverStarted: false } }).run(args);
    return JSON.parse(output).checks.find((c) => c.id === 'herdr');
  };
  // A newer herdr: every Observatory snapshot fails its protocol gate, and --fix never replaces it.
  const newer = await herdrRow({ version: '0.10.0', protocol: 23, compatible: false, running: false });
  assert.equal(newer.level, 'fail');
  assert.match(newer.detail, /herdr 0\.10\.0 at \/fake\/herdr speaks protocol 23; this OAK speaks protocol 22 \(herdr 0\.9\.1\)/);
  assert.match(newer.fix, /oak update. for an OAK that speaks protocol 23, or install herdr 0\.9\.1/);
  assert.equal((await herdrRow({ version: '0.10.0', protocol: 23, compatible: false, running: false }, ['--fix', '--json'])).level, 'fail', 'and --fix says so too');
  // While a server runs, `version`/`protocol` are the server's, and each side carries its own verdict.
  const running = (server, binary, extra = {}) => herdrRow({ ...server, running: true, compatible: false,
    binary: { compatible: binary.protocol === 22 && binary.version === '0.9.1', ...binary },
    serverCompatible: server.protocol === 22 && server.version === '0.9.1', paired: true, ...extra });
  // A server still running an older binary than the one on disk: only a restart fixes it.
  const stale = await running({ version: '0.9.0', protocol: 21 }, { version: '0.9.1', protocol: 22 });
  assert.match(stale.detail, /^the running herdr server \(0\.9\.0\) speaks protocol 21; this OAK speaks protocol 22 \(herdr 0\.9\.1\)$/);
  assert.match(stale.fix, /herdr server stop/);
  const older = await running({ version: '0.9.0', protocol: 22 }, { version: '0.9.1', protocol: 22 });
  assert.match(older.detail, /^the running herdr server \(0\.9\.0\) is older than herdr 0\.9\.1; /, 'never "speaks protocol 22; this OAK speaks protocol 22"');
  // A newer herdr installed on disk while the old server keeps running: the SERVER still serves OAK,
  // and stopping it would close every pane and restart it on the incompatible binary (2026-09-26).
  const binaryOnly = await running({ version: '0.9.1', protocol: 22 }, { version: '0.10.0', protocol: 23 });
  assert.equal(binaryOnly.level, 'fail');
  assert.match(binaryOnly.detail, /^herdr 0\.10\.0 at \/fake\/herdr speaks protocol 23; this OAK speaks protocol 22 \(herdr 0\.9\.1\) — the running herdr server \(0\.9\.1\) still serves OAK, so leave it running until then$/);
  assert.match(binaryOnly.fix, /^`oak update` for an OAK that speaks protocol 23, or install herdr 0\.9\.1$/);
  assert.doesNotMatch(binaryOnly.fix + binaryOnly.detail, /server stop/, 'never tells anyone to stop a working server');
  // Both off: the binary first, then the restart that picks it up.
  const both = await running({ version: '0.9.0', protocol: 21 }, { version: '0.10.0', protocol: 23 });
  assert.match(both.detail, /^herdr 0\.10\.0 at \/fake\/herdr speaks protocol 23, and the running herdr server \(0\.9\.0\) speaks protocol 21; /);
  assert.match(both.fix, /^`oak update` for an OAK that speaks protocol 23, or install herdr 0\.9\.1; then `herdr server stop`/);
  // Both match the pin, but herdr itself says the server cannot serve this binary.
  const unpaired = await running({ version: '0.9.1', protocol: 22 }, { version: '0.9.2', protocol: 22, compatible: true }, { paired: false });
  assert.match(unpaired.detail, /^herdr reports that the running herdr server \(0\.9\.1\) cannot serve herdr 0\.9\.2 at \/fake\/herdr$/);
  assert.match(unpaired.fix, /herdr server stop/);
  assert.equal((await herdrRow({ version: '0.9.1', protocol: 22, compatible: true, running: true })).level, 'ok');
});

test('CLI doctor: repair reports the downloaded version, size, and URL', async t => {
  const report = { version: '0.9.1', pinned: '0.9.1', bin: '/fake/herdr', upgraded: true,
    integrations: {}, warnings: [], pluginLinked: true, serverStarted: false,
    downloaded: { url: 'https://example.test/herdr-asset', bytes: 26_000_000 } };
  const result = await doctor(fixture(t), { report, spawn: () => ({ status: 1, stdout: '' }) }).run(['--fix']);
  assert.match(result.output, /downloaded herdr 0\.9\.1 \(26\.0 MB\) from https:\/\/example\.test\/herdr-asset/);
  assert.equal(result.repairs, 1);
});

test('CLI doctor: the herdr server identity row, one per state — "could not look" is never a clean bill (2026-09-23)', { skip: process.platform === 'win32' && 'POSIX fake PATH' }, async t => {
  const row = async (opts) => {
    const b = fixture(t);
    const { output } = await doctor(b, { ...opts, spawn: () => ({ status: 0, stdout: 'server:\n  status: running\n', stderr: '' }) }).run(['--json']);
    return JSON.parse(output).checks.find((c) => c.id === 'herdr-env');
  };
  const leak = await row({ identity: () => ({ state: 'leak', pid: 4242, keys: ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'GIT_EDITOR'] }) });
  assert.equal(leak.level, 'fail'); assert.match(leak.detail, /pid 4242.*CLAUDE_CODE_CHILD_SESSION, CLAUDECODE, GIT_EDITOR/); assert.match(leak.fix, /herdr server stop/);
  const clean = await row({ identity: () => ({ state: 'clean', pid: 7 }) });
  assert.equal(clean.level, 'ok'); assert.match(clean.detail, /pid 7\b.*carries no/);
  const absent = await row({ identity: () => ({ state: 'absent' }) });
  assert.equal(absent.level, 'ok'); assert.match(absent.detail, /no herdr server running/);
  const unknown = await row({ identity: () => ({ state: 'unknown', why: "no way to read another process's environment on win32" }) });
  assert.equal(unknown.level, 'warn', '"could not look" is never a clean bill'); assert.match(unknown.detail, /^not inspected — .*win32/);
  const threw = await row({ identity: () => { throw new Error('EPERM'); } });
  assert.equal(threw.level, 'warn'); assert.match(threw.detail, /EPERM/);
  // herdr says no server runs: nothing is scanned at all, and the row is quiet.
  let scanned = 0;
  const b = fixture(t);
  const { output } = await doctor(b, { identity: () => { scanned++; return { state: 'leak', pid: 1, keys: ['CLAUDECODE'] }; }, spawn: () => ({ status: 0, stdout: 'server:\n  status: not running\n', stderr: '' }) }).run(['--json']);
  const quiet = JSON.parse(output).checks.find((c) => c.id === 'herdr-env');
  assert.equal(scanned, 0, 'no server, no scan'); assert.equal(quiet.level, 'ok');
});

/** A saved machine for the `--machine` tests: a fake herdr and ssh first on PATH, and a "remote" home
 *  whose ~/.local/bin/oak is this build, reachable only through the command ssh is handed. */
function machineFixture(t) {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'));
  for (const name of ['ssh', 'herdr']) { fs.writeFileSync(path.join(bin, name), stub); fs.chmodSync(path.join(bin, name), 0o755); }
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  const remote = path.join(b.home, 'remote-home');
  fs.mkdirSync(path.join(remote, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(remote, '.local', 'bin', 'oak'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
  b.env.FAKE_REMOTE_HOME = remote;
  b.env.MACHINE_EXEC_LOG = path.join(b.home, 'machine-exec.log');
  // What a run ON the remote sees: the same environment the stub's sshd hands the remote command.
  const remoteEnv = { HOME: remote, PATH: '/usr/bin:/bin', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
  const onRemote = (args) => run({ home: b.home, env: remoteEnv }, process.execPath, [cli, ...args], { cwd: remote });
  // Two chained same-line edits make ONE review unit, shown as #2 with members [1, 2]; the file on
  // the remote's disk holds the latest content, so undo and redo have something real to revert.
  const seed = (session) => {
    const file = path.join(remote, 'work', `${session}.txt`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'L1\nC\nL3\n');
    const r = cp.spawnSync(process.execPath, ['-e', `
      const core = require(${JSON.stringify(path.join(root, 'packages/core/dist'))});
      const [session, file] = process.argv.slice(1);
      const edit = (before, after) => { const id = core.nextId(session); core.appendLog(session, { id, ts: id * 1000, tool: 'Edit', file,
        beforeBlob: core.writeBlob(session, Buffer.from(before)), afterBlob: core.writeBlob(session, Buffer.from(after)), status: 'pending' }); };
      core.ensureStore(session);
      edit('L1\\nA\\nL3\\n', 'L1\\nB\\nL3\\n');
      edit('L1\\nB\\nL3\\n', 'L1\\nC\\nL3\\n');`, session, file], { env: remoteEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return file;
  };
  const log = () => (fs.existsSync(b.env.MACHINE_EXEC_LOG) ? fs.readFileSync(b.env.MACHINE_EXEC_LOG, 'utf8') : '');
  const sshCalls = () => log().split(/^ssh\n/m).slice(1).map((s) => s.slice(0, s.indexOf('\n.\n')).split('\n'));
  return { b, onRemote, seed, log, sshCalls };
}
const onMachine = (f, args) => run(f.b, process.execPath, [cli, ...args, '--machine', 'build-box']);

test('CLI --machine: a review verb runs on the saved machine over ssh and answers byte for byte', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  f.seed('remote-review');
  const forwarded = onMachine(f, ['list', '--json', '--session', 'remote-review']);
  assert.equal(forwarded.status, 0, forwarded.stderr);
  const there = f.onRemote(['list', '--json', '--session', 'remote-review']);
  assert.equal(there.status, 0, there.stderr);
  assert.equal(JSON.parse(there.stdout).edits.length, 1, 'the fixture unit is in the remote store');
  assert.equal(forwarded.stdout, there.stdout, 'the JSON is the remote run’s own, unchanged');
  assert.match(f.log(), /^herdr machine list --json$/m, 'the ssh target comes from herdr’s saved machines');
  const calls = f.sshCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 8), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', 'builder@build-box.example']);
  const command = calls[0].slice(8).join('\n');
  assert.match(command, /^env PATH="\$HOME\/\.local\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\$PATH"/);
  assert.match(command, / OAK_FORWARDED=1 OAK_FORWARDED_MACHINE='build-box' /, 'the remote learns the label a repair it prints must name');
  assert.ok(command.endsWith("oak 'list' '--json' '--session' 'remote-review'"));
});

test('CLI --machine: decisions and hostile text run on the remote intact; its exit status and message pass through', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const file = f.seed('remote-review');
  const text = `it's "quoted" $HOME; echo pwned \`id\` & more`;
  const added = onMachine(f, ['comment', 'add', '--session', 'remote-review', '--edit', '2', '--text', text, '--json']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).text, text, 'one argument, unexpanded by the remote shell');
  const undone = onMachine(f, ['undo', '--ids', '2', '--units', '--session', 'remote-review', '--json']);
  assert.equal(undone.status, 0, undone.stderr);
  assert.deepEqual(JSON.parse(undone.stdout).ids.sort(), [1, 2]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'L1\nA\nL3\n', 'the whole unit reverted on the remote’s disk');
  const missing = onMachine(f, ['diff', '99', '--patch', '--session', 'remote-review']);
  assert.equal(missing.status, 1, 'the remote verb’s own exit status');
  assert.match(missing.stderr, /no edit #99 in session remote-review/);
  assert.equal(missing.stdout, '');
});

test('CLI --machine: an unreachable machine, a missing oak and an unknown label are each named', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  f.b.env.SSH_FAKE_EXIT = '255';
  f.b.env.SSH_FAKE_STDERR = 'ssh: connect to host build-box.example port 22: Connection refused';
  const down = onMachine(f, ['views', '--views', 'list', '--json', '--session', 'remote-review']);
  assert.equal(down.status, 255);
  assert.equal(down.stdout, '', 'no payload that could pass for an empty review');
  assert.match(down.stderr, /build-box is not reachable over ssh \(builder@build-box\.example\): ssh: connect to host build-box\.example port 22: Connection refused/);
  f.b.env.SSH_FAKE_EXIT = '127';
  f.b.env.SSH_FAKE_STDERR = 'env: oak: No such file or directory';
  const bare = onMachine(f, ['sessions', '--json']);
  assert.equal(bare.status, 127);
  assert.match(bare.stderr, /OAK is not installed on build-box — run `oak machine add build-box builder@build-box\.example` from here/);
  delete f.b.env.SSH_FAKE_EXIT;
  const unknown = run(f.b, process.execPath, [cli, 'sessions', '--json', '--machine', 'elsewhere']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no saved machine "elsewhere"/);
  assert.equal(f.sshCalls().length, 2, 'an unknown machine never reaches ssh');
});

// The terminal app has a saved machine name its own sessions' herdr tabs, so the one record of what OAK
// named on that server is the machine's own, which its sessions' hooks keep too.
test('CLI --machine: __tab-sync names the session\'s herdr tab on the saved machine, in that machine\'s own record, and prints nothing', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, async t => {
  const { fakeHerdr } = require(path.join(root, 'packages/core/test/fake-herdr'));
  let server;
  const herdr = await fakeHerdr(t, { 'tab.rename': ({ tab_id, label }) => { server.tabs.find((x) => x.tab_id === tab_id).label = label; return { type: 'ok' }; } });
  if (!herdr) return;
  const f = machineFixture(t);
  const S = 'fixture-remote-tab-sync';
  server = { workspaces: [{ workspace_id: 'w1', label: 'home' }], tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1' }],
    panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'x1' }], agents: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: S } }] };
  herdr.snapshot = server;
  // The remote's own store: the session's titled transcript, and the pane link its capture hook made there.
  const remote = f.b.env.FAKE_REMOTE_HOME;
  const work = path.join(remote, 'work');
  const transcript = path.join(remote, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${S}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [{ type: 'user', cwd: work, sessionId: S, message: { role: 'user', content: 'Tidy the fixture parser please' } },
    { type: 'ai-title', aiTitle: 'Parser tidy-up', sessionId: S }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const linked = cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(root, 'packages/core/dist'))}).linkHerdrPane(${JSON.stringify(S)})`],
    { env: { HOME: remote, PATH: '/usr/bin:/bin', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: herdr.socketPath }, encoding: 'utf8' });
  assert.equal(linked.status, 0, linked.stderr);
  // Asynchronously: the scripted herdr answers from this process, which must keep running meanwhile.
  const tabSync = (...args) => new Promise((resolve) => cp.execFile(process.execPath, [cli, '__tab-sync', S, ...args, '--machine', 'build-box'],
    { cwd: f.b.home, env: f.b.env, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  const r = await tabSync();
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], 'exits 0 and prints nothing');
  const calls = f.sshCalls();
  assert.equal(calls.length, 1, 'it ran there');
  assert.ok(calls[0].at(-1).endsWith(`oak '__tab-sync' '${S}'`), calls[0].at(-1));
  assert.deepEqual(herdr.calls('tab.rename'), [{ tab_id: 'w1:t1', label: 'Parser tidy-up' }], 'the tab took the title the machine lists');
  const recordIn = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'claude-observatory', 'herdr-tabs.json'), 'utf8')); } catch { return null; } };
  assert.deepEqual(recordIn(path.join(remote, '.claude')), { local: { 'w1:t1': 'Parser tidy-up' } }, 'the claim is the machine\'s own');
  assert.equal(recordIn(f.b.env.CLAUDE_CONFIG_DIR), null, 'and nothing of it is kept here');
  // A name this machine did not give (the terminal app named the tab from its own store before the
  // machine named its own): the machine takes it for a person's…
  const given = `Named "here" $HOME's`;
  server.tabs[0].label = given;
  assert.deepEqual(Object.values(await tabSync()), [0, '', '']);
  assert.equal(server.tabs[0].label, given);
  // …unless the app vouches for it, intact through the remote shell: then the machine takes the claim on.
  assert.deepEqual(Object.values(await tabSync(`--claimed=${given}`)), [0, '', '']);
  assert.equal(server.tabs[0].label, 'Parser tidy-up');
  assert.deepEqual(recordIn(path.join(remote, '.claude')), { local: { 'w1:t1': 'Parser tidy-up' } });
  // A session whose hooks never ran in a herdr pane there has no pane link: nothing is asked of herdr, and
  // the answer says so, for the app to name that tab itself.
  const requests = herdr.requests.length;
  const unlinked = await new Promise((resolve) => cp.execFile(process.execPath, [cli, '__tab-sync', 'fixture-unlinked-session', '--machine', 'build-box'],
    { cwd: f.b.home, env: f.b.env, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.deepEqual([unlinked.code, unlinked.stdout, unlinked.stderr], [0, 'unlinked\n', '']);
  assert.equal(herdr.requests.length, requests, 'herdr is asked nothing');
});

// The terminal Review's Refresh applies a new .observatoryignore where a session's store is: on its own
// machine. `ignore` forwards like the review verbs and sweeps THAT store.
test('CLI --machine: ignore sweeps the saved machine\'s store, not this one\'s', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const file = f.seed('remote-ignore');
  fs.writeFileSync(path.join(path.dirname(file), '.observatoryignore'), '*.txt\n');
  const forwarded = onMachine(f, ['ignore', '--session', 'remote-ignore', '--json']);
  assert.equal(forwarded.status, 0, forwarded.stderr);
  assert.equal(f.sshCalls().length, 1, 'it ran there');
  assert.ok(JSON.parse(forwarded.stdout).droppedNow > 0, forwarded.stdout);
  assert.equal(JSON.parse(f.onRemote(['list', '--json', '--session', 'remote-ignore']).stdout).edits.length, 0, 'the remote store no longer holds them');
});

test('CLI ignore --stdin: the paths reach a saved machine, and a check never sweeps (2026-09-26)', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  // ssh ran with no stdin, so the remote read no paths and fell through to the sweep: a read-only
  // check purged the session's records on the remote.
  const f = machineFixture(t);
  const S = 'remote-ignore-stdin';
  const file = f.seed(S);
  fs.writeFileSync(path.join(path.dirname(file), '.observatoryignore'), '*.txt\n');
  const edits = () => JSON.parse(f.onRemote(['list', '--json', '--session', S]).stdout).edits.length;
  // On the machine itself, an empty --stdin answers "nothing ignored" (exit 1, as git check-ignore).
  const bare = f.onRemote(['ignore', '--stdin', '--json', '--session', S]);
  assert.deepEqual([bare.status, JSON.parse(bare.stdout).paths], [1, []], bare.stdout + bare.stderr);
  assert.equal(edits(), 1, 'a check with no paths drops nothing');
  const ask = (input) => cp.spawnSync(process.execPath, [cli, 'ignore', '--stdin', '--json', '--session', S, '--machine', 'build-box'],
    { cwd: f.b.home, env: f.b.env, input, encoding: 'utf8', timeout: 15000 });
  const r = ask(`${file}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).paths.map((p) => [p.path, p.mode]), [[file, 'ignored']], 'the path was checked on the remote');
  assert.equal(edits(), 1, 'and the remote store still holds the edit');
});

test('CLI sessions: a session with one edit says "1 edit" (2026-09-26)', t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const work = path.join(b.home, 'work');
  fs.mkdirSync(work);
  const id = 'fixture-one-edit';
  const project = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), [
    { type: 'user', cwd: work, sessionId: id, message: { role: 'user', content: 'One fixture edit' } },
    { type: 'assistant', cwd: work, message: { id: 'fixture-answer', role: 'assistant', model: 'claude-opus-4-1', content: [], usage: { input_tokens: 10, output_tokens: 20 } } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const seeded = cp.spawnSync(process.execPath, ['-e', `const core = require(${JSON.stringify(path.join(root, 'packages/core/dist'))});
    const S = ${JSON.stringify(id)}; core.ensureStore(S);
    core.appendLog(S, { ts: Date.now(), tool: 'Edit', file: ${JSON.stringify(path.join(work, 'f.txt'))}, beforeBlob: core.writeBlob(S, Buffer.from('a\\n')), afterBlob: core.writeBlob(S, Buffer.from('b\\n')), status: 'pending' });`],
  { env: b.env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const r = run(b, process.execPath, [cli, 'sessions'], { cwd: work });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, / 1 edit · 30 tok · /);
});

test('CLI status and init --repair: an older install is named incomplete with the command doctor names, and the repair says what it wrote (2026-09-26)', t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const legacy = { type: 'command', command: 'claude-observatory capture #claude-observatory-hook' };
  const pair = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const group = { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [legacy] };
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [group], PostToolUse: [group] } }));
  };
  // A project install, then cut back to the capture pair alone, as 0.9.5 wrote it.
  const project = path.join(b.home, 'project');
  fs.mkdirSync(project);
  const init = run(b, process.execPath, [cli, 'init', '--project', '--no-codex'], { cwd: project });
  assert.equal(init.status, 0, init.stderr);
  pair(path.join(project, '.claude', 'settings.json'));
  pair(path.join(b.env.CLAUDE_CONFIG_DIR, 'settings.json')); // and the user file, 0.9.5's own
  const status = run(b, process.execPath, [cli, 'status']);
  assert.match(status.stdout, /settings\.json incomplete: 2 of 8 hook entries — run `oak init`$/m, 'the user file names what doctor names');
  assert.match(status.stdout, /\(project\) incomplete: 2 of 8 hook entries — run `oak init --repair`$/m, 'a project file, the command that reaches it');
  const repair = run(b, process.execPath, [cli, 'init', '--repair']);
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stdout, /repaired — one entry for each of the 8 capture events, current command/);
  assert.doesNotMatch(repair.stdout, /hook pair/);
  assert.doesNotMatch(run(b, process.execPath, [cli, 'status']).stdout, /incomplete/);
});

test('CLI server status: the start time is a product clock stamp, with its day when that is not today (2026-09-26)', async () => {
  // It printed the locale's time of day alone ("8:32:05 PM"), even for a server started days ago.
  const real = require(path.join(root, 'packages/core/dist'));
  const started = Date.now() - 2 * 86_400_000;
  const core = { daemonStatus: async () => ({ running: true, pid: 4242, protocol: 1, started, build: 'fixture-build' }), buildStamp: () => 'fixture-build', relTime: real.relTime };
  let output = '';
  const module = { exports: {} };
  vm.runInNewContext(doctorCode, {
    module, exports: module.exports, __dirname: path.join(root, 'packages/cli/dist'),
    require: (name) => (name === '@oak-observatory/core' ? core : require(name)),
    process: { platform: process.platform, env: {}, cwd: () => root, stdout: { isTTY: false, write: (text) => { output += text; } }, exit: () => {} },
  });
  await module.exports.cmdServer(['status']);
  assert.match(real.relTime(started), /^(?:[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}|\d{4}-\d{2}-\d{2})$/, 'two days back, the stamp carries its day');
  assert.ok(output.includes(`up since ${real.relTime(started)} · the same build as this oak`), output);
});

test('CLI notify --watch: a raised hand is stamped with the product clock, not the locale (2026-09-26)', { skip: process.platform !== 'linux' && 'the fake notifier is notify-send' }, async t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  b.env.LC_ALL = 'en_US.UTF-8'; // Node's default: "8:32:05 PM"
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // never a real notification
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  const work = path.join(b.home, 'work');
  fs.mkdirSync(work);
  const id = 'fixture-watch';
  const projectDir = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), [
    { type: 'user', cwd: work, sessionId: id, timestamp: at, message: { role: 'user', content: 'Run the fixture migration.' } },
    { type: 'assistant', cwd: work, sessionId: id, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Asking first.' }] } },
    { type: 'ai-title', sessionId: id, aiTitle: 'Fixture migration' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const store = path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', id);
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'attention.json'), JSON.stringify({ kind: 'permission', message: 'Bash', ts: Date.now() }));
  const child = cp.spawn(process.execPath, [cli, 'notify', '--watch', '--root', work], { cwd: work, env: b.env });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 200 && !/Fixture migration/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  const line = out.split('\n').find((l) => l.includes('Fixture migration'));
  assert.ok(line, `the hand was announced: ${out}`);
  assert.match(line, /^\d{2}:\d{2}:\d{2}  Fixture migration  /, 'HH:MM:SS, as every clock stamp in the product');
});

test('CLI notify in iTerm2 on macOS: the terminal posts it (OSC 9), not osascript, whose notifications open Script Editor (2026-09-27)', { skip: process.platform === 'win32' && 'POSIX PTY' }, async t => {
  let pty;
  try { pty = require('node-pty'); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return t.skip('node-pty is unavailable'); throw error; }
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  b.env.TERM_PROGRAM = 'iTerm.app';
  for (const k of ['TMUX', 'STY', 'ZELLIJ', 'HERDR_ENV', 'OAK_TAB', 'ALACRITTY_WINDOW_ID']) delete b.env[k];
  // Elsewhere the preload sends the CLI down macOS's branch; on a Mac it changes nothing. The PTY is the
  // terminal, so the OSC lands in this test's buffer and no real notification is ever posted.
  const preload = path.join(b.home, 'as-darwin.cjs');
  fs.writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' });\n");
  const child = pty.spawn(process.execPath, ['--require', preload, cli, 'notify', '--title', 'OAK', '--message', 'Click me'], { cols: 100, rows: 10, name: 'xterm-256color', cwd: b.home, env: b.env });
  let out = '';
  child.onData((d) => (out += d));
  const code = await new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
  assert.equal(code, 0, out);
  assert.ok(out.includes('\x1b]9;OAK: Click me\x07'), `the terminal received the notification: ${JSON.stringify(out)}`);
  assert.match(out, /sent via this terminal \(OSC 9\)/);
});

test('CLI --machine: only the review verbs forward; any other verb answers on this machine', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const version = run(f.b, process.execPath, [cli, 'version', '--machine', 'build-box']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /oak /);
  assert.deepEqual(f.sshCalls(), [], 'never reached ssh');
  const bare = run(f.b, process.execPath, [cli, 'sessions', '--json', '--machine']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /`--machine` needs a saved machine label/);
});

/** A Claude transcript on the fake remote, for a session started in `<remote home>/work` — below the
 *  login directory a forwarded command lands in, so walking up from there never reaches it. */
function remoteTranscript(f, session, title, base = 1800000000000) {
  const remote = f.b.env.FAKE_REMOTE_HOME;
  const work = path.join(remote, 'work');
  const project = path.join(remote, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const at = (i) => new Date(base + i * 1000).toISOString();
  fs.writeFileSync(path.join(project, `${session}.jsonl`), [
    { type: 'user', cwd: work, sessionId: session, timestamp: at(1), message: { role: 'user', content: 'Please review the fixture parser.' } },
    { type: 'assistant', cwd: work, sessionId: session, timestamp: at(2), message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } },
    { type: 'ai-title', sessionId: session, aiTitle: title },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return work;
}

test('CLI --machine: a forwarded read runs in its session’s workspace, so the review carries the session’s own title', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const work = remoteTranscript(f, 'titled-remote', 'Fixture parser review');
  f.seed('titled-remote');
  // Control: the same read run in the login directory, as ssh starts it, finds no transcript — so a
  // pass below is the forwarding at work, not a fixture that any directory would satisfy.
  const bare = f.onRemote(['views', '--views', 'changemap', '--json', '--session', 'titled-remote']);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(JSON.parse(bare.stdout).changemap.summary.title, '');
  const forwarded = onMachine(f, ['views', '--views', 'changemap', '--json', '--session', 'titled-remote']);
  assert.equal(forwarded.status, 0, forwarded.stderr);
  const summary = JSON.parse(forwarded.stdout).changemap.summary;
  assert.equal(summary.title, 'Fixture parser review');
  assert.equal(summary.root, work, 'the map is built for the session’s own workspace on that machine');
  assert.equal(summary.pending, 1, 'the store read is unchanged');
});

test('CLI tui --tab review --session <id>: a session that runs on a saved machine is found there and reviewed there', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  remoteTranscript(f, 'review-remote', 'Remote parser review');
  f.seed('review-remote');
  const env = { ...f.b.env, NO_COLOR: '1' };
  const once = (session) => run({ ...f.b, env }, process.execPath, [cli, 'tui', '--once', '--no-mouse', '--tab', 'review', '--session', session, '--cols', '140', '--rows', '40']);
  const shown = once('review-remote');
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Remote parser review  review-r  on build-box/, 'the header names the session and the machine it is reviewed on');
  assert.match(shown.stdout, /review-remote\.txt/, 'the review is the remote store’s edit');
  const forwarded = f.sshCalls().map((argv) => argv.join(' '));
  assert.ok(forwarded.some((c) => c.includes("oak 'sessions' '--json' '--session' 'review-remote'")), 'the owner came from build-box’s own catalog');
  assert.ok(forwarded.some((c) => c.includes("oak 'views' '--views'") && c.includes("'--session' 'review-remote'")), 'the review was read on build-box');
  // A session no machine holds still fails as loudly as a typo always has, naming who was asked.
  const missing = once('fixture-missing-session');
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stderr, /no session "fixture-missing-session" on this machine or on build-box/);
  assert.equal(missing.stdout, '', 'no frame for a session that is nowhere');
});

test('CLI tui --tab review, nothing named, outside any repo: Review opens on the session that last took a turn, on any machine', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  // build-box's session last took a turn an hour ago.
  const work = remoteTranscript(f, 'review-remote', 'Remote parser review', Date.now() - 60 * 60_000);
  f.seed('review-remote');
  const remote = path.join(f.b.env.FAKE_REMOTE_HOME, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), 'review-remote.jsonl');
  // This machine's own session, the launch default before any saved machine answers.
  const here = path.join(f.b.home, 'here');
  const project = path.join(f.b.env.CLAUDE_CONFIG_DIR, 'projects', here.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(here, { recursive: true });
  const local = path.join(project, 'local-session.jsonl');
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const writeLocal = (turnMinutesAgo, resumedNow) => fs.writeFileSync(local, [
    { type: 'user', cwd: here, sessionId: 'local-session', timestamp: ago(turnMinutesAgo + 1), message: { role: 'user', content: 'Tidy the local notes.' } },
    { type: 'assistant', cwd: here, sessionId: 'local-session', timestamp: ago(turnMinutesAgo), message: { role: 'assistant', content: [{ type: 'text', text: 'Tidied.' }] } },
    { type: 'ai-title', sessionId: 'local-session', aiTitle: 'Local notes tidy' },
    // What `claude --resume` appends when herdr restores the session's pane at startup: no turn.
    ...(resumedNow ? [{ type: 'system', sessionId: 'local-session', timestamp: ago(0) }, { type: 'bridge-session', sessionId: 'local-session', timestamp: ago(0) }] : []),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const touch = (file, minutesAgo) => { const at = new Date(Date.now() - minutesAgo * 60_000); fs.utimesSync(file, at, at); };
  const env = { ...f.b.env, NO_COLOR: '1' };
  const once = (cwd) => run({ ...f.b, env }, process.execPath, [cli, 'tui', '--once', '--no-mouse', '--tab', 'review', '--cols', '140', '--rows', '40'], { cwd });
  // The user's case: this machine's session was resumed just now (its file is the newest anywhere) but last
  // took a turn two days ago; build-box's took one an hour ago.
  writeLocal(2 * 24 * 60, true);
  touch(remote, 60);
  const shown = once(f.b.home);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Remote parser review  review-r  on build-box/, 'the session that last took a turn, reviewed where it runs');
  assert.match(shown.stdout, /review-remote\.txt/, 'the review is the remote store’s edit');
  // A session opened just now and never prompted (what Claude Code writes when it starts) is listed, but it
  // never took a turn, so it never wins however fresh its file.
  const fresh = path.join(project, 'fresh-session.jsonl');
  fs.writeFileSync(fresh, [
    { type: 'mode', mode: 'default', sessionId: 'fresh-session' },
    { type: 'permission-mode', permissionMode: 'default', sessionId: 'fresh-session' },
    { type: 'system', subtype: 'informational', level: 'notice', content: 'agents-md: loaded', cwd: here, sessionId: 'fresh-session', timestamp: ago(0) },
    { type: 'cost-state', sessionId: 'fresh-session' },
    { type: 'last-prompt', sessionId: 'fresh-session' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const listed = run({ ...f.b, env }, process.execPath, [cli, 'sessions', '--json'], { cwd: f.b.home });
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout).sessions;
  assert.equal(rows.find((r) => r.id === 'fresh-session')?.lastTurnMs, null, 'control: listed, as never having taken a turn');
  assert.ok(rows.find((r) => r.id === 'local-session').lastTurnMs < Date.now() - 24 * 60 * 60_000, 'the resumed session keeps its old turn');
  const withFresh = once(f.b.home);
  assert.equal(withFresh.status, 0, withFresh.stderr);
  assert.match(withFresh.stdout, /Remote parser review  review-r  on build-box/, 'a session that never took a turn does not win');
  fs.rmSync(fresh);
  // Controls: this machine's session that took a turn a minute ago stays, and so does a repo's own newest.
  writeLocal(1, false);
  const newerHere = once(f.b.home);
  assert.equal(newerHere.status, 0, newerHere.stderr);
  assert.match(newerHere.stdout, /🔬 local-se /, 'this machine’s own session (no edits, so its header names its id)');
  assert.doesNotMatch(newerHere.stdout, /on build-box/);
  writeLocal(60, false);
  // Inside a repo with a session of its own (older than build-box's), the repo's session stays.
  const repo = path.join(f.b.home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const repoProject = path.join(f.b.env.CLAUDE_CONFIG_DIR, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(repoProject, { recursive: true });
  const repoTranscript = path.join(repoProject, 'repo-session.jsonl');
  fs.writeFileSync(repoTranscript, [
    { type: 'user', cwd: repo, sessionId: 'repo-session', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Fix the repo build.' } },
    { type: 'assistant', cwd: repo, sessionId: 'repo-session', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  touch(repoTranscript, 60);
  const inRepo = once(repo);
  assert.equal(inRepo.status, 0, inRepo.stderr);
  assert.match(inRepo.stdout, /repo-ses ▾/, 'the repo’s own session');
  assert.doesNotMatch(inRepo.stdout, /Remote parser review|on build-box/, 'inside a repo the default stays this machine’s');
  // A session named by --session or CLAUDE_OBSERVATORY_SESSION stays, however recent build-box's is.
  const pinned = (extraArgs, extraEnv) => run({ ...f.b, env: { ...env, ...extraEnv } }, process.execPath,
    [cli, 'tui', '--once', '--no-mouse', '--tab', 'review', ...extraArgs, '--cols', '140', '--rows', '40'], { cwd: here });
  for (const [args, envs, why] of [[['--session', 'local-session'], {}, '--session'], [[], { CLAUDE_OBSERVATORY_SESSION: 'local-session' }, 'CLAUDE_OBSERVATORY_SESSION']]) {
    const r = pinned(args, envs);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /local-se ▾/, why);
    assert.doesNotMatch(r.stdout, /on build-box/, why);
  }
  // …and a session or workspace named another way: the legacy session variable, or `--root`.
  const legacy = run({ ...f.b, env: { ...env, CLAUDE_CHANGES_SESSION: 'local-session' } }, process.execPath,
    [cli, 'tui', '--once', '--no-mouse', '--tab', 'review', '--cols', '140', '--rows', '40'], { cwd: here });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /local-se ▾/, 'the pinned session is shown');
  assert.doesNotMatch(legacy.stdout, /on build-box/, 'CLAUDE_CHANGES_SESSION names the session');
  const rooted = run({ ...f.b, env }, process.execPath, [cli, 'tui', '--once', '--no-mouse', '--tab', 'review', '--root', here, '--cols', '140', '--rows', '40'], { cwd: f.b.home });
  assert.equal(rooted.status, 0, rooted.stderr);
  assert.doesNotMatch(rooted.stdout, /on build-box/, '--root names the workspace');
});

test('CLI tui --tab review, nothing named, outside any repo, no Claude session: Review opens on this machine’s Codex session that last took a turn', t => {
  const b = fixture(t);
  const work = path.join(b.home, 'work');
  fs.mkdirSync(work);
  const dir = path.join(b.env.CODEX_HOME, 'sessions', '2026', '09', '28');
  fs.mkdirSync(dir, { recursive: true });
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const rollout = (id, prompt, turnMin, reattached) => {
    const file = path.join(dir, `rollout-2026-09-28T12-00-00-${id}.jsonl`);
    fs.writeFileSync(file, [
      { timestamp: ago(turnMin + 2), type: 'session_meta', payload: { id, cwd: work, originator: 'codex-tui', source: 'cli', model_provider: 'openai' } },
      { timestamp: ago(turnMin + 1), type: 'event_msg', payload: { type: 'user_message', message: prompt } },
      { timestamp: ago(turnMin + 1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
      { timestamp: ago(turnMin), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
      // What a reattach appends: no turn, and a fresh file clock.
      ...(reattached ? [{ timestamp: ago(0), type: 'event_msg', payload: { type: 'thread_settings_applied' } }] : []),
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (!reattached) fs.utimesSync(file, new Date(Date.now() - turnMin * 60_000), new Date(Date.now() - turnMin * 60_000));
  };
  rollout('00000000-0000-4000-8000-0000000000a1', 'Tidy the Codex notes.', 10, false);
  rollout('00000000-0000-4000-8000-0000000000b1', 'Rename the old flags.', 2 * 24 * 60, true);
  const shown = run({ ...b, env: { ...b.env, NO_COLOR: '1' } }, process.execPath, [cli, 'tui', '--once', '--no-mouse', '--tab', 'review', '--cols', '140', '--rows', '40']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Tidy the Codex notes\./, 'the Codex session that last took a turn');
  assert.doesNotMatch(shown.stdout, /no agent session yet|Rename the old flags/);
});

test('CLI tui --tab review --session <id>: a saved machine that could not be asked is named with its reason, in one sentence', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const saved = (id, label) => ({ id, label, target: `builder@${label}.example`, session: 'default', enabled: true, selected: false });
  const env = { ...f.b.env, NO_COLOR: '1', MACHINE_EXEC_MACHINES: JSON.stringify([saved('m1', 'build-box'), saved('m2', 'down-box')]),
    SSH_FAKE_DOWN: 'builder@down-box.example', SSH_FAKE_STDERR: 'ssh: connect to host down-box.example port 22: Connection refused' };
  const missing = run({ ...f.b, env }, process.execPath, [cli, 'tui', '--once', '--no-mouse', '--tab', 'review', '--session', 'fixture-missing-session', '--cols', '140', '--rows', '40']);
  assert.equal(missing.status, 1, missing.stdout);
  // The remote CLI's reason keeps its words, not its `oak: ` prefix ("down could not be asked: oak: down is …").
  assert.match(missing.stderr, /^oak: no session "fixture-missing-session" on this machine or on build-box \(down-box could not be asked: down-box is not reachable over ssh \(builder@down-box\.example\): ssh: connect to host down-box\.example port 22: Connection refused\)/);
  assert.equal(missing.stderr.match(/oak: /g).length, 1, missing.stderr);
});

test('CLI keep/undo/redo --ids --units: a display id widens to its whole review unit', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const json = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const perRecord = f.seed('per-record');
  assert.deepEqual(json(f.onRemote(['undo', '--ids', '2', '--session', 'per-record', '--json'])).ids, [2], 'without --units, --ids acts per record');
  assert.equal(fs.readFileSync(perRecord, 'utf8'), 'L1\nB\nL3\n');
  const unit = f.seed('unit');
  assert.deepEqual(json(f.onRemote(['undo', '--ids', '2', '--units', '--session', 'unit', '--json'])).ids.sort(), [1, 2]);
  assert.equal(fs.readFileSync(unit, 'utf8'), 'L1\nA\nL3\n');
  assert.deepEqual(json(f.onRemote(['redo', '--ids', '2', '--units', '--session', 'unit', '--json'])).ids.sort(), [1, 2]);
  assert.equal(fs.readFileSync(unit, 'utf8'), 'L1\nC\nL3\n');
  assert.deepEqual(json(f.onRemote(['keep', '--ids', '2', '--units', '--session', 'unit', '--json'])).ids.sort(), [1, 2]);
});

test('CLI comment mark-sent: records a reply delivered another way, and only for the ids named', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  f.seed('comments');
  const json = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const one = json(f.onRemote(['comment', 'add', '--session', 'comments', '--edit', '2', '--text', 'first', '--json']));
  const two = json(f.onRemote(['comment', 'add', '--session', 'comments', '--edit', '2', '--text', 'second', '--json']));
  assert.deepEqual(json(f.onRemote(['comment', 'mark-sent', '--session', 'comments', '--ids', one.id, '--json'])), { marked: 1 });
  assert.deepEqual(json(f.onRemote(['comment', 'list', '--session', 'comments', '--unsent', '--json'])).comments.map((c) => c.id), [two.id]);
  assert.deepEqual(json(f.onRemote(['comment', 'mark-sent', '--session', 'comments', '--ids', one.id, '--json'])), { marked: 0 }, 'already sent');
  assert.equal(f.onRemote(['comment', 'mark-sent', '--session', 'comments', '--json']).status, 1, 'ids are required');
});

test('CLI doctor and installer/update: report gruvbox only when the theme was set', async t => {
  for (const themeConfigured of [true, false]) {
    const report = { version: '0.9.1', pinned: '0.9.1', bin: '/fake/herdr', upgraded: false,
      integrations: {}, warnings: [], pluginLinked: true, serverStarted: false,
      sidebarConfigured: false, themeConfigured };
    const opts = { report, spawn: () => ({ status: 1, stdout: '' }) };
    const fixed = await doctor(fixture(t), opts).run(['--fix']);
    const updated = await doctor(fixture(t), opts).updateHerdr();
    for (const result of [fixed, updated]) {
      assert.equal(result.output.includes('herdr theme: gruvbox (set)'), themeConfigured, result.output);
      assert.equal(result.repairs, 1);
    }
    const inspected = await doctor(fixture(t), opts).run([]);
    assert.equal(inspected.output.includes('herdr theme: gruvbox (set)'), false);
    assert.equal(inspected.repairs, 0, 'plain doctor remains read-only');
  }
});

test('CLI feed text prints complete replies, thoughts and prompts at terminal width', t => {
  const b = fixture(t), session = 'fixture-feed';
  const project = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', b.home.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  const row = (i, role, content) => ({ cwd: b.home, timestamp: new Date(1800000000000 + i).toISOString(), message: { role, content } });
  const words = 'Complete reply with unicode 猫 and all the words. '.repeat(6).trim();
  fs.writeFileSync(path.join(project, session + '.jsonl'), [
    row(1, 'user', 'Please inspect the fixture.'),
    row(2, 'assistant', [{ type: 'thinking', thinking: 'Inspect the complete fixture first.' }]),
    row(3, 'assistant', [{ type: 'text', text: words }]),
  ].map(JSON.stringify).join('\n') + '\n');
  const result = run(b, process.execPath, [cli, 'feed', '--root', b.home, '--session', session]);
  assert.equal(result.status, 0, result.stderr);
  const normalized = result.stdout.replace(/\s+/g, ' ');
  assert.ok(normalized.includes('said — ' + words));
  assert.ok(normalized.includes('thinking — Inspect the complete fixture first.'));
  assert.ok(normalized.includes('Please inspect the fixture.'));
  assert.ok(result.stdout.split('\n').every(line => [...line].reduce((n, c) => n + (c === '猫' ? 2 : 1), 0) <= 100));
});

test('CLI feed keeps thinking dim through the timestamp and label resets', () => {
  let output = '';
  const module = { exports: {} };
  const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { cmdFeed };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, __dirname: path.dirname(cli),
    process: { env: {}, cwd: () => '/workspace', stdout: { isTTY: true, columns: 100, write: text => { output += text; } } },
    require: name => name === '@oak-observatory/core' ? { isSafeSessionId: () => true, relTime: () => 'now', liveFeed: () => ({
      title: 'Fixture', mode: 'audit', lastTs: 1, entries: [{ ts: 1, kind: 'reasoning', label: 'thinking', reasoningKind: 'thinking', reasoning: 'Complete thought words' }],
    }) } : name === '@oak-observatory/tui' ? require('../packages/tui/dist') : require(name),
  });
  module.exports.cmdFeed(['--session', 'fixture-feed']);
  const row = output.split('\n').find(line => line.includes('Complete thought words'));
  assert.ok(row, 'the thought is printed');
  const prefix = row.slice(0, row.indexOf('Complete thought words'));
  assert.equal([...prefix.matchAll(/\x1b\[([0-9;]+)m/g)].at(-1)?.[1], '2', 'the active style at the prose is dim');
});

test('CLI --machine: shell transport preserves arbitrary argument boundaries', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t);
  const oak = path.join(f.b.env.FAKE_REMOTE_HOME, '.local/bin/oak');
  fs.writeFileSync(oak, '#!/bin/sh\nexec "' + process.execPath + '" -e \'process.stdout.write(JSON.stringify(process.argv.slice(1)))\' -- "$@"\n');
  const values = ["it's quoted", 'first\nsecond', '猫 😀', '--literal', '', '$HOME; `id`'];
  const result = onMachine(f, ['list', ...values]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['list', ...values]);
});

test('CLI --machine: lookup accepts ids but refuses disabled, ambiguous and repeated targets', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t);
  const machine = { id: 'm1', label: 'build-box', target: 'builder@build-box.example', session: 'default', enabled: true, selected: false };
  const call = label => run(f.b, process.execPath, [cli, 'sessions', '--json', '--machine', label]);
  f.b.env.MACHINE_EXEC_MACHINES = JSON.stringify([machine]);
  assert.equal(call('m1').status, 0);
  f.b.env.MACHINE_EXEC_MACHINES = JSON.stringify([{ ...machine, enabled: false }]);
  assert.match(call('build-box').stderr, /disabled/);
  f.b.env.MACHINE_EXEC_MACHINES = JSON.stringify([machine, { ...machine, id: 'm2' }]);
  assert.match(call('build-box').stderr, /ambiguous/);
  f.b.env.MACHINE_EXEC_MACHINES = JSON.stringify([machine]);
  const duplicate = onMachine(f, ['sessions', '--json', '--machine', 'build-box']);
  assert.match(duplicate.stderr, /only once/);
  f.b.env.MACHINE_EXEC_MACHINES = JSON.stringify([{ ...machine, target: '-oProxyCommand=fixture' }]);
  assert.match(call('build-box').stderr, /invalid ssh target/);
});

test('CLI --machine: remote exit 255 is not reported as an SSH connection failure', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t);
  fs.writeFileSync(path.join(f.b.env.FAKE_REMOTE_HOME, '.local/bin/oak'), '#!/bin/sh\nprintf \'remote output\\n\'\nprintf \'remote refused\\n\' >&2\nexit 255\n');
  const result = onMachine(f, ['list']);
  assert.equal(result.status, 255);
  assert.equal(result.stdout, 'remote output\n');
  assert.equal(result.stderr, 'remote refused\n');
});

test('CLI --machine: old remote builds cannot silently ignore unit expansion', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t), file = f.seed('old-build');
  const oak = path.join(f.b.env.FAKE_REMOTE_HOME, '.local/bin/oak');
  fs.writeFileSync(oak, '#!/bin/sh\nif [ "$1" = "__review-protocol" ]; then exit 1; fi\nexec "' + process.execPath + '" "' + cli + '" "$@"\n');
  const result = onMachine(f, ['undo', '--ids', '2', '--units', '--session', 'old-build', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /update OAK on build-box/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'L1\nC\nL3\n');
});

test('CLI --machine: caller store roots and session identities never reach SSH', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t);
  f.b.env.CLAUDE_CODE_CHILD_SESSION = 'fixture-child';
  f.b.env.CLAUDE_CODE_CUSTOM = 'fixture-identity';
  f.b.env.CLAUDECODE = '1';
  f.b.env.MACHINE_EXEC_ENV = path.join(f.b.home, 'ssh-env-keys');
  const result = onMachine(f, ['sessions', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.b.env.MACHINE_EXEC_ENV, 'utf8'), '');
});

test('CLI comment accepts flag-looking text through an explicit equals value', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t); f.seed('flag-comment');
  const text = '--please retain\n猫 and all whitespace';
  const result = onMachine(f, ['comment', 'add', '--session', 'flag-comment', '--edit', '2', '--text=' + text, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).text, text);
});

test('CLI --machine equals form still routes to one remote store', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t);
  const r = run(f.b, process.execPath, [cli, 'sessions', '--json', '--machine=build-box']);
  assert.equal(r.status, 0, r.stderr); assert.equal(f.sshCalls().length, 1);
});

test('CLI --machine: a configurable overall deadline fails loudly and escalates a stuck SSH child', async () => {
  const { EventEmitter } = require('node:events'), timers = [], signals = [];
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = signal => signals.push(signal || 'SIGTERM');
  const module = { exports: {} }; let stderr = '';
  const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { forwardToMachine };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const core = { findHerdrBin: () => '/fake/herdr', herdrMachines: async () => [{ id: 'm', label: 'box', target: 'box.example', enabled: true }],
    spawnTool: () => child };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer,
    require: name => name === '@oak-observatory/core' ? core : require(name),
    process: { env: { OAK_MACHINE_TIMEOUT_MS: '250' }, stdout: { isTTY: false }, stderr: { write: text => { stderr += text; } },
      exit: code => { throw new Error('exit ' + code); } },
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {} });
  await module.exports.forwardToMachine('views', ['--machine', 'box']);
  assert.equal(timers[0].ms, 250);
  timers[0].fn(); timers[1].fn();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.throws(() => child.emit('close', null), /exit 124/);
  assert.match(stderr, /box did not finish.*OAK_MACHINE_TIMEOUT_MS.*refresh before retrying/);
});

test('CLI --machine: every forwarded verb retains its JSON contract', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t);
  for (const verb of ['views', 'review', 'list', 'sessions', 'diff', 'keep', 'undo', 'redo', 'resolve', 'comment', 'quote']) {
    const session = 'json-' + verb, file = f.seed(session), remote = f.b.env.FAKE_REMOTE_HOME;
    const cwd = path.dirname(file), project = path.join(remote, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, session + '.jsonl'), JSON.stringify({ type: 'assistant', sessionId: session, cwd,
      timestamp: '2026-09-20T12:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply.' }] } }) + '\n');
    if (verb === 'redo') assert.equal(f.onRemote(['undo', '2', '--session', session, '--json']).status, 0);
    const args = [verb, ...(verb === 'comment' ? ['list'] : ['diff', 'keep', 'undo', 'redo'].includes(verb) ? ['2'] : []),
      '--session', session, '--json', ...(verb === 'views' ? ['--views', 'list'] : [])];
    const result = onMachine(f, args);
    assert.equal(result.status, 0, verb + ': ' + result.stderr);
    assert.ok(JSON.parse(result.stdout), verb + ' answers structured JSON');
  }
});

test('Remote review help and documentation distinguish store reads, discovery and compatibility', t => {
  const b = fixture(t), help = run(b, process.execPath, [cli, '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--json --machine <label\|id>/);
  assert.doesNotMatch(help.stdout, /--machines|--gather-machines/);
  assert.match(help.stdout, /OAK_MACHINE_TIMEOUT_MS/);
  for (const file of ['docs/REMOTE.md', 'docs/cli.html']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(text.includes('OAK_MACHINE_TIMEOUT_MS'), file);
    assert.ok(!text.includes('--machines'), file);
    assert.match(text, /compatible remote|remote CLI's/);
  }
});

test('CLI doctor: a daemon in a login scope warns only where logind stops the scope, and is left untouched', async t => {
  const scope = killUserProcesses => ({ state: 'scope', pid: 42, scope: 'session-7.scope', killUserProcesses });
  for (const [facts, level, pattern, fix] of [
    // KillUserProcesses=no: logind abandons the scope when the login ends and never stops it.
    [scope(false), 'ok', /pid 42\) is in the login scope session-7\.scope; logind keeps it running after that login ends \(KillUserProcesses=no\)/],
    [scope(true), 'warn', /pid 42\) is inside a login scope; logind can stop it and every pane when that login ends/,
      /herdr server stop, then oak doctor --fix; loginctl enable-linger/],
    [scope(null), 'warn', /pid 42\) is in the login scope session-7\.scope, and logind's KillUserProcesses could not be read; if it is yes, logind stops the server and every pane/,
      /KillUserProcesses`; if it prints b true, .*herdr server stop, then oak doctor --fix/],
    // No logind off Linux: nothing to inspect is not a warning.
    [{ state: 'not-applicable' }, 'ok', /^not applicable: login scopes are logind's/],
    [{ state: 'clean', pid: 42 }, 'ok', /outside every login scope/],
    [{ state: 'absent' }, 'ok', /no herdr server running/],
    [{ state: 'unknown', why: 'fixture failure' }, 'warn', /not inspected — fixture failure/],
  ]) {
    const result = await doctor(fixture(t), {
      loginScope: () => facts,
      spawn: () => ({ status: 0, stdout: 'server: running' }),
    }).run(['--json']);
    const row = JSON.parse(result.output).checks.find(c => c.id === 'herdr-login-scope');
    assert.equal(row?.level, level, JSON.stringify(facts));
    assert.match(row.detail, pattern);
    if (fix) assert.match(row.fix, fix); else assert.equal(row.fix, undefined, 'an ok or uninspected row offers no fix');
    assert.equal(result.repairs, 0);
  }
});

test('CLI workflow feed prints action targets and separated, dimmed agent tags', t => {
  const b = fixture(t);
  fs.mkdirSync(path.join(b.home, '.git'));
  const demo = run(b, process.execPath, [cli, 'demo', '--fast', '--json']);
  assert.equal(demo.status, 0, demo.stderr);
  const { session } = JSON.parse(demo.stdout);
  const args = ['feed', '--session', session, '--kind', 'workflow', '--id', 'wf_demo'];
  const data = JSON.parse(run(b, process.execPath, [cli, ...args, '--json']).stdout);
  const result = run(b, process.execPath, [cli, ...args]);
  assert.equal(result.status, 0, result.stderr);
  const action = data.entries.find(e => e.kind === 'action' && e.target);
  assert.ok(action, 'the demo contributes a real workflow action target');
  assert.ok(result.stdout.replace(/\s/g, '').includes((action.label + action.target).replace(/\s/g, '')));
  // Rows wrap at 100 columns, and the demo's paths run through the temp root, so where a row wraps depends on
  // that root's length (macOS's is longer). Where nothing wraps, the tag stands two spaces from its text.
  const wide = run(b, process.execPath, ['-e',
    "process.stdout.columns=1000;process.argv=[process.execPath," + JSON.stringify(cli) + ",...process.argv.slice(1)];require(" + JSON.stringify(cli) + ")", ...args]);
  assert.match(wide.stdout, /  \[outliner\]/);
  // The same CLI under a TTY emits the dim tag; no PTY or real pane is needed.
  const tty = run(b, process.execPath, ['-e',
    "process.stdout.isTTY=true;process.argv=[process.execPath," + JSON.stringify(cli) + ",...process.argv.slice(1)];require(" + JSON.stringify(cli) + ")", ...args]);
  assert.match(tty.stdout, /\x1b\[2m\[outliner\]\x1b\[0m/);
});

test('CLI demo Feed examples match the documented task, agent and process samples', t => {
  const b = fixture(t);
  fs.mkdirSync(path.join(b.home, '.git'));
  const demo = run(b, process.execPath, [cli, 'demo', '--fast', '--json']);
  assert.equal(demo.status, 0, demo.stderr);
  const { session } = JSON.parse(demo.stdout);
  const doc = fs.readFileSync(path.join(root, 'docs/DEMO.md'), 'utf8');
  const { wrapVisible } = require('../packages/tui/dist/textwidth');
  const boot = "process.stdout.columns=100000;process.argv=[process.execPath," + JSON.stringify(cli) + ",...process.argv.slice(1)];require(" + JSON.stringify(cli) + ")";
  for (const [kind, id, extra] of [['task', '57e216e743ae', []], ['agent', 'demosub1', ['--limit', '4']], ['process', 'demo-serve', []]]) {
    const args = ['feed', '--kind', kind, '--id', id, ...extra];
    const out = run(b, process.execPath, ['-e', boot, ...args, '--session', session]);
    assert.equal(out.status, 0, out.stderr);
    // The Feed prints a path outside the workspace as recorded, so on Windows with `\`; DEMO.md is POSIX.
    const actual = out.stdout.split(b.home + path.sep).join('').split(path.sep).join('/').trimEnd().split('\n').flatMap(line => wrapVisible(line, 100)).join('\n');
    const command = '$ oak ' + args.join(' ');
    const start = doc.indexOf(command) + command.length + 1, end = doc.indexOf('\n```', start);
    const clock = text => text.replace(/\b\d{2}:\d{2}:\d{2}\b/g, 'HH:MM:SS');
    // DEMO.md quotes its own recipe's run, in a repository at /tmp/obs-demo/ws: each side drops its sandbox.
    const quoted = doc.slice(start, end).split('/tmp/obs-demo/ws/').join('');
    assert.equal(clock(actual), clock(quoted), kind + ' sample (only sandbox path, separator and clock normalized)');
  }
});

test('remote conversation: real fake-SSH reads the owning file byte-for-byte, tails and resets it', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t), session = 'fixture-conversation';
  const rootThere = f.b.env.FAKE_REMOTE_HOME, project = path.join(rootThere, '.claude/projects', rootThere.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, session + '.jsonl');
  const prompt = text => JSON.stringify({ type: 'user', cwd: rootThere, sessionId: session, timestamp: '2026-09-18T12:00:00Z', message: { role: 'user', content: text } }) + '\n';
  fs.writeFileSync(file, Array.from({ length: 60 }, (_, i) => prompt('Remote turn ' + i)).join(''));
  const args = ['conversation', '--json', '--session', session, '--with-source'];
  const initial = onMachine(f, args), there = f.onRemote(args);
  assert.equal(initial.status, 0, initial.stderr); assert.equal(initial.stdout, there.stdout);
  const first = JSON.parse(initial.stdout); assert.ok(first.truncated > 0); assert.equal(first.turns, 50);
  const here = run(f.b, process.execPath, [cli, ...args]); assert.equal(JSON.parse(here.stdout).transcriptPath, null, 'positive remote result has no local transcript');
  fs.appendFileSync(file, prompt('Remote appended turn'));
  const tail = onMachine(f, [...args, '--since', String(first.cursor), '--source', first.source]); assert.equal(tail.status, 0, tail.stderr);
  const next = JSON.parse(tail.stdout); assert.ok(next.cursor > first.cursor);
  assert.match(tail.stdout, /Remote appended turn/); assert.doesNotMatch(tail.stdout, /Remote turn 59/);
  const replacement = file + '.new'; fs.writeFileSync(replacement, prompt('Replacement '.repeat(2000))); fs.renameSync(replacement, file);
  const replaced = onMachine(f, [...args, '--since', String(next.cursor), '--source', next.source]); assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(JSON.parse(replaced.stdout).reset, true, 'inode change resets even when the replacement is larger');
  for (const verb of ['feed', 'multitask', 'subagents']) {
    const result = onMachine(f, [verb, '--json', '--session', session]);
    assert.equal(result.status, 0, result.stderr); assert.ok(JSON.parse(result.stdout));
    assert.ok(f.sshCalls().at(-1).at(-1).includes("oak '" + verb + "'"));
  }
});

test('remote conversation: an older remote printing help must demand an OAK update', { skip: process.platform === 'win32' }, t => {
  const f = machineFixture(t);
  const oak = path.join(f.b.env.FAKE_REMOTE_HOME, '.local/bin/oak');
  fs.copyFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'), oak); fs.chmodSync(oak, 0o755);
  const r = onMachine(f, ['conversation', '--json', '--session', 'fixture-session']);
  assert.equal(r.status, 78); assert.equal(r.stdout, ''); assert.match(r.stderr, /update OAK on build-box.*conversation protocol/);
});

test('remote conversation: provenance identifies a mirror without returning its stale events', t => {
  const b = fixture(t), session = 'fixture-mirror', recordedCwd = '/remote/work';
  const project = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', '-local-work'); fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, session + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: recordedCwd, message: { role: 'user', content: 'Stale mirror text' } }) + '\n');
  const r = run(b, process.execPath, [cli, 'conversation', '--json', '--source-info', '--session', session]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { mirrored: true, recordedCwd, syncedAt: fs.statSync(file).mtimeMs });
  assert.doesNotMatch(r.stdout, /Stale mirror text/);
  const local = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', '-remote-work'); fs.renameSync(project, local);
  const control = run(b, process.execPath, [cli, 'conversation', '--json', '--source-info', '--session', session]);
  assert.equal(JSON.parse(control.stdout).mirrored, false, 'matching project slug is the local positive control');
});
