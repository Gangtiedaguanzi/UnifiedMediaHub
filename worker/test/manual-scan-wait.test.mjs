import './fixtures/offline-network.mjs';
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {scanPage} from '../src/shared/scanner.mjs';

// Synthetic, isolated contexts only. Every browser request is fulfilled locally.
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url))});});
after(async()=>{await browser?.close();});
const source={platform:'douyin',kind:'saved',url:'https://www.douyin.com/user/synthetic_owner',accountId:'synthetic_owner'};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const never=()=>new Promise(()=>{});
const watched=['request','response','framenavigated','close','crash'];
async function fixture(t){
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<button role="tab" aria-selected="true">收藏</button><div role="tabpanel"><a href="/video/123">synthetic card</a><p>没有更多了</p></div>'}));
  const page=await context.newPage();await page.goto(source.url);
  const listeners=Object.fromEntries(watched.map(name=>[name,page.listeners(name)]));
  const events=[];
  return {context,page,events,retired:()=>{for(const name of watched)assert.equal(page.listeners(name).filter(fn=>!listeners[name].includes(fn)).length,0,`${name} listener retired`);},run:extra=>scanPage(page,{source,navigate:false,maxRounds:1,waitMs:1,emit:async(type,payload)=>events.push({type,...payload}),...extra})};
}
const manual=({waitForManual,signal},action)=>waitForManual?waitForManual(action):action(signal);

test('explicit human wait may exceed automatic scan budget, then Continue still publishes',async t=>{
  const f=await fixture(t);let continued=false;
  const result=await f.run({timeoutMs:300,manualTimeoutMs:1000,prepare:args=>manual(args,async signal=>{await delay(500);signal.throwIfAborted();continued=true;})});
  assert.equal(continued,true);assert.equal(result.status,'completed');assert.equal(f.events.filter(e=>e.type==='item').length,1);f.retired();
});

test('manual timeout is terminal needs_action and retires noncooperating late completion',async t=>{
  const f=await fixture(t),late=Promise.withResolvers();let manualSignal;
  const result=await f.run({timeoutMs:1000,manualTimeoutMs:50,prepare:args=>manual(args,signal=>{manualSignal=signal;return late.promise;})});
  assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'manual_wait_timeout');assert.equal(manualSignal.aborted,true);
  const terminal=f.events.findLast(e=>e.type==='needs_action');assert.equal(terminal?.code,'manual_wait_timeout');assert.equal(terminal?.awaitingInput,false);
  const count=f.events.length;late.resolve();await delay(40);assert.equal(f.events.length,count);assert.equal(f.events.some(e=>e.type==='item'),false);f.retired();
});

test('parent cancellation interrupts manual wait and aborts its child signal',async t=>{
  const f=await fixture(t),parent=new AbortController();let manualSignal;
  const result=f.run({timeoutMs:1000,signal:parent.signal,prepare:args=>manual(args,signal=>{manualSignal=signal;setTimeout(()=>parent.abort(new Error('synthetic stop')),30);return never();})});
  await assert.rejects(result,/synthetic stop/);assert.equal(manualSignal.aborted,true);assert.equal(f.events.some(e=>e.type==='item'),false);f.retired();
});

for(const closure of ['page','context','crash'])test(`manual wait ends when synthetic ${closure} closes`,async t=>{
  const f=await fixture(t);let manualSignal;
  const result=await f.run({timeoutMs:1000,prepare:args=>manual(args,signal=>{
    manualSignal=signal;setTimeout(()=>{if(closure==='page')void f.page.close();else if(closure==='context')void f.context.close();else f.page.emit('crash');},30);return never();
  })});
  assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'browser_closed');assert.equal(manualSignal.aborted,true);assert.equal(f.events.some(e=>e.type==='item'),false);f.retired();
});

test('automatic preparation without manual wait retains its original finite budget',async t=>{
  const f=await fixture(t);let prepareSignal;
  const result=await f.run({timeoutMs:60,prepare:({signal})=>{prepareSignal=signal;return never();}});
  assert.equal(result.reasonCode,'scan_boundary');assert.equal(prepareSignal.aborted,true);f.retired();
});

test('manual return resumes remaining automatic time instead of resetting full budget',async t=>{
  const f=await fixture(t);let resumed=false;
  const result=await f.run({timeoutMs:300,manualTimeoutMs:1000,prepare:async args=>{
    await delay(180);args.signal.throwIfAborted();
    await manual(args,async signal=>{await delay(400);signal.throwIfAborted();resumed=true;});
    await delay(180);args.signal.throwIfAborted();
  }});
  assert.equal(resumed,true);assert.equal(result.reasonCode,'scan_boundary');assert.equal(f.events.some(e=>e.type==='item'),false);f.retired();
});

test('second manual interval is refused without invoking its action',async t=>{
  const f=await fixture(t);let repeated=false;
  const result=await f.run({timeoutMs:1000,prepare:async args=>{
    assert.equal(typeof args.waitForManual,'function');await args.waitForManual(async()=>{});
    await assert.rejects(args.waitForManual(()=>{repeated=true;}),error=>error.code==='input_required'&&error.message==='manual_wait_unavailable');
  }});
  assert.equal(repeated,false);assert.equal(result.status,'completed');assert.equal(f.events.filter(e=>e.type==='item').length,1);f.retired();
});

test('concurrent second manual interval is refused without replacing the first deadline',async t=>{
  const f=await fixture(t);let repeated=false;
  const result=await f.run({timeoutMs:1000,manualTimeoutMs:40,prepare:async args=>{
    assert.equal(typeof args.waitForManual,'function');const first=args.waitForManual(never);void first.catch(()=>{});
    await assert.rejects(args.waitForManual(()=>{repeated=true;}),error=>error.code==='input_required');await first;
  }});
  assert.equal(repeated,false);assert.equal(result.reasonCode,'manual_wait_timeout');f.retired();
});

test('manual callback captured from completed preparation cannot reopen its clock',async t=>{
  const f=await fixture(t);let captured,late=false;
  const result=await f.run({timeoutMs:1000,prepare:({waitForManual})=>{captured=waitForManual;}});
  assert.equal(result.status,'completed');assert.equal(typeof captured,'function');
  await assert.rejects(captured(()=>{late=true;}),error=>error.code==='input_required'&&error.message==='manual_wait_unavailable');assert.equal(late,false);f.retired();
});

test('preparation cannot swallow a manual expiry and then publish',async t=>{
  const f=await fixture(t);
  const result=await f.run({timeoutMs:1000,manualTimeoutMs:40,prepare:async args=>{try{await manual(args,never);}catch{}}});
  assert.equal(result.reasonCode,'manual_wait_timeout');assert.equal(f.events.some(e=>e.type==='item'),false);f.retired();
});

for(const disposition of ['swallowed','fire-and-forget'])test(`manual expiry independently ends noncooperating ${disposition} preparation`,async t=>{
  const f=await fixture(t);
  const running=f.run({timeoutMs:100,manualTimeoutMs:30,prepare:async args=>{
    const waiting=manual(args,never);
    if(disposition==='swallowed'){try{await waiting;}catch{}}
    else void waiting.catch(()=>{});
    await never();
  }});
  const result=await Promise.race([running,delay(250).then(()=>({notSettled:true}))]);
  assert.equal(result.notSettled,undefined,'manual failure must terminate preparation independently');
  assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'manual_wait_timeout');
  assert.equal(f.events.findLast(e=>e.type==='needs_action')?.awaitingInput,false);f.retired();
});

test('browser closure independently ends preparation even if its rejection is swallowed',async t=>{
  const f=await fixture(t);
  const running=f.run({timeoutMs:100,manualTimeoutMs:1000,prepare:async args=>{
    try{await manual(args,()=>{setTimeout(()=>void f.page.close(),20);return never();});}catch{}
    await never();
  }});
  const result=await Promise.race([running,delay(250).then(()=>({notSettled:true}))]);
  assert.equal(result.notSettled,undefined);assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'browser_closed');f.retired();
});
