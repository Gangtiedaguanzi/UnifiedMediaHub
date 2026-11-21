using System.Text.Json;
using Microsoft.Data.Sqlite;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class CoreTests : IDisposable
{
    [Theory]
    [InlineData("work_unavailable")]
    [InlineData("embedded_unsupported")]
    [InlineData("sensitive_content")]
    [InlineData("work_unresolved")]
    public void WorkReasonsAreRecognizedAndHaveSpecificAdvice(string code)
    { Assert.Equal(code,UserText.SafeCode(code)); Assert.NotEqual(UserText.Error("operation_failed"),UserText.Error(code)); }

    private readonly string root = Path.Combine(Path.GetTempPath(), "UnifiedMediaHub-tests", Guid.NewGuid().ToString("N"));
    public CoreTests() => Directory.CreateDirectory(root);
    public void Dispose() { SqliteConnection.ClearAllPools(); Directory.Delete(root, true); }
    private HubRepository Open() { var repo = new HubRepository(Path.Combine(root, "private", "hub.db")); repo.Initialize(); return repo; }
    private static ContentItem Item(string id = "9007199254740993123") => new() { Platform = "x", ContentId = id, SourceUrl = "https://x.com/person/status/" + id, Title = "sample", MediaResolved = true, Media = [new() { Index = 1, Kind = "image", Extension = "jpg", Url = "https://example.org/image.jpg" }] };

    [Theory]
    [InlineData("https://x.com.evil.test/a/status/123")]
    [InlineData("https://evilx.com/a")]
    [InlineData("https://xiaohongshu.com.evil.test/explore/123")]
    [InlineData("file:///C:/private")]
    [InlineData("javascript:alert(1)")]
    [InlineData("tg://join?invite=abc")]
    [InlineData("https://user:secret@x.com/person")]
    public void ClassifierRejectsLookalikesAndUnsafeSchemes(string input)
    { Assert.False(SourceClassifier.TryClassify(input, out var source, out var error)); Assert.Null(source); Assert.False(string.IsNullOrWhiteSpace(error)); }

    [Theory]
    [InlineData("https://x.com/person/status/9007199254740993123", "x", "single")]
    [InlineData("https://twitter.com/person", "x", "profile")]
    [InlineData("https://x.com/i/bookmarks", "x", "saved")]
    [InlineData("https://x.com/i/likes", "x", "liked")]
    [InlineData("https://x.com/i/history/likes", "x", "liked")]
    [InlineData("https://www.douyin.com/note/123", "douyin", "single")]
    [InlineData("https://www.douyin.com/user/abc", "douyin", "profile")]
    [InlineData("https://v.douyin.com/abc/", "douyin", "single")]
    [InlineData("https://xhslink.com/a/abc", "xiaohongshu", "single")]
    [InlineData("https://www.xiaohongshu.com/user/profile/abc", "xiaohongshu", "profile")]
    [InlineData("https://t.me/channel", "telegram", "chat")]
    public void ClassifierRecognizesSupportedSourceKinds(string input, string platform, string kind)
    { Assert.True(SourceClassifier.TryClassify(input, out var source, out _)); Assert.Equal(platform, source!.Platform); Assert.Equal(kind, source.Kind); }

    [Theory]
    [InlineData("https://t.me/channel/123", "channel", "123", null)]
    [InlineData("https://t.me/c/123456/789", "-100123456", "789", null)]
    [InlineData("https://t.me/c/123456/55/789", "-100123456", "789", "55")]
    [InlineData("https://t.me/channel/55/789", "channel", "789", "55")]
    [InlineData("https://t.me/channel/789?thread=55", "channel", "789", "55")]
    public void TelegramLinksPreserveChatMessageAndTopic(string url, string chat, string message, string? topic)
    { Assert.True(SourceClassifier.TryClassify(url, out var source, out _)); Assert.Equal(chat, source!.ChatId); Assert.Equal(message, source.MessageId); Assert.Equal(topic, source.TopicId); }

    [Fact]
    public void SignedSourceUrlRetainsOriginalToken()
    { const string url = "https://www.xiaohongshu.com/explore/abc?xsec_token=a%2Bb%2Fc%3D&xsec_source=pc"; Assert.True(SourceClassifier.TryClassify(url, out var source, out _)); Assert.Equal(url, source!.Url); }

    [Fact]
    public void TelegramInvitesRequireUserInput()
    { Assert.False(SourceClassifier.TryClassify("https://t.me/+privateInvite", out _, out var error)); Assert.Contains("invite", error!, StringComparison.OrdinalIgnoreCase); }

    [Fact]
    public void IdentityRequiresTelegramChatAndSeparatesCrossChatMessages()
    {
        Assert.Equal("telegram:-10011:42", ContentIdentity.KeyFor(new() { Platform = "telegram", ChatId = "-10011", MessageId = "42" }));
        Assert.Equal("telegram:-10022:42", ContentIdentity.KeyFor(new() { Platform = "telegram", ChatId = "-10022", MessageId = "42" }));
        Assert.Throws<ArgumentException>(() => ContentIdentity.KeyFor(new() { Platform = "telegram", ContentId = "42" }));
        Assert.Throws<ArgumentException>(() => ContentIdentity.KeyFor(new() { Platform = "x", ContentId = "../work" }));
        Assert.Equal("x:9007199254740993123", ContentIdentity.KeyFor(Item()));
    }

    [Fact]
    public void WorkerJsonKeepsHugeIdsAndTypedEventPayloads()
    {
        var request = new WorkerRequest { RequestId = "r1", Operation = "download", Source = new() { Platform = "x", Kind = "single", Url = "https://x.com/p/status/9007199254740993123" }, Items = [Item()], Paths = new() { DataRoot = root, DownloadRoot = root, BrowserExecutable = "browser.exe", EngineRoot = "engines" } };
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(request, HubJson.Options));
        Assert.Equal(1, doc.RootElement.GetProperty("version").GetInt32());
        Assert.Equal("9007199254740993123", doc.RootElement.GetProperty("items")[0].GetProperty("contentId").GetString());
        var evt = JsonSerializer.Deserialize<WorkerEvent>("{\"version\":1,\"requestId\":\"r1\",\"type\":\"chat\",\"chat\":{\"id\":\"9007199254740993123\",\"title\":\"Chat\",\"topics\":[{\"id\":\"8\",\"title\":\"Topic\"}]},\"futureField\":1}", HubJson.Options)!;
        Assert.Equal("8", evt.Chat!.Topics![0].Id); Assert.Equal("9007199254740993123", evt.Chat.Id);
    }

    [Fact]
    public void CanonicalContentCanBelongToTwoJobsWithoutLosingSelectionOrMedia()
    {
        using var repo = Open(); var a = repo.CreateJob(new() { Platform = "x", Kind = "saved" }, root); var b = repo.CreateJob(new() { Platform = "x", Kind = "liked" }, root);
        repo.UpsertItems(a.Id, [Item()]); repo.SetSelected(a.Id, "x:9007199254740993123", false);
        repo.UpsertItems(b.Id, [Item()]); repo.UpsertItems(a.Id, [new() { Platform = "x", ContentId = "9007199254740993123", Title = "new card" }]);
        var first = Assert.Single(repo.ListItems(a.Id)); var second = Assert.Single(repo.ListItems(b.Id));
        Assert.False(first.Selected); Assert.True(second.Selected); Assert.Single(first.Media); Assert.True(first.MediaResolved); Assert.Equal(first.Key, second.Key); Assert.Equal("new card", second.Title);
    }

    [Fact]
    public void ReceiptHistorySurvivesReopenAndInvalidFilesAreNotSkipped()
    {
        var file = Path.Combine(root, "media.bin"); File.WriteAllBytes(file, [1, 2, 3]); string jobId;
        using (var repo = Open()) { var job = repo.CreateJob(new() { Platform = "x" }, root); jobId = job.Id; repo.UpsertItems(job.Id, [Item()]); repo.RecordReceipt(job.Id, new() { ContentKey = "x:9007199254740993123", MediaIndex = 1, FilePath = file, Bytes = 3, Sha256 = "testhash", Status = "completed" }); }
        using (var repo = Open()) { Assert.NotNull(repo.GetJob(jobId)); Assert.Single(repo.ListReceipts(jobId)); Assert.NotNull(repo.FindVerifiedReceipt("x:9007199254740993123", 1)); File.WriteAllBytes(file, [1]); Assert.Null(repo.FindVerifiedReceipt("x:9007199254740993123", 1)); File.Delete(file); Assert.Null(repo.FindVerifiedReceipt("x:9007199254740993123", 1)); }
    }

    [Fact]
    public void RecoveryPausesOnlyActiveJobsAndPreservesScanCompleteness()
    {
        using var repo = Open(); var scan = repo.CreateJob(new(), root); var download = repo.CreateJob(new(), root); var interrupted = repo.CreateJob(new(), root); var ready = repo.CreateJob(new(), root);
        repo.UpdateJob(scan.Id, "scanning", completeness: "partial"); repo.UpdateJob(download.Id, "downloading", completeness: "complete"); repo.UpdateJob(interrupted.Id, "interrupted");
        Assert.Equal(3, repo.RecoverInterruptedJobs()); Assert.Equal(0, repo.RecoverInterruptedJobs());
        Assert.Equal("paused", repo.GetJob(scan.Id)!.Status); Assert.Equal("paused", repo.GetJob(download.Id)!.Status); Assert.Equal("ready", repo.GetJob(ready.Id)!.Status);
        repo.UpdateJob(scan.Id, "completed"); Assert.Equal("partial", repo.GetJob(scan.Id)!.Completeness); Assert.Equal(4, repo.ListJobs().Count);
    }

    [Fact]
    public void UpsertIsAtomicWhenAnItemHasInvalidIdentity()
    {
        using var repo = Open(); var job = repo.CreateJob(new(), root);
        Assert.Throws<ArgumentException>(() => repo.UpsertItems(job.Id, [Item(), new() { Platform = "telegram", MessageId = "42" }]));
        Assert.Empty(repo.ListItems(job.Id));
    }

    [Fact]
    public void NewlyDiscoveredUnresolvedMediaDoesNotInheritResolvedState()
    {
        using var repo = Open(); var job = repo.CreateJob(new(), root); repo.UpsertItems(job.Id, [Item()]);
        repo.UpsertItems(job.Id, [new() { Platform = "x", ContentId = "9007199254740993123", Media = [new() { Index = 2, Kind = "image" }] }]);
        var item = Assert.Single(repo.ListItems(job.Id)); Assert.Equal(2, item.Media.Count); Assert.False(item.MediaResolved);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void LessDetailedMediaRefreshPreservesResolvedUrl(string? refreshedUrl)
    {
        using var repo = Open(); var job = repo.CreateJob(new(), root); repo.UpsertItems(job.Id, [Item()]);
        repo.UpsertItems(job.Id, [new() { Platform = "x", ContentId = "9007199254740993123", MediaResolved = false, Media = [new() { Index = 1, Kind = "image", Url = refreshedUrl }] }]);
        var item = Assert.Single(repo.ListItems(job.Id));
        Assert.Equal("https://example.org/image.jpg", Assert.Single(item.Media).Url);
        Assert.True(item.MediaResolved);
    }

    [Fact]
    public void GlobalReceiptLookupIgnoresFailuresAndReusesOtherJobHistory()
    {
        using var repo = Open(); var a = repo.CreateJob(new(), root); var b = repo.CreateJob(new(), root);
        var file = Path.Combine(root, "good.jpg"); File.WriteAllBytes(file, [1, 2, 3]);
        repo.RecordReceipt(a.Id, new() { ContentKey = "x:123", MediaIndex = 1, FilePath = file, Bytes = 3, Status = "completed" });
        repo.RecordReceipt(b.Id, new() { ContentKey = "x:123", MediaIndex = 1, FilePath = Path.Combine(root, "missing.jpg"), Bytes = 3, Status = "failed" });
        Assert.Equal(file, repo.FindVerifiedReceipt("x:123", 1)!.FilePath); Assert.Null(repo.FindVerifiedReceipt("x:123", 2));
        Assert.Equal("failed", Assert.Single(repo.ListReceipts(b.Id)).Status);
    }

    [Fact]
    public void PersistedActiveJobRecoversAfterRepositoryReopen()
    {
        string id;
        using (var repo = Open()) { var job = repo.CreateJob(new(), root); id = job.Id; repo.UpdateJob(id, "downloading", completeness: "partial"); }
        using (var repo = Open()) { Assert.Equal(1, repo.RecoverInterruptedJobs()); Assert.Equal("paused", repo.GetJob(id)!.Status); Assert.Equal("partial", repo.GetJob(id)!.Completeness); }
    }
}
