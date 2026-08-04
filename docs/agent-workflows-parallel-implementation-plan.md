# Agent Workflows Parallel Implementation Plan

Status: proposed fanout plan  
Date: 2026-08-04  
Design source: `docs/agent-workflows-design.md`  
Purpose: prepare Agent Workflows work for parallel subagent implementation using isolated git worktrees.

## 1. Goal

Implement the first useful slice of **Agent Workflows** while preserving Pi Deck's product boundary:

> **Skills are reusable agent abilities. Agent Workflows are reusable agent orchestration plans.**

The first implementation should prove that Pi Deck can define, persist, run, and observe a workflow where one Pi session starts after another completes. The next slice adds natural-language conditional branching and manual gates.

## 2. Fanout principles

1. **Contract-first, then parallelize.** Freeze shared workflow schemas and IPC names before UI/backend lanes edit against them.
2. **One worktree per subagent.** Any subagent that edits code works only in its assigned branch/worktree.
3. **Primary agent owns integration.** Subagents deliver bounded diffs and handoff summaries; the primary agent reviews, merges, resolves shared contracts, and runs combined validation.
4. **Prefer additive files.** New workflow modules should be added under `src/main/workflows/`, `src/renderer/workflows/`, and `src/renderer/components/workflows/` to reduce conflicts with current monolithic files.
5. **Avoid DSL creep.** User-facing workflow configuration remains cards, forms, chips, and dropdowns.
6. **Keep Pi-native behavior.** Workflow steps create normal Pi Deck sessions and can invoke Pi skills/slash commands, but workflows do not replace skills.

## 3. Target first slice

### Slice AW-1: Linear Agent Workflow

A user can:

1. Open **Agent Workflows** from the sidebar.
2. Create a workflow template with:
   - workflow name;
   - optional workflow inputs;
   - Step A agent prompt;
   - Step B agent prompt;
   - `Always after Step A, run Step B` transition.
3. Run the workflow in the active workspace.
4. See a Workflow Run view with card statuses.
5. Open each spawned Pi session from its card.
6. See Step B start automatically after Step A completes.
7. Relaunch and still see the saved template/run state.

### Slice AW-2: Conditional Branch MVP

A user can replace the always-after transition with:

```text
After Step A completes, ask condition Q.
YES    → Step B
NO     → Step C
UNSURE → Manual approval
```

Pi Deck evaluates Q using a judge step, records the decision/rationale, and starts only the selected downstream step.

## 4. Worktree setup

Recommended sibling directory:

```bash
mkdir -p /Users/liusuzeng/Workspace/pi-deck-worktrees
```

Create worktrees from the primary checkout:

```bash
git worktree add -b aw/contracts \
  /Users/liusuzeng/Workspace/pi-deck-worktrees/aw-contracts

git worktree add -b aw/main-engine \
  /Users/liusuzeng/Workspace/pi-deck-worktrees/aw-main-engine

git worktree add -b aw/renderer-ux \
  /Users/liusuzeng/Workspace/pi-deck-worktrees/aw-renderer-ux

git worktree add -b aw/qa-e2e \
  /Users/liusuzeng/Workspace/pi-deck-worktrees/aw-qa-e2e
```

Every subagent prompt should include:

```text
Work only inside your assigned git worktree. Before editing, run `pwd`,
`git branch --show-current`, and `git status --short`. Do not modify the main
checkout or another subagent's worktree. Provide a handoff summary listing files
changed, tests run, and any contracts you need integrated centrally.
```

If a requested subagent model is unavailable, use the closest available version 5.5+ model capable of the task and note the substitution in the handoff.

## 5. Parallel lanes

| Lane | Branch / worktree | Ownership | Can start | Must not edit |
| --- | --- | --- | --- | --- |
| A. Contracts + pure domain | `aw/contracts` / `aw-contracts` | Shared schemas, type exports, pure validation helpers | Immediately | Renderer layout, `src/main/main.ts` integration |
| B. Main workflow engine + store | `aw/main-engine` / `aw-main-engine` | Durable workflow store, engine, scheduler stubs, IPC handlers | After Lane A schema draft | Renderer components except generated type imports |
| C. Renderer workflow UX | `aw/renderer-ux` / `aw-renderer-ux` | Agent Workflows screen, builder cards, run cards, CSS/tests | After Lane A schema draft | Main workflow store/engine internals |
| D. QA + fake workflow coverage | `aw/qa-e2e` / `aw-qa-e2e` | Fake RPC scenarios, unit fixtures, E2E specs, acceptance checklist | After Lane A schema draft and minimal IPC stubs | Product implementation outside test fixtures |

The primary agent should keep `docs/agent-workflows-design.md`, this plan doc, final `src/main/main.ts` route wiring, and final `src/renderer/App.tsx` integration centralized unless a lane explicitly receives those files.

## 6. Shared contract freeze checklist

Lane A proposes the contract; primary agent approves before broad implementation.

Required artifacts:

- Workflow template schemas.
- Workflow run schemas.
- Workflow prompt-part schemas.
- Workflow event schemas.
- Workflow IPC request/response schemas.
- Validation rules for:
  - duplicate step IDs;
  - dangling transition targets;
  - missing branch routes;
  - empty prompts;
  - missing required workflow inputs.

Recommended files:

```text
src/shared/workflowSchemas.ts
src/shared/workflowTypes.ts     # optional; may use z.infer in shared/types.ts instead
src/shared/workflowSchemas.test.ts
```

If the repo convention prefers one shared schema file, Lane A may add these to `src/shared/ipcSchemas.ts`, but a separate workflow schema file is preferred to reduce file size and merge conflicts.

## 7. Lane A: Contracts + pure domain

### Scope

- Define workflow DTO schemas/types.
- Define prompt parts and workflow input references.
- Define pure template validation helpers.
- Define activity classification shape for workflow runs, but do not integrate Work inbox yet.

### Suggested files

```text
src/shared/workflowSchemas.ts
src/shared/workflowSchemas.test.ts
src/renderer/workflows/workflowDomain.ts
src/renderer/workflows/workflowDomain.test.ts
```

### Acceptance

- `npm test -- workflowSchemas workflowDomain` passes.
- Schemas reject invalid templates and accept the AW-1/AW-2 examples.
- Handoff includes final schema names and any IPC channel names expected by other lanes.

### Subagent starter prompt

```text
You are Lane A for Pi Deck Agent Workflows. Work only in
/Users/liusuzeng/Workspace/pi-deck-worktrees/aw-contracts on branch aw/contracts.

Task: add shared Agent Workflow schemas/types and pure template validation helpers.
Do not wire Electron IPC or renderer screens. Prefer additive files. Preserve the
product boundary: skills are reusable agent abilities; workflows are orchestration
plans.

Validation: run focused Vitest tests for new schema/domain files, then run
`npm run typecheck` if feasible. Handoff with changed files, schema summary,
validation run, and integration notes for Lanes B/C/D.
```

## 8. Lane B: Main workflow engine + store

### Scope

- Implement durable `WorkflowStore` under `PI_DECK_HOME/workflows.json`.
- Implement pure/non-Electron `WorkflowEngine` for run state transitions.
- Implement scheduler boundary that can enqueue ready steps and call existing chat/session internals after integration.
- Add IPC handlers behind workflow channels once contracts are accepted.

### Suggested files

```text
src/main/workflows/workflowStore.ts
src/main/workflows/workflowStore.test.ts
src/main/workflows/workflowEngine.ts
src/main/workflows/workflowEngine.test.ts
src/main/workflows/workflowPromptRenderer.ts
src/main/workflows/workflowPromptRenderer.test.ts
src/main/workflows/workflowScheduler.ts
src/main/workflows/workflowScheduler.test.ts
src/main/workflows/workflowService.ts
```

### Integration notes

- Do not create hidden warm Pi sessions for future branch steps.
- A workflow step should create a normal Pi Deck session only when the step becomes selected and ready.
- Reuse existing worker capacity settings and hard cap.
- Main should resolve workspace/template/run IDs; renderer-supplied IDs are not filesystem authority.

### Acceptance

- Store persists templates/runs atomically and recovers from corrupt files like `WorkspaceStore`.
- Engine can execute AW-1 state transitions without Pi.
- Prompt renderer resolves workflow inputs and upstream final-answer chips.
- Scheduler can be tested with fake chat/session adapter stubs.

### Subagent starter prompt

```text
You are Lane B for Pi Deck Agent Workflows. Work only in
/Users/liusuzeng/Workspace/pi-deck-worktrees/aw-main-engine on branch aw/main-engine.

Task: implement main-process workflow store, pure engine, prompt renderer, and a
scheduler/service boundary using Lane A contracts. Keep changes additive under
src/main/workflows where possible. Do not build the renderer UX.

Validation: run focused workflow tests and `npm run typecheck` if feasible.
Handoff with changed files, store path/format, IPC assumptions, tests run, and
any central integration needed in main.ts.
```

## 9. Lane C: Renderer workflow UX

### Scope

- Add Agent Workflows top-level screen.
- Add Templates/Runs list.
- Add card-based builder for AW-1.
- Add Run view with card statuses.
- Add static/fixture-backed UX for AW-2 condition cards if backend not ready.
- Add workflow input chips and shared context card UI.

### Suggested files

```text
src/renderer/workflows/workflowViewModels.ts
src/renderer/workflows/workflowViewModels.test.ts
src/renderer/components/workflows/WorkflowHome.tsx
src/renderer/components/workflows/WorkflowBuilder.tsx
src/renderer/components/workflows/WorkflowRunView.tsx
src/renderer/components/workflows/WorkflowStepCard.tsx
src/renderer/components/workflows/WorkflowTransitionCard.tsx
src/renderer/components/workflows/WorkflowContextCard.tsx
src/renderer/components/workflows/*.test.tsx
```

### Integration notes

- Avoid editing large sections of `src/renderer/App.tsx` until primary integration. Export standalone components that can be mounted centrally.
- Use accessible form controls and keyboard navigation patterns already present in the app.
- Start with structured vertical cards, not a drag-connect graph canvas.
- In template mode, show config validity. In run mode, show execution status.

### Acceptance

- Builder can create an in-memory AW-1 template shape.
- Run view renders waiting/queued/running/failed/completed/skipped/needs approval states from fixtures.
- Workflow inputs render as chips, not raw variable syntax.
- Tests cover card expansion, branch target selection, and inline validation.

### Subagent starter prompt

```text
You are Lane C for Pi Deck Agent Workflows. Work only in
/Users/liusuzeng/Workspace/pi-deck-worktrees/aw-renderer-ux on branch aw/renderer-ux.

Task: build standalone renderer components for the Agent Workflows UX using Lane A
contracts: home screen, card builder, workflow context/input chips, and run view.
Avoid broad App.tsx route integration unless explicitly requested by the primary
agent. No DSL UI and no drag-connect canvas for MVP.

Validation: run focused renderer/component tests and `npm run typecheck` if
feasible. Handoff with changed files, component entry points, props/contracts,
accessibility notes, and integration needs.
```

## 10. Lane D: QA + fake workflow coverage

### Scope

- Add fake workflow fixtures and deterministic fake RPC scenarios.
- Add E2E tests for AW-1 and AW-2 once IPC/UI stubs exist.
- Add acceptance checklist for manual review.
- Stress worker-capacity queue behavior for workflow steps with fake workers.

### Suggested files

```text
src/test/workflowFixtures.ts
e2e/agent-workflows.e2e.ts
docs/agent-workflows-validation-checklist.md
```

Potential fake scenarios:

- agent A completes with final answer;
- agent A fails;
- judge returns `yes`;
- judge returns `no`;
- judge returns malformed output;
- delayed worker to exercise queued state.

### Acceptance

- Deterministic tests prove AW-1 Step A → Step B.
- Conditional route test proves only selected branch starts.
- Manual gate test proves run pauses until approval.
- Relaunch persistence test proves template/run survives restart.

### Subagent starter prompt

```text
You are Lane D for Pi Deck Agent Workflows. Work only in
/Users/liusuzeng/Workspace/pi-deck-worktrees/aw-qa-e2e on branch aw/qa-e2e.

Task: prepare fake fixtures, E2E specs, and validation checklist for Agent
Workflows. Coordinate with Lane A contracts and avoid modifying implementation
files except small test hooks agreed by the primary agent.

Validation: run focused fake fixture/unit tests and E2E specs that are available.
Handoff with changed files, test commands, current pass/fail status, and missing
implementation hooks.
```

## 11. Integration sequence

### Integration Gate I0: Contract merge

Primary agent:

1. Review Lane A schemas and validation tests.
2. Merge or cherry-pick contract files.
3. Update preload/shared API types if needed.
4. Notify Lanes B/C/D to rebase onto updated main.

### Integration Gate I1: AW-1 backend + frontend behind flag

Primary agent:

1. Merge Lane B store/engine/service.
2. Merge Lane C standalone components.
3. Wire minimal `workflows.*` preload API.
4. Add sidebar **Agent Workflows** entry point.
5. Mount Workflow Home/Builder/Run view.
6. Keep feature behind an internal flag if needed, e.g. `PI_DECK_AGENT_WORKFLOWS=1`, until AW-1 tests pass.

### Integration Gate I2: Linear run smoke

Acceptance:

- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- Fake E2E: create AW-1 template, run it, Step B starts after Step A completes.

### Integration Gate I3: Conditional branch

Acceptance:

- Judge parser unit tests pass.
- Fake E2E: judge YES starts YES branch and skips NO branch.
- Malformed judge output routes to manual approval.

## 12. File ownership and conflict policy

Primary-owned integration files unless explicitly delegated:

```text
src/main/main.ts
src/preload/index.ts
src/shared/types.ts
src/shared/ipcSchemas.ts        # if workflow schemas are not split out
src/renderer/App.tsx
src/renderer/styles.css         # shared/global style changes
package.json
package-lock.json
```

Lane-owned additive areas:

```text
src/shared/workflowSchemas.ts
src/main/workflows/**
src/renderer/workflows/**
src/renderer/components/workflows/**
src/test/workflowFixtures.ts
e2e/agent-workflows.e2e.ts
```

If a lane must edit a primary-owned file, it should either:

1. stop and request integration ownership from the primary agent; or
2. create a tiny documented patch and call it out in handoff.

## 13. Suggested milestone breakdown

| Milestone | Outcome | Owner |
| --- | --- | --- |
| AW-M0 | Contracts accepted, lanes rebased | Primary + Lane A |
| AW-M1 | Templates can be created/listed/persisted | Lane B + integration |
| AW-M2 | Builder and run view render from real IPC | Lane C + integration |
| AW-M3 | Linear workflow runs two fake Pi sessions in sequence | Lane B/D + integration |
| AW-M4 | Condition judge routes YES/NO/UNSURE | Lane B/C/D |
| AW-M5 | Work inbox labels workflow runs and spawned sessions | Primary + Lane C |

## 14. Open decisions before implementation

1. Should workflows be enabled by default once AW-1 works, or hidden behind `PI_DECK_AGENT_WORKFLOWS=1` until AW-2?
2. Should judge steps create visible sessions, hidden internal sessions, or collapsible workflow-internal sessions?
3. Should workflow templates be global by default with an optional workspace default, or workspace-scoped by default?
4. What is the first version of workflow input types: text only, text + path references, or text + path references + images?
5. Should branch preview be default-on for early safety?
6. Should AW-1 use current real chat create/prompt internals directly, or introduce a small internal `ChatSessionService` first to reduce `main.ts` coupling?

## 15. Primary-agent merge checklist

Before reporting a combined feature slice ready:

- [ ] Review every subagent diff.
- [ ] Confirm no lane edited another lane's worktree or broad unrelated files.
- [ ] Confirm workflow/skill product boundary remains explicit in UX copy.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run focused Agent Workflows E2E when available.
- [ ] Update `docs/agent-workflows-design.md` if implementation decisions changed.
- [ ] Update `CHANGELOG.md` only when the feature is user-visible.
