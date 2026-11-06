const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const core = require('../packages/core/dist');
const { indexFixture, reply, text } = require('../packages/core/test/fixtures/index-fixture.cjs');

function fixture(t) {
  const b = indexFixture(t, core);
  const parent = b.claude('parent', b.work, [reply('parent-text', [text('PARENT ONLY')])]);
  const file = path.join(path.dirname(parent), 'parent/subagents/agent-worker.jsonl');
  b.write(file, [{ ...reply('worker-text', [text('WORKER ONLY')]), isSidechain: true }]);
  fs.writeFileSync(file.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'Check the fixtures', requestShape: 'background' }));
  const append = (file, records) => fs.appendFileSync(file, b.lines(records));
  const end = (ts = '2026-10-01T10:05:12.345Z') => append(parent, [{ type: 'queue-operation', operation: 'enqueue', timestamp: ts,
    content: '<task-notification><task-id>worker</task-id><status>completed</status></task-notification>' }]);
  return { ...b, parent, file, append, end };
}

test('worker feed: silence is not an end; completion and resumed turns keep exact evidence', t => {
  const b = fixture(t);
  const read = () => core.liveFeed(b.work, 'parent', { kind: 'agent', id: 'worker' });
  let feed = read();
  assert.equal(feed.mode, 'live');
  assert.match(JSON.stringify(feed.entries), /WORKER ONLY/);
  assert.doesNotMatch(JSON.stringify(feed.entries), /PARENT ONLY/);
  b.end();
  feed = read();
  assert.equal(feed.mode, 'audit');
  assert.equal(feed.endedTs, Date.parse('2026-10-01T10:05:12.345Z'));
  assert.match(feed.note, /Worker ended at 2026-10-01T10:05:12.345Z/);
  b.append(b.file, [{ ...reply('resumed', [text('RESUMED')]), timestamp: '2026-10-01T10:06:00Z', isSidechain: true }]);
  assert.equal(read().mode, 'live');
  assert.equal(read().endedTs, undefined);
});

test('worker feed: foreground tool result supplies the completion time', t => {
  const b = fixture(t);
  b.append(b.parent, [{ type: 'user', timestamp: '2026-10-01T10:03:00.123Z',
    toolUseResult: { agentId: 'worker', status: 'completed' }, message: { content: [] } }]);
  const feed = core.liveFeed(b.work, 'parent', { kind: 'agent', id: 'worker' });
  assert.equal(feed.endedTs, Date.parse('2026-10-01T10:03:00.123Z'));
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 120; i++) { if (fn()) return; await delay(25); }
  assert.fail('live log did not update within 3 seconds');
}
for (const poll of [false, true]) test(`worker follow: ${poll ? 'poll fallback' : 'file watch'}, partial writes, rotation, idle and disposal`, async t => {
  const b = fixture(t), seen = [], errors = [];
  const stop = core.followWorkerFeed(b.work, 'parent', 'worker', {
    onFeed: feed => seen.push(feed), onError: error => errors.push(error), pollMs: poll ? 40 : 60000,
    ...(poll ? { watch: () => { throw new Error('watch unavailable'); } } : {}),
  });
  t.after(stop);
  assert.equal(seen.length, 1);
  await delay(150);
  assert.equal(seen.length, 1, 'idle polls must not parse or repaint');
  const line = b.lines([{ ...reply('next', [text('NEW ACTIVITY')]), isSidechain: true }]);
  fs.appendFileSync(b.file, line.slice(0, -8));
  await delay(100);
  fs.appendFileSync(b.file, line.slice(-8));
  await until(() => JSON.stringify(seen.at(-1)).includes('NEW ACTIVITY'));
  fs.renameSync(b.file, b.file + '.old');
  b.write(b.file, [{ ...reply('replacement', [text('REPLACED LOG')]), isSidechain: true }]);
  await until(() => JSON.stringify(seen.at(-1)).includes('REPLACED LOG'));
  b.end();
  await until(() => seen.at(-1).endedTs);
  const n = seen.length;
  b.append(b.file, [{ ...reply('after', [text('AFTER CLOSE')]), isSidechain: true }]);
  await delay(150);
  assert.equal(seen.length, n, 'completion closes watchers and timers');
  assert.deepEqual(errors, []);
});

test('worker follow includes an entire burst beyond the initial tail limit', async t => {
  const b = fixture(t), seen = [];
  const stop = core.followWorkerFeed(b.work, 'parent', 'worker', { limit: 2, onFeed: f => seen.push(f), onError: e => { throw e; } });
  t.after(stop);
  b.append(b.file, Array.from({ length: 80 }, (_, i) => ({ ...reply(`burst${i}`, [text(`Burst ${i}`)]), isSidechain: true })));
  await until(() => JSON.stringify(seen.at(-1)).includes('Burst 79'));
  assert.equal(seen.at(-1).entries.length, 80, 'no new activity is lost between watch events');
});

test('worker feed uses a recorded SubagentStop even before the parent result arrives', t => {
  const b = fixture(t);
  core.appendCaptureEvent('parent', 'subagent', { phase: 'stop', context: { agentId: 'worker' } });
  const stop = core.readCaptureEvents('parent', ['subagent']).at(-1).ts;
  assert.equal(core.liveFeed(b.work, 'parent', { kind: 'agent', id: 'worker' }).endedTs, stop);
});

test('worker follow waits for the first transcript and releases its handles on cancellation', async t => {
  const b = fixture(t), seen = [];
  fs.unlinkSync(b.file);
  const stop = core.followWorkerFeed(b.work, 'parent', 'worker', { onFeed: f => seen.push(f), onError: e => { throw e; }, pollMs: 40 });
  t.after(stop);
  assert.match(seen[0].note, /waiting/);
  b.write(b.file, [{ ...reply('arrived', [text('FIRST WRITE')]), isSidechain: true }]);
  await until(() => JSON.stringify(seen.at(-1)).includes('FIRST WRITE'));
  stop();
  const n = seen.length;
  b.end();
  await delay(100);
  assert.equal(seen.length, n);
});

test('CLI worker follow streams new activity, then the exact end and exits', async t => {
  const b = fixture(t);
  const child = cp.spawn(process.execPath, [path.resolve(__dirname, '../packages/cli/dist/index.js'), 'feed',
    '--kind', 'agent', '--id', 'worker', '--session', 'parent', '--root', b.work, '--follow'], { env: process.env });
  t.after(() => child.kill());
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  await until(() => out.includes('WORKER ONLY'));
  b.append(b.file, [{ ...reply('next', [text('SECOND STEP')]), isSidechain: true }]);
  await until(() => out.includes('SECOND STEP'));
  b.end();
  assert.equal(await Promise.race([exit, delay(3000).then(() => 'timed out')]), 0, err);
  assert.match(out, /Worker ended at 2026-10-01T10:05:12.345Z/);
  assert.equal(out.split('WORKER ONLY').length - 1, 1, 'append output must not duplicate old rows');
});

test('CLI worker follow JSON is one parseable snapshot per line', async t => {
  const b = fixture(t);
  const child = cp.spawn(process.execPath, [path.resolve(__dirname, '../packages/cli/dist/index.js'), 'feed',
    '--kind', 'agent', '--id', 'worker', '--session', 'parent', '--root', b.work, '--follow', '--json'], { env: process.env });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const exit = new Promise(resolve => child.once('exit', resolve));
  await until(() => out.includes('\n'));
  assert.equal(JSON.parse(out.trim()).ref.id, 'worker');
  b.end();
  assert.equal(await Promise.race([exit, delay(3000).then(() => 'timed out')]), 0);
  const snapshots = out.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].endedTs, Date.parse('2026-10-01T10:05:12.345Z'));
});
