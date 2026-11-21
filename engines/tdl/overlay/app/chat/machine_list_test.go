package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"github.com/iyear/tdl/core/umh"
)

func machinePage() *tg.MessagesDialogs {
	return &tg.MessagesDialogs{
		Dialogs: []tg.DialogClass{
			&tg.Dialog{Peer: &tg.PeerUser{UserID: 7}},
			&tg.Dialog{Peer: &tg.PeerChat{ChatID: 7}},
			&tg.Dialog{Peer: &tg.PeerChannel{ChannelID: 7}},
		},
		Users: []tg.UserClass{&tg.User{ID: 7, FirstName: "name\n", LastName: "person", Phone: "PRIVATE_PHONE"}},
		Chats: []tg.ChatClass{
			&tg.Chat{ID: 7, Title: "group", Photo: &tg.ChatPhotoEmpty{}},
			&tg.Channel{ID: 7, Title: "forum", Username: "valid_name", Forum: true, Photo: &tg.ChatPhotoEmpty{}},
		},
		Messages: []tg.MessageClass{&tg.Message{ID: 9, PeerID: &tg.PeerUser{UserID: 7}, Message: "PRIVATE_MESSAGE"}},
	}
}

// machineAPI serves `result` as the whole main list and an empty archive folder.
func machineAPI(t *testing.T, result tg.MessagesDialogsClass, calls *int) *tg.Client {
	t.Helper()
	return tg.NewClient(telegram.InvokeFunc(func(_ context.Context, in bin.Encoder, out bin.Decoder) error {
		*calls++
		q, ok := in.(*tg.MessagesGetDialogsRequest)
		if !ok || *calls > 2 {
			t.Fatalf("unexpected RPC %T, calls=%d", in, *calls)
		}
		if q.Limit != machineDialogBatch || q.OffsetDate != 0 || q.OffsetID != 0 || q.Hash != 0 || q.ExcludePinned {
			t.Fatal("wrong initial request")
		}
		if _, ok := q.OffsetPeer.(*tg.InputPeerEmpty); !ok {
			t.Fatal("not an initial page")
		}
		folder, hasFolder := q.GetFolderID()
		if *calls == 1 && hasFolder {
			t.Fatal("main list must not be folder restricted")
		}
		if *calls == 2 {
			if !hasFolder || folder != 1 {
				t.Fatal("second request must read the archive folder")
			}
			return listResult(out, &tg.MessagesDialogs{})
		}
		return listResult(out, result)
	}))
}

// machinePagedPage builds a slice page of users first..first+n-1, each with a
// top message whose date decreases with the user ID.
func machinePagedPage(first, n int) *tg.MessagesDialogsSlice {
	p := &tg.MessagesDialogsSlice{Count: 100000}
	for i := first; i < first+n; i++ {
		id := int64(i)
		p.Dialogs = append(p.Dialogs, &tg.Dialog{Peer: &tg.PeerUser{UserID: id}, TopMessage: 1000 + i})
		p.Users = append(p.Users, &tg.User{ID: id, FirstName: "user", LastName: strconv.Itoa(i), AccessHash: id * 31})
		p.Messages = append(p.Messages, &tg.Message{ID: 1000 + i, PeerID: &tg.PeerUser{UserID: id}, Date: 2000000 - i, Message: "PRIVATE_MESSAGE"})
	}
	return p
}

type machineStep struct {
	folder int
	result tg.MessagesDialogsClass
	err    error
}

// machineScript serves each step in order and records the requests made.
func machineScript(t *testing.T, steps []machineStep, reqs *[]*tg.MessagesGetDialogsRequest) *tg.Client {
	t.Helper()
	return tg.NewClient(telegram.InvokeFunc(func(_ context.Context, in bin.Encoder, out bin.Decoder) error {
		q, ok := in.(*tg.MessagesGetDialogsRequest)
		if !ok || len(*reqs) >= len(steps) {
			t.Fatalf("unexpected RPC %T after %d requests", in, len(*reqs))
		}
		step := steps[len(*reqs)]
		*reqs = append(*reqs, q)
		folder, hasFolder := q.GetFolderID()
		if (step.folder == 0 && hasFolder) || (step.folder != 0 && (!hasFolder || folder != step.folder)) {
			t.Fatalf("request %d read the wrong folder", len(*reqs))
		}
		if step.err != nil {
			return step.err
		}
		return listResult(out, step.result)
	}))
}

func runMachine(t *testing.T, api *tg.Client, limit int) MachineChats {
	t.Helper()
	var out bytes.Buffer
	if err := MachineList(context.Background(), api, limit, &out); err != nil {
		t.Fatal(err)
	}
	var r MachineChats
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestMachineListPagesMainListThenArchive(t *testing.T) {
	var reqs []*tg.MessagesGetDialogsRequest
	archive := machinePagedPage(500, 5)
	r := runMachine(t, machineScript(t, []machineStep{
		{0, machinePagedPage(1, 100), nil},
		{0, machinePagedPage(101, 30), nil},
		{1, archive, nil},
	}, &reqs), 5000)
	if len(r.Chats) != 135 || r.Completeness != "complete" || r.Truncated || r.ResponseKind != "full" {
		t.Fatalf("wrong paged result: %d chats, %+v", len(r.Chats), r)
	}
	if r.Chats[134].ID != "504" || r.Chats[0].Title != "user 1" {
		t.Fatal("archived chats or order lost")
	}
	next := reqs[1]
	peer, ok := next.OffsetPeer.(*tg.InputPeerUser)
	if !ok || peer.UserID != 100 || peer.AccessHash != 100*31 || next.OffsetID != 1100 || next.OffsetDate != 2000000-100 {
		t.Fatalf("cursor not taken from the page's last dialog: %+v", next)
	}
	if _, ok := reqs[2].OffsetPeer.(*tg.InputPeerEmpty); !ok || reqs[2].OffsetID != 0 {
		t.Fatal("archive folder must start from its first page")
	}
}

func TestMachineListStopsPagingAtLimit(t *testing.T) {
	var reqs []*tg.MessagesGetDialogsRequest
	r := runMachine(t, machineScript(t, []machineStep{
		{0, machinePagedPage(1, 100), nil},
		{0, machinePagedPage(101, 100), nil},
	}, &reqs), 150)
	if len(reqs) != 2 || len(r.Chats) != 150 || !r.Truncated || r.Completeness != "partial" || r.ResponseKind != "slice" {
		t.Fatalf("limit not enforced across pages: %d requests, %+v", len(reqs), r)
	}
}

func TestMachineListFloodAfterFirstPageReturnsPartial(t *testing.T) {
	var reqs []*tg.MessagesGetDialogsRequest
	r := runMachine(t, machineScript(t, []machineStep{
		{0, machinePagedPage(1, 100), nil},
		{0, nil, tgerr.New(420, "FLOOD_WAIT_30")},
	}, &reqs), 5000)
	if len(r.Chats) != 100 || !r.Truncated || r.Completeness != "partial" {
		t.Fatalf("partial result lost on flood wait: %+v", r)
	}
}

func TestMachineListRejectsBrokenCursor(t *testing.T) {
	for _, bad := range []string{"repeated", "missing_date", "missing_entity"} {
		t.Run(bad, func(t *testing.T) {
			var reqs []*tg.MessagesGetDialogsRequest
			first := machinePagedPage(1, 100)
			steps := []machineStep{{0, first, nil}}
			switch bad {
			case "repeated":
				steps = append(steps, machineStep{0, machinePagedPage(1, 100), nil})
			case "missing_date":
				first.Messages = first.Messages[:99]
			case "missing_entity":
				first.Users = first.Users[:99]
			}
			var out bytes.Buffer
			if err := MachineList(context.Background(), machineScript(t, steps, &reqs), 5000, &out); err == nil || out.Len() != 0 {
				t.Fatal("broken cursor accepted")
			}
		})
	}
}

func TestMachineListSinglePageBoundedAndPrivate(t *testing.T) {
	calls := 0
	var out bytes.Buffer
	if err := MachineList(context.Background(), machineAPI(t, machinePage(), &calls), 2, &out); err != nil {
		t.Fatal(err)
	}
	var r MachineChats
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || len(r.Chats) != 2 || !r.Truncated || r.Completeness != "partial" || r.ResponseKind != "slice" || r.DuplicateCount != 0 || r.SkippedCount != 0 {
		t.Fatalf("wrong bounded result: %+v", r)
	}
	if r.Chats[0].ID != "7" || r.Chats[0].PeerType != "user" || r.Chats[1].PeerType != "chat" {
		t.Fatal("typed peers collapsed")
	}
	for _, secret := range []string{"PRIVATE", "topics", "access_hash", "messages", "phone", "offset", "\"forum\""} {
		if strings.Contains(out.String(), secret) {
			t.Fatalf("output contains forbidden field/content %s", secret)
		}
	}
	if strings.Count(out.String(), "\n") != 1 || strings.Contains(r.Chats[0].Title, "\n") {
		t.Fatal("not one sanitized record")
	}
}

func TestMachineListCompleteness(t *testing.T) {
	for _, kind := range []string{"full", "empty_full", "slice", "empty_slice", "missing", "duplicate", "unavailable", "folder"} {
		t.Run(kind, func(t *testing.T) {
			p := machinePage()
			var result tg.MessagesDialogsClass = p
			want, skipped, duplicates := "partial", 0, 0
			switch kind {
			case "full":
				want = "complete"
			case "empty_full":
				result = &tg.MessagesDialogs{}
				want = "complete"
			case "slice":
				// A short slice is the folder's last page.
				result = &tg.MessagesDialogsSlice{Count: 3, Dialogs: p.Dialogs, Users: p.Users, Chats: p.Chats}
				want = "complete"
			case "empty_slice":
				result = &tg.MessagesDialogsSlice{Count: 0}
				want = "complete"
			case "missing":
				p.Users = nil
				skipped = 1
			case "duplicate":
				p.Dialogs = append(p.Dialogs, p.Dialogs[0])
				duplicates = 1
			case "unavailable":
				p.Users = []tg.UserClass{&tg.UserEmpty{ID: 7}}
				skipped = 1
			case "folder":
				// The archive entry is read as its own folder, not skipped.
				p.Dialogs = append(p.Dialogs, &tg.DialogFolder{Folder: tg.Folder{ID: 1, Title: "archive"}, Peer: &tg.PeerUser{UserID: 7}})
				want = "complete"
			}
			calls := 0
			var out bytes.Buffer
			if err := MachineList(context.Background(), machineAPI(t, result, &calls), 10, &out); err != nil {
				t.Fatal(err)
			}
			var r MachineChats
			if err := json.Unmarshal(out.Bytes(), &r); err != nil {
				t.Fatal(err)
			}
			if r.Completeness != want || r.SkippedCount != skipped || r.DuplicateCount != duplicates || r.Truncated {
				t.Fatalf("wrong proof %+v", r)
			}
		})
	}
}

func TestMachineListValidatesEntireResponseBeforeOutput(t *testing.T) {
	for _, bad := range []string{"later_bad_id", "later_bad_entity", "conflict", "not_modified", "negative_count"} {
		t.Run(bad, func(t *testing.T) {
			p := machinePage()
			var result tg.MessagesDialogsClass = p
			switch bad {
			case "later_bad_id":
				p.Dialogs = append(p.Dialogs, &tg.Dialog{Peer: &tg.PeerUser{UserID: -1}})
			case "later_bad_entity":
				p.Users = append(p.Users, &tg.User{ID: 0})
			case "conflict":
				p.Chats = append(p.Chats, &tg.Channel{ID: 7, Title: "different", Photo: &tg.ChatPhotoEmpty{}})
			case "not_modified":
				result = &tg.MessagesDialogsNotModified{Count: 5}
			case "negative_count":
				result = &tg.MessagesDialogsSlice{Count: -1}
			}
			calls := 0
			var out bytes.Buffer
			if err := MachineList(context.Background(), machineAPI(t, result, &calls), 1, &out); err == nil || out.Len() != 0 {
				t.Fatal("invalid trailing response partially published")
			}
		})
	}
}

func TestMachineListInvalidLimitAndPreCancelMakeNoRPC(t *testing.T) {
	for _, limit := range []int{-1, 0, MachineMaxLimit + 1} {
		if err := MachineList(context.Background(), nil, limit, io.Discard); !errors.Is(err, umh.ErrInput) {
			t.Fatalf("limit not rejected: %v", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := MachineList(ctx, nil, 1, io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestMachineListTerminalErrorsAndLateCancelPublishNothing(t *testing.T) {
	for _, kind := range []string{"flood", "deadline", "cancel_after_response"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			var out bytes.Buffer
			api := tg.NewClient(telegram.InvokeFunc(func(_ context.Context, _ bin.Encoder, dst bin.Decoder) error {
				calls++
				switch kind {
				case "flood":
					return tgerr.New(420, "FLOOD_WAIT_3600")
				case "deadline":
					return context.DeadlineExceeded
				default:
					cancel()
					return listResult(dst, machinePage())
				}
			}))
			err := MachineList(ctx, api, 3, &out)
			if err == nil || calls != 1 || out.Len() != 0 {
				t.Fatal("terminal barrier lost")
			}
			if kind == "flood" && !tgerr.Is(err, "FLOOD_WAIT") {
				t.Fatal("flood changed")
			}
			if kind == "deadline" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("timeout changed")
			}
			if kind == "cancel_after_response" && !errors.Is(err, context.Canceled) {
				t.Fatal("cancel changed")
			}
		})
	}
}

type failMachineWriter struct{}

func (failMachineWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestMachineListMetadataBoundsAndWriterFailure(t *testing.T) {
	p := machinePage()
	p.Chats[1].(*tg.Channel).Title = strings.Repeat("中", 600) + "\x00"
	p.Chats[1].(*tg.Channel).Username = "PRIVATE/INVALID"
	calls := 0
	var out bytes.Buffer
	if err := MachineList(context.Background(), machineAPI(t, p, &calls), 3, &out); err != nil {
		t.Fatal(err)
	}
	var r MachineChats
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if len([]rune(r.Chats[2].Title)) != 500 || r.Chats[2].Username != "" {
		t.Fatal("unbounded metadata")
	}
	calls = 0
	if err := MachineList(context.Background(), machineAPI(t, p, &calls), 3, failMachineWriter{}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("writer failure swallowed")
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if err := MachineList(ctx, nil, 1, io.Discard); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("pre deadline ignored")
	}
}
