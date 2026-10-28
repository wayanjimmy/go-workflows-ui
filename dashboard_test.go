package dashboard_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/cschleiden/go-workflows/backend/sqlite"
	"github.com/cschleiden/go-workflows/core"
	"github.com/cschleiden/go-workflows/diag"
	dashboard "github.com/wayanjimmy/go-workflows-ui"
	"github.com/wayanjimmy/go-workflows-ui/internal/demo"
)

// This exercises actual SQLite persistence, workers and the public HTTP handler.
// Failure cases: finished != succeeded, retry attempts collapse, colon/slash IDs
// break pagination, middleware mounts break assets, and write requests reach storage.
func TestSQLiteDashboardEndToEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workflows.db")
	b := sqlite.NewSqliteBackend(path)
	defer b.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := demo.Seed(ctx, b); err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(http.StripPrefix("/ops", dashboard.NewHandler(b)))
	defer s.Close()
	get := func(path string, out any) {
		t.Helper()
		r, err := http.Get(s.URL + "/ops/" + path)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		if r.StatusCode != 200 {
			data, _ := io.ReadAll(r.Body)
			t.Fatalf("%s: %d %s", path, r.StatusCode, data)
		}
		if out != nil {
			if err := json.NewDecoder(r.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, path := range []string{"", "app.js", "style.css"} {
		get(path, nil)
	}
	var all []*diag.WorkflowInstanceRef
	after := ""
	for {
		var page struct {
			Executions []*diag.WorkflowInstanceRef `json:"executions"`
			Next       string                      `json:"next"`
		}
		get("api/executions?limit=2&after="+url.QueryEscape(after), &page)
		all = append(all, page.Executions...)
		if page.Next == "" {
			break
		}
		if page.Next == after || len(all) > 20 {
			t.Fatal("pagination did not advance")
		}
		after = page.Next
	}
	seen := map[string]bool{}
	// Date windows retain their bounds while paginating.
	for _, window := range []string{"hour", "today"} {
		var ids []string
		cursor := ""
		for {
			var page struct {
				Executions []*diag.WorkflowInstanceRef `json:"executions"`
				Next       string                      `json:"next"`
			}
			get("api/executions?limit=1&range="+window+"&timezone=Pacific%2FKiritimati&after="+url.QueryEscape(cursor), &page)
			for _, ref := range page.Executions {
				ids = append(ids, ref.Instance.InstanceID)
			}
			if page.Next == "" {
				break
			}
			if len(ids) > len(all) {
				t.Fatal("filtered pagination did not advance")
			}
			cursor = page.Next
		}
		if len(ids) != len(all) {
			t.Fatalf("%s returned %d, want %d", window, len(ids), len(all))
		}
	}
	statuses := map[string]string{}
	for _, ref := range all {
		key := ref.Instance.InstanceID + "/" + ref.Instance.ExecutionID
		if seen[key] {
			t.Fatalf("duplicate execution %s", key)
		}
		seen[key] = true
		var detail struct {
			Status  string        `json:"status"`
			History []*diag.Event `json:"history"`
		}
		get("api/execution?instance="+url.QueryEscape(ref.Instance.InstanceID)+"&execution="+url.QueryEscape(ref.Instance.ExecutionID), &detail)
		statuses[ref.Instance.InstanceID] = detail.Status
		if ref.Instance.InstanceID == "demo:retry/summary" {
			attempts, failed, completed := 0, 0, 0
			for _, e := range detail.History {
				switch e.Type {
				case "ActivityScheduled":
					attempts++
				case "ActivityFailed":
					failed++
				case "ActivityCompleted":
					completed++
				}
			}
			if attempts != 2 || failed != 1 || completed != 1 {
				t.Fatalf("retry history: %d/%d/%d", attempts, failed, completed)
			}
		}
	}
	for id, want := range map[string]string{"demo:retry/summary": "Succeeded", "demo:failed": "Failed", "demo:waiting": "Running", "demo:canceled": "Canceled", "demo:parent": "Succeeded", "demo:child": "Succeeded"} {
		if statuses[id] != want {
			t.Errorf("%s status %q, want %q", id, statuses[id], want)
		}
	}
	var tree diag.WorkflowInstanceTree
	for _, ref := range all {
		if ref.Instance.InstanceID == "demo:parent" {
			get("api/tree?instance="+url.QueryEscape(ref.Instance.InstanceID)+"&execution="+ref.Instance.ExecutionID, &tree)
		}
	}
	if len(tree.Children) != 1 || tree.Children[0].Instance.InstanceID != "demo:child" {
		t.Fatalf("unexpected relationships: %+v", tree)
	}
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"POST", "api/executions", 405}, {"DELETE", "api/execution?instance=demo:waiting", 405},
		{"GET", "api/executions?limit=-1", 400}, {"GET", "api/executions?limit=101", 400},
		{"GET", "api/executions?after=invalid", 400}, {"GET", "api/execution", 400},
		{"GET", "api/executions?range=invalid", 400}, {"GET", "api/executions?range=today&timezone=invalid", 400},
		{"GET", "api/execution?instance=missing&execution=missing", 404}, {"GET", "api/unknown", 404},
	} {
		req, _ := http.NewRequest(tc.method, s.URL+"/ops/"+tc.path, nil)
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != tc.status {
			t.Errorf("%s %s: %d, want %d", tc.method, tc.path, r.StatusCode, tc.status)
		}
	}
	for _, ref := range all {
		if ref.Instance.InstanceID == "demo:waiting" {
			state, err := b.GetWorkflowInstanceState(ctx, core.NewWorkflowInstance(ref.Instance.InstanceID, ref.Instance.ExecutionID))
			if err != nil || state != core.WorkflowInstanceStateActive {
				t.Fatalf("read-only requests changed workflow: %v %v", state, err)
			}
		}
	}
	var stats map[string]any
	get("api/stats", &stats)
	if stats["ActiveWorkflowInstances"] != float64(1) {
		t.Fatalf("unexpected active count: %v", stats)
	}
	// Change only disposable test data: recent, older than one hour, previous
	// calendar day, and future starts must not all pass a time filter.
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UTC()
	for id, started := range map[string]time.Time{
		"demo:retry/summary": now.Add(-59 * time.Minute),
		"demo:failed":        now.Add(-61 * time.Minute),
		"demo:canceled":      now.Add(-48 * time.Hour),
		"demo:waiting":       now.Add(time.Hour),
	} {
		if _, err := db.Exec("UPDATE instances SET created_at = ? WHERE id = ?", started, id); err != nil {
			t.Fatal(err)
		}
	}
	var recent struct {
		Executions []*diag.WorkflowInstanceRef `json:"executions"`
	}
	get("api/executions?range=hour", &recent)
	if len(recent.Executions) != 3 {
		t.Fatalf("hour: got %d executions, want retry, parent, child", len(recent.Executions))
	}
	for _, ref := range recent.Executions {
		if id := ref.Instance.InstanceID; id != "demo:retry/summary" && id != "demo:parent" && id != "demo:child" {
			t.Fatalf("unexpected recent execution %s", id)
		}
	}
	get("api/executions?range=today&timezone=Pacific%2FKiritimati", &recent)
	zone, _ := time.LoadLocation("Pacific/Kiritimati")
	local := now.In(zone)
	midnight := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, zone)
	for _, ref := range recent.Executions {
		if ref.CreatedAt.Before(midnight) || ref.CreatedAt.After(now) {
			t.Fatalf("outside calendar window: %s", ref.Instance.InstanceID)
		}
	}
	utcMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	between := utcMidnight.Add(midnight.Sub(utcMidnight) / 2)
	if _, err := db.Exec("UPDATE instances SET created_at = ?", now.Add(-72*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE instances SET created_at = ? WHERE id = ?", between, "demo:retry/summary"); err != nil {
		t.Fatal(err)
	}
	for zone, want := range map[string]int{"UTC": 0, "Pacific/Kiritimati": 1} {
		if midnight.After(utcMidnight) {
			want = 1 - want
		}
		get("api/executions?range=today&timezone="+url.QueryEscape(zone), &recent)
		if len(recent.Executions) != want {
			t.Fatalf("calendar date in %s: got %d, want %d", zone, len(recent.Executions), want)
		}
	}
}
