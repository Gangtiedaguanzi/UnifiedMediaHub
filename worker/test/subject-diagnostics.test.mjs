import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {chromium} from 'playwright';
import {scanPage} from '../src/shared/scanner.mjs';import {tabSnapshot} from '../src/shared/browser.mjs';import {DiagnosticCollector,diagnosticEntry} from '../src/shared/diagnostics.mjs';
let browser;before(async()=>{browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url))});});after(async()=>browser?.close());
const subject='SECRET_MixedCase_-Subject',source={platform:'douyin',kind:'liked',url:`https://www.douyin.com/user/${subject}`,accountId:subject};
const markup='<body><div role="tablist"><button role="tab" aria-selected="false">作品</button><button role="tab" aria-selected="true">喜欢</button><button role="tab" aria-selected="false">收藏</button></div><div role="tabpanel"></div>';
const cases=[
 {verdict:'rejected_origin',origin:'https://foreign.invalid',family:'other'},
 {verdict:'rejected_origin',origin:'https://douyin.com',family:'douyin.com'},
 {verdict:'rejected_origin',origin:'https://www.iesdouyin.com',family:'iesdouyin.com'},
 {verdict:'rejected_credentials',origin:'https://SECRET_PASSWORD@www.douyin.com',family:'www.douyin.com'},
 {verdict:'rejected_subject_count',query:`sec_user_id=${subject}&sec_user_id=${subject}&max_cursor=0`},
 {verdict:'rejected_subject_count',query:'max_cursor=0'},
 {verdict:'rejected_subject_value',query:'sec_user_id=SECRET_OTHER&max_cursor=0'},
 ...['snapshot','current'].flatMap(stage=>[
  {verdict:`rejected_${stage}_subject`,[stage]:source.url+'?modal_id=987654321987',hasWork:true,hostAllowed:true,subjectIsSource:true},
  {verdict:`rejected_${stage}_subject`,[stage]:'https://www.douyin.com/user/SECRET_OTHER',hasWork:false,hostAllowed:true,subjectIsSource:false},
  {verdict:`rejected_${stage}_subject`,[stage]:`https://foreign.invalid/user/${subject}`,hasWork:false,hostAllowed:false,subjectIsSource:true},
 ]),
 {verdict:'accepted'},
];
for(const [index,c] of cases.entries())test(`subject refusal ${index}: ${c.verdict} and exact scalar context`,async t=>{
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());await context.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:markup}));const page=await context.newPage();await page.goto(c.snapshot??source.url);
 // Model a current-document snapshot delivered before its navigation event.
 // This isolates S5 instead of the separate stale_generation short circuit.
 let current=false;const evaluate=page.evaluate.bind(page);page.evaluate=async(fn,arg)=>{const result=await evaluate(fn,arg);return current&&fn.name==='sourceTabState'?{...result,url:c.current}:result;};
 const diagnostics=new DiagnosticCollector(),items=[],query=c.query??`sec_user_id=${subject}&max_cursor=0`;
 const req={url:()=>`${c.origin??'https://www.douyin.com'}/aweme/v1/web/aweme/favorite/?${query}`,method:()=> 'GET',frame:()=>page.mainFrame(),isNavigationRequest:()=>false};
 const response={request:()=>req,status:()=>200,ok:()=>true,headers:()=>({'content-type':'application/json'}),text:async()=>JSON.stringify({status_code:0,aweme_list:[{aweme_id:'123000111',desc:'SECRET_TITLE'}],has_more:0,max_cursor:'987654321987'})};
 await scanPage(page,{source,navigate:false,maxRounds:1,waitMs:1,diagnostics,prepare:async()=>{page.emit('request',req);await tabSnapshot(page,'douyin','liked');page.emit('response',response);},beforePublish:async()=>{if(c.current)current=true;},emit:async(type,p)=>{if(type==='item')items.push(p.item);}});
 const rows=diagnostics.snapshot(),verdict=rows.find(e=>e.listVerdict===c.verdict);assert.ok(verdict,JSON.stringify(rows));assert.equal(verdict.status,200);assert.ok(Number.isInteger(verdict.requestOrdinal));
 const shape=rows.find(e=>e.requestOrdinal===verdict.requestOrdinal&&'requestSubjectLength' in e);assert.ok(shape,JSON.stringify(rows));const subjects=new URL(req.url()).searchParams.getAll('sec_user_id');
 assert.equal(shape.requestSubjectLength,Math.min(256,subjects[0]?.length??0));assert.equal(shape.sourceSubjectLength,subject.length);assert.equal(shape.accountIdLength,subject.length);assert.equal(shape.requestSubjectIsSource,subjects.length===1&&subjects[0]===subject);assert.equal(shape.requestSubjectIsAccount,subjects.length===1&&subjects[0]===subject);assert.equal(shape.sourceSubjectIsAccount,true);assert.equal(shape.originFamily,c.family??'www.douyin.com');
 if(c.snapshot||c.current){const snapshot=rows.find(e=>e.requestOrdinal===verdict.requestOrdinal&&'snapshotPath' in e);assert.ok(snapshot,JSON.stringify(rows));assert.equal(snapshot.snapshotPath,'/user/:id');assert.equal(snapshot.snapshotHasWork,c.hasWork);assert.equal(snapshot.snapshotHostAllowed,c.hostAllowed);assert.equal(snapshot.snapshotSubjectIsSource,c.subjectIsSource);}
 assert.equal(items.length,c.verdict==='accepted'?1:0);
 for(const row of rows)assert.ok(Buffer.byteLength(JSON.stringify(row))<=300);
 for(const secret of ['SECRET_','sec_user_id','987654321987','?'])assert.equal(JSON.stringify(rows).includes(secret),false);
});
test('group capacity is atomic and reserves the final summary',()=>{const d=new DiagnosticCollector();for(let i=0;i<198;i++)d.add({status:200});assert.equal(d.addGroup([{requestOrdinal:1,listVerdict:'accepted'},{requestOrdinal:1,requestSubjectLength:12}]),false);assert.equal(d.snapshot().length,198);d.addFinal({reason:'completed',published:0});assert.equal(d.snapshot().at(-1).reason,'completed');});
test('request ordinals remain distinct beyond the legacy attempt cap',async t=>{
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());await context.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:markup}));const page=await context.newPage();await page.goto(source.url);const diagnostics=new DiagnosticCollector();
 await scanPage(page,{source,navigate:false,maxRounds:1,waitMs:1,diagnostics,prepare:()=>{for(let i=0;i<10;i++){const req={url:()=> 'https://www.douyin.com/aweme/v1/web/aweme/favorite/?sec_user_id=SECRET_OTHER&max_cursor=0',method:()=> 'GET',frame:()=>page.mainFrame(),isNavigationRequest:()=>false};page.emit('request',req);page.emit('response',{request:()=>req,status:()=>200});}},emit:async()=>{}});
 const rows=diagnostics.snapshot(),verdicts=rows.filter(e=>e.listVerdict);assert.deepEqual(verdicts.map(e=>e.requestOrdinal),Array.from({length:10},(_,i)=>i+1));assert.equal(verdicts[9].attempt,8);for(const row of verdicts){const shape=rows.filter(e=>e.requestOrdinal===row.requestOrdinal&&e.originFamily);assert.equal(shape.length,1);assert.equal(shape[0].requestSubjectIsSource,false);}
});
test('new scalar whitelist rejects unknown values and bounds',()=>{
 assert.deepEqual(diagnosticEntry({status:200,requestOrdinal:1025,requestSubjectLength:257,sourceSubjectLength:-1,accountIdLength:1.5,requestSubjectIsSource:1,requestSubjectIsAccount:'true',sourceSubjectIsAccount:null,snapshotHasWork:1,snapshotHostAllowed:'SECRET',snapshotSubjectIsSource:0,originFamily:'www.douyin.com.SECRET',listVerdict:'rejected_SECRET',accountId:'SECRET'}),{status:200});
 const shape={requestOrdinal:1024,requestSubjectLength:256,sourceSubjectLength:0,accountIdLength:256,requestSubjectIsSource:false,requestSubjectIsAccount:false,sourceSubjectIsAccount:true,originFamily:'edith.xiaohongshu.com'};assert.deepEqual(diagnosticEntry(shape),shape);
 const snapshot={requestOrdinal:1,snapshotPath:'https://www.douyin.com/user/SECRET?modal_id=SECRET',snapshotHasWork:true,snapshotHostAllowed:true,snapshotSubjectIsSource:true};assert.deepEqual(diagnosticEntry(snapshot),{snapshotPath:'/user/:id',requestOrdinal:1,snapshotHasWork:true,snapshotHostAllowed:true,snapshotSubjectIsSource:true});
});
