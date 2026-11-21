import './fixtures/offline-network.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {ordinaryHostExecutable,ordinaryLogin,ordinaryLoginArgs,runOrdinaryProcess} from '../src/shared/ordinary-login.mjs';
import {openBrowser,withBrowserProfile} from '../src/shared/browser.mjs';
import {Controls} from '../src/shared/protocol.mjs';
import {xAdapter} from '../src/adapters/x.mjs';
const repo=fileURLToPath(new URL('../..',import.meta.url));
const fixture=path.join(repo,'tests/fixtures/CrashHarness/bin/Debug/net10.0/CrashHarness.exe');
const host=path.join(repo,'.tooling/dotnet/dotnet.exe'),hostArgs=[path.join(path.dirname(fixture),'CrashHarness.dll')];
const browserExecutable=path.join(repo,'runtime/browsers/chromium-1248/chrome-win64/chrome.exe');
process.env.DOTNET_ROOT=path.dirname(host); // This test subprocess only; synthetic apphost runtime.
test('ordinary host resolves to the release-root application executable',()=>assert.equal(ordinaryHostExecutable,path.join(repo,'UnifiedMediaHub.exe')));
async function exists(file){return access(file).then(()=>true,()=>false);}
async function waitUntil(fn){const end=Date.now()+8000;while(!await fn()){assert.ok(Date.now()<end,'synthetic process deadline');await new Promise(r=>setTimeout(r,25));}}
async function setup(t,mode='normal'){
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-native-login-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const controls=new Controls(),abort=new AbortController(),order=[],events=[];
 t.after(()=>{abort.abort();controls.close();});
 let profile;
 const paths={dataRoot:root,browserExecutable};
 const ctx={paths,controls,signal:abort.signal,emit:async(type,value)=>events.push({type,...value})};
 const launch=async request=>{
  profile=request.args[0].slice('--user-data-dir='.length);await writeFile(path.join(profile,'mode.txt'),mode);
  assert.equal(request.executable,browserExecutable);
  await runOrdinaryProcess({...request,executable:fixture,host,hostArgs,onReady:async close=>{await waitUntil(async()=>await exists(path.join(profile,'window.ready'))&&await exists(path.join(profile,'leaf.pid')));order.push('ready');return request.onReady(()=>{order.push('WM_CLOSE');close();});}});
  order.push('tree-exited');
 };
 return {root,ctx,launch,controls,abort,order,events,get profile(){return profile;}};
}
for(const end of ['finish','self-close','timeout','cancel'])test(`ordinary executable lifecycle: ${end}`,{timeout:25000},async t=>{
 const f=await setup(t,end==='timeout'?'ignore':'normal');let verified=0;
 const running=ordinaryLogin(f.ctx,async lease=>{
  verified++;f.order.push('verify');assert.equal(lease.profile,f.profile);
  for(const file of ['browser.pid','leaf.pid']){const pid=Number(await readFile(path.join(f.profile,file),'utf8'));assert.throws(()=>process.kill(pid,0));}
  if(end!=='timeout')assert.equal(await exists(path.join(f.profile,'graceful.exit')),true);
  return {status:'completed'};
 },{launch:f.launch});
 let settled=false;const result=running.then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
 try{
  await waitUntil(()=>f.events.length>0||settled);if(settled)throw (await result).error??new Error('premature completion');
  const args=JSON.parse(await readFile(path.join(f.profile,'args.json'),'utf8'));
  assert.deepEqual(args,ordinaryLoginArgs(f.profile,'https://x.com/i/flow/login'));
  // The packaged browser's sandboxed network service cannot read its own executable and crashed with no
  // network in the owned window; it runs unsandboxed, as it does under Playwright. No automation flags.
  assert.deepEqual(args.slice(1),['--no-first-run','--no-default-browser-check','--disable-features=NetworkServiceSandbox','https://x.com/i/flow/login']);assert.equal(args.length,5);
  assert.equal(args.some(a=>/remote-debugging|enable-automation|disable-blink-features/.test(a)),false);
  await assert.rejects(openBrowser(f.ctx.paths,'x'),/profile_busy/);
  const adapter=xAdapter({session:async(_ctx,_platform,fn)=>fn({})});
  const scanContext={...f.ctx,request:{source:{platform:'x',kind:'profile',url:'https://x.com/synthetic'},items:[]}};
  await assert.rejects(adapter.scan(scanContext),/profile_busy/);
  await assert.rejects(adapter.download({...scanContext,request:{...scanContext.request,items:[{selected:true,mediaResolved:false}]}}),/profile_busy/);
  await assert.rejects(withBrowserProfile(f.ctx.paths,'douyin',f.ctx.signal,()=>assert.fail('busy')),/profile_busy/);
  const started=Date.now();
  if(end==='self-close')await writeFile(path.join(f.profile,'self-close'),'close');else if(end==='cancel')f.abort.abort(new Error('synthetic cancel'));else f.controls.push({command:'finish-login'});
  const completed=await result;
  if(end==='cancel'){assert.match(completed.error?.message??'',/synthetic cancel/);assert.equal(verified,0);for(const file of ['browser.pid','leaf.pid']){const pid=Number(await readFile(path.join(f.profile,file),'utf8'));assert.throws(()=>process.kill(pid,0));}}
  else {assert.equal(completed.value?.status,'completed');assert.equal(verified,1);assert.deepEqual(f.order,end==='self-close'?['ready','tree-exited','verify']:['ready','WM_CLOSE','tree-exited','verify']);}
  if(end==='timeout'){assert.ok(Date.now()-started>=9900);assert.equal(await exists(path.join(f.profile,'wm-close.txt')),true);assert.equal(await exists(path.join(f.profile,'graceful.exit')),false);}
  if(end==='self-close'){const next=f.controls.waitFor('finish-login',f.ctx.signal);f.controls.push({command:'finish-login'});assert.equal((await next).command,'finish-login');}
  await withBrowserProfile(f.ctx.paths,'x',new AbortController().signal,()=>{});
 }finally{f.abort.abort();await result;}
});

test('native helper crash closes its nested Job; unrelated executable survives',{timeout:15000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-host-crash-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'mode.txt'),'ignore');
 const sentinel=spawn(fixture,['--ordinary-leaf',root],{windowsHide:true,stdio:'ignore'});
 await waitUntil(()=>exists(path.join(root,'leaf.pid')));const sentinelPid=sentinel.pid;
 const helper=spawn(host,[...hostArgs,'--ordinary-browser-host'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>helper.once('close',resolve));
 try{
  helper.stdin.write(JSON.stringify({executable:fixture,args:ordinaryLoginArgs(root,'https://x.com/i/flow/login')})+'\n');
  await waitUntil(()=>exists(path.join(root,'window.ready')));const parent=Number(await readFile(path.join(root,'browser.pid'),'utf8'));
  await waitUntil(async()=>Number(await readFile(path.join(root,'leaf.pid'),'utf8'))!==sentinelPid);const leaf=Number(await readFile(path.join(root,'leaf.pid'),'utf8'));
  helper.kill();await closed;
  await waitUntil(()=>{try{process.kill(parent,0);return false;}catch{return true;}});
  assert.throws(()=>process.kill(leaf,0));assert.doesNotThrow(()=>process.kill(sentinelPid,0));
 }finally{helper.kill();await closed;const stopped=new Promise(resolve=>sentinel.once('close',resolve));sentinel.kill();await stopped;}
});
