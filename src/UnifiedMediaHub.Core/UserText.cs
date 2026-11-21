namespace UnifiedMediaHub.Core;

public static class UserText
{
    public static string LoginAction(SourceRequest? source,string? code,bool waiting)
        =>source is {Platform:"x",Label:"手动登录"}&&code=="auth_required"
        ?waiting?"在打开的浏览器里登录 X，完成后点'我已完成登录'或直接关闭该窗口。":"没有检测到 X 登录。若推特一直停在'确认你的帐户'，可能是推特的风控，请稍后再试，或先在常用浏览器里完成验证。"
        :Error(code);
    public static string? JobMessage(string? message)=>message=="Operation interrupted; resume requires explicit action."?"上次操作意外中断。请手动选择重新扫描或继续下载；不会自动恢复。":message;
    public static string Platform(string? value)=>value switch {"x"=>"X", "telegram"=>"Telegram", "douyin"=>"抖音", "xiaohongshu"=>"小红书",_=>"未知平台"};
    public static string Kind(string? value)=>value switch {"bridge"=>"Edge 桥接导入", "single"=>"单条作品", "profile"=>"作者作品", "saved"=>"全部收藏", "saved_folders"=>"收藏夹目录", "saved_folder"=>"收藏夹 / 专辑", "liked"=>"我的喜欢", "chat"=>"聊天 / 频道", "topic"=>"话题", "collection"=>"合集",_=>"来源"};
    public static string Status(string? value)=>value switch {"ready"=>"待开始", "scanning"=>"进行中", "downloading"=>"下载中", "paused"=>"已暂停", "needs_action"=>"需要处理", "completed"=>"已完成", "failed"=>"有失败", _=>"已中断"};
    public static string RateLimited(int seconds,DateTimeOffset now)
    {
        var wait=seconds>=3600?$"{(seconds+3599)/3600} 小时":$"{Math.Max(1,(seconds+59)/60)} 分钟";
        return $"平台要求等待约 {wait} 后再试（大约 {now.AddSeconds(seconds):HH:mm} 以后）。任务已停止，已下载的文件保留，之后点“下载所选”即可接着下。";
    }
    public static string DownloadRootUnavailable(string root)=>$"保存位置 {root} 现在不可用：所在磁盘没有连接，或者盘符变了。请接上磁盘；如果盘符变了，到“设置”页改保存位置后重新扫描。";
    public static string Error(string? code)=>code switch
    {
        "download_root_unavailable"=>"保存位置现在不可用：所在磁盘没有连接，或者盘符变了。",
        "bridge_snapshot"=>"已收到 Edge 发来的这一批作品。",
        "bridge_refresh_required"=>"请在 Edge 打开原页面，用桥接脚本重新发送这些作品；已完成文件保留。",
        "bridge_account_mismatch"=>"Edge 提供的账号与管理器绑定账号不一致，请在清单上明确确认后再下载。",
        "auth_required"=>"需要登录或重新确认账号。请到“账号”页处理后手动继续。",
        "identity_unverified"=>"本次未能确认当前账号身份，操作已停止；这不代表登录失效。请稍后手动重试。",
        "folder_unverified"=>"本次未能读取可确认的收藏夹／专辑目录；未扫描全部收藏，请稍后重试。",
        "folder_members_unavailable"=>"当前版本尚未支持所选收藏夹内的作品扫描。",
        "challenge"=>"平台要求验证。请在本程序打开的浏览器内完成验证后继续。",
        "rate_limited"=>"平台限制了请求频率。任务已停止，请稍后手动重试。",
        "input_required"=>"需要人工输入或选择页面标签。请按提示完成后确认。",
        "work_unavailable"=>"该作品已删除、不可见或链接已失效。请在浏览器确认链接后再手动重试；程序不会自动重试。",
        "embedded_unsupported"=>"该帖子的视频来自卡片、外链或引用帖，当前版本还不支持。请打开视频所在的原始帖子，复制它的链接后重试。",
        "sensitive_content"=>"该帖子被标记为敏感内容。需要在专用浏览器登录 X，并在账号设置中允许显示敏感内容，然后手动重试。",
        "media_unsupported"=>"这些消息里是文件、语音或贴纸等，本程序只下载图片和视频；其余勾选项已处理。",
        "work_unresolved"=>"没能在页面中解析出这条作品。请确认链接能在浏览器中正常打开，再手动重试。",
        "media_forbidden"=>"平台拒绝了媒体文件请求，已停止。可以稍后重试；如果持续出现，请把诊断报告发给维护者。",
        "source_tab_required"=>"尚未确认所选内容标签。请在专用浏览器选择对应的收藏或喜欢标签，内容出现后再继续。",
        "manual_wait_timeout"=>"等待页面处理已超时，本次扫描已停止。已保存的清单仍保留，请重新发起扫描。",
        "file_conflict"=>"目标位置已有不同文件，已保留原文件。请自行备份或移走冲突文件后，再手动继续。",
        "transfer_failed"=>"媒体传输或完整性检查失败，可手动继续补缺。",
        "disk_full"=>"磁盘可用空间不足，已停止任务。此前已保存的文件和检查点保留；最后一条进度可能未能写入。释放对应目录空间后，重新打开程序并手动继续。",
        "browser_closed"=>"专用浏览器已关闭或崩溃，本次操作已结束。请重新发起所需操作。",
        "source_changed"=>"页面来源、账号或标签发生变化，已停止采集。请重新确认来源后手动扫描。",
        "item_limit"=>"已达到所选扫描数量，请提高上限或缩小来源后重新扫描。",
        "scan_boundary"=>"已达到程序的有限扫描边界，请缩小来源或选择具体作品后重试。",
        "history_unproven"=>"扫描完成。",
        "network_error"=>"网络连接失败，任务已停止。检查网络后手动重试。",
        "delivery_unsupported"=>"Telegram 选择了本程序尚未支持的验证码渠道，本次登录已停止。请先在官方客户端处理，勿反复请求验证码。",
        "qr_expired"=>"二维码已过期，请重新点击扫码登录。",
        "resend_unavailable"=>"本次重发条件不满足或次数已用完，登录已停止。请按服务器提供的渠道和等待时间处理。",
        "cancelled"=>"任务已停止，已保存的文件和检查点保留，继续需要手动操作。",
        "operation_failed"=>"操作未能完成。请检查链接、登录、目录权限和磁盘空间后手动重试。",
        "owned_temp_unconfirmed" or "owned_temp_limit"=>"有尚未确认归属的临时记录，已保留文件并停止操作。请检查程序私有目录 owned-temps 中的记录；不要直接删除媒体文件。",
        _=>"操作未能完成。请检查链接、登录、目录权限和磁盘空间后手动重试。"
    };
    public static string? SafeCode(string? code)=>code is "bridge_snapshot" or "bridge_refresh_required" or "bridge_account_mismatch" or "qr_expired" or "auth_required" or "identity_unverified" or "folder_unverified" or "folder_members_unavailable" or "challenge" or "rate_limited" or "work_unavailable" or "embedded_unsupported" or "sensitive_content" or "work_unresolved" or "media_unsupported" or "download_root_unavailable" or "media_forbidden" or "input_required" or "source_tab_required" or "manual_wait_timeout" or "file_conflict" or "transfer_failed" or "owned_temp_unconfirmed" or "owned_temp_limit" or "disk_full" or "browser_closed" or "source_changed" or "item_limit" or "scan_boundary" or "history_unproven" or "network_error" or "delivery_unsupported" or "resend_unavailable" or "cancelled" or "operation_failed" ? code : null;
}
