package cmd

import (
	"context"
	"errors"
	"github.com/iyear/tdl/core/umh"
	"github.com/iyear/tdl/pkg/kv"
	"github.com/spf13/cobra"
	"io"
	"testing"
)

func TestMachineChatsCommandAndEarlyLimitValidation(t *testing.T) {
	for _, limit := range []string{"0", "5001", "-1"} {
		r := NewUMH()
		c, _, err := r.Find([]string{"chats"})
		if err != nil || c == nil || c.Name() != "chats" || !IsMachine(c) || c.RunE == nil {
			t.Fatal("missing bounded machine chats command")
		}
		if c.Flags().Lookup("limit") == nil || c.Flags().Lookup("limit").DefValue != "50" {
			t.Fatal("missing finite default limit")
		}
		if err := c.ParseFlags([]string{"--limit", limit}); err != nil {
			t.Fatal(err)
		}
		// No initialized storage or client exists. Invalid limits must return first.
		if err := c.RunE(c, nil); !errors.Is(err, umh.ErrInput) {
			t.Fatalf("limit reached initialization: %v", err)
		}
		if c.Args == nil || c.Args(c, []string{"unexpected"}) == nil {
			t.Fatal("positional arguments allowed")
		}
	}
}

func TestMachineChatsRejectsBeforeRootInitialization(t *testing.T) {
	for _, args := range [][]string{{"--limit", "0"}, {"--limit", "5001"}, {"--limit", "1.5"}, {"extra"}} {
		initialized := false
		r := &cobra.Command{Use: "offline", SilenceUsage: true, SilenceErrors: true, PersistentPreRunE: func(*cobra.Command, []string) error {
			initialized = true
			return errors.New("initialization must not run")
		}}
		r.SetOut(io.Discard)
		r.SetErr(io.Discard)
		group := NewUMH()
		group.GroupID = ""
		r.AddCommand(group)
		r.SetArgs(append([]string{"umh", "chats"}, args...))
		if err := r.ExecuteContext(context.Background()); err == nil || initialized {
			t.Fatal("invalid args reached root initialization")
		}
	}
}

func TestMachineCommands(t *testing.T) {
	r := New()
	for _, args := range [][]string{{"umh", "identity"}, {"umh", "login"}, {"umh", "login-qr"}} {
		c, _, e := r.Find(args)
		if e != nil || c == nil || !IsMachine(c) || c.RunE == nil {
			t.Fatal("missing machine route")
		}
	}
}

func TestFailOnFloodWaitFlagReachesClientOptions(t *testing.T) {
	storage, err := kv.NewWithMap(map[string]string{"type": "bolt", "path": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	for _, arg := range []string{"--fail-on-flood-wait=false", "--fail-on-flood-wait=true"} {
		root := New()
		if err := root.ParseFlags([]string{arg}); err != nil {
			t.Fatal(err)
		}
		opts, err := tOptions(kv.With(context.Background(), storage))
		if err != nil || opts.FailOnFloodWait != (arg == "--fail-on-flood-wait=true") {
			t.Fatal("global flag did not reach client options")
		}
	}
}
func TestStrictFlags(t *testing.T) {
	for _, c := range []*cobra.Command{NewDownload(), NewChatExport()} {
		if c.Flags().Lookup("strict-peer") == nil {
			t.Fatal("missing strict path")
		}
	}
	if NewChatExport().Flags().Lookup("peer-type") == nil {
		t.Fatal("missing selector")
	}
}
