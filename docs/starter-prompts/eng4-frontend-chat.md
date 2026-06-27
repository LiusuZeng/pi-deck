# Starter Prompt — Eng 4: Frontend Chat / Composer

You are Eng 4 on **Pi Deck**, a local macOS Electron + TypeScript GUI for controlling Pi agents. Your ownership is the initial renderer shell, chat timeline, and composer UX.

## Read First

Please read these docs before coding:

1. `docs/requirements.md`
2. `docs/technical-architecture.md`
3. `docs/project-task-breakdown.md`
4. `docs/project-tracker.md`
5. `docs/git-worktree-parallel-setup.md`

Focus especially on:

- Requirements §9 UI Style Direction
- Requirements §10 Proposed App Layout
- Architecture §16 Tool and Output Visibility
- Architecture §17 Electron Security and IPC Validation
- Milestone tasks M1.6, M2.4, M2.5 in `docs/project-task-breakdown.md`
- Tracker rows M1.6, M2.4, M2.5 in `docs/project-tracker.md`

## Worktree Requirement

Work only inside your assigned git worktree, expected branch/path:

- Branch: `eng4/frontend-chat`
- Path: `/Users/liusu/pi-deck-worktrees/eng4-frontend-chat`

Before editing, run:

```bash
pwd
git branch --show-current
git status --short
```

Do not modify files in the main checkout or another engineer's worktree. If you are not in your assigned worktree/branch, stop and ask for setup.

## Your Mission

Build the first usable renderer shell for Pi Deck.

You own:

- **M1.6** Basic layout shell
- **M2.4** Basic chat timeline rendering
- **M2.5** Composer prompt and abort UX

Use fake IPC/fake RPC fixtures if real backend is not ready. Do not add Node/fs access to renderer.

## Required Implementation

### M1.6 — Basic Layout Shell

Build a clean app layout:

```text
+-------------------------------------------------------------+
| Project / Session title                  Model | Thinking   |
+----------------------+--------------------------------------+
| Sessions             | Chat / Agent Timeline                |
|                      |                                      |
| session list         | messages / timeline                  |
|                      |                                      |
+----------------------+--------------------------------------+
| [+] files/images    | prompt box...        [Send]          |
+-------------------------------------------------------------+
```

Requirements:

- Chat-centered layout, closer to ChatGPT/Cursor than terminal.
- Sidebar area with placeholder sessions/states.
- Header placeholders for project, session title, model, thinking.
- Composer with multiline text box and send button.
- Responsive enough for normal desktop window sizes.
- Empty/loading/error states.

### M2.4 — Basic Chat Timeline Rendering

Render timeline items from fake or backend-provided data:

- User messages as chat bubbles.
- Assistant messages as markdown blocks.
- Streaming assistant updates.
- Diagnostic/error messages.
- Placeholder/collapsed tool-card style if useful, but full tool cards are M7.

Security requirements:

- Markdown must be sanitized.
- Raw unsafe HTML must not execute.
- External links must not navigate inside app; coordinate with Eng 1 for safe link handling.

### M2.5 — Composer Prompt and Abort UX

Implement composer behavior:

- Multiline text input.
- Send action for idle state.
- Abort action visible while working.
- Disable invalid empty sends.
- Show pending/sending/error states.
- Wire to preload API if available; otherwise use fake client that matches planned API.

Do not implement yet:

- steer/follow-up intervention mode beyond placeholders,
- attachment picker,
- slash command picker,
- model/thinking switcher logic,
- extension UI dialogs.

## Acceptance Criteria

Your work is done when:

- App renders the basic Pi Deck layout.
- Chat timeline can render fake user/assistant messages.
- Assistant message can stream incrementally from fake event fixture/client.
- Composer supports multiline input and send.
- Abort button/state is represented and can call fake or real API.
- Markdown rendering is sanitized.
- Renderer does not import Node APIs.
- UI works against fake data while backend lanes are still in progress.

## Non-Goals

Do not implement yet:

- Project picker behavior.
- Real session scanning/resume.
- Model/thinking/slash command behavior.
- Attachments/images.
- Multi-worker concurrency.
- Extension UI.
- Full tool-card rendering.

## Coordination Points

Coordinate with:

- Eng 1 for preload API shape, renderer setup, CSP, link handling.
- Eng 2 for fake RPC event fixtures and chat event shapes.
- Eng 5 for sidebar/session-control UI boundaries.
- Eng 6 for renderer tests.

## Suggested First Steps

1. Verify worktree/branch.
2. Inspect renderer scaffold from Eng 1 if available.
3. Add minimal app shell components.
4. Define local view-model types only if shared types are not available yet.
5. Implement fake chat event stream for UI development.
6. Add sanitized markdown renderer.
7. Wire composer to fake/preload API.
8. Add basic renderer tests if framework exists.
9. Update `docs/project-tracker.md` statuses for owned tasks if workflow includes doc updates.

## PR Summary Template

```text
Summary:
- ...

Implemented:
- M1.6 ...
- M2.4 ...
- M2.5 ...

Frontend notes:
- Layout: ...
- Timeline model: ...
- Markdown sanitization: ...

Testing:
- npm run typecheck
- npm test
- manual dev launch

Known follow-ups:
- ...
```
