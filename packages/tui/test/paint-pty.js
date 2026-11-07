const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
let pty, Terminal;
try { pty = require('node-pty'); ({ Terminal } = require('@xterm/headless')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const skip = process.platform === 'win32' ? 'fixture uses POSIX signals' : !pty ? 'node-pty unavailable' : false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const COLS = 120, ROWS = 32;

/** Every cell of the screen as the reader sees it: text, width, colours and attributes, row by row, and the cursor. */
const cellsOf = (term, cursor) => {
  const buf = term.buffer.active, rows = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(y), row = [];
    for (let x = 0; x < term.cols; x++) {
      const c = line.getCell(x);
      row.push([c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold(), c.isItalic(), c.isDim(),
        c.isUnderline(), c.isBlink(), c.isInverse(), c.isInvisible(), c.isStrikethrough(), c.isOverline()].join(','));
    }
    rows.push(`${line.translateToString(false, 0, term.cols).trimEnd()}\n${row.join('|')}`); // a shrunk line keeps cells past the width
  }
  return { rows, cursor: cursor.shown ? [buf.cursorX, buf.cursorY] : 'hidden' };
};
/** A terminal that follows `?25h`/`?25l`, which xterm keeps no public flag for. */
const track = term => {
  const cursor = { shown: true };
  for (const final of ['h', 'l']) term.parser.registerCsiHandler({ prefix: '?', final }, params => { if (params.includes(25)) cursor.shown = final === 'h'; return false; });
  return cursor;
};
const written = (term, data) => new Promise(resolve => term.write(data, resolve));

test('PTY output: a paint writes only the rows that changed, and the screen stays the full frame', { skip, timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(process.env.OAK_PAINT_OUT || os.tmpdir(), 'paint-'));
  const env = { ...process.env, OAK_PAINT_DIR: dir, OAK_PAINT_TAB: 'review', OAK_PAINT_TICK: '1', HOME: dir, USERPROFILE: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), CODEX_HOME: path.join(dir, '.codex'), XDG_CONFIG_HOME: path.join(dir, '.config'),
    HERDR_SOCKET_PATH: path.join(dir, 'missing.sock'), OAK_NO_BACKGROUND: '1', OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1',
    OAK_MACHINE_LABEL: 'fixture-machine', TERM: 'xterm-256color' };
  for (const name of ['TMUX', 'NO_COLOR', 'HERDR_BIN_PATH', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']) delete env[name];
  fs.writeFileSync(path.join(dir, 'herdr'), `#!${process.execPath}\n` + fs.readFileSync(path.join(__dirname, 'fixtures/paint-herdr.cjs'), 'utf8'), { mode: 0o755 });
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true }), cursor = track(term);
  const child = pty.spawn(process.execPath, [path.join(__dirname, 'fixtures/paint-app.cjs')], { cwd: dir, env, cols: COLS, rows: ROWS, name: 'xterm-256color' });
  let raw = '', lastByte = Date.now(), exited = false, applied = Promise.resolve();
  child.onData(data => { raw += data; lastByte = Date.now(); applied = written(term, data); });
  const closed = new Promise(resolve => child.onExit(e => { exited = true; resolve(e); }));
  t.after(async () => {
    if (!exited) child.kill();
    await Promise.race([closed, wait(1000)]);
    term.dispose();
    if (!process.env.OAK_PAINT_OUT) fs.rmSync(dir, { recursive: true, force: true });
  });
  const read = name => fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const rendered = () => read('frames.jsonl').length;
  /** Each synchronized write from `from` on, with the 1-based rows it writes. */
  const bursts = (from = 0) => [...raw.slice(from).matchAll(/\x1b\[\?2026h([\s\S]*?)\x1b\[\?2026l/g)]
    .map(m => ({ text: m[0], rows: [...m[1].matchAll(/\x1b\[(\d+);1H\x1b\[K/g)].map(r => Number(r[1])) }));
  const all = n => Array.from({ length: n }, (_, i) => i + 1);
  const screen = () => Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
  const until = async (ok, what) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { await wait(25); if (ok()) return; assert.ok(!exited, `app exited waiting for ${what}`); }
    assert.fail(`timed out waiting for ${what}:\n${screen()}`);
  };
  /** Quiet: no byte and no rendered frame for `ms`, and the emulator has applied every byte. */
  const settle = async (ms = 250) => {
    let n = rendered(), since = Date.now();
    await until(() => {
      const now = rendered();
      if (now !== n) { n = now; since = Date.now(); }
      return Date.now() - Math.max(since, lastByte) >= ms;
    }, 'a quiet screen');
    await applied;
  };
  /** What the newest rendered frame shows, painted whole into a fresh alternate screen the old way: every row. */
  const fullRepaint = async () => {
    const frames = read('frames.jsonl'), last = frames.at(-1), spans = read('spans.jsonl').filter(s => s.n === last.n);
    const lines = [...last.lines];
    for (let r = 0, s = 0; r < lines.length && s < spans.length; r++) if (lines[r] === spans[s].line) lines[r] = spans[s++].out;
    const ref = new Terminal({ cols: last.cols, rows: last.rows, allowProposedApi: true }), refCursor = track(ref);
    await written(ref, '\x1b[?1049h\x1b[?2026h\x1b[?25l\x1b[H' + lines.map((l, i) => `\x1b[${i + 1};1H\x1b[K${l}`).join('') + '\x1b[?2026l');
    const cells = cellsOf(ref, refCursor);
    ref.dispose();
    return cells;
  };
  /** The screen equals a full repaint of the newest frame. Compared only while nothing new arrived in between. */
  const sameAsFullRepaint = async (label, cursorAt = 'hidden', quiet = 250) => {
    for (let attempt = 0; ; attempt++) {
      await settle(quiet);
      const n = rendered(), length = raw.length;
      const got = cellsOf(term, cursor), want = await fullRepaint();
      if (rendered() !== n || raw.length !== length) { assert.ok(attempt < 10, `${label}: the screen never stayed still`); continue; }
      const off = got.rows.map((row, y) => row === want.rows[y] ? null : `row ${y + 1}: ${JSON.stringify(row.split('\n')[0])} for ${JSON.stringify(want.rows[y]?.split('\n')[0])}`).filter(Boolean);
      if (off.length) fs.writeFileSync(path.join(dir, `mismatch-${label.replace(/\W+/g, '-')}.json`), JSON.stringify({ got, want }));
      assert.deepEqual(off, [], `${label}: the screen is not the full frame`);
      assert.deepEqual(got.cursor, cursorAt, `${label}: cursor`);
      return;
    }
  };
  const results = {};
  const step = async (name, fn) => { try { await fn(); results[name] = null; } catch (error) { results[name] = error; } };
  const statusRow = text => read('frames.jsonl').at(-1).lines.findIndex(l => l.includes(text)) + 1;
  let driveError;
  try {
    await until(() => bursts().length > 0, 'the first frame');
    await step('first', async () => {
      assert.deepEqual(bursts()[0].rows, all(ROWS), 'the first frame writes every row');
      await sameAsFullRepaint('first frame');
    });
    await step('idle', async () => {
      await settle();
      const from = raw.length, n = rendered();
      await wait(3500);
      assert.ok(rendered() - n >= 3, `the refresh tick painted while idle (${rendered() - n} frames)`);
      assert.equal(JSON.stringify(raw.slice(from)), '""', 'an idle paint writes nothing');
    });
    /** Signal a status change; the rows written are exactly the rows of the frame that differ from the one before. */
    const change = async n => {
      await settle();
      const from = raw.length, before = read('frames.jsonl').at(-1).lines;
      process.kill(child.pid, 'SIGUSR1');
      await until(() => bursts(from).length > 0, `status change ${n}`);
      await settle();
      const after = read('frames.jsonl').at(-1).lines, differ = after.map((l, i) => l === before[i] ? 0 : i + 1).filter(Boolean);
      assert.ok(statusRow(`PAINT CHANGE ${n}`) > 0, 'the status shows the change');
      assert.deepEqual(bursts(from).map(b => b.rows), [differ], 'the rows written are the rows that changed');
      await sameAsFullRepaint(`after status change ${n}`);
      return differ;
    };
    await step('one row', async () => {
      assert.equal((await change(1)).length, 2, 'a first status row moves the panes\' bottom edge up a row'); // 2 rows
      assert.deepEqual(await change(2), [statusRow('PAINT CHANGE 2')], 'a new status is its one row');
    });
    await step('help overlay', async () => {
      child.write('?');
      await until(() => /keys.*esc/.test(screen()), 'the help');
      await sameAsFullRepaint('help open');
      child.write('\x1b');
      await until(() => !/keys.*esc/.test(screen()), 'the help to close');
      await sameAsFullRepaint('help closed');
    });
    await step('selection', async () => {
      const lines = read('frames.jsonl').at(-1).lines, row = lines.length, x = lines[row - 1].replace(/\x1b\[[0-9;:]*m/g, '').indexOf('window');
      assert.ok(x >= 0, 'the key row names the windows');
      child.write(`\x1b[<0;${x + 1};${row}M\x1b[<32;${x + 6};${row}M`);
      await until(() => read('spans.jsonl').length > 0, 'a band');
      await sameAsFullRepaint('dragging');
      child.write(`\x1b[<0;${x + 6};${row}m`);
      await wait(200);
      await sameAsFullRepaint('released, with its toast');
      await until(() => !read('frames.jsonl').at(-1).lines.some(l => /copied/.test(l)), 'the toast to end');
      await sameAsFullRepaint('the toast gone');
    });
    await step('resize', async () => {
      await settle();
      const from = raw.length, before = read('frames.jsonl').at(-1).lines;
      term.resize(COLS, 30); child.resize(COLS, 30); // the height only, so rows above the change read the same at both sizes
      await until(() => bursts(from).length > 0, 'a paint at the new size');
      const after = read('frames.jsonl').find(f => f.rows === 30).lines;
      assert.ok(after.some((line, i) => line === before[i]), 'some rows read the same at both sizes, so only the resize makes the paint write them');
      assert.deepEqual(bursts(from)[0].rows, all(30), 'the paint after a resize writes every row');
      await sameAsFullRepaint('resized');
    });
    await step('focus', async () => {
      await settle();
      await written(term, '\x1b[2J'); // the terminal clears its screen under the app, as a "clear buffer" does
      const from = raw.length;
      await assert.rejects(sameAsFullRepaint('cleared'), 'the clear is visible before the focus report');
      child.write('\x1b[I');
      await until(() => bursts(from).length > 0, 'a paint after focus');
      assert.deepEqual(bursts(from)[0].rows, all(30), 'the paint after a focus-in writes every row');
      await sameAsFullRepaint('focused');
    });
    await step('handover', async () => {
      await settle();
      const from = raw.length;
      child.write('\x1a');
      await until(() => raw.indexOf('\x1b[?1049l', from) >= 0, 'the terminal handed over');
      await wait(1500);
      assert.deepEqual(bursts(from), [], 'nothing paints while the terminal is handed over');
      await written(term, '\x1b[?1049hA CHILD DREW THIS'); // a child that took the alternate screen and never gave it back
      const back = raw.length;
      process.kill(child.pid, 'SIGCONT');
      await until(() => bursts(back).length > 0, 'the paint after SIGCONT');
      assert.ok(raw.indexOf('\x1b[?1049h', back) >= 0, 'the alternate screen was entered again');
      assert.deepEqual(bursts(back)[0].rows, all(30), 'the paint after a handover writes every row');
      await sameAsFullRepaint('resumed');
    });
    await step('native tab', async () => {
      child.write('\x1bOP');
      await until(() => /HERDR PANE READY/.test(screen()), 'the herdr pane');
      await sameAsFullRepaint('herdr tab', [4, 3]); // the pane's cursor (row 3, col 5) under the one-row tab bar
      const from = raw.length, n = rendered();
      await wait(1500);
      assert.ok(rendered() - n >= 3, `the pane's redraws painted (${rendered() - n} frames)`);
      assert.deepEqual(bursts(from), [], 'a redraw that moved nothing writes nothing');
    });
    await step('animation', async () => {
      const from = raw.length;
      child.write('\x1bOQ');
      await until(() => / Sessions ─/.test(screen()), 'the Observatory');
      await wait(1500);
      const spins = bursts(from).slice(1);
      assert.ok(spins.length >= 3, `the working pane's spinner painted (${spins.length} writes)`);
      for (const b of spins) assert.ok(b.rows.length < 30, `a spinner frame writes its own rows, not all (${b.rows})`);
      await sameAsFullRepaint('observatory', 'hidden', 100); // between two spinner frames, 150 ms apart
    });
    child.write('\x11\x11');
    await Promise.race([closed, wait(2000)]);
    assert.ok(exited, 'app exits normally');
  } catch (error) { driveError = error; }
  fs.writeFileSync(path.join(dir, 'outer.bin'), raw);
  t.diagnostic(`recording: ${dir}; ${Buffer.byteLength(raw)} bytes; ${bursts().length} writes; ${rendered()} frames rendered`);
  if (driveError) throw driveError;
  for (const [name, title] of [['first', 'the first frame writes every row'], ['idle', 'idle refresh ticks write nothing'],
    ['one row', 'a one-row change writes only that row'], ['help overlay', 'an overlay opens and closes to the full frame'],
    ['selection', 'a drag band, its toast and their end match the full frame'], ['resize', 'after a resize the next paint is a full frame'],
    ['focus', 'after a focus-in the next paint is a full frame, and heals a cleared screen'],
    ['handover', 'after a child had the terminal the next paint is a full frame'],
    ['native tab', 'the herdr tab keeps its cursor and writes nothing for a redraw that moved nothing'],
    ['animation', 'a spinner writes only its rows']])
    await t.test(title, () => { if (results[name]) throw results[name]; assert.ok(name in results, `${name} never ran`); });
});
