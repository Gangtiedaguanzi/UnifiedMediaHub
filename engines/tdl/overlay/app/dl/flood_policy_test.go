package dl

import (
	"context"
	"errors"
	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"github.com/spf13/viper"
	"testing"
	"time"
)

func TestDownloadPoolFloodPolicy(t *testing.T) {
	prior := viper.GetBool("fail-on-flood-wait")
	defer viper.Set("fail-on-flood-wait", prior)
	for _, failFast := range []bool{false, true} {
		viper.Set("fail-on-flood-wait", failFast)
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		calls := 0
		var invoker tg.Invoker = telegram.InvokeFunc(func(context.Context, bin.Encoder, bin.Decoder) error {
			calls++
			return tgerr.New(420, "FLOOD_WAIT_3600")
		})
		chain := poolMiddlewares(ctx)
		for i := len(chain) - 1; i >= 0; i-- {
			invoker = chain[i].Handle(invoker)
		}
		err := invoker.Invoke(ctx, nil, nil)
		if calls != 1 {
			t.Fatalf("pool retried %d calls", calls)
		}
		if failFast {
			if !tgerr.Is(err, "FLOOD_WAIT") || ctx.Err() != nil {
				t.Fatal("pool lost immediate flood error")
			}
		} else if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("legacy pool policy changed")
		}
		cancel()
	}
}
