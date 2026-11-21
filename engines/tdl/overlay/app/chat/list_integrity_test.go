package chat

import (
	"context"
	"errors"
	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"github.com/iyear/tdl/core/logctx"
	"github.com/iyear/tdl/core/storage"
	clientcore "github.com/iyear/tdl/core/tclient"
	"go.uber.org/zap"
	"testing"
	"time"
)

type listMemory map[string][]byte

func (m listMemory) Get(_ context.Context, k string) ([]byte, error) {
	if b, ok := m[k]; ok {
		return b, nil
	}
	return nil, storage.ErrNotFound
}
func (m listMemory) Set(_ context.Context, k string, v []byte) error { m[k] = v; return nil }
func (m listMemory) Delete(_ context.Context, k string) error        { delete(m, k); return nil }
func listResult(out bin.Decoder, value bin.Encoder) error {
	var b bin.Buffer
	if err := value.Encode(&b); err != nil {
		return err
	}
	return out.Decode(&b)
}
func pageOfDialogs(n int) *tg.MessagesDialogsSlice {
	p := &tg.MessagesDialogsSlice{Count: n + 1}
	for i := 1; i <= n; i++ {
		id := int64(i)
		c := &tg.Channel{ID: id, Title: "synthetic", Photo: &tg.ChatPhotoEmpty{}}
		c.SetAccessHash(id + 100)
		p.Chats = append(p.Chats, c)
		p.Dialogs = append(p.Dialogs, &tg.Dialog{Peer: &tg.PeerChannel{ChannelID: id}, TopMessage: 7})
		p.Messages = append(p.Messages, &tg.Message{ID: 7, PeerID: &tg.PeerChannel{ChannelID: id}, Date: i + 1000})
	}
	// Deliberately shuffle duplicate message IDs: last array message is not last dialog.
	p.Messages[0], p.Messages[n-1] = p.Messages[n-1], p.Messages[0]
	return p
}
func TestDialogPaginationUsesPeerAndMessage(t *testing.T) {
	ctx := logctx.With(context.Background(), zap.NewNop())
	calls := 0
	p := pageOfDialogs(100)
	// Same numeric peer IDs across all three namespaces, plus MessageService.
	p.Users = []tg.UserClass{&tg.User{ID: 1, AccessHash: 111}}
	p.Chats = append(p.Chats, &tg.Chat{ID: 1, Title: "group", Photo: &tg.ChatPhotoEmpty{}})
	p.Dialogs[0] = &tg.Dialog{Peer: &tg.PeerUser{UserID: 1}, TopMessage: 7}
	p.Dialogs[1] = &tg.Dialog{Peer: &tg.PeerChat{ChatID: 1}, TopMessage: 7}
	p.Messages = append(p.Messages, &tg.Message{ID: 7, PeerID: &tg.PeerUser{UserID: 1}, Date: 9001}, &tg.MessageService{ID: 7, PeerID: &tg.PeerChat{ChatID: 1}, Date: 9002, Action: &tg.MessageActionEmpty{}})
	api := tg.NewClient(telegram.InvokeFunc(func(_ context.Context, in bin.Encoder, out bin.Decoder) error {
		calls++
		q := in.(*tg.MessagesGetDialogsRequest)
		if calls == 1 {
			return listResult(out, p)
		}
		if q.OffsetID != 7 || q.OffsetDate != 1100 || q.OffsetPeer.(*tg.InputPeerChannel).ChannelID != 100 || q.OffsetPeer.(*tg.InputPeerChannel).AccessHash != 200 {
			t.Fatalf("wrong next RPC offset: %+v", q)
		}
		return listResult(out, &tg.MessagesDialogs{})
	}))
	rows, skipped, err := fetchDialogsWithErrorHandling(ctx, api)
	if err != nil || skipped != 0 || len(rows) != 100 || calls != 2 {
		t.Fatalf("rows=%d skipped=%d calls=%d err=%v", len(rows), skipped, calls, err)
	}
	if rows[0].Last.GetDate() != 9001 || rows[1].Last.GetDate() != 9002 || rows[2].Last.GetDate() != 1003 || rows[99].Last.GetDate() != 1100 {
		t.Fatal("message identity collision")
	}
}
func TestActualListTerminalBarrierStopsAllLaterRPC(t *testing.T) {
	for _, phase := range []string{"first", "second", "blocked", "topic", "cancel"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(logctx.With(context.Background(), zap.NewNop()), time.Second)
			defer cancel()
			calls := 0
			terminal := error(tgerr.New(420, "FLOOD_WAIT_3600"))
			if phase == "cancel" {
				terminal = context.Canceled
			}
			var inv tg.Invoker = telegram.InvokeFunc(func(_ context.Context, in bin.Encoder, out bin.Decoder) error {
				calls++
				t.Logf("RPC %T", in)
				switch q := in.(type) {
				case *tg.MessagesGetDialogsRequest:
					if phase == "cancel" {
						cancel()
						return terminal
					}
					if phase == "first" || phase == "second" && calls == 2 {
						return terminal
					}
					n := 2
					if phase == "second" {
						n = 100
					}
					p := pageOfDialogs(n)
					for _, c := range p.Chats {
						c.(*tg.Channel).Forum = true
					}
					return listResult(out, p)
				case *tg.ContactsGetBlockedRequest:
					if phase == "blocked" {
						return terminal
					}
					return listResult(out, &tg.ContactsBlocked{})
				case *tg.MessagesGetForumTopicsRequest:
					if phase != "topic" || q.Peer.(*tg.InputPeerChannel).ChannelID != 1 {
						t.Fatal("unexpected later topic RPC")
					}
					return terminal
				default:
					t.Fatalf("unexpected RPC %T", in)
					return nil
				}
			})
			chain := clientcore.NewDefaultMiddlewares(ctx, time.Minute, true)
			for i := len(chain) - 1; i >= 0; i-- {
				inv = chain[i].Handle(inv)
			}
			err := listWithAPI(ctx, tg.NewClient(inv), listMemory{}, ListOptions{Filter: "true", Output: ListOutputJson})
			expected := map[string]int{"first": 1, "second": 2, "blocked": 2, "topic": 4, "cancel": 1}[phase]
			if err == nil || calls != expected || (phase != "cancel" && ctx.Err() != nil) {
				t.Fatalf("barrier lost err=%v calls=%d", err, calls)
			}
			if phase == "cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			} else if !tgerr.Is(err, "FLOOD_WAIT") {
				t.Fatal(err)
			}
		})
	}
}

func TestMissingEntitySkipAndMissingFinalCursorAreDifferent(t *testing.T) {
	for _, final := range []bool{false, true} {
		t.Run(map[bool]string{false: "skipped row continues", true: "missing cursor fails"}[final], func(t *testing.T) {
			p := pageOfDialogs(100)
			index := 0
			if final {
				index = 99
			}
			p.Chats = append(p.Chats[:index], p.Chats[index+1:]...)
			calls := 0
			api := tg.NewClient(telegram.InvokeFunc(func(_ context.Context, _ bin.Encoder, out bin.Decoder) error {
				calls++
				if calls == 1 {
					return listResult(out, p)
				}
				return listResult(out, &tg.MessagesDialogs{})
			}))
			rows, skipped, err := fetchDialogsWithErrorHandling(logctx.With(context.Background(), zap.NewNop()), api)
			if final {
				if err == nil || calls != 1 {
					t.Fatal("missing final cursor certified success")
				}
			} else if err != nil || skipped != 1 || len(rows) != 99 || calls != 2 {
				t.Fatalf("skip boundary: %d %d %d %v", len(rows), skipped, calls, err)
			}
		})
	}
}
