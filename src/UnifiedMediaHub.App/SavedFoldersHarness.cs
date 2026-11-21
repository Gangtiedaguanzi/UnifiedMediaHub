using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using UnifiedMediaHub.Core;

namespace UnifiedMediaHub.App;

// Invoked only by explicit --smoke-test and the saved-folders-probe marker.
internal static class SavedFoldersHarness
{
    internal static async Task RunAsync(MainWindow window,AppServices services,string output)
    {
        if(File.Exists(Path.Combine(output,"saved-folders-rescan-probe"))){await RescanAsync(window,services,output);return;}
        var fixture=services.Fixture!;var failures=new List<string>();
        void Check(bool ok,string message){if(!ok)failures.Add(message);}
        static void Click(Button button)=>button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        void OpenHistory(HubJob job)
        {
            var row=new HistoryRow(job,services.Repository.ListItems(job.Id),[],[]);
            window.HistoryGrid.ItemsSource=new[]{row};window.HistoryGrid.SelectedItem=row;
            window.HistoryGrid.RaiseEvent(new MouseButtonEventArgs(Mouse.PrimaryDevice,Environment.TickCount,MouseButton.Left){RoutedEvent=Control.MouseDoubleClickEvent});
        }
        async Task Wait(Func<bool> ready){var end=DateTime.UtcNow.AddSeconds(8);while(!ready()){if(DateTime.UtcNow>end)throw new TimeoutException("Offline folder UI fixture timed out.");await Task.Delay(30);}}
        services.Accounts.Add(new(){Platform="xiaohongshu",AccountId="fixtureAccount",DisplayName="离线合成账号"});
        services.Accounts.Add(new(){Platform="douyin",AccountId="fixtureAccount",DisplayName="离线合成账号"});
        await Task.Delay(400);Check(fixture.Requests==0,"Idle started an operation.");
        Click(window.MasterButton);await window.LastAction;window.SourcePlatform.SelectedIndex=2;
        Check(!window.FolderScanButton.IsEnabled,"Unselected directory enabled scan.");
        Click(window.FoldersButton);await window.LastAction;await Wait(()=>window.Folders.Items.Count==2);
        Check(fixture.Requests==1,"Directory started a child scan.");
        Check(window.Folders.SelectedIndex==-1&&!window.FolderScanButton.IsEnabled,"Directory automatically selected or scanned a folder.");
        var directory=services.Repository.ListJobs().Single();Check(directory.Source.Kind=="saved_folders"&&services.Repository.GetFolders(directory.Id).Count==2,"Directory did not persist its metadata.");
        var folders=window.Folders.Items.Cast<WorkerFolder>().ToArray();Check(folders[0].Title==folders[1].Title&&folders[0].Id!=folders[1].Id&&folders[0].ItemCount==null,"Same-name or unknown-count metadata lost.");
        window.Folders.SelectedIndex=1;await Wait(()=>window.FolderScanButton.IsEnabled);Check(fixture.Requests==1,"Selection started a scan automatically.");
        window.FolderScanLimit.Text="2";fixture.ScanCount=2;Click(window.FolderScanButton);await window.LastAction;await Task.Delay(450);
        var selected=services.Repository.ListJobs().Single(j=>j.Source.Kind=="saved_folder");
        Check(selected.Source.FolderId==folders[1].Id&&selected.Source.AccountId==directory.Source.AccountId&&selected.Source.Url==directory.Source.Url&&selected.Source.MaxItems==2,"Selected source changed folder or account scope.");
        Check(fixture.Requests==2&&services.Repository.ListItems(selected.Id).Count==2,"Explicit selected-folder scan failed.");
        Check(window.SourceLabel.Text.Contains(folders[1].Title),"Folder title not shown.");
        fixture.CaptureDownloadsOnly=true;
        Click(window.SelectNoneButton);Check(!window.DownloadButton.IsEnabled,"Empty selection enabled folder download.");
        window.Rows[1].Selected=true;var selectedKey=window.Rows[1].Item.Key;
        OpenHistory(services.Repository.GetJob(selected.Id)!);
        Check(window.DownloadButton.IsEnabled,"Selected XHS folder download remained disabled.");
        Click(window.DownloadButton);await window.LastAction;
        var download=fixture.CapturedDownloads.SingleOrDefault();
        Check(download!=null&&download.Source.Kind=="saved_folder"&&download.Source.Platform=="xiaohongshu"&&download.Source.FolderId==folders[1].Id&&download.Source.AccountId==directory.Source.AccountId&&download.Source.Url==directory.Source.Url,"History download lost folder/account/source binding.");
        Check(download?.Items?.Count==1&&download.Items[0].Key==selectedKey,"Download broadened beyond the one checked item.");
        Check(fixture.Transfers==0&&!Directory.Exists(Path.Combine(output,"fixture-downloads")),"Capture-only fixture transferred a file.");
        // A job message shows once, then a local notice (settings saved) must survive later refresh ticks.
        services.Repository.UpdateJob(selected.Id,"completed","已跳过 1 条不支持的消息。");OpenHistory(services.Repository.GetJob(selected.Id)!);await Task.Delay(800);
        Check(window.StatusLine.Text.Contains("已跳过 1 条不支持的消息"),"Job message was not shown on the status line.");
        Click(window.SaveSettingsButton);await window.LastAction;await Task.Delay(1200);
        Check(window.StatusLine.Text.Contains("已保存设置"),"Settings-saved notice was overwritten by the unchanged job message.");
        // Deliberately seed a stale directory membership to exercise the handler guard,
        // even when a selected row exists and a disabled button event is raised.
        services.Repository.UpsertItems(directory.Id,[new(){Platform="xiaohongshu",ContentId="guard",Key="xiaohongshu:guard",Selected=true}]);
        OpenHistory(services.Repository.GetJob(directory.Id)!);var beforeGuard=fixture.Requests;
        Check(!window.DownloadButton.IsEnabled,"Directory enabled download.");
        Click(window.DownloadButton);await window.LastAction;
        Check(fixture.Requests==beforeGuard&&window.StatusLine.Text.Contains("收藏夹目录不能下载"),"Directory download handler did not reject locally.");
        window.SourcePlatform.SelectedIndex=1;Check(window.Folders.Items.Count==0&&!window.FolderScanButton.IsEnabled,"Platform switch retained selection.");
        Click(window.FoldersButton);await window.LastAction;await Wait(()=>window.Folders.Items.Count==2);window.Folders.SelectedIndex=0;
        Check(!window.FolderScanButton.IsEnabled&&fixture.Requests==beforeGuard+1,"Unsupported Douyin member scan became enabled.");
        var dyDirectory=services.Repository.ListJobs().Single(j=>j.Source.Platform=="douyin");
        var dyFolder=services.Repository.CreateJob(SavedFolders.Select(dyDirectory.Source,services.Repository.GetFolders(dyDirectory.Id)[0]),services.Settings.DownloadRoot);
        services.Repository.UpsertItems(dyFolder.Id,[new(){Platform="douyin",ContentId="guard",Key="douyin:guard",Selected=true}]);
        OpenHistory(dyFolder);beforeGuard=fixture.Requests;
        Check(!window.DownloadButton.IsEnabled,"Douyin folder enabled download.");Click(window.DownloadButton);await window.LastAction;
        Check(fixture.Requests==beforeGuard&&window.StatusLine.Text.Contains("该平台收藏夹下载尚未接入"),"Douyin folder download handler did not reject locally.");
        Click(window.MasterButton);await window.LastAction;Check(services.Hub.ActiveCount==0&&services.Hub.PendingCount==0,"Disable left an operation active.");
        File.WriteAllText(Path.Combine(output,"saved-folders-ui.json"),JsonSerializer.Serialize(new{fixture="offline-only",checksPassed=failures.Count==0,requests=fixture.Requests,directoryCount=folders.Length,selectedWorks=2,downloadRequests=fixture.CapturedDownloads.Count,downloadItems=download?.Items?.Count??0,transfers=fixture.Transfers,failures},new JsonSerializerOptions{WriteIndented=true}));
        if(failures.Count>0)throw new InvalidOperationException(string.Join("; ",failures));
    }

    static async Task RescanAsync(MainWindow window,AppServices services,string output)
    {
        var failures=new List<string>();var dispatcherErrors=new List<string>();var fixture=services.Fixture!;
        void Check(bool ok,string message){if(!ok)failures.Add(message);}
        static void Click(Button button)=>button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        System.Windows.Threading.DispatcherUnhandledExceptionEventHandler trap=(_,e)=>{dispatcherErrors.Add(e.Exception.GetType().Name);e.Handled=true;};
        // Fixture-only capture converts an otherwise unhandled UI exception into a RED result.
        window.Dispatcher.UnhandledException+=trap;
        try
        {
            services.Accounts.Add(new(){Platform="douyin",AccountId="fixtureAccount",DisplayName="离线合成账号"});
            Click(window.MasterButton);await window.LastAction;window.SourcePlatform.SelectedIndex=1;
            Click(window.FoldersButton);await window.LastAction;await Task.Delay(450);
            var job=services.Repository.ListJobs().Single();services.Repository.SetScanLimit(job.Id,2);
            var oldRow=new HistoryRow(services.Repository.GetJob(job.Id)!,[],[],[]);
            window.HistoryGrid.ItemsSource=new[]{oldRow};window.HistoryGrid.SelectedItem=oldRow;
            Check(oldRow.Job.Source.MaxItems==2,"Fixture did not begin with the persisted old limit.");
            fixture.FolderCount=3;Click(window.RescanButton);await window.LastAction;await Task.Delay(500);
            Check(dispatcherErrors.Count==0,"Rescan raised an unhandled Dispatcher exception.");
            Check(window.Folders.Items.Count==3,"Rescan picker lost the third folder.");
            Check(services.Repository.GetJob(job.Id)!.Source.MaxItems==50&&services.Repository.GetFolders(job.Id).Count==3,"Rescan did not use the refreshed directory budget.");
            Check(fixture.Requests==2&&fixture.FolderLists==2&&services.Repository.ListJobs().Count==1&&services.Repository.ListItems(job.Id).Count==0,"Directory rescan started a member scan.");
            Click(window.MasterButton);await window.LastAction;
            Check(services.Hub.ActiveCount==0&&services.Hub.PendingCount==0,"Rescan fixture did not release operations.");
            File.WriteAllText(Path.Combine(output,"saved-folders-rescan-ui.json"),JsonSerializer.Serialize(new{fixture="offline-only",checksPassed=failures.Count==0,initialLimit=2,updatedLimit=50,visibleFolders=window.Folders.Items.Count,requests=fixture.Requests,directoryOperations=fixture.FolderLists,dispatcherErrors,failures},new JsonSerializerOptions{WriteIndented=true}));
            if(failures.Count>0)throw new InvalidOperationException(string.Join("; ",failures));
        }
        finally{window.Dispatcher.UnhandledException-=trap;}
    }
}
