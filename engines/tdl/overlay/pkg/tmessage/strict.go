// UMH additions to tdl v0.20.4; licensed under the upstream AGPL-3.0.
package tmessage

import (
	"context"
	"github.com/gotd/td/telegram/peers"
	"github.com/gotd/td/tg"
	"github.com/iyear/tdl/core/dcpool"
	"github.com/iyear/tdl/core/storage"
	"github.com/iyear/tdl/core/umh"
	"github.com/iyear/tdl/core/util/tutil"
	"io"
	"os"
)

func parseStrictFile(ctx context.Context, c *tg.Client, kvd storage.Storage, r io.Reader) (*Dialog, error) {
	s, e := umh.ParseSelected(ctx, r)
	if e != nil {
		return nil, e
	}
	m := peers.Options{Storage: storage.NewPeers(kvd)}.Build(c)
	p, e := tutil.ResolveTyped(ctx, m, s.PeerType, s.ID.String())
	if e != nil {
		return nil, e
	}
	return &Dialog{Peer: p.InputPeer(), Messages: s.Messages}, nil
}
func FromStrictFile(ctx context.Context, pool dcpool.Pool, kvd storage.Storage, files []string) ParseSource {
	return func() ([]*Dialog, error) {
		if len(files) != 1 {
			return nil, umh.ErrInput
		}
		f, e := os.Open(files[0])
		if e != nil {
			return nil, e
		}
		defer f.Close()
		d, e := parseStrictFile(ctx, pool.Default(ctx), kvd, f)
		if e != nil {
			return nil, e
		}
		return []*Dialog{d}, nil
	}
}
