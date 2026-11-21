using System.Text.Json;
using Microsoft.Data.Sqlite;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;
// One folder per download task: "<what>_<whose/which>_<yyyy-MM-dd_HHmm>", files flat inside.
public sealed class TaskFolderTests : IDisposable
{
    readonly string root=Path.Combine(Path.GetTempPath(),"UMH-task-folder",Guid.NewGuid().ToString("N"));
    static readonly DateTimeOffset At=new(new DateTime(2026,11,19,20,5,0,DateTimeKind.Local));
    HubRepository Open(){Directory.CreateDirectory(root);var repo=new HubRepository(Path.Combine(root,"hub.db"));repo.Initialize();return repo;}
    static HubJob Job(SourceRequest source)=>new(){Source=source};
    static IEnumerable<ContentItem> By(params string[] authors)=>authors.Select((a,i)=>new ContentItem{Author=a,ContentId=i.ToString()});

    [Fact]
    public void NameSaysWhatWhoseAndWhen()
    {
        Assert.Equal("我的喜欢_小号_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="x",Kind="liked"}),()=>[],"小号",At));
        Assert.Equal("全部收藏_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="xiaohongshu",Kind="saved"}),()=>[],null,At));
        Assert.Equal("收藏夹_板鞋_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="xiaohongshu",Kind="saved_folder",Label="板鞋"}),()=>[],"小号",At));
        Assert.Equal("收藏夹_板鞋_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="douyin",Kind="bridge",Bridge=new(){ListKind="saved_folder",FolderTitle="板鞋",ViewerName="看的人"}}),()=>[],null,At));
        Assert.Equal("我的喜欢_看的人_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="douyin",Kind="bridge",Bridge=new(){ListKind="liked",ViewerName="看的人"}}),()=>[],"别的号",At));
        Assert.Equal("作者_阿B_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="douyin",Kind="profile"}),()=>By("阿A","阿B","阿B",""),null,At));
        Assert.Equal("聊天_kestrel_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="telegram",Kind="chat",Label="kestrel"}),()=>[],null,At));
        Assert.Equal("作者_abc_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="x",Kind="profile"}),()=>By(" a/b:c\t. "),null,At));
        Assert.Equal("作者_2026-11-19_2005",TaskFolders.Name(Job(new(){Platform="x",Kind="profile"}),()=>By("<>|"),null,At));
        var longName=TaskFolders.Name(Job(new(){Platform="x",Kind="liked"}),()=>[],new string('名',200),At);
        Assert.Equal("我的喜欢_"+new string('名',40)+"_2026-11-19_2005",longName);
    }
    [Fact]
    public void FolderIsKeptPerTaskAndDuplicateNamesGetANumber()
    {
        string first,second,legacy;
        using(var repo=Open())
        {
            var a=repo.CreateJob(new(){Platform="x",Kind="liked",Url="https://x.com/i/likes"},root);var b=repo.CreateJob(new(){Platform="x",Kind="liked",Url="https://x.com/i/likes"},root);
            first=a.Id;second=b.Id;legacy=repo.CreateJob(new(){Platform="x",Kind="single",Url="https://x.com/a/status/1"},root).Id;
            Assert.Equal("我的喜欢_2026-11-19_2005",repo.EnsureTaskFolder(a.Id,"我的喜欢_2026-11-19_2005"));
            Assert.Equal("我的喜欢_2026-11-19_2005",repo.EnsureTaskFolder(a.Id,"别的名字"));
            Assert.Equal("我的喜欢_2026-11-19_2005_2",repo.EnsureTaskFolder(b.Id,"我的喜欢_2026-11-19_2005"));
        }
        using(var repo=Open())
        {
            Assert.Equal("我的喜欢_2026-11-19_2005",repo.GetJob(first)!.TaskFolder);
            Assert.Equal("我的喜欢_2026-11-19_2005_2",repo.ListJobs().Single(j=>j.Id==second).TaskFolder);
            Assert.Null(repo.GetJob(legacy)!.TaskFolder);
        }
    }
    [Fact]
    public async Task DownloadSendsTheTaskFolderOnlyWhenChosenAndKeepsItAfterwards()
    {
        using var repo=Open();
        static ContentItem Item(string id)=>new(){Key="x:"+id,Platform="x",ContentId=id,Author="alice",SourceUrl="https://x.com/alice/status/"+id,MediaResolved=true,Media=[new(){Index=1,Kind="image"}]};
        var folders=new List<string?>();
        var runner=new FixtureRunner(async(request,emit,_)=>{using var json=JsonDocument.Parse(JsonSerializer.Serialize(request,HubJson.Options));folders.Add(json.RootElement.GetProperty("paths").GetProperty("folder").GetString());await emit(new(){Type="complete",Status="completed",Completeness="partial"});});
        await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root,EngineRoot=root,BrowserExecutable=Path.Combine(root,"browser.exe")});hub.Enable();
        var plain=repo.CreateJob(new(){Platform="x",Kind="profile",Url="https://x.com/alice"},root);repo.UpsertItems(plain.Id,[Item("1")]);
        await hub.Submit(plain.Id,"download");
        Assert.Equal("",folders.Single());Assert.Null(repo.GetJob(plain.Id)!.TaskFolder);
        hub.FolderPerTask=true;
        var flat=repo.CreateJob(new(){Platform="x",Kind="profile",Url="https://x.com/alice"},root);repo.UpsertItems(flat.Id,[Item("2")]);
        await hub.Submit(flat.Id,"download");
        var kept=repo.GetJob(flat.Id)!.TaskFolder;
        Assert.NotNull(kept);Assert.StartsWith("作者_alice_",kept);Assert.Equal(kept,folders[^1]);
        hub.FolderPerTask=false;await hub.Submit(flat.Id,"download");
        Assert.Equal(kept,folders[^1]);Assert.Equal(kept,repo.GetJob(flat.Id)!.TaskFolder);
    }
    public void Dispose(){SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
}
