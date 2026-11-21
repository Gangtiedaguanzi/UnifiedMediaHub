package umh

import (
	"context"
	"strings"
	"testing"
)

func TestSelectedLossless(t *testing.T) {
	for _, id := range []string{"9007199254740993", "9223372036854775807"} {
		v, e := ParseSelected(context.Background(), strings.NewReader(`{"messages":[{"id":2147483647,"type":"message","file":"x"}],"id":`+id+`,"peer_type":"channel"}`))
		if e != nil || v.ID.String() != id || len(v.Messages) != 1 || v.Messages[0] != 2147483647 {
			t.Fatalf("lossless failed: %v", e)
		}
	}
}
func TestSelectedRejects(t *testing.T) {
	for _, src := range []string{
		`{"id":1,"messages":[]}`, `{"id":1,"peer_type":"wat","messages":[]}`,
		`{"id":1,"id":2,"peer_type":"user","messages":[]}`,
		`{"id":1e2,"peer_type":"user","messages":[]}`,
		`{"id":1.0,"peer_type":"user","messages":[]}`,
		`{"id":-1,"peer_type":"user","messages":[]}`,
		`{"id":"1","peer_type":"user","messages":[]}`,
		`{"id":9223372036854775808,"peer_type":"user","messages":[]}`,
		`{"id":1,"peer_type":"user","messages":[{"id":0,"type":"message","file":"x"}]}`,
		`{"id":1,"peer_type":"user","messages":[{"id":2147483648,"type":"message","file":"x"}]}`,
		`{"id":1,"peer_type":"user","messages":[{"id":1,"id":2,"type":"message","file":"x"}]}`,
		`{"id":1,"peer_type":"user","messages":[{"id":1,"type":"service","file":"x"}]}`,
		`{"id":1,"peer_type":"user","messages":[{"id":1,"type":"message","file":"x"},{"id":1,"type":"message","file":"x"}]}`,
		`{"id":1,"peer_type":"user","messages":[]`,
		`{"id":1,"peer_type":"user","messages":[]} {}`,
	} {
		if _, e := ParseSelected(context.Background(), strings.NewReader(src)); e == nil {
			t.Errorf("accepted malformed fixture %s", src)
		}
	}
}
func TestSelectedBoundedCanceled(t *testing.T) {
	if _, e := ParseSelected(context.Background(), strings.NewReader(strings.Repeat(" ", MaxSelectedBytes+1))); e == nil {
		t.Fatal("unbounded")
	}
	c, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := ParseSelected(c, strings.NewReader(`{"id":1,"peer_type":"user","messages":[]}`)); e == nil {
		t.Fatal("ignored cancel")
	}
}
