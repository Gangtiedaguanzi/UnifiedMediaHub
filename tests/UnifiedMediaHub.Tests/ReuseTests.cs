using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class ReuseTests : IDisposable
{
    readonly string root=Path.Combine(Path.GetTempPath(),"UMH-reuse",Guid.NewGuid().ToString("N"));
    readonly HubRepository repo;
    readonly string original;
    static readonly byte[] Bytes=[1,2,3,4];
    const string Digest="9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
    static ContentItem Item()=>new(){Key="x:123",Platform="x",ContentId="123",SourceUrl="https://x.com/a/status/123",MediaResolved=true,Media=[new(){Index=1,Kind="image",Extension="jpg"}]};
    public ReuseTests(){Directory.CreateDirectory(root);repo=new(Path.Combine(root,"hub.db"));repo.Initialize();original=Path.Combine(root,"x","item-123-"+new string('a',64),"media-001.jpg");Directory.CreateDirectory(Path.GetDirectoryName(original)!);File.WriteAllBytes(original,Bytes);var old=repo.CreateJob(Source(),root);repo.UpsertItems(old.Id,[Item()]);repo.RecordReceipt(old.Id,Receipt(original,"completed"));}
    static SourceRequest Source()=>new(){Platform="x",Kind="single",Url="https://x.com/a/status/123"};
    static DownloadReceipt Receipt(string file,string status)=>new(){ContentKey="x:123",MediaIndex=1,FilePath=file,Status=status,Bytes=4,Sha256=Digest};
    HubCoordinator Hub(FixtureRunner runner)=>new(repo,runner,new(){DataRoot=root,DownloadRoot=root,EngineRoot=root,BrowserExecutable=Path.Combine(root,"browser.exe")});
    [Fact]
    public async Task OldHashLayoutReceiptIsReusedWithoutWorkerDownload()
    {
        var job=repo.CreateJob(Source(),root);repo.UpsertItems(job.Id,[Item()]);var runner=new FixtureRunner();await using var hub=Hub(runner);hub.Enable();await hub.Submit(job.Id,"download");
        Assert.Empty(runner.Requests);var receipt=Assert.Single(repo.ListLatestReceipts(job.Id));Assert.Equal("skipped",receipt.Status);Assert.Equal(original,receipt.FilePath);Assert.Equal("completed",repo.GetJob(job.Id)!.Status);
    }
    [Fact]
    public async Task NewCategorySendsVerifiedReusePathAndDigestToWorker()
    {
        var job=repo.CreateJob(Source(),root,"风景");repo.UpsertItems(job.Id,[Item()]);
        var runner=new FixtureRunner(async(request,emit,_)=>{using var json=JsonDocument.Parse(JsonSerializer.Serialize(request,HubJson.Options));var asset=json.RootElement.GetProperty("items")[0].GetProperty("media")[0];Assert.Equal(original,asset.GetProperty("reuseFrom").GetString());Assert.Equal(Digest,asset.GetProperty("reuseSha256").GetString());Assert.Equal(4,asset.GetProperty("reuseBytes").GetInt64());await emit(new(){Type="receipt",Receipt=Receipt(original,"skipped")});await emit(new(){Type="complete",Status="completed",Completeness="unknown"});});
        await using var hub=Hub(runner);hub.Enable();await hub.Submit(job.Id,"download");Assert.Single(runner.Requests);Assert.Equal("completed",repo.GetJob(job.Id)!.Status);
    }
    [Fact]
    public async Task ReceiptOutsideNewRootDoesNotSkipOrIssueAnOutOfRootReuseHint()
    {
        var next=Path.Combine(root,"other-root");Directory.CreateDirectory(next);var job=repo.CreateJob(Source(),next);repo.UpsertItems(job.Id,[Item()]);
        var runner=new FixtureRunner(async(request,emit,_)=>{using var json=JsonDocument.Parse(JsonSerializer.Serialize(request,HubJson.Options));Assert.False(json.RootElement.GetProperty("items")[0].GetProperty("media")[0].TryGetProperty("reuseFrom",out var ignored));var file=Path.Combine(next,"result.jpg");File.WriteAllBytes(file,Bytes);await emit(new(){Type="receipt",Receipt=Receipt(file,"completed")});await emit(new(){Type="complete",Status="completed",Completeness="unknown"});});
        await using var hub=Hub(runner);hub.Enable();await hub.Submit(job.Id,"download");Assert.Single(runner.Requests);Assert.Equal("completed",repo.GetJob(job.Id)!.Status);
    }
    [Fact]
    public async Task WorkerItemCannotPersistHostReuseHints()
    {
        var job=repo.CreateJob(Source(),root);var item=Item();item.Media[0].ReuseFrom=original;item.Media[0].ReuseBytes=4;item.Media[0].ReuseSha256=Digest;
        var runner=new FixtureRunner(async(_,emit,_)=>{await emit(new(){Type="item",Item=item});await emit(new(){Type="complete",Status="completed",Completeness="partial"});});
        await using var hub=Hub(runner);hub.Enable();await hub.Submit(job.Id,"scan");var stored=Assert.Single(repo.ListItems(job.Id)).Media[0];Assert.Null(stored.ReuseFrom);Assert.Null(stored.ReuseSha256);Assert.Null(stored.ReuseBytes);
    }
    public void Dispose(){repo.Dispose();SqliteConnection.ClearAllPools();Directory.Delete(root,true);}
}
