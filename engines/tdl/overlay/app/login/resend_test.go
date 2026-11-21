package login

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

type resendFake struct {
	fakeAccount
	calls       []string
	hash        string
	resendError error
	unsupported bool
	timeout     int
	twoFA       bool
}

func (f *resendFake) sent(hash string) *tg.AuthSentCode {
	s := &tg.AuthSentCode{PhoneCodeHash: hash, Type: &tg.AuthSentCodeTypeApp{Length: 5}}
	s.SetNextType(&tg.AuthCodeTypeSMS{})
	s.SetTimeout(f.timeout)
	if f.unsupported {
		s.Type = &tg.AuthSentCodeTypeFirebaseSMS{Length: 5}
	}
	return s
}
func (f *resendFake) SendCode(context.Context, string, auth.SendCodeOptions) (tg.AuthSentCodeClass, error) {
	f.calls = append(f.calls, "send")
	return f.sent("PRIVATE_HASH_OLD"), nil
}
func (f *resendFake) ResendCode(_ context.Context, phone, hash string) (tg.AuthSentCodeClass, error) {
	f.calls = append(f.calls, "resend")
	if hash != "PRIVATE_HASH_OLD" && hash != "PRIVATE_HASH_NEW" {
		panic("bad resend hash")
	}
	if f.resendError != nil {
		return nil, f.resendError
	}
	return f.sent("PRIVATE_HASH_NEW"), nil
}
func (f *resendFake) SignIn(_ context.Context, phone, code, hash string) (*tg.AuthAuthorization, error) {
	f.calls = append(f.calls, "signin")
	f.hash = hash
	if f.twoFA {
		return nil, auth.ErrPasswordAuthNeeded
	}
	f.authorized = true
	return &tg.AuthAuthorization{}, nil
}
func (f *resendFake) Password(context.Context, string) (*tg.AuthAuthorization, error) {
	f.calls = append(f.calls, "password")
	f.authorized = true
	return &tg.AuthAuthorization{}, nil
}
func TestOwnedLoginResendState(t *testing.T) {
	for _, mode := range []string{"resend", "early", "stale", "unsupported", "flood", "cancel", "twofa", "exhausted"} {
		t.Run(mode, func(t *testing.T) {
			inR, inW, _ := os.Pipe()
			outR, outW, _ := os.Pipe()
			defer inW.Close()
			defer outR.Close()
			defer outW.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			f := &resendFake{fakeAccount: fakeAccount{id: 9}, unsupported: mode == "unsupported", twoFA: mode == "twofa"}
			if mode == "early" {
				f.timeout = 60
			}
			if mode == "flood" {
				f.resendError = tgerr.New(420, "FLOOD_WAIT_3600")
			}
			done := make(chan error, 1)
			go func() { done <- MachineLogin(ctx, f, inR, outW); outW.Close() }()
			reader := bufio.NewReader(outR)
			prompts := 0
			oldNonce := ""
			account := false
			for {
				line, e := reader.ReadBytes('\n')
				if e == io.EOF {
					break
				}
				if e != nil {
					t.Fatal(e)
				}
				if strings.Contains(string(line), "PRIVATE_HASH") {
					t.Fatal("secret leaked")
				}
				var event map[string]any
				if json.Unmarshal(line, &event) != nil {
					t.Fatal("bad JSON")
				}
				if event["type"] == "account" {
					account = true
					continue
				}
				prompts++
				nonce := event["promptId"].(string)
				reply := map[string]string{"promptId": nonce, "text": "synthetic"}
				if event["field"] == "code" {
					d := event["delivery"].(map[string]any)
					if d["method"] != "app" || d["nextMethod"] != "sms" {
						t.Fatal("method lost")
					}
					if mode == "cancel" {
						cancel()
						continue
					}
					if mode == "early" || mode == "flood" || mode == "resend" && oldNonce == "" || mode == "stale" && oldNonce == "" || mode == "exhausted" {
						delete(reply, "text")
						reply["action"] = "resend"
					}
					if mode == "stale" && oldNonce != "" {
						reply["promptId"] = oldNonce
					}
					if oldNonce == "" {
						oldNonce = nonce
					}
				}
				b, _ := json.Marshal(reply)
				inW.Write(append(b, '\n'))
			}
			err := <-done
			if mode == "resend" || mode == "twofa" {
				if err != nil || !account {
					t.Fatalf("success lost %v", err)
				}
				if mode == "resend" && f.hash != "PRIVATE_HASH_NEW" {
					t.Fatal("stale hash signin")
				}
				if mode == "twofa" && (len(f.calls) == 0 || f.calls[len(f.calls)-1] != "password") {
					t.Fatal("2FA lost")
				}
			} else {
				if err == nil || account {
					t.Fatal("invalid attempt succeeded")
				}
				for _, c := range f.calls {
					if c == "signin" {
						t.Fatal("unexpected signin")
					}
				}
			}
			n := 0
			for _, c := range f.calls {
				if c == "resend" {
					n++
				}
			}
			expected := map[string]int{"resend": 1, "stale": 1, "flood": 1, "exhausted": 3}[mode]
			if n != expected {
				t.Fatalf("resend calls %d want %d", n, expected)
			}
			if mode == "unsupported" && prompts != 1 {
				t.Fatal("unsupported method prompted for code")
			}
		})
	}
}
