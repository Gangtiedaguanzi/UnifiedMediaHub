using System.IO;
using System.Windows;
using System.Windows.Media.Imaging;
using UnifiedMediaHub.Core;
namespace UnifiedMediaHub.App;
public partial class MainWindow
{
 string? qrAttemptJob;long qrExpires;bool qrDisplayed;
 void LoginQr_Click(object sender,RoutedEventArgs e)=>Start(async()=>{
  RequireEnabled();if(Choice(LoginPlatform)!="telegram"||services.Hub.ActiveCount!=0||services.Hub.PendingCount!=0)throw new InvalidOperationException("请先停止当前任务，再扫码登录 Telegram。");
  ClearQr();ClearInput();var job=services.Repository.CreateJob(new(){Platform="telegram",Kind="profile",Url="https://t.me/",Label="手动登录"},services.Settings.DownloadRoot);qrAttemptJob=job.Id;
  ActionMessage.Text="正在请求本次登录二维码，请稍候。";
  try{var login=services.Hub.Submit(job.Id,"loginQr");RefreshCounts();await login;}finally{if(qrAttemptJob==job.Id)ClearQr();}
  var result=services.Repository.GetJob(job.Id)!;platformActions["telegram"]=(job.Id,new(){Type="complete",Status=result.Status,ReasonCode=result.ReasonCode},DateTimeOffset.UtcNow);RefreshLoginAction();RefreshAccount();
 });
 void ShowQr(string id,WorkerEvent e){
  try{
   if(closing||id!=qrAttemptJob||qrDisplayed||!services.Hub.Enabled||services.Hub.ActiveJobId!=id||Choice(LoginPlatform)!="telegram"||e.QrCode==null)return;
   var bytes=e.QrCode.DecodeValidated(DateTimeOffset.UtcNow);
   try{using var stream=new MemoryStream(bytes,false);var image=new BitmapImage();image.BeginInit();image.CacheOption=BitmapCacheOption.OnLoad;image.StreamSource=stream;image.DecodePixelWidth=320;image.DecodePixelHeight=320;image.EndInit();image.Freeze();LoginQrImage.Source=image;}
   finally{Array.Clear(bytes);}
   qrExpires=e.QrCode.ExpiresAtUnix;qrDisplayed=true;ClearInput();FinishLoginButton.IsEnabled=false;ContinueButton.IsEnabled=false;LoginQrPanel.Visibility=Visibility.Visible;
   ActionMessage.Text="请在手机 Telegram 中批准本次登录。";RefreshQr();
  }catch{ClearQr();StatusLine.Text="登录二维码无效，本次操作已停止。";_ = Guard(()=>services.Hub.StopJobAsync(id));}
  finally{e.QrCode=null;}
 }
 void ClearQr(){qrAttemptJob=null;qrExpires=0;qrDisplayed=false;if(LoginQrImage!=null)LoginQrImage.Source=null;if(LoginQrPanel!=null)LoginQrPanel.Visibility=Visibility.Collapsed;if(LoginQrCountdown!=null)LoginQrCountdown.Text="";}
 void RefreshQr(){
  if(LoginQrButton==null)return;
  var platform=Choice(LoginPlatform);var telegram=platform=="telegram";
  LoginQrButton.Visibility=telegram?Visibility.Visible:Visibility.Collapsed;
  LoginButton.Content=telegram?"手机号登录":"打开专用登录";
  LoginMethodHint.Visibility=telegram?Visibility.Visible:Visibility.Collapsed;
  var available=services.Hub.Enabled&&services.Hub.ActiveCount==0&&services.Hub.PendingCount==0;
  LoginButton.IsEnabled=LoginQrButton.IsEnabled=available;
  if(!services.Hub.Enabled)LoginAvailabilityHint.Text="总开关已关闭。请先开启总开关，再手动选择登录方式。";
  else if(available)LoginAvailabilityHint.Text=telegram?"当前可登录：请选择手机号登录或扫码登录。只有点击登录入口才会开始操作。":"当前可登录：点击“打开专用登录”开始操作。";
  else{
   var active=services.Hub.ActiveJobId is string id?services.Repository.GetJob(id)?.Source.Platform:null;
   var queued=services.Hub.QueueSnapshot.Select(q=>services.Repository.GetJob(q.JobId)?.Source.Platform).Where(p=>p!=null).Distinct().ToArray();
   if((active==null||active==platform)&&queued.All(p=>p==platform))LoginAvailabilityHint.Text=$"{UserText.Platform(platform)} 有运行或排队任务。如需选择登录方式，请先点击“停止该平台”，等待自有操作和排队均为 0，再选择所需登录方式。";
   else{
    var busy=active==null?"当前有排队任务":$"{UserText.Platform(active)} 正在运行任务";
    if(queued.Length>0)busy+="；排队平台："+string.Join("、",queued.Select(p=>UserText.Platform(p!)));
    LoginAvailabilityHint.Text=busy+"。请等待任务结束，或选择对应平台点击“停止该平台” / 到“历史”页停止相应任务及排队。自有操作和排队均为 0 后才能登录；只停止当前所选平台不会清除其他平台任务。";
   }
  }
  if(qrAttemptJob==null)return;
  if(!services.Hub.Enabled||Choice(LoginPlatform)!="telegram"||(services.Hub.ActiveJobId!=qrAttemptJob&&qrDisplayed)){ClearQr();return;}
  if(qrDisplayed){var remaining=qrExpires-DateTimeOffset.UtcNow.ToUnixTimeSeconds();if(remaining<=0){ClearQr();ActionMessage.Text=UserText.Error("qr_expired");return;}LoginQrCountdown.Text=$"本张二维码剩余 {remaining} 秒 · 过期后需手动重新扫码登录";}
 }
}
