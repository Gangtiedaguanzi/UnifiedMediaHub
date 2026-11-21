// ==UserScript==
// @name         统一媒体管理器 · 抖音 Edge 桥接
// @namespace    local.unifiedmediahub.bridge
// @version      0.1.4
// @description  手动读取可见列表并发送到本机统一媒体管理器；不调用平台接口
// @match        https://www.douyin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addElement
// @grant        GM_info
// @connect      localhost
// @sandbox      raw
// @noframes
// @run-at       document-start
// @license      GPL-3.0-only
// ==/UserScript==
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 UnifiedMediaHub contributors. See COPYING.
(function(){
 'use strict';
 // Best-effort early captures, NOT a secrecy boundary in a shared realm.
 const apply=Reflect.apply,stringify=JSON.stringify,encode=TextEncoder.prototype.encode,
  regexTest=RegExp.prototype.test,trim=String.prototype.trim,encoder=new TextEncoder(),tokenPattern=/^[A-Za-z0-9_-]{43}$/;
 const json=value=>apply(stringify,JSON,[value]),byteLength=value=>apply(encode,encoder,[value]).length,
  trimToken=value=>apply(trim,value,[]),validToken=value=>typeof value==='string'&&apply(regexTest,tokenPattern,[value]);
 const getValue=typeof GM_getValue==='function'?GM_getValue:null,sendRequest=typeof GM_xmlhttpRequest==='function'?GM_xmlhttpRequest:null,
  setValue=typeof GM_setValue==='function'?GM_setValue:null;
 const DOUYIN_BRIDGE_FIELDS={"root":["aweme_id","awemeId","desc","create_time","createTime","authorInfo","author","images","video"],"author":["secUid","sec_uid","nickname"],"image":["urlList","url_list","downloadUrlList","download_url_list","src","url","urlDefault","urlPre","video"],"liveVideo":["playAddr","playApi","play_addr","urlList","url_list","downloadUrlList","download_url_list","src","url","urlDefault","urlPre"],"video":["playAddr","playApi","play_addr","cover","urlList","url_list","downloadUrlList","download_url_list","src","url","urlDefault","urlPre"],"url":["urlList","url_list","downloadUrlList","download_url_list","src","url","urlDefault","urlPre"]};
 function pruneDouyinForBridge(raw,spec=DOUYIN_BRIDGE_FIELDS){
 function copy(value,group,depth=0){
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(v=>copy(v,group,depth));
  const out={};if(depth>8)return out;
  for(const key of spec[group])if(Object.prototype.hasOwnProperty.call(value,key)){
   const next=group==='root'?(key==='images'?'image':['authorInfo','author'].includes(key)?'author':key==='video'?'video':'url'):group==='image'&&key==='video'?'liveVideo':'url';
   out[key]=copy(value[key],next,depth+1);
  }return out;
 }return copy(raw,'root');
}
 // Data-only MAIN_WORLD reader. It never receives pairing credentials or a
 // network API. Keep it self-contained: the isolated controller injects it.
 function readSnapshot(doc,location,limit,chosenKind,action,fields=DOUYIN_BRIDGE_FIELDS,prune=pruneDouyinForBridge,exclude=[]){
  // exclude: works already sent from this page, so a long list (1000+) can be sent in successive batches.
  const skip=new Set(Array.isArray(exclude)?exclude.filter(x=>typeof x==="string"):[]);
  const win=doc.defaultView,visible=e=>{if(!e?.isConnected||!e.getClientRects().length)return false;for(let p=e;p;p=p.parentElement){const s=win.getComputedStyle(p);if(p.hidden||p.inert||p.getAttribute('aria-hidden')==='true'||s.display==='none'||['hidden','collapse'].includes(s.visibility)||s.opacity==='0')return false;}return true;};
  const url=new URL(location.href);if(url.origin!=='https://www.douyin.com'||!/^\/user\/[A-Za-z0-9_-]{1,200}\/?$/.test(url.pathname))throw new Error('profile_required');
  // 收藏 → 收藏夹 shows the opened folder's works beside the folder column (showSubTab=favorite_folder).
  const folderView=url.searchParams.get('showTab')==='favorite_collection'&&url.searchParams.get('showSubTab')==='favorite_folder';
  const kinds={like:'liked',favorite_collection:'saved',post:'profile'},detected=folderView?'saved_folder':kinds[url.searchParams.get('showTab')],kind=detected??chosenKind;if(!['liked','saved','profile','saved_folder'].includes(kind))throw new Error('choose_kind');
  const selectors={liked:'[data-e2e="user-like-list"]',saved:'[data-e2e="user-favorite-list"]',profile:'[data-e2e="user-post-list"]'},listSelector=Object.values(selectors).join(',');
  const fiberOf=e=>e?e[Object.getOwnPropertyNames(e).find(k=>k.startsWith('__reactFiber$'))]:undefined;
  const cardSelector='.waterfall-videoCardContainer[href], [href*="/video/"][target=_blank], [href*="/note/"][target=_blank]';
  const awemeOf=props=>{for(const candidate of [props?.awemeInfo,props?.aweme_info,props?.itemInfo?.awemeInfo])if(candidate&&typeof candidate==='object')return candidate;return null;};
  let list,direct=null,folder=null,folderCards=null;
  if(kind==='saved_folder'){
   // The folder grid has no known list marker: take the visible work cards and their nearest common container.
   if(!folderView)throw new Error('visible_panel');
   let cards=[...doc.querySelectorAll(cardSelector)].filter(visible);
   if(!cards.length){
    // Cards without links: the outermost visible element whose component carries the work (id from the work itself).
    direct=new Map();let scanned=0;
    for(const e of doc.querySelectorAll('div,li,a,section')){if(++scanned>20000)break;let aweme=null;for(let f=fiberOf(e),d=0;f&&d<8&&!aweme;d++,f=f.return)aweme=awemeOf(f.memoizedProps);const id=aweme?String(aweme.awemeId??aweme.aweme_id??''):'';if(/^\d{1,32}$/.test(id)&&!direct.has(id)&&visible(e))direct.set(id,{card:e,aweme});}
    cards=[...direct.values()].map(x=>x.card);
   }
   if(!cards.length)throw new Error('folder_empty');
   folderCards=cards;list=cards[0];while(list.parentElement&&!cards.every(c=>list.contains(c)))list=list.parentElement;
   // Folder name: the open folder's own component data, else the single visibly selected entry of the folder column.
   const nameKeys=['collects_name','collectsName','collectName','folderName','folder_name'],idKeys=['collects_id_str','collects_id','collectsId','collectId','folderId'];
   const clean=v=>typeof v==='string'&&v.trim()&&v.length<=256&&!/[\u0000-\u001f\u007f]/.test(v)?v.trim():null;
   const info=o=>{if(!o||typeof o!=='object'||Array.isArray(o))return null;for(const k of nameKeys){const title=clean(o[k]);if(title){let id=null;for(const ik of idKeys){const v=o[ik];if(typeof v==='string'&&/^\d{1,24}$/.test(v)||Number.isSafeInteger(v)&&v>0){id=String(v);break;}}return id?{title,id}:{title};}}return null;};
   const fromProps=p=>{const own=info(p);if(own||!p||typeof p!=='object')return own;for(const k of Object.keys(p).slice(0,40)){const r=info(p[k]);if(r)return r;}return null;};
   for(let f=fiberOf(list),d=0;f&&d<40&&!folder;d++,f=f.return)folder=fromProps(f.memoizedProps);
   if(!folder){
    const marked=e=>{for(let n=e,d=0;n&&d<4;d++,n=n.parentElement)if(n.getAttribute?.('aria-selected')==='true'||n.getAttribute?.('aria-current')||/(^|[\s_-])(active|selected|checked|current)([\s_-]|$)/i.test(typeof n.className==='string'?n.className:''))return true;return false;};
    const found=new Map();let scanned=0;
    for(const e of doc.querySelectorAll('div,li,a')){if(++scanned>20000)break;if(folderCards.some(c=>c.contains(e)))continue;let r=null,selected=false,exact=false;for(let f=fiberOf(e),d=0;f&&d<6&&!r;d++,f=f.return){const p=f.memoizedProps;
      // Observed Douyin folder entry: {id:'<digits>', name, active:boolean, total}; active marks the open folder.
      const entry=p&&typeof p.active==='boolean'&&typeof p.id==='string'&&/^\d{1,24}$/.test(p.id)&&clean(p.name)?{title:clean(p.name),id:p.id}:null;
      r=entry??fromProps(p);if(r){exact=!!entry;selected=entry?p.active===true:!!(p&&(p.isSelected||p.selected||p.active||p.isActive||p.checked||p.isCurrent));}}
     if(r&&visible(e)){const mark=selected||!exact&&marked(e),key=r.id??r.title,prior=found.get(key);if(!prior)found.set(key,{...r,selected:mark});else if(mark)prior.selected=true;}}
    const chosen=[...found.values()].filter(x=>x.selected);if(chosen.length===1)folder=chosen[0].id?{title:chosen[0].title,id:chosen[0].id}:{title:chosen[0].title};
   }
  }else{const lists=[...doc.querySelectorAll(selectors[kind])].filter(e=>visible(e)&&(kind!=='profile'||!e.closest(selectors.saved)));if(lists.length!==1)throw new Error('visible_panel');list=lists[0];}
  const items=[],seen=new Set();let payloadBytes=0,limitedBySize=false;limit=Number.isInteger(limit)?Math.min(1000,Math.max(1,limit)):20;
  const entries=direct?[...direct.entries()].map(([hrefId,x])=>({card:x.card,hrefId,aweme:x.aweme})):(folderCards??[...list.querySelectorAll(cardSelector)]).map(card=>({card}));
  for(const {card,hrefId:knownId,aweme:knownAweme} of entries){
   if(!visible(card))continue;try{let hrefId=knownId,aweme=knownAweme;
    if(!hrefId){const href=new URL(card.getAttribute('href'),url);if(href.origin!==url.origin||href.username||href.password)continue;hrefId=href.pathname.match(/^\/(?:video|note)\/(\d{1,32})(?:\/|$)/)?.[1]??(href.searchParams.getAll('modal_id').length===1&&/^\d{1,32}$/.test(href.searchParams.get('modal_id')??'')?href.searchParams.get('modal_id'):null);if(!hrefId||seen.has(hrefId)||skip.has(hrefId))continue;
     let fiber=fiberOf(card);
     for(let depth=0;fiber&&depth<20;depth++,fiber=fiber.return){const props=fiber.memoizedProps;for(const candidate of [props?.awemeInfo,props?.aweme_info,props?.itemInfo?.awemeInfo])if(candidate&&typeof candidate==='object'&&(candidate.awemeId??candidate.aweme_id)===hrefId){aweme=candidate;break;}if(aweme)break;}
    }else if(seen.has(hrefId)||skip.has(hrefId))continue;
    if(!aweme)continue;const raw=JSON.stringify(prune(aweme,fields)),rawBytes=new TextEncoder().encode(raw).length,entry=rawBytes>256*1024?{hrefId,oversized:true}:{hrefId,aweme:JSON.parse(raw)},bytes=new TextEncoder().encode(JSON.stringify(entry)).length;if(payloadBytes+bytes+96>8*1024*1024-4096){limitedBySize=true;break;}payloadBytes+=bytes+96;items.push(entry);seen.add(hrefId);if(items.length>=limit)break;
   }catch{}
  }
  const result={bridgeVersion:'1',platform:'douyin',listKind:kind,page:{path:url.pathname,tab:{liked:'like',saved:'favorite_collection',profile:'post',saved_folder:'favorite_folder'}[kind]},items};
  if(folder)result.folder=folder;
  // The live page has no reliable viewer store. Always omit viewer; never
  // infer login identity from profile owner or card authors.
  const ownerId=url.pathname.match(/^\/user\/([^/]+)/)?.[1];if(ownerId&&ownerId!=='self')result.owner={secUid:ownerId,nickname:''};
  const route=list.closest('.parent-route-container'),endPattern=/没有更多|暂时没有更多|已经到底/;let end=endPattern.test(list.textContent??'');
  // At most two parents, at most50 sibling elements per level, never another
  // list's text or the whole document. Footer markers can sit beside the list.
  for(let branch=list,depth=0;!end&&branch.parentElement&&depth<2;depth++){const parent=branch.parentElement;for(const node of parent.childNodes){if(node.nodeType===3&&endPattern.test(node.textContent??''))end=true;}for(const sibling of [...parent.children].slice(0,50))if(sibling!==branch&&!sibling.matches(listSelector)&&!sibling.querySelector(listSelector)&&visible(sibling)&&endPattern.test(sibling.textContent??''))end=true;if(parent===route)break;branch=parent;}
  if(action==='scroll'){
   // A folder grid scrolls in its own container; other lists keep the route container.
   let scroller=null;if(kind==='saved_folder')for(let n=list;n&&n!==doc.body&&!scroller;n=n.parentElement){const s=win.getComputedStyle(n);if(/(auto|scroll)/.test(s.overflowY)&&n.scrollHeight>n.clientHeight+20)scroller=n;}
   scroller??=route??(kind==='saved_folder'?doc.scrollingElement:null);if(!scroller)throw new Error('scroll_container');scroller.scrollBy({top:Math.max(400,scroller.clientHeight*0.8),behavior:'auto'});
  }
  return {payload:result,pageKey:url.origin+url.pathname+'|'+url.searchParams.get('showTab')+'|'+kind+(kind==='saved_folder'?'|'+(folder?.id??folder?.title??''):''),end,limitedBySize};
 }
 function newBatch(){return {items:new Map(),sizes:new Map(),bytes:0,limited:false};}
 function mergeBatch(batch,items,limit){for(const item of items){if(batch.items.size>=limit&&!batch.items.has(item.hrefId))continue;const bytes=new TextEncoder().encode(JSON.stringify(item)).length,prior=batch.sizes.get(item.hrefId)??0;if(batch.bytes-prior+bytes>8*1024*1024-4096){batch.limited=true;break;}batch.items.set(item.hrefId,item);batch.sizes.set(item.hrefId,bytes);batch.bytes+=bytes-prior;}return batch;}
 const canPair=info=>['raw','js','dom'].includes(info?.sandboxMode);
 // CommonJS is for local synthetic tests only; no runtime globals/export API.
 if(typeof module==='object'&&module.exports){module.exports={readSnapshot:(...args)=>readSnapshot(...args).payload,readPage:readSnapshot,canPair,newBatch,mergeBatch,douyinFields:DOUYIN_BRIDGE_FIELDS,pruneDouyin:pruneDouyinForBridge};return;}
 if(typeof GM_info==='undefined'||!canPair(GM_info)){
  if(typeof GM_registerMenuCommand==='function')GM_registerMenuCommand('桥接不可用：未识别脚本运行环境',()=>alert('未识别脚本运行环境，未读取配对信息。请确认脚本已正确安装。'));return;
 }
 function createUi(){
 let batch=newBatch(),cached=batch.items,pageKey=null,busy=false;const sent=new Set();
 const button=document.createElement('button');button.textContent='发送到统一媒体管理器';button.style.cssText='position:fixed;right:22px;bottom:24px;z-index:2147483646;padding:12px;background:#167b87;color:white;border:0;border-radius:7px;cursor:pointer';document.body.append(button);
 const shell=document.createElement('div');shell.style.cssText='position:fixed;right:22px;bottom:76px;z-index:2147483646;width:325px;background:white;color:#18323d;padding:16px;border:1px solid #a8babd;border-radius:8px;display:none;font:14px sans-serif';
 const shadow=shell.attachShadow({mode:'closed'});document.body.append(shell);
 const title=document.createElement('strong');title.textContent='Edge 桥接 · 手动发送';shadow.append(title);
 const status=document.createElement('p');status.textContent='先打开喜欢、收藏、收藏夹或作者作品页。';shadow.append(status);
 const kind=document.createElement('select');for(const [value,label]of [['','请确认列表类型'],['liked','我的喜欢'],['saved','全部收藏'],['saved_folder','收藏夹（当前打开的）'],['profile','作者作品']]){const option=document.createElement('option');option.value=value;option.textContent=label;kind.append(option);}shadow.append(kind);
 const limit=document.createElement('input');limit.type='number';limit.min='1';limit.max='1000';limit.value='20';limit.style.cssText='width:65px;margin:10px';limit.setAttribute('aria-label','本批条数上限');shadow.append(limit);
 const count=()=>{const n=Number(limit.value);if(!Number.isInteger(n)||n<1||n>1000)throw new Error('limit');return n;};
 const names={liked:'我的喜欢',saved:'全部收藏',saved_folder:'收藏夹',profile:'作者作品'};
 function showError(error){status.textContent=({profile_required:'请打开一个抖音用户主页。',choose_kind:'请先确认列表类型。',visible_panel:'没有找到当前列表，请手动打开喜欢、收藏、收藏夹或作品列表。',folder_empty:'收藏夹里没有找到可读取的作品，请确认右侧已显示该收藏夹的作品后重新读取。',scroll_container:'未找到列表滚动容器，请手动滚动后重新读取。',limit:'条数应为1–1000。',page_changed:'页面或标签已变化，已清空本批，请重新读取。',too_large:'本批超过8 MiB，请减小条数分批发送。',reader_timeout:'页面读取超时，请确认当前页面可见；没有发送。'}[error?.message]??'操作未完成，请检查管理器总开关、桥接端口和配对信息。');}
 function read(action){if(GM_info.sandboxMode!=='dom')return Promise.resolve(readSnapshot(document,location,count(),kind.value,action,DOUYIN_BRIDGE_FIELDS,pruneDouyinForBridge,[...sent]));return new Promise((resolve,reject)=>{const nonce=crypto.randomUUID();let node;const timer=setTimeout(()=>finish(new Error('reader_timeout')),3000);function finish(error,value){clearTimeout(timer);window.removeEventListener('message',receive);node?.remove();error?reject(error):resolve(value);}function receive(event){if(event.source!==window||event.origin!==location.origin||event.data?.type!=='umh-bridge-snapshot'||event.data.nonce!==nonce)return;const value=event.data;if(value.error)return finish(new Error(value.error));try{if(byteLength(json(value.snapshot))>8*1024*1024)return finish(new Error('too_large'));finish(null,value.snapshot);}catch{finish(new Error('reader_timeout'));}}window.addEventListener('message',receive);try{node=GM_addElement('script',{textContent:`(()=>{try{const snapshot=(${readSnapshot.toString()})(document,location,${count()},${json(kind.value)},${json(action)},${json(DOUYIN_BRIDGE_FIELDS)},${pruneDouyinForBridge.toString()},${json([...sent])});window.postMessage({type:'umh-bridge-snapshot',nonce:${json(nonce)},snapshot},location.origin);}catch(e){window.postMessage({type:'umh-bridge-snapshot',nonce:${json(nonce)},error:['profile_required','choose_kind','visible_panel','folder_empty','scroll_container'].includes(e.message)?e.message:'reader_timeout'},location.origin);}})();`});if(!node)finish(new Error('reader_timeout'));}catch(e){finish(e);}});}
 async function collect(action){const snapshot=await read(action);if(pageKey&&pageKey!==snapshot.pageKey){batch=newBatch();cached=batch.items;sent.clear();pageKey=snapshot.pageKey;throw new Error('page_changed');}pageKey=snapshot.pageKey;kind.value=snapshot.payload.listKind;mergeBatch(batch,snapshot.payload.items,count());if(snapshot.limitedBySize)batch.limited=true;status.textContent=`${snapshot.payload.listKind==='saved_folder'?'收藏夹「'+(snapshot.payload.folder?.title??'未识别名称')+'」':names[kind.value]} · 已识别 ${cached.size} 条（本批上限 ${count()}）`+([...cached.values()].some(x=>x.oversized)?` · 已跳过 ${[...cached.values()].filter(x=>x.oversized).length} 个过大作品（发送占位，不用后续作品顶替）`:'')+(batch.limited?' · 本批数据达到上限，请先发送或清空后分批':'');return snapshot;}
 function control(label,action){const b=document.createElement('button');b.textContent=label;b.style.cssText='padding:8px;margin:5px 5px 0 0';b.onclick=async event=>{if(!event.isTrusted||busy)return;busy=true;try{await action();}catch(e){showError(e);}finally{busy=false;}};shadow.append(b);return b;}
 async function configure(){const port=prompt('管理器设置中显示的桥接端口（默认47631）',String(getValue('port',47631)));if(port===null)return;const parsed=Number(port);if(!Number.isInteger(parsed)||parsed<1024||parsed>65535)throw new Error('port');const input=prompt('粘贴配对令牌。同页脚本可能取得令牌；只在你信任的抖音页面使用。','');if(input===null)return;const token=trimToken(input);if(!validToken(token))throw new Error('token');setValue('port',parsed);setValue('token',token);status.textContent='配对信息已保存。';}
 GM_registerMenuCommand('配置统一媒体管理器桥接',()=>configure().catch(showError));control('配置配对',configure);control('读取当前页',()=>collect());
 control('继续加载',async()=>{let stalled=0,snapshot=await collect();for(let round=0;round<50&&cached.size<count()&&stalled<3&&!snapshot.end&&!batch.limited;round++){const before=cached.size;await collect('scroll');await new Promise(r=>setTimeout(r,1200));snapshot=await collect();stalled=cached.size===before?stalled+1:0;}status.textContent+= ' · 加载已停止';});
 control('发送',async()=>{const snapshot=await collect();const payload={...snapshot.payload,items:[...cached.values()].slice(0,count())};if(!payload.items.length){status.textContent='没有可发送的作品，请先加载列表。';return;}const data=json(payload);if(byteLength(data)>8*1024*1024)throw new Error('too_large');const token=getValue('token',''),port=getValue('port',47631);if(!validToken(token)||!Number.isInteger(port)||port<1024||port>65535){status.textContent='请先配置配对信息。';return;}await new Promise((resolve,reject)=>sendRequest({method:'POST',url:`http://localhost:${port}/bridge/v1/douyin/items`,headers:{'Content-Type':'application/json','X-UMH-Bridge-Token':token},anonymous:true,data,timeout:60000,onload:response=>{let result;try{result=JSON.parse(response.responseText);}catch{reject(new Error('send'));return;}if(response.status===200&&result.accepted===true&&Number.isInteger(result.itemCount)){for(const item of payload.items)sent.add(item.hrefId);batch=newBatch();cached=batch.items;status.textContent=`已导入 ${result.itemCount} 条（本页已发送共 ${sent.size} 条），请回管理器勾选下载。还有更多时，点“继续加载”再发送，已发过的会自动跳过。`;resolve();}else{status.textContent=({bad_token:'配对令牌已失效，请重新配置。',origin_rejected:'请求带Origin，已拒绝；请检查扩展请求方式，不要关闭管理器校验。',too_large:'本批过大，请减小上限。',busy:'管理器正在处理导入，请稍后手动发送。',disabled:'请开启管理器总开关和Edge桥接。',invalid_payload:'本批格式未通过检查，未自动重试。'}[result.code]??'导入未完成，请回管理器检查。');resolve();}},onerror:()=>reject(new Error('send')),ontimeout:()=>reject(new Error('send'))}));});
 control('清空本批',async()=>{batch=newBatch();cached=batch.items;pageKey=null;status.textContent='本批已清空。';});control('关闭面板',async()=>shell.style.display='none');button.onclick=()=>{shell.style.display=shell.style.display==='none'?'block':'none';};
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',createUi,{once:true});else createUi();
})();
