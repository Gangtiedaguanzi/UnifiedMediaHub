using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
namespace UnifiedMediaHub.Core;

public static class PrivateStorage
{
    public static void RejectLinks(string path)
    {
        for(var current=new DirectoryInfo(Path.GetFullPath(path));current!=null;current=current.Parent)
            if(current.Exists && (current.Attributes&FileAttributes.ReparsePoint)!=0) throw new IOException("程序数据目录不能使用链接或重定向目录。");
    }
    public static void SecureDirectory(string path)
    {
        if(!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        RejectLinks(path); var directory=Directory.CreateDirectory(path); RejectLinks(path);
        using var identity=WindowsIdentity.GetCurrent(); var sid=identity.User??throw new UnauthorizedAccessException();
        var before=directory.GetAccessControl();
        if(!sid.Equals(before.GetOwner(typeof(SecurityIdentifier)))) throw new UnauthorizedAccessException("私有目录所有者与当前用户不一致。");
        var allowed=new[]{sid,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null)};
        var acl=new DirectorySecurity(); acl.SetAccessRuleProtection(true,false);
        foreach(var principal in allowed) acl.AddAccessRule(new FileSystemAccessRule(principal,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        // The verified owner is already correct. Redundant SetOwner requires rights a non-admin may not have.
        directory.SetAccessControl(acl);
        var verified=directory.GetAccessControl();
        if(!verified.AreAccessRulesProtected || !sid.Equals(verified.GetOwner(typeof(SecurityIdentifier)))) throw new UnauthorizedAccessException("无法保护程序私有目录。");
        var rules=verified.GetAccessRules(true,true,typeof(SecurityIdentifier));
        if(rules.Count!=3) throw new UnauthorizedAccessException("私有目录访问规则异常。");
        foreach(FileSystemAccessRule rule in rules)
            if(rule.IsInherited || rule.AccessControlType!=AccessControlType.Allow || rule.FileSystemRights!=FileSystemRights.FullControl || rule.InheritanceFlags!=(InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit) || rule.PropagationFlags!=PropagationFlags.None || !allowed.Contains(rule.IdentityReference)) throw new UnauthorizedAccessException("私有目录访问规则异常。");
    }
}
public sealed class DataRootLease : IDisposable
{
    Mutex? mutex,legacyMutex;
    public string Name {get;}
    DataRootLease(Mutex mutex,Mutex legacyMutex,string name){this.mutex=mutex;this.legacyMutex=legacyMutex;Name=name;}
    public static string NameFor(string path)
    {
        var normalized=Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)).ToUpperInvariant();
        return "Global\\UnifiedMediaHub-"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))[..16];
    }
    public bool Matches(string path)=>mutex!=null&&Name==NameFor(path);
    public static DataRootLease? TryAcquire(string path)
    {
        var name=NameFor(path);var handle=new Mutex(false,name,out var created);
        if(!created){handle.Dispose();return null;}
        // Retain the published lease name too, so preview29 and older builds
        // cannot open the same root while a new-version instance is running.
        try{
            var normalized=Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)).ToUpperInvariant();
            var legacyKey=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Environment.UserDomainName+"\\"+Environment.UserName+"|"+normalized)));
            var legacy=new Mutex(false,"Local\\UnifiedMediaHub-"+legacyKey,out var legacyCreated);
            if(!legacyCreated){legacy.Dispose();handle.Dispose();return null;}
            return new(handle,legacy,name);
        }catch{handle.Dispose();throw;}
    }
    public static DataRootLease Acquire(string path)
    {
        return TryAcquire(path)??throw new InvalidOperationException("此数据目录的统一媒体管理器已经运行，请切换到已有窗口。");
    }
    public void Dispose(){Interlocked.Exchange(ref legacyMutex,null)?.Dispose();Interlocked.Exchange(ref mutex,null)?.Dispose();}
}
