namespace UnifiedMediaHub.Core;
public sealed class LoginDelivery
{
 public string Method {get;set;}="";public string? NextMethod {get;set;}public int? TimeoutSeconds {get;set;}public int ResendsRemaining {get;set;}
 public bool IsValid=>Method is "app" or "sms" or "call" && NextMethod is null or "sms" or "call" or "unsupported" && TimeoutSeconds is null or >=0 and <=600 && ResendsRemaining is >=0 and <=3;
 public bool CanResend(TimeSpan elapsed)=>IsValid&&ResendsRemaining>0&&NextMethod is "sms" or "call"&&TimeoutSeconds.HasValue&&elapsed.TotalSeconds>=TimeoutSeconds.Value;
 static string MethodName(string? method)=>method switch{"app"=>"已登录设备中的 Telegram 服务通知","sms"=>"手机短信","call"=>"语音电话",_=>"不支持的渠道"};
 public string Display=>!IsValid?"验证码渠道未能确认，请停止后重新检查。":$"Telegram 选择的验证码渠道：{MethodName(Method)}。收到服务器响应不代表验证码已送达。"+(ResendsRemaining==0?"本次登录的 3 次手动重发已用完。":NextMethod is not ("sms" or "call")?"服务器未提供本程序支持的下一渠道，无法在本次登录内重发。":TimeoutSeconds==null?"服务器未提供等待时间，重发不可用。":$"下一渠道：{MethodName(NextMethod)}；等待服务器指定的 {TimeoutSeconds} 秒后可手动重发，剩余 {ResendsRemaining} 次。该等待时间不是验证码有效期。");
}
