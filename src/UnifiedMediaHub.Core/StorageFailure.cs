using Microsoft.Data.Sqlite;
namespace UnifiedMediaHub.Core;
public static class StorageFailure
{
 public static void RequireMetadataSpace(string root){if(string.IsNullOrEmpty(root))return;var drive=new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root))!);if(drive.AvailableFreeSpace<64L*1024*1024)throw new IOException("disk_full",unchecked((int)0x80070070));}
 public static bool IsFull(Exception error)=>error is SqliteException {SqliteErrorCode:13} || error is IOException && ((error.HResult&0xffff) is 39 or 112) || error.InnerException!=null&&IsFull(error.InnerException);
}
