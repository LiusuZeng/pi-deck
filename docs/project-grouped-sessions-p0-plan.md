# Pi Deck Projects P0 Plan — Grouped Sessions

Status: implemented for P0 baseline; retained as rollout record  
Date: 2026-07-07  
Implementation reviewed: 2026-07-10  
Scope: P0 only — introduce first-class **projects** as grouped Pi sessions. P1 common context/resources are intentionally deferred.

## 1. Goal

Make Pi Deck treat a project as a durable workspace containing related sessions, so the user can work on the same effort across multiple Pi sessions without losing the grouping.

P0 definition:

> A Pi Deck project is a local working directory plus an app-owned grouping of Pi session references for that directory.

This keeps Pi-native session files as the source of truth while adding a Pi Deck project layer that remembers and presents related sessions together.

## 2. Current Repo Baseline

Relevant current behavior:

- `src/shared/ipcSchemas.ts` already has `ProjectRef`, `pickProjectResult`, and `AppSettings.projectCwd`.
- `src/main/main.ts` keeps a single selected real project cwd via `selectedRealProjectCwd` / `settings.projectCwd`.
- `listChatSessions()` scans Pi's configured session directory and filters by session file `cwd`.
- `createSession()` starts a new worker in the selected cwd.
- `resumeSession()` rejects sessions whose persisted `cwd` differs from the current selected cwd.
- Renderer keeps recent projects in `localStorage`, not main-process durable app state.
- Session identity is already based on canonical `sessionFile` when available.

P0 should evolve this from “one current cwd with UI-local recent projects” to “main-process-owned project records with project-scoped session membership.”

## 3. P0 Product Requirements

### In scope

1. Create/open/select Pi Deck projects.
2. Persist project records in app data, not renderer `localStorage`.
3. List sessions grouped under the selected project.
4. Create multiple sessions in the selected project.
5. Resume/delete project sessions without crossing project boundaries.
6. Preserve existing Pi session storage and Pi-native session files.
7. Auto-adopt existing Pi sessions whose persisted `cwd` matches the project root.
8. Show recent/all projects in the UI.
9. Keep project switching deterministic: active workers from the old project are either closed or clearly detached before switching.

### Out of scope for P0

- Shared project context injected into prompts.
- Project resources, memories, skills, prompt templates, or `.pi` resource management.
- Cross-project session moves/copies.
- Nested/multi-root projects.
- Cloud sync/collaboration.
- Reorganizing Pi's native session directory layout.

## 4. Core Concepts

### Project

```ts
interface ProjectRecord {
  id: string; // stable app-owned id, initially canonical root path
  rootPath: string; // canonical cwd used for Pi workers
  displayName: string;
  createdAtMs: number;
  updatedAtMs: number;
  lastOpenedAtMs: number;
  archivedAtMs?: number;
}
```

P0 can use canonical `rootPath` as `id` to simplify migration. If future rename/move support needs path-independent identity, add UUID ids later with migration.

### Project session membership

```ts
interface ProjectSessionRef {
  projectId: string;
  sessionFile: string; // canonical Pi JSONL path
  sessionId?: string;
  title?: string;
  addedAtMs: number;
  lastSeenAtMs: number;
}
```

Membership is app-owned metadata, but it is not the only source of truth:

- Explicit membership: sessions created/resumed through Pi Deck.
- Discovered membership: existing Pi sessions where parsed session `cwd` equals project `rootPath`.
- If metadata and scan disagree, scan wins for availability; metadata helps preserve grouping and ordering.

## 5. Storage Plan

Store project metadata under a dedicated Pi Deck metadata directory, separate from Electron `userData`, app settings, and Pi's own `~/.pi` data.

Recommended P0 file:

```text
~/.pideck/projects.json
```

For tests/dev isolation, an environment override such as `PI_DECK_HOME` may redirect this directory. Recommendation: start with one `projects.json` file unless the implementation is already splitting repositories. The data volume is small because session content remains in Pi session files.

`settings.json` should keep only the active selection pointer, e.g. `activeProjectId` or continue `projectCwd` during migration.

## 6. Main-Process Services

Add a small project repository/service in main process.

Responsibilities:

1. Load and persist project records.
2. Canonicalize project root paths.
3. Create or update a project when a folder is picked.
4. Return all/recent projects.
5. Track active project selection.
6. Add/update session refs when a worker reports `state.sessionFile`.
7. Merge persisted refs with scanned Pi session summaries.
8. Validate that resume/delete operations target the selected project.

Implementation should keep Electron main as source of truth. Renderer receives project snapshots over IPC.

## 7. IPC Contract Changes

Add or evolve IPC around projects:

- `projects:list` → returns recent/all project records.
- `projects:getActive` → returns active project, if any.
- `projects:openFolder` or existing `project:pickFolder` → creates/selects project.
- `projects:select` → selects an existing known project by id.
- Optional P0: `projects:removeFromRecent` / archive.

Update chat IPC to be project-aware:

- `chat:listSessions({ projectId? })`
- `chat:createSession({ projectId? })`
- `chat:resumeSession({ projectId?, sessionFile })`
- `chat:deleteSession({ projectId?, sessionFile })`
- `chat:deleteAllSessions({ projectId? })`

For migration safety, default omitted `projectId` to the active project.

## 8. Session Listing Semantics

When listing project sessions:

1. Resolve active project root.
2. Scan authoritative Pi session dir as today.
3. Filter scanned session files where parsed `cwd === project.rootPath`.
4. Merge with `ProjectSessionRef`s for that project.
5. Drop missing/unreadable session files from visible list, but keep a diagnostic or stale marker if useful.
6. Mark attached sessions with `attachedRuntimeId` as today.
7. Sort by `updatedAtMs` desc.

This means existing sessions become visible automatically when a project is opened, even before Pi Deck has explicit membership metadata for them.

## 9. Worker and Project Switching Rules

P0 should choose simple, safe behavior:

- New sessions always launch with selected project `rootPath` as cwd.
- A runtime belongs to the project whose cwd/session file it was created or resumed from.
- Duplicate open of the same `sessionFile` reuses the attached runtime.
- Switching active project should not silently mix workers from different projects into the selected sidebar.

Recommended P0 switch behavior:

1. If old project has running workers, prompt: cancel switch or abort/close old project workers.
2. If old project workers are idle, close them and switch.
3. After switch, create/attach an initial worker for the new project only if needed by current app startup behavior; otherwise list sessions first.

Future enhancement can allow background workers across multiple projects, but P0 should avoid cross-project UI ambiguity.

## 10. Renderer UX Plan

P0 UI changes:

- Rename header from `Project / Session` to clearer project-first hierarchy.
- Show active project name/path in header.
- Sidebar lists sessions only for active project.
- Add a project switcher/dropdown using main-process project records.
- `Open project…` creates/selects a project and refreshes project sessions.
- `+ New session` creates a session under the active project.
- Empty state: “No sessions in this project yet.”
- Remove renderer `localStorage` as source of truth for recent projects after migration.

Do not add P1 common context/resource UI yet. A small placeholder can say “Shared project context/resources planned for P1” only if it does not imply current behavior.

## 11. Migration Plan

1. On startup, read existing `settings.projectCwd`.
2. If present, create/upsert a project for that canonical cwd.
3. Set it as active project.
4. Import renderer `localStorage` recent projects only if a safe migration path is worth it; otherwise allow recency to rebuild from main-process picks.
5. Continue accepting old IPC calls without `projectId` during transition.

No Pi session files are moved or rewritten.

## 12. Test Plan

Unit tests:

- Project repository load/persist/defaults.
- Canonical path id/upsert behavior.
- Merge project refs with scanned sessions.
- Missing session ref handling.
- Active project selection migration from `projectCwd`.

Main/IPC tests:

- Open/select project persists active project.
- `listSessions` filters by selected project.
- `createSession` uses selected project cwd.
- `resumeSession` rejects session from another project.
- `deleteAllSessions` only affects selected project sessions.

E2E/fake-Pi tests:

- Open project A, create/prompt session, verify listed under A.
- Open project B, verify A session is hidden.
- Switch back to A, verify session is visible/resumable.
- Restart app, active/recent projects and grouped sessions persist.
- Duplicate resume within a project still reuses one runtime.

Manual real-Pi validation:

- Existing real Pi sessions for a cwd auto-appear when opening that project.
- New real sessions survive restart and remain grouped.
- Project switching across two real repos does not leak sessions between sidebars.

## 13. Rollout Phases

### Phase 1 — Contracts and repository — Done

- Define `ProjectRecord` / `ProjectSessionRef` schemas.
- Add main-process project repository.
- Migrate selected cwd into active project metadata.

### Phase 2 — Project-aware chat backend — Done

- Thread active project through session scan/create/resume/delete.
- Record session membership when `sessionFile` becomes known.
- Keep backwards-compatible IPC defaults.

### Phase 3 — Renderer project UX — Done

- Replace renderer-only recent projects with main-owned project list.
- Update project switcher and session empty states.
- Refresh sessions on project selection.

### Phase 4 — Hardening — Done for P0 baseline

- Add restart/switch/resume/delete regression tests.
- Run real-Pi validation with isolated session dirs.
- Document limitations and P1 handoff.

Remaining post-P0 hardening: broader real-Pi manual validation against pre-existing messy session dirs and improved stale-project diagnostics.

## 14. Open Decisions

1. Should project id be canonical root path for P0, or a UUID from day one?
   - Recommendation: canonical root path for P0.
2. Should project switching close idle workers or allow per-project background workers?
   - Recommendation: close old project workers in P0; multi-project background workers later.
3. Should explicit session membership include sessions from the same cwd automatically, or only sessions opened in Pi Deck?
   - Recommendation: auto-adopt matching-cwd sessions on scan.
4. Should recent project migration from renderer `localStorage` be implemented?
   - Recommendation: optional; not required if project opening is quick.

## 15. P1 Handoff

Once P0 grouped sessions is stable, P1 can add project-level assets:

- Shared context snippets.
- Resource files/links.
- Project notes.
- Common prompt templates.
- Optional project-specific `.pi` resource inspection.
- Session-to-project summaries.

P0 should leave clean extension points but not build these features now.
