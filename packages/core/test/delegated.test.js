// Delegated agents (core src/delegated.ts): the state OAK derives from a session's own files, the start from a brief in a
// herdr tab (against a fake herdr), close, and the index's `delegated` rows. Synthetic transcripts, rollouts and machines.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const core = require('../dist');
const { indexFixture } = require('./fixtures/index-fixture.cjs');
const { fakeHerdr, processInfo } = require('./fake-herdr');

const skipIndex = !core.indexRuntime().ok && `no node:sqlite with FTS5 in ${process.version}`;

/** A process whose command line names the agent's CLI, as the pid OAK records for it. */
function liveAgent(t, kind) {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', kind], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  return child;
}

/** A record as `oak agent start` writes it, for a local agent working in `cwd`. */
function record(f, over = {}) {
  const out = path.join(f.dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const now = Date.now();
  const rec = { id: 'a1', title: 'Fix the parser', brief: path.join(f.dir, 'a1-brief.md'), cwd: f.work, out, report: path.join(out, 'report.md'), kind: 'claude',
    agentType: 'builder', model: null, effort: null, sandbox: null, machine: null, workspace: 'w1', tab: 't1', pane: 'p1', herdrName: 'oak-a1', pid: null,
    session: null, parent: null, startedMs: now - 60_000, endedMs: null, closedMs: null, state: 'starting', since: now - 60_000, ...over };
  core.writeDelegated(rec);
  return rec;
}
const stateOf = (id, opts) => core.refreshDelegated(opts).find((r) => r.id === id);
const tool = (id) => ({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });
const said = (n) => ({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `m-${n}`, role: 'assistant', content: [{ type: 'text', text: 'finished' }] } });
const result = (id) => ({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('delegated: indexed remote matching takes linear work across agents and machines', (t) => {
  indexFixture(t, core);
  const api = require('../dist/index/api');
  t.mock.method(fs, 'renameSync', () => {});
  t.mock.method(fs, 'writeFileSync', () => {});
  for (const machines of [1, 100]) {
    let ids = 0, visits = 0;
    const recs = Array.from({ length: 1000 }, (_, i) => ({ id: `local-${i}`, remoteId: `remote-${i}`, kind: 'codex',
      get machine() { visits++; return `machine-${i % machines}`; }, startedMs: 1, state: 'working', since: 1, closedMs: null }));
    const groups = new Map(Array.from({ length: machines }, (_, m) => [`machine-${m}`, []]));
    recs.forEach((r, i) => groups.get(r.machine).push({ get id() { ids++; return `remote-${i}`; }, state: 'blocked', since: i,
      tokens: i, cost: i / 100, workers: [{ id: `worker-${i}`, parent: `remote-${i}` }] }));
    t.mock.method(api, 'indexedMachineDelegated', (label) => ({ agents: groups.get(label) }));
    visits = 0;
    assert.equal(core.refreshRemoteFromIndex(recs, 1000).size, machines);
    assert.deepEqual(recs.map((r) => [r.state, r.since, r.remote.tokens, r.remote.workers[0].parent]),
      recs.map((r, i) => ['blocked', i, i, r.id]));
    assert.ok(ids <= 2 * recs.length, `remote id reads (${machines} machines): ${ids}`);
    assert.ok(visits <= 8 * recs.length, `local machine reads (${machines} machines): ${visits}`);
  }
});

test('delegated: derivation — done outranks gone outranks blocked; starting until a session; working, waiting by the turn', () => {
  const rec = { state: 'starting', since: 1000, startedMs: 1000 };
  const e = { session: null, report: null, hand: null, turn: null, native: null, alive: null, lastActiveMs: null };
  assert.deepEqual(core.deriveDelegatedState(rec, e, 5000), { state: 'starting', since: 1000 });
  assert.deepEqual(core.deriveDelegatedState(rec, { ...e, session: 's' }, 5000), { state: 'working', since: 5000 }, 'a session with no turn ended works');
  assert.deepEqual(core.deriveDelegatedState({ ...rec, state: 'working', since: 4000 }, { ...e, session: 's', turn: 'open' }, 5000).since, 4000, 'since holds while the state does');
  assert.deepEqual(core.deriveDelegatedState(rec, { ...e, session: 's', turn: 'ended', lastActiveMs: 3000 }, 5000), { state: 'waiting', since: 3000 }, 'waiting since the last write');
  assert.equal(core.deriveDelegatedState(rec, { ...e, session: 's', turn: 'ended', native: 'busy' }, 5000).state, 'working', "Claude Code's busy outranks a tail");
  assert.equal(core.deriveDelegatedState(rec, { ...e, session: 's', turn: 'open', hand: { kind: 'idle-done', ts: 4500 } }, 5000).state, 'waiting', 'the Stop hook ended the turn');
  assert.deepEqual(core.deriveDelegatedState(rec, { ...e, session: 's', hand: { kind: 'permission', ts: 4200 } }, 5000), { state: 'blocked', since: 4200 });
  assert.equal(core.deriveDelegatedState(rec, { ...e, session: 's', hand: { kind: 'question', ts: 1 }, alive: false }, 5000).state, 'gone');
  assert.deepEqual(core.deriveDelegatedState(rec, { ...e, alive: false, report: { mtimeMs: 4800, size: 9 } }, 5000), { state: 'done', since: 4800 }, 'the report written is done, ended or not');
  assert.equal(core.deriveDelegatedState(rec, { ...e, report: { mtimeMs: 500, size: 9 } }, 5000).state, 'starting', 'a report from before it started is not its own');
  assert.equal(core.deriveDelegatedState(rec, { ...e, report: { mtimeMs: 4800.8633, size: 9 } }, 5000).since, 4801, 'a whole millisecond, as every other time');
  assert.equal(core.deriveDelegatedState(rec, { ...e, report: { mtimeMs: 4800, size: 0 } }, 5000).state, 'starting', 'an empty report is not written yet');
  assert.deepEqual(core.deriveDelegatedState({ ...rec, state: 'done', since: 2000 }, { ...e, alive: false }, 5000), { state: 'done', since: 2000 }, 'done is final');
  assert.deepEqual(core.deriveDelegatedState(rec, { ...e, session: 's', turn: 'open', turnError: { message: 'at capacity', ts: 4100 } }, 5000), { state: 'errored', since: 4100, error: 'at capacity' });
  assert.equal(core.deriveDelegatedState(rec, { ...e, session: 's', hand: { kind: 'input', ts: 1 }, turnError: { message: 'x', ts: 2 } }, 5000).state, 'blocked', 'a hand outranks the error');
});

test('delegated: a Claude agent through every state, from its own transcript, hands, process and report', (t) => {
  const f = indexFixture(t, core);
  const agent = liveAgent(t, 'claude');
  record(f, { pid: agent.pid });
  const native = () => new Map();
  assert.equal(stateOf('a1', { native }).state, 'starting', 'no session linked yet');
  // The agent's first hook links its session: the tab's shell exported OAK_DELEGATED.
  core.linkDelegated('s-claude-1', { OAK_DELEGATED: 'a1' });
  core.linkDelegated('s-nested', { OAK_DELEGATED: 'a1' });
  assert.equal(core.readDelegated('a1').session, 's-claude-1', 'the first session wins; a nested one finds it taken');
  f.claude('s-claude-1', f.work, [{ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'brief' } }, tool('c1')]);
  const working = stateOf('a1', { native });
  assert.equal(working.state, 'working', 'a tool call in progress');
  core.writeAttention('s-claude-1', { kind: 'permission', message: 'Bash', ts: Date.now() - 1000 });
  const blocked = stateOf('a1', { native });
  assert.equal(blocked.state, 'blocked');
  assert.ok(Math.abs(blocked.since - (Date.now() - 1000)) < 50, 'since the hand went up');
  core.clearAttention('s-claude-1');
  f.claude('s-claude-1', f.work, [tool('c1'), result('c1'), said(2)]);
  assert.equal(stateOf('a1', { native }).state, 'waiting', 'the turn ended with no report');
  assert.equal(stateOf('a1', { native: () => new Map([['s-claude-1', { status: 'busy', pid: agent.pid }]]) }).state, 'working', "claude agents --json says busy");
  fs.writeFileSync(core.readDelegated('a1').report, 'DONE\n');
  const done = stateOf('a1', { native });
  assert.equal(done.state, 'done');
  assert.equal(done.endedMs, done.since);
  assert.equal(core.readDelegated('a1').state, 'done', 'written back to its record');
});

test('delegated: a hook killed while writing its session link leaves the next hook able to link', (t) => {
  const f = indexFixture(t, core);
  record(f);
  const prefix = path.join(core.delegatedDir(), 'a1.session');
  const killed = cp.spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const write = fs.writeFileSync;
    fs.writeFileSync = function (p, data, opts) {
      if (String(p).startsWith(${JSON.stringify(prefix)})) {
        fs.openSync(p, opts?.flag || 'w', 0o600);
        process.kill(process.pid, 'SIGKILL');
      }
      return write.call(fs, p, data, opts);
    };
    require(${JSON.stringify(path.resolve(__dirname, '../dist/delegated-link'))}).linkDelegated('s-first', { OAK_DELEGATED: 'a1' });
  `]);
  assert.equal(killed.signal, 'SIGKILL');
  core.linkDelegated('s-retried', { OAK_DELEGATED: 'a1' });
  core.linkDelegated('s-nested', { OAK_DELEGATED: 'a1' });
  assert.equal(core.readDelegated('a1').session, 's-retried', 'a complete link wins and nested agents cannot replace it');
});

test('delegated: a record writer killed before rename leaves the previous record readable', (t) => {
  const f = indexFixture(t, core);
  const rec = record(f);
  const killed = cp.spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    fs.renameSync = () => process.kill(process.pid, 'SIGKILL');
    require(${JSON.stringify(path.resolve(__dirname, '../dist/delegated'))}).writeDelegated(${JSON.stringify({ ...rec, state: 'done' })});
  `]);
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(core.readDelegated('a1').state, 'starting');
  assert.deepEqual(core.listDelegatedRecords().map((r) => r.id), ['a1'], 'an orphan temporary record is ignored');
});

test('delegated: a Codex agent by its rollout; one whose process ended without a report is gone', (t) => {
  const f = indexFixture(t, core);
  const agent = liveAgent(t, 'codex');
  record(f, { id: 'c1', kind: 'codex', pid: agent.pid, session: '0199aaaa-0000-7000-8000-000000000001' });
  const ev = (type) => ({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, turn_id: 'turn-1' } });
  const file = f.rollout('0199aaaa-0000-7000-8000-000000000001', f.work, [ev('task_started')]);
  assert.equal(stateOf('c1').state, 'working', 'task_started with no completion');
  fs.appendFileSync(file, JSON.stringify(ev('task_complete')) + '\n');
  assert.equal(stateOf('c1').state, 'waiting', 'task_complete');
  agent.kill('SIGKILL');
  cp.spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
  const gone = stateOf('c1');
  assert.equal(gone.state, 'gone', 'its process ended and no report');
  fs.writeFileSync(path.join(f.dir, 'out', 'report.md'), 'late\n');
  assert.equal(stateOf('c1').state, 'gone', 'gone is final');
});

test('delegated: a Codex turn that stopped on a provider error is errored, with its text and time, until the prompt is sent again', (t) => {
  const f = indexFixture(t, core);
  const agent = liveAgent(t, 'codex');
  const id = '0199aaaa-0000-7000-8000-0000000000e1';
  record(f, { id: 'e1', kind: 'codex', pid: agent.pid, session: id });
  const at = (ms) => new Date(ms).toISOString();
  const ev = (payload, ms = Date.now()) => ({ timestamp: at(ms), type: 'event_msg', payload });
  const errAt = Date.now() - 5000;
  const file = f.rollout(id, f.work, [ev({ type: 'task_started', turn_id: 't1' }, errAt - 9000), ev({ type: 'agent_message', message: 'reading the brief' }, errAt - 8000),
    ev({ type: 'error', message: 'Selected model is at capacity. Please try a different model.' }, errAt)]);
  const errored = stateOf('e1');
  assert.deepEqual([errored.state, errored.error, errored.since], ['errored', 'Selected model is at capacity. Please try a different model.', errAt],
    'stopped on the error, not working (no task_complete followed) and not waiting');
  fs.appendFileSync(file, JSON.stringify(ev({ type: 'task_complete', turn_id: 't1', last_agent_message: null }, errAt + 100)) + '\n');
  assert.equal(stateOf('e1').state, 'errored', 'nor waiting once the turn is closed');
  fs.appendFileSync(file, JSON.stringify(ev({ type: 'task_started', turn_id: 't2' })) + '\n');
  const resent = stateOf('e1');
  assert.equal(resent.state, 'working', 'sent again');
  assert.equal(resent.error, undefined, 'and the error is no longer said');
});

test('delegated: a Claude turn that ended on an API error is errored until a person writes again', (t) => {
  const f = indexFixture(t, core);
  const agent = liveAgent(t, 'claude');
  record(f, { id: 'e2', pid: agent.pid, session: 's-e2' });
  const ts = Date.now() - 3000;
  const file = f.claude('s-e2', f.work, [{ type: 'user', timestamp: new Date(ts - 1000).toISOString(), message: { role: 'user', content: 'brief' } },
    { type: 'assistant', isApiErrorMessage: true, timestamp: new Date(ts).toISOString(), message: { id: 'm-err', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }]);
  const e = stateOf('e2', { native: () => new Map() });
  assert.deepEqual([e.state, e.error, e.since], ['errored', 'API Error: 529 Overloaded', ts]);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', cwd: f.work, sessionId: 's-e2', timestamp: new Date().toISOString(), message: { role: 'user', content: 'try again' } }) + '\n');
  const resent = stateOf('e2', { native: () => new Map([['s-e2', { status: 'busy', pid: agent.pid }]]) });
  assert.deepEqual([resent.state, resent.error], ['working', undefined], 'sent again: no longer errored');
});

test('delegated: a pane herdr no longer has ends its agent; a closed tab does too, done with its report', (t) => {
  const f = indexFixture(t, core);
  record(f, { id: 'p1', session: 's-p1' });
  const herdr = new Map([['local', core.paneEvidence({ panes: [{ pane_id: 'other', agent_session: null }] })]]);
  assert.equal(stateOf('p1', { herdr }).state, 'gone');
  record(f, { id: 'p2', pane: 'p2', session: 's-p2' });
  fs.writeFileSync(path.join(f.dir, 'out', 'report.md'), 'report\n');
  const rec = core.readDelegated('p2');
  core.writeDelegated({ ...rec, closedMs: Date.now() });
  assert.equal(stateOf('p2').state, 'done');
});

test('delegated: start — a tab labelled from the brief, its shell told not to update, herdr\'s timeout checked against the pane, the trust prompt answered, the brief sent and entered', async (t) => {
  const f = indexFixture(t, core);
  const brief = path.join(f.dir, 'fix1-brief.md');
  fs.writeFileSync(brief, '# Fix the parser\n\nDo it.\n');
  let infos = 0, reads = 0;
  const screens = ['$ ', 'Is this a project you created or one you trust? (Like your own code)\n❯ 1. Yes, I trust this folder', '> \n? for shortcuts', 'thinking… (esc to interrupt)'];
  const fake = await fakeHerdr(t, {
    'tab.create': () => ({ type: 'tab_created', tab: { tab_id: 't9', workspace_id: 'w2', label: 'x', number: 3, focused: false, pane_count: 1, agent_status: 'unknown' }, root_pane: { pane_id: 'p9' } }),
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: infos++ < 1 ? processInfo.idle(pane_id) : { pane_id, shell_pid: 100, foreground_process_group_id: 300, foreground_processes: [{ pid: 300, name: 'claude', argv: ['claude', '--agent', 'builder'] }] } }),
    // herdr's own start gave up while the agent was in fact starting.
    'agent.start': () => { throw Object.assign(new Error('timed out waiting for the agent'), { code: 'timeout' }); },
    'pane.read': () => ({ type: 'pane_read', read: { pane_id: 'p9', text: screens[Math.min(reads++, screens.length - 1)], revision: reads, format: 'text', source: 'visible', tab_id: 't9', truncated: false, workspace_id: 'w2' } }),
    'pane.send_keys': () => ({ type: 'ok' }),
    'agent.prompt': () => ({ type: 'agent_prompted', agent: {} }),
    'agent.send_keys': () => ({ type: 'ok' }),
  });
  if (!fake) return;
  fake.snapshot = {};
  const logs = [];
  const rec = await core.startDelegatedAgent({ kind: 'claude', brief, cwd: f.work, name: 'fix1', out: path.join(f.dir, 'fix1-out'), agentType: 'builder', permissionMode: 'auto',
    herdr: { socketPath: fake.socketPath }, sleep: async () => {}, patience: 0.1, log: (l) => logs.push(l) });
  const create = fake.calls('tab.create')[0];
  assert.deepEqual([create.label, create.focus, create.env, create.cwd], ['fix1: Fix the parser', false, { DISABLE_AUTO_UPDATE: 'true', OAK_DELEGATED: 'fix1' }, f.work]);
  assert.deepEqual(fake.calls('agent.start')[0].args, ['--agent', 'builder', '--permission-mode', 'auto']);
  assert.ok(logs.some((l) => /claude runs in the pane/.test(l)), 'the timeout was checked, not believed');
  assert.deepEqual(fake.calls('pane.send_keys'), [{ pane_id: 'p9', keys: ['Enter'] }], 'the trust prompt took its first choice');
  const prompt = fake.calls('agent.prompt')[0];
  assert.equal(prompt.target, 'oak-fix1');
  assert.match(prompt.text, /^# fix1: Fix the parser\n\nYour brief is .*fix1-brief\.md\. .*write .*fix1-out\/report\.md and end your last message with DONE\.$/s);
  assert.deepEqual(fake.calls('agent.send_keys'), [{ target: 'oak-fix1', keys: ['Enter'] }], 'Enter follows the prompt');
  const order = fake.requests.map((r) => r.method).filter((m) => m !== 'pane.read' && m !== 'pane.process_info');
  assert.deepEqual(order, ['session.snapshot', 'tab.create', 'agent.start', 'pane.send_keys', 'agent.prompt', 'agent.send_keys']);
  assert.deepEqual([rec.id, rec.title, rec.tab, rec.workspace, rec.pane, rec.pid, rec.state, rec.agentType], ['fix1', 'Fix the parser', 't9', 'w2', 'p9', 300, 'starting', 'builder']);
  assert.deepEqual(core.readDelegated('fix1').pane, 'p9', 'recorded');
});

test('delegated: start — an agent that never started leaves its row gone with why, and the tab for a look', async (t) => {
  const f = indexFixture(t, core);
  const brief = path.join(f.dir, 'b.md');
  fs.writeFileSync(brief, 'no heading\n');
  const fake = await fakeHerdr(t, {
    'tab.create': () => ({ type: 'tab_created', tab: { tab_id: 't1', workspace_id: 'w1' }, root_pane: { pane_id: 'p1' } }),
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: processInfo.idle(pane_id) }),
    'agent.start': () => { throw Object.assign(new Error('codex: command not found'), { code: 'launch_failed' }); },
  });
  if (!fake) return;
  fake.snapshot = {};
  await assert.rejects(core.startDelegatedAgent({ kind: 'codex', brief, cwd: f.work, herdr: { socketPath: fake.socketPath }, sleep: async () => {}, patience: 0.1 }),
    /codex did not start: codex: command not found\. The tab stays open in herdr \(pane p1\)/);
  const rec = core.readDelegated('b');
  assert.deepEqual([rec.title, rec.state, rec.error], ['b', 'gone', 'codex did not start: codex: command not found']);
});

test('delegated: Codex starts with its model, effort and sandbox, and may write its output folder outside the tree', () => {
  assert.deepEqual(core.delegatedArgs('codex', { model: 'gpt-x', effort: 'xhigh', sandbox: 'workspace-write', cwd: '/w/tree', out: '/w/tree-out', args: ['-a', 'never'] }),
    ['-c', 'model="gpt-x"', '-c', 'model_reasoning_effort="xhigh"', '-c', 'check_for_update_on_startup=false', '-s', 'workspace-write',
      '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([path.resolve('/w/tree-out')])}`, '-a', 'never']);
  assert.deepEqual(core.delegatedArgs('codex', { sandbox: 'workspace-write', cwd: '/w/tree', out: '/w/tree/out' }), ['-c', 'check_for_update_on_startup=false', '-s', 'workspace-write', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([path.resolve('/w/tree/out')])}`]);
  assert.deepEqual(core.parsePrefs({ agents: { codex: { model: 'gpt-x', sandbox: 7, args: ['-a', 'never'] }, claude: { agentType: 'builder' } } }).agents,
    { codex: { model: 'gpt-x', args: ['-a', 'never'] }, claude: { agentType: 'builder' } }, 'a bad field is dropped, never the rest');
});

test('delegated: close — the tab closed in herdr, the row kept, closed and gone without its report', async (t) => {
  const f = indexFixture(t, core);
  record(f, { id: 'x1', session: 's-x1', tab: 't4' });
  const fake = await fakeHerdr(t, { 'tab.close': () => ({ type: 'ok' }) });
  if (!fake) return;
  const rec = await core.closeDelegatedAgent('x1', { socketPath: fake.socketPath });
  assert.deepEqual(fake.calls('tab.close'), [{ tab_id: 't4' }]);
  assert.equal(rec.state, 'gone');
  assert.equal(typeof core.readDelegated('x1').closedMs, 'number');
  assert.equal(core.listDelegated({ native: () => new Map() }).length, 0, 'closed rows leave the list…');
  assert.equal(core.listDelegated({ all: true, native: () => new Map() }).length, 1, '…and stay under all');
});

test('delegated: the index mirrors the records, publishes them in the record log, and `oak query delegated` lists them with their workers', { skip: skipIndex }, (t) => {
  const f = indexFixture(t, core);
  record(f, { id: 'q1', session: 's-q1', state: 'working' });
  record(f, { id: 'q2', kind: 'codex', state: 'done', closedMs: Date.now() });
  const parent = f.claude('s-q1', f.work, [{ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } },
    { type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'map the parser', subagent_type: 'Explore' } }], usage: { input_tokens: 100, output_tokens: 20 } } }]);
  const sub = path.join(path.dirname(parent), 's-q1', 'subagents', 'agent-w1.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, JSON.stringify({ type: 'user', isSidechain: true, agentId: 'w1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'map the parser' } }) + '\n');
  const a = core.queryIndex('delegated', {}, { budgetMs: Infinity });
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  assert.deepEqual(a.rows.map((r) => [r.id, r.kind, r.state, r.parent]), [['q1', 'claude', 'working', null], ['w1', 'worker', null, 'q1']]);
  assert.equal(a.rows[0].tokens, 120, "its session's tokens");
  const all = core.queryIndex('delegated', { all: true, workers: false });
  assert.deepEqual(all.rows.map((r) => r.id).sort(), ['q1', 'q2'], 'all takes the closed one');
  // A record changed is read again; one removed leaves.
  core.writeDelegated({ ...core.readDelegated('q1'), state: 'waiting' });
  fs.rmSync(path.join(core.delegatedDir(), 'q2.json'));
  assert.deepEqual(core.queryIndex('delegated', { all: true, workers: false }).rows.map((r) => [r.id, r.state]), [['q1', 'waiting']]);
  // Every machine's index hears of it: this machine's record log carries the rows.
  const host = core.machineHostTag();
  const log = core.segments(host).map((s) => fs.readFileSync(s.file, 'utf8')).join('');
  assert.match(log, /"t":"delegated","r":\{"id":"q1"/);
  assert.match(log, /"t":"delegated","d":\{"id":"q2"\}/);
  assert.doesNotMatch(log, /"stamp"/, "the record's file stamp stays here");
});

test('delegated: watch roots — the records, the report\'s folder, the transcript\'s folder and the session\'s store, for live local agents only', (t) => {
  const f = indexFixture(t, core);
  const rec = record(f, { session: 's-w1' });
  f.claude('s-w1', f.work, [said(1)]);
  const roots = core.delegatedWatchRoots([rec, { ...rec, id: 'r', machine: 'box' }, { ...rec, id: 'd', state: 'done' }]);
  assert.deepEqual(roots.map((r) => [r.kind, r.dir]), [['store', core.delegatedDir()], ['store', path.dirname(rec.report)], ['store', core.storeDir('s-w1')], ['activity', core.projectDir(f.work)]]);
  const report = roots[1];
  assert.equal(report.relevant('report.md', report.dir), true);
  assert.equal(report.relevant('notes.md', report.dir), false);
});

test('queued agents: multiple sessionless agents stay visible in Workers and the database without a migration', { skip: skipIndex }, async t => {
  const f = indexFixture(t, core);
  record(f, { id: 'dep', state: 'done' });
  for (const id of ['first', 'second']) record(f, { id, state: 'queued', after: ['dep'], pane: null, tab: null });
  const fleet = await core.readWorkerFleet(f.work, null, { snapshot: { panes: [], agents: [], tabs: [] }, native: new Map(), alive: () => false });
  assert.deepEqual(fleet.workers.filter(w => w.state === 'queued').map(w => [w.title, w.after, w.active]), [
    ['Fix the parser', ['dep'], true], ['Fix the parser', ['dep'], true],
  ]);
  const query = core.queryIndex('delegated', { all: true, workers: false }, { budgetMs: Infinity });
  assert.equal(query.rows.filter(r => r.state === 'queued').length, 2);
});

test('agent tell record: stale refreshes preserve messages and closed rows', t => {
  const f = indexFixture(t, core), stale = record(f);
  const message = { id: 'message1', at: Date.now(), from: 'test-teller', text: 'extra scope' };
  core.writeDelegated({ ...stale, messages: [message], lastMessageMs: message.at, closedMs: message.at, state: 'gone' });
  core.writeDelegated({ ...stale, state: 'working' });
  const rec = core.readDelegated(stale.id);
  assert.deepEqual(rec.messages, [message]); assert.equal(rec.lastMessageMs, message.at);
  assert.equal(rec.state, 'gone'); assert.equal(rec.closedMs, message.at);
});

test('agent close record: closure time advances and a stale writer cannot replace closed done with gone', async t => {
  const f = indexFixture(t, core);
  record(f, { id: 'closing', state: 'working', since: Date.now() - 60000 });
  const fake = await fakeHerdr(t, { 'tab.close': () => ({ type: 'ok' }) }); if (!fake) return;
  const before = Date.now();
  const closed = await core.closeDelegatedAgent('closing', { socketPath: fake.socketPath });
  assert.ok(closed.since >= before, 'gone begins when the tab closes, not when working began');
  const stale = record(f, { id: 'finished', state: 'working' });
  core.writeDelegated({ ...stale, state: 'done', closedMs: before, endedMs: before, since: before });
  core.writeDelegated(stale);
  assert.equal(core.readDelegated('finished').state, 'done');
});
