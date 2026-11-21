using System.Text.Json;
using System.Security.Cryptography;
namespace UnifiedMediaHub.Core;

public interface IWorkerRunner
{
    Task RunAsync(WorkerRequest request, Func<WorkerEvent, Task> emit, CancellationToken cancellationToken);
    Task SendControlAsync(object control, CancellationToken cancellationToken = default);
}

public sealed class HubCoordinator : IAsyncDisposable
{
    readonly HubRepository repository;
    readonly IWorkerRunner runner;
    readonly WorkerPaths paths;
    readonly int batchItems;
    readonly object gate = new();
    readonly Queue<Operation> pending = new();
    Operation? active;
    Task? pump;
    bool enabled, stopping, disposed;
    public event Action<string>? Changed;
    public event Action<string, WorkerEvent>? Message;
    public string? StorageWarning {get;private set;}
    public string? ResourceWarning { get; private set; }
    JobResourceMetrics? resources;
    public JobResourceMetrics? Resources { get { lock (gate) return resources; } }
    ScanProgressView? scanProgress;
    public ScanProgressView? ScanProgress { get { lock (gate) return scanProgress; } }
    public string? ScanProgressWarning { get; private set; }
    public bool AwaitingInput {get {lock(gate)return active?.AwaitingInput==true&&!active.Cancel.IsCancellationRequested;}}
    public void ReportStorageFailure()
    {
        lock(gate){StorageWarning="disk_full";enabled=false;active?.Cancel.Cancel();
            while(pending.TryDequeue(out var queued)){queued.Cancel.Cancel();queued.Cancel.Dispose();queued.Done.TrySetResult();}}
        Notify("");
    }
    void FinishState(Operation op,string status,string? reason=null)
    {
        op.TerminalState=status;
        reason=StorageWarning??op.ReasonCode??reason;
        var message=reason==null?"已完成。":reason==op.ReasonCode&&op.Detail!=null?op.Detail:UserText.Error(reason);
        if(reason=="bridge_refresh_required"&&op.BridgeSkippedCount>0)message=$"已跳过 {op.BridgeSkippedCount} 个未解析作品。"+message;
        if(reason=="media_unsupported"&&op.UnsupportedSkippedCount>0)message=$"已跳过 {op.UnsupportedSkippedCount} 条不支持的消息。"+message;
        try{repository.UpdateJob(op.JobId,status,message,reasonCode:reason,clearReason:reason==null);}
        catch(Exception error)when(StorageFailure.IsFull(error)){ReportStorageFailure();}
    }
    // New downloads put every file of a task flat into one folder named by TaskFolders.Name.
    public bool FolderPerTask { get; set; }
    public Func<string,string?>? AccountName { get; set; }
    public bool Enabled { get { lock(gate) return enabled; } }
    public int PendingCount { get { lock(gate) return pending.Count; } }
    public int ActiveCount { get { lock(gate) return active == null ? 0 : 1; } }
    public string? ActiveJobId { get { lock(gate) return active?.JobId; } }
    public IReadOnlyList<(string JobId,string Operation)> QueueSnapshot { get { lock(gate) return pending.Select(p=>(p.JobId,p.Kind)).ToArray(); } }
    public HubCoordinator(HubRepository repository, IWorkerRunner runner, WorkerPaths paths, int batchItems = 200)
    {
        this.repository=repository; this.runner=runner; this.paths=paths;
        this.batchItems=Math.Clamp(batchItems,1,1000); repository.RecoverInterruptedJobs(); repository.RecoverScanProgress();
    }
    public void Enable() { lock(gate) { ObjectDisposedException.ThrowIf(disposed,this); if(StorageWarning!=null)throw new InvalidOperationException(UserText.Error(StorageWarning)); if(stopping) throw new InvalidOperationException("正在停止，请稍候。"); enabled=true; } Notify(""); }
    public Task ImportBridgeAsync(string jobId,JsonElement payload)=>SubmitOperation(jobId,"importBridge",payload.Clone());
    public Task Submit(string jobId, string operation)=>SubmitOperation(jobId,operation,null);
    Task SubmitOperation(string jobId,string operation,JsonElement? bridge)
    {
        if(operation is not ("scan" or "download" or "login" or "loginQr" or "listChats" or "listFolders" or "importBridge")) throw new ArgumentException("Unknown operation.");
        lock(gate)
        {
            if(!enabled || stopping || disposed) throw new InvalidOperationException("请先打开总开关。");
            if(pending.Count>=32) throw new InvalidOperationException("等待队列已满，请等待当前任务结束。");
            if(active?.JobId==jobId || pending.Any(p=>p.JobId==jobId)) throw new InvalidOperationException("此任务已经运行或排队。");
            if((operation is "login" or "loginQr") && (active!=null || pending.Count>0)) throw new InvalidOperationException("请先停止当前任务，再登录账号。");
            var job=repository.GetJob(jobId)??throw new KeyNotFoundException();
            if(operation=="importBridge"&&(job.Source.Platform!="douyin"||job.Source.Kind!="bridge"||bridge==null))throw new InvalidOperationException("Invalid bridge import.");
            if(job.Source.Kind=="bridge"&&operation is not("importBridge" or "download"))throw new InvalidOperationException("请在 Edge 重新发送这些作品。");
            if(operation=="download"&&job.Source.Kind=="bridge"&&job.Source.Bridge is {ConfirmationRequired:true,Confirmed:false})throw new InvalidOperationException(UserText.Error("bridge_account_mismatch"));
            SavedFolders.ValidateSource(job.Source);
            if(operation is "scan" or "download"&&ChatDirectoryState.IsDirectory(job.Source))throw new InvalidOperationException("聊天目录不是媒体来源，请重新读取目录并选择聊天。");
            if(operation=="listFolders")SavedFolders.ValidateDirectory(job.Source);
            if(operation=="listChats")
            {
                if(job.Source.Platform!="telegram"||job.Source.Kind!="chat"||job.Source.MaxItems<0)throw new InvalidOperationException("聊天目录需要 Telegram 聊天来源和有效上限。");
                _=ChatDirectoryState.Source(job.Source.AccountId);
            }
            if(job.Source.Kind=="saved_folders"&&operation!="listFolders")throw new ArgumentException("A folder directory cannot scan or download media.");
            if(operation=="loginQr"&&job.Source.Platform!="telegram")throw new ArgumentException("QR login requires Telegram.");
            var entry=new Operation(jobId,job.Source.Platform,operation);
            entry.BridgePayload=bridge;
            repository.UpdateJob(jobId,"ready","已排队，等待前一个任务结束。",clearReason:true);
            pending.Enqueue(entry); pump ??= Task.Run(PumpAsync); Notify(jobId); return entry.Done.Task;
        }
    }
    public Task SendControlAsync(object control,CancellationToken ct=default)
    {
        lock(gate){
            if(!enabled||active==null||active.Cancel.IsCancellationRequested||!active.AwaitingInput)throw new InvalidOperationException("没有等待输入的任务。");
            var value=JsonSerializer.SerializeToElement(control,HubJson.Options);var command=value.GetProperty("command").GetString();
            if(command is "input" or "resend"){
                if(active.InputId==null||!value.TryGetProperty("inputId",out var id)||id.GetString()!=active.InputId)throw new InvalidOperationException("此输入请求已结束，请使用当前提示。");
                if(command=="resend"&&!(active.Delivery?.CanResend(DateTimeOffset.UtcNow-active.PromptReceived)??false))throw new InvalidOperationException(UserText.Error("resend_unavailable"));
            }
            active.AwaitingInput=false;
        }
        return runner.SendControlAsync(control,ct);
    }
    public async Task DisableAsync()
    {
        Task? wait;
        lock(gate) { enabled=false; stopping=true; CancelPending(_=>true); active?.Cancel.Cancel(); wait=pump; }
        Notify("");
        try { if(wait!=null) await wait.ConfigureAwait(false); }
        finally { lock(gate) stopping=false; Notify(""); }
    }
    public Task StopPlatformAsync(string platform)=>StopMatchingAsync(o=>o.Platform==platform);
    public Task StopJobAsync(string jobId)=>StopMatchingAsync(o=>o.JobId==jobId);
    async Task StopMatchingAsync(Func<Operation,bool> predicate)
    {
        Task? wait=null;
        lock(gate) { CancelPending(predicate); if(active!=null && predicate(active)) { active.Cancel.Cancel(); wait=active.Done.Task; } }
        if(wait!=null) await wait.ConfigureAwait(false); Notify("");
    }
    void CancelPending(Func<Operation,bool> predicate)
    {
        var keep=new Queue<Operation>();
        while(pending.TryDequeue(out var op))
        {
            if(!predicate(op)) { keep.Enqueue(op); continue; }
            repository.UpdateJob(op.JobId,"paused","已停止排队；继续需要手动操作。"); op.Cancel.Cancel(); op.Cancel.Dispose(); op.Done.TrySetResult(); Notify(op.JobId);
        }
        while(keep.TryDequeue(out var op)) pending.Enqueue(op);
    }
    async Task PumpAsync()
    {
        while(true)
        {
            Operation op;
            lock(gate)
            {
                if(!enabled || !pending.TryDequeue(out var next)) { active=null; pump=null; return; }
                active=op=next;
                resources=null;
                scanProgress=null;
            }
            try { await ExecuteAsync(op).ConfigureAwait(false); }
            catch(Exception error) when(StorageFailure.IsFull(error)){op.ReasonCode="disk_full";ReportStorageFailure();FinishState(op,"failed");}
            catch(OperationCanceledException) { FinishState(op,StorageWarning==null?"paused":"failed","cancelled"); }
            catch(AccountMismatchException) { op.ReasonCode="auth_required";FinishState(op,"needs_action"); }
            catch(Exception error) { RecordHostFailure(op,error); FinishState(op,op.ReasonCode is "auth_required" or "identity_unverified" or "folder_unverified" or "folder_members_unavailable" or "rate_limited" or "work_unavailable" or "embedded_unsupported" or "sensitive_content" or "work_unresolved" or "media_forbidden" or "input_required" or "source_tab_required" or "manual_wait_timeout" or "source_changed" or "browser_closed"?"needs_action":"failed","operation_failed"); }
            finally
            {
                try
                {
                    if(op.Checkpoint!=null)
                    {
                        var state=op.Cancel.IsCancellationRequested?(StorageWarning==null?"paused":"failed"):op.TerminalState;
                        op.Checkpoint=op.Checkpoint with{Phase="finished",TerminalState=state,UpdatedAt=DateTimeOffset.UtcNow};
                        FlushScanProgress(op,true);
                    }
                    if(op.Cancel.IsCancellationRequested)FinishState(op,StorageWarning==null?"paused":"failed","cancelled");
                }
                finally
                {
                    lock(gate){op.AwaitingInput=false;active=null;op.Cancel.Dispose();op.Done.TrySetResult();}
                }
                Notify(op.JobId);
            }
        }
    }
    async Task ExecuteAsync(Operation op)
    {
        var ct=op.Cancel.Token; ct.ThrowIfCancellationRequested(); StorageFailure.RequireMetadataSpace(paths.DataRoot); var job=repository.GetJob(op.JobId)!;
        if(op.Kind=="listFolders")repository.ClearFolders(job.Id);
        // A removed drive or a changed drive letter otherwise fails deep in the worker as operation_failed.
        if(op.Kind=="download"&&!DownloadRootAvailable(job.DownloadRoot))
        {op.ReasonCode="download_root_unavailable";op.Detail=UserText.DownloadRootUnavailable(job.DownloadRoot);FinishState(op,"needs_action");return;}
        if(op.Kind=="download"&&FolderPerTask&&job.TaskFolder==null)
        {var id=job.Id;job.TaskFolder=repository.EnsureTaskFolder(id,TaskFolders.Name(job,()=>repository.ListItems(id).Where(i=>i.Selected),AccountName?.Invoke(job.Source.Platform),DateTimeOffset.Now));}
        repository.UpdateJob(job.Id,op.Kind=="download"?"downloading":"scanning",op.Kind=="download"?"正在下载已勾选内容。":"正在处理，请稍候。"); Notify(job.Id);
        var batches=op.Kind=="download" ? await BuildBatchesAsync(job,op,ct).ConfigureAwait(false) : new List<List<ContentItem>?> { null }; var failed=false;
        foreach(var batch in batches)
        {
            ct.ThrowIfCancellationRequested(); job=repository.GetJob(job.Id)!;
            if(op.Kind=="download" && NeedsBinding(job.Source) && string.IsNullOrEmpty(job.Source.AccountId)) throw new AccountMismatchException();
            var request=Request(job,op.Kind,batch);request.BridgePayload=op.BridgePayload; var verified=false; WorkerEvent? complete=null; var allowed=batch?.ToDictionary(i=>i.Key);var received=new HashSet<(string Key,int Index)>();var chatIds=new HashSet<string>(StringComparer.Ordinal);
            await RunScanProgressAsync(op,request,async evt=>
            {
                ct.ThrowIfCancellationRequested(); if(complete!=null) throw new InvalidDataException("Event after completion.");
                if(evt.QrCode!=null&&evt.Type!="login_qr")throw new InvalidDataException("Unexpected QR payload.");
                if(evt.Folder!=null&&evt.Type!="folder")throw new InvalidDataException("Unexpected folder payload.");
                if(op.Kind is "listFolders" or "listChats"&&(evt.Type is "item" or "receipt" || evt.Item!=null || evt.Receipt!=null))throw new InvalidDataException("A directory cannot publish media.");
                switch(evt.Type)
                {
                    case "folder":
                        if(op.Kind!="listFolders")throw new InvalidDataException("Unexpected folder event.");
                        if(!verified)throw new AccountMismatchException();
                        SavedFolders.Validate(evt.Folder);repository.UpsertFolder(job.Id,evt.Folder!);
                        repository.UpdateJob(job.Id,"scanning",completeness:"partial");break;
                    case "login_qr":
                        if(op.Kind!="loginQr"||job.Source.Platform!="telegram"||op.QrSeen||op.HadInputWait||verified||evt.QrCode==null)throw new InvalidDataException("Unexpected login QR.");
                        evt.QrCode.DecodeValidated(DateTimeOffset.UtcNow);op.QrSeen=true;op.AwaitingInput=false;break;
                    case "account":
                        if((op.Kind is "login" or "loginQr")&&verified)throw new InvalidDataException("Duplicate login identity.");
                        if(evt.Authenticated==true && !string.IsNullOrWhiteSpace(evt.AccountId) && evt.Platform==job.Source.Platform)
                        { if(!repository.BindAccount(job.Id,evt.AccountId)) throw new AccountMismatchException(); verified=true; }
                        else if(NeedsBinding(job.Source)) throw new AccountMismatchException();
                        break;
                    case "item":
                        if(evt.Item==null || evt.Item.Platform!=job.Source.Platform) throw new InvalidDataException("Invalid item event.");
                        if(NeedsBinding(job.Source) && !verified) throw new AccountMismatchException();
                        evt.Item.Key=ContentIdentity.KeyFor(evt.Item);
                        if(allowed!=null && !allowed.ContainsKey(evt.Item.Key)) throw new InvalidDataException("Unselected item.");
                        // Reuse proof is issued by BuildBatches after hashing a
                        // receipt, never trusted from worker/platform item data.
                        foreach(var asset in evt.Item.Media){asset.ReuseFrom=null;asset.ReuseSha256=null;asset.ReuseBytes=null;}
                        repository.UpsertItems(job.Id,[evt.Item]);
                        if(CanProjectScan(op,evt)&&op.CommittedKeys.Add(evt.Item.Key))
                        {
                            op.Checkpoint=op.Checkpoint! with{Phase="scan",CommittedUniqueItemCount=op.CommittedKeys.Count,UpdatedAt=DateTimeOffset.UtcNow};
                            FlushScanProgress(op,op.CommittedKeys.Count==1);
                        }
                        if(op.Kind=="scan")repository.UpdateJob(job.Id,"scanning",completeness:"partial");
                        if(allowed!=null && !allowed[evt.Item.Key].MediaResolved)allowed[evt.Item.Key]=evt.Item;
                        break;
                    case "receipt":
                        if(evt.Receipt==null || allowed==null || !allowed.TryGetValue(evt.Receipt.ContentKey,out var selected) || (selected.MediaResolved && !selected.Media.Any(m=>m.Index==evt.Receipt.MediaIndex))) throw new InvalidDataException("Unselected receipt.");
                        if(NeedsBinding(job.Source) && !verified) throw new AccountMismatchException();
                        var receipt=evt.Receipt;
                        if(receipt.Status is "completed" or "skipped")
                        {
                            var full=Path.GetFullPath(receipt.FilePath);
                            if(!full.StartsWith(Path.TrimEndingDirectorySeparator(Path.GetFullPath(job.DownloadRoot))+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Receipt outside download root.");
                            if(!await HashMatchesAsync(receipt,ct).ConfigureAwait(false)) throw new InvalidDataException("Receipt file verification failed.");
                            ct.ThrowIfCancellationRequested();
                        }
                        receipt.DuplicateOfContentKey=null;receipt.DuplicateOfMediaIndex=null;
                        if(receipt.Status is "completed" or "skipped")
                        {
                            receipt.Sha256=receipt.Sha256.ToLowerInvariant();
                            foreach(var candidate in repository.FindDigestCandidates(receipt.Sha256,receipt.Bytes))
                                if(candidate.ContentKey!=receipt.ContentKey && candidate.Status is "completed" or "skipped" && await HashMatchesAsync(candidate,ct).ConfigureAwait(false))
                                {receipt.DuplicateOfContentKey=candidate.ContentKey;receipt.DuplicateOfMediaIndex=candidate.MediaIndex;break;}
                        }
                        receipt.Message=receipt.Status=="failed"?UserText.Error(receipt.ErrorCode):null; receipt.ErrorCode=UserText.SafeCode(receipt.ErrorCode);
                        repository.RecordReceipt(job.Id,receipt);received.Add((receipt.ContentKey,receipt.MediaIndex)); failed |= receipt.Status=="failed"; break;
                    case "complete":
                        if(evt.Status is not ("completed" or "paused" or "failed" or "needs_action") || evt.Completeness is not ("complete" or "partial" or "unknown")) throw new InvalidDataException("Invalid completion.");
                        if(UserText.SafeCode(evt.ReasonCode) is string terminalCode)op.ReasonCode=terminalCode;
                        else if(evt.Status=="completed"&&op.HadInputWait)op.ReasonCode=null;
                        if(evt.Status=="completed"&&(op.Kind is "login" or "loginQr")&&!verified)throw new InvalidDataException("Login did not confirm identity.");
                        if(evt.Status=="completed"&&op.Kind is "listFolders" or "listChats"&&!verified)throw new AccountMismatchException();
                        if(op.Kind=="listFolders"&&evt.Status=="completed"&&repository.GetFolders(job.Id).Count>=SavedFolders.DirectoryLimit(job.Source))
                        {evt.Completeness="partial";op.ReasonCode="item_limit";}
                        op.AwaitingInput=false;complete=evt; break;
                    case "needs_action":
                        if(evt.Delivery!=null&&(!evt.Delivery.IsValid||job.Source.Platform!="telegram"))throw new InvalidDataException("Invalid delivery projection.");
                        if(evt.InputId!=null&&(!Guid.TryParseExact(evt.InputId,"D",out _)))throw new InvalidDataException("Invalid input ID.");
                        op.InputId=evt.InputId;op.Delivery=evt.Delivery;op.PromptReceived=DateTimeOffset.UtcNow;
                        op.ReasonCode=UserText.SafeCode(evt.Code)??"operation_failed";op.AwaitingInput=evt.AwaitingInput==true;op.HadInputWait|=op.AwaitingInput;
                        if(op.ReasonCode=="rate_limited"&&evt.RetryAfterSeconds is >0 and <=86400)op.Detail=UserText.RateLimited(evt.RetryAfterSeconds.Value,DateTimeOffset.Now);
                        repository.UpdateJob(job.Id,"needs_action",op.Detail??UserText.Error(op.ReasonCode),reasonCode:op.ReasonCode);
                        if(CanProjectScan(op,evt)){op.Checkpoint=op.Checkpoint! with{Phase="waiting",UpdatedAt=DateTimeOffset.UtcNow};FlushScanProgress(op,true);}
                        if(op.ReasonCode=="disk_full")ReportStorageFailure();break;
                    case "progress":
                        if(CanProjectScan(op,evt)&&op.Checkpoint!.Observe(evt) is ScanCheckpoint next){op.Checkpoint=next;FlushScanProgress(op,false);}
                        break;
                    case "error":
                        failed=true;op.AwaitingInput=false;op.ReasonCode=UserText.SafeCode(evt.Code)??"operation_failed";
                        repository.UpdateJob(job.Id,"failed",UserText.Error(op.ReasonCode),reasonCode:op.ReasonCode);
                        if(op.ReasonCode=="disk_full")ReportStorageFailure();break;
                    case "chat":
                        if(op.Kind!="listChats"||evt.Chat==null || job.Source.Platform!="telegram") throw new InvalidDataException("Invalid chat.");
                        if(!verified)throw new AccountMismatchException();
                        ChatDirectoryState.Validate(evt.Chat);
                        if(chatIds.Add(evt.Chat.Id)&&chatIds.Count>Math.Min(job.Source.MaxItems>0?job.Source.MaxItems:ChatDirectoryState.Limit,ChatDirectoryState.Limit))throw new InvalidDataException("Chat directory limit exceeded.");
                        break;
                }
                Message?.Invoke(job.Id,evt); Notify(job.Id);
            },ct).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested(); if(complete==null) throw new InvalidDataException("No protocol completion.");
            if(op.Kind is "scan" or "listFolders" or "listChats" or "importBridge") repository.UpdateJob(job.Id,"scanning",op.ReasonCode==null?null:UserText.Error(op.ReasonCode),completeness:complete.Completeness,reasonCode:op.ReasonCode);
            if(complete.Status=="needs_action") { FinishState(op,"needs_action","input_required"); return; }
            if(complete.Status=="paused") throw new OperationCanceledException(); failed |= complete.Status=="failed";
            if(allowed!=null)
                foreach(var item in allowed.Values)
                {
                    if(!item.MediaResolved || item.Media.Count==0)failed=true;
                    foreach(var asset in item.Media.Where(m=>!received.Contains((item.Key,m.Index))))
                    {
                        failed=true;repository.RecordReceipt(job.Id,new(){ContentKey=item.Key,MediaIndex=asset.Index,Status="failed",ErrorCode="transfer_failed",Message="未收到此媒体的完成记录，请手动继续补缺。"});
                    }
                }
        }
        ct.ThrowIfCancellationRequested();
        if(!failed&&op.Kind=="importBridge"&&job.Source.Bridge is {ConfirmationRequired:true,Confirmed:false}){op.ReasonCode="bridge_account_mismatch";FinishState(op,"needs_action");return;}
        if(op.BridgeSkippedCount>0){op.ReasonCode="bridge_refresh_required";FinishState(op,"needs_action");return;}
        if(!failed&&op.UnsupportedSkippedCount>0){op.ReasonCode="media_unsupported";FinishState(op,"completed");return;}
        FinishState(op,failed?"failed":"completed",failed?"transfer_failed":null);
    }
    bool CanProjectScan(Operation op,WorkerEvent evt)
    {
        lock(gate)return active==op&&op.ProgressOpen&&op.Checkpoint!=null&&evt.RequestId==op.Checkpoint.RequestId;
    }
    async Task RunScanProgressAsync(Operation op,WorkerRequest request,Func<WorkerEvent,Task> emit,CancellationToken ct)
    {
        if(op.Kind!="scan"){await RunObservedAsync(op,request,emit,ct).ConfigureAwait(false);return;}
        op.Checkpoint=new(){JobId=op.JobId,Generation=op.Id,RequestId=request.RequestId};op.ProgressOpen=true;
        FlushScanProgress(op,true);
        // One serialized callback lane also fences retained/late fixture callbacks.
        var callbacks=new SemaphoreSlim(1,1);
        try
        {
            await RunObservedAsync(op,request,async evt=>
            {
                await callbacks.WaitAsync().ConfigureAwait(false);
                try
                {
                    lock(gate)if(!op.ProgressOpen||active!=op)return;
                    if(evt.RequestId.Length>0&&evt.RequestId!=request.RequestId)return;
                    await emit(evt).ConfigureAwait(false);
                }
                finally{callbacks.Release();}
            },ct).ConfigureAwait(false);
        }
        finally{await callbacks.WaitAsync().ConfigureAwait(false);try{op.ProgressOpen=false;}finally{callbacks.Release();}}
    }
    void FlushScanProgress(Operation op,bool force)
    {
        if(op.Checkpoint==null)return;
        var now=System.Diagnostics.Stopwatch.GetTimestamp();
        if(force||op.LastProgressWrite==0||System.Diagnostics.Stopwatch.GetElapsedTime(op.LastProgressWrite,now)>=TimeSpan.FromSeconds(1))
        {
            op.LastProgressWrite=now;
            try{repository.SaveScanProgress(op.Checkpoint);op.PersistedCheckpoint=op.Checkpoint;op.ProgressSaveFailed=false;}
            catch(Exception error)when(error is Microsoft.Data.Sqlite.SqliteException or IOException or UnauthorizedAccessException)
            {
                op.ProgressSaveFailed=true;ScanProgressWarning="扫描进度未保存";
                if(StorageFailure.IsFull(error))
                {
                    op.TerminalState="failed";
                    op.Checkpoint=op.Checkpoint with{Phase="finished",TerminalState="failed"};
                    ReportStorageFailure();
                }
            }
        }
        lock(gate)scanProgress=new(op.Checkpoint,op.PersistedCheckpoint,op.ProgressSaveFailed);
    }
    // Host-side failures otherwise surface only as operation_failed; keep the type and a code-literal message.
    void RecordHostFailure(Operation op,Exception error)
    {
        try{var log=new DiagnosticLog();using var entry=JsonDocument.Parse(JsonSerializer.Serialize(new{hostFailure=error.GetType().Name,hostMessage=error.Message,hostStage=error.TargetSite?.Name}));log.Add(entry.RootElement);log.Save(paths.DataRoot,op.JobId);}
        catch(Exception logError)when(logError is IOException or UnauthorizedAccessException or JsonException){}
    }
    async Task RunObservedAsync(Operation op, WorkerRequest request, Func<WorkerEvent, Task> emit, CancellationToken ct)
    {
        var diagnostics=new DiagnosticLog();var accepting=true;
        try{await RunMeasuredAsync(op,request,evt=>{
            if(evt.Type!="diagnostic")return emit(evt);
            lock(gate)if(accepting&&active==op&&evt.RequestId==request.RequestId&&evt.Diagnostic is {} entry)diagnostics.Add(entry);
            return Task.CompletedTask;
        },ct).ConfigureAwait(false);}
        catch(Exception error)when(error is not OperationCanceledException)
        {
            // Host-side failures otherwise surface only as operation_failed; keep the type and a code-literal message.
            using var entry=JsonDocument.Parse(JsonSerializer.Serialize(new{hostFailure=error.GetType().Name,hostMessage=error.Message}));
            diagnostics.Add(entry.RootElement);throw;
        }
        finally{lock(gate)accepting=false;diagnostics.Save(paths.DataRoot,op.JobId);}
    }
    async Task RunMeasuredAsync(Operation op, WorkerRequest request, Func<WorkerEvent, Task> emit, CancellationToken ct)
    {
        if (runner is not IResourceWorkerRunner measured) { await runner.RunAsync(request, emit, ct).ConfigureAwait(false); return; }
        var accepting = true;
        ResourceMetrics latest = new() { RequestId = request.RequestId, Operation = request.Operation, OperationId = op.Id };
        lock (gate) resources = new(op.JobId, latest.AcrossBatches(op.ResourceSummary));
        void Observe(ResourceMetrics value)
        {
            lock (gate)
            {
                if (!accepting || active != op || value.RequestId != request.RequestId || value.Operation != request.Operation || latest.FinishedAt != null) return;
                latest = value with { OperationId = op.Id }; resources = new(op.JobId, latest.AcrossBatches(op.ResourceSummary));
            }
        }
        try { await measured.RunWithResourcesAsync(request, emit, Observe, ct).ConfigureAwait(false); }
        finally
        {
            lock (gate)
            {
                accepting = false;
                if (latest.FinishedAt == null) latest = latest.Finish();
                op.ResourceSummary = latest.AcrossBatches(op.ResourceSummary);
                resources = new(op.JobId, op.ResourceSummary);
            }
            // Only the serial operation pump writes summaries, after owned cleanup has settled.
            // A failed resource write must not reclassify successful media work as failed.
            try { repository.SaveResourceSummary(op.JobId, latest); }
            catch (Exception e) when (e is Microsoft.Data.Sqlite.SqliteException or IOException or UnauthorizedAccessException)
            { ResourceWarning = "资源记录未保存"; }
        }
    }
    static bool NeedsBinding(SourceRequest source)=>source.Kind!="bridge"&&(!string.IsNullOrEmpty(source.AccountId) || source.Kind is "saved" or "liked" or "saved_folder" or "saved_folders" || source.Platform=="telegram");
    WorkerRequest Request(HubJob job,string kind,List<ContentItem>? items)=>new(){RequestId=Guid.NewGuid().ToString("N"),Operation=kind,Source=job.Source,Items=items,Paths=new(){DataRoot=paths.DataRoot,DownloadRoot=job.DownloadRoot,Category=job.Category,Folder=job.TaskFolder??"",BrowserExecutable=paths.BrowserExecutable,EngineRoot=paths.EngineRoot},MaxConcurrentDownloads=2};
    async Task<List<List<ContentItem>?>> BuildBatchesAsync(HubJob job,Operation op,CancellationToken ct)
    {
        repository.UpdateJob(job.Id,"downloading","正在核验已完成文件；仅检查本次勾选项，可随时停止。");Notify(job.Id);
        var batches=new List<List<ContentItem>?>(); var batch=new List<ContentItem>();
        var bytes=JsonSerializer.SerializeToUtf8Bytes(Request(job,"download",[]),HubJson.Options).Length; var baseBytes=bytes;
        var selected=repository.ListItems(job.Id).Where(i=>i.Selected).ToList();
        if(job.Source.Kind=="bridge")
        {
            op.BridgeSkippedCount=selected.Count(i=>!i.MediaResolved||i.Media.Count==0);
            selected=selected.Where(i=>i.MediaResolved&&i.Media.Count>0).ToList();
        }
        else if(job.Source.Platform=="telegram")
        {
            // File, voice and sticker messages never resolve to image/video (kind comes from MIME); skip them instead of stopping the batch.
            op.UnsupportedSkippedCount=selected.Count(i=>!i.MediaResolved&&i.Media.Count==0);
            selected=selected.Where(i=>i.MediaResolved||i.Media.Count>0).ToList();
        }
        foreach(var item in selected)
        {
            ct.ThrowIfCancellationRequested();
            if(item.MediaResolved)
            {
                var remaining=new List<MediaAsset>();
                foreach(var m in item.Media)
                {
                    m.ReuseFrom=null;m.ReuseSha256=null;m.ReuseBytes=null;
                    var receipt=repository.FindVerifiedReceipt(item.Key,m.Index);
                    if(receipt==null || !await HashMatchesAsync(receipt,ct).ConfigureAwait(false)){remaining.Add(m);continue;}
                    if(!Within(job.DownloadRoot,receipt.FilePath)){remaining.Add(m);continue;}
                    if(!Within(Path.Combine(job.DownloadRoot,CategoryName.Validate(job.Category)),receipt.FilePath))
                    {m.ReuseFrom=receipt.FilePath;m.ReuseSha256=receipt.Sha256.ToLowerInvariant();m.ReuseBytes=receipt.Bytes;remaining.Add(m);continue;}
                    receipt.Status="skipped"; receipt.Message=null; repository.RecordReceipt(job.Id,receipt);
                }
                item.Media=remaining;
                if(item.Media.Count==0) continue;
            }
            var size=JsonSerializer.SerializeToUtf8Bytes(item,HubJson.Options).Length+1;
            if(size+baseBytes>8*1024*1024) throw new InvalidDataException("Item exceeds request limit.");
            if(batch.Count>=batchItems || bytes+size>8*1024*1024) { batches.Add(batch); batch=[]; bytes=baseBytes; }
            batch.Add(item); bytes+=size;
        }
        if(batch.Count>0) batches.Add(batch); return batches;
    }
    static bool DownloadRootAvailable(string root)
    {
        try{var drive=Path.GetPathRoot(Path.GetFullPath(root));return !string.IsNullOrEmpty(drive)&&Directory.Exists(drive);}
        catch(Exception e)when(e is ArgumentException or NotSupportedException or IOException or UnauthorizedAccessException){return false;}
    }
    static bool Within(string root,string file)=>Path.GetFullPath(file).StartsWith(Path.TrimEndingDirectorySeparator(Path.GetFullPath(root))+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
    static async Task<bool> HashMatchesAsync(DownloadReceipt receipt,CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if(receipt.Bytes<=0 || receipt.Sha256 is not {Length:64} || !receipt.Sha256.All(Uri.IsHexDigit))return false;
        try
        {
            if(!Path.IsPathFullyQualified(receipt.FilePath) || receipt.FilePath.StartsWith(@"\\",StringComparison.Ordinal) || new DriveInfo(Path.GetPathRoot(receipt.FilePath)!).DriveType==DriveType.Network)return false;
            // Reject alternate data streams as well as directories/devices: a receipt names one ordinary media file.
            if(receipt.FilePath[Path.GetPathRoot(receipt.FilePath)!.Length..].Contains(':'))return false;
            PrivateStorage.RejectLinks(Path.GetDirectoryName(receipt.FilePath)!);
            if((File.GetAttributes(receipt.FilePath)&(FileAttributes.ReparsePoint|FileAttributes.Directory|FileAttributes.Device))!=0)return false;
            await using var stream=new FileStream(receipt.FilePath,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.Asynchronous|FileOptions.SequentialScan);
            if(stream.Length!=receipt.Bytes)return false;
            var hash=await SHA256.HashDataAsync(stream,ct).ConfigureAwait(false);
            return Convert.ToHexString(hash).Equals(receipt.Sha256,StringComparison.OrdinalIgnoreCase);
        }
        catch(Exception e)when(e is IOException or UnauthorizedAccessException){return false;}
    }
    void Notify(string id)=>Changed?.Invoke(id);
    public async ValueTask DisposeAsync() { lock(gate) disposed=true; await DisableAsync().ConfigureAwait(false); }
    sealed class AccountMismatchException : Exception;
    sealed class Operation(string jobId,string platform,string kind)
    {
        public int BridgeSkippedCount {get;set;}
        public int UnsupportedSkippedCount {get;set;}
        // A specific user-facing message for ReasonCode (e.g. the wait time or the missing location).
        public string? Detail {get;set;}
        public JsonElement? BridgePayload {get;set;}
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public ResourceMetrics? ResourceSummary { get; set; }
        public string TerminalState {get;set;}="failed";
        public ScanCheckpoint? Checkpoint {get;set;} public ScanCheckpoint? PersistedCheckpoint {get;set;}
        public HashSet<string> CommittedKeys {get;}=[];
        public bool ProgressOpen {get;set;} public bool ProgressSaveFailed {get;set;} public long LastProgressWrite {get;set;}
        public string JobId {get;}=jobId; public string Platform {get;}=platform; public string Kind {get;}=kind;
        public bool QrSeen {get;set;} public string? InputId {get;set;} public LoginDelivery? Delivery {get;set;} public DateTimeOffset PromptReceived {get;set;}
        public string? ReasonCode {get;set;} public bool AwaitingInput {get;set;} public bool HadInputWait {get;set;}
        public CancellationTokenSource Cancel {get;}=new(); public TaskCompletionSource Done {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
