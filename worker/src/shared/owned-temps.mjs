import path from 'node:path';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { open, rename, rm, lstat, readdir } from 'node:fs/promises';
import { securePrivateRoot } from './private.mjs';
import { safeDirectory, rejectLinks, safeSegment, validCategory, validTaskFolder } from './paths.mjs';

const roots=new Map();
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const recordName=new RegExp('^'+uuid+'\\.json$');
export function stageNamespace(dataRoot) {
  const resolved=path.resolve(dataRoot);
  return createHash('sha256').update(process.platform==='win32'?resolved.toLowerCase():resolved).digest('hex');
}
async function journalRoot(dataRoot) {
  const key=path.resolve(dataRoot);
  if(!roots.has(key))roots.set(key,securePrivateRoot(key).then(p=>safeDirectory(path.join(p,'owned-temps'))).catch(e=>{roots.delete(key);throw e;}));
  const root=await roots.get(key);await rejectLinks(root);return root;
}
function validate(dataRoot,root,target,kind) {
  if(!path.isAbsolute(root)||!path.isAbsolute(target)||root.startsWith('\\\\')||target.startsWith('\\\\'))throw new Error('unsafe_temp');
  const rel=path.relative(root,target).split(path.sep).join('/');
  const part=new RegExp('^(x|telegram|douyin|xiaohongshu)/item-[A-Za-z0-9_-]{1,64}-[0-9a-f]{64}/media-[0-9]{3,}\\.[a-z0-9]{1,10}\\.'+uuid+'\\.part$');
  const pieces=rel.split('/'),offset=pieces.length===5?1:0;
  let readable=false;
  if(pieces.length===4||pieces.length===5){
    const [platform,author,work,file]=pieces.slice(offset);
    try{readable=(!offset||validCategory(pieces[0])===pieces[0])&&['x','telegram','douyin','xiaohongshu'].includes(platform)&&
      !!author&&safeSegment(author,40,'')===author&&safeSegment(work,140,'')===work&&
      /^(?:无日期|[0-9]{4,6}-[0-9]{2}-[0-9]{2})_.+_[A-Za-z0-9_-]{1,64}$/.test(work)&&
      new RegExp('^(?:0[1-9]|[1-9][0-9]+)\\.[a-z0-9]{1,10}\\.'+uuid+'\\.part$').test(file);
    }catch{}
  }
  // Telegram per-chat layout: [category/]telegram/<title_>chatId/<stamp>_<message>[_NN].<ext>.<uuid>.part
  if(!readable&&(pieces.length===3||pieces.length===4)){
    const shift=pieces.length===4?1:0,[platform,chat,file]=pieces.slice(shift);
    try{readable=(!shift||validCategory(pieces[0])===pieces[0])&&platform==='telegram'&&
      !!chat&&safeSegment(chat,60,'')===chat&&/(?:^|_)(?:user|chat|channel)_\d{1,20}$/.test(chat)&&
      new RegExp('^(?:无日期|[0-9]{8}_[0-9]{6})_[0-9]{1,20}(?:_[0-9]{2,})?\\.[a-z0-9]{1,10}\\.'+uuid+'\\.part$').test(file);
    }catch{}
  }
  // Flat task layout: [category/]<platform>/<task folder>/<stamp>_..._<NN>.<ext>.<uuid>.part
  if(!readable&&(pieces.length===3||pieces.length===4)){
    const shift=pieces.length===4?1:0,[platform,folder,file]=pieces.slice(shift);
    try{const base=file.slice(0,-(37+5));readable=(!shift||validCategory(pieces[0])===pieces[0])&&['x','telegram','douyin','xiaohongshu'].includes(platform)&&
      validTaskFolder(folder)===folder&&safeSegment(base,240,'')===base&&
      new RegExp('^(?:无日期|[0-9]{4,6}-[0-9]{2}-[0-9]{2}_[0-9]{6})_.*[A-Za-z0-9_-]\\.[a-z0-9]{1,10}\\.'+uuid+'\\.part$').test(file);
    }catch{}
  }
  const stage=new RegExp('^\\.unified-media-hub-staging/'+stageNamespace(dataRoot)+'/private/task-[A-Za-z0-9]{6}$');
  if(!(kind==='part'?part.test(rel)||readable:kind==='stage'&&stage.test(rel)))throw new Error('unsafe_temp');
}
async function info(target) {try{return await lstat(target);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const identity=s=>({dev:String(s.dev),ino:String(s.ino),birthtimeMs:s.birthtimeMs});
async function save(file,value) {
  const temporary=file+'.writing';let h;
  try{h=await open(temporary,'wx',0o600);await h.writeFile(JSON.stringify(value));await h.sync();await h.close();h=null;await rename(temporary,file);}
  finally{await h?.close();await rm(temporary,{force:true});}
}
export async function registerOwnedTemp(dataRoot,root,target,kind) {
  root=path.resolve(root);target=path.resolve(target);validate(dataRoot,root,target,kind);
  await rejectLinks(target);if(await info(target))throw new Error('temp_exists');
  const file=path.join(await journalRoot(dataRoot),randomUUID()+'.json');
  const record={version:1,root,target,kind,state:'planned'};await save(file,record);
  return {
    target,
    async claim() {await rejectLinks(target);const stat=await lstat(target);if(kind==='part'?!stat.isFile():!stat.isDirectory())throw new Error('unsafe_temp');Object.assign(record,{state:'created',identity:identity(stat)});await save(file,record);},
    // A failed exclusive create never owns the existing name. Discard only intent.
    async abandon() {await rm(file,{force:true});},
    async clean() {await cleanRecord(dataRoot,file,record);},
  };
}
async function cleanRecord(dataRoot,file,record) {
  if(record.version!==1)throw new Error('unsafe_temp');
  validate(dataRoot,record.root,record.target,record.kind);await rejectLinks(record.target);
  const stat=await info(record.target);
  if(stat) {
    if(record.state!=='created'||JSON.stringify(identity(stat))!==JSON.stringify(record.identity))throw new Error('owned_temp_unconfirmed');
    if(record.kind==='stage') {
      if(!stat.isDirectory())throw new Error('unsafe_temp');
      // Validate the entire subtree before recursive removal; never follow a junction.
      let count=0;
      const walk=async(dir,depth)=>{
        if(depth>64)throw new Error('owned_temp_limit');
        for(const name of await readdir(dir)) {
          if(++count>100000)throw new Error('owned_temp_limit');
          const child=path.join(dir,name);await rejectLinks(child);
          if((await lstat(child)).isDirectory())await walk(child,depth+1);
        }
      };
      await walk(record.target,0);
    } else if(!stat.isFile())throw new Error('unsafe_temp');
    await rm(record.target,{recursive:record.kind==='stage',force:true});
  }
  // Keep the only recovery evidence until removal (or confirmed absence) succeeds.
  await rm(file,{force:true});
}
export async function reserveMediaStage(dataRoot,output) {
  const root=await securePrivateRoot(path.join(path.resolve(output),'.unified-media-hub-staging',stageNamespace(dataRoot)));
  return registerOwnedTemp(dataRoot,path.resolve(output),path.join(root,'task-'+randomBytes(6).toString('hex').slice(0,6)),'stage');
}
export async function recoverOwnedTemps(dataRoot) {
  const root=await journalRoot(dataRoot);const entries=await readdir(root);
  if(entries.length>4096)throw new Error('owned_temp_limit');
  for(const name of entries) {
    if(!recordName.test(name))continue;
    const file=path.join(root,name);await rejectLinks(file);
    const h=await open(file,'r');let record;
    try{if((await h.stat()).size>16384)throw new Error('unsafe_temp');record=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
    await cleanRecord(dataRoot,file,record);
  }
}
