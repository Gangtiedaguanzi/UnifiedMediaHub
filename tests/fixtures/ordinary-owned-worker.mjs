import readline from 'node:readline';import path from 'node:path';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {runOrdinaryProcess,ordinaryLoginArgs} from '../../worker/src/shared/ordinary-login.mjs';
const input=readline.createInterface({input:process.stdin}),abort=new AbortController();let started=false;
input.on('close',()=>abort.abort());
input.on('line',line=>{
 const request=JSON.parse(line);if(started){if(request.command==='cancel')abort.abort();return;}started=true;
 void(async()=>{
  const config=JSON.parse(await readFile(process.env.PID_FILE+'.config','utf8'));
  process.env.DOTNET_ROOT=path.dirname(config.host);
  const root=process.env.PID_FILE+'.ordinary';await mkdir(root,{recursive:true});await writeFile(path.join(root,'mode.txt'),'ignore');
  const emit=(type,payload)=>process.stdout.write(JSON.stringify({version:1,requestId:request.requestId,type,...payload})+'\n');
  try{await runOrdinaryProcess({executable:config.fixture,args:ordinaryLoginArgs(root,'https://x.com/i/flow/login'),host:config.host,hostArgs:[config.dll],signal:abort.signal,onReady:async()=>{
   for(let i=0;;i++){abort.signal.throwIfAborted();if(i>300)throw new Error('fixture timeout');try{await access(path.join(root,'window.ready'));await access(path.join(root,'leaf.pid'));break;}catch{await new Promise(r=>setTimeout(r,25));}}
   const pids=[process.pid,...await Promise.all(['browser.pid','leaf.pid'].map(file=>readFile(path.join(root,file),'utf8')))];
   await writeFile(process.env.PID_FILE,pids.join('\n'));emit('status',{message:'tree-ready'});
  }});}catch{}finally{emit('complete',{status:'paused',completeness:'unknown'});input.close();process.stdin.pause();}
 })();
});
