using System.Net;using System.Net.Sockets;using System.Text;using System.Text.Json;
namespace UnifiedMediaHub.Core;

public sealed class BridgeEndpoint(BridgePairing pairing,Func<BridgePayload,CancellationToken,Task<BridgeImportResult>> import):IAsyncDisposable
{
 readonly HashSet<Task> clients=[];readonly SemaphoreSlim slots=new(8);readonly object state=new();CancellationTokenSource? stop;TcpListener? listener;Task? accepting,shutdown;int busy;
 public bool Enabled{get{lock(state)return listener!=null;}}public int Port{get;private set;}
 public event Action<string,int>? Diagnostic;
 public void Start(int port=47631){lock(state){if(Enabled||shutdown is {IsCompleted:false})throw new InvalidOperationException("桥接已开启或正在停止。");if(port is <1024 or >65535)throw new ArgumentOutOfRangeException(nameof(port));var next=new TcpListener(IPAddress.Loopback,port);next.Server.ExclusiveAddressUse=true;try{next.Start(8);}catch{next.Stop();throw;}Port=port;stop=new();listener=next;shutdown=null;accepting=Accept(next,stop.Token);}}
 async Task Accept(TcpListener active,CancellationToken ct){try{while(!ct.IsCancellationRequested){var client=await active.AcceptTcpClientAsync(ct);if(!slots.Wait(0)){client.Dispose();continue;}var task=Handle(client,ct);lock(clients)clients.Add(task);_=task.ContinueWith(done=>{lock(clients)clients.Remove(done);slots.Release();},CancellationToken.None,TaskContinuationOptions.ExecuteSynchronously,TaskScheduler.Default);}}catch(Exception e)when(e is OperationCanceledException or SocketException or ObjectDisposedException){}}
 async Task Handle(TcpClient client,CancellationToken lifetime){using(client){using var timeout=CancellationTokenSource.CreateLinkedTokenSource(lifetime);timeout.CancelAfter(TimeSpan.FromSeconds(10));var stream=client.GetStream();var owns=false;try{
  var header=new MemoryStream();var buffer=new byte[4096];int end=-1;while(end<0){var n=await stream.ReadAsync(buffer,timeout.Token);if(n==0)return;header.Write(buffer,0,n);var all=header.GetBuffer();for(var i=Math.Max(0,(int)header.Length-n-3);i<header.Length-3;i++)if(all[i]==13&&all[i+1]==10&&all[i+2]==13&&all[i+3]==10){end=i+4;break;}if((end<0&&header.Length>16384)||end>16384){await Reply(stream,400,"invalid_payload",lifetime);return;}}
  var bytes=header.ToArray();if(bytes.Take(end).Any(b=>b>127||b==0))throw new InvalidDataException();var lines=Encoding.ASCII.GetString(bytes,0,end-4).Split("\r\n");var first=lines[0].Split(' ');if(first.Length!=3||first[2]!="HTTP/1.1")throw new InvalidDataException();var headers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);foreach(var line in lines.Skip(1)){var split=line.IndexOf(':');if(split<1||line.Take(split).Any(c=>!char.IsAsciiLetterOrDigit(c)&&c!='-')||!headers.TryAdd(line[..split],line[(split+1)..].Trim()))throw new InvalidDataException();}
  if(!headers.TryGetValue("Host",out var host)||!new[]{"localhost:"+Port,"127.0.0.1:"+Port}.Contains(host,StringComparer.OrdinalIgnoreCase)||headers.ContainsKey("Transfer-Encoding"))throw new InvalidDataException();
  if(headers.ContainsKey("Origin")){await Reply(stream,403,"origin_rejected",lifetime);return;}
  if(first[0]=="GET"&&first[1]=="/bridge/v1/ping"){await Write(stream,200,new{version="1",enabled=Enabled},lifetime);return;}
  if(first[0]!="POST"||first[1]!="/bridge/v1/douyin/items")throw new InvalidDataException();
  if(!pairing.Matches(headers.GetValueOrDefault("X-UMH-Bridge-Token"))){await Reply(stream,401,"bad_token",lifetime);return;}
  if(!headers.TryGetValue("Content-Type",out var type)||!type.Split(';')[0].Trim().Equals("application/json",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException();
  if(!headers.TryGetValue("Content-Length",out var size)||!size.All(char.IsAsciiDigit)||!long.TryParse(size,out var length)||length<1)throw new InvalidDataException();if(length>BridgePayload.MaxBytes){await Reply(stream,413,"too_large",lifetime);client.Client.Shutdown(SocketShutdown.Send);using var drain=CancellationTokenSource.CreateLinkedTokenSource(lifetime);drain.CancelAfter(TimeSpan.FromSeconds(1));try{for(var budget=BridgePayload.MaxBytes;budget>0;){var n=await stream.ReadAsync(buffer.AsMemory(0,Math.Min(buffer.Length,budget)),drain.Token);if(n==0)break;budget-=n;}}catch(OperationCanceledException){}return;}
  if(Interlocked.CompareExchange(ref busy,1,0)!=0){await Reply(stream,409,"busy",lifetime);return;}owns=true;
  var body=new byte[(int)length];var prefix=bytes.Length-end;if(prefix>body.Length)throw new InvalidDataException();Array.Copy(bytes,end,body,0,prefix);var read=prefix;while(read<body.Length){var n=await stream.ReadAsync(body.AsMemory(read),timeout.Token);if(n==0)throw new InvalidDataException();read+=n;}
  if(!pairing.Matches(headers.GetValueOrDefault("X-UMH-Bridge-Token"))){await Reply(stream,401,"bad_token",lifetime);return;}
  var payload=BridgePayload.Parse(body);timeout.CancelAfter(Timeout.InfiniteTimeSpan);lifetime.ThrowIfCancellationRequested();var result=await import(payload,lifetime);Diagnostic?.Invoke("accepted",result.ItemCount);await Write(stream,200,new{accepted=true,jobId=result.JobId,itemCount=result.ItemCount},lifetime);
 }catch(BridgeRequestException e){try{await Reply(stream,e.Code=="busy"?409:503,e.Code,lifetime);}catch(IOException){}}
 catch(Exception e)when(e is InvalidDataException or JsonException or KeyNotFoundException or InvalidOperationException or FormatException){try{await Reply(stream,400,"invalid_payload",lifetime);}catch(IOException){}}
 catch(OperationCanceledException){if(!lifetime.IsCancellationRequested)try{await Reply(stream,400,"invalid_payload",lifetime);}catch(IOException){}}
 catch(Exception e)when(e is IOException or SocketException or ObjectDisposedException){}
 finally{if(owns)Interlocked.Exchange(ref busy,0);}}}
 async Task Reply(NetworkStream stream,int status,string code,CancellationToken ct){Diagnostic?.Invoke(code,0);await Write(stream,status,new{accepted=false,code},ct);}
 static async Task Write(NetworkStream stream,int status,object value,CancellationToken ct){var body=JsonSerializer.SerializeToUtf8Bytes(value,HubJson.Options);var head=Encoding.ASCII.GetBytes($"HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");await stream.WriteAsync(head,ct);await stream.WriteAsync(body,ct);}
 public Task StopAsync(){lock(state){if(listener==null)return shutdown??Task.CompletedTask;var active=listener;listener=null;var retiring=stop!;retiring.Cancel();active.Stop();shutdown=Retire(accepting,retiring);return shutdown;}}
 async Task Retire(Task? accept,CancellationTokenSource retiring){if(accept!=null)await accept;Task[] pending;lock(clients)pending=clients.ToArray();try{await Task.WhenAll(pending);}finally{retiring.Dispose();}}
 public async ValueTask DisposeAsync(){await StopAsync();}
}
public sealed class BridgeRequestException(string code):Exception
{public string Code{get;}=code is "busy" or "disabled"?code:"disabled";}
