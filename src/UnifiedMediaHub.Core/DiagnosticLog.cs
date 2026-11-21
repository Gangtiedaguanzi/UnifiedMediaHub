using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace UnifiedMediaHub.Core;

public sealed class DiagnosticLog
{
 const long Budget=5_000_000;
 static readonly HashSet<string> Parts=new("aweme v1 v2 v3 web api sns user profile self detail note feed listcollection post user_posted favorite like collect page me video slides share explore discovery item jingxuan discover search_result".Split(' '));
 static readonly Dictionary<string,string[]> Enums=new(){["status"]=["idle_timeout"],["telegramCheck"]=["peer_mismatch","public_peer_mismatch","message_missing","media_unresolved"],["peerKind"]=["user","chat","channel"],["xVerify"]="no_viewer ui_missing blocked rate_limited navigation_count viewer_conflict cookie_missing cookie_mismatch binding_mismatch".Split(' '),["method"]=["GET","POST"],["listVerdict"]="accepted rejected_frame rejected_subject rejected_origin rejected_credentials rejected_subject_count rejected_subject_value rejected_snapshot_subject rejected_current_subject rejected_cursor rejected_method not_ready stale_generation not_belongs payload_invalid body_limit tab_unconfirmed".Split(' '),["originFamily"]="www.douyin.com douyin.com iesdouyin.com www.xiaohongshu.com xiaohongshu.com edith.xiaohongshu.com webapi.rednote.com other".Split(' '),["reason"]="completed history_unproven item_limit scan_boundary work_unresolved challenge rate_limited auth_required identity_unverified source_changed browser_closed source_tab_required manual_wait_timeout input_required cancelled operation_failed".Split(' ')};
 static readonly HashSet<string> Fields=new("status_code status_msg aweme_detail aweme_list data items notes note_card code success has_more cursor log_pb extra filter_list".Split(' '));
 static readonly Regex Owned=new("^[a-fA-F0-9]{32}\\.json$",RegexOptions.CultureInvariant);
 readonly List<Dictionary<string,object>> entries=[];
 public static Dictionary<string,object>? Clean(JsonElement raw)
 {
  if(raw.ValueKind!=JsonValueKind.Object)return null;var result=new Dictionary<string,object>();
  foreach(var key in new[]{"path","finalPath","snapshotPath"})if(raw.TryGetProperty(key,out var path)&&path.ValueKind==JsonValueKind.String&&path.GetString() is {Length:>0 and <=16384} text&&Uri.TryCreate(new Uri("https://diagnostic.invalid"),text,out var uri))result[key]=string.Join('/',uri.AbsolutePath.Split('/').Select(p=>p.Length==0?"":Parts.Contains(p)?p:":id"));
  if(raw.TryGetProperty("host",out var host)&&host.ValueKind==JsonValueKind.String&&host.GetString() is {} h){var match=Regex.Match(h,"^(?:[a-z0-9-]+\\.)*((?:douyinvod|douyinpic|byteimg|xhscdn|twimg|zjcdn)\\.com)$",RegexOptions.CultureInvariant);if(match.Success)result["host"]=match.Groups[1].Value;}
  foreach(var (key,min,max) in new[]{("status",100,599),("attempt",1,8),("requestOrdinal",1,1024),("requestSubjectLength",0,256),("sourceSubjectLength",0,256),("accountIdLength",0,256),("embeddedScanned",0,1000),("rscRowsParsed",0,50),("awemeType",0,10000),("mediaType",0,10000),("imageCount",0,200),("liveVideoCount",0,200),("unknownFieldCount",0,10000),("entryCount",0,1000),("unsupportedMedia",0,100000),("rounds",0,500),("scrolls",0,500),("published",0,10000)})if(raw.TryGetProperty(key,out var n)&&n.TryGetInt32Safe(out var value)&&value>=min&&value<=max)result[key]=value;
  foreach(var key in new[]{"operationStarted","scanExpired","hasAwemeDetail","hasLiveVideo","unresolved","jsonObserved","sourceChanged","bodyUnavailable","bodyTooLarge","wrapperFound","detailFound","hasMore","tabConfirmed","listEndSeen","manualWait","requestSubjectIsSource","requestSubjectIsAccount","sourceSubjectIsAccount","snapshotHasWork","snapshotHostAllowed","snapshotSubjectIsSource"})if(raw.TryGetProperty(key,out var value)&&value.ValueKind is JsonValueKind.True or JsonValueKind.False)result[key]=value.GetBoolean();
  foreach(var (key,allowed) in Enums)if(raw.TryGetProperty(key,out var value)&&value.ValueKind==JsonValueKind.String&&allowed.Contains(value.GetString()))result[key]=value.GetString()!;
  // Host failure: exception type and a plain-word message (no digits, paths or quotes survive).
  if(raw.TryGetProperty("unsupportedExt",out var ext)&&ext.ValueKind==JsonValueKind.String&&Regex.IsMatch(ext.GetString()!,"^[a-z0-9]{1,10}$",RegexOptions.CultureInvariant))result["unsupportedExt"]=ext.GetString()!;
  if(raw.TryGetProperty("hostStage",out var stage)&&stage.ValueKind==JsonValueKind.String&&Regex.IsMatch(stage.GetString()!,"^[A-Za-z_<>]{3,80}$",RegexOptions.CultureInvariant))result["hostStage"]=stage.GetString()!;
  if(raw.TryGetProperty("hostFailure",out var type)&&type.ValueKind==JsonValueKind.String&&Regex.IsMatch(type.GetString()!,"^[A-Za-z]{3,60}$",RegexOptions.CultureInvariant))result["hostFailure"]=type.GetString()!;
  if(raw.TryGetProperty("hostMessage",out var hostText)&&hostText.ValueKind==JsonValueKind.String&&Regex.IsMatch(hostText.GetString()!,"^[A-Za-z][A-Za-z ,.;()-]{2,120}$",RegexOptions.CultureInvariant))result["hostMessage"]=hostText.GetString()!;
  if(raw.TryGetProperty("xEngineError",out var engineError)&&engineError.ValueKind==JsonValueKind.String&&Regex.IsMatch(engineError.GetString()!,"^[A-Za-z]{3,40}$",RegexOptions.CultureInvariant))result["xEngineError"]=engineError.GetString()!;
  if(raw.TryGetProperty("xSourceKind",out var sourceKind)&&sourceKind.GetString() is "single" or "profile" or "saved" or "liked")result["xSourceKind"]=sourceKind.GetString()!;
  if(raw.TryGetProperty("xEngineDetail",out var engineDetail)&&engineDetail.ValueKind==JsonValueKind.String&&Regex.IsMatch(engineDetail.GetString()!,"^(?:rate_limit|timeline_unavailable|not_authenticated|protected|other|http_[0-9]{3})$",RegexOptions.CultureInvariant))result["xEngineDetail"]=engineDetail.GetString()!;
  // Worker failure codes: identifiers from code literals only.
  foreach(var key in new[]{"failure","engineCode"})if(raw.TryGetProperty(key,out var code)&&code.ValueKind==JsonValueKind.String&&Regex.IsMatch(code.GetString()!,"^[a-z][a-z_]{2,40}$",RegexOptions.CultureInvariant))result[key]=code.GetString()!;
  if(raw.TryGetProperty("topFields",out var keys)&&keys.ValueKind==JsonValueKind.Array)result["topFields"]=keys.EnumerateArray().Where(k=>k.ValueKind==JsonValueKind.String&&Fields.Contains(k.GetString()!)).Select(k=>k.GetString()!).Distinct().Order().Take(8).ToArray();
  while(JsonSerializer.SerializeToUtf8Bytes(result).Length>300)result.Remove(result.Keys.Last());
  return result.Count==0?null:result;
 }
 public void Add(JsonElement raw){lock(entries){if(entries.Count<200&&Clean(raw) is {} value)entries.Add(value);}}
 public bool Save(string dataRoot,string jobId)
 {
  lock(entries){if(entries.Count==0)return true;
   try{
    if(!Regex.IsMatch(jobId,"^[a-fA-F0-9]{32}$"))return false;
    var dir=Path.Combine(dataRoot,"private","diagnostics");PrivateStorage.SecureDirectory(dir);var target=Path.Combine(dir,jobId+".json");
    var records=ReadFile(target);records.Add(new(){CompletedAt=DateTimeOffset.UtcNow,Entries=entries.ToList()});records=records.OrderByDescending(r=>r.CompletedAt).Take(5).ToList();
    var bytes=JsonSerializer.SerializeToUtf8Bytes(records,HubJson.Options);if(bytes.Length>Budget)return false;
    var all=new DirectoryInfo(dir).EnumerateFileSystemInfos().ToArray();if(all.Length>10000||all.Any(f=>(f.Attributes&FileAttributes.ReparsePoint)!=0))return false;
    long total=all.OfType<FileInfo>().Sum(f=>f.Length);var count=all.OfType<FileInfo>().Count();
    foreach(var old in all.OfType<FileInfo>().Where(f=>Owned.IsMatch(f.Name)&&f.FullName!=target).OrderBy(f=>f.LastWriteTimeUtc)){
     if(total+bytes.Length<=Budget&&count<100)break;var length=old.Length;old.Delete();total-=length;count--;
    }
    if(total+bytes.Length>Budget||count>=100)return false;
    var temp=Path.Combine(dir,jobId+"."+Guid.NewGuid().ToString("N")+".tmp");var created=false;
    try{using(var file=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){created=true;file.Write(bytes);file.Flush(true);}PlainFile(target);File.Move(temp,target,true);}
    finally{if(created&&File.Exists(temp))File.Delete(temp);}
    return true;
   }catch(Exception e)when(e is IOException or UnauthorizedAccessException or JsonException){return false;}
  }
 }
 public static IReadOnlyList<IReadOnlyList<Dictionary<string,object>>> ReadRecent(string directory)
 {
  try{
   PrivateStorage.RejectLinks(directory);if(!Directory.Exists(directory))return [];
   var files=new DirectoryInfo(directory).EnumerateFiles().Where(f=>Owned.IsMatch(f.Name)).Take(100).ToArray();
   if(files.Sum(f=>f.Length)>Budget)return [];
   return files.SelectMany(f=>ReadFile(f.FullName)).OrderByDescending(r=>r.CompletedAt).Take(5).Select(r=>(IReadOnlyList<Dictionary<string,object>>)r.Entries).ToArray();
  }catch(Exception e)when(e is IOException or UnauthorizedAccessException or JsonException){return [];}
 }
 static void PlainFile(string file){PrivateStorage.RejectLinks(Path.GetDirectoryName(file)!);if(File.Exists(file)&&(File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new IOException("Unsafe diagnostic file.");}
 static List<Snapshot> ReadFile(string file)
 {
  PlainFile(file);if(!File.Exists(file)||new FileInfo(file).Length>Budget)return [];
  try{
   using var doc=JsonDocument.Parse(File.ReadAllText(file));if(doc.RootElement.ValueKind!=JsonValueKind.Array)return [];
   return doc.RootElement.EnumerateArray().Take(5).Where(r=>r.ValueKind==JsonValueKind.Object).Select(r=>{
    var result=new Snapshot();if(r.TryGetProperty("completedAt",out var time)&&time.ValueKind==JsonValueKind.String&&time.TryGetDateTimeOffset(out var at))result.CompletedAt=at;
    if(r.TryGetProperty("entries",out var rows)&&rows.ValueKind==JsonValueKind.Array)foreach(var row in rows.EnumerateArray().Take(200))if(Clean(row) is {} entry)result.Entries.Add(entry);
    return result;
   }).ToList();
  }catch(JsonException){return [];}
 }
 sealed class Snapshot{public DateTimeOffset CompletedAt{get;set;}public List<Dictionary<string,object>> Entries{get;set;}=[];}
}
static class DiagnosticJsonExtensions{public static bool TryGetInt32Safe(this JsonElement e,out int value){value=0;return e.ValueKind==JsonValueKind.Number&&e.TryGetInt32(out value);}}
