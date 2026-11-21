package login

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"testing"
)

type fakeAccount struct {
	authorized                   bool
	id                           int64
	status, self, login, history int
}

func (f *fakeAccount) Status(context.Context) (*auth.Status, error) {
	f.status++
	return &auth.Status{Authorized: f.authorized}, nil
}
func (f *fakeAccount) Self(context.Context) (*tg.User, error) {
	f.self++
	return &tg.User{ID: f.id, FirstName: "synthetic"}, nil
}
func (f *fakeAccount) IfNecessary(context.Context, auth.Flow) error {
	f.login++
	f.authorized = true
	return nil
}
func TestMachineIdentity(t *testing.T) {
	for _, id := range []int64{9007199254740993, 9007199254740995} {
		f := &fakeAccount{authorized: true, id: id}
		var b bytes.Buffer
		if e := MachineIdentity(context.Background(), f, &b); e != nil {
			t.Fatal(e)
		}
		var event map[string]any
		json.Unmarshal(b.Bytes(), &event)
		if event["accountId"] != fmtID(id) || f.self != 1 || f.status != 1 || f.login != 0 || f.history != 0 {
			t.Fatal("identity boundary")
		}
	}
	f := &fakeAccount{}
	var b bytes.Buffer
	if e := MachineIdentity(context.Background(), f, &b); e == nil || b.Len() != 0 || f.login != 0 || f.self != 0 || f.history != 0 {
		t.Fatal("unauthorized boundary")
	}
}
