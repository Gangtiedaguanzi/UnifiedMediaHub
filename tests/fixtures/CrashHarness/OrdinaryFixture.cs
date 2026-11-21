using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

// Synthetic executable only. Hidden native window, no Chromium or sockets.
internal static class OrdinaryFixture
{
    private static readonly WindowProc Callback=Handle;
    private static string root="",mode="";
    public static int Run(string[] args)
    {
        if(args[0]=="--ordinary-leaf")
        {
            File.WriteAllText(Path.Combine(args[1],"leaf.pid"),Environment.ProcessId.ToString());
            Thread.Sleep(Timeout.Infinite);return 0;
        }
        root=args[0]["--user-data-dir=".Length..];Directory.CreateDirectory(root);
        mode=File.ReadAllText(Path.Combine(root,"mode.txt"));
        File.WriteAllText(Path.Combine(root,"args.json"),JsonSerializer.Serialize(args));
        File.WriteAllText(Path.Combine(root,"browser.pid"),Environment.ProcessId.ToString());
        var child=new ProcessStartInfo(Environment.ProcessPath!){UseShellExecute=false,CreateNoWindow=true};child.ArgumentList.Add("--ordinary-leaf");child.ArgumentList.Add(root);using var leaf=Process.Start(child)!;
        var type=new WindowClass{Proc=Callback,Name="UMHFixture"};RegisterClassW(ref type);
        var window=CreateWindowExW(0,type.Name,"Synthetic ordinary login",0,0,0,100,100,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
        if(window==IntPtr.Zero)return 2;
        SetTimer(window,1,50,IntPtr.Zero);File.WriteAllText(Path.Combine(root,"window.ready"),"synthetic");
        while(GetMessageW(out var message,IntPtr.Zero,0,0)>0){TranslateMessage(ref message);DispatchMessageW(ref message);}
        if(!leaf.HasExited)leaf.Kill();leaf.WaitForExit();File.WriteAllText(Path.Combine(root,"graceful.exit"),"cookies-flush-fixture");return 0;
    }
    private static IntPtr Handle(IntPtr window,uint message,IntPtr wParam,IntPtr lParam)
    {
        if(message==0x10){File.AppendAllText(Path.Combine(root,"wm-close.txt"),"WM_CLOSE\n");if(mode!="ignore")DestroyWindow(window);return IntPtr.Zero;}
        if(message==0x113&&File.Exists(Path.Combine(root,"self-close")))DestroyWindow(window);
        if(message==2){PostQuitMessage(0);return IntPtr.Zero;}
        return DefWindowProcW(window,message,wParam,lParam);
    }
    private delegate IntPtr WindowProc(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]private struct WindowClass{public uint Style;public WindowProc Proc;public int ClassExtra,WindowExtra;public IntPtr Instance,Icon,Cursor,Background;public string? Menu;public string Name;}
    [StructLayout(LayoutKind.Sequential)]private struct Message{public IntPtr Window;public uint Id;public IntPtr WParam,LParam;public uint Time;public int X,Y;public uint Private;}
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]private static extern ushort RegisterClassW(ref WindowClass value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]private static extern IntPtr CreateWindowExW(uint ex,string type,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
    [DllImport("user32.dll")]private static extern nuint SetTimer(IntPtr window,nuint id,uint milliseconds,IntPtr callback);
    [DllImport("user32.dll")]private static extern int GetMessageW(out Message message,IntPtr window,uint min,uint max);
    [DllImport("user32.dll")]private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")]private static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")]private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")]private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")]private static extern IntPtr DefWindowProcW(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
}
