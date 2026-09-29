/**
 * The Review tab on a session that lives on another machine: its reads and verbs go to THAT machine
 * through the CLI's own `--machine <label>`, and a session on this machine is served exactly as before.
 *
 * The backend is driven with a fake core that records every child it would spawn and counts every
 * in-process read of this machine's store, so "routed there" and "never read here" are both measured.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const tui = require('../dist');
const { createBackend, createConversationReader } = require('../dist/backend');

const self = process.argv[1];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeCore(overrides = {}) {
  const calls = [];
  const inProcess = [];
  const core = {
    spawnTool(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => { child.killed = true; child.emit('exit'); child.emit('close', null); };
      const writes = [];
      child.stdin = { writable: true, write: (s) => { writes.push(s); return true; }, on() {} };
      calls.push({ command, args, options, child, writes,
        // One JSON document then exit: a cold CLI child.
        reply(value, code = 0) { child.stdout.emit('data', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); child.emit('close', code); },
        fail(stderr, code) { child.stderr.emit('data', Buffer.from(stderr)); child.emit('close', code); },
        // One payload line from the warm `views --serve` worker.
        line(value) { child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); } });
      return child;
    },
    createWatcher: () => ({ stats: () => [{ mode: 'native' }], close() {} }),
    observatoryRoots: () => [],
    readLog: (session) => { inProcess.push(['readLog', session]); return []; },
    coloredDiff: () => { inProcess.push(['coloredDiff']); return ''; },
    groupMembers: (session, id) => { inProcess.push(['groupMembers', session, id]); return [id]; },
    ...overrides,
  };
  return { core, calls, inProcess };
}
function backendFor(t, overrides) {
  const f = fakeCore(overrides);
  const backend = createBackend({ core: f.core, cwd: '/workspace', session: 's', onDegrade() {} });
  const data = [];
  backend.onData((payload, err, startedAt, session, machine) => data.push({ payload, err, session, machine }));
  t.after(() => backend.close());
  return { ...f, backend, data };
}

test('backend: a session on this machine reads through the warm worker with its argv unchanged', async (t) => {
  const b = backendFor(t);
  b.backend.request(['changemap', 'list'], 's', ['--root', '/w']);
  await tick();
  assert.equal(b.calls.length, 1);
  assert.deepEqual(b.calls[0].args, [self, 'views', '--serve']);
  assert.deepEqual(JSON.parse(b.calls[0].writes[0]), { views: ['changemap', 'list'], args: ['--session', 's', '--root', '/w'] });
  b.calls[0].line({ list: { edits: [] } });
  await tick();
  assert.deepEqual(b.data, [{ payload: { list: { edits: [] } }, err: null, session: 's', machine: undefined }]);
});

test('backend: behind an identical read in flight, a poll is coalesced but a read after a write still runs', async (t) => {
  const b = backendFor(t);
  b.backend.request(['list'], 's');
  await tick();
  b.backend.request(['list'], 's');
  b.backend.request(['list'], 's', [], true);
  b.calls[0].line({ list: {} });
  await tick();
  await tick();
  assert.equal(b.calls[0].writes.length, 2, 'the forced read ran after the one in flight; the plain poll did not');
  b.calls[0].line({ list: {} });
  await tick();
  assert.equal(b.data.length, 2);
});

test('backend: a session on another machine reads there, cold, and says where the payload came from', async (t) => {
  const b = backendFor(t);
  b.backend.request(['changemap', 'list'], 's', ['--root', '/w'], false, 'build-box');
  await tick();
  assert.equal(b.calls.length, 1, 'no warm worker: it reads this machine’s store');
  assert.deepEqual(b.calls[0].args, [self, 'views', '--views', 'changemap,list', '--json', '--session', 's', '--root', '/w', '--machine', 'build-box']);
  b.calls[0].reply({ list: { edits: [{ id: 2 }] } });
  await tick();
  assert.deepEqual(b.data, [{ payload: { list: { edits: [{ id: 2 }] } }, err: null, session: 's', machine: 'build-box' }]);
});

test('backend: an unreachable machine reaches the caller as its named failure, never as an empty payload', async (t) => {
  const b = backendFor(t);
  b.backend.request(['list'], 's', [], false, 'build-box');
  await tick();
  b.calls[0].fail('oak: build-box is not reachable over ssh (builder@build-box.example): Connection refused\n', 255);
  await tick();
  assert.deepEqual(b.data, [{ payload: null, err: 'oak: build-box is not reachable over ssh (builder@build-box.example): Connection refused', session: 's', machine: 'build-box' }]);
});

test('backend: another machine is polled on its own floor, but a switch or a read after a write goes at once', async (t) => {
  const b = backendFor(t);
  const ask = (session = 's', force = false) => b.backend.request(['list'], session, [], force, 'build-box');
  ask();
  await tick();
  b.calls[0].reply({ list: {} });
  await tick();
  ask();
  await tick();
  assert.equal(b.calls.length, 1, 'an unforced repeat inside the floor spawns nothing');
  ask('other');
  await tick();
  assert.equal(b.calls.length, 2, 'a different read is a switch, not a poll');
  // A forced read queued behind one in flight still goes: it follows a write the in-flight read predates.
  ask('other', true);
  await tick();
  assert.equal(b.calls.length, 2, 'queued behind the read in flight');
  b.calls[1].reply({ list: {} });
  await tick();
  assert.equal(b.calls.length, 3, 'the queued forced read ran rather than meeting the floor');
  b.calls[2].reply({ list: {} });
  await tick();
  ask('other', true);
  await tick();
  assert.equal(b.calls.length, 4, 'and a forced read with nothing in flight goes at once');
  b.calls[3].reply({ list: {} });
  await tick();
});

test('backend: decisions on another machine go there, units expanded there, never from this machine’s store', async (t) => {
  const b = backendFor(t);
  const answer = async (i, json) => { await tick(); b.calls[i].reply(json); };
  let done = b.backend.mutate('keep', [5, 9], 's', 'build-box');
  await answer(0, { kept: 3, ids: [4, 5, 9] });
  assert.deepEqual(await done, { ok: true, json: { kept: 3, ids: [4, 5, 9] }, err: null });
  assert.deepEqual(b.calls[0].args, [self, 'keep', '--ids', '5,9', '--units', '--session', 's', '--json', '--machine', 'build-box']);
  done = b.backend.mutate('undo', [5], 's', 'build-box');
  await answer(1, { status: 'undone', ids: [4, 5] });
  await done;
  assert.deepEqual(b.calls[1].args, [self, 'undo', '5', '--session', 's', '--json', '--machine', 'build-box']);
  done = b.backend.mutateUnder('keep', '/remote/work/src', 's', 'build-box');
  await answer(2, { kept: 1, ids: [7] });
  await done;
  assert.deepEqual(b.calls[2].args, [self, 'keep', '--under', '/remote/work/src', '--session', 's', '--json', '--machine', 'build-box']);
  done = b.backend.mutateAll('undo', 's', 'build-box');
  await answer(3, { undone: 0, ids: [] });
  await done;
  assert.deepEqual(b.calls[3].args, [self, 'undo', '--all', '--session', 's', '--json', '--machine', 'build-box']);
  done = b.backend.resolveAll('s', 'build-box');
  await answer(4, { accepted: 0, cleared: 0 });
  await done;
  assert.deepEqual(b.calls[4].args, [self, 'resolve', '--session', 's', '--json', '--machine', 'build-box']);
  done = b.backend.diff(5, 's', 'build-box');
  await answer(5, '@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(await done, '@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual(b.calls[5].args, [self, 'diff', '5', '--patch', '--session', 's', '--machine', 'build-box']);
  done = b.backend.run(['comment', 'add', '--session', 's', '--edit', '5', '--text', 'why', '--json'], 'build-box');
  await answer(6, '{"id":"c1"}');
  assert.equal(await done, '{"id":"c1"}');
  assert.deepEqual(b.calls[6].args.slice(-2), ['--machine', 'build-box']);
  assert.deepEqual(b.inProcess, [], 'nothing was read from this machine’s store');
});

test('backend: decisions on this machine keep their in-process expansion and argv', async (t) => {
  const b = backendFor(t, {
    groupMembers(session, id) { return id === 5 ? [4, 5] : [id]; },
    readLog: () => [{ id: 5 }],
    coloredDiff: () => 'LOCAL PATCH',
  });
  const done = b.backend.mutate('keep', [5, 9], 's');
  await tick();
  b.calls[0].reply({ kept: 3, ids: [4, 5, 9] });
  await done;
  assert.deepEqual(b.calls[0].args, [self, 'keep', '--ids', '4,5,9', '--session', 's', '--json']);
  assert.equal(await b.backend.diff(5, 's'), 'LOCAL PATCH');
  assert.equal(b.calls.length, 1, 'the diff was read in process, as before');
});

test('Observatory mapping: a session belongs to the machine whose herdr pane runs it; this machine wins', () => {
  const pane = (session) => ({ pane_id: `p-${session}`, agent_session: { value: session, agent: 'claude' } });
  // This machine listed LAST: it wins by being this machine, not by coming first.
  const state = { observatory: { details: {}, machines: [
    { id: 'm1', label: 'build-box', snapshot: { panes: [pane('away'), pane('both')] } },
    { id: 'm2', label: 'offline', error: 'ssh unavailable' },
    { id: 'local', label: 'laptop', local: true, snapshot: { panes: [pane('both')] } },
  ] } };
  assert.equal(tui.sessionMachine(state, 'away')?.label, 'build-box');
  assert.equal(tui.sessionMachine(state, 'both')?.local, true);
  assert.equal(tui.sessionMachine(state, 'nowhere'), undefined, 'no pane anywhere: this machine’s by construction');
  assert.equal(tui.sessionMachine({}, 'away'), undefined);
});

test('Review panes: reading from another machine says so, and names its failure; this machine’s wording is unchanged', () => {
  const panes = () => ({ minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {}, sizes: {} });
  const tabs = [
    { id: 'observatory', kind: 'panes', name: 'observatory', panes: panes() },
    { id: 'review', kind: 'panes', name: 'review', panes: panes(), session: 'abc' },
  ];
  const state = (extra) => ({
    views: null, screen: 'edits', cursor: 0, scroll: 0, session: 'abc', sessionTitle: '', filter: '', status: 'ready',
    error: null, confirm: null, now: 0, open: new Set(), marked: new Set(), sort: 'time', syntax: true, keys: {},
    watcherMode: 'native', promptScope: null, overlay: null, goto: null, tabs, activeTab: 1,
    get panes() { return tabs[1].panes; }, set panes(v) {}, ...extra,
  });
  const frame = (s) => tui.renderDashFrame(s, { cols: 100, rows: 30, color: 'none', glyphs: tui.glyphs('ascii') }).map(tui.stripSgr).join('\n');
  const local = frame(state({}));
  assert.match(local, /building…/);
  const reading = frame(state({ reviewMachine: { label: 'build-box' } }));
  assert.match(reading, /reading this session's review from build-box…/);
  assert.doesNotMatch(reading, /building…/);
  const down = frame(state({ reviewMachine: { label: 'build-box', error: 'build-box is not reachable over ssh (builder@build-box.example): Connection refused' } }));
  assert.match(down, /build-box is not reachable over ssh/);
  assert.doesNotMatch(down, /building…|reading this session/);
});

test('reader: a reply delivered to another machine’s pane marks its comments sent THERE, and says why not', async () => {
  const calls = [];
  const core = { spawnTool(command, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ args, child });
    return child;
  } };
  const reader = createConversationReader(core, '/workspace');
  try {
    const marked = reader.markCommentsSent('s', ['c1', 'c2'], 'build-box');
    assert.deepEqual(calls[0].args.slice(1), ['comment', 'mark-sent', '--session', 's', '--ids', 'c1,c2', '--json', '--machine', 'build-box']);
    calls[0].child.stdout.emit('data', Buffer.from('{"marked":2}'));
    calls[0].child.emit('close', 0);
    await marked;
    const refused = reader.markCommentsSent('s', ['c3'], 'build-box');
    calls[1].child.stderr.emit('data', Buffer.from('oak: build-box is not reachable over ssh (builder@build-box.example): timed out'));
    calls[1].child.emit('close', 255);
    await assert.rejects(refused, /build-box is not reachable over ssh/);
  } finally { reader.close(); }
});

test('reader: a saved machine names its own session\'s herdr tab (`__tab-sync` there); an OAK there from before it says so, and one that cannot be reached rejects', async () => {
  const calls = [];
  const core = { spawnTool(command, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ args, child });
    return child;
  } };
  const reader = createConversationReader(core, '/workspace');
  try {
    const synced = reader.syncTab('s', 'build-box');
    assert.deepEqual(calls[0].args.slice(1), ['__tab-sync', 's', '--machine', 'build-box']);
    calls[0].child.emit('close', 0);
    assert.equal(await synced, true, 'it ran there: it prints nothing');
    const old = reader.syncTab('s', 'build-box');
    calls[1].child.stderr.emit('data', Buffer.from('oak: unknown command "__tab-sync". Run `oak help`.\n'));
    calls[1].child.emit('close', 1);
    assert.equal(await old, false, 'an OAK from before the verb');
    const help = reader.syncTab('s', 'build-box');
    calls[2].child.stdout.emit('data', Buffer.from('Legacy OAK: use oak help for supported commands\n'));
    calls[2].child.emit('close', 0);
    assert.equal(await help, false, 'an OAK that answers with anything else did not run it');
    const down = reader.syncTab('s', 'build-box');
    calls[3].child.stderr.emit('data', Buffer.from('oak: build-box is not reachable over ssh (builder@build-box.example): timed out'));
    calls[3].child.emit('close', 255);
    await assert.rejects(down, /build-box is not reachable over ssh/);
    // A name this app recorded giving the tab rides along as one argument, whatever it holds.
    const vouched = reader.syncTab('s', 'build-box', '--Named "here"');
    assert.deepEqual(calls[4].args.slice(1), ['__tab-sync', 's', '--claimed=--Named "here"', '--machine', 'build-box']);
    calls[4].child.emit('close', 0);
    assert.equal(await vouched, true);
    // A machine that holds no herdr pane link for the session cannot name its tab, and says so.
    const unlinked = reader.syncTab('s', 'build-box');
    calls[5].child.stdout.emit('data', Buffer.from('unlinked\n'));
    calls[5].child.emit('close', 0);
    assert.equal(await unlinked, 'unlinked');
  } finally { reader.close(); }
});

test('app: every review read and verb names the machine the session is reviewed on', () => {
  // `runTui` needs a TTY, a store and a backend to construct, so the wiring is pinned at the source:
  // a new call site that forgets the machine would read or revert THIS machine's store instead.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
  const calls = src.match(/backend[!?]?\s*\??\.(?:mutate|mutateUnder|mutateAll|resolveAll|diff|request)\([^;]*/g) ?? [];
  // 8 since the dead blob and full-diff openers went; fewer means the pattern broke.
  assert.ok(calls.length >= 8, `found the call sites (${calls.length})`);
  for (const call of calls) assert.match(call, /reviewMachine\(|, machine\)/, call);
  assert.match(src, /const payload = machine && raw \? \{ \.\.\.raw, sessions: catalog \}/, 'remote metadata never replaces this machine’s catalog');
});

test('backend: the remote throttle expires and scales with slow reads', async t => {
  let now = 100000; t.mock.method(Date, 'now', () => now);
  const b = backendFor(t);
  const ask = force => b.backend.request(['list'], 's', [], force, 'build-box');
  ask(false); await tick(); now += 7000; b.calls[0].reply({ list: {} }); await tick();
  now = 113999; ask(false); await tick(); assert.equal(b.calls.length, 1);
  now = 114000; ask(false); await tick(); assert.equal(b.calls.length, 2, 'twice the seven-second read has elapsed');
  b.calls[1].reply({ list: {} }); await tick();
  now = 114001; ask(true); await tick(); assert.equal(b.calls.length, 3, 'a decision does not wait for the floor');
  b.calls[2].reply({ list: {} }); await tick();
});

test('backend: failed and malformed remote reads never become an empty successful review', async t => {
  const b = backendFor(t);
  for (const [body, code] of [['{"list":', 124], ['{"list":{"edits":[]}}', 124], ['[]', 0]]) {
    b.backend.request(['list'], 's', [], true, 'build-box'); await tick();
    b.calls.at(-1).reply(body, code); await tick();
    assert.equal(b.data.at(-1).payload, null, 'a failed command or invalid envelope cannot paint');
    assert.ok(b.data.at(-1).err);
  }
});

test('backend: remote decisions serialize while the post-write read survives an older poll', async t => {
  const b = backendFor(t);
  b.backend.request(['list'], 's', [], false, 'build-box'); await tick();
  const first = b.backend.mutate('keep', [1], 's', 'build-box');
  const second = b.backend.mutate('undo', [2], 's', 'build-box');
  await tick(); assert.equal(b.calls.length, 2, 'one read and one decision; the second decision queues');
  b.calls[1].reply({ ids: [1], status: 'kept' }); await first; await tick();
  assert.equal(b.calls.length, 3);
  b.calls[2].reply({ ids: [2], status: 'undone' }); await second;
  b.backend.request(['list'], 's', [], true, 'build-box');
  b.calls[0].reply({ list: { edits: [{ id: 1 }] } }); await tick();
  assert.equal(b.calls.length, 4, 'the read begun before both writes cannot absorb their refresh');
  b.calls[3].reply({ list: { edits: [] } }); await tick();
});

// Execute the actual closures with just their dependencies supplied; no TTY, live pane, or store.
/** `out.context` receives the sandbox, so a test can read a binding the part assigned (a flag it cleared). */
function appPart(name, bindings, out = {}) {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/app.ts'), 'utf8');
  const tree = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true);
  let found;
  function visit(n) {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name?.getText(tree) === name) found = n;
    if (name === 'once' && ts.isIfStatement(n) && n.expression.getText(tree) === '!interactive') found = n.thenStatement;
    if (name === 'onData' && ts.isCallExpression(n) && n.expression.getText(tree) === 'backend.onData') found = n.arguments[0];
    ts.forEachChild(n, visit);
  }
  visit(tree); assert.ok(found, name);
  const text = name === 'once' ? 'function once() ' + found.getText(tree) : name === 'onData' ? 'const onData = ' + found.getText(tree)
    : ts.isVariableDeclaration(found) ? 'const ' + found.getText(tree) : found.getText(tree);
  const context = { ...bindings, Buffer, process, console, module: { exports: {} } };
  vm.runInNewContext(ts.transpileModule(text + '; module.exports = ' + name, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  out.context = context;
  return context.module.exports;
}

test('app: remembered remote ownership survives a missing pane, but a local pane wins', () => {
  const sessionMachines = new Map(), state = { observatory: { machines: [] } };
  const reviewMachine = appPart('reviewMachine', { sessionMachines, state, sessionMachine: tui.sessionMachine,
    listedMachine: tui.listedMachine, elsewhere: new Set(), holdsHere: () => true });
  const pane = { agent_session: { value: 's' } };
  state.observatory.machines = [{ label: 'build-box', snapshot: { panes: [pane] } }];
  assert.equal(reviewMachine('s'), 'build-box');
  state.observatory.machines = [];
  assert.equal(reviewMachine('s'), 'build-box', 'ending a pane does not move its store here');
  state.observatory.machines = [{ label: 'new-box', snapshot: { panes: [pane] } }];
  assert.equal(reviewMachine('s'), 'new-box');
  state.observatory.machines.push({ label: 'build-box', local: true, snapshot: { panes: [pane] } });
  assert.equal(reviewMachine('s'), undefined, 'even a local label matching the remembered remote is local');
});

test('app: a late reply from the old machine cannot retarget the same session', () => {
  const state = { session: 's', views: null, reviewMachine: undefined };
  const onData = appPart('onData', { state, localCatalog: undefined,
    reviewMachine: () => undefined, tabs: [{ id: 'review' }], active: 0,
    clampCursor() {}, schedulePaint() {} });
  onData(null, 'old-box failed', 1, 's', 'old-box');
  assert.equal(state.reviewMachine, undefined);
});

test('app: remote folder decisions require an absolute remote workspace', () => {
  const calls = [], state = { session: 's' }; let root = '/remote/work';
  const apply = appPart('applyUnder', { state, path, schedulePaint() {}, reviewMachine: () => 'build-box',
    reviewReady: () => true, view: () => ({ summary: { root } }), reportMutation: () => () => {},
    backend: { mutateUnder(...args) { calls.push(args); return Promise.resolve({}); } } });
  apply('undo', 'src'); assert.equal(calls[0][1], '/remote/work/src');
  root = undefined; apply('undo', 'src');
  assert.equal(calls.length, 1, 'never resolve a folder relative to the remote login home');
  assert.match(state.status, /workspace/);
});

test('app: one-shot review forwards its read and rejects a failed JSON answer', async () => {
  const f = fakeCore();
  const once = appPart('createOnce', { cliJson: appPart('cliJson', {}) });
  const result = once(f.core, '/local', 's', ['list'], 'build-box', '/remote/work');
  assert.deepEqual(Array.from(f.calls[0].args.slice(-4)), ['--root', '/remote/work', '--machine', 'build-box']);
  f.calls[0].reply({ list: {} }, 124);
  await assert.rejects(result, /124/);
});

test('Review metadata comes from its own machine without replacing the local catalog', () => {
  const state = { session: 's', now: 0, views: { sessions: { sessions: [{ id: 'local', title: 'Local' }] } },
    reviewMachine: { label: 'build-box' }, reviewSession: { id: 's', title: 'Remote title', model: 'Remote model' } };
  const data = tui.statuslineDataFor(state);
  assert.equal(data.title, 'Remote title'); assert.equal(data.model, 'Remote model');
  assert.equal(state.views.sessions.sessions[0].id, 'local');
});

test('app: decisions wait for rows from a changed owner and old completions do not alter new rows', () => {
  const state = { session: 's', views: {}, reviewMachine: { label: 'old-box' } }; let asked = 0;
  const ready = appPart('reviewReady', { state, reviewMachine: () => 'new-box', ask: () => { asked++; }, schedulePaint() {} });
  assert.equal(ready(), false); assert.equal(asked, 1);
  let applied = 0;
  const report = appPart('reportMutation', { state, reviewMachine: () => state.reviewMachine?.label,
    ask: () => { asked++; }, schedulePaint() {}, applyLocally: () => { applied++; }, pendingLocal: [] });
  const finish = report('keep', 1);
  state.session = 'other';
  finish({ ok: true, json: { ids: [1], status: 'kept' }, err: null });
  assert.equal(applied, 0, 'record ids from the previous session cannot mark this one kept');
});

test('app: a remote draft arriving after a session switch cannot enter the new composer', async () => {
  const state = { session: 's' }; let answer, opened = 0;
  const run = appPart('runCommand', { state, reviewMachine: () => 'build-box',
    observatorySelection: () => ({ root: '/remote' }), sessionRoot: () => '/remote',
    schedulePaint() {}, backend: { run: () => new Promise(resolve => { answer = resolve; }) },
    openConversation: () => { opened++; }, leafPanes: () => [], tabs: [{}], active: 0,
    copyText() {}, observatoryReply() {} });
  run('quote'); state.session = 'other'; answer(JSON.stringify({ text: 'from the old session' }));
  await tick(); assert.equal(opened, 0);
});

test('app: one-frame Review discovers the owner before reading its views', async () => {
  const state = { panes: { minimized: new Set(), focus: 'traces' }, views: null }, calls = [];
  const local = { sessions: [{ id: 'local' }] }, remote = { sessions: [{ id: 's', title: 'Remote' }] };
  const once = appPart('once', { state, core: { realSessionTitle: (t) => t || null }, cwd: '/local', session: 's', tabs: [{ id: 'review' }], active: 0,
    cols: 80, rows: 30, glyphs: {}, colorDepth: 'none', flag: () => undefined, reviewNewestAnywhere: false,
    viewsForLayoutOf: () => ['list'], resolveLayout: () => ({}), tabLabel: () => 'review',
    sessionMachine: () => ({ label: 'build-box' }), observatorySelection: () => ({ root: '/remote/work' }),
    createObservatory: () => ({ start: async () => { calls.push('discover'); }, close() {} }),
    createOnce: async (_core, _cwd, _session, views, machine, root) => {
      calls.push({ views: Array.from(views), machine, root });
      return machine ? { sessions: remote, list: { edits: [] } } : { sessions: local };
    },
    refreshTabFacts() {}, renderDashFrame: () => [], out: { write() {} } });
  once(); await tick();
  assert.equal(calls[0], 'discover');
  assert.deepEqual(calls[1], { views: ['list', 'sessions'], machine: 'build-box', root: '/remote/work' });
  assert.deepEqual(calls[2].views, ['sessions'], 'the local read supplies only the catalog');
  assert.equal(state.views.sessions, local);
  assert.equal(state.reviewSession.title, 'Remote');
  assert.equal(state.sessionTitle, 'Remote', 'a map without a title is named by its own machine’s catalog');
});

test('app: one-frame Review with nothing named reviews the most recent session on any machine (2026-09-28)', async () => {
  let localRows = [{ id: 'here', lastActiveMs: 100 }];
  const state = { panes: { minimized: new Set(), focus: 'traces' }, views: null, observatory: { machines: [
    { id: 'm', label: 'build-box', sessions: { sessions: [{ id: 'there', title: 'Remote', lastActiveMs: 200 }] } }] } };
  const calls = [];
  const once = appPart('once', { state, core: { realSessionTitle: (t) => t || null }, cwd: '/local', session: 'here', tabs: [{ id: 'review' }], active: 0,
    cols: 80, rows: 30, glyphs: {}, colorDepth: 'none', flag: () => undefined, reviewNewestAnywhere: true, newestAnywhere: tui.newestAnywhere,
    // The Review layout's own views include the catalog, as the real one's do.
    viewsForLayoutOf: () => ['list', 'sessions'], resolveLayout: () => ({}), tabLabel: () => 'review',
    // This machine holds the id too: the machine that listed the adopted session still reads it.
    sessionMachine: () => undefined, listedMachine: tui.listedMachine, elsewhere: new Set(), holdsHere: () => true,
    observatorySelection: () => ({ root: '/remote/work' }),
    createObservatory: () => ({ start: async () => {}, close() {} }),
    createOnce: async (_core, _cwd, session, views, machine, root) => {
      calls.push({ session, views: Array.from(views), machine, root });
      return machine ? { sessions: { sessions: [{ id: 'there', title: 'Remote' }] }, list: { edits: [] } }
        : views.length === 1 && views[0] === 'sessions' ? { sessions: { sessions: localRows } } : { list: { edits: [] } };
    },
    refreshTabFacts() {}, renderDashFrame: () => [], out: { write() {} } });
  once(); await tick();
  assert.deepEqual(calls[0], { session: 'here', views: ['sessions'], machine: undefined, root: undefined }, 'this machine’s own listing first: the bar to clear');
  assert.deepEqual(calls[1], { session: 'there', views: ['list', 'sessions'], machine: 'build-box', root: '/remote/work' });
  assert.equal(state.session, 'there');
  assert.equal(state.reviewSession.title, 'Remote');
  assert.equal(calls.length, 2, 'the frame’s catalog is the listing already read');
  // This machine's own newer session wins too, and is read here.
  state.observatory.machines[0].sessions = { sessions: [] };
  state.session = 'here';
  calls.length = 0;
  localRows = [{ id: 'here', lastActiveMs: 100 }, { id: 'codex-here', lastActiveMs: 300 }];
  once(); await tick();
  assert.deepEqual(calls.map(c => [c.session, c.views, c.machine]), [['here', ['sessions'], undefined], ['codex-here', ['list'], undefined]],
    'the listing already read is the frame’s catalog: not listed twice');
  assert.equal(state.session, 'codex-here');
  assert.equal(state.views.sessions.sessions, localRows);
});

test('app: e refuses a remote path before starting a local editor', () => {
  const state = { session: 's', diffMeta: { path: '/remote/work/file.ts' } }; let spawned = false;
  const open = appPart('openInEditor', { state, reviewMachine: () => 'build-box',
    schedulePaint() {}, rowsOf: () => [],
    selectedPath: () => '', currentRow: () => null, selected: () => null,
    core: { spawnTool() { spawned = true; } }, prefs: { editor: 'fixture-editor' } });
  open();
  assert.equal(spawned, false); assert.match(state.status, /on build-box.*open it there/);
});

test('app: changing review owner clears a pending decision and uses the remote workspace', () => {
  const state = { session: 's', views: {}, reviewMachine: { label: 'old-box' },
    confirm: { verb: 'undo', ids: [7] }, marked: new Set([7]), diffMeta: { id: 7 }, diffPatch: 'old patch' };
  const calls = [];
  const ask = appPart('ask', { state, core: {}, tabs: [{ id: 'review' }], active: 0,
    sessionRoot: () => '/local/copy', viewsForLayoutOf: () => ['list'], layout: () => ({}),
    reviewMachine: () => 'new-box', observatorySelection: () => ({ root: '/new/work' }), pendingLocal: [],
    backend: { request: (...args) => calls.push(args) } });
  ask();
  assert.equal(state.confirm, null, 'old record ids cannot survive in a confirmation on the new owner');
  assert.equal(state.views, null); assert.equal(state.marked.size, 0); assert.equal(state.diffMeta, undefined);
  assert.deepEqual(Array.from(calls[0][2]), ['--root', '/new/work']);
  assert.equal(calls[0][4], 'new-box');
});

test('backend: transport failure after a JSON mutation result stays failed; conflicts keep their result', async t => {
  const b = backendFor(t);
  const writes = [
    () => b.backend.mutate('undo', [1], 's', 'box'),
    () => b.backend.mutate('undo', [1, 2], 's', 'box'),
    () => b.backend.mutateUnder('undo', '/remote', 's', 'box'),
    () => b.backend.mutateAll('undo', 's', 'box'),
    () => b.backend.resolveAll('s', 'box'),
  ];
  for (const write of writes) {
    const result = write(); await tick();
    b.calls.at(-1).reply({ ids: [1], undone: 1 }, 124);
    assert.equal((await result).ok, false, 'no success inferred from output of a failed transport');
  }
  const conflict = b.backend.mutate('undo', [1], 's', 'box'); await tick();
  b.calls.at(-1).reply({ status: 'conflict', message: 'fixture conflict' }, 1);
  assert.equal((await conflict).json.status, 'conflict', 'an ordinary decision refusal remains structured');
});

test('picker rows: this machine first, then every saved machine’s catalog in its own name; a machine not yet answering or unreachable says so', () => {
  const state = { observatory: { details: {}, machines: [
    { id: 'local', label: 'laptop', local: true, sessions: { sessions: [{ id: 'ignored' }] } },
    { id: 'm1', label: 'build-box', sessions: { sessions: [{ id: 'r1', title: 'Remote one', machine: 'this machine', current: true }] } },
    { id: 'm2', label: 'far-box' },
    { id: 'm3', label: 'down-box', sessionsError: 'down-box is not reachable over ssh' },
  ] } };
  const rows = tui.pickerSessionRows(state, [{ id: 'l1', title: 'Local one', machine: 'this machine' }]);
  assert.deepEqual(rows.map((r) => [r.id, r.machine, r.owner]), [
    ['l1', 'this machine', undefined], ['r1', 'build-box', 'build-box'], ['!far-box', 'far-box', 'far-box'], ['!down-box', 'down-box', 'down-box']]);
  assert.match(rows[2].note, /far-box has not answered yet/);
  assert.equal(rows[2].error, undefined);
  assert.match(rows[3].note, /could not list down-box's sessions — down-box is not reachable over ssh/);
  assert.equal(rows[3].error, 'down-box is not reachable over ssh');
  assert.equal(state.observatory.machines[1].sessions.sessions[0].machine, 'this machine', 'the catalog itself is never relabelled in place');
  assert.equal(tui.listedMachine(state, 'r1')?.label, 'build-box');
  assert.equal(tui.listedMachine(state, 'ignored'), undefined, 'this machine’s own listing is not a saved machine’s');
  // herdr's list of saved machines failed: the picker says so rather than showing this machine alone.
  const failed = tui.pickerSessionRows({ observatory: { details: {}, machines: [], machineError: 'herdr is missing; run oak doctor --fix' } }, []);
  assert.deepEqual(failed.map((r) => [r.id, r.note]), [['!machines', 'could not read the saved machines — herdr is missing; run oak doctor --fix']]);
});

test('app: with no pane, a session this machine does not hold is reviewed on the saved machine whose catalog lists it', () => {
  const sessionMachines = new Map(), held = new Set(['both']);
  const state = { observatory: { machines: [{ id: 'm1', label: 'build-box', sessions: { sessions: [{ id: 'away' }, { id: 'both' }, { id: 'picked' }] } }] } };
  const reviewMachine = appPart('reviewMachine', { sessionMachines, state, sessionMachine: tui.sessionMachine, listedMachine: tui.listedMachine,
    elsewhere: new Set(), holdsHere: (id) => held.has(id) });
  assert.equal(reviewMachine('away'), 'build-box');
  assert.equal(reviewMachine('both'), undefined, 'a transcript or store here outranks a listing elsewhere');
  assert.equal(reviewMachine('nowhere'), undefined);
  sessionMachines.set('picked', '');
  assert.equal(reviewMachine('picked'), undefined, 'a row picked from this machine’s list stays here');
  state.observatory.machines = [];
  assert.equal(reviewMachine('away'), 'build-box', 'remembered once found, like a pane');
});

test('app: a launch session held nowhere here is never read here — Review says where it looks, then that no machine lists it', () => {
  const askWith = (searched, machines, owner) => {
    const calls = [];
    const state = { session: 's', views: {}, reviewMachine: undefined, observatory: { machines: [{ id: 'local', label: 'laptop', local: true }, ...machines] } };
    const ask = appPart('ask', { state, core: {}, tabs: [{ id: 'review' }], active: 0, sessionRoot: () => null,
      viewsForLayoutOf: () => ['list'], layout: () => ({}), reviewMachine: () => owner, elsewhere: new Set(['s']), searched,
      nowhere: (id) => `no session "${id}" on this machine or on build-box`, observatorySelection: () => ({ root: '' }),
      pendingLocal: [], schedulePaint() {}, backend: { request: (...args) => calls.push(args) } });
    ask();
    return { state, calls };
  };
  const looking = askWith(false, [{ id: 'm1', label: 'build-box' }]);
  assert.equal(looking.calls.length, 0, 'nothing is read from this machine’s store');
  assert.equal(looking.state.reviewFinding, 'looking for this session on build-box…');
  assert.equal(looking.state.views, null);
  const none = askWith(true, [{ id: 'm1', label: 'build-box', sessions: { sessions: [] } }]);
  assert.equal(none.calls.length, 0);
  assert.equal(none.state.reviewFinding, 'no session "s" on this machine or on build-box');
  const found = askWith(true, [{ id: 'm1', label: 'build-box', sessions: { sessions: [{ id: 's' }] } }], 'build-box');
  assert.equal(found.state.reviewFinding, undefined);
  assert.equal(found.calls[0][4], 'build-box', 'read where its catalog lists it');
  // …and the panes say it, in place of a review.
  const panes = () => ({ minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {}, sizes: {} });
  const tabs = [{ id: 'observatory', kind: 'panes', name: 'observatory', panes: panes() }, { id: 'review', kind: 'panes', name: 'review', panes: panes(), session: 's' }];
  const frame = tui.renderDashFrame({ views: null, screen: 'edits', cursor: 0, scroll: 0, session: 's', sessionTitle: '', filter: '', status: 'ready',
    error: null, confirm: null, now: 0, open: new Set(), marked: new Set(), sort: 'time', syntax: true, keys: {}, watcherMode: 'native',
    promptScope: null, overlay: null, goto: null, tabs, activeTab: 1, reviewFinding: none.state.reviewFinding,
    get panes() { return tabs[1].panes; }, set panes(v) {} }, { cols: 120, rows: 30, color: 'none', glyphs: tui.glyphs('ascii') }).map(tui.stripSgr).join('\n');
  assert.match(frame, /no session "s" on this machine or on build-box/);
  assert.doesNotMatch(frame, /building…/);
});

// switch-forgets: marks and the shown diff stay with the session they were made in.
for (const check of ['picker', 'pin', 'cursor', 'launch', 'launch-newest', 'launch-late-local', 'launch-late-local-review', 'launch-no-local',
  'launch-two-review', 'launch-leave-review', 'launch-r-key', 'launch-mouse-switch', 'launch-resolve-remote', 'launch-enter-quiet', 'launch-feed-quiet', 'launch-local-newest',
  'launch-codex-only', 'launch-listing-fails', 'promptscope-switch', 'hint-legacy-pin', 'hint-resumed', 'hint-codex', 'first-run-root',
  'switch-forgets', 'refresh-remote', 'comment-line']) test(`Review on a saved machine, driven: ${check}`, () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/review-remote-probe.cjs')], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_REVIEW_CHECK: check },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, new RegExp(`PASS: ${check}`));
});

// An app started before an update keeps running the old build, so the notice names the command that starts
// it again (it said `restart dash`). Driven through the same interactive app.
test('the terminal app says how to pick up an updated CLI: restart oak tui', () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/review-remote-probe.cjs')], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_REVIEW_CHECK: 'update-skew' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /PASS: update-skew/);
});

// Reviewing a session whose machine cannot be reached, the header stated `0 pending ✓ 0 kept · 0 high
// risk … 0 conflicts` as facts while every pane named the failure. Counts not in
// hand read as unknown; counts in hand read as numbers, one conflict as one conflict.
test('Review header: counts from views not in hand read as unknown, never zero; one conflict is singular (2026-09-26)', () => {
  const panes = () => ({ minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {}, sizes: {} });
  const tabs = [{ id: 'observatory', kind: 'panes', name: 'observatory', panes: panes() }, { id: 'review', kind: 'panes', name: 'review', panes: panes() }];
  const frame = (views, extra = {}) => tui.renderDashFrame({ views, screen: 'edits', cursor: 0, scroll: 0, session: 'remote-s', sessionTitle: 'Remote work', filter: '', status: 'ready',
    error: null, confirm: null, now: 0, open: new Set(), marked: new Set(), sort: 'time', syntax: true, keys: {}, watcherMode: 'native',
    promptScope: null, overlay: null, goto: null, tabs, activeTab: 1, ...extra,
    get panes() { return tabs[1].panes; }, set panes(v) {} }, { cols: 160, rows: 12, color: 'none', glyphs: tui.glyphs('ascii') }).map(tui.stripSgr).join('\n');
  const unread = frame(null, { reviewMachine: { label: 'far', error: 'far is not reachable over ssh (fixture.invalid)' } });
  assert.doesNotMatch(unread, /\b0 (pending|kept|high risk|conflicts)\b/);
  assert.match(unread, /— pending/);
  const read = frame({ changemap: { summary: { pending: 0, kept: 2 } }, risk: { high: 0, count: 0 }, egress: { remote: 0 }, multitask: { summary: { active: 1, conflicts: 1 } } });
  assert.match(read, /0 pending/, 'control: a zero read from a view is a zero');
  assert.match(read, /2 kept/);
  assert.match(read, /\b1 conflict\b/);
});

test('newest anywhere: any machine’s session, this one’s included, outranks the one Review is on only when more recent (2026-09-28)', () => {
  const machine = (id, label, rows, local = false) => ({ id, label, local, ...(rows ? { sessions: { sessions: rows } } : {}) });
  const state = (...machines) => ({ observatory: { machines } });
  const here = [{ id: 'here', lastActiveMs: 100 }, { id: 'codex-here', lastActiveMs: 500 }];
  const saved = [machine('l', 'this', [{ id: 'mine', lastActiveMs: 999 }], true),
    machine('m1', 'build-box', [{ id: 'older', lastActiveMs: 50 }, { id: 'newer', lastActiveMs: 150 }]),
    machine('m2', 'gpu-box', [{ id: 'newest', lastActiveMs: 180 }]), machine('m3', 'quiet-box')];
  // This machine's own newer session wins, of any agent, and comes without a machine.
  const local = tui.newestAnywhere(state(...saved), here, 'here');
  assert.equal(local.session, 'codex-here');
  assert.equal(local.machine, undefined);
  // A saved machine's newer session wins with its machine; the local machine entry is never a saved one.
  const remote = tui.newestAnywhere(state(...saved), [{ id: 'here', lastActiveMs: 100 }], 'here');
  assert.equal(remote.session, 'newest');
  assert.equal(remote.machine.label, 'gpu-box');
  // Only the listings `candidate` accepts are searched (this machine's is `undefined`), and each can still
  // supply the current session's activity.
  assert.equal(tui.newestAnywhere(state(...saved), here, 'here', m => m !== undefined).session, 'newest');
  assert.equal(tui.newestAnywhere(state(...saved), here, 'here', m => m === undefined).session, 'codex-here');
  assert.equal(tui.newestAnywhere(state(...saved), here, 'here', m => m?.id === 'm1').session, 'newer');
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'there', lastActiveMs: 300 }])), [{ id: 'x', lastActiveMs: 200 }], 'there', m => m === undefined), null,
    'the current session on a saved machine is weighed by its own row even when that machine is not searched');
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'older', lastActiveMs: 50 }])), [{ id: 'here', lastActiveMs: 100 }], 'here'), null);
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'tie', lastActiveMs: 100 }])), [{ id: 'here', lastActiveMs: 100 }], 'here'), null, 'a tie keeps Review where it is');
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: '../escape', lastActiveMs: 999 }])), [{ id: 'here', lastActiveMs: 100 }], 'here'), null, 'an unsafe id is never a session');
  // Activity is the last TURN: a session whose file was touched
  // by a resume just now but took its last turn long ago does not outrank one that took a turn recently.
  const resumed = [{ id: 'here', lastActiveMs: 100 }, { id: 'resumed', lastActiveMs: 9_999, lastTurnMs: 50 }];
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'worked', lastActiveMs: 300, lastTurnMs: 300 }])), resumed, 'here').session, 'worked');
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'old-oak', lastActiveMs: 400 }])), resumed, 'here').session, 'old-oak',
    'a row from an OAK without the turn clock is weighed by its file');
  // A session that never took a turn (`lastTurnMs: null`: opened, never prompted) never wins, however fresh
  // its file, even with no session to beat.
  const fresh = { id: 'fresh', lastActiveMs: 99_999, lastTurnMs: null };
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'worked', lastActiveMs: 300, lastTurnMs: 300 }])), [...resumed, fresh], 'here').session, 'worked');
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [fresh])), [fresh], ''), null);
  // No session here: any listed one. Not weighable yet: this machine's listing is unread and no saved
  // machine lists the session. Read, and the session is not in it: weighed as never active.
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'any', lastActiveMs: 5 }])), undefined, '').session, 'any');
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'x', lastActiveMs: 150 }])), undefined, 'here'), undefined);
  assert.equal(tui.newestAnywhere(state(machine('m1', 'build-box', [{ id: 'x', lastActiveMs: 1 }])), [], 'here').session, 'x');
});

test('app: a launch that named no session moves Review to a saved machine’s newer session, until the reader chooses or acts (2026-09-28)', () => {
  const setup = (over = {}) => {
    const picked = [], out = {};
    const tabs = [{ id: 'observatory' }, { id: 'review', session: 'here' }];
    const state = { observatory: { machines: [{ id: 'l', label: 'this', local: true },
      { id: 'm', label: 'build-box', sessions: { sessions: [{ id: 'there', title: 'Remote work', lastActiveMs: 200 }] } }] } };
    const sessionMachines = new Map();
    const adopt = appPart('adoptNewestAnywhere', { adoptOpen: true, localCatalog: { sessions: [{ id: 'here', lastActiveMs: 100 }] },
      adoptWeighed: new Set(), localWeighed: false, localAwaited: false, state, tabs, active: 0, searched: false, newestAnywhere: tui.newestAnywhere, core: { realSessionTitle: (s) => s },
      choosePicked: (...a) => picked.push(a), sessionMachines, schedulePaint() {}, ...over }, out);
    return { adopt, out, tabs, state, picked, sessionMachines };
  };
  // While this machine's own listing is still awaited (no launch session), nothing is decided.
  let s = setup({ localAwaited: true });
  s.adopt();
  assert.equal(s.tabs[1].session, 'here');
  assert.equal(s.out.context.adoptOpen, true);
  // Beside the Observatory: Review is pointed there, to be read on that machine, and the status says why.
  s = setup();
  s.adopt();
  assert.equal(s.tabs[1].session, 'there');
  assert.equal(s.sessionMachines.get('there'), 'build-box');
  assert.match(s.state.status, /Review is on Remote work on build-box, active more recently/);
  assert.equal(s.out.context.adoptOpen, true, 'open until every saved machine has answered');
  // A machine is weighed once: its refresh never moves Review again; a machine answering later can.
  s.state.observatory.machines[1].sessions.sessions.push({ id: 'there-too', title: 'Remote other', lastActiveMs: 250 });
  s.adopt();
  assert.equal(s.tabs[1].session, 'there', 'no hop on build-box’s refresh');
  s.state.observatory.machines.push({ id: 'n', label: 'gpu-box', sessions: { sessions: [{ id: 'gpu', title: 'GPU work', lastActiveMs: 300 }] } });
  s.adopt();
  assert.equal(s.tabs[1].session, 'gpu');
  // This machine's own newer session wins too, pinned here ('' names this machine), and its listing is weighed
  // once like any machine's: a refresh with a newer local session does not move Review again.
  s = setup({ localCatalog: { sessions: [{ id: 'here', lastActiveMs: 100 }, { id: 'codex-here', title: 'Local codex', lastActiveMs: 500 }] } });
  s.adopt();
  assert.equal(s.tabs[1].session, 'codex-here');
  assert.equal(s.sessionMachines.get('codex-here'), '');
  assert.match(s.state.status, /^Review is on Local codex, active more recently$/);
  s.out.context.localCatalog = { sessions: [{ id: 'here', lastActiveMs: 100 }, { id: 'codex-here', lastActiveMs: 500 }, { id: 'later-here', lastActiveMs: 900 }] };
  s.adopt();
  assert.equal(s.tabs[1].session, 'codex-here', 'no hop on this machine’s refresh');
  // On the Review tab itself: the picker's own switch, with its guards; that switch is not the reader's
  // choice, so a machine answering later may still outrank it.
  // The stand-in closes the window the way choosePicked does, in the part's own sandbox.
  s = setup({ active: 1, choosePicked: (...a) => { s.out.context.adoptOpen = false; s.picked.push(a); } });
  s.adopt();
  assert.deepEqual(s.picked, [['there', 'build-box']]);
  assert.equal(s.out.context.adoptOpen, true);
  // …never under an open overlay or a pending confirmation.
  for (const key of ['overlay', 'confirm']) {
    s = setup({ active: 1 });
    s.state[key] = { title: 'open' };
    s.adopt();
    assert.deepEqual(s.picked, [], key);
    assert.equal(s.tabs[1].session, 'here', key);
  }
  // Closed (a choice, or an act in Review), this machine newer, or its own listing not read yet: nothing moves.
  for (const over of [{ adoptOpen: false }, { localCatalog: { sessions: [{ id: 'here', lastActiveMs: 300 }] } }, { localCatalog: undefined }]) {
    s = setup(over);
    s.adopt();
    assert.equal(s.tabs[1].session, 'here', JSON.stringify(over));
    assert.equal(s.sessionMachines.size, 0, JSON.stringify(over));
  }
  // The first discovery settled and every saved machine answered: decided, and closed…
  s = setup({ searched: true });
  s.adopt();
  assert.equal(s.tabs[1].session, 'there');
  assert.equal(s.out.context.adoptOpen, false);
  // …but not while the session Review is on cannot be weighed (this machine's listing still unread)…
  s = setup({ searched: true, localCatalog: undefined });
  s.adopt();
  assert.equal(s.out.context.adoptOpen, true);
  // …nor while a saved machine has not answered; one that answered with an error has answered.
  s = setup({ searched: true });
  s.state.observatory.machines.push({ id: 'q', label: 'quiet-box' });
  s.adopt();
  assert.equal(s.out.context.adoptOpen, true);
  s = setup({ searched: true });
  s.state.observatory.machines.push({ id: 'd', label: 'down-box', sessionsError: 'not reachable' });
  s.adopt();
  assert.equal(s.out.context.adoptOpen, false);
});

test('app: the Observatory cursor retargets Review, as a pin does', () => {
  const retargeted = [];
  const rows = [{ scope: { session: 'a', machineId: 'l', label: 'A' } }, { scope: { session: 'b', machineId: 'm', label: 'B' } }];
  const bindings = (id) => ({ tabs: [{ id, root: { leaf: true } }], active: 0, state: { scopeWorker: null, treeScroll: {} },
    treeGeom: () => ({ tl: { placements: [{ view: 'sessions-nav', id: 'nav', rect: { w: 40, h: 20 } }] } }),
    treePaneRows: () => rows, glyphs: {}, colorDepth: 'none', schedulePaint() {},
    targetReview: (session, selection) => retargeted.push([session, selection.machineId]) });
  const nav = appPart('navObservatory', bindings('observatory'));
  nav(1);
  nav(1);
  assert.deepEqual(retargeted, [['a', 'l'], ['b', 'm']]);
  // Another tree tab with a session list keeps its own scoping: Review follows the Observatory's cursor.
  retargeted.length = 0;
  appPart('navObservatory', bindings('board'))(1);
  assert.deepEqual(retargeted, []);
});

test('app: choosing what Review shows closes the launch rule; so does a key, paste or click on Review, but not a passing pointer', () => {
  const out = {};
  const target = appPart('targetReview', { tabs: [{ id: 'review' }], state: { observatory: { machines: [] } }, sessionMachines: new Map(), adoptOpen: true }, out);
  assert.equal(target('s'), 0);
  assert.equal(out.context.adoptOpen, false);
  const picked = {};
  const choose = appPart('choosePicked', { state: { session: 's', overlay: null }, OLDER_ROW: '\u0000older', schedulePaint() {}, adoptOpen: true }, picked);
  choose('s');
  assert.equal(picked.context.adoptOpen, false, 'a pick (the picker, the palette, a raised hand) closes it too');
  const settle = (tab, ev, leaderArmed = false) => {
    const o = {};
    const onEvent = appPart('onEvent', { tabs: [{ id: tab }], active: 0, adoptOpen: true, leaderArmed,
      layout: () => ({}), hitTest: (_lay, _col, row) => (row === 0 ? { t: 'tabbar' } : { t: 'body' }) }, o);
    try { onEvent(ev); } catch { /* the rest of the dispatcher is not bound here: the gate at its top ran */ }
    return o.context.adoptOpen;
  };
  assert.equal(settle('review', { t: 'key', key: 'j', ctrl: false, alt: false }), false);
  assert.equal(settle('review', { t: 'paste', text: 'x' }), false);
  assert.equal(settle('review', { t: 'mouse', kind: 'down', row: 3, col: 3 }), false);
  assert.equal(settle('review', { t: 'mouse', kind: 'move', row: 3, col: 3 }), true);
  assert.equal(settle('observatory', { t: 'key', key: 'j', ctrl: false, alt: false }), true);
  // Leaving Review is not acting in it: the leader, the key after it, quit, the tab bar.
  assert.equal(settle('review', { t: 'key', key: 'a', ctrl: true, alt: false }), true);
  assert.equal(settle('review', { t: 'key', key: '2', ctrl: false, alt: false }, true), true);
  assert.equal(settle('review', { t: 'key', key: 'q', ctrl: true, alt: false }), true);
  assert.equal(settle('review', { t: 'mouse', kind: 'down', row: 0, col: 20 }), true);
  assert.equal(settle('review', { t: 'mouse', kind: 'wheel-down', row: 5, col: 20 }), false, 'scrolling the review is acting in it');
  assert.equal(settle('review', { t: 'mouse', kind: 'up', row: 5, col: 20 }), true, 'the release of the click that switched tabs');
  assert.equal(settle('herdr', { t: 'key', key: 'x', ctrl: false, alt: false }), true, 'typing to an agent is not acting in Review');
  // The other tab-switch keys leave it too.
  assert.equal(settle('review', { t: 'key', key: 'n', ctrl: true, alt: false }), true);
  assert.equal(settle('review', { t: 'key', key: 'p', ctrl: true, alt: false }), true);
  assert.equal(settle('review', { t: 'key', key: '2', ctrl: false, alt: true }), true);
});
