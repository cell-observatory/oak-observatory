// `oak agent start --brief | list | wait | close` and `oak query delegated`, end to end through the built CLI: synthetic
// records, transcripts and rollouts, a fake herdr, and a saved machine reached through a fake ssh (no network, no real
// host). Includes the measured delay from a report written, or a turn ended, to the state `wait` and `list` show.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { fakeHerdr, processInfo } = require('../packages/core/test/fake-herdr');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const core = require(path.join(root, 'packages/core/dist/index.js'));
const skipIndex = !core.indexRuntime().ok && `no node:sqlite with FTS5 in ${process.version}`;
const posix = process.platform === 'win32' && 'POSIX fake ssh and agent processes';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-agents-')));
  t.after(() => (() => { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* a child's late write: never skip the stop hooks after this one */ } })());
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // Claude Code's own status, as `claude agents --json --all` prints it, from a file the test writes.
  const nativeFile = path.join(home, 'claude-agents.json');
  fs.writeFileSync(nativeFile, '[]');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat "${nativeFile}"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_BIN: path.join(bin, 'claude'), HERDR_SOCKET_PATH: path.join(home, 'no-herdr.sock'), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const k of ['HERDR_PANE_ID', 'OAK_DELEGATED', 'CODEX_THREAD_ID', 'CLAUDE_OBSERVATORY_SESSION', 'OAK_AGENT_WAIT_MS', 'OAK_AGENT_FORWARD']) delete env[k];
  const store = path.join(env.CLAUDE_CONFIG_DIR, 'claude-observatory');
  const work = path.join(home, 'work', 'tree');
  fs.mkdirSync(work, { recursive: true });
  return { home, bin, env, store, work, nativeFile };
}

function run(f, args, opts = {}) {
  const r = cp.spawnSync(process.execPath, [cli, ...args], { cwd: f.home, env: { ...f.env, ...opts.env }, encoding: 'utf8', timeout: opts.timeout ?? 30000 });
  assert.equal(r.error, undefined);
  return r;
}

/** `run`, without blocking this process: the fake herdr answering the CLI lives here. */
function runAsync(f, args, opts = {}) {
  const child = cp.spawn(process.execPath, [cli, ...args], { cwd: f.home, env: { ...f.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout ?? 60000);
  return new Promise((resolve) => child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); }));
}

/** A process whose command line names the agent's CLI: the pid OAK recorded for it. */
function liveAgent(t, kind) {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', kind], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  return child;
}

/** A record as `oak agent start` writes it (core delegated.ts), in this fixture's store. */
function record(f, over) {
  const out = path.join(f.home, 'work', `${over.id}-out`);
  fs.mkdirSync(out, { recursive: true });
  const now = Date.now();
  const rec = { title: 'Fix the parser', brief: path.join(f.home, 'work', `${over.id}-brief.md`), cwd: f.work, out, report: path.join(out, 'report.md'), kind: 'claude',
    agentType: null, model: null, effort: null, sandbox: null, machine: null, workspace: 'w1', tab: 't1', pane: 'p1', herdrName: `oak-${over.id}`, pid: null,
    session: null, parent: null, startedMs: now - 60_000, endedMs: null, closedMs: null, state: 'starting', since: now - 60_000, ...over };
  fs.mkdirSync(path.join(f.store, 'delegated'), { recursive: true });
  fs.writeFileSync(path.join(f.store, 'delegated', `${rec.id}.json`), JSON.stringify(rec));
  return rec;
}

/** A Claude transcript for `id`, working in the fixture's tree. */
function transcript(f, id, records) {
  const file = path.join(f.env.CLAUDE_CONFIG_DIR, 'projects', f.work.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify({ cwd: f.work, sessionId: id, timestamp: new Date().toISOString(), ...r })).join('\n') + '\n');
  return file;
}
const pendingCall = { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } };

/** Run `oak agent wait …` in the background; resolves with its exit status, output and when it ended. */
function waitInBackground(f, args, env = {}) {
  const child = cp.spawn(process.execPath, [cli, 'agent', 'wait', ...args], { cwd: f.home, env: { ...f.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr, at: Date.now() })));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('oak agent list: one listing read and one locked merge per remote record per refresh', async (t) => {
  require('../packages/core/test/fixtures/index-fixture.cjs').indexFixture(t, core);
  const api = require('../packages/core/dist/index/api');
  const recs = Array.from({ length: 100 }, (_, i) => ({ id: `local-${i}`, kind: 'codex', machine: 'build-box', remoteId: `remote-${i}`,
    title: `Agent ${i}`, startedMs: i, state: 'working', since: 1, closedMs: null, session: null }));
  for (const rec of recs) core.writeDelegated(rec);
  const agents = recs.map((r, i) => ({ ...r, id: r.remoteId, state: 'blocked', since: 10, tokens: i + 1, cost: (i + 1) / 100, workers: [] }));
  let reads = 0, writes = 0, indexed = 0;
  const read = fs.readFileSync, rename = fs.renameSync;
  const dir = core.delegatedDir() + path.sep;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file).startsWith(dir) && String(file).endsWith('.json')) reads++;
    return read.call(this, file, ...args);
  });
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (String(to).startsWith(dir)) writes++;
    return rename.call(this, from, to);
  });
  t.mock.method(api, 'indexedMachineDelegated', () => { indexed++; return { agents }; });
  const cli = require('./fixtures/delegated-refresh.cjs')(core);
  const rows = await cli.delegatedNow(false);
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.since, r.tokens, r.cost]), [...recs].reverse().map((r, j) =>
    [r.id, 'blocked', 10, 100 - j, (100 - j) / 100]));
  assert.deepEqual({ reads, writes, indexed, ssh: cli.counts.ssh }, { reads: 200, writes: 100, indexed: 1, ssh: 0 });
});

test('oak agent list: SSH matching and machine grouping take linear work', async (t) => {
  const recs = Array.from({ length: 1000 }, (_, i) => ({ id: `local-${i}`, remoteId: `remote-${i}`, machine: 'build-box', state: 'working' }));
  const agents = recs.map((r, i) => ({ id: r.remoteId, state: 'blocked', since: i }));
  const matched = [];
  const cli = require('./fixtures/delegated-refresh.cjs')({
    isTerminalDelegated: core.isTerminalDelegated, refreshRemoteFromIndex: () => new Set(),
    applyRemoteDelegated: (rec, there, via) => matched.push([rec.id, there.since, via]),
  }, agents);
  await cli.refreshRemoteDelegated(recs);
  assert.deepEqual(matched, recs.map((r, i) => [r.id, i, 'ssh']));
  assert.ok(cli.counts.ids <= 2 * recs.length, `remote id reads: ${cli.counts.ids}`);
  assert.ok(cli.counts.grouped <= 2 * recs.length, `grouped record visits: ${cli.counts.grouped}`);
  assert.equal(cli.counts.ssh, 1);
});

test('oak agent list: every delegated agent with its state and since, kind, tab, and its session\'s workers; closed ones under --all', { skip: posix }, (t) => {
  const f = fixture(t);
  const agent = liveAgent(t, 'claude');
  record(f, { id: 'l1', pid: agent.pid, session: 's-l1', agentType: 'builder' });
  const main = transcript(f, 's-l1', [{ type: 'user', message: { role: 'user', content: 'brief' } }, pendingCall]);
  // One of its workers, still at it.
  const sub = path.join(path.dirname(main), 's-l1', 'subagents', 'agent-w7.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'w7', timestamp: new Date().toISOString(),
    message: { id: 'mw', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'tw', name: 'Read', input: {} }] } }) + '\n');
  record(f, { id: 'l2', kind: 'codex', state: 'done', since: Date.now() - 1000, closedMs: Date.now() });
  const r = run(f, ['agent', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout).agents;
  assert.deepEqual(rows.map((a) => [a.id, a.state, a.kind, a.tab, a.agentType]), [['l1', 'working', 'claude', 't1', 'builder']]);
  assert.equal(typeof rows[0].since, 'number');
  assert.deepEqual(rows[0].workers.map((w) => [w.id, w.parent, w.state]), [['w7', 'l1', 'working']], 'its worker, with its parent');
  const all = JSON.parse(run(f, ['agent', 'list', '--all', '--json']).stdout).agents;
  assert.deepEqual(all.map((a) => a.id).sort(), ['l1', 'l2']);
  const text = run(f, ['agent', 'list']);
  assert.match(text.stdout, /^l1  working since \d\d:\d\d:\d\d  Fix the parser\n    claude · this machine · tab l1: Fix the parser\n    └ worker /m, 'an exact time, not an age');
});

test('oak agent wait/list: a report written shows as done within seconds — watched, not polled', { skip: posix }, async (t) => {
  const f = fixture(t);
  const agent = liveAgent(t, 'claude');
  const rec = record(f, { id: 'w1', pid: agent.pid, session: 's-w1' });
  transcript(f, 's-w1', [{ type: 'user', message: { role: 'user', content: 'brief' } }, pendingCall]);
  // The poll fallback a minute away: only the watch can end this wait in time.
  const waiting = waitInBackground(f, ['w1', '--until', 'done', '--json'], { OAK_AGENT_WAIT_MS: '60000' });
  await sleep(2500);
  const written = Date.now();
  fs.writeFileSync(rec.report, '# Report\nDONE\n');
  const listed = run(f, ['agent', 'list', '--json']);
  const listMs = Date.now() - written;
  assert.equal(JSON.parse(listed.stdout).agents[0].state, 'done', 'list derives it on the spot');
  const w = await waiting;
  const waitMs = w.at - written;
  assert.equal(w.code, 0, w.stderr);
  assert.deepEqual(JSON.parse(w.stdout).agents.map((a) => a.state), ['done']);
  t.diagnostic(`report written → list says done: ${listMs} ms; → wait returned: ${waitMs} ms`);
  assert.ok(waitMs <= 5000, `wait saw the report ${waitMs} ms after it was written`);
});

test('oak agent wait --until any: a Codex turn ended (task_complete) shows as waiting within seconds; one stopped on a provider error as errored', { skip: posix }, async (t) => {
  const f = fixture(t);
  const agent = liveAgent(t, 'codex');
  const session = '0199bbbb-0000-7000-8000-0000000000a1';
  record(f, { id: 'x1', kind: 'codex', pid: agent.pid, session });
  const rollout = path.join(f.env.CODEX_HOME, 'sessions', '2026', '11', '03', `rollout-2026-11-03T14-00-00-${session}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  const ev = (payload) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n';
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: session, cwd: f.work } }) + '\n' + ev({ type: 'task_started', turn_id: 'a' }));
  assert.equal(JSON.parse(run(f, ['agent', 'list', '--json']).stdout).agents[0].state, 'working');
  const waiting = waitInBackground(f, ['x1', '--until', 'any', '--json'], { OAK_AGENT_WAIT_MS: '60000' });
  await sleep(2500);
  const ended = Date.now();
  fs.appendFileSync(rollout, ev({ type: 'task_complete', turn_id: 'a', last_agent_message: 'halfway' }));
  const w = await waiting;
  const ms = w.at - ended;
  assert.equal(w.code, 0, w.stderr);
  assert.deepEqual(JSON.parse(w.stdout).agents.map((a) => a.state), ['waiting']);
  t.diagnostic(`turn ended → wait --until any returned: ${ms} ms`);
  assert.ok(ms <= 5000, `wait saw the turn end ${ms} ms after it was written`);
  // Sent again, and stopped on the provider's error: errored, with the text and the time, for `--until blocked` too.
  fs.appendFileSync(rollout, ev({ type: 'task_started', turn_id: 'b' }) + ev({ type: 'error', message: 'Selected model is at capacity. Please try a different model.' }));
  const b = run(f, ['agent', 'wait', 'x1', '--until', 'blocked', '--json', '--timeout', '20']);
  assert.equal(b.status, 0, b.stderr);
  const [row] = JSON.parse(b.stdout).agents;
  assert.deepEqual([row.state, row.error], ['errored', 'Selected model is at capacity. Please try a different model.']);
  assert.match(run(f, ['agent', 'list']).stdout, /x1  errored since \d\d:\d\d:\d\d .*\n.*\n    Selected model is at capacity/);
});

test('oak agent wait: done for all, exit 1 when one is gone; 124 at the timeout; refuses an unknown id', { skip: posix }, (t) => {
  const f = fixture(t);
  record(f, { id: 'g1', session: 's-g1', pid: 2 ** 22 + 7 }); // a pid no process has
  const out = record(f, { id: 'd1', session: 's-d1' });
  fs.writeFileSync(out.report, 'done\n');
  const r = run(f, ['agent', 'wait', 'g1', 'd1', '--json']);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).agents.map((a) => [a.id, a.state]).sort(), [['d1', 'done'], ['g1', 'gone']]);
  const agent = liveAgent(t, 'claude');
  record(f, { id: 's1', pid: agent.pid });
  const slow = run(f, ['agent', 'wait', 's1', '--timeout', '1', '--json']);
  assert.equal(slow.status, 124);
  assert.equal(JSON.parse(slow.stdout).reached, false);
  assert.equal(run(f, ['agent', 'wait', 'nope']).status, 1);
});

test('oak agent wait: every state has the documented exit for done, blocked and any', { skip: posix }, (t) => {
  const f = fixture(t);
  const agent = liveAgent(t, 'claude');
  for (const state of ['starting', 'working', 'waiting', 'blocked', 'errored', 'done', 'gone']) {
    const session = state === 'starting' ? null : `s-${state}`;
    const rec = record(f, { id: state, session, pid: state === 'gone' ? 2 ** 22 + 7 : agent.pid });
    if (session) transcript(f, session, [{ type: 'user', message: { role: 'user', content: 'brief' } },
      state === 'waiting' ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'paused' }] } }
        : state === 'errored' ? { type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: overloaded' }] } }
          : pendingCall]);
    if (state === 'done') fs.writeFileSync(rec.report, 'done\n');
    if (state === 'blocked') {
      fs.mkdirSync(path.join(f.store, session), { recursive: true });
      fs.writeFileSync(path.join(f.store, session, 'attention.json'), JSON.stringify({ kind: 'permission', message: 'Bash', ts: Date.now() }));
    }
    for (const until of ['done', 'blocked', 'any']) {
      const expected = state === 'done' ? 0 : state === 'gone' ? (until === 'done' ? 1 : 0)
        : until === 'any' && !['starting', 'working'].includes(state) ? 0
          : until === 'blocked' && ['blocked', 'errored'].includes(state) ? 0 : 124;
      const r = run(f, ['agent', 'wait', state, '--until', until, '--timeout', '0.1', '--json']);
      assert.equal(r.status, expected, `${state}/${until}: ${r.stderr} ${r.stdout}`);
      assert.equal(JSON.parse(r.stdout).agents[0].state, state, `${state}/${until}`);
    }
  }
});

test('oak agent close: closes the tab in herdr and keeps the row; `oak query delegated` lists the same rows', { skip: skipIndex || posix }, async (t) => {
  const f = fixture(t);
  const fake = await fakeHerdr(t, { 'tab.close': () => ({ type: 'ok' }) });
  if (!fake) return;
  fake.snapshot = { panes: [{ pane_id: 'p1', agent_session: null }] };
  f.env.HERDR_SOCKET_PATH = fake.socketPath;
  const agent = liveAgent(t, 'claude');
  record(f, { id: 'c1', pid: agent.pid, tab: 't5', pane: 'p1' });
  const q = await runAsync(f, ['query', 'delegated']);
  assert.equal(q.status, 0, q.stderr);
  assert.deepEqual(JSON.parse(q.stdout).rows.map((r) => [r.id, r.state, r.tab]), [['c1', 'starting', 't5']]);
  const r = await runAsync(f, ['agent', 'close', 'c1', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fake.calls('tab.close'), [{ tab_id: 't5' }]);
  assert.deepEqual(JSON.parse(r.stdout).closed.map((a) => [a.id, a.state, typeof a.closedMs]), [['c1', 'gone', 'number']]);
  assert.deepEqual(JSON.parse((await runAsync(f, ['agent', 'list', '--json'])).stdout).agents, []);
  const all = JSON.parse((await runAsync(f, ['query', 'delegated', '--all'])).stdout).rows;
  assert.deepEqual(all.map((x) => [x.id, x.state, typeof x.closed_ms]), [['c1', 'gone', 'number']], 'the query holds the row as list --all does');
});

/** A saved machine, `build-box`, reached through the fake ssh: its own home, this build as its oak, and a fake herdr
 *  server where its herdr's socket is. */
async function savedMachine(t, f, handlers) {
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'));
  for (const name of ['ssh', 'herdr']) fs.writeFileSync(path.join(f.bin, name), stub, { mode: 0o755 });
  const remote = path.join(f.home, 'remote-home');
  fs.mkdirSync(path.join(remote, '.local', 'bin'), { recursive: true });
  // Its claude: Claude Code's status there, which knows no session.
  fs.writeFileSync(path.join(remote, '.local', 'bin', 'claude'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(remote, '.local', 'bin', 'oak'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
  f.env.FAKE_REMOTE_HOME = remote;
  f.env.MACHINE_EXEC_LOG = path.join(f.home, 'machine-exec.log');
  const fake = await fakeHerdr(t, handlers);
  if (!fake) return null;
  fs.mkdirSync(path.join(remote, '.config', 'herdr'), { recursive: true });
  fs.symlinkSync(fake.socketPath, path.join(remote, '.config', 'herdr', 'herdr.sock'));
  const remoteEnv = { HOME: remote, PATH: `${path.join(remote, '.local', 'bin')}:/usr/bin:/bin` };
  const onRemote = (args) => runAsync({ home: remote, env: remoteEnv }, args);
  const sshCalls = () => (fs.existsSync(f.env.MACHINE_EXEC_LOG) ? fs.readFileSync(f.env.MACHINE_EXEC_LOG, 'utf8') : '').split(/^ssh\n/m).length - 1;
  return { remote, fake, onRemote, sshCalls };
}

test('oak agent across machines: start on a saved machine in its herdr, list and wait over ssh or from the synced index, close there', { skip: skipIndex || posix }, async (t) => {
  const f = fixture(t);
  const agent = liveAgent(t, 'codex');
  let reads = 0;
  const m = await savedMachine(t, f, {
    'tab.create': () => ({ type: 'tab_created', tab: { tab_id: 'rt1', workspace_id: 'rw1' }, root_pane: { pane_id: 'rp1' } }),
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: reads === 0 ? processInfo.idle(pane_id)
      : { pane_id, shell_pid: 100, foreground_process_group_id: agent.pid, foreground_processes: [{ pid: agent.pid, name: 'codex', argv: ['codex'] }] } }),
    'agent.start': () => ({ type: 'agent_started', agent: {}, argv: [] }),
    'pane.read': () => ({ type: 'pane_read', read: { text: reads++ < 2 ? 'Ask Codex to do anything' : 'Working (3s • esc to interrupt)' } }),
    'agent.prompt': () => ({ type: 'agent_prompted', agent: {} }),
    'agent.send_keys': () => ({ type: 'ok' }),
    'tab.close': () => ({ type: 'ok' }),
  });
  if (!m) return;
  m.fake.snapshot = { panes: [{ pane_id: 'rp1', agent_session: null }] };
  // The brief and the tree are that machine's.
  const tree = path.join(m.remote, 'work', 'tree');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(m.remote, 'work', 'rb1-brief.md'), '# Port the lexer\n');
  const started = await runAsync(f, ['agent', 'start', '--kind', 'codex', '--brief', path.join(m.remote, 'work', 'rb1-brief.md'), '--cwd', tree, '--name', 'rb1',
    '--model', 'gpt-x', '--machine', 'build-box', '--json'], { timeout: 60000 });
  assert.equal(started.status, 0, started.stderr);
  const here = JSON.parse(started.stdout);
  assert.deepEqual([here.id, here.remoteId, here.machine, here.title, here.tab, here.model], ['rb1', 'rb1', 'build-box', 'Port the lexer', 'rt1', 'gpt-x']);
  assert.equal(m.fake.calls('tab.create')[0].env.OAK_DELEGATED, 'rb1', 'the tab was made by that machine\'s herdr');
  assert.match(m.fake.calls('agent.prompt')[0].text, /Your brief is .*remote-home\/work\/rb1-brief\.md/);
  assert.equal((await m.onRemote(['agent', 'list', '--json'])).status, 0);
  // Over ssh: its own derivation there (working: no session yet is starting; its session linked, its rollout open).
  const session = '0199cccc-0000-7000-8000-0000000000b1';
  fs.writeFileSync(path.join(m.remote, '.claude', 'claude-observatory', 'delegated', 'rb1.session'), session);
  const rollout = path.join(m.remote, '.codex', 'sessions', '2026', '11', '03', `rollout-2026-11-03T14-00-00-${session}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'a' } }) + '\n');
  const before = m.sshCalls();
  const listed = JSON.parse((await runAsync(f, ['agent', 'list', '--json'])).stdout).agents;
  assert.deepEqual(listed.map((a) => [a.id, a.machine, a.state, a.session, a.remote.via]), [['rb1', 'build-box', 'working', session, 'ssh']]);
  assert.equal(m.sshCalls(), before + 1, 'one ssh read of that machine');
  // oak sync brought that machine's records here and reached it a minute ago: read from the index, no ssh.
  fs.writeFileSync(path.join(m.remote, 'work', 'rb1-out', 'report.md'), 'DONE\n');
  // That machine's side of an oak sync run: its agents derived again, then its records published.
  const published = await m.onRemote(['__sync-inventory', '--json', '--publish', '--user', os.userInfo().username]);
  assert.equal(published.status, 0, published.stderr);
  const records = path.join(m.remote, '.claude', 'claude-observatory', 'records');
  const [host] = fs.readdirSync(records).filter((n) => /^[0-9a-f]{12}$/.test(n));
  fs.cpSync(path.join(records, host), path.join(f.store, 'records', host), { recursive: true });
  fs.mkdirSync(path.join(f.store, 'sync'), { recursive: true });
  fs.writeFileSync(path.join(f.store, 'sync', 'status.json'), JSON.stringify({ at: Date.now() - 60_000, durationMs: 1, status: 'ok', warnings: [],
    machines: [{ label: 'build-box', host, status: 'ok', pulled: { files: 1, bytes: 1 }, conflicts: 0, pending: { files: 0, bytes: 0 }, errors: [], lastOkAt: Date.now() - 60_000 }] }));
  const noSsh = m.sshCalls();
  const w = await runAsync(f, ['agent', 'wait', 'rb1', '--json', '--timeout', '20']);
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(JSON.parse(w.stdout).agents.map((a) => [a.id, a.state, a.remote.via]), [['rb1', 'done', 'index']]);
  assert.equal(m.sshCalls(), noSsh, 'read from the synced records');
  // The editors' and the terminal app's views read it so too (multitask's `delegated`), with no ssh of their own: the row
  // here put back as it was before that read.
  const pointer = path.join(f.store, 'delegated', 'rb1.json');
  fs.writeFileSync(pointer, JSON.stringify({ ...JSON.parse(fs.readFileSync(pointer, 'utf8')), state: 'working', endedMs: null }));
  const mt = await runAsync(f, ['multitask', '--json', '--session', 's-none', '--root', f.work]);
  assert.equal(mt.status, 0, mt.stderr);
  assert.deepEqual(JSON.parse(mt.stdout).delegated.map((a) => [a.id, a.state, a.remote.via]), [['rb1', 'done', 'index']]);
  assert.equal(m.sshCalls(), noSsh);
  // Every machine sees every agent: the index here holds that machine's own row.
  const q = JSON.parse((await runAsync(f, ['query', 'sql', "SELECT machine_id, id, state FROM delegated WHERE machine_id != (SELECT machine_id FROM machines WHERE is_self = 1 LIMIT 1)"])).stdout);
  assert.deepEqual(q.rows.map((r) => [r.machine_id, r.id, r.state]), [[host, 'rb1', 'done']]);
  // Close: on that machine, by its OAK.
  const closed = await runAsync(f, ['agent', 'close', 'rb1', '--json']);
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(m.fake.calls('tab.close'), [{ tab_id: 'rt1' }]);
  assert.equal(typeof JSON.parse(closed.stdout).closed[0].closedMs, 'number');
  assert.equal(typeof JSON.parse((await m.onRemote(['agent', 'list', '--all', '--json'])).stdout).agents[0].closedMs, 'number', 'closed there too');
});

async function commHerdr(t, f, kinds = ['claude', 'codex']) {
  const live = kinds.map(kind => liveAgent(t, kind));
  const fake = await fakeHerdr(t, {
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: { pane_id, shell_pid: 1,
      foreground_processes: [{ pid: live[Number(pane_id.slice(1)) || 0].pid, name: kinds[Number(pane_id.slice(1)) || 0] }] } }),
    'pane.read': () => ({ type: 'pane_read', read: { text: '? for shortcuts\nesc to interrupt' } }),
    'agent.prompt': () => ({ type: 'agent_prompted', agent: {} }),
    'agent.send_keys': () => ({ type: 'ok' }),
  });
  if (!fake) return null;
  fake.snapshot = { panes: kinds.map((kind, i) => ({ pane_id: `p${i}`, agent: kind, agent_session: null })) };
  f.env.HERDR_SOCKET_PATH = fake.socketPath;
  return { fake, live };
}

test('agent tell: both local kinds receive exact hostile text, Enter, and an attributed record', { skip: posix }, async t => {
  const f = fixture(t), h = await commHerdr(t, f);
  if (!h) return;
  for (const [i, kind] of ['claude', 'codex'].entries()) record(f, { id: kind, kind, pane: `p${i}`, pid: h.live[i].pid });
  const marker = path.join(f.home, 'executed');
  const text = `Extra scope: 'single' "double" $(touch ${marker}) \`touch ${marker}\`\nline two\tend`;
  const file = path.join(f.home, 'message.txt'); fs.writeFileSync(file, text);
  const r = await runAsync(f, ['agent', 'tell', 'claude', 'codex', '--file', file, '--json'], { env: { OAK_DELEGATED: 'teller' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.fake.calls('agent.prompt').map(p => [p.target, p.text]), [['oak-claude', text], ['oak-codex', text]]);
  assert.deepEqual(h.fake.calls('agent.send_keys'), ['claude', 'codex'].map(id => ({ target: `oak-${id}`, keys: ['Enter'] })));
  assert.equal(fs.existsSync(marker), false);
  const rows = JSON.parse((await runAsync(f, ['agent', 'list', '--json'])).stdout).agents;
  for (const row of rows) {
    assert.equal(typeof row.lastMessageMs, 'number');
    assert.deepEqual(row.messages.map(m => [m.from, m.text, m.at]), [['teller', text, row.lastMessageMs]]);
  }
  assert.equal(JSON.parse(r.stdout).sent.length, 2);
});

test('agent tell: preflight rejects gone, done, closed, missing and control input without sending to anyone', { skip: posix }, async t => {
  const f = fixture(t), h = await commHerdr(t, f);
  if (!h) return;
  record(f, { id: 'live', pane: 'p0', pid: h.live[0].pid });
  for (const state of ['gone', 'done']) record(f, { id: state, state });
  record(f, { id: 'closed', closedMs: Date.now() });
  for (const id of ['gone', 'done', 'closed', 'missing']) {
    const r = await runAsync(f, ['agent', 'tell', 'live', id, 'new scope']);
    assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, new RegExp(id));
  }
  for (const control of ['\0', '\r', '\x03', '\x1b[201~', '\x7f', '\x9b']) {
    const file = path.join(f.home, 'control.txt'); fs.writeFileSync(file, `scope${control}bad`);
    const r = await runAsync(f, ['agent', 'tell', 'live', '--file', file]);
    assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, /control/i);
  }
  assert.deepEqual(h.fake.calls('agent.prompt'), []);
});

test('agent tell: remote Claude and Codex use SSH, preserve hostile text and teller, preflight before local sends', { skip: posix }, async t => {
  const f = fixture(t);
  const agents = ['claude', 'codex'].map(kind => liveAgent(t, kind));
  const m = await savedMachine(t, f, {
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: { pane_id, shell_pid: 1,
      foreground_processes: [{ pid: agents[Number(pane_id.slice(1))].pid, name: ['claude', 'codex'][Number(pane_id.slice(1))] }] } }),
    'pane.read': () => ({ type: 'pane_read', read: { text: '? for shortcuts\nesc to interrupt' } }),
    'agent.prompt': () => ({ type: 'agent_prompted', agent: {} }), 'agent.send_keys': () => ({ type: 'ok' }),
  });
  if (!m) return;
  m.fake.snapshot = { panes: [0, 1].map(i => ({ pane_id: `p${i}`, agent_session: null })) };
  const remote = { ...f, home: m.remote, store: path.join(m.remote, '.claude', 'claude-observatory') };
  for (const [i, kind] of ['claude', 'codex'].entries()) {
    record(remote, { id: kind, kind, pane: `p${i}`, pid: agents[i].pid });
    record(f, { id: `r-${kind}`, kind, machine: 'build-box', remoteId: kind });
  }
  const marker = path.join(m.remote, 'executed');
  const text = `" ' $(touch ${marker}) \`touch ${marker}\`\n--machine evil --help\tend`;
  const r = await runAsync(f, ['agent', 'tell', 'r-claude', 'r-codex', text, '--json'], { env: { OAK_DELEGATED: 'local-teller' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(m.fake.calls('agent.prompt').map(p => p.text), [text, text]);
  assert.equal(fs.existsSync(marker), false);
  for (const kind of ['claude', 'codex']) {
    const rec = JSON.parse(fs.readFileSync(path.join(remote.store, 'delegated', `${kind}.json`)));
    assert.deepEqual(rec.messages.map(x => [x.from, x.text]), [['local-teller', text]]);
  }
  assert.ok(m.sshCalls() >= 2);
  const h = await commHerdr(t, f); if (!h) return;
  record(f, { id: 'local', pane: 'p0', pid: h.live[0].pid });
  record(remote, { id: 'codex', kind: 'codex', state: 'gone' });
  const failed = await runAsync(f, ['agent', 'tell', 'local', 'r-codex', 'must not send']);
  assert.equal(failed.status, 1); assert.deepEqual(h.fake.calls('agent.prompt'), []);
  const long = 'more scope\n'.repeat(25000), file = path.join(f.home, 'long.txt');
  fs.writeFileSync(file, long);
  const large = await runAsync(f, ['agent', 'tell', 'r-claude', '--file', file, '--json']);
  assert.equal(large.status, 0, large.stderr); assert.equal(m.fake.calls('agent.prompt').at(-1).text, long);
});

async function queueFixture(t) {
  const f = fixture(t), agent = liveAgent(t, 'codex');
  const fake = await fakeHerdr(t, {
    'tab.create': () => ({ type: 'tab_created', tab: { tab_id: 'qt', workspace_id: 'qw' }, root_pane: { pane_id: 'qp' } }),
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: processInfo.idle(pane_id) }),
    'agent.start': () => ({ type: 'agent_started', agent: {}, argv: [] }),
    'pane.read': () => ({ type: 'pane_read', read: { text: '? for shortcuts\nesc to interrupt' } }),
    'agent.prompt': () => ({ type: 'agent_prompted', agent: {} }), 'agent.send_keys': () => ({ type: 'ok' }),
    'tab.close': () => ({ type: 'ok' }),
  });
  if (!fake) return null;
  fake.snapshot = { panes: [{ pane_id: 'p1', agent_session: null }, { pane_id: 'qp', agent_session: null }] };
  f.env.HERDR_SOCKET_PATH = fake.socketPath;
  f.env.OAK_AGENT_WAIT_MS = '200';
  const brief = path.join(f.home, 'q-brief.md'); fs.writeFileSync(brief, '# Queued work\n');
  const start = (name, after, extra = []) => runAsync(f, ['agent', 'start', '--kind', 'codex', '--brief', brief, '--cwd', f.work,
    '--name', name, '--after', ...after, '--json', ...extra]);
  t.after(async () => {
    // Cancel and let every explicitly requested background job leave before its fixture is removed.
    const dir = path.join(f.store, 'delegated');
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const file = path.join(dir, n), rec = JSON.parse(fs.readFileSync(file));
      if (rec.state === 'queued') fs.writeFileSync(file, JSON.stringify({ ...rec, closedMs: Date.now(), state: 'gone' }));
    }
    await sleep(500);
  });
  return { f, fake, agent, start };
}
async function eventually(check, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await sleep(100); }
  assert.fail('condition did not become true');
}

test('agent start --after: queued immediately, survives launcher exit, waits for every dependency then starts once', { skip: posix }, async t => {
  const q = await queueFixture(t); if (!q) return;
  const { f, fake, agent, start } = q;
  const a = record(f, { id: 'a', kind: 'codex', pid: agent.pid }), b = record(f, { id: 'b', kind: 'codex', pid: agent.pid });
  const r = await start('q', ['a', 'b']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).state, 'queued');
  assert.deepEqual(JSON.parse(r.stdout).after, ['a', 'b']);
  await sleep(700); assert.deepEqual(fake.calls('agent.start'), []);
  assert.match((await runAsync(f, ['agent', 'list'])).stdout, /q  queued.*waiting on a, b/s);
  fs.writeFileSync(a.report, 'done'); await sleep(700); assert.deepEqual(fake.calls('agent.start'), []);
  fs.writeFileSync(b.report, 'done');
  await eventually(() => fake.calls('agent.send_keys').length === 1);
  const rec = JSON.parse(fs.readFileSync(path.join(f.store, 'delegated', 'q.json')));
  assert.equal(rec.id, 'q'); assert.equal(fake.calls('tab.create')[0].env.OAK_DELEGATED, 'q');
  assert.equal(fake.calls('agent.start').length, 1);
});

test('agent start --after: failed dependency never starts; after-any accepts gone; unknown and cycles refused before queue', { skip: posix }, async t => {
  const q = await queueFixture(t); if (!q) return;
  const { f, fake, start } = q;
  record(f, { id: 'bad', state: 'gone' });
  const failed = await start('failed', ['bad']);
  assert.equal(failed.status, 0, failed.stderr);
  await eventually(() => JSON.parse(fs.readFileSync(path.join(f.store, 'delegated', 'failed.json'))).state === 'gone');
  const rec = JSON.parse(fs.readFileSync(path.join(f.store, 'delegated', 'failed.json')));
  assert.match(rec.error, /dependency.*bad.*gone/i); assert.equal(fake.calls('agent.start').length, 0);
  for (const [name, after, error] of [['unknown', ['missing'], /unknown|no delegated/], ['cycle', ['cycle'], /cycle/]]) {
    const r = await start(name, after); assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, error);
    assert.equal(fs.existsSync(path.join(f.store, 'delegated', `${name}.json`)), false);
  }
  record(f, { id: 'loop-a', state: 'queued', after: ['loop-b'] }); record(f, { id: 'loop-b', state: 'queued', after: ['loop-a'] });
  const cyclic = await start('transitive', ['loop-a']); assert.equal(cyclic.status, 1); assert.match(cyclic.stderr, /cycle/);
  const any = await start('any', ['bad'], ['--after-any']); assert.equal(any.status, 0, any.stderr);
  await eventually(() => fake.calls('agent.send_keys').length === 1);
});

test('agent start --after: close cancels a queued agent, including after dependencies finish', { skip: posix }, async t => {
  const q = await queueFixture(t); if (!q) return;
  const { f, fake, agent, start } = q;
  const dep = record(f, { id: 'dep', kind: 'codex', pid: agent.pid });
  assert.equal((await start('cancel', ['dep'])).status, 0);
  const closed = await runAsync(f, ['agent', 'close', 'cancel', '--json']);
  assert.equal(closed.status, 0, closed.stderr); assert.equal(JSON.parse(closed.stdout).closed[0].state, 'gone');
  fs.writeFileSync(dep.report, 'done'); await sleep(1000);
  assert.deepEqual(fake.calls('tab.create'), []); assert.deepEqual(fake.calls('tab.close'), []);
});

test('agent start --after: a remote dependency finishes through its synced database records while SSH is down', { skip: skipIndex || posix }, async t => {
  const q = await queueFixture(t); if (!q) return;
  const { f, fake, start } = q;
  const m = await savedMachine(t, f, {}); if (!m) return;
  m.fake.snapshot = {};
  const remote = { ...f, home: m.remote, store: path.join(m.remote, '.claude', 'claude-observatory') };
  record(remote, { id: 'remote-dep', state: 'done', endedMs: Date.now(), pane: null });
  record(f, { id: 'remote-dep', machine: 'build-box', remoteId: 'remote-dep', state: 'working' });
  f.env.SSH_FAKE_EXIT = '255';
  assert.equal((await start('synced', ['remote-dep'])).status, 0);
  await sleep(500); assert.deepEqual(fake.calls('agent.start'), []);
  const published = await m.onRemote(['__sync-inventory', '--json', '--publish', '--user', os.userInfo().username]);
  assert.equal(published.status, 0, published.stderr);
  const records = path.join(remote.store, 'records');
  const [host] = fs.readdirSync(records).filter(n => /^[0-9a-f]{12}$/.test(n));
  fs.cpSync(path.join(records, host), path.join(f.store, 'records', host), { recursive: true });
  fs.mkdirSync(path.join(f.store, 'sync'), { recursive: true });
  fs.writeFileSync(path.join(f.store, 'sync', 'status.json'), JSON.stringify({ at: Date.now(), status: 'ok', machines: [
    { label: 'build-box', host, status: 'ok', lastOkAt: Date.now() },
  ] }));
  await eventually(() => fake.calls('agent.send_keys').length === 1);
  const dep = JSON.parse(fs.readFileSync(path.join(f.store, 'delegated', 'remote-dep.json')));
  assert.equal(dep.remote.via, 'index'); assert.equal(dep.state, 'done');
});

test('agent start --after: a queued remote start keeps its local id and launches on the saved machine', { skip: posix }, async t => {
  const f = fixture(t);
  const m = await savedMachine(t, f, {
    'tab.create': () => ({ type: 'tab_created', tab: { tab_id: 'rt', workspace_id: 'rw' }, root_pane: { pane_id: 'rp' } }),
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: processInfo.idle(pane_id) }),
    'agent.start': () => ({ type: 'agent_started', agent: {}, argv: [] }),
    'pane.read': () => ({ type: 'pane_read', read: { text: '? for shortcuts\nesc to interrupt' } }),
    'agent.prompt': () => ({ type: 'agent_prompted', agent: {} }), 'agent.send_keys': () => ({ type: 'ok' }),
  });
  if (!m) return;
  m.fake.snapshot = { panes: [{ pane_id: 'rp', agent_session: null }] };
  const brief = path.join(m.remote, 'remote-brief.md'); fs.writeFileSync(brief, '# Remote queued work');
  record(f, { id: 'done', state: 'done' });
  const r = await runAsync(f, ['agent', 'start', '--kind', 'codex', '--brief', brief, '--cwd', m.remote,
    '--name', 'remote-q', '--machine', 'build-box', '--after', 'done', '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).state, 'queued');
  await eventually(() => {
    const rec = JSON.parse(fs.readFileSync(path.join(f.store, 'delegated', 'remote-q.json')));
    return rec.remoteId === 'remote-q' && rec.state === 'starting';
  });
  assert.equal(m.fake.calls('agent.start').length, 1);
  assert.equal(m.fake.calls('tab.create')[0].env.OAK_DELEGATED, 'remote-q');
  assert.match(m.fake.calls('agent.prompt')[0].text, /Remote queued work/);
});

test('agent tell: native transcript ingestion shows the submitted text in Prompts and Feed for both kinds', { skip: posix }, async t => {
  for (const kind of ['claude', 'codex']) {
    const f = fixture(t), agent = liveAgent(t, kind);
    const session = kind === 'codex' ? '0199dddd-0000-7000-8000-0000000000c1' : 's-tell';
    const file = kind === 'claude' ? transcript(f, session, []) : path.join(f.env.CODEX_HOME, 'sessions', `rollout-${session}.jsonl`);
    if (kind === 'codex') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: session, cwd: f.work } }) + '\n');
    }
    let pasted = '';
    const fake = await fakeHerdr(t, {
      'pane.process_info': () => ({ type: 'pane_process_info', process_info: { shell_pid: 1, foreground_processes: [{ pid: agent.pid, name: kind }] } }),
      'pane.read': () => ({ type: 'pane_read', read: { text: '? for shortcuts' } }),
      'agent.prompt': ({ text }) => { pasted = text; return { type: 'agent_prompted', agent: {} }; },
      'agent.send_keys': () => {
        const row = kind === 'claude' ? { type: 'user', sessionId: session, cwd: f.work, message: { role: 'user', content: pasted } }
          : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: pasted }] } };
        fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\n');
        return { type: 'ok' };
      },
    });
    if (!fake) return;
    fake.snapshot = { panes: [{ pane_id: 'p1', agent_session: { value: session } }] };
    f.env.HERDR_SOCKET_PATH = fake.socketPath;
    record(f, { id: kind, kind, session, pid: agent.pid });
    const text = 'Please also verify the copper parser';
    const r = await runAsync(f, ['agent', 'tell', kind, text]); assert.equal(r.status, 0, r.stderr);
    for (const verb of ['prompts', 'feed']) {
      const view = await runAsync(f, [verb, '--session', session, '--root', f.work, '--json']);
      assert.equal(view.status, 0, view.stderr); assert.ok(view.stdout.includes(text), `${kind} ${verb}: ${view.stdout}`);
    }
  }
});
