using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace UnifiedMediaHub.Core.Runtime;

// Internal pipe mode: no application settings/database/mutex/UI startup.
// The helper inherits the worker Job; the browser inherits it too. A nested
// kill-on-close Job lets this helper retire only its browser tree before verify.
public static class OrdinaryBrowserHost
{
    public static async Task<int> RunAsync()
    {
        if(!OperatingSystem.IsWindows())return 2;
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        using var job=new WorkerJob();
        try
        {
            var first=await Console.In.ReadLineAsync();
            if(first==null||first.Length>32768)return 2;
            var request=JsonSerializer.Deserialize<Launch>(first,new JsonSerializerOptions{PropertyNameCaseInsensitive=true});
            if(request==null||!Path.IsPathFullyQualified(request.Executable)||!File.Exists(request.Executable)||request.Args.Length>16||request.Args.Any(x=>x==null||x.Contains('\0')))return 2;
            var command=new StringBuilder(string.Join(" ",new[]{request.Executable}.Concat(request.Args).Select(Quote)));
            var startup=new StartupInfo{Size=Marshal.SizeOf<StartupInfo>()};
            // CREATE_SUSPENDED, no BREAKAWAY flag: cannot create children before
            // nested assignment, cannot escape the existing worker Job.
            if(!CreateProcessW(request.Executable,command,IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,Path.GetDirectoryName(request.Executable),ref startup,out var info))throw new Win32Exception(Marshal.GetLastWin32Error());
            using var process=new SafeProcessHandle(info.Process,true);using var thread=new SafeFileHandle(info.Thread,true);
            try{job.Assign(process);if(ResumeThread(thread)==uint.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error());}
            catch{TerminateProcess(process,1);throw;}
            await Emit(new{type="ready",pid=info.ProcessId});
            // Console's synchronized reader can block synchronously even for
            // ReadLineAsync. Never block process-exit/deadline observation on it.
            var read=Task.Run(Console.In.ReadLine);Stopwatch? closing=null;var forced=false;
            while(job.ActiveProcessIds().Length!=0)
            {
                if(read.IsCompleted)
                {
                    var commandLine=await read;
                    if(commandLine!="close"){forced=true;job.Terminate();break;}
                    if(closing==null){CloseWindows(job);closing=Stopwatch.StartNew();}
                    read=Task.Run(Console.In.ReadLine);
                }
                if(closing?.Elapsed>=TimeSpan.FromSeconds(10)){forced=true;job.Terminate();break;}
                await Task.Delay(25);
            }
            // Wait for all assigned children, not just the initial browser PID.
            var retirement=Stopwatch.StartNew();
            while(job.ActiveProcessIds().Length!=0){if(retirement.Elapsed>TimeSpan.FromSeconds(10))throw new IOException("Browser tree did not retire.");await Task.Delay(25);}
            await Emit(new{type="exited",forced});return 0;
        }
        catch(Exception error){await Emit(new{type="error",kind=error.GetType().Name,native=error is Win32Exception win?win.NativeErrorCode:0});return 1;} // No private values in diagnostics.
    }
    private static async Task Emit(object value){await Console.Out.WriteLineAsync(JsonSerializer.Serialize(value));await Console.Out.FlushAsync();}
    private static string Quote(string value)
    {
        var output=new StringBuilder("\"");var slashes=0;
        foreach(var c in value){if(c=='\\'){slashes++;continue;}output.Append('\\',c=='"'?slashes*2+1:slashes);output.Append(c);slashes=0;}
        output.Append('\\',slashes*2);return output.Append('"').ToString();
    }
    private static void CloseWindows(WorkerJob job)
    {
        EnumWindows((window,_)=>{GetWindowThreadProcessId(window,out var pid);if(pid<=int.MaxValue&&job.OwnsProcessId((int)pid))PostMessageW(window,0x0010,IntPtr.Zero,IntPtr.Zero);return true;},IntPtr.Zero);
    }
    private sealed record Launch(string Executable,string[] Args);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]private struct StartupInfo
    {
        public int Size;public string? Reserved,Desktop,Title;public int X,Y,XSize,YSize,XCountChars,YCountChars,FillAttribute,Flags;public short ShowWindow,Reserved2Size;public IntPtr Reserved2,StdInput,StdOutput,StdError;
    }
    [StructLayout(LayoutKind.Sequential)]private struct ProcessInfo{public IntPtr Process,Thread;public uint ProcessId,ThreadId;}
    private delegate bool WindowCallback(IntPtr window,IntPtr data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,[MarshalAs(UnmanagedType.Bool)]bool inherit,uint flags,IntPtr environment,string? directory,ref StartupInfo startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern uint ResumeThread(SafeFileHandle thread);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool TerminateProcess(SafeProcessHandle process,uint code);
    [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)]private static extern bool EnumWindows(WindowCallback callback,IntPtr data);
    [DllImport("user32.dll")]private static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]private static extern bool PostMessageW(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
}
