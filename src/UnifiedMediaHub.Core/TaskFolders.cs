using System.Text.RegularExpressions;
namespace UnifiedMediaHub.Core;

// One folder per download task: "<what>_<whose / which>_<yyyy-MM-dd_HHmm>", e.g.
// "我的喜欢_小号_2026-11-19_2005", "收藏夹_板鞋_2026-11-19_2005", "作者_某某_2026-11-19_2005".
// Same single-segment rules as worker paths.validTaskFolder (safeSegment, 80 code points).
public static class TaskFolders
{
    public static string Name(HubJob job,Func<IEnumerable<ContentItem>> items,string? accountName,DateTimeOffset now)
    {
        var s=job.Source;var bridge=s.Kind=="bridge";
        var kind=bridge?s.Bridge?.ListKind??"bridge":s.Kind;
        var what=kind switch {"liked"=>"我的喜欢","saved"=>"全部收藏","saved_folder"=>"收藏夹","chat"=>"聊天","topic"=>"话题","profile"=>"作者","single"=>"单条","collection"=>"合集",_=>"下载"};
        var who=kind switch
        {
            "liked" or "saved"=>bridge?s.Bridge?.ViewerName:accountName,
            "saved_folder"=>bridge?s.Bridge?.FolderTitle:s.Label,
            "chat" or "topic"=>s.Label,
            "profile" or "single" or "collection"=>items().Select(i=>i.Author).Where(a=>!string.IsNullOrWhiteSpace(a)).GroupBy(a=>a).OrderByDescending(g=>g.Count()).Select(g=>g.Key).FirstOrDefault(),
            _=>null
        };
        var stamp=now.ToLocalTime().ToString("yyyy-MM-dd_HHmm",System.Globalization.CultureInfo.InvariantCulture);
        who=Clean(who,40);
        return Clean(string.IsNullOrEmpty(who)?$"{what}_{stamp}":$"{what}_{who}_{stamp}",80) is {Length:>0} name?name:$"下载_{stamp}";
    }
    // Mirrors worker paths.safeSegment: drop control and path characters, collapse whitespace,
    // trim trailing spaces/dots, keep at most max code points, prefix reserved device names.
    public static string Clean(string? text,int max)
    {
        var clean=Regex.Replace(text??"","[\\p{Cc}<>:\"/\\\\|?*]","");
        clean=Regex.Replace(clean,"[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+"," ").Trim(' ').TrimEnd(' ','.');
        clean=string.Concat(clean.EnumerateRunes().Take(max).Select(r=>r.ToString())).TrimEnd(' ','.');
        if(clean.Length>0&&Regex.IsMatch(clean.Split('.')[0],"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant))clean="_"+clean;
        return clean;
    }
}
