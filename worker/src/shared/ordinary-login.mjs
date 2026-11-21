import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {withBrowserProfile} from './browser.mjs';
import {rejectLinks} from './paths.mjs';

export const ordinaryHostExecutable=fileURLToPath(new URL('../../../UnifiedMediaHub.exe',import.meta.url));
export function ordinaryLoginArgs(profile,url){
 // NetworkServiceSandbox off: the packaged browser's sandboxed network service cannot read its own
 // executable, crashes, and the owned window is left with no network (Playwright runs it unsandboxed too).
 return [`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-features=NetworkServiceSandbox',url];
}

// A short-lived native helper, itself inside the worker's Job. No browser CDP,
// shell, detached process, browser environment override or automation arguments.
export async function runOrdinaryProcess({executable,args,signal,onReady,host=ordinaryHostExecutable,hostArgs=[]}){
 signal?.throwIfAborted();await rejectLinks(host);
 const child=spawn(host,[...hostArgs,'--ordinary-browser-host'],{windowsHide:true,shell:false,detached:false,stdio:['pipe','pipe','ignore']});
 let buffer='',ready=false,exited=false,failure;
 const completion=new Promise((resolve,reject)=>{
  child.once('error',()=>{failure=new Error('ordinary_browser_start_failed');});
  child.stdout.on('data',chunk=>{
   buffer+=chunk.toString('utf8');
   if(Buffer.byteLength(buffer)>4096){failure=new Error('ordinary_browser_protocol');child.stdin.destroy();return;}
   let i;while((i=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
    try{const event=JSON.parse(line);
     if(event.type==='ready'&&!ready){ready=true;void Promise.resolve().then(()=>onReady(()=>child.stdin.write('close\n'))).catch(error=>{failure=error;child.stdin.end();});}
     else if(event.type==='exited'&&ready)exited=true;
     else throw new Error();
    }catch{failure=new Error('ordinary_browser_protocol');child.stdin.destroy();}
   }
  });
  child.once('close',code=>{
   signal?.removeEventListener('abort',cancel);
   if(signal?.aborted)reject(signal.reason);else if(failure)reject(failure);else if(code!==0||!ready||!exited)reject(new Error('ordinary_browser_failed'));else resolve();
  });
 });
 const cancel=()=>child.stdin.end('cancel\n');
 child.stdin.on('error',()=>{});
 signal?.addEventListener('abort',cancel,{once:true});
 child.stdin.write(JSON.stringify({executable,args})+'\n');
 if(signal?.aborted)cancel();
 await completion;
}

export async function ordinaryLogin(ctx,verify,{launch=runOrdinaryProcess,platform='x',url='https://x.com/i/flow/login'}={}){
 return withBrowserProfile(ctx.paths,platform,ctx.signal,async lease=>{
  // Self-close also ends the waiter. A stale finish command must not leak into
  // another attempt, and cancellation must not release the lease before exit.
  const done=new AbortController();const waitingSignal=AbortSignal.any([ctx.signal,done.signal]);
  try{
   await launch({executable:lease.executable,args:ordinaryLoginArgs(lease.profile,url),signal:ctx.signal,onReady:async close=>{
    const waiting=ctx.controls.waitFor('finish-login',waitingSignal);void waiting.catch(()=>{});
    await ctx.emit('needs_action',{code:'auth_required',awaitingInput:true,message:'Sign in in the opened browser, then confirm or close its window.'});
    try{await waiting;ctx.signal.throwIfAborted();close();}catch(error){if(!done.signal.aborted)throw error;}
   }});
   done.abort();ctx.signal.throwIfAborted();return await verify(lease);
  }finally{done.abort();}
 });
}
