using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class ResultModelTests
{
    static ContentItem Item(string id,bool resolved=true,bool selected=true)=>new(){Platform="telegram",Key="telegram:channel_987654321:"+id,ChatId="channel_987654321",MessageId=id,ContentId=id,MediaResolved=resolved,Selected=selected,Media=[new(){Index=1},new(){Index=2},new(){Index=3}]};
    [Fact]
    public void PartialGalleryCountsPendingAndUnknownSeparatelyAcrossSelectedScope()
    {
        var a=Item("123456789");var unknown=Item("123456790",false);var off=Item("123456791",true,false);
        unknown.Media=[];
        var summary=ResultSummary.From([a,unknown,off],[new(){ContentKey=a.Key,MediaIndex=1,Status="completed"}]);
        Assert.Equal(3,summary.Works);Assert.Equal(2,summary.SelectedWorks);Assert.Equal(3,summary.KnownAssets);
        Assert.Equal(1,summary.Completed);Assert.Equal(2,summary.Pending);Assert.Equal(1,summary.UnresolvedWorks);
        Assert.Equal(0,summary.Failed);Assert.Contains("待处理 2",summary.Display);
    }
    [Theory][InlineData("channel")][InlineData("chat")][InlineData("user")]
    public void SanitizedReportUsesOnlyLocalOpaqueAliasesAndDurableReasonCodes(string peerType)
    {
        var root=Path.Combine(Path.GetTempPath(),"umh-report-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try{
            using var db=new HubRepository(Path.Combine(root,"hub.db"));db.Initialize();
            var peer=peerType+"_987654321";
            var job=db.CreateJob(new(){Platform="telegram",Kind="chat",ChatId=peer,AccountId="9007199254740993",Url="https://t.me/private?token=SECRET"},root);
            var item=Item("123456789");item.ChatId=peer;item.Key="telegram:"+peer+":123456789";db.UpsertItems(job.Id,[item]);db.RecordReceipt(job.Id,new(){ContentKey=item.Key,MediaIndex=1,Status="failed",ErrorCode="transfer_failed"});
            db.UpdateJob(job.Id,"failed",reasonCode:"disk_full");
            var report=SanitizedReport.Create(db);
            foreach(var secret in new[]{job.Id,item.Key,"987654321","123456789","9007199254740993","https://","SECRET"})Assert.DoesNotContain(secret,report);
            Assert.Contains("disk_full",report);Assert.Contains("pending",report);Assert.Contains("work-1",report);
            Assert.Equal("disk_full",db.GetJob(job.Id)!.ReasonCode);
        }finally{Directory.Delete(root,true);}
    }
}
