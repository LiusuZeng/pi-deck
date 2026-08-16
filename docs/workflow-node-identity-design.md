# Stable workflow-node identity — execution design

**Status:** Proposed
**Owner:** BE
**Tracker:** [BE pending item](agent-workflows-backend-pending-items.md)

## Goal

Make a workflow node's identity independent of its mutable display name. Duplicate names and renames must not change workflow routing, orchestrator ownership, input bindings, graph selection, occurrence lineage, or historical-run interpretation.

## Identity model

| Concept | Identifier | Purpose |
| --- | --- | --- |
| Workflow definition | `workflowId` | Stable opaque UUID identifying the workflow across edits. |
| Configured node | `nodeId` | Stable opaque UUID created once with the node; unique within its workflow and never changed on rename. |
| Definition revision | `revision` | Mutable version metadata; never part of a node's identity. |
| Run | `runId` | Identifies one execution and its immutable definition snapshot. |
| Node occurrence | `occurrenceId` | Identifies one execution/attempt/iteration of a configured node. |

Internal cross-workflow keys use `(workflowId, nodeId)`. Within an immutable run, `nodeId` resolves against that run's definition snapshot; occurrence relationships use `occurrenceId`/parent-occurrence IDs.

Do **not** use a five-character identifier as a persisted primary key. It has too little collision space, even when scoped to one workflow. A five-character or similarly short derived token may be displayed as a non-authoring disambiguator, but it never participates in lookup or storage. UUIDs (or an equivalently collision-resistant opaque ID) remain the stored values.

Do **not** append `revision` or timestamp to node identity. Revisions and timestamps describe a change/event; adding either would make a node appear new after edits and break historical/restart semantics.

## Contract changes

1. Require `id: UUID` for every canonical node and `id: UUID` for each workflow definition.
2. Require all relationships, `entryNodeId`, orchestrator `agents`/`decider`, `managedBy`, and future explicit input bindings to refer to `nodeId`, never `name`.
3. Validate node-ID uniqueness within the definition, UUID format, and referential integrity at parse, save, IPC, and run-creation boundaries.
4. Treat `name` as a bounded, mutable display string. Allow duplicate names.
5. Run creation snapshots IDs and display names with the definition. Editing a template never changes a prior run's identity resolution.

## Builder and graph behavior

- Generate a UUID when the user adds a role/node; retain it through rename, reorder, and inspector edits.
- Node selectors primarily show the name and role. If names collide, show compact contextual disambiguation (for example role, container/path, and a display-only short ID).
- The read-only graph keys layout/selection by `nodeId`; labels use `name`. Renaming updates labels without replacing nodes or connections.
- JSON view preserves IDs. Copy/import validates IDs rather than regenerating them silently; an explicit duplicate/copy workflow operation must intentionally mint a new workflow ID and new node IDs or provide a defined remapping pass.

## Migration and compatibility

1. Audit existing persisted canonical definitions and legacy template formats to identify any name-keyed reference.
2. For each migratable definition, generate node UUIDs once and rewrite every internal reference atomically in the same persisted transaction.
3. Validate the rewritten definition before commit; write an existing-store backup before migration and preserve unknown/future versions unchanged.
4. Do not rewrite immutable historical run snapshots if it could alter their meaning. Prefer the existing snapshot/legacy reader; only migrate a run when all name-to-node references resolve uniquely, and test the transformation.
5. Resume/rehydration resolves from the run's stored snapshot, not the current template or display name.

## Implementation sequence

1. **Audit and fixtures:** Locate every name-keyed lookup in schemas, builder, definition helpers, graph, engine/scheduler, prompt/input binding, store, IPC, rehydration, and tests. Add duplicate-name and rename fixtures before changes.
2. **Schema and validation:** Introduce/enforce UUID node IDs and ID-only references in the canonical schema; add strict uniqueness/referential-integrity validation and clear migration errors.
3. **Runtime and persistence:** Update lookup/index helpers and occurrence creation to use IDs. Ensure saved runs retain immutable definition snapshots and that rehydration uses their IDs.
4. **Migration:** Implement a versioned, backed-up atomic migration for unambiguous saved definitions, with fallback legacy reading for anything unsafe to rewrite.
5. **Renderer:** Generate IDs at creation, remove name-as-key state, retain stable React/graph keys, and add duplicate-name disambiguation in selectors and graph inspection.
6. **Verification:** Run schema/store migration tests; runtime routing, retry, loop, fan-out, and rehydration tests; renderer duplicate-name/rename tests; and E2E tests proving rename/duplicate labels do not alter existing connections, handoffs, or prior runs.

## Completion gate

A workflow may contain two identically named nodes; either may be renamed after connections, orchestration, and input bindings are configured. In all cases, the intended node remains connected and associated with the same occurrences before and after reload/restart. Historical runs resolve against their own snapshot without consulting current names.
