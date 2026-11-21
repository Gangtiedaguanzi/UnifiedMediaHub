import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyBarrier} from '../src/shared/browser.mjs';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
import {Controls} from '../src/shared/protocol.mjs';

// A guest Xiaohongshu home shows a login dialog mentioning "验证码"; that is a login prompt, not a challenge.
test('a login dialog that mentions 验证码 is not a platform challenge',()=>{
 assert.equal(classifyBarrier({path:'/',text:'手机号登录 获取验证码 扫码登录'}),null);
 assert.equal(classifyBarrier({path:'/',text:'请完成下列验证后继续'}),'challenge');
 assert.equal(classifyBarrier({path:'/website-login/captcha',text:''}),'challenge');
 assert.equal(classifyBarrier({path:'/',text:'安全验证'}),'challenge');
 assert.equal(classifyBarrier({path:'/',text:'操作频繁，请稍后再试'}),'rate_limited');
 assert.equal(classifyBarrier({path:'/login',text:''}),'auth_required');
});

// In the automation-controlled browser the user's QR login never persisted (still guest);
// like X, Xiaohongshu login now runs in an ordinary browser window first.
test('Xiaohongshu login runs in an ordinary browser, then verifies with the same profile lease',async()=>{
 const calls=[];const events=[];const lease={profile:'P',executable:'E'};
 const page={context:()=>({newPage:async()=>page}),isClosed:()=>false,goto:async()=>{},close:async()=>{},evaluate:async()=>({path:'/',text:''})};
 const browser={pages:()=>[page],newPage:async()=>page,close:async()=>{}};
 const adapter=browserAdapter('xiaohongshu',{
  open:async(_paths,platform,options)=>{calls.push({open:platform,lease:options.profileLease});return browser;},
  identity:async()=>({accountId:'owner',displayName:'fixture'}),
  ordinary:async(ctx,verify,options)=>{calls.push({ordinary:options.platform,url:options.url});return verify(lease);},
 });
 const ctx={request:{source:{platform:'xiaohongshu',kind:'saved'}},paths:{dataRoot:'D',downloadRoot:'M'},signal:new AbortController().signal,controls:new Controls(),emit:async(type,payload)=>events.push({type,...payload})};
 const result=await adapter.login(ctx);
 assert.equal(result.status,'completed');
 assert.deepEqual(calls,[{ordinary:'xiaohongshu',url:'https://www.xiaohongshu.com/'},{open:'xiaohongshu',lease}]);
 assert.equal(events.find(e=>e.type==='account')?.accountId,'owner');
});
