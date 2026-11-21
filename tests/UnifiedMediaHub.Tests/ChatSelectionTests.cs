using UnifiedMediaHub.Core;
using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class ChatSelectionTests
{
    [Fact]
    public void TypedChatSelectionKeepsDirectMessageAndTopicIntent()
    {
        SourceClassifier.TryClassify("https://t.me/c/123/7/42",out var original,out _);
        var source=ChatSources.Select(new(){Id="channel_123",Title="Channel"},null,"login",original);
        Assert.Equal("channel_123",source.ChatId);Assert.Equal("42",source.MessageId);Assert.Equal("7",source.TopicId);Assert.Equal("single",source.Kind);Assert.Equal("login",source.AccountId);
    }
    [Fact]
    public void OtherChatCannotSilentlyRetargetDirectMessage()
    {
        SourceClassifier.TryClassify("https://t.me/alice/42",out var original,out _);
        Assert.Throws<InvalidOperationException>(()=>ChatSources.Select(new(){Id="chat_123",Username="bob"},null,null,original));
        var source=ChatSources.Select(new(){Id="channel_321",Username="alice"},null,null,original);Assert.Equal("42",source.MessageId);
    }
    [Fact]
    public void NewBasicChatHasTypedIdentityWithoutFakePrivateChannelUrl()
    {var source=ChatSources.Select(new(){Id="chat_123",Title="Group"},"7",null);Assert.Equal("https://t.me/",source.Url);Assert.Equal("chat_123",source.ChatId);Assert.Equal("topic",source.Kind);}
}
