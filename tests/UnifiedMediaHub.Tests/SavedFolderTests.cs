using System.Text.Json;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class SavedFolderTests : IDisposable
{
    readonly string root=Path.Combine(Path.GetTempPath(),"UMH-folders",Guid.NewGuid().ToString("N"));
    readonly HubRepository repo;
    public SavedFolderTests(){Directory.CreateDirectory(root);repo=new(Path.Combine(root,"hub.db"));repo.Initialize();}
    public void Dispose(){repo.Dispose();Directory.Delete(root,true);}
    SourceRequest DirectorySource()=>new(){Platform="douyin",Kind="saved_folders",AccountId="owner",Url="https://www.douyin.com/user/owner",MaxItems=50};
    HubCoordinator Make(FixtureRunner runner)=>new(repo,runner,new(){DataRoot=root,DownloadRoot=root,BrowserExecutable=Path.Combine(root,"browser.exe"),EngineRoot=root});
    static WorkerEvent Account(string id="owner")=>new(){Type="account",Platform="douyin",Authenticated=true,AccountId=id};
    static WorkerEvent FolderJson(string id="folder_1",string title="PRIVATE_FOLDER_TITLE")=>JsonSerializer.Deserialize<WorkerEvent>(JsonSerializer.Serialize(new{type="folder",folder=new{id,title,itemCount=(long?)null}}),HubJson.Options)!;
    static WorkerEvent Done()=>new(){Type="complete",Status="completed",Completeness="partial",ReasonCode="history_unproven"};

    [Fact]
    public async Task VerifiedDirectoryPublishesMetadataWithoutScanningItems()
    {
        var job=repo.CreateJob(DirectorySource(),root);var seen=new List<WorkerEvent>();
        var runner=new FixtureRunner(async(_,emit,_)=>{await emit(Account());await emit(FolderJson());await emit(Done());});
        await using var hub=Make(runner);hub.Message+=(_,e)=>seen.Add(e);hub.Enable();await hub.Submit(job.Id,"listFolders");
        Assert.Equal("completed",repo.GetJob(job.Id)!.Status);Assert.Single(seen,e=>e.Type=="folder");Assert.Empty(repo.ListItems(job.Id));Assert.Single(runner.Requests);
        Assert.Equal("PRIVATE_FOLDER_TITLE",Assert.Single(repo.GetFolders(job.Id)).Title);
        Assert.Equal("partial",repo.GetJob(job.Id)!.Completeness);
        Assert.DoesNotContain("PRIVATE_FOLDER_TITLE",SanitizedReport.Create(repo));
    }

    [Theory]
    [InlineData("unverified")]
    [InlineData("wrong-account")]
    [InlineData("item")]
    [InlineData("receipt")]
    [InlineData("foreign-payload")]
    [InlineData("no-account-complete")]
    public async Task InvalidDirectoryEventsCannotPublishMediaOrFolders(string mode)
    {
        var job=repo.CreateJob(DirectorySource(),root);var seen=new List<WorkerEvent>();
        var runner=new FixtureRunner(async(_,emit,_)=>{
            if(mode=="wrong-account")await emit(Account("other"));
            else if(mode is not ("unverified" or "no-account-complete"))await emit(Account());
            if(mode=="item")await emit(new(){Type="item",Item=new(){Platform="douyin",ContentId="123",Key="douyin:123"}});
            else if(mode=="receipt")await emit(new(){Type="receipt",Receipt=new(){ContentKey="douyin:123",MediaIndex=1,Status="failed"}});
            else if(mode=="foreign-payload")await emit(new(){Type="status",Folder=new(){Id="1",Title="private"}});
            else if(mode!="no-account-complete")await emit(FolderJson());
            await emit(Done());
        });
        await using var hub=Make(runner);hub.Message+=(_,e)=>seen.Add(e);hub.Enable();await hub.Submit(job.Id,"listFolders");
        Assert.NotEqual("completed",repo.GetJob(job.Id)!.Status);Assert.Empty(repo.GetFolders(job.Id));Assert.Empty(repo.ListItems(job.Id));Assert.Empty(repo.ListReceipts(job.Id));Assert.DoesNotContain(seen,e=>e.Type=="folder");
    }

    [Theory]
    [InlineData("scan")]
    [InlineData("download")]
    public async Task DirectoryCannotFallBackToWholeCollection(string operation)
    {
        var job=repo.CreateJob(DirectorySource(),root);var runner=new FixtureRunner();await using var hub=Make(runner);hub.Enable();
        await Assert.ThrowsAsync<ArgumentException>(()=>hub.Submit(job.Id,operation));Assert.Empty(runner.Requests);
    }

    [Theory]
    [InlineData("x","saved_folders","owner",null)]
    [InlineData("douyin","saved","owner",null)]
    [InlineData("douyin","saved_folders",null,null)]
    [InlineData("xiaohongshu","saved_folders","owner","accidental-folder")]
    public async Task InvalidDirectoryIntentDoesNotStartWorker(string platform,string kind,string? account,string? folder)
    {
        var source=DirectorySource();source.Platform=platform;source.Kind=kind;source.AccountId=account;source.FolderId=folder;
        var job=repo.CreateJob(source,root);var runner=new FixtureRunner();await using var hub=Make(runner);hub.Enable();
        await Assert.ThrowsAsync<ArgumentException>(()=>hub.Submit(job.Id,"listFolders"));Assert.Empty(runner.Requests);
    }

    [Theory]
    [InlineData("", "name",null)]
    [InlineData("bad/id", "name",null)]
    [InlineData("非ASCII", "name",null)]
    [InlineData("id", " ",null)]
    [InlineData("id", "line\nline",null)]
    [InlineData("id", "name",-1L)]
    [InlineData("id", "name",9007199254740992L)]
    public void InvalidFolderMetadataCannotBePersisted(string id,string title,long? count)
    {
        var job=repo.CreateJob(DirectorySource(),root);
        Assert.Throws<InvalidDataException>(()=>repo.UpsertFolder(job.Id,new(){Id=id,Title=title,ItemCount=count}));Assert.Empty(repo.GetFolders(job.Id));
    }

    [Fact]
    public void FolderBoundsAndReopenPreserveIdsRatherThanNames()
    {
        var source=DirectorySource();var job=repo.CreateJob(source,root);
        repo.UpsertFolder(job.Id,new(){Id="first",Title="same",ItemCount=null});repo.UpsertFolder(job.Id,new(){Id="second",Title="same",ItemCount=0});repo.UpsertFolder(job.Id,new(){Id="first",Title="renamed",ItemCount=9007199254740991L});
        Assert.Throws<InvalidDataException>(()=>repo.UpsertFolder(job.Id,new(){Id=new string('a',129),Title="valid"}));
        Assert.Throws<InvalidDataException>(()=>repo.UpsertFolder(job.Id,new(){Id="id",Title=new string('a',257)}));
        using var reopened=new HubRepository(Path.Combine(root,"hub.db"));reopened.Initialize();var entries=reopened.GetFolders(job.Id);
        Assert.Equal(2,entries.Count);Assert.Equal("renamed",entries.Single(f=>f.Id=="first").Title);Assert.Equal(0,entries.Single(f=>f.Id=="second").ItemCount);
        var selected=SavedFolders.Select(reopened.GetJob(job.Id)!.Source,entries[0]);
        Assert.Equal("saved_folder",selected.Kind);Assert.Equal("first",selected.FolderId);Assert.Equal(source.AccountId,selected.AccountId);Assert.Equal(source.Url,selected.Url);Assert.Equal(50,selected.MaxItems);
        var scan=repo.CreateJob(selected,root);Assert.Equal("first",repo.GetJob(scan.Id)!.Source.FolderId);Assert.DoesNotContain("renamed",SanitizedReport.Create(repo));
    }

    [Fact]
    public void PickerRejectsPreviousAttemptAndOtherAccountAndNeverSelectsByTitle()
    {
        var source=DirectorySource();var picker=new SavedFolderPicker();picker.Begin("new",source);
        var first=new WorkerFolder{Id="one",Title="same"};
        Assert.False(picker.Accept("old",source,"douyin","owner",first));Assert.False(picker.Accept("new",source,"douyin","other",first));Assert.False(picker.Accept("new",source,"xiaohongshu","owner",first));
        Assert.Throws<InvalidOperationException>(()=>picker.Select(null,"douyin","owner"));
        Assert.True(picker.Accept("new",source,"douyin","owner",first));Assert.True(picker.Accept("new",source,"douyin","owner",new(){Id="two",Title="same"}));
        first.Id="mutated";Assert.Equal("one",picker.Select("one","douyin","owner").FolderId);Assert.Equal("two",picker.Select("two","douyin","owner",2).FolderId);
        Assert.Throws<InvalidOperationException>(()=>picker.Select("one","douyin","other"));picker.Clear();Assert.Empty(picker.Folders);Assert.Throws<InvalidOperationException>(()=>picker.Select("one","douyin","owner"));
    }

    [Theory]
    [InlineData(2,2,"completed")]
    [InlineData(0,50,"completed")]
    [InlineData(500,50,"completed")]
    [InlineData(2,2,"needs_action")]
    public async Task DirectoryUniqueLimitIsBoundedAndCannotClaimComplete(int requested,int expected,string status)
    {
        var source=DirectorySource();source.MaxItems=requested;var job=repo.CreateJob(source,root);
        var runner=new FixtureRunner(async(_,emit,_)=>{await emit(Account());for(var i=0;i<expected;i++)await emit(FolderJson(i.ToString()));await emit(FolderJson("0","renamed"));await emit(new(){Type="complete",Status=status,Completeness=status=="completed"?"complete":"partial",ReasonCode=status=="needs_action"?"folder_unverified":null});});
        await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"listFolders");
        Assert.Equal(expected,repo.GetFolders(job.Id).Count);Assert.Equal("renamed",repo.GetFolders(job.Id)[0].Title);Assert.Equal("partial",repo.GetJob(job.Id)!.Completeness);Assert.Equal(status=="needs_action"?"folder_unverified":"item_limit",repo.GetJob(job.Id)!.ReasonCode);
        Assert.Throws<InvalidDataException>(()=>repo.UpsertFolder(job.Id,new(){Id="overflow",Title="one too many"}));
    }

    [Fact]
    public async Task CancelledDirectoryKeepsAcceptedMetadataAndStartsNoChildScan()
    {
        var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var job=repo.CreateJob(DirectorySource(),root);
        var runner=new FixtureRunner(async(_,emit,ct)=>{await emit(Account());await emit(FolderJson());entered.SetResult();await Task.Delay(Timeout.Infinite,ct);});
        await using var hub=Make(runner);hub.Enable();var task=hub.Submit(job.Id,"listFolders");await entered.Task;await hub.DisableAsync();await task;
        Assert.Single(repo.GetFolders(job.Id));Assert.Equal("paused",repo.GetJob(job.Id)!.Status);Assert.Equal(0,hub.ActiveCount);Assert.Single(runner.Requests);
    }

    [Fact]
    public async Task FolderEventOnRegularScanIsRejected()
    {
        var source=DirectorySource();source.Kind="saved";var job=repo.CreateJob(source,root);
        var runner=new FixtureRunner(async(_,emit,_)=>{await emit(Account());await emit(FolderJson());await emit(Done());});
        await using var hub=Make(runner);hub.Enable();await hub.Submit(job.Id,"scan");Assert.Equal("failed",repo.GetJob(job.Id)!.Status);Assert.Empty(repo.GetFolders(job.Id));
    }
}
