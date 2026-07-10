# Project-Grouped Sessions P0 Design

Status: implemented for P0 baseline; retained as design record  
Date: 2026-07-07  
Implementation reviewed: 2026-07-10  
Related plan: `docs/project-grouped-sessions-p0-plan.md`

## 1. Design Summary

P0 introduces **Projects** as a Pi Deck-owned grouping layer over Pi-native sessions.

Pi itself does not need to know about Pi Deck projects. Pi Deck persists lightweight metadata that says: “these Pi session files belong to this Pi Deck project.” The Pi session file remains the durable source of truth for the conversation and execution state.

In P0, a project is:

- a local root directory used as the default cwd for new Pi sessions, plus
- an app-owned record of related session files.

This design intentionally avoids changing Pi's session storage format or moving Pi session files.

## 2. Design Principles

1. **Pi Deck owns project grouping**
   - Project membership is an app-level concept.
   - Pi sessions stay Pi-native.

2. **Session files remain canonical for conversation persistence**
   - Pi Deck stores references and display metadata only.
   - If a session file is deleted or unreadable, Pi Deck marks/removes the reference but does not invent replacement session data.

3. **Project membership is explicit first, inferred second**
   - Sessions created/resumed through Pi Deck are explicitly recorded under the active project.
   - Existing Pi sessions can be auto-adopted when their persisted `cwd` matches a project root.

4. **P0 favors simple runtime boundaries**
   - The selected project controls which sessions appear in the sidebar.
   - Runtime/session records carry a project id so events and prompts cannot be routed ambiguously.

5. **No P1 context/resource behavior in P0**
   - Projects do not inject shared prompt context yet.
   - Projects do not manage resources, memories, skills, or templates yet.

## 3. User Model

A user should experience this as:

1. Open Pi Deck.
2. Select or open a project directory.
3. See sessions grouped under that project.
4. Create multiple related sessions in that project.
5. Switch to another project and see a different session group.
6. Switch back and continue the previous project sessions.

The key product behavior is grouping, not new execution semantics.

## 4. Data Model

### 4.1 ProjectRecord

```ts
interface ProjectRecord {
  id: string;
  rootPath: string;
  displayName: string;
  createdAtMs: number;
  updatedAtMs: number;
  lastOpenedAtMs: number;
  archivedAtMs?: number;
}
```

Field notes:

- `id`: P0 should use canonical `rootPath` as the id. This keeps migration and lookup simple.
- `rootPath`: canonical realpath of the local project directory.
- `displayName`: defaults to basename of `rootPath`; can become user-editable later.
- `archivedAtMs`: optional future-friendly field for hiding stale projects without deleting metadata.

### 4.2 ProjectSessionRef

```ts
interface ProjectSessionRef {
  projectId: string;
  sessionFile: string;
  sessionId?: string;
  title?: string;
  addedAtMs: number;
  lastSeenAtMs: number;
  lastKnownUpdatedAtMs?: number;
  missingSinceMs?: number;
}
```

Field notes:

- `projectId`: links the session to a Pi Deck project.
- `sessionFile`: canonical realpath of the Pi JSONL session file.
- `sessionId`: Pi's session id if known.
- `title`: cached display title; refreshed from scans/snapshots when available.
- `missingSinceMs`: lets the UI hide or mark stale references after files disappear.

### 4.3 Runtime project ownership

Runtime metadata should also carry project ownership:

```ts
interface RuntimeProjectBinding {
  runtimeId: string;
  projectId: string;
  sessionFile?: string;
  cwd: string;
}
```

This is not persisted. It is main-process runtime bookkeeping used to prevent cross-project event/prompt confusion.

## 5. Storage Design

Use app-owned storage under a dedicated Pi Deck metadata directory, separate from Electron `userData` and separate from Pi's `~/.pi` data.

Recommended P0 file:

```text
~/.pideck/projects.json
```

For tests/dev isolation, the implementation may allow an environment override such as `PI_DECK_HOME`, but the normal user-facing default should be `~/.pideck`.

Suggested shape:

```json
{
  "version": 1,
  "activeProjectId": "/Users/me/work/my-repo",
  "projects": [
    {
      "id": "/Users/me/work/my-repo",
      "rootPath": "/Users/me/work/my-repo",
      "displayName": "my-repo",
      "createdAtMs": 1760000000000,
      "updatedAtMs": 1760000000000,
      "lastOpenedAtMs": 1760000000000
    }
  ],
  "sessionRefs": [
    {
      "projectId": "/Users/me/work/my-repo",
      "sessionFile": "/Users/me/.pi/agent/sessions/abc.jsonl",
      "sessionId": "abc",
      "title": "Refactor sidebar",
      "addedAtMs": 1760000000000,
      "lastSeenAtMs": 1760000000000,
      "lastKnownUpdatedAtMs": 1760000000000
    }
  ]
}
```

Why one file for P0:

- The metadata is small.
- Session contents are not duplicated.
- It avoids over-designing a directory layout before the feature grows.
- It is easy to version and migrate.

Persist writes atomically where practical: write temp file, then rename.

## 6. Project Repository Responsibilities

Add a main-process `ProjectRepository` or equivalent service.

Responsibilities:

1. Load and validate `projects.json`.
2. Recover to empty defaults on missing file.
3. Backup corrupt metadata before replacing with defaults.
4. Canonicalize directory paths before project creation/selection.
5. Upsert project records by canonical root path.
6. Persist active project id.
7. Add/update session refs.
8. Mark session refs missing when files disappear.
9. Return recent projects sorted by `lastOpenedAtMs`.
10. Return project-scoped session refs.

This service should live in Electron main. Renderer should not own durable project state.

## 7. IPC Design

### 7.1 Project IPC

Add project APIs:

```ts
projects.list(): Promise<ProjectListResult>
projects.getActive(): Promise<ProjectActiveResult>
projects.pickProject(): Promise<PickProjectResult>
projects.select(request: { projectId: string }): Promise<ProjectActiveResult>
```

Possible result shapes:

```ts
interface ProjectListResult {
  activeProjectId?: string;
  projects: ProjectRecord[];
}

interface ProjectActiveResult {
  project?: ProjectRecord;
}
```

Existing `projects.pickProject()` can be evolved to create/upsert and select a project in the repository.

### 7.2 Chat IPC

Chat APIs should accept optional `projectId`:

```ts
chat.listSessions(request?: { projectId?: string })
chat.createSession(request?: { projectId?: string })
chat.resumeSession(request: { projectId?: string; sessionFile: string })
chat.deleteSession(request: { projectId?: string; sessionFile: string })
chat.deleteAllSessions(request?: { projectId?: string })
```

Compatibility rule:

- If `projectId` is omitted, use the active project.
- This keeps the migration from current renderer code incremental.

## 8. Session Membership Flow

### 8.1 Creating a new session

1. Resolve active project.
2. Spawn Pi worker with `cwd = project.rootPath`.
3. Call `get_state`.
4. When `state.sessionFile` is known:
   - canonicalize session file path,
   - create/update `ProjectSessionRef`,
   - bind runtime id to project id and session file.
5. Return snapshot to renderer.

If Pi does not report `sessionFile` immediately, keep the runtime bound to project id and update membership when a later snapshot/event exposes the session file.

### 8.2 Resuming a project session

1. Resolve target project from request or active project.
2. Canonicalize requested `sessionFile`.
3. If session is already attached, reuse existing runtime.
4. If no explicit `ProjectSessionRef` exists:
   - allow resume only if parsed session `cwd` matches `project.rootPath`, or
   - require the session was selected from that project's scanned list.
5. Spawn `pi --mode rpc --session <sessionFile>`.
6. Verify returned `get_state.sessionFile` equals requested canonical file.
7. Upsert `ProjectSessionRef` under the project.
8. Bind runtime to project id.

### 8.3 Auto-adopting existing sessions

When listing sessions for a project:

1. Scan Pi's authoritative session dir as today.
2. Parse summaries.
3. Include sessions where parsed `cwd` canonicalizes to `project.rootPath`.
4. For matching sessions, upsert `ProjectSessionRef` with source metadata.

This gives users immediate grouping for old Pi sessions without requiring manual import.

### 8.4 Deleting sessions

Delete should remain project-scoped:

- `deleteSession(projectId, sessionFile)` verifies the session belongs to that project or has matching cwd.
- `deleteAllSessions(projectId)` only deletes sessions visible in that project group.
- Attached runtimes are closed before deleting their session files, as current behavior already does.

## 9. Session Listing Merge Algorithm

Inputs:

- `ProjectRecord`
- persisted `ProjectSessionRef[]`
- scanned `ChatSessionSummary[]` from Pi session dir
- attached runtime locks

Algorithm:

1. Build map by canonical `sessionFile`.
2. Insert persisted refs for the project.
3. Insert/merge scanned sessions whose `cwd === project.rootPath`.
4. For merged scanned sessions:
   - prefer scanned title/update/message counts over cached metadata,
   - update `lastSeenAtMs`,
   - clear `missingSinceMs`.
5. For persisted refs not found in scan:
   - if file still exists, summarize directly or show cached metadata,
   - if missing, mark missing and hide from default list or show as stale depending UI choice.
6. Add `attachedRuntimeId` if locked.
7. Sort by updated time descending.

P0 recommendation: hide missing refs from the main list and surface a diagnostic count rather than adding noisy stale rows.

## 10. Active Project and Runtime Rules

### 10.1 Active project

There is one active project for P0.

- Sidebar shows sessions for active project only.
- New sessions are created in active project only.
- Composer sends to selected session, which must belong to active project.

### 10.2 Runtime safety

Maintain maps like:

```ts
runtimeId -> projectId
runtimeId -> sessionFile
sessionFile -> runtimeId
```

Before prompt/model/thinking/abort operations:

1. Resolve runtime id.
2. Confirm runtime belongs to active/requested project.
3. Reject with clear error if it does not.

This is the primary guard against cross-project mistakes.

### 10.3 Project switching

P0 recommended behavior:

1. If workers in old project are running, prompt user:
   - cancel switch,
   - or abort/close old project workers and switch.
2. If workers are idle, close them and switch.
3. Select new project.
4. Refresh project-scoped session list.
5. Do not auto-show sessions from old project.

This keeps P0 simple. Multi-project background execution can be designed later.

## 11. Renderer UX Design

P0 renderer changes:

1. Header shows active project name/path.
2. Project switcher uses main-process project list.
3. `Open project…` creates/selects a project.
4. Recent projects come from main process, not `localStorage`.
5. Sidebar title should read like `Sessions in <project>`.
6. Empty state: `No sessions in this project yet.`
7. `+ New session` creates a session in the active project.
8. Saved session rows do not show sessions from other projects.

Avoid adding a large “project dashboard” for P0. The feature is session grouping.

## 12. Migration

Startup migration:

1. Load existing app settings.
2. If `settings.projectCwd` exists:
   - canonicalize it,
   - upsert project record,
   - set it active.
3. If no project exists:
   - use `PI_DECK_PROJECT_CWD` or current process cwd as an initial project in real mode, matching current behavior.
4. Store project metadata in `~/.pideck/projects.json` by default.
5. Renderer `localStorage` recent projects can be ignored for P0 unless preserving that list is important.

No Pi session files are edited, moved, or deleted during migration.

## 13. Error Handling

Important cases:

- Project root no longer exists:
  - keep project record,
  - mark as invalid in project list,
  - block selection until path is restored or reopened.

- Session file missing:
  - mark ref missing,
  - hide from default session list,
  - record diagnostic.

- Session cwd differs from project root:
  - do not auto-adopt,
  - block resume from that project unless user explicitly reassigns in a future feature.

- Symlinked project path:
  - canonicalize to realpath so one physical repo does not appear as multiple projects by accident.

- Moved project directory:
  - P0 treats moved path as a different project unless a future “relocate project” action is added.

## 14. Testing Strategy

### Unit tests

- Project repository initializes empty state.
- Upserting same canonical path does not duplicate projects.
- Active project persists.
- Session refs upsert by `(projectId, sessionFile)`.
- Missing/corrupt `projects.json` recovery.
- Merge scanned sessions with explicit refs.
- Auto-adopt matching cwd sessions.
- Do not auto-adopt different cwd sessions.

### IPC/main tests

- `pickProject` creates/selects project.
- `selectProject` switches active project.
- `chat.createSession` uses selected project's root path.
- `chat.listSessions` returns only active project sessions.
- `chat.resumeSession` records membership.
- `chat.deleteAllSessions` stays project-scoped.

### E2E fake-Pi tests

- Project A create/prompt appears under A.
- Switch to Project B; A session is hidden.
- Create/prompt in B; B session is visible under B.
- Switch back to A; A session is resumable.
- Restart app; active project and grouped sessions persist.

### Real Pi manual validation

- Existing sessions for repo root are auto-adopted.
- Newly created sessions remain grouped after restart.
- Switching between two repos does not leak sidebar sessions.
- Deleting all sessions in one project does not delete sessions from another project.

## 15. Explicit Non-Goals for P0

- Project-level prompt context.
- Resource attachment library.
- Session reassignment between projects.
- Project rename/relocation flow.
- Multi-root projects.
- Cross-project background workers.
- Pi-side changes.

## 16. Approval Checklist

Implementation baseline confirms:

- [x] Project ids can be canonical root paths for P0.
- [x] Pi Deck owns grouping metadata; Pi remains unaware.
- [x] Existing sessions are auto-adopted by matching `cwd`.
- [x] Main process owns durable project state.
- [x] Renderer `localStorage` recent projects can be replaced/ignored.
- [x] P0 can close old-project workers on project switch.
- [x] Missing session refs are hidden with diagnostics rather than noisy stale rows.

Remaining post-P0 polish: richer diagnostics around stale refs and a future relocate/rename flow for moved projects.
