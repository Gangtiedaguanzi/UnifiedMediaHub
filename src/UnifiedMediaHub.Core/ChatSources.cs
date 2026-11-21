namespace UnifiedMediaHub.Core;
public static class ChatSources
{
    public static SourceRequest Select(WorkerChat chat,string? topic,string? account,SourceRequest? original=null)
    {
        var parts=chat.Id.Split('_');
        if(parts.Length!=2 || parts[0] is not ("user" or "chat" or "channel") || !long.TryParse(parts[1],out var id) || id<1 || parts[1]!=id.ToString())throw new InvalidOperationException("聊天身份尚未确认，请重新获取聊天列表。");
        if(!string.IsNullOrEmpty(topic) && (!int.TryParse(topic,out var topicId) || topicId<1))throw new InvalidOperationException("话题标识无效。");
        if(original?.MessageId!=null || original?.TopicId!=null)
        {
            var originalChat=original.ChatId;
            if(originalChat?.StartsWith("-100",StringComparison.Ordinal)==true)originalChat="channel_"+originalChat[4..];
            if(originalChat!=chat.Id && !(chat.Username!=null && string.Equals(original.ChatId,chat.Username,StringComparison.OrdinalIgnoreCase)))throw new InvalidOperationException("所选聊天与粘贴的消息链接不同。请清空链接后选择整个聊天，或选择该消息对应的聊天。");
        }
        return new(){Platform="telegram",Kind=original?.MessageId!=null?"single":string.IsNullOrEmpty(original?.TopicId??topic)?"chat":"topic",Url=original?.MessageId!=null?original.Url:"https://t.me/",ChatId=chat.Id,MessageId=original?.MessageId,TopicId=original?.TopicId??(string.IsNullOrEmpty(topic)?null:topic),AccountId=original?.AccountId??account,Label=chat.Title};
    }
}
