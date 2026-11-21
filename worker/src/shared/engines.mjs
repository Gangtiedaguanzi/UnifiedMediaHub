import {diskFull,requireSpace,METADATA_RESERVE,WRITE_WINDOW} from './storage-budget.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { mkdtemp, rm, stat, readFile, writeFile, readdir } from 'node:fs/promises';
import { securePrivateRoot } from './private.mjs';
import { safeDirectory, rejectLinks } from './paths.mjs';
import { ActionRequired } from './source-resolution.mjs';

const packaged = fileURLToPath(new URL('../../../runtime/engines',import.meta.url));
const locks = new Set();
const machineCodes = new Set(['qr_expired','delivery_unsupported','resend_unavailable','invalid_input','unauthorized','auth_failed','rate_limited','network_error','cancelled','timeout','operation_failed']);
export function engineFailure(stdout='',stderr='') {
  let code = 'operation_failed';
  for (const line of stdout.split('\n')) {
    try { const event=JSON.parse(line); if(event.type==='error' && machineCodes.has(event.code)) code=event.code; } catch {}
  }
  const diagnostic=stdout+'\n'+stderr;
  if (/FLOOD_WAIT|rate.?limit|too many requests/i.test(diagnostic)) code='rate_limited';
  if (/ENOSPC|no space left on device|not enough space on the disk|disk full/i.test(diagnostic))code='disk_full';
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|not authorized|unauthorized|login required|authenticat/i.test(diagnostic)) code='unauthorized';
  const error = new Error(code); error.engineCode=code;
  // Telegram states the wait: "FLOOD_WAIT_60" or gotd's "FLOOD_WAIT (60)". Only the number is kept.
  const wait=/FLOOD_WAIT[_ (]+(\d{1,6})/i.exec(diagnostic);
  if(code==='rate_limited'&&wait&&Number(wait[1])>0&&Number(wait[1])<=86400)error.retryAfterSeconds=Number(wait[1]);
  return error;
}
// No process is launched at import. All children inherit the parent's owned Windows Job.
// This helper never accepts a caller-supplied environment, shell or detached process option.
export async function isolatedProcess({executable,args,root,signal,timeoutMs=120000,maxOutput=16*1024*1024,onLine,outputFile,maxFileBytes=16*1024*1024,spaceRoot}) {
  signal?.throwIfAborted();
  await safeDirectory(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^TDL_/i.test(k)));
  for (const key of Object.keys(env)) if (['HOME','USERPROFILE','TEMP','TMP','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME'].includes(key.toUpperCase())) delete env[key];
  Object.assign(env,{HOME:root,USERPROFILE:root,TEMP:root,TMP:root,APPDATA:root,LOCALAPPDATA:root,XDG_CONFIG_HOME:root,XDG_CACHE_HOME:root,PYTHONIOENCODING:'utf-8',NO_COLOR:'1'});
  const local = new AbortController(), combined = signal ? AbortSignal.any([signal,local.signal]) : local.signal;
  const timer=setTimeout(()=>local.abort(new Error('engine_timeout')),timeoutMs);
  let child,stdout='',stderr='',bytes=0,lineBuffer='',queue=Promise.resolve(),failure,activeCallbacks=0,fileTimer,spaceTimer,spaceChecking=false;
  const decoder=new StringDecoder('utf8');
  const fail = e=>{failure ??= e; local.abort(e);};
  try {
    child=spawn(executable,args,{cwd:root,env,windowsHide:true,shell:false,detached:false,stdio:['pipe','pipe','pipe']});
    const closed=new Promise(resolve=>{
      child.once('error',()=>{failure=new Error('engine_start_failed');});
      child.once('close',(code)=>resolve(code));
    });
    const stop=()=>{ failure ??= combined.reason ?? new Error('cancelled'); child.stdin.destroy(); child.kill(); };
    combined.addEventListener('abort',stop,{once:true});
    child.stdin.on('error',()=>{});
    const write=async value=>{
      combined.throwIfAborted();
      if (typeof value!=='string' || Buffer.byteLength(value)>65536) throw new Error('invalid_input');
      await new Promise((resolve,reject)=>child.stdin.write(value,'utf8',e=>e?reject(new Error('engine_input_failed')):resolve()));
    };
    const consume=line=> {
      if (Buffer.byteLength(line)>65536) return fail(new Error('engine_line_limit'));
      queue=queue.then(async()=>{combined.throwIfAborted();activeCallbacks++;try{return await onLine(line.replace(/\r$/,''),write,combined);}finally{activeCallbacks--;}}).catch(fail);
    };
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>maxOutput) return fail(new Error('engine_output_limit'));
      const s=decoder.write(chunk); stdout+=s;
      if(onLine){lineBuffer+=s; let i; while((i=lineBuffer.indexOf('\n'))>=0){consume(lineBuffer.slice(0,i));lineBuffer=lineBuffer.slice(i+1);} if(Buffer.byteLength(lineBuffer)>65536) fail(new Error('engine_line_limit'));}
    });
    child.stderr.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>maxOutput) return fail(new Error('engine_output_limit'));
      // Retained only privately in memory for allowlisted error translation; never forwarded.
      stderr=(stderr+chunk.toString('utf8')).slice(-65536);
      if(engineFailure('',stderr).engineCode==='disk_full')fail(Object.assign(new Error('disk_full'),{code:'ENOSPC'}));
    });
    if(combined.aborted) stop();
    if(outputFile)fileTimer=setInterval(()=>{void stat(outputFile).then(info=>{if(info.size>maxFileBytes)fail(new Error('engine_output_limit'));}).catch(e=>{if(e.code!=='ENOENT')fail(diskFull(e)?e:new Error('engine_output_failed'));});},100);
    if(spaceRoot)spaceTimer=setInterval(()=>{if(spaceChecking)return;spaceChecking=true;void requireSpace(spaceRoot,WRITE_WINDOW).catch(fail).finally(()=>spaceChecking=false);},100);
    if(!onLine) child.stdin.end();
    const code=await closed;
    combined.removeEventListener('abort',stop);
    if(onLine && lineBuffer.trim()) fail(new Error('engine_truncated_line'));
    // An engine exiting while a UI prompt is pending must release that waiter.
    if(code!==0 && !failure)failure=engineFailure(stdout,stderr);
    if(code!==0 || failure || activeCallbacks) local.abort(failure ?? new Error('engine_closed_with_pending_input'));
    await queue;
    if(failure) throw failure;
    if(code!==0) throw engineFailure(stdout,stderr);
    return {stdout,stderr};
  } finally {
    clearTimeout(timer);
    clearInterval(fileTimer);clearInterval(spaceTimer);
    local.abort(new Error('cancelled'));
    child?.stdin.destroy();
  }
}
export async function withEngineSession(ctx,platform,operation) {
  const paths=ctx.paths ?? ctx.request.paths;
  await requireSpace(paths.dataRoot,METADATA_RESERVE);
  if(path.resolve(paths.engineRoot).toLowerCase()!==path.resolve(packaged).toLowerCase()) throw new Error('invalid_engine_path');
  if(!['x','telegram'].includes(platform)) throw new Error('invalid_engine');
  const key=path.resolve(paths.dataRoot).toLowerCase();
  if(locks.has(key)) throw new Error('profile_busy');
  locks.add(key);
  let work;
  try {
    const privateRoot=await securePrivateRoot(paths.dataRoot);
    const persistent=await safeDirectory(path.join(privateRoot,'engines',platform));
    const tmp=await safeDirectory(path.join(privateRoot,'engine-tasks'));
    // Coordinator holds the data-root mutex. Only this application's known task
    // directory names are eligible for crash-secret cleanup on a later operation.
    for(const entry of await readdir(tmp,{withFileTypes:true}))if(/^task-[A-Za-z0-9]{6}$/.test(entry.name)){
      const stale=path.join(tmp,entry.name);await rejectLinks(stale);if(entry.isDirectory())await rm(stale,{recursive:true,force:true});
    }
    work=await mkdtemp(path.join(tmp,'task-'));
    const home=await safeDirectory(path.join(work,'home'));
    const engine=platform==='x'?'gallery-dl':'tdl';
    const executable=path.join(packaged,engine,`${engine}.exe`);
    await rejectLinks(executable);
    // Telegram: two pooled connections and 30 s reconnect, as in the proven standalone tool. FLOOD_WAIT fails
    // fast by default (login/identity/listing); a bulk download passes floodWait:'wait' so tdl sleeps out short waits.
    const base=platform==='telegram'?['--storage',`type=bolt,path=${path.join(persistent,'storage')}`,'-n','unified-media-hub-v1','--pool','2','--reconnect-timeout','30s']:[];
    const prefixFor=options=>platform==='telegram'&&options.floodWait!=='wait'?[...base,'--fail-on-flood-wait']:base;
    return await operation({work,home,persistent,run:(args,options={})=>isolatedProcess({...options,executable,args:[...prefixFor(options),...args],root:home,signal:ctx.signal}),write:async(name,text)=>{
      if(!/^[a-z0-9-]+\.(json|txt)$/.test(name)) throw new Error('invalid_temp_name');
      const file=path.join(work,name); await writeFile(file,text,{flag:'wx',mode:0o600}); return file;
    }});
  } finally {
    try { if(work) await rm(work,{recursive:true,force:true}); } finally { locks.delete(key); }
  }
}
export async function boundedFile(file,max=16*1024*1024) {
  await rejectLinks(file);
  if((await stat(file)).size>max) throw new Error('engine_output_limit');
  return readFile(file,'utf8');
}
export async function engineAction(ctx,operation) {
  try { return await operation(); }
  catch(e){
    if(ctx.signal?.aborted) throw e;
    const bounded=['engine_output_limit','engine_timeout'].includes(e.message);
    const code=['qr_expired','delivery_unsupported','resend_unavailable'].includes(e.engineCode)?e.engineCode:diskFull(e)?'disk_full':e.message==='storage_budget'?'storage_budget':e.engineCode==='network_error'?'network_error':e instanceof ActionRequired?e.code:e.engineCode==='rate_limited'?'rate_limited':['unauthorized','auth_failed'].includes(e.engineCode)?'auth_required':bounded?'input_required':null;
    if(!code) throw e;
    await ctx.emit('needs_action',{code,message:e instanceof ActionRequired?e.message:bounded?(e.message==='engine_timeout'?'The operation reached its finite time boundary. Narrow the source or retry this selection manually.':'The engine output exceeded the application boundary. Narrow the source to a topic or specific work and scan again.'):code==='rate_limited'?'The platform limited this operation. Retry only after manual action.':'Sign in to the new dedicated session and rescan this source.',...(code==='rate_limited'&&e.retryAfterSeconds?{retryAfterSeconds:e.retryAfterSeconds}:{})});
    return {status:'needs_action',completeness:'partial',reasonCode:code};
  }
}
