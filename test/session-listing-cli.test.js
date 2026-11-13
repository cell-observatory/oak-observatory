const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
test('sessions --all and --session follow the continued copy after a workspace move, with and without the index',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oak-sessions-move-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const env={...process.env,HOME:dir,USERPROFILE:dir,CLAUDE_CONFIG_DIR:path.join(dir,'config'),CODEX_HOME:path.join(dir,'codex'),HERDR_BIN:path.join(dir,'absent-herdr'),HERDR_SOCKET_PATH:path.join(dir,'no-socket')};
 const old=path.join(dir,'a-old'),current=path.join(dir,'z-new'),id='fixture-moved';
 fs.mkdirSync(current);fs.symlinkSync(current,old,process.platform==='win32'?'junction':'dir');
 const file=cwd=>path.join(env.CLAUDE_CONFIG_DIR,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),id+'.jsonl');
 const records=(cwd,prompt,sec)=>[
   {type:'user',cwd,sessionId:id,uuid:prompt,timestamp:new Date(sec*1000).toISOString(),message:{role:'user',content:prompt}},
   {type:'assistant',cwd,sessionId:id,timestamp:new Date((sec+1)*1000).toISOString(),message:{id:prompt,role:'assistant',content:[{type:'text',text:prompt+' response'}],usage:{input_tokens:10,output_tokens:20}}},
 ].map(r=>JSON.stringify(r)).join('\n')+'\n';
 for(const cwd of [old,current])fs.mkdirSync(path.dirname(file(cwd)),{recursive:true});
 fs.writeFileSync(file(old),records(old,'Before the move',1000));fs.utimesSync(file(old),1000,1000);
 fs.writeFileSync(file(current),fs.readFileSync(file(old),'utf8')+records(current,'Kestrel continuation',2000));fs.utimesSync(file(current),2000,2000);
 for(const extra of [{},{OAK_INDEX:'off'}]){
   const cli=(...args)=>{const r=spawnSync(process.execPath,[process.env.OAK_LISTING_TEST_CLI || path.resolve(__dirname,'../packages/cli/dist/index.js'),...args],{cwd:old,env:{...env,...extra},encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
   const rows=cli('sessions','--all','--json').sessions;
   assert.equal(rows.length,1);assert.equal(rows[0].workspace,'~/z-new');assert.equal(rows[0].tokens,60);
   assert.match(JSON.stringify(cli('prompts','--session',id,'--root',old,'--json')),/Kestrel continuation/);
   assert.match(JSON.stringify(cli('conversation','--session',id,'--root',old,'--json')),/Kestrel continuation response/);
   assert.equal(cli('search','Kestrel','--json').hits[0]?.workspace,'~/z-new');
 }
});
test('sessions CLI scopes and groups local workspaces; batched JSON shares the contract without herdr',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oak-sessions-cli-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const env={...process.env,HOME:dir,USERPROFILE:dir,CLAUDE_CONFIG_DIR:path.join(dir,'config'),CODEX_HOME:path.join(dir,'codex'),XDG_CONFIG_HOME:path.join(dir,'xdg'),HERDR_BIN:path.join(dir,'absent-herdr'),HERDR_SOCKET_PATH:path.join(dir,'no-socket')};
 const work=path.join(dir,'work'),other=path.join(dir,'other');fs.mkdirSync(work);fs.mkdirSync(other);
 const seed=(id,cwd,folder=cwd)=>{const base=path.join(env.CLAUDE_CONFIG_DIR,'projects',folder.replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(base,{recursive:true});fs.writeFileSync(path.join(base,id+'.jsonl'),[
 {type:'user',cwd,sessionId:id,message:{role:'user',content:'Local fixture title'}},
 {type:'assistant',cwd,message:{id:'fixture-answer',role:'assistant',model:'claude-opus-4-1',content:[],usage:{input_tokens:10,output_tokens:20}}},
 ].map(r=>JSON.stringify(r)).join('\n')+'\n');};
 seed('fixture-here',work);seed('fixture-other',other);seed('fixture-mirror',path.join(dir,'foreign-host'),work);
 // A session in which nothing happened (a `/model`, then quit), long quiet: neither editor lists it.
 const empty=path.join(env.CLAUDE_CONFIG_DIR,'projects',work.replace(/[^a-zA-Z0-9]/g,'-'),'fixture-empty.jsonl');
 fs.writeFileSync(empty,JSON.stringify({type:'user',cwd:work,sessionId:'fixture-empty',message:{role:'user',content:'<command-name>/model</command-name>'}})+'\n');fs.utimesSync(empty,1e6,1e6);
 // A worker still at it (a call of its own waiting for its result) rides its session's row.
 const sub=path.join(env.CLAUDE_CONFIG_DIR,'projects',work.replace(/[^a-zA-Z0-9]/g,'-'),'fixture-here','subagents');fs.mkdirSync(sub,{recursive:true});
 fs.writeFileSync(path.join(sub,'agent-fixture-worker.jsonl'),JSON.stringify({isSidechain:true,agentId:'fixture-worker',type:'assistant',timestamp:new Date().toISOString(),
  message:{role:'assistant',model:'claude-opus-4-1',content:[{type:'tool_use',id:'fixture-call',name:'Bash',input:{command:'make'}}]}})+'\n');
 const cli=(...args)=>{const r=spawnSync(process.execPath,[process.env.OAK_LISTING_TEST_CLI || path.resolve(__dirname,'../packages/cli/dist/index.js'),...args],{cwd:work,env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return r.stdout;};
 const listing=JSON.parse(cli('sessions','--json'));
 assert.deepEqual(listing.sessions.map(r=>r.id),['fixture-here','fixture-other']);
 assert.deepEqual(listing.sessions.map(r=>r.activeWorkers.map(w=>[w.agentId,w.model])),[[['fixture-worker','Opus 4.1']],[]],'every row carries its workers still at it, none an empty list');
 assert.match(listing.sessions[0].activeWorkers[0].phase,/^(working|awaiting-permission)$/);
 assert.equal(listing.sessions[0].workspace,'~/work');
 assert.equal(listing.sessions[0].tokens,30);
 assert.deepEqual(JSON.parse(cli('views','--views','sessions','--json')).sessions,listing);
 const text=cli('sessions');assert.match(text,/~\/work · 1 session/);assert.match(text,/0 edits · 30 tok · 0s/);assert.doesNotMatch(text,/fixture-mirror|bridge|reachable/);
 assert.ok(text.indexOf('~/work ·')<text.indexOf('~/other ·'));
});
// Codex's Auto-review runs each approval as a thread with a rollout of its own. Every surface lists sessions
// through this CLI (the terminal app's picker reads the batched `views --views sessions`), so it leaves them out
// for all of them; `--session` naming one and `--all` list it, and usage still counts it.
test('sessions CLI leaves out Codex Auto-review threads unless named or --all; usage still counts them',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oak-sessions-review-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const env={...process.env,HOME:dir,USERPROFILE:dir,CLAUDE_CONFIG_DIR:path.join(dir,'config'),CODEX_HOME:path.join(dir,'codex'),XDG_CONFIG_HOME:path.join(dir,'xdg'),HERDR_BIN:path.join(dir,'absent-herdr'),HERDR_SOCKET_PATH:path.join(dir,'no-socket')};
 const work=path.join(dir,'work');fs.mkdirSync(work);
 const rollout=(id,prompt,meta,input,output)=>{const base=path.join(env.CODEX_HOME,'sessions','2026','09','30');fs.mkdirSync(base,{recursive:true});
  const file=path.join(base,`rollout-2026-09-30T12-00-00-${id}.jsonl`);
  fs.writeFileSync(file,[{type:'session_meta',payload:{id,cwd:work,...meta}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}},
  {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:0,output_tokens:output}}}}]
  .map(r=>JSON.stringify({timestamp:new Date().toISOString(),...r})).join('\n')+'\n');return file;};
 const PARENT='0199a000-0000-7000-8000-0000000000b1',REVIEW='0199a000-0000-7000-8000-0000000000b2';
 fs.utimesSync(rollout(PARENT,'Fix the fixture exporter',{},1000,100),1e6,1e6);
 rollout(REVIEW,'The following is the Codex agent history whose request action you are assessing.',{thread_source:'guardian_review',parent_thread_id:PARENT},300,30);
 const cli=(...args)=>{const r=spawnSync(process.execPath,[process.env.OAK_LISTING_TEST_CLI || path.resolve(__dirname,'../packages/cli/dist/index.js'),...args],{cwd:work,env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return r.stdout;};
 const ids=(...args)=>JSON.parse(cli('sessions','--json',...args)).sessions.map(r=>r.id).sort();
 assert.deepEqual(ids(),[PARENT],'the session is listed, its review is not');
 assert.equal(JSON.parse(cli('sessions','--json')).active,PARENT,'and the review, though newer, is not the session this workspace resolves to');
 assert.deepEqual(JSON.parse(cli('views','--views','sessions','--json','--root',work)).sessions.sessions.map(r=>r.id),[PARENT],'the terminal app\'s picker read');
 assert.doesNotMatch(cli('sessions'),/Auto-review/);
 assert.deepEqual(ids('--all'),[PARENT,REVIEW].sort(),'--all lists it');
 const named=JSON.parse(cli('sessions','--json','--session',REVIEW)).sessions.find(r=>r.id===REVIEW);
 assert.equal(named?.title,'Auto-review: Fix the fixture exporter','--session naming it lists it, under its title');
 assert.equal(JSON.parse(cli('conversation','--json','--session',REVIEW,'--limit','5')).agent,'codex','and its views still open');
 const usage=JSON.parse(cli('usage','--breakdown','--by','model','--agent','codex','--json'));
 assert.equal(usage.agents[0].totals.tokens,1430,'usage counts the review\'s tokens with its session\'s');
});

// One rollout whose session id no store path can take (written by hand, or damaged) is left out of the listing, from
// the index and from the files: the files' listing threw "invalid session id" for it and listed nothing at all.
test('sessions CLI: a Codex rollout with an unsafe session id is left out, and every other session is listed',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oak-sessions-unsafe-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const env={...process.env,HOME:dir,USERPROFILE:dir,CLAUDE_CONFIG_DIR:path.join(dir,'config'),CODEX_HOME:path.join(dir,'codex'),XDG_CONFIG_HOME:path.join(dir,'xdg'),HERDR_BIN:path.join(dir,'absent-herdr'),HERDR_SOCKET_PATH:path.join(dir,'no-socket'),OAK_NO_BACKGROUND:'1'};
 const work=path.join(dir,'work');fs.mkdirSync(work);
 const base=path.join(env.CODEX_HOME,'sessions','2026','11','01');fs.mkdirSync(base,{recursive:true});
 const rollout=(name,id)=>fs.writeFileSync(path.join(base,`rollout-2026-11-01T10-00-00-${name}.jsonl`),[{type:'session_meta',payload:{id,cwd:work}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`Run ${name}`}]}}]
  .map(r=>JSON.stringify({timestamp:new Date().toISOString(),...r})).join('\n')+'\n');
 const GOOD='0199b000-0000-7000-8000-0000000000d1';
 rollout(GOOD,GOOD);
 rollout('0199b000-0000-7000-8000-0000000000d2','../escape');
 for(const extra of [{},{OAK_INDEX:'off'}]){
  const r=spawnSync(process.execPath,[process.env.OAK_LISTING_TEST_CLI || path.resolve(__dirname,'../packages/cli/dist/index.js'),'sessions','--json'],{cwd:work,env:{...env,...extra},encoding:'utf8',timeout:20000});
  assert.equal(r.status,0,`${JSON.stringify(extra)}: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout).sessions.map(s=>s.id),[GOOD],`${JSON.stringify(extra)}: the session with a safe id is listed, the other left out`);
 }
});
