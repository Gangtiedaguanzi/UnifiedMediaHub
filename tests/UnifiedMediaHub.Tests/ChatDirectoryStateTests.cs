using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class ChatDirectoryStateTests
{
    [Fact] public void FiveHundredSupplementaryRunesAreValid(){ChatDirectoryState.Validate(new(){Id="channel_1",Title=string.Concat(Enumerable.Repeat("😀",500)),Username="Good_name123"});}
    [Theory][InlineData("")][InlineData(" ")][InlineData("bad\nname")][InlineData("bad\u0085name")]
    public void EmptyOrControlTitleIsRejected(string title)=>Assert.Throws<InvalidDataException>(()=>ChatDirectoryState.Validate(new(){Id="chat_1",Title=title}));
    [Fact] public void FiveHundredAndOneRunesAreRejected()=>Assert.Throws<InvalidDataException>(()=>ChatDirectoryState.Validate(new(){Id="chat_1",Title=string.Concat(Enumerable.Repeat("😀",501))}));
    [Theory][InlineData("")][InlineData("@name")][InlineData("1name")][InlineData("abc\n")][InlineData("名字")]
    public void InvalidUsernameRejected(string username)=>Assert.Throws<InvalidDataException>(()=>ChatDirectoryState.Validate(new(){Id="chat_1",Title="valid",Username=username}));
    [Theory][InlineData("0")][InlineData("01")][InlineData("+1")][InlineData("1 ")][InlineData("name")][InlineData("9223372036854775808")]
    public void AccountMustBeCanonicalPositiveInt64(string account)=>Assert.Throws<InvalidOperationException>(()=>ChatDirectoryState.Source(account));
    static WorkerEvent Account(string account="123",string platform="telegram")=>new(){Type="account",Platform=platform,Authenticated=true,AccountId=account};
    static WorkerEvent Row(string id="channel_123")=>new(){Type="chat",Chat=new(){Id=id,Title="same title",Topics=[new(){Id="7",Title="not loaded by bounded contract"}]}};
    static WorkerEvent Complete(string status="completed",string completeness="partial")=>new(){Type="complete",Status=status,Completeness=completeness};
    [Fact] public void NewRequestRequiresConfirmedAccountAndUsesFixedLimit(){Assert.Throws<InvalidOperationException>(()=>ChatDirectoryState.Source(null));var source=ChatDirectoryState.Source("123");Assert.Equal(5000,source.MaxItems);Assert.Equal("123",source.AccountId);}
    [Fact] public void NoRowsBeforeAccountAndNoSelectionBeforeComplete(){var s=new ChatDirectoryState();s.Begin("job","123");Assert.False(s.Accept("job","123",Row()));s.Accept("job","123",Account());s.Accept("job","123",Row());Assert.False(s.CanSelect("channel_123","123"));s.Accept("job","123",Complete());Assert.True(s.CanSelect("channel_123","123"));Assert.Equal("partial",s.Completeness);Assert.Null(Assert.Single(s.Chats).Topics);}
    [Theory][InlineData("456","telegram")][InlineData("123","x")]
    public void WrongAccountOrPlatformCannotEnableSelection(string account,string platform){var s=new ChatDirectoryState();s.Begin("job","123");s.Accept("job","123",Account(account,platform));Assert.False(s.Accept("job","123",Row()));Assert.Empty(s.Chats);Assert.False(s.CanSelect("channel_123","123"));}
    [Fact] public void OldJobAndLateRowsCannotContaminateNewAttempt(){var s=new ChatDirectoryState();s.Begin("old","123");s.Accept("old","123",Account());s.Accept("old","123",Row());s.Begin("new","123");Assert.Empty(s.Chats);Assert.False(s.Accept("old","123",Account()));Assert.False(s.Accept("old","123",Row()));s.Accept("new","123",Account());s.Accept("new","123",Row());s.Accept("new","123",Complete());Assert.False(s.Accept("new","123",Row("chat_456")));Assert.Single(s.Chats);}
    [Fact] public void AccountSwitchInvalidatesEvenIfSwitchedBack(){var s=new ChatDirectoryState();s.Begin("job","123");s.Accept("job","123",Account());s.Accept("job","123",Row());s.Accept("job","456",Complete());Assert.Empty(s.Chats);Assert.False(s.CanSelect("channel_123","123"));}
    [Theory][InlineData("paused")][InlineData("failed")][InlineData("needs_action")]
    public void NonSuccessDirectoryCannotBeSelected(string status){var s=new ChatDirectoryState();s.Begin("job","123");s.Accept("job","123",Account());s.Accept("job","123",Row());s.Accept("job","123",Complete(status));Assert.False(s.CanSelect("channel_123","123"));}
    [Fact] public void ExactTypedIdsDeduplicateAndCapAt5000(){var s=new ChatDirectoryState();s.Begin("job","123");s.Accept("job","123",Account());for(var i=1;i<=5000;i++)s.Accept("job","123",Row("channel_"+i));s.Accept("job","123",Row("channel_1"));Assert.Equal(5000,s.Chats.Count);Assert.Throws<InvalidDataException>(()=>s.Accept("job","123",Row("chat_5001")));}
    [Fact] public void BareChatLinkCannotSilentlyRetargetSelection(){var s=new ChatDirectoryState();s.Begin("job","123");s.Accept("job","123",Account());s.Accept("job","123",Row());s.Accept("job","123",Complete());SourceClassifier.TryClassify("https://t.me/otherchat",out var wrong,out _);Assert.Throws<InvalidOperationException>(()=>s.Select("channel_123","123",wrong));}
    [Fact] public void SelectionPreservesMatchingPastedTopicAndRejectsDifferentChat(){var s=new ChatDirectoryState();s.Begin("job","123");s.Accept("job","123",Account());s.Accept("job","123",Row());s.Accept("job","123",Complete());SourceClassifier.TryClassify("https://t.me/c/123/7/42",out var direct,out _);var chosen=s.Select("channel_123","123",direct);Assert.Equal("42",chosen.MessageId);Assert.Equal("7",chosen.TopicId);SourceClassifier.TryClassify("https://t.me/c/456/7/42",out var wrong,out _);Assert.Throws<InvalidOperationException>(()=>s.Select("channel_123","123",wrong));}
}

