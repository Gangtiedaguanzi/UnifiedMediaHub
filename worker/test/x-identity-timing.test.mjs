import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {verifyXAccount,X_IDENTITY_TIMEOUT_MS,X_SIDEBAR_TIMEOUT_MS} from '../src/adapters/x.mjs';
const account='9007199254740993';
// Synthetic slow page: the Viewer response arrives after viewerMs; the sidebar
// renders after sidebarMs; optionally the page turns into a challenge after blockedMs.
async function verify({viewerMs=0,sidebarMs=0,blockedMs,timeoutMs,sidebarTimeoutMs}){
 const page=new EventEmitter(),frame={},logged=[],started=Date.now();
 const ctx={request:{source:{platform:'x',kind:'saved',url:'https://x.com/i/bookmarks'}},signal:new AbortController().signal,diagnostics:{add:e=>logged.push(e)}};
 const req={frame:()=>frame,method:()=> 'GET',isNavigationRequest:()=>false,serviceWorker:()=>null};
 const response={frame:()=>frame,request:()=>req,url:()=> 'https://x.com/i/api/graphql/fixture/Viewer',fromServiceWorker:()=>false,ok:()=>true,headers:()=>({}),text:async()=>JSON.stringify({data:{viewer:{user_results:{result:{rest_id:account}}}}})};
 page.mainFrame=()=>frame;page.waitForTimeout=ms=>new Promise(r=>setTimeout(r,ms));
 page.evaluate=async()=>{const t=Date.now()-started;return {account:t>=sidebarMs,blocked:blockedMs!==undefined&&t>=blockedMs,limited:false};};
 page.context=()=>({newCDPSession:async()=>({send:async()=>{},detach:async()=>{}})});
 page.goto=async()=>{
  page.emit('request',{...req,isNavigationRequest:()=>true,url:()=> 'https://x.com/home'});page.emit('request',req);
  setTimeout(()=>page.emit('response',response),viewerMs);
 };
 const browser={cookies:async()=>[{name:'auth_token',value:'SYNTHETIC',domain:'.x.com'},{name:'twid',value:`u%3D${account}`,domain:'.x.com'}]};
 try{return {account:await verifyXAccount(page,browser,ctx,{timeoutMs,sidebarTimeoutMs}),logged,elapsed:Date.now()-started};}
 catch(error){return {error,logged,elapsed:Date.now()-started};}
}
test('X identity waits long enough for a slow network by default',()=>{
 assert.equal(X_IDENTITY_TIMEOUT_MS,30000);assert.equal(X_SIDEBAR_TIMEOUT_MS,15000);
});
test('a Viewer response after the old 6 s window still verifies within the identity timeout (scaled)',async()=>{
 const r=await verify({viewerMs:300,timeoutMs:1000,sidebarTimeoutMs:500});
 assert.equal(r.account?.accountId,account,String(r.error));
});
test('no Viewer within the identity timeout fails with an xVerify no_viewer diagnostic',async()=>{
 const r=await verify({viewerMs:600,timeoutMs:100,sidebarTimeoutMs:500});
 assert.equal(r.error?.code,'auth_required');assert.deepEqual(r.logged.filter(e=>e.xVerify),[{xVerify:'no_viewer'}]);
});
test('identity verifies when the sidebar renders after the Viewer response',async()=>{
 const r=await verify({viewerMs:0,sidebarMs:300,timeoutMs:1000,sidebarTimeoutMs:1000});
 assert.equal(r.account?.accountId,account,String(r.error));
});
test('a sidebar that never renders fails as ui_missing after the sidebar timeout',async()=>{
 const r=await verify({viewerMs:0,sidebarMs:60000,timeoutMs:1000,sidebarTimeoutMs:200});
 assert.equal(r.error?.code,'auth_required');assert.deepEqual(r.logged.filter(e=>e.xVerify),[{xVerify:'ui_missing'}]);
});
test('a challenge page during the sidebar wait fails at once as blocked',async()=>{
 const r=await verify({viewerMs:0,sidebarMs:60000,blockedMs:100,timeoutMs:1000,sidebarTimeoutMs:5000});
 assert.equal(r.error?.code,'auth_required');assert.deepEqual(r.logged.filter(e=>e.xVerify),[{xVerify:'blocked'}]);
 assert.ok(r.elapsed<2000,`waited ${r.elapsed} ms instead of failing at the challenge`);
});
// X stopped requesting Viewer on /home (observed 2026-11-16); the fresh home document
// embeds the account in window.__INITIAL_STATE__ (session.user_id + entities.users).
import {initialStateIdentity} from '../src/adapters/x.mjs';
const stateHtml=(state,tail='')=>`<html><script>window.__INITIAL_STATE__=${JSON.stringify(state)};window.__META_DATA__={"x":"}{"};</script>${tail}</html>`;
const goodState={session:{user_id:account,isLoaded:true},entities:{users:{entities:{[account]:{id_str:account,screen_name:'fixture_name'}}}}};
test('home document state yields the session account when entities agree',()=>{
 assert.deepEqual(initialStateIdentity(stateHtml(goodState)),{accountId:account,screenName:'fixture_name'});
 assert.deepEqual(initialStateIdentity(stateHtml(goodState,'<script>var s="}{\\"session\\""</script>')),{accountId:account,screenName:'fixture_name'});
});
for(const [name,state] of [
 ['no session',{entities:goodState.entities}],
 ['guest session',{session:{guestId:'1'},entities:goodState.entities}],
 ['entity mismatch',{...goodState,entities:{users:{entities:{[account]:{id_str:'123'}}}}}],
 ['missing entity',{...goodState,entities:{users:{entities:{}}}}],
 ['non-decimal id',{...goodState,session:{user_id:'u'+account}}],
])test(`home document state is rejected: ${name}`,()=>assert.equal(initialStateIdentity(stateHtml(state)),null));
test('a page without embedded state yields no identity',()=>assert.equal(initialStateIdentity('<html></html>'),null));
async function verifyDocument({state=goodState,path='/home',secondNavigation=false,fromServiceWorker=false}={}){
 const page=new EventEmitter(),frame={},logged=[];
 const ctx={request:{source:{platform:'x',kind:'saved',url:'https://x.com/i/bookmarks'}},signal:new AbortController().signal,diagnostics:{add:e=>logged.push(e)}};
 const nav={frame:()=>frame,method:()=> 'GET',isNavigationRequest:()=>true,serviceWorker:()=>null,url:()=>`https://x.com${path}`};
 page.mainFrame=()=>frame;page.waitForTimeout=ms=>new Promise(r=>setTimeout(r,ms));
 page.evaluate=async()=>({account:true,blocked:false,limited:false});
 page.context=()=>({newCDPSession:async()=>({send:async()=>{},detach:async()=>{}})});
 page.goto=async()=>{
  page.emit('request',nav);
  page.emit('response',{frame:()=>frame,request:()=>nav,url:()=>`https://x.com${path}`,fromServiceWorker:()=>fromServiceWorker,ok:()=>true,headers:()=>({}),text:async()=>stateHtml(state)});
  if(secondNavigation)page.emit('request',{...nav});
 };
 const browser={cookies:async()=>[{name:'auth_token',value:'SYNTHETIC',domain:'.x.com'},{name:'twid',value:`u%3D${account}`,domain:'.x.com'}]};
 try{return {account:await verifyXAccount(page,browser,ctx,{timeoutMs:300,sidebarTimeoutMs:300}),logged};}catch(error){return {error,logged};}
}
test('identity verifies from the fresh home document alone',async()=>{
 const r=await verifyDocument();assert.equal(r.account?.accountId,account,String(r.error));assert.equal(r.account.screenName,'fixture_name');
});
for(const [name,options] of [['another path',{path:'/explore'}],['service worker document',{fromServiceWorker:true}],['second navigation',{secondNavigation:true}]])test(`home document identity is not accepted from ${name}`,async()=>{
 const r=await verifyDocument(options);assert.equal(r.error?.code,'auth_required');
});
