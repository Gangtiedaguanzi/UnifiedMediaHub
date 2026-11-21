using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class ReleaseRecoveryTests
{
    [Fact]
    public void LargerRescanRetainsMembershipSelectionAndAccountBinding()
    {
        var root=Path.Combine(Path.GetTempPath(),"umh-rescan-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try
        {
            using var db=new HubRepository(Path.Combine(root,"hub.db"));db.Initialize();
            var job=db.CreateJob(new(){Platform="xiaohongshu",Kind="saved",Url="https://www.xiaohongshu.com/user/profile/author",AccountId="author"},root);
            db.UpsertItems(job.Id,[new(){Platform="xiaohongshu",ContentId="abc",SourceUrl="https://www.xiaohongshu.com/explore/abc",Selected=false}]);
            db.SetScanLimit(job.Id,1500);
            db.UpsertItems(job.Id,[new(){Platform="xiaohongshu",ContentId="abc",SourceUrl="https://www.xiaohongshu.com/explore/abc",Selected=true}]);
            var updated=db.GetJob(job.Id)!;Assert.Equal(1500,updated.Source.MaxItems);Assert.Equal("author",updated.Source.AccountId);
            Assert.Equal(job.Source.Url,updated.Source.Url);Assert.Equal("saved",updated.Source.Kind);Assert.Equal("ready",updated.Status);
            Assert.False(Assert.Single(db.ListItems(job.Id)).Selected);
            Assert.Throws<ArgumentOutOfRangeException>(()=>db.SetScanLimit(job.Id,10001));
        }
        finally{Directory.Delete(root,true);}
    }
}
