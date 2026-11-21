import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const e=await import('../src/shared/engines.mjs').catch(()=>({}));
const fixture=new URL('./fixtures/engine-child.mjs',import.meta.url);
import { fileURLToPath } from 'node:url';

test('engine launch isolates environment including inherited TDL and bounds raw output',async t=>{
  assert.equal(typeof e.isolatedProcess,'function');
  const root=await mkdtemp(path.join(os.tmpdir(),'umh-engine-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  process.env.TDL_STORAGE='MUST_NOT_SURVIVE';
  try {
    const r=await e.isolatedProcess({executable:process.execPath,args:[fileURLToPath(fixture),'env'],root,signal:new AbortController().signal});
    const env=JSON.parse(r.stdout);
    assert.equal(env.tdl.length,0);
    assert.equal(env.home,root);
    assert.equal(env.profile,root);
    assert.equal(env.temp,root);
    assert.equal(env.tmp,root);
    await assert.rejects(e.isolatedProcess({executable:process.execPath,args:[fileURLToPath(fixture),'overflow'],root,maxOutput:1024}),/engine_output_limit/);
  } finally {delete process.env.TDL_STORAGE;}
});
test('cancel during engine prompt kills process and rejects without reflecting secret',async t=>{
  assert.equal(typeof e.isolatedProcess,'function');
  const root=await mkdtemp(path.join(os.tmpdir(),'umh-engine-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const abort=new AbortController();
  let prompt=false;
  let signalPrompt;
  const promptStarted=new Promise(resolve=>{signalPrompt=resolve;});
  // Deliberately delay child startup beyond the former 150ms cancellation timer.
  const preload='data:text/javascript,await new Promise(resolve=>setTimeout(resolve,300))';
  const guard=setTimeout(()=>abort.abort(new Error('prompt_start_guard')),5000);
  const pending=e.isolatedProcess({executable:process.execPath,args:['--import',preload,fileURLToPath(fixture),'prompt'],root,signal:abort.signal,timeoutMs:5000,onLine:async(line,write,signal)=>{
    prompt=true;
    await new Promise((_,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
      signalPrompt();
    });
  }});
  // Observe rejection immediately, including startup failures; never leave a child
  // or an unhandled rejection behind when the ready handshake itself fails.
  const settled=pending.then(()=>({error:null}),error=>({error}));
  try{
    await Promise.race([promptStarted,settled.then(()=>{throw new Error('engine settled before prompt');})]);
    assert.equal(prompt,true);
    abort.abort();
    const {error}=await settled;
    assert.ok(error);assert.match(error.message,/cancelled|abort/i);assert.equal(error.message.includes('SYNTHETIC_SECRET'),false);
  }finally{clearTimeout(guard);abort.abort();await settled;}
});
test('engine root cannot be replaced by a request path',async t=>{
  assert.equal(typeof e.withEngineSession,'function');
  const root=await mkdtemp(path.join(os.tmpdir(),'umh-engine-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await assert.rejects(e.withEngineSession({paths:{dataRoot:root,engineRoot:root},signal:new AbortController().signal},'telegram',async s=>s.run(['--help'])),/invalid_engine_path/);
});
test('nonzero machine error after prompt is translated to rate_limited rather than cancellation',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umh-engine-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await assert.rejects(e.isolatedProcess({executable:process.execPath,args:[fileURLToPath(fixture),'machineerror'],root,onLine:async()=>{}}),error=>error.engineCode==='rate_limited');
});
test('engine exiting successfully with an unanswered prompt settles finitely',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'umh-engine-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const started=Date.now();
  await assert.rejects(e.isolatedProcess({executable:process.execPath,args:[fileURLToPath(fixture),'prompt-exit'],root,timeoutMs:1000,onLine:async(line,write,signal)=>{await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}}));
  assert.equal(Date.now()-started<800,true);
});
test('ordinary engine flood diagnostics on stdout become rate_limited without raw reflection',()=>{
 const error=e.engineFailure('Error: rpc FLOOD_WAIT_3600 SYNTHETIC_SECRET','');assert.equal(error.engineCode,'rate_limited');assert.equal(error.message.includes('SYNTHETIC_SECRET'),false);
});
test('engine export disk output bound stops oversized output before command deadline',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-engine-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const started=Date.now();
 await assert.rejects(e.isolatedProcess({executable:process.execPath,args:[fileURLToPath(fixture),'file-output',path.join(root,'export.json')],root,outputFile:path.join(root,'export.json'),maxFileBytes:1024,timeoutMs:1000}),/engine_output_limit/);
 assert.equal(Date.now()-started<800,true);
});
test('failed task deletes cookie and next operation removes only known crash remnants',async t=>{
 const {mkdir,writeFile,access}=await import('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-engine-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ctx={paths:{dataRoot:root,engineRoot:fileURLToPath(new URL('../../runtime/engines',import.meta.url))},signal:new AbortController().signal};
 let task;
 await assert.rejects(e.withEngineSession(ctx,'x',async s=>{task=s.work;await s.write('cookies.txt','SYNTHETIC_SECRET');throw new Error('fixture_failure');}),/fixture_failure/);
 await assert.rejects(access(task),{code:'ENOENT'});
 const parent=path.join(root,'private','engine-tasks');await mkdir(path.join(parent,'task-ABC123'));await writeFile(path.join(parent,'task-ABC123','cookies.txt'),'SYNTHETIC_SECRET');await mkdir(path.join(parent,'not-a-task'));
 await e.withEngineSession(ctx,'telegram',async()=>{});
 assert.deepEqual(await readdir(parent),['not-a-task']);
});
test('bounded engine stop returns actionable needs_action with distinct output and timeout reasons',async()=>{
 for(const code of ['engine_output_limit','engine_timeout']){const events=[];const result=await e.engineAction({signal:new AbortController().signal,emit:async(type,payload)=>events.push({type,...payload})},async()=>{throw new Error(code);});assert.equal(result.status,'needs_action');assert.equal(events[0].code,'input_required');assert.match(events[0].message,code==='engine_timeout'?/time/i:/output/i);}
});
test('rate limits carry the server wait in seconds so the user can be told how long to wait',async()=>{
 const m=await import('../src/shared/engines.mjs');
 for(const [text,seconds] of [['rpc error code 420: FLOOD_WAIT (75)',75],['Error: rpc FLOOD_WAIT_3600',3600],['too many requests',undefined]]){
  const error=m.engineFailure(text,'');assert.equal(error.engineCode,'rate_limited',text);assert.equal(error.retryAfterSeconds,seconds,text);
 }
 const events=[];const ctx={signal:new AbortController().signal,emit:async(type,payload)=>events.push({type,...payload})};
 const result=await m.engineAction(ctx,async()=>{throw m.engineFailure('FLOOD_WAIT (300)','');});
 assert.equal(result.reasonCode,'rate_limited');assert.equal(events[0].retryAfterSeconds,300);
});
