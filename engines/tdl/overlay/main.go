package main

import (
	"context"
	"os"
	"os/signal"

	surveyterm "github.com/AlecAivazis/survey/v2/terminal"
	"github.com/fatih/color"
	"github.com/go-faster/errors"
	"go.etcd.io/bbolt"

	"github.com/iyear/tdl/app/login"
	"github.com/iyear/tdl/cmd"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	humanizeErrors := map[error]string{
		bbolt.ErrTimeout:        "Current database is used by another process, please terminate it first",
		surveyterm.InterruptErr: "Interrupted",
	}

	root := cmd.New()
	found, _, _ := root.Find(os.Args[1:])
	machine := cmd.IsMachine(found)
	if err := root.ExecuteContext(ctx); err != nil {
		if machine {
			_ = login.MachineError(os.Stdout, err)
			os.Exit(1)
		}
		for e, m := range humanizeErrors {
			if errors.Is(err, e) {
				color.Red("%s", m)
				os.Exit(1)
			}
		}

		color.Red("Error: %+v", err)
		os.Exit(1)
	}
}
