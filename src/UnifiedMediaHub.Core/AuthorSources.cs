namespace UnifiedMediaHub.Core;

public static class AuthorSources
{
    public static bool TryGet(ContentItem item, out SourceRequest? source)
    {
        source = null;
        if (string.IsNullOrWhiteSpace(item.AuthorUrl) || !SourceClassifier.TryClassify(item.AuthorUrl, out var found, out _) || found!.Platform != item.Platform || found.Kind != "profile") return false;
        source = found;
        return true;
    }
}
