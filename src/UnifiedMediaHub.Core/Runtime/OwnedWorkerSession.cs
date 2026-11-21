using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace UnifiedMediaHub.Core.Runtime;

public sealed class WorkerLaunchOptions
{
    public string ExecutablePath { get; set; } = "";
    public string WorkerScriptPath { get; set; } = "";
    public string WorkingDirectory { get; set; } = "";
    public Dictionary<string, string> Environment { get; set; } = [];
    public TimeSpan ShutdownTimeout { get; set; } = TimeSpan.FromSeconds(5);
}

public sealed class OwnedWorkerSession : IAsyncDisposable
{
    private const int MaxLineChars = 65536;
    private const int MaxBridgeItemBytes = 512*1024;
    private const int MaxRequestChars = 16 * 1024 * 1024;
    private static readonly TimeSpan EventStallTimeout = TimeSpan.FromSeconds(5);
    private static readonly HashSet<string> EventTypes = ["diagnostic", "login_qr", "status", "item", "progress", "account", "chat", "folder", "receipt", "needs_action", "complete", "error"];
    private readonly Process process;
    private readonly WorkerJob job;
    private readonly TimeSpan shutdownTimeout;
    private readonly string requestId;
    private readonly bool allowsQr,allowsBridgeItems; private bool qrSeen;
    // Finite async backpressure permits bulk output without unbounded retention.
    private readonly Channel<WorkerEvent> events;
    private readonly CancellationTokenSource transportStopping = new();
    private readonly SemaphoreSlim writes = new(1, 1);
    private readonly object stopLock = new();
    private readonly object releaseLock = new();
    private readonly CancellationTokenSource samplingStop = new();
    private readonly Task sampling;
    private readonly Action<ResourceMetrics>? observeResources;
    private ResourceMetrics resources;
    private Task? releaseTask;
    private Task? stopTask;
    private int disposed;
    private bool inputClosed;
    public int ProcessId { get; }
    public Task<int> Completion { get; }
    public ResourceMetrics Resources => Volatile.Read(ref resources);

    private OwnedWorkerSession(Process process, WorkerJob job, TimeSpan timeout, WorkerRequest request, Action<ResourceMetrics>? observeResources)
    {
        this.process = process; this.job = job; shutdownTimeout = timeout; this.requestId = request.RequestId; allowsQr=request.Operation=="loginQr"&&request.Source.Platform=="telegram";
        allowsBridgeItems=request.Operation=="importBridge"&&request.Source.Kind=="bridge"&&request.Source.Platform=="douyin";
        events=Channel.CreateBounded<WorkerEvent>(new BoundedChannelOptions(allowsBridgeItems?8:256){SingleWriter=true,FullMode=BoundedChannelFullMode.Wait});
        ProcessId = process.Id;
        this.observeResources = observeResources;
        resources = new() { RequestId = request.RequestId, Operation = request.Operation };
        sampling = Task.Run(SampleResourcesAsync);
        Completion = MonitorAsync();
    }

    public static async Task<OwnedWorkerSession> StartAsync(WorkerLaunchOptions options, WorkerRequest request, CancellationToken cancellationToken = default, Action<ResourceMetrics>? observeResources = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(options); ArgumentNullException.ThrowIfNull(request);
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Owned workers require Windows Jobs.");
        if (options.ShutdownTimeout <= TimeSpan.Zero || options.ShutdownTimeout > TimeSpan.FromMinutes(1)) throw new ArgumentOutOfRangeException(nameof(options));
        if(request.Operation=="loginQr"&&request.Source.Platform!="telegram")throw new ArgumentException("QR login requires Telegram.");
        if (request.Version != 1 || string.IsNullOrWhiteSpace(request.RequestId)) throw new ArgumentException("Worker request requires version 1 and a request ID.", nameof(request));
        if (!Path.IsPathFullyQualified(options.ExecutablePath) || !File.Exists(options.ExecutablePath) || !Path.IsPathFullyQualified(options.WorkerScriptPath) || !File.Exists(options.WorkerScriptPath) || !Path.IsPathFullyQualified(options.WorkingDirectory) || !Directory.Exists(options.WorkingDirectory))
            throw new ArgumentException("Worker executable, script and working directory must be existing absolute paths.", nameof(options));
        // Bridge JSON travels over a pipe, never into HTML. Keep its bounded
        // UTF-8 form rather than expanding every '<' or non-ASCII character.
        var optionsForRequest=request.Operation=="importBridge"?new JsonSerializerOptions(HubJson.Options){Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping}:HubJson.Options;
        var firstLine = JsonSerializer.Serialize(request, optionsForRequest);
        if (firstLine.Length > MaxRequestChars) throw new ArgumentException("Worker request exceeds transport limit.", nameof(request));
        var info = new ProcessStartInfo(options.ExecutablePath)
        {
            WorkingDirectory = options.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false, true),
            StandardOutputEncoding = new UTF8Encoding(false, true),
            StandardErrorEncoding = new UTF8Encoding(false, false)
        };
        info.ArgumentList.Add(options.WorkerScriptPath);
        foreach (var entry in options.Environment) info.Environment[entry.Key] = entry.Value;
        var job = new WorkerJob();
        var process = new Process { StartInfo = info };
        OwnedWorkerSession? session = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!process.Start()) throw new IOException("Worker could not start.");
            // The packaged script remains inert until this assignment succeeds.
            job.Assign(process);
            cancellationToken.ThrowIfCancellationRequested();
            session = new OwnedWorkerSession(process, job, options.ShutdownTimeout, request, observeResources);
            await session.WriteLineAsync(firstLine, cancellationToken);
            return session;
        }
        catch
        {
            if (session != null) await session.DisposeAsync();
            else
            {
                job.Dispose();
                // Assign failure must never leave the just-started process unowned.
                try { if (process.Id > 0 && !process.HasExited) { process.Kill(); await process.WaitForExitAsync(); } } catch (InvalidOperationException) { }
                process.Dispose();
            }
            throw;
        }
    }

    public async IAsyncEnumerable<WorkerEvent> ReadEventsAsync([EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var item in events.Reader.ReadAllAsync(cancellationToken)) yield return item;
    }

    public Task SendControlAsync(object control, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(control);
        var line = JsonSerializer.Serialize(control, HubJson.Options);
        if (line.Length > MaxLineChars) throw new ArgumentException("Worker control exceeds transport limit.", nameof(control));
        return WriteLineAsync(line, cancellationToken);
    }

    private async Task WriteLineAsync(string line, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(shutdownTimeout);
        await writes.WaitAsync(timeout.Token);
        try
        {
            if (inputClosed || Volatile.Read(ref disposed) != 0) throw new IOException("Worker input is closed.");
            await process.StandardInput.WriteLineAsync(line.AsMemory(), timeout.Token);
            await process.StandardInput.FlushAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            // A cancelled write may have left half a JSON line in the pipe.
            transportStopping.Cancel(); await ReleaseJobAsync().ConfigureAwait(false); throw;
        }
        catch (IOException) { if (Volatile.Read(ref disposed) == 0) transportStopping.Cancel(); await ReleaseJobAsync().ConfigureAwait(false); throw new IOException("Worker input could not be written."); }
        finally { writes.Release(); }
    }

    public Task StopAsync(CancellationToken cancellationToken = default)
    {
        Task stopping;
        lock (stopLock) stopping = stopTask ??= StopCoreAsync();
        // Cancelling a caller's wait never abandons the owned cleanup operation.
        return stopping.WaitAsync(cancellationToken);
    }

    private async Task StopCoreAsync()
    {
        using var grace = new CancellationTokenSource(shutdownTimeout);
        try
        {
            if (!Completion.IsCompleted)
            {
                try { await SendControlAsync(new { command = "cancel" }, grace.Token); } catch (IOException) { }
                await writes.WaitAsync(grace.Token);
                try { inputClosed = true; process.StandardInput.Close(); } finally { writes.Release(); }
                await Completion.WaitAsync(grace.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        finally
        {
            if (!Completion.IsCompleted) transportStopping.Cancel();
            await ReleaseJobAsync().ConfigureAwait(false);
            try { await Completion; } catch (IOException) { }
        }
    }

    private async Task<int> MonitorAsync()
    {
        var stdout = GuardPumpAsync(ReadOutputAsync);
        var stderr = GuardPumpAsync(DrainDiagnosticsAsync);
        Exception? failure = null;
        try
        {
            await process.WaitForExitAsync();
            await ReleaseJobAsync().ConfigureAwait(false); // Root exit must not strand children or inherited pipes.
            await Task.WhenAll(stdout, stderr);
            return process.ExitCode;
        }
        catch (Exception error) when (error is IOException or InvalidDataException or JsonException or DecoderFallbackException)
        {
            failure = new IOException(error is IOException ? error.Message : "Worker protocol decoding failed.");
            throw failure;
        }
        finally { await ReleaseJobAsync().ConfigureAwait(false); events.Writer.TryComplete(failure); }
    }

    private async Task GuardPumpAsync(Func<Task> pump)
    {
        try { await pump(); } catch { transportStopping.Cancel(); await ReleaseJobAsync().ConfigureAwait(false); throw; }
    }

    private async Task SampleResourcesAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            do
            {
                samplingStop.Token.ThrowIfCancellationRequested();
                ResourceSample sample;
                try { sample = job.Sample(); }
                catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or OverflowException) { sample = default; }
                long? hostCommit = null, hostWorkingSet = null;
                try
                {
                    using var host = Process.GetCurrentProcess();
                    hostCommit = host.PrivateMemorySize64; hostWorkingSet = host.WorkingSet64;
                }
                catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException) { }
                PublishResources(Resources.Add(sample) with { HostPrivateCommitBytes = hostCommit, HostWorkingSetBytes = hostWorkingSet });
            } while (await timer.WaitForNextTickAsync(samplingStop.Token).ConfigureAwait(false));
        }
        catch (OperationCanceledException) when (samplingStop.IsCancellationRequested) { }
    }

    private void PublishResources(ResourceMetrics value)
    {
        Volatile.Write(ref resources, value);
        // Resource display must never change media results, even if an observer fails.
        try { observeResources?.Invoke(value); } catch (Exception) { }
    }

    private Task ReleaseJobAsync()
    {
        lock (releaseLock) return releaseTask ??= ReleaseJobCoreAsync();
    }

    private async Task ReleaseJobCoreAsync()
    {
        samplingStop.Cancel();
        // This path deliberately never waits for Completion: MonitorAsync also calls it.
        try { await sampling.ConfigureAwait(false); }
        finally { job.Dispose(); PublishResources(Resources.Finish()); samplingStop.Dispose(); }
    }

    private async Task DrainDiagnosticsAsync()
    {
        // Suppress all raw stderr: it can contain cookies, signed URLs or TG input.
        // Fixed scratch space drains diagnostics without retaining sensitive content.
        var buffer = new char[4096];
        while (await process.StandardError.ReadAsync(buffer.AsMemory()) > 0) { }
    }

    private async Task ReadOutputAsync()
    {
        var buffer = new char[4096]; var line = new StringBuilder();
        int read;
        while ((read = await process.StandardOutput.ReadAsync(buffer.AsMemory())) > 0)
        {
            for (var i = 0; i < read; i++)
            {
                if (buffer[i] == '\n') { await EmitLineAsync(line.ToString().TrimEnd('\r')); line.Clear(); }
                else { if (line.Length >= (allowsBridgeItems?MaxBridgeItemBytes:MaxLineChars)) throw new IOException("Worker protocol line exceeds transport limit."); line.Append(buffer[i]); }
            }
        }
        if (line.Length > 0) throw new IOException("Worker protocol ended with an incomplete line.");
    }

    private async Task EmitLineAsync(string line)
    {
        WorkerEvent? item;
        try
        {
            using var json = JsonDocument.Parse(line);
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var number) || number != 1 || !root.TryGetProperty("requestId", out var id) || id.ValueKind != JsonValueKind.String || id.GetString() != requestId || !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || !EventTypes.Contains(type.GetString()!))
                throw new IOException("Worker event has an invalid envelope.");
            item = JsonSerializer.Deserialize<WorkerEvent>(line, HubJson.Options);
            var bytes=Encoding.UTF8.GetByteCount(line);
            if(bytes>MaxLineChars&&!(allowsBridgeItems&&item?.Type=="item"&&item.Item?.Platform=="douyin"&&bytes<=MaxBridgeItemBytes))throw new IOException("Worker event exceeds its transport limit.");
        }
        catch (JsonException) { throw new IOException("Worker emitted malformed JSON."); }
        if (item == null) throw new IOException("Worker emitted an empty event.");
        if(item.Diagnostic!=null&&item.Type!="diagnostic")throw new IOException("Unexpected diagnostic payload.");
        if(item.Type=="diagnostic"&&item.Diagnostic?.ValueKind!=JsonValueKind.Object)throw new IOException("Invalid diagnostic payload.");
        if(item.QrCode!=null&&item.Type!="login_qr")throw new IOException("Unexpected QR payload.");
        if(item.Folder!=null&&item.Type!="folder")throw new IOException("Unexpected folder payload.");
        if(item.Type=="folder")SavedFolders.Validate(item.Folder);
        if(item.Type=="login_qr"){
            if(!allowsQr||qrSeen||item.QrCode==null)throw new IOException("Unexpected login QR.");
            item.QrCode.DecodeValidated(DateTimeOffset.UtcNow);qrSeen=true;
        }
        if (events.Writer.TryWrite(item)) return;
        using var stall = CancellationTokenSource.CreateLinkedTokenSource(transportStopping.Token);
        stall.CancelAfter(EventStallTimeout);
        try { await events.Writer.WriteAsync(item, stall.Token); }
        catch (OperationCanceledException) { throw new IOException("Worker event delivery stalled or was stopped."); }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        await writes.WaitAsync();
        try { if (Interlocked.Exchange(ref disposed, 1) == 0) { process.Dispose(); transportStopping.Dispose(); } }
        finally { writes.Release(); }
    }
}
