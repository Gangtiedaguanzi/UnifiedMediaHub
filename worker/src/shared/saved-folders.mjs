import {parseLossless} from './json.mjs';
import {installSourceObserver,prepareSourceTab,tabSnapshot,barrier} from './browser.mjs';
import {bounded,pause} from './source-observation.mjs';
import {ActionRequired} from './source-resolution.mjs';

const folderId=value=>typeof value==='string'&&/^[1-9]\d{0,23}$/.test(value)?value:Number.isSafeInteger(value)&&value>0?String(value):null;
const cursorValue=value=>typeof value==='string'&&/^(?:0|[1-9]\d{0,23})$/.test(value)?value:Number.isSafeInteger(value)&&value>=0?String(value):null;

// Candidate maintainer contract; only naturally emitted page responses may supply it.
export function parseFolderDirectory(text){
 const bad=()=>{throw Error('folder_schema');};
 let body;try{body=parseLossless(text);}catch{bad();}
 if(body?.status_code!==0||!Array.isArray(body.collects_list)||body.collects_list.length>1000)bad();
 const folders=body.collects_list.map(entry=>{
  const id=folderId(entry?.collects_id_str??entry?.collects_id),alternate=entry?.collects_id==null?null:folderId(entry.collects_id);
  if(!id||(entry?.collects_id!=null&&alternate!==id)||typeof entry?.collects_name!=='string'||!entry.collects_name.trim()||entry.collects_name.length>256||/[\u0000-\u001f\u007f]/.test(entry.collects_name))bad();
  return {id,title:entry.collects_name,itemCount:Number.isSafeInteger(entry.total_number)&&entry.total_number>=0?entry.total_number:null};
 });
 return {folders,cursor:cursorValue(body.cursor),hasMore:body.has_more===false||body.has_more===0?false:body.has_more===true||body.has_more===1?true:null};
}

// The one known secondary role group, never a title/URL guessed from folder data.
function folderTabState({target}={}){
 const visible=e=>{if(!e?.isConnected||!e.getClientRects().length)return false;let depth=0;for(let n=e;n;n=n.parentElement){if(++depth>128)return false;const s=getComputedStyle(n);if(n.hidden||n.inert||n.getAttribute('aria-hidden')==='true'||s.display==='none'||['hidden','collapse'].includes(s.visibility)||Number(s.opacity)===0)return false;}return true;};
 const groups=document.querySelectorAll('[role="tablist"]'),tabs=document.querySelectorAll('[role="tab"]');
 if(groups.length>64||tabs.length>512)return target?null:{available:false,selected:false};
 const label=e=>e.textContent.length<=128?e.textContent.trim().replace(/\s+/g,' '):'';
 const candidates=[...groups].map(node=>({node,tabs:[...tabs].filter(t=>t.closest('[role="tablist"]')===node)})).filter(g=>g.tabs.filter(t=>label(t)==='收藏夹').length===1&&g.tabs.filter(t=>label(t)==='视频').length===1);
 if(candidates.length!==1||!visible(candidates[0].node))return target?null:{available:false,selected:false};
 const group=candidates[0],folder=group.tabs.find(t=>label(t)==='收藏夹');
 const key='__umh_saved_folder_tab_v1';let state=window[key];
 if(!state||state.node!==group.node){const generation=(state?.generation??0)+1;state?.observer.disconnect();state={node:group.node,generation};state.observer=new MutationObserver(records=>{if(records.length)state.generation++;});state.observer.observe(group.node,{attributes:true,childList:true,subtree:true,characterData:true});window[key]=state;}
 if(state.observer.takeRecords().length)state.generation++;
 const invalid=group.tabs.some(t=>t.hasAttribute('aria-selected')&&!['true','false'].includes(t.getAttribute('aria-selected')));
 const active=group.tabs.filter(t=>t.getAttribute('aria-selected')==='true'||t.getAttribute('data-state')==='active'||/(^|\s)(active|selected)(\s|$)/.test(t.className));
 const selected=!invalid&&active.length===1&&active[0]===folder&&visible(folder);
 if(target)return !selected&&!invalid&&target.url===location.href&&target.generation===state.generation&&visible(folder)?folder:null;
 return {available:!invalid&&visible(folder),selected,generation:state.generation,url:location.href};
}

function ownPath(raw,expected){try{const u=new URL(raw);return u.origin==='https://www.douyin.com'&&!u.username&&!u.password&&!u.port&&u.pathname==='/user/'+expected;}catch{return false;}}
async function snapshot(page,expected,signal){
 const first=await bounded(()=>tabSnapshot(page,'douyin','saved'),signal,3000,'source_changed');
 const secondary=await bounded(()=>page.evaluate(folderTabState),signal,3000,'source_changed');
 const last=await bounded(()=>tabSnapshot(page,'douyin','saved'),signal,3000,'source_changed');
 if(!ownPath(page.url(),expected)||!ownPath(first.url,expected)||first.url!==last.url||first.url!==page.url()||first.documentId!==last.documentId||first.tabGeneration!==last.tabGeneration||!first.selected||first.pending)return null;
 return {url:last.url,documentId:last.documentId,tabGeneration:last.tabGeneration,secondary};
}
const same=(a,b)=>!!a&&!!b&&a.url===b.url&&a.documentId===b.documentId&&a.tabGeneration===b.tabGeneration&&a.secondary.selected&&b.secondary.selected&&a.secondary.generation===b.secondary.generation;
const stopped=(code,message)=>new ActionRequired(code,message);
async function selectFolderTab(page,expected,signal){
 const end=Date.now()+3000;let clicked=false;
 do{
  signal.throwIfAborted();const state=await snapshot(page,expected,signal);
  if(!state)throw stopped('source_changed','The verified directory source changed during preparation.');
  if(state.secondary.selected)return state;
  if(!clicked&&state.secondary.available){
   const handle=await bounded(()=>page.evaluateHandle(folderTabState,{target:state.secondary}),signal,Math.max(1,end-Date.now()),'source_changed');
   try{const element=handle.asElement();if(element){clicked=true;try{await element.click({timeout:Math.max(1,end-Date.now())});}catch{signal.throwIfAborted();throw stopped('folder_unverified','The saved-folder tab could not be selected within this attempt.');}}}finally{await handle.dispose();}
  }
  await pause(75,signal);
 }while(Date.now()<end);
 throw stopped('folder_unverified','The unique saved-folder tab could not be verified.');
}
function directoryRequest(req,page){
 try{
  const u=new URL(req.url());if(req.method()!=='GET'||req.frame()!==page.mainFrame()||req.serviceWorker?.()||u.origin!=='https://www.douyin.com'||u.username||u.password||u.port||u.pathname!=='/aweme/v1/web/collects/list/')return null;
  const cursors=u.searchParams.getAll('cursor'),counts=u.searchParams.getAll('count');
  if(cursors.length!==1||counts.length!==1||cursorValue(cursors[0])===null||!/^\d{1,4}$/.test(counts[0])||Number(counts[0])<1||Number(counts[0])>1000)return null;
  return {cursor:cursors[0]};
 }catch{return null;}
}

export async function listDouyinFolders(page,{source,signal,emit,verifyAccount,maxRounds=10,waitMs=750,timeoutMs=120000}={}){
 if(source?.platform!=='douyin'||source.kind!=='saved_folders'||source.maxItems!=null&&(!Number.isSafeInteger(source.maxItems)||source.maxItems<0)||source.folderId!=null||typeof source.accountId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(source.accountId)||typeof verifyAccount!=='function')throw stopped('input_required','A verified account-bound directory source is required.');
 const cap=Math.min(source.maxItems>0?source.maxItems:50,50);
 const local=new AbortController(),active=signal?AbortSignal.any([signal,local.signal]):local.signal;
 const timer=setTimeout(()=>local.abort(stopped('folder_unverified','The finite folder directory observation expired.')),Math.min(120000,Math.max(1,timeoutMs)));
 const close=()=>{void page.close().catch(()=>{});};active.addEventListener('abort',close,{once:true});
 const tracked=new WeakMap(),pending=new Set(),rows=[];let requestCount=0,totalBytes=0,closed=false,queue=Promise.resolve(),lease,navigationGeneration=0;
 const onRequest=req=>{
  if(closed)return;
  try{if(req.isNavigationRequest()&&req.frame()===page.mainFrame())navigationGeneration++;}catch{}
  const meta=directoryRequest(req,page);if(!meta||++requestCount>32||!ownPath(page.url(),source.accountId))return;
  const generation=navigationGeneration;
  // This endpoint describes folders independently of tab-rendering order.
  // Fetch may precede the ARIA update; only document/path ownership is required
  // here. Both tab selections and fresh identity are required at publication.
  const scope=bounded(()=>tabSnapshot(page,'douyin','saved'),active,3000,'source_changed').then(state=>ownPath(state.url,source.accountId)&&ownPath(page.url(),source.accountId)?{url:state.url,documentId:state.documentId,navigationGeneration:generation}:null).catch(()=>null);
  tracked.set(req,{...meta,scope});
 };
 const onResponse=response=>{
  if(closed||response.fromServiceWorker?.())return;const meta=tracked.get(response.request());if(!meta)return;
  const task=queue=queue.then(async()=>{
   const scope=await meta.scope;if(!scope)return;
   if(response.status()!==200){rows.push({scope,error:response.status()===401?'auth_required':response.status()===429?'rate_limited':'folder_unverified'});return;}
   try{
    const body=await bounded(async()=>{const size=Number(await response.headerValue('content-length')??0);if(size>4*1024*1024)throw Error('folder_body_limit');return response.text();},active,2000,'folder_body_timeout');
    const bytes=Buffer.byteLength(body);totalBytes+=bytes;if(bytes>4*1024*1024||totalBytes>8*1024*1024)throw Error('folder_body_limit');
    rows.push({scope,input:meta.cursor,page:parseFolderDirectory(body)});
   }catch{rows.push({scope,error:'folder_unverified'});}
  }).catch(()=>{rows.push({error:'folder_unverified'});});
  pending.add(task);void task.finally(()=>pending.delete(task));
 };
 page.on('request',onRequest);page.on('response',onResponse);
 const verify=async()=>{
  let account;try{account=await bounded(child=>verifyAccount({signal:child}),active,45000,'identity_unverified');}catch(error){active.throwIfAborted();if(error.message==='identity_unverified')throw stopped('identity_unverified','The current account identity could not be verified within this attempt.');throw error;}
  active.throwIfAborted();if(!account)throw stopped('identity_unverified','The current account identity could not be verified within this attempt.');
  if(account.accountId!==source.accountId)throw stopped('auth_required','The current account differs from the bound directory account.');return account;
 };
 try{
  active.throwIfAborted();const account=await verify();await bounded(()=>emit('account',{...account,platform:'douyin',authenticated:true}),active,5000,'item_delivery_failed');await installSourceObserver(page,'douyin','saved');
  await page.goto('https://www.douyin.com/user/'+source.accountId,{waitUntil:'domcontentloaded',timeout:30000});
  if(!ownPath(page.url(),source.accountId))throw stopped('source_changed','The directory page left the bound account.');
  const blocked=await barrier(page);if(blocked)throw stopped(['auth_required','challenge','rate_limited'].includes(blocked)?blocked:'source_changed','The directory page requires manual attention.');
  if(!await prepareSourceTab(page,'douyin','saved',{signal:active}))throw stopped('folder_unverified','The primary saved tab could not be verified.');
  lease=await selectFolderTab(page,source.accountId,active);
  lease.navigationGeneration=navigationGeneration;
  const found=new Map(),inputs=new Set();let cursor='0',observed=false,terminal=false,limited=false,processed=0,idle=0;
  const rounds=Math.min(10,Math.max(1,maxRounds));
  for(let round=0;round<rounds;round++){
   await pause(Math.min(1000,Math.max(1,waitMs)),active);await queue;active.throwIfAborted();
   if(!same(lease,await snapshot(page,source.accountId,active)))throw stopped('source_changed','The selected folder directory source changed.');
   const before=found.size;
   for(;processed<rows.length;processed++){
    const row=rows[processed];if(row.error)throw stopped(row.error,'The saved-folder directory response could not be verified.');
    if(row.scope.documentId!==lease.documentId||row.scope.navigationGeneration!==lease.navigationGeneration||!ownPath(row.scope.url,source.accountId))throw stopped('source_changed','The directory response belongs to a previous document or account path.');
    if(inputs.has(row.input))continue;
    if(row.input!==cursor)throw stopped('source_changed','The directory pagination could not be verified.');
    observed=true;inputs.add(row.input);
    for(const folder of row.page.folders){if(!found.has(folder.id)&&found.size>=cap){limited=true;break;}found.set(folder.id,folder);}
    terminal=row.page.hasMore===false;cursor=row.page.cursor;
    if(found.size>=cap)limited=true;
   }
   if(terminal||limited)break;
   if(found.size===before)idle++;else idle=0;
   if(idle>=2)break;
   await bounded(()=>page.evaluate(()=>window.scrollBy(0,Math.max(1,innerHeight*0.8))),active,3000,'source_changed');
  }
  closed=true;page.off('request',onRequest);page.off('response',onResponse);await Promise.all([...pending]);
  if(!observed)throw stopped('folder_unverified','No verified saved-folder directory response was observed.');
  if(processed<rows.length)throw stopped('source_changed','The directory changed after its observation boundary.');
  if(navigationGeneration!==lease.navigationGeneration||!same(lease,await snapshot(page,source.accountId,active)))throw stopped('source_changed','The directory source changed before publication.');
  await verify();active.throwIfAborted();
  if(!same(lease,await snapshot(page,source.accountId,active)))throw stopped('source_changed','The directory source changed during account verification.');
  for(const folder of found.values()){
   active.throwIfAborted();if(navigationGeneration!==lease.navigationGeneration||!same(lease,await snapshot(page,source.accountId,active)))throw stopped('source_changed','The directory source changed during publication.');
   await bounded(()=>emit('folder',{folder}),active,5000,'item_delivery_failed');
  }
  return {status:'completed',completeness:terminal&&!limited?'complete':'partial',...(terminal&&!limited?{}:{reasonCode:limited?'item_limit':'history_unproven'})};
 }catch(error){
  active.throwIfAborted();if(error instanceof ActionRequired)throw error;
  throw stopped('folder_unverified','The saved-folder directory could not be verified within this attempt.');
 }finally{
  closed=true;page.off('request',onRequest);page.off('response',onResponse);clearTimeout(timer);active.removeEventListener('abort',close);await Promise.all([...pending]);
 }
}
