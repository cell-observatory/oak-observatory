const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const C = require('../dist');
function fresh() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-parity-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  process.env.CODEX_HOME = path.join(base, 'codex');
  const cwd = path.join(base, 'work'); fs.mkdirSync(cwd);
  return { base, cwd };
}
function hook(session, cwd, file, event, call = 'call') {
  C.handleCodexHookPayload({ session_id: session, cwd, hook_event_name: event, turn_id: 'turn', tool_use_id: call,
    tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch` } });
}
test('parity: oversized shell before-state cannot become an undoable creation', () => {
  const { cwd } = fresh(); const f = path.join(cwd, 'f.txt'); const s = 'oversized';
  fs.writeFileSync(f, 'x'.repeat(5 * 1024 * 1024 + 1));
  const p = { session_id: s, cwd, tool_name: 'Bash', tool_use_id: 'x' };
  C.handleCodexHookPayload({ ...p, hook_event_name: 'PreToolUse' }); fs.writeFileSync(f, 'small\n');
  C.handleCodexHookPayload({ ...p, hook_event_name: 'PostToolUse' });
  assert.equal(C.readLog(s).length, 0); assert.ok(C.readSkips(s).some(x => x.file === f));
});
test('parity: capture, Undo, and identical re-edit creates a fresh pending record', () => {
  const { cwd } = fresh(); const f = path.join(cwd, 'f'); const s = 'repeat'; fs.writeFileSync(f, 'old\n');
  hook(s, cwd, f, 'PreToolUse', 'a'); fs.writeFileSync(f, 'new\n'); hook(s, cwd, f, 'PostToolUse', 'a');
  C.undoEdit(s, 1); assert.equal(fs.readFileSync(f, 'utf8'), 'old\n');
  hook(s, cwd, f, 'PreToolUse', 'b'); fs.writeFileSync(f, 'new\n'); hook(s, cwd, f, 'PostToolUse', 'b');
  assert.deepEqual(C.readLog(s).map(r => r.status), ['undone', 'pending']);
});
test('parity: overlapping hooks retain the oldest before-state and mark ambiguity', () => {
  const { cwd } = fresh(); const f = path.join(cwd,'f'); const s='overlap'; fs.writeFileSync(f,'A\n');
  hook(s,cwd,f,'PreToolUse','a'); fs.writeFileSync(f,'B\n'); hook(s,cwd,f,'PreToolUse','b'); fs.writeFileSync(f,'C\n');
  hook(s,cwd,f,'PostToolUse','a'); hook(s,cwd,f,'PostToolUse','b');
  const rows=C.readLog(s); assert.equal(rows.length,1); assert.equal(C.readBlob(s,rows[0].beforeBlob).toString(),'A\n');
  assert.equal(rows[0].attribution,'ambiguous'); assert.equal(rows[0].partial,true);
});
test('parity: a drive lease cannot be consumed by Bash and survives GC until release', () => {
  const { cwd }=fresh(); const s='lease'; C.ensureStore(s); const h=C.writeBlob(s,Buffer.from('before'));
  const lease=C.writeSnapshotLease(s,{a:h}); C.writeBashManifest(s,{root:cwd,files:{b:h},ts:Date.now(),toolCallId:'b'});
  assert.equal(C.claimBashManifest(s,cwd,'other'),null);
  const claim=C.claimBashManifest(s,cwd,'b'); assert.ok(claim); assert.equal(C.claimBashManifest(s,cwd,'b'),null);
  C.gcSession(s); assert.equal(C.readBlob(s,h).toString(),'before'); claim.release();
  C.gcSession(s); assert.equal(C.readBlob(s,h).toString(),'before'); C.releaseSnapshotLease(s,lease);
  C.gcSession(s); assert.throws(()=>C.readBlob(s,h));
});
test('parity: current Codex metadata is recognized without hiding unknown event types', () => {
  const {cwd}=fresh(), f=path.join(cwd,'rollout.jsonl');
  const rows=[{type:'session_meta',payload:{id:'modern',cwd}},
    ...['world_state','token_usage_record'].map(type=>({type})),
    {type:'event_msg',payload:{type:'item_completed'}},
    ...['system','developer'].map(role=>({type:'response_item',payload:{type:'message',role,content:[{text:'private instruction'}]}})),
    {type:'future_unknown',payload:{}}];
  fs.writeFileSync(f,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const derived=C.codexTranscriptFile(f);
  assert.equal(C.codexParserHealth(f).unsupported,1);
  assert.ok(!fs.readFileSync(derived,'utf8').includes('private instruction'));
});
function rollout(cwd, id='native', records=[]) {
  const dir=path.join(process.env.CODEX_HOME,'sessions','2026','09','09');fs.mkdirSync(dir,{recursive:true});
  const f=path.join(dir,`rollout-2026-${id}.jsonl`);
  const ev=(timestamp,type,payload)=>({timestamp,type,payload});
  fs.writeFileSync(f,[ev('2026-09-09T10:00:00Z','session_meta',{id,cwd,model_provider:'openai'}),...records].map(x=>JSON.stringify(x)).join('\n')+'\n');
  return f;
}
test('parity: native Codex discovery, prompts, response, actions and usage share the same transcript',()=>{
  const {cwd}=fresh(); const id='native'; const at='2026-09-09T10:00:00Z';
  const f=rollout(cwd,id,[
    {timestamp:at,type:'turn_context',payload:{turn_id:'native-turn',model:'gpt-5.2',effort:'high'}},
    {timestamp:at,type:'event_msg',payload:{type:'task_started',turn_id:'native-turn'}},
    {timestamp:at,type:'event_msg',payload:{type:'user_message',message:'inspect this project'}},
    {timestamp:'2026-09-09T10:00:01Z',type:'response_item',payload:{type:'function_call',call_id:'tool-1',name:'exec_command',arguments:'{"cmd":"pwd"}'}},
    {timestamp:'2026-09-09T10:00:02Z',type:'response_item',payload:{type:'function_call_output',call_id:'tool-1',output:'done',exit_code:0}},
    {timestamp:'2026-09-09T10:00:03Z',type:'event_msg',payload:{type:'token_count',info:{model_context_window:10000,last_token_usage:{total_tokens:110},total_token_usage:{input_tokens:100,cached_input_tokens:20,output_tokens:10}}}},
    {timestamp:'2026-09-09T10:00:04Z',type:'event_msg',payload:{type:'agent_message',message:'This is the assistant reply.'}},
  ]);
  assert.equal(C.resolveSessionId(cwd),id);
  const desc=C.resolveSessionContinuation(id);assert.equal(desc.agentId,'codex');assert.equal(desc.nativeSessionId,id);
  assert.ok(C.resolveSessionContinuation(id,'claude').error);
  assert.equal(C.sessionMeta(cwd).sessions.find(x=>x.id===id).agent,'codex');
  assert.equal(C.sessionUsage(cwd,id).total,90);
  const prompts=C.sessionPrompts(cwd,id);assert.equal(prompts.length,1);assert.equal(prompts[0].id,'native-turn');assert.equal(prompts[0].tokens,90);assert.equal(prompts[0].actions,1);
  assert.equal(C.parseActions(cwd,id).length,1);
  const feed=C.liveFeed(cwd,id,{kind:'session',id});assert.match(JSON.stringify(feed),/This is the assistant reply/);
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'statusline-last.json'),JSON.stringify({five_pct:12,week_pct:34,tok_in:999,tok_out:888}));
  const u=C.usageLine(cwd,id);assert.equal(u.tokensIn,80);assert.equal(u.tokensOut,10);assert.equal(u.fiveHourPct,null);assert.equal(u.ctx.tokens,110);
  C.handleCodexHookPayload({session_id:id,cwd,hook_event_name:'SubagentStart',agent_id:'child',agent_type:'reviewer'});
  assert.equal(C.readCaptureEvents(id,['subagent'])[0].payload.context.agentId,'child');
  C.handleCodexHookPayload({session_id:id,cwd,hook_event_name:'Interrupt'});assert.equal(C.readAttention(id).kind,'idle-done');
  assert.ok(f);
});
test('parity: historical GPT totals allocate deltas to the right model and period',()=>{
  const {cwd}=fresh(); const event=(timestamp,payload)=>({timestamp,type:'event_msg',payload});
  const f=rollout(cwd,'billing',[
    event('2026-08-15T00:00:00Z',{type:'thread_settings_applied',thread_settings:{model:'gpt-5.1'}}),
    event('2026-08-15T00:01:00Z',{type:'token_count',info:{total_token_usage:{input_tokens:1000,output_tokens:0}}}),
    event('2026-09-08T00:00:00Z',{type:'thread_settings_applied',thread_settings:{model:'gpt-5.2'}}),
    event('2026-09-08T00:01:00Z',{type:'token_count',info:{total_token_usage:{input_tokens:1100,output_tokens:0}}}),
  ]);
  const since=Date.parse('2026-09-01');const d=C.codexUsageDeltas(f);assert.deepEqual(d.map(x=>[x.model,x.usage.input]),[['gpt-5.1',1000],['gpt-5.2',100]]);
  const b=C.codexBreakdown('model',since,null);assert.equal(b.buckets.length,1);assert.equal(b.buckets[0].tokens,100);
  assert.equal(C.codexCycleUsage(since,since).moTok,100);
  assert.equal(C.modelRate('gpt-5-unlisted').approx,true);
});
test('parity: incremental Codex reader tolerates UTF-8 tails, appends and replacement',()=>{
  const {cwd}=fresh();const f=rollout(cwd,'cursor');const text=JSON.stringify({timestamp:'2026-09-09T10:00:00Z',type:'event_msg',payload:{type:'user_message',message:'café'}})+'\n';
  const bytes=Buffer.from(text), at=bytes.indexOf(Buffer.from('é'))+1;
  fs.appendFileSync(f,bytes.subarray(0,at));C.codexTranscriptFile(f);assert.ok(C.codexParserHealth(f).pendingBytes>0);
  fs.appendFileSync(f,bytes.subarray(at));const derived=C.codexTranscriptFile(f);const first=fs.readFileSync(derived,'utf8');assert.match(first,/café/);
  C.codexTranscriptFile(f);assert.equal(fs.readFileSync(derived,'utf8'),first);
  fs.writeFileSync(f,JSON.stringify({timestamp:'2026-09-09T10:00:01Z',type:'event_msg',payload:{type:'user_message',message:'replacement'}})+'\n');
  const replaced=fs.readFileSync(C.codexTranscriptFile(f),'utf8');assert.match(replaced,/replacement/);assert.doesNotMatch(replaced,/café/);
});
test('parity: Codex installer preserves foreign metadata, mixed hooks and trust',()=>{
  // A backslash in the Codex home puts one in every trust key, as a Windows path always does (C:\Users\…),
  // so each OS checks that the keys are written as escaped TOML strings, ours and this foreign one alike.
  const {base}=fresh();process.env.CODEX_HOME=path.join(base,'codex\\home');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});const file=C.codexHooksJsonPath();
  const foreign=C.codexHookKey(file,'PreToolUse',0);
  fs.writeFileSync(file,JSON.stringify({description:'foreign',custom:{retain:true},hooks:{PreToolUse:[{matcher:'Bash',custom:'group',hooks:[{type:'command',command:'foreign'},{type:'command',command:'oak #ours'}]}]}}));
  fs.writeFileSync(C.codexConfigTomlPath(),`# configuration\n[hooks.state.${JSON.stringify(foreign)}]\ntrusted_hash = "foreign-hash"\n`);
  C.installCodexHooks('oak new #ours',s=>s.includes('#ours'));
  let json=JSON.parse(fs.readFileSync(file));assert.equal(json.custom.retain,true);assert.equal(json.description,'foreign');assert.equal(json.hooks.PreToolUse[0].hooks[0].command,'foreign');
  assert.match(fs.readFileSync(C.codexConfigTomlPath(),'utf8'),/foreign-hash/);
  assert.equal(C.codexHooksStatus(s=>s.includes('#ours')).trust,'trusted');
  delete json.hooks.Stop;fs.writeFileSync(file,JSON.stringify(json));assert.notEqual(C.codexHooksStatus(s=>s.includes('#ours')).trust,'trusted');
  C.uninstallCodexHooks(s=>s.includes('#ours'));json=JSON.parse(fs.readFileSync(file));assert.equal(json.custom.retain,true);assert.match(fs.readFileSync(C.codexConfigTomlPath(),'utf8'),/foreign-hash/);
});
test('parity: read-only integrity identifies unsafe historical creations without rewriting history',()=>{
  const {cwd}=fresh();const s='old';C.ensureStore(s);const f=path.join(cwd,'f');fs.writeFileSync(f,'keep');const h=C.writeBlob(s,Buffer.from('keep'));
  C.appendLog(s,{ts:1,file:f,tool:'Shell',source:'acp',beforeBlob:null,afterBlob:h,status:'pending'});
  const log=path.join(C.storeDir(s),'log.jsonl'),before=fs.readFileSync(log);
  assert.ok(C.captureIntegrity(s).issues.some(x=>x.code==='uncertain-before'));assert.deepEqual(fs.readFileSync(log),before);
  assert.equal(C.undoEdit(s,1).ok,false);assert.equal(fs.readFileSync(f,'utf8'),'keep');
});
test('parity: oversized rollout records do not lose their neighbours; newline-less messages preview once',()=>{
  const {cwd}=fresh();const f=rollout(cwd,'bounds');
  const message=text=>JSON.stringify({timestamp:'2026-09-09T10:00:00Z',type:'event_msg',payload:{type:'agent_message',message:text}});
  fs.appendFileSync(f,message('before')+'\n'+JSON.stringify({huge:'x'.repeat(5*1024*1024)})+'\n'+message('after'));
  let out=fs.readFileSync(C.codexTranscriptFile(f),'utf8');assert.match(out,/before/);assert.match(out,/after/);assert.equal(C.codexParserHealth(f).malformed,1);
  fs.appendFileSync(f,'\n');out=fs.readFileSync(C.codexTranscriptFile(f),'utf8');assert.equal((out.match(/"text":"after"/g)||[]).length,1);
  assert.equal(C.codexParserHealth(f).pendingBytes,0);
});
test('parity: malformed TOML and disabled hooks are never installed or called healthy',()=>{
  fresh();fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});const f=C.codexConfigTomlPath();
  fs.writeFileSync(f,'model = "unterminated');assert.throws(()=>C.installCodexHooks('oak #ours',c=>c.includes('#ours')));
  assert.equal(fs.existsSync(C.codexHooksJsonPath()),false);assert.equal(fs.readFileSync(f,'utf8'),'model = "unterminated');
  fs.writeFileSync(f,'');C.installCodexHooks('oak #ours',c=>c.includes('#ours'));
  fs.appendFileSync(f,'\n[features]\nhooks = false\n');assert.equal(C.codexHooksStatus(c=>c.includes('#ours')).disabled,true);
  assert.notEqual(C.codexHooksStatus(c=>c.includes('#ours')).trust,'trusted');
  const original=fs.readFileSync(f,'utf8').replace('hooks = false','hooks = true');fs.writeFileSync(f,original);
  const altered=original.replace(/trusted_hash = "([^"]+)"/,(_,hash)=>`trusted_hash = "changed" # ${hash}`);
  fs.writeFileSync(f,altered);assert.notEqual(C.codexHooksStatus(c=>c.includes('#ours')).trust,'trusted');
  fs.writeFileSync(f,original);assert.equal(C.codexHooksStatus(c=>c.includes('#ours')).trust,'trusted');
});
test('parity: review units retain uncertain creation evidence and separate model switches',()=>{
  const {cwd}=fresh(),s='mixed-group',file=path.join(cwd,'f');C.ensureStore(s);
  const a=C.writeBlob(s,Buffer.from('one\n')),b=C.writeBlob(s,Buffer.from('two\n'));fs.writeFileSync(file,'two\n');
  C.appendLog(s,{ts:1,tool:'Bash',file,beforeBlob:null,afterBlob:a,status:'pending'});
  C.appendLog(s,{ts:2,tool:'Edit',file,beforeBlob:a,afterBlob:b,status:'pending'});
  assert.equal(C.undoGroup(s,2).ok,false);assert.equal(fs.readFileSync(file,'utf8'),'two\n');
  const m='model-groups';C.ensureStore(m);
  const x=C.writeBlob(m,Buffer.from('x\n')),y=C.writeBlob(m,Buffer.from('y\n')),z=C.writeBlob(m,Buffer.from('z\n'));
  C.appendLog(m,{ts:10,tool:'Edit',file,beforeBlob:x,afterBlob:y,status:'pending',model:'first',runtime:'codex',promptId:'same'});
  C.appendLog(m,{ts:11,tool:'Edit',file,beforeBlob:y,afterBlob:z,status:'pending',model:'second',runtime:'codex',promptId:'same'});
  assert.deepEqual(C.reviewEdits(m).map(r=>r.model),['first','second']);
});
test('parity: native Claude continuation still preserves its recorded workspace',()=>{
  const {cwd}=fresh(),s='legacy-claude',dir=C.projectDir(cwd);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,s+'.jsonl'),JSON.stringify({type:'user',cwd,sessionId:s,message:{role:'user',content:'hello'}})+'\n');
  assert.equal(C.nativeSessionCommand(s).cwd,cwd);assert.equal(C.resolveSessionContinuation(s,'claude').cwd,cwd);
  assert.equal(C.describeSession('').runtime,'unknown');
});
test('parity: native turn boundaries dominate unfinished calls and quota-only records',()=>{
  const {cwd}=fresh(),f=rollout(cwd,'lifecycle');
  const event=payload=>fs.appendFileSync(f,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload})+'\n');
  event({type:'task_started',turn_id:'one'});
  fs.appendFileSync(f,JSON.stringify({type:'response_item',payload:{type:'function_call',call_id:'pending',name:'exec_command',arguments:'{"cmd":"sleep 10"}'}})+'\n');
  event({type:'task_complete',turn_id:'one'});
  event({type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:1}}});
  assert.deepEqual(C.agentPhaseDetail(C.codexTranscriptFile(f)),{phase:'done',confidence:'high'});
  event({type:'task_started',turn_id:'two'});
  assert.deepEqual(C.agentPhaseDetail(C.codexTranscriptFile(f)),{phase:'working',confidence:'high'});
  event({type:'turn_aborted',turn_id:'two'});
  assert.deepEqual(C.agentPhaseDetail(C.codexTranscriptFile(f)),{phase:'done',confidence:'high'});
});
test('parity: corrupt derived cursors rebuild and malformed store lines cannot hide valid edits',()=>{
  const {cwd}=fresh(),f=rollout(cwd,'corrupt'),s='bad-lines';
  fs.appendFileSync(f,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'retained message'}})+'\n');
  const out=C.codexTranscriptFile(f),cursor=path.join(path.dirname(out),'cursor.json');
  for(const invalid of ['null','{}','{"version":3,"source":"wrong"}']) {
    fs.writeFileSync(cursor,invalid);assert.match(fs.readFileSync(C.codexTranscriptFile(f),'utf8'),/retained message/);
  }
  C.ensureStore(s);fs.writeFileSync(C.logPath(s),'null\n{}\n[]\n"bad"\n'+JSON.stringify({id:1,ts:1,tool:'Edit',file:path.join(cwd,'x'),beforeBlob:null,afterBlob:null,status:'pending'})+'\n');
  assert.equal(C.readLog(s).length,1);assert.equal(C.statusesBeforeUndone(s,[1]).get(1),'pending');
});

test('parity: a zero-token line does not mark a priced bucket unavailable', () => {
  // A <synthetic> transcript line carries no tokens; its unknown rate must not flip a bucket's $ to "—".
  const zero = C.priceUsage('<synthetic>', { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  assert.equal(zero.known, true, 'nothing to price is not "price unknown"');
  const real = C.priceUsage('provider:ollama/llama', { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0 });
  assert.equal(real.known, false, 'a real un-priceable spend IS still flagged unavailable');
  // codex's own opaque model names (codex-auto-review) and unlisted GPT versions (gpt-6-astra) are
  // OpenAI calls — family-priced (approx) so they carry a cost instead of blanking the GPT bucket.
  for (const m of ['codex-auto-review', 'gpt-6-astra']) {
    const r = C.priceUsage(m, { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0 });
    assert.equal(r.known, true, `${m} is family-priced, not unavailable`);
    assert.equal(r.approx, true, `${m} is flagged approximate`);
    assert.ok(r.usd > 0, `${m} carries a nonzero cost`);
  }
});

test('parity: installer REFUSES to shift a following foreign hook rather than unbind its trust', () => {
  fresh(); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const file = C.codexHooksJsonPath();
  // Our handler sits BEFORE a foreign one in a shared group: removing ours would shift the foreign
  // handler down an index and silently unbind its trust (codex trust keys embed the index).
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: 'oak #ours' }, { type: 'command', command: 'foreign' }] }] } }));
  assert.throws(() => C.installCodexHooks('oak new #ours', (s) => s.includes('#ours')), /interleaves|foreign/i,
    'the installer refuses rather than shifting the foreign hook index');
});

// The TUI shows the Fable cap from `claudeAccount`; the JetBrains status widget
// reads only FLAT top-level numbers (`num("claudeFivePct")` and friends), so with no `claudeFable*`
// key in `usage --json` it could not show the cap at all, whatever its own code did.
test('parity: usage --json flattens the Fable cap beside the other claude account keys', () => {
  const { cwd } = fresh();
  const CLI = path.resolve(__dirname, '../../cli/dist/index.js');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), JSON.stringify({
    five_pct: 26, week_pct: 77, five_reset: '2099-01-01T00:00:00Z', week_reset: '2099-01-02T00:00:00Z',
    fable_pct: 93, fable_reset: '2099-01-03T00:00:00Z', fable_label: 'Fable',
  }));
  const env = { ...process.env, HOME: cwd, USERPROFILE: cwd, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
  const usage = JSON.parse(cp.execFileSync(process.execPath, [CLI, 'usage', '--json'], { cwd, env, encoding: 'utf8' }));
  assert.equal(usage.claudeAccount.fablePct, 93, 'positive control: the nested account block carries the cap');
  for (const [flat, nested] of [['claudeFablePct', 'fablePct'], ['claudeFableReset', 'fableReset'], ['claudeFableLabel', 'fableLabel']]) {
    assert.ok(flat in usage, `${flat} is exposed to flat-key consumers`);
    assert.deepEqual(usage[flat], usage.claudeAccount[nested], `${flat} mirrors claudeAccount.${nested}`);
  }
  assert.equal(usage.claudeFablePct, 93);
  assert.equal(usage.claudeFableLabel, 'Fable');
  assert.equal(usage.claudeFivePct, 26, 'the keys it sits beside are unchanged');
});
