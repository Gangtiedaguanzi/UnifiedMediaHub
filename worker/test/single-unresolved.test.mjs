import './fixtures/offline-network.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {scanPage} from '../src/shared/scanner.mjs';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url)),args:['--disable-background-networking','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});});
after(async()=>{await browser?.close();});
async function fixture(t,{api=false}={}){
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());
 await context.route('**/*',route=>{
  if(route.request().url().includes('/aweme/detail/'))return route.fulfill({contentType:'application/json',body:JSON.stringify({aweme_detail:{aweme_id:'456',video:{play_addr:{url_list:['https://synthetic.invalid/wrong.mp4']}}}})});
  return route.fulfill({contentType:'text/html',body:`<body>synthetic empty detail${api?'<script>fetch("/aweme/v1/web/aweme/detail/?aweme_id=123")</script>':''}</body>`});
 });
 const page=await context.newPage(),events=[],source={platform:'douyin',kind:'single',url:'https://www.douyin.com/video/123'};
 return {context,page,events,source,emit:async(type,payload)=>events.push({type,...payload})};
}
test('douyin single with detail API missing target is needs_action',async t=>{
 const f=await fixture(t,{api:true});
 const result=await scanPage(f.page,{source:f.source,emit:f.emit,maxRounds:2,waitMs:10,timeoutMs:5000});
 assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'work_unresolved');assert.equal(f.events.some(e=>e.type==='item'),false);
 assert.equal(f.events.find(e=>e.type==='needs_action').code,'work_unresolved');
});
test('douyin single scan timeout is needs_action',async t=>{
 const f=await fixture(t);
 const result=await scanPage(f.page,{source:f.source,emit:f.emit,maxRounds:100,waitMs:100,timeoutMs:400});
 assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'work_unresolved');assert.equal(f.events.filter(e=>e.type==='needs_action').length,1);
});
test('download of unresolved single reports work_unresolved without transfer',async t=>{
 const f=await fixture(t);let transfers=0;
 const adapter=browserAdapter('douyin',{open:async()=>f.context,download:async()=>{transfers++;throw new Error('unexpected transfer');}});
 const result=await adapter.download({request:{source:f.source,paths:{downloadRoot:'G:/synthetic-output',dataRoot:'G:/synthetic-data'},items:[{platform:'douyin',contentId:'123',sourceUrl:f.source.url,mediaResolved:false,media:[]}]},signal:new AbortController().signal,emit:f.emit});
 assert.equal(result.reasonCode,'work_unresolved');assert.equal(transfers,0);
});
