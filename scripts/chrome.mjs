import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import pngjs from 'pngjs';

const { PNG } = pngjs;

/** Use the explicit override, then the usual Linux executables and macOS bundle. */
export function resolveChrome(env = process.env) {
  const candidates = env.CHROME_BIN ? [env.CHROME_BIN] : [
    ...['google-chrome', 'chromium'].flatMap(name => (env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, name))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch {}
  }
  throw new Error('Chrome/Chromium is unavailable; set CHROME_BIN to an executable browser path.');
}

/** Chrome keeps a Unix socket under TMPDIR and dies with SIGTRAP when that path is too long (measured:
 *  a TMPDIR of 60 characters works, 66 does not), so a longer one is replaced by /tmp for the browser. */
const browserEnv = () => (process.platform === 'win32' || tmpdir().length <= 60 ? process.env : { ...process.env, TMPDIR: '/tmp' });

/** Headless Chrome lays a page out in a viewport shorter than `--window-size` (87 CSS px in Chrome 138)
 *  and paints nothing below it, so a screenshot loses that much of the page at the bottom. Measured once
 *  per run, from a page that prints its own height, with the flags the capture uses. */
let viewportLoss;
function measureViewportLoss(chrome, args, width, height) {
  const flags = args.filter(a => a.startsWith('--') && !a.startsWith('--window-size=') && !a.startsWith('--screenshot'));
  const dom = execFileSync(chrome, [...flags, `--window-size=${width},${height}`, '--dump-dom', 'data:text/html,<script>document.write(innerHeight)</script>'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, env: browserEnv() });
  const inner = Number(/<body>(\d+)/.exec(dom)?.[1]);
  if (!Number.isFinite(inner)) throw new Error('could not measure the headless viewport');
  return Math.max(0, height - inner);
}

/** Keep the top `height` CSS px of a screenshot taken `width` CSS px wide, at whatever scale it has. */
function cropToHeight(bytes, width, height) {
  const png = PNG.sync.read(bytes);
  const rows = Math.round((height * png.width) / width);
  if (rows >= png.height) return bytes;
  const out = new PNG({ width: png.width, height: rows });
  png.data.copy(out.data, 0, 0, png.width * rows * 4);
  return PNG.sync.write(out);
}

/** Never replace published media with empty output, or reuse a stale screenshot after failure. A
 *  `--window-size=W,H` capture comes back as the full W×H page: the window opens taller by the viewport
 *  loss, and the image is cropped back to H. */
export function capturePng(chrome, args) {
  const dir = mkdtempSync(join(tmpdir(), 'oak-media-'));
  const file = join(dir, 'frame.png');
  try {
    const size = args.find(a => a.startsWith('--window-size='));
    const [width, height] = size ? size.slice('--window-size='.length).split(',').map(Number) : [];
    if (size) viewportLoss ??= measureViewportLoss(chrome, args, width, height);
    const run = size ? args.map(a => (a === size ? `--window-size=${width},${height + viewportLoss}` : a)) : args;
    execFileSync(chrome, [...run, `--screenshot=${file}`], { stdio: 'pipe', timeout: 60000, env: browserEnv() });
    const bytes = readFileSync(file);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('Chrome returned an empty or invalid PNG; existing media was not replaced.');
    return size && viewportLoss > 0 ? cropToHeight(bytes, width, height) : bytes;
  } catch (error) {
    throw new Error(`Media capture failed; check CHROME_BIN and browser permissions (${error.message}).`, { cause: error });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A scene is as tall as its window, so trim the black under the window to the margin above it. A capture
 *  with less room than that below the window may have cut it off (a scene drawn straight onto the black
 *  can end between two rows), so it fails, and the scene's height in SIZE grows. */
export function fitToContent(bytes, name = 'scene') {
  const png = PNG.sync.read(bytes), { width, height, data } = png;
  const lit = y => { for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (data[i] + data[i + 1] + data[i + 2] > 10) return true; } return false; };
  let top = 0; while (top < height && !lit(top)) top++;
  let bottom = height - 1; while (bottom > top && !lit(bottom)) bottom--;
  if (bottom >= height - 1 || bottom + 1 + top > height) throw new Error(`${name}: the window does not fit its capture with a margin below it — raise its height in SIZE`);
  const out = new PNG({ width, height: bottom + 1 + top });
  data.copy(out.data, 0, 0, width * out.height * 4);
  return PNG.sync.write(out);
}
