using System.Diagnostics;
using UnifiedMediaHub.Core;
using UnifiedMediaHub.Core.Runtime;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class RuntimeTests : IDisposable
{
    private static readonly string Root = FindRoot();
    private static readonly string Node = Path.Combine(Root, "runtime", "node", "node.exe");
    private static readonly string Script = Path.Combine(Root, "tests", "fixtures", "owned-worker.mjs");
    private readonly string temp = Path.Combine(Path.GetTempPath(), "UnifiedMediaHub-runtime", Guid.NewGuid().ToString("N"));
    public RuntimeTests() => Directory.CreateDirectory(temp);
    private static string FindRoot() { var d = new DirectoryInfo(AppContext.BaseDirectory); while (d != null && !File.Exists(Path.Combine(d.FullName, "AGENTS.md"))) d = d.Parent; return d?.FullName ?? throw new InvalidOperationException("Project root missing"); }
    private WorkerLaunchOptions Options(string mode) => new() { ExecutablePath = Node, WorkerScriptPath = Script, WorkingDirectory = Root, ShutdownTimeout = TimeSpan.FromMilliseconds(300), Environment = new Dictionary<string, string> { { "FIXTURE_MODE", mode }, { "PID_FILE", Path.Combine(temp, "pids") } } };
    private static WorkerRequest Request() => new() { RequestId = "owned-中文-9007199254740993123", Operation = "scan" };
    private static async Task<List<WorkerEvent>> Events(OwnedWorkerSession s) { var events = new List<WorkerEvent>(); await foreach (var e in s.ReadEventsAsync()) events.Add(e); return events; }

    [Theory][InlineData("status")][InlineData("foreign")][InlineData("oversize")]
    public async Task LargeBridgeAllowanceDoesNotRelaxOtherEventsOrMaximum(string kind){var request=Request();request.Operation="importBridge";request.Source=new(){Platform="douyin",Kind="bridge"};await using var session=await OwnedWorkerSession.StartAsync(Options("bridge-bound-"+kind),request);await Assert.ThrowsAnyAsync<IOException>(async()=>await session.Completion.WaitAsync(TimeSpan.FromSeconds(10)));Assert.False(IsAlive(session.ProcessId));}

    [Fact]
    public async Task EarlyEventsAreRetainedAndCompletionDoesNotNeedAReader()
    {
        await using var session = await OwnedWorkerSession.StartAsync(Options("events"), Request());
        Assert.Equal(0, await session.Completion.WaitAsync(TimeSpan.FromSeconds(10)));
        var events = await Events(session);
        Assert.Equal(101, events.Count); Assert.Equal(Enumerable.Range(0, 100).Select(n => (long?)n), events.Take(100).Select(e => e.Current));
        Assert.All(events, e => Assert.Equal(Request().RequestId, e.RequestId)); Assert.Equal("中文", events[0].Message);
    }

    [Theory]
    [InlineData("cancel")]
    [InlineData("eof")]
    public async Task StopCompletesGracefullyAndControlsPreserveUtf8(string mode)
    {
        await using var session = await OwnedWorkerSession.StartAsync(Options(mode), Request());
        await session.SendControlAsync(new { command = "input", text = "中文验证码" });
        await session.StopAsync();
        Assert.Equal(0, await session.Completion);
        var events = await Events(session); Assert.Contains(events, e => e.Message == "中文验证码"); Assert.Contains(events, e => e.Status == "paused");
    }

    [Theory]
    [InlineData("malformed")]
    [InlineData("oversized")]
    [InlineData("wrong-id")]
    [InlineData("overflow")]
    [InlineData("string-version")]
    [InlineData("truncated")]
    [InlineData("invalid-utf8")]
    public async Task InvalidOrUnconsumedExcessOutputFailsWithoutSensitiveDiagnostics(string mode)
    {
        await using var session = await OwnedWorkerSession.StartAsync(Options(mode), Request());
        var error = await Assert.ThrowsAnyAsync<IOException>(async () => await session.Completion.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.DoesNotContain("secret", error.ToString()); Assert.DoesNotContain("cdn.invalid", error.ToString()); Assert.True(error.Message.Length < 1000);
        Assert.False(IsAlive(session.ProcessId));
    }

    [Fact]
    public async Task ForcedDisposeKillsOnlyOwnedTree()
    {
        using var sentinel = Sentinel();
        var session = await OwnedWorkerSession.StartAsync(Options("hang"), Request());
        try
        {
            await WaitTree(session); var pids = ReadPids(); Assert.Equal(3, pids.Length); Assert.All(pids, pid => Assert.True(IsAlive(pid)));
            await session.DisposeAsync(); await AssertDead(pids); Assert.False(sentinel.HasExited);
        }
        finally { await session.DisposeAsync(); sentinel.Kill(); }
    }

    [Fact]
    public async Task NormalWorkerExitAlsoClosesOwnedDescendants()
    {
        await using var session = await OwnedWorkerSession.StartAsync(Options("tree"), Request());
        await WaitTree(session); var pids = ReadPids(); await session.StopAsync(); await AssertDead(pids);
    }

    [Fact]
    public async Task ParentCrashClosesJobWithoutKillingUnrelatedProcess()
    {
        using var sentinel = Sentinel();
        var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
        var dll = Path.Combine(Root, "tests", "fixtures", "CrashHarness", "bin", configuration, "net10.0", "CrashHarness.dll");
        Assert.True(File.Exists(dll), "Crash harness project reference must build the disposable owner.");
        var start = new ProcessStartInfo(Path.Combine(Root, ".tooling", "dotnet", "dotnet.exe")) { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true, WorkingDirectory = Root };
        foreach (var arg in new[] { dll, Node, Script, Root, Path.Combine(temp, "pids") }) start.ArgumentList.Add(arg);
        using var harness = Process.Start(start)!;
        try { Assert.Equal("READY", await harness.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10))); var pids = ReadPids(); Assert.Equal(3, pids.Length); harness.Kill(); await harness.WaitForExitAsync(); await AssertDead(pids); Assert.False(sentinel.HasExited); }
        finally { if (!harness.HasExited) harness.Kill(); sentinel.Kill(); }
    }

    [Theory][InlineData(false)][InlineData(true)]
    public async Task OrdinaryBrowserAndItsLeafInheritWorkerJob(bool ownerCrash)
    {
        var configuration=new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
        var dll=Path.Combine(Root,"tests","fixtures","CrashHarness","bin",configuration,"net10.0","CrashHarness.dll");
        var host=Path.Combine(Root,".tooling","dotnet","dotnet.exe");var pidFile=Path.Combine(temp,"pids");
        File.WriteAllText(pidFile+".config",System.Text.Json.JsonSerializer.Serialize(new{host,dll,fixture=Path.ChangeExtension(dll,".exe")}));
        var script=Path.Combine(Root,"tests","fixtures","ordinary-owned-worker.mjs");
        using var sentinel=Sentinel();
        try
        {
            if(ownerCrash)
            {
                var start=new ProcessStartInfo(host){UseShellExecute=false,RedirectStandardOutput=true,CreateNoWindow=true};
                foreach(var arg in new[]{dll,Node,script,Root,pidFile})start.ArgumentList.Add(arg);
                using var owner=Process.Start(start)!;
                try{Assert.Equal("READY",await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)));var pids=ReadPids();Assert.Equal(3,pids.Length);owner.Kill();await owner.WaitForExitAsync();await AssertDead(pids);}
                finally{if(!owner.HasExited)owner.Kill();}
            }
            else
            {
                var options=Options("tree");options.WorkerScriptPath=script;
                await using var session=await OwnedWorkerSession.StartAsync(options,Request());await WaitTree(session);
                var pids=ReadPids();Assert.Equal(3,pids.Length);await session.StopAsync();await AssertDead(pids);
            }
            Assert.False(sentinel.HasExited);
        }
        finally{if(!sentinel.HasExited)sentinel.Kill();}
    }

    [Fact]
    public async Task PreCancelledLaunchHasNoWorkerEffects()
    {
        using var cts = new CancellationTokenSource(); cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => OwnedWorkerSession.StartAsync(Options("tree"), Request(), cts.Token));
        Assert.False(File.Exists(Path.Combine(temp, "pids")));
    }

    [Fact]
    public async Task CancelledPartialControlWriteTerminatesInsteadOfLeavingDesynchronizedWorker()
    {
        await using var session = await OwnedWorkerSession.StartAsync(Options("no-read"), Request());
        await foreach (var item in session.ReadEventsAsync()) if (item.Message == "ready") break;
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => session.SendControlAsync(new { command = "input", text = new string('a', 60000) }, timeout.Token));
        await session.Completion.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(IsAlive(session.ProcessId));
    }

    [Fact]
    public async Task ConcurrentStopAndDisposeAreIdempotent()
    {
        var session = await OwnedWorkerSession.StartAsync(Options("hang"), Request());
        await WaitTree(session); var pids = ReadPids();
        await Task.WhenAll(session.StopAsync(), session.DisposeAsync().AsTask(), session.DisposeAsync().AsTask());
        await AssertDead(pids);
        await Assert.ThrowsAsync<IOException>(() => session.SendControlAsync(new { command = "cancel" }));
    }

    [Fact]
    public async Task ContinuousSlowConsumerReceivesBulkBeyondBufferCapacity()
    {
        await using var session = await OwnedWorkerSession.StartAsync(Options("bulk"), Request());
        var received = new List<long?>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await foreach (var item in session.ReadEventsAsync(timeout.Token))
        {
            if (item.Type == "progress") received.Add(item.Current);
            if (received.Count % 4 == 0) await Task.Delay(2, timeout.Token);
        }
        Assert.Equal(Enumerable.Range(0, 600).Select(n => (long?)n), received);
        Assert.Equal(0, await session.Completion);
    }

    [Fact]
    public async Task ForcedStopInterruptsBackpressureWhenConsumerAbandonsQueue()
    {
        var session = await OwnedWorkerSession.StartAsync(Options("bulk"), Request());
        try
        {
            // Leave the reader absent until the worker is waiting on its full queue.
            await Task.Delay(200);
            await session.StopAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Assert.True(session.Completion.IsCompleted);
            Assert.False(IsAlive(session.ProcessId));
        }
        finally { await session.DisposeAsync(); }
    }

    private Process Sentinel() { var info = new ProcessStartInfo(Node) { UseShellExecute = false, CreateNoWindow = true }; info.ArgumentList.Add("-e"); info.ArgumentList.Add("setTimeout(()=>{},20000)"); return Process.Start(info)!; }
    private static async Task WaitTree(OwnedWorkerSession s) { using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10)); await foreach (var e in s.ReadEventsAsync(cts.Token)) if (e.Message == "tree-ready") return; throw new InvalidOperationException("Missing tree event"); }
    private int[] ReadPids() => File.ReadAllLines(Path.Combine(temp, "pids")).Select(int.Parse).ToArray();
    private static bool IsAlive(int pid) { try { using var p = Process.GetProcessById(pid); return !p.HasExited; } catch (ArgumentException) { return false; } }
    private static async Task AssertDead(int[] pids) { var timer = Stopwatch.StartNew(); while (timer.Elapsed < TimeSpan.FromSeconds(5) && pids.Any(IsAlive)) await Task.Delay(25); Assert.All(pids, p => Assert.False(IsAlive(p), $"Owned process {p} survived")); }
    // Cleanup belongs to session Jobs/harness handles. Never kill by saved PID here:
    // PID reuse after an assertion failure could target an unrelated process.
    // Fixture descendants also have a 20-second failsafe lifetime.
    public void Dispose() => Directory.Delete(temp, true);
}
