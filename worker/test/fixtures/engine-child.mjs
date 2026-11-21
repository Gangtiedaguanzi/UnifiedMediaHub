const mode=process.argv[2];
if(mode==='env') console.log(JSON.stringify({home:process.env.HOME,profile:process.env.USERPROFILE,temp:process.env.TEMP,tmp:process.env.TMP,tdl:Object.keys(process.env).filter(k=>/^TDL_/i.test(k))}));
if(mode==='overflow') process.stdout.write('x'.repeat(100000));
if(mode==='prompt'){ console.log('{"field":"password","secret":"SYNTHETIC_SECRET"}'); process.stdin.resume(); }
if(mode==='machineerror'){ console.log('{"version":1,"type":"error","code":"rate_limited"}');process.exitCode=1; }
if(mode==='prompt-exit'){console.log('{"type":"input_required"}');}
if(mode==='file-output'){const {writeFile}=await import('node:fs/promises');await writeFile(process.argv[3],'x'.repeat(2048));setTimeout(()=>{},10000);}
if(mode==='tg-prompt'){console.log(JSON.stringify({version:1,type:'input_required',field:'password',inputType:'password',promptId:'b'.repeat(48)}));process.stdin.resume();}
if(mode==='stage-wait'){const {writeFile}=await import('node:fs/promises');await writeFile(process.argv[3],'synthetic media');console.log('staged');process.stdin.resume();}
