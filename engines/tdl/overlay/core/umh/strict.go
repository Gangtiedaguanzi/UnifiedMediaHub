// UMH additions to tdl v0.20.4; licensed under the upstream AGPL-3.0.
package umh

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

const MaxSelectedBytes = 16 << 20
const MaxMessages = 100000

var ErrInput = errors.New("invalid_input")

func Kind(k string) bool { return k == "user" || k == "chat" || k == "channel" }
func PositiveID(s string, bits int) (int64, error) {
	if len(s) == 0 || s[0] < '1' || s[0] > '9' {
		return 0, ErrInput
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, ErrInput
		}
	}
	n, e := strconv.ParseInt(s, 10, bits)
	if e != nil {
		return 0, ErrInput
	}
	return n, nil
}

// Object reads one object, rejecting duplicate keys before normal JSON decoding.
func Object(d *json.Decoder, allowed map[string]bool) (map[string]json.RawMessage, error) {
	tok, e := d.Token()
	if e != nil || tok != json.Delim('{') {
		return nil, ErrInput
	}
	m := map[string]json.RawMessage{}
	for d.More() {
		tok, e = d.Token()
		k, ok := tok.(string)
		if e != nil || !ok || !allowed[k] {
			return nil, ErrInput
		}
		if _, exists := m[k]; exists {
			return nil, ErrInput
		}
		var v json.RawMessage
		if d.Decode(&v) != nil || !utf8.Valid(v) {
			return nil, ErrInput
		}
		m[k] = v
	}
	tok, e = d.Token()
	if e != nil || tok != json.Delim('}') {
		return nil, ErrInput
	}
	return m, nil
}
func End(d *json.Decoder) bool { var x any; return d.Decode(&x) == io.EOF }

type Selected struct {
	ID       json.Number
	PeerType string
	Messages []int
}

func ParseSelected(ctx context.Context, r io.Reader) (Selected, error) {
	var out Selected
	// Bound total input even for one huge JSON token, then iterate message entries.
	lr := &io.LimitedReader{R: r, N: MaxSelectedBytes + 1}
	d := json.NewDecoder(lr)
	d.UseNumber()
	tok, e := d.Token()
	if e != nil || tok != json.Delim('{') {
		return out, ErrInput
	}
	seen := map[string]bool{}
	ids := map[int]bool{}
	for d.More() {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		tok, e = d.Token()
		k, ok := tok.(string)
		if e != nil || !ok || seen[k] {
			return out, ErrInput
		}
		seen[k] = true
		switch k {
		case "id":
			tok, e = d.Token()
			n, ok := tok.(json.Number)
			if e != nil || !ok {
				return out, ErrInput
			}
			if _, e = PositiveID(n.String(), 64); e != nil {
				return out, e
			}
			out.ID = n
		case "peer_type":
			if d.Decode(&out.PeerType) != nil || !Kind(out.PeerType) {
				return out, ErrInput
			}
		case "messages":
			tok, e = d.Token()
			if e != nil || tok != json.Delim('[') {
				return out, ErrInput
			}
			for d.More() {
				if ctx.Err() != nil {
					return out, ctx.Err()
				}
				if len(out.Messages) >= MaxMessages {
					return out, ErrInput
				}
				m, e := Object(d, map[string]bool{"id": true, "type": true, "file": true, "photo": true})
				if e != nil {
					return out, e
				}
				id, e := PositiveID(string(m["id"]), 32)
				if e != nil || ids[int(id)] {
					return out, ErrInput
				}
				var typ, file, photo string
				if json.Unmarshal(m["type"], &typ) != nil || typ != "message" {
					return out, ErrInput
				}
				if v, ok := m["file"]; ok && json.Unmarshal(v, &file) != nil {
					return out, ErrInput
				}
				if v, ok := m["photo"]; ok && json.Unmarshal(v, &photo) != nil {
					return out, ErrInput
				}
				if file == "" && photo == "" {
					return out, ErrInput
				}
				ids[int(id)] = true
				out.Messages = append(out.Messages, int(id))
			}
			tok, e = d.Token()
			if e != nil || tok != json.Delim(']') {
				return out, ErrInput
			}
		default:
			return out, ErrInput
		}
	}
	tok, e = d.Token()
	if e != nil || tok != json.Delim('}') || !End(d) || lr.N <= 0 || !seen["messages"] || out.ID == "" || !Kind(out.PeerType) {
		return out, ErrInput
	}
	return out, nil
}

func response(b []byte, nonce string) (string, error) {
	if !utf8.Valid(b) {
		return "", ErrInput
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	m, e := Object(d, map[string]bool{"promptId": true, "text": true})
	if e != nil || !End(d) {
		return "", ErrInput
	}
	var id, s string
	if json.Unmarshal(m["promptId"], &id) != nil || id != nonce || json.Unmarshal(m["text"], &s) != nil || s == "" || utf8.RuneCountInString(s) > 4096 {
		return "", ErrInput
	}
	for _, c := range s {
		if c < 32 || c == 127 || c == utf8.RuneError {
			return "", ErrInput
		}
	}
	return s, nil
}

func promptResponse(b []byte, nonce string, allowResend bool) (Reply, error) {
	if allowResend && utf8.Valid(b) {
		d := json.NewDecoder(strings.NewReader(string(b)))
		m, e := Object(d, map[string]bool{"promptId": true, "action": true, "text": true})
		if e != nil || !End(d) {
			return Reply{}, ErrInput
		}
		if _, ok := m["action"]; ok {
			var id, action string
			if len(m) != 2 || json.Unmarshal(m["promptId"], &id) != nil || id != nonce || json.Unmarshal(m["action"], &action) != nil || action != "resend" {
				return Reply{}, ErrInput
			}
			return Reply{Resend: true}, nil
		}
	}
	text, e := response(b, nonce)
	return Reply{Text: text}, e
}
