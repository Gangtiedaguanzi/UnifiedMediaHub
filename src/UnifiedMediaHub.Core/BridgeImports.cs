using System.Text.Json;
namespace UnifiedMediaHub.Core;
public sealed class BridgeSourceInfo
{
 public string ListKind{get;set;}="";public string? ViewerId{get;set;}public string ViewerName{get;set;}="身份未提供";public int ItemCount{get;set;}public string? FolderTitle{get;set;}public bool ConfirmationRequired{get;set;}public bool Confirmed{get;set;}public string? ReviewAccountId{get;set;}
}
public static class BridgeImports
{
 public static SourceRequest Source(BridgePayload payload,string? boundAccount)=>new(){Platform="douyin",Kind="bridge",Url="https://www.douyin.com/user/self",Label="来自 Edge 桥接",Bridge=new(){ListKind=payload.ListKind,FolderTitle=payload.FolderTitle,ViewerId=payload.ViewerId,ViewerName=payload.ViewerName,ItemCount=payload.Count,ReviewAccountId=boundAccount,ConfirmationRequired=!string.IsNullOrEmpty(boundAccount)&&payload.ViewerId!=null&&payload.ViewerId!=boundAccount}};
}
