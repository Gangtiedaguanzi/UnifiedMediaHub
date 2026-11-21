using UnifiedMediaHub.Core.Runtime;
using UnifiedMediaHub.Core;
using System.Diagnostics;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class ResourceMetricsTests
{
    static string Root { get { var d = new DirectoryInfo(AppContext.BaseDirectory); while (d != null && !File.Exists(Path.Combine(d.FullName, "AGENTS.md"))) d = d.Parent; return d!.FullName; } }
    static WorkerLaunchOptions Options(string mode) => new() { ExecutablePath = Path.Combine(Root, "runtime/node/node.exe"), WorkerScriptPath = Path.Combine(Root, "tests/fixtures/resource-worker.mjs"), WorkingDirectory = Root, ShutdownTimeout = TimeSpan.FromMilliseconds(300), Environment = new() { ["FIXTURE_MODE"] = mode } };
    [Theory]
    [InlineData("normal")]
    [InlineData("hang")]
    public async Task OwnedTreeIncludesAllocatedChildExcludesSentinelAndSamplingStops(string mode)
    {
        var start = new ProcessStartInfo(Options(mode).ExecutablePath) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("-e"); start.ArgumentList.Add("globalThis.x=Buffer.alloc(64*1024*1024,1);setTimeout(()=>{},20000)");
        using var sentinel = Process.Start(start)!;
        await using var session = await OwnedWorkerSession.StartAsync(Options(mode), new() { RequestId = "synthetic-resources", Operation = "scan" });
        try
        {
            using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            int child = 0;
            await foreach (var e in session.ReadEventsAsync(wait.Token)) if (e.Message == "ready") { child = (int)e.Current!; break; }
            ResourceMetrics Snapshot() => session.Resources;
            var ready = DateTimeOffset.UtcNow;
            while (Snapshot().SampledAt <= ready && !wait.IsCancellationRequested) await Task.Delay(50);
            Assert.True(Snapshot().ProcessCount >= 2, System.Text.Json.JsonSerializer.Serialize(Snapshot()));
            var job = (WorkerJob)typeof(OwnedWorkerSession).GetField("job", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(session)!;
            Assert.True(job.ReadProcessMemory(child)?.Commit >= 48 * 1024 * 1024);
            Assert.Null(job.ReadProcessMemory(sentinel.Id));
            var current = Snapshot();
            Assert.True(current.PrivateCommitBytes >= 48 * 1024 * 1024); Assert.True(current.WorkingSetBytes > 0);
            Assert.True(current.HostPrivateCommitBytes > 0); Assert.True(current.HostWorkingSetBytes > 0);
            Assert.True(current.PeakProcessCount >= 2); Assert.False(sentinel.HasExited);
            await session.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
            var final = Snapshot(); Assert.NotNull(final.FinishedAt); Assert.Null(final.ProcessCount);
            Assert.True(final.PeakPrivateCommitBytes >= current.PrivateCommitBytes);
            await Task.Delay(1150); Assert.Equal(final, Snapshot()); Assert.False(sentinel.HasExited);
        }
        finally { if (!sentinel.HasExited) { sentinel.Kill(); await sentinel.WaitForExitAsync(); } }
    }

    [Fact]
    public void UnknownAndFailedSamplesAreNotZeroAndDoNotEraseObservedPeaks()
    {
        var metrics = new ResourceMetrics { RequestId = "r", Operation = "scan" };
        Assert.Equal("unknown", metrics.Quality); Assert.Null(metrics.PeakPrivateCommitBytes);
        metrics = metrics.Add(new(true, 3, 100, 200)).Add(default);
        Assert.Null(metrics.PrivateCommitBytes); Assert.Equal(100L, metrics.PeakPrivateCommitBytes);
        Assert.Equal("incomplete", metrics.Quality); Assert.Equal(1, metrics.IncompleteSampleCount);
        Assert.Null(metrics.Finish().WorkingSetBytes);
    }

    [Fact]
    public void GrowingEnumerationIsBoundedAndMissingProcessIsIncomplete()
    {
        var calls = 0; var reads = 0;
        var sample = WorkerJob.Collect(capacity => { calls++; return (false, capacity + 1, Array.Empty<int>()); }, pid => { reads++; return (1L, 1L); });
        Assert.False(sample.Complete); Assert.Equal(3, calls); Assert.Equal(0, reads);
        Assert.False(WorkerJob.Collect(_ => (true, 513, []), _ => (1L, 1L)).Complete);
        Assert.False(WorkerJob.Collect(_ => (true, 2, [1, 2]), pid => pid == 1 ? (10L, 20L) : null).Complete);
        Assert.Equal(new ResourceSample(true, 2, 20, 40), WorkerJob.Collect(_ => (true, 2, [1, 2]), _ => (10L, 20L)));
        calls = 0; reads = 0;
        sample = WorkerJob.Collect(capacity => { calls++; return capacity < 512 ? (false, 512, []) : (true, 512, Enumerable.Range(1, 512).ToArray()); }, _ => { reads++; return (1L, 2L); });
        Assert.True(sample.Complete); Assert.Equal(2, calls); Assert.Equal(512, reads); Assert.Equal(512, sample.ProcessCount);
    }

    [Fact]
    public void UnobservedBatchMakesAggregateIncompleteWithoutInventingZeroPeaks()
    {
        var known = new ResourceMetrics { RequestId = "first", Operation = "download", OperationId = "run" }.Add(new(true, 2, 100, 200)).Finish();
        var missing = new ResourceMetrics { RequestId = "second", Operation = "download", OperationId = "run" }.Finish();
        var aggregate = missing.AcrossBatches(known);
        Assert.Equal("incomplete", aggregate.Quality); Assert.Equal(100L, aggregate.PeakPrivateCommitBytes); Assert.Null(aggregate.PrivateCommitBytes);
        Assert.Equal("unknown", missing.AcrossBatches(missing).Quality);
    }

    [Fact]
    public async Task WorkerJsonCannotForgeResourceMeasurements()
    {
        await using var session = await OwnedWorkerSession.StartAsync(Options("spoof"), new() { RequestId = "spoof", Operation = "scan" });
        await Assert.ThrowsAsync<IOException>(async () => await session.Completion.WaitAsync(TimeSpan.FromSeconds(5)));
    }
}
