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

test('focus server stops once a store move takes its endpoint away, so the next terminal starts one where the store went', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-focus-move-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** One server over an in-memory transport, its endpoint `sock()`; returns what a test needs to drive it. */
  const start = (sock) => {
    let accept, closed = false;
    const server = new EventEmitter();
    server.listen = (_path, ready) => ready();
    server.close = () => { closed = true; };
    const timers = [];
    const module = { exports: {} };
    const fakeCore = { ...core, daemonPaths: () => ({ dir, sockDir: dir, sock: sock(), pid: path.join(dir, 'pid') }),
      readDaemonPid: () => null, reclaimStaleDaemon: () => false };
    const context = { exports: module.exports, module,
      require: name => name === 'net' ? { createServer: fn => { accept = fn; return server; } } : name === 'fs' ? { ...fs, chmodSync: () => {} } : require(name),
      process: { ...process, platform: 'linux', on() {}, stderr: { write() {} }, exit: code => { throw Error(`exit ${code}`); } },
      setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../dist/server.js'), 'utf8'), context);
    module.exports.runServer(fakeCore);
    const terminal = new Socket(); accept(terminal);
    terminal.receive({ op: 'hello', protocol: core.DAEMON_PROTOCOL });
    terminal.receive({ op: 'watch', id: 1 });
    return { terminal, closed: () => closed, check: () => timers.filter(timer => timer.ms === 2000).at(-1).fn() };
  };
  // The store's location names another endpoint (a move, or a new path too long for a socket).
  let at = path.join(dir, 'focus.sock');
  const one = start(() => at);
  one.check();
  assert.equal(one.closed(), false, 'control: a store that stayed keeps its server');
  at = path.join(dir, 'moved', 'focus.sock');
  one.check();
  assert.equal(one.closed(), true, 'a store that moved stops it');
  assert.deepEqual(one.terminal.messages.at(-1), { event: 'bye' }, 'and its terminal is told, so it reconnects');
  // The same path, but not the socket it bound: a copied store leaves the socket out. (Windows has no socket file,
  // and the server checks none there.)
  if (process.platform === 'win32') return;
  const file = path.join(dir, 'same.sock');
  const pidfile = path.join(dir, 'pid');
  fs.writeFileSync(file, '');
  const two = start(() => file);
  two.check();
  assert.equal(two.closed(), false, 'control: its own socket keeps it');
  // Keep the old inode allocated: unlink/recreate can reuse a regular file's inode on ext4.
  fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, 'x');
  // Meanwhile a server started where the store is now holds the pidfile too.
  fs.writeFileSync(pidfile, '424242');
  two.check();
  assert.equal(two.closed(), true, 'another file where its socket was stops it');
  // Stopping, it removes its own socket and pidfile only: removed by path, the new server's endpoint went with them, and
  // it ran on unreachable, its pidfile gone, so the next terminal started a second one.
  assert.equal(fs.readFileSync(file, 'utf8'), 'x', "the socket that replaced it is left to its server");
  assert.equal(fs.readFileSync(pidfile, 'utf8'), '424242', "and so is that server's pidfile");
  // Its socket gone, with nothing in its place (a move by copying leaves it out): it stops too.
  fs.writeFileSync(file, '');
  const three = start(() => file);
  three.check();
  assert.equal(three.closed(), false, 'control: its own socket keeps it');
  assert.equal(fs.readFileSync(pidfile, 'utf8'), String(process.pid), 'control: the pidfile is its own');
  fs.rmSync(file);
  three.check();
  assert.equal(three.closed(), true, 'a socket that is gone stops it');
  assert.equal(fs.existsSync(pidfile), false, 'and its own pidfile goes with it');
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
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; (() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* a child's late write: never skip the stop hooks after this one */ } })(); });
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

// A zombie (exited, its parent never collected it) still answers signal 0. On the Mac an old focus server whose parent
// app had not collected it read as one that "did not stop", so `oak doctor` reported a problem that was not there and a
// new server would not start over it (2026-11-05).
test('focus server: a zombie counts as stopped where the server is started, stopped and reported', { skip: process.platform === 'win32' && 'POSIX processes' }, async t => {
  const { spawn } = require('node:child_process');
  // The shell backgrounds a short process, then becomes `sleep`, which never collects it: a zombie for as long as it sleeps.
  const parent = spawn('/bin/sh', ['-c', 'sleep 0 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => parent.kill('SIGKILL'));
  const zombie = Number((await new Promise(resolve => parent.stdout.once('data', resolve))).toString().trim());
  for (let i = 0; i < 50; i++) {
    const r = require('node:child_process').spawnSync('ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' });
    if (/^\s*Z/.test(r.stdout)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(require('node:child_process').spawnSync('ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' }).stdout, /^\s*Z/, 'control: the child is a zombie');
  assert.equal(core.pidAlive(zombie), true, 'signal 0 alone still reaches it');
  assert.equal(core.pidAlive(zombie, { reaped: true }), false, 'a zombie is gone for the focus server');
  assert.equal(core.pidAlive(parent.pid, { reaped: true }), true, 'a running process is not');

  // The pidfile names the zombie and nothing listens: a stale pidfile, which stop and a new start both clear.
  const paths = core.daemonPaths();
  for (const dir of new Set([paths.dir, paths.sockDir])) fs.mkdirSync(dir, { recursive: true });
  const leftBehind = () => { fs.writeFileSync(paths.pid, String(zombie)); fs.writeFileSync(paths.sock, ''); };
  leftBehind();
  const status = await core.daemonStatus();
  assert.deepEqual([status.running, status.pid, status.stale], [false, zombie, true], 'status: a stale pidfile, not a server');
  assert.equal(core.reclaimStaleDaemon(), true, 'start: the zombie\'s pidfile and socket are reclaimed');
  assert.deepEqual([fs.existsSync(paths.pid), fs.existsSync(paths.sock)], [false, false]);
  leftBehind();
  assert.deepEqual(await core.stopDaemon(), { stopped: false, why: 'no oak server is running' });
  assert.equal(fs.existsSync(paths.pid), false, 'stop: the pidfile is reclaimed');

  // The server itself starts over a pidfile that names the zombie.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-focus-zombie-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transport = new EventEmitter();
  transport.listen = (_path, ready) => ready();
  transport.close = () => {};
  let reclaimed = false;
  const module = { exports: {} };
  const fakeCore = { ...core, daemonPaths: () => ({ dir, sockDir: dir, sock: path.join(dir, 'focus.sock'), pid: path.join(dir, 'pid') }),
    readDaemonPid: () => zombie, reclaimStaleDaemon: () => { reclaimed = true; return true; } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../dist/server.js'), 'utf8'), { exports: module.exports, module,
    require: name => name === 'net' ? { createServer: () => transport } : name === 'fs' ? { ...fs, chmodSync: () => {} } : require(name),
    process: { ...process, on() {}, stderr: { write() {} }, exit: code => { throw Error(`exit ${code}`); } },
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {} });
  module.exports.runServer(fakeCore);
  assert.equal(reclaimed, true, 'start: the server reclaims the zombie\'s pidfile instead of exiting "already running"');
  assert.equal(fs.readFileSync(path.join(dir, 'pid'), 'utf8'), String(process.pid));

  // A server that answers, then becomes a zombie once told to shut down: stop says it stopped, and does not wait it out.
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write(JSON.stringify({ event: 'hello', protocol: core.DAEMON_PROTOCOL, pid: zombie }) + '\n');
    socket.on('data', chunk => { if (String(chunk).includes('"shutdown"')) socket.destroy(); });
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.sock, resolve); }); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'EAFNOSUPPORT'].includes(error.code)) throw error;
    const reason = `SKIP FOCUS SOCKET: Unix socket binding unavailable (${error.code}); stop over a live connection not verified.`;
    console.error(reason); t.skip(reason); return;
  }
  const began = Date.now();
  assert.deepEqual(await core.stopDaemon(6000), { stopped: true, why: '' });
  assert.ok(Date.now() - began < 3000, `stop returns once the server is a zombie, not at its deadline (${Date.now() - began} ms)`);
});

// `/proc/<pid>/stat` is `pid (name) state …`, and the name may hold `) ` itself: read from the first `)`, a live process
// named `s) Z s` is a zombie, and a zombie named `z) S z` is alive.
test('focus server: a process name holding ") " does not decide whether it is a zombie', { skip: process.platform !== 'linux' && '/proc is Linux only' }, async t => {
  const { spawn, spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-zombie-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The shell under each name, not sleep: Rust coreutils' sleep (Ubuntu 26.04's) refuses to run under another name, so
  // neither process was there, and Node renames its main thread. The parent waits in `read` on a FIFO nobody writes to,
  // and reaps no child it did not start.
  for (const name of ['z) S z', 's) Z s']) fs.symlinkSync('/bin/sh', path.join(dir, name));
  const fifo = path.join(dir, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'control: a FIFO for the parent to wait on');
  const parent = spawn('/bin/sh', ['-c', '"$1" -c "" & echo $!; exec "$2" -c \'read x < "$1"\' "$2" "$3"', 'sh', path.join(dir, 'z) S z'), path.join(dir, 's) Z s'), fifo], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => parent.kill('SIGKILL'));
  const zombie = Number((await new Promise(resolve => parent.stdout.once('data', resolve))).toString().trim());
  const stat = pid => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return ''; } };
  // Until the parent sleeps, not only wears its new name: just after its exec it is still running (R), and a loaded
  // runner read it there.
  for (let i = 0; i < 250 && !(stat(zombie).startsWith(`${zombie} (z) S z) Z `) && stat(parent.pid).startsWith(`${parent.pid} (s) Z s) S `)); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(stat(zombie), /^\d+ \(z\) S z\) Z /, 'control: a zombie named "z) S z"');
  assert.match(stat(parent.pid), /^\d+ \(s\) Z s\) S /, 'control: a sleeping process named "s) Z s"');
  assert.equal(core.pidAlive(zombie, { reaped: true }), false, 'the zombie is gone');
  assert.equal(core.pidAlive(parent.pid, { reaped: true }), true, 'the sleeping process is alive');
});
