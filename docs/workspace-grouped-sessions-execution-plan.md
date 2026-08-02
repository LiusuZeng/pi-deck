# Workspace-Grouped Sessions Execution Plan

Status: implementation in progress  
Date: 2026-08-01  
Supersedes for new work: `project-grouped-sessions-p0-plan.md`  
Compatibility baseline: existing directory-backed Projects remain readable during migration

## 1. Outcome

Introduce a first-class **Workspace** that groups related Pi sessions by user intent rather than by filesystem directory.

The product vocabulary is:

- **Workspace**: a durable, user-named container for related sessions.
- **Working folder**: a registered local directory used as a Pi execution context.
- **Session**: one Pi-native conversation, assigned to exactly one workspace and retaining its own actual `cwd`.

A workspace may have no default working folder. Sessions in one workspace may use different working folders. Pi session JSONL files remain authoritative for conversation history and are never moved or rewritten by this feature.

## 2. Non-Negotiable Invariants

1. Workspace IDs are opaque UUIDs and never filesystem paths.
2. A canonical `sessionFile` belongs to at most one workspace in the first release.
3. Workspace membership is explicit and app-owned; cwd inference is used only for migration/import suggestions.
4. Pi still launches in a concrete cwd:
   - new session: request working folder, then workspace default, otherwise require a user choice;
   - resumed session: validated cwd from the Pi JSONL header.
5. Workspace archive/removal never deletes Pi session files.
6. Removing a session from a workspace is distinct from deleting the Pi session from disk.
7. Renderer-supplied IDs and paths are never filesystem authority. Main resolves stored records and revalidates files immediately before resume/delete.
8. Models, `.pi` configuration, resources, image settings, and attachment-relative paths are scoped to a runtime/draft working folder, not a workspace.
9. Switching workspaces is a view transaction. Attached workers in other workspaces remain addressable and visible in cross-workspace active work.
10. The existing fake backend remains functional while the real backend gains workspace semantics.

## 3. Target Data Model

Workspace metadata is additive and stored in `~/.pideck/workspaces.json` (or `PI_DECK_HOME/workspaces.json` in isolated environments).

```ts
interface WorkspaceRecord {
  id: string;
  name: string;
  defaultProjectId?: string; // existing registered directory record; convenience only
  legacyProjectId?: string; // idempotent migration/compatibility mapping
  createdAtMs: number;
  updatedAtMs: number;
  lastOpenedAtMs: number;
  archivedAtMs?: number;
}

interface WorkspaceSessionRef {
  workspaceId: string;
  sessionFile: string;
  sessionId?: string;
  cwd?: string;
  title?: string;
  preview?: string;
  addedAtMs: number;
  lastSeenAtMs: number;
  lastKnownUpdatedAtMs?: number;
  createdAtMs?: number;
  messageCount?: number;
  missingSinceMs?: number;
}

interface WorkspaceStoreFileV1 {
  version: 1;
  activeWorkspaceId?: string;
  projectsMigrationCompletedAtMs?: number;
  workspaces: WorkspaceRecord[];
  sessionRefs: WorkspaceSessionRef[];
}
```

The existing `ProjectStore` remains temporarily responsible for canonical directory registration and authorization. Its session-reference responsibilities become legacy-only after workspace migration.

Runtime bookkeeping becomes one binding rather than parallel maps where practical:

```ts
interface RuntimeWorkspaceBinding {
  runtimeId: string;
  workspaceId: string;
  projectId?: string;
  cwd: string;
  sessionFile?: string;
}
```

## 4. IPC Contract

### 4.1 Workspace lifecycle

```ts
workspaces.list(): Promise<WorkspaceListResult>
workspaces.getActive(): Promise<WorkspaceListResult>
workspaces.create({ name, defaultProjectId? }): Promise<WorkspaceListResult>
workspaces.update({ workspaceId, name?, defaultProjectId? }): Promise<WorkspaceListResult>
workspaces.select({ workspaceId }): Promise<WorkspaceListResult>
workspaces.archive({ workspaceId }): Promise<WorkspaceListResult>
```

Names are trimmed, whitespace-normalized, and limited to 120 characters. Duplicate names are allowed; identity is the UUID.

### 4.2 Workspace membership

```ts
workspaces.addSession({ workspaceId, sessionFile }): Promise<WorkspaceSessionMutationResult>
workspaces.moveSession({ sessionFile, toWorkspaceId }): Promise<WorkspaceSessionMutationResult>
workspaces.removeSession({ workspaceId, sessionFile }): Promise<WorkspaceSessionMutationResult>
workspaces.listUnassignedSessions(): Promise<ChatListSessionsResult>
```

Adding/importing validates that the file is a regular Pi `.jsonl` session below the configured session directory and reads its canonical header cwd. Move is rejected while an attached runtime owns the file in the first release.

### 4.3 Chat lifecycle

```ts
chat.listSessions({ workspaceId? })
chat.createSession({ workspaceId?, projectId? })
chat.resumeSession({ workspaceId?, sessionFile })
chat.deleteSession({ workspaceId?, sessionFile })
chat.deleteAllSessions({ workspaceId? })
chat.listModels({ runtimeId?, projectId? })
```

During one compatibility release, omitted `workspaceId` resolves from the active workspace, while legacy `projectId` calls translate through `legacyProjectId`. New snapshots include `workspaceId`; deprecated `projectId` remains available until the renderer migration is complete.

For a draft, model discovery receives a registered working-folder `projectId`. For an attached runtime, `runtimeId` is authoritative.

## 5. Main-Process Execution Changes

### 5.1 Workspace store

Add `src/main/workspaces/workspaceStore.ts` with:

- strict Zod validation;
- serialized atomic writes using temp-file rename;
- corrupt-file backup and empty recovery;
- UUID generation with `node:crypto.randomUUID()`;
- create, update, select, archive, and list operations;
- canonical session membership upsert/move/remove;
- cached session-summary projection for bootstrap;
- lookup by legacy project ID;
- idempotent import from the already-loaded ProjectStore snapshot.

The store must validate an entire mutation batch before changing in-memory state and retry a previously failed persist on a later equivalent mutation, matching current ProjectStore durability behavior.

### 5.2 Migration

On first real-backend bootstrap when `projectsMigrationCompletedAtMs` is absent:

1. Read active/non-archived existing project records and refs.
2. Create one workspace per project, preserving display name and storing `legacyProjectId` and `defaultProjectId`.
3. Copy each project session ref into the matching workspace.
4. Resolve duplicate `sessionFile` membership deterministically:
   - active legacy project wins;
   - otherwise most recently opened project wins;
   - record a diagnostic for every discarded duplicate.
5. Persist `workspaces.json` atomically with the migration marker.
6. Do not modify `projects.json` or any Pi JSONL file.

If no legacy project exists, create an initial workspace from the existing bootstrap cwd so current launch commands still open into a usable view.

### 5.3 Session repository

Split repository responsibilities:

- `scanSessionRepository({ sessionDir, ...limits })` becomes cwd-neutral and returns every valid summary with canonical header cwd.
- `validatePiSessionFile({ sessionFile, sessionDir })` validates canonical containment, regular file, `.jsonl`, and Pi header and returns `{ sessionFile, cwd }`.
- Resume separately requires the returned cwd to exist and be a directory.
- Delete requires a valid contained Pi session file but does not require cwd equality with a workspace default.

Preserve the existing scan depth/file/byte/wall-time limits and symlink rejection.

### 5.4 Listing

`chat.listSessions({ workspaceId })`:

1. Resolve/authorize the workspace.
2. Read its explicit session refs.
3. Revalidate referenced files with bounded concurrency.
4. Refresh summary metadata for valid files.
5. Mark missing refs and hide them from the visible list.
6. Add `attachedRuntimeId` from the existing session-file lock map.
7. Sort by `updatedAtMs` descending.

Do not scan all sessions on every workspace switch. A cwd-neutral full scan is reserved for explicit refresh/import and the unassigned view.

### 5.5 Create and resume

New session:

1. Resolve workspace.
2. Resolve registered working folder from request or workspace default.
3. Revalidate the folder immediately before launch.
4. Resolve cwd-specific Pi configuration and start the worker.
5. Bind runtime to `{ workspaceId, projectId, cwd }`.
6. As soon as `get_state` reports `sessionFile`, persist membership even when there are zero messages and no title.

Resume:

1. Resolve workspace and exact stored membership.
2. Revalidate session file and obtain header cwd.
3. Resolve cwd-specific Pi configuration.
4. Start `pi --mode rpc --session <file>` with the header cwd.
5. Verify Pi returns the requested canonical session file.
6. Bind runtime to the owning workspace and actual cwd.

### 5.6 Delete semantics

- **Remove from workspace** removes metadata only.
- **Delete session** closes its runtime, moves/removes the JSONL file, then removes membership.
- **Delete all in workspace** iterates only explicit workspace members and returns the exact successfully deleted subset.
- **Archive workspace** hides the workspace and does not touch sessions or workers; attached work remains discoverable until closed.

## 6. Renderer Execution Changes

### 6.1 State model

Separate grouping fields from execution fields:

```ts
interface SessionViewModel {
  workspaceId: string;
  workingDirectory?: string;
  projectId?: string;
  // existing runtime/session/timeline fields remain
}
```

Remove fallback membership checks based on `session.projectPath === projectId`. Workspace filtering uses only `workspaceId`.

### 6.2 Bootstrap and navigation

- Bootstrap renders active workspace and cached workspace session refs without starting Pi or scanning the repository.
- Workspace switching retains all runtime-backed sessions, drafts with composer state, and cross-workspace attention items.
- Destination saved rows are refreshed without evicting hidden workspace state.
- Opening an item from cross-workspace active work selects its owning workspace and session as one UI transaction.

### 6.3 Workspace UI

Replace the folder-only project action with:

- workspace switcher;
- **New workspace…** dialog requiring only a name;
- optional **Choose default working folder…**;
- rename and archive actions;
- visible default-folder subtitle or `No default folder`.

New session behavior:

- inherit a valid workspace default;
- otherwise show an explicit working-folder chooser before model discovery/first send;
- remember the chosen folder on the draft and offer `Make default for this workspace`;
- show compact cwd badges when one workspace contains multiple working folders.

Session actions add:

- **Move to workspace…**;
- **Remove from workspace**;
- existing destructive **Delete session** remains visually and textually distinct.

An explicit **Add existing session…** / **Unassigned sessions** flow replaces silent cwd-based adoption after migration.

### 6.4 Directory-sensitive UI

- Attachment selection and dropped-file relative paths use the selected session/draft working directory.
- Draft model discovery waits until a working folder is resolved.
- Runtime model/command/image capabilities continue using `runtimeId`.
- A missing workspace default is a recoverable workspace setting, not an invalid workspace.

## 7. Compatibility and Removal Schedule

Release N:

- Add workspaces and migrate existing projects.
- Keep current ProjectStore and legacy project IPC translation.
- Renderer uses workspace APIs.
- CLI `--project <path>` creates/selects the migrated path-backed workspace or creates a workspace named from the path basename with that folder as default.

Release N+1:

- Stop writing legacy project session refs.
- Rename internal directory authority from ProjectStore to WorkingDirectoryStore if worthwhile.
- Remove renderer `ProjectRef.path/canonicalPath` assumptions.

Later:

- Remove legacy project chat-request translation after stored migrations and supported downgrade expectations are documented.

## 8. Parallel Workstreams and Ownership

### Workstream A — Workspace persistence

Owned files:

- `src/main/workspaces/workspaceStore.ts`
- `src/main/workspaces/workspaceStore.test.ts`

Deliverable: complete store API, durability behavior, cached projections, and legacy-project migration input contract. No edits to shared IPC or `main.ts`.

### Workstream B — Session repository decoupling

Owned files:

- `src/main/pi/sessionRepository.ts`
- `src/main/pi/sessionRepository.test.ts`

Deliverable: cwd-neutral scan and validation returning canonical session cwd, retaining all safety/limit coverage. No edits outside those files.

### Workstream C — Renderer workspace UX

Owned files:

- `src/renderer/App.tsx`
- `src/renderer/App.test.ts`
- `src/renderer/styles.css`

Deliverable: workspace terminology/state/filtering and creation/default-folder UI using the target contracts in this plan. Changes must remain buildable after primary contract integration; no edits to shared/preload/main files.

### Primary integration workstream

Owned files:

- `src/shared/ipcSchemas.ts`, `src/shared/types.ts`, and tests
- `src/preload/index.ts` and tests
- `src/main/main.ts` and IPC registration tests
- bootstrap/settings/launcher compatibility
- integration and E2E tests
- documentation updates

The primary agent reviews every branch diff, resolves shared contracts centrally, and runs the combined verification suite.

## 9. Verification Matrix

Unit and contract checks:

- workspace create/rename/select/archive;
- folderless workspace and duplicate names;
- atomic/concurrent persistence and corrupt recovery;
- idempotent legacy migration and duplicate membership resolution;
- cwd-neutral repository scan;
- validator returns canonical header cwd;
- malformed, symlinked, non-JSONL, and outside-session-dir rejection;
- membership required for resume/delete;
- metadata-only remove versus file delete;
- attachment base path follows session cwd;
- renderer filters solely by workspace ID and preserves hidden drafts/runtimes.

E2E scenarios:

1. Upgrade existing `projects.json`; verify workspace/session grouping survives restart.
2. Create a workspace without a folder; verify no Pi worker starts.
3. Create its first session, select folder A, send, and persist membership.
4. Add/resume a session from folder B in the same workspace.
5. Switch workspaces while work is active and return through Active work.
6. Move an idle session to another workspace without changing JSONL.
7. Archive a workspace and verify its JSONL files remain.
8. Delete all workspace sessions and verify only that workspace's explicit members are affected.

Required commands after integration:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Real-Pi manual smoke:

- two working folders with different `.pi` configuration;
- models/resources resolve from each session cwd;
- both sessions remain grouped in one workspace across restart;
- no session or attachment leaks across workspace selection.

## 10. Completion Criteria

The feature is complete when a user can create a named folderless workspace, create or import sessions from multiple working folders, switch away and back without losing or stopping active work, restart Pi Deck and retain grouping, and safely remove/archive grouping metadata without altering Pi-native session files.
