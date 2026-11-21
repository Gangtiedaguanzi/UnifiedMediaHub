using System.Security.AccessControl;
using System.Security.Principal;
using UnifiedMediaHub.Core;
using Xunit;

namespace UnifiedMediaHub.Tests;

public sealed class HostSecurityTests : IDisposable
{
    readonly string root=Path.Combine(Path.GetTempPath(),"UMH-security",Guid.NewGuid().ToString("N"));
    public HostSecurityTests()=>Directory.CreateDirectory(root);
    public void Dispose()=>Directory.Delete(root,true);
    [Fact]
    public void PrivateAclWorksForCurrentNonAdminOwnerWithoutOwnerRewrite()
    {
        if(!OperatingSystem.IsWindows()) return;
        var path=Path.Combine(root,"private"); PrivateStorage.SecureDirectory(path);
        var acl=new DirectoryInfo(path).GetAccessControl();
        Assert.True(acl.AreAccessRulesProtected); Assert.Equal(WindowsIdentity.GetCurrent().User,acl.GetOwner(typeof(SecurityIdentifier)));
        var rules=acl.GetAccessRules(true,true,typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToList();
        Assert.Equal(3,rules.Count); foreach(var r in rules) { Assert.False(r.IsInherited); Assert.Equal(AccessControlType.Allow,r.AccessControlType); }
        using var repo=new HubRepository(Path.Combine(path,"hub.db")); repo.Initialize(); repo.CreateJob(new(){Url="https://www.xiaohongshu.com/explore/id?xsec_token=private"},root);
        PrivateStorage.SecureDirectory(path);
    }
    [Fact]
    public void SameNormalizedDataRootHasExclusiveOwnershipButOtherRootsWork()
    {
        using var first=DataRootLease.Acquire(root);
        Assert.Throws<InvalidOperationException>(()=>DataRootLease.Acquire(Path.Combine(root,".")));
        using var other=DataRootLease.Acquire(Path.Combine(root,"another"));
    }
    [Fact]
    public void AuthorActionRejectsForeignOrSingleUrls()
    {
        Assert.False(AuthorSources.TryGet(new(){Platform="x",AuthorUrl="https://evil.test/alice"},out _));
        Assert.False(AuthorSources.TryGet(new(){Platform="x",AuthorUrl="https://x.com/alice/status/123"},out _));
        Assert.False(AuthorSources.TryGet(new(){Platform="x",AuthorUrl="https://www.douyin.com/user/alice"},out _));
        Assert.True(AuthorSources.TryGet(new(){Platform="x",Author="Nickname",AuthorUrl="https://x.com/actual"},out var source)); Assert.Null(source!.AccountId);
    }
}
