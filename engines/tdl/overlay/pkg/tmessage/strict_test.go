package tmessage

import (
	"context"
	"github.com/iyear/tdl/core/umh"
	"strings"
	"testing"
)

func TestStrictFileUsesValidatedSelection(t *testing.T) {
	s, e := umh.ParseSelected(context.Background(), strings.NewReader(`{"id":9007199254740993,"peer_type":"chat","messages":[{"id":7,"type":"message","file":"x"},{"id":9,"type":"message","file":"y"}]}`))
	if e != nil || len(s.Messages) != 2 || s.Messages[0] != 7 || s.Messages[1] != 9 {
		t.Fatal("selection changed")
	}
	// Missing type fails before a resolver/client could be invoked.
	if _, e := parseStrictFile(context.Background(), nil, nil, strings.NewReader(`{"id":1,"messages":[]}`)); e == nil {
		t.Fatal("missing type accepted")
	}
}
