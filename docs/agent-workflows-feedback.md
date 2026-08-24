# Agent Workflows — Product Feedback and Continuation Notes

**Status:** Historical Agent Workflows UX feedback and continuation record. For current behavior, see the [canonical product design](agent-workflows-role-based-design.md) and [README](../README.md).<br>
**Feedback captured:** 2026-08-07<br>
**Historical continuation branch:** `dev/agent-workflows-prompt-first`

This is a historical product-feedback log retained for implementation context.
Current users should use the canonical design and README rather than its
continuation or branch instructions.

## Historical numbered feedback and bugs

### 1. Empty workflow screen has two creation actions

- **Status:** Resolved — the page-header action is now the sole creation CTA.
- **Reported:** 2026-08-07.
- **Area:** Agent Workflows home, empty-template state.
- **Screenshot:** [Duplicate create-workflow actions](assets/agent-workflows-feedback/workflow-home-duplicate-create-actions.png).
- **Observed behavior:** The page simultaneously shows a primary **New workflow**
  button in the page header and a **Create your first workflow** button inside the
  empty state. Both invoke the same `onCreate` callback, so they are not distinct
  workflow-creation paths.
- **Why this needs follow-up:** Two controls for the same action compete for
  attention, weaken the primary-action hierarchy, and add redundant keyboard and
  screen-reader stops. A follow-up session should decide which single creation
  action is appropriate in the empty state while preserving an obvious way to
  create another workflow when workflows exist.
- **Implementation context:** Both controls are in
  `src/renderer/components/workflows/WorkflowHome.tsx` (the header action near
  lines 245–251 and empty-state action near lines 282–289). Focused coverage
  belongs in `src/renderer/components/workflows/WorkflowHome.test.ts`.
- **Completion signal:** The empty state exposes exactly one clear creation CTA;
  the populated state still exposes a clear way to create another workflow; and
  tests cover both states and the `onCreate` callback.

### 2. Replace the field-heavy step model with four execution roles

- **Status:** Canonical Agent Workflows authoring, graph, persistence, and core runtime
  implemented; end-to-end occurrence-run UI wiring remains tracked.
- **Reported:** 2026-08-07.
- **Area:** Workflow concepts, authoring model, and agent-step configuration UX.
- **Canonical product design:** [Agent Workflows](agent-workflows-role-based-design.md).
- **Screenshot:** [Current field-heavy agent-step editor](assets/agent-workflows-feedback/agent-step-editor-role-model.png).
- **Problem:** The current editor mixes an agent's instructions with graph wiring,
  start behavior, model overrides, thinking settings, and transition controls in
  one large form. Users must understand low-level workflow mechanics before they
  can describe what an agent should do.
- **Agreed core roles:**
  1. **Worker** — performs concrete work with optional input and output.
  2. **Decider** — evaluates input and emits a structured true/false decision;
     it may use worker machinery internally, but remains a separate UX concept.
  3. **Orchestrator** — manages and monitors other agents without performing the
     domain work itself; its initial coordination modes are loop and fan-out.
  4. **Human checkpoint** — collects input, approval, or a choice without being
     represented as a model-backed agent.
- **Abstraction boundary:** Planner, researcher, implementer, reviewer, tester,
  writer, and similar application concepts are configured uses of these roles,
  not additional role types or additional role templates. For example, a
  reviewer that writes findings configures a Worker, while a reviewer that only
  approves or rejects configures a Decider.
- **Agreed design summary:** Expose exactly four generic role templates. A
  workflow fills their configuration inputs and relates the configured role
  instances. Use canonical versioned JSON with no first-version YAML or custom
  DSL. Author with compact cards and a focused inspector; visualize through a
  separate auto-laid-out, read-only graph; and provide synchronized Build, Graph,
  and JSON views over one document. See the detailed design linked above for the
  exact role contracts, JSON shape, runtime semantics, migration requirements,
  implementation phases, and test plan.
- **Completion signal:** The implementation delivers a versioned JSON schema,
  compact role-configuration cards with a focused inspector, and an auto-laid-out
  read-only graph without adding planner/reviewer/etc. as core concepts.

### 3. Workflow scope selector omits existing workspaces

- **Status:** Complete (implemented and tested).
- **Reported:** 2026-08-07.
- **Area:** New/edit Agent Workflow, workflow scope selector.
- **Observed behavior:** The sidebar shows an existing `liusu_pi_gui` workspace
  with 13 saved sessions, but the workflow scope selector offers only **All
  workspaces (global)** and **Default workspace**. The existing workspace cannot
  be selected as the workflow's scope.
- **Expected behavior:** The selector should list every active workspace that can
  own a workflow, including `liusu_pi_gui`, rather than only the current/default
  workspace.
- **Implementation context:** `WorkflowBuilder.tsx` renders only the single
  `workspaceId`/`workspaceName` pair supplied by `App.tsx`. `App.tsx` currently
  passes `currentWorkspace`, so the builder has no collection from which to
  render the other active workspaces. The fix should pass validated workspace
  choices into the builder while preserving global scope and any saved scope.
- **Completion signal:** All active workspaces appear by name in the workflow
  scope selector; selecting one persists its ID; archived workspaces are not
  offered for new selections; and focused renderer tests cover multiple
  workspaces, global scope, and editing a previously scoped workflow.

## Latest product direction

The first version should feel like a prompt editor, not a workflow programming
language.

- A workflow step is primarily **one prompt/instructions field**.
- Shared context is **one shared prompt plus “Don’t do”**.
- Do not expose separate Objective, Constraints, Relevant paths, Standards, or
  explicit file/link/path inputs in the first version.
- In Build UX, handoffs should be implicit. Agents work in the same local
  workspace and should discover/read local files as needed; do not make users
  compose structured previous-result handoff chips.
- Keep the workflow/skills distinction: workflows coordinate; skills remain
  Pi-native agent capabilities.
- Model override and thinking level should use dropdown choices matching the
  normal Pi Deck session prompt controls, not free-form text fields.
- Keep first-version run inputs prompt/text-only. Defer file, URL, and link input
  types.
- Clicking **Start run** on a workflow with no inputs should launch immediately.
  Only workflows with actual inputs need a setup form before launch.

## Feedback tracker

- [x] Simplify the shared-context editor to Prompt + Don’t do.
- [x] Simplify each agent step to Instructions; remove structured handoff UI.
- [x] Make model and thinking overrides dropdowns using session-style choices.
- [x] Limit new run inputs to text/prompt values; defer path/file/link UX.
- [x] Avoid the empty second “Start workflow” screen for no-input workflows.
- [x] Recheck copy, spacing, and mobile layout after the simplification.
- [x] Add/update renderer and backend compatibility tests.
- [x] Push the continuation branch and isolated implementation branches; run final validation.
- [x] Populate the workflow scope selector with all active workspaces.

## Captured screenshots

These are copies of the screenshots supplied during feedback, stored in Git so
future workstations can inspect the original UI context:

1. [Shared context](assets/agent-workflows-feedback/shared-context.png)
2. [Empty reusable inputs](assets/agent-workflows-feedback/run-inputs-empty.png)
3. [Agent step editor](assets/agent-workflows-feedback/agent-step-editor.png)
4. [Workflow home](assets/agent-workflows-feedback/workflow-home.png)
5. [Run start form](assets/agent-workflows-feedback/run-start-form.png)

## Compatibility policy

Existing workflow JSON may contain the richer pre-feedback fields and handoff
parts. The first-version editor should stop creating new instances of those
concepts without making old saved templates unreadable. Backend parsing/rendering
should keep a safe compatibility fallback while the new UI writes the simpler
shape.

## Current implementation context

The feature is centered in:

- `src/shared/workflowSchemas.ts` — template/run contracts and validation.
- `src/main/workflows/workflowStore.ts` — persisted templates and runs.
- `src/main/workflows/workflowEngine.ts` — graph execution and state changes.
- `src/main/workflows/workflowScheduler.ts` — Pi worker scheduling/capacity.
- `src/main/workflows/workflowPromptRenderer.ts` — prompt/context rendering.
- `src/main/workflows/workflowRehydration.ts` — startup/workspace recovery.
- `src/main/main.ts` — workflow IPC/runtime integration and path authorization.
- `src/preload/index.ts` — validated renderer bridge.
- `src/renderer/App.tsx` — workflow view state and session integration.
- `src/renderer/components/workflows/` — home, builder, step, transition, and run UI.

Related design/implementation documents:

- `docs/agent-workflows-design.md`
- `docs/agent-workflows-design.html`
- `docs/agent-workflows-parallel-implementation-plan.md`

The underlying orchestration implementation already includes persistent global or
workspace-scoped templates, normal Pi sessions per step, transitions/conditions,
manual gates, retries/overrides, capacity handling, transcript/runtime recovery,
workspace/path guards, and stop-race protection. This feedback pass is a UX
simplification, not a request to remove those runtime safety guarantees.

## Historical continuation instructions (another laptop)

These instructions are retained for historical context. For current setup and
usage, follow the [README](../README.md).

```bash
git clone https://github.com/LiusuZeng/pi-deck.git
cd pi-deck
git fetch origin
git switch --track origin/dev/agent-workflows-prompt-first
npm ci
npm run typecheck
npm test
npm run deck:fake:build
```

The fake launch is the safest first demo and does not require Pi provider
credentials. For real local Pi:

```bash
npm run deck:real:build -- /absolute/path/to/project
```

Requirements are macOS, Node.js 22.12+, npm, and a working authenticated `pi`
installation for real mode.

## Validation record

Before this feedback pass, the integrated workflow feature had passed:

- 363 unit/renderer tests, with 2 intentional TODOs.
- Main and renderer TypeScript checks.
- Production main/preload/renderer build.
- Prettier format check.
- Full Playwright E2E: 35 passed, 3 environment-skipped.
- Independent backend and UI blocker-only reviews.

Prompt-first implementation commits currently include:

- `674e289` — App model/thinking choice derivation and workflow-editor props.
- `011a8cf` — Prompt-first context schema/rendering compatibility.
- `19299a8` — Prompt-first renderer editor and run-flow UX.
- `ac05e11` — Parent integration fixes for choice types and compatibility fields.

Historical continuation-branch record:
`origin/dev/agent-workflows-prompt-first`

The isolated implementation lanes were consolidated into the continuation
branch and their remote refs were retired after integration:

- `aw/v1-ux`
- `aw/v1-contracts`
- `aw/v1-app`

Release-worktree hardening additionally:

- prevents duplicate no-input and input-form launches while a start is pending;
- reports immediate-launch failures without leaving the workflow home;
- preserves legacy structured prompt references until the user explicitly
  replaces them with prompt-only instructions;
- migrates all legacy shared-context content into the prompt-first shape when it
  is edited; and
- disables unavailable model choices and constrains thinking choices to the
  effective workflow model.

Final validation after consolidation and hardening: 378 tests passed with 2
intentional TODOs; typecheck, production build, format, and diff checks passed.
Full Playwright E2E passed 37 with 1 environment-skipped real-Pi smoke test.
Backend compatibility review approved; the shared prompt label fix from
`3d6e024` is included. Do not push unrelated site/screenshot work; that work
remains isolated in the local `pi-deck-site-capture` worktree.
