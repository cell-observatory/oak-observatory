// Keep fixtures private, and keep repository discovery inside that fixture boundary.
// Merely nesting mkdtemp under /tmp does not help: repoRoot walks all the way to /.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Unix socket paths are capped at 104 bytes on macOS and 108 on Linux, and the suite binds sockets up to 84
// bytes below the directory that holds the run's root (that root, a root per test file, a fixture, then
// OAK's store). A macOS runner's TMPDIR is 56 characters, which put them past the cap (`listen EINVAL`), so
// the run's root goes in /tmp. Where /tmp is read-only or mounted noexec (the suite runs scripts it writes
// under the root), the root stays in TMPDIR. Each test file's process nests its root inside the run's, the
// TMPDIR it inherits, so the run's exit removes both.
const inherited = os.tmpdir();
const makeRoot = (parent) => fs.realpathSync(fs.mkdtempSync(path.join(parent, 'oak-tests-')));
function rootInTmp() {
  let root = null;
  try {
    root = makeRoot('/tmp');
    const probe = path.join(root, 'probe');
    fs.writeFileSync(probe, '', { mode: 0o755 });
    fs.accessSync(probe, fs.constants.X_OK); // EACCES on a noexec mount
    fs.rmSync(probe);
    return root;
  } catch {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    return null;
  }
}
const nested = process.platform === 'win32' || path.basename(inherited).startsWith('oak-tests-');
const temporaryRoot = (!nested && rootInTmp()) || makeRoot(inherited);
for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = temporaryRoot;

// Running the suite from INSIDE a herdr pane leaks its pane markers into every spawned test process;
// tests that render OAK's herdr tab expect the NON-nested case, so clear them for determinism. A test
// that needs a pane context sets these itself. HERDR_BIN_PATH and HERDR_SESSION name the live install
// and pick its socket; neither belongs to a test either.
for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'HERDR_SESSION']) delete process.env[key];

// The store and herdr's socket are ISOLATED for the whole run. Tests that spread the real core
// (the observatory runtime's fakeRuntime) reached the real store: one gate run wrote fixture
// machines into ~/.claude/claude-observatory/herdr-tabs.json and wiped OAK's tab ownership on
// this machine, after which no live tab was ever renamed again (TUI sweep, 2026-09-23). And the
// live herdr PTY probe attached a client to a person's running session on every `npm test`. A test
// that wants the real server opts in with OAK_LIVE_HERDR=1; everything else talks to a socket that
// does not exist and fails fast.
process.env.CLAUDE_CONFIG_DIR = path.join(temporaryRoot, 'claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
// Codex's home too: an Observatory test read the developer's real rollouts through the real reader.
process.env.CODEX_HOME = path.join(temporaryRoot, 'codex');
// herdr's config dir decides its default socket, so a test that drops HERDR_SOCKET_PATH still lands in
// the private root, never on the live server under the real ~/.config.
if (process.env.OAK_LIVE_HERDR !== '1') {
  process.env.HERDR_SOCKET_PATH = path.join(temporaryRoot, 'no-herdr.sock');
  process.env.XDG_CONFIG_HOME = path.join(temporaryRoot, 'config');
}

// Hide only ancestor markers, never a .git created by a test inside the private root.
// Both Git and core's filesystem-only discovery should see the same boundary.
process.env.GIT_CEILING_DIRECTORIES = [temporaryRoot, process.env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
const ancestorMarkers = new Set();
for (let dir = path.dirname(temporaryRoot); ; dir = path.dirname(dir)) {
  ancestorMarkers.add(path.join(dir, '.git'));
  if (path.dirname(dir) === dir) break;
}
const existsSync = fs.existsSync;
fs.existsSync = function (file) {
  if (typeof file === 'string' && ancestorMarkers.has(path.resolve(file))) return false;
  return existsSync.call(this, file);
};

// A detached background child (the account pull and title refresh `oak usage` starts) can outlive this
// process, in a HOME a test put under this root, and while it runs Windows refuses to remove that
// directory (EBUSY). The retries wait it out, 100 ms longer each time, 5.5 s at most. A child that runs
// longer still (Node 20 and 22 on the Windows runner) leaves the root behind rather than failing the
// file; the runner discards its temp dir. Anything else, and every error off Windows, still throws.
process.on('exit', () => {
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10 });
  } catch (error) {
    if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error && error.code)) throw error;
    process.stderr.write(`test cleanup: left ${temporaryRoot} (${error.code}: a detached child still runs there)\n`);
  }
});
module.exports = { temporaryRoot };
