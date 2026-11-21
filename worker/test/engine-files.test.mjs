import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const f=await import('../src/shared/engine-files.mjs').catch(()=>({}));
test('engine file publication verifies magic and size before receipts and preserves conflicting destination',async t=>{
  assert.equal(typeof f.publishEngineFile,'function');
  const root=await mkdtemp(path.join(os.tmpdir(),'umh-files-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'staged');
  const png=await readFile(new URL('./fixtures/synthetic-blue.png',import.meta.url));
  await writeFile(source,png);
  const item={platform:'telegram',chatId:'user_7',messageId:'9',contentId:'9'};
  const asset={index:1,kind:'image',extension:'png',expectedBytes:png.length};
  const receipt=await f.publishEngineFile({root:path.join(root,'media'),source,item,asset});
  assert.equal(receipt.bytes,png.length); assert.match(receipt.sha256,/^[a-f0-9]{64}$/);
  assert.equal((await f.publishEngineFile({root:path.join(root,'media'),source,item,asset})).status,'skipped');
  await assert.rejects(f.publishEngineFile({root:path.join(root,'other'),source,item,asset:{...asset,expectedBytes:1}}),/size_mismatch/);
  await writeFile(source,'<html>not media</html>');
  await assert.rejects(f.publishEngineFile({root:path.join(root,'media'),source,item,asset:{...asset,expectedBytes:null}}),/invalid_media/);
  assert.deepEqual(await readFile(receipt.filePath),png);
});
test('photo size evidence rejects truncated staged JPEG before any published path',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-photo-publish-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=path.join(root,'9');await writeFile(source,Buffer.from('ffd8ffe000104a464946000101','hex'));
 const {telegramItems}=await import('../src/shared/engine-media.mjs');
 for(const size of [{Type:'x',Size:650},{Type:'x',Sizes:[100,300,650]}]){
  const [item]=telegramItems(JSON.stringify({id:7,peer_type:'channel',messages:[{id:9,type:'message',raw:{Media:{Photo:{Sizes:[size]}}}}]}));
  await assert.rejects(f.publishEngineFile({root:path.join(root,'output'),source,item,asset:item.media[0]}),/size_mismatch/);
 }
 const {readdir}=await import('node:fs/promises');const names=await readdir(path.join(root,'output'),{recursive:true});assert.equal(names.some(n=>n.endsWith('.jpg')||n.endsWith('.part')),false);
});
test('cancelled streamed publication removes its part file on the output volume',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-photo-cancel-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=path.join(root,'9');const jpg=await readFile(new URL('./fixtures/synthetic-telegram-photo.jpg',import.meta.url));await writeFile(source,jpg);
 const abort=new AbortController();
 await assert.rejects(f.publishEngineFile({root:path.join(root,'output'),source,item:{platform:'telegram',chatId:'channel_7',messageId:'9',contentId:'9'},asset:{index:1,kind:'image',extension:'jpg',expectedBytes:650},signal:abort.signal,onProgress:async()=>abort.abort()}),/abort/i);
 const {readdir}=await import('node:fs/promises');const names=await readdir(path.join(root,'output'),{recursive:true});assert.equal(names.some(n=>n.endsWith('.jpg')||n.endsWith('.part')),false);
});
