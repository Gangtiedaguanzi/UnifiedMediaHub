import './fixtures/offline-network.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {telegramAdapter} from '../src/adapters/telegram.mjs';import {Controls} from '../src/shared/protocol.mjs';
const identity='{"version":1,"type":"account","authenticated":true,"accountId":"9"}\n';
test('TG delivery prompt carries finite metadata; explicit resend uses same current engine nonce',async()=>{
 const controls=new Controls(),events=[],sent=[];const ctx={request:{source:{}},signal:new AbortController().signal,controls,emit:async(type,e)=>{events.push({type,...e});if(type==='needs_action'){assert.equal(e.delivery.method,'app');assert.equal(e.awaitingInput,true);assert.ok(e.inputId);controls.push({command:'resend',inputId:e.inputId});}}};
 const adapter=telegramAdapter({session:async(_,__,operation)=>operation({run:async(args,options)=>{await options.onLine(JSON.stringify({version:1,type:'input_required',field:'code',inputType:'password',promptId:'a'.repeat(48),delivery:{method:'app',nextMethod:'sms',timeoutSeconds:0,resendsRemaining:3}}),async s=>sent.push(JSON.parse(s)),ctx.signal);return {stdout:identity};}})});
 assert.equal((await adapter.login(ctx)).status,'completed');assert.deepEqual(sent,[{promptId:'a'.repeat(48),action:'resend'}]);assert.equal(JSON.stringify(events).includes('a'.repeat(48)),false);
});
test('controls ignore stale code/resend IDs and consume one current action',async()=>{
 const controls=new Controls();const abort=new AbortController();let settled=false;
 const pending=controls.waitFor(['input','resend'],abort.signal,c=>c.inputId==='new');pending.then(()=>settled=true);
 controls.push({command:'input',text:'old code',inputId:'old'});await new Promise(r=>setTimeout(r,1));assert.equal(settled,false);
 controls.push({command:'resend',inputId:'new'});assert.equal((await pending).command,'resend');controls.close();
});
