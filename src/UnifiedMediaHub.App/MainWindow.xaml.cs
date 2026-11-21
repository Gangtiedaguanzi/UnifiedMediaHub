using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using UnifiedMediaHub.Core;

namespace UnifiedMediaHub.App;

public partial class MainWindow : Window
{
    readonly AppServices services;
    readonly DispatcherTimer refreshTimer;
    readonly Dictionary<DataGridRow,CancellationTokenSource> visibleRows=[];
    readonly Dictionary<string,(string JobId,WorkerEvent Event,DateTimeOffset Received)> platformActions=[];
    string? currentJobId, inputJobId;
    // Last job state written to the status line; the job message is re-applied only when it changes, so
    // a later local notice (settings saved, token copied) is not overwritten on the next refresh tick.
    string? statusKey;
    ResourceMetrics? historicalResources;
    string? resourceCacheKey;
    ScanCheckpoint? historicalScanProgress;
    string? scanProgressCacheKey;
    SourceRequest? chatIntent;
    readonly ChatDirectoryState chatDirectory=new();
    readonly SavedFolderPicker folderPicker=new();
    bool dirty=true,closed,closing;
    string? inputType,inputId; LoginDelivery? delivery; DateTimeOffset deliveryReceived;
    public ObservableCollection<PreviewRow> Rows {get;}=[];
    public Task LastAction {get;private set;}=Task.CompletedTask;
    public MainWindow(AppServices services)
    {
        this.services=services; InitializeComponent(); DataContext=this;Title += " · " + services.LoadedReleaseId;
        OutputFolder.Text=services.Settings.DownloadRoot; ScanLimit.Text=services.Settings.MaxScanItems.ToString(); FolderPerTaskBox.IsChecked=services.Settings.FolderPerTask;
        DestinationLabel.Text="保存到："+services.Settings.DownloadRoot; DataLocation.Text="已加载版本："+services.LoadedReleaseId+"\n本程序数据目录："+services.DataRoot;
        FixtureLabel.Text=services.Smoke?"离线合成样本 · 无真实账号或平台请求":"本地预览版本 · 部分来源仍在完善";
        InitializeBridge();
        services.Hub.Changed+=_=>dirty=true;
        services.Hub.Message+=(id,e)=>Dispatcher.BeginInvoke(()=>HandleMessage(id,e));
        refreshTimer=new DispatcherTimer(TimeSpan.FromMilliseconds(350),DispatcherPriority.Background,(_,_)=>{if(dirty){dirty=false;Refresh();}RefreshCounts();},Dispatcher);
        Closing+=OnClosing; Refresh();
    }
    void Start(Func<Task> action)=>LastAction=Guard(action);
    async Task Guard(Func<Task> action)
    {try{await action();}catch(Exception e)when(StorageFailure.IsFull(e)){services.Hub.ReportStorageFailure();StatusLine.Text=UserText.Error("disk_full");}catch(InvalidOperationException e){StatusLine.Text=e.Message;}catch(Exception){StatusLine.Text="操作未能完成。请检查目录权限、可用空间和组件是否齐全，再手动重试。";}finally{dirty=true;}}
    string Choice(ComboBox combo)=>(combo.SelectedItem as ComboBoxItem)?.Tag as string??"x";
    void RequireEnabled(){if(!services.Hub.Enabled)throw new InvalidOperationException("请先打开右上角的总开关，再开始操作。");}
    string NewCategory(){try{return CategoryName.Validate(CategoryInput.Text);}catch(ArgumentException e){throw new InvalidOperationException(e.Message);}}
    void Master_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        MasterButton.IsEnabled=false;
        try
        {
            if(services.Hub.Enabled)
            {ClearQr();ClearInput();var stop=services.Hub.DisableAsync();await Task.WhenAll(stop,services.Previews.StopAsync(),services.StopBridgeAsync());StatusLine.Text="已停止并释放全部自有操作与桥接监听。清单、登录和下载文件仍保留。";}
            else {services.Hub.Enable();await services.StartConfiguredBridgeAsync();StatusLine.Text="总开关已开启。请选择要登录、扫描或下载的来源。";}
        }
        finally{MasterButton.IsEnabled=true;RefreshCounts();}
    });
    void Paste_Click(object sender,RoutedEventArgs e)=>Start(()=>{if(Clipboard.ContainsText())SourceUrl.Text=Clipboard.GetText().Trim();return Task.CompletedTask;});
    void Scan_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        RequireEnabled();
        if(!SourceClassifier.TryClassify(SourceUrl.Text,out var source,out var error))throw new InvalidOperationException(error?.Any(c=>c>127)==true?error:"无法识别此链接。请使用平台的作品、作者主页或 Telegram 直接消息链接。");
        await NewScan(source!);
    });
    async Task NewScan(SourceRequest source,bool legacy=false)
    {
        if(!legacy&&source.Platform=="douyin"&&source.Kind is "profile" or "liked" or "saved"){ShowBridgeHint();return;}
        RequireEnabled();if(source.Kind!="saved_folder")source.MaxItems=services.Settings.MaxScanItems;
        if(source.Kind is "saved" or "liked")source.AccountId??=services.Account(source.Platform)?.AccountId;
        var job=services.Repository.CreateJob(source,services.Settings.DownloadRoot,NewCategory());currentJobId=job.Id;
        services.Previews.Enable();services.Previews.EnablePlatform(source.Platform);Pages.SelectedIndex=0;Rows.Clear();Refresh();
        await services.Hub.Submit(job.Id,"scan");Refresh();
    }
    void OwnSource_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        if(Choice(SourcePlatform)=="douyin"){ShowBridgeHint();return;}
        RequireEnabled();var platform=Choice(SourcePlatform);var kind=Choice(OwnKind);var account=services.Account(platform);
        if(account==null)throw new InvalidOperationException("请先到“账号”页手动登录此平台，确认账号后再扫描我的收藏或喜欢。");
        var url=platform switch {"x"=>kind=="saved"?"https://x.com/i/bookmarks":"https://x.com/i/likes","douyin"=>"https://www.douyin.com/user/"+Uri.EscapeDataString(account.AccountId),_=>"https://www.xiaohongshu.com/user/profile/"+Uri.EscapeDataString(account.AccountId)+"?tab="+(kind=="saved"?"fav":"liked")};
        await NewScan(new(){Platform=platform,Kind=kind,Url=url,AccountId=account.AccountId,Label=UserText.Kind(kind)});
    });
    void SourcePlatform_Changed(object sender,SelectionChangedEventArgs e)
    {if(FolderChooser==null)return;ClearFolderPicker();RefreshFolderPicker();ClearChatDirectory();RefreshBridgeUi();}
    void ClearFolderPicker(){folderPicker.Clear();Folders.Items.Clear();FolderChooser.Visibility=Visibility.Collapsed;FolderScanButton.IsEnabled=false;}
    void Folder_Changed(object sender,SelectionChangedEventArgs e){if(FolderScanButton!=null)RefreshFolderPicker();}
    static bool CanScanFolderMembers(string platform)=>platform=="xiaohongshu";
    static bool CanDownloadSource(SourceRequest? source)=>source!=null&&!ChatDirectoryState.IsDirectory(source)&&source.Kind!="saved_folders"&&(source.Kind!="saved_folder"||source.Platform=="xiaohongshu");
    void RefreshFolderPicker()
    {
        var platform=Choice(SourcePlatform);var account=services.Account(platform)?.AccountId;
        FoldersButton.IsEnabled=platform is "douyin" or "xiaohongshu";
        if(folderPicker.JobId!=null&&!folderPicker.Matches(platform,account)){ClearFolderPicker();return;}
        var supported=CanScanFolderMembers(platform);
        FolderScanButton.Content=supported?"扫描所选专辑":"收藏夹内容扫描待支持";
        FolderScanButton.IsEnabled=supported && services.Hub.Enabled && Folders.SelectedItem is WorkerFolder && folderPicker.Matches(platform,account) && services.Hub.ActiveJobId!=folderPicker.JobId && !services.Hub.QueueSnapshot.Any(q=>q.JobId==folderPicker.JobId);
        if(folderPicker.JobId is string id && services.Repository.GetJob(id) is HubJob job)
            FolderSummary.Text=$"共 {Folders.Items.Count} 个收藏夹 · "+UserText.Status(job.Status)+(job.ReasonCode==null?"":" · "+UserText.Error(job.ReasonCode))+(supported?"":" · 这个平台暂不支持读取收藏夹内容");
    }
    void ShowFolderDirectory(HubJob job)
    {
        folderPicker.Begin(job.Id,job.Source);Folders.Items.Clear();FolderScanLimit.Text="50";FolderChooser.Visibility=Visibility.Visible;ChatChooser.Visibility=Visibility.Collapsed;
        foreach(var folder in services.Repository.GetFolders(job.Id))AddFolder(job.Id,job.Source,folder);
        RefreshFolderPicker();
    }
    void AddFolder(string jobId,SourceRequest source,WorkerFolder folder)
    {
        if(!folderPicker.Accept(jobId,source,Choice(SourcePlatform),services.Account(Choice(SourcePlatform))?.AccountId,folder))return;
        var selected=(Folders.SelectedItem as WorkerFolder)?.Id;
        Folders.Items.Clear();foreach(var item in folderPicker.Folders)Folders.Items.Add(item);
        if(selected!=null)Folders.SelectedItem=Folders.Items.Cast<WorkerFolder>().FirstOrDefault(f=>f.Id==selected);
        RefreshFolderPicker();
    }
    void Folders_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        RequireEnabled();var platform=Choice(SourcePlatform);
        if(platform is not ("douyin" or "xiaohongshu"))throw new InvalidOperationException("此入口目前仅用于抖音收藏夹与小红书专辑。");
        var account=services.Account(platform)??throw new InvalidOperationException("请先在“账号”页确认此平台账号，再读取收藏夹目录。");
        var url=platform=="douyin"?"https://www.douyin.com/user/"+Uri.EscapeDataString(account.AccountId):"https://www.xiaohongshu.com/user/profile/"+Uri.EscapeDataString(account.AccountId)+"?tab=fav";
        var job=services.Repository.CreateJob(new(){Platform=platform,Kind="saved_folders",Url=url,AccountId=account.AccountId,Label="收藏夹目录",MaxItems=50},services.Settings.DownloadRoot,NewCategory());
        currentJobId=job.Id;Rows.Clear();Pages.SelectedIndex=0;ShowFolderDirectory(job);Refresh();
        await services.Hub.Submit(job.Id,"listFolders");Refresh();
    });
    void FolderScan_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        RequireEnabled();if(!CanScanFolderMembers(Choice(SourcePlatform)))throw new InvalidOperationException("该平台收藏夹内容扫描尚未支持；当前可读取目录。");
        if(!int.TryParse(FolderScanLimit.Text,out var limit)||limit<1||limit>50)throw new InvalidOperationException("专辑首批作品上限应为 1 至 50 的整数。");
        await NewScan(folderPicker.Select((Folders.SelectedItem as WorkerFolder)?.Id,Choice(SourcePlatform),services.Account(Choice(SourcePlatform))?.AccountId,limit));
    });
    void Chats_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        RequireEnabled();ClearChatDirectory();
        var source=ChatDirectoryState.Source(services.Account("telegram")?.AccountId);
        var job=services.Repository.CreateJob(source,services.Settings.DownloadRoot,NewCategory());
        await ReadChatDirectory(job);
    });
    async Task ReadChatDirectory(HubJob job)
    {
        ClearChatDirectory();
        if(!ChatDirectoryState.IsDirectory(job.Source)||job.Source.AccountId!=services.Account("telegram")?.AccountId)throw new InvalidOperationException("此目录绑定账号与当前账号不同，请点击“选择 Telegram 聊天”新建目录；不会重新绑定旧历史。");
        _=ChatDirectoryState.Source(job.Source.AccountId);
        services.Repository.SetScanLimit(job.Id,ChatDirectoryState.Limit);
        ChatChooser.Visibility=Visibility.Visible;FolderChooser.Visibility=Visibility.Collapsed;
        EmptyState.Visibility=Visibility.Collapsed;StatusLine.Text=$"正在读取 Telegram 聊天目录（含已归档，最多 {ChatDirectoryState.Limit} 个），不展开话题。聊天多时需要一两分钟。";
        chatIntent=SourceClassifier.TryClassify(SourceUrl.Text,out var linked,out _) && linked!.Platform=="telegram"?linked:null;
        chatDirectory.Begin(job.Id,job.Source.AccountId!);RefreshChatDirectory();
        await services.Hub.Submit(job.Id,"listChats");RefreshChatDirectory();
        var finished=services.Repository.GetJob(job.Id);
        StatusLine.Text=finished?.Status=="completed"?"本次聊天目录操作已结束，数量与范围见聊天选择区。":UserText.Error(finished?.ReasonCode??"operation_failed");
    }
    void Chat_Changed(object sender,SelectionChangedEventArgs e)
    {if(Topics==null)return;Topics.Items.Clear();RefreshChatDirectory();}
    void ClearChatDirectory(){chatDirectory.Clear();Chats.ItemsSource=null;Topics.Items.Clear();ChatChooser.Visibility=Visibility.Collapsed;ChatScanButton.IsEnabled=false;}
    void FillChats()
    {
        var query=ChatSearch.Text.Trim();var selected=(Chats.SelectedItem as WorkerChat)?.Id;
        var rows=chatDirectory.Chats.Where(c=>query.Length==0||c.Title.Contains(query,StringComparison.OrdinalIgnoreCase)||(c.Username?.Contains(query,StringComparison.OrdinalIgnoreCase)??false)).ToList();
        Chats.ItemsSource=rows;Chats.SelectedItem=rows.FirstOrDefault(c=>c.Id==selected)??rows.FirstOrDefault();
    }
    void ChatSearch_Changed(object sender,TextChangedEventArgs e){if(Chats!=null){FillChats();RefreshChatDirectory();}}
    void RefreshChatDirectory()
    {
        if(ChatScanButton==null)return;
        var account=services.Account("telegram")?.AccountId;
        if(chatDirectory.JobId!=null&&!chatDirectory.Matches(account)){ClearChatDirectory();return;}
        if(chatDirectory.JobId is string id&&services.Repository.GetJob(id) is HubJob job&&job.Status is "failed" or "paused" or "needs_action"&&services.Hub.ActiveJobId!=id)chatDirectory.Stop(job.Status);
        ChatScanButton.IsEnabled=services.Hub.Enabled&&chatDirectory.CanSelect((Chats.SelectedItem as WorkerChat)?.Id,account)&&services.Hub.ActiveJobId!=chatDirectory.JobId&&!services.Hub.QueueSnapshot.Any(q=>q.JobId==chatDirectory.JobId);
        ChatDirectorySummary.Text=$"共 {chatDirectory.Chats.Count} 个聊天"+(ChatSearch.Text.Trim().Length>0?$"，匹配 {Chats.Items.Count} 个":"")+" · "+(chatDirectory.Status=="running"?"正在读取":UserText.Status(chatDirectory.Status));
    }
    void ChatScan_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        RequireEnabled();if(Chats.SelectedItem is not WorkerChat chat)throw new InvalidOperationException("请先选择要扫描的聊天。");
        if(services.Hub.ActiveJobId==chatDirectory.JobId||services.Hub.QueueSnapshot.Any(q=>q.JobId==chatDirectory.JobId))throw new InvalidOperationException("请等待本次聊天目录结束。");
        chatIntent=null;
        if(!string.IsNullOrWhiteSpace(SourceUrl.Text))
        {
            if(!SourceClassifier.TryClassify(SourceUrl.Text,out var linked,out _)||linked!.Platform!="telegram")throw new InvalidOperationException("请清空链接，或粘贴 Telegram 聊天、话题或消息链接。");
            chatIntent=linked;
        }
        var source=chatDirectory.Select(chat.Id,services.Account("telegram")?.AccountId,chatIntent);
        ChatChooser.Visibility=Visibility.Collapsed;
        await NewScan(source);
    });
    void SelectAll_Click(object sender,RoutedEventArgs e){foreach(var row in Rows)row.Selected=true;RefreshSelection();}
    void SelectNone_Click(object sender,RoutedEventArgs e){foreach(var row in Rows)row.Selected=false;RefreshSelection();}
    void Download_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        RequireEnabled();if(currentJobId==null || !Rows.Any(r=>r.Selected))throw new InvalidOperationException("请先扫描清单并至少勾选一项。");
        var source=services.Repository.GetJob(currentJobId)?.Source;
        if(source?.Kind=="bridge")services.Repository.ReviewBridgeAccount(currentJobId,services.Account("douyin")?.AccountId);
        if(!CanDownloadSource(source))throw new InvalidOperationException(ChatDirectoryState.IsDirectory(source)?"聊天目录不能下载，请重新读取目录并选择聊天。":source?.Kind=="saved_folders"?"收藏夹目录不能下载；请先选择专辑并扫描作品。":"该平台收藏夹下载尚未接入；本次不会开始下载。");
        await services.Hub.Submit(currentJobId,"download");Refresh();
    });
    void Pause_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {if(currentJobId!=null){var job=services.Repository.GetJob(currentJobId)!;await Task.WhenAll(services.Hub.StopJobAsync(currentJobId),services.Previews.StopAsync(job.Source.Platform));}ClearInput();});
    void Author_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {if(PreviewGrid.SelectedItem is PreviewRow row && AuthorSources.TryGet(row.Item,out var source)){SourceUrl.Text=source!.Url;await NewScan(source);}});
    void Preview_SelectionChanged(object sender,SelectionChangedEventArgs e)=>AuthorButton.IsEnabled=PreviewGrid.SelectedItem is PreviewRow row && AuthorSources.TryGet(row.Item,out _);
    void Login_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        RequireEnabled();var platform=Choice(LoginPlatform);
        var url=platform switch{"x"=>"https://x.com/","telegram"=>"https://t.me/","douyin"=>"https://www.douyin.com/",_=>"https://www.xiaohongshu.com/"};
        var job=services.Repository.CreateJob(new(){Platform=platform,Kind="profile",Url=url,Label="手动登录"},services.Settings.DownloadRoot);
        ActionMessage.Text="正在打开本程序专用登录，请稍候。";var login=services.Hub.Submit(job.Id,"login");RefreshCounts();await login;
        var result=services.Repository.GetJob(job.Id)!;
        platformActions[platform]=(job.Id,new(){Type="complete",Status=result.Status,ReasonCode=result.ReasonCode},DateTimeOffset.UtcNow);
        RefreshLoginAction(announce:platform==Choice(LoginPlatform));RefreshAccount();
    });
    void FinishLogin_Click(object sender,RoutedEventArgs e)=>Start(async()=>{FinishLoginButton.IsEnabled=false;await services.Hub.SendControlAsync(new{command="finish-login"});});
    void Continue_Click(object sender,RoutedEventArgs e)=>Start(async()=>{ContinueButton.IsEnabled=false;await services.Hub.SendControlAsync(new{command="continue"});});
    void SubmitInput_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        if(inputJobId==null || inputJobId!=services.Hub.ActiveJobId)throw new InvalidOperationException("此输入请求已结束，请重新开始登录。");
        var value=inputType=="text"?PhoneInput.Text:SecretInput.Password;var token=inputId;ClearInput();
        if(value.Length==0 || value.Length>4096 || value.Any(char.IsControl))throw new InvalidOperationException("输入为空或包含不支持的字符，请重新开始登录。");
        await services.Hub.SendControlAsync(new{command="input",inputId=token,text=value});
    });
    void ResendCode_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {
        if(inputJobId==null||inputJobId!=services.Hub.ActiveJobId||!(delivery?.CanResend(DateTimeOffset.UtcNow-deliveryReceived)??false))throw new InvalidOperationException(UserText.Error("resend_unavailable"));
        var token=inputId;ClearInput();await services.Hub.SendControlAsync(new{command="resend",inputId=token});
    });
    void StopPlatform_Click(object sender,RoutedEventArgs e)=>Start(async()=>{var platform=Choice(LoginPlatform);ClearQr();ClearInput();await Task.WhenAll(services.Hub.StopPlatformAsync(platform),services.Previews.StopAsync(platform));});
    void LoginPlatform_Changed(object sender,SelectionChangedEventArgs e){if(AccountBadge!=null){ClearQr();RefreshAccount();if(ActionMessage!=null)RefreshLoginAction();}}
    void RefreshAccount()=>AccountBadge.Text=services.Account(Choice(LoginPlatform))?.Badge??"还没有登录";
    void HandleMessage(string id,WorkerEvent e)
    {
        if(e.Type=="login_qr"){ShowQr(id,e);return;}
        if(closing)return;
        if(id==qrAttemptJob&&e.Type is "needs_action" or "complete" or "error" or "account")ClearQr();
        if(chatDirectory.Accept(id,services.Account("telegram")?.AccountId,e))
        {
            // Rows arrive one event each; rebuild the picker once the directory stops, not per row.
            if(e.Type!="chat")FillChats();
            RefreshChatDirectory();
        }
        if(e.Type=="folder" && e.Folder!=null && services.Repository.GetJob(id) is HubJob directory)AddFolder(id,directory.Source,e.Folder);
        if(e.Type=="account")RefreshAccount();
        if(e.Type is "needs_action" or "complete")
        {
            var job=services.Repository.GetJob(id);
            if(job!=null){
                var received=DateTimeOffset.UtcNow;
                if(e.Type=="needs_action"&&e.InputId!=null&&platformActions.TryGetValue(job.Source.Platform,out var old)&&old.JobId==id&&old.Event.InputId==e.InputId)received=old.Received;
                platformActions[job.Source.Platform]=(id,e,received);if(job.Source.Platform==Choice(LoginPlatform))RefreshLoginAction(announce:e.Type=="complete");
            }
        }
        RefreshCounts();
    }
    // announce: this refresh reports a just-finished login/operation, so the status line (which showed the
    // waiting prompt) must follow; a mere platform switch leaves the status line alone.
    void RefreshLoginAction(bool announce=false)
    {
        ClearInput();FinishLoginButton.IsEnabled=false;ContinueButton.IsEnabled=false;
        if(!platformActions.TryGetValue(Choice(LoginPlatform),out var action)){ActionMessage.Text="当前没有进行中的操作。";RefreshCounts();return;}
        var (id,e,received)=action;
        var waiting=e.AwaitingInput==true&&services.Hub.ActiveJobId==id&&services.Hub.AwaitingInput;
        if(e.Type=="needs_action")
        {
            ActionMessage.Text=UserText.LoginAction(services.Repository.GetJob(id)?.Source,e.Code,waiting);
            if(e.Code=="source_tab_required" && services.Repository.GetJob(id)?.Source is SourceRequest source)
                ActionMessage.Text="本次扫描："+UserText.Platform(source.Platform)+" · "+UserText.Kind(source.Kind)+"。"+ActionMessage.Text;
            StatusLine.Text=ActionMessage.Text;
            if(!waiting)ActionMessage.Text="本次操作已结束，请手动发起新操作。"+ActionMessage.Text;
            FinishLoginButton.IsEnabled=waiting && e.Code=="auth_required" && services.Repository.GetJob(id)?.Source.Label=="手动登录";
            ContinueButton.IsEnabled=waiting && e.InputType==null && e.Code is "challenge" or "input_required" or "source_tab_required";
            if(waiting && e.InputType is "text" or "password")
            {
                ClearInput();inputJobId=id;inputType=e.InputType;inputId=e.InputId;delivery=e.Delivery;deliveryReceived=received;
                if(delivery!=null){ActionMessage.Text=delivery.Display;ResendCodeButton.Visibility=Visibility.Visible;}InputPanel.Visibility=Visibility.Visible;
                InputLabel.Text=e.InputType=="text"?"请输入手机号（含国家区号）":e.Prompt?.Contains("two-step",StringComparison.OrdinalIgnoreCase)==true?"请输入 Telegram 两步验证密码":"请输入 Telegram 验证码";
                PhoneInput.Visibility=e.InputType=="text"?Visibility.Visible:Visibility.Collapsed;SecretInput.Visibility=e.InputType=="password"?Visibility.Visible:Visibility.Collapsed;
            }
        }
        if(e.Type=="complete")
        {
            var job=services.Repository.GetJob(id);var reason=e.ReasonCode??job?.ReasonCode;
            ActionMessage.Text=e.Status=="completed"&&reason==null
                ?job?.Source.Label=="手动登录"?"本次登录已确认。后续操作仍会重新检查当前账号状态。":"本次操作已结束。请在工作台或历史记录查看结果。"
                :"本次操作已结束，请手动发起新操作。"+UserText.LoginAction(job?.Source,reason??"operation_failed",false);
            if(announce&&job?.Source.Label=="手动登录")StatusLine.Text=ActionMessage.Text;
        }
        RefreshCounts();
    }
    void ClearInput(){PhoneInput.Clear();SecretInput.Clear();InputPanel.Visibility=Visibility.Collapsed;inputJobId=null;inputType=null;inputId=null;delivery=null;ResendCodeButton.IsEnabled=false;ResendCodeButton.Visibility=Visibility.Collapsed;}
    void Refresh()
    {
        if(currentJobId!=null && services.Repository.GetJob(currentJobId) is HubJob job)
        {
            var items=services.Repository.ListItems(currentJobId);var receipts=services.Repository.ListLatestReceipts(currentJobId);
            var existing=Rows.ToDictionary(r=>r.Item.Key);
            foreach(var item in items)
            {
                if(existing.TryGetValue(item.Key,out var row))row.Update(item,receipts);
                else Rows.Add(new PreviewRow(item,(key,selected)=>{services.Repository.SetSelected(job.Id,key,selected);RefreshSelection();},receipts));
            }
            SourceLabel.Text=UserText.Platform(job.Source.Platform)+" · "+UserText.Kind(job.Source.Kind)+(string.IsNullOrWhiteSpace(job.Source.Label)||job.Source.Label==UserText.Kind(job.Source.Kind)?"":" · "+job.Source.Label);
            ScanSummary.Text=ChatDirectoryState.IsDirectory(job.Source)?"聊天目录 · "+UserText.Status(job.Status):job.Source.Kind=="saved_folders"?$"共 {services.Repository.GetFolders(job.Id).Count} 个收藏夹 · "+UserText.Status(job.Status):$"共 {items.Count} 项 · "+UserText.Status(job.Status);
            DestinationLabel.Text="保存到："+Destination(job);
            var key=string.Join('\u001f',job.Id,job.Status,job.ReasonCode,job.Message,services.Hub.AwaitingInput,services.Hub.ActiveJobId==job.Id);
            if(key!=statusKey){statusKey=key;
            if(!string.IsNullOrEmpty(job.Message))StatusLine.Text=job.Source is {Platform:"x",Label:"手动登录"}&&job.ReasonCode=="auth_required"?UserText.LoginAction(job.Source,job.ReasonCode,services.Hub.ActiveJobId==job.Id&&services.Hub.AwaitingInput):UserText.JobMessage(job.Message);
            if(job.Status=="needs_action" && !services.Hub.AwaitingInput)StatusLine.Text=((job.Source.Kind=="bridge"&&job.ReasonCode=="bridge_refresh_required"||job.ReasonCode is "rate_limited" or "download_root_unavailable")&&!string.IsNullOrEmpty(job.Message)?UserText.JobMessage(job.Message):UserText.LoginAction(job.Source,job.ReasonCode,false));
            }
        }
        EmptyState.Visibility=Rows.Count==0&&ChatChooser.Visibility!=Visibility.Visible?Visibility.Visible:Visibility.Collapsed;RefreshSelection();RefreshAccount();
        var selected=(HistoryGrid.SelectedItem as HistoryRow)?.Job.Id;
        HistoryGrid.ItemsSource=services.Repository.ListJobs().Reverse().Select(j=>new HistoryRow(j,services.Repository.ListItems(j.Id),services.Repository.ListLatestReceipts(j.Id),services.Hub.QueueSnapshot)).ToList();
        if(selected!=null)HistoryGrid.SelectedItem=HistoryGrid.Items.Cast<HistoryRow>().FirstOrDefault(r=>r.Job.Id==selected);
        if(services.Hub.StorageWarning!=null)StatusLine.Text=UserText.Error(services.Hub.StorageWarning);
        if(!services.Hub.AwaitingInput){ClearInput();FinishLoginButton.IsEnabled=false;ContinueButton.IsEnabled=false;}
        CacheSize.Text=$"缩略图：{services.Previews.CachedBytes/1024d/1024:F1} MiB / 128 MiB";
        var measured=services.Hub.Resources;
        var cacheKey=$"{currentJobId}|{measured?.Metrics.OperationId}|{measured?.Metrics.FinishedAt:O}";
        if(resourceCacheKey!=cacheKey){historicalResources=currentJobId==null?null:services.Repository.GetLatestResourceSummary(currentJobId);resourceCacheKey=cacheKey;}
        var progress=services.Hub.ScanProgress;
        var progressKey=progress!=null&&progress.Current.JobId==currentJobId?$"{currentJobId}|{progress.Current.Generation}|{progress.Persisted?.UpdatedAt:O}":currentJobId??"";
        if(scanProgressCacheKey!=progressKey){historicalScanProgress=currentJobId==null?null:services.Repository.GetLatestScanProgress(currentJobId);scanProgressCacheKey=progressKey;}
        RefreshScanProgress();
    }
    void RefreshSelection(){SelectionSummary.Text=$"已选择 {Rows.Count(r=>r.Selected)} / {Rows.Count} 项";var source=currentJobId==null?null:services.Repository.GetJob(currentJobId)?.Source;DownloadButton.Content=ChatDirectoryState.IsDirectory(source)?"请先读取目录并选择聊天":source?.Kind=="saved_folders"?"请先选择专辑并扫描作品":source?.Kind=="saved_folder"&&!CanDownloadSource(source)?"收藏夹下载待支持":"下载所选";DownloadButton.IsEnabled=source?.Bridge is not {ConfirmationRequired:true,Confirmed:false}&&CanDownloadSource(source)&&services.Hub.Enabled&&Rows.Any(r=>r.Selected);}
    void RefreshCounts(){RefreshBridgeUi();RefreshSelection();RefreshFolderPicker();RefreshChatDirectory();RefreshQr();ResendCodeButton.IsEnabled=services.Hub.AwaitingInput&&(delivery?.CanResend(DateTimeOffset.UtcNow-deliveryReceived)??false);MasterButton.Content=services.Hub.Enabled?"● 总开关：开":"总开关：关 · 点击开启";MasterButton.Style=(Style)FindResource(services.Hub.Enabled?"Soft":"Primary");MasterButton.ToolTip=services.Hub.Enabled?"点击停止全部任务并释放内存":null;OwnedCount.Text=$"自有操作 {services.Hub.ActiveCount} · 排队 {services.Hub.PendingCount} · 预览 {services.Previews.ActiveCount}";RefreshResources();RefreshScanProgress();}
    void RefreshScanProgress()
    {
        static string Count(long? value)=>value?.ToString()??"未知";
        static string Phase(string phase)=>phase switch{"starting"=>"准备扫描","scan"=>"扫描中","waiting"=>"等待处理","finished"=>"已结束",_=>"未知"};
        static string State(string state)=>state switch{"running"=>"进行中","completed"=>"完成","paused"=>"已暂停","failed"=>"失败","needs_action"=>"待处理","interrupted"=>"曾中断",_=>"未知"};
        var current=services.Hub.ScanProgress;
        var selected=current!=null&&current.Current.JobId==currentJobId;
        var value=selected?current!.Current:historicalScanProgress;
        if(value==null){ScanCheckpointLine.Text="";ScanDurableLine.Text="";return;}
        var live=selected&&services.Hub.ActiveJobId==currentJobId&&value.TerminalState=="running";
        var label=live?"本轮（内存）":selected?"本轮结束（内存）":"历史检查点";
        ScanCheckpointLine.Text=$"{label} · {Phase(value.Phase)} / {State(value.TerminalState)} · 本轮保存/确认 {value.CommittedUniqueItemCount} 项 · 观察 {Count(value.ObservedCurrent)} / 总数 {Count(value.Total)} · 滚动轮次 {Count(value.ObservedRounds)} · API 页数 {Count(value.ObservedPages)} · {value.UpdatedAt.ToLocalTime():MM-dd HH:mm:ss}";
        var saved=selected?current!.Persisted:historicalScanProgress;
        ScanDurableLine.Text=saved==null?"本轮尚无已保存检查点":$"已保存检查点 {saved.UpdatedAt.ToLocalTime():MM-dd HH:mm:ss} · 本轮 {saved.CommittedUniqueItemCount} 项 · {Phase(saved.Phase)} / {State(saved.TerminalState)}";
        if(selected&&current!.SaveFailed)ScanDurableLine.Text+=" · 扫描进度未保存，以上已存记录未更新";
    }
    void RefreshResources()
    {
        static string Bytes(long? value)=>value.HasValue?$"{value.Value/1048576d:F1} MiB":"未知";
        var latest=services.Hub.Resources;
        var live=latest!=null&&latest.Metrics.FinishedAt==null&&latest.JobId==services.Hub.ActiveJobId;
        var metrics=live||latest?.JobId==currentJobId?latest?.Metrics:historicalResources;
        if(metrics==null)ResourceLine.Text="自有进程资源：尚无采样";
        else
        {
            var operation=metrics.Operation switch{"scan"=>"扫描","download"=>"下载","listFolders"=>"读取收藏夹","listChats"=>"读取聊天","login"=>"登录","loginQr"=>"扫码登录",_=>"操作"};
            var current=live?$"当前操作 · 自有进程 {metrics.ProcessCount?.ToString()??"未知"} · 私有提交 {Bytes(metrics.PrivateCommitBytes)} · 工作集之和 {Bytes(metrics.WorkingSetBytes)}":$"所选任务历史采样（操作结束 {metrics.FinishedAt?.ToLocalTime():MM-dd HH:mm:ss} · {operation}）";
            var quality=metrics.Quality=="unknown"?"尚无样本":metrics.Quality=="incomplete"?"采样不完整":"每秒采样";
            ResourceLine.Text=$"{current} · 采样峰值：进程 {metrics.PeakProcessCount?.ToString()??"未知"} / 私有提交 {Bytes(metrics.PeakPrivateCommitBytes)} / 工作集之和 {Bytes(metrics.PeakWorkingSetBytes)} · {quality}";
        }
        if(services.Hub.ResourceWarning!=null)ResourceLine.Text+=" · "+services.Hub.ResourceWarning;
        var host=latest?.Metrics;
        HostResourceLine.Text=host?.SampledAt==null?"主界面内存：尚无采样":$"主界面（最近采样 {host.SampledAt.Value.ToLocalTime():HH:mm:ss}）· 私有提交 {Bytes(host.HostPrivateCommitBytes)} · 工作集 {Bytes(host.HostWorkingSetBytes)}";
    }
    void OpenHistory_Click(object sender,RoutedEventArgs e)=>OpenHistory();
    void History_DoubleClick(object sender,MouseButtonEventArgs e)=>OpenHistory();
    void OpenHistory(){if(HistoryGrid.SelectedItem is not HistoryRow row)return;currentJobId=row.Job.Id;Rows.Clear();if(ChatDirectoryState.IsDirectory(row.Job.Source)){ClearChatDirectory();StatusLine.Text="此历史记录是聊天目录。请在历史页重新扫描目录，再选择聊天；不会下载目录。";}else if(row.Job.Source.Kind=="saved_folders"){SourcePlatform.SelectedIndex=row.Job.Source.Platform=="douyin"?1:2;ShowFolderDirectory(row.Job);}else if(services.Hub.Enabled){services.Previews.Enable();services.Previews.EnablePlatform(row.Job.Source.Platform);}Pages.SelectedIndex=0;Refresh();}
    void Rescan_Click(object sender,RoutedEventArgs e)=>Start(async()=>{RequireEnabled();if(HistoryGrid.SelectedItem is HistoryRow row){currentJobId=row.Job.Id;Rows.Clear();Pages.SelectedIndex=0;if(services.Hub.ActiveJobId==row.Job.Id || services.Hub.QueueSnapshot.Any(q=>q.JobId==row.Job.Id))throw new InvalidOperationException("请先停止此任务再更改扫描范围。");
        if(row.Job.Source.Kind=="bridge"){ShowBridgeHint();return;}if(ChatDirectoryState.IsDirectory(row.Job.Source))await ReadChatDirectory(row.Job);
        else if(row.Job.Source.Kind=="saved_folders"){SourcePlatform.SelectedIndex=row.Job.Source.Platform=="douyin"?1:2;services.Repository.SetScanLimit(row.Job.Id,50);var directory=services.Repository.GetJob(row.Job.Id)!;ShowFolderDirectory(directory);Folders.Items.Clear();folderPicker.Begin(directory.Id,directory.Source);await services.Hub.Submit(row.Job.Id,"listFolders");}
        else {if(row.Job.Source.Kind=="saved_folder"&&!CanScanFolderMembers(row.Job.Source.Platform))throw new InvalidOperationException("该平台收藏夹内容扫描尚未支持；不会改为扫描全部收藏。");services.Previews.Enable();services.Repository.SetScanLimit(row.Job.Id,row.Job.Source.Kind=="saved_folder"?row.Job.Source.MaxItems:services.Settings.MaxScanItems);await services.Hub.Submit(row.Job.Id,"scan");}Refresh();}});
    void StopHistory_Click(object sender,RoutedEventArgs e)=>Start(async()=>{if(HistoryGrid.SelectedItem is HistoryRow row)await Task.WhenAll(services.Hub.StopJobAsync(row.Job.Id),services.Previews.StopAsync(row.Job.Source.Platform));});
    void PickFolder_Click(object sender,RoutedEventArgs e){var picker=new OpenFolderDialog{Title="选择媒体下载目录",Multiselect=false};if(picker.ShowDialog(this)==true)OutputFolder.Text=picker.FolderName;}
    void SaveSettings_Click(object sender,RoutedEventArgs e)=>Start(()=>{if(!int.TryParse(ScanLimit.Text,out var limit)||limit<0||limit>10000)throw new InvalidOperationException("扫描上限应为 0 至 10000 的整数。");services.SaveSettings(OutputFolder.Text,limit,FolderPerTaskBox.IsChecked==true);StatusLine.Text="已保存设置；新任务将使用此目录。";if(currentJobId==null)DestinationLabel.Text="保存到："+services.Settings.DownloadRoot;return Task.CompletedTask;});
    void ClearCache_Click(object sender,RoutedEventArgs e)=>Start(async()=>{await services.Previews.ClearAsync();foreach(var row in Rows)row.Image=null;StatusLine.Text="已清理本程序缩略图缓存。登录、历史和媒体保留。";});
    void MeasureBrowser_Click(object sender,RoutedEventArgs e)=>Start(async()=>
    {var path=Path.Combine(services.DataRoot,"private","browser");var bytes=await Task.Run(()=>MeasureTree(path));BrowserSize.Text=$"浏览器资料当前占用 {bytes/1024d/1024:F1} MiB（含登录与缓存，不受缩略图上限控制）。";});
    internal static long MeasureTree(string path)
    {if(!Directory.Exists(path))return 0;PrivateStorage.RejectLinks(path);long total=0;foreach(var entry in new DirectoryInfo(path).EnumerateFileSystemInfos()){if((entry.Attributes&FileAttributes.ReparsePoint)!=0)continue;total+=entry is FileInfo file?file.Length:MeasureTree(entry.FullName);}return total;}
    // One-folder-per-task downloads live in <root><category><platform><task folder>.
    static string Destination(HubJob job)=>job.TaskFolder is {} folder?Path.Combine(job.DownloadRoot,job.Category,job.Source.Platform,folder):Path.Combine(job.DownloadRoot,job.Category);
    void OpenFolder_Click(object sender,RoutedEventArgs e)=>Start(()=>
    {var job=currentJobId==null?null:services.Repository.GetJob(currentJobId);var path=job==null?services.Settings.DownloadRoot:Destination(job);if(!Directory.Exists(path))throw new InvalidOperationException("此下载目录尚未创建。完成下载后可以打开。");Process.Start(new ProcessStartInfo("explorer.exe"){ArgumentList={path},UseShellExecute=false});return Task.CompletedTask;});
    void Export_Click(object sender,RoutedEventArgs e)=>Start(()=>
    {var dialog=new SaveFileDialog{Title="导出脱敏任务报告",FileName="统一媒体管理器-任务报告.json",Filter="JSON 报告|*.json"};if(dialog.ShowDialog(this)==true){File.WriteAllText(dialog.FileName,services.ExportReport());StatusLine.Text="已导出脱敏报告（不含原始链接、账号输入或登录数据）。";}return Task.CompletedTask;});
    void ItemResults_Click(object sender,RoutedEventArgs e)
    {
        if(currentJobId==null || PreviewGrid.SelectedItem is not PreviewRow row)return;
        var receipts=services.Repository.ListLatestReceipts(currentJobId).Where(r=>r.ContentKey==row.Item.Key).ToArray();
        var details=ResultSummary.From([row.Item],receipts,false).Display+"\n\n"+string.Join("\n\n",receipts.Select(r=>$"媒体 {r.MediaIndex} · "+(r.Status=="failed"?"未完成："+UserText.Error(r.ErrorCode):r.Status=="skipped"?"已核验并复用现有文件":"已保存")+(r.DuplicateOfContentKey==null?"":" · 已检测字节相同（本次传输未省略）")+"\n"+r.FilePath));
        MessageBox.Show(this,details,"此项文件结果",MessageBoxButton.OK,MessageBoxImage.Information);
    }
    void ItemFolder_Click(object sender,RoutedEventArgs e)=>Start(()=>
    {
        if(currentJobId==null || PreviewGrid.SelectedItem is not PreviewRow row)return Task.CompletedTask;
        var receipt=services.Repository.ListLatestReceipts(currentJobId).FirstOrDefault(r=>r.ContentKey==row.Item.Key && r.Status is "completed" or "skipped" && File.Exists(r.FilePath));
        if(receipt==null)throw new InvalidOperationException("此项尚无可打开的已保存文件。");
        Process.Start(new ProcessStartInfo("explorer.exe"){ArgumentList={Path.GetDirectoryName(receipt.FilePath)!},UseShellExecute=false});return Task.CompletedTask;
    });
    void OriginalLink_Click(object sender,RoutedEventArgs e)=>Start(()=>
    {if(PreviewGrid.SelectedItem is PreviewRow row && row.HasPublicLink)Process.Start(new ProcessStartInfo(row.Item.SourceUrl){UseShellExecute=true});return Task.CompletedTask;});
    void Preview_LoadingRow(object sender,DataGridRowEventArgs e)
    {
        e.Row.Loaded-=VisibleRowLoaded;e.Row.Loaded+=VisibleRowLoaded;
        if(e.Row.IsLoaded)LoadVisible(e.Row);
    }
    void VisibleRowLoaded(object sender,RoutedEventArgs e)=>LoadVisible((DataGridRow)sender);
    void Preview_UnloadingRow(object sender,DataGridRowEventArgs e)
    {e.Row.Loaded-=VisibleRowLoaded;if(visibleRows.Remove(e.Row,out var cancel)){cancel.Cancel();cancel.Dispose();}if(e.Row.Item is PreviewRow row)row.Image=null;}
    async void LoadVisible(DataGridRow gridRow)
    {
        if(gridRow.Item is not PreviewRow row || closing)return;
        if(visibleRows.Remove(gridRow,out var old)){old.Cancel();old.Dispose();}
        var cancel=new CancellationTokenSource();visibleRows[gridRow]=cancel;
        try
        {
            var file=await services.Previews.LoadAsync(row.Item.Platform,row.Item.ThumbnailUrl,cancel.Token);
            if(file==null || cancel.IsCancellationRequested || !ReferenceEquals(gridRow.Item,row))return;
            row.Image=DecodePreview(file);
        }
        catch(Exception ex)when(ex is IOException or NotSupportedException or FileFormatException or ArgumentException or InvalidOperationException){row.Image=null;}
    }
    internal static BitmapSource? DecodePreview(string path)
    {
        var bytes=File.ReadAllBytes(path);if(bytes.Length>2*1024*1024 || !PreviewImage.TryGetDimensions(bytes,out var width,out var height))return null;
        var scale=Math.Min(1,Math.Min(160d/width,100d/height));
        using var stream=new MemoryStream(bytes);var bitmap=new BitmapImage();bitmap.BeginInit();bitmap.CacheOption=BitmapCacheOption.OnLoad;bitmap.DecodePixelWidth=Math.Max(1,(int)(width*scale));bitmap.DecodePixelHeight=Math.Max(1,(int)(height*scale));bitmap.StreamSource=stream;bitmap.EndInit();bitmap.Freeze();return bitmap;
    }
    async void OnClosing(object? sender,CancelEventArgs e)
    {
        if(closed)return;e.Cancel=true;if(closing)return;closing=true;IsEnabled=false;StatusLine.Text="正在保存并关闭自有操作…";refreshTimer.Stop();ClearQr();ClearInput();
        foreach(var cancel in visibleRows.Values)cancel.Cancel();
        try{await Task.WhenAll(services.Hub.DisableAsync(),services.Previews.StopAsync(),services.StopBridgeAsync());await services.Hub.DisposeAsync();await services.Previews.DisposeAsync();}
        finally{foreach(var cancel in visibleRows.Values)cancel.Dispose();visibleRows.Clear();closed=true;_ = Dispatcher.BeginInvoke(Close);}
    }
}
public sealed class PreviewRow : INotifyPropertyChanged
{
    readonly Action<string,bool> select;
    ContentItem item;BitmapSource? image;string result="";
    public ContentItem Item=>item;
    public bool Selected{get=>item.Selected;set{if(item.Selected==value)return;item.Selected=value;select(item.Key,value);Notify();}}
    public BitmapSource? Image{get=>image;set{image=value;Notify();}}
    public string Attribution=>string.Join(" · ",new[]{item.Author?.Trim(),DateTimeOffset.TryParse(item.CreatedAt,out var at)?at.ToLocalTime().ToString("yyyy-MM-dd"):item.CreatedAt}.Where(s=>!string.IsNullOrWhiteSpace(s)));
    public string Identity=>item.Platform=="telegram"?$"{item.ChatId} / 消息 {item.MessageId}":item.ContentId;
    public string MediaCount=>!item.MediaResolved&&item.Media.Count==0?"下载时解析":string.Join(" · ",new[]{(item.Media.Count(m=>m.Kind=="image"),"图"),(item.Media.Count(m=>m.Kind=="video"),"视频")}.Where(p=>p.Item1>0).Select(p=>$"{p.Item1} {p.Item2}")) is {Length:>0} text?text:"无媒体";
    public string Result=>result;
    public bool HasPublicLink=>SourceClassifier.TryClassify(item.SourceUrl,out var source,out _) && source!.Platform==item.Platform && source.Kind=="single";
    public PreviewRow(ContentItem item,Action<string,bool> select,IReadOnlyList<DownloadReceipt> receipts){this.item=item;this.select=select;Update(item,receipts);}
    public void Update(ContentItem value,IReadOnlyList<DownloadReceipt> receipts)
    {item=value;var files=receipts.Where(r=>r.ContentKey==item.Key).ToArray();result=ResultText.Item(ResultSummary.From([item],files,false));Notify("");}
    public event PropertyChangedEventHandler? PropertyChanged;
    void Notify([CallerMemberName]string? property=null)=>PropertyChanged?.Invoke(this,new(property));
}
public sealed class HistoryRow(HubJob job,IReadOnlyList<ContentItem> items,IReadOnlyList<DownloadReceipt> receipts,IReadOnlyList<(string JobId,string Operation)> queue)
{
    public HubJob Job=>job;
    public string Platform=>UserText.Platform(job.Source.Platform);
    public string Source=>(ChatDirectoryState.IsDirectory(job.Source)?"聊天目录":UserText.Kind(job.Source.Kind))+"\n"+(job.Source.Kind=="saved_folder"?job.Source.Label:Uri.TryCreate(job.Source.Url,UriKind.Absolute,out var uri)?(job.Source.Platform=="telegram"?job.Source.ChatId??uri.AbsolutePath:uri.Host+uri.AbsolutePath):"来源未提供");
    public string Created=>DateTimeOffset.TryParse(job.CreatedAt,out var time)?time.ToLocalTime().ToString("MM-dd HH:mm"):"时间未提供";
    public string Status=>queue.Any(q=>q.JobId==job.Id)?"排队等待 · "+(queue.First(q=>q.JobId==job.Id).Operation=="download"?"下载":"扫描"):UserText.Status(job.Status);
    public string Completeness=>ChatDirectoryState.IsDirectory(job.Source)?job.Completeness=="complete"?"本次目录已到末尾":"本次目录未确认全部":job.Completeness=="complete"?"已确认到列表末尾":"未确认全部";
    public string Detail=>ChatDirectoryState.IsDirectory(job.Source)?"聊天目录":ResultText.Task(ResultSummary.From(items,receipts),UserText.JobMessage(job.Message));
}
internal static class ResultText
{
    // One item: whether its files are saved. A task: how much of the selection is saved, plus any problem.
    internal static string Item(ResultSummary r)=>r.Completed+r.Skipped+r.Failed==0?"未下载":(r.Failed>0?$"失败 {r.Failed} · ":"")+(r.Completed+r.Skipped>=r.KnownAssets&&r.KnownAssets>0?"已保存":$"已保存 {r.Completed+r.Skipped}/{r.KnownAssets}");
    internal static string Task(ResultSummary r,string? message)
    {
        var saved=r.Completed+r.Skipped;
        var line=$"已选 {r.SelectedWorks}/{r.Works} 条"+(saved+r.Failed>0?$" · 已保存 {saved} 个文件":"")+(r.Failed>0?$" · 失败 {r.Failed}":"");
        return string.IsNullOrWhiteSpace(message)||message is "已完成。" or "扫描完成。"?line:line+"\n"+message;
    }
}
