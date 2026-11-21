using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class ShareTextClassificationTests
{
    [Theory]
    [InlineData("1.71 A@g.OK 02/21 hbA:/ :1pm 这是合成分享文案！ # 示例 https://v.douyin.com/SyntheticOnly/ 复制此链接，打开Dou音搜索，直接观看视频！", "https://v.douyin.com/SyntheticOnly/", "douyin")]
    [InlineData("分享推文\r\nhttps://x.com/alice/status/123/photo/2\r\n看看这张图", "https://x.com/alice/status/123/photo/2", "x")]
    [InlineData("分享（https://www.douyin.com/video/123）", "https://www.douyin.com/video/123", "douyin")]
    [InlineData("【笔记】 https://www.xiaohongshu.com/explore/abc?xsec_token=a%2Bb%2Fc%3D&xsec_source=pc 复制打开", "https://www.xiaohongshu.com/explore/abc?xsec_token=a%2Bb%2Fc%3D&xsec_source=pc", "xiaohongshu")]
    [InlineData("消息 https://t.me/channel/55/789?thread=55 查看", "https://t.me/channel/55/789?thread=55", "telegram")]
    public void ShareTextPreservesExactIntent(string input,string url,string platform)
    {
        Assert.True(SourceClassifier.TryClassify(input,out var source,out var error),error);
        Assert.Equal(url,source!.Url); Assert.Equal(platform,source.Platform);
        Assert.Equal("single",source.Kind); Assert.Null(source.AccountId);
    }

    [Theory]
    [InlineData("两个 https://x.com/a/status/123 https://www.douyin.com/video/456")]
    [InlineData("来源 https://example.org/page 作品 https://x.com/a/status/123")]
    [InlineData("同一链接 https://x.com/a/status/123 https://x.com/a/status/123")]
    public void MultipleLinksRequireAChoice(string input)
    { Assert.False(SourceClassifier.TryClassify(input,out var source,out var error));Assert.Null(source);Assert.Contains("多个",error); }

    [Theory]
    [InlineData("分享 https://x.com.evil.example/a/status/123 查看")]
    [InlineData("分享 https://user:secret@x.com/a/status/123 查看")]
    [InlineData("分享 https://x.com:8123/a/status/123 查看")]
    [InlineData("分享 https://x.com/i/bookmarks/123 查看")]
    [InlineData("分享 https://evil.example/?next=https://x.com/a/status/123 查看")]
    [InlineData("没有链接，只有文字")]
    public void InvalidOrUnsupportedShareDoesNotBroaden(string input)
    { Assert.False(SourceClassifier.TryClassify(input,out var source,out _));Assert.Null(source); }

    [Fact] public void OversizedShareIsRejectedBeforeParsing()
    { Assert.False(SourceClassifier.TryClassify(new string('字',16385)+" https://x.com/a/status/123",out var source,out _));Assert.Null(source); }

    [Fact] public void PureSignedUrlIsNotRewritten()
    {
        const string url="https://www.xiaohongshu.com/explore/abc?xsec_token=a%2B%2F%3D+.,&xsec_source=pc";
        Assert.True(SourceClassifier.TryClassify(url,out var source,out _));Assert.Equal(url,source!.Url);
    }
}
