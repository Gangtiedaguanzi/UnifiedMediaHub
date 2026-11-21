import {spawn} from 'node:child_process';
import net from 'node:net';
import {writeFileSync} from 'node:fs';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(import.meta.url);
if(process.argv[2]==='grandchild') {
 const server=net.createServer();server.listen(0,'127.0.0.1',()=>process.send?.({pid:process.pid,port:server.address().port}));
 setTimeout(()=>process.exit(0),60000);
} else if(process.argv[2]==='child') {
 const child=spawn(process.execPath,[script,'grandchild'],{stdio:['ignore','ignore','ignore','ipc']});
 child.once('message',grandchild=>process.send?.({pid:process.pid,grandchild}));setTimeout(()=>process.exit(0),60000);
} else {
 let request;const input=readline.createInterface({input:process.stdin});
 input.on('line',line=>{
  const value=JSON.parse(line);
  if(!request){request=value;const child=spawn(process.execPath,[script,'child'],{stdio:['ignore','ignore','ignore','ipc']});
   child.once('message',tree=>{writeFileSync(process.env.UMH_EVIDENCE,JSON.stringify({worker:process.pid,...tree}));console.log(JSON.stringify({version:1,requestId:request.requestId,type:'status',message:'tree-ready'}));});
  }else if(value.command==='cancel'){console.log(JSON.stringify({version:1,requestId:request.requestId,type:'complete',status:'paused',completeness:'partial'}));process.exit(0);}
 });input.on('close',()=>process.exit(0));setTimeout(()=>process.exit(9),60000);
}
