# Agent Workflows v2 — Completion Gap and Parallel Plan

**Status:** Build/Graph/home completion integrated; occurrence-run UI wiring remains tracked
**Date:** 2026-08-08
**Design source:** [Role-Based Agent Workflows v2](agent-workflows-role-based-design.md)
**Baseline:** `dev/agent-workflows-prompt-first` at merge `c5b41ba`

## 1. Goal

Finish the role-based authoring experience described by the approved design. The
canonical schema and occurrence runtime already contain substantial v2 support,
but the Build and Graph views do not currently let a user author or understand
that model.

This plan is the shared contract for isolated implementation worktrees. The
primary agent owns integration, contract reconciliation, App/main wiring, and the
combined verification suite.

## 2. Confirmed gaps

### Build view blockers

- A newly added Orchestrator hard-codes a Worker reference without assigning the
  Worker's reciprocal `managedBy`, so the generated document fails validation.
- Orchestrator mode, managed Workers, loop Decider, maximum iterations, fan-out
  concurrency, and `all`/`any` completion cannot be edited in Build.
- A Decider exposes only its question. The generic connector creates an
  unconditional edge even though a top-level Decider requires one `true` and one
  `false` relationship.
- Conditional terminal destinations cannot be authored in Build.
- Optional role fields are incomplete: Worker expected output/input, Decider
  labels/input, Human choice options/input, and shared execution settings.
- Existing relationships cannot be removed or safely retargeted.
- Build does not surface enough semantic validation to explain invalid ownership,
  reachability, or missing routes.

### Graph and responsive gaps

- Graph is a flat list rather than a derived, auto-laid-out semantic projection.
- Managed roles are hidden instead of rendered inside Orchestrator containers.
- Decider true/false routes, loop limits/Decider, fan-out concurrency/completion,
  and Human interaction types are not represented as designed.
- The inspector does not become a tablet drawer or mobile full-screen sheet.

### Lifecycle and runtime gaps

- The v2 store and list/create/update IPC exist, but the current renderer home
  still consumes the legacy template list. Workflows containing role nodes are
  filtered out by the compatibility conversion and can disappear from the home
  UI after save.
- The occurrence runtime is not yet the normal renderer start/run path.
- Fan-out `completion: "any"` completes the Orchestrator while running siblings
  remain active; a later sibling completion can attempt to advance/route the
  completed Orchestrator again.
- Test coverage does not exercise role-aware Build authoring or the complete
  Graph semantics.

## 3. Frozen interpretation for this implementation

1. **Exactly four roles:** Worker, Decider, Orchestrator, Human.
2. **Fixed-list fan-out:** fan-out count is the number of configured managed
   Workers. There is no separate `fanoutCount` field. `maxConcurrency` limits how
   many of those Workers run at once. Dynamic N-way generation from input remains
   out of scope, matching the design's simpler fixed-list default.
3. **Loop contract:** a Loop owns one or more managed Workers, one managed
   Decider, and `maxIterations`. Each iteration runs the configured Worker batch,
   then evaluates the Decider. Changing serial-versus-batch semantics is out of
   scope for the renderer completion milestone; the UI must describe the actual
   batch behavior rather than implying an unimplemented serial pipeline.
4. **Explicit boolean routing:** an unmanaged Decider has exactly one `true` and
   one `false` destination. Destinations may be top-level nodes or named terminal
   outcomes. Labels remain display text; runtime values remain booleans.
5. **Bidirectional ownership:** assigning a role to an Orchestrator must update
   both the Orchestrator references and the child's `managedBy`. Managed roles
   cannot retain top-level relationships. The UI must prevent or explicitly
   resolve conflicting ownership rather than silently creating invalid JSON.
6. **One canonical document:** Build and Graph mutate/project the same v2 document;
   JSON remains the escape hatch, not the only way to configure core semantics.
7. **No DSL, drag-connect requirement, or dynamic fan-out generation.**

## 4. Parallel lanes and file ownership

### Lane A — Build authoring and role inspector

Owns:

- `src/renderer/components/workflows/WorkflowV2Builder.tsx`
- `src/renderer/components/workflows/WorkflowV2Builder.test.ts`
- `src/renderer/workflows/workflowV2.ts` and focused tests when needed
- narrowly scoped `.workflow-v2-*` rules in `src/renderer/styles.css`
- additive role-inspector components under
  `src/renderer/components/workflows/v2/`, if useful

Delivers:

- Valid Orchestrator creation and bidirectional managed-role ownership.
- Editable mode, managed Workers, loop Decider/max iterations, fan-out
  concurrency/completion, and a clearly displayed derived fan-out count.
- Explicit Decider true/false destination controls and labels.
- Role-specific optional fields, Human choice options, relationship deletion,
  and editable Advanced execution settings.
- Focused inline validation and renderer tests for GUI → canonical JSON.

Must not edit shared schemas, main-process runtime/store, App integration, or the
new Graph component owned by Lane B.

### Lane B — Derived semantic Graph

Owns additive files only:

- `src/renderer/components/workflows/v2/WorkflowV2Graph.tsx`
- `src/renderer/components/workflows/v2/WorkflowV2Graph.test.ts`
- `src/renderer/workflows/workflowV2Graph.ts`
- `src/renderer/workflows/workflowV2Graph.test.ts`

Delivers a standalone component with this contract:

```ts
interface WorkflowV2GraphProps {
  definition: WorkflowDefinition;
  selectedNodeId?: string;
  onSelectNode(nodeId: string): void;
}
```

It must render top-level flow, Orchestrator containers with managed roles,
Decider true/false labels, loop Decider/iteration limit, fan-out Worker count,
concurrency and all/any policy, Human interaction, and terminal outcomes. It is
read-only and keyboard selectable. Use semantic HTML and deterministic derived
layout/model; do not add a graph-layout dependency.

Must not edit `WorkflowV2Builder.tsx`, `styles.css`, App, shared schemas, or main
files. Return any required integration CSS as a small handoff snippet or use a
component-local class contract for the primary agent.

### Lane C — Runtime correctness hardening

Owns:

- `src/main/workflows/workflowV2Runtime.ts`
- `src/main/workflows/workflowV2Runtime.test.ts`

Delivers:

- Idempotent fan-out `completion: "any"`: already-running siblings are cancelled
  or safely ignored according to the smallest consistent policy, and late child
  completions cannot route an already-completed Orchestrator twice.
- Tests proving bounded concurrency, `all`, `any`, late completion safety,
  multiple loop iterations, and single downstream routing.

Must not alter shared schemas, renderer files, IPC, store, or scheduler wiring.

### Lane D — V2 lifecycle/home integration design and additive UI

Owns additive files only:

- `src/renderer/components/workflows/v2/WorkflowV2Home.tsx`
- `src/renderer/components/workflows/v2/WorkflowV2Home.test.ts`
- `src/renderer/workflows/workflowV2ViewModels.ts`
- `src/renderer/workflows/workflowV2ViewModels.test.ts`

Delivers a standalone v2 workflow list/card surface using
`WorkflowDefinition[]`, with create/edit/start callbacks and summaries for all
four roles. It must not convert v2 workflows through legacy templates. The
handoff must state the minimal App integration contract and any occurrence-run UI
that remains blocked on backend wiring.

Must not edit App, WorkflowHome, main/preload/shared IPC, store, or runtime. The
primary agent will integrate the existing `listWorkflows` API and reconcile the
legacy/v2 home surfaces.

## 5. Integration order

1. Review every lane diff and validation evidence.
2. Merge Lane C (isolated runtime behavior).
3. Merge Lane B additive Graph component/model.
4. Merge Lane A Build authoring; replace its temporary graph rendering with Lane
   B through the frozen component contract.
5. Merge Lane D additive home/view-model surface.
6. Primary agent wires App to `listWorkflows`, v2 create/update/edit, and the
   unified home. No role workflow may disappear after save.
7. Run focused tests, full Vitest, typecheck, format, production build, and a fake
   user-flow check. Add a fresh-context review wave before release.

Occurrence-run IPC/scheduler integration is a follow-on milestone if it cannot be
completed without broad changes to primary-owned `main.ts`, preload, App, and run
surfaces. It must remain explicitly tracked rather than being represented as
finished.

## 6. Acceptance contract

### Authoring

- A user can create a valid fixed-list Fan-out entirely in Build, choose managed
  Workers, set concurrency and all/any, and see the derived count.
- A user can create a valid Loop entirely in Build, choose managed Workers and a
  managed Decider, and set max iterations.
- A user can create an unmanaged Decider and assign distinct Yes/No destinations
  without editing JSON.
- Build-authored workflows pass the shared validator and round-trip through JSON.
- Dismissal, role selection, ownership changes, and relationship edits preserve
  unrelated nodes and current focus/selection predictably.

### Graph

- Every top-level and managed role has a semantic representation.
- Orchestrator mode and limits/policy are visible; Decider outcomes are labeled.
- Graph remains read-only and keyboard selection returns to the corresponding
  Build inspector through the parent callback.

### Runtime

- Fan-out `any` produces exactly one downstream route and handles sibling work
  deterministically.
- Existing loop/all behavior remains covered and green.

### Lifecycle

- Saved v2 workflows remain visible and editable through a v2-native list path.
- Legacy workflows and runs remain readable through their compatibility path.
- The UI does not imply v2 runs are supported until occurrence execution is wired
  end to end.

## 7. Integrated result — 2026-08-08

Completed in the release worktree:

- Build can author fixed-list Fan-out and Loop Orchestrators, including managed
  ownership, concurrency/completion, loop Decider, and iteration limits.
- Decider and Human boolean/choice branches have explicit conditional
  destinations; role-specific optional and execution fields are editable.
- Graph is a deterministic read-only semantic projection with managed-role
  containers, labeled outcomes, limits, policies, and terminal outcomes.
- V2 definitions remain visible/editable through a workspace-scoped native list
  while legacy templates and runs retain their compatibility surface.
- Fan-out `any` handles success-first, failure-first, late sibling completion or
  failure, and all-failed outcomes without duplicate downstream routing.
- Mobile uses a full-screen inspector sheet with focus entry/restoration. Tablet
  currently uses a sticky inspector rather than the optional drawer treatment.

Deferred explicitly:

- V2 occurrence execution is not yet wired through the normal App run UI and
  scheduler IPC, so Start remains disabled with an accessible explanation.
- Dynamic input-generated fan-out remains out of scope; count is derived from the
  fixed managed-Worker list.

Validation after integration: 58 Vitest files passed with 436 tests and 2 TODOs;
main and renderer typechecks, Prettier, production build, and diff checks passed.
Independent fresh-context release review reported no blockers.

## 8. Required lane handoff

Each worker reports:

- worktree/branch and baseline commit;
- files changed and concise diff summary;
- tests/commands with exit codes;
- assumptions made inside this frozen contract;
- integration steps or conflicts;
- residual risks and intentionally deferred scope.
