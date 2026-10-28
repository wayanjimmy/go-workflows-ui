// Package demo creates disposable workflow executions using real SQLite workers.
package demo

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/cschleiden/go-workflows/backend"
	"github.com/cschleiden/go-workflows/client"
	"github.com/cschleiden/go-workflows/worker"
	"github.com/cschleiden/go-workflows/workflow"
)

type activities struct{ attempts atomic.Int32 }

func (a *activities) Summarize(ctx context.Context, input string) (string, error) {
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-time.After(120 * time.Millisecond):
	}
	if a.attempts.Add(1) == 1 {
		return "", errors.New("temporary upstream failure")
	}
	return "Summary ready: " + input, nil
}

func RetrySummary(ctx workflow.Context, input string) (string, error) {
	var a *activities
	return workflow.ExecuteActivity[string](ctx, workflow.ActivityOptions{RetryOptions: workflow.RetryOptions{
		MaxAttempts: 2, FirstRetryInterval: 80 * time.Millisecond, BackoffCoefficient: 1,
	}}, a.Summarize, input).Get(ctx)
}

func FailedSummary(ctx workflow.Context) error { return errors.New("transcript is unavailable") }

func CancellableWait(ctx workflow.Context) error { return workflow.Sleep(ctx, 24*time.Hour) }

func AwaitApproval(ctx workflow.Context) (string, error) {
	value, ok := workflow.NewSignalChannel[string](ctx, "approval").Receive(ctx)
	if !ok {
		return "", ctx.Err()
	}
	return value, nil
}

func ChildSummary(ctx workflow.Context) (string, error) {
	if err := workflow.Sleep(ctx, 100*time.Millisecond); err != nil {
		return "", err
	}
	return "Child summary complete", nil
}

func ParentSummary(ctx workflow.Context) (string, error) {
	return workflow.CreateSubWorkflowInstance[string](ctx, workflow.SubWorkflowOptions{InstanceID: "demo:child"}, ChildSummary).Get(ctx)
}

// Seed must only be called on a disposable backend. It creates executions and
// cancels one of them. Workers stop before returning; a signal-waiting run remains.
func Seed(ctx context.Context, b backend.Backend) error {
	w := worker.New(b, nil)
	for _, wf := range []workflow.Workflow{RetrySummary, FailedSummary, CancellableWait, AwaitApproval, ChildSummary, ParentSummary} {
		if err := w.RegisterWorkflow(wf); err != nil {
			return err
		}
	}
	if err := w.RegisterActivity(&activities{}); err != nil {
		return err
	}
	workerCtx, stop := context.WithCancel(ctx)
	if err := w.Start(workerCtx); err != nil {
		stop()
		return err
	}
	defer func() { stop(); _ = w.WaitForCompletion() }()
	c := client.New(b)
	for _, item := range []struct {
		id   string
		wf   workflow.Workflow
		args []any
	}{
		{"demo:retry/summary", RetrySummary, []any{"<script>window.injected=true</script> A safe, visible payload"}},
		{"demo:failed", FailedSummary, nil},
		{"demo:parent", ParentSummary, nil},
		{"demo:canceled", CancellableWait, nil},
		{"demo:waiting", AwaitApproval, nil},
	} {
		instance, err := c.CreateWorkflowInstance(ctx, client.WorkflowInstanceOptions{InstanceID: item.id}, item.wf, item.args...)
		if err != nil {
			return fmt.Errorf("create %s: %w", item.id, err)
		}
		if item.id == "demo:canceled" {
			if err := c.CancelWorkflowInstance(ctx, instance); err != nil {
				return err
			}
		}
		if item.id != "demo:waiting" {
			if err := c.WaitForWorkflowInstance(ctx, instance, 20*time.Second); err != nil {
				return fmt.Errorf("wait %s: %w", item.id, err)
			}
		} else {
			// Wait until the initial task is persisted, without signaling the run.
			for {
				events, err := b.GetWorkflowInstanceHistory(ctx, instance, nil)
				if err != nil {
					return err
				}
				if len(events) > 0 {
					break
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(20 * time.Millisecond):
				}
			}
		}
	}
	return nil
}
