// Canonical bridge projection schema. root/author/image/video are object
// field paths; url repeats recursively through objects/arrays to depth6.
// Keep the standalone userscript copy identical (structural/runtime tests).
export const DOUYIN_BRIDGE_FIELDS={
 root:['aweme_id','awemeId','desc','create_time','createTime','authorInfo','author','images','video'],
 author:['secUid','sec_uid','nickname'],
 image:['urlList','url_list','downloadUrlList','download_url_list','src','url','urlDefault','urlPre','video'],
 liveVideo:['playAddr','playApi','play_addr','urlList','url_list','downloadUrlList','download_url_list','src','url','urlDefault','urlPre'],
 video:['playAddr','playApi','play_addr','cover','urlList','url_list','downloadUrlList','download_url_list','src','url','urlDefault','urlPre'],
 url:['urlList','url_list','downloadUrlList','download_url_list','src','url','urlDefault','urlPre'],
};
export function pruneDouyinForBridge(raw,spec=DOUYIN_BRIDGE_FIELDS){
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
export function id(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)
    ? value
    : Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;
}
export function url(value, base) {
  try {
    const u = new URL(value, base);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
function urls(v, depth = 0) {
  if (depth > 6 || v == null) return [];
  if (typeof v === "string") return url(v) ? [v] : [];
  if (Array.isArray(v))
    return v.slice(0, 100).flatMap((x) => urls(x, depth + 1));
  for (const k of DOUYIN_BRIDGE_FIELDS.url)
    if (v[k]) {
      const result = urls(v[k], depth + 1);
      if (result.length) return result;
    }
  return [];
}
function asset(list, kind, u, extra = {}) {
  let ext;
  try {
    ext = new URL(u).pathname.match(/\.([a-zA-Z0-9]{1,5})$/)?.[1];
  } catch {}
  list.push({
    index: list.length + 1,
    kind,
    url: u ?? null,
    extension: ext ?? (kind === "video" ? "mp4" : "jpg"),
    ...extra,
  });
}
const secondsDate=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647?new Date(v*1000).toISOString():undefined;
const millisecondsDate=v=>Number.isSafeInteger(v)&&v>=946684800000&&v<=4102444800000?new Date(v).toISOString():undefined;
const text = (x) => (typeof x === "string" ? x.slice(0, 1500) : "");
export function normalizeDouyin(raw) {
  const value=v=>typeof v==='string'&&v.startsWith('$')?undefined:v;
  const cid = id(value(raw?.aweme_id)??value(raw?.awemeId));
  if (!cid) return null;
  const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:undefined;
  const author=object(raw.authorInfo)??object(raw.author);
  const authorId = id(value(author?.secUid)??value(author?.sec_uid)??value(raw.author?.sec_uid));
  const images=Array.isArray(raw.images)?raw.images:[];
  const media = [];
  const video = (v) => urls(value(v?.playAddr))[0]??urls(value(v?.playApi))[0]??urls(value(v?.play_addr)??v)[0];
  for (const img of images.slice(0, 200)) {
    if(!object(img))continue;
    asset(media, "image", urls(img)[0]);
    if (object(img.video)) asset(media, "video", video(img.video));
  }
  if (!media.length && object(raw.video)) asset(media, "video", video(raw.video));
  return {
    key: `douyin:${cid}`,
    platform: "douyin",
    contentId: cid,
    sourceUrl: `https://www.douyin.com/${images.length ? "note" : "video"}/${cid}`,
    title: text(value(raw.desc)),createdAt:secondsDate(value(raw.create_time)??value(raw.createTime)),
    author: text(value(author?.nickname)),
    ...(authorId ? { authorUrl: `https://www.douyin.com/user/${authorId}` } : {}),
    thumbnailUrl: urls(value(raw.video?.cover) ?? images[0])[0] ?? null,
    media,
    mediaResolved: media.length > 0 && media.every((m) => m.url),
    selected: true,
  };
}
export function normalizeXhs(raw, detail = false) {
  const n = raw?.note_card ?? raw?.noteCard ?? raw;
  const authorId = id(n.user?.user_id ?? n.user?.userId);
  const cid = id(
    raw?.note_id ?? raw?.noteId ?? raw?.id ?? n?.note_id ?? n?.noteId,
  );
  if (!cid) return null;
  const media = [];
  if (detail) {
    for (const img of (n.imageList ?? n.image_list ?? []).slice(0, 200))
      asset(
        media,
        "image",
        urls(img)[0] ??
          urls(
            img.infoList?.find((x) => x.imageScene === "WB_DFT") ??
              img.infoList?.[0],
          )[0],
      );
    const v = n.video;
    // Streams were stream.h264[]; they are now grouped (EF4, EF5, ...) and may carry only backupUrls.
    // Prefer h264 for compatibility, then the tallest rendition.
    const streams=Object.values(v?.media?.stream??{}).filter(Array.isArray).flat().filter(s=>s&&typeof s==='object').slice(0,50);
    const streamUrl=s=>urls(s.masterUrl)[0]??urls(s.backupUrls)[0];
    const best=[...streams].filter(streamUrl).sort((a,b)=>(String(b.videoCodec).toLowerCase()==='h264')-(String(a.videoCodec).toLowerCase()==='h264')||(Number(b.height)||0)-(Number(a.height)||0))[0];
    let vu = urls(v)[0] ?? urls(v?.media?.stream?.h264?.[0]?.masterUrl)[0] ?? (best&&streamUrl(best));
    const origin = v?.originVideoKey ?? v?.consumer?.originVideoKey;
    if (!vu && typeof origin === "string" && /^[A-Za-z0-9_/-]+$/.test(origin))
      vu = `https://sns-video-bd.xhscdn.com/${origin}`;
    if (v) asset(media, "video", vu);
  }
  const token = raw.xsec_token ?? raw.xsecToken ?? n.xsec_token;
  const source = new URL(`https://www.xiaohongshu.com/explore/${cid}`);
  if (typeof token === "string" && token.length < 4096) {
    source.searchParams.set("xsec_token", token);
    source.searchParams.set("xsec_source", "pc_user");
  }
  return {
    key: `xiaohongshu:${cid}`,
    platform: "xiaohongshu",
    contentId: cid,
    sourceUrl: source.href,
    createdAt:millisecondsDate(n.time),
    title: text(n.display_title ?? n.displayTitle ?? n.title),
    author: text(n.user?.nickname),
    ...(authorId ? { authorUrl: `https://www.xiaohongshu.com/user/profile/${authorId}` } : {}),
    thumbnailUrl: urls(n.cover)[0] ?? null,
    media,
    mediaResolved: detail && media.length > 0 && media.every((m) => m.url),
    selected: true,
  };
}
