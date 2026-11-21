import {validateLoginQr} from '../shared/protocol.mjs';
import {preflight} from '../shared/storage-budget.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { withEngineSession, boundedFile, engineAction, engineFailure } from '../shared/engines.mjs';
import { decimal, typedPeer, sourcePeerConstraint, messageId, telegramSource, telegramExport, telegramSelected } from '../shared/engine-media.mjs';
import { parseLossless } from '../shared/json.mjs';
import { ActionRequired } from '../shared/source-resolution.mjs';
import { withMediaStage } from '../shared/media-stage.mjs';
import { applyMediaSelection } from '../shared/selection.mjs';
import { publishEngineFile } from '../shared/engine-files.mjs';
import {tryReuseAsset} from '../shared/download.mjs';
import { thumbnailCandidate, decodeThumbnails } from '../shared/telegram-thumbnails.mjs';

function accountFrom(text) {
  let account;
  for(const line of text.split('\n').filter(x=>x.trim())) {
    const e=JSON.parse(line);
    if(e.version!==1) throw new Error('invalid_machine_output');
    if(e.type==='error')throw engineFailure(line);
    if(e.type==='account'){
      if(account || e.authenticated!==true || typeof e.accountId!=='string')throw new Error('invalid_machine_output');
      account={platform:'telegram',authenticated:true,accountId:decimal(e.accountId)};
    }
  }
  if(!account)throw new ActionRequired('auth_required','The dedicated Telegram session is not currently authorized.');
  return account;
}
function matchAccount(account,source){
  if(source.accountId && source.accountId!==account.accountId)throw new ActionRequired('auth_required','The current Telegram account differs from this source binding. Create a new scan for another account.');
}
// Engine maximum: main list then archive, paged by the engine.
const DIRECTORY_LIMIT=5000,DIRECTORY_OUTPUT=16*1024*1024;
export const TELEGRAM_DOWNLOAD_CHUNK=20;
// Message export budget grows with the requested count (10000 messages: ~12 min, 160 MiB) instead of a fixed 2 min/16 MiB.
const exportBudget=count=>({timeoutMs:Math.min(1800000,120000+count*60),maxFileBytes:Math.min(256*1024*1024,Math.max(16*1024*1024,count*16*1024))});
// Download refresh: one export per chunk of at most REFRESH_BATCH selected IDs spanning at most REFRESH_SPAN IDs.
const REFRESH_BATCH=200,REFRESH_SPAN=5000;
function directoryLimit(source,items){
  if(source?.platform!=='telegram'||source.kind!=='chat'||typeof source.accountId!=='string'||items?.length)throw new Error('invalid_chats');
  decimal(source.accountId);
  const n=source.maxItems??0;
  if(!Number.isSafeInteger(n)||n<0)throw new Error('invalid_limit');
  return n===0?DIRECTORY_LIMIT:Math.min(n,DIRECTORY_LIMIT);
}
function directoryFrom(text,limit){
  const fail=()=>{throw new Error('invalid_chats');};
  if(typeof text!=='string'||Buffer.byteLength(text)>DIRECTORY_OUTPUT)fail();
  let data;try{data=JSON.parse(text);}catch{fail();}
  const fields=['version','type','limit','responseKind','chats','skippedCount','duplicateCount','truncated','completeness'];
  if(!data||Array.isArray(data)||Object.keys(data).some(k=>!fields.includes(k))||data.version!==1||data.type!=='chats'||data.limit!==limit||!['full','slice'].includes(data.responseKind)||!Array.isArray(data.chats)||data.chats.length>limit||typeof data.truncated!=='boolean'||!['complete','partial'].includes(data.completeness))fail();
  for(const field of ['skippedCount','duplicateCount'])if(!Number.isSafeInteger(data[field])||data[field]<0)fail();
  const complete=data.responseKind==='full'&&data.skippedCount===0&&data.duplicateCount===0&&!data.truncated;
  if((data.completeness==='complete')!==complete)fail();
  const seen=new Set();
  // Validate the complete finite response before a single chat event is emitted.
  const chats=data.chats.map(row=>{
    if(!row||Array.isArray(row)||Object.keys(row).some(k=>!['peer_type','id','title','username'].includes(k))||typeof row.id!=='string'||typeof row.title!=='string'||!row.title.trim()||[...row.title].length>500||/\p{Cc}/u.test(row.title))fail();
    const peer=typedPeer(`${row.peer_type}_${decimal(row.id)}`),id=`${peer.peerType}_${peer.selector}`;
    if(seen.has(id))fail();seen.add(id);
    const chat={id,title:row.title};
    if(row.username!==undefined){if(typeof row.username!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(row.username))fail();chat.username=row.username;}
    return chat;
  });
  return {chats,completeness:data.completeness};
}
export function telegramAdapter({session=withEngineSession,decode=decodeThumbnails}={}) {
  async function identity(ctx,s) {
    const r=await s.run(['umh','identity'],{timeoutMs:120000,maxOutput:65536});
    const account=accountFrom(r.stdout);matchAccount(account,ctx.request.source);await ctx.emit('account',account);return account;
  }
  // range [first,last] exports every message of one chat in that ID span in one engine call.
  async function exportItems(ctx,s,source,{previews=true,range}={}) {
    const selector=telegramSource(source), file=path.join(s.work,`export-${randomUUID()}.json`);
    const args=['chat','export','--strict-peer','-c',selector.selector];
    if(selector.peerType)args.push('--peer-type',selector.peerType);
    if(selector.topicId)args.push('--topic',selector.topicId);
    if(range)args.push('-T','id','-i',`${range[0]},${range[1]}`);
    else if(selector.messageId)args.push('-T','id','-i',`${selector.messageId},${selector.messageId}`);
    else args.push('-T','last','-i',String(Math.min(source.maxItems || 10000,10000)+1));
    args.push('--raw','--with-content','-o',file);
    const budget=exportBudget(range?range[1]-range[0]+1:selector.messageId?1:Math.min(source.maxItems || 10000,10000)+1);
    await s.run(args,{timeoutMs:budget.timeoutMs,maxOutput:1024*1024,outputFile:file,maxFileBytes:budget.maxFileBytes});
    const text=await boundedFile(file,budget.maxFileBytes), raw=parseLossless(text);
    const peer=typedPeer(`${raw.peer_type}_${decimal(raw.id)}`);
    const check=(name,extra={})=>ctx.diagnostics?.add({telegramCheck:name,peerKind:selector.peerType??peer.peerType,...extra});
    if(selector.peerType && (peer.peerType!==selector.peerType || peer.selector!==selector.selector)){check('peer_mismatch');throw new ActionRequired('input_required','Telegram resolved a different chat; no messages were accepted.');}
    const expected=sourcePeerConstraint(source);
    if(expected && (expected.peerType!==peer.peerType||expected.selector!==peer.selector)){check('public_peer_mismatch');throw new ActionRequired('input_required','The public Telegram source resolved a different typed chat.');}
    const normalized=telegramExport(text,{chatTitle:source.label});let items=normalized.items;
    if(range)return {items,mediaTypes:normalized.mediaTypes,completeness:'partial',truncated:false};
    if(selector.messageId)items=items.filter(i=>i.messageId===selector.messageId);
    if(selector.messageId&&!items.length){check('message_missing',{entryCount:Math.min(normalized.items.length,1000)});throw new ActionRequired('input_required','The exact Telegram message was not returned. Check access and the message/topic identity before rescanning.');}
    const limit=Math.min(source.maxItems || 10000,10000), truncated=items.length>limit;
    items=items.slice(0,limit);
    const rawById=new Map(raw.messages.map(m=>[messageId(m.id),m.raw]));
    if(previews){
      const thumbnails=await decode(items.map(i=>thumbnailCandidate(rawById.get(i.messageId))),{root:s.home,signal:ctx.signal});
      items=items.map((i,n)=>({...i,...(thumbnails[n]?{thumbnailUrl:thumbnails[n]}:{})}));
    }
    return {items,mediaTypes:normalized.mediaTypes,completeness:selector.messageId && items.length===1 && items[0].mediaResolved?'complete':'partial',truncated};
  }
  async function loginAttempt(ctx,qrMode=false) {
    if(qrMode&&ctx.request.source.platform!=='telegram')throw new Error('invalid_operation');
    return engineAction(ctx,()=>session(ctx,'telegram',async s=>{
      const seen=new Set();let qrSeen=false,promptSeen=false,accountSeen=false;
      const r=await s.run(['umh',qrMode?'login-qr':'login'],{timeoutMs:600000,maxOutput:65536,onLine:async(line,write,signal)=>{
        ctx.signal?.throwIfAborted();const e=JSON.parse(line);
        if(e.version!==1)throw new Error('invalid_machine_output');
        if(e.type==='qr'){
          if(!qrMode||qrSeen||promptSeen||accountSeen)throw new Error('invalid_machine_qr');
          const qrCode=validateLoginQr(e);qrSeen=true;await ctx.emit('login_qr',{qrCode});ctx.signal?.throwIfAborted();return;
        }
        if(e.type==='account'){if(accountSeen)throw new Error('invalid_machine_output');accountFrom(line);accountSeen=true;return;}
        if(e.type==='error')return;
        if(accountSeen||e.type!=='input_required' || !/^[a-f0-9]{48}$/.test(e.promptId) || seen.has(e.promptId) || !['phone','code','password'].includes(e.field) || e.inputType!==(e.field==='phone'?'text':'password'))throw new Error('invalid_machine_prompt');
        if(qrMode&&e.field!=='password')throw new Error('invalid_machine_prompt');
        promptSeen=true;seen.add(e.promptId);
        // Register before emitting, since the host may respond immediately.
        const inputId=randomUUID();let delivery;
        if(e.delivery!=null){const d=e.delivery;if(e.field!=='code'||!['app','sms','call'].includes(d.method)||!['sms','call','unsupported',undefined].includes(d.nextMethod)||!(d.timeoutSeconds==null||Number.isInteger(d.timeoutSeconds)&&d.timeoutSeconds>=0&&d.timeoutSeconds<=600)||!Number.isInteger(d.resendsRemaining)||d.resendsRemaining<0||d.resendsRemaining>3)throw new Error('invalid_machine_prompt');delivery={method:d.method,nextMethod:d.nextMethod,timeoutSeconds:d.timeoutSeconds??undefined,resendsRemaining:d.resendsRemaining};}
        const pending=ctx.controls.waitFor(['input','resend'],signal,c=>c.inputId===inputId);void pending.catch(()=>{});
        const received=Date.now();
        await ctx.emit('needs_action',{code:'input_required',awaitingInput:true,inputId,delivery,inputType:e.inputType,prompt:e.field==='phone'?'Phone number including country code':e.field==='code'?'Telegram login code':'Telegram two-step verification password'});
        const input=await pending;
        if(input.command==='resend'){
          if(!delivery||!['sms','call'].includes(delivery.nextMethod)||delivery.timeoutSeconds==null||delivery.resendsRemaining<=0||Date.now()-received<delivery.timeoutSeconds*1000)throw new ActionRequired('resend_unavailable','服务器重发条件未满足。');
          await write(JSON.stringify({promptId:e.promptId,action:'resend'})+'\n');
        }else{
          if(!input.text||input.text.length>4096||/[\x00-\x1f\x7f]/.test(input.text))throw new Error('invalid_input');
          await write(JSON.stringify({promptId:e.promptId,text:input.text})+'\n');
        }
      }});
      ctx.signal?.throwIfAborted();const account=accountFrom(r.stdout);matchAccount(account,ctx.request.source);await ctx.emit('account',account);
      return {status:'completed',completeness:'unknown'};
    }));
  }
  return {
    login:ctx=>loginAttempt(ctx),
    loginQr:ctx=>loginAttempt(ctx,true),
    scan:async ctx=>{
      telegramSource(ctx.request.source); // validate before any authenticated callback/process
      return engineAction(ctx,()=>session(ctx,'telegram',async s=>{
        await identity(ctx,s);const result=await exportItems(ctx,s,ctx.request.source);
        for(const item of result.items){ctx.signal?.throwIfAborted();await ctx.emit('item',{item});}
        return {status:'completed',completeness:result.completeness,reasonCode:result.completeness==='partial'?(result.truncated?(ctx.request.source.maxItems?'item_limit':'scan_boundary'):'history_unproven'):undefined,message:result.completeness==='partial'?(result.truncated?(ctx.request.source.maxItems && ctx.request.source.maxItems<=10000?'The selected item limit was reached. Raise the limit or narrow this source and scan again.':'The 10,000-message scan boundary was reached. Choose a topic or specific message to narrow the source.'):'Only returned media are shown. The engine provides no full-history terminal proof; narrow to a topic or message if content is missing.'):undefined};
      }));
    },
    listChats:async ctx=>{
      const limit=directoryLimit(ctx.request.source,ctx.request.items);ctx.signal?.throwIfAborted();
      return engineAction(ctx,()=>session(ctx,'telegram',async s=>{
        await identity(ctx,s);ctx.signal?.throwIfAborted();
        const r=await s.run(['umh','chats','--limit',String(limit)],{timeoutMs:330000,maxOutput:DIRECTORY_OUTPUT});
        ctx.signal?.throwIfAborted();const result=directoryFrom(r.stdout,limit);
        for(const chat of result.chats){ctx.signal?.throwIfAborted();await ctx.emit('chat',{chat});}
        ctx.signal?.throwIfAborted();
        return {status:'completed',completeness:result.completeness,reasonCode:result.completeness==='partial'?'history_unproven':undefined,message:`本次最多读取 ${limit} 个聊天（含已归档），未展开话题。目录${result.completeness==='complete'?'返回完整':'仅返回部分结果'}，不代表消息历史完整；未找到时可粘贴聊天或话题链接。`};
      }));
    },
    download:async ctx=>{
      const selected=(ctx.request.items??[]).filter(i=>i.selected!==false && (!i.mediaResolved || i.media.length));
      if(!selected.length)return {status:'completed',completeness:'unknown'};
      for(const i of selected){typedPeer(i.chatId);messageId(i.messageId);}
      if(!ctx.request.source.accountId)return engineAction(ctx,async()=>{throw new ActionRequired('auth_required','Rescan this Telegram source to bind a verified account before downloading.');});
      return engineAction(ctx,()=>session(ctx,'telegram',async s=>{
        await identity(ctx,s);const resolved=[],mediaTypes=new Map();
        // Persisted assets cannot encode photo-vs-document reliably, so selected messages are
        // refreshed for current exact engine size/type evidence. One ranged export per chunk of
        // nearby IDs in one chat (not one engine call per message, which Telegram rate-limits).
        const chunks=[];
        for(const chatId of [...new Set(selected.map(i=>i.chatId))]){
          const ids=selected.filter(i=>i.chatId===chatId).map(i=>Number(i.messageId)).sort((a,b)=>a-b);let chunk=null;
          for(const id of ids){if(!chunk||id-chunk.first>REFRESH_SPAN||chunk.count>=REFRESH_BATCH){chunk={chatId,first:id,last:id,count:0};chunks.push(chunk);}chunk.last=id;chunk.count++;}
        }
        const refreshed=new Map();
        for(const chunk of chunks){
          ctx.signal?.throwIfAborted();
          const result=await exportItems(ctx,s,{...ctx.request.source,kind:'single',url:'https://t.me/',chatId:chunk.chatId,messageId:String(chunk.first),topicId:undefined},{previews:false,range:[chunk.first,chunk.last]});
          for(const i of result.items)if(i.chatId===chunk.chatId)refreshed.set(i.key,{item:i,mediaType:result.mediaTypes.get(i.key)});
        }
        for(const item of selected){
          ctx.signal?.throwIfAborted();
          const hit=refreshed.get(`telegram:${item.chatId}:${item.messageId}`),fresh=hit?.item,result={mediaTypes:new Map(hit?[[fresh.key,hit.mediaType]]:[])};
          if(!fresh){ctx.diagnostics?.add({telegramCheck:'message_missing',peerKind:typedPeer(item.chatId).peerType,entryCount:0});throw new ActionRequired('input_required','The exact Telegram message was not returned. Check access and the message/topic identity before rescanning.');}
          if(!fresh?.mediaResolved){ctx.diagnostics?.add({telegramCheck:'media_unresolved',peerKind:typedPeer(item.chatId).peerType,entryCount:Math.min(fresh?.media?.length??0,1000)});throw new ActionRequired('input_required','The selected Telegram message has no supported resolvable image/video metadata.');}
          const allowed=applyMediaSelection(item,fresh);await ctx.emit('item',{item:allowed});
          const reused=await tryReuseAsset({root:ctx.paths.downloadRoot,category:ctx.paths.category,folder:ctx.paths.folder,item:allowed,asset:allowed.media[0],signal:ctx.signal});
          if(reused){ctx.signal?.throwIfAborted();await ctx.emit('receipt',{receipt:reused});}
          else{resolved.push(allowed);mediaTypes.set(allowed.key,result.mediaTypes.get(allowed.key));}
        }
        const groups=telegramSelected(resolved,mediaTypes);
        // Large chats: download and publish in chunks, so a late failure or timeout keeps every finished chunk.
        const batches=groups.flatMap(group=>{const chatItems=resolved.filter(i=>i.chatId===`${group.peerType}_${group.selector}`),out=[];for(let at=0;at<chatItems.length;at+=TELEGRAM_DOWNLOAD_CHUNK)out.push(chatItems.slice(at,at+TELEGRAM_DOWNLOAD_CHUNK));return out;});
        for(const groupItems of batches){
          const [chunk]=telegramSelected(groupItems,mediaTypes);if(!chunk)continue;
          await preflight(ctx.paths??ctx.request.paths,groupItems.flatMap(i=>i.media),true);
          const name=`selected-${randomUUID()}.json`,file=await s.write(name,chunk.json);
          await withMediaStage(ctx,async stage=>{
            // Pacing of the proven standalone tool: 2 threads per file, 2 files at once, 200 ms between files.
            await s.run(['download','--strict-peer','--restart','-f',file,'-d',stage,'--template','{{ .MessageID }}','-t','2','-l','2','--delay','200ms'],{timeoutMs:3600000,maxOutput:1024*1024,spaceRoot:ctx.paths.downloadRoot,floodWait:'wait'});
            const names=await readdir(stage),expected=new Set(groupItems.map(i=>i.messageId));
            if(names.some(n=>!expected.has(n)))throw new Error('unexpected_engine_output');
            for(const item of groupItems){
              ctx.signal?.throwIfAborted();
              const asset=item.media[0];
              const receipt=await publishEngineFile({root:ctx.paths.downloadRoot,category:ctx.paths.category,folder:ctx.paths.folder,dataRoot:ctx.paths.dataRoot,source:path.join(stage,item.messageId),item,asset,signal:ctx.signal,onProgress:bytes=>ctx.emit('progress',{phase:'download',bytes})});
              await ctx.emit('receipt',{receipt});
            }
          });
        }
        return {status:'completed',completeness:'unknown'};
      }));
    },
  };
}
const adapter=telegramAdapter();
export const {login,loginQr,scan,download,listChats}=adapter;
