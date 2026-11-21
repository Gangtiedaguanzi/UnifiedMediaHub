package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/go-faster/jx"
	"github.com/gotd/td/telegram/message/peer"
	"github.com/gotd/td/telegram/peers"
	"github.com/gotd/td/tg"
	"github.com/iyear/tdl/core/util/tutil"
	"testing"
)

type exportFake struct {
	m     *peers.Manager
	calls []string
}

func (f *exportFake) ResolveUserID(c context.Context, id int64) (peers.User, error) {
	f.calls = append(f.calls, "user")
	return f.m.User(&tg.User{ID: id}), nil
}
func (f *exportFake) ResolveChatID(c context.Context, id int64) (peers.Chat, error) {
	f.calls = append(f.calls, "chat")
	return f.m.Chat(&tg.Chat{ID: id}), nil
}
func (f *exportFake) ResolveChannelID(c context.Context, id int64) (peers.Channel, error) {
	f.calls = append(f.calls, "channel")
	return f.m.Channel(&tg.Channel{ID: id}), nil
}
func (f *exportFake) Resolve(c context.Context, name string) (peers.Peer, error) {
	f.calls = append(f.calls, "name")
	return f.m.Channel(&tg.Channel{ID: 7}), nil
}
func TestStrictSelector(t *testing.T) {
	f := &exportFake{m: peers.Options{}.Build(nil)}
	for _, o := range []ExportOptions{{StrictPeer: true}, {StrictPeer: true, Chat: "7"}, {StrictPeer: true, Chat: "-1007"}, {Chat: "7", PeerType: "unknown"}, {Chat: "name", PeerType: "channel"}} {
		if _, e := resolveStrictExport(context.Background(), f, o); e == nil || len(f.calls) != 0 {
			t.Fatal("invalid selector touched resolver")
		}
	}
	p, e := resolveStrictExport(context.Background(), f, ExportOptions{StrictPeer: true, Chat: "publicName"})
	if e != nil || p.ID() != 7 || tutil.InputPeerType(p.InputPeer()) != "channel" || len(f.calls) != 1 || f.calls[0] != "name" {
		t.Fatal("public type lost")
	}
}

func TestTypedListCollisions(t *testing.T) {
	e := peer.NewEntities(map[int64]*tg.User{7: {ID: 7}}, map[int64]*tg.Chat{7: {ID: 7}}, map[int64]*tg.Channel{7: {ID: 7, Megagroup: true}})
	channel, err := processChannel(context.Background(), nil, 7, e)
	if err != nil {
		t.Fatal(err)
	}
	rows := []*Dialog{processUser(7, e), processChat(7, e), channel}
	for i, k := range []string{"user", "chat", "channel"} {
		if rows[i] == nil || rows[i].PeerType != k {
			t.Fatal("lost namespace")
		}
	}
	keys := map[string]bool{}
	for _, p := range []tg.PeerClass{&tg.PeerUser{UserID: 7}, &tg.PeerChat{ChatID: 7}, &tg.PeerChannel{ChannelID: 7}} {
		keys[tutil.PeerKey(p)] = true
	}
	if len(keys) != 3 {
		t.Fatal("collision")
	}
	b, _ := json.Marshal(rows)
	if !json.Valid(b) {
		t.Fatal("invalid JSON")
	}
}
func TestTypedExportRootEvenEmpty(t *testing.T) {
	for _, kind := range []string{"user", "chat", "channel"} {
		for _, nonempty := range []bool{false, true} {
			var b bytes.Buffer
			e := jx.NewStreamingEncoder(&b, 512)
			e.ObjStart()
			writeExportHeader(e, 9007199254740993, kind)
			e.FieldStart("messages")
			e.ArrStart()
			if nonempty {
				e.Raw([]byte(`{"id":7}`))
			}
			e.ArrEnd()
			e.ObjEnd()
			e.Close()
			var v struct {
				ID       json.Number       `json:"id"`
				PeerType string            `json:"peer_type"`
				Messages []json.RawMessage `json:"messages"`
			}
			if json.Unmarshal(b.Bytes(), &v) != nil || v.ID.String() != "9007199254740993" || v.PeerType != kind || len(v.Messages) != map[bool]int{false: 0, true: 1}[nonempty] {
				t.Fatal("lost export identity")
			}
		}
	}
}
