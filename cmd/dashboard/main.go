// Dashboard opens an existing go-workflows SQLite database strictly read-only.
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/cschleiden/go-workflows/backend/sqlite"
	dashboard "github.com/wayanjimmy/go-workflows-ui"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	listen := flag.String("listen", "127.0.0.1:8423", "HTTP listen address; protect with authentication before exposing")
	path := flag.String("db", "", "Existing SQLite database or consistent snapshot")
	flag.Parse()
	if *path == "" {
		return fmt.Errorf("-db is required; use cmd/demo for disposable sample data")
	}
	abs, err := filepath.Abs(*path)
	if err != nil {
		return err
	}
	dsn := url.URL{Scheme: "file", Path: abs}
	q := url.Values{"mode": {"ro"}, "_pragma": {"query_only(1)", "busy_timeout(5000)"}}
	dsn.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := db.PingContext(ctx); err != nil {
		return err
	}
	// Unlike NewSqliteBackend, this constructor does not set WAL mode or migrate.
	b := sqlite.NewSqliteBackendWithDB(db)
	s := &http.Server{Addr: *listen, Handler: dashboard.NewHandler(b), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.Shutdown(shutdown)
	}()
	log.Printf("Read-only SQLite dashboard on %s", *listen)
	err = s.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
