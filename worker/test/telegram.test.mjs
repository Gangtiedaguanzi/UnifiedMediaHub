import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Controls} from '../src/shared/protocol.mjs';
const tg=await import('../src/adapters/telegram.mjs').catch(()=>({}));
async function setup(t,source={},items=[]){const root=await mkdtemp(path.join(os.tmpdir(),'umh-tg-'));t.after(()=>rm(root,{recursive:true,force:true}));const events=[];return {root,events,ctx:{request:{source:{platform:'telegram',kind:'chat',url:'https://t.me/',chatId:'channel_7',...source},items},paths:{dataRoot:root,downloadRoot:path.join(root,'media')},signal:new AbortController().signal,controls:new Controls(),emit:async(type,payload)=>events.push({type,...payload})}};}
function session(root,run){return async(ctx,p,fn)=>fn({work:root,home:root,run,write:async(name,text)=>{const f=path.join(root,name);await writeFile(f,text);return f;}});}
const identity='{"version":1,"type":"account","authenticated":true,"accountId":"9007199254740993"}\n';
const exported='{"id":7,"peer_type":"channel","messages":[{"id":9,"type":"message","file":"a.jpg","raw":{"Media":{"Photo":{"Sizes":[{"Type":"x","Size":650}]}}}},{"id":10,"type":"message","file":"b.mp4","raw":{"Media":{"Document":{"MimeType":"video/mp4","Size":24}}}}]}';
test('Telegram verifies bound account before any private export and retains strict exact message selection',async t=>{
  assert.equal(typeof tg.telegramAdapter,'function');
  const {root,events,ctx}=await setup(t,{kind:'single',url:'https://t.me/c/7/9',accountId:'9007199254740993'});let exportArgs;
  const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};exportArgs=args;await writeFile(args[args.indexOf('-o')+1],exported);return {stdout:''};})});
  const result=await a.scan(ctx);
  assert.equal(result.status,'completed');assert.equal(result.completeness,'complete');
  assert.equal(exportArgs.includes('--strict-peer'),true);assert.deepEqual(exportArgs.slice(exportArgs.indexOf('-i')+1,exportArgs.indexOf('-i')+2),['9,9']);
  assert.deepEqual(events.filter(x=>x.type==='item').map(x=>x.item.messageId),['9']);
  const mismatch=await setup(t,{accountId:'123'});let calls=0;
  const b=tg.telegramAdapter({session:session(mismatch.root,async()=>{calls++;return {stdout:identity};})});
  assert.equal((await b.scan(mismatch.ctx)).status,'needs_action');assert.equal(calls,1);assert.equal(mismatch.events.some(x=>x.type==='item'),false);
});
test('Telegram machine login relays fresh prompts via stdin and emits identity only after success',async t=>{
  assert.equal(typeof tg.telegramAdapter,'function');
  const {root,ctx,events}=await setup(t);const inputs=[];
  ctx.emit=async(type,payload)=>{events.push({type,...payload});if(type==='needs_action')ctx.controls.push({command:'input',inputId:payload.inputId,text:'SYNTHETIC_SECRET'});};
  const a=tg.telegramAdapter({session:session(root,async(args,options)=>{assert.deepEqual(args,['umh','login']);const nonce='a'.repeat(48);await options.onLine(JSON.stringify({version:1,type:'input_required',field:'password',promptId:nonce,inputType:'password'}),async s=>inputs.push(s),ctx.signal);await options.onLine(identity.trim(),async()=>{},ctx.signal);assert.equal(events.some(x=>x.type==='account'),false);return {stdout:identity};})});
  assert.equal((await a.login(ctx)).status,'completed');
  assert.deepEqual(JSON.parse(inputs[0]),{promptId:'a'.repeat(48),text:'SYNTHETIC_SECRET'});
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_SECRET'),false);assert.equal(JSON.stringify(events).includes('a'.repeat(48)),false);
  assert.equal(events[0].inputType,'password');assert.equal(events.at(-1).accountId,'9007199254740993');
});
test('Telegram selected transfer writes only checked typed message and publishes verified receipt',async t=>{
  assert.equal(typeof tg.telegramAdapter,'function');
  const item={key:'telegram:channel_7:9',platform:'telegram',chatId:'channel_7',messageId:'9',contentId:'9',sourceUrl:'https://t.me/c/7/9',selected:true,mediaResolved:true,media:[{index:1,kind:'image',url:null,extension:'jpg',expectedBytes:null}]};
  const {root,ctx,events}=await setup(t,{accountId:'9007199254740993'},[item,{...item,messageId:'10',contentId:'10',key:'telegram:channel_7:10',selected:false}]);
  const jpg=await readFile(new URL('./fixtures/synthetic-telegram-photo.jpg',import.meta.url));let selection,stage,refreshes=0;
  const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};if(args[0]==='chat'){refreshes++;await writeFile(args[args.indexOf('-o')+1],exported);return {stdout:''};}assert.equal(args.includes('--strict-peer'),true);assert.equal(args.includes('--restart'),true);assert.equal(args.includes('--group'),false);const manifest=args[args.indexOf('-f')+1];selection=await readFile(manifest,'utf8');stage=args[args.indexOf('-d')+1];assert.equal(path.relative(ctx.paths.downloadRoot,stage).startsWith('..'),false);assert.equal(path.relative(ctx.paths.downloadRoot,manifest).startsWith('..'),true);await writeFile(path.join(stage,'9'),jpg);return {stdout:''};})});
  assert.equal((await a.download(ctx)).status,'completed');assert.deepEqual(JSON.parse(selection).messages.map(m=>m.id),[9]);
  assert.equal(refreshes,1);assert.deepEqual(JSON.parse(selection).messages,[{id:9,type:'message',photo:'selected'}]);assert.equal(events.find(e=>e.type==='item').item.media[0].expectedBytes,650);assert.equal(events.filter(e=>e.type==='receipt').length,1);assert.equal(events.at(-1).receipt.bytes,650);await assert.rejects(readdir(stage),{code:'ENOENT'});
});
test('Telegram typed chat list keeps same bare IDs distinct and validates no implicit Self before engine',async t=>{
  assert.equal(typeof tg.telegramAdapter,'function');const {root,ctx,events}=await setup(t,{accountId:'9007199254740993'});let calls=0;
  const a=tg.telegramAdapter({session:session(root,async args=>{calls++;return {stdout:args[1]==='identity'?identity:JSON.stringify({version:1,type:'chats',limit:5000,responseKind:'full',chats:['user','chat','channel'].map(peer_type=>({id:'7',peer_type,title:'Synthetic'})),skippedCount:0,duplicateCount:0,truncated:false,completeness:'complete'})};})});
  await a.listChats(ctx);assert.deepEqual(events.filter(e=>e.type==='chat').map(e=>e.chat.id),['user_7','chat_7','channel_7']);
  ctx.request.source={platform:'telegram',url:'https://t.me/',kind:'chat'};calls=0;
  await assert.rejects(a.scan(ctx),/invalid_peer/);assert.equal(calls,0);
});
test('Telegram missing exact message requires action rather than completed empty scan',async t=>{
 const {root,ctx,events}=await setup(t,{kind:'single',url:'https://t.me/c/7/9'});
 const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};await writeFile(args[args.indexOf('-o')+1],'{"id":7,"peer_type":"channel","messages":[]}');return {stdout:''};})});
 assert.equal((await a.scan(ctx)).status,'needs_action');assert.equal(events.some(x=>x.type==='item'),false);
});
test('Telegram login zero exit with final engine error never emits account',async t=>{
 const {root,ctx,events}=await setup(t);
 const a=tg.telegramAdapter({session:session(root,async(args,options)=>{await options.onLine(identity.trim(),async()=>{},ctx.signal);return {stdout:identity+'{"version":1,"type":"error","code":"rate_limited"}\n'};})});
 assert.equal((await a.login(ctx)).status,'needs_action');assert.equal(events.some(x=>x.type==='account'),false);
});
test('Telegram prompt output failure releases pending input without unhandled rejection',async t=>{
 const {root,ctx}=await setup(t);const {isolatedProcess}=await import('../src/shared/engines.mjs');const {fileURLToPath}=await import('node:url');
 ctx.emit=async()=>{throw new Error('fixture_output_closed');};
 const a=tg.telegramAdapter({session:session(root,async(args,options)=>isolatedProcess({...options,executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/engine-child.mjs',import.meta.url)),'tg-prompt'],root,signal:ctx.signal}))});
 await assert.rejects(a.login(ctx),/fixture_output_closed/);await new Promise(r=>setTimeout(r,50));
});
test('Telegram public username scan consumes actual typed export and propagates thread without guessing',async t=>{
 const {root,ctx,events}=await setup(t,{kind:'single',url:'https://www.telegram.me/PublicName/9?thread=23',chatId:'publicname',messageId:'9',topicId:'23'});let exportArgs;
 const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};exportArgs=args;await writeFile(args[args.indexOf('-o')+1],exported);return {stdout:''};})});
 assert.equal((await a.scan(ctx)).status,'completed');assert.equal(exportArgs[exportArgs.indexOf('-c')+1],'PublicName');assert.equal(exportArgs.includes('--peer-type'),false);assert.equal(exportArgs[exportArgs.indexOf('--topic')+1],'23');assert.equal(events.find(e=>e.type==='item').item.chatId,'channel_7');
});

test('Telegram truncated photo cannot publish a receipt even when persisted expected size is null',async t=>{
 const item={key:'telegram:channel_7:9',platform:'telegram',chatId:'channel_7',messageId:'9',contentId:'9',sourceUrl:'https://t.me/c/7/9',selected:true,mediaResolved:true,media:[{index:1,kind:'image',url:null,extension:'jpg',expectedBytes:null}]};
 const {root,ctx,events}=await setup(t,{accountId:'9007199254740993'},[item]);let stage;
 const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};if(args[0]==='chat'){await writeFile(args[args.indexOf('-o')+1],exported);return {stdout:''};}stage=args[args.indexOf('-d')+1];await writeFile(path.join(stage,'9'),Buffer.from('ffd8ffe000104a464946000101','hex'));return {stdout:''};})});
 await assert.rejects(a.download(ctx),/size_mismatch/);assert.equal(events.some(e=>e.type==='receipt'),false);await assert.rejects(readdir(stage),{code:'ENOENT'});
});
test('Telegram persisted selection stops on missing photo evidence or changed kind before transfer',async t=>{
 const item={key:'telegram:channel_7:9',platform:'telegram',chatId:'channel_7',messageId:'9',contentId:'9',sourceUrl:'https://t.me/c/7/9',selected:true,mediaResolved:true,media:[{index:1,kind:'image',extension:'jpg',expectedBytes:650}]};
 for(const mode of ['missing','changed']){
  const {root,ctx,events}=await setup(t,{accountId:'9007199254740993'},[item]);let downloads=0;
  const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};if(args[0]==='chat'){const body=mode==='missing'?exported.replace('"Sizes":[{"Type":"x","Size":650}]','"Sizes":[]'):exported.replace('"Photo":{"Sizes":[{"Type":"x","Size":650}]}','"Document":{"MimeType":"video/mp4","Size":650}');await writeFile(args[args.indexOf('-o')+1],body);return {stdout:''};}downloads++;await writeFile(path.join(args[args.indexOf('-d')+1],'9'),await readFile(new URL('./fixtures/synthetic-telegram-photo.jpg',import.meta.url)));return {stdout:''};})});
  if(mode==='missing')assert.equal((await a.download(ctx)).status,'needs_action');else await assert.rejects(a.download(ctx),/media_selection_changed/);
  assert.equal(downloads,0);assert.equal(events.some(e=>e.type==='receipt'),false);
 }
});
test('Telegram explicit empty media whitelist performs no session or stage work',async t=>{
 const {ctx}=await setup(t,{},[{selected:true,mediaResolved:true,media:[]}]);let calls=0;
 const a=tg.telegramAdapter({session:async()=>{calls++;throw new Error('must_not_run');}});assert.equal((await a.download(ctx)).status,'completed');assert.equal(calls,0);
});
test('Telegram cancelled owned child settles before its output media stage is removed',async t=>{
 const {isolatedProcess}=await import('../src/shared/engines.mjs');const {fileURLToPath}=await import('node:url');
 const item={key:'telegram:channel_7:9',platform:'telegram',chatId:'channel_7',messageId:'9',contentId:'9',sourceUrl:'https://t.me/c/7/9',selected:true,mediaResolved:true,media:[{index:1,kind:'image',extension:'jpg',expectedBytes:650}]};
 const {root,ctx,events}=await setup(t,{accountId:'9007199254740993'},[item]);const abort=new AbortController();ctx.signal=abort.signal;let stage,staged=false;
 const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};if(args[0]==='chat'){await writeFile(args[args.indexOf('-o')+1],exported);return {stdout:''};}stage=args[args.indexOf('-d')+1];return isolatedProcess({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/engine-child.mjs',import.meta.url)),'stage-wait',path.join(stage,'9')],root,signal:ctx.signal,onLine:async line=>{if(line==='staged'){staged=true;assert.equal(path.relative(ctx.paths.downloadRoot,stage).startsWith('..'),false);assert.equal((await readFile(path.join(stage,'9'))).length>0,true);abort.abort();}}});})});
 await assert.rejects(a.download(ctx),/abort/i);assert.equal(staged,true);assert.equal(events.some(e=>e.type==='receipt'),false);await assert.rejects(readdir(stage),{code:'ENOENT'});
});
test('Telegram download records which refresh check stopped it, without content',async t=>{
 const item={key:'telegram:user_7:9',platform:'telegram',chatId:'user_7',messageId:'9',contentId:'9',sourceUrl:'',selected:true,mediaResolved:true,media:[{index:1,kind:'image',url:null,extension:'jpg'}]};
 for(const [name,exported,want] of [
  ['missing',`{"id":7,"peer_type":"user","messages":[]}`,{telegramCheck:'message_missing',peerKind:'user',entryCount:0}],
  ['other peer',`{"id":8,"peer_type":"user","messages":[]}`,{telegramCheck:'peer_mismatch',peerKind:'user'}],
 ]){
  const {root,ctx}=await setup(t,{accountId:'9007199254740993',chatId:undefined},[item]);const logged=[];ctx.diagnostics={add:e=>logged.push(e)};
  const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};await writeFile(args[args.indexOf('-o')+1],exported);return {stdout:''};})});
  assert.equal((await a.download(ctx)).status,'needs_action',name);
  assert.deepEqual(logged.filter(e=>e.telegramCheck),[want],name);
 }
});
test('Telegram download refreshes one chat with a single ranged export, not one call per message',async t=>{
 const photo=id=>({id,type:'message',file:`${id}.jpg`,raw:{Media:{Photo:{Sizes:[{Type:'x',Size:650}]}}}});
 const ranged=JSON.stringify({id:7,peer_type:'channel',messages:[photo(15),photo(14),photo(12),photo(9)]});
 const items=[9,12,15].map(id=>({key:`telegram:channel_7:${id}`,platform:'telegram',chatId:'channel_7',messageId:String(id),contentId:String(id),sourceUrl:`https://t.me/c/7/${id}`,selected:true,mediaResolved:true,media:[{index:1,kind:'image',url:null,extension:'jpg',expectedBytes:null}]}));
 const {root,ctx,events}=await setup(t,{accountId:'9007199254740993'},items);
 const jpg=await readFile(new URL('./fixtures/synthetic-telegram-photo.jpg',import.meta.url));const exports=[];let selection;
 const a=tg.telegramAdapter({session:session(root,async args=>{
  if(args[0]==='umh')return {stdout:identity};
  if(args[0]==='chat'){exports.push(args.slice(args.indexOf('-T'),args.indexOf('-T')+4));await writeFile(args[args.indexOf('-o')+1],ranged);return {stdout:''};}
  selection=JSON.parse(await readFile(args[args.indexOf('-f')+1],'utf8'));const stage=args[args.indexOf('-d')+1];
  for(const m of selection.messages)await writeFile(path.join(stage,String(m.id)),jpg);return {stdout:''};
 })});
 assert.equal((await a.download(ctx)).status,'completed');
 assert.deepEqual(exports,[['-T','id','-i','9,15']]);
 assert.deepEqual(selection.messages.map(m=>m.id),[9,12,15]);
 assert.equal(events.filter(e=>e.type==='receipt').length,3);
});
test('Telegram download paces like the proven standalone tool and waits out short flood waits',async t=>{
 const item={key:'telegram:channel_7:9',platform:'telegram',chatId:'channel_7',messageId:'9',contentId:'9',sourceUrl:'https://t.me/c/7/9',selected:true,mediaResolved:true,media:[{index:1,kind:'image',url:null,extension:'jpg',expectedBytes:null}]};
 const {root,ctx}=await setup(t,{accountId:'9007199254740993'},[item]);
 const jpg=await readFile(new URL('./fixtures/synthetic-telegram-photo.jpg',import.meta.url));const calls=[];
 const a=tg.telegramAdapter({session:session(root,async(args,options={})=>{
  calls.push({cmd:args[0],args,floodWait:options.floodWait});
  if(args[0]==='umh')return {stdout:identity};
  if(args[0]==='chat'){await writeFile(args[args.indexOf('-o')+1],exported);return {stdout:''};}
  await writeFile(path.join(args[args.indexOf('-d')+1],'9'),jpg);return {stdout:''};
 })});
 assert.equal((await a.download(ctx)).status,'completed');
 const dl=calls.find(c=>c.cmd==='download');
 for(const [flag,value] of [['-t','2'],['-l','2'],['--delay','200ms']])assert.equal(dl.args[dl.args.indexOf(flag)+1],value,flag);
 assert.equal(dl.floodWait,'wait');
 assert.equal(calls.filter(c=>c.cmd!=='download').every(c=>c.floodWait!=='wait'),true);
});
test('Telegram large selection downloads in chunks of 20 and keeps finished chunks when a later chunk fails',async t=>{
  const ids=Array.from({length:45},(_,i)=>String(101+i));
  const items=ids.map(id=>({key:'telegram:channel_7:'+id,platform:'telegram',chatId:'channel_7',messageId:id,contentId:id,sourceUrl:'https://t.me/c/7/'+id,selected:true,mediaResolved:true,media:[{index:1,kind:'image',url:null,extension:'jpg',expectedBytes:null}]}));
  const {root,ctx,events}=await setup(t,{accountId:'9007199254740993'},items);
  const jpg=await readFile(new URL('./fixtures/synthetic-telegram-photo.jpg',import.meta.url));
  const many=JSON.stringify({id:7,peer_type:'channel',messages:ids.map(id=>({id:Number(id),type:'message',file:id+'.jpg',raw:{Media:{Photo:{Sizes:[{Type:'x',Size:650}]}}}}))});
  const sizes=[];let downloads=0;
  const a=tg.telegramAdapter({session:session(root,async args=>{if(args[0]==='umh')return {stdout:identity};if(args[0]==='chat'){await writeFile(args[args.indexOf('-o')+1],many);return {stdout:''};}
    downloads++;const selection=JSON.parse(await readFile(args[args.indexOf('-f')+1],'utf8'));sizes.push(selection.messages.length);if(downloads===3)throw new Error('synthetic late failure');
    const stage=args[args.indexOf('-d')+1];for(const m of selection.messages)await writeFile(path.join(stage,String(m.id)),jpg);return {stdout:''};})});
  await a.download(ctx).catch(()=>{});
  assert.deepEqual(sizes,[20,20,5]);
  const receipts=events.filter(e=>e.type==='receipt'&&e.receipt.status==='completed');assert.equal(receipts.length,40);
  assert.equal((await readdir(ctx.paths.downloadRoot,{recursive:true})).filter(n=>/\.jpg$/.test(n)).length,40);
});
