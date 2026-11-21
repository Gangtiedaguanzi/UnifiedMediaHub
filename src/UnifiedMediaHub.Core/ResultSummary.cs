using System.Text.Json;
namespace UnifiedMediaHub.Core;
public sealed class ResultSummary
{
    public int Works {get;init;} public int SelectedWorks {get;init;} public int KnownAssets {get;init;}
    public int Completed {get;init;} public int Skipped {get;init;} public int Failed {get;init;} public int Pending {get;init;}
    public int UnresolvedWorks {get;init;} public int DuplicateAssets {get;init;}
    public string Display=>$"作品 {Works}（已选 {SelectedWorks}） · 已知媒体 {KnownAssets} · 完成 {Completed} / 跳过 {Skipped} / 失败 {Failed} / 待处理 {Pending} · 未解析作品 {UnresolvedWorks} · 已检测字节重复 {DuplicateAssets}";
    public static ResultSummary From(IEnumerable<ContentItem> items,IEnumerable<DownloadReceipt> receipts,bool selectedOnly=true)
    {
        var all=items.ToArray();var scope=all.Where(i=>!selectedOnly||i.Selected).ToArray();
        var latest=receipts.GroupBy(r=>(r.ContentKey,r.MediaIndex)).ToDictionary(g=>g.Key,g=>g.Last());
        int completed=0,skipped=0,failed=0,pending=0,duplicates=0;
        foreach(var item in scope)foreach(var asset in item.Media){latest.TryGetValue((item.Key,asset.Index),out var receipt);switch(receipt?.Status){case "completed":completed++;break;case "skipped":skipped++;break;case "failed":failed++;break;default:pending++;break;}if(receipt?.Status is "completed" or "skipped" && receipt.DuplicateOfContentKey!=null)duplicates++;}
        return new(){Works=all.Length,SelectedWorks=all.Count(i=>i.Selected),KnownAssets=scope.Sum(i=>i.Media.Count),Completed=completed,Skipped=skipped,Failed=failed,Pending=pending,UnresolvedWorks=scope.Count(i=>!i.MediaResolved),DuplicateAssets=duplicates};
    }
}
public static class SanitizedReport
{
    public static string Create(HubRepository repository,string? storageWarning=null)
    {
        var aliases=new Dictionary<string,string>();string Alias(string key){if(!aliases.TryGetValue(key,out var value))aliases[key]=value="work-"+(aliases.Count+1);return value;}
        var jobs=repository.ListJobs().Select((j,index)=>{
            var items=repository.ListItems(j.Id);var receipts=repository.ListLatestReceipts(j.Id);
            return new {job="task-"+(index+1),platform=UserText.Platform(j.Source.Platform),sourceType=UserText.Kind(j.Source.Kind),status=UserText.Status(j.Status),j.Completeness,reasonCode=UserText.SafeCode(j.ReasonCode),advice= j.ReasonCode==null?null:UserText.Error(j.ReasonCode),summary=ResultSummary.From(items,receipts),works=items.Select(i=>new {work=Alias(i.Key),i.Selected,unresolved=!i.MediaResolved,knownAssets=i.Media.Count}),receipts=receipts.Select(r=>new{work=Alias(r.ContentKey),r.MediaIndex,r.Bytes,r.Status,error=UserText.SafeCode(r.ErrorCode),duplicateOf=r.DuplicateOfContentKey==null?null:Alias(r.DuplicateOfContentKey),r.DuplicateOfMediaIndex})};
        }).ToArray();
        var diagnostics=DiagnosticLog.ReadRecent(Path.Combine(Path.GetDirectoryName(repository.DatabasePath)!,"diagnostics"));
        return JsonSerializer.Serialize(new {format="UnifiedMediaHub sanitized report v3",generatedAt=DateTimeOffset.Now,verification="离线预览；真实平台验收未完成",storageWarning=UserText.SafeCode(storageWarning),jobs,diagnostics},new JsonSerializerOptions(HubJson.Options){WriteIndented=true});
    }
}
