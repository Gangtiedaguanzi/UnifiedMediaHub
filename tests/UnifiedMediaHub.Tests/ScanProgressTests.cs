using Microsoft.Data.Sqlite;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class ScanProgressTests : IDisposable
{
    readonly string root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "UMH-scan-progress", Guid.NewGuid().ToString("N")));
    readonly HubRepository repo;
    public ScanProgressTests() { Directory.CreateDirectory(root); repo = new(Path.Combine(root, "hub.db")); repo.Initialize(); }
    HubJob Job() => repo.CreateJob(new() { Platform = "x", Kind = "profile", Url = "https://x.com/synthetic" }, root);
    HubCoordinator Hub(IWorkerRunner runner) => new(repo, runner, new() { DataRoot = root, DownloadRoot = root });
    static ContentItem Item(string id) => new() { Key = "x:" + id, Platform = "x", ContentId = id, SourceUrl = "https://x.com/synthetic/status/" + id, Title = "synthetic-private-title" };
    SqliteConnection Database() { var db = new SqliteConnection($"Data Source={Path.Combine(root, "hub.db")};Pooling=False"); db.Open(); return db; }
    void AssertCheckpoint(string jobId, long committed, long? observed, string state)
    {
        using var db = Database(); using var query = db.CreateCommand();
        query.CommandText = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='scan_progress'";
        Assert.Equal(1L, query.ExecuteScalar());
        query.CommandText = "SELECT committed_unique_item_count,observed_current,total,observed_rounds,observed_pages,terminal_state FROM scan_progress WHERE job_id=$id ORDER BY rowid DESC LIMIT 1";
        query.Parameters.AddWithValue("$id", jobId); using var row = query.ExecuteReader(); Assert.True(row.Read());
        Assert.Equal(committed, row.GetInt64(0)); Assert.Equal(observed, row.IsDBNull(1) ? null : row.GetInt64(1));
        Assert.True(row.IsDBNull(2)); Assert.True(row.IsDBNull(3)); Assert.True(row.IsDBNull(4)); Assert.Equal(state, row.GetString(5));
    }

    [Fact]
    public async Task CompletedScanPersistsUniqueCommittedItemsSeparatelyFromObservedCount()
    {
        var job = Job(); repo.UpsertItems(job.Id, [Item("1"), Item("old")]);
        var runner = new FixtureRunner(async (request, emit, ct) =>
        {
            foreach (var id in new[] { "1", "1", "2" }) await emit(new() { Type = "item", RequestId = request.RequestId, Item = Item(id) });
            await emit(new() { Type = "progress", RequestId = request.RequestId, Phase = "scan", Current = 10, Message = "private-token https://private.invalid" });
            await emit(new() { Type = "complete", RequestId = request.RequestId, Status = "completed", Completeness = "partial" });
        });
        await using var hub = Hub(runner); hub.Enable(); await hub.Submit(job.Id, "scan");
        Assert.Equal(3, repo.ListItems(job.Id).Count); AssertCheckpoint(job.Id, 2, 10, "completed");
    }

    [Fact]
    public async Task PauseFlushesCommittedCheckpointAndReopenDoesNotRestart()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new FixtureRunner(async (request, emit, ct) =>
        {
            await emit(new() { Type = "item", RequestId = request.RequestId, Item = Item("1") });
            await emit(new() { Type = "progress", RequestId = request.RequestId, Phase = "scan", Current = 7 });
            entered.TrySetResult(); await Task.Delay(Timeout.Infinite, ct);
        });
        var job = Job();
        await using (var hub = Hub(runner))
        {
            hub.Enable(); var running = hub.Submit(job.Id, "scan"); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await hub.StopJobAsync(job.Id); await running;
        }
        AssertCheckpoint(job.Id, 1, 7, "paused");
        using var reopened = new HubRepository(Path.Combine(root, "hub.db")); reopened.Initialize();
        await using var idle = new HubCoordinator(reopened, runner, new() { DataRoot = root, DownloadRoot = root });
        Assert.False(idle.Enabled); Assert.Equal(0, idle.ActiveCount); Assert.Single(runner.Requests);
    }

    [Fact]
    public async Task ProgressIsThrottledAndCurrentMemoryIsDistinctFromDurableCheckpoint()
    {
        using var db=Database();using var command=db.CreateCommand();
        command.CommandText="CREATE TABLE write_audit(n INTEGER); CREATE TRIGGER progress_audit BEFORE INSERT ON scan_progress BEGIN INSERT INTO write_audit VALUES(1); END";command.ExecuteNonQuery();
        var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner=new FixtureRunner(async(r,emit,ct)=>{
            await emit(new(){Type="item",RequestId=r.RequestId,Item=Item("1")});
            await emit(new(){Type="item",RequestId=r.RequestId,Item=Item("2")});
            for(var i=0;i<100;i++)await emit(new(){Type="progress",RequestId=r.RequestId,Phase="scan",Current=i,Total=100,ObservedRounds=3,ObservedPages=2});
            entered.TrySetResult();await release.Task.WaitAsync(ct);await emit(new(){Type="complete",RequestId=r.RequestId,Status="completed",Completeness="partial"});
        });
        await using var hub=Hub(runner);hub.Enable();var job=Job();var running=hub.Submit(job.Id,"scan");await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2,hub.ScanProgress!.Current.CommittedUniqueItemCount);Assert.Equal(99,hub.ScanProgress.Current.ObservedCurrent);
        Assert.Equal(1,hub.ScanProgress.Persisted!.CommittedUniqueItemCount);Assert.Equal(1,repo.GetLatestScanProgress(job.Id)!.CommittedUniqueItemCount);
        release.TrySetResult();await running;
        var final=repo.GetLatestScanProgress(job.Id)!;Assert.Equal(2,final.CommittedUniqueItemCount);Assert.Equal(100,final.Total);Assert.Equal(3,final.ObservedRounds);Assert.Equal(2,final.ObservedPages);
        command.CommandText="SELECT count(*) FROM write_audit";Assert.Equal(3L,command.ExecuteScalar());
    }

    [Theory]
    [InlineData("foreign")][InlineData("phase")][InlineData("negative")][InlineData("overflow")][InlineData("total")][InlineData("rounds")][InlineData("pages")]
    public async Task InvalidProjectionDoesNotEnterStorageOrFailMedia(string mode)
    {
        var runner=new FixtureRunner(async(r,emit,ct)=>{
            await emit(new(){Type="progress",RequestId=r.RequestId,Phase="scan",Current=5});
            var e=new WorkerEvent{Type="progress",RequestId=r.RequestId,Phase="scan",Current=6,Message="private-token https://private.invalid"};
            if(mode=="foreign")e.RequestId="another-request";if(mode=="phase")e.Phase="https://private.invalid";if(mode=="negative")e.Current=-1;if(mode=="overflow")e.Current=1_000_000_001;if(mode=="total")e.Total=2;if(mode=="rounds")e.ObservedRounds=-1;if(mode=="pages")e.ObservedPages=1_000_000_001;
            await emit(e);await emit(new(){Type="complete",RequestId=r.RequestId,Status="completed",Completeness="partial"});
        });
        await using var hub=Hub(runner);hub.Enable();var job=Job();await hub.Submit(job.Id,"scan");
        AssertCheckpoint(job.Id,0,5,"completed");Assert.Equal("completed",repo.GetJob(job.Id)!.Status);
    }

    [Fact]
    public async Task FailedItemUpsertCannotIncreaseCommittedCount()
    {
        using var db=Database();using var command=db.CreateCommand();command.CommandText="CREATE TRIGGER reject_item BEFORE INSERT ON contents BEGIN SELECT RAISE(ABORT,'private failure'); END";command.ExecuteNonQuery();
        var runner=new FixtureRunner(async(r,emit,ct)=>await emit(new(){Type="item",RequestId=r.RequestId,Item=Item("1")}));
        await using var hub=Hub(runner);hub.Enable();var job=Job();await hub.Submit(job.Id,"scan");
        Assert.Empty(repo.ListItems(job.Id));AssertCheckpoint(job.Id,0,null,"failed");
    }

    [Fact]
    public async Task CheckpointWriteFailurePreservesLastDurableAndDoesNotClaimSaved()
    {
        using var db=Database();using var command=db.CreateCommand();command.CommandText="CREATE TRIGGER reject_progress_update BEFORE UPDATE ON scan_progress BEGIN SELECT RAISE(ABORT,'private failure'); END";command.ExecuteNonQuery();
        var runner=new FixtureRunner(async(r,emit,ct)=>{await emit(new(){Type="item",RequestId=r.RequestId,Item=Item("1")});await emit(new(){Type="complete",RequestId=r.RequestId,Status="completed",Completeness="partial"});});
        await using var hub=Hub(runner);hub.Enable();var job=Job();await hub.Submit(job.Id,"scan");
        Assert.Equal("completed",repo.GetJob(job.Id)!.Status);AssertCheckpoint(job.Id,0,null,"running");
        Assert.True(hub.ScanProgress!.SaveFailed);Assert.Equal(1,hub.ScanProgress.Current.CommittedUniqueItemCount);Assert.Equal(0,hub.ScanProgress.Persisted!.CommittedUniqueItemCount);Assert.NotNull(hub.ScanProgressWarning);Assert.Null(hub.StorageWarning);
    }

    [Fact]
    public async Task NewGenerationRejectsRetainedOldCallbackAndKeepsPreviousInventory()
    {
        Func<WorkerEvent,Task>? old=null;string? oldId=null;
        var runner=new FixtureRunner(async(r,emit,ct)=>{
            if(old!=null)await old(new(){Type="progress",RequestId=oldId!,Phase="scan",Current=999});
            await emit(new(){Type="item",RequestId=r.RequestId,Item=Item("1")});
            await emit(new(){Type="progress",RequestId=r.RequestId,Phase="scan",Current=2});
            old=emit;oldId=r.RequestId;await emit(new(){Type="complete",RequestId=r.RequestId,Status="completed",Completeness="partial"});
        });
        await using var hub=Hub(runner);hub.Enable();var job=Job();await hub.Submit(job.Id,"scan");var first=repo.GetLatestScanProgress(job.Id)!;
        repo.SetSelected(job.Id,"x:1",false);await hub.Submit(job.Id,"scan");var second=repo.GetLatestScanProgress(job.Id)!;
        Assert.NotEqual(first.Generation,second.Generation);Assert.NotEqual(first.RequestId,second.RequestId);Assert.False(Assert.Single(repo.ListItems(job.Id)).Selected);
        AssertCheckpoint(job.Id,1,2,"completed");await old!(new(){Type="progress",RequestId=oldId!,Phase="scan",Current=888});Assert.Equal(second,repo.GetLatestScanProgress(job.Id));
    }

    [Theory]
    [InlineData("needs_action")][InlineData("failed")]
    public async Task NonSuccessTerminalStatesFlushCheckpoint(string status)
    {
        var runner=new FixtureRunner(async(r,emit,ct)=>{
            await emit(new(){Type="item",RequestId=r.RequestId,Item=Item("1")});
            if(status=="needs_action")await emit(new(){Type="needs_action",RequestId=r.RequestId,Code="challenge",AwaitingInput=false});
            else await emit(new(){Type="error",RequestId=r.RequestId,Code="operation_failed"});
            await emit(new(){Type="complete",RequestId=r.RequestId,Status=status,Completeness="partial"});
        });
        await using var hub=Hub(runner);hub.Enable();var job=Job();await hub.Submit(job.Id,"scan");AssertCheckpoint(job.Id,1,null,status);
    }

    [Fact]
    public async Task ConstructorMarksRunningCheckpointInterruptedWithoutStartingWork()
    {
        var job=Job();var recorded=DateTimeOffset.UtcNow.AddHours(-1);repo.SaveScanProgress(new(){JobId=job.Id,Generation="synthetic-generation",RequestId="synthetic-request",CommittedUniqueItemCount=3,UpdatedAt=recorded});
        var runner=new FixtureRunner();await using var hub=Hub(runner);
        AssertCheckpoint(job.Id,3,null,"interrupted");Assert.False(hub.Enabled);Assert.Empty(runner.Requests);
        Assert.Equal(recorded,repo.GetLatestScanProgress(job.Id)!.UpdatedAt);
    }

    [Fact]
    public async Task SameGenerationCounterRegressionIsIgnoredAndMissingTotalStaysUnknown()
    {
        var runner=new FixtureRunner(async(r,emit,ct)=>{
            await emit(new(){Type="progress",RequestId=r.RequestId,Phase="scan",Current=5,Total=10,ObservedRounds=3,ObservedPages=2});
            await emit(new(){Type="progress",RequestId=r.RequestId,Phase="scan",Current=4,Total=10,ObservedRounds=3,ObservedPages=2});
            await emit(new(){Type="progress",RequestId=r.RequestId,Phase="scan",Current=6,Total=10,ObservedRounds=2,ObservedPages=2});
            await emit(new(){Type="progress",RequestId=r.RequestId,Phase="scan",Current=7,Total=10,ObservedRounds=3,ObservedPages=1});
            await emit(new(){Type="complete",RequestId=r.RequestId,Status="completed",Completeness="partial"});
        });
        await using var hub=Hub(runner);hub.Enable();var job=Job();await hub.Submit(job.Id,"scan");
        var stored=repo.GetLatestScanProgress(job.Id)!;Assert.Equal(5,stored.ObservedCurrent);Assert.Equal(3,stored.ObservedRounds);Assert.Equal(2,stored.ObservedPages);
        var updated=stored.Observe(new(){Phase="scan",Current=11});Assert.NotNull(updated);Assert.Null(updated.Total);
    }

    [Fact]
    public async Task ActualSqliteFullDuringCheckpointFlushStopsQueueAndRetainsDurableRow()
    {
        var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var proceed=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner=new FixtureRunner(async(r,emit,ct)=>{
            await emit(new(){Type="item",RequestId=r.RequestId,Item=Item("1")});entered.TrySetResult();await proceed.Task.WaitAsync(ct);
            await emit(new(){Type="needs_action",RequestId=r.RequestId,Code="challenge",AwaitingInput=true});ct.ThrowIfCancellationRequested();
        });
        await using var hub=Hub(runner);hub.Enable();var first=Job();var second=Job();var work=hub.Submit(first.Id,"scan");await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));var queued=hub.Submit(second.Id,"scan");
        var connection=(SqliteConnection)typeof(HubRepository).GetField("connection",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.GetValue(repo)!;
        using(var command=connection.CreateCommand())
        {
            command.CommandText="CREATE TABLE full_probe(data BLOB); CREATE TRIGGER fill_on_progress BEFORE UPDATE ON scan_progress BEGIN INSERT INTO full_probe VALUES(zeroblob(1048576)); END";command.ExecuteNonQuery();
            command.CommandText="PRAGMA page_count";var pages=command.ExecuteScalar();command.CommandText="PRAGMA max_page_count="+pages;command.ExecuteScalar();
        }
        proceed.TrySetResult();await Task.WhenAll(work,queued).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("disk_full",hub.StorageWarning);Assert.False(hub.Enabled);Assert.Single(runner.Requests);Assert.Single(repo.ListItems(first.Id));AssertCheckpoint(first.Id,1,null,"running");Assert.True(hub.ScanProgress!.SaveFailed);
    }

    [Fact]
    public async Task FirstSqliteFullAtCompletedFlushCannotLeaveCurrentStateCompleted()
    {
        var runner=new FixtureRunner(async(r,emit,ct)=>{
            await emit(new(){Type="item",RequestId=r.RequestId,Item=Item("1")});
            var connection=(SqliteConnection)typeof(HubRepository).GetField("connection",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.GetValue(repo)!;
            using(var command=connection.CreateCommand())
            {
                command.CommandText="CREATE TABLE final_full_probe(data BLOB); CREATE TRIGGER fill_at_final BEFORE UPDATE ON scan_progress WHEN NEW.terminal_state='completed' BEGIN INSERT INTO final_full_probe VALUES(zeroblob(1048576)); END";command.ExecuteNonQuery();
                command.CommandText="PRAGMA page_count";var pages=command.ExecuteScalar();command.CommandText="PRAGMA max_page_count="+pages;command.ExecuteScalar();
            }
            await emit(new(){Type="complete",RequestId=r.RequestId,Status="completed",Completeness="partial"});
        });
        await using var hub=Hub(runner);hub.Enable();var job=Job();await hub.Submit(job.Id,"scan").WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("disk_full",hub.StorageWarning);Assert.Equal("failed",repo.GetJob(job.Id)!.Status);
        Assert.Equal("failed",hub.ScanProgress!.Current.TerminalState);Assert.True(hub.ScanProgress.SaveFailed);
        AssertCheckpoint(job.Id,1,null,"running");Assert.Equal(0,hub.ActiveCount);
    }

    [Fact]
    public async Task FinalCheckpointDoesNotReadJobAgainOrStrandSubmitAndDisable()
    {
        using var db=Database();using var command=db.CreateCommand();
        command.CommandText="CREATE TRIGGER invalidate_job_read AFTER UPDATE OF status ON jobs WHEN NEW.status='completed' BEGIN UPDATE jobs SET source='{' WHERE id=NEW.id; END";command.ExecuteNonQuery();
        var runner=new FixtureRunner(async(r,emit,ct)=>await emit(new(){Type="complete",RequestId=r.RequestId,Status="completed",Completeness="partial"}));
        var hub=Hub(runner);hub.Enable();var job=Job();
        try
        {
            var submitted=hub.Submit(job.Id,"scan");
            Assert.Same(submitted,await Task.WhenAny(submitted,Task.Delay(1500)));
            await submitted;await hub.DisableAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(0,hub.ActiveCount);AssertCheckpoint(job.Id,0,null,"completed");
            Assert.Throws<System.Text.Json.JsonException>(()=>repo.GetJob(job.Id));
        }
        finally{try{await hub.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));}catch(System.Text.Json.JsonException){}}
    }

    public void Dispose()
    {
        repo.Dispose();
        var allowed = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "UMH-scan-progress"));
        if (!string.Equals(Path.GetDirectoryName(root), allowed, StringComparison.OrdinalIgnoreCase) || !Guid.TryParseExact(Path.GetFileName(root), "N", out _)) throw new IOException("Fixture deletion boundary failed.");
        if (!Directory.Exists(root)) return;
        for (var ancestor = new DirectoryInfo(root); ancestor != null; ancestor = ancestor.Parent)
            if ((ancestor.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Fixture ancestor is a link.");
        var pending = new Stack<string>(); pending.Push(root);
        while (pending.TryPop(out var directory)) foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Fixture descendant is a link.");
            if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
        }
        Directory.Delete(root, true);
    }
}
