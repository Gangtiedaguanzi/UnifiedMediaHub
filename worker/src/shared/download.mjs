import {preflight,rollingSpace,requireSpace} from './storage-budget.mjs';
import path from "node:path";
import { open, link as fsLink, rm, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { registerOwnedTemp } from './owned-temps.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {
  contentKey,
  relativeMediaPath,
  safeDirectory,
  rejectLinks,
} from "./paths.mjs";

export function cookieHeader(cookies, target) {
  const u = new URL(target);
  return cookies
    .filter((c) => {
      const domain = c.domain?.replace(/^\./, "").toLowerCase();
      const host = u.hostname.toLowerCase();
      const matches = c.domain?.startsWith(".")
        ? host === domain || host.endsWith("." + domain)
        : host === domain;
      const cookiePath = c.path || "/";
      return (
        matches &&
        (!c.secure || u.protocol === "https:") &&
        (c.expires == null ||
          c.expires === -1 ||
          c.expires > Date.now() / 1000) &&
        (u.pathname === cookiePath ||
          u.pathname.startsWith(
            cookiePath.endsWith("/") ? cookiePath : cookiePath + "/",
          )) &&
        /^[^\r\n;=]+$/.test(c.name) &&
        /^[^\r\n;]*$/.test(c.value)
      );
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

const referers={
 'https://www.douyin.com/':['douyin.com','iesdouyin.com','douyinvod.com','douyinpic.com','byteimg.com','pstatp.com','ibytedtos.com','bytetos.com','zjcdn.com'],
 'https://www.xiaohongshu.com/':['xiaohongshu.com','xhscdn.com'],
};
function mediaHeaders(input,target,initialHost){
 const result={};let referer;
 for(const [name,value] of Object.entries(input??{})){
  if(typeof value!=='string'||value.length>512||/[\u0000-\u001f\u007f]/.test(value))continue;
  if(name.toLowerCase()==='user-agent')result['user-agent']=value;
  if(name.toLowerCase()==='referer'&&Object.hasOwn(referers,value))referer=value;
 }
 if(referer&&target.protocol==='https:'&&(target.hostname===initialHost||referers[referer].some(host=>target.hostname===host||target.hostname.endsWith('.'+host))))result.referer=referer;
 return result;
}

export function mediaMagic(bytes, kind) {
  if (kind === "image")
    return (
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
      (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
      ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ||
      (bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP") ||
      bytes.toString("ascii", 4, 8) === "ftyp"
    );
  return (
    bytes.toString("ascii", 4, 8) === "ftyp" ||
    bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))
  );
}

async function existingHash(filePath, signal) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath, { signal })) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function tryReuseAsset({root,category='',folder='',item,asset,signal,link=fsLink}){
  signal?.throwIfAborted();
  const source=asset.reuseFrom;
  if(typeof source!=='string'||!path.isAbsolute(source)||source.startsWith('\\\\'))return null;
  const relative=path.relative(path.resolve(root),path.resolve(source));
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||relative.includes(':'))return null;
  try{await rejectLinks(source);if(!(await lstat(source)).isFile())return null;}
  catch(error){if(['ENOENT','ENOTDIR'].includes(error.code)||error.message==='unsafe_link')return null;throw error;}
  if(!/^[a-f0-9]{64}$/i.test(asset.reuseSha256??'')||!Number.isSafeInteger(asset.reuseBytes)||asset.reuseBytes<=0)throw new Error('reuse_changed');
  const verified=async (file,failure='reuse_changed')=>{
    await rejectLinks(file);const saved=await existingHash(file,signal);signal?.throwIfAborted();
    if(saved.bytes!==asset.reuseBytes||saved.sha256!==asset.reuseSha256.toLowerCase())throw new Error(failure);
    return saved;
  };
  await verified(source);
  const target=path.resolve(root,relativeMediaPath(item,asset,{category,folder,root}));
  await safeDirectory(path.dirname(target));await rejectLinks(target);signal?.throwIfAborted();
  const receipt=async(filePath,status,failure)=>({contentKey:contentKey(item),mediaIndex:asset.index,filePath,...await verified(filePath,failure),status});
  if(path.resolve(source).toLowerCase()===target.toLowerCase()||path.parse(source).root.toLowerCase()!==path.parse(target).root.toLowerCase())return receipt(source,'skipped');
  try{await link(source,target);}catch(error){
    signal?.throwIfAborted();
    if(error.code==='EEXIST')return receipt(target,'skipped','file_conflict');
    return receipt(source,'skipped');
  }
  return receipt(target,'completed');
}

export const IDLE_TIMEOUT_MS=30000;
export const RETRY_DELAY_MS=2000;
export async function downloadAsset(input){
 for(let retry=0;;retry++){
  input.signal?.throwIfAborted();
  try{return await downloadAttempt({...input,attempt:(input.attempt??1)+retry});}
  catch(error){const serverError=error.httpStatus>=500&&error.httpStatus<=599;if(input.signal?.aborted||(!serverError&&error.message!=='idle_timeout')||retry>=1)throw error;if(serverError)await (input.retryDelay??((ms,signal)=>delay(ms,undefined,{signal})))(RETRY_DELAY_MS,input.signal);}
 }
}
async function downloadAttempt({
  root,
  category = '', folder = '',
  dataRoot,
  item,
  asset,
  cookies = [],
  fetchImpl = fetch, openFile = open, link = fsLink, allowedUrl,
  signal,
  onProgress = async () => {},
  requestHeaders,diagnostics,attempt=1,idleTimeoutMs=IDLE_TIMEOUT_MS,
}) {
  signal?.throwIfAborted();
  const reused=await tryReuseAsset({root,category,folder,item,asset,signal,link});
  if(reused)return reused;
  await preflight({downloadRoot:root,dataRoot},[asset]);
  const checkSpace=rollingSpace(root);
  const filePath = path.resolve(root, relativeMediaPath(item, asset, {category,folder,root}));
  const relative = path.relative(path.resolve(root), filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("unsafe_path");
  await safeDirectory(path.dirname(filePath));
  await rejectLinks(filePath);
  const part = filePath + "." + randomUUID() + ".part";
  let handle, response, owned, created = false,currentHost;
  if(!Number.isFinite(idleTimeoutMs)||idleTimeoutMs<=0)throw new Error('invalid_idle_timeout');
  const idleAbort=new AbortController(),networkSignal=signal?AbortSignal.any([signal,idleAbort.signal]):idleAbort.signal;
  const waitForData=async work=>{let timer;try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=new Error('idle_timeout');idleAbort.abort(error);reject(error);},idleTimeoutMs);})]);}finally{clearTimeout(timer);}};
  try {
    let next = asset.url;const initialHost=new URL(next).hostname;
    for (let redirects = 0; ; redirects++) {
      const u = new URL(next);
      currentHost=u.hostname;
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw new Error("invalid_media_url");
      const cookie = cookieHeader(cookies, u);
      const headers=mediaHeaders(requestHeaders,u,initialHost);if(cookie)headers.cookie=cookie;
      if(allowedUrl&&!allowedUrl(u.href))throw new Error('invalid_media_host');
      response = await waitForData(()=>fetchImpl(u, {
        signal:networkSignal,
        redirect: "manual",
        headers,
      }));
      diagnostics?.add({host:u.hostname,status:response.status,attempt});
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects >= 5 || !response.headers.get("location"))
          throw new Error("invalid_redirect");
        next = new URL(response.headers.get("location"), u).href;
        continue;
      }
      break;
    }
    if (!response.ok) {
      const error = new Error("http_error");
      error.httpStatus = response.status;
      throw error;
    }
    const sizeHeader=Number(response.headers.get("content-length"));
    if(Number.isSafeInteger(sizeHeader)&&sizeHeader>0)await requireSpace(root,sizeHeader);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("html") || contentType.includes("json"))
      throw new Error("not_media");
    if(dataRoot) owned=await registerOwnedTemp(dataRoot,root,part,'part');
    handle = await openFile(part, "wx", 0o600);
    created=true;
    await owned?.claim();
    const hash = createHash("sha256");
    let bytes = 0,
      first = Buffer.alloc(0),
      lastProgress = 0;
    const iterator=response.body[Symbol.asyncIterator]();
    try{for (;;) {
      const next=await waitForData(()=>iterator.next());if(next.done)break;const chunk=next.value;
      signal?.throwIfAborted();
      if (first.length < 32)
        first = Buffer.concat([
          first,
          Buffer.from(chunk).subarray(0, 32 - first.length),
        ]);
      await checkSpace(chunk.length);
      await handle.writeFile(chunk);
      hash.update(chunk);
      bytes += chunk.length;
      if (Date.now() - lastProgress > 500) {
        lastProgress = Date.now();
        await onProgress(bytes);
      }
    }
    }finally{await iterator.return?.().catch(()=>{});}
    if (!bytes || !mediaMagic(first, asset.kind))
      throw new Error("invalid_media");
    const declared = response.headers.get("content-length");
    if (
      (asset.expectedBytes != null && bytes !== asset.expectedBytes) ||
      (declared && bytes !== Number(declared))
    )
      throw new Error("size_mismatch");
    await handle.sync();
    await handle.close();
    handle = null;
    signal?.throwIfAborted();
    await rejectLinks(filePath);
    const sha256 = hash.digest("hex");
    let status = "completed";
    try {
      // A same-volume hard link publishes the fully synced file without replacing
      // an existing name. Filesystems without hard links fail safely.
      await link(part, filePath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await rejectLinks(filePath);
      const existing = await existingHash(filePath, signal);
      if (existing.bytes !== bytes || existing.sha256 !== sha256)
        throw new Error("file_conflict");
      status = "skipped";
    }
    await onProgress(bytes);
    return {
      contentKey: contentKey(item),
      mediaIndex: asset.index,
      filePath,
      bytes,
      sha256,
      status,
    };
  } catch(error){if(!signal?.aborted&&error.message==='idle_timeout')diagnostics?.add({host:currentHost,status:'idle_timeout',attempt});throw error;
  } finally {
    await response?.body?.cancel().catch(() => {});
    await handle?.close();
    if(owned) {if(created)await owned.clean();else await owned.abandon();}
    else if(created) await rm(part, { force: true });
  }
}
