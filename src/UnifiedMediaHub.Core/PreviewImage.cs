using System.Buffers.Binary;
namespace UnifiedMediaHub.Core;

public static class PreviewImage
{
    // Read encoded dimensions before asking a raster decoder to materialize any pixels.
    public static bool HasSafeDimensions(ReadOnlySpan<byte> bytes)=>TryGetDimensions(bytes,out _,out _);
    public static bool TryGetDimensions(ReadOnlySpan<byte> bytes,out int width,out int height)
    {
        width=0;height=0;
        if(bytes.Length>=24 && bytes[..8].SequenceEqual(new byte[]{137,80,78,71,13,10,26,10}))
        { width=BinaryPrimitives.ReadInt32BigEndian(bytes[16..20]); height=BinaryPrimitives.ReadInt32BigEndian(bytes[20..24]); }
        else if(bytes.Length>=10 && (bytes[..6].SequenceEqual("GIF87a"u8) || bytes[..6].SequenceEqual("GIF89a"u8)))
        {
            width=BinaryPrimitives.ReadUInt16LittleEndian(bytes[6..8]); height=BinaryPrimitives.ReadUInt16LittleEndian(bytes[8..10]);
            if(bytes.Length<13)return false;var offset=13+((bytes[10]&128)!=0?3*(1<<((bytes[10]&7)+1)):0);var frame=false;
            while(offset<bytes.Length)
            {
                var marker=bytes[offset++];
                if(marker==0x2C)
                {
                    if(offset+9>bytes.Length)return false;
                    var left=BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(offset,2));var top=BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(offset+2,2));
                    var fw=BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(offset+4,2));var fh=BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(offset+6,2));
                    if(fw<1 || fh<1 || left+fw>width || top+fh>height)return false;frame=true;break;
                }
                if(marker!=0x21 || ++offset>=bytes.Length)return false;
                while(offset<bytes.Length){var count=bytes[offset++];if(count==0)break;offset+=count;}
            }
            if(!frame)return false;
        }
        else if(bytes.Length>=30 && bytes[..4].SequenceEqual("RIFF"u8) && bytes[8..12].SequenceEqual("WEBP"u8))
        {
            if(bytes[12..16].SequenceEqual("VP8 "u8) && bytes[23..26].SequenceEqual(new byte[]{157,1,42}))
            {width=BinaryPrimitives.ReadUInt16LittleEndian(bytes[26..28])&0x3FFF;height=BinaryPrimitives.ReadUInt16LittleEndian(bytes[28..30])&0x3FFF;}
            else if(bytes[12..16].SequenceEqual("VP8L"u8) && bytes[20]==0x2F)
            {var bits=BinaryPrimitives.ReadUInt32LittleEndian(bytes[21..25]);width=(int)(bits&0x3FFF)+1;height=(int)((bits>>14)&0x3FFF)+1;}
            else if(bytes[12..16].SequenceEqual("VP8X"u8))
            {width=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16);height=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16);}
        }
        else if(bytes.Length>4 && bytes[0]==255 && bytes[1]==216)
        {
            for(var offset=2;offset+4<bytes.Length;)
            {
                if(bytes[offset++]!=255) return false;
                while(offset<bytes.Length && bytes[offset]==255) offset++;
                if(offset>=bytes.Length) return false; var marker=bytes[offset++];
                if(marker is 0xD8 or 0x01 || marker is >=0xD0 and <=0xD7) continue;
                if(marker is 0xDA or 0xD9 || offset+2>bytes.Length) return false;
                var length=BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(offset,2));
                if(length<2 || offset+length>bytes.Length) return false;
                if(marker is 0xC0 or 0xC1 or 0xC2)
                { if(length<8) return false; height=BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(offset+3,2)); width=BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(offset+5,2)); break; }
                offset+=length;
            }
        }
        return width>0 && height>0 && width<=8192 && height<=8192 && (long)width*height<=16_000_000;
    }
}
