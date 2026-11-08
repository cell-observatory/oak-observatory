const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCwd } = require('../dist/native.js');

// A native tab spawns its PTY child in the reviewed session's workspace root. That root is read from
// the transcript, so a session synced from ANOTHER machine names a directory that does not exist here
// — and node-pty's child chdir()s before exec, dying silently. The chooser must fall back to a
// directory that exists on this machine (on a second machine, every herdr tab "exited").
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

// herdr copies a selection, or passes on what a program in its pane copied, as OSC 52 when it has no clipboard tool to
// run (over ssh, on Linux without one). The emulator behind the herdr tab had no clipboard, so that copy went nowhere
// (2026-10-13). Its writes reach the session's listener; a request to read the clipboard is neither passed on nor answered.
test('native: the program\'s clipboard writes (OSC 52) reach the session\'s listener; a read is never passed on or answered', async t => {
  const Module = require('node:module');
  const filename = require.resolve('../dist/native.js');
  const fresh = new Module(filename, module);
  fresh.filename = filename; fresh.paths = module.paths;
  let emit;
  const written = [];
  const load = fresh.require.bind(fresh);
  fresh.require = name => name === 'node-pty' ? {
    spawn: () => ({ pid: 123, onData(fn) { emit = fn; }, onExit() {}, kill() {}, resize() {}, write(d) { written.push(d); } }),
  } : load(name);
  fresh._compile(fs.readFileSync(filename, 'utf8'), filename);
  const session = fresh.exports.spawnNative('fixture', [], 40, 3, os.tmpdir(), 'fixture');
  assert.ok(session); t.after(() => session.close());
  const copies = [];
  session.onClipboard(text => copies.push(text));
  const settle = () => new Promise(resolve => { session.onUpdate(resolve); });
  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  for (const chunk of [`\x1b]52;c;${b64('line 9 of the pane\nline 10')}\x07`, `\x1b]52;;${b64('café ✓')}\x1b\\`,
    '\x1b]52;c;?\x07', '\x1b]52;c;\x07', '\x1b]52;c;not base64!\x07', `\x1b]52;p;${b64('primary')}\x07`, 'text\r\n']) {
    const painted = settle();
    emit(chunk);
    await painted;
  }
  assert.deepEqual(copies, ['line 9 of the pane\nline 10', 'café ✓'], 'a write to the clipboard; not a read, nothing that is not base64, not the primary selection');
  assert.deepEqual(written, [], 'nothing is answered to the program');
  assert.match(session.grid(40, 3, 'none').join('\n'), /text/, 'and the screen goes on as before');
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

test('native mouse: the top rows and the status, usage and key rows go to OAK, never to the child', () => {
  const result = translate(Array.from({ length: 31 }, (_, row) => `\x1b[<0;5;${row}M`).join(''));
  assert.equal(routed(result, 'chrome'), '\x1b[<0;5;1M\x1b[<0;5;2M\x1b[<0;5;3M\x1b[<0;5;28M\x1b[<0;5;29M\x1b[<0;5;30M');
  assert.equal(routed(result, 'pty'), Array.from({ length: 24 }, (_, row) => `\x1b[<0;5;${row + 1}M`).join(''));
  assert.equal(routed(translate('\x1b[<0;5;1M', undefined, 0, 24), 'pty'), '\x1b[<0;5;1M');
  // A drag there is OAK's, its motion and release with it; the wheel there goes nowhere, as before.
  const below = translate('\x1b[<32;6;29M\x1b[<0;6;29m\x1b[<64;6;29M\x1b[<65;6;29M');
  assert.equal(routed(below, 'chrome'), '\x1b[<32;6;29M\x1b[<0;6;29m');
  assert.equal(routed(below, 'pty'), '');
});

// A drag in the program's screen let go over OAK's rows: herdr got the press and the motion but never the release, so
// its selection stayed up and nothing was copied, and a program reading the mouse saw a press with no release
// (2026-10-13). While the program holds the button, its motion and its release are its own, on its nearest row.
test('native mouse: while the program holds the button, its motion and release reach it on its screen\'s nearest row', () => {
  const held = (text) => translateNativeMouse(Buffer.from(text), 3, 24, undefined, true);
  const below = held('\x1b[<32;6;29M\x1b[<32;7;30M\x1b[<0;7;30m');
  assert.equal(routed(below, 'pty'), '\x1b[<32;6;24M\x1b[<32;7;24M\x1b[<0;7;24m', 'under its screen: its last row');
  assert.equal(routed(below, 'chrome'), '');
  assert.equal(routed(held('\x1b[<32;6;2M\x1b[<0;6;1m'), 'pty'), '\x1b[<32;6;1M\x1b[<0;6;1m', 'over the tab bar: its first row');
  assert.equal(routed(held('\x1b[<32;6;10M\x1b[<0;6;10m'), 'pty'), '\x1b[<32;6;7M\x1b[<0;6;7m', 'on its screen, as ever');
  // Not motion or a release: a press and the wheel go where they always went.
  const other = held('\x1b[<0;6;29M\x1b[<64;6;29M\x1b[<0;6;2M');
  assert.equal(routed(other, 'chrome'), '\x1b[<0;6;29M\x1b[<0;6;2M');
  assert.equal(routed(other, 'pty'), '');
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

// A failure's text reached the status row as it came. herdr's line in a form other than Rust's Debug form keeps its
// line break, and a CRLF in it returned the cursor and broke the row in two; an escape in it (a remote's banner) cleared
// the screen or set the window title. The row shows the text, its line breaks and other controls as spaces, and passes
// only colour, OAK's own among it.
test('frame: the status row passes no control character and no escape but colour (2026-10-13)', () => {
  const tui = require('../dist');
  const { fixture } = require('./fixtures/observatory');
  const said = 'herdr review tokens: warning: line one\r\nmachine \x1b[2Jbuild-box\x1b]0;title\x07 is \x1b[31mred\x1b[0m\x07 \u009b2Kback';
  for (const [tab, note] of [[0, null], [0, 'herdr exited'], [1, null], [2, null]]) {
    const state = fixture(); state.activeTab = tab; state.panes = state.tabs[tab].panes;
    state.status = said; state.nativeNote = note;
    let bottom;
    const lines = tui.renderDashFrame(state, { cols: 160, rows: 60, color: 'truecolor', bottom: (first, status) => { bottom = { first, status }; } });
    const row = lines[bottom.first];
    assert.equal(lines.length, 60, 'the frame keeps its height');
    assert.equal(/[\x00-\x1a\x1c-\x1f\x7f-\x9f]/.test(row), false, `no control character (tab ${tab}): ${JSON.stringify(row)}`);
    assert.equal(/\x1b(?!\[[0-9;:]*m)/.test(row), false, `no escape but colour (tab ${tab}): ${JSON.stringify(row)}`);
    const plain = row.replace(/\x1b\[[0-9;:]*m/g, '').trimEnd();
    assert.equal(plain, note ?? 'herdr review tokens: warning: line one  machine build-box is red   2Kback');
    if (!note) assert.match(row, /\x1b\[31mred\x1b\[0m/, 'colour passes');
    else assert.match(row, /\x1b\[[0-9;]+mherdr exited/, 'and so does OAK\'s own');
    assert.equal(bottom.status.replace(/\x1b\[[0-9;:]*m/g, ''), plain, 'a drag to the row\'s edge copies the text the row shows');
  }
});

// A session's title, a workspace's label and a machine's label come from outside (a transcript, herdr, a person's typing):
// the Observatory's tree drew their bidirectional controls, which reorder the row around them in a terminal that lays
// out right-to-left text, and their zero-width characters. The joiners an emoji family is built with stay.
test('frame: the Observatory draws titles and labels without bidi controls or zero-width characters, an emoji family whole', () => {
  const tui = require('../dist');
  const { fixture } = require('./fixtures/observatory');
  const state = fixture(); state.activeTab = 1; state.panes = state.tabs[1].panes;
  state.tabs[1].root = tui.OBSERVATORY_TREE; state.tabs[1].treeFocus = 'obs-sessions';
  const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
  state.views.sessions.sessions[0].title = state.views.multitask.agents[0].title = `Fix\u202e the\u200b demo\u2066 ${family}`;
  state.observatory.machines[0].label = 'lap\u200etop\ufeff';
  state.observatory.machines[0].snapshot.workspaces[0].label = 'de\u061cmo\u2069';
  const lines = tui.renderDashFrame(state, { cols: 160, rows: 30, color: 'none' });
  const hidden = /[\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
  assert.deepEqual(lines.filter((l) => hidden.test(l)).map((l) => JSON.stringify(l.trimEnd())), [], 'no bidi control or zero-width character is drawn');
  const text = lines.join('\n');
  assert.ok(text.includes(`Fix the demo ${family}`), `the title, its emoji family whole:\n${text}`);
  assert.match(text, /^ laptop /m, 'the machine\'s label');
  assert.match(text, /^ {3}demo /m, 'the workspace\'s label');
});

// The same row under an overlay (the help, a picker, options) passed the status raw, and a toast passed its text raw on
// every frame: a raised hand's toast carries the session's title, which a transcript sets (2026-10-13). A status of
// escapes alone says nothing, and the Observatory's panes keep the row it would have taken.
test('frame: under an overlay and in a toast, the status row passes no control character and no escape but colour (2026-10-13)', () => {
  const tui = require('../dist');
  const { fixture } = require('./fixtures/observatory');
  const said = 'herdr review tokens: line one\r\nmachine \x1b[2Jbuild-box\x1b]0;title\x07 is \x1b[31mred\x1b[0m\x07 \u009b2Kback';
  const toast = 'Fix \x1b]0;pwned\x07the demo\r\nneeds your permission \x1b[2J';
  const clean = row => /[\x00-\x1a\x1c-\x1f\x7f-\x9f]/.test(row) || /\x1b(?!\[[0-9;:]*m)/.test(row) ? JSON.stringify(row) : '';
  for (const tab of [0, 1, 2]) for (const overlay of [null, { title: 'help', lines: ['  a line'], scroll: 0 }]) for (const withToast of [false, true]) {
    const state = fixture(); state.activeTab = tab; state.panes = state.tabs[tab].panes;
    state.status = said; state.overlay = overlay;
    if (withToast) state.toast = { text: toast, until: state.now + 5000 };
    const lines = tui.renderDashFrame(state, { cols: 160, rows: 60, color: 'truecolor' });
    const where = `tab ${tab}${overlay ? ', overlay' : ''}${withToast ? ', toast' : ''}`;
    assert.equal(lines.length, 60, `the frame keeps its height (${where})`);
    assert.deepEqual(lines.map(clean).filter(Boolean), [], `no control character and no escape but colour (${where})`);
    const plain = lines.map(l => l.replace(/\x1b\[[0-9;:]*m/g, ''));
    assert.ok(plain.some(l => l.startsWith('herdr review tokens: line one  machine build-box is red   2Kback')), `the status shows (${where})`);
    if (withToast) assert.ok(plain.some(l => l.trimEnd().endsWith('Fix the demo  needs your permission')), `and the toast (${where})`);
  }
  // Escapes alone say nothing: the Observatory's tree keeps its last row, as with a status that is silent.
  const state = fixture(); state.activeTab = 1; state.panes = state.tabs[1].panes;
  const frame = status => { state.status = status; return tui.renderDashFrame(state, { cols: 160, rows: 60, color: 'truecolor' }).map(l => l.replace(/\x1b\[[0-9;:]*m/g, '')); };
  assert.equal(tui.treeReclaimsRow({ ...state, status: '\x1b[2J\x1b]0;title\x07' }, 160, 'truecolor'), false, 'a status of escapes alone reclaims no row');
  assert.deepEqual(frame('\x1b[2J\x1b]0;title\x07'), frame('ready'), 'and draws as a silent status does');
});

// A refusal's toast stands eight seconds. On a status row too narrow for both, it hid the quit hint, a confirmation's
// [y/n], herdr's prefix note, a key's answer said again and a failed keep, and what was no news (a size note, `ready`
// said again, a question the map asks) hid it (2026-10-13). The rule, as statusWithToast states it too:
// On a status row too narrow for both the status and a toast, the toast takes the row (it is the newer fact and the
// shorter one) unless the row shows a question (a confirmation's [y/n] or the go-to prompt), a status said after the
// toast (a new text, or a key's answer said again, never the idle `ready`), or the error of a keep, undo, redo or
// resolve that failed after the toast; that then takes the row whole. Only what the row shows counts: an error, the
// size note or the zoomed edit's bar standing in the status's place is not the status said, and a question the map
// draws is not on the row. A status with nothing to show (empty, or escapes alone) leaves the row to the toast, and a
// row with room for both draws both.
// Each situation is drawn on the surfaces where it arises, plain and in truecolor, at 40, 60, 80 and 110 columns. The
// toast is herdr's refusal, 62 columns: at 40 and 60 it is cut at the edge, at 80 a status of up to 16 columns fits beside
// it, and at 110 one of up to 46. `status`: the row is the status's, as it is with no toast. `toast`: the toast whole with
// the status cut beside it, or the toast alone. `both`: each whole. Each row first checks what the row shows with no
// toast, so it tests the situation it names. The app stamps when a status is said and when a decision fails (statusAt,
// errorAt); the probe's copy-remote-ready check holds the app to those stamps.
test('frame: who takes a status row too narrow for both the status and a toast, by situation, surface and width (2026-10-13)', () => {
  const tui = require('../dist');
  const { fixture } = require('./fixtures/observatory');
  const refusal = "herdr's copy is too large for the terminal (80KB, limit ~73KB)";
  const now = fixture().now, at = ms => now + ms;
  const surfaces = {
    herdr: s => { s.activeTab = 0; },
    observatory: s => { s.activeTab = 1; s.tabs[1] = { ...s.tabs[1], root: tui.OBSERVATORY_TREE, treeFocus: 'obs-sessions' }; },
    review: s => { s.activeTab = 2; },
    // Review with an edit's diff zoomed, whose bar stands on the row when nothing else does.
    diff: s => { s.activeTab = 2; s.tabs[2].panes = { ...s.tabs[2].panes, zoom: 'detail', focus: 'detail' }; s.diffMeta = { id: 7, path: 'src/app.ts' }; },
    overlay: s => { s.activeTab = 2; s.overlay = { title: 'keys', lines: ['a line'], scroll: 0 }; },
  };
  // The status row, plain: the third from the bottom (divider, status, usage, keys), or none when the divider is there.
  const statusRow = (surface, patch, cols, color) => {
    const s = fixture(); surfaces[surface](s); s.panes = s.tabs[s.activeTab].panes; Object.assign(s, patch);
    const line = tui.renderDashFrame(s, { cols, rows: 30, color })[27].replace(/\x1b\[[0-9;:]*m/g, '').trimEnd();
    return /^─+$/.test(line) ? '' : line;
  };
  // As the app stamps them: a toast shown at `ms`, a status said at `ms` (held five seconds), a keep asked three seconds
  // ago that failed at `ms`.
  const toast = ms => ({ toast: { text: refusal, until: at(ms) + 8000, at: at(ms) } });
  const said = (text, ms) => ({ status: text, statusAt: at(ms), statusUntil: at(ms) + 5000 });
  const failed = ms => ({ status: 'keeping 3 edit(s)…', statusAt: at(-3000), statusUntil: 0, error: 'keep failed: the store is locked by another oak process', errorAt: at(ms) });
  const hint = 'press ctrl+q again to exit', nothing = 'nothing here to copy — select an edit, or open its diff';
  const readError = 'a read of the conversation failed: the machine could not be reached';
  const rows = [
    // situation, surfaces, what the row shows with no toast (a control), state, winner at 40, 60, 80 and 110 columns
    ["a confirmation's [y/n]", 'review observatory overlay', /^keep 3 edit\(s\) — everything listed\?/, { confirm: { verb: 'keep', ids: [1, 2, 3], label: 'everything listed' }, ...toast(-1000) }, 'status status status both'],
    ['the go-to prompt', 'review observatory', /^go to edit #1234_$/, { goto: '1234', ...toast(-1000) }, 'status status status both'],
    ['the quit hint', 'herdr review observatory diff overlay', /^press ctrl\+q again to exit$/, { ...said(hint, -500), ...toast(-1000) }, 'status status status both'],
    // A key's answer said again is stamped again, so the row reads as it does for a fresh one.
    ['the quit hint said again after its window', 'review observatory', /^press ctrl\+q again to exit$/, { ...said(hint, -500), ...toast(-1000) }, 'status status status both'],
    ["herdr's prefix note", 'herdr', /^ctrl\+b — m OAK tabs/, { ...said("ctrl+b — m OAK tabs · M pin this pane's session · any other key is herdr's", -500), ...toast(-1000) }, 'status status status status'],
    ["`y`'s answer", 'review', /^nothing here to copy/, { ...said(nothing, -500), ...toast(-1000) }, 'status status status status'],
    ["`y`'s answer said again, a read's error standing", 'review', /^nothing here to copy/, { ...said(nothing, -500), error: readError, ...toast(-1000) }, 'status status status status'],
    ['a decision failure after the toast', 'review observatory diff overlay', /^! keep failed/, { ...failed(-500), ...toast(-1000) }, 'status status status status'],
    ['a decision failure after the toast, on the herdr tab, which draws the status', 'herdr', /^keeping 3 edit\(s\)…$/, { ...failed(-500), ...toast(-1000) }, 'toast toast toast both'],
    ['a decision failure before the toast', 'review observatory overlay', /^! keep failed/, { ...failed(-1500), ...toast(-1000) }, 'toast toast toast toast'],
    ['the size note, once the hold of a status said after the toast ends', 'review', /^at this size: /, { ...said('kept 1 edit', -5500), ...toast(-6000) }, 'toast toast toast both'],
    ["the zoomed edit's bar, once the hold of a status said after the toast ends", 'diff', /^edit #7 · src\/app\.ts$/, { ...said('kept 1 edit', -5500), ...toast(-6000) }, 'toast toast toast both'],
    ['`ready`', 'herdr observatory', null, { ...said('ready', -500), ...toast(-1000) }, 'toast toast toast toast'],
    ["`ready` said again (closing the help), a read's error standing", 'review observatory', /^! a read of the conversation failed/, { ...said('ready', -500), error: readError, ...toast(-1000) }, 'toast toast toast toast'],
    ['`ready` under an overlay, which draws it', 'overlay', /^ready$/, { ...said('ready', -500), ...toast(-1000) }, 'toast toast both both'],
    ['an error standing from before the toast', 'review observatory overlay', /^! a read of the conversation failed/, { error: readError, ...toast(-1000) }, 'toast toast toast toast'],
    ['an error, once the hold of a status said after the toast ends', 'review observatory overlay', /^! a read of the conversation failed/, { ...said('kept 1 edit', -5500), error: readError, ...toast(-6000) }, 'toast toast toast toast'],
    ['a status said before the toast', 'herdr review observatory overlay', /^press ctrl\+q again to exit$/, { ...said(hint, -1500), ...toast(-1000) }, 'toast toast toast both'],
    ['an empty status', 'herdr observatory overlay', null, { ...said('', -500), ...toast(-1000) }, 'toast toast toast toast'],
    ['an escape-only status', 'herdr observatory overlay', null, { ...said('\x1b[2J\x1b]0;title\x07', -500), ...toast(-1000) }, 'toast toast toast toast'],
    ['an escape-only status of colour alone', 'herdr observatory overlay', null, { ...said('\x1b[31m\x1b[0m', -500), ...toast(-1000) }, 'toast toast toast toast'],
    ['a question the map draws', 'review', /^! a read of the conversation failed/, { error: readError, confirm: { verb: 'keep', ids: [1, 2], label: 'src/app.ts', under: 'src/app.ts' }, ...toast(-1000) }, 'toast toast toast toast'],
    ['a status of 16 columns said after the toast', 'herdr review observatory overlay', /^keep: 12 edit\(s\)$/, { ...said('keep: 12 edit(s)', -500), ...toast(-1000) }, 'status status both both'],
  ];
  for (const [name, where, shows, patch, want] of rows) for (const surface of where.split(' ')) for (const color of ['none', 'truecolor']) {
    const got = [40, 60, 80, 110].map(cols => {
      const alone = statusRow(surface, { ...patch, toast: null }, cols, color), shown = statusRow(surface, patch, cols, color);
      assert.ok(shows ? shows.test(alone) : !alone, `control: ${name} (${surface}, ${color}, ${cols}) shows ${JSON.stringify(alone)}`);
      if (alone && shown === alone) return 'status';
      if (alone && shown.startsWith(alone) && shown.endsWith(refusal)) return 'both';
      return shown.endsWith(refusal) || shown === refusal.slice(0, cols) ? 'toast' : JSON.stringify(shown);
    });
    assert.equal(got.join(' '), want, `${name} (${surface}, ${color})`);
  }
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
  t.after(() => (() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* a child's late write: never skip the stop hooks after this one */ } })());
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
  t.after(() => (() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* a child's late write: never skip the stop hooks after this one */ } })());
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
  // The repaint that clears the band follows the copy; on a loaded machine it can land after the 400 ms above.
  let cleared = band(at.y, at.x - 1, end + 1);
  for (const until = Date.now() + 5000; cleared !== '.'.repeat(13) && Date.now() < until; cleared = band(at.y, at.x - 1, end + 1)) await settle(100);
  assert.equal(cleared, '.'.repeat(13), 'the band clears on the release');
});

// OAK's terminal app in a PTY, on `tab`, over a herdr that draws one line and records every byte OAK sends it, and that
// copies `one`, `two` and `three` through OSC 52 at once when it is sent `B`. With a session of its own (`session`), its
// status row is silent until something is said. `tmux` runs it as inside tmux, with `tmux` there the stand-in the test
// writes into the app's `dir`.
async function bottomRowsApp(t, tab, cols, rows, { session = false, tmux = false } = {}) {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-bottom-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = path.join(dir, 'herdr-stdin.log');
  fs.writeFileSync(path.join(dir, 'herdr'), `#!${process.execPath}\n` + [
    "if (process.argv.length > 2) { process.stdout.write('[]\\n'); process.exit(0); }",
    "const fs = require('fs'); fs.writeFileSync(" + JSON.stringify(sent) + ", '');",
    "process.stdin.setRawMode(true); process.stdin.on('data', (d) => { fs.appendFileSync(" + JSON.stringify(sent) + ", d.toString('latin1'));",
    "  if (d.toString('latin1') === 'B') process.stdout.write(['one', 'two', 'three'].map((text) => '\\x1b]52;c;' + Buffer.from(text).toString('base64') + '\\x07').join('')); });",
    "process.stdout.write('\\x1b[2J\\x1b[H' + 'fake herdr screen');",
  ].join('\n') + '\n', { mode: 0o755 });
  const env = { ...process.env, TERM: 'xterm-256color', HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, 'config'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1',
    HERDR_SOCKET_PATH: path.join(dir, 'absent.sock'), PATH: dir + path.delimiter + process.env.PATH };
  for (const k of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'TMUX']) delete env[k];
  fs.mkdirSync(path.join(env.CLAUDE_CONFIG_DIR, 'claude-observatory'), { recursive: true });
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'claude-observatory/agent-setup-suggested'), '1\n');
  if (tmux) env.TMUX = path.join(dir, 'tmux-socket') + ',1,0';
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  t.after(() => term.dispose());
  const args = [];
  if (session) {
    const id = '11111111-2222-3333-4444-555555555555';
    const projects = path.join(env.CLAUDE_CONFIG_DIR, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, cwd: dir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }) + '\n');
    args.push('--session', id, '--root', dir);
  }
  const cli = path.resolve(__dirname, '../../cli/dist/index.js');
  const child = pty.spawn(process.execPath, [cli, 'tui', '--tab', tab, '--no-server', ...args], { cols, rows, name: 'xterm-256color', cwd: dir, env });
  t.after(() => { try { child.kill(); } catch {} });
  const app = { child, term, raw: '', dir };
  child.onData(d => { app.raw += d; term.write(d); });
  const line = y => term.buffer.active.getLine(term.buffer.active.baseY + y);
  const settle = ms => new Promise(r => term.write('', () => setTimeout(r, ms)));
  return Object.assign(app, {
    settle,
    /** Whether `holds` comes true within `ms`, read as the screen repaints. */
    until: async (holds, ms = 5000) => { for (const end = Date.now() + ms; !holds() && Date.now() < end;) await settle(50); return holds(); },
    text: (y, x0 = 0, x1 = term.cols) => line(y).translateToString(true, x0, x1),
    band: (y, x0, x1) => { let s = ''; for (let x = x0; x <= x1; x++) { const c = line(y).getCell(x); s += c.isInverse() || c.isBgRGB() ? 'X' : '.'; } return s; },
    mouse: (b, x, y, up = false) => child.write(`\x1b[<${b};${x + 1};${y + 1}${up ? 'm' : 'M'}`),
    copied: s => [...s.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8')),
    reports: () => (fs.existsSync(sent) ? fs.readFileSync(sent, 'latin1') : '').match(/\x1b\[<[\d;]+[Mm]/g) ?? [],
  });
}
const NO_SESSION = 'no agent session yet — start one in the herdr tab; the Observatory lists every session';

// The rows under every tab (the status row, the usage bar and the key row) lie outside every pane, so nothing
// copied them, and on the herdr tab their clicks went nowhere: an error there could not be copied (2026-10-13).
// A drag there copies as one in a pane does, on each tab, and the status row's text that the terminal is too
// narrow to show comes with it. A click there still does nothing, and nothing of a drag there reaches herdr.
test('built CLI: a drag over the bottom rows copies them on every tab, the status row whole', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const status = NO_SESSION;
  for (const tab of ['observatory', 'review', 'herdr']) await t.test(tab, async () => {
    // Narrower than the status row's text, which the terminal therefore cuts.
    const cols = 60, rows = 20;
    const app = await bottomRowsApp(t, tab, cols, rows);
    const { settle, text, band, mouse, copied, reports } = app;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !(text(rows - 3).startsWith(status.slice(0, 20)) && (tab !== 'herdr' || text(1).includes('fake herdr screen')))) await settle(100);
    const y = rows - 3;
    assert.equal(text(y), status.slice(0, cols), `the status row speaks, cut at the terminal's edge\n${app.raw.slice(-300)}`);
    const keys = text(rows - 1);
    if (tab !== 'herdr') {
      // The pointer says so, as over a pane's text (on the herdr tab herdr owns the pointer).
      const from = app.raw.length;
      mouse(35, 3, y); await settle(300);
      assert.ok(app.raw.slice(from).includes('\x1b]22;text'), 'an I-beam over the status row');
    }
    const copy = async (gesture) => { const from = app.raw.length; await gesture(); await settle(500); return copied(app.raw.slice(from)); };
    // A click does what it did: nothing.
    assert.deepEqual(await copy(async () => { mouse(0, 5, y); await settle(150); mouse(0, 5, y, true); }), [], 'a click copies nothing');
    assert.equal(text(y), status.slice(0, cols), 'and leaves the status row as it was');
    // Only the left button selects: a drag with the middle one selects and copies nothing.
    assert.deepEqual(await copy(async () => {
      mouse(1, 0, rows - 1); await settle(150);
      mouse(33, 9, rows - 1); await settle(300);
      assert.equal(band(rows - 1, 0, 10), '.'.repeat(11), 'no band under a middle-button drag');
      mouse(1, 9, rows - 1, true);
    }), [], 'a middle-button drag copies nothing');
    // A drag on the key row: the band while dragging, exactly the dragged cells on release.
    const ks = await copy(async () => {
      mouse(0, 0, rows - 1); await settle(150);
      mouse(32, 9, rows - 1); await settle(300);
      assert.equal(band(rows - 1, 0, 10), `${'X'.repeat(10)}.`, 'mid-drag the band covers exactly the dragged cells');
      assert.equal(text(y), status.slice(0, cols), 'the status row is not replaced while it is selected');
      mouse(0, 9, rows - 1, true);
    });
    assert.deepEqual(ks, [keys.slice(0, 10).trimEnd()], 'the dragged part of the key row');
    assert.match(text(y), new RegExp(`copied ${ks[0].length} chars to clipboard$`), 'the toast counts what was copied');
    // Across the status row to its edge: the whole status, the part past the edge too.
    const whole = await copy(async () => { mouse(0, 0, y); await settle(150); mouse(32, cols - 1, y); await settle(150); mouse(0, cols - 1, y, true); });
    assert.deepEqual(whole, [status], 'the status row copies whole');
    // From the status row down to the key row, then up over the screen above: the selection stays in the bottom rows.
    const all = await copy(async () => {
      mouse(0, 0, y); await settle(150);
      mouse(32, 4, rows - 1); await settle(150);
      mouse(32, 4, 3); await settle(150);
      mouse(32, 4, rows - 1); await settle(150);
      mouse(0, 4, rows - 1, true);
    });
    assert.deepEqual(all, [[status, text(rows - 2).trimEnd(), keys.slice(0, 5).trimEnd()].join('\n')]);
    let cleared = band(rows - 1, 0, 6);
    for (const until = Date.now() + 5000; cleared !== '.'.repeat(7) && Date.now() < until; cleared = band(rows - 1, 0, 6)) await settle(100);
    assert.equal(cleared, '.'.repeat(7), 'the band clears on the release');
    // One cell: one char.
    assert.deepEqual(await copy(async () => {
      mouse(0, 0, rows - 1); await settle(150); mouse(32, 1, rows - 1); await settle(150); mouse(32, 0, rows - 1); await settle(150); mouse(0, 0, rows - 1, true);
    }), [keys.slice(0, 1)]);
    assert.match(text(y), /copied 1 char to clipboard$/);
    if (tab !== 'herdr') return;
    // Nothing of those gestures reached herdr, though one crossed its screen; a click on its screen still does.
    assert.deepEqual(reports(), [], 'no report from a gesture on the bottom rows');
    mouse(0, 7, 5); mouse(0, 7, 5, true); await settle(500);
    assert.deepEqual(reports(), ['\x1b[<0;8;5M', '\x1b[<0;8;5m'], 'a click on its screen reaches it, one row up');
    // A selection whose release never came (let go outside the window): the next press, on herdr's screen, is
    // herdr's, and so is its release; the band goes. The wheel over herdr's screen meanwhile is herdr's too.
    mouse(0, 2, rows - 1); await settle(150); mouse(32, 6, rows - 1); await settle(300);
    assert.equal(band(rows - 1, 2, 6), 'XXXXX');
    mouse(64, 7, 6); await settle(300);
    mouse(0, 7, 6); mouse(0, 7, 6, true); await settle(500);
    assert.deepEqual(reports().slice(2), ['\x1b[<64;8;6M', '\x1b[<0;8;6M', '\x1b[<0;8;6m'], 'the wheel, the press and its release reach herdr');
    assert.equal(band(rows - 1, 2, 6), '.....');
    // A release let go outside the window, then the pointer back over herdr's screen with no button held: that motion
    // ends the selection as its release would, and copies it; herdr gets none of it.
    const back = await copy(async () => { mouse(0, 2, rows - 1); await settle(150); mouse(32, 6, rows - 1); await settle(150); mouse(35, 7, 6); });
    assert.deepEqual(back, [keys.slice(2, 7).trimEnd()]);
    assert.equal(reports().length, 5, 'nothing more reached herdr');
  });
});

// A selection held on the bottom rows copied whatever lay under it at the release, and those rows move: the status row
// goes when the toast that made it speak runs out, or when the press itself drops herdr's prefix note, and a resize
// moves them all. It copied the divider, or text nobody selected (2026-10-13). Nothing is copied then, and a toast says
// so, which goes by itself. Nothing of these gestures reaches herdr.
test('built CLI: a selection held on the bottom rows copies nothing when they move under it', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const cols = 60, rows = 20, y = rows - 3;
  const app = await bottomRowsApp(t, 'herdr', cols, rows, { session: true });
  const { settle, until, text, band, mouse, copied, reports, child, term } = app;
  const silent = row => /^─/.test(text(row)); // the divider is on the status row's row
  assert.ok(await until(() => silent(y) && text(1).includes('fake herdr screen'), 20000), `the status row is silent\n${app.raw.slice(-300)}`);
  const refused = 'nothing copied: the rows under the selection moved before its release';
  const drag = async (row, hold) => {
    const from = app.raw.length;
    mouse(0, 0, row); await settle(150);
    mouse(32, 8, row); await settle(150);
    await hold();
    mouse(32, 9, row); await settle(150);
    mouse(0, 9, row, true); await settle(500);
    return copied(app.raw.slice(from));
  };
  // herdr's prefix: its note takes the status row, and the press there drops it with the prefix.
  child.write('\x02');
  assert.ok(await until(() => /^ctrl\+b — /.test(text(y))), 'the prefix note is on the status row');
  assert.deepEqual(await drag(y, async () => {
    assert.ok(await until(() => silent(y)), 'the press took the note, and the status row with it');
    assert.ok(await until(() => band(y, 0, 9).includes('X')), 'the band now lies on the divider');
  }), [], 'the divider is not copied');
  assert.ok(await until(() => text(y) === refused.slice(0, cols)), text(y));
  // The next copy's toast takes its place, and makes the otherwise silent status row speak until it runs out.
  mouse(0, 0, rows - 1); await settle(150); mouse(32, 3, rows - 1); await settle(150); mouse(0, 3, rows - 1, true);
  assert.ok(await until(() => /^ +copied 4 chars to clipboard$/.test(text(y))), 'the toast speaks on the status row');
  assert.deepEqual(await drag(y, async () => {
    assert.ok(await until(() => silent(y)), 'the toast ran out under the selection');
  }), [], 'nothing is copied');
  assert.ok(await until(() => text(y) === refused.slice(0, cols)), text(y));
  // The terminal changes size: the selection is dropped at once, and says so.
  assert.deepEqual(await drag(rows - 1, async () => {
    child.resize(cols, rows + 4); term.resize(cols, rows + 4);
    assert.ok(await until(() => text(rows + 1) === 'nothing copied: the terminal changed size during the selection'.slice(0, cols)), text(rows + 1));
    assert.equal(band(rows + 3, 0, 10), '.'.repeat(11), 'no band after the resize');
  }), [], 'nothing is copied');
  // That toast goes by itself.
  assert.ok(await until(() => silent(rows + 1), 10000), 'the status row is silent again');
  // A press that has not moved yet selects nothing: the resize drops it without a word.
  mouse(0, 3, rows + 3); await settle(150);
  child.resize(cols, rows); term.resize(cols, rows);
  assert.ok(await until(() => silent(y)), 'resized back');
  mouse(0, 3, rows - 1, true); await settle(400);
  assert.ok(silent(y), 'and stays silent');
  assert.deepEqual(reports(), [], 'nothing of it reached herdr');
});

// A program in herdr's pane may write the clipboard on every change, and herdr passes each write on: inside tmux each
// one started a `tmux load-buffer` of its own (2026-10-13). One runs at a time, and the newest text that waited goes
// next. herdr says that it copied, so OAK adds no toast.
test('built CLI: herdr\'s copies inside tmux run one tmux at a time, and the newest text that waited goes next', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const cols = 60, rows = 20;
  const app = await bottomRowsApp(t, 'herdr', cols, rows, { tmux: true });
  const { until, text, child } = app;
  const runs = path.join(app.dir, 'tmux-runs');
  fs.mkdirSync(runs);
  // The stand-in tmux: what each run was given, and whether another was running when it started. Each takes a moment.
  fs.writeFileSync(path.join(app.dir, 'tmux'), `#!${process.execPath}\n` + [
    "const fs = require('fs'), path = require('path'), runs = " + JSON.stringify(runs) + ";",
    "if (fs.readdirSync(runs).some((f) => f.endsWith('.running'))) fs.writeFileSync(path.join(runs, 'overlap'), '');",
    "const name = path.join(runs, `${Date.now()}-${process.pid}`); fs.writeFileSync(name + '.running', '');",
    "let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { text += d; });",
    "process.stdin.on('end', () => setTimeout(() => { fs.writeFileSync(name + '.in', text); fs.rmSync(name + '.running'); }, 400));",
  ].join('\n') + '\n', { mode: 0o755 });
  assert.ok(await until(() => text(1).includes('fake herdr screen'), 20000), app.raw.slice(-300));
  child.write('B');
  const copies = () => fs.readdirSync(runs).filter(f => f.endsWith('.in')).sort().map(f => fs.readFileSync(path.join(runs, f), 'utf8'));
  assert.ok(await until(() => copies().length >= 2, 10000), `two runs: ${fs.readdirSync(runs)}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(copies(), ['one', 'three'], 'the first, then the newest that waited');
  assert.equal(fs.existsSync(path.join(runs, 'overlap')), false, 'never two at once');
  assert.doesNotMatch(text(rows - 3), /copied|via tmux/, 'no toast from OAK');
});

// herdr's own copy on the herdr tab, against herdr itself (HERDR_BIN, else the herdr found as OAK finds it), kept off
// every real server: its own HOME, configuration, state and socket. herdr copies as OSC 52 where it prefers that (over
// ssh, in VS Code's terminal, in WSL) and with a clipboard tool otherwise, which macOS always has (pbcopy): the
// VSCODE_IPC_HOOK_CLI herdr reads, and OAK does not, has it copy as OSC 52 on every system, and never into the clipboard
// of whoever runs the test. The emulator behind the tab dropped that copy, and a drag in herdr's pane let go
// over OAK's rows never ended: herdr kept its selection up and copied nothing, and a program in the pane that reads the
// mouse got a press with no release (2026-10-13). Verified on herdr 0.9.1 and 0.9.3.
test('built CLI with herdr: herdr\'s copies reach the terminal OAK runs in, and a drag let go over OAK\'s rows ends in herdr', { skip: process.platform === 'win32', timeout: 120000 }, async t => {
  const bin = process.env.HERDR_BIN || require('../../core/dist').findHerdrBin();
  if (!bin) { const why = 'SKIP HERDR COPY: no herdr binary; the forwarding is verified against the emulator only.'; console.error(why); return t.skip(why); }
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const cp = require('node:child_process');
  const cli = path.resolve(__dirname, '../../cli/dist/index.js');
  const cols = 100, rows = 30;
  const run = async (mouse) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-herdr-copy-'));
    for (const d of ['home', 'config/herdr', 'data', 'state', 'cache', 'run', 'bin', 'tmp', 'ws']) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'config/herdr/config.toml'), 'onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n');
    fs.symlinkSync(bin, path.join(dir, 'bin', 'herdr'));
    const got = path.join(dir, 'pane-stdin.log');
    // The pane's program: numbered lines to select; with `mouse`, it asks for the mouse and records what it is sent.
    fs.writeFileSync(path.join(dir, 'bin', 'pane'), `#!${process.execPath}\nconst fs = require('fs'); process.stdin.setRawMode(true);\n` +
      `process.stdout.write(${JSON.stringify(mouse ? '\x1b[?1002h\x1b[?1006h' : '')} + Array.from({ length: 12 }, (_, i) => 'line ' + i + ' of the pane, words to select').join('\\r\\n'));\n` +
      `process.stdin.on('data', d => fs.appendFileSync(${JSON.stringify(got)}, d.toString('latin1'))); setInterval(() => {}, 1e6);\n`, { mode: 0o755 });
    const env = { PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, TERM: 'xterm-256color', LANG: 'C.UTF-8', SHELL: path.join(dir, 'bin', 'pane'),
      HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_STATE_HOME: path.join(dir, 'state'),
      XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_RUNTIME_DIR: path.join(dir, 'run'), HERDR_SOCKET_PATH: path.join(dir, 'run', 'h.sock'), TMPDIR: path.join(dir, 'tmp'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), OAK_NO_SERVER: '1', OAK_NO_BACKGROUND: '1',
      CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', OAK_MACHINE_LABEL: 'workstation', VSCODE_IPC_HOOK_CLI: path.join(dir, 'run', 'vscode.sock') };
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    const child = pty.spawn(process.execPath, [cli, 'tui', '--tab', 'herdr', '--no-server'], { cols, rows, name: 'xterm-256color', cwd: path.join(dir, 'ws'), env });
    t.after(() => {
      try { child.kill(); } catch {}
      cp.spawnSync(bin, ['server', 'stop'], { env, timeout: 10000, stdio: 'ignore' });
      term.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const app = { raw: '' };
    child.onData(d => { app.raw += d; term.write(d); });
    const settle = ms => new Promise(r => term.write('', () => setTimeout(r, ms)));
    const text = y => term.buffer.active.getLine(term.buffer.active.baseY + y).translateToString(true);
    const find = s => { for (let y = 0; y < rows; y++) { const x = text(y).indexOf(s); if (x >= 0) return { x, y }; } return null; };
    const press = (b, x, y, up = false) => child.write(`\x1b[<${b};${x + 1};${y + 1}${up ? 'm' : 'M'}`);
    const copies = from => [...app.raw.slice(from).matchAll(/\x1b\]52;c;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));
    for (const end = Date.now() + 30000; !find('line 11 of the pane') && Date.now() < end;) await settle(100);
    assert.ok(find('line 11 of the pane'), `herdr's pane is on the herdr tab\n${Array.from({ length: rows }, (_, y) => text(y)).join('\n')}`);
    await settle(1000);
    return { app, settle, text, find, press, copies, got: () => (fs.existsSync(got) ? fs.readFileSync(got, 'latin1') : '') };
  };
  await t.test('herdr\'s own selection', async () => {
    const { app, settle, text, find, press, copies } = await run(false);
    // Within its pane: the copy reaches OAK's terminal as OSC 52.
    const at = find('line 3 of the pane');
    let from = app.raw.length;
    press(0, at.x, at.y); await settle(100); press(32, at.x + 6, at.y); await settle(100); press(32, at.x + 9, at.y); await settle(100); press(0, at.x + 9, at.y, true);
    for (const end = Date.now() + 5000; !copies(from).length && Date.now() < end;) await settle(100);
    assert.deepEqual(copies(from).map(s => s.trimEnd()), [text(at.y).slice(at.x, at.x + 10).trimEnd()], 'the selected text, as OSC 52 from OAK');
    // herdr says it copied, in its own screen; OAK's status row adds no toast of its own.
    await settle(300);
    assert.doesNotMatch(text(rows - 3), /copied/, 'no toast from OAK');
    // Let go over OAK's key row: herdr's selection ends on its last row, and herdr copies it.
    await settle(1500);
    const start = find('line 5 of the pane');
    from = app.raw.length;
    press(0, start.x, start.y); await settle(100); press(32, start.x + 4, start.y + 2); await settle(100); press(32, start.x + 4, rows - 1); await settle(150); press(0, start.x + 4, rows - 1, true);
    for (const end = Date.now() + 5000; !copies(from).length && Date.now() < end;) await settle(100);
    const [copied] = copies(from);
    assert.ok(copied?.startsWith('line 5 of the pane'), `herdr finished the selection and copied it: ${JSON.stringify(copied)}`);
    assert.match(copied, /line 11 of the pane/, 'down to its last row');
  });
  await t.test('a program in herdr\'s pane that reads the mouse', async () => {
    const { settle, find, press, got } = await run(true);
    const at = find('line 3 of the pane');
    const before = got().length;
    press(0, at.x, at.y); await settle(100); press(32, at.x + 3, at.y); await settle(100); press(32, at.x + 3, rows - 1); await settle(150); press(0, at.x + 3, rows - 1, true);
    let reports = [];
    for (const end = Date.now() + 5000; !reports.some(r => r.endsWith('m')) && Date.now() < end; reports = got().slice(before).match(/\x1b\[<\d+;\d+;\d+[Mm]/g) ?? []) await settle(100);
    const presses = reports.filter(r => /^\x1b\[<0;/.test(r) && r.endsWith('M')), releases = reports.filter(r => r.endsWith('m'));
    assert.equal(presses.length, 1, JSON.stringify(reports));
    assert.equal(releases.length, 1, `the press is paired with its release: ${JSON.stringify(reports)}`);
    assert.ok(reports.some(r => /^\x1b\[<32;/.test(r)), `and the motion between: ${JSON.stringify(reports)}`);
    assert.ok(reports.at(-1).endsWith('m'), 'the release comes last');
  });
});
