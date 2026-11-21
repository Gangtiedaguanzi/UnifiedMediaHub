import path from "node:path";
import { mkdir, lstat } from "node:fs/promises";
export function contentKey(item) {
  if (!["x", "telegram", "douyin", "xiaohongshu"].includes(item.platform))
    throw new Error("invalid_identity");
  const valid = (x) =>
    typeof x === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(x);
  if (item.platform === "telegram") {
    if (
      !/^(user|chat|channel)_[1-9]\d{0,18}$/.test(item.chatId ?? '') ||
      BigInt(item.chatId.split('_')[1]) > 9223372036854775807n ||
      typeof item.messageId !== "string" ||
      !/^[1-9]\d{0,9}$/.test(item.messageId) ||
      BigInt(item.messageId) > 2147483647n
    )
      throw new Error("invalid_identity");
    return `telegram:${item.chatId.toLowerCase()}:${item.messageId}`;
  }
  if (!valid(item.contentId)) throw new Error("invalid_identity");
  return `${item.platform}:${item.contentId}`;
}
export function safeSegment(text,maxChars,fallback){
  let value=[...String(text??'').replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g,'').replace(/\s+/gu,' ').trim().replace(/[ .]+$/g,'')].slice(0,maxChars).join('').replace(/[ .]+$/g,'');
  if(!value)return fallback;
  if(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value.split('.')[0]))value='_'+value;
  return value;
}
export function validCategory(text){
  if(text===undefined||text==='')return '';
  if(typeof text!=='string')throw new Error('invalid_category');
  const clean=safeSegment(text,40,'');
  if(!clean||clean!==text)throw new Error('invalid_category');
  return clean;
}
// One folder per download task (named by the hub, e.g. "我的喜欢_账号_2026-11-19_2005").
export function validTaskFolder(text){
  if(text===undefined||text===null||text==='')return '';
  if(typeof text!=='string')throw new Error('invalid_folder');
  const clean=safeSegment(text,80,'');
  if(!clean||clean!==text)throw new Error('invalid_folder');
  return clean;
}
export function relativeMediaPath(item, asset, {category='',root='',folder=''}={}) {
  const key = contentKey(item);
  if (!Number.isInteger(asset.index) || asset.index < 1)
    throw new Error("invalid_index");
  let ext = String(asset.extension ?? "").replace(/^\.+/, "");
  if (!/^[a-zA-Z0-9]{1,10}$/.test(ext)) ext = "bin";
  const identity = key
    .slice(item.platform.length + 1)
    .replaceAll(":", "_")
    .slice(0, 64);
  category=validCategory(category);folder=validTaskFolder(folder);
  const date=typeof item.createdAt==='string'?new Date(item.createdAt):new Date(NaN);
  const two=n=>String(n).padStart(2,'0');
  if(folder){
    // Flat: every file of the task in one folder; names sort by publish time (local clock).
    const stamp=Number.isFinite(date.valueOf())?`${String(date.getFullYear()).padStart(4,'0')}-${two(date.getMonth()+1)}-${two(date.getDate())}_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`:'无日期';
    let author=safeSegment(item.author,40,'未知作者'),title=safeSegment(item.title,40,'无标题');
    const name=()=>item.platform==='telegram'
      ?`${stamp}_${String(item.messageId??'').replace(/\D/g,'').slice(0,20)||'0'}${asset.index>1?`_${two(asset.index)}`:''}.${ext.toLowerCase()}`
      :`${stamp}_${author}_${title}_${identity}_${two(asset.index)}.${ext.toLowerCase()}`;
    const render=()=>path.join(category,item.platform,folder,name());
    let relative=render();
    if(path.join(root,relative).length>240){title=safeSegment(title,10,'无标题');relative=render();}
    if(path.join(root,relative).length>240){author=safeSegment(author,10,'未知作者');relative=render();}
    if(path.join(root,relative).length>240)throw new Error('path_too_long');
    return relative;
  }
  if(item.platform==='telegram'){
    // As in the standalone Telegram tool: one folder per chat (title + typed chat ID), and file
    // names that sort by send time in the local clock, then message ID.
    const chat=String(item.chatId??'').replace(/[^A-Za-z0-9_]/g,'').slice(0,40)||'chat';
    const message=String(item.messageId??item.contentId??'').replace(/\D/g,'').slice(0,20)||'0';
    const stamp=Number.isFinite(date.valueOf())?`${String(date.getFullYear()).padStart(4,'0')}${two(date.getMonth()+1)}${two(date.getDate())}_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`:'无日期';
    const name=`${stamp}_${message}${asset.index>1?`_${two(asset.index)}`:''}.${ext.toLowerCase()}`;
    let title=safeSegment(String(item.author??'').replace(/[<>:"/\\|?*]/g,'_'),40,'');
    const render=()=>path.join(category,'telegram',title?`${title}_${chat}`:chat,name);
    let relative=render();
    if(path.join(root,relative).length>240){title=safeSegment(title,10,'');relative=render();}
    if(path.join(root,relative).length>240)throw new Error('path_too_long');
    return relative;
  }
  let author=safeSegment(item.author,40,'未知作者'),title=safeSegment(item.title,40,'无标题');
  const day=Number.isFinite(date.valueOf())?`${String(date.getFullYear()).padStart(4,'0')}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`:'无日期';
  const render=()=>path.join(category,item.platform,author,`${day}_${title}_${identity}`,`${String(asset.index).padStart(2,'0')}.${ext.toLowerCase()}`);
  let relative=render();
  if(path.join(root,relative).length>240){title=safeSegment(title,10,'无标题');relative=render();}
  if(path.join(root,relative).length>240){author=safeSegment(author,10,'未知作者');relative=render();}
  if(path.join(root,relative).length>240)throw new Error('path_too_long');
  return relative;
}
// Walk every existing ancestor; junctions and symlinks are forbidden for roots and descendants.
export async function rejectLinks(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("unsafe_link");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
export async function safeDirectory(target) {
  await rejectLinks(target);
  await mkdir(target, { recursive: true });
  await rejectLinks(target);
  return target;
}
