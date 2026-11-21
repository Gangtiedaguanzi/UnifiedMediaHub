import './fixtures/offline-network.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
import {ActionRequired} from '../src/shared/source-resolution.mjs';
const directory=await import('../src/shared/saved-folders.mjs');
const endpoint='https://www.douyin.com/aweme/v1/web/collects/list/?cursor=0&count=10';
const source={platform:'douyin',kind:'saved_folders',url:'https://www.douyin.com/user/fixture-owner',accountId:'fixture-owner',maxItems:50};
const body={status_code:0,cursor:10,has_more:0,collects_list:[{collects_id_str:'7312345678901234567',collects_name:'SYNTHETIC FOLDER',total_number:0},{collects_id_str:'7312345678901234568',collects_name:'SYNTHETIC FOLDER'}]};
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url)),args:['--disable-background-networking','--disable-component-update','--no-first-run','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});});
after(async()=>{await browser?.close();});
async function fixture(t,{payload=body,url=endpoint,mode='normal',duplicateGroup=false}={}){
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());
 const requests=[],events=[];
 await context.route('**/*',async route=>{
  const req=route.request();
  if(req.isNavigationRequest()&&new URL(req.url()).pathname.startsWith('/user/'))return route.fulfill({contentType:'text/html; charset=utf-8',body:`<body><div role="tablist" id="primary"><button role="tab" aria-selected="true" id="profile">作品</button><button role="tab" aria-selected="false" id="saved">收藏</button><button role="tab" aria-selected="false">喜欢</button></div><div role="tablist" id="secondary" hidden><button role="tab" aria-selected="false" id="folder">收藏夹</button><button role="tab" aria-selected="true" id="video">视频</button></div>${duplicateGroup?'<div role="tablist"><button role="tab">收藏夹</button><button role="tab">视频</button></div>':''}<script>
saved.onclick=()=>{profile.setAttribute('aria-selected','false');saved.setAttribute('aria-selected','true');secondary.hidden=false;};
folder.onclick=()=>{window.folderClicks=(window.folderClicks??0)+1;const select=()=>{video.setAttribute('aria-selected','false');folder.setAttribute('aria-selected','true');};${mode==='fetch-first'?'setTimeout(select,100);':'select();'}${mode==='iframe'?`const frame=document.createElement('iframe');frame.srcdoc='<script>fetch(${JSON.stringify(url)})<\\/script>';document.body.append(frame);`:`fetch(${JSON.stringify(url)}).then(r=>r.json()).catch(()=>{});`}${mode==='switch'?`saved.setAttribute('aria-selected','false');profile.setAttribute('aria-selected','true');`:''}};
</script></body>`});
  requests.push({url:req.url(),frame:req.frame(),method:req.method()});
  return route.fulfill({contentType:'application/json',body:JSON.stringify(payload)});
 });
 const page=await context.newPage(),controller=new AbortController();
 return {page,context,requests,events,controller,run:extra=>directory.listDouyinFolders(page,{source,signal:controller.signal,emit:async(type,p)=>events.push({type,...p}),verifyAccount:async()=>({accountId:source.accountId}),maxRounds:2,waitMs:25,timeoutMs:4000,...extra})};
}
test('normal primary and secondary clicks publish only directory metadata after account gate',async t=>{
 assert.equal(typeof directory.listDouyinFolders,'function');const f=await fixture(t);let gate=0;
 const result=await f.run({verifyAccount:async()=>{gate++;assert.equal(f.events.filter(e=>e.type==='folder').length,0);return {accountId:source.accountId};}});
 assert.equal(result.status,'completed');assert.equal(result.completeness,'complete');assert.equal(gate,2);
 assert.equal(f.events.filter(e=>e.type==='account').length,1);
 assert.deepEqual(f.events.filter(e=>e.type==='folder'),body.collects_list.map((e,i)=>({type:'folder',folder:{id:e.collects_id_str,title:e.collects_name,itemCount:i===0?0:null}})));
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'GET');
});
test('first directory response survives fetch before delayed folder ARIA selection, with one native click',async t=>{
 const f=await fixture(t,{mode:'fetch-first'});assert.equal((await f.run()).status,'completed');assert.equal(f.events.filter(e=>e.type==='folder').length,2);assert.equal(await f.page.evaluate(()=>window.folderClicks),1);
});
test('observed empty terminal directory is distinct from absent response',async t=>{
 assert.equal(typeof directory.listDouyinFolders,'function');
 const f=await fixture(t,{payload:{...body,collects_list:[]}});assert.equal((await f.run()).completeness,'complete');assert.equal(f.events.some(e=>e.type==='folder'),false);
 const missing=await fixture(t,{url:'https://www.douyin.com/aweme/v1/web/aweme/listcollection/?cursor=0&count=10'});
 await assert.rejects(missing.run(),e=>e.code==='folder_unverified');assert.equal(missing.events.some(e=>e.type==='folder'),false);
});
for(const mode of ['iframe','switch'])test(`${mode} cannot populate directory`,async t=>{
 assert.equal(typeof directory.listDouyinFolders,'function');const f=await fixture(t,{mode});await assert.rejects(f.run(),e=>e.code=== (mode==='iframe'?'folder_unverified':'source_changed'));assert.equal(f.events.some(e=>e.type==='folder'),false);
});
test('ambiguous folder tab groups stop instead of clicking a title',async t=>{
 assert.equal(typeof directory.listDouyinFolders,'function');const f=await fixture(t,{duplicateGroup:true});await assert.rejects(f.run(),e=>e.code==='folder_unverified');assert.equal(f.events.some(e=>e.type==='folder'),false);assert.equal(f.requests.length,0);
});
test('publication account failure and cancellation deliver no metadata or raw diagnostics',async t=>{
 assert.equal(typeof directory.listDouyinFolders,'function');
 for(const cancel of [false,true]){
  const f=await fixture(t);
  let checks=0;await assert.rejects(f.run({verifyAccount:async()=>{if(++checks===1)return {accountId:source.accountId};if(cancel)f.controller.abort(new Error('SYNTHETIC PRIVATE SECRET'));else throw new ActionRequired('auth_required','The bound account changed.');}}));
  assert.equal(f.events.some(e=>e.type==='folder'),false);assert.equal(JSON.stringify(f.events).includes('SYNTHETIC PRIVATE SECRET'),false);
 }
});
test('directory cap and unknown pagination stay partial',async t=>{
 assert.equal(typeof directory.listDouyinFolders,'function');
 const f=await fixture(t,{payload:{...body,collects_list:Array.from({length:51},(_,i)=>({collects_id_str:String(i+1),collects_name:'SYNTHETIC'}))}});
 assert.equal((await f.run()).completeness,'partial');assert.equal(f.events.filter(e=>e.type==='folder').length,50);
 const unknown=await fixture(t,{payload:{...body,has_more:'unknown'}});assert.equal((await unknown.run()).completeness,'partial');
});
test('requested directory limit two is honored without whole-directory publication',async t=>{
 const f=await fixture(t,{payload:{...body,collects_list:[...body.collects_list,{collects_id_str:'3',collects_name:'SYNTHETIC EXTRA'}]}});
 const result=await f.run({source:{...source,maxItems:2}});assert.equal(result.completeness,'partial');assert.equal(result.reasonCode,'item_limit');assert.equal(f.events.filter(e=>e.type==='folder').length,2);
});
test('directory zero defaults fifty and larger requests remain clamped fifty',async t=>{
 for(const maxItems of [0,100]){const f=await fixture(t,{payload:{...body,collects_list:Array.from({length:51},(_,i)=>({collects_id_str:String(i+1),collects_name:'SYNTHETIC'}))}});assert.equal((await f.run({source:{...source,maxItems}})).completeness,'partial');assert.equal(f.events.filter(e=>e.type==='folder').length,50);}
});
test('front identity mismatch stops before navigation; publication mismatch is also checked by module',async t=>{
 for(const failAt of [1,2]){const f=await fixture(t);let calls=0;await assert.rejects(f.run({verifyAccount:async()=>({accountId:++calls===failAt?'changed':source.accountId})}),e=>e.code==='auth_required');assert.equal(f.events.some(e=>e.type==='folder'),false);if(failAt===1)assert.equal(f.page.url(),'about:blank');}
});
test('adapter reuses identity checker at start and before folder publication',async t=>{
 let identities=0;const f=await fixture(t);const events=[];
 const adapter=browserAdapter('douyin',{open:async()=>f.context,identity:async()=>({accountId:++identities===1?'fixture-owner':'changed-owner'})});
 const result=await adapter.listFolders({request:{source},signal:f.controller.signal,emit:async(type,p)=>events.push({type,...p})});
 assert.equal(identities,2);assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'auth_required');assert.equal(events.some(e=>e.type==='folder'||e.type==='item'),false);
});
test('source switch during delivery prevents later folder events',async t=>{
 const f=await fixture(t);let delivered=0;
 await assert.rejects(f.run({emit:async(type)=>{if(type==='folder'&&++delivered===1)await f.page.evaluate(()=>{document.querySelector('#saved').setAttribute('aria-selected','false');document.querySelector('#profile').setAttribute('aria-selected','true');});}}),e=>e.code==='source_changed');
 assert.equal(delivered,1);
});
test('XHS adapter directory dispatch shares the existing identity callback contract',async t=>{
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());
 await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<body><div class="xhs-user-page-primary-tabs"><div class="reds-tab-item">笔记</div><div class="reds-tab-item active">收藏</div></div><script>window.__INITIAL_STATE__={board:{userBoardList:{_rawValue:[{id:"synthetic-board",name:"Synthetic"}]}}};</script></body>'}));
 let checks=0;const events=[];const adapter=browserAdapter('xiaohongshu',{open:async()=>context,identity:async()=>{checks++;return {accountId:source.accountId};}});
 const result=await adapter.listFolders({request:{source:{...source,platform:'xiaohongshu',url:'https://www.xiaohongshu.com/user/profile/'+source.accountId}},signal:new AbortController().signal,emit:async(type,p)=>events.push({type,...p})});
 assert.equal(result.status,'completed',JSON.stringify({result,checks,eventTypes:events.map(e=>e.type)}));assert.equal(checks,2);assert.equal(events.filter(e=>e.type==='account').length,1);assert.equal(events.filter(e=>e.type==='folder').length,1);
});
