const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const core = require('../../core/dist');
const source = fs.readFileSync(process.env.OAK_WORKSPACE_SOURCE || path.join(__dirname, '../src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const declarations = new Map(ast.statements.filter(n => n.name).map(n => [n.name.getText(ast), n.getText(ast)]));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate) { for (let end = Date.now() + 4000; Date.now() < end && !predicate();) await delay(10); assert.ok(predicate(), 'request acted on promptly'); }
function harness(t, watch = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-workspace-review-'));
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = dir;
  const subscriptions = [], events = [], terminals = [], notices = [], errors = [], focus = [];
  let pending = true;
  const box = { fs: watch ? fs : { ...fs, watch() { throw new Error('no watcher'); } }, path, core,
    workspaceRoot: () => dir, currentMachine: () => undefined, currentSession: () => 'synthetic',
    // A command answers on a later turn, as VS Code's do: a consume loop that never ends must still let the timeout fire.
    vscode: { env: { appName: 'Visual Studio Code' }, commands: { executeCommand: async (...args) => { events.push(args); await delay(0); } },
      window: { terminals, onDidChangeWindowState: fn => { focus.push(fn); return { dispose() {} }; },
        createTerminal: options => { const term = { ...options, sendText: s => events.push(['send', s]), show: () => events.push(['terminal']) }; terminals.push(term); return term; },
        setStatusBarMessage: msg => notices.push(msg), showErrorMessage: msg => errors.push(msg) } } };
  const methods = ast.statements.find(n => n.name?.getText(ast) === 'ReviewViewProvider').members;
  const reviewMethods = methods.filter(n => ['openRequestedAll', 'openAllStackedInEditor'].includes(n.name?.getText(ast))).map(n => n.getText(ast)).join('\n');
  const code = ['editorReviewKind', 'consumeRemoteEditorReview', 'watchEditorReview'].map(n => declarations.get(n) || '').join('\n') + `
class Review { stackedOpen=0; ${reviewMethods} }
globalThis.review = new Review();
globalThis.consume = () => consumeRemoteEditorReview(review, overview);
globalThis.start = context => { if (typeof watchEditorReview === 'function') watchEditorReview(context, review, overview); else void consume(); };`;
  box.overview = { showWorkspaceDashboards: async () => events.push(['grouped']) };
  vm.runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), box);
  box.review.loadStackedScope = async (session, prompt) => { assert.equal(prompt, null); return pending ? { ids: [1, 2], records: [{ rec: { id: 1 } }, { rec: { id: 2 } }] } : { ids: [], records: [] }; };
  box.review.openStacked = (session, recs, title) => events.push(['stacked', session, recs.map(r => r.id).join(','), title]);
  t.after(() => { for (const s of subscriptions) s.dispose(); if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...box, dir, events, terminals, notices, errors, focus, subscriptions, empty: () => { pending = false; },
    write(action = 'workspace') { const mailbox = path.join(dir, 'editor-review'); fs.mkdirSync(mailbox, { recursive: true }); const id = require('crypto').randomUUID(); const file = path.join(mailbox, id + '.json'); fs.writeFileSync(file + '.tmp', JSON.stringify({ id, editor: 'vscode', session: 'synthetic', workspace: dir, action, expiresAt: Date.now() + 600000 })); fs.renameSync(file + '.tmp', file); } };
}
function layout(h, count) {
  assert.equal(h.events.filter(e => e[0] === 'claudeObservatory.pinSession').length, count, 'each request is served once: consumeEditorReviewRequest claims (renames away) the file it returns');
  for (const name of ['fileHistory', 'reviewList', 'timeline']) assert.equal(h.events.filter(e => e[0] === `claudeObservatory.${name}.focus`).length, count, name);
  assert.equal(h.events.filter(e => e[0] === 'grouped').length, count);
  assert.equal(h.events.filter(e => e[0] === 'terminal').length, count);
  assert.equal(h.terminals.length, 1); assert.equal(h.terminals[0].name, 'OAK'); assert.equal(h.terminals[0].cwd, h.dir);
  assert.deepEqual(h.events.filter(e => e[0] === 'send'), [['send', 'oak']]);
  assert.deepEqual(h.errors, []);
}
test('workspace activation pins, opens pending stacked, reveals every view and one OAK terminal', { timeout: 10_000 }, async t => {
  const h = harness(t); h.write(); h.start({ subscriptions: h.subscriptions });
  await until(() => h.events.some(e => e[0] === 'grouped')); layout(h, 1);
  assert.equal(h.events.find(e => e[0] === 'stacked')[2], '1,2');
  await h.consume(); layout(h, 1);
});
test('workspace watcher serves an already-open window and reuses its OAK terminal', { timeout: 10_000 }, async t => {
  const h = harness(t); h.start({ subscriptions: h.subscriptions }); await delay(30);
  h.write(); await until(() => h.events.filter(e => e[0] === 'grouped').length === 1);
  h.write(); await until(() => h.events.filter(e => e[0] === 'grouped').length === 2); layout(h, 2);
});
test('workspace focus fallback consumes once; nothing pending opens no empty stacked tab', { timeout: 10_000 }, async t => {
  const h = harness(t, false); h.empty(); h.start({ subscriptions: h.subscriptions }); await delay(30);
  h.write(); for (const f of h.focus) f({ focused: true });
  await until(() => h.events.some(e => e[0] === 'grouped'));
  for (const f of h.focus) f({ focused: true }); await delay(30);
  layout(h, 1); assert.ok(h.notices.some(n => /nothing pending/.test(n)));
  assert.equal(h.events.filter(e => e[0] === 'stacked').length, 0);
});
test('workspace dashboards focus the placed Overview and deliver grouping after its webview is ready', async () => {
  const calls = [], messages = []; let receive;
  const host = { visible: true, onDidChangeVisibility() {}, webview: { postMessage: m => messages.push(m), onDidReceiveMessage: fn => { receive = fn; } } };
  const box = { changeMapShell: () => '', versionChipInfo: async () => ({}), setTimeout, vscode: { commands: { executeCommand: async (...a) => calls.push(a) } } };
  vm.runInNewContext(ts.transpile(declarations.get('ChangeMapViewProvider') + '\nglobalThis.provider = new ChangeMapViewProvider();', { target: ts.ScriptTarget.ES2022 }), box);
  const p = box.provider; p.refresh = () => {};
  assert.equal(typeof p.showWorkspaceDashboards, 'function');
  await p.showWorkspaceDashboards(); p.resolveWebviewView(host);
  assert.equal(messages.length, 0, 'unready host holds the request');
  receive({ type: 'ready' });
  assert.equal(messages.filter(m => m.type === 'workspaceDashboards').length, 1);
  assert.deepEqual(calls.map(c => Array.from(c)), [['claudeObservatory.changemap.focus']]);
  const block = source.match(/else if\(m.type==='workspaceDashboards'\)\{([\s\S]*?)\n    \}/);
  assert.ok(block, 'webview receives grouping');
  const ui = { GROUPNAV: false, NAV: 'tasks', COLC: { all: ['fleet'] }, GROUP_BUILT: 'on', saveState() {}, applySplit() {}, paint() {} };
  vm.runInNewContext(block[1], ui);
  assert.equal(ui.GROUPNAV, true); assert.equal(ui.NAV, 'sessions'); assert.equal(Object.keys(ui.COLC).length, 0);
});
