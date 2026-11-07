const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const spawn = require('../dist/spawn');
const { handleCodexHookPayload, isCodexMemoryCwd } = require('../dist/codex');
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
  t.mock.method(require('../dist/herdr-context'), 'herdrPaneContextSync', () => process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH
    ? { nested: true, paneId: process.env.HERDR_PANE_ID, socketPath: process.env.HERDR_SOCKET_PATH }
    : { nested: false });
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

test('Codex capture never links the pane or reports the memory-writing thread its hooks run beside (2026-09-30)', t => {
  const b = sandbox(t);
  // Codex runs that agent in the pane session's own process, as an ephemeral thread of its own in
  // <CODEX_HOME>/memories (memories_v2 for its second format): `startup`, no transcript.
  for (const dir of ['memories', 'memories_v2']) {
    const memory = { session_id: `memory-${dir}`, cwd: path.join(process.env.CODEX_HOME, dir), transcript_path: null, model: 'test', permission_mode: 'bypassPermissions' };
    handleCodexHookPayload({ ...memory, hook_event_name: 'SessionStart', source: 'startup' });
    handleCodexHookPayload({ ...memory, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'consolidate' });
    handleCodexHookPayload({ ...memory, hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'ls' } });
    handleCodexHookPayload({ ...memory, hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'apply_patch', tool_use_id: 'call-2',
      tool_input: { command: `*** Begin Patch\n*** Add File: ${path.join(memory.cwd, 'MEMORY.md')}\n+note\n*** End Patch\n` }, tool_response: '' });
    assert.equal(readHerdrPaneLink(memory.session_id), null, `no pane link (${dir})`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(storeDir(memory.session_id), 'agent.json'), 'utf8')).cwd, memory.cwd, 'still recorded as a Codex session');
  }
  assert.equal(b.calls.length, 0, 'nothing reported to herdr');
  // Control: the pane's own thread, beside it, still links and reports.
  handleCodexHookPayload(b.payload);
  assert.equal(b.calls.length, 1);
  assert.equal(readHerdrPaneLink('codex-session').paneId, 'w2:p3');
});

test('a symlinked CODEX_HOME still names the memory-writing thread; a project folder named memories never does', t => {
  const b = sandbox(t);
  // CODEX_HOME names a link; Codex reports the folder's real path (or the reverse), as macOS's /var
  // for /private/var does. A junction needs no privilege on Windows.
  const real = path.join(b.root, 'real-codex');
  fs.mkdirSync(path.join(real, 'memories'), { recursive: true });
  fs.symlinkSync(real, process.env.CODEX_HOME, 'junction');
  assert.equal(isCodexMemoryCwd(path.join(process.env.CODEX_HOME, 'memories')), true, 'as written');
  assert.equal(isCodexMemoryCwd(path.join(real, 'memories')), true, 'the real path of a linked CODEX_HOME');
  process.env.CODEX_HOME = real;
  assert.equal(isCodexMemoryCwd(path.join(b.root, 'codex', 'memories')), true, 'a link to the real CODEX_HOME');
  process.env.CODEX_HOME = path.join(b.root, 'codex');
  const project = path.join(b.root, 'project', 'memories');
  fs.mkdirSync(project, { recursive: true });
  assert.equal(isCodexMemoryCwd(project), false, 'a project folder named memories');
  assert.equal(isCodexMemoryCwd(path.join(real, 'memories_v2')), false, 'a memories_v2 folder that does not exist');
  // Capture takes the same rule: the thread reported under the real path links no pane.
  handleCodexHookPayload({ ...b.payload, session_id: 'memory-real', cwd: path.join(real, 'memories') });
  assert.equal(readHerdrPaneLink('memory-real'), null);
  assert.equal(b.calls.length, 0);
});

test('the memory-writing thread in Codex\'s default home links no pane, whatever CODEX_HOME or HOME its hook gets (2026-10-06)', t => {
  const b = sandbox(t);
  // Codex runs each hook with its own environment through the person's login shell, whose startup files
  // can point CODEX_HOME (here the sandbox's) or HOME elsewhere while the thread runs in ~/.codex.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }; // os.homedir() reads USERPROFILE on Windows
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.HOME = process.env.USERPROFILE = path.join(b.root, 'login-home');
  const threads = { 'memory-account': path.join(os.userInfo().homedir, '.codex', 'memories'), 'memory-home': path.join(os.homedir(), '.codex', 'memories_v2') };
  for (const [id, cwd] of Object.entries(threads)) {
    assert.equal(isCodexMemoryCwd(cwd), true, cwd);
    // A start and a prompt only: nothing here reads the folder itself.
    const memory = { session_id: id, cwd, transcript_path: null, model: 'test', permission_mode: 'bypassPermissions' };
    handleCodexHookPayload({ ...memory, hook_event_name: 'SessionStart', source: 'startup' });
    handleCodexHookPayload({ ...memory, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'consolidate' });
    assert.equal(readHerdrPaneLink(id), null, `no pane link (${id})`);
  }
  assert.equal(b.calls.length, 0, 'nothing reported to herdr');
  // Control: a folder of that name under any other `.codex` is a project's, and its session links.
  const project = path.join(b.root, 'work', '.codex', 'memories');
  assert.equal(isCodexMemoryCwd(project), false);
  handleCodexHookPayload({ ...b.payload, session_id: 'project-session', cwd: project });
  assert.equal(readHerdrPaneLink('project-session').paneId, 'w2:p3');
  assert.equal(b.calls.length, 1);
});

test('a Codex session resumed in its pane links newer than one that started and exited there since', t => {
  const b = sandbox(t);
  // The Observatory's heal gives a pane to the session with the newest link there, so a resume must
  // refresh the link's time: R1 starts, R2 starts and exits, R1 resumes, and the pane is R1's again.
  let clock = 1_000;
  t.mock.method(Date, 'now', () => clock);
  handleCodexHookPayload({ ...b.payload, session_id: 'r1', source: 'startup' });
  clock = 2_000;
  handleCodexHookPayload({ ...b.payload, session_id: 'r2', source: 'startup' });
  clock = 3_000;
  handleCodexHookPayload({ ...b.payload, session_id: 'r1', source: 'resume' });
  assert.equal(readHerdrPaneLink('r1').at, 3_000);
  assert.ok(readHerdrPaneLink('r1').at > readHerdrPaneLink('r2').at, 'the resumed session is the pane\'s newest link');
  // A turn in between is not a session start and keeps the time.
  clock = 4_000;
  handleCodexHookPayload({ ...b.payload, session_id: 'r1', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'test' });
  assert.equal(readHerdrPaneLink('r1').at, 3_000);
});

test('Codex capture wire request through the real herdr CLI and a fake socket', async t => {
  const b = sandbox(t);
  // Restore the real spawn for this test only. The capture process is separate so its synchronous
  // CLI report cannot block this test's socket server from replying.
  t.mock.restoreAll();
  // Found as the other real-binary tests find it, PATH first: the suite's bootstrap gives each test a HOME of its own,
  // so `~/.local/bin/herdr` named a folder that never holds one, and the test skipped even where CI installs herdr.
  const binary = process.env.HERDR_BIN || require('../dist/herdr-install').findHerdrBin();
  if (!binary || !fs.existsSync(binary)) {
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
      const result = request.method === 'ping' ? { type: 'pong', version: '0.9.1', protocol: 22 }
        : request.method === 'pane.process_info' ? { type: 'pane_process_info', process_info: { pane_id: request.params.pane_id, shell_pid: process.pid } } : { type: 'ok' };
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
  const reports = () => requests.filter(request => request.method === 'pane.report_agent_session');
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
