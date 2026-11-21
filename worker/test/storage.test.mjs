import './fixtures/offline-network.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import * as storage from '../src/shared/storage-budget.mjs';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
import {downloadAsset} from '../src/shared/download.mjs';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
test('space budget rejects before a transfer and includes TG stage plus publish',async()=>{
 assert.equal(storage.mediaBudget([{expectedBytes:100},{expectedBytes:200}],true),600);
 await assert.rejects(storage.requireSpace(process.cwd(),100,{statfsImpl:async()=>({bavail:1n,bsize:1n})}),e=>e.code==='ENOSPC');
 assert.equal(storage.mediaBudget([{expectedBytes:20*1024**3}]),20*1024**3);
 assert.equal(storage.mediaBudget([{}]),64*1024**2);
});
test('real transfer write ENOSPC stops browser batch at first media',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-space-'));let fetched=0,writes=0,uaReads=0,closed=false;const events=[];
 const item={platform:'douyin',contentId:'1',key:'douyin:1',sourceUrl:'https://www.douyin.com/video/1',selected:true,mediaResolved:true,media:[1,2].map(index=>({index,kind:'image',url:'https://cdn.invalid/synthetic.png',extension:'png',expectedBytes:8}))};
 try{
  const browser={pages:()=>[{evaluate:async()=>{uaReads++;return 'SyntheticUA/156';}}],cookies:async()=>[],close:async()=>{closed=true;}};
  const adapter=browserAdapter('douyin',{open:async()=>browser,download:options=>downloadAsset({...options,fetchImpl:async()=>{fetched++;return new Response(Buffer.from('89504e470d0a1a0a','hex'));},openFile:async()=>({writeFile:async()=>{writes++;throw Object.assign(new Error('private path never expose'),{code:'ENOSPC'});},close:async()=>{}})})});
  const result=await adapter.download({request:{items:[item],source:{platform:'douyin',kind:'single'},paths:{downloadRoot:root}},signal:new AbortController().signal,emit:async(type,payload)=>events.push({type,...payload})});
  assert.equal(result.reasonCode,'disk_full');assert.equal(result.status,'needs_action');assert.equal(fetched,1);assert.equal(writes,1);assert.equal(events.some(e=>e.receipt?.errorCode==='transfer_failed'),false);assert.equal(uaReads,1);assert.equal(closed,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
