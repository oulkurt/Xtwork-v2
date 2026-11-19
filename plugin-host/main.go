package main

import (
	"context"
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

//go:embed THIRD_PARTY_NOTICES
var thirdPartyNotices string

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 1 && args[0] == "--third-party-notices" {
		_, err := io.WriteString(os.Stdout, thirdPartyNotices)
		return err
	}
	if len(args) == 2 && args[0] == "worker" {
		err := serve(args[1], os.Stdin, os.Stdout)
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	if len(args) == 0 || args[0] != "serve" {
		return errors.New("usage: xtwork-plugin-host serve --plugins-dir <directory> --data-dir <directory>")
	}
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	plugins := flags.String("plugins-dir", "", "built-in plugin directory")
	data := flags.String("data-dir", "", "plugin data directory")
	disabled := flags.String("disabled", "", "comma-separated disabled plugin ids")
	zone := flags.String("time-zone", "UTC", "host IANA time zone")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Closing the pipe interrupts a read when the parent stops the server.
	defer context.AfterFunc(ctx, func() { _ = os.Stdin.Close() })()
	host, err := newHost(*plugins, *data, *disabled, *zone)
	if err != nil {
		return err
	}
	defer host.close()
	return host.serve(ctx, os.Stdin, os.Stdout)
}
