using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class ShareTextIndependentTests
{
    [Theory]
    [InlineData("javascript:https://x.com/alice/status/123")]
    [InlineData("file:///C:/https://www.douyin.com/video/123")]
    [InlineData("ftp://example.test/https://x.com/alice/status/123")]
    public void UnsupportedAbsoluteUriCannotBecomeEmbeddedPlatformSource(string text)
    {Assert.False(SourceClassifier.TryClassify(text,out var source,out _));Assert.Null(source);}
    [Theory]
    [InlineData("https://user:secret@x.com/alice/status/123")]
    [InlineData("https://x.com:8123/alice/status/123")]
    [InlineData("https://x.com.evil.example/alice/status/123")]
    public void PureUnsafeUrlStillRejected(string text)
    {Assert.False(SourceClassifier.TryClassify(text,out var source,out _));Assert.Null(source);}
    [Fact] public void SignedDirectUrlKeepsEveryByte()
    {const string text="https://www.xiaohongshu.com/explore/abc?xsec_token=a%2fb%2Bc%3D&xsec_source=pc#fragment";Assert.True(SourceClassifier.TryClassify(text,out var source,out _));Assert.Equal(text,source!.Url);}
    [Fact] public void DifferentCaseSecondUrlStillRequiresSelection()
    {Assert.False(SourceClassifier.TryClassify("分享 https://v.douyin.com/Synthetic/ 第二个 HTTPS://X.COM/alice/status/123",out var source,out _));Assert.Null(source);}
}
