using UnifiedMediaHub.Core;using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class DouyinSourceTests{
 [Theory]
 [InlineData("https://www.iesdouyin.com/share/video/123456/?share=synthetic")]
 [InlineData("https://www.iesdouyin.com/share/note/123456/")]
 [InlineData("https://www.iesdouyin.com/share/slides/123456/")]
 [InlineData("https://iesdouyin.com/share/slides/123456/")]
 [InlineData("https://www.douyin.com/jingxuan?modal_id=123456")]
 [InlineData("https://douyin.com/discover?modal_id=123456")]
 public void SupportedPhotoShareAndModalRoutesAreSingle(string url){Assert.True(SourceClassifier.TryClassify(url,out var source,out _));Assert.Equal("douyin",source!.Platform);Assert.Equal("single",source.Kind);}
 [Theory]
 [InlineData("https://iesdouyin.com.foreign.invalid/share/slides/123456/")]
 [InlineData("https://iesdouyin.com/share/slides/abc/")]
 [InlineData("https://iesdouyin.com/share/slides/123456/extra")]
 [InlineData("https://iesdouyin.com/share/slides/%2f123456")]
 [InlineData("https://www.douyin.com/jingxuan")]
 [InlineData("https://www.douyin.com/discover?modal_id=123&modal_id=456")]
 [InlineData("https://www.douyin.com/discover?modal_id=abc")]
 [InlineData("https://www.douyin.com/unknown?modal_id=123456")]
 public void InvalidPhotoAndModalRoutesAreRejected(string url){Assert.False(SourceClassifier.TryClassify(url,out _,out _));}
}
