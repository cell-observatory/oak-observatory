const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(process.env.RV3_VS_SOURCE || path.join(__dirname, '../src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const decls = new Map();
for (const n of ast.statements) if (n.name) decls.set(n.name.getText(ast), n.getText(ast));
function load(names, box) {
  for (const n of names) assert.ok(decls.has(n), `production function ${n} exists`);
  vm.runInNewContext(ts.transpile(names.map(n => decls.get(n)).join('\n'), { target: ts.ScriptTarget.ES2022 }), box);
  return box;
}
test('Review has no reply composer in either editor', () => {
  assert.doesNotMatch(source.slice(source.indexOf('class ReviewViewProvider'), source.indexOf('class ChangeMapProvider')), /rv-reply|sendReply|replyBusy/);
  const jb = fs.readFileSync(path.join(__dirname, '../../jetbrains/src/main/kotlin/com/cellobservatory/observatory/ui/ReviewPanel.kt'), 'utf8');
  assert.doesNotMatch(jb, /ReplyComposer|composer.refresh/);
});

test('VS Code remote open writes to the saved machine then opens its SSH workspace in a new window', async () => {
  const calls = [], commands = [];
  const info = { workspace: '/home/fixture/project with space', installed: true, home:'/home/fixture', hostname:'lab-a', user:'fixture', shares:[] };
  const box = { core: { isSafeSessionId:()=>true }, tryMountedReview:async()=>false, editorReviewKind:()=> 'cursor',
    runOak:async()=>({code:0,stdout:JSON.stringify([{label:'lab-a',target:'dev@ssh-alias',enabled:true}])}),
    oakOn:async(machine,args)=>{calls.push([machine,Array.from(args)]);return {json:info};},
    vscode:{Uri:{from:x=>x}, ProgressLocation:{Notification:15}, commands:{executeCommand:async(...args)=>commands.push(args)},window:{withProgress:(o,fn)=>fn(),showErrorMessage:assert.fail,showWarningMessage:assert.fail}},
  };
  load(['openRemoteReview','openRemoteReviewSteps'],box);
  await box.openRemoteReview('lab-a','synthetic',7);
  assert.ok(calls.some(([m,a])=>m==='lab-a' && a[0]==='editor-review' && a[1]==='prepare' && a.includes('synthetic') && a.includes('7')));
  const c=commands.at(-1); assert.equal(c[0],'vscode.openFolder');
  assert.equal(c[1].scheme,'vscode-remote'); assert.equal(c[1].authority,'ssh-remote+dev@ssh-alias'); assert.equal(c[1].path,info.workspace); assert.equal(c[2].forceNewWindow,true);
});
test('receiving extension selects requested session and dispatches edit, file and Open all', async () => {
  for (const action of ['edit','file','all']) {
    const commands=[]; const request={session:'synthetic',action,edit:7,file:'/remote/f.ts',prompt:'ask-2'}; const requests=[request];
    const box={core:{consumeEditorReviewRequest:()=>requests.shift() ?? null,reviewEdits:()=>[{id:7,file:request.file}],findRecord:()=>null},editorReviewKind:()=> 'cursor',workspaceRoot:()=>'/remote',
      vscode:{commands:{executeCommand:async(...a)=>commands.push(a)},Uri:{file:x=>x},window:{showTextDocument:async x=>commands.push(['file',x])}},
      openFileAtEdit:async n=>commands.push(['edit',n.rec.id])};
    load(['consumeRemoteEditorReview'],box);
    await box.consumeRemoteEditorReview({openRequestedAll:(s,p)=>commands.push(['all',s,p])});
    assert.deepEqual(commands[0],['claudeObservatory.pinSession','synthetic']);
    assert.equal(commands.at(-1)[0],action); if(action==='all') assert.deepEqual(commands.at(-1),['all','synthetic','ask-2']);
  }
});
test('remote Diff uses native before/after viewer when the machine supplies both sides', async()=>{
  const commands=[];
  const box={oakOn:async()=>({json:{before:'old\n',after:'new\n',file:'/remote/a.ts',patch:'patch'}}),
    vscode:{workspace:{openTextDocument:async d=>({uri:d.content})},commands:{executeCommand:async(...a)=>commands.push(a)},window:{showTextDocument:async()=>assert.fail('patch fallback'),showErrorMessage:assert.fail}}};
  load(['showRemoteDiff'],box); await box.showRemoteDiff('lab-a','synthetic',7);
  assert.deepEqual(commands[0].slice(0,3),['vscode.diff','old\n','new\n']);
});

test('mounted review opens verified real files and retains remote placement/action identity', async () => {
  const realCore = require('../../core/dist');
  const commands = [], opened = [], mounts = realCore.parseMountTable('//fixture@lab-a/fixture on /Volumes/fixture (smbfs, nodev)', 'mac');
  const unit = {id:7,file:'/home/fixture/Github/app/a.ts',status:'pending',members:[7]};
  const record = {...unit, before:'old\n',after:'new\n'};
  const box={core:{...realCore,readMountTable:()=>mounts},fs:{existsSync:()=>true,realpathSync:x=>x},path,
    currentMachine:()=> 'lab-a',canonFsPath:u=>u, mountedReviews:new Map(),refreshInline(){},selectRemoteReviewFile(){},anchorLines:p=>p.lines,
    oakOn:async(m,args)=>({json:args[0]==='views'?{review:{units:[unit]},timeline:{edits:[unit]}}:args[0]==='diff'?{before:'old\n',after:'new\n'}:{records:[record]}}),
    vscode:{Uri:{file:x=>x},Selection:class{},Range:class{},CodeLens:class{constructor(range,command){this.command=command;}},
      workspace:{openTextDocument:async d=>({uri:d.content})},
      commands:{executeCommand:async(...a)=>commands.push(a)},window:{showTextDocument:async uri=>{opened.push(uri);return {document:{uri,getText:()=> 'new\n'},revealRange(){}};}}}};
  load(['tryMountedReview','mountedPlacements','mountedLenses'],box);
  const info={home:'/home/fixture',hostname:'lab-a',user:'fixture',shares:[]};
  assert.equal(await box.tryMountedReview('lab-a','synthetic','fixture@alias',info,7),true);
  assert.deepEqual(opened,['/Volumes/fixture/Github/app/a.ts']);
  assert.deepEqual(commands[0],['claudeObservatory.pinRemoteSession','lab-a','synthetic']);
  const doc={uri:opened[0],getText:()=> 'new\n'};
  assert.deepEqual(Array.from(box.mountedPlacements('synthetic',doc)[0].lines),[0]);
  for(const lens of box.mountedLenses('synthetic',doc)) assert.deepEqual(Array.from(lens.command.arguments).slice(0,2),['lab-a','synthetic']);
  assert.equal(await box.tryMountedReview('lab-b','synthetic','lab-b',{...info,hostname:'lab-b'},7),false);
  assert.equal(opened.length,1,'a different machine cannot reuse a local file or mount');
  assert.equal(await box.tryMountedReview('lab-a','synthetic','alias',info,undefined,unit.file),true);
  assert.equal(opened.at(-1),opened[0],'File History opens the mounted file');
  assert.equal(await box.tryMountedReview('lab-a','synthetic','alias',info,undefined,undefined,true),false, 'Open all uses its own stacked route');
  record.status='undone';
  const redo=box.mountedLenses('synthetic',{...doc,getText:()=> 'old\n'}).map(l=>l.command.arguments[2]);
  assert.ok(redo.includes('redo')); assert.ok(!redo.includes('undo'));

});

test('mounted review actions refresh the captured machine and never write through local core', async()=>{
  const calls=[], refresh=[];
  const box={oakOn:async(m,a)=>{calls.push([m,Array.from(a)]);return {json:{kept:1}};},
    refreshMountedReview:async(...a)=>refresh.push(a),forceRefreshAll:()=>{},
    core:new Proxy({}, {get:()=>()=>assert.fail('local write')}),
    vscode:{window:{showWarningMessage:async()=> 'Continue',setStatusBarMessage(){},showErrorMessage:assert.fail}}};
  load(['remoteDecision'],box);
  for(const verb of ['keep','undo','redo','resolve']) await box.remoteDecision('lab-a','synthetic',verb,['7','--units']);
  assert.ok(calls.every(([m,a])=>m==='lab-a'&&a.includes('synthetic')));
  assert.equal(refresh.length,4);
});

test('missing remote OAK offers installation on that machine and refuses an unverified handoff', async()=>{
  const commands=[], calls=[], errors=[], offers=[];
  const box={core:{isSafeSessionId:()=>true},tryMountedReview:async()=>false,editorReviewKind:()=> 'cursor',
    runOak:async args=>{calls.push(Array.from(args));return args[0]==='machine'?{code:0,stdout:'[{"label":"lab-a","target":"alias","enabled":true}]'}:{code:0,stdout:'installation output'};},
    oakOn:async()=>({json:{installed:false,workspace:'/remote'}}),
    vscode:{ProgressLocation:{Notification:15},commands:{executeCommand:async(...a)=>commands.push(a)},window:{withProgress:(o,fn)=>fn(),showWarningMessage:async m=>{offers.push(m);return 'Install OAK there';},showErrorMessage:m=>errors.push(m)}}};
  load(['openRemoteReview','openRemoteReviewSteps'],box); await box.openRemoteReview('lab-a','synthetic',7);
  assert.match(offers[0],/missing.*cursor.*lab-a/);
  assert.deepEqual(calls.at(-1),['install-extensions','--vscode-only','--machine','lab-a']);
  assert.equal(commands.length,0); assert.match(errors[0],/still missing/);
});
