const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCwd } = require('../dist/native.js');

// A native tab spawns its PTY child in the reviewed session's workspace root. That root is read from
// the transcript, so a session synced from ANOTHER machine names a directory that does not exist here
// — and node-pty's child chdir()s before exec, dying silently. The chooser must fall back to a
// directory that exists on this machine (2026-09-18: every herdr tab "exited" on a second machine).
test('spawnCwd: an existing directory is kept as-is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-spawncwd-'));
  try {
    assert.equal(spawnCwd(dir, '/fallback'), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnCwd: a root that does not exist on this machine falls back', () => {
  const missing = path.join(os.tmpdir(), `oak-spawncwd-missing-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(missing), false, 'precondition: the path really is absent');
  assert.equal(spawnCwd(missing, '/fallback'), '/fallback');
  assert.equal(spawnCwd(null, '/fallback'), '/fallback');
  assert.equal(spawnCwd(undefined, '/fallback'), '/fallback');
  assert.equal(spawnCwd('', '/fallback'), '/fallback');
});

test('spawnCwd: a plain file is not a cwd either', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-spawncwd-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, '');
  try {
    assert.equal(spawnCwd(file, '/fallback'), '/fallback');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnCwd: the default fallback is this process cwd', () => {
  assert.equal(spawnCwd(null), process.cwd());
});

test('native quiet output paints after real xterm asynchronous write completes', async t => {
  const Module = require('node:module');
  const filename = require.resolve('../dist/native.js');
  // Load a fresh native module so its lazy PTY lookup cannot reuse another test's binding.
  const fresh = new Module(filename, module);
  fresh.filename = filename; fresh.paths = module.paths;
  let emit;
  const load = fresh.require.bind(fresh);
  fresh.require = name => name === 'node-pty' ? {
    spawn: () => ({ pid: 123, onData(fn) { emit = fn; }, onExit() {}, kill() {}, resize() {} }),
  } : load(name);
  fresh._compile(fs.readFileSync(filename, 'utf8'), filename);
  const session = fresh.exports.spawnNative('fixture', [], 40, 3, os.tmpdir(), 'fixture');
  assert.ok(session); t.after(() => session.close());
  assert.ok(!session.grid(40, 3, 'none').join('\n').includes('quiet-marker'));
  let painted;
  const update = new Promise(resolve => session.onUpdate(() => { painted = session.grid(40, 3, 'none'); resolve(); }));
  emit('quiet-marker');
  await update;
  assert.match(painted.join('\n'), /quiet-marker/);
  assert.match(session.grid(40, 3, 'none').join('\n'), /quiet-marker/, 'a quiet screen must keep the applied chunk in its cache');
});

const { translateNativeMouse } = require('../dist/native-input');
const translate = (text, pending, top = 3, height = 24) => translateNativeMouse(Buffer.from(text), top, height, pending);
const routed = (result, target) => Buffer.concat(result.parts.filter(p => p.target === target).map(p => p.bytes)).toString();

test('native mouse: all press/release/wheel/drag/any-motion reports in a read are translated', () => {
  const result = translate('\x1b[<0;7;4M\x1b[<0;7;4m\x1b[<64;8;5M\x1b[<32;9;6M\x1b[<35;10;7M');
  assert.equal(routed(result, 'pty'), '\x1b[<0;7;1M\x1b[<0;7;1m\x1b[<64;8;2M\x1b[<32;9;3M\x1b[<35;10;4M');
  assert.equal(result.pending.length, 0);
});

// ESC held from one read, then an unrelated key in the next: the ESC is its own part (a key for the
// child) and the leader byte LEADS the next part, so the caller's `bytes[0] === 0x01` check still
// sees it. Glued, `\x1b\x01n` reached the child whole and ctrl+a n could not leave the tab.
test('native mouse: a held ESC is not glued to a following unrelated key', () => {
  const held = translate('\x1b').pending;
  assert.equal(held.toString(), '\x1b');
  const result = translate('\x01n', held);
  assert.deepEqual(result.parts.map(p => [p.target, p.bytes.toString('latin1')]), [['pty', '\x1b'], ['pty', '\x01n']]);
  assert.equal(result.pending.length, 0);
  // The same hold still completes a real report split after its ESC.
  const cont = translate('[<0;7;4M', translate('\x1b').pending);
  assert.equal(routed(cont, 'pty'), '\x1b[<0;7;1M');
  const cont2 = translate('<0;7;4M', translate('\x1b[').pending);
  assert.equal(routed(cont2, 'pty'), '\x1b[<0;7;1M');
  const cont3 = translate('4M', translate('\x1b[<0;7;').pending);
  assert.equal(routed(cont3, 'pty'), '\x1b[<0;7;1M');
});

test('native mouse: reports split at every byte boundary retain the same routing', () => {
  const input = '\x1b[<35;11;12M\x1b[<0;11;12m';
  for (let split = 1; split < input.length; split++) {
    const first = translate(input.slice(0, split));
    const second = translate(input.slice(split), first.pending);
    assert.equal(routed(first, 'pty') + routed(second, 'pty'), '\x1b[<35;11;9M\x1b[<0;11;9m', `split ${split}`);
    assert.equal(second.pending.length, 0);
  }
});

test('native mouse: top rows go only to chrome; status and usage rows never go to the child', () => {
  const result = translate(Array.from({ length: 31 }, (_, row) => `\x1b[<0;5;${row}M`).join(''));
  assert.equal(routed(result, 'chrome'), '\x1b[<0;5;1M\x1b[<0;5;2M\x1b[<0;5;3M');
  assert.equal(routed(result, 'pty'), Array.from({ length: 24 }, (_, row) => `\x1b[<0;5;${row + 1}M`).join(''));
  assert.equal(routed(translate('\x1b[<0;5;1M', undefined, 0, 24), 'pty'), '\x1b[<0;5;1M');
});

test('native mouse: raw keyboard, arrows, paste and split UTF-8 remain byte-for-byte intact', () => {
  const input = Buffer.from('\x02??+\x1b[A\x1b[200~hello λ\x1b[201~');
  for (let split = 1; split < input.length; split++) {
    const first = translateNativeMouse(input.subarray(0, split), 3, 24);
    const second = translateNativeMouse(input.subarray(split), 3, 24, first.pending);
    assert.deepEqual(Buffer.concat([...first.parts, ...second.parts].map(p => p.bytes)), input);
  }
});

test('native mouse: mixed top/body reports retain their order and buffer only the unfinished tail', () => {
  const first = translate('?\x1b[<0;5;8M\x1b[<0;2;2M\x1b[<35;');
  assert.deepEqual(first.parts.map(p => [p.target, p.bytes.toString()]), [
    ['pty', '?'], ['pty', '\x1b[<0;5;5M'], ['chrome', '\x1b[<0;2;2M'],
  ]);
  assert.equal(first.pending.toString(), '\x1b[<35;');
  assert.equal(routed(translate('10;10M', first.pending), 'pty'), '\x1b[<35;10;7M');
});

test('outer tabs: herdr padding, fixed labels, full active block and no plus', async t => {
  const tui = require('../dist');
  const { fixture } = require('./fixtures/observatory');
  const state = fixture(); state.activeTab = 0; state.panes = state.tabs[0].panes;
  const opts = { cols: 120, rows: 36, color: 'none' };
  const bar = tui.renderDashFrame(state, opts).slice(0, 1).map(line => line.trimEnd()).join('\n');
  assert.equal(bar + '\n', fs.readFileSync(path.join(__dirname, 'fixtures/outer-tabs.txt'), 'utf8'));
  const labels = state.tabs.map((tab, i) => tui.tabLabel(tab, i, tui.glyphs('safe')));
  const layout = tui.resolveLayout({ ...opts, minimized: new Set(), zoom: null, focus: 'traces', tabs: labels, activeTab: 0 });
  for (const [i, span] of layout.tabbar.entries()) {
    assert.equal(span.w, Math.max(8, tui.displayWidth(labels[i]) + 4));
    if (i) assert.equal(span.x, layout.tabbar[i - 1].x + layout.tabbar[i - 1].w + 1);
    for (const col of [span.x, span.x + span.w - 1]) assert.deepEqual(tui.hitTest(layout, col, 0), { t: 'tabbar', index: i });
  }
  for (let cols = 40; cols <= 160; cols++) for (let activeTab = 0; activeTab < 3; activeTab++) {
    const narrow = tui.resolveLayout({ ...opts, cols, minimized: new Set(), zoom: null, focus: 'traces', tabs: labels, activeTab });
    const post = narrow.tabbarMore.post;
    if (post) assert.ok(post.x + post.w <= cols - tui.WORKERS_ROLLUP_W, `overflow marker fits at ${cols} columns`);
  }
  const { Terminal } = require('@xterm/headless');
  for (const color of ['truecolor', '256', '16']) {
    const term = new Terminal({ cols: 120, rows: 36, allowProposedApi: true });
    t.after(() => term.dispose());
    const frame = tui.renderDashFrame(state, { ...opts, color });
    await new Promise(resolve => term.write(frame.slice(0, 1).join('\r\n'), resolve));
    const row = term.buffer.active.getLine(0);
    for (const span of layout.tabbar) for (let col = span.x; col < span.x + span.w; col++) {
      assert.equal(!!row.getCell(col).isInverse(), span.selected, `${color} active cell ${col}`);
    }
  }
});

// The instrument must not lie about the product. A CRASH of the CLI under test used to land inside
// the probe's widest wait and come back as "no saved machine or workspace" — a skip, exit 0, and the
// blame on the environment. Run the real probe against a CLI stand-in that paints a sidebar and then
// dies, in a scratch tree so nothing built here is touched: it must FAIL.
test('built CLI PTY: a CLI that dies mid-probe fails, it does not skip', { timeout: 30000 }, async t => {
  let pty;
  try { pty = require('node-pty'); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return t.skip('node-pty is unavailable'); throw error; }
  assert.ok(pty);
  if (process.platform === 'win32') return t.skip('the executable herdr fixture requires a POSIX shebang');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-pty-guard-'));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  const here = path.resolve(__dirname, 'fixtures');
  fs.mkdirSync(path.join(tree, 'packages/tui/test/fixtures'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'packages/cli/dist'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'packages/core'), { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, '../../../node_modules'), path.join(tree, 'node_modules'));
  fs.symlinkSync(path.resolve(__dirname, '../../core/dist'), path.join(tree, 'packages/core/dist'));
  for (const name of ['herdr-pty-probe.cjs', 'herdr-terminal.cjs'])
    fs.copyFileSync(path.join(here, name), path.join(tree, 'packages/tui/test/fixtures', name));
  // Enough of a herdr tab to pass every wait before the one under test: the keyboard push, a sidebar
  // whose only row is `local` (which is never a click target), and the fixture's super+w receipt.
  fs.writeFileSync(path.join(tree, 'packages/cli/dist/index.js'),
    "process.stdout.write('\\x1b[>1u\\x1b[2J\\x1b[H');\n" +
    "process.stdout.write('\\r\\n\\r\\n\\r\\n  ▸ local\\r\\nsuper+w reached herdr fixture verbatim\\r\\n');\n" +
    'setTimeout(() => process.exit(3), 1500);\n');
  const probe = require(path.join(tree, 'packages/tui/test/fixtures/herdr-pty-probe.cjs'));
  const skips = [], afters = [];
  const inner = { skip: why => skips.push(why), diagnostic() {}, after: fn => afters.push(fn) };
  try {
    await assert.rejects(() => probe(inner, true), /CLI exited while waiting for/,
      'a dead CLI under test must fail the probe, never skip it');
  } finally { for (const fn of afters) await fn(); }
  assert.deepEqual(skips, [], 'nothing about a crash is a missing prerequisite');
});

test('built CLI PTY: translated sidebar click and independent herdr/OAK keys (fixture)', { timeout: 25000 }, t => require('./fixtures/herdr-pty-probe.cjs')(t, true));
// Opt-in: this attaches a herdr CLIENT to the machine's live server and presses keys in it, which
// resizes and pokes whatever a person has open there. Never part of an unattended gate run.
test('LIVE built CLI PTY: saved machine/workspace click and independent herdr/OAK prefixes',
  { timeout: 60000, skip: process.env.OAK_LIVE_HERDR !== '1' && 'set OAK_LIVE_HERDR=1 to exercise the live herdr server' },
  t => require('./fixtures/herdr-pty-probe.cjs')(t));

require('./native-keyboard.cjs');

test('native: an overlay value of undefined REMOVES the variable; other overlays and the env ride along (2026-09-23)', t => {
  const Module = require('node:module');
  const filename = require.resolve('../dist/native.js');
  const fresh = new Module(filename, module);
  fresh.filename = filename; fresh.paths = module.paths;
  let seen;
  const load = fresh.require.bind(fresh);
  fresh.require = name => name === 'node-pty' ? {
    spawn: (_c, _a, o) => { seen = o.env; return { pid: 1, onData() {}, onExit() {}, kill() {}, resize() {}, write() {} }; },
  } : load(name);
  fresh._compile(fs.readFileSync(filename, 'utf8'), filename);
  process.env.OAK_T_IDENTITY = '1'; t.after(() => { delete process.env.OAK_T_IDENTITY; });
  const s = fresh.exports.spawnNative('fixture', [], 20, 2, os.tmpdir(), 'fixture', { OAK_T_IDENTITY: undefined, OAK_TAB: 'herdr@1' });
  assert.ok(s); t.after(() => s.close());
  // node-pty would otherwise export the string "undefined" for a spread-in undefined.
  assert.equal(Object.prototype.hasOwnProperty.call(seen, 'OAK_T_IDENTITY'), false, 'removed, not set to "undefined"');
  assert.equal(seen.OAK_TAB, 'herdr@1');
  assert.equal(seen.PATH, process.env.PATH);
  assert.ok(Object.values(seen).every(v => typeof v === 'string'), 'node-pty gets strings only');
});

test('native (real PTY): the child cannot see a removed variable', { skip: process.platform === 'win32' }, async t => {
  const { spawnNative, nativeAvailable } = require('../dist/native.js');
  process.env.OAK_T_IDENTITY = '1'; t.after(() => { delete process.env.OAK_T_IDENTITY; });
  const s = spawnNative('/bin/sh', ['-c', 'printf "[%s]" "${OAK_T_IDENTITY-unset}"; sleep 1'], 30, 2, os.tmpdir(), 'sh', { OAK_T_IDENTITY: undefined });
  // A node-pty that loads but cannot spawn also returns null: the macOS 0644 spawn-helper passed here as
  // a skip on the first macOS CI run (2026-09-27). Only a node-pty that is not here at all is a skip.
  if (!s) { assert.equal(nativeAvailable(), false, 'node-pty loaded, but could not spawn /bin/sh'); return t.skip('node-pty unavailable'); }
  t.after(() => s.close());
  const deadline = Date.now() + 5000;
  let text = '';
  while (Date.now() < deadline && !/\[[^\]]*\]/.test(text)) { await new Promise(r => setTimeout(r, 25)); text = s.grid(30, 2, 'none').join('\n'); }
  assert.match(text, /\[unset\]/);
});

// A passthrough program's text attributes and cursor survive the serializer (2026-09-23: inside
// OAK's herdr tab a status bar drawn with underlines came through plain, and Claude Code's prompt,
// whose caret is the terminal cursor, showed no cursor at all).
test('native: underline, inverse, italic and strikethrough survive the grid; the cursor is reported with its visibility', async t => {
  const Module = require('node:module');
  const filename = require.resolve('../dist/native.js');
  const fresh = new Module(filename, module);
  fresh.filename = filename; fresh.paths = module.paths;
  let emit;
  const load = fresh.require.bind(fresh);
  fresh.require = name => name === 'node-pty' ? { spawn: () => ({ pid: 123, onData(fn) { emit = fn; }, onExit() {}, kill() {}, resize() {} }) } : load(name);
  fresh._compile(fs.readFileSync(filename, 'utf8'), filename);
  const s = fresh.exports.spawnNative('fixture', [], 40, 3, os.tmpdir(), 'fixture');
  assert.ok(s); t.after(() => s.close());
  const settle = () => new Promise(resolve => { s.onUpdate(resolve); });
  const p = settle(); emit('\x1b[4mUL\x1b[0m \x1b[7mIV\x1b[0m \x1b[3mIT\x1b[0m \x1b[9mST\x1b[0m end'); await p;
  const styled = s.grid(40, 3, 'truecolor')[0];
  const sgrBefore = (word) => { const i = styled.indexOf(word); return styled.slice(Math.max(0, i - 12), i); };
  assert.match(sgrBefore('UL'), /\x1b\[[0-9;]*\b4[m;]/, 'underline is emitted as SGR 4');
  assert.match(sgrBefore('IV'), /\x1b\[[0-9;]*\b7[m;]/, 'inverse is emitted as SGR 7');
  assert.match(sgrBefore('IT'), /\x1b\[[0-9;]*\b3[m;]/, 'italic is emitted as SGR 3');
  assert.match(sgrBefore('ST'), /\x1b\[[0-9;]*\b9[m;]/, 'strikethrough is emitted as SGR 9');
  assert.doesNotMatch(s.grid(40, 3, 'none')[0], /\x1b/, 'a colourless depth stays plain text');
  // The cursor: where the program left it, and whether the program is showing it.
  assert.deepEqual(s.cursor(), { x: 15, y: 0, visible: true }, 'after "UL IV IT ST end" the cursor sits past the text, shown');
  const hid = settle(); emit('\x1b[?25l'); await hid;
  assert.equal(s.cursor().visible, false, 'DECTCEM off hides it');
  const shown = settle(); emit('\x1b[?25h\x1b[2;4H'); await shown;
  assert.deepEqual(s.cursor(), { x: 3, y: 1, visible: true }, 'shown again, at the program\'s new position');
});

// END TO END: the built CLI's herdr tab runs a fake `herdr` that draws an underlined word and parks a
// visible cursor; OAK's own output must carry the underline and place the terminal cursor there.
test('built CLI herdr tab: a program\'s underline and cursor reach the outer terminal', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const pty = require('node-pty');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-native-attrs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'herdr'), `#!${process.execPath}\n` + [
    "if (process.argv.length > 2) { process.stdout.write('[]\\n'); process.exit(0); }",
    "process.stdout.write('\\x1b[2J\\x1b[H' + 'plain \\x1b[4mUNDERLINED\\x1b[0m word' + '\\x1b[3;6H' + '\\x1b[?25h');",
    'setInterval(() => {}, 1000);',
  ].join('\n') + '\n', { mode: 0o755 });
  const env = { ...process.env, TERM: 'xterm-256color', HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', TMUX: '',
    HERDR_SOCKET_PATH: path.join(dir, 'absent.sock'), PATH: dir + path.delimiter + process.env.PATH };
  for (const k of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'NO_COLOR']) delete env[k];
  env.FORCE_COLOR = '3';
  const cli = path.resolve(__dirname, '../../cli/dist/index.js');
  const child = pty.spawn(process.execPath, [cli, 'tui', '--tab', 'herdr', '--no-mouse'], { cols: 100, rows: 24, name: 'xterm-256color', cwd: dir, env });
  t.after(() => { try { child.kill(); } catch {} });
  let raw = '';
  child.onData(d => { raw += d; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !/UNDERLINED/.test(raw)) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 1500)); // a couple of repaints after the program painted
  const i = raw.lastIndexOf('UNDERLINED');
  assert.ok(i > 0, `the program's screen reached OAK's frame\n${raw.slice(-400)}`);
  assert.match(raw.slice(Math.max(0, i - 40), i), /\x1b\[[0-9;]*\b4[m;]/, 'the underline is emitted by OAK for the outer terminal');
  // The last frame ends with the cursor placed at the program's cursor (row 3 col 6 of the pane = one
  // tab-bar row lower on screen) and SHOWN, before the frame is committed.
  const lastFrame = raw.slice(raw.lastIndexOf('\x1b[?2026h'));
  assert.match(lastFrame, /\x1b\[4;6H\x1b\[\?25h\x1b\[\?2026l/, `the real cursor lands on the program's cursor and is shown:\n${JSON.stringify(lastFrame.slice(-120))}`);
});

// END TO END: a drag across the built CLI's Observatory, in a real PTY (copying there
// works the same way it does in the herdr tab). The band shows while dragging and
// clears on the release, and the copy is the OSC 52 escape on the terminal OAK itself runs in, written
// between frames, so a remote machine's pane copies to the clipboard of the machine OAK runs on.
test('built CLI Observatory: a drag copies through OSC 52 on the terminal OAK runs in', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-obs-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, TERM: 'xterm-256color', HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1',
    HERDR_SOCKET_PATH: path.join(dir, 'absent.sock'), OAK_MACHINE_LABEL: 'fixture-box' };
  // TMUX too: inside tmux the copy goes through `tmux load-buffer`, not the escape this reads.
  for (const k of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'TMUX']) delete env[k];
  const cols = 120, rows = 32, term = new Terminal({ cols, rows, allowProposedApi: true });
  const cli = path.resolve(__dirname, '../../cli/dist/index.js');
  const child = pty.spawn(process.execPath, [cli, 'tui', '--tab', 'observatory', '--no-server'], { cols, rows, name: 'xterm-256color', cwd: dir, env });
  t.after(() => { try { child.kill(); } catch {} });
  let raw = '';
  child.onData(d => { raw += d; term.write(d); });
  const settle = ms => new Promise(r => term.write('', () => setTimeout(r, ms)));
  const line = y => term.buffer.active.getLine(term.buffer.active.baseY + y);
  const find = text => { for (let y = 0; y < rows; y++) { const x = line(y)?.translateToString(true).indexOf(text) ?? -1; if (x >= 0) return { x, y }; } return null; };
  const band = (y, x0, x1) => { let s = ''; for (let x = x0; x <= x1; x++) { const c = line(y).getCell(x); s += c.isInverse() || c.isBgRGB() ? 'X' : '.'; } return s; };
  const mouse = (b, x, y, up = false) => child.write(`\x1b[<${b};${x + 1};${y + 1}${up ? 'm' : 'M'}`);
  const copied = s => [...s.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));
  const deadline = Date.now() + 15000;
  let at = null;
  while (Date.now() < deadline && !(at = find('fixture-box'))) await settle(100);
  assert.ok(at, `the Observatory painted its machine\n${raw.slice(-400)}`);
  const end = at.x + 'fixture-box'.length - 1;
  mouse(0, at.x, at.y); await settle(150);
  mouse(32, end, at.y); await settle(300);
  assert.equal(band(at.y, at.x - 1, end + 1), `.${'X'.repeat(11)}.`, 'mid-drag the band covers exactly the dragged cells');
  assert.deepEqual(copied(raw), [], 'nothing is copied before the release');
  const released = raw.length;
  mouse(0, end, at.y, true); await settle(400);
  const after = raw.slice(released);
  assert.deepEqual(copied(after), ['fixture-box'], 'the release puts the dragged text on the clipboard escape');
  const i = after.indexOf('\x1b]52;');
  assert.ok(after.lastIndexOf('\x1b[?2026h', i) <= after.lastIndexOf('\x1b[?2026l', i), 'as its own write, never inside a synchronized frame');
  assert.equal(band(at.y, at.x - 1, end + 1), '.'.repeat(13), 'the band clears on the release');
});
