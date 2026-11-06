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
  put(spec, "const home = '/home/user', id = '00000000-0000-4000-8000-00000000dead', codex = '0199a000-0000-7000-8000-0000000000d1';\n");
  assert.equal(run().status, 0, 'placeholders pass: a test may use /home/user and a UUID with a zero second group');
  for (const [rel, text, rule] of [
    [readme, 'installed under /home/somebody/.claude\n', 'home-path'],
    [stub, 'printf \'[{"label":"\x6eova"}]\'\n', 'machine-name'],
    [spec, `const id = '${['3f2b8c1e', '6d4a', '4f7b', '9c2e', '5a1d9e8b7f64'].join('-')}';\n`, 'real-session-id'],
    // Codex session ids are v7 UUIDs, and a v4-only rule let them through (2026-09-26).
    [spec, `const id = '${['0199a1b2', 'c3d4', '7e5f', '8a9b', '1c2d3e4f5a6b'].join('-')}';\n`, 'real-session-id'],
    // A real id with only its tail zeroed keeps the 8 hex every surface displays; any `0000` let it pass (2026-10-07).
    [spec, `const id = '${['3f2b8c1e', '6d4a', '4f7b', '9c2e', '000000000001'].join('-')}';\n`, 'real-session-id'],
    [spec, `const id = '${['0199a1b2', 'c3d4', '7e5f', '8a9b', '000000000002'].join('-')}';\n`, 'real-session-id'],
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
  const out = PNG.sync.read(capturePng('/fixture/browser', ['--headless', '--disable-extensions', '--window-size=400,200', 'file:///fixture/scene.html']));
  assert.deepEqual(shots, ['400,287'], 'the window opens taller by what the viewport loses');
  assert.deepEqual([out.width, out.height], [800, 400], 'and the image is the 400×200 page asked for, at 2x');
});

test('media capture runs Chrome in a home of its own, with no bus, display, desktop or host names, and a short TMPDIR', { skip: process.platform === 'win32' && 'POSIX TMPDIR' }, async t => {
  // Run as the reader, Chrome wrote to their ~/.pki, mimeapps.list and ~/.cache, asked KWallet and KLauncher
  // for the keyring on a KDE desktop (kwalletd can abort when it starts), and contacted Google (2026-10-07).
  const { capturePng, runChrome } = await import(pathToFileURL(path.join(scripts, 'chrome.mjs')).href + '?isolation');
  const { syncBuiltinESMExports } = require('node:module');
  // A long TMPDIR crashes Chrome: its socket path overflows.
  const long = path.join(temp(t), 'a-temporary-directory-name-long-enough-to-overflow-a-unix-socket-path');
  fs.mkdirSync(long);
  const desktop = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/home/user/.Xauthority', XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'x11', DESKTOP_SESSION: 'plasma', KDE_FULL_SESSION: 'true',
    KDE_SESSION_VERSION: '6' };
  const buses = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/run/dbus/system_bus_socket' };
  const saved = { ...process.env };
  Object.assign(process.env, desktop, buses, { TMPDIR: long });
  const runs = [];
  t.mock.method(cp, 'execFileSync', (file, args, opts) => {
    const home = opts.env.HOME;
    runs.push({ file, args, env: opts.env, existed: fs.existsSync(home) });
    if (args.some(a => a.startsWith('--screenshot='))) throw new Error('stop after the launch');
    return 'dom';
  });
  syncBuiltinESMExports();
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const dump = ['--headless', '--disable-extensions', '--dump-dom', 'file:///fixture/page.html'];
  const shot = ['--headless', '--disable-extensions', 'file:///fixture/page.html'];
  assert.equal(runChrome('/fixture/browser', dump, { encoding: 'utf8' }), 'dom');
  assert.throws(() => capturePng('/fixture/browser', shot), /Media capture failed/);
  assert.equal(runs.length, 2, 'both the direct launch and the capture went through the isolation');
  for (const [i, { file, args, env, existed }] of runs.entries()) {
    const home = env.HOME;
    assert.equal(file, '/fixture/browser');
    assert.ok(existed, 'the home existed while Chrome ran');
    assert.ok(!fs.existsSync(home), 'and is gone after it, a failed launch included');
    assert.ok(home.startsWith(`${path.sep}tmp${path.sep}oak-chrome-`) && home.length <= 60, `a home short enough for Chrome's socket: ${home}`);
    assert.deepEqual(args.slice(0, 6), ['--password-store=basic', '--use-mock-keychain', '--disable-background-networking', '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND', `--user-data-dir=${path.join(home, 'profile')}`], 'no keyring, background fetch or host name');
    const own = i === 0 ? dump : shot;
    assert.deepEqual(args.slice(6, 6 + own.length), own, 'the caller\'s own arguments follow, so a page that needs a host passes its own rules');
    assert.deepEqual([env.USERPROFILE, env.TMPDIR], [home, home]);
    for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) assert.ok(env[key].startsWith(home + path.sep), `${key} is inside the home`);
    for (const key of Object.keys(buses)) assert.equal(env[key], 'disabled:', `no ${key}`);
    for (const key of Object.keys(desktop)) assert.equal(env[key], undefined, `no ${key}`);
  }
  assert.notEqual(runs[0].env.HOME, runs[1].env.HOME, 'each launch has a home of its own');
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

test('a coloured terminal cell paints one row, never over the row below it', async t => {
  const { frameHtml } = await load('ansi-html.mjs');
  const { resolveChrome, runChrome } = await load('chrome.mjs');
  // Every page that shows a frame sets rows 1.15em tall: at 1em the tails of letters such as y and g hang
  // into the next row, under its coloured cells, and at 1.2em Menlo's │ no longer reaches the next row.
  const root = path.resolve(scripts, '..');
  for (const [rel, rule] of [['scripts/build-tui-shots.mjs', /font:16px\/1\.15 /], ['docs/_content/tui.html', /\.tuid-term pre\{[^}]*line-height:1\.15;/], ['docs/showcase.html', /\.tuid-term pre\{[^}]*line-height:1\.15;/]])
    assert.match(fs.readFileSync(path.join(root, rel), 'utf8'), rule, `${rel} renders TUI frames at line-height 1.15`);
  // At that height a │ joins the next row's only in a font that draws it taller than the row: DejaVu Sans Mono and Noto
  // Sans Mono do (1.19em and 1.23em), while a browser's monospace can be Ubuntu Mono (1.12em) or FreeMono (1.00em), whose
  // borders show gaps. The web font has no │, so each player names the two before monospace.
  for (const rel of ['docs/_content/tui.html', 'docs/showcase.html', 'scripts/build-tui-shots.mjs']) {
    const stack = /\.tuid-term pre\{[^}]*font-family:([^;]*);/.exec(fs.readFileSync(path.join(root, rel), 'utf8'))?.[1]
      ?? /font:16px\/1\.15 ([^;]*);/.exec(fs.readFileSync(path.join(root, rel), 'utf8'))?.[1] ?? '';
    const at = (name) => stack.search(new RegExp(`["']${name}["']`));
    assert.match(stack, /,\s*monospace\s*$/, `${rel}: the stack ends in monospace (${stack})`);
    for (const name of ['DejaVu Sans Mono', ...(rel.startsWith('docs/') ? ['Noto Sans Mono'] : [])])
      assert.ok(at(name) >= 0 && at(name) < stack.lastIndexOf('monospace'), `${rel}: ${name} comes before monospace (${stack})`);
  }
  // The docs page's .prose pre is a light code box; the frame must sit on the terminal's own background.
  assert.match(fs.readFileSync(path.join(root, 'docs/_content/tui.html'), 'utf8'), /\.tuid-term pre\{[^}]*background:none;/);
  // A coloured cell has no height of its own, so it is as tall as the row the page sets, and the published
  // frames carry the same cell.
  const cell = /<span style="background:[^;"]*;?([^"]*)">/.exec(frameHtml('\x1b[48;2;200;110;80m cell \x1b[0m'))[1];
  assert.match(cell, /^display:inline-block;vertical-align:top$/, `a coloured cell is not an inline-block on the top of its row: ${cell}`);
  assert.doesNotMatch(cell, /height/, `a coloured cell sets its own height: ${cell}`);
  const published = [...fs.readFileSync(path.join(root, 'docs/media/tui-frames.js'), 'utf8').matchAll(/background:[^;\\]*;([^\\]*)\\"/g)].map(m => m[1]);
  assert.ok(published.length > 0, 'the published frames have coloured cells');
  for (const rest of new Set(published))
    assert.ok(rest === cell || rest.startsWith(cell + ';'), `docs/media/tui-frames.js has a coloured cell the converter no longer writes (${rest}); rebuild it with scripts/build-tui-demo.mjs`);
  let chrome;
  try { chrome = resolveChrome(); } catch { return t.skip('no Chrome to lay out the frame'); }
  // Two rows of tab pills, as herdr's bar sits under OAK's, in any local monospace font: every one has
  // an ascent plus descent taller than 1em, which is what made an inline background overlap. Laid out at
  // the pages' line-height and at two others, since a cell follows whatever row the page sets.
  const bg = '\x1b[48;2;200;110;80m', off = '\x1b[0m';
  const rows = [`${bg} herdr ${off} observatory ${bg} review ${off}`, `spaces ${bg} btop ${off}${bg}  2  ${off}`, `${bg}row three${off}`];
  const lineHeights = [1, 1.15, 1.5];
  const dir = temp(t), page = path.join(dir, 'rows.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf8"><style>pre{margin:0;font:16px monospace}</style>${lineHeights.map(lh => `<pre style="line-height:${lh}">${frameHtml(rows.join('\n'))}</pre>`).join('')}
<script>document.body.dataset.cells = JSON.stringify([...document.querySelectorAll('pre')].map(pre => { const box = pre.getBoundingClientRect(), pitch = box.height / ${rows.length};
  return [...pre.querySelectorAll('span')].map(s => { const r = s.getBoundingClientRect(); return [(r.top - box.top) / pitch, r.height / pitch]; }); }));</script>`);
  // A home, profile and short TMPDIR of its own, removed afterwards, and no bus, desktop or host names (runChrome).
  // Extensions off: a system package can install one into every new profile, whose native host crashes
  // (KDE's Plasma Integration does).
  const dom = runChrome(chrome, ['--headless', '--disable-extensions', '--disable-gpu', '--no-sandbox', '--ozone-platform=headless', '--dump-dom', pathToFileURL(page).href],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
  const pages = JSON.parse(/data-cells="([^"]*)"/.exec(dom)[1].replace(/&quot;/g, '"'));
  assert.equal(pages.length, lineHeights.length);
  for (const [i, cells] of pages.entries()) {
    assert.equal(cells.length, 5);
    for (const [row, height] of cells) {
      assert.ok(Math.abs(row - Math.round(row)) < 0.01, `at line-height ${lineHeights[i]} a coloured cell starts at row ${row}, not on a row boundary`);
      assert.ok(Math.abs(height - 1) < 0.01, `at line-height ${lineHeights[i]} a coloured cell is ${height} rows tall, not one row`);
    }
  }
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
  const bar = '  F1 herdr   F2 observatory   F3 review';
  for (const frame of ['', `${bar}\nworkstation · not reachable`, `${bar}\nSelect a session`, `${bar}\nNo conversation events yet`])
    assert.throws(() => validateFrame(frame, { conversation: true }), /existing media was not replaced/);
  assert.throws(() => validateFrame(`${bar}\nOAK demo · mouse-first terminal · ↵ continue`, { herdr: true }), /onboarding/);
  // CURRENCY: a healthy frame of a product that no longer exists. Every published TUI shot showed the
  // retired `[+]` tab a day after it was removed, and every gate here passed.
  assert.throws(() => validateFrame('│ herdr │ observatory │ ○ review │ [+]\nworkstation\n↗ herdr\n> Demo conversation',
    { conversation: true }), /retired tab bar/);
  assert.throws(() => validateFrame('workstation\n↗ herdr\n> Demo conversation', { conversation: true }), /retired tab bar/);
  // …and the bar from before the tab keys: the names without F1 to F3.
  assert.throws(() => validateFrame('  herdr   observatory   review\nworkstation\n↗ herdr\n> Demo conversation', { conversation: true }), /retired tab bar/);
  // Retired keys: the published frames showed the ctrl+a leader and `i reply` after 0.11.0 moved them.
  assert.throws(() => validateFrame(`${bar}\nworkstation\n↑↓ · ↵ pin · i reply/esc leave`, { conversation: true }), /retired keys/);
  assert.throws(() => validateFrame(`${bar}\nOAK demo · disposable session\nctrl+b is herdr's prefix · ctrl+a n/p tabs`, { herdr: true }), /retired keys/);
  // An older key row: the published demo kept an Observatory with no W window and a Review with no e/E · W.
  assert.throws(() => validateFrame(`${bar}\nworkstation\n↗ herdr\n↑↓ · ←→ · ↵ pin · c reply/esc leave · t herdr · R/X · B archived · : · ?`,
    { conversation: true }), /older key row/);
  assert.throws(() => validateFrame(`${bar}\nF4-F7 window · Tab · ↑↓ · space fold · a/u/U · e · : · ?`, { review: true }), /older key row/);
  // Every row the app draws at the media widths passes, so a change to those rows fails here first.
  const { OBS_HINTS, KEY_HINTS } = require('../dist/frame');
  for (const row of OBS_HINTS.slice(0, 3)) assert.doesNotThrow(() => validateFrame(`${bar}\nworkstation\n↗ herdr\n${row}`, { conversation: true }), row);
  for (const row of KEY_HINTS.slice(0, 2)) assert.doesNotThrow(() => validateFrame(`${bar}\n${row}`, { review: true }), row);
  const current = `${bar}\nworkstation\n↗ herdr\n> Demo conversation\n${OBS_HINTS[1]}`;
  assert.equal(validateFrame(current, { conversation: true }), current);
  const scrolled = `${bar}\nworkstation\n> Demo conversation\n↑↓ · ↵ pin · c reply/esc leave · W window · t herdr · ?`;
  assert.equal(validateFrame(scrolled, { conversation: true }), scrolled, 'the c reply hint alone marks a pinned conversation');
});

test('the published terminal demo shows the current app, each caption over the frame its beat drew', async () => {
  const { validateFrame } = await load('tui-capture.mjs');
  const src = fs.readFileSync(path.resolve(scripts, '../docs/media/tui-frames.js'), 'utf8');
  const frames = JSON.parse(src.slice(src.indexOf('=') + 1).replace(/;\s*$/, ''))
    .map(({ cap, html }) => ({ cap, text: html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }));
  assert.ok(frames.length > 2);
  // The gate that guards the capture, run again on what was published: a stale file fails it.
  for (const f of frames) {
    f.herdr = f.text.includes('OAK demo · disposable session'); f.review = /^F4-F7 window/m.test(f.text);
    assert.doesNotThrow(() => validateFrame(f.text, { herdr: f.herdr, review: f.review, conversation: !f.herdr && !f.review }), f.cap);
  }
  // A beat logs its caption before it writes, so a frame taken at the log line is the beat before it
  // (build-tui-demo.mjs): "three background shells" over "No shells in this session".
  const shows = [
    [/^▸ prompt 1 /, /Add feature scaling and dataset validation/],
    [/^▸ plan /, /Tasks · [1-9]/],
    [/the sanity run FAILS/, /StatisticsError/],
    [/three background shells/, /Processes · [1-9]/],
    [/^▸ prompt 2 /, /Now the tests and the usage docs/],
    [/^▸ prompt 3 /, /Profile it and leave me the report/],
  ];
  // The first beat had no session to draw until it ran, so a frame taken ahead of its beat never shows it.
  assert.match(frames.find(f => !f.herdr && !f.review).cap, shows[0][0], 'the Observatory frames open on the first beat');
  for (const { cap, text } of frames)
    for (const [caption, effect] of shows) if (caption.test(cap)) assert.match(text, effect, `"${cap}" shows its own beat`);
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
      write(key) {
        keys.push(key);
        const pane = '  F1 herdr   F2 observatory   F3 review\r\nOAK demo · disposable session\r\n';
        emit('\x1b[2J\x1b[H' + (key === '\r' ? 'Integrations · optional setup' : pane + 'starting…'));
        if (key !== '\r') setTimeout(() => emit('\x1b[2J\x1b[H' + pane + 'ready'), 300);
      },
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
    assert.match(frame, /F1 herdr {3}F2 observatory/, 'the gate waits for the CURRENT bar, not a word the hint line used to carry');
    assert.doesNotMatch(frame, /starting…/, "and for OAK's first read, so the shot is not of an empty status line");
    assert.deepEqual(keys, ['\r', '\x1b']); assert.equal(killed, 1);
  } finally { await capture.stop(); }
  assert.equal(stopped, 1);
});

test('media workspaces remain repositories under valid git-marker discovery', t => {
  const core = require('../../core/dist');
  for (const name of ['build-tui-shots.mjs', 'build-tui-demo.mjs']) {
    const ws = path.join(temp(t), 'workspace');
    fs.mkdirSync(ws);
    const source = fs.readFileSync(path.join(scripts, name), 'utf8');
    const start = source.indexOf("fs.mkdirSync(path.join(ws, '.git')");
    const end = source.indexOf('process.env.HOME', start);
    require('node:vm').runInNewContext(source.slice(start, end), { fs, path, ws });
    assert.equal(core.repoRoot(ws), ws, name + ' must allow the demo to create its sibling session');
  }
});
