import './fixtures/offline-network.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
const fingerprint=await import('../src/shared/session-fingerprint.mjs').catch(()=>({}));
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url)),args:['--disable-background-networking','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});});
after(async()=>{await browser?.close();});
const token='SYNTHETIC_SESSION_A',owner='fixture_owner';
const cookie=(platform,value=token)=>({name:platform==='douyin'?'sessionid':'web_session',value,domain:platform==='douyin'?'.douyin.com':'.xiaohongshu.com',path:'/',secure:true});
async function fixture(t,{platform='xiaohongshu',identity,afterTransfer,afterItem,afterAction,noCookie=false}={}){
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());
 if(!noCookie)await context.addCookies([cookie(platform)]);
 let identityChecks=0,newPages=0;const events=[],transfers=[],identityPages=new Set(),identityEntryUrls=[];
 const nativeNewPage=context.newPage.bind(context);context.newPage=async()=>{newPages++;return nativeNewPage();};
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.pathname.includes('/aweme/listcollection/'))return route.fulfill({contentType:'application/json',body:JSON.stringify({status_code:0,cursor:50,has_more:0,aweme_list:Array.from({length:50},(_,i)=>({aweme_id:String(1000+i),desc:'Synthetic work'}))})});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<body><div role="tablist"><button role="tab" aria-selected="false">作品</button><button role="tab" aria-selected="true">收藏</button><button role="tab" aria-selected="false">喜欢</button></div>${platform==='douyin'?'<script>fetch("/aweme/v1/web/aweme/listcollection/",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"cursor=0&count=50"})</script>':''}</body>`});
 });
 const adapter=browserAdapter(platform,{open:async()=>context,identity:async(page,p,options)=>{identityPages.add(page);identityEntryUrls.push(page.url());identityChecks++;await page.goto(platform==='douyin'?'https://www.douyin.com/':'https://www.xiaohongshu.com/explore',{waitUntil:'domcontentloaded'});return identity?identity({check:identityChecks,page,options,transfers,context}):{accountId:owner};},download:async({item,asset})=>{transfers.push({item:item.contentId,index:asset.index});await afterTransfer?.({context,count:transfers.length,identityPages});return {contentKey:item.key,mediaIndex:asset.index,status:'completed'};}});
 const source={platform,kind:'profile',accountId:owner,url:platform==='douyin'?`https://www.douyin.com/user/${owner}`:`https://www.xiaohongshu.com/user/profile/${owner}`};
 const emit=async(type,payload)=>{events.push({type,...payload});if(type==='item')await afterItem?.({context,count:events.filter(e=>e.type==='item').length,identityPages});if(type==='needs_action')await afterAction?.({identityPages});};
 const items=n=>Array.from({length:n},(_,i)=>({key:`${platform}:${i+1}`,platform,contentId:String(i+1),sourceUrl:platform==='douyin'?`https://www.douyin.com/video/${i+1}`:`https://www.xiaohongshu.com/explore/${i+1}?xsec_token=synthetic`,mediaResolved:true,media:Array.from({length:9},(_,j)=>({index:j+1,kind:'image',extension:'png',url:`https://synthetic.invalid/${i}/${j}`}))}));
 return {context,adapter,events,transfers,identityPages,identityEntryUrls,get identityChecks(){return identityChecks;},get newPages(){return newPages;},
  download:(n=1,signal=new AbortController().signal)=>adapter.download({request:{source,items:items(n),paths:{downloadRoot:'G:/synthetic-output',dataRoot:'G:/synthetic-data'}},signal,emit}),
  scan:()=>adapter.scan({request:{source:{...source,kind:'saved',maxItems:50}},signal:new AbortController().signal,emit})};
}
test('fingerprint is order-independent, excludes unrelated cookies and never returns cookie text',async()=>{
 assert.equal(typeof fingerprint.sessionFingerprint,'function');
 const context={cookies:async()=>[{name:'irrelevant',value:'ignored'},{name:'web_session',value:'one'}]};
 assert.equal(await fingerprint.sessionFingerprint(context,'xiaohongshu'),createHash('sha256').update('web_session=one\n').digest('hex'));
 assert.equal(await fingerprint.sessionFingerprint({cookies:async()=>[]},'xiaohongshu'),null);
 const a={cookies:async()=>[{name:'uid_tt',value:'user'},{name:'sessionid',value:'session'}]},b={cookies:async()=>(await a.cookies()).reverse()};
 assert.equal(await fingerprint.sessionFingerprint(a,'douyin'),await fingerprint.sessionFingerprint(b,'douyin'));
});
test('private list scan of 50 items calls identity at most 3 times',async t=>{
 const f=await fixture(t,{platform:'douyin'});const result=await f.scan();assert.equal(result.status,'completed');assert.equal(f.events.filter(e=>e.type==='item').length,50);assert.ok(f.identityChecks<=3);assert.equal(f.identityChecks,2);
});
for(const n of [1,3])test(`download of ${n} item(s) x 9 media calls identity exactly 2 times`,async t=>{
 const f=await fixture(t);const result=await f.download(n);assert.equal(result.status,'completed');assert.equal(f.transfers.length,n*9);assert.equal(f.identityChecks,2);
 assert.equal(f.events.filter(e=>e.type==='receipt').length,n*9);assert.equal(JSON.stringify(f.events).includes(token),false);
});
test('identity checks reuse one tab',async t=>{
 const f=await fixture(t);await f.download();assert.ok(f.newPages<=2);assert.equal(f.identityPages.size,1);assert.equal([...f.identityPages].every(p=>p.isClosed()),true);
});
for(const operation of ['scan','download'])test(`identity page returns to about:blank after each ${operation} check`,async t=>{
 const parked=[];
 const observe=({identityPages})=>{for(const page of identityPages)parked.push(page.url());};
 const f=await fixture(t,{platform:operation==='scan'?'douyin':'xiaohongshu',afterItem:observe,afterTransfer:observe});
 const result=await f[operation]();
 assert.equal(result.status,'completed');assert.ok(parked.length>0);
 assert.deepEqual([...new Set(parked)],['about:blank']);
 assert.deepEqual(f.identityEntryUrls,['about:blank','about:blank']);
 assert.equal(f.identityChecks,2);assert.equal(f.identityPages.size,1);assert.equal(f.newPages,2);
});
for(const failure of ['identity_timeout','account_mismatch','cancelled'])test(`identity page is blank or closed after ${failure}`,async t=>{
 const states=[],controller=new AbortController();
 const observe=({identityPages})=>{for(const page of identityPages)states.push(page.isClosed()||page.url()==='about:blank');};
 const f=await fixture(t,{identity:async()=>{
  if(failure==='account_mismatch')return {accountId:'other'};
  if(failure==='cancelled'){controller.abort(new Error('synthetic cancellation'));controller.signal.throwIfAborted();}
  throw new Error('identity_timeout');
 },afterAction:observe});
 if(failure==='cancelled'){
  await assert.rejects(f.download(1,controller.signal),/synthetic cancellation/);observe(f);
 }else{
  const result=await f.download();assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,failure==='identity_timeout'?'identity_unverified':'auth_required');
 }
 assert.ok(states.length>0);assert.ok(states.every(Boolean));assert.equal(f.transfers.length,0);
});
test('cookie change mid-download stops before next asset and keeps four receipts',async t=>{
 const f=await fixture(t,{afterTransfer:async({context,count})=>{if(count===4)await context.addCookies([cookie('xiaohongshu','SYNTHETIC_SESSION_B')]);}});
 const result=await f.download();assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'auth_required');assert.equal(f.transfers.length,4);assert.equal(f.events.filter(e=>e.type==='receipt').length,4);
});
test('session cookie missing at start fails closed',async t=>{
 const f=await fixture(t,{noCookie:true});const result=await f.download();assert.equal(result.reasonCode,'auth_required');assert.equal(f.transfers.length,0);
});
test('account mismatch at final check is needs_action with completed receipts retained',async t=>{
 const f=await fixture(t,{identity:async({check})=>({accountId:check===2?'other':owner})});
 const result=await f.download();assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'auth_required');assert.equal(f.events.filter(e=>e.type==='receipt').length,9);
});
test('cookie change during scan stops publishing after ten items',async t=>{
 const f=await fixture(t,{platform:'douyin',afterItem:async({context,count})=>{if(count===10)await context.addCookies([cookie('douyin','SYNTHETIC_CHANGED')]);}});
 const result=await f.scan();assert.equal(result.reasonCode,'auth_required');assert.equal(f.events.filter(e=>e.type==='item').length,10);
});
test('off-platform main frame stops bound download before transfer',async t=>{
 const f=await fixture(t,{identity:async({page})=>{await page.context().pages()[0].goto('https://synthetic.invalid/away');return {accountId:owner};}});
 const result=await f.download();assert.equal(result.reasonCode,'source_changed');assert.equal(f.transfers.length,0);
});
