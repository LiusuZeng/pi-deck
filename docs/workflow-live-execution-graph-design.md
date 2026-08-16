# Agent Workflow static and live execution graph — execution design

**Status:** Proposed; execution-ready design
**Owner:** BE (with renderer/UX implementation)
**Tracker:** [BE pending item](agent-workflows-backend-pending-items.md)

## 1. Problem and outcome

The current read-only workflow view represents relationships as text and arrows. It does not let a user quickly understand workflow topology, orchestration ownership, conditional routes, or a live run's position. A run detail instead leads with occurrence cards and raw session detail.

Build one **derived, read-only graph** that has two modes:

- **Definition mode** displays the workflow snapshot's nodes and relationships.
- **Run mode** uses that exact definition graph and overlays the selected run's current execution state.

The graph is an explanation and monitoring surface, not an editor or execution control plane. The canonical workflow JSON and scheduler remain authoritative.

### Success criteria

- A configured workflow displays nodes, directed connections, condition labels, and orchestration structure as a real graph rather than text arrows.
- A run graph accurately communicates which configured nodes are not started, active, completed, failed, skipped, cancelled, retrying, or blocked for human input.
- Users can select a node to inspect a concise, safe summary and deliberately open its Pi session where one exists.
- Fan-out, loops, retries, and resumed/re-hydrated runs are represented without falsely implying that one static node has only one execution.
- The graph remains usable by keyboard and has an equivalent text representation. Color alone never conveys role or state.

## 2. Scope and non-goals

### In scope

- Deterministic graph derivation from the immutable workflow definition/run snapshot.
- A shared graph model, layout, and renderer for static and live views.
- Per-node aggregate status and occurrence details for a selected run.
- Incremental run updates, restart recovery, terminal states, and human checkpoints.
- Node selection, concise occurrence summary, and an explicit deep link to Pi session detail.

### Out of scope

- Dragging nodes, editing links, saving node positions, or changing workflow JSON from the graph.
- A separate graph storage format or runtime truth owned by the renderer.
- Streaming raw prompt/transcript content into graph nodes.
- Changing scheduling, retry, cancellation, or orchestration behavior.
- Deciding whether a reopened Pi session permits follow-up prompts.

## 3. Canonical semantics

The definition graph derives only from the workflow's versioned JSON snapshot:

- Top-level nodes are connected by `relationships`.
- A normal relationship is a directed edge.
- Conditional relationships label the edge with its true/false/choice condition.
- An Orchestrator is a container node. Its managed Worker/Decider children appear inside it, with ownership edges distinct from top-level control-flow edges.
- A loop container identifies its completion Decider, iteration limit, and feedback path.
- A fan-out container identifies managed parallel children, concurrency limit, and all/any completion policy.
- Terminal outcomes appear as terminal graph nodes, not as fake workflow roles.

The source of truth is the run's immutable workflow-definition snapshot, never the currently edited template. This ensures historical runs remain understandable after a template changes.

## 4. Run-state projection

A static node may have zero, one, or many runtime occurrences. The graph must therefore project occurrences onto the stable configured node and retain the individual occurrence list for drill-in.

### 4.1 Node aggregate statuses

Use one primary aggregate state plus supplemental counts/details:

| Aggregate state | Meaning |
| --- | --- |
| `not_started` | No occurrence has been scheduled for this configured node in this run. |
| `queued` | An occurrence is ready but not yet executing, including capacity-limited work. |
| `in_progress` | At least one occurrence is executing. |
| `waiting_human` | A current Human occurrence needs input, approval, or a choice. |
| `retrying` | A prior attempt failed and a retry is pending or active. |
| `completed` | All relevant occurrences completed and no active/retry occurrence remains. |
| `failed` | A terminal failure prevents normal continuation. |
| `skipped` | The route was not selected, or fan-out/any completion made the occurrence unnecessary. |
| `cancelled` | The run or node was stopped/cancelled. |
| `unknown` | Legacy/incomplete history cannot be faithfully mapped; show an explicit data-availability notice. |

Precedence is: `waiting_human` → `in_progress` → `retrying` → `queued` → terminal failure/cancellation → `completed` → `skipped` → `not_started`. The payload must also include counts so a mixed fan-out node can state, for example, “2 completed, 1 in progress.”

### 4.2 Occurrence details

For each configured node, expose an ordered, bounded list of occurrence summaries:

- occurrence ID and configured node ID;
- status, attempt, iteration, parent orchestrator occurrence ID;
- started/ended timestamps and elapsed time where available;
- safe/truncated output summary or error summary;
- whether a human response is required and which interaction type;
- durable Pi session reference, if the role created one.

The UI must not derive status from transcript text. Full prompts, output, and transcripts stay behind explicit drill-in/session actions and existing authorization controls.

### 4.3 Edges and paths

Edges retain their definition semantics. Run mode overlays a state:

- `not_taken` for a conditional route not selected;
- `pending` when its source has not resolved;
- `active` when execution has crossed/is currently traversing it;
- `taken` after a successful traversal;
- `blocked` when upstream failure, cancellation, or an unmet human checkpoint prevents progress.

For loops, the container shows current/max iteration and the selected child occurrence/attempt. For fan-out, it shows completed/total, active count, and completion policy. Do not draw a separate permanent node for every iteration unless a selected-node detail explicitly expands those occurrences; doing so would make the overview unstable and unreadable.

### 4.4 Execution budgets, retries, and failures

The graph must communicate both configured limits and live consumption. Do not hide this information exclusively in raw occurrence cards.

| Concern | Static definition graph | Live run graph |
| --- | --- | --- |
| Loop | Display `maxIterations` and the completion condition/Decider. | Display `completed iterations / maxIterations`, `iterations remaining`, current iteration, and whether termination was completion, limit exhaustion, failure, cancellation, or a human gate. |
| Retryable node | Display configured `maxAttempts` (or “no retry” for one attempt) and retry policy. | Display `attempt N / maxAttempts`, `retries remaining`, retry-pending/active state, most recent failure summary, and terminal failure once the budget is exhausted. |
| Fan-out | Display managed-child count, concurrency limit, and all/any completion policy. | Display `completed / total`, active, queued, failed, skipped/cancelled counts, plus whether the completion policy has been satisfied or can no longer be satisfied. |
| Human checkpoint | Display interaction type and configured prompt summary. | Display waiting duration, requested action, and whether downstream work is blocked. |
| Conditional route | Display each labeled possible outcome. | Clearly distinguish selected/taken route, pending routes, and routes not taken. |

These values are calculated from persisted occurrence state and scheduler policy, not inferred from agent output. “Remaining” must be `null`/“not applicable” when no finite configured budget exists; it must never be invented from a timeout or UI estimate. Failure summaries are concise, redacted/bounded, and link to node detail rather than rendering full error/transcript text on the canvas.

### 4.5 Information density rules

The node's default visual treatment presents the most decision-relevant facts without turning the graph into a dashboard of tiny text:

- Always show node name, role, primary status, and one compact state badge.
- Loop containers show `iteration 2 of 3` (and therefore one remaining) while active or terminal reason when done.
- Retryable nodes show `attempt 2 of 3` and a failure indicator when relevant.
- Fan-out containers show `3/5 complete · 1 active`.
- Selecting/focusing a node reveals the full breakdown, occurrence history, timestamps, failure summary, and remaining budget in the inspector.
- Tooltips/accessible descriptions expose the abbreviated values; the structured text alternative exposes all values directly.

## 5. Backend and IPC contract

### 5.1 Shared graph projection types

Add renderer-safe shared types, for example `WorkflowGraphSnapshot`, `WorkflowGraphNode`, `WorkflowGraphEdge`, and `WorkflowGraphOccurrenceSummary`. The API must contain:

```text
WorkflowGraphSnapshot {
  workflowSnapshot: canonical definition snapshot
  runId?: string
  runStatus?: queued | running | waiting_human | completed | failed | cancelled
  revision: monotonically increasing run revision
  nodes: [{ nodeId, aggregateStatus?, counts?, occurrences? }]
  edges: [{ relationshipId, status? }]
  updatedAt?: timestamp
}
```

Definition mode omits run-specific fields. Run mode requires the exact run snapshot and must include every configured node and relationship, even when no occurrence exists.

Do not expose `runtimeId` as a durable session identity. Session-opening references use the durable `sessionFile` policy tracked separately in [the reopenable-session item](agent-workflows-backend-pending-items.md#backend-pending-items).

### 5.2 Derivation and lifecycle

- The main-process workflow layer owns snapshot derivation from persisted run/occurrence state.
- Derivation must be pure and deterministic for a given definition/run state, enabling unit tests and rehydration.
- Run creation, scheduling transitions, retries, human responses, stop/cancel, and rehydration persist state first, increment the run revision, then publish the derived graph snapshot.
- The renderer fetches a full snapshot on opening a run and applies only newer revisions from subscriptions. On a revision gap, reconnect, or app reload, it refetches rather than guessing missed transitions.
- IPC must authorize the run and associated workspace before returning graph data. Output/error summaries must use existing bounds/redaction rules.

Polling is acceptable only as a temporary compatibility fallback; the design target is an existing or new scoped workflow-run update subscription. Subscription cleanup must occur when the run view unmounts or changes runs.

## 6. Renderer behavior

### 6.1 Static definition graph

Place the graph in the existing read-only Graph view. Auto-layout is deterministic (stable node/edge IDs yield stable placement), recalculates on definition changes, and does not persist positions. A layered left-to-right layout is the default; containers are laid out before their children. Static nodes expose configured execution limits, including max attempts, loop max iterations, fan-out concurrency/completion policy, and human interaction type, so users understand the workflow's operational behavior before starting it. On small displays, provide fit-to-view, zoom, pan, and a list/text alternative rather than requiring precise horizontal manipulation.

### 6.2 Live run graph

Make the graph the initial monitoring summary in run detail. Show run status, start/update time, and compact progress counts above it. Node treatment includes role shape/icon, visible state label, and status indicator; edge treatment includes visible condition labels and state. Selecting a node opens an inspector/drawer with occurrence selector (when multiple), summaries, errors, retry/iteration data, human action when applicable, and **Open Pi session** as a deliberate deep link.

The graph must not imply that an occurrence has completed solely because its Pi session exists. It renders scheduler-persisted occurrence status.

### 6.3 Accessibility

- Nodes and edges have programmatic names including node name, role, aggregate state, and relevant count.
- Keyboard navigation supports entering the graph, moving among connected nodes, selecting a node, and returning focus from the inspector.
- A structured text/list alternative exposes nodes, relationships, state, and selected route/occurrence details without requiring canvas interaction.
- State uses text/icon/pattern in addition to color; animation respects reduced-motion preferences.
- Live updates announce material changes concisely (for example, “Implement: completed”) without reading every update or stealing focus.

## 7. Delivery sequence

1. **Contract audit and fixtures.** Inventory current schemas, store records, scheduler events, rehydration behavior, and renderer update channels. Create fixtures for linear, decision, fan-out, loop, retry, failure, human wait, cancellation, and legacy run data. Resolve missing node-to-occurrence or revision fields before UI work.
2. **Pure projection layer.** Implement shared types and main-process pure derivation from definition/run records. Add unit tests for aggregate precedence, edge state, occurrence ordering, loop/fan-out counts, and legacy fallback.
3. **Snapshot IPC and updates.** Add authorized fetch and scoped update delivery; persist-before-publish and revision rules. Test ordering, reconnect/refetch, rehydration, and subscription cleanup.
4. **Shared static graph.** Implement graph model/layout/rendering with deterministic snapshots, containers, labeled conditions, selection, and accessible text alternative. Replace text-and-arrows rendering only after semantic parity tests pass.
5. **Live overlay and inspector.** Bind run graph to snapshots; add state treatments, occurrence drill-in, human controls, and session link. Keep existing controls functional throughout.
6. **Integration hardening.** Validate real Pi sessions, restart recovery, long fan-out/loop runs, retries, error redaction, cancellation races, narrow layouts, and assistive-technology keyboard paths.

## 8. Test matrix and acceptance gate

### Automated coverage

- Shared schema/projection: all aggregate and edge states, missing/legacy data, bounded summaries, deterministic output.
- Store/scheduler: every persisted transition produces the expected next revision/snapshot; no stale completion overwrites a newer state.
- IPC: workspace/run authorization, subscription scope/cleanup, revision-gap refetch behavior.
- Renderer: static graph semantic parity, selected-node inspector, all statuses, multiple occurrences, and text alternative/keyboard behavior.
- E2E: linear completion; conditional branch; fan-out with mixed progress; loop with iterations; retry then success; terminal failure; waiting-human response; stop/cancel; restart recovery; Pi-session deep link.

### Completion gate

The item is complete only when a user can open a workflow or a prior/current run and accurately answer: **what can run, what has run, what is running/waiting, which route was taken, and why execution stopped or needs attention**—without reading raw transcripts. The graph must stay consistent with the persisted scheduler state across reload/restart, and all graph interaction has a keyboard-accessible equivalent.
