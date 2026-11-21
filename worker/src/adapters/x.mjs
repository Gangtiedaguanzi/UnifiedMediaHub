import {ordinaryLogin} from '../shared/ordinary-login.mjs';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openBrowser } from '../shared/browser.mjs';
import { withEngineSession, engineAction, engineFailure } from '../shared/engines.mjs';
import { xSource, galleryItems, decimal } from '../shared/engine-media.mjs';
import { parseLossless } from '../shared/json.mjs';
import { ActionRequired } from '../shared/source-resolution.mjs';
import { applyMediaSelection } from '../shared/selection.mjs';
import { downloadAsset } from '../shared/download.mjs';

const hosts=['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com'];
function allowed(u){return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&[...hosts,'t.co'].includes(u.hostname);}
export async function resolveXShortlink(source,{signal,fetchImpl=fetch}={}){
  let current=new URL(source.url);
  if(current.hostname!=='t.co')return source;
  const deadline=AbortSignal.timeout(15000),combined=signal?AbortSignal.any([signal,deadline]):deadline;
  for(let hop=0;hop<5;hop++){
    if(!allowed(current))throw new ActionRequired('input_required','The short link left its allowed platform.');
    if(current.hostname!=='t.co'){
      try{if(!['single','profile'].includes(source.kind))throw new Error();xSource({...source,url:current.href});}catch{throw new ActionRequired('input_required','The short link did not match the requested source type.');}
      return {...source,url:current.href};
    }
    const response=await fetchImpl(current,{signal:combined,redirect:'manual',credentials:'omit',headers:{}});
    await response.body?.cancel();
    if(![301,302,303,307,308].includes(response.status)||!response.headers.get('location'))throw new ActionRequired('input_required','The short link did not provide a supported redirect.');
    current=new URL(response.headers.get('location'),current);
    if(!allowed(current))throw new ActionRequired('input_required','The short link left its allowed platform.');
  }
  throw new ActionRequired('input_required','The short link exceeded its finite redirect limit.');
}
function cookieAccount(cookies){
  const values=new Set();
  for(const c of cookies){
    const domain=c.domain?.replace(/^\./,'');
    if(c.name!=='twid'||!hosts.includes(domain))continue;
    let value;try{value=decodeURIComponent(c.value);}catch{continue;}
    const m=/^u=(\d+)$/.exec(value);
    if(m)values.add(decimal(m[1],18446744073709551615n,'invalid_identity'));
  }
  return values.size===1?[...values][0]:null;
}
// X's home document embeds the signed-in account in window.__INITIAL_STATE__: session.user_id,
// confirmed by the same ID under entities.users. Returns null for guest, partial or inconsistent state.
export function initialStateIdentity(html){
  const marker='window.__INITIAL_STATE__=',start=typeof html==='string'?html.indexOf(marker):-1;
  if(start<0)return null;
  let i=start+marker.length;while(html[i]===' ')i++;
  if(html[i]!=='{')return null;
  let depth=0,inString=false,escaped=false,end=-1;
  for(let j=i;j<html.length;j++){
    const c=html[j];
    if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue;}
    if(c==='"')inString=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=j+1;break;}
  }
  if(end<0)return null;
  try{
    const state=parseLossless(html.slice(i,end)),id=state?.session?.user_id;
    if(typeof id!=='string'||!/^\d{1,20}$/.test(id))return null;
    const accountId=decimal(id,18446744073709551615n,'invalid_identity'),user=state.entities?.users?.entities?.[id];
    if(!user||user.id_str!==accountId)return null;
    return {accountId,screenName:typeof user.screen_name==='string'?user.screen_name:undefined};
  }catch{return null;}
}
// A proxied first load of x.com/home with the cache disabled can take well over
// 6 s before the Viewer request; the sidebar may render after that response.
export const X_IDENTITY_TIMEOUT_MS=30000,X_SIDEBAR_TIMEOUT_MS=15000;
export async function verifyXAccount(page,browser,ctx,{timeoutMs=X_IDENTITY_TIMEOUT_MS,sidebarTimeoutMs=X_SIDEBAR_TIMEOUT_MS}={}){
  let observed,invalid=false,navigationRequests=0;const pending=new Set(),requests=new WeakSet();
  const fail=(reason,code='auth_required',message='The current X account identity could not be verified. Sign in manually and rescan.')=>{ctx.diagnostics?.add({xVerify:reason});return new ActionRequired(code,message);};
  const wire=await page.context().newCDPSession(page);
  const started=req=>{try{
    if(req.frame()!==page.mainFrame())return;
    if(req.isNavigationRequest?.())navigationRequests++;
    if(navigationRequests===1&&['GET','POST'].includes(req.method())&&!req.serviceWorker?.())requests.add(req);
  }catch{}};
  const response=async r=>{
    let u;try{
      u=new URL(r.url());
      if(r.fromServiceWorker?.()||r.frame()!==page.mainFrame()||!requests.has(r.request())||navigationRequests!==1||!['GET','POST'].includes(r.request().method())||u.protocol!=='https:'||u.username||u.password||u.port)return;
    }catch{return;}
    // The home document itself (the one tracked navigation) or an API identity response.
    const homeDocument=r.request().isNavigationRequest?.()&&u.pathname==='/home';
    if(!hosts.includes(u.hostname) || !(homeDocument||/^\/i\/api\/graphql\/[^/]+\/Viewer$/.test(u.pathname)||/^\/(?:i\/api\/)?1\.1\/account\/verify_credentials\.json$/.test(u.pathname)) || !r.ok())return;
    const limit=homeDocument?8*1024*1024:1024*1024;
    const length=Number(r.headers()['content-length']??0);if(length>limit)return;
    let timer,abortBody;
    try{
      const boundary=new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('identity_response_timeout')),Math.min(timeoutMs,10000));
        abortBody=()=>reject(new Error('cancelled'));
        ctx.signal?.addEventListener('abort',abortBody,{once:true});
      });
      const body=await Promise.race([r.text(),boundary]);if(Buffer.byteLength(body)>limit)return;
      let id,screenName;
      if(homeDocument){const state=initialStateIdentity(body);if(!state)return;({accountId:id,screenName}=state);}
      else{
        const data=parseLossless(body);
        const user=u.pathname.endsWith('/Viewer')?data.data?.viewer?.user_results?.result:data;
        id=decimal(user?.rest_id??user?.id_str??user?.id,18446744073709551615n,'invalid_identity');
        screenName=typeof user.legacy?.screen_name==='string'?user.legacy.screen_name:typeof user.screen_name==='string'?user.screen_name:undefined;
      }
      if(observed && observed.accountId!==id)invalid=true;
      observed={platform:'x',authenticated:true,accountId:id,screenName};
    }catch{}finally{clearTimeout(timer);ctx.signal?.removeEventListener('abort',abortBody);}
  };
  const handler=r=>{const work=response(r);pending.add(work);void work.finally(()=>pending.delete(work));};
  page.on('request',started);page.on('response',handler);
  try{
    await wire.send('Network.enable');
    await wire.send('Network.setCacheDisabled',{cacheDisabled:true});
    await wire.send('Network.setBypassServiceWorker',{bypass:true});
    // Cache stays disabled so the Viewer proof is a fresh server response, never a cached one.
    await page.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:30000});
    const deadline=Date.now()+timeoutMs;
    while(!observed && Date.now()<deadline){ctx.signal?.throwIfAborted();await page.waitForTimeout(50);}
    await Promise.all([...pending]);
    ctx.signal?.throwIfAborted();
    const readUi=()=>page.evaluate(()=>({account:!!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'),blocked:/\/flow\/login|\/account\/access|\/challenge/.test(location.pathname),limited:/rate limit|too many requests/i.test(document.body?.innerText?.slice(0,20000)??'')}));
    let ui=await readUi();
    // Wait for the sidebar only after a Viewer proof; a challenge or rate limit ends the wait at once.
    const sidebarDeadline=Date.now()+sidebarTimeoutMs;
    while(observed&&!ui.account&&!ui.blocked&&!ui.limited&&Date.now()<sidebarDeadline){ctx.signal?.throwIfAborted();await page.waitForTimeout(100);ui=await readUi();}
    ctx.signal?.throwIfAborted();
    if(ui.limited)throw fail('rate_limited','rate_limited','X requires manual action after a rate limit.');
    const cookies=await browser.cookies(['https://x.com/','https://twitter.com/']);
    const id=cookieAccount(cookies),auth=cookies.some(c=>c.name==='auth_token'&&c.value&&hosts.includes(c.domain?.replace(/^\./,'')));
    ctx.signal?.throwIfAborted();
    if(ui.blocked)throw fail('blocked');
    if(!observed)throw fail('no_viewer');
    if(invalid)throw fail('viewer_conflict');
    if(navigationRequests!==1)throw fail('navigation_count');
    if(!ui.account)throw fail('ui_missing');
    if(!auth)throw fail('cookie_missing');
    if(id!==observed.accountId)throw fail('cookie_mismatch');
    if(ctx.request.source.accountId && ctx.request.source.accountId!==id)throw fail('binding_mismatch','auth_required','The current X account differs from this source binding. The source was not rebound.');
    return observed;
  }finally{page.off('request',started);page.off('response',handler);await wire.detach().catch(()=>{});}
}
function cookieFile(cookies){
  const lines=['# Netscape HTTP Cookie File'];
  for(const c of cookies){
    const domain=c.domain?.replace(/^\./,'');
    if(!hosts.includes(domain)||[c.domain,c.path,c.name,c.value].some(v=>typeof v!=='string'||/[\x00-\x20\x7f]/.test(v)))continue;
    if(c.expires>0&&c.expires<=Date.now()/1000)continue;
    lines.push([`${c.httpOnly?'#HttpOnly_':''}${c.domain}`,c.domain.startsWith('.')?'TRUE':'FALSE',c.path||'/',c.secure?'TRUE':'FALSE',c.expires>0?Math.floor(c.expires):0,c.name,c.value].join('\t'));
  }
  return lines.join('\n')+'\n';
}
const extractorArgs=['--config-ignore','--no-colors','--retries','2','-o','extractor.timeout=30','-o','extractor.twitter.ratelimit=abort','-o','extractor.twitter.text-tweets=false','-o','extractor.twitter.cards=false','-o','extractor.twitter.retweets=false','-o','extractor.twitter.previews=false','-o','extractor.twitter.timeline.strategy=media'];
export function xEngineReason({items,errors,queued}){
  if(errors.some(e=>/rate limit/i.test(e.message)))return {code:'rate_limited'};
  if(errors.some(e=>['AuthRequired','AuthorizationError'].includes(e.type)&&/NSFW/.test(e.message)))return {code:'sensitive_content'};
  if(errors.some(e=>['AuthRequired','AuthorizationError','AuthenticationError'].includes(e.type)))return {code:'auth_required'};
  if(errors.some(e=>e.type==='NotFoundError'||/Tweet unavailable/.test(e.message)))return {code:'work_unavailable'};
  if(errors.length)return {code:'input_required'};
  if(!items.length&&queued>0)return {code:'embedded_unsupported'};
  return null;
}
// The handle names the account in the app and in one-folder-per-task download folders.
export const xName=account=>typeof account?.screenName==='string'&&/^[A-Za-z0-9_]{1,15}$/.test(account.screenName)?{displayName:account.screenName}:{};
export function xAdapter({open=openBrowser,ordinary=ordinaryLogin,session=withEngineSession,transfer=downloadAsset,resolve=resolveXShortlink}={}){
  const privateSource=s=>['saved','liked'].includes(s.kind)||!!s.accountId;
  async function using(ctx,fn){
    return engineAction(ctx,()=>session(ctx,'x',async s=>{
      let browser,cookiePath;
      try{
        browser=await open(ctx.paths,'x',{signal:ctx.signal});
        let account;
        if(privateSource(ctx.request.source)){
          const page=browser.pages()[0]??await browser.newPage();account=await verifyXAccount(page,browser,ctx);await ctx.emit('account',{platform:'x',authenticated:true,accountId:account.accountId,...xName(account)});
        }
        const cookies=await browser.cookies(['https://x.com/','https://twitter.com/']);
        cookiePath=await s.write(`cookies-${randomUUID()}.txt`,cookieFile(cookies));
        return await fn(s,cookiePath,cookies,account);
      }finally{
        try{await browser?.close();}finally{if(cookiePath)await rm(cookiePath,{force:true});}
      }
    }));
  }
  async function extract(s,cookiePath,source,account,diagnostics){
    const target=xSource(source,account?.accountId,account?.screenName);
    const args=[...extractorArgs,'--cookies',cookiePath];
    const count=source.kind==='single'?1:Math.min(source.maxItems||10000,10000)+1;
    if(source.kind!=='single')args.push('--range',`1-${count}`);
    args.push('--dump-json',target.url);
    // Time and output grow with the requested count (thousands of likes/bookmarks), instead of a fixed 2 min/16 MiB.
    const r=await s.run(args,{timeoutMs:Math.min(1800000,120000+count*120),maxOutput:Math.min(256*1024*1024,Math.max(16*1024*1024,count*24*1024))});
    const barrier=engineFailure('',r.stderr??'');
    if(['rate_limited','unauthorized'].includes(barrier.engineCode))throw barrier;
    let {items,errors,queued,skipped}=galleryItems(r.stdout);
    if(skipped.length)diagnostics?.add({unsupportedMedia:skipped.length,unsupportedExt:skipped[0]});
    if(target.contentId)items=items.filter(i=>i.contentId===target.contentId);
    if(target.mediaIndex&&items.length){
      const item=items[0];if(!item?.media.some(m=>m.index===target.mediaIndex&&m.kind===target.mediaKind))throw new ActionRequired('input_required','The requested X photo/video index was not returned.');
      items=[{...item,media:item.media.filter(m=>m.index===target.mediaIndex)}];
    }
    if(errors.length||queued)items=items.map(item=>({...item,mediaResolved:false}));
    return {items,target,errors,queued};
  }
  return {
    login:ctx=>engineAction(ctx,()=>ordinary(ctx,async profileLease=>{
      let browser;
      try{
        ctx.signal.throwIfAborted();browser=await open(ctx.paths,'x',{signal:ctx.signal,profileLease});const page=browser.pages()[0]??await browser.newPage();
        const account=await verifyXAccount(page,browser,ctx);ctx.signal.throwIfAborted();await ctx.emit('account',{platform:'x',authenticated:true,accountId:account.accountId,...xName(account)});
        return {status:'completed',completeness:'unknown'};
      }finally{await browser?.close();}
    })),
    scan:ctx=>engineAction(ctx,async()=>{
      const source=await resolve(ctx.request.source,{signal:ctx.signal});
      // Reject invalid routes before browser/engine starts; own likes needs current identity.
      if(source.kind!=='liked')xSource(source);
      return using(ctx,async(s,cookiePath,cookies,account)=>{
        const result=await extract(s,cookiePath,source,account,ctx.diagnostics);
        // Engine error class names only (e.g. AuthorizationError); messages stay private.
        const detail=m=>/rate limit/i.test(m)?'rate_limit':/Unable to retrieve Tweets from this timeline/i.test(m)?'timeline_unavailable':/Could not authenticate/i.test(m)?'not_authenticated':/protected|blocked/i.test(m)?'protected':/^(\d{3}) /.test(m)?'http_'+/^(\d{3})/.exec(m)[1]:'other';
        for(const e of result.errors.slice(0,3))ctx.diagnostics?.add({xEngineError:e.type,xSourceKind:source.kind,xEngineDetail:detail(String(e.message??''))});
        const reason=xEngineReason(result),single=source.kind==='single';
        if(single&&(reason?.code==='rate_limited'||!result.items.length))throw new ActionRequired(reason?.code??'input_required');
        const limit=Math.min(source.maxItems||10000,10000),items=result.items.slice(0,limit);
        for(const item of items){ctx.signal?.throwIfAborted();await ctx.emit('item',{item});}
        if(!single&&['rate_limited','auth_required','sensitive_content'].includes(reason?.code))throw new ActionRequired(reason.code);
        return {status:'completed',completeness:single&&items.every(i=>i.mediaResolved)?'complete':'partial',reasonCode:reason?.code??((result.errors.length||result.queued)?'history_unproven':single?undefined:result.items.length>limit?'item_limit':'history_unproven')};
      });
    }),
    download:async ctx=>{
      const items=(ctx.request.items??[]).filter(i=>i.selected!==false&&(!i.mediaResolved||i.media.length));
      if(!items.length)return {status:'completed',completeness:'unknown'};
      if(privateSource(ctx.request.source)&&!ctx.request.source.accountId)return engineAction(ctx,async()=>{throw new ActionRequired('auth_required','Rescan the private X source to bind its verified account before downloading.');});
      return using(ctx,async(s,cookiePath,cookies,account)=>{
        for(const original of items){
          const extracted=await extract(s,cookiePath,{...ctx.request.source,kind:'single',url:original.sourceUrl,maxItems:0},account,ctx.diagnostics);
          const reason=xEngineReason(extracted);if(reason)throw new ActionRequired(reason.code);
          const fresh=extracted.items.find(i=>i.contentId===original.contentId);
          if(!fresh)throw new ActionRequired('input_required','The selected X work could not be refreshed.');
          if(!fresh.mediaResolved)throw new ActionRequired('input_required','The engine returned additional unsupported extraction metadata. Narrow the source or review this work before downloading.');
          const item=applyMediaSelection(original,fresh);await ctx.emit('item',{item});
          for(const asset of item.media){
            const receipt=await transfer({root:ctx.paths.downloadRoot,category:ctx.paths.category,folder:ctx.paths.folder,dataRoot:ctx.paths.dataRoot,item,asset,cookies,signal:ctx.signal,onProgress:bytes=>ctx.emit('progress',{phase:'download',bytes})});
            await ctx.emit('receipt',{receipt});
          }
        }
        return {status:'completed',completeness:'unknown'};
      });
    },
  };
}
const adapter=xAdapter();export const {login,scan,download}=adapter;
