// Explicit offline smoke only. Not a platform fixture or an account check.
import { mkdtemp,rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withEngineSession } from '../../src/shared/engines.mjs';
const engineRoot=fileURLToPath(new URL('../../../runtime/engines',import.meta.url));
const cache=fileURLToPath(new URL('../../../.cache/',import.meta.url));
const root=await mkdtemp(path.join(cache,'task4-engine-help-'));
try{
 const ctx={paths:{engineRoot,dataRoot:root},signal:new AbortController().signal};
 await withEngineSession(ctx,'x',async s=>{const r=await s.run(['--help']);if(!r.stdout.includes('--dump-json')||!r.stdout.includes('--cookies'))throw new Error('gallery_help_contract');console.log(JSON.stringify({engine:'gallery-dl',command:'--help',bytes:Buffer.byteLength(r.stdout),offline:true}));});
 await withEngineSession(ctx,'telegram',async s=>{
  for(const [args,required] of [[['umh','login','--help'],'login'],[['umh','identity','--help'],'identity'],[['chat','export','--help'],'--strict-peer'],[['chat','ls','--help'],'--fail-on-flood-wait'],[['download','--help'],'--strict-peer']]){
   const r=await s.run(args);if(!r.stdout.includes(required))throw new Error('tdl_help_contract');console.log(JSON.stringify({engine:'tdl',command:args.join(' '),bytes:Buffer.byteLength(r.stdout),offline:true}));
  }
 });
}finally{await rm(root,{recursive:true,force:true});}
