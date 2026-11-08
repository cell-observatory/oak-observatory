const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitDir: makeGitDir } = require('./fixtures/git.cjs');
const cp = require('node:child_process');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const cli = process.env.RV3_TEST_CLI || path.join(root, 'packages/cli/dist/index.js');
const source = fs.readFileSync(path.join(root, 'packages/cli/src/index.ts'), 'utf8');
// Exercise the doctor command with its external diagnostics injected: no real PTY, socket,
// installation, or network is needed to check its output and dependency probes.
// The real lookup for the rows that must agree with what core does, with Homebrew's directories set by the test.
const realCore = require(path.join(root, 'packages/core/dist/index.js'));
const doctorCode = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { cmdDoctor, ensureHerdrPin, cmdServer, maybeCheckForUpdate };'), {
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

// Regular files work even where the sandbox denies Node's pipe socketpair. A command gets two minutes, which only a hang
// uses up: a stalled macOS runner held `oak usage --session=`, a tenth of a second of work, past the 15 s it had.
function run(b, file, args, options = {}) {
  const stdout = path.join(b.home, 'stdout');
  const stderr = path.join(b.home, 'stderr');
  const out = fs.openSync(stdout, 'w');
  const err = fs.openSync(stderr, 'w');
  let result;
  try { result = cp.spawnSync(file, args, { cwd: b.home, env: b.env, timeout: 120000, ...options, stdio: ['ignore', out, err] }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  assert.equal(result.error, undefined);
  return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') };
}

test('CLI launcher: unsupported Node is refused before loading OAK, while capture remains fail-open', t => {
  const b = fixture(t);
  const preload = path.join(b.home, 'node-version.cjs');
  b.env.XDG_CACHE_HOME = path.join(b.home, 'cache');
  for (const version of ['20.19.0', '22.15.1', '23.11.1', '22.16.0', '24.0.0']) {
    fs.writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: '${version}' }); Object.defineProperty(process, 'version', { value: 'v${version}' });`);
    const supported = version === '24.0.0';
    const r = run(b, process.execPath, ['--require', preload, cli, '--version']);
    assert.equal(r.status, supported ? 0 : 1, `${version}: ${r.stdout}${r.stderr}`);
    if (supported) assert.match(r.stdout, /^oak /);
    else {
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(`needs Node.js 24 or newer; found v${version}`), r.stderr);
      assert.equal(fs.existsSync(b.env.XDG_CACHE_HOME), false, 'refusal precedes even the compile cache');
      assert.equal(fs.existsSync(b.env.CLAUDE_CONFIG_DIR), false, 'no store or settings written');
      const capture = run(b, process.execPath, ['--require', preload, cli, 'capture']);
      assert.equal(capture.status, 0, 'an unsupported Node must not block the agent tool call');
      assert.equal(capture.stdout, '');
      assert.match(capture.stderr, /needs Node.js 24/);
      // And it still records (review 2026-11-05): an update that lands on the Node 0.10 ran on must not silently stop
      // recording edits. A home of its own, so the checks above stay about the refusal.
      const c = fixture(t), ws = path.join(c.home, 'ws'), file = path.join(ws, 'a.txt');
      fs.mkdirSync(ws); fs.writeFileSync(file, 'one\n');
      for (const [event, text] of [['PreToolUse', null], ['PostToolUse', 'two\n']]) {
        if (text) fs.writeFileSync(file, text);
        const payload = path.join(c.home, 'payload.json');
        fs.writeFileSync(payload, JSON.stringify({ session_id: 'synthetic-capture', cwd: ws, hook_event_name: event, tool_name: 'Write', tool_input: { file_path: file } }));
        const input = fs.openSync(payload, 'r');
        let r;
        try { r = cp.spawnSync(process.execPath, ['--require', preload, cli, 'capture'], { cwd: ws, env: { ...c.env, OAK_NO_SERVER: '1', OAK_NO_BACKGROUND: '1' }, timeout: 15000, stdio: [input, 'ignore', 'ignore'] }); }
        finally { fs.closeSync(input); }
        assert.equal(r.status, 0, `${version} ${event}`);
      }
      const logs = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : e.name === 'log.jsonl' && logs.push(path.join(d, e.name)); };
      if (fs.existsSync(c.env.CLAUDE_CONFIG_DIR)) walk(c.env.CLAUDE_CONFIG_DIR);
      assert.equal(logs.length, 1, `${version}: the edit is recorded`);
      assert.equal(JSON.parse(fs.readFileSync(logs[0], 'utf8').trim().split('\n')[0]).file, file);
    }
  }
});

/** `argv`, run so that it leaves no core dump: the CLI ends by SIGQUIT as that signal ends a process, which
 *  dumps core. A size limit of 0 does not stop the kernel piping the dump to systemd-coredump or apport; a
 *  limit of 1 byte does, where the hard limit is not already 0 (raising it is refused). On macOS, which has no
 *  prlimit, a limit of 0 does stop it. */
let coreLimitOfOneByte;
const oneByteCoreLimit = () => (coreLimitOfOneByte ??= fs.existsSync('/usr/bin/prlimit') && cp.spawnSync('/usr/bin/prlimit', ['--core=1:1', '--', 'true']).status === 0);
const withoutCore = (argv) => oneByteCoreLimit() ? ['/usr/bin/prlimit', '--core=1:1', '--', ...argv] : ['/bin/sh', '-c', 'ulimit -c 0 && exec "$@"', 'sh', ...argv];
/** Why a test does not end a real process by SIGQUIT here, or false: on Linux nothing but prlimit's 1-byte
 *  limit keeps its core dump out of systemd-coredump or apport. */
const noQuitHere = () => process.platform === 'linux' && !oneByteCoreLimit() && 'no prlimit that sets a 1-byte core limit, and with `ulimit -c 0` systemd-coredump or apport still records the dump SIGQUIT leaves';

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

test('CLI views and sessions: a pipe gets the title bytes exactly, and --session=<id> pins the listing as --session <id> does', t => {
  // The output filter applies to views only on a terminal: the editors and `views --serve` read it from a
  // pipe, where turning a C1 control (which JSON leaves raw) into a space would change the title they show.
  const b = fixture(t), id = 'fixture-pin', title = 'Fix a\u009b31mb';
  const dir = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', b.home.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = '2025-03-04T12:00:00.000Z';
  const file = path.join(dir, `${id}.jsonl`);
  // A prompt with no answer and long idle: listed only while it is the session under review.
  fs.writeFileSync(file, [
    { type: 'user', cwd: b.home, sessionId: id, timestamp, message: { role: 'user', content: 'Hello' } },
    { type: 'ai-title', aiTitle: title, sessionId: id },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const old = new Date(timestamp);
  fs.utimesSync(file, old, old);
  // A newer, answered session is the workspace's current one, so only the pin can list the first.
  fs.writeFileSync(path.join(dir, 'fixture-newer.jsonl'), [
    { type: 'user', cwd: b.home, sessionId: 'fixture-newer', message: { role: 'user', content: 'Next' } },
    { type: 'assistant', cwd: b.home, sessionId: 'fixture-newer', message: { id: 'fixture-reply', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const request = path.join(b.home, 'request'), answer = path.join(b.home, 'answer');
  fs.writeFileSync(request, JSON.stringify({ views: ['sessions'], args: ['--session', id] }) + '\n');
  const input = fs.openSync(request, 'r'), output = fs.openSync(answer, 'w');
  let r;
  try { r = cp.spawnSync(process.execPath, [cli, 'views', '--serve'], { cwd: b.home, env: b.env, timeout: 30000, stdio: [input, output, 'ignore'] }); }
  finally { fs.closeSync(input); fs.closeSync(output); }
  assert.equal(r.status, 0);
  assert.ok(fs.readFileSync(answer, 'utf8').includes(JSON.stringify(title).slice(1, -1)), 'the title reached the pipe byte for byte');
  const ids = args => {
    const listed = run(b, process.execPath, [cli, 'sessions', '--json', ...args], { cwd: b.home });
    assert.equal(listed.status, 0, listed.stderr);
    return JSON.parse(listed.stdout).sessions.map(row => row.id);
  };
  assert.ok(!ids([]).includes(id), 'control: unpinned, the unanswered session is not listed');
  assert.ok(ids(['--session', id]).includes(id), 'pinned as two words');
  assert.ok(ids([`--session=${id}`]).includes(id), 'pinned in the inline form');
  // An empty inline id is refused as the bare flag is, by the listing and the terminal app alike, rather
  // than falling back to this workspace's session (which exists here, so a fallback would succeed).
  for (const args of [['sessions', '--json'], ['tui', '--once', '--no-mouse', '--cols', '80', '--rows', '10']]) {
    for (const pin of [['--session'], ['--session=']]) {
      const r = run(b, process.execPath, [cli, ...args, ...pin], { cwd: b.home });
      assert.equal(r.status, 1, `${args[0]} ${pin[0]}: ${r.stdout}`);
      assert.match(r.stderr, /`--session` requires a session id/, `${args[0]} ${pin[0]}`);
    }
  }
});

test('CLI views: actions batches, and answers as `actions --json` does', t => {
  // VS Code reads a saved machine's session's Actions as `views --views actions --machine <label>`: `views` runs there.
  const b = fixture(t), id = 'fixture-acts';
  const dir = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', b.home.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    { type: 'user', cwd: b.home, sessionId: id, timestamp: '2025-03-04T12:00:00.000Z', message: { role: 'user', content: 'List the files' } },
    { type: 'assistant', cwd: b.home, sessionId: id, timestamp: '2025-03-04T12:00:01.000Z', message: { id: 'fixture-m1', role: 'assistant',
      content: [{ type: 'tool_use', id: 'fixture-tu1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', cwd: b.home, sessionId: id, timestamp: '2025-03-04T12:00:02.000Z', message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'fixture-tu1', content: 'a.txt' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const one = run(b, process.execPath, [cli, 'actions', '--json', '--session', id]);
  assert.equal(one.status, 0, one.stderr);
  const single = JSON.parse(one.stdout);
  assert.equal(single.actions.length, 1, 'control: the session made one tool call');
  const batch = run(b, process.execPath, [cli, 'views', '--views', 'actions', '--json', '--session', id]);
  assert.equal(batch.status, 0, batch.stderr);
  assert.deepEqual(JSON.parse(batch.stdout), { actions: single });
});

test('CLI stats, usage and clean: --session=<id> is read as --session <id> is, and an empty or unsafe id is refused', t => {
  // The three read `--session <id>` alone: `--session=<id>` was ignored, an unsafe id included, and
  // `clean --session=` cleaned the whole store.
  const b = fixture(t), work = path.join(b.home, 'work');
  fs.mkdirSync(work);
  const demo = run(b, process.execPath, [cli, 'demo', '--fast', '--json'], { cwd: work });
  assert.equal(demo.status, 0, demo.stderr);
  const { session } = JSON.parse(demo.stdout);
  const call = (...args) => run(b, process.execPath, [cli, ...args], { cwd: b.home }); // no session of its own here
  const edits = (...args) => { const r = call('stats', '--json', ...args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout).windows.session.edits; };
  const named = edits('--session', session);
  assert.ok(named > 0, `the demo session has edits (${named})`);
  assert.deepEqual([edits(), edits(`--session=${session}`)], [0, named], 'unnamed, this directory has none; named inline, the same as two words');
  // blob-memo.json goes only in a store-wide clean.
  const memo = path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'blob-memo.json');
  fs.writeFileSync(memo, 'y');
  for (const verb of [['stats', '--json'], ['usage'], ['clean', '--json']]) {
    for (const [arg, why] of [['--session=bad/id', /invalid session id "bad\/id"/], ['--session=', /`--session` requires a session id/], ['--session', /`--session` requires a session id/]]) {
      const r = call(...verb, arg);
      assert.equal(r.status, 1, `${verb[0]} ${arg}: ${r.stdout}`);
      assert.match(r.stderr, why, `${verb[0]} ${arg}`);
    }
  }
  assert.equal(call('clean', '--json', `--session=${session}`).status, 0);
  assert.ok(fs.existsSync(memo), 'no clean so far was store-wide');
  assert.equal(call('clean', '--json').status, 0);
  assert.ok(!fs.existsSync(memo), 'control: a store-wide clean removes it');
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
  assert.match(r.stdout, /^1 ask matching “armadillo” · 1 session, 1 ask, \d+ ms/m, 'one of each reads as one');
  assert.match(run(b, process.execPath, [cli, 'search', 'okapi']).stdout, /^nothing matches “okapi” across 1 session \(1 ask, \d+ ms\)$/m);
  assert.doesNotMatch(r.stdout, /\d\/\d+\/\d{4}|\b[AP]M\b/);
  // The terminal app's search palette dates its rows and its pick the same way.
  const tui = fs.readFileSync(path.join(root, 'packages/tui/src/app.ts'), 'utf8');
  assert.equal((tui.match(/core\.relTime\(h\.ts\)/g) || []).length, 2);
  assert.doesNotMatch(tui, /new Date\(h\.ts\)\.toLocaleString\(\)/);
});

test('CLI search --per-session: one row per session before the limit, and the cut is counted', t => {
  const b = fixture(t), cwd = path.join(b.home, 'work');
  const dir = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(cwd); fs.mkdirSync(dir, { recursive: true });
  const say = (id, asks) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), asks.flatMap((text, i) => [
    { type: 'user', cwd, sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: text } },
    { type: 'assistant', cwd, sessionId: id, timestamp: new Date().toISOString(), message: { id: `${id}-a${i}`, role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ]).map((r) => JSON.stringify(r)).join('\n') + '\n');
  say('fixture-chatty', ['kestrel one', 'kestrel kestrel two', 'kestrel three']);
  say('fixture-quiet', ['a kestrel']);
  const json = (...args) => { const r = run(b, process.execPath, [cli, 'search', 'kestrel', '--json', ...args], { cwd: b.home }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const asks = json('--limit', '2');
  assert.deepEqual([asks.hits.length, asks.matched], [2, 4]);
  const per = json('--per-session', '--limit', '2');
  assert.deepEqual(per.hits.map((h) => h.session).sort(), ['fixture-chatty', 'fixture-quiet']);
  assert.equal(per.hits.find((h) => h.session === 'fixture-chatty').prompt, 'kestrel kestrel two', "the row a session keeps is its best hit");
  assert.equal(per.matched, 2);
  const r = run(b, process.execPath, [cli, 'search', 'kestrel', '--per-session', '--limit', '1'], { cwd: b.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 of the 2 sessions matching “kestrel”/);
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
  assert.equal(usage([`--session=${here}`]).gptFivePct, 11, 'named as --session=<id> too');
  const statusline = usage(['--session', 'fixture-claude'], { OAK_STATUSLINE: '1' });
  assert.equal(statusline.gptFivePct, null, 'the statusline reads only sessionTokens, so it skips the GPT panel');
  assert.equal(typeof statusline.sessionTokens, 'object');
});

test('CLI usage: a 5-hour window whose reset has passed is 0 with no reset and no cache reads, for Claude and GPT (2026-10-20)', t => {
  // The keys both editors read. Claude's ended window kept its cache reads beside its 0, and GPT's ended window was
  // null, so its slot vanished. A plan with no 5-hour window (Codex reports the weekly alone) still has none.
  const b = fixture(t), sec = Math.floor(Date.now() / 1000), id = '00000000-0000-4000-8000-000000000051';
  b.env.OAK_INDEX = 'off'; // This fixture supplies cache measurements only; database totals are tested separately.
  fs.mkdirSync(b.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const claude = (five) => fs.writeFileSync(path.join(b.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), JSON.stringify({ v: 3,
    five_pct: 95, five_at: sec - 3 * 3600, five_reads: 30_000_000, week_pct: 22, week_at: sec - 600, week_reset: sec + 3 * 86400, ...five }));
  const gpt = (primary) => {
    const dir = path.join(b.env.CODEX_HOME, 'sessions', '2026', '10', '20');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-10-20T00-00-00-${id}.jsonl`), [
      { timestamp: new Date((sec - 7200) * 1000).toISOString(), type: 'session_meta', payload: { id, cwd: b.home, model_provider: 'openai' } },
      { timestamp: new Date((sec - 7200) * 1000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
        rate_limits: { ...(primary ? { primary } : {}), secondary: { used_percent: 22, window_minutes: 10080, resets_at: sec + 3 * 86400 } } } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  const usage = (args = []) => {
    const r = run(b, process.execPath, [cli, 'usage', ...args]);
    assert.equal(r.status, 0, r.stderr);
    const u = JSON.parse(r.stdout);
    return { claude: [u.claudeFivePct, u.claudeFiveReset, u.claudeAccount.fiveReads], gpt: [u.gptFivePct, u.gptFiveReset], session: [u.fiveHourPct, u.fiveReset] };
  };
  claude({ five_reset: sec - 600 });
  gpt({ used_percent: 40, window_minutes: 300, resets_at: sec - 600 });
  const ended = usage();
  assert.deepStrictEqual([ended.claude, ended.gpt], [[0, null, null], [0, null]], 'ended: 0, no reset, no reads');
  const named = usage(['--session', id]);
  assert.deepStrictEqual([named.gpt, named.session], [[0, null], [0, null]], 'and so for the Codex session the Stats panels name');
  // Control: running windows keep their shares, resets and reads.
  claude({ five_pct: 10, five_at: sec - 600, five_reset: sec + 3600 });
  gpt({ used_percent: 40, window_minutes: 300, resets_at: sec + 3600 });
  const running = usage();
  assert.deepStrictEqual([running.claude, running.gpt], [[10, (sec + 3600) * 1000, 30_000_000], [40, (sec + 3600) * 1000]]);
  // A GPT plan with no 5-hour window: none.
  gpt(null);
  assert.deepStrictEqual(usage().gpt, [null, null], 'no 5-hour window, no share');
  // Older Codex gives the reset as the seconds left (`resets_in_seconds`), counted from the reading, two hours ago here.
  for (const [left, want] of [[600, [0, null]], [4 * 3600, [40, (sec + 7200) * 1000]]]) {
    gpt({ used_percent: 40, window_minutes: 300, resets_in_seconds: left });
    const named = usage(['--session', id]);
    assert.deepStrictEqual([usage().gpt, named.gpt, named.session], [want, want, want], `${left} s left at the reading`);
  }
});

test('CLI usage: an account with no five-hour limit has no 5h share under any key, and says since when (2026-10-30)', t => {
  // Its newest usage answer carries no 5h window (a verified Ultra account), which the status line cache records as
  // five_none_at. `oak usage` reports no 5h share, reset or estimate under any key the surfaces read, in the account
  // block and the flat claude* keys alike, whatever share the cache holds, and says when in `fiveNoneAt`, with or
  // without --json (it always prints JSON); the brief a saved machine reads carries both of the account's answers. An
  // answer with a 5h window since (five_seen_at) brings every key back.
  const b = fixture(t), sec = Math.floor(Date.now() / 1000);
  fs.mkdirSync(b.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const kept = { v: 3, five_pct: 26, five_at: sec - 60, five_reset: sec + 3600, five_tok: 1_560_000, five_total: 6_000_000,
    week_pct: 22, week_at: sec - 60, week_reset: sec + 3 * 86400 };
  const usage = (cache, args) => {
    fs.writeFileSync(path.join(b.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), JSON.stringify(cache));
    const r = run(b, process.execPath, [cli, 'usage', ...args], { env: { ...b.env, OAK_NO_BACKGROUND: '1' } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const keys = (u) => [u.claudeFivePct, u.claudeFiveReset, u.claudeFiveTokens, u.claudeFiveTotal, u.claudeAccount.fiveHourPct,
    u.claudeAccount.fiveNoneAt, u.fiveHourPct, u.fiveNoneAt, u.claudeWeekPct];
  assert.deepStrictEqual(keys(usage(kept, ['--json'])), [26, (sec + 3600) * 1000, 1_560_000, 6_000_000, 26, null, 26, null, 22], 'control: the 5h window, in every key');
  const none = { ...kept, five_none_at: sec - 300 };
  for (const args of [['--json'], []]) {
    assert.deepStrictEqual(keys(usage(none, args)), [null, null, null, null, null, (sec - 300) * 1000, null, (sec - 300) * 1000, 22],
      `${args.join(' ') || 'no flag'}: no 5h share anywhere, and when the account said so`);
  }
  const brief = usage({ ...none, five_seen_at: sec - 900 }, ['--brief', '--json']);
  assert.deepStrictEqual([brief.five, brief.fiveNoneAt, brief.fiveSeenAt, brief.week.pct], [null, (sec - 300) * 1000, (sec - 900) * 1000, 22], 'the brief a saved machine reads');
  assert.deepStrictEqual(keys(usage({ ...none, five_seen_at: sec - 200 }, ['--json'])), [26, (sec + 3600) * 1000, 1_560_000, 6_000_000, 26, null, 26, null, 22],
    'an answer with a 5h window since: every key back');
});

test('CLI usage: a month measured at zero is a 0% share in the keys the JetBrains status bar reads', t => {
  // A new bill cycle with nothing run yet: the statusline cache holds the cycle measured at 0 beside its
  // budget and reset, and GPT's last turn sits in the old cycle with its week budget remembered.
  const b = fixture(t), now = Date.now(), d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const cfg = b.env.CLAUDE_CONFIG_DIR, sessions = path.join(b.env.CODEX_HOME, 'sessions');
  fs.mkdirSync(path.join(cfg, 'claude-observatory'), { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  const cache = (o) => fs.writeFileSync(path.join(cfg, 'statusline-last.json'), JSON.stringify(o));
  cache({ v: 3, month_tok: 0, month_tok_total: 111423689, month_reset: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000) });
  fs.writeFileSync(path.join(sessions, 'rollout-2026-01-01T00-00-00-00000000-0000-4000-8000-00000000000c.jsonl'), [
    { type: 'session_meta', payload: { id: '00000000-0000-4000-8000-00000000000c', cwd: path.join(b.home, 'elsewhere'), model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-5.2' } },
    { timestamp: new Date(start - 3600000).toISOString(), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 50000, output_tokens: 0 } },
      rate_limits: { secondary: { used_percent: 30, window_minutes: 10080, resets_at: Math.round((now + 3 * 86400000) / 1000) } } } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(cfg, 'claude-observatory', 'gpt-week-budget.json'), JSON.stringify({ weekTotal: 1000000, at: now }));
  const usage = () => {
    const r = run(b, process.execPath, [cli, 'usage'], { env: { ...b.env, OAK_NO_BACKGROUND: '1' } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const j = usage();
  assert.deepEqual([j.claudeMonthPct, j.claudeAccount.monthTokens], [0, 0], 'Claude: a 0% share, from the measured 0');
  assert.equal(j.gptMonthTok, 0, 'GPT: the measured 0');
  assert.ok(j.gptMonthTokTotal > 0, 'control: GPT has a budget to share against');
  cache({ v: 3 });
  const never = usage();
  assert.deepEqual([never.claudeMonthPct, never.claudeAccount.monthTokens], [null, null], 'a month never measured has no share');
});

for (const [label, pattern] of [
  ['session deletion', /^  sessions .*--delete <id>.*--undelete <id>/m],
  ['workspace listing help', /sessions \[--all\] \[--synced\] \[--delete[^\n]*\n\s+this machine's sessions, grouped by workspace/],
  ['every machine\'s sessions from the index', /--synced adds every other machine's sessions the local database holds from its\n\s+records, by machine, with when oak sync last brought them/],
  ['a saved machine searched in its records', /--machine <label> searches a saved machine's conversations: in its records here\n\s+when oak sync read it in the last ten minutes, there over SSH otherwise/],
  ['Auto-review threads left out', /without Codex's Auto-review threads unless --all or --session names one/],
  ['store housekeeping', /^  store .*--move <dir>.*--default/m],
  ['inbox keys on both tabs', /On both OAK tabs, i opens the inbox and h jumps to the\n\s+next session waiting on you/],
  ['pinned machine version', /add installs the version pinned in herdr\.lock[\s\S]*?newer local herdr is left alone/],
  ['attach with an optional machine', /^  attach \[machine\] +attach this terminal to herdr here, or on a saved machine/m],
  ['notify from a plain terminal', /--watch[^\n]*\n[^\n]*from a plain terminal with no editor open/],
  ['taking over a backup record', /^  sync setup \[[^\n]*\n +\[--restore\]\n[\s\S]*?--restore takes over the folder's record under this machine's name/m],
  ['a backup key never as an argument', /^  sync key \[--show \| --import \| --from <machine>\] \[--replace\]\n[\s\S]*?--import takes one from standard input, or asks for it on a terminal \(never\n +as an argument\)/m],
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
  // A ControlMaster with no ControlPersist (see --machine): no step of the add becomes that master.
  b.env.SSH_FAKE_G = 'controlmaster auto\ncontrolpersist no\n';
  // Each ssh and scp, `ssh -G` included, runs as every ssh to a saved machine does: carrying none of this
  // machine's store or session variables (the fixture sets three), and never asking in a dialog.
  b.env.SSH_ASKPASS_REQUIRE = 'force';
  b.env.SSH_ASKPASS_LOG = path.join(b.home, 'ssh-askpass.log');
  const result = run(b, process.execPath, [cli, 'machine', 'add', 'testlbl', 'testtgt']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const l = fs.readFileSync(log, 'utf8');
  const steps = l.split('\n').filter((line) => /^(ssh|scp) /.test(line) && !line.startsWith('ssh -G '));
  assert.ok(steps.length > 3 && steps.every((line) => line.includes('-o ControlMaster=no')), l);
  const runs = fs.readFileSync(b.env.SSH_ASKPASS_LOG, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  assert.equal(runs.length, l.split('\n').filter((line) => /^(ssh|scp) /.test(line)).length, 'one line for each ssh and scp');
  assert.deepEqual([...new Set(runs)].sort(), ['scp never', 'ssh never'], runs.join('\n'));
  assert.match(l, /ssh .* node --version/, 'checks Node on the remote before installing oak');
  assert.match(l, /scp .*index\.js testtgt:\.local\/lib\/oak\/index\.js/, 'pushes the CLI bundle');
  assert.match(l, /scp .*capture\.js testtgt:\.local\/lib\/oak\/capture\.js/, 'pushes the capture bundle');
  assert.match(l, /ssh .*\.local\/bin\/oak/, 'writes the oak launcher on the remote PATH');
  assert.match(l, /ssh .*oak init/, 'installs the capture hooks on the remote');
  assert.match(l, /oak init --no-codex [^\n]*oak init --codex/, 'the unseen remote init installs codex hooks but never wires a codex model');
  assert.match(l, /herdr machine add testtgt --label testlbl/, 'still saves the machine in herdr');
  // A machine is saved now: oak sync is offered, until it is set up (or declined) here.
  assert.match(result.stdout, /share memory, plans, skills and sessions with testlbl, and choose where sessions are backed up: `oak sync setup`/);
  assert.equal(run(b, process.execPath, [cli, 'sync', 'setup', '--none', '--json']).status, 0);
  const again = run(b, process.execPath, [cli, 'machine', 'add', 'testlbl', 'testtgt']);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.doesNotMatch(again.stdout, /oak sync setup/, 'declined: not offered again');
});

// OAK needs Node 24 or later on the remote as here: any other Node there is named, and nothing of oak is copied.
test('CLI machine add: a remote whose Node is older than 24 is named and is not given oak', { skip: process.platform === 'win32' && 'POSIX fake tools' }, t => {
  for (const [node, installs] of [['v22.15.1', false], ['v20.11.0', false], ['v23.11.1', false], ['v22.16.0', false], ['v24.0.0', true], ['v24.18.0', true]]) {
    const b = fixture(t);
    const bin = path.join(b.home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    b.env.PATH = bin + path.delimiter + b.env.PATH;
    b.env.MACHINE_ADD_LOG = path.join(b.home, 'machine-add.log');
    b.env.SSH_FAKE_NODE = node;
    const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-add-tool-stub.sh'));
    for (const name of ['ssh', 'scp', 'herdr']) { fs.writeFileSync(path.join(bin, name), stub); fs.chmodSync(path.join(bin, name), 0o755); }
    const result = run(b, process.execPath, [cli, 'machine', 'add', 'testlbl', 'testtgt']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const l = fs.readFileSync(b.env.MACHINE_ADD_LOG, 'utf8');
    assert.equal(/scp .*index\.js testtgt:/.test(l), installs, `${node}: ${l}`);
    assert.equal(result.stdout.includes(`oak not installed on testtgt: needs Node.js 24 or newer (found ${node})`), !installs, `${node}: ${result.stdout}`);
    assert.match(l, /herdr machine add testtgt --label testlbl/, `${node}: still saves the machine in herdr`);
  }
});

test('CLI machine add: a remote with an older herdr gets a copy of this machine\'s, run like every other step', { skip: process.platform === 'win32' && 'POSIX fake tools' }, t => {
  // The same platform, and this machine's herdr at the pin: its bytes are copied over scp, not downloaded.
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  b.env.MACHINE_ADD_LOG = path.join(b.home, 'machine-add.log');
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-add-tool-stub.sh'));
  for (const name of ['ssh', 'scp', 'herdr']) { fs.writeFileSync(path.join(bin, name), stub); fs.chmodSync(path.join(bin, name), 0o755); }
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version;
  Object.assign(b.env, { SSH_FAKE_HERDR: '0.0.1', HERDR_FAKE_VERSION: pin, SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS_LOG: path.join(b.home, 'ssh-askpass.log'),
    SSH_FAKE_UNAME: `${{ linux: 'Linux', darwin: 'Darwin' }[process.platform]}\\n${{ x64: 'x86_64', arm64: 'arm64' }[process.arch]}` });
  const result = run(b, process.execPath, [cli, 'machine', 'add', 'testlbl', 'testtgt']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(result.stdout.includes(`herdr ${pin} installed on testtgt`), result.stdout);
  assert.match(fs.readFileSync(b.env.MACHINE_ADD_LOG, 'utf8'), new RegExp(`^scp .* ${path.join(bin, 'herdr').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} testtgt:\\.local/bin/herdr\\.oak-new$`, 'm'), 'this machine\'s herdr, copied');
  const runs = fs.readFileSync(b.env.SSH_ASKPASS_LOG, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual([...new Set(runs)].sort(), ['scp never', 'ssh never'], runs.join('\n'));
});

// The launcher starts every child with no window of its own on Windows (windowsHide), and a child whose stdio are all
// pipes is then given an unseen console of its own: a jump host's ssh asked its question there and waited out the
// deadline, where REMOTE.md says it asks. Each ssh and scp of `oak machine add` runs in the command's own console
// instead: a terminal's, or the unseen one an editor runs the CLI in, so none opens a window. Only Windows shows the
// difference, so the options each one is started with are recorded.
test('CLI machine add: each ssh and scp shares the command\'s console on Windows, where a jump host can ask (windowsHide: false)', { skip: process.platform === 'win32' && 'POSIX fake tools' }, t => {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  b.env.MACHINE_ADD_LOG = path.join(b.home, 'machine-add.log');
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-add-tool-stub.sh'));
  for (const name of ['ssh', 'scp', 'herdr']) { fs.writeFileSync(path.join(bin, name), stub); fs.chmodSync(path.join(bin, name), 0o755); }
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version;
  const log = path.join(b.home, 'spawns.jsonl');
  Object.assign(b.env, { SSH_FAKE_HERDR: '0.0.1', HERDR_FAKE_VERSION: pin, OAK_SPAWN_LOG: log,
    SSH_FAKE_UNAME: `${{ linux: 'Linux', darwin: 'Darwin' }[process.platform]}\\n${{ x64: 'x86_64', arm64: 'arm64' }[process.arch]}` });
  const result = run(b, process.execPath, ['--require', path.join(root, 'packages/tui/test/fixtures/spawn-recorder.cjs'), cli, 'machine', 'add', 'testlbl', 'testtgt']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const steps = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((s) => ['ssh', 'scp'].includes(path.basename(s.file)) && s.args[0] !== '-G');
  assert.ok(steps.some((s) => path.basename(s.file) === 'scp' && s.args.at(-1).endsWith('herdr.oak-new')) && steps.length > 5, `control: the add copied herdr and ran its steps: ${JSON.stringify(steps.map((s) => s.args.at(-1)))}`);
  assert.deepEqual(steps.filter((s) => s.windowsHide).map((s) => `${path.basename(s.file)} ${s.args.at(-1)}`), [], 'none is started hidden');
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

test('CLI machine add: an oak there that is not its launcher is left as it is, and the launcher never writes through a link (2026-10-07)', { skip: process.platform === 'win32' && 'POSIX fake tools' }, t => {
  // With npm's prefix in ~/.local, `npm link` makes ~/.local/bin/oak a link into the checkout's build, and the
  // launcher `oak machine add` wrote there went through it: the checkout's packages/cli/dist/index.js became
  // the launcher.
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  const remote = path.join(b.home, 'remote');
  fs.mkdirSync(bin);
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  b.env.REMOTE = remote;
  const log = path.join(b.home, 'tools.log');
  b.env.TOOLS_LOG = log;
  // ssh runs the remote command in the remote home, as sshd does, with Node 24+ on its PATH; scp copies there.
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
[ "$1" = -G ] && exit 0
for a in "$@"; do last="$a"; done
cd "$REMOTE" && exec /usr/bin/env -i HOME="$REMOTE" PATH="$REMOTE/node-bin:/usr/bin:/bin" /bin/sh -c "$last"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'scp'), `#!/bin/sh
r=; skip=; set --  "$@" ; n=$#; i=0; srcs=
for a in "$@"; do
  i=$((i+1))
  if [ -n "$skip" ]; then skip=; continue; fi
  case "$a" in -o) skip=1 ;; -r) r=-r ;; -*) ;; *) if [ $i -eq $n ]; then dest="$REMOTE/\${a#*:}"; else srcs="$a"; fi ;; esac
done
echo "scp $srcs" >> "$TOOLS_LOG"
cp $r "$srcs" "$dest"
`, { mode: 0o755 });
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version;
  // herdr here: the machine is already saved. herdr there: already at the pin.
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\n[ "$*" = "machine list --json" ] && echo '[{"id":"m1","label":"box","target":"me@box","session":"default","enabled":true,"selected":false}]'\nexit 0\n`, { mode: 0o755 });
  const reset = () => {
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(log, { force: true });
    fs.mkdirSync(path.join(remote, '.local', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(remote, 'node-bin'));
    fs.symlinkSync(process.execPath, path.join(remote, 'node-bin', 'node'));
    // Its Node in ~/.local/bin as well, where a user-local Node lives: the installed oak runs on MACHINE_PATH,
    // whose /usr/local/bin comes before the PATH above, and on GitHub's ubuntu-latest runner that holds an
    // older Node than OAK accepts.
    fs.symlinkSync(process.execPath, path.join(remote, '.local', 'bin', 'node'));
    fs.writeFileSync(path.join(remote, '.local', 'bin', 'herdr'), `#!/bin/sh\necho "herdr ${pin}"\n`, { mode: 0o755 });
  };
  const add = () => run(b, process.execPath, [cli, 'machine', 'add', 'box', 'me@box'], { timeout: 60000 });
  const scps = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

  // npm's link to a checkout there, as `npm link` leaves it with npm's prefix in ~/.local.
  reset();
  const build = path.join(remote, 'src', 'oak', 'packages', 'cli', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(build), { recursive: true });
  makeGitDir(path.join(remote, 'src', 'oak', '.git'));
  const ours = '#!/bin/sh\necho "oak $*" >> "$HOME/oak.log"\n[ "$1" = --version ] && echo "oak 9.9.9-dev.0"\nexit 0\n';
  fs.writeFileSync(build, ours, { mode: 0o755 });
  fs.mkdirSync(path.join(remote, '.local', 'lib', 'node_modules'), { recursive: true });
  fs.symlinkSync('../../../src/oak/packages/cli', path.join(remote, '.local', 'lib', 'node_modules', 'oak-observatory'));
  fs.symlinkSync('../lib/node_modules/oak-observatory/dist/index.js', path.join(remote, '.local', 'bin', 'oak'));
  let r = add();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(build, 'utf8'), ours, "the checkout's build is untouched");
  assert.equal(fs.readlinkSync(path.join(remote, '.local', 'bin', 'oak')), '../lib/node_modules/oak-observatory/dist/index.js', 'and so is the link');
  assert.deepEqual([scps(), fs.existsSync(path.join(remote, '.local', 'lib', 'oak'))], [[], false], 'nothing was copied there');
  assert.ok(r.stdout.includes(`me@box already runs oak from ${path.join(remote, '.local', 'bin', 'oak')}, which \`oak machine add\` did not put there: left as it is`), r.stdout);
  assert.match(r.stdout, /oak on me@box \(oak 9\.9\.9-dev\.0\) \+ capture hooks/);
  assert.deepEqual(fs.readFileSync(path.join(remote, 'oak.log'), 'utf8').trim().split('\n'), ['oak init --no-codex', 'oak init --codex', 'oak --version'], 'its own capture hooks set up with it');

  // A link that leads nowhere is no oak: the launcher goes in its place, never through it (where it would
  // have made the file the link names).
  reset();
  const nowhere = path.join(remote, 'gone', 'index.js');
  fs.mkdirSync(path.dirname(nowhere));
  fs.symlinkSync(nowhere, path.join(remote, '.local', 'bin', 'oak'));
  r = add();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.lstatSync(path.join(remote, '.local', 'bin', 'oak')).isFile(), true, 'the launcher replaced the link');
  assert.equal(fs.existsSync(nowhere), false, 'nothing was written where the link pointed');
  assert.match(fs.readFileSync(path.join(remote, '.local', 'bin', 'oak'), 'utf8'), /"\$HOME\/\.local\/lib\/oak\/index\.js"/);
  assert.match(r.stdout, /oak installed on me@box \(oak \S+\) \+ capture hooks; ~\/\.local\/bin on PATH/);
  assert.ok(fs.existsSync(path.join(remote, '.local', 'lib', 'oak', 'cli.js')), 'the bundle was pushed');
  // Run again over its own launcher, it pushes again: that is how `oak machine add` updates its copy.
  fs.rmSync(log);
  r = add();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(scps().length >= 5, scps().join('\n'));
  assert.doesNotMatch(r.stdout, /already runs oak/);
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

test('CLI init: a codex config.toml that begins with a byte order mark keeps it first, and its hooks are trusted', { skip: process.platform === 'win32' && 'POSIX fake codex' }, async t => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const marked = (file) => {
    const bytes = fs.readFileSync(file);
    return bytes.subarray(0, 3).equals(BOM) && bytes.indexOf(BOM, 3) === -1;
  };
  const trusted = (b) => assert.match(run(b, process.execPath, [cli, 'status']).stdout, /^codex hooks: +installed → .* {2}trusted$/m);
  // `oak init --codex` reads the file, and appends the hooks' trust after everything in it.
  const hooks = codexFixture(t);
  fs.writeFileSync(hooks.cfg, Buffer.concat([BOM, Buffer.from('model = "gpt-5"\n\n[projects."/tmp/x"]\ntrust_level = "trusted"\n')]));
  let r = run(hooks.b, process.execPath, [cli, 'init', '--codex']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(marked(hooks.cfg), fs.readFileSync(hooks.cfg, 'utf8').slice(0, 80));
  trusted(hooks.b);
  // Plain `oak init` also wires a local model when nothing chooses one: its keys go after the mark and
  // before the first table, and `oak uninstall` puts the file back as it was.
  const wired = codexFixture(t);
  const ollama = await fakeOllama(t, wired.b);
  const original = Buffer.concat([BOM, Buffer.from('[features]\nhooks = true\n')]);
  fs.writeFileSync(wired.cfg, original);
  r = run(wired.b, process.execPath, [...ollama, cli, 'init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wired to your newest local model, llama3\.2:latest/);
  assert.ok(marked(wired.cfg), fs.readFileSync(wired.cfg, 'utf8').slice(0, 80));
  assert.equal(require('smol-toml').parse(fs.readFileSync(wired.cfg, 'utf8')).model, 'llama3.2:latest');
  trusted(wired.b);
  r = run(wired.b, process.execPath, [cli, 'uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(wired.cfg), original, 'uninstall leaves config.toml as it was before init, the mark first');
});

function doctor(b, { platform = process.platform, report, spawn, binary = '/fake/herdr', identity, loginScope, version, dirname = path.join(root, 'packages/cli/dist') } = {}) {
  let output = '';
  const native = [];
  let exitCode;
  let repairs = 0;
  // The signal handlers doctor installs, and what was done: the forwarding check run, herdr's commands for saved
  // machines stopped, a signal raised.
  const handlers = [], acted = [];
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
    diagnoseMachineUsage: () => [{ id: 'machine-usage:build-box', label: 'Claude usage from build-box', level: 'warn', detail: 'fixture', fix: 'Update OAK on build-box' }],
    diagnoseSync: () => [],
    diagnoseIndex: () => ({ id: 'index', label: 'Local database', level: 'ok', detail: 'fixture' }),
    diagnoseCodexQuota: () => null,
    // How many signal handlers were in place when the check began: they must be, before it starts herdr.
    diagnoseHerdrForwarding: async () => { acted.push(`forwarding, ${handlers.length} handlers in place`); return []; },
    diagnoseHerdrPane: async () => [],
    stopDetachedChildren: () => { acted.push('stop'); },
    getUpdateChannel: () => 'stable',
    terminalNotifierPath: realCore.terminalNotifierPath,
    spawnToolSync: spawn || ((file, args) => run(b, file, args)),
  };
  const module = { exports: {} };
  vm.runInNewContext(doctorCode, {
    module, exports: module.exports, __dirname: dirname,
    require: name => name === '@oak-observatory/core' ? core : name === '@oak-observatory/tui'
      ? { diagnoseNativeSpawn: async (fix, opts) => { native.push(opts); return { id: 'pty', label: 'pty', level: 'ok', detail: 'fixture' }; } } : require(name),
    process: { platform, env: b.env, cwd: () => b.home, pid: 4242,
      stdout: { isTTY: false, write: text => { output += text; } },
      exit: code => { exitCode = code; },
      once: (signal, fn) => { handlers.push([signal, fn]); },
      kill: (pid, signal) => { acted.push(`raise ${signal} at ${pid}`); } },
  });
  return { async updateHerdr() {
    await module.exports.ensureHerdrPin();
    return { output, repairs };
  }, async run(args = []) {
    await module.exports.cmdDoctor(args);
    return { output, exitCode, repairs, native, handlers, acted };
  } };
}

// The forwarding check runs `herdr --machine <label> pane list` for each saved machine, apart from the terminal
// (execFileTool `detached`), for up to 30 s each: ctrl+c, or an editor's deadline (SIGTERM), ended doctor and
// left herdr and its ssh running.
test('CLI doctor: a signal during the forwarding check stops herdr\'s commands for saved machines, then ends doctor by it', async t => {
  const b = fixture(t);
  // Windows runs them in doctor's console, which ctrl+c reaches as well: nothing to install there.
  const windows = await doctor(b, { platform: 'win32' }).run(['--json']);
  assert.deepEqual([windows.acted, windows.handlers], [['forwarding, 0 handlers in place'], []]);
  // No login shell is run for the `oak` row: the one here is this machine's, and Windows has no /bin/sh to run.
  const r = await doctor(b, { platform: 'linux', spawn: () => ({ status: 1, stdout: '' }) }).run(['--json']);
  assert.deepEqual(r.acted, ['forwarding, 4 handlers in place'], 'installed before the check starts herdr, not after');
  assert.deepEqual(r.handlers.map(([signal]) => signal), ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'], 'one handler for each signal that stops ssh');
  for (const [signal, handler] of r.handlers) {
    r.acted.length = 0;
    handler();
    assert.deepEqual(r.acted, ['stop', `raise ${signal} at 4242`], `${signal}: herdr's commands stop first, then doctor ends by ${signal}`);
  }
});

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

// On Windows node-pty's ConPTY keeps a worker thread running after the PTY check's child has exited
// (microsoft/node-pty#887): `oak doctor --json` and `--markdown` never ended, and a caller waited out its own timeout.
// The fake node-pty here leaves a timer running the same way.
test('CLI doctor: --json and --markdown end once printed, though node-pty leaves a handle running after its check', t => {
  const b = fixture(t);
  const fake = path.join(b.home, 'fake-node-pty');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'package.json'), '{"name":"node-pty","main":"index.js"}');
  fs.writeFileSync(path.join(fake, 'index.js'), `exports.spawn = () => {
  require('fs').appendFileSync(${JSON.stringify(path.join(b.home, 'spawned'))}, 'x');
  setInterval(() => {}, 60_000);
  return { onData() {}, onExit(fn) { setImmediate(() => fn({ exitCode: 0 })); }, kill() {} };
};\n`);
  const preload = path.join(b.home, 'fake-node-pty.cjs');
  fs.writeFileSync(preload, `const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'node-pty/package.json' ? ${JSON.stringify(path.join(fake, 'package.json'))} : resolve.call(this, request, ...rest);
};\n`);
  b.env = { ...b.env, HERDR_BIN: path.join(b.home, 'absent-herdr'), HERDR_SOCKET_PATH: path.join(b.home, 'no-socket'), OAK_NO_BACKGROUND: '1' };
  const json = run(b, process.execPath, ['--require', preload, cli, 'doctor', '--json'], { timeout: 30_000 });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).checks.find((c) => c.id === 'native-spawn')?.level, 'ok');
  assert.equal(fs.readFileSync(path.join(b.home, 'spawned'), 'utf8'), 'x', 'control: the check ran the fake');
  const md = run(b, process.execPath, ['--require', preload, cli, 'doctor', '--markdown'], { timeout: 30_000 });
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /Native terminal PTY spawn/);
});

test('CLI doctor: names an `oak` a login shell finds before this installation, since Codex runs its hooks through one (2026-10-06)', { skip: process.platform === 'win32' && 'POSIX login shell' }, async t => {
  // On the Mac it happened on, a login shell found a release in Homebrew's prefix before ~/.local/bin, where
  // the checkout's link was: every Codex hook ran the release, and nothing said so.
  const b = fixture(t);
  const ours = path.join(root, 'packages/cli/dist/index.js');
  const mine = path.join(b.home, 'mine');
  fs.mkdirSync(mine);
  fs.symlinkSync(ours, path.join(mine, 'oak')); // this installation's command, as npm links it
  const brew = path.join(b.home, 'brew');
  const pkg = path.join(brew, 'lib', 'node_modules', 'oak-observatory');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(brew, 'bin'));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oak-observatory', version: '0.11.0-dev.15' }));
  fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), '#!/usr/bin/env node\n', { mode: 0o755 }); // npm makes a bin's target executable
  fs.symlinkSync('../lib/node_modules/oak-observatory/dist/index.js', path.join(brew, 'bin', 'oak'));
  // A login shell: its PATH comes from the login startup files, not from the shell doctor runs in.
  const shell = path.join(b.home, 'login-shell');
  fs.writeFileSync(shell, '#!/bin/sh\n[ "$1" = -lc ] || exit 64\npwd > "$HOME/login-cwd"\nPATH="$LOGIN_PATH" exec /bin/sh -c "$2"\n', { mode: 0o755 });
  b.env.SHELL = shell;
  // Each spawn as the CLI makes it, its options included, in the fixture's environment.
  const spawn = (file, args, opts = {}) => cp.spawnSync(file, args, { ...opts, env: b.env });
  const row = async (opts = {}) => JSON.parse((await doctor(b, { spawn, ...opts }).run(['--json'])).output).checks.find((c) => c.id === 'login-shell-oak');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8')).version;
  const here = `${version} at ${fs.realpathSync(ours)}`;

  b.env.LOGIN_PATH = [path.join(brew, 'bin'), mine, '/usr/bin', '/bin'].join(':');
  const shadowed = await row();
  assert.equal(shadowed.level, 'warn');
  assert.equal(shadowed.detail, `a login shell runs ${path.join(brew, 'bin', 'oak')}, which is 0.11.0-dev.15 at ${fs.realpathSync(path.join(pkg, 'dist', 'index.js'))}, not this installation (${here}): the hooks Codex runs through a login shell run that one`);
  assert.match(shadowed.fix, /npm uninstall -g oak-observatory.*~\/\.zprofile.*path_helper puts \/usr\/local\/bin and Homebrew's directories before ~\/\.local\/bin/);
  assert.equal(fs.readFileSync(path.join(b.home, 'login-cwd'), 'utf8').trim(), fs.realpathSync(b.home), 'from the home folder, as the hooks are');
  // This installation first: the same file, so nothing to say.
  b.env.LOGIN_PATH = [mine, path.join(brew, 'bin'), '/usr/bin', '/bin'].join(':');
  assert.deepEqual(await row(), { id: 'login-shell-oak', label: '`oak` in a login shell', level: 'ok', detail: `${path.join(mine, 'oak')} is this installation (${here})` });
  // None at all: the hooks cannot run.
  b.env.LOGIN_PATH = '/usr/bin:/bin';
  assert.match((await row()).detail, /^a login shell \(\S+ -lc\) finds no `oak`, so the hooks Codex runs through one cannot capture anything/);
  // A launcher it cannot follow is said as such, never passed as this installation.
  const shim = path.join(b.home, 'shims');
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'oak'), '#!/bin/sh\nexec somewhere-else "$@"\n', { mode: 0o755 });
  b.env.LOGIN_PATH = [shim, mine, '/usr/bin', '/bin'].join(':');
  const shimmed = await row();
  assert.equal(shimmed.level, 'warn');
  assert.match(shimmed.detail, /which OAK cannot follow to an installation/);
  // The copy `oak machine add` pushes runs through the launcher it writes, which is that installation.
  assert.ok(source.includes('"$HOME/.local/lib/oak/index.js" "$@"'), 'the launcher machine add writes');
  const bundle = path.join(b.home, '.local', 'lib', 'oak');
  fs.mkdirSync(bundle, { recursive: true });
  fs.copyFileSync(ours, path.join(bundle, 'index.js'));
  fs.copyFileSync(path.join(root, 'packages/cli/package.json'), path.join(bundle, 'package.json'));
  fs.mkdirSync(path.join(b.home, '.local', 'bin'));
  fs.writeFileSync(path.join(b.home, '.local', 'bin', 'oak'), '#!/bin/sh\nexec "$(command -v node 2>/dev/null || echo "$HOME/.local/bin/node")" "$HOME/.local/lib/oak/index.js" "$@"\n', { mode: 0o755 });
  b.env.LOGIN_PATH = [path.join(b.home, '.local', 'bin'), path.join(brew, 'bin'), '/usr/bin', '/bin'].join(':');
  assert.equal((await row({ dirname: bundle })).level, 'ok');
  assert.equal((await row()).level, 'warn', 'control: the launcher is that copy, not the npm install');
  // A login startup file that leaves a job of its own holding the shell's output open: the shell answers and
  // exits, and only the wait for that output to close runs into the deadline (1.5 s here). The answer stands,
  // whichever it is. A shell that never answers is still not inspected.
  const job = path.join(b.home, 'login-job');
  const held = async (script) => {
    fs.writeFileSync(shell, `#!/bin/sh\n[ "$1" = -lc ] || exit 64\n${script}\n`, { mode: 0o755 });
    const short = (file, args, opts = {}) => cp.spawnSync(file, args, { ...opts, ...(file === shell ? { timeout: 1500 } : {}), env: b.env });
    try {
      return await row({ spawn: short });
    } finally {
      try { process.kill(Number(fs.readFileSync(job, 'utf8'))); } catch {}
    }
  };
  const answers = 'sleep 30 &\necho $! > "$HOME/login-job"\nPATH="$LOGIN_PATH" exec /bin/sh -c "$2"';
  b.env.LOGIN_PATH = [mine, path.join(brew, 'bin'), '/usr/bin', '/bin'].join(':');
  assert.deepEqual(await held(answers), { id: 'login-shell-oak', label: '`oak` in a login shell', level: 'ok', detail: `${path.join(mine, 'oak')} is this installation (${here})` });
  b.env.LOGIN_PATH = '/usr/bin:/bin';
  assert.match((await held(answers)).detail, /^a login shell \(\S+ -lc\) finds no `oak`/);
  assert.match((await held('echo $$ > "$HOME/login-job"\nexec sleep 30')).detail, /^not inspected — .* did not answer within 5 s$/);
  // Windows runs no login shell for the hooks.
  assert.match((await row({ platform: 'win32' })).detail, /^not checked on Windows/);
});

test('CLI: the daily update nudge stays quiet for a CLI run from a checkout, or a local build, which `oak update` leaves alone (2026-10-06)', async t => {
  const b = fixture(t);
  fs.writeFileSync(path.join(b.home, '.update-check'), JSON.stringify({ checkedMs: 0, latestTag: '0.10.0', latestDevTag: '9.9.9-dev.1' }));
  const nudge = (dirname) => {
    const registered = [], spawned = [];
    const core = { rootDir: () => b.home, getUpdateChannel: () => 'dev', compareVersions: realCore.compareVersions, isNewer: realCore.isNewer,
      isLocalBuild: realCore.isLocalBuild, noBackgroundChildren: () => false, spawnTool: (...a) => { spawned.push(a); return { unref() {} }; } };
    const module = { exports: {} };
    vm.runInNewContext(doctorCode, {
      module, exports: module.exports, __dirname: dirname, __filename: path.join(dirname, 'cli.js'),
      require: (name) => (name === '@oak-observatory/core' ? core : require(name)),
      process: { platform: process.platform, env: {}, execPath: process.execPath, stderr: { isTTY: true, write: () => true }, on: (event) => { registered.push(event); } },
    });
    module.exports.maybeCheckForUpdate('status', []);
    return { registered, spawned: spawned.length };
  };
  assert.deepEqual(nudge(path.join(root, 'packages/cli/dist')), { registered: [], spawned: 0 }, 'this checkout\'s build: no nudge, no check');
  // A checkout whose version a release can carry (a `main` checkout after a promote): the checkout keeps it quiet,
  // not the local build's own rule, which this tree's dev.0 version also meets.
  const checkout = path.join(b.home, 'src', 'oak');
  makeGitDir(path.join(checkout, '.git'));
  fs.mkdirSync(path.join(checkout, 'packages', 'cli', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'packages', 'cli', 'package.json'), JSON.stringify({ name: 'oak-observatory', version: '9.9.9-dev.3' }));
  assert.deepEqual(nudge(path.join(checkout, 'packages', 'cli', 'dist')), { registered: [], spawned: 0 }, 'a checkout at a released version: no nudge, no check');
  // The copy `oak machine add` pushes (its manifest beside it), which `oak machine add` updates; at a released version.
  const bundle = path.join(b.home, 'lib', 'oak');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'oak-observatory', version: '9.9.9-dev.3' }));
  assert.deepEqual(nudge(bundle), { registered: [], spawned: 0 }, 'a copy `oak machine add` pushed: no nudge, no check');
  // An installed copy (npm's layout: the manifest one level up), at a version a release carries, and at a
  // local build's (dev.0), which no release carries.
  const installed = (v) => {
    const pkg = fs.mkdtempSync(path.join(b.home, 'pkg-'));
    fs.mkdirSync(path.join(pkg, 'dist'));
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oak-observatory', version: v }));
    return path.join(pkg, 'dist');
  };
  assert.deepEqual(nudge(installed('9.9.9-dev.0')), { registered: [], spawned: 0 }, 'a local build: no nudge, no check');
  assert.deepEqual(nudge(installed('9.9.9-dev.3')), { registered: ['exit'], spawned: 1 }, 'control: an installed copy of a release is nudged and checks');
});

test('CLI doctor: on macOS without terminal-notifier, a warning says a click opens Script Editor', { skip: process.platform === 'win32' && 'POSIX fake PATH' }, async t => {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync('/bin/sh', path.join(bin, 'sh'));
  b.env.PATH = bin;
  const brew = path.join(b.home, 'brew');
  fs.mkdirSync(brew);
  realCore.setTerminalNotifierDirs([brew]);
  t.after(() => realCore.setTerminalNotifierDirs(undefined));
  const row = async platform => JSON.parse((await doctor(b, { platform }).run(['--json'])).output).checks.find(c => c.id === 'terminal-notifier');
  const warning = { id: 'terminal-notifier', label: 'Desktop notifications (macOS)', level: 'warn',
    detail: 'terminal-notifier is not installed: a notification posted through osascript opens Script Editor when clicked',
    fix: 'brew install terminal-notifier' };
  assert.deepEqual(await row('darwin'), warning);
  assert.equal(await row('linux'), undefined, 'no row off macOS');
  // Installed where Homebrew puts it but off PATH, as an editor launched from the Dock sees it: the post
  // finds it there, so doctor must not warn.
  fs.writeFileSync(path.join(brew, 'terminal-notifier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(await row('darwin'), undefined, 'no row when it is in a Homebrew directory off PATH');
  fs.rmSync(path.join(brew, 'terminal-notifier'));
  assert.deepEqual(await row('darwin'), warning, 'control: removed again, the warning returns');
  fs.writeFileSync(path.join(bin, 'terminal-notifier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(await row('darwin'), undefined, 'no row once it is on PATH');
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
  assert.ok(JSON.parse(result.output).checks.some(c => c.id === 'machine-usage:build-box'), '…and the saved machines\' usage rows');
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

test('CLI --machine: worker follow polls the owner, prints the exact end and exits', { skip: process.platform === 'win32' && 'POSIX fake ssh', timeout: 20000 }, async t => {
  const f = machineFixture(t), remote = f.b.env.FAKE_REMOTE_HOME;
  const work = path.join(remote, 'worker-project');
  fs.mkdirSync(work);
  const project = path.join(remote, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  const parent = path.join(project, 'worker-parent.jsonl'), worker = path.join(project, 'worker-parent/subagents/agent-w1.jsonl');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  const line = (text, sidechain = false) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T10:00:00Z', cwd: work,
    sessionId: 'worker-parent', isSidechain: sidechain, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
  fs.writeFileSync(parent, line('REMOTE PARENT'));
  fs.writeFileSync(worker, line('REMOTE WORKER', true));
  const child = cp.spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/worker-poll-clock.cjs'), cli,
    'feed', '--kind', 'agent', '--id', 'w1', '--session', 'worker-parent', '--follow', '--machine', 'build-box'], { env: f.b.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  let out = '', err = '';
  const ready = new Promise(resolve => child.stdout.on('data', d => { out += d; if (out.includes('REMOTE WORKER')) resolve(); }));
  child.stderr.on('data', d => { err += d; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const polling = new Promise(resolve => child.once('message', resolve));
  // Wait for the first snapshot and its scheduled poll; advance that poll only after writing the end.
  await Promise.race([Promise.all([ready, polling]), closed.then(code => assert.fail(`worker follower closed before its first snapshot (${code}): ${err}`))]);
  assert.deepEqual(await polling, { pollMs: 10000 });
  assert.match(out, /REMOTE WORKER/, err);
  fs.appendFileSync(worker, line('REMOTE SECOND STEP', true));
  fs.appendFileSync(parent, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T10:05:00.123Z',
    content: '<task-notification><task-id>w1</task-id><status>completed</status></task-notification>' }) + '\n');
  child.send('poll');
  assert.equal(await closed, 0, err);
  assert.match(out, /REMOTE SECOND STEP/);
  assert.match(out, /Worker ended at 2026-10-01T10:05:00.123Z/);
  assert.doesNotMatch(out, /REMOTE PARENT/);
  assert.equal(f.sshCalls().length, 2, 'two snapshots across a poll, with no remote follower');
  assert.ok(f.sshCalls().every(args => !args.join(' ').includes("'--follow'")));
});

test('CLI --machine: editor Review batch includes units, tree and raw file history', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t), session = 'remote-panel', file = f.seed(session);
  const project = path.join(f.b.env.FAKE_REMOTE_HOME, '.claude', 'projects', path.dirname(file).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, session + '.jsonl'), JSON.stringify({ type: 'assistant', cwd: path.dirname(file), message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic remote review' }] } }) + '\n');
  const r = onMachine(f, ['views', '--views', 'review,tree,timeline', '--no-patch', '--json', '--session', session]);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.review?.units.length, 1, r.stdout);
  assert.deepEqual(d.review.units[0].members, [1, 2]);
  assert.equal(d.timeline?.edits.length, 2, 'history keeps every raw revision');
  assert.ok(d.tree && Array.isArray(d.tree.files), r.stdout);
  assert.ok(!('patch' in d.review.units[0]), 'list read carries no patches');
  const patch = onMachine(f, ['diff', '2', '--patch', '--session', session]);
  assert.equal(patch.status, 0, patch.stderr); assert.match(patch.stdout, /\+C/);
  const context = onMachine(f, ['chat-context', '--edit', '2', '--json', '--session', session]);
  assert.equal(context.status, 0, context.stderr); assert.ok(JSON.parse(context.stdout).prompt);
  assert.equal(onMachine(f, ['keep', '--all', '--session', session, '--json']).status, 0);
  const clear = onMachine(f, ['clean', '--resolved', '--ids', '1,2', '--session', session, '--json']);
  assert.equal(clear.status, 0, clear.stderr); assert.equal(JSON.parse(clear.stdout).cleared, 2);
});

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
  // No keepalive of OAK's own: the person's ssh_config decides that.
  assert.deepEqual(calls[0].slice(0, 8), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', 'builder@build-box.example']);
  const command = calls[0].slice(8).join('\n');
  assert.match(command, /^env PATH="\$HOME\/\.local\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\$PATH"/);
  assert.match(command, / OAK_FORWARDED=1 OAK_FORWARDED_MACHINE='build-box' /, 'the remote learns the label a repair it prints must name');
  assert.ok(command.endsWith("oak 'list' '--json' '--session' 'remote-review'"));
});

test('CLI --machine: OAK\'s ssh never becomes a shared-connection master that ends with it', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  // ControlMaster on and ControlPersist off make the ssh OAK runs the master every other session to that
  // host then shares, and stopping it (a deadline, ctrl+c) ends them all. `ssh -G` says which; a
  // persisted master runs in the background, where OAK's ssh can come and go.
  const f = machineFixture(t);
  f.seed('mux');
  f.b.env.SSH_G_LOG = path.join(f.b.home, 'ssh-G.log');
  const sharedOff = (answer) => {
    f.b.env.SSH_FAKE_G = answer;
    fs.rmSync(f.b.env.MACHINE_EXEC_LOG, { force: true });
    const r = onMachine(f, ['list', '--json', '--session', 'mux']);
    assert.equal(r.status, 0, r.stderr);
    const [argv] = f.sshCalls();
    return argv.some((a, i) => a === '-o' && argv[i + 1] === 'ControlMaster=no');
  };
  const cases = [
    ['controlmaster auto\ncontrolpersist no\n', true],
    ['controlmaster true\ncontrolpersist no\n', true],
    ['controlmaster autoask\ncontrolpersist no\n', true],
    ['controlmaster ask\ncontrolpersist no\n', true],
    ['controlmaster auto\ncontrolpersist 600\n', false],
    ['controlmaster true\ncontrolpersist yes\n', false],
    ['controlmaster false\ncontrolpersist no\n', false],
  ];
  for (const [answer, off] of cases) assert.equal(sharedOff(answer), off, answer);
  assert.deepEqual(fs.readFileSync(f.b.env.SSH_G_LOG, 'utf8').trim().split('\n'), cases.map(() => 'builder@build-box.example'), 'it asks about the target it reaches');
});

test('CLI ssh: a configuration `ssh -G` could not print reads as a shared master, and each target is asked once', () => {
  // `ssh -G` runs the config's `Match exec` commands, so it can fail or hang. ControlMaster=no is the safe
  // reading then: it still rides a master that is already open, and otherwise connects directly.
  const module = { exports: {} }, asked = [];
  const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { sshMux };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const answers = {
    'me@shared': { status: 0, stdout: 'controlmaster auto\ncontrolpersist no\n' },
    'me@plain': { status: 0, stdout: 'controlmaster false\ncontrolpersist no\n' },
    'me@broken': { status: 255, stdout: 'controlmaster false\n', stderr: 'bad configuration option' },
    'me@slow': { status: null, signal: 'SIGTERM', stdout: '', error: Object.assign(new Error('spawnSync ssh ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
  };
  const core = { machineSshEnv: () => ({}), sshMuxOptions: realCore.sshMuxOptions, spawnToolSync: (bin, argv, opts) => {
    assert.deepEqual([bin, argv[0], opts.timeout], ['ssh', '-G', 5000]);
    asked.push(argv[1]);
    return answers[argv[1]];
  } };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, require: name => name === '@oak-observatory/core' ? core : require(name),
    process: { env: {}, stdout: { isTTY: false }, stderr: { write() {} }, platform: 'linux' } });
  const sshMux = (target) => [...module.exports.sshMux(target)], no = ['-o', 'ControlMaster=no']; // an array of this realm
  assert.deepEqual(sshMux('me@shared'), no);
  assert.deepEqual(sshMux('me@plain'), [], 'a second target in the same run is judged by its own answer');
  assert.deepEqual(sshMux('me@shared'), no);
  assert.deepEqual(sshMux('me@broken'), no, 'ssh -G failed');
  assert.deepEqual(sshMux('me@slow'), no, 'ssh -G ran past its 5 s');
  assert.deepEqual(asked, ['me@shared', 'me@plain', 'me@broken', 'me@slow'], 'asked once per target');
});

/** What OpenSSH 9.6 wrote to stderr for each failure, run with OAK's options against a loopback sshd (a closed
 *  port, a key it does not know, a changed host key, too many keys offered, its session killed, a login the
 *  server closed after its banner or that PAM refused, each of these through a jump host or a ProxyCommand too,
 *  a jump host that cannot reach its target, may not forward to it or asks for a password, with LogLevel
 *  VERBOSE, and with RequestTTY yes and no terminal on stdin) and against addresses with no route or no name,
 *  and what scp, which runs ssh, wrote after it; only the paths, the user and the port are replaced. ssh ends
 *  its own lines with \r\n. Each is [stderr, the reason OAK names]: no more than ssh's last two lines that say
 *  why. */
const sshCaptured = {
  refused: ['ssh: connect to host 127.0.0.1 port 1: Connection refused\r\n', 'ssh: connect to host 127.0.0.1 port 1: Connection refused'],
  'no route': ['ssh: connect to host 172.17.0.99 port 22: No route to host\r\n', 'ssh: connect to host 172.17.0.99 port 22: No route to host'],
  'no network': ['ssh: connect to host 2001:db8::1 port 22: Network is unreachable\r\n', 'ssh: connect to host 2001:db8::1 port 22: Network is unreachable'],
  'changed host key': ["@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\r\nSomeone could be eavesdropping on you right now (man-in-the-middle attack)!\r\nIt is also possible that a host key has just been changed.\r\nThe fingerprint for the ED25519 key sent by the remote host is\nSHA256:DxQ9IZzklrl668ArCGxHPg5wZINAMi5H84DWAySQE1Q.\r\nPlease contact your system administrator.\r\nAdd correct host key in /home/user/.ssh/known_hosts to get rid of this message.\r\nOffending ED25519 key in /home/user/.ssh/known_hosts:1\r\n  remove with:\r\n  ssh-keygen -f '/home/user/.ssh/known_hosts' -R '[127.0.0.1]:2222'\r\nHost key for [127.0.0.1]:2222 has changed and you have requested strict checking.\r\nHost key verification failed.\r\n", 'Host key for [127.0.0.1]:2222 has changed and you have requested strict checking. — Host key verification failed.'],
  'first contact, then a refused login': ["Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.\r\nuser@127.0.0.1: Permission denied (publickey).\r\n", 'user@127.0.0.1: Permission denied (publickey).'],
  'stale control socket': ['Control socket connect(/home/user/.ssh/cm-box): Connection refused\r\nssh: connect to host 127.0.0.1 port 1: Connection refused\r\n', 'ssh: connect to host 127.0.0.1 port 1: Connection refused'],
  'unknown host': ['ssh: Could not resolve hostname no-such-host.invalid: Name or service not known\r\n', 'ssh: Could not resolve hostname no-such-host.invalid: Name or service not known'],
  // The session's server process killed after the remote command wrote a line of its own.
  'dropped connection': ['warning: low disk space\nConnection to 127.0.0.1 closed by remote host.\r\n', 'warning: low disk space — Connection to 127.0.0.1 closed by remote host.'],
  // Neither says what failed, and ssh adds nothing after them: no reason beats a wrong one.
  'only a stale socket': ['Control socket connect(/home/user/.ssh/cm-box): Connection refused\r\n', ''],
  'first contact, then the remote shell killed': ["Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.\r\n", ''],
  // Through a jump host (ProxyJump) or a ProxyCommand, ssh adds the close of the proxied connection after the
  // reason, from a host it knows only as UNKNOWN; alone, it is all there is to name.
  'jump host refused': ['ssh: connect to host 127.0.0.1 port 1: Connection refused\r\nConnection closed by UNKNOWN port 65535\r\n', 'ssh: connect to host 127.0.0.1 port 1: Connection refused'],
  'jump host with no name': ['ssh: Could not resolve hostname bastion.invalid: Name or service not known\r\nConnection closed by UNKNOWN port 65535\r\n', 'ssh: Could not resolve hostname bastion.invalid: Name or service not known'],
  // The jump host's own ssh gets none of OAK's options, so ssh's default asks whether to trust a key it has not
  // seen, and with no terminal to ask on, refuses it; a password it may not ask for (SSH_ASKPASS_REQUIRE=never)
  // fails each try.
  'jump host met for the first time': ['Host key verification failed.\r\nConnection closed by UNKNOWN port 65535\r\n', 'Host key verification failed.'],
  'jump host that asks for a password': ['Permission denied, please try again.\r\nPermission denied, please try again.\r\nuser@127.0.0.1: Permission denied (password).\r\nConnection closed by UNKNOWN port 65535\r\n', 'Permission denied, please try again. — user@127.0.0.1: Permission denied (password).'],
  'jump host whose key has changed': ["@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\r\nSomeone could be eavesdropping on you right now (man-in-the-middle attack)!\r\nIt is also possible that a host key has just been changed.\r\nThe fingerprint for the ED25519 key sent by the remote host is\nSHA256:RzRG9zaOgk/FAjwp0vjlf57thPNj0waWywr6AWhPzVQ.\r\nPlease contact your system administrator.\r\nAdd correct host key in /home/user/.ssh/known_hosts to get rid of this message.\r\nOffending ED25519 key in /home/user/.ssh/known_hosts:1\r\n  remove with:\r\n  ssh-keygen -f '/home/user/.ssh/known_hosts' -R '[127.0.0.1]:2222'\r\nHost key for [127.0.0.1]:2222 has changed and you have requested strict checking.\r\nHost key verification failed.\r\nConnection closed by UNKNOWN port 65535\r\n", 'Host key for [127.0.0.1]:2222 has changed and you have requested strict checking. — Host key verification failed.'],
  'ProxyCommand that fails': ['proxy: cannot reach the bastion\nConnection closed by UNKNOWN port 65535\r\n', 'proxy: cannot reach the bastion'],
  'ProxyCommand that says nothing': ['Connection closed by UNKNOWN port 65535\r\n', 'Connection closed by UNKNOWN port 65535'],
  'jump host that never answers': ['Connection timed out during banner exchange\r\nConnection to UNKNOWN port 65535 timed out\r\n', 'Connection timed out during banner exchange'],
  // A jump host that cannot open the connection to its target says why, after its banner, then that its
  // forwarding failed.
  'jump host reached, its target refusing': ['Authorized access only. All activity is logged.\nchannel 0: open failed: connect failed: Connection refused\r\nstdio forwarding failed\r\nConnection closed by UNKNOWN port 65535\r\n', 'Authorized access only. All activity is logged. — channel 0: open failed: connect failed: Connection refused'],
  'jump host reached, its target with no name': ['Authorized access only. All activity is logged.\nchannel 0: open failed: connect failed: Name or service not known\r\nstdio forwarding failed\r\nConnection closed by UNKNOWN port 65535\r\n', 'Authorized access only. All activity is logged. — channel 0: open failed: connect failed: Name or service not known'],
  'jump host that may not forward': ['channel 0: open failed: administratively prohibited: open failed\r\nstdio forwarding failed\r\nConnection closed by UNKNOWN port 65535\r\n', 'channel 0: open failed: administratively prohibited: open failed'],
  'verbose, jump host reached, its target refusing': ['Authorized access only. All activity is logged.\nchannel 0: open failed: connect failed: Connection refused\r\nstdio forwarding failed\r\nkex_exchange_identification: Connection closed by remote host\r\nConnection closed by UNKNOWN port 65535\r\n', 'Authorized access only. All activity is logged. — channel 0: open failed: connect failed: Connection refused'],
  // Through a jump host, the close of a login the target ended is that UNKNOWN close too, so what is named is
  // the banner, the jump host's and then its target's, shown once: it reads the same as a ProxyCommand's own
  // reason before the same close (above), and OAK cannot tell the two apart.
  'banners through a jump host, then a login the server closed': ['Authorized access only. All activity is logged.\nAuthorized access only. All activity is logged.\nConnection closed by UNKNOWN port 65535\r\n', 'Authorized access only. All activity is logged.'],
  // A server that disconnects says why, then ssh says it was disconnected.
  'too many keys offered': ["Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.\r\nAuthorized access only. All activity is logged.\nReceived disconnect from 127.0.0.1 port 2222:2: Too many authentication failures\r\nDisconnected from 127.0.0.1 port 2222\r\n", 'Authorized access only. All activity is logged. — Received disconnect from 127.0.0.1 port 2222:2: Too many authentication failures'],
  // One that resets or closes the connection is named by ssh's line that says so, after the line before it: a
  // read that failed, the server's banner (whose lines end as its file's do, \r\n here), a key ssh could not
  // load, or why PAM refused the login (pam_nologin while the server starts; LogLevel VERBOSE prints the same).
  // Through a jump host, the target's PAM refusal follows its banner, and its close is that UNKNOWN one; a
  // refusal by the jump host itself ends with the jump host's own close. LogLevel VERBOSE's note of the closed
  // identification exchange is never why.
  'reset at once': ['kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 127.0.0.1 port 2222\r\n', 'kex_exchange_identification: read: Connection reset by peer — Connection reset by 127.0.0.1 port 2222'],
  'banner, then a login the server closed': ["Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.\r\nAuthorized access only. All activity is logged.\nConnection closed by 127.0.0.1 port 2222\r\n", 'Authorized access only. All activity is logged. — Connection closed by 127.0.0.1 port 2222'],
  'banner with CRLF line ends, then a login the server closed': ['Authorized access only.\r\nAll activity is logged.\r\nConnection closed by 127.0.0.1 port 2222\r\n', 'All activity is logged. — Connection closed by 127.0.0.1 port 2222'],
  'a key ssh cannot load, then a login the server closed': ['Load key "/home/user/.ssh/id_broken": error in libcrypto\r\nConnection closed by 127.0.0.1 port 2222\r\n', 'Load key "/home/user/.ssh/id_broken": error in libcrypto — Connection closed by 127.0.0.1 port 2222'],
  'PAM refusing the login': ['Authorized access only. All activity is logged.\nSystem is booting up. Unprivileged users are not permitted to log in yet. Please come back later. For technical details, see pam_nologin(8).\n\nConnection closed by 127.0.0.1 port 2222\r\n', 'System is booting up. Unprivileged users are not permitted to log in yet. Please come back later. For technical details, see pam_nologin(8). — Connection closed by 127.0.0.1 port 2222'],
  'PAM refusing the login, through a jump host': ['Authorized access only. All activity is logged.\nAuthorized access only. All activity is logged.\nSystem is booting up. Unprivileged users are not permitted to log in yet. Please come back later. For technical details, see pam_nologin(8).\n\nConnection closed by UNKNOWN port 65535\r\n', 'Authorized access only. All activity is logged. — System is booting up. Unprivileged users are not permitted to log in yet. Please come back later. For technical details, see pam_nologin(8).'],
  'jump host whose PAM refuses the login': ['Authorized access only. All activity is logged.\nSystem is booting up. Unprivileged users are not permitted to log in yet. Please come back later. For technical details, see pam_nologin(8).\n\nConnection closed by 127.0.0.1 port 2222\r\nConnection closed by UNKNOWN port 65535\r\n', 'System is booting up. Unprivileged users are not permitted to log in yet. Please come back later. For technical details, see pam_nologin(8). — Connection closed by 127.0.0.1 port 2222'],
  'verbose, closed before the identification exchange': ['kex_exchange_identification: Connection closed by remote host\r\nConnection closed by 127.0.0.1 port 2222\r\n', 'Connection closed by 127.0.0.1 port 2222'],
  // LogLevel VERBOSE in the person's ssh_config: ssh notes the login that succeeded, and ends with the bytes it
  // moved; neither is why.
  'verbose, session killed': ['Authenticated to 127.0.0.1 ([127.0.0.1]:2222) using "publickey".\r\nConnection to 127.0.0.1 closed by remote host.\r\nTransferred: sent 3516, received 3560 bytes, in 0.0 seconds\r\nBytes per second: sent 73507.5, received 74427.4\r\n', 'Connection to 127.0.0.1 closed by remote host.'],
  'verbose, a remote that wrote a line and exited 255': ['Authenticated to 127.0.0.1 ([127.0.0.1]:2222) using "publickey".\r\noak: a remote error\nTransferred: sent 3520, received 3716 bytes, in 0.0 seconds\r\nBytes per second: sent 72984.6, received 77048.5\r\n', 'oak: a remote error'],
  // RequestTTY yes in the person's ssh_config, with no terminal on stdin (`oak machine add`): ssh says first
  // that it allocates none, which is never why.
  'a terminal asked for, then refused': ['Pseudo-terminal will not be allocated because stdin is not a terminal.\r\nssh: connect to host 127.0.0.1 port 1: Connection refused\r\n', 'ssh: connect to host 127.0.0.1 port 1: Connection refused'],
  'a terminal asked for, then a refused login': ['Pseudo-terminal will not be allocated because stdin is not a terminal.\r\nuser@127.0.0.1: Permission denied (publickey).\r\n', 'user@127.0.0.1: Permission denied (publickey).'],
  // scp (`oak machine add`) adds its own line after ssh's, and after one that says why a file was not written.
  'scp, first contact, then a refused login': ["Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.\r\nuser@127.0.0.1: Permission denied (publickey).\r\nscp: Connection closed\r\n", 'user@127.0.0.1: Permission denied (publickey).'],
  'scp, older protocol, refused': ['ssh: connect to host 127.0.0.1 port 1: Connection refused\r\nlost connection\n', 'ssh: connect to host 127.0.0.1 port 1: Connection refused'],
  'scp, a file it cannot write': ['scp: dest open ".local/lib/oak/cli.js": Permission denied\r\nscp: failed to upload file src.txt to .local/lib/oak/cli.js\r\n', 'scp: dest open ".local/lib/oak/cli.js": Permission denied'],
  // scp names itself in its lines as it was run: here by a wrapper that ran it by its path.
  'scp run by its path, a file it cannot write': ['/usr/bin/scp: dest open ".local/lib/oak/cli.js": Permission denied\r\n/usr/bin/scp: failed to upload file src.txt to .local/lib/oak/cli.js\r\n', '/usr/bin/scp: dest open ".local/lib/oak/cli.js": Permission denied'],
};

test('CLI ssh: a connection that fails is named by the lines where ssh says why', () => {
  const module = { exports: {} };
  const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { sshReason };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, require, process: { env: {}, stdout: { isTTY: false }, stderr: { write() {} }, platform: 'linux' } });
  for (const [name, [stderr, reason]] of Object.entries(sshCaptured)) assert.equal(module.exports.sshReason(stderr), reason, name);
  // The rows of `@` that frame a warning are never named, even with nothing after them.
  assert.equal(module.exports.sshReason('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n'), '');
});

test('CLI machine add: a host it cannot reach, or a copy that fails there, is named by the lines where ssh says why', { skip: process.platform === 'win32' && 'POSIX fake tools' }, t => {
  // It named the first line ssh wrote: a row of `@` for a changed host key, and the key accept-new had just
  // recorded for a first contact whose login then failed.
  const b = fixture(t);
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  b.env.MACHINE_ADD_LOG = path.join(b.home, 'machine-add.log');
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-add-tool-stub.sh'));
  for (const name of ['ssh', 'scp', 'herdr']) { fs.writeFileSync(path.join(bin, name), stub); fs.chmodSync(path.join(bin, name), 0o755); }
  const add = (env) => run({ home: b.home, env: { ...b.env, ...env } }, process.execPath, [cli, 'machine', 'add', 'testlbl', 'testtgt']);
  for (const name of ['changed host key', 'first contact, then a refused login', 'jump host reached, its target refusing', 'banner, then a login the server closed', 'PAM refusing the login']) {
    const [stderr, reason] = sshCaptured[name];
    const r = add({ SSH_FAKE_EXIT: '255', SSH_FAKE_STDERR: stderr });
    assert.deepEqual([r.status, r.stderr], [1, `oak: could not reach testtgt: ${reason}\n`], name);
  }
  // Reached, then the first copy of OAK's own files fails.
  const [stderr, reason] = sshCaptured['scp, first contact, then a refused login'];
  const r = add({ SCP_FAKE_EXIT: '255', SCP_FAKE_STDERR: stderr });
  assert.deepEqual([r.status, r.stderr], [1, `oak: could not copy oak/cli.js to testtgt: ${reason}\n`]);
});

test('CLI --machine: search reads the saved machine\'s conversations there, not this machine\'s', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const talk = (config, id, answer) => {
    const work = path.join(path.dirname(config), 'work');
    const project = path.join(config, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${id}.jsonl`), [
      { type: 'user', cwd: work, sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: 'tidy the parser' } },
      { type: 'assistant', cwd: work, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: answer }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  talk(path.join(f.b.env.FAKE_REMOTE_HOME, '.claude'), 'remote-talk', 'The quokka column is parsed now.');
  talk(f.b.env.CLAUDE_CONFIG_DIR, 'local-talk', 'The quokka column is parsed here too.');
  // `--query=`: the picker's form, so a query that starts with a dash stays the query.
  const r = onMachine(f, ['search', '--json', '--query=quokka']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).hits.map((h) => h.session), ['remote-talk']);
  assert.equal(f.sshCalls().length, 1);
  assert.ok(f.sshCalls()[0].join('\n').endsWith("oak 'search' '--json' '--query=quokka'"));
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

test('CLI sessions --json --machine: a machine whose record log oak sync keeps current here is listed from the local index, saying how fresh; one oak sync last reached longer ago is asked over ssh', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const remote = f.b.env.FAKE_REMOTE_HOME;
  // A session on the remote, three hours idle, and the record log its index publishes.
  const at = new Date(Date.now() - 3 * 3600_000);
  const transcript = path.join(remote, '.claude', 'projects', '-build-p', 'r1.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    { type: 'user', timestamp: at.toISOString(), cwd: '/build/p', sessionId: 'r1', message: { role: 'user', content: 'tidy the build' } },
    { type: 'assistant', timestamp: at.toISOString(), cwd: '/build/p', sessionId: 'r1', message: { id: 'msg-r1', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 1 } } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.utimesSync(transcript, at, at);
  assert.equal(f.onRemote(['__index-build']).status, 0);
  const records = path.join(remote, '.claude', 'claude-observatory', 'records');
  const [host] = fs.readdirSync(records).filter((n) => /^[0-9a-f]{12}$/.test(n)); // beside it, blobs/ keeps OAK 0.10's clean off the folder
  // oak sync brought that log here, and its last run reached build-box `ago` ms ago.
  const store = path.join(f.b.env.CLAUDE_CONFIG_DIR, 'claude-observatory');
  fs.cpSync(path.join(records, host), path.join(store, 'records', host), { recursive: true });
  const reached = (ago) => {
    fs.mkdirSync(path.join(store, 'sync', 'index'), { recursive: true });
    fs.writeFileSync(path.join(store, 'sync', 'status.json'), JSON.stringify({ at: Date.now() - ago, durationMs: 1, status: 'ok', warnings: [],
      machines: [{ label: 'build-box', host, status: 'ok', pulled: { files: 1, bytes: 1 }, conflicts: 0, pending: { files: 0, bytes: 0 }, errors: [], lastOkAt: Date.now() - ago }] }));
    // …and kept what it saw of that machine's files, as each run does: its transcript, three hours idle.
    fs.writeFileSync(path.join(store, 'sync', 'index', `${host}.json`), JSON.stringify({ label: 'build-box', savedAt: Date.now() - ago,
      inventory: { inventory: 1, at: Date.now() - ago, host, families: { transcripts: [{ name: '-build-p/r1.jsonl', size: 1, mtime: at.getTime() }] } } }));
  };
  reached(60_000);
  assert.equal(run(f.b, process.execPath, [cli, '__index-build']).status, 0);
  const fresh = onMachine(f, ['sessions', '--json']);
  assert.equal(fresh.status, 0, fresh.stderr);
  const listed = JSON.parse(fresh.stdout);
  assert.deepEqual([listed.fromIndex, listed.host, listed.sessions.map((s) => [s.id, s.title, s.workspace])], [true, host, [['r1', 'tidy the build', '/build/p']]]);
  assert.ok(Math.abs(listed.syncedAt - (Date.now() - 60_000)) < 10_000, 'as of the oak sync run that read it');
  assert.equal(typeof listed.publishedAt, 'number', 'and when that machine last published');
  assert.equal(f.sshCalls().length, 0, 'no ssh');
  // A read that names a root or a session (the terminal app's) takes the machine's own answer, with its live state.
  const rooted = onMachine(f, ['sessions', '--json', '--root', '/build/p']);
  assert.equal(rooted.status, 0, rooted.stderr);
  assert.equal(JSON.parse(rooted.stdout).fromIndex, undefined);
  assert.equal(f.sshCalls().length, 1, 'over ssh');
  // Two of oak sync's runs ago and more: the machine itself answers, over ssh.
  reached(11 * 60_000);
  const stale = onMachine(f, ['sessions', '--json']);
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(f.sshCalls().length, 2);
  assert.ok(f.sshCalls()[1].join('\n').endsWith("oak 'sessions' '--json'"));
  const answered = JSON.parse(stale.stdout);
  assert.equal(answered.fromIndex, undefined, 'the machine\'s own listing');
  assert.deepEqual(answered.sessions.map((s) => s.id), ['r1']);
});

/** Saved machines for `usage --pull-machines`: one home per ssh target under FAKE_REMOTE_ROOT, each with this
 *  build as its oak, a Claude login and a status-line cache; this machine logs in as `acct-1`. */
function usageMachinesFixture(t, machines) {
  const f = machineFixture(t);
  const root = path.join(f.b.home, 'remotes');
  f.b.env.FAKE_REMOTE_ROOT = root;
  f.b.env.MACHINE_EXEC_MACHINES = JSON.stringify(machines.map((m, i) => ({ id: `m${i}`, label: m.label, target: m.target ?? `me@${m.label}`, session: 'default', enabled: m.enabled ?? true, selected: false })));
  const nowS = Math.floor(Date.now() / 1000);
  // A Claude config dir: its login and its cache, with both shares measured `ago` seconds ago inside their windows.
  const claude = (cfg, json, account, pct, ago) => {
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(json, JSON.stringify({ oauthAccount: { accountUuid: account } }));
    fs.writeFileSync(path.join(cfg, 'statusline-last.json'), JSON.stringify({ v: 3, five_pct: pct, five_at: nowS - ago, five_reset: nowS + 3 * 3600,
      week_pct: pct + 20, week_at: nowS - ago, week_reset: nowS + 2 * 86400 }));
  };
  const remote = (host, account, pct, ago) => {
    const home = path.join(root, host);
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'oak'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
    claude(path.join(home, '.claude'), path.join(home, '.claude.json'), account, pct, ago);
  };
  const local = (pct, ago) => claude(f.b.env.CLAUDE_CONFIG_DIR, path.join(f.b.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'acct-1', pct, ago);
  const pull = () => run(f.b, process.execPath, [cli, 'usage', '--pull-machines']);
  const usage = () => {
    const r = run(f.b, process.execPath, [cli, 'usage', '--json']);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { ...f, root, remote, local, pull, usage };
}

test('CLI usage --pull-machines: where this machine has no current Claude share, a saved machine\'s reading of the same account is shown and named', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = usageMachinesFixture(t, [{ label: 'build-box' }, { label: 'other-box' }, { label: 'off-box', enabled: false }, { label: 'build-box-2', target: 'me@build-box' }]);
  f.remote('build-box', 'acct-1', 1, 60);
  f.remote('other-box', 'acct-2', 50, 10); // fresher, but another account
  f.remote('off-box', 'acct-1', 60, 5); // the freshest, but disabled in herdr
  f.local(40, 10 * 86400); // this machine's shares are ten days old: last week's
  const before = f.usage();
  assert.deepEqual([before.claudeFivePct, before.claudeWeekPct, before.claudeMachineNote], [null, null, ''], 'control: nothing current here');
  f.b.env.MACHINE_EXEC_ENV = path.join(f.b.home, 'ssh-env.log'); // the names of this machine's settings each ssh would carry
  const pulled = f.pull();
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(pulled.stdout + pulled.stderr, '', 'a background refresh prints nothing');
  const u = f.usage();
  assert.deepEqual([u.claudeFivePct, u.claudeWeekPct, u.claudeMachineNote, u.claudeMachineBarNote, u.claudeMachineUnmatched], [1, 21, 'build-box', 'build-box', false]);
  assert.deepEqual([u.claudeAccount.fiveMachine, u.claudeAccount.weekMachine], ['build-box', 'build-box']);
  // …with when that machine measured it, for the editors to say (never this machine's cache time).
  const measuredThere = JSON.parse(fs.readFileSync(path.join(f.root, 'build-box', '.claude', 'statusline-last.json'), 'utf8')).week_at * 1000;
  assert.deepEqual([u.claudeMachineAt, u.claudeAccount.machineAt], [measuredThere, measuredThere]);
  // Each enabled target is asked once (two labels share one), over OAK's own ssh, for its usage records alone.
  const calls = f.sshCalls();
  assert.deepEqual(calls.map((c) => c[c.length - 2]).sort(), ['me@build-box', 'me@other-box']);
  assert.deepEqual(calls[0].slice(0, 7), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new']);
  assert.equal(calls[0].at(-1), 'env PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1 oak __usage-records --json');
  assert.equal(fs.readFileSync(f.b.env.MACHINE_EXEC_ENV, 'utf8'), '', 'no ssh carries this machine\'s store or agent identity');
  delete f.b.env.MACHINE_EXEC_ENV;
  // Kicked again within five minutes, the detached refresh asks nothing.
  assert.equal(run(f.b, process.execPath, [cli, 'usage', '--pull-machines', '--if-due']).status, 0);
  assert.equal(f.sshCalls().length, calls.length, 'within five minutes a kicked refresh asks nothing');

  // Unreachable: the refresh says nothing and the machine's last reading stands; the cache records why.
  f.remote('build-box', 'acct-1', 9, 30);
  f.b.env.SSH_FAKE_DOWN = 'me@build-box';
  f.b.env.SSH_FAKE_STDERR = 'ssh: connect to host build-box port 22: Connection refused';
  const down = f.pull();
  assert.equal(down.stdout + down.stderr, '', 'no error noise');
  assert.deepEqual([f.usage().claudeFivePct, f.usage().claudeMachineNote], [1, 'build-box']);
  const outcome = (label) => JSON.parse(fs.readFileSync(path.join(f.b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'remote-cache', 'machine-usage.json'), 'utf8')).outcomes.find((o) => o.label === label);
  assert.deepEqual([outcome('build-box').status, outcome('build-box').detail], ['unreachable', 'ssh: connect to host build-box port 22: Connection refused']);
  delete f.b.env.SSH_FAKE_DOWN;
  f.pull();
  assert.equal(f.usage().claudeFivePct, 9, 'control: reachable again, its new reading lands');

  // An older reading there than this machine's own: this machine's stands, unnamed. (Each reading a machine took is kept,
  // and the freshest counts: this one is later than its last, as a machine's readings are.)
  f.local(7, 10);
  f.remote('build-box', 'acct-1', 3, 20);
  f.pull();
  assert.deepEqual([f.usage().claudeFivePct, f.usage().claudeMachineNote], [7, '']);

  // An OAK there from before `__usage-brief` prints something else, which is no reading.
  f.local(40, 10 * 86400);
  fs.copyFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'), path.join(f.root, 'build-box', '.local', 'bin', 'oak'));
  f.pull();
  assert.equal(f.usage().claudeFivePct, 3, 'the last reading stands');
  // A machine no longer saved is no longer read.
  f.b.env.MACHINE_EXEC_MACHINES = JSON.stringify([{ id: 'm1', label: 'other-box', target: 'me@other-box', session: 'default', enabled: true, selected: false }]);
  f.pull();
  assert.deepEqual([f.usage().claudeFivePct, f.usage().claudeMachineNote], [null, '']);
  // With no Claude Code login here there is no account to match: the one account the saved machines name stands in,
  // and the JSON says it was not matched.
  fs.writeFileSync(path.join(f.b.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ numStartups: 1 }));
  const unmatched = f.usage();
  assert.deepEqual([unmatched.claudeFivePct, unmatched.claudeMachineNote, unmatched.claudeMachineUnmatched], [50, 'other-box', true]);
});

test('CLI usage --pull-machines: what a saved machine measured of its own usage reaches `oak usage --json`, named in the key the JetBrains widget reads', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  // The JetBrains status widget reads top-level keys alone, so `claudeMeasuredMachines` is its only source for naming the
  // machines whose usage the estimates include; a renamed key would leave its tooltip silently without them.
  const f = usageMachinesFixture(t, [{ label: 'build-box' }]);
  f.remote('build-box', 'acct-1', 1, 60);
  f.local(7, 60); // this machine's own shares are current: they are shown, and the saved machine's usage is added
  // The saved machine's own turns in this 5-hour window, which its usage pull answer carries, each message once.
  const project = path.join(f.root, 'build-box', '.claude', 'projects', '-build-p');
  fs.mkdirSync(project, { recursive: true });
  const at = new Date(Date.now() - 600_000).toISOString();
  fs.writeFileSync(path.join(project, 'b1.jsonl'), [
    { type: 'user', timestamp: at, cwd: '/build/p', sessionId: 'b1', message: { role: 'user', content: 'build' } },
    { type: 'assistant', timestamp: at, cwd: '/build/p', sessionId: 'b1', message: { id: 'msg-b1', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 3_900_000, output_tokens: 20_000 } } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  assert.deepEqual([f.usage().claudeMeasuredMachines, f.usage().claudeAccount.machineMeasured], ['', null], 'control: nothing read yet');
  assert.equal(f.pull().status, 0);
  const u = f.usage();
  assert.deepEqual([u.claudeMeasuredMachines, u.claudeAccount.machineMeasured.machines, u.claudeAccount.machineMeasured.five.tok, u.claudeMachineNote],
    ['build-box', 'build-box', 3920000, ''], 'its own usage is added and named, while the shares shown stay this machine\'s');
  assert.equal(u.usageTotals.five.tokens, 3920000, 'and the account\'s 5-hour window counts it');
});

test('CLI usage --json: reads saved machines\' usage from the cache alone, and kicks the refresh detached', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = usageMachinesFixture(t, [{ label: 'build-box' }]);
  f.remote('build-box', 'acct-1', 1, 60);
  f.local(40, 10 * 86400);
  // An ssh that would hang for a minute: a read that waited on it would time out here.
  fs.writeFileSync(path.join(f.b.home, 'bin', 'ssh'), '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const log = path.join(f.b.home, 'spawns.jsonl');
  const recorder = path.join(root, 'packages/tui/test/fixtures/spawn-recorder.cjs');
  const env = { ...f.b.env, OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: '' };
  // What another machine reads here starts nothing: no account pull, month scan or refresh of its own, although
  // the refresh is due (the poll below is the control: in this same state it kicks it).
  const brief = run({ ...f.b, env }, process.execPath, ['--require', recorder, cli, '__usage-brief', '--json']);
  assert.equal(brief.status, 0, brief.stderr);
  assert.equal(JSON.parse(brief.stdout).brief, 1);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'oak __usage-brief starts no process');
  const started = Date.now();
  const r = run({ ...f.b, env }, process.execPath, ['--require', recorder, cli, 'usage', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 10_000, 'answered without waiting on ssh');
  const spawns = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(spawns.filter((s) => s.file === 'ssh'), [], 'no ssh in the read');
  assert.ok(spawns.some((s) => s.detached && s.args.slice(1).join(' ') === 'usage --pull-machines --if-due'), 'the refresh is kicked, detached');
});

test('CLI usage: the saved machines\' refresh, its herdr call and each ssh ask for no window on Windows', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  // The refresh runs detached, with no console: on Windows a console program it starts without windowsHide would
  // open a console window of its own, for every machine, every five minutes. The options are recorded here, since
  // only Windows would show the window.
  const f = usageMachinesFixture(t, [{ label: 'build-box' }]);
  f.remote('build-box', 'acct-1', 1, 60);
  f.local(40, 10 * 86400);
  const log = path.join(f.b.home, 'spawns.jsonl');
  const recorder = path.join(root, 'packages/tui/test/fixtures/spawn-recorder.cjs');
  const env = { ...f.b.env, OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: '' };
  const spawns = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const kicked = run({ ...f.b, env }, process.execPath, ['--require', recorder, cli, 'usage', '--json']);
  assert.equal(kicked.status, 0, kicked.stderr);
  assert.deepEqual(spawns().filter((s) => s.args.includes('--pull-machines')).map((s) => [s.detached, s.windowsHide]), [[true, true]], 'the kick');
  fs.rmSync(log);
  const pulled = run({ ...f.b, env }, process.execPath, ['--require', recorder, cli, 'usage', '--pull-machines']);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(f.usage().claudeMachineNote, 'build-box', 'control: the recorded refresh read the machine');
  const started = spawns().map((s) => [path.basename(s.file), s.args.join(' '), s.windowsHide]);
  assert.deepEqual(started.filter(([file]) => file === 'herdr' || file === 'ssh').map(([file, args, hide]) => [file, file === 'ssh' ? args.split(' ').at(-1) : args, hide]),
    [['herdr', 'machine list --json', true], ['ssh', '--json', true]], `herdr's machine list and the machine's ssh: ${JSON.stringify(started)}`);
});

test('CLI usage: with "machineUsage": false in prefs.json, no refresh is kicked or run and no saved machine\'s reading is shown', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = usageMachinesFixture(t, [{ label: 'build-box' }]);
  f.remote('build-box', 'acct-1', 1, 60);
  f.local(40, 10 * 86400);
  assert.equal(f.pull().status, 0);
  assert.equal(f.usage().claudeMachineNote, 'build-box', 'control: on, the saved machine\'s reading is shown');
  const store = path.join(f.b.env.CLAUDE_CONFIG_DIR, 'claude-observatory');
  const prefs = path.join(store, 'prefs.json');
  const cachePath = path.join(store, 'remote-cache', 'machine-usage.json');
  const log = path.join(f.b.home, 'spawns.jsonl');
  const recorder = path.join(root, 'packages/tui/test/fixtures/spawn-recorder.cjs');
  // `oak usage --json` as a poller runs it, with a refresh due: the kicks it starts.
  const poll = () => {
    fs.rmSync(log, { force: true });
    fs.rmSync(`${cachePath}.kick`, { force: true });
    fs.writeFileSync(cachePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cachePath, 'utf8')), attemptedAt: 0 }));
    const r = run({ ...f.b, env: { ...f.b.env, OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: '' } }, process.execPath, ['--require', recorder, cli, 'usage', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const kicks = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s) => s.args.includes('--pull-machines')) : [];
    return { u: JSON.parse(r.stdout), kicks: kicks.length };
  };
  fs.writeFileSync(prefs, JSON.stringify({ machineUsage: false }));
  const off = poll();
  assert.deepEqual([off.u.claudeFivePct, off.u.claudeMachineNote, off.u.claudeMachineAt], [null, '', null], 'off: the cached reading is not shown');
  assert.equal(off.kicks, 0, 'off: no refresh is kicked');
  const before = f.log();
  assert.equal(f.pull().status, 0);
  assert.equal(f.log(), before, 'off: `oak usage --pull-machines` calls neither herdr nor ssh');
  // Control: on again, the same poll kicks one, and the refresh reaches herdr and ssh.
  fs.writeFileSync(prefs, '{}');
  const on = poll();
  assert.deepEqual([on.u.claudeMachineNote, on.kicks], ['build-box', 1]);
  assert.equal(f.pull().status, 0);
  assert.notEqual(f.log(), before);
});

/** The pids a fake ssh appended to `file`, oldest first; none before it has. */
const pidsIn = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').map(Number).filter((pid) => pid > 0); } catch { return []; } };
/** The last of them, or 0 (never passed to a kill: pid 0 signals this whole process group). */
const pidIn = (file) => pidsIn(file).at(-1) ?? 0;
const killPids = (file) => { for (const pid of pidsIn(file)) try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } };
/** Where a fake ssh appends its pids: outside the fixture's home, which goes first, so each is stopped after the test. */
function stallFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-stall-'));
  t.after(() => { killPids(path.join(dir, 'pids')); fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, 'pids');
}

/** `bin/ssh` as `pre` (shell, given ssh's arguments), then the stub's ssh. */
function sshAhead(f, pre) {
  const stub = path.join(f.b.home, 'stub', 'ssh');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'), stub);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(path.join(f.b.home, 'bin', 'ssh'), `#!/bin/sh\n${pre}\nexec "${stub}" "$@"\n`, { mode: 0o755 });
}

test('CLI usage --pull-machines: each machine\'s ssh asks nothing, waits on no other machine, and ends at its own deadline', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = usageMachinesFixture(t, [{ label: 'box-a' }, { label: 'box-b' }, { label: 'stall-box' }, { label: 'flood-box' }]);
  for (const box of ['box-a', 'box-b', 'flood-box']) f.remote(box, 'acct-1', 1, 60);
  // flood-box runs an OAK from before the usage pull, which refuses `__usage-records`, and prints 70 KB before its brief:
  // past the 64 KB a brief may take, it is no answer.
  fs.writeFileSync(path.join(f.root, 'flood-box', '.local', 'bin', 'oak'), `#!/bin/sh\n[ "$1" = __usage-records ] && { echo 'oak: unknown command "__usage-records"' >&2; exit 1; }\nprintf '%70000s' ''\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
  // ssh's look-up of a target's configuration (`ssh -G`, which runs its Match exec commands) takes 3 s, and
  // stall-box's server sends its banner and then nothing, where ssh has no timeout of its own.
  const stalled = stallFile(t);
  sshAhead(f, `if [ "$1" = -G ]; then sleep 3; else for a in "$@"; do [ "$a" = me@stall-box ] && { echo $$ >> '${stalled}'; exec sleep 60; }; done; fi`);
  f.b.env.SSH_ASKPASS_REQUIRE = 'force';
  f.b.env.SSH_ASKPASS_LOG = path.join(f.b.home, 'askpass.log');
  const started = Date.now();
  // A machine's 30-second deadline passes in 1.5 s here (short-usage-ask.cjs).
  const pulled = run(f.b, process.execPath, ['--require', path.join(__dirname, 'fixtures/short-usage-ask.cjs'), cli, 'usage', '--pull-machines']);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.ok(Date.now() - started < 8000, `the machines are asked side by side, each within its own deadline (${Date.now() - started} ms)`);
  assert.ok(pidIn(stalled) > 0, 'control: stall-box\'s ssh ran');
  assert.throws(() => process.kill(pidIn(stalled), 0), { code: 'ESRCH' }, 'the stalled ssh is stopped at its deadline');
  const cache = JSON.parse(fs.readFileSync(path.join(f.b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'remote-cache', 'machine-usage.json'), 'utf8'));
  assert.deepEqual(cache.machines.map((e) => e.label).sort(), ['box-a', 'box-b'], 'flood-box\'s answer was too long to be one');
  assert.ok(Date.now() - cache.attemptedAt < 60_000, 'the refresh finished, so the next one waits five minutes');
  const asked = fs.readFileSync(f.b.env.SSH_ASKPASS_LOG, 'utf8').trim().split('\n');
  assert.ok(asked.length >= 3 && asked.every((l) => / never$/.test(l)), `no ssh asks in a dialog: ${asked.join(', ')}`);
});

test('CLI usage --pull-machines: a refresh ended by a signal stops its ssh', { skip: process.platform === 'win32' && 'POSIX signals' }, async t => {
  const f = usageMachinesFixture(t, [{ label: 'stall-box' }]);
  const stalled = stallFile(t);
  sshAhead(f, `[ "$1" = -G ] || for a in "$@"; do [ "$a" = me@stall-box ] && { echo $$ >> '${stalled}'; exec sleep 60; }; done`);
  const sshPid = () => pidIn(stalled);
  const refresh = cp.spawn(process.execPath, [cli, 'usage', '--pull-machines'], { env: f.b.env, stdio: 'ignore' });
  const ended = new Promise((resolve) => refresh.on('exit', (_code, signal) => resolve(signal)));
  for (let i = 0; i < 200 && !sshPid(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(sshPid(), 'control: the refresh started its ssh');
  refresh.kill('SIGTERM');
  assert.equal(await ended, 'SIGTERM');
  let alive = true;
  for (let i = 0; i < 60 && alive; i++) {
    try { process.kill(sshPid(), 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'its ssh ended with it');
});

test('CLI usage --pull-machines: an OAK there from before the brief runs nothing of its own', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = usageMachinesFixture(t, [{ label: 'build-box' }]);
  f.remote('build-box', 'acct-1', 1, 60);
  // Such a build ignores a flag it does not know, so `oak usage --brief` ran its whole usage read there, which
  // starts that machine's account-usage and title reads; a verb it does not know it refuses.
  const ran = path.join(f.root, 'build-box', 'ran');
  fs.writeFileSync(path.join(f.root, 'build-box', '.local', 'bin', 'oak'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ran}'\n` +
    `[ "$1" = usage ] && { printf '{"fiveHourPct":5}\\n'; exit 0; }\nprintf 'oak: unknown command "%s"\\n' "$1" >&2; exit 1\n`, { mode: 0o755 });
  assert.equal(f.pull().status, 0);
  assert.ok(fs.existsSync(ran), 'control: the refresh reached that oak');
  assert.deepEqual(fs.readFileSync(ran, 'utf8').trim().split('\n').filter((l) => /^usage\b/.test(l)), [], 'no `oak usage` ran there');
  assert.equal(f.usage().claudeMachineNote, '', 'and it supplied no reading');
});

test('CLI usage --pull-machines: a machine that gives no reading says why, in the cache and in oak doctor', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = usageMachinesFixture(t, ['good-box', 'old-box', 'chatty-box', 'down-box', 'bare-box', 'odd-box'].map((label) => ({ label })));
  for (const box of ['good-box', 'old-box', 'chatty-box', 'odd-box']) f.remote(box, 'acct-1', 1, 60);
  fs.mkdirSync(path.join(f.root, 'bare-box'), { recursive: true }); // no oak there
  f.local(40, 10 * 86400);
  const oak = (box, body) => fs.writeFileSync(path.join(f.root, box, '.local', 'bin', 'oak'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // An OAK from before the verb refuses it as every release refuses a verb it does not know (0.10.0's words).
  oak('old-box', `printf 'oak: unknown command "%s". Run \`oak help\`.\\n' "$1" >&2; exit 1`);
  // A shell startup file there that prints before OAK answers.
  oak('chatty-box', `echo 'Welcome to chatty-box'; exec "${process.execPath}" "${cli}" "$@"`);
  // A failure there, in colour, with a bidi override and a bell, and more lines than the one kept.
  oak('odd-box', `printf '\\033[31moak: the store is locked\\033[0m\\342\\200\\256\\a\\nat a second line\\n' >&2; exit 3`);
  f.b.env.SSH_FAKE_DOWN = 'me@down-box';
  f.b.env.SSH_FAKE_STDERR = 'ssh: connect to host down-box port 22: Connection refused';
  const pulled = f.pull();
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(pulled.stdout + pulled.stderr, '', 'the background refresh still prints nothing');
  const cache = JSON.parse(fs.readFileSync(path.join(f.b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'remote-cache', 'machine-usage.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(cache.outcomes.map((o) => [o.label, [o.status, o.detail ?? '']])), {
    'good-box': ['ok', ''], 'old-box': ['old-oak', ''], 'chatty-box': ['not-reading', ''],
    'down-box': ['unreachable', 'ssh: connect to host down-box port 22: Connection refused'], 'bare-box': ['no-oak', ''],
    'odd-box': ['failed', 'oak: the store is locked'],
  });
  assert.ok(!JSON.stringify(cache).includes('Welcome') && !JSON.stringify(cache).includes('second line'), 'no more of what a machine printed is kept');
  assert.equal(f.usage().claudeMachineNote, 'good-box', 'control: the machine that answered supplies the reading');
  // `oak doctor` names each machine's outcome from the cache, with what to do.
  const d = run({ ...f.b, env: { ...f.b.env, SHELL: '/bin/sh' } }, process.execPath, [cli, 'doctor', '--json']);
  assert.equal(d.status, 0, d.stderr);
  const rows = Object.fromEntries(JSON.parse(d.stdout).checks.filter((c) => c.id.startsWith('machine-usage:')).map((c) => [c.label, c]));
  assert.deepEqual(Object.keys(rows).sort(), ['bare-box', 'chatty-box', 'down-box', 'good-box', 'odd-box', 'old-box'].map((b) => `Claude usage from ${b}`));
  assert.equal(rows['Claude usage from good-box'].level, 'ok');
  for (const [box, fix] of [['old-box', /^Update OAK on old-box: /], ['chatty-box', /^Make the shell startup files on chatty-box print nothing/],
    ['down-box', /`ssh me@down-box` connects/], ['bare-box', /^`oak machine add bare-box me@bare-box`/], ['odd-box', /^Run `oak doctor` on odd-box/]]) {
    assert.equal(rows[`Claude usage from ${box}`].level, 'warn', box);
    assert.match(rows[`Claude usage from ${box}`].fix, fix, box);
  }
  assert.match(rows['Claude usage from odd-box'].detail, /: oak: the store is locked$/);
});

test('CLI usage --pull-machines: an ssh that leaves a process holding its output gives its answer when it ends', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  // A LocalCommand in the person's ssh_config can leave a process that inherits ssh's stdout and outlives it: the
  // pipe stayed open, so the refresh waited for its 30-second deadline and then dropped the answer ssh had written.
  const f = usageMachinesFixture(t, [{ label: 'build-box' }]);
  f.remote('build-box', 'acct-1', 1, 60);
  f.local(40, 10 * 86400);
  const held = stallFile(t);
  sshAhead(f, `[ "$1" = -G ] || { sh -c 'echo $$ >> "${held}"; exec sleep 60' & }`);
  const started = Date.now();
  const pulled = run(f.b, process.execPath, [cli, 'usage', '--pull-machines'], { timeout: 45000 });
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.ok(pidIn(held) > 0, 'control: a process held the output');
  assert.doesNotThrow(() => process.kill(pidIn(held), 0), 'control: …and still holds it');
  assert.ok(Date.now() - started < 10_000, `read once ssh ended, not at the deadline (${Date.now() - started} ms)`);
  assert.deepEqual([f.usage().claudeFivePct, f.usage().claudeMachineNote], [1, 'build-box'], 'and the answer is the reading');
});

test('CLI usage --pull-machines: a saved machine whose clock is ten minutes fast is shown, dated by this machine\'s clock', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  // Its stamps ran ten minutes ahead, past the five minutes a reading may be ahead and still be dated: a fresh
  // reading was not shown until it was minutes old.
  const f = usageMachinesFixture(t, [{ label: 'fast-box' }]);
  f.remote('fast-box', 'acct-1', 1, 60);
  const home = path.join(f.root, 'fast-box');
  const skew = 10 * 60_000;
  const nowS = Math.floor(Date.now() / 1000);
  // That machine's own cache, stamped by its clock: measured a minute ago, real time.
  fs.writeFileSync(path.join(home, '.claude', 'statusline-last.json'), JSON.stringify({ v: 3, five_pct: 1, five_at: nowS - 60 + skew / 1000, five_reset: nowS + 3 * 3600,
    week_pct: 21, week_at: nowS - 60 + skew / 1000, week_reset: nowS + 2 * 86400 }));
  const clock = path.join(home, 'clock.cjs');
  fs.writeFileSync(clock, `const now = Date.now; Date.now = () => now() + ${skew};\n`);
  fs.writeFileSync(path.join(home, '.local', 'bin', 'oak'), `#!/bin/sh\nexec "${process.execPath}" --require "${clock}" "${cli}" "$@"\n`, { mode: 0o755 });
  f.local(40, 10 * 86400);
  assert.equal(f.pull().status, 0);
  const u = f.usage();
  assert.deepEqual([u.claudeFivePct, u.claudeWeekPct, u.claudeMachineNote], [1, 21, 'fast-box']);
  assert.ok(Math.abs(u.claudeMachineAt - (nowS - 60) * 1000) < 10_000, `measured a minute ago by this machine's clock, not nine minutes ahead (${(u.claudeMachineAt - Date.now()) / 1000} s from now)`);
});

test('CLI --machine: an unreachable machine, a missing oak and an unknown label are each named', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  f.b.env.SSH_FAKE_EXIT = '255';
  f.b.env.SSH_FAKE_STDERR = 'ssh: connect to host build-box.example port 22: Connection refused';
  const down = onMachine(f, ['views', '--views', 'list', '--json', '--session', 'remote-review']);
  assert.equal(down.status, 255);
  assert.equal(down.stdout, '', 'no payload that could pass for an empty review');
  assert.match(down.stderr, /build-box is not reachable over ssh \(builder@build-box\.example\): ssh: connect to host build-box\.example port 22: Connection refused/);
  // With ControlMaster=no, a stale control socket is reported first, and ssh then connects directly: the
  // reason is what that connection said.
  f.b.env.SSH_FAKE_STDERR = 'Control socket connect(/home/user/.ssh/cm-build-box): Connection refused\nssh: connect to host build-box.example port 22: Connection timed out';
  const stale = onMachine(f, ['sessions', '--json']);
  assert.equal(stale.status, 255);
  assert.match(stale.stderr, /build-box is not reachable over ssh \(builder@build-box\.example\): ssh: connect to host build-box\.example port 22: Connection timed out\n$/);
  // A first connection records the host key (accept-new) and says so before the login fails.
  f.b.env.SSH_FAKE_STDERR = "Warning: Permanently added 'build-box.example' (ED25519) to the list of known hosts.\nbuilder@build-box.example: Permission denied (publickey).";
  const firstKey = onMachine(f, ['sessions', '--json']);
  assert.equal(firstKey.status, 255);
  assert.match(firstKey.stderr, /build-box is not reachable over ssh \(builder@build-box\.example\): builder@build-box\.example: Permission denied \(publickey\)\.\n$/);
  // A jump host reached says why it could not reach the target, after its banner and before its own failed
  // forwarding.
  f.b.env.SSH_FAKE_STDERR = sshCaptured['jump host reached, its target refusing'][0];
  const jumped = onMachine(f, ['sessions', '--json']);
  assert.equal(jumped.status, 255);
  assert.match(jumped.stderr, /build-box is not reachable over ssh \(builder@build-box\.example\): Authorized access only\. All activity is logged\. — channel 0: open failed: connect failed: Connection refused\n$/);
  f.b.env.SSH_FAKE_EXIT = '127';
  f.b.env.SSH_FAKE_STDERR = 'env: oak: No such file or directory';
  const bare = onMachine(f, ['sessions', '--json']);
  assert.equal(bare.status, 127);
  assert.match(bare.stderr, /OAK is not installed on build-box — run `oak machine add build-box builder@build-box\.example` from here/);
  delete f.b.env.SSH_FAKE_EXIT;
  const unknown = run(f.b, process.execPath, [cli, 'sessions', '--json', '--machine', 'elsewhere']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no saved machine "elsewhere"/);
  assert.equal(f.sshCalls().length, 5, 'an unknown machine never reaches ssh');
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
  const linked = cp.spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(path.join(root, 'packages/core/dist'))}); const f = require('fs'), p = require('path'); f.mkdirSync(c.storeDir(${JSON.stringify(S)}), { recursive: true }); f.writeFileSync(p.join(c.storeDir(${JSON.stringify(S)}), 'herdr.json'), JSON.stringify({ paneId: process.env.HERDR_PANE_ID, socketPath: process.env.HERDR_SOCKET_PATH, at: Date.now() }))`],
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

test('CLI ignore --stdin: paths typed at a terminal reach a saved machine, read by OAK, never by its ssh', { skip: process.platform === 'win32' && 'POSIX fake ssh and PTY' }, async t => {
  // ssh runs apart from the terminal's jobs, so ctrl+z, which stops the command, does not stop ssh: one that
  // read the terminal itself went on taking what was then typed to the shell. OAK reads it and hands the paths on.
  const f = machineFixture(t);
  const S = 'remote-ignore-typed';
  const file = f.seed(S);
  fs.writeFileSync(path.join(path.dirname(file), '.observatoryignore'), '*.txt\n');
  const stub = path.join(f.b.home, 'stub');
  fs.mkdirSync(stub);
  fs.renameSync(path.join(f.b.home, 'bin', 'ssh'), path.join(stub, 'ssh'));
  const stdinOf = path.join(f.b.home, 'ssh.stdin');
  fs.writeFileSync(path.join(f.b.home, 'bin', 'ssh'), `#!/bin/sh\n[ "$1" = -G ] || { [ -t 0 ] && echo terminal || echo pipe; } >> '${stdinOf}'\nexec '${stub}/ssh' "$@"\n`, { mode: 0o755 });
  let out = '';
  const term = require('node-pty').spawn(process.execPath, [cli, 'ignore', '--stdin', '--json', '--session', S, '--machine', 'build-box'], { cols: 400, rows: 30, cwd: f.b.home, env: f.b.env });
  term.onData((d) => (out += d));
  const ended = new Promise((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)));
  term.write(`${file}\r`);
  term.write('\x04');
  const code = await Promise.race([ended, new Promise((r) => setTimeout(() => r('still running'), 15000))]);
  if (code === 'still running') term.kill();
  assert.equal(code, 0, out);
  assert.deepEqual(JSON.parse(out.slice(out.indexOf('{')).replace(/\r\n/g, '\n')).paths.map((p) => [p.path, p.mode]), [[file, 'ignored']], 'the typed path was checked on the remote');
  assert.equal(fs.readFileSync(stdinOf, 'utf8'), 'pipe\n', 'ssh read the paths from OAK, not from the terminal');
});

test('CLI ignore --stdin: an ssh that fails before it reads the paths is named as unreachable', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  // OAK hands the paths on to ssh, which here stops reading them and then fails: the paths it still has to
  // hand on cannot be written, which must not end the command before it says why.
  const f = machineFixture(t);
  fs.writeFileSync(path.join(f.b.home, 'bin', 'ssh'), '#!/bin/sh\n[ "$1" = -G ] && exit 0\nexec 0<&-\nsleep 0.5\n' +
    "echo 'ssh: connect to host build-box.example port 22: Connection refused' >&2\nexit 255\n", { mode: 0o755 });
  const r = cp.spawnSync(process.execPath, [cli, 'ignore', '--stdin', '--json', '--machine', 'build-box'],
    { cwd: f.b.home, env: f.b.env, input: 'src/a.txt\n'.repeat(100000), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 255, r.stderr);
  assert.match(r.stderr, /build-box is not reachable over ssh \(builder@build-box\.example\): ssh: connect to host build-box\.example port 22: Connection refused\n$/);
});

test('CLI --machine: only ignore --stdin hands its stdin on, byte for byte; any other verb leaves it to the caller', { skip: process.platform === 'win32' && 'POSIX fake ssh and shell' }, t => {
  // OAK reads the paths and writes them to ssh, as bytes: decoded as text, a path that is not UTF-8 would
  // arrive changed. Any other verb hands ssh no stdin at all: given one, the remote command could wait on a
  // stdin that never ends, and fed one, it took what the caller's next command was to read.
  const f = machineFixture(t);
  const got = path.join(f.b.env.FAKE_REMOTE_HOME, 'stdin.bin');
  // The remote oak keeps all that reaches its stdin, then answers.
  fs.writeFileSync(path.join(f.b.env.FAKE_REMOTE_HOME, '.local', 'bin', 'oak'), `#!/bin/sh\ncat > '${got}'\nprintf '{}\\n'\n`, { mode: 0o755 });
  f.b.env.OAK_MACHINE_TIMEOUT_MS = '5000';
  const inputs = {
    // Every byte value, so invalid UTF-8 too, over several of the pipe's reads.
    binary: [[], Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 7 + (i >> 8)) & 255))],
    // NUL-separated paths with spaces, newlines and tabs in them.
    '-z': [['-z'], Buffer.from(Array.from({ length: 20000 }, (_, i) => `a b/c\n${i}\t.txt\0`).join(''))],
  };
  for (const [name, [flags, input]] of Object.entries(inputs)) {
    fs.rmSync(got, { force: true });
    const r = cp.spawnSync(process.execPath, [cli, 'ignore', '--stdin', ...flags, '--json', '--machine', 'build-box'], { cwd: f.b.home, env: f.b.env, input, timeout: 15000 });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.ok(fs.readFileSync(got).equals(input), `${name}: the remote read the input byte for byte`);
  }
  const file = path.join(f.b.home, 'in.txt'), rest = path.join(f.b.home, 'rest.txt'), status = path.join(f.b.home, 'status');
  fs.writeFileSync(file, 'src/a.txt\n'.repeat(50000));
  fs.rmSync(got, { force: true });
  // OAK's own exit status: the shell's is the next command's.
  const script = path.join(f.b.home, 'search.sh');
  fs.writeFileSync(script, `{ "$1" "$2" search --json --query quokka --machine build-box; echo "$?" > '${status}'; cat > '${rest}'; } < '${file}'\n`);
  const r = cp.spawnSync('/bin/sh', [script, process.execPath, cli],
    { cwd: f.b.home, env: f.b.env, encoding: 'utf8', timeout: 15000 });
  assert.deepEqual([fs.readFileSync(status, 'utf8'), r.stdout, r.stderr], ['0\n', '{}\n', ''], 'the command answered at once');
  assert.equal(fs.readFileSync(got, 'utf8'), '', 'the remote command\'s stdin ended at once, with nothing on it');
  assert.ok(fs.readFileSync(rest).equals(fs.readFileSync(file)), 'the caller\'s next command read all of its stdin');
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

test('CLI human output: an agent-written escape sequence never reaches the terminal; --json keeps the text exact', t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const work = path.join(b.home, 'work');
  fs.mkdirSync(work);
  const id = 'fixture-hostile-title';
  const title = 'Fix \x1b]0;PWNED\x07 it \x1b[2J\x1b[1;1H now \u009b31m done\rX';
  const reply = 'Done \x1b]52;c;ZXZpbA==\x07 \x1b[31mred\x1b[0m';
  const project = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), [
    { type: 'user', cwd: work, sessionId: id, message: { role: 'user', content: title } },
    { type: 'assistant', cwd: work, message: { id: 'a', role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'text', text: reply }], usage: { input_tokens: 1, output_tokens: 2 } } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const controls = (s) => s.replace(/\x1b\[[0-9;:]*m/g, '').match(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g) ?? [];
  for (const args of [['sessions'], ['conversation', '--session', id], ['quote', '--session', id], ['search', '--query', 'Fix']]) {
    const r = run(b, process.execPath, [cli, ...args], { cwd: work });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(args[0] === 'quote' ? 'Done' : 'Fix'), `${args[0]} printed the text: ${JSON.stringify(r.stdout)}`);
    assert.deepEqual(controls(r.stdout + r.stderr), [], `${args[0]}: ${JSON.stringify(r.stdout)}`);
    assert.ok(!/PWNED|ZXZpbA/.test(r.stdout), 'an OSC payload goes with its sequence');
  }
  const json = run(b, process.execPath, [cli, 'sessions', '--json'], { cwd: work });
  assert.equal(JSON.parse(json.stdout).sessions.find((s) => s.id === id)?.title.includes('\x1b]0;PWNED\x07 it \x1b[2J'), true, json.stdout);
  // chat-context answers in JSON with no --json flag, and JSON.stringify leaves C1 characters raw.
  const ctx = run(b, process.execPath, [cli, 'chat-context', '--session', id, '--task', 'x\u009b2Jy'], { cwd: work });
  assert.equal(ctx.status, 0, ctx.stderr);
  assert.match(JSON.parse(ctx.stdout).prompt, /"x\u009b2Jy"/, 'JSON is written unfiltered');
});

/** The CLI as a terminal runs it: stdout claims to be a TTY (no PTY needed). */
const onTerminal = (b, args, options) => run(b, process.execPath, ['-e',
  'process.stdout.isTTY=true;process.argv=[process.execPath,' + JSON.stringify(cli) + ',...process.argv.slice(1)];require(' + JSON.stringify(cli) + ')', ...args], options);

test('CLI machine formats: ignore -z and diff --patch are byte for byte in a pipe, and filtered on a terminal', t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const work = path.join(b.home, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, '.observatoryignore'), 'secret*\n');
  const hostile = 'secret \x1b]0;PWNED\x07 \x1b[2J.txt';
  const escapes = (s) => s.replace(/\x1b\[[0-9;:]*m/g, '').match(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g) ?? [];
  // git's NUL-separated check-ignore shape: the NULs and the path as given survive a pipe.
  const zArgs = ['ignore', '-v', '-z', '--check', hostile];
  const piped = run(b, process.execPath, [cli, ...zArgs], { cwd: work });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.stdout, `.observatoryignore\x001\x00secret*\x00${hostile}\x00`);
  const shown = onTerminal(b, zArgs, { cwd: work });
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.includes('secret*'), shown.stdout);
  assert.deepEqual(escapes(shown.stdout), [], JSON.stringify(shown.stdout));
  // A recorded edit whose content carries escapes: the patch is exact in a pipe, filtered on a terminal.
  const session = 'fixture-patch-bytes', file = path.join(work, 'shown.txt');
  const seeded = cp.spawnSync(process.execPath, ['-e', `
    const core = require(${JSON.stringify(path.join(root, 'packages/core/dist'))});
    const [session, file] = process.argv.slice(1);
    core.ensureStore(session);
    core.appendLog(session, { id: core.nextId(session), ts: 1000, tool: 'Edit', file, status: 'pending',
      beforeBlob: core.writeBlob(session, Buffer.from('plain\\n')), afterBlob: core.writeBlob(session, Buffer.from('bell \\x07 clear \\x1b[2J\\n')) });`,
    session, file], { env: b.env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const patch = run(b, process.execPath, [cli, 'diff', '1', '--patch', '--session', session], { cwd: work });
  assert.equal(patch.status, 0, patch.stderr);
  assert.ok(patch.stdout.includes('+bell \x07 clear \x1b[2J'), JSON.stringify(patch.stdout));
  const patchShown = onTerminal(b, ['diff', '1', '--patch', '--session', session], { cwd: work });
  assert.equal(patchShown.status, 0, patchShown.stderr);
  assert.ok(patchShown.stdout.includes('bell'), patchShown.stdout);
  assert.deepEqual(escapes(patchShown.stdout), [], JSON.stringify(patchShown.stdout));
});

// A Trojan Source edit: a right-to-left override makes a check read as part of a comment, and a zero-width space hides in a
// name. The filter on what the CLI prints for a person drops them, so `oak diff` showed a line that runs differently
// from how it reads. Wherever the output is filtered, each shows as the mark that names it; `--patch` in a pipe and
// `--json` keep the file's text exactly.
test('CLI diff and review: a hidden character in the file shows as the mark that names it, and a pipe\'s --patch stays exact', t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const work = path.join(b.home, 'work');
  fs.mkdirSync(work);
  const session = 'fixture-trojan-source', file = path.join(work, 'auth.js');
  const evil = '    /*\u202e } \u2066if (isAdmin)\u2069 \u2066 begin admins only */ ok\u200bname';
  // A joiner hidden in an identifier shows too, at its end as well; an emoji, an Indic conjunct and a Persian word keep theirs.
  const inIdentifier = ['if (is\u200dadmin) {}', 'foo\u200cbar = 1', 'a\u200d1 += 2', 'let isAdmin\u200d = true;'];
  const builtWith = ['family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}"', 'ksha = "\u0915\u094d\u200d\u0937"', 'kitab = "\u06a9\u062a\u0627\u0628\u200c\u0647\u0627"'];
  const marked = (l) => l.replace(/[\u200c\u200d]/g, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase()}⟩`);
  const seeded = cp.spawnSync(process.execPath, ['-e', `
    const core = require(${JSON.stringify(path.join(root, 'packages/core/dist'))});
    const [session, file, evil] = process.argv.slice(1);
    core.ensureStore(session);
    core.appendLog(session, { id: core.nextId(session), ts: 1000, tool: 'Edit', file, status: 'pending',
      beforeBlob: core.writeBlob(session, Buffer.from('plain\\n')), afterBlob: core.writeBlob(session, Buffer.from(evil + '\\n')) });
    // A transcript, which \`oak review\` reads the session's asks from.
    const fs = require('fs'), path = require('path'), dir = core.projectDir(path.dirname(file));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, session + '.jsonl'), [{ type: 'user', timestamp: new Date(500).toISOString(), message: { role: 'user', content: 'tidy auth.js' } },
      { type: 'assistant', timestamp: new Date(900).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] } }].map((l) => JSON.stringify(l)).join('\\n') + '\\n');`,
    session, file, [evil, ...inIdentifier, ...builtWith].join('\n')], { env: b.env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const hidden = /[\u202e\u2066\u2069\u200b]/;
  const shown = '+    /*⟨U+202E⟩ } ⟨U+2066⟩if (isAdmin)⟨U+2069⟩ ⟨U+2066⟩ begin admins only */ ok⟨U+200B⟩name';
  const plain = (out) => out.replace(/\x1b\[[0-9;:]*m/g, '');
  for (const [how, out] of [['on a terminal', onTerminal(b, ['diff', '1', '--session', session], { cwd: work })],
    ['on a terminal, --patch', onTerminal(b, ['diff', '1', '--patch', '--session', session], { cwd: work })],
    ['in a pipe', run(b, process.execPath, [cli, 'diff', '1', '--session', session], { cwd: work })],
    ['oak review, on a terminal', onTerminal(b, ['review', '--session', session], { cwd: work })]]) {
    assert.equal(out.status, 0, out.stderr);
    assert.ok(plain(out.stdout).includes(shown) && !hidden.test(out.stdout), `${how}: ${JSON.stringify(out.stdout)}`);
    for (const l of inIdentifier) assert.ok(plain(out.stdout).includes(`+${marked(l)}`), `${how}: ${JSON.stringify(l)} shows its joiner`);
    for (const l of builtWith) assert.ok(plain(out.stdout).includes(`+${l}`), `${how}: ${JSON.stringify(l)} keeps its joiner`);
  }
  const tty = onTerminal(b, ['diff', '1', '--session', session], { cwd: work });
  assert.ok(tty.stdout.includes('\x1b[2m⟨U+202E⟩\x1b[22m'), 'dimmed on a terminal, the line keeping its colour');
  const patch = run(b, process.execPath, [cli, 'diff', '1', '--patch', '--session', session], { cwd: work });
  assert.ok(patch.stdout.includes(`+${evil}`) && !patch.stdout.includes('⟨U+'), `--patch in a pipe is the file's text, byte for byte: ${JSON.stringify(patch.stdout)}`);
  const json = run(b, process.execPath, [cli, 'diff', '1', '--json', '--session', session], { cwd: work });
  assert.ok(JSON.parse(json.stdout).patch.includes(`+${evil}`), '--json carries it exactly');
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
  assert.match(status.stdout, /settings\.json incomplete: 2 of 9 hook entries — run `oak init`$/m, 'the user file names what doctor names');
  assert.match(status.stdout, /\(project\) incomplete: 2 of 9 hook entries — run `oak init --repair`$/m, 'a project file, the command that reaches it');
  const repair = run(b, process.execPath, [cli, 'init', '--repair']);
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stdout, /repaired — one entry for each of the 9 capture events, current command/);
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

// JetBrains announces through `notify --session`, a process that ends when it answers: it waits out a
// permission prompt's grace itself, ends as soon as the prompt is answered, and posts only a prompt that
// still stands. (A prompt stamped ahead of the clock is covered by core's announceWhenDue test.) Its
// `stillUp` says whether the prompt still stood when the wait ended, whoever posted it: JetBrains pops its
// own balloon only then.
test('CLI notify --session: a permission prompt answered within its grace posts nothing, at once; one still up posts once', { skip: process.platform !== 'linux' && 'the fake notifier is notify-send' }, t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin);
  const posted = path.join(b.home, 'posted');
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/sh\necho "$@" >> '${posted}'\n`, { mode: 0o755 });
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  const ts = Date.now() - 4000;
  const hand = (id, attention) => {
    const store = path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', id);
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'attention.json'), JSON.stringify(attention));
  };
  const fresh = Date.now();
  hand('fixture-approved', { kind: 'idle-done', message: '', ts: fresh + 500 }); // the approved call ran and its turn ended
  hand('fixture-waiting', { kind: 'permission', message: 'apply_patch', ts });
  const notify = (id, title, at = ts) => {
    const started = Date.now();
    const r = run(b, process.execPath, [cli, 'notify', '--session', id, '--kind', 'permission', '--ts', String(at), '--title', title, '--message', 'apply_patch', '--agent', 'codex', '--json']);
    return { ...r, ms: Date.now() - started };
  };
  const approved = notify('fixture-approved', 'Approved', fresh);
  assert.equal(approved.status, 0, approved.stderr);
  assert.deepEqual(JSON.parse(approved.stdout), { sent: false, stillUp: false });
  assert.ok(approved.ms < 4000, `it ended without sitting out the five-second grace (${approved.ms} ms)`);
  const waiting = notify('fixture-waiting', 'Waiting');
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.deepEqual(JSON.parse(waiting.stdout), { sent: true, stillUp: true });
  assert.ok(waiting.ms < 10_000, `well inside JetBrains' budget (${waiting.ms} ms)`);
  assert.deepEqual(JSON.parse(notify('fixture-waiting', 'Waiting').stdout), { sent: false, stillUp: true }, 'the same prompt posts once, and is still up for a window that pops it');
  // A Codex session under Auto-review waits AUTO_REVIEW_WAIT_MS, not the grace: a prompt 1.5 s short of
  // that wait, long past the grace, is posted only once the wait is over.
  const rollout = path.join(b.home, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { turn_id: 't1', approval_policy: 'on-request', approvals_reviewer: 'auto_review' } }) + '\n');
  const reviewedTs = Date.now() - 90_000 + 1500;
  hand('fixture-reviewed', { kind: 'permission', message: 'Bash', ts: reviewedTs });
  fs.writeFileSync(path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-reviewed', 'agent.json'), JSON.stringify({ agent: 'codex', transcriptPath: rollout, updated: 1 }));
  const started = Date.now();
  const reviewed = run(b, process.execPath, [cli, 'notify', '--session', 'fixture-reviewed', '--kind', 'permission', '--ts', String(reviewedTs), '--title', 'Reviewed', '--message', 'Bash', '--agent', 'codex', '--json']);
  assert.deepEqual(JSON.parse(reviewed.stdout), { sent: true, stillUp: true }, reviewed.stderr);
  assert.ok(Date.now() - started >= 1000, `it waited out the rest of the Auto-review wait (${Date.now() - started} ms)`);
  for (let i = 0; i < 100 && (!fs.existsSync(posted) || fs.readFileSync(posted, 'utf8').trim().split('\n').length < 2); i++) cp.spawnSync('sleep', ['0.05']);
  const lines = fs.readFileSync(posted, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /OAK: Waiting/);
  assert.match(lines[1], /OAK: Reviewed/);
});

// Another machine's hand reaches JetBrains' desktop through `notify --session --host <id> --machine <label>`: announced
// at once (that machine published it once it stood its wait there), claimed under that machine (a session id can repeat
// across machines), naming it, and once; `stillUp` is what its records last said. A malformed machine id is refused.
test('CLI notify --session --host: another machine\'s hand posts at once, naming its machine, once', { skip: process.platform !== 'linux' && 'the fake notifier is notify-send' }, t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin);
  const posted = path.join(b.home, 'posted');
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/sh\necho "$@" >> '${posted}'\n`, { mode: 0o755 });
  b.env.PATH = bin + path.delimiter + b.env.PATH;
  // No store and no hand here: it waits on build-box, and nothing here may say it was answered.
  const ts = Date.now() - 1000;
  const notify = (...extra) => run(b, process.execPath, [cli, 'notify', '--session', 'fixture-remote', '--kind', 'permission', '--ts', String(ts), '--title', 'Remote', '--message', 'Bash', '--agent', 'claude', ...extra, '--json']);
  const started = Date.now();
  const first = notify('--host', 'aaaaaaaaaaaa', '--machine', 'build-box');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { sent: true, stillUp: true });
  assert.ok(Date.now() - started < 4000, 'at once: no grace waited out here');
  assert.deepEqual(JSON.parse(notify('--host', 'aaaaaaaaaaaa', '--machine', 'build-box').stdout), { sent: false, stillUp: true }, 'once');
  // The same session id on another machine is another hand.
  assert.deepEqual(JSON.parse(notify('--host', 'bbbbbbbbbbbb', '--machine', 'gpu-box').stdout).sent, true);
  for (let i = 0; i < 100 && (!fs.existsSync(posted) || fs.readFileSync(posted, 'utf8').trim().split('\n').length < 2); i++) cp.spawnSync('sleep', ['0.05']);
  const lines = fs.readFileSync(posted, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /OAK: Remote .*needs your permission — Bash · on build-box/);
  assert.match(lines[1], /· on gpu-box/);
  const bad = notify('--host', 'not-a-machine');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid machine id "not-a-machine"/);
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

test('CLI --machine: the help and SECURITY.md list exactly the verbs it runs on a saved machine', t => {
  const verbs = [...source.match(/const MACHINE_VERBS = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((v) => !v.startsWith('__')).sort();
  assert.ok(verbs.includes('search') && verbs.length >= 17, verbs.join(' '));
  const help = run(fixture(t), process.execPath, [cli, 'help']).stdout;
  const head = '<verb> … --machine <label>';
  const listed = help.slice(help.indexOf(head) + head.length, help.indexOf(' run on that saved')).split(/,|\sand\s/).map((v) => v.trim()).filter(Boolean);
  assert.deepEqual(listed.sort(), verbs, 'the help');
  const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
  const named = security.slice(security.indexOf('`oak <verb> --machine <label>` runs one of'), security.indexOf('with the saved machine\'s own `oak`'));
  assert.deepEqual([...named.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort(), verbs, 'SECURITY.md');
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
  const once = (session, pin = ['--session', session]) => run({ ...f.b, env }, process.execPath, [cli, 'tui', '--once', '--no-mouse', '--tab', 'review', ...pin, '--cols', '140', '--rows', '40']);
  const shown = once('review-remote');
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Remote parser review  review-r  on build-box/, 'the header names the session and the machine it is reviewed on');
  // `--session=<id>` pins the session just as `--session <id>` does.
  const inline = once('review-remote', ['--session=review-remote']);
  assert.equal(inline.status, 0, inline.stderr);
  assert.match(inline.stdout, /Remote parser review  review-r  on build-box/);
  assert.match(shown.stdout, /review-remote\.txt/, 'the review is the remote store’s edit');
  const forwarded = f.sshCalls().map((argv) => argv.join(' '));
  assert.ok(forwarded.some((c) => c.includes("oak 'sessions' '--json' '--session' 'review-remote'")), 'the owner came from build-box’s own Sessions-only catalog');
  assert.ok(!forwarded.some(c => c.includes("'--workers'")), 'Review alone shows no Workers pane');
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
  makeGitDir(path.join(repo, '.git'));
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

test('CLI --machine: ignore --dry-run needs review protocol 2, so an older remote never sweeps for a preview', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t), session = 'dry-sweep';
  f.seed(session);
  const remote = f.b.env.FAKE_REMOTE_HOME;
  fs.writeFileSync(path.join(remote, 'work', '.observatoryignore'), '*.txt\n');
  const recorded = () => JSON.parse(f.onRemote(['list', '--json', '--session', session]).stdout).edits.length;
  // Bare, the probe answers 1, which is what a 0.10 caller checks for exactly; asked for its level, 2.
  assert.equal(f.onRemote(['__review-protocol']).stdout, '1\n');
  assert.equal(f.onRemote(['__review-protocol', '--level']).stdout, '2\n');
  // A current remote counts and drops nothing.
  const counted = onMachine(f, ['ignore', '--dry-run', '--session', session, '--json']);
  assert.equal(counted.status, 0, counted.stderr);
  assert.ok(JSON.parse(counted.stdout).wouldDrop > 0, counted.stdout);
  assert.equal(recorded(), 1);
  // 0.10 answers 1 to the probe, however asked, and has no `ignore --dry-run`: it ran the sweep, which cannot be undone.
  fs.writeFileSync(path.join(remote, '.local/bin/oak'), '#!/bin/sh\nif [ "$1" = "__review-protocol" ]; then echo 1; exit 0; fi\n' +
    'for a; do shift; [ "$a" = --dry-run ] || set -- "$@" "$a"; done\nexec "' + process.execPath + '" "' + cli + '" "$@"\n');
  const refused = onMachine(f, ['ignore', '--dry-run', '--session', session, '--json']);
  assert.equal(refused.status, 78, refused.stderr);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /update OAK on build-box/);
  assert.equal(recorded(), 1, 'nothing was dropped there');
  // Level 1 features still reach that build.
  const units = onMachine(f, ['list', '--units', '--session', session, '--json']);
  assert.equal(units.status, 0, units.stderr);
  // And a --dry-run that cannot preview names every one that can.
  assert.match(run(f.b, process.execPath, [cli, 'keep', '--all', '--dry-run']).stderr, /`ignore --dry-run` can preview/);
});

test('CLI --machine: on a terminal, the remote answer passes through this side\'s output filter', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  fs.writeFileSync(path.join(f.b.env.FAKE_REMOTE_HOME, '.local/bin/oak'), "#!/bin/sh\nprintf 'row \\033]0;PWNED\\007 \\033[31mred\\033[0m end\\n'\n");
  const piped = onMachine(f, ['list', '--json']);
  assert.equal(piped.stdout, 'row \x1b]0;PWNED\x07 \x1b[31mred\x1b[0m end\n', 'a pipe gets the remote bytes');
  const shown = onTerminal(f.b, ['list', '--json', '--machine', 'build-box']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, 'row  \x1b[31mred\x1b[0m end\n', 'a terminal gets colour, never the title escape');
  // A colour split across two reads of the remote's output is still one colour, and the last line needs no newline.
  fs.writeFileSync(path.join(f.b.env.FAKE_REMOTE_HOME, '.local/bin/oak'), "#!/bin/sh\nprintf 'row \\033[3'; sleep 0.3; printf '1mred\\033[0m end\\ntail'\n");
  const split = onTerminal(f.b, ['list', '--json', '--machine', 'build-box']);
  assert.equal(split.status, 0, split.stderr);
  assert.equal(split.stdout, 'row \x1b[31mred\x1b[0m end\ntail');
  // `views`, whose batches the editors read through a pipe byte for byte, is filtered on a terminal too.
  fs.writeFileSync(path.join(f.b.env.FAKE_REMOTE_HOME, '.local/bin/oak'), "#!/bin/sh\nprintf 'row \\033]0;PWNED\\007 end\\n'\n");
  assert.equal(onMachine(f, ['views', '--views', 'sessions', '--json']).stdout, 'row \x1b]0;PWNED\x07 end\n', 'a pipe gets the remote bytes');
  const views = onTerminal(f.b, ['views', '--views', 'sessions', '--json', '--machine', 'build-box']);
  assert.equal(views.status, 0, views.stderr);
  assert.equal(views.stdout, 'row  end\n');
});

test('CLI --machine: on a terminal, a remote line longer than 64 KB is written before it ends, less a split escape', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  const marker = path.join(f.b.home, 'bulk-written');
  // The remote writes 90 KB with no newline, ending inside one long colour sequence, and finishes its line only
  // once this side has written the bulk (the marker), or after 10 s. However the pipe splits the reads, the one
  // that takes the held text past 64 KB ends inside that sequence, which must be held back whole.
  const bulk = 'x'.repeat(30000) + '\x1b[' + '0;'.repeat(30000);
  const remote = path.join(f.b.env.FAKE_REMOTE_HOME, 'long-line.js');
  fs.writeFileSync(remote, `const fs = require('fs');
    const out = (s) => { const b = Buffer.from(s); for (let at = 0; at < b.length;) at += fs.writeSync(1, b, at); };
    out(${JSON.stringify(bulk)});
    for (let i = 0; i < 100 && !fs.existsSync(${JSON.stringify(marker)}); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    out('31mred\\x1b[0m end\\n');`);
  fs.writeFileSync(path.join(f.b.env.FAKE_REMOTE_HOME, '.local/bin/oak'), `#!/bin/sh\nexec "${process.execPath}" "${remote}"\n`);
  const writes = path.join(f.b.home, 'writes.json');
  const shown = run(f.b, process.execPath, ['-e',
    `const fs = require('fs'), seen = [], write = process.stdout.write.bind(process.stdout);
     process.stdout.write = (chunk, ...rest) => { seen.push(String(chunk)); fs.writeFileSync(${JSON.stringify(writes)}, JSON.stringify(seen));
       fs.writeFileSync(${JSON.stringify(marker)}, ''); return write(chunk, ...rest); };
     process.stdout.isTTY = true; process.argv = [process.execPath, ${JSON.stringify(cli)}, ...process.argv.slice(1)]; require(${JSON.stringify(cli)})`,
    'list', '--json', '--machine', 'build-box']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, bulk + '31mred\x1b[0m end\n');
  const seen = JSON.parse(fs.readFileSync(writes, 'utf8'));
  const end = seen.findIndex(s => s.includes('end'));
  assert.ok(end > 0, `the bulk was written before the remote finished its line (${seen.map(s => s.length)})`);
  assert.ok(seen.slice(0, end).every(s => !/\x1b\[?[0-9;]*$/.test(s)), 'a split colour is held back, never written in two halves');
});

test('CLI --machine: no ssh it runs asks in a dialog, whatever the caller asked for', { skip: process.platform === 'win32' }, t => {
  // Run apart from the terminal, ssh would ask through the desktop's askpass program wherever a display is set,
  // and so would a jump host's ssh, which inherits ssh's environment but none of OAK's options: a dialog on
  // every read the terminal app or an editor makes.
  const f = machineFixture(t);
  f.b.env.SSH_ASKPASS_REQUIRE = 'force';
  f.b.env.SSH_ASKPASS_LOG = path.join(f.b.home, 'ssh-askpass.log');
  const result = onMachine(f, ['sessions', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(f.b.env.SSH_ASKPASS_LOG, 'utf8').trim().split('\n'), ['G never', 'run never'], 'ssh -G, then the command');
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

// `oak diff --patch --machine` on a terminal: the saved machine prints the patch into its pipe byte for byte, and the
// filter on this terminal dropped a bidirectional control or zero-width character in it. It shows the mark naming it.
test('CLI --machine: a patch shown on a terminal shows a hidden character in the file as the mark that names it', async () => {
  const { EventEmitter } = require('node:events');
  const forwarded = async (verb, args) => {
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}; child.kill = () => true;
    const module = { exports: {} }; let out = '';
    const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { forwardToMachine };'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const core = { findHerdrBin: () => '/fake/herdr', herdrMachines: async () => [{ id: 'm', label: 'box', target: 'box.example', enabled: true }],
      machineSshEnv: () => ({}), sshMuxOptions: realCore.sshMuxOptions, spawnTool: () => child, revealHidden: realCore.revealHidden,
      spawnToolSync: () => ({ status: 0, stdout: 'controlmaster false\ncontrolpersist no\n' }) };
    const proc = { env: {}, platform: 'linux', stdout: { isTTY: true, write: (text) => { out += text; return true; } }, stderr: { write() {} }, pid: 4242, once() {}, off() {} };
    vm.runInNewContext(code, { module, exports: module.exports, Buffer, require: name => name === '@oak-observatory/core' ? core : require(name), process: proc,
      setTimeout: () => ({ unref() {} }), clearTimeout() {} });
    await module.exports.forwardToMachine(verb, args);
    child.stdout.emit('data', '+if (ok\u202e) {}\n');
    return out;
  };
  assert.equal(await forwarded('diff', ['12', '--patch', '--machine', 'box']), '+if (ok\x1b[2m⟨U+202E⟩\x1b[22m) {}\n');
  assert.equal(await forwarded('sessions', ['--machine', 'box']), '+if (ok\u202e) {}\n', 'control: another command\'s output goes on to the filter as it came');
});

test('CLI --machine: a configurable overall deadline fails loudly and escalates a stuck SSH child', async () => {
  const { EventEmitter } = require('node:events'), timers = [], signals = [], handlers = {};
  // `killed`, as Node's: set once a signal was sent.
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = function (signal) { signals.push(signal || 'SIGTERM'); this.killed = true; return true; };
  const module = { exports: {} }; let stderr = '';
  const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { forwardToMachine };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const core = { findHerdrBin: () => '/fake/herdr', herdrMachines: async () => [{ id: 'm', label: 'box', target: 'box.example', enabled: true }],
    machineSshEnv: () => ({}), sshMuxOptions: realCore.sshMuxOptions, spawnTool: () => child, spawnToolSync: () => ({ status: 0, stdout: 'controlmaster false\ncontrolpersist no\n' }) };
  // Only `once`: a handler left behind would keep the raised signal from ending the process.
  const proc = { env: { OAK_MACHINE_TIMEOUT_MS: '250' }, platform: 'linux', stdout: { isTTY: false }, stderr: { write: text => { stderr += text; } }, pid: 4242,
    exit: code => { throw new Error('exit ' + code); }, once: (signal, fn) => { handlers[signal] = fn; }, kill: (pid, signal) => { throw new Error(`raised ${signal} at ${pid}`); } };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer,
    require: name => name === '@oak-observatory/core' ? core : require(name), process: proc,
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {} });
  await module.exports.forwardToMachine('views', ['--machine', 'box']);
  assert.equal(timers[0].ms, 250);
  timers[0].fn(); timers[1].fn();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.throws(() => child.emit('close', null), /exit 124/);
  assert.match(stderr, /box did not finish.*OAK_MACHINE_TIMEOUT_MS.*refresh before retrying/);
  // Stopped from outside (the terminal app's own deadline sends SIGTERM), it stops ssh too, then raises the
  // signal again, so it ends as that signal ends it; on Windows, which has none, with the status a shell reports.
  for (const [signal, status] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    signals.length = 0;
    proc.platform = 'linux';
    assert.throws(() => handlers[signal](), new RegExp(`raised ${signal} at 4242`), signal);
    assert.deepEqual(signals, ['SIGTERM'], `${signal} stops the ssh child`);
    proc.platform = 'win32';
    assert.throws(() => handlers[signal](), new RegExp(`exit ${status}`), signal);
  }
  // ctrl+\ as well, where there is one (see the test below for Windows).
  signals.length = 0;
  proc.platform = 'linux';
  assert.throws(() => handlers.SIGQUIT(), /raised SIGQUIT at 4242/);
  assert.deepEqual(signals, ['SIGTERM'], 'SIGQUIT stops the ssh child');
  // Ended any other way (an uncaught exception), it stops an ssh still running, once; and on Windows, where a
  // signal's handler ends it with process.exit, which runs the exit handler too, ssh is not stopped twice.
  signals.length = 0;
  child.killed = false;
  handlers.exit();
  handlers.exit();
  assert.deepEqual(signals, ['SIGTERM'], 'an exit stops ssh once');
  signals.length = 0;
  child.killed = false;
  proc.platform = 'win32';
  assert.throws(() => handlers.SIGINT(), /exit 130/);
  handlers.exit();
  assert.deepEqual(signals, ['SIGTERM'], 'the signal handler stopped ssh, and the exit handler did not again');
});

test('CLI --machine and update: ssh runs in a session of its own except on Windows, so ctrl+c reaches OAK alone', async () => {
  // Once its session is up, OpenSSH catches SIGINT and SIGHUP and exits 255. Signalled along with OAK, ssh
  // could close first, and the command named the machine unreachable and exited 255, which a shell loop
  // read as a command that handled ctrl+c. Windows has no such group to leave, and there a detached child
  // opens a console window of its own. Nor is it hidden there (windowsHide): it shares OAK's console, where a
  // jump host's ssh can ask, rather than an unseen one of its own, where the question waited out the deadline.
  const { EventEmitter } = require('node:events');
  const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { forwardToMachine, sshUpdate };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const platform of ['linux', 'darwin', 'win32']) {
    const detached = [], handled = [], module = { exports: {} };
    const core = { findHerdrBin: () => '/fake/herdr', herdrMachines: async () => [{ id: 'm', label: 'box', target: 'box.example', enabled: true }],
      machineSshEnv: () => ({}), sshMuxOptions: realCore.sshMuxOptions, spawnToolSync: () => ({ status: 0, stdout: 'controlmaster false\ncontrolpersist no\n' }),
      spawnTool: (bin, argv, opts) => { detached.push([bin, opts.detached, opts.windowsHide]); return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() {} }); } };
    vm.runInNewContext(code, { module, exports: module.exports, Buffer, require: name => name === '@oak-observatory/core' ? core : require(name),
      process: { env: {}, platform, stdout: { isTTY: false }, stderr: { write() {} }, once: (event) => handled.push(event), off() {} }, setTimeout: () => ({ unref() {} }), clearTimeout() {} });
    await module.exports.forwardToMachine('views', ['--machine', 'box']);
    void module.exports.sshUpdate({ label: 'box', target: 'box.example' }, 'oak update --here --json', 1000);
    assert.deepEqual(detached, [['ssh', platform !== 'win32', false], ['ssh', platform !== 'win32', false]], `${platform}: --machine, then the update`);
    // So each signal a terminal sends must reach ssh through OAK's handlers: ctrl+\ (SIGQUIT) too, which Windows
    // does not have; and any other exit stops ssh as well.
    const each = ['SIGTERM', 'SIGINT', 'SIGHUP', ...(platform === 'win32' ? [] : ['SIGQUIT']), 'exit'];
    assert.deepEqual(handled, [...each, ...each], `${platform}: --machine, then the update`);
  }
});

test('CLI --machine: ctrl+c stops a shell loop of forwarded commands at the first one', { skip: process.platform === 'win32' && 'POSIX shell and PTY' }, async t => {
  // bash goes on with a loop when its command exits 130, as one that handled ctrl+c itself, and stops it
  // only when ctrl+c ended the command. The ssh here never answers, so ctrl+c lands while it waits, and it
  // ends as OpenSSH does once its session is up: SIGINT, SIGHUP or SIGTERM, noted, end it with status 255.
  const f = machineFixture(t);
  f.b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const runs = path.join(f.b.home, 'ssh.runs'), after = path.join(f.b.home, 'loop.after'), signals = path.join(f.b.home, 'ssh.signals');
  fs.writeFileSync(path.join(f.b.home, 'bin', 'ssh'), `#!/bin/sh\n[ "$1" = -G ] && exit 0\necho "$$" >> '${runs}'\n` +
    `for s in INT HUP TERM; do trap "echo $s >> '${signals}'; exit 255" $s; done\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 });
  const seen = new Set(); // every ssh started, killed at the end whatever the assertions said
  const ssh = () => { const now = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []; now.forEach((p) => seen.add(p)); return now; };
  t.after(() => { for (const pid of seen) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const loop = `for i in 1 2 3; do '${process.execPath}' '${cli}' search --json --query quokka --machine build-box; echo "after $i" >> '${after}'; done`;
  const term = require('node-pty').spawn('/bin/bash', ['-c', loop], { cols: 100, rows: 30, cwd: f.b.home, env: f.b.env });
  term.onData(() => {});
  const ended = new Promise((resolve) => term.onExit(resolve));
  for (const end = Date.now() + 15000; Date.now() < end && !ssh().length;) await new Promise((r) => setTimeout(r, 50));
  assert.equal(ssh().length, 1, 'the first command is waiting on its ssh');
  term.write('\x03');
  const done = await Promise.race([ended.then(() => 'ended'), new Promise((r) => setTimeout(() => r('still running'), 10000))]);
  if (done !== 'ended') term.kill();
  assert.equal(done, 'ended', 'the loop ended');
  assert.equal(fs.existsSync(after) ? fs.readFileSync(after, 'utf8') : '', '', 'nothing after the first command ran');
  assert.equal(ssh().length, 1, 'no second command started');
  // ctrl+c reached OAK alone, which stopped its ssh. Reaching ssh too, it let ssh close first with its 255,
  // which is how the loop went on.
  const noted = () => (fs.existsSync(signals) ? fs.readFileSync(signals, 'utf8') : '');
  for (const end = Date.now() + 5000; Date.now() < end && !noted();) await new Promise((r) => setTimeout(r, 50));
  assert.equal(noted(), 'TERM\n', 'ssh was stopped by OAK, and ctrl+c never reached it');
});

test('CLI --machine: ended by ctrl+\\ or by an uncaught exception, it stops its ssh too', { skip: process.platform === 'win32' && 'POSIX signals and fake ssh' }, async t => {
  // ssh runs apart from the terminal's job, so only OAK can stop it, and ctrl+\ (SIGQUIT) and an uncaught
  // exception each ended OAK with ssh left running until the remote command ended. The ssh here records its
  // pid, never answers, and ends as OpenSSH does once its session is up: a signal, noted, ends it with 255.
  const f = machineFixture(t);
  const runs = path.join(f.b.home, 'ssh.runs'), signals = path.join(f.b.home, 'ssh.signals');
  fs.writeFileSync(path.join(f.b.home, 'bin', 'ssh'), `#!/bin/sh\n[ "$1" = -G ] && exit 0\n` +
    `for s in INT HUP QUIT TERM; do trap "echo $s >> '${signals}'; exit 255" $s; done\necho "$$" >> '${runs}'\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 });
  const throws = path.join(f.b.home, 'throws.cjs');
  fs.writeFileSync(throws, `if (process.argv[1] === ${JSON.stringify(cli)}) {
  const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(runs)})) { clearInterval(t); throw new Error('fixture: an uncaught exception while ssh runs'); } }, 20);
  t.unref();
}
`);
  const alive = (pid) => { try { process.kill(pid, 0); } catch { return false; } return !/Z/.test(cp.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout); };
  const seen = new Set(); // every ssh started, killed at the end whatever the assertions said
  const ssh = () => { const now = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []; now.forEach((p) => seen.add(p)); return now; };
  t.after(() => { for (const pid of seen) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  for (const how of ['SIGQUIT', 'an uncaught exception']) await t.test(how, { skip: how === 'SIGQUIT' && noQuitHere() }, async () => {
    for (const file of [runs, signals]) fs.rmSync(file, { force: true });
    const quit = how === 'SIGQUIT';
    // Its own process group, as a shell gives each job, so the test can signal the job the way a terminal does.
    const [file, ...args] = withoutCore([process.execPath, cli, 'search', '--json', '--query', 'quokka', '--machine', 'build-box']);
    const child = cp.spawn(file, args, { env: quit ? f.b.env : { ...f.b.env, NODE_OPTIONS: `--require ${throws}` }, cwd: f.b.home, stdio: 'ignore', detached: true });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ended */ } });
    const exited = new Promise((resolve) => child.on('exit', (status, sig) => resolve({ status, sig })));
    for (const end = Date.now() + 15000; Date.now() < end && !ssh().length;) await new Promise((r) => setTimeout(r, 50));
    assert.equal(ssh().length, 1, `${how}: the command is waiting on its ssh`);
    if (quit) process.kill(-child.pid, 'SIGQUIT');
    assert.deepEqual(await exited, quit ? { status: null, sig: 'SIGQUIT' } : { status: 1, sig: null }, `${how}: it ends as that ends it`);
    for (const end = Date.now() + 3000; Date.now() < end && ssh().some(alive);) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ssh().filter(alive), [], `${how}: no ssh is left running`);
    const noted = () => (fs.existsSync(signals) ? fs.readFileSync(signals, 'utf8') : '');
    for (const end = Date.now() + 3000; Date.now() < end && !noted();) await new Promise((r) => setTimeout(r, 50));
    assert.equal(noted(), 'TERM\n', `${how}: OAK stopped its ssh, and the job's signal never reached it`);
  });
});

/** A herdr with one saved machine, box, which holds session s1's pane. Each command for box logs its pid and
 *  what it is; a prompt reaches the pane 3 s after it starts, as one forwarded over a slow connection does,
 *  and with FAKE_SNAPSHOT_HANGS a snapshot never answers. With `slow`, a second saved machine, slow, whose
 *  snapshot never answers (logged as `slowsnap`). Like herdr, it traps no signal. The ssh beside it fails at
 *  once: the terminal app also lists box's sessions through it. With `slowG`, its `ssh -G` answers after 2 s,
 *  as one held by a slow `Match exec` does, with ControlMaster on and no ControlPersist. */
function slowMachineHerdr(t, { slow = false, slowG = false } = {}) {
  const b = fixture(t);
  const bin = path.join(b.home, 'bin'), log = path.join(b.home, 'herdr.log');
  fs.mkdirSync(bin);
  const snapshot = JSON.stringify({ result: { snapshot: { version: '0.9.1', protocol: 22, panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle' }], agents: [] } } });
  const machines = JSON.stringify(['box', ...(slow ? ['slow'] : [])].map((label, i) => ({ id: `m${i + 1}`, label, target: `${label}.example`, session: 's', enabled: true, selected: false })));
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
case "$*" in
  'machine list --json') echo '${machines}' ;;
  '--machine box api snapshot') echo "$$ snapshot" >> '${log}'; [ -z "$FAKE_SNAPSHOT_HANGS" ] || sleep 30; echo '${snapshot}' ;;
  '--machine slow api snapshot') echo "$$ slowsnap" >> '${log}'; sleep 30 ;;
  '--machine box agent prompt '*) echo "$$ prompt" >> '${log}'; sleep 3; echo "$$ delivered" >> '${log}'; echo '{"result":{"type":"ok"}}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\n${slowG ? "[ \"$1\" != -G ] || { sleep 2; printf 'controlmaster auto\\ncontrolpersist no\\n'; exit 0; }\n" : ''}echo "ssh: Could not resolve hostname box.example: Name or service not known" >&2\nexit 255\n`, { mode: 0o755 });
  Object.assign(b.env, { PATH: bin + path.delimiter + b.env.PATH, HERDR_BIN: path.join(bin, 'herdr'),
    CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', OAK_NO_BACKGROUND: '1', OAK_NO_SERVER: '1' });
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')) : []);
  t.after(() => { for (const [pid] of runs()) try { process.kill(-Number(pid), 'SIGKILL'); } catch { /* gone */ } });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** The pid of box's first `what` (snapshot, prompt), once it has started. */
  const started = async (what) => {
    for (const end = Date.now() + 20000; Date.now() < end; await wait(20)) {
      const run = runs().find(([, w]) => w === what);
      if (run) return Number(run[0]);
    }
    assert.fail(`no ${what} for box started`);
  };
  /** '' once herdr's whole process group, herdr and the sleep it runs, is gone within 3 s; otherwise what is left of
   *  it, as `ps` lists it (pid, parent, state, command), so a failure on a CI runner says what outlived the stop. */
  const stopped = async (pid) => {
    let why = '';
    const gone = () => { try { process.kill(-pid, 0); why = 'alive'; return false; } catch (error) { why = error.code; return error.code === 'ESRCH'; } };
    for (const end = Date.now() + 3000; Date.now() < end && !gone();) await wait(20);
    if (gone()) return '';
    const ps = cp.spawnSync('ps', ['-A', '-o', 'pid=,pgid=,ppid=,stat=,command='], { encoding: 'utf8' }).stdout || '';
    const left = ps.split('\n').filter((line) => line.trim().split(/\s+/)[1] === String(pid));
    return `process group ${pid} (kill -0: ${why}): ${left.join(' | ') || 'no process of it listed'}`;
  };
  const within = (promise, ms, late) => Promise.race([promise, wait(ms).then(() => late)]);
  return { b, runs, started, stopped, within, wait };
}

test('CLI prompt: ctrl+c while a saved machine\'s herdr delivers the prompt stops herdr, and nothing is delivered', { skip: process.platform === 'win32' && 'POSIX process groups and fake herdr' }, async t => {
  // herdr's command for a saved machine runs apart from the terminal, so ctrl+c reached OAK alone, which ended
  // and left herdr to deliver the prompt a moment later.
  const h = slowMachineHerdr(t);
  // Its own process group, as a shell gives each job, so the test signals the job as a terminal's ctrl+c does.
  const child = cp.spawn(process.execPath, [cli, 'prompt', '--session', 's1', '--text', 'hello there', '--machine', 'box'], { env: h.b.env, cwd: h.b.home, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ended */ } });
  const exited = new Promise((resolve) => child.on('exit', (status, sig) => resolve({ status, sig })));
  const herdr = await h.started('prompt');
  const at = Date.now();
  process.kill(-child.pid, 'SIGINT');
  assert.deepEqual(await h.within(exited, 10000, 'still running'), { status: null, sig: 'SIGINT' }, 'it ends by ctrl+c, so a shell loop around it stops');
  assert.equal(await h.stopped(herdr), '', 'herdr stopped, with its whole process group');
  await h.wait(Math.max(0, at + 3500 - Date.now())); // past the moment the prompt would have arrived
  assert.deepEqual(h.runs().map(([, what]) => what), ['snapshot', 'prompt'], 'the prompt was not delivered');
});

test('terminal app: quitting it, a hangup, or ctrl+c or a deadline on a one-shot frame stops a saved machine\'s read in flight', { skip: process.platform === 'win32' && 'POSIX process groups, PTY and fake herdr' }, async t => {
  // The Observatory reads each saved machine through herdr, apart from the terminal: neither the app's exit nor
  // a hangup reached that read, which ran on after the app was gone.
  let pty;
  try { pty = require('node-pty'); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return t.skip('node-pty is unavailable'); throw error; }
  for (const how of ['ctrl+q twice', 'a hangup', 'ctrl+c on --once', 'a deadline\'s SIGTERM on --once']) await t.test(how, async (t) => {
    const h = slowMachineHerdr(t);
    h.b.env.FAKE_SNAPSHOT_HANGS = '1';
    if (how.endsWith('on --once')) {
      const child = cp.spawn(process.execPath, [cli, 'tui', '--once', '--no-mouse', '--tab', 'observatory'], { env: h.b.env, cwd: h.b.home, stdio: 'ignore', detached: true });
      t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ended */ } });
      const exited = new Promise((resolve) => child.on('exit', (status, sig) => resolve({ status, sig })));
      const herdr = await h.started('snapshot');
      // ctrl+c reaches the terminal's whole job; a deadline (an editor's, `timeout`) signals the frame alone.
      const sig = how.startsWith('ctrl+c') ? 'SIGINT' : 'SIGTERM';
      process.kill(sig === 'SIGINT' ? -child.pid : child.pid, sig);
      assert.deepEqual(await h.within(exited, 10000, 'still running'), { status: null, sig }, `the frame ends by ${sig}`);
      assert.equal(await h.stopped(herdr), '', 'the read stopped with it');
      return;
    }
    const term = pty.spawn(process.execPath, [cli, 'tui', '--tab', 'observatory'], { cols: 120, rows: 36, cwd: h.b.home, env: h.b.env });
    term.onData(() => {});
    t.after(() => { try { term.kill('SIGKILL'); } catch { /* exited */ } });
    const exited = new Promise((resolve) => term.onExit(resolve));
    const herdr = await h.started('snapshot');
    if (how === 'a hangup') term.kill('SIGHUP');
    else { term.write('\x11'); await h.wait(200); term.write('\x11'); }
    assert.equal((await h.within(exited, 10000, { exitCode: 'still running' })).exitCode, 0, 'the app exited');
    assert.equal(await h.stopped(herdr), '', 'the read stopped with it');
  });
});

test('terminal app: a reply already sending to a saved machine arrives after the app quits or its terminal closes, while a read in flight stops', { skip: process.platform === 'win32' && 'POSIX process groups, PTY and fake herdr' }, async t => {
  // The send ran apart from the terminal like the reads, and the app's exit stopped it with them: a reply sent
  // just before quitting never arrived. It finishes now, as one sent from VS Code does; the reads still stop.
  let pty, Terminal;
  try { pty = require('node-pty'); ({ Terminal } = require('@xterm/headless')); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return t.skip('node-pty is unavailable'); throw error; }
  for (const how of ['ctrl+q twice', 'its terminal closing']) await t.test(how, async (t) => {
    const h = slowMachineHerdr(t, { slow: true });
    const xt = new Terminal({ cols: 140, rows: 40, allowProposedApi: true });
    const term = pty.spawn(process.execPath, [cli, 'tui', '--tab', 'observatory', '--session', 's1', '--no-mouse'], { cols: 140, rows: 40, cwd: h.b.home, env: h.b.env });
    term.onData((data) => xt.write(data));
    t.after(() => { try { term.kill('SIGKILL'); } catch { /* exited */ } });
    const exited = new Promise((resolve) => term.onExit(resolve));
    const screen = () => { const buffer = xt.buffer.active, lines = []; for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? ''); return lines.join('\n'); };
    const shows = async (pattern) => {
      for (const end = Date.now() + 20000; Date.now() < end; await h.wait(50)) if (pattern.test(screen())) return;
      assert.fail(`the screen never showed ${pattern}:\n${screen()}`);
    };
    const read = await h.started('slowsnap'); // slow's read, in flight until the app ends
    await h.started('snapshot');
    await shows(/^\s+s1\s+│/m); // box's session, listed
    term.write('\r');
    await shows(/pinned s1/);
    term.write('c');
    await shows(/> _/);
    term.write('please keep going');
    await shows(/> please keep going_/);
    term.write('\r');
    const send = await h.started('prompt');
    if (how === 'its terminal closing') term.destroy();
    else { term.write('\x11'); await h.wait(150); term.write('\x11'); }
    const { exitCode, signal } = await h.within(exited, 10000, { exitCode: 'still running' });
    assert.deepEqual([exitCode, signal], [0, 0], 'the app exited with status 0, not by a signal');
    assert.equal(await h.stopped(read), '', 'the read stopped with it');
    for (const end = Date.now() + 10000; Date.now() < end && !h.runs().some(([, what]) => what === 'delivered'); await h.wait(50));
    assert.deepEqual(h.runs().filter(([, what]) => what === 'prompt' || what === 'delivered'), [[String(send), 'prompt'], [String(send), 'delivered']], 'the reply arrived after the app had gone');
  });
});

test('terminal app: a reply sent just before it quits or its terminal closes arrives, however long its machine\'s ssh -G takes', { skip: process.platform === 'win32' && 'POSIX process groups, PTY and fake herdr' }, async t => {
  // The reply first read its machine's ssh configuration (`machine list`, then `ssh -G`, which a slow `Match exec`
  // holds for seconds) and only then started herdr: an app that ended meanwhile ended the reply with it, unsent.
  let pty, Terminal;
  try { pty = require('node-pty'); ({ Terminal } = require('@xterm/headless')); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return t.skip('node-pty is unavailable'); throw error; }
  for (const how of ['ctrl+q twice', 'its terminal closing']) await t.test(how, async (t) => {
    const h = slowMachineHerdr(t, { slowG: true });
    const xt = new Terminal({ cols: 140, rows: 40, allowProposedApi: true });
    const term = pty.spawn(process.execPath, [cli, 'tui', '--tab', 'observatory', '--session', 's1', '--no-mouse'], { cols: 140, rows: 40, cwd: h.b.home, env: h.b.env });
    term.onData((data) => xt.write(data));
    t.after(() => { try { term.kill('SIGKILL'); } catch { /* exited */ } });
    const exited = new Promise((resolve) => term.onExit(resolve));
    const screen = () => { const buffer = xt.buffer.active, lines = []; for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? ''); return lines.join('\n'); };
    const shows = async (pattern) => {
      for (const end = Date.now() + 20000; Date.now() < end; await h.wait(50)) if (pattern.test(screen())) return;
      assert.fail(`the screen never showed ${pattern}:\n${screen()}`);
    };
    await h.started('snapshot');
    await shows(/^\s+s1\s+│/m);
    term.write('\r');
    await shows(/pinned s1/);
    term.write('c');
    await shows(/> _/);
    term.write('please keep going');
    await shows(/> please keep going_/);
    term.write('\r');
    const sent = Date.now();
    await shows(/Sending…/); // the app has read the Enter: closing the terminal before that would discard it
    if (how === 'its terminal closing') term.destroy();
    else { term.write('\x11'); await h.wait(150); term.write('\x11'); }
    const { exitCode, signal } = await h.within(exited, 10000, { exitCode: 'still running' });
    assert.deepEqual([exitCode, signal], [0, 0], 'the app exited with status 0, not by a signal');
    assert.ok(Date.now() - sent < 2000, `the app ended before an ssh -G could have answered (${Date.now() - sent} ms)`);
    for (const end = Date.now() + 10000; Date.now() < end && !h.runs().some(([, what]) => what === 'delivered'); await h.wait(50));
    const send = h.runs().filter(([, what]) => what === 'prompt' || what === 'delivered');
    assert.deepEqual(send.map(([, what]) => what), ['prompt', 'delivered'], 'the reply arrived after the app had gone');
    assert.equal(send[0][0], send[1][0], 'delivered by the herdr that started it');
  });
});

test('terminal app: a closed terminal that fails a read or a write (EIO) before any SIGHUP ends it with status 0, as a hangup', { skip: process.platform === 'win32' && 'POSIX PTY' }, async t => {
  // Closing the terminal can fail the app's read on it or its write to it (EIO) before SIGHUP arrives, which ended it
  // as a crash, with status 1, rarely, and more often on a busy machine.
  let pty;
  try { pty = require('node-pty'); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return t.skip('node-pty is unavailable'); throw error; }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const app = (t, argv, extra = () => ({})) => {
    const b = fixture(t);
    fs.mkdirSync(path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory'), { recursive: true });
    fs.writeFileSync(path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory/agent-setup-suggested'), '1\n');
    const bin = path.join(b.home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); // no herdr: the app draws its frame without one
    const env = { ...b.env, PATH: bin + path.delimiter + b.env.PATH, OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', ...extra(b) };
    const [file, ...args] = argv(b);
    const term = pty.spawn(file, args, { cols: 120, rows: 36, cwd: b.home, env });
    t.after(() => { try { term.kill('SIGKILL'); } catch { /* it ended */ } });
    const run = { b, term, out: '', exited: new Promise((resolve) => term.onExit(resolve)) };
    term.onData((data) => { run.out += data; });
    return run;
  };
  const drawn = async (run) => {
    for (const end = Date.now() + 20000; Date.now() < end && !/Observatory/.test(run.out); await wait(50));
    assert.match(run.out, /Observatory/, 'the app drew its first frame');
  };
  await t.test('a read that fails', async (t) => {
    // The kernel fails the read only in the moment before it hangs the terminal up, so a preload raises the error Node
    // raises for it, on SIGUSR2.
    const run = app(t, (b) => [process.execPath, '--require', path.join(b.home, 'eio.cjs'), cli, 'tui', '--tab', 'observatory', '--no-mouse'], (b) => {
      fs.writeFileSync(path.join(b.home, 'eio.cjs'), "process.on('SIGUSR2', () => process.stdin.emit('error', Object.assign(new Error('read EIO'), { errno: -5, code: 'EIO', syscall: 'read' })));\n");
      return {};
    });
    await drawn(run);
    process.kill(run.term.pid, 'SIGUSR2');
    const { exitCode, signal } = await Promise.race([run.exited, wait(10000).then(() => ({ exitCode: 'still running' }))]);
    assert.deepEqual([exitCode, signal], [0, 0], run.out.slice(-300));
  });
  const setsid = ['/usr/bin/setsid', '/bin/setsid'].find((file) => fs.existsSync(file));
  // `oak tui` and a bare `oak` reach the app by separate paths in the CLI, and each must mark it as the terminal app.
  for (const verb of [['tui'], []]) await t.test(`a write that fails (${verb.length ? 'oak tui' : 'oak'})`, { skip: !setsid && 'no setsid here' }, async (t) => {
    // In a session of its own on the terminal's fds, the app gets no SIGHUP, and its next write fails. The shell ignores
    // SIGHUP so that it outlives the terminal to record the app's status.
    const script = `trap "" HUP; ${setsid} -w /bin/sh -c 'echo $$ > "$OAK_TEST_PID"; exec "$0" "$@"' "$0" "$@" 2>"$OAK_TEST_ERR"; echo $? > "$OAK_TEST_STATUS"`;
    let files;
    const run = app(t, () => ['/bin/sh', '-c', script, process.execPath, cli, ...verb, '--tab', 'observatory', '--no-mouse'], (b) => {
      files = { OAK_TEST_STATUS: path.join(b.home, 'status'), OAK_TEST_PID: path.join(b.home, 'pid'), OAK_TEST_ERR: path.join(b.home, 'stderr') };
      return files;
    });
    t.after(() => { try { process.kill(Number(fs.readFileSync(files.OAK_TEST_PID, 'utf8')), 'SIGKILL'); } catch { /* it ended */ } });
    await drawn(run);
    run.term.destroy();
    for (const end = Date.now() + 10000; Date.now() < end && !fs.existsSync(files.OAK_TEST_STATUS); await wait(50));
    assert.doesNotMatch(fs.readFileSync(files.OAK_TEST_ERR, 'utf8'), /ResetStdio|Assertion failed/,
      'Node must not abort while restoring a closed terminal, including on 22.16');
    assert.equal(fs.existsSync(files.OAK_TEST_STATUS) && fs.readFileSync(files.OAK_TEST_STATUS, 'utf8').trim(), '0',
      fs.existsSync(files.OAK_TEST_ERR) ? fs.readFileSync(files.OAK_TEST_ERR, 'utf8') : 'still running');
  });
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
  makeGitDir(path.join(b.home, '.git'));
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
  makeGitDir(path.join(b.home, '.git'));
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

test('CLI --json through a slow pipe: the whole answer arrives, with the verb\'s exit status', { skip: process.platform === 'win32' && 'POSIX sh pipeline' }, t => {
  // process.exit() right after the write drops whatever the pipe has not taken yet: the reader got the
  // first 64 KB on Linux and 8 KB on macOS, and a JSON parse failed. The reader here starts a second late.
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const paths = path.join(b.home, 'paths');
  fs.writeFileSync(paths, Array.from({ length: 3000 }, (_, i) => `src/some/deep/dir/file-${i}.ts\n`).join(''));
  const out = path.join(b.home, 'piped.json'), pipeline = path.join(b.home, 'pipeline.sh');
  fs.writeFileSync(pipeline, '{ "$1" "$2" ignore --stdin --json < "$3"; echo $? > "$4.status"; } | (sleep 1; cat > "$4")\n');
  const piped = run(b, '/bin/sh', [pipeline, process.execPath, cli, paths, out]);
  assert.equal(piped.status, 0, piped.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(text.length > 128 * 1024, `the answer is larger than any pipe buffer (${text.length} bytes)`);
  assert.equal(JSON.parse(text).paths.length, 3000, 'every path is in the answer');
  assert.equal(fs.readFileSync(`${out}.status`, 'utf8').trim(), '1', 'none is ignored: exit 1, as git check-ignore');
});

test('CLI ignore --check text answers through a slow pipe: -v and the multi-path list arrive whole, with the exit status', { skip: process.platform === 'win32' && 'POSIX sh pipeline' }, t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const paths = path.join(b.home, 'paths');
  fs.writeFileSync(paths, Array.from({ length: 4000 }, (_, i) => `src/some/deep/directory/of/the/workspace/file-${i}.ts\n`).join(''));
  for (const flags of [['-v', '-n'], ['-n']]) {
    const out = path.join(b.home, 'piped' + flags.join('')), pipeline = path.join(b.home, 'pipeline.sh');
    fs.writeFileSync(pipeline, `{ "$1" "$2" ignore --stdin ${flags.join(' ')} < "$3"; echo $? > "$4.status"; } | (sleep 1; cat > "$4")\n`);
    const piped = run(b, '/bin/sh', [pipeline, process.execPath, cli, paths, out]);
    assert.equal(piped.status, 0, piped.stderr);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.length > 128 * 1024, `${flags}: the answer is larger than any pipe buffer (${text.length} bytes)`);
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, 4000, `${flags}: every path is in the answer`);
    assert.ok(lines.at(-1).endsWith('file-3999.ts'), lines.at(-1));
    assert.equal(fs.readFileSync(`${out}.status`, 'utf8').trim(), '1', `${flags}: none is ignored: exit 1`);
  }
});

test('CLI: an answer that cannot be written keeps the exit status the verb set', t => {
  // A reader that closed early (EPIPE) ends the CLI at once; a verb that has already answered and set its exit status
  // (here: none of the paths is ignored, status 1) must not then report a success.
  const b = fixture(t);
  const closed = path.join(b.home, 'closed.cjs');
  fs.writeFileSync(closed, "process.stdout.write = function () { process.nextTick(() => this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' }))); return true; };\n");
  assert.equal(run(b, process.execPath, [cli, 'ignore', '--check', 'a', 'b', '-n']).status, 1);
  assert.equal(run(b, process.execPath, ['--require', closed, cli, 'ignore', '--check', 'a', 'b', '-n']).status, 1);
  assert.equal(run(b, process.execPath, ['--require', closed, cli, 'sessions']).status, 0, 'a verb that set no status still ends with 0');
});

test('CLI: a write that fails on a closed terminal (EIO) is an error in any command but the terminal app', t => {
  // Only the terminal app takes EIO on its terminal as a hangup and ends with 0 (its own tests). Any other command
  // may have been cut off part way, so it ends as on any other write error, with a non-zero status.
  const b = fixture(t);
  const closed = path.join(b.home, 'closed-tty.cjs');
  fs.writeFileSync(closed, "for (const s of [process.stdin, process.stdout]) Object.defineProperty(s, 'isTTY', { value: true }); process.stdout.write = function () { process.nextTick(() => this.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO', errno: -5, syscall: 'write' }))); return true; };\n");
  const r = run(b, process.execPath, ['--require', closed, cli, 'sessions']);
  assert.notEqual(r.status, 0, `exit status ${r.status}`);
  assert.match(String(r.stderr), /write EIO/);
  // The terminal app's one-shot frame (`--once`) is a command's output too: a hangup ends it by its signal, not with 0.
  const once = run(b, process.execPath, ['--require', closed, cli, 'tui', '--once', '--tab', 'observatory']);
  assert.notEqual(once.status, 0, `--once: exit status ${once.status}`);
  assert.match(String(once.stderr), /write EIO/);
});

test('CLI tui --root=dir: the inline form names the workspace, as --root dir does', () => {
  const calls = [];
  const module = { exports: {} };
  const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { getTuiSessionId };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports,
    require: (name) => name === '@oak-observatory/core' ? { defaultTuiSession: (...args) => { calls.push(args); return null; } } : require(name),
    process: { env: {}, cwd: () => '/launch' } });
  for (const args of [['--root=/named'], ['--root', '/named'], []]) module.exports.getTuiSessionId(args);
  assert.deepEqual(calls, [['/named', true], ['/named', true], ['/launch', false]]);
});

test('CLI --root=: an empty inline root is refused by every verb, export and the app alike', t => {
  // It named no workspace: the verbs read it as named (export wrote `"root": ""`), the app as absent.
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  for (const args of [['export', '--root=', '--session', 'fixture-root-session'], ['views', '--json', '--root='], ['--root=']]) {
    const r = run(b, process.execPath, [cli, ...args]);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stderr, 'oak: `--root` requires a path\n', args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
  // Control: a named root still exports, and says so.
  const named = run(b, process.execPath, [cli, 'export', `--root=${b.home}`, '--session', 'fixture-root-session']);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(JSON.parse(named.stdout).root, b.home);
});

test('CLI undo --json and redo --json: the answer is written before the process ends, and the exit status is kept', t => {
  // A stdout that completes its writes later, as a macOS pipe does: process.exit() after the write lost the answer.
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const later = path.join(b.home, 'later-stdout.cjs');
  fs.writeFileSync(later, `const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => { setImmediate(() => write(chunk, encoding, callback)); return true; };\n`);
  for (const verb of ['undo', 'redo']) {
    const r = run(b, process.execPath, ['--require', later, cli, verb, '999', '--session', 'fixture-pipe-session', '--json']);
    assert.equal(r.status, 1, `${verb}: a refusal exits 1 (${r.stderr})`);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, status: 'error', message: 'no edit #999 in this session' }, verb);
  }
});

/** This build laid out as an install, outside any checkout. `oak update` leaves a CLI that runs from a
 *  checkout alone, as the one under test does, so a test of the update itself runs this copy. One per
 *  test process, which nothing writes to. */
let installedCopy;
/** installedCli(), stamped `version` in a copy of its own: this tree's own version is a local build (dev.0) on
 *  `dev`, which `oak update` leaves alone, so a test of an update to another release runs one of these. */
function installedCliAt(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-installed-at-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.dirname(path.dirname(installedCli())), path.join(dir, 'oak-observatory'), { recursive: true });
  const manifest = path.join(dir, 'oak-observatory', 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version }));
  return path.join(dir, 'oak-observatory', 'dist', 'index.js');
}
function installedCli() {
  if (!installedCopy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-installed-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    for (const f of ['package.json', 'dist', 'statusline']) fs.cpSync(path.join(root, 'packages/cli', f), path.join(dir, 'oak-observatory', f), { recursive: true });
    installedCopy = path.join(dir, 'oak-observatory', 'dist', 'index.js');
  }
  return installedCopy;
}

/**
 * `oak update` on a whole setup: this machine's every surface and its saved machines, against a local
 * releases API. The fakes are the editors' own CLIs (they record a call and write the registry the
 * real ones would), the Remote-SSH server binaries, herdr, and ssh (the shared stub, one home per host).
 * Every oak is the installed copy, and npm's global prefix is the fixture's own, here and there.
 */
function updateFixture(t) {
  const b = fixture(t);
  const env = b.env;
  env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  env.npm_config_prefix = path.join(b.home, 'npm-prefix');
  env.APPDATA = path.join(b.home, 'AppData'); // jetbrainsPluginDirs reads it unconditionally
  env.TMPDIR = path.join(b.home, 'tmp');
  fs.mkdirSync(env.TMPDIR);
  const target = JSON.parse(cp.execFileSync(process.execPath, [cli, 'version', '--json'], { env, encoding: 'utf8' })).current;
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version;
  // The release: a CLI tarball npm is never really handed, a .vsix whose bytes are the version it
  // installs, and a real plugin zip.
  const assets = path.join(b.home, 'assets');
  fs.mkdirSync(path.join(assets, 'zip', 'oak-observatory-jetbrains', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(assets, 'oak.tgz'), 'tgz');
  fs.writeFileSync(path.join(assets, 'oak.vsix'), target);
  fs.writeFileSync(path.join(assets, 'zip', 'oak-observatory-jetbrains', 'lib', `oak-observatory-jetbrains-${target}.jar`), 'jar');
  cp.execFileSync('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', path.join(assets, 'jb'), path.join(assets, 'zip')]);
  const sha = (f) => 'sha256:' + require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url.startsWith('/releases')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ tag_name: `v${target}`, prerelease: false, assets: [
        { name: `oak-observatory-${target}.tgz`, browser_download_url: `${base}/a/oak.tgz`, digest: sha(path.join(assets, 'oak.tgz')) },
        { name: `oak-observatory-vscode-v${target}.vsix`, browser_download_url: `${base}/a/oak.vsix`, digest: sha(path.join(assets, 'oak.vsix')) },
        { name: `oak-observatory-jetbrains-v${target}.zip`, browser_download_url: `${base}/a/jb.zip`, digest: sha(path.join(assets, 'jb.zip')) },
      ] }]));
    } else if (['/a/oak.tgz', '/a/oak.vsix', '/a/jb.zip'].includes(req.url)) res.end(fs.readFileSync(path.join(assets, req.url.slice(3))));
    else { res.statusCode = 404; res.end(); }
  });
  t.after(() => srv.close());
  const listening = new Promise((r) => srv.listen(0, '127.0.0.1', r)).then(() => { env.CLAUDE_OBSERVATORY_RELEASES_API = `http://127.0.0.1:${srv.address().port}`; });

  const exe = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 }); };
  // An editor CLI: records the call, and installs the way the real one does — into its own registry.
  const editor = (file, extDir) => exe(file, `echo "$(basename "$0") $*" >> "$HOME/editor.log"
[ "$1" = --install-extension ] || exit 0
mkdir -p "$HOME/${extDir}"
printf '[{"identifier":{"id":"cell-observatory.oak-observatory-vscode"},"version":"%s","metadata":{"source":"vsix"}}]' "$(cat "$2")" > "$HOME/${extDir}/extensions.json"
`);
  const registry = (home, extDir, version, source = 'vsix') => {
    fs.mkdirSync(path.join(home, extDir), { recursive: true });
    fs.writeFileSync(path.join(home, extDir, 'extensions.json'), JSON.stringify([{ identifier: { id: 'cell-observatory.oak-observatory-vscode' }, version, metadata: { source } }]));
  };
  // herdr at the pin, its integrations current: an update has nothing to install there.
  const herdr = (file) => exe(file, `case "$*" in
  --version) echo "herdr ${pin}" ;;
  "integration status") printf 'claude: current (v1)\\ncodex: current (v1)\\n' ;;
  "machine list --json") printf '%s' "$MACHINE_EXEC_MACHINES" ;;
esac
exit 0
`);
  const bin = path.join(b.home, 'bin');
  editor(path.join(bin, 'code'), '.vscode/extensions');
  editor(path.join(bin, 'cursor'), '.cursor/extensions');
  herdr(path.join(bin, 'herdr'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'), path.join(bin, 'ssh'));
  fs.chmodSync(path.join(bin, 'ssh'), 0o755);
  env.PATH = bin + path.delimiter + env.PATH;
  env.MACHINE_EXEC_LOG = path.join(b.home, 'machine-exec.log');
  env.FAKE_REMOTE_ROOT = path.join(b.home, 'remotes');

  // This machine. VS Code and Cursor's server are behind; Cursor came from a marketplace, which on the
  // stable channel owns its updates; VS Code's server is current; two IDEs (one the installers never
  // name) have an old plugin.
  registry(b.home, '.vscode/extensions', '0.10.0');
  registry(b.home, '.cursor/extensions', '0.10.0', 'gallery');
  registry(b.home, '.cursor-server/extensions', '0.10.0');
  editor(path.join(b.home, '.cursor-server/bin/linux-x64/abc123/bin/cursor-server'), '.cursor-server/extensions');
  registry(b.home, '.vscode-server/extensions', target);
  editor(path.join(b.home, '.vscode-server/cli/servers/Stable-abc123/server/bin/code-server'), '.vscode-server/extensions');
  const ides = ['PyCharm2026.1', 'CLion2026.1'].map((ide) => path.join(b.home, '.local/share/JetBrains', ide));
  for (const ide of ides) {
    fs.mkdirSync(path.join(ide, 'oak-observatory-jetbrains', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(ide, 'oak-observatory-jetbrains', 'lib', 'oak-observatory-jetbrains-0.10.0.jar'), 'old');
  }
  // Capture hooks written by a build that knew one event fewer, and the bundled status line, edited.
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  assert.equal(run(b, process.execPath, [cli, 'init', '--no-codex']).status, 0);
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  delete s.hooks.SubagentStop;
  fs.writeFileSync(settings, JSON.stringify(s));
  const installer = path.join(root, 'packages/cli/statusline/install-statusline.sh');
  assert.equal(run(b, 'bash', [installer]).status, 0);
  const script = path.join(env.CLAUDE_CONFIG_DIR, 'statusline.sh');
  fs.appendFileSync(script, '# an older build\n');

  // The saved machines, one home each: OAK current; a stale server extension; no OAK; an OAK from
  // before `update --here`; one that never answers; and one disabled in herdr.
  const remote = (host) => path.join(env.FAKE_REMOTE_ROOT, host);
  const remoteOak = (host) => {
    exe(path.join(remote(host), '.local/bin/oak'), `export CLAUDE_OBSERVATORY_RELEASES_API="$API" TMPDIR="$HOME/tmp" npm_config_prefix="$HOME/npm-prefix"\nmkdir -p "$HOME/tmp"\nexec "${process.execPath}" "${installedCli()}" "$@"\n`);
    herdr(path.join(remote(host), '.local/bin/herdr'));
  };
  remoteOak('current');
  // An editor there without our extension: `update` never installs into it, so it is not work left.
  editor(path.join(remote('current'), '.local/bin/code'), '.vscode/extensions');
  remoteOak('stale');
  registry(remote('stale'), '.vscode-server/extensions', '0.10.0');
  editor(path.join(remote('stale'), '.vscode-server/cli/servers/Stable-abc123/server/bin/code-server'), '.vscode-server/extensions');
  fs.mkdirSync(remote('bare'), { recursive: true });
  fs.mkdirSync(path.join(remote('legacy'), '.local/bin'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'), path.join(remote('legacy'), '.local/bin/oak'));
  fs.chmodSync(path.join(remote('legacy'), '.local/bin/oak'), 0o755);
  // Never answers while the test runs; its home's removal at the end stops it, so nothing outlives the test.
  exe(path.join(remote('slow'), '.local/bin/oak'), 'while [ -d "$HOME" ]; do sleep 0.2; done\n');
  const machine = (label, enabled = true) => ({ id: label, label, target: `me@${label}`, session: 'default', enabled, selected: false });
  const machines = (...labels) => { env.MACHINE_EXEC_MACHINES = JSON.stringify(labels.map((l) => (l === 'off' ? machine(l, false) : machine(l)))); };

  const oak = async (args, extra = {}) => {
    await listening;
    // The remote's oak finds the mock API through its own environment: the ssh stub passes nothing on.
    for (const host of ['current', 'stale']) {
      const f = path.join(remote(host), '.local/bin/oak');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"\$API"|"http:\/\/127[^"]*"/, `"${env.CLAUDE_OBSERVATORY_RELEASES_API}"`));
    }
    return new Promise((resolve) => cp.execFile(process.execPath, [installedCli(), 'update', ...args], { env: { ...env, ...extra }, cwd: b.home, encoding: 'utf8', timeout: 120000 },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
  };
  const editorLog = (home = b.home) => (fs.existsSync(path.join(home, 'editor.log')) ? fs.readFileSync(path.join(home, 'editor.log'), 'utf8') : '');
  const regVersion = (home, extDir) => JSON.parse(fs.readFileSync(path.join(home, extDir, 'extensions.json'), 'utf8'))[0].version;
  const jars = () => ides.map((ide) => fs.readdirSync(path.join(ide, 'oak-observatory-jetbrains', 'lib')));
  const hookEntries = () => realCore.CAPTURE_HOOK_EVENTS.filter((e) => JSON.stringify(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.[e] ?? []).includes('oak capture')).length;
  // Each ssh's arguments, and the remote commands ssh was handed, per host.
  const sshArgv = (host) => (fs.existsSync(env.MACHINE_EXEC_LOG) ? fs.readFileSync(env.MACHINE_EXEC_LOG, 'utf8') : '')
    .split(/^ssh\n/m).slice(1).map((c) => c.slice(0, c.indexOf('\n.\n')).split('\n')).filter((a) => a.includes(`me@${host}`));
  const sshTo = (host) => sshArgv(host).map((a) => a[a.length - 1]);
  return { b, target, oak, machines, remote, editorLog, regVersion, jars, hookEntries, script, installer, sshArgv, sshTo };
}

test('CLI update: one plan for this machine and every saved machine, then each surface updated once', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  const f = updateFixture(t);
  const { b, target } = f;
  const row = (out, label) => (out.match(new RegExp(`^  ${label.replace(/[\\()]/g, '\\$&')}\\s{2,}(.*)$`, 'm')) ?? [])[1];
  const result = (out) => out.slice(out.indexOf('\nResult\n')); // the rows after the update, not the plan's

  // The plan, before anything is touched. The machine that never answers is a timeout row, not a hang.
  f.machines('current', 'stale', 'bare', 'legacy', 'slow', 'off');
  const started = Date.now();
  const check = await f.oak(['--check'], { OAK_MACHINE_TIMEOUT_MS: '8000' });
  assert.equal(check.status, 0, check.stderr);
  assert.ok(Date.now() - started < 30000, `the silent machine is cut off by its deadline (${Date.now() - started} ms)`);
  assert.match(check.stdout, /^Plan$/m);
  assert.equal(row(check.stdout, 'VS Code'), `0.10.0 → ${target}`);
  assert.equal(row(check.stdout, 'VS Code server'), `current (${target})`);
  assert.equal(row(check.stdout, 'Cursor server'), `0.10.0 → ${target}`, 'a Remote-SSH server is its own row');
  assert.match(row(check.stdout, 'Cursor'), /installed from a marketplace, which updates it/);
  assert.equal(row(check.stdout, 'JetBrains (PyCharm2026.1)'), `0.10.0 → ${target}`);
  assert.equal(row(check.stdout, 'JetBrains (CLion2026.1)'), `0.10.0 → ${target}`, 'every JetBrains product with the plugin');
  assert.match(row(check.stdout, 'Claude Code capture hooks'), new RegExp(`settings\\.json: ${realCore.HEALTHY_HOOK_ENTRIES - 1} of ${realCore.HEALTHY_HOOK_ENTRIES} events`));
  assert.equal(row(check.stdout, 'status line'), 'older than this build’s script');
  assert.equal(row(check.stdout, 'herdr'), `current (${JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version})`);
  assert.equal(row(check.stdout, 'machine current'), `current (${target})`);
  assert.equal(row(check.stdout, 'machine stale'), `VS Code server 0.10.0 → ${target}`);
  assert.match(row(check.stdout, 'machine bare'), /OAK is not installed there — `oak machine add bare me@bare` installs it/);
  assert.match(row(check.stdout, 'machine legacy'), /predates `oak update --here` — run `oak update` there once/);
  assert.match(row(check.stdout, 'machine slow'), /no answer within 8 s/);
  assert.equal(row(check.stdout, 'machine off'), 'disabled in herdr — skipped');
  assert.equal(f.editorLog(), '', '--check installs nothing');
  assert.equal(f.editorLog(f.remote('stale')), '', '…here or there');

  // --json: the same plan as data, read-only; --here leaves the machines out.
  f.machines('current', 'stale', 'bare', 'legacy', 'off');
  const plan = JSON.parse((await f.oak(['--json'])).stdout);
  assert.deepEqual(plan.machines.map((m) => [m.label, m.state]), [['current', 'current'], ['stale', 'update'], ['bare', 'no-oak'], ['legacy', 'old-oak'], ['off', 'disabled']]);
  assert.equal(plan.machines[1].plan.surfaces.find((s) => s.label === 'VS Code server').reason, 'behind', "a machine's row carries its own plan");
  assert.deepEqual(plan.components.map((c) => [c.id, c.state]), [['hooks', 'update'], ['codex-hooks', 'absent'], ['statusline', 'update'], ['herdr', 'current'], ['focus-server', 'current']]);
  assert.equal(plan.surfaces.find((s) => s.label === 'Cursor').reason, 'managed');
  assert.equal(plan.upToDate, false);
  const herePlan = JSON.parse((await f.oak(['--json', '--here'])).stdout);
  assert.equal(herePlan.machines, undefined);
  assert.equal(f.editorLog(), '', '--json installs nothing');

  // The update: every stale surface once, the marketplace's install and the current server never; the
  // machine with work updated by its own oak; a failure on one machine stops none of the rest.
  const run1 = await f.oak([]);
  assert.equal(run1.status, 1, 'an OAK too old to update is a failure the exit code reports');
  assert.match(run1.stderr, /could not update machine legacy \(its OAK predates `oak update --here` — run `oak update` there once\) — see the table above/);
  assert.match(run1.stdout, /^Plan$[\s\S]*^Result$/m);
  assert.deepEqual(f.editorLog().trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' ')).sort(), ['code --install-extension', 'cursor-server --install-extension']);
  assert.equal(f.regVersion(b.home, '.vscode/extensions'), target);
  assert.equal(f.regVersion(b.home, '.cursor-server/extensions'), target);
  assert.equal(f.regVersion(b.home, '.cursor/extensions'), '0.10.0', 'the marketplace install is left to the marketplace');
  assert.deepEqual(f.jars(), [[`oak-observatory-jetbrains-${target}.jar`], [`oak-observatory-jetbrains-${target}.jar`]]);
  assert.equal(f.hookEntries(), realCore.HEALTHY_HOOK_ENTRIES, 'the hooks gained the event the old build lacked');
  assert.match(row(result(run1.stdout), 'Claude Code capture hooks'), /^updated — repaired to all \d+ events$/);
  assert.equal(row(result(run1.stdout), 'status line'), 'updated — refreshed to this build');
  assert.doesNotMatch(fs.readFileSync(f.script, 'utf8'), /an older build/);
  assert.equal(f.regVersion(f.remote('stale'), '.vscode-server/extensions'), target, 'the stale machine updated itself');
  assert.equal(row(result(run1.stdout), 'machine stale'), `updated to ${target}`);
  assert.equal(row(result(run1.stdout), 'machine current'), `current (${target})`);
  assert.match(row(result(run1.stdout), 'machine bare'), /OAK is not installed there/);
  assert.equal(f.sshTo('current').filter((c) => c.includes('; s=$?;')).length, 0, 'a current machine is not asked to update');
  assert.equal(f.sshTo('stale').filter((c) => c.includes('; s=$?;')).length, 1, '…and a stale one is, once');
  assert.ok(f.sshTo('stale').every((c) => c.startsWith(`env PATH="${realCore.MACHINE_PATH}" `)), 'through the shared remote PATH');

  // Again: nothing left to do anywhere, so nothing is touched and the exit code is clean.
  f.machines('current', 'stale', 'bare', 'off');
  const before = { here: f.editorLog(), there: f.editorLog(f.remote('stale')), script: fs.readFileSync(f.script, 'utf8') };
  const run2 = await f.oak([]);
  assert.equal(run2.status, 0, run2.stderr);
  assert.match(run2.stdout, new RegExp(`everything is up to date \\(${target.replace(/[\\.]/g, '\\$&')}\\)`));
  assert.deepEqual({ here: f.editorLog(), there: f.editorLog(f.remote('stale')), script: fs.readFileSync(f.script, 'utf8') }, before, 'idempotent: no install runs twice');
  for (const label of ['VS Code', 'Cursor server', 'JetBrains (PyCharm2026.1)', 'machine stale', 'machine current'])
    assert.match(row(result(run2.stdout), label), /^current \(/, label);
  assert.equal(row(result(run2.stdout), 'status line'), 'current (this build’s script)');
});

test('CLI update: a foreign status line and an uninstalled hook are never touched', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  const f = updateFixture(t);
  f.machines();
  const settings = path.join(f.b.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'ccusage statusline' } }));
  const plan = JSON.parse((await f.oak(['--json', '--here'])).stdout);
  assert.deepEqual(plan.components.filter((c) => ['hooks', 'statusline'].includes(c.id)).map((c) => c.state), ['absent', 'absent']);
  await f.oak(['--here', '--cli-only']);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { statusLine: { type: 'command', command: 'ccusage statusline' } });
});

test('CLI __after-update: the installed CLI reports what it did to the one that ran the update', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  const f = updateFixture(t);
  // Codex hooks whose trust state is gone (codex then skips them silently): reinstalled and trusted.
  assert.equal(run(f.b, process.execPath, [cli, 'init', '--codex']).status, 0);
  fs.rmSync(path.join(f.b.env.CODEX_HOME, 'config.toml'));
  const report = path.join(f.b.home, 'report.json');
  const r = run(f.b, process.execPath, [cli, '__after-update'], { env: { ...f.b.env, OAK_UPDATE_REPORT: report }, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepEqual(rows.map((c) => [c.id, c.state]), [['hooks', 'updated'], ['codex-hooks', 'updated'], ['statusline', 'updated'], ['herdr', 'current'], ['focus-server', 'current']]);
  assert.equal(f.hookEntries(), realCore.HEALTHY_HOOK_ENTRIES);
  // npm installs a release on a Node older than its engines with only an EBADENGINE warning, so the update says, as it
  // finishes, what that Node leaves out (simulated here: its node:sqlite missing). A Node that runs the index hears nothing.
  assert.equal(/Local database/.test(r.stdout), !realCore.indexRuntime().ok, 'nothing said where this Node runs the index');
  const old = run(f.b, process.execPath, [cli, '__after-update'], { env: { ...f.b.env, OAK_INDEX_TEST_MODULE: 'oak-no-such-sqlite' }, timeout: 60000 });
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /Local database: this Node \(v[\d.]+\) has no node:sqlite; the database needs Node\.js 24 or newer/);
  assert.match(old.stdout, /→ Install Node\.js 24 or newer \(this is v[\d.]+\)\./);
});

test('CLI update: stopped while its saved machines run, it stops each ssh it started there', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // An editor's deadline sends the CLI SIGTERM; a terminal sends ctrl+c, ctrl+\ or a hangup to the whole job;
  // an uncaught exception ends it with no signal. Each ssh records its own pid, never answers, and ends as
  // OpenSSH does once its session is up: SIGINT, SIGHUP, SIGQUIT or SIGTERM, noted, end it with status 255.
  // Left running after the CLI is gone, it would keep that machine's update going under init. (`ssh -G`, the
  // configuration read before each, answers at once.)
  const f = updateFixture(t);
  f.machines('one', 'two');
  await f.oak(['--json', '--here']); // the mock release feed is up
  const pids = path.join(f.b.home, 'ssh.pids'), signals = path.join(f.b.home, 'ssh.signals');
  fs.writeFileSync(path.join(f.b.home, 'bin', 'ssh'), `#!/bin/sh\n[ "$1" = -G ] && exit 0\n` +
    `for s in INT HUP QUIT TERM; do trap "echo $s >> '${signals}'; exit 255" $s; done\necho "$$" >> '${pids}'\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 });
  const throws = path.join(f.b.home, 'throws.cjs');
  fs.writeFileSync(throws, `if (process.argv[1] === ${JSON.stringify(cli)}) {
  const t = setInterval(() => { try { if (require('fs').readFileSync(${JSON.stringify(pids)}, 'utf8').trim().split('\\n').length < 2) return; } catch { return; }
    clearInterval(t); throw new Error('fixture: an uncaught exception while both ssh run'); }, 20);
  t.unref();
}
`);
  const alive = (pid) => { try { process.kill(pid, 0); } catch { return false; } return !/Z/.test(cp.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout); };
  const seen = new Set(); // every ssh started, killed at the end whatever the assertions said
  const ssh = () => { const now = fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []; now.forEach((p) => seen.add(p)); return now; };
  t.after(() => { for (const pid of seen) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  for (const how of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'an uncaught exception']) await t.test(how, { skip: how === 'SIGQUIT' && noQuitHere() }, async () => {
    for (const file of [pids, signals]) fs.rmSync(file, { force: true });
    const signal = how.startsWith('SIG') ? how : null;
    // Its own process group, as a shell gives each job, so the test can signal the job the way a terminal does.
    const [file, ...args] = withoutCore([process.execPath, cli, 'update', '--check']);
    const child = cp.spawn(file, args, { env: signal ? f.b.env : { ...f.b.env, NODE_OPTIONS: `--require ${throws}` }, cwd: f.b.home, stdio: 'ignore', detached: true });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ended */ } });
    const exited = new Promise((resolve) => child.on('exit', (status, sig) => resolve({ status, sig })));
    for (const end = Date.now() + 15000; Date.now() < end && ssh().length < 2;) await new Promise((r) => setTimeout(r, 50));
    assert.equal(ssh().length, 2, 'one ssh per saved machine is running');
    if (signal) process.kill(signal === 'SIGTERM' ? child.pid : -child.pid, signal);
    assert.deepEqual(await exited, signal ? { status: null, sig: signal } : { status: 1, sig: null }, `${how}: it ends as that ends it, so a shell loop around it stops`);
    for (const end = Date.now() + 3000; Date.now() < end && ssh().some(alive);) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ssh().filter(alive), [], `${how}: no ssh is left running`);
    const noted = () => (fs.existsSync(signals) ? fs.readFileSync(signals, 'utf8') : '');
    for (const end = Date.now() + 3000; Date.now() < end && noted().length < 10;) await new Promise((r) => setTimeout(r, 50));
    assert.equal(noted(), 'TERM\nTERM\n', `${how}: the CLI stopped each ssh, and the job's signal never reached one`);
  });
});

test('CLI update: its signal handlers stand only while an ssh to a saved machine runs', () => {
  // Between its machine steps, a signal ends the update as it always has, at once.
  const { EventEmitter } = require('node:events');
  const code = ts.transpileModule(source.replace(/main\(\);\s*$/, 'module.exports = { stopWithUpdate };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // A list, not a map: a handler registered twice would run twice. A signal raised with no handler left ends
  // the process at once, so nothing after the raise runs: here it throws.
  const listeners = [], raised = [], module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, require,
    process: { env: {}, stdout: { isTTY: false }, stderr: { write() {} }, platform: 'linux', pid: 4242,
      once: (signal, fn) => listeners.push([signal, fn]),
      off: (signal, fn) => { const i = listeners.findIndex(([s, f]) => s === signal && f === fn); if (i >= 0) listeners.splice(i, 1); },
      kill: (pid, signal) => { raised.push(signal); throw new Error(`raised ${signal} at ${pid}`); } } });
  const { stopWithUpdate } = module.exports;
  // `killed`, as Node's: set once a signal was sent.
  const ssh = () => Object.assign(new EventEmitter(), { killed: false, sent: [], kill(signal) { this.sent.push(signal ?? 'SIGTERM'); this.killed = true; return true; } });
  const [one, two, three] = [ssh(), ssh(), ssh()];
  stopWithUpdate(one);
  stopWithUpdate(two);
  assert.deepEqual(listeners.map(([s]) => s).sort(), ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM', 'exit'], 'one handler per signal, and one for any other exit, however many ssh run');
  one.emit('close', 0, null);
  assert.equal(listeners.length, 5, 'while one still runs');
  assert.throws(() => listeners.find(([s]) => s === 'SIGINT')[1](), /raised SIGINT at 4242/);
  assert.deepEqual([one.sent, two.sent], [[], ['SIGTERM']], 'the running ssh is stopped before the signal is raised again, which ends the process');
  // Any other exit (an uncaught exception, or Windows' process.exit once a signal's handler has run) stops each
  // ssh no handler has stopped, and no other.
  stopWithUpdate(three);
  listeners.find(([s]) => s === 'exit')[1]();
  assert.deepEqual([two.sent, three.sent], [['SIGTERM'], ['SIGTERM']], 'each ssh is stopped once');
  two.emit('close', null, 'SIGTERM');
  three.emit('close', null, 'SIGTERM');
  assert.equal(listeners.length, 0, 'none once every ssh has closed');
  assert.deepEqual(raised, ['SIGINT'], 'an ssh that closes raises nothing');
});

test('CLI update: where herdr publishes no build, herdr is left alone and the update still succeeds', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // Linux on armv7, as Windows on ARM and any other platform herdr ships nothing for: no herdr here, and
  // none to download. Planned as work, it was a failed row and exit 1 on every run.
  const f = updateFixture(t);
  f.machines();
  fs.rmSync(path.join(f.b.home, 'bin', 'herdr'));
  f.b.env.PATH = [path.join(f.b.home, 'bin'), '/usr/bin', '/bin'].join(path.delimiter);
  assert.equal(realCore.findHerdrBin({ env: f.b.env, home: f.b.home }), null, 'no herdr on this PATH or in this home');
  const arm = path.join(f.b.home, 'armv7.cjs');
  fs.writeFileSync(arm, "Object.defineProperty(process, 'arch', { value: 'arm' });\n");
  const onArm = { NODE_OPTIONS: `--require ${arm}` };
  const plan = JSON.parse((await f.oak(['--json', '--here'], onArm)).stdout);
  assert.deepEqual(plan.components.find((c) => c.id === 'herdr'), { id: 'herdr', label: 'herdr', state: 'absent', detail: 'herdr publishes no build for this platform' });
  const r = await f.oak(['--here', '--cli-only'], onArm);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.slice(r.stdout.indexOf('\nResult\n')), /^ {2}herdr\s+herdr publishes no build for this platform$/m);
  assert.equal(fs.existsSync(path.join(f.b.home, '.local', 'bin', 'herdr')), false, 'nothing was installed');
});

test('CLI update: a Codex hook turned off in Codex is left off, and only a changed hash is reinstalled', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  const f = updateFixture(t);
  f.machines();
  assert.equal(run(f.b, process.execPath, [cli, 'init', '--codex']).status, 0);
  const cfg = path.join(f.b.env.CODEX_HOME, 'config.toml');
  // Turned off in Codex: `enabled = false` in the state table of one of OAK's hooks.
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/(:post_tool_use:0:0"\]\ntrusted_hash = "[^"]*")/, '$1\nenabled = false'));
  const turnedOff = fs.readFileSync(cfg, 'utf8');
  assert.match(turnedOff, /enabled = false/);
  const codexRow = async () => JSON.parse((await f.oak(['--json', '--here'])).stdout).components.find((c) => c.id === 'codex-hooks');
  assert.deepEqual(await codexRow(), { id: 'codex-hooks', label: 'Codex capture hooks', state: 'current', detail: 'PostToolUse turned off in Codex — left alone' });
  const status = run(f.b, process.execPath, [cli, 'status']);
  assert.match(status.stdout, /^codex hooks: +installed → .*trusted\n +turned off in Codex: PostToolUse$/m, 'status says which hook is off, apart from trust');
  let r = await f.oak(['--here', '--cli-only']);
  assert.equal(r.status, 0, r.stderr);
  // (The status line refresh appends Codex's own status line settings; nothing above them moves.)
  assert.ok(fs.readFileSync(cfg, 'utf8').startsWith(turnedOff), 'the update rewrote no hook state');
  // Another hook's hash drifted: that is work, and the reinstall keeps the switch where the user left it.
  fs.writeFileSync(cfg, turnedOff.replace(/(:stop:0:0"\]\ntrusted_hash = "sha256:)[0-9a-f]{8}/, (_, head) => head + '00000000'));
  assert.equal((await codexRow()).state, 'update');
  r = await f.oak(['--here', '--cli-only']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.slice(r.stdout.indexOf('\nResult\n')), /^ {2}Codex capture hooks\s+updated — reinstalled and trusted$/m);
  const states = require('smol-toml').parse(fs.readFileSync(cfg, 'utf8')).hooks.state;
  const off = Object.entries(states).filter(([, s]) => s.enabled === false).map(([k]) => k.split(':').slice(-3)[0]);
  assert.deepEqual(off, ['post_tool_use'], 'the hook the user turned off is still off');
  assert.deepEqual(await codexRow(), { id: 'codex-hooks', label: 'Codex capture hooks', state: 'current', detail: 'PostToolUse turned off in Codex — left alone' });
});

test('CLI update: the installed CLI\'s setup step failing is a failed row and a non-zero exit', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // npm installs the release, then that CLI finishes the update (`__after-update`). One that crashes there
  // set nothing up, which the update used to report as success.
  const b = fixture(t);
  const env = b.env;
  env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  env.TMPDIR = path.join(b.home, 'tmp');
  fs.mkdirSync(env.TMPDIR);
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version;
  // The release's CLI, already where npm's global prefix keeps it: its entry point is the setup step.
  const prefix = path.join(b.home, 'prefix');
  const pkg = path.join(prefix, 'lib', 'node_modules', 'oak-observatory');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oak-observatory', version: '9.9.9', bin: { oak: 'dist/index.js' } }));
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin);
  // npm: no pre-rename package, an install that succeeds, and the global prefix.
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\ncase "$1" in ls) exit 1 ;; exec) echo "${prefix}" ;; esac\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncase "$*" in --version) echo "herdr ${pin}" ;; "integration status") printf 'claude: current (v1)\\ncodex: current (v1)\\n' ;; esac\nexit 0\n`, { mode: 0o755 });
  env.PATH = bin + path.delimiter + env.PATH;
  const sha = 'sha256:' + require('crypto').createHash('sha256').update('tgz').digest('hex');
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    res.end(req.url.startsWith('/releases')
      ? JSON.stringify([{ tag_name: 'v9.9.9', prerelease: false, assets: [{ name: 'oak-observatory-9.9.9.tgz', browser_download_url: `${base}/a/x.tgz`, digest: sha }] }])
      : 'tgz');
  });
  t.after(() => srv.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  env.CLAUDE_OBSERVATORY_RELEASES_API = `http://127.0.0.1:${srv.address().port}`;
  const update = () => new Promise((resolve) => cp.execFile(process.execPath, [installedCliAt('9.9.8'), 'update', '--here', '--cli-only'], { env, cwd: b.home, encoding: 'utf8', timeout: 60000 },
    (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
  const setupRow = (out) => (out.slice(out.indexOf('\nResult\n')).match(/^ {2}OAK setup\s+(.*)$/m) ?? [])[1];

  fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), 'console.error("TypeError: boom"); process.exit(1);\n');
  const failed = await update();
  assert.equal(failed.status, 1, failed.stdout);
  assert.equal(setupRow(failed.stdout), 'failed — the installed CLI’s setup step failed — run `oak doctor --fix`');
  assert.match(failed.stderr, /could not update OAK setup \(the installed CLI’s setup step failed — run `oak doctor --fix`\) — see the table above/);
  // One that set part of it up before it failed: the rows it reported stay, beside the failure.
  fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), "require('fs').writeFileSync(process.env.OAK_UPDATE_REPORT, JSON.stringify([{ id: 'statusline', label: 'status line', state: 'updated', detail: 'refreshed to this build' }])); process.exit(1);\n");
  const partly = await update();
  assert.equal(partly.status, 1, partly.stdout);
  assert.match(partly.stdout.slice(partly.stdout.indexOf('\nResult\n')), /^ {2}status line\s+updated — refreshed to this build$/m);
  assert.equal(setupRow(partly.stdout), 'failed — the installed CLI’s setup step failed — run `oak doctor --fix`');
  // The control: a release that sets itself up and reports nothing (one older than the report) still passes.
  fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), 'process.exit(0);\n');
  const quiet = await update();
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(setupRow(quiet.stdout), 'set up by the installed CLI, which reports no detail — `oak doctor` checks it');
});

test('CLI update: saved machines that share an ssh target are asked and updated once, and each row shows the answer', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // One host saved twice (a machine per herdr session there): two updates at once on one home would race.
  const f = updateFixture(t);
  const machine = (label, session) => ({ id: label, label, target: 'me@stale', session, enabled: true, selected: false });
  f.b.env.MACHINE_EXEC_MACHINES = JSON.stringify([machine('a', 'default'), machine('b', 'other')]);
  // A ControlMaster with no ControlPersist: every ssh the update runs stays out of it (see --machine).
  f.b.env.SSH_FAKE_G = 'controlmaster auto\ncontrolpersist no\n';
  f.b.env.SSH_G_LOG = path.join(f.b.home, 'ssh-G.log');
  // Nor does any ask in a dialog (see --machine), whatever the caller asked for.
  f.b.env.SSH_ASKPASS_REQUIRE = 'force';
  f.b.env.SSH_ASKPASS_LOG = path.join(f.b.home, 'ssh-askpass.log');
  const planReads = () => f.sshTo('stale').filter((c) => !c.includes('; s=$?;')).length;
  const updates = () => f.sshTo('stale').filter((c) => c.includes('; s=$?;')).length;
  const plan = JSON.parse((await f.oak(['--json'])).stdout);
  assert.deepEqual(plan.machines.map((m) => [m.label, m.state, m.detail]), [['a', 'update', `VS Code server 0.10.0 → ${f.target}`], ['b', 'update', `VS Code server 0.10.0 → ${f.target}`]]);
  assert.equal(planReads(), 1, 'its plan is read once');
  const r = await f.oak([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(updates(), 1, 'and it is updated once');
  const result = r.stdout.slice(r.stdout.indexOf('\nResult\n'));
  for (const label of ['a', 'b']) assert.match(result, new RegExp(`^ {2}machine ${label}\\s+updated to ${f.target.replace(/[\\.]/g, '\\$&')}$`, 'm'), label);
  assert.ok(f.sshArgv('stale').every((argv) => argv.join(' ').includes('-o ControlMaster=no')), 'no ssh of the update becomes that master');
  assert.deepEqual(fs.readFileSync(f.b.env.SSH_G_LOG, 'utf8').trim().split('\n'), ['me@stale', 'me@stale'], 'ssh -G once per target in each run: the plan read, then the update');
  const asks = fs.readFileSync(f.b.env.SSH_ASKPASS_LOG, 'utf8').trim().split('\n');
  assert.deepEqual([asks.filter((l) => l.startsWith('G ')).length, asks.length], [2, 2 + f.sshArgv('stale').length], asks.join('\n'));
  assert.ok(asks.every((l) => l.endsWith(' never')), asks.join('\n'));
});

test('CLI update: a saved machine ssh cannot reach is named with the reason ssh gives, past a stale control socket', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // With ControlMaster=no, a stale control socket is reported first, and ssh then connects directly: the
  // reason is what that connection said.
  const f = updateFixture(t);
  f.machines('down');
  f.b.env.SSH_FAKE_DOWN = 'me@down';
  f.b.env.SSH_FAKE_STDERR = 'Control socket connect(/home/user/.ssh/cm-down): Connection refused\nssh: connect to host down port 22: No route to host';
  const [m] = JSON.parse((await f.oak(['--json'])).stdout).machines;
  assert.deepEqual([m.state, m.detail], ['unreachable', 'not reachable over ssh (me@down): ssh: connect to host down port 22: No route to host']);
});

test('CLI update --force: a saved machine reinstalls, then reads the plan it is left with unforced, for itself alone', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  const f = updateFixture(t);
  f.machines('current');
  // npm, here and there: no pre-rename package, an install that succeeds, and a global prefix whose CLI
  // finishes the update with an empty report.
  const npm = '#!/bin/sh\necho "npm $*" >> "$HOME/npm.log"\ncase "$1" in ls) exit 1 ;; exec) echo "$HOME/npm-prefix" ;; esac\nexit 0\n';
  for (const [home, dir] of [[f.b.home, 'bin'], [f.remote('current'), '.local/bin']]) {
    const pkg = path.join(home, 'npm-prefix', 'lib', 'node_modules', 'oak-observatory');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oak-observatory', version: f.target, bin: { oak: 'dist/index.js' } }));
    fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), "require('fs').writeFileSync(process.env.OAK_UPDATE_REPORT, '[]');\n");
    fs.writeFileSync(path.join(home, dir, 'npm'), npm, { mode: 0o755 });
  }
  // The machine's herdr notes when it is asked for that machine's own saved machines.
  const herdr = path.join(f.remote('current'), '.local', 'bin', 'herdr');
  fs.renameSync(herdr, herdr + '.real');
  fs.writeFileSync(herdr, `#!/bin/sh\n[ "$*" = "machine list --json" ] && echo asked >> "$HOME/machine-list.log"\nexec '${herdr}.real' "$@"\n`, { mode: 0o755 });
  const r = await f.oak(['--force', '--channel', 'stable']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(f.remote('current'), 'npm.log'), 'utf8'), /^npm i -g /m, 'the machine reinstalled its CLI: --force reached it');
  assert.match(r.stdout.slice(r.stdout.indexOf('\nResult\n')), new RegExp(`^ {2}machine current\\s+updated to ${f.target.replace(/[\\.]/g, '\\$&')}$`, 'm'), 'nothing reads as still to do');
  const [sent] = f.sshTo('current').filter((c) => c.includes('; s=$?;'));
  // The script travels inside `sh -c '…'`, where each quote of its own reads '\''.
  assert.match(sent.replace(/'\\''/g, "'"), /oak update --here '--channel' 'stable' '--force' >&2; s=\$\?; oak update --here --json '--channel' 'stable'; \(exit "\$s"\)/, 'the read after it carries the channel and nothing else');
  assert.equal(fs.existsSync(path.join(f.remote('current'), 'machine-list.log')), false, 'the machine was never asked about its own saved machines');
});

test('CLI update --cli-only: the CLI and its setup on this machine, and no saved machine is asked', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  const f = updateFixture(t);
  f.machines('current', 'stale');
  const check = await f.oak(['--cli-only', '--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.doesNotMatch(check.stdout, /^ {2}machine /m);
  assert.equal(JSON.parse((await f.oak(['--cli-only', '--json'])).stdout).machines, undefined);
  assert.deepEqual([...f.sshTo('current'), ...f.sshTo('stale')], [], 'no ssh to any saved machine');
});

test('CLI update: repairs the hooks in the user\'s settings, and names the repair a project\'s own settings need without writing there', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // A repository's .claude/settings.json is committed and shared: `oak update` writes no file in it, and
  // leaves no backup there. The fixture's user settings lack SubagentStop; so does the project's.
  const f = updateFixture(t);
  f.machines();
  const repo = path.join(f.b.home, 'team-repo');
  fs.mkdirSync(repo);
  assert.equal(run(f.b, process.execPath, [cli, 'init', '--project', '--no-codex'], { cwd: repo }).status, 0);
  const projectFile = path.join(repo, '.claude', 'settings.json');
  const p = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  delete p.hooks.SubagentStop;
  fs.writeFileSync(projectFile, JSON.stringify(p, null, 2) + '\n');
  const before = { files: fs.readdirSync(path.join(repo, '.claude')), text: fs.readFileSync(projectFile, 'utf8') };
  const row = { id: 'project-hooks', label: 'Claude Code project hooks', state: 'manual', detail: `${projectFile} is missing SubagentStop — run \`oak init --repair\` there` };
  const plan = JSON.parse((await f.oak(['--json', '--here'])).stdout);
  assert.deepEqual(plan.components.filter((c) => c.id.endsWith('hooks') && c.id !== 'codex-hooks'), [
    { id: 'hooks', label: 'Claude Code capture hooks', state: 'update', detail: `${path.join(f.b.env.CLAUDE_CONFIG_DIR, 'settings.json')}: ${realCore.HEALTHY_HOOK_ENTRIES - 1} of ${realCore.HEALTHY_HOOK_ENTRIES} events` },
    row,
  ]);
  const r = await f.oak(['--here', '--cli-only']);
  assert.equal(r.status, 0, `the project's row is not a failure: ${r.stderr}`);
  assert.equal(f.hookEntries(), realCore.HEALTHY_HOOK_ENTRIES, 'the user settings were repaired');
  assert.deepEqual({ files: fs.readdirSync(path.join(repo, '.claude')), text: fs.readFileSync(projectFile, 'utf8') }, before, 'nothing written in the repository, no backup left there');
  const result = r.stdout.slice(r.stdout.indexOf('\nResult\n'));
  assert.match(result, /^ {2}Claude Code capture hooks\s+updated — repaired to all \d+ events$/m);
  assert.ok(result.includes(`  Claude Code project hooks  ${row.detail}\n`), result);
  // Run again, with nothing left that the update does: the row stays, and nothing claims all is current.
  const again = await f.oak(['--here', '--cli-only']);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.slice(again.stdout.indexOf('\nResult\n')).includes(`  Claude Code project hooks  ${row.detail}\n`), again.stdout);
  assert.doesNotMatch(again.stdout, /everything is up to date/, 'not while a repair is left to do');
  // `oak init --repair` there still repairs it, as it always has.
  assert.equal(run(f.b, process.execPath, [cli, 'init', '--repair'], { cwd: repo }).status, 0);
  assert.deepEqual(realCore.missingHookEvents(projectFile), []);
  assert.equal(JSON.parse((await f.oak(['--json', '--here'])).stdout).components.some((c) => c.id === 'project-hooks'), false, 'and the row is gone');
  // An entry written twice, with no event missing, is a repair too, and the row says what it found.
  const twice = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  twice.hooks.Stop.push(twice.hooks.Stop[0]);
  fs.writeFileSync(projectFile, JSON.stringify(twice, null, 2) + '\n');
  assert.deepEqual(JSON.parse((await f.oak(['--json', '--here'])).stdout).components.filter((c) => c.id === 'project-hooks').map((c) => c.detail),
    [`${projectFile} has ${realCore.HEALTHY_HOOK_ENTRIES + 1} entries for its ${realCore.HEALTHY_HOOK_ENTRIES} events — run \`oak init --repair\` there`]);
  assert.equal(run(f.b, process.execPath, [cli, 'init', '--repair'], { cwd: repo }).status, 0);

  // A saved machine's project file: its own run can only print the row there, so its machine row says it
  // here: in the plan, after an update ran there, and in place of the line that calls everything current.
  const theirs = (host) => {
    const there = f.remote(host), theirRepo = path.join(there, 'repo');
    fs.mkdirSync(theirRepo);
    const init = cp.spawnSync(process.execPath, [cli, 'init', '--project', '--no-codex'], { cwd: theirRepo, env: { HOME: there, PATH: '/usr/bin:/bin', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' } });
    assert.equal(init.status, 0, String(init.stderr));
    const file = path.join(theirRepo, '.claude', 'settings.json');
    const q = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete q.hooks.Stop;
    fs.writeFileSync(file, JSON.stringify(q));
    return `${file} is missing Stop — run \`oak init --repair\` there`;
  };
  const [current, stale] = [theirs('current'), theirs('stale')];
  f.machines('current', 'stale');
  const planned = JSON.parse((await f.oak(['--json'])).stdout).machines;
  assert.deepEqual(planned.map((m) => [m.state, m.detail]), [['current', `${f.target}; ${current}`], ['update', `VS Code server 0.10.0 → ${f.target}; ${stale}`]]);
  const machineRow = (out, label) => (out.slice(out.indexOf('\nResult\n')).match(new RegExp(`^ {2}machine ${label}\\s{2,}(.*)$`, 'm')) ?? [])[1];
  const updated = await f.oak([]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(machineRow(updated.stdout, 'stale'), `updated to ${f.target}; ${stale}`, 'the repair stays on the row of a machine that updated');
  const settled = await f.oak([]);
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(machineRow(settled.stdout, 'current'), `current (${f.target}; ${current})`);
  assert.equal(machineRow(settled.stdout, 'stale'), `current (${f.target}; ${stale})`);
  assert.doesNotMatch(settled.stdout, /everything is up to date/, 'not while a saved machine has a repair left to do');
});

test('CLI update: a CLI linked to a checkout is left alone and named, here or run from it; an installed copy still updates (2026-10-06)', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // `npm link`, `npm i -g ./packages/cli` and ./install.sh leave npm's global package a link to the checkout.
  // `oak update` installed a release over one, so every `oak` and every hook ran that release's older code,
  // and building the checkout changed nothing.
  const b = fixture(t);
  const env = b.env;
  env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  env.TMPDIR = path.join(b.home, 'tmp');
  fs.mkdirSync(env.TMPDIR);
  const checkout = path.join(b.home, 'src', 'oak');
  makeGitDir(path.join(checkout, '.git'));
  fs.mkdirSync(path.join(checkout, 'packages', 'cli'), { recursive: true });
  fs.copyFileSync(path.join(root, 'packages/cli/package.json'), path.join(checkout, 'packages', 'cli', 'package.json'));
  const prefix = path.join(b.home, 'prefix');
  const global = path.join(prefix, 'lib', 'node_modules', 'oak-observatory');
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.symlinkSync('../../../src/oak/packages/cli', global); // relative, as npm writes it
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin);
  // npm: the global prefix, no pre-rename package, and every install logged.
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\ncase "$1" in ls) exit 1 ;; exec) echo "${prefix}" ;; *) echo "npm $*" >> "$HOME/npm.log" ;; esac\nexit 0\n`, { mode: 0o755 });
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version;
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncase "$*" in --version) echo "herdr ${pin}" ;; "integration status") printf 'claude: current (v1)\\ncodex: current (v1)\\n' ;; esac\nexit 0\n`, { mode: 0o755 });
  env.PATH = bin + path.delimiter + env.PATH;
  let downloads = 0;
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url.startsWith('/releases')) res.end(JSON.stringify([{ tag_name: 'v9.9.9', prerelease: false, assets: [{ name: 'oak-observatory-9.9.9.tgz', browser_download_url: `${base}/a/x.tgz` }] }]));
    else { downloads++; res.end('tgz'); }
  });
  t.after(() => srv.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  env.CLAUDE_OBSERVATORY_RELEASES_API = `http://127.0.0.1:${srv.address().port}`;
  const oak = (entry, args) => new Promise((resolve) => cp.execFile(process.execPath, [entry, ...args], { env, cwd: b.home, encoding: 'utf8', timeout: 60000 },
    (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
  const npmLog = () => (fs.existsSync(path.join(b.home, 'npm.log')) ? fs.readFileSync(path.join(b.home, 'npm.log'), 'utf8') : '');
  const cliRow = (out) => (out.slice(out.indexOf('\nResult\n')).match(/^ {2}CLI\s{2,}(.*)$/m) ?? [])[1];
  const version = JSON.parse(fs.readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8')).version;
  const said = `${version} · linked to the checkout at ${checkout}; update it there (git pull, then npm run build)`;

  // An installed copy runs, and npm's package is the link: the link is what an install would replace.
  const copy = installedCli();
  const plan = JSON.parse((await oak(copy, ['update', '--here', '--cli-only', '--json'])).stdout);
  assert.deepEqual(plan.surfaces.map((s) => [s.reason, s.linked]), [['linked', checkout]]);
  for (const args of [[], ['--force'], ['--channel', 'dev']]) {
    const r = await oak(copy, ['update', '--here', '--cli-only', ...args]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(cliRow(r.stdout), said, args.join(' '));
    assert.doesNotMatch(r.stdout, /everything is up to date/, 'the checkout is its owner\'s to update');
  }
  assert.equal(fs.readlinkSync(global), '../../../src/oak/packages/cli', 'the link is still there, unchanged');
  assert.deepEqual([npmLog(), downloads], ['', 0], 'nothing was downloaded or installed');
  // The version check offers no release to it either, and says why.
  const check = JSON.parse((await oak(copy, ['version', '--check', '--json'])).stdout);
  assert.deepEqual([check.linked, check.updateAvailable, check.stranded], [checkout, false, false]);
  assert.match((await oak(copy, ['version', '--check'])).stdout, new RegExp(`this CLI is linked to the checkout at ${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; update it there \\(git pull, then npm run build\\); \`oak update\` leaves it alone`));

  // The CLI a checkout builds is left alone when it runs, whatever npm's package is.
  fs.rmSync(global);
  fs.mkdirSync(path.join(global, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(global, 'package.json'), JSON.stringify({ name: 'oak-observatory', version: '0.0.1', bin: { oak: 'dist/index.js' } }));
  fs.writeFileSync(path.join(global, 'dist', 'index.js'), "require('fs').writeFileSync(process.env.OAK_UPDATE_REPORT, '[]');\n");
  // This tree is a checkout where it is a git work tree. A source archive (a release's tarball, `git archive`) has no
  // .git, and its CLI is a local build, no checkout's.
  const own = fs.existsSync(path.join(root, '.git')) ? fs.realpathSync(root) : undefined;
  assert.deepEqual(JSON.parse((await oak(cli, ['update', '--here', '--cli-only', '--json'])).stdout).surfaces.map((s) => [s.reason, s.linked]), [[own ? 'linked' : 'local', own]]);
  assert.equal(JSON.parse((await oak(cli, ['version', '--json'])).stdout).linked, own, 'the version chip is told without a network or npm');
  assert.deepEqual([npmLog(), downloads], ['', 0]);

  // The control: an installed copy that npm's package is updates as it always has (one a release can carry).
  const released = installedCliAt('9.9.8');
  assert.equal(JSON.parse((await oak(released, ['version', '--json'])).stdout).linked, undefined);
  assert.equal(JSON.parse((await oak(released, ['version', '--check', '--json'])).stdout).updateAvailable, true);
  const r = await oak(released, ['update', '--here', '--cli-only']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cliRow(r.stdout), 'updated — 9.9.8 → 9.9.9');
  assert.match(npmLog(), /^npm i -g \S+oak-observatory-9\.9\.9\.tgz --allow-scripts=node-pty$/m);
  assert.equal(downloads, 1);
});

test('CLI update: a local build (dev.0, which no release carries) is offered nothing and left alone, unless asked by --force or --channel (2026-10-07)', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // The dev channel offered its rolling build (dev.N) over an install of a checkout's build, and `oak update`
  // replaced it, the CLI, the VS Code extension and the JetBrains plugin alike; on stable, with an older release.
  const b = fixture(t);
  const env = b.env;
  env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  env.APPDATA = path.join(b.home, 'AppData');
  env.TMPDIR = path.join(b.home, 'tmp');
  fs.mkdirSync(env.TMPDIR);
  // An installed copy of a local build, and npm's global package a plain directory (no link, no checkout).
  const local = installedCliAt('9.9.9-dev.0');
  const prefix = path.join(b.home, 'prefix');
  const global = path.join(prefix, 'lib', 'node_modules', 'oak-observatory');
  fs.mkdirSync(path.join(global, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(global, 'package.json'), JSON.stringify({ name: 'oak-observatory', version: '9.9.9-dev.15', bin: { oak: 'dist/index.js' } }));
  fs.writeFileSync(path.join(global, 'dist', 'index.js'), "require('fs').writeFileSync(process.env.OAK_UPDATE_REPORT, '[]');\n");
  const bin = path.join(b.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\ncase "$1" in ls) exit 1 ;; exec) echo "${prefix}" ;; *) echo "npm $*" >> "$HOME/npm.log" ;; esac\nexit 0\n`, { mode: 0o755 });
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version;
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncase "$*" in --version) echo "herdr ${pin}" ;; "integration status") printf 'claude: current (v1)\\ncodex: current (v1)\\n' ;; esac\nexit 0\n`, { mode: 0o755 });
  // VS Code with a local build of the extension, and a JetBrains IDE with a local build of the plugin.
  fs.mkdirSync(path.join(b.home, '.vscode', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(b.home, '.vscode', 'extensions', 'extensions.json'), JSON.stringify([{ identifier: { id: 'cell-observatory.oak-observatory-vscode' }, version: '9.9.9-dev.0', metadata: { source: 'vsix' } }]));
  fs.writeFileSync(path.join(bin, 'code'), '#!/bin/sh\necho "code $*" >> "$HOME/editor.log"\n', { mode: 0o755 });
  const ide = path.join(b.home, '.local', 'share', 'JetBrains', 'PyCharm2026.1', 'oak-observatory-jetbrains', 'lib');
  fs.mkdirSync(ide, { recursive: true });
  fs.writeFileSync(path.join(ide, 'oak-observatory-jetbrains-9.9.9-dev.0.jar'), 'local');
  env.PATH = bin + path.delimiter + env.PATH;
  // The channels: the rolling pre-release 9.9.9-dev.15, and the stable 9.9.8.
  let downloads = 0;
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url.startsWith('/releases')) res.end(JSON.stringify([
      { tag_name: 'dev-latest', name: 'Pre-release 9.9.9-dev.15 (rolling, from dev)', prerelease: true, assets: [{ name: 'oak-observatory-cli-dev.tgz', browser_download_url: `${base}/a/dev.tgz` }] },
      { tag_name: 'v9.9.8', prerelease: false, assets: [{ name: 'oak-observatory-9.9.8.tgz', browser_download_url: `${base}/a/stable.tgz` }] },
    ]));
    else { downloads++; res.end('tgz'); }
  });
  t.after(() => srv.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  env.CLAUDE_OBSERVATORY_RELEASES_API = `http://127.0.0.1:${srv.address().port}`;
  const oak = (entry, args) => new Promise((resolve) => cp.execFile(process.execPath, [entry, ...args], { env, cwd: b.home, encoding: 'utf8', timeout: 60000 },
    (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
  const npmLog = () => (fs.existsSync(path.join(b.home, 'npm.log')) ? fs.readFileSync(path.join(b.home, 'npm.log'), 'utf8') : '');
  const row = (out, label) => (out.slice(out.indexOf('\nResult\n')).match(new RegExp(`^ {2}${label.replace(/[\\()]/g, '\\$&')}\\s{2,}(.*)$`, 'm')) ?? [])[1];
  const said = '9.9.9-dev.0 · a local build, which no release carries: `oak update` leaves it alone, and `--force` or `--channel` replaces it';
  const channel = (c) => {
    fs.mkdirSync(path.join(env.CLAUDE_CONFIG_DIR, 'claude-observatory'), { recursive: true });
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'channel'), c + '\n');
  };

  for (const c of ['dev', 'stable']) {
    channel(c);
    const check = JSON.parse((await oak(local, ['version', '--check', '--json', '--compare', '9.9.9-dev.0'])).stdout);
    assert.deepEqual([check.local, check.updateAvailable, check.stranded, check.compared.reason], [true, false, false, 'local build'], c);
    const text = (await oak(local, ['version', '--check'])).stdout;
    assert.match(text, /this CLI is a local build, which no release carries: `oak update` leaves it alone/, c);
    assert.doesNotMatch(text, /update available|not on this channel|up to date/, c);
    const plan = JSON.parse((await oak(local, ['update', '--here', '--json'])).stdout);
    assert.deepEqual(plan.surfaces.filter((s) => s.from).map((s) => [s.label, s.reason]), [['CLI', 'local'], ['VS Code', 'local'], ['JetBrains (PyCharm2026.1)', 'local']], c);
    assert.equal(plan.upToDate, true, c);
    const r = await oak(local, ['update', '--here']);
    assert.equal(r.status, 0, r.stderr);
    for (const label of ['CLI', 'VS Code', 'JetBrains (PyCharm2026.1)']) assert.equal(row(r.stdout, label), said, `${c} ${label}`);
    assert.doesNotMatch(r.stdout, /everything is up to date/, 'a local build is not the channel\'s');
  }
  assert.deepEqual([npmLog(), downloads, fs.existsSync(path.join(b.home, 'editor.log')), fs.readdirSync(ide)], ['', 0, false, ['oak-observatory-jetbrains-9.9.9-dev.0.jar']], 'nothing downloaded or installed');
  // Asked by name, it is replaced: --force, or the channel named, the one followed included (stable is followed
  // here, so `--channel stable` names it without switching, and `--channel dev` switches).
  for (const args of [['--force'], ['--channel', 'stable'], ['--channel', 'dev']]) {
    fs.rmSync(path.join(b.home, 'npm.log'), { force: true });
    const r = await oak(local, ['update', '--here', '--cli-only', ...args]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(npmLog(), /^npm i -g \S+ --allow-scripts=node-pty$/m, args.join(' '));
  }
  // The control: a build a release carries is offered the channel's newest, and updated.
  const released = installedCliAt('9.9.9-dev.3');
  assert.equal(JSON.parse((await oak(released, ['version', '--check', '--json'])).stdout).updateAvailable, true);
  assert.equal(JSON.parse((await oak(released, ['update', '--here', '--cli-only', '--json'])).stdout).surfaces[0].reason, 'behind');
});

test('CLI update: a saved machine whose CLI is a local build keeps it, and its row says so (2026-10-07)', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  const f = updateFixture(t);
  // The machine's `oak` is a local build; its npm logs every call, so an install there would show.
  const there = f.remote('current');
  const oak = path.join(there, '.local/bin/oak');
  fs.writeFileSync(oak, fs.readFileSync(oak, 'utf8').replace(installedCli(), installedCliAt('9.9.9-dev.0')));
  fs.writeFileSync(path.join(there, '.local/bin/npm'), '#!/bin/sh\ncase "$1" in exec) echo "$HOME/npm-prefix" ;; ls) exit 1 ;; *) echo "npm $*" >> "$HOME/npm.log" ;; esac\nexit 0\n', { mode: 0o755 });
  f.machines('current');
  const said = `CLI 9.9.9-dev.0 is a local build, which no release carries: \`oak update\` leaves it alone, and \`--force\` or \`--channel\` replaces it`;
  const [planned] = JSON.parse((await f.oak(['--json'])).stdout).machines;
  assert.deepEqual([planned.state, planned.detail], ['current', `${f.target}; ${said}`]);
  const r = await f.oak([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.slice(r.stdout.indexOf('\nResult\n')).match(/^ {2}machine current\s{2,}(.*)$/m) ?? [])[1], `current (${f.target}; ${said})`);
  assert.equal(fs.existsSync(path.join(there, 'npm.log')), false, 'nothing installed there');
});

test('CLI uninstall --all: removes the lines the bundled status line set in Codex\'s config.toml (2026-10-07)', t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  fs.mkdirSync(b.env.CODEX_HOME, { recursive: true });
  const toml = path.join(b.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(toml, 'model = "gpt-5.2"\n\n[tui]  # oak-statusline\nstatus_line = ["model-with-reasoning"]  # oak-statusline\nstatus_line_use_colors = true  # oak-statusline\n');
  const r = run(b, process.execPath, [cli, 'uninstall', '--all']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`removed the bundled status line's lines from ${toml}`), r.stdout);
  assert.equal(fs.readFileSync(toml, 'utf8'), 'model = "gpt-5.2"\n');
  // Plain `oak uninstall` leaves them, as its tip says.
  fs.writeFileSync(toml, 'status_line_use_colors = true  # oak-statusline\n');
  assert.equal(run(b, process.execPath, [cli, 'uninstall']).status, 0);
  assert.equal(fs.readFileSync(toml, 'utf8'), 'status_line_use_colors = true  # oak-statusline\n');
  // A project's uninstall leaves the status line, which the installer sets up for the user: Codex's lines, and
  // the script Claude Code's user settings run, which it deleted while those settings still ran it.
  const cfg = b.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(cfg, { recursive: true });
  const script = path.join(cfg, 'statusline.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho status\n');
  const settings = path.join(cfg, 'settings.json');
  const user = JSON.stringify({ statusLine: { type: 'command', command: `bash ${script}` } }) + '\n';
  fs.writeFileSync(settings, user);
  const lines = 'model = "gpt-5.2"\n\n[tui]  # oak-statusline\nstatus_line = ["model-with-reasoning"]  # oak-statusline\n';
  fs.writeFileSync(toml, lines);
  const repo = path.join(b.home, 'repo');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}\n');
  const scoped = run(b, process.execPath, [cli, 'uninstall', '--project', '--all'], { cwd: repo });
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.deepEqual([fs.readFileSync(toml, 'utf8'), fs.existsSync(script), fs.readFileSync(settings, 'utf8')], [lines, true, user]);
  assert.ok(scoped.stdout.includes('a project\'s uninstall leaves the bundled status line, which is set up for your user: `oak uninstall --all` reverts it'), scoped.stdout);
  // …which `oak uninstall --all` does.
  assert.equal(run(b, process.execPath, [cli, 'uninstall', '--all']).status, 0);
  assert.deepEqual([fs.readFileSync(toml, 'utf8'), fs.existsSync(script), JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine], ['model = "gpt-5.2"\n', false, undefined]);
});

test('CLI uninstall --purge-store without --all says that it purged nothing (2026-11-03)', t => {
  // `--purge-store` acts only with `--all`; alone it exited 0 with the stored edits in place and said nothing of them.
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  const session = path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-purge-session');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'log.jsonl'), '');
  const r = run(b, process.execPath, [cli, 'uninstall', '--purge-store']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('`--purge-store` takes effect with `--all`: nothing was purged. Run `oak uninstall --all --purge-store`'), r.stdout);
  assert.ok(fs.existsSync(session), 'the stored edits are where the line says they are');
  assert.ok(!run(b, process.execPath, [cli, 'uninstall']).stdout.includes('--purge-store'), 'said only when asked for');
});

// `oak uninstall --all --purge-store` removes every session folder, one holding no edit log among them (a session that only
// asked and read, a Bash snapshot's stub), where it took only those with a log; and the teardown names what it leaves: the
// bundled status line's files beside its cache, and Node's compile cache of OAK's code that the `oak` launcher keeps.
test('CLI uninstall --all --purge-store: every session folder goes, one with no edit log too; the status line\'s side files and the compile cache are named (2026-11-03)', t => {
  const b = fixture(t);
  b.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK = '1';
  b.env.XDG_CACHE_HOME = path.join(b.home, 'cache');
  const store = path.join(b.env.CLAUDE_CONFIG_DIR, 'claude-observatory');
  const plant = (rel, text) => { fs.mkdirSync(path.dirname(path.join(store, rel)), { recursive: true }); fs.writeFileSync(path.join(store, rel), text); };
  plant('fixture-logged/log.jsonl', '');
  plant('fixture-asked/capture-events.jsonl', '{}\n');
  plant('fixture-stub/blobs/' + 'a'.repeat(64), 'snapshot');
  // Three of the four: one not there is not named.
  const side = ['statusline-usage.json', 'statusline-last.json.month-refresh', 'statusline-last.json.pull-log'].map((n) => path.join(b.env.CLAUDE_CONFIG_DIR, n));
  for (const f of side) fs.writeFileSync(f, '{}');
  // A machine that never synced, with `"machineUsage": false`: oak sync's copy of that setting, which a listing keeps.
  fs.writeFileSync(path.join(store, 'prefs.json'), JSON.stringify({ machineUsage: false }));
  assert.equal(run(b, process.execPath, [cli, 'sessions', '--json']).status, 0, 'control: a run through the launcher');
  assert.ok(fs.existsSync(path.join(store, 'sync', 'settings.json')), 'control: the copy');
  const cache = path.join(b.env.XDG_CACHE_HOME, 'oak', 'compile-cache');
  assert.ok(fs.existsSync(cache), 'control: the launcher made its compile cache');
  const r = run(b, process.execPath, [cli, 'uninstall', '--all', '--purge-store']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /purged the store \(3 session\(s\)\)/);
  for (const id of ['fixture-logged', 'fixture-asked', 'fixture-stub']) assert.ok(!fs.existsSync(path.join(store, id)), `${id} purged`);
  assert.ok(r.stdout.includes(`Status line files: delete ${side.join(', ')}  (`), r.stdout);
  assert.doesNotMatch(r.stdout, /statusline-last\.json\.pulling/, 'nor one that is not there');
  assert.ok(r.stdout.includes(`Compile cache: delete ${cache}  (`), r.stdout);
  // The sync folder holds the list of the sessions the purge removed and that copy, which the step says, and the file that
  // keeps OAK 0.10's clean off the folder, which is nothing to name.
  assert.ok(r.stdout.includes(`Sync state: delete ${path.join(store, 'sync')}  (the list of the sessions removed here, and a copy of oak sync's settings and "machineUsage" from prefs.json)`), r.stdout);
  for (const f of side) assert.ok(fs.existsSync(f), 'named, and left');
  // Plain `oak uninstall` prints no teardown steps; a project's leaves the status line, and names none of its files.
  assert.doesNotMatch(run(b, process.execPath, [cli, 'uninstall']).stdout, /Status line files/);
  const repo = path.join(b.home, 'repo');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}\n');
  assert.doesNotMatch(run(b, process.execPath, [cli, 'uninstall', '--project', '--all'], { cwd: repo }).stdout, /Status line files/);
  // A relative XDG_CACHE_HOME names no cache folder: the launcher keeps its cache in the home's, and the step names that one.
  b.env.XDG_CACHE_HOME = 'rel-cache';
  const rel = run(b, process.execPath, [cli, 'uninstall', '--all'], { cwd: repo });
  assert.ok(rel.stdout.includes(`Compile cache: delete ${path.join(b.home, '.cache', 'oak', 'compile-cache')}  (`), rel.stdout);
  assert.ok(!fs.existsSync(path.join(repo, 'rel-cache')), 'nothing in the folder it ran in');
  // Nor is an empty HOME a home: no folder of the one the command runs in is named, though it holds one of that name.
  fs.mkdirSync(path.join(repo, '.cache', 'oak', 'compile-cache'), { recursive: true });
  const homeless = run(b, process.execPath, [cli, 'uninstall', '--all'], { cwd: repo, env: { ...b.env, XDG_CACHE_HOME: '', HOME: '', USERPROFILE: '' } });
  assert.equal(homeless.status, 0, homeless.stderr);
  assert.doesNotMatch(homeless.stdout, /Compile cache:/);
});

test('CLI update: a saved machine keeps a CLI linked to a checkout, and one whose OAK predates that is not run (2026-10-06)', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  const f = updateFixture(t);
  // A saved machine whose npm package is a link to a checkout there.
  const linkTo = (host) => {
    const there = f.remote(host);
    makeGitDir(path.join(there, 'src', 'oak', '.git'));
    fs.mkdirSync(path.join(there, 'src', 'oak', 'packages', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(there, 'npm-prefix', 'lib', 'node_modules'), { recursive: true });
    fs.symlinkSync('../../../src/oak/packages/cli', path.join(there, 'npm-prefix', 'lib', 'node_modules', 'oak-observatory'));
    fs.writeFileSync(path.join(there, '.local', 'bin', 'npm'), '#!/bin/sh\ncase "$1" in exec) echo "$HOME/npm-prefix" ;; *) echo "npm $*" >> "$HOME/npm.log" ;; esac\nexit 0\n', { mode: 0o755 });
    return fs.realpathSync(path.join(there, 'src', 'oak'));
  };
  // The fixture's stale machine (a VS Code server behind), its CLI linked.
  const stale = linkTo('stale');
  // An OAK from before level 2 (0.10.0 answers 1, whatever it is asked) where npm's package is a link.
  const old = f.remote('old');
  fs.mkdirSync(path.join(old, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(old, '.local', 'bin', 'oak'), `#!/bin/sh\necho "oak $*" >> "$HOME/oak.log"\ncase "$1" in __update-protocol) echo 1 ;; update) echo '{"target":"${f.target}","surfaces":[],"components":[],"upToDate":true}' ;; esac\n`, { mode: 0o755 });
  const oldCheckout = linkTo('old');
  f.machines('stale', 'old');
  const kept = (checkout) => `CLI linked to the checkout at ${checkout}; update it there (git pull, then npm run build)`;
  const row = (out, label) => (out.slice(out.indexOf('\nResult\n')).match(new RegExp(`^ {2}machine ${label}\\s{2,}(.*)$`, 'm')) ?? [])[1];

  const plan = JSON.parse((await f.oak(['--json'])).stdout).machines;
  assert.deepEqual(plan.map((m) => [m.label, m.state, m.detail]), [
    ['stale', 'update', `VS Code server 0.10.0 → ${f.target}; ${kept(stale)}`],
    ['old', 'linked', `its CLI is linked to the checkout at ${oldCheckout}; update it there (git pull, then npm run build); its OAK there predates leaving such a CLI alone, so nothing ran there`],
  ]);
  // The update runs there and keeps the link; the older OAK is not run at all, which is no failure.
  const r = await f.oak([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(row(r.stdout, 'stale'), `updated to ${f.target}; ${kept(stale)}`);
  assert.equal(f.regVersion(f.remote('stale'), '.vscode-server/extensions'), f.target, 'the rest there was updated');
  assert.match(row(r.stdout, 'old'), /^its CLI is linked to the checkout at /);
  assert.doesNotMatch(r.stdout, /everything is up to date/);
  for (const host of ['stale', 'old']) {
    assert.equal(fs.lstatSync(path.join(f.remote(host), 'npm-prefix', 'lib', 'node_modules', 'oak-observatory')).isSymbolicLink(), true, host);
    assert.equal(fs.existsSync(path.join(f.remote(host), 'npm.log')), false, `${host}: nothing installed`);
  }
  assert.deepEqual(fs.readFileSync(path.join(old, 'oak.log'), 'utf8').trim().split('\n'), ['oak __update-protocol --level', 'oak __update-protocol --level'], 'asked its level, and nothing else');
  // The control: without the link, the older OAK there runs as it always has.
  fs.rmSync(path.join(old, 'npm-prefix', 'lib', 'node_modules', 'oak-observatory'));
  fs.rmSync(path.join(old, 'oak.log'));
  assert.equal(JSON.parse((await f.oak(['--json'])).stdout).machines.find((m) => m.label === 'old').state, 'current');
  assert.match(fs.readFileSync(path.join(old, 'oak.log'), 'utf8'), /^oak update --here --json$/m);
});

test('CLI update: the copy `oak machine add` pushed is left to `oak machine add`, here and from a saved machine, and an older copy is not run (2026-10-06)', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // `oak update --here` there installed the release with npm beside the copy, where nothing runs it, and
  // reported the CLI updated while `oak` there still ran the copy.
  const f = updateFixture(t);
  await f.oak(['--json', '--here']); // the release feed is up, and its address known
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'), 'utf8')).version;
  const provision = (host, oak) => {
    const there = f.remote(host);
    const bin = path.join(there, '.local', 'bin');
    const lib = path.join(there, '.local', 'lib', 'oak');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(lib, { recursive: true });
    // As installOakStack leaves it: the bundle and its manifest in ~/.local/lib/oak, and its launcher.
    for (const file of ['cli.js', 'capture.js', 'THIRD_PARTY_NOTICES.md', 'index.js']) fs.copyFileSync(path.join(root, 'packages/cli/dist', file), path.join(lib, file));
    fs.cpSync(path.join(root, 'packages/cli/dist/herdr-plugin'), path.join(lib, 'herdr-plugin'), { recursive: true });
    fs.copyFileSync(path.join(root, 'packages/cli/package.json'), path.join(lib, 'package.json'));
    fs.writeFileSync(path.join(bin, 'oak'), oak ?? '#!/bin/sh\nexec "$(command -v node 2>/dev/null || echo "$HOME/.local/bin/node")" "$HOME/.local/lib/oak/index.js" "$@"\n', { mode: 0o755 });
    // The node the launcher falls back to, with the release feed's address; npm, every call logged.
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexport CLAUDE_OBSERVATORY_RELEASES_API="${f.b.env.CLAUDE_OBSERVATORY_RELEASES_API}" TMPDIR="$HOME/tmp"\nmkdir -p "$HOME/tmp"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm $*" >> "$HOME/npm.log"\ncase "$1" in exec) echo "$HOME/npm-prefix" ;; ls) exit 1 ;; esac\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncase "$*" in --version) echo "herdr ${pin}" ;; "integration status") printf 'claude: current (v1)\\ncodex: current (v1)\\n' ;; esac\nexit 0\n`, { mode: 0o755 });
    return there;
  };
  const box = provision('box');
  // A copy older than the release, which an update would otherwise install.
  const boxManifest = path.join(box, '.local', 'lib', 'oak', 'package.json');
  fs.writeFileSync(boxManifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(boxManifest, 'utf8')), version: '0.0.1' }));
  // A copy from before level 2: it asks its level, and logs anything else it is asked.
  const oldbox = provision('oldbox', '#!/bin/sh\necho "oak $*" >> "$HOME/oak.log"\ncase "$1" in __update-protocol) echo 1 ;; esac\n');
  // npm with its prefix in ~/.local, whose `oak` there is npm's link, beside a copy `oak machine add` left: an
  // older OAK installed by npm, which updates itself as before.
  const npmbox = provision('npmbox');
  const npmOak = path.join(npmbox, 'npm-prefix', 'lib', 'node_modules', 'oak-observatory', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(npmOak), { recursive: true });
  fs.writeFileSync(npmOak, `#!/bin/sh\necho "oak $*" >> "$HOME/oak.log"\ncase "$1" in __update-protocol) echo 1 ;; update) echo '{"target":"${f.target}","surfaces":[],"components":[],"upToDate":true}' ;; esac\n`, { mode: 0o755 });
  fs.rmSync(path.join(npmbox, '.local', 'bin', 'oak'));
  fs.symlinkSync(npmOak, path.join(npmbox, '.local', 'bin', 'oak'));

  // On the machine itself, as the update from another machine runs it: the copy stays, the rest goes on.
  // Asynchronously: the release feed answers from this process.
  const env = { HOME: box, PATH: `${path.join(box, '.local', 'bin')}:/usr/bin:/bin`, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
  const there = (...args) => new Promise((resolve) => cp.execFile(path.join(box, '.local', 'bin', 'oak'), args, { env, cwd: box, encoding: 'utf8', timeout: 60000 },
    (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
  const here = await there('update', '--here', '--cli-only');
  assert.equal(here.status, 0, here.stderr);
  assert.match(here.stdout.slice(here.stdout.indexOf('\nResult\n')), /^ {2}CLI\s+0\.0\.1 · copied here by `oak machine add` from another machine; running it there again updates it$/m);
  assert.equal(fs.existsSync(path.join(box, 'npm.log')), false, 'npm was not asked to install anything, nor where its global package is');
  const json = JSON.parse((await there('update', '--here', '--json', '--cli-only')).stdout);
  assert.deepEqual([json.surfaces[0].reason, json.upToDate], ['provisioned', true]);
  const check = JSON.parse((await there('version', '--check', '--json')).stdout);
  assert.deepEqual([check.provisioned, check.updateAvailable], [true, false], 'and no release is offered to it');

  // From this machine: each row names the command that updates it, and the older copy is not run at all.
  f.machines('box', 'oldbox', 'npmbox');
  const plan = JSON.parse((await f.oak(['--json'])).stdout).machines;
  assert.deepEqual(plan.map((m) => [m.label, m.state, m.detail]), [
    ['box', 'current', `${f.target}; CLI copied there by \`oak machine add\`, which updates it: \`oak machine add box me@box\``],
    ['oldbox', 'provisioned', 'its OAK is a copy `oak machine add` pushed, from a release whose `oak update` installs a CLI that nothing there runs, so nothing ran there; `oak machine add oldbox me@oldbox` updates it'],
    ['npmbox', 'current', f.target],
  ]);
  const r = await f.oak([]);
  assert.equal(r.status, 0, `a copy left to \`oak machine add\` is no failure: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /everything is up to date/);
  assert.deepEqual(fs.readFileSync(path.join(oldbox, 'oak.log'), 'utf8').trim().split('\n'), ['oak __update-protocol --level', 'oak __update-protocol --level']);
  assert.equal(fs.existsSync(path.join(oldbox, 'npm.log')), false);
});

test('CLI update: a saved machine whose CLI is still behind after its update fails, and the failure line names each machine with its reason (2026-10-06)', { skip: process.platform === 'win32' && 'POSIX fakes' }, async t => {
  // npm installed the release where the machine's `oak` does not run it: the read after the update still
  // showed the CLI behind, and the row said "updated". The editors show only the failure line on stderr,
  // which named the machines and no reason.
  const f = updateFixture(t);
  // The stale machine's `oak` reports an older version, and its npm installs where that `oak` never looks.
  const stale = f.remote('stale');
  const old = path.join(stale, 'old-oak');
  fs.cpSync(path.dirname(path.dirname(installedCli())), old, { recursive: true });
  const manifest = path.join(old, 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '0.0.1' }));
  const launcher = path.join(stale, '.local', 'bin', 'oak');
  fs.writeFileSync(launcher, fs.readFileSync(launcher, 'utf8').replace(installedCli(), path.join(old, 'dist', 'index.js')));
  const pkg = path.join(stale, 'npm-prefix', 'lib', 'node_modules', 'oak-observatory');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oak-observatory', version: f.target, bin: { oak: 'dist/index.js' } }));
  fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), "require('fs').writeFileSync(process.env.OAK_UPDATE_REPORT, '[]');\n");
  fs.writeFileSync(path.join(stale, '.local', 'bin', 'npm'), '#!/bin/sh\necho "npm $*" >> "$HOME/npm.log"\ncase "$1" in exec) echo "$HOME/npm-prefix" ;; ls) exit 1 ;; esac\nexit 0\n', { mode: 0o755 });
  // An `oak` there that crashes on its plan: Node's report names the file, quotes its source line, a bundle's thousands of
  // characters long, and lists every frame. Its error line is the reason, on one line, in the table and in the line on stderr.
  const crash = f.remote('crash');
  fs.mkdirSync(path.join(crash, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(crash, 'oak.js'), `const DATA = "${'x'.repeat(3000)}", WHY = "could not update"; const plan = undefined; plan.surfaces;\n`);
  fs.writeFileSync(path.join(crash, '.local', 'bin', 'oak'), `#!/bin/sh\n[ "$1" = __update-protocol ] && echo 2 && exit 0\nexec "${process.execPath}" "$HOME/oak.js" "$@"\n`, { mode: 0o755 });
  const report = cp.spawnSync(process.execPath, [path.join(crash, 'oak.js')], { encoding: 'utf8' }).stderr;
  assert.ok(report.length > 3000 && report.split('\n').length > 8, `control: a crash's report is long (${report.length} characters)`);
  const crashed = "TypeError: Cannot read properties of undefined (reading 'surfaces')";
  assert.ok(report.includes(`\n${crashed}\n`), report.slice(-600));
  f.machines('stale', 'legacy', 'down', 'crash');
  f.b.env.SSH_FAKE_DOWN = 'me@down';
  f.b.env.SSH_FAKE_STDERR = 'ssh: connect to host down port 22: No route to host';
  const r = await f.oak([]);
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(path.join(stale, 'npm.log'), 'utf8'), /^npm i -g /m, 'the update ran there');
  const result = (label) => (r.stdout.slice(r.stdout.indexOf('\nResult\n')).match(new RegExp(`^ {2}machine ${label}\\s{2,}(.*)$`, 'm')) ?? [])[1];
  const row = result('stale');
  assert.equal(row, `the update ran, but the CLI there still reports 0.0.1; still to do: CLI 0.0.1 → ${f.target}`);
  assert.equal(result('crash'), crashed);
  const line = `⚠ could not update machine stale (${row}); machine legacy (its OAK predates \`oak update --here\` — run \`oak update\` there once); machine down (not reachable over ssh (me@down): ssh: connect to host down port 22: No route to host); machine crash (${crashed}) — see the table above.`;
  assert.equal(r.stderr.trim(), line);
  // What both editors show for a failed run: stderr, less Node's own warnings, whole: a notification wraps it.
  assert.ok(line.length > 300, `control: the line is longer than the 300 characters the editors once cut it to (${line.length})`);
  assert.equal(realCore.cliFailureMessage(r.stdout, r.stderr, 'the CLI exited 1 without saying why'), line);
});

test('queued asks: local and --machine Prompts and Feed agree on a synthetic session', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t), remote = f.b.env.FAKE_REMOTE_HOME;
  const q = require('../packages/core/test/fixtures/queued-asks.cjs');
  const work = path.join(remote, 'queued-work'), session = 'queued-machine';
  const project = path.join(remote, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  const records = [q.ask('Start', 0, 'start'), q.remove('Change zebracorn', 1, 'mid'), q.queued('Change zebracorn', 2, 'mid'), q.blob('Change zebracorn', 3),
    q.ask('[Image: original 2366x1301, displayed at 1000x550]', 4, 'image', { isMeta: true }), q.answer('Done', 5)];
  fs.writeFileSync(path.join(project, `${session}.jsonl`), records.map(r => JSON.stringify({ cwd: work, sessionId: session, ...r })).join('\n') + '\n');
  for (const verb of ['prompts', 'feed', 'views']) {
    const args = [verb, ...(verb === 'views' ? ['--views', 'prompts'] : []), '--session', session, '--root', work, '--json'];
    const local = f.onRemote(args), remoteRead = onMachine(f, args);
    assert.equal(local.status, 0, local.stderr); assert.equal(remoteRead.status, 0, remoteRead.stderr);
    const a = JSON.parse(local.stdout), b = JSON.parse(remoteRead.stdout);
    const asks = x => verb === 'views' ? x.prompts.prompts.map(p => p.text) : verb === 'prompts' ? x.prompts.map(p => p.text) : x.entries.filter(e => e.kind === 'prompt').map(e => e.promptText);
    assert.deepEqual(asks(a), ['Start', 'Change zebracorn']);
    assert.deepEqual(asks(b), asks(a));
  }
});

test('CLI --machine: task decisions use the remote strict span and never the local task', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t);
  for (const verb of ['task-keep', 'task-undo', 'task-clear', 'completed']) {
    const session = 'remote-' + verb, file = f.seed(session), cwd = path.dirname(file);
    const project = path.join(f.b.env.FAKE_REMOTE_HOME, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, session + '.jsonl'), [500, 1500].map((ts, i) => JSON.stringify({ type: 'assistant', cwd, timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'todo-' + i, name: 'TodoWrite', input: { todos: [{ content: 'Synthetic task', status: i ? 'completed' : 'in_progress' }] } }] } })).join('\n'));
    const map = f.onRemote(['changemap', '--root', cwd, '--session', session, '--json']);
    assert.equal(map.status, 0, map.stderr);
    const task = JSON.parse(map.stdout).tasks[0].taskId;
    if (verb === 'task-clear' || verb === 'completed') assert.equal(f.onRemote(['keep', '--all', '--session', session]).status, 0);
    const result = onMachine(f, [verb === 'completed' ? 'task-clear' : verb, ...(verb === 'completed' ? ['--completed'] : [task]), '--session', session, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    if (verb === 'task-undo') {
      assert.equal(value.conflicts, 1, 'the later edit outside the task still protects its file');
      assert.equal(fs.readFileSync(file, 'utf8'), 'L1\nC\nL3\n');
    } else assert.deepEqual(value.ids, [1], 'only the first edit is in the strict task span');
    assert.ok(f.sshCalls().some(args => args.at(-1).includes('task-')));
    const local = run(f.b, process.execPath, [cli, 'list', '--session', session, '--json']);
    assert.equal(JSON.parse(local.stdout).edits.length, 0, 'nothing was created in the local session');
  }
});


test('CLI --machine: editor handoff belongs to the remote workspace, consumes once, and diff has both sides', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t), session = 'handoff-fixture', file = f.seed(session), workspace = path.dirname(file);
  const home = f.b.env.FAKE_REMOTE_HOME;
  const project = path.join(home, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, session + '.jsonl'), JSON.stringify({ type: 'assistant', cwd: workspace, message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic editor handoff' }] } }) + '\n');
  const prepare = onMachine(f, ['editor-review', 'prepare', '--session', session, '--editor', 'cursor', '--action', 'edit', '--edit', '2', '--json']);
  assert.equal(prepare.status, 0, prepare.stderr);
  const info = JSON.parse(prepare.stdout);
  assert.equal(info.workspace, workspace); assert.equal(info.installed, false);
  assert.equal(info.request.session, session); assert.equal(info.request.edit, 2);
  // OAK in the machine's Cursor server (what a Remote-SSH window runs) is found: its row is `cursor-server`, not `cursor`.
  const serverExt = path.join(home, '.cursor-server/extensions/cell-observatory.oak-observatory-vscode-0.11.0-dev.0');
  fs.mkdirSync(serverExt, { recursive: true });
  fs.writeFileSync(path.join(serverExt, 'package.json'), JSON.stringify({ name: 'oak-observatory-vscode', publisher: 'cell-observatory', version: '0.11.0-dev.0' }));
  fs.writeFileSync(path.join(home, '.cursor-server/extensions/extensions.json'), JSON.stringify([{ identifier: { id: 'cell-observatory.oak-observatory-vscode' },
    version: '0.11.0-dev.0', relativeLocation: path.basename(serverExt) }]));
  const cursorInfo = JSON.parse(onMachine(f, ['editor-review', 'info', '--session', session, '--editor', 'cursor', '--json']).stdout);
  assert.equal(cursorInfo.installed, true, 'OAK in the Cursor server counts as installed');
  const backend = path.join(home, '.cache/JetBrains/RemoteDev/dist/fixture-ide');
  fs.mkdirSync(path.join(backend, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(backend, 'bin/remote-dev-server.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(backend, 'product-info.json'), JSON.stringify({ productCode: 'PY', dataDirectoryName: 'PyCharmFixture' }));
  const otherPlugin = path.join(home, '.config/JetBrains/RemoteDev-PY/_different_project/plugins/oak-observatory-jetbrains');
  fs.mkdirSync(otherPlugin, { recursive: true });
  const jbInfo = () => JSON.parse(onMachine(f, ['editor-review', 'info', '--session', session, '--editor', 'jetbrains', '--product', 'PY', '--json']).stdout);
  assert.equal(jbInfo().installed, false, 'another project plugin does not prove this project has OAK');
  // The installer names this directory from JB_PLUGIN_DIRNAME.
  fs.mkdirSync(path.join(home, '.local/share/JetBrains/PyCharmFixture/oak-observatory-jetbrains'), { recursive: true });
  assert.equal(jbInfo().idePath, backend);
  assert.equal(jbInfo().installed, true, 'current backend product plugin directory is detected');

  assert.equal(fs.existsSync(path.join(f.b.env.CLAUDE_CONFIG_DIR, 'editor-review')), false, 'no local handoff written');
  assert.equal(fs.readdirSync(path.join(home, '.claude', 'editor-review')).filter(x => x.endsWith('.json')).length, 1);
  const consume = (workspace, editor = 'cursor') => {
    const r = f.onRemote(['editor-review', 'consume', '--workspace', workspace, '--editor', editor, '--json']);
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout).request;
  };
  assert.equal(consume(workspace, 'vscode'), null);
  assert.equal(consume(workspace + '-other'), null);
  assert.equal(consume(workspace).edit, 2); assert.equal(consume(workspace), null);
  const diff = onMachine(f, ['diff', '2', '--contents', '--json', '--session', session]);
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).before, 'L1\nA\nL3\n');
  assert.equal(JSON.parse(diff.stdout).after, 'L1\nC\nL3\n');
  assert.equal(info.file, file, 'raw history edits retain their remote filename');
  assert.equal(onMachine(f, ['undo', '2', '--units', '--session', session, '--json']).status, 0);
  const locate = cp.spawnSync(process.execPath, [cli, 'locate', '--file', file, '--include-undone', '--session', session, '--machine', 'build-box'],
    { cwd: f.b.home, env: f.b.env, input: 'L1\nA\nL3\n', encoding: 'utf8', timeout: 15000 });
  assert.equal(locate.status, 0, locate.stderr);
  assert.deepEqual(JSON.parse(locate.stdout).placements.find(p => p.id === 1).lines, [1], 'remote locate receives the mounted buffer on stdin and anchors Redo');
  assert.ok(f.sshCalls().every(args => args.includes('builder@build-box.example')));
});

test('CLI --machine: diff pages batch missing files from records with a strict page bound', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t), session = 'remote-diff-page', file = f.seed(session);
  fs.unlinkSync(file);
  // Same scale as the field report, entirely synthetic; repeated pairs keep fixture creation cheap.
  const dir = path.join(f.b.env.FAKE_REMOTE_HOME, '.claude', 'claude-observatory', session);
  const raw = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>!r.op);
  const template = raw.at(-1), first = raw[0];
  const records = Array.from({length:2616},(_,i)=>({...template,id:i+1,ts:i+1,file:path.join(f.b.env.FAKE_REMOTE_HOME,'files',`${i%1293}.txt`), beforeBlob:first.beforeBlob}));
  fs.mkdirSync(path.join(f.b.env.FAKE_REMOTE_HOME,'files'));
  for(let i=0;i<361;i++) fs.writeFileSync(records[i].file, 'synthetic');
  fs.writeFileSync(path.join(dir, 'log.jsonl'), records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const before = f.sshCalls().length;
  for (const ids of ['401,402,403,404,405,406,407,408,409,410','411,412,413,414,415,416,417,418,419,420']) {
    const r = onMachine(f, ['diff', '--ids', ids, '--preview-lines', '1', '--contents', '--json', '--session', session]);
    assert.equal(r.status, 0, r.stderr);
    const page = JSON.parse(r.stdout);
    assert.equal(page.records.length, 10);
    assert.equal(page.records[0].rec.id, Number(ids.split(',')[0]));
    assert.equal(fs.existsSync(page.records[0].rec.file), false);
    assert.ok(page.records[0].patch.length > 0);
    assert.equal(typeof page.records[0].before, 'string');
    assert.equal(typeof page.records[0].after, 'string');
  }
  assert.equal(f.sshCalls().length - before, 2, 'one SSH for each page');
  const cancelledFile = path.join(f.b.env.FAKE_REMOTE_HOME, 'cancelled.txt');
  fs.appendFileSync(path.join(dir, 'log.jsonl'), [
    {...template, id:2617, ts:2617, file:cancelledFile, beforeBlob:first.beforeBlob},
    {...template, id:2618, ts:2618, file:cancelledFile, beforeBlob:template.afterBlob, afterBlob:first.beforeBlob},
  ].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const scope = onMachine(f, ['diff', '--pending', '--offset', '400', '--json', '--session', session]);
  assert.equal(scope.status, 0, scope.stderr);
  const selected = JSON.parse(scope.stdout);
  assert.equal(selected.ids.length, 2616, 'cancelled chains are absent from the count and page');
  assert.equal(selected.records.length, 10);
  assert.equal(selected.records[0].rec.id, 401);
  const invalid = onMachine(f, ['diff', '--ids', Array.from({length:11},(_,i)=>i+1).join(','), '--json', '--session', session]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /1–10/);
});

test('CLI multitask --only-session and diff --ids --patch: the trimmed reads carry every field the Workers, Tasks and previews draw', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, t => {
  const f = machineFixture(t), session = 'saved-workers', remote = f.b.env.FAKE_REMOTE_HOME;
  const seeded = cp.spawnSync(process.execPath, [path.join(__dirname, 'fixtures/saved-session.cjs'), root, session, '4', '12'],
    { env: { HOME: remote, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const { work } = JSON.parse(seeded.stdout);
  const read = (args) => { const r = f.onRemote(args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const full = read(['multitask', '--json', '--session', session, '--root', work]).agents.find(a => a.session === session);
  assert.equal(full.subagents.length, 4);
  assert.ok(full.subagents.every(s => s.edits === 2 && s.added === 3 && s.removed === 3), 'each worker\'s own edits are attributed to it');
  // The one row the Observatory's Workers and Tasks read, exactly as the whole fleet carries it.
  const only = read(['multitask', '--json', '--only-session', '--session', session, '--root', work]);
  assert.deepEqual(only, { agents: [{ session, subagents: full.subagents, todos: full.todos }] });
  const drawn = ['agentId', 'agentType', 'description', 'currentTask', 'phase', 'ts', 'model', 'effort', 'edits', 'added', 'removed', 'tokensIn', 'tokensOut', 'tokensCacheRead', 'durationMs'];
  for (const s of only.agents[0].subagents) assert.deepEqual(drawn.filter(k => s[k] === undefined), [], s.agentId);
  assert.deepEqual(only.agents[0].todos.map(({ content, status }) => ({ content, status })),
    [{ content: 'Fan out workers', status: 'completed' }, { content: 'Merge results', status: 'in_progress' }]);
  // Every preview in one read, each the patch `diff <id> --patch` prints; an id with no edit is named in `errors`.
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  const batch = read(['diff', '--ids', [...ids, 999].join(','), '--patch', '--session', session]);
  assert.deepEqual(Object.keys(batch.patches).map(Number).sort((a, b) => a - b), ids);
  assert.deepEqual(batch.errors, { 999: `no edit #999 in session ${session}` });
  for (const id of [1, 8, 9, 20]) {
    const one = f.onRemote(['diff', String(id), '--patch', '--session', session]);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(batch.patches[id], one.stdout, `#${id}`);
  }
});
