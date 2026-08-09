# Agent Workflows — Canonical Product Design

**Status:** Product direction approved; Build, Graph, persistence, and core role runtime implemented; occurrence-run UI integration remains in progress
**Date:** 2026-08-07
**Tracking item:** [Agent Workflows feedback item 2](agent-workflows-feedback.md#2-replace-the-field-heavy-step-model-with-four-execution-roles)

This is the single implementation-oriented product design for Agent Workflows.
It replaces the field-heavy agent-step editor and agent-only workflow contract
with four generic role templates, one canonical versioned JSON workflow
definition, compact configuration cards, and a derived read-only graph.

Storage schema numbers are migration details, not product variants. The UI,
documentation, and runtime expose one Agent Workflows model: Worker, Decider,
Orchestrator, and Human.

## 1. Goals

- Give users exactly four workflow concepts: Worker, Decider, Orchestrator, and
  Human.
- Let users configure instances of those roles and relationships between them.
- Cover application concepts such as planner, researcher, implementer, reviewer,
  tester, and writer without adding more core roles or templates.
- Make versioned JSON the canonical workflow source so workflows do not depend on
  the GUI.
- Provide synchronized Build, Graph, and JSON views over one workflow document.
- Keep role configuration compact while making loops, fan-out, decisions, and
  human interaction understandable.
- Preserve existing workflow data and run history through explicit versioning and
  migration.

## 2. Non-goals

- YAML support in the first version.
- A custom workflow DSL.
- A free-form or editable graph canvas.
- Planner, reviewer, tester, or similar additional role types.
- Arbitrary graph cycles; repetition is owned by a Loop Orchestrator.
- Full forms embedded in every workflow card.
- Drag-to-connect as a required interaction.
- Replacing Pi-native skills with workflow concepts.

## 3. Terminology

### Role template

One of four fixed generic contracts supplied by Pi Deck:

1. Worker
2. Decider
3. Orchestrator
4. Human

A role template defines the fields users can configure and the runtime output
contract. It contains no concrete planner/reviewer names, prompts, or workflow
relationships.

### Configured role instance

One use of a role template inside a workflow. It has a stable ID, a user-facing
name, role-specific configuration, and optional shared execution settings.

For example, a role instance may be named “Plan the change,” but its role remains
`worker`. The application name does not create a Planner role or template.

### Relationship

A directed connection from a configured role instance to another role instance
or a terminal workflow outcome. Relationships pass completion and output context.
Conditional relationships compare the fixed output of a Decider or Human role.

### Managed role

A role instance owned by an Orchestrator. Managed roles execute only through that
Orchestrator and are not independent top-level entry points.

## 4. Fixed role-template contracts

These contracts describe configurable fields. They are schema definitions, not
concrete workflow configurations.

```json
[
  {
    "role": "worker",
    "inputs": {
      "instructions": { "type": "text", "required": true },
      "input": { "type": "context", "required": false },
      "expectedOutput": { "type": "text", "required": false }
    },
    "output": { "type": "text", "required": false }
  },
  {
    "role": "decider",
    "inputs": {
      "question": { "type": "text", "required": true },
      "input": { "type": "context", "required": true },
      "trueLabel": {
        "type": "text",
        "required": false,
        "default": "Yes"
      },
      "falseLabel": {
        "type": "text",
        "required": false,
        "default": "No"
      }
    },
    "output": { "type": "boolean", "required": true }
  },
  {
    "role": "orchestrator",
    "inputs": {
      "mode": {
        "type": "enum",
        "values": ["loop", "fanout"],
        "required": true
      },
      "agents": { "type": "agentReferences", "required": true },
      "input": { "type": "context", "required": false },
      "decider": {
        "type": "agentReference",
        "requiredWhen": { "mode": "loop" }
      },
      "maxIterations": {
        "type": "integer",
        "minimum": 1,
        "requiredWhen": { "mode": "loop" }
      },
      "maxConcurrency": {
        "type": "integer",
        "minimum": 1,
        "requiredWhen": { "mode": "fanout" }
      },
      "completion": {
        "type": "enum",
        "values": ["all", "any"],
        "default": "all",
        "requiredWhen": { "mode": "fanout" }
      }
    },
    "output": { "type": "agentOutputs", "required": false }
  },
  {
    "role": "human",
    "inputs": {
      "interaction": {
        "type": "enum",
        "values": ["input", "approval", "choice"],
        "required": true
      },
      "prompt": { "type": "text", "required": true },
      "input": { "type": "context", "required": false },
      "options": {
        "type": "textList",
        "requiredWhen": { "interaction": "choice" }
      }
    },
    "output": {
      "typeByInteraction": {
        "input": "text",
        "approval": "boolean",
        "choice": "text"
      },
      "required": true
    }
  }
]
```

### 4.1 Worker

A Worker performs concrete work. Its instructions are required. Runtime input and
text output are optional. Planning, researching, coding, reviewing, testing, and
writing are configured Worker uses, not separate concepts.

A Worker that performs workspace changes may omit a downstream text output. A
Worker whose result is used by another role provides a text result, normally the
Pi session's final answer.

### 4.2 Decider

A Decider evaluates provided context against one question and emits exactly
`true` or `false`. The user may customize the display labels, but labels do not
change the boolean runtime contract.

The underlying implementation may use Worker/Pi-session machinery. That detail
must not appear in the role configuration UX. Malformed or ambiguous model output
is a runtime attention/error state, not a third canonical decision value.

### 4.3 Orchestrator

An Orchestrator manages and monitors other agents without doing their domain work.
It has two initial modes:

- `loop`: repeatedly runs managed agents and evaluates a managed Decider until the
  Decider returns the configured completion value or `maxIterations` is reached.
- `fanout`: dispatches managed agents with bounded concurrency and completes when
  `all` or `any` satisfies the completion policy.

The workflow engine enforces iteration and concurrency limits. These safeguards
must never depend only on model instructions.

### 4.4 Human

A Human role creates a workflow checkpoint without creating a model-backed Pi
session.

- `input` returns text.
- `approval` returns a boolean.
- `choice` returns one configured option value.

Human roles do not expose model, thinking, or tool configuration.

## 5. Shared execution settings

Model-backed roles may optionally use shared execution settings:

```json
{
  "model": "inherit",
  "thinking": "inherit",
  "maxAttempts": 1,
  "timeoutSeconds": 1200
}
```

These settings are not additional role concepts. Human roles reject them. The UI
places them under an Advanced section rather than in the compact card.

Failure behavior such as retry, stop, or request attention is also an execution
policy, not a role type.

## 6. Canonical JSON workflow definition

The workflow definition is one strict, versioned JSON document. The role
templates are fixed by the schema and are not repeated in every workflow. Each
node directly identifies one role and supplies that role's configuration.

```json
{
  "format": "pi-deck.agent-workflow",
  "schemaVersion": 2,
  "id": "feature-delivery",
  "revision": 1,
  "name": "Feature delivery",
  "description": "Plan, implement, verify, approve, and summarize a change.",
  "inputs": [
    {
      "id": "request",
      "label": "What should be built?",
      "type": "text",
      "required": true
    }
  ],
  "entryNodeId": "plan",
  "nodes": [
    {
      "id": "plan",
      "name": "Plan the change",
      "role": "worker",
      "config": {
        "instructions": "Create an ordered implementation plan. Do not edit files.",
        "expectedOutput": "An implementation plan with validation steps."
      },
      "execution": {
        "thinking": "high"
      }
    },
    {
      "id": "delivery",
      "name": "Implement until ready",
      "role": "orchestrator",
      "config": {
        "mode": "loop",
        "agents": ["implement"],
        "decider": "ready",
        "maxIterations": 3
      }
    },
    {
      "id": "implement",
      "name": "Implement the change",
      "role": "worker",
      "managedBy": "delivery",
      "config": {
        "instructions": "Implement the plan and run focused tests.",
        "expectedOutput": "Changed files, test evidence, and remaining issues."
      }
    },
    {
      "id": "ready",
      "name": "Check readiness",
      "role": "decider",
      "managedBy": "delivery",
      "config": {
        "question": "Is the implementation correct, tested, and ready for approval?",
        "trueLabel": "Ready",
        "falseLabel": "Needs revision"
      }
    },
    {
      "id": "approval",
      "name": "Approve the result",
      "role": "human",
      "config": {
        "interaction": "approval",
        "prompt": "Review the completed implementation and approve or reject it."
      }
    },
    {
      "id": "summary",
      "name": "Summarize the result",
      "role": "worker",
      "config": {
        "instructions": "Summarize the completed work, validation, and limitations.",
        "expectedOutput": "A concise final report."
      }
    }
  ],
  "relationships": [
    {
      "id": "plan-to-delivery",
      "from": "plan",
      "to": { "nodeId": "delivery" }
    },
    {
      "id": "delivery-to-approval",
      "from": "delivery",
      "to": { "nodeId": "approval" }
    },
    {
      "id": "approval-accepted",
      "from": "approval",
      "when": { "equals": true },
      "to": { "nodeId": "summary" }
    },
    {
      "id": "approval-rejected",
      "from": "approval",
      "when": { "equals": false },
      "to": { "end": "rejected" }
    },
    {
      "id": "summary-complete",
      "from": "summary",
      "to": { "end": "completed" }
    }
  ]
}
```

This example uses application labels such as “Plan the change,” but they are node
names and configurations. The only role values remain `worker`, `decider`,
`orchestrator`, and `human`.

## 7. Context and output handoff

The first version should avoid an expression language and named data ports.

- The entry node receives workflow inputs and shared workflow context.
- A normal relationship passes the source output to the destination as input.
- A Loop Orchestrator supplies its input to the first managed agent.
- Later loop iterations also receive the prior output and the Decider's false
  result context.
- The loop Decider receives the latest managed-agent outputs.
- A Fan-out Orchestrator supplies its input to each managed agent and collects
  their outputs.
- An Orchestrator exposes collected/final managed outputs to its downstream
  relationship.
- Roles may omit output when no downstream role requires it.

The exact persisted representation of explicit non-default input binding remains
an implementation detail to settle before supporting arbitrary bindings. The canonical workflow model must
not add a custom expression or interpolation DSL.

## 8. Relationship semantics

Relationships connect top-level nodes. Orchestrator ownership references managed
nodes directly through `agents` and, for loops, `decider`.

Validation rules:

- Node and relationship IDs are unique and stable.
- `entryNodeId` references a known, unmanaged node.
- Every top-level node is reachable from the entry.
- Every managed node has exactly one Orchestrator owner.
- `managedBy` and the owning Orchestrator's references agree.
- Managed nodes cannot be top-level relationship targets or sources.
- A Loop Orchestrator has at least one managed agent, one managed Decider, and a
  finite positive `maxIterations`.
- A Fan-out Orchestrator has at least one managed agent, a positive
  `maxConcurrency`, and `completion: "all" | "any"`.
- Arbitrary cycles are invalid; only Loop Orchestrators repeat managed roles.
- Conditional relationships may originate only from boolean/choice outputs.
- A top-level Decider has at most one true route and one false route.
- Human choice option IDs are unique and relationship conditions reference only
  declared options.
- Relationship targets reference a node or a named terminal outcome, never both.
- Unknown fields and unsupported schema versions are rejected without deleting
  the source document.

## 9. Runtime model

Older runs materialize exactly one run record per static step. Canonical loops
and fan-out require occurrence-based runtime records.

Each execution creates a node occurrence:

```json
{
  "id": "node-run-uuid",
  "nodeId": "implement",
  "parentOrchestratorRunId": "orchestrator-run-uuid",
  "iteration": 2,
  "attempt": 1,
  "status": "completed",
  "output": "Implementation and test summary",
  "sessionId": "pi-session-id"
}
```

Requirements:

- A run stores an immutable snapshot of the resolved canonical workflow definition.
- Loop iterations, retries, and fan-out children produce distinct occurrences.
- Worker and Decider occurrences may own Pi sessions.
- Human occurrences pause without creating a Pi session.
- Orchestrator occurrences track managed children, completion state, iteration,
  concurrency, and aggregation.
- Stop/cancel ownership checks must retain the current stale-completion safety.
- Full transcripts remain Pi-session-owned; workflow records store bounded output
  and session references.
- Restart recovery handles each occurrence independently and must not silently
  restart completed work.

## 10. Builder UI/UX

The editor has three synchronized views:

```text
[Build] [Graph] [JSON]
```

All views project the same canonical in-memory JSON document.

### 10.1 Build view

Build is the primary authoring view.

- Show compact cards for configured role instances.
- Add Role presents exactly Worker, Decider, Orchestrator, and Human.
- Cards show role, name, a short configuration summary, relationships, and
  validation state.
- Selecting a card opens one focused role-specific inspector.
- Required fields appear first; optional fields follow; shared execution settings
  remain collapsed under Advanced.
- Cards never embed full textareas, model selectors, and transition forms.
- Connections use explicit buttons/searchable target selection. Dragging is not
  required.
- A Decider card shows true and false destinations.
- A Loop Orchestrator card contains or references its managed-agent sequence and
  Decider, plus the maximum iteration count.
- A Fan-out Orchestrator card shows parallel managed agents, concurrency, and
  all/any completion policy.
- A Human card shows Input, Approval, or Choice and its expected interaction.

Desktop uses a side inspector. Tablet uses a drawer. Mobile uses a full-screen
configuration sheet and keeps Build as the required editing experience.

### 10.2 Graph view

Graph is derived, auto-laid out, and view-only.

- It never stores a second editable graph or canonical node positions.
- Selecting a graph node may focus the corresponding Build card/inspector.
- Users cannot drag, reconnect, or mutate workflow semantics in Graph.
- Decider edges are labeled true and false.
- Orchestrators render as containers around managed roles.
- Loop containers display the maximum iteration limit and completion Decider.
- Fan-out containers display parallel branches and all/any completion.
- Human nodes display their interaction type.
- Shape, text, and icons communicate role; color is supplementary.
- The same graph can later overlay live run status and progress.

### 10.3 JSON view

JSON is a direct editor for the canonical workflow source.

- Maintain a temporary text draft separate from the last valid document.
- Parse, schema-validate, and graph-validate before Apply.
- Invalid JSON never replaces the last valid workflow.
- Show line/column syntax errors and JSON-path semantic errors.
- Provide Format, Copy, Apply, and Revert.
- Clicking a validation error should focus the related Build card when possible.
- Save persists only a valid document.
- Run snapshots exactly the saved canonical document.

## 11. Accessibility

- Every graph node and relationship has an equivalent semantic representation in
  Build.
- All editing is possible without dragging or pointer precision.
- Cards expose role, name, validation state, incoming relationship, and outgoing
  outcomes to assistive technology.
- Inspector fields use unique labels and field-associated errors.
- Opening and closing the inspector restores focus to the originating card.
- Graph selection supports keyboard navigation but is never required for editing.
- Role and status are not communicated by color alone.
- Mobile does not require horizontal graph interaction to configure a workflow.

## 12. Persistence, versioning, and migration

The workflow store must perform version-aware loading before parsing or changing
persisted shapes. Storage versions are internal migration boundaries and must not
create parallel product behavior.

Required behavior:

1. Detect the store/document version before parsing the current schema.
2. Preserve unsupported future versions and report them; never replace them with
   an empty store.
3. Back up v1 data before migration.
4. Convert legacy agent steps to Worker nodes.
5. Convert condition transitions to Decider nodes and boolean relationships.
6. Convert manual gates/start approvals to Human approval nodes.
7. Preserve legacy prompt/context data or normalize it through an explicit,
   tested migration.
8. Preserve existing run snapshots. Completed/in-progress v1 runs should remain
   readable through a legacy path rather than being rewritten as fabricated v2
   occurrences.
9. New canonical runs use occurrence-based runtime state.
10. Template edits never mutate existing run snapshots.

## 13. Validation layers

1. **JSON syntax:** valid JSON with useful line/column errors.
2. **Schema:** supported version, strict role union, role-specific config types,
   and no unknown fields.
3. **Graph:** IDs, references, reachability, legal ownership, no arbitrary cycles,
   complete boolean/choice routing, and terminal targets.
4. **Role semantics:** required Worker instructions, required Decider question,
   mode-specific Orchestrator fields, and interaction-specific Human fields.
5. **Runtime compatibility:** available models/thinking levels, workspace scope,
   authorized paths, and scheduler limits.

The same shared validator serves import, JSON Apply, GUI editing, Save, IPC, and
run creation.

## 14. Implementation sequence

### Phase 1 — Contracts and migration foundation

- Add canonical definition and occurrence schemas as strict discriminated unions.
- Add semantic graph validation.
- Add version-aware store loading and non-destructive migration infrastructure.
- Add fixtures and round-trip tests before changing the UI.

Primary files:

- `src/shared/workflowSchemas.ts`
- `src/shared/workflowSchemas.test.ts`
- `src/main/workflows/workflowStore.ts`
- `src/main/workflows/workflowStore.test.ts`
- new `src/main/workflows/workflowMigrations.ts`

### Phase 2 — Runtime execution

- Execute Worker and Decider roles.
- Add occurrence-based run records.
- Add Loop and Fan-out Orchestrator scheduling.
- Add Human input/approval/choice pauses.
- Preserve cancellation, retry, capacity, and recovery safety.

Primary files:

- `src/main/workflows/workflowEngine.ts`
- `src/main/workflows/workflowEngine.test.ts`
- `src/main/workflows/workflowScheduler.ts`
- `src/main/workflows/workflowScheduler.test.ts`
- `src/main/workflows/workflowPromptRenderer.ts`

### Phase 3 — Build and JSON views

- Replace full inline step/transition forms with role cards and an inspector.
- Make one canonical document the renderer state.
- Add role-aware validation and safe JSON draft/apply/revert behavior.

Primary files:

- `src/renderer/components/workflows/WorkflowBuilder.tsx`
- replace/simplify `WorkflowStepCard.tsx`
- replace/simplify `WorkflowTransitionCard.tsx`
- new role picker, card, inspector, and JSON editor components
- `src/renderer/App.tsx`
- `src/renderer/styles.css`

### Phase 4 — Read-only Graph

- Add deterministic auto-layout from the canonical document.
- Render role, outcome, loop, fan-out, and Human semantics.
- Add keyboard selection and Build-card synchronization.
- Reuse the graph model for run status overlays.

### Phase 5 — End-to-end validation

- Migrate representative v1 workflows.
- Round-trip GUI → JSON → GUI without semantic changes.
- Exercise Worker, Decider, Loop, Fan-out, and each Human interaction.
- Validate restart, stop, retry, capacity, and corrupted/unsupported data behavior.

## 15. Test requirements

- Unit tests for each valid and invalid role configuration.
- Conditional-field tests for both Orchestrator modes and all Human interactions.
- Graph reachability, ownership, cycle, and route tests.
- Migration fixtures for prompt-first and legacy structured workflows.
- Store tests proving unsupported versions are preserved.
- Runtime tests with multiple loop iterations and repeated node occurrences.
- Fan-out tests for concurrency, all/any completion, partial failure, and cancel.
- Human pause/resume tests with no Pi session creation.
- Renderer tests for compact cards and inspector focus behavior.
- JSON syntax/schema/semantic error and last-valid-document tests.
- Graph snapshot/semantic tests and keyboard-selection tests.
- E2E round-trip and run-progress tests.

## 16. Open implementation questions

These are not new product concepts and should be resolved before their respective
implementation phase:

1. Whether an Orchestrator owns a supervisory Pi session or is entirely executed
   by deterministic engine behavior. Limits and scheduling remain engine-enforced
   either way.
2. Whether first-version Fan-out agents are a fixed configured list only or may be
   generated dynamically from input items. Fixed lists are the simpler default.
3. The exact persisted form for explicit non-default input bindings. The default
   remains relationship-based handoff without an expression DSL.
4. The shape and size limits of aggregated Orchestrator outputs.
5. Detailed failure policies for partial Fan-out failure and exhausted loops.
6. Whether terminal outcome names are fixed (`completed`, `rejected`, `stopped`)
   or workflow-defined identifiers.

These questions must not introduce additional role types.
