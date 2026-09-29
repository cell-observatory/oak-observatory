/**
 * Accepted edits that vanish for a moment and then come back.
 *
 * A `views` read that BEGAN before a write lands AFTER it, carrying the store as it was — so the
 * rows the reader just kept reappear, then vanish again when the next read finishes. On a small
 * fixture both halves take ~120 ms and the window never opens; on a real 16 MB session the read is
 * ~11 s and the write ~90 ms, so it opens every time. This test opens it on purpose.
 *
 * Usage: node test/stale-read-race.js <cli-dist-index.js>
 *
 * SELF-HOSTING. The dashboard spawns its children as `node <argv[1]> views …`, so this file has to
 * BE argv[1] to intercept them — it runs as the launcher in the parent and as a deliberately slow
 * `views` in the child. (Pointing argv[1] at the real CLI was the instrument bug that made an
 * earlier version of this reproduction report "no race" while the mutant was live.)
 *
 * MUTATION CONTROL: delete the `applyLocally` re-application in app.ts's `onData` handler and this
 * must fail with "*** AND CAME BACK".
 */
// The parent exports this before launching, so every spawned child inherits it — which is also how
// a child knows it is one. Sniffing argv instead only caught `views` and let the `keep` child
// re-enter the launcher, seeding a second store and silently never accepting anything.
const CHILD = !!process.env.OBS_RACE_CLI;
const CLI = process.env.OBS_RACE_CLI || process.argv[2];
const SLOW_MS = Number(process.env.OBS_RACE_SLOW_MS || 2500);

if (CHILD) {
  if (process.argv[2] !== 'views') {
    // Every other verb — `keep`, `undo`, `diff` — runs at full speed. Only the READ is slow, which
    // is the asymmetry that opens the window on a real session.
    process.argv = [process.argv[0], CLI, ...process.argv.slice(2)];
    require(CLI);
  } else {
    // The read genuinely runs against the store as it is NOW; only its answer is held back. That is
    // exactly the state a pre-write answer carries, which makes this a faithful stand-in for a slow
    // read rather than a stall.
    const cp = require('child_process');
    const r = cp.spawnSync(process.execPath, [CLI, ...process.argv.slice(2)], { encoding: 'utf8', maxBuffer: 1 << 28 });
    setTimeout(() => {
      process.stdout.write(r.stdout || '');
      if (r.stderr) process.stderr.write(r.stderr);
      // exitCode, not exit(): the answer must drain first. The dashboard reads this child through a
      // socket that holds 8 KB on macOS, and exit() with the rest still queued delivered 8 KB of a 40 KB
      // answer ("views exited 0 without valid JSON"), so the map never filled (2026-09-27).
      process.exitCode = r.status ?? 0;
    }, SLOW_MS);
  }
  return;
}

// ---- parent mode: drive the real dashboard ---------------------------------------------------
const COLS = 120;
const ROWS = 34;
process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};
process.stdin.resume = () => process.stdin;
process.stdin.pause = () => process.stdin;
process.stdout.isTTY = true;
process.stdout.columns = COLS;
process.stdout.rows = ROWS;

const screen = new Array(ROWS).fill('');
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => {
  const text = typeof s === 'string' ? s : String(s);
  const re = /\x1b\[(\d+);1H\x1b\[K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const row = Number(m[1]) - 1;
    if (row >= 0 && row < ROWS) screen[row] = m[2];
  }
  return true;
};
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const frame = () => screen.map(plain);
const say = (s) => realWrite(s + '\n');

const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require(path.join(path.dirname(path.dirname(CLI)), '..', 'core', 'dist', 'index.js'));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'race-cfg-'));
process.env.CLAUDE_CONFIG_DIR = sandbox;
process.env.OBS_RACE_CLI = CLI;
// No focus server: this race does not use one, and one started here would outlive the sandbox it lives in.
process.env.OAK_NO_SERVER = '1';
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'race-ws-')));
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
const SESSION = 'staleread0';
core.ensureStore(SESSION);
const SEEDED = 40;
for (let i = 0; i < SEEDED; i++) {
  const f = path.join(ws, 'src', `f${i}.ts`);
  fs.writeFileSync(f, `export const v = ${i};\n`);
  const before = core.writeBlob(SESSION, Buffer.from('export const v = 0;\n'));
  const after = core.writeBlob(SESSION, Buffer.from(`export const v = ${i};\n`));
  core.appendLog(SESSION, { ts: Date.now() - i * 1000, tool: 'Edit', file: f, beforeBlob: before, afterBlob: after, status: 'pending' });
}
process.on('exit', () => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
});

// The Map pane is what this race is measured on, and the default tab (observatory) does not
// show it. Open the tab that does, exactly as a reader reviewing edits would.
process.argv = [process.argv[0], __filename, '--root', ws, '--session', SESSION, '--tab', 'review'];
require(CLI);

const send = (b) => process.stdin.emit('data', Buffer.from(b, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickAt = (row, col) => { send(`\x1b[<0;${col};${row}M`); send(`\x1b[<0;${col};${row}m`); };
/**
 * The SESSION row's pending counter.
 *
 * Not the map's heading: the confirmation bar REPLACES that row, so reading it made an open question
 * look like "everything was accepted" and the check passed against a screen that showed nothing of
 * the sort.
 */
const pendingShown = () => {
  const m = /\? (\d+) pending/.exec(frame().find((l) => /\? \d+ pending/.test(l)) || '');
  return m === null ? -1 : Number(m[1]);
};

(async () => {
  for (let i = 0; i < 120 && !frame().some((l) => /CHANGE MAP/.test(l)); i++) await sleep(150);
  const before = pendingShown();
  if (before <= 0) { say(`SKIP: the map never showed pending edits (${before})`); process.exit(1); }

  // ZOOM the Map first (F4 focuses it, F4 again fills the frame): in the review tab's default
  // four-pane split the Map column is too narrow for the heading toolbar, so the keep-all button
  // this race is armed by never renders un-zoomed — the same drill-in a reader would use.
  send('\x1bOS');
  await sleep(120);
  send('\x1bOS');
  for (let i = 0; i < 40 && !frame().some((l) => /\[ [✓+] \d+ \]/.test(l)); i++) await sleep(150);
  const barRow = frame().findIndex((l) => /\[ [✓+] \d+ \]/.test(l)); // the keep-all ICON button (words moved to the footer keymap)
  if (barRow < 0) { say('SKIP: no map toolbar even zoomed'); say(JSON.stringify(frame().filter((l)=>/CHANGE MAP|\[/.test(l)).slice(0,4))); process.exit(1); }

  // Put a read in flight, THEN write. Without the nudge the accept can land in a quiet gap and the
  // race the test exists to cover never happens.
  send('r');
  await sleep(40);
  clickAt(barRow + 1, frame()[barRow].search(/\[ [✓+]/) + 2);
  await sleep(400);
  const qRow = frame().findIndex((l) => /y — yes/.test(l));
  if (qRow < 0) {
    say('SKIP: the confirmation never appeared');
    say('barRow=' + barRow + ' clickCol=' + (frame()[barRow].search(/\[ [✓+]/) + 2));
    for (let r = Math.max(0, barRow - 1); r <= Math.min(barRow + 3, frame().length - 1); r++) say(r + ': ' + JSON.stringify(frame()[r].slice(0, 118)));
    process.exit(1);
  }
  clickAt(qRow + 1, frame()[qRow].indexOf('[ y — yes') + 3);

  // Watch well past the slow read, so a late clobber cannot slip past the end of the window.
  const trail = [];
  let sawGone = false;
  let cameBack = false;
  for (let i = 0; i < SLOW_MS / 25 + 80; i++) {
    await sleep(50);
    const p = pendingShown();
    if (!trail.length || trail[trail.length - 1][1] !== p) trail.push([i * 50, p]);
    if (!sawGone && p === 0) sawGone = true;
    if (sawGone && p > 0) cameBack = true;
  }

  process.stdout.write = realWrite;
  say(`pending: ${before} → ${pendingShown()}  ·  timeline ${JSON.stringify(trail)}`);
  if (!sawGone) { say('*** the accept never took effect on screen'); process.exit(1); }
  if (cameBack) { say('*** AND CAME BACK — a read that predates the write clobbered it'); process.exit(1); }
  say('STALE-READ-RACE: accepted rows stayed gone');
  process.exit(0);
})().catch((e) => {
  process.stdout.write = realWrite;
  console.error('THREW: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
