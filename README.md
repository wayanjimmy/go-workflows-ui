# go-workflows-ui

A read-only execution console for [go-workflows](https://github.com/cschleiden/go-workflows).
An independent Go module with an embedded React/shadcn frontend. No Node runtime,
Temporal server, database migrations, or worker process is needed to serve it.
Production frontend assets are included. Node is needed to rebuild them and run
browser tests.

## Embed in an application

Add the module to the consuming application:

```sh
go get github.com/wayanjimmy/go-workflows-ui@latest
```

Then import and mount the handler around the application's existing backend:

```go
import (
    "net/http"
    "github.com/cschleiden/go-workflows/diag"
    dashboard "github.com/wayanjimmy/go-workflows-ui"
)

func mount(mux *http.ServeMux, b diag.Backend) {
    mux.Handle("/workflows/", http.StripPrefix("/workflows", dashboard.NewHandler(b)))
}
```

Use a trailing slash in the mount URL. The handler does not own or close the
backend. Put authentication and authorization middleware in front of it.
The API exposes workflow payloads, errors, IDs, and history. Read-only does not
mean safe for anonymous users. No automatic secret redaction is provided.

Tested with go-workflows v1.4.2, including an existing summarize database.
Other backends must implement `diag.Backend`; the handler uses no SQL.

## Disposable SQLite demo

Run from this directory:

```sh
go run ./cmd/demo -listen 127.0.0.1:8423
```

Open port 8423 on the machine running the command. The demo uses real workers
to persist six executions: a successful activity retry, a failed workflow,
a canceled workflow, a running signal wait, and a parent/child workflow with
a timer. It stops those workers before serving the read-only dashboard.

The default database lives in a private temporary directory removed on graceful
shutdown. To retain it, pass `-db /path/to/new-demo.db`. The demo refuses any
existing file, so it cannot seed or migrate a production database by accident.

## Inspect an existing SQLite database

Prefer a consistent SQLite backup over a raw file copy, especially with WAL:

```sh
umask 077
sqlite3 -readonly /path/to/workflows.db '.backup /path/to/snapshot.db'
go run ./cmd/dashboard -db /path/to/snapshot.db -listen 127.0.0.1:8423
```

The viewer uses SQLite `mode=ro` and `query_only(1)`, and disables migrations by
using `sqlite.NewSqliteBackendWithDB`. It neither creates a missing database nor
starts workers. A snapshot does not update when the original application runs.
Defaults bind to loopback. Keep real-data viewers private or behind authentication.

## What is displayed

- Cursor-paginated execution list, page-local ID/queue filter, and queue counts.
- Start-time presets: All time, Today in the selected timezone, and Last 1 hour.
  Time presets apply across all pages. Pagination pins the time window; refresh
  starts a new window. Changing the preset or timezone returns to the first page.
- Copy icons for workflow and execution IDs in the list, details, and relationship
  inspector, with confirmation and accessible feedback. Plain HTTP uses a legacy
  clipboard fallback; browser policy may still require manually selecting an ID.
- Execution metadata and outcome derived from terminal history, not coarse state.
- Temporal-inspired lines-and-dots timeline with workflow lifetime, a shared
  elapsed-time axis, separate retry attempts, timers, child workflows, and signals.
  Select a row for timezone-aware timestamps and the original start/end events.
  Icon controls reverse event order or show failed and unfinished events only.
  Mobile retains the graph with fewer axis ticks; durations remain in the inspector.
- Expandable event JSON, decoded UTF-8 input/result previews, history download,
  and parent/child links. Custom codec payloads remain encoded.
- Temporal-style family graph with connected nodes, current-execution marker,
  keyboard node selection, expand/collapse, and a selected-workflow inspector
  with parent/child navigation. Wide families scroll inside the graph.
- Keyboard-accessible tabs, mobile layout, and explicit missing/error states.
- Persistent timezone selection: browser-local, UTC, or an IANA timezone. List,
  metadata, history, timeline labels, and refresh timestamps use the selection.
  Durations and raw JSON remain unchanged. Dates use a 24-hour clock and include
  the timezone abbreviation or offset.

The list labels finished executions **Finished**, not Succeeded. It does not
fetch every history to manufacture status counts or indexed search. Text search
only applies to the current page. Start-time presets scan backend
pages because `diag.Backend` has no date predicate. Large datasets may hit the
10-second request timeout rather than return incomplete results.
Activity bars include queue time. Timer-fired
timestamps are created when timers are scheduled upstream, so timer bars use
the recorded eligibility time and show scheduled wait, not measured firing latency.
An unfinished bar has no fabricated terminal event.

The family graph uses the existing `GetWorkflowTree` contract. The current
execution uses its history-derived outcome; other nodes retain coarse Finished
or Finished with error labels rather than guessing success or cancellation.
It does not invent schedule or continue-as-new chain links. Selecting a graph
node inspects it without leaving the current execution; links open that execution.

History is loaded in full through the existing backend contract, then rendered
100 events at a time. Text previews stop at 64,000 characters, but JSON downloads
retain full data. This is not backend history pagination or a large-history
memory bound. Schedules, reset, cancellation, signaling, worker diagnostics, and
Temporal's query language are intentionally absent.

## Generated shadcn frontend

Generated with [shadcn Create](https://ui.shadcn.com/create) using preset `b0`:
Vite, Base UI, Nova style, neutral base/theme, Inter, and Lucide. The scaffold
command was `npx shadcn@4.23.0 init --preset b0 --template vite`; added `badge`,
`card`, `input`, `table`, `tabs`, and `native-select` through the same CLI. Generated
components and `components.json` are retained in `frontend/`. Temporal's layout
informs the compact execution table, blue status accents, and detail tabs. An
icon navigation rail and icon-only toolbar buttons keep labels short. Every
icon control retains an accessible name and tooltip.
No Temporal-specific APIs or unsupported mutation controls are copied.

To rebuild after changing `frontend/src/`:

```sh
npm --prefix frontend ci
npm run build
npm --prefix frontend run lint
```

Vite writes the production bundle into `web/`, embedded by Go. Keep that output
with source changes. Relative asset/API URLs support mounting under a subpath.
Inter fonts are bundled locally; the dashboard makes no CDN requests. The CSP
permits same-origin scripts, styles, and fonts without allowing inline scripts
or styles. The interface uses a fixed light theme.

## End-to-end tests

The Go test creates a fresh SQLite database, executes real workflows, and calls
the public handler over HTTP under a subpath. No backend mocks or unit tests.

```sh
go test -race -count=1 ./...
npm ci
npm --prefix frontend ci
npm run build
npx playwright install chromium
npm run test:e2e
```

For an existing Chrome-family browser, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome` instead of
installing one. Browser tests start their own disposable demo on port 18423.
They check retries, outcomes, payload escaping, history, relationships, reloads,
mobile overflow, keyboard tabs, CSP, bundled fonts, filtering, timezone persistence
and conversion, not-found behavior,
and rejected writes. Repeatable screenshots
land in `test-results/`; `playwright-report/` contains the HTML test report.

To also exercise an existing read-only viewer, set
`DASHBOARD_LIVE_URL=http://127.0.0.1:8423` when running browser tests. This test
only reads data, does not require a particular workflow ID, and skips when unset.
Treat reports, traces, downloads, and screenshots from real datasets as private.

The dashboard is maintained independently of upstream go-workflows. Pin a module
version or commit in consuming applications; no Temporal deployment is required.
