using System.Text.Json;
using Microsoft.Data.Sqlite;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;
public sealed class CategoryTests : IDisposable
{
    readonly string root=Path.Combine(Path.GetTempPath(),"UMH-category",Guid.NewGuid().ToString("N"));
    string Database=>Path.Combine(root,"hub.db");
    HubRepository Open(){Directory.CreateDirectory(root);var repo=new HubRepository(Database);repo.Initialize();return repo;}
    HubJob Create(HubRepository repo,string category)=>repo.CreateJob(new SourceRequest{Platform="x",Kind="single",Url="https://x.com/a/status/1"},root,category);
    static string Value(HubJob job)=>job.Category;
    [Fact]
    public void CategoryIsPersistedAcrossReopenAndLegacyJobsDefaultToEmpty()
    {
        string id;
        using(var repo=Open()){var job=Create(repo,"风景😀");id=job.Id;Assert.Equal("风景😀",Value(job));Assert.Equal("",Value(repo.CreateJob(new(),root)));}
        using(var repo=Open()){Assert.Equal("风景😀",Value(repo.GetJob(id)!));Assert.Equal("风景😀",Value(repo.ListJobs().Single(j=>j.Id==id)));}
    }
    [Theory]
    [InlineData("a\\b")][InlineData("a/b")][InlineData("..")][InlineData("CON")][InlineData("x:y")][InlineData("x.")][InlineData(" space")]
    public void InvalidCategoryIsRejectedBeforeCreatingAJob(string category)
    {using var repo=Open();Assert.Throws<ArgumentException>(()=>Create(repo,category));Assert.Empty(repo.ListJobs());}
    [Fact]
    public void CategoryLimitCountsUnicodeCodePoints()
    {
        using var repo=Open();Assert.Equal(string.Concat(Enumerable.Repeat("😀",40)),Value(Create(repo,string.Concat(Enumerable.Repeat("😀",40)))));
        Assert.Throws<ArgumentException>(()=>Create(repo,string.Concat(Enumerable.Repeat("😀",41))));
    }
    [Fact]
    public async Task CoordinatorSendsPersistentCategoryInWorkerPaths()
    {
        using var repo=Open();var job=Create(repo,"风景");
        var runner=new FixtureRunner(async(request,emit,_)=>{using var json=JsonDocument.Parse(JsonSerializer.Serialize(request,HubJson.Options));Assert.Equal("风景",json.RootElement.GetProperty("paths").GetProperty("category").GetString());await emit(new(){Type="complete",Status="completed",Completeness="partial"});});
        await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root,EngineRoot=root,BrowserExecutable=Path.Combine(root,"browser.exe")});hub.Enable();await hub.Submit(job.Id,"scan");Assert.Equal("completed",repo.GetJob(job.Id)!.Status);
    }
    public void Dispose(){SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
}
