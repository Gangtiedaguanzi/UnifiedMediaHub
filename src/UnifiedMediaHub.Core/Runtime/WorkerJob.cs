using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace UnifiedMediaHub.Core.Runtime;

internal sealed class WorkerJob : IDisposable
{
    private readonly SafeFileHandle handle;
    public WorkerJob()
    {
        handle = CreateJobObjectW(IntPtr.Zero, null);
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create worker Job."); }
        var limits = new ExtendedLimitInformation { BasicLimitInformation = new BasicLimitInformation { LimitFlags = 0x2000 } };
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimitInformation>()))
        {
            var code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code, "Could not configure worker Job.");
        }
    }
    public void Assign(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.SafeHandle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not assign worker to its Job.");
    }
    internal void Assign(SafeProcessHandle process)
    {
        if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    internal void Terminate()
    {
        if (!TerminateJobObject(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    internal int[] ActiveProcessIds()
    {
        var capacity=32;
        for(var attempt=0;attempt<3;attempt++)
        {
            var list=ReadProcessList(capacity);
            if(list.Success&&list.Assigned==list.Pids.Length)return list.Pids;
            if(list.Assigned<0||list.Assigned>512)break;
            capacity=Math.Min(512,Math.Max(capacity*2,list.Assigned));
        }
        throw new IOException("Could not enumerate owned browser Job.");
    }
    internal bool OwnsProcessId(int pid)
    {
        using var process=OpenProcess(0x1000,false,pid);
        return !process.IsInvalid&&IsProcessInJob(process,handle,out var belongs)&&belongs;
    }
    public void Dispose() => handle.Dispose();

    internal ResourceSample Sample()
    {
        return Collect(ReadProcessList, ReadProcessMemory);
    }

    // A changing Job can outgrow the buffer; bound both growth and total PID work.
    internal static ResourceSample Collect(Func<int, (bool Success, int Assigned, int[] Pids)> enumerate,
        Func<int, (long Commit, long WorkingSet)?> memory)
    {
        var capacity = 32;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var list = enumerate(capacity);
            if (list.Assigned > 512 || list.Assigned < 0 || list.Pids.Length > capacity) return default;
            if (!list.Success || list.Assigned > list.Pids.Length)
            {
                if (list.Assigned <= capacity || attempt == 2) return default;
                capacity = Math.Min(512, Math.Max(capacity * 2, list.Assigned));
                continue;
            }
            long commit = 0, workingSet = 0;
            foreach (var pid in list.Pids)
            {
                var value = memory(pid);
                if (value == null || value.Value.Commit < 0 || value.Value.WorkingSet < 0) return default;
                try { commit = checked(commit + value.Value.Commit); workingSet = checked(workingSet + value.Value.WorkingSet); }
                catch (OverflowException) { return default; }
            }
            return new(true, list.Pids.Length, commit, workingSet);
        }
        return default;
    }

    private (bool Success, int Assigned, int[] Pids) ReadProcessList(int capacity)
    {
        var bytes = 8 + capacity * IntPtr.Size;
        var buffer = Marshal.AllocHGlobal(bytes);
        try
        {
            Marshal.WriteInt32(buffer, 0, 0); Marshal.WriteInt32(buffer, 4, 0);
            var success = QueryInformationJobObject(handle, 3, buffer, (uint)bytes, out _);
            var error = success ? 0 : Marshal.GetLastWin32Error();
            if (!success && error != 234) return (false, 0, []); // ERROR_MORE_DATA
            var assigned = Marshal.ReadInt32(buffer, 0); var count = Marshal.ReadInt32(buffer, 4);
            if (count < 0 || count > capacity) return (false, 0, []);
            var pids = new int[count];
            for (var i = 0; i < count; i++)
            {
                var pid = Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
                if (pid <= 0 || pid > int.MaxValue) return (false, 0, []);
                pids[i] = (int)pid;
            }
            return (success, assigned, pids);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal (long Commit, long WorkingSet)? ReadProcessMemory(int pid)
    {
        using var process = OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION
        if (process.IsInvalid || !IsProcessInJob(process, handle, out var belongs) || !belongs) return null;
        // Membership and memory use the same handle, preventing PID reuse from adding an unrelated process.
        var info = new ProcessMemoryCounters { Size = (uint)Marshal.SizeOf<ProcessMemoryCounters>() };
        if (!K32GetProcessMemoryInfo(process, ref info, info.Size) || info.PrivateUsage > long.MaxValue || info.WorkingSet > long.MaxValue) return null;
        return ((long)info.PrivateUsage, (long)info.WorkingSet);
    }

    [StructLayout(LayoutKind.Sequential)] private struct ProcessMemoryCounters
    {
        public uint Size, PageFaultCount;
        public nuint PeakWorkingSet, WorkingSet, QuotaPeakPagedPool, QuotaPagedPool, QuotaPeakNonPagedPool, QuotaNonPagedPool, PagefileUsage, PeakPagefileUsage, PrivateUsage;
    }
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int infoClass, IntPtr info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsProcessInJob(SafeProcessHandle process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool belongs);
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool K32GetProcessMemoryInfo(SafeProcessHandle process, ref ProcessMemoryCounters counters, uint size);

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimitInformation info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeProcessHandle process);
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
}
