// Generate the frames for the homepage's interactive terminal demo, from the REAL current TUI.
//
// Faithful end-to-end: runs the scripted demo through the real capture pipeline in a hermetic
// HOME + workspace, and at each beat captures one plain frame of the ACTUAL `oak tui` via its
// `--once` renderer (truecolor forced through prefs). Each frame's ANSI is converted to HTML spans
// and written to docs/media/tui-frames.js as window.__OAK_TUI_FRAMES__ = [{cap, html}, …], which
// the interactive player in showcase.html reads. Rendering the real binary — not a mockup — is the
// point: a terminal demo that drifts from the product is a claim nobody can check.
//
// Usage: node scripts/build-tui-demo.mjs        (requires a built core/cli)
// --renderer-only uses the shipped frame renderer on demo data, without a child process or sockets.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { frameHtml } from './ansi-html.mjs';
import { startCaptureServer, validateFrame } from './tui-capture.mjs';
import { demoFrame } from './demo-frame.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const COLS = 100, ROWS = 30;

const herdrBinary = require(path.join(ROOT, 'packages/core/dist')).findHerdrBin();

// --- hermetic demo home + workspace (never touches real sessions) ---------------------------------
// /tmp/obs-demo on every POSIX system: the privacy gate admits that path in published media, and
// macOS's per-user TMPDIR (/var/folders/…) would otherwise be written into it.
const scratch = process.platform === 'win32' ? path.join(os.tmpdir(), 'obs-demo') : '/tmp/obs-demo';
fs.mkdirSync(scratch, { recursive: true });
const home = fs.mkdtempSync(path.join(scratch, 'home-'));
const ws = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'workspace-')));
fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
process.env.XDG_CONFIG_HOME = path.join(home, 'config');
process.env.XDG_STATE_HOME = path.join(home, 'state');
process.env.XDG_DATA_HOME = path.join(home, 'data');
process.env.XDG_CACHE_HOME = path.join(home, 'cache');
process.env.CODEX_HOME = path.join(home, 'codex');
process.env.OAK_MACHINE_LABEL = 'workstation';
process.env.HERDR_SOCKET_PATH = path.join(home, 'herdr.sock');
for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SESSION', 'OAK_TAB', 'TMUX']) delete process.env[key];
const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));
core.writePrefs({ color: 'truecolor', glyphs: 'unicode', mouse: false }); // --once emits truecolor in a pipe

let capture;
try {
if (!process.argv.includes('--renderer-only')) capture = await startCaptureServer(herdrBinary, home, ws);
const once = (session, tab = 'observatory') => {
  session ||= core.resolveSessionId(ws);
  if (!session) return null;
  if (process.argv.includes('--renderer-only')) return tab === 'observatory' ? demoFrame(ws, session, COLS, ROWS) : null;
  capture.seed(session);
  const args = ['tui', '--once', '--root', ws, '--no-mouse', '--tab', tab];
  if (session) args.push('--session', session);
  let frame;
  try {
    frame = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ws, encoding: 'utf8', env: { ...capture.env, COLUMNS: String(COLS), LINES: String(ROWS) },
    });
  } catch (error) { throw new Error('TUI media needs permission to execute the built CLI', { cause: error }); }
  return validateFrame(frame, { conversation: tab === 'observatory' });
};

// --- replay the demo, capturing a real frame at every beat ----------------------------------------
console.log('▸ replaying the demo, one --once frame per beat…');
const beats = [];
const res = await core.runDemo({
  fast: true, cwd: ws,
  log: (line) => { const f = once(null); if (f) beats.push({ cap: line.trim(), frame: f }); },
});
// a couple of settled end frames: the main session, then its sibling if the demo made one
beats.push({ cap: `✓ ${core.reviewUnits(res.session, 'pending').filter((u) => !u.cancelled).length} pending change(s) to review`, frame: once(res.session) });
if (res.sibling) beats.push({ cap: 'A second agent on demo/hotfix — siblings on one board', frame: once(res.sibling) });

// keep frames that actually rendered the app (a session banner, not the empty state), newest data wins
const real = beats.filter((b) => b.frame && /observatory/i.test(b.frame));
// sample down to ~12 evenly, always keeping the final settled frame
let picked = real;
const MAX = 12;
if (real.length > MAX) {
  const step = (real.length - 1) / (MAX - 1);
  picked = Array.from({ length: MAX }, (_, i) => real[Math.round(i * step)]);
}
console.log(`  ${beats.length} beats, ${real.length} with content, ${picked.length} frames kept`);


// The other two tabs around them: herdr first, where the agents run, and Review last, where each change is
// kept or undone. Both are the real app's frames, the herdr tab's from a private herdr server.
const herdr = process.argv.includes('--renderer-only') ? null
  : validateFrame(await capture.herdrFrame(CLI, res.session, COLS, ROWS), { herdr: true });
const review = once(res.session, 'review');
const shown = [
  ...(herdr ? [{ cap: 'The herdr tab: agents run in herdr, in its own tabs and panes, on this machine or a saved one', frame: herdr }] : []),
  ...picked,
  ...(review ? [{ cap: 'The Review tab: keep or undo each change the agent made', frame: review }] : []),
];

// --- emit docs/media/tui-frames.js ----------------------------------------------------------------
if (!picked.length) throw new Error('No TUI frames rendered; existing media was not replaced');
const data = shown.map((b) => ({ cap: b.cap, html: frameHtml(b.frame) }));
const outPath = path.join(ROOT, 'docs', 'media', 'tui-frames.js');
fs.writeFileSync(outPath, 'window.__OAK_TUI_FRAMES__=' + JSON.stringify(data) + ';\n');
console.log(`✓ docs/media/tui-frames.js — ${data.length} frames, ${(fs.statSync(outPath).size/1024).toFixed(0)} KB`);

// --- hermetic cleanup -----------------------------------------------------------------------------
} finally {
await capture?.stop();
core.cleanDemo({ cwd: ws });
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });
}
