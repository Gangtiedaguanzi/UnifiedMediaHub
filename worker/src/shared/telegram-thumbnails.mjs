// Small port of gotd/td v0.140.0 telegram/thumbnail/thumbnail.go (MIT,
// Copyright 2020 Aleksandr Razumov), itself based on tdesktop v2.7.5 image.cpp.
// See THIRD-PARTY-ENGINE-NOTICES.txt for provenance and the full MIT notice.
import path from 'node:path';
import { isolatedProcess } from './engines.mjs';
import { STRIPPED_HEADER } from './telegram-jpeg-header.mjs';
const MAX=24*1024;
function base64(s){
  if(typeof s!=='string'||s.length>Math.ceil(MAX/3)*4||s.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return null;
  const b=Buffer.from(s,'base64');return b.length && b.length<=MAX && b.toString('base64')===s?b:null;
}
function dimensions(b,mime){
  if(mime==='image/png') return b.length>=33 && b.toString('ascii',12,16)==='IHDR' ? [b.readUInt32BE(16),b.readUInt32BE(20)] : null;
  for(let i=2;i+8<b.length;){
    if(b[i++]!==255) return null; const marker=b[i++];
    if(marker===0xda || marker===0xd9) break;
    const length=b.readUInt16BE(i); if(length<2 || i+length>b.length) return null;
    if([0xc0,0xc1,0xc2].includes(marker)) return [b.readUInt16BE(i+5),b.readUInt16BE(i+3)];
    i+=length;
  }
  return null;
}
function raster(b){
  const mime=b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':b[0]===255 && b[1]===216 && b.at(-2)===255 && b.at(-1)===217?'image/jpeg':null;
  if(!mime || b.length>MAX) return null;
  const size=dimensions(b,mime);
  return size && size.every(x=>x>0 && x<=1024)?{bytes:b,mime}:null;
}
export function thumbnailCandidate(raw){
  const sizes=raw?.Media?.Photo?.Sizes ?? raw?.Media?.Document?.Thumbs;
  if(!Array.isArray(sizes)) return null;
  const candidates=sizes.slice(0,16);
  for(const s of candidates){if(s.Type==='i'||s.Type==='j')continue;const b=base64(s.Bytes);const cached=b&&raster(b);if(cached)return cached;}
  for(const s of candidates){
    if(s.Type!=='i')continue;
    const b=base64(s.Bytes);
    if(!b || b.length<4 || b[0]!==1 || !b[1] || !b[2] || 623+b.length-1>MAX)continue;
    const header=Buffer.from(STRIPPED_HEADER,'base64');header[164]=b[1];header[166]=b[2];
    const candidate=raster(Buffer.concat([header,b.subarray(3),Buffer.from([255,217])]));
    if(candidate)return candidate;
  }
  return null;
}
// WPF's native decoder validates bounded candidate bytes before they enter a card.
// stdin carries image bytes; no payload appears in command lines or diagnostics.
// Decoder is one finite owned process per exported batch, with no network or file writes.
export async function decodeThumbnails(candidates,{root,signal}){
  if(!candidates.some(Boolean))return candidates.map(()=>null);
  const results=[];
  const script='$ErrorActionPreference="Stop"; Add-Type -AssemblyName PresentationCore; [Console]::Out.WriteLine("ready"); while(($s=[Console]::In.ReadLine()) -ne "end"){ if($null -eq $s){break}; $ok=$false; $m=$null; try { $b=[Convert]::FromBase64String($s); if($b.Length -gt 24576){throw "size"}; $m=[IO.MemoryStream]::new($b,$false); $d=[Windows.Media.Imaging.BitmapDecoder]::Create($m,[Windows.Media.Imaging.BitmapCreateOptions]::None,[Windows.Media.Imaging.BitmapCacheOption]::OnLoad); $f=$d.Frames[0]; if($f.PixelWidth -gt 0 -and $f.PixelWidth -le 1024 -and $f.PixelHeight -gt 0 -and $f.PixelHeight -le 1024){$p=New-Object byte[] ($f.PixelHeight*$f.PixelWidth*4); $f.CopyPixels($p,$f.PixelWidth*4,0); $ok=$true} } catch {} finally {if($m){$m.Dispose()}}; [Console]::Out.WriteLine($(if($ok){"true"}else{"false"})) }';
  const executable=process.platform==='win32'?path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe';
  try{
    await isolatedProcess({executable,args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],root,signal,timeoutMs:60000,maxOutput:65536,onLine:async(line,write)=>{
      if(line==='ready'){
        for(const c of candidates)await write((c?.bytes.toString('base64')??'')+'\n');
        await write('end\n');
      }else if(line==='true'||line==='false')results.push(line==='true');
      else throw new Error('invalid_decoder_output');
    }});
    if(results.length!==candidates.length)return candidates.map(()=>null);
    return candidates.map((c,i)=>c&&results[i]?`data:${c.mime};base64,${c.bytes.toString('base64')}`:null);
  }catch(e){if(signal?.aborted)throw e;return candidates.map(()=>null);}
}
