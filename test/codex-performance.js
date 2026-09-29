/** Reproducible local I/O budget for the versioned native rollout adapter. No models or network. */
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{performance}=require('perf_hooks');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'oak-codex-perf-'));
process.env.CLAUDE_CONFIG_DIR=path.join(base,'claude');process.env.CODEX_HOME=path.join(base,'codex');
const C=require('../packages/core/dist'),source=path.join(base,'rollout.jsonl');
const message=(i)=>JSON.stringify({timestamp:new Date(1800000000000+i).toISOString(),type:'event_msg',payload:{type:'agent_message',turn_id:`turn-${i}`,message:`${i}:`+'x'.repeat(2000)}})+'\n';
try {
  fs.writeFileSync(source,JSON.stringify({type:'session_meta',payload:{id:'performance',cwd:base,model_provider:'openai'}})+'\n');
  for(let i=0;i<6000;i++)fs.appendFileSync(source,message(i));
  const start=performance.now();const derived=C.codexTranscriptFile(source);const cold=performance.now()-start;
  const warmStart=performance.now();C.codexTranscriptFile(source);const warm=performance.now()-warmStart;
  fs.appendFileSync(source,message(6001));
  const originalRead=fs.readSync,originalOpen=fs.openSync,originalClose=fs.closeSync;let readBytes=0;const sourceFds=new Set();
  fs.openSync=function(...args){const fd=originalOpen.apply(this,args);if(args[0]===source)sourceFds.add(fd);return fd;};
  fs.closeSync=function(fd){sourceFds.delete(fd);return originalClose.call(this,fd);};
  fs.readSync=function(...args){const n=originalRead.apply(this,args);if(sourceFds.has(args[0]))readBytes+=n;return n;};
  const appendStart=performance.now();try{C.codexTranscriptFile(source);}finally{fs.readSync=originalRead;fs.openSync=originalOpen;fs.closeSync=originalClose;}
  const append=performance.now()-appendStart;
  assert.ok(fs.readFileSync(derived,'utf8').includes('6001:'));
  assert.ok(readBytes<128*1024,`warm append read ${readBytes} bytes; budget is 128 KiB`);
  assert.ok(append<2000,`warm append blocked ${append.toFixed(1)}ms; budget is 2 seconds`);
  console.log(JSON.stringify({node:process.version,sourceBytes:fs.statSync(source).size,records:6001,coldMs:+cold.toFixed(2),warmMs:+warm.toFixed(2),appendMs:+append.toFixed(2),appendReadBytes:readBytes,rssMiB:Math.round(process.memoryUsage().rss/1024/1024)},null,2));
}finally{fs.rmSync(base,{recursive:true,force:true});}
