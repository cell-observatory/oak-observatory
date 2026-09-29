// Render high-res screenshots of the REAL TUI, one per root tab, for the docs sub-pages.
//
// Same hermetic pipeline as build-tui-demo.mjs: a scripted demo through the real capture stack in a
// throwaway HOME + workspace, then `oak tui --once --tab <id>` for each tab, truecolor forced through
// prefs. Each frame's ANSI is converted to HTML spans, rendered in headless Chrome at 2x, and trimmed
// to its content box with pngjs. Rendering the real binary — not a mockup — is the point: a docs
// screenshot that drifts from the product is a claim nobody can check.
//
// Usage: node scripts/build-tui-shots.mjs        (requires a built core/cli + google-chrome)
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { frameHtml } from './ansi-html.mjs';
import { startCaptureServer, validateFrame } from './tui-capture.mjs';
import { resolveChrome, capturePng } from './chrome.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));

let CHROME;
try { CHROME = resolveChrome(); }
catch (error) { console.error(error.message); process.exit(1); }

// --- hermetic demo home + workspace (never touches real sessions) ---------------------------------
const herdrBinary = require(path.join(ROOT, 'packages/core/dist')).findHerdrBin();
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
core.writePrefs({ color: 'truecolor', glyphs: 'unicode', mouse: false });

let capture;
try {
capture = await startCaptureServer(herdrBinary, home, ws);
const once = (session, tab, cols, rows) => {
  capture.seed(session);
  const args = ['tui', '--once', '--root', ws, '--no-mouse', '--tab', tab, '--cols', String(cols), '--rows', String(rows)];
  if (session) args.push('--session', session);
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd: ws, encoding: 'utf8', env: { ...capture.env, COLUMNS: String(cols), LINES: String(rows) },
    });
  } catch (error) { throw new Error('TUI screenshot needs permission to execute the built CLI', { cause: error }); }
};

console.log('▸ replaying the demo to populate a hermetic store…');
const res = await core.runDemo({ fast: true, cwd: ws, log: () => {} });
const session = res.session;
capture.seed(session);
if (res.sibling) capture.seed(res.sibling);


// --- trim a uniform-background border with pngjs --------------------------------------------------
function trim(buf, bg = [13,13,16], slack = 26) {
  const png = PNG.sync.read(buf), { width:W, height:H, data } = png;
  const near = (i) => Math.abs(data[i]-bg[0])+Math.abs(data[i+1]-bg[1])+Math.abs(data[i+2]-bg[2]) < 24;
  const rowBlank = (y) => { for (let x=0;x<W;x++) if(!near((y*W+x)*4)) return false; return true; };
  const colBlank = (x) => { for (let y=0;y<H;y++) if(!near((y*W+x)*4)) return false; return true; };
  let top=0,bot=H-1,left=0,right=W-1;
  while(top<bot && rowBlank(top)) top++;
  while(bot>top && rowBlank(bot)) bot--;
  while(left<right && colBlank(left)) left++;
  while(right>left && colBlank(right)) right--;
  top=Math.max(0,top-slack); left=Math.max(0,left-slack);
  bot=Math.min(H-1,bot+slack); right=Math.min(W-1,right+slack);
  const w=right-left+1, h=bot-top+1, out=new PNG({ width:w, height:h });
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const s=((top+y)*W+(left+x))*4, d=(y*w+x)*4;
    out.data[d]=data[s]; out.data[d+1]=data[s+1]; out.data[d+2]=data[s+2]; out.data[d+3]=255;
  }
  return PNG.sync.write(out);
}


const TABS = [
  { id: 'observatory', out: 'tui-observatory', cols: 120, rows: 34 },
  { id: 'review',      out: 'tui-review',      cols: 128, rows: 52 },
  // herdr is a real native terminal; capture it with --herdr in an unrestricted terminal.
  ...(process.argv.includes('--herdr') ? [{ id: 'herdr', out: 'tui-herdr', cols: 120, rows: 34 }] : []),
];

for (const t of TABS) {
  const frame = t.id === 'herdr' ? await capture.herdrFrame(CLI, session, t.cols, t.rows) : once(session, t.id, t.cols, t.rows);
  validateFrame(frame, { conversation: t.id === 'observatory', herdr: t.id === 'herdr' });
  if (!frame.includes('\x1b')) throw new Error(`${t.id}: no styled TUI frame; existing media was not replaced`);
  // JetBrains Mono via webfont (it is not installed on every render box) and line-height 1:
  // the site's interactive demo uses the same pair, and any taller line box opens a gap between
  // rows that breaks every │ pane border into dashes — a terminal's cell height IS its line height.
  const html = `<!doctype html><meta charset="utf8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    html,body{margin:0;background:#0d0d10}
    pre{margin:0;padding:26px 30px;display:inline-block;
      font:16px/1 "JetBrains Mono","DejaVu Sans Mono","Menlo",monospace;
      color:#c9cdd3;background:#0d0d10;font-variant-ligatures:none;letter-spacing:0}
  </style><pre>${frameHtml(frame)}</pre>`;
  const htmlPath = path.join(home, `tuishot-${t.id}.html`);
  fs.writeFileSync(htmlPath, html);
  // --virtual-time-budget makes the screenshot wait for the webfont fetch; without it the shot
  // races the font load and silently renders the fallback.
  const raw = capturePng(CHROME, [ '--headless','--disable-gpu','--no-sandbox',
    '--ozone-platform=headless','--hide-scrollbars','--force-device-scale-factor=2',
    '--window-size=1500,1100','--virtual-time-budget=10000',
    'file://'+htmlPath]);
  const trimmed = trim(raw);
  const outPath = path.join(ROOT, 'docs', 'media', t.out + '.png');
  fs.writeFileSync(outPath, trimmed);
  const dim = PNG.sync.read(trimmed);
  console.log(`✓ ${t.out}.png — ${dim.width}×${dim.height}, ${(trimmed.length/1024).toFixed(0)} KB`);
}

} finally {
await capture?.stop();
core.cleanDemo({ cwd: ws });
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });
}
