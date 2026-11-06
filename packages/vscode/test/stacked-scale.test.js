const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { performance } = require('node:perf_hooks');
const core = require('../../core/dist');
const source = fs.readFileSync(process.env.OA1_SOURCE || path.join(__dirname, '../src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const cls = ast.statements.find(n => n.name?.text === 'ReviewViewProvider');
const methods = new Map(cls.members.map(n => [n.name?.getText(ast), n.getText(ast)]));
function provider(box) {
  const names = ['pendingScope', 'loadStackedScope', 'openAllInEditor', 'openAllStackedInEditor', 'openStacked', 'stackedActs', 'patchStacked', 'renderStacked', 'remoteAction', 'openRemoteStacked'];
  // Include the page state/loader when present; the same test runs against the original renderer.
  for (const name of methods.keys()) if (/^stacked|^loadStacked|^openStackedSide|^moveStacked/.test(name) && !names.includes(name)) names.push(name);
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${names.map(n => methods.get(n) || '').join('\n')} }`, { target: ts.ScriptTarget.ES2022 }), box);
  return new box.Provider();
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-stacked-'));
  const session = 'synthetic-stacked';
  core.ensureStore(session);
  const recs = [];
  for (let i = 0; i < 2616; i++) {
    const file = path.join(dir, 'files', `${i % 1293}.ts`);
    const before = Array.from({ length: 70 }, (_, n) => `const v${n} = ${i * 100 + n};`).join('\n') + '\n';
    const after = before.split('\n').map((s, n) => n < 18 ? s.replace('const', 'let') : s).join('\n');
    recs.push({id:i+1, ts:i+1, tool:'Edit', file, status:'pending', beforeBlob:core.writeBlob(session, Buffer.from(before)), afterBlob:core.writeBlob(session, Buffer.from(after))});
    if (i < 361) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, after); }
  }
  for (const r of recs) core.appendLog(session, r);
  return {dir, session, recs};
}
function harness(recs) {
  let receive;
  const posts = [], commands = [], calls = [];
  const panel = { title:'', dispose(){}, onDidDispose(){}, webview:{html:'', onDidReceiveMessage:f=>{receive=f;}, postMessage:async m=>posts.push(m)} };
  const box = { core, fs, path, process, setTimeout, setImmediate, Map, Set,
    workspaceRoot:()=>'/synthetic', currentMachine:()=> 'lab-a', currentSession:()=> 'synthetic-stacked',
    readRemoteReview:()=>({data:{units:recs.map(r=>({...r, members:[r.id], rel:r.file})), ids:recs.map(r=>r.id)}}),
    runOak:async args=>new Promise(resolve=>{require('node:child_process').execFile(process.execPath,[path.resolve(__dirname,'../../cli/dist/cli.js'),...args],{maxBuffer:16*1024*1024},(e,stdout,stderr)=>resolve({code:e?1:0,stdout,stderr}));}),
    selectRemoteReviewFile(){}, remoteReviewCursor:undefined, openRemoteReview:async()=>assert.fail('Open all must stay in this window'),
    tmGrammarFor:async()=>null, hlLine:s=>s, getNonce:()=> 'n',
    undoOne:async(s,id)=>core.undoGroup(s,id), redoOne:async(s,id)=>core.redoGroup(s,id),
    blobUri:(s,b,f,side)=> `${side}:${b}`,
    vscode:{Uri:{file:x=>x}, ViewColumn:{Active:1}, workspace:{getConfiguration:()=>({get:()=>50}), openTextDocument:async d=>({uri:d.content})},
      commands:{executeCommand:async(...a)=>commands.push(a)}, window:{createWebviewPanel:(kind,title)=>{panel.title=title;return panel;}, setStatusBarMessage(){}, showErrorMessage:assert.fail, showTextDocument:async()=>{}, showInformationMessage(){}}},
    oakOn:async(machine,args)=>{ calls.push([machine, Array.from(args)]); const ids=args[args.indexOf('--ids')+1]?.split(',').map(Number); return {json:{records:recs.filter(r=>ids.includes(r.id)).map(rec=>({rec, ...core.lineDelta('synthetic-stacked', rec), patch:core.coloredDiff('synthetic-stacked',rec,false), omittedLines:0}))}}; },
    remoteDecision:async(machine,session,verb,scope)=>{calls.push([machine,[verb,...scope]]); recs.find(r=>r.id===Number(scope[0])).status=verb==='keep'?'kept':verb==='undo'?'undone':'pending';},
  };
  return {p:provider(box), panel, posts, commands, calls, box, receive:m=>receive(m)};
}
async function waitFor(fn) { const end=Date.now()+20000; while (!fn() && Date.now()<end) await new Promise(r=>setTimeout(r,5)); assert.ok(fn(), 'renderer completed'); }

test('stacked large session renders bounded pages and yields to the host', async () => {
  const {dir,session,recs}=fixture();
  try {
    const h=harness(recs);
    let longest=0, last=performance.now();
    const tick=setInterval(()=>{const now=performance.now();longest=Math.max(longest,now-last);last=now;},1);
    const start=performance.now();
    await h.p.openAllStackedInEditor(session, null);
    await waitFor(()=>h.panel.webview.html.includes('data-acts='));
    const first=performance.now()-start;
    await new Promise(r=>setTimeout(r,5)); clearInterval(tick);
    const count=(h.panel.webview.html.match(/data-acts="[0-9]+"/g)||[]).length;
    console.log(JSON.stringify({fixture:2616, files:1293, missing:932, firstMs:first, longestMs:longest, peakRssMiB:process.resourceUsage().maxRSS/1024, blocks:count}));
    assert.equal(h.panel.title,'session — 2616 change(s) · stacked');
    assert.ok(count<=10, `only a page is built: ${count}`);
    if (process.env.OA1_PERF) assert.ok(first<1100, `first page ${first} ms`);
    assert.ok(longest<200, `host blocked ${longest} ms`);
    assert.match(h.panel.webview.html,/2606.*(?:remaining|more)/);
    await h.receive({type:'nextPage'});
    await waitFor(()=>h.panel.webview.html.includes('data-acts="11"'));
    assert.ok((h.panel.webview.html.match(/data-acts="[0-9]+"/g)||[]).length<=10,'old pages are released');
    await h.receive({type:'keep', id:11});
    await waitFor(()=>h.posts.some(m=>m.id===11 && /kept/.test(m.html)));
    await h.receive({type:'sideBySide'});
    await waitFor(()=>h.commands.some(c=>c[0]==='vscode.changes'));
    const changes=h.commands.find(c=>c[0]==='vscode.changes');
    assert.ok(changes[2].length<=10);
    assert.match(changes[1],/remaining/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('remote Open all stays stacked here, reads once per page and acts on a later page', async () => {
  const recs=Array.from({length:2616},(_,i)=>({id:i+1,file:`/missing/${i%1293}.ts`,status:'pending',beforeBlob:null,afterBlob:null}));
  const h=harness(recs); h.p.getPrompt=()=>null;
  await h.p.remoteAction({type:'openAllStacked',machine:'lab-a',session:'synthetic-stacked',prompt:null});
  await waitFor(()=>h.panel.webview.html.includes('data-acts="1"'));
  assert.equal(h.commands.filter(c=>c[0]==='vscode.openFolder').length,0);
  assert.equal(h.calls.length,1);
  await h.receive({type:'nextPage'});
  await waitFor(()=>h.panel.webview.html.includes('data-acts="11"'));
  assert.equal(h.calls.length,2);
  await h.receive({type:'keep',id:11});
  await waitFor(()=>h.posts.some(m=>m.id===11&&/kept/.test(m.html)));
  await h.receive({type:'undo',id:11});
  await waitFor(()=>h.posts.some(m=>m.id===11&&/reverted/.test(m.html)));
  assert.ok(h.calls.every(c=>c[0]==='lab-a'));
  assert.ok(h.calls.filter(c=>c[1][0]==='diff').every(c=>c[1].includes('--ids')));
});

test('page mount mapping checks each distinct file and share once, refusing other hosts and symlink escapes', () => {
  const cli = fs.readFileSync(process.env.OA1_CLI_SOURCE || path.join(__dirname, '../../cli/src/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', cli, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n=>n.name?.text==='cmdEditorReview').getText(tree);
  const remote = {home:'/home/fixture',hostname:'lab-a',user:'fixture',shares:[]};
  const mounts = core.parseMountTable('//fixture@lab-a/fixture on /Volumes/fixture (smbfs, nodev)', 'mac');
  const reads = [], stats = [];
  let output;
  const box = { require:n=>n==='@oak-observatory/core'?{...core, readMountTable:()=>mounts}:n==='fs'?{
    existsSync:p=>{stats.push(p);return !p.endsWith('missing');},
    realpathSync:p=>{reads.push(p);return p.endsWith('escape')?'/outside/secret':p;}
  }:require(n), flagValue:(a,f)=>a[a.indexOf(f)+1] && a.includes(f)?a[a.indexOf(f)+1]:undefined,
    emitJson:r=>{output=r;}, fail:assert.fail };
  vm.runInNewContext(ts.transpile(fn,{target:ts.ScriptTarget.ES2022}),box);
  const paths=['/home/fixture/a','/home/fixture/a','/home/fixture/missing','/home/fixture/escape','/local/same'];
  box.cmdEditorReview(['map','--files',JSON.stringify(paths),'--target','lab-a','--remote',JSON.stringify(remote)]);
  assert.equal(output.files.length,4);
  assert.equal(output.files[0].file,'/Volumes/fixture/a');
  assert.ok(output.files.slice(1).every(m=>m.file===null));
  assert.equal(reads.filter(p=>p==='/Volumes/fixture').length,1);
  assert.equal(stats.filter(p=>p==='/Volumes/fixture/a').length,1);
  box.cmdEditorReview(['map','--files',JSON.stringify(paths),'--target','lab-b','--remote',JSON.stringify({...remote,hostname:'lab-b'})]);
  assert.ok(output.files.every(m=>m.file===null),'a different machine cannot borrow the mount');
});
