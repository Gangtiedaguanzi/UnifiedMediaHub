using System.Text.Json;
using Xunit;
using UnifiedMediaHub.Core;
namespace UnifiedMediaHub.Tests;
public sealed class StageCDiagnosticTests
{
 [Fact] public void ZjcdnHostIsSanitizedToFamilyAndDeceptiveSuffixIsDropped()
 {
  using var valid=JsonDocument.Parse("{\"host\":\"edge-123.zjcdn.com\",\"status\":200}");
  var entry=DiagnosticLog.Clean(valid.RootElement)!;Assert.Equal("zjcdn.com",entry["host"]);
  using var foreign=JsonDocument.Parse("{\"host\":\"zjcdn.com.foreign.invalid\",\"status\":403}");Assert.False(DiagnosticLog.Clean(foreign.RootElement)!.ContainsKey("host"));
 }
 [Fact] public void EmbeddedDiagnosticsPersistAndExportOnlyBoundedScalarFields()
 {
  var root=Path.Combine(Path.GetTempPath(),"umh-stage-c-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
  try{
   using var raw=JsonDocument.Parse("{\"embeddedScanned\":190,\"rscRowsParsed\":1,\"wrapperFound\":true,\"detailFound\":true,\"imageCount\":16,\"liveVideoCount\":16,\"awemeType\":68,\"mediaType\":42,\"title\":\"SECRET\"}");
   var log=new DiagnosticLog();log.Add(raw.RootElement);Assert.True(log.Save(root,Guid.NewGuid().ToString("N")));
   var entry=Assert.Single(Assert.Single(DiagnosticLog.ReadRecent(Path.Combine(root,"private","diagnostics"))))!;
   Assert.Equal(8,entry.Count);Assert.Equal(190,entry["embeddedScanned"]);Assert.Equal(1,entry["rscRowsParsed"]);Assert.Equal(42,entry["mediaType"]);Assert.Equal(true,entry["wrapperFound"]);Assert.Equal(true,entry["detailFound"]);Assert.All(entry.Values,value=>Assert.True(value is int or bool));
   using var bad=JsonDocument.Parse("{\"status\":200,\"embeddedScanned\":1001,\"rscRowsParsed\":51,\"mediaType\":10001,\"wrapperFound\":\"SECRET\",\"detailFound\":1}");Assert.Single(DiagnosticLog.Clean(bad.RootElement)!);
  }finally{Directory.Delete(root,true);}
 }
}
