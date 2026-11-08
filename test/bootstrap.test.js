const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitDir: makeGitDir } = require('./fixtures/git.cjs');
const core = require('../packages/core/dist');

test('test bootstrap isolates fixture discovery while preserving fixture repositories', t => {
  assert.match(path.basename(os.tmpdir()), /^oak-tests-/, 'load test/bootstrap.cjs before the suite');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  assert.equal(core.repoRoot(workspace), null, 'ancestor .git entries cannot turn the fixture into a repo');
  assert.equal(core.commonDir(workspace), null);
  makeGitDir(path.join(workspace, '.git'));
  const nested = path.join(workspace, 'nested');
  fs.mkdirSync(nested);
  assert.equal(core.repoRoot(nested), workspace, 'fixture repository discovery still walks upward');
  assert.equal(core.commonDir(nested), path.join(workspace, '.git'));
});

// What `dir` lets the suite do: 'ok' when a test can create a directory in it and run a script it writes there,
// 'noexec' when the kernel refuses to run the script, 'unwritable' when nothing can be created.
function tmpState(dir) {
  let box;
  try { box = fs.mkdtempSync(path.join(dir, 'oak-probe-')); } catch { return 'unwritable'; }
  try {
    fs.writeFileSync(path.join(box, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    return cp.spawnSync(path.join(box, 'tool')).error?.code === 'EACCES' ? 'noexec' : 'ok';
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
}

test('test bootstrap: a long TMPDIR (a macOS runner\'s is 56 characters) still leaves room for the suite\'s deepest socket', { skip: process.platform === 'win32' ? 'Windows pipes have no path cap' : tmpState('/tmp') !== 'ok' && '/tmp is read-only or noexec here, so the root stays in TMPDIR' }, t => {
  const long = path.join(os.tmpdir(), 'long-tmpdir-' + 'x'.repeat(40));
  fs.mkdirSync(long);
  t.after(() => fs.rmSync(long, { recursive: true, force: true }));
  // A run's process loads the bootstrap under that TMPDIR, then goes as deep as the suite does: a test file's
  // root, a fixture, OAK's store, and the store's socket.
  const script = `const fs = require('fs'), net = require('net'), os = require('os'), path = require('path');
    const store = path.join(fs.mkdtempSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tests-')), 'oak-focus-live-')), 'claude-observatory');
    fs.mkdirSync(store);
    const server = net.createServer().on('error', (e) => console.log(e.code));
    server.listen(path.join(store, 'oak.sock'), () => { console.log('listening'); server.close(); });`;
  const r = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'bootstrap.cjs'), '-e', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: long } });
  assert.equal(r.stdout.trim(), 'listening', r.stderr);
});

test('test bootstrap: where /tmp is read-only or noexec, the run\'s root stays in TMPDIR, where the suite can run the scripts it writes', { skip: process.platform === 'win32' && 'the root is always in TMPDIR on Windows' }, async t => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpdir-'));
  t.after(() => fs.rmSync(tmpdir, { recursive: true, force: true }));
  // Loaded before the bootstrap: its directory in /tmp fails with EROFS, or goes on a real noexec mount instead.
  const fakeTmp = path.join(tmpdir, 'fake-tmp.cjs');
  fs.writeFileSync(fakeTmp, `const fs = require('fs'), path = require('path'), mkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...rest) {
  if (path.dirname(prefix) === '/tmp') {
    if (process.env.FAKE_TMP === 'read-only') throw Object.assign(new Error('EROFS: read-only file system, mkdtemp'), { code: 'EROFS' });
    prefix = path.join(process.env.FAKE_TMP, path.basename(prefix));
  }
  return mkdtempSync.call(this, prefix, ...rest);
};`);
  const script = `const fs = require('fs'), os = require('os'), path = require('path');
    const tool = path.join(os.tmpdir(), 'tool');
    fs.writeFileSync(tool, '#!/bin/sh\\necho ran\\n', { mode: 0o755 });
    console.log(path.dirname(os.tmpdir()), require('child_process').execFileSync(tool, { encoding: 'utf8' }).trim());`;
  // Debian and Ubuntu mount /run/lock as a writable noexec tmpfs, so it can stand in for a noexec /tmp.
  const noexec = tmpState('/run/lock') === 'noexec';
  for (const [name, fake, skip] of [['read-only /tmp', 'read-only', false], ['noexec /tmp', '/run/lock', !noexec && 'no writable noexec /run/lock here']]) {
    await t.test(name, { skip }, () => {
      const r = cp.spawnSync(process.execPath, ['--require', fakeTmp, '--require', path.join(__dirname, 'bootstrap.cjs'), '-e', script],
        { encoding: 'utf8', env: { ...process.env, TMPDIR: tmpdir, FAKE_TMP: fake } });
      assert.equal(r.stdout.trim(), `${tmpdir} ran`, r.stderr);
    });
  }
});

test('test bootstrap: OAK_NO_BACKGROUND stops every detached child OAK starts on its own, so none outlives a test and writes into the root the run is removing', async t => {
  assert.equal(process.env.OAK_NO_BACKGROUND, '1', 'test/bootstrap.cjs sets the switch for the whole run');
  const root = path.resolve(__dirname, '..');
  const cli = path.join(root, 'packages/cli/dist/index.js');
  // The recorder logs each launch and never starts a detached one, so the control run below starts nothing either.
  const recorder = path.join(root, 'packages/tui/test/fixtures/spawn-recorder.cjs');
  const pty = process.platform === 'win32' ? null : require('node-pty');
  // This build laid out as an install: a CLI run from this checkout starts no update check (`oak update`
  // leaves a checkout alone, so nothing nudges it there), so the check is started by a copy outside it, at a
  // version a release can carry (this tree's own may be a local build, dev.0, which nothing nudges either).
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-installed-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const f of ['package.json', 'dist', 'statusline']) fs.cpSync(path.join(root, 'packages/cli', f), path.join(copy, 'oak-observatory', f), { recursive: true });
  const manifest = path.join(copy, 'oak-observatory', 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '9.9.9-dev.3' }));
  const installed = path.join(copy, 'oak-observatory', 'dist', 'index.js');
  // Each entry point in a HOME of its own, where every kick is due: no caches, no claims, a statusline installed.
  const launches = async (entry, extraEnv, switchValue) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-background-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const log = path.join(home, 'spawns.jsonl');
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'),
      XDG_CONFIG_HOME: path.join(home, 'config'), OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: switchValue, ...extraEnv };
    for (const key of ['CLAUDE_OBSERVATORY_NO_UPDATE_CHECK', 'OAK_NO_SERVER', 'OAK_STATUSLINE']) delete env[key];
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'statusline.sh'), '#!/bin/sh\n');
    // The log is read while the run writes it, so a line still being written is left for the next read.
    const recorded = () => {
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line)) : [];
      // On Windows the launcher runs bash through cmd.exe, so the recorded file is the whole command line.
      return calls.filter((c) => c.detached).map((c) => (/^bash(?:\s|$)/.test(c.file) ? 'month refresh' : c.args.slice(1).join(' ')));
    };
    if (entry.pty) {
      // The update check needs a terminal on stderr, and the terminal app runs until it is stopped. Neither run is stopped
      // on a clock from its start: on a starved runner the app can take more than 3 s to come up, and a run stopped 3 s
      // after its start then records none of its kicks without the switch, and none under it only because nothing that
      // kicks has run yet. A verb runs until it exits. The app, which draws frames, has decided every kick by the end of
      // its first whole frame (the server's at startup, the rest in that first paint): under the switch it runs on for 3 s
      // past that frame, and without it until every kick expected of it is recorded, and never less than the 3 s from its
      // start it always had, so an extra kick in that time still shows.
      const started = Date.now();
      const child = pty.spawn(process.execPath, ['--require', recorder, entry.cli ?? cli, ...entry.args], { cols: 100, rows: 30, cwd: home, env });
      let output = '', drawnAt = 0, gone = false;
      child.onData((data) => {
        if (drawnAt) return;
        output += data;
        if (output.includes('\x1b[?2026l')) drawnAt = Date.now(); // the end of a whole frame
      });
      const exited = new Promise((resolve) => child.onExit(() => { gone = true; resolve(); }));
      const settled = () => gone || (drawnAt > 0 && (switchValue === '1' ? Date.now() - drawnAt >= 3000 : recorded().length >= entry.kicks.length && Date.now() - started >= 3000));
      for (const deadline = Date.now() + 60000; !settled() && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
      const ran = gone || drawnAt > 0;
      if (!gone) child.kill();
      await exited;
      assert.ok(ran, 'the run got as far as its kicks: it exited, or it drew a frame');
    } else {
      const r = cp.spawnSync(process.execPath, ['--require', recorder, ...entry.args], { cwd: home, env, encoding: 'utf8', timeout: 20000 });
      assert.equal(r.status, 0, r.stderr);
    }
    return recorded();
  };
  // The saved machines' usage refresh is kicked only where herdr is, since OAK's saved machines are herdr's.
  const machines = core.findHerdrBin({ env: { PATH: process.env.PATH } }) ? ['usage --pull-machines --if-due'] : [];
  const entries = [
    // …and the local index's catch-up of what `oak usage` itself does not read (the session it reports, this machine's usage).
    { name: 'oak usage', args: [cli, 'usage', '--json'], kicks: ['usage --pull-account --json', 'titles --refresh --if-due', 'month refresh', '__index-build', ...machines] },
    { name: 'a capture hook inside herdr', args: ['-e', "require(process.argv[1]).herdrPaneContextSync = () => ({ nested: true }); require(process.argv[2]).kickTabSync('s1', '/fixture/oak.js')", path.join(root, 'packages/core/dist/herdr-context'), path.join(root, 'packages/core/dist')],
      env: { HERDR_PANE_ID: 'p1' }, kicks: ['__tab-sync s1'] },
    { name: 'any verb in a terminal', args: ['sessions'], pty: true, cli: installed, kicks: ['__update-check'] },
    // On the Review tab: the herdr tab would start a real herdr, which writes its session under this HOME on the way out.
    { name: 'the terminal app', args: ['tui', '--tab', 'review'], pty: true, kicks: ['usage --pull-account --json', 'server --daemon', 'titles --refresh --if-due', 'month refresh', '__index-build', ...machines] },
  ];
  for (const entry of entries) {
    await t.test(entry.name, { skip: entry.pty && !pty && 'POSIX PTY' }, async () => {
      assert.deepEqual(await launches(entry, entry.env, '1'), [], 'no detached child under the switch');
      // Control: without the switch the same run launches every one of them, so the recorder sees what it guards.
      assert.deepEqual((await launches(entry, entry.env, '')).sort(), [...entry.kicks].sort());
    });
  }
});

test('test bootstrap: each test process runs under a HOME of its own, so a store resolved before a test makes its own is never the developer\'s (0.11.0)', (t) => {
  // Test files clear CLAUDE_CONFIG_DIR so their fixtures pick the store by HOME, and until a test made its own HOME the
  // store resolved under the one the run inherited: one test wrote its fixture sessions into a developer's real store.
  const inheritedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'inherited-home-'));
  t.after(() => fs.rmSync(inheritedHome, { recursive: true, force: true }));
  const script = `const os = require('os'), path = require('path');
    const { temporaryRoot } = require(${JSON.stringify(path.join(__dirname, 'bootstrap.cjs'))});
    delete process.env.CLAUDE_CONFIG_DIR; // as core.test.js and the VS Code smoke test do at load
    const store = require(${JSON.stringify(path.join(__dirname, '../packages/core/dist'))}).rootDir();
    const inside = (p) => { const rel = path.relative(temporaryRoot, p); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
    console.log(JSON.stringify({ home: inside(os.homedir()), profile: inside(process.env.USERPROFILE), store: inside(store), cache: inside(process.env.XDG_CACHE_HOME) }));`;
  // The developer's cache folder set too: the `oak` launcher keeps Node's compile cache there.
  const r = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'bootstrap.cjs'), '-e', script],
    { encoding: 'utf8', env: { ...process.env, HOME: inheritedHome, USERPROFILE: inheritedHome, XDG_CACHE_HOME: path.join(inheritedHome, '.cache') } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { home: true, profile: true, store: true, cache: true }, 'HOME, USERPROFILE, the store and the cache folder are all inside the run\'s own root');
});

test('test bootstrap: a test whose store resolves under the real home fails, whether it starts that way or ends so (0.11.0)', (t) => {
  // The positive control: deliberately leaky tests are caught. They only point the store there; nothing in them, nor in
  // the guard (which judges the folder before it reads any preferences), reads or writes under the real home.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaky-tests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const leak = 'process.env.HOME = process.env.USERPROFILE = require("os").userInfo().homedir; delete process.env.CLAUDE_CONFIG_DIR;';
  const fixtures = {
    'leaky-in-test.js': `const { test } = require('node:test');\ntest('points the store at the real home', () => { ${leak} });\n`,
    // A test that resolves the store before it makes its own home: it ends safe, so only the check before it sees it.
    'leaky-at-load.js': `const { test } = require('node:test'), fs = require('fs'), os = require('os'), path = require('path');\n${leak}\n`
      + `test('starts with the store at the real home', () => { process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'late-')); });\n`,
    'own-home.js': `const { test } = require('node:test'), fs = require('fs'), os = require('os'), path = require('path');\n`
      + `test('makes a home of its own', () => { process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'own-')); delete process.env.CLAUDE_CONFIG_DIR; });\n`,
  };
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // run as a test file of its own, reporting in text
  const run = (name, mode = []) => {
    fs.writeFileSync(path.join(dir, name), fixtures[name]);
    const r = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'bootstrap.cjs'), ...mode, path.join(dir, name)], { encoding: 'utf8', env });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  // Also where the runner runs the tests in its own process (--test-isolation=none, CONTRIBUTING's fallback where test
  // workers are refused): the guard, hooked only outside the runner, ran nowhere there, and both leaky files passed.
  const modes = [[]];
  if (cp.spawnSync(process.execPath, ['--test-isolation=none', '-e', '0']).status === 0) modes.push(['--test', '--test-isolation=none']);
  for (const mode of modes) {
    for (const name of ['leaky-in-test.js', 'leaky-at-load.js']) {
      const r = run(name, mode);
      assert.equal(r.status, 1, `${name} ${mode.join(' ')} fails: ${r.out}`);
      assert.match(r.out, /OAK's store resolves under the real home/, `${name} ${mode.join(' ')}: and the guard says why`);
    }
    const control = run('own-home.js', mode);
    assert.equal(control.status, 0, `control: a test with a home of its own passes ${mode.join(' ')}: ${control.out}`);
  }
});

test('test bootstrap: a live herdr run (OAK_LIVE_HERDR=1) still finds the herdr OAK installed in the real home, off PATH (0.11.0)', (t) => {
  // The HOME each test process is given hid `~/.local/bin/herdr`, the place findHerdrBin looks after PATH, so wherever
  // herdr was not on PATH as well the live tests skipped as "no herdr binary installed". Only the lookup runs here: the
  // child starts no herdr and opens no socket.
  const liveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'live-home-'));
  const noHerdr = fs.mkdtempSync(path.join(os.tmpdir(), 'no-herdr-'));
  t.after(() => { for (const dir of [liveHome, noHerdr]) fs.rmSync(dir, { recursive: true, force: true }); });
  const bin = core.herdrInstallPath(liveHome, process.platform);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, HOME: liveHome, USERPROFILE: liveHome, OAK_LIVE_HERDR: '1' };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH' || key === 'XDG_CONFIG_HOME') delete env[key];
  env.PATH = noHerdr;
  const find = `console.log(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '../packages/core/dist'))}).findHerdrBin()))`;
  const r = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'bootstrap.cjs'), '-e', find], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), bin, 'found where OAK installs it');
});
