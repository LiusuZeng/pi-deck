# Agent Workflows Design

Status: proposed feature design  
Date: 2026-08-04  
Owner: TBD  
Related docs: `docs/requirements.md`, `docs/technical-architecture.md`, `docs/workspace-grouped-sessions-execution-plan.md`, `docs/activity-inbox-tagged-filtering-plan.md`, `docs/agent-workflows-parallel-implementation-plan.md`

## 1. Summary

**Agent Workflows** are a focused orchestration layer for Pi Deck. A workflow lets a user define a small graph of Pi agent steps ahead of time, then Pi Deck queues and starts those sessions as upstream steps complete.

The first version intentionally avoids a user-facing DSL. Users configure workflows through a dedicated card-based UI with agent steps and transition rules. Conditions are written in natural language and evaluated by a dedicated Pi judge step that returns one of a small set of branch labels.

Pi Deck remains a local Pi agent harness:

- each agent step is a Pi-native session backed by a normal `pi --mode rpc` worker when running;
- workflow state is Pi Deck-owned orchestration metadata;
- session transcripts remain Pi-owned JSONL files;
- the existing chat/session UI remains the worker cockpit;
- the new Agent Workflows UI becomes the orchestration cockpit.

Product differentiator to preserve throughout the design:

> **Skills are reusable agent abilities. Agent Workflows are reusable agent orchestration plans.**

Agent Workflows should compose Pi-native skills, slash commands, prompt templates, models, thinking levels, and session files rather than replacing them.

## 2. Product goals

1. Let users define multi-agent work before waiting for the first agent to finish.
2. Save user time by automatically queueing downstream agents when dependencies resolve.
3. Keep orchestration understandable without code, scripts, or DSL syntax.
4. Preserve user control with manual approval gates and branch preview options.
5. Build on existing Pi Deck concepts: workspaces, sessions, Work inbox, runtime state, model/thinking controls, attachments, steer/follow-up/abort.

## 3. Non-goals for the first release

- No arbitrary scripting language.
- No loops.
- No general variable/expression system.
- No full visual programming canvas in the first slice.
- No automatic source-code editing outside what Pi agents already do.
- No cross-machine/cloud workflow execution.
- No guaranteed semantic correctness of condition judging; conditions are an orchestration aid, not formal proof.
- No metrics/ops dashboard as part of this feature.

## 4. Core vocabulary

| Term | Meaning |
| --- | --- |
| **Workflow Template** | Reusable user-defined orchestration plan. |
| **Workflow Run** | One execution instance of a template. |
| **Agent Step** | A Pi session definition: prompt, model, thinking, inputs, workspace target. |
| **Transition** | A rule that decides what can run after a step completes. |
| **Condition** | A natural-language question evaluated against upstream output. |
| **Judge Step** | A hidden or collapsible Pi step that evaluates a condition and returns `yes`, `no`, or `unsure`. |
| **Manual Gate** | A pause point where the user approves, edits, skips, or reroutes the next step. |
| **Step Output** | Final assistant response, transcript summary, session link, selected files changed summary when available later. |

## 5. Relationship to Pi skills

Agent Workflows are intentionally different from Pi skills.

| Concept | Pi Skill | Agent Workflow |
| --- | --- | --- |
| Product layer | Agent capability/context | Multi-agent orchestration |
| Runs inside | One Pi session | Pi Deck-managed workflow run across one or more sessions |
| Main job | Teach an agent how to perform a task | Decide what agents run, when they run, and how outputs flow |
| Logic/state | Mostly prompt/resource content | Step status, transitions, branches, gates, queueing |
| Output handling | Current agent decides what to do next | Pi Deck can pass output to downstream steps |

A workflow step may invoke a skill, for example a review step can use `/skill:code-review`. The workflow itself should not duplicate skill content. It should orchestrate Pi-native capabilities by deciding:

- when to start a session;
- what prompt/context to send;
- which skill or command a step should use;
- which previous outputs to include;
- which branch to take;
- when to ask the user;
- when to stop.

This boundary keeps Pi Deck focused as a harness and orchestration framework rather than a replacement for Pi's resource system.

## 6. MVP scope

The MVP should support four primitives:

1. **Agent step**
   - prompt body;
   - model and thinking defaults;
   - optional referenced paths/images using existing attachment token flow at run start;
   - input source selection from upstream steps.

2. **Always-after transition**
   - run step B after step A completes successfully.

3. **Natural-language if/else transition**
   - ask a yes/no/unsure question about step A's result;
   - map each result to one next step or to a manual gate.

4. **Manual approval gate**
   - pause workflow;
   - let user approve, edit next prompt, skip, or stop the workflow.

The MVP should also support saving templates and running a template in a selected workspace.

## 7. User experience design

### 7.1 Entry points

Add an **Agent Workflows** entry point without disrupting the current chat/session UI.

Recommended entry points:

1. Sidebar top-level item: **Agent Workflows**.
2. Workspace header action: **New workflow**.
3. Completed session action: **Create workflow from this session**.
4. Chat action menu: **Queue downstream agent** as a small bridge into the workflow builder.

The first two are primary. The latter two are convenience paths after the initial screen exists.

### 7.2 Top-level Agent Workflows screen

The screen has two tabs or segmented controls:

```text
Agent Workflows
[ Templates ] [ Runs ]

Templates
- Bug triage → fix → review
- Feature plan → implement → docs
- Investigate flaky test

Runs
- Bug triage #12        Running
- Feature plan #4       Waiting for approval
- Flaky test #8         Completed
```

Template row actions:

- Run
- Edit
- Duplicate
- Archive

Run row actions:

- Open run
- Pause/Resume when supported later
- Stop remaining queued steps
- Open active session

### 7.3 Workflow Builder

Use a vertical card builder, not a node canvas for MVP.

Example layout:

```text
Workflow: Fix failing tests
Workspace: Current workspace

Step 1 · Agent
Name: Investigate failing test
Prompt:
  Find the root cause of the failing test. Do not change code yet.
Model: [default / picker]
Thinking: [default / picker]
Inputs: [Current workspace] [Referenced paths...]

After Step 1
[ Ask a condition ]
Question:
  Did the investigation identify a concrete and safe code fix?

If YES → Step 2A · Agent
  Name: Implement fix
  Prompt:
    Use the investigation output below and implement the smallest safe fix.
    {{Step 1 final answer}}

If NO → Step 2B · Agent
  Name: Investigate deeper
  Prompt:
    Continue investigation. Focus on reproducing and collecting evidence.
    {{Step 1 final answer}}

If UNSURE → Manual approval
```

Builder principles:

- Every card has a plain-language title.
- Users choose rule types from dropdowns instead of writing syntax.
- Prompt insertion uses chips/placeholders, not mustache syntax in the UI. Internally placeholders may be stored as structured references.
- Conditions have preview copy explaining that Pi Deck will ask a small judge agent to answer `yes`, `no`, or `unsure`.
- Invalid workflows show inline card-level validation.

### 7.4 Agent Step card

Fields:

- Name.
- Prompt.
- Model: inherit workflow default or override.
- Thinking: inherit workflow default or override.
- Input context:
  - No upstream context.
  - Explicit previous-agent result chips: final answer, summary, or bounded transcript.
  - Workflow inputs and shared workflow context.
  - Multiple upstream outputs in later fan-in versions.

Parent-session policy toggles and arbitrary transcript selection are intentionally
not exposed in the first release. Handoffs are explicit prompt parts so a step
cannot silently request context that is unavailable.
- Attachments/referenced paths:
  - use existing picker UX;
  - tokens are not persisted long term; template stores references only when safe, such as explicit paths.
- Run behavior:
  - auto-start when ready;
  - require approval before start.

### 7.5 Transition card

Supported MVP transition types:

1. **Always continue**

```text
After [Investigate] completes, run [Implement].
```

2. **Ask a condition**

```text
After [Investigate] completes, ask:
"Did it find a concrete root cause?"

YES    → Implement fix
NO     → Investigate deeper
UNSURE → Ask me
```

3. **Ask me**

```text
After [Implement] completes, wait for my approval before running [Review].
```

### 7.6 Workflow Run view

The run view shows real execution state.

```text
Fix failing tests — Running

✓ Step 1 Investigate failing test
  Session: Open
  Output: Root cause appears to be stale fixture setup...

✓ Condition: concrete safe fix?
  Judge result: YES
  Rationale: The upstream agent identified one localized fixture bug.

● Step 2A Implement fix
  Running · Open session

○ Step 3 Review final changes
  Waiting for Step 2A
```

Each step row/card includes:

- status: waiting, queued, starting, running, completed, failed, skipped, blocked, needs approval;
- session link when a Pi session exists;
- prompt preview;
- output summary;
- branch decision details;
- actions: open session, approve, edit prompt before start, skip, retry, stop downstream.

### 7.7 Relationship with Work inbox

Workflow runs should appear in the Work inbox as orchestration items while keeping individual sessions visible.

Recommended model:

- Work inbox row for the workflow run:
  - `Workflow · Fix failing tests · Running`;
  - badge if any step needs attention or failed.
- Existing session rows continue to show each Pi session.
- Session rows spawned by a workflow include a small workflow label, e.g. `Fix failing tests / Step 2A`.

### 7.8 Running without waiting

A key feature is defining downstream steps before upstream results exist.

UX requirements:

- Users can create all branch steps with unresolved placeholders.
- Pi Deck validates structure, not future content.
- Ready steps run immediately when dependencies resolve.
- Downstream prompts are rendered only at execution time after parent outputs are available.
- Condition transitions default to automatic selected-branch execution. A `Preview selected branch before starting` control can turn the selected step into a manual approval gate.
- An `UNSURE` route should target a dedicated approval-configured step, or stop when no approval step is defined.

### 7.9 Parameterized workflow templates

Reusable workflows should be parameterized through **workflow inputs**, not a DSL.

Template authors define inputs such as:

- issue or task description;
- relevant files/folders;
- desired outcome;
- constraints or non-goals;
- optional review checklist.

When a user runs the template, Pi Deck shows a **Run workflow** form. Agent prompts reference inputs through insertable chips/placeholders in the prompt editor.

Example UX:

```text
Run workflow: Investigate and fix issue

Required inputs
Issue / task description: [ ... ]
Relevant paths:          [ + Add paths ]
Desired outcome:         [ ... ]
Constraints:             [ ... ]

[ Start workflow ]
```

Prompt editor behavior:

```text
Investigate this issue:
[Issue / task description]

Focus on:
[Relevant paths]

Constraints:
[Constraints]
```

The UI should show chips, not raw variable syntax. Internally, these chips can be stored as structured prompt parts.

Template actions should include:

- duplicate;
- edit inputs;
- save as new template;
- run with current workspace;
- create workflow from an existing completed session.

### 7.10 Card status model

Cards are the primary status surface. The same card layout should work in two modes.

**Template mode** shows configuration state:

- complete;
- incomplete;
- missing prompt;
- missing input mapping;
- missing branch target;
- references workflow inputs;
- uses model/thinking override.

**Run mode** shows execution state:

- idle/not started;
- waiting;
- queued;
- starting;
- in progress;
- paused / needs approval;
- failed;
- completed;
- skipped;
- blocked.

Collapsed run card example:

```text
● Step 2 · Implement fix
In progress · 3m 12s · Open session
```

Expanded run card shows prompt, model, thinking level, resolved inputs, upstream output used, runtime/session link, latest status, and actions.

### 7.11 Subagent display in card view

Any Pi Deck-orchestrated agent session should be visible in the workflow UI.

MVP rule:

> One Agent Step card maps to one visible Pi session when it runs.

Later, a group/fan-out card can contain child agent cards:

```text
Step 2 · Parallel follow-up work
  ├─ Agent: Backend implementation     Running
  ├─ Agent: Test update                Queued
  └─ Agent: Docs update                Waiting
```

Condition judge steps are different: they may be hidden by default because they are orchestration internals. However, users should be able to expand the condition card to inspect judge input, decision, and rationale.

### 7.12 Card interaction model

Do not start with drag-and-connect as the primary interaction. MVP should use a structured builder that is easier to learn and harder to break.

Primary interactions:

- `+ Add agent step`;
- `+ Add condition`;
- `+ Add manual approval`;
- `After this step...` dropdown;
- branch target dropdowns;
- expand/collapse cards;
- inline validation and quick fixes.

Cards are arranged as a guided vertical flow with indentation for branches:

```text
Step 1 · Investigate
└─ Condition: concrete fix?
   ├─ YES → Step 2A · Implement
   ├─ NO → Step 2B · Investigate deeper
   └─ UNSURE → Ask me
```

Expanded Agent Step cards contain:

- prompt editor;
- model picker;
- thinking picker;
- workflow input chips;
- upstream output chips;
- attachment/path reference picker;
- run policy controls.

A freeform graph canvas can be considered later after the core orchestration model is proven.

### 7.13 Shared workflow context

Agent Workflows should support explicit shared context without silently stuffing everything into every prompt.

Add a **Workflow Context** card near the top of the builder:

- objective;
- constraints;
- relevant files/folders;
- coding standards;
- do-not-do instructions;
- run inputs.

Each Agent Step chooses what shared context it includes:

```text
Context for this step
[x] Workflow objective
[x] Run inputs
[x] Relevant paths
[ ] Full previous transcript
[x] Previous step final answer
```

Recommended context layers:

1. **Workflow inputs**: reusable parameters filled at run time.
2. **Shared workflow context**: common instructions available to steps.
3. **Step-local prompt**: what this specific agent should do.
4. **Upstream outputs**: selected parent result, summary, or transcript.
5. **Pi-native resources**: skills, prompt templates, project markdown, memories, and extensions loaded by Pi itself.

This keeps context composition visible and reinforces the distinction between workflows and skills.

## 8. Execution semantics

### 8.1 Step lifecycle

```text
waiting → ready → queued → starting → running → completed
                         ↘ failed
                         ↘ skipped
                         ↘ blocked
                         ↘ needs_approval
```

Definitions:

- **waiting**: dependencies not resolved.
- **ready**: dependencies resolved, but not yet admitted to worker capacity.
- **queued**: accepted by workflow scheduler but waiting for session capacity.
- **starting**: Pi Deck is creating/resuming a Pi runtime.
- **running**: Pi agent is active.
- **completed**: terminal success state.
- **failed**: worker or prompt failed.
- **skipped**: branch not selected or user skipped.
- **blocked**: missing input, invalid template, unavailable model, missing attachment path, or capacity disabled.
- **needs_approval**: waiting for user decision.

### 8.2 Completion detection

An Agent Step is complete when the associated Pi runtime reaches a terminal idle state after an accepted prompt and Pi Deck has reconciled current messages/status.

Use existing runtime events and reconciliation:

- `agent_start`
- `message_update`
- `agent_end`
- `worker_exit`
- runtime status snapshots for missed terminal events

### 8.3 Judge conditions

For MVP, conditions are evaluated by a generated judge prompt in a separate Pi session or a lightweight hidden worker.

Input to judge:

- condition question;
- upstream final answer;
- optional upstream transcript summary;
- strict instruction to return structured JSON with one of `yes`, `no`, `unsure`.

Example internal judge prompt:

```text
You are evaluating a Pi Deck workflow condition.
Question: Did the investigation identify a concrete and safe code fix?

Upstream final answer:
...

Return only JSON:
{"decision":"yes"|"no"|"unsure","rationale":"short reason"}
```

Design notes:

- The UI should not expose this as a DSL.
- Judge output must be parsed defensively.
- Invalid judge output never selects a branch automatically. The run enters `needs attention` with retry and explicit YES/NO override actions.
- Users can inspect the judge rationale.
- Users can review or override a branch decision before downstream starts when the template enables branch preview.

### 8.4 Prompt rendering

Prompts are stored as structured parts, not raw string interpolation where possible.

Conceptual shape:

```ts
type WorkflowPromptPart =
  | { type: "text"; text: string }
  | { type: "stepFinalAnswer"; stepId: string }
  | { type: "stepSummary"; stepId: string }
  | { type: "stepTranscript"; stepId: string };
```

At execution time, Pi Deck resolves parts to a final prompt string and image inputs/path references.

If an upstream output is missing, the step becomes `blocked` with an actionable message.

### 8.5 Failure behavior

Default MVP failure policy:

- If an Agent Step fails, dependent steps do not start.
- The run enters `needs_attention`.
- User can retry failed step, edit and retry, skip, or stop downstream.
- If a Judge Step fails or returns malformed output, pause the run in `needs attention`; the user can retry the judge or explicitly override YES/NO. This avoids silently taking a code-changing branch.

Later policies may add `continue on failure`, but avoid it initially.

## 9. Engineering design

### 9.1 New modules

Recommended main-process modules:

```text
src/main/workflows/workflowStore.ts
src/main/workflows/workflowEngine.ts
src/main/workflows/workflowScheduler.ts
src/main/workflows/workflowPromptRenderer.ts
src/main/workflows/workflowJudge.ts
```

Recommended renderer modules:

```text
src/renderer/workflows/workflowDomain.ts
src/renderer/components/WorkflowList.tsx
src/renderer/components/WorkflowBuilder.tsx
src/renderer/components/WorkflowRunView.tsx
src/renderer/components/WorkflowStepCard.tsx
src/renderer/components/WorkflowTransitionCard.tsx
```

Shared contracts:

```text
src/shared/workflowSchemas.ts
```

or fold into `src/shared/ipcSchemas.ts` initially if the repo prefers one schema file. If adding many workflow schemas, a dedicated shared schema file may keep `ipcSchemas.ts` manageable.

### 9.2 Persistence

Store workflow metadata under `PI_DECK_HOME` next to workspace metadata.

Suggested file:

```text
~/.pideck/workflows.json
```

Template and run metadata are app-owned. Pi sessions remain Pi-owned JSONL files and are referenced by path/session id once created.

#### Template schema v1

```ts
interface WorkflowTemplateRecordV1 {
  id: string; // uuid
  name: string;
  description?: string;
  workspaceId?: string; // optional default target
  defaultModel?: { provider?: string; modelId?: string };
  defaultThinkingLevel?: string;
  steps: WorkflowStepTemplate[];
  transitions: WorkflowTransitionTemplate[];
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs?: number;
}

interface WorkflowStepTemplate {
  id: string; // stable within template
  name: string;
  kind: "agent";
  promptParts: WorkflowPromptPart[];
  modelOverride?: { provider?: string; modelId?: string };
  thinkingOverride?: string;
  inputPolicy: {
    includeParentFinalAnswer?: boolean;
    includeParentSummary?: boolean;
    includeParentTranscript?: boolean;
  };
  startPolicy: "auto" | "manualApproval";
  referencedPaths?: Array<{
    path: string;
    label?: string;
  }>;
}

type WorkflowTransitionTemplate =
  | {
      id: string;
      fromStepId: string;
      kind: "always";
      toStepId: string;
    }
  | {
      id: string;
      fromStepId: string;
      kind: "condition";
      question: string;
      routes: {
        yes?: WorkflowRouteTarget;
        no?: WorkflowRouteTarget;
        unsure?: WorkflowRouteTarget;
      };
      previewBeforeStart?: boolean;
    }
  | {
      id: string;
      fromStepId: string;
      kind: "manualGate";
      toStepId: string;
      prompt?: string;
    };

type WorkflowRouteTarget =
  | { kind: "step"; stepId: string }
  | { kind: "manualGate" }
  | { kind: "stop" };
```

#### Run schema v1

```ts
interface WorkflowRunRecordV1 {
  id: string; // uuid
  templateId?: string;
  name: string;
  workspaceId: string;
  status:
    | "waiting"
    | "running"
    | "needs_attention"
    | "completed"
    | "failed"
    | "stopped";
  templateSnapshot: WorkflowTemplateRecordV1;
  stepRuns: WorkflowStepRunRecord[];
  transitionRuns: WorkflowTransitionRunRecord[];
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
}

interface WorkflowStepRunRecord {
  id: string; // uuid or template step run key
  templateStepId: string;
  name: string;
  status:
    | "waiting"
    | "ready"
    | "queued"
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "blocked"
    | "needs_approval";
  runtimeId?: string;
  sessionFile?: string;
  sessionId?: string;
  renderedPrompt?: string;
  finalAnswer?: string;
  summary?: string;
  error?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
}

interface WorkflowTransitionRunRecord {
  id: string;
  templateTransitionId: string;
  status: "waiting" | "evaluating" | "resolved" | "failed" | "skipped";
  decision?: "yes" | "no" | "unsure";
  rationale?: string;
  selectedTarget?: WorkflowRouteTarget;
  judgeRuntimeId?: string;
  error?: string;
  updatedAtMs: number;
}
```

Implementation notes:

- Persist the full template snapshot on run start so edits to templates do not mutate existing runs.
- Use serialized atomic writes like `WorkspaceStore`.
- Validate with Zod and back up corrupt files.
- Store only paths and metadata plus bounded step outputs needed for workflow continuity. A bounded transcript projection may be persisted on the step run; the Pi session JSONL remains the authoritative full transcript.

### 9.3 IPC API

Add workflow channels with strict schemas.

Suggested API surface:

```ts
workflows.listTemplates(): Promise<WorkflowTemplateListResult>
workflows.getTemplate({ templateId }): Promise<WorkflowTemplateResult>
workflows.createTemplate(input): Promise<WorkflowTemplateResult>
workflows.updateTemplate(input): Promise<WorkflowTemplateResult>
workflows.archiveTemplate({ templateId }): Promise<WorkflowTemplateListResult>
workflows.duplicateTemplate({ templateId }): Promise<WorkflowTemplateResult>

workflows.listRuns({ workspaceId? }): Promise<WorkflowRunListResult>
workflows.getRun({ runId }): Promise<WorkflowRunResult>
workflows.startRun({ templateId, workspaceId?, initialInputs? }): Promise<WorkflowRunResult>
workflows.stopRun({ runId }): Promise<WorkflowRunResult>
workflows.retryStep({ runId, stepRunId }): Promise<WorkflowRunResult>
workflows.approveGate({ runId, gateId, target }): Promise<WorkflowRunResult>
workflows.skipStep({ runId, stepRunId }): Promise<WorkflowRunResult>
workflows.onEvent(listener): Unsubscribe
```

Renderer never supplies filesystem authority directly for dangerous operations. It supplies workflow/template IDs; main resolves stored records and validates workspace/session/path access.

### 9.4 Workflow engine responsibilities

`workflowEngine` owns deterministic orchestration state transitions:

- instantiate run from template;
- compute ready steps;
- route transitions;
- mark unselected branches skipped;
- handle manual approvals;
- handle retries;
- compute aggregate run status;
- emit workflow events for renderer and Work inbox refresh.

Keep this domain logic pure where possible and unit-testable without Electron or Pi.

### 9.5 Workflow scheduler responsibilities

`workflowScheduler` bridges ready workflow steps to existing chat/session runtime operations.

Responsibilities:

- respect `settings.maxRunningSessions` and existing worker capacity;
- enqueue ready steps when capacity is full;
- create a Pi session through the same pathway as `chat.createSession`;
- prompt the session with rendered prompt and resolved attachments/images;
- attach runtime/session IDs back to the step run;
- monitor runtime events and reconcile completion;
- release capacity and advance engine on terminal states.

This should share or sit above existing worker capacity logic (`workerCapacity.ts`) instead of duplicating hard-cap enforcement.

### 9.6 Session creation strategy

For each Agent Step, create a normal Pi Deck session in the run workspace.

Minimum viable strategy:

1. Resolve workspace.
2. Call internal equivalent of `chat.createSession({ workspaceId })`.
3. Apply model/thinking overrides if configured.
4. Render prompt.
5. Send prompt through existing `prompt` path.
6. Persist returned `runtimeId`, eventual `sessionFile`, and `sessionId` on the step run.

Do not create Pi sessions for branch steps until their branch is selected. This avoids hidden empty persisted sessions and matches the current lazy session design.

### 9.7 Event model

Add workflow events separate from chat runtime events.

```ts
type WorkflowRuntimeEvent =
  | { type: "workflow_run_updated"; runId: string; status: string }
  | { type: "workflow_step_updated"; runId: string; stepRunId: string; status: string }
  | { type: "workflow_transition_updated"; runId: string; transitionRunId: string; status: string }
  | { type: "workflow_attention_required"; runId: string; reason: string };
```

The renderer can merge these into the Work inbox using the same general pattern as runtime event overlays.

### 9.8 Work inbox integration

Extend activity source models to optionally include workflow runs.

Potential new activity kind tags:

```ts
type ActivityTag =
  | `workspace:${string}`
  | `status:${ActivityStatus}`
  | "kind:session"
  | "kind:workflow"
  | "visibility:archived";
```

Workflow status classification:

- `needsAttention`: approval needed, failed step, blocked step.
- `pending`: ready/queued steps exist but not running.
- `inProgress`: any step running/evaluating.
- `completed`: run completed.
- `idle`: saved template only should not appear in Work inbox; templates live in Agent Workflows screen.

### 9.9 Security and authority boundaries

- Renderer may create/edit workflow metadata but cannot directly open arbitrary session files.
- Main validates workspace IDs, template IDs, run IDs, and stored referenced paths before use.
- Persisted referenced paths should be labeled as references, not uploaded content.
- Attachment tokens are runtime-scoped and should not be persisted in templates. Template attachments should be path references or user re-selected file tokens at run start.
- Judge prompts are normal Pi prompts and may contact configured providers like any other Pi run.
- Existing sandboxed renderer and validated IPC requirements remain unchanged.

## 10. Validation and testing plan

### 10.1 Unit tests

- Workflow store validation, corrupt-file recovery, atomic writes.
- Template validation:
  - missing start step;
  - dangling transition targets;
  - duplicate step IDs;
  - unreachable step warnings;
  - invalid branch routes.
- Engine transitions:
  - always-after;
  - condition yes/no/unsure;
  - manual gate approval;
  - failed step blocks dependents;
  - branch-not-selected steps become skipped.
- Prompt renderer:
  - final-answer placeholder;
  - transcript placeholder;
  - missing output blocks step;
  - path references render clearly.
- Judge parser:
  - valid JSON yes/no/unsure;
  - malformed output maps to unsure;
  - rationale truncation.

### 10.2 Integration tests with fake RPC

- Start workflow with Step A then Step B always-after.
- Conditional workflow routes to YES branch.
- Conditional malformed judge output routes to manual approval.
- Capacity full puts ready steps in queued state.
- Failed worker marks run needs attention and does not start downstream.
- Retry failed step continues downstream after success.

### 10.3 Renderer tests

- Builder creates valid template without DSL syntax.
- Inline validation for dangling or empty cards.
- Run view updates step states from workflow events.
- Manual gate approval starts selected next step.
- Session link opens existing chat session.
- Work inbox shows workflow run attention state.

### 10.4 E2E tests

- Create template → run → two fake Pi sessions execute in sequence.
- Create conditional template → fake judge YES → selected branch session starts, other branch skipped.
- Approval gate pauses run and resumes after approval.
- Relaunch app while run is waiting/queued; state persists and can continue.

## 11. Phased implementation plan

### Phase 1: Design skeleton and storage

- Add shared workflow schemas and types.
- Implement `WorkflowStore` with templates and runs.
- Add template CRUD IPC.
- Add simple Agent Workflows list screen.

### Phase 2: Linear workflows

- Implement Agent Step and always-after transitions.
- Add workflow run instantiation and scheduler bridge to chat session creation/prompt.
- Add run view with step state.
- Fake RPC E2E for Step A → Step B.

### Phase 3: Conditions and manual gates

- Add condition transition card.
- Add judge prompt execution and parser.
- Add yes/no/unsure route handling.
- Add manual approval gate UI.
- Add branch decision override before downstream start.

### Phase 4: Work inbox and polish

- Add workflow run rows to Work inbox.
- Add session workflow labels.
- Add retry/skip/stop downstream actions.
- Add template duplicate/archive.

## 12. Open decisions

1. Should judge steps use the same model/thinking as the parent step, workflow defaults, or a dedicated configurable lightweight model?
2. Should judge steps create visible Pi sessions, hidden workflow-internal sessions, or collapsible sessions visible only in run details?
3. How much upstream transcript should be available by default before warning about context size?
4. Should branch preview be default-on for early safety, or default-off for faster automation?
5. How should workflow templates reference files that may move or become unreadable between runs?
6. Should templates be workspace-scoped by default or global with optional workspace default?

## 13. Recommended first user-facing slice

Build the smallest valuable slice as:

> A user can create an Agent Workflow with two visible agent steps connected by "always after", run it in the current workspace, and watch Pi Deck start the second Pi session automatically when the first completes.

Then add:

> A user can replace the always-after rule with a yes/no/unsure natural-language condition and define separate YES and NO branch agent steps.

This proves the product direction without introducing a DSL, graph editor, joins, loops, or complex boolean logic.
