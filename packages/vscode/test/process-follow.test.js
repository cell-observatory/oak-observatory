const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
for (const machine of [undefined, 'synthetic-box']) test(`editor process stream: ${machine || 'local'}, partial JSON, deadline and cancellation`, () => {
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'followProcessCli');
  assert.ok(declaration, 'the editor must use the processes --follow route');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout.setEncoding = () => {};
  let killed = 0, call, timeout;
  child.kill = () => killed++;
  const box = { core: { spawnTool: (...args) => { call = args; return child; }, plainProcessOutput: s => s },
    resolveObservatoryBin: () => 'synthetic-oak', process, SAVED_DEADLINE_MS: 45000,
    setTimeout: (f, ms) => { timeout = ms; return 1; }, clearTimeout() {}, };
  vm.runInNewContext(ts.transpile(declaration.getText(ast) + '\nglobalThis.follow = followProcessCli;', { target: ts.ScriptTarget.ES2022 }), box);
  const seen = [], errors = [];
  const stop = box.follow('parent', 'shell-0', '/synthetic', machine, s => seen.push(s), e => errors.push(e));
  assert.deepEqual(Array.from(call[1]).slice(0, 3), ['processes', '--follow', 'shell-0']);
  assert.equal(timeout, 50000);
  assert.equal(call[2].env.OAK_MACHINE_TIMEOUT_MS, '45000');
  if (machine) { assert.ok(call[1].includes(machine)); assert.ok(!call[1].includes('--root')); }
  else assert.ok(call[1].includes('/synthetic'));
  const line = text => JSON.stringify({ processLogVersion: 1, ref: { kind: 'process', id: 'shell-0' }, process: { running: true }, entries: [{ kind: 'output', label: text }], outputTail: text }) + '\n';
  child.stdout.emit('data', line('FIRST').slice(0, 18));
  assert.equal(seen.length, 0);
  child.stdout.emit('data', line('FIRST').slice(18) + line('APPENDED'));
  assert.deepEqual(seen.map(s => s.outputTail), ['FIRST', 'APPENDED']);
  stop(); child.stdout.emit('data', line('STALE'));
  assert.equal(killed, 1); assert.equal(seen.length, 2); assert.deepEqual(errors, []);
});

test('Overview list reads on a saved machine use the shared deadline', () => {
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'spawnCliJson');
  let call, timeout, answer;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
  const box = { core: { spawnTool: (...args) => { call = args; return child; } }, process,
    resolveObservatoryBin: () => 'synthetic-oak', CLI_SPAWN_TIMEOUT_MS: 120000, SAVED_DEADLINE_MS: 45000,
    setTimeout: (_, ms) => { timeout = ms; return 1; }, clearTimeout() {} };
  vm.runInNewContext(ts.transpile(declaration.getText(ast) + '\nglobalThis.read = spawnCliJson;', { target: ts.ScriptTarget.ES2022 }), box);
  box.read(['views', '--views', 'changemap,multitask,processes', '--session', 'parent', '--machine', 'build-box'], '/synthetic', data => { answer = data; });
  assert.equal(timeout, 50000);
  assert.equal(call[2].env.OAK_MACHINE_TIMEOUT_MS, '45000');
  child.stdout.emit('data', '{"processes":{"processes":[],"summary":{"total":0}}}'); child.emit('close');
  assert.equal(answer.processes.processes.length, 0);
});

test('Processes empty state is visible and agent-neutral before and after a CLI answer', () => {
  const render = source.match(/  function renderProcesses\(\)\{[\s\S]*?\n  \}/)[0];
  const host = { innerHTML: '' };
  const box = { paneHost: () => host, scopeNote: () => '', OV_SEEN: false, PR: null, PR_ERR: '', esc: String };
  vm.runInNewContext(render + '\nglobalThis.render = renderProcesses;', box);
  box.render(); assert.match(host.innerHTML, /Reading/);
  box.OV_SEEN = true; box.render(); assert.match(host.innerHTML, /No answer/);
  box.PR = { processes: [], summary: { total: 0, running: 0, failed: 0 } };
  box.render(); assert.match(host.innerHTML, /No shells in this session/);
  // A saved machine that did not answer says why, as the terminal app does; never "update the CLI on PATH".
  box.PR = null; box.PR_ERR = 'oak: no saved machine "nosuchbox"';
  box.render(); assert.match(host.innerHTML, /Processes unavailable: oak: no saved machine "nosuchbox"/); assert.doesNotMatch(host.innerHTML, /CLI on PATH/);
});

test('a saved machine\'s failed Processes read keeps its reason (review 2026-11-05)', () => {
  // The read hands its caller the CLI's stderr on a failure.
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'spawnCliJson');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const box = { core: { spawnTool: () => child }, process, resolveObservatoryBin: () => 'synthetic-oak', CLI_SPAWN_TIMEOUT_MS: 120000,
    SAVED_DEADLINE_MS: 45000, setTimeout: () => 1, clearTimeout() {} };
  vm.runInNewContext(ts.transpile(declaration.getText(ast) + '\nglobalThis.read = spawnCliJson;', { target: ts.ScriptTarget.ES2022 }), box);
  let got;
  box.read(['views', '--views', 'processes', '--json', '--session', 's', '--machine', 'nosuchbox'], '/synthetic', (data, why) => { got = [data, why]; });
  child.stderr.emit('data', 'oak: no saved machine "nosuchbox"\n'); child.emit('close');
  assert.deepEqual(got, [null, 'oak: no saved machine "nosuchbox"\n']);
  // And the Overview turns it into the panel's reason.
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'machineProcessesFailure');
  const fbox = { core: require('../../core/dist') };
  vm.runInNewContext(ts.transpile(fn.getText(ast) + '\nglobalThis.why = machineProcessesFailure;'), fbox);
  assert.match(fbox.why('nosuchbox', null, null, got[1]), /no saved machine "nosuchbox"/);
  assert.equal(fbox.why('lab', { __problems: { processes: 'synthetic read error' } }, null), 'synthetic read error');
  assert.equal(fbox.why('lab', {}, null), 'lab did not return its background shells');
  assert.equal(fbox.why(undefined, null, null, 'x'), '', 'this machine keeps the update-the-CLI text');
  assert.equal(fbox.why('lab', null, { processes: [] }), '', 'they arrived');
});
