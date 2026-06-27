# Pi Deck Requirements (Personal MVP Draft v0.4)

## 1. Purpose

Build a **local desktop GUI** for using Pi as a coding agent without starting Pi's terminal/TUI interface. The app is for personal daily use first: fast prompting, easy model switching, visible multi-session state, concurrent background sessions, session resume, slash commands, project memories/skills, and simple sidebar state indicators.

This app is **not intended to replace an IDE/editor**. The user will continue using their preferred editor for code navigation and editing. The GUI's job is to act as a **local Pi agent harness framework**: orchestrate, monitor, and interact with one or more Pi agents better than a set of terminal windows.

## 2. Product Principles

1. **GUI-first**: this is a real graphical application, not a TUI, terminal wrapper, or terminal-themed variation.
2. **Harness-first**: the app is a control plane for Pi agents: launch, observe, steer, resume, and manage sessions.
3. **Pi-native**: reuse Pi's native sessions, models, thinking levels, slash commands, skills, prompt templates, project markdown files, and memories.
4. **No Pi TUI required**: the GUI should launch/control Pi through SDK or RPC directly.
5. **Local-only**: run on the local machine without a remote GUI backend/server or app sync. Pi/model-provider calls still receive prompts/context according to normal Pi behavior when the user sends agent work.
6. **Simple controls over fancy workflows**: MVP should prioritize obvious buttons and visible state over keyboard shortcuts, drag/drop, or power-user attachment mechanisms.
7. **Multi-session awareness**: if multiple agents/sessions are active, their state must be obvious.
8. **Concurrent agent work**: the GUI should allow multiple Pi sessions to keep running in the background while the user is typing or working in the current session.
9. **Separation from editing**: source-code editing remains in the user's IDE/editor; this app coordinates the agent harness around that workflow.
10. **Fast intervention**: after sending a prompt, the user should be able to steer or interrupt the agent quickly.
11. **Low-friction daily use**: opening the app should make it easy to resume previous work immediately.

## 3. Primary User

Personal-use developer who already uses Pi and wants a better GUI workflow than the terminal:

- Works across multiple projects and sessions.
- Wants to resume past sessions from a sidebar.
- Wants prompts with text, files, and images.
- Wants fast model/thinking-level switching.
- Wants visibility into which agents are idle, working, or waiting.
- Wants multiple agents running at once without opening multiple terminals.
- Does not want the GUI to become a full IDE/editor.

## 4. Product Framing: Local Agent Harness

The GUI should be thought of as a **local harness framework for Pi agents**, not as a code editor or IDE replacement.

It should provide:

- Agent/session lifecycle management.
- Concurrent background agent execution.
- Prompt, file, and image input routing.
- Session state tracking through visible sidebar indicators.
- Model/thinking-level control.
- Slash-command and skill access.
- Tool-call and output observability.
- Steering, follow-up, and abort controls.

It should intentionally avoid becoming:

- A full IDE.
- A source-code editor.
- A terminal multiplexer clone.
- A remote/cloud agent platform.

## 5. Core Requirements

### R1. Local GUI App

- The app must run locally on the user's machine.
- MVP target platform is **macOS only**.
- No remote backend/server dependency.
- The app should directly start/manage Pi sessions through Pi SDK or `pi --mode rpc`; the initial MVP architecture uses the user-installed `pi --mode rpc` CLI.
- The user should not need to start Pi TUI manually.

### R2. Prompt Input: Text, Files, Images

The composer must support:

- Plain text prompts.
- Multi-line text.
- A visible **+** button for attachments.
- Clicking **+** opens the native macOS Finder file picker.
- The file picker supports selecting one or more files.
- Selected files are shown clearly before sending.
- Non-image files are presented in the GUI as selected file context, but for MVP they are sent as **referenced paths**, not guaranteed inlined file contents. UI labels must make this clear, e.g. `Referenced path`.
- The GUI should not impose a low arbitrary product-level file-size limit in MVP; attachment limits should generally be whatever Pi/model/backend support allows. The GUI may still enforce crash-prevention safety guards for files/images that would risk app OOM or instability.
- Image files selected through the same **+** button are sent as image inputs when the selected model supports image input.
- If the selected model does not support images, the GUI should warn before sending image attachments.

Out of scope for MVP:

- `@file` fuzzy search.
- Drag-and-drop attachments.
- Special paste-to-attach behavior.
- Multiple competing ways to attach files.

### R3. Model and Thinking-Level Switching

The UI must make model controls highly accessible:

- Current provider/model visible at all times.
- Current thinking level visible at all times.
- Quick model switcher.
- Quick thinking-level switcher.
- Show model capabilities, especially:
  - image support,
  - reasoning/thinking support,
  - context window if available.

### R4. Sidebar of Past Sessions

The app must have a session sidebar showing past sessions.

Required sidebar behavior:

- List previous sessions for the current project.
- Ideally also support all/recent sessions across projects later.
- Show session name/title, project, last updated time, and state.
- Clicking a session resumes it directly.
- Resumed session should pick up where it left off.
- User can create a new session from the sidebar/header.

Session state indicators:

- Idle.
- Working/running.
- Waiting for user input.
- Error.
- Compacting/retrying.
- Queued messages present.

### R5. Slash Commands

Pi slash commands exposed by RPC must work in the GUI.

Required:

- User can type `/` commands in the prompt box.
- GUI can list available commands returned by Pi RPC `get_commands`, including:
  - extension commands,
  - prompt templates,
  - skills such as `/skill:name`.
- GUI should provide a simple command list/picker for those commands.
- Invoking supported slash commands should go through Pi, not a separate reimplementation.
- TUI-only built-in commands such as `/settings`, `/hotkeys`, and TUI screens are not required as slash commands in the GUI MVP. GUI-native equivalents should be buttons/menus where needed.

### R6. Concurrent Multi-Session Tracking

The GUI should support multiple active Pi sessions without requiring multiple terminal windows.

MVP requirement:

- Multiple sessions can exist in the sidebar.
- User can switch between sessions.
- Multiple sessions can run concurrently in the background.
- Each actively running session is expected to map to its own Pi process/RPC worker, similar to opening multiple terminal Pi instances.
- The current session remains usable while other sessions continue running.
- User can type a prompt for the current session while background sessions are working.
- The maximum number of concurrently running sessions is user-configurable, with a hard safety cap of **20**.
- Each active session maintains its own stream/events/state.
- Sidebar clearly shows which sessions are idle, working, waiting for input, errored, compacting, or retrying.
- The sidebar shows clear state indicators for background sessions. A session that needs user input should show a **red dot** next to that session.

Important behavior:

- Switching away from a running session must not stop it.
- Background sessions should continue receiving events.
- A background session that needs extension UI input should show a red dot in the sidebar and should not silently block unnoticed.
- The app should not automatically switch to a session that needs input; the user can click the red-dot session when ready.

### R7. Session State Indicators

The app should surface state changes in the session sidebar without requiring the user to watch every chat constantly.

Required states/events:

- Agent started working.
- Agent is streaming text.
- Tool is running.
- Agent is idle/done.
- Agent needs user input via extension UI request.
- Error occurred.
- Retry started/finished.
- Compaction started/finished.
- Queued steering/follow-up messages changed.

Indicator behavior:

- Use simple visible indicators in the session sidebar.
- A **red dot** means the session needs user input.
- Do not auto-switch sessions when input is needed.
- When the user clicks a red-dot session, show the pending input request in that session view.
- Ignore OS notifications and notification-center features for MVP.

### R8. Steering / Interruption UX

After a prompt is sent and the agent is working, the composer should switch to an intervention mode.

Required controls:

- **Steer** button: send an instruction to change direction as soon as Pi can accept steering.
- **Follow-up** button: queue a message to run after current work completes.
- **Abort** button: stop current work.

Important note:

- Pi's native steering currently delivers after the current assistant turn finishes executing tool calls, before the next LLM call. The GUI should present this as fast intervention, while staying faithful to Pi behavior.

Potential UX:

- Primary button changes from `Send` to `Steer` while the agent is working.
- Secondary dropdown offers `Follow-up` and `Abort`.

### R9. Skills, Project Markdown, and Memories

The GUI must use Pi's normal resource-loading behavior so the agent sees the same context it would see in Pi CLI/TUI.

Required:

- Load project-level `AGENTS.md` / `CLAUDE.md` context files.
- Load global context files.
- Load project/user skills.
- Load prompt templates.
- Load enabled extensions where applicable.
- Respect Pi settings and project trust behavior.
- If a project contains resources that may require trust, the GUI should handle it through a simple GUI prompt or clear blocking message. The user should not need to open Pi TUI to proceed for the current run.
- Persistent "remember trust" behavior is post-MVP unless Pi exposes a stable API/contract for writing trust decisions.

The GUI should also display resource information, with strict labels:

- `Discovered locally`: context markdown files and project/user resources found by static inspection.
- `Available command from active Pi worker`: commands returned by active Pi RPC `get_commands`.
- `Possibly skipped / trust-gated`: protected project resources that may not be loaded depending on trust.
- Any warnings/errors from resource discovery or worker diagnostics.

MVP does not guarantee a perfect loaded-resource inventory for every resource type because RPC does not expose all loaded context/resource details.

### R10. Tool and Output Visibility

Although not the first focus, the GUI must eventually expose Pi's work clearly.

MVP basics:

- Show assistant messages.
- Show tool calls and results.
- Collapse/expand tool output.
- Show bash command status/output.
- Show edit/write file paths.

Soon after MVP:

- Rich diff view for edits.
- Search in tool output.
- Filter tool messages.

## 6. MVP Scope

The first usable version should include:

1. Local GUI app shell.
2. Project picker / current project.
3. Session sidebar with past sessions for the project.
4. Resume session by clicking it.
5. New session.
6. Chat view with streaming assistant output.
7. Prompt composer with text input.
8. File and image attachment support through a **+** button that opens Finder and allows selecting one or more files.
9. Model switcher.
10. Thinking-level switcher.
11. Slash command support with a simple command list/picker.
12. Session state indicators: idle, working, error, waiting for input.
13. Concurrent background sessions with independent state/event tracking.
14. Steer/follow-up/abort controls while working.
15. Use Pi's resource loading for skills, project markdown files, prompt templates, and settings in the active worker; the resource panel may distinguish statically discovered resources from active-worker observed commands.
16. Local-only operation.

## 7. Explicit Non-Goals for Initial MVP

- Terminal/TUI wrapper.
- Remote server or cloud sync.
- Team collaboration.
- Full IDE replacement.
- Full file editor.
- Replacing the user's preferred code editor.
- Keyboard-shortcut-heavy workflows.
- Drag/drop or multiple advanced attachment methods.
- OS notifications or notification-center features.
- Marketplace/package management.
- Perfect custom UI rendering for every Pi extension.
- Reimplementing Pi internals.

## 8. Architecture Direction

Pi supports two main integration strategies.

### Option A: Pi RPC Subprocess

Spawn Pi with `pi --mode rpc` and communicate using JSONL.

Benefits:

- Does not require launching Pi TUI.
- Process isolation.
- Protocol exposes prompts, streaming events, messages, models, sessions, stats, compaction, slash-command discovery, and extension UI requests.
- Good fit for a GUI backend adapter.

Risks:

- Some TUI-only extension UI features are unavailable.
- Need robust JSONL framing/process lifecycle.
- Need one process per active running session if supporting true concurrency.
- Must manage multiple subprocess lifecycles, event streams, and pending extension UI requests.

### Option B: Pi SDK in Node Backend

Use `@earendil-works/pi-coding-agent` directly.

Benefits:

- Direct access to `AgentSession`, `AgentSessionRuntime`, `SessionManager`, resource loading, settings, and events.
- Better long-term control for concurrent multi-session management.
- Type-safe integration.

Risks:

- More tightly coupled to Pi internals.
- GUI needs a Node backend/sidecar.

### Current Recommendation

Use a **GUI frontend + local Node backend/sidecar** with a clean `PiAdapter` interface.

Initial implementation uses **RPC** because it is explicit and isolated. For concurrent background sessions, the likely RPC design is one Pi RPC subprocess per active running session, similar to one terminal per active Pi agent. The user can configure the concurrent running-session limit, but the app enforces a hard cap of **20**. Keep the adapter boundary clean enough to switch to SDK later if multi-session/runtime control becomes easier that way.

Stack decision for MVP:

- Start simple and optimize for implementation speed over frontend sophistication.
- Prefer **Electron + TypeScript** for the initial MVP because it gives the simplest Node/Pi integration path.
- Avoid complex frontend architecture until the product shape is validated.
- Tauri or other lighter shells can be reconsidered later if app size/performance becomes important.

## 9. UI Style Direction

The frontend should use a familiar modern AI-chat style, closer to **ChatGPT** or **Cursor** than a terminal or IDE clone.

Style goals:

- Clean chat-centered layout.
- Minimal visual noise.
- Session sidebar similar to ChatGPT's conversation list, but with Pi-specific state indicators.
- Composer similar to ChatGPT/Cursor: text box, **+** attachment button, send/steer action button.
- Model/thinking controls should be visible but not dominate the interface.
- Tool calls should appear as compact expandable cards.
- Overall feel should be simple, polished, and practical rather than highly customized.

This is inspiration only; the app should not attempt to exactly clone either product.

## 10. Proposed App Layout

```text
+-------------------------------------------------------------+
| Project / Session title                  Model | Thinking   |
+----------------------+--------------------------------------+
| Sessions             | Chat / Agent Timeline                |
|                      |                                      |
| ● Working Session A  | User prompt                          |
| ○ Idle Session B     | Assistant response                   |
| 🔴 Needs Input C     | Tool call cards / diffs / output     |
|                      |                                      |
| + New Session        |                                      |
+----------------------+--------------------------------------+
| [+] files/images    | prompt box...        [Steer/Send]    |
+-------------------------------------------------------------+
```

## 11. Important Pi Capabilities to Use

From Pi RPC/SDK, the GUI should rely on:

- `prompt` with optional images.
- `steer`.
- `follow_up`.
- `abort`.
- `get_state`.
- `get_messages`.
- `get_available_models`.
- `set_model`.
- `set_thinking_level`.
- `get_commands`.
- `new_session`.
- Resume existing sessions by launching RPC with the selected session file; `switch_session` is not required for the MVP resume path.
- `set_session_name`.
- `get_session_stats`.
- Streaming events:
  - `agent_start`, `agent_end`,
  - `message_update`,
  - `tool_execution_start/update/end`,
  - `queue_update`,
  - `compaction_start/end`,
  - `auto_retry_start/end`,
  - `extension_ui_request`.

## 12. MVP Clarifications and Known Cut Lines

- Non-image file attachments are referenced paths in MVP, not guaranteed inlined content.
- Slash-command support is scoped to RPC-supported commands returned by `get_commands`; TUI-only built-in commands are excluded.
- Resource display distinguishes locally discovered resources from active-worker observed commands and does not guarantee a perfect loaded-resource mirror.
- Persistent project-trust decisions are post-MVP; per-run trust choices are MVP.
- Session listing must support default session storage, app/env overrides, and lightweight static `sessionDir` parsing where safe; unusual or trust-dependent session locations may require user configuration.

## 13. Success Criteria

This personal MVP succeeds if:

1. The app can be launched locally without starting Pi TUI.
2. A project can be opened and prior sessions appear in a sidebar.
3. Clicking a past session resumes it.
4. Text/image/file prompts can be sent, with non-image files accurately labeled as referenced paths.
5. RPC-supported slash commands are usable.
6. Model and thinking level can be changed quickly.
7. Session state is visible, especially for working vs idle vs needs-input.
8. The user can steer/follow-up/abort while the agent is working.
9. Pi skills and project markdown context are loaded normally by active workers when project trust/settings allow.
10. The workflow feels better than using Pi directly in the terminal for daily personal coding.
