import './fixtures/offline-network.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../src/shared/browser.mjs';
const x=await import('../src/adapters/x.mjs').catch(()=>({}));
test('X reason mapping covers each gallery-dl error class and priority',()=>{
 assert.equal(typeof x.xEngineReason,'function');
 const r=(errors,extra={})=>x.xEngineReason({items:[],errors,queued:0,...extra})?.code??null;
 for(const [errors,expected] of [
  [[{type:'AbortExtraction',message:'Rate limit exceeded'}],'rate_limited'],
  [[{type:'AuthRequired',message:'NSFW Tweet'}],'sensitive_content'],
  [[{type:'AuthorizationError',message:'NSFW Tweet'}],'sensitive_content'],
  [[{type:'AuthRequired',message:'Protected Tweet'}],'auth_required'],
  [[{type:'AuthenticationError',message:'x'}],'auth_required'],
  [[{type:'AbortExtraction',message:"Tweet unavailable ('Suspended')"}],'work_unavailable'],
  [[{type:'NotFoundError',message:'x'}],'work_unavailable'],
  [[{type:'HttpError',message:'x'}],'input_required'],
  [[{type:'AuthRequired',message:'NSFW'},{type:'AbortExtraction',message:'rate limit'}],'rate_limited'],
 ])assert.equal(r(errors),expected);
 assert.equal(r([],{queued:1}),'embedded_unsupported');assert.equal(r([]),null);
 assert.equal(r([],{items:[{}],queued:1}),null);
});
async function galleryFixture(t,rows,source={}){
 const {ctx,events,root}=await setup(t,source);let calls=0,transfers=0;
 const adapter=x.xAdapter({open:async()=>({cookies:async()=>[],close:async()=>{}}),session:async(ctx,p,fn)=>fn({write:async(name,text)=>{const file=path.join(root,name);await writeFile(file,text);return file;},run:async()=>{calls++;return {stdout:JSON.stringify(rows)};}}),transfer:async()=>{transfers++;throw new Error('unexpected transfer');}});
 return {ctx,events,adapter,calls:()=>calls,transfers:()=>transfers};
}
const galleryMedia=id=>[3,'https://pbs.twimg.com/a.jpg',{tweet_id:id,num:1,extension:'jpg'}];
test('X single with media then error is partial and unresolved',async t=>{
 const f=await galleryFixture(t,[galleryMedia('1234567890123456789'),[-1,{error:'AbortExtraction',message:'boom'}]]);
 const result=await f.adapter.scan(f.ctx);assert.equal(result.status,'completed');assert.equal(result.completeness,'partial');assert.equal(result.reasonCode,'input_required');
 assert.equal(f.events.find(e=>e.type==='item').item.mediaResolved,false);
});
test('X single with only queue reports embedded_unsupported',async t=>{
 const f=await galleryFixture(t,[[6,'https://x.com/i/cards/1',{}]]);
 const result=await f.adapter.scan(f.ctx);assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'embedded_unsupported');
});
test('profile rate limit mid-scan keeps items and stops',async t=>{
 const f=await galleryFixture(t,[galleryMedia('1234567890123456789'),galleryMedia('1234567890123456790'),[-1,{error:'AbortExtraction',message:'Rate limit exceeded'}]],{kind:'profile',url:'https://x.com/fixture'});
 const result=await f.adapter.scan(f.ctx);assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'rate_limited');assert.equal(f.events.filter(e=>e.type==='item').length,2);assert.equal(f.calls(),1);
});
test('X download maps refresh error instead of generic input_required',async t=>{
 const f=await galleryFixture(t,[[-1,{error:'AbortExtraction',message:"Tweet unavailable ('Deleted')"}]]);
 f.ctx.request.items=[{key:'x:1234567890123456789',platform:'x',contentId:'1234567890123456789',sourceUrl:f.ctx.request.source.url,mediaResolved:true,media:[{index:1,kind:'image'}]}];
 const result=await f.adapter.download(f.ctx);assert.equal(result.reasonCode,'work_unavailable');assert.equal(f.transfers(),0);
});
test('X single queue plus media cannot claim complete media',async t=>{
 const f=await galleryFixture(t,[galleryMedia('1234567890123456789'),[6,'https://x.com/i/cards/1',{}]]);
 const result=await f.adapter.scan(f.ctx);assert.equal(result.completeness,'partial');assert.equal(result.reasonCode,'history_unproven');assert.equal(f.events.find(e=>e.type==='item').item.mediaResolved,false);
});
test('X indexed single preserves unavailable reason before missing-index fallback',async t=>{
 const f=await galleryFixture(t,[[-1,{error:'NotFoundError',message:'x'}]],{url:'https://x.com/a/status/1234567890123456789/video/2'});
 const result=await f.adapter.scan(f.ctx);assert.equal(result.reasonCode,'work_unavailable');
});
const browserExecutable=fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url));
const engineRoot=fileURLToPath(new URL('../../runtime/engines',import.meta.url));
for(const ending of ['finish','cancel'])test(`real X login notifies action before exact finish control and closes: ${ending}`,async t=>{
 const {Controls}=await import('../src/shared/protocol.mjs');const {xLoginPage,xLoginOrdinary}=await import('./fixtures/x-login-page.mjs');
 const {ctx,events}=await setup(t,{kind:'profile',url:'https://x.com/'}),fixture=xLoginPage(),controls=new Controls(),abort=new AbortController();
 ctx.signal=abort.signal;ctx.controls=controls;const notified=Promise.withResolvers();
 ctx.emit=async(type,payload)=>{events.push({type,...payload});notified.resolve();};
 let settled=false;const running=x.xAdapter({open:async()=>fixture.browser,ordinary:xLoginOrdinary}).login(ctx);
 const observed=running.then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
 try {
  await notified.promise;
  assert.equal(events[0].type,'needs_action');assert.equal(events[0].code,'auth_required');
  assert.equal(settled,false);assert.deepEqual(fixture.navigations,[]);
  controls.push({command:'continue'});await new Promise(r=>setTimeout(r,10));
  assert.equal(settled,false);assert.equal(events.some(e=>e.type==='account'),false);
  if(ending==='finish')controls.push({command:'finish-login'});else abort.abort(new Error('fixture cancel'));
  const result=await observed;
  if(ending==='finish'){assert.equal(result.value.status,'completed');assert.equal(events[1].type,'account');assert.equal(events[1].accountId,'9007199254740993');assert.deepEqual(fixture.navigations,['https://x.com/home']);}
  else {assert.match(result.error?.message??'',/fixture cancel/);assert.equal(events.some(e=>e.type==='account'),false);}
  assert.equal(fixture.closed,ending==='finish');
 }finally{abort.abort();await observed;controls.close();}
});
async function setup(t,source={}){const root=await mkdtemp(path.join(os.tmpdir(),'umh-x-'));t.after(()=>rm(root,{recursive:true,force:true}));const events=[];const paths={dataRoot:root,downloadRoot:path.join(root,'media'),engineRoot,browserExecutable};return {root,events,ctx:{paths,request:{source:{platform:'x',kind:'single',url:'https://x.com/a/status/1234567890123456789',...source},items:[]},signal:new AbortController().signal,emit:async(type,payload)=>events.push({type,...payload})}};}
async function fixture(t,ctx,mode='authenticated'){
 const browser=await openBrowser(ctx.paths,'x',{headless:true,signal:ctx.signal});t.after(()=>browser.close());
 await browser.addCookies([{name:'auth_token',value:'SYNTHETIC_AUTH',domain:'.x.com',path:'/',secure:true},{name:'twid',value:'u%3D9007199254740993',domain:'.x.com',path:'/',secure:true}]);
 await browser.route('**/*',async route=>{
  if(new URL(route.request().url()).pathname.includes('/Viewer'))return route.fulfill({contentType:'application/json',body:'{"data":{"viewer":{"user_results":{"result":{"rest_id":"9007199254740993","legacy":{"screen_name":"fixture"}}}}}}'});
  return route.fulfill({contentType:'text/html',body:mode==='authenticated'?'<button data-testid="SideNav_AccountSwitcher_Button">Fixture</button><script>fetch("/i/api/graphql/fixture/Viewer")</script>':'<a href="/i/flow/login">Log in</a>'});
 });return browser;
}
test('X private identity requires fresh authenticated account response and stale cookie alone fails',async t=>{
 assert.equal(typeof x.verifyXAccount,'function');
 for(const mode of ['authenticated','loggedout']){
  const {ctx}=await setup(t,{kind:'saved',url:'https://x.com/i/bookmarks'});const browser=await fixture(t,ctx,mode);const page=browser.pages()[0];
  if(mode==='authenticated'){const a=await x.verifyXAccount(page,browser,ctx,{timeoutMs:1000});assert.equal(a.accountId,'9007199254740993');ctx.request.source.accountId='123';await assert.rejects(x.verifyXAccount(page,browser,ctx,{timeoutMs:1000}),/differs/);}
  else await assert.rejects(x.verifyXAccount(page,browser,ctx,{timeoutMs:300}),/identity|Sign in/);
  await browser.close();
 }
});
test('X shortlinks stop before off-platform hops and preserve recognized photo suffix intent',async()=>{
 assert.equal(typeof x.resolveXShortlink,'function');let calls=[];
 const fetchImpl=async u=>{calls.push(String(u));return new Response(null,{status:302,headers:{location:'https://evil.example/steal'}});};
 await assert.rejects(x.resolveXShortlink({url:'https://t.co/fixture',kind:'single'},{fetchImpl}),/allowed platform/);assert.equal(calls.length,1);
 const source=await x.resolveXShortlink({url:'https://t.co/fixture',kind:'single'},{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://mobile.twitter.com/a/status/1234567890123456789/photo/2'}})});
 assert.equal(source.url,'https://mobile.twitter.com/a/status/1234567890123456789/photo/2');
 await assert.rejects(x.resolveXShortlink({url:'https://t.co/f',kind:'single'},{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://x.com/profile'}})}),/requested source/);
});
test('X temporary cookie file is filtered and deleted after extraction failure',async t=>{
 assert.equal(typeof x.xAdapter,'function');const {ctx,root,events}=await setup(t);let cookiePath,closed=false;
 const a=x.xAdapter({open:async()=>({cookies:async()=>[{name:'auth_token',value:'SYNTHETIC_SECRET',domain:'.x.com',path:'/',secure:true,expires:-1},{name:'unrelated',value:'DO_NOT_EXPORT',domain:'.evil.example',path:'/'}],close:async()=>{closed=true;}}),session:async(ctx,p,fn)=>fn({work:root,write:async(name,text)=>{const file=path.join(root,name);await writeFile(file,text);return file;},run:async args=>{cookiePath=args[args.indexOf('--cookies')+1];const data=await readFile(cookiePath,'utf8');assert.equal(data.includes('SYNTHETIC_SECRET'),true);assert.equal(data.includes('DO_NOT_EXPORT'),false);throw new Error('fixture_failure');}})});
 await assert.rejects(a.scan(ctx),/fixture_failure/);assert.equal(closed,true);await assert.rejects(readFile(cookiePath),{code:'ENOENT'});assert.equal(JSON.stringify(events).includes('SYNTHETIC_SECRET'),false);
});
test('X refresh preserves explicit video-only index selection and emits resolved item before receipt',async t=>{
 assert.equal(typeof x.xAdapter,'function');const {ctx,root,events}=await setup(t);let transfers=[];
 ctx.request.items=[{key:'x:1234567890123456789',platform:'x',contentId:'1234567890123456789',sourceUrl:'https://x.com/i/status/1234567890123456789',selected:true,mediaResolved:true,media:[{index:2,kind:'video',extension:'mp4'}]}];
 const manifest='[[3,"https://pbs.twimg.com/a.jpg",{"tweet_id":1234567890123456789,"num":1,"extension":"jpg"}],[3,"https://video.twimg.com/a.mp4",{"tweet_id":1234567890123456789,"num":2,"extension":"mp4"}]]';
 const a=x.xAdapter({open:async()=>({cookies:async()=>[],close:async()=>{}}),session:async(ctx,p,fn)=>fn({work:root,write:async(name,text)=>{const file=path.join(root,name);await writeFile(file,text);return file;},run:async()=>({stdout:manifest})}),transfer:async({item,asset})=>{transfers.push(asset.index);return {contentKey:item.key,mediaIndex:asset.index,status:'completed'};}});
 await a.download(ctx);assert.deepEqual(transfers,[2]);assert.equal(events[0].type,'item');assert.deepEqual(events[0].item.media.map(m=>m.index),[2]);assert.equal(events[1].type,'receipt');
});
test('X unsafe redirect is emitted as needs_action by scan without opening browser',async t=>{
 const {ctx,events}=await setup(t,{url:'https://t.co/fixture'});let opened=false;
 const {ActionRequired}=await import('../src/shared/source-resolution.mjs');
 const a=x.xAdapter({open:async()=>{opened=true;throw new Error('must_not_open');},resolve:async()=>{throw new ActionRequired('input_required','The short link left its allowed platform.');}});
 assert.equal((await a.scan(ctx)).status,'needs_action');assert.equal(opened,false);assert.equal(events[0].type,'needs_action');
});
test('X all-source scan supplies finite engine enumeration bound and retains partial completeness',async t=>{
 const {ctx,root}=await setup(t,{kind:'profile',url:'https://x.com/fixture',maxItems:0});let args;
 const a=x.xAdapter({open:async()=>({cookies:async()=>[],close:async()=>{}}),session:async(ctx,p,fn)=>fn({write:async(name,text)=>{const file=path.join(root,name);await writeFile(file,text);return file;},run:async a=>{args=a;return {stdout:'[]'};}})});
 const result=await a.scan(ctx);assert.equal(args[args.indexOf('--range')+1],'1-10001');assert.equal(result.completeness,'partial');
});
test('X identity ignores service-worker-only account observations even when cookies and UI match',async t=>{
 const {ctx}=await setup(t,{kind:'saved',url:'https://x.com/i/bookmarks'});
 const {EventEmitter}=await import('node:events');
 const page=new EventEmitter();page.goto=async()=>page.emit('response',{url:()=> 'https://x.com/i/api/graphql/fixture/Viewer',ok:()=>true,headers:()=>({}),fromServiceWorker:()=>true,text:async()=>'{"data":{"viewer":{"user_results":{"result":{"rest_id":"9007199254740993"}}}}}'});page.waitForTimeout=ms=>new Promise(r=>setTimeout(r,ms));page.evaluate=async()=>({account:true,blocked:false,limited:false});page.context=()=>({newCDPSession:async()=>({send:async()=>{},detach:async()=>{}})});
 const browser={cookies:async()=>[{name:'auth_token',value:'fixture',domain:'.x.com'},{name:'twid',value:'u%3D9007199254740993',domain:'.x.com'}]};
 await assert.rejects(x.verifyXAccount(page,browser,ctx,{timeoutMs:100}),/identity|Sign in/);
});
test('X identity response body has a finite wait when platform response never finishes',async t=>{
 const {ctx}=await setup(t,{kind:'saved',url:'https://x.com/i/bookmarks'});const {EventEmitter}=await import('node:events');
 const page=new EventEmitter();page.goto=async()=>page.emit('response',{url:()=> 'https://x.com/i/api/graphql/fixture/Viewer',ok:()=>true,headers:()=>({}),fromServiceWorker:()=>false,text:async()=>new Promise(()=>{})});page.waitForTimeout=ms=>new Promise(r=>setTimeout(r,ms));page.evaluate=async()=>({account:true,blocked:false,limited:false});page.context=()=>({newCDPSession:async()=>({send:async()=>{},detach:async()=>{}})});
 page.mainFrame=()=>page;let bodies=0;
 page.goto=async()=>{
  const request={frame:()=>page,method:()=> 'GET',isNavigationRequest:()=>false,serviceWorker:()=>null};
  page.emit('request',{...request,isNavigationRequest:()=>true});page.emit('request',request);
  page.emit('response',{frame:()=>page,request:()=>request,url:()=> 'https://x.com/i/api/graphql/fixture/Viewer',ok:()=>true,headers:()=>({}),fromServiceWorker:()=>false,text:async()=>{bodies++;return new Promise(()=>{});}});
 };
 const result=await Promise.race([x.verifyXAccount(page,{cookies:async()=>[]},ctx,{timeoutMs:100}).then(()=> 'accepted',()=> 'rejected'),new Promise(r=>setTimeout(()=>r('hung'),500))]);assert.equal(result,'rejected');assert.equal(bodies,1);
});
test('X extraction rate barrier on a zero exit cannot become completed empty scan',async t=>{
 const {ctx,root,events}=await setup(t,{kind:'profile',url:'https://x.com/fixture'});
 const a=x.xAdapter({open:async()=>({cookies:async()=>[],close:async()=>{}}),session:async(ctx,p,fn)=>fn({write:async(name,text)=>{const file=path.join(root,name);await writeFile(file,text);return file;},run:async()=>({stdout:'[]',stderr:'[twitter][error] rate limit SYNTHETIC_SECRET'})})});
 assert.equal((await a.scan(ctx)).status,'needs_action');assert.equal(events[0].code,'rate_limited');assert.equal(JSON.stringify(events).includes('SYNTHETIC_SECRET'),false);
});
test('X account event names the account by its handle when the handle is valid',()=>{
 assert.deepEqual(x.xName({accountId:'1',screenName:'fixture_1'}),{displayName:'fixture_1'});
 for(const screenName of [undefined,'','a b','x'.repeat(16),'名字'])assert.deepEqual(x.xName({accountId:'1',screenName}),{});
});
