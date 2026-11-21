import {preflight,rollingSpace} from './storage-budget.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, link, rm } from 'node:fs/promises';
import { contentKey, relativeMediaPath, rejectLinks, safeDirectory } from './paths.mjs';
import { mediaMagic } from './download.mjs';
import { registerOwnedTemp } from './owned-temps.mjs';

async function hashFile(file,signal) {
  const hash=createHash('sha256'); let bytes=0;
  for await(const chunk of createReadStream(file,{signal})) {hash.update(chunk);bytes+=chunk.length;}
  return {bytes,sha256:hash.digest('hex')};
}
// The engine writes only inside its private task staging directory. Publish a verified
// streamed copy on the destination volume; never trust an engine filename as a path.
export async function publishEngineFile({root,category='',folder='',dataRoot,source,item,asset,signal,onProgress=async()=>{}}) {
  signal?.throwIfAborted();
  await preflight({downloadRoot:root,dataRoot},[asset]);
  await rejectLinks(source);
  const checkSpace=rollingSpace(root);
  const filePath=path.resolve(root,relativeMediaPath(item,asset,{category,folder,root}));
  const relative=path.relative(path.resolve(root),filePath);
  if(relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_path');
  await safeDirectory(path.dirname(filePath)); await rejectLinks(filePath);
  const part=filePath+'.'+randomUUID()+'.part';
  let handle,owned,created=false;
  try {
    if(dataRoot)owned=await registerOwnedTemp(dataRoot,root,part,'part');
    handle=await open(part,'wx',0o600);
    created=true;await owned?.claim();
    let bytes=0,first=Buffer.alloc(0),lastProgress=0; const hash=createHash('sha256');
    for await(const chunk of createReadStream(source,{signal})) {
      signal?.throwIfAborted();
      if(first.length<32) first=Buffer.concat([first,chunk.subarray(0,32-first.length)]);
      await checkSpace(chunk.length);
      await handle.writeFile(chunk); bytes+=chunk.length; hash.update(chunk);
      if(Date.now()-lastProgress>500){lastProgress=Date.now();await onProgress(bytes);}
    }
    if(!bytes || !mediaMagic(first,asset.kind)) throw new Error('invalid_media');
    if(asset.expectedBytes!=null && bytes!==asset.expectedBytes) throw new Error('size_mismatch');
    await handle.sync(); await handle.close(); handle=null;
    signal?.throwIfAborted(); await rejectLinks(filePath);
    const sha256=hash.digest('hex'); let status='completed';
    try {await link(part,filePath);} catch(e) {
      if(e.code!=='EEXIST') throw e;
      await rejectLinks(filePath); const saved=await hashFile(filePath,signal);
      if(saved.bytes!==bytes || saved.sha256!==sha256) throw new Error('file_conflict'); status='skipped';
    }
    return {contentKey:contentKey(item),mediaIndex:asset.index,filePath,bytes,sha256,status};
  } finally {await handle?.close();if(owned){if(created)await owned.clean();else await owned.abandon();}else if(created)await rm(part,{force:true});}
}
