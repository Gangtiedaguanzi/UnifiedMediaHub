import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,rm,link} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {downloadAsset} from '../src/shared/download.mjs';
async function fixture(t){
 const temp=await mkdtemp(path.join(os.tmpdir(),'umh-reuse-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'media'),source=path.join(root,'legacy','photo.png');await mkdir(path.dirname(source),{recursive:true});
 const png=await readFile(new URL('./fixtures/synthetic-blue.png',import.meta.url));await writeFile(source,png);
 const item={platform:'douyin',contentId:'123',author:'作者',title:'标题'},asset={index:1,kind:'image',extension:'png',url:'https://synthetic.invalid/image',reuseFrom:source,reuseBytes:200,reuseSha256:'7d1dc11be712c39a7c343e934740d84c936896959d13e9983cf15ea6c1473288'};
 let requests=0;
 return {temp,root,source,item,asset,png,get requests(){return requests;},run:patch=>downloadAsset({root,category:'风景',item,asset,fetchImpl:async()=>{requests++;return new Response(png,{headers:{'content-type':'image/png'}});},...patch})};
}
test('same media into a new category is hardlinked without network',async t=>{
 const f=await fixture(t);const receipt=await f.run();
 assert.equal(receipt.status,'completed');assert.equal(receipt.filePath,path.join(f.root,'风景','douyin','作者','无日期_标题_123','01.png'));
 assert.equal((await stat(f.source)).nlink,2);assert.equal((await stat(receipt.filePath)).ino,(await stat(f.source)).ino);assert.equal(f.requests,0);assert.equal(receipt.sha256,f.asset.reuseSha256);
});
test('cross-volume reuse falls back to existing path without network or copy',async t=>{
 const f=await fixture(t);const receipt=await f.run({link:async()=>{throw Object.assign(new Error('synthetic EXDEV'),{code:'EXDEV'});}});
 assert.equal(receipt.status,'skipped');assert.equal(receipt.filePath,f.source);assert.equal(f.requests,0);assert.equal((await stat(f.source)).nlink,1);
});
test('reuseFrom outside download root is ignored',async t=>{
 const f=await fixture(t),outside=path.join(f.temp,'outside.png');await writeFile(outside,f.png);
 const receipt=await f.run({asset:{...f.asset,reuseFrom:outside}});assert.equal(receipt.status,'completed');assert.equal(f.requests,1);assert.equal((await stat(outside)).nlink,1);
});
test('changed source cannot earn a reused receipt or trigger network',async t=>{
 const f=await fixture(t);const changed=Buffer.from(f.png);changed[changed.length-1]^=1;await writeFile(f.source,changed);
 await assert.rejects(f.run(),/reuse_changed/);assert.equal(f.requests,0);
});
test('reuse cancellation publishes no success',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort(new Error('synthetic cancelled'));
 await assert.rejects(f.run({signal:controller.signal}),/synthetic cancelled/);assert.equal(f.requests,0);assert.equal((await stat(f.source)).nlink,1);
});
test('existing different file in category is a conflict',async t=>{
 const f=await fixture(t),target=path.join(f.root,'风景','douyin','作者','无日期_标题_123','01.png');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'synthetic existing file');
 await assert.rejects(f.run({link}),error=>error.message==='file_conflict');
 assert.equal(await readFile(target,'utf8'),'synthetic existing file');assert.equal(f.requests,0);
});
test('reuse into a category that already holds the file records the category path after A to B to A',async t=>{
 const f=await fixture(t);
 const firstA=await f.run({category:'A'});
 const b=await f.run({category:'B',asset:{...f.asset,reuseFrom:firstA.filePath}});
 const secondA=await f.run({category:'A',asset:{...f.asset,reuseFrom:b.filePath}});
 assert.equal(secondA.filePath,firstA.filePath);assert.equal(secondA.status,'skipped');assert.equal(f.requests,0);
 assert.equal((await stat(secondA.filePath)).ino,(await stat(b.filePath)).ino);
});
test('existing matching category copy is verified and used without network',async t=>{
 const f=await fixture(t),target=path.join(f.root,'风景','douyin','作者','无日期_标题_123','01.png');
 await mkdir(path.dirname(target),{recursive:true});await writeFile(target,f.png);
 assert.notEqual((await stat(target)).ino,(await stat(f.source)).ino);
 const receipt=await f.run();assert.equal(receipt.filePath,target);assert.equal(receipt.status,'skipped');
 assert.equal(receipt.sha256,f.asset.reuseSha256);assert.equal(receipt.bytes,f.asset.reuseBytes);assert.equal(f.requests,0);
});
