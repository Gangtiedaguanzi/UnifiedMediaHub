package tutil

import (
	"context"
	"errors"
	"github.com/gotd/td/telegram/peers"
	"github.com/gotd/td/tg"
	"testing"
)

type fakeResolver struct {
	calls []string
	fail  bool
	wrong bool
	m     *peers.Manager
}

func (f *fakeResolver) check(k string) error {
	f.calls = append(f.calls, k)
	if f.fail {
		return errors.New("synthetic")
	}
	return nil
}
func (f *fakeResolver) ResolveUserID(c context.Context, id int64) (peers.User, error) {
	e := f.check("user")
	if f.wrong {
		id++
	}
	return f.m.User(&tg.User{ID: id}), e
}
func (f *fakeResolver) ResolveChatID(c context.Context, id int64) (peers.Chat, error) {
	e := f.check("chat")
	return f.m.Chat(&tg.Chat{ID: id}), e
}
func (f *fakeResolver) ResolveChannelID(c context.Context, id int64) (peers.Channel, error) {
	e := f.check("channel")
	return f.m.Channel(&tg.Channel{ID: id}), e
}
func TestTypedSingleNamespace(t *testing.T) {
	for _, k := range []string{"user", "chat", "channel"} {
		for _, fail := range []bool{false, true} {
			f := &fakeResolver{m: peers.Options{}.Build(nil), fail: fail}
			p, e := ResolveTyped(context.Background(), f, k, "9007199254740993")
			if len(f.calls) != 1 || f.calls[0] != k || (e != nil) != fail {
				t.Fatal("wrong dispatch", f.calls, e)
			}
			if !fail && (p.ID() != 9007199254740993 || InputPeerType(p.InputPeer()) != k) {
				t.Fatal("lost typed identity")
			}
		}
	}
}
func TestTypedRejects(t *testing.T) {
	for _, pair := range [][2]string{{"other", "1"}, {"channel", "-1001"}, {"user", "1e3"}, {"chat", "+1"}, {"chat", "9223372036854775808"}, {"user", ""}} {
		f := &fakeResolver{m: peers.Options{}.Build(nil)}
		if _, e := ResolveTyped(context.Background(), f, pair[0], pair[1]); e == nil || len(f.calls) != 0 {
			t.Fatal("invalid resolver call")
		}
	}
	f := &fakeResolver{m: peers.Options{}.Build(nil), wrong: true}
	if _, e := ResolveTyped(context.Background(), f, "user", "1"); e == nil {
		t.Fatal("accepted wrong ID")
	}
}
