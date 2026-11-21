using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace UnifiedMediaHub.App;

internal static class XLoginGuidanceHarness
{
    public static async Task RunAsync(MainWindow window,AppServices services,string output)
    {
        var checks=new List<string>();
        void Check(bool ok,string name){if(!ok)throw new InvalidOperationException(name);checks.Add(name);}
        void Click(Button button)=>button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        async Task Until(Func<bool> fn){var end=DateTime.UtcNow.AddSeconds(10);while(!fn()){if(DateTime.UtcNow>end)throw new TimeoutException();await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.ApplicationIdle);await Task.Delay(25);}}
        Click(window.MasterButton);await window.LastAction;window.Pages.SelectedIndex=1;window.LoginPlatform.SelectedIndex=0;
        services.Fixture!.FailXLogin=true;
        Click(window.LoginButton);var login=window.LastAction;await Until(()=>window.FinishLoginButton.IsEnabled);
        Check(window.ActionMessage.Text=="在打开的浏览器里登录 X，完成后点'我已完成登录'或直接关闭该窗口。","X pending login shows ordinary-window instructions");
        SmokeHarness.Capture(window,Path.Combine(output,"x-login-waiting.png"));
        Click(window.FinishLoginButton);await window.LastAction;await login;await Until(()=>services.Hub.ActiveCount==0);
        Check(window.ActionMessage.Text.Contains("没有检测到 X 登录。若推特一直停在'确认你的帐户'，可能是推特的风控，请稍后再试，或先在常用浏览器里完成验证。"),"X failed verification explains uncertainty and manual retry");
        Check(!window.FinishLoginButton.IsEnabled&&window.LoginButton.IsEnabled,"failed login retires finish and permits a new attempt");
        SmokeHarness.Capture(window,Path.Combine(output,"x-login-failed.png"));
        services.Fixture.FailXLogin=false;Click(window.LoginButton);login=window.LastAction;await Until(()=>window.FinishLoginButton.IsEnabled);
        Click(window.FinishLoginButton);await window.LastAction;await login;
        Check(window.ActionMessage.Text.Contains("本次登录已确认"),"retry can confirm synthetic account");
        Check(window.StatusLine.Text.Contains("本次登录已确认")&&!window.StatusLine.Text.Contains("完成后点"),"status line leaves the waiting prompt once login is confirmed");
        window.LoginPlatform.SelectedIndex=2;Click(window.LoginButton);login=window.LastAction;await Until(()=>window.FinishLoginButton.IsEnabled);
        Check(!window.ActionMessage.Text.Contains("推特")&&!window.ActionMessage.Text.Contains("直接关闭"),"Douyin retains its existing prompt");
        Click(window.StopPlatformButton);await window.LastAction;await login;
        Click(window.MasterButton);await window.LastAction;
        Check(services.Hub.ActiveCount==0&&services.Hub.PendingCount==0,"off leaves no operations");
        File.WriteAllText(Path.Combine(output,"x-login-guidance-result.json"),JsonSerializer.Serialize(new{passed=true,synthetic=true,checks},new JsonSerializerOptions{WriteIndented=true}));
    }
}
