using Microsoft.Data.Sqlite;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class ResourceCoordinatorTests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "UMH-resources", Guid.NewGuid().ToString("N"));
    readonly HubRepository repo;
    public ResourceCoordinatorTests() { Directory.CreateDirectory(root); repo = new(Path.Combine(root, "hub.db")); repo.Initialize(); }
    public void Dispose()
    {
        repo.Dispose();
        var target = Path.GetFullPath(root); var allowed = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "UMH-resources"));
        if (!string.Equals(Path.GetDirectoryName(target), allowed, StringComparison.OrdinalIgnoreCase) || !Guid.TryParseExact(Path.GetFileName(target), "N", out _))
            throw new IOException("Resource fixture deletion boundary failed.");
        if (!Directory.Exists(target)) return;
        for (var ancestor = new DirectoryInfo(target); ancestor != null; ancestor = ancestor.Parent)
            if ((ancestor.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Resource fixture ancestor is a link.");
        var pending = new Stack<string>(); pending.Push(target);
        while (pending.TryPop(out var directory))
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Resource fixture descendant is a link.");
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
            }
        Directory.Delete(target, true);
    }
    HubJob Job() => repo.CreateJob(new() { Platform = "x", Kind = "profile", Url = "https://x.com/synthetic" }, root);
    HubCoordinator Hub(IWorkerRunner runner) => new(repo, runner, new() { DataRoot = root, DownloadRoot = root });
    static Task Done(Func<WorkerEvent, Task> emit) => emit(new() { Type = "complete", Status = "completed", Completeness = "partial" });

    [Fact]
    public async Task FinalTypedMetricsPersistAndLateOldRequestCannotReplaceCurrentOperation()
    {
        Action<ResourceMetrics>? old = null; ResourceMetrics? first = null;
        var runner = new ResourceRunner(async (request, emit, observe, ct) =>
        {
            if (old != null) old(first! with { PeakPrivateCommitBytes = 999999 });
            var metrics = new ResourceMetrics { RequestId = request.RequestId, Operation = request.Operation }.Add(new(true, 2, 100, 200));
            observe(metrics with { RequestId = "other-request", PeakPrivateCommitBytes = 888888 });
            observe(metrics); old = observe; first = metrics;
            await Done(emit); observe(metrics.Finish());
        });
        await using var hub = Hub(runner); hub.Enable();
        var a = Job(); var b = Job(); await hub.Submit(a.Id, "scan"); await hub.Submit(b.Id, "scan");
        Assert.Equal(100L, Assert.Single(repo.GetResourceSummaries(a.Id)).PeakPrivateCommitBytes);
        Assert.Equal(100L, Assert.Single(repo.GetResourceSummaries(b.Id)).PeakPrivateCommitBytes);
        old!(first! with { PeakPrivateCommitBytes = 777777 });
        Assert.Equal(b.Id, hub.Resources!.JobId); Assert.Equal(100L, hub.Resources.Metrics.PeakPrivateCommitBytes);
        Assert.Null(hub.Resources.Metrics.PrivateCommitBytes); Assert.NotNull(hub.Resources.Metrics.FinishedAt);
    }

    [Fact]
    public async Task NoSamplesRemainsUnknownAndSurvivesReopenWithoutChangingLegacyJobsLayout()
    {
        var runner = new ResourceRunner(async (request, emit, observe, ct) => { await Done(emit); observe(new ResourceMetrics { RequestId = request.RequestId, Operation = request.Operation }.Finish()); });
        var job = Job();
        await using (var hub = Hub(runner)) { hub.Enable(); await hub.Submit(job.Id, "scan"); }
        using var reopened = new HubRepository(Path.Combine(root, "hub.db")); reopened.Initialize();
        var final = Assert.Single(reopened.GetResourceSummaries(job.Id)); Assert.Equal("unknown", final.Quality); Assert.Null(final.PeakPrivateCommitBytes);
        using var db = new SqliteConnection($"Data Source={Path.Combine(root, "hub.db")};Pooling=False"); db.Open();
        using var command = db.CreateCommand(); command.CommandText = "SELECT count(*) FROM pragma_table_info('jobs')"; Assert.Equal(8L, command.ExecuteScalar());
    }

    [Fact]
    public async Task SequentialBatchesUseMaximumPeaksAndNextSubmitStartsFresh()
    {
        var job = Job();
        repo.UpsertItems(job.Id, [new() { Key = "x:1", Platform = "x", ContentId = "1", Selected = true }, new() { Key = "x:2", Platform = "x", ContentId = "2", Selected = true }]);
        var batch = 0;
        Action<ResourceMetrics>? prior = null; ResourceMetrics? priorMetrics = null;
        var runner = new ResourceRunner(async (r, emit, observe, ct) =>
        {
            batch++;
            prior?.Invoke(priorMetrics! with { PeakPrivateCommitBytes = 999999 });
            var next = new ResourceMetrics { RequestId = r.RequestId, Operation = r.Operation }.Add(new(true, batch == 1 ? 3 : 1, batch == 1 ? 300 : 100, batch == 1 ? 600 : 200)).Finish();
            observe(next); prior = observe; priorMetrics = next;
            await Done(emit);
        });
        await using var hub = new HubCoordinator(repo, runner, new() { DataRoot = root, DownloadRoot = root }, batchItems: 1);
        hub.Enable(); await hub.Submit(job.Id, "download");
        Assert.Equal(2, batch); Assert.Equal(300L, hub.Resources!.Metrics.PeakPrivateCommitBytes); Assert.Equal(600L, hub.Resources.Metrics.PeakWorkingSetBytes);
        Assert.Equal(2, hub.Resources.Metrics.SampleCount);
        var stored = repo.GetLatestResourceSummary(job.Id)!;
        Assert.Equal(300L, stored.PeakPrivateCommitBytes); Assert.Equal(2, stored.SampleCount);
        await hub.Submit(job.Id, "scan");
        Assert.Equal(100L, hub.Resources!.Metrics.PeakPrivateCommitBytes); Assert.Equal(1, hub.Resources.Metrics.SampleCount);
        Assert.Equal(100L, repo.GetLatestResourceSummary(job.Id)!.PeakPrivateCommitBytes);
        Assert.NotEqual(stored.OperationId, repo.GetLatestResourceSummary(job.Id)!.OperationId);
    }

    [Fact]
    public async Task ZeroWorkerBatchesDoNotReusePriorCurrentMetricsOrCreateNewSamples()
    {
        var calls = 0;
        var runner = new ResourceRunner(async (r, emit, observe, ct) => { calls++; observe(new ResourceMetrics { RequestId = r.RequestId, Operation = r.Operation }.Add(new(true, 1, 100, 200)).Finish()); await Done(emit); });
        await using var hub = Hub(runner); hub.Enable(); var job = Job();
        await hub.Submit(job.Id, "scan"); var previous = repo.GetLatestResourceSummary(job.Id)!;
        await hub.Submit(job.Id, "download");
        Assert.Equal(1, calls); Assert.Null(hub.Resources); Assert.Single(repo.GetResourceSummaries(job.Id));
        Assert.Equal(previous, repo.GetLatestResourceSummary(job.Id)); Assert.Equal("completed", repo.GetJob(job.Id)!.Status);
    }

    [Fact]
    public async Task ResourceWriteFailureDoesNotChangeSuccessfulMediaOutcome()
    {
        using var db = new SqliteConnection($"Data Source={Path.Combine(root, "hub.db")};Pooling=False"); db.Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='job_resources'";
        Assert.Equal(1L, command.ExecuteScalar());
        command.CommandText = "CREATE TRIGGER reject_resource BEFORE INSERT ON job_resources BEGIN SELECT RAISE(ABORT,'synthetic private error'); END"; command.ExecuteNonQuery();
        var runner = new ResourceRunner(async (r, emit, observe, ct) => { observe(new ResourceMetrics { RequestId = r.RequestId, Operation = r.Operation }.Add(new(true, 1, 10, 20)).Finish()); await Done(emit); });
        await using var hub = Hub(runner); hub.Enable(); var job = Job(); await hub.Submit(job.Id, "scan");
        Assert.Equal("completed", repo.GetJob(job.Id)!.Status); Assert.Null(hub.StorageWarning); Assert.True(hub.Enabled);
        Assert.Equal("资源记录未保存", hub.ResourceWarning); Assert.Empty(repo.GetResourceSummaries(job.Id));
    }

    sealed class ResourceRunner(Func<WorkerRequest, Func<WorkerEvent, Task>, Action<ResourceMetrics>, CancellationToken, Task> run) : IResourceWorkerRunner
    {
        public Task RunAsync(WorkerRequest request, Func<WorkerEvent, Task> emit, CancellationToken ct) => Done(emit);
        public Task RunWithResourcesAsync(WorkerRequest request, Func<WorkerEvent, Task> emit, Action<ResourceMetrics> observe, CancellationToken ct) => run(request, emit, observe, ct);
        public Task SendControlAsync(object value, CancellationToken ct = default) => Task.CompletedTask;
    }
}
