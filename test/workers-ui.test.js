const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'packages/vscode/src/extension.ts'), 'utf8');
const kotlin = p => fs.readFileSync(path.join(root, 'packages/jetbrains/src/main/kotlin/com/cellobservatory/observatory', p), 'utf8');

test('workers UI: both editor tab strips and grouped columns put Processes after Workers and Workflows last', () => {
  const group = source.match(/var NAV_GROUPS=(.*);/)[1];
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(group)))[0][2], ['sessions', 'fleet', 'processes', 'tasks', 'workflows']);
  const strip = source.slice(source.indexOf('function renderNavTabs()'), source.indexOf('function renderNavTabs()')+5000);
  assert.ok(strip.indexOf("['workflows','Workflows'") > strip.indexOf("['processes','Processes'"));
  assert.match(kotlin('model/NavGrouping.kt'), /listOf\(SESSIONS, FLEET, PROCESSES, TASKS, WORKFLOWS\)/);
  assert.match(kotlin('ui/ChangeMapPanel.kt'), /listOf\("sessions", "fleet", "processes", "tasks", "workflows"\)/);
});

function filter(data) {
  const code = source.slice(source.indexOf('export const multitaskFilter ='), source.indexOf('// Plain ES5 concatenation', source.indexOf('export const multitaskFilter =')));
  const context = { exports: {} };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.exports.multitaskFilter(data, { activeOnly: true }).agents;
}

test('workers UI: Active only hides finished children', () => {
  const rows = filter({ agents: [
    { session: 'parent', state: 'working', phase: 'working', subagents: [{ agentId: 'done', phase: 'done' }, { agentId: 'live', phase: 'working' }, { agentId: 'gone', phase: 'gone' }] },
  ] });
  assert.deepEqual(Array.from(rows[0].subagents, x => x.agentId), ['live']);
});

test('workers UI: Active only retains waiting and blocked workers and hides gone', () => {
  const rows = filter({ agents: [
    { session: 'parent', state: 'working', phase: 'working' },
    { session: 'wait', state: 'waiting', phase: 'idle' }, { session: 'blocked', state: 'blocked', phase: 'awaiting-input' },
    { session: 'gone', state: 'gone', phase: 'working' },
  ] });
  assert.deepEqual(Array.from(rows, x => x.session), ['parent', 'wait', 'blocked']);
});


test('queued agents: Active only keeps a queued worker with no conversation', () => {
  const rows = filter({ agents: [{ session: '', title: 'Queued job', state: 'queued', phase: 'idle', after: ['dep'] }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Queued job');
});
