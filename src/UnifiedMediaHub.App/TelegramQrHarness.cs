using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using UnifiedMediaHub.Core;
namespace UnifiedMediaHub.App;
internal static class TelegramQrHarness
{
 public static async Task RunAsync(MainWindow w,AppServices s,string output){
  var f=s.Fixture!;w.Pages.SelectedIndex=1;w.LoginPlatform.SelectedIndex=1;await Idle();Entries(w,false,"platform selected before master enable");
  Check(f.Requests==0,"platform selection started a worker");Click(w.MasterButton);await w.LastAction;await Idle();Entries(w,true,"enabled idle");Check(f.Requests==0,"master enable started a worker");
  Click(w.MasterButton);await w.LastAction;w.LoginPlatform.SelectedIndex=0;Click(w.MasterButton);await w.LastAction;w.LoginPlatform.SelectedIndex=1;await Idle();Entries(w,true,"master enabled before platform selection");Check(f.Requests==0,"enable/selection order started a worker");
  Click(w.LoginButton);var phone=w.LastAction;await Wait(()=>s.Hub.AwaitingInput&&w.InputPanel.IsVisible);await Idle();Entries(w,false,"phone login active");
  var prompt=w.ActionMessage.Text;var label=w.InputLabel.Text;w.SecretInput.Password="SYNTHETIC-UNSUBMITTED";await Idle();Check(w.InputPanel.IsVisible&&w.ActionMessage.Text==prompt&&w.InputLabel.Text==label&&w.SecretInput.Password=="SYNTHETIC-UNSUBMITTED","availability refresh replaced active input");
  Capture(w,Path.Combine(output,"synthetic-phone-busy.png"));Click(w.StopPlatformButton);await w.LastAction;await phone;await Idle();Entries(w,true,"phone login stopped");
  var other=s.Repository.CreateJob(new(){Platform="x",Kind="profile",Url="https://x.com/",Label="手动登录"},s.Settings.DownloadRoot);var active=s.Hub.Submit(other.Id,"login");await Wait(()=>s.Hub.ActiveJobId==other.Id&&s.Hub.AwaitingInput);
  var queued=s.Repository.CreateJob(new(){Platform="douyin",Kind="profile",Url="https://www.douyin.com/user/fixture"},s.Settings.DownloadRoot);var pending=s.Hub.Submit(queued.Id,"scan");await Idle();Check(s.Hub.PendingCount==1,"other-platform work not queued");Entries(w,false,"other-platform active and queued");Capture(w,Path.Combine(output,"synthetic-other-platform-busy.png"));
  Click(w.StopPlatformButton);await w.LastAction;await Idle();Check(s.Hub.ActiveJobId==other.Id&&s.Hub.PendingCount==1,"stopping selected platform cleared other work");Entries(w,false,"unrelated platform stop");
  await s.Hub.StopJobAsync(queued.Id);await pending;await Idle();Entries(w,false,"other-platform active after queue cleared");await s.Hub.StopJobAsync(other.Id);await active;await Idle();Entries(w,true,"all other work cleared");
  Capture(w,Path.Combine(output,"synthetic-login-idle.png"));
  foreach(var mode in new[]{"switch","stop","expiry","2fa","complete","off"}){
   if(!s.Hub.Enabled){Click(w.MasterButton);await w.LastAction;}w.LoginPlatform.SelectedIndex=1;await Idle();Entries(w,true,$"before QR {mode}");f.QrFixtureMode=mode;
   Click(w.LoginQrButton);var task=w.LastAction;await Wait(()=>w.LoginQrImage.Source!=null);Check(!s.Hub.AwaitingInput&&!w.InputPanel.IsVisible,"QR wait exposed input");
   if(mode=="switch"){w.Width=1200;await Idle();Capture(w,Path.Combine(output,"synthetic-qr-1200.png"));w.Width=1000;await Idle();Capture(w,Path.Combine(output,"synthetic-qr-1000.png"));w.LoginPlatform.SelectedIndex=2;Check(w.LoginQrImage.Source==null,"switch retained image");w.LoginPlatform.SelectedIndex=1;Check(w.LoginQrImage.Source==null,"switch restored retired image");Click(w.StopPlatformButton);await w.LastAction;}
   if(mode=="stop"){Click(w.StopPlatformButton);await w.LastAction;}
   if(mode=="expiry")await Wait(()=>w.LoginQrImage.Source==null);
   if(mode is "2fa" or "complete"){await f.SendControlAsync(new{command="fixture-approve"});if(mode=="2fa"){await Wait(()=>w.SecretInput.IsVisible);Check(w.LoginQrImage.Source==null,"2FA retained image");w.SecretInput.Password="SYNTHETIC-QR-PASSWORD";Click(w.SubmitInputButton);await w.LastAction;}}
   if(mode=="off"){Click(w.MasterButton);await w.LastAction;}
   await task;await Idle();Check(w.LoginQrImage.Source==null&&w.LoginQrPanel.Visibility==Visibility.Collapsed,"terminal retained QR");Entries(w,mode!="off",$"after QR {mode}");
  }
  var report=s.ExportReport();Check(!report.Contains("PngBase64",StringComparison.OrdinalIgnoreCase)&&!report.Contains("SYNTHETIC-QR-PASSWORD"),"QR persisted in report");
  File.WriteAllText(Path.Combine(output,"qr-smoke-result.json"),JsonSerializer.Serialize(new{status="PASS",fixture="synthetic only; no Telegram requests",cases=new[]{"both-enable-selection-orders-zero-worker","off-idle-both-disabled","idle-both-enabled","phone-blocks-both-and-preserves-input","phone-stop-recovers-both","other-platform-active-and-queue-gate","unrelated-stop-keeps-gate","all-work-cleared-recovers","switch-no-redisplay","stop","expiry","2fa","complete","master-off","terminal-entry-recovery"},widths=new[]{1000,1200},active=s.Hub.ActiveCount,pending=s.Hub.PendingCount,requests=f.Requests}));
 }
 public static LoginQrCode SyntheticQr(int seconds){var pixels=new byte[320*320*4];for(int y=0;y<320;y++)for(int x=0;x<320;x++){var p=(y*320+x)*4;byte c=(byte)(((x/16+y/16)%2==0)?0:255);pixels[p]=pixels[p+1]=pixels[p+2]=c;pixels[p+3]=255;}var image=BitmapSource.Create(320,320,96,96,PixelFormats.Bgra32,null,pixels,1280);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(image));using var stream=new MemoryStream();encoder.Save(stream);return new(){PngBase64=Convert.ToBase64String(stream.ToArray()),ExpiresAtUnix=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+seconds};}
 static void Entries(MainWindow w,bool enabled,string state){Check(w.LoginButton.IsVisible&&w.LoginQrButton.IsVisible,$"login entries hidden: {state}");Check(w.LoginButton.IsEnabled==enabled,$"ordinary login availability: {state}");Check(w.LoginQrButton.IsEnabled==enabled,$"QR login availability: {state}");}
 static void Click(Button b){Check(b.IsVisible&&b.IsEnabled,$"cannot click hidden/disabled entry: {b.Name}");b.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));}
 static void Check(bool ok,string message){if(!ok)throw new InvalidOperationException(message);}
 static async Task Idle(){await Dispatcher.Yield(DispatcherPriority.ApplicationIdle);await Task.Delay(450);}
 static async Task Wait(Func<bool> predicate){var end=DateTime.UtcNow.AddSeconds(10);while(!predicate()){if(DateTime.UtcNow>end)throw new TimeoutException("QR fixture wait");await Task.Delay(50);}}
 static void Capture(Window w,string path){w.UpdateLayout();var image=new RenderTargetBitmap((int)w.ActualWidth,(int)w.ActualHeight,96,96,PixelFormats.Pbgra32);image.Render(w);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(image));using var stream=File.Create(path);encoder.Save(stream);}
}
