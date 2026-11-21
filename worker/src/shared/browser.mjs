import { sourceTabState, bounded, pause } from './source-observation.mjs';
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, errors as browserErrors } from "playwright";
import { securePrivateRoot } from "./private.mjs";
import { safeDirectory, rejectLinks } from "./paths.mjs";

// Xiaohongshu's web API moved from edith.xiaohongshu.com to webapi.rednote.com (observed 2026-11-17); both are accepted.
export const XHS_API_ORIGINS=['https://edith.xiaohongshu.com','https://webapi.rednote.com'];
const activeRoots = new Set();
const leases = new WeakMap();
const packagedBrowser = fileURLToPath(
  new URL(
    "../../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe",
    import.meta.url,
  ),
);

async function acquireProfile(paths,platform,signal) {
  signal?.throwIfAborted();
  if (!["x", "douyin", "xiaohongshu"].includes(platform))
    throw new Error("unsupported_browser");
  if (
    path.resolve(paths.browserExecutable).toLowerCase() !==
    path.resolve(packagedBrowser).toLowerCase()
  )
    throw new Error("invalid_browser_path");
  await rejectLinks(packagedBrowser);
  const key = path.resolve(paths.dataRoot).toLowerCase();
  if (activeRoots.has(key)) throw new Error("profile_busy");
  // The C# host holds the cross-process data-root mutex; Chromium also owns its
  // native profile lock. No application lock file survives an interrupted worker.
  activeRoots.add(key);
  const release = () => activeRoots.delete(key);
  try {
    const root = await securePrivateRoot(paths.dataRoot);
    const profile = await safeDirectory(path.join(root, "browser", platform));
    signal?.throwIfAborted();
    const lease=Object.freeze({profile,executable:packagedBrowser});
    leases.set(lease,{key,platform,release});return lease;
  }catch(error){release();throw error;}
}

export async function withBrowserProfile(paths,platform,signal,operation){
  const lease=await acquireProfile(paths,platform,signal);
  try{return await operation(lease);}finally{leases.get(lease).release();leases.delete(lease);}
}

export async function openBrowser(paths,platform,{headless=false,signal,profileLease}={}) {
  signal?.throwIfAborted();
  const owned=!profileLease;
  const lease=profileLease??await acquireProfile(paths,platform,signal);
  const state=leases.get(lease);
  if(!state||state.platform!==platform||state.key!==path.resolve(paths.dataRoot).toLowerCase()||path.resolve(paths.browserExecutable).toLowerCase()!==path.resolve(packagedBrowser).toLowerCase())throw new Error('invalid_profile_lease');
  const release=()=>{if(owned){state.release();leases.delete(lease);}};
  let context;
  try {
    context = await chromium.launchPersistentContext(lease.profile, {
      executablePath: packagedBrowser,
      headless,
      viewport: null,
      acceptDownloads: false,
      chromiumSandbox: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--no-first-run",
      ],
    });
    context.once("close", release);
    const original = context.close.bind(context);
    const abort = () => {
      void context.close().catch(() => {});
    };
    context.close = async () => {
      try {
        await original();
      } finally {
        signal?.removeEventListener("abort", abort);
        release();
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      await context.close();
      signal.throwIfAborted();
    }
    return context;
  } catch (error) {
    await context?.close().catch(() => {});
    release();
    throw error;
  }
}

// A bare "验证码" is not a challenge: a guest Xiaohongshu home shows a login dialog offering an SMS code.
export function classifyBarrier({path:pathname='',text=''}={}) {
  if (
    /captcha|verify|website-login\/error/i.test(pathname) ||
    /请完成.*验证|安全验证|安全限制|访问链接异常/.test(text)
  )
    return "challenge";
  if (/请求过于频繁|操作频繁|稍后再试/.test(text)) return "rate_limited";
  if (/登录后查看|请登录后|登录后继续/.test(text) || /\/login(?:\/|$)/.test(pathname))
    return "auth_required";
  if (/页面不见了|笔记不存在|无法浏览/.test(text)) return "unavailable";
  return null;
}

export async function barrier(page) {
  return classifyBarrier(await page.evaluate(() => ({path:location.pathname,text:document.body?.innerText?.slice(0, 30000) ?? ""})));
}

// Passive verification of ordinary page traffic. Unknown schemas fail closed.
export async function currentIdentity(page, platform, {signal,timeoutMs=10000}={}) {
  const config=platform==='douyin'?{origins:['https://www.douyin.com'],path:'/aweme/v1/web/user/profile/self/',home:'https://www.douyin.com/'}:platform==='xiaohongshu'?{origins:XHS_API_ORIGINS,path:'/api/sns/web/v2/user/me',home:'https://www.xiaohongshu.com/explore'}:null;
  if(!config)return null;
  signal?.throwIfAborted();
  const wire=await page.context().newCDPSession(page),requests=new WeakSet(),pending=new Set(),requestNavigation=new WeakMap(),inFlightIdentity=new Set();
  let observed=null,invalid=false,active=true,navigationRequests=0,navigationUrl=null,proofNavigation=null,leftHome=false,failedIdentityRequest=false;
  const identityUrl=raw=>{try{const u=new URL(raw);return config.origins.includes(u.origin)&&u.pathname===config.path&&!u.username&&!u.password;}catch{return false;}};
  const started=req=>{try{
    const main=req.frame()===page.mainFrame();
    if(main&&req.isNavigationRequest?.()){navigationRequests++;navigationUrl??=req.url();}
    if(req.method()==='GET'&&main&&!req.serviceWorker?.()){requests.add(req);requestNavigation.set(req,navigationRequests);if(identityUrl(req.url()))inFlightIdentity.add(req);}
  }catch{}};
  const navigated=frame=>{if(frame===page.mainFrame()&&frame.url()!==config.home)leftHome=true;};
  const failed=req=>{if(inFlightIdentity.delete(req))failedIdentityRequest=true;};
  const salvageable=()=>!!observed&&!invalid&&!failedIdentityRequest&&!signal?.aborted&&!page.isClosed()&&page.url()===config.home&&
    navigationRequests===1&&navigationUrl===config.home&&proofNavigation===1&&!leftHome;
  const consume=async r=>{
    try{
      const u=new URL(r.url());if(!active||!config.origins.includes(u.origin)||u.pathname!==config.path||u.username||u.password||!requests.has(r.request())||r.fromServiceWorker?.()||r.status()!==200)return;
      if(Number(r.headers()['content-length']??0)>1048576){invalid=true;return;}
      let timer,abort;
      try{
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('identity_timeout')),Math.min(timeoutMs,2000));abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});});
        const text=await Promise.race([r.text(),timeout]);if(!active)return;if(Buffer.byteLength(text)>1048576){invalid=true;return;}
        const data=JSON.parse(text),user=platform==='douyin'?data.user:data.data;
        const valid=platform==='douyin'?data.status_code===0:data.code===0&&data.success!==false&&user?.guest===false;
        const id=platform==='douyin'?user?.sec_uid:user?.user_id;
        if(!valid||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id)){invalid=true;return;}
        if(observed&&observed.accountId!==id)invalid=true;
        observed={accountId:id,displayName:typeof user.nickname==='string'?user.nickname.slice(0,200):''};
        proofNavigation=requestNavigation.get(r.request());
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    }catch{invalid=true;}
  };
  const response=r=>{const task=consume(r);pending.add(task);void task.finally(()=>{pending.delete(task);inFlightIdentity.delete(r.request());});};
  try{
    await wire.send('Network.enable');await wire.send('Network.setCacheDisabled',{cacheDisabled:true});await wire.send('Network.setBypassServiceWorker',{bypass:true});
    page.on('request',started);page.on('response',response);page.on('framenavigated',navigated);page.on('requestfailed',failed);
    try{
      await page.goto(config.home,{waitUntil:'domcontentloaded',timeout:30000});
    }catch(error){
      signal?.throwIfAborted();
      // An unrelated script may hold DCL after this navigation already supplied
      // strict fresh self proof. Only that TimeoutError can retain it; new
      // documents/away-and-back routes or unsettled/conflicting proofs cannot.
      if(!(error instanceof browserErrors.TimeoutError)||!salvageable())throw error;
      try{await bounded(async child=>{
        while(pending.size||inFlightIdentity.size){child.throwIfAborted();if(pending.size)await Promise.all([...pending]);else await pause(10,child);}
      },signal,Math.min(timeoutMs,2000),'identity_timeout');}
      catch{signal?.throwIfAborted();throw error;}
      signal?.throwIfAborted();
      if(pending.size||inFlightIdentity.size||!salvageable())throw error;
      return observed;
    }
    const end=Date.now()+timeoutMs;
    while(!observed&&!invalid&&Date.now()<end){signal?.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,Math.min(50,timeoutMs)));}
    await Promise.all([...pending]);signal?.throwIfAborted();return invalid?null:observed;
  }finally{active=false;page.off('request',started);page.off('response',response);page.off('framenavigated',navigated);page.off('requestfailed',failed);inFlightIdentity.clear();await wire.detach().catch(()=>{});}
}

export async function installSourceObserver(page, platform, kind) {
  await page.addInitScript(sourceTabState, { platform, kind });
  return tabSnapshot(page, platform, kind);
}

export async function tabSnapshot(page, platform, kind) {
  return page.evaluate(sourceTabState, { platform, kind });
}

export async function prepareSourceTab(page, platform, kind, {signal, timeoutMs=3000}={}) {
  const deadline=Date.now()+timeoutMs;
  let attempted=false,nativeAttempts=0,handle,closing,origin,subject,initial;
  // Scanner child cancellation may precede the parent browser cancellation.
  // Closing only this operation's page makes an in-flight native click settle;
  // never race away from a click that could later succeed on an unblocked page.
  const abort=()=>{closing??=page.close().catch(()=>{});};
  signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
  try {
    if(signal?.aborted)abort();
    // Resolve the shared route parser lazily: scanner itself imports this module.
    const {sourceIdentity}=await import('./scanner.mjs');
    const sameSource=state=>{
      try {
        const url=new URL(state.url),identity=sourceIdentity({platform,kind,url:state.url});
        return state.documentId===initial.documentId && url.origin===origin.origin && url.pathname===origin.pathname &&
          url.protocol==='https:'&&!url.username&&!url.password&&!url.port &&
          identity.kind===kind&&!identity.work&&identity.subject===subject;
      }catch{return false;}
    };
    do {
      signal?.throwIfAborted();
      const state=await bounded(()=>tabSnapshot(page,platform,kind),signal,Math.max(1,deadline-Date.now()),'tab_snapshot_timeout');
      if(initial&&!sameSource(state))return false;
      if(state.selected)return true;
      if(!initial){
        initial=state;
        try {
          origin=new URL(state.url);const identity=sourceIdentity({platform,kind,url:state.url});subject=identity.subject;
          const hosts=platform==='douyin'?['www.douyin.com','douyin.com','www.iesdouyin.com']:['www.xiaohongshu.com','xiaohongshu.com'];
          if(!subject||identity.work||identity.kind!==kind||!hosts.includes(origin.hostname)||!sameSource(state))return false;
        }catch{return false;}
      }
      if(!attempted&&state.label){
        const acquisitionMs=deadline-Date.now();if(acquisitionMs<=0)return false;
        handle=await bounded(async child=>{
          const acquired=await page.evaluateHandle(sourceTabState,{platform,kind,targetHandle:state});
          // evaluateHandle itself has no timeout option. A result arriving
          // after the finite gate must be disposed, never clicked or leaked.
          if(child.aborted){await acquired.dispose().catch(()=>{});child.throwIfAborted();}
          return acquired;
        },signal,acquisitionMs,'tab_target_timeout');
        signal?.throwIfAborted();
        const target=handle.asElement(),remaining=deadline-Date.now();
        if(!target){
          // A generation change may invalidate acquisition before any click.
          // Release the empty handle and retry from a fresh scoped snapshot.
          await handle.dispose().catch(()=>{});handle=undefined;
        }else if(remaining>0){
          attempted=true;nativeAttempts++;
          try{await target.click({timeout:remaining});}
          catch(error){
            signal?.throwIfAborted();
            if(error?.name==='TimeoutError'||!/^(?:elementHandle\.click: )?Element is not attached to the DOM(?:\r?\n|$)/.test(error?.message??''))throw error;
            // Hydration may replace this exact element during preparation.
            // Only a definite detach allows another fully scoped acquisition.
            await handle.dispose().catch(()=>{});handle=undefined;
            attempted=nativeAttempts>=3;
          }
        }
        signal?.throwIfAborted();
      }
      if(Date.now()>=deadline)break;
      await pause(Math.min(50,deadline-Date.now()),signal);
    }while(Date.now()<deadline);
    return false;
  }catch(error){
    signal?.throwIfAborted();
    if(error?.name==='TimeoutError'||error?.message==='tab_target_timeout'||error?.message==='tab_snapshot_timeout'||/Element is not attached|Target page, context or browser has been closed|Execution context was destroyed|Cannot find context with specified id/.test(error?.message??''))return false;
    throw error;
  }finally {
    signal?.removeEventListener('abort',abort);
    if(closing)await closing;
    await handle?.dispose().catch(()=>{});
  }
}
export async function readListDom(page, platform, {maxAnchors=1000,kind,subject,accountId,expectedSnapshot}={}) {
  maxAnchors=Math.min(10000,Math.max(1000,Math.floor(maxAnchors)||1000));
  const ownSaved=platform==='xiaohongshu'&&kind==='saved';
  if(ownSaved) {
    const fresh=await tabSnapshot(page,platform,kind);
    if(!expectedSnapshot||!fresh.selected||fresh.documentId!==expectedSnapshot.documentId||fresh.tabGeneration!==expectedSnapshot.tabGeneration||fresh.url!==expectedSnapshot.url)
      return {items:[],end:false,partialOnly:true,scopeStatus:'refused'};
  }
  return page.evaluate(({platform,maxAnchors,ownSaved,subject,accountId,expectedSnapshot}) => {
    // Modern own-saved pages have no tabpanel. Correlate one complete rendered
    // feed with one complete ordered state group; state is never a token source.
    if(ownSaved&&document.querySelector('.xhs-user-page-primary-tabs, .feeds-container')) {
      const result=(scopeStatus,{truncated=false,unparsed=false,items=[]}={})=>({items,end:false,truncated,unparsed,partialOnly:true,scopeStatus});
      const refused=(truncated=false)=>result('refused',{truncated,unparsed:true});
      const here=new URL(location.href),tabs=here.searchParams.getAll('tab'),sub=here.searchParams.getAll('subTab');
      if(!subject||subject!==accountId||here.origin!=='https://www.xiaohongshu.com'||here.username||here.password||here.port||here.pathname!==`/user/profile/${subject}`||tabs.length!==1||tabs[0]!=='fav'||sub.length>1||(sub.length===1&&sub[0]!=='note')||location.href!==expectedSnapshot.url)return refused();
      let exhausted=false;
      const rendered=e=>{
        if(!e.getClientRects().length)return false;
        let n=e;
        for(let depth=0;n&&depth<64;depth++,n=n.parentElement) {
          const css=getComputedStyle(n);
          if(n.hidden||n.getAttribute('aria-hidden')==='true'||css.display==='none'||['hidden','collapse'].includes(css.visibility)||Number(css.opacity)===0)return false;
        }
        if(n){exhausted=true;return false;}
        return true;
      };
      const feeds=[...document.querySelectorAll('.feeds-container')];
      if(feeds.length>16)return refused(true);
      const allCards=document.querySelectorAll('.feeds-container .note-item'),allAnchors=document.querySelectorAll('.feeds-container a[href]');
      if(allCards.length>maxAnchors||allAnchors.length>maxAnchors)return refused(true);
      const eligible=[];
      for(const feed of feeds) {
        const cards=[...feed.querySelectorAll('.note-item')].filter(c=>c.closest('.feeds-container')===feed&&!c.closest('.query-note-item'));
        if(rendered(feed)&&cards.some(rendered))eligible.push({feed,cards});
      }
      if(exhausted)return refused(true);
      if(eligible.length>1)return refused();
      if(!eligible.length)return result('not_ready');
      const {feed,cards}=eligible[0];
      if(feeds.some(other=>other!==feed&&(other.contains(feed)||feed.contains(other))&&other.querySelector('.note-item')&&rendered(other)))return refused();
      const ids=[],links=new Map();let unparsed=false;
      for(const card of cards) {
        // Hidden cards cannot help certify a complete ordered rendered segment.
        if(!rendered(card))return exhausted?refused(true):result('not_ready');
        const found=new Map();
        for(const anchor of card.querySelectorAll('a[href]')) {
          if(anchor.closest('.note-item')!==card||anchor.closest('.query-note-item'))continue;
          let u;try{u=new URL(anchor.getAttribute('href'),location.href);}catch{continue;}
          if(u.origin!=='https://www.xiaohongshu.com'||u.username||u.password||u.port)continue;
          const cid=u.pathname.match(/^\/(?:explore|search_result|discovery\/item)\/([A-Za-z0-9_-]+)$/)?.[1]??u.pathname.match(/^\/user\/profile\/[^/]+\/([A-Za-z0-9_-]+)$/)?.[1];
          if(!cid)continue;
          const tokens=u.searchParams.getAll('xsec_token'),valid=tokens.length===1&&tokens[0].trim().length>0&&tokens[0].length<4096;
          const entry=found.get(cid)??[];
          if(valid)entry.push({token:tokens[0],title:(anchor.innerText??'').slice(0,1500)});
          found.set(cid,entry);
        }
        if(found.size!==1)return refused();
        const [cid,observed]=[...found][0];
        if(!links.has(cid)){ids.push(cid);links.set(cid,[]);}
        links.get(cid).push(...observed);
      }
      const unwrap=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.hasOwn(x,'_value')?x._value:x;
      const groups=unwrap(window.__INITIAL_STATE__?.user?.notes);
      if(groups===undefined)return result('not_ready');
      if(!Array.isArray(groups))return refused();
      if(groups.length>16)return refused(true);
      let entries=0,matches=0;
      for(const group of groups) {
        const values=unwrap(group);
        if(!Array.isArray(values))return refused();
        entries+=values.length;if(entries>maxAnchors)return refused(true);
        const groupIds=[];
        for(const value of values) {
          const candidates=[value,value?.note_card,value?.noteCard].flatMap(x=>x&&typeof x==='object'?[x.note_id,x.noteId,x.id].filter(v=>v!==undefined):[]);
          if(!candidates.length||candidates.some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(v))||new Set(candidates).size!==1)return refused();
          if(!groupIds.includes(candidates[0]))groupIds.push(candidates[0]);
        }
        if(groupIds.length&&groupIds.length===ids.length&&groupIds.every((id,i)=>id===ids[i]))matches++;
      }
      if(matches!==1)return refused();
      const items=[];
      for(const cid of ids) {
        const observed=links.get(cid),tokens=new Set(observed.map(x=>x.token));
        if(tokens.size!==1){unparsed=true;continue;}
        items.push({note_id:cid,xsec_token:observed[0].token,note_card:{display_title:observed[0].title}});
      }
      return result('ready',{items,unparsed});
    }
    const visible = (e) =>
      e.getClientRects().length && getComputedStyle(e).visibility !== "hidden";
    const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(
      visible,
    );
    if (panels.length !== 1) return { items: [], end: false };
    const panel = panels[0],
      items = [];
    let unparsed = false;
    const anchors = panel.querySelectorAll("a[href]");
    const truncated = anchors.length > maxAnchors;
    for (const anchor of [...anchors].slice(0, maxAnchors)) {
      let u;
      try {
        u = new URL(anchor.href);
      } catch {
        continue;
      }
      if (platform === "douyin") {
        if (!["www.douyin.com", "douyin.com"].includes(u.hostname)) continue;
        const cid = u.pathname.match(/^\/(?:video|note)\/(\d+)/)?.[1];
        if (cid)
          items.push({ aweme_id: cid, desc: anchor.innerText.slice(0, 1500) });
      } else {
        if (
          u.hostname !== "www.xiaohongshu.com" ||
          anchor.closest(".query-note-item")
        )
          continue;
        const cid =
          u.pathname.match(
            /^\/(?:explore|search_result|discovery\/item)\/([A-Za-z0-9_-]+)/,
          )?.[1] ??
          u.pathname.match(/^\/user\/profile\/[^/]+\/([A-Za-z0-9_-]+)/)?.[1];
        if (cid) {
          const token = u.searchParams.get("xsec_token");
          if (!token) {
            unparsed = true;
            continue;
          }
          items.push({
            note_id: cid,
            xsec_token: token,
            note_card: { display_title: anchor.innerText.slice(0, 1500) },
          });
        }
      }
    }
    const end = [...panel.querySelectorAll("p,span,div")].some(
      (e) =>
        visible(e) &&
        ["暂时没有更多了", "没有更多了", "没有更多内容"].includes(
          e.innerText.trim(),
        ),
    );
    return { items, end: end && !unparsed, truncated, unparsed };
  }, {platform,maxAnchors,ownSaved,subject,accountId,expectedSnapshot});
}

export async function readDetail(page, platform, expected, {diagnostics}={}) {
  const result=await page.evaluate(
    ({ platform, expected }) => {
      const diagnostic={embeddedScanned:0,rscRowsParsed:0,wrapperFound:false,detailFound:false,imageCount:0,liveVideoCount:0};
      const hasId = (x) =>
        x &&
        typeof x === "object" &&
        String(
          x.aweme_id ?? x.awemeId ?? x.note_id ?? x.noteId ?? x.id ?? "",
        ) === expected;
      const matches=x=>hasId(x)&&(platform!=="douyin"||Array.isArray(x.images)||(x.video&&typeof x.video==="object"&&!Array.isArray(x.video)));
      const detail=x=>{
        if(platform==="douyin"&&hasId(x)&&x.aweme?.detail&&typeof x.aweme.detail==="object"){
          diagnostic.wrapperFound=true;if(matches(x.aweme.detail))return x.aweme.detail;
        }
        return matches(x)?x:null;
      };
      // Only expected work objects leave the page, with explicit field allowlists.
      const pick = (x) => {
        const keys =
          platform === "douyin"
            ? [
                "aweme_id",
                "awemeId",
                "desc","create_time","createTime","aweme_type","awemeType","media_type","mediaType",
                "author",
                "authorInfo",
                "images",
                "video",
              ]
            : [
                "note_id",
                "noteId",
                "id",
                "title","time",
                "display_title",
                "user",
                "imageList",
                "image_list",
                "video",
                "xsec_token",
              ];
        const o = {};
        for (const k of keys) if (x[k] !== undefined) o[k] = x[k];
        return o;
      };
      const finish=x=>{
        diagnostic.detailFound=!!x;
        if(x){
          const images=Array.isArray(x.images)?x.images:[];
          diagnostic.imageCount=Math.min(200,images.length);
          diagnostic.liveVideoCount=Math.min(200,images.filter(i=>i?.video&&typeof i.video==='object'&&!Array.isArray(i.video)).length);
          for(const [key,v] of [['awemeType',x.aweme_type??x.awemeType],['mediaType',x.media_type??x.mediaType]])if(Number.isInteger(v)&&v>=0&&v<=10000)diagnostic[key]=v;
        }
        return {detail:x?pick(x):null,diagnostic};
      };
      if (platform === "xiaohongshu") {
        const state = window.__INITIAL_STATE__?.note;
        const note = state?.noteDetailMap?.[expected]?.note ?? state?.note;
        if (matches(note)) return finish(note);
      }
      const roots =
        platform === "douyin"
          ? [
              window._ROUTER_DATA,
              window.__INITIAL_STATE__,
              window.__UNIVERSAL_DATA_FOR_REHYDRATION__,
            ]
          : [];
      for (const s of [...document.scripts].slice(0, platform==="douyin"?400:64)) {
        diagnostic.embeddedScanned++;
        if (s.textContent.length > 4 * 1024 * 1024) continue;
        let text = s.textContent.trim();
        if(platform==="douyin"&&!text.includes(expected))continue;
        if(platform==="douyin"){
          const row=text.match(/^self\.__pace_f\.push\((\[[\s\S]*\])\)\s*;?$/);
          if(row){
            try{const payload=JSON.parse(row[1]);if(typeof payload[1]==="string"&&/^[0-9a-z]+:/.test(payload[1])){roots.push(JSON.parse(payload[1].replace(/^[0-9a-z]+:/,'')));diagnostic.rscRowsParsed=Math.min(50,diagnostic.rscRowsParsed+1);}}catch{}
            continue;
          }
        }
        if (s.id === "RENDER_DATA") {
          try {
            text = decodeURIComponent(text);
          } catch {}
        } else if (
          !["application/json", "application/ld+json"].includes(s.type)
        ) {
          const m = text.match(
            /^(?:window\.)?(?:_ROUTER_DATA|__INITIAL_STATE__|__UNIVERSAL_DATA_FOR_REHYDRATION__)\s*=\s*([\s\S]*?);?$/,
          );
          if (!m) continue;
          text = m[1];
        }
        try {
          roots.push(JSON.parse(text));
        } catch {}
      }
      const limit=platform==="douyin"?20000:5000,maxDepth=platform==="douyin"?40:14;
      const relevant=x=>{
        if(platform!=="douyin")return true;
        try{const seen=new WeakSet();let count=0;return JSON.stringify(x,(_key,value)=>{
          if(value&&typeof value==="object"){if(seen.has(value))return undefined;seen.add(value);if(++count>limit)throw new Error('embedded_budget');}return value;
        })?.includes(expected)===true;}catch{return false;}
      };
      let visited = 0;
      const queue = roots.filter(relevant).map((x) => [x, 0]);
      const seen=new WeakSet();
      while (visited<queue.length && visited < limit) {
        const [x, d] = queue[visited++];
        if (!x || typeof x !== "object" || d > maxDepth||seen.has(x)) continue;
        seen.add(x);const found=detail(x);if(found)return finish(found);
        for (const v of Object.values(x).slice(0, 400))
          if (v && typeof v === "object"&&queue.length<limit) queue.push([v, d + 1]);
      }
      return finish(null);
    },
    { platform, expected },
  );
  if(platform==='douyin')diagnostics?.add(result.diagnostic);
  return result.detail;
}

export async function scrollFeed(page) {
  await page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
    let el = panel;
    while (el) {
      const css = getComputedStyle(el);
      if (
        /auto|scroll/.test(css.overflowY) &&
        el.scrollHeight > el.clientHeight
      ) {
        el.scrollBy(0, Math.max(500, el.clientHeight * 0.8));
        return;
      }
      el = el.parentElement;
    }
    window.scrollBy(0, Math.max(500, innerHeight * 0.8));
  });
}
