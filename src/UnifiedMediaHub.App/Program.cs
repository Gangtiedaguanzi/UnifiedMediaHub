using System.IO;
using System.Windows;
using UnifiedMediaHub.Core;

namespace UnifiedMediaHub.App;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if(args is ["--ordinary-browser-host"])return UnifiedMediaHub.Core.Runtime.OrdinaryBrowserHost.RunAsync().GetAwaiter().GetResult();
        string? smoke=null; string dataRoot=StartupPaths.DefaultDataRoot(AppContext.BaseDirectory);
        for(var i=0;i<args.Length;i++)
        {
            if(args[i]=="--smoke-test" && i+1<args.Length) smoke=Path.GetFullPath(args[++i]);
            else if(args[i]=="--data-root" && i+1<args.Length) dataRoot=Path.GetFullPath(args[++i]);
            else {MessageBox.Show("启动参数无效。","统一媒体管理器");return 2;}
        }
        if(smoke!=null)dataRoot=Path.Combine(smoke,"fixture-data");
        try
        {
            using var startupLease=DataRootLease.TryAcquire(dataRoot);
            if(startupLease==null){InstanceActivation.Activate(dataRoot);return 0;}
            using var services=new AppServices(dataRoot,smoke,startupLease);
            var app=new Application {ShutdownMode=ShutdownMode.OnMainWindowClose};
            var window=new MainWindow(services);
            InstanceActivation.Register(window,dataRoot);
            if(smoke!=null)window.Loaded+=async(_,_)=>await SmokeHarness.RunAsync(window,services,smoke);
            var result=app.Run(window);return SmokeHarness.Failed?1:result;
        }
        catch(Exception error)
        {
            if(smoke!=null){Directory.CreateDirectory(smoke);File.WriteAllText(Path.Combine(smoke,"startup-failure.txt"),error.ToString());}
            else MessageBox.Show(error is InvalidOperationException?error.Message:"无法打开程序数据目录。请检查目录权限，并确认该目录属于当前用户。","统一媒体管理器",MessageBoxButton.OK,MessageBoxImage.Warning);
            return 1;
        }
    }
}
