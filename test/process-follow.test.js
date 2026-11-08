const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const core = require('../packages/core/dist');
const { indexFixture } = require('../packages/core/test/fixtures/index-fixture.cjs');

function fixture(t, count = 1) {
  const b = indexFixture(t, core);
  const outputs = Array.from({ length: count }, (_, i) => path.join(b.dir, `task-${i}.output`));
  const records = outputs.flatMap((file, i) => {
    fs.writeFileSync(file, `START ${i}\n`);
    return [
      { type: 'assistant', timestamp: '2026-10-01T10:00:00Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: `tool-${i}`, name: 'Bash', input: { command: `build-${i}`, description: `Build ${i}`, run_in_background: true } }] } },
      { type: 'user', timestamp: '2026-10-01T10:00:01Z', toolUseResult: { backgroundTaskId: `shell-${i}` }, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `tool-${i}`, content: `Output is being written to: ${file}` }] } },
    ];
  });
  const transcript = b.claude('parent', b.work, records);
  const finish = (i = 0) => fs.appendFileSync(transcript, b.lines([{ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T10:02:00Z',
    content: `<task-notification><task-id>shell-${i}</task-id><status>completed</status><summary>exit code 0</summary></task-notification>` }]));
  return { ...b, outputs, transcript, records, finish };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3500) {
  for (let n = 0; n < ms / 25; n++) { if (fn()) return; await delay(25); }
  assert.fail('process feed did not update');
}

test('process output is plain text, including OSC, CSI, DCS, C0 and C1 controls', t => {
  const b = fixture(t);
  fs.writeFileSync(b.outputs[0], '\x01hello\x0e\x1b[2J\x1b[H\x1b]0;bad title\x07\x1bPpayload\x1b\\\x1b[31m red\x1b[0m\u009b2J\r\nworld\x0f\x1b]2;unfinished');
  assert.equal(core.processOutputTail(b.outputs[0]), 'hello red\nworld');
});

// An OSC string that never ends backtracked quadratically on a long run of C1 OSC introducers (CodeQL's
// js/polynomial-redos input); the timeout stops a regression instead of hanging the run.
test('process output stays fast on a long run of OSC introducers', () => {
  const plain = () => core.plainProcessOutput('\u009d'.repeat(100_000) + '\x1bx');
  assert.equal(require('node:vm').runInNewContext('plain()', { plain }, { timeout: 2000 }), '');
});

for (const pollOnly of [false, true]) test(`process follow ${pollOnly ? 'poll fallback' : 'watch'} updates appends, rotates, stops and cancels`, async t => {
  const b = fixture(t), seen = [];
  const stop = core.followProcessOutput(b.work, 'parent', 'shell-0', { onSnapshot: s => seen.push(s), onError: e => { throw e; }, pollMs: pollOnly ? 40 : 2000, ...(pollOnly ? { watch: () => { throw new Error('watch unavailable'); } } : {}) });
  t.after(stop);
  assert.equal(seen[0].outputTail, 'START 0\n');
  await delay(130);
  assert.equal(seen.length, 1, 'idle polling must not emit');
  fs.appendFileSync(b.outputs[0], 'APPENDED\nAPPENDED\n');
  await until(() => seen.at(-1).outputTail.includes('APPENDED'));
  assert.equal(seen.at(-1).outputDelta, 'APPENDED\nAPPENDED\n');
  fs.renameSync(b.outputs[0], b.outputs[0] + '.old');
  fs.writeFileSync(b.outputs[0], 'ROTATED\n');
  await until(() => seen.at(-1).outputTail === 'ROTATED\n');
  b.finish();
  await until(() => seen.at(-1).process.running === false);
  const n = seen.length;
  fs.appendFileSync(b.outputs[0], 'AFTER END\n');
  await delay(130);
  assert.equal(seen.length, n);
});

test('process snapshots authorize ids and include a worker shell', t => {
  const b = fixture(t);
  assert.throws(() => core.processSnapshot(b.work, 'parent', b.outputs[0]), /no background shell/);
  const worker = path.join(path.dirname(b.transcript), 'parent/subagents/agent-worker.jsonl');
  b.write(worker, b.records.map(r => ({ ...r, isSidechain: true })));
  const snapshot = core.processSnapshot(b.work, 'parent', 'worker:shell-0');
  const listing = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../packages/cli/dist/index.js'), 'processes', '--session', 'parent', '--root', b.work], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /worker:shell-0/, 'the listed worker id must work with --follow');
  assert.equal(snapshot.process.workerId, 'worker');
  assert.equal(snapshot.outputTail, 'START 0\n');
});

test('a worker shell ends from the queued-command attachment its transcript records (2026-11-05)', t => {
  const b = fixture(t);
  const worker = path.join(path.dirname(b.transcript), 'parent/subagents/agent-worker.jsonl');
  // The shape a worker's transcript gives a background shell's end: no queue-operation record, an attachment instead.
  b.write(worker, [...b.records.map(r => ({ ...r, isSidechain: true })), { type: 'attachment', isSidechain: true, timestamp: '2026-10-01T10:03:00Z',
    attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>shell-0</task-id>\n<tool-use-id>tool-0</tool-use-id>\n<status>completed</status>\n<summary>Background command finished with exit code 0</summary>\n</task-notification>' } }]);
  const shell = core.sessionProcesses(b.work, 'parent').find(p => p.workerId === 'worker');
  assert.equal(shell.running, false, 'a worker shell that ended is not listed as running');
  assert.equal(shell.status, 'completed');
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.endedTs, Date.parse('2026-10-01T10:03:00Z'));
  assert.equal(core.sessionProcesses(b.work, 'parent').find(p => !p.workerId).running, true, 'the parent shell has no end and still runs');
});

test('a worker shell with no end stops counting as running once its worker has ended and it has gone quiet (2026-11-05)', t => {
  const b = fixture(t);
  const worker = path.join(path.dirname(b.transcript), 'parent/subagents/agent-worker.jsonl');
  b.write(worker, b.records.map(r => ({ ...r, isSidechain: true })));
  const stamp = ms => { const d = new Date(ms); fs.utimesSync(b.outputs[0], d, d); };
  stamp(Date.parse('2026-10-01T10:00:30Z'));
  const workerShell = () => core.sessionProcesses(b.work, 'parent').find(p => p.workerId === 'worker');
  assert.equal(workerShell().running, true, 'no notice for the worker yet: it may still report');
  // The parent logs the worker's own completion; the worker never logged one for its shell.
  fs.appendFileSync(b.transcript, b.lines([{ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T10:05:00Z',
    content: '<task-notification><task-id>worker</task-id><status>completed</status><summary>Agent finished</summary></task-notification>' }]));
  assert.equal(workerShell().running, false, 'its worker has ended and the shell has written nothing since');
  assert.equal(workerShell().status, 'no end recorded');
  stamp(Date.parse('2026-10-01T10:06:00Z'));
  assert.equal(workerShell().running, false, 'output within two minutes of its worker\'s end trails that end');
  stamp(Date.parse('2026-10-01T10:07:30Z'));
  assert.equal(workerShell().running, true, 'output written after its worker ended: still running');
  assert.equal(core.sessionProcesses(b.work, 'parent').find(p => !p.workerId).running, true, 'the parent\'s own shell is unaffected');
});

test('a worker\'s end with no timestamp decides nothing about its shells (review 2026-11-05)', t => {
  const b = fixture(t);
  const worker = path.join(path.dirname(b.transcript), 'parent/subagents/agent-worker.jsonl');
  // Neither the shell's records nor its output file (reaped) say when it last did anything.
  b.write(worker, b.records.map(({ timestamp, ...r }) => ({ ...r, isSidechain: true })));
  fs.rmSync(b.outputs[0]);
  const workerShell = () => core.sessionProcesses(b.work, 'parent').find(p => p.workerId === 'worker');
  const notice = timestamp => fs.appendFileSync(b.transcript, b.lines([{ type: 'queue-operation', operation: 'enqueue', ...(timestamp ? { timestamp } : {}),
    content: '<task-notification><task-id>worker</task-id><status>completed</status><summary>Agent finished</summary></task-notification>' }]));
  notice();
  assert.equal(workerShell().running, true, 'an end at no known time is not compared with the shell\'s evidence');
  notice('2026-10-01T10:05:00Z');
  assert.equal(workerShell().status, 'no end recorded', 'control: an end with a time does end the shell');
});

test('a foreground worker\'s quiet shell stops counting as running once the worker\'s spawn has returned (review 2026-11-05)', t => {
  const b = fixture(t);
  const worker = path.join(path.dirname(b.transcript), 'parent/subagents/agent-worker.jsonl');
  b.write(worker, b.records.map(r => ({ ...r, isSidechain: true })));
  const stamp = ms => { const d = new Date(ms); fs.utimesSync(b.outputs[0], d, d); };
  stamp(Date.parse('2026-10-01T10:00:30Z'));
  const workerShell = () => core.sessionProcesses(b.work, 'parent').find(p => p.workerId === 'worker');
  assert.equal(workerShell().running, true, 'control: the worker has not returned yet');
  // A foreground worker ends with its Agent call's tool result in the parent (no background completion notice).
  fs.appendFileSync(b.transcript, b.lines([
    { type: 'assistant', timestamp: '2026-10-01T10:00:05Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'spawn-1', name: 'Agent', input: { description: 'Worker', prompt: 'p', subagent_type: 'general-purpose' } }] } },
    { type: 'user', timestamp: '2026-10-01T10:04:00Z', toolUseResult: { agentId: 'worker', status: 'completed', totalDurationMs: 235000, totalTokens: 10, totalToolUseCount: 1 },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'done' }] } }]));
  assert.equal(workerShell().running, false, 'its worker returned and the shell has written nothing since');
  assert.equal(workerShell().status, 'no end recorded');
});

test('Codex yielded exec sessions expose recorded output and write_stdin completion without guessing files', t => {
  const b = fixture(t);
  const record = payload => ({ type: 'response_item', timestamp: '2026-10-01T10:00:00Z', payload });
  const file = b.rollout('codex-shell', b.work, [
    record({ type: 'function_call', name: 'exec_command', call_id: 'exec-1', arguments: JSON.stringify({ cmd: 'npm test' }) }),
    record({ type: 'function_call_output', call_id: 'exec-1', output: 'Process running with session ID 123\nOutput:\nCODEX FIRST\n' }),
  ]);
  let snapshot = core.processSnapshot(b.work, 'codex-shell', 'codex-123');
  assert.equal(snapshot.process.running, true);
  assert.equal(snapshot.process.outputPath, null);
  assert.equal(snapshot.outputTail, 'CODEX FIRST\n');
  fs.appendFileSync(file, b.lines([
    record({ type: 'function_call', name: 'write_stdin', call_id: 'poll-1', arguments: JSON.stringify({ session_id: 123, chars: '' }) }),
    record({ type: 'function_call_output', call_id: 'poll-1', output: 'Process exited with code 0\nOutput:\nCODEX END\n' }),
  ]));
  snapshot = core.processSnapshot(b.work, 'codex-shell', 'codex-123', snapshot);
  assert.equal(snapshot.process.exitCode, 0);
  assert.equal(snapshot.outputDelta, 'CODEX END\n');
  assert.match(snapshot.note, /no output file/);
});

test('one refresh with 20 running shells and a 50 MB output uses bounded tail reads', t => {
  const b = fixture(t, 20);
  const fd = fs.openSync(b.outputs[0], 'w');
  fs.ftruncateSync(fd, 50 * 1024 * 1024);
  fs.writeSync(fd, Buffer.from('\nLARGE END\n'), 0, 11, 50 * 1024 * 1024 - 11);
  fs.closeSync(fd);
  core.sessionProcesses(b.work, 'parent'); // warm the transcript cursor
  const read = fs.readSync;
  let bytes = 0;
  fs.readSync = function(fd, buf, offset, length, position) { bytes += length; return read.call(this, fd, buf, offset, length, position); };
  const started = performance.now();
  let result;
  try { result = core.processView(b.work, 'parent', { selected: 'shell-0', previews: ['shell-1', 'shell-2', 'shell-3'] }); }
  finally { fs.readSync = read; }
  const elapsed = performance.now() - started;
  assert.equal(result.processes.length, 20);
  assert.match(result.selected.outputTail, /LARGE END/);
  assert.ok(bytes <= 16 * 1024 + 3 * 2048, `read ${bytes} bytes`);
  assert.ok(elapsed < 250, `refresh took ${elapsed} ms`);
  t.diagnostic(`20 processes, 50 MB file: ${elapsed.toFixed(2)} ms, ${bytes} requested bytes`);
});

for (const json of [false, true]) test(`CLI process follow streams appends (${json ? 'JSON snapshots' : 'text'})`, async t => {
  const b = fixture(t);
  const child = cp.spawn(process.execPath, [path.resolve(__dirname, '../packages/cli/dist/index.js'), 'processes', '--session', 'parent', '--root', b.work,
    '--follow', 'shell-0', ...(json ? ['--json'] : [])], { env: process.env });
  t.after(() => child.kill());
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const exit = new Promise(r => child.once('exit', r));
  await until(() => out.includes('START 0'));
  fs.appendFileSync(b.outputs[0], 'NEW OUTPUT\n');
  await until(() => out.includes('NEW OUTPUT'));
  b.finish();
  assert.equal(await Promise.race([exit, delay(3500).then(() => 'timeout')]), 0, err);
  if (json) {
    const snapshots = out.trim().split('\n').map(JSON.parse);
    assert.equal(snapshots.at(-1).process.exitCode, 0);
    assert.ok(snapshots.every(s => s.processLogVersion === 1));
  } else assert.equal(out.split('START 0').length - 1, 1);
});


test('CLI process follow reads appended output on the saved machine through fake SSH', { skip: process.platform === 'win32' }, async t => {
  const b = fixture(t), bin = path.join(b.dir, 'bin'), remote = path.join(b.dir, 'remote');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(remote, '.local/bin'), { recursive: true });
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'));
  for (const name of ['ssh', 'herdr']) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
  const cli = path.resolve(__dirname, '../packages/cli/dist/index.js');
  fs.writeFileSync(path.join(remote, '.local/bin/oak'), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o755 });
  const work = path.join(remote, 'work'); fs.mkdirSync(work);
  const output = path.join(remote, 'remote.output'); fs.writeFileSync(output, 'REMOTE FIRST\n');
  const transcript = path.join(remote, '.claude/projects', work.replace(/[^a-zA-Z0-9]/g, '-'), 'parent.jsonl');
  b.write(transcript, b.records.map(r => JSON.parse(JSON.stringify({ ...r, cwd: work }).replaceAll(b.outputs[0], output))));
  fs.writeFileSync(b.outputs[0], 'LOCAL MUST NEVER APPEAR\n');
  const log = path.join(b.dir, 'ssh.log');
  const child = cp.spawn(process.execPath, [cli, 'processes', '--session', 'parent', '--follow', 'shell-0', '--machine', 'build-box', '--json'], {
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FAKE_REMOTE_HOME: remote, MACHINE_EXEC_LOG: log, OAK_MACHINE_TIMEOUT_MS: '45000' },
  });
  t.after(() => child.kill());
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const exit = new Promise(r => child.once('exit', r));
  await until(() => out.includes('REMOTE FIRST'), 6000).catch(e => { throw new Error(e.message + ': ' + err + ' ' + out); });
  fs.appendFileSync(output, 'REMOTE APPEND\n');
  fs.appendFileSync(transcript, b.lines([{ type: 'queue-operation', timestamp: '2026-10-01T10:02:00Z', content: '<task-notification><task-id>shell-0</task-id><status>completed</status><summary>exit code 0</summary></task-notification>' }]));
  await until(() => out.includes('REMOTE APPEND'), 14000);
  assert.equal(await Promise.race([exit, delay(3000).then(() => 'timeout')]), 0, err);
  assert.doesNotMatch(out, /LOCAL MUST NEVER/);
  const snapshots = out.trim().split('\n').map(JSON.parse);
  assert.equal(snapshots.at(-1).process.exitCode, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /processes/);
});

test('Observatory lists running shells, folds finished shells and tails the selected output', t => {
  const tui = require('../packages/tui/dist');
  const stateFixture = require('../packages/tui/test/fixtures/observatory').fixture;
  const b = fixture(t, 2); b.finish(1);
  let state = tui.selectAndPin(stateFixture(), 'parent', 'obs-detail', 'local');
  let detail = state.observatory.details['obs-detail'];
  detail.processes = core.processView(b.work, 'parent');
  detail.loading = false;
  const rows = () => tui.observatoryDetailRows(state, 120, tui.glyphs('ascii'), 'none');
  const text = () => rows().map(r => r.cells).join('\n');
  assert.match(text(), /Build 0.*running/);
  assert.match(text(), /1 finished/);
  assert.doesNotMatch(text(), /Build 1/);
  const fold = rows().find(r => r.cells.includes('1 finished'));
  state.open = new Set([fold.openPath]);
  assert.match(text(), /Build 1.*completed.*exit 0/);
  const shell = rows().find(r => r.cells.includes('Build 0'));
  assert.equal(shell.scope.processId, 'shell-0');
  state = tui.selectAndPin(state, 'parent', 'obs-detail', 'local', shell.scope);
  detail = state.observatory.details['obs-detail'];
  detail.processes = core.processView(b.work, 'parent', { selected: 'shell-0' });
  assert.match(text(), /START 0/);
  fs.appendFileSync(b.outputs[0], 'NEW OBSERVATORY OUTPUT\n');
  state.observatory.details['obs-detail'] = { ...detail, processes: core.processView(b.work, 'parent', { selected: 'shell-0' }) };
  assert.match(text(), /NEW OBSERVATORY OUTPUT/);
});

for (const machine of ['local', 'build']) test(`Processes header follows Workers for empty, preview and unavailable sessions: ${machine}`, () => {
  const tui = require('../packages/tui/dist');
  let state = tui.selectAndPin(require('../packages/tui/test/fixtures/observatory').fixture(), 'parent', 'obs-detail', machine);
  for (const mode of ['empty', 'error', 'preview']) {
    const detail = state.observatory.details['obs-detail'];
    if (mode === 'preview') delete state.observatory.details['obs-detail'];
    else state.observatory.details['obs-detail'] = { ...detail, loading: false, processes: { processes: [], previews: {} }, processError: mode === 'error' ? 'synthetic unavailable' : undefined };
    const rows = tui.observatoryDetailRows(state, 120, tui.glyphs('ascii'), 'none').map(r => r.cells);
    const workers = rows.indexOf('Workers · 0');
    assert.ok(workers >= 0, mode + ': Workers header');
    assert.equal(rows[workers + 1], 'Processes · 0', mode + ': Processes immediately below Workers');
    assert.ok(rows.indexOf('Tasks · 0') > workers + 1);
    if (mode === 'error') assert.equal(rows[workers + 2], 'Processes unavailable: synthetic unavailable');
    if (mode === 'empty') assert.equal(rows[workers + 2], '  No shells in this session');
  }
});

test('dashboard processes: synthetic 1,000 shells, worker, Codex and saved machine through fake SSH', { skip: process.platform === 'win32' }, async t => {
  const { processDashboard } = require('./fixtures/process-dashboard.cjs');
  const tui = require('../packages/tui/dist');
  const { createConversationReader } = require('../packages/tui/dist/backend');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oak-process-dashboard-'));
  const fx = processDashboard(dir), oldEnv = { ...process.env }, oldArg = process.argv[1];
  Object.assign(process.env, fx.env); process.argv[1] = path.resolve(__dirname, '../packages/cli/dist/index.js');
  core.clearRootMemo(); core.clearFsCache();
  const reader = createConversationReader(core, fx.local.work);
  t.after(() => {
    reader.close(); process.argv[1] = oldArg;
    for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k];
    Object.assign(process.env, oldEnv); core.clearRootMemo(); core.clearFsCache(); core.resetIndexRuntime();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const machine of [undefined, 'build-box']) {
    let state = tui.selectAndPin(require('../packages/tui/test/fixtures/observatory').fixture(), 'parent', 'obs-detail', machine ? 'build' : 'local');
    const start = performance.now();
    const view = await reader.processes('parent', fx.local.work, undefined, ['shell-0', 'shell-999'], machine);
    state.observatory.details['obs-detail'] = { ...state.observatory.details['obs-detail'], loading: false, processes: view };
    const rows = () => tui.observatoryDetailRows(state, 120, tui.glyphs('ascii'), 'none');
    const first = rows(), elapsed = performance.now() - start;
    assert.ok(Array.isArray(view.processes), JSON.stringify(view));
    assert.equal(view.processes.length, 1000);
    assert.equal(view.processes.filter(p => p.running).length, 2);
    assert.deepEqual(Object.keys(view.previews), ['shell-0'], 'only requested running previews');
    assert.ok(first.some(r => r.cells === 'Processes · 2/1000 running'));
    assert.match(first.map(r => r.cells).join('\n'), /998 finished/);
    assert.ok(elapsed < 5000, `TUI refresh took ${elapsed} ms`);
    t.diagnostic(`TUI ${machine || 'local'} 1,000-shell read + collapsed render: ${elapsed.toFixed(2)} ms`);
    const fold = first.find(r => r.openPath?.endsWith(':Processes'));
    state.open = new Set([fold.openPath]);
    const finished = rows().find(r => r.scope?.processId === 'worker:shell-999');
    assert.ok(finished, 'worker shell survives expanding the finished group');
    state = tui.selectAndPin(state, 'parent', 'obs-detail', machine ? 'build' : 'local', finished.scope);
    state.observatory.details['obs-detail'].processes = await reader.processes('parent', fx.local.work, finished.scope.processId, [], machine);
    assert.match(rows().map(r => r.cells).join('\n'), new RegExp(`${machine ? 'REMOTE' : 'LOCAL'} OUTPUT 999`));
    const empty = await reader.processes('empty', fx.local.work, undefined, [], machine);
    assert.equal(empty.processes.length, 0);
    const codex = await reader.processes('codex-shell', fx.local.work, 'codex-123', [], machine);
    assert.equal(codex.processes.length, 1);
    assert.match(codex.selected.outputTail, new RegExp(`${machine ? 'REMOTE' : 'LOCAL'} CODEX`));
  }
  assert.match(fs.readFileSync(fx.log, 'utf8'), /processes/);
  // A large output file and 998 finished shells do not turn a list refresh into whole-file reads.
  const fd = fs.openSync(fx.local.output, 'w'); fs.ftruncateSync(fd, 50 * 1024 * 1024); fs.closeSync(fd);
  core.sessionProcesses(fx.local.work, 'parent');
  const originalRead = fs.readSync; let bytes = 0;
  fs.readSync = function(fd, buffer, offset, length, position) { bytes += length; return originalRead.call(this, fd, buffer, offset, length, position); };
  try { core.processView(fx.local.work, 'parent', { previews: ['shell-0', 'shell-1', 'worker:shell-999'] }); }
  finally { fs.readSync = originalRead; }
  assert.ok(bytes <= 4096, `visible running previews requested ${bytes} bytes`);
  t.diagnostic(`1,000-shell refresh, 50 MB output: ${bytes} requested output bytes`);
});
