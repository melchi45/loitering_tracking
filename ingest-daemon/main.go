package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/lts2026/ingest-daemon/api"
)

func main() {
	addr := flag.String("addr", ":7070", "HTTP API listen address")
	flag.Parse()

	if envAddr := os.Getenv("INGEST_DAEMON_ADDR"); envAddr != "" {
		*addr = envAddr
	}

	log.Printf("[ingest-daemon] starting on %s", *addr)

	srv := api.NewServer()
	go func() {
		if err := srv.Run(*addr); err != nil {
			log.Fatalf("[ingest-daemon] server error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("[ingest-daemon] shutting down")
	srv.StopAll()
}
