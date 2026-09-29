const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
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
 const cli=(...args)=>{const r=spawnSync(process.execPath,[process.env.OAK_LISTING_TEST_CLI || path.resolve(__dirname,'../packages/cli/dist/index.js'),...args],{cwd:work,env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return r.stdout;};
 const listing=JSON.parse(cli('sessions','--json'));
 assert.deepEqual(listing.sessions.map(r=>r.id),['fixture-here','fixture-other']);
 assert.equal(listing.sessions[0].workspace,'~/work');
 assert.equal(listing.sessions[0].tokens,30);
 assert.deepEqual(JSON.parse(cli('views','--views','sessions','--json')).sessions,listing);
 const text=cli('sessions');assert.match(text,/~\/work · 1 session/);assert.match(text,/0 edits · 30 tok · 0s/);assert.doesNotMatch(text,/fixture-mirror|bridge|reachable/);
 assert.ok(text.indexOf('~/work ·')<text.indexOf('~/other ·'));
});
