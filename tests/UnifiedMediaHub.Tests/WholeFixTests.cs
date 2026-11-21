using System.Reflection;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;
using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class WholeFixTests:IDisposable
{
 readonly string root=Path.Combine(Path.GetTempPath(),"umh-whole-"+Guid.NewGuid().ToString("N"));readonly HubRepository repo;
 public WholeFixTests(){Directory.CreateDirectory(root);repo=new(Path.Combine(root,"hub.db"));repo.Initialize();}
 public void Dispose(){repo.Dispose();Directory.Delete(root,true);}
 HubJob Job()=>repo.CreateJob(new(){Platform="x",Kind="profile",Url="https://x.com/synthetic"},root);
 ContentItem Item(string id)=>new(){Key="x:"+id,Platform="x",ContentId=id,MediaResolved=true,Media=[new(){Index=1,Kind="image"}]};
 HubCoordinator Hub(FixtureRunner r)=>new(repo,r,new(){DataRoot=root,DownloadRoot=root},1);
 [Theory][InlineData("source_tab_required")][InlineData("manual_wait_timeout")][InlineData("rate_limited")][InlineData("input_required")][InlineData("source_changed")][InlineData("item_limit")][InlineData("scan_boundary")][InlineData("browser_closed")]
 [InlineData("folder_unverified")][InlineData("folder_members_unavailable")][InlineData("media_forbidden")]
 public async Task ReasonSurvivesCompleteExitAndReopen(string code){
  var job=Job();var runner=new FixtureRunner(async(_,emit,_)=>{await emit(new(){Type="needs_action",Code=code,Message="https://private.invalid/SECRET"});await emit(new(){Type="complete",Status="needs_action",Completeness="partial"});throw new IOException("SECRET");});
  await using(var hub=Hub(runner)){hub.Enable();await hub.Submit(job.Id,"scan");Assert.False(hub.AwaitingInput);}
  using var again=new HubRepository(Path.Combine(root,"hub.db"));again.Initialize();Assert.Equal(code,again.GetJob(job.Id)!.ReasonCode);Assert.Contains(UserText.Error(code),again.GetJob(job.Id)!.Message);Assert.DoesNotContain("SECRET",SanitizedReport.Create(again));
  if(code is "folder_unverified" or "folder_members_unavailable" or "media_forbidden")Assert.Equal("needs_action",again.GetJob(job.Id)!.Status);
 }
 [Fact]
 public async Task IdentityUnverifiedPersistsAsNeedsActionWithoutRawDiagnostic(){
  var job=Job();var runner=new FixtureRunner(async(_,emit,_)=>{
   await emit(new(){Type="needs_action",Code="identity_unverified",Message="SECRET signed identity URL"});
   await emit(new(){Type="complete",Status="needs_action",Completeness="partial",ReasonCode="identity_unverified"});
   throw new IOException("SECRET transport ending");
  });
  await using(var hub=Hub(runner)){hub.Enable();await hub.Submit(job.Id,"scan");Assert.False(hub.AwaitingInput);}
  using var reopened=new HubRepository(Path.Combine(root,"hub.db"));reopened.Initialize();var stored=reopened.GetJob(job.Id)!;
  Assert.Equal("needs_action",stored.Status);Assert.Equal("identity_unverified",stored.ReasonCode);
  Assert.Equal(UserText.Error("identity_unverified"),stored.Message);
  var report=SanitizedReport.Create(reopened);Assert.Contains("identity_unverified",report);Assert.DoesNotContain("SECRET",report);
 }
 [Theory][InlineData(false)][InlineData(true)]
 public async Task EqualBytesAcrossIdentitiesDetectedOnlyAfterReverification(bool corrupted){
  var first=Job();var second=Job();var a=Item("1");var b=Item("2");repo.UpsertItems(first.Id,[a]);repo.UpsertItems(second.Id,[b]);
  var pa=Path.Combine(root,"a.bin");var pb=Path.Combine(root,"b.bin");byte[] bytes=[1,2,3];File.WriteAllBytes(pa,corrupted?[3,2,1]:bytes);File.WriteAllBytes(pb,bytes);var hash=Convert.ToHexString(SHA256.HashData(bytes));
  repo.RecordReceipt(first.Id,new(){ContentKey=a.Key,MediaIndex=1,FilePath=pa,Bytes=3,Sha256=hash,Status="completed"});
  var runner=new FixtureRunner(async(_,emit,_)=>{await emit(new(){Type="receipt",Receipt=new(){ContentKey=b.Key,MediaIndex=1,FilePath=pb,Bytes=3,Sha256=hash.ToLowerInvariant(),Status="completed"}});await emit(new(){Type="complete",Status="completed",Completeness="unknown"});});
  await using var hub=Hub(runner);hub.Enable();await hub.Submit(second.Id,"download");
  var receipt=Assert.Single(repo.ListLatestReceipts(second.Id));Assert.Equal(corrupted?null:a.Key,receipt.DuplicateOfContentKey);Assert.True(File.Exists(pa));Assert.True(File.Exists(pb));Assert.Single(repo.ListItems(first.Id));Assert.Single(repo.ListItems(second.Id));
 }
 [Fact]
 public async Task ActualSqliteFullStopsOperationAndQueueKeepsPreviousCheckpoint(){
  var a=Job();var b=Job();repo.UpsertItems(a.Id,[Item("1")]);
  var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var proceed=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
  var runner=new FixtureRunner(async(_,emit,_)=>{entered.SetResult();await proceed.Task;var huge=Item("2");huge.Title=new string('z',1024*1024);await emit(new(){Type="item",Item=huge});throw new Exception("must stop");});
  await using var hub=Hub(runner);hub.Enable();var work=hub.Submit(a.Id,"scan");await entered.Task;var queued=hub.Submit(b.Id,"scan");
  var connection=(SqliteConnection)typeof(HubRepository).GetField("connection",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(repo)!;
  using(var command=connection.CreateCommand()){command.CommandText="PRAGMA page_count";var pages=command.ExecuteScalar();command.CommandText="PRAGMA max_page_count="+pages;command.ExecuteScalar();}
  proceed.SetResult();await Task.WhenAll(work,queued).WaitAsync(TimeSpan.FromSeconds(10));
  Assert.Equal("disk_full",hub.StorageWarning);Assert.False(hub.Enabled);Assert.Single(runner.Requests);Assert.Single(repo.ListItems(a.Id));Assert.Equal("x:1",repo.ListItems(a.Id)[0].Key);
 }
}
