import './fixtures/offline-network.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
const source={platform:'xiaohongshu',kind:'saved_folder',accountId:'fixture_owner',folderId:'fixture_board',url:'https://www.xiaohongshu.com/user/profile/fixture_owner?tab=fav',maxItems:2};
const member=id=>({noteId:id,xsecToken:`fresh_${id}`});
const item=(id,patch={})=>({key:`xiaohongshu:${id}`,platform:'xiaohongshu',contentId:id,sourceUrl:`https://www.xiaohongshu.com/explore/${id}?xsec_token=stale`,selected:true,mediaResolved:false,media:[],...patch});
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url)),args:['--disable-background-networking','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});});
after(async()=>{await browser?.close();});
async function fixture(t,{members=['one','two','three'].map(member),identity,transfer,detail}={}){
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());const requests=[],transfers=[],events=[];let identityChecks=0,closed=false;context.on('close',()=>{closed=true;});
 await context.addCookies([{name:'web_session',value:'SYNTHETIC_SESSION',domain:'.xiaohongshu.com',path:'/',secure:true}]);
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());requests.push({path:url.pathname,token:url.searchParams.get('xsec_token')});let state,body='';
  if(url.pathname.startsWith('/user/profile/')){state={board:{userBoardList:{_rawValue:[{id:'fixture_board',name:'Synthetic board'}]}}};body='<div class="xhs-user-page-primary-tabs"><div class="reds-tab-item">笔记</div><div class="reds-tab-item active">收藏</div></div>';}
  else if(url.pathname==='/board/fixture_board')state={board:{boardFeedsMap:{_rawValue:{fixture_board:{notes:members}}}}};
  else if(url.pathname.startsWith('/explore/')){const id=url.pathname.split('/').at(-1),note=detail?detail(id):{noteId:id,imageList:[{urlDefault:`https://synthetic-media.invalid/${id}/1`},{urlDefault:`https://synthetic-media.invalid/${id}/2`}]};state={note:{noteDetailMap:{[id]:{note}}}};}
  else return route.abort();
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<body>${body}<script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script></body>`});
 });
 const adapter=browserAdapter('xiaohongshu',{open:async()=>context,identity:async(...args)=>{identityChecks++;return identity?identity(identityChecks,...args):{accountId:source.accountId};},download:async args=>{transfers.push({id:args.item.contentId,index:args.asset.index,url:args.asset.url});if(transfer)return transfer(args,transfers.length);return {contentKey:args.item.key,mediaIndex:args.asset.index,status:'completed'};}});
 return {context,requests,transfers,events,get identityChecks(){return identityChecks;},get closed(){return closed;},run:(items,signal=new AbortController().signal)=>adapter.download({request:{source,items,paths:{downloadRoot:'G:/synthetic-output',dataRoot:'G:/synthetic-data'}},signal,emit:async(type,payload)=>events.push({type,...payload})})};
}
test('folder download preflights all selected members and replaces stale tokens before selected-only detail',async t=>{
 const f=await fixture(t);const result=await f.run([item('one'),item('two',{selected:false}),item('three')]);
 assert.equal(result.status,'completed');assert.deepEqual(f.requests.filter(r=>r.path.startsWith('/explore/')), [{path:'/explore/one',token:'fresh_one'},{path:'/explore/three',token:'fresh_three'}]);
 assert.deepEqual(f.transfers.map(x=>x.id),['one','one','three','three']);assert.equal(f.events.filter(e=>e.type==='account').length,1);assert.deepEqual(f.events.filter(e=>e.type==='item').map(e=>e.item.contentId),['one','three']);assert.equal(f.requests.filter(r=>r.path.startsWith('/board/')).length,1);assert.equal(f.closed,true);
});
test('one missing selected member prevents every detail and transfer',async t=>{
 const f=await fixture(t);const result=await f.run([item('one'),item('missing')]);assert.equal(result.reasonCode,'folder_unverified');assert.equal(f.requests.some(r=>r.path.startsWith('/explore/')),false);assert.equal(f.transfers.length,0);assert.equal(f.events.some(e=>e.type==='item'||e.type==='receipt'),false);assert.equal(f.closed,true);
});
test('member outside first fifty is unverified without details or transfer',async t=>{
 const f=await fixture(t,{members:Array.from({length:51},(_,i)=>member(`note_${i}`))});const result=await f.run([item('note_50')]);assert.equal(result.reasonCode,'folder_unverified');assert.equal(f.requests.some(r=>r.path.startsWith('/explore/')),false);assert.equal(f.transfers.length,0);assert.equal(f.requests.filter(r=>r.path.startsWith('/board/')).length,1);
});
test('cached pending asset mask survives mandatory initial detail and exactly one 403 refresh',async t=>{
 const f=await fixture(t,{transfer:async(args,attempt)=>{if(attempt===1)throw Object.assign(new Error('synthetic expired'),{httpStatus:403});return {contentKey:args.item.key,mediaIndex:args.asset.index,status:'completed'};}});
 const result=await f.run([item('one',{mediaResolved:true,media:[{index:2,kind:'image',extension:'png',url:'https://synthetic-media.invalid/stale'}]})]);
 assert.equal(result.status,'completed');assert.deepEqual(f.transfers.map(x=>x.index),[2,2]);assert.ok(f.transfers.every(x=>x.url==='https://synthetic-media.invalid/one/2'));
 assert.deepEqual(f.requests.filter(r=>r.path.startsWith('/explore/')),Array(2).fill({path:'/explore/one',token:'fresh_one'}));assert.equal(f.requests.filter(r=>r.path.startsWith('/board/')).length,1);
 assert.ok(f.events.filter(e=>e.type==='item').every(e=>e.item.media.length===1&&e.item.media[0].index===2));assert.equal(f.events.filter(e=>e.type==='receipt').length,1);
});
for(const [code,reason,attempts] of [[401,'auth_required',1],[429,'rate_limited',1],[403,'media_forbidden',2],[410,'media_forbidden',2]])test(`folder transfer ${code} has existing finite stop policy`,async t=>{
 const f=await fixture(t,{transfer:async()=>{throw Object.assign(new Error('synthetic rejected'),{httpStatus:code});}});const result=await f.run([item('one')]);
 assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,reason);assert.equal(f.transfers.length,attempts);assert.equal(f.requests.filter(r=>r.path.startsWith('/explore/')).length,attempts);assert.equal(f.events.some(e=>e.type==='receipt'),false);assert.equal(f.closed,true);
});
test('starting account mismatch prevents details and every transfer',async t=>{
 const f=await fixture(t,{identity:async()=>({accountId:'different_owner'})});const result=await f.run([item('one')]);assert.equal(result.reasonCode,'auth_required');assert.equal(f.transfers.length,0);assert.equal(f.events.some(e=>e.type==='receipt'),false);assert.equal(f.requests.some(r=>r.path.startsWith('/explore/')),false);
});
test('cookie change after first folder transfer stops before next file',async t=>{
 let f;f=await fixture(t,{transfer:async(args,count)=>{if(count===1)await f.context.addCookies([{name:'web_session',value:'SYNTHETIC_CHANGED',domain:'.xiaohongshu.com',path:'/',secure:true}]);return {contentKey:args.item.key,mediaIndex:args.asset.index,status:'completed'};}});
 const result=await f.run([item('one')]);assert.equal(result.reasonCode,'auth_required');assert.equal(f.transfers.length,1);assert.equal(f.events.filter(e=>e.type==='receipt').length,1);
});
test('cancelled final identity keeps receipts and closes every owned page',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),controller=new AbortController();t.after(()=>release.resolve());
 const f=await fixture(t,{identity:async check=>{if(check===2){entered.resolve();await release.promise;}return {accountId:source.accountId};}});
 const running=f.run([item('one')],controller.signal);void running.catch(()=>{});await entered.promise;const reason=new Error('synthetic cancelled');controller.abort(reason);
 let timer;
 try{await assert.rejects(Promise.race([running,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('cancel did not retire identity')),300);})]),e=>e===reason);}
 finally{clearTimeout(timer);release.resolve();await running.catch(()=>{});}
 assert.equal(f.transfers.length,2);assert.equal(f.events.filter(e=>e.type==='receipt').length,2);assert.equal(f.context.pages().length,0);assert.equal(f.closed,true);
});
test('cancelled late transfer cannot publish a receipt or start the next asset',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),controller=new AbortController();t.after(()=>release.resolve());
 const f=await fixture(t,{transfer:async args=>{entered.resolve();await release.promise;return {contentKey:args.item.key,mediaIndex:args.asset.index,status:'completed'};}});
 const running=f.run([item('one')],controller.signal);void running.catch(()=>{});await entered.promise;const reason=new Error('synthetic transfer cancelled');controller.abort(reason);release.resolve();await assert.rejects(running,e=>e===reason);assert.equal(f.transfers.length,1);assert.equal(f.events.some(e=>e.type==='receipt'),false);assert.equal(f.closed,true);
});
test('cancelled late transfer progress cannot publish after cancellation',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),controller=new AbortController();t.after(()=>release.resolve());
 const f=await fixture(t,{transfer:async args=>{entered.resolve();await release.promise;await args.onProgress(123);return {contentKey:args.item.key,mediaIndex:args.asset.index,status:'completed'};}});
 const running=f.run([item('one')],controller.signal);void running.catch(()=>{});await entered.promise;const reason=new Error('synthetic progress cancelled');controller.abort(reason);release.resolve();await assert.rejects(running,e=>e===reason);assert.equal(f.events.some(e=>e.type==='progress'&&e.phase==='download'),false);assert.equal(f.events.some(e=>e.type==='receipt'),false);
});
test('DY folder and either directory downloads remain rejected without browser launch',async()=>{
 let opened=0;for(const [platform,kind] of [['douyin','saved_folder'],['douyin','saved_folders'],['xiaohongshu','saved_folders']]){
  const adapter=browserAdapter(platform,{open:async()=>{opened++;throw Error('unexpected browser');}});const result=await adapter.download({request:{source:{...source,platform,kind},items:[item('one',{platform})]},signal:new AbortController().signal,emit:async()=>{}});assert.equal(result.reasonCode,'folder_members_unavailable');
 }assert.equal(opened,0);
});
