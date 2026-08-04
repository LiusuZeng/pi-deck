# Activity Inbox: Tagged Filtering Integration Plan

Status: proposed implementation plan
Date: 2026-08-03
Baseline: `origin/main` (`v0.3.0`, workspace feature complete)

## 1. Outcome

Activity is one operational inbox over all live and recently completed session
work. The global inbox and each workspace inbox are the same view with a
different pre-applied filter:

- **All workspaces**: no workspace filter; aggregate activity across every
  non-archived workspace.
- **Workspace Activity**: apply `workspace:<workspaceId>` to the same feed.
- **Status filters**: apply `status:<kind>` to the same feed.

This avoids separate global/workspace implementations. Rendering, counts,
empty states, navigation, and future filters all operate on one normalized
activity model.

The feature remains renderer-derived in the first release. Workspace metadata
and membership are owned by the main-process workspace store; runtime state is
owned by the existing session/runtime projection. Activity combines those
inputs and does not create a second persistence layer.

## 2. Product behavior

### 2.1 Entry points and scopes

1. The global sidebar **Activity** action opens `ActivityScope = { type:
   "all" }`.
2. A workspace row/header **Activity** action opens the same screen with
   `ActivityScope = { type: "workspace", workspaceId }`.
3. The global screen can select a workspace filter. Selecting a workspace from
   the tree while in a workspace-scoped inbox changes the scope to the newly
   selected workspace. The global scope remains global when the user is merely
   browsing the tree.
4. Clearing the workspace filter returns to the all-workspaces view.

The view title/eyebrow must make scope explicit (`Activity` / `Activity ·
<workspace name>`). A workspace name is shown on every global row; it may be
de-emphasized in the workspace-scoped view.

### 2.2 System tags

Tags are a typed projection used for filtering. They are generated from
canonical fields and are not user-editable in this release.

```ts
type ActivityStatus =
  | "needsAttention"
  | "failed"
  | "pending"
  | "inProgress"
  | "completed";

type ActivityTag =
  | `workspace:${string}`
  | `status:${ActivityStatus}`
  | "kind:session"
  | "visibility:archived";
```

Every visible item has exactly one `kind:session` tag and, when classified,
exactly one `status:*` tag. Workspace identity is also retained as a real
`workspaceId` field; the workspace tag is for filtering only. Workspace IDs,
never names or paths, are used in tags.

Status precedence remains explicit and mutually exclusive:

1. `needsAttention`
2. `failed`
3. `pending`
4. `inProgress`
5. `completed`

An idle/saved session with no current-run completion timestamp is omitted from
the inbox. Archived workspace/session memberships are omitted by default and
carry `visibility:archived` when an archived view is eventually added.

### 2.3 Counts and badges

- Filter-chip counts are calculated from the same filtered item set.
- Global sidebar badge = `needsAttention + failed + pending` across all active
  workspaces.
- Workspace tree badge = the same actionable count after applying that
  workspace tag.
- `inProgress` and `completed` remain visible in the inbox but do not increase
  the actionable badge.

### 2.4 Row navigation

Each row carries `{ workspaceId, sessionFile?, sessionId?, runtimeId? }`.

- If the owner workspace is not active, select it through
  `workspaces.select({ workspaceId })` / the existing workspace view
  transaction. Runtime-backed sessions in other workspaces must remain
  retained and addressable.
- If a runtime is already present, select that runtime/session.
- Otherwise resume through
  `chat.resumeSession({ workspaceId, sessionFile })`.
- Activity navigation never invokes a project/folder picker.
- Archived rows are not shown by default. If an archived view is introduced,
  the primary action is restore, followed by normal navigation.

## 3. Data model and boundaries

### 3.1 Normalized source item

Add a renderer-owned source shape that can be produced from both the existing
`SessionViewModel` list and workspace session summaries:

```ts
interface ActivitySourceSession {
  id: string;                 // runtime id or stable saved-session id
  workspaceId: string;
  sessionFile?: string;
  sessionId?: string;
  runtimeId?: string;
  title: string;
  workspaceName: string;
  updatedAtMs: number;
  baseState: BaseSessionState;
  overlays: SessionOverlays;
  status?: SessionStatus;
  completedAtMs?: number;
  lastError?: string;
  archivedAtMs?: number;
}
```

The existing project/path fields may remain on `SessionViewModel` for
compatibility and composer/attachment behavior, but they must not determine
Activity identity, workspace scope, or folder selection.

### 3.2 Normalized activity item

```ts
interface ActivityItem {
  id: string;                 // activity:<workspaceId>:<session key>
  sessionKey: string;         // sessionFile when available, otherwise id
  workspaceId: string;
  workspaceName: string;
  sessionFile?: string;
  sessionId?: string;
  runtimeId?: string;
  status: ActivityStatus;
  tags: readonly ActivityTag[];
  title: string;
  detail: string;
  updatedAtMs: number;
  actionLabel: string;
}
```

Use `workspaceId + sessionFile` for stable saved-session identity. Runtime IDs
are execution handles and may be absent or change after resume. If a saved
session is not yet assigned a file, the source `id` is a temporary key and
must not be persisted.

### 3.3 Filter model

Keep filter semantics small and deterministic:

```ts
type ActivityFilter = {
  includeAll?: readonly ActivityTag[];
  exclude?: readonly ActivityTag[];
};

type ActivityScope =
  | { type: "all" }
  | { type: "workspace"; workspaceId: string };
```

`ActivityScope` translates to a workspace tag. Status chips translate to one
`status:*` tag. Filtering is intersection-based; an item must contain every
`includeAll` tag and none of the excluded tags. Keep filter operations pure and
unit-testable so UI state does not leak into classification.

## 4. Renderer implementation

### 4.1 Domain module

Refactor `src/renderer/activityInbox.ts` into three layers:

1. `classifyActivity(source)` returns the canonical status and detail.
2. `activityTags(source, status)` creates the typed system tags.
3. `buildActivityInbox(sources, filter?)` normalizes, excludes archived items,
   applies the tag filter, sorts each status group by `updatedAtMs`, and
   computes counts/actionable count.

The classifier must retain the current precedence and queue/in-progress detail
logic. Do not encode workspace scope in the classifier.

Recommended exported helpers:

```ts
buildActivityInbox(
  sources: readonly ActivitySourceSession[],
  filter?: ActivityFilter,
): ActivityInboxModel;
tagsForScope(scope: ActivityScope): ActivityFilter;
filterActivityItems(items: readonly ActivityItem[], filter: ActivityFilter):
  ActivityItem[];
```

The model should expose `availableWorkspaceCounts` or a reusable count helper
so the UI can render workspace filter counts without rebuilding ad hoc state.

### 4.2 App state and data assembly

In `src/renderer/App.tsx`:

- Add `activityScope` state and an Activity-visible state if not already
  present.
- Build sources from `sessions`, excluding archived memberships by default,
  and join workspace names from `workspaces`/`archivedWorkspaces`.
- Keep the source list cross-workspace. Do not replace it with only the active
  workspace during workspace switching; the existing retention invariant
  requires hidden runtime sessions to stay available.
- Pass scope/filter state into `ActivityInbox`.
- On row activation, use the existing workspace switch/select helper and then
  select/resume using the row's canonical session identity.
- Global Activity toggle must remain reversible: opening it from the sidebar
  opens the feed; activating the same button closes it and returns to session
  view.

When a workspace list refresh renames a workspace, update the joined display
name in existing sources without changing item identity or tags.

### 4.3 UI component

Refactor `src/renderer/components/ActivityInbox.tsx` to render:

- scope title and optional “All workspaces” / current workspace selector;
- status chips generated from `ACTIVITY_STATUSES` and counts from the model;
- the same grouped rows for both scopes;
- workspace context on global rows;
- accessible empty states that mention the active scope and filter;
- keyboard activation and focus behavior consistent with existing sidebar
  controls.

The component should receive `scope`, `workspaces`, `model`, and callbacks for
scope changes and row activation. It must not call IPC directly.

### 4.4 Workspace navigation affordance

Add one workspace-scoped Activity entry without introducing a second screen:

- preferred: workspace header action or workspace-row context action labelled
  “View activity”;
- optional later: compact actionable badge on each workspace row.

The action calls `onOpenActivity({ type: "workspace", workspaceId })`.

## 5. Main/preload/API impact

No new IPC channel is required for the first implementation. Existing workspace
and chat APIs already provide the needed identity and membership:

- `workspaces.list()` / `getActive()` for workspace names and active/archived
  membership;
- `chat.listSessions({ workspaceId? })` for saved summaries;
- runtime events/status for live state;
- `chat.resumeSession({ workspaceId, sessionFile })` for row activation.

If current bootstrap/listing does not expose a saved session's `workspaceId`,
join the result using the workspace request that produced it. Do not infer it
from `cwd` or `projectPath`. A future durable Activity history would require a
new store, but that is explicitly out of scope here.

## 6. Workstream ownership

The implementation is split into independent persistent worktrees, all based
on this design branch and `origin/main`:

### Domain/tag model

Owner: `src/renderer/activityInbox.ts`, its unit tests, and any small shared
activity types. Implement typed tags, scope filters, canonical status
precedence, archive exclusion, deterministic IDs, and count helpers.

### App/data/navigation integration

Owner: `src/renderer/App.tsx`, `src/renderer/App.test.ts`, and only the
minimal renderer test configuration needed for App tests. Integrate the domain
model, preserve cross-workspace runtime sessions, add scoped Activity state,
and implement row navigation/workspace switching without a folder picker.

### UI/filtering/e2e

Owner: `src/renderer/components/ActivityInbox.tsx`, component tests,
`src/renderer/styles.css`, and Activity-focused e2e coverage. Implement global
and workspace scopes as filters, workspace selector/badges, accessible states,
and visual interaction tests.

Agents must not edit outside their ownership list without coordinating with
the primary agent. The primary agent owns shared contract resolution and final
integration.

## 7. Acceptance tests

Unit/domain:

- all-workspace filter includes items from multiple workspaces;
- workspace filter excludes every other workspace;
- status filters are tag intersections and retain precedence;
- archived memberships are hidden by default;
- IDs remain stable across workspace rename;
- actionable counts are correct per scope.

Renderer/App:

- global Activity can open a session from an inactive workspace;
- opening the row selects the workspace, then selects/resumes the session;
- workspace switching retains runtime-backed sessions in other workspaces;
- workspace-scoped Activity follows the selected workspace;
- toggling Activity returns to session view;
- new/resumed sessions never open a directory picker.

UI/e2e:

- sidebar Activity opens the all-workspaces view;
- workspace “View activity” opens the same view with a workspace filter;
- clearing the filter returns to global Activity;
- status chip counts update within the active workspace scope;
- row labels remain accessible and keyboard-activatable;
- no-activity and no-results copy names the active scope.

## 8. Integration sequence

1. Rebase the existing Activity implementation worktree onto this design
   branch (which is based on finalized `origin/main`) after preserving a
   backup branch.
2. Apply the domain, App, and UI workstream commits in that order.
3. Resolve the shared `ActivityItem`/filter contract centrally; do not let
   component-specific types fork it.
4. Run formatting, renderer typecheck, focused Activity tests, full unit tests,
   build, and full Electron e2e.
5. Keep the design branch and all agent worktrees persistent until the combined
   verification passes. Merge into `main` only after review approval.

## 9. Explicit non-goals

- No user-authored arbitrary tags yet.
- No persisted Activity history or notifications database.
- No new workspace/session IPC solely for Activity.
- No folder/path-derived workspace identity.
- No separate global and workspace Activity components.
- No automatic restore of archived workspaces merely by clicking an archived
  Activity row.
