const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const spawn = require('../dist/spawn');
const { handleCodexHookPayload } = require('../dist/codex');
const { handleHookPayload } = require('../dist/capture');
const { readHerdrPaneLink, reportHerdrSession } = require('../dist/herdr-link');
const { storeDir } = require('../dist/store');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-codex-join-'));
  const keys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEX_THREAD_ID', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH', 'HERDR_ENV', 'OAK_TAB'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HERDR_PANE_ID: 'w2:p3', HERDR_SOCKET_PATH: path.join(root, 'herdr.sock'), HERDR_BIN_PATH: path.join(root, 'herdr') });
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  let answer = { status: 0 };
  t.mock.method(spawn, 'spawnToolSync', (...args) => { calls.push(args); return answer; });
  const payload = { session_id: 'codex-session', cwd: root, hook_event_name: 'SessionStart', transcript_path: null, model: 'test', source: 'startup' };
  return { root, calls, payload, answer(value) { answer = value; } };
}

test('Codex capture reports the pane identity synchronously without a TUI, OAK_TAB, HERDR_ENV or transcript', t => {
  const b = sandbox(t);
  handleCodexHookPayload(b.payload);
  assert.equal(b.calls.length, 1, 'report finished before capture handler returns');
  const [binary, args, options] = b.calls[0];
  assert.equal(binary, process.env.HERDR_BIN_PATH);
  assert.deepEqual(args.slice(0, 9), ['pane', 'report-agent-session', 'w2:p3', '--source', 'herdr:codex', '--agent', 'codex', '--agent-session-id', 'codex-session']);
  assert.equal(args[9], '--seq');
  assert.ok(BigInt(args[10]) > BigInt(Date.now() - 1000) * 1_000_000n, 'sequence uses native epoch nanoseconds');
  assert.deepEqual(args.slice(11), ['--session-start-source', 'startup']);
  assert.equal(options.env.HERDR_SOCKET_PATH, process.env.HERDR_SOCKET_PATH);
  assert.equal(options.timeout, 500);
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(options.direct, true);
  assert.equal(options.stdio, 'ignore', 'hook output must remain silent');
  assert.equal(readHerdrPaneLink('codex-session').reported, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(storeDir('codex-session'), 'agent.json'), 'utf8')).agent, 'codex');
});

test('Codex capture reuses a successful join, re-reports SessionStart and reports pane moves', t => {
  const b = sandbox(t);
  handleCodexHookPayload(b.payload);
  const other = { ...b.payload, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'test' };
  handleCodexHookPayload(other);
  assert.equal(b.calls.length, 1);
  handleCodexHookPayload({ ...b.payload, source: 'resume' });
  assert.equal(b.calls.length, 2, 'resume/server restart gets a fresh report');
  assert.deepEqual(b.calls[1][1].slice(-2), ['--session-start-source', 'resume']);
  process.env.HERDR_PANE_ID = 'w3:p4';
  handleCodexHookPayload(other);
  assert.equal(b.calls.length, 3);
  assert.equal(b.calls[2][1][2], 'w3:p4');
  process.env.HERDR_SOCKET_PATH = path.join(b.root, 'moved.sock');
  handleCodexHookPayload(other);
  assert.equal(b.calls.length, 4);
  assert.equal(b.calls[3][2].env.HERDR_SOCKET_PATH, process.env.HERDR_SOCKET_PATH);
});

test('Codex capture retains the sidecar on reporting failure and retries the next hook', t => {
  const b = sandbox(t);
  b.answer({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) });
  assert.doesNotThrow(() => handleCodexHookPayload(b.payload));
  assert.equal(readHerdrPaneLink('codex-session').paneId, 'w2:p3');
  assert.equal(readHerdrPaneLink('codex-session').reported, undefined);
  b.answer({ status: 0 });
  handleCodexHookPayload({ ...b.payload, hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(b.calls.length, 2);
  assert.deepEqual(b.calls[1][1].slice(-2), ['--session-start-source', 'startup'], 'retry retains replacement authority');
  assert.equal(readHerdrPaneLink('codex-session').reported, true);
});

test('Claude capture keeps its existing sidecar-only behavior', t => {
  const b = sandbox(t);
  handleHookPayload({ session_id: 'claude-session', hook_event_name: 'SessionStart', cwd: b.root });
  assert.equal(readHerdrPaneLink('claude-session').paneId, 'w2:p3');
  assert.equal(b.calls.length, 0);
});

test('Codex capture does not report without pane/socket identity or overwrite an inherited parent session', t => {
  const b = sandbox(t);
  delete process.env.HERDR_PANE_ID;
  handleCodexHookPayload(b.payload);
  assert.equal(readHerdrPaneLink('codex-session'), null);
  process.env.HERDR_PANE_ID = 'w2:p3';
  delete process.env.HERDR_SOCKET_PATH;
  handleCodexHookPayload(b.payload);
  assert.equal(b.calls.length, 0);
  process.env.HERDR_SOCKET_PATH = path.join(b.root, 'herdr.sock');
  process.env.CODEX_THREAD_ID = 'parent-session';
  handleCodexHookPayload(b.payload);
  assert.equal(b.calls.length, 0);
  process.env.CODEX_THREAD_ID = 'codex-session';
  handleCodexHookPayload(b.payload);
  assert.equal(b.calls.length, 1);
});

test('Codex capture wire request through the real herdr CLI and a fake socket', async t => {
  const b = sandbox(t);
  // Restore the real spawn for this test only. The capture process is separate so its synchronous
  // CLI report cannot block this test's socket server from replying.
  t.mock.restoreAll();
  const binary = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'herdr.exe' : 'herdr');
  if (!fs.existsSync(binary)) {
    const why = 'SKIP LIVE CODEX JOIN: herdr binary unavailable; request construction is covered, wire delivery is NOT verified.';
    console.error(why); t.skip(why); return;
  }
  process.env.HERDR_BIN_PATH = binary;
  const requests = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]);
      requests.push(request);
      // herdr's CLI opens every invocation with a compatibility ping (id api-client:status) and
      // aborts with UnexpectedResult unless a server answers it as one; a blanket {type:'ok'}
      // fixture would make the report under test never leave the process.
      const result = request.method === 'ping' ? { type: 'pong', version: '0.9.1', protocol: 22 } : { type: 'ok' };
      socket.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(process.env.HERDR_SOCKET_PATH, resolve); });
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    const why = `SKIP LIVE CODEX JOIN: socket bind denied (${error.code}); request construction passed, wire delivery is NOT verified. Run /tmp/oak-codexjoin-live.cjs outside the sandbox.`;
    console.error(why); t.skip(why); return;
  }
  t.after(() => new Promise(resolve => server.close(resolve)));
  const script = `require(${JSON.stringify(path.resolve(__dirname, '../dist/codex'))}).runCodexCapture(); process.exit(0);`;
  const child = cp.spawn(process.execPath, ['-e', script], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify(b.payload));
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, '');
  const reports = () => requests.filter(request => request.method !== 'ping');
  assert.equal(reports().length, 1, 'report reached the server before process.exit');
  assert.equal(reports()[0].method, 'pane.report_agent_session');
  assert.equal(reports()[0].params.source, 'herdr:codex');
  assert.equal(reports()[0].params.agent_session_id, b.payload.session_id);
  // Same protocol used by the existing TUI watcher, which remains unchanged.
  await reportHerdrSession('watcher-session', 'codex', { paneId: 'w2:p3', socketPath: process.env.HERDR_SOCKET_PATH, at: 1 });
  assert.equal(reports()[1].params.source, 'herdr:codex');
});

test('the capture hook path leaves the herdr installer unloaded until a Codex report needs a binary', t => {
  // Every capture hook loads herdr-link; only a Codex hook in a herdr pane without HERDR_BIN_PATH ever
  // looks for the binary. The installer brings smol-toml and codex-hook-trust with it.
  const loaded = (body) => cp.spawnSync(process.execPath, ['-e',
    `${body};process.stdout.write(String(Object.keys(require.cache).some((f) => f.endsWith('herdr-install.js'))))`], { encoding: 'utf8' }).stdout;
  assert.equal(loaded(`require(${JSON.stringify(path.resolve(__dirname, '../dist/capture'))})`), 'false', 'loading capture does not load the installer');
  const b = sandbox(t);
  delete process.env.HERDR_BIN_PATH;
  const link = require('../dist/herdr-link');
  const install = require('../dist/herdr-install');
  t.mock.method(install, 'findHerdrBin', () => path.join(b.root, 'found-herdr'));
  assert.equal(link.reportHerdrSessionSync('codex-session', 'codex', { paneId: 'w2:p3', socketPath: process.env.HERDR_SOCKET_PATH, at: 1 }), true);
  assert.equal(b.calls[0][0], path.join(b.root, 'found-herdr'), 'the report still finds the binary when it needs one');
});
