import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {currentIdentity} from '../src/shared/browser.mjs';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
import {xAdapter} from '../src/adapters/x.mjs';
import {Controls} from '../src/shared/protocol.mjs';
import {xSource,telegramItems} from '../src/shared/engine-media.mjs';
import {normalizeDouyin,normalizeXhs} from '../src/shared/normalizers.mjs';

// All identities, URLs and wire responses below are synthetic; no network.
function identityPage(platform, responses=[]){
 const page=new EventEmitter();let navigations=0;
 const wire={send:async()=>{},detach:async()=>{}};
 page.context=()=>({newCDPSession:async()=>wire});page.mainFrame=()=>page;
 page.evaluate=async()=>({accountId:'author-B'});page.isClosed=()=>false;
 page.goto=async()=>{navigations++;for(const r of responses){const req={method:()=>r.method??'GET',frame:()=>r.wrongFrame?{}:page,serviceWorker:()=>null};if(!r.old)page.emit('request',req);page.emit('response',{request:()=>req,url:()=>r.url??(platform==='douyin'?'https://www.douyin.com/aweme/v1/web/user/profile/self/':'https://edith.xiaohongshu.com/api/sns/web/v2/user/me'),ok:()=>true,status:()=>200,fromServiceWorker:()=>!!r.sw,headers:()=>({'content-length':r.large?'1048577':'100'}),text:async()=>JSON.stringify(r.body)});}};
 return {page,navigations:()=>navigations};
}
for(const platform of ['douyin','xiaohongshu']){
 const body=platform==='douyin'?{status_code:0,user:{sec_uid:'viewer-A'}}:{code:0,data:{guest:false,user_id:'viewer-A'}};
 test(`${platform}: author/cache state never proves identity`,async()=>{
  const f=identityPage(platform);assert.equal(await currentIdentity(f.page,platform,{timeoutMs:25}),null);
 });
 test(`${platform}: fresh self response alone identifies viewer`,async()=>{
  const f=identityPage(platform,[{body}]);assert.equal((await currentIdentity(f.page,platform,{timeoutMs:25})).accountId,'viewer-A');assert.equal(f.navigations(),1);
 });
 for(const variant of ['old','sw','wrongFrame','large','wrongHost','other','conflict'])test(`${platform}: reject ${variant} identity`,async()=>{
  const invalid={body,[variant]:true};if(variant==='wrongHost')invalid.url='https://evil.invalid/api/sns/web/v2/user/me';if(variant==='other')invalid.url='https://www.douyin.com/aweme/v1/web/user/profile/other/';
  const rs=variant==='conflict'?[{body},{body:platform==='douyin'?{status_code:0,user:{sec_uid:'viewer-B'}}:{code:0,data:{guest:false,user_id:'viewer-B'}}}]:[invalid];
  assert.equal(await currentIdentity(identityPage(platform,rs).page,platform,{timeoutMs:25}),null);
 });
}
// X self-close now intentionally verifies; ordinary-login/process tests cover it.
// Xiaohongshu login runs in an ordinary window (xhs-ordinary-login.test.mjs); the controlled-page closure applies to Douyin.
for(const platform of ['douyin'])for(const when of ['navigation','waiting','crash','finish-race'])test(`${platform}: login ${when} closure settles and retires control`,async()=>{
 const page=new EventEmitter(),browser=new EventEmitter(),controls=new Controls(),events=[];let closed=false;
 page.isClosed=()=>closed;page.goto=async()=>{if(when==='navigation'){closed=true;page.emit('close');throw new Error('page closed');}};
 browser.pages=()=>[page];browser.close=async()=>{};
 const abort=new AbortController();const watchdog=setTimeout(()=>abort.abort(new Error('watchdog')),400);
 const ctx={paths:{},request:{source:{}},signal:abort.signal,controls,emit:async(type,payload)=>{events.push({type,...payload});if(type==='needs_action'){if(when==='finish-race')controls.push({command:'finish-login'});closed=true;page.emit(when==='crash'?'crash':'close');browser.emit('close');}}};
 try{
  const adapter=platform==='x'?xAdapter({open:async()=>browser}):browserAdapter(platform,{open:async()=>browser});
  const result=await adapter.login(ctx);
  assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'browser_closed');assert.equal(events.some(e=>e.type==='account'),false);
  assert.equal(page.listenerCount('close')+page.listenerCount('crash')+browser.listenerCount('close'),0);
  // A late finish cannot be consumed by this attempt's abandoned waiter.
  const next=controls.waitFor('finish-login',abort.signal);controls.push({command:'finish-login'});assert.equal((await next).command,'finish-login');
 }finally{clearTimeout(watchdog);abort.abort();controls.close();}
});
test('X with_replies profile route matches classifier normalization',()=>assert.equal(xSource({kind:'profile',url:'https://x.com/alice/with_replies'}).url,'https://x.com/alice/media'));
test('Telegram export seconds become reliable ISO dates; invalid stays absent',()=>{
 const items=telegramItems(JSON.stringify({id:'12',peer_type:'chat',messages:[{id:1,date:1700000000},{id:2,date:'bad'},{id:3,date:1700000000000}]}));
 assert.equal(items[0].createdAt,'2023-11-14T22:13:20.000Z');assert.equal(items[1].createdAt,undefined);assert.equal(items[2].createdAt,undefined);
});
test('source date fields keep their documented units and never guess missing dates',()=>{
 assert.equal(normalizeDouyin({aweme_id:'1',create_time:1700000000}).createdAt,'2023-11-14T22:13:20.000Z');
 assert.equal(normalizeXhs({note_id:'a',time:1700000000000}).createdAt,'2023-11-14T22:13:20.000Z');
 assert.equal(normalizeDouyin({aweme_id:'1',create_time:'unknown'}).createdAt,undefined);
 assert.equal(normalizeXhs({note_id:'a',time:1700000000}).createdAt,undefined);
});
