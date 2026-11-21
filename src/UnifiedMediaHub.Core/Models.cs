using System.Text.Json;
namespace UnifiedMediaHub.Core;

public sealed class SourceRequest
{
    public string Platform { get; set; } = "";
    public string Kind { get; set; } = "single";
    public string Url { get; set; } = "";
    public string Label { get; set; } = "";
    public int MaxItems { get; set; }
    public string? ChatId { get; set; }
    public string? MessageId { get; set; }
    public string? TopicId { get; set; }
    public string? AccountId { get; set; }
    public string? FolderId { get; set; }
    public BridgeSourceInfo? Bridge {get;set;}
}

public sealed class MediaAsset
{
    public string? ReuseFrom { get; set; }
    public string? ReuseSha256 { get; set; }
    public long? ReuseBytes { get; set; }
    public int Index { get; set; }
    public string Kind { get; set; } = "";
    public string? Url { get; set; }
    public string Extension { get; set; } = "";
    public long? ExpectedBytes { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
}

public sealed class ContentItem
{
    public string Key { get; set; } = "";
    public string Platform { get; set; } = "";
    public string ContentId { get; set; } = "";
    public string SourceUrl { get; set; } = "";
    public string Title { get; set; } = "";
    public string Author { get; set; } = "";
    public string? AuthorUrl { get; set; }
    public string? CreatedAt { get; set; }
    public string? ThumbnailUrl { get; set; }
    public string? ChatId { get; set; }
    public string? MessageId { get; set; }
    public List<MediaAsset> Media { get; set; } = [];
    public bool MediaResolved { get; set; }
    public bool Selected { get; set; } = true;
}

public sealed class DownloadReceipt
{
    public string ContentKey { get; set; } = "";
    public int MediaIndex { get; set; }
    public string FilePath { get; set; } = "";
    public long Bytes { get; set; }
    public string Sha256 { get; set; } = "";
    public string Status { get; set; } = "";
    public string? ErrorCode { get; set; }
    public string? Message { get; set; }
    public string? DuplicateOfContentKey {get;set;}
    public int? DuplicateOfMediaIndex {get;set;}
}

public sealed class HubJob
{
    public string Category { get; set; } = "";
    // Set at the first download when one folder per task is chosen; null keeps the per-author layout.
    public string? TaskFolder { get; set; }
    public string Id { get; set; } = "";
    public SourceRequest Source { get; set; } = new();
    public string Status { get; set; } = "ready";
    public string Completeness { get; set; } = "unknown";
    public string? Message { get; set; }
    public string? ReasonCode {get;set;}
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
    public string DownloadRoot { get; set; } = "";
}

public sealed class HubSettings
{
    // Every Windows account has a profile folder; a fixed drive letter may not exist on another computer.
    public string DownloadRoot { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),"Downloads","统一媒体下载");
    public int MaxConcurrentDownloads { get; set; } = 2;
    public int MaxScanItems { get; set; }
    public bool FolderPerTask { get; set; } = true;
    public bool EdgeBridgeEnabled {get;set;}
    public int EdgeBridgePort {get;set;}=47631;
}

public sealed class PlatformCapabilities
{
    public string Platform { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public List<string> SourceTypes { get; set; } = [];
    public string VerificationState { get; set; } = "unverified";
}

public sealed class WorkerPaths
{
    public string Category { get; set; } = "";
    public string Folder { get; set; } = "";
    public string DataRoot { get; set; } = "";
    public string DownloadRoot { get; set; } = "";
    public string BrowserExecutable { get; set; } = "";
    public string EngineRoot { get; set; } = "";
}

public sealed class WorkerRequest
{
    public int Version { get; set; } = 1;
    public string RequestId { get; set; } = "";
    public string Operation { get; set; } = "";
    public SourceRequest Source { get; set; } = new();
    public List<ContentItem>? Items { get; set; }
    public JsonElement? BridgePayload {get;set;}
    public WorkerPaths Paths { get; set; } = new();
    public int MaxConcurrentDownloads { get; set; } = 2;
}

public sealed class WorkerTopic
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
}

public sealed class WorkerChat
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Username { get; set; }
    public List<WorkerTopic>? Topics { get; set; }
}

public sealed class WorkerEvent
{
    public JsonElement? Diagnostic { get; set; }
    public int Version { get; set; } = 1;
    public string RequestId { get; set; } = "";
    public string Type { get; set; } = "";
    public string? Message { get; set; }
    public string? Phase { get; set; }
    public ContentItem? Item { get; set; }
    public long? Current { get; set; }
    public long? Total { get; set; }
    public long? ObservedRounds { get; set; }
    public long? ObservedPages { get; set; }
    public long? Bytes { get; set; }
    public string? Platform { get; set; }
    public bool? Authenticated { get; set; }
    public string? AccountId { get; set; }
    public string? DisplayName { get; set; }
    public WorkerChat? Chat { get; set; }
    public WorkerFolder? Folder { get; set; }
    public DownloadReceipt? Receipt { get; set; }
    public string? Code { get; set; }
    public string? InputType { get; set; }
    public string? InputId {get;set;}
    public LoginQrCode? QrCode {get;set;}
    public LoginDelivery? Delivery {get;set;}
    public string? Prompt { get; set; }
    public string? Status { get; set; }
    public string? Completeness { get; set; }
    public string? ReasonCode {get;set;}
    public bool? AwaitingInput {get;set;}
    public int? RetryAfterSeconds {get;set;}
}
