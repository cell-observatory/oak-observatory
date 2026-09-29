const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../packages/core/dist');

test('test bootstrap isolates fixture discovery while preserving fixture repositories', t => {
  assert.match(path.basename(os.tmpdir()), /^oak-tests-/, 'load test/bootstrap.cjs before the suite');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  assert.equal(core.repoRoot(workspace), null, 'ancestor .git entries cannot turn the fixture into a repo');
  assert.equal(core.commonDir(workspace), null);
  fs.mkdirSync(path.join(workspace, '.git'));
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
