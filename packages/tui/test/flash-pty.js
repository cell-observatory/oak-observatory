const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const scan = require('./fixtures/terminal-stream.cjs');
let pty, Terminal;
try { pty = require('node-pty'); ({ Terminal } = require('@xterm/headless')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const skip = process.platform === 'win32' ? 'fixture uses a POSIX shell' : !pty ? 'node-pty unavailable' : false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('PTY output: hidden panes, drawn text and periodic frames', { skip, timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(process.env.OAK_FLASH_OUT || os.tmpdir(), 'flash-'));
  const env = { ...process.env, OAK_FLASH_DIR: dir, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'),
    CODEX_HOME: path.join(dir, '.codex'), XDG_CONFIG_HOME: path.join(dir, '.config'), HERDR_SOCKET_PATH: path.join(dir, 'missing.sock'),
    OAK_NO_BACKGROUND: '1', OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', OAK_MACHINE_LABEL: 'fixture-machine', TERM: 'xterm-256color' };
  for (const name of ['TMUX', 'HERDR_BIN_PATH', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']) delete env[name];
  fs.writeFileSync(path.join(dir, 'herdr'), `#!${process.execPath}\n` + fs.readFileSync(path.join(__dirname, 'fixtures/flash-herdr.cjs'), 'utf8'), { mode: 0o755 });
  const term = new Terminal({ cols: 140, rows: 40, allowProposedApi: true });
  const child = pty.spawn(process.execPath, [path.join(__dirname, 'fixtures/flash-app.cjs')], { cwd: dir, env, cols: 140, rows: 40, name: 'xterm-256color' });
  const chunks = [], phases = [], screens = {};
  let length = 0, exited = false;
  child.onData(data => { const bytes = Buffer.from(data); chunks.push({ at: Date.now(), offset: length, bytes }); length += bytes.length; term.write(data); });
  const closed = new Promise(resolve => child.onExit(e => { exited = true; resolve(e); }));
  const screen = () => Array.from({ length: 40 }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
  const readLog = name => fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse) : [];
  const until = async (condition, description = String(condition)) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await wait(30);
      if (typeof condition === 'function' ? condition() : condition.test(screen())) return;
      assert.ok(!exited, `app exited waiting for ${description}:\n${screen()}`);
    }
    assert.fail(`timed out waiting for ${description}:\n${screen()}`);
  };
  const phase = name => { phases.push({ name, offset: length, at: Date.now() }); };
  // Shell sleep is only a minimum: keep the phase until real bells have reached the app's handler.
  const untilBells = async (count = 2, visible = false) => {
    const current = phases.at(-1);
    await until(() => readLog('pane.jsonl').filter(b => b.at >= current.at).length >= count
      && readLog('sources.jsonl').filter(s => s.kind === 'pane-bell' && s.at >= current.at).length >= count
      && (!visible || scan(Buffer.concat(chunks.map(c => c.bytes))).events.filter(e => e.kind === 'bell' && e.offset >= current.offset).length >= count),
    `${count} pane bells during ${current.name}`);
  };
  const click = async text => {
    fs.writeFileSync(path.join(dir, 'hold-updates'), '1');
    await wait(200);
    await until(new RegExp(text));
    const lines = screen().split('\n'), y = lines.findIndex(l => l.includes(text)), x = lines[y].indexOf(text);
    child.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    await wait(250);
    fs.unlinkSync(path.join(dir, 'hold-updates'));
  };
  t.after(async () => {
    if (!exited) child.kill();
    await Promise.race([closed, wait(1000)]);
    term.dispose();
    if (!process.env.OAK_FLASH_OUT) fs.rmSync(dir, { recursive: true, force: true });
  });
  let driveError;
  try {
    await until(/HERDR PANE READY/);
    phase('F1'); await wait(Number(process.env.OAK_FLASH_DWELL || 900)); await untilBells(2, true); screens.F1 = screen();
    child.write('\x1bOQ'); await until(/\[ F2 observatory \]/);
    phase('F2'); child.write('\r'); await until(/CONVERSATION TEXT/);
    await wait(Number(process.env.OAK_FLASH_DWELL || 900)); await untilBells(); screens.F2 = screen();
    await click('PROCESSNAME'); await until(/PROCESS ?TEXT/);
    phase('process-follow'); await wait(900); screens.process = screen();
    child.write('\x1bOR'); await until(/\[ F3 review \]/);
    phase('F3'); await wait(Number(process.env.OAK_FLASH_DWELL || 900)); await untilBells(); screens.F3 = screen();
    phase('palette'); child.write(':'); await until(/a command, or type to find/); await wait(350); screens.palette = screen();
    child.write('\x1b'); await wait(150);
    phase('command'); child.write(':doctor\r'); await until(/COMMAND/); await wait(350); screens.command = screen();
    child.write('\x1b'); await wait(150);
    child.write('?'); await until(/keys.*esc/); child.write('\x1b1'); await until(/\[ F1 herdr \]/);
    phase('F1-covered'); await untilBells(); screens.covered = screen();
    phase('F1-return'); child.write('\x1b'); await until(/HERDR PANE READY/); await untilBells(1, true);
    phase('quit'); child.write('\x11\x11');
    await Promise.race([closed, wait(2000)]);
    assert.ok(exited, 'app exits normally');
  } catch (error) { driveError = error; child.kill(); await Promise.race([closed, wait(1000)]); }
  const bytes = Buffer.concat(chunks.map(c => c.bytes)), result = scan(bytes);
  const sources = readLog('sources.jsonl');
  const writes = sources.filter(s => s.kind === 'write');
  const paneBells = readLog('pane.jsonl');
  // PTY ONLCR adds CR to newlines; record source ranges in the actual output's coordinate system.
  let at = 0;
  for (const s of writes) { const b = Buffer.from(s.base64, 'base64').toString().replace(/\n/g, '\r\n'); s.start = at; at += Buffer.byteLength(b); s.end = at; }
  for (const event of result.events) {
    const chunk = chunks.find(c => event.offset >= c.offset && event.offset < c.offset + c.bytes.length);
    const source = writes.find(s => event.offset >= s.start && event.offset < s.end);
    event.at = chunk?.at; event.ms = source?.ms; event.virtualMs = source?.virtualMs; event.source = source?.stack;
    event.phase = phases.findLast(p => p.offset <= event.offset)?.name || 'startup';
  }
  fs.writeFileSync(path.join(dir, 'outer.bin'), bytes);
  fs.writeFileSync(path.join(dir, 'chunks.jsonl'), chunks.map(c => JSON.stringify({ at: c.at, offset: c.offset, length: c.bytes.length })).join('\n'));
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify({ phases, ...result }, null, 2));
  fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify(screens, null, 2));
  t.diagnostic(`recording: ${dir}; ${bytes.length} bytes; ${result.events.filter(e => e.kind === 'frame').length} frames`);
  if (driveError) throw driveError;
  await t.test('a non-visible native pane never rings the outer terminal', () => {
    for (const name of ['F2', 'F3', 'F1-covered']) {
      const i = phases.findIndex(p => p.name === name);
      assert.ok(paneBells.filter(b => b.at >= phases[i].at && b.at < phases[i + 1].at).length >= 2, `real shell rang while ${name} hid it`);
    }
    assert.deepEqual(result.events.filter(e => e.kind === 'bell' && ['F2', 'process-follow', 'F3', 'F1-covered'].includes(e.phase)).map(e => ({ ms: e.ms, phase: e.phase })), []);
  });
  await t.test('the visible native pane preserves real bells', () => {
    assert.ok(result.events.filter(e => e.kind === 'bell' && e.phase === 'F1').length >= 2, 'F1 forwards its visible pane bells');
    assert.ok(result.events.some(e => e.kind === 'bell' && e.phase === 'F1-return'), 'returning to F1 restores bell delivery');
    // Every bell the pane's emulator raised is a real one: the fake herdr logs the shell's BEL bytes before it passes
    // them on, so by each raised bell at least as many have been logged. A BEL that ends a split OSC title or sits in a
    // DCS payload, taken for a bell, would outrun them.
    const raised = sources.filter(s => s.kind === 'pane-bell');
    const real = paneBells.map(b => ({ at: b.at, count: Buffer.from(b.hex, 'hex').filter(x => x === 7).length }));
    raised.forEach((s, k) => assert.ok(real.filter(b => b.at <= s.at).reduce((n, b) => n + b.count, 0) > k,
      `split OSC terminators and DCS payloads do not add bells: bell ${k + 1} was raised after fewer real ones`));
    // Each bell raised while F1 showed the pane reached the outer terminal once. The app forwards by its own active tab,
    // so that is the count to compare with. The bells rung before the test saw F2 drawn also hold those rung after the
    // app had hidden the pane, and a switch longer than two of the shell's 200 ms rings counted two too many.
    // One raised just before F1 began may still arrive after it.
    const i = phases.findIndex(p => p.name === 'F1');
    const shown = raised.filter(s => s.tab === 'herdr' && s.at >= phases[i].at && s.at < phases[i + 1].at).length;
    const received = result.events.filter(e => e.kind === 'bell' && e.phase === 'F1').length;
    assert.ok(received >= shown && received <= shown + 1, `each bell raised while F1 showed reached the terminal once: ${received} received, ${shown} raised`);
  });
  await t.test('drawn text never carries a raw BEL or erase', () => {
    assert.match(screens.F2, /CONVERSATION TEXT/);
    assert.match(screens.process, /PROCESS ?TEXT/);
    assert.deepEqual(result.events.filter(e => e.kind === 'bell' && e.sync || e.kind === 'erase').map(e => ({ kind: e.kind, ms: e.ms, phase: e.phase })), []);
    assert.match(screens.command, /COMMAND TEXT/);
    assert.match(screens.palette, /TITLE TEXT/);
  });
  await t.test('periodic work keeps the alternate screen and synchronizes every frame', () => {
    assert.deepEqual(result.events.filter(e => e.kind === 'alternate').map(e => [e.phase, e.sequence]), [['startup', '?1049h'], ['quit', '?1049l']]);
    assert.deepEqual(result.events.filter(e => e.kind === 'frame' && !e.sync || e.kind.startsWith('unsynced-')).slice(0, 5).map(e => ({ kind: e.kind, offset: e.offset })), []);
    assert.ok(result.events.filter(e => e.kind === 'frame').length > 15);
    for (const kind of ['refresh', 'fixture-update', 'herdr-snapshot', 'tab-housekeeping', 'conversation-read', 'process-read']) assert.ok(sources.filter(s => s.kind === kind).length > 1, kind);
    assert.ok(sources.filter(s => s.kind === 'backend-run' && s.args[0] === 'sync').length > 1, 'sync status refreshed');
    assert.ok(sources.some(s => s.kind === 'fixture-update' && s.worker === 'done'), 'a worker finished');
    assert.equal(result.sync, false);
  });
});

test('built CLI: transcript titles and search snippets cannot drive the terminal', { skip, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(process.env.OAK_FLASH_OUT || os.tmpdir(), 'flash-cli-'));
  const repo = path.resolve(__dirname, '../../..');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), CODEX_HOME: path.join(dir, '.codex'),
    XDG_CONFIG_HOME: path.join(dir, '.config'), HERDR_SOCKET_PATH: path.join(dir, 'missing.sock'), HERDR_BIN_PATH: path.join(dir, 'herdr'),
    PATH: dir + path.delimiter + process.env.PATH, OAK_NO_BACKGROUND: '1', OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', OAK_MACHINE_LABEL: 'fixture-machine', TERM: 'xterm-256color' };
  for (const key of ['TMUX', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'CLAUDE_OBSERVATORY_NO_UPDATE_CHECK']) delete env[key];
  // The waits below find the active tab by its brackets, which the app draws without colour: pin it, whatever the runner has.
  env.NO_COLOR = '1';
  delete env.FORCE_COLOR;
  fs.writeFileSync(path.join(dir, 'herdr'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
  const store = path.join(env.CLAUDE_CONFIG_DIR, 'claude-observatory');
  fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(path.join(store, 'agent-setup-suggested'), '1\n');
  fs.writeFileSync(path.join(store, '.update-check'), JSON.stringify({ checkedMs: Date.now(), latestTag: 'v99.0.0', latestDevTag: 'v99.0.0-dev.0' }));
  const projects = path.join(env.CLAUDE_CONFIG_DIR, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'flash-real.jsonl'), [
    { type: 'custom-title', sessionId: 'flash-real', customTitle: 'TITLE\x07TEXT' },
    { type: 'user', sessionId: 'flash-real', cwd: dir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'FLASHMATCH CONVERSATION\x07TEXT ERASE\x1b[2JEND' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const child = pty.spawn(process.execPath, [path.join(repo, 'packages/cli/dist/index.js'), 'tui', '--session', 'flash-real', '--root', dir, '--tab', 'observatory', '--no-server'],
    { cwd: dir, env, cols: 140, rows: 40, name: 'xterm-256color' });
  const term = new Terminal({ cols: 140, rows: 40, allowProposedApi: true });
  const chunks = []; let exited = false;
  child.onData(data => { chunks.push({ at: Date.now(), data }); term.write(data); });
  const closed = new Promise(resolve => child.onExit(() => { exited = true; resolve(); }));
  const screen = () => Array.from({ length: 40 }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
  const until = async re => {
    for (const deadline = Date.now() + 12000; Date.now() < deadline;) { await wait(40); if (re.test(screen())) return; assert.ok(!exited, screen()); }
    assert.fail(`waiting for ${re}:\n${screen()}`);
  };
  t.after(async () => {
    if (!exited) child.kill(); await Promise.race([closed, wait(1000)]); term.dispose();
    if (!process.env.OAK_FLASH_OUT) fs.rmSync(dir, { recursive: true, force: true });
  });
  try {
    await until(/TITLE TEXT/);
    child.write('\x1bOR'); await until(/\[ F3 review \]/); await wait(300);
    child.write('\x1bOQ'); await until(/\[ F2 observatory \]/);
    child.write(':'); await until(/a command, or type to find/); await wait(200);
    child.write('FLASHMATCH\r'); await until(/END/); await wait(300);
    child.write('\x11\x11'); await Promise.race([closed, wait(1000)]);
  } finally {
    fs.writeFileSync(path.join(dir, 'outer.bin'), chunks.map(c => c.data).join(''));
    fs.writeFileSync(path.join(dir, 'chunks.jsonl'), chunks.map(c => JSON.stringify(c)).join('\n'));
    fs.writeFileSync(path.join(dir, 'screen.txt'), screen());
  }
  const bytes = Buffer.from(chunks.map(c => c.data).join(''));
  const result = scan(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    const end = offset + Buffer.byteLength(chunk.data);
    for (const event of result.events) if (event.offset >= offset && event.offset < end) {
      event.at = chunk.at; event.ms = chunk.at - chunks[0].at;
    }
    offset = end;
  }
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(result, null, 2));
  t.diagnostic(`built CLI recording: ${dir}`);
  assert.deepEqual(result.events.filter(e => ['bell', 'erase'].includes(e.kind)).map(e => ({ kind: e.kind, offset: e.offset })), []);
  assert.deepEqual(result.events.filter(e => e.kind.startsWith('unsynced-')), [], 'the update cache prints no nudge over the app or on exit');
});
