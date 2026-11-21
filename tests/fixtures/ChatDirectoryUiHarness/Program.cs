using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using UnifiedMediaHub.App;
using UnifiedMediaHub.Core;
internal static class Program
{
    static int checks;
    static void Require(bool value,string message){checks++;if(!value)throw new Exception(message);}
    static object? Call(MainWindow w,string name,params object?[] args)=>typeof(MainWindow).GetMethod(name,BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(w,args);
    static void Wait(Task task){var until=DateTime.UtcNow.AddSeconds(10);while(!task.IsCompleted){if(DateTime.UtcNow>until)throw new TimeoutException();Drain();Thread.Sleep(5);}task.GetAwaiter().GetResult();Drain();}
    static void Drain(){var frame=new DispatcherFrame();Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ContextIdle,()=>frame.Continue=false);Dispatcher.PushFrame(frame);}
    sealed class DirectoryFixture:IWorkerRunner
    {
        public int Requests;
        public List<WorkerRequest> Captured {get;}=[];
        public async Task RunAsync(WorkerRequest r,Func<WorkerEvent,Task> emit,CancellationToken ct){Requests++;Captured.Add(r);ct.ThrowIfCancellationRequested();await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId="123"});if(r.Operation=="listChats"){await emit(new(){Type="chat",Chat=new(){Id="channel_123",Title="Synthetic chat"}});for(var i=1;i<=2000;i++)await emit(new(){Type="chat",Chat=new(){Id="channel_"+(1000+i),Title="Filler "+i}});await emit(new(){Type="chat",Chat=new(){Id="user_77",Title="Kestrel Synthetic",Username="kestrel_synthetic"}});}await emit(new(){Type="complete",Status="completed",Completeness="partial"});}
        public Task SendControlAsync(object value,CancellationToken ct=default)=>Task.CompletedTask;
    }
    [STAThread] static int Main()
    {
        var fixtureBase=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"UMH-chat-directory-ui"));var root=Path.Combine(fixtureBase,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        Application? app=null;AppServices? services=null;
        try
        {
            app=new Application();SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext());services=new AppServices(Path.Combine(root,"data"),root);services.Hub.DisposeAsync().AsTask().GetAwaiter().GetResult();var runner=new DirectoryFixture();var hub=new HubCoordinator(services.Repository,runner,new(){DataRoot=root,DownloadRoot=root});typeof(AppServices).GetField("<Hub>k__BackingField",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(services,hub);var window=new MainWindow(services);var chats=(ComboBox)window.FindName("Chats");
            Call(window,"HandleMessage","stale-job",new WorkerEvent{Type="chat",Chat=new(){Id="channel_999",Title="stale"}});
            Require(chats.Items.Count==0,"unowned chat event must not populate chooser");
            services.Hub.Enable();Call(window,"Chats_Click",null,new RoutedEventArgs());Wait(window.LastAction);Require(runner.Requests==0,"unconfirmed account starts no worker");
            services.Accounts.Add(new(){Platform="telegram",AccountId="123"});
            Call(window,"Chats_Click",null,new RoutedEventArgs());Wait(window.LastAction);Call(window,"RefreshCounts");
            Require(chats.Items.Count==2002,"bound completed directory populates every returned chat");var search=(TextBox)window.FindName("ChatSearch");search.Text="KESTREL";Require(chats.Items.Count==1&&((WorkerChat)chats.SelectedItem).Id=="user_77","search filters by title, case-insensitive, and selects the match");search.Text="kestrel_syn";Require(chats.Items.Count==1,"search matches username");search.Text="";Require(chats.Items.Count==2002,"clearing search restores the directory");chats.SelectedItem=chats.Items.Cast<WorkerChat>().First(c=>c.Id=="channel_123");
            var state=(ChatDirectoryState)typeof(MainWindow).GetField("chatDirectory",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(window)!;
            var job=services.Repository.GetJob(state.JobId!)!;Require(job.Source.MaxItems==ChatDirectoryState.Limit&&job.Source.AccountId=="123","actual UI request bound with the directory limit");
            Require(((ComboBox)window.FindName("Topics")).Items.Count==0,"bounded directory never presents unloaded topics");
            Require(((Button)window.FindName("ChatScanButton")).IsEnabled,"completed current directory selectable");
            var content=(FrameworkElement)window.Content;content.Measure(new Size(984,660));content.Arrange(new Rect(0,0,984,660));content.UpdateLayout();
            var summary=(TextBlock)window.FindName("ChatDirectorySummary");var bounds=summary.TransformToAncestor(content).TransformBounds(new Rect(summary.RenderSize));
            Require(bounds.Right<=984&&bounds.Bottom<=660&&summary.DesiredSize.Height<=summary.ActualHeight+summary.Margin.Top+summary.Margin.Bottom+0.5,"directory summary fits minimum client bounds");
            var visual=new DrawingVisual();using(var drawing=visual.RenderOpen())drawing.DrawRectangle(window.Background,null,new Rect(0,0,984,660));var bitmap=new RenderTargetBitmap(984,660,96,96,PixelFormats.Pbgra32);bitmap.Render(visual);bitmap.Render(content);
            var directory=new DirectoryInfo(AppContext.BaseDirectory);while(directory!=null&&!File.Exists(Path.Combine(directory.FullName,"AGENTS.md")))directory=directory.Parent;var output=Path.Combine(directory!.FullName,"artifacts","telegram-directory-ui");Directory.CreateDirectory(output);var png=new PngBitmapEncoder();png.Frames.Add(BitmapFrame.Create(bitmap));using(var stream=File.Create(Path.Combine(output,"directory-minimum.png")))png.Save(stream);
            Call(window,"HandleMessage","stale-job",new WorkerEvent{Type="complete",Status="failed",Completeness="unknown"});Require(state.Status=="completed","foreign terminal cannot retire current directory");
            Call(window,"Refresh");var history=(DataGrid)window.FindName("HistoryGrid");history.SelectedItem=history.Items.Cast<HistoryRow>().Single(r=>r.Job.Id==job.Id);
            Call(window,"Rescan_Click",null,new RoutedEventArgs());Wait(window.LastAction);Call(window,"RefreshCounts");
            Require(runner.Captured.Last().Operation=="listChats"&&runner.Captured.Last().Source.MaxItems==ChatDirectoryState.Limit&&state.JobId==job.Id,"historical directory reopens bounded directory not media scan");
            services.Repository.UpsertItems(job.Id,[new(){Key="telegram:channel_123:1",Platform="telegram",ContentId="1",ChatId="channel_123",MessageId="1",SourceUrl="",Title="synthetic stale row",Selected=true}]);
            Call(window,"Refresh");history.SelectedItem=history.Items.Cast<HistoryRow>().Single(r=>r.Job.Id==job.Id);Call(window,"OpenHistory");
            Require(!((Button)window.FindName("DownloadButton")).IsEnabled,"historical directory download remains disabled even with stale selected media");
            var beforeDownload=runner.Requests;Call(window,"Download_Click",null,new RoutedEventArgs());Wait(window.LastAction);Require(runner.Requests==beforeDownload,"directory download click starts no worker");
            Call(window,"Rescan_Click",null,new RoutedEventArgs());Wait(window.LastAction);Call(window,"RefreshCounts");
            Require(((Button)window.FindName("ChatScanButton")).IsEnabled,"historical directory can select freshly returned chat");
            Call(window,"ChatScan_Click",null,new RoutedEventArgs());Wait(window.LastAction);
            Require(runner.Captured.Last().Operation=="scan"&&runner.Captured.Last().Source.ChatId=="channel_123"&&runner.Captured.Last().Source.AccountId=="123","selection after directory rescan submits actual bound peer");
            services.Accounts.Clear();services.Accounts.Add(new(){Platform="telegram",AccountId="456"});Call(window,"RefreshCounts");Require(chats.Items.Count==0&&!((Button)window.FindName("ChatScanButton")).IsEnabled,"account switch clears rows and disables selection");
            Call(window,"Refresh");history.SelectedItem=history.Items.Cast<HistoryRow>().Single(r=>r.Job.Id==job.Id);var beforeChanged=runner.Requests;Call(window,"Rescan_Click",null,new RoutedEventArgs());Wait(window.LastAction);Require(runner.Requests==beforeChanged&&services.Repository.GetJob(job.Id)!.Source.AccountId=="123","historical account switch starts nothing and never rebinds history");
            Console.WriteLine($"PASS {checks} offline chat-directory WPF assertions");return 0;
        }
        catch(Exception e){Console.Error.WriteLine(e);return 1;}
        finally
        {
            services?.Hub.DisposeAsync().AsTask().GetAwaiter().GetResult();services?.Previews.DisposeAsync().AsTask().GetAwaiter().GetResult();services?.Dispose();app?.Shutdown();
            if(Path.GetDirectoryName(Path.GetFullPath(root))!=fixtureBase||!Guid.TryParseExact(Path.GetFileName(root),"N",out _))throw new IOException("Fixture boundary");
            for(var p=new DirectoryInfo(root);p!=null;p=p.Parent)if((p.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Fixture ancestor link");
            var pending=new Stack<string>();pending.Push(root);while(pending.TryPop(out var dir))foreach(var entry in Directory.EnumerateFileSystemEntries(dir)){var flags=File.GetAttributes(entry);if((flags&FileAttributes.ReparsePoint)!=0)throw new IOException("Fixture link");if((flags&FileAttributes.Directory)!=0)pending.Push(entry);}Directory.Delete(root,true);
        }
    }
}


