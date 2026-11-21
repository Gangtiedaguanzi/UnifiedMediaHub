using System.Text.Json;
using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class StageEDiagnosticTests
{
 [Fact]public void NewVerdictsAndRequestShapesSurviveStorageAndExport(){
  var root=Path.Combine(Path.GetTempPath(),"umh-stage-e-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try{
   var log=new DiagnosticLog();var verdicts=new[]{"rejected_origin","rejected_credentials","rejected_subject_count","rejected_subject_value","rejected_snapshot_subject","rejected_current_subject"};
   for(var i=0;i<verdicts.Length;i++){
    using var main=JsonDocument.Parse(JsonSerializer.Serialize(new{path="/aweme/v1/web/aweme/favorite/?sec_user_id=SECRET",requestOrdinal=i+1,method="GET",status=200,listVerdict=verdicts[i]}));log.Add(main.RootElement);
    using var shape=JsonDocument.Parse(JsonSerializer.Serialize(new{requestOrdinal=i+1,requestSubjectLength=76,sourceSubjectLength=76,accountIdLength=76,requestSubjectIsSource=true,requestSubjectIsAccount=true,sourceSubjectIsAccount=true,originFamily="www.douyin.com"}));log.Add(shape.RootElement);
    using var snapshot=JsonDocument.Parse(JsonSerializer.Serialize(new{requestOrdinal=i+1,snapshotPath="https://www.douyin.com/user/SECRET?modal_id=987654321987",snapshotHasWork=true,snapshotHostAllowed=true,snapshotSubjectIsSource=true}));log.Add(snapshot.RootElement);
   }
   Assert.True(log.Save(root,Guid.NewGuid().ToString("N")));var rows=Assert.Single(DiagnosticLog.ReadRecent(Path.Combine(root,"private","diagnostics")));Assert.Equal(18,rows.Count);
   for(var i=0;i<verdicts.Length;i++){Assert.Equal(verdicts[i],rows[i*3]["listVerdict"]);Assert.Equal(i+1,rows[i*3]["requestOrdinal"]);Assert.Equal(76,rows[i*3+1]["requestSubjectLength"]);Assert.Equal(true,rows[i*3+1]["sourceSubjectIsAccount"]);Assert.Equal("www.douyin.com",rows[i*3+1]["originFamily"]);Assert.Equal("/user/:id",rows[i*3+2]["snapshotPath"]);Assert.Equal(true,rows[i*3+2]["snapshotHasWork"]);}
   var text=JsonSerializer.Serialize(rows);foreach(var secret in new[]{"SECRET","sec_user_id","987654321987","?"})Assert.DoesNotContain(secret,text);foreach(var row in rows)Assert.True(JsonSerializer.SerializeToUtf8Bytes(row).Length<=300);
  }finally{Directory.Delete(root,true);}
 }
 [Fact]public void NewWhitelistBoundsAndUnknownValuesFailClosed(){
  using var bad=JsonDocument.Parse("""{"status":200,"requestOrdinal":1025,"requestSubjectLength":257,"sourceSubjectLength":-1,"accountIdLength":1.5,"requestSubjectIsSource":1,"requestSubjectIsAccount":"true","sourceSubjectIsAccount":null,"snapshotHasWork":1,"snapshotHostAllowed":"SECRET","snapshotSubjectIsSource":0,"originFamily":"www.douyin.com.SECRET","listVerdict":"rejected_SECRET","accountId":"SECRET"}""");Assert.Single(DiagnosticLog.Clean(bad.RootElement)!);
  using var good=JsonDocument.Parse("""{"requestOrdinal":1024,"requestSubjectLength":256,"sourceSubjectLength":0,"accountIdLength":256,"requestSubjectIsSource":false,"requestSubjectIsAccount":false,"sourceSubjectIsAccount":true,"originFamily":"edith.xiaohongshu.com"}""");var clean=DiagnosticLog.Clean(good.RootElement)!;Assert.Equal(8,clean.Count);Assert.Equal(256,clean["accountIdLength"]);Assert.Equal("edith.xiaohongshu.com",clean["originFamily"]);
 }
 [Fact]public async Task WorkerAndCoreWhitelistsAgreeOnNewEnumsAndBoundaryCorpus(){
  var project=new DirectoryInfo(AppContext.BaseDirectory);while(project!=null&&!File.Exists(Path.Combine(project.FullName,"AGENTS.md")))project=project.Parent;var codeRoot=project!.FullName;
  var rows=new List<object>();foreach(var verdict in new[]{"rejected_origin","rejected_credentials","rejected_subject_count","rejected_subject_value","rejected_snapshot_subject","rejected_current_subject","SECRET"})rows.Add(new{status=200,listVerdict=verdict});
  foreach(var family in new[]{"www.douyin.com","douyin.com","iesdouyin.com","www.xiaohongshu.com","xiaohongshu.com","edith.xiaohongshu.com","other","SECRET"})rows.Add(new{status=200,originFamily=family});
  foreach(var n in new[]{-1,0,1,256,257,1024,1025})rows.Add(new{status=200,requestOrdinal=n,requestSubjectLength=n,sourceSubjectLength=n,accountIdLength=n});
  rows.Add(new{snapshotPath="https://www.douyin.com/user/SECRET?modal_id=SECRET",snapshotHasWork=true,snapshotHostAllowed=false,snapshotSubjectIsSource=true});
  rows.Add(new{requestSubjectIsSource=false,requestSubjectIsAccount=true,sourceSubjectIsAccount=false});
  var json=JsonSerializer.Serialize(rows);var start=new System.Diagnostics.ProcessStartInfo(Path.Combine(codeRoot,"runtime/node/node.exe")){WorkingDirectory=codeRoot,UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
  foreach(var arg in new[]{"--import","./worker/test/fixtures/offline-network.mjs","--input-type=module","--eval","import {diagnosticEntry} from './worker/src/shared/diagnostics.mjs';let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(JSON.stringify(JSON.parse(text).map(diagnosticEntry)));"})start.ArgumentList.Add(arg);
  using var process=System.Diagnostics.Process.Start(start)!;await process.StandardInput.WriteAsync(json);process.StandardInput.Close();var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(10));await process.WaitForExitAsync(timeout.Token);Assert.Equal(0,process.ExitCode);Assert.Equal("",await errors);
  using var raw=JsonDocument.Parse(json);using var worker=JsonDocument.Parse(await output);Assert.Equal(raw.RootElement.GetArrayLength(),worker.RootElement.GetArrayLength());
  for(var i=0;i<rows.Count;i++){using var core=JsonDocument.Parse(JsonSerializer.Serialize(DiagnosticLog.Clean(raw.RootElement[i])));Assert.True(JsonElement.DeepEquals(core.RootElement,worker.RootElement[i]),"Whitelist corpus index "+i);}
 }
}
