using System.Text.Json;
using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class StageDDiagnosticTests
{
 [Fact]public void ListEnumsSurviveStorageExportAndUnknownStringsAreRemoved(){
  var root=Path.Combine(Path.GetTempPath(),"umh-stage-d-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try{
   var log=new DiagnosticLog();foreach(var verdict in new[]{"accepted","rejected_frame","rejected_subject","rejected_cursor","rejected_method","not_ready","stale_generation","not_belongs","payload_invalid","body_limit","tab_unconfirmed"}){
    using var row=JsonDocument.Parse(JsonSerializer.Serialize(new{path="/aweme/v1/web/aweme/favorite/?sec_user_id=SECRET&max_cursor=987654321987",method="GET",status=200,listVerdict=verdict,entryCount=18,hasMore=true,attempt=1}));log.Add(row.RootElement);
   }
   using(var summary=JsonDocument.Parse("{\"finalPath\":\"/user/SECRET?cookie=SECRET\",\"rounds\":35,\"scrolls\":35,\"published\":20,\"reason\":\"item_limit\",\"manualWait\":false,\"tabConfirmed\":true}"))log.Add(summary.RootElement);
   Assert.True(log.Save(root,Guid.NewGuid().ToString("N")));var entries=Assert.Single(DiagnosticLog.ReadRecent(Path.Combine(root,"private","diagnostics")));Assert.Equal(12,entries.Count);Assert.Equal("accepted",entries[0]["listVerdict"]);Assert.Equal("tab_unconfirmed",entries[10]["listVerdict"]);Assert.Equal(20,entries[11]["published"]);var text=JsonSerializer.Serialize(entries);Assert.DoesNotContain("SECRET",text);Assert.DoesNotContain("?",text);Assert.DoesNotContain("987654321987",text);
   using var bad=JsonDocument.Parse("{\"status\":200,\"method\":\"SECRET\",\"listVerdict\":\"SECRET\",\"reason\":\"SECRET\",\"entryCount\":1001,\"rounds\":501,\"scrolls\":501,\"published\":10001,\"hasMore\":\"SECRET\"}");Assert.Single(DiagnosticLog.Clean(bad.RootElement)!);
  }finally{Directory.Delete(root,true);}
 }
}
