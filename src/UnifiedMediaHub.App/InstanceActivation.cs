using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using UnifiedMediaHub.Core;
namespace UnifiedMediaHub.App;
internal static class InstanceActivation
{
    static string Key(string root)=>"UMH-Instance-"+DataRootLease.NameFor(root)[^16..];
    public static void Register(Window window,string root)
    {
        var key=Key(root);window.SourceInitialized+=(_,_)=>SetProp(new WindowInteropHelper(window).Handle,key,new IntPtr(1));
        window.Closed+=(_,_)=>RemoveProp(new WindowInteropHelper(window).Handle,key);
    }
    public static bool Activate(string root)
    {
        var key=Key(root);IntPtr found=IntPtr.Zero;
        for(var attempt=0;attempt<10&&found==IntPtr.Zero;attempt++)
        {
            EnumWindows((window,_)=>{if(GetProp(window,key)==IntPtr.Zero)return true;found=window;return false;},IntPtr.Zero);
            if(found==IntPtr.Zero)Thread.Sleep(50);
        }
        if(found==IntPtr.Zero)return false;
        ShowWindowAsync(found,9);return SetForegroundWindow(found);
    }
    delegate bool WindowVisitor(IntPtr window,IntPtr parameter);
    [DllImport("user32.dll")]static extern bool EnumWindows(WindowVisitor visitor,IntPtr parameter);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool SetProp(IntPtr window,string name,IntPtr value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetProp(IntPtr window,string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr RemoveProp(IntPtr window,string name);
    [DllImport("user32.dll")]static extern bool ShowWindowAsync(IntPtr window,int command);
    [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
}
