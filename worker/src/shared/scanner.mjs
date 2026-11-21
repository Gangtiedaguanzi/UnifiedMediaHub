import { bounded, pause } from './source-observation.mjs';
import { randomUUID } from "node:crypto";
import {
  barrier,
  installSourceObserver,
  tabSnapshot,
  readDetail,
  readListDom,
  scrollFeed,
} from "./browser.mjs";
import { id, normalizeDouyin, normalizeXhs } from "./normalizers.mjs";
import { parseLossless } from "./json.mjs";
import { diagnosticPath } from './diagnostics.mjs';
import { XHS_API_ORIGINS } from './browser.mjs';
const normalizers = { douyin: normalizeDouyin, xiaohongshu: normalizeXhs };
// Unlike bounded(), this wait has no independent wall-clock deadline. Its
// caller owns the automatic clock, which may pause for one finite human wait.
async function untilAborted(operation, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),
      new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}),
    ]);
  }finally {signal.removeEventListener('abort',abort);}
}
export function scanBudget(source) {
  // 0 means "no limit" in settings: give it the full budget (10000 items). Lists that end stop early (listEndSeen).
  const explicit=Number.isSafeInteger(source?.maxItems)&&source.maxItems>0?Math.min(source.maxItems,10000):0,requested=explicit||10000;
  return {maxRounds:Math.min(500,Math.max(35,Math.ceil(requested/10))),maxAnchors:Math.max(1000,explicit)};
}
export function sourceIdentity(source) {
  const u = new URL(source.url);
  const dy = source.platform === "douyin";
  let work = dy
    ? (u.pathname.match(/^\/(?:share\/)?(?:video|note|slides)\/(\d+)(?:\/|$)/)?.[1] ??
      (u.searchParams.getAll('modal_id').length===1&&/^\d+$/.test(u.searchParams.get('modal_id')??'')?u.searchParams.get('modal_id'):null))
    : (u.pathname.match(
        /^\/(?:explore|discovery\/item|search_result)\/([A-Za-z0-9_-]+)/,
      )?.[1] ??
      u.pathname.match(/^\/user\/profile\/[^/]+\/([A-Za-z0-9_-]+)/)?.[1]);
  const subject = dy
    ? u.pathname.match(/^\/user\/([^/]+)/)?.[1]
    : u.pathname.match(/^\/user\/profile\/([^/]+)/)?.[1];
  return Object.freeze({
    scanId: randomUUID(),
    platform: source.platform,
    kind: work ? "single" : source.kind,
    work: id(work),
    subject: id(subject),
    host: u.hostname,
  });
}
const ownCursor = value => {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?String(value):null;
  return typeof value==='string'&&/^(?:0|[1-9][0-9]{0,1023})$/.test(value)?value:null;
};
function ownCollectionRequest(req, u, subject, reject=()=>null) {
  // Parse only the two known content types, with a finite raw body budget.
  const raw=req.postDataBuffer();
  if(!raw||raw.length>65536||u.search.length>65536)return reject('body_limit');
  const text=raw.toString('utf8'),type=(req.headers()['content-type']??'').split(';')[0].trim().toLowerCase();
  let values;
  if(type==='application/x-www-form-urlencoded') {
    const form=new URLSearchParams(text);values=key=>form.getAll(key);
  }else if(type==='application/json') {
    const data=JSON.parse(text);
    if(!data||typeof data!=='object'||Array.isArray(data))return reject('payload_invalid');
    // JSON.parse keeps only the last duplicate key. Count actual top-level keys
    // first; string tokens are consumed whole, including escaped key spellings.
    const counts=new Map();let depth=0;
    for(const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
      if(token[0]==='{'||token[0]==='[')depth++;
      else if(token[0]==='}'||token[0]===']')depth--;
      else if(depth===1&&/^\s*:/.test(text.slice(token.index+token[0].length))) {
        const key=JSON.parse(token[0]);counts.set(key,(counts.get(key)??0)+1);
      }
    }
    values=key=>Array.from({length:counts.get(key)??0},()=>data[key]);
  }else return reject('payload_invalid');
  const combined = key => [u.searchParams.getAll(key),values(key)];
  const subjects=combined('sec_user_id');
  if(subjects.some(parts=>parts.length>1))return reject('rejected_subject_count');
  if(subjects.some(parts=>parts.some(value=>value!==subject)))return reject('rejected_subject_value');
  const single = key => {
    const parts=combined(key);
    if(parts.some(values=>values.length>1))return null;
    const supplied=parts.flat().map(ownCursor);
    return supplied.length&&supplied.every(value=>value!==null&&value===supplied[0])?supplied[0]:null;
  };
  const count=single('count');
  if(count===null||Number(count)<1||Number(count)>1000)return reject('rejected_cursor');
  const input=single('cursor');
  return {type:'list',ownSavedAPI:true,input,initial:input==='0',route:u.origin+u.pathname};
}
const listPaths=(platform,kind)=>platform==='douyin'?[`/aweme/v1/web/aweme/${{profile:'post',liked:'favorite',saved:'listcollection'}[kind]}/`]:['v1','v2'].map(v=>`/api/sns/web/${v}/${{profile:'user_posted',liked:'note/like/page',saved:'note/collect/page'}[kind]}`);
function candidate(identity, req, page, accountId, reject=()=>null) {
  try {
    const u=new URL(req.url()),dy=identity.platform==='douyin';
    if(req.serviceWorker?.() || req.frame()!==page.mainFrame())return reject('rejected_frame');
    if(u.username || u.password)return reject('rejected_credentials');
    if(identity.kind==='single') {
      // Preserve the existing single-work route contract; normalizing still
      // requires the exact requested contentId. List provenance is stricter.
      if(dy && ['www.douyin.com','www.iesdouyin.com'].includes(u.hostname) && u.pathname.includes('/aweme/detail/') && u.searchParams.get('aweme_id')===identity.work)return {type:'detail'};
      if(!dy && ['www.xiaohongshu.com','edith.xiaohongshu.com','webapi.rednote.com'].includes(u.hostname) && u.pathname.endsWith('/note/feed'))return {type:'detail'};
      return null;
    }
    const paths=listPaths(identity.platform,identity.kind);
    if(!paths.includes(u.pathname))return reject('not_belongs');
    if(dy&&identity.kind==='saved'&&req.method()==='POST'&&u.origin==='https://www.douyin.com'&&paths.includes(u.pathname)) {
      if(typeof accountId!=='string'||id(accountId)!==accountId||accountId!==identity.subject)return reject('rejected_subject_value');
      return ownCollectionRequest(req,u,identity.subject,reject);
    }
    if(req.method()!=='GET')return reject('rejected_method');
    if(dy?u.origin!=='https://www.douyin.com':!XHS_API_ORIGINS.includes(u.origin))return reject('rejected_origin');
    const subjects=u.searchParams.getAll(dy?'sec_user_id':'user_id');
    if(subjects.length!==1)return reject('rejected_subject_count');
    if(subjects[0]!==identity.subject)return reject('rejected_subject_value');
    const cursors=u.searchParams.getAll(dy?'max_cursor':'cursor');
    const input=cursors.length===1 && cursors[0].length<=1024?cursors[0]:null;
    return {type:'list',input,initial:input===(dy?'0':''),route:u.origin+u.pathname};
  }catch{return reject('payload_invalid');}
}
function listPayload(platform, data, ownSavedAPI=false) {
  const dy=platform==='douyin';
  if(dy?data?.status_code!==0:data?.code!==0 || data?.success!==true)return null;
  const d=dy?data:data.data,entries=dy?d?.aweme_list:(d?.notes??d?.note_list);
  if(!Array.isArray(entries) || entries.length>1000)return null;
  const flag=d.has_more??d.hasMore;
  if(![true,false,0,1].includes(flag))return null;
  const cursor=ownSavedAPI?ownCursor(d.cursor):dy?d.max_cursor:d.cursor;
  return {entries,end:flag===false||flag===0,cursor:typeof cursor==='string'&&cursor.length<=1024?cursor:Number.isSafeInteger(cursor)&&cursor>=0?String(cursor):null};
}
export async function scanPage(page, {
  source, signal, emit, maxRounds=scanBudget(source).maxRounds, waitMs=700,
  navigate=true, prepare, beforePublish, beforeFinish, diagnostics, gateTimeoutMs=45000, bodyTimeoutMs=2000,
  // Automatic time covers navigation, preparation, rounds and serial draining.
  // Only one explicit manual interval may pause it, under its own finite cap.
  // 2 minutes minimum; larger requested scans scale with rounds up to 15 minutes.
  // Each identity gate gets 45 seconds (30s navigation + 10s observation + 2s body + margin),
  // independently of the 5-second actual output backpressure limit.
  timeoutMs=Math.min(900000,Math.max(120000,scanBudget(source).maxRounds*(waitMs+2000))),
  manualTimeoutMs=900000,
}) {
  const identity=sourceIdentity(source),normalize=normalizers[identity.platform];
  if(!identity.work && !identity.subject)return {status:'needs_action',completeness:'unknown',message:'Open an explicit work or profile URL in the dedicated browser.'};
  const lifetime=new AbortController(),life=lifetime.signal;
  const cancel=()=>lifetime.abort(signal.reason??new Error('cancelled'));
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  let timer,automaticStarted,remainingMs=timeoutMs,automaticPaused=true;
  const resumeAutomatic=()=>{
    if(!automaticPaused||life.aborted)return;
    automaticPaused=false;automaticStarted=performance.now();
    if(remainingMs<=0)lifetime.abort(new Error('scan_budget'));
    else timer=setTimeout(()=>lifetime.abort(new Error('scan_budget')),remainingMs);
  };
  const pauseAutomatic=()=>{
    if(automaticPaused)return;
    remainingMs=Math.max(0,remainingMs-(performance.now()-automaticStarted));
    clearTimeout(timer);automaticPaused=true;
    if(remainingMs<=0)lifetime.abort(new Error('scan_budget'));
  };
  resumeAutomatic();
  const seen=new Map(),requests=new WeakMap(),pending=new Set(),inFlight=new Set();
  const listScan=['douyin','xiaohongshu'].includes(identity.platform)&&['profile','liked','saved'].includes(identity.kind);
  const observations=new WeakMap(),unreported=new Set();let observedCount=0,rounds=0,scrolls=0,finalReason='operation_failed';
  const observe=req=>{
    if(!listScan||!diagnostics||unreported.size>=200||observedCount>=1024)return;
    try{const u=new URL(req.url());if(!['profile','liked','saved'].some(kind=>listPaths(identity.platform,kind).includes(u.pathname)))return;
      const subjects=u.searchParams.getAll(identity.platform==='douyin'?'sec_user_id':'user_id'),subject=subjects.length===1?subjects[0]:null;
      const families=identity.platform==='douyin'?['www.douyin.com','douyin.com','iesdouyin.com']:['www.xiaohongshu.com','xiaohongshu.com','edith.xiaohongshu.com','webapi.rednote.com'];
      const host=u.hostname==='www.iesdouyin.com'?'iesdouyin.com':u.hostname,length=value=>typeof value==='string'?Math.min(256,value.length):0;
      const shape={requestSubjectLength:length(subjects[0]),sourceSubjectLength:length(identity.subject),accountIdLength:length(source.accountId),requestSubjectIsSource:subject!==null&&subject===identity.subject,requestSubjectIsAccount:subject!==null&&subject===source.accountId,sourceSubjectIsAccount:typeof identity.subject==='string'&&identity.subject===source.accountId,originFamily:families.includes(host)?host:'other'};
      const record={path:u.pathname,method:req.method(),requestOrdinal:++observedCount,attempt:Math.min(8,observedCount),shape,verdict:'not_ready'};observations.set(req,record);unreported.add(record);return record;
    }catch{}
  };
  const report=(record,verdict,payload)=>{
    if(!record||record.done)return;record.done=true;unreported.delete(record);
    const group=[{path:record.path,method:record.method,status:record.status,attempt:record.attempt,requestOrdinal:record.requestOrdinal,listVerdict:verdict,...(payload?{entryCount:payload.entries.length,hasMore:!payload.end}:{})},{requestOrdinal:record.requestOrdinal,...record.shape}];
    if(record.snapshotShape)group.push({requestOrdinal:record.requestOrdinal,...record.snapshotShape});
    diagnostics?.addGroup(group);
  };
  let active=true,ready=false,navigating=false,generation=0,incomplete=false,partialOnly=false,documentChanged=false,fatal;
  let sourceTransitions=0,lastNavigationUrl=page.url();
  // listEndSeen: the platform itself answered "no more" for this list. Scrolling stops there; completeness
  // still needs the unbroken page chain (terminal), so a broken chain stays partial without burning rounds.
  let tail=Promise.resolve(),prepared,preparationSnapshot,latest,chain=null,terminal=false,listEndSeen=false,totalBytes=0,requestCount=0,ownSavedObserved=false;
  let preparationOpen=false,manualUsed=false,manualPending,manualFailure,preparationSignal,preparationRetirement;
  const waitForManual=action=>{
    if(!preparationOpen||manualUsed||!active||life.aborted||typeof action!=='function')
      return Promise.reject(Object.assign(new Error('manual_wait_unavailable'),{code:'input_required'}));
    manualUsed=true;pauseAutomatic();if(listScan)diagnostics?.add({tabConfirmed:false,manualWait:true});
    const closed=new AbortController();
    const onClosed=()=>closed.abort(Object.assign(new Error('The dedicated browser closed during manual preparation.'),{code:'browser_closed'}));
    page.on('close',onClosed);page.on('crash',onClosed);
    if(page.isClosed())onClosed();
    const manualSignal=AbortSignal.any([life,preparationSignal,closed.signal]);
    const cap=Number.isFinite(manualTimeoutMs)&&manualTimeoutMs>0?Math.min(900000,manualTimeoutMs):900000;
    manualPending=bounded(action,manualSignal,cap,'manual_wait_timeout').catch(error=>{
      manualFailure=error?.message==='manual_wait_timeout'?Object.assign(error,{code:'manual_wait_timeout'}):error;
      // Preparation may swallow this rejection, or never await the interval.
      // Its enclosing abortable wait must still end with the manual reason.
      preparationRetirement.abort(manualFailure);
      throw manualFailure;
    }).finally(()=>{
      page.off('close',onClosed);page.off('crash',onClosed);
      closed.abort(new Error('manual_wait_retired'));
      if(!manualFailure)resumeAutomatic();
    });
    // Even a preparation callback which forgets to await its interval must not
    // create an unhandled rejection or escape the enclosing finite preparation.
    void manualPending.catch(()=>{});
    return manualPending;
  };
  const allowed=identity.platform==='douyin'?['www.douyin.com','douyin.com','www.iesdouyin.com','iesdouyin.com']:['www.xiaohongshu.com','xiaohongshu.com'];
  const subjectMatches=s=>{
    try {const u=new URL(s.url),here=sourceIdentity({...source,url:s.url});return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&allowed.includes(u.hostname)&&(identity.kind==='single'?here.work===identity.work:here.subject===identity.subject&&!here.work);}catch{return false;}
  };
  const snapshotShape=s=>{
    let here,u;try{u=new URL(s.url);here=sourceIdentity({...source,url:s.url});}catch{}
    return {snapshotPath:diagnosticPath(s?.url),snapshotHasWork:!!here?.work,snapshotHostAllowed:!!u&&allowed.includes(u.hostname),snapshotSubjectIsSource:typeof here?.subject==='string'&&here.subject===identity.subject};
  };
  const belongs=s=>s&&subjectMatches(s)&&(identity.kind==='single'||s.selected);
  // Only the verified owner's explicit Douyin private list can keep an early
  // response across its initial tab confirmation. No navigation/account grace.
  const canHold=b=>identity.platform==='douyin'&&['liked','saved'].includes(identity.kind)&&b.duringPreparation&&
    source.accountId===identity.subject&&b.accountId===source.accountId&&subjectMatches(b.snapshot);
  const rebindPrepared=b=>{
    const now=preparationSnapshot,prior=b.snapshot;
    if(!now||!belongs(now)||b.generation!==generation||now.documentId!==prior.documentId||now.url!==prior.url)return null;
    const delta=now.tabGeneration-prior.tabGeneration;
    if(delta!==(prior.pending?0:1))return null;
    incomplete=true;return {...b,snapshot:now};
  };
  const same=(a,b)=>a&&b&&a.documentId===b.documentId&&a.tabGeneration===b.tabGeneration&&a.url===b.url;
  const snapshot=()=>bounded(()=>tabSnapshot(page,identity.platform,identity.kind),life,3000);
  const singleContinuation=identity.platform==='douyin'&&identity.kind==='single';
  const currentGeneration=lease=>lease.generation===generation||singleContinuation&&!navigating&&subjectMatches(lease.snapshot)&&subjectMatches({url:page.url()});
  const current=async lease=>{
    if(!active||life.aborted||navigating||!currentGeneration(lease)){lease.verdict='stale_generation';return false;}
    const now=await snapshot();
    // The browser-to-worker snapshot itself is asynchronous: a navigation may
    // commit while its old-document result is in transit.
    if(!active||life.aborted||navigating||!currentGeneration(lease)){lease.verdict='stale_generation';return false;}
    if(latest&&!same(latest,now)){chain=null;terminal=false;incomplete=true;}
    latest=now;
    const valid=ready&&belongs(now)&&(singleContinuation?subjectMatches(lease.snapshot):same(lease.snapshot,now));
    if(!valid){lease.verdict=!ready?'not_ready':!subjectMatches(now)?'rejected_current_subject':!belongs(now)?'not_belongs':'stale_generation';if(lease.verdict==='rejected_current_subject'&&lease.observation)lease.observation.snapshotShape=snapshotShape(now);}
    return valid;
  };
  const leaseFor=s=>({generation,snapshot:s});
  const output=(type,p)=>bounded(()=>{life.throwIfAborted();return emit(type,p);},life,5000,'item_delivery_failed');
  const recordFailure=error=>{
    if(life.aborted)return;
    fatal??=error?.code??error?.message??'item_delivery_failed';
  };
  // One serial publication queue avoids duplicate/limit races. A source lease is
  // checked on BOTH sides of the separate, cancellable fresh-account gate.
  const publish=async(raw,lease)=>{
    if(!await current(lease)){incomplete=true;return false;}
    const item=normalize(raw,identity.kind==='single');
    if(!item){incomplete=true;return true;}
    if(identity.kind==='single'&&item.contentId!==identity.work)return true;
    if(identity.kind==='single')item.sourceUrl=source.url;
    if(seen.has(item.key)&&(!item.mediaResolved||seen.get(item.key).mediaResolved))return true;
    if(source.maxItems>0&&!seen.has(item.key)&&seen.size>=source.maxItems){incomplete=true;return true;}
    if(beforePublish)await bounded(gateSignal=>beforePublish({signal:gateSignal}),life,gateTimeoutMs,'identity_timeout');
    if(!await current(lease)){incomplete=true;return false;}
    life.throwIfAborted();
    await output('item',{item});
    if(active&&!life.aborted)seen.set(item.key,item);
    return true;
  };
  const enqueue=work=>{
    const job=tail.then(()=>{life.throwIfAborted();if(active&&!fatal)return work();}).catch(recordFailure);
    tail=job;return job;
  };
  const advance=(binding,payload,lease)=>{
    if(chain&&!same(chain.lease.snapshot,lease.snapshot)){incomplete=true;chain=null;}
    if(!chain) {
      if(!binding.initial){incomplete=true;return;}
      chain={lease,route:binding.route,next:binding.input,used:new Set(),ended:false};
    }
    if(chain.ended||binding.route!==chain.route||binding.input===null||chain.next!==binding.input||chain.used.has(binding.input)) {incomplete=true;return;}
    chain.used.add(binding.input);
    if(payload.end){chain.ended=true;terminal=true;return;}
    if(payload.cursor===null||payload.cursor===binding.input||chain.used.has(payload.cursor)){incomplete=true;return;}
    chain.next=payload.cursor;
  };
  const start=async(req)=>{
    const record=observe(req);
    const info=candidate(identity,req,page,source.accountId,verdict=>{if(record)record.verdict=verdict;return null;});if(!info||!active||life.aborted||navigating)return;
    if(++requestCount>1024){incomplete=true;return;}
    const captured=generation;
    const duringPreparation=!ready;
    const binding=snapshot().then(s=>({...info,generation:captured,snapshot:s,accountId:source.accountId,duringPreparation,observation:record})).catch(()=>null);
    requests.set(req,binding);
    inFlight.add(req);
  };
  const onRequest=req=>{
    try {if(req.isNavigationRequest()&&req.frame()===page.mainFrame()){observe(req);sourceTransitions++;navigating=true;terminal=false;chain=null;if(ready){incomplete=true;documentChanged=true;}return;}}catch{observe(req);return;}
    void start(req);
  };
  const onNavigation=frame=>{if(frame===page.mainFrame()){const url=page.url();if(url!==lastNavigationUrl)sourceTransitions++;lastNavigationUrl=url;generation++;navigating=false;terminal=false;chain=null;if(ready)incomplete=true;}};
  const onResponse=response=>{
    if(active&&identity.platform==='douyin'&&identity.kind==='single')diagnostics?.observeResponse(response,page);
    const record=observations.get(response.request());if(record)record.status=response.status();
    const entry=requests.get(response.request());if(!entry){if(active)report(record,record?.verdict??'not_ready');return;}if(!active||life.aborted)return;
    inFlight.delete(response.request());
    if(pending.size>=8){incomplete=true;report(record,'not_ready');return;}
    const job=(async()=>{
      let binding=await entry;
      if(!binding){report(record,'not_ready');return;}
      if(!currentGeneration(binding)){report(record,'stale_generation');return;}
      if(!subjectMatches(binding.snapshot)){if(record)record.snapshotShape=snapshotShape(binding.snapshot);report(record,'rejected_snapshot_subject');return;}
      if(response.fromServiceWorker?.()){report(record,'rejected_frame');return;}
      const early=!belongs(binding.snapshot)&&canHold(binding);
      if(!belongs(binding.snapshot)&&!early&&!(!binding.ownSavedAPI&&binding.snapshot.pending&&binding.duringPreparation)){report(record,binding.duringPreparation?(binding.snapshot.pending?'not_ready':'tab_unconfirmed'):'not_belongs');return;}
      if(response.status()===429){fatal='rate_limited';report(record,'payload_invalid');return;}
      if([401,403].includes(response.status())){fatal='auth_required';report(record,'payload_invalid');return;}
      if(!response.ok()||!(response.headers()['content-type']??'').includes('json')){incomplete=true;report(record,'payload_invalid');return;}
      if(Number(response.headers()['content-length']??0)>4*1024*1024){incomplete=true;report(record,'body_limit');return;}
      const text=await bounded(()=>response.text(),life,bodyTimeoutMs,'body_timeout');
      if(!active||life.aborted)return;
      totalBytes+=Buffer.byteLength(text);
      if(Buffer.byteLength(text)>4*1024*1024||totalBytes>16*1024*1024){incomplete=true;report(record,'body_limit');return;}
      let data;try{data=parseLossless(text);}catch{incomplete=true;report(record,'payload_invalid');return;}
      // A small response budget is held only until finite preparation completes.
      await prepared;
      if(!active||life.aborted||!currentGeneration(binding)){report(record,'stale_generation');return;}
      if(early){
        const resumed=rebindPrepared(binding);
        if(!resumed){report(record,!preparationSnapshot?.selected?(binding.snapshot.pending?'not_ready':'tab_unconfirmed'):'stale_generation');return;}
        binding=resumed;
      }
      await enqueue(async()=>{
        if(!await current(binding)){incomplete=true;report(record,binding.verdict??'stale_generation');return;}
        if(binding.type==='list'){
          const p=listPayload(identity.platform,data,binding.ownSavedAPI);if(!p){incomplete=true;report(record,'payload_invalid');return;}
          // Own POST discovery is supported; independent full-history acceptance
          // is still pending, even when its observed cursor chain reaches an end.
          if(binding.ownSavedAPI){ownSavedObserved=true;partialOnly=true;}
          for(const raw of p.entries)if(!await publish(raw,binding)){report(record,binding.verdict??'not_belongs',p);return;}
          if(await current(binding)){advance(binding,p,binding);if(p.end&&binding.input!==null)listEndSeen=true;report(record,binding.input===null?'rejected_cursor':'accepted',p);}
          else report(record,binding.verdict??'stale_generation',p);
        }else {
          const raws=identity.platform==='douyin'?[data.aweme_detail]:(data.data?.items?.map(x=>x.note_card??x)??[]);
          for(const raw of raws)if(!await publish(raw,binding))return;
        }
      });
    })().catch(error=>{report(record,error?.message==='body_timeout'?'body_limit':'not_ready');if(!life.aborted){incomplete=true;if(error?.code)fatal??=error.code;}});
    pending.add(job);void job.finally(()=>pending.delete(job));
  };
  const needsAction=async(code,expired=false)=>{
    if(identity.kind==='single'){
      await diagnostics?.settle();diagnostics?.addFinal({unresolved:code==='work_unresolved',sourceChanged:code==='source_changed',scanExpired:expired,finalPath:page.url()});
    }
    const reasonCode=['work_unresolved','challenge','rate_limited','auth_required','identity_unverified','source_changed','browser_closed','source_tab_required','manual_wait_timeout'].includes(code)?code:'input_required';
    finalReason=reasonCode;if(listScan)diagnostics?.add({tabConfirmed:false,manualWait:false});
    const payload={code:reasonCode,awaitingInput:false,message:'The page requires manual attention; automatic navigation has stopped.'};
    if(expired)await bounded(()=>{signal?.throwIfAborted();return emit('needs_action',payload);},signal,5000,'item_delivery_failed');
    else await output('needs_action',payload);
    return {status:'needs_action',completeness:seen.size?'partial':'unknown',reasonCode,message:code};
  };
  const finish=async message=>{
    while(pending.size)await bounded(()=>Promise.all([...pending]),life,timeoutMs,'scan_budget');
    await bounded(()=>tail,life,timeoutMs,'scan_budget');
    life.throwIfAborted();if(fatal)return needsAction(fatal);
    if(chain&&!await current(chain.lease)){terminal=false;incomplete=true;}
    const finalGate=beforeFinish??beforePublish;
    if(finalGate&&(beforeFinish||terminal&&chain)){
      try {
        await bounded(gateSignal=>finalGate({signal:gateSignal}),life,gateTimeoutMs,'identity_timeout');
        if(chain&&!await current(chain.lease)){terminal=false;incomplete=true;}
      }catch(error){life.throwIfAborted();return needsAction(error?.code??error?.message??'identity_timeout');}
    }
    // Requests without responses, or new candidates arriving during the final
    // account check, lie outside the drained proof. Never certify their absence.
    if(inFlight.size||pending.size)incomplete=true;
    const limited=source.maxItems>0&&seen.size>=source.maxItems;
    const complete=identity.kind==='single'?[...seen.values()].some(i=>i.mediaResolved):terminal&&chain?.ended&&!incomplete&&!limited&&!partialOnly;
    if(identity.kind==='single'&&!complete)return needsAction('work_unresolved');
    const reasonCode=complete?undefined:limited?'item_limit':ownSavedObserved||incomplete?'history_unproven':message==='stalled_or_timeout'&&!terminal?'scan_boundary':'history_unproven';finalReason=reasonCode??'completed';
    return {status:'completed',completeness:complete?'complete':'partial',reasonCode,...(complete||!message?{}:{message})};
  };
  let releasePreparation;
  prepared=new Promise(resolve=>{releasePreparation=resolve;});
  page.on('request',onRequest);page.on('response',onResponse);page.on('framenavigated',onNavigation);
  try {
    life.throwIfAborted();
    await bounded(()=>installSourceObserver(page,identity.platform,identity.kind),life,3000);
    if(navigate)await bounded(()=>page.goto(source.url,{waitUntil:'domcontentloaded',timeout:30000}),life,30000);
    if(prepare){
      preparationRetirement=new AbortController();preparationSignal=AbortSignal.any([life,preparationRetirement.signal]);preparationOpen=true;
      try {
        await untilAborted(()=>prepare({signal:preparationSignal,waitForManual}),preparationSignal);
        if(manualPending)await untilAborted(()=>manualPending,preparationSignal);
        if(manualFailure)throw manualFailure;
      }finally {preparationOpen=false;preparationRetirement.abort(new Error('preparation_retired'));}
    }
    const initialGeneration=generation,initialTransitions=sourceTransitions;
    const initial=await snapshot();
    if(navigating||sourceTransitions!==initialTransitions)return await needsAction('source_changed');
    if(generation!==initialGeneration) {
      // Chromium emits framenavigated for same-URL history.replaceState too.
      // Admit it only after one stable, identical snapshot. Real navigations,
      // URL excursions (including away/back), and endless churn stay retired.
      const confirmationGeneration=generation;
      const confirmed=await snapshot();
      if(navigating||generation!==confirmationGeneration||sourceTransitions!==initialTransitions||
        !same(initial,confirmed))return await needsAction('source_changed');
    }
    if(!subjectMatches(initial))return await needsAction('source_changed');
    ready=true;latest=initial;preparationSnapshot=initial;if(listScan)diagnostics?.add({tabConfirmed:belongs(initial),manualWait:false});
    const readDom=state=>bounded(()=>readListDom(page,identity.platform,{...scanBudget(source),kind:identity.kind,subject:identity.subject,accountId:source.accountId,expectedSnapshot:state}),life,3000);
    const publishDom=async(dom,lease)=>{
      partialOnly ||= dom.partialOnly===true;
      incomplete ||= dom.truncated===true||dom.unparsed===true;
      if(dom.items.length)await enqueue(async()=>{for(const raw of dom.items)if(!await publish(raw,lease))break;});
    };
    // Hold parsed continuation responses while the initial rendered segment
    // hydrates. Never drain pending/finish here: those API jobs await prepared.
    try {
      if(identity.platform==='xiaohongshu'&&identity.kind==='saved') {
        const hydrationEnd=Date.now()+3000;
        do {
          life.throwIfAborted();
          const blocked=await bounded(()=>barrier(page),life,3000);
          if(blocked||fatal)return await needsAction(blocked??fatal);
          const observedGeneration=generation;
          const state=await snapshot();
          if(navigating||generation!==observedGeneration){incomplete=true;break;}
          if(!same(initial,state)||!subjectMatches(state)){incomplete=true;break;}
          if(!belongs(state))break;
          const lease=leaseFor(state);
          const dom=await readDom(state);
          await publishDom(dom,lease);
          if(dom.scopeStatus!=='not_ready'||Date.now()>=hydrationEnd||fatal)break;
          await pause(Math.min(100,hydrationEnd-Date.now()),life);
        }while(Date.now()<hydrationEnd);
      }
    }finally {releasePreparation();}
    for(let round=0;round<maxRounds;round++) {
      rounds=Math.min(500,rounds+1);
      life.throwIfAborted();
      const blocked=await bounded(()=>barrier(page),life,3000);
      if(blocked||fatal)return await needsAction(blocked??fatal);
      const observedGeneration=generation;
      const state=await snapshot();
      if(navigating||generation!==observedGeneration){incomplete=true;continue;}
      if(latest&&!same(latest,state)){chain=null;terminal=false;incomplete=true;}
      latest=state;
      if(!subjectMatches(state))return await needsAction('source_changed');
      if(belongs(state)) {
        const lease=leaseFor(state);
        if(identity.kind==='single') {
          const raw=await bounded(()=>readDetail(page,identity.platform,identity.work,{diagnostics}),life,3000);
          if(raw)await enqueue(()=>publish(raw,lease));
          if([...seen.values()].some(i=>i.mediaResolved))return await finish();
        }else {
          const dom=await readDom(state);
          await publishDom(dom,lease);
          // DOM end is a finite stopping cue, never proof of the missing first page.
          if(dom.end)return await finish();
        }
      }
      if(terminal)return await finish();
      if(listEndSeen){diagnostics?.add({listEndSeen:true});return await finish();}
      if(source.maxItems>0&&seen.size>=source.maxItems)return await finish('requested_limit');
      await output('progress',{phase:'scan',current:seen.size,message:'Observed accessible items; completeness requires source end evidence.'});
      scrolls=Math.min(500,scrolls+1);await bounded(()=>scrollFeed(page),life,3000);await pause(waitMs,life);
    }
    return await finish('stalled_or_timeout');
  }catch(error){
    signal?.throwIfAborted();
    if(life.aborted){finalReason='scan_boundary';return identity.kind==='single'?await needsAction('work_unresolved',true):{status:'completed',completeness:'partial',reasonCode:'scan_boundary',message:'scan_budget'};}
    if(documentChanged&&/Execution context was destroyed|Cannot find context with specified id/.test(error?.message??''))return await needsAction('source_changed');
    if(error?.code)return await needsAction(error.code);
    throw error;
  }finally {
    if(listScan){for(const record of unreported)report(record,record.verdict);diagnostics?.addFinal({finalPath:page.url(),rounds,scrolls,published:Math.min(10000,seen.size),reason:signal?.aborted?'cancelled':finalReason});}
    active=false;releasePreparation();lifetime.abort(new Error('scan_retired'));clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    await diagnostics?.settle();
    page.off('request',onRequest);page.off('response',onResponse);page.off('framenavigated',onNavigation);
  }
}
