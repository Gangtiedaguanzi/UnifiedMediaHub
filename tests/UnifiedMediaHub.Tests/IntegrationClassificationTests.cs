using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public class IntegrationClassificationTests
{
    [Theory]
    [InlineData("https://x.com/alice/media", "x", "profile")]
    [InlineData("https://x.com/alice/with_replies", "x", "profile")]
    [InlineData("https://x.com/alice/status/123/photo/2", "x", "single")]
    [InlineData("https://x.com/alice/status/123/video/1", "x", "single")]
    [InlineData("https://www.douyin.com/user/author?modal_id=123", "douyin", "single")]
    [InlineData("https://www.xiaohongshu.com/user/profile/author/note?xsec_token=secret", "xiaohongshu", "single")]
    [InlineData("https://www.xiaohongshu.com/user/profile/author?tab=fav", "xiaohongshu", "saved")]
    [InlineData("https://www.xiaohongshu.com/user/profile/author?tab=liked", "xiaohongshu", "liked")]
    public void RecognizesIntentWithoutBindingAuthor(string url, string platform, string kind)
    {
        Assert.True(SourceClassifier.TryClassify(url, out var source, out _));
        Assert.Equal(platform, source!.Platform); Assert.Equal(kind, source.Kind);
        Assert.Equal(url, source.Url); Assert.Null(source.AccountId);
    }

    [Theory]
    [InlineData("https://x.com/i/bookmarks/123")]
    [InlineData("https://www.douyin.com/user/author?modal_id=bad")]
    [InlineData("https://t.me/channel/123?comment=456")]
    public void UnsupportedIntentNeverBroadens(string url) => Assert.False(SourceClassifier.TryClassify(url, out _, out _));

    [Theory]
    [InlineData("https://www.douyin.com/user/otherAuthor")]
    [InlineData("https://www.xiaohongshu.com/user/profile/otherAuthor")]
    public void PublicAuthorDoesNotMeanAuthenticatedIdentity(string url)
    { Assert.True(SourceClassifier.TryClassify(url, out var source, out _)); Assert.Null(source!.AccountId); }
}
