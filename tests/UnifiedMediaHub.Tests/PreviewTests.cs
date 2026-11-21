using System.Net;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class PreviewTests : IDisposable
{
    readonly string root=Path.Combine(Path.GetTempPath(),"UMH-preview",Guid.NewGuid().ToString("N"));
    public PreviewTests()=>Directory.CreateDirectory(root);
    public void Dispose()=>Directory.Delete(root,true);
    // Complete valid 1x1 PNG, not a header-only stand-in.
    public static readonly byte[] Png=Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=");
    [Fact]
    public async Task WebpCoversHaveBoundedEncodedDimensionsAndCanBeCached()
    {
        var webp=Convert.FromBase64String("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA");
        var handler=new FixtureHttp(_=>new(HttpStatusCode.OK){Content=new ByteArrayContent(webp)}); await using var cache=new PreviewCache(root,handler); cache.Enable();
        Assert.NotNull(await cache.LoadAsync("xiaohongshu","https://sns-webpic-qc.xhscdn.com/a"));
        webp[26]=255;webp[27]=63;webp[28]=255;webp[29]=63; Assert.False(PreviewImage.HasSafeDimensions(webp));
    }
    [Fact]
    public void ExtendedAndLosslessWebpHeadersRejectHugeCanvases()
    {
        var lossless=Convert.FromHexString("5249464616000000574542505650384C090000002F00000000000000000000");
        Assert.True(PreviewImage.TryGetDimensions(lossless,out var width,out var height));Assert.Equal(1,width);Assert.Equal(1,height);
        lossless[21]=255;lossless[22]=255;lossless[23]=255;lossless[24]=15;Assert.False(PreviewImage.HasSafeDimensions(lossless));
        var extended=Convert.FromHexString("524946461600000057454250565038580A0000000000000000000000000000");
        Assert.True(PreviewImage.HasSafeDimensions(extended));extended[24]=255;extended[25]=255;extended[26]=255;Assert.False(PreviewImage.HasSafeDimensions(extended));
    }
    [Fact]
    public void GifFrameCannotExceedItsSmallLogicalCanvas()
    {
        var gif=Convert.FromHexString("474946383961010001000000002C000000001027102700020100003B");
        Assert.False(PreviewImage.HasSafeDimensions(gif));
    }
    [Fact]
    public async Task PlatformStopCancelsOnlyItsPreviewsAndBlocksNewRequestsUntilExplicitEnable()
    {
        var started=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler=new FixtureHttp(async(_,ct)=>{started.TrySetResult();await Task.Delay(Timeout.Infinite,ct);return new(HttpStatusCode.OK);});
        await using var cache=new PreviewCache(root,handler);cache.Enable();var x=cache.LoadAsync("x","https://pbs.twimg.com/media/a");await started.Task;
        await cache.StopAsync("x");await x;var before=handler.Calls;Assert.Null(await cache.LoadAsync("x","https://pbs.twimg.com/media/b"));Assert.Equal(before,handler.Calls);
    }
    [Theory]
    [InlineData("https://localhost/a")]
    [InlineData("http://pbs.twimg.com/a")]
    [InlineData("https://pbs.twimg.com.evil.test/a")]
    [InlineData("file:///C:/private")]
    [InlineData("https://127.0.0.1/a")]
    [InlineData("https://user:pass@pbs.twimg.com/a")]
    public async Task UntrustedPreviewNeverSendsRequest(string url)
    {
        var handler=new FixtureHttp(_=>new(HttpStatusCode.OK){Content=new ByteArrayContent(Png)}); await using var cache=new PreviewCache(root,handler); cache.Enable();
        Assert.Null(await cache.LoadAsync("x",url)); Assert.Equal(0,handler.Calls);
    }
    [Fact]
    public async Task DisabledNeverFetchesButCachedImageCanDisplayOffline()
    {
        var handler=new FixtureHttp(_=>new(HttpStatusCode.OK){Content=new ByteArrayContent(Png)}); await using var cache=new PreviewCache(root,handler);
        Assert.Null(await cache.LoadAsync("x","https://pbs.twimg.com/media/a")); Assert.Equal(0,handler.Calls);
        cache.Enable(); var local=await cache.LoadAsync("x","https://pbs.twimg.com/media/a"); Assert.NotNull(local); Assert.True(File.Exists(local));
        await cache.StopAsync(); Assert.Equal(local,await cache.LoadAsync("x","https://pbs.twimg.com/media/a")); Assert.Equal(1,handler.Calls);
    }
    [Fact]
    public async Task RedirectIsRevalidatedAndNoCredentialsSent()
    {
        var handler=new FixtureHttp(r=> { Assert.Empty(r.Headers); var response=new HttpResponseMessage(HttpStatusCode.Redirect); response.Headers.Location=new Uri("https://127.0.0.1/private"); return response; });
        await using var cache=new PreviewCache(root,handler); cache.Enable(); Assert.Null(await cache.LoadAsync("x","https://pbs.twimg.com/media/a")); Assert.Equal(1,handler.Calls);
    }
    [Fact]
    public async Task StopCancelsAndAwaitsEveryPreviewIncludingSemaphoreWaiters()
    {
        var started=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler=new FixtureHttp(async (_,ct)=> { started.TrySetResult(); await Task.Delay(Timeout.Infinite,ct); return new(HttpStatusCode.OK); });
        await using var cache=new PreviewCache(root,handler); cache.Enable(); var tasks=Enumerable.Range(0,10).Select(i=>cache.LoadAsync("x","https://pbs.twimg.com/media/"+i)).ToArray(); await started.Task;
        await cache.StopAsync(); await Task.WhenAll(tasks); Assert.All(tasks,t=>Assert.True(t.IsCompletedSuccessfully)); Assert.Equal(0,cache.ActiveCount); Assert.InRange(handler.Peak,1,2);
        Assert.Null(await cache.LoadAsync("x","https://pbs.twimg.com/media/new"));
    }
    [Fact]
    public async Task OversizedEncodedDimensionsAndInlineDataDoNotEnterCache()
    {
        var bomb=Png.ToArray(); bomb[16]=127; bomb[17]=255;
        var handler=new FixtureHttp(_=>new(HttpStatusCode.OK){Content=new ByteArrayContent(bomb)}); await using var cache=new PreviewCache(root,handler); cache.Enable();
        Assert.Null(await cache.LoadAsync("x","https://pbs.twimg.com/media/bomb"));
        Assert.Null(await cache.LoadAsync("telegram","data:image/png;base64,"+Convert.ToBase64String(new byte[24577])));
        Assert.Null(await cache.LoadAsync("telegram","data:image/png;base64,AAAA")); Assert.Empty(Directory.GetFiles(root));
    }
    [Fact]
    public async Task CacheEvictsOnlyOwnedFilesAndHonorsDiskCap()
    {
        var handler=new FixtureHttp(_=>new(HttpStatusCode.OK){Content=new ByteArrayContent(Png)}); await using var cache=new PreviewCache(root,handler,140); cache.Enable();
        File.WriteAllText(Path.Combine(root,"unrelated.txt"),"preserve");
        for(var i=0;i<6;i++) Assert.NotNull(await cache.LoadAsync("x","https://pbs.twimg.com/media/"+i));
        Assert.InRange(cache.CachedBytes,1,140); await cache.ClearAsync(); Assert.True(File.Exists(Path.Combine(root,"unrelated.txt"))); Assert.Equal(0,cache.CachedBytes);
    }
}
internal sealed class FixtureHttp : HttpMessageHandler
{
    readonly Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> handler;
    public int Calls; public int Peak; int active;
    public FixtureHttp(Func<HttpRequestMessage,HttpResponseMessage> f)=>handler=(r,_)=>Task.FromResult(f(r));
    public FixtureHttp(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> f)=>handler=f;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken ct)
    { Interlocked.Increment(ref Calls); Peak=Math.Max(Peak,Interlocked.Increment(ref active)); try { return await handler(r,ct); } finally {Interlocked.Decrement(ref active);} }
}
