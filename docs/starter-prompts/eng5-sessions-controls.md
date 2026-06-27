# Starter Prompt — Eng 5: Sessions / Controls UI

You are Eng 5 on **Pi Deck**, a local macOS Electron + TypeScript GUI for controlling Pi agents. Your ownership is project/session UI and Pi-native control shells: sidebar, project picker, model/thinking controls, slash command picker, and attachment UI shell.

## Read First

Please read these docs before coding:

1. `docs/requirements.md`
2. `docs/technical-architecture.md`
3. `docs/project-task-breakdown.md`
4. `docs/project-tracker.md`
5. `docs/git-worktree-parallel-setup.md`

Focus especially on:

- Requirements R3 Model and Thinking-Level Switching
- Requirements R4 Sidebar of Past Sessions
- Requirements R5 Slash Commands
- Requirements R7 Session State Indicators
- Requirements R8 Steering / Interruption UX
- Architecture §8 State Model, Event Reduction, and Sidebar Priority
- Architecture §12 Model, Thinking, and Slash Commands
- Architecture §11 Prompt Input and Attachments
- Milestone tasks M3.1 UI portions, M4.1-M4.5 UI portions in `docs/project-task-breakdown.md`

## Worktree Requirement

Work only inside your assigned git worktree, expected branch/path:

- Branch: `eng5/sessions-controls`
- Path: `/Users/liusu/pi-deck-worktrees/eng5-sessions-controls`

Before editing, run:

```bash
pwd
git branch --show-current
git status --short
```

Do not modify files in the main checkout or another engineer's worktree. If you are not in your assigned worktree/branch, stop and ask for setup.

## Your Mission

Build frontend UI shells and components for sessions and Pi-native controls, using fake data until backend APIs are available.

You primarily own UI portions of:

- **M3.1** Project picker / recent project UI
- **M3 sidebar/session list UI support**
- **M4.1** Model switcher UI
- **M4.2** Thinking-level switcher UI
- **M4.3** Slash command picker UI
- **M4.4/M4.5** Attachment picker/chip UI for referenced-path files

Coordinate closely with Eng 4 to avoid layout conflicts.

## Required Implementation

### Project Picker / Recent Project UI

- Native picker call should go through preload/backend API when available.
- If backend is not ready, create a mock UI state and stub API shape.
- Show current project in header.
- Show recent project list/empty state.
- Handle invalid/deleted project errors visually.

### Session Sidebar UI

Build sidebar components that can render:

- session title/name,
- project path/name,
- last updated time,
- state indicator,
- queued count badge,
- red dot for `waitingForInput` / `needsUserInput`,
- new session button,
- selected/focused session.

Follow sidebar priority rules from architecture:

1. waiting input red dot
2. error
3. attaching
4. compacting
5. retrying
6. tool running
7. streaming/working
8. queued badge
9. idle
10. exited/unloaded

### Model / Thinking Controls

UI should show current provider/model and thinking level at all times.

Model switcher should be able to display:

- provider/model id,
- image support,
- reasoning/thinking support,
- context window if available,
- unavailable/auth error/zero models state.

Thinking switcher should:

- show selected level,
- handle unsupported/failed state,
- call backend/preload API when available or fake API otherwise.

### Slash Command Picker UI

- Typing `/` in the composer should be able to open a command list/picker, coordinating with Eng 4.
- Commands are only those returned by active Pi worker `get_commands`.
- Copy must not imply TUI-only commands like `/settings` or `/hotkeys` work.
- Selecting a command inserts/sends command text through normal prompt path; do not reimplement command behavior.

### Attachment Picker / Chips UI

- Add visible `+` button shell, coordinating with Eng 4 composer.
- Native file picker must eventually go through backend/preload token API; do not read files directly in renderer.
- Show selected chips clearly.
- Non-image files must be labeled exactly or clearly as `Referenced path`.
- Outside-project path warning UI should exist or be stubbed.
- Deleted/unreadable file error state should exist or be stubbed.

## Acceptance Criteria

Your work is done when:

- Project picker UI exists and can use fake/preload API.
- Sidebar renders all required states and priority order from fake fixtures.
- New session/select session actions have clear UI hooks.
- Model and thinking controls render current values and fake option lists.
- Slash command picker renders fake `get_commands` data and scopes copy correctly.
- Attachment chips show `Referenced path` for non-images.
- Renderer does not read arbitrary files or use Node APIs.
- Components can be wired to real backend later without redesign.

## Non-Goals

Do not implement yet:

- Backend project/session scanning.
- Real `get_available_models` / `set_model` / `get_commands` logic.
- Actual file reading/base64 image processing.
- Scheduler/concurrency backend.
- Extension UI dialogs.
- Tool cards.

## Coordination Points

Coordinate with:

- Eng 4 for shared layout/composer ownership.
- Eng 1 for preload API/security limits.
- Eng 2/3 for eventual backend method shapes.
- Eng 6 for UI fixture/test cases.

## Suggested First Steps

1. Verify worktree/branch.
2. Inspect Eng 1/4 renderer structure if available.
3. Create reusable sidebar state indicator components with fixture data.
4. Create model/thinking control components with fixture data.
5. Create slash command picker component with fixture data.
6. Create attachment chip components and `+` button shell.
7. Add component tests if test setup exists.
8. Update `docs/project-tracker.md` statuses for owned tasks if workflow includes doc updates.

## PR Summary Template

```text
Summary:
- ...

Implemented:
- Project/session UI: ...
- Model/thinking UI: ...
- Slash picker UI: ...
- Attachment chip UI: ...

Frontend/security notes:
- Renderer file access: ...
- Fake/preload API shape: ...

Testing:
- npm run typecheck
- npm test
- manual dev launch

Known follow-ups:
- ...
```
