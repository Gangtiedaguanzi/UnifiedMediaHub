// UMH additions to tdl v0.20.4; licensed under the upstream AGPL-3.0.
package login

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/gotd/td/clock"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"github.com/iyear/tdl/core/umh"
	"github.com/skip2/go-qrcode"
	"io"
	"time"
)

var ErrQRExpired = errors.New("qr_expired")

type QRLoginClient interface {
	AccountClient
	Export(context.Context, ...int64) (qrlogin.Token, error)
	Import(context.Context) (*tg.AuthAuthorization, error)
	Password(context.Context, string) (*tg.AuthAuthorization, error)
}

// Register before constructing/running the client: a phone approval can arrive
// during Export or while stdout is still rendering. Duplicate updates coalesce.
func BufferedLoginToken(d interface{ OnLoginToken(tg.LoginTokenHandler) }) <-chan struct{} {
	ch := make(chan struct{}, 1)
	d.OnLoginToken(func(ctx context.Context, _ tg.Entities, _ *tg.UpdateLoginToken) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		select {
		case ch <- struct{}{}:
		default:
		}
		return nil
	})
	return ch
}
func MachineQRLogin(ctx context.Context, c QRLoginClient, in io.ReadCloser, out io.Writer, updates <-chan struct{}) error {
	return machineQRLogin(ctx, c, in, out, updates, clock.System)
}
func machineQRLogin(ctx context.Context, c QRLoginClient, in io.ReadCloser, out io.Writer, updates <-chan struct{}, clk clock.Clock) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	p := umh.NewWatchingPipe(in, out)
	defer p.Close()
	if err := ctx.Err(); err != nil {
		return err
	}
	state, err := c.Status(ctx)
	if err != nil {
		return err
	}
	if state != nil && state.Authorized {
		return MachineIdentity(ctx, c, out)
	}
	token, err := c.Export(ctx)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if token.Empty() {
		return MachineIdentity(ctx, c, out)
	}
	remaining := token.Expires().Sub(clk.Now())
	if remaining <= 0 {
		return ErrQRExpired
	}
	if remaining > 600*time.Second {
		return ErrUnauthorized
	}
	png, err := qrcode.Encode(token.URL(), qrcode.Medium, 320)
	if err != nil || len(png) > 32768 {
		return ErrUnauthorized
	}
	expires := token.Expires()
	token = qrlogin.Token{}
	if err = json.NewEncoder(out).Encode(map[string]any{"version": 1, "type": "qr", "pngBase64": base64.StdEncoding.EncodeToString(png), "expiresAtUnix": expires.Unix()}); err != nil {
		return err
	}
	png = nil
	timer := clk.Timer(expires.Sub(clk.Now()))
	defer clock.StopTimer(timer)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-p.Ended():
		return io.EOF
	case <-timer.C():
		return ErrQRExpired
	case <-updates:
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if !clk.Now().Before(expires) {
		return ErrQRExpired
	}
	select {
	case <-p.Ended():
		return io.EOF
	default:
	}
	authorization, err := c.Import(ctx)
	if errors.Is(err, auth.ErrPasswordAuthNeeded) || tgerr.Is(err, "SESSION_PASSWORD_NEEDED") {
		password, e := p.Ask(ctx, "password")
		if e != nil {
			return e
		}
		if e = ctx.Err(); e != nil {
			return e
		}
		authorization, err = c.Password(ctx, password)
		password = ""
	}
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	var expected int64
	if authorization != nil && authorization.User != nil {
		u, ok := authorization.User.(*tg.User)
		if !ok || u.ID <= 0 {
			return ErrUnauthorized
		}
		expected = u.ID
	}
	return machineIdentity(ctx, c, out, expected)
}
