namespace UnifiedMediaHub.Core.Runtime;

public sealed class OwnedWorkerRunner(WorkerLaunchOptions options) : IResourceWorkerRunner
{
    readonly object gate=new();
    OwnedWorkerSession? active;
    public Task RunAsync(WorkerRequest request,Func<WorkerEvent,Task> emit,CancellationToken cancellationToken)
        => RunWithResourcesAsync(request, emit, _ => { }, cancellationToken);
    public async Task RunWithResourcesAsync(WorkerRequest request,Func<WorkerEvent,Task> emit,Action<ResourceMetrics> resources,CancellationToken cancellationToken)
    {
        await using var session=await OwnedWorkerSession.StartAsync(options,request,cancellationToken,resources).ConfigureAwait(false);
        lock(gate) active=session;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            await foreach(var evt in session.ReadEventsAsync(cancellationToken)) await emit(evt).ConfigureAwait(false);
            if(await session.Completion.ConfigureAwait(false)!=0) throw new IOException("Worker transport did not exit successfully.");
        }
        finally { lock(gate) active=null; }
    }
    public Task SendControlAsync(object control,CancellationToken cancellationToken=default)
    { lock(gate) return (active??throw new InvalidOperationException("当前没有等待输入的任务。")).SendControlAsync(control,cancellationToken); }
}
