import './fixtures/offline-network.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installSourceObserver, tabSnapshot, readListDom, readDetail } from '../src/shared/browser.mjs';
import { scanPage } from '../src/shared/scanner.mjs';
import { normalizeXhs } from '../src/shared/normalizers.mjs';
import { browserAdapter } from '../src/shared/browser-adapter.mjs';

// Synthetic fixtures only: every browser request is fulfilled locally.
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url))});});
after(async()=>{await browser?.close();});
const source={platform:'xiaohongshu',kind:'saved',url:'https://www.xiaohongshu.com/user/profile/owner?tab=fav',accountId:'owner',maxItems:2};
const tabs='<div class="xhs-user-page-primary-tabs"><div class="reds-tab-item">笔记</div><div class="reds-tab-item active">收藏</div></div>';
const endpoint='https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?user_id=owner&cursor=later';
const card=(id,href=`/explore/${id}?xsec_token=synthetic-${id}`)=>`<section class="note-item"><a href="${href}">${id}</a></section>`;
const state=ids=>ids.map(note_id=>({note_id}));
const html=(cards=card('A')+card('B'),groups=[[],state(['A','B']),[],[]])=>`${tabs}<div class="feeds-container"></div><div class="feeds-container" id="initial">${cards}</div><div class="feeds-container"></div><div class="feeds-container"></div><script>window.__INITIAL_STATE__={user:{notes:${JSON.stringify(groups)}}};</script>`;
const continuation={code:0,success:true,data:{notes:['C','D'].map(note_id=>({note_id,xsec_token:'synthetic'})),has_more:false,cursor:'end'}};
async function fixture(t,body,respond=()=>continuation){
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('**/*',async route=>{
    if(new URL(route.request().url()).hostname==='edith.xiaohongshu.com')await route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(await respond(route.request()))}).catch(()=>{});
    else await route.fulfill({contentType:'text/html; charset=utf-8',body}).catch(()=>{});
  });
  return context.newPage();
}
async function read(page,options={}){
  await installSourceObserver(page,'xiaohongshu','saved');
  const expectedSnapshot=await tabSnapshot(page,'xiaohongshu','saved');
  return readListDom(page,'xiaohongshu',{kind:'saved',subject:'owner',accountId:'owner',expectedSnapshot,...options});
}
async function scan(page,options={}){
  const events=[];
  const result=await scanPage(page,{source,emit:async(type,p)=>events.push({type,...p}),maxRounds:1,waitMs:1,...options});
  return {result,items:events.filter(e=>e.type==='item').map(e=>e.item),events};
}

test('zero-tabpanel saved DOM correlates ordered membership independent of feed/group position',async t=>{
  const page=await fixture(t,html());await page.goto(source.url);
  const first=await read(page);
  assert.deepEqual(first.items.map(x=>x.note_id),['A','B']);assert.equal(first.partialOnly,true);assert.equal(first.scopeStatus,'ready');
  await page.evaluate(()=>{const feed=document.querySelector('#initial');document.body.append(feed);window.__INITIAL_STATE__.user.notes={_value:[{_value:[{id:'A'},{note_card:{noteId:'B'}}]},[],[]]};});
  assert.deepEqual((await read(page)).items.map(x=>x.note_id),['A','B']);
});

test('delayed rendered initial A/B publish before early continuation C/D at max2',async t=>{
  const page=await fixture(t,html()+`<script>document.querySelector('#initial').style.display='none';fetch(${JSON.stringify(endpoint)});setTimeout(()=>document.querySelector('#initial').style.display='',180);</script>`);
  const {items,result}=await scan(page);
  assert.deepEqual(items.map(x=>x.contentId),['A','B']);assert.equal(result.completeness,'partial');assert.equal(result.reasonCode,'item_limit');
});

test('rendering and correlation failures never choose a plausible feed or group',async t=>{
  const cases=[
    ['hidden ancestor',()=>{const feed=document.querySelector('#initial'),wrapper=document.createElement('div');feed.replaceWith(wrapper);wrapper.append(feed);wrapper.style.visibility='hidden';},'not_ready'],
    ['opacity zero',()=>document.querySelector('#initial').style.opacity='0','not_ready'],
    ['aria hidden',()=>document.querySelector('#initial').setAttribute('aria-hidden','true'),'not_ready'],
    ['hidden card',()=>document.querySelector('.note-item').hidden=true,'not_ready'],
    ['two populated feeds',()=>document.querySelector('.feeds-container').innerHTML=document.querySelector('#initial').innerHTML,'refused'],
    ['nested populated feed',()=>{const outer=document.createElement('div');outer.className='feeds-container';document.querySelector('#initial').replaceWith(outer);outer.innerHTML='<div class="feeds-container"><section class="note-item"><a href="/explore/A?xsec_token=a">A</a></section></div>';},'refused'],
    ['two matching groups',()=>window.__INITIAL_STATE__.user.notes.push([{note_id:'A'},{note_id:'B'}]),'refused'],
    ['order mismatch',()=>window.__INITIAL_STATE__.user.notes[1].reverse(),'refused'],
    ['invalid group id',()=>window.__INITIAL_STATE__.user.notes[1][0]={note_id:'A',id:'other'},'refused'],
    ['missing state',()=>delete window.__INITIAL_STATE__,'not_ready'],
    ['unsupported nested wrapper',()=>window.__INITIAL_STATE__.user.notes={_value:{_value:[]}},'refused'],
  ];
  for(const [name,mutate,status] of cases){
    const page=await fixture(t,html());await page.goto(source.url);await page.evaluate(mutate);
    const actual=await read(page);assert.deepEqual(actual.items,[],name);assert.equal(actual.scopeStatus,status,name);assert.equal(actual.partialOnly,true,name);
  }
  const page=await fixture(t,html());await page.goto(source.url);
  await page.evaluate(()=>document.querySelector('#initial').style.marginTop='5000px');
  assert.deepEqual((await read(page)).items.map(x=>x.note_id),['A','B']);
});

test('strict same-card URLs and observed tokens cannot invent actionable sources',async t=>{
  const bad=[
    '/explore/A', '/explore/A?xsec_token=', '/explore/A?xsec_token=%20',
    '/explore/A?xsec_token=a&xsec_token=a','/explore/A?xsec_token=a&xsec_token=b',
    `/explore/A?xsec_token=${'x'.repeat(4096)}`, 'http://www.xiaohongshu.com/explore/A?xsec_token=a',
    'https://evil.example/explore/A?xsec_token=a','https://name@www.xiaohongshu.com/explore/A?xsec_token=a',
    'https://www.xiaohongshu.com:444/explore/A?xsec_token=a','/explore/A/extra?xsec_token=a',
  ];
  for(const href of bad){
    const page=await fixture(t,html(card('A',href),[state(['A'])]));await page.goto(source.url);
    assert.deepEqual((await read(page)).items,[],href.slice(0,100));
  }
  for(const links of [card('A').replace('</section>','<a href="/explore/other?xsec_token=b">other</a></section>'),card('A')+card('A','/explore/A?xsec_token=different')]){
    const page=await fixture(t,html(links,[state(['A'])]));await page.goto(source.url);assert.deepEqual((await read(page)).items,[]);
  }
});

test('duplicates retain first DOM order and signed duplicate can supply its observed token',async t=>{
  const cards=card('B','/explore/B')+card('A').replace('</section>','<a href="/explore/A?xsec_token=synthetic-A">repeat</a></section>')+card('B')+card('A');
  const page=await fixture(t,html(cards,[state(['B','A','B'])]));await page.goto(source.url);
  const dom=await read(page);assert.deepEqual(dom.items.map(x=>x.note_id),['B','A']);
  const item=normalizeXhs(dom.items[0],false);assert.equal(item.mediaResolved,false);assert.equal(new URL(item.sourceUrl).searchParams.get('xsec_token'),'synthetic-B');
  await page.evaluate(()=>window.__INITIAL_STATE__.note={noteDetailMap:{B:{note:{note_id:'B',title:'resolved fixture',imageList:[{urlDefault:'https://sns-webpic-qc.xhscdn.com/synthetic.jpg'}]}}}});
  assert.equal((await readDetail(page,'xiaohongshu','B')).note_id,'B');
  assert.equal(await readDetail(page,'xiaohongshu','A'),null);
});

test('observed DOM token reaches the existing same-ID detail resolver',async t=>{
  const page=await fixture(t,html());await page.goto(source.url);
  const item=normalizeXhs((await read(page)).items[0],false);
  assert.equal(item.mediaResolved,false);
  let detailRequest,transfers=0;const events=[];
  await page.context().route('**/explore/A?*',async route=>{
    detailRequest=new URL(route.request().url());
    await route.fulfill({contentType:'text/html; charset=utf-8',body:'<body><script>window.__INITIAL_STATE__={note:{noteDetailMap:{A:{note:{note_id:"A",imageList:[{urlDefault:"https://sns-webpic-qc.xhscdn.com/synthetic.jpg"}]}}}}};</script>'});
  });
  const result=await browserAdapter('xiaohongshu',{open:async()=>page.context(),download:async({item:resolved})=>{
    transfers++;assert.equal(resolved.contentId,'A');assert.equal(resolved.mediaResolved,true);
    return {status:'fixture_only'};
  }}).download({request:{source:{platform:'xiaohongshu',kind:'single',url:item.sourceUrl},items:[item],paths:{}},signal:new AbortController().signal,emit:async(type,p)=>events.push({type,...p})});
  assert.equal(detailRequest.searchParams.get('xsec_token'),'synthetic-A');assert.equal(transfers,1);assert.equal(result.status,'completed');
  assert.equal(events.find(e=>e.type==='item')?.item.contentId,'A');
});

test('feed, state, card, anchor and ancestor caps refuse complete membership validation',async t=>{
  const changes=[
    ()=>{for(let i=0;i<13;i++)document.body.insertAdjacentHTML('beforeend','<div class="feeds-container"></div>');},
    ()=>{window.__INITIAL_STATE__.user.notes=Array.from({length:17},()=>[]);},
    ()=>{window.__INITIAL_STATE__.user.notes=[Array.from({length:1001},()=>({note_id:'A'}))];},
    ()=>{document.querySelector('#initial').innerHTML=Array.from({length:1001},()=>'<section class="note-item"></section>').join('');},
    ()=>{document.querySelector('.note-item').insertAdjacentHTML('beforeend','<a href="/unrelated">x</a>'.repeat(1000));},
    ()=>{const feed=document.querySelector('#initial');for(let i=0;i<65;i++){const wrapper=document.createElement('div');feed.replaceWith(wrapper);wrapper.append(feed);}},
  ];
  for(const change of changes){const page=await fixture(t,html());await page.goto(source.url);await page.evaluate(change);const dom=await read(page);assert.deepEqual(dom.items,[]);assert.equal(dom.truncated,true);assert.equal(dom.scopeStatus,'refused');}
});

test('modern saved source requires own exact route, selected semantic tab and original snapshot',async t=>{
  const routes=[source.url+'&tab=fav',source.url+'&subTab=note&subTab=note',source.url+'&subTab=video',source.url.replace('/owner?','/other?'),source.url.replace('/owner?','/owner/work?')];
  for(const url of routes){const page=await fixture(t,html());await page.goto(url);assert.deepEqual((await read(page)).items,[]);}
  const page=await fixture(t,html());await page.goto(source.url);
  assert.deepEqual((await read(page,{accountId:'other'})).items,[]);
  await installSourceObserver(page,'xiaohongshu','saved');const expectedSnapshot=await tabSnapshot(page,'xiaohongshu','saved');
  await page.evaluate(()=>{const selected=document.querySelector('.active');selected.className='reds-tab-item';selected.className='reds-tab-item active';});
  assert.deepEqual((await read(page,{expectedSnapshot})).items,[]);
  await page.evaluate(()=>document.querySelector('.active').className='reds-tab-item');
  assert.deepEqual((await read(page)).items,[]);
});

test('later terminal API cannot elevate correlated modern DOM to complete',async t=>{
  const page=await fixture(t,html()+`<script>fetch(${JSON.stringify(endpoint.replace('cursor=later','cursor='))});</script>`);
  const {items,result}=await scan(page,{source:{...source,maxItems:0}});
  assert.deepEqual(items.map(x=>x.contentId),['A','B','C','D']);assert.equal(result.completeness,'partial');assert.equal(result.reasonCode,'history_unproven');
});

test('missing initial tokens and hydration expiry release held API work as partial',async t=>{
  for(const body of [html(card('A','/explore/A')+card('B','/explore/B')),html().replace('id="initial"','id="initial" hidden')]){
    const page=await fixture(t,body+`<script>fetch(${JSON.stringify(endpoint)});</script>`);
    const {items,result}=await scan(page);
    assert.deepEqual(items.map(x=>x.contentId),['C','D']);assert.equal(result.completeness,'partial');
  }
});

test('slow continuation after preparation follows initial DOM without duplicate budget consumption',async t=>{
  const page=await fixture(t,html()+`<script>fetch(${JSON.stringify(endpoint)});</script>`,async()=>{await new Promise(r=>setTimeout(r,250));return {...continuation,data:{...continuation.data,notes:[{note_id:'A',xsec_token:'synthetic-A'},...continuation.data.notes]}};});
  const {items,result}=await scan(page,{source:{...source,maxItems:3},maxRounds:8,waitMs:50});
  assert.deepEqual(items.map(x=>x.contentId),['A','B','C']);assert.equal(result.reasonCode,'item_limit');
});

test('cancellation during hydration retires prepared API work with no late publication',async t=>{
  const page=await fixture(t,html().replace('id="initial"','id="initial" hidden')+`<script>fetch(${JSON.stringify(endpoint)});</script>`);
  const controller=new AbortController(),events=[];
  const running=scanPage(page,{source,signal:controller.signal,emit:async type=>events.push(type),maxRounds:1,waitMs:1});
  const observed=running.catch(e=>e);await page.waitForURL(source.url);await new Promise(r=>setTimeout(r,100));controller.abort(new Error('fixture stop'));
  assert.match((await observed).message,/fixture stop/);await new Promise(r=>setTimeout(r,80));assert.equal(events.includes('item'),false);
});

test('prepared continuation responses retain the eight-pending budget during hydration',async t=>{
  const urls=Array.from({length:12},(_,i)=>endpoint.replace('cursor=later',`cursor=next${i}`));
  const page=await fixture(t,html().replace('id="initial"','id="initial" hidden')+`<script>Promise.all(${JSON.stringify(urls)}.map(u=>fetch(u))).then(()=>setTimeout(()=>document.querySelector('#initial').hidden=false,80));</script>`,request=>{
    const cid=new URL(request.url()).searchParams.get('cursor');
    return {...continuation,data:{...continuation.data,notes:[{note_id:cid,xsec_token:'synthetic'}]}};
  });
  const {items,result}=await scan(page,{source:{...source,maxItems:0}});
  assert.deepEqual(items.slice(0,2).map(x=>x.contentId),['A','B']);assert.equal(items.length,10);assert.equal(result.completeness,'partial');
});

for(const change of ['tab','document','account'])test(`initial DOM publication refuses stale ${change} lease and held continuation`,async t=>{
  const page=await fixture(t,html()+`<script>fetch(${JSON.stringify(endpoint)});</script>`);
  const {items,result}=await scan(page,{beforePublish:async()=>{
    if(change==='tab')await page.evaluate(()=>{const selected=document.querySelector('.active');selected.className='reds-tab-item';selected.className='reds-tab-item active';});
    else if(change==='document'){await page.route('**/user/profile/owner?*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:tabs}));await page.reload({waitUntil:'domcontentloaded'});}
    else throw Object.assign(new Error('account changed'),{code:'auth_required'});
  }});
  assert.deepEqual(items,[]);assert.notEqual(result.completeness,'complete');
  if(change==='account')assert.equal(result.reasonCode,'auth_required');
});

// Run the real browser read, then delay its delivery across actual same-document
// navigations. Final URL/document/tab all agree; only scanner generation retires it.
for(const phase of ['initial window','ordinary loop'])test(`DOM result transit preserves original navigation lease: ${phase}`,async t=>{
  const ordinary=phase==='ordinary loop';
  const page=await fixture(t,html(card('A'),ordinary?[]:[state(['A'])]));
  const evaluate=page.evaluate.bind(page);let domReads=0,changed=false;
  page.evaluate=async(...args)=>{
    const value=await evaluate(...args);
    if(value?.partialOnly&&Array.isArray(value.items)){
      domReads++;
      if(ordinary&&domReads===1){
        assert.equal(value.scopeStatus,'refused');
        await evaluate(()=>window.__INITIAL_STATE__.user.notes=[[{note_id:'A'}]]);
      }else if(!changed&&value.items.length){
        changed=true;
        await Promise.all([page.waitForEvent('framenavigated'),evaluate(()=>history.pushState(null,'','/user/profile/other?tab=fav'))]);
        await Promise.all([page.waitForEvent('framenavigated'),evaluate(url=>{document.querySelector('#initial').remove();window.__INITIAL_STATE__.user.notes=[];history.pushState(null,'',url);},source.url)]);
      }
    }
    return value;
  };
  const {items,result}=await scan(page,{source:{...source,maxItems:1}});
  assert.equal(changed,true);assert.ok(domReads>=(ordinary?2:1));
  assert.deepEqual(items,[]);assert.notEqual(result.reasonCode,'item_limit');assert.equal(result.completeness,'partial');
});

for(const phase of ['initial window','ordinary loop'])test(`snapshot result transit cannot acquire a new navigation generation: ${phase}`,async t=>{
  const ordinary=phase==='ordinary loop';
  const page=await fixture(t,html(card('A'),ordinary?[]:[state(['A'])]));
  const evaluate=page.evaluate.bind(page);let ownSnapshots=0,changed=false,firstDom=true;
  page.evaluate=async(...args)=>{
    const value=await evaluate(...args);
    if(value?.documentId&&value.selected&&value.url===source.url){
      ownSnapshots++;
      // The own-page initial snapshot is first; the attempt snapshot is second.
      // Ordinary mode first performs a refused initial DOM read (+fresh snapshot).
      if(ownSnapshots===(ordinary?4:2)){
        changed=true;
        await Promise.all([page.waitForEvent('framenavigated'),evaluate(()=>history.pushState(null,'','/user/profile/other?tab=fav'))]);
        await Promise.all([page.waitForEvent('framenavigated'),evaluate(()=>{history.pushState(null,'','/user/profile/owner?tab=fav');document.querySelector('#initial').dataset.afterNavigation='true';})]);
      }
    }
    if(ordinary&&firstDom&&value?.partialOnly&&Array.isArray(value.items)){
      firstDom=false;assert.equal(value.scopeStatus,'refused');
      await evaluate(()=>window.__INITIAL_STATE__.user.notes=[[{note_id:'A'}]]);
    }
    return value;
  };
  const {items,result}=await scan(page,{source:{...source,maxItems:1},maxRounds:ordinary?1:0});
  assert.equal(changed,true);assert.deepEqual(items,[]);assert.notEqual(result.reasonCode,'item_limit');assert.notEqual(result.completeness,'complete');
});
