using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class ChatDirectoryTests : IDisposable
{
    readonly string root=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"UMH-chat-directory",Guid.NewGuid().ToString("N")));
    readonly HubRepository repo;
    public ChatDirectoryTests(){Directory.CreateDirectory(root);repo=new(Path.Combine(root,"hub.db"));repo.Initialize();}
    [Theory]
    [InlineData("partial")]
    [InlineData("complete")]
    public async Task DirectoryPersistsItsOwnCompleteness(string completeness)
    {
        var runner=new FixtureRunner(async(r,emit,ct)=>{await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId="123"});await emit(new(){Type="chat",Chat=new(){Id="channel_123",Title="synthetic"}});await emit(new(){Type="complete",Status="completed",Completeness=completeness});});
        await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Enable();
        var job=repo.CreateJob(new(){Platform="telegram",Kind="chat",Url="https://t.me/",AccountId="123",MaxItems=50},root);
        await hub.Submit(job.Id,"listChats");Assert.Equal("completed",repo.GetJob(job.Id)!.Status);Assert.Equal(completeness,repo.GetJob(job.Id)!.Completeness);
    }
    [Fact]
    public async Task DirectoryCannotPublishChatsBeforeBoundAccount()
    {
        var published=0;var runner=new FixtureRunner(async(r,emit,ct)=>{await emit(new(){Type="chat",Chat=new(){Id="channel_123",Title="synthetic"}});await emit(new(){Type="complete",Status="completed",Completeness="partial"});});
        await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Message+=(_,e)=>{if(e.Type=="chat")published++;};hub.Enable();
        var job=repo.CreateJob(new(){Platform="telegram",Kind="chat",Url="https://t.me/",AccountId="123",MaxItems=50},root);
        await hub.Submit(job.Id,"listChats");Assert.Equal(0,published);Assert.Equal("needs_action",repo.GetJob(job.Id)!.Status);
    }
    [Fact]
    public async Task DirectoryHostRejectsOversizedRowsBeforeUiPublication()
    {
        var published=0;var runner=new FixtureRunner(async(r,emit,ct)=>{await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId="123"});for(var i=1;i<=51;i++)await emit(new(){Type="chat",Chat=new(){Id="channel_"+i,Title="synthetic"}});await emit(new(){Type="complete",Status="completed",Completeness="partial"});});
        await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Message+=(_,e)=>{if(e.Type=="chat")published++;};hub.Enable();
        var job=repo.CreateJob(new(){Platform="telegram",Kind="chat",Url="https://t.me/",AccountId="123",MaxItems=50},root);
        await hub.Submit(job.Id,"listChats");Assert.Equal(50,published);Assert.Equal("failed",repo.GetJob(job.Id)!.Status);
    }
    [Theory][InlineData("account")][InlineData("item")][InlineData("no_account_complete")]
    public async Task InvalidDirectoryNeverPublishesMediaOrSucceeds(string variant)
    {
        var published=0;var runner=new FixtureRunner(async(r,emit,ct)=>{
            if(variant!="no_account_complete")await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId=variant=="account"?"456":"123"});
            if(variant=="item")await emit(new(){Type="item",Item=new(){Platform="telegram",ContentId="1",ChatId="channel_123",MessageId="1",Key="telegram:channel_123:1",SourceUrl="",Title="synthetic"}});
            await emit(new(){Type="complete",Status="completed",Completeness="partial"});});
        await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Message+=(_,e)=>{if(e.Type is "chat" or "item")published++;};hub.Enable();
        var job=repo.CreateJob(new(){Platform="telegram",Kind="chat",Url="https://t.me/",AccountId="123",MaxItems=50},root);
        await hub.Submit(job.Id,"listChats");Assert.Equal(0,published);Assert.NotEqual("completed",repo.GetJob(job.Id)!.Status);Assert.Empty(repo.ListItems(job.Id));
    }
    [Fact]
    public async Task DirectoryWithoutKnownAccountStartsNoWorker()
    {
        var calls=0;var runner=new FixtureRunner((r,emit,ct)=>{calls++;return Task.CompletedTask;});await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Enable();
        var job=repo.CreateJob(new(){Platform="telegram",Kind="chat",Url="https://t.me/",MaxItems=50},root);
        Assert.Throws<InvalidOperationException>(()=>{_ = hub.Submit(job.Id,"listChats");});Assert.Equal(0,calls);
    }
    [Theory][InlineData(2,2)][InlineData(0,5000)][InlineData(150,150)][InlineData(9000,5000)]
    public async Task HostPreservesSmallCallerLimitAndCapsLargeCaller(int requested,int expected)
    {
        var published=0;var runner=new FixtureRunner(async(r,emit,ct)=>{Assert.Equal(requested,r.Source.MaxItems);await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId="123"});for(var i=1;i<=expected;i++)await emit(new(){Type="chat",Chat=new(){Id="channel_"+i,Title="synthetic"}});await emit(new(){Type="complete",Status="completed",Completeness="partial"});});
        await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Message+=(_,e)=>{if(e.Type=="chat")published++;};hub.Enable();var job=repo.CreateJob(new(){Platform="telegram",Kind="chat",Url="https://t.me/",AccountId="123",MaxItems=requested},root);await hub.Submit(job.Id,"listChats");Assert.Equal(expected,published);Assert.Equal("completed",repo.GetJob(job.Id)!.Status);
    }
    [Theory][InlineData("single","123",50)][InlineData("chat","01",50)][InlineData("chat","123",-1)]
    public async Task InvalidDirectoryRequestStartsNoWorker(string kind,string account,int max)
    {
        var calls=0;var runner=new FixtureRunner((r,e,ct)=>{calls++;return Task.CompletedTask;});await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Enable();var job=repo.CreateJob(new(){Platform="telegram",Kind=kind,Url="https://t.me/",AccountId=account,MaxItems=max},root);Assert.Throws<InvalidOperationException>(()=>{_=hub.Submit(job.Id,"listChats");});Assert.Equal(0,calls);
    }
    [Theory][InlineData("scan")][InlineData("download")]
    public async Task RootDirectoryCannotBeUsedAsMediaSource(string operation)
    {
        var calls=0;var runner=new FixtureRunner((r,e,ct)=>{calls++;return Task.CompletedTask;});await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Enable();var job=repo.CreateJob(new(){Platform="telegram",Kind="chat",Url="https://t.me/",AccountId="123",MaxItems=50},root);Assert.Throws<InvalidOperationException>(()=>{_=hub.Submit(job.Id,operation);});Assert.Equal(0,calls);
    }
    public void Dispose()
    {
        repo.Dispose();var allowed=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"UMH-chat-directory"));
        if(Path.GetDirectoryName(root)!=allowed||!Guid.TryParseExact(Path.GetFileName(root),"N",out _))throw new IOException("Fixture boundary");
        for(var p=new DirectoryInfo(root);p!=null;p=p.Parent)if((p.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Fixture ancestor link");
        var pending=new Stack<string>();pending.Push(root);while(pending.TryPop(out var dir))foreach(var entry in Directory.EnumerateFileSystemEntries(dir)){var flags=File.GetAttributes(entry);if((flags&FileAttributes.ReparsePoint)!=0)throw new IOException("Fixture link");if((flags&FileAttributes.Directory)!=0)pending.Push(entry);}
        Directory.Delete(root,true);
    }
}


