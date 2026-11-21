using System.Buffers.Binary;
using System.Text.Json;
using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class LoginQrCodeTests : IDisposable
{
 readonly string root=Path.Combine(Path.GetTempPath(),"UMH-qr",Guid.NewGuid().ToString("N"));readonly HubRepository repo;
 public LoginQrCodeTests(){Directory.CreateDirectory(root);repo=new(Path.Combine(root,"hub.db"));repo.Initialize();}
 public void Dispose(){repo.Dispose();Directory.Delete(root,true);}
 internal static LoginQrCode Qr(){var b=new byte[57];Convert.FromHexString("89504E470D0A1A0A").CopyTo(b,0);BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(8),13);"IHDR"u8.CopyTo(b.AsSpan(12));BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(16),320);BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(20),320);b[24]=8;b[25]=6;"IDAT"u8.CopyTo(b.AsSpan(37));"IEND"u8.CopyTo(b.AsSpan(49));return new(){PngBase64=Convert.ToBase64String(b),ExpiresAtUnix=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+30};}
 [Fact]public void RejectMalformedOrUnboundedImageAndExpiryBeforeDecode(){Assert.Equal(57,Qr().DecodeValidated(DateTimeOffset.UtcNow).Length);foreach(var defect in new[]{"base64","oversize","width","nonsquare","truncated","past","future"}){var q=Qr();var b=Convert.FromBase64String(q.PngBase64);switch(defect){case "base64":q.PngBase64="abcd$";break;case "oversize":q.PngBase64=Convert.ToBase64String(new byte[32769]);break;case "width":BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(16),999999);q.PngBase64=Convert.ToBase64String(b);break;case "nonsquare":BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(20),321);q.PngBase64=Convert.ToBase64String(b);break;case "truncated":q.PngBase64=Convert.ToBase64String(b[..33]);break;case "past":q.ExpiresAtUnix=1;break;case "future":q.ExpiresAtUnix=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+601;break;}Assert.Throws<InvalidDataException>(()=>q.DecodeValidated(DateTimeOffset.UtcNow));}}
 HubJob Job(string platform="telegram")=>repo.CreateJob(new(){Platform=platform,Kind="profile",Url=platform=="telegram"?"https://t.me/":"https://x.com/"},root);
 HubCoordinator Hub(FixtureRunner r)=>new(repo,r,new(){DataRoot=root,DownloadRoot=root});
 static WorkerEvent Done()=>new(){Type="complete",Status="completed",Completeness="unknown"};
 [Theory][InlineData("good")][InlineData("duplicate")][InlineData("no-account")][InlineData("mismatch")][InlineData("after-prompt")]
 public async Task OnlyOneActiveTelegramQrAndVerifiedAccountMayComplete(string mode){var job=Job();if(mode=="mismatch")repo.BindAccount(job.Id,"bound");var qr=Qr();var published=0;var runner=new FixtureRunner(async(_,emit,_)=>{await emit(new(){Type="login_qr",QrCode=qr});if(mode=="after-prompt")await emit(new(){Type="needs_action",Code="input_required",InputType="password",InputId=Guid.NewGuid().ToString(),AwaitingInput=true});if(mode is "duplicate" or "after-prompt")await emit(new(){Type="login_qr",QrCode=qr});if(mode!="no-account")await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId="42"});await emit(Done());});await using var hub=Hub(runner);hub.Message+=(_,e)=>{if(e.Type=="login_qr"){published++;Assert.False(hub.AwaitingInput);}};hub.Enable();await hub.Submit(job.Id,"loginQr");Assert.Equal(1,published);Assert.Equal(mode=="good"?"completed":mode is "mismatch" or "after-prompt"?"needs_action":"failed",repo.GetJob(job.Id)!.Status);Assert.DoesNotContain(qr.PngBase64,JsonSerializer.Serialize(repo.ListJobs()));}
 [Fact]public async Task WrongPlatformAndBusyLoginQrNeverLaunch(){var entered=new TaskCompletionSource();var runner=new FixtureRunner(async(_,_,ct)=>{entered.SetResult();await Task.Delay(Timeout.Infinite,ct);});await using var hub=Hub(runner);hub.Enable();await Assert.ThrowsAsync<ArgumentException>(async()=>await hub.Submit(Job("x").Id,"loginQr"));var active=hub.Submit(Job().Id,"loginQr");await entered.Task;await Assert.ThrowsAsync<InvalidOperationException>(async()=>await hub.Submit(Job().Id,"loginQr"));await hub.DisableAsync();await active;Assert.Single(runner.Requests);}
 [Fact]public async Task CancelRejectsLateQrAndAccount(){var entered=new TaskCompletionSource();var release=new TaskCompletionSource();var job=Job();var runner=new FixtureRunner(async(_,emit,_)=>{entered.SetResult();await release.Task;await emit(new(){Type="login_qr",QrCode=Qr()});await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId="42"});});await using var hub=Hub(runner);int messages=0;hub.Message+=(_,_)=>messages++;hub.Enable();var task=hub.Submit(job.Id,"loginQr");await entered.Task;var stop=hub.DisableAsync();release.SetResult();await stop;await task;Assert.Equal(0,messages);Assert.Null(repo.GetJob(job.Id)!.Source.AccountId);Assert.Equal("paused",repo.GetJob(job.Id)!.Status);}
}



public sealed class QrTransportTests
{
 [Theory][InlineData("valid")][InlineData("wrong-operation")][InlineData("duplicate")][InlineData("bad-expiry")][InlineData("hidden-payload")]
 public async Task OwnedTransportAcceptsOnlyBoundedQrEnvelope(string mode){
  var project=new DirectoryInfo(AppContext.BaseDirectory);while(project!=null&&!File.Exists(Path.Combine(project.FullName,"AGENTS.md")))project=project.Parent;
  var temp=Path.Combine(project!.FullName,".cache","qr-transport-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(temp);
  try{
   var script=Path.Combine(temp,"worker.mjs");await File.WriteAllTextAsync(script,"process.stdin.once('data',b=>{const r=JSON.parse(b.toString());for(const e of JSON.parse(process.env.SYNTHETIC_EVENTS))process.stdout.write(JSON.stringify({...e,version:1,requestId:r.requestId})+'\\n');process.stdin.pause();process.stdout.end(()=>process.exit(0));});");
   var qr=LoginQrCodeTests.Qr();if(mode=="bad-expiry")qr.ExpiresAtUnix=1;
   var e=new WorkerEvent{Version=1,Type=mode=="hidden-payload"?"status":"login_qr",QrCode=qr};
   var events=mode=="duplicate"?new[]{e,e}:new[]{e};
   var options=new UnifiedMediaHub.Core.Runtime.WorkerLaunchOptions{ExecutablePath=Path.Combine(project.FullName,"runtime","node","node.exe"),WorkerScriptPath=script,WorkingDirectory=temp,Environment=new(){["SYNTHETIC_EVENTS"]=JsonSerializer.Serialize(events,HubJson.Options)}};
   var request=new WorkerRequest{RequestId="synthetic-qr",Operation=mode=="wrong-operation"?"login":"loginQr",Source=new(){Platform="telegram"}};
   await using var session=await UnifiedMediaHub.Core.Runtime.OwnedWorkerSession.StartAsync(options,request);
   if(mode=="valid"){Assert.Equal(0,await session.Completion.WaitAsync(TimeSpan.FromSeconds(10)));var count=0;await foreach(var item in session.ReadEventsAsync()){Assert.NotNull(item.QrCode);count++;}Assert.Equal(1,count);}
   else {var error=await Assert.ThrowsAnyAsync<IOException>(async()=>await session.Completion.WaitAsync(TimeSpan.FromSeconds(10)));Assert.DoesNotContain(qr.PngBase64,error.ToString());}
  }finally{Directory.Delete(temp,true);}
 }
}
