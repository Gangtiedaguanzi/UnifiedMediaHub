import {normalizeDouyin} from './normalizers.mjs';
import {MAX_BRIDGE_ITEM_LINE} from './protocol.mjs';
export const bridgeMediaHosts=['douyin.com','iesdouyin.com','douyinvod.com','douyinpic.com','byteimg.com','pstatp.com','ibytedtos.com','bytetos.com','zjcdn.com'];
export function safeBridgeMedia(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&bridgeMediaHosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h));}catch{return false;}}
export function safeBridgeThumbnail(raw){if(typeof raw!=='string'||raw.length>36000||!safeBridgeMedia(raw))return false;const host=new URL(raw).hostname;return ['douyinpic.com','byteimg.com','pstatp.com','ibytedtos.com'].some(h=>host===h||host.endsWith('.'+h));}
export function validateBridge(p){
 const object=x=>x&&typeof x==='object'&&!Array.isArray(x),keys=(x,allowed)=>object(x)&&Object.keys(x).every(k=>allowed.includes(k));
 // saved_folder: one opened 收藏夹, optionally named; never broadened to all favorites.
 const folderOk=p?.folder===undefined||p.listKind==='saved_folder'&&keys(p.folder,['title','id'])&&typeof p.folder.title==='string'&&p.folder.title.trim()!==''&&p.folder.title.length<=256&&!/[\u0000-\u001f\u007f]/.test(p.folder.title)&&(p.folder.id===undefined||typeof p.folder.id==='string'&&/^\d{1,24}$/.test(p.folder.id));
 if(!keys(p,['bridgeVersion','platform','listKind','page','viewer','owner','items','folder'])||!folderOk||p.bridgeVersion!=='1'||p.platform!=='douyin'||!['liked','saved','profile','saved_folder'].includes(p.listKind)||!keys(p.page,['path','tab'])||!/^\/user\/[A-Za-z0-9_-]{1,200}\/?$/.test(p.page.path??'')||p.page.tab!=={liked:'like',saved:'favorite_collection',profile:'post',saved_folder:'favorite_folder'}[p.listKind]||!Array.isArray(p.items)||p.items.length<1||p.items.length>1000||Buffer.byteLength(JSON.stringify(p))>8*1024*1024)throw new Error('invalid_bridge');
 for(const person of [p.viewer,p.owner])if(person!==undefined&&(!keys(person,['secUid','nickname','uniqueId'])||typeof person.secUid!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(person.secUid)||['nickname','uniqueId'].some(k=>person[k]!==undefined&&(typeof person[k]!=='string'||person[k].length>200||/[\u0000-\u001f\u007f]/.test(person[k])))))throw new Error('invalid_bridge');
 const seen=new Set();for(const entry of p.items){const oversized=entry.oversized===true;if(!keys(entry,oversized?['hrefId','oversized']:['hrefId','aweme'])||typeof entry.hrefId!=='string'||!/^\d{1,32}$/.test(entry.hrefId)||seen.has(entry.hrefId)||(!oversized&&(!object(entry.aweme)||Buffer.byteLength(JSON.stringify(entry.aweme))>256*1024)))throw new Error('invalid_bridge');seen.add(entry.hrefId);}return p;
}
export async function importBridge(ctx){
 if(ctx.request.source.platform!=='douyin'||ctx.request.source.kind!=='bridge')throw new Error('invalid_bridge');const payload=validateBridge(ctx.request.bridgePayload);
 for(const {hrefId,aweme,oversized} of payload.items){ctx.signal.throwIfAborted();let item=oversized?null:normalizeDouyin(aweme);if(!item||item.contentId!==hrefId||!item.mediaResolved||item.media.some(a=>!safeBridgeMedia(a.url))||Buffer.byteLength(JSON.stringify(item))>MAX_BRIDGE_ITEM_LINE-1024)item={key:'douyin:'+hrefId,platform:'douyin',contentId:hrefId,sourceUrl:'https://www.douyin.com/video/'+hrefId,title:oversized?'过大，暂不支持':'需要在 Edge 重新发送',media:[],mediaResolved:false,selected:false};if(item.thumbnailUrl&&!safeBridgeThumbnail(item.thumbnailUrl))item.thumbnailUrl=null;await ctx.emit('item',{item});}
 return {status:'completed',completeness:'partial',reasonCode:'bridge_snapshot'};
}
