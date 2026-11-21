using Microsoft.Data.Sqlite;
using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class RepositoryRollbackTests
{
    [Fact]
    public void UpgradeAllowsLegacyEightValueInsertAndInvalidatesOldReasonAfterLegacyUpdate()
    {
        var root=Path.Combine(Path.GetTempPath(),"umh-rollback-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        var path=Path.Combine(root,"hub.db");string id;
        try {
            using(var repo=new HubRepository(path)) {repo.Initialize();id=repo.CreateJob(new(){Platform="x",Kind="profile",Url="https://x.com/synthetic"},root).Id;repo.UpdateJob(id,"needs_action",reasonCode:"rate_limited");}
            using(var legacy=new SqliteConnection($"Data Source={path};Pooling=False")) {
                legacy.Open();using var command=legacy.CreateCommand();
                // Exact positional INSERT used by preview.2, against the upgraded database.
                command.CommandText="INSERT INTO jobs VALUES ($id,$source,$status,$completeness,NULL,$created,$updated,$root)";
                foreach(var pair in new[]{("$id","legacy-job"),("$source","{\"platform\":\"x\",\"kind\":\"profile\"}"),("$status","ready"),("$completeness","unknown"),("$created","legacy-created"),("$updated","legacy-updated"),("$root",root)})command.Parameters.AddWithValue(pair.Item1,pair.Item2);
                Assert.Equal(1,command.ExecuteNonQuery());command.Parameters.Clear();
                command.CommandText="UPDATE jobs SET status='completed',updated_at='legacy-next' WHERE id=$id";command.Parameters.AddWithValue("$id",id);Assert.Equal(1,command.ExecuteNonQuery());
            }
            using var reopened=new HubRepository(path);reopened.Initialize();Assert.Equal(2,reopened.ListJobs().Count);Assert.Null(reopened.GetJob(id)!.ReasonCode);Assert.Equal("ready",reopened.GetJob("legacy-job")!.Status);
            reopened.UpdateJob(id,"needs_action",reasonCode:"browser_closed");Assert.Equal("browser_closed",reopened.GetJob(id)!.ReasonCode);
            reopened.UpdateJob(id,"paused");Assert.Equal("browser_closed",reopened.GetJob(id)!.ReasonCode);
            reopened.UpdateJob(id,"ready",clearReason:true);Assert.Null(reopened.GetJob(id)!.ReasonCode);
        } finally {Directory.Delete(root,true);}
    }
    [Fact]
    public void ReasonWriteFailureRollsBackJobUpdate()
    {
        var root=Path.Combine(Path.GetTempPath(),"umh-reason-atomic-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);var path=Path.Combine(root,"hub.db");
        try {
            using var repo=new HubRepository(path);repo.Initialize();var job=repo.CreateJob(new(){Platform="x",Kind="profile"},root);
            using(var sql=new SqliteConnection($"Data Source={path};Pooling=False")){sql.Open();using var c=sql.CreateCommand();c.CommandText="CREATE TRIGGER reject_reason BEFORE INSERT ON job_reasons BEGIN SELECT RAISE(ABORT,'synthetic full'); END";c.ExecuteNonQuery();}
            Assert.Throws<SqliteException>(()=>repo.UpdateJob(job.Id,"failed",reasonCode:"disk_full"));var after=repo.GetJob(job.Id)!;Assert.Equal(job.Status,after.Status);Assert.Equal(job.UpdatedAt,after.UpdatedAt);Assert.Null(after.ReasonCode);
        } finally {Directory.Delete(root,true);}
    }
}
