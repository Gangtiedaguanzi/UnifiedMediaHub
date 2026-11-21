import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
import {scanPage} from '../src/shared/scanner.mjs';

// Every request is fulfilled locally; these exercise Chromium navigation events,
// not a live platform. The wrapper delays an actual snapshot's delivery while
// actual page history/document changes occur; it never fabricates snapshot data.
const executablePath=fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url));
const start='https://v.douyin.com/SyntheticOnly/';
const final='https://www.douyin.com/video/123';
const modes=['baseline-short','baseline-direct','same-url-initial','same-work-query-initial','other-work-initial','away-back-initial','reload-initial','tab-change-initial','account-change-initial','continuous-same-url','cancel-initial','cancel-recheck'];
for(const mode of modes)test(`initial snapshot: ${mode}`,async()=>{
 const browser=await chromium.launch({executablePath,headless:true});
 try{
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  const wire=await context.newCDPSession(page);
  const html=`<!doctype html><body><div role="tablist"><button role="tab" aria-selected="true">作品</button><button role="tab" aria-selected="false">收藏</button><button role="tab" aria-selected="false">喜欢</button></div><script>window._ROUTER_DATA={aweme_id:'123',video:{play_addr:{url_list:['https://synthetic.invalid/media.mp4']}}};</script></body>`;
  wire.on('Fetch.requestPaused',async event=>{
   const redirect=event.request.url===start;
   await wire.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:redirect?302:200,responseHeaders:redirect?[{name:'Location',value:final}]:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(redirect?'':html).toString('base64')}).catch(()=>{});
  });
  await wire.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  const control=new AbortController(),source={platform:'douyin',kind:'single',url:final,maxItems:1,accountId:'synthetic-owner'};
  const evaluate=page.evaluate.bind(page),goto=page.goto.bind(page);
  let snapshots=0,gotos=0,triggered=false,sameDocument,sameUrl,sameTab;
  page.goto=async(...args)=>{gotos++;return goto(...args);};
  const history=async url=>Promise.all([page.waitForEvent('framenavigated'),evaluate(url=>window.history.replaceState({hydrated:true},'',url),url)]);
  page.evaluate=async(fn,arg)=>{
   const value=await evaluate(fn,arg);
   if(fn.name==='sourceTabState'){
    snapshots++;
    const first=snapshots===2&&!mode.startsWith('baseline');
    if(first||(mode==='continuous-same-url'&&snapshots>2)){
     triggered=true;
     if(mode==='reload-initial')await page.reload({waitUntil:'domcontentloaded'});
     else if(mode==='away-back-initial'){await history('/video/456');await history('/video/123');}
     else await history(mode==='same-work-query-initial'?'/video/123?tracking=synthetic':mode==='other-work-initial'?'/video/456':page.url());
     if(mode==='tab-change-initial')await evaluate(()=>{const tabs=document.querySelectorAll('[role=tab]');tabs[0].setAttribute('aria-selected','false');tabs[1].setAttribute('aria-selected','true');});
     if(mode==='account-change-initial')source.accountId='synthetic-other';
     const after=await evaluate(fn,arg);sameDocument=after.documentId===value.documentId;sameUrl=after.url===value.url;sameTab=after.tabGeneration===value.tabGeneration;
     if(mode==='cancel-initial')control.abort(new Error('synthetic_cancel'));
    }
    if(mode==='cancel-recheck'&&snapshots===3)control.abort(new Error('synthetic_cancel'));
   }
   return value;
  };
  const events=[],emit=async(type,payload)=>events.push({type,...payload});
  const run=()=>mode==='account-change-initial'?scanPage(page,{source,signal:control.signal,emit,maxRounds:2,waitMs:0,beforePublish:async()=>{if(source.accountId!=='synthetic-owner')throw Object.assign(new Error('synthetic session changed'),{code:'auth_required'});}}):browserAdapter('douyin',{open:async()=>context}).scan({request:{source:{platform:'douyin',kind:'single',url:mode==='baseline-direct'?final:start,maxItems:1}},signal:control.signal,emit});
  const deadline=setTimeout(()=>control.abort(new Error('fixture_timeout')),10000);
  let result;
  try{
   if(mode.startsWith('cancel-'))await assert.rejects(run(),/synthetic_cancel/);
   else result=await run();
  }finally{clearTimeout(deadline);}
  const works=events.filter(e=>e.type==='item').length;
  if(mode.startsWith('baseline')||mode==='same-url-initial'){
   assert.equal(result.status,'completed');assert.equal(works,1);assert.equal(gotos,mode==='baseline-direct'?1:2);
   assert.equal(events.find(e=>e.type==='item').item.contentId,'123');
  }else if(!mode.startsWith('cancel-')){assert.equal(result.reasonCode,mode==='account-change-initial'?'auth_required':'source_changed');assert.equal(works,0);}
  if(!mode.startsWith('baseline'))assert.equal(triggered,true);
  if(mode==='same-url-initial'){assert.equal(sameDocument,true);assert.equal(sameUrl,true);assert.equal(sameTab,true);}
  if(mode==='tab-change-initial')assert.equal(sameTab,false);
  if(mode==='reload-initial')assert.equal(sameDocument,false);
  if(mode==='continuous-same-url')assert.ok(snapshots<=3,'continuous changes must not retry indefinitely');
  if(mode.startsWith('cancel-')){assert.equal(works,0);assert.equal(events.filter(e=>e.type==='needs_action').length,0);}
 }finally{await browser.close();}
});
