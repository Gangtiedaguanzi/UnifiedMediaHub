// UMH additions to tdl v0.20.4; licensed under the upstream AGPL-3.0.
package tutil

import (
	"context"
	"fmt"
	"github.com/gotd/td/telegram/peers"
	"github.com/gotd/td/tg"
	"github.com/iyear/tdl/core/umh"
)

type TypedResolver interface {
	ResolveUserID(context.Context, int64) (peers.User, error)
	ResolveChatID(context.Context, int64) (peers.Chat, error)
	ResolveChannelID(context.Context, int64) (peers.Channel, error)
}

func ResolveTyped(ctx context.Context, m TypedResolver, kind, idText string) (peers.Peer, error) {
	id, e := umh.PositiveID(idText, 64)
	if e != nil || !umh.Kind(kind) {
		return nil, umh.ErrInput
	}
	var p peers.Peer
	switch kind {
	case "user":
		p, e = m.ResolveUserID(ctx, id)
	case "chat":
		p, e = m.ResolveChatID(ctx, id)
	case "channel":
		p, e = m.ResolveChannelID(ctx, id)
	}
	if e != nil {
		return nil, e
	}
	if p == nil || p.ID() != id || InputPeerType(p.InputPeer()) != kind {
		return nil, umh.ErrInput
	}
	return p, nil
}
func InputPeerType(p tg.InputPeerClass) string {
	switch p.(type) {
	case *tg.InputPeerUser:
		return "user"
	case *tg.InputPeerChat:
		return "chat"
	case *tg.InputPeerChannel:
		return "channel"
	}
	return ""
}
func PeerKey(p tg.PeerClass) string {
	switch v := p.(type) {
	case *tg.PeerUser:
		return fmt.Sprintf("user:%d", v.UserID)
	case *tg.PeerChat:
		return fmt.Sprintf("chat:%d", v.ChatID)
	case *tg.PeerChannel:
		return fmt.Sprintf("channel:%d", v.ChannelID)
	}
	return ""
}
