import './fixtures/offline-network.mjs';
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';import {downloadAsset} from '../src/shared/download.mjs';import {browserAdapter} from '../src/shared/browser-adapter.mjs';import {DiagnosticCollector} from '../src/shared/diagnostics.mjs';
let browser;before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url))});});after(async()=>{await browser?.close();});
const ua='SyntheticBrowserUA/156';
async function direct(t,redirect){
 const root=await mkdtemp(path.join(os.tmpdir(),'umh-media-headers-'));t.after(()=>rm(root,{recursive:true,force:true}));const calls=[],diagnostics=new DiagnosticCollector();
 const png=await readFile(new URL('./fixtures/synthetic-blue.png',import.meta.url));
 await downloadAsset({root,item:{platform:'douyin',contentId:'123'},asset:{index:1,kind:'image',extension:'png',url:'https://p3.douyinpic.com/synthetic.png?secret=SECRET_TOKEN'},requestHeaders:{referer:'https://www.douyin.com/','user-agent':ua,authorization:'SECRET_ACCOUNT',cookie:'SECRET_TOKEN'},attempt:2,diagnostics,fetchImpl:async(url,options)=>{
  calls.push({url:String(url),headers:options.headers});return redirect&&calls.length===1?new Response(null,{status:302,headers:{location:redirect}}):new Response(png,{status:200,headers:{'content-type':'image/png'}});
 }});return {calls,diagnostics};
}
test('douyin media request carries referer and browser UA with only allowlisted headers',async t=>{
 const f=await direct(t);assert.equal(f.calls[0].headers.referer,'https://www.douyin.com/');assert.equal(f.calls[0].headers['user-agent'],ua);assert.equal(f.calls[0].headers.authorization,undefined);assert.equal(f.calls[0].headers.cookie,undefined);
 assert.equal(f.diagnostics.snapshot()[0].status,200);assert.equal(f.diagnostics.snapshot()[0].attempt,2);assert.equal(JSON.stringify(f.diagnostics.snapshot()).includes('SECRET'),false);
});
test('douyin redirect to zjcdn keeps referer and records only CDN family',async t=>{const f=await direct(t,'https://v1.zjcdn.com/synthetic-live.mp4?private=SECRET_TOKEN');assert.equal(f.calls[1].headers.referer,'https://www.douyin.com/');assert.equal(f.diagnostics.snapshot()[1].host,'zjcdn.com');assert.equal(JSON.stringify(f.diagnostics.snapshot()).includes('SECRET'),false);});
test('zjcdn diagnostic host rejects deceptive domain suffix',()=>{const d=new DiagnosticCollector();d.add({host:'v1.zjcdn.com',status:200});d.add({host:'zjcdn.com.foreign.invalid',status:403});assert.equal(d.snapshot()[0].host,'zjcdn.com');assert.equal(d.snapshot()[1].host,undefined);});
for(const [target,expected] of [['https://foreign.invalid/file',undefined],['https://douyinpic.com.foreign.invalid/file',undefined],['https://p9.douyinpic.com/file','https://www.douyin.com/'],['http://p9.douyinpic.com/file',undefined]])test(`cross-host redirect referer policy ${target}`,async t=>{const f=await direct(t,target);assert.equal(f.calls.length,2);assert.equal(f.calls[1].headers.referer,expected);assert.equal(f.calls[1].headers['user-agent'],ua);});
test('adapter reads dedicated browser UA once per operation and passes platform referer',async t=>{
 const context=await browser.newContext({userAgent:ua});t.after(()=>context.close());const page=await context.newPage(),evaluate=page.evaluate.bind(page);let uaReads=0;page.evaluate=async(...args)=>{const value=await evaluate(...args);if(value===ua)uaReads++;return value;};const headers=[];
 const adapter=browserAdapter('douyin',{open:async()=>context,download:async input=>{headers.push(input.requestHeaders);return {status:'completed'};}});
 const result=await adapter.download({request:{source:{platform:'douyin',kind:'single',url:'https://www.douyin.com/video/123'},paths:{downloadRoot:'G:/synthetic'},items:[{platform:'douyin',contentId:'123',mediaResolved:true,media:[{index:1,kind:'image',url:'https://p3.douyinpic.com/one'},{index:2,kind:'image',url:'https://p3.douyinpic.com/two'}]}]},signal:new AbortController().signal,emit:async()=>{}});
 assert.equal(result.status,'completed');assert.equal(headers.length,2);for(const h of headers){assert.equal(h?.referer,'https://www.douyin.com/');assert.equal(h?.['user-agent'],ua);}assert.equal(uaReads,1);
});
for(const status of [403,410,401])test(`media status ${status} uses bounded refresh and correct action reason`,async t=>{
 const context=await browser.newContext({userAgent:ua});t.after(()=>context.close());await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<script>window.__INITIAL_STATE__={note:{noteDetailMap:{abc123:{note:{noteId:'abc123',imageList:[{urlDefault:'https://sns.xhscdn.com/new'}]}}}}};</script>`}));const events=[];let attempts=0;
 const adapter=browserAdapter('xiaohongshu',{open:async()=>context,download:async()=>{attempts++;throw Object.assign(new Error('synthetic media status'),{httpStatus:status});}});
 const sourceUrl='https://www.xiaohongshu.com/explore/abc123?xsec_token=synthetic';const result=await adapter.download({request:{source:{platform:'xiaohongshu',kind:'single',url:sourceUrl},paths:{downloadRoot:'G:/synthetic'},items:[{platform:'xiaohongshu',contentId:'abc123',sourceUrl,mediaResolved:true,media:[{index:1,kind:'image',url:'https://sns.xhscdn.com/old'}]}]},signal:new AbortController().signal,emit:async(type,payload)=>events.push({type,...payload})});
 assert.equal(result.reasonCode,status===401?'auth_required':'media_forbidden');assert.equal(result.status,'needs_action');assert.equal(attempts,status===401?1:2);assert.equal(events.filter(e=>e.type==='receipt').length,0);
});
