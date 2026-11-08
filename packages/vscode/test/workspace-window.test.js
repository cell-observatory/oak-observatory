const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(process.env.OAK_WORKSPACE_SOURCE || path.join(__dirname, '../src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
function harness(row) {
  const calls = [], errors = [], reads = [];
  const box = { core: require('../../core/dist'), path, process, console,
    workspaceRoot: () => '/reader', currentSession: () => 'other', editorReviewKind: () => 'cursor',
    readSessionListing: async () => ({ sessions: [row] }),
    // A saved machine oak sync keeps answers a bare listing from the local index (`~/…` paths, no workspaceExists); only
    // a read naming the session is asked there (review 2026-11-05).
    oakOn: async (machine, args) => { reads.push([machine, args]); return { json: args[0] === 'editor-review' ? { workspace: row.workspacePath, request: {} }
      : { sessions: [args.includes('--session') ? row : { id: row.id, workspacePath: '~/work' }] } }; },
    runOak: async () => ({ code: 0, stdout: JSON.stringify([{ label: 'lab', target: 'fixture@alias', enabled: true }]) }),
    vscode: { Uri: { file: p => ({ scheme: 'file', path: p }), from: p => p },
      env: { remoteName: undefined }, workspace: { workspaceFolders: [] },
      commands: { executeCommand: async (...a) => { if (a[1].scheme === 'file' || a[1].authority === 'ssh-remote+current-host') { const r = box.core.consumeEditorReviewRequest('cursor', row.workspacePath); assert.equal(r?.action, 'workspace'); assert.equal(r?.session, row.id); } else { assert.ok(reads.some(([m, args]) => m === 'lab' && args[1] === 'prepare' && args.includes('workspace') && args.includes('cursor'))); } calls.push(a); } },
      window: { showErrorMessage: s => errors.push(s), setStatusBarMessage() {} } } };
  const decl = ast.statements.filter(n => n.name?.getText(ast) === 'openWorkspaceWindow' || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === 'openingWorkspaceWindow'))).map(n => n.getText(ast)).join('\n');
  vm.runInNewContext(ts.transpile(decl + '\nglobalThis.open = typeof openWorkspaceWindow === "function" ? openWorkspaceWindow : async () => {};'), box);
  return { ...box, calls, errors, reads };
}
test('workspace window: VS Code opens the chosen local workspace in a new window', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-window-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const h = harness({ id: 'chosen', workspacePath: dir }); await h.open('chosen');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'vscode.openFolder');
  assert.equal(h.calls[0][1].path, dir); assert.equal(h.calls[0][1].scheme, 'file'); assert.equal(h.calls[0][2].forceNewWindow, true);
});
test('workspace window: VS Code uses the saved SSH target and remote path', async () => {
  const h = harness({ id: 'chosen', workspacePath: '/remote/project a', workspaceExists: true }); await h.open('chosen', 'lab');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1].authority, 'ssh-remote+fixture@alias');
  assert.equal(h.calls[0][1].scheme, 'vscode-remote'); assert.equal(h.calls[0][1].path, '/remote/project a'); assert.equal(h.calls[0][2].forceNewWindow, true);
  assert.equal(h.reads[0][0], 'lab');
});
for (const [name, row, machine, reason] of [
  ['missing local', { workspacePath: '/synthetic/not-present' }, undefined, /missing|unavailable/],
  ['missing remote', { workspacePath: '/remote/gone', workspaceExists: false }, 'lab', /missing|unavailable/],
  ['no workspace', {}, undefined, /no workspace/],
  ['unverified remote', { workspacePath: '/remote/project' }, 'lab', /verify/],
]) test('workspace window: VS Code refuses ' + name, async () => {
  const h = harness({ id: 'chosen', ...row }); await h.open('chosen', machine);
  assert.equal(h.calls.length, 0); assert.match(h.errors.join('\n'), reason);
});

test('workspace window: a local session in a Remote-SSH extension host stays on that host', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-window-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const h = harness({ id: 'chosen', workspacePath: dir });
  h.vscode.workspace.workspaceFolders = [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+current-host' } }];
  await h.open('chosen');
  assert.equal(h.calls[0][1].authority, 'ssh-remote+current-host'); assert.equal(h.calls[0][1].path, dir);
});
