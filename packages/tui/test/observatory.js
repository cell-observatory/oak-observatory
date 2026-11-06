// The suite's isolation (private store and Codex home, and a herdr socket that does not exist) even when
// this file runs on its own: runtimes here drive real herdr transports, and from a herdr pane the
// environment names the person's live server.
require('../../../test/bootstrap.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('../../core/dist');
const tui = require('../dist');
const { fixture, pane, snapshot, syncView } = require('./fixtures/observatory');
const { workspaceFixture } = require('../../core/test/fixtures/workspace-fixture.cjs');
// Rows print clock times in the reader's local zone (relTime); the goldens are written in UTC.
process.env.TZ = 'UTC';
const g = tui.glyphs('ascii');

test('tab labels: Observatory filters placeholders on each machine before Workers arrives', () => {
  for (const label of ['1', '', '   ', 'claude', 'codex', 'Demo checks', '2024']) {
    const state = fixture();
    for (const machine of state.observatory.machines) {
      machine.snapshot.tabs = [{ tab_id: 'elsewhere', workspace_id: 'other', number: 1, label: '1' },
        { tab_id: 'tab', workspace_id: 'w1', number: 8, label }];
    }
    const named = ['Demo checks', '2024'].includes(label);
    const rows = tui.observatorySessions(state);
    assert.equal(rows.find(r => r.session === 'claude-conversation').label, named ? label : 'Fix the demo');
    assert.equal(rows.find(r => r.session === 'remote-done').label, named ? label : 'Remote review');
    assert.equal(tui.statuslineDataFor(state).title, 'Fix the demo');
  }
});

for (const check of ['once-tab-labels', 'live-tab-labels']) test(`tab labels: ${check} keeps session titles and user tab names`, () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/observatory-app-probe.cjs')], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_APP_FIX_CHECK: check },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, new RegExp(`PASS: ${check}`));
});

test('Observatory process refresh reads only visible tails on the owner, throttles and rejects stale selection', async t => {
  const state = tui.selectAndPin(fixture(), 'remote-done', 'obs-detail', 'build', { processId: 'shell-0' });
  const calls = [];
  const process = { id: 'shell-0', command: 'synthetic build', running: true, status: 'running', runtimeMs: 10, exitCode: null };
  const fake = fakeRuntime(state, {}, { watch: false, visibleProcesses: () => ['shell-1'], reader: { ...testReader(),
    processes: async (...args) => { calls.push(args); return { processes: [process], previews: {}, selected: { process, outputTail: 'OWNER OUTPUT' } }; },
  } });
  t.after(() => fake.runtime.close());
  await fake.runtime.load('obs-detail');
  assert.deepEqual(calls[0].slice(2), ['shell-0', ['shell-1'], 'build-box']);
  await fake.runtime.tail(); await fake.runtime.tail();
  assert.equal(calls.length, 1, 'a saved-machine read waits ten seconds');
  assert.match(tui.observatoryDetailRows(state, 120, g, 'none').map(r => r.cells).join('\n'), /OWNER OUTPUT/);
  const pending = deferred();
  const late = fakeRuntime(state, {}, { watch: false, reader: { ...testReader(), processes: () => pending.promise } });
  t.after(() => late.runtime.close());
  const loading = late.runtime.load('obs-detail');
  Object.assign(state, tui.selectAndPin(state, 'claude-conversation'));
  pending.resolve({ processes: [process], previews: {}, selected: { process, outputTail: 'STALE' } });
  await loading;
  assert.equal(state.observatory.details['obs-detail'].processes, undefined);
});

test('worker selection opens its own live log in the detail pane and cannot reply to the parent', async t => {
  const { indexFixture, reply, text } = require('../../core/test/fixtures/index-fixture.cjs');
  const b = indexFixture(t, core);
  const parent = b.claude('claude-conversation', b.work, [reply('parent', [text('PARENT TEXT')])]);
  const file = path.join(path.dirname(parent), 'claude-conversation/subagents/agent-w1.jsonl');
  b.write(file, [{ ...reply('worker', [text('WORKER TEXT')]), isSidechain: true }]);
  const state = tui.selectAndPin(fixture(), 'claude-conversation', 'obs-detail', 'local', { agentId: 'w1' });
  state.observatory.details['obs-detail'].selection.root = b.work;
  let reads = 0;
  const fake = fakeRuntime(state, {}, { watch: false, reader: { ...testReader(),
    feed: async (session, root, id) => { reads++; return core.liveFeed(root, session, { kind: 'agent', id }); },
  } });
  t.after(() => fake.runtime.close());
  await fake.runtime.load('obs-detail');
  assert.equal(state.observatory.details['obs-detail'].selection.agentId, 'w1');
  const render = () => tui.observatoryDetailRows(state, 120, g, 'none').map(r => r.cells).join('\n');
  assert.match(render(), /WORKER TEXT/);
  assert.doesNotMatch(render(), /PARENT TEXT/);
  assert.equal(tui.observatoryReplyRow(state, 'obs-detail', 100, 0), undefined);
  await fake.runtime.tail();
  assert.equal(reads, 1, 'an unchanged worker log makes no child request');
  fs.appendFileSync(file, b.lines([{ ...reply('next', [text('WORKER NEXT')]), isSidechain: true }]));
  await fake.runtime.tail();
  assert.match(render(), /WORKER NEXT/);
  fs.appendFileSync(parent, b.lines([{ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T11:00:00.123Z',
    content: '<task-notification><task-id>w1</task-id><status>completed</status></task-notification>' }]));
  await fake.runtime.tail();
  assert.match(render(), /Worker ended at 2026-10-01T11:00:00.123Z/);
  assert.ok(!fake.calls.some(call => /tab.create|pane.split|pane.send_text/.test(call.method)), 'a worker log creates no terminal and sends no input');
  const back = tui.selectAndPin(state, 'claude-conversation');
  assert.equal(back.observatory.details['obs-detail'].selection.agentId, undefined);
  assert.equal(back.observatory.details['obs-detail'].feed, undefined);
});

test('remote worker log reads the owner, throttles polls, rejects stale selections and reports failures', async t => {
  const state = tui.selectAndPin(fixture(), 'remote-done', 'obs-detail', 'build', { agentId: 'r1' });
  // A local copy of the parent must not retarget an explicitly selected remote worker.
  state.observatory.machines[0].snapshot.panes.push(pane('copy', 'remote-done', 'idle'));
  const calls = [];
  const fake = fakeRuntime(state, {}, { watch: false, reader: { ...testReader(),
    feed: async (...args) => { calls.push(args); return { workerLogVersion: 1, ref: { kind: 'agent', id: args[2] }, entries: [{ label: 'Remote log', kind: 'reasoning', reasoning: 'Remote worker activity' }], mode: 'live' }; },
  } });
  t.after(() => fake.runtime.close());
  await fake.runtime.load('obs-detail');
  assert.equal(calls[0][3], 'build-box');
  assert.equal(calls[0][2], 'r1');
  await fake.runtime.tail(); await fake.runtime.tail();
  assert.equal(calls.length, 1, 'remote snapshots wait ten seconds');
  assert.match(JSON.stringify(state.observatory.details['obs-detail'].feed), /Remote worker activity/);
  const pending = deferred();
  const late = fakeRuntime(state, {}, { watch: false, reader: { ...testReader(), feed: () => pending.promise } });
  t.after(() => late.runtime.close());
  const loading = late.runtime.load('obs-detail');
  Object.assign(state, tui.selectAndPin(state, 'claude-conversation'));
  pending.resolve({ ref: { kind: 'agent', id: 'r1' }, entries: [], workerLogVersion: 1 });
  await loading;
  assert.equal(state.observatory.details['obs-detail'].feed, undefined);
  Object.assign(state, tui.selectAndPin(state, 'remote-done', 'obs-detail', 'build', { agentId: 'r1' }));
  const down = fakeRuntime(state, {}, { watch: false, reader: { ...testReader(), feed: async () => { throw new Error('build-box is not reachable over ssh'); } } });
  t.after(() => down.runtime.close());
  await down.runtime.load('obs-detail');
  assert.match(state.observatory.details['obs-detail'].error, /not reachable over ssh/);
});
// The master is memoized on the identity of what it reads, which the runtime and the app replace rather
// than mutate. These tests edit a fixture in place between renders, so each render hands it new arrays.
const fresh = state => ({ ...state, observatory: state.observatory && { ...state.observatory, machines: state.observatory.machines.map(m => ({ ...m })) },
  views: state.views && { ...state.views, sessions: state.views.sessions && { ...state.views.sessions, sessions: [...(state.views.sessions.sessions ?? [])] } } });
const render = (state, width = 82, depth = 'none') => tui.rowsFor(fresh(state), width, g, depth);
const lines = rows => rows.map(r => r.cells).join('\n');
const turn = (records = []) => ({ ts: 1, update: { sessionUpdate: 'turn_end', stopReason: 'end_turn', edits: records.length, ts: 1, records } });
function golden(name, actual) {
  const file = path.join(__dirname, 'fixtures', `${name}.txt`);
  if (process.env.OAK_UPDATE_GOLDENS === '1') fs.writeFileSync(file, actual + '\n');
  assert.equal(actual, fs.readFileSync(file, 'utf8').trimEnd(), `${name} golden`);
}
function isolated(t) {
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'OAK_TAB', 'TZ'].map(k => [k, process.env[k]]));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-observatory-test-'));
  const root = path.join(base, 'work'); fs.mkdirSync(root);
  process.env.TZ = 'UTC';
  process.env.HOME = process.env.USERPROFILE = base;
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  process.env.CODEX_HOME = path.join(base, 'codex');
  // A socket that does not exist, never herdr's default: with XDG_CONFIG_HOME set that is the live one.
  delete process.env.HERDR_PANE_ID; process.env.HERDR_SOCKET_PATH = path.join(base, 'no-herdr.sock'); delete process.env.OAK_TAB;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(base, { recursive: true, force: true }); });
  return { base, root };
}
function transcript(t, kind) {
  const { root } = isolated(t);
  const session = `${kind}-conversation`;
  const dir = kind === 'claude' ? core.projectDir(root) : path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '18');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, kind === 'claude' ? `${session}.jsonl` : `rollout-2026-09-18T15-00-00-${session}.jsonl`);
  fs.writeFileSync(file, workspaceFixture(`conversation-${kind}.jsonl`, root));
  core.ensureStore(session);
  const beforeBlob = core.writeBlob(session, Buffer.from('old\n'));
  const afterBlob = core.writeBlob(session, Buffer.from('new\n'));
  const record = core.appendLog(session, { ts: Date.parse(kind === 'claude' ? '2026-09-18T14:00:01.500Z' : '2026-09-18T15:00:04.500Z'), tool: kind === 'claude' ? 'Edit' : 'apply_patch', file: path.join(root, kind === 'claude' ? 'demo.ts' : 'codex.ts'), beforeBlob, afterBlob, status: 'pending' });
  return { root, file, session, record };
}
function pin(state, session = 'claude-conversation', paneId = 'obs-detail', machineId) {
  return tui.selectAndPin(state, session, paneId, machineId);
}

test('Observatory master: two machines, authoritative pane states, unresolved retention and archived toggle', () => {
  const state = fixture();
  const rows = render(state);
  const text = lines(rows);
  golden('observatory-master', text);
  for (const status of ['blocked', 'working', 'idle', 'unknown']) assert.ok(text.includes(status));
  // remote-done's pane reads done, so it folds under build-box with its pending count (df1 brief: a done session folds
  // even with pending edits); its fold, opened, shows herdr's done over the session's own idle phase.
  assert.match(lines(render({ ...state, open: new Set(['done:build']) })), /Remote review\n +\* done · GPT/);
  // An idle, unresolved (paneless, pending) session folds into `earlier`; it is retained, not lost.
  assert.ok(text.includes('earlier'));
  assert.ok(!text.includes('Recover edits'), 'an idle unresolved session is folded, not inline');
  assert.ok(lines(render({ ...state, open: new Set(['earlier']) })).includes('Recover edits'), 'opening earlier reveals it');
  assert.ok(!text.includes('Finished yesterday'));
  assert.ok(lines(render({ ...state, allSessions: true, open: new Set(['archived']) })).includes('Finished yesterday'));
  assert.deepEqual(rows.filter(r => r.key.startsWith('machine:')).map(r => r.cells.replace(' [W window]', '')), ['laptop', 'build-box']);
  assert.ok(text.indexOf('claude · p1') < text.indexOf('Fix the demo'));
  // The master lists sessions; a pinned session's detail lists its Workers (2026-09-26).
  assert.ok(!rows.some(r => r.cells.includes('Workers')));
  assert.ok(!text.includes('laptop · claude'), 'machine is a tree node, not an agent label');
  state.views.remoteSessions = { rows: [{ id: 'old-ssh-row', title: 'Retired remote merge' }] };
  assert.ok(!lines(render({ ...state, allSessions: true })).includes('Retired remote merge'));
});

// oak sync, while it is in use here: under this machine its last run and its backup, under each saved machine what the run
// pulled from it or why it could not, in the CLI's words (each line's `text`), whole; a machine that never chose to sync
// sees none of it.
test('Observatory master: oak sync\'s last run under each machine, in the CLI\'s words, wrapped whole, and only while sync is in use', () => {
  const state = fixture();
  state.sync = syncView();
  const rows = render(state, 60);
  const of = (key) => rows.filter(r => r.key === key || r.key.startsWith(`${key}:wrap:`)).map(r => r.cells.trim()).join(' ');
  assert.equal(of('machine:local:sync'), 'sync · last run 14:00:30 (partial) · 1 conflict in the inbox · 1 warning in the options');
  assert.equal(of('machine:local:backup'), `backup · /mnt/share/oak-backup · key a11b-f2dc-f733-a548 · ${state.sync.last.machines[1].text}`,
    'the refusal and its next step, whole');
  assert.equal(of('machine:build:sync'), 'sync · pulled 3 files, 1KB at 14:00:30');
  for (const r of rows) assert.ok(tui.displayWidth(r.cells) <= 60, `"${r.cells}" fits the pane`);
  // Continuations of the machine's row, which the arrows step over as over a session's stat row.
  const syncRows = rows.filter(r => /^machine:[^:]+:(sync|backup)/.test(r.key));
  assert.ok(syncRows.length > 3, 'control: the backup line wraps');
  for (const r of syncRows) assert.equal(r.cont, true, r.key);
  // Under its own machine, between the machine and its workspaces.
  const keys = rows.map(r => r.key);
  assert.equal(keys.indexOf('machine:local:sync'), keys.indexOf('machine:local') + 1);
  assert.ok(keys.indexOf('machine:build') < keys.indexOf('machine:build:sync') && keys.indexOf('machine:build:sync') < keys.indexOf('workspace:build:herdr:w1'));
  // A machine the run could not reach says why, and when it last gave something.
  state.sync = syncView();
  state.sync.last.machines[0] = { ...state.sync.last.machines[0], status: 'unreachable', detail: 'Connection refused', text: 'could not be reached over ssh: Connection refused (last pulled 13:00:00)' };
  assert.equal(render(state, 200).find(r => r.key === 'machine:build:sync').cells, '  sync · could not be reached over ssh: Connection refused (last pulled 13:00:00)');
  // Running now; a backup on a saved machine; and a saved machine the last run did not ask.
  state.sync = syncView({ running: true, backup: { kind: 'machine', label: 'build-box' }, conflicts: [] });
  state.sync.last = { ...state.sync.last, warnings: [], machines: [] };
  const run = render(state, 200);
  assert.equal(run.find(r => r.key === 'machine:local:sync').cells, '  sync · running now');
  assert.equal(run.find(r => r.key === 'machine:local:backup').cells, '  backup · build-box');
  assert.equal(run.find(r => r.key === 'machine:build:sync').cells, '  sync · not asked in the last run (14:00:30)');
  // Not in use (no run here, no backup chosen, no conflict open): the master is as it was, row for row.
  state.sync = syncView({ setUp: false, last: null, backup: null, conflicts: [] });
  assert.equal(lines(render(state)), lines(render(fixture())));
  assert.ok(!lines(render(state)).includes('sync ·'));
});

// A saved machine's sessions read from this machine's index (oak sync brought its records; no ssh) say so under it, with
// when that run read it; one read from the machine itself says nothing more.
test('Observatory master: a saved machine\'s sessions read from the local index say so under it, with when oak sync read it', () => {
  const state = fixture();
  const build = state.observatory.machines.find((m) => !m.local);
  const at = Date.UTC(2026, 8, 18, 13, 55);
  build.sessions = { ...(build.sessions ?? { sessions: [] }), fromIndex: true, syncedAt: at };
  const rows = render(state, 200);
  const keys = rows.map((r) => r.key);
  assert.equal(rows.find((r) => r.key === `machine:${build.id}:records`)?.cells, '  sessions · from its records, synced 13:55:00');
  assert.equal(rows.find((r) => r.key === `machine:${build.id}:records`).cont, true, 'a continuation of the machine\'s row');
  assert.equal(keys.indexOf(`machine:${build.id}:records`) > keys.indexOf(`machine:${build.id}`), true);
  delete build.sessions.fromIndex;
  assert.ok(!render(state, 200).some((r) => r.key === `machine:${build.id}:records`), 'read from the machine: nothing more');
  assert.ok(!render(state, 200).some((r) => r.key === 'machine:local:records'), 'nor under this machine');
});

// 0.10.0 made every timestamp a clock time ("Timestamps now show the exact time, not an age"); the
// Observatory master still printed "1m ago".
test('Observatory master: a session\'s last activity reads as a clock time, as in every other list (2026-09-26)', () => {
  const text = lines(render(fixture()));
  assert.match(text, /· 14:00:00$/m, 'a minute before the fixture\'s 14:01:00, printed as the time it was');
  assert.doesNotMatch(text, /\bago\b/);
});

// Sessions and agents are organized by workspace.
const workspaceOfRow = (rows, session) => {
  const at = rows.findIndex(r => r.scope?.session === session && r.key.startsWith('session:') && !r.cont);
  assert.ok(at >= 0, `${session} is listed`);
  return rows.slice(0, at).findLast(r => r.key.startsWith('workspace:')).cells.replace(' [W window]', '').trim();
};
const workspaceHeaders = (state, machineId) => render(state).filter(r => r.key.startsWith(`workspace:${machineId}:`)).map(r => r.cells.replace(' [W window]', '').trim());

test('Observatory master: each machine groups its panes by herdr workspace, labelled as that machine labels it', () => {
  const state = fixture();
  const rows = render(state);
  assert.deepEqual(rows.filter(r => r.key.startsWith('workspace:')).map(r => [r.key, r.cells.replace(' [W window]', '')]),
    [['workspace:local:herdr:w1', '  demo'], ['workspace:local:herdr:w2', '  docs'], ['workspace:build:herdr:w1', '  review']],
    'the same workspace id carries each machine\'s own label');
  // remote-done is done, so it is listed in build-box's done fold, opened here, under its workspace's label (df1 brief).
  const opened = render({ ...state, open: new Set(['done:build']) });
  assert.deepEqual(['claude-conversation', 'working', 'idle', 'remote-done', 'unknown'].map(s => workspaceOfRow(opened, s)), ['demo', 'demo', 'docs', 'review', 'review']);
  assert.equal(rows.find(r => r.key === 'pane:local:p3').cells, '    v claude · p3', 'the agent kind and pane id stay on the pane line');
  assert.equal(rows.find(r => r.key === 'pane:local:p3').scope.session, 'idle', 'the pane line belongs to the session it runs');
  assert.equal(rows.find(r => r.key === 'workspace:local:herdr:w2').scope, undefined, 'a workspace header is not a session');
  // A pane in a workspace the snapshot does not list is filed under that workspace's id.
  state.observatory.machines[0].snapshot.panes[2].workspace_id = 'w9';
  assert.equal(workspaceOfRow(render(state), 'idle'), 'w9');
  // The filter matches the workspace too.
  const zeta = fixture();
  zeta.observatory.machines[0].snapshot.workspaces[1].label = 'zeta-lab';
  const filtered = lines(render({ ...zeta, filter: 'zeta' }));
  assert.match(filtered, /Waiting for prompt/);
  assert.doesNotMatch(filtered, /Fix the demo|Run checks|Remote review|Unknown state/);
});

test('Observatory master: workspaces and their sessions run newest first; the watched session\'s workspace leads its machine', () => {
  const state = fixture();
  const [p1, p2, p3] = state.observatory.machines[0].snapshot.panes;
  const meta = id => state.views.sessions.sessions.find(s => s.id === id);
  const sessionsIn = () => render(state).filter(r => r.key.startsWith('session:local:') && !r.cont && r.key.split(':').length === 4).map(r => r.scope.session);
  meta('idle').lastActiveMs = state.now;
  assert.deepEqual(workspaceHeaders(state, 'local'), ['demo', 'docs'], 'a live agent counts as now, ahead of a newer quiet session');
  // Quiet, not done: a done session folds whatever it has pending (df1 brief), and this test checks recency inline.
  p1.agent_status = 'idle'; p2.agent_status = 'idle';
  assert.deepEqual(workspaceHeaders(state, 'local'), ['docs', 'demo'], 'with every agent quiet, the newest session leads');
  meta('working').lastActiveMs = state.now - 1000; meta('claude-conversation').lastActiveMs = state.now - 5000;
  assert.deepEqual(sessionsIn(), ['idle', 'working', 'claude-conversation'], 'inside a workspace, newest first');
  meta('claude-conversation').current = true;
  assert.deepEqual(workspaceHeaders(state, 'local'), ['demo', 'docs'], 'the workspace of the session OAK watches comes first');
  assert.deepEqual(workspaceHeaders(state, 'build'), ['review'], 'and only on its own machine');
  delete meta('claude-conversation').current;
  // Two live workspaces keep herdr's order however their clocks interleave, so the rows hold still.
  p1.agent_status = 'working'; p3.agent_status = 'working';
  for (const newer of ['idle', 'claude-conversation']) {
    meta(newer).lastActiveMs = state.now + 1000;
    assert.deepEqual(workspaceHeaders(state, 'local'), ['demo', 'docs'], `live workspaces hold herdr's order while ${newer} is newest`);
  }
});

// One project, one group: a paneless session is filed by its project directory's name whether the name
// comes from the fleet's worktree or from core's session row (`~/…`), and core's own label names an
// unknown one (`app` and `~/src/app` were two groups, "no workspace" a third label).
test('Observatory master: a paneless session is filed under its project\'s one name, from either source (2026-09-26)', () => {
  const state = fixture();
  const plain = (id, workspace) => state.views.sessions.sessions.push({ id, title: id, pending: 1, agent: 'claude', model: 'Opus',
    tokens: 1, lastActiveMs: state.now - 1000, phase: 'working', workspace, machine: 'laptop' });
  plain('app-one', '~/src/app'); plain('app-two', '~/src/app'); plain('unplaced', 'Unknown workspace');
  state.views.multitask.agents.push({ session: 'app-one', worktree: '/home/fixture/src/app' });
  const rows = render(state);
  assert.deepEqual(['app-one', 'app-two', 'unplaced'].map(s => workspaceOfRow(rows, s)), ['app', 'app', 'Unknown workspace']);
  assert.equal(rows.filter(r => r.key.startsWith('workspace:local:') && r.cells.trim() === 'app').length, 1, 'one group for the project');
});

test('Observatory master: a paneless live session joins its project, or says it has no workspace', () => {
  const state = fixture();
  // Retained by its pending edit (a paneless session needs one, or to be current), surfaced by working.
  const plain = (id, title, workspace) => state.views.sessions.sessions.push({ id, title, pending: 1, agent: 'claude', model: 'Opus',
    tokens: 1, lastActiveMs: state.now - 1000, phase: 'working', workspace, machine: 'laptop' });
  plain('plain-docs', 'Terminal docs pass', 'docs');
  plain('plain-project', 'Terminal project work', 'Github-project');
  plain('plain-worktree', 'Worktree session', 'Github-checkouts-feature-tree');
  state.views.multitask.agents.push({ session: 'plain-worktree', worktree: '/fixture/checkouts/feature-tree' });
  plain('plain-none', 'Unplaced session', '');
  for (const herdr of ['connected', 'unreachable']) {
    if (herdr === 'unreachable') state.observatory.machines[0] = { id: 'local', label: 'laptop', local: true, error: 'herdr unavailable' };
    const rows = render(state);
    assert.deepEqual(['plain-docs', 'plain-project', 'plain-worktree', 'plain-none'].map(s => workspaceOfRow(rows, s)),
      ['docs', 'Github-project', 'feature-tree', 'Unknown workspace'], `${herdr}: the project OAK knows it by, its directory's name first`);
    assert.equal(rows.filter(r => r.key.startsWith('workspace:local:') && r.cells.trim() === 'docs').length, 1, `${herdr}: a project sharing a workspace's name joins it`);
    assert.ok(!rows.some(r => r.key.startsWith('pane:') && r.scope?.session.startsWith('plain-')), `${herdr}: no pane line for a paneless session`);
    const text = lines(rows);
    assert.ok(text.indexOf('Unplaced session') < text.indexOf('build-box'), `${herdr}: listed under its own machine`);
  }
});

test('Observatory master: a selected session stays in its open fold, and surfaces under its machine while the fold is closed', () => {
  const state = fixture();
  state.scopeWorker = tui.observatorySelection(state, 'unresolved');
  const listed = st => {
    const rows = render(st);
    const at = rows.flatMap((r, i) => (r.key.startsWith('session:') && !r.cont && !r.key.endsWith(':state') && r.scope?.session === 'unresolved' ? [i] : []));
    return { rows, at };
  };
  const closed = listed(state);
  assert.equal(closed.at.length, 1);
  assert.ok(closed.at[0] < closed.rows.findIndex(r => r.key === 'machine:build'), 'closed fold: the selection shows under its machine');
  const open = listed({ ...state, open: new Set(['earlier']) });
  assert.equal(open.at.length, 1);
  const fold = open.rows.findIndex(r => r.key === 'earlier');
  assert.ok(fold >= 0 && open.at[0] > fold, 'open fold: the selection stays where the arrows found it');
});

// A session's workers that are still at it (core's `activeWorkers`) are grouped under it, so they show without
// opening the session and never flood the list: a summary row counting them by state, collapsed by default, and
// open, a sub-group per state (waiting first), each worker two rows as a session is: its title, then its stat row.
const activeWorker = (agentId, title, phase, extra = {}) => ({ agentId, title, phase, phaseConfidence: 'high', model: 'Opus 5.5', edits: 3,
  pending: 3, added: 120, removed: 4, tokens: 1_200_000, lastActiveMs: Date.parse('2026-09-18T14:00:40Z'), ...extra });
const someWorkers = () => [
  activeWorker('a1', 'Review brain code', 'awaiting-permission', { edits: 0, pending: 0, added: 0, removed: 0, tokens: 400_000, lastActiveMs: Date.parse('2026-09-18T13:59:10Z') }),
  activeWorker('a2', 'Review spine code', 'working'),
  activeWorker('a3', 'Review spine schematic', 'awaiting-input', { edits: 1, pending: 1, added: 12, removed: 0, tokens: 350_000, lastActiveMs: Date.parse('2026-09-18T13:59:30Z') }),
  activeWorker('a4', 'Assess brain 3D rendering', 'working', { edits: 7, pending: 5, added: 2100, removed: 88, tokens: 2_600_000, lastActiveMs: Date.parse('2026-09-18T14:00:55Z') }),
];
const group = (rows, session = 'session:local:p2:working') => {
  const from = rows.findIndex(r => r.key === `${session}:state`) + 1;
  let to = from;
  while (rows[to] && !/^(pane|workspace|machine|session):/.test(rows[to].key.replace(/^session:[^:]*:[^:]*:[^:]*:worker:.*/, 'w'))) to++;
  return rows.slice(from, to);
};

test('Observatory master: a session\'s active workers sit under it in one group, collapsed by default (2026-10-23)', () => {
  const state = fixture();
  state.views.sessions.sessions[1].activeWorkers = someWorkers();
  const rows = render(state);
  // Collapsed: one summary row under the session's stat row, counting them by state, working first.
  assert.deepEqual(group(rows).map(r => r.cells), ['        > 4 workers · | 2 working · + 2 blocked']);
  const summary = group(rows)[0];
  assert.deepEqual([summary.key, summary.openPath, summary.scope.session, summary.scope.machineId, summary.scope.workers], ['workers:local:working', 'workers:local:working', 'working', 'local', 'all']);
  assert.equal(rows.filter(r => r.key.startsWith('workers:')).length, 1, 'no other session has a group');
  // Open: a sub-group per state, a person needed first, each worker its title and then its stat row in the
  // session row's terms; two cells deeper per level.
  const open = render({ ...state, open: new Set(['workers:local:working']) }, 100);
  assert.deepEqual(group(open).map(r => r.cells), [
    '        v 4 workers · | 2 working · + 2 blocked',
    '          + blocked (2)',
    '            Review brain code',
    '              + blocked · Opus 5.5 · 400k tok · 0 pending · 13:59:10',
    '            Review spine schematic',
    '              + blocked · Opus 5.5 · 1 edit · +12 −0 · 350k tok · 1 pending · 13:59:30',
    '          | working (2)',
    '            Review spine code',
    '              | working · Opus 5.5 · 3 edits · +120 −4 · 1.2M tok · 3 pending · 14:00:40',
    '            Assess brain 3D rendering',
    '              | working · Opus 5.5 · 7 edits · +2k −88 · 2.6M tok · 5 pending · 14:00:55',
  ]);
  const rowOf = key => open.find(r => r.key === key);
  assert.deepEqual([rowOf('workers:local:working:blocked').scope.workers, rowOf('workers:local:working:working').scope.workers], ['blocked', 'working'], 'each header is a row of its own to pick');
  const title = rowOf('session:local:p2:working:worker:a2'), line = rowOf('session:local:p2:working:worker:a2:state');
  assert.deepEqual([title.scope.session, title.scope.machineId, title.scope.agentId, !!title.cont], ['working', 'local', 'a2', false]);
  assert.deepEqual([line.scope.agentId, line.cont], ['a2', true], 'its stat row continues its title');
  // A state with no worker in it has no header.
  state.views.sessions.sessions[1].activeWorkers = someWorkers().filter(w => w.phase === 'working');
  assert.deepEqual(group(render({ ...state, open: new Set(['workers:local:working']) }, 100)).map(r => r.cells.trim().split(' · ')[0]),
    ['v 2 workers', '| working (2)', 'Review spine code', '| working', 'Assess brain 3D rendering', '| working']);
  // The ascii tier's fold marks; the unicode tier's own.
  state.views.sessions.sessions[1].activeWorkers = someWorkers();
  const uni = tui.rowsFor(fresh({ ...state, open: new Set(['workers:local:working']) }), 82, tui.glyphs('unicode'), 'none');
  assert.match(group(uni)[0].cells, /^ {8}▾ 4 workers · ⠼|^ {8}▾ 4 workers · [⠋⠙⠹⠸⠼⠴⠦⠧] 2 working · [◐◓◑◒] 2 blocked$/);
});

test('Observatory master: a worker group\'s spinners and colours are the session rows\' own, wherever a row wraps (2026-10-23)', () => {
  const state = { ...fixture(), open: new Set(['workers:local:working']) };
  state.views.sessions.sessions[1].activeWorkers = someWorkers();
  const cell = row => row.cells.trimStart().split(' · ')[0];
  for (const now of [state.now, state.now + 120, state.now + 380]) {
    const rows = tui.rowsFor({ ...fresh(state), now }, 120, g, 'truecolor');
    const k = key => rows.find(r => r.key === key);
    const working = cell(k('session:local:p2:working:state')), blocked = cell(k('session:local:p1:claude-conversation:state'));
    assert.equal(cell(k('session:local:p2:working:worker:a2:state')), working, 'a working worker, as a working session draws it');
    assert.equal(cell(k('session:local:p2:working:worker:a1:state')), blocked, 'one waiting on a person: the blocked face, word and all, as herdr says it');
    // A row with colour in it closes it at its end.
    assert.equal(k('workers:local:working:working').cells, `          ${working} (2)\x1b[0m`);
    assert.equal(k('workers:local:working').cells, `        ${tui.glyphs('ascii').open} 4 workers · ${working.replace('working', '2 working')} · ${blocked.replace('blocked', '2 blocked')}\x1b[0m`);
  }
  // Every spinner moves with the frame: the summary's two, each header's and each worker's.
  const frame = now => tui.rowsFor({ ...fresh(state), now }, 120, g, 'none');
  const a = frame(state.now), b = frame(state.now + 380);
  for (const key of ['workers:local:working', 'workers:local:working:blocked', 'workers:local:working:working', 'session:local:p2:working:worker:a1:state', 'session:local:p2:working:worker:a2:state'])
    assert.notEqual(a.find(r => r.key === key).cells, b.find(r => r.key === key).cells, `${key} animates`);
  // However narrow the pane, no stand-in is left undrawn on a row it wrapped onto.
  for (const width of [24, 30, 41, 60]) {
    const rows = tui.rowsFor({ ...fresh(state), now: state.now }, width, g, 'none');
    assert.ok(!rows.some(r => /[]/.test(r.cells)), `${width} columns: ${lines(rows.filter(r => /[]/.test(r.cells)))}`);
  }
  // A long title wraps under its own indent, every word kept.
  const long = 'Audit every capture hook for the permission prompts a subagent raises and the calls they wait on';
  state.views.sessions.sessions[1].activeWorkers = [activeWorker('w1', long, 'working')];
  const narrow = render(state, 40);
  const at = narrow.findIndex(r => r.key === 'session:local:p2:working:worker:w1');
  const title = narrow.slice(at).filter((r, i) => i === 0 || r.key.startsWith('session:local:p2:working:worker:w1:wrap:'));
  assert.ok(title.length > 2 && title.every(r => r.cells.startsWith('            ') && tui.displayWidth(r.cells) <= 40), lines(title));
  assert.equal(title.map(r => r.cells.trim()).join(' '), long);
});

test('Observatory master: a worker group keeps its fold across a re-poll; a finished worker drops out, the last takes the group (2026-10-23)', () => {
  const state = { ...fixture(), open: new Set(['workers:local:working']) };
  state.views.sessions.sessions[1].activeWorkers = someWorkers();
  const titles = st => group(render(st)).filter(r => /:worker:[^:]+$/.test(r.key)).map(r => r.cells.trim());
  assert.deepEqual(titles(state), ['Review brain code', 'Review spine schematic', 'Review spine code', 'Assess brain 3D rendering']);
  // The next poll's listing is a new payload: the group is still open.
  state.views = { ...state.views, sessions: { sessions: state.views.sessions.sessions.map(r => ({ ...r, activeWorkers: r.activeWorkers?.map(w => ({ ...w })) })) } };
  assert.equal(titles(state).length, 4, 'still open');
  // A worker that finished is no longer in the listing: its rows go, and the counts with it.
  state.views.sessions.sessions[1].activeWorkers = someWorkers().filter(w => w.agentId !== 'a3');
  assert.deepEqual(titles(state), ['Review brain code', 'Review spine code', 'Assess brain 3D rendering']);
  assert.equal(group(render(state))[0].cells, '        v 3 workers · | 2 working · + 1 blocked');
  // A finished worker an older OAK still lists is not drawn either: the group counts only those still at it.
  state.views.sessions.sessions[1].activeWorkers = [...someWorkers().slice(0, 2), activeWorker('a9', 'Done already', 'done')];
  assert.equal(group(render(state))[0].cells, '        v 2 workers · | 1 working · + 1 blocked');
  state.views.sessions.sessions[1].activeWorkers = [];
  assert.deepEqual(group(render(state)), [], 'the last one finished: no group');
});

test('Observatory master: the mark follows the picked row of a worker group, and falls back to its session (2026-10-23)', () => {
  const state = { ...fixture(), open: new Set(['workers:local:working']) };
  state.views.sessions.sessions[1].activeWorkers = someWorkers();
  // The unicode tier, whose fold marks are not the selection's `>`.
  const draw = st => tui.rowsFor(fresh(st), 100, tui.glyphs('unicode'), 'none');
  const marked = scope => draw({ ...state, scopeWorker: { ...tui.observatorySelection(state, 'working', 'local'), ...scope } })
    .filter(r => r.cells.trimStart().startsWith('> ')).map(r => r.key);
  assert.deepEqual(marked({}), ['session:local:p2:working']);
  assert.deepEqual(marked({ workers: 'all' }), ['workers:local:working']);
  assert.deepEqual(marked({ workers: 'blocked' }), ['workers:local:working:blocked']);
  assert.deepEqual(marked({ agentId: 'a4' }), ['session:local:p2:working:worker:a4']);
  assert.deepEqual(marked({ agentId: 'gone' }), ['session:local:p2:working'], 'a worker that finished since: its session');
  assert.deepEqual(draw({ ...state, open: new Set(), scopeWorker: { ...tui.observatorySelection(state, 'working', 'local'), agentId: 'a4' } })
    .filter(r => r.cells.trimStart().startsWith('> ')).map(r => r.key), ['session:local:p2:working'], 'a closed group: its session');
});

test('Observatory master: a saved machine\'s session groups its workers too, from that machine\'s listing (2026-10-23)', () => {
  const state = { ...fixture(), open: new Set(['workers:build:remote-done']) };
  state.observatory.machines[1].sessions.sessions[0].activeWorkers = [activeWorker('r1', 'Remote worker', 'awaiting-input')];
  const rows = render(state, 100);
  assert.deepEqual(group(rows, 'session:build:p1:remote-done').map(r => r.cells), [
    '        v 1 worker · + 1 blocked',
    '          + blocked (1)',
    '            Remote worker',
    '              + blocked · Opus 5.5 · 3 edits · +120 −4 · 1.2M tok · 3 pending · 14:00:40',
  ]);
  assert.deepEqual(['session', 'machineId', 'agentId'].map(k => rows.find(r => r.key === 'session:build:p1:remote-done:worker:r1').scope[k]), ['remote-done', 'build', 'r1']);
});

test('Observatory master: a session with two workers working and three finished counts two, and lists only the working (2026-10-23)', t => {
  const { root } = isolated(t);
  const S = 'fixture-five-workers', now = Date.now();
  const dir = path.join(core.projectDir(root), S, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const line = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';
  const at = ms => new Date(now - ms).toISOString();
  const ids = ['working-1', 'working-2', 'finished-1', 'finished-2', 'finished-3'];
  fs.writeFileSync(path.join(core.projectDir(root), `${S}.jsonl`), line([
    { type: 'user', cwd: root, sessionId: S, timestamp: at(600e3), message: { role: 'user', content: 'Fan out' } },
    ...ids.flatMap((id, i) => [
      { type: 'assistant', cwd: root, sessionId: S, timestamp: at(500e3 - i * 1000), message: { id: `s${i}`, role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id: `t${i}`, name: 'Agent', input: { description: `Task ${id}`, run_in_background: true } }], usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: 'user', cwd: root, sessionId: S, timestamp: at(500e3 - i * 1000), toolUseResult: { status: 'async_launched', isAsync: true, agentId: id }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'launched' }] } }]),
    ...ids.filter(id => id.startsWith('finished')).map(id => ({ type: 'queue-operation', operation: 'enqueue', cwd: root, sessionId: S, timestamp: at(30e3), content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` })),
  ]));
  for (const id of ids) {
    const file = path.join(dir, `agent-${id}.jsonl`);
    fs.writeFileSync(file, line(id.startsWith('working')
      ? [{ isSidechain: true, agentId: id, type: 'assistant', timestamp: at(2000), message: { id: `m-${id}`, role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id: `c-${id}`, name: 'Read', input: { file_path: 'x' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
        { isSidechain: true, agentId: id, type: 'user', timestamp: at(1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c-${id}`, content: 'ok' }] } }]
      : [{ isSidechain: true, agentId: id, type: 'assistant', timestamp: at(60e3), message: { id: `m-${id}`, role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text: 'Done.' }] } }]));
    if (id.startsWith('finished')) fs.utimesSync(file, (now - 60e3) / 1000, (now - 60e3) / 1000);
  }
  const listed = core.sessionMeta(root).sessions.find(r => r.id === S);
  assert.deepEqual(listed.activeWorkers.map(w => [w.agentId, w.phase]).sort(), [['working-1', 'working'], ['working-2', 'working']]);
  const state = fixture();
  state.views.sessions.sessions[1] = { ...state.views.sessions.sessions[1], activeWorkers: listed.activeWorkers };
  const uni = (open) => tui.rowsFor(fresh({ ...state, open: new Set(open) }), 82, tui.glyphs('unicode'), 'none');
  const collapsed = group(uni([]));
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0].cells, /^ {8}▸ 2 workers · [⠋⠙⠹⠸⠼⠴⠦⠧] 2 working$/, 'two, both working: no finished count, no total that holds them');
  const open = group(uni(['workers:local:working'])).map(r => r.cells.trim());
  assert.match(open[1], /^[⠋⠙⠹⠸⠼⠴⠦⠧] working \(2\)$/);
  assert.equal(open.filter(c => / \(\d+\)$/.test(c)).length, 1, 'only the working sub-group');
  assert.deepEqual(open.filter((c, i) => i > 1 && i % 2 === 0), ['Task working-2', 'Task working-1'], 'newest spawn first');
});

test('Observatory master: a paneless session with a worker still at it shows under its machine, not in a fold (2026-10-23)', () => {
  const state = fixture();
  const where = st => { const rows = render(st); return { rows, at: rows.findIndex(r => r.key === 'session:unresolved::unresolved') }; };
  assert.equal(where(state).at, -1, 'control: a quiet unresolved session folds into earlier');
  state.views.sessions.sessions.find(r => r.id === 'unresolved').activeWorkers = [activeWorker('w1', 'Still going', 'working')];
  const busy = where(state);
  assert.ok(busy.at >= 0 && busy.at < busy.rows.findIndex(r => r.key === 'machine:build'), 'listed under its machine');
  assert.equal(busy.rows[busy.at + 2].cells.trim().split(' · ')[0], '> 1 worker', 'with its group under it');
});

test('Observatory master: a paneless session with nothing pending, not the current one, is kept while a worker of it is at it (2026-10-23)', () => {
  const state = fixture();
  const listed = st => render(st).findIndex(r => r.key === 'session:unresolved::archived');
  assert.equal(listed(state), -1, 'control: a quiet, resolved paneless session is archived');
  state.views.sessions.sessions.find(r => r.id === 'archived').activeWorkers = [activeWorker('w1', 'Still going', 'working')];
  const rows = render(state), at = listed(state);
  assert.ok(at >= 0 && at < rows.findIndex(r => r.key === 'machine:build'), 'listed under its machine');
  assert.equal(rows[at + 2].cells.trim().split(' · ')[0], '> 1 worker', 'with its group under it');
  assert.ok(!rows.some(r => r.key === 'archived'), 'and not archived as well');
});

test('Observatory master: a worker whose phase is inferred wears ~ on its state, one a record states does not (2026-10-23)', () => {
  const state = { ...fixture(), open: new Set(['workers:local:working']) };
  state.views.sessions.sessions[1].activeWorkers = [activeWorker('g1', 'Long build', 'awaiting-permission', { phaseConfidence: 'heuristic' }),
    activeWorker('q1', 'Asked a question', 'awaiting-input'), activeWorker('w1', 'Quiet background', 'working', { phaseConfidence: 'heuristic' })];
  const line = id => render(state, 100).find(r => r.key === `session:local:p2:working:worker:${id}:state`).cells.trim().split(' · ')[0];
  assert.deepEqual(['g1', 'q1', 'w1'].map(line), ['+ blocked~', '+ blocked', '| working~']);
});

test('Observatory master: a picked state header whose workers have all moved on leaves the mark on its session (2026-10-23)', () => {
  const state = { ...fixture(), open: new Set(['workers:local:working']) };
  state.views.sessions.sessions[1].activeWorkers = someWorkers().filter(w => w.phase === 'working');
  const marked = draw => draw.filter(r => r.cells.trimStart().startsWith('> ')).map(r => r.key);
  const rows = tui.rowsFor(fresh({ ...state, scopeWorker: { ...tui.observatorySelection(state, 'working', 'local'), workers: 'blocked' } }), 100, tui.glyphs('unicode'), 'none');
  assert.deepEqual(marked(rows), ['session:local:p2:working']);
});

test('Observatory reply: re-pinning a leaf parks its unsent draft with its session; pinning that session again restores it', () => {
  let state = pin(fixture(), 'working');
  state.observatory.details['obs-detail'].reply = { text: 'half-typed answer', caret: 4, focused: true, commentIds: ['c1'] };
  state = pin(state, 'idle');
  assert.equal(state.observatory.details['obs-detail'].selection.session, 'idle');
  assert.equal(state.observatory.details['obs-detail'].reply, undefined, 'the other session is never offered the draft');
  state = pin(state, 'working');
  assert.deepEqual(state.observatory.details['obs-detail'].reply, { text: 'half-typed answer', caret: 4, focused: false, commentIds: ['c1'] },
    'it returns with its session, unfocused');
  state.observatory.details['obs-detail'].reply = { text: '', caret: 0, focused: false, sending: true };
  state = pin(pin(state, 'idle'), 'working');
  assert.equal(state.observatory.details['obs-detail'].reply, undefined, 'a reply already on its way is not parked');
});

test('Observatory master: unreachable machines stay visible; closing resolved panes archives the session', () => {
  const state = fixture();
  state.observatory.machines[1] = { id: 'build', label: 'build-box', error: 'ssh unavailable' };
  assert.match(lines(render(state)), /build-box\n  not reachable · ssh unavailable/);
  state.observatory.machines[0].snapshot.panes = [];
  assert.ok(lines(render({ ...state, open: new Set(['earlier']) })).includes('Fix the demo'), 'pending survives pane close, folded into earlier');
  assert.ok(!lines(render(state)).includes('Run checks'), 'resolved pane closes into archive');
});

for (const width of [22, 46]) test(`Observatory polish: loading/failure and wrapped master content at ${width} columns`, () => {
  const state = fixture();
  state.views.sessions.sessions[0].title = 'tidy-fixture-importer-pass with every word preserved';
  state.observatory.machines[0].snapshot.panes.push({ ...pane('p4', 'waiting', 'idle'), agent_session: null });
  state.observatory.machines[1] = { id: 'build', label: 'build-box' };
  for (const phase of ['connecting', 'failed']) {
    if (phase === 'failed') state.observatory.machines[1].error = 'herdr forwarding failed: ssh unavailable';
    const rows = render(state, width);
    golden(`observatory-master-${phase}-${width}`, lines(rows));
    for (const row of rows) assert.ok(tui.displayWidth(row.cells) <= width, row.cells);
    const titleRows = rows.filter(r => /^session:local:p1:claude-conversation(?::wrap:\d+)?$/.test(r.key));
    assert.equal(titleRows.map(r => r.cells.trim()).join('').replaceAll(' ', ''), state.views.sessions.sessions[0].title.replaceAll(' ', ''));
    assert.ok(titleRows.length > 1);
    assert.ok(titleRows.slice(1).every(r => r.cont && r.scope.session === 'claude-conversation'));
    assert.match(lines(rows), width === 22 ? /no session yet/ : /waiting for session/);
    if (phase === 'connecting') {
      assert.match(lines(rows), /connecting…/);
      assert.doesNotMatch(lines(rows), /not reachable|✗/);
    } else {
      assert.match(lines(rows), /build-box ✗/);
      const detailRows = render({ ...state, screen: 'session-detail' }, width);
      golden(`observatory-failure-detail-${width}`, lines(detailRows));
      assert.ok(detailRows.every(r => tui.displayWidth(r.cells) <= width));
      assert.match(detailRows.filter(r => r.key.startsWith('detail:machine-error')).map(r => r.cells).join(' '), /herdr forwarding failed: ssh unavailable/);
    }
  }
  // A long colored machine name and Unicode title obey the same width contract.
  state.observatory.machines[0].label = 'a-machine-name-longer-than-the-entire-master';
  state.views.sessions.sessions[0].title = '界面修复全部内容🙂 keep the entire title';
  const colored = render(state, width, 'truecolor');
  assert.ok(colored.every(r => tui.displayWidth(r.cells) <= width));
  assert.equal(colored.filter(r => /^machine:local(?::wrap:\d+)?$/.test(r.key)).map(r => tui.stripSgr(r.cells)).join(''), state.observatory.machines[0].label);
  assert.equal(colored.filter(r => /^session:local:p1:claude-conversation(?::wrap:\d+)?$/.test(r.key))
    .map(r => tui.stripSgr(r.cells).trim()).join('').replaceAll(' ', ''), state.views.sessions.sessions[0].title.replaceAll(' ', ''));
});

test('Observatory detail: preview headers, pin holds while browsing, per-leaf pins and isolated cursor memo', () => {
  let state = fixture(); state.screen = 'session-detail';
  state.scopeWorker = tui.observatorySelection(state, 'claude-conversation');
  assert.match(lines(render(state)), /Fix the demo.*laptop.*blocked.*Opus/);
  assert.ok(!state.observatory.details['obs-detail'], 'preview performs no conversation load');
  state.open = new Set(['detail:obs-detail:claude-conversation:Workers']);
  assert.match(lines(render(state)), /Inspect the grid[\s\S]*Processes · 0[\s\S]*Tasks/);
  state = pin(state);
  const detail = state.observatory.details['obs-detail'];
  detail.loading = false; detail.cursor = 10; detail.events = [turn()];
  const first = render(state);
  assert.strictEqual(render({ ...state, now: state.now + 150, views: { ...state.views } }), first);
  state.scopeWorker = tui.observatorySelection(state, 'remote-done');
  assert.strictEqual(render(state), first, 'browsing holds pinned header and body');
  detail.cursor = 11;
  const next = render(state); assert.notStrictEqual(next, first);
  assert.equal(lines(next), lines(first));
  state = pin(state, 'remote-done', 'second-detail');
  assert.match(lines(render({ ...state, observatoryPane: 'second-detail' })), /Remote review.*build-box.*done/);
  assert.match(lines(render(state)), /Fix the demo/);
  const frame = tui.renderTreeBody(state, { kind: 'split', dir: 'h', ratio: 0.5,
    first: { kind: 'pane', id: 'obs-detail', view: 'session-detail' }, second: { kind: 'pane', id: 'second-detail', view: 'session-detail' } }, 180, 24, 'second-detail', g, 'none').join('\n');
  assert.match(frame, /Fix the demo/); assert.match(frame, /Remote review/);
  const zoomed = tui.resolveZoomedTree(tui.OBSERVATORY_TREE, { x: 0, y: 0, w: 100, h: 24 }, 'obs-detail', 'obs-detail');
  assert.equal(zoomed.placements.filter(p => p.rect.h > 1).length, 1);
});

for (const kind of ['claude', 'codex']) test(`Observatory detail: ${kind} fixture through conversationEvents and shared Agent renderer`, t => {
  const { root, session, record } = transcript(t, kind);
  let state = fixture(); state.screen = 'session-detail';
  if (kind === 'codex') state.views.sessions.sessions.push({ id: session, agent: kind, title: 'Codex demo', pending: 1, tokens: 900, model: 'GPT' });
  state = pin(state, session);
  const result = core.conversationEvents(session, { root });
  assert.ok(result.events.length > 10);
  const detail = { selection: { session, root, label: kind === 'claude' ? 'Fix the demo' : 'Codex demo' }, ...result,
    loadedAt: Date.parse(`2026-09-18T${kind === 'claude' ? '14' : '15'}:01:00Z`), previews: { [record.id]: core.coloredDiff(session, record, false) } };
  state.observatory.details['obs-detail'] = detail;
  // The goldens name /workspace in POSIX form; a Windows root is `C:\…` with `\` below it too.
  const unroot = s => s.replaceAll(root + path.sep, '/workspace/').replaceAll(root, '/workspace');
  const deep = v => typeof v === 'string' ? unroot(v) : Array.isArray(v) ? v.map(deep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  detail.events = deep(JSON.parse(JSON.stringify(detail.events)));
  detail.previews[record.id] = unroot(detail.previews[record.id]);
  let rows = render(state);
  const text = unroot(lines(rows));
  golden(`observatory-detail-${kind}`, text);
  assert.match(text, /^\+- You .*\+\n\|(Fix|Patch) /m, 'the ask is a box, like the calls beside it');
  assert.match(text, /\$ /);
  assert.match(text, /Plan/);
  assert.match(text, /turn ended/);
  assert.match(text, /thinking/);
  assert.ok(!text.includes('Inspecting the demo carefully.'), 'thought text starts folded');
  assert.ok(lines(render(state, 82, 'truecolor')).includes(GROUNDS.default.truecolor), 'user prompt retains the grey bubble');
  const thought = rows.find(r => r.openPath?.startsWith('thought:'));
  assert.ok(thought);
  state.open = new Set([thought.openPath]);
  assert.ok(lines(render(state)).includes('thinking —'));
  assert.match(text, /Workers ·/); assert.match(text, /Tasks ·/);
});

test('Observatory turn_end: at most eight real diff boxes; markdown tables and folded thoughts retain content', () => {
  let state = pin(fixture()); state.screen = 'session-detail';
  const records = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, file: `file${i + 1}.ts`, partial: i === 0 }));
  const detail = state.observatory.details['obs-detail'];
  detail.loading = false; detail.cursor = 1;
  detail.events = [{ ts: 0, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '| Name | State |\n| --- | --- |\n| demo | **ready** |' } } }, turn(records)];
  detail.previews = Object.fromEntries(records.map(r => [r.id, '--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new\n']));
  const text = lines(render(state));
  assert.equal((text.match(/Edit #\d+/g) || []).length, 8);
  assert.match(text, /2 more edits/); assert.match(text, /partial/);
  assert.match(text, /-old/); assert.match(text, /\+new/);
  assert.match(text, /\| demo \| \*\*ready\*\* \|/);
  const color = lines(render(state, 82, 'truecolor'));
  assert.ok(color.includes('│') && color.includes('\x1b[1mready'), 'same styled markdown table as Agent');
});

test('Observatory turn_end: one edit past the eight boxes reads "1 more edit"', () => {
  const state = pin(fixture()); state.screen = 'session-detail';
  const detail = state.observatory.details['obs-detail'];
  detail.loading = false; detail.cursor = 1;
  detail.events = [turn(Array.from({ length: 9 }, (_, i) => ({ id: i + 1, file: `file${i + 1}.ts` })))];
  const text = lines(render(state));
  assert.match(text, /turn ended · end_turn · 9 edits/);
  assert.match(text, /(^|\n)1 more edit · ⌕ review shows all/);
});

// The Observatory draws a user prompt as a grey-tinted blob with the same bordered format as the
// others. The ask is a box like the
// calls and edits beside it: who and when on its top edge, every word inside on the theme's grey, and an
// agent's own blockquote is never taken for it.
const PROMPT = 'Fix the demo so that a long ask wraps across more than one row of the detail pane and every wrapped row keeps the band\nand its own second line';
const ASKED = Date.parse('2026-09-18T14:00:30Z');
function promptState() {
  const state = pin(fixture()); state.screen = 'session-detail';
  Object.assign(state.observatory.details['obs-detail'], { loading: false, cursor: 1, events: [
    { ts: ASKED, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: PROMPT } } },
    { ts: ASKED + 1000, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Agent prose stays unbanded.\n> quoted by the agent' } } },
  ] });
  return state;
}
const GROUNDS = {
  default: { truecolor: '\x1b[48;2;38;42;51m', 256: '\x1b[48;5;236m', 16: '\x1b[100m' },
  light: { truecolor: '\x1b[48;2;226;230;236m', 256: '\x1b[48;5;253m', 16: '\x1b[100m' },
};

test('Observatory detail: a prompt is a box like its calls, who and when on its edge, every word inside on the theme\'s grey (2026-09-27)', t => {
  t.after(() => tui.setTheme(undefined));
  const words = PROMPT.split(/\s+/);
  for (const tier of ['ascii', 'safe']) for (const width of [60, 22, 12]) for (const theme of ['default', 'light']) for (const depth of ['truecolor', '256', '16', 'none']) {
    tui.setTheme(theme);
    const glyphs = tui.glyphs(tier), { tl, tr, bl, br, v, h } = glyphs.box;
    const label = `${tier}/${width}/${theme}/${depth}`;
    const rows = tui.rowsFor(fresh(promptState()), width, glyphs, depth);
    const plain = rows.map(r => tui.stripSgr(r.cells));
    const top = plain.findIndex(l => l.startsWith(`${tl}${h} You `));
    const bottom = plain.findIndex((l, i) => i > top && l.startsWith(bl));
    assert.ok(top > 0 && bottom > top + 1, `${label}: the ask opens a box under "You" and closes it:\n${plain.join('\n')}`);
    // Who, and when where every blob's time rides (the title padded out to it, as a call's is); under 18
    // columns the time gives way, never the title.
    assert.equal(plain[top], width >= 18 ? `${tl}${h} You${' '.repeat(width - 18)}  14:00:30 ${tr}` : `${tl}${h} You${' '.repeat(width - 8)} ${tr}`, label);
    assert.equal(plain[bottom], `${bl}${h.repeat(width - 2)}${br}`, label);
    const body = plain.slice(top + 1, bottom);
    for (const line of body) assert.ok(line.startsWith(v) && line.endsWith(v) && tui.displayWidth(line) === width, `${label}: between the box's sides: ${JSON.stringify(line)}`);
    const inside = body.map(l => l.slice(1, -1).trim());
    assert.deepEqual(inside.join(' ').split(/\s+/), words, `${label}: every word, in order, none cut`);
    assert.match(inside[inside.findIndex(l => l.endsWith('band')) + 1], /^and its/, `${label}: the ask's own second line starts a row`);
    assert.ok(!body.some(l => l.includes('…')), `${label}: wrapped, never cut`);
    // A drag takes the words: the edges hold none, and the sides are drawn, not text.
    const box = rows.slice(top, bottom + 1);
    assert.deepEqual(box.map(r => r.copy), [null, ...body.map(() => [1, width - 2]), null], label);
    if (depth === 'none') { for (const row of box) assert.doesNotMatch(row.cells, /\x1b/, `${label}: no colour, no escapes`); }
    else {
      assert.ok(box[0].cells.includes(tui.tint('You', 'accent', depth)), `${label}: the title wears the accent, as a call's verb does`);
      for (const row of [box[0], box.at(-1)]) assert.doesNotMatch(row.cells, /\x1b\[(48;|100m)/, `${label}: the edges are not on the ground`);
      for (const row of box.slice(1, -1)) {
        // The border, then the theme's ground over the whole inside, then the border.
        const at = row.cells.indexOf(GROUNDS[theme][depth]), end = row.cells.indexOf('\x1b[0m', at);
        assert.ok(at > 0 && tui.stripSgr(row.cells.slice(0, at)) === v, `${label}: the ground opens right inside the border: ${JSON.stringify(row.cells)}`);
        assert.equal(tui.displayWidth(row.cells.slice(at, end)), width - 2, `${label}: and fills the inside: ${JSON.stringify(row.cells)}`);
        assert.equal(tui.stripSgr(row.cells.slice(end)), v, `${label}: then the border closes the row`);
      }
    }
    for (const row of rows.slice(bottom + 1)) assert.doesNotMatch(row.cells, /\x1b\[(48;|100m)/, `${label}: agent text is never on the ground: ${JSON.stringify(row.cells)}`);
    assert.match(plain.slice(bottom + 1).join(' '), /quoted by the agent/, `${label}: an agent's blockquote stays the agent's`);
  }
  // In the real frame the box fills the detail pane's text area, from the gutter to the pane's border.
  tui.setTheme('default');
  const frame = tui.renderTreeBody(promptState(), tui.OBSERVATORY_TREE, 120, 30, 'obs-detail', g, 'truecolor').map(l => tui.stripSgr(l));
  const edge = frame.find(l => l.includes('+- You'));
  assert.match(edge ?? '', /\| \+- You +14:00:30 \+\|$/, `the box spans the pane:\n${frame.join('\n')}`);
});

// A drag copies an ask's words, not its box, as a Review pane's drag leaves its pane's
// box out, and the band covers the same cells. Wrapped and two lines long, in a boxed pane and a bare one.
test('Observatory detail: a drag over a prompt bands and copies its words, not its box (2026-09-27)', () => {
  const state = promptState();
  const root = { kind: 'pane', id: 'obs-detail', view: 'session-detail' };
  for (const glyphs of [g, tui.glyphs('safe'), { ...g, boxes: false }]) {
    const label = `${glyphs.box.v} ${glyphs.boxes ? 'boxed' : 'bare'}`;
    const lines = tui.renderTreeBody(state, root, 50, 20, 'obs-detail', glyphs, 'none');
    // The pane's text area, as the app holds a drag to it (app.ts, a tree pane's press).
    const inset = glyphs.boxes ? 2 : 1;
    const clip = { x0: inset, x1: 50 - inset, y0: 1, y1: 20 - inset };
    const rows = tui.treePaneTextRows(state, { ...root, rect: { x: 0, y: 0, w: 50, h: 20 }, focused: true }, glyphs, 'none', clip);
    const top = lines.findIndex(l => l.includes(`${glyphs.box.tl}${glyphs.box.h} You`));
    const bottom = lines.findIndex((l, i) => i > top && l.includes(`${glyphs.box.bl}${glyphs.box.h}`));
    assert.ok(top > 0 && bottom > top + 2, `${label}: the ask's box is on screen:\n${lines.join('\n')}`);
    // From the box's top-left corner to its bottom-right one.
    const a = { row: top, col: clip.x0 }, b = { row: bottom, col: clip.x1 };
    const text = tui.sliceSpan(lines, a, b, { ...clip, rows });
    assert.equal(text.split('\n').join(' '), PROMPT.replaceAll('\n', ' '), `${label}: every word: ${JSON.stringify(text)}`);
    assert.match(text, /band\nand its own/, `${label}: a row per row, the ask's own line break kept`);
    assert.ok(![glyphs.box.v, glyphs.box.tl, glyphs.box.br].some(c => text.includes(c)), `${label}: no border: ${JSON.stringify(text)}`);
    assert.ok(tui.sliceSpan(lines, a, b, clip).includes(glyphs.box.v), `${label}: control: without the rows, the copy takes the borders`);
    // The band covers what the copy takes: nothing of an edge, a body row inside its sides.
    for (let r = top; r <= bottom; r++) {
      assert.deepEqual(tui.spanCols(r, a, b, { ...clip, rows }), r === top || r === bottom ? null : [clip.x0 + 1, clip.x1 - 1], `${label}: row ${r}`);
    }
  }
  // A pane too short for the box: its last line is `↓ newest`, which is not the box's, though a row of
  // the box would stand there in a taller pane.
  const pane = h => ({ ...root, rect: { x: 0, y: 0, w: 50, h }, focused: true });
  const top = { ...state, treeScroll: { ...state.treeScroll, 'obs-detail': 0 } };
  const lines = tui.renderTreeBody(top, root, 50, 8, 'obs-detail', g, 'none');
  const newest = lines.findIndex(l => l.includes('↓ newest'));
  assert.deepEqual(tui.treePaneTextRows(top, pane(20), g, 'none', { x0: 2, x1: 48, y0: 1 }).get(newest), [3, 47], `control: a taller pane draws the box's words there:\n${lines.join('\n')}`);
  assert.equal(tui.treePaneTextRows(top, pane(8), g, 'none', { x0: 2, x1: 48, y0: 1 }).get(newest), undefined);
  // A pane narrower than the box (it is never under 8 columns) cuts it at the pane's text area; the
  // text a drag takes stops there too, never on the pane's own border.
  const narrow = [...tui.treePaneTextRows(top, { ...root, rect: { x: 0, y: 0, w: 9, h: 60 }, focused: true }, g, 'none', { x0: 2, x1: 7, y0: 1 }).values()];
  assert.ok(narrow.some(Boolean), 'control: the box is on screen');
  for (const span of narrow.filter(Boolean)) assert.deepEqual(span, [3, 7]);
});

test('Observatory detail: a theme saved mid-session repaints the pinned conversation (2026-09-26)', t => {
  t.after(() => tui.setTheme(undefined));
  const state = promptState();
  tui.setTheme('default');
  assert.ok(lines(render(state, 60, 'truecolor')).includes(GROUNDS.default.truecolor));
  tui.setTheme('light');
  const light = lines(render(state, 60, 'truecolor'));
  assert.ok(light.includes(GROUNDS.light.truecolor) && !light.includes(GROUNDS.default.truecolor), 'not the dark band from the memo');
});

// The Workers and Tasks menus are colour-coded and always list active workers, with a fold that
// shows all.
test('Observatory detail: Workers and Tasks list what is going on, colour-coded by state, and fold the rest (2026-09-26)', () => {
  const state = pin(fixture()); state.screen = 'session-detail';
  const worker = (agentId, phase, description, ts) => ({ agentId, agentType: 'Explore', description, phase, ts });
  Object.assign(state.observatory.details['obs-detail'], { loading: false, cursor: 1, events: [], fleet: {
    subagents: [worker('a-done', 'done', 'Wrote the tests', 1), worker('a-work', 'working', 'Maps the grid', 5), worker('a-ask', 'awaiting-input', 'Asks which grid', 4),
      worker('a-err', 'errored', 'Hit a wall', 3), worker('a-idle', 'idle', 'Finished just now', 2)],
    todos: [{ content: 'Edit the demo', status: 'completed' }, { content: 'Run checks', status: 'in_progress' }, { content: 'Report back', status: 'pending' }, { content: 'Plan it', status: 'completed' }],
  } });
  const workersFold = 'detail:obs-detail:claude-conversation:Workers', tasksFold = 'detail:obs-detail:claude-conversation:Tasks';
  const listed = ['Maps the grid', 'Asks which grid'], finished = ['Wrote the tests', 'Hit a wall', 'Finished just now'];
  const closed = render(state);
  const text = lines(closed);
  assert.match(text, /^Workers · 2\/5 active$/m, 'the header counts active/total');
  assert.match(text, /^Tasks · 2\/4 open$/m);
  for (const d of listed) assert.match(text, new RegExp(`^  \\S ${'Explore · ' + d}`, 'm'), `an active worker is listed with the fold closed: ${d}`);
  for (const d of finished) assert.doesNotMatch(text, new RegExp(d), `a finished worker waits behind the fold: ${d}`);
  assert.match(text, /^  > 3 finished$/m);
  assert.match(text, /^  v Run checks · in progress$/m); assert.match(text, /^  > Report back · pending$/m);
  assert.doesNotMatch(text, /Edit the demo|Plan it/); assert.match(text, /^  > 2 done$/m);
  // One click toggles: the fold row carries the fold, and it is the only row that does.
  assert.deepEqual(closed.filter(r => r.openPath).map(r => [r.openPath, tui.stripSgr(r.cells)]), [[workersFold, '  > 3 finished'], [tasksFold, '  > 2 done']]);
  const workersOpen = render({ ...state, open: new Set([workersFold]) });
  const opened = lines(workersOpen);
  for (const d of [...listed, ...finished]) assert.match(opened, new RegExp(d), `the fold reveals every worker: ${d}`);
  assert.match(opened, /^  v 3 finished$/m);
  assert.doesNotMatch(opened, /Edit the demo/, 'each fold opens on its own');
  for (const id of ['a-work', 'a-err']) assert.equal(workersOpen.find(r => r.key === `${workersFold}:${id}`).scope.agentId, id, 'a click on any worker still opens its feed');
  const all = render({ ...state, open: new Set([workersFold, tasksFold]) }, 82, 'truecolor');
  assert.match(lines(all.map(r => ({ cells: tui.stripSgr(r.cells) }))), /Edit the demo · done\n  \+ Plan it · done/);
  // Each state wears its colour on its glyph and its word: workers as the editors colour a phase,
  // tasks as the Tasks board does.
  const FG = { live: '38;2;76;139;245', agent: '38;2;217;130;43', kept: '38;2;63;185;80', risk: '38;2;229;83;75', undone: '38;2;154;160;170', pending: '38;2;217;164;65' };
  for (const [what, key, word] of [['Maps the grid', 'live', 'working'], ['Asks which grid', 'agent', 'awaiting-input'], ['Wrote the tests', 'kept', 'done'],
    ['Hit a wall', 'risk', 'errored'], ['Finished just now', 'undone', 'idle'], ['Run checks', 'live', 'in progress'], ['Report back', 'pending', 'pending'], ['Edit the demo', 'kept', 'done']]) {
    const cells = all.find(r => tui.stripSgr(r.cells).includes(what)).cells;
    assert.match(cells, new RegExp(`^  \\x1b\\[${FG[key]}m\\S\\x1b\\[0m `), `${what}: its glyph wears ${key}`);
    assert.ok(cells.includes(`\x1b[${FG[key]}m${word}\x1b[0m`), `${what}: and so does its state, "${word}"`);
  }
  // A worker row too long for the pane wraps inside its list, not back at the pane's edge.
  const narrow = render(state, 30);
  const at = narrow.findIndex(r => r.key === `${workersFold}:a-work`);
  assert.equal(narrow[at + 1]?.key, `${workersFold}:a-work:wrap:1`);
  assert.match(narrow[at + 1].cells, /^  \S/);
});

// The second line of each worker is colour-coded too: like the session list's stats, not in its
// status colour.
test('Observatory detail: a worker\'s stats wear the session list\'s colours, one per kind, never its state\'s (2026-09-28)', t => {
  t.after(() => tui.setTheme(undefined));
  const state = pin(fixture()); state.screen = 'session-detail';
  const fold = 'detail:obs-detail:claude-conversation:Workers';
  const worker = (agentId, phase) => ({ agentId, agentType: 'Explore', description: `Worker ${agentId}`, phase, ts: state.now - 60000,
    model: 'Opus', effort: 'high', edits: 2, added: 12, removed: 3, tokensIn: 1200, tokensOut: 300, tokensCacheRead: 40000, durationMs: 180000 });
  Object.assign(state.observatory.details['obs-detail'], { loading: false, cursor: 1, events: [], fleet: { todos: [],
    subagents: [worker('w-work', 'working'), worker('w-ask', 'awaiting-input'), worker('w-done', 'done'), worker('w-err', 'errored'), worker('w-idle', 'idle')] } });
  state.open = new Set([fold]);
  const cost = (width, depth, id) => tui.rowsFor(fresh(state), width, g, depth).filter(r => r.key.startsWith(`${fold}:${id}:cost`)).map(r => r.cells);
  const bare = (row) => row.replace(/(\x1b\[0m)+$/, '');
  const words = cost(120, 'none', 'w-work')[0];
  const [, time, duration] = /^ {4}\+12 −3 · Opus · high · (14:00:00) · 2 edits · ↑1k ↓300 ↺40k · (\S+)$/.exec(words) ?? [];
  assert.ok(duration, `control: the words it colours: ${words}`);
  for (const theme of ['default', 'light']) for (const depth of ['truecolor', '256', '16', 'none']) {
    tui.setTheme(theme);
    const expected = `    ${tui.tint('+12', 'kept', depth)} ${tui.tint('−3', 'risk', depth)} · ${tui.tint('Opus', 'agent', depth)} · ${tui.tint('high', 'agent', depth)}`
      + ` · ${tui.tint(time, 'undone', depth)} · 2 edits · ${tui.tint('↑1k ↓300 ↺40k', 'undone', depth)} · ${tui.tint(duration, 'undone', depth)}`;
    for (const [id, key] of [['w-work', 'live'], ['w-ask', 'agent'], ['w-done', 'kept'], ['w-err', 'risk'], ['w-idle', 'undone']]) {
      const label = `${theme}/${depth}/${id}`;
      const [row] = cost(120, depth, id);
      assert.equal(bare(row), bare(expected), `${label}: the session list's colours, the same whatever the worker's state`);
      if (depth === 'none') continue;
      assert.ok(tui.rowsFor(fresh(state), 120, g, depth).find(r => r.key === `${fold}:${id}`).cells.includes(tui.tint('\0', key, depth).split('\0')[0]),
        `${label}: control: its first line wears its state's ${key}`);
    }
  }
  // Wrapped, no row of it takes on the state's colour.
  tui.setTheme('default');
  const rows = cost(30, 'truecolor', 'w-work');
  assert.ok(rows.length > 1, 'control: it wraps at 30 columns');
  const live = tui.tint('\0', 'live', 'truecolor').split('\0')[0];
  assert.ok(tui.rowsFor(fresh(state), 30, g, 'truecolor').find(r => r.key === `${fold}:w-work`).cells.includes(live), 'control: the state colour is findable');
  for (const row of rows) assert.ok(!row.includes(live), JSON.stringify(row));
});

// Inject the child boundary in unit tests; production never calls these core reads on the paint thread.
function testReader(api = core) {
  return {
    read: async (session, root, since) => api.conversationEvents(session, { root, ...(since === undefined ? {} : { since }) }),
    diff: async (session, id) => { const record = api.readLog(session).find(r => r.id === id); return record ? api.coloredDiff(session, record, false) : ''; },
    fleet: async (session, root) => {
      const cached = api.siblingOverviewCached(root, session, { root });
      const roll = new Map(cached?.map.rollupBySubagent.map(r => [r.subagentId, r]) || []);
      return { subagents: api.subagentDigests(root, session).map(worker => ({ ...worker, ...roll.get(worker.agentId) })), todos: cached?.todos || [] };
    },
    close() {},
  };
}

function fakeRuntime(state, overrides = {}, runtimeOptions = {}) {
  const calls = [], subs = [], statuses = [];
  let watcher;
  let currentSnapshot = state.observatory.machines[0].snapshot;
  const fake = { ...core, findHerdrBin: () => '/herdr', herdrSocketPath: () => '/fake.sock',
    herdrSnapshot: async () => currentSnapshot,
    herdrMachines: async () => [{ id: 'build', label: 'build-box', enabled: true }],
    herdrOnMachine: async (label, argv) => { calls.push({ label, argv }); return { result: { type: 'session_snapshot', snapshot: state.observatory.machines[1]?.snapshot || snapshot([]) } }; },
    herdrRequest: async (method, params) => { calls.push({ method, params }); return method === 'pane.current' ? { pane: currentSnapshot.panes[0] } : { type: 'ok' }; },
    herdrSubscribe: (subscriptions, event, options) => { const sub = { subscriptions, event, options, closed: false, close() { this.closed = true; } }; subs.push(sub); return sub; },
    readHerdrPaneLink: () => null,
    observatoryRoots: () => [{ kind: 'store', dir: '/fake', relevant: f => f === 'log.jsonl' }],
    createWatcher: options => { watcher = options; return { close() { watcher.closed = true; } }; },
    sessionMeta: () => state.views.sessions,
    ...overrides,
  };
  const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', reader: testReader(fake), changed() {}, status: message => statuses.push(message), timers: false, ...runtimeOptions });
  return { runtime, calls, subs, statuses, watcher: () => watcher, snapshot: value => { currentSnapshot = value; } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flushAsync = () => new Promise(resolve => setImmediate(resolve));
function remoteTimeoutEnv(t, value) {
  const previous = process.env.OAK_HERDR_REMOTE_TIMEOUT_MS;
  if (value === undefined) delete process.env.OAK_HERDR_REMOTE_TIMEOUT_MS;
  else process.env.OAK_HERDR_REMOTE_TIMEOUT_MS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.OAK_HERDR_REMOTE_TIMEOUT_MS;
    else process.env.OAK_HERDR_REMOTE_TIMEOUT_MS = previous;
  });
}

// Started in a folder with no session of its own, the app names no session: the Observatory reads this machine's listing and
// each saved machine's with none named (every session there), and lists both, as it does from a folder with a session.
test('Observatory with no session named: this machine\'s listing and a saved machine\'s sessions are read and listed (2026-10-08)', async () => {
  const state = fixture();
  const listing = state.views.sessions, remote = state.observatory.machines[1];
  state.session = '';
  state.views = null;
  state.observatory = { machines: [{ id: 'local', label: 'laptop', local: true }], details: {} };
  const asked = [];
  const reader = { ...testReader(), sessions: async (session, root, machine) => { asked.push([session, machine ?? 'this machine']); return machine ? remote.sessions : listing; } };
  const fake = { ...core, findHerdrBin: () => '/herdr', herdrSocketPath: () => '/fake.sock', herdrSnapshot: async () => snapshot([]),
    herdrMachines: async () => [{ id: 'build', label: 'build-box', enabled: true }],
    herdrOnMachine: async () => ({ result: { type: 'session_snapshot', snapshot: remote.snapshot } }),
    herdrRequest: async () => ({ type: 'ok' }), herdrSubscribe: () => ({ close() {} }), readHerdrPaneLink: () => null };
  const runtime = tui.createObservatory(fake, state, { cwd: '/elsewhere', reader, changed() {}, status() {}, timers: false, watch: false, readOnly: true });
  try {
    await runtime.start();
    await runtime.refreshSessions();
    for (let i = 0; i < 5; i++) await flushAsync();
    assert.deepEqual(asked.sort(), [['', 'build-box'], ['', 'this machine']], 'each listing is read with no session named');
    const listed = tui.observatorySessions(state).map(s => `${s.machineId}:${s.session}`).sort();
    assert.ok(listed.includes('build:remote-done') && listed.includes('build:unknown'), `the saved machine's sessions: ${listed}`);
    assert.ok(listed.includes('unresolved:unresolved'), `this machine's own, with pending edits: ${listed}`);
    // Its done session is listed in its done fold, opened as the reader opens it (df1 brief).
    assert.match(lines(render({ ...state, open: new Set(['done:build']) }, 82)), /build-box[\s\S]*Remote review/);
  } finally { runtime.close(); }
});

test('Observatory detail follows its pane: a restarted agent in the pinned pane retargets the conversation (2026-09-22)', async () => {
  const state = fixture();
  const fake = fakeRuntime(state);
  try {
    const pinned = pin(state, 'claude-conversation', 'obs-detail', 'local');
    Object.assign(state, pinned);
    assert.equal(state.observatory.details['obs-detail'].selection.paneId, 'p1');
    const seeded = { ...state.observatory.details['obs-detail'], loading: false, cursor: 40, events: [turn()], transcriptPath: '/old/transcript.jsonl' };
    state.observatory.details['obs-detail'] = seeded;
    // The same snapshot again changes nothing: the pin, its events and its cursor stay.
    await fake.runtime.refreshLocal();
    assert.strictEqual(state.observatory.details['obs-detail'], seeded, 'an unchanged pane keeps the detail object');
    // `claude` restarted in pane p1 under a new session id. The master row moves on the snapshot;
    // the detail must move with it instead of tailing a transcript nothing appends to any more.
    fake.snapshot(snapshot([pane('p1', 'restarted-conversation', 'working'), pane('p2', 'working', 'working'), pane('p3', 'idle', 'idle')]));
    await fake.runtime.refreshLocal();
    await flushAsync();
    const next = state.observatory.details['obs-detail'];
    assert.equal(next.selection.session, 'restarted-conversation', 'the detail now names the pane\'s new session');
    assert.equal(next.selection.paneId, 'p1');
    assert.equal(next.selection.machineId, 'local');
    assert.ok(!next.events.some(e => e.update.sessionUpdate === 'turn_end'), 'the old session\'s events are gone, not carried over');
    assert.equal(state.scopeWorker.session, 'restarted-conversation', 'the master selection follows the same pane');
    // A detail pinned to a SESSION with no pane has nothing to follow and keeps its pin.
    const orphan = tui.selectAndPin(state, 'unresolved', 'split-9');
    state.observatory = orphan.observatory;
    await fake.runtime.refreshLocal();
    assert.equal(state.observatory.details['split-9'].selection.session, 'unresolved');
  } finally { fake.runtime.close(); }
});

test('Observatory detail follows its pane, precisely: another machine\'s same pane id, the read, cleared events, scroll, draft, a stale read (2026-09-23)', async () => {
  const state = fixture();
  const reads = []; const pending = new Map();
  const deferredRead = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const said = (session) => ({ events: [{ ts: 2, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: `from ${session}` } } }], turns: [], agent: 'claude', transcriptPath: null, cursor: null, truncated: false });
  const reader = {
    read: (session, root) => { reads.push([session, root]); const d = deferredRead(); pending.set(session, d); return d.promise; },
    diff: async () => '', fleet: async () => ({ subagents: [], todos: [] }), close() {},
  };
  let current = state.observatory.machines[0].snapshot;
  const fake = { ...core, findHerdrBin: () => '/herdr', herdrSocketPath: () => '/fake.sock', herdrSnapshot: async () => current,
    herdrMachines: async () => [], herdrSubscribe: () => ({ close() {} }), readHerdrPaneLink: () => null,
    observatoryRoots: () => [], sessionMeta: () => state.views.sessions, ensureHerdrTabs: undefined };
  const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', reader, changed() {}, status() {}, timers: false, watch: false });
  try {
    // p1 exists on BOTH machines (the fixture overlaps them on purpose). Pin each in its own leaf.
    Object.assign(state, tui.selectAndPin(state, 'remote-done', 'remote-leaf', 'build'));
    Object.assign(state, tui.selectAndPin(state, 'claude-conversation', 'local-leaf', 'local'));
    const seeded = { ...state.observatory.details['local-leaf'], loading: false, events: [turn()], reply: { text: 'half-typed answer', caret: 17, focused: true } };
    state.observatory = { ...state.observatory, details: { ...state.observatory.details, 'local-leaf': seeded } };
    state.treeScroll = { ...state.treeScroll, 'local-leaf': 7 }; // the reader had scrolled up
    void runtime.load('local-leaf'); // an OLD read is in flight when the agent restarts
    assert.deepEqual(reads.at(-1), ['claude-conversation', '/workspace']);
    state.scopeWorker = tui.observatorySelection(state, 'working', 'local'); // the master cursor sits on ANOTHER pane
    reads.length = 0;
    current = snapshot([{ ...pane('p1', 'restarted-conversation', 'working'), cwd: '/elsewhere', title: 'New title' }, pane('p2', 'working', 'working')]);
    await runtime.refreshLocal();
    const local = () => state.observatory.details['local-leaf'];
    assert.equal(state.observatory.details['remote-leaf'].selection.session, 'remote-done', 'a LOCAL restart never retargets a detail pinned on another machine that happens to use the same pane id');
    assert.equal(local().selection.session, 'restarted-conversation');
    assert.equal(local().selection.root, '/elsewhere', 'the new session is read where the pane now runs');
    assert.equal(local().selection.label, 'New title');
    assert.deepEqual(local().events, [], 'nothing of the old session shows under the new one, even before the read lands');
    assert.deepEqual(reads, [['restarted-conversation', '/elsewhere']], 'the retargeted detail is read at once, not on the next tail tick');
    assert.equal(state.scopeWorker.session, 'working', 'a master selection on another pane is not hijacked');
    assert.equal(state.treeScroll['local-leaf'], Number.MAX_SAFE_INTEGER, 'the leaf follows the new conversation from its tail');
    assert.deepEqual(local().reply, { text: 'half-typed answer', caret: 17, focused: true }, 'the draft is the person\'s and survives');
    pending.get('claude-conversation').resolve(said('claude-conversation')); await flushAsync();
    assert.ok(!local().events.some((e) => e.update.content?.text === 'from claude-conversation'), 'a stale read of the old session is discarded');
    pending.get('restarted-conversation').resolve(said('restarted-conversation')); await flushAsync();
    assert.deepEqual(local().events.map((e) => e.update.content.text), ['from restarted-conversation']);
  } finally { runtime.close(); }
});

test('Observatory detail without a transcript retries slowly and keeps its message (TUI sweep, 2026-09-23)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const state = fixture();
  let reads = 0;
  const reader = { read: async () => { reads++; return { events: [], turns: [], agent: 'claude', transcriptPath: null, cursor: null, truncated: false }; }, diff: async () => '', fleet: async () => ({ subagents: [], todos: [] }), close() {} };
  const fake = { ...core, findHerdrBin: () => '/herdr', herdrSocketPath: () => '/fake.sock', herdrSnapshot: async () => state.observatory.machines[0].snapshot,
    herdrMachines: async () => [], herdrSubscribe: () => ({ close() {} }), readHerdrPaneLink: () => null, observatoryRoots: () => [], sessionMeta: () => state.views.sessions, ensureHerdrTabs: undefined };
  const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', reader, changed() {}, status() {}, timers: false, watch: false });
  try {
    Object.assign(state, tui.selectAndPin(state, 'claude-conversation', 'obs-detail', 'local'));
    await runtime.load('obs-detail');
    const detail = () => state.observatory.details['obs-detail'];
    assert.equal(reads, 1);
    assert.match(detail().error, /unavailable on this machine/);
    // Every 750 ms tick used to reload: a cold spawn each time, and "loading…" flickering over the message.
    for (let i = 0; i < 5; i++) await runtime.tail();
    assert.equal(reads, 1, 'no retry inside the back-off window');
    assert.equal(detail().loading, false); assert.match(detail().error, /unavailable/);
    t.mock.timers.tick(16_000);
    await runtime.tail();
    assert.equal(reads, 2, 'one retry once the window passed');
    assert.match(detail().error, /unavailable/, 'the message stays while the retry runs and after it fails again');
  } finally { runtime.close(); }
});

test('Observatory master: a session moved to another pane is listed once, under the live pane (2026-09-23)', () => {
  const state = fixture();
  // herdr keeps the old pane's agent_session after the agent left it; the live pane is the new one.
  const stale = { ...pane('p9', 'claude-conversation', 'unknown'), agent: null, agent_status: 'unknown' };
  state.observatory.machines[0].snapshot = snapshot([stale, pane('p1', 'claude-conversation', 'working'), pane('p2', 'working', 'working')]);
  const rows = tui.observatorySessions(state).filter(s => s.session === 'claude-conversation' && s.machineId === 'local');
  assert.equal(rows.length, 1, 'one row for the session on that machine');
  assert.equal(rows[0].paneId, 'p1', 'the pane whose agent is alive wins');
  const text = lines(render(state));
  assert.equal((text.match(/Fix the demo/g) || []).length, 1, 'the master shows it once');
  // The same pane id on ANOTHER machine is a different session slot, untouched.
  assert.ok(tui.observatorySessions(state).some(s => s.paneId === 'p1' && s.machineId === 'build'));
});

test('Observatory remote placeholder: pending first poll, failure, retry, recovery and removal', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const state = fixture(); state.observatory.machines.pop();
  let fetch = deferred(), enabled = true;
  const fake = fakeRuntime(state, {
    herdrMachines: async () => enabled ? [{ id: 'build', label: 'build-box', enabled: true }] : [],
    herdrOnMachine: async () => fetch.promise,
  });
  try {
    const first = fake.runtime.refreshRemotes(); await Promise.resolve();
    assert.equal(state.observatory.machines.find(m => m.id === 'build').error, undefined);
    assert.match(lines(render(state, 22)), /build-box\n  connecting…/);
    assert.doesNotMatch(lines(render(state, 22)), /✗|not reachable/);
    fetch.reject(new Error('actual failure')); await first;
    assert.equal(state.observatory.machines.find(m => m.id === 'build').error, 'actual failure');
    t.mock.timers.tick(30000);
    fetch = deferred();
    const retry = fake.runtime.refreshRemotes(); await Promise.resolve();
    assert.equal(state.observatory.machines.find(m => m.id === 'build').error, 'actual failure', 'retry retains last result');
    fetch.resolve({ result: { snapshot: snapshot([pane('remote', 'remote-done', 'done')]) } }); await retry;
    assert.equal(state.observatory.machines.find(m => m.id === 'build').error, undefined);
    assert.match(lines(render(state, 46)), /1 done/);
    state.open = new Set(['done:build']);
    assert.match(lines(render(state, 46)), /remote-done/); // no remote catalog yet: use its pane title
    t.mock.timers.tick(15000);
    fetch = deferred();
    const malformed = fake.runtime.refreshRemotes(); await Promise.resolve();
    assert.ok(state.observatory.machines.find(m => m.id === 'build').snapshot, 'poll retains successful result');
    fetch.resolve({ result: { snapshot: {} } }); await malformed;
    assert.match(state.observatory.machines.find(m => m.id === 'build').error, /snapshot has no version\/protocol\/panes/);
    enabled = false; await fake.runtime.refreshRemotes();
    assert.ok(!state.observatory.machines.some(m => m.id === 'build'));
  } finally { fake.runtime.close(); }
});

test('Observatory remote timeout: default, env validation and every forwarded command use the remote budget', async t => {
  remoteTimeoutEnv(t, undefined);
  for (const [value, expected] of [[undefined, 30000], ['60000', 60000], [' 45000 ', 45000], ['1', 1], ['2147483647', 2147483647],
    ['', 30000], ['garbage', 30000], ['0', 30000], ['-100', 30000], ['1.5', 30000], ['Infinity', 30000], ['2147483648', 30000]]) {
    if (value === undefined) delete process.env.OAK_HERDR_REMOTE_TIMEOUT_MS;
    else process.env.OAK_HERDR_REMOTE_TIMEOUT_MS = value;
    const state = fixture(), forwarded = [], local = [];
    const fake = fakeRuntime(state, {
      herdrSnapshot: async options => { local.push(options); return state.observatory.machines[0].snapshot; },
      herdrMachines: async options => { local.push(options); return [{ id: 'build', label: 'build-box', enabled: true }]; },
      herdrOnMachine: async (label, argv, options) => {
        forwarded.push({ label, argv, options });
        return argv[0] === 'api' ? { snapshot: state.observatory.machines[1].snapshot } : { result: { type: 'ok' } };
      },
    });
    try {
      await fake.runtime.start(); await fake.runtime.publishStore();
      await fake.runtime.focus(tui.observatorySelection(state, 'remote-done'));
      Object.assign(state, pin(state, 'remote-done'));
      fake.runtime.editReply('obs-detail', 'Remote timeout check'); await fake.runtime.sendReply('obs-detail');
      const verbs = new Set(forwarded.map(c => c.argv.slice(0, 2).join(' ')));
      // The tab tidy rides the same transport and budget (checked below); its btop tab is made at most
      // once a minute per machine, so whether this pass made one depends on the tests before it.
      verbs.delete('tab create');
      assert.deepEqual(verbs, new Set(['api snapshot', 'pane report-metadata', 'agent focus', 'agent prompt']));
      assert.ok(forwarded.every(c => c.options.timeoutMs === expected), `env ${value}: forwarded timeout ${expected}`);
      // Only the reply finishes after the app ends (keepOnExit); its reads stop with it.
      assert.deepEqual(forwarded.filter(c => c.options.keepOnExit).map(c => c.argv.slice(0, 2).join(' ')), ['agent prompt']);
      assert.ok(local.length && local.every(o => o.timeoutMs === 4000), 'local requests and machine discovery retain their budget');
    } finally { fake.runtime.close(); }
  }
});

// Model the forwarding adapter's timeout using virtual time: no subprocesses or sockets.
function slowForwarder(responseMs) {
  const calls = [];
  return {
    calls,
    forward(label, argv, options) {
      if (argv[0] !== 'api') return Promise.resolve({ result: { type: 'ok' } });
      assert.ok(!calls.some(c => c.label === label && c.finished === undefined), `${label} has at most one snapshot in flight`);
      const call = { label, started: Date.now(), timeoutMs: options.timeoutMs, finished: undefined };
      calls.push(call);
      return new Promise((resolve, reject) => setTimeout(() => {
        call.finished = Date.now();
        if (responseMs > options.timeoutMs) reject(new core.HerdrTimeoutError('api snapshot', options.timeoutMs));
        else resolve({ result: { snapshot: snapshot([pane('remote', 'remote-done', 'done')]) } });
      }, Math.min(responseMs, options.timeoutMs)));
    },
  };
}

for (const [responseMs, override] of [[25000, undefined], [47000, '60000']]) {
  test(`Observatory remote polling: ${responseMs}ms first result survives interval ticks without overlap`, async t => {
    remoteTimeoutEnv(t, override);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const state = fixture(); state.observatory.machines.pop();
    const transport = slowForwarder(responseMs);
    const fake = fakeRuntime(state, { herdrOnMachine: transport.forward }, { timers: true });
    try {
      const first = fake.runtime.start(); await flushAsync();
      const placeholder = state.observatory.machines.find(m => m.id === 'build');
      assert.match(lines(render(state, 22)), /connecting…/);
      let elapsed = 0;
      while (elapsed + 15000 < responseMs) {
        t.mock.timers.tick(15000); elapsed += 15000; await flushAsync();
        await fake.runtime.refreshRemotes(); // overlapping manual refresh also skips, without queuing
        assert.equal(transport.calls.length, 1);
        assert.strictEqual(state.observatory.machines.find(m => m.id === 'build'), placeholder);
        assert.doesNotMatch(lines(render(state, 22)), /not reachable|✗/);
      }
      t.mock.timers.tick(responseMs - elapsed); await first;
      const connected = state.observatory.machines.find(m => m.id === 'build');
      assert.ok(connected.snapshot); assert.equal(connected.error, undefined);
      assert.notStrictEqual(connected, placeholder);
      assert.doesNotMatch(lines(render(state, 22)), /connecting…/);
      assert.equal(transport.calls.length, 1, 'no catch-up poll is queued');
      t.mock.timers.tick(14999); await flushAsync(); await fake.runtime.refreshRemotes();
      assert.equal(transport.calls.length, 1);
      t.mock.timers.tick(1);
      const next = fake.runtime.refreshRemotes(); await flushAsync();
      assert.equal(transport.calls.length, 2);
      assert.strictEqual(state.observatory.machines.find(m => m.id === 'build'), connected, 'refresh retains the previous result');
      t.mock.timers.tick(responseMs); await next;
    } finally { fake.runtime.close(); }
  });
}

test('Observatory remote polling: transport timeout changes connecting to failure and starts cooldown on completion', async t => {
  remoteTimeoutEnv(t, undefined);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const state = fixture(); state.observatory.machines.pop();
  const transport = slowForwarder(40000);
  const fake = fakeRuntime(state, { herdrOnMachine: transport.forward }, { timers: true });
  try {
    const first = fake.runtime.start(); await flushAsync();
    t.mock.timers.tick(15000); await flushAsync();
    t.mock.timers.tick(14999); await flushAsync();
    assert.equal(transport.calls.length, 1); assert.match(lines(render(state, 22)), /connecting…/);
    t.mock.timers.tick(1); await first;
    const failed = state.observatory.machines.find(m => m.id === 'build');
    assert.match(failed.error, /timed out after 30000 ms/); assert.match(lines(render(state, 22)), /build-box ✗/);
    t.mock.timers.tick(29999); await flushAsync(); await fake.runtime.refreshRemotes();
    assert.equal(transport.calls.length, 1); assert.strictEqual(state.observatory.machines.find(m => m.id === 'build'), failed);
    t.mock.timers.tick(1); await flushAsync();
    assert.equal(transport.calls.length, 2); assert.equal(transport.calls[1].started, 60000);
    t.mock.timers.tick(30000); await flushAsync();
  } finally { fake.runtime.close(); }
});

test('Observatory remote polling: failure doubles backoff to two minutes and success resets it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const state = fixture();
  let attempts = 0, fail = true;
  const fake = fakeRuntime(state, { herdrOnMachine: async (_label, argv) => {
    if (argv[0] !== 'api') return { result: { type: 'ok' } };
    attempts++;
    if (fail) throw new Error('ssh unavailable');
    return { snapshot: snapshot([pane('remote', 'remote-done', 'done')]) };
  } });
  try {
    await fake.runtime.refreshRemotes(); assert.equal(attempts, 1);
    for (const delay of [30000, 60000, 120000, 120000]) {
      const before = attempts, failed = state.observatory.machines.find(m => m.id === 'build');
      t.mock.timers.tick(delay - 1); await fake.runtime.refreshRemotes();
      assert.equal(attempts, before, `skip during ${delay}ms cooldown`);
      assert.strictEqual(state.observatory.machines.find(m => m.id === 'build'), failed);
      t.mock.timers.tick(1); await fake.runtime.refreshRemotes();
      assert.equal(attempts, before + 1);
    }
    fail = false; t.mock.timers.tick(120000); await fake.runtime.refreshRemotes();
    assert.equal(state.observatory.machines.find(m => m.id === 'build').error, undefined);
    assert.ok(state.observatory.machines.find(m => m.id === 'build').snapshot);
    const before = attempts;
    t.mock.timers.tick(14999); await fake.runtime.refreshRemotes(); assert.equal(attempts, before);
    t.mock.timers.tick(1); await fake.runtime.refreshRemotes(); assert.equal(attempts, before + 1, 'normal 15s interval restored');
    fail = true; t.mock.timers.tick(15000); await fake.runtime.refreshRemotes();
    t.mock.timers.tick(29999); await fake.runtime.refreshRemotes(); assert.equal(attempts, before + 2);
    t.mock.timers.tick(1); await fake.runtime.refreshRemotes(); assert.equal(attempts, before + 3, 'new failure restarts at 30s');
  } finally { fake.runtime.close(); }
});

test('Observatory remote polling: a slow machine does not hold up another machine', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const state = fixture(), slow = deferred(), calls = [];
  // Polls only: the tab tidy reads a machine's snapshot again before it makes a btop tab, through this
  // same transport, and that read is not a poll.
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrMachines: async () => [{ id: 'build', label: 'build-box', enabled: true }, { id: 'other', label: 'other-box', enabled: true }],
    herdrOnMachine: async (label, argv) => {
      if (argv[0] !== 'api') return { result: { type: 'ok' } };
      calls.push(label);
      return label === 'build-box' ? slow.promise : { snapshot: snapshot([]) };
    },
  });
  try {
    const first = fake.runtime.refreshRemotes(); await flushAsync();
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(15000); await fake.runtime.refreshRemotes(); }
    assert.equal(calls.filter(label => label === 'build-box').length, 1);
    assert.equal(calls.filter(label => label === 'other-box').length, 4);
    slow.resolve({ snapshot: snapshot([]) }); await first;
    assert.ok(state.observatory.machines.find(m => m.id === 'build').snapshot);
  } finally { fake.runtime.close(); }
});

test('Observatory remote polling: concurrent discovery coalesces without duplicate snapshot requests', async () => {
  const state = fixture(), discovered = deferred(), response = deferred();
  let discoveries = 0, polls = 0;
  const fake = fakeRuntime(state, {
    herdrMachines: () => { discoveries++; return discovered.promise; },
    herdrOnMachine: async (_label, argv) => {
      if (argv[0] !== 'api') return { result: { type: 'ok' } };
      polls++; return response.promise;
    },
  });
  try {
    const first = fake.runtime.refreshRemotes(), second = fake.runtime.refreshRemotes();
    assert.equal(discoveries, 1);
    discovered.resolve([{ id: 'build', label: 'build-box', enabled: true }]); await flushAsync();
    assert.equal(polls, 1);
    response.resolve({ snapshot: snapshot([]) }); await Promise.all([first, second]);
    assert.equal(polls, 1);
  } finally { fake.runtime.close(); }
});

test('Observatory remote polling: removal and re-enable retain the flight latch and discard the obsolete response', async () => {
  const state = fixture(); state.observatory.machines.pop();
  let enabled = true, response = deferred(), polls = 0;
  const fake = fakeRuntime(state, {
    herdrMachines: async () => [{ id: 'build', label: 'build-box', enabled }],
    herdrOnMachine: async (_label, argv) => {
      if (argv[0] !== 'api') return { result: { type: 'ok' } };
      polls++; return response.promise;
    },
  });
  try {
    const first = fake.runtime.refreshRemotes(); await flushAsync();
    enabled = false; await fake.runtime.refreshRemotes();
    assert.ok(!state.observatory.machines.some(m => m.id === 'build'));
    enabled = true; await fake.runtime.refreshRemotes(); assert.equal(polls, 1);
    response.resolve({ snapshot: snapshot([pane('old', 'old-session', 'idle')]) }); await first;
    assert.equal(state.observatory.machines.find(m => m.id === 'build').snapshot, undefined, 'old response cannot replace the new placeholder');
    response = deferred(); const next = fake.runtime.refreshRemotes(); await flushAsync();
    assert.equal(polls, 2);
    response.resolve({ snapshot: snapshot([]) }); await next;
    assert.ok(state.observatory.machines.find(m => m.id === 'build').snapshot);
  } finally { fake.runtime.close(); }
});

test('Observatory reply: pin/live/blocked gates, focus, immediate send, failure and repin isolation', async () => {
  let state = fixture();
  const calls = []; let request = deferred();
  const fake = fakeRuntime(state, { herdrAgent: { prompt: (...args) => { calls.push(args); return request.promise; } } });
  try {
    assert.equal(tui.observatoryReplyRow(state, 'obs-detail', 50, 'none'), undefined);
    fake.runtime.focusReply('obs-detail'); assert.match(fake.statuses.at(-1), /Pin/);
    Object.assign(state, pin(state));
    assert.equal(tui.observatoryReplyRow(state, 'obs-detail', 50, 'none'), undefined);
    fake.runtime.focusReply('obs-detail'); assert.ok(!state.observatory.details['obs-detail'].reply?.focused);
    await fake.runtime.sendReply('obs-detail'); assert.equal(calls.length, 0);
    state.observatory.machines[0].snapshot.panes[0].agent_status = 'idle';
    fake.runtime.focusReply('obs-detail');
    fake.runtime.editReply('obs-detail', 'A reply without waiting');
    assert.match(tui.observatoryReplyRow(state, 'obs-detail', 50, 'none'), /> A reply without waiting_/);
    const sending = fake.runtime.sendReply('obs-detail');
    assert.deepEqual(calls[0][0], { target: 'claude-conversation', text: 'A reply without waiting' });
    assert.ok(!('wait' in calls[0][0]));
    assert.match(lines(render({ ...state, screen: 'session-detail' })), /^\|A reply without waiting +\|$/m);
    assert.match(tui.observatoryReplyRow(state, 'obs-detail', 50, 'none'), /Sending/);
    await fake.runtime.sendReply('obs-detail'); assert.equal(calls.length, 1, 'no double submission');
    fake.runtime.focusReply('obs-detail', false);
    request.resolve({ type: 'agent_prompted' }); await sending;
    assert.equal(state.observatory.details['obs-detail'].reply.sending, false);
    assert.equal(state.observatory.details['obs-detail'].reply.focused, false, 'esc survives async send');
    fake.runtime.focusReply('obs-detail');
    fake.runtime.editReply('obs-detail', 'Restore on refusal');
    request = deferred(); const failed = fake.runtime.sendReply('obs-detail');
    request.reject(new Error('agent_blocked')); await failed;
    const detail = state.observatory.details['obs-detail'];
    assert.equal(detail.reply.text, 'Restore on refusal'); assert.match(detail.reply.error, /agent_blocked/);
    // Kept as a draft, in the words `oak prompt` uses for one, never as a failure.
    assert.equal(fake.statuses.at(-1), 'Draft retained: agent_blocked');
    assert.match(lines(render({ ...state, screen: 'session-detail' })), /Draft retained: agent_blocked/);
    assert.equal(detail.optimistic.length, 1, 'failed bubble removed, accepted bubble retained');
    request = deferred(); const late = fake.runtime.sendReply('obs-detail');
    Object.assign(state, pin(state, 'working'));
    request.reject(new Error('late refusal')); await late;
    assert.equal(state.observatory.details['obs-detail'].selection.session, 'working');
    assert.equal(state.observatory.details['obs-detail'].reply, undefined);
    Object.assign(state, pin(state, 'unresolved'));
    assert.equal(tui.observatoryReplyRow(state, 'obs-detail', 50, 'none'), undefined);
    await fake.runtime.sendReply('obs-detail'); assert.equal(calls.length, 3);
  } finally { fake.runtime.close(); }
});

test('Observatory reply: remote target, blocked transition, pane loss and transcript reconciliation', async () => {
  const state = pin(fixture(), 'remote-done');
  let events = [], cursor = 0;
  const calls = [];
  const fake = fakeRuntime(state, {
    herdrOnMachine: async (label, argv) => { calls.push({ label, argv }); return { result: { type: 'agent_prompted' } }; },
    conversationEvents: () => ({ events, cursor: ++cursor, transcriptPath: null }),
  });
  try {
    fake.runtime.focusReply('obs-detail'); fake.runtime.editReply('obs-detail', '--keep all words');
    await fake.runtime.sendReply('obs-detail');
    assert.deepEqual(calls, [{ label: 'build-box', argv: ['agent', 'prompt', 'remote-done', '--keep all words'] }]);
    const pending = state.observatory.details['obs-detail'].optimistic[0].event;
    await fake.runtime.load('obs-detail');
    assert.equal(state.observatory.details['obs-detail'].optimistic.length, 1, 'loading an unchanged transcript retains the prompt');
    events = [pending]; await fake.runtime.load('obs-detail');
    assert.equal(state.observatory.details['obs-detail'].optimistic.length, 0);
    assert.equal((lines(render({ ...state, screen: 'session-detail' })).match(/--keep all words/g) || []).length, 1);
    fake.runtime.editReply('obs-detail', '--keep all words'); await fake.runtime.sendReply('obs-detail');
    await fake.runtime.load('obs-detail');
    assert.equal(state.observatory.details['obs-detail'].optimistic.length, 1, 'an older identical prompt cannot acknowledge a new send');
    events = [...events, pending]; await fake.runtime.load('obs-detail');
    assert.equal(state.observatory.details['obs-detail'].optimistic.length, 0);
    fake.runtime.editReply('obs-detail', 'Keep this draft');
    state.observatory.machines[1].snapshot.panes[0].agent_status = 'blocked';
    await fake.runtime.sendReply('obs-detail'); assert.equal(calls.length, 2);
    assert.equal(tui.observatoryReplyRow(state, 'obs-detail', 40, 'none'), undefined);
    state.observatory.machines[1].snapshot.panes = [];
    await fake.runtime.sendReply('obs-detail'); assert.equal(calls.length, 2);
    assert.equal(tui.observatoryReplyRow(state, 'obs-detail', 40, 'none'), undefined);
    assert.equal(state.observatory.details['obs-detail'].reply.text, 'Keep this draft');
  } finally { fake.runtime.close(); }
});

const detailRoot = { kind: 'pane', id: 'obs-detail', view: 'session-detail' };
const detailFrame = (state, glyphs = g) => tui.renderTreeBody(state, detailRoot, 50, 12, 'obs-detail', glyphs, 'none').join('\n');
const prompt = text => ({ ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text } } });
const history = () => Array.from({ length: 30 }, (_, i) => prompt(`Message ${String(i + 1).padStart(2, '0')}`));

test('Observatory detail scroll: async initial load opens at newest after painting loading rows', async t => {
  const { base } = isolated(t), file = path.join(base, 'conversation.jsonl'); fs.writeFileSync(file, '');
  const state = pin(fixture(), 'working'), pending = deferred();
  const fake = fakeRuntime(state, {}, { reader: { read: () => pending.promise, diff: async () => '', fleet: async () => ({}), close() {} } });
  t.after(() => fake.runtime.close());
  const loading = fake.runtime.load('obs-detail');
  assert.equal(state.observatory.details['obs-detail'].loading, true);
  assert.match(detailFrame(state), /loading conversation/);
  pending.resolve({ events: history(), cursor: 0, transcriptPath: file });
  await loading;
  for (const glyphs of [g, tui.glyphs('safe'), { ...g, boxes: false }]) {
    const frame = detailFrame(state, glyphs);
    assert.match(frame, /Message 30/);
    assert.doesNotMatch(frame, /Message 01|↓ newest/);
    assert.equal(frame.split('\n').length, 12);
  }
  golden('observatory-scroll-loaded', detailFrame(state));
});

test('Observatory detail scroll: follow appended events and keep independent leaf positions', async t => {
  const { base } = isolated(t), file = path.join(base, 'conversation.jsonl'); fs.writeFileSync(file, '');
  const state = pin(pin(fixture(), 'working'), 'remote-done', 'second-detail');
  const fake = fakeRuntime(state, {}, { reader: {
    read: async (_session, _root, since) => ({ events: since === undefined ? history() : [prompt('Newest appended message')],
      cursor: since === undefined ? 0 : 1, transcriptPath: file }),
    diff: async () => '', fleet: async () => ({}), close() {},
  } });
  t.after(() => fake.runtime.close());
  await fake.runtime.load('obs-detail');
  // The other pin is deliberately above its tail and must stay there while this one follows.
  state.treeScroll = { ...state.treeScroll, 'second-detail': 3 };
  assert.match(detailFrame(state), /Message 30/);
  fs.appendFileSync(file, '\n'); await fake.runtime.tail();
  assert.match(detailFrame(state), /Newest appended message/);
  assert.doesNotMatch(detailFrame(state), /↓ newest/);
  assert.equal(state.treeScroll['second-detail'], 3);
  golden('observatory-scroll-appended', detailFrame(state));
});

test('Observatory detail scroll: reading history holds its offset and offers newest', () => {
  let state = pin(fixture(), 'working');
  Object.assign(state.observatory.details['obs-detail'], { loading: false, events: history() });
  state.treeScroll = { 'obs-detail': 8 };
  const before = detailFrame(state);
  state.observatory.details['obs-detail'] = { ...state.observatory.details['obs-detail'],
    events: [...state.observatory.details['obs-detail'].events, prompt('Newest appended message')] };
  for (const glyphs of [g, tui.glyphs('safe'), { ...g, boxes: false }]) {
    const frame = detailFrame(state, glyphs);
    assert.match(frame, /↓ newest · End/);
    assert.doesNotMatch(frame, /Newest appended message/);
    assert.ok(frame.split('\n').every(line => tui.displayWidth(line) <= 50));
  }
  assert.equal(detailFrame(state), before, 'append cannot shift the history being read');
  state = pin(state, 'working');
  assert.equal(state.treeScroll['obs-detail'], 8, 'repinning the same session preserves the reader position');
  golden('observatory-scroll-history', detailFrame(state));
});

for (const session of ['claude-conversation', 'unresolved']) test(`Observatory detail reply hidden: ${session}`, () => {
  const state = pin(fixture(), session), fake = fakeRuntime(state);
  try {
    Object.assign(state.observatory.details['obs-detail'], { loading: false, events: [prompt('Read this conversation')] });
    assert.equal(tui.observatoryReplyRow(state, 'obs-detail', 50, 'none'), undefined);
    fake.runtime.focusReply('obs-detail');
    assert.equal(fake.statuses.at(-1), session === 'unresolved' ? 'No live pane' : 'Blocked · answer in herdr');
    assert.ok(!state.observatory.details['obs-detail'].reply?.focused);
    for (const glyphs of [g, { ...g, boxes: false }]) {
      const frame = detailFrame(state, glyphs);
      assert.doesNotMatch(frame, /Reply disabled|[Nn]o live pane|[Bb]locked · answer in herdr|c reply/);
      assert.equal(frame.split('\n').length, 12);
      const pl = { ...detailRoot, rect: { x: 0, y: 0, w: 50, h: 12 }, focused: true };
      assert.equal(tui.treePaneBodyHeight(state, pl, glyphs), glyphs.boxes ? 10 : 11, 'no blank composer row');
    }
    golden(`observatory-reply-hidden-${session === 'unresolved' ? 'no-pane' : 'blocked'}`, detailFrame(state));
  } finally { fake.runtime.close(); }
});

// A Codex agent asked a question and kept working: herdr calls its pane blocked (Codex's title says "Action
// Required"), while its row says the turn still runs. The list reads working, spinner moving, with the question in
// the waiting state's glyph and tint; the reply still waits for the answer in herdr.
function asking({ row = {}, agent = 'codex' } = {}) {
  const state = fixture();
  state.views.sessions.sessions.push({ id: 'codex-asking', title: 'Assess the processing step', pending: 0, agent: 'codex', model: 'GPT', tokens: 900,
    lastActiveMs: state.now - 10_000, phase: 'working', machine: 'laptop', turnOpen: true, attention: null, ...row });
  state.observatory.machines[0].snapshot = snapshot([...state.observatory.machines[0].snapshot.panes, pane('p4', 'codex-asking', 'blocked', agent)]);
  return state;
}
const askingLine = (state, depth = 'none', width = 82) => tui.rowsFor(fresh(state), width, g, depth).find(r => r.key === 'session:local:p4:codex-asking:state')?.cells;

test('Observatory master: a Codex agent working with a question waiting reads working · ? question, not blocked', () => {
  const state = asking();
  assert.match(askingLine(state), /^ {8}\S working · \? question · GPT · 900 tok · 0 pending · 14:00:50$/);
  assert.notEqual(askingLine(state).trim()[0], askingLine({ ...state, now: state.now + 120 }).trim()[0], 'its spinner moves');
  assert.ok(['|', '/', '-', '\\'].includes(askingLine(state).trim()[0]), 'the working spinner, not the blocked pulse');
  const colour = askingLine(state, 'truecolor');
  assert.ok(colour.includes(` ${tui.tint('working', 'live', 'truecolor')} · ${tui.tint('? question', 'agent', 'truecolor')} · `),
    'working in its own tint, the question in the waiting state\'s');
  assert.equal(tui.agentStateFace('blocked', g).key, 'agent', 'control: the waiting state\'s tint');
  for (const glyphs of [tui.glyphs('safe'), tui.glyphs('ascii')]) {
    assert.match(tui.stripSgr(tui.rowsFor(fresh(state), 82, glyphs, 'none').find(r => r.key === 'session:local:p4:codex-asking:state').cells), / working · \? question · /);
  }
  // The other blocked pane, a Claude one, is herdr's blocked as before.
  assert.match(lines(render(state)), /Fix the demo\n\s+\S blocked · Opus/);
  // The detail header says the same, without the spinner.
  const header = lines(render({ ...pin(state, 'codex-asking'), screen: 'session-detail' }, 120)).split('\n')[0];
  assert.match(header, /^Assess the processing step · laptop · > working · \? question · GPT · 900 tokens · 0 pending$/);
});

test('Observatory master: blocked stays blocked when the turn ended, went quiet, raised a hand, or the pane is Claude\'s', () => {
  const blocked = /^ {8}\S blocked · GPT · /;
  assert.match(askingLine(asking({ row: { turnOpen: false } })), blocked, 'the turn ended');
  assert.match(askingLine(asking({ row: { turnOpen: undefined } })), blocked, 'an older OAK, or a rollout that could not say');
  assert.match(askingLine(asking({ row: { lastActiveMs: fixture().now - 91_000 } })), blocked, 'quiet past the window');
  assert.match(askingLine(asking({ row: { attention: { kind: 'permission', message: 'Bash', ts: fixture().now } } })), blocked, 'a permission prompt stands');
  assert.match(askingLine(asking({ agent: 'claude' })), blocked, 'a Claude pane');
  const stale = asking({ row: { lastActiveMs: fixture().now - 91_000 } });
  const header = lines(render({ ...pin(stale, 'codex-asking'), screen: 'session-detail' }, 120)).split('\n')[0];
  assert.match(header, /· laptop · \? blocked · GPT ·/);
  assert.doesNotMatch(header, /question/);
});

test('Observatory reply: a question waiting holds the reply for an answer in herdr, and says so', async () => {
  const state = pin(asking(), 'codex-asking');
  const calls = [];
  const fake = fakeRuntime(state, { herdrAgent: { prompt: (...args) => { calls.push(args); return Promise.resolve({ type: 'agent_prompted' }); } } });
  try {
    assert.equal(tui.observatoryReply(state, 'obs-detail').reason, 'Question waiting · answer in herdr');
    assert.equal(tui.observatoryReplyRow(state, 'obs-detail', 50, 'none'), undefined, 'no reply box');
    fake.runtime.focusReply('obs-detail');
    assert.equal(fake.statuses.at(-1), 'Question waiting · answer in herdr');
    await fake.runtime.sendReply('obs-detail');
    assert.equal(calls.length, 0, 'nothing is sent to the pane');
    // Once the turn ends, the reason is herdr's blocked again.
    state.views.sessions.sessions.find(r => r.id === 'codex-asking').turnOpen = false;
    assert.equal(tui.observatoryReply(state, 'obs-detail').reason, 'Blocked · answer in herdr');
  } finally { fake.runtime.close(); }
});

// Codex's PermissionRequest hook raises the hand before Codex shows the approval and herdr calls the pane blocked. While
// the app polls the listing itself (catalogFresh), the row read before the hand reads as a question waiting until the
// next poll: the flip is the runtime's cue to list this machine's sessions again at once, and only the flip.
test('Observatory: a Codex pane herdr has just called blocked lists this machine\'s sessions again at once', async () => {
  const state = asking();
  const panes = state.observatory.machines[0].snapshot.panes;
  const at = status => snapshot([...panes.filter(p => p.pane_id !== 'p4'), pane('p4', 'codex-asking', status, 'codex')]);
  let reads = 0;
  const hand = { kind: 'permission', message: 'Bash', ts: state.now };
  const fake = fakeRuntime(state, { herdrMachines: async () => [] }, { catalogFresh: () => true,
    reader: { ...testReader(), sessions: async () => { reads++; return { sessions: state.views.sessions.sessions.map(r => r.id === 'codex-asking' ? { ...r, attention: hand } : r) }; } } });
  try {
    fake.snapshot(at('working'));
    await fake.runtime.refreshLocal(); await flushAsync();
    assert.equal(reads, 0, 'control: a working pane lists nothing here (the app\'s poll does)');
    fake.snapshot(at('blocked'));
    await fake.runtime.refreshLocal(); await flushAsync();
    assert.equal(reads, 1, 'the flip to blocked lists the sessions');
    assert.match(askingLine(state), /^ {8}\S blocked · GPT · /, 'the approval reads blocked, its hand raised');
    await fake.runtime.refreshLocal(); await flushAsync();
    assert.equal(reads, 1, 'a pane that stays blocked lists nothing more');
  } finally { fake.runtime.close(); }
});

// A long command writes nothing to Codex's rollout, so past the window the row read herdr's blocked while Codex's screen
// plainly showed it working. Such a pane's screen is read through herdr (`pane.read`, as text), only in that state and once
// for each revision herdr gives the pane: the row reads working · ? question while Codex's timer is above its prompt, and
// herdr's blocked once it is gone. Every read reaches a scripted herdr (fake-herdr.js), never a real one.
const codexScreens = {
  working: '• Ran the build\n\nWorking (10m 4s • esc to interrupt) · Running hook\n\n• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer\n\n› Ask Codex to do anything\n\n  model-x high · ~/project · Context 40% used\n',
  finished: '• Built it.\n\n─ Worked for 10m 4s ─────────\n\n› Ask Codex to do anything\n',
};
const paneRead = (pane_id, text) => ({ type: 'pane_read', read: { pane_id, workspace_id: 'w1', tab_id: 'tab', source: 'visible', format: 'text', text, revision: 1, truncated: false } });

/** This machine's Codex pane `p4`, blocked in herdr, its rollout ten minutes quiet, its turn open and no hand, read
 *  against the clock the runtime reads; its screen comes from a scripted herdr (`screen.text`, failing while
 *  `screen.fail`), and `changeScreen` gives the next snapshot a new revision for it. */
async function quietCodex(t, runtimeOptions = {}) {
  const { fakeHerdr } = require('../../core/test/fake-herdr');
  const screen = { text: codexScreens.working, fail: false, snapshotFails: false };
  const herdr = await fakeHerdr(t, { 'pane.read': ({ pane_id }) => {
    if (screen.fail) throw screen.fail instanceof Error ? screen.fail : Object.assign(new Error('screen unavailable'), { code: 'read_failed' });
    return paneRead(pane_id, screen.text);
  } });
  if (!herdr) return null;
  const state = asking();
  state.now = Date.now();
  const row = state.views.sessions.sessions.find(r => r.id === 'codex-asking');
  row.lastActiveMs = state.now - 600_000;
  // Revision 0, as herdr 0.9.1 gives every pane: what its screen showed is still evidence.
  const panes = state.observatory.machines[0].snapshot.panes.map(p => p.pane_id === 'p4' ? { ...p, revision: 0 } : p);
  let current = snapshot(panes), revision = 0;
  const statuses = [];
  const fake = { ...core, findHerdrBin: () => '/herdr', herdrMachines: async () => [],
    herdrSnapshot: async () => { if (screen.snapshotFails) throw new Error('herdr is not answering'); return current; },
    herdrRequest: (method, params, o) => core.herdrRequest(method, params, { ...o, socketPath: herdr.socketPath }),
    herdrSubscribe: () => ({ close() {} }), readHerdrPaneLink: () => null, observatoryRoots: () => [], sessionMeta: () => state.views.sessions };
  const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', reader: testReader(fake), changed() {}, status: m => statuses.push(m), timers: false, watch: false, readOnly: true, ...runtimeOptions });
  t.after(() => runtime.close());
  return { state, row, runtime, screen, statuses,
    changeScreen: () => { current = snapshot(panes.map(p => p.pane_id === 'p4' ? { ...p, revision: ++revision } : p)); },
    reads: () => herdr.calls('pane.read'),
    refresh: async () => { await runtime.refreshLocal(); await runtime.readScreens(); } };
}

test('Observatory: a Codex pane quiet past the window shows what its screen shows, read once for each revision (2026-10-29)', { timeout: 30000 }, async t => {
  const fx = await quietCodex(t);
  if (!fx) return;
  const { state, row, runtime, screen, statuses, changeScreen, reads, refresh } = fx;
  assert.match(askingLine(state), / blocked · GPT · /, 'control: quiet past the window, with nothing read, herdr\'s blocked');
  await refresh();
  assert.deepEqual(reads(), [{ pane_id: 'p4', source: 'visible', format: 'text', strip_ansi: true }], 'only that pane is read, as herdr\'s CLI reads it: the blocked Claude pane is not');
  assert.match(askingLine(state), / working · \? question · GPT · /, 'Codex\'s timer above its prompt: working, the question beside it');
  await refresh();
  assert.equal(reads().length, 1, 'the same revision: its screen is not read again');
  assert.match(askingLine(state), / working · \? question · /);
  // A newer screen is read again; until that read lands, the pane keeps what the last one found.
  screen.text = codexScreens.finished; changeScreen();
  await runtime.refreshLocal();
  assert.match(askingLine(state), / working · \? question · /, 'no blink to blocked while its newer screen is read');
  await runtime.readScreens();
  assert.equal(reads().length, 2);
  assert.match(askingLine(state), / blocked · GPT · /, 'the timer gone from its screen: herdr\'s blocked');
  // A read that fails is no evidence, said nowhere, and not asked again for the same screen.
  screen.text = codexScreens.working; screen.fail = true; changeScreen();
  await refresh();
  assert.equal(reads().length, 3);
  assert.match(askingLine(state), / blocked · GPT · /, 'herdr\'s word stands');
  await refresh();
  assert.equal(reads().length, 3, 'a failed read is not repeated for the same screen');
  assert.deepEqual(statuses, [], 'and the status row says nothing of it');
  screen.fail = false;
  // Out of that state no screen is read, whatever it shows: written within the window, a hand raised, the turn ended.
  for (const [why, edit] of [['written within the window', { lastActiveMs: Date.now() - 10_000 }],
    ['a permission prompt raised', { attention: { kind: 'permission', message: 'Bash', ts: Date.now() } }], ['the turn ended', { turnOpen: false }]]) {
    const saved = { ...row };
    Object.assign(row, edit); changeScreen();
    await refresh();
    assert.equal(reads().length, 3, why);
    Object.assign(row, saved);
  }
  // Back in that state, the newest screen is read.
  changeScreen();
  await refresh();
  assert.equal(reads().length, 4);
  assert.match(askingLine(state), / working · \? question · /);
});

// What a screen showed lasts while herdr's blocked sits on the open turn: through the rollout's writes (a quiet spell after
// one keeps it until the newer screen is read), and the pass between snapshots reads a pane whose window ran out since the
// last one. A hand raised, the turn ended or a snapshot that fails forgets it, and nothing is carried back from before.
test('Observatory: a Codex pane\'s screen reading lasts through the rollout\'s writes, and goes with its turn, its hand or its machine (2026-10-29)', { timeout: 30000 }, async t => {
  const fx = await quietCodex(t);
  if (!fx) return;
  const { state, row, runtime, screen, changeScreen, reads, refresh } = fx;
  await refresh();
  assert.equal(reads().length, 1);
  assert.match(askingLine(state), / working · \? question · /, 'control: read, Codex at work');
  // The rollout written: the window decides and nothing is read. Quiet again on a newer screen, the reading from before
  // the write stands until that screen is read.
  row.lastActiveMs = Date.now() - 10_000; changeScreen();
  await refresh();
  assert.equal(reads().length, 1, 'written within the window: no screen is read');
  row.lastActiveMs = Date.now() - 600_000; changeScreen();
  await runtime.refreshLocal();
  assert.match(askingLine(state), / working · \? question · /, 'quiet again: no blink to blocked while the newer screen is read');
  await runtime.readScreens();
  assert.equal(reads().length, 2);
  // The window runs out between snapshots: the pass, which runs every second, reads the pane at once.
  row.lastActiveMs = Date.now() - 10_000; changeScreen();
  await refresh();
  assert.equal(reads().length, 2, 'control: within the window, nothing read');
  row.lastActiveMs = Date.now() - 600_000;
  await runtime.readScreens();
  assert.equal(reads().length, 3, 'quiet past the window since the last snapshot: read with no snapshot after it');
  // A hand raised, the turn ended, or a snapshot that failed: the reading goes, and back in that state the pane is herdr's
  // blocked until its screen is read again.
  const leave = { 'a permission prompt raised': () => { row.attention = { kind: 'permission', message: 'Bash', ts: Date.now() }; },
    'the turn ended': () => { row.turnOpen = false; }, 'a snapshot that failed': () => { screen.snapshotFails = true; } };
  for (const [why, away] of Object.entries(leave)) {
    const saved = { ...row }, before = reads().length;
    away(); changeScreen();
    await refresh();
    assert.equal(reads().length, before, `${why}: no screen is read`);
    Object.assign(row, saved); screen.snapshotFails = false; changeScreen();
    await runtime.refreshLocal();
    assert.match(askingLine(state), / blocked · GPT · /, `${why}, then back: nothing carried over from before`);
    await runtime.readScreens();
    assert.equal(reads().length, before + 1);
    assert.match(askingLine(state), / working · \? question · /);
  }
});

test('Observatory: the screen pass runs on its own every second between snapshots (2026-10-29)', { timeout: 30000 }, async t => {
  const fx = await quietCodex(t, { timers: true });
  if (!fx) return;
  const { row, runtime, reads } = fx;
  row.lastActiveMs = Date.now() - 10_000;
  await runtime.refreshLocal();
  assert.equal(reads().length, 0, 'control: within the window, nothing is read');
  row.lastActiveMs = Date.now() - 600_000;
  for (let i = 0; i < 60 && !reads().length; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(reads().length, 1, 'quiet past the window, it is read within the second, with no snapshot after it');
});

// herdr 0.9.1 gives every pane revision 0 whatever its screen does (measured on a sandboxed server, with a client
// attached and without), so a reading also lapses: a pane still in that state is read again 15 seconds on, not before.
test('Observatory: a screen reading lapses after 15 seconds, since herdr 0.9.1 gives every pane revision 0 (2026-10-29)', { timeout: 30000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fx = await quietCodex(t);
  if (!fx) return;
  const { state, screen, reads, refresh } = fx;
  await refresh();
  assert.equal(reads().length, 1);
  assert.match(askingLine(state), / working · \? question · /, 'control: read, Codex at work');
  t.mock.timers.tick(14_000);
  await refresh();
  assert.equal(reads().length, 1, 'the same revision, read 14 seconds ago: not read again');
  screen.text = codexScreens.finished;
  t.mock.timers.tick(1_500);
  await refresh();
  assert.equal(reads().length, 2, 'the same revision, read over 15 seconds ago: read again');
  assert.match(askingLine(state), / blocked · GPT · /, 'and what the screen shows now stands');
});

// A one-shot frame waits for the screens it needs, and stops there: two quiet panes whose reads each take longer than a
// reading lasts are each read once, not one after the other for ever.
test('Observatory: readScreens settles with each pane read once, however long its reads take (2026-10-29)', { timeout: 30000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { fakeHerdr } = require('../../core/test/fake-herdr');
  const herdr = await fakeHerdr(t, { 'pane.read': ({ pane_id }) => { t.mock.timers.tick(16_000); return paneRead(pane_id, codexScreens.working); } });
  if (!herdr) return;
  const state = asking();
  state.now = Date.now();
  const quiet = { turnOpen: true, attention: null, lastActiveMs: state.now - 600_000 };
  Object.assign(state.views.sessions.sessions.find(r => r.id === 'codex-asking'), quiet);
  state.views.sessions.sessions.push({ id: 'codex-second', title: 'Second long build', pending: 0, agent: 'codex', model: 'GPT', tokens: 900, machine: 'laptop', ...quiet });
  const local = snapshot([...state.observatory.machines[0].snapshot.panes, pane('p5', 'codex-second', 'blocked', 'codex')]);
  const fake = { ...core, findHerdrBin: () => '/herdr', herdrMachines: async () => [], herdrSnapshot: async () => local,
    herdrRequest: (method, params, o) => core.herdrRequest(method, params, { ...o, socketPath: herdr.socketPath }),
    herdrSubscribe: () => ({ close() {} }), readHerdrPaneLink: () => null, observatoryRoots: () => [], sessionMeta: () => state.views.sessions };
  const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', reader: testReader(fake), changed() {}, status() {}, timers: false, watch: false, readOnly: true });
  t.after(() => runtime.close());
  await runtime.refreshLocal();
  await runtime.readScreens();
  assert.deepEqual(herdr.calls('pane.read').map(r => r.pane_id), ['p4', 'p5'], 'each pane read once');
});

test('Observatory: screens are read one at a time on a machine, the pane read longest ago first (2026-10-29)', { timeout: 30000 }, async () => {
  const state = asking();
  state.now = Date.now();
  const quiet = { turnOpen: true, attention: null, lastActiveMs: state.now - 600_000 };
  Object.assign(state.views.sessions.sessions.find(r => r.id === 'codex-asking'), quiet);
  state.views.sessions.sessions.push({ id: 'codex-second', title: 'Second long build', pending: 0, agent: 'codex', model: 'GPT', tokens: 900, machine: 'laptop', ...quiet });
  const panes = [...state.observatory.machines[0].snapshot.panes, pane('p5', 'codex-second', 'blocked', 'codex')];
  let current = snapshot(panes), revision = 1;
  const held = [];
  const fake = fakeRuntime(state, {
    herdrSnapshot: async () => current,
    herdrRequest: (method, params) => method === 'pane.read' ? new Promise(resolve => held.push({ pane: params.pane_id, answer: () => resolve(paneRead(params.pane_id, codexScreens.working)) }))
      : Promise.resolve({ type: 'ok' }),
  }, { readOnly: true });
  try {
    await fake.runtime.refreshLocal();
    assert.deepEqual(held.map(h => h.pane), ['p4'], 'one read at a time on this machine');
    await fake.runtime.refreshLocal();
    assert.deepEqual(held.map(h => h.pane), ['p4'], 'another snapshot while it is out starts no second read');
    held[0].answer(); await flushAsync(); await flushAsync();
    assert.deepEqual(held.map(h => h.pane), ['p4', 'p5'], 'the next pane once the first is read');
    held[1].answer(); await flushAsync(); await flushAsync();
    const change = ids => { revision++; current = snapshot(current.panes.map(p => ids.includes(p.pane_id) ? { ...p, revision } : p)); };
    // p4's screen changes and is read again, which leaves p5's reading the older one, though p5 comes after p4.
    await new Promise(resolve => setTimeout(resolve, 5));
    change(['p4']); await fake.runtime.refreshLocal();
    assert.equal(held[2].pane, 'p4');
    held[2].answer(); await flushAsync(); await flushAsync();
    assert.equal(held.length, 3, 'control: p5\'s screen has not changed, so it is not read');
    change(['p4', 'p5']); await fake.runtime.refreshLocal();
    assert.deepEqual(held.slice(3).map(h => h.pane), ['p5'], 'both changed: the pane read longest ago first, and one at a time');
  } finally { fake.runtime.close(); }
});

test('Observatory: a saved machine\'s Codex pane has its screen read there, through herdr\'s CLI with the remote budget (2026-10-29)', { timeout: 30000 }, async t => {
  const { fakeHerdr } = require('../../core/test/fake-herdr');
  const herdr = await fakeHerdr(t, { 'pane.read': ({ pane_id }) => paneRead(pane_id, codexScreens.working) });
  if (!herdr) return;
  remoteTimeoutEnv(t, '45000');
  const state = fixture();
  state.now = Date.now();
  const remote = state.observatory.machines[1];
  remote.snapshot.panes[0].agent_status = 'blocked';
  Object.assign(remote.sessions.sessions[0], { turnOpen: true, attention: null, lastActiveMs: state.now - 600_000 });
  const forwarded = [], asked = [];
  const fake = { ...core, findHerdrBin: () => '/herdr', herdrSnapshot: async () => state.observatory.machines[0].snapshot,
    herdrMachines: async () => [{ id: 'build', label: 'build-box', enabled: true }],
    herdrOnMachine: async (label, argv, o) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: remote.snapshot } };
      forwarded.push({ label, argv, text: o.text, timeoutMs: o.timeoutMs });
      return core.herdrOnMachine(label, argv, { ...o, binary: herdr.binary });
    },
    herdrRequest: async method => { asked.push(method); throw new Error(`${method}: this machine's herdr has nothing to answer here`); },
    herdrSubscribe: () => ({ close() {} }), readHerdrPaneLink: () => null, observatoryRoots: () => [], sessionMeta: () => state.views.sessions };
  const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', reader: testReader(fake), changed() {}, status() {}, timers: false, watch: false, readOnly: true });
  t.after(() => runtime.close());
  const remoteLine = () => render(state).find(r => r.key === 'session:build:p1:remote-done:state').cells;
  assert.match(remoteLine(), / blocked · GPT · /, 'control: herdr\'s blocked before its screen is read');
  await runtime.refreshRemotes();
  await runtime.readScreens();
  assert.deepEqual(forwarded, [{ label: 'build-box', argv: ['pane', 'read', 'p1', '--source', 'visible', '--format', 'text'], text: true, timeoutMs: 45000 }]);
  assert.deepEqual(herdr.calls('pane.read'), [{ pane_id: 'p1', source: 'visible', format: 'text', strip_ansi: true, machine: 'build-box' }], 'the CLI asks that machine\'s herdr');
  assert.match(remoteLine(), / working · \? question · GPT · /);
  assert.deepEqual(asked, [], 'nothing is read from this machine\'s herdr for it');
});

test('Observatory reply stays at the detail bottom with independent scroll and a full editable draft', () => {
  const state = pin(fixture(), 'working'); state.screen = 'session-detail';
  const detail = state.observatory.details['obs-detail'];
  detail.loading = false; detail.events = Array.from({ length: 30 }, () => turn());
  detail.reply = { text: 'a long draft with Unicode 🙂 and all its text intact', caret: 50, focused: true };
  for (const glyphs of [g, tui.glyphs('safe'), { ...g, boxes: false }]) for (const width of [40, 80]) {
    const root = { kind: 'pane', id: 'obs-detail', view: 'session-detail' };
    const pl = { ...root, rect: { x: 0, y: 0, w: width, h: 12 }, focused: true };
    const before = detail.reply.text;
    const bottom = glyphs.boxes ? 10 : 11;
    const first = tui.renderTreeBody(state, root, width, 12, 'obs-detail', glyphs, 'none');
    const scrolled = tui.renderTreeBody({ ...state, treeScroll: { 'obs-detail': 1000 } }, root, width, 12, 'obs-detail', glyphs, 'none');
    assert.equal(first[bottom], scrolled[bottom]); assert.match(first[bottom], /_/);
    assert.equal(first.length, 12); assert.equal(scrolled.length, 12);
    assert.equal(tui.treePaneBodyHeight(state, pl, glyphs), glyphs.boxes ? 9 : 10);
    assert.equal(detail.reply.text, before);
    assert.ok(first.every(row => tui.displayWidth(row) <= width));
  }
});

test('Native footers select complete measured tiers for herdr and shell', t => {
  const old = process.env.TMUX;
  delete process.env.TMUX;
  t.after(() => { if (old !== undefined) process.env.TMUX = old; });
  for (const id of ['herdr', 'shell']) for (const cols of [20, 40, 60, 62, 100]) {
    const state = fixture(); state.tabs = [{ ...state.tabs[0], id }]; state.activeTab = 0;
    state.panes = state.tabs[0].panes;
    const hints = id === 'herdr' ? tui.HERDR_HINTS : tui.NATIVE_HINTS;
    const footer = tui.renderDashFrame(state, { cols, rows: 24, glyphs: g, color: 'none' }).at(-1);
    assert.equal(footer.trimEnd(), hints.find(s => tui.displayWidth(s) <= cols - 1));
    assert.ok(tui.displayWidth(footer) < cols);
  }
  assert.match(tui.OBS_HINTS.join('\n'), /c reply.*esc/);
});

test("Observatory navigation: herdr's prefix then M and openConversation use the same select-and-pin transition", async () => {
  const state = fixture();
  const { runtime, calls } = fakeRuntime(state);
  try {
    await runtime.start();
    const current = await runtime.current();
    const fromLeader = pin(state, current.session, 'obs-detail', current.machineId);
    const fromDriveSession = pin(state, 'claude-conversation');
    assert.deepEqual(fromLeader, fromDriveSession);
    assert.equal(fromLeader.tabs[fromLeader.activeTab].id, 'observatory');
    assert.equal(fromLeader.observatory.details['obs-detail'].selection.session, 'claude-conversation');
    await runtime.focus(fromLeader.scopeWorker);
    assert.ok(calls.some(c => c.method === 'pane.current'));
    assert.ok(calls.some(c => c.method === 'pane.focus' && c.params.pane_id === 'p1'));
    await runtime.focus(tui.observatorySelection(state, 'remote-done'));
    assert.ok(calls.some(c => c.label === 'build-box' && c.argv.join(' ') === 'agent focus remote-done'));
  } finally { runtime.close(); }
});

test('Observatory subscriptions: every pane, newly created panes, reconnect, close, no views refetch', async () => {
  const state = fixture(), views = state.views;
  const fake = fakeRuntime(state);
  try {
    await fake.runtime.start(); await fake.runtime.publishStore();
    assert.deepEqual(fake.subs[0].subscriptions.slice(0, 4).map(s => s.type), ['pane.created', 'pane.closed', 'pane.agent_detected', 'workspace.renamed']);
    assert.deepEqual(fake.subs[0].subscriptions.slice(4).map(s => s.pane_id), ['p1', 'p2', 'p3']);
    // The rename event alone refreshes the local snapshot, so the workspace group is relabelled at once.
    fake.snapshot(snapshot([pane('p1', 'claude-conversation', 'blocked'), pane('p2', 'working', 'working'), pane('p3', 'idle', 'idle', 'claude', 'w2')], { w1: 'demo', w2: 'renamed docs' }));
    const w2Label = () => state.observatory.machines.find(m => m.local).snapshot.workspaces.find(w => w.workspace_id === 'w2').label;
    assert.equal(w2Label(), 'docs', 'control: the old label is showing');
    fake.subs[0].event({ type: 'workspace_renamed' });
    for (let i = 0; i < 20 && w2Label() !== 'renamed docs'; i++) await flushAsync();
    assert.equal(w2Label(), 'renamed docs');
    assert.equal(fake.subs[0].closed, false, 'same panes: the subscription is kept');
    fake.snapshot(snapshot([pane('p-new', 'new-session', 'working')]));
    fake.subs[0].event({ type: 'pane_created' });
    await fake.runtime.refreshLocal();
    assert.equal(fake.subs[0].closed, true);
    assert.deepEqual(fake.subs.at(-1).subscriptions.slice(4).map(s => s.pane_id), ['p-new']);
    fake.subs.at(-1).options.onStatus('connected'); await fake.runtime.refreshLocal();
    assert.strictEqual(state.views, views);
    assert.ok(tui.observatorySessions(state).some(s => s.session === 'new-session'));
  } finally { fake.runtime.close(); }
  assert.equal(fake.subs.at(-1).closed, true); assert.equal(fake.watcher().closed, true);
});

test('Observatory store watcher: exact identity link, oak pending token and explicit clear', async () => {
  const state = fixture();
  state.observatory.machines[0].snapshot.panes.push({ ...pane('p-link', 'linked', 'working'), agent_session: null });
  state.views.sessions.sessions.push({ id: 'linked', agent: 'codex', pending: 0 });
  const identities = [];
  const fake = fakeRuntime(state, { readHerdrPaneLink: session => session === 'linked' ? { paneId: 'p-link', socketPath: '/fake.sock', at: 3 } : null,
    reportHerdrSession: async (...args) => identities.push(args) });
  try {
    await fake.runtime.start(); await fake.runtime.publishStore();
    assert.equal(identities.length, 1); assert.equal(identities[0][0], 'linked'); assert.equal(identities[0][1], 'codex');
    assert.ok(fake.calls.some(c => c.method === 'pane.report_metadata' && c.params.source === 'oak' && c.params.tokens.pending === '2' && c.params.ttl_ms === 120000));
    state.views.sessions.sessions[0].pending = 0;
    fake.watcher().onChange('store', 'event'); await fake.runtime.publishStore();
    assert.ok(fake.calls.some(c => c.method === 'pane.report_metadata' && c.params.tokens.pending === null));
    assert.ok(fake.watcher().roots[0].relevant('session/herdr.json', '/fake'));
  } finally { fake.runtime.close(); }
});

test('Observatory store watcher: a pane an older OAK gave Codex\'s memory thread goes back to the newest session linked there', async () => {
  const state = fixture();
  // herdr holds the memory thread in the pane; its link (the newest) and the root thread's both name it.
  state.observatory.machines[0].snapshot.panes.push({ ...pane('p-mem', 'memory-thread', 'idle'), agent_session: { value: 'memory-thread' } });
  state.views.sessions.sessions.push({ id: 'root-thread', agent: 'codex', pending: 0 }, { id: 'memory-thread', agent: 'codex', pending: 0 }, { id: 'claude-row', agent: 'claude', pending: 0 });
  const links = { 'root-thread': { paneId: 'p-mem', socketPath: '/fake.sock', at: 3, sessionStartSource: 'startup' }, 'memory-thread': { paneId: 'p-mem', socketPath: '/fake.sock', at: 5 },
    'claude-row': { paneId: 'p-claude', socketPath: '/fake.sock', at: 1 } };
  const identities = [], asked = [];
  const fake = fakeRuntime(state, { readHerdrPaneLink: session => links[session] ?? null, isCodexMemorySession: session => (asked.push(session), session === 'memory-thread'),
    reportHerdrSession: async (...args) => identities.push(args) });
  try {
    await fake.runtime.start(); await fake.runtime.publishStore();
    assert.deepEqual(identities.map(a => [a[0], a[1], a[2], a[5]]), [['root-thread', 'codex', links['root-thread'], true]], 'the root thread, replacing');
    // Only a Codex row can be the memory thread: a Claude row's agent.json is never read for it.
    assert.ok(asked.includes('root-thread') && !asked.includes('claude-row'), `asked about ${asked}`);
  } finally { fake.runtime.close(); }
  // Control: a pane herdr gives any other session is never taken.
  const other = fixture();
  other.observatory.machines[0].snapshot.panes.push({ ...pane('p-mem', 'someone-else', 'idle'), agent_session: { value: 'someone-else' } });
  other.views.sessions.sessions.push({ id: 'root-thread', agent: 'codex', pending: 0 });
  const none = [];
  const control = fakeRuntime(other, { readHerdrPaneLink: session => links[session] ?? null, isCodexMemorySession: () => false,
    reportHerdrSession: async (...args) => none.push(args) });
  try { await control.runtime.start(); await control.runtime.publishStore(); assert.deepEqual(none, []); }
  finally { control.runtime.close(); }
});

test('Observatory store watcher: a pane this app reported for the root thread before Codex\'s memory thread took it goes back to the root thread (2026-10-06)', async () => {
  const state = fixture();
  // The root thread's link arrived before herdr showed its hook's own report, so this app reported it.
  const root = { ...pane('p-root', 'root-thread', 'idle', 'codex'), agent_session: null };
  state.observatory.machines[0].snapshot.panes.push(root);
  state.views.sessions.sessions.push({ id: 'root-thread', agent: 'codex', pending: 0 }, { id: 'memory-thread', agent: 'codex', pending: 0 });
  const links = { 'root-thread': { paneId: 'p-root', socketPath: '/fake.sock', at: 3, sessionStartSource: 'startup' } };
  const identities = [];
  const fake = fakeRuntime(state, { readHerdrPaneLink: session => links[session] ?? null, isCodexMemorySession: session => session === 'memory-thread',
    reportHerdrSession: async (...args) => identities.push(args) });
  const reports = () => identities.map(a => [a[0], a[5]]);
  try {
    await fake.runtime.start(); await fake.runtime.publishStore();
    assert.deepEqual(reports(), [['root-thread', false]]);
    // An older OAK's hook reports Codex's memory thread in that pane: it goes back to the root thread.
    root.agent_session = { agent: 'codex', kind: 'id', value: 'memory-thread', source: 'herdr:codex' };
    await fake.runtime.publishStore();
    assert.deepEqual(reports(), [['root-thread', false], ['root-thread', true]], 'replacing, once the thread holds the pane');
    // Asked once per thread holding it, not on every pass while herdr has not caught up.
    await fake.runtime.publishStore();
    assert.equal(identities.length, 2);
  } finally { fake.runtime.close(); }
});

test('Observatory store watcher: a pane Codex\'s memory thread takes again, after it went back, goes back again (2026-10-07)', async () => {
  const state = fixture();
  const held = (value) => ({ agent: 'codex', kind: 'id', value, source: 'herdr:codex' });
  const root = { ...pane('p-root', 'root-thread', 'idle', 'codex'), agent_session: held('memory-thread') };
  state.observatory.machines[0].snapshot.panes.push(root);
  state.views.sessions.sessions.push({ id: 'root-thread', agent: 'codex', pending: 0 }, { id: 'memory-thread', agent: 'codex', pending: 0 });
  const links = { 'root-thread': { paneId: 'p-root', socketPath: '/fake.sock', at: 3, sessionStartSource: 'startup' } };
  const identities = [];
  const fake = fakeRuntime(state, { readHerdrPaneLink: session => links[session] ?? null, isCodexMemorySession: session => session === 'memory-thread',
    reportHerdrSession: async (...args) => identities.push(args) });
  const reports = () => identities.map(a => [a[0], a[5]]);
  try {
    await fake.runtime.start(); await fake.runtime.publishStore();
    assert.deepEqual(reports(), [['root-thread', true]], 'the pane goes back to the root thread');
    // herdr shows the root thread there again; at a later turn the memory thread takes the pane again.
    root.agent_session = held('root-thread');
    await fake.runtime.publishStore();
    root.agent_session = held('memory-thread');
    await fake.runtime.publishStore();
    assert.deepEqual(reports(), [['root-thread', true], ['root-thread', true]], 'and back again');
    await fake.runtime.publishStore();
    assert.equal(identities.length, 2, 'once per takeover, while herdr has not caught up');
  } finally { fake.runtime.close(); }
});

test('Observatory store watcher: each Codex session\'s agent record is read once to tell its memory thread, not on every pass (2026-10-07)', async () => {
  const state = fixture();
  state.observatory.machines[0].snapshot.panes.push({ ...pane('p-codex', 'codex-a', 'idle', 'codex'), agent_session: null });
  state.views.sessions.sessions.push({ id: 'codex-a', agent: 'codex', pending: 0 }, { id: 'codex-b', agent: 'codex', pending: 0 });
  const links = { 'codex-a': { paneId: 'p-codex', socketPath: '/fake.sock', at: 3 }, 'codex-b': { paneId: 'p-codex', socketPath: '/fake.sock', at: 2 } };
  const asked = [];
  const fake = fakeRuntime(state, { readHerdrPaneLink: session => links[session] ?? null, isCodexMemorySession: session => (asked.push(session), false),
    readCodexAgentMeta: session => (session === 'codex-a' ? { agent: 'codex', cwd: '/work' } : null), reportHerdrSession: async () => {} });
  try {
    await fake.runtime.start();
    for (let i = 0; i < 3; i++) await fake.runtime.publishStore();
    assert.equal(asked.filter(s => s === 'codex-a').length, 1, 'a session with its record is asked once');
    assert.ok(asked.filter(s => s === 'codex-b').length >= 3, 'one with no record yet is asked again, on every pass');
  } finally { fake.runtime.close(); }
});

test('Observatory capture identity sidecar: both kinds without OAK_TAB and herdr:<kind> source', async t => {
  isolated(t);
  process.env.HERDR_PANE_ID = 'pane-capture'; process.env.HERDR_SOCKET_PATH = '/capture.sock';
  t.mock.method(require('../../core/dist/herdr-context'), 'herdrPaneContextSync', () => ({ nested: true, paneId: 'pane-capture', socketPath: '/capture.sock' }));
  core.linkTab('claude-capture'); core.linkTab('codex-capture');
  for (const session of ['claude-capture', 'codex-capture']) {
    const link = core.readHerdrPaneLink(session);
    assert.equal(link.paneId, 'pane-capture'); assert.equal(link.socketPath, '/capture.sock');
    assert.equal(core.readTabLink(session), null);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(core.storeDir(session), 'herdr.json')).mode & 0o777, 0o600);
  }
  const adapter = require('../../core/dist/herdr'); const original = adapter.herdrRequest; const calls = [];
  adapter.herdrRequest = async (...args) => { calls.push(args); return { type: 'ok' }; };
  try { await core.reportHerdrSession('codex-capture', 'codex', core.readHerdrPaneLink('codex-capture')); }
  finally { adapter.herdrRequest = original; }
  assert.equal(calls[0][0], 'pane.report_agent_session'); assert.equal(calls[0][1].source, 'herdr:codex');
});

test('Observatory transcript follow: unchanged cursor keeps object, append replaces, truncate reloads', async t => {
  const { root, file, session } = transcript(t, 'claude');
  let state = pin(fixture(), session); state.observatory.details['obs-detail'].selection.root = root;
  const runtime = tui.createObservatory(core, state, { cwd: root, reader: testReader(), watch: false, timers: false, changed() {}, status() {} });
  t.after(() => runtime.close());
  await runtime.load('obs-detail');
  await flushAsync();
  const before = state.observatory.details['obs-detail'];
  assert.ok(before.transcriptPath); assert.ok(state.observatory.details['obs-detail'].previews[1]);
  await runtime.tail(); assert.strictEqual(state.observatory.details['obs-detail'], before);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'appended', sessionId: session, cwd: root, timestamp: '2026-09-18T14:02:00Z', message: { role: 'user', content: 'One more check.' } }) + '\n');
  await runtime.tail();
  const next = state.observatory.details['obs-detail'];
  assert.notStrictEqual(next, before); assert.ok(next.cursor > before.cursor);
  assert.ok(next.events.some(e => e.update.sessionUpdate === 'user_prompt' && e.update.content.text === 'One more check.'));
  fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: session, cwd: root, timestamp: '2026-09-18T14:03:00Z', message: { role: 'user', content: 'Replacement.' } }) + '\n');
  await runtime.tail();
  assert.equal(state.observatory.details['obs-detail'].events.filter(e => e.update.sessionUpdate === 'user_prompt').length, 1);
});

test('Observatory transcript follow: a replacement reset replaces the aggregate instead of appending', async t => {
  const { root, file, session } = transcript(t, 'claude');
  const state = pin(fixture(), session); state.observatory.details['obs-detail'].selection.root = root;
  // What the reader reports when the transcript a cursor came from was REWRITTEN rather than appended
  // to: `reset`, plus a fresh bounded conversation and the new byte cursor. Appending that tail put
  // the new answer under the old prompt, and the old prompt outlived the file it came from.
  const base = testReader();
  let replaced = false;
  const reader = { ...base, read: async (s, r, since) =>
    replaced && since !== undefined ? { ...await base.read(s, r), reset: true } : base.read(s, r, since) };
  const runtime = tui.createObservatory(core, state, { cwd: root, reader, watch: false, timers: false, changed() {}, status() {} });
  t.after(() => runtime.close());
  await runtime.load('obs-detail'); await flushAsync();
  const before = state.observatory.details['obs-detail'];
  const texts = kind => state.observatory.details['obs-detail'].events
    .filter(e => e.update.sessionUpdate === kind).map(e => e.update.content.text);
  assert.deepEqual(texts('user_prompt'), ['Fix the demo and make a plan.', 'Run the focused tests.']);
  // Same inode, rewritten in place, and LONGER than the saved cursor — the stat gate reads growth. The
  // padding follows the cursor, which grows with the root's length (a Windows root is longer).
  replaced = true;
  fs.writeFileSync(file, [
    { type: 'user', sessionId: session, cwd: root, timestamp: '2026-09-18T15:00:00Z', message: { role: 'user', content: 'Rewritten prompt.' } },
    { type: 'assistant', sessionId: session, cwd: root, timestamp: '2026-09-18T15:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `Rewritten answer.${' '.repeat(before.cursor)}` }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.ok(fs.statSync(file).size > before.cursor, 'the replacement must grow the file to reach the tail path');
  await runtime.tail();
  assert.notStrictEqual(state.observatory.details['obs-detail'], before);
  assert.deepEqual(texts('user_prompt'), ['Rewritten prompt.'], 'the replacement is the whole conversation');
  assert.equal(texts('agent_message_chunk').some(text => /first turn|focused tests/.test(text)), false,
    'no answer from the replaced transcript survives');
});

test('Observatory reply: real transcript tail acknowledges a prompt before the submit response', async t => {
  const { root, file, session } = transcript(t, 'claude');
  const state = pin(fixture(), session);
  state.observatory.machines[0].snapshot.panes[0].agent_status = 'idle';
  state.observatory.details['obs-detail'].selection.root = root;
  const request = deferred();
  const runtime = tui.createObservatory({ ...core, herdrAgent: { prompt: () => request.promise } }, state,
    { cwd: root, reader: testReader(), watch: false, timers: false, changed() {}, status() {} });
  t.after(() => runtime.close());
  await runtime.load('obs-detail'); runtime.focusReply('obs-detail'); runtime.editReply('obs-detail', 'Reply from the new box.');
  const sending = runtime.sendReply('obs-detail');
  assert.equal(state.observatory.details['obs-detail'].optimistic.length, 1);
  await runtime.tail(); assert.equal(state.observatory.details['obs-detail'].optimistic.length, 1);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'reply-echo', sessionId: session, cwd: root,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'Reply from the new box.' } }) + '\n');
  await runtime.tail();
  assert.equal(state.observatory.details['obs-detail'].optimistic.length, 0);
  runtime.focusReply('obs-detail', false);
  request.resolve({ type: 'agent_prompted' }); await sending;
  assert.equal(state.observatory.details['obs-detail'].reply.sending, false);
  assert.equal(state.observatory.details['obs-detail'].reply.focused, false);
  assert.equal((lines(render({ ...state, screen: 'session-detail' })).match(/Reply from the new box\./g) || []).length, 1);
});

test('Observatory visible navigation retires Agent/Feed and keeps the herdr prefix independent', () => {
  assert.ok(!tui.SCREENS.some(s => s.id === 'feed' || s.id === 'claude'));
  assert.ok(!tui.TAB_SCREEN.dashboards.includes('feed'));
  assert.ok(!tui.helpLines({}).join('\n').includes('Agent screen'));
  assert.match(tui.helpLines({}).join('\n'), /ctrl\+b M +from the herdr tab, pin its focused pane's session/);
  assert.ok(!tui.OBS_HINTS.join('\n').includes('feed'));
  const app = fs.readFileSync(path.join(__dirname, '../src/app.ts'), 'utf8');
  assert.match(app, /id: 'herdr', kind: 'native'/);
  assert.ok(!app.includes("id: 'agent',"));
  // Prefix ownership is exercised by native-keys/native-kitty below and keys-probe's herdr-prefix, including split reads.
});

async function checkLiveHerdr(t, transport = core) {
  // The prerequisite is a REACHABLE server. This is an OPT-IN (OAK_LIVE_HERDR=1): test/bootstrap.cjs
  // points every other run at a socket that does not exist, so no gate reads a person's live server.
  const binary = transport.findHerdrBin();
  if (!binary) return t.skip('LIVE HERDR NOT VERIFIED: no herdr binary installed');
  let snapshot;
  try { snapshot = await transport.herdrSnapshot({ timeoutMs: 1000 }); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOENT', 'ECONNREFUSED', 'server_not_running'].includes(error.code)) throw error;
    const why = process.env.OAK_LIVE_HERDR === '1'
      ? `LIVE HERDR NOT VERIFIED: no server answering at ${transport.herdrSocketPath()} (${error.message}); the snapshot and remote forwarding were NOT exercised.`
      : 'LIVE HERDR NOT VERIFIED: opt-in check; OAK_LIVE_HERDR=1 runs it read-only against the herdr server this machine runs.';
    console.error(why);
    return t.skip(why);
  }
  assert.equal(snapshot.protocol, 22);
  const machines = await transport.herdrMachines({ binary: transport.findHerdrBin(), timeoutMs: 3000 });
  if (!machines.some(m => m.enabled)) t.diagnostic('Remote forwarding not exercised: no enabled machines.');
  for (const machine of machines.filter(m => m.enabled)) await t.test(`remote ${machine.label}`, async sub => {
    // The hop rides ssh. A transport failure (a dropped ControlMaster, a closed connection, a timeout)
    // is the network's, not the product's: retry once, then SKIP LOUDLY. A wrong answer still fails.
    const transportFailure = /remote platform detection failed|Connection closed|Broken pipe|mux_client|timed out|ECONNRESET|ssh:|ssh bridge exited|remote SSH connection failed|exit status: 255|remote server (startup failed|is not ready)/i;
    let result;
    for (let attempt = 0; ; attempt++) {
      try { result = await transport.herdrOnMachine(machine.label, ['api', 'snapshot'], { binary, timeoutMs: tui.observatoryRemoteTimeoutMs() }); break; }
      catch (error) {
        const why = String(error?.message || error);
        if (!transportFailure.test(why)) throw error;
        if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 1500)); continue; }
        return sub.skip(`LIVE REMOTE NOT VERIFIED: ${machine.label} unreachable over ssh (${why.slice(0, 160)}); the forwarded snapshot was NOT exercised.`);
      }
    }
    assert.equal(tui.remoteSnapshot(result).protocol, 22);
  });
}

test('LIVE herdr snapshot and remote forwarding (read-only)', t => checkLiveHerdr(t));

test('Observatory Codex live follow reads raw rollout changes before the derived transcript changes', async t => {
  const { root, file, session } = transcript(t, 'codex');
  const state = pin(fixture(), session);
  state.observatory.details['obs-detail'].selection.root = root;
  const runtime = tui.createObservatory(core, state, { cwd: root, reader: testReader(), watch: false, timers: false, changed() {}, status() {} });
  t.after(() => runtime.close());
  await runtime.load('obs-detail');
  const before = state.observatory.details['obs-detail'];
  assert.equal(before.agent, 'codex');
  const stamp = fs.statSync(before.transcriptPath).mtimeMs;
  fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-09-18T15:02:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Follow the raw rollout.' } }) + '\n');
  assert.equal(fs.statSync(before.transcriptPath).mtimeMs, stamp);
  await runtime.tail();
  const after = state.observatory.details['obs-detail'];
  assert.notStrictEqual(after, before);
  assert.ok(after.events.some(e => e.update.sessionUpdate === 'user_prompt' && e.update.content.text === 'Follow the raw rollout.'));
});


test('Observatory runtime: reply keys/send/click and remote focus/tab switch alongside native navigation', () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/observatory-app-probe.cjs')], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_TEST_CONTEXT: '' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /PASS: lazy herdr PTY/);
});

test('Observatory comments: acknowledgement consumes only the submitted session draft; failures preserve it', async () => {
  const state = pin(fixture());
  state.observatory.machines[0].snapshot.panes[0].agent_status = 'idle';
  const consumed = []; let request = deferred();
  const fake = fakeRuntime(state, {
    herdrAgent: { prompt: () => request.promise },
    markCommentsSent: (session, ids) => consumed.push({ session, ids }),
  });
  try {
    fake.runtime.editReply('obs-detail', 'Review these lines');
    const session = state.observatory.details['obs-detail'].selection.session;
    state.observatory.details['obs-detail'].reply.commentIds = ['c1', 'c2'];
    const first = fake.runtime.sendReply('obs-detail');
    assert.deepEqual(consumed, [], 'drafting and an in-flight send consume nothing');
    request.reject(new Error('agent_blocked')); await first;
    assert.deepEqual(consumed, []);
    assert.deepEqual(state.observatory.details['obs-detail'].reply.commentIds, ['c1', 'c2']);
    assert.equal(state.observatory.details['obs-detail'].reply.text, 'Review these lines');
    request = deferred();
    const retry = fake.runtime.sendReply('obs-detail');
    Object.assign(state, pin(state, 'working'));
    request.resolve({ type: 'agent_prompted' }); await retry;
    assert.deepEqual(consumed, [{ session, ids: ['c1', 'c2'] }], 'a repin cannot consume the new session comments');
    assert.equal(state.observatory.details['obs-detail'].reply, undefined);
  } finally { fake.runtime.close(); }
});

test('Observatory comments: a ledger error after acknowledgement never restores a submitted prompt', async () => {
  const state = pin(fixture());
  state.observatory.machines[0].snapshot.panes[0].agent_status = 'idle';
  let calls = 0;
  const fake = fakeRuntime(state, {
    herdrAgent: { prompt: async () => { calls++; return { type: 'agent_prompted' }; } },
    markCommentsSent() { throw new Error('store is busy'); },
  });
  try {
    fake.runtime.editReply('obs-detail', 'Review these lines');
    state.observatory.details['obs-detail'].reply.commentIds = ['c1'];
    await fake.runtime.sendReply('obs-detail');
    assert.equal(state.observatory.details['obs-detail'].reply.text, '');
    assert.equal(state.observatory.details['obs-detail'].reply.error, undefined);
    assert.match(fake.statuses.at(-1), /Reply sent; could not mark review comments: store is busy/);
    await fake.runtime.sendReply('obs-detail');
    assert.equal(calls, 1, 'a ledger failure must not offer a duplicate prompt for retry');
  } finally { fake.runtime.close(); }
});

test('Observatory reply draft retains body and detail rows; body inputs still invalidate', () => {
  const { conversationRows, observatoryDetailRows } = require('../dist/observatory-rows');
  const state = pin(fixture(), 'working');
  const fake = fakeRuntime(state);
  try {
    const detail = state.observatory.details['obs-detail'];
    Object.assign(detail, { loading: false, events: [{ ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Keep the conversation cached' } } }] });
    const body = () => conversationRows(state, state.observatory.details['obs-detail'], 60, g, 'none');
    const header = () => observatoryDetailRows(state, 60, g, 'none');
    const first = body(), firstHeader = header();
    for (let i = 1; i <= 200; i++) {
      fake.runtime.editReply('obs-detail', 'x'.repeat(i));
      assert.strictEqual(body(), first, `keystroke ${i} rebuilt the conversation`);
      assert.strictEqual(header(), firstHeader, `keystroke ${i} rebuilt the detail`);
    }
    for (const change of [
      { events: [...detail.events, { ts: 2, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'New answer' } } }] },
      { previews: { 1: 'new diff' } },
      { optimistic: [{ event: detail.events[0], previousMatches: 0 }] },
      { cursor: 99 }, { loadedAt: detail.loadedAt + 1 },
    ]) {
      const before = body();
      state.observatory.details['obs-detail'] = { ...state.observatory.details['obs-detail'], ...change };
      assert.notStrictEqual(body(), before, `changed ${Object.keys(change)[0]} must invalidate`);
    }
    const beforeFold = body(); state.open = new Set(['fold']); assert.notStrictEqual(body(), beforeFold);
    const beforeError = header();
    state.observatory.details['obs-detail'].reply = { text: '', caret: 0, error: 'fixture refusal' };
    assert.notStrictEqual(header(), beforeError);
    assert.match(lines(header()), /fixture refusal/);
  } finally { fake.runtime.close(); }
});

// A call with no result yet is never drawn settled (the ✓ a finished one wears): while the pinned session waits on a
// person (its pane blocked) it is the call it waits on, `?`; otherwise it is running, the live dot (2026-11-02).
test('Observatory detail: a call with no result is `?` while its session waits on a person, running otherwise, never ✓', () => {
  const { observatoryDetailRows } = require('../dist/observatory-rows');
  const markOf = (session) => {
    const state = pin(fixture(), session);
    Object.assign(state.observatory.details['obs-detail'], { loading: false, events: [
      { ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Clean the build' } } },
      { ts: 2, update: { sessionUpdate: 'tool_call', toolCallId: 'b1', title: 'Bash', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } } }] });
    const rows = observatoryDetailRows(state, 80, g, 'none').map((r) => r.cells);
    assert.match(rows[0], session ? /> working/ : /\? blocked/, 'control: the session\'s state');
    return / (\S) +\d{4}-\d\d-\d\d \+$/.exec(rows.find((r) => r.includes('$ rm -rf build')))?.[1];
  };
  assert.equal(markOf(undefined), g.pending, 'blocked: the call it waits on');
  assert.equal(markOf('working'), g.dot.live, 'running');
  assert.notEqual(g.dot.live, g.kept);
  // One detail drawn waiting and then not, with no new event between (the session went back to work): its rows are not
  // the ones drawn while it waited, which the rows' memo would keep without the waiting in its key.
  const { conversationRows } = require('../dist/observatory-rows');
  const state = pin(fixture(), 'working');
  const detail = { ...state.observatory.details['obs-detail'], loading: false, events: [
    { ts: 2, update: { sessionUpdate: 'tool_call', toolCallId: 'b2', title: 'Bash', kind: 'execute', status: 'pending', rawInput: { command: 'make test' } } }] };
  const mark = (waiting) => / (\S) +\d{4}-\d\d-\d\d \+$/.exec(conversationRows(state, detail, 80, g, 'none', waiting).map((r) => r.cells).find((r) => r.includes('$ make test')))?.[1];
  assert.equal(mark(true), g.pending);
  assert.equal(mark(false), g.dot.live, 'drawn again once it does not wait');
});

test('Observatory: a prompt bubble wraps a family emoji whole, at every width', () => {
  // A row broke between any two code points, so an ask that wrapped at a family emoji showed part of it on each row.
  const { conversationRows } = require('../dist/observatory-rows');
  const fam = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
  const cutInside = (t) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t) || (/[\u{1F466}-\u{1F469}]/u.test(t) && !t.includes(fam));
  const state = pin(fixture(), 'working');
  const detail = state.observatory.details['obs-detail'];
  for (let k = 0; k <= 34; k++) { // every offset, so the family runs past each width's edge
    for (const cols of [22, 26, 30, 34]) {
      const events = [{ ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: `${'x'.repeat(k)}${fam}${'y'.repeat(30)}` } } }];
      const rows = conversationRows(state, { ...detail, loading: false, events }, cols, g, 'none').map((r) => r.cells);
      assert.ok(rows.every((r) => !cutInside(r)) && rows.some((r) => r.includes(fam)), `${cols} columns, the family at ${k}: ${JSON.stringify(rows)}`);
    }
  }
});

test('Observatory machine label override survives local refresh and subscription errors', async t => {
  const old = process.env.OAK_MACHINE_LABEL;
  t.after(() => { if (old === undefined) delete process.env.OAK_MACHINE_LABEL; else process.env.OAK_MACHINE_LABEL = old; });
  process.env.OAK_MACHINE_LABEL = 'workstation';
  const state = fixture(), fake = fakeRuntime(state);
  try {
    await fake.runtime.refreshLocal();
    assert.equal(state.observatory.machines.find(m => m.local).label, 'workstation');
    fake.subs[0].options.onError(new Error('fixture disconnect'));
    assert.equal(state.observatory.machines.find(m => m.local).label, 'workstation');
  } finally { fake.runtime.close(); }
});

test('herdr footer explains tmux send-prefix and preserves the ordinary hint', t => {
  const old = process.env.TMUX;
  t.after(() => { if (old === undefined) delete process.env.TMUX; else process.env.TMUX = old; });
  const state = fixture(); state.panes = state.tabs[0].panes; state.nativeGrid = ['fixture terminal'];
  process.env.TMUX = '/fixture/tmux';
  const draw = () => tui.renderDashFrame(state, { cols: 140, rows: 30, color: 'none', glyphs: g }).join('\n');
  assert.match(draw(), /ctrl\+b is herdr's prefix \(twice if tmux uses it too\)/);
  delete process.env.TMUX;
  assert.match(draw(), /herdr's tab bar below starts agents · ctrl\+b is herdr's prefix · ctrl\+b m OAK's tabs/);
  // The prefix is herdr's configured one, not a hard-coded ctrl+b.
  state.herdrPrefix = 'ctrl+g';
  assert.match(draw(), /ctrl\+g is herdr's prefix · ctrl\+g m OAK's tabs/);
  // herdr's config took m: M is the way back; took both: only a click leaves.
  state.herdrBack = 'M';
  assert.match(draw(), /ctrl\+g M OAK's tabs/);
  state.herdrBack = null;
  assert.match(draw(), /click OAK's tab bar to leave/);
  assert.doesNotMatch(draw(), /ctrl\+g m/);
});

for (const check of ['views', 'fallback', 'launch-failed', 'launch-refused', 'tick-pref', 'tick-flag', 'identity', 'hand-observatory', 'hand-wait', 'synced-hand', 'synced-hand-unsaved', 'help', 'delete', 'delete-folder',
  'sync-inbox', 'sync-options', 'sync-cursor', 'sync-stamp', 'sync-none', 'sync-saved', 'fixed-tabs', 'native-mouse', 'native-keys', 'native-kitty', 'prefix-quit', 'repeat-keys', 'usage', 'once', 'once-newest', 'once-screen', 'detail-scroll',
  'ctrl-q-herdr', 'ctrl-q-observatory', 'ctrl-q-review', 'ctrl-q-reply', 'ctrl-q-overlay', 'ctrl-q-palette', 'ctrl-q-confirm', 'ctrl-q-timeout', 'ctrl-q-prefix', 'ctrl-q-shared',
  'click-pin', 'click-split', 'done-fold', 'workspace-nav', 'worker-rows', 'worker-preview', 'worker-vanish']) test(`Observatory app regression: ${check}`, () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/observatory-app-probe.cjs')], {
    // The sync checks walk the options window a key at a time, as a reader does: seconds, more on a loaded machine.
    encoding: 'utf8', timeout: check.startsWith('sync-') ? 30000 : 10000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_APP_FIX_CHECK: check },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, new RegExp(`PASS: ${check}`));
});

// F1 to F3 raise herdr, the Observatory and Review from every tab, in every form a terminal sends them, over every overlay
// and before herdr sees them, unless herdr's config binds them; herdr's prefix then V opens Review on the focused pane's
// session, read on the machine that runs it (2026-10-23).
for (const check of ['tab-keys', 'tab-keys-overlays', 'tab-keys-herdr-config', 'tab-keys-nested', 'review-key']) test(`terminal app tab keys: ${check}`, () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/observatory-app-probe.cjs')], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_APP_FIX_CHECK: check },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, new RegExp(`PASS: ${check}`));
});

// Copying in the Observatory works the same way it does in the
// herdr tab: press, drag and release selects and copies within one pane; a press that never moves stays
// the click. Review's drag-to-copy and the seam and pane drags ride along as regression guards.
for (const check of ['drag-master', 'drag-detail', 'drag-button', 'click-release', 'drag-review', 'drag-seam-pane', 'lost-release', 'stale-press']) test(`Observatory drag-to-copy: ${check}`, () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/observatory-app-probe.cjs')], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_APP_FIX_CHECK: check },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, new RegExp(`PASS: ${check}`));
});

// Who holds a press on the herdr tab (herdr's rows as far as OAK shows them, a tab left with a button down, herdr's
// prefix pressed during its drag), and what a copy says and runs: a toast for every outcome, one process at a time on
// each path and stopped after ten seconds, and messages that name herdr's copy and the tool that failed (2026-10-13).
for (const check of ['herdr-hold', 'copy-outcomes', 'copy-lanes', 'copy-stuck', 'copy-messages', 'copy-remote', 'copy-remote-narrow', 'copy-remote-ready', 'copy-remote-toast-ends']) test(`terminal app pointer and copies: ${check}`, () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/observatory-app-probe.cjs')], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_APP_FIX_CHECK: check },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, new RegExp(`PASS: ${check}`));
});

test('the app never relaunches its own host to refresh titles: only an oak CLI entry the CLI registered is launched (2026-09-24)', t => {
  // The probe runs the app on core directly, so its argv[1] is the probe. A refresh launched through argv[1]
  // reran the whole probe, which kicked again from a fresh HOME (so the claim never held), forever.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-spawn-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const titleLaunches = (name, env = {}) => {
    const log = path.join(dir, `${name}.jsonl`);
    const result = require('child_process').spawnSync(process.execPath,
      ['--require', path.join(__dirname, 'fixtures/spawn-recorder.cjs'), path.join(__dirname, 'fixtures/observatory-app-probe.cjs')],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_APP_FIX_CHECK: '', OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: '', ...env } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return calls.filter(c => c.args.includes('titles') && c.args.includes('--refresh')).map(c => [c.file === process.execPath, c.args, c.detached]);
  };
  assert.deepEqual(titleLaunches('probe'), [], 'a process that is not the oak CLI launches no titles refresh');
  // Control: the same run with an oak CLI entry registered, as the CLI registers its own at startup, launches
  // exactly one refresh, through that entry: the refresh was due, and the recorder sees a launch that happens.
  assert.deepEqual(titleLaunches('registered', { OAK_REGISTER_CLI_ENTRY: '/fixture/oak/dist/index.js' }),
    [[true, ['/fixture/oak/dist/index.js', 'titles', '--refresh', '--if-due'], true]]);
});

test('Observatory remote prompt argv reaches the pinned herdr parser for ordinary and dash-prefixed text', async t => {
  const binary = core.findHerdrBin();
  if (!binary) return t.skip('No herdr binary available for the CLI parser check');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-herdr-parser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const text of ['hello from OAK', '--keep all words']) {
    const state = pin(fixture(), 'remote-done');
    let argv;
    const fake = fakeRuntime(state, { herdrOnMachine: async (_label, args) => { argv = args; return { result: { type: 'agent_prompted' } }; } });
    try { fake.runtime.editReply('obs-detail', text); await fake.runtime.sendReply('obs-detail'); }
    finally { fake.runtime.close(); }
    // A deliberately unsupported final flag stops argument parsing BEFORE any socket/SSH access.
    const log = path.join(dir, 'parser.log'), fd = fs.openSync(log, 'w');
    let result;
    try { result = require('child_process').spawnSync(binary, [...argv, '--oak-parser-probe'], { stdio: ['ignore', fd, fd] }); }
    finally { fs.closeSync(fd); }
    assert.equal(result.status, 2, result.error?.message);
    assert.match(fs.readFileSync(log, 'utf8'), /unknown option: --oak-parser-probe/);
  }
});


test('Live herdr verification skips only absent prerequisites and rejects product failures', async () => {
  let skips = 0;
  const context = { skip() { skips++; }, diagnostic() {}, test: async (_name, fn) => fn(context) };
  const valid = { findHerdrBin: () => '/fixture/herdr', herdrSocketPath: () => '/fixture/socket',
    herdrSnapshot: async () => snapshot([]), herdrMachines: async () => [{ label: 'fixture', enabled: true }],
    herdrOnMachine: async () => ({ result: { snapshot: snapshot([]) } }) };
  await checkLiveHerdr(context, valid); assert.equal(skips, 0);
  await checkLiveHerdr(context, { ...valid, findHerdrBin: () => null }); assert.equal(skips, 1);
  await checkLiveHerdr(context, { ...valid, herdrSnapshot: async () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); } });
  assert.equal(skips, 2);
  for (const overrides of [
    { herdrSnapshot: async () => { throw Object.assign(new Error('malformed response'), { code: 'invalid_response' }); } },
    { herdrSnapshot: async () => ({ ...snapshot([]), protocol: 999 }) },
    { herdrOnMachine: async () => ({ result: { snapshot: { ...snapshot([]), protocol: 999 } } }) },
    { herdrOnMachine: async () => { throw new Error('remote product failure'); } },
  ]) {
    await assert.rejects(checkLiveHerdr(context, { ...valid, ...overrides }));
    assert.equal(skips, 2, 'product failures must never increment the skip count');
  }
});

// The 3 s worker refresh used to spawn a whole-fleet read per pinned detail on every tick (8 MB, ~1 s
// of CPU) to use one session's subagents/todos. The transcript + subagents stamps gate it now, and a
// session that keeps moving is read at most once per refresh interval.
test('Observatory worker refresh is gated on the session stamps — nothing moved, nothing spawned', async t => {
  const { root, file, session } = transcript(t, 'claude');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-26T10:00:00Z') });
  const state = pin(fixture(), session);
  state.observatory.details['obs-detail'].selection.root = root;
  let fleetReads = 0;
  const base = testReader();
  const reader = { ...base, fleet: async (...args) => { fleetReads++; return base.fleet(...args); } };
  const runtime = tui.createObservatory(core, state, { cwd: root, reader, watch: false, timers: false, changed() {}, status() {} });
  t.after(() => runtime.close());
  await runtime.load('obs-detail');
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  await settle();
  const afterLoad = fleetReads;
  assert.ok(afterLoad >= 1, 'the first load reads the fleet');
  t.mock.timers.tick(3000);
  runtime.refreshWorkers(); await settle();
  runtime.refreshWorkers(); await settle();
  assert.equal(fleetReads, afterLoad, 'an unchanged transcript spawns no new fleet read');
  const move = text => fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: text, sessionId: session, cwd: root, timestamp: '2026-09-18T14:03:00Z', message: { role: 'user', content: text } }) + '\n');
  move('Something moved.');
  runtime.refreshWorkers(); await settle();
  assert.equal(fleetReads, afterLoad + 1, 'a changed transcript triggers exactly one fleet read');
  // Moving again at once: not before the refresh interval has passed since that read (2026-09-26).
  move('And again.');
  runtime.refreshWorkers(); await settle();
  assert.equal(fleetReads, afterLoad + 1, 'no second read inside the interval');
  t.mock.timers.tick(3000);
  runtime.refreshWorkers(); await settle();
  assert.equal(fleetReads, afterLoad + 2, 'the next refresh after it reads what moved');
});

// A pinned, working session re-ran the whole-fleet Workers read after every tail that found new records:
// 26 to 56 cold `multitask` reads a minute, most of the 0.4-1.3 cores it cost. A tail
// reads the conversation and its edit previews; the Workers wait for the refresh tick.
test('Observatory tail reads the conversation and its previews, never the Workers (2026-09-26)', async t => {
  const { root, file, session } = transcript(t, 'claude');
  const state = pin(fixture(), session);
  state.observatory.details['obs-detail'].selection.root = root;
  let fleetReads = 0, reads = 0;
  const base = testReader();
  const reader = { ...base, read: async (...args) => { reads++; return base.read(...args); },
    fleet: async (...args) => { fleetReads++; return base.fleet(...args); } };
  const runtime = tui.createObservatory(core, state, { cwd: root, reader, watch: false, timers: false, changed() {}, status() {} });
  t.after(() => runtime.close());
  await runtime.load('obs-detail'); await flushAsync();
  const [readsBefore, fleetBefore] = [reads, fleetReads];
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: `tail-${i}`, sessionId: session, cwd: root, timestamp: '2026-09-18T14:03:00Z', message: { role: 'user', content: `Tail ${i}.` } }) + '\n');
    await runtime.tail(); await flushAsync();
  }
  assert.equal(reads, readsBefore + 3, 'control: each tail read the conversation');
  assert.ok(state.observatory.details['obs-detail'].events.some(e => e.update.content?.text === 'Tail 2.'));
  assert.equal(fleetReads, fleetBefore, 'no tail read the Workers');
});

// An idle pinned Codex conversation was re-read every 750 ms forever: its transcript is derived from the
// rollout and changes only when read, so the unchanged-transcript check could not apply (80 cold reads a
// minute). The rollout's own stamp gates it now.
test('Observatory Codex follow reads only when the rollout moved (2026-09-26)', async t => {
  const { root, file, session } = transcript(t, 'codex');
  const state = pin(fixture(), session);
  state.observatory.details['obs-detail'].selection.root = root;
  let reads = 0;
  const base = testReader();
  const reader = { ...base, read: async (...args) => { reads++; return base.read(...args); } };
  const runtime = tui.createObservatory(core, state, { cwd: root, reader, watch: false, timers: false, changed() {}, status() {} });
  t.after(() => runtime.close());
  await runtime.load('obs-detail');
  assert.equal(state.observatory.details['obs-detail'].agent, 'codex');
  await runtime.tail(); // records the rollout it read from
  const settled = reads;
  for (let i = 0; i < 5; i++) await runtime.tail();
  assert.equal(reads, settled, 'an idle rollout is not read again');
  fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-09-18T15:02:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Moved on.' } }) + '\n');
  await runtime.tail();
  assert.equal(reads, settled + 1, 'a rollout that moved is read once');
  assert.ok(state.observatory.details['obs-detail'].events.some(e => e.update.sessionUpdate === 'user_prompt' && e.update.content.text === 'Moved on.'));
  for (let i = 0; i < 3; i++) await runtime.tail();
  assert.equal(reads, settled + 1, 'and then it settles again');
});

// A store write used to recompute `core.sessionMeta` synchronously in the watcher callback — ~200 ms on
// a large store, on the paint thread. It rides the reader's child now, coalesced.
test('Observatory store change refreshes the session rows through the reader, never on the paint thread', async t => {
  const state = fixture();
  let syncCalls = 0;
  let childCalls = 0;
  const { runtime, watcher } = fakeRuntime(state, { sessionMeta: () => { syncCalls++; return state.views.sessions; } },
    { reader: { ...testReader(), sessions: async () => { childCalls++; await flushAsync(); return { marker: 'from-child', calls: childCalls }; } } });
  t.after(() => runtime.close());
  watcher().onChange(); watcher().onChange(); watcher().onChange();
  for (let i = 0; i < 6; i++) await flushAsync();
  assert.equal(state.views.sessions.marker, 'from-child', 'the rows come from the child read');
  assert.equal(syncCalls, 0, 'core.sessionMeta never runs on the paint thread');
  assert.ok(childCalls >= 1 && childCalls <= 2, `three store events coalesce into at most two child reads (got ${childCalls})`);
});

// While the app's own poll keeps this machine's catalog current, a store write needs no second listing:
// one per write doubled the listing a working session paid for.
test('Observatory store change lists the sessions again only while the app is not keeping the catalog fresh', async t => {
  const state = fixture();
  let fresh = true, listings = 0;
  const { runtime, watcher } = fakeRuntime(state, {},
    { reader: { ...testReader(), sessions: async () => { listings++; return state.views.sessions; } }, catalogFresh: () => fresh });
  t.after(() => runtime.close());
  watcher().onChange();
  for (let i = 0; i < 6; i++) await flushAsync();
  assert.equal(listings, 0, 'the app\'s poll keeps the catalog: the write is not listed again');
  fresh = false;
  watcher().onChange();
  for (let i = 0; i < 6; i++) await flushAsync();
  assert.equal(listings, 1, 'control: with no poll keeping it, the write lists the sessions again');
});

test('remote source: metadata joins only the owning catalog and local joins remain byte-identical', () => {
  const state = fixture(), localBefore = JSON.stringify(tui.observatorySessions(state).filter(s => s.machineId === 'local'));
  const remote = state.observatory.machines[1];
  const fresh = { id: 'remote-done', title: 'Fresh remote title', model: 'Remote model', tokens: 4321, pending: 7, lastActiveMs: 12345 };
  remote.sessions = { sessions: [fresh] };
  const row = tui.observatorySessions(state).find(s => s.session === fresh.id);
  assert.deepEqual(row.meta, fresh); assert.equal(row.label, fresh.title);
  assert.deepEqual(row.fleet, {}, 'never join local workers to a remote session');
  remote.sessions = undefined;
  const unknown = tui.observatorySessions(state).find(s => s.session === fresh.id);
  assert.deepEqual(unknown.meta, {}, 'an unavailable owner never falls back to the same-id local row');
  assert.equal(JSON.stringify(tui.observatorySessions(state).filter(s => s.machineId === 'local')), localBefore);
  state.observatory.owners = { 'remote-done': 'build-box' }; remote.snapshot = undefined;
  assert.ok(!tui.observatorySessions({ ...state, allSessions: true }).some(s => s.session === 'remote-done'), 'a missing snapshot cannot relabel the mirror as local history');
});

test('remote source: first window, incremental cursor, reset, diff ownership, throttle and mirror failure', async t => {
  isolated(t);
  let now = 100000; const realNow = Date.now; Date.now = () => now; t.after(() => { Date.now = realNow; });
  const state = pin(fixture(), 'remote-done'); state.screen = 'session-detail';
  const calls = [], metaCalls = [], diffs = [], fleets = [];
  let result = { events: [turn([{ id: 7, file: 'remote.ts' }])], cursor: 9000, transcriptPath: '/absent-on-this-host/source.jsonl', agent: 'claude' };
  let fail = false, metadataFail = false;
  const fresh = { id: 'remote-done', title: 'Fresh remote title', model: 'Remote model', tokens: 4321, pending: 7, lastActiveMs: now };
  const reader = {
    read: async (...args) => { calls.push(args); if (fail) throw new Error('ssh refused'); return result; },
    sessions: async (...args) => { metaCalls.push(args); if (metadataFail) throw new Error('metadata refused'); return { sessions: [fresh] }; },
    diff: async (...args) => { diffs.push(args); return '+remote patch'; },
    fleet: async (...args) => { fleets.push(args); return { todos: [], subagents: [] }; },
    mirror: async () => ({ mirrored: true, syncedAt: Date.parse('2026-09-18T01:23:00Z') }), close() {},
  };
  const fake = fakeRuntime(state, {}, { reader, watch: false }); t.after(() => fake.runtime.close());
  await fake.runtime.load('obs-detail'); await flushAsync();
  const detail = () => state.observatory.details['obs-detail'];
  assert.deepEqual(calls[0], ['remote-done', '/workspace', undefined, 'build-box']);
  assert.equal(detail().error, undefined, 'remote path must never be statted on this host');
  assert.deepEqual(diffs[0], ['remote-done', 7, 'build-box']); assert.equal(fleets[0][2], 'build-box');
  assert.equal(detail().previews[7], '+remote patch');
  assert.match(lines(render(state)), /Fresh remote title.*build-box/);
  assert.equal(tui.observatorySessions(state).find(s => s.session === fresh.id).meta.tokens, 4321);
  for (let i = 0; i < 5; i++) { await fake.runtime.tail(); fake.runtime.refreshWorkers(); }
  await flushAsync(); assert.equal(calls.length, 1); assert.equal(metaCalls.length, 1); assert.equal(fleets.length, 1);
  now += 10000; result = { ...result, events: [turn()], cursor: 9500 };
  await fake.runtime.tail(); assert.equal(calls.at(-1)[2], 9000); assert.equal(detail().events.length, 2);
  now += 10000; result = { ...result, reset: true, events: [turn()], cursor: 12 };
  await fake.runtime.tail(); assert.equal(detail().events.length, 1); assert.equal(detail().cursor, 12);
  assert.deepEqual(detail().previews, {}, 'a replacement discards old edit previews');
  now += 10000; fail = metadataFail = true;
  await fake.runtime.tail(); await flushAsync();
  assert.match(detail().error, /build-box.*ssh refused/); assert.match(detail().error, /last synced copy from 01:23/);
  assert.match(detail().error, /metadata refused/);
  assert.match(lines(render(state)), /last synced\s+copy from/);
  assert.deepEqual(tui.observatorySessions(state).find(s => s.session === fresh.id).meta, {});
  const attempts = calls.length; await fake.runtime.tail(); assert.equal(calls.length, attempts);
  now += 10000; fail = metadataFail = false; result = { ...result, reset: false, events: [] };
  await fake.runtime.tail(); await flushAsync();
  assert.equal(detail().error, undefined, 'even an unchanged successful tail clears the stale-data warning');
  assert.equal(calls.at(-1)[2], 12, 'only the owning file supplies cursors');
});

// A saved machine's previews come in one read, and are drawn when it answers: they waited for the Workers read
// beside them, the slower one over ssh. An OAK there from before that read answers undefined, and each is asked alone.
test('remote source: previews come in one read and draw before the Workers read ends; an older OAK is asked per edit (2026-11-05)', async t => {
  isolated(t);
  for (const older of [false, true]) {
    const state = pin(fixture(), 'remote-done'); state.screen = 'session-detail';
    const batches = [], singles = [], workers = deferred();
    const reader = {
      read: async () => ({ events: [turn([{ id: 7, file: 'a.ts' }, { id: 8, file: 'b.ts' }, { id: 9, file: 'c.ts' }])], cursor: 1, transcriptPath: '/absent-on-this-host/source.jsonl', agent: 'claude' }),
      sessions: async () => ({ sessions: [] }),
      diffs: async (...args) => { batches.push(args); return older ? undefined : { patches: { 7: '+seven', 8: '+eight' }, errors: { 9: 'no edit #9 in session remote-done' } }; },
      diff: async (...args) => { singles.push(args); return `+single ${args[1]}`; },
      fleet: () => workers.promise,
      mirror: async () => ({ mirrored: false }), close() {},
    };
    const fake = fakeRuntime(state, {}, { reader, watch: false }); t.after(() => fake.runtime.close());
    await fake.runtime.load('obs-detail'); await flushAsync(); await flushAsync();
    const detail = () => state.observatory.details['obs-detail'];
    assert.deepEqual(batches, [['remote-done', [7, 8, 9], 'build-box']]);
    assert.deepEqual(singles.map(args => args[1]), older ? [7, 8, 9] : []);
    assert.deepEqual(detail().previews, older ? { 7: '+single 7', 8: '+single 8', 9: '+single 9' }
      : { 7: '+seven', 8: '+eight', 9: '(edit content unavailable on build-box: no edit #9 in session remote-done)' }, 'drawn while the Workers read is out');
    workers.resolve({ todos: [], subagents: [{ agentId: 'w1' }] }); await flushAsync();
    assert.equal(detail().fleet.subagents[0].agentId, 'w1', 'and the Workers read lands beside them');
    assert.equal(Object.keys(detail().previews).length, 3);
  }
});

test('remote source: owner changes discard an old answer and a local pane wins without a remote cursor', async t => {
  const { root, file, session } = transcript(t, 'claude');
  const state = pin(fixture(), session), first = deferred(), calls = [];
  state.observatory.machines[0].snapshot = snapshot([]);
  state.observatory.machines[1].snapshot = snapshot([pane('p1', session, 'working')]);
  state.observatory.details['obs-detail'].selection = { session, root, machineId: 'build' };
  const reader = { ...testReader(), read: (...args) => {
    calls.push(args); return args[3] ? first.promise : Promise.resolve(core.conversationEvents(session, { root }));
  } };
  const fake = fakeRuntime(state, {}, { reader, watch: false }); t.after(() => fake.runtime.close());
  const pending = fake.runtime.load('obs-detail');
  state.observatory.machines[0].snapshot = snapshot([pane('local', session, 'working')]);
  await fake.runtime.tail();
  assert.equal(calls.length, 2); assert.equal(calls[1][3], undefined); assert.equal(calls[1][2], undefined);
  const local = JSON.stringify(state.observatory.details['obs-detail'].events);
  assert.equal(local, JSON.stringify(core.conversationEvents(session, { root }).events));
  first.resolve({ events: [turn()], cursor: 999, transcriptPath: '/remote/file' }); await pending;
  assert.equal(JSON.stringify(state.observatory.details['obs-detail'].events), local);
  assert.equal(state.observatory.details['obs-detail'].transcriptPath, file);
});

test('remote source: metadata refresh coalesces per machine and waits twice a slow read duration', async t => {
  isolated(t); let now = 100000; const realNow = Date.now; Date.now = () => now; t.after(() => { Date.now = realNow; });
  const state = pin(pin(fixture(), 'remote-done'), 'unknown', 'other', 'build'), held = deferred(); let count = 0;
  const fake = fakeRuntime(state, {}, { watch: false, reader: { ...testReader(),
    read: async () => ({ events: [], cursor: 1, transcriptPath: '/remote/file' }),
    sessions: () => { count++; return count === 1 ? held.promise : Promise.resolve({ sessions: [] }); },
    fleet: async () => ({}) } });
  t.after(() => fake.runtime.close());
  await Promise.all([fake.runtime.load('obs-detail'), fake.runtime.load('other')]);
  assert.equal(count, 1);
  now += 16000; await fake.runtime.tail(); assert.equal(count, 1, 'the in-flight read remains coalesced');
  held.resolve({ sessions: [] }); await flushAsync();
  now = 131999; await fake.runtime.tail(); assert.equal(count, 1);
  now = 132000; await fake.runtime.tail(); await flushAsync(); assert.equal(count, 2);
});

test('remote source: replacement drops delayed previews and a failed tail coalesces through mirror diagnosis', async t => {
  isolated(t); let now = 100000; const realNow = Date.now; Date.now = () => now; t.after(() => { Date.now = realNow; });
  const state = pin(fixture(), 'remote-done'), patch = deferred(), mirror = deferred();
  let fail = false, reads = 0;
  const fake = fakeRuntime(state, {}, { watch: false, reader: {
    read: async () => {
      reads++;
      if (fail) throw new Error('offline');
      return { events: reads === 1 ? [turn([{ id: 9, file: 'old.ts' }])] : [turn()], cursor: reads === 1 ? 90 : 100, transcriptPath: '/remote/file', reset: reads > 1 };
    }, diff: () => patch.promise, fleet: async () => ({}), mirror: () => mirror.promise, close() {},
  } }); t.after(() => fake.runtime.close());
  await fake.runtime.load('obs-detail');
  now += 10000; await fake.runtime.tail();
  patch.resolve('+obsolete edit'); await flushAsync();
  assert.deepEqual(state.observatory.details['obs-detail'].previews, {}, 'old enrichment cannot reappear after a replacement');
  now += 10000; fail = true;
  const pending = fake.runtime.tail(); await flushAsync();
  const before = reads;
  now += 20000; await fake.runtime.tail(); assert.equal(reads, before, 'provenance diagnosis retains the in-flight latch');
  mirror.resolve({ mirrored: false }); await pending;
  assert.match(state.observatory.details['obs-detail'].error, /offline/);
});

test('remote tab titles: numbered tabs rename from the owning catalog as it arrives; local titles stay local', async t => {
  isolated(t);
  const state = fixture();
  for (const machine of state.observatory.machines) machine.snapshot.tabs = [
    { tab_id: 'monitor', workspace_id: 'workspace', number: 1, label: 'btop' },
    { tab_id: 'tab', workspace_id: 'workspace', number: 2, label: '2' },
  ];
  state.observatory.machines[1].sessions = undefined;
  state.views.sessions.sessions.find(s => s.id === 'remote-done').title = 'Stale mirrored title';
  const held = deferred();
  // The pass runs through the runtime's own (fake) transport, which records every verb in `calls`.
  const fake = fakeRuntime(state, { ensureHerdrTabs: core.ensureHerdrTabs }, { watch: false,
    reader: { ...testReader(), sessions: () => held.promise } });
  const calls = fake.calls;
  t.after(() => fake.runtime.close());
  await fake.runtime.refreshLocal(); await flushAsync();
  assert.ok(calls.some(c => c.method === 'tab.rename' && c.params.tab_id === 'tab' && c.params.label === 'Fix the demo'));
  const remote = fake.runtime.refreshRemotes(); await flushAsync();
  assert.ok(!calls.some(c => c.label && c.argv[0] === 'tab' && c.argv[1] === 'rename'), 'a missing catalog must never use the local mirror');
  held.resolve({ sessions: [{ id: 'remote-done', title: 'Fresh owning-machine title' }] });
  await remote; await flushAsync();
  assert.ok(calls.some(c => c.label === 'build-box' && c.argv.join('|') === 'tab|rename|tab|Fresh owning-machine title'), 'metadata arrival renames without waiting for the next snapshot');
  assert.ok(!JSON.stringify(calls).includes('Stale mirrored title'));
});

test('remote tab titles: metadata completion queues behind a running tidy pass', async t => {
  isolated(t);
  const state = fixture(), held = deferred(), metadata = deferred(), passes = []; let active = 0, maximum = 0;
  state.observatory.machines[1].sessions = undefined;
  const fake = fakeRuntime(state, { ensureHerdrTabs: async opts => {
    if (!opts.machine) return [];
    active++; maximum = Math.max(maximum, active);
    passes.push({ title: opts.titleOf('remote-done') });
    if (passes.length === 1) await held.promise;
    active--; return [];
  } }, { watch: false, reader: { ...testReader(), sessions: () => metadata.promise } });
  t.after(() => fake.runtime.close());
  const refresh = fake.runtime.refreshRemotes(); await flushAsync();
  metadata.resolve({ sessions: [{ id: 'remote-done', title: 'Arrived title' }] }); await refresh;
  assert.equal(passes.length, 1); assert.equal(passes[0].title, undefined);
  held.resolve(); await flushAsync();
  assert.equal(maximum, 1); assert.equal(passes.length, 2);
  assert.equal(passes[1].title, 'Arrived title');
});

test('Observatory detail: buttons a narrow pane breaks across rows keep their own offsets, so a click fires the button under it (2026-10-07)', () => {
  const { observatoryDetailRows } = require('../dist/observatory-rows');
  const state = pin(fixture(), 'working');
  const jumps = (cols) => observatoryDetailRows(state, cols, g, 'none').filter((r) => r.key.startsWith('detail:jumps'));
  assert.equal(jumps(80).length, 1, 'one row where they fit');
  for (const cols of [36, 30, 20, 12]) {
    const rows = jumps(cols);
    assert.ok(rows.length > 1, `${cols} columns break them`);
    // Every button is drawn where its row says, whole, and each once.
    assert.deepEqual(rows.flatMap((r) => r.buttons.map((b) => [b.action, r.cells.slice(b.x, b.x + b.w)])),
      [['herdr', '↗ herdr'], ['review', '⌕ review'], ['resolve', '⚑ resolve'], ['kill', '■ stop']], `at ${cols} columns`);
    for (const r of rows) assert.ok(tui.displayWidth(r.cells) <= cols, `${JSON.stringify(r.cells)} fits in ${cols}`);
  }
});

test('placeholder titles: "New Claude session" names nothing — a pane title, the change map title and the short id outrank it (2026-09-24)', () => {
  const { observatoryDetailRows } = require('../dist/observatory-rows');
  const state = fixture();
  state.views.sessions.sessions.find(s => s.id === 'working').title = 'New Claude session';
  state.views.sessions.sessions.find(s => s.id === 'unresolved').title = 'New Claude session';
  state.observatory.machines[1].sessions.sessions.find(s => s.id === 'remote-done').title = 'New Codex session';
  state.observatory.machines[0].snapshot.panes[1] = { ...pane('p2', 'working', 'working'), title: 'Deploy fix' };
  state.observatory.machines[1].snapshot.panes[0] = { ...pane('p1', 'remote-done', 'done', 'codex'), title: 'Remote pane title' };
  const label = id => tui.observatorySessions(state).find(s => s.session === id)?.label;
  assert.equal(label('claude-conversation'), 'Fix the demo', 'control: a real title still leads');
  assert.equal(label('working'), 'Deploy fix', "the pane's own title outranks a placeholder");
  assert.equal(label('remote-done'), 'Remote pane title', '…on a saved machine too');
  assert.equal(label('unresolved'), 'unresolved', 'a paneless session falls back to its short id');
  // The pinned conversation's header uses the same name.
  const header = lines(observatoryDetailRows(pin(state, 'working'), 80, g, 'none'));
  assert.match(header, /Deploy fix/);
  assert.doesNotMatch(header, /New Claude session/);
  // The statusline title: the change map's title outranks it, as the shell statusline never shows one.
  Object.assign(state, { session: 'working', sessionTitle: 'Deploy the fix' });
  assert.equal(tui.statuslineDataFor(state).title, 'Deploy the fix');
});

test('placeholder titles never rename a herdr tab, here or on a saved machine (2026-09-24)', async t => {
  isolated(t);
  const state = fixture();
  for (const machine of state.observatory.machines) machine.snapshot.tabs = [
    { tab_id: 'monitor', workspace_id: 'workspace', number: 1, label: 'btop' },
    { tab_id: 'tab', workspace_id: 'workspace', number: 2, label: '2' },
  ];
  const local = state.views.sessions.sessions.find(s => s.id === 'claude-conversation');
  local.title = 'New Claude session';
  state.observatory.machines[1].sessions = undefined; // build-box's only catalog is the placeholder one read below
  const fake = fakeRuntime(state, { ensureHerdrTabs: core.ensureHerdrTabs }, { watch: false,
    reader: { ...testReader(), sessions: async () => ({ sessions: [{ id: 'remote-done', title: 'New Codex session' }] }) } });
  const calls = fake.calls;
  t.after(() => fake.runtime.close());
  await fake.runtime.refreshLocal(); await fake.runtime.refreshRemotes(); await flushAsync(); await flushAsync();
  const renames = () => calls.filter(c => c.method === 'tab.rename' || (c.label && c.argv[0] === 'tab' && c.argv[1] === 'rename'));
  assert.deepEqual(renames(), [], 'a placeholder names no tab, local or remote');
  // Control: the same pass renames the tab once the session has a real name.
  local.title = 'Fix the demo';
  await fake.runtime.refreshLocal(); await flushAsync(); await flushAsync();
  assert.ok(calls.some(c => c.method === 'tab.rename' && c.params.tab_id === 'tab' && c.params.label === 'Fix the demo'), 'control: a real title renames it');
});

// A saved machine's hooks keep their claims in its own store; this app kept its claims for the same tabs
// here, and after it renamed a tab there the machine's own sync took the label for a person's and stopped
// following the title. The machine now names its own sessions' tabs, asked by the app.
test('remote tab titles: a saved machine names its own sessions\' tabs, asked once per tab, label and title; one whose OAK predates that is named from here', async t => {
  isolated(t);
  // The polls wait 10–15 s between reads of a machine: the clock is moved past that between rounds.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const state = fixture();
  for (const machine of state.observatory.machines) machine.snapshot.tabs = [
    { tab_id: 'monitor', workspace_id: 'workspace', number: 1, label: 'btop' },
    { tab_id: 'tab', workspace_id: 'workspace', number: 2, label: '2' },
  ];
  state.observatory.machines[1].sessions = undefined; // build-box's titles are the ones its own list gives below
  let title = 'Owning-machine title', answer = true;
  const asked = [];
  const fake = fakeRuntime(state, { ensureHerdrTabs: core.ensureHerdrTabs }, { watch: false, reader: { ...testReader(),
    sessions: async () => ({ sessions: [{ id: 'remote-done', title }] }),
    syncTab: async (session, machine, claimed) => {
      asked.push(claimed === undefined ? [session, machine] : [session, machine, claimed]);
      if (answer === 'unreachable') throw new Error('oak: build-box is not reachable over ssh (fixture.invalid): timed out');
      return answer;
    } } });
  const calls = fake.calls;
  t.after(() => fake.runtime.close());
  const renamedThere = () => calls.filter(c => c.label === 'build-box' && c.argv[0] === 'tab' && c.argv[1] === 'rename').map(c => c.argv[3]);
  const round = async () => { t.mock.timers.tick(20_000); await fake.runtime.refreshRemotes(); for (let i = 0; i < 8; i++) await flushAsync(); };
  await round();
  assert.deepEqual(asked, [['remote-done', 'build-box']], 'the machine is asked to name its session\'s tab');
  assert.deepEqual(renamedThere(), [], 'no tab there is renamed from here');
  const record = path.join(core.rootDir(), 'herdr-tabs.json');
  assert.ok(!fs.existsSync(record) || !('build-box' in JSON.parse(fs.readFileSync(record, 'utf8'))), 'and no record of names there is kept here');
  // The same tab, label and title: not asked again, however often the machine is read.
  await round(); await round();
  assert.equal(asked.length, 1);
  // A new title there is asked about again.
  title = 'Retitled on the owning machine';
  await round();
  assert.deepEqual(asked, [['remote-done', 'build-box'], ['remote-done', 'build-box']]);
  // An ask that could not reach the machine is made again on the next pass, and only until one lands.
  answer = 'unreachable';
  title = 'Retitled while unreachable';
  await round();
  assert.equal(asked.length, 3);
  answer = true;
  await round(); await round();
  assert.equal(asked.length, 4);
  // An OAK there from before `__tab-sync` answers that it cannot: from then on its tabs are named from here, as before.
  answer = false;
  title = 'Named from here';
  await round();
  assert.equal(asked.length, 5);
  await round();
  assert.deepEqual([...new Set(renamedThere())], ['Named from here']);
  assert.equal(asked.length, 5, 'and it is not asked meanwhile');
});

// A machine that holds no pane link for a session cannot name its tab and answers `unlinked`: the app names
// that one tab from here, by its own record as before, and asks again only ten minutes on.
test('remote tab titles: the tab of a session a saved machine holds no pane link for is named from here, and asked about again ten minutes on', async t => {
  isolated(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const state = fixture();
  for (const machine of state.observatory.machines) machine.snapshot.tabs = [
    { tab_id: 'monitor', workspace_id: 'workspace', number: 1, label: 'btop' },
    { tab_id: 'tab', workspace_id: 'workspace', number: 2, label: '2' },
  ];
  state.observatory.machines[1].sessions = undefined;
  let title = 'Owning-machine title';
  const asked = [];
  const fake = fakeRuntime(state, { ensureHerdrTabs: core.ensureHerdrTabs }, { watch: false, reader: { ...testReader(),
    sessions: async () => ({ sessions: [{ id: 'remote-done', title }] }),
    syncTab: async (session, machine) => { asked.push([session, machine]); return 'unlinked'; } } });
  const calls = fake.calls;
  t.after(() => fake.runtime.close());
  const renamedThere = () => [...new Set(calls.filter(c => c.label === 'build-box' && c.argv[0] === 'tab' && c.argv[1] === 'rename').map(c => c.argv[3]))];
  const round = async () => { t.mock.timers.tick(20_000); await fake.runtime.refreshRemotes(); for (let i = 0; i < 30; i++) await flushAsync(); };
  await round();
  assert.deepEqual(asked, [['remote-done', 'build-box']], 'the machine is asked');
  assert.deepEqual(renamedThere(), ['Owning-machine title'], 'and the app names the tab itself');
  assert.deepEqual(core.herdrTabClaims('build-box'), { tab: 'Owning-machine title' }, 'in its own record');
  // A new title is followed from here, and the machine is not asked meanwhile.
  title = 'Retitled there';
  await round();
  assert.deepEqual(renamedThere(), ['Owning-machine title', 'Retitled there']);
  assert.equal(asked.length, 1);
  // Ten minutes on, it is asked again: the session's hooks may have linked its pane since.
  t.mock.timers.tick(10 * 60_000);
  title = 'Retitled later';
  await round();
  assert.equal(asked.length, 2);
  assert.deepEqual(renamedThere(), ['Owning-machine title', 'Retitled there', 'Retitled later']);
});

/** The two-store case: this app (its own store) and a saved machine "build-box" (another store: its
 *  own OAK, its sessions' hooks) over one scripted herdr server. `syncThere` runs `oak __tab-sync` in the
 *  machine's store: what the app's `--machine` runs there over ssh, and what the session's own hooks start;
 *  it answers as the app's reader does. `link: false`: the session's hooks never ran in its pane there. */
async function twoStores(t, { link = true } = {}) {
  const { base } = isolated(t);
  const { fakeHerdr } = require('../../core/test/fake-herdr');
  const cp = require('node:child_process');
  let server;
  const herdr = await fakeHerdr(t, { 'tab.rename': ({ tab_id, label }) => { server.tabs.find(x => x.tab_id === tab_id).label = label; return { type: 'ok' }; } });
  if (!herdr) return null;
  const S = 'fixture-remote-tab';
  server = { workspaces: [{ workspace_id: 'w1', label: 'home' }], tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1' }],
    panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'x1' }], agents: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: S } }] };
  herdr.snapshot = server;
  // The machine's own store: the session's transcript, titled, and the pane link its capture hook made.
  const there = { ...process.env, CLAUDE_CONFIG_DIR: path.join(base, 'remote-claude'), CODEX_HOME: path.join(base, 'remote-codex') };
  for (const k of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH']) delete there[k];
  const work = path.join(base, 'remote-work');
  const transcript = path.join(there.CLAUDE_CONFIG_DIR, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${S}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const rec = o => JSON.stringify(o) + '\n';
  fs.writeFileSync(transcript, rec({ type: 'user', cwd: work, sessionId: S, message: { role: 'user', content: 'Tidy the fixture parser please' } })
    + rec({ type: 'ai-title', aiTitle: 'Parser tidy-up', sessionId: S }));
  const OAK = path.resolve(__dirname, '../../cli/dist/index.js');
  if (link) {
    const linked = cp.spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(path.resolve(__dirname, '../../core/dist'))}); const f = require('fs'), p = require('path'); f.mkdirSync(c.storeDir(${JSON.stringify(S)}), { recursive: true }); f.writeFileSync(p.join(c.storeDir(${JSON.stringify(S)}), 'herdr.json'), JSON.stringify({ paneId: process.env.HERDR_PANE_ID, socketPath: process.env.HERDR_SOCKET_PATH, at: Date.now() }))`],
      { env: { ...there, HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: herdr.socketPath }, encoding: 'utf8' });
    assert.equal(linked.status, 0, linked.stderr);
  }
  const syncThere = claimed => new Promise((resolve, reject) => cp.execFile(process.execPath, [OAK, '__tab-sync', S, ...(claimed ? [`--claimed=${claimed}`] : [])],
    { env: there, encoding: 'utf8', timeout: 20000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim() === 'unlinked' ? 'unlinked' : stdout === ''))));
  const titles = { current: 'Parser tidy-up' };
  const retitle = title => { fs.appendFileSync(transcript, rec({ type: 'custom-title', customTitle: title, sessionId: S })); titles.current = title; };
  const onServer = (method, params) => core.herdrRequest(method, params, { socketPath: herdr.socketPath, timeoutMs: 4000 });
  /** The terminal app, in this test's store, with build-box saved. */
  const app = () => {
    const state = { session: 'none', views: { sessions: { sessions: [] } }, observatory: { machines: [{ id: 'local', label: 'laptop', local: true }], details: {} } };
    const fake = { ...core, findHerdrBin: () => '/herdr', herdrSocketPath: () => '/fake.sock', resolveMonitor: () => null,
      herdrSnapshot: async () => snapshot([]), herdrSubscribe: () => ({ close() {} }), herdrRequest: async () => ({ type: 'ok' }),
      herdrMachines: async () => [{ id: 'build', label: 'build-box', enabled: true }],
      // The machine's herdr, reached from here: its snapshot, and a rename sent from here, land on the same server.
      herdrOnMachine: async (label, argv) => argv[0] === 'api' ? { result: await onServer('session.snapshot', {}) }
        : argv[0] === 'tab' && argv[1] === 'rename' ? { result: await onServer('tab.rename', { tab_id: argv[2], label: argv[3] }) } : null,
      readHerdrPaneLink: () => null, observatoryRoots: () => [], sessionMeta: () => state.views.sessions };
    const runtime = tui.createObservatory(fake, state, { cwd: base, changed() {}, status() {}, timers: false, watch: false, reader: { ...testReader(fake),
      sessions: async (_session, _root, machine) => ({ sessions: machine ? [{ id: S, title: titles.current, agent: 'claude' }] : [] }),
      syncTab: async (_session, _machine, claimed) => syncThere(claimed) } });
    t.after(() => runtime.close());
    return runtime;
  };
  const until = async check => { for (const end = Date.now() + 15000; !check() && Date.now() < end;) await new Promise(r => setTimeout(r, 50)); return check(); };
  const recordOf = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'claude-observatory', 'herdr-tabs.json'), 'utf8')); } catch { return {}; } };
  return { server, there, syncThere, retitle, app, until, recordOf, here: process.env.CLAUDE_CONFIG_DIR };
}

// Asked by the app, the machine names the tab itself, so when the title changes there later, its own sync
// follows it with the app closed.
test('remote tab titles: a tab the app had a saved machine name keeps following its session there once the app is closed', async t => {
  const f = await twoStores(t);
  if (!f) return;
  const runtime = f.app();
  await runtime.refreshRemotes();
  assert.ok(await f.until(() => f.server.tabs[0].label === 'Parser tidy-up'), `the tab took the session's title (${f.server.tabs[0].label})`);
  // The machine's sync renames the tab before it records the claim: wait for the record, not the label.
  assert.ok(await f.until(() => f.recordOf(f.there.CLAUDE_CONFIG_DIR).local?.['w1:t1'] === 'Parser tidy-up'), 'the machine recorded its claim');
  assert.deepEqual(f.recordOf(f.here), {}, 'this app keeps no record of names on that server');
  assert.deepEqual(f.recordOf(f.there.CLAUDE_CONFIG_DIR), { local: { 'w1:t1': 'Parser tidy-up' } }, 'the machine keeps the one record');
  runtime.close();
  // The app is closed. The title changes there (a /rename), and the session's own hooks sync its tab.
  f.retitle('Release blockers');
  assert.equal(await f.syncThere(), true);
  assert.equal(f.server.tabs[0].label, 'Release blockers', 'the tab follows its session');
});

// An app from before this change named the machine's tab from here and recorded that in ITS store; the
// machine's own claim, if any, is an older name. The updated app vouches for the name it recorded, so the
// machine takes the claim on rather than taking the name for a person's.
test('remote tab titles: a tab an older app named on a saved machine is handed over to that machine, and follows its session there', async t => {
  const f = await twoStores(t);
  if (!f) return;
  assert.equal(await f.syncThere(), true); // the machine's own sync named the tab once: its claim is 'Parser tidy-up'
  f.server.tabs[0].label = 'Named by an older app';
  fs.mkdirSync(path.join(f.here, 'claude-observatory'), { recursive: true });
  fs.writeFileSync(path.join(f.here, 'claude-observatory', 'herdr-tabs.json'), JSON.stringify({ 'build-box': { 'w1:t1': 'Named by an older app' } }));
  f.retitle('Release blockers');
  // Control: the machine alone takes that name for a person's.
  assert.equal(await f.syncThere(), true);
  assert.equal(f.server.tabs[0].label, 'Named by an older app');
  const runtime = f.app();
  await runtime.refreshRemotes();
  assert.ok(await f.until(() => f.server.tabs[0].label === 'Release blockers'), `the machine took the tab on (${f.server.tabs[0].label})`);
  assert.ok(await f.until(() => f.recordOf(f.there.CLAUDE_CONFIG_DIR).local?.['w1:t1'] === 'Release blockers'), 'the machine recorded the claim it took on');
  assert.deepEqual(f.recordOf(f.there.CLAUDE_CONFIG_DIR), { local: { 'w1:t1': 'Release blockers' } });
  runtime.close();
  f.retitle('Ship the parser');
  assert.equal(await f.syncThere(), true);
  assert.equal(f.server.tabs[0].label, 'Ship the parser', 'and follows its session with the app closed');
});

// A session whose hooks never ran in its pane on the machine (not installed there, or the session began
// before they were) has no pane link there, so the machine cannot name its tab: it says so, and the app
// names that tab itself, as it did before machines named their own.
test('remote tab titles: the tab of a session a saved machine holds no pane link for is named by the app', async t => {
  const f = await twoStores(t, { link: false });
  if (!f) return;
  assert.equal(await f.syncThere(), 'unlinked', 'the machine cannot name it, and says so');
  const runtime = f.app();
  await runtime.refreshRemotes();
  assert.ok(await f.until(() => f.server.tabs[0].label === 'Parser tidy-up'), `the tab took the session's title (${f.server.tabs[0].label})`);
  assert.ok(await f.until(() => f.recordOf(f.here)['build-box']?.['w1:t1'] === 'Parser tidy-up'), 'this app records the name it gave there');
  assert.deepEqual(f.recordOf(f.there.CLAUDE_CONFIG_DIR), {}, 'and the machine keeps none');
});

// The app open, its session list a moment behind: the session's own sync renamed the tab to its new
// title, and the app's next pass (a herdr event at the same turn boundary) put the old title back until
// its list caught up.
test('herdr tab titles: the app\'s pass leaves alone a tab its session\'s own sync renamed after the app read its list', async t => {
  isolated(t);
  const { fakeHerdr } = require('../../core/test/fake-herdr');
  let server;
  const herdr = await fakeHerdr(t, { 'tab.rename': ({ tab_id, label }) => { server.tabs.find(x => x.tab_id === tab_id).label = label; return { type: 'ok' }; } });
  if (!herdr) return;
  const S = 'fixture-flap-session';
  server = { workspaces: [{ workspace_id: 'w1', label: 'home' }], tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1' }],
    panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'x1', agent: 'claude', agent_status: 'working' }],
    agents: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: S } }] };
  herdr.snapshot = server;
  const options = { socketPath: herdr.socketPath, timeoutMs: 4000 };
  let listTitle = 'Old title';
  const passes = [];
  const state = { session: S, views: { sessions: { sessions: [] } }, observatory: { machines: [{ id: 'local', label: 'laptop', local: true }], details: {} } };
  const fake = { ...core, findHerdrBin: () => '/herdr', herdrSocketPath: () => herdr.socketPath, resolveMonitor: () => null,
    herdrSnapshot: async () => ({ version: '0.9.1', protocol: 22, layouts: [], ...JSON.parse(JSON.stringify(server)) }),
    herdrRequest: (method, params, o) => core.herdrRequest(method, params, { ...o, ...options }),
    herdrSubscribe: () => ({ close() {} }), herdrMachines: async () => [], readHerdrPaneLink: () => null, observatoryRoots: () => [],
    ensureHerdrTabs: async opts => { const done = await core.ensureHerdrTabs(opts); passes.push(opts.listedAt); return done; } };
  const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', changed() {}, status() {}, timers: false, watch: false, reader: { ...testReader(fake),
    sessions: async () => ({ sessions: [{ id: S, title: listTitle, agent: 'claude' }] }) } });
  t.after(() => runtime.close());
  const until = async check => { for (const end = Date.now() + 10000; !check() && Date.now() < end;) await new Promise(r => setTimeout(r, 20)); return check(); };
  const pass = async () => { const n = passes.length; await runtime.refreshLocal(); assert.ok(await until(() => passes.length > n), 'the pass ran'); };
  const labels = () => herdr.calls('tab.rename').map(c => c.label);
  // The app reads its list, then names the tab by it.
  await runtime.refreshSessions();
  await pass();
  assert.deepEqual(labels(), ['Old title']);
  assert.equal(typeof passes.at(-1), 'number', 'the pass knows when its list was read');
  // The title changes; the session's own sync (its Stop hook, on this machine) renames the tab.
  await new Promise(r => setTimeout(r, 20));
  const saved = { HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
  Object.assign(process.env, { HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: herdr.socketPath });
  try { fs.mkdirSync(core.storeDir(S), { recursive: true }); fs.writeFileSync(path.join(core.storeDir(S), 'herdr.json'), JSON.stringify({ paneId: 'w1:p1', socketPath: herdr.socketPath, at: Date.now() })); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  await core.syncSessionTab({ session: S, title: 'New title', transport: core, herdrOptions: { timeoutMs: 4000 } });
  assert.deepEqual(labels(), ['Old title', 'New title']);
  // A herdr event: the app's pass, from the list it read before that sync, leaves the tab alone.
  await pass();
  assert.deepEqual(labels(), ['Old title', 'New title'], 'the old title is never put back');
  // Its list read again, the app agrees, and follows the next title as ever.
  listTitle = 'New title';
  await runtime.refreshSessions();
  await pass();
  listTitle = 'Newest title';
  await runtime.refreshSessions();
  await pass();
  assert.deepEqual(labels(), ['Old title', 'New title', 'Newest title']);
});

test('app: the session list the app reads itself tells the tab pass when it was read', () => {
  // `runTui` needs a TTY to construct, so the wiring is pinned at the source: the list the app's own poll
  // keeps current is the one the tab pass on this machine names tabs by.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
  assert.ok(/if \(!machine && raw && raw\.sessions !== undefined\) \{\s*localCatalog = raw\.sessions;\s*observatory\?\.sessionsRead\(raw\.sessions, startedAt\);/.test(src),
    'app.ts hands the runtime the start of each read of this machine\'s session list');
});

// A probe run from a herdr pane made btop tabs on the LIVE herdr server it ran under: the tidy
// pass sent its verbs through herdr-tabs' own import of the transport, bypassing the fake core the probe
// injected, straight to HERDR_SOCKET_PATH. Here the environment's socket AND its herdr binary are
// sentinels that record whatever reaches them, and the runtime gets its own scripted herdr. Every write —
// a tab rename here and on a saved machine, the monitor's launch line, a review token, an identity
// report — must arrive through the injected transport, and nothing at the sentinels.
test('Observatory runtime: every herdr call goes through the injected transport, never the environment\'s socket or binary (2026-09-26)', async t => {
  isolated(t);
  const { fakeHerdr, processInfo, scripted } = require('../../core/test/fake-herdr');
  const ok = () => ({ type: 'ok' });
  const verbs = { 'tab.rename': ok, 'tab.create': ok, 'tab.move': ok, 'pane.rename': ok, 'pane.send_text': ok, 'pane.report_metadata': ok, 'pane.report_agent_session': ok };
  const sentinel = await fakeHerdr(t, { ...verbs, 'pane.process_info': scripted({}) });
  const injected = await fakeHerdr(t, { ...verbs, 'pane.process_info': scripted({ p9: [processInfo.idle('p9')] }) });
  if (!sentinel || !injected) return;
  process.env.HERDR_SOCKET_PATH = sentinel.socketPath;
  const state = fixture();
  const local = state.observatory.machines[0].snapshot, remote = state.observatory.machines[1].snapshot;
  // Here: a numbered tab whose session has a title, the btop tab's idle monitor shell, a pane herdr
  // knows no session for while its capture link names one, and pending edits. There: a numbered tab.
  local.tabs = [{ tab_id: 'monitor', workspace_id: 'w1', number: 1, label: 'btop' }, { tab_id: 'tab', workspace_id: 'w1', number: 2, label: '2' }];
  local.panes.push({ ...pane('p9', 'none', 'idle'), tab_id: 'monitor', label: 'btop', terminal_id: `sentinel-${process.pid}-${Date.now()}`, agent: null, agent_session: null });
  local.panes.push({ ...pane('p-link', 'linked', 'working'), agent_session: null });
  state.views.sessions.sessions.push({ id: 'linked', agent: 'codex', pending: 0 });
  remote.tabs = [{ tab_id: 'tab', workspace_id: 'w1', number: 1, label: '1' }];
  const fake = { ...core, resolveMonitor: () => '/usr/bin/htop',
    // The environment's herdr binary: the runtime hands it to the transport, which must not use it.
    findHerdrBin: () => sentinel.binary,
    herdrSnapshot: async () => local, herdrSubscribe: () => ({ close() {} }),
    herdrMachines: async () => [{ id: 'build', label: 'build-box', enabled: true }],
    herdrRequest: (method, params, o) => core.herdrRequest(method, params, { ...o, socketPath: injected.socketPath }),
    herdrOnMachine: async (label, argv, o) => argv[0] === 'api' ? { result: { type: 'session_snapshot', snapshot: remote } }
      : core.herdrOnMachine(label, argv, { ...o, binary: injected.binary }),
    readHerdrPaneLink: session => session === 'linked' ? { paneId: 'p-link', at: 3 } : null,
    observatoryRoots: () => [], sessionMeta: () => state.views.sessions };
  const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', reader: testReader(fake), changed() {}, status() {}, timers: false, watch: false });
  t.after(() => runtime.close());
  await runtime.start();
  const heard = () => injected.requests.map(r => `${r.params.machine ?? 'local'} ${r.method}`);
  const expected = ['local tab.rename', 'local pane.send_text', 'local pane.report_metadata', 'local pane.report_agent_session', 'build-box tab.rename'];
  for (let i = 0; i < 150 && !expected.every(e => heard().includes(e)); i++) await new Promise(resolve => setTimeout(resolve, 20));
  // Nothing reached the environment's socket or binary…
  assert.deepEqual(sentinel.requests.map(r => `${r.params.machine ?? 'local'} ${r.method}`), [], 'the environment\'s herdr heard nothing');
  // …while the writes happened (the control), through the injected transport.
  for (const e of expected) assert.ok(heard().includes(e), `${e} went through the injected transport (heard: ${heard().join(', ')})`);
});

// `oak tui --once` prints one frame. It used to tidy herdr on the way: a btop tab made and moved, panes
// renamed, a launch line typed into a pane — here and on every saved machine. This
// machine's server records every request, and the herdr binary on PATH logs every argv it gets.
test('oak tui --once only reads herdr: no tab tidy, token or identity write, here or on a saved machine (2026-09-26)', async t => {
  const { base, root } = isolated(t);
  const { fakeHerdr } = require('../../core/test/fake-herdr');
  const ok = () => ({ type: 'ok' });
  const tabs = [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: '1' }];
  const localSnap = { ...snapshot([{ ...pane('p1', 'claude-conversation', 'working'), tab_id: 't1' }], { w1: 'home' }), tabs };
  const remoteSnap = { ...snapshot([{ ...pane('p1', 'remote-done', 'working', 'codex'), tab_id: 't1' }], { w1: 'home' }), tabs };
  const server = await fakeHerdr(t, { 'session.snapshot': () => ({ type: 'session_snapshot', snapshot: localSnap }),
    'tab.create': () => ({ type: 'tab_created', tab: { tab_id: 't9' }, root_pane: { pane_id: 'p9', terminal_id: 'term-9' } }),
    'tab.rename': ok, 'tab.move': ok, 'pane.rename': ok, 'pane.send_text': ok, 'pane.report_metadata': ok, 'pane.report_agent_session': ok,
    'pane.process_info': () => ({ type: 'pane_process_info', process_info: { pane_id: 'p9', shell_pid: 1, foreground_process_group_id: 1, foreground_processes: [{ pid: 1, name: 'zsh' }] } }) });
  if (!server) return;
  const bin = path.join(base, 'bin'), argvLog = path.join(base, 'herdr-argv.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
const argv = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'machine' && argv[1] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify([{ id: 'm1', label: 'far', target: 'nobody@far.invalid', session: 'default', enabled: true, selected: false }]))});
else if (argv[0] === '--machine' && argv[2] === 'api') process.stdout.write(${JSON.stringify(JSON.stringify({ result: { type: 'session_snapshot', snapshot: remoteSnap } }))});
else process.stdout.write('{"result":{"type":"ok"}}');
`, { mode: 0o755 });
  // A monitor to manage, and an ssh that never leaves this machine.
  fs.writeFileSync(path.join(bin, 'htop'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "ssh: far.invalid: test double" >&2\nexit 255\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HERDR_SOCKET_PATH: server.socketPath,
    XDG_CONFIG_HOME: path.join(base, 'config'), CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', OAK_NO_SERVER: '1' };
  const cli = path.join(__dirname, '..', '..', 'cli', 'dist', 'index.js');
  const run = await new Promise(resolve => require('child_process').execFile(process.execPath,
    [cli, 'tui', '--once', '--no-mouse', '--tab', 'observatory', '--cols', '100', '--rows', '24', '--no-color'],
    { cwd: root, env, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.split('\n').filter(Boolean).length, 24, 'one frame, printed');
  await new Promise(resolve => setTimeout(resolve, 100)); // anything still in flight when the frame printed
  const argvs = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  // Control: it did read both machines…
  assert.ok(server.requests.some(r => r.method === 'session.snapshot'), 'this machine\'s snapshot was read');
  assert.ok(argvs.some(a => a.join(' ') === '--machine far api snapshot'), `the saved machine's snapshot was read (argv: ${JSON.stringify(argvs)})`);
  // …and wrote to neither.
  assert.deepEqual(server.requests.map(r => r.method).filter(m => !['session.snapshot', 'pane.process_info'].includes(m)), [], 'only snapshot and process reads on this machine\'s socket');
  const writes = argvs.filter(a => a[0] === '--machine' && a[2] !== 'api');
  assert.deepEqual(writes, [], 'nothing but the snapshot on the saved machine');
});

// A saved machine's pinned session cost one ssh call per edit preview (289 for one window of a 2,600-edit
// session) and a whole-fleet `multitask` for its Workers and Tasks (5.2 MB on the Mac), then the `subagents`
// fallback (94 MB) when the fleet did not list it. The frame now reads each of them once, and only that session.
test('oak tui --once: a saved machine\'s pinned session reads its previews in one call and only its own workers (2026-11-05)', { skip: process.platform === 'win32' && 'POSIX fake ssh' }, async t => {
  const { base } = isolated(t);
  const repo = path.join(__dirname, '..', '..', '..'), cli = path.join(repo, 'packages', 'cli', 'dist', 'index.js');
  const bin = path.join(base, 'bin'), remote = path.join(base, 'remote-home'), runs = path.join(base, 'remote-runs.log');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(remote, '.local', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'test', 'fixtures', 'machine-exec-stub.sh'), path.join(bin, 'ssh')); fs.chmodSync(path.join(bin, 'ssh'), 0o755);
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv.join(' ') === 'machine list --json') process.stdout.write(${JSON.stringify(JSON.stringify([{ id: 'm1', label: 'build-box', target: 'builder@build-box.example', session: 'default', enabled: true, selected: false }]))});
else if (argv[0] === '--machine') process.stdout.write('{"result":{"snapshot":{"version":"0.9.1","protocol":22,"panes":[],"agents":[],"workspaces":[],"tabs":[]}}}');
`, { mode: 0o755 });
  // The remote's oak: this build, and one line per run of what it was asked and how many bytes it answered.
  fs.writeFileSync(path.join(remote, '.local', 'bin', 'oak'), `#!${process.execPath}
const r = require('child_process').spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'inherit'] });
process.stdout.write(r.stdout);
require('fs').appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ bytes: r.stdout.length, argv: process.argv.slice(2) }) + '\\n');
process.exitCode = r.status ?? 1;
`, { mode: 0o755 });
  const session = 'saved-pinned', remoteEnv = { HOME: remote, PATH: '/usr/bin:/bin' };
  const seeded = require('child_process').spawnSync(process.execPath, [path.join(repo, 'test', 'fixtures', 'saved-session.cjs'), repo, session, '12', '40'], { env: remoteEnv, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_REMOTE_HOME: remote, MACHINE_EXEC_LOG: path.join(base, 'machine-exec.log'),
    XDG_CONFIG_HOME: path.join(base, 'config'), CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', OAK_NO_SERVER: '1', OAK_NO_BACKGROUND: '1' };
  const run = await new Promise(resolve => require('child_process').execFile(process.execPath,
    [cli, 'tui', '--once', '--no-mouse', '--tab', 'observatory', '--session', session, '--cols', '120', '--rows', '40', '--no-color'],
    { cwd: base, env, timeout: 120_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  assert.equal(run.code, 0, run.stderr);
  const asked = fs.readFileSync(runs, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => !r.argv[0].startsWith('__'));
  const verbs = asked.map(r => r.argv[0]);
  assert.ok(asked.some(r => r.argv[0] === 'sessions' && r.argv.includes('--workers')), 'the visible Observatory tree still receives its machine Workers');
  // Control: the frame has the session's workers and tasks, and a preview (its text is only in the machine's store).
  assert.match(run.stdout, /Workers · 0\/12 active/, run.stdout);
  assert.match(run.stdout, /Tasks · 1\/2 open/);
  assert.match(run.stdout, /\+new 63 0/);
  assert.equal(verbs.filter(v => v === 'diff').length, 1, `one read for every preview (asked: ${verbs.join(' ')})`);
  assert.ok(asked.some(r => r.argv[0] === 'diff' && r.argv[1] === '--ids' && r.argv[2].split(',').length > 10), 'the previews are batched');
  assert.ok(!verbs.includes('subagents'), 'no subagents fallback');
  const workers = asked.filter(r => r.argv[0] === 'multitask');
  assert.equal(workers.length, 1);
  assert.ok(workers[0].argv.includes('--only-session'), workers[0].argv.join(' '));
  assert.ok(asked.length <= 5, `at most five remote reads (asked: ${verbs.join(' ')})`);
  // 5.6 KB here; the whole fleet's was 18.8 KB.
  assert.ok(workers[0].bytes < 10_000, `the workers read is ${workers[0].bytes} bytes`);
});

// Every tail replaced the events array, so the whole conversation was drawn again on the paint thread
// after each append: 0.5 s a frame at 3,000 events, 1.6 s near 10,000. An append
// draws what it touched; every other row is the one already drawn — and the whole is exactly what a
// fresh render of the same events draws.
test('Observatory conversation: an append redraws only what it touched, and draws what a fresh render draws (2026-09-26)', () => {
  const { conversationRows } = require('../dist/observatory-rows');
  const state = pin(fixture());
  const tool = id => ({ ts: 2, update: { sessionUpdate: 'tool_call', toolCallId: id, title: `Read /workspace/${id}.ts`, kind: 'read', status: 'pending', rawInput: { file_path: `/workspace/${id}.ts` } } });
  const done = id => ({ ts: 3, update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `contents of ${id}` } }] } });
  const say = text => ({ ts: 4, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
  const events = [{ ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Read the files.' } } }];
  for (let i = 0; i < 40; i++) events.push(tool(`f${i}`), done(`f${i}`), say(`Read f${i}. `));
  const detail = { ...state.observatory.details['obs-detail'], loading: false, events, cursor: 10, loadedAt: state.now, previews: {} };
  const draw = d => conversationRows(state, d, 80, g, 'truecolor');
  const fresh = d => draw({ ...d, events: structuredClone(d.events) });
  const first = draw(detail);
  // A tail: the same event objects in a new array; the last text run grows and a tool call opens.
  const appended = { ...detail, events: [...events, say('And more.'), tool('g0')], cursor: 20 };
  const next = draw(appended);
  assert.deepEqual(next.map(r => [r.cells, r.openPath ?? '']), fresh(appended).map(r => [r.cells, r.openPath ?? '']), 'what a fresh render draws');
  const kept = new Set(first);
  const reused = next.filter(r => kept.has(r)).length;
  assert.ok(reused >= first.length - 2, `every row but the grown text run is the one already drawn (${reused} of ${first.length})`);
  // A completion arriving later redraws its call: its status mark changes.
  const completed = { ...appended, events: [...appended.events, done('g0')], cursor: 30 };
  assert.deepEqual(draw(completed).map(r => r.cells), fresh(completed).map(r => r.cells));
  assert.notDeepEqual(draw(completed).map(r => r.cells), next.map(r => r.cells));
  // A preview arriving redraws the calls that show it, and only those.
  const previewed = { ...completed, previews: { 5: '@@ -1 +1 @@\n-old\n+new' } };
  assert.deepEqual(draw(previewed).map(r => r.cells), fresh(previewed).map(r => r.cells));
});

// A spread of the conversation's rows into one push overflowed the call stack past about 125,000 rows,
// and the paint's uncaught RangeError took the whole terminal app down (2026-09-26).
test('Observatory conversation: a pinned conversation longer than a call\'s argument limit still renders (2026-09-26)', () => {
  const state = pin(fixture());
  const out = 'word '.repeat(2000);
  const events = Array.from({ length: 1100 }, (_, n) => ({ ts: 1, update: { sessionUpdate: 'tool_call', toolCallId: `t${n}`, title: 'Bash', kind: 'execute',
    status: 'completed', rawInput: { command: `seq ${n}` }, content: [{ type: 'content', content: { type: 'text', text: out } }] } }));
  state.observatory.details['obs-detail'] = { ...state.observatory.details['obs-detail'], loading: false, events, cursor: 1, loadedAt: state.now, previews: {} };
  const rows = tui.rowsFor({ ...state, screen: 'session-detail' }, 80, g, 'none');
  assert.ok(rows.length > 140000, `${rows.length} rows`);
});

// The master was built twice a frame — once to ask whether its pane was empty (it never is), at the full
// width — and again for every animation frame, every 150 ms while any pane worked: tens of ms a frame with
// Show archived and its folds open. It is built once for what it shows; a frame
// only moves the live sessions' spinners.
test('Observatory master: built once for what it shows; an animation frame moves only the spinners (2026-09-26)', () => {
  const rowsMod = require('../dist/observatory-rows'), original = rowsMod.observatoryMasterRows;
  let calls = 0;
  rowsMod.observatoryMasterRows = (...args) => { calls++; return original(...args); };
  try {
    const state = fixture();
    state.tabs[1].root = tui.OBSERVATORY_TREE; state.activeTab = 1;
    tui.renderTreeBody(state, tui.OBSERVATORY_TREE, 120, 30, 'obs-sessions', g, 'truecolor');
    assert.equal(calls, 1, 'one master per frame');
  } finally { rowsMod.observatoryMasterRows = original; }
  const state = { ...fixture(), allSessions: true, open: new Set(['earlier', 'archived']) };
  const at = now => tui.rowsFor({ ...state, now }, 82, g, 'truecolor');
  const a = at(state.now), b = at(state.now + 120);
  const live = rows => rows.filter(r => /^session:local:p[12]:[^:]+:state$/.test(r.key));
  assert.equal(live(a).length, 2, 'the blocked and the working session');
  assert.notDeepEqual(live(a).map(r => r.cells), live(b).map(r => r.cells), 'their spinners move');
  const built = new Set(a);
  assert.deepEqual(b.filter(r => !built.has(r)).map(r => r.key), live(b).map(r => r.key), 'every other row is the one already built');
  assert.deepEqual(b.map(r => r.cells), render({ ...state, now: state.now + 120 }, 82, 'truecolor').map(r => r.cells), 'what a fresh build draws');
  // A change to what it shows rebuilds it.
  const quiet = { ...state, observatory: { ...state.observatory, machines: state.observatory.machines.map(m => m.local
    ? { ...m, snapshot: { ...m.snapshot, panes: m.snapshot.panes.map(p => ({ ...p, agent_status: 'idle' })) } } : m) } };
  const rebuilt = tui.rowsFor(quiet, 82, g, 'truecolor');
  assert.deepEqual(live(rebuilt).map(r => tui.stripSgr(r.cells).trim().split(' · ')[0].split(' ')[1]), ['idle', 'idle'], 'a quiet pane is drawn quiet');
  assert.deepEqual(rebuilt.map(r => r.cells), render(quiet, 82, 'truecolor').map(r => r.cells));
});

// A review token went out again every 15 s whether or not it changed — for a saved machine, an ssh round
// trip per pending pane each time (11.8 calls a minute for three panes). It goes out
// when it changes, and again only before herdr's hold on it lapses.
test('Observatory review tokens: sent on change, and refreshed only before they lapse (2026-09-26)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-26T10:00:00Z') });
  const state = fixture();
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined }, { watch: false });
  t.after(() => fake.runtime.close());
  const sent = () => fake.calls.filter(c => c.method === 'pane.report_metadata' || (c.label && c.argv[1] === 'report-metadata'));
  await fake.runtime.start(); await fake.runtime.publishStore();
  const first = sent().length;
  assert.equal(first, 2, 'one token per pending pane, here and on the saved machine');
  t.mock.timers.tick(30000); await fake.runtime.publishStore();
  assert.equal(sent().length, first, 'an unchanged token is not sent again 30 s later');
  t.mock.timers.tick(31000); await fake.runtime.publishStore();
  assert.equal(sent().length, first + 2, 'it is sent again before its two-minute hold lapses');
  assert.ok(sent().every(c => c.params ? c.params.ttl_ms === 120000 : c.argv.includes('120000')));
  state.views = { ...state.views, sessions: { sessions: state.views.sessions.sessions.map(r => r.id === 'claude-conversation' ? { ...r, pending: 5 } : r) } };
  await fake.runtime.publishStore();
  assert.equal(sent().length, first + 3, 'a change goes out at once');
});

for (const local of [true, false]) test(`Observatory closed pane: pending edits on ${local ? 'this machine' : 'a saved machine'} forget the pane until herdr lists it again`, { skip: !local && process.platform === 'win32' }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:00Z') });
  const state = fixture(), m = state.observatory.machines[local ? 0 : 1];
  const listed = m.snapshot, session = local ? 'claude-conversation' : 'remote-done';
  let gone = true;
  const attempts = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-closed-pane-'));
  t.after(() => (() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* a child's late write: never skip the stop hooks after this one */ } })());
  const binary = path.join(dir, 'herdr');
  fs.writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write(JSON.stringify({error:{code:'pane_not_found',message:'pane p1 not found'},id:'cli:request'})); process.exitCode = 1;\n`, { mode: 0o755 });
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrRequest: async (method, params) => {
      if (local && method === 'pane.report_metadata' && params.pane_id === 'p1') {
        attempts.push(params);
        if (gone) throw new core.HerdrError('pane_not_found', 'pane p1 not found');
      }
      return { type: 'ok' };
    },
    herdrOnMachine: async (label, argv, options) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: listed } };
      if (!local && argv[2] === 'p1') {
        attempts.push(argv);
        if (gone) return core.herdrOnMachine(label, argv, { ...options, binary });
      }
      return null;
    } }, { watch: false });
  t.after(() => fake.runtime.close());
  await fake.runtime.publishStore();
  assert.equal(attempts.length, 1);
  assert.deepEqual(fake.statuses, [], 'closing a pane says nothing on the status row');
  const row = () => tui.observatorySessions(state).find(s => s.session === session);
  assert.equal(row().paneId, undefined, 'the pending session stays, without its stale pane');
  assert.ok(row().meta.pending > 0);
  assert.ok(!state.observatory.machines.find(x => x.id === m.id).snapshot.agents.some(a => a.pane_id === 'p1'));
  assert.ok(state.observatory.machines[local ? 1 : 0].snapshot.panes.some(p => p.pane_id === 'p1'), 'pane ids are scoped to their machine');
  for (const elapsed of [0, 15000, 30000, 120000, 600000]) {
    t.mock.timers.tick(elapsed);
    await fake.runtime.publishStore();
  }
  assert.equal(attempts.length, 1, 'no backoff loop or token refresh targets the closed pane');
  gone = false;
  if (local) await fake.runtime.refreshLocal(); else await fake.runtime.refreshRemotes();
  await fake.runtime.publishStore();
  assert.equal(attempts.length, 2, 'a fresh listing permits reporting to the pane again');
  assert.equal(row().paneId, 'p1');
  assert.deepEqual(fake.statuses, []);
});

test('Observatory closed pane: identity reports forget the stale capture link until a fresh listing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:00Z') });
  const state = fixture();
  state.observatory.machines[0].snapshot.panes.push({ ...pane('p-link', 'linked', 'working'), agent_session: null });
  state.views.sessions.sessions.push({ id: 'linked', agent: 'codex', pending: 2 });
  let attempts = 0, gone = true;
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    readHerdrPaneLink: session => session === 'linked' ? { paneId: 'p-link', socketPath: '/fake.sock', at: 3 } : null,
    reportHerdrSession: async () => { attempts++; if (gone) throw new core.HerdrError('pane_not_found', 'pane p-link not found'); } }, { watch: false });
  t.after(() => fake.runtime.close());
  await fake.runtime.publishStore();
  assert.deepEqual(fake.statuses, []);
  for (const elapsed of [15000, 30000, 120000]) { t.mock.timers.tick(elapsed); await fake.runtime.publishStore(); }
  assert.equal(attempts, 1, 'the durable capture link does not resurrect the pane');
  gone = false;
  await fake.runtime.refreshLocal(); await fake.runtime.publishStore();
  assert.equal(attempts, 2);
});

test('Observatory closed pane: screen reads forget a pane until herdr lists it again', async t => {
  const fx = await quietCodex(t);
  if (!fx) return;
  fx.screen.fail = new core.HerdrError('pane_not_found', 'pane p4 not found');
  await fx.refresh();
  assert.ok(!fx.state.observatory.machines[0].snapshot.panes.some(p => p.pane_id === 'p4'));
  await fx.runtime.readScreens(); await fx.runtime.readScreens();
  assert.equal(fx.reads().length, 1, 'no further screen reads without a listing');
  assert.deepEqual(fx.statuses, []);
  fx.screen.fail = false;
  await fx.refresh();
  assert.equal(fx.reads().length, 2);
  assert.match(askingLine(fx.state), / working /);
});

// herdr 0.9.1's `pane report-metadata` exits 0 and prints nothing. The forwarded token was refused as
// "herdr command did not return JSON", so the status line showed an error and the token went out
// again, one ssh call each, on every pass.
test('Observatory review tokens: a saved machine\'s silent report-metadata counts as sent', { skip: process.platform === 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-silent-herdr-'));
  t.after(() => (() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* a child's late write: never skip the stop hooks after this one */ } })());
  const binary = path.join(dir, 'herdr');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const state = fixture(), forwarded = [];
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrOnMachine: async (label, argv, o) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: state.observatory.machines[1].snapshot } };
      forwarded.push(argv);
      return core.herdrOnMachine(label, argv, { ...o, binary });
    } }, { watch: false });
  t.after(() => fake.runtime.close());
  await fake.runtime.start(); await fake.runtime.publishStore();
  assert.equal(forwarded.filter(a => a[1] === 'report-metadata').length, 1);
  assert.deepEqual(fake.statuses.filter(s => s.includes('review tokens')), []);
  await fake.runtime.publishStore();
  assert.equal(forwarded.filter(a => a[1] === 'report-metadata').length, 1, 'a recorded token is not sent again on the next pass');
});

// A saved machine that stopped answering failed its review-token report on every pass, and each failure wrote
// herdr's error over the status row, where it stood after the machine was back (2026-10-13). The Observatory
// marks that machine itself; the report says nothing, and it and every other report to that machine wait,
// longer each time, rather than spending a connection timeout per pane on every pass.
test('Observatory review tokens: a saved machine that cannot be reached is not said on the status row, and its reports wait (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = fixture();
  // Two pending panes on the saved machine, so a pass that tried each would try twice.
  state.observatory.machines[1].sessions.sessions[1].pending = 1;
  let down = true;
  const tries = [];
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrOnMachine: async (label, argv) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: state.observatory.machines[1].snapshot } };
      tries.push(argv[2]);
      if (down) throw new core.HerdrError('command_failed', "machine 'build-box' (session default): remote SSH connection failed: ssh: connect to host fixture.invalid port 22: Operation timed out");
      return null;
    } }, { watch: false });
  t.after(() => fake.runtime.close());
  const local = () => fake.calls.filter(c => c.method === 'pane.report_metadata').length;
  await fake.runtime.start(); await fake.runtime.publishStore();
  assert.equal(tries.length, 1, 'the first failure holds the machine\'s other report too');
  assert.equal(local(), 1, 'this machine\'s token goes out as before');
  await fake.runtime.publishStore(); await fake.runtime.publishStore();
  assert.equal(tries.length, 1, 'a pass inside the wait does not try again');
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(tries.length, 2, 'tried again after the first wait');
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(tries.length, 2, 'the second wait is longer');
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(tries.length, 3);
  assert.deepEqual(fake.statuses, [], 'nothing on the status row: the Observatory marks the machine');
  down = false;
  t.mock.timers.tick(60000); await fake.runtime.publishStore();
  assert.deepEqual(tries.slice(3).sort(), ['p1', 'p2'], 'back, both panes\' tokens go out');
  await fake.runtime.publishStore();
  assert.equal(tries.length, 5, 'and are not sent again on the next pass');
  // The next outage starts over from the first wait.
  down = true;
  state.observatory.machines[1].sessions.sessions[0].pending = 4;
  await fake.runtime.publishStore();
  assert.equal(tries.length, 6);
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(tries.length, 7, 'tried again after the first wait, not the last');
  assert.deepEqual(fake.statuses, []);
});

const unreachableBuildBox = () => new core.HerdrError('command_failed', "machine 'build-box' (session default): remote SSH connection failed: ssh: connect to host fixture.invalid port 22: Operation timed out");

// Each failure doubles the wait up to two minutes, where it stays: a machine down all afternoon is tried every two minutes.
test('Observatory review tokens: a saved machine that stays down is tried after 15, 30 and 60 seconds, then every two minutes (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = fixture();
  const tries = [];
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrOnMachine: async (label, argv) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: state.observatory.machines[1].snapshot } };
      tries.push(Date.now());
      throw unreachableBuildBox();
    } }, { watch: false });
  t.after(() => fake.runtime.close());
  await fake.runtime.start(); await fake.runtime.publishStore();
  for (let s = 0; s < 600; s++) { t.mock.timers.tick(1000); await fake.runtime.publishStore(); }
  assert.deepEqual(tries.slice(1).map((at, i) => (at - tries[i]) / 1000), [15, 30, 60, 120, 120, 120, 120]);
});

// A machine that leaves herdr's list (removed, or disabled) and comes back started from the longest wait it had reached.
test('Observatory review tokens: a saved machine that leaves herdr\'s list and comes back starts again from the first wait (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = fixture();
  const remote = state.observatory.machines[1];
  let listed = true;
  const tries = [];
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrMachines: async () => listed ? [{ id: 'build', label: 'build-box', enabled: true }] : [],
    herdrOnMachine: async (label, argv) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: remote.snapshot } };
      tries.push(Date.now());
      throw unreachableBuildBox();
    } }, { watch: false, reader: { ...testReader(), sessions: async (_session, _root, label) => label ? remote.sessions : state.views.sessions } });
  t.after(() => fake.runtime.close());
  await fake.runtime.start(); await fake.runtime.publishStore();
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  t.mock.timers.tick(30000); await fake.runtime.publishStore();
  assert.equal(tries.length, 3, 'the wait is a minute now');
  listed = false; await fake.runtime.refreshRemotes();
  assert.ok(!state.observatory.machines.some(m => m.id === 'build'), 'the machine left');
  t.mock.timers.tick(1000);
  listed = true; await fake.runtime.refreshRemotes(); await fake.runtime.publishStore();
  assert.equal(tries.length, 4, 'back, its count goes out at once');
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(tries.length, 5, 'and after its failure waits 15 seconds, not a minute or two');
});

// Any other failure of a report is said once, not on every pass, and the report waits before it is tried again.
test('Observatory review tokens and identity: another failure is said once, and the report waits (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = fixture();
  state.observatory.machines[0].snapshot.panes.push({ ...pane('p-link', 'linked', 'working'), agent_session: null });
  state.views.sessions.sessions.push({ id: 'linked', agent: 'codex', pending: 0 });
  const tries = [], identities = [];
  let refused = true;
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    readHerdrPaneLink: session => session === 'linked' ? { paneId: 'p-link', socketPath: '/fake.sock', at: 3 } : null,
    reportHerdrSession: async () => { identities.push(1); throw new core.HerdrError('metadata_rejected', 'pane p-link metadata rejected'); },
    herdrOnMachine: async (label, argv) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: state.observatory.machines[1].snapshot } };
      tries.push(argv[2]);
      if (refused) throw new core.HerdrError('metadata_rejected', 'pane p1 metadata rejected');
      return null;
    } }, { watch: false });
  t.after(() => fake.runtime.close());
  await fake.runtime.start(); await fake.runtime.publishStore();
  await fake.runtime.publishStore(); await fake.runtime.publishStore();
  assert.deepEqual(fake.statuses, ['herdr identity: pane p-link metadata rejected', 'herdr review tokens: pane p1 metadata rejected'], 'each said once');
  assert.deepEqual([identities.length, tries.length], [1, 1], 'neither is tried again inside its wait');
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.deepEqual([identities.length, tries.length], [2, 2], 'both are tried again after it');
  assert.equal(fake.statuses.length, 2, 'the same failure is not said again');
  // Once a count goes out, a later failure is a new one, and is said.
  refused = false;
  t.mock.timers.tick(30000); await fake.runtime.publishStore();
  assert.equal(tries.length, 3);
  refused = true;
  state.observatory.machines[1].sessions.sessions[0].pending = 4;
  await fake.runtime.publishStore();
  assert.deepEqual(fake.statuses.slice(2), ['herdr review tokens: pane p1 metadata rejected']);
});

// A conversation pinned from a saved machine that is down failed its Workers read every ten seconds, each failure
// written over the status row. It is said once; after a read that works, the next failure is said again.
test('Observatory Workers: a saved machine\'s failing read is said once, not on every read (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = pin(fixture(), 'remote-done', 'obs-detail', 'build');
  let down = true, reads = 0;
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined }, { watch: false, reader: { ...testReader(),
    read: async () => ({ events: [], cursor: null, transcriptPath: '/remote/remote-done.jsonl', agent: 'codex' }),
    fleet: async () => {
      reads++;
      if (down) throw new Error('oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out');
      return { subagents: [], todos: [] };
    } } });
  t.after(() => fake.runtime.close());
  const workers = () => fake.statuses.filter(s => s.startsWith('Workers'));
  await fake.runtime.load('obs-detail');
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(11000); await fake.runtime.refreshWorkers(); }
  assert.ok(reads >= 4, `read on its own schedule, as before (${reads})`);
  assert.deepEqual(workers(), ['Workers: oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out']);
  down = false; t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  down = true; t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(workers().length, 2, 'a failure after a read that worked is said');
});

// A pane that stopped showing the conversation, then showed it again (the pane's view picked away and back), read the
// same failure and said nothing: what the closed detail had said was still kept for it.
test('Observatory Workers: a detail closed and opened again on its pane says its read\'s failure again (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = pin(fixture(), 'remote-done', 'obs-detail', 'build');
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined }, { watch: false, reader: { ...testReader(),
    read: async () => ({ events: [], cursor: null, transcriptPath: '/remote/remote-done.jsonl', agent: 'codex' }),
    fleet: async () => { throw new Error('oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out'); } } });
  t.after(() => fake.runtime.close());
  const workers = () => fake.statuses.filter(s => s.startsWith('Workers'));
  await fake.runtime.load('obs-detail');
  t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(workers().length, 1);
  const { 'obs-detail': _closed, ...rest } = state.observatory.details;
  state.observatory = { ...state.observatory, details: rest };
  await fake.runtime.refreshWorkers();
  state.observatory = pin(state, 'remote-done', 'obs-detail', 'build').observatory;
  await fake.runtime.load('obs-detail');
  t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(workers().length, 2, 'opened again, its failure is said again');
});

// A detail closed while its Workers failure stood on the status row left it there: no read of that detail would ever
// work again to take it back, so the row said the machine could not be reached after it was back (2026-10-13). The
// close takes it back, unless the row has said something else since.
test('Observatory Workers: a detail closed while its failure is on the status row takes the failure with it (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = pin(fixture(), 'remote-done', 'obs-detail', 'build');
  let down = true;
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined }, { watch: false, status: message => { state.status = message; }, reader: { ...testReader(),
    read: async () => ({ events: [], cursor: null, transcriptPath: '/remote/remote-done.jsonl', agent: 'codex' }),
    fleet: async () => { if (down) throw new Error('oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out'); return { subagents: [], todos: [] }; } } });
  t.after(() => fake.runtime.close());
  const close = () => { const { 'obs-detail': _closed, ...rest } = state.observatory.details; state.observatory = { ...state.observatory, details: rest }; };
  await fake.runtime.load('obs-detail');
  t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(state.status, 'Workers: oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out');
  close(); await fake.runtime.refreshWorkers();
  assert.equal(state.status, 'ready', 'closed, its failure leaves the row');
  down = false;
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(11000); await fake.runtime.refreshWorkers(); }
  assert.equal(state.status, 'ready', 'and the row stays clear once the machine is back');
  // What the row said since stays.
  down = true;
  state.observatory = pin(state, 'remote-done', 'obs-detail', 'build').observatory;
  await fake.runtime.load('obs-detail');
  t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.match(state.status, /^Workers: /, 'opened again, its failure is said again');
  state.status = 'kept 1 edit';
  close(); await fake.runtime.refreshWorkers();
  assert.equal(state.status, 'kept 1 edit');
});

// Two conversations pinned from one saved machine fail their Workers reads in the same words: the one that works again
// took them back, and the other, still failing, said them no more (2026-10-13). It says them at its next failure.
test('Observatory Workers: a failure taken back for one detail is said again by another that still fails in the same words (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  let state = pin(fixture(), 'remote-done', 'obs-a', 'build');
  state = pin(state, 'unknown', 'obs-b', 'build');
  const down = new Set(['remote-done', 'unknown']);
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined }, { watch: false, status: message => { state.status = message; }, reader: { ...testReader(),
    read: async session => ({ events: [], cursor: null, transcriptPath: `/remote/${session}.jsonl`, agent: 'codex' }),
    fleet: async session => { if (down.has(session)) throw new Error('oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out'); return { subagents: [], todos: [] }; } } });
  t.after(() => fake.runtime.close());
  const said = 'Workers: oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out';
  await fake.runtime.load('obs-a'); await fake.runtime.load('obs-b');
  t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(state.status, said);
  down.delete('remote-done');
  t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(state.status, said, 'obs-a works again and obs-b failed again: the row still says so');
  down.delete('unknown');
  t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(state.status, 'ready', 'both work: taken back');
});

// Said once, such a failure stood on the status row after what failed worked again: the machine was back, and the row
// still said it could not be reached (2026-10-13). It is taken back then, unless the row has said something else since.
test('Observatory: a failure said on the status row is taken back once what failed works again (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = pin(fixture(), 'remote-done', 'obs-detail', 'build');
  let down = true, refused = true;
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrOnMachine: async (label, argv) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: state.observatory.machines[1].snapshot } };
      if (refused) throw new core.HerdrError('metadata_rejected', 'pane p1 metadata rejected');
      return null;
    } }, { watch: false, status: message => { state.status = message; }, reader: { ...testReader(),
    read: async () => ({ events: [], cursor: null, transcriptPath: '/remote/remote-done.jsonl', agent: 'codex' }),
    fleet: async () => {
      if (down) throw new Error('oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out');
      return { subagents: [], todos: [] };
    } } });
  t.after(() => fake.runtime.close());
  await fake.runtime.load('obs-detail');
  t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(state.status, 'Workers: oak: build-box is not reachable over ssh (fixture.invalid): Connection timed out');
  down = false; t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(state.status, 'ready', 'taken back once a read works');
  down = true; t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  state.status = 'kept 1 edit';
  down = false; t.mock.timers.tick(11000); await fake.runtime.refreshWorkers();
  assert.equal(state.status, 'kept 1 edit', 'what the row said since stays');
  await fake.runtime.publishStore();
  assert.equal(state.status, 'herdr review tokens: pane p1 metadata rejected');
  refused = false; t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(state.status, 'ready', 'taken back once the count goes out');
});

test('Observatory identity: a failed report that tells herdr a pane\'s session is taken back once it goes out (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = fixture();
  state.observatory.machines[0].snapshot.panes.push({ ...pane('p-link', 'linked', 'working'), agent_session: null });
  state.views.sessions.sessions.push({ id: 'linked', agent: 'codex', pending: 0 });
  let refused = true;
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    readHerdrPaneLink: session => session === 'linked' ? { paneId: 'p-link', socketPath: '/fake.sock', at: 3 } : null,
    reportHerdrSession: async () => { if (refused) throw new core.HerdrError('metadata_rejected', 'pane p-link metadata rejected'); } },
  { watch: false, status: message => { state.status = message; } });
  t.after(() => fake.runtime.close());
  await fake.runtime.start(); await fake.runtime.publishStore();
  assert.equal(state.status, 'herdr identity: pane p-link metadata rejected');
  refused = false; t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(state.status, 'ready', 'taken back once the report goes out');
});

// Two reports failed in the same words (a local herdr too busy to answer names the request, not the pane): the one that
// went out took them back, and the other, still failing, said them no more (2026-10-13). It says them at its next failure.
test('Observatory review tokens: a failure taken back for one report is said again by another that still fails in the same words (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = fixture();
  state.views.sessions.sessions.find(s => s.id === 'working').pending = 1;
  const failing = new Set(['p1', 'p2']);
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrRequest: async (method, params) => {
      if (method === 'pane.report_metadata' && failing.has(params.pane_id)) throw new core.HerdrTimeoutError('pane.report_metadata', 4000);
      return { type: 'ok' };
    } }, { watch: false, status: message => { state.status = message; } });
  t.after(() => fake.runtime.close());
  await fake.runtime.start(); await fake.runtime.publishStore();
  const said = 'herdr review tokens: herdr pane.report_metadata timed out after 4000 ms';
  assert.equal(state.status, said);
  failing.delete('p1');
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(state.status, said, 'p1 went out and p2 failed again: the row still says so');
  failing.delete('p2');
  t.mock.timers.tick(30000); await fake.runtime.publishStore();
  assert.equal(state.status, 'ready', 'both went out: taken back');
});

// What goes out takes back its own words only: another report's failure of the same kind, said on the row since, stays.
test('Observatory review tokens: a report that goes out leaves another report\'s failure of the same kind on the row (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = fixture();
  state.views.sessions.sessions.find(s => s.id === 'working').pending = 1;
  const refused = new Set(['p1']);
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrOnMachine: async (label, argv) => argv[0] === 'api' ? { result: { type: 'session_snapshot', snapshot: state.observatory.machines[1].snapshot } } : null,
    herdrRequest: async (method, params) => { if (method === 'pane.report_metadata' && refused.has(params.pane_id)) throw new core.HerdrError('metadata_rejected', `pane ${params.pane_id} metadata rejected`); return { type: 'ok' }; } },
  { watch: false, status: message => { state.status = message; } });
  t.after(() => fake.runtime.close());
  await fake.runtime.start(); await fake.runtime.publishStore();
  assert.equal(state.status, 'herdr review tokens: pane p1 metadata rejected');
  // p1 fails again (its wait is now 30 s); p2's count changes and its report fails in its own words, said on the row.
  state.views.sessions.sessions.find(s => s.id === 'working').pending = 4;
  refused.add('p2');
  t.mock.timers.tick(15000); await fake.runtime.publishStore();
  assert.equal(state.status, 'herdr review tokens: pane p2 metadata rejected');
  refused.delete('p1');
  t.mock.timers.tick(30000); await fake.runtime.publishStore();
  assert.equal(state.status, 'herdr review tokens: pane p2 metadata rejected', "p1 went out, and p2's failure, said after p1's, stays");
});

// A saved machine that stays listed and stays down keeps its growing wait across the discoveries that run on the same
// 15-second timer as the reports.
test('Observatory review tokens: a saved machine that stays listed keeps its growing wait across discoveries (2026-10-13)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  const state = fixture();
  const tries = [];
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined,
    herdrOnMachine: async (label, argv) => {
      if (argv[0] === 'api') return { result: { type: 'session_snapshot', snapshot: state.observatory.machines[1].snapshot } };
      tries.push(Date.now());
      throw unreachableBuildBox();
    } }, { watch: false });
  t.after(() => fake.runtime.close());
  await fake.runtime.start(); await fake.runtime.publishStore();
  for (let s = 0; s < 240; s += 15) { t.mock.timers.tick(15000); await fake.runtime.refreshRemotes(); await fake.runtime.publishStore(); }
  assert.deepEqual(tries.slice(1).map((at, i) => (at - tries[i]) / 1000).slice(0, 4), [15, 30, 60, 120]);
});

// A saved machine's failure read `build-box conversation unavailable: oak: build-box is not reachable…`,
// the CLI's own prefix mid-sentence. The Review panes already drop it.
test('Observatory detail: a remote read failure reads as one sentence, without the CLI\'s oak: prefix (2026-09-26)', async t => {
  const state = pin(fixture(), 'remote-done', 'obs-detail', 'build');
  const fake = fakeRuntime(state, { ensureHerdrTabs: undefined }, { watch: false, reader: { ...testReader(),
    read: async () => { throw new Error('oak: build-box is not reachable over ssh (fixture.invalid): Connection refused'); }, mirror: async () => ({ mirrored: false }) } });
  t.after(() => fake.runtime.close());
  await fake.runtime.load('obs-detail');
  assert.equal(state.observatory.details['obs-detail'].error, 'build-box conversation unavailable: build-box is not reachable over ssh (fixture.invalid): Connection refused');
});

// The tab strip always draws the selected tab whole, so under about 15 columns row 0 was wider than the
// terminal (`[ observatory ]` at 10) while every row below it was fitted.
test('frame: every row fits a terminal narrower than the selected tab (2026-09-26)', () => {
  for (const tab of [1, 2]) for (const cols of [1, 2, 5, 10, 14]) for (const rows of [1, 3, 5, 8]) {
    const state = fixture();
    state.tabs[1].root = tui.OBSERVATORY_TREE; state.activeTab = tab;
    Object.defineProperty(state, 'panes', { get: () => state.tabs[state.activeTab].panes, set() {} });
    const lines = tui.renderDashFrame(state, { cols, rows, color: 'none', glyphs: g });
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(tui.displayWidth(line) <= cols, `${state.tabs[tab].id} at ${cols}x${rows}: ${JSON.stringify(line)}`);
  }
});

// Codex's Auto-review runs each approval as a thread with a rollout of its own; the session list the master
// is drawn from (core's listing, which the app reads through the CLI) leaves them out (2026-09-30).
test('Observatory master: a Codex Auto-review thread is not listed beside the session it reviews', t => {
  const { root } = isolated(t);
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '30');
  fs.mkdirSync(dir, { recursive: true });
  const rollout = (id, prompt, meta) => fs.writeFileSync(path.join(dir, `rollout-2026-09-30T12-00-00-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd: root, ...meta } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } } },
  ].map(r => JSON.stringify({ timestamp: '2026-09-30T12:00:00Z', ...r })).join('\n') + '\n');
  const PARENT = '0199a000-0000-7000-8000-0000000000c1', REVIEW = '0199a000-0000-7000-8000-0000000000c2';
  rollout(PARENT, 'Fix the observatory exporter', {});
  rollout(REVIEW, 'The following is the Codex agent history whose request action you are assessing.', { thread_source: 'guardian_review', parent_thread_id: PARENT });
  const drawn = listing => {
    const state = fixture();
    state.views.sessions = listing;
    return lines(render({ ...state, allSessions: true, open: new Set(['earlier', 'archived']) }));
  };
  const all = drawn(core.sessionMeta(root, null, { includeReviews: true }));
  assert.match(all, /Auto-review: Fix the observatory exporter/, 'control: a listed review thread is drawn');
  const text = drawn(core.sessionMeta(root, null));
  assert.match(text, /Fix the observatory exporter/);
  assert.doesNotMatch(text, /Auto-review/);
});

// While Review reads a saved machine's session, only a store write lists this machine's sessions, and that machine's payload
// carries the app's catalog of them. The listing went into the views alone, which a switch to another of that machine's
// sessions clears, and a listing still being read then was dropped: a hand a waiting agent raised (its last write) left
// Review's toast and inbox until the next write. Each listing is the app's catalog now; moved to a session on this
// machine, whose own read lists the sessions, a listing still being read is dropped.
test('the session listing: Review moved to another session while it was read (2026-10-08)', async t => {
  isolated(t);
  const listing = { sessions: [{ id: 'localone', attention: { kind: 'permission', message: 'Bash', ts: 1 } }] };
  const run = async (move) => {
    const state = { session: 'remoteone', reviewMachine: { label: 'build-box' }, views: { list: {}, sessions: { sessions: [] } },
      observatory: { machines: [{ id: 'local', label: 'laptop', local: true }], details: {} } };
    const kept = [];
    let answer;
    const fake = { ...core, herdrMachines: async () => [], herdrSubscribe: () => ({ close() {} }), observatoryRoots: () => [] };
    const runtime = tui.createObservatory(fake, state, { cwd: '/workspace', changed() {}, status() {}, timers: false, watch: false,
      catalogFresh: () => !state.reviewMachine && !!state.session, catalog: (sessions) => kept.push(sessions),
      reader: { ...testReader(fake), sessions: () => new Promise((resolve) => { answer = resolve; }) } });
    t.after(() => runtime.close());
    const flight = runtime.refreshSessions();
    move(state);
    answer(listing);
    await flight;
    return { views: state.views, kept };
  };
  // The picker moves Review to another session on the same saved machine: its views are cleared for that machine's read.
  const away = await run((state) => { state.session = 'remotetwo'; state.views = null; });
  assert.deepEqual(away.kept, [listing], 'kept for the saved machine\'s read, whose payload carries this machine\'s sessions');
  assert.equal(away.views, null, 'never a payload of sessions alone, which Review draws as "… has no data to draw"');
  // Moved to a session on this machine: its own read lists the sessions, and this listing is dropped.
  const here = await run((state) => { state.session = 'localone'; state.reviewMachine = undefined; state.views = null; });
  assert.deepEqual([here.kept, here.views], [[], null]);
  // Still on the saved machine's session, its views in: the listing lands beside them, and in the catalog a switch reads.
  const stay = await run(() => {});
  assert.deepEqual([stay.views.sessions, stay.kept], [listing, [listing]]);
  // That machine's read failed, with nothing to draw: the listing lands in the views, as it did.
  const failed = await run((state) => { state.session = 'remotetwo'; state.views = null; state.reviewMachine = { label: 'build-box', error: 'not reachable' }; });
  assert.deepEqual([failed.views?.sessions, failed.kept], [listing, [listing]]);
  // The app keeps what the runtime hands it as this machine's catalog, which a saved machine's payload carries.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
  assert.match(src, /catalog: \(sessions\) => \{ localCatalog = sessions; \}/);
  assert.match(src, /const catalog = state\.views\?\.sessions \?\? localCatalog;/);
});

// Agents OAK started from a brief (`oak agent start --brief`): listed with OAK's own state, when it began, the error a
// turn stopped on and their workers; a row with a session pins it, and `t` opens the agent's own tab on its machine,
// before its session has a row of its own.
test('Observatory master: delegated agents with their states, since, error and workers; their tab opens on their machine', async () => {
  const state = fixture();
  const since = Date.UTC(2026, 8, 18, 13, 58, 7);
  state.views = { ...state.views, multitask: { ...(state.views.multitask ?? {}), agents: [], delegated: [
    { id: 'fix1', title: 'Fix the parser', kind: 'claude', model: 'Opus 5.5', effort: 'xhigh', machine: null, tab: 't1', pane: 'p9', session: 'sess-fix1', cwd: '/w/tree',
      state: 'working', since, tokens: 125000, cost: 1.25, workers: [{ id: 'w1', title: 'map the lexer', state: 'working', model: 'Sonnet' }] },
    { id: 'port2', remoteId: 'port2', title: 'Port the lexer', kind: 'codex', model: 'gpt-x', effort: 'high', machine: 'build-box', tab: 'rt1', pane: 'rp1', session: 'sess-port2',
      state: 'errored', since, error: 'Selected model is at capacity. Please try a different model.', workers: [] },
  ] } };
  const rows = render(state, 120);
  const text = lines(rows);
  assert.match(text, /^agents · 2$/m);
  assert.match(text, /^  fix1 · Fix the parser\n    \S+ working · since 13:58:07 · claude · Opus 5\.5 xhigh · tab fix1 · 125k tok · \$1\.25\n    └ map the lexer · working · Sonnet$/m);
  assert.match(text, /^  port2 · Port the lexer\n    \S+ errored · since 13:58:07 · codex · gpt-x high · on build-box · tab port2\n    Selected model is at capacity\. Please try a different model\.$/m);
  const row = rows.find(r => r.key === 'delegated:fix1');
  assert.deepEqual([row.scope.session, row.scope.paneId, row.scope.machineId], ['sess-fix1', 'p9', 'local']);
  assert.equal(rows.find(r => r.key === 'delegated:fix1:worker:w1').scope.agentId, 'w1');
  state.views.multitask.delegated[0].worktree = { state: { files: 3, added: 120, removed: 8, merged: false } };
  assert.match(lines(render({ ...state }, 180)), /3 files · \+120 −8 · not merged/);
  // Its tab: by its pane, here and on its saved machine, though neither session is listed yet.
  const { runtime, calls } = fakeRuntime(state);
  try {
    await runtime.start();
    await runtime.focus(row.scope);
    assert.ok(calls.some(c => c.method === 'pane.focus' && c.params.pane_id === 'p9'));
    await runtime.focus(rows.find(r => r.key === 'delegated:port2').scope);
    assert.ok(calls.some(c => c.label === 'build-box' && c.argv.join(' ') === 'agent focus rp1'));
  } finally { runtime.close(); }
  // None started: the master is as it was.
  assert.equal(lines(render(fixture())), lines(render({ ...fixture(), views: { ...fixture().views, multitask: { agents: [], delegated: [] } } })));
});

test('Observatory findings count stays visible without delegated agents and updates on refresh', () => {
  const state = fixture();
  state.views = { ...state.views, multitask: { agents: [], findings: { count: 2, rows: [] } } };
  assert.match(lines(render(state, 120)), /findings · 2 · oak finding list/);
  state.views.multitask.findings = { count: 0, rows: [] };
  assert.match(lines(render(state, 120)), /findings · 0 · oak finding list/);
  state.views.multitask.findings = { count: null, rows: [] };
  assert.match(lines(render(state, 120)), /findings · unavailable/);
});

test('workers: machine fleet state overrides a stale working transcript and names the pane by its tab', () => {
  const { observatorySessions } = require('../dist/observatory');
  const { observatoryMasterRows } = require('../dist/observatory-rows');
  const { glyphs } = require('../dist/glyphs');
  const state = { now: Date.now(), open: new Set(['archived']), allSessions: true, views: { sessions: { sessions: [] } },
    observatory: { details: {}, machines: [{ id: 'local', label: 'test-box', local: true,
      snapshot: { panes: [{ pane_id: 'p1', tab_id: 't1', agent: 'claude', agent_status: 'working', agent_session: { value: 'killed', agent: 'claude' } }], agents: [], tabs: [{ tab_id: 't1', label: 'Check amber widgets' }] },
      sessions: { sessions: [], workers: [{ session: 'killed', title: 'Check amber widgets', state: 'gone', kind: 'claude', worktree: '/synthetic', tokens: 10, lastActiveMs: 1, subagents: [] }] } }] } };
  assert.equal(observatorySessions(state)[0].label, 'Check amber widgets');
  const text = observatoryMasterRows(state, 150, glyphs('ascii'), 'none').map(r => r.cells).join('\n');
  assert.match(text, /gone/);
  assert.doesNotMatch(text, /working/);
});


test('queued agents: Workers show dependency ids before a session exists', () => {
  const state = fixture();
  const machine = state.observatory.machines.find(m => m.local);
  machine.sessions = { sessions: [], workers: [{ key: 'local:delegated:queue', title: 'Queued job', state: 'queued', session: '', after: ['dep-a', 'dep-b'] }] };
  const text = lines(render(state, 120));
  assert.match(text, /Queued job\n    queued · waiting on dep-a, dep-b/);
});

test('workspace window: groups offer only one unambiguous folder on their own machine', () => {
  const state = fixture();
  const rows = render(state);
  const group = rows.find(r => r.key === 'workspace:local:herdr:w1');
  assert.equal(group.workspaceWindow.root, '/workspace');
  assert.equal(group.workspaceWindow.machineId, 'local');
  assert.equal(group.buttons[0].action, 'workspace-window');
  assert.equal(rows.find(r => r.key === 'machine:build').workspaceWindow.machineId, 'build');
  assert.equal(rows.find(r => r.key === 'machine:local').workspaceWindow, undefined, 'another local session has no known folder');
  state.observatory.machines[0].snapshot.panes[1].cwd = '/other-project';
  assert.equal(render(state).find(r => r.key === 'workspace:local:herdr:w1').workspaceWindow, undefined, 'two folders sharing a group label must not choose one');
});

test('done sessions: per-machine folds retain workspaces, pins, selection, revival and search, and fold pending work with its count', () => {
  const state = fixture();
  state.views.sessions.sessions = [];
  state.views.multitask = { agents: [] };
  state.observatory.machines = ['local', 'build'].map((id, i) => ({ id, label: id, local: !i,
    snapshot: snapshot([pane('p1', `${id}-one`, 'done', 'codex', 'w1'), pane('p2', `${id}-two`, 'done', 'claude', 'w2')],
      { w1: `${id}-first`, w2: `${id}-second` }), sessions: { sessions: [] } }));
  const folds = rows => rows.filter(r => r.openPath?.startsWith('done:'));
  const shown = rows => rows.filter(r => r.key.startsWith('session:') && !r.cont).map(r => r.scope.session);
  const closed = render(state);
  assert.deepEqual(folds(closed).map(r => r.cells.trim()), ['> 2 done', '> 2 done']);
  assert.deepEqual(shown(closed), []);
  assert.ok(!closed.some(r => r.key.startsWith('workspace:')), 'done-only workspaces belong inside the fold');
  assert.deepEqual(closed.filter(r => r.key.startsWith('machine:') || r.openPath).map(r => r.key),
    ['machine:local', 'done:local', 'machine:build', 'done:build']);
  state.open = new Set(['done:local', 'done:build']);
  const opened = render(state);
  assert.equal(shown(opened).length, 4);
  for (const id of ['local', 'build']) {
    assert.equal(workspaceOfRow(opened, `${id}-one`).trim(), `${id}-first`);
    assert.equal(workspaceOfRow(opened, `${id}-two`).trim(), `${id}-second`);
  }
  const pinned = pin({ ...state, open: new Set() }, 'build-one', 'obs-detail', 'build');
  pinned.scopeWorker = null;
  assert.deepEqual(shown(render(pinned)), ['build-one'], 'a detail pin stays visible without the master selection');
  state.open = new Set();
  state.scopeWorker = tui.observatorySelection(state, 'local-two', 'local');
  assert.deepEqual(shown(render(state)), ['local-two'], 'the selected session cannot be hidden');
  // Selected inside its open fold, it stays there: pulled above the fold, it moved away from under the arrows that picked it.
  const order = rows => rows.filter(r => (r.key.startsWith('session:') && !r.cont) || r.openPath?.startsWith('done:')).map(r => r.openPath ?? r.scope.session);
  assert.deepEqual(order(render({ ...state, open: new Set(['done:local']) })), ['done:local', 'local-one', 'local-two', 'done:build']);
  state.scopeWorker = null;
  state.observatory.machines[0].sessions.sessions = [];
  state.views.sessions.sessions = [{ id: 'local-two', pending: 2 }];
  // The user: "alot of sessions that are marked done but not collapsed" (finished agents with edits left). Done folds
  // all the same; the fold row says how much review work is inside it.
  assert.deepEqual(shown(render(state)), [], 'a done session with pending edits folds');
  assert.deepEqual(folds(render(state)).map(r => r.cells.trim()), ['> 2 done · 2 pending', '> 2 done'], 'the fold counts the pending edits inside it');
  state.views.sessions.sessions = [];
  // `current` is the watched session only on this machine: a saved machine's listing marks the newest session of its own
  // launch folder, which must not hold a done session out of the fold here (2026-11-05).
  state.observatory.machines[1].sessions.sessions = [{ id: 'build-one', current: true }];
  assert.ok(!shown(render(state)).includes('build-one'), 'another machine\'s current session folds when done');
  state.observatory.machines[1].sessions.sessions = [];
  state.views.sessions.sessions = [{ id: 'local-one', current: true }];
  assert.deepEqual(shown(render(state)), ['local-one'], 'this machine\'s watched session stays visible');
  state.views.sessions.sessions = [];
  state.observatory.machines[0].snapshot.panes[0].agent_status = 'working';
  assert.deepEqual(shown(render(state)), ['local-one'], 'a new turn leaves its closed fold');
  state.filter = 'build-two';
  assert.deepEqual(shown(render(state)), ['build-two'], 'a search reveals the matching done session');
  assert.equal(folds(render(state)).length, 0);
  state.filter = '';
  state.views.sessions.sessions = [{ id: 'pending-done', pending: 2 }];
  state.views.multitask.agents = [{ session: 'pending-done', state: 'done', title: 'Pending finished work', worktree: '/fixture' }];
  state.open = new Set(['earlier']);
  assert.ok(!shown(render(state)).includes('pending-done'), 'finished work awaiting review is not under earlier');
  state.open = new Set(['done:local']);
  const inFold = shown(render(state));
  assert.ok(inFold.includes('pending-done'), 'it is in its machine’s done fold');
  assert.equal(inFold.filter(id => id === 'pending-done').length, 1, 'listed once');
  // A filter that matches it shows it under its machine, and "earlier" neither lists nor counts it again (review 2026-11-05).
  state.open = new Set(['earlier']);
  state.filter = 'pending-done';
  const filtered = render(state);
  assert.equal(shown(filtered).filter(id => id === 'pending-done').length, 1, 'a filtered finished session is drawn once');
  assert.ok(!filtered.some(r => r.key === 'earlier'), 'and not counted under earlier');
  state.filter = '';
  // With no herdr pane, a finished turn its hooks recorded (idle-done) folds as the editors fold it (review 2026-11-05).
  state.views.multitask.agents = [];
  // (With nothing pending such a session is archived here, behind Show archived, as before.)
  state.views.sessions.sessions = [{ id: 'quiet-finished', pending: 1, attention: { kind: 'idle-done', ts: 1 } }];
  state.open = new Set();
  assert.ok(!shown(render(state)).includes('quiet-finished'), 'a paneless finished session folds');
  state.open = new Set(['done:local']);
  assert.ok(shown(render(state)).includes('quiet-finished'), 'inside its machine\'s done fold');
});

test('saved machine Workers follow pane visibility without delaying Sessions or changing the poll', async t => {
  const state = fixture(), reads = [];
  let visible = false;
  const fake = fakeRuntime(state, {}, { watch: false, workersVisible: () => visible, reader: { ...testReader(),
    sessions: async (_session, _root, machine, workers) => {
      reads.push({ machine, workers });
      return { sessions: [{ id: 'remote-done', title: 'Remote work' }], ...(workers ? { workers: [{ session: 'remote-done' }] } : {}) };
    },
  } });
  t.after(() => fake.runtime.close());
  await fake.runtime.refreshRemotes();
  assert.ok(reads.length);
  assert.ok(reads.every(r => r.workers === false), 'hidden Workers never enters the Workers reader');
  const count = reads.length;
  visible = true;
  await fake.runtime.refreshRemotes();
  assert.equal(reads.length, count * 2, 'opening Workers upgrades the recent Sessions-only answer immediately');
  assert.ok(reads.slice(count).every(r => r.workers));
  assert.ok(state.observatory.machines.find(m => !m.local).sessions.workers.length);
  await fake.runtime.refreshRemotes();
  assert.equal(reads.length, count * 2, 'regular cooldown still applies');
});

test('app Workers demand follows the visible pane, including the Observatory tree that renders fleet states', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/app.ts'), 'utf8');
  const ast = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true);
  const callbacks = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'workersVisible') callbacks.push(node.initializer.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(callbacks.length, 2, 'live and one-shot app both declare the consumer');
  for (const callback of callbacks) {
    const context = { tabs: [{ root: {} }], active: 0, placements: [], leafPanes: () => context.placements,
      treeGeom: () => ({ tl: { placements: context.placements } }) };
    const visible = vm.runInNewContext(ts.transpile('(' + callback + ')'), context);
    for (const [views, expected] of [[['workers'], true], [['sessions-nav'], true], [['session-detail'], false], [[], false]]) {
      context.placements = views.map(view => ({ view }));
      assert.equal(visible(), expected, views.join(',') || 'collapsed');
    }
    context.tabs = [{}];
    assert.equal(visible(), false, 'another tab has no Workers consumer');
  }
});
