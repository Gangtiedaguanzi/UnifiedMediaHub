// UMH additions to tdl v0.20.4; licensed under the upstream AGPL-3.0.
package chat

import (
	"context"
	"github.com/go-faster/jx"
	"github.com/gotd/td/telegram/peers"
	"github.com/iyear/tdl/core/umh"
	"github.com/iyear/tdl/core/util/tutil"
)

func resolveExportPeer(ctx context.Context, m *peers.Manager, o ExportOptions) (peers.Peer, error) {
	if o.StrictPeer || o.PeerType != "" {
		return resolveStrictExport(ctx, m, o)
	}
	if o.Chat == "" {
		return m.Self(ctx)
	}
	return tutil.GetInputPeer(ctx, m, o.Chat)
}

type exportResolver interface {
	tutil.TypedResolver
	Resolve(context.Context, string) (peers.Peer, error)
}

func resolveStrictExport(ctx context.Context, m exportResolver, o ExportOptions) (peers.Peer, error) {
	if o.PeerType != "" {
		return tutil.ResolveTyped(ctx, m, o.PeerType, o.Chat)
	}
	{
		if o.Chat == "" {
			return nil, umh.ErrInput
		}
		c := o.Chat[0]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '@') {
			return nil, umh.ErrInput
		}
		p, e := m.Resolve(ctx, o.Chat)
		if e != nil {
			return nil, e
		}
		if !umh.Kind(tutil.InputPeerType(p.InputPeer())) || p.ID() <= 0 {
			return nil, umh.ErrInput
		}
		return p, nil
	}
}
func writeExportHeader(enc *jx.Encoder, id int64, kind string) {
	enc.Field("id", func(e *jx.Encoder) { e.Int64(id) })
	enc.Field("peer_type", func(e *jx.Encoder) { e.Str(kind) })
}
