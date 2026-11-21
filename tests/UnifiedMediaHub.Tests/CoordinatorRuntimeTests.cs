using System.Diagnostics;
using UnifiedMediaHub.Core;
using UnifiedMediaHub.Core.Runtime;
using Xunit;

namespace UnifiedMediaHub.Tests;
public sealed class CoordinatorRuntimeTests
{
    [Fact]
    public async Task MasterOffThroughRealRunnerWaitsForOwnedChildAndGrandchildExit()
    {
        var root=new DirectoryInfo(AppContext.BaseDirectory);while(root!=null&&!File.Exists(Path.Combine(root.FullName,"AGENTS.md")))root=root.Parent;
        Assert.NotNull(root);var dir=Path.Combine(root.FullName,".cache","task5-runtime",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
        var pidFile=Path.Combine(dir,"pids");var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var repo=new HubRepository(Path.Combine(dir,"hub.db"));repo.Initialize();
        var runner=new OwnedWorkerRunner(new(){ExecutablePath=Path.Combine(root.FullName,"runtime","node","node.exe"),WorkerScriptPath=Path.Combine(root.FullName,"tests","fixtures","owned-worker.mjs"),WorkingDirectory=root.FullName,ShutdownTimeout=TimeSpan.FromMilliseconds(300),Environment=new(){["FIXTURE_MODE"]="tree",["PID_FILE"]=pidFile}});
        await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=dir,DownloadRoot=dir,EngineRoot=dir,BrowserExecutable=Path.Combine(dir,"unused.exe")});
        hub.Message+=(_,e)=>{if(e.Message=="tree-ready")entered.TrySetResult();};hub.Enable();var first=repo.CreateJob(new(){Platform="x",Url="https://x.com/alice"},dir);var work=hub.Submit(first.Id,"scan");await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var pids=File.ReadAllText(pidFile).Split(new[]{',','\n','\r'},StringSplitOptions.RemoveEmptyEntries).Select(int.Parse).ToArray();Assert.Equal(3,pids.Length);
        var second=repo.CreateJob(new(){Platform="douyin",Url="https://www.douyin.com/user/alice"},dir);var queued=hub.Submit(second.Id,"scan");await hub.DisableAsync();await Task.WhenAll(work,queued);
        foreach(var pid in pids){try{using var p=Process.GetProcessById(pid);await p.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));}catch(ArgumentException){}}
        Assert.Equal("paused",repo.GetJob(first.Id)!.Status);Assert.Equal("paused",repo.GetJob(second.Id)!.Status);Assert.Equal(0,hub.ActiveCount);Assert.Equal(0,hub.PendingCount);
        var final=Assert.Single(repo.GetResourceSummaries(first.Id));Assert.NotNull(final.FinishedAt);Assert.Null(final.PrivateCommitBytes);
        Assert.Empty(repo.GetResourceSummaries(second.Id));
        var stopped=hub.Resources;await Task.Delay(1100);Assert.Equal(stopped,hub.Resources);
    }
}
