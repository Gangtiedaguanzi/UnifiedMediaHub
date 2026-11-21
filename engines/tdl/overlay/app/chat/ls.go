package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/expr-lang/expr"
	"github.com/go-faster/errors"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/message/peer"
	"github.com/gotd/td/telegram/peers"
	"github.com/gotd/td/telegram/query/dialogs"
	"github.com/gotd/td/tg"
	"github.com/mattn/go-runewidth"
	"go.uber.org/zap"

	"github.com/iyear/tdl/core/logctx"
	"github.com/iyear/tdl/core/storage"
	"github.com/iyear/tdl/core/util/tutil"
	"github.com/iyear/tdl/pkg/texpr"
)

//go:generate go-enum --names --values --flag --nocase

type Dialog struct {
	PeerType    string  `json:"peer_type"`
	ID          int64   `json:"id" comment:"ID of dialog"`
	Type        string  `json:"type" comment:"Type of dialog. Can be 'private', 'channel' or 'group'"`
	VisibleName string  `json:"visible_name,omitempty" comment:"Title of channel and group, first and last name of user. If empty, output '-'"`
	Username    string  `json:"username,omitempty" comment:"Username of dialog. If empty, output '-'"`
	Topics      []Topic `json:"topics,omitempty" comment:"Topics of dialog. If not set, output '-'"`
}

type Topic struct {
	ID    int    `json:"id" comment:"ID of topic"`
	Title string `json:"title" comment:"Title of topic"`
}

// ListOutput
// ENUM(table, json)
type ListOutput int

// External designation, different from Telegram mtproto
const (
	DialogGroup   = "group"
	DialogPrivate = "private"
	DialogChannel = "channel"
	DialogUnknown = "unknown"
)

type ListOptions struct {
	Output ListOutput
	Filter string
}

func List(ctx context.Context, c *telegram.Client, kvd storage.Storage, opts ListOptions) error {
	return listWithAPI(ctx, c.API(), kvd, opts)
}
func listWithAPI(ctx context.Context, api *tg.Client, kvd storage.Storage, opts ListOptions) error {
	log := logctx.From(ctx)

	// align output
	runewidth.EastAsianWidth = false
	runewidth.DefaultCondition.EastAsianWidth = false

	// output available fields
	if opts.Filter == "-" {
		fg := texpr.NewFieldsGetter(nil)
		fields, err := fg.Walk(&Dialog{})
		if err != nil {
			return fmt.Errorf("failed to walk fields: %w", err)
		}

		fmt.Print(fg.Sprint(fields, true))
		return nil
	}
	// compile filter
	filter, err := expr.Compile(opts.Filter, expr.AsBool())
	if err != nil {
		return fmt.Errorf("failed to compile filter: %w", err)
	}

	// Manually iterate through dialogs to handle errors gracefully
	// This allows us to skip problematic dialogs (deleted/inaccessible channels)
	// rather than failing completely when ExtractPeer fails
	dialogs, skipped, err := fetchDialogsWithErrorHandling(ctx, api)
	if err != nil {
		return err
	}
	if skipped > 0 {
		log.Warn("skipped problematic dialogs during iteration",
			zap.Int("skipped", skipped),
			zap.Int("fetched", len(dialogs)))
	}

	blocked, err := tutil.GetBlockedDialogs(ctx, api)
	if err != nil {
		return err
	}

	manager := peers.Options{Storage: storage.NewPeers(kvd)}.Build(api)
	result := make([]*Dialog, 0, len(dialogs))
	for _, d := range dialogs {
		id := tutil.GetInputPeerID(d.Peer)

		// we can update our access hash state if there is any new peer.
		if err = applyPeers(ctx, manager, d.Entities, id); err != nil {
			log.Warn("failed to apply peer updates", zap.Int64("id", id), zap.Error(err))
		}

		// filter blocked peers
		if _, ok := blocked[id]; ok {
			continue
		}

		var r *Dialog
		switch t := d.Peer.(type) {
		case *tg.InputPeerUser:
			r = processUser(t.UserID, d.Entities)
		case *tg.InputPeerChannel:
			r, err = processChannel(ctx, api, t.ChannelID, d.Entities)
			if err != nil {
				return err
			}
		case *tg.InputPeerChat:
			r = processChat(t.ChatID, d.Entities)
		}

		// skip unsupported types
		if r == nil {
			continue
		}

		// filter
		b, err := texpr.Run(filter, r)
		if err != nil {
			return fmt.Errorf("failed to run filter: %w", err)
		}
		if !b.(bool) {
			continue
		}

		result = append(result, r)
	}

	switch opts.Output {
	case ListOutputTable:
		printTable(result)
	case ListOutputJson:
		bytes, err := json.MarshalIndent(result, "", "\t")
		if err != nil {
			return fmt.Errorf("marshal json: %w", err)
		}

		fmt.Println(string(bytes))
	default:
		return fmt.Errorf("unknown output: %s", opts.Output)
	}

	return nil
}

func printTable(result []*Dialog) {
	fmt.Printf("%s %s %s %s %s\n",
		trunc("ID", 10),
		trunc("Type", 8),
		trunc("VisibleName", 20),
		trunc("Username", 20),
		"Topics")

	for _, r := range result {
		fmt.Printf("%s %s %s %s %s\n",
			trunc(strconv.FormatInt(r.ID, 10), 10),
			trunc(r.Type, 8),
			trunc(r.VisibleName, 20),
			trunc(r.Username, 20),
			topicsString(r.Topics))
	}
}

func trunc(s string, len int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		s = "-"
	}

	return runewidth.FillRight(runewidth.Truncate(s, len, "..."), len)
}

func topicsString(topics []Topic) string {
	if len(topics) == 0 {
		return "-"
	}

	s := make([]string, 0, len(topics))
	for _, t := range topics {
		s = append(s, fmt.Sprintf("%d: %s", t.ID, t.Title))
	}

	return strings.Join(s, ", ")
}

func processUser(id int64, entities peer.Entities) *Dialog {
	u, ok := entities.User(id)
	if !ok {
		return nil
	}

	return &Dialog{
		ID:          u.ID,
		PeerType:    "user",
		VisibleName: visibleName(u.FirstName, u.LastName),
		Username:    u.Username,
		Type:        DialogPrivate,
		Topics:      nil,
	}
}

func processChannel(ctx context.Context, api *tg.Client, id int64, entities peer.Entities) (*Dialog, error) {
	c, ok := entities.Channel(id)
	if !ok {
		return nil, nil
	}

	d := &Dialog{
		ID:          c.ID,
		PeerType:    "channel",
		VisibleName: c.Title,
		Username:    c.Username,
	}

	// channel type
	switch {
	case c.Broadcast:
		d.Type = DialogChannel
	case c.Megagroup, c.Gigagroup:
		d.Type = DialogGroup
	default:
		d.Type = DialogUnknown
	}

	if c.Forum {
		topics, err := fetchTopics(ctx, api, c.AsInputPeer())
		if err != nil {
			return nil, err
		}

		d.Topics = topics
	}

	return d, nil
}

// fetchTopics https://github.com/telegramdesktop/tdesktop/blob/4047f1733decd5edf96d125589f128758b68d922/Telegram/SourceFiles/data/data_forum.cpp#L135
func fetchTopics(ctx context.Context, api *tg.Client, peer tg.InputPeerClass) ([]Topic, error) {
	log := logctx.From(ctx)
	res := make([]Topic, 0)
	limit := 100 // why can't we use 500 like tdesktop?
	offsetTopic, offsetID, offsetDate := 0, 0, 0
	lastOffsetTopic := -1 // Track the last offsetTopic to detect infinite loops

	// Track seen offsetTopics to detect cycles
	seenOffsets := make(map[int]bool)

	for {
		// Detect infinite loop: if offsetTopic hasn't changed or we've seen it before
		if offsetTopic == lastOffsetTopic && lastOffsetTopic != -1 {
			log.Warn("pagination stuck (same offset), breaking loop",
				zap.Int("offset_topic", offsetTopic))
			return nil, fmt.Errorf("incomplete topic pagination")
		}
		if seenOffsets[offsetTopic] {
			log.Warn("pagination cycle detected, breaking loop",
				zap.Int("offset_topic", offsetTopic))
			break
		}
		seenOffsets[offsetTopic] = true
		lastOffsetTopic = offsetTopic

		req := &tg.MessagesGetForumTopicsRequest{
			Peer:        peer,
			Limit:       limit,
			OffsetTopic: offsetTopic,
			OffsetID:    offsetID,
			OffsetDate:  offsetDate,
		}

		topics, err := api.MessagesGetForumTopics(ctx, req)
		if err != nil {
			return nil, errors.Wrap(err, "get forum topics")
		}

		// If no topics returned, we're done
		if len(topics.Topics) == 0 {
			break
		}

		for _, tp := range topics.Topics {
			if t, ok := tp.(*tg.ForumTopic); ok {
				res = append(res, Topic{
					ID:    t.ID,
					Title: t.Title,
				})

				offsetTopic = t.ID
			}
		}

		// Safety break if we've collected all topics
		if len(res) >= topics.Count {
			break
		}

		// last page
		if len(topics.Topics) < limit {
			break
		}

		// Update offset using last message if available
		// Use a local variable for length to be absolutely safe against index out of range
		msgCount := len(topics.Messages)
		if msgCount > 0 {
			if lastMsg, ok := topics.Messages[msgCount-1].AsNotEmpty(); ok {
				offsetID, offsetDate = lastMsg.GetID(), lastMsg.GetDate()
			} else {
				log.Debug("no valid message for offset, relying on offsetTopic only",
					zap.Int("offset_topic", offsetTopic))
			}
		} else {
			log.Debug("no messages in topics response, relying on offsetTopic only",
				zap.Int("offset_topic", offsetTopic),
				zap.Int("topics_count", len(topics.Topics)))
		}
	}

	return res, nil
}

func processChat(id int64, entities peer.Entities) *Dialog {
	c, ok := entities.Chat(id)
	if !ok {
		return nil
	}

	return &Dialog{
		ID:          c.ID,
		PeerType:    "chat",
		VisibleName: c.Title,
		Username:    "-",
		Type:        DialogGroup,
		Topics:      nil,
	}
}

func visibleName(first, last string) string {
	if first == "" && last == "" {
		return ""
	}

	if first == "" {
		return last
	}

	if last == "" {
		return first
	}

	return first + " " + last
}

func applyPeers(ctx context.Context, manager *peers.Manager, entities peer.Entities, id int64) error {
	users := make([]tg.UserClass, 0, 1)
	if user, ok := entities.User(id); ok {
		users = append(users, user)
	}

	chats := make([]tg.ChatClass, 0, 1)
	if chat, ok := entities.Chat(id); ok {
		chats = append(chats, chat)
	}
	if channel, ok := entities.Channel(id); ok {
		chats = append(chats, channel)
	}

	return manager.Apply(ctx, users, chats)
}

// fetchDialogsWithErrorHandling manually iterates through dialogs using the raw Telegram API
// to gracefully handle errors from problematic dialogs (deleted/inaccessible channels).
// Instead of failing completely when ExtractPeer fails in gotd's iterator, it logs errors
// and continues, skipping bad dialogs.
func fetchDialogsWithErrorHandling(ctx context.Context, api *tg.Client) ([]dialogs.Elem, int, error) {
	const batchSize = 100
	type messageKey struct {
		peer string
		id   int
	}
	var rows []dialogs.Elem
	skipped, offsetID, offsetDate := 0, 0, 0
	var offsetPeer tg.InputPeerClass = &tg.InputPeerEmpty{}
	seen := map[string]bool{}
	cursors := map[messageKey]bool{}
	for {
		result, err := api.MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{OffsetDate: offsetDate, OffsetID: offsetID, OffsetPeer: offsetPeer, Limit: batchSize})
		if err != nil {
			return nil, skipped, fmt.Errorf("get dialogs: %w", err)
		}
		var ds []tg.DialogClass
		var ms []tg.MessageClass
		var us []tg.UserClass
		var cs []tg.ChatClass
		switch r := result.(type) {
		case *tg.MessagesDialogs:
			ds, ms, us, cs = r.Dialogs, r.Messages, r.Users, r.Chats
		case *tg.MessagesDialogsSlice:
			ds, ms, us, cs = r.Dialogs, r.Messages, r.Users, r.Chats
		default:
			return nil, skipped, fmt.Errorf("unsupported dialogs response")
		}
		if len(ds) == 0 {
			return rows, skipped, nil
		}
		users := map[int64]*tg.User{}
		chats := map[int64]*tg.Chat{}
		channels := map[int64]*tg.Channel{}
		for _, u := range us {
			if x, ok := u.(*tg.User); ok {
				users[x.ID] = x
			}
		}
		for _, c := range cs {
			switch x := c.(type) {
			case *tg.Chat:
				chats[x.ID] = x
			case *tg.Channel:
				channels[x.ID] = x
			}
		}
		entities := peer.NewEntities(users, chats, channels)
		messages := map[messageKey]tg.NotEmptyMessage{}
		for _, m := range ms {
			if x, ok := m.AsNotEmpty(); ok {
				if key := tutil.PeerKey(x.GetPeerID()); key != "" {
					messages[messageKey{key, x.GetID()}] = x
				}
			}
		}
		for _, d := range ds {
			x, ok := d.(*tg.Dialog)
			if !ok {
				skipped++
				continue
			}
			key := tutil.PeerKey(x.Peer)
			if key == "" {
				skipped++
				continue
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			input, err := entities.ExtractPeer(x.Peer)
			if err != nil {
				skipped++
				continue
			}
			rows = append(rows, dialogs.Elem{Peer: input, Entities: entities, Dialog: x, Last: messages[messageKey{key, x.TopMessage}]})
		}
		if len(ds) < batchSize {
			return rows, skipped, nil
		}
		last, ok := ds[len(ds)-1].(*tg.Dialog)
		if !ok {
			return nil, skipped, fmt.Errorf("incomplete dialog cursor")
		}
		key := messageKey{tutil.PeerKey(last.Peer), last.TopMessage}
		msg := messages[key]
		if key.peer == "" || key.id <= 0 || msg == nil || msg.GetDate() <= 0 || cursors[key] {
			return nil, skipped, fmt.Errorf("incomplete dialog cursor")
		}
		cursors[key] = true
		input, err := entities.ExtractPeer(last.Peer)
		if err != nil {
			return nil, skipped, fmt.Errorf("incomplete dialog peer: %w", err)
		}
		offsetPeer, offsetID, offsetDate = input, last.TopMessage, msg.GetDate()
	}
}
