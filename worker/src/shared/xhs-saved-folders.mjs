import {bounded,pause} from './source-observation.mjs';
import {installSourceObserver,tabSnapshot,barrier} from './browser.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const alias=(entry,a,b)=>{
 const x=entry[a],y=entry[b];
 if(x!=null&&y!=null&&x!==y)fail('folder_schema');
 return x??y;
};
// Independent implementation of the observed upstream state shape, not its
// broken board-feed collector. This parser never reads notes or boardFeedsMap.
export function parseXhsFolderDirectory(raw){
 if(!Array.isArray(raw)||raw.length>1000)fail('folder_schema');
 const seen=new Set();
 return raw.map(entry=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))fail('folder_schema');
  const id=alias(entry,'id','boardId'),title=alias(entry,'name','title'),count=alias(entry,'total','itemCount');
  if(!validId(id)||seen.has(id)||typeof title!=='string'||!title.trim()||title.length>256||/[\u0000-\u001f\u007f-\u009f]/.test(title))fail('folder_schema');
  if(count!=null&&(!Number.isSafeInteger(count)||count<0))fail('folder_schema');
  seen.add(id);return {id,title,itemCount:count??null};
 });
}

export async function listXhsFolders(page,{source,signal,emit,verifyAccount,timeoutMs=120000,hydrationMs=8000}){
 signal?.throwIfAborted();
 if(source?.platform!=='xiaohongshu'||source.kind!=='saved_folders'||source.folderId!=null||typeof source.accountId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(source.accountId)||typeof verifyAccount!=='function')fail('input_required');
 if(source.maxItems!=null&&(!Number.isSafeInteger(source.maxItems)||source.maxItems<0))fail('input_required');
 const limit=Math.min(source.maxItems||50,50),url=`https://www.xiaohongshu.com/user/profile/${source.accountId}?tab=fav&subTab=board`;
 const budget=Number.isFinite(timeoutMs)&&timeoutMs>0?Math.min(timeoutMs,120000):120000;
 const hydration=Number.isFinite(hydrationMs)&&hydrationMs>=0?Math.min(hydrationMs,10000):8000;
 let closing;
 const close=()=>{closing??=page.close().catch(()=>{});};
 const same=(a,b)=>a.url===b.url&&a.documentId===b.documentId&&a.tabGeneration===b.tabGeneration&&b.selected;
 try{
  return await bounded(async life=>{
   life.addEventListener('abort',close,{once:true});
   try{
    const proof=async()=>{
     const account=await bounded(child=>verifyAccount({signal:child}),life,45000,'identity_unverified');life.throwIfAborted();
     if(!account||account.accountId!==source.accountId)fail(account?'auth_required':'identity_unverified');
     return account;
    };
    const account=await proof();
    await bounded(()=>{life.throwIfAborted();return emit('account',{...account,platform:'xiaohongshu',authenticated:true});},life,5000,'item_delivery_failed');
    await bounded(()=>installSourceObserver(page,'xiaohongshu','saved'),life,3000,'source_changed');
    await bounded(()=>page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}),life,30000,'source_changed');
    const snap=()=>bounded(()=>tabSnapshot(page,'xiaohongshu','saved'),life,3000,'source_changed');
    const read=async(strict=true)=>{
     const before=await snap();
     if(before.url!==url)fail('source_changed');
     const raw=await bounded(()=>page.evaluate(()=>{
      const list=window.__INITIAL_STATE__?.board?.userBoardList?._rawValue;
      if(list===undefined||list===null)return null;
      if(!Array.isArray(list)||list.length>1000)return {invalid:true};
      const keys=['id','boardId','name','title','total','itemCount'];
      return list.map(entry=>{
       if(!entry||typeof entry!=='object'||Array.isArray(entry))return null;
       const result={};
       for(const key of keys){const value=entry[key];if(value===undefined)continue;if(value!==null&&!['string','number'].includes(typeof value))return null;if(typeof value==='string'&&value.length>256)return null;result[key]=value;}
       return result;
      });
     }),life,3000,'source_changed');
     const after=await snap();
     // While hydrating, tab re-rendering moves tabGeneration mid-read: that read is merely unsettled and is
     // retried. Once a directory is accepted (strict), any drift still refuses.
     if(before.url!==after.url||before.documentId!==after.documentId)fail('source_changed');
     if(before.tabGeneration!==after.tabGeneration){if(strict)fail('source_changed');return {snapshot:after,folders:null,unsettled:true};}
     return {snapshot:after,folders:raw===null?null:parseXhsFolderDirectory(raw)};
    };
    const end=Date.now()+hydration;let observed;
    do{
     life.throwIfAborted();
     const blocked=await bounded(()=>barrier(page),life,3000,'source_changed');if(blocked)fail(blocked);
     observed=await read(false);
     if(!observed.unsettled&&observed.snapshot.selected&&observed.folders!==null)break;
     if(Date.now()>=end)fail('source_changed');
     await pause(Math.min(100,end-Date.now()),life);
    }while(true);
    await proof();
    const fingerprint=JSON.stringify(observed.folders);
    // Recheck the directory, not merely the profile, after identity navigation
    // and before each output. An unproven or changed directory emits no more.
    const ensureCurrent=async()=>{
     const now=await read();life.throwIfAborted();
     if(!same(observed.snapshot,now.snapshot)||JSON.stringify(now.folders)!==fingerprint)fail('source_changed');
    };
    await ensureCurrent();
    for(const folder of observed.folders.slice(0,limit)){
     await ensureCurrent();
     await bounded(()=>{life.throwIfAborted();return emit('folder',{folder});},life,5000,'item_delivery_failed');
    }
    return {status:'completed',completeness:'partial',reasonCode:'history_unproven'};
   }finally{life.removeEventListener('abort',close);}
  },signal,budget,'folder_directory_timeout');
 }catch(error){
  signal?.throwIfAborted();
  const code=error?.code??error?.message;
  if(!['auth_required','identity_unverified','challenge','rate_limited','source_changed','folder_schema','folder_directory_timeout','unavailable'].includes(code)&&error?.name!=='TimeoutError')throw error;
  const reasonCode=['auth_required','identity_unverified','challenge','rate_limited'].includes(code)?code:'folder_unverified';
  signal?.throwIfAborted();
  await bounded(()=>emit('needs_action',{code:reasonCode,awaitingInput:false,message:'The saved board directory could not be verified.'}),signal,5000,'item_delivery_failed');
  return {status:'needs_action',completeness:'partial',reasonCode};
 }finally{if(closing)await closing;}
}
