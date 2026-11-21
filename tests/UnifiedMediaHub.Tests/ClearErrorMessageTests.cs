using UnifiedMediaHub.Core;using Xunit;
namespace UnifiedMediaHub.Tests;
// Real failures (a removed drive, a Telegram flood wait) were shown only as generic text.
public sealed class ClearErrorMessageTests
{
 static ContentItem Photo(int i)=>new(){Key="telegram:channel_7:"+i,Platform="telegram",ContentId=i.ToString(),ChatId="channel_7",MessageId=i.ToString(),SourceUrl="https://t.me/c/7/"+i,Selected=true,MediaResolved=true,Media=[new(){Index=1,Kind="image",Extension="jpg"}]};
 static SourceRequest Chat()=>new(){Platform="telegram",Kind="chat",Url="https://t.me/c/7",ChatId="channel_7",AccountId="123"};
 [Fact]public async Task DownloadToAMissingDriveStopsBeforeTheWorkerAndNamesTheLocation()
 {
  var letter=Enumerable.Range('D','Z'-'D'+1).Select(c=>(char)c).Reverse().First(c=>!Directory.Exists(c+@":\"));
  var missing=letter+@":\统一媒体下载";
  var root=Path.Combine(Path.GetTempPath(),"umh-root-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try{using var repo=new HubRepository(Path.Combine(root,"hub.db"));repo.Initialize();var job=repo.CreateJob(Chat(),missing);repo.UpsertItems(job.Id,[Photo(1)]);
   var calls=0;var runner=new FixtureRunner((_,_,_)=>{calls++;return Task.CompletedTask;});
   await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Enable();await hub.Submit(job.Id,"download");
   var done=repo.GetJob(job.Id)!;Assert.Equal(0,calls);Assert.Equal("needs_action",done.Status);Assert.Equal("download_root_unavailable",done.ReasonCode);Assert.Contains(missing,done.Message);}
  finally{Directory.Delete(root,true);}
 }
 [Theory][InlineData(150,"3 分钟")][InlineData(45,"1 分钟")][InlineData(7200,"2 小时")]
 public async Task TelegramFloodWaitTellsHowLongToWait(int seconds,string expected)
 {
  var root=Path.Combine(Path.GetTempPath(),"umh-flood-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try{using var repo=new HubRepository(Path.Combine(root,"hub.db"));repo.Initialize();var job=repo.CreateJob(Chat(),root);repo.UpsertItems(job.Id,[Photo(1)]);
   var runner=new FixtureRunner(async(request,emit,_)=>{await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId="123"});await emit(new(){Type="needs_action",Code="rate_limited",RetryAfterSeconds=seconds});await emit(new(){Type="complete",Status="needs_action",Completeness="partial",ReasonCode="rate_limited"});});
   await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root});hub.Enable();await hub.Submit(job.Id,"download");
   var done=repo.GetJob(job.Id)!;Assert.Equal("rate_limited",done.ReasonCode);Assert.Contains(expected,done.Message);Assert.Contains("后再试",done.Message);}
  finally{Directory.Delete(root,true);}
 }
}
