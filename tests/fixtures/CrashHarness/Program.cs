using UnifiedMediaHub.Core;
using UnifiedMediaHub.Core.Runtime;

if(args is ["--ordinary-browser-host"])return await OrdinaryBrowserHost.RunAsync();
if(args.Length>0&&(args[0].StartsWith("--user-data-dir=")||args[0]=="--ordinary-leaf"))return OrdinaryFixture.Run(args);
// The test kills only this disposable owner. Never kill the testhost/controller.
var options = new WorkerLaunchOptions {
    ExecutablePath = args[0], WorkerScriptPath = args[1], WorkingDirectory = args[2],
    Environment = new Dictionary<string,string> { ["FIXTURE_MODE"] = "tree", ["PID_FILE"] = args[3] }
};
await using var session = await OwnedWorkerSession.StartAsync(options, new WorkerRequest { RequestId = "crash-test", Operation = "scan" });
await foreach(var item in session.ReadEventsAsync()) {
    if(item.Message == "tree-ready") { Console.WriteLine("READY"); await Task.Delay(Timeout.Infinite); }
}
return 0;
