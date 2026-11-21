import readline from 'node:readline';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(import.meta.url);
if (process.argv[2] === 'descendant') {
  if (process.argv[3] === 'child') {
    const grandchild = spawn(process.execPath, [script, 'descendant', 'grandchild'], {stdio:['ignore','ignore','ignore','ipc']});
    fs.appendFileSync(process.argv[4], `${grandchild.pid}\n`);
    grandchild.once('message',value=>{if(value==='ready')process.send?.('tree-ready');});
  } else {
    process.send?.('ready');
  }
  setTimeout(() => process.exit(0), 20000);
} else {
  // No file writes, engine imports or descendants before the first valid command.
  const input = readline.createInterface({input:process.stdin});
  let request;
  const emit = (type, fields={}) => console.log(JSON.stringify({version:1, requestId:request.requestId,type,...fields}));
  input.on('line', line => {
    const value = JSON.parse(line);
    if (!request) {
      if(value.version !== 1 || !value.requestId) process.exit(2);
      request = value;
      const mode = process.env.FIXTURE_MODE;
      if(mode?.startsWith('bridge-bound-')){const kind=mode.slice(13);if(kind==='status')emit('status',{message:'x'.repeat(100000)});else emit('item',{item:{platform:kind==='foreign'?'x':'douyin',title:'x'.repeat(kind==='oversize'?524288:100000)}});process.stdout.write('',()=>process.exit(0));}
      else if(mode === 'tree' || mode === 'hang') {
        const child = spawn(process.execPath,[script,'descendant','child',process.env.PID_FILE],{stdio:['ignore','ignore','ignore','ipc']});
        fs.appendFileSync(process.env.PID_FILE,`${process.pid}\n${child.pid}\n`);
        child.once('message',value=>{if(value==='tree-ready')emit('status',{message:'tree-ready'});});
      } else if(mode === 'malformed') {
        process.stderr.write('Cookie: super-secret; https://cdn.invalid/?token=secret\n'.repeat(10000));
        console.log('not-json https://cdn.invalid/?token=secret');
      } else if(mode === 'oversized') process.stdout.write('x'.repeat(1000000));
      else if(mode === 'overflow') {
        for(let n=0;n<2000;n++) emit('progress',{current:n});
        process.exit(0);
      } else if(mode === 'events') {
        for(let n=0;n<100;n++) emit('progress',{current:n,message:'中文'});
        emit('complete',{status:'completed',completeness:'complete'});
        process.exit(0);
      } else if(mode === 'wrong-id') { console.log(JSON.stringify({version:1,requestId:'wrong',type:'status'})); }
      else if(mode === 'string-version') console.log(JSON.stringify({version:'1',requestId:request.requestId,type:'status'}));
      else if(mode === 'truncated') {process.stdout.write('{');process.exit(0);}
      else if(mode === 'invalid-utf8') {process.stdout.write(Buffer.from([0xff,0x0a]));process.exit(0);}
      else if(mode === 'no-read') { input.pause(); process.stdin.pause(); emit('status',{message:'ready'}); }
      else if(mode === 'bulk') {
        for(let n=0;n<600;n++) emit('progress',{current:n});
        emit('complete',{status:'completed',completeness:'complete'});
        process.stdout.write('',()=>process.exit(0));
      }
      else emit('status',{message:'ready'});
    } else if(value.command === 'cancel' && !['hang','eof'].includes(process.env.FIXTURE_MODE)) {
      emit('complete',{status:'paused',completeness:'partial'}); process.exit(0);
    } else if(value.command === 'input') emit('status',{message:value.text});
  });
  input.on('close',() => {
    if(process.env.FIXTURE_MODE !== 'hang') {if(request) emit('complete',{status:'paused',message:'eof'}); process.exit(0);}
  });
  setTimeout(() => process.exit(9),20000);
}
