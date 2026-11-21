using System.Buffers.Binary;
namespace UnifiedMediaHub.Core;

// Authentication transport only. Never attach this object to repository or report models.
public sealed class LoginQrCode
{
 public string PngBase64 {get;set;}="";
 public long ExpiresAtUnix {get;set;}
 public byte[] DecodeValidated(DateTimeOffset now)
 {
  static InvalidDataException Invalid()=>new("Invalid login QR.");
  if(ExpiresAtUnix<=now.ToUnixTimeMilliseconds()/1000d||ExpiresAtUnix-now.ToUnixTimeMilliseconds()/1000d>600||PngBase64 is not {Length:>0 and <=43692}||PngBase64.Length%4!=0)throw Invalid();
  byte[] b;try{b=Convert.FromBase64String(PngBase64);}catch(FormatException){throw Invalid();}
  if(b.Length is <57 or >32768||Convert.ToBase64String(b)!=PngBase64||!b.AsSpan(0,8).SequenceEqual(new byte[]{137,80,78,71,13,10,26,10})||BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(8))!=13||!b.AsSpan(12,4).SequenceEqual("IHDR"u8))throw Invalid();
  var width=BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(16));var height=BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(20));
  if(width!=height||width is <128 or >512||b[24] is not (1 or 2 or 4 or 8 or 16)||b[25] is not (0 or 2 or 3 or 4 or 6)||b[26]!=0||b[27]!=0||b[28]>1)throw Invalid();
  var pos=8;bool data=false,end=false;
  while(pos+12<=b.Length){var n=BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(pos));if(n>b.Length-pos-12)throw Invalid();var type=b.AsSpan(pos+4,4);data|=type.SequenceEqual("IDAT"u8);pos+=(int)n+12;if(type.SequenceEqual("IEND"u8)){if(n!=0||pos!=b.Length)throw Invalid();end=true;break;}}
  if(!data||!end)throw Invalid();return b;
 }
}
