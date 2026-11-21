import {statfs} from 'node:fs/promises';
import path from 'node:path';
export const METADATA_RESERVE=64*1024**2,WRITE_WINDOW=64*1024**2;
export const diskFull=e=>e?.code==='ENOSPC'||e?.code==='EDQUOT'||e?.message==='disk_full';
export function mediaBudget(assets,staging=false){
 let bytes=0;
 for(const a of assets){const size=a.expectedBytes??WRITE_WINDOW;if(!Number.isSafeInteger(size)||size<0)throw new Error('invalid_size');bytes+=size;}
 bytes*=staging?2:1;if(!Number.isSafeInteger(bytes))throw new Error('storage_budget');return bytes;
}
export async function requireSpace(root,bytes,{statfsImpl=statfs}={}){
 let current=path.resolve(root),info;
 for(;;){try{info=await statfsImpl(current,{bigint:true});break;}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(current);if(parent===current)throw e;current=parent;}}
 if(info.bavail*info.bsize<BigInt(bytes+METADATA_RESERVE))throw Object.assign(new Error('disk_full'),{code:'ENOSPC'});
}
export async function preflight(paths,assets,staging=false){
 const bytes=mediaBudget(assets,staging);await requireSpace(paths.downloadRoot,bytes);
 if(paths.dataRoot)await requireSpace(paths.dataRoot,METADATA_RESERVE);return bytes;
}

export function rollingSpace(root){let remaining=0;return async bytes=>{if(bytes>remaining){await requireSpace(root,Math.max(bytes,WRITE_WINDOW));remaining=Math.max(bytes,WRITE_WINDOW);}remaining-=bytes;};}
