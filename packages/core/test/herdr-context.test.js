const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const paneServer = require('./fixtures/pane-context.cjs');
const core = require('../dist');
const CLI = path.resolve(__dirname, '../../cli/dist/index.js');
const POSIX = { skip: process.platform === 'win32' && 'POSIX process/tty fixture' };

async function context(t, scenario, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-pane-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = scenario === 'unreachable' ? { socketPath: path.join(dir, 'missing.sock'), calls: () => [] } : await paneServer(t, dir, scenario, options);
  const env = { ...process.env, HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: server.socketPath, HERDR_ENV: '1',
    HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), XDG_CONFIG_HOME: path.join(dir, 'config') };
  return { dir, server, env };
}

for (const scenario of ['valid', 'stale', 'foreign', 'wrong-tty', 'unreachable', 'timeout']) {
  test(`pane context: ${scenario} controls the rendered F1 tab`, POSIX, async t => {
    const b = await context(t, scenario);
    const result = cp.spawnSync(process.execPath, [CLI, 'tui', '--once', '--no-mouse', '--tab', 'observatory'], { env: b.env, cwd: b.dir, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const bar = result.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0];
    assert.equal(bar.includes('herdr'), scenario !== 'valid', bar);
    assert.doesNotMatch(result.stderr, /HERDR_PANE_ID|timed out|not running/);
    assert.equal(b.server.calls().filter(c => c.method === 'pane.process_info').length, scenario === 'unreachable' ? 0 : 1);
  });
  test(`pane context: ${scenario} gates capture links, reports and tab sync`, POSIX, async t => {
    const b = await context(t, scenario);
    const report = path.join(b.dir, 'reported');
    const binary = path.join(b.dir, 'herdr');
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s" "$*" > "$PANE_REPORT_LOG"\n', { mode: 0o755 });
    const result = cp.spawnSync(process.execPath, ['-e', `
      const core = require(${JSON.stringify(path.resolve(__dirname, '../dist'))});
      core.linkHerdrPane('fixture-session', 'codex', 'startup');
      core.kickTabSync('fixture-session', '/fixture/oak.js');
      core.reportHerdrSessionSync('fixture-session', 'codex', { paneId: process.env.HERDR_PANE_ID, socketPath: process.env.HERDR_SOCKET_PATH, at: 1 });
      process.stdout.write(JSON.stringify({ link: core.readHerdrPaneLink('fixture-session'), kicked: require('fs').existsSync(require('path').join(core.storeDir('fixture-session'), 'herdr-tab.kick')) }));
    `], { env: { ...b.env, HERDR_BIN_PATH: binary, PANE_REPORT_LOG: report, OAK_NO_BACKGROUND: '' }, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(!!value.link, scenario === 'valid', 'only an owned pane can become a prompt destination');
    assert.equal(value.kicked, scenario === 'valid', 'only an owned pane can start a tab sync');
    assert.equal(fs.existsSync(report), scenario === 'valid', 'an inherited pane cannot receive an identity report');
    assert.equal(b.server.calls().length, scenario === 'unreachable' ? 0 : 1, 'link, report and kick share one check');
  });
}

for (const scenario of ['valid', 'stale', 'foreign', 'unreachable']) test(`pane context: attach ${scenario} verifies nesting and strips stale markers`, { skip: process.platform === 'win32' }, async t => {
  const b = await context(t, scenario);
  const binary = path.join(b.dir, 'herdr'), marker = path.join(b.dir, 'attached');
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "api" ]; then echo \'{"tabs":[{"label":"oak","tab_id":"t1"}]}\'; elif [ "$#" = 0 ]; then printf "%s|%s" "$HERDR_PANE_ID" "$HERDR_ENV" > "$PANE_ATTACH_LOG"; fi\n', { mode: 0o755 });
  const r = cp.spawnSync(process.execPath, [CLI, 'attach'], { env: { ...b.env, PATH: b.dir + path.delimiter + process.env.PATH, PANE_ATTACH_LOG: marker }, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes('already inside herdr'), scenario === 'valid');
  assert.equal(fs.existsSync(marker), scenario !== 'valid');
  if (scenario !== 'valid') assert.equal(fs.readFileSync(marker, 'utf8'), '|');
  assert.equal(b.server.calls().filter(c => /send|prompt/.test(c.method)).length, 0);
  assert.equal(b.server.calls().length, scenario === 'unreachable' ? 0 : 1);
});

test('pane context: the default socket is verified and a changed socket cannot reuse a decision', POSIX, async t => {
  const b = await context(t, 'valid');
  const other = await paneServer(t, path.join(b.dir, 'config/herdr'), 'foreign');
  assert.equal((await core.herdrPaneContext(b.env)).nested, true);
  const env = { ...b.env }; delete env.HERDR_SOCKET_PATH;
  assert.equal(core.herdrSocketPath(env), other.socketPath);
  assert.equal((await core.herdrPaneContext(env)).nested, false);
  assert.equal(other.calls().length, 1);
});

for (const scenario of ['valid', 'stale', 'foreign', 'unreachable', 'timeout']) test(`pane context: ${scenario} is cached and doctor is quiet except for stale identity`, POSIX, async t => {
  const b = await context(t, scenario);
  const start = Date.now();
  const [first, second] = await Promise.all([core.herdrPaneContext(b.env), core.herdrPaneContext(b.env)]);
  assert.equal(first, second);
  assert.equal(first.nested, scenario === 'valid');
  assert.equal(core.herdrPaneContextSync(b.env), first, 'capture reuses the async decision');
  assert.equal(await core.herdrPaneContext(b.env), first);
  assert.ok(Date.now() - start < 1500, 'unreachable or hung server has a short, bounded wait');
  assert.equal(b.server.calls().length, scenario === 'unreachable' ? 0 : 1, 'one request for the life of this pane/socket context');
  const hints = await core.diagnoseHerdrPane(b.env);
  assert.equal(hints.length, ['stale', 'foreign'].includes(scenario) ? 1 : 0);
  if (hints.length) assert.equal(hints[0].detail, 'HERDR_PANE_ID names a pane this terminal is not in; started from a herdr pane?');
});

test('pane context: a process table that cannot be read in time decides nothing, and the next check decides', POSIX, async t => {
  // Under load `ps` can miss its budget. That is not evidence the terminal is outside the pane: it must not hide or
  // show F1 for good, mark the marker stale, or be cached for the process's life.
  const b = await context(t, 'valid');
  b.server.update({ pid: 777777, tty: '' }); // the pane's shell is an ancestor, so membership needs the process table
  const spawn = require('../dist/spawn');
  const real = spawn.spawnToolSync;
  let slow = true;
  t.mock.method(spawn, 'spawnToolSync', (bin, args, options) => bin !== 'ps' ? real(bin, args, options)
    : slow ? { status: null, error: Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '' }
      : { status: 0, stdout: `${process.pid} 777777 ?\n777777 1 ?\n` });
  const first = await core.herdrPaneContext(b.env);
  assert.deepEqual([first.nested, first.stale, first.unknown], [false, false, true], 'undecided: neither nested nor stale');
  assert.deepEqual(await core.diagnoseHerdrPane(b.env), [], 'no stale hint for an undecided check');
  slow = false;
  const second = await core.herdrPaneContext(b.env);
  assert.deepEqual([second.nested, second.stale], [true, false], 'the next check, with the table read, decides');
});
