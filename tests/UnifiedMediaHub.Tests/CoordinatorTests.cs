using System.Text.Json;
using System.Security.Cryptography;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class CoordinatorTests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "UMH-coordinator", Guid.NewGuid().ToString("N"));
    readonly HubRepository repo;
    public CoordinatorTests() { Directory.CreateDirectory(root); repo = new(Path.Combine(root, "hub.db")); repo.Initialize(); }
    public void Dispose() { repo.Dispose(); Directory.Delete(root, true); }
    HubJob Job(string kind = "profile", string platform = "x") => repo.CreateJob(new() { Platform = platform, Kind = kind, Url = "https://x.com/alice" }, root);
    static ContentItem Item(string id = "123") => new() { Key = "x:" + id, Platform = "x", ContentId = id, SourceUrl = "https://x.com/alice/status/" + id, MediaResolved = true, Media = [new() { Index = 1, Kind = "image" }, new() { Index = 2, Kind = "video" }] };
    HubCoordinator Make(FixtureRunner runner, int batchItems = 200) => new(repo, runner, new() { DataRoot = root, DownloadRoot = root, BrowserExecutable = Path.Combine(root,"browser.exe"), EngineRoot = root }, batchItems);
    static WorkerEvent Done(string status = "completed", string completeness = "partial") => new() { Type = "complete", Status = status, Completeness = completeness };

    [Theory]
    [InlineData("work_unavailable")]
    [InlineData("embedded_unsupported")]
    [InlineData("sensitive_content")]
    [InlineData("work_unresolved")]
    public async Task WorkReasonSurvivesWorkerFailureAsNeedsAction(string code)
    {
        var job=Job();var runner=new FixtureRunner(async(_,emit,_)=>{await emit(new(){Type="needs_action",Code=code});throw new Exception("fixture stopped");});
        await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"scan");
        Assert.Equal("needs_action",repo.GetJob(job.Id)!.Status);Assert.Equal(code,repo.GetJob(job.Id)!.ReasonCode);
    }

    [Theory]
    [InlineData("owned_temp_unconfirmed", "complete")]
    [InlineData("owned_temp_limit", "complete")]
    [InlineData("owned_temp_unconfirmed", "complete-then-exit")]
    [InlineData("owned_temp_limit", "complete-then-exit")]
    [InlineData("owned_temp_unconfirmed", "transport-before-complete")]
    [InlineData("owned_temp_limit", "transport-before-complete")]
    public async Task RecoveryFailureReasonSurvivesCompletionAndTransportFailure(string code,string ending)
    {
        var job=Job();
        var runner=new FixtureRunner(async (_,emit,_)=>{
            await emit(new(){Type="error",Code=code,Message="untrusted signed-secret"});
            if(ending!="transport-before-complete")await emit(Done("failed"));
            if(ending!="complete")throw new IOException("nonzero worker exit signed-secret");
        });
        await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"scan");
        var stored=repo.GetJob(job.Id)!;
        Assert.Equal("failed",stored.Status);
        Assert.Equal("有尚未确认归属的临时记录，已保留文件并停止操作。请检查程序私有目录 owned-temps 中的记录；不要直接删除媒体文件。",stored.Message);
        Assert.DoesNotContain("signed-secret",stored.Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnallowlistedErrorCannotPersistWorkerOrTransportText(bool throws)
    {
        var job=Job();
        var runner=new FixtureRunner(async (_,emit,_)=>{
            await emit(new(){Type="error",Code="owned_temp_unconfirmed-signed-secret",Message="untrusted signed-secret"});
            await emit(Done("failed"));if(throws)throw new IOException("signed-secret");
        });
        await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"scan");
        Assert.Equal("failed",repo.GetJob(job.Id)!.Status);
        Assert.DoesNotContain("signed-secret",repo.GetJob(job.Id)!.Message);
        Assert.DoesNotContain("owned-temps",repo.GetJob(job.Id)!.Message);
    }

    [Theory]
    [InlineData("completed", "missing")]
    [InlineData("skipped", "missing")]
    [InlineData("completed", "size")]
    [InlineData("skipped", "size")]
    [InlineData("completed", "emptyHash")]
    [InlineData("skipped", "emptyHash")]
    [InlineData("completed", "invalidHash")]
    [InlineData("skipped", "invalidHash")]
    [InlineData("completed", "wrongHash")]
    [InlineData("skipped", "wrongHash")]
    [InlineData("completed", "emptyFile")]
    [InlineData("skipped", "emptyFile")]
    [InlineData("completed", "directory")]
    [InlineData("skipped", "directory")]
    public async Task UnverifiedSuccessReceiptFailsWithoutRecordingSuccessOrChangingFiles(string status,string fault)
    {
        var job=Job();var item=Item();item.Media.RemoveAt(1);repo.UpsertItems(job.Id,[item]);
        var file=Path.Combine(root,"receipt.bin");byte[] original=fault=="emptyFile"?[]:[1,2,3,4];
        if(fault=="directory")Directory.CreateDirectory(file);
        else if(fault!="missing")File.WriteAllBytes(file,original);
        var hash=Convert.ToHexString(SHA256.HashData(original));
        hash=fault switch { "emptyHash"=>"", "invalidHash"=>new string('z',64), "wrongHash"=>Convert.ToHexString(SHA256.HashData(new byte[]{4,3,2,1})), _=>hash };
        var runner=new FixtureRunner(async(_,emit,_)=>{
            await emit(new(){Type="receipt",Receipt=new(){ContentKey=item.Key,MediaIndex=1,FilePath=file,Bytes=fault=="size"?5:original.Length,Sha256=hash,Status=status}});
            await emit(Done());
        });
        await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"download");
        Assert.Equal("failed",repo.GetJob(job.Id)!.Status);Assert.Empty(repo.ListReceipts(job.Id));
        if(fault=="directory")Assert.True(Directory.Exists(file));
        else if(fault=="missing")Assert.False(File.Exists(file));
        else Assert.Equal(original,File.ReadAllBytes(file));
    }

    [Theory]
    [InlineData("completed")]
    [InlineData("skipped")]
    public async Task VerifiedIncomingReceiptIsPersistedAndCompletes(string status)
    {
        var job=Job();var item=Item();item.Media.RemoveAt(1);repo.UpsertItems(job.Id,[item]);
        var file=Path.Combine(root,"receipt.bin");File.WriteAllBytes(file,[1,2,3,4]);
        var runner=new FixtureRunner(async(_,emit,_)=>{
            await emit(new(){Type="receipt",Receipt=new(){ContentKey=item.Key,MediaIndex=1,FilePath=file,Bytes=4,Sha256="9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",Status=status}});
            await emit(Done());
        });
        await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"download");
        Assert.Equal("completed",repo.GetJob(job.Id)!.Status);Assert.Equal(status,Assert.Single(repo.ListReceipts(job.Id)).Status);
    }

    [Fact]
    public async Task StopDuringIncomingReceiptVerificationPausesWithoutPublishingSuccess()
    {
        var job=Job();var item=Item();item.Media.RemoveAt(1);repo.UpsertItems(job.Id,[item]);
        var file=Path.Combine(root,"large-receipt.bin");const long length=128*1024*1024;
        using(var stream=File.Create(file))stream.SetLength(length);
        var entered=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner=new FixtureRunner(async(_,emit,_)=>{
            var accepting=emit(new(){Type="receipt",Receipt=new(){ContentKey=item.Key,MediaIndex=1,FilePath=file,Bytes=length,Sha256=new string('0',64),Status="completed"}});
            entered.SetResult(accepting.IsCompleted);
            await accepting;await emit(Done());
        });
        await using var hub=Make(runner);hub.Enable();var work=hub.Submit(job.Id,"download");
        var finishedBeforeStop=await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await hub.DisableAsync();await work;
        Assert.False(finishedBeforeStop);Assert.Equal("paused",repo.GetJob(job.Id)!.Status);Assert.Empty(repo.ListReceipts(job.Id));Assert.Equal(length,new FileInfo(file).Length);
    }

    [Fact]
    public async Task DisabledAndReopenedNeverStartWork()
    {
        var runner = new FixtureRunner(); var job = Job();
        await using (var hub = Make(runner)) { Assert.False(hub.Enabled); await Assert.ThrowsAsync<InvalidOperationException>(async () => await hub.Submit(job.Id, "scan")); hub.Enable(); await hub.Submit(job.Id, "scan"); }
        await using (var hub = Make(runner)) { Assert.False(hub.Enabled); Assert.Single(runner.Requests); }
    }

    [Fact]
    public async Task ExplicitQueueSerializesAndOffPausesPendingWithoutStartingNext()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new FixtureRunner(async (_, _, ct) => { entered.SetResult(); await Task.Delay(Timeout.Infinite, ct); });
        await using var hub = Make(runner); hub.Enable(); var a = Job(); var b = Job();
        var first = hub.Submit(a.Id,"scan"); await entered.Task; var second = hub.Submit(b.Id,"scan");
        Assert.Single(runner.Requests); Assert.Equal(1, hub.PendingCount);
        await hub.DisableAsync(); await Task.WhenAll(first,second);
        Assert.Equal("paused", repo.GetJob(a.Id)!.Status); Assert.Equal("paused", repo.GetJob(b.Id)!.Status);
        hub.Enable(); await Task.Delay(30); Assert.Single(runner.Requests);
    }

    [Fact]
    public async Task QueueAdvancesOnlyAlreadySubmittedWorkWhileEnabled()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new FixtureRunner(async (_, emit, ct) => { entered.TrySetResult(); await release.Task.WaitAsync(ct); await emit(Done()); });
        await using var hub = Make(runner); hub.Enable(); var a = hub.Submit(Job().Id,"scan"); await entered.Task; var b = hub.Submit(Job().Id,"scan");
        Assert.Single(runner.Requests); release.SetResult(); await Task.WhenAll(a,b); Assert.Equal(2, runner.Requests.Count); Assert.Equal(1,runner.Peak);
    }

    [Fact]
    public async Task PlatformStopPreservesOtherQueuedPlatform()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new FixtureRunner(async (r, emit, ct) => { if(r.Source.Platform=="x") { entered.SetResult(); await Task.Delay(Timeout.Infinite,ct); } await emit(Done()); });
        await using var hub = Make(runner); hub.Enable(); var a=Job(); var b=Job(platform:"douyin");
        var first=hub.Submit(a.Id,"scan"); await entered.Task; var second=hub.Submit(b.Id,"scan"); await hub.StopPlatformAsync("x"); await Task.WhenAll(first,second);
        Assert.Equal("paused",repo.GetJob(a.Id)!.Status); Assert.Equal("completed",repo.GetJob(b.Id)!.Status);
    }

    [Fact]
    public async Task SelectedOnlyResumeMasksVerifiedAssetsAndPreservesCanonicalDetail()
    {
        var job=Job(); repo.UpsertItems(job.Id,[Item(),Item("456")]); repo.SetSelected(job.Id,"x:456",false); repo.UpdateJob(job.Id,"ready",completeness:"partial");
        var path=Path.Combine(root,"existing.jpg"); File.WriteAllBytes(path,[1,2,3]); repo.RecordReceipt(job.Id,new(){ContentKey="x:123",MediaIndex=1,FilePath=path,Bytes=3,Sha256=Convert.ToHexString(SHA256.HashData([1,2,3])),Status="completed"});
        var runner = new FixtureRunner(async (r, emit, _) => { var item=Assert.Single(r.Items!); Assert.Equal("x:123",item.Key); Assert.Equal(2,Assert.Single(item.Media).Index);var file=Path.Combine(root,"new.mp4");File.WriteAllBytes(file,[1,2,3,4]); await emit(new(){Type="receipt",Receipt=new(){ContentKey=item.Key,MediaIndex=2,FilePath=file,Bytes=4,Sha256="9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",Status="completed"}}); await emit(Done(completeness:"complete")); });
        await using var hub=Make(runner); hub.Enable(); await hub.Submit(job.Id,"download");
        Assert.Equal(2,repo.ListItems(job.Id).First(i=>i.Key=="x:123").Media.Count); Assert.Equal("partial",repo.GetJob(job.Id)!.Completeness);
        Assert.Contains(repo.ListReceipts(job.Id),r=>r.Status=="skipped" && r.FilePath==path); Assert.Contains(repo.ListReceipts(job.Id),r=>r.MediaIndex==2);
    }

    [Fact]
    public async Task FullyVerifiedSelectionRequiresNoTransfer()
    {
        var job=Job(); var item=Item(); item.Media.RemoveAt(1); repo.UpsertItems(job.Id,[item]); var path=Path.Combine(root,"existing.jpg"); File.WriteAllBytes(path,[1]);
        repo.RecordReceipt(job.Id,new(){ContentKey=item.Key,MediaIndex=1,FilePath=path,Bytes=1,Sha256=Convert.ToHexString(SHA256.HashData([1])),Status="completed"});
        var runner=new FixtureRunner(); await using var hub=Make(runner); hub.Enable(); await hub.Submit(job.Id,"download"); Assert.Empty(runner.Requests);
    }

    [Fact]
    public async Task BatchesAreBoundedAndEarlierFailureCannotBecomeSuccess()
    {
        var job=Job(); repo.UpsertItems(job.Id,Enumerable.Range(1,5).Select(i=>Item(i.ToString())));
        var runner=new FixtureRunner(async (r,emit,_)=> { Assert.True(JsonSerializer.SerializeToUtf8Bytes(r,HubJson.Options).Length<=8*1024*1024); await emit(new(){Type="receipt",Receipt=new(){ContentKey=r.Items![0].Key,MediaIndex=1,Status="failed"}}); await emit(Done()); });
        await using var hub=Make(runner,2); hub.Enable(); await hub.Submit(job.Id,"download"); Assert.Equal(3,runner.Requests.Count); Assert.All(runner.Requests,r=>Assert.InRange(r.Items!.Count,1,2)); Assert.Equal("failed",repo.GetJob(job.Id)!.Status);
    }

    [Fact]
    public async Task ChangedAccountResumeIsNeedsActionWithoutAcceptingTransfer()
    {
        var job=Job("saved"); repo.BindAccount(job.Id,"first"); repo.UpsertItems(job.Id,[Item()]);
        var runner=new FixtureRunner(async (_,emit,_)=> { await emit(new(){Type="account",Platform="x",Authenticated=true,AccountId="other"}); throw new Exception("Should stop at account mismatch"); });
        await using var hub=Make(runner); hub.Enable(); await hub.Submit(job.Id,"download");
        Assert.Equal("needs_action",repo.GetJob(job.Id)!.Status); Assert.Equal("first",repo.GetJob(job.Id)!.Source.AccountId); Assert.Empty(repo.ListReceipts(job.Id));
    }

    [Fact]
    public async Task ScanBindsAccountBeforePrivateItemsAndPersistsAuthorSeparately()
    {
        var job=Job("saved"); var runner=new FixtureRunner(async (_,emit,_)=> { await emit(new(){Type="account",Platform="x",Authenticated=true,AccountId="login"}); var item=Item(); item.Author="Display name"; item.AuthorUrl="https://x.com/actualAuthor"; await emit(new(){Type="item",Item=item}); await emit(Done()); });
        await using(var hub=Make(runner)){hub.Enable(); await hub.Submit(job.Id,"scan");}
        repo.UpsertItems(job.Id,[new(){Platform="x",ContentId="123"}]);
        using var reopened=new HubRepository(Path.Combine(root,"hub.db")); reopened.Initialize(); Assert.Equal("login",reopened.GetJob(job.Id)!.Source.AccountId); Assert.Equal("https://x.com/actualAuthor",Assert.Single(reopened.ListItems(job.Id)).AuthorUrl);
        Assert.False(reopened.BindAccount(job.Id,"different"));
    }

    [Fact]
    public async Task LateCompletionCannotOverwritePauseOrLaunchAnotherBatch()
    {
        var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner=new FixtureRunner(async (_,emit,_)=>{ entered.SetResult(); await release.Task; await emit(Done()); }); var job=Job(); repo.UpsertItems(job.Id,[Item("1"),Item("2")]);
        await using var hub=Make(runner,1); hub.Enable(); var task=hub.Submit(job.Id,"download"); await entered.Task; var stop=hub.DisableAsync(); release.SetResult(); await stop; await task;
        Assert.Single(runner.Requests); Assert.Equal("paused",repo.GetJob(job.Id)!.Status);
    }

    [Fact]
    public async Task MissingCompletionAndForeignReceiptsFailClosed()
    {
        var job=Job(); repo.UpsertItems(job.Id,[Item()]); var runner=new FixtureRunner(async (_,emit,_)=> await emit(new(){Type="receipt",Receipt=new(){ContentKey="x:foreign",MediaIndex=1,Status="completed",FilePath="C:\\other",Bytes=1}}));
        await using var hub=Make(runner); hub.Enable(); await hub.Submit(job.Id,"download"); Assert.Equal("failed",repo.GetJob(job.Id)!.Status); Assert.Empty(repo.ListReceipts(job.Id));
    }

    [Fact]
    public async Task EqualLengthCorruptionCannotJustifySkippingSelectedAsset()
    {
        var job=Job();var item=Item();item.Media.RemoveAt(1);repo.UpsertItems(job.Id,[item]);var path=Path.Combine(root,"corrupted.png");File.WriteAllBytes(path,[9,8,7]);
        repo.RecordReceipt(job.Id,new(){ContentKey=item.Key,MediaIndex=1,FilePath=path,Bytes=3,Sha256=Convert.ToHexString(SHA256.HashData([1,2,3])),Status="completed"});
        var runner=new FixtureRunner();await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"download");
        Assert.Equal(1,Assert.Single(Assert.Single(runner.Requests).Items!).Media[0].Index);Assert.DoesNotContain(repo.ListReceipts(job.Id),r=>r.Status=="skipped");
    }
    [Fact]
    public async Task InterruptedScanKeepsDiscoveredItemsAndPartialScope()
    {
        var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner=new FixtureRunner(async(_,emit,ct)=>{await emit(new(){Type="item",Item=Item()});entered.SetResult();await Task.Delay(Timeout.Infinite,ct);});
        var job=Job();await using var hub=Make(runner);hub.Enable();var task=hub.Submit(job.Id,"scan");await entered.Task;await hub.DisableAsync();await task;
        Assert.Single(repo.ListItems(job.Id));Assert.Equal("partial",repo.GetJob(job.Id)!.Completeness);Assert.Equal("paused",repo.GetJob(job.Id)!.Status);
    }
    [Fact]
    public async Task CompletionWithoutSelectedMediaReceiptsCannotClaimSuccess()
    {
        var job=Job();repo.UpsertItems(job.Id,[Item()]);await using var hub=Make(new FixtureRunner());hub.Enable();await hub.Submit(job.Id,"download");
        Assert.Equal("failed",repo.GetJob(job.Id)!.Status);Assert.Equal(2,repo.ListReceipts(job.Id).Count(r=>r.Status=="failed"));
    }
    [Fact]
    public async Task Utf8SizeBoundSplitsLargeValidCardsBeforeItemCountLimit()
    {
        var job=Job();repo.UpsertItems(job.Id,Enumerable.Range(1,180).Select(i=>{var item=Item(i.ToString());item.Title=new string('z',50000);return item;}));
        var runner=new FixtureRunner();await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"download");
        Assert.True(runner.Requests.Count>1);Assert.All(runner.Requests,r=>Assert.InRange(JsonSerializer.SerializeToUtf8Bytes(r,HubJson.Options).Length,1,8*1024*1024));Assert.Equal(180,runner.Requests.Sum(r=>r.Items!.Count));
    }
    [Fact]
    public void LatestAssetResultChangesAfterRetryWithoutDeletingPriorEvidence()
    {
        var job=Job();repo.RecordReceipt(job.Id,new(){ContentKey="x:123",MediaIndex=1,Status="failed"});repo.RecordReceipt(job.Id,new(){ContentKey="x:123",MediaIndex=1,FilePath=Path.Combine(root,"result.png"),Bytes=3,Status="completed"});
        Assert.Equal(2,repo.ListReceipts(job.Id).Count);Assert.Equal("completed",Assert.Single(repo.ListLatestReceipts(job.Id)).Status);
        repo.RecordReceipt(job.Id,new(){ContentKey="x:123",MediaIndex=1,Status="failed",ErrorCode="file_conflict"});Assert.Equal("failed",Assert.Single(repo.ListLatestReceipts(job.Id)).Status);
    }
}

internal sealed class FixtureRunner(Func<WorkerRequest,Func<WorkerEvent,Task>,CancellationToken,Task>? behavior=null) : IWorkerRunner
{
    public List<WorkerRequest> Requests {get;}=[]; public int Peak; int running;
    public async Task RunAsync(WorkerRequest request,Func<WorkerEvent,Task> emit,CancellationToken ct)
    { Requests.Add(request); Peak=Math.Max(Peak,Interlocked.Increment(ref running)); try { if(behavior!=null) await behavior(request,emit,ct); else await emit(new(){Type="complete",Status="completed",Completeness="partial"}); } finally {Interlocked.Decrement(ref running);} }
    public Task SendControlAsync(object control,CancellationToken ct=default)=>Task.CompletedTask;
}
