package login

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"go.uber.org/zap"

	"github.com/iyear/tdl/core/logctx"
	clientcore "github.com/iyear/tdl/core/tclient"
)

type floodAccount struct{ invoker tg.Invoker }

func (f floodAccount) Status(ctx context.Context) (*auth.Status, error) {
	return nil, f.invoker.Invoke(ctx, nil, nil)
}
func (f floodAccount) Self(context.Context) (*tg.User, error) {
	panic("Self must not follow failed authorization")
}

func TestMachineFloodWaitProductionChain(t *testing.T) {
	ctx, cancel := context.WithTimeout(logctx.With(context.Background(), zap.NewNop()), 50*time.Millisecond)
	defer cancel()
	calls := 0
	var invoker tg.Invoker = telegram.InvokeFunc(func(context.Context, bin.Encoder, bin.Decoder) error {
		calls++
		return tgerr.New(420, "FLOOD_WAIT_3600")
	})
	chain := clientcore.NewDefaultMiddlewares(ctx, time.Minute, true)
	for i := len(chain) - 1; i >= 0; i-- {
		invoker = chain[i].Handle(invoker)
	}
	var output bytes.Buffer
	err := MachineIdentity(ctx, floodAccount{invoker}, &output)
	if err == nil || output.Len() != 0 {
		t.Fatal("failed RPC emitted an account")
	}
	MachineError(&output, err)
	var event map[string]any
	if json.Unmarshal(output.Bytes(), &event) != nil || event["code"] != "rate_limited" || calls != 1 || ctx.Err() != nil {
		t.Fatalf("production chain swallowed flood cause: code=%v calls=%d expired=%v", event["code"], calls, ctx.Err() != nil)
	}
}
