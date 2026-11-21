namespace UnifiedMediaHub.Core;

public static class ContentIdentity
{
    public static string KeyFor(ContentItem item)
    {
        ArgumentNullException.ThrowIfNull(item);
        var platform = item.Platform;
        if (platform is not ("x" or "telegram" or "douyin" or "xiaohongshu"))
            throw new ArgumentException("Unsupported content platform.", nameof(item));
        if (platform == "telegram")
        {
            ValidateId(item.ChatId, "chat ID");
            if (string.IsNullOrEmpty(item.MessageId) || !item.MessageId.All(char.IsAsciiDigit))
                throw new ArgumentException("Telegram content requires a numeric message ID.", nameof(item));
            return $"telegram:{item.ChatId!.ToLowerInvariant()}:{item.MessageId}";
        }
        ValidateId(item.ContentId, "content ID");
        return $"{platform}:{item.ContentId}";
    }

    private static void ValidateId(string? value, string name)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 200 || !value.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-'))
            throw new ArgumentException($"Missing or invalid {name}.");
    }
}
