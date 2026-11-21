import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const recovery = await import('../src/shared/owned-temps.mjs').catch(()=>({}));
const downloadUrl = new URL('../src/shared/download.mjs',import.meta.url).href;
const stageUrl = new URL('../src/shared/media-stage.mjs',import.meta.url).href;
test('readable category part paths retain ownership recovery without broadening to arbitrary files',async t=>{
 const f=await fixture(t);const {relativeMediaPath}=await import('../src/shared/paths.mjs');
 const suffix='.12345678-1234-1234-1234-123456789abc.part';
 for(const category of ['', '风景']){
  const relative=relativeMediaPath({platform:'douyin',contentId:'123',author:'作者',title:'标题'},{index:1,extension:'png'},{category});
  const target=path.join(f.downloadRoot,relative)+suffix;await mkdir(path.dirname(target),{recursive:true});
  const owned=await recovery.registerOwnedTemp(f.dataRoot,f.downloadRoot,target,'part');await writeFile(target,'synthetic partial');await owned.claim();
  await recovery.recoverOwnedTemps(f.dataRoot);await assert.rejects(readFile(target),{code:'ENOENT'});
 }
 const arbitrary=path.join(f.downloadRoot,'风景','douyin','作者','unrelated-report','01.png')+suffix;
 await assert.rejects(recovery.registerOwnedTemp(f.dataRoot,f.downloadRoot,arbitrary,'part'),/unsafe_temp/);
});
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'umh-recovery-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,dataRoot:path.join(root,'data'),downloadRoot:path.join(root,'output')};
}
async function killed(t, code) {
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const closed=once(child,'close'); let stderr='';child.stderr.on('data',b=>stderr+=b);
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const ready=new Promise((resolve,reject)=>{let text='';child.stdout.on('data',b=>{text+=b;if(text.includes('READY\n'))resolve();});child.once('close',()=>reject(new Error('fixture exited before ready: '+stderr)));});
  await ready;child.kill();await closed;
}
test('killed HTTP transfer recovery deletes only recorded parts across repeated resumes',async t=>{
  const f=await fixture(t);const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'image/png'});res.write(Buffer.from('89504e470d0a1a0a','hex'));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  await mkdir(f.downloadRoot,{recursive:true});const sentinel=path.join(f.downloadRoot,'unrelated.part');await writeFile(sentinel,'keep');
  for(let round=0;round<2;round++) {
    await killed(t,`import {downloadAsset} from ${JSON.stringify(downloadUrl)};await downloadAsset({root:${JSON.stringify(f.downloadRoot)},dataRoot:${JSON.stringify(f.dataRoot)},item:{platform:'douyin',contentId:'123'},asset:{index:1,kind:'image',extension:'png',url:'http://127.0.0.1:${server.address().port}/slow'},onProgress:async()=>console.log('READY')});`);
    const before=await readdir(f.downloadRoot,{recursive:true});assert.equal(before.filter(x=>x.endsWith('.part')).length,2);
    assert.equal(typeof recovery.recoverOwnedTemps,'function');
    await recovery.recoverOwnedTemps(f.dataRoot);
    const after=await readdir(f.downloadRoot,{recursive:true});assert.deepEqual(after.filter(x=>x.endsWith('.part')),['unrelated.part']);
  }
  assert.equal(await readFile(sentinel,'utf8'),'keep');
});
test('killed output media stage is journaled before creation and recovered without touching other namespaces',async t=>{
  const f=await fixture(t);await mkdir(f.downloadRoot,{recursive:true});
  const sentinel=path.join(f.downloadRoot,'other-stage');await mkdir(sentinel);await writeFile(path.join(sentinel,'keep'),'keep');
  await killed(t,`import {withMediaStage} from ${JSON.stringify(stageUrl)};import {writeFile} from 'node:fs/promises';await withMediaStage({paths:${JSON.stringify(f)}},async stage=>{await writeFile(stage+'/media','partial');console.log('READY');await new Promise(()=>{});});setTimeout(()=>{},20000);`);
  assert.equal(typeof recovery.recoverOwnedTemps,'function');
  await recovery.recoverOwnedTemps(f.dataRoot);
  assert.equal((await readdir(f.downloadRoot,{recursive:true})).filter(x=>/task-[A-Za-z0-9]{6}[\\/]media$/.test(x)).length,0);
  assert.equal(await readFile(path.join(sentinel,'keep'),'utf8'),'keep');
});
test('recovery refuses tampered journal targets and junction descendants',async t=>{
  assert.equal(typeof recovery.registerOwnedTemp,'function');const f=await fixture(t);
  await mkdir(f.downloadRoot,{recursive:true});const sentinel=path.join(f.root,'keep');await writeFile(sentinel,'keep');
  await assert.rejects(recovery.registerOwnedTemp(f.dataRoot,f.downloadRoot,sentinel,'part'),/unsafe_temp/);
  const stage=await recovery.reserveMediaStage(f.dataRoot,f.downloadRoot);await mkdir(stage.target);await stage.claim();
  await symlink(f.root,path.join(stage.target,'escape'),'junction');
  await assert.rejects(recovery.recoverOwnedTemps(f.dataRoot),/unsafe_link/);
  assert.equal((await readdir(path.join(f.dataRoot,'private','owned-temps'))).filter(x=>x.endsWith('.json')).length,1);
  assert.equal(await readFile(sentinel,'utf8'),'keep');
});
test('uncreated intent clears; preexisting and unconfirmed names are preserved',async t=>{
  const f=await fixture(t);
  const absent=await recovery.reserveMediaStage(f.dataRoot,f.downloadRoot);
  await recovery.recoverOwnedTemps(f.dataRoot);
  assert.equal((await readdir(path.join(f.dataRoot,'private','owned-temps'))).length,0);
  const pending=await recovery.reserveMediaStage(f.dataRoot,f.downloadRoot);
  await mkdir(pending.target);await writeFile(path.join(pending.target,'keep'),'keep');
  await assert.rejects(recovery.registerOwnedTemp(f.dataRoot,f.downloadRoot,pending.target,'stage'),/temp_exists/);
  await assert.rejects(recovery.recoverOwnedTemps(f.dataRoot),/owned_temp_unconfirmed/);
  assert.equal(await readFile(path.join(pending.target,'keep'),'utf8'),'keep');
  await pending.abandon();assert.equal(await readFile(path.join(pending.target,'keep'),'utf8'),'keep');
});
test('failed removal retains durable evidence for a later explicit recovery',async t=>{
  if(process.platform!=='win32')return;
  const f=await fixture(t);const stage=await recovery.reserveMediaStage(f.dataRoot,f.downloadRoot);await mkdir(stage.target);await stage.claim();
  const locked=path.join(stage.target,'locked');await writeFile(locked,'synthetic');
  const script='$s=[IO.File]::Open($env:UMH_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[Console]::WriteLine("READY");[Console]::ReadLine()|Out-Null;$s.Dispose()';
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,UMH_LOCK:locked}});
  const closed=once(child,'close');t.after(()=>{if(child.exitCode===null)child.kill();});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
  await assert.rejects(recovery.recoverOwnedTemps(f.dataRoot));
  assert.equal((await readdir(path.join(f.dataRoot,'private','owned-temps'))).filter(x=>x.endsWith('.json')).length,1);
  child.stdin.end('\n');await closed;
  await recovery.recoverOwnedTemps(f.dataRoot);
  assert.equal((await readdir(path.join(f.dataRoot,'private','owned-temps'))).filter(x=>x.endsWith('.json')).length,0);
});
test('Telegram per-chat part paths are owned and recoverable; unrelated files there are not',async t=>{
 const f=await fixture(t);const {relativeMediaPath}=await import('../src/shared/paths.mjs');
 const suffix='.12345678-1234-1234-1234-123456789abc.part';
 for(const category of ['', '风景']){
  const relative=relativeMediaPath({platform:'telegram',chatId:'channel_7',messageId:'9',author:'kestrel',createdAt:new Date(2026,9,4,10,21).toISOString()},{index:1,extension:'mov'},{category});
  const target=path.join(f.downloadRoot,relative)+suffix;await mkdir(path.dirname(target),{recursive:true});
  const owned=await recovery.registerOwnedTemp(f.dataRoot,f.downloadRoot,target,'part');await writeFile(target,'synthetic partial');await owned.claim();
  await recovery.recoverOwnedTemps(f.dataRoot);await assert.rejects(readFile(target),{code:'ENOENT'});
 }
 for(const name of [path.join('telegram','kestrel_channel_7','notes.txt'),path.join('telegram','kestrel','20261004_102100_9.mov')])
  await assert.rejects(recovery.registerOwnedTemp(f.dataRoot,f.downloadRoot,path.join(f.downloadRoot,name)+suffix,'part'),/unsafe_temp/,name);
});
test('task-folder part paths are owned and recoverable; unrelated files there are not',async t=>{
 const f=await fixture(t);const {relativeMediaPath}=await import('../src/shared/paths.mjs');
 const suffix='.12345678-1234-1234-1234-123456789abc.part',at=new Date(2026,9,4,10,21).toISOString();
 for(const [category,item] of [['',{platform:'x',contentId:'1',author:'作者',title:'标题',createdAt:at}],['风景',{platform:'telegram',chatId:'channel_7',messageId:'9',author:'kestrel',createdAt:at}],['',{platform:'douyin',contentId:'2',author:'a',title:'b'}]]){
  const relative=relativeMediaPath(item,{index:1,extension:'mp4'},{category,folder:'我的喜欢_小号_2026-11-19_2005'});
  const target=path.join(f.downloadRoot,relative)+suffix;await mkdir(path.dirname(target),{recursive:true});
  const owned=await recovery.registerOwnedTemp(f.dataRoot,f.downloadRoot,target,'part');await writeFile(target,'synthetic partial');await owned.claim();
  await recovery.recoverOwnedTemps(f.dataRoot);await assert.rejects(readFile(target),{code:'ENOENT'});
 }
 for(const name of [path.join('x','我的喜欢_2026-11-19_2005','notes.txt'),path.join('x','a/b','2026-10-04_102100_a_1_01.jpg'),path.join('mail','f','2026-10-04_102100_a_1_01.jpg')])
  await assert.rejects(recovery.registerOwnedTemp(f.dataRoot,f.downloadRoot,path.join(f.downloadRoot,name)+suffix,'part'),/unsafe_temp/,name);
});
