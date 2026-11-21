import readline from 'node:readline';
import {xAdapter} from '../../worker/src/adapters/x.mjs';
import {Controls,eventWriter} from '../../worker/src/shared/protocol.mjs';
import {xLoginPage,xLoginOrdinary} from '../../worker/test/fixtures/x-login-page.mjs';
// Explicit offline GUI integration worker. Real adapter/controls/identity parser;
// only the browser page is synthetic, with no network-capable methods.
const input=readline.createInterface({input:process.stdin}),controls=new Controls(),abort=new AbortController();
let started=false;
input.on('line',line=>{
 const value=JSON.parse(line);
 if(started){if(value.command==='cancel')abort.abort();controls.push(value);return;}
 started=true;
 void (async()=>{
  const emit=eventWriter(process.stdout,value.requestId),fixture=xLoginPage();
  try {
   const result=await xAdapter({open:async()=>fixture.browser,ordinary:xLoginOrdinary}).login({request:value,paths:value.paths,controls,signal:abort.signal,emit});
   await emit('complete',result);
  }catch{await emit('complete',{status:abort.signal.aborted?'paused':'failed',completeness:'unknown'});}
  finally{controls.close();input.close();process.stdin.pause();}
 })();
});
input.on('close',()=>abort.abort());
