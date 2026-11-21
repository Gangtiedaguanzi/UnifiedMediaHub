using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Channels;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using UnifiedMediaHub.Core;
using UnifiedMediaHub.Core.Runtime;

namespace UnifiedMediaHub.App;

// Explicit offline mode: never constructed during an ordinary launch.
public sealed class FixtureWorker(string output) : IWorkerRunner
{
    readonly Channel<string> controls=Channel.CreateUnbounded<string>();
    OwnedWorkerRunner? adapterLogin;
    public bool UsedRealXLoginAdapter {get;private set;}
    public bool FailXLogin {get;set;}
    public List<string> Thumbnails {get;}=[];
    public int Requests {get;private set;}
    public int Transfers {get;private set;}
    public int Resends {get;private set;}
    public int CodeTimeoutSeconds {get;set;}
    public int ScanCount {get;set;}=80;
    public int FolderCount {get;set;}=2;
    public int FolderLists {get;private set;}
    public bool CaptureDownloadsOnly {get;set;}
    public List<WorkerRequest> CapturedDownloads {get;}=[];
    public bool BlockNext {get;set;}
    public string QrFixtureMode {get;set;}="complete";
    public string ScanActionMode {get;set;}="none";
    public int Continues {get;private set;}
    public async Task RunAsync(WorkerRequest request,Func<WorkerEvent,Task> emit,CancellationToken ct)
    {
        Requests++;
        if(request.Operation=="importBridge"){foreach(var entry in request.BridgePayload!.Value.GetProperty("items").EnumerateArray()){var id=entry.GetProperty("hrefId").GetString()!;if(entry.TryGetProperty("oversized",out var large)&&large.ValueKind==JsonValueKind.True){await emit(new(){Type="item",Item=new(){Platform="douyin",ContentId=id,SourceUrl="https://www.douyin.com/video/"+id,Title="过大，暂不支持",MediaResolved=false,Selected=false}});continue;}await emit(new(){Type="item",Item=new(){Key="douyin:"+id,Platform="douyin",ContentId=id,SourceUrl="https://www.douyin.com/video/"+id,Title="Synthetic bridge work",ThumbnailUrl=Thumbnails.FirstOrDefault(),MediaResolved=true,Media=[new(){Index=1,Kind="image",Url="https://p3.douyinpic.com/synthetic.jpg"}]}});}await emit(new(){Type="complete",Status="completed",Completeness="partial",ReasonCode="bridge_snapshot"});return;}
        if(BlockNext){BlockNext=false;await Task.Delay(Timeout.Infinite,ct);}
        if(request.Operation=="loginQr"){
            await emit(new(){Type="login_qr",QrCode=TelegramQrHarness.SyntheticQr(QrFixtureMode=="expiry"?2:60)});
            if(QrFixtureMode=="expiry"){await Task.Delay(2200,ct);await emit(new(){Type="needs_action",Code="qr_expired"});await emit(new(){Type="complete",Status="needs_action",ReasonCode="qr_expired",Completeness="unknown"});return;}
            await controls.Reader.ReadAsync(ct);
            if(QrFixtureMode=="2fa"){await emit(new(){Type="needs_action",Code="input_required",InputId=Guid.NewGuid().ToString(),InputType="password",Prompt="Telegram two-step verification password",AwaitingInput=true});await controls.Reader.ReadAsync(ct);}
            await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId="synthetic-qr-account"});
        }
        if(request.Operation=="login")
        {
            var config=AppServices.Read<LoginAdapterFixture>(Path.Combine(output,"x-login-worker-config.json"));
            if(request.Source.Platform=="x" && config!=null)
            {
                adapterLogin=new(new(){ExecutablePath=config.NodeExecutable,WorkerScriptPath=config.WorkerScript,WorkingDirectory=output});
                try{UsedRealXLoginAdapter=true;await adapterLogin.RunAsync(request,emit,ct);}
                finally{adapterLogin=null;}
                return;
            }
            for(;;){
                var telegram=request.Source.Platform=="telegram";
                await emit(new(){Type="needs_action",AwaitingInput=true,InputId=telegram?Guid.NewGuid().ToString():null,Delivery=telegram?new(){Method="app",NextMethod="sms",TimeoutSeconds=CodeTimeoutSeconds,ResendsRemaining=3-Resends}:null,Code=telegram?"input_required":"auth_required",InputType=telegram?"password":null,Prompt=telegram?"Telegram login code":null});
                var command=await controls.Reader.ReadAsync(ct);if(telegram&&command=="resend"){Resends++;continue;}if(command==(telegram?"input":"finish-login"))break;
            }
            if(request.Source.Platform=="x"&&FailXLogin){await emit(new(){Type="needs_action",Code="auth_required"});await emit(new(){Type="complete",Status="needs_action",ReasonCode="auth_required",Completeness="unknown"});return;}
            await emit(new(){Type="account",Platform=request.Source.Platform,Authenticated=true,AccountId="fixtureAccount",DisplayName="离线样本账号"});
        }
        if(request.Operation=="scan")
        {
            if(request.Source.Platform=="telegram" || request.Source.Kind is "saved" or "liked" or "saved_folder")await emit(new(){Type="account",Platform=request.Source.Platform,Authenticated=true,AccountId="fixtureAccount"});
            if(ScanActionMode!="none"){
                await emit(new(){Type="needs_action",Code="source_tab_required",AwaitingInput=true});
                if(ScanActionMode=="expiry"){
                    await Task.Delay(1200,ct);
                    await emit(new(){Type="needs_action",Code="manual_wait_timeout",AwaitingInput=false});
                    await emit(new(){Type="complete",Status="needs_action",ReasonCode="manual_wait_timeout",Completeness="partial"});return;
                }
                if(await controls.Reader.ReadAsync(ct)!="continue")throw new InvalidOperationException("Unexpected synthetic scan control");
                Continues++;
            }
            for(var i=1;i<=ScanCount;i++)
            {
                ct.ThrowIfCancellationRequested();var platform=request.Source.Platform;
                var item=new ContentItem{Platform=platform,ContentId=i.ToString(),Key=$"{platform}:{i}",SourceUrl=$"https://x.com/fixtureAuthor/status/{i}",Title=(i%3) switch{0=>"离线样本 · 山间的光线与风景",1=>"离线样本 · 城市散步记录",_=>"离线样本 · 海边的一天"},Author="合成作者 · 仅供界面验证",AuthorUrl="https://x.com/fixtureAuthor",CreatedAt="2026-10-24",ThumbnailUrl=Thumbnails.Count>0?Thumbnails[(i-1)%Thumbnails.Count]:null,MediaResolved=true,Media=[new(){Index=1,Kind="image",Extension="png"},new(){Index=2,Kind=i%3==0?"video":"image",Extension=i%3==0?"mp4":"png"}]};
                if(platform=="telegram"){item.ChatId=request.Source.ChatId??"channel_123";item.MessageId=i.ToString();item.Key=$"telegram:{item.ChatId}:{i}";item.SourceUrl="";item.AuthorUrl=null;}
                await emit(new(){Type="item",Item=item});
            }
        }
        if(request.Operation=="listChats")
        {await emit(new(){Type="account",Platform="telegram",Authenticated=true,AccountId=request.Source.AccountId??"123"});await emit(new(){Type="chat",Chat=new(){Id="channel_123",Title="合成频道"}});}
        if(request.Operation=="listFolders")
        {
            FolderLists++;
            await emit(new(){Type="account",Platform=request.Source.Platform,Authenticated=true,AccountId="fixtureAccount"});
            await emit(new(){Type="folder",Folder=new(){Id="synthetic_one",Title="离线合成收藏夹",ItemCount=null}});
            await emit(new(){Type="folder",Folder=new(){Id="synthetic_two",Title="离线合成收藏夹",ItemCount=2}});
            if(FolderCount>=3)await emit(new(){Type="folder",Folder=new(){Id="synthetic_three",Title="离线合成第三收藏夹",ItemCount=1}});
        }
        if(request.Operation=="download")
        {
            if(request.Source.AccountId!=null)await emit(new(){Type="account",Platform=request.Source.Platform,Authenticated=true,AccountId="fixtureAccount"});
            if(CaptureDownloadsOnly){CapturedDownloads.Add(request);await emit(new(){Type="complete",Status="completed",Completeness="partial"});return;}
            foreach(var item in request.Items??[])
                foreach(var media in item.Media)
                {
                    ct.ThrowIfCancellationRequested();var path=Path.Combine(request.Paths.DownloadRoot,$"fixture-{item.ContentId}-{media.Index}.png");Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    var bytes=Convert.FromBase64String(Thumbnails[0].Split(',')[1]);await File.WriteAllBytesAsync(path,bytes,ct);Transfers++;
                    await emit(new(){Type="receipt",Receipt=new(){ContentKey=item.Key,MediaIndex=media.Index,FilePath=path,Bytes=bytes.Length,Sha256=Convert.ToHexString(SHA256.HashData(bytes)),Status="completed"}});
                }
        }
        await emit(new(){Type="complete",Status="completed",Completeness=request.Operation=="scan"?"partial":"unknown"});
    }
    public Task SendControlAsync(object control,CancellationToken ct=default)
    {
        if(adapterLogin!=null)return adapterLogin.SendControlAsync(control,ct);
        using var data=JsonDocument.Parse(JsonSerializer.Serialize(control));
        // Never retain input text, even fixture input. Only the command is needed.
        return controls.Writer.WriteAsync(data.RootElement.GetProperty("command").GetString()!,ct).AsTask();
    }
    public string Output=>output;
    public sealed class LoginAdapterFixture {public string NodeExecutable {get;set;}="";public string WorkerScript {get;set;}="";}
}

internal static class SmokeHarness
{
    public static bool Failed {get;private set;}
    public static async Task RunAsync(MainWindow window,AppServices services,string output)
    {
        if(File.Exists(Path.Combine(output,"x-login-guidance-probe"))){try{await XLoginGuidanceHarness.RunAsync(window,services,output);}catch(Exception e){File.WriteAllText(Path.Combine(output,"smoke-failure.txt"),e.ToString());Failed=true;}finally{window.Close();}return;}
        if(File.Exists(Path.Combine(output,"bridge-probe"))){try{await BridgeHarness.RunAsync(window,services,output);}catch(Exception e){File.WriteAllText(Path.Combine(output,"smoke-failure.txt"),e.ToString());Failed=true;}finally{window.Close();}return;}
        if(File.Exists(Path.Combine(output,"saved-folders-probe"))||File.Exists(Path.Combine(output,"saved-folders-rescan-probe"))){try{await SavedFoldersHarness.RunAsync(window,services,output);}catch(Exception e){File.WriteAllText(Path.Combine(output,"smoke-failure.txt"),e.ToString());Failed=true;}finally{window.Close();}return;}
        if(File.Exists(Path.Combine(output,"source-wait-probe"))){try{await ManualSourceWaitHarness.RunAsync(window,services,output);}catch(Exception e){File.WriteAllText(Path.Combine(output,"smoke-failure.txt"),e.ToString());Failed=true;}finally{window.Close();}return;}
        if(File.Exists(Path.Combine(output,"readiness-probe"))){try{await ReadinessHarness.RunAsync(window,services,output);}catch(Exception e){File.WriteAllText(Path.Combine(output,"smoke-failure.txt"),e.ToString());Failed=true;}finally{window.Close();}return;}
        if(File.Exists(Path.Combine(output,"telegram-qr-probe"))){try{await TelegramQrHarness.RunAsync(window,services,output);}catch(Exception e){File.WriteAllText(Path.Combine(output,"smoke-failure.txt"),e.ToString());Failed=true;}finally{window.Close();}return;}
        var observations=new Dictionary<string,object>();
        try
        {
            Directory.CreateDirectory(output);var fixture=services.Fixture!;
            var tallPath=Path.Combine(output,"synthetic-tall.png");var tallEncoder=new PngBitmapEncoder();tallEncoder.Frames.Add(BitmapFrame.Create(BitmapSource.Create(1,8192,96,96,PixelFormats.Bgra32,null,new byte[32768],4)));using(var tallFile=File.Create(tallPath))tallEncoder.Save(tallFile);
            var tall=MainWindow.DecodePreview(tallPath);Check(tall!=null && tall.PixelWidth<=160 && tall.PixelHeight<=100,"Extreme aspect preview exceeded decoded dimension bound");
            for(var i=0;i<3;i++)fixture.Thumbnails.Add(SyntheticThumbnail(i));
            await Idle();
            Check(!services.Hub.Enabled && fixture.Requests==0,"Idle launch admitted work");
            var process=Process.GetCurrentProcess();process.Refresh();observations["idleWorkingSetBytes"]=process.WorkingSet64;observations["idlePrivateBytes"]=process.PrivateMemorySize64;observations["pid"]=process.Id;observations["idleWorkerStarts"]=fixture.Requests;
            Capture(window,Path.Combine(output,"01-idle-1200.png"));
            window.SourceUrl.Text="https://x.com/fixtureAuthor";Click(window.ScanButton);await window.LastAction;Check(fixture.Requests==0,"Disabled scan ran");
            Click(window.MasterButton);await window.LastAction;Check(fixture.Requests==0,"Enabling started work");
            Click(window.ScanButton);await window.LastAction;await Idle();Check(window.Rows.Count==80,"Scan UI failed");
            Click(window.SelectNoneButton);Check(window.Rows.All(r=>!r.Selected),"Select none failed");window.Rows[0].Selected=true;
            Click(window.DownloadButton);await window.LastAction;Check(fixture.Transfers==2,"Selection transfer broadened");
            Click(window.DownloadButton);await window.LastAction;Check(fixture.Transfers==2,"Verified receipt skip failed");
            await Idle();Capture(window,Path.Combine(output,"02-workbench-1200.png"));
            window.Width=1000;window.Height=700;await Idle();Capture(window,Path.Combine(output,"03-workbench-1000.png"));window.Width=1200;window.Height=800;
            fixture.ScanCount=1200;Click(window.ScanButton);await window.LastAction;await Idle();
            window.PreviewGrid.ScrollIntoView(window.Rows[1100]);await Idle();
            var retained=window.Rows.Count(r=>r.Image!=null);Check(retained<=20,"Decoded images retained beyond viewport");observations["largeListItems"]=window.Rows.Count;observations["decodedImagesAfterScroll"]=retained;
            Capture(window,Path.Combine(output,"04-large-list.png"));
            window.Pages.SelectedIndex=2;await Idle();Capture(window,Path.Combine(output,"05-history.png"));
            window.Pages.SelectedIndex=3;window.OutputFolder.Text=Path.Combine(output,"chosen-output");Click(window.SaveSettingsButton);await window.LastAction;Check(services.Settings.DownloadRoot==Path.GetFullPath(window.OutputFolder.Text),"Settings handler failed");await Idle();Capture(window,Path.Combine(output,"06-settings.png"));
            window.Pages.SelectedIndex=1;window.LoginPlatform.SelectedIndex=1;Click(window.LoginButton);var login=window.LastAction;await WaitUntil(()=>window.SecretInput.IsVisible);
            Check(window.PhoneInput.Visibility==Visibility.Collapsed,"Telegram code was not masked");
            window.LoginPlatform.SelectedIndex=2;Check(!window.SecretInput.IsVisible&&!window.ResendCodeButton.IsEnabled,"Other platform exposed Telegram input");
            window.LoginPlatform.SelectedIndex=1;Check(window.SecretInput.IsVisible,"Returning to Telegram lost its current prompt");
            await WaitUntil(()=>window.ResendCodeButton.IsEnabled);Click(window.ResendCodeButton);await window.LastAction;await WaitUntil(()=>services.Fixture!.Resends==1&&window.SecretInput.IsVisible);Check(window.ActionMessage.Text.Contains("Telegram")&&window.ActionMessage.Text.Contains("剩余 2"),"Delivery/resend state missing");window.SecretInput.Password="SYNTHETIC-NOT-A-CREDENTIAL";Capture(window,Path.Combine(output,"07-masked-login.png"));Click(window.SubmitInputButton);await window.LastAction;await login;Check(window.SecretInput.Password=="","Input not cleared");
            Check(window.ActionMessage.Text.Contains("本次登录已确认"),"Completed login retained an obsolete action prompt");
            window.LoginPlatform.SelectedIndex=2;Check(!window.ActionMessage.Text.Contains("Telegram")&&!window.FinishLoginButton.IsEnabled,"Platform switch retained another platform's prompt");
            window.LoginPlatform.SelectedIndex=0;Click(window.LoginButton);login=window.LastAction;await WaitUntil(()=>window.FinishLoginButton.IsEnabled);
            window.LoginPlatform.SelectedIndex=2;Check(!window.FinishLoginButton.IsEnabled,"Other platform exposed active login control");window.LoginPlatform.SelectedIndex=0;Check(window.FinishLoginButton.IsEnabled,"Returning to active login lost its control");
            Click(window.FinishLoginButton);await window.LastAction;await login;
            observations["usedRealXLoginAdapter"]=fixture.UsedRealXLoginAdapter;
            if(File.Exists(Path.Combine(output,"x-login-worker-config.json")))Check(fixture.UsedRealXLoginAdapter,"Real X login adapter fixture was not consumed");
            var report=services.ExportReport();Check(!report.Contains("SYNTHETIC-NOT-A-CREDENTIAL") && !report.Contains("https://") && !report.Contains("fixtureAccount"),"Report leaked private values");File.WriteAllText(Path.Combine(output,"sanitized-report.json"),report);
            var webp=Path.Combine(output,"synthetic.webp");File.WriteAllBytes(webp,Convert.FromBase64String("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"));var decoded=MainWindow.DecodePreview(webp);Check(decoded!=null,"System WebP decode unavailable");observations["webpDecode"]=new{decoded!.PixelWidth,decoded.PixelHeight};
            // ActiveCount is set before the worker is entered. Wait for the
            // fixture's blocking request acknowledgement before sampling its
            // request count, otherwise that active request can look like a
            // queued request admitted after OFF.
            fixture.BlockNext=true;window.Pages.SelectedIndex=0;Click(window.ScanButton);var blocked=window.LastAction;await WaitUntil(()=>services.Hub.ActiveCount==1&&!fixture.BlockNext);var pending=services.Repository.CreateJob(new(){Platform="douyin",Url="https://www.douyin.com/user/fixture",Kind="profile"},services.Settings.DownloadRoot);var queued=services.Hub.Submit(pending.Id,"scan");var before=fixture.Requests;
            Click(window.MasterButton);await window.LastAction;await Task.WhenAll(blocked,queued);observations["offBeforeWorkerRequests"]=before;observations["offAfterWorkerRequests"]=fixture.Requests;Check(fixture.Requests==before && services.Hub.PendingCount==0 && services.Hub.ActiveCount==0,"Off admitted queued task");Check(services.Repository.GetJob(pending.Id)!.Status=="paused","Queued task not persisted paused");
            observations["finalActiveOperations"]=services.Hub.ActiveCount;observations["finalActivePreviews"]=services.Previews.ActiveCount;observations["browserDataBytes"]=MainWindow.MeasureTree(Path.Combine(services.DataRoot,"private","browser"));observations["thumbnailCacheBytes"]=services.Previews.CachedBytes;observations["status"]="PASS — offline fixtures only";
            File.WriteAllText(Path.Combine(output,"smoke-result.json"),JsonSerializer.Serialize(observations,new JsonSerializerOptions{WriteIndented=true}));
        }
        catch(Exception e){File.WriteAllText(Path.Combine(output,"smoke-failure.txt"),e.ToString());Failed=true;}
        finally{window.Close();}
    }
    static void Click(Button button)=>button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    static async Task Idle(){await Dispatcher.Yield(DispatcherPriority.ApplicationIdle);await Task.Delay(500);await Dispatcher.Yield(DispatcherPriority.ApplicationIdle);}
    static async Task WaitUntil(Func<bool> condition){var deadline=DateTime.UtcNow.AddSeconds(10);while(!condition()){if(DateTime.UtcNow>deadline)throw new TimeoutException("Fixture UI wait timed out");await Task.Delay(50);}}
    internal static void Capture(Window window,string path)
    {
        window.UpdateLayout();var image=new RenderTargetBitmap((int)window.ActualWidth,(int)window.ActualHeight,96,96,PixelFormats.Pbgra32);image.Render(window);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(image));using var stream=File.Create(path);encoder.Save(stream);
    }
    static string SyntheticThumbnail(int variant)
    {
        var visual=new DrawingVisual();using(var drawing=visual.RenderOpen())
        {
            var sky=new[]{Color.FromRgb(169,205,213),Color.FromRgb(218,190,153),Color.FromRgb(154,185,171)}[variant];drawing.DrawRectangle(new SolidColorBrush(sky),null,new Rect(0,0,160,100));drawing.DrawEllipse(Brushes.LemonChiffon,null,new Point(124,23),12,12);
            var mountain=new StreamGeometry();using(var g=mountain.Open()){g.BeginFigure(new Point(0,80),true,true);g.LineTo(new Point(48,22),true,false);g.LineTo(new Point(94,80),true,false);g.LineTo(new Point(122,45),true,false);g.LineTo(new Point(160,80),true,false);g.LineTo(new Point(160,100),true,false);g.LineTo(new Point(0,100),true,false);}drawing.DrawGeometry(new SolidColorBrush(Color.FromRgb(61,110,113)),null,mountain);drawing.DrawRectangle(new SolidColorBrush(Color.FromRgb(224,231,213)),null,new Rect(0,82,160,18));
        }
        var bitmap=new RenderTargetBitmap(160,100,96,96,PixelFormats.Pbgra32);bitmap.Render(visual);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using var data=new MemoryStream();encoder.Save(data);return "data:image/png;base64,"+Convert.ToBase64String(data.ToArray());
    }
}
