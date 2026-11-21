import './fixtures/offline-network.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { prepareSourceTab, tabSnapshot } from '../src/shared/browser.mjs';
import { scanPage } from '../src/shared/scanner.mjs';
import { sourceTabState } from '../src/shared/source-observation.mjs';
import { getEventListeners } from 'node:events';

// Synthetic fixtures only: every browser request is fulfilled locally.
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url))});});
after(async()=>{await browser?.close();});
const source={platform:'douyin',kind:'saved',url:'https://www.douyin.com/user/synthetic',accountId:'synthetic'};
const endpoint='https://www.douyin.com/aweme/v1/web/aweme/listcollection/?sec_user_id=synthetic&max_cursor=0';
const payload={status_code:0,aweme_list:[{aweme_id:'1234567890123456789',desc:'synthetic',video:{play_addr:{url_list:['https://media.invalid/synthetic.mp4']}}}],has_more:0,max_cursor:0};
const other='<div id="other" role="tablist"><button role="tab" aria-selected="true">视频</button><button role="tab">用户</button></div>';
function group(active='saved',works='作品 12.3万',include=['profile','saved','liked']) {
  const labels={profile:works,saved:'收藏',liked:'喜欢'};
  return `<div id="primary" role="tablist">${include.map(k=>`<button id="${k}" role="tab" aria-selected="${k===active}" onclick="window.clicks=(window.clicks||0)+1;for(const t of this.parentElement.querySelectorAll('[role=tab]'))t.setAttribute('aria-selected',String(t===this))"><span> ${labels[k]} </span></button>`).join('')}</div>`;
}
async function fixture(t,html){
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',r=>r.fulfill(new URL(r.request().url()).pathname.includes('/aweme/v1/')?{contentType:'application/json',body:JSON.stringify(payload)}:{contentType:'text/html; charset=utf-8',body:`<body><section id="holder">${html}</section><section id="feed"></section></body>`}));
  const page=await context.newPage();return page;
}
async function open(t,html){const page=await fixture(t,html);await page.goto(source.url);return page;}
const snapshot=page=>tabSnapshot(page,'douyin','saved');
const clicks=page=>page.evaluate(()=>window.clicks||0);
async function scan(page,extra={}){
  const events=[];const result=await scanPage(page,{source,emit:async(type,p)=>events.push({type,...p}),maxRounds:4,waitMs:25,...extra});
  return {result,items:events.filter(e=>e.type==='item')};
}

test('scoped preparation accepts profile saved liked despite unrelated selected tabs',async t=>{
  for(const kind of ['saved','liked','profile'])for(const already of [true,false]){
    const page=await open(t,group(already?kind:(kind==='saved'?'profile':'saved'))+other);
    // This verifies recognition/click behavior, not a subsecond timing budget.
    assert.equal(await prepareSourceTab(page,'douyin',kind),true,`${kind}: already=${already}`);
    assert.equal((await tabSnapshot(page,'douyin',kind)).selected,true);assert.equal(await clicks(page),already?0:1);
  }
  const page=await open(t,group('profile','作品',['profile','liked'])+other);
  assert.equal(await prepareSourceTab(page,'douyin','profile'),true);
  for(const kind of ['saved','liked']){const s=await tabSnapshot(page,'douyin',kind);assert.equal(s.selected,false);assert.equal(s.label,'');}
});

function nestedNativeTabs(event) {
  const labels={profile:'作品0',liked:'喜欢',saved:'收藏'};
  return `<div id="primary" role="tablist">${Object.entries(labels).map(([kind,label])=>`<div id="${kind}" role="tab" aria-selected="${kind==='profile'}"><div id="${kind}-label">${label}</div></div>`).join('')}</div><div role="tablist"><div role="tab" aria-selected="true">收藏夹</div><div role="tab" aria-selected="false">视频</div></div><script>
    window.clicks=0;
    const tab=document.querySelector('#saved'), inner=document.querySelector('#saved-label');
    const target=${JSON.stringify(event)}==='root-click'?tab:inner;
    target.addEventListener(${JSON.stringify(event==='pointerdown'?'pointerdown':'click')},e=>{
      if(${JSON.stringify(event)}==='trusted'&&!e.isTrusted)return;
      window.clicks++;window.lastTarget=e.target.id;window.lastTrusted=e.isTrusted;
      for(const t of document.querySelector('#primary').children)t.setAttribute('aria-selected',String(t===tab));
    });
  </script>`;
}
for(const [event,name] of [['root-click','root click baseline'],['click','inner DIV click'],['pointerdown','inner DIV pointerdown'],['trusted','inner DIV trusted click']])test(`native source-tab preparation: ${name}`,async t=>{
  const page=await open(t,nestedNativeTabs(event));
  assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:400}),true);
  assert.equal((await snapshot(page)).selected,true);assert.equal(await clicks(page),1);
  if(event!=='root-click')assert.equal(await page.evaluate(()=>window.lastTarget),'saved-label');
  if(event==='trusted')assert.equal(await page.evaluate(()=>window.lastTrusted),true);
});

test('internal target handles share strict recognition and reject stale snapshots',async t=>{
  const page=await open(t,nestedNativeTabs('click')),initial=await snapshot(page);
  for(const expected of [{...initial,url:initial.url+'?different=1'},{...initial,documentId:'another'},{...initial,tabGeneration:initial.tabGeneration+1}]){
    const handle=await page.evaluateHandle(sourceTabState,{platform:'douyin',kind:'saved',targetHandle:expected});
    try{assert.equal(handle.asElement(),null);}finally{await handle.dispose();}
  }
  const handle=await page.evaluateHandle(sourceTabState,{platform:'douyin',kind:'saved',targetHandle:initial});
  try{assert.equal(await handle.asElement()?.getAttribute('id'),'saved');}finally{await handle.dispose();}
  await page.evaluate(()=>document.querySelector('#primary').insertAdjacentHTML('beforeend','<div role="tab">收藏</div>'));
  const ambiguous=await page.evaluateHandle(sourceTabState,{platform:'douyin',kind:'saved',targetHandle:await snapshot(page)});
  try{assert.equal(ambiguous.asElement(),null);}finally{await ambiguous.dispose();}
  assert.equal(await clicks(page),0);
});

test('native click accepts same-document source query and selection generation changes',async t=>{
  const page=await open(t,nestedNativeTabs('click')),initial=await snapshot(page);
  await page.evaluate(()=>document.querySelector('#saved-label').addEventListener('click',()=>history.replaceState({},'',location.pathname+'?showTab=collect')));
  assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:500}),true);
  const last=await snapshot(page);assert.equal(last.documentId,initial.documentId);assert.ok(last.tabGeneration>initial.tabGeneration);assert.match(last.url,/showTab=collect/);assert.equal(await clicks(page),1);
});

for(const change of ['profile','work','document'])test(`native click refuses a changed ${change} even when saved becomes selected`,async t=>{
  const page=await open(t,nestedNativeTabs('click'));
  if(change==='document')await page.context().route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:group('saved')}));
  await page.evaluate(change=>document.querySelector('#saved-label').addEventListener('click',()=>{
    if(change==='profile')history.replaceState({},'','/user/another?showTab=collect');
    else if(change==='work')history.replaceState({},'',location.pathname+'?modal_id=123');
    else location.reload();
  }),change);
  assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:700}),false);
  assert.equal((await snapshot(page)).selected,true);
});

function trackNativeTargets(page,{onAcquire=async()=>{},onFailure=async()=>{}}={}){
  const evaluateHandle=page.evaluateHandle.bind(page),seen={acquisitions:0,attempts:0,completed:0,disposed:0,failures:[],timeouts:[]};
  page.evaluateHandle=async(...args)=>{
    const handle=await evaluateHandle(...args);
    if(handle.asElement()){
      const index=++seen.acquisitions,dispose=handle.dispose.bind(handle),click=handle.click.bind(handle);
      handle.dispose=async()=>{await dispose();seen.disposed++;};
      handle.click=async options=>{
        seen.attempts++;seen.timeouts.push(options.timeout);
        try{await click(options);seen.completed++;}
        catch(error){seen.failures.push(error);await onFailure(error,index);throw error;}
      };
      await onAcquire(index);
    }
    return handle;
  };
  return seen;
}
const replaceSaved=()=>{const e=document.querySelector('#saved');e.outerHTML=e.outerHTML;};

for(const selected of [false,true])test(`detached native target recovers from a scoped replacement: selected=${selected}`,async t=>{
  const page=await open(t,group('profile'));
  const seen=trackNativeTargets(page,{onAcquire:async index=>{
    if(index===1){
      await page.evaluate(replaceSaved);
      if(selected)await page.evaluate(()=>{for(const e of document.querySelector('#primary').children)e.setAttribute('aria-selected',String(e.id==='saved'));});
    }else assert.equal(seen.disposed,1,'detached handle must be disposed before reacquisition');
  }});
  const result=await prepareSourceTab(page,'douyin','saved',{timeoutMs:700}),received=await clicks(page);
  t.diagnostic(JSON.stringify({result,clicks:received,attempts:seen.attempts,completed:seen.completed,failures:seen.failures.map(e=>e.message.split('\n')[0])}));
  assert.equal(seen.failures.length,1);assert.match(seen.failures[0].message,/Element is not attached to the DOM/);
  assert.equal(result,true);assert.equal(received,selected?0:1);assert.equal(seen.completed,selected?0:1);
  assert.equal(seen.acquisitions,selected?1:2);assert.equal(seen.attempts,selected?1:2);assert.equal(seen.disposed,seen.acquisitions);
  assert.equal((await snapshot(page)).selected,true);
});

for(const change of ['ambiguous','profile','work','document'])test(`detached native target refuses a changed ${change} before reacquisition`,async t=>{
  const page=await open(t,group('profile'));
  const seen=trackNativeTargets(page,{onAcquire:()=>page.evaluate(replaceSaved),onFailure:async()=>{
    if(change==='document')await page.reload();
    else await page.evaluate(change=>{
      if(change==='ambiguous')document.querySelector('#primary').append(document.querySelector('#saved').cloneNode(true));
      else if(change==='profile')history.replaceState({},'','/user/another');
      else history.replaceState({},'',location.pathname+'?modal_id=123');
    },change);
  }});
  assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:300}),false);
  assert.equal(seen.attempts,1);assert.equal(seen.acquisitions,1);assert.equal(seen.disposed,1);assert.equal(seen.completed,0);
  assert.match(seen.failures[0].message,/Element is not attached to the DOM/);assert.equal(await clicks(page),0);
});

for(const selected of [false,true])test(`detached native targets stop after three attempts: selected=${selected}`,async t=>{
  const page=await open(t,group('profile'));
  const seen=trackNativeTargets(page,{onAcquire:async index=>{
    await page.evaluate(replaceSaved);
    if(selected&&index===3)await page.evaluate(()=>{for(const e of document.querySelector('#primary').children)e.setAttribute('aria-selected',String(e.id==='saved'));});
  }});
  const result=await Promise.race([prepareSourceTab(page,'douyin','saved',{timeoutMs:600}),new Promise(resolve=>setTimeout(()=>resolve('over_attempt_budget'),1000))]);
  assert.equal(result,selected);assert.equal(seen.attempts,3);assert.equal(seen.acquisitions,3);assert.equal(seen.disposed,3);assert.equal(seen.completed,0);
  assert.equal(seen.failures.length,3);for(const error of seen.failures)assert.match(error.message,/Element is not attached to the DOM/);
  assert.equal(page.isClosed(),false);assert.equal(await clicks(page),0);
});

test('detached native retry keeps the original deadline and does not retry an obstructed timeout',async t=>{
  const page=await open(t,group('profile'));
  const seen=trackNativeTargets(page,{onAcquire:async index=>{if(index===1)await page.evaluate(replaceSaved);else await page.evaluate(cover);}});
  const result=await Promise.race([prepareSourceTab(page,'douyin','saved',{timeoutMs:300}),new Promise(resolve=>setTimeout(()=>resolve('over_budget'),1000))]);
  assert.equal(result,false);assert.equal(seen.attempts,2);assert.equal(seen.acquisitions,2);assert.equal(seen.disposed,2);assert.equal(seen.completed,0);
  assert.match(seen.failures[0].message,/Element is not attached to the DOM/);assert.equal(seen.failures[1].name,'TimeoutError');
  assert.ok(seen.timeouts[0]<=300);assert.ok(seen.timeouts[1]<seen.timeouts[0]-40);
  assert.equal(page.isClosed(),false);await page.evaluate(()=>document.querySelector('#overlay').remove());
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await clicks(page),0);
});

test('empty target handle retries a fresh snapshot after a source generation change',async t=>{
  const page=await open(t,nestedNativeTabs('root-click')),evaluateHandle=page.evaluateHandle.bind(page);
  const acquired=[],disposed=[];let changed;
  page.evaluateHandle=async(...args)=>{
    if(!acquired.length){
      const before=args[1].targetHandle;
      await page.evaluate(()=>{const inner=document.querySelector('#saved-label');inner.replaceWith(inner.cloneNode(true));});
      changed=await snapshot(page);
      assert.equal(changed.documentId,before.documentId);assert.equal(changed.url,before.url);assert.ok(changed.tabGeneration>before.tabGeneration);
    }else assert.deepEqual(disposed,['empty'],'empty handle must be disposed before reacquisition');
    const handle=await evaluateHandle(...args),type=handle.asElement()?'element':'empty',dispose=handle.dispose.bind(handle);
    acquired.push(type);handle.dispose=async()=>{await dispose();disposed.push(type);};return handle;
  };
  const result=await prepareSourceTab(page,'douyin','saved',{timeoutMs:700}),received=await clicks(page);
  t.diagnostic(JSON.stringify({result,clicks:received,acquired,disposed}));
  assert.equal(acquired[0],'empty','the first real acquisition must reject the stale generation');
  assert.equal(result,true);assert.equal(received,1);assert.deepEqual(acquired,['empty','element']);assert.deepEqual(disposed,['empty','element']);
  assert.equal((await snapshot(page)).selected,true);
});

test('empty target handles remain bounded when the source keeps changing',async t=>{
  const page=await open(t,nestedNativeTabs('root-click')),evaluateHandle=page.evaluateHandle.bind(page);
  let acquisitions=0,disposals=0;
  page.evaluateHandle=async(...args)=>{
    assert.equal(disposals,acquisitions,'previous empty handle must be disposed before reacquisition');
    await page.evaluate(()=>{const inner=document.querySelector('#saved-label');inner.replaceWith(inner.cloneNode(true));});
    const handle=await evaluateHandle(...args),dispose=handle.dispose.bind(handle);acquisitions++;
    assert.equal(handle.asElement(),null);
    handle.dispose=async()=>{await dispose();disposals++;};return handle;
  };
  const result=await Promise.race([prepareSourceTab(page,'douyin','saved',{timeoutMs:260}),new Promise(resolve=>setTimeout(()=>resolve('over_budget'),1000))]);
  assert.equal(result,false);assert.ok(acquisitions>=2);assert.equal(disposals,acquisitions);
  assert.equal(page.isClosed(),false);assert.equal(await clicks(page),0);
});

test('empty target reacquisition cancellation closes its page and disposes the late handle',async t=>{
  const page=await open(t,nestedNativeTabs('root-click')),evaluateHandle=page.evaluateHandle.bind(page),controller=new AbortController();
  const second=Promise.withResolvers(),release=Promise.withResolvers(),lateDisposed=Promise.withResolvers();
  let acquisitions=0,disposals=0,received=0;t.after(()=>release.resolve());
  await page.exposeFunction('syntheticClick',()=>{received++;});await page.evaluate(()=>document.querySelector('#saved').addEventListener('click',()=>window.syntheticClick()));
  page.evaluateHandle=async(...args)=>{
    assert.equal(disposals,acquisitions);
    await page.evaluate(()=>{const inner=document.querySelector('#saved-label');inner.replaceWith(inner.cloneNode(true));});
    const handle=await evaluateHandle(...args),dispose=handle.dispose.bind(handle);acquisitions++;
    assert.equal(handle.asElement(),null);
    handle.dispose=async()=>{await dispose();disposals++;if(acquisitions===2)lateDisposed.resolve(true);};
    if(acquisitions===2){second.resolve(true);await release.promise;}return handle;
  };
  const before=getEventListeners(controller.signal,'abort').length;
  const running=prepareSourceTab(page,'douyin','saved',{signal:controller.signal,timeoutMs:1500});void running.catch(()=>{});
  assert.equal(await Promise.race([second.promise,new Promise(resolve=>setTimeout(()=>resolve(false),1000))]),true);
  controller.abort(new Error('synthetic empty target stop'));await assert.rejects(running,/synthetic empty target stop/);
  assert.equal(page.isClosed(),true);assert.equal(disposals,1);assert.equal(getEventListeners(controller.signal,'abort').length,before);
  release.resolve();assert.equal(await Promise.race([lateDisposed.promise,new Promise(resolve=>setTimeout(()=>resolve(false),500))]),true);
  assert.equal(acquisitions,2);assert.equal(disposals,2);assert.equal(received,0);
});

for(const mode of ['deadline','abort'])test(`source snapshot ${mode} settles without a late click`,{timeout:5000},async t=>{
  const page=await open(t,group('profile'));
  const evaluate=page.evaluate.bind(page),evaluateHandle=page.evaluateHandle.bind(page);
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),delivered=Promise.withResolvers();
  const controller=new AbortController();let acquisitions=0;
  t.after(()=>release.resolve());
  page.evaluate=async(...args)=>{
    const value=await evaluate(...args);
    if(args[0]===sourceTabState){entered.resolve();await release.promise;delivered.resolve();}
    return value;
  };
  page.evaluateHandle=async(...args)=>{acquisitions++;return evaluateHandle(...args);};
  const listeners=getEventListeners(controller.signal,'abort').length;
  const running=prepareSourceTab(page,'douyin','saved',{signal:controller.signal,timeoutMs:mode==='deadline'?150:2000});
  void running.catch(()=>{});
  await entered.promise;
  if(mode==='abort'){
    const reason=new Error('synthetic snapshot cancellation');controller.abort(reason);
    await assert.rejects(running,error=>error===reason);
  }else assert.equal(await running,false);
  assert.equal(page.isClosed(),mode==='abort');
  assert.equal(getEventListeners(controller.signal,'abort').length,listeners);
  release.resolve();await delivered.promise;await new Promise(setImmediate);
  assert.equal(acquisitions,0,'a retired snapshot must never acquire a native click target');
  if(mode==='deadline')assert.equal(await clicks(page),0);
});

test('target acquisition has remaining budget and disposes its late handle without clicking',async t=>{
  const page=await open(t,nestedNativeTabs('root-click')),evaluateHandle=page.evaluateHandle.bind(page),acquired=Promise.withResolvers(),release=Promise.withResolvers(),disposed=Promise.withResolvers();
  let acquisitions=0,disposals=0,nativeClicks=0;t.after(()=>release.resolve());
  page.evaluateHandle=async(...args)=>{
    const handle=await evaluateHandle(...args);acquisitions++;
    const dispose=handle.dispose.bind(handle),click=handle.click.bind(handle);
    handle.dispose=async()=>{disposals++;await dispose();disposed.resolve();};handle.click=async(...args)=>{nativeClicks++;return click(...args);};
    acquired.resolve();await release.promise;return handle;
  };
  const running=prepareSourceTab(page,'douyin','saved',{timeoutMs:50});void running.catch(()=>{});
  await acquired.promise;
  const result=await Promise.race([running,new Promise(resolve=>setTimeout(()=>resolve('over_budget'),150))]);
  assert.equal(result,false);assert.equal(page.isClosed(),false);assert.equal(nativeClicks,0);
  release.resolve();await Promise.race([disposed.promise,new Promise(resolve=>setTimeout(resolve,250))]);
  assert.equal(acquisitions,1);assert.equal(disposals,1);assert.equal(nativeClicks,0);assert.equal(await clicks(page),0);
});

test('already selected source is a no-op without target handle acquisition',async t=>{
  const page=await open(t,group('saved')+other);page.evaluateHandle=()=>{throw new Error('selected source must not acquire click target');};
  assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:100}),true);assert.equal(await clicks(page),0);
});

const cover=()=>{const overlay=document.createElement('div');overlay.id='overlay';overlay.style='position:fixed;inset:0;background:white;z-index:99999';document.body.append(overlay);};
test('ordinary native click timeout retains browser for manual handling without a late click',async t=>{
  const page=await open(t,nestedNativeTabs('click'));await page.evaluate(cover);
  assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:180}),false);assert.equal(page.isClosed(),false);
  await page.evaluate(()=>document.querySelector('#overlay').remove());await new Promise(r=>setTimeout(r,100));assert.equal(await clicks(page),0);
});

for(const detachFirst of [false,true])test(`preparation child cancellation closes its source page and settles obstructed click: detached=${detachFirst}`,async t=>{
  const page=await open(t,group('profile'));await page.evaluate(cover);
  const controller=new AbortController(),started=Promise.withResolvers(),evaluateHandle=page.evaluateHandle.bind(page);let settled=false,received=0,disposed=0,acquisitions=0;
  await page.exposeFunction('syntheticClick',()=>{received++;});await page.evaluate(()=>document.querySelector('#primary').addEventListener('click',()=>window.syntheticClick()));
  page.evaluateHandle=async(...args)=>{
    const handle=await evaluateHandle(...args);
    if(handle.asElement()){
      const detached=detachFirst&&++acquisitions===1;
      const click=handle.click.bind(handle),dispose=handle.dispose.bind(handle);
      handle.click=async options=>{if(!detached)started.resolve(options);try{return await click(options);}finally{if(!detached)settled=true;}};
      handle.dispose=async()=>{disposed++;await dispose();};
      if(detached)await page.evaluate(replaceSaved);
    }
    return handle;
  };
  const before=getEventListeners(controller.signal,'abort').length;
  const running=prepareSourceTab(page,'douyin','saved',{signal:controller.signal,timeoutMs:1500});void running.catch(()=>{});
  const options=await Promise.race([started.promise,new Promise(resolve=>setTimeout(()=>resolve(null),2000))]);assert.ok(options);assert.ok(options.timeout>0&&options.timeout<=1500);assert.equal(options.force,undefined);
  controller.abort(new Error('synthetic child stop'));await assert.rejects(running,/synthetic child stop/);
  assert.equal(page.isClosed(),true);assert.equal(settled,true);assert.equal(disposed,detachFirst?2:1);assert.equal(getEventListeners(controller.signal,'abort').length,before);
  await new Promise(r=>setTimeout(r,100));assert.equal(received,0);
});

test('ambiguous hidden duplicate and nested semantic sources refuse clicks',async t=>{
  const valid=group('profile');
  const cases=[valid+valid,valid+`<section hidden>${valid}</section>`,valid.replace('</div>','<button role="tab">收藏</button></div>'),valid.replace('</div>','<button role="tab">赞过</button></div>'),valid.replace('id="saved"','hidden id="saved"'),`<section style="opacity:0">${valid}</section>`,valid.replace('</div>',group()+'</div>'),valid.replace('id="saved" role="tab" aria-selected="false"','id="saved" role="tab" aria-selected="true"'),valid.replace('id="liked" role="tab" aria-selected="false"','id="liked" role="tab" aria-selected="maybe"'),valid.replace('id="primary"','inert id="primary"'),valid.replace('id="primary"','aria-hidden="true" id="primary"')];
  for(const [i,html] of cases.entries()){
    const page=await open(t,html+'<button role="tab" aria-selected="true">收藏</button>');
    const s=await snapshot(page);assert.equal(s.selected,false,`case ${i}`);assert.equal(s.label,'',`case ${i}`);
    assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:200}),false,`case ${i}`);assert.equal(await clicks(page),0);
  }
});

test('semantic hydration waits within preparation and no-op click never succeeds',async t=>{
  for(const initial of [other,other+'<div role="tablist" id="shell"></div>']){
    const page=await open(t,initial);const early=await snapshot(page);assert.equal(early.pending,true);assert.equal(early.label,'');
    await page.evaluate(html=>setTimeout(()=>document.querySelector('#holder').insertAdjacentHTML('beforeend',html),60),group());
    assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:1000}),true);
    assert.equal((await snapshot(page)).tabGeneration,early.tabGeneration);
  }
  const page=await open(t,'<div role="tablist"><button role="tab">作品</button></div>');
  assert.equal((await snapshot(page)).pending,false);assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:80}),false);
  const absent=await open(t,other);assert.equal(await prepareSourceTab(absent,'douyin','saved',{timeoutMs:80}),false);
  const noop=await open(t,group('profile'));await noop.evaluate(()=>document.querySelector('#saved').onclick=()=>{window.clicks=(window.clicks||0)+1;});
  assert.equal(await prepareSourceTab(noop,'douyin','saved',{timeoutMs:100}),false);assert.equal(await clicks(noop),1);
});

test('fixed labels and works counts reject arbitrary text',async t=>{
  for(const label of ['作品','作品 12345678','作品 ( 12.34 万 )','作品（1亿）','作品 0.5万']){
    const page=await open(t,group('saved',label));assert.equal((await snapshot(page)).selected,true,label);
    const first=await snapshot(page);await page.evaluate(()=>document.querySelector('#profile span').textContent='作品 999');assert.equal((await snapshot(page)).tabGeneration,first.tabGeneration);
  }
  const counts=await open(t,group().replace('作品 12.3万','作品 <em>12</em>'));
  const countStart=await snapshot(counts);
  await counts.evaluate(()=>document.querySelector('#profile em').firstChild.data='13');assert.equal((await snapshot(counts)).tabGeneration,countStart.tabGeneration);
  await counts.evaluate(()=>document.querySelector('#profile em').textContent='14');assert.equal((await snapshot(counts)).tabGeneration,countStart.tabGeneration);
  for(const label of ['作品集','作品 +12','作品 123456789','作品 1.234万','作品 (12）','作品 12万次']){
    const page=await open(t,group('saved',label));assert.equal((await snapshot(page)).selected,false,label);
  }
  for(const html of [group().replace(' 收藏 ',' 我的收藏 '),group().replace(' 收藏 ',' 收藏 2 '),group().replace('id="saved"','aria-label="喜欢" id="saved"'),group().replace(' 收藏 ','<span>收藏</span>夹'),group().replace('id="saved"','aria-label="收藏夹" id="saved"')]){
    const page=await open(t,html);const s=await snapshot(page);assert.equal(s.selected,false);assert.equal(s.label,'');
  }
  const alias=await open(t,group().replace(' 喜欢 ',' 赞过 '));assert.equal((await snapshot(alias)).selected,true);
  // Xiaohongshu renamed its profile tab to 点赞 (observed 2026-11-17).
  const renamed=await open(t,group().replace(' 喜欢 ',' 点赞 '));assert.equal((await snapshot(renamed)).selected,true);
});

const mutations={
  selection:()=>{const e=document.querySelector('#saved');e.setAttribute('aria-selected','false');e.setAttribute('aria-selected','true');},
  group:()=>{const e=document.querySelector('#primary'),p=e.parentElement;e.remove();p.append(e);},
  ancestor:()=>{const e=document.querySelector('#holder'),p=e.parentElement;e.remove();p.append(e);},
  equalMarkup:()=>{const e=document.querySelector('#primary');e.outerHTML=e.outerHTML;},
  labelChildren:()=>{const e=document.querySelector('#saved');const old=e.innerHTML;e.innerHTML='<span>喜欢</span>';e.innerHTML=old;},
  labelText:()=>{const e=document.querySelector('#saved span').firstChild,old=e.data;e.data='喜欢';e.data=old;},
  role:()=>{const e=document.querySelector('#primary');e.setAttribute('role','group');e.setAttribute('role','tablist');},
  name:()=>{const e=document.querySelector('#saved');e.setAttribute('aria-label','喜欢');e.removeAttribute('aria-label');},
  visibility:()=>{const e=document.querySelector('#holder');e.hidden=true;e.hidden=false;},
  nested:()=>{const e=document.createElement('div');e.setAttribute('role','tablist');e.innerHTML='<button role="tab">作品</button><button role="tab">收藏</button>';document.querySelector('#primary').append(e);e.remove();},
  competing:()=>{const e=document.createElement('div');e.setAttribute('role','tablist');e.innerHTML='<button role="tab">作品</button><button role="tab">收藏</button>';document.body.append(e);e.remove();},
  existingCompetingText:()=>{const [a,b]=document.querySelector('#other').children;const x=a.firstChild,y=b.firstChild,oldX=x.data,oldY=y.data;x.data='作品';y.data='收藏';x.data=oldX;y.data=oldY;},
  existingCompetingChildren:()=>{const [a,b]=document.querySelector('#other').children,oldA=a.textContent,oldB=b.textContent;a.textContent='作品';b.textContent='收藏';a.textContent=oldA;b.textContent=oldB;},
};
for(const [name,mutate] of Object.entries(mutations))test(`same-batch source mutations retire generation: ${name}`,async t=>{
  const page=await open(t,group()+other);const first=await snapshot(page);assert.equal(first.selected,true);
  await page.evaluate(mutate);const last=await snapshot(page);assert.equal(last.selected,true);assert.equal(last.documentId,first.documentId);assert.ok(last.tabGeneration>first.tabGeneration,name);
});
for(const [name,mutate] of Object.entries(mutations))test(`scanner publication retains only current semantic source leases: ${name}`,async t=>{
  const page=await fixture(t,group()+other+`<script>fetch(${JSON.stringify(endpoint)})</script>`);let gates=0;
  const {items,result}=await scan(page,{beforePublish:async()=>{gates++;await page.evaluate(mutate);}});
  assert.ok(gates>0);assert.equal(items.length,0);assert.notEqual(result.completeness,'complete');
});
test('scanner publication preserves unrelated selection children and feed changes',async t=>{
  const page=await fixture(t,group()+other+`<script>fetch(${JSON.stringify(endpoint)})</script>`);
  let first;
  const {items,result}=await scan(page,{beforePublish:async()=>{
    const before=await snapshot(page);first??=before;
    await page.evaluate(()=>{const g=document.querySelector('#other');g.firstElementChild.setAttribute('aria-selected','false');g.lastElementChild.setAttribute('aria-selected','true');g.firstElementChild.innerHTML='<span>另一个</span>';document.querySelector('#feed').innerHTML='<p>new feed</p>';document.querySelector('#profile span').textContent='作品 999';});
    assert.equal((await snapshot(page)).tabGeneration,first.tabGeneration);
  }});assert.equal(items.length,1);assert.equal(result.completeness,'complete');
});

test('unrelated label history without a simultaneous source combination preserves publication',async t=>{
  const page=await fixture(t,group()+other+`<script>fetch(${JSON.stringify(endpoint)})</script>`);
  const {items,result}=await scan(page,{beforePublish:async()=>{
    const before=await snapshot(page);
    await page.evaluate(()=>{const [a,b]=document.querySelector('#other').children,x=a.firstChild,y=b.firstChild,oldX=x.data,oldY=y.data;x.data='作品';x.data=oldX;y.data='收藏';y.data=oldY;x.data='关注';x.data=oldX;});
    assert.equal((await snapshot(page)).tabGeneration,before.tabGeneration);
  }});assert.equal(items.length,1);assert.equal(result.completeness,'complete');
});
test('scanner owner-bound initial hydration and first tab confirmation publish only partial discoveries',async t=>{
  const page=await fixture(t,other);
  const {items}=await scan(page,{prepare:async()=>{
    await Promise.all([page.waitForResponse(r=>r.url()===endpoint),page.evaluate(url=>fetch(url),endpoint)]);
    await page.evaluate(html=>document.querySelector('#holder').insertAdjacentHTML('beforeend',html),group());
    assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:1000}),true);
  }});assert.equal(items.length,1);
  const works=await fixture(t,group('profile')+other);
  const old=await scan(works,{prepare:async()=>{
    await Promise.all([works.waitForResponse(r=>r.url()===endpoint),works.evaluate(url=>fetch(url),endpoint)]);
    assert.equal(await prepareSourceTab(works,'douyin','saved',{timeoutMs:1000}),true);
  }});assert.equal(old.items.length,1);assert.notEqual(old.result.completeness,'complete');
});
test('scanner same-URL document reload retires queued items',async t=>{
  const page=await fixture(t,group()+other+`<script>if(!sessionStorage.loaded){sessionStorage.loaded=1;fetch(${JSON.stringify(endpoint)});}</script>`);
  const {items,result}=await scan(page,{beforePublish:()=>page.reload({waitUntil:'domcontentloaded'})});assert.equal(items.length,0);assert.notEqual(result.completeness,'complete');
});
test('no-tablist legacy and XHS retain behavior and semantic shells suppress fallback',async t=>{
  const legacy='<button role="tab" aria-selected="true">收藏</button>';
  const page=await open(t,legacy);assert.equal(await prepareSourceTab(page,'douyin','saved',{timeoutMs:100}),true);assert.equal((await snapshot(page)).selected,true);
  for(const shell of ['<div role="tablist"></div>','<div role="tablist" hidden></div>']){const p=await open(t,shell+legacy);const s=await snapshot(p);assert.equal(s.selected,false);assert.equal(s.label,'');}
  for(const html of [legacy,'<div class="xhs-user-page-primary-tabs"><div class="reds-tab-item active">收藏</div></div>']){
    const p=await open(t,html);assert.equal(await prepareSourceTab(p,'xiaohongshu','saved',{timeoutMs:100}),true);
  }
});
