const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const core = require('../../core/dist');

class Socket extends EventEmitter {
  destroyed = false;
  messages = [];
  setEncoding() { return this; }
  write(line) { this.messages.push(JSON.parse(line)); return true; }
  end() { this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  receive(value) { this.emit('data', JSON.stringify(value) + '\n'); }
}

test('focus client: hello, request acknowledgement, rejection, and disconnect', async t => {
  const socket = new Socket();
  t.mock.method(net, 'connect', () => {
    queueMicrotask(() => socket.receive({ event: 'hello', protocol: core.DAEMON_PROTOCOL, pid: 1 }));
    return socket;
  });
  const client = await core.connectDaemon({ client: 'fixture', timeoutMs: 100 });
  assert.ok(client);
  assert.equal(socket.messages[0].op, 'hello');
  const focused = [];
  client.on(ev => { if (ev.event === 'focus') focused.push(ev); });
  const request = client.request({ op: 'focus', session: 'session-1', tab: 'review' });
  const sent = socket.messages.at(-1);
  socket.receive({ event: 'focus', session: sent.session, tab: sent.tab });
  socket.receive({ event: 'ok', re: sent.id });
  assert.equal((await request).event, 'ok');
  assert.deepEqual(focused, [{ event: 'focus', session: 'session-1', tab: 'review' }]);
  const refused = client.request({ op: 'focus', session: 'session-1', tab: 'review' });
  socket.receive({ event: 'error', re: socket.messages.at(-1).id, why: 'no reader' });
  await assert.rejects(refused, /no reader/);
  const pending = client.request({ op: 'watch' });
  socket.destroy();
  await assert.rejects(pending, /closed the connection/);
  assert.equal(client.alive, false);
});

test('focus client refuses obsolete protocol before sending operations', async t => {
  const socket = new Socket();
  t.mock.method(net, 'connect', () => {
    queueMicrotask(() => socket.receive({ event: 'hello', protocol: core.DAEMON_PROTOCOL - 1 }));
    return socket;
  });
  assert.equal(await core.connectDaemon({ client: 'fixture', timeoutMs: 100 }), null);
  assert.equal(socket.destroyed, true);
  assert.deepEqual(socket.messages, []);
});

test('focus server routes only validated focus requests to attached watchers', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-focus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let accept;
  const server = new EventEmitter();
  server.listen = (_path, ready) => ready(); // in-memory transport; no socket is bound
  server.close = () => {};
  const timers = new Set();
  const module = { exports: {} };
  const fakeCore = { ...core, daemonPaths: () => ({ dir, sockDir: dir, sock: path.join(dir, 'focus.sock'), pid: path.join(dir, 'pid') }),
    readDaemonPid: () => null, reclaimStaleDaemon: () => false };
  const context = { exports: module.exports, module,
    require: name => name === 'net' ? { createServer: fn => { accept = fn; return server; } }
      : name === 'fs' ? { ...fs, chmodSync: () => {} } : require(name),
    process: { ...process, on() {}, stderr: { write() {} }, exit: code => { throw Error(`exit ${code}`); } },
    setTimeout: fn => { const timer = { fn, unref() {} }; timers.add(timer); return timer; }, clearTimeout: timer => timers.delete(timer),
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../dist/server.js'), 'utf8'), context);
  module.exports.runServer(fakeCore);
  const sender = new Socket(); accept(sender);
  sender.receive({ op: 'hello', protocol: core.DAEMON_PROTOCOL });
  sender.receive({ op: 'focus', id: 1, session: 's', tab: 'review' });
  assert.match(sender.messages.at(-1).why, /no OAK terminal/);
  const watcher = new Socket(); accept(watcher);
  watcher.receive({ op: 'hello', protocol: core.DAEMON_PROTOCOL });
  watcher.receive({ op: 'watch', id: 2 });
  sender.receive({ op: 'focus', id: 3, session: '../bad', tab: 'review' });
  assert.equal(sender.messages.at(-1).event, 'error');
  sender.receive({ op: 'focus', id: 4, session: 's', tab: 'observatory' });
  assert.deepEqual(watcher.messages.at(-1), { event: 'focus', session: 's', tab: 'observatory' });
  assert.deepEqual(sender.messages.at(-1), { event: 'ok', re: 4 });
  sender.receive({ op: 'spawn', id: 5 });
  assert.match(sender.messages.at(-1).why, /unknown focus operation/);
  sender.receive({ op: 'focus', id: 6, session: 's', tab: 'invalid' });
  assert.equal(sender.messages.at(-1).event, 'error');
  watcher.destroy(); sender.destroy();
});

test('focus: a socket fallback directory that is a symbolic link is refused, never chmodded', { skip: process.platform === 'win32' && 'the ownership check is POSIX only' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-focus-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const victim = path.join(dir, 'victim');
  fs.mkdirSync(victim);
  const link = path.join(dir, 'oak-link');
  fs.symlinkSync(victim, link);
  const chmodded = [], logged = [];
  const module = { exports: {} };
  const server = new EventEmitter();
  server.listen = (_path, ready) => ready(); // in-memory: were the link accepted, nothing would bind or keep the test alive
  server.close = () => {};
  const fakeCore = { ...core, daemonPaths: () => ({ dir, sockDir: link, sock: path.join(link, 'focus.sock'), pid: path.join(dir, 'pid') }),
    readDaemonPid: () => null, reclaimStaleDaemon: () => false };
  const context = { exports: module.exports, module,
    require: name => name === 'fs' ? { ...fs, chmodSync: p => chmodded.push(p) } : name === 'net' ? { createServer: () => server } : require(name),
    process: { ...process, on() {}, stderr: { write: s => logged.push(s) }, exit: code => { throw Error(`exit ${code}`); } },
    setTimeout: () => ({ unref() {} }), clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../dist/server.js'), 'utf8'), context);
  assert.throws(() => module.exports.runServer(fakeCore), /exit 1/);
  assert.ok(chmodded.includes(dir), 'control: the store directory itself was checked and closed');
  assert.ok(!chmodded.includes(link), 'the link was not chmodded');
  assert.match(logged.join(''), /not a plain directory/);
});

test('focus: live socket round trip', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-focus-live-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const paths = core.daemonPaths(); fs.mkdirSync(paths.sockDir, { recursive: true });
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write(JSON.stringify({ event: 'hello', protocol: core.DAEMON_PROTOCOL, pid: process.pid }) + '\n');
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const op = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (op.op === 'focus') socket.write(JSON.stringify({ event: 'focus', session: op.session, tab: op.tab }) + '\n' + JSON.stringify({ event: 'ok', re: op.id }) + '\n');
      }
    });
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.sock, resolve); }); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'EAFNOSUPPORT'].includes(error.code)) throw error;
    const reason = `SKIP FOCUS SOCKET: Unix socket binding unavailable (${error.code}); no live transport verified.`;
    console.error(reason); t.skip(reason); return;
  }
  const client = await core.connectDaemon({ client: 'live-fixture' }); assert.ok(client); t.after(() => client.close());
  const seen = []; client.on(event => { if (event.event === 'focus') seen.push(event); });
  assert.equal((await client.request({ op: 'focus', session: 'native-session', tab: 'observatory' })).event, 'ok');
  assert.deepEqual(seen, [{ event: 'focus', session: 'native-session', tab: 'observatory' }]);
});
