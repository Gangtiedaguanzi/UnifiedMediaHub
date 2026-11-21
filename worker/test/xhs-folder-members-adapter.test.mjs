import './fixtures/offline-network.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';

let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url)),args:['--disable-background-networking','--no-first-run','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});});
after(async()=>{await browser?.close();});
const source={platform:'xiaohongshu',kind:'saved_folder',accountId:'synthetic-owner',folderId:'synthetic-board',url:'https://www.xiaohongshu.com/user/profile/synthetic-owner?tab=fav',maxItems:2};

test('XHS adapter routes an explicit folder through verified board members and closes the browser',async t=>{
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());
 const paths=[];
 await context.route('**/*',route=>{
  const path=new URL(route.request().url()).pathname;paths.push(path);
  const state=path==='/board/synthetic-board'
   ?{board:{boardFeedsMap:{_rawValue:{'synthetic-board':{notes:[{noteId:'synthetic-note-1',displayTitle:'Synthetic',xsecToken:'synthetic-token-1'},{noteId:'synthetic-note-2',displayTitle:'Synthetic 2',xsecToken:'synthetic-token-2'},{noteId:'synthetic-note-3',displayTitle:'Not requested'}]}}}}}
   :{board:{userBoardList:{_rawValue:[{id:'synthetic-board',name:'Synthetic board',total:3}]}}};
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<body><div class="xhs-user-page-primary-tabs"><div class="reds-tab-item">笔记</div><div class="reds-tab-item active">收藏</div></div><script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script></body>`});
 });
 let identities=0,closed=false;context.on('close',()=>{closed=true;});const events=[];
 const adapter=browserAdapter('xiaohongshu',{open:async()=>context,identity:async()=>{identities++;return {accountId:source.accountId};}});
 const result=await adapter.scan({request:{source},signal:new AbortController().signal,emit:async(type,p)=>events.push({type,...p})});
 assert.equal(result.status,'completed');assert.equal(result.completeness,'partial');
 assert.equal(events.filter(e=>e.type==='account').length,1);assert.ok(identities>=2);
 const items=events.filter(e=>e.type==='item').map(e=>e.item);assert.equal(items.length,2);
 assert.deepEqual(items.map(x=>x.contentId),['synthetic-note-1','synthetic-note-2']);
 assert.equal(new URL(items[0].sourceUrl).searchParams.get('xsec_token'),'synthetic-token-1');
 assert.ok(items.every(x=>!x.mediaResolved&&x.media.length===0));
 assert.equal(events.some(e=>e.type==='folder'||e.type==='receipt'),false);
 assert.equal(paths.filter(x=>x.startsWith('/board/')).length,1);assert.equal(paths.some(x=>x.startsWith('/explore/')),false);assert.equal(closed,true);
});

test('unsupported folder member platform and directory scan remain explicit refusals without browser launch',async()=>{
 let opened=0;const events=[];
 for(const [platform,kind] of [['douyin','saved_folder'],['xiaohongshu','saved_folders']]){
  const adapter=browserAdapter(platform,{open:async()=>{opened++;throw Error('must not open');}});
  const result=await adapter.scan({request:{source:{...source,platform,kind}},signal:new AbortController().signal,emit:async(type,p)=>events.push({type,...p})});
  assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'folder_members_unavailable');
 }
 assert.equal(opened,0);assert.equal(events.some(e=>e.type==='item'),false);
});
