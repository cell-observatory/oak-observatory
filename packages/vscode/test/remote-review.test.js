// Drive the production provider, shared read cache and webview with synthetic --machine replies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(process.env.RV1_VS_SOURCE || path.join(__dirname, '../src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const declarations = new Map();
for (const n of ast.statements) {
  if (n.name) declarations.set(n.name.getText(ast), n.getText(ast));
  if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) declarations.set(d.name.getText(ast), 'const ' + d.getText(ast) + ';');
}
const names = ['remoteReviewReads', 'remoteReviewListeners', 'readRemoteReview', 'selectRemoteReviewFile', 'remoteDecision', 'ReviewViewProvider', 'FileHistoryProvider'];
function harness() {
  const calls = [], posts = [], commands = [], notices = [];
  let fail = false, machine = 'lab-a', pending = [];
  const units = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1, members: [i + 1], file: '/remote/f' + i + '.ts', rel: 'f' + i + '.ts', tool: 'Edit', status: i === 2 ? 'undone' : 'pending', ts: 1, added: 1, removed: 0 }));
  const core = { ...require('../../core/dist'), reviewEdits() { throw new Error('local review read'); }, cancelledMemberIds() { throw new Error('local cancelled read'); }, keepGroup() { throw new Error('local mutation'); } };
  const box = { core, console, Date, Map, Set, setTimeout, clearTimeout, SAVED_READ_MS: 10000, editFilter: '', filterExts: [], filterCats: [],
    currentSort: () => 'name', filterSpecMsg: () => ({ exts: [], categories: [] }), currentMachine: () => machine, currentSession: () => 'same-id', resolveObservatoryBin: () => 'fake-oak',
    mountedReviews: new Map(), activeEditorFile: () => undefined, remoteReviewFile: undefined, remoteReviewCursor: undefined, remoteReviewPrompt: () => null, refreshMountedReview: async () => {}, navigateRemoteReview: async () => {}, forceRefreshAll: null, reviewShell: () => '', tmOnThemeChanged() {},
    vscode: { EventEmitter: class { event() {} fire() {} }, TreeItem: class { constructor(label) { this.label = label; } },
      commands: { executeCommand: async (...a) => { commands.push(a); } },
      window: { showWarningMessage: async m => { notices.push(m); return 'Continue'; }, showInputBox: async () => '1',
        showErrorMessage: m => notices.push(m), setStatusBarMessage: m => notices.push(m) } },
    oakOn: async (m, args) => {
      calls.push([...args, '--machine', m]);
      if (args[0] !== 'views') return { json: { kept: 1 }, why: '' };
      await new Promise(r => pending.push(r));
      const selected = args.includes('--prompt') ? [units[1]] : units;
      return fail ? { json: null, why: 'ssh: Connection refused' } : { json: { review: { units: selected, ids: selected.map(u => u.id), cancelled: [], cancelledIds: [], errors: [], ...(args.includes('--prompt') ? { prompt: {index:2,title:'Second ask'} } : {}) }, timeline: { edits: units } }, why: '' };
    } };
  vm.runInNewContext(ts.transpile(names.map(n => declarations.get(n) || '').join('\n') + '\nglobalThis.P = ReviewViewProvider; globalThis.H = FileHistoryProvider; globalThis.reads = typeof remoteReviewReads === "undefined" ? new Map() : remoteReviewReads;', { target: ts.ScriptTarget.ES2022 }), box);
  const p = new box.P(() => null);
  let message;
  const view = { visible: true, webview: { postMessage: m => posts.push(m), onDidReceiveMessage: fn => { message = fn; } }, onDidChangeVisibility() {} };
  p.resolveWebviewView(view);
  const action = p.remoteAction?.bind(p);
  if (action) p.remoteAction = m => action({ machine: 'lab-a', session: 'same-id', prompt: null, ...m });
  p.onMutate = () => { for (const r of box.reads.values()) r.at = 0; };
  return { p, view, box, units, posts, calls, commands, notices, message: m => message(m), fail: () => { fail = true; }, switch: (next = 'lab-b') => { machine = next; },
    settle: async () => { pending.splice(0).forEach(f => f()); await new Promise(r => setImmediate(r)); },
    expire: () => { for (const r of box.reads.values()) r.at = 0; } };
}
test('remote Review fills 3000 rows without local reads, coalesces reads and refreshes', async () => {
  const h = harness();
  const start = performance.now(); h.p.refresh(); h.p.refresh();
  assert.ok(performance.now() - start < 100, 'refresh never waits on SSH');
  assert.equal(h.calls.length, 1); await h.settle();
  assert.equal(h.posts.at(-1).data.units.length, 3000);
  assert.equal(h.view.badge.value, 2999);
  assert.deepEqual(h.calls[0].slice(-2), ['--machine', 'lab-a']);
  assert.ok(!h.calls[0].includes('--root'));
  h.expire(); h.p.refresh(); await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.posts.at(-1).data.units.length, 3000);
});
test('remote Review actions capture machine, open remote editor reviews and select raw file history', async () => {
  const h = harness(); h.p.refresh(); await h.settle();
  await h.p.remoteAction({ type: 'open', id: 1 });
  assert.deepEqual(h.commands.at(-1), ['claudeObservatory.remoteOpen', 'lab-a', 'same-id', 1, undefined]);
  const history = new h.box.H();
  assert.equal(history.getChildren().length, 1);
  assert.equal(history.getTreeItem(history.getChildren()[0]).command.command, 'claudeObservatory.remoteOpen');
  for (const [type, verb, extra] of [['keep', 'keep', { id: 1 }], ['undo', 'undo', { id: 1 }], ['redo', 'redo', { id: 3 }],
    ['keepFile', 'keep', { file: '/remote/f0.ts' }], ['undoFile', 'undo', { file: '/remote/f0.ts' }], ['redoFile', 'redo', { file: '/remote/f2.ts' }],
    ['keepAll', 'keep', {}], ['undoAll', 'undo', {}], ['redoAll', 'redo', {}], ['resolveAll', 'resolve', {}], ['resolve', 'clean', { id: 1 }], ['resolveFile', 'clean', { file: '/remote/f0.ts' }], ['comment', 'comment', { id: 1 }]]) {
    await h.p.remoteAction({ type, ...extra });
    const call = h.calls.filter(a => a[0] === verb).at(-1);
    assert.ok(call, type); assert.deepEqual(call.slice(-2), ['--machine', 'lab-a']);
    assert.ok(!call.includes('--root'));
  }
  assert.ok(h.notices.some(n => /undo .*on lab-a/.test(n)));
});
test('remote Review failed read names reason and last success, and never crosses hosts', async () => {
  const h = harness(); h.p.refresh(); await h.settle(); h.fail(); h.expire(); h.p.refresh(); await h.settle();
  assert.match(h.posts.at(-1).data.note, /Connection refused.*Last successful read: (?!never)/);
  assert.equal(h.posts.at(-1).data.units.length, 0);
  h.switch(); h.p.refresh(); await h.settle();
  assert.match(h.posts.at(-1).data.note, /lab-b.*Last successful read: never/);
});

test('remote Actions retains risk, egress and live conflicts from its machine batch', () => {
  const box = { ACTION_ICON: {}, statusIcon: () => ({}), vscode: { TreeItem: class {}, ThemeIcon: class {}, ThemeColor: class {}, TreeItemCollapsibleState: { Expanded: 2, Collapsed: 1, None: 0 } } };
  vm.runInNewContext(ts.transpile(declarations.get('remoteTlProvider')) + ';globalThis.provider=remoteTlProvider;', box);
  const p = box.provider('actions', { machine:'lab-a', session:'s', data: { groups: [], risk: { risky: [{ target:'rm synthetic', level:'high', reasons:['removes files'] }], outsideWrites:[{file:'/outside',count:2}] },
    egress:{channels:[{target:'fixture.invalid',kind:'web',scope:'remote',count:1}]}, multitask:{collisions:[{file:'/remote/f.ts',agents:['a','b'],anyPending:true}]} } });
  assert.deepEqual(Array.from(p.getChildren(), n => n.label), ['Risk','Outside the workspace','Egress','Live conflicts']);
});

test('remote Review prompt scope, filters and delayed messages preserve the selected target', async () => {
  const h = harness(); h.p.getPrompt = () => 'ask-2'; h.p.refresh(); await h.settle();
  assert.equal(h.posts.at(-1).data.units.length, 1);
  assert.equal(h.posts.at(-1).data.index, 2);
  assert.ok(h.calls[0].includes('--prompt'));
  await h.p.remoteAction({ type: 'keepAll', prompt: 'ask-2' });
  assert.equal(h.calls.at(-1)[h.calls.at(-1).indexOf('--ids') + 1], '2');
  h.box.filterExts = ['md']; h.p.refresh();
  assert.equal(h.posts.at(-1).data.units.length, 0);
  h.box.filterExts = []; h.box.editFilter = 'f1.ts'; h.p.refresh();
  assert.equal(h.posts.at(-1).data.units.length, 1);
  const before = h.calls.length;
  h.switch(null);
  h.message({ type: 'keep', id: 2, machine: 'lab-a', session: 'same-id', prompt: 'ask-2' });
  assert.equal(h.calls.length, before, 'an old remote message cannot mutate a newly selected local session');
});

test('clearing a remote prompt sends only its resolved member ids to that machine', async () => {
  const calls = [];
  const box = { refreshMountedReview: async () => {}, forceRefreshAll: null, currentMachine: () => 'lab-a', workspaceRoot: () => '/local',
    core: { promptEditIds() { throw new Error('local prompt read'); } },
    vscode: { window: { showErrorMessage: assert.fail } },
    oakOn: async (machine, args) => { calls.push([machine, args]); return { json: { units: [
      { status: 'pending', members: [1] }, { status: 'kept', members: [2, 3] }, { status: 'undone', members: [4] },
    ] } }; },
    remoteDecision: async (...args) => calls.push(args),
  };
  vm.runInNewContext(ts.transpile(['remotePromptDecision', 'clearPrompt'].map(n => declarations.get(n)).join('\n'), { target: ts.ScriptTarget.ES2022 }) + ';globalThis.clear=clearPrompt;', box);
  await box.clear('same-id', 'ask-2');
  assert.equal(calls[0][0], 'lab-a');
  assert.ok(calls[0][1].includes('ask-2'));
  assert.deepEqual(Array.from(calls[1].slice(0, 3)), ['lab-a', 'same-id', 'clean']);
  assert.deepEqual(Array.from(calls[1][3]), ['--resolved', '--ids', '2,3,4']);
});

test('remote task decisions never read or mutate the local task with the same id', async () => {
  const calls = [], notices = [];
  const box = { refreshMountedReview: async () => {}, forceRefreshAll: null, currentMachine: () => 'lab-a', workspaceRoot: () => '/local',
    core: new Proxy({}, { get: (_, name) => () => { throw new Error('local task path: ' + String(name)); } }),
    oakOn: async (machine, args) => { calls.push([machine, Array.from(args)]); return { json: { kept: 1, undone: 1, cleared: 1 } }; },
    vscode: { window: { showWarningMessage: async m => { notices.push(m); return 'Continue'; }, setStatusBarMessage() {}, showErrorMessage: assert.fail } },
  };
  vm.runInNewContext(ts.transpile(['remoteDecision','keepTaskScope','undoTaskScope','clearTaskScope','clearCompletedTasks'].map(n => declarations.get(n)).join('\n'), { target: ts.ScriptTarget.ES2022 }) + ';globalThis.ops=[keepTaskScope,undoTaskScope,clearTaskScope,clearCompletedTasks];', box);
  for (const fn of box.ops) await fn('same-id', 'task-1');
  assert.deepEqual(calls.map(c => [c[0], c[1][0]]), [['lab-a','task-keep'],['lab-a','task-undo'],['lab-a','task-clear'],['lab-a','task-clear']]);
  for (const [, args] of calls) { assert.ok(args.includes('same-id')); assert.ok(!args.includes('--root')); }
  assert.ok(calls[3][1].includes('--completed'));
  assert.ok(notices.some(n => /task-undo.*lab-a/.test(n)));
});
