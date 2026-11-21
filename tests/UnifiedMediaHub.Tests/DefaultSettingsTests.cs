using UnifiedMediaHub.Core;using Xunit;
namespace UnifiedMediaHub.Tests;
// A fresh install on another computer had a default save folder on a drive letter
// that computer may not have, so every first download stopped as "location unavailable".
public sealed class DefaultSettingsTests
{
 [Fact]public void DefaultDownloadRootIsOnTheCurrentUsersProfileDrive()
 {
  var profile=Path.TrimEndingDirectorySeparator(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
  var root=new HubSettings().DownloadRoot;
  Assert.True(Path.IsPathFullyQualified(root));
  Assert.StartsWith(profile+Path.DirectorySeparatorChar,root,StringComparison.OrdinalIgnoreCase);
  Assert.True(Directory.Exists(Path.GetPathRoot(root)));
 }
 [Fact]public void SavedDownloadRootStillWinsOverTheDefault()
 {
  var saved=System.Text.Json.JsonSerializer.Deserialize<HubSettings>("""{"DownloadRoot":"Q:\\Saved"}""")!;
  Assert.Equal(@"Q:\Saved",saved.DownloadRoot);
 }
}
