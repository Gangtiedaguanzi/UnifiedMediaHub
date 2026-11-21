import {bounded,pause} from './source-observation.mjs';
import {tabSnapshot,barrier} from './browser.mjs';
import {normalizeXhs} from './normalizers.mjs';
import {listXhsFolders} from './xhs-saved-folders.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const identifier=(value,max=200)=>typeof value==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(value);
const alias=(object,a,b)=>{
 const x=object[a],y=object[b];
 if(x!=null&&y!=null&&x!==y)fail('folder_unverified');
 return x??y;
};
const text=value=>{
 if(value==null)return undefined;
 if(typeof value!=='string'||value.length>1500)fail('folder_unverified');
 return value;
};
// Pinned upstream contract: boardFeedsMap._rawValue[boardId].notes[], not a
// whole-favorites feed. No note-detail lookup or media resolution is performed.
export function parseXhsBoardMembers(entry){
 if(!entry||typeof entry!=='object'||Array.isArray(entry)||!Array.isArray(entry.notes)||entry.notes.length>1000)fail('folder_unverified');
 const items=new Map();
 for(const note of entry.notes){
  if(!note||typeof note!=='object'||Array.isArray(note))fail('folder_unverified');
  const id=alias(note,'noteId','id'),token=alias(note,'xsecToken','xsec_token');
  if(!identifier(id))fail('folder_unverified');
  if(token!=null&&(typeof token!=='string'||!token.length||token.length>=4096||token.trim()!==token||/[\u0000-\u001f\u007f-\u009f]/.test(token)))fail('folder_unverified');
  const displayTitle=text(note.displayTitle),title=text(note.title);
  if(note.user!=null&&(typeof note.user!=='object'||Array.isArray(note.user)))fail('folder_unverified');
  const nickname=text(note.user?.nickName)??text(note.user?.nickname);
  let cover;
  // A display-only cover cannot invalidate verified board membership.
  if(note.cover&&typeof note.cover==='object'&&!Array.isArray(note.cover)){
   for(const key of ['urlDefault','url','urlPre']){
    const value=note.cover[key];
    if(typeof value!=='string'||!value.length||value.length>4096)continue;
    let u;try{u=new URL(value);}catch{continue;}
    if(!['https:','http:'].includes(u.protocol)||u.username||u.password)continue;
    cover={url:value};break;
   }
  }
  const item=normalizeXhs({note_id:id,xsec_token:token,note_card:{display_title:displayTitle??title,user:{nickname},cover}},false);
  const canonical=new URL(item.sourceUrl);
  if(canonical.origin!=='https://www.xiaohongshu.com'||canonical.pathname!==`/explore/${id}`||canonical.username||canonical.password||canonical.hash)fail('folder_unverified');
  if(items.has(id)&&JSON.stringify(items.get(id))!==JSON.stringify(item))fail('folder_unverified');
  items.set(id,item);
 }
 return [...items.values()];
}

// Only this exact board's bounded scalar fields cross the page boundary. Other
// entries and any note media/state blobs are deliberately never traversed.
function boardProjection(boardId){
 const map=window.__INITIAL_STATE__?.board?.boardFeedsMap?._rawValue;
 if(map==null)return null;
 if(typeof map!=='object'||Array.isArray(map)||!Object.hasOwn(map,boardId))return null;
 const entry=map[boardId];
 if(!entry||typeof entry!=='object'||Array.isArray(entry)||!Array.isArray(entry.notes)||entry.notes.length>1000)return {invalid:true};
 const scalar=(value,limit)=>value==null?value:typeof value==='string'&&value.length<=limit?value:{invalid:true};
 return {notes:entry.notes.map(note=>{
  if(!note||typeof note!=='object'||Array.isArray(note))return null;
  const row={};for(const key of ['noteId','id'])if(note[key]!==undefined)row[key]=scalar(note[key],200);
  for(const key of ['xsecToken','xsec_token'])if(note[key]!==undefined)row[key]=scalar(note[key],4095);
  for(const key of ['displayTitle','title'])if(note[key]!==undefined)row[key]=scalar(note[key],1500);
  if(note.user!=null){
   if(typeof note.user!=='object'||Array.isArray(note.user))return null;
   row.user={nickName:scalar(note.user.nickName,1500),nickname:scalar(note.user.nickname,1500)};
  }
  if(note.cover&&typeof note.cover==='object'&&!Array.isArray(note.cover)){
   for(const key of ['urlDefault','url','urlPre']){
    const value=note.cover[key];if(typeof value!=='string'||!value.length||value.length>4096)continue;
    let url;try{url=new URL(value);}catch{continue;}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)continue;
    row.cover={url:value};break;
   }
  }
  return row;
 })};
}

export async function scanXhsFolderMembers(page,{source,signal,emit,verifyAccount,timeoutMs=120000,hydrationMs=8000}={}){
 signal?.throwIfAborted();
 if(source?.platform!=='xiaohongshu'||source.kind!=='saved_folder'||!identifier(source.accountId)||!identifier(source.folderId,128)||typeof verifyAccount!=='function'||source.maxItems!=null&&(!Number.isSafeInteger(source.maxItems)||source.maxItems<0))fail('input_required');
 const cap=Math.min(source.maxItems||50,50),target=`https://www.xiaohongshu.com/board/${source.folderId}?source=web_user_page`;
 const budget=Number.isFinite(timeoutMs)&&timeoutMs>0?Math.min(timeoutMs,120000):120000;
 const hydration=Number.isFinite(hydrationMs)&&hydrationMs>=0?Math.min(hydrationMs,10000):8000;
 const closed=new AbortController(),active=signal?AbortSignal.any([signal,closed.signal]):closed.signal;
 let closing,navigation=0,navigationUrl=page.url();
 // Hydration can replace history state without changing the source. Real URL
 // transitions remain counted (including away/back); documentId catches reloads.
 const onNavigation=frame=>{if(frame===page.mainFrame()){const url=frame.url();if(url!==navigationUrl)navigation++;navigationUrl=url;}};
 const onClosed=()=>closed.abort(Object.assign(new Error('browser_closed'),{code:'browser_closed'}));
 const close=()=>{closing??=page.close().catch(()=>{});};
 page.on('framenavigated',onNavigation);page.on('close',onClosed);page.on('crash',onClosed);
 try{
  return await bounded(async life=>{
   life.addEventListener('abort',close,{once:true});
   try{
    // Reuse the already independently verified directory path. Its limit is
    // 50: a chosen ID not in this finite result is unverified, not nonexistent.
    let found=false;
    const directorySource={...source,kind:'saved_folders',folderId:undefined,maxItems:50};
    const directory=await listXhsFolders(page,{source:directorySource,signal:life,verifyAccount,hydrationMs:hydration,emit:async(type,payload)=>{
     life.throwIfAborted();
     if(type==='account')return emit(type,payload);
     if(type==='folder'&&payload.folder.id===source.folderId)found=true;
    }});
    life.throwIfAborted();
    if(directory.status!=='completed')fail(directory.reasonCode??'folder_unverified');
    if(!found)fail('folder_unverified');
    await bounded(()=>page.goto(target,{waitUntil:'domcontentloaded',timeout:30000}),life,30000,'folder_unverified');
    const document=await bounded(()=>tabSnapshot(page,'xiaohongshu','saved'),life,3000,'folder_unverified');
    if(document.url!==target||page.url()!==target)fail('folder_unverified');
    const generation=navigation;
    const current=async()=>{
     life.throwIfAborted();
     const state=await bounded(()=>tabSnapshot(page,'xiaohongshu','saved'),life,3000,'folder_unverified');
     if(state.url!==target||page.url()!==target||state.documentId!==document.documentId||navigation!==generation)fail('folder_unverified');
    };
    const read=async()=>{
     await current();
     const raw=await bounded(()=>page.evaluate(boardProjection,source.folderId),life,3000,'folder_unverified');
     await current();return raw===null?null:parseXhsBoardMembers(raw);
    };
    const end=Date.now()+hydration;let items;
    do{
     const blocked=await bounded(()=>barrier(page),life,3000,'folder_unverified');
     if(blocked)fail(['auth_required','challenge','rate_limited'].includes(blocked)?blocked:'folder_unverified');
     items=await read();if(items!==null)break;
     if(Date.now()>=end)fail('folder_unverified');
     await pause(Math.min(100,end-Date.now()),life);
    }while(true);
    const fingerprint=JSON.stringify(items);
    const account=await bounded(child=>verifyAccount({signal:child}),life,45000,'identity_unverified');life.throwIfAborted();
    if(!account)fail('identity_unverified');if(account.accountId!==source.accountId)fail('auth_required');
    const ensureCurrent=async()=>{if(JSON.stringify(await read())!==fingerprint)fail('folder_unverified');};
    await ensureCurrent();
    for(const item of items.slice(0,cap)){
     await ensureCurrent();
     await bounded(()=>{life.throwIfAborted();return emit('item',{item});},life,5000,'item_delivery_failed');
    }
    await ensureCurrent();
    return {status:'completed',completeness:'partial',reasonCode:items.length>=cap?'item_limit':'history_unproven'};
   }finally{life.removeEventListener('abort',close);}
  },active,budget,'folder_unverified');
 }catch(error){
  signal?.throwIfAborted();
  const code=error?.code??error?.message;
  if(!['folder_unverified','auth_required','identity_unverified','challenge','rate_limited','browser_closed'].includes(code)&&error?.name!=='TimeoutError')throw error;
  const reasonCode=['auth_required','identity_unverified','challenge','rate_limited','browser_closed'].includes(code)?code:'folder_unverified';
  await bounded(()=>{signal?.throwIfAborted();return emit('needs_action',{code:reasonCode,awaitingInput:false,message:'The selected board and its first visible state could not be verified within this attempt.'});},signal,5000,'item_delivery_failed');
  return {status:'needs_action',completeness:'partial',reasonCode};
 }finally{
  page.off('framenavigated',onNavigation);page.off('close',onClosed);page.off('crash',onClosed);
  if(closing)await closing;
 }
}
