// UMH additions to tdl v0.20.4; licensed under the upstream AGPL-3.0.
package umh

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"sync"
)

type Pipe struct {
	in        io.ReadCloser
	reader    *bufio.Reader
	out       io.Writer
	mu        sync.Mutex
	closeOnce sync.Once
	lines     chan []byte
	ended     chan struct{}
}

func NewPipe(in io.ReadCloser, out io.Writer) *Pipe {
	return &Pipe{in: in, reader: bufio.NewReaderSize(in, 65537), out: out}
}

// NewWatchingPipe uses exactly one bounded reader, also observing EOF during QR waits.
func NewWatchingPipe(in io.ReadCloser, out io.Writer) *Pipe {
	p := NewPipe(in, out)
	p.lines = make(chan []byte, 1)
	p.ended = make(chan struct{})
	go func() {
		defer close(p.ended)
		defer close(p.lines)
		for {
			line, e := p.reader.ReadSlice('\n')
			if e != nil || len(line) > 65536 {
				return
			}
			b := append([]byte(nil), line...)
			select {
			case p.lines <- b:
			default:
				return
			}
		}
	}()
	return p
}
func (p *Pipe) Ended() <-chan struct{} { return p.ended }

// Some Windows anonymous pipes cannot interrupt a synchronous Read via Close. Never wait for that OS call; the owning process exits on cancellation.
func (p *Pipe) Close() error { p.closeOnce.Do(func() { go p.in.Close() }); return nil }

type Delivery struct {
	Method           string `json:"method"`
	NextMethod       string `json:"nextMethod,omitempty"`
	TimeoutSeconds   *int   `json:"timeoutSeconds,omitempty"`
	ResendsRemaining int    `json:"resendsRemaining"`
}
type Reply struct {
	Text   string
	Resend bool
}

func (p *Pipe) Ask(ctx context.Context, field string) (string, error) {
	r, e := p.ask(ctx, field, nil)
	return r.Text, e
}
func (p *Pipe) AskCode(ctx context.Context, d Delivery) (Reply, error) { return p.ask(ctx, "code", &d) }
func (p *Pipe) ask(ctx context.Context, field string, delivery *Delivery) (Reply, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ctx.Err() != nil {
		return Reply{}, ctx.Err()
	}
	if field != "phone" && field != "code" && field != "password" {
		return Reply{}, ErrInput
	}
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		return Reply{}, ErrInput
	}
	nonce := hex.EncodeToString(b)
	typ := "password"
	if field == "phone" {
		typ = "text"
	}
	event := map[string]any{"version": 1, "type": "input_required", "promptId": nonce, "field": field, "inputType": typ}
	if delivery != nil {
		event["delivery"] = delivery
	}
	if e := json.NewEncoder(p.out).Encode(event); e != nil {
		return Reply{}, ErrInput
	}
	type result struct {
		s Reply
		e error
	}
	done := make(chan result, 1)
	go func() {
		line, e := p.readLine(ctx)
		if e != nil || len(line) > 65536 {
			done <- result{e: ErrInput}
			return
		}
		s, e := promptResponse(line, nonce, delivery != nil)
		done <- result{s, e}
	}()
	select {
	case <-ctx.Done():
		p.Close()
		return Reply{}, ctx.Err()
	case v := <-done:
		return v.s, v.e
	}
}

func (p *Pipe) readLine(ctx context.Context) ([]byte, error) {
	if p.lines == nil {
		return p.reader.ReadSlice('\n')
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case line, ok := <-p.lines:
		if !ok {
			return nil, io.EOF
		}
		return line, nil
	}
}
