/* node --test packages/core/test/herdr.test.js (build core first).
   Every server and binary fixture uses temporary state; no real herdr server is contacted. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { Duplex } = require('node:stream');
const ts = require('typescript');
const core = require('../dist/herdr.js');
const { generate } = require('../scripts/gen-herdr-types.js');
const execFile = promisify(cp.execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
require('./herdr-context.test');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-herdr-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'state'), XDG_CACHE_HOME: path.join(dir, 'cache'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), ZDOTDIR: dir,
    HERDR_SOCKET_PATH: path.join(dir, 'herdr.sock'), SHELL: '/bin/sh' };
  for (const name of ['HERDR_SESSION', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV']) delete env[name];
  // A sandboxed server stays off the network: herdr's own opt-outs for its background version check
  // and its agent-detection manifest refresh (it fetched herdr.dev on every `npm test`).
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'herdr'), { recursive: true });
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'herdr', 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n');
  return { dir, env, socketPath: env.HERDR_SOCKET_PATH, cleanups };
}

async function eventually(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(10);
  }
}

function socketTest(name, options, run) {
  if (typeof options === 'function') { run = options; options = {}; }
  test(name, options, async t => {
    try { await run(t); }
    catch (error) {
      if (!error.socketPrerequisite || !['EPERM', 'EACCES', 'EAFNOSUPPORT'].includes(error.code)) throw error;
      const reason = `SKIP SOCKET TEST: Unix socket binding unavailable (${error.code}); no live transport verified.`;
      console.error(reason); t.skip(reason);
    }
  });
}

async function fakeServer(t, box, answer) {
  const sockets = new Set();
  const requests = [];
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(request);
        answer(request, socket);
      }
    });
  });
  async function stop() {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  box.cleanups.push(stop);
  await new Promise((resolve, reject) => {
    server.once('error', error => { error.socketPrerequisite = true; reject(error); });
    server.listen(box.socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  return { stop, requests, get connections() { return connections; } };
}

function success(socket, id, result) { socket.end(JSON.stringify({ id, result }) + '\n'); }
const pong = { type: 'pong', version: '0.9.1', protocol: 22 };

// These transport-only checks also run in environments which prohibit binding Unix sockets.
// Socket/server tests below skip loudly only when their actual binding prerequisite is denied.
function memoryTransport(t, answer) {
  const connections = [];
  t.mock.method(net, 'createConnection', socketPath => {
    const socket = new Duplex({
      read() {},
      write(bytes, encoding, done) {
        answer(JSON.parse(bytes.toString()), socket);
        done();
      },
    });
    connections.push({ socket, socketPath });
    queueMicrotask(() => { if (!socket.destroyed) socket.emit('connect'); });
    return socket;
  });
  t.after(() => connections.forEach(({ socket }) => socket.destroy()));
  return connections;
}

test('herdr: in-memory transport verifies framing, errors, timeout and one request per connection', async t => {
  // Only the timeout case waits out its deadline; the others answer at once, with room for a loaded machine.
  const opts = { socketPath: '/tmp/memory-only.sock', timeoutMs: 1000 };
  let mode = 'pong';
  const connections = memoryTransport(t, ({ id }, socket) => {
    if (mode === 'timeout') return;
    if (mode === 'close') return socket.destroy();
    if (mode === 'error') return socket.push(JSON.stringify({ id, error: { code: 'agent_blocked', message: 'dialog' } }) + '\n');
    if (mode === 'missing') return socket.destroy(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    if (mode === 'invalid') return socket.push('bad json\n');
    if (mode === 'id') return socket.push(JSON.stringify({ id: 'different', result: pong }) + '\n');
    const bytes = Buffer.from(JSON.stringify({ id, result: { ...pong, version: 'é' } }) + '\n');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    socket.push(bytes.subarray(0, split));
    setImmediate(() => socket.push(bytes.subarray(split)));
  });
  assert.equal((await core.herdrRequest('ping', {}, opts)).version, 'é');
  assert.equal((await core.herdrRequest('ping', {}, opts)).version, 'é');
  for (const [next, code] of [['error', 'agent_blocked'], ['missing', 'server_not_running'], ['invalid', 'invalid_response'], ['id', 'invalid_response'], ['close', 'connection_closed'], ['timeout', 'timeout']]) {
    mode = next;
    await assert.rejects(core.herdrRequest('ping', {}, next === 'timeout' ? { ...opts, timeoutMs: 30 } : opts), { code });
  }
  assert.equal(connections.length, 8);
  // Windows connects to the named pipe the marker names, not to the marker itself.
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${opts.socketPath}` : opts.socketPath;
  assert.ok(connections.every(c => c.socket.destroyed && c.socketPath === endpoint));
});

test('herdr: an answer that arrives while this process is busy is an answer, not a timeout (2026-11-05)', { skip: process.platform === 'win32' && 'POSIX socket fixture' }, async t => {
  // The server runs on its own thread, so this thread's busy loop cannot delay it; it answers 30 ms after each request.
  const { Worker } = require('node:worker_threads');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-herdr-busy-'));
  const socketPath = path.join(dir, 'herdr.sock');
  const worker = new Worker(`const net = require('node:net');
    net.createServer(c => { let b = ''; c.on('data', d => { b += d; if (!b.includes('\\n')) return;
      const { id } = JSON.parse(b); setTimeout(() => c.end(JSON.stringify({ id, result: { type: 'pong', version: '0.9.1' } }) + '\\n'), 30); }); })
      .listen(${JSON.stringify(socketPath)}, () => require('node:worker_threads').parentPort.postMessage('ready'));`, { eval: true });
  t.after(async () => { await worker.terminate(); fs.rmSync(dir, { recursive: true, force: true }); });
  await once(worker, 'message');
  const busy = ms => { const end = Date.now() + ms; while (Date.now() < end); };
  // Busy after the request went out (a first paint, say): the answer is already waiting when the deadline passes.
  const after = core.herdrRequest('ping', {}, { socketPath, timeoutMs: 300 });
  setTimeout(() => setImmediate(() => busy(700)), 10);
  assert.equal((await after).type, 'pong');
  // Busy before it went out: the budget is herdr's time, so it counts from the write.
  const before = core.herdrRequest('ping', {}, { socketPath, timeoutMs: 300 });
  busy(700);
  assert.equal((await before).type, 'pong');
});

test('herdr: in-memory subscription verifies acknowledgement, reconnect, backoff and cancellation', async t => {
  let mode = 'stream';
  const event = { event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } };
  const connections = memoryTransport(t, ({ id, method, params }, socket) => {
    assert.equal(method, 'events.subscribe');
    assert.deepEqual(params.subscriptions, [{ type: 'pane.agent_status_changed', pane_id: 'w1:p1' }]);
    if (mode === 'down') return socket.destroy(Object.assign(new Error('missing'), { code: 'ECONNREFUSED' }));
    if (mode === 'silent') return;
    socket.push(JSON.stringify({ id, result: { type: 'subscription_started' } }) + '\n' + JSON.stringify(event) + '\n');
  });
  const events = [], statuses = [], errors = [];
  // The reconnect waits, in order with the acknowledgements, as the subscription asks for them.
  const timeline = [];
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => { if (fn.name === 'connect') timeline.push(ms); return realSetTimeout(fn, ms, ...rest); });
  const sub = core.herdrSubscribe([{ type: 'pane.agent_status_changed', pane_id: 'w1:p1' }], event => events.push(event), {
    socketPath: '/tmp/memory-only.sock', timeoutMs: 20, reconnectDelayMs: 10, maxReconnectDelayMs: 30,
    onStatus: status => { statuses.push(status); if (status === 'connected') timeline.push('connected'); }, onError: error => errors.push(error),
  });
  t.after(() => sub.close());
  await eventually(() => events.length === 1, 'first in-memory event');
  mode = 'down';
  connections[0].socket.destroy();
  // Three refusals, so the waits reach the 30 ms cap before the server returns.
  await eventually(() => errors.filter(e => e.code === 'server_not_running').length >= 3, 'down errors');
  mode = 'stream';
  await eventually(() => events.length === 2, 'reconnected in-memory event');
  assert.deepEqual(events, [event, event]);
  assert.equal(statuses.filter(s => s === 'connected').length, 2);
  mode = 'silent';
  connections.at(-1).socket.destroy();
  await eventually(() => errors.some(e => e.code === 'timeout'), 'handshake timeout');
  sub.close();
  const count = connections.length;
  await sleep(80);
  assert.equal(connections.length, count);
  // Backoff: while the server is down each wait doubles, up to the cap; an acknowledged subscription
  // starts the next outage from the first wait again (a reset nothing checked).
  const [first, second] = [timeline.indexOf('connected'), timeline.lastIndexOf('connected')];
  const outage = timeline.slice(first + 1, second);
  assert.ok(outage.length >= 4, `the outage retried past the cap: ${timeline}`);
  assert.deepEqual(outage, outage.map((_, i) => Math.min(30, 10 * 2 ** i)), `doubling to the cap: ${timeline}`);
  assert.equal(timeline[second + 1], 10, `back to the first wait after reconnecting: ${timeline}`);
});

test('herdr: socket path follows override, XDG, then home', () => {
  assert.equal(core.herdrSocketPath({ HERDR_SOCKET_PATH: '/tmp/explicit.sock', XDG_CONFIG_HOME: '/tmp/xdg' }), '/tmp/explicit.sock');
  // POSIX form; Windows markers (APPDATA, pipes) are the platform regression's, further down.
  assert.equal(core.herdrSocketPath({ XDG_CONFIG_HOME: '/tmp/xdg' }, 'linux'), '/tmp/xdg/herdr/herdr.sock');
  assert.equal(core.herdrSocketPath({}), path.join(os.homedir(), '.config/herdr/herdr.sock'));
});

socketTest('herdr: each request opens a connection, accepts fragmented UTF-8, and preserves results', async t => {
  const box = sandbox(t);
  const fake = await fakeServer(t, box, ({ id }, socket) => {
    const bytes = Buffer.from(JSON.stringify({ id, result: { ...pong, version: '0.9.1-é' } }) + '\n');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    socket.write(bytes.subarray(0, split));
    setImmediate(() => socket.end(bytes.subarray(split)));
  });
  const first = await core.herdrRequest('ping', {}, box);
  const more = await Promise.all(Array.from({ length: 4 }, () => core.herdrRequest('ping', {}, box)));
  assert.equal(first.version, '0.9.1-é');
  assert.equal(more.length, 4);
  assert.equal(fake.connections, 5);
  assert.equal(new Set(fake.requests.map(r => r.id)).size, 5);
  assert.ok(fake.requests.every(r => r.method === 'ping' && typeof r.id === 'string'));
});

socketTest('herdr: server errors retain exact codes/messages; unavailable server has a distinct class', async t => {
  const box = sandbox(t);
  const fake = await fakeServer(t, box, ({ id, params }, socket) => {
    socket.end(JSON.stringify({ id, error: { code: params.pane_id, message: 'server detail' } }) + '\n');
  });
  for (const code of ['invalid_request', 'agent_not_ready', 'agent_blocked', 'agent_prompt_stalled', 'pane_not_found', 'server_not_running']) {
    await assert.rejects(core.herdrRequest('pane.get', { pane_id: code }, box), error => {
      assert.ok(error instanceof core.HerdrError);
      assert.equal(error.code, code);
      assert.equal(error.message, 'server detail');
      assert.equal(error instanceof core.HerdrServerNotRunningError, code === 'server_not_running');
      return true;
    });
  }
  await fake.stop();
  await assert.rejects(core.herdrRequest('ping', {}, box), error =>
    error instanceof core.HerdrServerNotRunningError && /oak doctor --fix/.test(error.message));
});

socketTest('herdr: timeout, early close, invalid frames and response ids reject without replay', async t => {
  const box = sandbox(t);
  const fake = await fakeServer(t, box, ({ id, params }, socket) => {
    if (params.pane_id === 'timeout') return;
    if (params.pane_id === 'close') return socket.end();
    if (params.pane_id === 'json') return socket.end('{bad json}\n');
    if (params.pane_id === 'shape') return socket.end(JSON.stringify({ id, result: null }) + '\n');
    success(socket, 'wrong-id', pong);
  });
  await assert.rejects(core.herdrRequest('pane.get', { pane_id: 'timeout' }, { ...box, timeoutMs: 30 }), core.HerdrTimeoutError);
  for (const [pane_id, code] of [['close', 'connection_closed'], ['json', 'invalid_response'], ['shape', 'invalid_response'], ['id', 'invalid_response']]) {
    await assert.rejects(core.herdrRequest('pane.get', { pane_id }, box), { code });
  }
  assert.equal(fake.connections, 5, 'failed mutations are never replayed');
});

socketTest('herdr: subscription acknowledges, streams, reconnects after restart, and closes permanently', async t => {
  const box = sandbox(t);
  const subscriptions = [{ type: 'pane.created' }, { type: 'pane.agent_status_changed', pane_id: 'w1:p1' }];
  const event = { event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'working', revision: 1 } };
  const answer = ({ id }, socket) => socket.write(JSON.stringify({ id, result: { type: 'subscription_started' } }) + '\n' + JSON.stringify(event) + '\n');
  const first = await fakeServer(t, box, answer);
  const events = [], statuses = [], errors = [];
  const sub = core.herdrSubscribe(subscriptions, e => events.push(e), {
    ...box, reconnectDelayMs: 10, maxReconnectDelayMs: 40,
    onStatus: s => statuses.push(s), onError: e => errors.push(e),
  });
  box.cleanups.push(() => sub.close());
  await eventually(() => events.length === 1, 'initial event');
  assert.deepEqual(statuses, ['connected']);
  assert.deepEqual(events[0], event);
  assert.deepEqual(first.requests[0].params, { subscriptions });
  await first.stop();
  await eventually(() => errors.length > 0, 'reconnect attempted while server down');
  assert.ok(errors[0] instanceof core.HerdrServerNotRunningError);
  const second = await fakeServer(t, box, answer);
  await eventually(() => events.length === 2, 'event after restart');
  assert.equal(statuses.filter(s => s === 'connected').length, 2);
  assert.ok(statuses.includes('reconnecting'));
  assert.deepEqual(second.requests[0].params, { subscriptions });
  sub.close();
  sub.close();
  const count = statuses.length;
  await sleep(100);
  assert.equal(second.connections, 1);
  assert.equal(statuses.length, count);
});

socketTest('herdr: rejected and unacknowledged subscriptions surface errors and can be closed during backoff', async t => {
  const box = sandbox(t);
  const fake = await fakeServer(t, box, ({ id }, socket) => {
    if (fake.requests.length === 1) socket.end(JSON.stringify({ id, error: { code: 'invalid_request', message: 'pane_id required' } }) + '\n');
  });
  const errors = [];
  const sub = core.herdrSubscribe([{ type: 'pane.created' }], () => assert.fail('no events expected'), {
    ...box, timeoutMs: 30, reconnectDelayMs: 10, onError: e => errors.push(e),
  });
  box.cleanups.push(() => sub.close());
  await eventually(() => errors.length >= 2, 'subscription errors');
  assert.equal(errors[0].code, 'invalid_request');
  assert.ok(errors[1] instanceof core.HerdrTimeoutError);
  sub.close();
  const count = fake.connections;
  await sleep(80);
  assert.equal(fake.connections, count);
});

socketTest('herdr: agent helpers forward exact verbs and snapshot refuses incompatible servers', async t => {
  const box = sandbox(t);
  let protocol = 22;
  const fake = await fakeServer(t, box, ({ id, method }, socket) => success(socket, id,
    method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: { version: '0.9.1', protocol, panes: [] } } : { type: 'ok' }));
  for (const [helper, method, params] of [
    ['start', 'agent.start', { name: 'oak', kind: 'codex', pane_id: 'w1:p1' }],
    ['waitFor', 'agent.wait', { target: 'oak', until: ['idle'], timeout_ms: 50000 }],
    ['prompt', 'agent.prompt', { target: 'oak', text: 'hello' }],
    ['read', 'agent.read', { target: 'oak', source: 'visible' }],
    ['sendKeys', 'agent.send_keys', { target: 'oak', keys: ['down', 'enter'] }],
    ['focus', 'agent.focus', { target: 'oak' }], ['get', 'agent.get', { target: 'oak' }],
  ]) {
    await core.herdrAgent[helper](params, box);
    assert.deepEqual({ method: fake.requests.at(-1).method, params: fake.requests.at(-1).params }, { method, params });
  }
  await core.herdrAgent.list(box);
  assert.equal(fake.requests.at(-1).method, 'agent.list');
  assert.deepEqual((await core.herdrSnapshot(box)).panes, []);
  protocol = 999;
  await assert.rejects(core.herdrSnapshot(box), { code: 'incompatible_version' });
});

// The fake herdr is a Node script behind the launcher each OS can run: a sh `exec` here, and on Windows
// a .cmd shim, which the helpers run through cmd.exe (Windows starts only .exe images directly).
function fakeBinary(t) {
  const box = sandbox(t);
  const script = path.join(box.dir, 'fake-herdr.js');
  fs.writeFileSync(script, `const argv = process.argv.slice(2), env = process.env;
if (env.FAKE_HANG) setTimeout(() => {}, 5000);
else if (env.FAKE_ERROR) { console.log('{"error":{"code":"agent_blocked","message":"dialog open"}}'); process.exitCode = 1; }
else if (env.FAKE_BAD) console.log('not json');
else if (env.FAKE_SILENT) { /* herdr 0.9.1's pane report-metadata and pane send-text: exit 0, no output */ }
else if (env.FAKE_TEXT !== undefined) process.stdout.write(env.FAKE_TEXT); // herdr 0.9.1's pane read: the pane's text as read
else if (env.FAKE_STDERR && argv[0] !== 'machine') { process.stderr.write(require('fs').readFileSync(env.FAKE_STDERR, 'utf8')); process.exitCode = 1; }
else if (argv[0] === 'status') console.log(env.FAKE_STATUS);
else if (argv[0] === 'machine') console.log('[]');
else console.log(JSON.stringify({ args: [0, 1, 2, 3].map(i => argv[i] ?? ''), socket: env.HERDR_SOCKET_PATH ?? '' }));
`);
  const binary = path.join(box.dir, process.platform === 'win32' ? 'herdr.cmd' : 'herdr');
  fs.writeFileSync(binary, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return { ...box, binary };
}

test('herdr: binary helpers parse JSON, preserve argv boundaries and surface command failures', async t => {
  const opts = fakeBinary(t);
  assert.deepEqual(await core.herdrMachines(opts), []);
  const label = 'machine with spaces; $(not-a-command)';
  assert.deepEqual(await core.herdrOnMachine(label, ['api', 'snapshot'], opts), {
    args: ['--machine', label, 'api', 'snapshot'], socket: opts.socketPath,
  });
  await assert.rejects(core.herdrOnMachine('remote', ['api', 'snapshot'], { ...opts, env: { ...opts.env, FAKE_ERROR: '1' } }), { code: 'agent_blocked', message: 'dialog open' });
  await assert.rejects(core.herdrMachines({ ...opts, env: { ...opts.env, FAKE_BAD: '1' } }), { code: 'invalid_response' });
  // A verb that succeeds silently resolves null only when the caller says it prints nothing; the JSON verbs still refuse it.
  const silent = { ...opts, env: { ...opts.env, FAKE_SILENT: '1' } };
  assert.equal(await core.herdrOnMachine('remote', ['pane', 'report-metadata', 'w1:p1'], { ...silent, emptyOk: true }), null);
  await assert.rejects(core.herdrOnMachine('remote', ['api', 'snapshot'], silent), { code: 'invalid_response' });
  await assert.rejects(core.herdrOnMachine('remote', ['pane', 'report-metadata'], { ...opts, emptyOk: true, env: { ...opts.env, FAKE_ERROR: '1' } }), { code: 'agent_blocked' });
  assert.deepEqual((await core.herdrOnMachine('remote', ['tab', 'rename'], { ...opts, emptyOk: true })).args, ['--machine', 'remote', 'tab', 'rename']);
  // A verb that prints text resolves it as printed when the caller says so; the JSON verbs refuse it, and an error is one still.
  const read = { ...opts, env: { ...opts.env, FAKE_TEXT: 'Working (5s)\n\n› Ask Codex\n' } };
  assert.equal(await core.herdrOnMachine('remote', ['pane', 'read', 'w1:p1', '--source', 'visible', '--format', 'text'], { ...read, text: true }), 'Working (5s)\n\n› Ask Codex\n');
  await assert.rejects(core.herdrOnMachine('remote', ['pane', 'read', 'w1:p1'], read), { code: 'invalid_response' });
  await assert.rejects(core.herdrOnMachine('remote', ['pane', 'read', 'w1:p1'], { ...opts, text: true, env: { ...opts.env, FAKE_ERROR: '1' } }), { code: 'agent_blocked' });
  await assert.rejects(core.herdrMachines({ ...opts, env: { ...opts.env, FAKE_HANG: '1' }, timeoutMs: 60 }), core.HerdrTimeoutError);
  // herdr.exe on Windows, as findHerdrBin resolves it: an image is started directly, so its absence is ENOENT.
  await assert.rejects(core.herdrMachines({ ...opts, binary: path.join(opts.dir, process.platform === 'win32' ? 'missing.exe' : 'missing') }), { code: 'binary_not_found' });
  await assert.rejects(core.herdrOnMachine('remote', ['api', 'snapshot'], { ...opts, binary: path.join(opts.dir, process.platform === 'win32' ? 'missing.exe' : 'missing') }), { code: 'binary_not_found' });
});

test('herdr: a stderr error envelope keeps its code and reads as its message', async t => {
  const opts = fakeBinary(t);
  const said = path.join(opts.dir, 'stderr.json');
  for (const code of ['pane_not_found', 'agent_blocked']) {
    const message = code === 'pane_not_found' ? 'pane w1:p1 not found' : 'agent is waiting for approval';
    fs.writeFileSync(said, JSON.stringify({ error: { code, message }, id: 'cli:request' }) + '\n');
    const env = { ...opts.env, FAKE_STDERR: said };
    for (const output of [{}, { emptyOk: true }, { text: true }]) {
      await assert.rejects(core.herdrOnMachine('build-box', ['pane', 'report-metadata', 'w1:p1'], { ...opts, ...output, env }),
        { name: 'HerdrError', code, message });
    }
    // Local binary helpers share the same decoding boundary.
    await assert.rejects(core.herdrVersion({ ...opts, env }), { name: 'HerdrError', code, message });
  }
});

// herdr ends a failed command with Rust's Debug form of the error, and OAK showed it as it came: the terminal
// app's status row read `herdr review tokens: Error: Custom { kind: ConnectionAborted, error: "machine '…'
// (session default): remote SSH connection failed: …" }` (2026-10-13). The first two lines below are what herdr
// 0.9.3 and 0.9.1 print when their ssh to a saved machine fails.
test('herdr: a failure herdr prints in Rust\'s Debug form reads as its message, and other text is kept (2026-10-13)', async t => {
  const opts = fakeBinary(t);
  const said = path.join(opts.dir, 'stderr.txt');
  const message = async (stderr) => {
    fs.writeFileSync(said, stderr);
    const error = await core.herdrOnMachine('build-box', ['pane', 'list'], { ...opts, env: { ...opts.env, FAKE_STDERR: said } }).then(() => null, (e) => e);
    assert.equal(error?.code, 'command_failed');
    return error.message;
  };
  assert.equal(await message(`Error: Custom { kind: ConnectionAborted, error: "machine 'build-box' (session default): remote SSH connection failed: ssh: connect to host fixture.invalid port 22: Operation timed out" }\n`),
    "machine 'build-box' (session default): remote SSH connection failed: ssh: connect to host fixture.invalid port 22: Operation timed out");
  assert.equal(await message(`Error: Custom { kind: Other, error: "machine 'build-box': remote platform detection failed: ssh: connect to host fixture.invalid port 22: Connection refused" }\n`),
    "machine 'build-box': remote platform detection failed: ssh: connect to host fixture.invalid port 22: Connection refused");
  // Rust's escapes: a quote and a backslash read as themselves, a tab as a space, and its lines are joined, so the
  // message stays one line. Any other control character stays written out, so a machine's text cannot drive the
  // terminal.
  assert.equal(await message(String.raw`Error: Custom { kind: Other, error: "machine 'build-box': remote SSH connection failed: Warning: Permanently added 'build-box' (ED25519) to the list of known hosts.\r\nsaid \"no\" to C:\\keys\tthere\n\u{1b}[2Jbanner\nPermission denied (publickey)." }` + '\n'),
    `machine 'build-box': remote SSH connection failed: Warning: Permanently added 'build-box' (ED25519) to the list of known hosts. — said "no" to C:\\keys there — \\u{1b}[2Jbanner — Permission denied (publickey).`);
  // Not that form: kept as it came.
  assert.equal(await message("error: unknown machine 'build-box'; use `herdr machine list`\n"), "error: unknown machine 'build-box'; use `herdr machine list`");
  assert.equal(await message(`warning: a line of its own\nError: Custom { kind: Other, error: "machine 'build-box': no \\"route\\"" }\n`), `warning: a line of its own\nmachine 'build-box': no "route"`);
  // A message that reads as nothing is herdr's line as it came, never Node's `Command failed: <path> …` with the line after it.
  assert.equal(await message('Error: Custom { kind: Other, error: "" }\n'), 'Error: Custom { kind: Other, error: "" }');
  assert.equal(await message('Error: Custom { kind: Other, error: "\\n\\n" }\n'), 'Error: Custom { kind: Other, error: "\\n\\n" }');
  // Beside another line too: the line is kept, not dropped for an empty one.
  assert.equal(await message('warning: a line of its own\nError: Custom { kind: Other, error: "" }\n'), 'warning: a line of its own\nError: Custom { kind: Other, error: "" }');
});

// Whether a saved machine's failure is that machine not answering, which the Observatory marks on the machine and the
// terminal app waits out without a word on the status row, or another failure, which the status row says once. The
// lines below are what herdr 0.9.1, 0.9.2 and 0.9.3 print when a saved machine is reached through a stand-in ssh that
// fails as ssh does (2026-10-13). A machine whose herdr is too old for machine API forwarding answers: its user has to
// update herdr there, which herdr 0.9.2 and 0.9.3 say under `remote binary discovery failed`.
test('herdr: which of herdr\'s failures say a saved machine cannot be reached, on herdr 0.9.1, 0.9.2 and 0.9.3 (2026-10-13)', async t => {
  const opts = fakeBinary(t);
  const said = path.join(opts.dir, 'stderr.txt');
  const unreachable = async (stderr) => {
    fs.writeFileSync(said, stderr + '\n');
    const error = await core.herdrOnMachine('build-box', ['pane', 'list'], { ...opts, env: { ...opts.env, FAKE_STDERR: said } }).then(() => null, (e) => e);
    assert.equal(error?.code, 'command_failed', stderr);
    return core.herdrUnreachable(error);
  };
  const cannot = [
    // herdr 0.9.1: connection refused, a connect timeout, an unknown host, a refused key.
    `Error: Custom { kind: Other, error: "machine 'build-box': remote platform detection failed: ssh: connect to host 127.0.0.1 port 1: Connection refused" }`,
    `Error: Custom { kind: Other, error: "machine 'build-box': remote platform detection failed: ssh: connect to host 192.0.2.1 port 22: Connection timed out" }`,
    `Error: Custom { kind: Other, error: "machine 'build-box': remote platform detection failed: ssh: Could not resolve hostname fixture.invalid: Name or service not known" }`,
    `Error: Custom { kind: Other, error: "machine 'build-box': remote platform detection failed: user@build-box: Permission denied (publickey)." }`,
    // herdr 0.9.2 and 0.9.3: the same, with the session named; a connect timeout reads as herdr 0.9.1's.
    `Error: Custom { kind: ConnectionAborted, error: "machine 'build-box' (session default): remote SSH connection failed: ssh: connect to host 127.0.0.1 port 1: Connection refused" }`,
    `Error: Custom { kind: ConnectionAborted, error: "machine 'build-box' (session default): remote SSH connection failed: ssh: Could not resolve hostname fixture.invalid: Name or service not known" }`,
    `Error: Custom { kind: ConnectionAborted, error: "machine 'build-box' (session default): remote SSH connection failed: user@build-box: Permission denied (publickey)." }`,
    `Error: Custom { kind: ConnectionAborted, error: "machine 'build-box' (session default): remote SSH connection failed: ssh: connect to host fixture.invalid port 22: Operation timed out" }`,
  ];
  for (const line of cannot) assert.equal(await unreachable(line), true, line);
  const other = [
    // The machine's herdr is too old: herdr 0.9.1, then 0.9.2 and 0.9.3 (once with the session named, once without).
    `Error: Custom { kind: Unsupported, error: "machine 'build-box': remote Herdr does not support machine API forwarding; update Herdr on this machine" }`,
    `Error: Custom { kind: Other, error: "machine 'build-box' (session default): remote binary discovery failed: remote Herdr does not support machine API forwarding; update Herdr on this machine" }`,
    `Error: Custom { kind: Other, error: "machine 'build-box': remote binary discovery failed: remote Herdr does not support machine API forwarding; update Herdr on this machine" }`,
    "error: unknown machine 'build-box'; use `herdr machine list`",
  ];
  for (const line of other) assert.equal(await unreachable(line), false, line);
  // OAK's own deadline passing first is the machine not answering too; herdr's refusal of the command is not.
  assert.equal(core.herdrUnreachable(await core.herdrOnMachine('build-box', ['pane', 'list'], { ...opts, env: { ...opts.env, FAKE_HANG: '1' }, timeoutMs: 60 }).then(() => null, (e) => e)), true);
  assert.equal(core.herdrUnreachable(await core.herdrOnMachine('build-box', ['pane', 'list'], { ...opts, env: { ...opts.env, FAKE_ERROR: '1' } }).then(() => null, (e) => e)), false);
  assert.equal(core.herdrUnreachable(new Error('oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out')), false, 'only herdr\'s own failures');
});

// A saved machine's command runs herdr's ssh there and, through a jump host, the jump host's ssh, which gets
// none of herdr's options. On the terminal app's terminal that ssh asked for a passphrase there, and the
// deadline stopped herdr alone, leaving both ssh running. This fake herdr starts a child that outlives it.
test('herdr: a saved machine\'s command runs apart from the terminal, refuses askpass, and its deadline stops all it started', { skip: process.platform === 'win32' && 'POSIX process groups' }, async t => {
  const box = sandbox(t);
  const log = path.join(box.dir, 'runs.log');
  const binary = path.join(box.dir, 'herdr');
  // Each run logs its first argument, its pid, its process group, its askpass setting, and where herdr's own
  // state is. One that hangs logs that it was asked to stop, and starts a child that ignores that request, which
  // only SIGKILL ends.
  fs.writeFileSync(binary, `#!/bin/sh
printf '%s %s %s %s %s %s\\n' "$1" "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" "\${SSH_ASKPASS_REQUIRE:-unset}" "\${XDG_CONFIG_HOME:-unset}" "\${HERDR_SOCKET_PATH:-unset}" >> "${log}"
case "$*" in
  *hang*) trap 'echo stopped >> "${log}"; exit 143' TERM; (trap '' TERM; exec sleep 30) </dev/null >/dev/null 2>&1 & wait ;;
  *flood*) head -c 17000000 /dev/zero; exec sleep 30 ;;
  'machine list --json') echo '[]' ;;
  *) echo '{"ok":true}' ;;
esac
`, { mode: 0o755 });
  const opts = { ...box, binary, env: { ...box.env, SSH_ASKPASS_REQUIRE: 'prefer' } };
  // Before each command for a saved machine, herdr is asked for that machine's target (`machine list`).
  const lines = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' '));
  const runs = () => lines().filter(([first]) => first !== 'machine');
  // Any other command runs as it did: in this process's group, with the caller's own askpass setting.
  assert.deepEqual(await core.herdrMachines(opts), []);
  const [, pid, group, askpass] = lines()[0];
  assert.notEqual(group, pid);
  assert.equal(askpass, 'prefer');
  // A saved machine's runs as the leader of a group of its own, with askpass refused and herdr's state kept.
  assert.deepEqual(await core.herdrOnMachine('box', ['api', 'snapshot'], opts), { ok: true });
  const [, remotePid, ...seen] = runs()[0];
  assert.deepEqual(seen, [remotePid, 'never', box.env.XDG_CONFIG_HOME, box.socketPath]);
  await assert.rejects(core.herdrOnMachine('box', ['hang'], { ...opts, timeoutMs: 300 }), core.HerdrTimeoutError);
  const hung = Number(runs()[1][2]);
  assert.deepEqual(runs()[2], ['stopped'], 'asked to stop (SIGTERM) before it is killed');
  await eventually(() => { try { process.kill(-hung, 0); return false; } catch (error) { return error.code === 'ESRCH'; } },
    'herdr, or the child it started, outlived the deadline');
  // One that prints without end is stopped once it passes the 16 MB a reply may have, not at its deadline.
  const flooded = Date.now();
  await assert.rejects(core.herdrOnMachine('box', ['flood'], { ...opts, timeoutMs: 20000 }), { code: 'command_failed', message: 'stdout maxBuffer length exceeded' });
  assert.ok(Date.now() - flooded < 10000, `stopped at 16 MB, not at its 20 s deadline (${Date.now() - flooded} ms)`);
});

// herdr 0.9.1 runs the `ssh` first on its PATH with options of its own, none of which says whether to share a
// connection: where the person's ssh_config has ControlMaster on and ControlPersist off, that ssh became the master
// the person's own sessions shared, and OAK's stop (a deadline, a quit, ctrl+c) ended them. This fake herdr execs
// `ssh` from PATH as herdr does; the fake ssh beside it answers `ssh -G` for each target and records how it ran.
test('herdr: a saved machine\'s ssh gets ControlMaster=no exactly where OAK\'s own ssh would', { skip: process.platform === 'win32' && 'POSIX PATH shim' }, async t => {
  const box = sandbox(t);
  const bin = path.join(box.dir, 'bin'), log = path.join(box.dir, 'ssh.log');
  fs.mkdirSync(bin);
  const machine = (label) => ({ id: `id-${label}`, label, target: `me@${label}`, session: 'default', enabled: true, selected: false });
  // Listed first, a machine whose label is plain's id: herdr takes that name as plain, by its id.
  const decoy = { ...machine('id-plain'), id: 'decoy', target: 'me@shared' };
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
case "$1" in
  machine) [ -z "$FAKE_LIST_FAILS" ] || exit 1; echo '${JSON.stringify([decoy, ...['shared', 'persisted', 'unprintable', 'plain'].map(machine)])}' ;;
  --machine) exec ssh -o BatchMode=yes -T "me@$2" /bin/sh -s ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then
  echo "G $2" >> "${log}"
  case "$2" in
    me@shared) printf 'user me\\ncontrolmaster auto\\ncontrolpersist no\\n' ;;
    me@persisted) printf 'user me\\ncontrolmaster auto\\ncontrolpersist 600\\n' ;;
    me@plain) [ -z "$FAKE_SLOW_G" ] || exec sleep 20; printf 'user me\\ncontrolmaster false\\ncontrolpersist no\\n' ;;
    *) echo 'bad configuration option' >&2; exit 255 ;;
  esac
  exit 0
fi
line=ran; for a in "$@"; do line="$line $a"; done
printf '%s\\n' "$line" >> "${log}" # one write each, so runs at once do not interleave
echo '{"ok":true}'
`, { mode: 0o755 });
  const opts = { ...box, binary: path.join(bin, 'herdr'), env: { ...box.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
  const herdrs = '-o BatchMode=yes -T';
  const ran = async (label, o = opts) => {
    fs.rmSync(log, { force: true });
    core.clearSshDecisions(); // each case asks afresh: a decision is kept for a minute
    assert.deepEqual(await core.herdrOnMachine(label, ['pane', 'list'], o), { ok: true });
    return fs.readFileSync(log, 'utf8').trim().split('\n');
  };
  // ControlMaster on, ControlPersist off: herdr's ssh may not become that master.
  assert.deepEqual(await ran('shared'), ['G me@shared', `ran -o ControlMaster=no ${herdrs} me@shared /bin/sh -s`]);
  // A persisted master runs in the background, where herdr's ssh can come and go: it still shares, as fast as before.
  assert.deepEqual(await ran('persisted'), ['G me@persisted', `ran ${herdrs} me@persisted /bin/sh -s`]);
  assert.deepEqual(await ran('plain'), ['G me@plain', `ran ${herdrs} me@plain /bin/sh -s`]);
  // By id too, as herdr takes it, and by id first: a label that is another machine's id names that machine.
  assert.deepEqual(await ran('id-shared'), ['G me@shared', `ran -o ControlMaster=no ${herdrs} me@id-shared /bin/sh -s`]);
  assert.deepEqual(await ran('id-plain'), ['G me@plain', `ran ${herdrs} me@id-plain /bin/sh -s`]);
  // No answer from `ssh -G` (it failed, or ran past 5 s), or no target to ask about: added, as for OAK's own ssh.
  assert.deepEqual(await ran('unprintable'), ['G me@unprintable', `ran -o ControlMaster=no ${herdrs} me@unprintable /bin/sh -s`]);
  assert.deepEqual(await ran('plain', { ...opts, env: { ...opts.env, FAKE_LIST_FAILS: '1' } }), [`ran -o ControlMaster=no ${herdrs} me@plain /bin/sh -s`]);
  // A send kept past the terminal app (keepOnExit) asks `ssh -G` nothing and gets the option unasked, even for a
  // machine whose configuration persists the master, where asking would have left it out.
  assert.deepEqual(await ran('persisted', { ...opts, keepOnExit: true }), [`ran -o ControlMaster=no ${herdrs} me@persisted /bin/sh -s`]);
  // One that does not answer (a slow `Match exec`) holds the command for 5 s at most, or for the command's own
  // budget when that is shorter.
  for (const [budget, within] of [[1500, 4000], [undefined, 12000]]) {
    const started = Date.now();
    assert.deepEqual(await ran('plain', { ...opts, timeoutMs: budget, env: { ...opts.env, FAKE_SLOW_G: '1' } }), ['G me@plain', `ran -o ControlMaster=no ${herdrs} me@plain /bin/sh -s`]);
    assert.ok(Date.now() - started < within, `with a ${budget ?? 'default'} ms budget, the command went on within ${within} ms (${Date.now() - started} ms)`);
  }
  // A budget of 0, which execFile reads as none, still stops `ssh -G` at 5 s. What the command does next is not the
  // question: runHerdr kills one with a 0 budget half a second in.
  const unbounded = Date.now();
  await core.herdrOnMachine('plain', ['pane', 'list'], { ...opts, timeoutMs: 0, env: { ...opts.env, FAKE_SLOW_G: '1' } }).catch(() => {});
  assert.ok(Date.now() - unbounded < 12000, `with a 0 ms budget, the command went on within 12000 ms (${Date.now() - unbounded} ms)`);
  // The shim: written once into a directory of this process's store that only this user can reach.
  const dir = path.join(require('../dist/store').rootDir(), 'herdr-ssh');
  assert.deepEqual(fs.readdirSync(dir), ['ssh']);
  assert.deepEqual([fs.statSync(dir).mode & 0o777, fs.statSync(path.join(dir, 'ssh')).mode & 0o777], [0o700, 0o700]);
  // A PATH that already starts with that directory still finds the real ssh after it: the shim never runs itself.
  assert.deepEqual(await ran('shared', { ...opts, timeoutMs: 3000, env: { ...opts.env, PATH: `${dir}${path.delimiter}${opts.env.PATH}` } }),
    ['G me@shared', `ran -o ControlMaster=no ${herdrs} me@shared /bin/sh -s`]);
  // One that others can write to is not run: herdr's ssh runs without `ControlMaster=no`.
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o777);
  assert.deepEqual(await ran('shared'), ['G me@shared', `ran ${herdrs} me@shared /bin/sh -s`]);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written there');
  // `oak doctor` names it on each machine whose ssh needed it, and not on one whose ssh did not.
  const doctor = async () => Object.fromEntries((await core.diagnoseHerdrForwarding(opts)).map((c) => [c.label.replace('herdr forwarding: ', ''), c]));
  const warned = await doctor();
  assert.deepEqual(['shared', 'persisted', 'unprintable', 'plain'].map((l) => warned[l].level), ['warn', 'ok', 'warn', 'ok']);
  assert.match(warned.shared.detail, /herdr's ssh ran without -o ControlMaster=no, which OAK adds for shared \(ControlMaster on with no ControlPersist, or a configuration `ssh -G` could not print\): .*is not a directory that only you can write to/);
  assert.match(warned.shared.fix, /ControlPersist/);
  // It is replaced whole, never written in place: an `ssh` there that links to another file leaves that file be.
  fs.chmodSync(dir, 0o700);
  const elsewhere = path.join(box.dir, 'elsewhere');
  fs.writeFileSync(elsewhere, 'not a shim\n');
  fs.symlinkSync(elsewhere, path.join(dir, 'ssh'));
  assert.deepEqual(await ran('shared'), ['G me@shared', `ran -o ControlMaster=no ${herdrs} me@shared /bin/sh -s`]);
  assert.deepEqual([fs.readFileSync(elsewhere, 'utf8'), fs.lstatSync(path.join(dir, 'ssh')).isFile()], ['not a shim\n', true]);
  // Once it is in place again, `oak doctor` no longer names it.
  assert.deepEqual(Object.values(await doctor()).map((c) => c.level), ['ok', 'ok', 'ok', 'ok', 'ok']);
  fs.rmSync(dir, { recursive: true });
  // A store whose path PATH cannot hold, or on a noexec mount, where herdr would pass over the shim: herdr's ssh
  // runs without the option, and `oak doctor` says why. Each runs in a process of its own, with that store.
  const ranShared = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('ran') && l.includes(' me@shared '));
  const withStore = async (config) => {
    fs.rmSync(log, { force: true });
    const herdr = JSON.stringify(path.join(__dirname, '../dist/herdr.js')), o = JSON.stringify({ binary: opts.binary });
    const { stdout } = await execFile(process.execPath, ['-e', `const h = require(${herdr}); h.herdrOnMachine('shared', ['pane', 'list'], ${o})
      .then(() => h.diagnoseHerdrForwarding(${o})).then((rows) => process.stdout.write(JSON.stringify(rows.find((r) => r.label === 'herdr forwarding: shared'))))`],
    { env: { ...opts.env, CLAUDE_CONFIG_DIR: config } });
    return JSON.parse(stdout);
  };
  const colon = path.join(box.dir, 'co:lon');
  const unheld = await withStore(colon);
  assert.deepEqual(ranShared(), Array(2).fill(`ran ${herdrs} me@shared /bin/sh -s`), 'herdr\'s ssh ran without it, in the command and in the doctor\'s');
  assert.deepEqual([unheld.level, fs.existsSync(path.join(colon, 'claude-observatory', 'herdr-ssh'))], ['warn', false]);
  assert.match(unheld.detail, /the store's path has a ":" in it, which PATH cannot hold/);
  const noexec = ['/run/lock', '/dev/shm'].map((parent) => {
    let probe;
    try { probe = fs.mkdtempSync(path.join(parent, 'oak-noexec-')); } catch { return undefined; }
    t.after(() => fs.rmSync(probe, { recursive: true, force: true }));
    fs.writeFileSync(path.join(probe, 'x'), '#!/bin/sh\n', { mode: 0o700 });
    try { fs.accessSync(path.join(probe, 'x'), fs.constants.X_OK); return undefined; } catch { return probe; }
  }).find(Boolean);
  await t.test('a store on a noexec mount', { skip: !noexec && 'no noexec mount to write to here (/run/lock, /dev/shm)' }, async () => {
    const unrun = await withStore(path.join(noexec, 'claude'));
    assert.deepEqual(ranShared(), Array(2).fill(`ran ${herdrs} me@shared /bin/sh -s`));
    assert.equal(unrun.level, 'warn');
    assert.match(unrun.detail, /herdr-ssh\/ssh cannot be run there; the store may be on a noexec mount\. OAK stops a herdr command/);
  });
  // Processes that write it at once, each into its store (box's), each run with it, and leave it whole.
  const theirs = path.join(box.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'herdr-ssh');
  assert.equal(fs.existsSync(theirs), false);
  const script = `require(${JSON.stringify(path.join(__dirname, '../dist/herdr.js'))}).herdrOnMachine('shared', ['pane', 'list'], ${JSON.stringify({ binary: opts.binary })}).then((v) => process.stdout.write(JSON.stringify(v)))`;
  fs.rmSync(log, { force: true });
  const results = await Promise.all(Array.from({ length: 8 }, () => execFile(process.execPath, ['-e', script], { env: opts.env })));
  assert.deepEqual(results.map((r) => r.stdout), Array(8).fill('{"ok":true}'));
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('ran')), Array(8).fill(`ran -o ControlMaster=no ${herdrs} me@shared /bin/sh -s`));
  assert.deepEqual(fs.readdirSync(theirs), ['ssh'], 'no temporary file left beside it');
});

// herdr 0.9.2 and later run that ssh with a connection of their own: `-F` and `-S` of theirs, and
// `-o ControlMaster=auto -o ControlPersist=600`, whose master runs in the background. An option put first wins in
// ssh, so the shim's `-o ControlMaster=no` made each command connect anew; it runs that ssh as herdr asked. This
// fake herdr passes what herdr 0.9.3 passes (its argv, captured from the 0.9.3 binary), the one before what 0.9.1 does.
test('herdr: the ssh of a herdr that keeps its own connection (0.9.2 and later) runs as herdr asked, and doctor has nothing to say of the shim (2026-10-07)', { skip: process.platform === 'win32' && 'POSIX PATH shim' }, async t => {
  const box = sandbox(t);
  const bin = path.join(box.dir, 'bin'), log = path.join(box.dir, 'ssh.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
case "$1" in
  --version) echo "herdr \${FAKE_HERDR_VERSION:-0.9.3}" ;;
  machine) echo '[{"id":"m1","label":"shared","target":"me@shared","session":"default","enabled":true,"selected":false}]' ;;
  --machine) if [ "\${FAKE_HERDR_VERSION:-0.9.3}" = 0.9.1 ]; then exec ssh -o BatchMode=yes -T "me@$2" /bin/sh -s; fi
    exec ssh -C -F "$HOME/herdr-ssh-config" -S "$HOME/hssh/%C" -o ControlMaster=auto -o ControlPersist=600 -o BatchMode=yes -T "me@$2" /bin/sh -s ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then printf 'user me\\ncontrolmaster auto\\ncontrolpersist no\\n'; exit 0; fi
line=ran; for a in "$@"; do line="$line $a"; done
printf '%s\\n' "$line" >> "${log}"
echo '{"ok":true}'
`, { mode: 0o755 });
  const opts = { ...box, binary: path.join(bin, 'herdr'), env: { ...box.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
  const own = `-C -F ${box.dir}/herdr-ssh-config -S ${box.dir}/hssh/%C -o ControlMaster=auto -o ControlPersist=600 -o BatchMode=yes -T me@shared /bin/sh -s`;
  const ran = async (o = opts) => {
    fs.rmSync(log, { force: true });
    core.clearSshDecisions();
    assert.deepEqual(await core.herdrOnMachine('shared', ['pane', 'list'], o), { ok: true });
    return fs.readFileSync(log, 'utf8').trim().split('\n');
  };
  // ControlMaster on and ControlPersist off for the target, where a 0.9.1 herdr's ssh gets ControlMaster=no.
  assert.deepEqual(await ran(), [`ran ${own}`], 'as herdr asked, through the shim');
  assert.deepEqual(await ran({ ...opts, keepOnExit: true }), [`ran ${own}`], 'a reply sent past the terminal app too');
  const old = { ...opts, env: { ...opts.env, FAKE_HERDR_VERSION: '0.9.1' } };
  assert.deepEqual(await ran(old), ['ran -o ControlMaster=no -o BatchMode=yes -T me@shared /bin/sh -s'], 'control: 0.9.1 still gets it');
  // Where the shim cannot be put in place, a 0.9.1 herdr's ssh runs without the option, which doctor names;
  // a 0.9.3 herdr's would not get it anyway, so doctor has nothing to say.
  const dir = path.join(require('../dist/store').rootDir(), 'herdr-ssh');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o777);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); // the next command writes it afresh
  const row = async (o) => (await core.diagnoseHerdrForwarding(o)).find((c) => c.label === 'herdr forwarding: shared');
  const warned = await row(old);
  assert.equal(warned.level, 'warn');
  assert.match(warned.detail, /herdr's ssh ran without -o ControlMaster=no/);
  const quiet = await row(opts);
  assert.equal(quiet.level, 'ok', quiet.detail);
  assert.doesNotMatch(quiet.detail, /ControlMaster/);
  core.clearSshDecisions();
});

// `oak doctor` asks herdr its version when a saved machine's ssh shim could not be put in place. On Windows a console
// program started without windowsHide by a process with no console (VS Code's extension host, the CLI a JetBrains IDE
// runs) opens a window of its own; only Windows shows it, so the options this launch hands child_process are read here.
test('herdr: doctor asks herdr its version with no console window on Windows (windowsHide)', { skip: process.platform === 'win32' && 'POSIX PATH shim' }, async t => {
  const box = sandbox(t);
  const bin = path.join(box.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
case "$1" in
  --version) echo "herdr 0.9.1" ;;
  machine) echo '[{"id":"m1","label":"shared","target":"me@shared","session":"default","enabled":true,"selected":false}]' ;;
  --machine) exec ssh -o BatchMode=yes -T "me@$2" /bin/sh -s ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then printf 'user me\\ncontrolmaster auto\\ncontrolpersist no\\n'; exit 0; fi
echo '{"ok":true}'
`, { mode: 0o755 });
  const opts = { ...box, binary: path.join(bin, 'herdr'), env: { ...box.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
  // A shim directory others can write to is not used, so doctor has a shim to ask about.
  const dir = path.join(require('../dist/store').rootDir(), 'herdr-ssh');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o777);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  core.clearSshDecisions();
  t.after(() => core.clearSshDecisions());
  await core.herdrOnMachine('shared', ['pane', 'list'], opts);
  const childProcess = require('node:child_process'), execFileReal = childProcess.execFile, asked = [];
  t.mock.method(childProcess, 'execFile', function (file, args, options, ...rest) {
    asked.push({ args, windowsHide: options?.windowsHide });
    return execFileReal.call(this, file, args, options, ...rest);
  });
  const row = (await core.diagnoseHerdrForwarding(opts)).find((c) => c.label === 'herdr forwarding: shared');
  assert.match(row.detail, /herdr's ssh ran without -o ControlMaster=no/, 'control: doctor reached the shim it asks herdr about');
  assert.deepEqual(asked.filter((c) => c.args?.[0] === '--version'), [{ args: ['--version'], windowsHide: true }]);
});

// The terminal app forwards a command to each saved machine every 15 s: herdr's machine list and `ssh -G` are asked
// once a minute per machine, not before every command, and every command still gets the option. A lookup that
// failed is asked again, and a reply sent past the terminal app (keepOnExit) never reads a kept decision.
test('herdr: a saved machine\'s ssh options are looked up once a minute, not before every command', { skip: process.platform === 'win32' && 'POSIX PATH shim' }, async t => {
  const box = sandbox(t);
  const bin = path.join(box.dir, 'bin'), log = path.join(box.dir, 'ssh.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
case "$1" in
  machine) echo list >> "${log}"; echo '[{"id":"m1","label":"shared","target":"me@shared","session":"default","enabled":true,"selected":false},{"id":"m2","label":"kept","target":"me@kept","session":"default","enabled":true,"selected":false}]' ;;
  --machine) exec ssh -o BatchMode=yes -T "me@$2" /bin/sh -s ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then echo "G $2" >> "${log}"; [ -z "$FAKE_G_FAILS" ] || exit 255
  case "$2" in me@kept) printf 'user me\\ncontrolmaster auto\\ncontrolpersist 600\\n' ;; *) printf 'user me\\ncontrolmaster auto\\ncontrolpersist no\\n' ;; esac; exit 0; fi
line=ran; for a in "$@"; do line="$line $a"; done
printf '%s\\n' "$line" >> "${log}"
echo '{"ok":true}'
`, { mode: 0o755 });
  const opts = { ...box, binary: path.join(bin, 'herdr'), env: { ...box.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
  const lines = () => { const l = fs.readFileSync(log, 'utf8').trim().split('\n'); fs.rmSync(log); return l; };
  const ran = '-o ControlMaster=no -o BatchMode=yes -T me@shared /bin/sh -s';
  core.clearSshDecisions();
  t.after(() => core.clearSshDecisions());
  for (let i = 0; i < 3; i++) assert.deepEqual(await core.herdrOnMachine('shared', ['pane', 'list'], opts), { ok: true });
  assert.deepEqual(lines(), ['list', 'G me@shared', `ran ${ran}`, `ran ${ran}`, `ran ${ran}`]);
  // A minute later it is asked again.
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try { await core.herdrOnMachine('shared', ['pane', 'list'], opts); } finally { Date.now = realNow; }
  assert.deepEqual(lines(), ['list', 'G me@shared', `ran ${ran}`]);
  // A reply sent past the terminal app reads no kept decision: here, one kept for a persisted master, where the
  // reply still gets the option unasked.
  await core.herdrOnMachine('kept', ['pane', 'list'], opts);
  assert.deepEqual(lines(), ['list', 'G me@kept', 'ran -o BatchMode=yes -T me@kept /bin/sh -s']);
  await core.herdrOnMachine('kept', ['pane', 'list'], { ...opts, keepOnExit: true });
  assert.deepEqual(lines(), ['ran -o ControlMaster=no -o BatchMode=yes -T me@kept /bin/sh -s']);
  // A lookup ssh could not answer is not kept: the next command asks again.
  core.clearSshDecisions();
  const failing = { ...opts, env: { ...opts.env, FAKE_G_FAILS: '1' } };
  await core.herdrOnMachine('shared', ['pane', 'list'], failing);
  await core.herdrOnMachine('shared', ['pane', 'list'], failing);
  assert.deepEqual(lines(), ['list', 'G me@shared', `ran ${ran}`, 'list', 'G me@shared', `ran ${ran}`]);
});

// The detached path keeps execFile's contract: its callback, its errors, and a maxBuffer of bytes on each stream.
// Its stop (a deadline or an overflow) closes the output pipes as execFile does: a process that left the group
// and holds them no longer holds the callback, and what a flood writes after its overflow is not kept.
test('execFileTool detached: maxBuffer counts bytes on both streams, an overflow ends it however it exits, and a stop does not wait on the pipes', { skip: process.platform === 'win32' && 'POSIX process groups' }, async t => {
  const box = sandbox(t);
  const spawn = require('../dist/spawn');
  const run = (script, options = {}) => new Promise((resolve) => {
    const started = Date.now();
    spawn.execFileTool('/bin/sh', ['-c', script], { detached: true, timeout: 20000, ...options },
      (error, stdout, stderr) => resolve({ error, stdout, stderr, ms: Date.now() - started }));
  });
  const node = JSON.stringify(process.execPath);
  // A large reply of two-byte characters arrives whole, and output a grandchild writes after its parent exited
  // is part of it: as with execFile, the callback waits for the output to end, not for the exit.
  const large = await run(`${node} -e "process.stdout.write('é'.repeat(1 << 20))"`, { maxBuffer: 4 << 20 });
  assert.equal(large.error, null);
  assert.equal(large.stdout, 'é'.repeat(1 << 20));
  const later = await run('(sleep 0.3; printf tail) & printf head');
  assert.deepEqual([later.error, later.stdout], [null, 'headtail'], 'the output that came after the exit');
  // 1.2 MB in 600 K characters is over a 1 MiB maxBuffer, as execFile counts it.
  const wide = await run(`${node} -e "process.stdout.write('é'.repeat(600 * 1024))"`, { maxBuffer: 1 << 20 });
  assert.deepEqual([wide.error?.code, wide.error?.message], ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'stdout maxBuffer length exceeded'], 'bytes, not characters');
  // The limit is each stream's, as execFile's is: 60 KB on each is under 100 KB, though both together are over it.
  const each = await run(`${node} -e "process.stdout.write('a'.repeat(60000)); process.stderr.write('b'.repeat(60000))"`, { maxBuffer: 100000 });
  assert.deepEqual([each.error, each.stdout.length, each.stderr.length], [null, 60000, 60000], 'counted per stream');
  // stderr has the same limit. This flood ignores SIGTERM and would write on until the SIGKILL half a second
  // later: none of that is kept.
  const flood = await run("trap '' TERM; head -c 20000000 /dev/zero >&2; sleep 30", { maxBuffer: 100000 });
  assert.deepEqual([flood.error?.code, flood.error?.message], ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'stderr maxBuffer length exceeded']);
  assert.ok(flood.ms < 10000, `stopped at its overflow, not at its 20 s deadline (${flood.ms} ms)`);
  assert.ok(flood.stderr.length <= 100000 + 65536, `nothing read after the overflow (${flood.stderr.length} characters kept)`);
  const exitsZero = await run("trap '' TERM; head -c 200000 /dev/zero; exit 0", { maxBuffer: 100000 });
  assert.equal(exitsZero.error?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'an overflow followed by exit 0 is still an overflow');
  // A daemon it starts (a session of its own, as an ssh ControlPersist master has) keeps both pipes open for
  // 20 s; the stop at the overflow after it does not wait for that.
  const pidFile = path.join(box.dir, 'daemon.pid');
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* none, or ended */ } });
  const daemon = await run(`${node} -e "const c = require('child_process').spawn('sleep', ['20'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); c.unref(); require('fs').writeFileSync(process.argv[1], String(c.pid)); process.stdout.write('x'.repeat(2 << 20))" ${JSON.stringify(pidFile)}; exec sleep 30`);
  assert.ok(fs.existsSync(pidFile), 'the daemon started before the stop');
  assert.equal(daemon.error?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.ok(daemon.ms < 10000, `the callback came at the stop, not when the daemon let go of the pipes (${daemon.ms} ms)`);
  // stopDetachedChildren signals only what still runs: an ended command's group id may belong to another by now.
  const kills = [];
  const mocked = t.mock.method(process, 'kill', (pid, signal) => { kills.push([pid, signal]); return true; });
  spawn.stopDetachedChildren();
  mocked.mock.restore();
  assert.deepEqual(kills, [], 'every command above has ended, and none is signalled');
  const started = path.join(box.dir, 'started');
  t.after(() => { try { process.kill(Number(fs.readFileSync(started, 'utf8')), 'SIGKILL'); } catch { /* none, or ended */ } });
  const hung = run(`sleep 30 & echo $! > ${JSON.stringify(started)}; wait`);
  for (const end = Date.now() + 10000; Date.now() < end && !fs.existsSync(started);) await new Promise((r) => setTimeout(r, 20));
  spawn.stopDetachedChildren();
  const stopped = await hung;
  assert.deepEqual([stopped.error?.signal, stopped.ms < 10000], ['SIGTERM', true], 'one still running is stopped, with the child it started');
});

// The terminal app stops each saved machine's herdr command as it ends (stopDetachedChildren), except the reply it
// is sending (keepOnExit), which finishes after it, as one sent from VS Code does.
test('execFileTool detached: stopDetachedChildren leaves a keepOnExit child to finish', { skip: process.platform === 'win32' && 'POSIX process groups' }, async t => {
  const box = sandbox(t);
  const spawn = require('../dist/spawn');
  const started = path.join(box.dir, 'started');
  const run = (name, options = {}) => new Promise((resolve) => spawn.execFileTool('/bin/sh', ['-c', `echo ${name} >> ${JSON.stringify(started)}; sleep 1; echo ${name} done`],
    { detached: true, timeout: 20000, ...options }, (error, stdout) => resolve({ error, stdout })));
  const both = [run('read'), run('send', { keepOnExit: true })];
  await eventually(() => fs.existsSync(started) && fs.readFileSync(started, 'utf8').trim().split('\n').length === 2, 'both started');
  spawn.stopDetachedChildren();
  const [read, send] = await Promise.all(both);
  assert.equal(read.error?.signal, 'SIGTERM', 'the read is stopped');
  assert.deepEqual([send.error, send.stdout], [null, 'send done\n'], 'the send finishes');
});

// Windows keeps execFile: there a detached child would get a console window of its own.
test('execFileTool detached: on Windows it is execFile, with no detached option', async t => {
  const spawn = require('../dist/spawn');
  const childProcess = require('node:child_process');
  const calls = [];
  t.mock.method(childProcess, 'spawn', () => { throw new Error('started apart'); });
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => { calls.push({ file, args, options }); queueMicrotask(() => callback(null, 'ok', '')); return {}; });
  const stdout = await new Promise((resolve, reject) => spawn.execFileTool('herdr.exe', ['--machine', 'box', 'api', 'snapshot'],
    { platform: 'win32', detached: true, timeout: 5, maxBuffer: 9 }, (error, out) => (error ? reject(error) : resolve(out))));
  assert.equal(stdout, 'ok');
  assert.deepEqual(calls.map(({ file, args, options }) => [file, args, 'detached' in options, options.timeout, options.maxBuffer, options.encoding]),
    [['herdr.exe', ['--machine', 'box', 'api', 'snapshot'], false, 5, 9, 'utf8']]);
});

// A command for this machine runs under execFile, whose deadline sends SIGTERM alone: one that ignores it is
// killed half a second later, so it cannot hold its caller.
test('herdr: a local command that ignores its deadline\'s SIGTERM is killed half a second later', { skip: process.platform === 'win32' && 'POSIX signals' }, async t => {
  const box = sandbox(t);
  const binary = path.join(box.dir, 'herdr');
  fs.writeFileSync(binary, "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n", { mode: 0o755 });
  const started = Date.now();
  await assert.rejects(core.herdrMachines({ ...box, binary, timeoutMs: 200 }), core.HerdrTimeoutError);
  assert.ok(Date.now() - started < 5000, `killed, not waited out (${Date.now() - started} ms)`);
});

test('herdr: status checks client, server, minimum version, protocol, and missing pin warning', async t => {
  const opts = fakeBinary(t);
  const lockDir = path.join(opts.dir, 'pin');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'herdr.lock'), JSON.stringify({ version: '0.9.1', protocol: 22, assets: {}, sha256: {} }));
  const client = { version: '0.9.1', protocol: 22 };
  const check = (server, overrides = {}) => core.herdrVersion({ ...opts, lockDir,
    env: { ...opts.env, FAKE_STATUS: JSON.stringify({ client, server }) }, ...overrides });
  assert.equal((await check({ running: false })).compatible, true);
  const server = { running: true, version: '0.9.1', protocol: 22, compatible: true, endpoint_compatible: true };
  assert.equal((await check(server)).compatible, true);
  assert.equal((await check({ ...server, version: '0.10.0' })).compatible, true);
  for (const changed of [{ version: '0.9.0' }, { version: '0.9.1-rc.1' }, { protocol: 23 }, { compatible: false }, { endpoint_compatible: false }]) {
    assert.equal((await check({ ...server, ...changed })).compatible, false);
  }
  // Each side keeps its own verdict, so a caller can tell which one fails: here only the binary on
  // disk (a newer herdr that bumped the protocol) while the running server still matches the pin.
  const split = await check(server, { env: { ...opts.env, FAKE_STATUS: JSON.stringify({ client: { version: '0.10.0', protocol: 23 }, server }) } });
  assert.deepEqual([split.compatible, split.binary, split.serverCompatible, split.paired, split.version],
    [false, { version: '0.10.0', protocol: 23, compatible: false }, true, true, '0.9.1']);
  const stale = await check({ ...server, version: '0.9.0', protocol: 21 });
  assert.deepEqual([stale.binary.compatible, stale.serverCompatible], [true, false], 'and here only the server');
  assert.equal((await check({ ...server, compatible: false })).paired, false, "herdr's own pairing verdict");
  client.version = '0.9.0';
  assert.equal((await check(server)).compatible, false);
  client.version = '0.9.1';
  const warnings = [];
  const noPin = await check(server, { lockDir: opts.dir, onWarning: message => warnings.push(message) });
  assert.equal(noPin.compatible, true);
  assert.deepEqual(noPin.warnings, warnings);
  assert.equal(warnings.length, 1);
  fs.writeFileSync(path.join(lockDir, 'herdr.lock'), '{}');
  await assert.rejects(check(server), /not a usable herdr.lock/);
});

test('herdr: generated declarations typecheck all methods and reject wrong params/subscriptions', t => {
  const box = sandbox(t);
  const file = path.join(box.dir, 'types.ts');
  const api = path.resolve(__dirname, '../dist/herdr-api').replaceAll('\\', '/');
  const adapter = path.resolve(__dirname, '../dist/herdr').replaceAll('\\', '/');
  fs.writeFileSync(file, `import { herdrRequest, herdrAgent } from ${JSON.stringify(adapter)};
import type { Method, Params, Result, Subscription } from ${JSON.stringify(api)};
type Assert<T extends true> = T;
type NoMissingResult = Assert<({ [M in Method]: Result<M> extends never ? M : never }[Method]) extends never ? true : false>;
async function example() {
  const created = await herdrRequest('workspace.create', { cwd: '/tmp' });
  const pane: string = created.root_pane.pane_id;
  const result = await herdrAgent.read({ target: pane, source: 'visible' });
  const text: string = result.read.text;
  // @ts-expect-error a pane target is required
  herdrRequest('pane.get', {});
  // @ts-expect-error invalid method
  herdrRequest('machine.list', {});
  // @ts-expect-error invalid read source
  herdrAgent.read({ target: pane, source: 'history' });
  // @ts-expect-error pane-specific subscription requires pane_id
  const bad: Subscription = { type: 'pane.agent_status_changed' };
}
`);
  const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: false,
    module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16, target: ts.ScriptTarget.ES2022,
    types: ['node'], typeRoots: [path.resolve(__dirname, '../../../node_modules/@types')] });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: f => f, getNewLine: () => '\n',
  }));
});

socketTest('herdr: live sandbox bootstrap, events, session identity, focused pane and snapshot', { timeout: 20000 }, async t => {
  const box = sandbox(t);
  const local = path.join(os.homedir(), '.local/bin/herdr');
  const binary = process.env.HERDR_BIN || (fs.existsSync(local) ? local : 'herdr');
  let version;
  try { version = (await execFile(binary, ['--version'], { env: box.env })).stdout.trim(); }
  catch (error) {
    if (!['ENOENT', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    const message = `SKIP LIVE HERDR: cannot execute herdr (${error.code}); NO live behavior verified.`;
    console.error(message);
    t.skip(message);
    return;
  }
  const socketProbe = await fakeServer(t, box, () => {});
  await socketProbe.stop();
  t.diagnostic(`Sandboxed ${version}; config=${box.env.XDG_CONFIG_HOME}`);
  const schema = JSON.parse((await execFile(binary, ['api', 'schema', '--json'], { env: box.env, maxBuffer: 16 * 1024 * 1024 })).stdout);
  // The committed types are generated from the pinned herdr. A newer one, which OAK keeps, has other methods
  // (herdr 0.9.2 removed `pane.graphics.*`), so only the pinned one is compared with them; the rest of this
  // test runs on either (checked on herdr 0.9.3).
  const pinned = require('../dist/herdr-lock').HERDR_LOCK.version, bare = version.replace(/^herdr\s+/, '');
  if (bare === pinned) assert.equal(generate(schema, bare), fs.readFileSync(path.join(__dirname, '../src/herdr-api.d.ts'), 'utf8'));
  else t.diagnostic(`herdr ${bare} is not the pinned ${pinned}: its API types were not compared with herdr-api.d.ts`);
  const server = cp.spawn(binary, ['server'], { env: box.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', failure;
  server.stderr.on('data', chunk => stderr += chunk);
  server.on('error', error => failure = error);
  box.cleanups.push(async () => {
    if (server.exitCode !== null || server.signalCode !== null || failure) return;
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 1000);
    await exited;
    clearTimeout(force);
  });
  const readyAt = Date.now();
  await eventually(async () => {
    if (failure) throw failure;
    assert.equal(server.exitCode, null, `herdr server exited: ${stderr}`);
    // bind publishes the socket before listen accepts connections. Only a pong proves readiness.
    try { return (await core.herdrRequest('ping', {}, box)).type === 'pong'; }
    catch (error) { if (error.code !== 'server_not_running') throw error; return false; }
  }, 'sandbox server answers ping', 10000);
  t.diagnostic(`Sandbox server answered ping after ${Date.now() - readyAt} ms`);
  const opts = { ...box, binary };
  const created = await core.herdrRequest('workspace.create', { cwd: box.dir, label: 'oak-client-test', focus: true }, opts);
  const pane_id = created.root_pane.pane_id;
  assert.ok(pane_id);
  const events = [], statuses = [];
  const sub = core.herdrSubscribe([{ type: 'pane.agent_detected' }, { type: 'pane.agent_status_changed', pane_id }], event => events.push(event), {
    ...opts, onStatus: status => statuses.push(status), onError: error => t.diagnostic(error.message),
  });
  box.cleanups.push(() => sub.close());
  await eventually(() => statuses.includes('connected'), 'subscription acknowledged');
  assert.equal((await core.herdrRequest('pane.report_agent', { pane_id, source: 'oak-test', agent: 'claude', state: 'working' }, opts)).type, 'ok');
  await eventually(() => events.some(event => event.event === 'pane.agent_status_changed' && event.data.agent_status === 'working'), 'working event received');
  const sessionId = 'oak-herdr-client-session';
  // herdr records a session identity ONLY when `source` is a registered integration id (verified 2026-09-18:
  // 'herdr:claude' sticks, 'oak'/'herdr:oak' return ok but record nothing) — OAK reports AS the integration.
  await core.herdrRequest('pane.report_agent_session', { pane_id, source: 'herdr:claude', agent: 'claude', agent_session_id: sessionId }, opts);
  const pane = (await core.herdrRequest('pane.get', { pane_id }, opts)).pane;
  assert.equal(pane.agent_session.value, sessionId);
  assert.equal((await core.herdrRequest('pane.current', {}, opts)).pane.pane_id, pane_id);
  const snapshot = await core.herdrSnapshot(opts);
  assert.equal(snapshot.panes.find(p => p.pane_id === pane_id).agent_session.value, sessionId);
  assert.equal((await core.herdrVersion(opts)).compatible, true);
  assert.deepEqual(await core.herdrMachines(opts), []);
});

test('herdr prompt handoff: match the live session, reject blocked and failed sends, never replay', async t => {
  const requests = [];
  let blocked = false, fail = false;
  memoryTransport(t, ({ id, method, params }, socket) => {
    requests.push({ method, params });
    if (method === 'session.snapshot') return socket.push(JSON.stringify({ id, result: {
      type: 'session_snapshot', snapshot: { protocol: 22, version: '0.9.1', panes: [{ pane_id: 'pane1', agent_session: { value: 's1' }, agent_status: blocked ? 'blocked' : 'idle' }] }
    } }) + '\n');
    if (fail) return socket.push(JSON.stringify({ id, error: { code: 'agent_blocked', message: 'permission pending' } }) + '\n');
    socket.push(JSON.stringify({ id, result: { type: 'agent_prompted' } }) + '\n');
  });
  const opts = { socketPath: '/tmp/memory-only.sock' };
  const result = await core.promptSession('s1', 'a prompt with \nnewlines', opts);
  assert.equal(result.sent, true);
  assert.deepEqual(requests.at(-1), { method: 'agent.prompt', params: { target: 'pane1', text: 'a prompt with \nnewlines' } });
  blocked = true;
  assert.equal((await core.promptSession('s1', 'retained', opts)).sent, false);
  assert.equal(requests.filter(r => r.method === 'agent.prompt').length, 1);
  blocked = false; fail = true;
  await assert.rejects(core.promptSession('s1', 'keep this draft', opts), /permission pending/);
  assert.equal(requests.filter(r => r.method === 'agent.prompt').length, 2, 'failed submission is never retried');
});

// herdr 0.9.1 calls a Codex pane blocked whenever Codex's title says "Action Required", which Codex keeps while a
// question it asked waits as its turn runs on. OAK reads that pane as working with a question waiting while the
// session's rollout shows the turn open and recently written, and no permission prompt stands.
test('herdr pane state: a Codex agent working with a question waiting reads as working; every other state is herdr\'s', async t => {
  const now = Date.parse('2026-10-23T10:00:00Z');
  const codex = { agent_status: 'blocked', agent: 'codex', agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: 's1' } };
  const asking = { id: 's1', agent: 'codex', turnOpen: true, lastActiveMs: now - 10_000, attention: null };
  const state = (pane, row, at = now) => core.paneAgentState(pane, row, at);
  assert.deepEqual(state(codex, asking), { status: 'working', question: true }, 'mid-turn, recently written: working, a question waiting');
  assert.deepEqual(state(codex, { ...asking, turnOpen: false }), { status: 'blocked', question: false }, 'the turn ended: blocked stays blocked');
  assert.deepEqual(state(codex, { ...asking, turnOpen: undefined }), { status: 'blocked', question: false }, 'the rollout could not say');
  assert.equal(core.CODEX_QUESTION_WINDOW_MS, 90_000);
  const edge = now - core.CODEX_QUESTION_WINDOW_MS;
  assert.deepEqual(state(codex, { ...asking, lastActiveMs: edge }), { status: 'working', question: true }, 'written exactly a window ago');
  assert.deepEqual(state(codex, { ...asking, lastActiveMs: edge - 1 }), { status: 'blocked', question: false }, 'a "running" turn quiet past the window is waiting, as herdr says');
  assert.deepEqual(state(codex, asking, now + core.CODEX_QUESTION_WINDOW_MS), { status: 'blocked', question: false }, 'the same row, read once the window has passed');
  for (const hand of ['permission', 'question', 'input']) {
    assert.deepEqual(state(codex, { ...asking, attention: { kind: hand, message: 'Bash', ts: now } }), { status: 'blocked', question: false }, `a ${hand} hand: Codex is stopped`);
  }
  assert.deepEqual(state(codex, { ...asking, attention: { kind: 'idle-done', message: '', ts: now - 60_000 } }), { status: 'working', question: true }, 'a finished turn\'s quiet hand does not outrank the open turn');
  const claude = { agent_status: 'blocked', agent: 'claude', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 's1' } };
  assert.deepEqual(state(claude, asking), { status: 'blocked', question: false }, 'a Claude pane is unchanged');
  assert.deepEqual(state({ agent_status: 'blocked', agent: 'codex' }, asking), { status: 'working', question: true }, 'herdr\'s own detection names the agent');
  assert.deepEqual(state(codex, undefined), { status: 'blocked', question: false }, 'no row for the pane');
  for (const status of ['working', 'idle', 'done', 'unknown']) assert.deepEqual(state({ ...codex, agent_status: status }, asking), { status, question: false }, `${status} is herdr's`);
  // The send rule holds: herdr refuses a prompt to a pane it calls blocked (agent_blocked, before any input), so the
  // reply stays a draft and nothing reaches the pane.
  const requests = [];
  memoryTransport(t, ({ id, method }, socket) => {
    requests.push(method);
    if (method === 'session.snapshot') return socket.push(JSON.stringify({ id, result: {
      type: 'session_snapshot', snapshot: { protocol: 22, version: '0.9.1', panes: [{ pane_id: 'pane1', ...codex }] } } }) + '\n');
    socket.push(JSON.stringify({ id, result: { type: 'agent_prompted' } }) + '\n');
  });
  const result = await core.promptSession('s1', 'my answer', { socketPath: '/tmp/memory-only.sock' });
  assert.equal(result.sent, false);
  assert.match(result.reason, /answer it in herdr/);
  assert.deepEqual(requests, ['session.snapshot'], 'no prompt is sent');
});

// Past the window a long command leaves the rollout quiet, and herdr's word stands unless the pane's screen showed Codex at
// work (`screenWorking`, the revision the terminal app read it at): only a pane in that state has its screen read.
test('herdr pane state: past the window, a Codex pane whose screen showed Codex at work is working with a question waiting', () => {
  const now = Date.parse('2026-10-29T10:00:00Z');
  const codex = { agent_status: 'blocked', agent: 'codex', agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: 's1' }, revision: 4 };
  const quiet = { id: 's1', agent: 'codex', turnOpen: true, lastActiveMs: now - 600_000, attention: null };
  assert.deepEqual(core.paneAgentState(codex, quiet, now), { status: 'blocked', question: false }, 'control: quiet past the window, nothing read: herdr\'s word');
  assert.equal(core.paneScreenDecides(codex, quiet, now), true, 'so its screen decides');
  const seen = { ...codex, screenWorking: 4 };
  assert.deepEqual(core.paneAgentState(seen, quiet, now), { status: 'working', question: true }, 'its screen showed Codex at work');
  assert.deepEqual(core.paneAgentState({ ...seen, revision: 0, screenWorking: 0 }, quiet, now), { status: 'working', question: true }, 'at revision 0, as herdr 0.9.1 gives every pane');
  const claude = { ...seen, agent: 'claude', agent_session: { ...seen.agent_session, agent: 'claude' } };
  for (const [why, pane, row] of [['the turn ended', seen, { ...quiet, turnOpen: false }], ['the rollout could not say', seen, { ...quiet, turnOpen: undefined }],
    ['a permission prompt stands', seen, { ...quiet, attention: { kind: 'permission', message: 'Bash', ts: now } }], ['a Claude pane', claude, quiet],
    ['herdr says idle', { ...seen, agent_status: 'idle' }, quiet], ['no row for the pane', seen, undefined]]) {
    assert.equal(core.paneAgentState(pane, row, now).question, false, `${why}: herdr's word`);
    assert.equal(core.paneScreenDecides(pane, row, now), false, `${why}: its screen is not read`);
  }
  // Within the window the rollout decides, and no screen is read.
  const recent = { ...quiet, lastActiveMs: now - 10_000 };
  assert.deepEqual(core.paneAgentState(codex, recent, now), { status: 'working', question: true });
  assert.equal(core.paneScreenDecides(codex, recent, now), false);
});

// herdr's Codex manifest matches Codex's live status row above its current prompt (rule `screen_working_fallback`, in the
// manifest that makes the interrupt hint optional); the port answers as herdr's own engine does (`herdr agent explain
// --file`, checked on these screens), except where herdr finds no current prompt and reads the whole screen: OAK claims
// no working pane without one. Synthetic screens only.
test('herdr: codexScreenWorking reads Codex\'s timer row above its current prompt, as herdr\'s Codex rule does', () => {
  const prompt = '\n\n› Ask Codex to do anything\n\n  model-x high · ~/project · Context 40% used · weekly 70% left\n';
  const working = {
    'the long command with a question queued': '• Ran npm test\n  └ Show details\n\nWorking (2m 05s • esc to interrupt) · Running hook\n\n• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer' + prompt,
    'the timer with the interrupt hint': 'Working (5s • esc to interrupt)' + prompt,
    'the timer without it': 'Working (12s)' + prompt,
    'the timer and an activity': 'Working (1m 05s • esc to interrupt) · Running tests' + prompt,
    'the timer, no hint, an activity': 'Thinking (3s) · Reading files' + prompt,
    'hours, and another interrupt key': 'Working (1h 2m 3s • ctrl+c to interrupt)' + prompt,
    'a bullet before the timer': '• Working (5s • esc to interrupt)' + prompt,
    'a hollow bullet before the timer': '◦ Exploring (17s)' + prompt,
    'messages queued after the next tool call': 'Working (8s)\n\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ check the logs' + prompt,
    'messages queued for the end of the turn': 'Working (8s)\n\n• Messages to be submitted at end of turn\n  ↳ then deploy' + prompt,
    'a prompt whose space a sparkle replaced': 'Working (8s)\n›⠂ the queued ask' + prompt,
    'typed text at the prompt': 'Working (8s)\n\n› fix the flaky test\n',
    'a bare prompt, no newline at the end': 'Working (8s)\n\n›',
  };
  for (const [what, screen] of Object.entries(working)) assert.equal(core.codexScreenWorking(screen), true, what);
  const not = {
    'a finished turn': '• Built it.\n\n─ Worked for 3m 2s ─────────' + prompt,
    'conversation text that reads Working (draft)': '• I kept the Working (draft) notes.\n• Then the build ran.' + prompt,
    'a timer-like line with a response after it': 'Working (5s) was the old label\n• Then the build ran.' + prompt,
    'an interruption after the timer': 'Working (5s • esc to interrupt)\n■ Conversation interrupted' + prompt,
    'the Reconnect failed row': 'Reconnect failed — check the endpoint, then relaunch (5s)' + prompt,
    'the Reconnect failed row with a bullet': '• Reconnect failed — check the endpoint, then relaunch (1m 5s)' + prompt,
    'the Reconnect failed row under a timer': 'Working (5s)\nReconnect failed — check the endpoint, then relaunch (5s)' + prompt,
    'no prompt marker': 'Working (5s • esc to interrupt)\n\n  model-x high · ~/project · Context 40% used\n',
    'a prompt only indented': 'Working (5s)\n\n  › Ask Codex\n',
    'a prompt already sent, a response after it': 'Working (5s)\n\n› Ask Codex\n\n• Done.\n',
    'the timer below the prompt': '› Ask Codex\nWorking (5s)\n',
    'a space in the timer': 'Working (5 s)' + prompt,
    'no seconds': 'Working (3m)' + prompt,
    'a timer that opens with a space': ' Working (5s)' + prompt,
    'nothing at all': '',
  };
  for (const [what, screen] of Object.entries(not)) assert.equal(core.codexScreenWorking(screen), false, what);
});

/** A PATH whose first entry holds an `ssh` that machineSsh finds (execFileTool is mocked, so it never runs): without
 *  one, machineSsh asks nothing on POSIX either, as on Windows. */
function pathWithSsh(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-ssh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ssh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return `${dir}${path.delimiter}${process.env.PATH}`;
}

test('herdr prompt handoff: remote forwarding preserves text arguments and unavailable panes stay drafts', async t => {
  const spawn = require('../dist/spawn');
  const env = { ...process.env, PATH: pathWithSsh(t) };
  const calls = [], lookups = [];
  let found = true;
  t.mock.method(spawn, 'execFileTool', (_binary, argv, options, callback) => {
    // Each is preceded by the lookup of that machine's target, herdr's `machine list`, run as any local command.
    // Recorded, not asserted here: machineSsh swallows a throw from the lookup (it adds the option unasked).
    if (argv[0] === 'machine') {
      lookups.push(options.detached);
      queueMicrotask(() => callback(null, '[]', ''));
      return { on() {} };
    }
    calls.push(argv);
    // A saved machine's command: apart from the terminal, and its ssh refuses askpass (see the fake-binary test).
    assert.deepEqual([options.detached, options.env.SSH_ASKPASS_REQUIRE], [true, 'never']);
    const value = argv.includes('snapshot') ? { snapshot: { version: '0.9.1', protocol: 22, panes: found ? [{ pane_id: 'remote-pane', agent_session: { value: 's1' }, agent_status: 'idle' }] : [] } } : { ok: true };
    queueMicrotask(() => callback(null, JSON.stringify(value), ''));
    return { on() {} };
  });
  const text = '--keep literal $HOME and `code`\nsecond line';
  assert.equal((await core.promptSession('s1', text, { machine: 'build-box', env })).sent, true);
  assert.deepEqual(calls.at(-1), ['--machine', 'build-box', 'agent', 'prompt', 'remote-pane', text]);
  found = false;
  assert.equal((await core.promptSession('s1', text, { machine: 'build-box', env })).sent, false);
  assert.equal(calls.filter(c => c.includes('prompt')).length, 1);
  // On Windows machineSsh asks nothing (OAK never stops herdr's ssh there), so there is no lookup to look at.
  assert.deepEqual(lookups, process.platform === 'win32' ? [] : [undefined, undefined, undefined], 'each lookup runs as a local command, not apart from the terminal');
});

test('herdr prompt handoff: forwarded commands get the remote budget, and a timed-out prompt may have landed', async t => {
  const spawn = require('../dist/spawn');
  const calls = [], lookups = [];
  let hang = false;
  t.mock.method(spawn, 'execFileTool', (_binary, argv, options, callback) => {
    // The lookup of the machine's target before each (herdr's `machine list`) keeps the local budget. Recorded and
    // asserted below: a throw here would be swallowed (machineSsh adds the option unasked).
    if (argv[0] === 'machine') {
      lookups.push(options.timeout);
      queueMicrotask(() => callback(null, '[]', ''));
      return { on() {} };
    }
    calls.push({ argv, timeout: options.timeout });
    if (hang && argv.includes('prompt')) {
      // execFile's deadline: the child is killed and the error says so.
      queueMicrotask(() => callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', ''));
      return { on() {} };
    }
    const value = argv.includes('snapshot') ? { snapshot: { version: '0.9.1', protocol: 22, panes: [{ pane_id: 'remote-pane', agent_session: { value: 's1' }, agent_status: 'idle' }] } } : { ok: true };
    queueMicrotask(() => callback(null, JSON.stringify(value), ''));
    return { on() {} };
  });
  const box = { machine: 'build-box', env: { PATH: pathWithSsh(t) } };
  assert.equal((await core.promptSession('s1', 'hello', box)).sent, true);
  assert.deepEqual(calls.map(c => c.timeout), [30000, 30000],
    'the forwarded snapshot and prompt get the 30 s remote budget, not the 15 s local default (forwarding measured at 21–25 s)');
  calls.length = 0;
  assert.equal((await core.promptSession('s1', 'hello', { ...box, env: { ...box.env, OAK_HERDR_REMOTE_TIMEOUT_MS: '60000' } })).sent, true);
  assert.deepEqual(calls.map(c => c.timeout), [60000, 60000], 'the same knob as the terminal app lengthens it');
  assert.deepEqual(lookups, process.platform === 'win32' ? [] : [15000, 15000, 15000, 15000], 'each lookup keeps the local budget, however long the remote one is');
  calls.length = 0;
  assert.equal((await core.promptSession('s1', 'hello', { ...box, timeoutMs: 5000 })).sent, true);
  assert.deepEqual(calls.map(c => c.timeout), [5000, 5000], 'a caller’s explicit budget still wins');
  hang = true;
  calls.length = 0;
  const timedOut = await core.promptSession('s1', 'hello', box);
  assert.equal(timedOut.sent, false, 'a timed-out forwarded prompt is not reported as sent…');
  assert.match(timedOut.reason, /did not confirm the prompt within 30 s — it may already be in pane remote-pane; check that pane before sending the draft again/,
    '…nor as a plain failure: the text may have reached the pane, so the reader is told to look before resending');
  assert.equal(calls.filter(c => c.argv.includes('prompt')).length, 1, 'and nothing retried the prompt on its own');
});

test('herdr regression: CLI snapshot envelopes share validation and remote prompt decoding', async t => {
  const snapshot = { version: '0.9.1', protocol: 22, panes: [{ pane_id: 'p1', agent_session: { value: 'fixture-session' }, agent_status: 'idle' }], agents: [] };
  const envelope = { id: 'cli:api:snapshot', result: { type: 'session_snapshot', snapshot } };
  const calls = [];
  t.mock.method(require('../dist/spawn'), 'execFileTool', (_binary, argv, _options, callback) => {
    if (argv[0] === 'machine') return queueMicrotask(() => callback(null, '[]', '')); // the lookup of its target
    calls.push(argv);
    queueMicrotask(() => callback(null, JSON.stringify(argv.includes('snapshot') ? envelope : { result: { type: 'ok' } }), ''));
  });
  assert.equal((await core.promptSession('fixture-session', 'hello', { machine: 'fixture' })).sent, true);
  assert.equal(calls.length, 2);
  for (const value of [envelope, { snapshot }, snapshot]) assert.deepEqual(core.snapshotFromCli(value), snapshot);
  for (const value of [null, [], {}, { snapshot: { ...snapshot, panes: null } }]) {
    assert.throws(() => core.snapshotFromCli(value), { code: 'invalid_response' });
  }
  for (const changed of [{ version: '0.9.0' }, { protocol: 999 }]) {
    assert.throws(() => core.snapshotFromCli({ ...snapshot, ...changed }), { code: 'incompatible_version' });
  }
  assert.throws(() => core.snapshotFromCli({ error: { code: 'server_not_running', message: 'offline' } }), { code: 'server_not_running' });
});

test('herdr regression: marker and connection paths follow platform and named sessions', () => {
  const win = { APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\fixture' };
  const marker = path.win32.join(win.APPDATA, 'herdr', 'herdr.sock');
  assert.equal(core.herdrSocketPath(win, 'win32'), marker);
  assert.equal(core.herdrConnectPath(win, 'win32'), `\\\\.\\pipe\\${marker}`);
  assert.equal(core.herdrSocketPath({ USERPROFILE: win.USERPROFILE }, 'win32'), marker);
  assert.equal(core.herdrSocketPath({ ...win, XDG_CONFIG_HOME: 'D:\\config' }, 'win32'), 'D:\\config\\herdr\\herdr.sock');
  for (const platform of ['linux', 'darwin']) {
    const env = { XDG_CONFIG_HOME: '/tmp/config', HERDR_SESSION: 'work' };
    assert.equal(core.herdrSocketPath(env, platform), '/tmp/config/herdr/sessions/work/herdr.sock');
    assert.equal(core.herdrConnectPath(env, platform), core.herdrSocketPath(env, platform));
    assert.equal(core.herdrSocketPath({ ...env, HERDR_SESSION: 'default' }, platform), '/tmp/config/herdr/herdr.sock');
    assert.equal(core.herdrSocketPath({ ...env, HERDR_SOCKET_PATH: '/tmp/explicit.sock' }, platform), '/tmp/explicit.sock');
  }
  assert.equal(core.herdrSocketPath({ ...win, HERDR_SESSION: 'work' }, 'win32'), path.win32.join(win.APPDATA, 'herdr', 'sessions', 'work', 'herdr.sock'));
  assert.equal(core.herdrConnectPath({ ...win, HERDR_SESSION: 'work', HERDR_SOCKET_PATH: 'D:\\explicit.sock' }, 'win32'), '\\\\.\\pipe\\D:\\explicit.sock');
});

test('herdr regression: both Windows transports connect to the pipe for an explicit marker', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const marker = 'C:\\Users\\fixture\\herdr.sock';
  const connections = memoryTransport(t, ({ id, method }, socket) => {
    socket.push(JSON.stringify({ id, result: { type: method === 'events.subscribe' ? 'subscription_started' : 'pong' } }) + '\n');
  });
  await core.herdrRequest('ping', {}, { socketPath: marker });
  let connected = false;
  const subscription = core.herdrSubscribe([], () => {}, { socketPath: marker, onStatus: status => { connected = status === 'connected'; } });
  t.after(() => subscription.close());
  await eventually(() => connected, 'Windows subscription acknowledgement');
  subscription.close();
  assert.deepEqual(connections.map(c => c.socketPath), [`\\\\.\\pipe\\${marker}`, `\\\\.\\pipe\\${marker}`]);
});

test('herdr regression: fake binary receives prompt as one positional including leading dashes', { skip: process.platform === 'win32' }, async t => {
  const box = sandbox(t);
  const binary = path.join(box.dir, 'herdr');
  const log = path.join(box.dir, 'argv');
  fs.writeFileSync(binary, `#!/bin/sh
if [ "$3" = api ]; then
  printf '%s\\n' '{"id":"snapshot","result":{"type":"session_snapshot","snapshot":{"version":"0.9.1","protocol":22,"panes":[{"pane_id":"p1","agent_session":{"value":"fixture-session"},"agent_status":"idle"}],"agents":[]}}}'
else
  printf '%s\\0' "$@" > "$ARGV_LOG"
  printf '%s\\n' '{"result":{"type":"ok"}}'
fi
`, { mode: 0o755 });
  const text = '--literal $value and `code`\n猫😀';
  assert.equal((await core.promptSession('fixture-session', text, { ...box, binary, machine: 'fixture', env: { ...box.env, ARGV_LOG: log } })).sent, true);
  assert.deepEqual(fs.readFileSync(log, 'utf8').split('\0').slice(0, -1), ['--machine', 'fixture', 'agent', 'prompt', 'p1', text]);
});

test('herdr regression: installed CLI parses ordinary and dash-leading prompt text', async t => {
  const binary = process.env.HERDR_BIN || require('../dist/herdr-install').findHerdrBin() || 'herdr';
  try { await execFile(binary, ['--version']); }
  catch (error) {
    if (!['ENOENT', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    const reason = `SKIP REAL HERDR PARSER: binary unavailable (${error.code}); agent_not_found not verified.`;
    console.error(reason); return t.skip(reason);
  }
  const unavailable = [];
  for (const text of ['hello', '--dash-leading-text']) {
    let output = '';
    try { output = (await execFile(binary, ['agent', 'prompt', `oak-missing-${require('node:crypto').randomUUID()}`, text], { timeout: 3000 })).stdout; }
    catch (error) { output = `${error.stdout || ''}\n${error.stderr || ''}`; }
    assert.doesNotMatch(output, /unknown option/);
    if (/Operation not permitted|Permission denied|server_not_running|not running|No such file|Connection refused/i.test(output)) {
      unavailable.push(`${text}: ${output.trim()}`);
      continue;
    }
    assert.match(output, /agent_not_found/);
  }
  if (unavailable.length) {
    const reason = `SKIP REAL HERDR TARGET: server unavailable; agent_not_found not verified: ${unavailable.join('; ')}`;
    console.error(reason); t.skip(reason);
  }
});

test('herdr new sessions: protocol gate, create terminal, start agent; failure leaves the shell address', async t => {
  const requests = [];
  let fail = false;
  memoryTransport(t, ({ id, method, params }, socket) => {
    requests.push({ method, params });
    const result = method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: { protocol: 22, version: '0.9.1', panes: [] } }
      : method === 'tab.create' ? { type: 'tab_created', root_pane: { pane_id: 'p1' } } : { type: 'agent_started' };
    socket.push(JSON.stringify(method === 'agent.start' && fail ? { id, error: { code: 'launch_failed', message: 'no binary' } } : { id, result }) + '\n');
  });
  const opts = { socketPath: '/tmp/memory-only.sock' };
  assert.equal((await core.startAgentSession('codex', '/work', opts)).pane, 'p1');
  assert.deepEqual(requests.map(r => r.method), ['session.snapshot', 'tab.create', 'agent.start']);
  assert.equal(requests[1].params.cwd, '/work');
  assert.equal(requests[2].params.kind, 'codex');
  assert.equal(requests[2].params.pane_id, 'p1');
  fail = true;
  await assert.rejects(core.startAgentSession('claude', '/work', opts), /pane p1.*no binary/);
  await assert.rejects(core.startAgentSession('unknown', '/work', opts), /Unsupported agent/);
});
