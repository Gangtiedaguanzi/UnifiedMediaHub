namespace UnifiedMediaHub.Core;

public sealed class WorkerFolder
{
    public string Id {get;set;}="";
    public string Title {get;set;}="";
    public long? ItemCount {get;set;}
    [System.Text.Json.Serialization.JsonIgnore]
    public string Display=>Title+(ItemCount is long count?$" · {count} 项":" · 数量未知");
}

public static class SavedFolders
{
    public const int Limit=50;
    public static int DirectoryLimit(SourceRequest source)=>Math.Min(source.MaxItems>0?source.MaxItems:Limit,Limit);
    public static bool ValidId(string? id)=>id is {Length:>=1 and <=128} && id.All(c=>char.IsAsciiLetterOrDigit(c)||c is '_' or '-');
    public static void Validate(WorkerFolder? folder)
    {
        if(folder==null || !ValidId(folder.Id) || string.IsNullOrWhiteSpace(folder.Title) || folder.Title.Length>256 || folder.Title.Any(char.IsControl) || folder.ItemCount is <0 or >9007199254740991L)
            throw new InvalidDataException("Invalid saved folder.");
    }
    public static void ValidateDirectory(SourceRequest source)
    {
        if(source.Platform is not ("douyin" or "xiaohongshu") || source.Kind!="saved_folders" || source.FolderId!=null || source.MaxItems<0 || string.IsNullOrWhiteSpace(source.AccountId) || source.AccountId.Length>200 || source.AccountId.Any(char.IsControl))
            throw new ArgumentException("A folder directory requires its bound account and platform.");
    }
    public static void ValidateSource(SourceRequest source)
    {
        if(source.Kind=="saved_folders"){ValidateDirectory(source);return;}
        if(source.Kind!="saved_folder") {if(source.FolderId!=null)throw new ArgumentException("Folder scope cannot be broadened.");return;}
        if(!ValidId(source.FolderId))throw new ArgumentException("A saved folder requires an explicit ID.");
        ValidateDirectory(new(){Platform=source.Platform,Kind="saved_folders",AccountId=source.AccountId});
    }
    public static SourceRequest Select(SourceRequest directory,WorkerFolder folder,int maxItems=Limit)
    {
        ValidateDirectory(directory);Validate(folder);
        if(maxItems<1 || maxItems>10000)throw new ArgumentOutOfRangeException(nameof(maxItems));
        return new(){Platform=directory.Platform,Kind="saved_folder",Url=directory.Url,AccountId=directory.AccountId,FolderId=folder.Id,Label=folder.Title,MaxItems=maxItems};
    }
}

// UI state is tied to one directory attempt; titles never identify a selection.
public sealed class SavedFolderPicker
{
    readonly Dictionary<string,WorkerFolder> folders=new(StringComparer.Ordinal);
    SourceRequest? source;
    public string? JobId {get;private set;}
    public IReadOnlyList<WorkerFolder> Folders=>folders.Values.ToArray();
    public void Clear(){JobId=null;source=null;folders.Clear();}
    public void Begin(string jobId,SourceRequest directory)
    {
        SavedFolders.ValidateDirectory(directory);Clear();JobId=jobId;
        source=new(){Platform=directory.Platform,Kind="saved_folders",AccountId=directory.AccountId,Url=directory.Url,MaxItems=directory.MaxItems};
    }
    public bool Matches(string platform,string? account)=>source!=null && source.Platform==platform && source.AccountId==account;
    public bool Accept(string jobId,SourceRequest directory,string currentPlatform,string? currentAccount,WorkerFolder folder)
    {
        if(JobId!=jobId || !Matches(currentPlatform,currentAccount) || source!.Platform!=directory.Platform || source.AccountId!=directory.AccountId || source.Url!=directory.Url || directory.Kind!="saved_folders")return false;
        SavedFolders.Validate(folder);
        if(!folders.ContainsKey(folder.Id)&&folders.Count>=SavedFolders.DirectoryLimit(source))throw new InvalidDataException("Folder directory limit exceeded.");
        folders[folder.Id]=new(){Id=folder.Id,Title=folder.Title,ItemCount=folder.ItemCount};return true;
    }
    public SourceRequest Select(string? id,string platform,string? account,int maxItems=SavedFolders.Limit)
    {
        if(!Matches(platform,account) || id==null || !folders.TryGetValue(id,out var folder))throw new InvalidOperationException("请先从本次目录中选择收藏夹／专辑。");
        return SavedFolders.Select(source!,folder,maxItems);
    }
}
