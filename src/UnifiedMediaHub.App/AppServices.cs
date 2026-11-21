using System.IO;
using System.Text.Json;
using UnifiedMediaHub.Core;
using UnifiedMediaHub.Core.Runtime;

namespace UnifiedMediaHub.App;

public sealed class AccountRecord
{
    public string Platform {get;set;}=""; public string AccountId {get;set;}=""; public string DisplayName {get;set;}=""; public string CheckedAt {get;set;}="";
    public string Badge=>$"已登录：{DisplayName}（{UserText.Platform(Platform)}，{CheckedAt} 确认）";
}
public sealed class AppServices : IDisposable
{
    readonly DataRootLease lease;
    public string DataRoot {get;}
    public string LoadedReleaseId {get;} = Read<LoadedManifest>(Path.Combine(AppContext.BaseDirectory,"release-manifest.json"))?.ReleaseId ?? "开发版本（未打包）";
    sealed class LoadedManifest {public string? ReleaseId {get;set;}}
    public bool Smoke {get;}
    public HubRepository Repository {get;}
    public PreviewCache Previews {get;}
    public HubCoordinator Hub {get;}
    public HubSettings Settings {get;private set;}
    public List<AccountRecord> Accounts {get;}
    public FixtureWorker? Fixture {get;}
    public BridgeEndpoint? Bridge {get;private set;}
    public BridgePairing? Pairing {get;private set;}
    public Func<BridgePayload,CancellationToken,Task<BridgeImportResult>>? BridgeImporter {get;set;}
    readonly SemaphoreSlim bridgeState=new(1);
    public AppServices(string root,string? smoke,DataRootLease? startupLease=null)
    {
        DataRoot=Path.GetFullPath(root); Smoke=smoke!=null;
        if(startupLease!=null&&!startupLease.Matches(DataRoot))throw new InvalidOperationException("启动实例与数据目录不一致。");
        lease=startupLease??DataRootLease.Acquire(DataRoot);
        try
        {
            PrivateStorage.RejectLinks(DataRoot);Directory.CreateDirectory(DataRoot);
            var privateRoot=Path.Combine(DataRoot,"private"); PrivateStorage.SecureDirectory(privateRoot);
            Repository=new(Path.Combine(privateRoot,"hub.db"));Repository.Initialize();
            Settings=Read<HubSettings>(Path.Combine(DataRoot,"settings.json"))??new();
            Accounts=Read<List<AccountRecord>>(Path.Combine(privateRoot,"accounts.json"))??[];
            Previews=new(Path.Combine(privateRoot,"thumbnails"));
            var paths=new WorkerPaths{DataRoot=DataRoot,DownloadRoot=Settings.DownloadRoot,BrowserExecutable=Path.Combine(AppContext.BaseDirectory,"runtime","browsers","chromium-1248","chrome-win64","chrome.exe"),EngineRoot=Path.Combine(AppContext.BaseDirectory,"runtime","engines")};
            IWorkerRunner runner;
            if(Smoke) {Fixture=new FixtureWorker(smoke!);runner=Fixture;Settings.DownloadRoot=Path.Combine(smoke!,"fixture-downloads");}
            else runner=new ReleaseWorker(DataRoot);
            Hub=new(Repository,runner,paths){FolderPerTask=Settings.FolderPerTask,AccountName=p=>Account(p)?.DisplayName is {Length:>0} name&&name!="已保存账号"?name:null};
            // Close the port immediately even when the coordinator disables
            // itself (for example, metadata-space failure), then join retirement
            // through the normal Stop/Dispose path.
            Hub.Changed+=changedJobId=>{if(!Hub.Enabled&&Bridge!=null)_=Bridge.StopAsync();};
            Hub.Message+=(_,evt)=>
            {
                if(evt.Type!="account" || evt.Authenticated!=true || string.IsNullOrEmpty(evt.AccountId) || string.IsNullOrEmpty(evt.Platform))return;
                lock(Accounts)
                {
                    Accounts.RemoveAll(a=>a.Platform==evt.Platform);
                    Accounts.Add(new(){Platform=evt.Platform,AccountId=evt.AccountId,DisplayName=CleanName(evt.DisplayName),CheckedAt=DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm")});
                    Write(Path.Combine(privateRoot,"accounts.json"),Accounts);
                }
            };
        }
        catch {lease.Dispose();throw;}
    }
    static string CleanName(string? value)=>new((value??"已保存账号").Where(c=>!char.IsControl(c)).Take(80).ToArray());
    public AccountRecord? Account(string platform){lock(Accounts)return Accounts.FirstOrDefault(a=>a.Platform==platform);}
    public void SaveSettings(string output,int maxItems,bool folderPerTask)
    {
        if(!Path.IsPathFullyQualified(output))throw new InvalidOperationException("请选择完整的下载目录路径。");
        Settings.DownloadRoot=Path.GetFullPath(output);Settings.MaxScanItems=Math.Max(0,maxItems);Settings.FolderPerTask=folderPerTask;Hub.FolderPerTask=folderPerTask;Write(Path.Combine(DataRoot,"settings.json"),Settings);
    }
    public async Task ConfigureBridgeAsync(bool enabled,int port)
    {if(port is <1024 or >65535)throw new InvalidOperationException("桥接端口应为1024–65535。");await bridgeState.WaitAsync();try{if(Bridge!=null)await Bridge.StopAsync();Settings.EdgeBridgeEnabled=enabled;Settings.EdgeBridgePort=port;Write(Path.Combine(DataRoot,"settings.json"),Settings);if(enabled&&Hub.Enabled)StartBridge();}finally{bridgeState.Release();}}
    void StartBridge()
    {if(Bridge?.Enabled==true)return;Pairing??=new BridgePairing(DataRoot);Bridge??=new BridgeEndpoint(Pairing,(payload,ct)=>BridgeImporter!=null&&Hub.Enabled?BridgeImporter(payload,ct):throw new BridgeRequestException("disabled"));try{Bridge.Start(Settings.EdgeBridgePort);}catch(System.Net.Sockets.SocketException){throw new InvalidOperationException($"桥接端口 {Settings.EdgeBridgePort} 已被占用或不可用，请手动选择其他端口；没有修改系统设置。");}}
    public async Task StartConfiguredBridgeAsync(){await bridgeState.WaitAsync();try{if(Settings.EdgeBridgeEnabled&&Hub.Enabled){if(Bridge!=null&&!Bridge.Enabled)await Bridge.StopAsync();StartBridge();}}finally{bridgeState.Release();}}
    public async Task StopBridgeAsync(){await bridgeState.WaitAsync();try{if(Bridge!=null)await Bridge.StopAsync();}finally{bridgeState.Release();}}
    public string ExportReport()
    {
        return SanitizedReport.Create(Repository,Hub.StorageWarning);
    }
    public static T? Read<T>(string path) {try {return File.Exists(path)?JsonSerializer.Deserialize<T>(File.ReadAllText(path),HubJson.Options):default;}catch(JsonException){return default;}}
    public static void Write<T>(string path,T value)
    {PrivateStorage.RejectLinks(Path.GetDirectoryName(path)!);var temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";try{File.WriteAllText(temp,JsonSerializer.Serialize(value,HubJson.Options));File.Move(temp,path,true);}finally{if(File.Exists(temp))File.Delete(temp);}}
    public void Dispose(){Bridge?.DisposeAsync().AsTask().GetAwaiter().GetResult();Repository.Dispose();lease.Dispose();bridgeState.Dispose();}
}
internal sealed class ReleaseWorker(string dataRoot) : IResourceWorkerRunner
{
    OwnedWorkerRunner? current;
    public Task RunAsync(WorkerRequest request,Func<WorkerEvent,Task> emit,CancellationToken ct)
        => RunWithResourcesAsync(request, emit, _ => { }, ct);
    public async Task RunWithResourcesAsync(WorkerRequest request,Func<WorkerEvent,Task> emit,Action<ResourceMetrics> resources,CancellationToken ct)
    {
        var release=AppContext.BaseDirectory;
        var manifest=AppServices.Read<ReleaseManifest>(Path.Combine(release,"release-manifest.json"))??throw new IOException("Release manifest missing.");
        var browser=Path.GetFullPath(Path.Combine(release,manifest.BrowserExecutable));
        if(Path.IsPathRooted(manifest.BrowserExecutable) || !browser.StartsWith(Path.Combine(release,"runtime","browsers")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase) || !File.Exists(browser))throw new IOException("Invalid browser manifest.");
        PrivateStorage.RejectLinks(Path.GetDirectoryName(browser)!);request.Paths.BrowserExecutable=browser;
        var temp=Path.Combine(dataRoot,"private","temp"); var home=Path.Combine(dataRoot,"private","home");Directory.CreateDirectory(temp);Directory.CreateDirectory(home);
        var options=new WorkerLaunchOptions{ExecutablePath=Path.Combine(release,"runtime","node","node.exe"),WorkerScriptPath=Path.Combine(release,"worker","src","main.mjs"),WorkingDirectory=release,Environment=new(){["TEMP"]=temp,["TMP"]=temp,["HOME"]=home,["USERPROFILE"]=home,["APPDATA"]=Path.Combine(home,"AppData","Roaming"),["LOCALAPPDATA"]=Path.Combine(home,"AppData","Local")}};
        current=new(options);try{await current.RunWithResourcesAsync(request,emit,resources,ct);}finally{current=null;}
    }
    public Task SendControlAsync(object control,CancellationToken ct=default)=>(current??throw new InvalidOperationException("没有等待输入的任务。")).SendControlAsync(control,ct);
    sealed class ReleaseManifest {public string BrowserExecutable {get;set;}="";}
}
