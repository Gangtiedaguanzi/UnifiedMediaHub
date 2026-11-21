using UnifiedMediaHub.Core;using Xunit;
namespace UnifiedMediaHub.Tests;
public sealed class LoginDeliveryTests
{
 [Fact]public void ResendNeedsKnownMethodElapsedServerTimeoutAndRemainingAllowance(){
  var delivery=new LoginDelivery{Method="app",NextMethod="sms",TimeoutSeconds=30,ResendsRemaining=3};Assert.True(delivery.IsValid);Assert.False(delivery.CanResend(TimeSpan.FromSeconds(29)));Assert.True(delivery.CanResend(TimeSpan.FromSeconds(30)));Assert.Contains("Telegram",delivery.Display);
  delivery.TimeoutSeconds=null;Assert.False(delivery.CanResend(TimeSpan.FromHours(1)));delivery.TimeoutSeconds=0;delivery.ResendsRemaining=0;Assert.False(delivery.CanResend(TimeSpan.Zero));delivery.ResendsRemaining=1;delivery.NextMethod="unsupported";Assert.False(delivery.CanResend(TimeSpan.Zero));delivery.Method="https://secret.invalid";Assert.False(delivery.IsValid);Assert.DoesNotContain("https",delivery.Display);
 }
}
