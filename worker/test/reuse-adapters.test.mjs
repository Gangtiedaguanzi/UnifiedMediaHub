import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {xAdapter} from '../src/adapters/x.mjs';
import {downloadAsset} from '../src/shared/download.mjs';
test('X selected refresh retains host reuse proof and avoids media transfer',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'umh-x-reuse-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'media'),old=path.join(root,'legacy','image.png');await mkdir(path.dirname(old),{recursive:true});
 const png=await readFile(new URL('./fixtures/synthetic-blue.png',import.meta.url));await writeFile(old,png);
 let mediaRequests=0,engineCalls=0;const events=[];
 const adapter=xAdapter({open:async()=>({cookies:async()=>[],close:async()=>{}}),session:async(_ctx,_platform,fn)=>fn({write:async(name,text)=>{const file=path.join(temp,name);await writeFile(file,text);return file;},run:async()=>{engineCalls++;return {stdout:'[[3,"https://pbs.twimg.com/synthetic.png",{"tweet_id":"123","num":1,"extension":"png"}]]'};}}),transfer:args=>downloadAsset({...args,fetchImpl:async()=>{mediaRequests++;return new Response(png,{headers:{'content-type':'image/png'}});}})});
 const result=await adapter.download({paths:{dataRoot:path.join(temp,'data'),downloadRoot:root,category:'分类'},request:{source:{platform:'x',kind:'single',url:'https://x.com/a/status/123'},items:[{platform:'x',key:'x:123',contentId:'123',sourceUrl:'https://x.com/a/status/123',mediaResolved:true,media:[{index:1,kind:'image',extension:'png',reuseFrom:old,reuseBytes:200,reuseSha256:'7d1dc11be712c39a7c343e934740d84c936896959d13e9983cf15ea6c1473288'}]}]},signal:new AbortController().signal,emit:async(type,payload)=>events.push({type,...payload})});
 assert.equal(result.status,'completed');assert.equal(engineCalls,1);assert.equal(mediaRequests,0);assert.equal((await stat(old)).nlink,2);assert.equal(events.find(e=>e.type==='receipt').receipt.status,'completed');
});
