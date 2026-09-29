/* Bounded I/O and exact suffix/cursor semantics; generated data never leaves the temp home. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('../dist');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-conversation-perf-'));
  const previous = { ...process.env };
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  process.env.CODEX_HOME = path.join(base, 'codex');
  const root = path.join(base, 'workspace'), session = 'bounded-conversation';
  fs.mkdirSync(root, { recursive: true });
  const dir = core.projectDir(root); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  // Restore the keys we changed one by one: replacing `process.env` wholesale swaps the live env object
  // out from under every other test sharing this process (--test-isolation=none), which broke 176 of
  // core.test.js's cases when the two ran together.
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) if (process.env[key] !== value) process.env[key] = value;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const row = (ts, role, content, extra = {}) => ({ cwd: root, timestamp: new Date(1800000000000 + ts).toISOString(), message: { role, content }, ...extra });
  const prompt = (ts, text = `prompt ${ts}`) => row(ts, 'user', text);
  const answer = (ts, text = 'answer') => row(ts, 'assistant', [{ type: 'text', text }]);
  const call = (ts, id, name = 'Read', input = { file_path: path.join(root, 'demo') }) => row(ts, 'assistant', [{ type: 'tool_use', id, name, input }]);
  const result = (ts, id) => row(ts, 'user', [{ type: 'tool_result', tool_use_id: id, content: 'done' }]);
  const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const read = limit => core.conversationEvents(session, { root, limit });
  const bytes = fn => {
    const orig = fs.readSync; let count = 0;
    fs.readSync = function (...args) { const n = orig.apply(this, args); count += n; return n; };
    try { return { result: fn(), count }; } finally { fs.readSync = orig; }
  };
  return { root, session, file, row, prompt, answer, call, result, jsonl, read, bytes };
}
function lastTurns(result, n) {
  const prompts = result.events.map((e, i) => e.update.sessionUpdate === 'user_prompt' ? i : -1).filter(i => i >= 0);
  return result.events.slice(prompts.at(-n));
}

test('conversation perf: 20 MB history reads less than ten percent for one turn', t => {
  const f = fixture(t);
  const fd = fs.openSync(f.file, 'w');
  for (let i = 0; i < 330; i++) fs.writeSync(fd, f.jsonl([f.prompt(i * 2), f.answer(i * 2 + 1, 'x'.repeat(65536))]));
  fs.writeSync(fd, f.jsonl([f.prompt(1000), f.answer(1001)])); fs.closeSync(fd);
  const size = fs.statSync(f.file).size;
  assert.ok(size > 20 * 1024 * 1024);
  const { result, count } = f.bytes(() => f.read(1));
  t.diagnostic(JSON.stringify({ historyBytes: size, limitedReadBytes: count }));
  assert.equal(result.turns, 1);
  assert.ok(count < size / 10, `limited read fetched ${count} of ${size} bytes`);
});

test('conversation perf: append to a 20 MB unfinished turn reads only new bytes', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0)]));
  const fd = fs.openSync(f.file, 'a');
  for (let i = 0; i < 330; i++) fs.writeSync(fd, f.jsonl([{ ignored: 'x'.repeat(65536) }]));
  fs.closeSync(fd);
  const first = f.read(1);
  const added = f.jsonl([f.answer(1, 'new '.repeat(450))]);
  fs.appendFileSync(f.file, added);
  const { result, count } = f.bytes(() => core.conversationTail(f.session, first.cursor));
  t.diagnostic(JSON.stringify({ appendedBytes: Buffer.byteLength(added), tailReadBytes: count }));
  assert.ok(count <= Buffer.byteLength(added) + 1024, `tail fetched ${count} for ${Buffer.byteLength(added)} appended bytes`);
  assert.deepEqual(result.events.map(e => e.update.sessionUpdate), ['agent_message_chunk', 'turn_end']);
});

test('conversation perf: suffix preserves boundary-crossing tools, sidechains, null and unfinished prompts', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0), f.call(1, 'across'), f.prompt(2), null,
    { ...f.prompt(3, 'hidden'), isSidechain: true }, f.result(4, 'across'), f.answer(5), f.prompt(6)]));
  const full = f.read(100);
  assert.deepEqual(f.read(2).events, lastTurns(full, 2));
  assert.deepEqual(f.read(1).events, lastTurns(full, 1));
  assert.equal(f.read(1).events.length, 1, 'unfinished prompt has no fabricated completion');
});

test('conversation perf: prompt and multibyte UTF-8 straddle backwards chunk edges', t => {
  const f = fixture(t);
  const tail = f.jsonl([f.prompt(2, '猫😀 kept'), f.answer(3, '猫😀 complete')]);
  const prefix = f.jsonl([f.prompt(0), f.answer(1)]);
  // Place the backwards 64 KiB edge inside the prompt emoji, not on a record boundary.
  const endOfEmoji = Buffer.byteLength(tail.slice(0, tail.indexOf('😀'))) + 2;
  const paddingLength = 65536 - Buffer.byteLength(tail) + endOfEmoji;
  const padding = JSON.stringify({ ignored: 'x'.repeat(paddingLength - 15) }) + '\n';
  fs.writeFileSync(f.file, prefix + tail + padding);
  const edge = fs.statSync(f.file).size - 65536;
  const contents = fs.readFileSync(f.file);
  assert.equal(contents[edge] & 0xc0, 0x80, 'fixture chunk edge splits a UTF-8 sequence');
  assert.deepEqual(f.read(1).events, lastTurns(f.read(100), 1));
});

test('conversation perf: suffix edit IDs retain positional attribution across older turns', t => {
  const f = fixture(t), target = path.join(f.root, 'demo');
  core.ensureStore(f.session);
  const blob = core.writeBlob(f.session, Buffer.from('content'));
  for (const ts of [1800000000010, 1800000000020]) core.appendLog(f.session, { file: target, tool: 'Edit', ts, beforeBlob: blob, afterBlob: blob, status: 'pending' });
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0), f.call(100, 'old', 'Edit'), f.result(101, 'old'), f.answer(102),
    f.prompt(200), f.call(201, 'new', 'Edit'), f.result(202, 'new'), f.answer(203)]));
  const full = f.read(100);
  assert.deepEqual(f.read(1).events, lastTurns(full, 1));
  assert.equal(f.read(1).events.find(e => e.update.sessionUpdate === 'tool_call').update.editId, 2);
});

test('conversation perf: persisted cursor survives a fresh CLI process without replaying the old turn', t => {
  const f = fixture(t); core.ensureStore(f.session); fs.writeFileSync(core.logPath(f.session), '');
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0), { ignored: 'x'.repeat(1024 * 1024) }]));
  const initial = f.read(1);
  fs.appendFileSync(f.file, f.jsonl([f.answer(2)]));
  const output = path.join(f.root, 'child.json'), fd = fs.openSync(output, 'w');
  const script = `const fs=require('fs'),core=require(${JSON.stringify(path.resolve(__dirname, '../dist'))});let bytes=0;const read=fs.readSync;fs.readSync=function(...args){const n=read.apply(this,args);bytes+=n;return n};const result=core.conversationTail(process.argv[1],${initial.cursor});console.log(JSON.stringify({result,bytes}));`;
  let child;
  try { child = require('node:child_process').spawnSync(process.execPath, ['-e', script, f.session], { stdio: ['ignore', fd, fd], env: { ...process.env, NODE_TEST_CONTEXT: '' } }); }
  finally { fs.closeSync(fd); }
  assert.ifError(child.error); assert.equal(child.status, 0, fs.readFileSync(output, 'utf8'));
  const { result, bytes } = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(result.events.map(e => e.update.sessionUpdate), ['agent_message_chunk', 'turn_end']);
  t.diagnostic(JSON.stringify({ freshProcessReadBytes: bytes }));
  assert.ok(bytes < 2048, `fresh process read ${bytes} bytes`);
});

test('conversation perf: rewritten files reject a saved cursor state', t => {
  const f = fixture(t); core.ensureStore(f.session);
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0, 'original'), f.call(1, 'old')]));
  const first = f.read(1);
  // Same inode, larger file: neither inode nor a size-only guard can detect this replacement.
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0, 'replacement'), { padding: ' '.repeat(first.cursor) }, f.answer(2)]));
  const since = core.conversationTail(f.session, first.cursor);
  assert.ok(since.events.some(e => e.update.sessionUpdate === 'turn_end'), 'old pending tool cannot suppress the replacement completion');
});

test('conversation perf: limited attribution leaves overlapping subagent edits unassigned', t => {
  const f = fixture(t); core.ensureStore(f.session);
  const target = path.join(f.root, 'demo'), blob = core.writeBlob(f.session, Buffer.from('content'));
  for (const ts of [1, 2, 3]) core.appendLog(f.session, { file: target, tool: 'Edit', ts: 1800000000000 + ts, beforeBlob: blob, afterBlob: blob, status: 'pending' });
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0), f.call(1, 'main-one', 'Edit'), f.answer(2), f.prompt(3), f.call(4, 'main-two', 'Edit'), f.result(5, 'main-two'), f.answer(6)]));
  const subs = f.file.replace(/\.jsonl$/, '') + '/subagents'; fs.mkdirSync(subs, { recursive: true });
  fs.writeFileSync(path.join(subs, 'agent-worker.jsonl'), f.jsonl([{ ...f.call(2, 'worker-one', 'Edit'), isSidechain: true }]));
  const suffix = f.read(1);
  assert.deepEqual(suffix.events, lastTurns(f.read(100), 1));
  assert.equal(suffix.events.find(e => e.update.sessionUpdate === 'tool_call').update.editId, undefined);
});

test('conversation perf: a new edit after a long quiet turn uses the primed attribution cursor', t => {
  const f = fixture(t), target = path.join(f.root, 'demo'); core.ensureStore(f.session);
  const blob = core.writeBlob(f.session, Buffer.from('content'));
  core.appendLog(f.session, { file: target, tool: 'Edit', ts: 1800000000001, beforeBlob: blob, afterBlob: blob, status: 'pending' });
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0)]));
  const fd = fs.openSync(f.file, 'a');
  for (let i = 0; i < 330; i++) fs.writeSync(fd, f.jsonl([{ ignored: 'x'.repeat(65536) }]));
  fs.closeSync(fd);
  const first = f.read(1);
  const added = f.jsonl([f.call(1, 'new-edit', 'Edit', { file_path: target, old_string: 'old', new_string: 'x'.repeat(1800) })]);
  fs.appendFileSync(f.file, added);
  const { result, count } = f.bytes(() => core.conversationTail(f.session, first.cursor));
  t.diagnostic(JSON.stringify({ editAppendBytes: Buffer.byteLength(added), editTailReadBytes: count }));
  assert.ok(count < 16 * 1024, `edit tail fetched ${count} bytes`);
  assert.equal(result.events[0].update.editId, 1);
});

test('conversation perf: suffix task plans preserve the action parser subject and task ID rules', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, f.jsonl([f.prompt(0), f.answer(1), f.prompt(2),
    f.call(3, 'create', 'TaskCreate', { subject: '  Check edits  ' }),
    f.call(4, 'invalid-update', 'TaskUpdate', { subject: 'No task ID' }),
    f.call(5, 'update', 'TaskUpdate', { taskId: 'task-one', subject: '  Checked edits  ', status: 'completed' })]));
  assert.deepEqual(f.read(1).events.filter(e => e.update.sessionUpdate === 'plan').map(e => e.update.entries), [
    [{ content: 'Check edits', priority: 'medium', status: 'pending' }],
    [{ content: 'Checked edits', priority: 'medium', status: 'completed' }],
  ]);
});
