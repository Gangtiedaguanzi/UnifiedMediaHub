import './fixtures/offline-network.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {tabSnapshot} from '../src/shared/browser.mjs';
const api=await import('../src/shared/xhs-folder-members.mjs').catch(()=>({}));
const source={platform:'xiaohongshu',kind:'saved_folder',accountId:'fixture-owner',folderId:'board_one',maxItems:2,url:'https://www.xiaohongshu.com/user/profile/fixture-owner?tab=fav'};
const notes=[{noteId:'note_one',displayTitle:'Synthetic',xsecToken:'synthetic-token'},{id:'note_two',title:'Synthetic 2',xsec_token:'token-two'},{id:'note_three'}];
const invalidCovers=[undefined,null,'unknown',123,[],{}, {url:''},{url:'/relative-cover'},{url:'not a URL'},{url:'javascript:synthetic'},{url:'https://user:password@synthetic.invalid/cover'},{url:'https://synthetic.invalid/'+ 'x'.repeat(4096)},{url:{unknown:'shape'}}];
test('optional covers omit invalid candidates while preserving verified note metadata',()=>{
 for(const cover of invalidCovers){const [item]=api.parseXhsBoardMembers({notes:[{...notes[0],cover}]});assert.equal(item.contentId,'note_one');assert.equal(item.thumbnailUrl,null);assert.equal(new URL(item.sourceUrl).searchParams.get('xsec_token'),'synthetic-token');assert.deepEqual(item.media,[]);assert.equal(item.mediaResolved,false);}
});
test('optional covers use a valid known-field fallback without later invalid fields rejecting it',()=>{
 for(const cover of [{urlDefault:'',url:'https://synthetic.invalid/cover',urlPre:'bad'},{urlDefault:123,url:'/relative',urlPre:'http://synthetic.invalid/cover'},{urlDefault:'https://synthetic.invalid/cover',url:{unknown:true}}]){
  const [item]=api.parseXhsBoardMembers({notes:[{...notes[0],cover}]});assert.ok(['https://synthetic.invalid/cover','http://synthetic.invalid/cover'].includes(item.thumbnailUrl));assert.deepEqual(item.media,[]);
 }
});
test('board parser preserves bounded tokens and returns canonical unresolved metadata only',()=>{
 const items=api.parseXhsBoardMembers({notes});
 assert.equal(items.length,3);assert.equal(items[0].contentId,'note_one');
 assert.equal(new URL(items[0].sourceUrl).searchParams.get('xsec_token'),'synthetic-token');
 assert.equal(new URL(items[1].sourceUrl).searchParams.get('xsec_token'),'token-two');
 assert.ok(items.every(i=>i.platform==='xiaohongshu'&&!i.mediaResolved&&i.media.length===0));
 assert.equal(new URL(items[0].sourceUrl).origin,'https://www.xiaohongshu.com');
});
test('board parser refuses ambiguous aliases, traversal IDs and unknown/oversized shapes',()=>{
 for(const raw of [{},[],{notes:{}},{notes:Array(1001).fill(notes[0])},...[
  {noteId:'../escape'},{noteId:'a',id:'b'},{noteId:'a',xsecToken:'a',xsec_token:'b'},
  {noteId:'a',xsecToken:'x'.repeat(4096)},{noteId:'a',xsecToken:123},{noteId:'a',title:{secret:'not scalar'}},
 ].map(n=>({notes:[n]}))])assert.throws(()=>api.parseXhsBoardMembers(raw));
});
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url)),args:['--disable-background-networking','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});});
after(async()=>{await browser?.close();});
async function fixture(t,{folders=[{id:'board_one',name:'Same'},{id:'board_two',name:'Same'}],entry={notes},wrongKey=false,wrongRoute=false}={}){
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());const requests=[];
 await context.route('**/*',r=>{
  const u=new URL(r.request().url());requests.push(u.pathname+u.search);
  if(u.pathname.startsWith('/user/profile/'))return r.fulfill({contentType:'text/html; charset=utf-8',body:`<body><div class="xhs-user-page-primary-tabs"><div class="reds-tab-item">笔记</div><div class="reds-tab-item active">收藏</div></div><script>window.__INITIAL_STATE__={board:{userBoardList:{_rawValue:${JSON.stringify(folders)}}}};</script></body>`});
  if(u.pathname==='/board/board_one')return r.fulfill({contentType:'text/html; charset=utf-8',body:`<body><script>window.__INITIAL_STATE__={board:{boardFeedsMap:{_rawValue:${JSON.stringify({[wrongKey?'another':'board_one']:entry,other_board:{notes:[{id:'never-read-other-board'}]}})}}}};${wrongRoute?"history.replaceState({},'','/board/another?source=web_user_page');":''}</script></body>`});
  return r.abort();
 });
 return {page:await context.newPage(),requests};
}
async function run(page,options={}){
 const events=[];let checks=0;
 const result=await api.scanXhsFolderMembers(page,{source,emit:async(type,p)=>events.push({type,...p}),verifyAccount:async()=>{checks++;return {accountId:source.accountId};},hydrationMs:25,...options});
 return {events,result,checks};
}
test('own directory first then exact chosen board, capped at two with no details or media requests',async t=>{
 const f=await fixture(t);const out=await run(f.page);
 assert.equal(out.result.status,'completed');assert.equal(out.result.completeness,'partial');assert.equal(out.result.reasonCode,'item_limit');assert.equal(out.checks,3);
 assert.deepEqual(f.requests,['/user/profile/fixture-owner?tab=fav&subTab=board','/board/board_one?source=web_user_page']);
 assert.equal(out.events.filter(e=>e.type==='account').length,1);assert.equal(out.events.some(e=>e.type==='folder'||e.type==='receipt'),false);
 assert.deepEqual(out.events.filter(e=>e.type==='item').map(e=>e.item.contentId),['note_one','note_two']);
});
for(const mode of ['same-url-replace','same-url-reload','away-and-back'])test(`hydration navigation ${mode} preserves only the same document and source`,async t=>{
 const f=await fixture(t,{wrongKey:true}),evaluate=f.page.evaluate.bind(f.page);let hydrated=false,before,after;const navigations=[];
 f.page.on('framenavigated',frame=>{if(hydrated&&frame===f.page.mainFrame())navigations.push(frame.url());});
 f.page.evaluate=async(...args)=>{
  const raw=await evaluate(...args);
  if(!hydrated&&args[0]?.name==='boardProjection'&&args[1]===source.folderId&&raw===null){
   before=await tabSnapshot(f.page,'xiaohongshu','saved');hydrated=true;
   if(mode==='same-url-reload')await f.page.reload({waitUntil:'domcontentloaded'});
   await evaluate(({mode,notes})=>{
    if(mode==='same-url-replace')history.replaceState({hydrated:true},'',location.href);
    if(mode==='away-and-back'){const original=location.href;history.replaceState({},'','/board/another?source=web_user_page');history.replaceState({},'',original);}
    window.__INITIAL_STATE__.board.boardFeedsMap._rawValue.board_one={notes};
   },{mode,notes});
   after=await tabSnapshot(f.page,'xiaohongshu','saved');
  }
  return raw;
 };
 const out=await run(f.page,{hydrationMs:1000});
 assert.equal(hydrated,true);assert.equal(before.url,after.url);
 assert.ok(navigations.length>=(mode==='away-and-back'?2:1),'fixture must observe actual Chromium navigation events');
 assert.equal(before.documentId===after.documentId,mode!=='same-url-reload');
 if(mode==='same-url-replace'){
  assert.equal(out.result.status,'completed');assert.equal(out.result.reasonCode,'item_limit');
  assert.deepEqual(out.events.filter(e=>e.type==='item').map(e=>e.item.contentId),['note_one','note_two']);
 }else{
  assert.equal(out.result.reasonCode,'folder_unverified');assert.equal(out.result.status,'needs_action');assert.equal(out.events.some(e=>e.type==='item'),false);
 }
});
test('optional covers survive the real board projection without losing notes or requesting media',async t=>{
 const boardNotes=[...invalidCovers.map((cover,i)=>({noteId:`cover_${i}`,cover})),{noteId:'valid_fallback',cover:{urlDefault:123,url:'https://synthetic.invalid/cover',urlPre:'not a URL'}}];
 const f=await fixture(t,{entry:{notes:boardNotes}});const out=await run(f.page,{source:{...source,maxItems:50}});
 assert.equal(out.result.status,'completed');assert.equal(out.result.completeness,'partial');
 const items=out.events.filter(e=>e.type==='item').map(e=>e.item);assert.deepEqual(items.map(i=>i.contentId),boardNotes.map(n=>n.noteId));
 assert.ok(items.slice(0,-1).every(i=>i.thumbnailUrl===null));assert.equal(items.at(-1).thumbnailUrl,'https://synthetic.invalid/cover');assert.ok(items.every(i=>i.mediaResolved===false&&i.media.length===0));
 assert.deepEqual(f.requests,['/user/profile/fixture-owner?tab=fav&subTab=board','/board/board_one?source=web_user_page']);
});
for(const [name,config] of [['missing chosen folder',{folders:[{id:'board_two',name:'Same'}]}],['wrong state key',{wrongKey:true}],['wrong board route',{wrongRoute:true}],['unknown entry',{entry:{}}],['invalid author',{entry:{notes:[{id:'a',user:123}]}}]])test(`members refuse ${name} without fallback`,async t=>{
 const f=await fixture(t,config);const out=await run(f.page);assert.equal(out.result.status,'needs_action');assert.equal(out.events.some(e=>e.type==='item'),false);if(name==='missing chosen folder')assert.equal(f.requests.length,1);
});
test('board source change after first delivery stops subsequent items',async t=>{
 const f=await fixture(t);const items=[];
 const out=await run(f.page,{emit:async(type,p)=>{if(type==='item'){items.push(p.item);await f.page.evaluate(()=>history.replaceState({},'','/board/another'));}}});
 assert.equal(items.length,1);assert.equal(out.result.status,'needs_action');
});
test('a late board state evaluation after cancellation cannot publish',async t=>{
 const f=await fixture(t),controller=new AbortController(),entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());const evaluate=f.page.evaluate.bind(f.page),events=[];
 f.page.evaluate=async(...args)=>{const result=await evaluate(...args);if(args[1]==='board_one'){entered.resolve();await release.promise;}return result;};
 const running=api.scanXhsFolderMembers(f.page,{source,signal:controller.signal,emit:async(type,p)=>events.push({type,...p}),verifyAccount:async()=>({accountId:source.accountId})});
 void running.catch(()=>{});await entered.promise;const reason=new Error('late state stop');controller.abort(reason);await assert.rejects(running,e=>e===reason);release.resolve();await new Promise(setImmediate);assert.equal(events.some(e=>e.type==='item'),false);assert.equal(f.page.isClosed(),true);
});
test('folder outside first fifty is unverified rather than retried or expanded',async t=>{
 const f=await fixture(t,{folders:[...Array.from({length:50},(_,i)=>({id:`other${i}`,name:'Other'})),{id:'board_one',name:'Same'}]});
 const out=await run(f.page);assert.equal(out.result.reasonCode,'folder_unverified');assert.equal(out.events.some(e=>e.type==='item'),false);assert.equal(f.requests.length,1);
});
for(const mode of ['account','route','reload','state'])test(`final ${mode} change cannot publish stale board members`,async t=>{
 const f=await fixture(t);let checks=0;
 const out=await run(f.page,{verifyAccount:async()=>{
  if(++checks===3){
   if(mode==='route')await f.page.evaluate(()=>history.replaceState({},'','/board/another'));
   if(mode==='reload')await f.page.reload();
   if(mode==='state')await f.page.evaluate(()=>window.__INITIAL_STATE__.board.boardFeedsMap._rawValue.board_one.notes[0].noteId='changed');
  }
  return {accountId:checks===3&&mode==='account'?'another':source.accountId};
 }});
 assert.equal(out.result.status,'needs_action');assert.equal(out.events.some(e=>e.type==='item'),false);
});
test('cancellation during final proof closes page and retires late member output',async t=>{
 const f=await fixture(t),controller=new AbortController(),entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());let checks=0;const events=[];
 const running=api.scanXhsFolderMembers(f.page,{source,signal:controller.signal,emit:async(type,p)=>events.push({type,...p}),verifyAccount:async()=>{if(++checks===3){entered.resolve();await release.promise;}return {accountId:source.accountId};}});
 void running.catch(()=>{});await entered.promise;const reason=new Error('synthetic stop');controller.abort(reason);await assert.rejects(running,e=>e===reason);release.resolve();await new Promise(setImmediate);assert.equal(f.page.isClosed(),true);assert.equal(events.some(e=>e.type==='item'),false);
});
