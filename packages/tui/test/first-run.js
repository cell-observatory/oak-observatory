const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitDir: makeGitDir } = require('../../../test/fixtures/git.cjs');

const CLI = path.join(__dirname, '..', '..', 'cli', 'dist', 'index.js');

// tty-retry: the first process-table read fails, which decides nothing; the app asks again and settles on the pane.
for (const scenario of ['valid', 'tty', 'tty-retry', 'stale', 'foreign', 'timeout']) test(`pane context PTY: ${scenario} paints first, then gates F1 and client input`, { skip: process.platform === 'win32' }, async t => {
  const pty = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-pane-pty-'));
  // Cleanup runs in registration order and stops at the first throw: removing home first, while the app still wrote to it,
  // threw ENOTEMPTY and skipped the kill and the server's stop, so a failing run hung the suite. Stop the app, then remove.
  const served = scenario === 'tty-retry' ? 'tty' : scenario;
  const server = await require('../../core/test/fixtures/pane-context.cjs')(t, home, served, { awaitPid: true });
  const marker = path.join(home, 'client-env');
  const binary = path.join(home, 'herdr');
  if (scenario === 'tty-retry') {
    const ps = spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(home, 'ps'), `#!/bin/sh\nif [ "$*" = "-axo pid=,ppid=,tty=" ] && [ ! -e "$HOME/ps-failed" ]; then : > "$HOME/ps-failed"; exit 1; fi\nexec ${ps} "$@"\n`, { mode: 0o755 });
  }
  // The client's marker appears whole (written aside, then renamed): the test waits for it to exist, and once read a
  // file the shell had made but not yet written, on a loaded runner.
  fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "herdr 0.9.1"; exit; fi\nif [ "$#" != 0 ]; then echo "[]"; exit; fi\nprintf "%s|%s|%s|%s" "$HERDR_PANE_ID" "$HERDR_TAB_ID" "$HERDR_WORKSPACE_ID" "$HERDR_ENV" > "$PANE_CLIENT_LOG.part" && mv "$PANE_CLIENT_LOG.part" "$PANE_CLIENT_LOG"\nwhile IFS= read -r line; do :; done\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'),
    XDG_CONFIG_HOME: path.join(home, 'config'), HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', HERDR_ENV: '1',
    HERDR_BIN_PATH: binary, PATH: home + path.delimiter + process.env.PATH, PANE_CLIENT_LOG: marker, OAK_NO_BACKGROUND: '1', OAK_NO_SERVER: '1', TERM: 'xterm-256color' };
  const terminal = new Terminal({ cols: 110, rows: 30, allowProposedApi: true });
  const child = pty.spawn(process.execPath, [CLI, 'tui', '--no-mouse', '--tab', 'observatory'], { cols: 110, rows: 30, cwd: home, env });
  // Registered at once: a failure anywhere after the spawn must still stop the app before its folder is removed.
  t.after(async () => {
    // SIGHUP first, which the app handles by stopping its own children; then the whole group, for anything left.
    const exited = new Promise(resolve => child.onExit(() => resolve()));
    try { child.kill(); } catch { /* already gone */ }
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group has ended */ }
    terminal.dispose();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  let firstPaint = 0;
  child.onData(data => {
    terminal.write(data, () => {
      if (!firstPaint && /F[123]/.test(data)) firstPaint = Date.now();
    });
  });
  const until = async predicate => { for (const end = Date.now() + 6000; !predicate() && Date.now() < end;) await new Promise(r => setTimeout(r, 20)); assert.ok(predicate()); };
  await until(() => firstPaint && server.calls().some(c => c.method === 'pane.process_info'));
  const row = () => terminal.buffer.active.getLine(0)?.translateToString(true) ?? '';
  assert.match(row(), /F1 herdr/, 'first frame precedes the membership answer');
  // On macOS spawn returns before spawn-helper acquires the controlling tty. The first frame proves
  // that helper has exec'd the app; only now can ps supply the pane's tty to the waiting server.
  const tty = spawnSync('ps', ['-p', String(child.pid), '-o', 'tty='], { encoding: 'utf8' }).stdout.trim();
  assert.ok(tty && !/^[?\-]+$/.test(tty), `the painted child has a controlling tty: ${JSON.stringify(tty)}`);
  server.update({ pid: child.pid, ...(served === 'tty' ? { tty: `/dev/${tty}` } : {}) });
  const nested = scenario === 'valid' || served === 'tty';
  if (nested) await until(() => !row().includes('herdr'));
  else { await new Promise(r => setTimeout(r, 600)); assert.match(row(), /F1 herdr/); }
  child.write('\x1bOP'); // F1
  if (nested) {
    await new Promise(r => setTimeout(r, 100));
    assert.equal(fs.existsSync(marker), false, 'F1 starts no client and sends no keys inside a confirmed pane');
  } else {
    await until(() => fs.existsSync(marker));
    assert.equal(fs.readFileSync(marker, 'utf8'), '|||', 'the available client inherits no stale pane markers');
  }
  assert.equal(server.calls().filter(c => c.method === 'pane.process_info').length, scenario === 'tty-retry' ? 2 : 1);
  if (scenario === 'tty-retry') assert.ok(fs.existsSync(path.join(home, 'ps-failed')), 'the first process-table read failed');
  assert.equal(server.calls().filter(c => /send|prompt/.test(c.method)).length, 0, 'an inherited pane is never a key destination');
});

test('agent setup suggestion: one-frame reads do not consume the first interactive notice', async t => {
  let pty;
  try { pty = require('node-pty'); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return t.skip('node-pty unavailable'); throw error; }
  if (process.platform === 'win32') return t.skip('the PTY fixture runs on POSIX');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-setup-notice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), HERDR_SOCKET_PATH: path.join(home, 'missing.sock'), OAK_NO_SERVER: '1', OAK_NO_BACKGROUND: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', TERM: 'xterm-256color' };
  for (const k of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_BIN_PATH', 'CLAUDE_OBSERVATORY_SESSION', 'CLAUDE_CHANGES_SESSION']) delete env[k];
  const once = runCli(home, ['tui', '--once', '--no-mouse', '--tab', 'observatory'], { cwd: home, env });
  assert.equal(once.status, 0, once.stderr);
  const marker = path.join(home, '.claude/claude-observatory/agent-setup-suggested');
  assert.equal(fs.existsSync(marker), false, 'a noninteractive frame never consumes the notice');
  async function launch(expectNotice) {
    let raw = '';
    const child = pty.spawn(process.execPath, [CLI, 'tui', '--tab', 'observatory', '--no-mouse'], { cols: 140, rows: 30, cwd: home, env, name: 'xterm-256color' });
    const exited = new Promise(resolve => child.onExit(resolve));
    child.onData(d => { raw += d; });
    let hung = false;
    try {
      const until = Date.now() + 8000;
      while (Date.now() < until && !(expectNotice ? raw.includes('oak agent setup') : raw.includes('no agent session yet'))) await new Promise(r => setTimeout(r, 50));
      if (expectNotice) assert.match(raw, /oak agent setup/);
      else { assert.match(raw, /no agent session yet/); assert.doesNotMatch(raw, /oak agent setup/); }
    } finally {
      // Wait for the exit before the next launch or the folder's removal: between the hangup and its exit the app can
      // still write its index into the folder, and the removal then failed with ENOTEMPTY (2026-11-10).
      child.kill();
      hung = await Promise.race([exited.then(() => false), new Promise(r => setTimeout(r, 5000, true))]);
      if (hung) { child.kill('SIGKILL'); await exited; }
    }
    assert.equal(hung, false, 'the app ends within 5 s of a hangup');
  }
  await launch(true);
  assert.ok(fs.existsSync(marker));
  await launch(false);
});

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

// INSIDE a confirmed herdr pane (the attach model) OAK has no herdr tab: herdr is the host,
// and a tab that could only say so was a dead tab the reader had to skip.
test('nested in herdr: the tab bar is observatory · review, no herdr tab', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-nested-'));
  // The pane's process is the app itself: Windows has no process table to find this test's process above it, only the
  // pid herdr names. So the app starts before the pane is answered for, and the answer names it.
  const herdr = await require('../../core/test/fixtures/pane-context.cjs')(t, home, 'valid', { awaitPid: true });
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), XDG_CONFIG_HOME: path.join(home, 'config'), HERDR_SOCKET_PATH: path.join(home, 'herdr.sock'), CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', COLUMNS: '100', LINES: '30' };
    const bar = async (extra) => {
      const out = path.join(home, 'stdout'), err = path.join(home, 'stderr');
      const fds = [fs.openSync(out, 'w'), fs.openSync(err, 'w')];
      let status;
      try {
        const child = require('node:child_process').spawn(process.execPath, [CLI, 'tui', '--once', '--no-mouse', '--tab', 'observatory'],
          { cwd: home, env: { ...env, ...extra }, stdio: ['ignore', ...fds], timeout: 60_000 });
        herdr.update({ pid: child.pid });
        status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      } finally { fds.forEach(fd => fs.closeSync(fd)); }
      assert.equal(status, 0, `exit ${status}; stderr: ${fs.readFileSync(err, 'utf8')}`);
      return fs.readFileSync(out, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0];
    };
    const plain = await bar({});
    assert.match(plain, /herdr/, 'from a plain terminal the herdr tab is offered');
    const nested = await bar({ HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', HERDR_ENV: '1' });
    assert.doesNotMatch(nested, /herdr/, 'inside a herdr pane there is no herdr tab');
    assert.match(nested, /observatory/); assert.match(nested, /review/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ONE FRAME OF A PINNED CONVERSATION waits for the detail's second read — its workers, tasks and edit
// previews. It printed before that read landed, so every one-shot conversation said "Workers · 0",
// the published media included, while `oak subagents` listed the demo's worker.
// A status the app writes is held over the size note for a few seconds (an answer to a key), but one
// frame answers no key: `--once` too small for its panes still says what they need.
test('one frame: too small a frame names what its panes need, over the status', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-once-small-'));
  const ws = path.join(home, 'ws');
  makeGitDir(path.join(ws, '.git'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'),
      XDG_CONFIG_HOME: path.join(home, 'config'), HERDR_SOCKET_PATH: path.join(home, 'herdr.sock'), OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
    for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'OAK_TAB']) delete env[key];
    const r = runCli(home, ['tui', '--once', '--no-mouse', '--no-color', '--tab', 'review', '--cols', '40', '--rows', '8'], { cwd: ws, env });
    assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stdout, /^at this size: \S+ needs \d+ cols/m, r.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('one frame: a pinned conversation shows its workers and tasks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-once-detail-'));
  const ws = path.join(home, 'ws');
  makeGitDir(path.join(ws, '.git'));
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

// `oak tui --root <dir>` reviews <dir>'s session. The launch resolved the session of the directory it was
// started FROM, so a frame named for one workspace showed another's session.
test('one frame: --root names the session, not the launch directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-once-root-'));
  const wsA = path.join(home, 'a'), wsB = path.join(home, 'b');
  makeGitDir(path.join(wsA, '.git'));
  makeGitDir(path.join(wsB, '.git'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
      HERDR_SOCKET_PATH: path.join(home, 'herdr.sock'), OAK_MACHINE_LABEL: 'workstation', OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
    for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'OAK_TAB', 'CLAUDE_OBSERVATORY_SESSION', 'CLAUDE_CHANGES_SESSION']) delete env[key];
    const core = path.join(__dirname, '..', '..', 'core', 'dist');
    const seed = (cwd) => {
      const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(core)}).runDemo({ fast: true, cwd: process.cwd(), log: () => {} }).then(r => console.log(r.session))`],
        { cwd, env, encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, `demo: ${r.stderr}`);
      return r.stdout.trim();
    };
    const a = seed(wsA), b = seed(wsB);
    assert.notEqual(a.slice(0, 8), b.slice(0, 8));
    const r = runCli(home, ['tui', '--once', '--no-mouse', '--no-color', '--tab', 'review', '--root', wsA, '--cols', '140', '--rows', '30'], { cwd: wsB, env });
    assert.equal(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(a.slice(0, 8)), `the frame reviews the --root workspace's session ${a}`);
    assert.ok(!r.stdout.includes(b.slice(0, 8)), `not the launch directory's session ${b}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The interactive app with no session at launch adopts the first one to appear. Under `--root` that is the
// named workspace's own session: the adoption asked for the newest session anywhere outside a repo. The same
// holds for the newer session it hints at and the one it moves to after the reader deletes the reviewed one.
for (const form of ['separate', 'inline']) test(`--root (${form}): every session the app picks on its own is the named workspace's`, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'root-probe.cjs'), form], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const { named, calls, adopted, hint, deleted, after } = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{')));
  assert.deepEqual([...new Set(calls.map(([step]) => step))], ['launch', 'newer', 'delete'], 'control: each step looked for a session');
  assert.deepEqual(calls, calls.map(([step]) => [step, named, true]), 'always the named workspace, as named');
  assert.equal(adopted, 'root-first', 'the first session is adopted');
  assert.equal(hint, 'a newer session is live — press b to switch');
  assert.deepEqual(deleted, ['root-first']);
  assert.equal(after, 'root-newer', 'the deleted session gives way to the workspace\'s newest');
});

// The interactive app with no session adopts the first one to appear. A session listing read before the adoption (the poll
// lists every session while there is none) landed after it, once the adoption had cleared the views for the session's own read,
// and so did a rerun of it asked for before the adoption: Review drew that listing alone as "… has no data to draw" until the
// session's own read came (reproduced live with a listing slowed to 1.5 s, as on a large store). Both are dropped now.
test('the first session adopted: a session listing read before it does not stand in for its own read', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'listing-race-probe.cjs')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const { before, adopted, stale, rerun, listings, landed } = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{')));
  assert.deepEqual(before, { says: 'no session to review', listings: [''] }, 'control: with no session, every session is listed');
  assert.deepEqual([adopted.session, adopted.views, adopted.says, adopted.asked], ['fresh-session', 'none', 'building…', ['fresh-session']]);
  assert.deepEqual(stale, { views: 'none', says: 'building…' }, 'the listing read before the adoption is dropped');
  assert.deepEqual(rerun, { views: 'none', says: 'building…' });
  assert.deepEqual(listings, [''], 'and none is read for the adopted session: its own read lists the sessions');
  assert.match(landed.views, /\blist\b/, 'control: the session\'s own read lands');
});

// A FOLDER WITH NO SESSION OF ITS OWN (a fresh repository) on a machine that has sessions elsewhere: the Observatory lists
// every session, as it does from a folder with one, and Review says it has nothing to review. The live app listed none
// there (its poll read nothing without a session) while its status said it listed every session, and Review said
// "building…" for good.
test('a folder with no session: the Observatory lists every session, and Review says there is nothing to review', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-no-session-')));
  const ws = path.join(home, 'ws'), repo = path.join(home, 'repo'), bin = path.join(home, 'bin');
  for (const dir of [ws, repo]) makeGitDir(path.join(dir, '.git'));
  fs.mkdirSync(bin);
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
      HERDR_SOCKET_PATH: path.join(home, 'herdr.sock'), OAK_MACHINE_LABEL: 'workstation', OAK_NO_SERVER: '1', OAK_NO_BACKGROUND: '1',
      CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', PATH: bin + path.delimiter + process.env.PATH, TERM: 'xterm-256color' };
    for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'OAK_TAB', 'TMUX', 'CLAUDE_OBSERVATORY_SESSION', 'CLAUDE_CHANGES_SESSION']) delete env[key];
    // A herdr that knows no machine and draws nothing: the app reads no real herdr.
    fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}\nprocess.stdout.write('[]\\n');\n`, { mode: 0o755 });
    // One session in the other workspace, with an edit pending review, as the capture hooks record it.
    const projects = path.join(env.CLAUDE_CONFIG_DIR, 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, 'elsewhere-session.jsonl'), JSON.stringify({ type: 'user', sessionId: 'elsewhere-session', cwd: ws,
      timestamp: new Date().toISOString(), message: { role: 'user', content: 'tidy the parser' } }) + '\n');
    const file = path.join(ws, 'a.ts');
    fs.writeFileSync(file, 'one\n');
    const hook = (event) => spawnSync(process.execPath, [path.join(path.dirname(CLI), 'capture.js')], { env, timeout: 30_000,
      input: JSON.stringify({ session_id: 'elsewhere-session', cwd: ws, hook_event_name: event, tool_name: 'Edit', tool_input: { file_path: file } }) });
    hook('PreToolUse'); fs.writeFileSync(file, 'two\n'); hook('PostToolUse');
    // One frame of each tab.
    const once = (tab) => runCli(home, ['tui', '--once', '--no-mouse', '--no-color', '--tab', tab, '--cols', '120', '--rows', '24'], { cwd: repo, env });
    const obs = once('observatory');
    assert.equal(obs.status, 0, obs.stderr);
    assert.match(obs.stdout, /earlier · 1/, 'the other workspace\'s session, folded as every quiet one but the watched one is');
    assert.match(obs.stdout, /no agent session in this workspace yet/);
    // `--root` names the workspace, a repository or not.
    const plain = path.join(home, 'plain');
    fs.mkdirSync(plain);
    const rooted = runCli(home, ['tui', '--once', '--no-mouse', '--no-color', '--tab', 'observatory', '--root', plain, '--cols', '120', '--rows', '24'], { cwd: home, env });
    assert.equal(rooted.status, 0, rooted.stderr);
    assert.match(rooted.stdout, /no agent session in this workspace yet/);
    const review = once('review');
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /no session to review — b picks one, or select one in the Observatory/);
    assert.doesNotMatch(review.stdout, /building…|did not arrive/);
    // The live app, in a terminal.
    let pty, Terminal;
    try { pty = require('node-pty'); ({ Terminal } = require('@xterm/headless')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    if (!pty || process.platform === 'win32') return;
    const term = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
    const child = pty.spawn(process.execPath, [CLI, 'tui', '--tab', 'observatory', '--tick', '3600'], { cols: 120, rows: 30, cwd: repo, env, name: 'xterm-256color' });
    const exited = new Promise((resolve) => child.onExit(resolve));
    child.onData((d) => term.write(d));
    const screen = () => new Promise((resolve) => term.write('', () => {
      const b = term.buffer.active;
      resolve(Array.from({ length: 30 }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true) ?? '').join('\n'));
    }));
    const until = async (re) => { for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (re.test(await screen())) return; };
    try {
      await until(/earlier · 1/);
      assert.match(await screen(), /earlier · 1/, 'the Observatory lists it at launch');
      // Listed, the app is idle: a read of the listing starts no other. Asking again whenever the listing changed the
      // Observatory's facts read it in a loop (0.83 s of CPU in 3 idle seconds, against none).
      if (process.platform === 'linux') {
        const cpu = () => { const f = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100; };
        const before = cpu();
        await new Promise((r) => setTimeout(r, 3000));
        assert.ok(cpu() - before < 0.3, `the app spent ${(cpu() - before).toFixed(2)} s of CPU in 3 idle seconds`);
      }
      child.write('\t');
      await until(/no session to review/);
      assert.match(await screen(), /no session to review — b picks one, or select one in the Observatory/);
    } finally {
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  } finally {
    // The home was removed while something still wrote in it once on a loaded runner (ENOTEMPTY), right after the kill
    // and before the app had exited. Which process wrote is not known: the app writes nothing between the kill and its
    // exit, even on a starved machine. The removal waits for the exit, and retries as keys-pty.js's does.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
