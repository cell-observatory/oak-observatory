const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-workers-'));
  const env = { ...process.env };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), OAK_INDEX: 'off' });
  t.after(() => { process.env = env; fs.rmSync(home, { recursive: true, force: true }); });
  const cwd = path.join(home, 'repo'), wt = path.join(home, 'sibling');
  const git = path.join(cwd, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(git, 'config'), '[core]\n bare = false\n');
  const admin = path.join(git, 'worktrees', 'sibling');
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/sibling\n');
  fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
  const id = '00000000-0000-4000-8000-000000000111';
  const rollout = path.join(process.env.CODEX_HOME, 'sessions', `rollout-${id}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, [
    { type: 'session_meta', payload: { id, cwd: wt, source: 'cli' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check synthetic widgets' }] } },
  ].map(x => JSON.stringify({ timestamp: new Date().toISOString(), ...x })).join('\n')+'\n');
  const pane = { pane_id: 'pane-1', tab_id: 'tab-1', workspace_id: 'ws', agent: 'codex', agent_status: 'unknown', cwd: wt,
    agent_session: { value: id, agent: 'codex' } };
  const snapshot = { version: '0.9.1', protocol: 22, workspaces: [], tabs: [{ tab_id: 'tab-1', label: 'Verify copper widgets' }], panes: [pane], agents: [{ ...pane, name: 'worker-1' }] };
  const options = { snapshot, native: new Map(), alive: () => true };
  return { home, cwd, wt, id, snapshot, options };
}

test('workers: herdr Codex in a sibling worktree uses its tab title, once', async t => {
  const f = fixture(t);
  const result = await core.readWorkerFleet(f.cwd, null, f.options);
  const rows = result.workers.filter(r => r.session === f.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Verify copper widgets');
  assert.equal(rows[0].kind, 'codex');
  assert.equal(rows[0].state, 'working');
  assert.equal(rows[0].worktree, f.wt);
  const { fakeHerdr } = require('./fake-herdr');
  const server = await fakeHerdr(t, {
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot: f.snapshot }),
    'pane.process_info': () => ({ type: 'pane_process_info', process_info: { shell_pid: 1, foreground_processes: [{ pid: 2, name: 'codex' }] } }),
  });
  if (server) for (const command of [['fleet', '--json'], ['sessions', '--json', '--workers']]) {
    const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)(process.execPath,
      [path.resolve(__dirname, '../../cli/dist/index.js'), ...command, '--root', f.cwd],
      { cwd: f.cwd, env: { ...process.env, HERDR_SOCKET_PATH: server.socketPath, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' }, timeout: 15000 });
    const worker = JSON.parse(stdout).workers.find(w => w.session === f.id);
    assert.equal(worker?.title, 'Verify copper widgets', command.join(' '));
    assert.equal(worker?.state, 'working');
  }

  // A rollout with no herdr pane is still discovered across the repository's worktrees.
  const bare = await core.readWorkerFleet(f.cwd, null, { ...f.options, snapshot: { ...f.snapshot, agents: [], panes: [] } });
  assert.ok(bare.workers.some(r => r.session === f.id));
});

test('tab labels: Workers ignores placeholders at the workspace position, including after tabs move', async t => {
  const f = fixture(t);
  const tab = f.snapshot.tabs[0];
  Object.assign(tab, { workspace_id: 'ws', number: 8 });
  const title = core.sessionMeta(f.cwd, null).sessions.find(r => r.id === f.id).title;
  assert.equal(title, 'Check synthetic widgets');
  for (const label of ['1', '', '   ', 'codex', ' Claude ']) {
    tab.label = label;
    const result = await core.readWorkerFleet(f.cwd, null, f.options);
    assert.equal(result.workers.find(r => r.session === f.id).title, title, JSON.stringify(label));
  }
  f.snapshot.tabs.unshift({ tab_id: 'elsewhere', workspace_id: 'other', number: 1, label: '1' },
    { tab_id: 'first', workspace_id: 'ws', number: 3, label: 'Notes' });
  tab.label = '2';
  const moved = await core.readWorkerFleet(f.cwd, null, f.options);
  assert.equal(moved.workers.find(r => r.session === f.id).title, title);
});

test('tab labels: Workers preserves user names until the tab returns to its default', async t => {
  const f = fixture(t);
  for (const label of ['Demo checks', '2024', '8', '1']) {
    Object.assign(f.snapshot.tabs[0], { workspace_id: 'ws', number: 8, label });
    const result = await core.readWorkerFleet(f.cwd, null, f.options);
    assert.equal(result.workers.find(r => r.session === f.id).title, label === '1' ? 'Check synthetic widgets' : label);
  }
});

test('workers: a killed session with an unfinished tool call is gone', async t => {
  const f = fixture(t);
  const id = 'killed-session', dir = core.projectDir(f.cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id+'.jsonl'), JSON.stringify({ type: 'assistant', sessionId: id, cwd: f.cwd, timestamp: new Date().toISOString(), message: {
    role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 10' } }] } })+'\n');
  const result = await core.readWorkerFleet(f.cwd, id, { ...f.options, alive: () => false });
  assert.equal(result.workers.find(r => r.session === id)?.state, 'gone');
  assert.equal(result.workers.find(r => r.session === id)?.active, false);
});

test('workers: saved-machine rows retain their owner and reviewed machine comes first', async t => {
  const f = fixture(t);
  const local = await core.readWorkerFleet(f.cwd, null, f.options);
  const remote = { label: 'test-lab', workers: local.workers };
  const rows = core.workersByMachine(local.workers, [remote], 'test-lab', f.id);
  assert.equal(rows[0].machine, 'test-lab');
  assert.equal(rows[0].self, true);
  assert.equal(rows[0].title, 'Verify copper widgets');
  assert.equal(rows[1].self, false);
  assert.notEqual(rows[0].key, rows[1].key, 'same session id on two machines never aliases');
});

test('workers: Claude native status is shared across processes for ten seconds, then sees a new agent', t => {
  const f = fixture(t);
  const cp = require('node:child_process');
  const bin = path.join(f.home, process.platform === 'win32' ? 'claude.cmd' : 'claude'), log = path.join(f.home, 'calls'), answer = path.join(f.home, 'answer');
  fs.writeFileSync(answer, '[]');
  // A node script behind a launcher: a shell script here, a .cmd on Windows, where cmd.exe runs no shell script.
  const script = path.join(f.home, 'claude.js');
  fs.writeFileSync(script, `const fs = require('fs');\nfs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(answer)}, 'utf8'));\n`);
  fs.writeFileSync(bin, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const module = path.resolve(__dirname, '../dist/delegated');
  const now = Date.now();
  const read = at => {
    const r = cp.spawnSync(process.execPath, ['-e', `Date.now = () => ${at}; console.log(JSON.stringify([...require(process.argv[1]).claudeNativeStatus(process.argv[2])]));`, module, bin], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(read(now), []);
  fs.writeFileSync(answer, JSON.stringify([{ sessionId: 'started', status: 'busy', pid: 123 }]));
  assert.deepEqual(read(now + 1), [], 'another process shares the answer inside the window');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(read(now + 10_001), [['started', { status: 'busy', pid: 123 }]], 'the next read after expiry sees the start');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
  fs.writeFileSync(answer, '[]');
  const registry = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, '123.json'), '{}');
  assert.deepEqual(read(now + 10_002), [], 'a changed process registry invalidates even a fresh answer');
});

test('workers: the serve protocol queues fleet and ordinary views, including stdin closing', async t => {
  const f = fixture(t), cp = require('node:child_process');
  const id = 'warm-worker';
  fs.mkdirSync(core.projectDir(f.cwd), { recursive: true });
  fs.writeFileSync(path.join(core.projectDir(f.cwd), `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, cwd: f.cwd,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'Synthetic worker' } })+'\n');
  const cli = path.resolve(__dirname, '../../cli/dist/index.js');
  const args = ['--root', f.cwd, '--session', id];
  const r = cp.spawnSync(process.execPath, [cli, 'views', '--serve'], { encoding: 'utf8', timeout: 15000,
    input: [{ views: ['fleet'], args }, { views: ['sessions'], args }].map(v => JSON.stringify(v)+'\n').join('') });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].fleet?.workers.some(w => w.session === id), r.stdout);
  assert.ok(lines[0].fleet.findings);
  assert.ok(lines[1].sessions.sessions.some(s => s.id === id));
});
