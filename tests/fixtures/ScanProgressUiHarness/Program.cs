using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Data.Sqlite;
using UnifiedMediaHub.App;
using UnifiedMediaHub.Core;

internal static class Program
{
    static int checks;
    static void Require(bool condition,string name){checks++;if(!condition)throw new Exception(name);}
    static void Call(MainWindow window,string method)=>typeof(MainWindow).GetMethod(method,BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(window,null);
    static void Select(MainWindow window,string job)=>typeof(MainWindow).GetField("currentJobId",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(window,job);
    static ContentItem Item(string id)=>new(){Key="x:"+id,Platform="x",ContentId=id,SourceUrl="https://x.com/synthetic/status/"+id,Title="离线样本 "+id};

    [STAThread]
    static int Main()
    {
        var fixtureBase=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"UMH-scan-progress-ui"));
        var root=Path.GetFullPath(Path.Combine(fixtureBase,Guid.NewGuid().ToString("N")));Directory.CreateDirectory(root);
        AppServices? services=null;HubCoordinator? hub=null;Application? app=null;
        try
        {
            app=new Application();services=new AppServices(Path.Combine(root,"data"),root);
            services.Hub.DisposeAsync().AsTask().GetAwaiter().GetResult();
            var runner=new Fixture();hub=new HubCoordinator(services.Repository,runner,new(){DataRoot=root,DownloadRoot=root});
            typeof(AppServices).GetField("<Hub>k__BackingField",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(services,hub);
            var window=new MainWindow(services){Width=1000,Height=700};
            var current=(TextBlock)window.FindName("ScanCheckpointLine");var durable=(TextBlock)window.FindName("ScanDurableLine");
            var summary=(TextBlock)window.FindName("ScanSummary");
            Call(window,"Refresh");Call(window,"RefreshScanProgress");
            Require(current.Text.Length==0&&durable.Text.Length==0&&hub.ActiveCount==0,"empty database window constructs and refreshes without checkpoint or worker");
            var job=services.Repository.CreateJob(new(){Platform="x",Kind="profile",Url="https://x.com/synthetic"},root);
            services.Repository.UpsertItems(job.Id,[Item("old")]);Select(window,job.Id);Call(window,"Refresh");
            Require(current.Text.Length==0,"no invented checkpoint before scan");
            hub.Enable();var submitted=hub.Submit(job.Id,"scan");runner.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            Call(window,"Refresh");Call(window,"RefreshScanProgress");
            Require(current.Text.Contains("本轮（内存）")&&current.Text.Contains("保存/确认 2 项"),"live committed count");
            Require(summary.Text.Contains("清单累计 3 项"),"historical inventory separate");
            Require(current.Text.Contains("观察 8 / 总数 未知")&&!current.Text.Contains('%'),"unknown total without percentage");
            Require(current.Text.Contains("滚动轮次 4")&&current.Text.Contains("API 页数 2"),"rounds and pages distinct");
            Require(durable.Text.Contains("本轮 1 项")&&current.Text.Contains("扫描中"),"current differs from last durable first item");
            Capture(window,"scan-progress-live-minimum.png",current,durable);

            using(var db=new SqliteConnection($"Data Source={Path.Combine(services.DataRoot,"private","hub.db")};Pooling=False"))
            {
                db.Open();using var command=db.CreateCommand();command.CommandText="CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON scan_progress BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END";command.ExecuteNonQuery();
            }
            runner.Release.TrySetResult();submitted.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();Call(window,"Refresh");
            Require(current.Text.Contains("本轮结束（内存）")&&current.Text.Contains("完成"),"terminal phase and state");
            Require(durable.Text.Contains("扫描进度未保存")&&durable.Text.Contains("本轮 1 项"),"write failure preserves durable display");
            Require(!current.Text.Contains(job.Id)&&!current.Text.Contains("private")&&!durable.Text.Contains("private"),"projection privacy");
            Capture(window,"scan-progress-unsaved-minimum.png",current,durable);

            using(var db=new SqliteConnection($"Data Source={Path.Combine(services.DataRoot,"private","hub.db")};Pooling=False"))
            {db.Open();using var command=db.CreateCommand();command.CommandText="DROP TRIGGER reject_checkpoint";command.ExecuteNonQuery();}
            var recorded=services.Repository.GetLatestScanProgress(job.Id)!.UpdatedAt;
            hub.DisposeAsync().AsTask().GetAwaiter().GetResult();hub=new HubCoordinator(services.Repository,runner,new(){DataRoot=root,DownloadRoot=root});
            typeof(AppServices).GetField("<Hub>k__BackingField",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(services,hub);
            var reopened=new MainWindow(services){Width=1000,Height=700};Select(reopened,job.Id);Call(reopened,"Refresh");
            var history=(TextBlock)reopened.FindName("ScanCheckpointLine");var saved=(TextBlock)reopened.FindName("ScanDurableLine");
            Require(history.Text.Contains("历史检查点")&&history.Text.Contains("曾中断")&&history.Text.Contains("确认 1 项"),"reopen shows interrupted durable history");
            Require(services.Repository.GetLatestScanProgress(job.Id)!.UpdatedAt==recorded,"reopen preserves actual checkpoint time");
            Require(!hub.Enabled&&hub.ActiveCount==0&&runner.Calls==1,"reopen never starts worker");
            Capture(reopened,"scan-progress-history-minimum.png",history,saved);
            Console.WriteLine($"PASS: {checks} offline WPF assertions; 1000x700 minimum-window client layout; no platform access.");return 0;
        }
        catch(Exception e){Console.Error.WriteLine(e);return 1;}
        finally
        {
            hub?.DisposeAsync().AsTask().GetAwaiter().GetResult();services?.Previews.DisposeAsync().AsTask().GetAwaiter().GetResult();services?.Dispose();app?.Shutdown();DeleteFixture(root,fixtureBase);
        }
    }

    static void Capture(MainWindow window,string name,params FrameworkElement[] controls)
    {
        Call(window,"RefreshCounts");
        // Conservative client bounds for the app's 1000x700 minimum outer window.
        var content=(FrameworkElement)window.Content;content.Measure(new Size(984,660));content.Arrange(new Rect(0,0,984,660));content.UpdateLayout();
        foreach(var control in controls)
        {
            var rect=control.TransformToAncestor(content).TransformBounds(new Rect(control.RenderSize));
            Require(rect.Left>=0&&rect.Right<=984&&rect.Top>=0&&rect.Bottom<=660&&control.DesiredSize.Height<=control.ActualHeight+control.Margin.Top+control.Margin.Bottom+0.5,$"checkpoint within minimum client bounds: {rect}; desired {control.DesiredSize.Height}; actual {control.ActualHeight}");
        }
        var directory=new DirectoryInfo(AppContext.BaseDirectory);while(directory!=null&&!File.Exists(Path.Combine(directory.FullName,"AGENTS.md")))directory=directory.Parent;
        var output=Path.Combine(directory!.FullName,"artifacts","scan-progress");Directory.CreateDirectory(output);
        var visual=new DrawingVisual();using(var drawing=visual.RenderOpen())drawing.DrawRectangle(window.Background,null,new Rect(0,0,984,660));
        var bitmap=new RenderTargetBitmap(984,660,96,96,PixelFormats.Pbgra32);bitmap.Render(visual);bitmap.Render(content);
        var png=new PngBitmapEncoder();png.Frames.Add(BitmapFrame.Create(bitmap));using var stream=File.Create(Path.Combine(output,name));png.Save(stream);
    }

    static void DeleteFixture(string root,string fixtureBase)
    {
        var target=Path.GetFullPath(root);var allowed=Path.GetFullPath(fixtureBase);
        if(!string.Equals(Path.GetDirectoryName(target),allowed,StringComparison.OrdinalIgnoreCase)||!Guid.TryParseExact(Path.GetFileName(target),"N",out _))throw new IOException("Fixture deletion boundary failed.");
        if(!Directory.Exists(target))return;
        for(var ancestor=new DirectoryInfo(target);ancestor!=null;ancestor=ancestor.Parent)if((ancestor.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Fixture ancestor is a link.");
        var pending=new Stack<string>();pending.Push(target);
        while(pending.TryPop(out var directory))foreach(var entry in Directory.EnumerateFileSystemEntries(directory)){var attributes=File.GetAttributes(entry);if((attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Fixture descendant is a link.");if((attributes&FileAttributes.Directory)!=0)pending.Push(entry);}
        Directory.Delete(target,true);
    }

    sealed class Fixture:IWorkerRunner
    {
        public int Calls;public TaskCompletionSource Entered{get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);public TaskCompletionSource Release{get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task RunAsync(WorkerRequest request,Func<WorkerEvent,Task> emit,CancellationToken ct)
        {
            Calls++;foreach(var id in new[]{"1","2","1"})await emit(new(){Type="item",RequestId=request.RequestId,Item=Item(id)});
            await emit(new(){Type="progress",RequestId=request.RequestId,Phase="scan",Current=8,ObservedRounds=4,ObservedPages=2,Message="synthetic private message"});
            Entered.TrySetResult();await Release.Task.WaitAsync(ct);await emit(new(){Type="complete",RequestId=request.RequestId,Status="completed",Completeness="partial"});
        }
        public Task SendControlAsync(object control,CancellationToken ct=default)=>Task.CompletedTask;
    }
}
