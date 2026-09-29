const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const scripts = path.resolve(__dirname, '../../../scripts');
const load = name => import(pathToFileURL(path.join(scripts, name)));
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-media-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function runNode(dir, argv, env = process.env) {
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr');
  const fds = [fs.openSync(out, 'w'), fs.openSync(err, 'w')];
  let result;
  try { result = cp.spawnSync(process.execPath, argv, { env, stdio: ['ignore', ...fds] }); }
  finally { fds.forEach(fd => fs.closeSync(fd)); }
  return { ...result, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(err, 'utf8') };
}
function executable(file, body = 'exit 0') { fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); }

test('media privacy rejects hostnames in nested docs, including the current build machine', t => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'docs/media'), { recursive: true });
  fs.copyFileSync(path.join(scripts, 'check-docs-privacy.mjs'), path.join(dir, 'scripts/check-docs-privacy.mjs'));
  const run = () => runNode(dir, [path.join(dir, 'scripts/check-docs-privacy.mjs')]);
  const file = path.join(dir, 'docs/media/frames.js');
  fs.writeFileSync(file, 'workstation fixture\n');
  assert.equal(run().status, 0);
  // Construct the explicitly prohibited legacy names without embedding private labels in fixtures.
  for (const hostname of [os.hostname(), '\x6eova', '\x6eebula']) {
    fs.writeFileSync(file, `window.frame=${JSON.stringify(hostname + ' · machine')}\n`);
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /docs[\\/]media[\\/]frames.js:1.*\[machine-name\]/); // the platform's separator
  }
});

test('media privacy scans the shipped READMEs, and tests for real machines and session ids', t => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.copyFileSync(path.join(scripts, 'check-docs-privacy.mjs'), path.join(dir, 'scripts/check-docs-privacy.mjs'));
  const run = () => runNode(dir, [path.join(dir, 'scripts/check-docs-privacy.mjs')]);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const readme = 'packages/cli/statusline/README.md', stub = 'test/fixtures/stub.sh', spec = 'packages/core/test/x.test.js';
  put(readme, 'installed under ~/.claude\n');
  put(stub, 'printf \'[{"label":"build-box"}]\'\n');
  put(spec, "const home = '/home/user', id = '00000000-0000-4000-8000-00000000dead';\n");
  assert.equal(run().status, 0, 'placeholders pass: a test may use /home/user and a zero-padded UUID');
  for (const [rel, text, rule] of [
    [readme, 'installed under /home/somebody/.claude\n', 'home-path'],
    [stub, 'printf \'[{"label":"\x6eova"}]\'\n', 'machine-name'],
    [spec, `const id = '${['3f2b8c1e', '6d4a', '4f7b', '9c2e', '5a1d9e8b7f64'].join('-')}';\n`, 'real-session-id'],
    // Codex session ids are v7 UUIDs, and a v4-only rule let them through (2026-09-26).
    [spec, `const id = '${['0199a1b2', 'c3d4', '7e5f', '8a9b', '1c2d3e4f5a6b'].join('-')}';\n`, 'real-session-id'],
    [readme, `codex resume ${['0199a1b2', 'c3d4', '7e5f', '8a9b', '1c2d3e4f5a6b'].join('-')}\n`, 'real-session-id'],
  ]) {
    const before = fs.readFileSync(path.join(dir, rel), 'utf8');
    put(rel, text);
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('/', '[\\\\/]')}:1 .*\\[${rule}\\]`));
    put(rel, before);
  }
});

test('Chrome resolves override and PATH fallbacks, and names CHROME_BIN when unavailable', async t => {
  const { resolveChrome } = await load('chrome.mjs');
  const dir = temp(t), chromium = path.join(dir, 'chromium'), chrome = path.join(dir, 'google-chrome'), override = path.join(dir, 'custom-browser');
  executable(chromium); executable(override);
  assert.equal(resolveChrome({ PATH: dir }), chromium);
  executable(chrome);
  assert.equal(resolveChrome({ PATH: dir }), chrome);
  assert.equal(resolveChrome({ PATH: dir, CHROME_BIN: override }), override);
  assert.throws(() => resolveChrome({ PATH: dir, CHROME_BIN: path.join(dir, 'missing') }), /CHROME_BIN/);
  const result = runNode(dir, [path.join(scripts, 'render-media.mjs'), 'feed'], { ...process.env, CHROME_BIN: path.join(dir, 'missing') });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /CHROME_BIN/);
});

test('media rejects successful browser exits with missing or empty PNG output', async t => {
  const { capturePng } = await load('chrome.mjs');
  const { syncBuiltinESMExports } = require('node:module');
  let empty = false;
  t.mock.method(cp, 'execFileSync', (_file, args) => {
    if (empty) fs.writeFileSync(args.find(arg => arg.startsWith('--screenshot=')).slice(13), '');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => capturePng('/fixture/browser', []), /Media capture failed/);
  empty = true;
  assert.throws(() => capturePng('/fixture/browser', []), /empty or invalid PNG/);
});

test('media capture opens the window taller by the headless viewport loss, then crops back to the size asked for', async t => {
  const { PNG } = require('pngjs');
  const { capturePng } = await import(pathToFileURL(path.join(scripts, 'chrome.mjs')).href + '?viewport');
  const { syncBuiltinESMExports } = require('node:module');
  const shots = [];
  t.mock.method(cp, 'execFileSync', (_file, args) => {
    const size = args.find(arg => arg.startsWith('--window-size=')).slice(14).split(',').map(Number);
    // Headless Chrome lays the page out 87 CSS px shorter than its window.
    if (args.includes('--dump-dom')) return `<html><head></head><body>${size[1] - 87}</body></html>`;
    shots.push(size.join(','));
    const png = new PNG({ width: size[0] * 2, height: size[1] * 2 });
    png.data.fill(255);
    fs.writeFileSync(args.find(arg => arg.startsWith('--screenshot=')).slice(13), PNG.sync.write(png));
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const out = PNG.sync.read(capturePng('/fixture/browser', ['--headless', '--window-size=400,200', 'file:///fixture/scene.html']));
  assert.deepEqual(shots, ['400,287'], 'the window opens taller by what the viewport loses');
  assert.deepEqual([out.width, out.height], [800, 400], 'and the image is the 400×200 page asked for, at 2x');
});

test('media capture gives the browser a short TMPDIR, since a long one crashes Chrome', { skip: process.platform === 'win32' && 'POSIX TMPDIR' }, async t => {
  const { capturePng } = await import(pathToFileURL(path.join(scripts, 'chrome.mjs')).href + '?tmpdir');
  const { syncBuiltinESMExports } = require('node:module');
  const long = path.join(temp(t), 'a-temporary-directory-name-long-enough-to-overflow-a-unix-socket-path');
  fs.mkdirSync(long);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = long;
  let env;
  t.mock.method(cp, 'execFileSync', (_file, _args, opts) => { env = opts.env; throw new Error('stop after the launch'); });
  syncBuiltinESMExports();
  t.after(() => { process.env.TMPDIR = saved; if (saved === undefined) delete process.env.TMPDIR; t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => capturePng('/fixture/browser', []), /Media capture failed/);
  assert.equal(env?.TMPDIR, '/tmp', `the browser ran with TMPDIR ${env?.TMPDIR}`);
});

test('media fits a scene to its window, and refuses one its capture may have cut off', async () => {
  const { PNG } = require('pngjs');
  const { fitToContent } = await load('chrome.mjs');
  const frame = (height, from, to) => {
    const png = new PNG({ width: 4, height });
    for (let y = 0; y < height; y++) for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4, lit = y >= from && y <= to;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = lit ? 60 : 0; png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  };
  assert.equal(PNG.sync.read(fitToContent(frame(100, 10, 49))).height, 60, 'the black below trims to the margin above');
  assert.throws(() => fitToContent(frame(100, 10, 99), 'cut'), /cut: .*raise its height/, 'a window at the bottom edge was cut');
  assert.throws(() => fitToContent(frame(100, 10, 95), 'tight'), /tight: .*raise its height/, 'less room below than above may have cut it');
});

test('bootstrap final health check executes oak doctor --fix', t => {
  const script = fs.readFileSync(path.join(scripts, 'bootstrap.sh'), 'utf8');
  const command = script.split('\n').find(line => /^oak doctor\b/.test(line));
  assert.ok(command);
  // The sh on PATH, not /bin/sh: on Windows bootstrap.sh runs from Git Bash, and there is no /bin there.
  const result = cp.spawnSync('sh', ['-c', 'oak() { printf "%s\\n" "$@"; }; ' + command], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return t.skip('no sh on PATH, so bootstrap.sh cannot run here either');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'doctor\n--fix\n');
});

test('capture rejects blank, unreachable, unpinned, onboarding and STALE frames', async () => {
  const { validateFrame } = await load('tui-capture.mjs');
  const bar = '  herdr   observatory   review';
  for (const frame of ['', `${bar}\nworkstation · not reachable`, `${bar}\nSelect a session`, `${bar}\nNo conversation events yet`])
    assert.throws(() => validateFrame(frame, { conversation: true }), /existing media was not replaced/);
  assert.throws(() => validateFrame(`${bar}\nOAK demo · mouse-first terminal · ↵ continue`, { herdr: true }), /onboarding/);
  // CURRENCY: a healthy frame of a product that no longer exists. Every published TUI shot showed the
  // retired `[+]` tab a day after it was removed, and every gate here passed.
  assert.throws(() => validateFrame('│ herdr │ observatory │ ○ review │ [+]\nworkstation\n↗ herdr\n> Demo conversation',
    { conversation: true }), /retired tab bar/);
  assert.throws(() => validateFrame('workstation\n↗ herdr\n> Demo conversation', { conversation: true }), /retired tab bar/);
  const current = `${bar}\nworkstation\n↗ herdr\n> Demo conversation`;
  assert.equal(validateFrame(current, { conversation: true }), current);
});

test('capture starts an isolated server, seeds identities, dismisses onboarding and cleans up', async t => {
  const { EventEmitter } = require('node:events');
  const { syncBuiltinESMExports } = require('node:module');
  const Module = require('node:module');
  const herdr = require('../../core/dist/herdr');
  const dir = temp(t), requests = [], commands = [], keys = [];
  let killed = 0, stopped = 0, nextPane = 0;
  const server = new EventEmitter(); server.kill = () => { stopped++; server.emit('close'); };
  t.mock.method(cp, 'spawn', (_bin, argv, options) => { assert.deepEqual(argv, ['server']); assert.equal(options.env.SHELL, '/bin/sh'); return server; });
  t.mock.method(cp, 'execFileSync', (_bin, argv) => { commands.push(argv); return Buffer.from(''); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(herdr, 'herdrSnapshot', async () => ({ protocol: 22 }));
  t.mock.method(herdr, 'herdrRequest', async (method, params) => { requests.push({ method, params }); return { root_pane: { pane_id: `demo-pane-${++nextPane}` }, workspace: { workspace_id: 'demo-workspace' } }; });
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function(name, ...rest) {
    if (name !== 'node-pty') return originalLoad.call(this, name, ...rest);
    let emit;
    return { spawn: () => ({
      onExit() {}, onData(fn) { emit = fn; fn('mouse-first terminal · ↵ continue'); },
      write(key) { keys.push(key); emit('\x1b[2J\x1b[H' + (key === '\r' ? 'Integrations · optional setup' : '  herdr   observatory   review\r\nOAK demo · disposable session')); },
      kill() { killed++; },
    }) };
  });
  const { startCaptureServer } = await load('tui-capture.mjs');
  const capture = await startCaptureServer('/fixture/herdr', dir, dir);
  try {
    capture.seed('demo-aabbccdd'); capture.seed('demo-aabbccdd');
    assert.equal(commands.length, 1, 'report each synthetic identity once');
    assert.ok(commands[0].includes('--agent-session-id'));
    assert.ok(commands[0].includes('demo-aabbccdd'));
    assert.equal(requests.filter(r => r.method === 'workspace.create').length, 1);
    assert.equal(requests.filter(r => r.method === 'tab.create').length, 1);
    assert.equal(requests.find(r => r.method === 'tab.create').params.workspace_id, 'demo-workspace');
    assert.equal(requests.filter(r => r.method === 'pane.send_text').length, 2);
    const frame = await capture.herdrFrame('/fixture/cli', 'demo-aabbccdd', 100, 30);
    assert.match(frame, /OAK demo/); assert.doesNotMatch(frame, /mouse-first/);
    assert.match(frame, /herdr {3}observatory/, 'the gate waits for the CURRENT bar, not a word the hint line used to carry');
    assert.deepEqual(keys, ['\r', '\x1b']); assert.equal(killed, 1);
  } finally { await capture.stop(); }
  assert.equal(stopped, 1);
});
