using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
namespace UnifiedMediaHub.Core;

public sealed class PreviewCache : IAsyncDisposable
{
    readonly string root;
    readonly long limit;
    readonly HttpClient client;
    readonly SemaphoreSlim slots=new(2,2);
    readonly object gate=new(), disk=new();
    readonly Dictionary<long,Work> works=[];
    readonly HashSet<string> stoppedPlatforms=[];
    bool enabled,disposed; long sequence;
    public int ActiveCount {get{lock(gate)return works.Count;}}
    public long CachedBytes {get{lock(disk)return Files().Sum(f=>f.Length);}}
    public PreviewCache(string root,HttpMessageHandler? handler=null,long limit=128*1024*1024)
    {
        this.root=Path.GetFullPath(root); this.limit=limit; PrivateStorage.RejectLinks(root); Directory.CreateDirectory(root);
        client=new HttpClient(handler??CreateHandler(),true){Timeout=TimeSpan.FromSeconds(20)};
        lock(disk) Evict(0);
    }
    public void Enable() {lock(gate){ObjectDisposedException.ThrowIf(disposed,this); enabled=true; stoppedPlatforms.Clear();}}
    public void EnablePlatform(string platform) {lock(gate){if(enabled) stoppedPlatforms.Remove(platform);}}
    public Task<string?> LoadAsync(string platform,string? url,CancellationToken ct=default)
    {
        if(string.IsNullOrEmpty(url) || url.Length>36000) return Task.FromResult<string?>(null);
        var path=Path.Combine(root,Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(platform+"|"+url)))+".thumb");
        lock(disk)
        {
            if(File.Exists(path))
            {
                if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0) return Task.FromResult<string?>(null);
                var file=new FileInfo(path);
                if(file.Length<=2*1024*1024 && PreviewImage.HasSafeDimensions(File.ReadAllBytes(path))) { File.SetLastWriteTimeUtc(path,DateTime.UtcNow); return Task.FromResult<string?>(path); }
            }
        }
        lock(gate)
        {
            if(disposed || !enabled || stoppedPlatforms.Contains(platform)) return Task.FromResult<string?>(null);
            var work=new Work(platform,CancellationTokenSource.CreateLinkedTokenSource(ct)); var id=++sequence;
            works.Add(id,work);
            work.Task=Task.Run(()=>FetchAsync(id,work,url,path)); return work.Task;
        }
    }
    async Task<string?> FetchAsync(long id,Work work,string url,string path)
    {
        var acquired=false; var ct=work.Cancel.Token;
        try
        {
            await slots.WaitAsync(ct).ConfigureAwait(false); acquired=true; byte[] bytes;
            if(url.StartsWith("data:image/png;base64,",StringComparison.Ordinal) || url.StartsWith("data:image/jpeg;base64,",StringComparison.Ordinal))
            { bytes=Convert.FromBase64String(url[(url.IndexOf(',')+1)..]); if(bytes.Length>24*1024) return null; }
            else
            {
                var next=url; byte[]? fetched=null;
                for(var redirects=0;redirects<=4;redirects++)
                {
                    if(!Allowed(work.Platform,next,out var uri)) return null;
                    using var request=new HttpRequestMessage(HttpMethod.Get,uri);
                    using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct).ConfigureAwait(false);
                    if((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
                    { if(response.Headers.Location==null) return null; next=new Uri(uri!,response.Headers.Location).AbsoluteUri; continue; }
                    if(!response.IsSuccessStatusCode || response.Content.Headers.ContentLength>2*1024*1024) return null;
                    using var data=new MemoryStream(); using var stream=await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                    var chunk=new byte[16384]; int count;
                    while((count=await stream.ReadAsync(chunk,ct).ConfigureAwait(false))>0)
                    { if(data.Length+count>2*1024*1024) return null; data.Write(chunk,0,count); }
                    fetched=data.ToArray(); break;
                }
                if(fetched==null) return null; bytes=fetched;
            }
            ct.ThrowIfCancellationRequested();
            if(!PreviewImage.HasSafeDimensions(bytes) || bytes.LongLength>limit) return null;
            lock(disk)
            {
                ct.ThrowIfCancellationRequested(); PrivateStorage.RejectLinks(root); Evict(bytes.Length);
                if(File.Exists(path)) { if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)return null; File.Delete(path); }
                // Only owned hashed files are ever written or evicted; no remote names enter local paths.
                using var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read); file.Write(bytes); file.Flush(true);
            }
            return path;
        }
        catch(Exception ex) when(ex is OperationCanceledException or HttpRequestException or IOException or FormatException or UnauthorizedAccessException) {return null;}
        finally {if(acquired)slots.Release(); lock(gate)works.Remove(id); work.Cancel.Dispose();}
    }
    public async Task StopAsync(string? platform=null)
    {
        Task[] tasks;
        lock(gate)
        {
            if(platform==null) enabled=false; else stoppedPlatforms.Add(platform);
            var selected=works.Values.Where(w=>platform==null || w.Platform==platform).ToArray();
            foreach(var work in selected)work.Cancel.Cancel(); tasks=selected.Select(w=>(Task)w.Task).ToArray();
        }
        await Task.WhenAll(tasks).ConfigureAwait(false);
    }
    public async Task ClearAsync()
    { await StopAsync().ConfigureAwait(false); lock(disk)foreach(var f in Files())f.Delete(); }
    IEnumerable<FileInfo> Files()=>new DirectoryInfo(root).EnumerateFiles("*.thumb",SearchOption.TopDirectoryOnly).Where(f=>f.Name.Length==70 && f.Name[..64].All(Uri.IsHexDigit) && (f.Attributes&FileAttributes.ReparsePoint)==0);
    void Evict(long incoming)
    {
        var files=Files().OrderBy(f=>f.LastWriteTimeUtc).ToList(); var size=files.Sum(f=>f.Length);
        foreach(var f in files) {if(size+incoming<=limit)break; size-=f.Length; f.Delete();}
    }
    static bool Allowed(string platform,string url,out Uri? uri)
    {
        uri=null;
        if(!Uri.TryCreate(url,UriKind.Absolute,out var u) || u.Scheme!="https" || !u.IsDefaultPort || u.UserInfo.Length>0 || u.HostNameType!=UriHostNameType.Dns) return false;
        var host=u.IdnHost.ToLowerInvariant();
        var suffixes=platform switch {"x"=>new[]{"pbs.twimg.com"},"douyin"=>new[]{"douyinpic.com","douyincdn.com","byteimg.com","pstatp.com","ibytedtos.com"},"xiaohongshu"=>new[]{"xhscdn.com","xhsimg.com"},_=>Array.Empty<string>()};
        if(!suffixes.Any(s=>host==s || (platform!="x" && host.EndsWith("."+s,StringComparison.Ordinal))))return false;
        uri=u;return true;
    }
    static SocketsHttpHandler CreateHandler()=>new()
    {
        AllowAutoRedirect=false,UseCookies=false,UseProxy=false,Credentials=null,AutomaticDecompression=DecompressionMethods.None,
        ConnectCallback=async(context,ct)=>
        {
            var addresses=await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host,ct).ConfigureAwait(false);
            foreach(var address in addresses)
            {
                if(!PublicAddress(address))continue; var socket=new Socket(address.AddressFamily,SocketType.Stream,ProtocolType.Tcp);
                try {await socket.ConnectAsync(new IPEndPoint(address,context.DnsEndPoint.Port),ct).ConfigureAwait(false); return new NetworkStream(socket,true);} catch {socket.Dispose();}
            }
            throw new HttpRequestException("Preview target is unavailable.");
        }
    };
    static bool PublicAddress(IPAddress ip)
    {
        if(ip.IsIPv4MappedToIPv6)ip=ip.MapToIPv4(); if(IPAddress.IsLoopback(ip))return false;
        var b=ip.GetAddressBytes();
        if(b.Length==4)return b[0]!=0 && b[0]!=10 && b[0]!=127 && b[0]<224 && !(b[0]==169&&b[1]==254) && !(b[0]==172&&b[1]>=16&&b[1]<=31) && !(b[0]==192&&b[1]==168) && !(b[0]==100&&b[1]>=64&&b[1]<=127);
        return !ip.IsIPv6LinkLocal && !ip.IsIPv6Multicast && !ip.Equals(IPAddress.IPv6None) && (b[0]&0xE0)==0x20;
    }
    public async ValueTask DisposeAsync() {lock(gate)disposed=true; await StopAsync().ConfigureAwait(false); client.Dispose(); slots.Dispose();}
    sealed class Work(string platform,CancellationTokenSource cancel)
    {public string Platform {get;}=platform;public CancellationTokenSource Cancel {get;}=cancel;public Task<string?> Task {get;set;}=System.Threading.Tasks.Task.FromResult<string?>(null);}
}
