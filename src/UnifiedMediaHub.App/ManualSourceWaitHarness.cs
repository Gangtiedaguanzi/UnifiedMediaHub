using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using UnifiedMediaHub.Core;

namespace UnifiedMediaHub.App;

// Offline, isolated --smoke-test mode: exercises real WPF controls, never account sessions.
internal static class ManualSourceWaitHarness
{
    internal static async Task RunAsync(MainWindow window,AppServices services,string output)
    {
        static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
        static void Click(Button button)=>button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        static async Task Wait(Func<bool> predicate){var end=DateTime.UtcNow.AddSeconds(10);while(!predicate()){if(DateTime.UtcNow>end)throw new TimeoutException("Synthetic source wait did not settle");await Task.Delay(40);}}
        var fixture=services.Fixture!;fixture.ScanCount=0;fixture.ScanActionMode="continue";
        await Task.Delay(450);Check(!services.Hub.Enabled&&fixture.Requests==0,"Idle launch started work");
        Click(window.MasterButton);await window.LastAction;window.Pages.SelectedIndex=1;window.LoginPlatform.SelectedIndex=2;
        HubJob Job()=>services.Repository.CreateJob(new(){Platform="douyin",Kind="saved",Url="https://www.douyin.com/user/self",AccountId="fixtureAccount"},services.Settings.DownloadRoot);
        var first=Job();var work=services.Hub.Submit(first.Id,"scan");
        await Wait(()=>services.Hub.AwaitingInput);await Task.Delay(450);
        Check(window.ContinueButton.IsEnabled,"Active source-tab wait cannot be continued through WPF");
        Check(!window.FinishLoginButton.IsEnabled,"Source wait incorrectly asks for login confirmation");
        window.UpdateLayout();var bitmap=new RenderTargetBitmap((int)window.ActualWidth,(int)window.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(window);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var stream=File.Create(Path.Combine(output,"synthetic-source-wait.png")))encoder.Save(stream);
        window.LoginPlatform.SelectedIndex=0;Check(!window.ContinueButton.IsEnabled,"Wrong platform can continue another source");
        window.LoginPlatform.SelectedIndex=2;Check(window.ContinueButton.IsEnabled,"Switching back loses current wait");
        Check(fixture.Requests==1&&fixture.Continues==0,"Selection silently continued or started work");
        Click(window.ContinueButton);await window.LastAction;await work;await Task.Delay(450);
        Check(fixture.Continues==1&&!window.ContinueButton.IsEnabled&&!services.Hub.AwaitingInput,"Continue did not retire exactly once");
        Check(services.Repository.GetJob(first.Id)!.Status=="completed","Continued scan did not complete");

        fixture.ScanActionMode="expiry";var expired=Job();work=services.Hub.Submit(expired.Id,"scan");
        await Wait(()=>services.Hub.AwaitingInput);await work;await Task.Delay(450);
        var ended=services.Repository.GetJob(expired.Id)!;
        Check(ended.Status=="needs_action"&&ended.ReasonCode=="manual_wait_timeout","Manual expiry lost durable reason");
        Check(!window.ContinueButton.IsEnabled&&!services.Hub.AwaitingInput&&services.Hub.ActiveCount==0,"Terminal manual expiry still accepts input");
        Check(fixture.Requests==2&&fixture.Continues==1,"Expiry retried or continued automatically");

        fixture.ScanActionMode="continue";var cancelled=Job();work=services.Hub.Submit(cancelled.Id,"scan");
        await Wait(()=>services.Hub.AwaitingInput);Click(window.MasterButton);await window.LastAction;await work;await Task.Delay(450);
        Check(!services.Hub.Enabled&&services.Hub.ActiveCount==0&&!window.ContinueButton.IsEnabled,"Master off left an active source wait");
        Check(services.Repository.GetJob(cancelled.Id)!.Status=="paused"&&fixture.Requests==3&&fixture.Continues==1,"Cancellation resumed work");
        File.WriteAllText(Path.Combine(output,"source-wait-result.json"),JsonSerializer.Serialize(new{status="PASS",synthetic=true,requests=fixture.Requests,continues=fixture.Continues,activeContinue=true,platformScoped=true,manualTimeout=ended.ReasonCode,masterOffCancels=true},new JsonSerializerOptions{WriteIndented=true}));
    }
}
