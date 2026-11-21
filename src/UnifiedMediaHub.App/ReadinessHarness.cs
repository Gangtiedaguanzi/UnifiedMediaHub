using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using UnifiedMediaHub.Core;

namespace UnifiedMediaHub.App;

// Explicit --smoke-test fixture only. No platform request or real credentials.
internal static class ReadinessHarness
{
    internal static async Task RunAsync(MainWindow window,AppServices services,string output)
    {
        var evidence=new Dictionary<string,object>();var failures=new List<string>();
        void Check(bool condition,string message){if(!condition)failures.Add(message);}
        static void Click(Button b)=>b.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        async Task Wait(Func<bool> predicate){var deadline=DateTime.UtcNow.AddSeconds(12);while(!predicate()){if(DateTime.UtcNow>deadline)throw new TimeoutException("Synthetic readiness UI wait");await Task.Delay(40);}}
        await Task.Delay(450);Check(!services.Hub.Enabled&&services.Fixture!.Requests==0,"Idle launch started work");
        Click(window.MasterButton);await window.LastAction;
        var fixture=services.Fixture!;fixture.CodeTimeoutSeconds=2;
        window.Pages.SelectedIndex=1;window.LoginPlatform.SelectedIndex=1;Click(window.LoginButton);var login=window.LastAction;
        await Wait(()=>window.SecretInput.IsVisible);var initialRequests=fixture.Requests;
        Check(!window.ResendCodeButton.IsEnabled,"Nonzero timeout allowed early resend");
        window.LoginPlatform.SelectedIndex=2;await Task.Delay(2200);var switched=Stopwatch.StartNew();window.LoginPlatform.SelectedIndex=1;
        await Task.Delay(400);Check(window.ResendCodeButton.IsEnabled,"Same prompt cooldown restarted after platform switch");
        evidence["samePromptResendEnabledAfterSwitchMs"]=switched.ElapsedMilliseconds;
        Check(fixture.Requests==initialRequests,"Platform selection created a login request");
        await Wait(()=>window.ResendCodeButton.IsEnabled);Click(window.ResendCodeButton);await window.LastAction;
        await Wait(()=>fixture.Resends==1&&window.SecretInput.IsVisible);Check(!window.ResendCodeButton.IsEnabled,"New prompt reused old elapsed time");
        window.SecretInput.Password="SYNTHETIC-READINESS";Click(window.SubmitInputButton);await window.LastAction;await login;
        Check(services.Hub.ActiveCount==0&&fixture.Resends==1,"Current nonce controls failed after switch");
        evidence["nonzeroTimeoutSeconds"]=fixture.CodeTimeoutSeconds;evidence["explicitResends"]=fixture.Resends;
        await Task.Delay(500); // Let the normal dirty refresh settle before setting layout-only fixtures.

        var items=new[]{new ContentItem{Platform="x",Key="x:1",ContentId="1",Title="合成样本：三项媒体，保留失败与待处理",MediaResolved=true,Media=[new(){Index=1,Kind="image"},new(){Index=2,Kind="image"},new(){Index=3,Kind="video"}]},new ContentItem{Platform="x",Key="x:2",ContentId="2",Title="合成样本：已跳过并检测字节重复",MediaResolved=true,Media=[new(){Index=1,Kind="image"}]},new ContentItem{Platform="x",Key="x:3",ContentId="3",Title="合成样本：媒体尚未解析，数量未知",MediaResolved=false}};
        var receipts=new[]{new DownloadReceipt{ContentKey="x:1",MediaIndex=1,Status="completed"},new DownloadReceipt{ContentKey="x:1",MediaIndex=2,Status="failed",ErrorCode="transfer_failed"},new DownloadReceipt{ContentKey="x:2",MediaIndex=1,Status="skipped",DuplicateOfContentKey="x:1",DuplicateOfMediaIndex=1}};
        var job=new HubJob{Id="synthetic-readiness",Source=new(){Platform="x",Kind="profile",Url="https://x.com/synthetic"},Status="needs_action",Completeness="partial",ReasonCode="disk_full",Message=UserText.Error("disk_full")};
        var rows=items.Select(i=>new PreviewRow(i,(_,_)=>{},receipts)).ToArray();
        window.Rows.Clear();foreach(var row in rows)window.Rows.Add(row);
        window.EmptyState.Visibility=Visibility.Collapsed;window.SelectionSummary.Text="已选择 3 / 3 项";
        window.DestinationLabel.Text="合成样本展示，不执行媒体下载";
        window.SourceLabel.Text="离线合成结果：含失败、待处理和未知媒体";
        window.ScanSummary.Text="示例仅用于布局验证";
        window.HistoryGrid.ItemsSource=new[]{new HistoryRow(job,items,receipts,[])};
        foreach(var width in new[]{1200d,1000d}){
            window.Width=width;window.Height=width==1000?700:800;window.Pages.SelectedIndex=0;await Task.Delay(450);window.UpdateLayout();
            foreach(var row in rows)CheckReadable(window.PreviewGrid,row,window.PreviewGrid.Columns.Count-1,$"Workbench {width}",Check);
            Capture(window,Path.Combine(output,$"workbench-unresolved-{width}.png"));
            window.PreviewGrid.ScrollIntoView(rows[0]);window.UpdateLayout();
            Capture(window,Path.Combine(output,$"workbench-{width}.png"));
            window.Pages.SelectedIndex=2;await Task.Delay(450);window.UpdateLayout();
            var history=window.HistoryGrid.Items[0];CheckReadable(window.HistoryGrid,history,window.HistoryGrid.Columns.Count-1,$"History {width}",Check);
            Capture(window,Path.Combine(output,$"history-{width}.png"));
        }
        window.Pages.SelectedIndex=0;window.Rows.Clear();for(var i=0;i<1200;i++)window.Rows.Add(new(new(){Platform="x",ContentId=i.ToString(),Key="x:"+i,Title="虚拟化合成样本",MediaResolved=true},(_,_)=>{},[]));
        window.PreviewGrid.ScrollIntoView(window.Rows[1100]);await Task.Delay(450);window.UpdateLayout();
        var realized=Enumerable.Range(0,window.Rows.Count).Count(i=>window.PreviewGrid.ItemContainerGenerator.ContainerFromIndex(i)!=null);
        Check(realized<=20,"Result wrapping disabled row virtualization");evidence["realizedRowsOf1200"]=realized;
        evidence["failures"]=failures;evidence["status"]=failures.Count==0?"PASS — offline readiness fixtures":"FAIL";
        File.WriteAllText(Path.Combine(output,"readiness-result.json"),JsonSerializer.Serialize(evidence,new JsonSerializerOptions{WriteIndented=true}));
        if(failures.Count>0)throw new InvalidOperationException(string.Join("; ",failures));
    }
    static void CheckReadable(DataGrid grid,object item,int column,string label,Action<bool,string> check)
    {
        grid.ScrollIntoView(item);grid.UpdateLayout();var text=grid.Columns[column].GetCellContent(item) as TextBlock;
        if(text==null){check(false,label+" result text missing");return;}
        DependencyObject? parent=text;while(parent!=null&&parent is not DataGridCell)parent=VisualTreeHelper.GetParent(parent);
        var cell=parent as DataGridCell;var padding=text.Padding;
        // A nonwrapping TextBlock can measure wider than its clipped cell.
        var width=Math.Max(1,Math.Min(text.ActualWidth,cell?.ActualWidth??0)-padding.Left-padding.Right);
        var height=Math.Min(text.ActualHeight,cell?.ActualHeight??0)-padding.Top-padding.Bottom;
        var formatted=new FormattedText(text.Text,CultureInfo.CurrentUICulture,text.FlowDirection,new Typeface(text.FontFamily,text.FontStyle,text.FontWeight,text.FontStretch),text.FontSize,text.Foreground,VisualTreeHelper.GetDpi(text).PixelsPerDip);
        if(text.TextWrapping!=TextWrapping.NoWrap)formatted.MaxTextWidth=width;
        check(formatted.WidthIncludingTrailingWhitespace<=width+2,label+" result width clipped");
        check(formatted.Height<=height+2,label+" result height clipped");
        check(text.TextTrimming==TextTrimming.None,label+" essential result trimmed");
    }
    static void Capture(Window window,string path){window.UpdateLayout();var bitmap=new RenderTargetBitmap((int)window.ActualWidth,(int)window.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(window);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using var stream=File.Create(path);encoder.Save(stream);}
}
