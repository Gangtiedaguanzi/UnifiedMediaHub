using System.Security.Cryptography;using System.Text;using UnifiedMediaHub.Core;using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class StartupInstanceTests{
 [Fact]public void PublishedLegacyLeaseAlsoBlocksNewStartup(){var root=Path.Combine(Path.GetTempPath(),"umh-legacy-"+Guid.NewGuid().ToString("N"));var normalized=Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)).ToUpperInvariant();var hash=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Environment.UserDomainName+"\\"+Environment.UserName+"|"+normalized)));using var legacy=new Mutex(false,"Local\\UnifiedMediaHub-"+hash);Assert.Null(DataRootLease.TryAcquire(root));}
 [Fact]public void InstalledExecutableAndShortcutDefaultToSameDataRoot(){var install=Path.Combine(Path.GetTempPath(),"umh-install");Assert.Equal(Path.Combine(install,"data"),StartupPaths.DefaultDataRoot(Path.Combine(install,"releases","0.1.0-preview.30")));Assert.Equal(Path.Combine(install,"portable","data"),StartupPaths.DefaultDataRoot(Path.Combine(install,"portable")));}
 [Fact]public void FailedDuplicateAcquisitionIsNonThrowingAndOtherRootsRemainIndependent(){var root=Path.Combine(Path.GetTempPath(),"umh-lease-"+Guid.NewGuid().ToString("N"));using var first=DataRootLease.TryAcquire(root);Assert.NotNull(first);Assert.Null(DataRootLease.TryAcquire(root));using var other=DataRootLease.TryAcquire(Path.Combine(root,"other"));Assert.NotNull(other);first.Dispose();first.Dispose();using var next=DataRootLease.TryAcquire(root);Assert.NotNull(next);}
 [Fact]public void SpecGlobalMutexBlocksSameNormalizedRootBeforeStorage(){
  var root=Path.Combine(Path.GetTempPath(),"umh-startup-"+Guid.NewGuid().ToString("N"));var normalized=Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)).ToUpperInvariant();
  var name="Global\\UnifiedMediaHub-"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))[..16];
  using var first=new Mutex(false,name);Assert.Throws<InvalidOperationException>(()=>DataRootLease.Acquire(Path.Combine(root,".")));Assert.False(Directory.Exists(root));
 }
}
