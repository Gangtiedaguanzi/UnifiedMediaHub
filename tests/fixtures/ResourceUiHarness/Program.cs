using System.Reflection;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using UnifiedMediaHub.App;
using UnifiedMediaHub.Core;

internal static class Program
{
    static void Require(bool condition, string name) { if (!condition) throw new Exception(name); }
    [STAThread]
    static int Main()
    {
        var fixtureBase = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "UMH-resource-ui"));
        var root = Path.GetFullPath(Path.Combine(fixtureBase, Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(root);
        try
        {
            var app = new Application();
            using var services = new AppServices(Path.Combine(root, "data"), root);
            var runner = new Fixture();
            services.Hub.DisposeAsync().AsTask().GetAwaiter().GetResult();
            var hub = new HubCoordinator(services.Repository, runner, new() { DataRoot = root, DownloadRoot = root });
            typeof(AppServices).GetField("<Hub>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(services, hub);
            var window = new MainWindow(services); // No Show or platform actions.
            var refresh = typeof(MainWindow).GetMethod("RefreshResources", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var refreshAll = typeof(MainWindow).GetMethod("Refresh", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var text = (TextBlock)window.FindName("ResourceLine"); var host = (TextBlock)window.FindName("HostResourceLine");
            refresh.Invoke(window, null); Require(text.Text.Contains("尚无采样"), "initial unknown");
            var job = services.Repository.CreateJob(new() { Platform = "x", Kind = "profile", Url = "https://x.com/synthetic" }, root);
            typeof(MainWindow).GetField("currentJobId", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(window, job.Id);
            hub.Enable(); var running = hub.Submit(job.Id, "scan"); runner.Entered.Task.GetAwaiter().GetResult();
            refresh.Invoke(window, null);
            Require(text.Text.Contains("当前操作") && text.Text.Contains("3") && text.Text.Contains("12.0 MiB") && text.Text.Contains("24.0 MiB"), "current owned values");
            Require(host.Text.Contains("主界面") && host.Text.Contains("最近采样") && host.Text.Contains("7.0 MiB"), "separate timestamped host");
            runner.Release.TrySetResult(); running.GetAwaiter().GetResult(); refresh.Invoke(window, null);
            Require(text.Text.Contains("历史采样") && !text.Text.Contains("当前操作"), "terminal current cleared");
            hub.Submit(job.Id, "download").GetAwaiter().GetResult(); refreshAll.Invoke(window, null); refresh.Invoke(window, null);
            Require(text.Text.Contains("历史采样") && text.Text.Contains("12.0 MiB"), "zero worker operation shows labelled history");
            Require(!text.Text.Contains(job.Id) && !text.Text.Contains("synthetic-token"), "fixed resource display privacy");
            var releaseType = typeof(AppServices).Assembly.GetType("UnifiedMediaHub.App.ReleaseWorker")!;
            Require(typeof(IResourceWorkerRunner).IsAssignableFrom(releaseType), "release typed bridge");
            hub.DisposeAsync().AsTask().GetAwaiter().GetResult(); services.Previews.DisposeAsync().AsTask().GetAwaiter().GetResult();
            app.Shutdown(); Console.WriteLine("PASS: 7 offline WPF resource assertions; no window shown, no platform access."); return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        finally { DeleteFixture(root, fixtureBase); }
    }

    static void DeleteFixture(string root, string fixtureBase)
    {
        var target = Path.GetFullPath(root); var allowed = Path.GetFullPath(fixtureBase);
        Require(string.Equals(Path.GetDirectoryName(target), allowed, StringComparison.OrdinalIgnoreCase)
            && Guid.TryParseExact(Path.GetFileName(target), "N", out _), "fixture deletion boundary");
        if (!Directory.Exists(target)) return;
        for (var ancestor = new DirectoryInfo(target); ancestor != null; ancestor = ancestor.Parent)
            Require((ancestor.Attributes & FileAttributes.ReparsePoint) == 0, "fixture ancestor is a link");
        var pending = new Stack<string>(); pending.Push(target);
        while (pending.TryPop(out var directory))
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                var attributes = File.GetAttributes(entry);
                Require((attributes & FileAttributes.ReparsePoint) == 0, "fixture descendant is a link");
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
            }
        Directory.Delete(target, true);
    }

    sealed class Fixture : IResourceWorkerRunner
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task RunAsync(WorkerRequest request, Func<WorkerEvent, Task> emit, CancellationToken ct) => throw new InvalidOperationException("Resource bridge bypassed");
        public async Task RunWithResourcesAsync(WorkerRequest r, Func<WorkerEvent, Task> emit, Action<ResourceMetrics> observe, CancellationToken ct)
        {
            var metric = new ResourceMetrics { RequestId = r.RequestId, Operation = r.Operation, SampledAt = DateTimeOffset.UtcNow, SampleCount = 1, ProcessCount = 3, PrivateCommitBytes = 12 * 1048576, WorkingSetBytes = 24 * 1048576, PeakProcessCount = 3, PeakPrivateCommitBytes = 12 * 1048576, PeakWorkingSetBytes = 24 * 1048576, HostPrivateCommitBytes = 7 * 1048576, HostWorkingSetBytes = 9 * 1048576 };
            observe(metric); Entered.TrySetResult(); await Release.Task.WaitAsync(ct);
            await emit(new() { Type = "complete", Status = "completed", Completeness = "partial" });
            observe(metric with { FinishedAt = DateTimeOffset.UtcNow, ProcessCount = null, PrivateCommitBytes = null, WorkingSetBytes = null });
        }
        public Task SendControlAsync(object control, CancellationToken ct = default) => Task.CompletedTask;
    }
}
