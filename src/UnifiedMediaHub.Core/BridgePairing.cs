using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
namespace UnifiedMediaHub.Core;

public sealed class BridgePairing
{
 readonly object gate=new();string token;
 public string FilePath {get;}
 public string Token {get{lock(gate)return token;}}
 public BridgePairing(string dataRoot){var dir=Path.Combine(dataRoot,"private");PrivateStorage.SecureDirectory(dir);FilePath=Path.Combine(dir,"bridge-pairing.dpapi");if(File.Exists(FilePath)){if((File.GetAttributes(FilePath)&FileAttributes.ReparsePoint)!=0||new FileInfo(FilePath).Length>4096)throw new IOException("Invalid pairing storage.");var bytes=Transform(File.ReadAllBytes(FilePath),false);try{if(bytes.Length!=32)throw new IOException("Invalid pairing storage.");token=Encode(bytes);}finally{CryptographicOperations.ZeroMemory(bytes);}}else{token="";Regenerate();}}
 static string Encode(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
 public bool Matches(string? provided){lock(gate){var left=SHA256.HashData(Encoding.UTF8.GetBytes(provided??""));var right=SHA256.HashData(Encoding.UTF8.GetBytes(token));return CryptographicOperations.FixedTimeEquals(left,right);}}
 public void Regenerate(){lock(gate){var bytes=RandomNumberGenerator.GetBytes(32);try{var protectedBytes=Transform(bytes,true);var temp=FilePath+"."+Guid.NewGuid().ToString("N")+".tmp";try{using(var f=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.Write(protectedBytes);f.Flush(true);}if(File.Exists(FilePath)&&(File.GetAttributes(FilePath)&FileAttributes.ReparsePoint)!=0)throw new IOException("Unsafe pairing file.");File.Move(temp,FilePath,true);token=Encode(bytes);}finally{if(File.Exists(temp))File.Delete(temp);}}finally{CryptographicOperations.ZeroMemory(bytes);}}}
 [StructLayout(LayoutKind.Sequential)]struct Blob{public int Length;public IntPtr Data;}
 [DllImport("crypt32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CryptProtectData(ref Blob input,string description,IntPtr entropy,IntPtr reserved,IntPtr prompt,uint flags,out Blob output);
 [DllImport("crypt32.dll",SetLastError=true)]static extern bool CryptUnprotectData(ref Blob input,IntPtr description,IntPtr entropy,IntPtr reserved,IntPtr prompt,uint flags,out Blob output);
 [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr memory);
 static byte[] Transform(byte[] bytes,bool protect){if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException();var input=new Blob{Length=bytes.Length,Data=Marshal.AllocHGlobal(bytes.Length)};Blob output=default;try{Marshal.Copy(bytes,0,input.Data,bytes.Length);var ok=protect?CryptProtectData(ref input,"UnifiedMediaHub bridge",IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,out output):CryptUnprotectData(ref input,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,out output);if(!ok)throw new CryptographicException("Pairing protection failed.");if(output.Length<1||output.Length>4096)throw new CryptographicException("Invalid pairing storage.");var result=new byte[output.Length];Marshal.Copy(output.Data,result,0,result.Length);return result;}finally{for(var i=0;i<input.Length;i++)Marshal.WriteByte(input.Data,i,0);Marshal.FreeHGlobal(input.Data);if(output.Data!=IntPtr.Zero){for(var i=0;i<output.Length;i++)Marshal.WriteByte(output.Data,i,0);LocalFree(output.Data);}}}
}
