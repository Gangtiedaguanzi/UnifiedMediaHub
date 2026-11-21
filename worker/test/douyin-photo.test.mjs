import './fixtures/offline-network.mjs';import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {chromium} from 'playwright';
import {resolveSource} from '../src/shared/source-resolution.mjs';import {sourceIdentity,scanPage} from '../src/shared/scanner.mjs';import {normalizeDouyin} from '../src/shared/normalizers.mjs';import {DiagnosticCollector} from '../src/shared/diagnostics.mjs';
let browser;before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url))});});after(async()=>{await browser?.close();});
const work='123456',raw=(live=false)=>({aweme_id:work,aweme_type:68,images:[{url_list:['https://p3.douyinpic.com/one.jpg'],...(live?{video:{play_addr:{url_list:['https://v3.douyinvod.com/live.mp4']}}}:{})},{url_list:['https://p3.douyinpic.com/two.jpg']}]});
async function fixture(t,html,response){const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());await context.route('**/*',r=>r.request().url().includes('/aweme/v1/web/aweme/detail/')?r.fulfill({contentType:'application/json',body:JSON.stringify(response??{status_code:0,aweme_detail:raw(true)})}):r.fulfill({contentType:'text/html; charset=utf-8',body:html}));return context.newPage();}
for(const type of [2,68,150])for(const live of [false,true])test(`photo type ${type}, live=${live} keeps stable indexes`,()=>{const item=normalizeDouyin({...raw(live),aweme_type:type});assert.equal(item.mediaResolved,true);assert.deepEqual(item.media.map(m=>[m.index,m.kind]),live?[[1,'image'],[2,'video'],[3,'image']]:[[1,'image'],[2,'image']]);});
for(const host of ['www.iesdouyin.com','iesdouyin.com'])test(`slides identity and shortlink normalize to note for ${host}`,async t=>{
 const final=`https://${host}/share/slides/${work}/?SECRET_ACCOUNT=SECRET_TOKEN`;assert.equal(sourceIdentity({platform:'douyin',kind:'single',url:final}).work,work);
 const page=await fixture(t,`<script>if(location.hostname==='v.douyin.com')location.replace(${JSON.stringify(final)})</script>`);
 const result=await resolveSource(page,{platform:'douyin',kind:'single',url:'https://v.douyin.com/synthetic/'});assert.equal(result.url,`https://www.douyin.com/note/${work}`);
});
for(const kind of ['replaceState','document'])test(`same work video-to-note ${kind} accepts exact identity after publication gate`,async t=>{
 const page=await fixture(t,`<script>window._ROUTER_DATA=${JSON.stringify(raw(true))}</script>`);let changed=false;const items=[];
 const result=await scanPage(page,{source:{platform:'douyin',kind:'single',url:`https://www.douyin.com/video/${work}`},maxRounds:1,waitMs:1,beforePublish:async()=>{if(!changed){changed=true;if(kind==='replaceState')await page.evaluate(id=>history.replaceState({},'',`/note/${id}`),work);else await page.goto(`https://www.douyin.com/note/${work}`,{waitUntil:'domcontentloaded'});}},emit:async(type,p)=>{if(type==='item')items.push(p.item);}});
 assert.equal(result.status,'completed');assert.equal(items.length,1);assert.equal(items[0].contentId,work);
});
test('a different work after navigation cannot publish old detail',async t=>{
 const page=await fixture(t,`<script>window._ROUTER_DATA=${JSON.stringify(raw())}</script>`);const items=[];
 const result=await scanPage(page,{source:{platform:'douyin',kind:'single',url:`https://www.douyin.com/video/${work}`},maxRounds:1,waitMs:1,beforePublish:()=>page.goto('https://www.douyin.com/note/999999',{waitUntil:'domcontentloaded'}),emit:async(type,p)=>{if(type==='item')items.push(p.item);}});assert.equal(items.length,0);assert.equal(result.status,'needs_action');
});
test('unresolved single includes sanitized JSON shape and final path diagnostics',async t=>{
 const body={status_code:0,aweme_detail:{...raw(true),aweme_id:'999999',desc:'SECRET_TITLE',author:{sec_uid:'SECRET_ACCOUNT'}},cookie:'SECRET_TOKEN'};
 const page=await fixture(t,`<script>fetch('/aweme/v1/web/aweme/detail/?aweme_id=SECRET_ACCOUNT&cookie=SECRET_TOKEN')</script>`,body),diagnostics=new DiagnosticCollector();
 const result=await scanPage(page,{source:{platform:'douyin',kind:'single',url:`https://www.douyin.com/note/${work}`},maxRounds:2,waitMs:10,diagnostics,emit:async()=>{}});assert.equal(result.reasonCode,'work_unresolved');
 const entries=diagnostics.snapshot();const shape=entries.find(e=>e.hasAwemeDetail===true);assert.ok(shape);assert.equal(shape.path,'/aweme/v1/web/aweme/detail/');assert.equal(shape.status,200);assert.equal(shape.awemeType,68);assert.equal(shape.imageCount,2);assert.equal(shape.hasLiveVideo,true);assert.ok(entries.some(e=>e.unresolved&&e.finalPath==='/note/:id'));
 const text=JSON.stringify(entries);for(const secret of ['?','cookie','SECRET_'])assert.equal(text.includes(secret),false);
});
test('no detail request is distinguishable from a returned empty detail',async t=>{const page=await fixture(t,'<body>synthetic</body>'),diagnostics=new DiagnosticCollector();await scanPage(page,{source:{platform:'douyin',kind:'single',url:`https://www.douyin.com/note/${work}`},maxRounds:1,waitMs:1,diagnostics,emit:async()=>{}});const entries=diagnostics.snapshot();assert.equal(entries.some(e=>e.jsonObserved),false);assert.equal(entries.some(e=>e.unresolved),true);});
