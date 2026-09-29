const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'cli', 'dist', 'index.js');

// Files preserve child output in restricted runners whose pipe descriptors reject writes.
function runCli(home, args, options) {
  const out = path.join(home, 'stdout'), err = path.join(home, 'stderr');
  const fds = [fs.openSync(out, 'w'), fs.openSync(err, 'w')];
  let result;
  try { result = spawnSync(process.execPath, [CLI, ...args], { ...options, stdio: ['ignore', ...fds], timeout: 60_000 }); }
  finally { fds.forEach(fd => fs.closeSync(fd)); }
  return { ...result, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(err, 'utf8') };
}


// A FIRST RUN: a machine with no agent session at all — no Claude transcript, no Codex rollout — and a
// workspace nobody has worked in. `oak` must still open (the herdr tab is what starts a session), not
// exit with "could not resolve an active Claude Code session". Everything that could leak a real
// session in is isolated: HOME (Codex reads ~/.codex), the Claude config dir, herdr's config + socket.
test('first run: the TUI opens with no session on the machine', () => {
  assert.ok(fs.existsSync(CLI), `built CLI missing at ${CLI} — run the build first`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-first-run-'));
  const ws = path.join(home, 'ws');
  fs.mkdirSync(ws);
  try {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      XDG_CONFIG_HOME: path.join(home, 'config'),
      HERDR_SOCKET_PATH: path.join(home, 'herdr.sock'),
      CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1',
      COLUMNS: '100',
      LINES: '30',
    };
    delete env.CLAUDE_OBSERVATORY_SESSION;
    delete env.CLAUDE_CHANGES_SESSION;
    const r = runCli(home, ['tui', '--once', '--no-mouse', '--tab', 'observatory'], { cwd: ws, env });
    assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /could not resolve an active/, 'the first run must not demand a session');
    assert.match(r.stdout, /observatory/, 'renders the tab bar');
    assert.match(r.stdout, /no agent session yet/, 'says what is missing instead of failing');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The pinned path keeps its strictness: an explicit `--session` that resolves nowhere is still an error
// (a typo must not silently open an empty dashboard).
test('first run: an explicit --session that does not exist still fails loudly', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-first-run-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), XDG_CONFIG_HOME: path.join(home, 'config'), HERDR_SOCKET_PATH: path.join(home, 'herdr.sock'), CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', COLUMNS: '100', LINES: '30' };
    // Well-formed but absent: this must reach session RESOLUTION, not the syntactic validator.
    const r = runCli(home, ['tui', '--once', '--no-mouse', '--session', '00000000-0000-4000-8000-00000000dead'], { cwd: home, env });
    assert.notEqual(r.status, 0, 'an absent --session must not open an empty dashboard');
    assert.match(r.stderr, /no session "00000000-0000-4000-8000-00000000dead" on this machine/, 'the error names the id');
    const bad = runCli(home, ['tui', '--once', '--no-mouse', '--session', '../etc/passwd'], { cwd: home, env });
    assert.notEqual(bad.status, 0, 'a traversing id is still rejected');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// INSIDE a herdr pane (HERDR_PANE_ID set — the attach model) OAK has no herdr tab: herdr is the host,
// and a tab that could only say so was a dead tab the reader had to skip.
test('nested in herdr: the tab bar is observatory · review, no herdr tab', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-nested-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), XDG_CONFIG_HOME: path.join(home, 'config'), HERDR_SOCKET_PATH: path.join(home, 'herdr.sock'), CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', COLUMNS: '100', LINES: '30' };
    const bar = (extra) => {
      const r = runCli(home, ['tui', '--once', '--no-mouse', '--tab', 'observatory'], { cwd: home, env: { ...env, ...extra } });
      assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
      return r.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0];
    };
    const plain = bar({});
    assert.match(plain, /herdr/, 'from a plain terminal the herdr tab is offered');
    const nested = bar({ HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', HERDR_ENV: '1' });
    assert.doesNotMatch(nested, /herdr/, 'inside a herdr pane there is no herdr tab');
    assert.match(nested, /observatory/); assert.match(nested, /review/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ONE FRAME OF A PINNED CONVERSATION waits for the detail's second read — its workers, tasks and edit
// previews. It printed before that read landed, so every one-shot conversation said "Workers · 0",
// the published media included, while `oak subagents` listed the demo's worker.
test('one frame: a pinned conversation shows its workers and tasks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-once-detail-'));
  const ws = path.join(home, 'ws');
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
      HERDR_SOCKET_PATH: path.join(home, 'herdr.sock'), OAK_MACHINE_LABEL: 'workstation', OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
    for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'OAK_TAB']) delete env[key];
    const core = path.join(__dirname, '..', '..', 'core', 'dist');
    const seeded = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(core)}).runDemo({ fast: true, cwd: process.cwd(), log: () => {} }).then(r => console.log(r.session))`],
      { cwd: ws, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(seeded.status, 0, `demo: ${seeded.stderr}`);
    const session = seeded.stdout.trim();
    const workers = JSON.parse(runCli(home, ['subagents', '--json', '--session', session, '--root', ws], { cwd: ws, env }).stdout).subagents;
    assert.equal(workers.length, 1, 'the demo spawns one worker');
    const r = runCli(home, ['tui', '--once', '--no-mouse', '--no-color', '--tab', 'observatory', '--session', session, '--root', ws, '--cols', '120', '--rows', '50'], { cwd: ws, env });
    assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stdout, /Workers · \d\/1 active/, 'the frame counts the worker');
    assert.match(r.stdout, /Tasks · \d+\/[1-9]\d* open/, 'and the plan');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
