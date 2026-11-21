using System.Text.RegularExpressions;

namespace UnifiedMediaHub.Core;

public static class SourceClassifier
{
    private static readonly Regex SharedUrls = new("https?://[^\\s<>\"“”‘’「」《》（）【】]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public static bool TryClassify(string input, out SourceRequest? source, out string? error)
    {
        source = null;
        error = "请粘贴一个平台链接，或只含一个链接的分享文案。";
        if (string.IsNullOrWhiteSpace(input) || input.Length > 16384) return false;
        var text = input.Trim();
        // Keep direct signed URLs byte-for-byte. Share extraction is local and never follows links.
        if (!text.Any(char.IsWhiteSpace) && Uri.TryCreate(text, UriKind.Absolute, out _))
            return TryClassifyUrl(text, out source, out error);
        var matches = SharedUrls.Matches(text);
        if (matches.Count != 1)
        {
            error = matches.Count > 1 ? "检测到多个链接，请一次只粘贴一个作品或来源的链接。" : "未找到可识别的平台链接。";
            return false;
        }
        var url = matches[0].Value.TrimEnd('。', '，', '！', '？', '；', '、');
        return TryClassifyUrl(url, out source, out error);
    }

    private static bool TryClassifyUrl(string input, out SourceRequest? source, out string? error)
    {
        source = null;
        error = "Unsupported or invalid source URL.";
        if (!Uri.TryCreate(input?.Trim(), UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("https" or "http") || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo)) return false;
        var host = uri.IdnHost.ToLowerInvariant();
        var parts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.UnescapeDataString).ToArray();
        if (parts.Any(p => p.Contains('/') || p.Contains('\\') || p is "." or "..")) return false;
        var result = new SourceRequest { Url = input!.Trim(), Label = host };
        var query = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2)).GroupBy(p => Uri.UnescapeDataString(p[0]))
            .ToDictionary(g => g.Key, g => g.Select(p => p.Length > 1 ? Uri.UnescapeDataString(p[1]) : "").ToArray());
        if (host is "t.co" or "v.douyin.com" or "xhslink.com" or "www.xhslink.com")
        {
            if (parts.Length == 0) return false;
            result.Platform = host == "t.co" ? "x" : host == "v.douyin.com" ? "douyin" : "xiaohongshu";
            result.Kind = "single"; // Provisional: the worker resolves the platform's short link.
        }
        else if (host is "x.com" or "www.x.com" or "twitter.com" or "www.twitter.com" or "mobile.twitter.com")
        {
            result.Platform = "x";
            if (parts is ["i", "bookmarks"]) result.Kind = "saved";
            else if (parts is ["i", "bookmarks", ..]) { error = "暂不支持书签文件夹；请使用“我的收藏”入口。"; return false; }
            else if (parts is ["i", "likes"] or ["i", "history", "likes"]) result.Kind = "liked";
            else if (parts is [_, "status", var id] && Digits(id)) result.Kind = "single";
            else if (parts is [_, "status", var post, "photo" or "video", var number] && Digits(post) && Digits(number)) result.Kind = "single";
            else if (parts is [var author, "media" or "with_replies"] && Identifier(author) && author != "i") result.Kind = "profile";
            else if (parts is [var profile] && Identifier(profile) && profile is not ("i" or "home" or "explore" or "settings" or "search" or "notifications" or "messages")) result.Kind = "profile";
            else return false;
        }
        else if (host is "douyin.com" or "www.douyin.com")
        {
            result.Platform = "douyin";
            if (parts is ["video" or "note", var id] && Identifier(id)) result.Kind = "single";
            else if(parts is ["jingxuan" or "discover"] && query.TryGetValue("modal_id",out var work) && work.Length==1 && Digits(work[0]))result.Kind="single";
            else if (parts is ["user", var account] && Identifier(account))
            {
                result.Kind = "profile";
                if (query.TryGetValue("modal_id", out var modal))
                { if (modal.Length != 1 || !Digits(modal[0])) return false; result.Kind = "single"; }
            }
            else return false;
        }
        else if(host is "iesdouyin.com" or "www.iesdouyin.com")
        {
            if(parts is not ["share","video" or "note" or "slides",var work] || !Digits(work))return false;
            result.Platform="douyin";result.Kind="single";
        }
        else if (host is "xiaohongshu.com" or "www.xiaohongshu.com")
        {
            result.Platform = "xiaohongshu";
            if ((parts is ["explore" or "search_result", var id] && Identifier(id)) || (parts is ["discovery", "item", var discoveryId] && Identifier(discoveryId))) result.Kind = "single";
            else if (parts is ["user", "profile", var author, var note] && Identifier(author) && Identifier(note)) result.Kind = "single";
            else if (parts is ["user", "profile", var account] && Identifier(account))
            {
                result.Kind = "profile";
                if (query.TryGetValue("tab", out var tabs))
                { if (tabs.Length != 1) return false; result.Kind = tabs[0] switch { "fav" => "saved", "liked" => "liked", _ => "profile" }; }
            }
            else return false;
        }
        else if (host is "t.me" or "www.t.me" or "telegram.me" or "www.telegram.me")
        {
            result.Platform = "telegram";
            if (query.ContainsKey("comment")) { error = "暂不支持讨论区跳转；请粘贴讨论消息的直接链接或选择聊天。"; return false; }
            if (parts.Length > 0 && (parts[0].StartsWith('+') || parts[0] == "joinchat"))
            { error = "Telegram invite links require explicit chat selection; no automatic join."; return false; }
            var offset = parts.Length > 0 && parts[0] == "c" ? 2 : 1;
            if (parts.Length < offset || !Identifier(parts[offset - 1])) return false;
            if (offset == 2 && !Digits(parts[1])) return false;
            result.ChatId = offset == 2 ? "-100" + parts[1] : parts[0].ToLowerInvariant();
            if (parts.Length == offset) result.Kind = "chat";
            else if (parts.Length == offset + 1 && Digits(parts[offset])) { result.Kind = "single"; result.MessageId = parts[offset]; }
            else if (parts.Length == offset + 2 && Digits(parts[offset]) && Digits(parts[offset + 1]))
            { result.Kind = "single"; result.TopicId = parts[offset]; result.MessageId = parts[offset + 1]; }
            else return false;
            foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var values = pair.Split('=', 2);
                if (values is ["thread", var thread] && Digits(thread)) result.TopicId = thread;
            }
        }
        else return false;
        source = result;
        error = null;
        return true;
    }

    private static bool Digits(string value) => value.Length > 0 && value.All(char.IsAsciiDigit);
    private static bool Identifier(string value) => value.Length > 0 && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-');
}
