namespace UnifiedMediaHub.Core;
public static class StartupPaths
{
    public static string DefaultDataRoot(string appBase)
    {
        var directory=new DirectoryInfo(Path.GetFullPath(appBase));
        // Launching an installed exe directly uses the same root as its shortcut.
        return Path.Combine(directory.Parent is {Name:var name,Parent:{} install}&&name.Equals("releases",StringComparison.OrdinalIgnoreCase)?install.FullName:directory.FullName,"data");
    }
}
