import { Fragment, createContext, useContext, useEffect, useState } from "react"
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Check,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  ListFilter,
  Code2,
  ChevronsDownUp,
  ChevronsUpDown,
  GitBranch,
  History,
  Info,
  Layers,
  ListTree,
  LockKeyhole,
  RefreshCw,
  Search,
  Workflow,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"

const TimeZoneContext = createContext("local")
const timeZones = ["UTC", ...Intl.supportedValuesOf("timeZone")]

type Instance = { instance_id: string; execution_id: string }
type Ref = {
  instance: Instance
  state: number
  queue: string
  created_at: string
  completed_at?: string
}
type Event = {
  id: string
  sequence_id: number
  type: string
  timestamp: string
  visible_at?: string
  schedule_event_id: number
  attributes?: {
    name?: string
    attempt?: number
    at?: string
    inputs?: string[]
    result?: string
    error?: unknown
  }
}
type Execution = Ref & { name: string; status: string; history: Event[] }
type ExecutionPage = { executions: Ref[]; next: string }
type Stats = {
  ActiveWorkflowInstances: number
  PendingWorkflowTasks: Record<string, number>
  PendingActivityTasks: Record<string, number>
}
type Tree = Ref & { workflow_name?: string; error?: boolean; children?: Tree[] }
const link = (instance: Instance) =>
  `#execution?${new URLSearchParams({ instance: instance.instance_id, execution: instance.execution_id })}`
const date = (value: string | undefined, timeZone: string) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZone: timeZone === "local" ? undefined : timeZone,
        timeZoneName: "short",
      })
    : "—"
const elapsed = (ms: number): string =>
  ms < 1000
    ? `${Math.round(ms)} ms`
    : ms < 60000
      ? `${(ms / 1000).toFixed(2)} s`
      : ms < 3600000
        ? `${(ms / 60000).toFixed(1)} min`
        : `${(ms / 3600000).toFixed(1)} h`
const preview = (value: unknown) => {
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? "No payload")
  return text.length > 64000
    ? `${text.slice(0, 64000)}\n… Display truncated. Download JSON for the complete data.`
    : text
}
function payload(value?: string) {
  if (value == null) return "No payload"
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    )
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  } catch {
    return value
  }
}
async function api<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`./api/${path}`, { signal, cache: "no-store" })
  if (!response.ok)
    throw new Error(
      response.status === 404 ? "Execution not found" : await response.text()
    )
  return response.json()
}
function Status({
  status,
  detail = false,
}: {
  status: string
  detail?: boolean
}) {
  return (
    <Badge
      variant="outline"
      className={`status status-${status.toLowerCase().replaceAll(" ", "-")}`}
      data-testid={detail ? "execution-status" : undefined}
    >
      <span className="status-dot" />
      {status}
    </Badge>
  )
}
function PanelTitle({ title, note }: { title: string; note?: string }) {
  return (
    <div className="panel-heading">
      <h2>{title}</h2>
      {note && (
        <span
          role="img"
          aria-label={note}
          title={note}
          className="text-muted-foreground"
        >
          <Info className="size-3.5" />
        </span>
      )}
    </div>
  )
}
function CopyID({
  value,
  kind,
}: {
  value: string
  kind: "workflow" | "execution"
}) {
  const [feedback, setFeedback] = useState("")
  useEffect(() => {
    if (!feedback) return
    const timer = setTimeout(() => setFeedback(""), 2000)
    return () => clearTimeout(timer)
  }, [feedback])
  async function copy() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value)
      else {
        const field = document.createElement("textarea")
        field.value = value
        field.className = "clipboard-fallback"
        document.body.append(field)
        const focused = document.activeElement as HTMLElement | null
        field.select()
        const copied = document.execCommand("copy")
        field.remove()
        focused?.focus()
        if (!copied) throw new Error("Copy unavailable")
      }
      setFeedback("Copied")
    } catch {
      setFeedback("Copy failed. Select the ID to copy manually.")
    }
  }
  return (
    <span className="copy-control">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Copy ${kind} ID`}
        title={feedback || `Copy ${kind} ID`}
        onClick={() => void copy()}
      >
        {feedback === "Copied" ? <Check /> : <Copy />}
      </Button>
      <span className="sr-only" role="status">
        {feedback}
      </span>
    </span>
  )
}
function ExecutionList({
  data,
  stats,
  previous,
  next,
  page,
  refresh,
  range,
  onRange,
}: {
  data: ExecutionPage
  stats: Stats
  previous: () => void
  next: () => void
  page: number
  refresh: () => void
  range: string
  onRange: (value: string) => void
}) {
  const timeZone = useContext(TimeZoneContext)
  const [filter, setFilter] = useState("")
  const refs = data.executions.filter((ref) =>
    `${ref.instance.instance_id} ${ref.queue}`
      .toLowerCase()
      .includes(filter.toLowerCase())
  )
  const sum = (counts: Record<string, number>) =>
    Object.values(counts || {}).reduce((a, b) => a + b, 0)
  const queues = [
    ...new Set([
      ...Object.keys(stats.PendingWorkflowTasks || {}),
      ...Object.keys(stats.PendingActivityTasks || {}),
    ]),
  ]
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1>Executions</h1>
            <Badge variant="secondary">{data.executions.length}</Badge>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={refresh}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="stats-grid">
        <Badge
          variant="outline"
          className="status status-running"
          title="Active executions across all queues"
        >
          <Activity className="size-3" />
          {stats.ActiveWorkflowInstances} Running
        </Badge>
        <Badge variant="outline" title="Pending workflow tasks">
          <Workflow className="size-3" />
          {sum(stats.PendingWorkflowTasks)} Workflow tasks
        </Badge>
        <Badge variant="outline" title="Pending activity tasks">
          <Layers className="size-3" />
          {sum(stats.PendingActivityTasks)} Activity tasks
        </Badge>
      </div>
      <Card className="data-panel">
        <div className="filter-bar">
          <NativeSelect
            aria-label="Started within"
            value={range}
            onChange={(event) => onRange(event.target.value)}
          >
            <NativeSelectOption value="all">All time</NativeSelectOption>
            <NativeSelectOption value="today">Today</NativeSelectOption>
            <NativeSelectOption value="hour">Last 1 hour</NativeSelectOption>
          </NativeSelect>
          <div className="flex items-center gap-2 text-sm font-medium">
            <ListTree className="size-4" />
            All
            <span
              role="img"
              aria-label="Finished is a persistence state, not a success verdict. Open an execution to inspect its outcome."
              title="Finished is a persistence state, not a success verdict. Open an execution to inspect its outcome."
              className="text-muted-foreground"
            >
              <Info className="size-3.5" />
            </span>
          </div>
          <div className="search-field">
            <Search className="size-4" />
            <Input
              aria-label="Filter this page"
              placeholder="Filter this page…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        </div>
        <Table aria-label="Workflow executions">
          <TableHeader>
            <TableRow>
              {[
                "State",
                "Workflow ID",
                "Execution ID",
                "Task queue",
                "Started",
                "Finished",
              ].map((title) => (
                <TableHead key={title}>{title}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {refs.length ? (
              refs.map((ref) => (
                <TableRow
                  key={`${ref.instance.instance_id}/${ref.instance.execution_id}`}
                >
                  <TableCell>
                    <Status
                      status={
                        ref.state === 0
                          ? "Running"
                          : ref.state === 1
                            ? "Continued as new"
                            : "Finished"
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <span className="id-with-copy">
                      <a className="workflow-link" href={link(ref.instance)}>
                        {ref.instance.instance_id}
                      </a>
                      <CopyID
                        value={ref.instance.instance_id}
                        kind="workflow"
                      />
                    </span>
                  </TableCell>
                  <TableCell className="run-id">
                    <span className="id-with-copy">
                      {ref.instance.execution_id}
                      <CopyID
                        value={ref.instance.execution_id}
                        kind="execution"
                      />
                    </span>
                  </TableCell>
                  <TableCell>{ref.queue}</TableCell>
                  <TableCell>{date(ref.created_at, timeZone)}</TableCell>
                  <TableCell>{date(ref.completed_at, timeZone)}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="empty">
                  No executions match this page.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="pagination">
          <span>{refs.length} executions shown</span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous"
              title="Previous page"
              disabled={page === 0}
              onClick={previous}
            >
              <ChevronLeft />
            </Button>
            <span>Page {page + 1}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next"
              title="Next page"
              disabled={!data.next}
              onClick={next}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </Card>
      <Card id="queues" className="data-panel mt-6">
        <PanelTitle
          title="Queue backlog"
          note="Task counts do not indicate worker availability"
        />
        <Table aria-label="Queue backlog">
          <TableHeader>
            <TableRow>
              <TableHead>Task queue</TableHead>
              <TableHead>Workflow tasks</TableHead>
              <TableHead>Activity tasks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queues.length ? (
              queues.map((queue) => (
                <TableRow key={queue}>
                  <TableCell>{queue}</TableCell>
                  <TableCell>
                    {stats.PendingWorkflowTasks?.[queue] || 0}
                  </TableCell>
                  <TableCell>
                    {stats.PendingActivityTasks?.[queue] || 0}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={3}>No queued tasks</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </>
  )
}
function TimelineSpan({
  from,
  to,
  status,
  label,
}: {
  from: number
  to: number
  status: string
  label: string
}) {
  const x1 = `${1 + Math.max(0, Math.min(1, from)) * 98}%`
  const x2 = `${1 + Math.max(0, Math.min(1, to)) * 98}%`
  return (
    <svg
      className={`timeline-bar span-${status}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <line x1={x1} x2={x2} y1="16" y2="16" />
      <circle cx={x1} cy="16" r="4" />
      <circle cx={x2} cy="16" r="4" className="span-end" />
    </svg>
  )
}
function Timeline({ data }: { data: Execution }) {
  const timeZone = useContext(TimeZoneContext)
  const [observedAt] = useState(Date.now)
  const [selected, setSelected] = useState("")
  const [reverse, setReverse] = useState(false)
  const [attentionOnly, setAttentionOnly] = useState(false)
  type Row = {
    kind: string
    event: Event
    start: number
    end?: number
    outcome?: string
    terminal?: Event
  }
  const rows: Row[] = [],
    pending = new Map<string, Row>()
  const starts: Record<string, string> = {
    ActivityScheduled: "Activity",
    TimerScheduled: "Timer",
    SubWorkflowScheduled: "Child workflow",
  }
  const ends: Record<string, string> = {
    ActivityCompleted: "Activity",
    ActivityFailed: "Activity",
    TimerFired: "Timer",
    TimerCanceled: "Timer",
    SubWorkflowCompleted: "Child workflow",
    SubWorkflowFailed: "Child workflow",
  }
  for (const event of data.history) {
    const kind = starts[event.type],
      endKind = ends[event.type]
    if (kind) {
      const row = { kind, event, start: new Date(event.timestamp).getTime() }
      rows.push(row)
      pending.set(`${kind}:${event.schedule_event_id}`, row)
    } else if (endKind) {
      const row = pending.get(`${endKind}:${event.schedule_event_id}`)
      if (row) {
        // TimerFired is created when scheduled, not when the timer fires.
        row.end = new Date(
          event.type === "TimerFired"
            ? event.visible_at || event.attributes?.at || event.timestamp
            : event.timestamp
        ).getTime()
        row.outcome = event.type
        row.terminal = event
        pending.delete(`${endKind}:${event.schedule_event_id}`)
      }
    } else if (event.type === "SignalReceived") {
      rows.push({
        kind: "Signal",
        event,
        start: new Date(event.timestamp).getTime(),
        end: new Date(event.timestamp).getTime(),
        outcome: "Received",
      })
    }
  }
  const start = new Date(data.created_at).getTime(),
    end = data.completed_at
      ? new Date(data.completed_at).getTime()
      : observedAt,
    total = Math.max(1, end - start)
  const visible = rows.filter(
    (row) => !attentionOnly || !row.outcome || row.outcome.includes("Failed")
  )
  if (reverse) visible.reverse()
  return (
    <Card className="data-panel timeline-panel">
      <div className="timeline-toolbar">
        <PanelTitle
          title="Timeline"
          note="Includes queue time · Not activity execution time"
        />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={reverse ? "Oldest first" : "Newest first"}
            title={reverse ? "Oldest first" : "Newest first"}
            aria-pressed={reverse}
            onClick={() => setReverse(!reverse)}
          >
            {reverse ? <ArrowUpWideNarrow /> : <ArrowDownWideNarrow />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              attentionOnly ? "Show all events" : "Show failed and pending only"
            }
            title={
              attentionOnly ? "Show all events" : "Show failed and pending only"
            }
            aria-pressed={attentionOnly}
            onClick={() => setAttentionOnly(!attentionOnly)}
          >
            <ListFilter />
          </Button>
        </div>
      </div>
      <div className="timeline-summary">
        <span>{date(data.created_at, timeZone)}</span>
        <span>
          {elapsed(total)} total{!data.completed_at && " · running"}
        </span>
      </div>
      <div
        className="timeline-scroll"
        tabIndex={0}
        aria-label="Scrollable timeline"
      >
        <div className="timeline-chart">
          <div
            className="timeline-axis timeline-row"
            aria-label="Elapsed time axis"
          >
            <span>Event</span>
            <div className="timeline-ticks">
              {[0, 1, 2, 3, 4].map((tick) => (
                <span key={tick}>{elapsed((total * tick) / 4)}</span>
              ))}
            </div>
            <span className="duration">Duration</span>
          </div>
          <div className="timeline-row workflow-lifetime">
            <div className="timeline-label">
              <Workflow className="size-4" />
              <strong>Workflow lifetime</strong>
            </div>
            <TimelineSpan
              from={0}
              to={1}
              status={
                !data.completed_at
                  ? "pending"
                  : ["Failed", "Terminated", "Canceled"].includes(data.status)
                    ? "failed"
                    : "workflow"
              }
              label={`Workflow lifetime: ${data.status}, ${elapsed(total)}`}
            />
            <div className="duration">
              {!data.completed_at && "≥ "}
              {elapsed(total)}
            </div>
          </div>
          {visible.length ? (
            visible.map((row) => {
              const duration = Math.max(0, (row.end ?? end) - row.start)
              const name = row.event.attributes?.name || row.kind
              const attempt =
                row.kind === "Activity"
                  ? `, attempt ${(row.event.attributes?.attempt || 0) + 1}`
                  : ""
              const isSelected = selected === row.event.id
              const status = row.outcome?.includes("Failed")
                ? "failed"
                : row.outcome?.includes("Canceled")
                  ? "canceled"
                  : !row.outcome
                    ? "pending"
                    : row.kind === "Timer"
                      ? "timer"
                      : "completed"
              const Icon =
                row.kind === "Timer"
                  ? Clock3
                  : row.kind === "Child workflow"
                    ? GitBranch
                    : row.kind === "Signal"
                      ? Activity
                      : Layers
              return (
                <Fragment key={row.event.id}>
                  <button
                    type="button"
                    className="timeline-row timeline-event"
                    data-kind={row.kind}
                    aria-label={`Inspect ${row.kind} ${name}${attempt}`}
                    aria-expanded={isSelected}
                    aria-controls={`timeline-details-${row.event.id}`}
                    onClick={() => setSelected(isSelected ? "" : row.event.id)}
                  >
                    <div className="timeline-label">
                      <div className="timeline-event-title">
                        <ChevronRight
                          className={isSelected ? "size-3 rotate-90" : "size-3"}
                        />
                        <span className="event-id">
                          {row.event.sequence_id}
                        </span>
                        <Icon className="size-3.5" />
                        <strong>{name}</strong>
                      </div>
                      <small>
                        {row.kind} ·{" "}
                        {row.kind === "Activity" && (
                          <>
                            <span>
                              Attempt {(row.event.attributes?.attempt || 0) + 1}
                            </span>{" "}
                            ·{" "}
                          </>
                        )}
                        {row.outcome?.replace(
                          /^(Activity|Timer|SubWorkflow)/,
                          ""
                        ) ||
                          (data.completed_at ? "No terminal event" : "Pending")}
                        {row.outcome === "TimerFired" && " · Scheduled wait"}
                      </small>
                    </div>
                    <TimelineSpan
                      from={(row.start - start) / total}
                      to={((row.end ?? end) - start) / total}
                      status={status}
                      label={`${row.kind}: ${row.outcome || (data.completed_at ? "No terminal event" : "Pending")}, ${elapsed(duration)}`}
                    />
                    <div className="duration">
                      {row.end == null && "≥ "}
                      {elapsed(duration)}
                    </div>
                  </button>
                  {isSelected && (
                    <section
                      className="timeline-inspector"
                      aria-label="Timeline event details"
                      id={`timeline-details-${row.event.id}`}
                    >
                      <div className="panel-heading">
                        <h3>
                          {name}
                          {attempt.replace(",", " ·")}
                        </h3>
                        <Badge variant="outline">
                          {row.outcome ||
                            (data.completed_at
                              ? "No terminal event"
                              : "Pending")}
                        </Badge>
                      </div>
                      <dl className="timeline-event-metadata">
                        <div>
                          <dt>Started</dt>
                          <dd>
                            {date(new Date(row.start).toISOString(), timeZone)}
                          </dd>
                        </div>
                        <div>
                          <dt>
                            {row.outcome === "TimerFired"
                              ? "Eligible at"
                              : "Finished"}
                          </dt>
                          <dd>
                            {row.end == null
                              ? "—"
                              : date(new Date(row.end).toISOString(), timeZone)}
                          </dd>
                        </div>
                        <div>
                          <dt>
                            {row.kind === "Timer"
                              ? "Scheduled wait"
                              : "Elapsed including queue time"}
                          </dt>
                          <dd>
                            {row.end == null && "≥ "}
                            {elapsed(duration)}
                          </dd>
                        </div>
                      </dl>
                      <pre>
                        {preview([
                          row.event,
                          ...(row.terminal ? [row.terminal] : []),
                        ])}
                      </pre>
                    </section>
                  )}
                </Fragment>
              )
            })
          ) : (
            <div className="empty">
              {attentionOnly
                ? "No failed or pending events."
                : "No activity, timer, child workflow, or signal events yet."}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
function EventHistory({ events }: { events: Event[] }) {
  const timeZone = useContext(TimeZoneContext)
  const [shown, setShown] = useState(100),
    [expanded, setExpanded] = useState<Set<string>>(new Set())
  return (
    <Card className="data-panel">
      <PanelTitle title="Event history" note={`${events.length} events`} />
      {events.slice(0, shown).map((event) => (
        <div className="event-row" key={event.id}>
          <Button
            variant="ghost"
            aria-expanded={expanded.has(event.id)}
            onClick={() =>
              setExpanded((previous) => {
                const next = new Set(previous)
                if (next.has(event.id)) next.delete(event.id)
                else next.add(event.id)
                return next
              })
            }
          >
            <ChevronRight
              className={expanded.has(event.id) ? "rotate-90" : ""}
            />
            <span className="event-id">{event.sequence_id}</span>
            <span>{event.type}</span>
            <time>{date(event.timestamp, timeZone)}</time>
          </Button>
          {expanded.has(event.id) && <pre>{preview(event)}</pre>}
        </div>
      ))}
      {shown < events.length && (
        <Button variant="ghost" onClick={() => setShown(shown + 100)}>
          Show more events
        </Button>
      )}
    </Card>
  )
}
function Payloads({ data }: { data: Execution }) {
  const start = data.history.find(
      (event) => event.type === "WorkflowExecutionStarted"
    ),
    finish = data.history.findLast((event) =>
      ["WorkflowExecutionFinished", "WorkflowExecutionContinuedAsNew"].includes(
        event.type
      )
    )
  return (
    <>
      <div className="payload-grid" data-testid="payloads">
        {[
          [
            "Input",
            (start?.attributes?.inputs || []).map(payload).join("\n\n") ||
              "No input",
          ],
          [
            "Result",
            finish?.attributes?.error || payload(finish?.attributes?.result),
          ],
        ].map(([title, value]) => (
          <Card className="data-panel" key={String(title)}>
            <PanelTitle title={String(title)} />
            <pre>{preview(value)}</pre>
          </Card>
        ))}
      </div>
      <p className="notice">
        UTF-8 payloads are decoded locally. Custom codecs remain encoded.
        Previews are limited to 64,000 characters.
      </p>
    </>
  )
}
function FamilyNode({
  item,
  current,
  selected,
  expanded,
  onSelect,
}: {
  item: Tree
  current: Instance
  selected: Tree
  expanded: boolean
  onSelect: (node: Tree) => void
}) {
  const isCurrent =
    item.instance.instance_id === current.instance_id &&
    item.instance.execution_id === current.execution_id
  const isSelected = item === selected
  return (
    <li>
      <div className="family-node">
        <button
          type="button"
          className="family-node-button"
          aria-label={`Select ${item.instance.instance_id}`}
          aria-pressed={isSelected}
          aria-current={isCurrent ? "true" : undefined}
          onClick={() => onSelect(item)}
          title={`${item.instance.instance_id}\n${item.instance.execution_id}`}
        >
          <span
            className={`family-node-symbol ${item.state === 0 ? "running" : item.error ? "error" : "finished"}`}
          >
            <Workflow className="size-5" />
          </span>
          <strong>{item.workflow_name || "Pending"}</strong>
          <span className="family-node-id">{item.instance.instance_id}</span>
        </button>
        {isCurrent && (
          <Badge variant="outline" className="current-marker">
            Current
          </Badge>
        )}
      </div>
      {expanded && !!item.children?.length && (
        <ul>
          {item.children.map((child) => (
            <FamilyNode
              key={`${child.instance.instance_id}/${child.instance.execution_id}`}
              item={child}
              current={current}
              selected={selected}
              expanded={expanded}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
function Relationships({
  query,
  current,
}: {
  query: string
  current: Execution
}) {
  const timeZone = useContext(TimeZoneContext)
  const [tree, setTree] = useState<Tree>(),
    [error, setError] = useState("")
  const [selection, setSelection] = useState<Tree>(),
    [expanded, setExpanded] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    api<Tree>(`tree?${query}`, controller.signal)
      .then(setTree)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message)
      })
    return () => controller.abort()
  }, [query])
  const members: { item: Tree; parent?: Tree }[] = []
  function collect(item: Tree, parent?: Tree) {
    members.push({ item, parent })
    item.children?.forEach((child) => collect(child, item))
  }
  if (tree) collect(tree)
  const selected =
    members.find(({ item }) => item === selection) ||
    members.find(
      ({ item }) =>
        item.instance.instance_id === current.instance.instance_id &&
        item.instance.execution_id === current.instance.execution_id
    )
  function state(item: Tree) {
    if (
      item.instance.instance_id === current.instance.instance_id &&
      item.instance.execution_id === current.instance.execution_id
    )
      return current.status
    return item.state === 0
      ? "Running"
      : item.state === 1
        ? "Continued as new"
        : item.error
          ? "Finished with error"
          : "Finished"
  }
  const relatives = selected
    ? [
        ...(selected.parent
          ? [{ item: selected.parent, relation: "Parent" }]
          : []),
        ...(selected.item.children || []).map((item) => ({
          item,
          relation: "Child",
        })),
      ]
    : []
  return (
    <Card className="data-panel">
      {error ? (
        <div role="alert" className="error-message">
          {error}
        </div>
      ) : tree && selected ? (
        <>
          <section aria-label="Workflow family">
            <div className="panel-heading">
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 text-muted-foreground" />
                <h2>Workflow family</h2>
                <Badge variant="secondary">{members.length}</Badge>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={expanded ? "Collapse all" : "Expand all"}
                title={expanded ? "Collapse all" : "Expand all"}
                aria-pressed={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
              </Button>
            </div>
            <div
              className="family-canvas"
              tabIndex={0}
              aria-label="Scrollable workflow family graph"
            >
              <ul className="family-tree">
                <FamilyNode
                  item={tree}
                  current={current.instance}
                  selected={selected.item}
                  expanded={expanded}
                  onSelect={setSelection}
                />
              </ul>
            </div>
          </section>
          <section className="family-details" aria-label="Selected workflow">
            <div className="panel-heading">
              <div className="flex flex-wrap items-center gap-2">
                <h2>{selected.item.workflow_name || "Pending"}</h2>
                <Status status={state(selected.item)} />
              </div>
              <a
                className="workflow-link family-open"
                href={link(selected.item.instance)}
                title="Open execution"
                aria-label="Open execution"
              >
                <ArrowUpRight className="size-4" />
              </a>
            </div>
            <dl className="family-metadata">
              <div>
                <dt>Workflow ID</dt>
                <dd>
                  <a
                    className="workflow-link"
                    href={link(selected.item.instance)}
                  >
                    {selected.item.instance.instance_id}
                  </a>
                  <CopyID
                    value={selected.item.instance.instance_id}
                    kind="workflow"
                  />
                </dd>
              </div>
              <div>
                <dt>Execution ID</dt>
                <dd className="font-mono text-xs">
                  {selected.item.instance.execution_id}
                  <CopyID
                    value={selected.item.instance.execution_id}
                    kind="execution"
                  />
                </dd>
              </div>
              <div>
                <dt>Task queue</dt>
                <dd>{selected.item.queue}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{date(selected.item.created_at, timeZone)}</dd>
              </div>
            </dl>
            <Table aria-label="Related executions" className="family-related">
              <TableHeader>
                <TableRow>
                  <TableHead>Relationship</TableHead>
                  <TableHead>Workflow ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {relatives.length ? (
                  relatives.map(({ item, relation }) => (
                    <TableRow
                      key={`${relation}/${item.instance.instance_id}/${item.instance.execution_id}`}
                    >
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <GitBranch className="size-3.5 text-muted-foreground" />
                          {relation}
                        </span>
                      </TableCell>
                      <TableCell>
                        <a className="workflow-link" href={link(item.instance)}>
                          {item.instance.instance_id}
                        </a>
                      </TableCell>
                      <TableCell>{item.workflow_name || "Pending"}</TableCell>
                      <TableCell>
                        <Status status={state(item)} />
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="empty">
                      No parent or child workflows
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </section>
        </>
      ) : (
        <p className="empty">Loading relationships…</p>
      )}
    </Card>
  )
}
function ExecutionDetail({
  data,
  query,
  refresh,
}: {
  data: Execution
  query: string
  refresh: () => void
}) {
  const timeZone = useContext(TimeZoneContext)
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "workflow-history.json"
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <>
      <a className="back-link" href="#">
        <ArrowLeft className="size-3.5" />
        All executions
      </a>
      <div className="page-heading">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="detail-title">{data.name}</h1>
            <Status status={data.status} detail />
          </div>
          <p className="description break-anywhere">
            {data.instance.instance_id}
            <CopyID value={data.instance.instance_id} kind="workflow" />
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={refresh}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={download}
            aria-label="Download JSON"
            title="Download JSON"
          >
            <ArrowDownToLine />
          </Button>
        </div>
      </div>
      <Card className="metadata-card">
        <CardContent>
          <dl className="metadata">
            {[
              ["Execution ID", data.instance.execution_id],
              ["Task queue", data.queue],
              ["Started", date(data.created_at, timeZone)],
              ["Finished", date(data.completed_at, timeZone)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd
                  className={
                    label === "Execution ID" ? "font-mono text-xs" : ""
                  }
                >
                  {value}
                  {label === "Execution ID" && (
                    <CopyID value={value} kind="execution" />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Tabs defaultValue="timeline" className="execution-tabs">
        <TabsList
          variant="line"
          className="view-tabs"
          aria-label="Execution views"
        >
          {[
            { value: "timeline", label: "Timeline", icon: Activity },
            { value: "history", label: "Event history", icon: History },
            { value: "payloads", label: "Payloads", icon: Code2 },
            { value: "relationships", label: "Relationships", icon: GitBranch },
          ].map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              aria-label={label}
              title={label}
            >
              <Icon />
              <span className="tab-label">
                {label === "Event history" ? "History" : label}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="timeline">
          <Timeline data={data} />
        </TabsContent>
        <TabsContent value="history">
          <EventHistory events={data.history} />
        </TabsContent>
        <TabsContent value="payloads">
          <Payloads data={data} />
        </TabsContent>
        <TabsContent value="relationships">
          <Relationships query={query} current={data} />
        </TabsContent>
      </Tabs>
    </>
  )
}
export default function App() {
  const [timeZone, setTimeZone] = useState(() => {
    try {
      const stored = localStorage.getItem("go-workflows-timezone")
      if (stored && (stored === "local" || timeZones.includes(stored)))
        return stored
    } catch {
      /* Storage may be disabled by the embedding browser. */
    }
    return "local"
  })
  useEffect(() => {
    try {
      localStorage.setItem("go-workflows-timezone", timeZone)
    } catch {
      /* Selection still works for this session. */
    }
  }, [timeZone])
  const [hash, setHash] = useState(location.hash),
    [range, setRange] = useState("all"),
    [revision, setRevision] = useState(0),
    [cursors, setCursors] = useState([""]),
    [page, setPage] = useState(0)
  const [result, setResult] = useState<{
    data?: Execution
    list?: ExecutionPage
    stats?: Stats
    error?: string
    updated?: string
  }>({})
  const query = hash.startsWith("#execution?") ? hash.slice(11) : ""
  useEffect(() => {
    const changed = () => {
      setHash(location.hash)
      setPage(0)
      setCursors([""])
    }
    window.addEventListener("hashchange", changed)
    return () => window.removeEventListener("hashchange", changed)
  }, [])
  const cursor = cursors[page]
  const listZone = query
    ? "UTC"
    : timeZone === "local"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : timeZone
  useEffect(() => {
    const controller = new AbortController(),
      signal = controller.signal
    const load = async () => {
      setResult({})
      try {
        const result = query
          ? { data: await api<Execution>(`execution?${query}`, signal) }
          : await Promise.all([
              api<ExecutionPage>(
                `executions?${new URLSearchParams({ limit: "25", after: cursor, range, timezone: listZone })}`,
                signal
              ),
              api<Stats>("stats", signal),
            ]).then(([list, stats]) => ({ list, stats }))
        if (!signal.aborted)
          setResult({ ...result, updated: new Date().toISOString() })
      } catch (error) {
        if (!signal.aborted)
          setResult({
            error:
              error instanceof Error
                ? error.message
                : "Unable to load workflow data",
          })
      }
    }
    void load()
    return () => controller.abort()
  }, [query, cursor, revision, range, listZone])
  const resetPages = () => {
    setPage(0)
    setCursors([""])
  }
  const refresh = () => {
    resetPages()
    setRevision((value) => value + 1)
  }
  return (
    <TimeZoneContext.Provider value={timeZone}>
      <div className="app-shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <aside className="sidebar">
          <a
            className="brand"
            href="#"
            aria-label="go-workflows"
            title="go-workflows"
          >
            <Workflow className="size-7" />
          </a>
          <nav aria-label="Main navigation">
            <a
              className="nav-selected"
              href="#"
              aria-label="Executions"
              title="Executions"
            >
              <Layers className="size-4" />
            </a>
            <a href="#queues" aria-label="Queue backlog" title="Queue backlog">
              <Activity className="size-4" />
            </a>
          </nav>
          <div className="sidebar-bottom">
            <span
              role="img"
              aria-label="Read-only access. No workflow mutations."
              title="Read-only access. No workflow mutations."
            >
              <LockKeyhole className="size-4" />
            </span>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="flex items-center gap-2">
              <Workflow className="size-4 text-muted-foreground" />
              <span className="font-medium">go-workflows</span>
              <ChevronRight className="size-3 text-muted-foreground" />
              <span className="context-label text-muted-foreground">
                {query ? "Execution details" : "Executions"}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div
                className="timezone"
                title={`Display timezone: ${timeZone === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone}`}
              >
                <Clock3 className="size-4" />
                <NativeSelect
                  aria-label="Timezone"
                  value={timeZone}
                  onChange={(event) => {
                    resetPages()
                    setTimeZone(event.target.value)
                  }}
                  className="timezone-select"
                >
                  <NativeSelectOption value="local">Local</NativeSelectOption>
                  {timeZones.map((zone) => (
                    <NativeSelectOption key={zone} value={zone}>
                      {zone}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <Badge variant="outline" className="read-only">
                <LockKeyhole className="size-3" />
                Read only
              </Badge>
            </div>
          </header>
          <main id="main">
            {result.error ? (
              <>
                <a className="back-link" href="#">
                  <ArrowLeft className="size-4" />
                  All executions
                </a>
                <Card className="error-message" role="alert">
                  {result.error}
                </Card>
              </>
            ) : result.data ? (
              <ExecutionDetail
                key={`${hash}/${revision}`}
                data={result.data}
                query={query}
                refresh={refresh}
              />
            ) : result.list && result.stats ? (
              <ExecutionList
                data={result.list}
                stats={result.stats}
                page={page}
                refresh={refresh}
                previous={() => setPage(page - 1)}
                range={range}
                onRange={(value) => {
                  resetPages()
                  setRange(value)
                }}
                next={() => {
                  setCursors([...cursors.slice(0, page + 1), result.list!.next])
                  setPage(page + 1)
                }}
              />
            ) : (
              <p className="empty">Loading execution data…</p>
            )}
          </main>
          <footer className="page-footer">
            <span className="flex items-center gap-1.5">
              <RefreshCw className="size-3" />
              {result.updated ? date(result.updated, timeZone) : ""}
            </span>
          </footer>
        </div>
      </div>
    </TimeZoneContext.Provider>
  )
}
