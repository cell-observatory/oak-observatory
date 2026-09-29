const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const core = require('../../core/dist');
const { diagnoseNativeSpawn, ptyBuildFix } = require('../dist/native');

test('doctor forwarding: one fake herdr command per machine, slow/fast boundary and SSH target', async t => {
  let clock = 0;
  const calls = [];
  const machines = [8000, 8001, 1000].map((ms, i) => ({ id: `${i}`, label: `machine-${i}`, target: `user@host-${i}`, session: 'default', enabled: i !== 2, selected: false, ms }));
  t.mock.method(cp, 'execFile', (file, args, options, callback) => {
    calls.push(args);
    assert.equal(file, '/fake/herdr.exe');
    if (args[0] === 'machine') callback(null, JSON.stringify(machines), '');
    else {
      assert.deepEqual(args.slice(2), ['pane', 'list']);
      assert.equal(options.timeout, 30000);
      clock += machines.find(m => m.label === args[1]).ms;
      callback(null, 'pane table (plain text, not JSON)\n', '');
    }
  });
  const checks = await core.diagnoseHerdrForwarding({ binary: '/fake/herdr.exe', now: () => clock, env: {} });
  assert.deepEqual(checks.map(c => c.level), ['ok', 'warn', 'ok']);
  assert.match(checks[1].fix, /Host host-1.*ControlMaster auto.*ControlPersist 10m/);
  assert.equal(calls.length, 4);
  machines.length = 0; calls.length = 0;
  assert.deepEqual(await core.diagnoseHerdrForwarding({ binary: '/fake/herdr.exe' }), []);
  assert.deepEqual(calls, [['machine', 'list', '--json']]);
});

test('doctor forwarding: slow failed call remains a warning with multiplexing advice', async t => {
  let clock = 0;
  t.mock.method(cp, 'execFile', (_file, args, options, callback) => {
    if (args[0] === 'machine') return callback(null, JSON.stringify([{ id: '1', label: 'box', target: 'box', session: '', enabled: true, selected: false }]), '');
    assert.equal(options.timeout, 9000);
    clock = 9000;
    callback(Object.assign(new Error('timeout'), { killed: true }), '', '');
  });
  const [check] = await core.diagnoseHerdrForwarding({ binary: '/fake/herdr.exe', now: () => clock, env: { OAK_HERDR_REMOTE_TIMEOUT_MS: '9000' } });
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /timed out/);
  assert.match(check.fix, /ControlMaster auto/);
});

function focusFixture(t, hello) {
  let running = true;
  const messages = [];
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-doctor-focus-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, 424242);
    if (!running) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (signal === 'SIGTERM') running = false;
    return true;
  });
  t.mock.method(net, 'connect', () => {
    const socket = new EventEmitter();
    let closed = false;
    socket.destroy = socket.end = () => { if (!closed) { closed = true; socket.emit('close'); } };
    socket.write = line => {
      const op = JSON.parse(line); messages.push(op);
      if (op.op === 'shutdown') { running = false; queueMicrotask(() => socket.destroy()); }
    };
    queueMicrotask(() => running
      ? socket.emit('data', JSON.stringify({ event: 'hello', pid: 424242, generation: 'test', started: 1, ...hello }) + '\n')
      : socket.destroy());
    return socket;
  });
  return { messages };
}

for (const hello of [{ protocol: core.DAEMON_PROTOCOL - 1, build: 'old' }, { protocol: core.DAEMON_PROTOCOL, build: 'old' }]) {
  test(`doctor focus: reports and stops mismatched protocol/build ${hello.protocol}`, async t => {
    const fixture = focusFixture(t, hello);
    assert.equal((await core.diagnoseFocusServer()).level, 'warn');
    assert.deepEqual(fixture.messages, [], 'inspection does not send operations');
    const repaired = await core.diagnoseFocusServer(true);
    assert.equal(repaired.level, 'ok');
    assert.match(repaired.detail, /stopped outdated server/);
    assert.deepEqual(fixture.messages.map(m => m.op), ['hello', 'shutdown']);
    assert.equal(fixture.messages[0].protocol, hello.protocol);
  });
}

test('TUI focus startup replaces an old protocol before attaching', async t => {
  const fixture = focusFixture(t, { protocol: core.DAEMON_PROTOCOL - 1, build: 'old' });
  const result = await core.ensureDaemon({ client: 'tui-focus', repairOutdated: true, spawn: false });
  assert.equal(result.client, null);
  assert.deepEqual(fixture.messages.map(m => m.op), ['hello', 'shutdown']);
});

test('doctor focus: current server is left running', async t => {
  const fixture = focusFixture(t, { protocol: core.DAEMON_PROTOCOL, build: core.buildStamp() });
  assert.equal((await core.diagnoseFocusServer(true)).level, 'ok');
  assert.deepEqual(fixture.messages, []);
});

test('doctor PTY: helper copied as 0644 fails inspection, repair retries the spawn', { skip: process.platform === 'win32' && 'POSIX executable permissions' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-doctor-pty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relative = `prebuilds/${process.platform}-${process.arch}/spawn-helper`;
  const helper = path.join(dir, relative);
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  let original;
  try { original = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds/darwin-arm64'); fs.accessSync(original); }
  catch (error) { const reason = `SKIP PTY PREBUILD COPY: node-pty prebuild fixture unavailable (${error.code})`; console.error(reason); t.skip(reason); return; }
  fs.cpSync(original, path.dirname(helper), { recursive: true });
  fs.chmodSync(helper, 0o644);
  // The native boundary is fake, but the prebuild copy, permission failure and chmod are real.
  fs.writeFileSync(path.join(dir, 'index.js'), `
    const fs = require('fs');
    exports.calls = 0;
    exports.spawn = (command, args) => {
      exports.calls++;
      require('assert').equal(command, '/bin/echo');
      fs.accessSync(require('path').join(__dirname, ${JSON.stringify(relative)}), fs.constants.X_OK);
      return { onData() {}, onExit(fn) { queueMicrotask(() => fn({ exitCode: 0 })); }, kill() {} };
    };
  `);
  const inspection = await diagnoseNativeSpawn(false, { packageDir: dir });
  assert.equal(inspection.level, 'fail');
  assert.match(inspection.detail, /spawn-helper is not executable — run oak doctor --fix/);
  assert.equal(fs.statSync(helper).mode & 0o777, 0o644);
  const result = await diagnoseNativeSpawn(true, { packageDir: dir });
  assert.equal(result.level, 'ok');
  assert.match(result.detail, /repaired spawn-helper.*PTY echo check passed/);
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
  assert.equal(require(dir).calls, 3);
});

test('doctor PTY: an unbuilt node-pty is a warning that names the Linux toolchain, what is missing, and oak attach', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-doctor-pty-unbuilt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // What a blocked or failed native build leaves: the package is there, its binding is not.
  fs.writeFileSync(path.join(dir, 'index.js'), "throw new Error('Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64')");
  const check = await diagnoseNativeSpawn(false, { packageDir: dir });
  assert.equal(check.level, 'warn', 'only the herdr tab needs node-pty, so the doctor still passes');
  assert.match(check.detail, /Failed to load native module/);
  assert.equal(check.fix, ptyBuildFix());
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'python3'), '');
  const linux = ptyBuildFix('linux', { PATH: bin });
  assert.match(linux, /needs python3, make and a C\+\+ compiler \(g\+\+\); missing here: make, g\+\+\./);
  assert.match(linux, /oak update --cli-only --force/);
  assert.match(linux, /`oak attach` opens herdr without it/);
  fs.writeFileSync(path.join(bin, 'make'), '');
  fs.writeFileSync(path.join(bin, 'clang++'), '');
  assert.doesNotMatch(ptyBuildFix('linux', { PATH: bin, CXX: 'clang++' }), /missing here/, 'CXX names the compiler node-gyp calls');
  for (const platform of ['darwin', 'win32']) {
    const text = ptyBuildFix(platform, { PATH: bin });
    assert.match(text, /^Reinstall OAK .*oak attach/);
    assert.doesNotMatch(text, /python3|oak doctor --fix/, 'prebuilt platforms need no toolchain, and --fix repairs nothing on Windows');
  }
});

test('doctor PTY: npm skipping node-pty\'s build script is told apart from a missing compiler (2026-09-26)', async t => {
  // npm 12 blocks every install script it was not told to allow, with only a warning. The advice then
  // named the compiler toolchain, on machines that had all of it, and never the flag that fixes it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-doctor-pty-blocked-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['python3', 'make', 'g++']) fs.writeFileSync(path.join(bin, tool), '');
  // What a blocked script leaves: the package, and no build/ directory at all.
  const pkg = path.join(dir, 'node-pty');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"node-pty"}');
  const blocked = ptyBuildFix('linux', { PATH: bin }, pkg);
  assert.match(blocked, /^npm installed node-pty without running its build script/);
  // Reinstalling keeps the unbuilt package, and oak-observatory is not on the npm registry: the advice is
  // the rebuild that runs its script (it named `npm install -g … oak-observatory`).
  assert.match(blocked, /\. Build it with `npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false`\. Meanwhile `oak attach`/);
  assert.doesNotMatch(blocked, /npm install -g|npm i -g|oak-observatory|[Rr]einstall/);
  assert.doesNotMatch(blocked, /Install them|missing here/, 'the tools are all here, so nobody is sent to install them');
  // node-pty in a checkout (install.sh's `npm install`): rebuilt there, where the checkout's package.json
  // allows its script and npm 12 refuses --allow-scripts.
  const checkout = path.join(dir, 'checkout'), inCheckout = path.join(checkout, 'node_modules', 'node-pty');
  fs.mkdirSync(inCheckout, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), '{"workspaces":["packages/cli"]}');
  fs.writeFileSync(path.join(inCheckout, 'package.json'), '{"name":"node-pty"}');
  assert.match(ptyBuildFix('linux', { PATH: bin }, inCheckout), new RegExp(`Build it with \`npm rebuild node-pty --ignore-scripts=false\` in ${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Meanwhile`));
  // A build that ran and failed leaves build/ behind: not the blocked script, and still not the tools.
  fs.mkdirSync(path.join(pkg, 'build'));
  const failed = ptyBuildFix('linux', { PATH: bin }, pkg);
  assert.match(failed, /all of which are here/);
  assert.doesNotMatch(failed, /Install them/);
  // Blocked, with a tool missing as well: both are said.
  fs.rmSync(path.join(pkg, 'build'), { recursive: true });
  fs.rmSync(path.join(bin, 'make'));
  assert.match(ptyBuildFix('linux', { PATH: bin }, pkg), /without running its build script .*missing here: make\. Install them, then build it with `npm rebuild -g node-pty/);
  // The doctor row hands the installed package to the advice.
  fs.writeFileSync(path.join(pkg, 'index.js'), "throw new Error('Failed to load native module: pty.node')");
  const check = await diagnoseNativeSpawn(false, { packageDir: pkg });
  assert.equal(check.fix, ptyBuildFix(process.platform, process.env, pkg));
  if (process.platform === 'linux') assert.match(check.fix, /--allow-scripts=node-pty/);
});

test('doctor PTY: an `oak machine add` copy is not told to reinstall, and the cause is one line', async t => {
  // The copy `oak machine add` pushes has no node_modules, so node-pty cannot be there; a reinstall through
  // npm would only put a second OAK beside it. And a missing module's message carries Node's whole
  // `Require stack:`, which the detail repeated.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-doctor-pty-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const platform of ['linux', 'darwin']) {
    const text = ptyBuildFix(platform, { PATH: dir }, undefined, true);
    assert.equal(text, '`oak machine add` installs OAK without node-pty, so OAK\'s herdr tab has no terminal on this machine. `oak attach` opens herdr without it.');
  }
  assert.match(ptyBuildFix('linux', { PATH: dir }), /reinstall OAK/, 'control: an npm install without node-pty is still sent to reinstall');
  fs.writeFileSync(path.join(dir, 'index.js'), "throw new Error('Failed to load native module: pty.node\\nRequire stack:\\n- /fixture/cli.js')");
  const check = await diagnoseNativeSpawn(false, { packageDir: dir, bundle: true });
  assert.equal(check.detail, 'node-pty is not built, so OAK\'s herdr tab has no terminal here: Failed to load native module: pty.node');
});

test('doctor PTY: timeout kills the diagnostic child and reports failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-doctor-pty-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.js'), `exports.killed = false; exports.spawn = () => ({ onData() {}, onExit() {}, kill() { exports.killed = true; } });`);
  const check = await diagnoseNativeSpawn(false, { packageDir: dir, timeoutMs: 15 });
  assert.equal(check.level, 'fail');
  assert.match(check.detail, /timed out/);
  assert.equal(require(dir).killed, true);
});
