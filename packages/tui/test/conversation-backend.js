const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createConversationReader, createServeWorker } = require('../dist/backend');
const { createObservatory } = require('../dist/observatory-runtime');
/** A fake CLI. Each cold read is one recorded child in `calls`. The warm `views --serve` worker is kept
 *  apart in `served`: without `warm` it cannot take requests (no stdin), so every read runs cold, which is
 *  what these tests pin; with `warm`, each request line it gets is recorded and answered by the test. */
function transport({ warm = false } = {}) {
  const calls = [], served = [], workers = [];
  const core = { spawnTool(command, args, options) {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('close', null); };
    if (args[1] === 'views' && args[2] === '--serve') {
      child.exitCode = null; child.pid = 4000 + workers.length; workers.push(child);
      if (warm) child.stdin = { writable: true, on() {}, write(line) {
        const request = JSON.parse(line);
        served.push({ ...request, answer(views) { child.stdout.emit('data', Buffer.from(JSON.stringify(views) + '\n')); } });
        return true;
      } };
      return child;
    }
    calls.push({ command, args, options, child, reply(value) { child.stdout.emit('data', Buffer.from(JSON.stringify(value))); child.emit('close', 0); } });
    return child;
  } };
  return { core, calls, served, workers };
}
/** A read of this machine tries the warm worker first, so its cold child exists a turn later. */
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime(t) {
  const { core, calls } = transport();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-runtime-perf-'));
  const file = path.join(dir, 'transcript.jsonl'); fs.writeFileSync(file, 'initial\n');
  const detail = { selection: { session: 'first', root: dir }, events: [], previews: {}, cursor: null, loading: true };
  const state = { session: 'first', views: {}, observatory: { machines: [], details: { detail } } };
  let paints = 0;
  const app = createObservatory({ ...core, findHerdrBin: () => null,
    conversationEvents() { throw new Error('main-thread full read'); }, conversationTail() { throw new Error('main-thread tail'); },
  }, state, { cwd: dir, watch: false, timers: false, changed() { paints++; }, status() {} });
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const payload = { events: [], cursor: 8, turns: 0, agent: 'claude', transcriptPath: file };
  return { state, app, calls, payload, file, paints: () => paints };
}

test('conversation backend: CLI arguments isolate initial and incremental reads and preserve split UTF-8 JSON', async () => {
  const { core, calls } = transport(); const reader = createConversationReader(core, '/workspace');
  try {
    const initial = reader.read('session', '/workspace'); await tick();
    assert.deepEqual(calls[0].args.slice(1), ['conversation', '--json', '--session', 'session', '--root', '/workspace', '--limit', '50']);
    const payload = { events: [{ text: '猫😀' }], cursor: 123 };
    const bytes = Buffer.from(JSON.stringify(payload)); const split = bytes.indexOf(Buffer.from('😀')) + 2;
    calls[0].child.stdout.emit('data', bytes.subarray(0, split)); calls[0].child.stdout.emit('data', bytes.subarray(split)); calls[0].child.emit('close', 0);
    assert.deepEqual(await initial, payload);
    const next = reader.read('session', '/workspace', 123); await tick();
    assert.deepEqual(calls[1].args.slice(-2), ['--since', '123']); calls[1].reply({ events: [], cursor: 123 }); await next;
  } finally { reader.close(); }
});

test('conversation runtime: a slow switch paints loading, coalesces reads and discards obsolete answers', async t => {
  const f = runtime(t);
  const first = f.app.load('detail'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.state.observatory.details.detail.loading, true);
  assert.ok(f.paints() > 0);
  assert.strictEqual(f.app.load('detail'), first);
  let ticked = false; await new Promise(resolve => setTimeout(() => { ticked = true; resolve(); }, 10)); assert.equal(ticked, true);
  f.state.observatory.details.detail = { ...f.state.observatory.details.detail, selection: { session: 'second', root: '/workspace' } };
  const second = f.app.load('detail'); await tick(); assert.equal(f.calls.length, 2);
  f.calls[0].reply(f.payload); await first; assert.equal(f.state.observatory.details.detail.loading, true);
  f.calls[1].reply({ ...f.payload, transcriptPath: null }); await second;
  assert.equal(f.state.observatory.details.detail.loading, false);
  assert.equal(f.state.observatory.details.detail.selection.session, 'second');
});

test('conversation runtime: a delayed tail preserves reply edits and polls only once', async t => {
  const f = runtime(t); const load = f.app.load('detail'); await tick(); f.calls[0].reply(f.payload); await load; await tick();
  // Settle enrichment separately from the conversation read.
  f.calls[1].reply({ agents: [{ session: 'first', todos: [], subagents: [] }] });
  fs.appendFileSync(f.file, 'append\n');
  const tail = f.app.tail(); await tick(); const call = f.calls.at(-1);
  assert.deepEqual(call.args.slice(-2), ['--since', '8']);
  const count = f.calls.length; await f.app.tail(); assert.equal(f.calls.length, count);
  f.state.observatory.details.detail = { ...f.state.observatory.details.detail, reply: { text: 'typed while reading', caret: 19 } };
  call.reply({ ...f.payload, cursor: 15, events: [{ ts: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } }] });
  await tail;
  assert.equal(f.state.observatory.details.detail.reply.text, 'typed while reading');
  assert.equal(f.state.observatory.details.detail.events.length, 1);
});

test('conversation backend: errors leave loading and close kills pending children', async t => {
  const f = runtime(t); const load = f.app.load('detail'); await tick();
  f.calls[0].child.stderr.emit('data', Buffer.from('cannot read transcript')); f.calls[0].child.emit('close', 1);
  await load; assert.equal(f.state.observatory.details.detail.loading, false);
  assert.match(f.state.observatory.details.detail.error, /cannot read transcript/);
  const pending = f.app.load('detail'); await tick(); f.app.close(); await pending;
  assert.equal(f.calls[1].child.killed, true);
});

test('remote conversation reader forwards conversation, metadata, previews and workers; local argv is unchanged', async () => {
  const { core, calls } = transport(), reader = createConversationReader(core, '/local');
  try {
    const payload = { events: [{ text: 'remote' }], cursor: 123, source: 'fixture-token' };
    for (const since of [undefined, 123]) {
      const result = reader.read('fixture-session', '/remote', since, 'build-box', since === undefined ? undefined : 'fixture-token');
      result.catch(() => {}); // keep a failing argv assertion from leaving an unhandled pending read
      const call = calls.at(-1);
      assert.deepEqual(call.args.slice(1), ['conversation', '--json', '--session', 'fixture-session', '--root', '/remote',
        ...(since === undefined ? ['--limit', '50'] : ['--since', '123']), '--with-source', ...(since === undefined ? [] : ['--source', 'fixture-token']), '--machine', 'build-box']);
      assert.equal(call.options.env.OAK_MACHINE_TIMEOUT_MS, '45000');
      call.reply(payload); assert.deepEqual(await result, payload);
    }
    const sessions = reader.sessions('fixture-session', '/remote', 'build-box');
    assert.deepEqual(calls.at(-1).args.slice(1), ['sessions', '--json', '--session', 'fixture-session', '--root', '/remote', '--machine', 'build-box']);
    calls.at(-1).reply({ sessions: [{ id: 'fixture-session', title: 'Remote title' }] });
    assert.equal((await sessions).sessions[0].title, 'Remote title');
    const diff = reader.diff('fixture-session', 7, 'build-box');
    assert.deepEqual(calls.at(-1).args.slice(1), ['diff', '7', '--patch', '--session', 'fixture-session', '--machine', 'build-box']);
    calls.at(-1).child.stdout.emit('data', Buffer.from('+remote\n')); calls.at(-1).child.emit('close', 0); assert.equal(await diff, '+remote\n');
    const fleet = reader.fleet('fixture-session', '/remote', 'build-box');
    assert.equal(calls.at(-1).args[1], 'multitask'); assert.deepEqual(calls.at(-1).args.slice(-2), ['--machine', 'build-box']);
    calls.at(-1).reply({ agents: [] }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1).args[1], 'subagents'); assert.deepEqual(calls.at(-1).args.slice(-2), ['--machine', 'build-box']);
    calls.at(-1).reply({ subagents: [{ agentId: 'worker' }] }); assert.equal((await fleet).subagents[0].agentId, 'worker');
    const local = reader.sessions('fixture-session', '/local'); await tick();
    assert.deepEqual(calls.at(-1).args.slice(1), ['views', '--views', 'sessions', '--json', '--session', 'fixture-session', '--root', '/local']);
    calls.at(-1).reply({ sessions: { sessions: [] } }); await local;
    const unchanged = reader.read('fixture-session', '/local'); await tick();
    assert.deepEqual(calls.at(-1).args.slice(1), ['conversation', '--json', '--session', 'fixture-session', '--root', '/local', '--limit', '50']);
    calls.at(-1).reply(payload); assert.equal(JSON.stringify(await unchanged), JSON.stringify(payload), 'local payload is byte-identical');
  } finally { reader.close(); }
});

// A pinned, working session read its conversation, previews, workers and the session list with a cold
// `oak` start each: 180+ processes and over a core a minute. This machine's reads go
// through ONE warm worker now; a view it could not build is asked of a cold child, whose error is the one
// reported; another machine's reads never reach it.
test('conversation reader: this machine\'s reads ride one warm worker; a view it cannot build falls back cold', async () => {
  const { core, calls, served } = transport({ warm: true });
  const reader = createConversationReader(core, '/local');
  try {
    const first = reader.read('fixture-session', '/local'); await tick();
    assert.deepEqual(served.map(r => [r.views, r.args]), [[['conversation'], ['--session', 'fixture-session', '--root', '/local', '--limit', '50']]]);
    const payload = { events: [{ ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'warm' } } }], cursor: 9, transcriptPath: '/t' };
    served[0].answer({ conversation: payload });
    assert.deepEqual(await first, payload);
    const tail = reader.read('fixture-session', '/local', 9); await tick();
    assert.deepEqual(served[1].args.slice(-2), ['--since', '9']); served[1].answer({ conversation: { events: [], cursor: 9 } }); await tail;
    const diff = reader.diff('fixture-session', 7); await tick();
    assert.deepEqual([served[2].views, served[2].args], [['diff'], ['7', '--session', 'fixture-session']]);
    served[2].answer({ diff: { session: 'fixture-session', id: 7, file: '/local/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' } });
    assert.equal(await diff, '@@ -1 +1 @@\n-a\n+b\n', 'the patch `oak diff 7 --patch` prints');
    const fleet = reader.fleet('fixture-session', '/local'); await tick();
    assert.deepEqual([served[3].views, served[3].args], [['multitask'], ['--session', 'fixture-session', '--root', '/local']]);
    served[3].answer({ multitask: { agents: [{ session: 'fixture-session', subagents: [{ agentId: 'w1' }], todos: [] }] } });
    assert.equal((await fleet).subagents[0].agentId, 'w1');
    const sessions = reader.sessions('fixture-session', '/local'); await tick();
    assert.deepEqual(served[4].views, ['sessions']);
    served[4].answer({ sessions: { sessions: [{ id: 'fixture-session' }] } });
    assert.deepEqual(await sessions, { sessions: [{ id: 'fixture-session' }] });
    assert.equal(calls.length, 0, 'not one cold child for any of them');
    // A view the worker could not build: a cold child answers, and its error is the one reported.
    const failing = reader.read('fixture-session', '/local'); await tick();
    served[5].answer({ conversation: null, __problems: { conversation: 'view conversation exited 1' } }); await tick();
    assert.deepEqual(calls[0].args.slice(1), ['conversation', '--json', '--session', 'fixture-session', '--root', '/local', '--limit', '50']);
    calls[0].child.stderr.emit('data', Buffer.from('oak: cannot read the transcript')); calls[0].child.emit('close', 1);
    await assert.rejects(failing, /cannot read the transcript/);
    // Another machine's read is never sent to this machine's worker.
    const remote = reader.read('fixture-session', '/remote', undefined, 'build-box'); await tick();
    assert.equal(served.length, 6); assert.equal(calls.at(-1).args.at(-1), 'build-box');
    calls.at(-1).reply({ events: [], cursor: 1 }); await remote;
  } finally { reader.close(); }
});

test('conversation reader: a warm worker whose stdin closed is replaced, not given up for good (2026-09-26)', async () => {
  const { core, calls, served, workers } = transport({ warm: true });
  const reader = createConversationReader(core, '/local');
  try {
    const first = reader.read('fixture-session', '/local'); await tick();
    served[0].answer({ conversation: { events: [], cursor: 1 } }); await first;
    // The worker is exiting: its stdin has closed, its exit not yet reported. This read falls back cold…
    workers[0].stdin.writable = false;
    const fallback = reader.read('fixture-session', '/local', 1); await tick();
    assert.equal(calls.length, 1, 'the read runs cold');
    calls[0].reply({ events: [], cursor: 1 }); await fallback;
    // …and the next one starts a new worker instead of running cold for the rest of the session.
    const next = reader.read('fixture-session', '/local', 1); await tick();
    assert.equal(workers.length, 2, 'a new worker');
    assert.equal(served.length, 2, 'which answers the read');
    served[1].answer({ conversation: { events: [], cursor: 1 } }); await next;
    assert.equal(calls.length, 1, 'no further cold child');
  } finally { reader.close(); }
});

// A warm worker keeps what its reads parsed: after a cold-cache listing of real-size sessions each held
// 1.5–1.8 GB for the TUI's whole life. It is retired when idle, or when an answer leaves
// it over the resident bound — never mid-answer, and not again and again for a working set that is simply big.
test('warm worker: retired after it sits idle; the next request starts another', async () => {
  const { core, served, workers } = transport({ warm: true });
  const worker = createServeWorker(core, '/local', 'oak.js', { idleMs: 40, rss: async () => null });
  try {
    const first = worker.request(['sessions'], []); await tick();
    served[0].answer({ sessions: [] }); await first;
    assert.notEqual(workers[0].killed, true, 'answered, it stays warm');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(workers[0].killed, true, 'idle past the bound, it is retired');
    const next = worker.request(['sessions'], []); await tick();
    assert.equal(workers.length, 2, 'the next request starts a new worker');
    served[1].answer({ sessions: [] }); assert.deepEqual(JSON.parse(await next), { sessions: [] });
  } finally { worker.close(); }
});

test('warm worker: an answer that leaves it over the resident bound retires it once that answer is in', async () => {
  const { core, served, workers } = transport({ warm: true });
  const sizes = new Map([[4000, 1.8 * 1024 ** 3], [4001, 1.8 * 1024 ** 3]]);
  let asked = null;
  const worker = createServeWorker(core, '/local', 'oak.js', { checkEveryMs: 0, rss: (pid) => new Promise(resolve => { asked = () => resolve(sizes.get(pid) ?? null); }) });
  try {
    const listing = worker.request(['sessions'], []); await tick();
    served[0].answer({ sessions: [] }); await listing;
    // A second request is in flight when the size comes back: it is answered first, then the worker goes.
    const tail = worker.request(['conversation'], []); await tick();
    asked();
    await tick();
    assert.notEqual(workers[0].killed, true, 'never killed mid-answer');
    served[1].answer({ conversation: { events: [], cursor: 1 } });
    assert.deepEqual(JSON.parse(await tail), { conversation: { events: [], cursor: 1 } }, 'the answer in flight arrives');
    assert.equal(workers[0].killed, true, 'then the oversized worker is retired');
    const next = worker.request(['sessions'], []); await tick();
    assert.equal(workers.length, 2, 'the next request starts a new worker');
    served[2].answer({ sessions: [] }); await next;
    // The new worker is as big: a working set that size is kept, not re-read after every request.
    asked();
    await tick();
    const again = worker.request(['sessions'], []); await tick();
    served[3].answer({ sessions: [] }); await again;
    assert.notEqual(workers[1].killed, true, 'not retired again within the interval');
    assert.equal(workers.length, 2);
  } finally { worker.close(); }
});

test('warm worker: its size comes with each answer, so none is measured by spawning `ps`', async () => {
  // Where /proc is absent (macOS) the size was read with `ps`, one spawn per worker every 5 s.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const { core, calls, served, workers } = transport({ warm: true });
  const worker = createServeWorker(core, '/local', 'oak.js', { checkEveryMs: 0 });
  try {
    for (let i = 0; i < 3; i++) {
      const r = worker.request(['sessions'], []); await tick();
      served[i].answer({ __rss: 300 * 1024 ** 2, sessions: [] }); await r; await tick();
    }
    assert.equal(workers.length, 1, 'a worker that reports 300 MB is kept');
    const big = worker.request(['sessions'], []); await tick();
    served[3].answer({ __rss: 1.8 * 1024 ** 3, sessions: [] });
    assert.deepEqual(JSON.parse(await big).sessions, [], 'the answer is delivered');
    await tick();
    assert.equal(workers[0].killed, true, 'one that reports 1.8 GB is retired');
    assert.deepEqual(calls.map((c) => c.command), [], 'and no process was spawned to measure it');
  } finally { worker.close(); Object.defineProperty(process, 'platform', platform); }
});

test('warm worker: a worker within the resident bound is kept', async () => {
  const { core, served, workers } = transport({ warm: true });
  const worker = createServeWorker(core, '/local', 'oak.js', { checkEveryMs: 0, rss: async () => 300 * 1024 ** 2 });
  try {
    for (let i = 0; i < 3; i++) { const r = worker.request(['sessions'], []); await tick(); served[i].answer({ sessions: [] }); await r; await tick(); }
    assert.equal(workers.length, 1, 'one worker throughout');
    assert.notEqual(workers[0].killed, true);
  } finally { worker.close(); }
});

test('remote conversation reader names deadlines, kills a stuck child and rejects partial JSON', async () => {
  const vm = require('node:vm'), { core, calls } = transport(), timers = [], signals = [];
  const context = { exports: {}, require, process, Buffer,
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/backend.js'), 'utf8'), context);
  const reader = context.exports.createConversationReader(core, '/local');
  const pending = reader.read('fixture-session', '/remote', undefined, 'build-box');
  calls[0].child.kill = signal => signals.push(signal || 'SIGTERM');
  calls[0].child.stdout.emit('data', Buffer.from('{"events":[],"cursor":1}'));
  assert.equal(timers[0].ms, 60000); timers[0].fn();
  await assert.rejects(pending, /build-box.*timed out/);
  assert.equal(timers[1].ms, 1000); timers[1].fn();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  calls[0].child.emit('close', 0); reader.close();
});
