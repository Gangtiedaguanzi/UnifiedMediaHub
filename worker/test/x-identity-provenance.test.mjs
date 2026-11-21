import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {verifyXAccount} from '../src/adapters/x.mjs';
const account='9007199254740993';
async function verify(mode){
 const page=new EventEmitter(),frame={},ctx={request:{source:{platform:'x',kind:'saved',url:'https://x.com/i/bookmarks'}},signal:new AbortController().signal};
 const request=(patch={})=>({frame:()=>frame,method:()=> 'GET',isNavigationRequest:()=>false,serviceWorker:()=>null,...patch});
 const req=request({method:()=>mode==='delete'?'DELETE':mode==='post'?'POST':'GET',frame:()=>mode==='subframe'?{}:frame});
 const url=mode==='http'?'http://x.com/i/api/graphql/fixture/Viewer':'https://x.com/i/api/graphql/fixture/Viewer';
 const response={frame:()=>req.frame(),request:()=>req,url:()=>url,fromServiceWorker:()=>false,ok:()=>true,headers:()=>({}),text:async()=>JSON.stringify({data:{viewer:{user_results:{result:{rest_id:account}}}}})};
 page.mainFrame=()=>frame;page.waitForTimeout=ms=>new Promise(r=>setTimeout(r,ms));page.evaluate=async()=>({account:true,blocked:false,limited:false});
 page.context=()=>({newCDPSession:async()=>({send:async method=>{if(mode==='pre-navigation'&&method==='Network.enable'){page.emit('request',req);page.emit('response',response);}if(mode==='old-request'&&method==='Network.enable')page.emit('request',req);},detach:async()=>{}})});
 page.goto=async()=>{
  page.emit('request',request({isNavigationRequest:()=>true,url:()=> 'https://x.com/home'}));
  if(!['pre-navigation','old-request','untracked'].includes(mode))page.emit('request',req);
  if(mode!=='pre-navigation')page.emit('response',response);
  if(mode==='second-navigation')page.emit('request',request({isNavigationRequest:()=>true,url:()=> 'https://x.com/home'}));
 };
 const browser={cookies:async()=>[{name:'auth_token',value:'SYNTHETIC',domain:'.x.com'},{name:'twid',value:`u%3D${mode==='cookie-mismatch'?'123':account}`,domain:'.x.com'}]};
 try{return await verifyXAccount(page,browser,ctx,{timeoutMs:60});}
 finally{assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('response'),0);}
}
for(const mode of ['subframe','http','pre-navigation','old-request','untracked','delete','second-navigation','cookie-mismatch'])test(`X identity rejects ${mode} provenance`,async()=>{
 await assert.rejects(verify(mode),e=>e.code==='auth_required');
});
for(const mode of ['get','post'])test(`X identity accepts a tracked main-frame HTTPS ${mode} request from the first document`,async()=>{
 assert.equal((await verify(mode)).accountId,account);
});
