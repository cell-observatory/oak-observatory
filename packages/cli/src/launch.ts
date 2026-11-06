/**
 * The `oak` bin (built unbundled to dist/index.js). The capture hooks run `oak capture` around every
 * tool call, so that command loads only the capture bundle instead of compiling the whole CLI,
 * terminal app included: 40 ms per hook against 77 ms (measured 2026-09-26). Everything else, and
 * `oak capture --help`, is the full CLI in dist/cli.js. The installed hook command is unchanged.
 *
 * Node's compile cache keeps what V8 compiled of either bundle, in this user's cache folder (never the store, and never
 * a folder other users write, as /tmp is), so a start after the first compiles neither bundle again. Node checks each
 * entry against its file's content, so a bundle an update replaced is compiled anew, never run from the cache. A relative
 * XDG_CACHE_HOME is ignored, as the XDG spec has it, and so is a home that is not an absolute path (HOME set empty): either
 * would put a cache in each folder a hook runs in. Only into a cache folder that is there, or made here, and writable:
 * Node makes the rest of the path itself, and its recursive mkdir never returns under a folder that answers ENOENT to a
 * mkdir (one of /proc). `oak uninstall` names the same folder.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
const old = major < 22 || major === 23 || (major === 22 && minor < 16);
const capture = process.argv[2] === 'capture' && !process.argv.includes('--help') && !process.argv.includes('-h');
if (old) {
  process.stderr.write(`oak: needs Node.js 22 (22.16 or newer) or 24 or newer; found ${process.version}. Install a supported Node and re-run.\n`);
  // The capture hooks keep recording (exit 0, never blocking the agent's tool call): the capture bundle runs on the Node
  // 0.10 supported (20 and newer), so an update that lands on an older Node does not silently stop recording edits
  // (review 2026-11-05). Everything else refuses, before the compile cache.
  if (!capture) process.exit(1);
}
const fs = require('fs');
const path = require('path');
const xdg = process.env.XDG_CACHE_HOME;
if (!old) try {
  const cache = xdg && path.isAbsolute(xdg) ? xdg : path.join(require('os').homedir(), '.cache');
  if (path.isAbsolute(cache)) {
    if (!fs.existsSync(cache)) fs.mkdirSync(cache);
    fs.accessSync(cache, fs.constants.W_OK);
    require('module').enableCompileCache?.(path.join(cache, 'oak', 'compile-cache'));
  }
} catch {
  /* no cache folder here (a home that cannot be written, or none at all): every start compiles, as before */
}
require(capture ? './capture.js' : './cli.js');
