const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(process.env.RV2_VS_SOURCE || path.join(__dirname, '../src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const declarations = new Map();
function visit(n) {
  if (ts.isFunctionDeclaration(n) && n.name) declarations.set(n.name.text, n.getText(ast));
  if (ts.isVariableDeclaration(n)) declarations.set(n.name.getText(ast), 'let ' + n.getText(ast) + ';');
  ts.forEachChild(n, visit);
}
visit(ast);
function load(names, box) {
  for (const n of names) assert.ok(declarations.has(n), 'production handler exists: ' + n);
  vm.runInNewContext(ts.transpile(names.map(n => declarations.get(n)).join('\n') + '\nglobalThis.api={' + names.join(',') + '};', { target: ts.ScriptTarget.ES2022 }), box);
  return box.api;
}

test('conversation search fans out asynchronously with machine provenance and the shared deadline', async () => {
  const calls = [], waits = [];
  const box = { SAVED_DEADLINE_MS: 45000, core: { cliFailureMessage: (_, err) => err },
    runOak: async (args, opts) => {
      calls.push({ args: Array.from(args), opts });
      if (args[0] === 'machine') return { code: 0, stdout: JSON.stringify([{label:'lab-a'},{label:'lab-b'},{label:'disabled',enabled:false}]) };
      await new Promise(r => waits.push(r));
      if (args.at(-1) === 'lab-b') return { code: 1, stdout: '', stderr: 'offline' };
      return { code: 0, stdout: JSON.stringify({ hits: [{session:'same-id',snippet:'synthetic hit'}] }) };
    },
  };
  let pending;
  if (declarations.has('searchConversationMachines')) pending = load(['searchConversationMachines'], box).searchConversationMachines('needle');
  else {
    // Execute the former production message handler, which only asked the local database.
    let handler;
    function find(n) { if (ts.isIfStatement(n) && n.expression.getText(ast).includes("m.type === 'searchConversations'")) handler = n.thenStatement.getText(ast); ts.forEachChild(n, find); }
    find(ast); assert.ok(handler);
    Object.assign(box, { workspaceRoot: () => '/local', core: { searchConversations: () => ({ hits: [] }) } });
    vm.runInNewContext(ts.transpile('globalThis.oldSearch = async function(m) ' + handler), box);
    pending = box.oldSearch.call({ view: { webview: { postMessage() {} } } }, { q: 'needle' });
  }
  await new Promise(r => setImmediate(r));
  assert.equal(waits.length, 3, 'local and both saved machines start before any answer');
  waits.forEach(r => r());
  const result = await pending;
  assert.deepEqual(Array.from(result.hits, h => [h.session,h.machine]), [['same-id',''],['same-id','lab-a']]);
  assert.match(result.error, /lab-b.*offline/);
  for (const c of calls.filter(c => c.args[0] === 'search')) {
    assert.ok(c.args.includes('--per-session')); assert.ok(!c.args.includes('--root'));
    assert.equal(c.opts.timeoutMs, 50000); assert.equal(c.opts.env.OAK_MACHINE_TIMEOUT_MS, '45000');
  }
  const commands=[];
  const open = load(['openConversationHit'], {vscode:{commands:{executeCommand:async (...args)=>commands.push(args)}}});
  await open.openConversationHit(result.hits[1]);
  assert.deepEqual(commands[0], ['claudeObservatory.pinRemoteSession','lab-a','same-id']);
});

test('remote keyboard edit, file and continuous navigation open remote editor reviews', async () => {
  const commands=[];
  let machine='lab-a';
  const units=[{id:2,file:'/remote/a',rel:'a',members:[1,2],status:'pending'}, {id:3,file:'/remote/a',rel:'a',members:[3],status:'pending'}, {id:4,file:'/remote/b',rel:'b',members:[4],status:'pending'}];
  const box={currentMachine:()=>machine,currentSession:()=> 'same-id', remoteReviewPrompt:()=>null,
    core:{fileExt:()=>'',fileCategory:()=>'', matchesFileFilter:()=>true},editFilter:'',filterExts:[],filterCats:[],
    oakOn:async()=>({json:{units}}), selectRemoteReviewFile(){},
    vscode:{workspace:{getConfiguration:()=>({get:()=>true})},commands:{executeCommand:async (...a)=>commands.push(a)},window:{showErrorMessage:assert.fail,setStatusBarMessage(){}}},
  };
  box.pickNextPending = () => { throw new Error('local review path reached'); };
  const api=load(declarations.has('navigateRemoteReview') ? ['remoteReviewCursor','navigateRemoteReview','navDiff','navFile','reviewStep'] : ['navDiff','navFile','reviewStep'], box);
  await api.reviewStep(1); await api.navDiff(1); await api.navFile(1); await api.reviewStep(-1);
  assert.deepEqual(commands.map(c=>c[3]),[2,3,4,3]);
  await api.navigateRemoteReview(1,'advance',3); // still pending, no advance
  assert.equal(commands.length,4);
  units[1].status='kept'; await api.navigateRemoteReview(1,'advance',3);
  assert.equal(commands.at(-1)[3],4);
  machine='lab-b'; await api.reviewStep(1);
  assert.equal(commands.at(-1)[1],'lab-b'); assert.equal(commands.at(-1)[3],2);
  assert.ok(commands.every(c=>c[0]==='claudeObservatory.remoteOpen'));
});

test('Review no longer has an inline reply sender or composer', () => {
  assert.doesNotMatch(source, /rv-reply|function sendInlineReply/);
});
