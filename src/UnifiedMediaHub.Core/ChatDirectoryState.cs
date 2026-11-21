using System.Globalization;
using System.Text;
namespace UnifiedMediaHub.Core;

// One explicit directory attempt. No titles or partial rows establish account ownership.
public sealed class ChatDirectoryState
{
    public const int Limit=5000;
    readonly Dictionary<string,WorkerChat> chats=new(StringComparer.Ordinal);
    string? account;
    bool verified,open;
    public string? JobId {get;private set;}
    public string Status {get;private set;}="unknown";
    public string Completeness {get;private set;}="unknown";
    public IReadOnlyList<WorkerChat> Chats=>chats.Values.ToArray();
    public static bool IsDirectory(SourceRequest? source)=>source is {Platform:"telegram",Kind:"chat",ChatId:null,MessageId:null,TopicId:null}&&source.Url=="https://t.me/";
    public static SourceRequest Source(string? account)
    {
        if(!long.TryParse(account,NumberStyles.None,CultureInfo.InvariantCulture,out var accountId)||accountId<1||account!=accountId.ToString(CultureInfo.InvariantCulture))throw new InvalidOperationException("请先在“账号”页确认 Telegram 账号，再读取聊天目录。");
        return new(){Platform="telegram",Kind="chat",Url="https://t.me/",AccountId=account,MaxItems=Limit};
    }
    public void Clear(){JobId=null;account=null;verified=false;open=false;chats.Clear();Status="unknown";Completeness="unknown";}
    public void Begin(string jobId,string accountId){Source(accountId);Clear();JobId=jobId;account=accountId;open=true;Status="running";}
    public bool Matches(string? currentAccount)=>JobId!=null&&account==currentAccount;
    public void Stop(string status){open=false;Status=status;}
    public bool Accept(string jobId,string? currentAccount,WorkerEvent value)
    {
        if(JobId!=jobId)return false;
        if(!Matches(currentAccount)){Clear();return false;}
        if(!open)return false;
        switch(value.Type)
        {
            case "account":
                if(value.Platform!="telegram"||value.Authenticated!=true||value.AccountId!=account){chats.Clear();verified=false;Stop("needs_action");return true;}
                verified=true;return true;
            case "chat":
                if(!verified||value.Chat==null)return false;
                var chat=value.Chat;Validate(chat);
                if(!chats.ContainsKey(chat.Id)&&chats.Count>=Limit)throw new InvalidDataException("Chat directory limit exceeded.");
                chats[chat.Id]=new(){Id=chat.Id,Title=chat.Title,Username=chat.Username};return true;
            case "complete":
                if(!verified)return false;
                if(value.Status is not ("completed" or "failed" or "paused" or "needs_action")||value.Completeness is not ("complete" or "partial" or "unknown"))return false;
                Completeness=value.Completeness;Stop(value.Status);return true;
            case "needs_action":case "error":Stop(value.Type=="error"?"failed":"needs_action");return true;
            default:return false;
        }
    }
    public bool CanSelect(string? id,string? currentAccount)=>verified&&Status=="completed"&&Matches(currentAccount)&&id!=null&&chats.ContainsKey(id);
    public SourceRequest Select(string? id,string? currentAccount,SourceRequest? original)
    {
        if(!CanSelect(id,currentAccount))throw new InvalidOperationException("请重新读取当前 Telegram 账号的聊天目录，再选择聊天。");
        if(original?.AccountId!=null&&original.AccountId!=account)throw new InvalidOperationException("链接绑定账号与本次目录不同。");
        if(original?.ChatId is string target)
        {
            if(target.StartsWith("-100",StringComparison.Ordinal))target="channel_"+target[4..];
            if(target!=id&&!string.Equals(target,chats[id!].Username,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("所选聊天与粘贴链接不同，请清空链接或选择匹配聊天。");
        }
        return ChatSources.Select(chats[id!],null,account,original);
    }
    public static void Validate(WorkerChat chat)
    {
        var parts=(chat.Id??"").Split('_');
        var username=chat.Username;
        if(parts.Length!=2||parts[0] is not ("user" or "chat" or "channel")||!long.TryParse(parts[1],NumberStyles.None,CultureInfo.InvariantCulture,out var id)||id<1||parts[1]!=id.ToString(CultureInfo.InvariantCulture)
            ||string.IsNullOrWhiteSpace(chat.Title)||chat.Title.EnumerateRunes().Count()>500||chat.Title.EnumerateRunes().Any(r=>Rune.GetUnicodeCategory(r)==UnicodeCategory.Control)
            ||username!=null&&(username.Length is <1 or >64||!char.IsAsciiLetter(username[0])||username.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c!='_')))throw new InvalidDataException("Invalid chat directory row.");
    }
}
