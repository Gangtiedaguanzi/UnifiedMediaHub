import './fixtures/offline-network.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as browserTools from '../src/shared/browser.mjs';
import { scanPage } from '../src/shared/scanner.mjs';
import { browserAdapter } from '../src/shared/browser-adapter.mjs';

// All requests are fulfilled locally. These prove lifecycle behavior, not live support.
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url))});});
after(async()=>{await browser?.close();});
const source={platform:'xiaohongshu',kind:'saved',url:'https://www.xiaohongshu.com/user/profile/owner?tab=fav',accountId:'owner'};
const route='/api/sns/web/v2/note/collect/page';
const endpoint=(cursor='')=>`https://webapi.rednote.com${route}?user_id=owner&cursor=${cursor}`;
const tabs=`<div class="xhs-user-page-primary-tabs"><div class="reds-tab-item">笔记</div><div class="reds-tab-item active" onclick="window.clicks=(window.clicks||0)+1">收藏</div></div>`;
const legacy=`<button role="tab" aria-selected="true">收藏</button>`;
const payload=(name='one',more=false,cursor='')=>({code:0,success:true,data:{notes:[{note_id:name,xsec_token:'synthetic'}],has_more:more,cursor}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,html,respond=()=>payload()){
  const context=await browser.newContext();t.after(()=>context.close());
  await context.addCookies([{name:'web_session',value:'SYNTHETIC_SESSION',domain:'.xiaohongshu.com',path:'/',secure:true}]);
  await context.route('**/*',async r=>{
    const q=r.request(),u=new URL(q.url());
    if(u.pathname.includes('/api/')){
      const p=await respond(q);
      await r.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:typeof p==='string'?p:JSON.stringify(p)}).catch(()=>{});
    }else await r.fulfill({contentType:'text/html; charset=utf-8',body:html}).catch(()=>{});
  });
  return {context,page:await context.newPage()};
}
async function scan(page,extra={}){const events=[];const result=await scanPage(page,{source,emit:async(type,p)=>events.push({type,...p}),maxRounds:8,waitMs:35,...extra});return {result,items:events.filter(e=>e.type==='item'),events};}

test('modern primary tab is uniquely scoped and active tab is never clicked',async t=>{
  const {page}=await fixture(t,tabs+'<aside class="reds-tab-item active">收藏</aside>');await page.goto(source.url);
  assert.equal((await browserTools.tabSnapshot(page,'xiaohongshu','saved')).selected,true);
  assert.equal(await browserTools.prepareSourceTab(page,'xiaohongshu','saved',{timeoutMs:150}),true);
  assert.equal(await page.evaluate(()=>window.clicks||0),0);
});
test('modern ambiguous/hidden/wrong-scope labels never fall back to legacy or global text',async t=>{
  for(const html of [tabs.replace('</div></div>','</div><div class="reds-tab-item active">收藏</div></div>'),tabs+tabs,tabs.replace('reds-tab-item active','reds-tab-item active" style="display:none'),'<div class="xhs-user-page-primary-tabs"><div class="reds-tab-item active">笔记</div></div><span>收藏</span>']){
    const {page}=await fixture(t,html+legacy);await page.goto(source.url);
    assert.equal((await browserTools.tabSnapshot(page,'xiaohongshu','saved')).selected,false);
    assert.equal(await browserTools.prepareSourceTab(page,'xiaohongshu','saved',{timeoutMs:50}),false);
  }
});
test('finite preparation handles hydration, activates requested tab, and tracks switch-back',async t=>{
  const html=tabs.replace('reds-tab-item active" onclick="window.clicks=(window.clicks||0)+1','reds-tab-item" onclick="this.classList.add(\'active\');this.previousElementSibling.classList.remove(\'active\')').replace('reds-tab-item">笔记','reds-tab-item active">笔记');
  const {page}=await fixture(t,`<body><script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(html)}),70)</script>`);await page.goto(source.url);
  assert.equal(await browserTools.prepareSourceTab(page,'xiaohongshu','saved',{timeoutMs:1000}),true);
  const first=await browserTools.tabSnapshot(page,'xiaohongshu','saved');assert.equal(first.selected,true);
  await page.evaluate(()=>document.querySelector('.reds-tab-item.active').classList.remove('active'));
  await page.evaluate(()=>document.querySelectorAll('.reds-tab-item')[1].classList.add('active'));
  const back=await browserTools.tabSnapshot(page,'xiaohongshu','saved');assert.ok(back.tabGeneration>first.tabGeneration);
});

for(const [name,cursors,bodies,complete] of [
  ['nonempty first cursor',['older'],[payload('one')],false],
  ['missing cursor',[null],[payload('one')],false],
  ['initial plus continuous end',['','next'],[payload('one',true,'next'),payload('two')],true],
  ['cursor gap',['','gap'],[payload('one',true,'next'),payload('two')],false],
  ['out of order',['next',''],[payload('two'),payload('one',true,'next')],false],
  ['cursor loop',['','next'],[payload('one',true,'next'),payload('two',true,'next')],false],
  ['failed payload',[''],[{code:9,success:false,data:payload().data}],false],
])test(`cursor evidence: ${name}`,async t=>{
  const urls=cursors.map(c=>c===null?endpoint().replace('&cursor=',''):endpoint(c));
  const {page}=await fixture(t,legacy+`<script>(async()=>{for(const u of ${JSON.stringify(urls)})await fetch(u)})()</script>`,q=>bodies[urls.indexOf(q.url())]);
  const {result,items}=await scan(page);assert.equal(result.completeness,complete?'complete':'partial');
  if(['nonempty first cursor','missing cursor'].includes(name))assert.equal(result.reasonCode,'history_unproven');
  if(name==='failed payload')assert.equal(items.length,0);else assert.ok(items.length>0);
});
test('traffic before hydration is observed and released only after preparation',async t=>{
  const {page}=await fixture(t,`<body><script>fetch(${JSON.stringify(endpoint())});setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(tabs)}),100)</script>`);
  const {result,items}=await scan(page,{prepare:()=>browserTools.prepareSourceTab(page,'xiaohongshu','saved',{timeoutMs:1000})});
  assert.equal(items.length,1);assert.equal(result.completeness,'partial');
});
test('pre-hydration request remains attributable when its body arrives after preparation',async t=>{
  const {page}=await fixture(t,`<body><script>fetch(${JSON.stringify(endpoint())});setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(tabs)}),60)</script>`,async()=>{await delay(180);return payload();});
  const {result,items}=await scan(page,{prepare:()=>browserTools.prepareSourceTab(page,'xiaohongshu','saved',{timeoutMs:1000})});
  assert.equal(items.length,1);assert.equal(result.completeness,'partial');
});
test('preparation accepts tab group shell followed by delayed child hydration',async t=>{
  const {page}=await fixture(t,`<body><div class="xhs-user-page-primary-tabs"></div><script>fetch(${JSON.stringify(endpoint())});setTimeout(()=>document.querySelector('div').innerHTML='<div class="reds-tab-item active">收藏</div>',60)</script>`);
  const {items}=await scan(page,{prepare:()=>browserTools.prepareSourceTab(page,'xiaohongshu','saved',{timeoutMs:1000})});assert.equal(items.length,1);
});
for(const [name,url,options] of [
  ['wrong origin',endpoint().replace('webapi.','www.'),{}],['wrong path',endpoint().replace('/api/','/other/api/'),{}],
  ['wrong method',endpoint(),{method:'POST'}],['wrong subject',endpoint().replace('owner&','other&'),{}],
  ['duplicate subject',endpoint()+'&user_id=other',{}],['HTTP',endpoint().replace('https:','http:'),{}],
])test(`list provenance rejects ${name}`,async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(url)},${JSON.stringify(options)})</script>`);
  const {items,result}=await scan(page);assert.equal(items.length,0);assert.equal(result.completeness,'partial');
});
test('subframe list cannot publish for main-frame source',async t=>{
  const {page}=await fixture(t,legacy+`<iframe srcdoc='<script>fetch("${endpoint()}")</script>'></iframe>`);
  const {items}=await scan(page);assert.equal(items.length,0);
});
test('queued publication checks lease after identity gate and rejects switch-back',async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())})</script>`,()=>({...payload(),data:{...payload().data,notes:[{note_id:'one'},{note_id:'two'}]}}));
  let calls=0;
  const {items,result}=await scan(page,{beforePublish:async()=>{calls++;await page.evaluate(()=>document.querySelector('[role=tab]').setAttribute('aria-selected','false'));await page.evaluate(()=>document.querySelector('[role=tab]').setAttribute('aria-selected','true'));}});
  assert.ok(calls>0);assert.equal(items.length,0);assert.equal(result.completeness,'partial');
});
for(const replacement of ['children','group','remove restore','label children'])test(`same-batch primary tab replacement retires old source lease: ${replacement}`,async t=>{
  const {page}=await fixture(t,`<section id="tabs-holder">${tabs}</section><script>fetch(${JSON.stringify(endpoint())})</script>`,()=>payload('old'));
  const {items,result}=await scan(page,{beforePublish:()=>page.evaluate(replacement=>{
    const holder=document.querySelector('#tabs-holder'),group=holder.firstElementChild;
    const other='<div class="reds-tab-item active">笔记</div><div class="reds-tab-item">收藏</div>';
    if(replacement==='children'){
      const original=group.innerHTML;group.innerHTML=other;group.innerHTML=original;
    }else if(replacement==='group'){
      const original=holder.innerHTML;holder.innerHTML='<div class="xhs-user-page-primary-tabs">'+other+'</div>';holder.innerHTML=original;
    }else if(replacement==='remove restore'){
      group.remove();holder.append(group);
    }else {
      const active=group.querySelector('.active'),original=active.innerHTML;active.innerHTML='<span>笔记</span>';active.innerHTML=original;
    }
  },replacement)});
  assert.equal(items.length,0);assert.equal(result.completeness,'partial');
});
test('unrelated feed child replacements preserve the primary-tab source lease',async t=>{
  const {page}=await fixture(t,`${tabs}<section id="feed"></section><script>fetch(${JSON.stringify(endpoint())})</script>`);
  const {items,result}=await scan(page,{beforePublish:()=>page.evaluate(()=>{
    const feed=document.querySelector('#feed');feed.innerHTML='<div class="reds-tab-item">feed card</div>';feed.innerHTML='<a>updated feed card</a>';
  })});
  assert.equal(items.length,1);assert.equal(result.completeness,'partial');
});
test('identity gate longer than output timeout is allowed',async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())})</script>`);
  const {items,result}=await scan(page,{beforePublish:()=>delay(5200),maxRounds:1});assert.equal(items.length,1);assert.equal(result.completeness,'complete');
});
test('cancel during noncooperating gate retires work without late item',async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())})</script>`);
  const entered=Promise.withResolvers(),gate=Promise.withResolvers(),controller=new AbortController(),events=[];
  const running=scanPage(page,{source,signal:controller.signal,emit:async(type)=>events.push(type),beforePublish:async()=>{entered.resolve();await gate.promise;},maxRounds:3,waitMs:20});
  const observed=running.catch(e=>e);await Promise.race([entered.promise,delay(1000)]);controller.abort(new Error('stop fixture'));assert.match((await observed).message,/stop fixture/);gate.resolve();await delay(80);assert.equal(events.includes('item'),false);
});
test('private adapter installs observation before owned navigation and retains redirect binding',async t=>{
  const {context}=await fixture(t,`<body>${tabs}<script>if(location.pathname==='/explore')fetch('https://webapi.rednote.com/api/sns/web/v2/user/me');else fetch(${JSON.stringify(endpoint())});</script>`,q=>new URL(q.url()).pathname.endsWith('/me')?{code:0,success:true,data:{user_id:'owner',guest:false}}:payload());
  const events=[];const result=await browserAdapter('xiaohongshu',{open:async()=>context}).scan({request:{source},signal:new AbortController().signal,emit:async(type,p)=>events.push({type,...p})});
  assert.equal(events.filter(e=>e.type==='item').length,1);assert.equal(result.completeness,'partial');
});

test('same-URL new document retires queued old-document items',async t=>{
  const {page}=await fixture(t,legacy+`<script>if(!sessionStorage.loaded){sessionStorage.loaded=1;fetch(${JSON.stringify(endpoint())});}</script>`);
  const {items,result}=await scan(page,{beforePublish:()=>page.reload({waitUntil:'domcontentloaded'})});
  assert.equal(items.length,0);assert.ok(['partial','unknown'].includes(result.completeness));
  if(result.status==='needs_action')assert.equal(result.reasonCode,'source_changed');
});
test('navigation completing while final snapshot is awaited invalidates that old snapshot',async t=>{
  const {page}=await fixture(t,legacy+`<script>if(!sessionStorage.loaded){sessionStorage.loaded=1;fetch(${JSON.stringify(endpoint())});}</script>`);
  const evaluate=page.evaluate.bind(page),reload=page.reload.bind(page);let arm=false,navigation,gates=0,commits=0;
  page.on('framenavigated',()=>commits++);
  page.reload=async options=>{await delay(60);return reload(options);};
  // Preserve the actual DOM snapshot, then delay its delivery across a committed
  // navigation, modeling the asynchronous browser-to-worker return boundary.
  // Concurrent snapshots must share that wait: clearing the arm before commit
  // lets another snapshot publish legitimately before navigation even starts.
  page.evaluate=async(...args)=>{const value=await evaluate(...args);if(arm&&value?.documentId){navigation??=page.reload({waitUntil:'domcontentloaded'}).finally(()=>{arm=false;});await navigation;}return value;};
  const {items}=await scan(page,{beforePublish:async()=>{if(++gates===1){arm=true;void browserTools.tabSnapshot(page,'xiaohongshu','saved').catch(()=>{});}}});
  await navigation;assert.ok(gates>0);assert.ok(commits>=2);assert.equal(items.length,0);
});
test('delayed old response cannot publish after tab switches away and back',async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())});setTimeout(()=>document.querySelector('button').setAttribute('aria-selected','false'),50);setTimeout(()=>document.querySelector('button').setAttribute('aria-selected','true'),100);</script>`,async()=>{await delay(200);return payload();});
  const {items,result}=await scan(page);assert.equal(items.length,0);assert.equal(result.completeness,'partial');
});
test('gate timeout aborts its child signal and retires all queued responses',async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())});fetch(${JSON.stringify(endpoint('next'))})</script>`);
  const gate=Promise.withResolvers();let aborted=false;const events=[];
  const result=await scanPage(page,{source,emit:async(type)=>events.push(type),gateTimeoutMs:40,beforePublish:async({signal})=>{signal.addEventListener('abort',()=>{aborted=true;});await gate.promise;},maxRounds:4,waitMs:25});
  assert.equal(aborted,true);assert.equal(result.status,'needs_action');gate.resolve();await delay(60);assert.equal(events.includes('item'),false);
});
for(const code of ['auth_required','identity_unverified'])test(`fresh identity ActionRequired reason survives the publication gate: ${code}`,async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())})</script>`);
  const {result,items}=await scan(page,{beforePublish:()=>{throw Object.assign(new Error('unverified or changed account'),{code});}});
  assert.equal(result.reasonCode,code);assert.equal(items.length,0);
});

test('fresh identity gate permits slow finite verification before publishing', {timeout:45000}, async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())})</script>`,()=>payload('slow-verified',true,'next'));
  let gates=0;
  const {items,result}=await scan(page,{maxRounds:1,waitMs:1,beforePublish:async()=>{gates++;await delay(26000);}});
  assert.equal(gates,1);assert.equal(items.length,1);assert.equal(items[0].item.contentId,'slow-verified');
  assert.equal(result.completeness,'partial');
});
test('empty terminal list still needs fresh account proof before completion',async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())})</script>`,()=>({code:0,success:true,data:{notes:[],has_more:false,cursor:''}}));
  const {result}=await scan(page,{beforePublish:()=>{throw Object.assign(new Error('changed account'),{code:'auth_required'});}});
  assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'auth_required');
});
test('malformed earlier payload prevents later terminal response claiming completeness',async t=>{
  const {page}=await fixture(t,legacy+`<script>(async()=>{await fetch(${JSON.stringify(endpoint('bad'))});await fetch(${JSON.stringify(endpoint())})})()</script>`,q=>q.url().includes('cursor=bad')?'{bad':payload());
  const {result,items}=await scan(page);assert.equal(items.length,1);assert.equal(result.completeness,'partial');
});
test('oversized and truncated entries cannot establish end proof',async t=>{
  for(const body of [JSON.stringify(payload()).replace('"one"',JSON.stringify('z'.repeat(4*1024*1024))),{...payload(),data:{...payload().data,notes:Array.from({length:1001},()=>({note_id:'one'}))}}]){
    const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())})</script>`,()=>body);
    const {result,items}=await scan(page);assert.equal(items.length,0);assert.equal(result.completeness,'partial');
  }
});
test('reaching requested item limit remains partial even at matching end',async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())})</script>`);
  const {result,items}=await scan(page,{source:{...source,maxItems:1}});assert.equal(items.length,1);assert.equal(result.completeness,'partial');assert.equal(result.reasonCode,'item_limit');
});
test('private adapter rejects profile redirect before publication',async t=>{
  const {context}=await fixture(t,`<body>${tabs}<script>if(location.pathname==='/explore')fetch('https://webapi.rednote.com/api/sns/web/v2/user/me');else fetch(${JSON.stringify(endpoint())});</script>`,q=>new URL(q.url()).pathname.endsWith('/me')?{code:0,success:true,data:{user_id:'owner',guest:false}}:payload());
  // A scripted same-site redirect is intercepted on both navigations. A
  // fulfill(302) would bypass Playwright routing on its follow-up request.
  await context.route('**/user/profile/owner?*',r=>r.fulfill({contentType:'text/html',body:'<script>location.replace("https://www.xiaohongshu.com/user/profile/other")</script>'}));
  const events=[];const result=await browserAdapter('xiaohongshu',{open:async()=>context}).scan({request:{source},signal:new AbortController().signal,emit:async(type,p)=>events.push({type,...p})});
  assert.equal(result.status,'needs_action');assert.equal(events.filter(e=>e.type==='item').length,0);
});

// Small contract doubles cover Playwright response methods that route.fulfill
// cannot emulate (a response body which never settles and service-worker origin).
function observedResponse(page,{worker=false,fromWorker=false,text=()=>Promise.resolve(JSON.stringify(payload())),url=endpoint()}={}){
  const req={url:()=>url,method:()=> 'GET',frame:()=>page.mainFrame(),serviceWorker:()=>worker?{}:null,isNavigationRequest:()=>false};
  const response={request:()=>req,status:()=>200,ok:()=>true,headers:()=>({'content-type':'application/json'}),fromServiceWorker:()=>fromWorker,text};
  page.emit('request',req);page.emit('response',response);
}
for(const setting of [{worker:true},{fromWorker:true}])test(`service-worker provenance excluded ${JSON.stringify(setting)}`,async t=>{
  const {page}=await fixture(t,legacy);
  const {items}=await scan(page,{prepare:()=>observedResponse(page,setting)});assert.equal(items.length,0);
});
test('body timeout is finite and cannot later publish or prove end',async t=>{
  const {page}=await fixture(t,legacy),body=Promise.withResolvers();const events=[];
  const result=await scanPage(page,{source,bodyTimeoutMs:30,emit:async(type)=>events.push(type),prepare:()=>observedResponse(page,{text:()=>body.promise}),maxRounds:1,waitMs:10});
  assert.equal(result.completeness,'partial');body.resolve(JSON.stringify(payload()));await delay(50);assert.equal(events.includes('item'),false);
});
test('terminal response cannot certify completeness while another matching request is unresolved',async t=>{
  const {page}=await fixture(t,legacy+`<script>fetch(${JSON.stringify(endpoint())});fetch(${JSON.stringify(endpoint('late'))})</script>`,async q=>{if(q.url().includes('cursor=late'))await delay(800);return payload();});
  const {result}=await scan(page);assert.equal(result.completeness,'partial');
});
test('pending candidate budget drops excess with partial completion',async t=>{
  const {page}=await fixture(t,legacy);
  const {result}=await scan(page,{prepare:()=>{for(let i=0;i<12;i++)observedResponse(page,{text:async()=>{await delay(30);return JSON.stringify(payload());}});}});
  assert.equal(result.completeness,'partial');
});

for(const outcome of ['continue','unmatched','cancel','page close','context close'])test(`private tab manual intervention lifecycle: ${outcome}`,async t=>{
  let identityRequests=0;
  const {context,page}=await fixture(t,`<body><script>if(location.pathname==='/explore')fetch('https://webapi.rednote.com/api/sns/web/v2/user/me');</script>`,q=>{
    if(new URL(q.url()).pathname.endsWith('/me')){identityRequests++;return {code:0,success:true,data:{user_id:'owner',guest:false}};}
    return payload();
  });
  const controller=new AbortController(),resume=Promise.withResolvers(),events=[];let waiting=false,waitRetired=false;
  const controls={waitFor:(command,signal)=>{
    assert.equal(command,'continue');waiting=true;
    return new Promise((resolve,reject)=>{
      const abort=()=>{waitRetired=true;reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
      resume.promise.then(()=>{signal.removeEventListener('abort',abort);waitRetired=true;resolve();});
      if(signal.aborted)abort();
    });
  }};
  const result=await browserAdapter('xiaohongshu',{open:async()=>context}).scan({request:{source},signal:controller.signal,controls,emit:async(type,p)=>{
    events.push({type,...p});if(type!=='needs_action'||!p.awaitingInput)return;
    assert.equal(p.code,'source_tab_required');
    assert.equal(page.isClosed(),false);assert.equal(waiting,true);
    if(outcome==='continue'){
      await page.evaluate(({tabs,url})=>{document.body.insertAdjacentHTML('beforeend',tabs);return fetch(url);},{tabs,url:endpoint()});resume.resolve();
    }else if(outcome==='unmatched')resume.resolve();
    else if(outcome==='cancel')controller.abort(new Error('manual cancel'));
    else if(outcome==='page close')await page.close();
    else await context.close();
  }}).catch(error=>({error}));
  assert.equal(waiting,true);assert.equal(waitRetired,true);
  if(outcome==='continue'){
    assert.equal(result.completeness,'partial');assert.equal(events.filter(e=>e.type==='item').length,1);assert.ok(identityRequests>=3);
  }else {
    assert.equal(events.filter(e=>e.type==='item').length,0);
    if(outcome==='cancel')assert.match(result.error?.message??'',/manual cancel/);
    else {assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,outcome==='unmatched'?'source_tab_required':'browser_closed');}
  }
});
