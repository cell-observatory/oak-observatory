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
  while (!check()) {
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
  await assert.rejects(core.herdrMachines({ ...opts, env: { ...opts.env, FAKE_HANG: '1' }, timeoutMs: 60 }), core.HerdrTimeoutError);
  // herdr.exe on Windows, as findHerdrBin resolves it: an image is started directly, so its absence is ENOENT.
  await assert.rejects(core.herdrMachines({ ...opts, binary: path.join(opts.dir, process.platform === 'win32' ? 'missing.exe' : 'missing') }), { code: 'binary_not_found' });
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
  assert.equal(generate(schema, version.replace(/^herdr\s+/, '')), fs.readFileSync(path.join(__dirname, '../src/herdr-api.d.ts'), 'utf8'));
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
  await eventually(() => {
    if (failure) throw failure;
    assert.equal(server.exitCode, null, `herdr server exited: ${stderr}`);
    return fs.existsSync(box.socketPath);
  }, 'sandbox server socket', 10000);
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

test('herdr prompt handoff: remote forwarding preserves text arguments and unavailable panes stay drafts', async t => {
  const spawn = require('../dist/spawn');
  const calls = [];
  let found = true;
  t.mock.method(spawn, 'execFileTool', (_binary, argv, _options, callback) => {
    calls.push(argv);
    const value = argv.includes('snapshot') ? { snapshot: { version: '0.9.1', protocol: 22, panes: found ? [{ pane_id: 'remote-pane', agent_session: { value: 's1' }, agent_status: 'idle' }] : [] } } : { ok: true };
    queueMicrotask(() => callback(null, JSON.stringify(value), ''));
    return { on() {} };
  });
  const text = '--keep literal $HOME and `code`\nsecond line';
  assert.equal((await core.promptSession('s1', text, { machine: 'build-box' })).sent, true);
  assert.deepEqual(calls.at(-1), ['--machine', 'build-box', 'agent', 'prompt', 'remote-pane', text]);
  found = false;
  assert.equal((await core.promptSession('s1', text, { machine: 'build-box' })).sent, false);
  assert.equal(calls.filter(c => c.includes('prompt')).length, 1);
});

test('herdr prompt handoff: forwarded commands get the remote budget, and a timed-out prompt may have landed', async t => {
  const spawn = require('../dist/spawn');
  const calls = [];
  let hang = false;
  t.mock.method(spawn, 'execFileTool', (_binary, argv, options, callback) => {
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
  const box = { machine: 'build-box', env: { PATH: process.env.PATH } };
  assert.equal((await core.promptSession('s1', 'hello', box)).sent, true);
  assert.deepEqual(calls.map(c => c.timeout), [30000, 30000],
    'the forwarded snapshot and prompt get the 30 s remote budget, not the 15 s local default (forwarding measured at 21–25 s)');
  calls.length = 0;
  assert.equal((await core.promptSession('s1', 'hello', { ...box, env: { ...box.env, OAK_HERDR_REMOTE_TIMEOUT_MS: '60000' } })).sent, true);
  assert.deepEqual(calls.map(c => c.timeout), [60000, 60000], 'the same knob as the terminal app lengthens it');
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
