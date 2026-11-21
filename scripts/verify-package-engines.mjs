import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const release=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);await mkdir(output,{recursive:true});
const {isolatedProcess}=await import(pathToFileURL(path.join(release,'worker/src/shared/engines.mjs')));
const tdl=path.join(release,'runtime/engines/tdl/tdl.exe'),gallery=path.join(release,'runtime/engines/gallery-dl/gallery-dl.exe');
const smokeRoot=await mkdtemp(path.join(output,'engine-smoke-'));
const checks=[];
for(const [name,exe,args,expected] of [
 ['gallery-version',gallery,['--version'],/1\.32\.16/],
 ['tdl-version',tdl,['version'],/0\.20\.4\+umh\.5\b/],
 ['machine-login',tdl,['umh','login','--help'],/login/i],
 ['machine-login-qr',tdl,['umh','login-qr','--help'],/login-qr/i],
 ['current-identity',tdl,['umh','identity','--help'],/identity/i],
 ['bounded-chats',tdl,['umh','chats','--help'],/limit/i],
 ['typed-selected',tdl,['download','--help'],/strict-peer/],
 ['typed-export',tdl,['chat','export','--help'],/peer-type/],
]) {
 const root=path.join(smokeRoot,name);
 const result=await isolatedProcess({executable:exe,args:exe===tdl?['--storage',"type=bolt,path="+path.join(root,'storage'),'-n','umh-offline-smoke',...args]:args,root,timeoutMs:15000,maxOutput:1024*1024});
 assert.match(result.stdout+'\n'+result.stderr,expected);checks.push({name,passed:true});
}
for(const [name,args,code] of [
 ['chats-limit-zero',['umh','chats','--limit','0'],'invalid_input'],
 ['chats-limit-high',['umh','chats','--limit','101'],'invalid_input'],
 ['chats-limit-negative',['umh','chats','--limit','-1'],'invalid_input'],
 ['chats-limit-invalid',['umh','chats','--limit','synthetic-secret'],'operation_failed'],
 ['chats-unknown-flag',['umh','chats','--invalid=synthetic-secret'],'operation_failed'],
]){
 const root=path.join(smokeRoot,name);
 await assert.rejects(()=>isolatedProcess({executable:tdl,args:['--storage',`type=bolt,path=${path.join(root,'storage')}`,'-n','umh-offline-smoke',...args],root,timeoutMs:15000,maxOutput:1024*1024}),error=>error.engineCode===code&&error.message===code);
 checks.push({name,passed:true});
}
await writeFile(path.join(output,'engine-smoke.json'),JSON.stringify({evidence:'Installed binary version/help and bounded invalid-input errors, isolated fresh stores, no authentication',checks},null,2));console.log(JSON.stringify(checks));
