// UMH additions to tdl v0.20.4; licensed under the upstream AGPL-3.0.
package login

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"github.com/iyear/tdl/core/umh"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

var ErrUnauthorized = errors.New("unauthorized")

type AccountClient interface {
	Status(context.Context) (*auth.Status, error)
	Self(context.Context) (*tg.User, error)
}
type LoginClient interface {
	AccountClient
	SendCode(context.Context, string, auth.SendCodeOptions) (tg.AuthSentCodeClass, error)
	ResendCode(context.Context, string, string) (tg.AuthSentCodeClass, error)
	SignIn(context.Context, string, string, string) (*tg.AuthAuthorization, error)
	Password(context.Context, string) (*tg.AuthAuthorization, error)
}

func fmtID(id int64) string { return strconv.FormatInt(id, 10) }
func MachineIdentity(ctx context.Context, c AccountClient, w io.Writer) error {
	return machineIdentity(ctx, c, w, 0)
}
func machineIdentity(ctx context.Context, c AccountClient, w io.Writer, expectedID int64) error {
	status, e := c.Status(ctx)
	if e != nil {
		return e
	}
	if status == nil || !status.Authorized {
		return ErrUnauthorized
	}
	u, e := c.Self(ctx)
	if e != nil {
		return e
	}
	if u == nil || u.ID <= 0 || (expectedID > 0 && u.ID != expectedID) || (status.User != nil && status.User.ID != u.ID) {
		return ErrUnauthorized
	}
	// Display name is optional. Omit it to keep untrusted account text out of diagnostics.
	return json.NewEncoder(w).Encode(map[string]any{"version": 1, "type": "account", "authenticated": true, "accountId": fmtID(u.ID)})
}

var ErrDeliveryUnsupported = errors.New("delivery_unsupported")
var ErrResendUnavailable = errors.New("resend_unavailable")

func delivery(s *tg.AuthSentCode, remaining int) (umh.Delivery, error) {
	d := umh.Delivery{ResendsRemaining: remaining}
	switch s.Type.(type) {
	case *tg.AuthSentCodeTypeApp:
		d.Method = "app"
	case *tg.AuthSentCodeTypeSMS:
		d.Method = "sms"
	case *tg.AuthSentCodeTypeCall:
		d.Method = "call"
	default:
		return d, ErrDeliveryUnsupported
	}
	next, hasNext := s.GetNextType()
	if hasNext {
		switch next.(type) {
		case *tg.AuthCodeTypeSMS:
			d.NextMethod = "sms"
		case *tg.AuthCodeTypeCall:
			d.NextMethod = "call"
		default:
			d.NextMethod = "unsupported"
		}
	}
	if seconds, ok := s.GetTimeout(); ok && seconds >= 0 && seconds <= 600 {
		d.TimeoutSeconds = &seconds
	}
	return d, nil
}
func MachineLogin(ctx context.Context, c LoginClient, in io.ReadCloser, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	p := umh.NewPipe(in, out)
	defer p.Close()
	state, err := c.Status(ctx)
	if err != nil {
		return err
	}
	if state != nil && state.Authorized {
		return MachineIdentity(ctx, c, out)
	}
	phone, err := p.Ask(ctx, "phone")
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	sent, err := c.SendCode(ctx, phone, auth.SendCodeOptions{})
	if err != nil {
		return err
	}
	for resends := 0; ; {
		if err = ctx.Err(); err != nil {
			return err
		}
		switch s := sent.(type) {
		case *tg.AuthSentCodeSuccess:
			if _, ok := s.Authorization.(*tg.AuthAuthorization); !ok {
				return ErrDeliveryUnsupported
			}
			return MachineIdentity(ctx, c, out)
		case *tg.AuthSentCode:
			if s.PhoneCodeHash == "" {
				return ErrUnauthorized
			}
			d, err := delivery(s, 3-resends)
			if err != nil {
				return err
			}
			received := time.Now()
			reply, err := p.AskCode(ctx, d)
			if err != nil {
				return err
			}
			if err = ctx.Err(); err != nil {
				return err
			}
			if reply.Resend {
				if resends >= 3 || d.TimeoutSeconds == nil || d.NextMethod == "" || d.NextMethod == "unsupported" || time.Since(received) < time.Duration(*d.TimeoutSeconds)*time.Second {
					return ErrResendUnavailable
				}
				resends++
				sent, err = c.ResendCode(ctx, phone, s.PhoneCodeHash)
				if err != nil {
					return err
				}
				continue
			}
			_, err = c.SignIn(ctx, phone, reply.Text, s.PhoneCodeHash)
			if errors.Is(err, auth.ErrPasswordAuthNeeded) {
				password, e := p.Ask(ctx, "password")
				if e != nil {
					return e
				}
				if e = ctx.Err(); e != nil {
					return e
				}
				_, err = c.Password(ctx, password)
			}
			if err != nil {
				return err
			}
			return MachineIdentity(ctx, c, out)
		default:
			return ErrDeliveryUnsupported
		}
	}
}
func ErrorCode(e error) string {
	if errors.Is(e, ErrQRExpired) || tgerr.Is(e, "AUTH_TOKEN_EXPIRED", "AUTH_TOKEN_INVALID", "AUTH_TOKEN_ALREADY_ACCEPTED") {
		return "qr_expired"
	}
	if errors.Is(e, ErrDeliveryUnsupported) {
		return "delivery_unsupported"
	}
	if errors.Is(e, ErrResendUnavailable) {
		return "resend_unavailable"
	}
	if errors.Is(e, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(e, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(e, umh.ErrInput) || errors.Is(e, io.EOF) {
		return "invalid_input"
	}
	if errors.Is(e, ErrUnauthorized) || auth.IsUnauthorized(e) {
		return "unauthorized"
	}
	if r, ok := tgerr.As(e); ok {
		if strings.HasPrefix(r.Type, "FLOOD_") {
			return "rate_limited"
		}
		if strings.HasPrefix(r.Type, "PHONE_") || strings.HasPrefix(r.Type, "PASSWORD_") || strings.HasPrefix(r.Type, "SESSION_") {
			return "auth_failed"
		}
	}
	var n net.Error
	if errors.As(e, &n) {
		return "network_error"
	}
	return "operation_failed"
}
func MachineError(w io.Writer, e error) error {
	return json.NewEncoder(w).Encode(map[string]any{"version": 1, "type": "error", "code": ErrorCode(e)})
}
