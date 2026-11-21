using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("UnifiedMediaHub.Tests")]

namespace UnifiedMediaHub.Core;

// Host-only measurements. Never deserialized from the worker protocol.
public sealed record ResourceMetrics
{
    public required string RequestId { get; init; }
    public required string Operation { get; init; }
    public string OperationId { get; init; } = "";
    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? SampledAt { get; init; }
    public DateTimeOffset? FinishedAt { get; init; }
    public int SampleCount { get; init; }
    public int IncompleteSampleCount { get; init; }
    public int? ProcessCount { get; init; }
    public long? PrivateCommitBytes { get; init; }
    public long? WorkingSetBytes { get; init; }
    public int? PeakProcessCount { get; init; }
    public long? PeakPrivateCommitBytes { get; init; }
    public long? PeakWorkingSetBytes { get; init; }
    public long? HostPrivateCommitBytes { get; init; }
    public long? HostWorkingSetBytes { get; init; }
    public bool HasUnobservedBatches { get; init; }
    public string Quality => SampleCount == 0 ? "unknown" : IncompleteSampleCount > 0 || HasUnobservedBatches ? "incomplete" : "sampled";

    internal ResourceMetrics AcrossBatches(ResourceMetrics? previous)
    {
        if (previous == null) return this;
        if (previous.OperationId != OperationId) throw new ArgumentException("Resource operation mismatch.");
        static long? Max(long? a, long? b) => a == null ? b : b == null ? a : Math.Max(a.Value, b.Value);
        return this with
        {
            StartedAt = previous.StartedAt,
            SampleCount = previous.SampleCount + SampleCount,
            IncompleteSampleCount = previous.IncompleteSampleCount + IncompleteSampleCount,
            HasUnobservedBatches = previous.HasUnobservedBatches || HasUnobservedBatches || previous.SampleCount == 0 || SampleCount == 0,
            PeakProcessCount = (int?)Max(previous.PeakProcessCount, PeakProcessCount),
            PeakPrivateCommitBytes = Max(previous.PeakPrivateCommitBytes, PeakPrivateCommitBytes),
            PeakWorkingSetBytes = Max(previous.PeakWorkingSetBytes, PeakWorkingSetBytes)
        };
    }

    internal ResourceMetrics Add(ResourceSample sample) => this with
    {
        SampledAt = DateTimeOffset.UtcNow, SampleCount = SampleCount + 1,
        IncompleteSampleCount = IncompleteSampleCount + (sample.Complete ? 0 : 1),
        ProcessCount = sample.Complete ? sample.ProcessCount : null,
        PrivateCommitBytes = sample.Complete ? sample.PrivateCommitBytes : null,
        WorkingSetBytes = sample.Complete ? sample.WorkingSetBytes : null,
        PeakProcessCount = sample.Complete ? Math.Max(PeakProcessCount ?? 0, sample.ProcessCount) : PeakProcessCount,
        PeakPrivateCommitBytes = sample.Complete ? Math.Max(PeakPrivateCommitBytes ?? 0, sample.PrivateCommitBytes) : PeakPrivateCommitBytes,
        PeakWorkingSetBytes = sample.Complete ? Math.Max(PeakWorkingSetBytes ?? 0, sample.WorkingSetBytes) : PeakWorkingSetBytes
    };

    internal ResourceMetrics Finish() => this with { FinishedAt = DateTimeOffset.UtcNow, ProcessCount = null, PrivateCommitBytes = null, WorkingSetBytes = null };
}

internal readonly record struct ResourceSample(bool Complete, int ProcessCount = 0, long PrivateCommitBytes = 0, long WorkingSetBytes = 0);

public sealed record JobResourceMetrics(string JobId, ResourceMetrics Metrics);

public interface IResourceWorkerRunner : IWorkerRunner
{
    Task RunWithResourcesAsync(WorkerRequest request, Func<WorkerEvent, Task> emit, Action<ResourceMetrics> resources, CancellationToken cancellationToken);
}
