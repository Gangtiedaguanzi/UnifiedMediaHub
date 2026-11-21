import { parseLossless } from './json.mjs';
import { contentKey } from './paths.mjs';

export function decimal(value, max = 9223372036854775807n, code = 'invalid_peer') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(code);
  const s = String(value ?? '');
  if (!/^[1-9]\d{0,19}$/.test(s) || BigInt(s) > max) throw new Error(code);
  return s;
}
export const messageId = v => decimal(v, 2147483647n, 'invalid_message');
export function typedPeer(value) {
  const m = /^(user|chat|channel)_([1-9]\d{0,18})$/.exec(value ?? '');
  if (!m) throw new Error('invalid_peer');
  return { peerType: m[1], selector: decimal(m[2]) };
}
export function sourcePeer(value){return String(value).startsWith('-100')?{peerType:'channel',selector:decimal(String(value).slice(4))}:typedPeer(value);}
export function sourcePeerConstraint(source){
  if(!source.chatId)return null;
  const first=new URL(source.url).pathname.split('/').filter(Boolean)[0];
  if(first && first!=='c' && String(source.chatId).toLowerCase()===first.toLowerCase())return null;
  return sourcePeer(source.chatId);
}
export function telegramSource(source) {
  const u = new URL(source.url);
  if (!['t.me','www.t.me','telegram.me','www.telegram.me'].includes(u.hostname) || u.username || u.password || u.port || !['http:','https:'].includes(u.protocol)) throw new Error('invalid_peer');
  const parts = u.pathname.split('/').filter(Boolean);
  let result;
  if (parts[0] === 'c') {
    result = { selector: decimal(parts[1]), peerType: 'channel' };
    parts.splice(0,2);
  } else if (parts.length) {
    const selector = parts.shift();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(selector) || ['joinchat','addlist','share','s','login'].includes(selector)) throw new Error('invalid_peer');
    result = { selector };
  } else if (source.chatId) result = sourcePeer(source.chatId);
  else throw new Error('invalid_peer');
  if (source.chatId) {
    const explicit = sourcePeerConstraint(source);
    if(explicit){
    if (result.peerType && (result.peerType !== explicit.peerType || result.selector !== explicit.selector)) throw new Error('peer_mismatch');
    // Public names resolve to a typed identity in the export; checked after export.
    if (!parts.length && !u.pathname.split('/').filter(Boolean).length) result = explicit;
    }
  }
  if (parts.length > 2) throw new Error('invalid_message');
  if (parts.length === 2) result.topicId = messageId(parts.shift());
  if (parts.length) result.messageId = messageId(parts.shift());
  for (const [field,value] of [['messageId',source.messageId],['topicId',source.topicId],['topicId',u.searchParams.get('topic')],['topicId',u.searchParams.get('thread')]]) {
    if (value != null && value !== '') {
      const id = messageId(value);
      if (result[field] && result[field] !== id) throw new Error('peer_mismatch');
      result[field] = id;
    }
  }
  if (source.kind === 'single' && !result.messageId) throw new Error('invalid_message');
  if (source.kind === 'topic' && !result.topicId) throw new Error('invalid_message');
  return result;
}
const extKinds = {jpg:'image',jpeg:'image',png:'image',webp:'image',gif:'image',mp4:'video',m4v:'video',mov:'video',webm:'video',mkv:'video'};
const bounded = (v,n=1000) => typeof v === 'string' ? v.slice(0,n) : '';
const bytes = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
// Own likes: X now rejects UserByRestId (HTTP 403) while UserByScreenName works, so use the verified
// account's screen name when known; the numeric id form stays as fallback.
const screenNameOk = v => typeof v === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(v) && !/^(i|home|explore|settings)$/i.test(v);
export function xSource(source, accountId, screenName) {
  const u = new URL(source.url);
  if (!['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com'].includes(u.hostname) || u.username || u.password || u.port) throw new Error('invalid_source');
  const p = u.pathname.replace(/\/$/,'');
  if (/^\/i\/bookmarks\//.test(p)) throw new Error('unsupported_bookmark_folder');
  if (source.kind === 'saved' && p === '/i/bookmarks') return {url:'https://x.com/i/bookmarks'};
  if (source.kind === 'liked' && ['/i/likes','/i/history/likes'].includes(p)) return {url:screenNameOk(screenName)?`https://x.com/${screenName}/likes`:`https://x.com/id:${decimal(accountId)}/likes`};
  const status = /^\/(?:[A-Za-z0-9_]+|i)\/status\/(\d+)(?:\/(photo|video)\/([1-9]\d*))?$/.exec(p);
  if (source.kind === 'single' && status) return {url:`https://x.com/i/status/${decimal(status[1],18446744073709551615n,'invalid_identity')}`,contentId:status[1],...(status[3] ? {mediaIndex:Number(status[3]),mediaKind:status[2] === 'photo'?'image':'video'} : {})};
  if (source.kind === 'profile' && /^\/[A-Za-z0-9_]+(?:\/(media|timeline|with_replies))?$/.test(p) && !/^\/(i|home|explore|settings)(\/|$)/.test(p)) return {url:`https://x.com/${p.split('/')[1]}/media`};
  if (source.kind === 'liked' && accountId && p === `/id:${accountId}/likes`) return {url:screenNameOk(screenName)?`https://x.com/${screenName}/likes`:`https://x.com${p}`};
  throw new Error('unsupported_source');
}
export function galleryItems(text) {
  const rows = parseLossless(text);
  if (!Array.isArray(rows) || rows.length > 100000) throw new Error('invalid_manifest');
  const items = new Map(), errors = [], skipped = [];
  let queued = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) throw new Error('invalid_manifest');
    if (row[0] === -1) {
      const error = row[1] ?? {};
      errors.push({type:typeof error.error === 'string' && /^[A-Za-z]{1,64}$/.test(error.error) ? error.error : 'Unknown', message:String(error.message ?? '').slice(0,300)});
      continue;
    }
    if (row[0] === 6) { queued++; continue; }
    if (row[0] !== 3) continue;
    const m = row[2] ?? {}, id = decimal(m.tweet_id,18446744073709551615n,'invalid_identity');
    const index = m.num, extension = String(m.extension ?? '').toLowerCase();
    // A media kind the program cannot save (for example a live broadcast) skips that file, not the whole list.
    if (!Number.isInteger(index) || index < 1 || index > 500 || !extKinds[extension]) { skipped.push(/^[a-z0-9]{1,10}$/.test(extension) ? extension : 'other'); continue; }
    const u = new URL(row[1]);
    if (u.protocol !== 'https:' || !['pbs.twimg.com','video.twimg.com'].includes(u.hostname) || u.username || u.password || u.port) throw new Error('invalid_media_host');
    const item = items.get(id) ?? {key:`x:${id}`,platform:'x',contentId:id,sourceUrl:`https://x.com/i/status/${id}`,title:bounded(m.content ?? m.description),author:bounded(m.author?.nick ?? m.author?.name,200),media:[],mediaResolved:true,selected:true};
    const handle=m.author?.screen_name ?? m.author?.name;
    if(typeof handle==='string' && /^[A-Za-z0-9_]{1,15}$/.test(handle) && !['i','home','explore','settings','search','notifications','messages'].includes(handle.toLowerCase()))item.authorUrl=`https://x.com/${handle}`;
    if(typeof m.date==='string'){
      const plain=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m.date);
      const date=plain?m.date.replace(' ','T')+'Z':m.date;
      if(/(?:Z|[+-]\d{2}:\d{2})$/.test(date)&&Number.isFinite(Date.parse(date))){
        const iso=new Date(date).toISOString();
        if(!plain||iso.slice(0,19)===m.date.replace(' ','T'))item.createdAt=iso;
      }
    }
    const asset = {index,kind:extKinds[extension],url:u.href,extension,expectedBytes:bytes(m.filesize),width:bytes(m.width),height:bytes(m.height)};
    const previous = item.media.find(x=>x.index===index);
    if (previous && (previous.url !== asset.url || previous.kind !== asset.kind)) throw new Error('conflicting_media');
    if (!previous) item.media.push(asset);
    if (asset.kind === 'image' && !item.thumbnailUrl && u.hostname==='pbs.twimg.com' && u.pathname.startsWith('/media/')) {
      const preview=new URL(u);preview.searchParams.set('name','small');item.thumbnailUrl=preview.href;
    }
    items.set(id,item);
  }
  return {items:[...items.values()].map(item=>({...item,media:item.media.sort((a,b)=>a.index-b.index)})),errors,queued,skipped};
}
function photoSizeEvidence(photo) {
  if(!Array.isArray(photo?.Sizes) || !photo.Sizes.length)return null;
  // Pinned tdl GetPhotoSize selects the final entry, not largest-by-byte-size.
  const selected=photo.Sizes.at(-1);
  if(!selected || typeof selected.Type!=='string' || !/^[A-Za-z0-9]{1,8}$/.test(selected.Type) || ['i','j'].includes(selected.Type))return null;
  const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
  if(Object.hasOwn(selected,'Sizes')){
    if(Object.hasOwn(selected,'Size') || !Array.isArray(selected.Sizes) || !selected.Sizes.length || !selected.Sizes.every((v,i,a)=>positive(v)&&(i===0||v>a[i-1])))return null;
    return selected.Sizes.at(-1);
  }
  return positive(selected.Size)?selected.Size:null;
}
// chatTitle (the directory label) becomes each item's author, which names its per-chat folder.
export function telegramExport(text,{chatTitle=''}={}) {
  const author=typeof chatTitle==='string'?[...chatTitle.replace(/\p{Cc}/gu,'').trim()].slice(0,200).join(''):'';
  const root = parseLossless(text), id = decimal(root.id);
  if (!['user','chat','channel'].includes(root.peer_type) || !Array.isArray(root.messages) || root.messages.length > 100000) throw new Error('invalid_manifest');
  const chatId = `${root.peer_type}_${id}`, seen = new Set();
  const mediaTypes=new Map();
  const items=root.messages.map(m=> {
    const mid = messageId(m.id);
    if (seen.has(mid)) throw new Error('conflicting_media');
    seen.add(mid);
    const raw = m.raw?.Media, document = raw?.Document, photo = raw?.Photo;
    const photoBytes=photoSizeEvidence(photo);
    const hasPhoto=!!photo&&!document;
    let kind = hasPhoto&&photoBytes!=null ? 'image' : !photo&&/^video\//.test(document?.MimeType ?? '') ? 'video' : !photo&&/^image\//.test(document?.MimeType ?? '') ? 'image' : null;
    const ext = /\.([a-zA-Z0-9]{1,10})$/.exec(m.file ?? '')?.[1]?.toLowerCase();
    // MIME is authoritative. Unsupported documents are not inferred to be videos from filenames.
    const resolved = !!kind;
    const extension = hasPhoto ? 'jpg' : extKinds[ext] === kind ? ext : kind === 'video' ? 'mp4' : kind === 'image' ? 'jpg' : 'bin';
    const item = {key:`telegram:${chatId}:${mid}`,platform:'telegram',contentId:mid,chatId,messageId:mid,sourceUrl:root.peer_type === 'channel' ? `https://t.me/c/${id}/${mid}` : '',title:bounded(m.text),author,mediaResolved:resolved,selected:resolved,media:kind ? [{index:1,kind,url:null,extension,expectedBytes:hasPhoto?photoBytes:bytes(document?.Size),width:null,height:null}] : []};
    if(Number.isSafeInteger(m.date)&&m.date>0&&m.date<=2147483647)item.createdAt=new Date(m.date*1000).toISOString();
    if(resolved)mediaTypes.set(item.key,hasPhoto?'photo':'document');
    return item;
  });
  return {items,mediaTypes};
}
export const telegramItems=text=>telegramExport(text).items;
export function telegramSelected(items,mediaTypes) {
  const groups = new Map();
  for (const item of items) {
    if (item.selected === false || (item.mediaResolved && !item.media.length)) continue;
    const peer = typedPeer(item.chatId), mid = messageId(item.messageId);
    if (item.contentId !== mid || item.key !== contentKey(item) || !item.mediaResolved || item.media.length !== 1 || item.media[0].index !== 1) throw new Error('invalid_selection');
    const group = groups.get(item.chatId) ?? {...peer,ids:new Set(),messages:[]};
    if (group.ids.has(mid)) throw new Error('invalid_selection');
    group.ids.add(mid);
    const mediaType=mediaTypes?.get(item.key);
    if(!['photo','document'].includes(mediaType) || (mediaType==='photo' && (item.media[0].kind!=='image' || !Number.isSafeInteger(item.media[0].expectedBytes) || item.media[0].expectedBytes<=0)))throw new Error('invalid_selection');
    const field = mediaType==='photo'?'photo':'file';
    group.messages.push(`{"id":${mid},"type":"message","${field}":"selected"}`);
    groups.set(item.chatId,group);
  }
  return [...groups.values()].map(g=>({peerType:g.peerType,selector:g.selector,json:`{"id":${g.selector},"peer_type":${JSON.stringify(g.peerType)},"messages":[${g.messages.join(',')}]}`}));
}
