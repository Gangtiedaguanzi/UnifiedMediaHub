// UMH additions to tdl v0.20.4; licensed under the upstream AGPL-3.0.
package cmd

import (
	"context"
	"errors"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/tg"
	"github.com/iyear/tdl/app/chat"
	"github.com/iyear/tdl/app/login"
	"github.com/iyear/tdl/core/storage"
	"github.com/iyear/tdl/core/umh"
	"github.com/iyear/tdl/pkg/key"
	"github.com/iyear/tdl/pkg/tclient"
	"github.com/spf13/cobra"
	"os"
	"time"
)

func IsMachine(c *cobra.Command) bool {
	for ; c != nil; c = c.Parent() {
		if c.Name() == "umh" {
			return true
		}
	}
	return false
}

type accountClient struct{ c *telegram.Client }

func (a accountClient) Status(c context.Context) (*auth.Status, error) { return a.c.Auth().Status(c) }
func (a accountClient) Self(c context.Context) (*tg.User, error)       { return a.c.Self(c) }
func (a accountClient) SendCode(c context.Context, phone string, opts auth.SendCodeOptions) (tg.AuthSentCodeClass, error) {
	return a.c.Auth().SendCode(c, phone, opts)
}
func (a accountClient) ResendCode(c context.Context, phone, hash string) (tg.AuthSentCodeClass, error) {
	return a.c.Auth().ResendCode(c, phone, hash)
}
func (a accountClient) SignIn(c context.Context, phone, code, hash string) (*tg.AuthAuthorization, error) {
	return a.c.Auth().SignIn(c, phone, code, hash)
}
func (a accountClient) Password(c context.Context, password string) (*tg.AuthAuthorization, error) {
	return a.c.Auth().Password(c, password)
}

func (a accountClient) Export(ctx context.Context, ids ...int64) (qrlogin.Token, error) {
	return a.c.QR().Export(ctx, ids...)
}
func (a accountClient) Import(ctx context.Context) (*tg.AuthAuthorization, error) {
	return a.c.QR().Import(ctx)
}
func NewUMH() *cobra.Command {
	root := &cobra.Command{Use: "umh", Short: "UMH private JSON pipe authentication and identity", GroupID: groupAccount.ID}
	root.AddCommand(newMachineChats())
	for _, name := range []string{"login", "login-qr", "identity"} {
		name := name
		c := &cobra.Command{Use: name, Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
			limit := 2 * time.Minute
			if name == "login" || name == "login-qr" {
				limit = 10 * time.Minute
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), limit)
			defer cancel()
			opts, e := tOptions(ctx)
			if e != nil {
				return e
			}
			if name == "login" || name == "login-qr" {
				if _, e := opts.KV.Get(ctx, key.App()); errors.Is(e, storage.ErrNotFound) {
					if e = opts.KV.Set(ctx, key.App(), []byte(tclient.AppDesktop)); e != nil {
						return e
					}
				} else if e != nil {
					return e
				}
			}
			var updates <-chan struct{}
			if name == "login-qr" {
				d := tg.NewUpdateDispatcher()
				updates = login.BufferedLoginToken(d)
				opts.UpdateHandler = d
			}
			// false loads the dedicated existing session, enabling an authorized no-prompt check.
			opts.FailOnFloodWait = true // machine auth/identity must preserve explicit rate-limit errors
			client, e := tclient.New(ctx, opts, false)
			if e != nil {
				return e
			}
			return client.Run(ctx, func(ctx context.Context) error {
				a := accountClient{client}
				if name == "login-qr" {
					return login.MachineQRLogin(ctx, a, os.Stdin, cmd.OutOrStdout(), updates)
				}
				if name == "login" || name == "login-qr" {
					return login.MachineLogin(ctx, a, os.Stdin, cmd.OutOrStdout())
				}
				return login.MachineIdentity(ctx, a, cmd.OutOrStdout())
			})
		}}
		root.AddCommand(c)
	}
	return root
}

func newMachineChats() *cobra.Command {
	limit := 50
	validate := func() error {
		if limit < 1 || limit > chat.MachineMaxLimit {
			return umh.ErrInput
		}
		return nil
	}
	c := &cobra.Command{Use: "chats", Short: "Read bounded chat metadata from the main list and archive", Args: func(cmd *cobra.Command, args []string) error {
		if len(args) != 0 {
			return umh.ErrInput
		}
		return validate()
	}, RunE: func(cmd *cobra.Command, args []string) error {
		if err := validate(); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Minute)
		defer cancel()
		if err := ctx.Err(); err != nil {
			return err
		}
		opts, err := tOptions(ctx)
		if err != nil {
			return err
		}
		opts.FailOnFloodWait = true
		client, err := tclient.New(ctx, opts, false)
		if err != nil {
			return err
		}
		return client.Run(ctx, func(ctx context.Context) error {
			status, err := client.Auth().Status(ctx)
			if err != nil {
				return err
			}
			if status == nil || !status.Authorized {
				return login.ErrUnauthorized
			}
			return chat.MachineList(ctx, client.API(), limit, cmd.OutOrStdout())
		})
	}}
	c.Flags().IntVar(&limit, "limit", 50, "Maximum chat metadata entries (1..5000), main list then archive")
	return c
}
