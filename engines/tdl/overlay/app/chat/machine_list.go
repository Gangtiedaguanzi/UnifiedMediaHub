// Bounded UMH directory projection; legacy chat ls remains unchanged.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"github.com/iyear/tdl/core/umh"
)

type MachineChat struct {
	PeerType string `json:"peer_type"`
	ID       string `json:"id"`
	Title    string `json:"title"`
	Username string `json:"username,omitempty"`
}

type MachineChats struct {
	Version        int           `json:"version"`
	Type           string        `json:"type"`
	Limit          int           `json:"limit"`
	ResponseKind   string        `json:"responseKind"`
	Chats          []MachineChat `json:"chats"`
	SkippedCount   int           `json:"skippedCount"`
	DuplicateCount int           `json:"duplicateCount"`
	Truncated      bool          `json:"truncated"`
	Completeness   string        `json:"completeness"`
}

// MachineMaxLimit bounds one directory read across the main list and archive.
const MachineMaxLimit = 5000

// machineDialogBatch is the per-request page size (Telegram's maximum).
const machineDialogBatch = 100

var errMachineDialogs = errors.New("invalid dialog response")
var machineUsername = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

// machineFolders are read in order: the main list, then the archive folder.
var machineFolders = []int{0, 1}

type machineEntity struct {
	title, username string
	available       bool
}

type machineCursor struct {
	peer string
	id   int
}

type machineNext struct {
	key  machineCursor
	peer tg.InputPeerClass
	date int
}

// MachineList pages through the main dialog list and then the archive folder
// until `limit` chats are projected or both lists end. It makes no blocked-list,
// topic, resolver or peer-cache calls. Of the returned messages only the date of
// each page's last top message is read, to build the next page's cursor; message
// content is never read or projected. A FLOOD_WAIT after at least one page ends
// the read early with a partial (truncated) result instead of discarding it.
func MachineList(ctx context.Context, api *tg.Client, limit int, w io.Writer) error {
	if limit < 1 || limit > MachineMaxLimit {
		return umh.ErrInput
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	r := MachineChats{Version: 1, Type: "chats", Limit: limit, Chats: []MachineChat{}, Completeness: "partial", ResponseKind: "full"}
	seen := map[string]bool{}
	pages := 0
folders:
	for _, folder := range machineFolders {
		offsetDate, offsetID := 0, 0
		var offsetPeer tg.InputPeerClass = &tg.InputPeerEmpty{}
		cursors := map[machineCursor]bool{}
		for {
			if len(r.Chats) >= limit {
				// More dialogs may exist; stop paging rather than reading past the bound.
				r.Truncated = true
				r.ResponseKind = "slice"
				break folders
			}
			req := &tg.MessagesGetDialogsRequest{OffsetDate: offsetDate, OffsetID: offsetID, OffsetPeer: offsetPeer, Limit: machineDialogBatch}
			if folder != 0 {
				req.SetFolderID(folder)
			}
			raw, err := api.MessagesGetDialogs(ctx, req)
			if err != nil {
				if _, flood := tgerr.AsFloodWait(err); flood && pages > 0 {
					r.Truncated = true
					r.ResponseKind = "slice"
					break folders
				}
				return err
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			pages++
			next, done, err := machineProjectPage(ctx, raw, limit, seen, &r)
			if err != nil {
				return err
			}
			if done {
				break
			}
			if cursors[next.key] {
				return errMachineDialogs
			}
			cursors[next.key] = true
			offsetPeer, offsetID, offsetDate = next.peer, next.key.id, next.date
		}
	}
	if r.ResponseKind == "full" && r.SkippedCount == 0 && r.DuplicateCount == 0 && !r.Truncated {
		r.Completeness = "complete"
	}
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Nothing reaches stdout until the entire response has passed validation.
	data = append(data, '\n')
	n, err := w.Write(data)
	if err == nil && n != len(data) {
		return io.ErrShortWrite
	}
	return err
}

func machinePeerKey(p tg.PeerClass) (string, int64, bool) {
	switch v := p.(type) {
	case *tg.PeerUser:
		if v == nil {
			return "", 0, false
		}
		return "user", v.UserID, true
	case *tg.PeerChat:
		if v == nil {
			return "", 0, false
		}
		return "chat", v.ChatID, true
	case *tg.PeerChannel:
		if v == nil {
			return "", 0, false
		}
		return "channel", v.ChannelID, true
	}
	return "", 0, false
}

// machineProjectPage validates one whole page, appends its chats to r and
// returns the next page's cursor, or done when this folder has no more pages.
func machineProjectPage(ctx context.Context, raw tg.MessagesDialogsClass, limit int, seen map[string]bool, r *MachineChats) (machineNext, bool, error) {
	var none machineNext
	var dialogs []tg.DialogClass
	var users []tg.UserClass
	var chats []tg.ChatClass
	var messages []tg.MessageClass
	last := false
	switch p := raw.(type) {
	case *tg.MessagesDialogs:
		if p == nil {
			return none, false, errMachineDialogs
		}
		// A full (non-slice) response carries every dialog of this folder.
		last = true
		dialogs, users, chats, messages = p.Dialogs, p.Users, p.Chats, p.Messages
	case *tg.MessagesDialogsSlice:
		if p == nil || p.Count < 0 {
			return none, false, errMachineDialogs
		}
		dialogs, users, chats, messages = p.Dialogs, p.Users, p.Chats, p.Messages
	default:
		return none, false, errMachineDialogs
	}
	entities := map[string]machineEntity{}
	inputs := map[string]tg.InputPeerClass{}
	add := func(kind string, id int64, title, username string, available bool, input tg.InputPeerClass) error {
		if id <= 0 || !utf8.ValidString(title) || !utf8.ValidString(username) {
			return errMachineDialogs
		}
		key := kind + "_" + strconv.FormatInt(id, 10)
		e := machineEntity{title, username, available}
		if prior, ok := entities[key]; ok && prior != e {
			return errMachineDialogs
		}
		entities[key] = e
		inputs[key] = input
		return nil
	}
	var err error
	for _, value := range users {
		if err := ctx.Err(); err != nil {
			return none, false, err
		}
		switch u := value.(type) {
		case *tg.User:
			if u == nil {
				return none, false, errMachineDialogs
			}
			err = add("user", u.ID, visibleName(u.FirstName, u.LastName), u.Username, !u.Deleted, &tg.InputPeerUser{UserID: u.ID, AccessHash: u.AccessHash})
		case *tg.UserEmpty:
			if u == nil {
				return none, false, errMachineDialogs
			}
			err = add("user", u.ID, "", "", false, &tg.InputPeerUser{UserID: u.ID})
		default:
			return none, false, errMachineDialogs
		}
		if err != nil {
			return none, false, err
		}
	}
	for _, value := range chats {
		if err := ctx.Err(); err != nil {
			return none, false, err
		}
		switch c := value.(type) {
		case *tg.Chat:
			if c == nil {
				return none, false, errMachineDialogs
			}
			err = add("chat", c.ID, c.Title, "", !c.Deactivated, &tg.InputPeerChat{ChatID: c.ID})
		case *tg.Channel:
			if c == nil {
				return none, false, errMachineDialogs
			}
			err = add("channel", c.ID, c.Title, c.Username, true, &tg.InputPeerChannel{ChannelID: c.ID, AccessHash: c.AccessHash})
		case *tg.ChatEmpty:
			if c == nil {
				return none, false, errMachineDialogs
			}
			err = add("chat", c.ID, "", "", false, &tg.InputPeerChat{ChatID: c.ID})
		case *tg.ChatForbidden:
			if c == nil {
				return none, false, errMachineDialogs
			}
			err = add("chat", c.ID, "", "", false, &tg.InputPeerChat{ChatID: c.ID})
		case *tg.ChannelForbidden:
			if c == nil {
				return none, false, errMachineDialogs
			}
			err = add("channel", c.ID, "", "", false, &tg.InputPeerChannel{ChannelID: c.ID, AccessHash: c.AccessHash})
		default:
			return none, false, errMachineDialogs
		}
		if err != nil {
			return none, false, err
		}
	}
	var lastDialog *tg.Dialog
	var lastKey string
	for _, value := range dialogs {
		if err := ctx.Err(); err != nil {
			return none, false, err
		}
		if folder, ok := value.(*tg.DialogFolder); ok {
			// The archive entry of the main list; its chats are read as their own folder.
			if folder == nil {
				return none, false, errMachineDialogs
			}
			continue
		}
		d, ok := value.(*tg.Dialog)
		if !ok || d == nil {
			return none, false, errMachineDialogs
		}
		kind, id, ok := machinePeerKey(d.Peer)
		if !ok || id <= 0 {
			return none, false, errMachineDialogs
		}
		textID := strconv.FormatInt(id, 10)
		key := kind + "_" + textID
		lastDialog, lastKey = d, key
		if seen[key] {
			r.DuplicateCount++
			continue
		}
		seen[key] = true
		e, ok := entities[key]
		if !ok || !e.available {
			r.SkippedCount++
			continue
		}
		// Still validate every later row of this page: reaching the limit never exits this loop.
		if len(r.Chats) >= limit {
			r.Truncated = true
			r.ResponseKind = "slice"
			continue
		}
		title := make([]rune, 0, 500)
		for _, c := range strings.TrimSpace(e.title) {
			if !unicode.IsControl(c) {
				title = append(title, c)
			}
			if len(title) == 500 {
				break
			}
		}
		label := strings.TrimSpace(string(title))
		if label == "" {
			label = key
		}
		row := MachineChat{PeerType: kind, ID: textID, Title: label}
		if machineUsername.MatchString(e.username) {
			row.Username = e.username
		}
		r.Chats = append(r.Chats, row)
	}
	if last || len(dialogs) < machineDialogBatch {
		return none, true, nil
	}
	if lastDialog == nil || lastDialog.TopMessage <= 0 {
		return none, false, errMachineDialogs
	}
	input, ok := inputs[lastKey]
	if !ok {
		return none, false, errMachineDialogs
	}
	cursor := machineCursor{lastKey, lastDialog.TopMessage}
	date := 0
	for _, m := range messages {
		x, ok := m.AsNotEmpty()
		if !ok || x.GetID() != cursor.id {
			continue
		}
		if kind, id, ok := machinePeerKey(x.GetPeerID()); ok && kind+"_"+strconv.FormatInt(id, 10) == lastKey {
			date = x.GetDate()
			break
		}
	}
	if date <= 0 {
		return none, false, errMachineDialogs
	}
	return machineNext{key: cursor, peer: input, date: date}, false, nil
}
