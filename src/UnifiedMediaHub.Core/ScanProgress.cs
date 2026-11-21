namespace UnifiedMediaHub.Core;

// A bounded projection, not a worker message, source cursor or resume token.
public sealed record ScanCheckpoint
{
    public required string JobId { get; init; }
    public required string Generation { get; init; }
    public required string RequestId { get; init; }
    public string Phase { get; init; } = "starting";
    public long CommittedUniqueItemCount { get; init; }
    public long? ObservedCurrent { get; init; }
    public long? Total { get; init; }
    public long? ObservedRounds { get; init; }
    public long? ObservedPages { get; init; }
    public DateTimeOffset UpdatedAt { get; init; } = DateTimeOffset.UtcNow;
    public string TerminalState { get; init; } = "running";

    internal ScanCheckpoint? Observe(WorkerEvent value)
    {
        static bool Valid(long? n) => n == null || n is >= 0 and <= 1_000_000_000;
        static bool Regressed(long? previous,long? next) => previous.HasValue&&next.HasValue&&next<previous;
        if (value.Phase != "scan" || !Valid(value.Current) || !Valid(value.Total) || !Valid(value.ObservedRounds) || !Valid(value.ObservedPages)
            || (value.Current??ObservedCurrent) is long current && value.Total is long total && total < current
            || Regressed(ObservedCurrent,value.Current)||Regressed(ObservedRounds,value.ObservedRounds)||Regressed(ObservedPages,value.ObservedPages)) return null;
        return this with { Phase = "scan", ObservedCurrent = value.Current??ObservedCurrent, Total = value.Total, ObservedRounds = value.ObservedRounds??ObservedRounds, ObservedPages = value.ObservedPages??ObservedPages, UpdatedAt = DateTimeOffset.UtcNow };
    }
}

public sealed record ScanProgressView(ScanCheckpoint Current, ScanCheckpoint? Persisted, bool SaveFailed);
