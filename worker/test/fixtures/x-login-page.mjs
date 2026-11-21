import {EventEmitter} from 'node:events';
export async function xLoginOrdinary(ctx,verify){
 const waiting=ctx.controls.waitFor('finish-login',ctx.signal);void waiting.catch(()=>{});
 await ctx.emit('needs_action',{code:'auth_required',awaitingInput:true});
 await waiting;ctx.signal.throwIfAborted();return verify();
}
// No sockets/browser/network: fixture page for the real X adapter's login flow.
export function xLoginPage() {
  const page=new EventEmitter(),navigations=[];let closed=false;
  page.mainFrame=()=>page;
  page.goto=async url=>{
    navigations.push(url);
    const request={frame:()=>page,method:()=> 'GET',isNavigationRequest:()=>false,serviceWorker:()=>null};
    page.emit('request',{...request,isNavigationRequest:()=>true,url:()=>url});
    if(url==='https://x.com/home'){page.emit('request',request);page.emit('response',{
      frame:()=>page,request:()=>request,
      url:()=> 'https://x.com/i/api/graphql/fixture/Viewer',ok:()=>true,headers:()=>({}),fromServiceWorker:()=>false,
      text:async()=>'{"data":{"viewer":{"user_results":{"result":{"rest_id":"9007199254740993","legacy":{"screen_name":"fixture"}}}}}}',
    });}
  };
  page.waitForTimeout=async()=>{};
  page.evaluate=async()=>({account:true,blocked:false,limited:false});
  page.context=()=>({newCDPSession:async()=>({send:async()=>{},detach:async()=>{}})});
  const browser=Object.assign(new EventEmitter(),{pages:()=>[page],cookies:async()=>[{name:'auth_token',value:'SYNTHETIC',domain:'.x.com'},{name:'twid',value:'u%3D9007199254740993',domain:'.x.com'}],close:async()=>{closed=true;}});
  return {browser,navigations,get closed(){return closed;}};
}
