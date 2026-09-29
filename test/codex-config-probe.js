/** Optional model-free integration gate against an installed Codex binary. No turn/start or prompt. */
const fs=require('fs'), os=require('os'), path=require('path'), cp=require('child_process'), assert=require('assert/strict');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'oak-codex-config-'));
const env={...process.env,CODEX_HOME:path.join(sandbox,'codex'),CLAUDE_CONFIG_DIR:path.join(sandbox,'claude')};
process.env.CODEX_HOME=env.CODEX_HOME;process.env.CLAUDE_CONFIG_DIR=env.CLAUDE_CONFIG_DIR;
const core=require('../packages/core/dist');
core.installCodexHooks('echo oak-config-probe', s=>s==='echo oak-config-probe');
const child=cp.spawn('codex',['app-server'],{cwd:sandbox,env,stdio:['pipe','pipe','pipe']});
const send=o=>child.stdin.write(JSON.stringify(o)+'\n');
let buf='',err='',done=false;
const finish=code=>{if(done)return;done=true;clearTimeout(timer);child.kill('SIGTERM');process.exitCode=code;};
const timer=setTimeout(()=>{console.error('Codex configuration probe timed out',err.slice(-2000));finish(1);},15000);
child.stderr.on('data',b=>{err=(err+b).slice(-4000);});
child.on('error',e=>{console.error(e.message);finish(1);});
child.on('exit',()=>{if(!done){console.error('Codex exited before returning hooks/list',err);finish(1);}fs.rmSync(sandbox,{recursive:true,force:true});});
child.stdout.on('data',b=>{buf+=b.toString();let at;while((at=buf.indexOf('\n'))>=0){const line=buf.slice(0,at);buf=buf.slice(at+1);let m;try{m=JSON.parse(line);}catch{continue;}
  if(m.id===1){if(m.error){console.error(m.error);finish(1);return;}send({method:'initialized',params:{}});send({id:2,method:'hooks/list',params:{cwds:[sandbox]}});}
  if(m.id===2){try{
    assert.ok(!m.error,JSON.stringify(m.error));
    const sets=m.result?.data ?? m.result?.hooks ?? [];
    const hooks=sets.flatMap(x=>x.hooks ?? [x]);
    const ours=hooks.filter(h=>JSON.stringify(h).includes('oak-config-probe'));
    console.log(JSON.stringify({codex:cp.execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),hooks:ours.map(h=>({event:h.eventName,timeout:h.timeoutSec,hash:h.currentHash,trust:h.trustStatus,status:h.statusMessage,enabled:h.enabled})),errors:sets.flatMap(x=>x.errors??[])},null,2));
    assert.equal(ours.length,core.CODEX_HOOK_EVENTS.length);
    assert.ok(ours.every(h=>h.trustStatus==='trusted'),'every installed hook must be trusted by Codex itself');
    finish(0);
  }catch(e){console.error(e.message);finish(1);}}
}});
send({id:1,method:'initialize',params:{clientInfo:{name:'oak_config_probe',version:'1'},capabilities:{experimentalApi:true}}});
