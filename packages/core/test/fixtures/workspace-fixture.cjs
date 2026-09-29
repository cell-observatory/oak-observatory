/* The conversation fixtures are recorded at /workspace. A test puts them under its own root, and that
 * has to stay valid JSON at every depth (a Codex call's `arguments` is JSON inside a JSON string) and
 * name the platform's own paths. Spliced into the text raw, a Windows root is `C:\Users\…`: an invalid
 * JSON escape, so every line was dropped on the Windows runner and the tests saw an empty transcript. */
const fs = require('node:fs');
const path = require('node:path');

function rooted(value, root) {
  if (typeof value === 'string') {
    if (/^[[{]/.test(value)) {
      try { return JSON.stringify(rooted(JSON.parse(value), root)); } catch { /* text that only looks like JSON */ }
    }
    return value.replace(/\/workspace((?:\/[^\s"'\\/]+)*)/g, (_, rest) => path.join(root, ...rest.split('/')));
  }
  if (Array.isArray(value)) return value.map(v => rooted(v, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rooted(v, root)]));
  return value;
}

/** The fixture's text with /workspace moved to `root`, one JSON record per line as recorded. */
function workspaceFixture(name, root) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8').split('\n')
    .map(line => line && JSON.stringify(rooted(JSON.parse(line), root))).join('\n');
}

module.exports = { workspaceFixture };
