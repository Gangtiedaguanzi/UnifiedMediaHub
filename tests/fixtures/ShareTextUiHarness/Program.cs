using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using UnifiedMediaHub.App;
using UnifiedMediaHub.Core;
internal static class Program
{
    static int checks;
    static void Require(bool condition,string message){checks++;if(!condition)throw new Exception(message);}
    static void Invoke(MainWindow window,string method,params object?[] args)=>typeof(MainWindow).GetMethod(method,BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(window,args);
    static void Drain(){var frame=new DispatcherFrame();Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ContextIdle,()=>frame.Continue=false);Dispatcher.PushFrame(frame);}
    static void Wait(Task task){var deadline=DateTime.UtcNow.AddSeconds(10);while(!task.IsCompleted){if(DateTime.UtcNow>deadline)throw new TimeoutException("Fixture timeout");Drain();Thread.Sleep(5);}task.GetAwaiter().GetResult();Drain();}
    sealed class ScanFixture:IWorkerRunner
    {
        public List<WorkerRequest> Requests {get;}=[];
        public async Task RunAsync(WorkerRequest request,Func<WorkerEvent,Task> emit,CancellationToken ct)
        {
            Requests.Add(request);ct.ThrowIfCancellationRequested();
            if(request.Operation!="scan")throw new InvalidOperationException("Fixture forbids download/login/other operations");
            var source=request.Source;
            await emit(new(){Type="item",RequestId=request.RequestId,Item=new(){Platform=source.Platform,ContentId="123",Key=source.Platform+":123",SourceUrl=source.Url,Title="离线合成作品",Selected=true,MediaResolved=true,Media=[new(){Index=1,Kind=source.Platform=="douyin"?"video":"image",Extension=source.Platform=="douyin"?"mp4":"jpg"}]}});
            await emit(new(){Type="complete",RequestId=request.RequestId,Status="completed",Completeness="complete"});
        }
        public Task SendControlAsync(object value,CancellationToken ct=default)=>throw new InvalidOperationException("Fixture forbids controls");
    }
    [STAThread] static int Main()
    {
        var allowed=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"UMH-share-text-ui"));var root=Path.Combine(allowed,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        Application? app=null;AppServices? services=null;
        try
        {
            app=new Application();SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext());services=new AppServices(Path.Combine(root,"data"),root);
            services.Hub.DisposeAsync().AsTask().GetAwaiter().GetResult();var worker=new ScanFixture();var hub=new HubCoordinator(services.Repository,worker,new(){DataRoot=root,DownloadRoot=root});
            typeof(AppServices).GetField("<Hub>k__BackingField",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(services,hub);
            var window=new MainWindow(services);var input=(TextBox)window.FindName("SourceUrl");hub.Enable();
            void Scan(string text){input.Text=text;Invoke(window,"Scan_Click",null,new RoutedEventArgs());Wait(window.LastAction);Invoke(window,"Refresh");}
            void Accept(string text,string expected,string platform)
            {
                var jobs=services.Repository.ListJobs().Count;var requests=worker.Requests.Count;Scan(text);
                Require(services.Repository.ListJobs().Count==jobs+1&&worker.Requests.Count==requests+1,"accepted share creates exactly one scan job");
                Require(worker.Requests.Last().Operation=="scan"&&worker.Requests.Last().Source.Url==expected&&worker.Requests.Last().Source.Platform==platform,"Scan_Click preserves classified exact URL and platform");
                Require(window.Rows.Count==1&&window.Rows[0].Selected,"synthetic scanned item reaches selectable preview");
                Require(worker.Requests.All(r=>r.Operation=="scan"),"scan never auto-downloads even selected resolved media");
            }
            Accept("1.71 abc:/ 今天的合成视频！ #离线 https://v.douyin.com/SyntheticOnly/ 复制此链接，打开Dou音搜索，直接观看视频！","https://v.douyin.com/SyntheticOnly/","douyin");
            Accept("分享推文\r\nhttps://x.com/synthetic/status/123/photo/2\r\n只看链接目标","https://x.com/synthetic/status/123/photo/2","x");
            Accept("https://www.xiaohongshu.com/explore/abc?xsec_token=synthetic%2b%2F%3D+.,&xsec_source=pc","https://www.xiaohongshu.com/explore/abc?xsec_token=synthetic%2b%2F%3D+.,&xsec_source=pc","xiaohongshu");
            foreach(var rejected in new[]{
                "两个 https://v.douyin.com/SyntheticOnly/ https://x.com/synthetic/status/123",
                "同一个 https://x.com/synthetic/status/123 https://x.com/synthetic/status/123",
                "https://user:secret@x.com/synthetic/status/123",
                "https://x.com:8123/synthetic/status/123",
                "https://x.com.evil.invalid/synthetic/status/123",
                "javascript:https://x.com/synthetic/status/123",
                "file:///C:/https://www.douyin.com/video/123",
                "ftp://example.test/https://x.com/synthetic/status/123"})
            {
                var jobs=services.Repository.ListJobs().Count;var requests=worker.Requests.Count;var preview=window.Rows.Single().Item.Key;Scan(rejected);
                Require(services.Repository.ListJobs().Count==jobs&&worker.Requests.Count==requests,"rejected input creates no job and starts no operation");
                Require(window.Rows.Single().Item.Key==preview,"rejected input retains preceding preview");
            }
            Require(worker.Requests.Count==3&&worker.Requests.All(r=>r.Operation=="scan"),"only three explicit scans, zero downloads/login/controls");
            Require(hub.ActiveCount==0&&hub.PendingCount==0,"all synthetic operations settled");
            Console.WriteLine($"PASS {checks} offline WPF share-text assertions; 3 scan requests, zero downloads; no browser/network/platform.");return 0;
        }
        catch(Exception e){Console.Error.WriteLine(e);return 1;}
        finally
        {
            services?.Hub.DisposeAsync().AsTask().GetAwaiter().GetResult();services?.Previews.DisposeAsync().AsTask().GetAwaiter().GetResult();services?.Dispose();app?.Shutdown();
            var target=Path.GetFullPath(root);if(Path.GetDirectoryName(target)!=allowed||!Guid.TryParseExact(Path.GetFileName(target),"N",out _))throw new IOException("Fixture boundary");
            for(var ancestor=new DirectoryInfo(target);ancestor!=null;ancestor=ancestor.Parent)if((ancestor.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Fixture ancestor link");
            var pending=new Stack<string>();pending.Push(target);while(pending.TryPop(out var dir))foreach(var entry in Directory.EnumerateFileSystemEntries(dir)){var attributes=File.GetAttributes(entry);if((attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Fixture descendant link");if((attributes&FileAttributes.Directory)!=0)pending.Push(entry);}Directory.Delete(target,true);
        }
    }
}
