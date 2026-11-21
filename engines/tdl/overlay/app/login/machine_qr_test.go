package login

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/gotd/neo"
	tdclock "github.com/gotd/td/clock"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"github.com/gotd/td/tgmock"
	"io"
	"strings"
	"testing"
	"time"
)

type qrFake struct {
	fakeAccount
	exports, imports, passwords int
	token                       qrlogin.Token
	err                         error
	updates                     chan struct{}
	afterExport                 func()
	verified                    bool
}

func (f *qrFake) Export(context.Context, ...int64) (qrlogin.Token, error) {
	f.exports++
	if f.afterExport != nil {
		f.afterExport()
	}
	return f.token, nil
}
func (f *qrFake) Import(context.Context) (*tg.AuthAuthorization, error) {
	f.imports++
	if f.err != nil {
		return nil, f.err
	}
	f.authorized = f.verified
	return &tg.AuthAuthorization{}, nil
}
func (f *qrFake) Password(context.Context, string) (*tg.AuthAuthorization, error) {
	f.passwords++
	f.authorized = true
	return &tg.AuthAuthorization{}, nil
}
func qrFixture() (*qrFake, *io.PipeReader, *io.PipeWriter) {
	r, w := io.Pipe()
	return &qrFake{fakeAccount: fakeAccount{id: 42}, token: qrlogin.NewToken([]byte("SYNTHETIC-QR-ONLY"), int(time.Now().Add(time.Minute).Unix())), updates: make(chan struct{}, 1), verified: true}, r, w
}
func TestMachineQRBufferedEarlyApproval(t *testing.T) {
	f, r, w := qrFixture()
	defer w.Close()
	f.afterExport = func() { f.updates <- struct{}{} }
	var out bytes.Buffer
	err := MachineQRLogin(context.Background(), f, r, &out, f.updates)
	if err != nil || f.exports != 1 || f.imports != 1 || !strings.Contains(out.String(), `"type":"account"`) {
		t.Fatalf("one-export confirmation failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	var e map[string]any
	json.Unmarshal([]byte(lines[0]), &e)
	if e["type"] != "qr" || len(e["pngBase64"].(string)) > 43692 {
		t.Fatal("bounded PNG event missing")
	}
}
func TestMachineQRAlreadyAuthorizedAndUnverifiedCompletion(t *testing.T) {
	for _, already := range []bool{true, false} {
		f, r, w := qrFixture()
		f.authorized = already
		f.verified = false
		f.updates <- struct{}{}
		var out bytes.Buffer
		e := MachineQRLogin(context.Background(), f, r, &out, f.updates)
		w.Close()
		if already {
			if e != nil || f.exports != 0 {
				t.Fatal("authorized session exported")
			}
		} else if !errors.Is(e, ErrUnauthorized) || strings.Contains(out.String(), `"type":"account"`) {
			t.Fatal("unverified account escaped")
		}
	}
}
func TestMachineQRExpiryCancelEOFAndFlood(t *testing.T) {
	for _, mode := range []string{"expiry", "future", "cancel", "eof", "flood"} {
		t.Run(mode, func(t *testing.T) {
			f, r, w := qrFixture()
			defer w.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "expiry":
				f.token = qrlogin.NewToken([]byte("synthetic"), int(time.Now().Unix())-1)
			case "future":
				f.token = qrlogin.NewToken([]byte("synthetic"), int(time.Now().Unix())+601)
			case "cancel":
				f.afterExport = cancel
			case "eof":
				w.Close()
			case "flood":
				f.err = tgerr.New(420, "FLOOD_WAIT_5")
				f.updates <- struct{}{}
			}
			var out bytes.Buffer
			e := MachineQRLogin(ctx, f, r, &out, f.updates)
			if e == nil || f.exports > 1 || strings.Contains(out.String(), `"type":"account"`) {
				t.Fatal("terminal failure must not refresh/authenticate")
			}
			if mode == "expiry" && ErrorCode(e) != "qr_expired" {
				t.Fatal("missing finite expiry")
			}
			if mode == "flood" && ErrorCode(e) != "rate_limited" {
				t.Fatal("missing finite flood")
			}
		})
	}
}
func TestMachineQRPasswordNonceAndStaleInput(t *testing.T) {
	for _, stale := range []bool{false, true} {
		f, r, w := qrFixture()
		f.err = auth.ErrPasswordAuthNeeded
		f.updates <- struct{}{}
		var out bytes.Buffer
		writer := &qrPromptWriter{Buffer: &out, w: w, stale: stale}
		e := MachineQRLogin(context.Background(), f, r, writer, f.updates)
		w.Close()
		if stale {
			if e == nil || f.passwords != 0 {
				t.Fatal("stale nonce accepted")
			}
		} else if e != nil || f.passwords != 1 || !strings.Contains(out.String(), `"type":"account"`) {
			t.Fatalf("2FA failed %v", e)
		}
	}
}

type qrPromptWriter struct {
	*bytes.Buffer
	w     *io.PipeWriter
	stale bool
}

func (w *qrPromptWriter) Write(b []byte) (int, error) {
	n, e := w.Buffer.Write(b)
	var v map[string]any
	json.Unmarshal(b, &v)
	if v["type"] == "input_required" {
		nonce := v["promptId"]
		if w.stale {
			nonce = "stale"
		}
		reply, _ := json.Marshal(map[string]any{"promptId": nonce, "text": "SYNTHETIC-PASSWORD"})
		go func() { w.w.Write(append(reply, '\n')) }()
	}
	return n, e
}

// The pinned helper's unbuffered default would lose this update before a receiver exists.
type qrDispatcher struct{ handler tg.LoginTokenHandler }

func (d *qrDispatcher) OnLoginToken(h tg.LoginTokenHandler) { d.handler = h }
func TestMachineQRUpdateDuringRenderingIsBuffered(t *testing.T) {
	f, r, w := qrFixture()
	defer w.Close()
	d := &qrDispatcher{}
	updates := BufferedLoginToken(d)
	out := &qrRenderWriter{d: d}
	if e := MachineQRLogin(context.Background(), f, r, out, updates); e != nil || f.imports != 1 {
		t.Fatalf("render-time approval lost: %v", e)
	}
}

type qrRenderWriter struct {
	bytes.Buffer
	d *qrDispatcher
}

func (w *qrRenderWriter) Write(b []byte) (int, error) {
	if bytes.Contains(b, []byte(`"type":"qr"`)) {
		for i := 0; i < 3; i++ {
			w.d.handler(context.Background(), tg.Entities{}, &tg.UpdateLoginToken{})
		}
	}
	return w.Buffer.Write(b)
}
func TestMachineQRClockExpiryHasNoRefresh(t *testing.T) {
	f, r, w := qrFixture()
	defer w.Close()
	clock := &qrTestClock{Time: neo.NewTime(time.Now()), ready: make(chan struct{})}
	f.token = qrlogin.NewToken([]byte("synthetic"), int(clock.Now().Add(time.Second).Unix()))
	var out bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- machineQRLogin(context.Background(), f, r, &out, f.updates, clock) }()
	<-clock.ready
	clock.Travel(2 * time.Second)
	if e := <-done; !errors.Is(e, ErrQRExpired) || f.exports != 1 || f.imports != 0 {
		t.Fatalf("expiry refreshed: %v", e)
	}
}
func TestMachineIdentityContradictoryStatus(t *testing.T) {
	f := &qrContradiction{fakeAccount: fakeAccount{authorized: true, id: 42}}
	var out bytes.Buffer
	if e := MachineIdentity(context.Background(), f, &out); !errors.Is(e, ErrUnauthorized) || out.Len() != 0 {
		t.Fatal("contradictory status accepted")
	}
}

type qrContradiction struct{ fakeAccount }

func (f *qrContradiction) Status(context.Context) (*auth.Status, error) {
	return &auth.Status{Authorized: true, User: &tg.User{ID: 43}}, nil
}

type qrTestClock struct {
	*neo.Time
	ready chan struct{}
}

func (c *qrTestClock) Timer(d time.Duration) tdclock.Timer {
	timer := c.Time.Timer(d)
	close(c.ready)
	return timer
}

// Runs the production state machine through the pinned SDK's actual Import,
// with only the MTProto invoker replaced. No socket or real account is involved.
func TestMachineQRSDKConfirmationMigration(t *testing.T) {
	mock := tgmock.New(t)
	migrated := false
	sdk := qrlogin.NewQR(tg.NewClient(mock), 12345, "synthetic-app-hash", qrlogin.Options{Migrate: func(_ context.Context, dc int) error {
		if dc != 2 {
			t.Fatal("wrong migration DC")
		}
		migrated = true
		return nil
	}})
	mock.ExpectCall(&tg.AuthExportLoginTokenRequest{APIID: 12345, APIHash: "synthetic-app-hash"}).ThenResult(&tg.AuthLoginToken{Token: []byte("synthetic-initial-token"), Expires: int(time.Now().Add(time.Minute).Unix())}).ExpectCall(&tg.AuthExportLoginTokenRequest{APIID: 12345, APIHash: "synthetic-app-hash"}).ThenResult(&tg.AuthLoginTokenMigrateTo{DCID: 2, Token: []byte("synthetic-migration-token")}).ExpectCall(&tg.AuthImportLoginTokenRequest{Token: []byte("synthetic-migration-token")}).ThenResult(&tg.AuthLoginTokenSuccess{Authorization: &tg.AuthAuthorization{User: &tg.User{ID: 42}}})
	f, r, w := qrFixture()
	defer w.Close()
	f.updates <- struct{}{}
	client := &qrSDKClient{qrFake: f, sdk: sdk}
	var out bytes.Buffer
	if e := MachineQRLogin(context.Background(), client, r, &out, f.updates); e != nil || !migrated || !strings.Contains(out.String(), `"accountId":"42"`) {
		t.Fatalf("SDK import/migration integration failed %v", e)
	}
}

type qrSDKClient struct {
	*qrFake
	sdk qrlogin.QR
}

func (c *qrSDKClient) Export(ctx context.Context, ids ...int64) (qrlogin.Token, error) {
	return c.sdk.Export(ctx, ids...)
}
func (c *qrSDKClient) Import(ctx context.Context) (*tg.AuthAuthorization, error) {
	a, e := c.sdk.Import(ctx)
	c.authorized = e == nil
	return a, e
}

type qrAuthMismatch struct{ *qrFake }

func (c *qrAuthMismatch) Import(context.Context) (*tg.AuthAuthorization, error) {
	c.authorized = true
	return &tg.AuthAuthorization{User: &tg.User{ID: 43}}, nil
}
func TestMachineQRImportIdentityMustMatchFreshSelf(t *testing.T) {
	f, r, w := qrFixture()
	defer w.Close()
	f.updates <- struct{}{}
	var out bytes.Buffer
	e := MachineQRLogin(context.Background(), &qrAuthMismatch{f}, r, &out, f.updates)
	if !errors.Is(e, ErrUnauthorized) || strings.Contains(out.String(), `"type":"account"`) {
		t.Fatal("contradictory import identity accepted")
	}
}

func TestMachineQRStaleInputBefore2FACannotAuthorize(t *testing.T) {
	f, r, w := qrFixture()
	defer w.Close()
	f.err = auth.ErrPasswordAuthNeeded
	sent := make(chan struct{})
	go func() {
		w.Write([]byte("{\"promptId\":\"stale-before-prompt\",\"text\":\"SYNTHETIC-STALE\"}\n"))
		close(sent)
	}()
	f.afterExport = func() { <-sent; f.updates <- struct{}{} }
	var out bytes.Buffer
	e := MachineQRLogin(context.Background(), f, r, &out, f.updates)
	if e == nil || f.passwords != 0 || strings.Contains(out.String(), `"type":"account"`) {
		t.Fatal("pre-prompt input authorized2FA")
	}
}
