using UnifiedMediaHub.Core;
using UnifiedMediaHub.Core.Runtime;
var release=args[0];var output=args[2];Directory.CreateDirectory(output);
await using var session=await OwnedWorkerSession.StartAsync(new WorkerLaunchOptions{
 ExecutablePath=Path.Combine(release,"runtime","node","node.exe"),WorkerScriptPath=args[1],WorkingDirectory=output,
 Environment=new(){["UMH_EVIDENCE"]=Path.Combine(output,"tree.json"),["TEMP"]=output,["TMP"]=output,["HOME"]=output,["USERPROFILE"]=output},
},new WorkerRequest{RequestId="release-lifecycle",Operation="scan"});
using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(20));
await foreach(var evt in session.ReadEventsAsync(timeout.Token))if(evt.Message=="tree-ready"){Console.WriteLine("READY");break;}
await Console.In.ReadLineAsync();await session.StopAsync();Console.WriteLine("STOPPED");
