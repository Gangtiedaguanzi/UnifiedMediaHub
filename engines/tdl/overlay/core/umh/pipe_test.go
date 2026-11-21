package umh

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPipeSequence(t *testing.T) {
	inR, inW, _ := os.Pipe()
	outR, outW, _ := os.Pipe()
	defer inW.Close()
	defer outR.Close()
	defer outW.Close()
	p := NewPipe(inR, outW)
	defer p.Close()
	requests := bufio.NewReader(outR)
	seen := map[string]bool{}
	for _, field := range []string{"phone", "code", "password"} {
		done := make(chan error, 1)
		go func() {
			s, e := p.Ask(context.Background(), field)
			if e == nil && s != "秘密synthetic" {
				e = io.ErrUnexpectedEOF
			}
			done <- e
		}()
		line, _ := requests.ReadBytes('\n')
		var event map[string]any
		json.Unmarshal(line, &event)
		id, _ := event["promptId"].(string)
		if len(id) < 32 || seen[id] || event["field"] != field || strings.Contains(string(line), "synthetic") {
			t.Fatal("invalid prompt")
		}
		seen[id] = true
		if field != "phone" && event["inputType"] != "password" {
			t.Fatal("secret UI not masked")
		}
		b, _ := json.Marshal(map[string]string{"promptId": id, "text": "秘密synthetic"})
		b = append(b, '\n')
		for _, c := range b {
			inW.Write([]byte{c})
		}
		if e := <-done; e != nil {
			t.Fatal(e)
		}
	}
}
func TestPipeRejects(t *testing.T) {
	for _, mode := range []string{"stale", "eof", "control", "oversized", "duplicate", "invalidutf8", "early", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			r, w, _ := os.Pipe()
			or, ow, _ := os.Pipe()
			defer w.Close()
			defer or.Close()
			defer ow.Close()
			p := NewPipe(r, ow)
			defer p.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, e := p.Ask(ctx, "password"); done <- e }()
			line, _ := bufio.NewReader(or).ReadBytes('\n')
			var event map[string]any
			json.Unmarshal(line, &event)
			id := event["promptId"].(string)
			switch mode {
			case "cancel":
				cancel()
			case "eof":
				w.Close()
			case "oversized":
				go func() { w.Write([]byte(strings.Repeat("x", 65537) + "\n")) }()
			case "invalidutf8":
				w.Write([]byte{255, '\n'})
			case "duplicate":
				w.Write([]byte(`{"promptId":"` + id + `","text":"a","text":"b"}` + "\n"))
			default:
				text := "synthetic-secret"
				if mode == "stale" || mode == "early" {
					id = "wrong"
				}
				if mode == "control" {
					text = "bad\x00secret"
				}
				b, _ := json.Marshal(map[string]string{"promptId": id, "text": text})
				w.Write(append(b, '\n'))
			}
			select {
			case e := <-done:
				if e == nil || strings.Contains(e.Error(), "secret") {
					t.Fatal("unsafe error")
				}
			case <-time.After(time.Second):
				t.Fatal("did not stop")
			}
		})
	}
}
