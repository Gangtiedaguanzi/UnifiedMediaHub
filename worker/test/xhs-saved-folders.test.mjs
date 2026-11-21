import './fixtures/offline-network.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const api=await import('../src/shared/xhs-saved-folders.mjs').catch(()=>({}));
const source={platform:'xiaohongshu',kind:'saved_folders',accountId:'fixture-owner',maxItems:2};
const boards=[{id:'a',name:'Same',total:3},{boardId:'b',title:'Same'},{id:'c',name:'Third',total:8}];
test('parser preserves same-name IDs and unknown counts',()=>{
 assert.deepEqual(api.parseXhsFolderDirectory(boards).slice(0,2),[{id:'a',title:'Same',itemCount:3},{id:'b',title:'Same',itemCount:null}]);
});
test('parser refuses invalid IDs, conflicting aliases, oversized state and invalid counts',()=>{
 for(const raw of [[{id:'../other',name:'A'}],[{id:'a',boardId:'b',name:'A'}],[{id:'a',name:'A',title:'B'}],[{id:'a',name:'A',total:-1}],Array(1001).fill(boards[0]),{},[{id:'a',name:'A'},{id:'a',name:'B'}]])
  assert.throws(()=>api.parseXhsFolderDirectory(raw));
});
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url)),args:['--disable-background-networking','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});});
after(async()=>{await browser?.close();});
async function fixture(t,{raw=boards,selected=true,redirect=false,missing=false}={}){
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());
 const requests=[];
 await context.route('**/*',async r=>{
  requests.push(r.request().url());
  return r.fulfill({contentType:'text/html; charset=utf-8',body:`<body><div class="xhs-user-page-primary-tabs"><div class="reds-tab-item ${selected?'':'active'}">笔记</div><div class="reds-tab-item ${selected?'active':''}">收藏</div></div><script>window.__INITIAL_STATE__=${JSON.stringify(missing?{}:{board:{userBoardList:{_rawValue:raw}}})};${redirect?"history.replaceState({},'','/user/profile/another?tab=fav&subTab=board');":''}</script></body>`});
 });
 const page=await context.newPage();return {page,requests};
}
async function run(page,options={}){
 const events=[];let checks=0;
 const result=await api.listXhsFolders(page,{source,emit:async(type,p)=>events.push({type,...p}),verifyAccount:async()=>{checks++;return {accountId:source.accountId};},hydrationMs:30,...options});
 return {result,events,checks};
}
test('directory navigates once, emits only bounded folders after two account checks',async t=>{
 const {page,requests}=await fixture(t);let checks=0;const events=[];
 const out=await run(page,{verifyAccount:async()=>{checks++;return {accountId:source.accountId};},emit:async(type,p)=>{if(type==='folder')assert.equal(checks,2);events.push({type,...p});}});
 assert.equal(out.result.status,'completed');assert.equal(out.result.completeness,'partial');assert.equal(out.result.reasonCode,'history_unproven');
 assert.deepEqual(events.filter(e=>e.type==='folder').map(e=>e.folder),[{id:'a',title:'Same',itemCount:3},{id:'b',title:'Same',itemCount:null}]);
 assert.equal(events.filter(e=>e.type==='account').length,1);
 assert.deepEqual(requests,['https://www.xiaohongshu.com/user/profile/fixture-owner?tab=fav&subTab=board']);
 assert.equal(page.isClosed(),false);
});
for(const [name,config] of [['unselected',{selected:false}],['redirect',{redirect:true}],['missing state',{missing:true}],['oversized',{raw:Array(1001).fill(boards[0])}]])test(`directory refuses ${name}`,async t=>{
 const {page}=await fixture(t,config);const out=await run(page);assert.equal(out.result.status,'needs_action');assert.equal(out.result.reasonCode,'folder_unverified');assert.equal(out.events.some(e=>e.type==='folder'),false);
});
test('tab re-render during the hydration read is retried, not refused',async t=>{
 const {page}=await fixture(t),evaluate=page.evaluate.bind(page);let mutated=false;
 page.evaluate=async(...args)=>{
  const raw=await evaluate(...args);
  if(!mutated&&String(args[0]).includes('userBoardList')){mutated=true;await evaluate(()=>{const tab=document.querySelector('.reds-tab-item.active');tab.setAttribute('data-hydrated','1');tab.classList.add('hydrated');});}
  return raw;
 };
 const out=await run(page,{hydrationMs:2000});
 assert.equal(mutated,true);assert.equal(out.result.status,'completed');assert.equal(out.events.filter(e=>e.type==='folder').length,2);
});
test('initial identity cancellation publishes neither late account nor folders',async t=>{
 const {page}=await fixture(t),controller=new AbortController(),entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());const events=[];
 const running=api.listXhsFolders(page,{source,signal:controller.signal,emit:async(type,p)=>events.push({type,...p}),verifyAccount:async()=>{entered.resolve();await release.promise;return {accountId:source.accountId};}});
 void running.catch(()=>{});await entered.promise;const reason=new Error('initial stop');controller.abort(reason);await assert.rejects(running,e=>e===reason);release.resolve();await new Promise(setImmediate);assert.deepEqual(events,[]);assert.equal(page.isClosed(),true);
});
test('directory state mutation during final proof refuses even with unchanged primary tabs',async t=>{
 const {page}=await fixture(t);let checks=0;
 const out=await run(page,{verifyAccount:async()=>{if(++checks===2)await page.evaluate(()=>window.__INITIAL_STATE__.board.userBoardList._rawValue[0].name='changed');return {accountId:source.accountId};}});
 assert.equal(out.result.reasonCode,'folder_unverified');assert.equal(out.events.some(e=>e.type==='folder'),false);
});
test('directory cap is 50 and a proven empty directory remains partial',async t=>{
 for(const count of [0,55]){
  const {page}=await fixture(t,{raw:Array.from({length:count},(_,i)=>({id:`folder${i}`,name:'Same'}))});
  const out=await run(page,{source:{...source,maxItems:100}});
  assert.equal(out.result.status,'completed');assert.equal(out.result.completeness,'partial');assert.equal(out.events.filter(e=>e.type==='folder').length,Math.min(count,50));
 }
});
test('account switch and page changes during final proof cannot publish folders',async t=>{
 for(const mode of ['account','page']){
  const {page}=await fixture(t);let checks=0;
  const out=await run(page,{verifyAccount:async()=>{checks++;if(checks===2&&mode==='page')await page.evaluate(()=>history.replaceState({},'','?tab=fav&subTab=note'));return {accountId:checks===2&&mode==='account'?'another':source.accountId};}});
  assert.equal(out.result.status,'needs_action');assert.equal(out.events.some(e=>e.type==='folder'),false);
 }
});
test('cancel during final identity proof closes owned page and publishes nothing late',async t=>{
 const {page}=await fixture(t),controller=new AbortController(),entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());let checks=0;const events=[];
 const running=api.listXhsFolders(page,{source,signal:controller.signal,emit:async(type,p)=>events.push({type,...p}),verifyAccount:async()=>{if(++checks===2){entered.resolve();await release.promise;}return {accountId:source.accountId};}});
 void running.catch(()=>{});await entered.promise;const reason=new Error('fixture stop');controller.abort(reason);await assert.rejects(running,e=>e===reason);assert.equal(page.isClosed(),true);release.resolve();await new Promise(setImmediate);assert.equal(events.some(e=>e.type==='folder'),false);
});
