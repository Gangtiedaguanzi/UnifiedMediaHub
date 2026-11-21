using System.Text.Json;
using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class DiagnosticTests:IDisposable
{
 [Fact]public void IdleTimeoutKeepsOnlyFixedStatusHostAndAttempt(){using var doc=JsonDocument.Parse("""{"host":"v1.zjcdn.com","status":"idle_timeout","attempt":2,"url":"SECRET","cookie":"SECRET"}""");var entry=DiagnosticLog.Clean(doc.RootElement)!;Assert.Equal("idle_timeout",entry["status"]);Assert.Equal("zjcdn.com",entry["host"]);Assert.Equal(2,entry["attempt"]);Assert.Equal(3,entry.Count);}
 [Fact]public void XVerifyReasonKeepsOnlyTheFixedEnum(){using var good=JsonDocument.Parse("""{"xVerify":"ui_missing","accountId":"SECRET"}""");var entry=DiagnosticLog.Clean(good.RootElement)!;Assert.Equal("ui_missing",entry["xVerify"]);Assert.Single(entry);using var bad=JsonDocument.Parse("""{"xVerify":"SECRET_REASON"}""");Assert.False(DiagnosticLog.Clean(bad.RootElement)?.ContainsKey("xVerify")??false);}
 [Fact]public void TelegramCheckKeepsOnlyFixedEnums(){using var doc=JsonDocument.Parse("""{"telegramCheck":"message_missing","peerKind":"user","entryCount":0,"chatId":"SECRET"}""");var entry=DiagnosticLog.Clean(doc.RootElement)!;Assert.Equal("message_missing",entry["telegramCheck"]);Assert.Equal("user",entry["peerKind"]);Assert.Equal(3,entry.Count);}
 [Fact]public void FailureCodeKeepsOnlyIdentifiers(){using var good=JsonDocument.Parse("""{"failure":"unexpected_engine_output","engineCode":"operation_failed"}""");var entry=DiagnosticLog.Clean(good.RootElement)!;Assert.Equal("unexpected_engine_output",entry["failure"]);Assert.Equal("operation_failed",entry["engineCode"]);using var bad=JsonDocument.Parse("""{"failure":"ENOENT: C:/Users/secret"}""");Assert.False(DiagnosticLog.Clean(bad.RootElement)?.ContainsKey("failure")??false);}
 [Fact]public void HostFailureKeepsTypeAndPlainMessageOnly(){using var good=JsonDocument.Parse("""{"hostFailure":"InvalidDataException","hostMessage":"Receipt is outside the download root."}""");var entry=DiagnosticLog.Clean(good.RootElement)!;Assert.Equal("InvalidDataException",entry["hostFailure"]);Assert.Equal("Receipt is outside the download root.",entry["hostMessage"]);using var bad=JsonDocument.Parse("""{"hostFailure":"IOException","hostMessage":"Access to the path K:/x/123.jpg is denied."}""");var cleaned=DiagnosticLog.Clean(bad.RootElement)!;Assert.Equal("IOException",cleaned["hostFailure"]);Assert.False(cleaned.ContainsKey("hostMessage"));}
 readonly string root=Path.Combine(Path.GetTempPath(),"umh-diagnostics-"+Guid.NewGuid().ToString("N"));
 readonly HubRepository repo;
 public DiagnosticTests(){Directory.CreateDirectory(Path.Combine(root,"private"));repo=new(Path.Combine(root,"private","hub.db"));repo.Initialize();}
 public void Dispose(){repo.Dispose();Directory.Delete(root,true);}
 async Task<string> EmitReport(int status=403,int count=1,string? jobId=null){
  var job=jobId==null?repo.CreateJob(new(){Platform="douyin",Kind="single",Url="https://www.douyin.com/video/123"},root):repo.GetJob(jobId)!;
  var runner=new FixtureRunner(async(request,emit,_)=>{
   for(var i=0;i<count;i++)await emit(JsonSerializer.Deserialize<WorkerEvent>(JsonSerializer.Serialize(new {version=1,requestId=request.RequestId,type="diagnostic",diagnostic=new {path="/aweme/v1/web/aweme/detail/?account=SECRET_ACCOUNT",status,attempt=1,topFields=new[]{"aweme_detail","cookie","SECRET_TITLE"},hasAwemeDetail=true,awemeType=68,imageCount=2,title="SECRET_TITLE",accountId="SECRET_ACCOUNT"}}),HubJson.Options)!);
   await emit(new(){Type="complete",Status="completed",Completeness="partial"});
  });
  await using var hub=new HubCoordinator(repo,runner,new(){DataRoot=root,DownloadRoot=root},1);hub.Enable();await hub.Submit(job.Id,"scan");
  return job.Id;
 }
 [Fact]public async Task WorkerDiagnosticIsPersistedAndExportedWithoutSecrets(){
  await EmitReport();var dir=Path.Combine(root,"private","diagnostics");Assert.True(Directory.Exists(dir));Assert.Single(Directory.GetFiles(dir,"*.json"));
  var report=SanitizedReport.Create(repo);using var parsed=JsonDocument.Parse(report);var operations=parsed.RootElement.GetProperty("diagnostics");Assert.Equal(1,operations.GetArrayLength());Assert.Equal(403,operations[0][0].GetProperty("status").GetInt32());
  foreach(var text in Directory.GetFiles(dir,"*.json").Select(File.ReadAllText).Append(report)){Assert.DoesNotContain("?",text);Assert.DoesNotContain("cookie",text);Assert.DoesNotContain("SECRET_",text);}
 }
 [Fact]public async Task OnlyLatestFiveOperationsAreExportedAndEntryLimitsHold(){
  for(var i=0;i<7;i++)await EmitReport(200+i,i==6?1000:1);
  using var parsed=JsonDocument.Parse(SanitizedReport.Create(repo));var operations=parsed.RootElement.GetProperty("diagnostics");Assert.Equal(5,operations.GetArrayLength());Assert.Equal(200,operations[0].GetArrayLength());Assert.Equal(206,operations[0][0].GetProperty("status").GetInt32());
  foreach(var entry in operations.EnumerateArray().SelectMany(o=>o.EnumerateArray()))Assert.True(System.Text.Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(entry))<=300);
 }
 [Fact]public async Task DiagnosticDirectoryRotatesUnderFiveMillionBytesAndPreservesForeignFiles(){
  var dir=Path.Combine(root,"private","diagnostics");Directory.CreateDirectory(dir);
  for(var i=0;i<90;i++)File.WriteAllText(Path.Combine(dir,Guid.NewGuid().ToString("N")+".json"),new string(' ',65536));
  File.WriteAllText(Path.Combine(dir,"keep.txt"),"owned-by-user");await EmitReport();
  Assert.True(new DirectoryInfo(dir).EnumerateFiles().Sum(f=>f.Length)<=5_000_000);Assert.Equal("owned-by-user",File.ReadAllText(Path.Combine(dir,"keep.txt")));
 }
 [Fact]public async Task SameJobRetainsFiveOperationsAndEditedFilesAreRevalidated(){
  var id=await EmitReport(200);for(var i=1;i<7;i++)await EmitReport(200+i,1,id);
  var file=Assert.Single(Directory.GetFiles(Path.Combine(root,"private","diagnostics"),"*.json"));
  using(var saved=JsonDocument.Parse(File.ReadAllText(file)))Assert.Equal(5,saved.RootElement.GetArrayLength());
  File.WriteAllText(file,"[{\"completedAt\":\"2026-11-09T01:00:00Z\",\"entries\":[{\"status\":403,\"cookie\":\"SECRET_ACCOUNT\",\"path\":\"/user/SECRET_ACCOUNT?token=SECRET_TOKEN\",\"topFields\":[\"aweme_detail\",\"SECRET_TITLE\"]}]}]");
  var report=SanitizedReport.Create(repo);Assert.DoesNotContain("SECRET_",report);Assert.DoesNotContain("cookie",report);Assert.DoesNotContain("?",report);
 }
 [Fact]public async Task ActualWorkerDiagnosticsPassTransportBeforeTerminalFailureWithoutLaunchingBrowser(){
  var project=new DirectoryInfo(AppContext.BaseDirectory);while(project!=null&&!File.Exists(Path.Combine(project.FullName,"AGENTS.md")))project=project.Parent;var codeRoot=project!.FullName;
  var options=new UnifiedMediaHub.Core.Runtime.WorkerLaunchOptions{ExecutablePath=Path.Combine(codeRoot,"runtime/node/node.exe"),WorkerScriptPath=Path.Combine(codeRoot,"worker/src/main.mjs"),WorkingDirectory=codeRoot,Environment=new(){["TEMP"]=root,["TMP"]=root}};
  var request=new WorkerRequest{RequestId="diagnostic-transport",Operation="login",Source=new(){Platform="douyin",Kind="profile",Url="https://www.douyin.com/user/synthetic"},Paths=new(){DataRoot=root,DownloadRoot=root,BrowserExecutable=options.ExecutablePath,EngineRoot=root}};
  await using var session=await UnifiedMediaHub.Core.Runtime.OwnedWorkerSession.StartAsync(options,request);using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(10));var events=new List<WorkerEvent>();
  await foreach(var evt in session.ReadEventsAsync(timeout.Token))events.Add(evt);await session.Completion;
  Assert.Contains(events,e=>e.Type=="diagnostic"&&e.Diagnostic!.Value.GetProperty("operationStarted").GetBoolean());Assert.Equal("complete",events[^1].Type);Assert.Contains(events,e=>e.Type=="error"&&e.Code=="invalid_browser_path");
 }
}
