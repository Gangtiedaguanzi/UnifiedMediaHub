package login

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

type flowFake struct{ fakeAccount }

func (f *flowFake) IfNecessary(ctx context.Context, flow auth.Flow) error {
	f.login++
	if f.authorized {
		return nil
	}
	if e := flow.Run(ctx, f); e != nil {
		return e
	}
	f.authorized = true
	return nil
}
func (f *flowFake) SendCode(context.Context, string, auth.SendCodeOptions) (tg.AuthSentCodeClass, error) {
	return &tg.AuthSentCode{PhoneCodeHash: "synthetic-hash", Type: &tg.AuthSentCodeTypeApp{Length: 5}}, nil
}
func (f *flowFake) SignIn(context.Context, string, string, string) (*tg.AuthAuthorization, error) {
	return nil, auth.ErrPasswordAuthNeeded
}
func (f *flowFake) Password(context.Context, string) (*tg.AuthAuthorization, error) {
	f.authorized = true
	return &tg.AuthAuthorization{}, nil
}
func (f *flowFake) ResendCode(context.Context, string, string) (tg.AuthSentCodeClass, error) {
	return nil, errors.New("unexpected resend")
}
func (f *flowFake) SignUp(context.Context, auth.SignUp) (*tg.AuthAuthorization, error) {
	return nil, errors.New("unexpected signup")
}

func TestMachineSubprocess(t *testing.T) {
	if os.Getenv("UMH_SYNTHETIC_CHILD") == "1" {
		f := &flowFake{fakeAccount: fakeAccount{id: 9007199254740993}}
		if e := MachineLogin(context.Background(), f, os.Stdin, os.Stdout); e != nil {
			MachineError(os.Stdout, e)
			os.Exit(2)
		}
		os.Exit(0)
	}
	for _, fail := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		c := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMachineSubprocess$")
		c.Env = append(os.Environ(), "UMH_SYNTHETIC_CHILD=1")
		in, _ := c.StdinPipe()
		out, _ := c.StdoutPipe()
		var stderr bytes.Buffer
		c.Stderr = &stderr
		if e := c.Start(); e != nil {
			t.Fatal(e)
		}
		scan := bufio.NewScanner(out)
		var transcript strings.Builder
		count := 0
		account := false
		for scan.Scan() {
			line := scan.Text()
			transcript.WriteString(line)
			var event map[string]any
			if json.Unmarshal([]byte(line), &event) != nil {
				t.Fatal("non JSON output")
			}
			if event["type"] == "input_required" {
				count++
				id := event["promptId"]
				if fail {
					id = "stale"
				}
				b, _ := json.Marshal(map[string]any{"promptId": id, "text": "secret-合成"})
				in.Write(append(b, '\n'))
			}
			if event["type"] == "account" {
				account = event["accountId"] == "9007199254740993"
			}
		}
		in.Close()
		e := c.Wait()
		cancel()
		if fail && (e == nil || account) || !fail && (e != nil || !account || count != 3) {
			t.Fatal("incorrect machine outcome")
		}
		if strings.Contains(transcript.String()+stderr.String(), "secret-") || stderr.Len() != 0 {
			t.Fatal("secret or raw diagnostic leaked")
		}
	}
}
func TestSanitizedErrors(t *testing.T) {
	for _, e := range []error{errors.New("synthetic-secret"), context.Canceled, ErrUnauthorized} {
		var b bytes.Buffer
		MachineError(&b, e)
		if strings.Contains(b.String(), "secret") || !json.Valid(bytes.TrimSpace(b.Bytes())) {
			t.Fatal("unsafe diagnostics")
		}
	}
}
