import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramAdapter } from '../src/adapters/telegram.mjs';
import { validateRequest } from '../src/shared/protocol.mjs';
import path from 'node:path';

const accountId='9007199254740993';
const identity=JSON.stringify({version:1,type:'account',authenticated:true,accountId});
const row={peer_type:'channel',id:'7',title:'Synthetic chat'};
test('transport rejects unbound/wrong-platform directory before worker dispatch',()=>{
  const root=path.resolve('artifacts/synthetic-directory-only');
  const r={version:1,requestId:'synthetic-directory',operation:'listChats',source:{platform:'telegram',kind:'chat',accountId,url:'https://t.me/'},paths:{dataRoot:root,downloadRoot:root,browserExecutable:root,engineRoot:root}};
  assert.equal(validateRequest(r),r);
  for(const bad of [{accountId:undefined},{accountId:''},{accountId:'01'},{accountId:'9223372036854775808'},{kind:'single'},{platform:'x',url:'https://x.com/'}])assert.throws(()=>validateRequest({...r,source:{...r.source,...bad}}));
  assert.throws(()=>validateRequest({...r,items:[{}]}));
});
function fixture({source={},body,account=identity,onEmit}={}){
  const events=[],calls=[],abort=new AbortController();let launches=0;
  const ctx={request:{source:{platform:'telegram',kind:'chat',url:'https://t.me/',accountId,...source}},signal:abort.signal,
    emit:async(type,data)=>{events.push({type,...data});await onEmit?.(type,abort);}};
  const adapter=telegramAdapter({session:async(_ctx,_platform,fn)=>{launches++;return fn({run:async(args,options)=>{
    calls.push({args,options});if(args[1]==='identity')return {stdout:account};
    return {stdout:typeof body==='string'?body:JSON.stringify(body??{version:1,type:'chats',limit:Number(args.at(-1)),responseKind:'slice',chats:[row],skippedCount:0,duplicateCount:0,truncated:false,completeness:'partial'})};
  }});}});
  return {ctx,events,calls,abort,launches:()=>launches,run:()=>adapter.listChats(ctx)};
}
test('bounded directory passes default limit upstream after fresh matching identity',async()=>{
  const f=fixture();const result=await f.run();assert.equal(result.status,'completed');assert.equal(result.completeness,'partial');
  assert.deepEqual(f.calls.map(c=>c.args),[['umh','identity'],['umh','chats','--limit','5000']]);
  assert.ok(f.calls[1].options.maxOutput>=8*1024*1024&&f.calls[1].options.maxOutput<=16*1024*1024);assert.ok(f.calls[1].options.timeoutMs>300000&&f.calls[1].options.timeoutMs<=360000);
  assert.deepEqual(f.events.map(e=>e.type),['account','chat']);assert.equal(f.events[1].chat.id,'channel_7');assert.equal(f.events[1].chat.topics,undefined);
});
for(const [value,expected] of [[0,5000],[2,2],[100,100],[1000,1000],[9000,5000]])test(`directory limit ${value} is applied before engine listing`,async()=>{
  const f=fixture({source:{maxItems:value}});await f.run();assert.deepEqual(f.calls[1].args,['umh','chats','--limit',String(expected)]);
});
for(const source of [{accountId:undefined},{accountId:''},{accountId:'01'},{accountId:7},{accountId:'9223372036854775808'},{maxItems:-1},{maxItems:1.5},{maxItems:'50'},{platform:'x'},{kind:'single'}])test(`invalid or unbound directory rejects before session: ${JSON.stringify(source)}`,async()=>{
  const f=fixture({source});await assert.rejects(f.run());assert.equal(f.launches(),0);assert.equal(f.events.length,0);
});
test('different live identity stops before directory and emits no rows',async()=>{
  const f=fixture({source:{accountId:'99'}});assert.equal((await f.run()).status,'needs_action');assert.equal(f.calls.length,1);assert.equal(f.events.some(e=>e.type==='chat'),false);
});
test('cancellation after identity does not start listing',async()=>{
  const f=fixture({onEmit:(type,abort)=>{if(type==='account')abort.abort();}});await assert.rejects(f.run());assert.equal(f.calls.length,1);
});
const full={version:1,type:'chats',limit:5000,responseKind:'full',chats:[row],skippedCount:0,duplicateCount:0,truncated:false,completeness:'complete'};
test('full and short slice have different directory completeness',async()=>{
  assert.equal((await fixture({body:full}).run()).completeness,'complete');
  assert.equal((await fixture({body:{...full,responseKind:'slice',completeness:'partial',chats:[]}}).run()).completeness,'partial');
});
test('typed peers retain distinct IDs and lossless decimal strings',async()=>{
  const f=fixture({body:{...full,chats:['user','chat','channel'].map(peer_type=>({...row,peer_type,id:'9007199254740993'}))}});
  await f.run();assert.deepEqual(f.events.filter(e=>e.type==='chat').map(e=>e.chat.id),['user_9007199254740993','chat_9007199254740993','channel_9007199254740993']);
});
const invalid=[
  {...full,limit:100},{...full,limit:50},{...full,version:2},{...full,responseKind:'unknown'},
  {...full,responseKind:'slice'}, {...full,skippedCount:1},{...full,duplicateCount:1},{...full,truncated:true},
  {...full,skippedCount:-1},{...full,duplicateCount:0.5},{...full,chats:Array.from({length:5001},(_,i)=>({...row,id:String(i+1)}))},
  {...full,chats:[row,row]}, {...full,chats:[row,{...row,id:9}]}, {...full,chats:[row,{...row,id:'0'}]},
  {...full,chats:[row,{...row,id:'9223372036854775808'}]}, {...full,chats:[row,{...row,peer_type:'unknown'}]},
  {...full,chats:[row,{...row,id:'8',title:'bad\ncontrol'}]}, {...full,chats:[row,{...row,id:'8',title:''}]},
  {...full,chats:[row,{...row,id:'8',title:'a'.repeat(501)}]}, {...full,chats:[row,{...row,id:'8',username:'@bad'}]},
  {...full,chats:[row,{...row,id:'8',topics:[]}]}, {...full,messages:['SYNTHETIC-SECRET']},
];
invalid.forEach((body,i)=>test(`invalid whole response ${i} never leaks earlier valid rows`,async()=>{
  const f=fixture({body});await assert.rejects(f.run());assert.equal(f.events.some(e=>e.type==='chat'),false);
}));
test('machine error after apparent success emits no directory rows',async()=>{
  const f=fixture({body:JSON.stringify(full)+'\n'+JSON.stringify({version:1,type:'error',code:'rate_limited'})});
  await assert.rejects(f.run());assert.equal(f.events.some(e=>e.type==='chat'),false);
});
test('cancellation during rows stops later output',async()=>{
  const f=fixture({body:{...full,chats:[row,{...row,id:'8'}]},onEmit:(type,abort)=>{if(type==='chat')abort.abort();}});
  await assert.rejects(f.run());assert.equal(f.events.filter(e=>e.type==='chat').length,1);
});
