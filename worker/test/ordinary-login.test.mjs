import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {xAdapter} from '../src/adapters/x.mjs';
import {Controls} from '../src/shared/protocol.mjs';
import {xLoginPage} from './fixtures/x-login-page.mjs';

for(const end of ['finish','self-close','cancel'])test(`X ordinary login precedes controlled verification: ${end}`,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-ordinary-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const controls=new Controls(),abort=new AbortController(),events=[],order=[],ready=Promise.withResolvers(),exited=Promise.withResolvers(),fixture=xLoginPage();
 const ctx={paths:{dataRoot:root},request:{source:{platform:'x',kind:'profile',url:'https://x.com/'}},controls,signal:abort.signal,emit:async(type,data)=>{events.push({type,...data});if(type==='needs_action')ready.resolve();}};
 const adapter=xAdapter({ordinary:async(ctx,verify)=>{
  order.push('ordinary');const waiting=ctx.controls.waitFor('finish-login',ctx.signal);
  void waiting.catch(()=>{});await ctx.emit('needs_action',{code:'auth_required',awaitingInput:true});
  await Promise.race([waiting.then(()=>order.push('WM_CLOSE')),exited.promise]);ctx.signal.throwIfAborted();order.push('exit');return verify({lease:'fixture'});
 },open:async(_paths,_platform,options)=>{order.push('verify-open');assert.deepEqual(options.profileLease,{lease:'fixture'});return fixture.browser;}});
 const running=adapter.login(ctx);const observed=running.then(value=>({value}),error=>({error}));
 try{
  const first=await Promise.race([ready.promise.then(()=> 'ready'),observed.then(()=> 'premature-open')]);assert.equal(first,'ready','controlled browser opened before ordinary login');assert.deepEqual(order,['ordinary']);assert.deepEqual(fixture.navigations,[]);
  controls.push({command:'continue'});await new Promise(r=>setTimeout(r,10));assert.deepEqual(order,['ordinary']);
  if(end==='finish')controls.push({command:'finish-login'});else if(end==='self-close')exited.resolve();else abort.abort(new Error('synthetic-cancel'));
  const result=await observed;
  if(end==='cancel'){assert.match(result.error?.message??'',/synthetic-cancel/);assert.equal(events.some(e=>e.type==='account'),false);}
  else {assert.equal(result.value.status,'completed');assert.deepEqual(order,end==='finish'?['ordinary','WM_CLOSE','exit','verify-open']:['ordinary','exit','verify-open']);assert.deepEqual(fixture.navigations,['https://x.com/home']);assert.equal(events.find(e=>e.type==='account').accountId,'9007199254740993');assert.equal(fixture.closed,true);}
 }finally{abort.abort();exited.resolve();await observed;controls.close();}
});

test('X failed verification remains auth_required and closes verifier',async()=>{
 const fixture=xLoginPage(),events=[];fixture.browser.pages()[0].evaluate=async()=>({account:false,blocked:true,limited:false});
 const ctx={paths:{},request:{source:{}},signal:new AbortController().signal,emit:async(type,data)=>events.push({type,...data})};
 const result=await xAdapter({ordinary:async(_ctx,verify)=>verify({}),open:async()=>fixture.browser}).login(ctx);
 assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'auth_required');assert.equal(events.some(e=>e.type==='account'),false);assert.equal(fixture.closed,true);
});
