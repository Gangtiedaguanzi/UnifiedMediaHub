import path from "node:path";
import { contentKey,validCategory,validTaskFolder } from "./paths.mjs";
export const MAX_LINE = 65536;
export const MAX_BRIDGE_ITEM_LINE = 512*1024;
const hosts = {
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "t.co"],
  telegram: ["t.me", "telegram.me", "www.t.me", "www.telegram.me"],
  douyin: ["www.douyin.com", "douyin.com", "v.douyin.com", "www.iesdouyin.com", "iesdouyin.com"],
  xiaohongshu: [
    "www.xiaohongshu.com",
    "xiaohongshu.com",
    "xhslink.com",
    "www.xhslink.com",
  ],
};
export function validateSource(source) {
  if (
    !source ||
    !hosts[source.platform] ||
    ![
      "single",
      "profile",
      "saved",
      "saved_folders",
      "saved_folder",
      "liked",
      "collection",
      "chat",
      "topic",
      "bridge",
    ].includes(source.kind)
  )
    throw new Error("invalid_source");
  if(source.kind==='bridge'&&source.platform!=='douyin')throw new Error('invalid_source');
  if(source.kind!=='saved_folder'&&source.folderId!=null)throw new Error('invalid_source');
  if(['saved_folders','saved_folder'].includes(source.kind)){
    if(!['douyin','xiaohongshu'].includes(source.platform)||typeof source.accountId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(source.accountId))throw new Error('invalid_source');
    if(source.kind==='saved_folder'&&(typeof source.folderId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(source.folderId)))throw new Error('invalid_source');
    if(source.kind==='saved_folders'&&source.folderId!=null)throw new Error('invalid_source');
  }
  const u = new URL(source.url);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    !hosts[source.platform].includes(u.hostname)
  )
    throw new Error("invalid_host");
  return source;
}
export function validateRequest(r) {
  if (
    r?.version !== 1 ||
    typeof r.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(r.requestId) ||
    !["login", "loginQr", "scan", "download", "listChats", "listFolders", "importBridge"].includes(r.operation)
  )
    throw new Error("invalid_request");
  validateSource(r.source);
  if(r.operation==='importBridge'&&(r.source.platform!=='douyin'||r.source.kind!=='bridge'))throw new Error('invalid_operation');
  if(r.source.kind==='bridge'&&!['importBridge','download'].includes(r.operation))throw new Error('invalid_operation');
  validCategory(r.paths?.category);validTaskFolder(r.paths?.folder);
  if(r.operation==='loginQr'&&r.source.platform!=='telegram')throw new Error('invalid_operation');
  if(r.operation==='listChats'&&(r.source.platform!=='telegram'||r.source.kind!=='chat'||typeof r.source.accountId!=='string'||!/^[1-9]\d{0,18}$/.test(r.source.accountId)||BigInt(r.source.accountId)>9223372036854775807n||r.items?.length))throw new Error('invalid_operation');
  if(r.operation==='listFolders'&&(r.source.kind!=='saved_folders'||r.items?.length))throw new Error('invalid_operation');
  if(r.source.kind==='saved_folders'&&r.operation!=='listFolders')throw new Error('invalid_operation');
  for (const key of [
    "dataRoot",
    "downloadRoot",
    "browserExecutable",
    "engineRoot",
  ])
    if (typeof r.paths?.[key] !== "string" || !path.isAbsolute(r.paths[key]))
      throw new Error("invalid_paths");
  if (
    r.maxConcurrentDownloads != null &&
    (!Number.isInteger(r.maxConcurrentDownloads) ||
      r.maxConcurrentDownloads < 1 ||
      r.maxConcurrentDownloads > 8)
  )
    throw new Error("invalid_concurrency");
  if (
    r.source.maxItems != null &&
    (!Number.isSafeInteger(r.source.maxItems) || r.source.maxItems < 0)
  )
    throw new Error("invalid_limit");
  if (r.items != null) {
    if (!Array.isArray(r.items) || r.items.length > 10000)
      throw new Error("invalid_items");
    for (const item of r.items) {
      contentKey(item);
      if (item.platform !== r.source.platform)
        throw new Error("wrong_platform");
      if (!(item.platform === "telegram" && item.sourceUrl === "" && /^(user|chat|channel)_[1-9]\d{0,18}$/.test(item.chatId ?? "") && BigInt(item.chatId.split("_")[1]) <= 9223372036854775807n && /^[1-9]\d{0,9}$/.test(item.messageId ?? "") && BigInt(item.messageId) <= 2147483647n)) validateSource({
        platform: item.platform,
        kind: "single",
        url: item.sourceUrl,
      });
      if (!Array.isArray(item.media) || item.media.length > 500)
        throw new Error("invalid_media");
      const indexes = new Set();
      for (const m of item.media) {
        if (
          !Number.isInteger(m.index) ||
          m.index < 1 ||
          indexes.has(m.index) ||
          !["image", "video"].includes(m.kind)
        )
          throw new Error("invalid_media");
        indexes.add(m.index);
        if(m.reuseFrom!=null&&(r.operation!=='download'||typeof m.reuseFrom!=='string'||!path.isAbsolute(m.reuseFrom)||m.reuseFrom.length>32767||typeof m.reuseSha256!=='string'||!/^[a-f0-9]{64}$/i.test(m.reuseSha256)||!Number.isSafeInteger(m.reuseBytes)||m.reuseBytes<=0))throw new Error('invalid_reuse');
        if(m.reuseFrom==null&&(m.reuseSha256!=null||m.reuseBytes!=null))throw new Error('invalid_reuse');
        if (
          m.expectedBytes != null &&
          (!Number.isSafeInteger(m.expectedBytes) || m.expectedBytes < 0)
        )
          throw new Error("invalid_size");
      }
    }
  }
  return r;
}
export class Controls {
  #waiting = [];
  #closed = false;
  push(control) {
    if (
      !["cancel", "continue", "finish-login", "input", "resend"].includes(
        control?.command,
      )
    )
      throw new Error("invalid_control");
    if (
      control.command === "input" &&
      (typeof control.text !== "string" || control.text.length > 4096)
    )
      throw new Error("invalid_control");
    const waiter = this.#waiting.find((x) => (Array.isArray(x.command)?x.command.includes(control.command):x.command===control.command) && (!x.accept||x.accept(control)));
    if (waiter) {
      this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
      waiter.resolve(control);
    } /* Controls sent before an action request never pre-authorize a later action. */
  }
  waitFor(command, signal, accept) {
    signal?.throwIfAborted();
    if (this.#closed) return Promise.reject(new Error("closed"));
    return new Promise((resolve, reject) => {
      const waiter = {
        command,accept,
        resolve: (v) => {
          signal?.removeEventListener("abort", abort);
          resolve(v);
        },
        reject: (e) => { signal?.removeEventListener("abort", abort); reject(e); },
      };
      const abort = () => {
        this.#waiting = this.#waiting.filter((x) => x !== waiter);
        reject(signal.reason ?? new Error("cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#waiting.push(waiter);
    });
  }
  close() {
    this.#closed = true;
    for (const w of this.#waiting) w.reject(new Error("closed"));
    this.#waiting = [];
  }
}
export function eventWriter(stream, requestId,{allowBridgeItems=false}={}) {
  let chain = Promise.resolve(),
    queued = 0;
  return async (type, payload = {}) => {
    if (++queued > (allowBridgeItems?8:256)) {
      queued--;
      throw new Error("event_backpressure");
    }
    const line = JSON.stringify({ version: 1, requestId, type, ...payload });
    const bound=allowBridgeItems&&type==='item'&&payload.item?.platform==='douyin'?MAX_BRIDGE_ITEM_LINE:MAX_LINE;
    if (Buffer.byteLength(line) > bound) {
      queued--;
      throw new Error("event_too_large");
    }
    const work = chain.then(async () => {
      if (!stream.write(line + "\n")) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            stream.off("drain", drained);
            stream.off("error", failed);
          };
          const drained = () => {
            cleanup();
            resolve();
          };
          const failed = (error) => {
            cleanup();
            reject(error);
          };
          const timer = setTimeout(
            () => failed(new Error("stdout_timeout")),
            5000,
          );
          stream.once("drain", drained);
          stream.once("error", failed);
        });
      }
    });
    chain = work.catch(() => {});
    try {
      await work;
    } finally {
      queued--;
    }
  };
}

// Ephemeral authentication image: strict bounds before any decoder sees bytes.
export function validateLoginQr(q,now=Date.now()) {
 const fail=()=>{throw new Error('invalid_machine_qr')};
 if(!q||!Number.isSafeInteger(q.expiresAtUnix)||q.expiresAtUnix*1000<=now||q.expiresAtUnix*1000-now>600000)fail();
 const text=q.pngBase64;
 if(typeof text!=='string'||text.length>43692||!text.length||text.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))fail();
 const b=Buffer.from(text,'base64');
 if(b.length>32768||b.length<57||b.toString('base64')!==text||!b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||b.readUInt32BE(8)!==13||b.toString('ascii',12,16)!=='IHDR')fail();
 const width=b.readUInt32BE(16),height=b.readUInt32BE(20);
 if(width!==height||width<128||width>512||![1,2,4,8,16].includes(b[24])||![0,2,3,4,6].includes(b[25])||b[26]||b[27]||b[28]>1)fail();
 let pos=8,idat=false,end=false;
 while(pos+12<=b.length){const n=b.readUInt32BE(pos),type=b.toString('ascii',pos+4,pos+8);if(n>b.length-pos-12)fail();if(type==='IDAT')idat=true;pos+=n+12;if(type==='IEND'){if(n||pos!==b.length)fail();end=true;break;}}
 if(!idat||!end)fail();
 return {pngBase64:text,expiresAtUnix:q.expiresAtUnix};
}
