import './fixtures/offline-network.mjs';
// All page requests are fulfilled/aborted locally in a fresh nonpersistent context.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium,errors} from 'playwright';
import {currentIdentity} from '../src/shared/browser.mjs';
const home='https://www.xiaohongshu.com/explore',endpoint='https://webapi.rednote.com/api/sns/web/v2/user/me';
const executablePath=fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url));

async function observe(mode){
 const browser=await chromium.launch({executablePath,headless:true,args:['--disable-background-networking','--disable-component-update','--no-first-run']});
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),controller=new AbortController();
 const row={mode,kind:0,freshRequests:0,endpointResponses:0,textStarted:0,textSettled:0,dcl:0,sameHome:false,acceptedExpectedAccount:false,originalDcl:false,originalNavigationMs:0,networkEnabled:false,cacheDisabled:false,serviceWorkerBypassed:false,identityListenerRetired:false,navigationRequests:0};let held,delayed,homeLoads=0,lateHeaders;
 const frame=page.mainFrame();
 const nativeSession=context.newCDPSession.bind(context);context.newCDPSession=async target=>{const wire=await nativeSession(target),send=wire.send.bind(wire);wire.send=async(method,args)=>{if(method==='Network.enable')row.networkEnabled=true;if(method==='Network.setCacheDisabled'&&args.cacheDisabled)row.cacheDisabled=true;if(method==='Network.setBypassServiceWorker'&&args.bypass)row.serviceWorkerBypassed=true;return send(method,args);};return wire;};
 const dcl=()=>row.dcl++;page.on('domcontentloaded',dcl);
 const request=req=>{if(req.isNavigationRequest()&&req.frame()===frame)row.navigationRequests++;if(req.url().startsWith(endpoint)&&req.method()==='GET'&&req.frame()===frame&&!req.serviceWorker())row.freshRequests++;};page.on('request',request);
 const response=res=>{if(!res.url().startsWith(endpoint))return;row.endpointResponses++;const text=res.text.bind(res);res.text=async()=>{row.textStarted++;if([5,11].includes(mode)&&res.url().includes('second'))await new Promise(resolve=>{delayed=setTimeout(resolve,mode===11?5000:1250);});const value=await text();row.textSettled++;return value;};};page.on('response',response);
 await context.route('**/*',async route=>{
  const url=route.request().url();if(url===home){
   homeLoads++;const first=mode===1||(mode===7&&homeLoads>1)?'':`fetch(${JSON.stringify(endpoint)});`;
   const second=[5,11,12].includes(mode)?`fetch(${JSON.stringify(endpoint+'?fixture=second')});`:'';
   const drift=mode===3?`history.pushState({},'', '/user/profile/fixture-other');`:mode===9?`history.pushState({},'', '/fixture-away');history.pushState({},'', '/explore');`:mode===10?`history.replaceState({},'', location.href);`:'';
   const cancel=mode===4?`fetch('/fixture-cancel');`:'';
   return route.fulfill({contentType:'text/html',body:`<!doctype html><script>${first}${second}${drift}${cancel}</script>${mode===6?'':'<script src="/fixture-held.js"></script>'}`});
  }
  if(url.startsWith(endpoint)){
   if(mode===12&&url.includes('second'))await new Promise(resolve=>{lateHeaders=setTimeout(resolve,1250);});
   return route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'https://www.xiaohongshu.com'},body:JSON.stringify({code:0,success:true,data:{guest:mode===2,user_id:[5,12].includes(mode)&&url.includes('second')?'fixture_other':'fixture_bound'}})}).catch(()=>{});
  }
  if(url.endsWith('/fixture-held.js')){held=route;return;}
  if(url.endsWith('/fixture-cancel')){setTimeout(()=>controller.abort(),100);return route.fulfill({body:''});}
  return route.abort();
 });
 const nativeGoto=page.goto.bind(page);page.goto=async(url,options)=>{row.originalDcl=options.waitUntil==='domcontentloaded';row.originalNavigationMs=options.timeout;try{return await nativeGoto(url,{...options,timeout:750});}catch(error){if(mode===7)await page.reload({waitUntil:'commit',timeout:1000});if(mode===8)throw new TypeError('synthetic non-timeout navigation failure');throw error;}};
 try{const value=await currentIdentity(page,'xiaohongshu',{signal:controller.signal,timeoutMs:2000});row.kind=value?1:2;row.acceptedExpectedAccount=value?.accountId==='fixture_bound';}
 catch(error){row.kind=controller.signal.aborted?4:error instanceof errors.TimeoutError?3:5;}
 finally{
  page.off('domcontentloaded',dcl);row.sameHome=page.url()===home;row.identityListenerRetired=page.listenerCount('request')===1&&page.listenerCount('response')===1&&page.listenerCount('framenavigated')===0&&page.listenerCount('requestfailed')===0;
  await held?.abort().catch(()=>{});await context.close();await browser.close();clearTimeout(delayed);clearTimeout(lateHeaders);
 }
 return row;
}
test('control: the identical exact fresh identity payload accepts after normal DCL',async()=>{const row=await observe(6);assert.equal(row.kind,1);assert.equal(row.acceptedExpectedAccount,true);assert.equal(row.dcl,1);});
test('valid exact fresh proof survives only its same-home DCL TimeoutError',async()=>{
 const row=await observe(0);assert.equal(row.freshRequests,1);assert.equal(row.endpointResponses,1);assert.equal(row.textSettled,1);assert.equal(row.dcl,0);assert.equal(row.sameHome,true);assert.equal(row.originalDcl,true);assert.equal(row.originalNavigationMs,30000);assert.equal(row.networkEnabled&&row.cacheDisabled&&row.serviceWorkerBypassed,true);assert.equal(row.identityListenerRetired,true);assert.equal(row.kind,1);
});
for(const [mode,name] of [[1,'no endpoint'],[2,'guest schema'],[3,'home route changed'],[4,'cancelled'],[5,'conflicting second proof still pending']])test(`negative: ${name} cannot accept account`,async()=>{const row=await observe(mode);assert.notEqual(row.kind,1);assert.equal(row.identityListenerRetired,true);if(mode!==1)assert.ok(row.freshRequests>=1);});
test('same URL document reload cannot salvage old fresh proof',async()=>{const row=await observe(7);assert.equal(row.sameHome,true);assert.equal(row.navigationRequests,2);assert.notEqual(row.kind,1);});
test('a non-TimeoutError cannot salvage valid fresh proof',async()=>{const row=await observe(8);assert.equal(row.kind,5);assert.equal(row.textSettled,1);});
test('leaving then returning to exact home cannot salvage old fresh proof',async()=>{const row=await observe(9);assert.equal(row.sameHome,true);assert.equal(row.navigationRequests,1);assert.notEqual(row.kind,1);});
test('same URL replaceState retains current proof and can salvage DCL timeout',async()=>{const row=await observe(10);assert.equal(row.kind,1);assert.equal(row.navigationRequests,1);assert.equal(row.acceptedExpectedAccount,true);});
test('pending response body that exceeds the existing body deadline cannot salvage',async()=>{const row=await observe(11);assert.notEqual(row.kind,1);assert.equal(row.textStarted,2);assert.equal(row.textSettled,1);});
test('an admitted second identity request with late conflicting headers cannot be missed',async()=>{const row=await observe(12);assert.equal(row.freshRequests,2);assert.notEqual(row.kind,1);});
