const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require(process.env.OAK_LISTING_TEST_DIST || '../dist');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-session-list-'));
  const old = { ...process.env };
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  process.env.CODEX_HOME = path.join(dir, 'codex');
  const work = path.join(dir, 'work'); fs.mkdirSync(work);
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); core.clearFsCache(); fs.rmSync(dir,{recursive:true,force:true}); });
  const write = (file, records) => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,records.map(x=>JSON.stringify(x)).join('\n')+'\n'); return file; };
  const claude = (id,cwd,records,folder=cwd) => write(path.join(core.projectDir(folder),id+'.jsonl'),records.map(r=>({cwd,sessionId:id,...r})));
  const rollout = (id,records,extra={}) => write(path.join(process.env.CODEX_HOME,'sessions',id+'.jsonl'),[
    {type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id,cwd:work,...extra}},...records]);
  return {dir,work,write,claude,rollout};
}
const user = text => ({type:'user',message:{role:'user',content:text}});
const answer = {type:'assistant',message:{id:'fixture-answer',role:'assistant',model:'claude-opus-4-1',content:[],usage:{input_tokens:100,output_tokens:20}}};
const cxUser = text => ({type:'response_item',timestamp:'2026-01-01T00:00:01Z',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
test('local transcript stays; mirrored copies and bridge pointers cannot list or resolve',t=>{
  const f=fixture(t);
  const local=f.claude('fixture-local',f.work,[user('Local work'),answer]);
  const foreign=path.join(f.dir,'other-host','work');
  const mirror=f.claude('fixture-mirror',foreign,[user('Foreign work'),answer],f.work);
  f.claude('fixture-bridge',f.work,[{type:'bridge-session',bridgeSessionId:'fixture-remote',lastSequenceNum:3},{type:'cost-state'}]);
  fs.utimesSync(local,10,10); fs.utimesSync(mirror,20,20);
  assert.equal(core.resolveSessionId(f.work),'fixture-local');
  assert.equal(core.newestSessionGlobal(),'fixture-local');
  assert.deepEqual(core.sessionMeta(f.work,'fixture-mirror').sessions.map(r=>r.id),['fixture-local']);
  assert.equal(core.findTranscript(f.work,'fixture-mirror'),null);
  assert.equal(core.sessionWorkspace('fixture-mirror'),null);
  assert.deepEqual(core.isMirroredTranscript(mirror),{mirrored:true,recordedCwd:foreign});
  assert.deepEqual(core.isMirroredTranscript(local),{mirrored:false,recordedCwd:f.work});
  assert.deepEqual(core.transcriptSessionIds(f.work),['fixture-local']);
});
test('a matching local workspace remains valid after deletion; mismatched existing workspace is a mirror',t=>{
  const f=fixture(t), gone=path.join(f.dir,'pruned-work'); fs.mkdirSync(gone);
  const local=f.claude('fixture-pruned',gone,[user('Keep local history'),answer]); fs.rmdirSync(gone);
  const mirror=f.claude('fixture-wrong-folder',f.dir,[answer],f.work);
  assert.equal(core.isMirroredTranscript(local).mirrored,false);
  assert.equal(core.isMirroredTranscript(mirror).mirrored,true);
  assert.ok(core.sessionMeta(f.work).sessions.some(r=>r.id==='fixture-pruned'));
});
test('bridge-prefixed real local conversation retains its title and stats',t=>{
 const f=fixture(t); f.claude('fixture-continued',f.work,[{type:'bridge-session',bridgeSessionId:'fixture-remote'},user('Local continuation'),answer]);
 const row=core.sessionMeta(f.work).sessions[0]; assert.ok(row); assert.equal(row.origin,'local'); assert.equal(row.title,'Local continuation'); assert.equal(row.tokens,120);
});
test('workspace grouping prefers editor root, then recent workspaces and recent sessions; ids are unique',t=>{
 const f=fixture(t), other=path.join(f.dir,'other'), third=path.join(f.dir,'third'); fs.mkdirSync(other);fs.mkdirSync(third);
 for(const [id,cwd,time] of [['fixture-here-old',f.work,10],['fixture-other',other,40],['fixture-here-new',f.work,20],['fixture-third',third,30]]) {const p=f.claude(id,cwd,[user(id),answer]);fs.utimesSync(p,time,time);}
 f.claude('fixture-other',other,[answer],f.work); // copied into another project folder
 const rows=core.sessionMeta(f.work).sessions;
 assert.deepEqual(rows.map(r=>r.id),['fixture-here-new','fixture-here-old','fixture-other','fixture-third']);
 assert.equal(rows[0].workspace,f.work); assert.equal(rows[2].workspace,other);
});
test('Codex index title beats context and refreshes on index-only rename; rollout supplies local stats',t=>{
 const f=fixture(t),id='fixture-codex';
 const file=f.rollout(id,[cxUser('# AGENTS.md instructions\n<INSTRUCTIONS>Injected</INSTRUCTIONS>'),cxUser('<environment_context>Injected</environment_context>'),cxUser('Implement the real feature'),
 {type:'turn_context',timestamp:'2026-01-01T00:00:02Z',payload:{model:'gpt-6',effort:'high'}},
 {type:'event_msg',timestamp:'2026-01-01T00:01:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:1000,cached_input_tokens:400,output_tokens:100}}}}]);
 const index=path.join(process.env.CODEX_HOME,'session_index.jsonl'); f.write(index,[{id,thread_name:'Native thread name',updated_at:'2026-01-01'}]);
 let row=core.sessionMeta(f.work).sessions.find(r=>r.id===id);
 assert.equal(row.title,'Native thread name'); assert.equal(row.tokens,700); assert.equal(row.cached,400); assert.equal(row.durationMs,60000); assert.ok(row.model.includes('gpt-6')); assert.equal(row.edits,0);
 assert.equal(row.lastActiveMs,fs.statSync(file).mtimeMs,'raw rollout recency, not derived-file generation time');
 fs.appendFileSync(index,JSON.stringify({id,thread_name:'Renamed native thread',updated_at:'2026-01-02'})+'\n');
 row=core.sessionMeta(f.work).sessions.find(r=>r.id===id); assert.equal(row.title,'Renamed native thread');
});
test('Codex uses rollout title, then real prompt beyond injected context; preserves full title',t=>{
 const f=fixture(t);
 const prompt='Explain how to handle a very long real user request without dropping any of its meaningful words';
 f.rollout('fixture-prompt',[cxUser('# AGENTS.md instructions\n<INSTRUCTIONS>'+ 'context '.repeat(50000)+'</INSTRUCTIONS>'),cxUser('<user_instructions>Injected</user_instructions>'),cxUser('<recommended_plugins>Injected</recommended_plugins>'),cxUser(prompt)]);
 f.rollout('fixture-native',[cxUser('A fallback prompt')],{title:'Rollout title'});
 const rows=core.sessionMeta(f.work).sessions;
 assert.equal(rows.find(r=>r.id==='fixture-prompt').title,prompt);
 assert.equal(rows.find(r=>r.id==='fixture-native').title,'Rollout title');
});
test('foreign-platform Codex rollouts are excluded, with a local rollout as positive control',t=>{
 const f=fixture(t);
 f.rollout('fixture-local-codex',[cxUser('Local task')]);
 const foreign=process.platform==='darwin'?'/home/user/fixture-foreign-workspace':'/Users/you/fixture-foreign-workspace';
 const file=f.rollout('fixture-mirrored-codex',[cxUser('Foreign task')],{cwd:foreign});
 assert.equal(core.isMirroredTranscript(file).mirrored,true);
 assert.deepEqual(core.sessionMeta(f.work).sessions.map(r=>r.id),['fixture-local-codex']);
 assert.equal(core.resolveSessionId(f.work),'fixture-local-codex');
});
test('bridge-only workspace has no current session; a new real local turn is still selectable',t=>{
 const f=fixture(t);
 f.claude('fixture-only-bridge',f.work,[{type:'bridge-session',bridgeSessionId:'fixture-service'}]);
 assert.equal(core.resolveSessionId(f.work),null);
 assert.equal(core.newestSessionGlobal(),null);
 assert.deepEqual(core.sessionMeta(f.work).sessions,[]);
 f.claude('fixture-first-turn',f.work,[user('My first real prompt')]);
 assert.equal(core.resolveSessionId(f.work),'fixture-first-turn');
});
test('picker conversation search cannot reintroduce mirrored sessions from its index or store',t=>{
 const f=fixture(t), timestamp='2026-01-01T00:00:00Z';
 f.claude('fixture-search-local',f.work,[{...user('Find the matching phrase'),timestamp},answer]);
 f.claude('fixture-search-mirror',path.join(f.dir,'foreign-work'),[{...user('Find the matching phrase'),timestamp},answer],f.work);
 core.ensureStore('fixture-search-mirror');
 const hits=core.searchConversations(f.work,'matching phrase').hits;
 assert.deepEqual(hits.map(h=>h.session),['fixture-search-local']);
 assert.equal(hits[0].workspace,f.work);
});
test('conversation search: --per-session keeps each session\'s best hit before the limit, and every answer counts what the limit cut',t=>{
 const f=fixture(t), timestamp='2026-01-01T00:00:00Z';
 // One chatty session asks about the kestrel five times, the third time three times over; a quiet one once.
 const best='kestrel kestrel kestrel step 3';
 f.claude('fixture-chatty',f.work,[1,2,3,4,5].flatMap(i=>[{...user(i===3?best:`kestrel step ${i}`),timestamp},answer]));
 f.claude('fixture-quiet',f.work,[{...user('one kestrel'),timestamp},answer]);
 const asks=core.searchConversations(f.work,'kestrel',{limit:2});
 assert.equal(asks.matched,6);
 assert.equal(asks.hits.length,2);
 const per=core.searchConversations(f.work,'kestrel',{limit:2,perSession:true});
 assert.deepEqual(per.hits.map(h=>h.session).sort(),['fixture-chatty','fixture-quiet'],'one row per session, so the quiet one is not crowded out');
 assert.equal(per.hits.find(h=>h.session==='fixture-chatty').prompt,best,'the row a session keeps is its best hit');
 assert.equal(per.matched,2);
 const cut=core.searchConversations(f.work,'kestrel',{limit:1,perSession:true});
 assert.equal(cut.hits.length,1);
 assert.equal(cut.hits[0].prompt,best);
 assert.equal(cut.matched,2,'the count says one session was left out');
});
test('conversation search: the next index write removes a temp file a stopped search left, and only one whose writer is gone',t=>{
 const f=fixture(t), timestamp='2026-01-01T00:00:00Z';
 const file=f.claude('fixture-temp',f.work,[{...user('the heron ask'),timestamp},answer]);
 assert.equal(core.searchConversations(f.work,'heron').hits.length,1);
 const dir=path.join(core.rootDir(),'changemap-cache','fixture-temp'); // the index lives among the derived caches
 const gone=require('node:child_process').spawnSync(process.execPath,['-e','0']).pid; // exited: no process has its pid
 const temp=(name)=>path.join(dir,name);
 const left=[`search-index-v5.json.${gone}.tmp`,`search-index-v5.json.${process.ppid}.tmp`,'search-index-v5.json.notes.tmp',`other.${gone}.tmp`];
 for (const name of left) fs.writeFileSync(temp(name),'a partial index');
 // The transcript grows, so the next search writes the index again.
 fs.appendFileSync(file,JSON.stringify({cwd:f.work,sessionId:'fixture-temp',...user('a second heron ask'),timestamp})+'\n');
 assert.equal(core.searchConversations(f.work,'heron').hits.length,2);
 assert.deepEqual(left.filter(name=>fs.existsSync(temp(name))),left.slice(1),'the dead writer\'s file is gone; a running writer\'s and every other file stay');
});
const brief=(file,heading)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,heading+'\n\nThe body of the brief.\n');return file;};
const nameThreads=(f,names)=>f.write(path.join(process.env.CODEX_HOME,'session_index.jsonl'),Object.entries(names).map(([id,thread_name])=>({id,thread_name,updated_at:'2026-01-01'})));
const titlesOf=(f,opts)=>Object.fromEntries(core.sessionMeta(f.work,null,opts).sessions.map(r=>[r.id,r.title]));
test('a Codex title that only hands its task to a brief is named by the brief heading; informative names stay',t=>{
 const f=fixture(t);
 process.env.HOME=process.env.USERPROFILE=f.dir; // `~/` resolves here (the fixture restores both)
 const task=brief(path.join(f.work,'FIXTURE-TASK.md'),'# Task (fixture): build the widget exporter');
 brief(path.join(f.dir,'COMMON.md'),'# Common rules for every fixture agent');
 const plan=brief(path.join(f.dir,'plans','fixture-plan-exporter.md'),'﻿# Task: `exporter.ts` — the fixture exporter'); // with a byte-order mark
 brief(path.join(f.dir,'briefs','fixture-home-task.md'),'# Task: tidy the fixture home');
 const handoff='Read FIXTURE-TASK.md in the current directory and carry it out completely. Your final message must be the report it asks for.';
 const commonFirst='Read ../COMMON.md first, then FIXTURE-TASK.md in the current directory, and carry the task out completely.';
 const prompts={'fixture-literal':commonFirst,'fixture-stem':commonFirst,'fixture-exec':handoff,'fixture-mention':'Carry out @FIXTURE-TASK.md.',
  'fixture-own-words':'Read FIXTURE-TASK.md and tighten its wording.','fixture-generic':'Fix the flaky parser test; FIXTURE-TASK.md explains how to run it.',
  'fixture-read':'Read FIXTURE-TASK.md.','fixture-section':'# Task\n\nFix the typo in FIXTURE-TASK.md','fixture-url':'Read file:///fixture-task/FIXTURE-TASK.md and carry it out.',
  'fixture-absolute':`Read ${plan} and implement it exactly, autonomously, without asking questions.`,'fixture-home':'Read ~/briefs/fixture-home-task.md and carry it out.'};
 for(const [id,prompt] of Object.entries(prompts)) f.rollout(id,[cxUser(prompt)]);
 nameThreads(f,{'fixture-literal':'Execute FIXTURE-TASK.md','fixture-stem':'Complete FIXTURE task','fixture-own-words':'Review FIXTURE-TASK.md wording',
  'fixture-generic':'Complete the task','fixture-absolute':'Implement plan exporter'});
 const kept={...prompts,'fixture-literal':'Execute FIXTURE-TASK.md','fixture-stem':'Complete FIXTURE task','fixture-own-words':'Review FIXTURE-TASK.md wording',
  'fixture-generic':'Complete the task','fixture-absolute':'`exporter.ts` — the fixture exporter','fixture-home':'tidy the fixture home',
  'fixture-section':'Task Fix the typo in FIXTURE-TASK.md', // a kept prompt is still one line of plain text
  'fixture-exec':'Read FIXTURE-TASK.md in the current directory and carry it out completely.'}; // a long one, its first sentence
 const heading='build the widget exporter';
 assert.deepEqual(titlesOf(f),{...kept,'fixture-literal':heading,'fixture-stem':heading,'fixture-exec':heading,'fixture-mention':heading});
 fs.writeFileSync(task,'# Task: export widgets as CSV and JSON\n'); // an edited brief shows at once
 assert.equal(titlesOf(f)['fixture-stem'],'export widgets as CSV and JSON');
 fs.writeFileSync(task,'# FIXTURE-TASK\n'); // a heading that only repeats the file name says no more than the hand-off
 assert.equal(titlesOf(f)['fixture-literal'],'Execute FIXTURE-TASK.md');
 fs.rmSync(task); // a brief that is gone leaves the hand-off as it was
 assert.deepEqual(titlesOf(f),kept);
});
test('a Codex brief pasted as the prompt is named by its heading; only a leading, title-like heading counts',t=>{
 const f=fixture(t);
 f.rollout('fixture-pasted',[cxUser('# Task: make the fixture theme the default\n\nYou are working in a private copy of the fixture repository.')]);
 const log='Please look at this failure:\n# Error log\nTraceback (most recent call last)', section='# Context\n\nThe CSV export drops rows. Fix the parser.';
 f.rollout('fixture-log',[cxUser(log)]);
 f.rollout('fixture-context',[cxUser(section)]);
 // A heading that does not name the task keeps its words as plain text: no marker, no line break.
 assert.deepEqual(titlesOf(f),{'fixture-pasted':'make the fixture theme the default',
  'fixture-log':'Please look at this failure','fixture-context':'Context The CSV export drops rows. Fix the parser.'}); // a long one, its first phrase
});
test('a long title OAK derives for Codex is cut to its first phrase, never clipped; names and short titles stay whole (2026-09-27)',t=>{
 const f=fixture(t);
 brief(path.join(f.work,'GOAL-TASK.md'),"# the fixture importer's column map — one schema, grouped by table, every column typed and with notes");
 f.rollout('fixture-goal',[cxUser('Read GOAL-TASK.md in the current directory and carry it out completely.')]);
 const noBreak='Fix parser.ts so the export keeps every row and then rerun the whole fixture suite end to end';
 f.rollout('fixture-nobreak',[cxUser(noBreak)]);
 const bothCuts='Fix the parser: it drops rows on export. Then rerun the whole fixture suite end to end please';
 f.rollout('fixture-both-cuts',[cxUser(bothCuts)]);
 const longName='Refactor the exporter module — split readers from writers and add streaming support';
 f.rollout('fixture-named',[cxUser('Refactor the exporter.')]);
 nameThreads(f,{'fixture-named':longName});
 const codeLead='`exporter.ts` — the fixture exporter that streams every row to CSV and JSON on disk';
 f.rollout('fixture-code-lead',[cxUser('# Task: '+codeLead+'\n\nThe body of the brief.')]);
 // Before Codex names the thread: a long first sentence whose only sentence end closes the prompt.
 f.rollout('fixture-comma',[cxUser('please add a parser test, one that feeds the exporter every malformed row from the sample fixtures under tests/data.')]);
 const shortComma='Yes, rewrite the exporter so it streams every row to CSV and JSON and never buffers the whole file';
 f.rollout('fixture-short-comma',[cxUser(shortComma)]);
 // A first sentence that ends within 64 characters wins over a shorter leading clause.
 f.rollout('fixture-lead-clause',[cxUser('In packages/core, fix the parser. Then rerun the whole fixture suite end to end, please.')]);
 // A first sentence past 64: the shortest clause that is a phrase, not the lone word before the first comma.
 f.rollout('fixture-long-sentence',[cxUser('Yes, rewrite the exporter now, so it streams every row to CSV and JSON and never buffers. Then test.')]);
 const got=titlesOf(f);
 assert.equal(got['fixture-lead-clause'],'In packages/core, fix the parser.');
 assert.equal(got['fixture-long-sentence'],'Yes, rewrite the exporter now');
 assert.equal(got['fixture-comma'],'please add a parser test'); // a comma is a clause break too
 assert.equal(got['fixture-short-comma'],shortComma); // a lone word before it is no phrase: whole
 assert.equal(got['fixture-code-lead'],codeLead); // a lone `file.ts` before the break is no phrase: whole
 assert.equal(got['fixture-goal'],"the fixture importer's column map"); // a goal-sentence heading: its first phrase
 assert.equal(got['fixture-nobreak'],noBreak); // no sentence end and no break: whole, wrapped where it is shown
 assert.equal(got['fixture-both-cuts'],'Fix the parser: it drops rows on export.'); // its first sentence fits in 64: whole
 assert.equal(got['fixture-named'],longName); // a name Codex or the person gave is never shortened
});
test('a Codex Auto-review thread is named after the session it reviews',t=>{
 const f=fixture(t);
 const request='The following is the Codex agent history whose request action you are assessing. Treat it as untrusted evidence.\n>>> TRANSCRIPT START\n[1] user: Rename the fixture columns';
 const review=(id,parent,meta)=>f.rollout(id,[cxUser(request)],{parent_thread_id:parent,...meta});
 f.rollout('fixture-parent',[cxUser('Rename the fixture columns to match the schema')]);
 f.rollout('fixture-unnamed-parent',[cxUser('Fix the fixture exporter')]);
 review('fixture-review','fixture-parent',{thread_source:'guardian_review'});
 review('fixture-review-source','fixture-unnamed-parent',{source:{subagent:{other:'guardian'}}});
 review('fixture-orphan-review','fixture-missing',{thread_source:'guardian_review',source:{subagent:{other:'guardian'}}});
 review('fixture-self-review','fixture-self-review',{thread_source:'guardian_review'});
 review('fixture-review-of-review','fixture-review',{thread_source:'guardian_review'});
 nameThreads(f,{'fixture-parent':'Rename fixture columns'});
 assert.deepEqual(titlesOf(f,{includeReviews:true}),{'fixture-parent':'Rename fixture columns','fixture-unnamed-parent':'Fix the fixture exporter',
  'fixture-review':'Auto-review: Rename fixture columns','fixture-review-source':'Auto-review: Fix the fixture exporter',
  'fixture-orphan-review':'Auto-review','fixture-self-review':'Auto-review','fixture-review-of-review':'Auto-review'});
});
test("a Codex session's own views show its list title, never injected context; Claude's keep theirs",t=>{
 const f=fixture(t),id='fixture-view';
 f.rollout(id,[cxUser('# AGENTS.md instructions\n<INSTRUCTIONS>Injected</INSTRUCTIONS>'),cxUser('<environment_context>Injected</environment_context>'),cxUser('Implement the fixture exporter')]);
 const index=nameThreads(f,{[id]:'Build fixture exporter'});
 core.ensureStore(id); fs.writeFileSync(core.logPath(id),''); // a store log: the map is cached on disk
 const opts={root:f.work,prompts:true};
 assert.equal(core.sessionMeta(f.work).sessions.find(r=>r.id===id).title,'Build fixture exporter');
 assert.equal(core.cachedChangeMap(f.work,id,opts).summary.title,'Build fixture exporter'); // terminal chip, JetBrains Stats
 fs.appendFileSync(index,JSON.stringify({id,thread_name:'Ship fixture exporter',updated_at:'2026-01-02'})+'\n');
 assert.equal(core.cachedChangeMap(f.work,id,opts).summary.title,'Ship fixture exporter','a rename reaches a map cached on disk');
 f.claude('fixture-claude',f.work,[{type:'ai-title',aiTitle:'Claude fixture title'},user('A Claude prompt'),answer]);
 assert.equal(core.buildChangeMap(f.work,'fixture-claude',{root:f.work}).summary.title,'Claude fixture title');
 const vscode=fs.readFileSync(path.join(__dirname,'../../vscode/src/extension.ts'),'utf8'); // the VS Code Stats header
 assert.match(vscode,/sessionTitle = \(core\.sessionViewTitle\(cwd, session\) \?\? ''\)/);
});

// Sessions in which nothing happened (2026-09-24). OLD is long quiet: outside every liveness window.
const OLD = 1_000_000;
const age = (file, sec = OLD) => { fs.utimesSync(file, sec, sec); return file; };
const cxModel = {type:'turn_context',timestamp:'2026-01-01T00:00:02Z',payload:{model:'fixture-model'}};
const cxCall = {type:'response_item',timestamp:'2026-01-01T00:00:03Z',payload:{type:'function_call',name:'exec_command',arguments:'{"cmd":"ls"}',call_id:'fixture-call'}};
// A workspace outside every temp root: the listing drops a rollout-less Codex session run in a temp dir.
const HOOKED = path.join(path.parse(os.tmpdir()).root, 'fixture-hook-workspace');
/** A Codex session known only from its hooks (no rollout), the way an ephemeral thread is. */
function hookOnly(f, id, { cwd, prompt = 'A fixture task', edits = 0, attention } = {}) {
  core.ensureStore(id);
  const dir = core.storeDir(id);
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ agent: 'codex', ...(cwd ? { cwd } : {}), updated: 1 }));
  if (prompt !== null) fs.writeFileSync(path.join(dir, 'capture-events.jsonl'), JSON.stringify({ ts: 1000, kind: 'turn_start', payload: { prompt } }) + '\n');
  for (let i = 0; i < edits; i++) core.appendLog(id, { ts: 1000 + i, tool: 'Edit', file: path.join(f.dir, `fixture-${id}-${i}.txt`),
    beforeBlob: core.writeBlob(id, Buffer.from('a\n')), afterBlob: core.writeBlob(id, Buffer.from(`b${i}\n`)), status: 'pending' });
  if (attention) fs.writeFileSync(path.join(dir, 'attention.json'), JSON.stringify({ kind: attention, message: '', ts: 1000 }));
  for (const n of fs.readdirSync(dir)) age(path.join(dir, n));
}
test('a session in which nothing happened is not listed; an edit, a token or a model turn keeps it', t => {
  const f = fixture(t);
  const empty = [
    f.claude('fixture-command-only', f.work, [{type:'mode',mode:'normal'}, user('<command-name>/model</command-name>'), user('<local-command-stdout>Set model</local-command-stdout>')]),
    f.claude('fixture-api-error', f.work, [user('Reply with ok'), {type:'assistant',isApiErrorMessage:true,message:{id:'fixture-error',role:'assistant',model:'<synthetic>',
      content:[{type:'text',text:'Not logged in · Please run /login'}],usage:{input_tokens:0,output_tokens:0}}}]),
    f.claude('fixture-unanswered', f.work, [user('A prompt the model never answered')]),
    f.rollout('fixture-codex-unanswered', [cxUser('Reply with exactly: ok'), cxModel]),
  ];
  const kept = [
    f.claude('fixture-no-usage', f.work, [user('An answer without usage'), {type:'assistant',message:{id:'fixture-plain',role:'assistant',content:[{type:'text',text:'Done.'}]}}]),
    f.rollout('fixture-codex-no-usage', [cxUser('Run the probe'), cxModel, cxCall]), // the provider reported no usage; the model worked
  ];
  for (const file of [...empty, ...kept]) age(file);
  age(f.claude('fixture-answered', f.work, [user('Real work'), answer]), OLD + 100); // the newest real one: the current session
  hookOnly(f, 'fixture-hook-empty', { cwd: HOOKED });
  hookOnly(f, 'fixture-hook-edits', { cwd: HOOKED, edits: 1 });
  const ids = core.sessionMeta(f.work).sessions.map(r => r.id).sort();
  assert.deepEqual(ids, ['fixture-answered', 'fixture-codex-no-usage', 'fixture-hook-edits', 'fixture-no-usage']);
  assert.equal(core.sessionMeta(f.work).sessions.find(r => r.id === 'fixture-codex-no-usage').tokens, 0, 'listed for its model turn, not its tokens');
  // The reaper still sees them: nothing happened in them, which makes them the most finished of all.
  const reapable = core.reapableSessions(f.work).map(r => r.id);
  for (const id of ['fixture-command-only', 'fixture-api-error', 'fixture-unanswered']) assert.ok(reapable.includes(id), id);
  assert.equal(core.sessionMeta(f.work, null, { includeEmpty: true }).sessions.length, 9);
});
test('a session that may still be running is listed before its first reply', t => {
  const f = fixture(t), now = Date.now() / 1000;
  const meta = [{type:'mode',mode:'normal'},{type:'permission-mode',permissionMode:'default'}];
  age(f.claude('fixture-current', f.work, [user('Real work'), answer]), now - 20 * 60); // current, so no other row is
  for (const id of ['fixture-running', 'fixture-exited', 'fixture-pinned']) age(f.claude(id, f.work, meta));
  f.claude('fixture-fresh', f.work, meta); // written just now
  const sessions = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'fixture-running', cwd: f.work }));
  fs.writeFileSync(path.join(sessions, '99999999.json'), JSON.stringify({ pid: 99999999, sessionId: 'fixture-exited', cwd: f.work }));
  age(f.rollout('fixture-turn', [cxUser('Start the long task'), cxModel, {type:'event_msg',timestamp:'2026-01-01T00:00:03Z',payload:{type:'task_started',turn_id:'fixture-turn-1'}}]), now - 30 * 60);
  hookOnly(f, 'fixture-hand', { cwd: HOOKED, attention: 'permission' });
  hookOnly(f, 'fixture-idle-done', { cwd: HOOKED, attention: 'idle-done' });
  const rows = core.sessionMeta(f.work, 'fixture-pinned').sessions;
  assert.deepEqual(rows.map(r => r.id).sort(), ['fixture-current', 'fixture-fresh', 'fixture-hand', 'fixture-pinned', 'fixture-running', 'fixture-turn']);
  assert.equal(rows.find(r => r.id === 'fixture-turn').phase, 'working');
  assert.equal(rows.find(r => r.id === 'fixture-running').title, core.UNTITLED_SESSION_TITLES.claude);
  const other = path.join(f.dir, 'other'); fs.mkdirSync(other);
  age(f.claude('fixture-current-empty', other, meta)); // the only session there, so the one that workspace resolves to
  assert.ok(core.sessionMeta(other).sessions.some(r => r.id === 'fixture-current-empty' && r.current), 'the current session stays');
});
// A Codex agent that asked a question and kept working: herdr calls its pane blocked (Codex's title says "Action
// Required"); its row says the turn is still running, so OAK reads the pane as working with a question waiting.
test('a Codex row says whether its last turn is still running, and the pane herdr calls blocked reads from it', t => {
  const f = fixture(t), now = Date.now() / 1000;
  const event = (type) => ({type:'event_msg',timestamp:'2026-01-01T00:00:03Z',payload:{type,turn_id:'fixture-turn-1'}});
  const file = f.rollout('fixture-asking', [cxUser('Assess the processing step'), event('task_started')]);
  f.claude('fixture-claude', f.work, [user('Claude work'), answer]);
  const row = id => core.sessionMeta(f.work).sessions.find(r => r.id === id);
  const pane = { agent_status: 'blocked', agent: 'codex', agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: 'fixture-asking' } };
  assert.equal(row('fixture-asking').turnOpen, true, 'a task_started with no end after it');
  assert.equal(row('fixture-asking').lastActiveMs, fs.statSync(file).mtimeMs, 'its clock is the rollout\'s');
  assert.ok(!('turnOpen' in row('fixture-claude')), 'a Claude session has no Codex turn');
  assert.deepEqual(core.paneAgentState(pane, row('fixture-asking')), { status: 'working', question: true });
  // Quiet past the window while herdr says blocked: Codex is waiting, as herdr says.
  age(file, now - 5 * 60);
  assert.equal(row('fixture-asking').turnOpen, true);
  assert.deepEqual(core.paneAgentState(pane, row('fixture-asking')), { status: 'blocked', question: false });
  // Past the phase window it is not asked at all.
  age(file, now - 3 * 60 * 60);
  const old = core.sessionMeta(f.work, 'fixture-asking').sessions.find(r => r.id === 'fixture-asking');
  assert.ok(old, 'control: listed, as the session under review');
  assert.ok(!('turnOpen' in old) && !('phase' in old), 'not asked for an old session, as its phase is not');
  // The turn ends: blocked stays blocked.
  fs.appendFileSync(file, JSON.stringify(event('task_complete')) + '\n');
  assert.equal(row('fixture-asking').turnOpen, false);
  assert.deepEqual(core.paneAgentState(pane, row('fixture-asking')), { status: 'blocked', question: false });
});
// Every listing derives each rollout before it asks about its turn, and the derivation keeps the turn's state as it
// reads: a listing in a new process (an editor's tick, a saved machine's poll) reads no rollout back to its turn's start.
test('a Codex row\'s running turn comes from the rollout\'s derivation, however far back the turn began', t => {
  const f = fixture(t);
  const event = (type) => ({type:'event_msg',timestamp:'2026-01-01T00:00:03Z',payload:{type,turn_id:'fixture-turn-long'}});
  const output = {type:'response_item',timestamp:'2026-01-01T00:00:04Z',payload:{type:'function_call_output',call_id:'c',output:'x'.repeat(1 << 20)}};
  const file = f.rollout('fixture-long-turn', [cxUser('Run the long job'), event('task_started'),
    ...Array.from({ length: Math.ceil(core.ROLLOUT_SCAN_BYTES / (1 << 20)) + 1 }, () => output)]);
  assert.equal(core.codexTurnOpen(file), null, 'control: read back from the end, the start lies past the scan');
  const row = () => core.sessionMeta(f.work).sessions.find(r => r.id === 'fixture-long-turn');
  assert.equal(row().turnOpen, true, 'the derivation read the start');
  fs.appendFileSync(file, JSON.stringify(event('task_complete')) + '\n');
  assert.equal(row().turnOpen, false, 'and the end');
});
// A Codex call with no output yet awaits permission only when the session's hooks say so, as a Claude Code call does:
// the listing reads the hand by the session's id, as the transcript it reads is OAK's derivation of the rollout, named
// for neither. Elapsed time decides only for a session no hook records (2026-11-03).
test('a Codex call still running reads as working, and as awaiting permission only while the session\'s hand says so', t => {
  const f = fixture(t), id = 'fixture-codex-running';
  const started = {type:'event_msg',timestamp:'2026-01-01T00:00:02Z',payload:{type:'task_started',turn_id:'fixture-turn-1'}};
  age(f.rollout(id, [cxUser('Run the long job'), cxModel, started, cxCall]), Date.now() / 1000 - 60);
  const phase = () => { const r = core.sessionMeta(f.work).sessions.find(s => s.id === id); return { phase: r.phase, phaseConfidence: r.phaseConfidence }; };
  assert.deepEqual(phase(), { phase: 'awaiting-permission', phaseConfidence: 'heuristic' }, 'no hook records it: elapsed time is all there is');
  core.ensureStore(id);
  fs.writeFileSync(path.join(core.storeDir(id), 'agent.json'), JSON.stringify({ agent: 'codex', cwd: f.work, updated: 1 }));
  assert.deepEqual(phase(), { phase: 'working', phaseConfidence: 'high' }, 'its hooks record it and no prompt is up: the command runs');
  core.writeAttention(id, { kind: 'permission', message: 'Bash', ts: Date.now() });
  assert.deepEqual(phase(), { phase: 'awaiting-permission', phaseConfidence: 'high' }, 'its permission prompt is up');
  // Its session ended (Codex's SessionEnd lowers the hand to idle-done) with the call left without a result.
  core.writeAttention(id, { kind: 'idle-done', message: '', ts: Date.now() });
  assert.deepEqual(phase(), { phase: 'idle', phaseConfidence: 'heuristic' }, 'nothing runs the call now');
});
test('titles are plain text: no markdown heading markers, no line breaks, whatever the source', t => {
  const f = fixture(t);
  f.claude('fixture-heading', f.work, [user('## Fix the parser\n\nThe parser crashes on empty rows. Then more.'), answer]);
  f.claude('fixture-later-heading', f.work, [user('Please look at this:\n## Step one\nThen fix it.'), answer]); // a heading on any line
  f.claude('fixture-renamed', f.work, [{type:'custom-title',customTitle:'# Renamed\nfixture session'}, user('A prompt'), answer]);
  f.rollout('fixture-codex-named', [cxUser('Do the thing'), cxModel, cxCall]);
  nameThreads(f, { 'fixture-codex-named': 'Ship the fixture\nexporter' });
  hookOnly(f, 'fixture-hook-heading', { cwd: HOOKED, prompt: '## Plan\n\nDo the fixture thing', edits: 1 });
  const rows = core.sessionMeta(f.work).sessions;
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.id, r.title])), {
    'fixture-heading': 'Fix the parser The parser crashes on empty rows.', 'fixture-renamed': 'Renamed fixture session',
    'fixture-later-heading': 'Please look at this: Step one Then fix it.',
    'fixture-codex-named': 'Ship the fixture exporter', 'fixture-hook-heading': 'Plan Do the fixture thing',
  });
  // The session's own views — the terminal chip, the JetBrains and VS Code Stats headers — agree.
  assert.equal(core.buildChangeMap(f.work, 'fixture-heading', { root: f.work }).summary.title, 'Fix the parser The parser crashes on empty rows. Then more.');
  assert.equal(core.sessionViewTitle(f.work, 'fixture-renamed'), 'Renamed fixture session');
});
test('a Codex memory-writing thread is titled Codex memory update, never its prompt template', t => {
  const f = fixture(t);
  process.env.CODEX_HOME = path.join(path.parse(os.tmpdir()).root, 'fixture-codex-home'); // ~/.codex is no temp dir either
  const memories = path.join(process.env.CODEX_HOME, 'memories');
  hookOnly(f, 'fixture-memory', { cwd: memories, prompt: '## Memory Writing Agent: Phase 2 (Consolidation)\n\nYou are a Memory Writing Agent.', edits: 1 });
  hookOnly(f, 'fixture-memory-quiet', { cwd: memories, prompt: null, edits: 1 }); // its prompt never reached OAK
  hookOnly(f, 'fixture-memory-sibling', { cwd: path.join(memories, 'skills'), prompt: 'Tidy the skills folder', edits: 1 }); // positive control
  const rows = core.sessionMeta(f.work).sessions;
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.id, r.title])), { 'fixture-memory': 'Codex memory update', 'fixture-memory-quiet': 'Codex memory update',
    'fixture-memory-sibling': 'Tidy the skills folder' });
  assert.equal(rows.find(r => r.id === 'fixture-memory').workspace, core.workspaceLabel(memories));
});
// Codex's Auto-review runs each approval as a `guardian` thread with a rollout of its own, and they can outnumber
// the sessions a person started. The lists leave it out; naming it, `includeReviews` and usage keep it.
test('a Codex Auto-review thread is left out of the session lists; named, it is listed, and usage still counts it', t => {
  const f = fixture(t), ts = new Date().toISOString();
  const tokens = (input, output) => ({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } } });
  const request = 'The following is the Codex agent history whose request action you are assessing.';
  age(f.rollout('fixture-parent', [cxUser('Rename the fixture columns'), cxModel, tokens(1000, 100)]), OLD + 10);
  // Newer than the session they review, as each one is while its approval waits: the newest rollout here.
  age(f.rollout('fixture-review', [cxUser(request), cxModel, tokens(300, 30)], { parent_thread_id: 'fixture-parent', thread_source: 'guardian_review' }), OLD + 50);
  age(f.rollout('fixture-review-source', [cxUser(request), cxModel, tokens(200, 20)], { parent_thread_id: 'fixture-parent', source: { subagent: { other: 'guardian' } } }), OLD + 40);
  // Titled like a review but recorded as an ordinary thread: the title text is never the test.
  age(f.rollout('fixture-lookalike', [cxUser('Auto-review: Rename the fixture columns'), cxModel, tokens(10, 1)]), OLD);
  // An ordinary subagent's thread is a subagent too, but no guardian: it stays listed.
  age(f.rollout('fixture-subagent', [cxUser('Check the fixture column names'), cxModel, tokens(40, 4)], { parent_thread_id: 'fixture-parent', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'fixture-parent', depth: 1 } } } }), OLD + 5);
  // Codex's memory-writing agent: listed only for an edit it captured, so a quiet one with none is not.
  hookOnly(f, 'fixture-memory', { cwd: path.join(process.env.CODEX_HOME, 'memories'), prompt: '## Memory Writing Agent: Phase 2 (Consolidation)' });
  const ids = (meta) => meta.sessions.map((r) => r.id).sort();
  assert.deepEqual(ids(core.sessionMeta(f.work)), ['fixture-lookalike', 'fixture-parent', 'fixture-subagent']);
  assert.equal(core.resolveSessionId(f.work), 'fixture-parent', 'a review is never the session this workspace resolves to');
  assert.equal(core.sessionMeta(f.work).active, 'fixture-parent');
  assert.deepEqual(ids(core.sessionMeta(f.work, null, { includeReviews: true })), ['fixture-lookalike', 'fixture-parent', 'fixture-review', 'fixture-review-source', 'fixture-subagent']);
  // Named explicitly (`--session`), it is listed, under the title it always had.
  const named = core.sessionMeta(f.work, 'fixture-review').sessions;
  assert.deepEqual(named.map((r) => r.id).sort(), ['fixture-lookalike', 'fixture-parent', 'fixture-review', 'fixture-subagent']);
  assert.equal(named.find((r) => r.id === 'fixture-review').title, 'Auto-review: Rename the fixture columns');
  assert.equal(named.find((r) => r.id === 'fixture-review').tokens, 330);
  assert.ok(core.findTranscript(f.work, 'fixture-review'), 'its id still resolves to its conversation');
  // Usage counts every thread's tokens, reviews included: 1100 + 330 + 220 + 11 + 44.
  assert.equal(core.codexBreakdown('model', 0, null).totals.tokens, 1705);
  assert.equal(core.codexBreakdown('session', 0, null).buckets.length, 5, 'one usage row per thread');
});
// Codex 0.160.1 keeps an Auto-review thread's history paginated, names the thread "Guardian review" in its
// index, and may name its rollout `<thread>_<rollout>`; its session_meta carries the same two markers.
test('a Codex 0.160.1 Auto-review thread is left out of the session lists, as an older one is', t => {
  const f = fixture(t), ts = new Date().toISOString();
  const tokens = { type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 30 } } } };
  const P = '0199a000-0000-7000-8000-0000000000d1', G = '0199a000-0000-7000-8000-0000000000d2';
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '06');
  age(f.write(path.join(day, `rollout-2026-10-06T13-00-30-${P}.jsonl`), [{ type: 'session_meta', timestamp: ts, payload: { session_id: P, id: P,
    cwd: f.work, source: 'cli', thread_source: 'user', cli_version: '0.160.1' } }, cxUser('Tidy the fixture importer'), cxModel, tokens]), OLD + 10);
  age(f.write(path.join(day, `rollout-2026-10-06T13-00-31-${G}_0199a000-0000-7000-8000-0000000000d3.jsonl`), [{ type: 'session_meta', timestamp: ts,
    payload: { session_id: P, id: G, parent_thread_id: P, cwd: f.work, source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review',
      history_mode: 'paginated', cli_version: '0.160.1' } }, { type: 'event_msg', timestamp: ts, payload: { type: 'thread_settings_applied', thread_settings: {} } },
  cxUser('The following is the Codex agent history whose request action you are assessing.'), cxModel, tokens]), OLD + 50);
  f.write(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), [{ id: P, thread_name: 'Tidy the fixture importer', updated_at: ts },
    { id: G, thread_name: 'Guardian review', updated_at: ts }]);
  assert.deepEqual(core.sessionMeta(f.work).sessions.map(r => r.id), [P]);
  assert.equal(core.resolveSessionId(f.work), P, 'never the session this workspace resolves to');
  const all = core.sessionMeta(f.work, null, { includeReviews: true }).sessions;
  assert.equal(all.find(r => r.id === G)?.title, 'Auto-review: Tidy the fixture importer', 'named for the session it reviews, not by the index');
});
// Search leaves Auto-review threads out too: each one quotes the session it reviews, so a search for that
// session's words found its reviews ahead of it, and more of them than of the session itself.
test('conversation search leaves Codex Auto-review threads out and keeps an ordinary subagent thread', t => {
  const f = fixture(t);
  const reply = (text) => ({ type: 'event_msg', timestamp: '2026-01-01T00:00:05Z', payload: { type: 'agent_message', message: text } });
  const review = 'Assess this request from the history: Port the kestrel importer';
  f.rollout('fixture-parent', [cxUser('Port the kestrel importer'), cxModel, reply('The kestrel importer is ported')]);
  f.rollout('fixture-review', [cxUser(review), cxModel, reply('Approve: the kestrel importer is safe')], { parent_thread_id: 'fixture-parent', thread_source: 'guardian_review' });
  f.rollout('fixture-review-source', [cxUser(review), cxModel], { parent_thread_id: 'fixture-parent', source: { subagent: { other: 'guardian' } } });
  f.rollout('fixture-subagent', [cxUser('Review the kestrel importer'), cxModel], { parent_thread_id: 'fixture-parent', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'fixture-parent', depth: 1 } } } });
  core.ensureStore('fixture-review'); // a store brings no review back in
  assert.deepEqual([...new Set(core.searchConversations(f.work, 'kestrel importer').hits.map((h) => h.session))].sort(), ['fixture-parent', 'fixture-subagent']);
});
test('every row names its workspace: a rollout its own session_meta cwd, else one Unknown workspace label', t => {
  const f = fixture(t), id = 'fixture-gone-workspace';
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-gone-')); fs.rmSync(gone, { recursive: true });
  // A temp workspace since removed keeps the rollout out of the source scan; its store brings it back.
  f.write(path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${id}.jsonl`), [
    {type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id,cwd:gone,originator:'fixture-drive'}}, cxUser('Drive the fixture'), cxModel,
    {type:'event_msg',timestamp:'2026-01-01T00:01:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:500,cached_input_tokens:0,output_tokens:50}}}}]);
  core.ensureStore(id); // a drive's store: no hook metadata
  hookOnly(f, 'fixture-no-cwd', { edits: 1 });
  const rows = core.sessionMeta(f.work).sessions;
  const row = rows.find(r => r.id === id);
  assert.ok(row, 'listed'); assert.equal(row.workspace, core.workspaceLabel(gone)); assert.equal(row.agent, 'codex'); assert.equal(row.tokens, 550);
  assert.equal(rows.find(r => r.id === 'fixture-no-cwd').workspace, core.UNKNOWN_WORKSPACE);
  assert.ok(rows.every(r => r.workspace), 'no blank workspace');
});
test('a prompt title an earlier build cached with its heading markers is rescanned, not served', t => {
  const f = fixture(t), id = 'fixture-stale-title';
  const file = f.claude(id, f.work, [user('Please look at this:\n## Step one\nThen fix it.'), answer]);
  const st = fs.statSync(file), sidecar = path.join(core.rootDir(), 'session-meta', `${id}.json`);
  fs.mkdirSync(path.dirname(sidecar), { recursive: true }); // what a version-4 build wrote: the lines already joined
  fs.writeFileSync(sidecar, JSON.stringify({ stamp: `4|${st.mtimeMs}:${st.size}`, parts: { rename: null, aiTitle: null, prompt: 'Please look at this: ## Step one Then fix it.', bridge: null } }));
  assert.equal(core.sessionMeta(f.work).sessions.find(r => r.id === id).title, 'Please look at this: Step one Then fix it.');
});

// Listing and usage cost. `oak sessions` and `oak usage` are fresh processes that
// every editor, the terminal app and the statusline run every few seconds, so whatever they cannot find
// on disk they redo in full: these pin that they do not.
const { spawnSync } = require('node:child_process');
const DIST = require.resolve(process.env.OAK_LISTING_TEST_DIST || '../dist');
/** A rollout with Codex's own kind of name, which carries its id. */
const namedRollout = (f, n, records, day = '01') => {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const file = f.write(path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', day, `rollout-2026-01-${day}T00-00-00-${id}.jsonl`), [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id, cwd: f.work } }, ...records]);
  return { id, file };
};
/** Run `body` in a fresh process, where it sees `core`, `fs`, `path` and `count(predicate)`: its answer,
 *  and how many calls of the `ops` fs functions it made on paths the predicate accepts. */
const fresh = (body, ops = ['readFileSync', 'openSync']) => {
  const code = `const fs=require('fs'),path=require('path'),core=require(${JSON.stringify(DIST)});let n=0,want=()=>false;const count=p=>{want=p;};
for(const k of ${JSON.stringify(ops)}){const orig=fs[k];fs[k]=function(p,...a){if(want(String(p)))n++;return orig.call(this,p,...a);};}
const value=(()=>{${body}})();process.stdout.write(JSON.stringify({value,n}));`;
  const r = spawnSync(process.execPath, ['-e', code], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
test('a listing reads the Codex tree once, not once for every session it looks up', t => {
  const f = fixture(t);
  for (const n of [1, 2, 3]) namedRollout(f, n, [cxUser('A fixture task'), cxModel, cxCall], `0${n}`);
  for (let i = 0; i < 40; i++) core.ensureStore(`fixture-store-${i}`); // no transcript, no rollout: each one is looked up
  const readdir = fs.readdirSync; let reads = 0;
  fs.readdirSync = function (p, ...args) { if (String(p).startsWith(process.env.CODEX_HOME)) reads++; return readdir.call(this, p, ...args); };
  let rows;
  try { rows = core.sessionMeta(f.work).sessions; } finally { fs.readdirSync = readdir; }
  assert.equal(rows.length, 3);
  assert.ok(reads < 40, `${reads} Codex directory reads to list 40 store sessions`);
});
test('a Claude session is not looked for inside Codex rollouts whose names carry their ids', t => {
  const f = fixture(t);
  const { id, file } = namedRollout(f, 1, [cxUser('A fixture task'), cxModel]);
  const sessions = path.join(process.env.CODEX_HOME, 'sessions') + path.sep;
  const miss = fresh(`count(p=>p.startsWith(${JSON.stringify(sessions)}));return core.findCodexRollout('fixture-claude');`);
  assert.deepEqual(miss, { value: null, n: 0 }, 'the statusline asks this for a Claude session on every render');
  assert.equal(core.findCodexRollout(id), file);
  // Positive control: a rollout named any other way is still found by its own session_meta.
  const other = fixture(t).rollout('fixture-unnamed', [cxUser('Another task')]);
  assert.equal(core.findCodexRollout('fixture-unnamed'), other);
});
test('a store size is kept across processes, and follows the log, blobs and staging', t => {
  const f = fixture(t), id = 'fixture-bytes';
  f.claude(id, f.work, [user('Measure the store'), answer]);
  core.ensureStore(id);
  for (let i = 0; i < 4; i++) core.appendLog(id, { ts: 1000 + i, tool: 'Edit', file: path.join(f.work, `fixture-${i}.txt`),
    beforeBlob: core.writeBlob(id, Buffer.from('a\n')), afterBlob: core.writeBlob(id, Buffer.from(`b${i}\n`)), status: 'pending' });
  const dir = core.storeDir(id);
  const onDisk = () => fs.statSync(path.join(dir, 'log.jsonl')).size + ['blobs', 'staging'].reduce((n, sub) =>
    n + fs.readdirSync(path.join(dir, sub)).reduce((m, x) => m + fs.statSync(path.join(dir, sub, x)).size, 0), 0);
  const probe = () => fresh(`count(p=>p.startsWith(${JSON.stringify(path.join(dir, 'blobs') + path.sep)}));return core.storeBytes(${JSON.stringify(id)});`, ['statSync']);
  const first = probe();
  assert.equal(first.value, onDisk());
  assert.ok(first.n > 0);
  assert.deepEqual(probe(), { value: first.value, n: 0 }, 'the next process stats no blob');
  core.writeBlob(id, Buffer.from('c\n'.repeat(50)));
  assert.equal(probe().value, onDisk(), 'a new snapshot moves the total');
  fs.writeFileSync(path.join(dir, 'staging', 'fixture-manifest.json'), 'x'.repeat(300));
  assert.equal(probe().value, onDisk(), 'so does a staged capture');
});
test('GPT totals in a fresh process read no derived transcript whose rollout has not changed', t => {
  const f = fixture(t), at = s => new Date(Date.now() - s * 1000).toISOString();
  const usage = (s, input, output) => ({ type: 'event_msg', timestamp: at(s), payload: { type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } } });
  const { file } = namedRollout(f, 1, [cxUser('A fixture task'), usage(3, 1000, 100), usage(2, 1500, 150)]);
  const derived = path.join(core.rootDir(), 'runtime-transcripts') + path.sep;
  const probe = () => fresh(`count(p=>p.startsWith(${JSON.stringify(derived)})&&p.endsWith('events.jsonl'));const g=core.gptUsagePanel();return g&&g.monthTok;`);
  const first = probe();
  assert.equal(first.value, 1650);
  assert.ok(first.n > 0, 'the first process derives the transcript');
  assert.deepEqual(probe(), { value: 1650, n: 0 }, 'the next one reads the usage rows kept beside it');
  fs.appendFileSync(file, JSON.stringify(usage(1, 2000, 200)) + '\n');
  assert.equal(probe().value, 2200, 'an appended event is counted');
});
// Claude Code 2.1.x caps a project dir name at 200 characters: a longer mangled path keeps its first
// 200 and gains `-` + a base-36 hash of the path. Taking that shortened name for a sync mirror hid real
// deep-directory sessions from every list.
const claudeCodeFolder = (cwd) => {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
};
test('a session in a directory whose project name Claude Code shortens is local, not a mirror', t => {
  const f = fixture(t);
  const deep = path.join(f.work, ...Array.from({ length: 12 }, (_, i) => `fixture-nested-directory-${i}`));
  fs.mkdirSync(deep, { recursive: true });
  assert.ok(deep.length > 200);
  const transcript = (id, cwd, folder) => f.write(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', folder, `${id}.jsonl`),
    [user('Work deep in the tree'), answer].map((r) => ({ cwd, sessionId: id, ...r })));
  const file = transcript('fixture-deep', deep, claudeCodeFolder(deep));
  assert.equal(core.isMirroredTranscript(file).mirrored, false);
  assert.equal(core.projectDir(deep), path.dirname(file), 'resolved from its own directory, too');
  assert.equal(core.resolveSessionId(deep), 'fixture-deep');
  assert.ok(core.sessionMeta(f.work).sessions.some((r) => r.id === 'fixture-deep'), 'listed');
  assert.deepEqual(core.searchConversations(f.work, 'deep in the tree').hits.map((h) => h.session), ['fixture-deep'], 'searched');
  // The kept prefix decides, not the hash: another build's hash is still this directory.
  const rehashed = transcript('fixture-rehashed', deep, `${claudeCodeFolder(deep).slice(0, 201)}zz9`);
  assert.equal(core.isMirroredTranscript(rehashed).mirrored, false);
  // Positive control: the same session filed under ANOTHER deep directory's name is a mirror.
  const other = path.join(f.work, ...Array.from({ length: 12 }, (_, i) => `fixture-other-directory-${i}`));
  const copied = transcript('fixture-copied', deep, claudeCodeFolder(other));
  assert.equal(core.isMirroredTranscript(copied).mirrored, true);
});
// Conversation search promised the prose that answered, and read none of Codex's.
test('conversation search reads Codex replies, whether or not the session has an OAK store', t => {
  const f = fixture(t);
  const reply = (text) => ({ type: 'event_msg', timestamp: '2026-01-01T00:00:05Z', payload: { type: 'agent_message', message: text } });
  const plain = namedRollout(f, 1, [cxUser('Rename the quokka helper'), cxModel, reply('The zanzibar module exports it now')]).id;
  const hooked = namedRollout(f, 2, [cxUser('Tidy the wombat tests'), cxModel, reply('Moved the platypus fixtures')], '02').id;
  core.handleCodexHookPayload({ session_id: hooked, cwd: f.work, hook_event_name: 'UserPromptSubmit', prompt: 'Tidy the wombat tests' });
  // A rollout the source scan passes over (its temp workspace is gone), found through its store instead.
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-gone-')); fs.rmSync(gone, { recursive: true });
  const stored = f.write(path.join(process.env.CODEX_HOME, 'sessions', '2026', '01', '03', 'rollout-2026-01-03T00-00-00-00000000-0000-4000-8000-000000000003.jsonl'), [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: '00000000-0000-4000-8000-000000000003', cwd: gone } }, cxUser('Port the numbat parser'), cxModel, reply('The echidna grammar is ported')]);
  core.ensureStore('00000000-0000-4000-8000-000000000003');
  assert.ok(stored);
  const hits = (q) => core.searchConversations(f.work, q).hits.map((h) => [h.session, h.where, h.agent]);
  assert.deepEqual(hits('zanzibar'), [[plain, 'response', 'codex']]);
  assert.deepEqual(hits('quokka'), [[plain, 'prompt', 'codex']]);
  assert.deepEqual(hits('platypus'), [[hooked, 'response', 'codex']]);
  assert.deepEqual(hits('echidna'), [['00000000-0000-4000-8000-000000000003', 'response', 'codex']]);
});
// A session's workers that are still at it ride its row (`activeWorkers`), so a list of sessions can show them
// without a read of its own: working, or waiting on a person (workerPhase's running phases), each with its title,
// model, its share of the session's captured edits, tokens and last write.
function workerSession(f, S, now) {
  const at = (ms) => new Date(now - ms).toISOString();
  const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 1000 };
  const spawn = (tu, id, description, ago, background = true) => [
    { type: 'assistant', timestamp: at(ago), message: { id: `m-${tu}`, role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { description, subagent_type: 'general-purpose', run_in_background: background } }], usage } },
    { type: 'user', timestamp: at(ago), toolUseResult: background ? { status: 'async_launched', isAsync: true, agentId: id } : { status: 'completed', agentId: id }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'launched' }] } },
  ];
  const notice = (id, status) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at(60e3), content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>` });
  f.claude(S, f.work, [user('Fan the review out'), answer,
    ...spawn('t1', 'aworking', 'Review the\nparser', 3600e3), ...spawn('t2', 'aperm', 'Audit the hooks', 3500e3), ...spawn('t3', 'ainput', 'Ask about scope', 3400e3),
    ...spawn('t4', 'atodo', '', 3300e3), ...spawn('t5', 'abare', '', 3200e3), ...spawn('t6', 'adone', 'Finished review', 3100e3),
    ...spawn('t7', 'afailed', 'Failed review', 3000e3), ...spawn('t8', 'afore', 'Foreground review', 2900e3, false), ...spawn('t9', 'aold', 'Waited too long', 2800e3),
    notice('adone', 'completed'), notice('afailed', 'failed')]);
  const dir = path.join(core.projectDir(f.work), S, 'subagents');
  const agent = (id, records, ago = 0, sidecar) => {
    const file = f.write(path.join(dir, `agent-${id}.jsonl`), records.map((r) => ({ isSidechain: true, agentId: id, sessionId: S, timestamp: at(ago + 1000), ...r })));
    if (sidecar) f.write(path.join(dir, `agent-${id}.meta.json`), [sidecar]);
    fs.utimesSync(file, (now - ago) / 1000, (now - ago) / 1000);
    return file;
  };
  const call = (id, name, input) => ({ type: 'assistant', message: { id: `m-${id}`, role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id, name, input }], usage } });
  const result = (id, error = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: error }] } });
  const said = (text) => ({ type: 'assistant', message: { id: `m-${text}`, role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text }], usage } });
  // Working: its last call's result is in and it is writing its next step. An Edit and a Bash command of its
  // own each made a captured edit.
  agent('aworking', [call('e1', 'Edit', { file_path: path.join(f.work, 'a.txt'), old_string: 'a', new_string: 'a b' }), result('e1'), call('b1', 'Bash', { command: 'sed -i s/x/y/ b.txt' }), result('b1')]);
  // Waiting on a person: a call with no result for a minute, its permission prompt up (below), and a question asked.
  agent('aperm', [call('p1', 'Bash', { command: 'rm -rf build' })], 60e3);
  agent('ainput', [call('q1', 'AskUserQuestion', { questions: [{ question: 'Which scope?', header: 'Scope', options: [] }] })], 600e3);
  // No description: its title is the to-do it is on, else its id. The second launched by another agent: only
  // its own metadata says it runs in the background.
  agent('atodo', [call('w1', 'TodoWrite', { todos: [{ content: 'Map the\tstore', status: 'in_progress' }, { content: 'Later', status: 'pending' }] }), result('w1')]);
  agent('abare', [call('x1', 'Read', { file_path: 'c.txt' }), result('x1')]);
  agent('anested', [call('n1', 'Grep', { pattern: 'todo' }), result('n1')], 0, { agentType: 'general-purpose', description: 'Nested check', requestShape: 'background' });
  // Finished: its completion notice (completed, failed), or a foreground worker whose turn ended.
  agent('adone', [said('Done.')], 120e3);
  agent('afailed', [said('Gave up.')], 120e3);
  agent('afore', [said('Here is the review.')], 30e3);
  // Waiting, by its tail, but last written three hours ago: past the window, never asked.
  agent('aold', [call('o1', 'Bash', { command: 'make' })], 3 * 3600e3);
  // The session's captured edits: two by `aworking`'s own calls, one by the main chain, one with no call id.
  core.ensureStore(S);
  // `aperm`'s call waits on its permission prompt, which the hooks raise as the session's hand, naming the subagent that
  // asked: what tells it from a command still running (2026-11-02).
  core.writeAttention(S, { kind: 'permission', message: 'Bash', ts: now - 60e3 }, { key: 'p1-key', agent: 'aperm' });
  const edit = (file, before, after, status, toolCallId) => core.appendLog(S, { ts: now - 5000, tool: 'Edit', file: path.join(f.work, file),
    beforeBlob: core.writeBlob(S, Buffer.from(before)), afterBlob: core.writeBlob(S, Buffer.from(after)), status, ...(toolCallId ? { toolCallId } : {}) });
  edit('a.txt', 'a\n', 'a\nb\n', 'pending', 'e1');
  edit('b.txt', 'x\n', 'y\n', 'kept', 'b1');
  edit('main.txt', 'm\n', 'm\nn\no\n', 'pending', 'main-call');
  edit('loose.txt', 'l\n', '', 'pending');
  return dir;
}

test('the session listing carries each session\'s workers still at it: working or waiting on a person, never a finished one (2026-10-23)', t => {
  const f = fixture(t), S = 'fixture-workers', now = Date.now();
  workerSession(f, S, now);
  f.claude('fixture-plain', f.work, [user('No workers here'), answer]);
  const rows = core.sessionMeta(f.work).sessions;
  assert.deepEqual(rows.find((r) => r.id === 'fixture-plain').activeWorkers, [], 'a session with no workers carries an empty list');
  const workers = rows.find((r) => r.id === S).activeWorkers;
  const by = Object.fromEntries(workers.map((w) => [w.agentId, w]));
  // Newest spawn first, as the Workers list orders them; the nested one (no spawn here) by its own first record.
  assert.deepEqual(workers.map((w) => [w.agentId, w.phase]), [['anested', 'working'], ['abare', 'working'], ['atodo', 'working'],
    ['ainput', 'awaiting-input'], ['aperm', 'awaiting-permission'], ['aworking', 'working']]);
  assert.deepEqual(workers.map((w) => w.title), ['Nested check', 'abare', 'Map the store', 'Ask about scope', 'Audit the hooks', 'Review the parser'],
    'its description on one line, else its to-do, else its id');
  assert.deepEqual(by.aworking, { agentId: 'aworking', title: 'Review the parser', phase: 'working', phaseConfidence: 'high', model: 'Opus 4.5',
    edits: 2, pending: 1, added: 2, removed: 1, tokens: 300, lastActiveMs: by.aworking.lastActiveMs });
  assert.ok(Math.abs(by.aworking.lastActiveMs - now) < 2000, 'when its transcript was last written');
  assert.deepEqual([by.aperm.edits, by.aperm.pending, by.aperm.tokens], [0, 0, 150], 'no call of its own made an edit');
  assert.equal(by.aperm.model, 'Opus 4.5');
  // The main chain's edit and the one captured with no call id are nobody's.
  const row = rows.find((r) => r.id === S);
  assert.deepEqual([row.edits, row.pending], [4, 3], 'control: the session itself counts all four');
});

test('the session listing asks only workers written in the last two hours, and a finished one again only once it is written (2026-10-23)', t => {
  const f = fixture(t), S = 'fixture-bounded', now = Date.now();
  const dir = workerSession(f, S, now);
  const listed = () => core.sessionMeta(f.work).sessions.find((r) => r.id === S).activeWorkers.map((w) => w.agentId).sort();
  assert.ok(!listed().includes('aold'), 'three hours quiet: not asked');
  // Inside the window its tail is read: the same file written an hour ago lists it, its call still running (no prompt
  // of its session names it).
  const old = path.join(dir, 'agent-aold.jsonl');
  fs.utimesSync(old, (now - 3600e3) / 1000, (now - 3600e3) / 1000);
  assert.ok(listed().includes('aold'), 'control: an hour quiet, it is asked and found at it');
  // A finished worker is judged once. Rewritten to the same size under the same mtime, its file is not read again;
  // a write it was not judged at is.
  const done = path.join(dir, 'agent-afore.jsonl');
  const st = fs.statSync(done);
  const waiting = JSON.stringify({ isSidechain: true, agentId: 'afore', sessionId: S, timestamp: new Date(now).toISOString(), type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'z1', name: 'Bash', input: { command: 'x' } }] } });
  const body = waiting + ' '.repeat(Math.max(0, st.size - waiting.length - 1)) + '\n';
  assert.equal(Buffer.byteLength(body), st.size, 'the fixture rewrites it byte for byte in size');
  fs.writeFileSync(done, body);
  fs.utimesSync(done, st.atime, st.mtime);
  assert.ok(!listed().includes('afore'), 'unchanged by size and mtime: not read again');
  fs.utimesSync(done, (now - 20e3) / 1000, (now - 20e3) / 1000);
  assert.ok(listed().includes('afore'), 'written since: read again, and found at it');
});

// Claude Code writes one API message as a record per content block (thinking, text, each tool call), each carrying
// the message's whole usage. A worker's tokens count each message once, as the session's own count does.
test('a worker\'s tokens count each message once, however many records it was written as (2026-10-23)', t => {
  const f = fixture(t), S = 'fixture-split-usage', now = Date.now(), at = (ms) => new Date(now - ms).toISOString();
  const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 1000 };
  const split = (id, extra) => ['thinking', 'text'].map((type) => ({ type: 'assistant', timestamp: at(5000), ...extra,
    message: { id, role: 'assistant', model: 'claude-opus-4-5-20251101', content: [type === 'text' ? { type, text: 'Working on it' } : { type, thinking: 'plan' }], usage } }));
  f.claude(S, f.work, [user('Fan out'), ...split('main-1', {}),
    { type: 'assistant', timestamp: at(5000), message: { id: 'main-1', role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Split usage', run_in_background: true } }], usage } },
    { type: 'user', timestamp: at(5000), toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'wsplit' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'launched' }] } }]);
  const sub = { isSidechain: true, agentId: 'wsplit', sessionId: S };
  f.write(path.join(core.projectDir(f.work), S, 'subagents', 'agent-wsplit.jsonl'), [...split('sub-1', sub),
    { ...sub, type: 'assistant', timestamp: at(3000), message: { id: 'sub-1', role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'x' } }], usage } },
    { ...sub, type: 'user', timestamp: at(2000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok' }] } }]);
  const row = core.sessionMeta(f.work).sessions.find((r) => r.id === S);
  assert.equal(row.tokens, 150, 'control: the session counts its three-record message once');
  assert.deepEqual(row.activeWorkers.map((w) => [w.agentId, w.tokens]), [['wsplit', 150]], 'and so does its worker');
});

// A worker's share is in review units, as the session's own counts are, and follows a keep in the same process.
test('a worker\'s edits are review units: a revised region is one, a file created and deleted again is none, and a keep is seen at once (2026-10-23)', t => {
  const f = fixture(t), S = 'fixture-worker-units', now = Date.now(), at = (ms) => new Date(now - ms).toISOString();
  f.claude(S, f.work, [user('Fan out'),
    { type: 'assistant', timestamp: at(60e3), message: { id: 'm-spawn', role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Revise', run_in_background: true } }] } },
    { type: 'user', timestamp: at(60e3), toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'wunits' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'launched' }] } }]);
  const sub = { isSidechain: true, agentId: 'wunits', sessionId: S, timestamp: at(2000) };
  f.write(path.join(core.projectDir(f.work), S, 'subagents', 'agent-wunits.jsonl'), ['k1', 'k2', 'k3', 'k4'].flatMap((id) => [
    { ...sub, type: 'assistant', message: { id: `m-${id}`, role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id, name: 'Edit', input: {} }] } },
    { ...sub, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }]));
  core.ensureStore(S);
  const blob = (text) => (text === null ? null : core.writeBlob(S, Buffer.from(text)));
  const edit = (file, before, after, toolCallId) => core.appendLog(S, { ts: now - 5000, tool: 'Edit', file: path.join(f.work, file), beforeBlob: blob(before), afterBlob: blob(after), status: 'pending', toolCallId });
  const first = edit('revised.txt', 'a\n', 'a\nb\n', 'k1');
  edit('revised.txt', 'a\nb\n', 'a\nB\n', 'k2');
  edit('scratch.txt', null, 'tmp\n', 'k3');
  edit('scratch.txt', 'tmp\n', null, 'k4');
  const worker = () => core.sessionMeta(f.work).sessions.find((r) => r.id === S).activeWorkers[0];
  const row = core.sessionMeta(f.work).sessions.find((r) => r.id === S);
  assert.deepEqual([row.edits, row.pending], [1, 1], 'control: the session counts one unit');
  assert.deepEqual([worker().edits, worker().pending], [1, 1], 'so does its worker');
  // Keep the unit, as every surface does: all of its members.
  core.setStatusMany(S, core.visibleEdits(S).filter((r) => r.status === 'pending').flatMap((r) => core.groupMembers(S, r.id)), 'kept');
  assert.ok(first, 'control: the edits were recorded');
  // Resolved records are counted one by one, by the session as by its worker.
  const kept = core.sessionMeta(f.work).sessions.find((r) => r.id === S);
  assert.deepEqual([kept.edits, kept.pending], [2, 0], 'control: the session sees the keep');
  assert.deepEqual([worker().edits, worker().pending], [2, 0], 'and so does its worker, in the same process');
});

// A background worker with no completion notice is done only while its whole session is quiet: once the session
// writes again it is asked again. One that another worker launched is background by its own metadata.
test('a background worker found done because its session went quiet is asked again once the session writes, and a nested one is background by its metadata (2026-10-23)', t => {
  const f = fixture(t), S = 'fixture-worker-quiet', now = Date.now(), at = (ms) => new Date(now - ms).toISOString();
  const parent = f.claude(S, f.work, [user('Fan out'),
    { type: 'assistant', timestamp: at(900e3), message: { id: 'm-spawn', role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Long build', run_in_background: true } }] } },
    { type: 'user', timestamp: at(900e3), toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'wquiet' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'launched' }] } }]);
  const dir = path.join(core.projectDir(f.work), S, 'subagents');
  const sub = (id) => ({ isSidechain: true, agentId: id, sessionId: S, timestamp: at(600e3) });
  const quiet = f.write(path.join(dir, 'agent-wquiet.jsonl'), [{ ...sub('wquiet'), type: 'assistant', message: { id: 'm-q', role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }] } },
    { ...sub('wquiet'), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } }]);
  for (const file of [quiet, parent]) fs.utimesSync(file, (now - 600e3) / 1000, (now - 600e3) / 1000);
  const listed = () => core.sessionMeta(f.work).sessions.find((r) => r.id === S).activeWorkers.map((w) => w.agentId);
  assert.deepEqual(listed(), [], 'it, its session and the session\'s other agents quiet for ten minutes: done');
  fs.appendFileSync(parent, JSON.stringify({ type: 'user', cwd: f.work, sessionId: S, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Still there?' } }) + '\n');
  assert.deepEqual(listed(), ['wquiet'], 'the session wrote: it is asked again, and counts as working');
  // Launched by another worker: no spawn in this session's transcript, only its metadata says it runs in the
  // background. Between two turns it is still at it.
  const nested = f.write(path.join(dir, 'agent-wnested.jsonl'), [{ ...sub('wnested'), timestamp: at(30e3), type: 'assistant', message: { id: 'm-n', role: 'assistant', model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text: 'Checked the first half.' }] } }]);
  fs.utimesSync(nested, (now - 30e3) / 1000, (now - 30e3) / 1000);
  f.write(path.join(dir, 'agent-wnested.meta.json'), [{ agentType: 'general-purpose', description: 'Nested check', requestShape: 'background' }]);
  assert.ok(listed().includes('wnested'), 'a background worker between turns is still at it');
});
