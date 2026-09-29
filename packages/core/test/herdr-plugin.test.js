// Run the shipped plugin with a server-like environment; no socket or real HOME.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { parse } = require('smol-toml');
const { fakeHerdr, processInfo, scripted } = require('./fake-herdr');
// Only the startup-hook tests compare with OAK's reconciler, so only they need the built core.
const reconciler = () => require('../dist/herdr-tabs');

const plugin = path.resolve(__dirname, '../../herdr-plugin');
const POSIX = { skip: process.platform === 'win32' && 'requires POSIX sh and env' };
const session = '0f0f0f0f-0000-4000-8000-0000000000aa';
const expected = ['focus', '--session', session, '--tab', 'observatory'];
// The wrapper must search global Homebrew directories too. Never let a test
// that deliberately omits oak accidentally invoke a real global installation.
const globalDirs = ['/usr/bin', '/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
const globalTool = name => globalDirs.some(dir => fs.existsSync(path.join(dir, name)));
const NO_GLOBAL_OAK = { skip: POSIX.skip || (globalTool('oak') && 'a global oak would win discovery') };
const NO_GLOBAL_CLI = { skip: NO_GLOBAL_OAK.skip || (globalTool('claude-observatory') && 'a global claude-observatory would win discovery') };

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak plugin home '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return {
    home,
    write(relative, body) {
      const file = path.join(home, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o755 });
      return file;
    },
    oak(relative = '.local/bin/oak', exit = 0) {
      return this.write(relative, `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/oak-argv"\nprintf '%s\\n' "$PATH" > "$HOME/oak-path"\nexit ${exit}\n`);
    },
    herdr(response, exit = 0, relative = '.local/bin/herdr') {
      fs.writeFileSync(path.join(home, 'pane-response'), typeof response === 'string' ? response : JSON.stringify(response));
      return this.write(relative, `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/herdr-argv"\nprintf '%s' "$HERDR_SOCKET_PATH" > "$HOME/herdr-socket"\ncat "$HOME/pane-response"\nexit ${exit}\n`);
    },
    run(context = {}, env = {}) {
      // File descriptors also work in sandboxes that deny Node's pipe socketpair.
      const stdout = fs.openSync(path.join(home, 'stdout'), 'w');
      const stderr = fs.openSync(path.join(home, 'stderr'), 'w');
      let result;
      try {
        result = spawnSync('/usr/bin/env', [
          '-i', 'PATH=/usr/bin:/bin', `HOME=${home}`,
          `HERDR_PLUGIN_CONTEXT_JSON=${typeof context === 'string' ? context : JSON.stringify(context)}`,
          ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
          'sh', 'open-in-oak.sh',
        ], { cwd: plugin, stdio: ['ignore', stdout, stderr], timeout: 15000 });
      } finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
      }
      return { ...result, stdout: fs.readFileSync(path.join(home, 'stdout'), 'utf8'), stderr: fs.readFileSync(path.join(home, 'stderr'), 'utf8') };
    },
    argv(name = 'oak') {
      return fs.readFileSync(path.join(home, `${name}-argv`), 'utf8').trimEnd().split('\n');
    },
  };
}

function success(b, result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(b.argv(), expected);
}

function failure(b, result, message) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^OAK: [^\r\n]+\n$/);
  assert.match(result.stderr, message);
  assert.equal(fs.existsSync(path.join(b.home, 'oak-argv')), false);
}

test('herdr plugin: manifest selects existing scripts by platform, with distinct action ids', () => {
  const manifest = parse(fs.readFileSync(path.join(plugin, 'herdr-plugin.toml'), 'utf8'));
  assert.equal(manifest.id, 'oak.observatory');
  assert.equal(new Set(manifest.actions.map(a => a.id)).size, manifest.actions.length);
  const unix = manifest.actions.find(a => a.id === 'open-in-oak');
  assert.deepEqual(unix.command, ['sh', 'open-in-oak.sh']);
  assert.deepEqual(unix.platforms, ['linux', 'macos']);
  const windows = manifest.actions.find(a => a.platforms.includes('windows'));
  assert.deepEqual(windows.command, ['cmd.exe', '/d', '/c', 'open-in-oak.cmd']);
  for (const file of ['open-in-oak.sh', 'open-in-oak.cmd', 'open-in-oak.ps1']) {
    assert.ok(fs.existsSync(path.join(plugin, file)));
  }
});

test('herdr plugin: minimal PATH discovers oak in a temporary HOME, prefers it to the alias, and never runs node', POSIX, t => {
  const b = fixture(t);
  b.oak();
  b.write('.local/bin/node', '#!/bin/sh\necho "unexpected node invocation" >&2\nexit 91\n');
  b.write('.local/bin/claude-observatory', '#!/bin/sh\nexit 92\n');
  success(b, b.run({ agent_session: { kind: 'id', value: session } }));
  const entries = fs.readFileSync(path.join(b.home, 'oak-path'), 'utf8').trimEnd().split(':');
  for (const dir of [path.join(b.home, '.local/bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(b.home, '.local/node/bin')]) {
    assert.ok(entries.includes(dir), dir);
  }
  assert.equal(fs.existsSync(path.join(b.home, 'herdr-argv')), false);
});

test('herdr plugin: falls back to claude-observatory', NO_GLOBAL_OAK, t => {
  const b = fixture(t);
  b.oak('.local/bin/claude-observatory');
  success(b, b.run({ session_id: session }));
});

for (const location of [
  '.local/node/bin', '.volta/bin', '.nvm/versions/node/v22.0.0/bin',
  '.local/share/fnm/node-versions/v22.0.0/installation/bin',
  'Library/Application Support/fnm/node-versions/v22.0.0/installation/bin',
  '.fnm/aliases/default/bin',
]) {
  test(`herdr plugin: discovers CLI under ${location}`, POSIX, t => {
    const b = fixture(t);
    b.oak(`${location}/fixture-oak`);
    success(b, b.run({ agent_session_id: session }, { OAK_BIN: 'fixture-oak' }));
  });
}

test('herdr plugin: honors a custom nvm directory and explicit OAK_BIN with spaces', POSIX, t => {
  const b = fixture(t);
  b.oak('custom nvm/versions/node/v24.0.0/bin/custom-oak');
  success(b, b.run({ pane: { agent_session: { kind: 'id', value: session } } }, {
    NVM_DIR: path.join(b.home, 'custom nvm'), OAK_BIN: 'custom-oak',
  }));
  const file = b.oak('alternate install/oak');
  success(b, b.run({ focused_pane: { session_id: session } }, { OAK_BIN: file }));
});

test('herdr plugin: inherits the socket and resolves the focused pane with HERDR_BIN_PATH', POSIX, t => {
  const b = fixture(t);
  b.oak();
  const herdr = b.herdr({ result: { type: 'pane', pane: { agent_session: { kind: 'id', value: session } } } }, 0, 'outside path/herdr');
  success(b, b.run({ focused_pane_id: 'pane-from-context' }, {
    HERDR_PANE_ID: 'pane-from-env', HERDR_BIN_PATH: herdr, HERDR_SOCKET_PATH: '/fake/socket with spaces',
  }));
  assert.deepEqual(b.argv('herdr'), ['pane', 'get', 'pane-from-env']);
  assert.equal(fs.readFileSync(path.join(b.home, 'herdr-socket'), 'utf8'), '/fake/socket with spaces');
});

test('herdr plugin: uses focused_pane_id and discovers herdr on the augmented PATH', POSIX, t => {
  const b = fixture(t);
  b.oak();
  b.herdr({ result: { pane: { agent_session: { kind: 'id', value: session } } } });
  success(b, b.run({ focused_pane_id: 'pane-42', selected_text: '{"session_id":"wrong-session"}' }));
  assert.deepEqual(b.argv('herdr'), ['pane', 'get', 'pane-42']);
});

test('herdr plugin: malformed context can still use HERDR_PANE_ID', POSIX, t => {
  const b = fixture(t);
  b.oak();
  b.herdr({ result: { pane: { agent_session: { kind: 'id', value: session } } } });
  success(b, b.run('{invalid', { HERDR_PANE_ID: 'pane-1' }));
});

test('herdr plugin: a missing CLI produces one diagnostic and a nonzero exit', NO_GLOBAL_CLI, t => {
  const b = fixture(t);
  failure(b, b.run({ session_id: session }), /neither oak nor claude-observatory was found/);
});

test('herdr plugin: an invalid OAK_BIN produces one diagnostic', POSIX, t => {
  const b = fixture(t);
  b.oak();
  failure(b, b.run({ session_id: session }, { OAK_BIN: path.join(b.home, 'missing') }), /OAK_BIN/);
});

for (const context of [{}, null, [], '{invalid', { selected_text: `{"session_id":"${session}"}` }, { session_id: 'bad\nid' }]) {
  test(`herdr plugin: unresolved context ${JSON.stringify(context)} fails visibly`, POSIX, t => {
    const b = fixture(t);
    b.oak();
    failure(b, b.run(context), /no focused pane or agent session/);
  });
}

for (const [label, response, exit, message] of [
  ['lookup fails', {}, 3, /herdr pane get failed/],
  ['invalid JSON', '{invalid', 0, /invalid JSON/],
  ['no reported session', { result: { pane: {} } }, 0, /no valid agent session/],
  ['path reference', { result: { pane: { agent_session: { kind: 'path', value: 'looks-like-an-id' } } } }, 0, /no valid agent session/],
  ['unsafe session', { result: { pane: { agent_session: { kind: 'id', value: '$(touch unexpected)' } } } }, 0, /no valid agent session/],
]) {
  test(`herdr plugin: ${label} fails visibly`, POSIX, t => {
    const b = fixture(t);
    b.oak();
    b.herdr(response, exit);
    failure(b, b.run({ focused_pane_id: 'pane-1' }), message);
  });
}

test('herdr plugin: propagates the CLI exit status', POSIX, t => {
  const b = fixture(t);
  b.oak('.local/bin/oak', 23);
  const result = b.run({ session_id: session });
  assert.equal(result.status, 23);
  assert.deepEqual(b.argv(), expected);
});

// --- the startup hook: herdr runs it once per server start, after restoring the session -------------

const PYTHON = { skip: POSIX.skip || (spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', 'python3', '-c', ''], { stdio: 'ignore' }).status !== 0 && 'requires python3 in /usr/bin or /bin') };

test('herdr plugin: a POSIX startup hook restarts the btop monitor', () => {
  const manifest = parse(fs.readFileSync(path.join(plugin, 'herdr-plugin.toml'), 'utf8'));
  assert.deepEqual(manifest.startup, [{ command: ['python3', 'herdr-startup.py'], platforms: ['linux', 'macos'] }]);
  assert.ok(fs.existsSync(path.join(plugin, 'herdr-startup.py')));
});

/** Run herdr-startup.py as herdr's server does: the plugin directory as cwd, a minimal PATH, and the
 *  server's socket in the environment. File descriptors, not pipes, for sandboxes without socketpair. */
async function startup(t, herdr, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak startup '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = fs.openSync(path.join(dir, 'stdout'), 'w');
  const err = fs.openSync(path.join(dir, 'stderr'), 'w');
  let status;
  try {
    const child = spawn('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', ...(herdr ? [`HERDR_SOCKET_PATH=${herdr.socketPath}`] : []),
      'python3', 'herdr-startup.py', ...args], { cwd: plugin, stdio: ['ignore', out, err] });
    status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  return { status, stdout: fs.readFileSync(path.join(dir, 'stdout'), 'utf8'), stderr: fs.readFileSync(path.join(dir, 'stderr'), 'utf8') };
}

/** A herdr server as the hook meets it right after a restore: it only reads and types. */
function restored(snapshot, states) {
  return {
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot }),
    'pane.process_info': scripted(states),
    'pane.send_text': () => ({ type: 'ok' }),
  };
}
// The home workspace is listed second, so picking the first workspace would be caught.
const machine = (tabs, panes, agents = []) => ({
  workspaces: [{ workspace_id: 'w0', label: 'scratch' }, { workspace_id: 'w1', label: 'home' }],
  tabs: [{ tab_id: 'w0:t1', workspace_id: 'w0', number: 1, label: 'btop' }, ...tabs],
  panes: [{ pane_id: 'w0:p1', tab_id: 'w0:t1', label: 'btop' }, ...panes], agents,
});
const btopTab = (n = 1) => ({ tab_id: `w1:t${n}`, workspace_id: 'w1', number: n, label: 'btop' });
/** The pane OAK labelled `btop` in tab n: the monitor's. */
const monitorPane = (paneN, tabN = paneN) => ({ pane_id: `w1:p${paneN}`, tab_id: `w1:t${tabN}`, label: 'btop' });

test('herdr startup hook: the restored btop tab\'s idle monitor pane in home gets the monitor', PYTHON, async t => {
  const herdr = await fakeHerdr(t, restored(machine([btopTab()], [monitorPane(1)]),
    { 'w0:p1': [processInfo.idle('w0:p1')], 'w1:p1': [processInfo.idle('w1:p1')] }));
  if (!herdr) return;
  const result = await startup(t, herdr);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(herdr.sent(), [{ pane_id: 'w1:p1', text: reconciler().MONITOR_LAUNCH }], 'the home workspace\'s, not the first workspace\'s');
});

test('herdr startup hook: only the pane labelled btop is typed into — never a pane split off beside it, or left when it closed', PYTHON, async t => {
  const idle = { 'w1:p1': [processInfo.idle('w1:p1')], 'w1:p2': [processInfo.idle('w1:p2')] };
  const split = await fakeHerdr(t, restored(machine([btopTab()], [{ pane_id: 'w1:p2', tab_id: 'w1:t1' }, monitorPane(1)]), idle));
  if (!split) return;
  await startup(t, split);
  assert.deepEqual(split.sent(), [{ pane_id: 'w1:p1', text: reconciler().MONITOR_LAUNCH }]);
  // The monitor's pane is gone, or the tab is from before OAK labelled it: left to OAK's terminal app.
  for (const panes of [[{ pane_id: 'w1:p2', tab_id: 'w1:t1' }], [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }]]) {
    const left = await fakeHerdr(t, restored(machine([btopTab()], panes), idle));
    await startup(t, left);
    assert.deepEqual(left.requests.map(r => r.method), ['session.snapshot'], JSON.stringify(panes));
  }
});

test('herdr startup hook: a btop tab an agent took over gets no keys and is not probed; the next agent-free btop tab gets the monitor', PYTHON, async t => {
  // herdr detected claude in one (no session joined yet); an agent of unknown kind joined a session in
  // the other. Either holds its tab.
  const taken = [btopTab(1), btopTab(2)];
  const panes = [{ ...monitorPane(1), agent: 'claude' }, monitorPane(2)];
  const agents = [{ pane_id: 'w1:p2', agent_session: { value: 'fixture-session' } }];
  const idle = { 'w1:p1': [processInfo.idle('w1:p1')], 'w1:p2': [processInfo.idle('w1:p2')], 'w1:p3': [processInfo.idle('w1:p3')] };
  const alone = await fakeHerdr(t, restored(machine(taken, panes, agents), idle));
  if (!alone) return;
  const result = await startup(t, alone);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(alone.requests.map(r => r.method), ['session.snapshot'], 'left to OAK\'s terminal app, which makes a new btop tab');
  // The btop tab OAK made beside them earlier is the monitor's.
  const beside = await fakeHerdr(t, restored(machine([...taken, btopTab(3)], [...panes, monitorPane(3)], agents), idle));
  await startup(t, beside);
  assert.deepEqual(beside.sent(), [{ pane_id: 'w1:p3', text: reconciler().MONITOR_LAUNCH }]);
  assert.ok(beside.calls('pane.process_info').every(p => p.pane_id === 'w1:p3'));
});

test('herdr startup hook: it never makes a tab — with no btop tab in home it is done at once', PYTHON, async t => {
  const herdr = await fakeHerdr(t, restored(machine([], []), {}));
  if (!herdr) return;
  const result = await startup(t, herdr);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(herdr.requests.map(r => r.method), ['session.snapshot']);
});

test('herdr startup hook: a shell still starting is waited on until it reaches the prompt', PYTHON, async t => {
  const herdr = await fakeHerdr(t, restored(machine([btopTab()], [monitorPane(1)]),
    { 'w1:p1': [processInfo.running('w1:p1', 'python3'), processInfo.idle('w1:p1')] }));
  if (!herdr) return;
  const result = await startup(t, herdr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(herdr.calls('pane.process_info').length, 2);
  assert.deepEqual(herdr.sent(), [{ pane_id: 'w1:p1', text: reconciler().MONITOR_LAUNCH }]);
});

test('herdr startup hook: nothing is typed into a btop pane running anything else', PYTHON, async t => {
  const busy = await fakeHerdr(t, restored(machine([btopTab()], [monitorPane(1)]), { 'w1:p1': [processInfo.running('w1:p1', 'vim')] }));
  if (!busy) return;
  const waited = await startup(t, busy, ['0.6']);
  assert.equal(waited.status, 0, waited.stderr);
  assert.ok(busy.calls('pane.process_info').length > 1, 'it waits for the prompt');
  assert.ok(busy.calls('pane.process_info').every(p => p.pane_id === 'w1:p1'));
  assert.deepEqual(busy.sent(), []);
  const running = await fakeHerdr(t, restored(machine([btopTab()], [monitorPane(1)]), { 'w1:p1': [processInfo.replaced('w1:p1')] }));
  const done = await startup(t, running);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(running.calls('pane.process_info').length, 1, 'the monitor already owns the pane: done at once');
  assert.deepEqual(running.sent(), []);
});

test('herdr startup hook: a failure is one OAK line on stderr (herdr plugin log list) and a nonzero exit', PYTHON, async t => {
  const result = await startup(t, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^OAK: [^\r\n]+\n$/);
});

test('herdr startup hook: sends the same launch line and reads a pane the same way as OAK\'s reconciler', PYTHON, t => {
  const cases = [processInfo.idle('p'), processInfo.idle('p', 'bash'), { ...processInfo.idle('p'), foreground_processes: [{ pid: 100, name: '-zsh' }] },
    processInfo.running('p'), processInfo.running('p', 'claude'), processInfo.replaced('p'), processInfo.replaced('p', 'python3.10'),
    processInfo.idle('p', 'fish'), { ...processInfo.idle('p'), foreground_processes: [{ pid: 100, name: 'zsh' }, { pid: 101, name: 'python3' }] },
    { ...processInfo.idle('p'), foreground_processes: [{ pid: 100 }] }, {}, null, { shell_pid: 100 }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak startup parity '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases));
  const out = fs.openSync(path.join(dir, 'out.json'), 'w');
  let result;
  try {
    result = spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', 'python3', '-c', [
      'import json, runpy, sys',
      "hook = runpy.run_path('herdr-startup.py', run_name='oak_parity')",
      "cases = json.load(open(sys.argv[1]))",
      "print(json.dumps({'launch': hook['MONITOR_LAUNCH'], 'states': [hook['foreground'](c) for c in cases]}))",
    ].join('\n'), path.join(dir, 'cases.json')], { cwd: plugin, stdio: ['ignore', out, 'inherit'], timeout: 15000 });
  } finally { fs.closeSync(out); }
  assert.equal(result.status, 0);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  assert.equal(parsed.launch, reconciler().MONITOR_LAUNCH);
  assert.deepEqual(parsed.states, cases.map(reconciler().paneForeground));
});

test('herdr startup hook: picks the same monitor pane as OAK\'s reconciler, or none where OAK would make or adopt a tab', PYTHON, t => {
  const W = [{ workspace_id: 'w0', label: 'scratch' }, { workspace_id: 'w1', label: 'Home ' }];
  const T = (id, label, ws = 'w1') => ({ tab_id: id, workspace_id: ws, number: 1, label });
  const P = (id, tab, extra = {}) => ({ pane_id: id, tab_id: tab, ...extra });
  const snapshots = [
    { workspaces: W, tabs: [T('w1:t1', 'btop')], panes: [P('w1:p1', 'w1:t1', { label: 'btop' })], agents: [] },
    { workspaces: W, tabs: [T('w1:t1', 'btop')], panes: [P('w1:p2', 'w1:t1'), P('w1:p1', 'w1:t1', { label: 'btop' })], agents: [] },
    { workspaces: W, tabs: [T('w1:t1', 'btop')], panes: [P('w1:p2', 'w1:t1')], agents: [] },
    { workspaces: W, tabs: [T('w1:t1', 'btop')], panes: [P('w1:p1', 'w1:t1', { label: 'btop', agent: 'claude' })], agents: [] },
    { workspaces: W, tabs: [T('w1:t1', 'btop'), T('w1:t2', 'btop')], panes: [P('w1:p1', 'w1:t1', { label: 'btop' }), P('w1:p2', 'w1:t2', { label: 'btop' })], agents: [{ pane_id: 'w1:p1' }] },
    { workspaces: W, tabs: [T('w1:t1', 'btop')], panes: [P('w1:p1', 'w1:t1', { label: 'btop' }), P('w1:p2', 'w1:t1', { agent: 'codex' })], agents: [] },
    { workspaces: W, tabs: [T('w0:t1', 'btop', 'w0'), T('w1:t1', '1')], panes: [P('w0:p1', 'w0:t1', { label: 'btop' }), P('w1:p1', 'w1:t1')], agents: [] },
    { workspaces: [{ workspace_id: 'w0', label: 'scratch' }], tabs: [T('w0:t1', 'btop', 'w0')], panes: [P('w0:p1', 'w0:t1', { label: 'btop' })], agents: [] },
    { workspaces: [], tabs: [], panes: [], agents: [] },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak startup parity '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'snapshots.json'), JSON.stringify(snapshots));
  const out = fs.openSync(path.join(dir, 'out.json'), 'w');
  let result;
  try {
    result = spawnSync('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', 'python3', '-c', [
      'import json, runpy, sys',
      "hook = runpy.run_path('herdr-startup.py', run_name='oak_parity')",
      "print(json.dumps([hook['monitor_pane'](s) for s in json.load(open(sys.argv[1]))]))",
    ].join('\n'), path.join(dir, 'snapshots.json')], { cwd: plugin, stdio: ['ignore', out, 'inherit'], timeout: 15000 });
  } finally { fs.closeSync(out); }
  assert.equal(result.status, 0);
  const hook = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  const oak = snapshots.map(s => reconciler().reconcileHerdrTabs(s, () => undefined, {}).actions.find(a => a.kind === 'launch-monitor')?.pane_id ?? null);
  assert.deepEqual(hook, oak);
  assert.deepEqual(oak, ['w1:p1', 'w1:p1', null, null, 'w1:p2', 'w1:p1', null, 'w0:p1', null], 'the cases cover both answers');
});
