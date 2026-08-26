# Issue 11 fix plan: workflow runtime ownership

GitHub issue: [#11 Harden workflow runtime ownership across destructive session operations](https://github.com/LiusuZeng/pi-deck/issues/11)

Worktree branch: `fix/issue-11-workflow-runtime-ownership`

## Problem summary

Workflow schedulers create ordinary chat runtimes through `createChatSessionSnapshot`. Those runtimes are tracked by the shared main-process chat maps, but workflow ownership is private to each scheduler:

- legacy `WorkflowScheduler`: `src/main/workflows/workflowScheduler.ts`, `activeByRuntime`
- canonical `WorkflowOccurrenceScheduler`: `src/main/workflows/workflowScheduler.ts`, `active`

Because main cannot distinguish renderer-owned chat sessions from scheduler-owned workflow runtimes, public destructive operations can close/delete/reset an active workflow runtime while the scheduler is still reading its terminal snapshot and persisting the final workflow result/transcript.

The invariant should be: once a scheduler allocates a runtime for workflow work, the scheduler remains the only lifecycle owner until terminal persistence and scheduler-internal close finish or an explicit scheduler shutdown path takes ownership of interruption.

## Current relevant seams

### Public destructive operations in main

- `src/main/main.ts`
  - `chat:closeSession` IPC handler: resolves runtime and calls `closeAttachedChatRuntime` after checking active turn state.
  - `chat:reset` IPC handler: calls `closeChatWorker`, then creates a new chat session.
  - `chat:deleteSession` / `deleteChatSession`: `allowAttached: true`, closes a locked runtime before deleting its persisted session file.
  - `deleteAllChatSessions` and `deleteAllWorkspaceChatSessions`: skip `chatSessionIsBusy`, then remove files or delegate to single delete.
  - `workspaceArchive` and `workspaceArchiveSession`: archive workspace/session refs after attached/resume/mutation checks.

### Runtime lifecycle support already present

- `WorkspaceRuntimeLifecycleGate` (`src/main/workspaceRuntimeLifecycleGate.ts`) serializes workspace archive claims against runtime creation.
- `WorkspaceRuntimeShutdownTombstones` (`src/main/workspaceRuntimeShutdownTombstones.ts`) keeps archive blocked after failed close until worker exit is confirmed.
- `closeAttachedChatRuntime` starts and clears shutdown tombstones for normal closes.
- `closeChatWorker` provisions tombstones before reset/quit teardown, but it then detaches the event router and clears runtime maps without first giving workflow schedulers an authoritative shutdown boundary.

### Scheduler runtime ownership

- `WorkflowScheduler` currently stores `{ runtimeId -> ActiveStep }`, performs ownership checks before/after some async work, snapshots final messages, persists `finalAnswer`/`transcript`, releases ownership, and then calls its injected `closeSession`.
- `WorkflowOccurrenceScheduler` stores `{ runtimeId -> { runId, occurrenceId } }`, deletes ownership when a terminal event starts, serializes by run, snapshots final messages, persists completion/failure, and then calls its injected `closeSession`.

## Design recommendation

Introduce one main-owned workflow runtime lifecycle guard and make all public destructive boundaries consult it. Do not put an unconditional guard inside `closeAttachedChatRuntime`, because scheduler-internal close must remain privileged.

### 1. Add a main-owned ownership registry

Create a small lifecycle module, for example `src/main/workflowRuntimeOwnership.ts`.

Responsibilities:

- Track live workflow-owned runtime IDs with metadata:
  - `runtimeId`
  - `scheduler`: `legacy` or `occurrence`
  - `runId`
  - step/occurrence ID when available
  - `workspaceId`
  - `sessionFile` if known
  - monotonically increasing `generation` token
  - phase: `allocating`, `running`, `terminal`, `closing`, `failed-close` if needed
- Provide an RAII-style claim API so ownership is released exactly once:
  - `claim(runtimeId, metadata) -> WorkflowRuntimeOwnerClaim`
  - `isOwned(runtimeId)` / `get(runtimeId)`
  - `assertPublicMutationAllowed(runtimeId, operation)`
  - optional `ownedRuntimeIds()` and `ownedSessionFiles()` for reset/bulk/archive checks
- Keep release idempotent. A claim release after `worker_exit` or failed close should be harmless.
- Integrate with shutdown tombstones, not replace them. A failed scheduler-internal close should still leave workspace archive blocked until worker exit confirms shutdown.

This should live in main (or a main-owned service injected into schedulers), not only inside each scheduler, because public IPC operations are in `main.ts` and main is the final authority.

### 2. Inject ownership claims into both schedulers

Extend scheduler dependencies with optional ownership hooks rather than importing main globals into workflow code.

Suggested dependency shape:

```ts
type WorkflowRuntimeOwnershipClaim = {
  release(): void;
  markTerminal?(): void;
  markClosing?(): void;
};

type WorkflowRuntimeOwnerMetadata = {
  scheduler: "legacy" | "occurrence";
  runId: string;
  workflowItemId: string;
  workspaceId: string;
  sessionFile?: string;
};

claimRuntimeOwnership?(runtimeId: string, metadata: WorkflowRuntimeOwnerMetadata): WorkflowRuntimeOwnershipClaim;
```

Legacy scheduler flow:

1. Create the session under the existing workspace creation gate.
2. Before persisting started runtime metadata and before prompting, claim ownership.
3. Store the returned claim next to `activeByRuntime`.
4. On terminal event, keep the claim through snapshot read and workflow persistence.
5. Mark terminal/closing for diagnostics if useful.
6. Release only after scheduler-internal close finishes or after a deterministic interruption transition during scheduler shutdown.
7. On allocation/prompt/configuration failure, release after internal close.

Canonical scheduler flow:

1. Claim immediately after `createSession` returns and before `startWorkflowOccurrence` is saved/promoted to running.
2. Store claim with `active` owner info.
3. Do not delete the main-owned claim at the start of terminal handling; keep it until completion/failure persistence and internal close finish.
4. Add a generation or claim identity check before saving terminal results so stale terminal callbacks cannot persist over a newer run mutation.
5. Convert snapshot failures into persisted occurrence failure rather than letting the promise reject from the event handler.

### 3. Guard public destructive operations

Add a helper in `main.ts`, backed by the ownership registry:

```ts
function assertRuntimeNotWorkflowOwned(runtimeId: string, action: string): void;
```

Recommended message: `Workflow runtime is still finalizing. Stop the workflow or wait for it to finish before ${action}.`

Use it at these authoritative public boundaries:

- `chat:closeSession`: after `resolveActiveChatRuntimeId`, before status/snapshot/close.
- `deleteChatSession`: inside `withChatSessionMutation(... allowAttached: true ...)`, after reading `lockedRuntimeId`, before `closeRuntimeForDeletedSession` and before file deletion.
- `deleteAllChatSessions`: explicitly skip owned session files/runtimes before mutation/removal. This is defense-in-depth beyond `chatSessionIsBusy`.
- `deleteAllWorkspaceChatSessions`: skip owned session files/runtimes before delegating to single delete.
- `chat:reset`: either reject while workflow-owned runtimes exist, or route through scheduler shutdown (see next section). The safer first implementation is rejection for ordinary reset, preserving existing ordinary chat reset behavior when no workflows are active.
- `workspaceArchive`: keep the existing live-runtime/resume/tombstone guard, but use workflow ownership for clearer error messages and to protect future registry drift.
- `workspaceArchiveSession`, `workspaceRemoveSession`, and `workspaceMoveSession`: optional explicit checks for better errors; current `withChatSessionMutation` blocks attached session-file locks, but the main guard should not rely on that as the only protection.

Do not guard `closeAttachedChatRuntime` globally. Instead, let scheduler dependency `closeSession` call the internal close path as the privileged lifecycle-owner operation.

### 4. Reset and shutdown policy

Issue #11 separates public reset from scheduler-internal close and app shutdown. Implement them deliberately:

- Public `chat:reset`
  - If workflow-owned runtimes exist, reject reset with a clear message.
  - Ordinary chat reset remains unchanged when no workflow runtime is owned.
- Application shutdown / before-quit
  - Add explicit scheduler shutdown APIs for both schedulers.
  - Enter a quiescing state so no new allocations or terminal writes can begin.
  - Persist deterministic interruption state for active workflow work, or document why app quit may rely on existing restart rehydration.
  - Close scheduler-owned runtimes through the privileged internal close dependency.
  - Keep failed-close shutdown tombstones until worker exit confirmation.

If product prefers `chat:reset` to stop active workflows, implement it as an explicit workflow-aware shutdown first; do not let `closeChatWorker` silently clear adapter/maps underneath schedulers.

### 5. Serialize allocation/reset/archive races

Keep `WorkspaceRuntimeLifecycleGate.withCreation` around `createChatSessionSnapshot`; it already covers worker registration and initial durable snapshot creation. Add the ownership claim within that lifecycle window or immediately after creation before any public destructive operation can observe an unowned workflow runtime.

For reset, use one of these contracts:

- Rejection contract: `chat:reset` checks `workflowRuntimeOwnership.hasOwnedRuntimes()` before calling `closeChatWorker`; no serialization beyond the synchronous main-owned registry check is needed.
- Shutdown contract: `chat:reset` first calls an awaited scheduler shutdown method that atomically marks schedulers quiescing and claims interruption ownership, then closes runtimes. Only after that may `closeChatWorker` clear shared adapter state.

### 6. Persistence fencing

Legacy scheduler already checks `mutationVersions`, but `persistAndEmit` can still perform a stale durable write if ownership changes while awaiting the store. Strengthen it by making terminal persistence compare the latest persisted run/generation before writing, or by moving to a store-level compare-and-swap/update function.

Canonical scheduler should receive equivalent protection:

- Store a generation/claim identity with each active occurrence.
- Check the claim before snapshot, before save, and after save.
- Ensure stop/retry/human answer invalidates any older runtime claim before the older terminal path can persist.

This is secondary to public operation blocking but closes the remaining terminal/archive/reset race at the scheduler layer.

## Test plan

### Unit tests: ownership registry

Add `src/main/workflowRuntimeOwnership.test.ts` covering:

- claim/release lifecycle and idempotent release
- duplicate claim rejection or deterministic replacement policy
- query by runtime ID, workspace ID, and session file
- public guard error messages
- release-after-worker-exit/failed-close behavior if the registry participates in tombstone state

### Scheduler tests

Extend `src/main/workflows/workflowScheduler.test.ts` for both scheduler classes:

- A workflow runtime remains owned from allocation through final snapshot persistence and internal close.
- Public ownership callback is released exactly once after successful terminal close.
- Prompt/configuration failure releases after internal close.
- Terminal snapshot failure persists failure, closes internally, and releases ownership.
- Stop/retry invalidates and releases the owned runtime before old terminal events can save completion.
- Canonical scheduler has deterministic coverage for multiple concurrent owned occurrences.

### Main/destructive-operation tests

`main.ts` currently has limited directly exported seams. Prefer extracting the guardable destructive operations into a small testable service, or expose test hooks under an existing test-only pattern. Cover:

- `chat.closeSession` rejects a workflow-owned runtime and does not call adapter close.
- Single delete rejects/skips an attached workflow-owned session and does not remove the session file.
- Global and workspace bulk delete skip workflow-owned sessions while deleting ordinary eligible sessions.
- `chat:reset` rejects while workflow-owned runtimes exist and still resets ordinary chat sessions.
- Workspace archive rejects while a workflow-owned runtime exists in the workspace.
- Failed scheduler-internal close leaves archive blocked until `worker_exit` confirmation.
- Allocation vs archive: archive cannot pass while workflow allocation is in `withCreation`; allocation cannot start after archive claim.
- Allocation vs reset: either reset rejects after claim appears, or scheduler shutdown serializes first.

### Renderer tests, if advisory UI is added

Renderer disablement is non-authoritative. If added, cover only messaging/disablement; main tests must prove enforcement.

## Suggested implementation order

1. Add the workflow runtime ownership registry and tests.
2. Inject registry claim/release hooks into both schedulers and add scheduler lifecycle tests.
3. Add public destructive-operation guards in main.
4. Add reset policy. Start with reject-while-workflow-owned unless product explicitly wants reset-to-stop-workflows.
5. Add scheduler shutdown/quiescing API for app quit and future reset-to-stop behavior.
6. Strengthen scheduler terminal persistence fencing, especially canonical generation checks and legacy stale durable-write prevention.
7. Run `npm run typecheck` and targeted Vitest suites, then broader `npm test`.

## Open decisions

- Should public `chat:reset` simply reject during workflow execution, or should it stop active workflows first? Rejection is safer and preserves ordinary chat reset behavior.
- Should canonical workflow occurrences persist bounded transcript like legacy workflow steps? Issue #11 requires transcript persistence not be interrupted where it exists; adding canonical transcript persistence is a product/schema decision.
- Should app quit persist active workflow work as failed/cancelled immediately, or rely on restart rehydration to mark interrupted work? A scheduler shutdown API can support either policy, but it should be explicit.
