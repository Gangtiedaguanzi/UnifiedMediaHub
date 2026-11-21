// Offline candidate-host executable probe: the executable passed as "browser"
// is CrashHarness, never Chromium. All profiles below are synthetic artifacts.
import assert from 'node:assert/strict';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),repo=fileURLToPath(new URL('..',import.meta.url));
const release=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
assert.ok(output.startsWith(path.join(repo,'artifacts')+path.sep));assert.ok(release.startsWith(path.join(repo,'artifacts')+path.sep));
const fixture=path.join(repo,'tests/fixtures/CrashHarness/bin/Debug/net10.0/CrashHarness.exe');process.env.DOTNET_ROOT=path.join(repo,'.tooling/dotnet');
const {runOrdinaryProcess,ordinaryLoginArgs,ordinaryHostExecutable}=await import(pathToFileURL(path.join(release,'worker/src/shared/ordinary-login.mjs')));
assert.equal(ordinaryHostExecutable,path.join(release,'UnifiedMediaHub.exe'));
await mkdir(output,{recursive:true});const checks=[];
async function exists(file){return access(file).then(()=>true,()=>false);}
async function until(fn){const end=Date.now()+8000;while(!await fn()){assert.ok(Date.now()<end,'fixture deadline');await new Promise(r=>setTimeout(r,25));}}
for(const mode of ['normal','self-close','ignore','cancel']){
 const profile=path.join(output,mode);await mkdir(profile);await writeFile(path.join(profile,'mode.txt'),mode);
 const controller=new AbortController();let command,actualArgs,begin,closed=false;
 const run=runOrdinaryProcess({executable:fixture,args:ordinaryLoginArgs(profile,'https://x.com/i/flow/login'),signal:controller.signal,onReady:async close=>{
  await until(async()=>await exists(path.join(profile,'window.ready'))&&await exists(path.join(profile,'leaf.pid')));
  const pid=Number(await readFile(path.join(profile,'browser.pid'),'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);
  const script=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-CimInstance Win32_Process -Property CommandLine -Filter 'ProcessId=${pid}').CommandLine`;
  const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:5000});command=result.stdout.trim();
  actualArgs=JSON.parse(await readFile(path.join(profile,'args.json'),'utf8'));assert.deepEqual(actualArgs,ordinaryLoginArgs(profile,'https://x.com/i/flow/login'));assert.equal(actualArgs.length,4);
  assert.ok(!/remote-debugging|enable-automation|disable-blink-features|disable-background-networking|disable-component-update/.test(command));
  begin=Date.now();if(mode==='self-close')await writeFile(path.join(profile,'self-close'),'close');else if(mode==='cancel')controller.abort(new Error('fixture cancel'));else close();
 }});
 try{await run;assert.notEqual(mode,'cancel');closed=true;}catch(error){if(mode!=='cancel')throw error;assert.match(error.message,/fixture cancel/);}
 for(const file of ['browser.pid','leaf.pid']){const pid=Number(await readFile(path.join(profile,file),'utf8'));assert.throws(()=>process.kill(pid,0));}
 if(mode==='ignore'){assert.ok(Date.now()-begin>=9900);assert.ok(!await exists(path.join(profile,'graceful.exit')));}
 if(mode==='normal')assert.ok(await exists(path.join(profile,'graceful.exit')));
 if(mode==='normal'||mode==='ignore')assert.ok(await exists(path.join(profile,'wm-close.txt')));
 checks.push({mode,completed:closed,cancelled:mode==='cancel',treeDead:true,elapsedAfterActionMs:Date.now()-begin,args:actualArgs.map(arg=>arg.replaceAll(profile,'<synthetic-profile>')),actualCommandLine:command.replaceAll(profile,'<synthetic-profile>').replaceAll(fixture,'<synthetic-executable>')});
}
const result={status:'PASS',synthetic:true,noChromiumLaunched:true,host:ordinaryHostExecutable,hostBypassesWpf:true,checks};await writeFile(path.join(output,'ordinary-host-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
