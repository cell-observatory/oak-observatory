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

test('reader: with no session to name, this machine\'s listing is read without `--session \'\'`, which the CLI refuses (2026-10-07)', async () => {
  const f = fakeCore();
  const reader = createConversationReader(f.core, '/workspace');
  try {
    const listed = reader.sessions('', '/workspace');
    await tick();
    assert.deepEqual(JSON.parse(f.calls[0].writes[0]), { views: ['sessions'], args: ['--root', '/workspace'] });
    f.calls[0].line({ sessions: { sessions: [{ id: 'a' }] } });
    assert.deepEqual(await listed, { sessions: [{ id: 'a' }] });
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
    // `case:<action>`: one action's case in onKey's verb switch, as a function of no arguments.
    if (name.startsWith('case:') && ts.isCaseClause(n) && n.expression.getText(tree) === `'${name.slice(5)}'`) found = n;
    ts.forEachChild(n, visit);
  }
  visit(tree); assert.ok(found, name);
  const text = name === 'once' ? 'function once() ' + found.getText(tree) : name === 'onData' ? 'const onData = ' + found.getText(tree)
    : ts.isCaseClause(found) ? `function ${name = 'caseAction'}() {${found.statements.map(st => st.getText(tree)).join('\n')}}`
    : ts.isVariableDeclaration(found) ? 'const ' + found.getText(tree) : found.getText(tree);
  const context = { ...bindings, Buffer, process, console, setTimeout, clearTimeout, module: { exports: {} } };
  vm.runInNewContext(ts.transpileModule(text + '; module.exports = ' + name, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  out.context = context;
  return context.module.exports;
}

/** `e`'s openInEditor, with the local launch it hands the file to (launchEditorHere) under the same bindings. */
const editorPart = (bindings) => appPart('openInEditor', { ...bindings, launchEditorHere: appPart('launchEditorHere', bindings) });

test('app: a focus reconnect that fails is tried again, waiting longer each time, and said once', async () => {
  // A reconnect that failed (the focus server it starts not up yet where the store went) was never tried again: focus
  // requests from herdr and `oak focus` went nowhere until the app restarted.
  const down = { client: null, why: 'focus endpoint: not up' };
  const answers = [down, down, down];
  let closed = null, watched = 0;
  const client = { on() {}, onClose(fn) { closed = fn; }, request: async (op) => { if (op.op === 'watch') watched++; return { event: 'ok' }; }, close() {} };
  const state = { status: '' };
  const out = {};
  const connectFocus = appPart('connectFocus', { core: { ensureDaemon: async () => answers.shift() ?? { client } }, state, schedulePaint() {},
    focusClosed: false, focusFailing: false, focusWaitMs: 3000, daemon: null, focusRetry: undefined, FOCUS_RETRY_MS: 3000, FOCUS_RETRY_MAX_MS: 60000,
    reviewSession() {}, switchTab() {}, pinSession() {}, tabs: [] }, out);
  const timers = [];
  out.context.setTimeout = (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; };
  const fire = async () => { timers.shift().fn(); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  await connectFocus();
  assert.equal(state.status, 'focus endpoint: not up', 'the first failure is said');
  state.status = 'something else';
  assert.deepEqual(timers.map((t) => t.ms), [3000], 'and tried again');
  await fire();
  assert.deepEqual(timers.map((t) => t.ms), [6000], 'waiting longer after each failure');
  assert.equal(state.status, 'something else', 'said once, not at every try');
  await fire();
  assert.deepEqual(timers.map((t) => t.ms), [12000]);
  await fire();
  assert.equal(watched, 1, 'connected, it watches for focus requests');
  assert.deepEqual(timers, [], 'with nothing left to try');
  closed();
  assert.deepEqual(timers.map((t) => t.ms), [3000], 'a disconnect after it connected waits the first wait again');
  answers.push(down, down, down, down, down, down);
  await fire();
  assert.equal(state.status, 'focus endpoint: not up', 'a new run of failures is said again');
  const waits = [timers[0].ms];
  for (let i = 0; i < 5; i++) { await fire(); waits.push(timers[0].ms); }
  assert.deepEqual(waits, [3000, 6000, 12000, 24000, 48000, 60000], 'to a minute at most');
  out.context.focusClosed = true;
  await fire();
  assert.deepEqual(timers, [], 'and none once the app closes');
});

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
    reviewReady: () => true, view: () => ({ summary: { root } }), reportMutation: () => () => {}, sayAfter() {},
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
  const once = appPart('once', { state, applyPaneContext() {}, paneContext: Promise.resolve({ nested: false }), core: { realSessionTitle: (t) => t || null }, cwd: '/local', session: 's', tabs: [{ id: 'review' }], active: 0,
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
  const once = appPart('once', { state, applyPaneContext() {}, paneContext: Promise.resolve({ nested: false }), core: { realSessionTitle: (t) => t || null }, cwd: '/local', session: 'here', tabs: [{ id: 'review' }], active: 0,
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

test('app: e on a remote path opens it on that machine, never in a local editor', () => {
  const state = { session: 's', diffMeta: { path: '/remote/work/file.ts' } }; let spawned = false; const there = [];
  const open = appPart('openInEditor', { state, reviewMachine: () => 'build-box',
    schedulePaint() {}, rowsOf: () => [], openOnMachine: (...args) => there.push(args),
    selectedPath: () => '', currentRow: () => null, selected: () => null,
    core: { editorKind: () => 'tty', spawnTool() { spawned = true; } }, prefs: { editor: 'fixture-editor' } });
  open();
  assert.equal(spawned, false);
  assert.deepEqual(there, [['build-box', 'fixture-editor', '/remote/work/file.ts', false]]);
});

test('app: an answer on the status row holds until newer news: a new error or a failed decision', () => {
  const bindings = { session: 's', prefs: {}, keys: () => ({}), once: false, STATUS_HOLD_MS: 5000, statusText: 'ready', inputTurn: false,
    errorText: null, tabs: [], active: 0 };
  const out = {};
  const state = appPart('state', bindings, out);
  const held = () => state.statusUntil > Date.now();
  state.status = 'keeping 1 edit(s)…';
  assert.ok(held(), 'a new status is an answer');
  state.error = 'the machine did not answer';
  assert.equal(held(), false, 'a new error ends it');
  state.status = 'opening a on build-box…';
  state.error = 'the machine did not answer';
  assert.ok(held(), 'the same error again, as each failing read repeats it, does not');
  state.status = 'opening a on build-box…';
  state.statusUntil = 0;
  state.status = 'opening a on build-box…';
  assert.equal(held(), false, 'an unchanged status written by no key is not news');
  out.context.inputTurn = true;
  state.status = 'opening a on build-box…';
  assert.ok(held(), 'but a key that answers the same again is');
  const failed = appPart('actionFailed', { state, STATUS_HOLD_MS: 5000, errorHeldUntil: 0 });
  failed('the machine did not answer');
  assert.equal(held(), false, 'a decision that fails ends it, even with the error already standing');
  assert.equal(state.error, 'the machine did not answer');
  // A read that brings a standing problem clears the error only when it brought none, so the setter never
  // sees null-then-the-same-problem as news (which cut every key's answer short).
  assert.match(fs.readFileSync(path.join(__dirname, '../src/app.ts'), 'utf8'), /if \(!err && Date\.now\(\) >= errorHeldUntil\) state\.error = null;/);
});

test('app: e refuses a machine name two saved machines answer to, as --machine does', async () => {
  const state = {}; let spawned = false;
  const launch = appPart('launchOnMachine', { state, path, cwd: '/', schedulePaint() {}, keyForAction: () => 'o',
    suspendTerminal() {}, resumeTerminal() {},
    core: { remoteEditorKind: () => 'tty', findHerdrBin: () => 'herdr', remoteEditorLaunch: () => ({ command: 'ssh', args: [], kind: 'tty' }),
      herdrMachines: async () => [{ id: 'm1', label: 'build-box', target: 'a@one', enabled: true }, { id: 'build-box', label: 'spare', target: 'b@two', enabled: true }],
      machineSshEnv: () => ({}), spawnTool() { spawned = true; throw new Error('spawned'); } } });
  await launch('build-box', 'nvim', '/w/a', false);
  assert.equal(spawned, false);
  assert.match(state.status, /^could not open a on build-box: ambiguous saved machine "build-box"/);
});

test('app: e opens the focused row, and the diff on screen only from the Diff or a row that names no file', () => {
  const spawned = [];
  const state = { session: 's', cursor: 0, panes: { focus: 'map' }, diffMeta: { path: '/work/shown.ts' } };
  const row = { ids: [], openPath: 'picked.ts' };
  const open = editorPart({ state, reviewMachine: () => undefined, schedulePaint() {}, rowsOf: () => [row], selectedPath: () => '',
    mapRowTarget: (r) => (r.openPath ? { path: `/work/${r.openPath}`, dir: false } : null), suspendTerminal() {}, resumeTerminal() {},
    core: { editorKind: () => 'gui', spawnTool: (cmd, args) => { spawned.push(args.at(-1)); return { on() {}, unref() {} }; } }, prefs: { editor: 'fixture-editor' }, cwd: '/work' });
  open();
  assert.deepEqual(spawned, ['/work/picked.ts'], 'a Map row opens itself while another edit\'s diff is open');
  state.panes.focus = 'detail';
  open();
  assert.equal(spawned.at(-1), '/work/shown.ts', 'the Diff opens the file it shows');
  state.panes.focus = 'prompts';
  row.openPath = undefined;
  open();
  assert.equal(spawned.at(-1), '/work/shown.ts', 'a row that names no file falls back to the diff on screen');
});

// The launcher starts every child's window hidden on Windows (windowsHide), where a console program's window is only noise.
// These open a window on purpose: a GUI editor, an editor run as a terminal one (an editor OAK does not know, such as
// notepad, is run that way and waited on, and hidden it would hold the app), a remote GUI editor and the file manager.
test('app: the editor, a remote GUI editor and the file manager ask for their windows on Windows (windowsHide: false)', async () => {
  const asked = [];
  const spawnTool = (cmd, args, opts) => { asked.push([cmd, opts.windowsHide]); return { on() {}, unref() {} }; };
  const state = { session: 's', cursor: 0, panes: { focus: 'map' } };
  for (const kind of ['gui', 'tty']) {
    editorPart({ state, reviewMachine: () => undefined, schedulePaint() {}, rowsOf: () => [{ ids: [], openPath: 'picked.ts' }],
      selectedPath: () => '', mapRowTarget: (r) => ({ path: `/work/${r.openPath}`, dir: false }), suspendTerminal() {}, resumeTerminal() {},
      core: { editorKind: () => kind, spawnTool }, prefs: { editor: `${kind}-editor` }, cwd: '/work' })();
  }
  const launch = appPart('launchOnMachine', { state, path, cwd: '/', schedulePaint() {}, keyForAction: () => 'o', suspendTerminal() {}, resumeTerminal() {},
    core: { remoteEditorKind: () => 'gui', findHerdrBin: () => 'herdr', machineSshEnv: () => ({}), spawnTool,
      remoteEditorLaunch: () => ({ command: 'code', args: ['--remote', 'ssh-remote+a@one', '/w/a'], kind: 'gui' }),
      herdrMachines: async () => [{ id: 'm1', label: 'build-box', target: 'a@one', enabled: true }] } });
  await launch('build-box', 'code', '/w/a', false);
  appPart('revealStore', { state, schedulePaint() {}, core: { storeDir: () => '/store/s', spawnTool } })('s');
  const fileManager = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  assert.deepEqual(asked, [['gui-editor', false], ['tty-editor', false], ['code', false], [fileManager, false]]);
});

// The reply box stepped and deleted one code point at a time, so the caret could stand inside an emoji built from several:
// the row then drew it on neither side of the caret, and backspace left part of it behind.
test('app: the reply box steps over and deletes a family emoji, a flag or an accented letter whole', () => {
  const core = require('../../core/dist');
  const fam = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
  let reply = { text: '', caret: 0 };
  const key = appPart('replyKey', { state: {}, core, observatoryReply: () => ({ detail: { reply } }), newestConversation() {}, pasteFromClipboard() {},
    observatory: { editReply: (_pane, text, caret) => { reply = { text, caret }; }, focusReply() {}, sendReply() {} } });
  const press = (k) => key('obs-detail', { key: k, ctrl: false, alt: false });
  for (const ch of [fam, '\u{1F1EF}\u{1F1F5}', 'é']) {
    reply = { text: `ab${ch}cd`, caret: 2 + ch.length };
    press('left');
    assert.equal(reply.caret, 2, `left steps over ${JSON.stringify(ch)} whole`);
    press('right');
    assert.equal(reply.caret, 2 + ch.length, 'and right steps back over it');
    press('backspace');
    assert.deepEqual(reply, { text: 'abcd', caret: 2 }, `backspace deletes ${JSON.stringify(ch)} whole`);
    reply = { text: `ab${ch}cd`, caret: 2 };
    press('delete');
    assert.deepEqual(reply, { text: 'abcd', caret: 2 }, 'and so does delete');
  }
  reply = { text: 'ab', caret: 0 };
  press('left');
  assert.equal(reply.caret, 0, 'nothing to the left of the start');
});

// The other text boxes' backspace took one UTF-16 unit, so a pasted emoji lost half of its surrogate pair and a family its
// last member, its joiner left behind. Each now goes through one helper that takes a character whole.
test('app: backspace in the filter, the picker, the palette, the help search, the diff find and an option takes a character whole', () => {
  const backspaced = appPart('backspaced', { core: require('../../core/dist') });
  for (const ch of ['\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u{1F1EF}\u{1F1F5}', '\u{1F600}', 'é', 'x'])
    assert.equal(backspaced(`ab${ch}`), 'ab', `${JSON.stringify(ch)} goes whole`);
  assert.equal(backspaced(''), '', 'nothing to take from an empty box');
  const source = fs.readFileSync(path.join(__dirname, '../src/app.ts'), 'utf8');
  for (const box of ['state.filter', 'pickerFilter', 'paletteFilter', 'helpFilter', 'diffFind', 'cap.buf'])
    assert.ok(source.includes(`${box} = backspaced(${box})`), `${box}'s backspace takes a character whole`);
  assert.doesNotMatch(source, /(\b[\w.]+) = \1\.slice\(0, -1\)/, 'no text box backspaces a UTF-16 unit');
});

// ^V cut a clipboard past its half-MB cap at a UTF-16 index, so the paste could end in half of an emoji's surrogate pair,
// and decoded each read of the clipboard tool apart, so a character whose bytes two reads split came out as U+FFFDs.
test('app: ^V cuts a paste past its cap where a character ends, and decodes a character two reads split', async () => {
  const { PassThrough } = require('node:stream');
  const paste = (chunks) => new Promise((resolve) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    const state = {};
    appPart('pasteFromClipboard', { takesPaste: () => true, state, schedulePaint() {}, keyForAction: () => '/', REMOTE_CLIPBOARD: false,
      PASTE_MAX: 512 * 1024, pastePlan: () => ({ via: 'tools', tools: [['fixture-paste', []]] }), charCount: tui.charCount, StringDecoder: require('node:string_decoder').StringDecoder,
      routePaste: (text) => setImmediate(() => resolve({ text, status: state.status })),
      core: { spawnTool: () => child, graphemeHead: require('../../core/dist').graphemeHead } })();
    for (const c of chunks) child.stdout.write(c);
    child.stdout.end();
    child.stdout.on('end', () => setImmediate(() => child.emit('exit', 0)));
  });
  const MAX = 512 * 1024;
  const big = await paste([Buffer.from(`${'a'.repeat(MAX - 1)}\u{1F600}tail`)]);
  assert.ok(big.text.isWellFormed() && big.text === 'a'.repeat(MAX - 1), `the paste ends before the emoji the cap fell inside: ${JSON.stringify(big.text.slice(-3))}`);
  assert.match(big.status, /pasted the first 512KB/);
  const bytes = Buffer.from('ab\u{1F600}cd');
  const split = await paste([bytes.subarray(0, 3), bytes.subarray(3)]);
  assert.deepEqual(split, { text: 'ab\u{1F600}cd', status: 'pasted 5 chars' }, 'an emoji two reads split arrives whole');
});

test('app: y on the anonymous outside-workspace Map row says why it copies nothing, as e does', () => {
  const copied = [];
  const state = { cursor: 0, panes: { focus: 'map' }, diffMeta: { path: '/work/shown.ts' } };
  let target = { refuse: 'this row is the anonymous outside-workspace bucket (older CLI payload) — it names no real path' };
  const copy = appPart('case:copy', { state, rowsOf: () => [{ openPath: '(outside the workspace)' }], selectedPath: () => '', mapRowTarget: () => target,
    schedulePaint() {}, copyText: (text) => copied.push(text) });
  copy();
  assert.deepEqual(copied, []);
  assert.equal(state.status, target.refuse);
  // Control: a Map row with a path copies it, not the diff on screen.
  target = { path: '/work/picked.ts', dir: false };
  copy();
  assert.deepEqual(copied, ['/work/picked.ts']);
});

test('app: changing review owner clears a pending decision and uses the remote workspace', () => {
  const state = { session: 's', views: {}, reviewMachine: { label: 'old-box' },
    confirm: { verb: 'undo', ids: [7] }, marked: new Set([7]), diffMeta: { id: 7 }, diffPatch: 'old patch' };
  const calls = [];
  const ask = appPart('ask', { state, core: {}, tabs: [{ id: 'review' }], active: 0, readSyncStatus() {},
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
  // A catalog read from this machine's index (that machine's records, as oak sync brought them) says so, with when,
  // before its rows; one read from the machine itself says nothing more.
  const at = Date.UTC(2026, 9, 31, 7, 1);
  const fromRecords = tui.pickerSessionRows({ observatory: { details: {}, machines: [
    { id: 'm1', label: 'build-box', sessions: { sessions: [{ id: 'r1', title: 'Remote one' }], fromIndex: true, syncedAt: at } },
  ] } }, []);
  assert.deepEqual(fromRecords.map((r) => [r.id, r.machine, r.owner, r.note ?? null]), [
    ['!build-box:records', 'build-box', 'build-box', `build-box's sessions as its records hold them, synced ${require('../../core/dist').relTime(at)}`], ['r1', 'build-box', 'build-box', null]]);
});

test('picker scroll: the cursor row is drawn, counted in the lines the frame draws, a wrapped row included', () => {
  const cols = 60, rows = 20, g = tui.glyphs('ascii');
  const lines = Array.from({ length: 40 }, (_, i) => `  row ${i}${i === 5 ? ` ${'long title '.repeat(12)}` : ''}`);
  const state = { views: null, screen: 'edits', cursor: 0, scroll: 0, session: 's', sessionTitle: '', filter: '', status: 'ready', error: null,
    confirm: null, now: 0, open: new Set(), marked: new Set(), sort: 'time', syntax: true, keys: {}, watcherMode: 'native', promptScope: null, goto: null };
  const budget = tui.overlayListRows(state, null, cols, rows, g);
  for (const cursor of [10, 12, 20, 39]) {
    const scroll = tui.overlayScroll(lines, cursor, 0, budget, cols);
    const frame = tui.renderDashFrame({ ...state, overlay: { title: 't', lines, scroll, cursor } }, { cols, rows, color: 'none', glyphs: g })
      .map(tui.stripSgr);
    assert.ok(frame.some((l) => l.startsWith('>') && new RegExp(`row ${cursor}\\b`).test(l)), `row ${cursor} is on screen and marked\n${frame.join('\n')}`);
  }
  // Moving up inside the window keeps it where it is.
  assert.equal(tui.overlayScroll(lines, 30, 25, budget, cols), 25);
  assert.equal(tui.overlayScroll(lines, 3, 25, budget, cols), 3);
});

test('overlay: a key\'s answer shows over a standing error while it holds, as under the panes (2026-10-07)', () => {
  const g = tui.glyphs('ascii');
  const state = { views: null, screen: 'edits', cursor: 0, scroll: 0, session: 's', sessionTitle: '', filter: '', status: 'that session is on build-box',
    error: 'build-box is not reachable over ssh', confirm: null, now: 1000, statusUntil: 6000, open: new Set(), marked: new Set(), sort: 'time', syntax: true,
    keys: {}, watcherMode: 'native', promptScope: null, goto: null, overlay: { title: 'sessions', lines: ['  a row'], scroll: 0, cursor: 0 } };
  const status = (s) => tui.renderDashFrame(s, { cols: 80, rows: 20, color: 'none', glyphs: g }).map(tui.stripSgr).find((l) => /build-box/.test(l)) ?? '';
  assert.match(status(state), /^that session is on build-box/);
  assert.match(status({ ...state, now: 7000 }), /^! build-box is not reachable/, 'the error again once the answer has been read');
});

test('app: a refresh count another machine answers late raises no question over another one, typing, or the herdr tab (2026-10-07)', async () => {
  let answer = null;
  const run = (over = {}) => {
    const state = { confirm: null, overlay: null, session: 's', scopeWorker: null, status: '', ...over.state };
    const asked = [];
    const refresh = appPart('refreshAsking', { state, tabs: over.tabs ?? [{ id: 'review', kind: 'panes', session: 's' }], active: 0,
      reviewMachine: () => 'build-box', backend: { run: () => new Promise((resolve) => { answer = resolve; }) }, core: {},
      ask: (force) => asked.push(force), schedulePaint() {}, keyForAction: () => 'r', options: null, filterOpen: false, diffFindOpen: false,
      markPending: null, claudeAsk: null, focusedReplyPane: () => undefined, ...over.bindings });
    refresh();
    return { state, asked, answer: async (n) => { answer(JSON.stringify({ wouldDrop: n })); await tick(); } };
  };
  // Control: with nothing else up, the count asks.
  let r = run();
  await r.answer(2);
  assert.match(r.state.confirm?.label ?? '', /^drop the 2 recorded edits in s on build-box that \.observatoryignore covers/);
  // A question asked meanwhile stands: a y meant for it dropped the records.
  r = run();
  const keepAll = { verb: 'keep', ids: [1, 2], label: 'every row listed on edits' };
  r.state.confirm = keepAll;
  await r.answer(2);
  assert.equal(r.state.confirm, keepAll);
  const notice = 'refreshed without dropping · .observatoryignore covers 2 recorded edits in s on build-box, kept — r on Review asks to drop them';
  assert.equal(r.state.status, notice);
  assert.deepEqual(r.asked, [true], 'the refresh still reads again');
  // That question holds the status row until it is answered, so its answer says the notice after its own: it was never shown.
  assert.equal(keepAll.after, notice);
  const answerConfirm = appPart('answerConfirm', { state: r.state, schedulePaint() {}, sayAfter: appPart('sayAfter', { state: r.state, schedulePaint() {} }),
    applyAnswer: (q, yes) => { r.state.status = yes ? 'keeping every pending edit…' : 'cancelled'; } });
  answerConfirm(false);
  assert.deepEqual([r.state.confirm, r.state.status], [null, `cancelled · ${notice}`]);
  for (const [what, over] of [
    ['typing into the session picker', { state: { overlay: { title: 'sessions', lines: [] } } }],
    ['typing into the filter', { bindings: { filterOpen: true } }],
    ['typing a find in the diff', { bindings: { diffFindOpen: true } }],
    ['typing a reply', { bindings: { focusedReplyPane: () => 'obs-detail' } }],
    ['on the herdr tab, whose keys are the program\'s', { tabs: [{ id: 'herdr', kind: 'native' }, { id: 'review', kind: 'panes', session: 's' }] }],
  ]) {
    r = run(over);
    await r.answer(1);
    assert.equal(r.state.confirm, null, what);
    assert.match(r.state.status, /covers 1 recorded edit in s on build-box, kept — r on Review asks to drop it$/, what);
  }
});

test('app: a yes that starts work says the notice its question held back after the work\'s result too (2026-10-07)', async () => {
  // The notice of a refresh that dropped nothing (above), held back by a question: a yes that keeps or undoes, resolves or
  // sweeps on another machine starts work whose result replaced the status row, notice and all, before it could be read.
  const notice = 'refreshed without dropping · .observatoryignore covers 2 recorded edits in s on build-box, kept — r on Review asks to drop them';
  const replies = [];
  const later = () => new Promise((resolve) => replies.push(resolve));
  const state = { session: 's', status: '', error: null, confirm: null, views: {}, marked: new Set() };
  const common = { state, schedulePaint() {}, ask() {}, reviewReady: () => true, reviewMachine: () => 'build-box' };
  const sayAfter = appPart('sayAfter', common);
  const reportMutation = appPart('reportMutation', { ...common, applyLocally() {}, pendingLocal: [], actionFailed: (err) => { state.error = err; } });
  const work = { ...common, sayAfter, reportMutation, actionFailed: (err) => { state.error = err; }, path, view: () => ({ summary: { root: '/remote/work' } }),
    backend: { mutateAll: later, mutate: later, mutateUnder: later, run: later, resolveAll: later },
    core: { dropIgnored: () => ({ dropped: 0 }), deleteSession() {}, defaultTuiSession: () => 's', deleteWords: () => require('../../core/dist').deleteWords({ backup: null }) }, tabs: [], cwd: '/', flag: () => undefined, pickerOpen: false };
  const applyAnswer = appPart('applyAnswer', { ...work, applyAll: appPart('applyAll', work), applyMutation: appPart('applyMutation', work), applyResolve: appPart('applyResolve', work),
    applyUnder: appPart('applyUnder', work), applySweep: appPart('applySweep', work), applyDeleteSession: appPart('applyDeleteSession', work) });
  const answerConfirm = appPart('answerConfirm', { ...common, applyAnswer, sayAfter });
  for (const [what, question, reply, said] of [
    ['keep every pending edit', { verb: 'keep', ids: [], all: true }, { ok: true, json: { kept: 2, ids: [1, 2] }, err: null }, 'keep: 2 edit(s)'],
    ['undo the marked edits', { verb: 'undo', ids: [1, 2] }, { ok: true, json: { undone: 2, ids: [1, 2] }, err: null }, 'undo: 2 edit(s)'],
    ['keep everything under src', { verb: 'keep', ids: [], under: 'src' }, { ok: true, json: { kept: 2, ids: [1, 2] }, err: null }, 'keep: 2 edit(s)'],
    ['resolve', { verb: 'resolve', ids: [], session: 's' }, { ok: true, json: { accepted: 1, cleared: 3 }, err: null }, 'resolved: accepted 1 pending, cleared 3 record(s)'],
    ['sweep on build-box', { verb: 'refresh', ids: [], session: 's', machine: 'build-box', pending: 2 }, JSON.stringify({ droppedNow: 2 }), 'refreshing… · dropped 2 now-ignored edits'],
    ['delete', { verb: 'delete', ids: [], session: 'gone', pending: 0 }, null, 'deleted gone and purged its edits — oak sessions --undelete gone lists it again, without them'],
  ]) {
    state.confirm = { ...question, label: what, after: notice };
    answerConfirm(true);
    assert.ok(state.status.endsWith(` · ${notice}`), `${what}: said after the answer (${state.status})`);
    if (reply !== null) { replies.shift()(reply); await tick(); }
    assert.deepEqual([state.status, state.error], [`${said} · ${notice}`, null], `${what}: and after the work's result`);
  }
  assert.equal(replies.length, 0);
  // A failure leaves the status the answer set, notice and all, and says its error: the notice is not said twice.
  state.confirm = { verb: 'keep', ids: [], all: true, label: 'every pending edit', after: notice };
  answerConfirm(true);
  replies.shift()({ ok: false, json: null, err: 'oak: the store is locked' }); await tick();
  assert.deepEqual([state.status, state.error], [`keeping every pending edit… · ${notice}`, 'oak: the store is locked']);
  state.error = null;
  // The reader has moved to another session by the time the work answers: that session's status stands, without the
  // notice about the one the question was on.
  state.confirm = { verb: 'keep', ids: [], all: true, label: 'every pending edit', after: notice };
  answerConfirm(true);
  state.session = 't'; state.status = 'switched to t';
  replies.shift()({ ok: true, json: { kept: 2, ids: [1, 2] }, err: null }); await tick();
  assert.equal(state.status, 'switched to t');
  state.session = 's';
  // Without a held notice the result is said alone.
  state.confirm = { verb: 'keep', ids: [], all: true, label: 'every pending edit' };
  answerConfirm(true);
  replies.shift()({ ok: true, json: { kept: 1, ids: [1] }, err: null }); await tick();
  assert.equal(state.status, 'keep: 1 edit(s)');
});

test('app: a typed command leads the palette, and what else its words find follows it (2026-10-07)', () => {
  const state = {};
  const session = { kind: 'session', label: 'Status page redesign', detail: 'ws', run() {} };
  const status = { kind: 'command', label: 'status', detail: 'hooks, session and edit counts', run() {} };
  const bindings = { state, paletteItems: [session, status], paletteFilter: 'status page', paletteCursor: 0, paletteShown: [],
    isCommand: (name) => name === 'status', runCommand() {}, runConversationSearch() {}, fuzzyMatch: tui.fuzzyMatch, schedulePaint() {} };
  const out = {};
  appPart('renderPalette', bindings, out)();
  // Read through JSON: arrays made inside the sandbox are not this realm's.
  const shown = () => JSON.parse(JSON.stringify(out.context.paletteShown.map((it) => [it.kind, it.label])));
  assert.deepEqual(shown(),
    [['command', 'status page'], ['session', 'Status page redesign'], ['search', 'search conversations for “status page”']]);
  out.context.paletteFilter = 'status';
  out.context.renderPalette();
  assert.deepEqual(shown().filter(([kind]) => kind === 'command'), [['command', 'status']], 'the command is listed once');
});

test('app: with no session to name, the picker lists this machine without `--session \'\'`, which the CLI refuses (2026-10-07)', () => {
  for (const [session, args] of [['', []], ['s', ['--session', 's']]]) {
    const calls = [];
    appPart('readLocalListing', { state: { session }, localListing: {}, backend: { run: (argv) => { calls.push(Array.from(argv)); return new Promise(() => {}); } } })();
    assert.deepEqual(calls, [['views', '--views', 'sessions', '--json', ...args]]);
  }
});

test('app: an overlay\'s last scroll position is measured once per overlay, not on every key (2026-10-07)', () => {
  let measured = 0;
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const state = { overlay: { title: 'help', lines, scroll: 0 } };
  const out = {};
  const move = appPart('move', { state, tabs: [{}], active: 0, frameCols: 80, overlayRows: () => 10, schedulePaint() {}, overlayEnd: null,
    overlayScroll: (...args) => { measured++; return tui.overlayScroll(...args); } }, out);
  for (let i = 0; i < 60; i++) move(1);
  assert.equal(state.overlay.scroll, 40, 'it stops at the last screen');
  assert.equal(measured, 1);
  state.overlay = { title: 'help', lines: lines.slice(0, 20), scroll: 0 };
  move(1);
  assert.equal(measured, 2, 'another overlay is measured again');
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
    const ask = appPart('ask', { state, core: {}, tabs: [{ id: 'review' }], active: 0, readSyncStatus() {}, sessionRoot: () => null,
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
  'launch-codex-only', 'launch-listing-fails', 'promptscope-switch', 'hint-legacy-pin', 'hint-inline-pin', 'hint-resumed', 'hint-codex', 'hint-index', 'first-run-root',
  'switch-forgets', 'refresh-remote', 'refresh-remote-old', 'palette-ignore', 'comment-line']) test(`Review on a saved machine, driven: ${check}`, () => {
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
      choosePicked: (...a) => picked.push(a), sessionMachines, schedulePaint() {}, launchNotice: null, ...over }, out);
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
  // The launch's notice about a saved key keeps the status row, beside the Observatory and over the switch on the
  // Review tab, which says one of its own; once anything replaced it, the move is said.
  for (const active of [0, 1]) {
    s = setup({ active, launchNotice: 'Options (o): choose another key', choosePicked: (...a) => { s.state.status = 'switched to there'; s.picked.push(a); } });
    s.state.status = 'Options (o): choose another key';
    s.adopt();
    assert.equal(s.state.status, 'Options (o): choose another key', `the notice stays (${active ? 'Review' : 'Observatory'} tab)`);
  }
  s = setup({ launchNotice: 'Options (o): choose another key' });
  s.state.status = 'ready';
  s.adopt();
  assert.match(s.state.status, /^Review is on Remote work on build-box, active more recently$/);
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

test('picker search: one search per machine at a time, a newer query waiting; an answer for older text never shows; the limit cut is noted', async () => {
  const runs = [];
  const backend = { run: (args, machine, opts) => new Promise((resolve) => runs.push({ args, machine, opts, resolve })) };
  const pickerText = new Map();
  const state = { confirm: null, observatory: { machines: [{ label: 'workstation', local: true }, { label: 'build-box', local: false }] } };
  const shared = { backend, pickerText, state, pickerOpen: false, renderSessionPicker() {}, AbortController, PICKER_SEARCH_TIMEOUT_MS: 30000, PICKER_SEARCH_LIMIT: 200 };
  const runOut = {};
  const runPickerSearch = appPart('runPickerSearch', { ...shared, pickerFilter: 'ab' }, runOut);
  const search = appPart('searchPickerText', { ...shared, runPickerSearch });
  const answered = appPart('pickerAnswered', { pickerText });
  const query = (r) => r.args.find((a) => a.startsWith('--query='));
  search('ab');
  assert.deepEqual(runs.map((r) => [r.machine, query(r)]), [[undefined, '--query=ab'], ['build-box', '--query=ab']], 'this machine and the saved one, at once');
  assert.ok(runs[0].args.includes('--per-session'));
  assert.equal(runs[0].opts.timeoutMs, 30000);
  search('abc');
  search('abcd');
  assert.equal(runs.length, 2, 'a machine already searching runs nothing more until it answers');
  assert.equal(pickerText.get('').queued, 'abcd', 'the newest text waits, replacing the text that was waiting');
  runOut.context.pickerFilter = 'abcd';
  runs[0].resolve(JSON.stringify({ hits: [{ session: 's1', snippet: 'ab here' }], matched: 1 }));
  await tick();
  assert.deepEqual(runs.slice(2).map((r) => [r.machine, query(r)]), [[undefined, '--query=abcd']], 'then the waiting text runs');
  // The answer for `ab` landed while the box says `abcd`: kept, but never shown under the newer text.
  assert.equal(pickerText.get('').query, 'ab');
  assert.deepEqual(Array.from(answered('abcd'), ([m]) => m), []);
  assert.deepEqual(Array.from(answered('ab'), ([m]) => m), ['']);
  // A build that counts its matches says when the limit cut them; an older one's full answer may have.
  runs[2].resolve(JSON.stringify({ hits: [{ session: 's1', snippet: 'abcd' }], matched: 3 }));
  runs[1].resolve(JSON.stringify({ hits: Array.from({ length: 200 }, (_, i) => ({ session: `r${i}`, snippet: 'ab' })) }));
  await tick();
  assert.equal(pickerText.get('').cut, true);
  assert.equal(pickerText.get('build-box').cut, true);
  assert.equal(pickerText.get('build-box').hits.size, 200);
  search('xyz');
  runs[3].resolve(JSON.stringify({ hits: [{ session: 's1', snippet: 'xyz' }], matched: 1 }));
  runs[4].resolve(JSON.stringify({ hits: [{ session: 'r1', snippet: 'xyz' }] }));
  await tick();
  assert.deepEqual([pickerText.get('').cut, pickerText.get('build-box').cut], [false, false], 'everything that matched is shown');
});

test('picker search: closing the picker clears the typing timer, stops every running search, and drops its late answer', async () => {
  const runs = [];
  const backend = { run: (args, machine, opts) => new Promise((resolve) => runs.push({ args, machine, opts, resolve })) };
  const pickerText = new Map();
  const shared = { backend, pickerText, state: { confirm: null, observatory: { machines: [{ label: 'build-box', local: false }] } }, pickerOpen: false,
    renderSessionPicker() {}, AbortController, PICKER_SEARCH_TIMEOUT_MS: 30000, PICKER_SEARCH_LIMIT: 200, pickerFilter: 'abc' };
  const search = appPart('searchPickerText', { ...shared, runPickerSearch: appPart('runPickerSearch', shared) });
  search('ab');
  search('abc'); // waits behind `ab`
  assert.equal(runs.length, 2);
  let fired = false;
  const out = {};
  const cancel = appPart('cancelPickerSearch', { pickerText, pickerSearchTimer: setTimeout(() => { fired = true; }, 30) }, out);
  cancel();
  assert.ok(runs.every((r) => r.opts.signal.aborted), 'each running search is told to stop');
  assert.equal(pickerText.size, 0);
  assert.equal(out.context.pickerSearchTimer, undefined);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, false, 'a search the typing scheduled never starts');
  runs[0].resolve(JSON.stringify({ hits: [{ session: 's1', snippet: 'ab' }] }));
  await tick();
  assert.equal(pickerText.size, 0, 'an answer that lands after the picker closed is dropped');
  assert.equal(runs.length, 2, '…and the text waiting behind it never runs, beside a reopened picker\'s own search');
  // Every dismissal goes through closeOverlay, and it stops them.
  let cancelled = 0;
  const close = appPart('closeOverlay', { rowMenu: null, jumpRows: null, state: { overlay: { title: 'sessions' }, confirm: null }, pickerFilter: '', helpFilter: null,
    pickerOpen: true, schedulePaint() {}, cancelPickerSearch() { cancelled++; } });
  assert.equal(close(), true);
  assert.equal(cancelled, 1);
  // So does the picker taking itself down when nothing is left to list (its last session deleted).
  const shown = { views: { sessions: { sessions: [] } }, overlay: { title: 'sessions' }, session: 's' };
  const emptied = {};
  appPart('renderSessionPicker', { state: shown, localCatalog: undefined, readLocalListing() {}, pickerSessionRows: () => [], pickerSources: null,
    pickerSourcesNow: () => null, reviewMachine: () => undefined, pickerFilter: 'abc', pickerOpen: true, schedulePaint() {},
    cancelPickerSearch() { cancelled++; } }, emptied)();
  assert.equal(cancelled, 2, 'an empty list closes the picker, and stops its searches');
  assert.deepEqual([emptied.context.pickerOpen, shown.overlay], [false, null]);
});

test("picker search: a hit's excerpt is one line with no ESC, BEL or C1 control characters", () => {
  const saidLine = appPart('saidLine', { wrapVisible: require('../dist/textwidth').wrapVisible });
  const line = saidLine('…the \x1b[31mzebrafish\x1b[0m column\x07 was \x9b2J renamed\x85 here…', 'zebrafish', 80);
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(line));
  assert.doesNotMatch(line, /…/);
  assert.match(line, /zebrafish/);
});

test('app: choosing what Review shows closes the launch rule; so does a key, paste or click on Review, but not a passing pointer', () => {
  const out = {};
  const target = appPart('targetReview', { tabs: [{ id: 'review' }], state: { observatory: { machines: [] } }, sessionMachines: new Map(), adoptOpen: true }, out);
  assert.equal(target('s'), 0);
  assert.equal(out.context.adoptOpen, false);
  const picked = {};
  let cancelled = 0;
  const choose = appPart('choosePicked', { state: { session: 's', overlay: null }, OLDER_ROW: '\u0000older', schedulePaint() {}, adoptOpen: true, cancelPickerSearch() { cancelled++; } }, picked);
  choose('s');
  assert.equal(picked.context.adoptOpen, false, 'a pick (the picker, the palette, a raised hand) closes it too');
  assert.equal(cancelled, 1, "a pick closes the picker, and stops the picker's searches with it");
  const tabKeyOf = appPart('tabKeyOf', { TAB_KEYS: require('../dist').TAB_KEYS });
  const settle = (tab, ev) => {
    const o = {};
    const onEvent = appPart('onEvent', { tabs: [{ id: tab }], active: 0, adoptOpen: true, tabKeyOf,
      layout: () => ({}), hitTest: (_lay, _col, row) => (row === 0 ? { t: 'tabbar' } : { t: 'body' }) }, o);
    try { onEvent(ev); } catch { /* the rest of the dispatcher is not bound here: the gate at its top ran */ }
    return o.context.adoptOpen;
  };
  assert.equal(settle('review', { t: 'key', key: 'j', ctrl: false, alt: false }), false);
  assert.equal(settle('review', { t: 'paste', text: 'x' }), false);
  assert.equal(settle('review', { t: 'mouse', kind: 'down', row: 3, col: 3 }), false);
  assert.equal(settle('review', { t: 'mouse', kind: 'move', row: 3, col: 3 }), true);
  assert.equal(settle('observatory', { t: 'key', key: 'j', ctrl: false, alt: false }), true);
  // Leaving Review is not acting in it: Tab and shift+Tab, quit, the tab bar.
  assert.equal(settle('review', { t: 'key', key: 'tab', ctrl: false, alt: false }), true);
  assert.equal(settle('review', { t: 'key', key: 'backtab', ctrl: false, alt: false }), true);
  assert.equal(settle('review', { t: 'key', key: 'q', ctrl: true, alt: false }), true);
  assert.equal(settle('review', { t: 'mouse', kind: 'down', row: 0, col: 20 }), true);
  assert.equal(settle('review', { t: 'mouse', kind: 'wheel-down', row: 5, col: 20 }), false, 'scrolling the review is acting in it');
  assert.equal(settle('review', { t: 'mouse', kind: 'up', row: 5, col: 20 }), true, 'the release of the click that switched tabs');
  assert.equal(settle('herdr', { t: 'key', key: 'x', ctrl: false, alt: false }), true, 'typing to an agent is not acting in Review');
  // The other tab-switch keys leave it too.
  assert.equal(settle('review', { t: 'key', key: 'n', ctrl: true, alt: false }), true);
  assert.equal(settle('review', { t: 'key', key: 'p', ctrl: true, alt: false }), true);
  assert.equal(settle('review', { t: 'key', key: '2', ctrl: false, alt: true }), true);
  // F1 to F3 are tab keys; with shift F2 is another key, which acts in Review (it says it is no window key).
  for (const key of ['f1', 'f2', 'f3']) assert.equal(settle('review', { t: 'key', key, ctrl: false, alt: false }), true, key);
  assert.equal(settle('review', { t: 'key', key: 'f2', ctrl: false, alt: false, shift: true }), false);
});

{
  // `e` on a session reviewed on a saved machine, pressed in a REAL terminal: the built CLI under node-pty,
  // its output parsed by @xterm/headless. The session's store and file live in a fake remote home that the
  // tests' fake ssh reaches (test/fixtures/machine-exec-stub.sh: it logs its argv, then runs the remote
  // command with sh in that home), and every editor, here and there, records what reached it.
  const { describe, it } = require('node:test');
  const os = require('node:os');
  const cp = require('node:child_process');

  const REPO = path.resolve(__dirname, '../../..');
  const CLI = path.join(REPO, 'packages/cli/dist/index.js');
  let pty = null, Terminal = null;
  try { pty = require('node-pty'); ({ Terminal } = require('@xterm/headless')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const skip = process.platform === 'win32' ? 'the fake ssh and editors are POSIX scripts' : !pty ? 'node-pty is unavailable' : false;

  const E = '\x1b';
  const K = { down: E + '[B', right: E + '[C', enter: '\r', f6: E + '[17~', f7: E + '[18~', pgup: E + '[5~', pgdn: E + '[6~' };
  const COLS = 200, ROWS = 40;
  const SESSION = 'remote-review';
  const TARGET = 'builder@build-box.example';
  // A space and a quote: the path must reach the remote editor as one argument, unexpanded.
  const NAME = "it's my file.txt";

  /** A saved machine, build-box, whose home holds the session (store and transcript) and a remote `nvim`;
   *  this machine has no copy of it, and a PATH of recording editors and the fake ssh and herdr. */
  function fixture(editor) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-editor-remote-')));
    const home = path.join(dir, 'h'), bin = path.join(dir, 'bin'), remote = path.join(dir, 'remote');
    for (const d of [home, bin, path.join(remote, '.local/bin')]) fs.mkdirSync(d, { recursive: true });
    const stub = fs.readFileSync(path.join(REPO, 'test/fixtures/machine-exec-stub.sh'));
    for (const name of ['ssh', 'herdr']) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
    fs.writeFileSync(path.join(remote, '.local/bin/oak'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
    const edLog = path.join(dir, 'editor.log');
    const recorder = (tag) => `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(edLog)}, JSON.stringify([${JSON.stringify(tag)}, ...process.argv.slice(2)]) + '\\n');\n`;
    for (const name of ['nvim', 'code', 'cursor', 'zed']) fs.writeFileSync(path.join(bin, name), recorder(name), { mode: 0o755 });
    fs.writeFileSync(path.join(remote, '.local/bin/nvim'), recorder('remote nvim'), { mode: 0o755 });
    // The remote store: one pending edit to the file, and the Claude transcript its catalog lists the session by.
    const work = path.join(remote, 'work'), file = path.join(work, NAME);
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(file, 'L1\nC\nL3\n');
    const remoteEnv = { HOME: remote, PATH: '/usr/bin:/bin', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
    const seeded = cp.spawnSync(process.execPath, ['-e', `
      const core = require(${JSON.stringify(path.join(REPO, 'packages/core/dist'))});
      const [session, file] = process.argv.slice(1);
      core.ensureStore(session);
      core.appendLog(session, { id: core.nextId(session), ts: Date.now(), tool: 'Edit', file, status: 'pending',
        beforeBlob: core.writeBlob(session, Buffer.from('L1\\nA\\nL3\\n')), afterBlob: core.writeBlob(session, Buffer.from('L1\\nC\\nL3\\n')) });`,
    SESSION, file], { env: remoteEnv, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
    const projects = path.join(remote, '.claude/projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, `${SESSION}.jsonl`), JSON.stringify({ type: 'user', sessionId: SESSION, cwd: work,
      timestamp: new Date().toISOString(), message: { role: 'user', content: 'fix it' } }) + '\n');
    fs.mkdirSync(path.join(home, '.claude/claude-observatory'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/claude-observatory/prefs.json'), JSON.stringify({ editor }));
    const env = { PATH: bin + path.delimiter + process.env.PATH, TERM: 'xterm-256color', HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'),
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(), HERDR_SOCKET_PATH: path.join(dir, 'no.sock'), OAK_NO_SERVER: '1', OAK_NO_BACKGROUND: '1',
      CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', OAK_MACHINE_LABEL: 'workstation', FAKE_REMOTE_HOME: remote, MACHINE_EXEC_LOG: path.join(dir, 'exec.log') };
    return { dir, home, remote, env, file, edLog, execLog: env.MACHINE_EXEC_LOG };
  }

  /** Start the app on the remote session's Review (or on `tab`), press `keys`, and hand back what happened;
   *  `then` runs against the live app before it is closed, and `prep` against the fixture before it starts.
   *  `shell`: started by a shell that outlives it, as from a terminal's prompt, so the app's own exit does not
   *  hang up the terminal and signal what it started. */
  async function drive(editor, keys, then, prep, tab = 'review', shell = false) {
    const fx = fixture(editor);
    prep?.(fx);
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    // `--tick 3600`: no periodic refresh repaints the frame, so every change on screen is one the app scheduled.
    const argv = [CLI, 'tui', '--session', SESSION, '--tab', tab, '--tick', '3600'];
    const child = shell ? pty.spawn('/bin/sh', ['-c', '"$0" "$@"; sleep 30', process.execPath, ...argv], { cols: COLS, rows: ROWS, cwd: fx.home, env: fx.env, name: 'xterm-256color' })
      : pty.spawn(process.execPath, argv, { cols: COLS, rows: ROWS, cwd: fx.home, env: fx.env, name: 'xterm-256color' });
    let raw = '', last = Date.now();
    child.onData((d) => { raw += d; last = Date.now(); term.write(d); });
    const flush = () => new Promise((resolve) => term.write('', resolve));
    const lines = () => { const b = term.buffer.active; return Array.from({ length: ROWS }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true) ?? ''); };
    const settle = async (ms) => { last = Math.max(last, Date.now()); const until = Date.now() + 5000; while (Date.now() - last < ms && Date.now() < until) await new Promise((r) => setTimeout(r, 30)); await flush(); };
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
    try {
      const deadline = Date.now() + 30000;
      const ready = tab === 'review' ? () => lines().join('\n').includes(NAME) && /on build-box/.test(lines().join('\n')) : () => /Sessions/.test(lines().join('\n'));
      while (Date.now() < deadline && !ready()) { await new Promise((r) => setTimeout(r, 50)); await flush(); }
      assert.ok(ready(), `the ${tab} tab painted\n${lines().join('\n')}`);
      await settle(400);
      const at = raw.length;
      // The status row: above the statusline and the key row.
      const status = () => lines()[ROWS - 3];
      // A function among the keys waits (up to 20 s) until it holds for the screen and the status row.
      const press = async (...more) => {
        for (const key of more) {
          if (typeof key === 'function') {
            for (const until = Date.now() + 20000; Date.now() < until && !key(lines().join('\n'), status());) { await new Promise((r) => setTimeout(r, 50)); await flush(); }
          } else { child.write(key); await settle(250); }
        }
        await settle(700);
      };
      // The rows drawn in reverse video: a picker's cursor.
      const marked = () => { const b = term.buffer.active; return Array.from({ length: ROWS }, (_, y) => b.getLine(b.baseY + y))
        .filter((l) => l && Array.from({ length: COLS }, (_, x) => l.getCell(x)).some((c) => c?.isInverse())).map((l) => l.translateToString(true)); };
      await press(...keys);
      if (then) await then({ press, status, lines, marked, child, fx });
      // A GUI editor starts detached and the status row says it ran at once, but its stand-in records its arguments
      // only once its own node is up, which on a loaded runner is after the keys have settled (macOS, 2026-11-09).
      const launched = () => /^(opened |GUI editor ).* — ran /.test(status());
      for (const until = Date.now() + 20000; Date.now() < until && (/^opening /.test(status()) || (launched() && !read(fx.edLog).length));) { await new Promise((r) => setTimeout(r, 50)); await flush(); }
      return { fx, status: status(), after: raw.slice(at), editor: read(fx.edLog).map((l) => JSON.parse(l)),
        ssh: read(fx.execLog).join('\n').split(/^ssh$/m).slice(1).map((s) => s.slice(1, s.indexOf('\n.\n')).split('\n'))
          // The review's own reads go over ssh -T; an editor's session is the one with a terminal.
          .filter((argv) => argv[0] === '-t') };
    } finally {
      child.kill();
      fx.cleanup?.();
      setTimeout(() => fs.rmSync(fx.dir, { recursive: true, force: true }), 200).unref();
    }
  }

  describe('workspace window on a saved machine, in a real PTY', { skip }, () => {
    // The fixture's session is done, so it is listed in build-box's done fold: ↓ picks the fold, → opens it and ↓ picks
    // the session in it (df1 brief: a done session folds even with an edit pending).
    // build-box's rows arrive over ssh after the frame first paints: the keys wait for its fold, and W for its opening.
    const DONE = [(screen) => /▸ \d+ done/.test(screen), K.down, K.right, K.down];
    const W = ['W', (_, status) => !/^opening |Enter pins its conversation/.test(status)];
    it('writes the workspace request only on the saved machine before launching Cursor', async () => {
      const r = await drive('cursor', [...DONE, ...W], null, fx => {
        fx.env.DISPLAY = ':synthetic';
        fs.writeFileSync(path.join(fx.dir, 'bin/cursor'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const requests = home => { const dir = path.join(home, '.claude/editor-review'); return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f)))) : []; };
fs.writeFileSync(${JSON.stringify(fx.edLog)}, JSON.stringify([JSON.stringify(requests(${JSON.stringify(fx.remote)})), JSON.stringify(requests(${JSON.stringify(fx.home)})), ...process.argv.slice(2)]) + '\\n');
`, { mode: 0o755 });
      }, 'observatory');
      assert.equal(r.editor.length, 1, r.status);
      const [remote, local, ...argv] = r.editor[0];
      const requests = JSON.parse(remote);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].action, 'workspace'); assert.equal(requests[0].editor, 'cursor');
      assert.equal(requests[0].session, SESSION); assert.equal(requests[0].workspace, path.dirname(r.fx.file));
      assert.deepEqual(JSON.parse(local), []);
      assert.deepEqual(argv, ['--remote', 'ssh-remote+' + TARGET, path.dirname(r.fx.file) + '/']);
    });
    it('W asks the machine itself for the folder when its listing came from the local index (review 2026-11-05)', async () => {
      // A machine oak sync keeps: its listing here comes from the local index, whose rows carry the `~/…` display path
      // and no workspaceExists, and so does a bare `sessions --json --machine`. Only a read naming the session is asked
      // there. This remote oak answers the Observatory's read and any bare listing the way the index does.
      const r = await drive('cursor', [...DONE, ...W], null, fx => {
        fs.writeFileSync(path.join(fx.remote, '.local/bin/oak'), `#!${process.execPath}
const args = process.argv.slice(2);
const r = require('child_process').spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
let out = r.stdout;
if (args[0] === 'sessions' && args.includes('--json') && (args.includes('--workers') || !args.includes('--session'))) {
  const listing = JSON.parse(out);
  for (const row of listing.sessions || []) { delete row.workspaceExists; if (row.workspacePath) row.workspacePath = '~/work'; }
  out = JSON.stringify(listing);
}
process.stdout.write(out); process.exit(r.status ?? 1);
`, { mode: 0o755 });
        fx.env.DISPLAY = ':synthetic';
      }, 'observatory');
      assert.deepEqual(r.editor, [['cursor', '--remote', 'ssh-remote+' + TARGET, path.dirname(r.fx.file) + '/']], r.status);
    });
    it('W runs one Remote-SSH folder command, with no new-window flag', async () => {
      const r = await drive('cursor', [...DONE, ...W], null, fx => { fx.env.DISPLAY = ':synthetic'; }, 'observatory');
      assert.deepEqual(r.editor, [['cursor', '--remote', 'ssh-remote+' + TARGET, path.dirname(r.fx.file) + '/']]);
      assert.match(r.status, /ran cursor --remote/);
    });
    it('W opens JetBrains Gateway with the resolved SSH connection', async () => {
      const r = await drive('idea', [...DONE, ...W], null, fx => {
        const ide = path.join(fx.remote, '.cache/JetBrains/RemoteDev/dist/synthetic');
        fs.mkdirSync(path.join(ide, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(ide, 'product-info.json'), JSON.stringify({ productCode: 'IC' }));
        fs.writeFileSync(path.join(ide, 'bin/remote-dev-server.sh'), '#!/bin/sh\n');
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        fs.writeFileSync(path.join(fx.dir, 'bin', opener), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const dir = ${JSON.stringify(path.join(fx.remote, '.claude/editor-review'))};
const requests = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f)))) : [];
fs.appendFileSync(${JSON.stringify(fx.edLog)}, JSON.stringify([${JSON.stringify(opener)}, ...process.argv.slice(2), JSON.stringify(requests)]) + '\\n');
`, { mode: 0o755 });
        fx.env.DISPLAY = ':synthetic'; fx.env.SSH_FAKE_G = 'hostname synthetic.example\nuser fixture\nport 2222\n';
      }, 'observatory');
      assert.equal(r.editor.length, 1, r.status);
      assert.match(r.editor[0][1], /^jetbrains-gateway:\/\/connect#idePath=/);
      assert.ok(r.editor[0][1].includes('projectPath=' + encodeURIComponent(path.dirname(r.fx.file))));
      assert.match(r.editor[0][1], /host=synthetic.example&port=2222&user=fixture/);
      const requests = JSON.parse(r.editor[0][2]);
      assert.equal(requests.length, 1); assert.equal(requests[0].action, 'workspace');
      assert.equal(requests[0].editor, 'jetbrains'); assert.equal(requests[0].workspace, path.dirname(r.fx.file));
      assert.equal(requests[0].session, SESSION);
    });
    it('W refuses a session with no recorded workspace', async () => {
      const r = await drive('code', [(screen) => /No workspace/.test(screen), K.down, ...W], null, fx => {
        fs.writeFileSync(path.join(fx.remote, '.local/bin/oak'), `#!/bin/sh
if [ "$1" = sessions ]; then echo '{"sessions":[{"id":"remote-review","title":"No workspace","pending":1}]}'; exit; fi
exec "${process.execPath}" "${CLI}" "$@"
`, { mode: 0o755 });
        fx.env.DISPLAY = ':synthetic';
      }, 'observatory');
      assert.deepEqual(r.editor, []); assert.match(r.status, /no workspace/);
    });
    it('W says when nothing opens the Gateway link (review 2026-11-05)', async () => {
      const r = await drive('idea', [...DONE, ...W, (_, status) => /Could not open the Gateway link/.test(status)], null, fx => {
        const ide = path.join(fx.remote, '.cache/JetBrains/RemoteDev/dist/synthetic');
        fs.mkdirSync(path.join(ide, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(ide, 'product-info.json'), JSON.stringify({ productCode: 'IC' }));
        fs.writeFileSync(path.join(ide, 'bin/remote-dev-server.sh'), '#!/bin/sh\n');
        // An opener with no handler for the link, as xdg-open exits then.
        fs.writeFileSync(path.join(fx.dir, 'bin', process.platform === 'darwin' ? 'open' : 'xdg-open'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
        fx.env.DISPLAY = ':synthetic'; fx.env.SSH_FAKE_G = 'hostname synthetic.example\nuser fixture\nport 2222\n';
      }, 'observatory');
      assert.match(r.status, /^Could not open the Gateway link \(is JetBrains Gateway or Toolbox installed\?\): (?:xdg-)?open 'jetbrains-gateway:/);
    });
    it('W on Review opens the edit at its line there through Remote-SSH, and e runs the terminal editor there', async () => {
      const r = await drive('nvim', ['e'], async ({ press, status }) => {
        for (const until = Date.now() + 10000; Date.now() < until && !/^back from nvim/.test(status());) await new Promise((resolve) => setTimeout(resolve, 50));
        await press(K.down, K.enter, K.f7, 'W');
      }, (fx) => {
        fs.writeFileSync(path.join(fx.home, '.claude/claude-observatory/prefs.json'), JSON.stringify({ editor: 'nvim', guiEditor: 'cursor' }));
        fx.env.DISPLAY = ':synthetic';
      });
      assert.deepEqual(r.editor, [['remote nvim', r.fx.file], ['cursor', '--remote', 'ssh-remote+' + TARGET, '--goto', `${r.fx.file}:2`]]);
      assert.equal(r.ssh.length, 1, 'only e went over ssh -t; cursor connects itself');
      assert.match(r.status, /^GUI editor cursor, from the GUI editor setting — ran cursor --remote ssh-remote\+builder@build-box\.example --goto /);
    });
    it('W on Review opens a JetBrains GUI editor\'s project there through Gateway', async () => {
      const r = await drive('idea', [K.down, K.enter, K.f7, ...W], null, fx => {
        const ide = path.join(fx.remote, '.cache/JetBrains/RemoteDev/dist/synthetic');
        fs.mkdirSync(path.join(ide, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(ide, 'product-info.json'), JSON.stringify({ productCode: 'IC' }));
        fs.writeFileSync(path.join(ide, 'bin/remote-dev-server.sh'), '#!/bin/sh\n');
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        fs.writeFileSync(path.join(fx.dir, 'bin', opener), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(fx.edLog)}, JSON.stringify([${JSON.stringify(opener)}, ...process.argv.slice(2)]) + '\\n');\n`, { mode: 0o755 });
        fx.env.DISPLAY = ':synthetic'; fx.env.SSH_FAKE_G = 'hostname synthetic.example\nuser fixture\nport 2222\n';
      });
      assert.equal(r.editor.length, 1, r.status);
      assert.match(r.editor[0][1], /^jetbrains-gateway:\/\/connect#idePath=/);
      assert.ok(r.editor[0][1].includes('projectPath=' + encodeURIComponent(path.dirname(r.fx.file))));
      assert.match(r.status, /^GUI editor idea, from the terminal editor setting; Gateway opens the project, the edit is at it's my file\.txt:2 — ran (?:xdg-)?open 'jetbrains-gateway:/);
    });
    it('W refuses a removed remote workspace from its listing', async () => {
      const r = await drive('code', [...DONE, ...W], null, fx => { fs.rmSync(path.dirname(fx.file), { recursive: true }); fx.env.DISPLAY = ':synthetic'; }, 'observatory');
      assert.deepEqual(r.editor, []); assert.match(r.status, /workspace folder.*(missing|unavailable)/);
    });
  });

  describe('a failed decision on a saved machine, in a real PTY', { skip }, () => {
    it('names the failure over the answer that started it, and a re-read does not wipe it', async () => {
      // The remote store refuses writes: keep cannot record the decision.
      const store = (fx) => path.join(fx.remote, '.claude/claude-observatory', SESSION);
      const lock = (fx, mode) => { for (const f of fs.readdirSync(store(fx))) if (!fs.statSync(path.join(store(fx), f)).isDirectory()) fs.chmodSync(path.join(store(fx), f), mode & 0o666); fs.chmodSync(store(fx), mode); };
      await drive('nvim', [], async ({ press, status }) => {
        await press(K.down, 'a');
        // A quiet terminal may still be waiting on the remote command.
        for (const until = Date.now() + 15000; Date.now() < until && !/^! oak: EACCES: permission denied/.test(status());) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.match(status(), /^! oak: EACCES: permission denied/, `the failure is on the status row, not "keeping 1 edit(s)…"\n${status()}`);
        const shown = status();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.equal(status(), shown, 'the read the decision forces does not clear its failure');
      }, (fx) => {
        lock(fx, 0o555); fx.cleanup = () => lock(fx, 0o755);
        // Exercise a reply that arrives after the PTY has gone quiet.
        fs.writeFileSync(path.join(fx.remote, '.local/bin/oak'), `#!/bin/sh\n[ "$1" = keep ] && sleep 3\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
      });
    });
  });

  describe('a refresh whose count the saved machine answers late, in a real PTY', { skip }, () => {
    it('leaves a question asked meanwhile standing, so its y keeps the edit rather than dropping it (2026-10-07)', async () => {
      const remoteEdits = (fx) => JSON.parse(cp.execFileSync(process.execPath, [CLI, 'list', '--session', SESSION, '--json'],
        { env: { HOME: fx.remote, PATH: '/usr/bin:/bin', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' }, cwd: path.join(fx.remote, 'work'), encoding: 'utf8' })).edits;
      let edits;
      await drive('nvim', [], async ({ press, status, fx }) => {
        await press('r', 'A');
        assert.match(status(), /keep 1 edit\(s\) — every row listed on edits\?/);
        // The count answers while the keep-all question stands.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.match(status(), /keep 1 edit\(s\) — every row listed on edits\?/, 'the keep-all question still stands');
        await press('y');
        for (const until = Date.now() + 15000; Date.now() < until && !/^keep: 1 edit/.test(status());) await new Promise((resolve) => setTimeout(resolve, 100));
        edits = remoteEdits(fx);
      }, (fx) => {
        fs.writeFileSync(path.join(fx.remote, 'work/.observatoryignore'), '*.txt\n');
        // The saved machine's `oak ignore` (the count, and a sweep) answers after two seconds.
        fs.writeFileSync(path.join(fx.remote, '.local/bin/oak'), `#!/bin/sh\n[ "$1" = ignore ] && sleep 2\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
      });
      assert.deepEqual(edits.map((e) => e.status), ['kept'], 'the y kept the edit; nothing was dropped');
    });
  });

  describe('the session picker and a zoomed Diff, in a real PTY', { skip, concurrency: 3 }, () => {
    // Thirty sessions on this machine fill the picker's first screen; the saved machine's follow them.
    const locals = (fx) => {
      for (let i = 0; i < 30; i++) {
        const id = `local-${String(i).padStart(2, '0')}`, cwd = path.join(fx.home, `w${i}`);
        const dir = path.join(fx.home, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        for (const d of [dir, cwd]) fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, cwd,
          timestamp: new Date().toISOString(), message: { role: 'user', content: `Local filler ${i}` } }) + '\n');
      }
    };
    it('the picker opens with the session in effect on screen and marked, below a screen of this machine\'s sessions', async () => {
      await drive('nvim', ['b'], async ({ lines, marked }) => {
        // A review on another machine reads this machine's listing when the picker first needs it.
        for (const until = Date.now() + 15000; Date.now() < until && !/Local filler/.test(lines().join('\n'));) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 300));
        assert.match(lines().join('\n'), /Local filler/, `this machine's sessions are listed first\n${lines().join('\n')}`);
        assert.ok(marked().some((l) => /fix it\s.*build-box/.test(l)), `the session in effect, on build-box, is drawn and marked\n${lines().join('\n')}`);
      }, locals);
    });
    it('the arrows move the picker\'s selection to its last row and the view follows it there', async () => {
      await drive('nvim', ['b'], async ({ press, lines, marked }) => {
        for (const until = Date.now() + 15000; Date.now() < until && !/Local filler/.test(lines().join('\n'));) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 300));
        // Up to the first row, then down again to the last: the saved machine's session, one row more than a screen
        // below it.
        await press(K.pgup, K.pgup, K.pgup, K.pgup);
        // Under the title, the search box; the rows start below it.
        const first = lines()[lines().findIndex((l) => /^sessions · /.test(l)) + 2];
        assert.match(first, /Local filler/, lines().join('\n'));
        assert.ok(marked().includes(first), `the first row is marked\n${lines().join('\n')}`);
        await press(K.pgdn, K.pgdn, K.pgdn, K.pgdn);
        assert.ok(marked().some((l) => /fix it\s.*build-box/.test(l)), `the last row is drawn and marked\n${lines().join('\n')}`);
        assert.ok(!lines().includes(first), 'the view scrolled to follow it');
      }, locals);
    });
    it('a zoomed Diff saved with the layout is not restored: nothing is picked at launch, and it showed only its hint', async () => {
      await drive('nvim', [], async ({ lines }) => {
        assert.doesNotMatch(lines().join('\n'), /ZOOM/, lines().join('\n'));
        assert.match(lines().join('\n'), /F5 Traces/);
      }, (fx) => fs.writeFileSync(path.join(fx.home, '.claude/claude-observatory/prefs.json'), JSON.stringify({ editor: 'nvim', layout: {
        version: require(path.join(REPO, 'packages/core/dist')).LAYOUT_VERSION, active: 'review',
        tabs: { review: { minimized: ['claude', 'dashboards'], zoom: 'detail', focus: 'detail', sizes: {} } } } })));
    });
    it('switching session from a zoomed edit leaves the zoom with the session it belonged to', async () => {
      await drive('nvim', [K.down, K.enter, K.f7, K.f7], async ({ press, lines }) => {
        assert.match(lines().join('\n'), /ZOOM Diff/, `the edit opened full screen\n${lines().join('\n')}`);
        await press('b');
        for (const until = Date.now() + 15000; Date.now() < until && !/Local filler/.test(lines().join('\n'));) await new Promise((r) => setTimeout(r, 100));
        assert.match(lines().join('\n'), /Local filler/, 'the local listing is ready before choosing a session');
        await press('Local filler 3', K.enter);
        assert.match(lines().join('\n'), /Local filler 3/, lines().join('\n'));
        assert.doesNotMatch(lines().join('\n'), /ZOOM/, lines().join('\n'));
      }, (fx) => {
        locals(fx);
        // A cold listing can take longer than the pauses between keys, especially in the full suite.
        const preload = path.join(fx.dir, 'slow-listing.cjs');
        fs.writeFileSync(preload, `if (process.env.HOME === ${JSON.stringify(fx.home)} && process.argv.includes('--views') && process.argv.includes('sessions'))
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);\n`);
        fx.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
      });
    });
  });

  describe('the session picker\'s search box, on both tabs, in a real PTY', { skip, concurrency: 4 }, () => {
    // This machine: twelve sessions named by their asks, and one whose ask says nothing of what its answer
    // does. The saved machine's session says `quokka` only in its answer.
    const talk = (fx) => {
      const say = (home, id, ask, answer) => {
        const cwd = path.join(home, `w-${id}`);
        const dir = path.join(home, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        for (const d of [dir, cwd]) fs.mkdirSync(d, { recursive: true });
        fs.appendFileSync(path.join(dir, `${id}.jsonl`), [
          { type: 'user', sessionId: id, cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: ask } },
          { type: 'assistant', sessionId: id, cwd, timestamp: new Date().toISOString(), message: { id: `a-${id}`, role: 'assistant', content: [{ type: 'text', text: answer }] } },
        ].map((r) => JSON.stringify(r)).join('\n') + '\n');
      };
      for (let i = 0; i < 12; i++) say(fx.home, `local-${String(i).padStart(2, '0')}`, `Local filler ${i}`, 'Done.');
      say(fx.home, 'local-talk', 'Tidy the parser', 'I renamed the zebrafish column and every reader of it.');
      const work = path.join(fx.remote, 'work');
      const remoteDir = path.join(fx.remote, '.claude/projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.appendFileSync(path.join(remoteDir, `${SESSION}.jsonl`), JSON.stringify({ type: 'assistant', sessionId: SESSION, cwd: work,
        timestamp: new Date().toISOString(), message: { id: 'a-remote', role: 'assistant', content: [{ type: 'text', text: 'The quokka importer is fixed.' }] } }) + '\n');
    };
    /** The picker's own lines: its title, the search box under it, then its rows. */
    const picker = (lines) => { const all = lines(); const at = all.findIndex((l) => /^sessions · /.test(l)); if (at < 0) return null;
      const rows = all.slice(at + 2);
      return { title: all[at], box: all[at + 1], rows: rows.slice(0, Math.max(0, rows.findIndex((l) => !l.trim()))) }; };
    const until = async (lines, re, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end && !re.test(lines().join('\n'));) await new Promise((r) => setTimeout(r, 100)); };
    const searches = (fx) => (fs.existsSync(fx.execLog) ? fs.readFileSync(fx.execLog, 'utf8').match(/oak 'search' '--json' '--query=[^']*'/g) ?? [] : []);
    const open = async (press, lines) => { await press('b'); await until(lines, /Local filler 11/); };
    for (const tab of ['review', 'observatory']) {
      it(`${tab}: the search box shows as the picker opens, and typing narrows the rows by name`, async () => {
        await drive('nvim', [], async ({ press, lines }) => {
          await open(press, lines);
          assert.match(picker(lines).box, /^search ▏ {2}names, and what was said in each session/, lines().join('\n'));
          await press(...'filler 1');
          const p = picker(lines);
          assert.match(p.box, /^search filler 1▏/);
          assert.deepEqual(p.rows.map((l) => /Local filler \d+/.exec(l)?.[0]).sort(), ['Local filler 1', 'Local filler 10', 'Local filler 11'], lines().join('\n'));
        }, talk, tab);
      });
      it(`${tab}: a session that only said the words appears after the pause, with an excerpt; the saved machine's too`, async () => {
        await drive('nvim', [], async ({ press, lines, fx }) => {
          await open(press, lines);
          await press(...'zebrafish');
          await until(lines, /said I renamed the zebrafish/);
          const p = picker(lines);
          assert.equal(p.rows.length, 1, lines().join('\n'));
          assert.match(p.rows[0], /Tidy the parser\s.*said I renamed the zebrafish column/, 'the row is named by its ask, and the excerpt is one line, cut at a word');
          assert.doesNotMatch(p.rows[0], /…/);
          assert.match(p.box, /searching… build-box/, 'the local excerpt arrives while the remote is still searching');
          fs.writeFileSync(path.join(fx.dir, 'release-search'), '');
          await until(lines, /1 more by what was said/);
          assert.match(picker(lines).box, /1 more by what was said/);
          await press(...Array('zebrafish'.length).fill('\x7f'));
          await press(...'quokka');
          await until(lines, /said The quokka importer/);
          assert.match(picker(lines).rows.join('\n'), /fix it\s.*build-box.*said The quokka importer is fixed\./, lines().join('\n'));
          // Typed with a capital: the search ignores case, and the picker shows its answer all the same.
          await press(...Array('quokka'.length).fill('\x7f'));
          await press(...'Zebrafish');
          await until(lines, /said I renamed the zebrafish/);
          assert.match(picker(lines).rows.join('\n'), /Tidy the parser\s.*said I renamed the zebrafish column/, lines().join('\n'));
        }, (fx) => {
          talk(fx);
          const release = path.join(fx.dir, 'release-search');
          fs.writeFileSync(path.join(fx.remote, '.local/bin/oak'), `#!/bin/sh\nif [ "$1" = search ] && [ "$3" = --query=zebrafish ]; then
            while [ ! -f '${release}' ]; do sleep 0.1; done
          fi
          exec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
          fx.cleanup = () => fs.writeFileSync(release, '');
        }, tab);
      });
    }
    it('a fast typist starts one search per machine, for the whole word, and nothing while still typing', async () => {
      await drive('nvim', [], async ({ press, lines, child, fx }) => {
        await open(press, lines);
        for (const ch of 'quokka') { child.write(ch); await new Promise((r) => setTimeout(r, 40)); }
        assert.deepEqual(searches(fx), [], 'nothing was searched while the letters were arriving');
        await until(lines, /said The quokka importer/);
        await new Promise((r) => setTimeout(r, 1500));
        assert.deepEqual(searches(fx), ["oak 'search' '--json' '--query=quokka'"]);
      }, talk);
    });
    it('a saved machine that cannot search says so in the list, as one that cannot list its sessions does', async () => {
      await drive('nvim', [], async ({ press, lines, fx }) => {
        await open(press, lines);
        // The remote's oak is now one with no conversations to search: its search fails with its own message.
        fs.writeFileSync(path.join(fx.remote, '.local/bin/oak'), `#!/bin/sh\n[ "$1" = search ] && { echo 'oak: unknown command "search"' >&2; exit 1; }\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
        await press(...'zebrafish');
        await until(lines, /could not search build-box/);
        assert.match(lines().join('\n'), /! could not search build-box's conversations — unknown command "search"/, lines().join('\n'));
        assert.match(picker(lines).rows.join('\n'), /Tidy the parser/, "this machine's answer still shows");
      }, talk);
    });
    it('a machine with more matches than its answer held says so in the search box', async () => {
      await drive('nvim', [], async ({ press, lines, fx }) => {
        await open(press, lines);
        // The remote's oak answers one session of the seven that matched.
        fs.writeFileSync(path.join(fx.remote, '.local/bin/oak'), `#!/bin/sh\n[ "$1" = search ] && { printf '%s' '{"hits":[{"session":"${SESSION}","snippet":"The quokka importer"}],"matched":7}'; exit 0; }\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
        await press(...'quokka');
        await until(lines, /more matches on build-box/);
        assert.match(picker(lines).box, /more matches on build-box than shown — refine the search/, lines().join('\n'));
      }, talk);
    });
    for (const [how, keys] of [['closing the picker', ['\x1b']], ['quitting OAK', ['\x03', '\x03']]]) {
      it(`${how} stops a search still running on a saved machine, and the ssh it runs`, async () => {
        let pids;
        await drive('nvim', [], async ({ press, lines, child }) => {
          await open(press, lines);
          await press(...'quokka');
          for (const end = Date.now() + 10000; Date.now() < end && !fs.existsSync(pids);) await new Promise((r) => setTimeout(r, 100));
          const [ssh, cli] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number);
          const alive = (pid) => { try { process.kill(pid, 0); } catch { return false; } return !/Z/.test(cp.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout); };
          try {
            assert.ok(alive(ssh) && alive(cli), 'the search is running');
            for (const key of keys) child.write(key);
            for (const end = Date.now() + 5000; Date.now() < end && (alive(ssh) || alive(cli));) await new Promise((r) => setTimeout(r, 100));
            assert.equal(alive(cli), false, 'its CLI is gone');
            assert.equal(alive(ssh), false, 'and so is the ssh that CLI ran');
          } finally {
            for (const pid of [ssh, cli]) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          }
        }, (fx) => {
          talk(fx);
          // The saved machine's search never answers; everything else it does goes through the usual stub.
          pids = path.join(fx.dir, 'search-ssh.pids');
          fs.mkdirSync(path.join(fx.dir, 'real'));
          fs.renameSync(path.join(fx.dir, 'bin', 'ssh'), path.join(fx.dir, 'real', 'ssh'));
          fs.writeFileSync(path.join(fx.dir, 'bin', 'ssh'), `#!/bin/sh\ncase "$*" in *"'search'"*) echo "$$ $PPID" > '${pids}'; exec sleep 30 ;; esac\nexec '${path.join(fx.dir, 'real', 'ssh')}' "$@"\n`, { mode: 0o755 });
        }, 'review', true);
      });
    }
    it('the picker\'s keys still work with the search box: backspace, paste, the arrows, Tab, ^D, Esc and Enter', async () => {
      await drive('nvim', [], async ({ press, lines, marked, status }) => {
        await open(press, lines);
        await press(...'filler 1x', '\x7f');
        assert.match(picker(lines).box, /^search filler 1▏/, 'backspace takes the last letter back');
        const chosen = () => marked().find((l) => /Local filler/.test(l));
        const first = chosen();
        assert.ok(first, lines().join('\n'));
        await press(K.down);
        assert.notEqual(chosen(), first, 'the arrows move the selection');
        await press('\t');
        assert.match(picker(lines).title, /\[working\]/, 'Tab cycles the state');
        await press('\t', '\t', '\t');
        assert.match(picker(lines).title, /\[all\]/);
        await press('\x04');
        assert.match(status(), /\[y\/n\]/, '^D asks to delete the highlighted session');
        await press('n');
        await press('\x1b');
        assert.equal(picker(lines), null, 'Esc closes the picker');
        await press('b', '\x1b[200~filler 7\x1b[201~');
        assert.match(picker(lines).box, /^search filler 7▏/, 'a paste goes into the search box');
        // A pasted family emoji goes with one backspace, whole: one UTF-16 unit left half of it in the box.
        await press('\x1b[200~\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\x1b[201~', '\x7f');
        assert.match(picker(lines).box, /^search filler 7▏/, 'backspace takes a pasted emoji back whole');
        assert.deepEqual(picker(lines).rows.map((l) => /Local filler \d+/.exec(l)?.[0]), ['Local filler 7']);
        await press(K.enter);
        assert.equal(picker(lines), null);
        assert.match(lines().join('\n'), /Local filler 7/, 'Enter opens the session');
      }, talk);
    });
  });

  describe('a --machine run the terminal app gives up on', { skip: process.platform === 'win32' && 'the fake ssh is a POSIX script' }, () => {
    it('stops the CLI it started and the ssh that CLI runs, leaving neither behind', async () => {
      const fx = fixture('nvim');
      const pids = path.join(fx.dir, 'ssh.pids');
      // An ssh whose remote never answers: it records its own pid and its parent's (the CLI), then waits.
      // (`ssh -G`, the configuration read that comes first, answers at once.)
      fs.writeFileSync(path.join(fx.dir, 'bin', 'ssh'), `#!/bin/sh\n[ "$1" = -G ] && exit 0\necho "$$ $PPID" > '${pids}'\nexec sleep 30\n`, { mode: 0o755 });
      const probe = `
        process.argv[1] = ${JSON.stringify(CLI)};
        const core = require(${JSON.stringify(path.join(REPO, 'packages/core/dist'))});
        const { createBackend } = require(${JSON.stringify(path.join(REPO, 'packages/tui/dist/backend.js'))});
        const b = createBackend({ core, cwd: process.env.HOME, session: 'x', onDegrade() {} });
        b.run(['search', '--json', '--query=quokka'], 'build-box', { timeoutMs: 3000 }).then((out) => { console.log(JSON.stringify(out)); b.close(); });`;
      const r = cp.spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, ...fx.env }, cwd: fx.home, encoding: 'utf8', timeout: 20000 });
      const [ssh, cli] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number);
      const alive = (pid) => { try { process.kill(pid, 0); } catch { return false; } return !/Z/.test(cp.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout); };
      try {
        assert.equal(JSON.parse(r.stdout.trim()), 'no answer within 3 s', r.stderr);
        for (const end = Date.now() + 3000; Date.now() < end && (alive(ssh) || alive(cli));) await new Promise((res) => setTimeout(res, 100));
        assert.equal(alive(cli), false, 'the CLI is gone');
        assert.equal(alive(ssh), false, 'and so is its ssh, not left running under init');
      } finally {
        for (const pid of [ssh, cli]) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(fx.dir, { recursive: true, force: true });
      }
    });
  });

  describe('e on a session reviewed on a saved machine, in a real PTY', { skip, concurrency: 3 }, () => {
    it('a terminal editor runs there over ssh -t, the path one argument, and the terminal comes back', async () => {
      const r = await drive('nvim', ['e']); // Traces opens on the file's header
      assert.deepEqual(r.editor, [['remote nvim', r.fx.file]], 'the remote editor got the whole path; the local one never ran');
      assert.equal(r.ssh.length, 1);
      assert.deepEqual(r.ssh[0].slice(0, 2), ['-t', TARGET], 'the ssh target is herdr’s saved machine');
      assert.ok(r.after.includes('\x1b[?1049l'), 'the alternate screen was handed over');
      assert.match(r.status, /^back from nvim on build-box — ran ssh -t builder@build-box\.example /);
    });
    it('a second e while the first is starting is ignored, and e works again once the editor returns', async () => {
      // herdr answers the machine list slowly while `slow` exists, so the second e lands while the first
      // is still waiting for it, as a double press or key autorepeat does.
      let slow;
      const r = await drive('nvim', [], async ({ press }) => {
        fs.writeFileSync(slow, '');
        await press('e', 'e');
        await new Promise((resolve) => setTimeout(resolve, 2500));
        fs.rmSync(slow);
        await press('e');
      }, (fx) => {
        const bin = path.join(fx.dir, 'bin'), real = path.join(fx.dir, 'real');
        slow = path.join(fx.dir, 'slow');
        fs.mkdirSync(real);
        fs.renameSync(path.join(bin, 'herdr'), path.join(real, 'herdr'));
        fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\n[ -e '${slow}' ] && sleep 1\nexec '${path.join(real, 'herdr')}' "$@"\n`, { mode: 0o755 });
      });
      assert.deepEqual(r.editor, [['remote nvim', r.fx.file], ['remote nvim', r.fx.file]], 'one editor for the double press, one for the later e');
      assert.equal(r.ssh.length, 2);
    });
    it('ctrl+c while its ssh -t asks for a passphrase stops that ssh, not the app (2026-10-07)', async () => {
      await drive('nvim', [], async ({ press, lines, status, child }) => {
        let exited = false;
        child.onExit(() => { exited = true; });
        await press('e');
        for (const until = Date.now() + 10000; Date.now() < until && !/Enter passphrase/.test(lines().join('\n'));) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.match(lines().join('\n'), /Enter passphrase/, 'ssh -t has the terminal');
        // The terminal signals the whole job: ssh, and the app that handed it the terminal.
        await press('\x03');
        assert.equal(exited, false, 'the app is still running');
        assert.match(status(), /^nvim on build-box was stopped \(SIGINT\) — ran ssh -t builder@build-box\.example /);
      }, (fx) => {
        // ssh -t (the editor's) asks for a passphrase and waits, as a key with one does; every other ssh is the stub.
        fs.mkdirSync(path.join(fx.dir, 'real'));
        fs.renameSync(path.join(fx.dir, 'bin', 'ssh'), path.join(fx.dir, 'real', 'ssh'));
        fs.writeFileSync(path.join(fx.dir, 'bin', 'ssh'), `#!/bin/sh\nif [ "$1" = -t ]; then printf 'Enter passphrase for key: '; read line; exit 255; fi\nexec '${path.join(fx.dir, 'real', 'ssh')}' "$@"\n`, { mode: 0o755 });
      });
    });
    it('ssh -t carries none of this machine\'s store or agent identity, and asks nothing in a dialog', async () => {
      // SSH_ASKPASS_REQUIRE=force in the environment the app was started with: every ssh it runs is told never.
      const r = await drive('nvim', ['e'], null, (fx) => Object.assign(fx.env, { MACHINE_EXEC_ENV: path.join(fx.dir, 'ssh-env-keys'),
        CLAUDE_CODE_FIXTURE: 'x', CLAUDECODE: '1', CLAUDE_OBSERVATORY_SESSION: SESSION,
        SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS_LOG: path.join(fx.dir, 'ssh-askpass.log') }));
      assert.equal(r.ssh.length, 1);
      assert.equal(fs.readFileSync(r.fx.env.MACHINE_EXEC_ENV, 'utf8'), '', 'no ssh exported CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME, HERDR_SOCKET_PATH or an agent variable');
      const asks = fs.readFileSync(r.fx.env.SSH_ASKPASS_LOG, 'utf8').trim().split('\n');
      const runs = fs.readFileSync(r.fx.execLog, 'utf8').split(/^ssh$/m).length - 1;
      assert.deepEqual(asks.filter((line) => line.startsWith('run ')), Array(runs).fill('run never'), 'every ssh run, the review\'s reads and the editor\'s ssh -t');
      assert.ok(asks.every((line) => line.endsWith(' never')), asks.join('\n'));
    });
    it('code opens it from here through Remote-SSH, from a Map row', async () => {
      const r = await drive('code', [K.f6, K.down, 'e']);
      assert.deepEqual(r.editor, [['code', '--remote', `ssh-remote+${TARGET}`, '--goto', r.fx.file]]);
      assert.deepEqual(r.ssh, [], 'no ssh -t from this side: the editor connects itself');
      assert.match(r.status, /^opened it's my file\.txt on build-box in code — ran code --remote ssh-remote\+builder@build-box\.example --goto /);
    });
    it('cursor opens it the same way, from the Diff pane', async () => {
      const r = await drive('cursor', [K.down, K.enter, K.f7, 'e']);
      assert.deepEqual(r.editor, [['cursor', '--remote', `ssh-remote+${TARGET}`, '--goto', r.fx.file]]);
      assert.match(r.status, /^opened it's my file\.txt on build-box in cursor/);
    });
    it('another GUI editor refuses and names what works', async () => {
      const r = await drive('zed', ['e']);
      assert.deepEqual(r.editor, []);
      assert.deepEqual(r.ssh, []);
      assert.match(r.status, /^zed cannot open a file on build-box — a terminal editor such as nvim, vim or hx runs there over ssh, and code or cursor open it through Remote-SSH/);
    });
    it('the answer shows on a zoomed Diff, whose edit bar stood on the status row, and the bar returns after', async () => {
      await drive('zed', [K.down, K.enter, K.f7, K.f7], async ({ press, status }) => {
        assert.match(status(), /^Diff full screen — esc back/, 'zooming says so; the edit bar stands on the row once that is read');
        await press('e');
        assert.match(status(), /^zed cannot open a file on build-box/, 'the answer is on screen, not under the bar');
        await new Promise((resolve) => setTimeout(resolve, 5500));
        assert.match(status(), /^edit #1 · /, 'the bar comes back once the answer has been read');
        // The same key, the same answer: a key's answer holds again even when its text has not changed.
        await press('e');
        assert.match(status(), /^zed cannot open a file on build-box/, 'a repeated answer is shown again');
      });
    });
  });
}
