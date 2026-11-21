import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
const [release,output]=process.argv.slice(2).map(x=>path.resolve(x));
const browserOnly=process.argv.includes('--browser-only');
await mkdir(output,{recursive:true});
const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAeklEQVR4nO3PUQkAIBTAwBfGVCYxviH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBrQRg4sN+1zwAAAAASUVORK5CYII=','base64');
const hash=createHash('sha256').update(data).digest('hex');
const observations=[];
const server=http.createServer((req,res)=>{
 if(req.url==='/bad'){res.writeHead(500);res.end('fixture server error');return;}
 res.writeHead(200,{'content-type':'image/png'});
 if(req.url==='/slow'){res.write(data.subarray(0,8));const timer=setTimeout(()=>res.end(data.subarray(8)),20000);res.once('close',()=>clearTimeout(timer));}
 else res.end(data);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const paths={dataRoot:path.join(output,'private-data'),downloadRoot:path.join(output,'媒体 样本'),browserExecutable:path.join(release,'runtime/browsers/chromium-1248/chrome-win64/chrome.exe'),engineRoot:path.join(release,'runtime/engines')};
const item=(url,selected=true)=>({key:'douyin:123',platform:'douyin',contentId:'123',sourceUrl:'https://www.douyin.com/video/123',selected,mediaResolved:true,media:[{index:1,kind:'image',extension:'png',url}]});
const url='http://127.0.0.1:'+server.address().port;
async function run(route,{cancel=false,kill=false}={}) {
 const child=spawn(path.join(release,'runtime/node/node.exe'),[path.join(release,'worker/src/main.mjs')],{cwd:output,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,TEMP:path.join(output,'temp'),TMP:path.join(output,'temp')}});
 const closed=once(child,'close');let stdout='',stderr='',buffer='',interrupted=false;
 const events=[];child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{stdout+=b;buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const e=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);events.push(e);if(e.type==='progress'&&e.phase==='download'&&!interrupted){interrupted=true;if(cancel)child.stdin.write('{"command":"cancel"}\n');if(kill)child.kill();}}});
 child.stdin.on('error',()=>{});
 const selected=item(url+route),unselected={...item(url+'/must-not-request',false),key:'douyin:999',contentId:'999'};
 child.stdin.write(JSON.stringify({version:1,requestId:'packaged-fixture',operation:'download',source:{platform:'douyin',kind:'single',url:'https://www.douyin.com/video/123'},items:[selected,unselected],paths})+'\n');
 const timeout=setTimeout(()=>child.kill(),30000);
 const [code]=await closed;clearTimeout(timeout);assert.equal(stderr,'');
 observations.push({case:route,cancel,kill,exitCode:code,pid:child.pid,complete:events.findLast(e=>e.type==='complete'),receipts:events.filter(e=>e.type==='receipt').map(e=>({status:e.receipt.status,bytes:e.receipt.bytes,sha256:e.receipt.sha256,errorCode:e.receipt.errorCode}))});
 await writeFile(path.join(output,'packaged-fixtures-progress.json'),JSON.stringify({evidence:'Synthetic fixtures; incremental case evidence, not final verdict',observations},null,2));
 return events;
}
try {
 if(!browserOnly) {
 let events=await run('/image');let receipt=events.find(e=>e.type==='receipt').receipt;assert.equal(receipt.sha256,hash);assert.deepEqual(await readFile(receipt.filePath),data);assert.equal(events.at(-1).status,'completed');
 events=await run('/image');assert.equal(events.find(e=>e.type==='receipt').receipt.status,'skipped');
 const corrupt=Buffer.from(data);corrupt[12]^=1;await writeFile(receipt.filePath,corrupt);
 events=await run('/image');assert.equal(events.find(e=>e.type==='receipt').receipt.status,'failed');assert.deepEqual(await readFile(receipt.filePath),corrupt);
 await rm(receipt.filePath);events=await run('/image');assert.equal(events.find(e=>e.type==='receipt').receipt.status,'completed');
 await rm(receipt.filePath);events=await run('/slow',{cancel:true});assert.equal(events.at(-1).status,'paused');assert.equal((await readdir(paths.downloadRoot,{recursive:true})).filter(x=>x.endsWith('.part')).length,0);
 events=await run('/image');assert.equal(events.find(e=>e.type==='receipt').receipt.sha256,hash);
 await rm(receipt.filePath);await writeFile(path.join(paths.downloadRoot,'unrelated.part'),'keep');await run('/slow',{kill:true});
 assert.equal((await readdir(paths.downloadRoot,{recursive:true})).filter(x=>x.endsWith('.part')).length,2);
 events=await run('/image');assert.equal(events.find(e=>e.type==='receipt').receipt.sha256,hash);assert.deepEqual((await readdir(paths.downloadRoot,{recursive:true})).filter(x=>x.endsWith('.part')),['unrelated.part']);
 events=await run('/bad');assert.equal(events.find(e=>e.type==='receipt').receipt.status,'failed');assert.equal(events.at(-1).status,'failed');
 } else observations.push(...JSON.parse(await readFile(path.join(output,'packaged-fixtures-progress.json'),'utf8')).observations);
 // Actual installed Chromium; all page requests fulfilled synthetically.
 const {openBrowser}=await import(pathToFileURL(path.join(release,'worker/src/shared/browser.mjs')));
 const {scanPage}=await import(pathToFileURL(path.join(release,'worker/src/shared/scanner.mjs')));
 const context=await openBrowser(paths,'douyin',{headless:true});
 try {await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<body><button role="tab" aria-selected="true">作品</button><div role="tabpanel"><a href="/video/123">fixture</a><p>没有更多了</p></div>'}));const items=[];const result=await scanPage(await context.newPage(),{source:{platform:'douyin',kind:'profile',url:'https://www.douyin.com/user/fixture'},emit:async(type,p)=>{if(type==='item')items.push(p.item);},maxRounds:1});assert.equal(result.completeness,'complete');assert.equal(items.length,1);observations.push({case:'installed-browser-synthetic-list',items:items.length,result});}finally{await context.close();}
 await writeFile(path.join(output,'packaged-fixtures.json'),JSON.stringify({evidence:'Synthetic loopback/intercepted fixtures, no platform/account validation',release,hash,observations},null,2));
 console.log(JSON.stringify({status:'passed',cases:observations.length,hash}));
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
