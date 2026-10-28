// Package dashboard serves a read-only, embedded dashboard for go-workflows.
package dashboard

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/cschleiden/go-workflows/backend"
	"github.com/cschleiden/go-workflows/backend/history"
	"github.com/cschleiden/go-workflows/core"
	"github.com/cschleiden/go-workflows/diag"
	"github.com/cschleiden/go-workflows/workflow"
)

//go:embed web/*
var assets embed.FS

type executionCursor struct {
	Instance  string
	Execution string
	Range     string
	Zone      string
	Start     time.Time
	End       time.Time
}

// NewHandler does not own or close b. Mount with http.StripPrefix when serving
// under a subpath ending in /. Wrap with authentication before exposing data.
// Only GET and HEAD are accepted. No worker, migration or write API is started.
func NewHandler(b diag.Backend) http.Handler {
	files, _ := fs.Sub(assets, "web")
	static := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Read-only dashboard", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/" || r.URL.Path == "/app.js" || r.URL.Path == "/style.css" || strings.HasPrefix(r.URL.Path, "/assets/") {
			static.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		var result any
		var err error
		switch r.URL.Path {
		case "/api/stats":
			result, err = b.GetStats(ctx)
		case "/api/executions":
			limit := 25
			if raw := r.URL.Query().Get("limit"); raw != "" {
				limit, err = strconv.Atoi(raw)
				if err != nil || limit < 1 || limit > 100 {
					http.Error(w, "limit must be between 1 and 100", 400)
					return
				}
			}
			window, zone := r.URL.Query().Get("range"), r.URL.Query().Get("timezone")
			if window == "" {
				window = "all"
			}
			if window != "all" && window != "today" && window != "hour" {
				http.Error(w, "Invalid start-time range", 400)
				return
			}
			if zone == "" {
				zone = "UTC"
			}
			location, zoneErr := time.LoadLocation(zone)
			if zoneErr != nil {
				http.Error(w, "Invalid timezone", 400)
				return
			}
			after := executionCursor{Range: window, Zone: zone, End: time.Now()}
			if window == "hour" {
				after.Start = after.End.Add(-time.Hour)
			}
			if window == "today" {
				now := after.End.In(location)
				after.Start = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
			}
			if raw := r.URL.Query().Get("after"); raw != "" {
				data, decodeErr := base64.RawURLEncoding.DecodeString(raw)
				if decodeErr != nil || json.Unmarshal(data, &after) != nil || after.Instance == "" || after.Execution == "" || after.Range != window || after.Zone != zone || after.End.IsZero() {
					http.Error(w, "Invalid execution cursor", 400)
					return
				}
			}
			var refs []*diag.WorkflowInstanceRef
			instance, execution := after.Instance, after.Execution
			// diag.Backend has no date predicate. Scan bounded batches so a
			// sparse window still fills pages without assuming backend ordering.
			for len(refs) <= limit {
				var batch []*diag.WorkflowInstanceRef
				batch, err = b.GetWorkflowInstances(ctx, instance, execution, 100)
				if err != nil {
					break
				}
				for _, ref := range batch {
					if window == "all" || (!ref.CreatedAt.Before(after.Start) && ref.CreatedAt.Before(after.End)) {
						refs = append(refs, ref)
						if len(refs) > limit {
							break
						}
					}
				}
				if len(batch) < 100 {
					break
				}
				last := batch[len(batch)-1].Instance
				instance, execution = last.InstanceID, last.ExecutionID
				if err = ctx.Err(); err != nil {
					break
				}
			}
			next := ""
			if len(refs) > limit {
				refs = refs[:limit]
				last := refs[len(refs)-1].Instance
				after.Instance, after.Execution = last.InstanceID, last.ExecutionID
				data, _ := json.Marshal(after)
				next = base64.RawURLEncoding.EncodeToString(data)
			}
			if refs == nil {
				refs = []*diag.WorkflowInstanceRef{}
			}
			result = struct {
				Executions []*diag.WorkflowInstanceRef `json:"executions"`
				Next       string                      `json:"next"`
			}{refs, next}
		case "/api/execution", "/api/tree":
			q := r.URL.Query()
			if q.Get("instance") == "" || q.Get("execution") == "" {
				http.Error(w, "instance and execution are required", 400)
				return
			}
			instance := core.NewWorkflowInstance(q.Get("instance"), q.Get("execution"))
			var ref *diag.WorkflowInstanceRef
			ref, err = b.GetWorkflowInstance(ctx, instance)
			if errors.Is(err, backend.ErrInstanceNotFound) || (err == nil && ref == nil) {
				http.Error(w, "Execution not found", 404)
				return
			}
			if err != nil {
				break
			}
			if r.URL.Path == "/api/tree" {
				result, err = b.GetWorkflowTree(ctx, instance)
				break
			}
			var events []*history.Event
			events, err = b.GetWorkflowInstanceHistory(ctx, instance, nil)
			if err != nil {
				break
			}
			name, status := "Pending", "Running"
			if ref.State == core.WorkflowInstanceStateFinished {
				status = "Finished"
			}
			converted := make([]*diag.Event, 0, len(events))
			for _, e := range events {
				converted = append(converted, &diag.Event{ID: e.ID, SequenceID: e.SequenceID, Type: e.Type.String(), Timestamp: e.Timestamp, ScheduleEventID: e.ScheduleEventID, Attributes: e.Attributes, VisibleAt: e.VisibleAt})
				switch e.Type {
				case history.EventType_WorkflowExecutionStarted:
					name = e.Attributes.(*history.ExecutionStartedAttributes).Name
				case history.EventType_WorkflowExecutionContinuedAsNew:
					status = "Continued as new"
				case history.EventType_WorkflowExecutionTerminated:
					status = "Terminated"
				case history.EventType_WorkflowExecutionFinished:
					a := e.Attributes.(*history.ExecutionCompletedAttributes)
					status = "Succeeded"
					if a.Error != nil {
						status = "Failed"
						// Upstream serializes sentinel errors as type/message pairs.
						if a.Error.Message == workflow.Canceled.Error() {
							status = "Canceled"
						}
					}
				}
			}
			// A cancellation request alone is not a terminal outcome.
			result = struct {
				*diag.WorkflowInstanceRef
				Name    string        `json:"name"`
				Status  string        `json:"status"`
				History []*diag.Event `json:"history"`
			}{ref, name, status, converted}
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, "Unable to read workflow data", 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
}
