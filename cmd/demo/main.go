// Demo owns a disposable SQLite database. It never opens an existing database.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/cschleiden/go-workflows/backend/sqlite"
	dashboard "github.com/wayanjimmy/go-workflows-ui"
	"github.com/wayanjimmy/go-workflows-ui/internal/demo"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	listen := flag.String("listen", "127.0.0.1:8423", "HTTP listen address")
	dbPath := flag.String("db", "", "New demo SQLite file; empty uses a temporary directory")
	flag.Parse()
	if *dbPath == "" {
		dir, err := os.MkdirTemp("", "go-workflows-ui-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		*dbPath = filepath.Join(dir, "workflows.db")
	}
	f, err := os.OpenFile(*dbPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	b := sqlite.NewSqliteBackend(*dbPath)
	defer b.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	seedCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	err = demo.Seed(seedCtx, b)
	cancel()
	if err != nil {
		return err
	}
	s := &http.Server{Addr: *listen, Handler: dashboard.NewHandler(b), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.Shutdown(shutdown)
	}()
	log.Printf("Disposable SQLite demo on %s", *listen)
	err = s.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
