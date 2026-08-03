# Workspace-Grouped Sessions Execution Plan

Status: implemented and verified
Date: 2026-08-02  
Supersedes for new work: `project-grouped-sessions-p0-plan.md`  
Compatibility baseline: existing directory-backed Projects remain readable during migration

## 1. Outcome

Introduce a first-class **Workspace** that groups related Pi sessions by user intent rather than by filesystem directory.

The product vocabulary is:

- **Workspace**: a durable, user-named container for related sessions.
- **Managed runtime context**: an app-owned internal directory used only because
  the Pi process requires an OS `cwd`; it is not workspace identity and is not
  selected by the user.
- **Session**: one Pi-native conversation assigned to exactly one workspace.
  Imported/legacy sessions retain their recorded `cwd`; new general sessions
  use the managed runtime context.

A workspace has no required filesystem directory. Compatibility data may retain
an old project/default reference, but creating or using a new workspace never
asks for a folder. Pi session JSONL files remain authoritative for conversation
history and are never moved or rewritten by this feature.

## 2. Non-Negotiable Invariants

1. Workspace IDs are opaque UUIDs and never filesystem paths.
2. A canonical `sessionFile` belongs to at most one workspace in the first release.
3. Workspace membership is explicit and app-owned; cwd inference is used only for migration/import suggestions.
4. Pi still launches in a concrete cwd as an internal implementation detail:
   - new general session: Pi Deck's managed runtime context below `PI_DECK_HOME`;
   - migrated session with an explicit compatibility project: that validated project;
   - resumed/imported session in a folderless workspace: managed runtime
     context; directory-backed compatibility session: validated header cwd.
     No new-workspace flow opens a folder picker or persists a workspace default.
5. Workspace archive/removal never deletes Pi session files.
6. Removing a session from a workspace is distinct from deleting the Pi session from disk.
7. Renderer-supplied IDs and paths are never filesystem authority. Main resolves stored records and revalidates files immediately before resume/delete.
8. Model/thinking discovery for a general draft uses the managed runtime context.
   Imported/legacy sessions continue using configuration from their recorded cwd.
9. Switching workspaces is a view transaction. Attached workers in other workspaces remain addressable and visible in cross-workspace active work.
10. The existing fake backend remains functional while the real backend gains workspace semantics.

## 3. Target Data Model

Workspace metadata is additive and stored in `~/.pideck/workspaces.json` (or `PI_DECK_HOME/workspaces.json` in isolated environments).

```ts
interface WorkspaceRecord {
  id: string;
  name: string;
  defaultProjectId?: string; // compatibility-only for migrated directory-backed projects
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
  archivedAtMs?: number;
  /** Set only when a workspace archive cascaded to this session. */
  archivedByWorkspaceId?: string;
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
workspaces.restore({ workspaceId }): Promise<WorkspaceListResult>
```

Names are trimmed, whitespace-normalized, and limited to 120 characters. Duplicate names are allowed; identity is the UUID.

### 4.2 Workspace membership

```ts
workspaces.addSession({ workspaceId, sessionFile }): Promise<WorkspaceSessionMutationResult>
workspaces.moveSession({ sessionFile, toWorkspaceId }): Promise<WorkspaceSessionMutationResult>
workspaces.removeSession({ workspaceId, sessionFile }): Promise<WorkspaceSessionMutationResult>
workspaces.archiveSession({ workspaceId, sessionFile }): Promise<WorkspaceSessionMutationResult>
workspaces.restoreSession({ workspaceId, sessionFile }): Promise<WorkspaceSessionMutationResult>
workspaces.listUnassignedSessions(): Promise<ChatListSessionsResult>
```

Adding/importing validates that the file is a regular Pi `.jsonl` session below the configured session directory and reads its canonical header cwd. Main rejects mutations while an attached runtime owns the file; the renderer closes an idle runtime internally before retrying the mutation.

### 4.3 Chat lifecycle

```ts
chat.listSessions({ workspaceId? })
chat.createSession({ workspaceId?, projectId? })
chat.resumeSession({ workspaceId?, sessionFile })
chat.deleteSession({ workspaceId?, sessionFile })
chat.deleteAllSessions({ workspaceId? })
chat.listModels({ runtimeId?, workspaceId?, projectId? })
```

During one compatibility release, omitted `workspaceId` resolves from the active workspace, while legacy `projectId` calls translate through `legacyProjectId`. New snapshots include `workspaceId`; deprecated `projectId` remains available until the renderer migration is complete.

For a folder-independent draft, model discovery receives `workspaceId` and main
resolves the managed runtime context. For an attached runtime, `runtimeId` is
authoritative. A compatibility `projectId` may override the managed context only
for migrated/explicit directory-backed sessions.

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

Explicit workspace refs are refreshed from their individual Pi JSONL files
before returning them; this repairs a filename-like cached title after a crash
or process exit without scanning the entire session repository.

Do not scan all sessions on every workspace switch. A cwd-neutral full scan is reserved for explicit refresh/import and the unassigned view.

### 5.5 Create and resume

New session:

1. Resolve workspace.
2. Resolve an explicit compatibility project when present; otherwise create and
   revalidate Pi Deck's managed runtime context below `PI_DECK_HOME`.
3. Resolve Pi configuration in that execution context and start the worker.
4. Bind runtime to `{ workspaceId, projectId?, cwd }` without changing workspace metadata.
5. As soon as `get_state` reports `sessionFile`, persist membership even when there are zero messages and no title.

Resume:

1. Resolve workspace and exact stored membership.
2. Revalidate session file and obtain header cwd.
3. For a folderless workspace, use the revalidated managed runtime context;
   for a directory-backed compatibility workspace, resolve the registered cwd.
4. Start `pi --mode rpc --session <file>` with the selected execution cwd.
5. Verify Pi returns the requested canonical session file.
6. Bind runtime to the owning workspace and actual cwd.

### 5.6 Delete semantics

- **Remove from workspace** removes metadata only.
- **Delete session** closes its runtime, moves/removes the JSONL file, then removes membership.
- **Delete all in workspace** iterates only explicit workspace members and returns the exact successfully deleted subset.
- **Archive workspace** is a reversible metadata operation. It archives every
  active session membership in the workspace in the same transaction, without
  touching Pi JSONL files. Sessions already archived independently retain that
  state. Restoring the workspace restores only memberships archived by that
  workspace cascade; independently archived sessions remain archived.
- **Archive session** hides one membership without deleting its Pi JSONL file;
  restore reverses that metadata change.
- Runtime processes are an implementation detail. Idle runtimes are closed as
  part of membership/archive operations when safe; users should not need to
  manage a separate “close runtime” lifecycle control.

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
- rename and archive actions;
- no folder requirement, folder picker, or `No default folder` warning.

New session behavior:

- immediately discover model/thinking defaults through the workspace-managed context;
- send the first prompt without a native folder picker;
- leave workspace metadata independent of the managed runtime directory;
- preserve recorded cwd when importing or resuming an existing session.

Session actions add:

- **Move to workspace…**;
- **Remove from workspace**;
- **Archive session…** / **Restore session**;
- existing destructive **Delete session** remains visually and textually distinct.

An explicit **Add existing session…** / **Unassigned sessions** flow replaces silent cwd-based adoption after migration.

### 6.4 Directory-sensitive UI

- Attachment selection and dropped-file relative paths use the selected session's
  recorded cwd or the managed runtime context for a new general draft.
- Draft model discovery starts immediately through `workspaceId`.
- Runtime model/command/image capabilities continue using `runtimeId`.
- A workspace has no required default-folder state.

### 6.5 Sidebar navigation and the default bucket

The sidebar is the primary grouping navigator:

- open workspaces render as expandable folder rows;
- saved, draft, attached, and attention sessions render as children of their
  owning workspace;
- clicking the workspace name selects it; its chevron only expands or collapses
  the row;
- **New session** and **New workspace** are available without leaving the tree;
- rename/archive actions live in each named workspace row, so the header does
  not duplicate workspace navigation.

The app creates one built-in **Default workspace** automatically. It is a
durable metadata bucket under `~/.pi-deck`, has no working-folder mapping, and
is selected on a fresh launch so a user can start a session without first
creating or choosing a workspace. Existing ungrouped Pi files can be imported
there without changing their JSONL contents; moving one into a named workspace
is an explicit metadata action. Keep the default bucket non-renamable and
non-archivable, and avoid using the word “project” for this concept. Archived
workspaces and sessions are available from a dedicated archived section so
archive remains reversible without cluttering the active tree.

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
- directory-independent workspace and duplicate names;
- managed runtime context containment and symlink rejection;
- folder-independent model/thinking discovery;
- atomic/concurrent persistence and corrupt recovery;
- idempotent legacy migration and duplicate membership resolution;
- cwd-neutral repository scan;
- validator returns canonical header cwd;
- malformed, symlinked, non-JSONL, and outside-session-dir rejection;
- membership required for resume/delete;
- metadata-only remove versus file delete;
- reversible session archive/restore and workspace cascade archive/restore;
- idle runtime metadata flush before internal shutdown and busy-runtime close rejection;
- attachment base path follows session cwd;
- renderer filters solely by workspace ID and preserves hidden drafts/runtimes.

E2E scenarios:

1. Upgrade existing `projects.json`; verify workspace/session grouping survives restart.
2. Create a workspace without a folder; verify no Pi worker starts.
3. Send its first prompt without a picker; verify the managed cwd is below
   `PI_DECK_HOME/runtime-context`, model/thinking defaults are visible, and the
   workspace still has no default project.
4. Add/resume an imported session with its recorded cwd in the same workspace.
5. Switch workspaces while work is active and return through Active work.
6. Move an idle session to another workspace without changing JSONL.
7. Archive a workspace and verify its JSONL files remain.
8. Restore a workspace and verify only cascade-archived sessions return; independently archived sessions remain hidden.
9. Delete all workspace sessions and verify only that workspace's explicit members are affected.

Required commands after integration:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Current verification: `npm run typecheck`, `npm test` (261 tests), `npm run format`,
`npm run build`, and the full Electron E2E suite (32 passed, 3 intentionally
skipped in the headless environment).

Real-Pi manual smoke:

- a new general session uses global Pi configuration from the managed context;
- an imported session continues resolving configuration from its recorded cwd;
- both sessions remain grouped in one workspace across restart;
- no session or attachment leaks across workspace selection.

## 10. Completion Criteria

The feature is complete when a user can create a named workspace and send its
first prompt without choosing a filesystem directory, while Pi runs in an
app-managed context; import sessions with their own recorded cwd; switch away
and back without losing or stopping active work; restart Pi Deck and retain
grouping; and safely remove/archive grouping metadata without altering Pi-native
session files.
