const parts=new Set('aweme v1 v2 v3 web api sns user profile self detail note feed listcollection post user_posted favorite like collect page me video slides share explore discovery item jingxuan discover search_result'.split(' '));
const fields=new Set('status_code status_msg aweme_detail aweme_list data items notes note_card code success has_more cursor log_pb extra filter_list'.split(' '));
const enums={status:['idle_timeout'],telegramCheck:['peer_mismatch','public_peer_mismatch','message_missing','media_unresolved'],peerKind:['user','chat','channel'],xVerify:['no_viewer','ui_missing','blocked','rate_limited','navigation_count','viewer_conflict','cookie_missing','cookie_mismatch','binding_mismatch'],method:['GET','POST'],listVerdict:['accepted','rejected_frame','rejected_subject','rejected_origin','rejected_credentials','rejected_subject_count','rejected_subject_value','rejected_snapshot_subject','rejected_current_subject','rejected_cursor','rejected_method','not_ready','stale_generation','not_belongs','payload_invalid','body_limit','tab_unconfirmed'],originFamily:['www.douyin.com','douyin.com','iesdouyin.com','www.xiaohongshu.com','xiaohongshu.com','edith.xiaohongshu.com','webapi.rednote.com','other'],reason:['completed','history_unproven','item_limit','scan_boundary','work_unresolved','challenge','rate_limited','auth_required','identity_unverified','source_changed','browser_closed','source_tab_required','manual_wait_timeout','input_required','cancelled','operation_failed']};
import {bounded} from './source-observation.mjs';
export function diagnosticPath(raw){
 if(typeof raw!=='string'||raw.length>16384)return undefined;
 try{const u=new URL(raw,'https://diagnostic.invalid');return u.pathname.split('/').map(p=>!p?'':parts.has(p)?p:':id').join('/');}catch{return undefined;}
}
export function diagnosticEntry(raw){
 if(!raw||typeof raw!=='object')return null;
 const out={};
 for(const key of ['path','finalPath','snapshotPath']){const value=diagnosticPath(raw[key]);if(value)out[key]=value;}
 if(typeof raw.host==='string'&&/^(?:[a-z0-9-]+\.)*(?:douyinvod\.com|douyinpic\.com|byteimg\.com|xhscdn\.com|twimg\.com|zjcdn\.com)$/.test(raw.host)){
  // Domain families give useful routing evidence without arbitrary subdomain IDs.
  out.host=raw.host.match(/(?:douyinvod|douyinpic|byteimg|xhscdn|twimg|zjcdn)\.com$/)[0];
 }
 for(const [key,min,max] of [['status',100,599],['attempt',1,8],['requestOrdinal',1,1024],['requestSubjectLength',0,256],['sourceSubjectLength',0,256],['accountIdLength',0,256],['embeddedScanned',0,1000],['rscRowsParsed',0,50],['awemeType',0,10000],['mediaType',0,10000],['imageCount',0,200],['liveVideoCount',0,200],['unknownFieldCount',0,10000],['entryCount',0,1000],['unsupportedMedia',0,100000],['rounds',0,500],['scrolls',0,500],['published',0,10000]])if(Number.isInteger(raw[key])&&raw[key]>=min&&raw[key]<=max)out[key]=raw[key];
 for(const key of ['operationStarted','scanExpired','hasAwemeDetail','hasLiveVideo','unresolved','jsonObserved','sourceChanged','bodyUnavailable','bodyTooLarge','wrapperFound','detailFound','hasMore','tabConfirmed','listEndSeen','manualWait','requestSubjectIsSource','requestSubjectIsAccount','sourceSubjectIsAccount','snapshotHasWork','snapshotHostAllowed','snapshotSubjectIsSource'])if(typeof raw[key]==='boolean')out[key]=raw[key];
 for(const [key,allowed] of Object.entries(enums))if(allowed.includes(raw[key]))out[key]=raw[key];
 // Worker failure codes are identifiers from code literals; anything with spaces, paths or digits-only is dropped.
 for(const key of ['failure','engineCode'])if(typeof raw[key]==='string'&&/^[a-z][a-z_]{2,40}$/.test(raw[key]))out[key]=raw[key];
 if(typeof raw.xEngineError==='string'&&/^[A-Za-z]{3,40}$/.test(raw.xEngineError))out.xEngineError=raw.xEngineError;
 if(['single','profile','saved','liked'].includes(raw.xSourceKind))out.xSourceKind=raw.xSourceKind;
 if(typeof raw.unsupportedExt==='string'&&/^[a-z0-9]{1,10}$/.test(raw.unsupportedExt))out.unsupportedExt=raw.unsupportedExt;
 if(typeof raw.xEngineDetail==='string'&&/^(?:rate_limit|timeline_unavailable|not_authenticated|protected|other|http_[0-9]{3})$/.test(raw.xEngineDetail))out.xEngineDetail=raw.xEngineDetail;
 if(Array.isArray(raw.topFields))out.topFields=[...new Set(raw.topFields.filter(k=>fields.has(k)))].sort().slice(0,8);
 while(Buffer.byteLength(JSON.stringify(out))>300)delete out[Object.keys(out).at(-1)];
 return Object.keys(out).length?out:null;
}
export class DiagnosticCollector{
 #entries=[];#pending=new Set();#seen=new WeakSet();#closed=false;
 add(raw){if(this.#closed||this.#entries.length>=200)return false;const entry=diagnosticEntry(raw);if(!entry)return false;this.#entries.push(entry);return true;}
 // Correlated list records must fit together, leaving one final summary slot.
 addGroup(raws){if(this.#closed||!Array.isArray(raws)||raws.length<1||raws.length>3||this.#entries.length+raws.length>199)return false;const entries=raws.map(diagnosticEntry);if(entries.some(e=>!e))return false;this.#entries.push(...entries);return true;}
 addFinal(raw){if(this.#closed)return;const entry=diagnosticEntry(raw);if(entry){if(this.#entries.length<200)this.#entries.push(entry);else this.#entries[199]=entry;}}
 observeResponse(response,page){
  try{
   if(this.#closed||this.#entries.length>=199||this.#pending.size>=4||this.#seen.has(response)||response.request().frame()!==page.mainFrame()||!(response.headers()['content-type']??'').includes('json'))return;
   this.#seen.add(response);const index=this.#entries.length,base={path:response.url(),status:response.status(),jsonObserved:true};this.add(base);
   const update=value=>{if(!this.#closed)this.#entries[index]=diagnosticEntry({...base,...value});};
   const task=(async()=>{
    if(Number(response.headers()['content-length']??0)>1048576){update({bodyTooLarge:true});return;}
    const text=await bounded(()=>response.text(),undefined,2000,'diagnostic_body_timeout');
    if(Buffer.byteLength(text)>1048576){update({bodyTooLarge:true});return;}
    const data=JSON.parse(text);if(!data||typeof data!=='object'){update({bodyUnavailable:true});return;}
    const detail=data.aweme_detail,images=Array.isArray(detail?.images)?detail.images:[],keys=Object.keys(data);
    update({topFields:keys,unknownFieldCount:Math.min(10000,keys.filter(k=>!fields.has(k)).length),hasAwemeDetail:!!detail&&typeof detail==='object',awemeType:detail?.aweme_type,imageCount:Math.min(200,images.length),hasLiveVideo:images.some(i=>i?.video!=null),liveVideoCount:Math.min(200,images.filter(i=>i?.video!=null).length)});
   })().catch(()=>update({bodyUnavailable:true}));
   this.#pending.add(task);void task.finally(()=>this.#pending.delete(task));
  }catch{}
 }
 async settle(){await Promise.allSettled([...this.#pending]);}
 close(){this.#closed=true;}
 snapshot(){return structuredClone(this.#entries);}
}
