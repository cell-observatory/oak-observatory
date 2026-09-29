const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const zlib = require('node:zlib');
const dist = process.env.OAK_DERIVE_TEST_DIST || path.resolve(__dirname, '../dist');
const core = require(dist);
let cache;
try { cache = require(path.join(dist, 'derived-transcript.js')); }
catch { cache = { clearTranscriptFactsMemory() {}, withoutTranscriptFactsCache: f => f() }; }
const worker = path.join(__dirname, 'fixtures/derive-worker.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-derive-'));
  const previous = { ...process.env };
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  process.env.CODEX_HOME = path.join(base, 'codex');
  const cwd = path.join(base, 'workspace'), session = 'facts-session';
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.mkdirSync(core.projectDir(cwd), { recursive: true });
  core.ensureStore(session); fs.writeFileSync(core.logPath(session), '');
  const file = path.join(core.projectDir(cwd), session + '.jsonl');
  const cacheDir = path.join(core.rootDir(), 'changemap-cache', session);
  const row = (ts, role, content, extra = {}) => ({ cwd, timestamp: new Date(1800000000000 + ts).toISOString(), message: { role, content }, ...extra });
  const call = (ts, id, name = 'Edit', input = { file_path: path.join(cwd, 'demo') }) => row(ts, 'assistant', [{ type: 'tool_use', id, name, input }]);
  const result = (ts, id, content = 'ok', is_error = false) => row(ts, 'user', [{ type: 'tool_result', tool_use_id: id, content, is_error }]);
  const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const factsFiles = () => fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter(n => n.startsWith('transcript-facts-') && n.endsWith('.json')).map(n => path.join(cacheDir, n)) : [];
  const facts = () => ({ actions: core.parseTranscriptActions(file), names: core.taskNamings(file), snaps: core.taskSnaps(file), insights: core.transcriptInsights(cwd, session) });
  const full = () => cache.withoutTranscriptFactsCache(facts);
  t.after(() => { cache.clearTranscriptFactsMemory(); process.env = previous; fs.rmSync(base, { recursive: true, force: true }); });
  return { base, cwd, session, file, cacheDir, row, call, result, jsonl, factsFiles, facts, full };
}
function child(f, args = [f.file], env = {}) {
  const out = path.join(f.base, `out-${crypto.randomBytes(4).toString('hex')}`), err = out + '.err';
  const fd = fs.openSync(out, 'w'), ef = fs.openSync(err, 'w');
  let r;
  try { r = cp.spawnSync(process.execPath, [worker, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', fd, ef] }); }
  finally { fs.closeSync(fd); fs.closeSync(ef); }
  assert.equal(r.status, 0, String(r.error || fs.readFileSync(err, 'utf8')));
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}
function countReads(file, fn) {
  const open = fs.openSync, close = fs.closeSync, read = fs.readSync, readFile = fs.readFileSync;
  const fds = new Set(); let bytes = 0;
  fs.openSync = function (p, ...args) { const fd = open.call(this, p, ...args); if (String(p) === file) fds.add(fd); return fd; };
  fs.closeSync = function (fd) { fds.delete(fd); return close.call(this, fd); };
  fs.readSync = function (fd, ...args) { const n = read.call(this, fd, ...args); if (fds.has(fd)) bytes += n; return n; };
  fs.readFileSync = function (p, ...args) { if (String(p) === file) bytes += fs.statSync(file).size; return readFile.call(this, p, ...args); };
  try { return { value: fn(), get bytes() { return bytes; } }; }
  finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; fs.readFileSync = readFile; }
}
function largePrefix(f) {
  fs.writeFileSync(f.file, f.jsonl([f.row(0, 'user', 'start'), f.row(1, 'assistant', [{ type: 'thinking', thinking: 'reasoning crosses the cursor' }]), f.call(2, 'delayed')]));
  fs.appendFileSync(f.file, f.jsonl(Array.from({ length: 80 }, () => ({ ignored: 'x'.repeat(65536) }))));
}

test('derived facts: subagent and process consumers resume across a fresh-process append', t => {
  const f = fixture(t); largePrefix(f);
  const dir = path.join(core.projectDir(f.cwd), f.session, 'subagents'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-child.jsonl'), f.jsonl([{ ...f.call(3, 'child-read', 'Read', { file_path: 'demo' }), isSidechain: true }]));
  fs.appendFileSync(f.file, f.jsonl([
    f.call(3, 'spawn', 'Agent', { description: 'Complete description', subagent_type: 'Explore' }),
    f.call(4, 'shell', 'Bash', { command: 'printf ready', run_in_background: true }),
  ]));
  const args = ['dependents', f.file, f.cwd, f.session], env = { OAK_DERIVE_FIXED_NOW: '1801000000000' };
  child(f, args, env);
  const added = f.jsonl([
    { ...f.result(5, 'spawn'), toolUseResult: { agentId: 'child', status: 'completed', totalTokens: 17 } },
    { ...f.result(6, 'shell'), toolUseResult: { backgroundTaskId: 'background' } },
    { timestamp: new Date(1800000000007).toISOString(), content: '<task-notification><task-id>background</task-id><status>completed</status><summary>exit code 3</summary></task-notification>' },
  ]);
  fs.appendFileSync(f.file, added);
  const after = child(f, args, env);
  t.diagnostic(JSON.stringify({ historyBytes: fs.statSync(f.file).size - Buffer.byteLength(added), appendedBytes: Buffer.byteLength(added), readBytes: after.bytes }));
  assert.ok(after.bytes <= Buffer.byteLength(added) + 1024, `dependent parsers read ${after.bytes} bytes`);
  assert.equal(after.subagents[0].description, 'Complete description');
  assert.equal(after.subagents[0].tokens, 17);
  assert.equal(after.processes[0].exitCode, 3);
  const warm = child(f, args, env);
  assert.ok(warm.bytes <= 512, `warm dependent parsers read ${warm.bytes} bytes`);
  const { bytes, ...payload } = after, { bytes: ignored, ...uncached } = child(f, args, { ...env, OAK_DERIVE_NO_CACHE: '1' });
  assert.deepEqual(payload, uncached);
});

test('derived facts: subagent todos and vitals resume without historical body reads', t => {
  const f = fixture(t), dir = path.join(core.projectDir(f.cwd), f.session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const sub = path.join(dir, 'agent-child.jsonl');
  fs.writeFileSync(f.file, f.jsonl([f.row(0, 'user', 'start')]));
  fs.writeFileSync(sub, f.jsonl([
    { ...f.call(1, 'todos', 'TodoWrite', { todos: [{ content: 'First task', status: 'in_progress' }] }), isSidechain: true },
    ...Array.from({ length: 80 }, () => ({ ignored: 'x'.repeat(65536) })),
  ]));
  const args = ['dependents', sub, f.cwd, f.session], env = { OAK_DERIVE_FIXED_NOW: '1801000000000' };
  child(f, args, env);
  const added = f.jsonl([{ ...f.call(5, 'next-todos', 'TodoWrite', { todos: [{ content: 'Complete 猫😀 task', status: 'in_progress' }] }), isSidechain: true },
    { timestamp: new Date(1800000000006).toISOString(), isSidechain: true, effort: 'high', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 1000 }, content: [] } }]);
  fs.appendFileSync(sub, added);
  const value = child(f, args, env), digest = value.digests[0];
  t.diagnostic(JSON.stringify({ subagentHistoryBytes: fs.statSync(sub).size - Buffer.byteLength(added), appendedBytes: Buffer.byteLength(added), readBytesIncludingPhaseTail: value.bytes }));
  assert.ok(value.bytes <= Buffer.byteLength(added) + 65536 + 1024, 'only appended facts, guards and the bounded live-phase tail');
  assert.equal(digest.currentTask, 'Complete 猫😀 task');
  assert.equal(digest.tokens, 15);
  assert.equal(digest.tokensCacheRead, 1000);
  assert.equal(digest.model, 'Opus 4.8');
  assert.equal(digest.effort, 'high');
});

test('derived facts: fleet and subagents share one enumeration per batch and refresh membership', t => {
  const f = fixture(t); fs.writeFileSync(f.file, f.jsonl([f.row(0, 'user', 'start')]));
  const dir = path.join(core.projectDir(f.cwd), f.session, 'subagents'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-first.jsonl'), f.jsonl([{ ...f.call(1, 'read', 'Read'), isSidechain: true }]));
  const original = fs.readdirSync, counts = new Map();
  fs.readdirSync = function (p, ...args) {
    // The live phase reader also scans child activity; it is outside the membership inventory.
    if (!new Error().stack.includes('newestChildActivityMs')) counts.set(String(p), (counts.get(String(p)) || 0) + 1);
    return original.call(this, p, ...args);
  };
  try {
    core.withDerivedInventory(() => {
      for (let i = 0; i < 3; i++) { core.listSiblings(f.cwd, f.session); core.listRepoSiblings(f.cwd, f.session); core.parseSubagents(f.cwd, f.session); core.subagentDigests(f.cwd, f.session); }
      fs.writeFileSync(path.join(dir, 'agent-next.jsonl'), f.jsonl([{ ...f.call(2, 'next', 'Read'), isSidechain: true }]));
      assert.equal(core.parseSubagents(f.cwd, f.session).length, 1, 'membership is fixed within the batch');
    });
  } finally { fs.readdirSync = original; }
  assert.equal(counts.get(dir), 1, 'one subagent enumeration');
  assert.equal(counts.get(core.projectDir(f.cwd)), 1, 'one project enumeration');
  assert.equal(core.withDerivedInventory(() => core.parseSubagents(f.cwd, f.session)).length, 2);
});

test('derived facts: subagent digests invalidate on parent results and metadata-only updates', t => {
  const f = fixture(t), dir = path.join(core.projectDir(f.cwd), f.session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f.file, f.jsonl([f.call(1, 'spawn', 'Agent', { description: 'Full spawn description' })]));
  fs.writeFileSync(path.join(dir, 'agent-child.jsonl'), f.jsonl([{ ...f.call(2, 'child-read', 'Read'), isSidechain: true }]));
  const meta = path.join(dir, 'agent-child.meta.json');
  fs.writeFileSync(meta, JSON.stringify({ agentType: 'Explore', description: 'Sidecar description' }));
  assert.equal(core.subagentDigests(f.cwd, f.session)[0].description, 'Sidecar description');
  fs.appendFileSync(f.file, f.jsonl([{ ...f.result(3, 'spawn'), toolUseResult: { agentId: 'child', status: 'completed', totalTokens: 29 } }]));
  const completed = core.subagentDigests(f.cwd, f.session)[0];
  assert.equal(completed.description, 'Full spawn description');
  assert.equal(completed.tokens, 29);
  fs.writeFileSync(meta, JSON.stringify({ agentType: 'Reviewer', description: 'Sidecar description' }));
  assert.equal(core.subagentDigests(f.cwd, f.session)[0].agentType, 'Reviewer');
});

test('derived facts: deferred process ends and kills preserve full-replay precedence after every append', t => {
  const f = fixture(t), args = ['dependents', f.file, f.cwd, f.session], env = { OAK_DERIVE_FIXED_NOW: '1801000000000' };
  const done = (ts, id, tool, code) => ({ timestamp: new Date(1800000000000 + ts).toISOString(), content:
    `<task-notification><task-id>${id}</task-id><tool-use-id>${tool}</tool-use-id><status>completed</status><summary>exit code ${code}</summary></task-notification>` });
  const rows = [
    f.call(1, 'a', 'Bash', { command: 'printf a', run_in_background: true }),
    done(2, 'background-a', 'a', 1),
    f.call(3, 'b', 'Bash', { command: 'printf b', run_in_background: true }),
    { ...f.result(4, 'b'), toolUseResult: { backgroundTaskId: 'background-b' } },
    f.call(5, 'stop', 'TaskStop', { task_id: 'background-b' }),
    { ...f.result(6, 'a'), toolUseResult: { backgroundTaskId: 'background-a' } },
    done(7, 'background-a', 'a', 2), done(8, 'background-b', 'b', 0), done(9, 'background-a', 'a', 9),
  ];
  fs.writeFileSync(f.file, '');
  for (const [i, row] of rows.entries()) {
    fs.appendFileSync(f.file, f.jsonl([row]));
    const incremental = child(f, args, env).processes;
    const replay = child(f, args, { ...env, OAK_DERIVE_NO_CACHE: '1' }).processes;
    assert.deepEqual(incremental, replay, `record ${i}`);
    if (process.env.OAK_DERIVE_REFERENCE_DIST) assert.deepEqual(incremental,
      child(f, args, { ...env, OAK_DERIVE_TEST_DIST: process.env.OAK_DERIVE_REFERENCE_DIST }).processes, `reference record ${i}`);
  }
  const final = child(f, args, env).processes;
  assert.equal(final.find(p => p.id === 'background-a').exitCode, 2);
  assert.equal(final.find(p => p.id === 'background-b').status, 'completed');
});

test('derived facts: fresh-process hit reads guards, and append reads only new bytes', t => {
  const f = fixture(t); largePrefix(f); f.facts();
  const warm = child(f);
  assert.ok(warm.bytes <= 512, `warm read ${warm.bytes} historical bytes`);
  const added = f.jsonl([f.result(3, 'delayed', 'failure', true), f.call(4, 'next')]);
  fs.appendFileSync(f.file, added);
  const appended = child(f);
  t.diagnostic(JSON.stringify({ historyBytes: fs.statSync(f.file).size - Buffer.byteLength(added), warmBytes: warm.bytes, appendedBytes: Buffer.byteLength(added), readBytes: appended.bytes }));
  assert.ok(appended.bytes <= Buffer.byteLength(added) + 1024);
  assert.equal(appended.actions[0].isError, true);
  assert.equal(appended.actions[1].reasoning, 'reasoning crosses the cursor');
  cache.clearTranscriptFactsMemory(); assert.deepEqual(f.facts(), f.full());
});

test('derived facts: delayed task results, renames, deletion and todos cross the cursor', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, f.jsonl([f.row(0, 'user', 'plan'), f.call(1, 'create', 'TaskCreate', { subject: 'first', description: 'whole description' }),
    f.call(2, 'todos', 'TodoWrite', { todos: [{ content: 'todo', status: 'in_progress' }] })]));
  f.facts(); cache.clearTranscriptFactsMemory();
  fs.appendFileSync(f.file, f.jsonl([f.row(3, 'user', 'next ask'), f.result(4, 'create', [{ type: 'text', text: 'Task #9 created' }]),
    f.call(5, 'rename', 'TaskUpdate', { taskId: '9', subject: 'renamed', status: 'in_progress' }),
    f.call(6, 'delete', 'TaskUpdate', { taskId: '9', status: 'deleted' }),
    { type: 'ai-title', aiTitle: 'New title' }]));
  const value = f.facts(); assert.deepEqual(value, f.full());
  assert.deepEqual(value.names.map(n => n.subject), ['first', 'renamed']);
  assert.deepEqual(value.snaps.at(-1).todos, []);
  assert.equal(value.insights.title, 'New title');
  assert.equal(value.insights.todos[0].content, 'todo');
});

test('derived facts: split UTF-8, malformed lines and valid unterminated tails count once', t => {
  const f = fixture(t);
  const prefix = f.jsonl([f.row(0, 'user', 'start')]);
  const tail = Buffer.from(f.jsonl([f.call(1, 'utf', 'TaskCreate', { subject: '猫😀 full text' })]));
  const split = tail.indexOf(Buffer.from('😀')) + 2;
  fs.writeFileSync(f.file, Buffer.concat([Buffer.from(prefix), tail.subarray(0, split)]));
  assert.equal(f.facts().actions.length, 0);
  cache.clearTranscriptFactsMemory(); fs.appendFileSync(f.file, tail.subarray(split, tail.length - 1));
  assert.equal(f.facts().actions.length, 1);
  cache.clearTranscriptFactsMemory(); assert.deepEqual(f.facts(), f.full());
  fs.appendFileSync(f.file, '\nnull\n[]\n{broken}\n' + f.jsonl([f.result(2, 'utf', 'Task #3 created')]));
  const value = f.facts(); assert.equal(value.actions.length, 1);
  assert.equal(value.names[0].subject, '猫😀 full text'); assert.deepEqual(value, f.full());
});

test('derived facts: replacement, truncation and same-size rewrite reset persisted facts', t => {
  const f = fixture(t);
  for (const mode of ['replacement', 'truncation', 'same-size']) {
    fs.writeFileSync(f.file, f.jsonl([f.call(1, 'old'), { ignored: 'x'.repeat(1024) }])); f.facts();
    const st = fs.statSync(f.file); cache.clearTranscriptFactsMemory();
    const text = f.jsonl([f.call(1, 'new'), { ignored: 'x'.repeat(mode === 'truncation' ? 0 : 1024) }]);
    if (mode === 'replacement') { fs.writeFileSync(f.file + '.next', text); fs.renameSync(f.file + '.next', f.file); }
    else fs.writeFileSync(f.file, text);
    if (mode === 'same-size') fs.utimesSync(f.file, st.atime, st.mtime);
    assert.deepEqual(f.facts(), f.full(), mode); assert.equal(f.facts().actions[0].toolUseId, 'new');
  }
});

test('derived facts: prefix and cursor guards reject a rewritten prefix followed by append', t => {
  const f = fixture(t);
  for (const edge of [false, true]) {
    // A relative path keeps `old` inside the last guard window (the 128 bytes before the cursor) whatever
    // the root's length. An absolute one moved it out on Windows, where the root is longer and escaped.
    fs.writeFileSync(f.file, f.jsonl([{ ignored: 'x'.repeat(1024) }, f.call(1, 'old', 'Edit', { file_path: 'demo' })])); f.facts(); cache.clearTranscriptFactsMemory();
    const body = fs.readFileSync(f.file); const needle = edge ? Buffer.from('old') : Buffer.from('xxxxx');
    const offset = body.indexOf(needle); const fd = fs.openSync(f.file, 'r+');
    fs.writeSync(fd, Buffer.from(edge ? 'new' : 'yyyyy'), 0, needle.length, offset); fs.closeSync(fd);
    fs.appendFileSync(f.file, f.jsonl([f.call(2, 'append')]));
    const r = countReads(f.file, f.facts);
    assert.ok(r.bytes > fs.statSync(f.file).size, 'invalid guard causes historical replay');
    assert.deepEqual(r.value, f.full());
  }
});

test('derived facts: main and sidechain policies have separate canonical-path caches', t => {
  const f = fixture(t); fs.writeFileSync(f.file, f.jsonl([f.call(0, 'main'), { ...f.call(1, 'side'), isSidechain: true }]));
  assert.equal(core.parseTranscriptActions(f.file).length, 1);
  assert.equal(core.parseTranscriptActions(f.file, { includeSidechain: true }).length, 2);
  assert.equal(f.factsFiles().length, 2);
  fs.symlinkSync(f.file, path.join(f.base, 'alias.jsonl'));
  cache.clearTranscriptFactsMemory();
  assert.deepEqual(core.parseTranscriptActions(path.join(f.base, 'alias.jsonl')), core.parseTranscriptActions(f.file));
  assert.equal(f.factsFiles().length, 2);
});

test('derived facts: malformed, incompatible and structurally invalid caches rebuild', t => {
  const f = fixture(t); largePrefix(f); f.facts();
  assert.equal(f.factsFiles().length, 1);
  const file = f.factsFiles()[0];
  for (const mode of ['torn', 'checksum', 'version', 'shape', 'prose-index']) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (mode === 'torn') fs.writeFileSync(file, '{');
    else if (mode === 'checksum') fs.writeFileSync(file, JSON.stringify({ ...j, sha256: 'wrong' }));
    else {
      const c = v8.deserialize(zlib.inflateRawSync(Buffer.from(j.data, 'base64')));
      if (mode === 'version') c.version = -1;
      else if (mode === 'prose-index') c.facts.actions.proseIndex = [{ ts: 1, kind: 'text', offset: -1, length: 20 }];
      else c.facts.tasks.state = [];
      const data = zlib.deflateRawSync(v8.serialize(c));
      fs.writeFileSync(file, JSON.stringify({ data: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') }));
    }
    cache.clearTranscriptFactsMemory(); const r = countReads(f.file, f.facts);
    assert.ok(r.bytes >= fs.statSync(f.file).size, mode); assert.deepEqual(r.value, f.full());
  }
});

test('derived facts: concurrent atomic writers publish a complete private cache', async t => {
  const f = fixture(t); largePrefix(f);
  const run = i => new Promise((resolve, reject) => {
    const fd = fs.openSync(path.join(f.base, `writer-${i}`), 'w');
    const proc = cp.spawn(process.execPath, [worker, f.file], { stdio: ['ignore', fd, fd], env: process.env });
    proc.on('error', reject); proc.on('exit', code => { fs.closeSync(fd); code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)); });
  });
  await Promise.all([run(1), run(2), run(3)]);
  assert.equal(f.factsFiles().length, 1); assert.ok(child(f).bytes <= 512);
  if (process.platform !== 'win32') { // no POSIX modes on Windows
    assert.equal(fs.statSync(f.cacheDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(f.factsFiles()[0]).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(f.cacheDir).some(n => n.endsWith('.tmp')), false);
});

test('derived facts: deleted stores are not resurrected, including a drop during publication', t => {
  const f = fixture(t); fs.writeFileSync(f.file, f.jsonl([f.call(0, 'first')])); f.facts();
  fs.rmSync(core.storeDir(f.session), { recursive: true }); fs.rmSync(f.cacheDir, { recursive: true });
  cache.clearTranscriptFactsMemory(); fs.appendFileSync(f.file, f.jsonl([f.call(1, 'next')])); f.facts();
  core.cachedChangeMap(f.cwd, f.session, { root: f.cwd, prompts: true });
  core.siblingOverview(f.cwd, f.session, { root: f.cwd });
  core.sessionPrompts(f.cwd, f.session);
  assert.equal(fs.existsSync(f.cacheDir), false);
  core.ensureStore(f.session); fs.writeFileSync(core.logPath(f.session), ''); cache.clearTranscriptFactsMemory();
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (String(to).includes('transcript-facts-')) {
      fs.rmSync(core.storeDir(f.session), { recursive: true, force: true });
      fs.rmSync(f.cacheDir, { recursive: true, force: true });
    }
    return rename.call(this, from, to);
  };
  try { f.facts(); } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(f.cacheDir), false);
});

test('derived facts: new and removed subagents recompute overlapping edit authors', t => {
  const f = fixture(t), target = path.join(f.cwd, 'demo');
  const blob = core.writeBlob(f.session, Buffer.from('text'));
  for (const [i, ts] of [[1, 10], [2, 20], [3, 30]]) core.appendLog(f.session, { id: i, file: target, tool: 'Edit', ts: 1800000000000 + ts, beforeBlob: blob, afterBlob: blob, status: 'pending' });
  fs.writeFileSync(f.file, f.jsonl([f.row(1, 'assistant', [{ type: 'text', text: 'main reason' }]), f.call(10, 'main-a'), f.call(30, 'main-b')]));
  assert.equal(core.reasoningByEdit(f.cwd, f.session).get(2), 'main reason');
  assert.deepEqual(core.parseActions(f.cwd, f.session).map(a => a.editId), [1, 2]);
  const dir = path.join(core.projectDir(f.cwd), f.session, 'subagents'); fs.mkdirSync(dir, { recursive: true });
  const sub = path.join(dir, 'agent-child.jsonl');
  fs.writeFileSync(sub, f.jsonl([{ ...f.row(19, 'assistant', [{ type: 'text', text: 'child reason' }]), isSidechain: true }, { ...f.call(20, 'child'), isSidechain: true }]));
  assert.equal(core.reasoningByEdit(f.cwd, f.session).get(2), 'child reason');
  assert.deepEqual(core.parseActions(f.cwd, f.session).map(a => a.editId), [undefined, undefined]);
  fs.unlinkSync(sub);
  assert.equal(core.reasoningByEdit(f.cwd, f.session).get(2), 'main reason');
  assert.deepEqual(core.parseActions(f.cwd, f.session).map(a => a.editId), [1, 2]);
  assert.ok(core.parseTranscriptActions(f.file).every(a => a.editId === undefined));
});

test('derived facts: one project inventory per view batch, refreshed for the next batch', t => {
  const f = fixture(t); fs.writeFileSync(f.file, f.jsonl([f.row(0, 'user', 'start')]));
  const readdir = fs.readdirSync; let reads = 0;
  fs.readdirSync = function (p, ...args) { if (String(p) === core.projectDir(f.cwd)) reads++; return readdir.call(this, p, ...args); };
  try {
    core.withDerivedInventory(() => {
      for (let i = 0; i < 5; i++) core.siblingOverviewCached(f.cwd, 'sibling-' + i, { root: f.cwd });
      core.cachedChangeMap(f.cwd, f.session, { root: f.cwd });
    });
  } finally { fs.readdirSync = readdir; }
  assert.equal(reads, 1);
  fs.writeFileSync(path.join(core.projectDir(f.cwd), 'new-sibling.jsonl'), f.jsonl([f.row(1, 'user', 'new')]));
  assert.equal(core.withDerivedInventory(() => core.cachedChangeMap(f.cwd, f.session, { root: f.cwd })).summary.fleet, 1);
});

// Exercise the actual public CLI payloads, not a parallel projection that could hide a field change.
test('derived facts: CLI runs every synchronous view in the inventory scope', t => {
  const f = fixture(t), cli = path.join(f.base, 'oak.cjs');
  fs.writeFileSync(f.file, f.jsonl([f.row(0, 'user', 'start')]));
  require('esbuild').buildSync({ entryPoints: [process.env.OAK_DERIVE_CLI_SOURCE || path.resolve(__dirname, '../../cli/src/index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: cli, external: ['node-pty', '@oak-observatory/core', '@oak-observatory/tui'] });
  const value = child(f, ['cli', cli, 'views', '--views', 'sessions,processes', '--session', f.session, '--root', f.cwd], { OAK_DERIVE_REQUIRE_INVENTORY: '1' });
  assert.equal(value.__problems, undefined);
  assert.equal(value.sessions.sessions[0].id, f.session);
  assert.equal(value.processes.session, f.session);
});

// The JetBrains Overview polls the CLI's DEFAULT batch (`views --json` with no --views). This gate
// compared five of those eight, and one of the three blind spots — `observations` — rides a consumer
// the derive pass rewrote: a mutation of its payload kept the gate green. Read
// the list out of the CLI source so the gate and the batch it guards cannot drift apart.
const DEFAULT_VIEWS = /const DEFAULT = '([^']+)'/.exec(
  fs.readFileSync(path.resolve(__dirname, '../../cli/src/index.ts'), 'utf8'))[1];

test('derived facts: cached and uncached CLI payloads deeply equal for every fixture and benchmark copy', t => {
  const f = fixture(t), cli = path.join(f.base, 'oak.cjs');
  require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, '../../cli/src/index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: cli, external: ['node-pty', '@oak-observatory/core', '@oak-observatory/tui'] });
  const resetDerived = () => {
    fs.rmSync(f.cacheDir, { recursive: true, force: true });
    fs.rmSync(path.join(core.rootDir(), 'session-meta'), { recursive: true, force: true });
  };
  const inputs = [];
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory() && e.name !== 'subagents') walk(p); else if (e.isFile() && e.name.endsWith('.jsonl')) inputs.push(p); } }
  walk(__dirname);
  if (process.env.OAK_DERIVE_BENCHMARK) inputs.push(process.env.OAK_DERIVE_BENCHMARK);
  for (const source of inputs) {
    // Ensure repo-scoped multitask actually includes this copied session. Keep every source record.
    fs.writeFileSync(f.file, JSON.stringify({ cwd: f.cwd }) + '\n');
    const src = fs.openSync(source, 'r'), dest = fs.openSync(f.file, 'a'), chunk = Buffer.alloc(65536);
    try { let n; while ((n = fs.readSync(src, chunk, 0, chunk.length, null))) fs.writeSync(dest, chunk, 0, n); }
    finally { fs.closeSync(src); fs.closeSync(dest); }
    const subs = path.join(core.projectDir(f.cwd), f.session, 'subagents');
    fs.rmSync(path.dirname(subs), { recursive: true, force: true });
    const sourceSubs = source === process.env.OAK_DERIVE_BENCHMARK && process.env.OAK_DERIVE_BENCHMARK_SUBAGENTS
      ? process.env.OAK_DERIVE_BENCHMARK_SUBAGENTS : path.join(source.slice(0, -6), 'subagents');
    if (fs.existsSync(sourceSubs)) fs.cpSync(sourceSubs, subs, { recursive: true, preserveTimestamps: true });
    cache.clearTranscriptFactsMemory();
    resetDerived();
    // Discard unrelated persisted asks/usage by using the same freshly copied bytes for both runs.
    const args = ['cli', cli, 'views', '--views', DEFAULT_VIEWS, '--json', '--session', f.session, '--root', f.cwd];
    const env = { OAK_DERIVE_FIXED_NOW: '1801000000000', OAK_DERIVE_CWD: f.cwd };
    const uncached = child(f, args, { ...env, OAK_DERIVE_NO_CACHE: '1' });
    assert.equal(uncached.__problems, undefined, path.basename(source));
    assert.deepEqual(Object.keys(uncached).filter(k => k !== 'bytes').sort(), DEFAULT_VIEWS.split(',').sort(),
      'every view JetBrains asks for is in the comparison');
    assert.ok(uncached.multitask.agents.some(a => a.session === f.session), 'multitask must exercise the selected session');
    if (fs.existsSync(sourceSubs)) {
      assert.ok(uncached.multitask.agents.find(a => a.session === f.session).subagents.length > 0, 'subagent payload must be nonempty');
      assert.ok(uncached.sessions.sessions.some(s => s.id === f.session), 'sessions must include the parent');
    }
    resetDerived();
    const cold = child(f, args, env), warm = child(f, args, env);
    if (!process.env.OAK_DERIVE_REFERENCE_DIST) t.diagnostic('reference-dist arm NOT run: set OAK_DERIVE_REFERENCE_DIST=<path to a built core dist of the base commit> to compare against the original implementation; only cached-vs-uncached equality was verified');
    if (process.env.OAK_DERIVE_REFERENCE_DIST) {
      resetDerived();
      const original = child(f, args, { ...env, OAK_DERIVE_TEST_DIST: process.env.OAK_DERIVE_REFERENCE_DIST });
      assert.deepEqual(cold, original, `original parser ${path.basename(source)}`);
    }
    assert.deepEqual(cold, uncached, `cold ${path.basename(source)}`);
    assert.deepEqual(warm, uncached, `warm ${path.basename(source)}`);
    t.diagnostic(`Deep equality: ${path.basename(source)} (${fs.statSync(source).size} bytes), the CLI DEFAULT view batch, subagents=${fs.existsSync(sourceSubs)}`);
  }
  assert.ok(inputs.length >= 3);
});

test('derived facts: prompt projection persists and invalidates after results and malformed payloads', t => {
  const f = fixture(t); largePrefix(f);
  const original = core.sessionPrompts(f.cwd, f.session);
  const warm = child(f, ['prompts', f.file, f.cwd, f.session]);
  assert.equal(warm.bytes, 0, 'finished prompt projection needs no transcript body');
  assert.deepEqual(warm.prompts, original);
  const slot = fs.readdirSync(f.cacheDir).find(n => /^prompts-.*\.json$/.test(n));
  assert.ok(slot);
  const file = path.join(f.cacheDir, slot), j = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...j, value: [null] }));
  assert.deepEqual(core.sessionPrompts(f.cwd, f.session), original, 'malformed projection is recomputed');
  fs.appendFileSync(f.file, f.jsonl([f.result(5, 'delayed', 'failed', true)]));
  const next = child(f, ['prompts', f.file, f.cwd, f.session]);
  assert.equal(next.prompts[0].errors, 1);
  assert.ok(next.bytes < 2048, 'append advances the shared facts even after the outer projection expires');
});

test('derived facts: missing and non-file sources remain empty', t => {
  const f = fixture(t);
  assert.deepEqual(core.parseTranscriptActions(f.file), []);
  assert.deepEqual(core.taskSnaps(f.cwd), []);
  assert.deepEqual(core.parseTranscriptActions(f.cwd), []);
});

test('derived facts: benchmark cursor reads only a 2 KB append and guards', { skip: !process.env.OAK_DERIVE_BENCHMARK && 'set OAK_DERIVE_BENCHMARK=<a large local transcript> — cursor read amplification NOT verified' }, t => {
  const f = fixture(t); fs.copyFileSync(process.env.OAK_DERIVE_BENCHMARK, f.file);
  const initial = f.facts().actions.length;
  const row = f.result(1, 'benchmark-unmatched', '');
  row.message.content[0].content = 'x'.repeat(2048 - Buffer.byteLength(f.jsonl([row])));
  const append = f.jsonl([row]); assert.equal(Buffer.byteLength(append), 2048);
  fs.appendFileSync(f.file, append);
  const after = child(f);
  t.diagnostic(JSON.stringify({ sourceBytes: fs.statSync(f.file).size - 2048, appendedBytes: 2048, readBytes: after.bytes }));
  assert.equal(after.actions.length, initial);
  // 2048 appended + two stamps of GUARD_WINDOWS x GUARD_BYTES (verify, then re-stamp). The guards
  // are a CONSTANT, whatever the transcript's size, which is the property this budget protects.
  assert.ok(after.bytes <= 2048 + 2 * 512, `cursor fetched ${after.bytes} bytes`);
});

test('derived facts: benchmark subagent and process parsers read only the 2 KB append and guards', {
  skip: !process.env.OAK_DERIVE_BENCHMARK && 'set OAK_DERIVE_BENCHMARK=<a large local transcript> — cursor read amplification NOT verified',
}, t => {
  const f = fixture(t); fs.copyFileSync(process.env.OAK_DERIVE_BENCHMARK, f.file);
  const dir = path.join(core.projectDir(f.cwd), f.session, 'subagents'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-child.jsonl'), f.jsonl([{ ...f.call(0, 'child-read', 'Read'), isSidechain: true }]));
  const args = ['dependents', f.file, f.cwd, f.session], env = { OAK_DERIVE_FIXED_NOW: '1801000000000' };
  child(f, args, env);
  const row = f.result(1, 'benchmark-unmatched', '');
  row.message.content[0].content = 'x'.repeat(2048 - Buffer.byteLength(f.jsonl([row])));
  fs.appendFileSync(f.file, f.jsonl([row]));
  const after = child(f, args, env);
  t.diagnostic(JSON.stringify({ sourceBytes: fs.statSync(f.file).size - 2048, appendedBytes: 2048, dependentReadBytes: after.bytes }));
  assert.ok(after.bytes <= 4096, `dependent parsers fetched ${after.bytes} bytes`);
});

test('derived facts: benchmark parent facts stay warm through its subagent inventory', {
  skip: (!process.env.OAK_DERIVE_BENCHMARK || !process.env.OAK_DERIVE_BENCHMARK_SUBAGENTS)
    && 'set OAK_DERIVE_BENCHMARK=<a large local transcript> and OAK_DERIVE_BENCHMARK_SUBAGENTS=<its subagents dir> — parent cache retention NOT verified',
}, t => {
  const f = fixture(t); fs.copyFileSync(process.env.OAK_DERIVE_BENCHMARK, f.file);
  fs.cpSync(process.env.OAK_DERIVE_BENCHMARK_SUBAGENTS, path.join(core.projectDir(f.cwd), f.session, 'subagents'), { recursive: true, preserveTimestamps: true });
  f.facts();
  const mainSlot = f.factsFiles()[0];
  core.parseSubagents(f.cwd, f.session);
  cache.clearTranscriptFactsMemory();
  const read = fs.readFileSync; let loads = 0;
  fs.readFileSync = function (p, ...args) { if (String(p) === mainSlot) loads++; return read.call(this, p, ...args); };
  try {
    core.withDerivedInventory(() => { core.parseSubagents(f.cwd, f.session); core.sessionProcesses(f.cwd, f.session); });
  } finally { fs.readFileSync = read; }
  t.diagnostic(JSON.stringify({ parentCacheLoads: loads }));
  assert.equal(loads, 1, 'child facts must not evict the parent before attribution and process projection reuse it');
});

// The benchmark above needs a private transcript, so no gate ran it. The same
// property on synthetic data: a parent and its children sized to overflow the 32 MiB this memory once had
// and to fit the 64 MiB it has now. At 32 MiB the children evict the parent mid-batch and its cache is
// decoded again for the process projection.
test('derived facts: a large parent stays warm through its subagent inventory (synthetic)', t => {
  const f = fixture(t);
  const turns = (n, prefix, sidechain) => Array.from({ length: n }, (_, i) => ({
    ...f.row(i, 'assistant', [{ type: 'text', text: `${prefix} ${i} ` + 'reasoning '.repeat(200) },
      { type: 'tool_use', id: `${prefix}-${i}`, name: 'Edit', input: { file_path: path.join(f.cwd, 'demo') } }]),
    ...(sidechain ? { isSidechain: true } : {}) }));
  fs.writeFileSync(f.file, f.jsonl(turns(2900, 'main', false))); // ~24 MiB of facts in memory
  const dir = path.join(core.projectDir(f.cwd), f.session, 'subagents'); fs.mkdirSync(dir, { recursive: true });
  for (let c = 0; c < 8; c++) fs.writeFileSync(path.join(dir, `agent-child${c}.jsonl`), f.jsonl(turns(250, `child${c}`, true))); // ~2 MiB each
  f.facts();
  const mainSlot = f.factsFiles()[0];
  core.parseSubagents(f.cwd, f.session);
  cache.clearTranscriptFactsMemory();
  const read = fs.readFileSync; let loads = 0;
  fs.readFileSync = function (p, ...args) { if (String(p) === mainSlot) loads++; return read.call(this, p, ...args); };
  try {
    core.withDerivedInventory(() => { core.parseSubagents(f.cwd, f.session); core.sessionProcesses(f.cwd, f.session); });
  } finally { fs.readFileSync = read; }
  assert.equal(loads, 1, 'child facts must not evict the parent before attribution and process projection reuse it');
});

test('derived facts: persisted relative edit paths resolve in the consuming process', t => {
  const f = fixture(t);
  core.appendLog(f.session, { id: 1, file: path.join(f.cwd, 'relative.ts'), tool: 'Edit', ts: 1800000000001, beforeBlob: null, afterBlob: null, status: 'pending' });
  fs.writeFileSync(f.file, f.jsonl([f.row(0, 'assistant', [{ type: 'text', text: 'relative reasoning' }]), f.call(1, 'relative', 'Edit', { file_path: 'relative.ts' })]));
  core.parseTranscriptActions(f.file); // persisted from a different working directory
  const next = child(f, ['reasoning', f.file, f.cwd, f.session], { OAK_DERIVE_CWD: f.cwd });
  assert.deepEqual(next.reasoning, [[1, 'relative reasoning']]);
});

// The schema version is part of the cache FILE NAME, so the
// generation a bump supersedes is addressed by nothing — it used to survive every `oak clean`
// forever, one dead file per transcript per bump (471 files / 47.6 MB measured on a real store).
test('derived facts: a schema bump leaves no stale generation behind after a prune', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, f.jsonl([f.call(0, 'read-one', 'Read', { file_path: 'a.ts' })]));
  f.facts();
  const live = f.factsFiles().map(p => path.basename(p));
  assert.equal(live.length, 1, 'positive control: the real reader wrote exactly one facts payload');
  const version = Number(/^transcript-facts-v(\d+)-/.exec(live[0])[1]);
  assert.equal(version, cache.TRANSCRIPT_FACTS_VERSION, 'the name carries the live schema');
  // Two earlier generations of the same transcript, named the way those builds named them — plus a
  // PRE-VERSIONING name, which carries no v<N> at all and matched no sweep until this release.
  const older = [`transcript-facts-${'a'.repeat(64)}.json`,
    ...[version - 1, version - 2].map((v, i) => `transcript-facts-v${v}-${String(i).repeat(64)}.json`)];
  for (const name of older) fs.writeFileSync(path.join(f.cacheDir, name), JSON.stringify({ sha256: 'unreadable', data: '' }));
  // A publication in flight must survive the sweep: it is the live name plus a .tmp suffix.
  const inFlight = path.join(f.cacheDir, `${live[0]}.${process.pid}.deadbeef.tmp`);
  fs.writeFileSync(inFlight, 'partial');
  assert.equal(f.factsFiles().length, 4);
  const pruned = core.pruneStaleMaps(f.session);
  assert.equal(pruned.removed, older.length, 'every superseded generation is reclaimed');
  assert.ok(pruned.bytes > 0);
  assert.deepEqual(f.factsFiles().map(p => path.basename(p)), live, 'and only the live generation is left');
  assert.equal(fs.readFileSync(inFlight, 'utf8'), 'partial', 'a publication in flight is not swept');
  fs.rmSync(inFlight);
  assert.equal(core.pruneStaleMaps(f.session).removed, 0, 'a second sweep finds nothing');
  assert.deepEqual(f.facts().actions.map(a => a.target), ['a.ts'], 'the surviving cache still answers');
});

// Editing a fold and rebuilding was a silent no-op on any session whose
// facts were already cached: the cursor sits at EOF, so the persisted answer came back and the new
// code never ran. The folds' own source text is part of the cache key, so it cannot happen again.
test('derived facts: an edited fold cannot be served from the cache the old fold wrote', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, f.jsonl([
    f.call(0, 'shell', 'Bash', { command: 'printf ready' }),
    f.call(1, 'read-one', 'Read', { file_path: 'a.ts' }),
  ]));
  const warm = child(f);
  assert.deepEqual(warm.actions.map(a => a.tool).sort(), ['Bash', 'Read'], 'both calls are cached');
  const before = f.factsFiles();
  assert.equal(before.length, 1);

  // A contributor-shaped edit to a fold, in a COPY of the built dist: Bash calls stop being recorded.
  const edited = path.join(f.base, 'dist-edited');
  fs.cpSync(dist, edited, { recursive: true });
  const actions = path.join(edited, 'actions.js');
  const source = fs.readFileSync(actions, 'utf8');
  const marker = 'function foldActionFacts(state, o, includeSidechain, offset, length) {';
  assert.ok(source.includes(marker), 'positive control: the fold is where the key hashes it from');
  fs.writeFileSync(actions, source.replace(marker, `${marker}\n    if (o?.message?.content?.[0]?.name === 'Bash') return;`));

  // The copy lives outside the workspace, so bare requires ('diff', 'smol-toml') need NODE_PATH.
  const modules = path.resolve(__dirname, '../../../node_modules');
  const after = child(f, [f.file], { OAK_DERIVE_TEST_DIST: edited, NODE_PATH: modules });
  assert.deepEqual(after.actions.map(a => a.tool), ['Read'], 'the edited fold runs, against the very same transcript');
  const files = f.factsFiles();
  assert.equal(files.length, 2, 'it keyed its own cache instead of overwriting the other build');
  assert.deepEqual(child(f).actions.map(a => a.tool).sort(), ['Bash', 'Read'], 'and the unedited build is unaffected');
  t.diagnostic(JSON.stringify({ before: before.map(p => path.basename(p)), after: files.map(p => path.basename(p)) }));
});

// Two guards proved only that the first and last 128 bytes survived: a same-size
// rewrite of the INTERIOR plus an append passed as a pure append and republished obsolete facts.
test('derived facts: an interior rewrite under an append is detected, not folded onto', t => {
  const f = fixture(t);
  const pad = n => ({ ignored: 'p'.repeat(n) });
  const body = f.jsonl([pad(200), f.call(1, 'one', 'Read', { file_path: 'old-path' }), pad(200)]);
  fs.writeFileSync(f.file, body);
  assert.deepEqual(f.facts().actions.map(a => a.target), ['old-path']);
  cache.clearTranscriptFactsMemory(); // the persisted cache is the thing under test
  fs.writeFileSync(f.file, body.replaceAll('old-path', 'new-path') + f.jsonl([f.call(2, 'two', 'Read', { file_path: 'appended' })]));
  const cached = f.facts().actions.map(a => a.target);
  t.diagnostic(JSON.stringify({ cached, uncached: f.full().actions.map(a => a.target) }));
  assert.deepEqual(cached, ['new-path', 'appended'], 'the rewritten region is reparsed');
  assert.deepEqual(cached, f.full().actions.map(a => a.target), 'cached and uncached agree');
});

test('derived facts: prose stores byte locations and the feed reads only its selected lines', t => {
  const f = fixture(t);
  const prose = require(path.join(dist, 'actions.js'));
  const text = 'Complete 猫😀 reply '.repeat(500);
  const thought = 'Private plan '.repeat(2000);
  const rows = Array.from({ length: 30 }, (_, i) => f.row(i, 'assistant', [
    { type: 'thinking', thinking: thought }, { type: 'text', text: '  ' + text + '  ' },
    { type: 'text', text: 'final block' },
  ]));
  fs.writeFileSync(f.file, f.jsonl(rows));
  f.facts();
  const saved = v8.deserialize(zlib.inflateRawSync(Buffer.from(JSON.parse(fs.readFileSync(f.factsFiles()[0])).data, 'base64')));
  assert.ok(saved.facts.actions.prose === undefined, 'the shared facts retain no prose bodies');
  const index = saved.facts.actions.proseIndex;
  assert.equal(index.length, 60);
  assert.deepEqual(Object.keys(index[0]).sort(), ['kind', 'length', 'offset', 'ts']);
  assert.equal(index[0].length, Buffer.byteLength(JSON.stringify(rows[0])));
  const picked = index.slice(-2);
  const read = countReads(f.file, () => prose.readTranscriptProse(f.file, picked));
  assert.equal(read.bytes, picked[0].length, 'thinking and text share one line read, with no historical reads');
  assert.deepEqual(read.value.map(p => p.text), [thought.trim(), text.trim() + '\nfinal block']);
  const feed = core.liveFeed(f.cwd, f.session, { kind: 'session', id: '' }, { limit: 1 });
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].reasoning, read.value[1].text);
  assert.equal(feed.truncated, 59);
});

test('derived facts: prose offsets survive partial UTF-8 lines, appends and replacement', t => {
  const f = fixture(t);
  const prose = () => core.liveFeed(f.cwd, f.session, { kind: 'session', id: '' }).entries.filter(e => e.kind === 'reasoning').map(e => e.reasoning);
  const first = f.jsonl([f.row(1, 'assistant', [{ type: 'text', text: '猫😀 first' }])]);
  const second = JSON.stringify(f.row(2, 'assistant', [{ type: 'thinking', thinking: 'Second thought' }]));
  fs.writeFileSync(f.file, first + second);
  assert.deepEqual(prose(), ['猫😀 first', 'Second thought']);
  fs.appendFileSync(f.file, '\n'); cache.clearTranscriptFactsMemory();
  assert.deepEqual(prose(), ['猫😀 first', 'Second thought']);
  fs.writeFileSync(f.file, f.jsonl([f.row(3, 'assistant', [{ type: 'text', text: 'Replacement' }])]));
  assert.deepEqual(prose(), ['Replacement']);
});
