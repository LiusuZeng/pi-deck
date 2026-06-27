# Pi Deck MVP Project Task Breakdown

Status: implementation planning draft  
Inputs: `docs/requirements.md`, `docs/technical-architecture.md`, `docs/engineering-design-review-notes.md`  
Planning goal: maximize parallel work while forcing risky integration/consensus decisions as early as possible.

## 1. Execution Strategy

Build the MVP as a set of thin vertical slices over stable contracts:

1. **Freeze shared contracts first**: `PiAdapter`, normalized runtime events, typed IPC schemas, timeline item model, session state reducer inputs/outputs, attachment token model.
2. **De-risk Pi integration early**: binary resolution, minimal RPC smoke test, strict JSONL framing, real `pi --mode rpc --session <file>` resume gate.
3. **Develop renderer against fake backend in parallel**: UI teams should not block on real Pi RPC once IPC contracts and fake event fixtures exist.
4. **Keep execution source of truth in Electron main**: renderer is a sandboxed client only.
5. **Use fake RPC for deterministic tests** before relying on real Pi availability.

## 2. Parallel Workstreams

| Workstream | Main ownership | Can start after | Blocks / feeds |
|---|---|---|---|
| WS0 Planning/contracts | Tech lead + all leads | Now | All workstreams |
| WS1 Electron app/security foundation | App/platform | WS0 initial contracts | UI, IPC, packaging |
| WS2 Pi RPC adapter + fake RPC | Backend/integration | WS0 PiAdapter contract | Sessions, chat, models, extension UI |
| WS3 Session repository/resume | Backend | WS0 + EffectivePiConfig draft | Sidebar, resume MVP gate |
| WS4 Renderer shell/chat/sidebar | Frontend | WS0 IPC/UI state contracts | End-to-end UX |
| WS5 State reducer/scheduler/concurrency | Backend + frontend | WS0 runtime event contract | Sidebar indicators, M5 |
| WS6 Model/thinking/slash commands | Backend + frontend | WS2 command/model methods | M4 controls |
| WS7 Attachments/images | Backend + frontend + platform | WS0 attachment contract | M4 attachment MVP |
| WS8 Trust/resources | Backend + frontend | WS3 EffectivePiConfig | M6 resource panel/trust prompt |
| WS9 Extension UI | Backend + frontend | WS2 event handling + WS5 reducer | M6 red-dot behavior |
| WS10 Tool visibility/timeline polish | Frontend + backend | WS2 events + WS4 timeline | M7 |
| WS11 Testing/diagnostics/packaging | QA/platform | WS1 + WS2 fake RPC | Release readiness |

## 3. Early Consensus and Integration Gates

These must happen before broad implementation to avoid rework.

### Gate G0: Contract Freeze for Parallel Development

**Target:** before feature teams begin broad work.

Decisions / artifacts:

- `PiAdapter` TypeScript interface.
- IPC channel list and zod/runtime schemas.
- Runtime event normalization shape.
- Base session state + overlays reducer API.
- Timeline item model for user, assistant, thinking, tool, extension UI, diagnostics.
- Attachment token and send payload model.
- Error/diagnostic envelope shape.

Acceptance criteria:

- All workstream leads sign off on schemas.
- Renderer can be developed against a fake main-process service.
- Backend can be tested without renderer.
- Contract changes after this require explicit migration notes.

### Gate G1: Minimal Pi RPC Health Spike

**Target:** M1, first technical spike.

Acceptance criteria:

- Finder-like environment can resolve `pi` or show actionable diagnostics.
- `pi --version` captured.
- Minimal smoke command runs in temp cwd with full required flags:
  `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline`.
- `get_state` response parsed successfully.
- No session file is created by the smoke test.
- Result cached by binary path/version and visible in diagnostics.

### Gate G2: Resume Compatibility Hard Gate

**Target:** M3, before calling session resume shippable.

Acceptance criteria:

- Given an existing session file, spawning `pi --mode rpc --session <file>` and calling `get_state` returns a `sessionFile` whose canonical path equals the requested file.
- Unsupported versions produce a clear blocking error with binary path/version diagnostics.
- No `switch_session` fallback is implemented for MVP.

### Gate G3: Image Resizing / Packaging Spike

**Target:** before M4 image support ships.

Acceptance criteria:

- Resizing approach chosen, preferably Electron `nativeImage` + pure-JS metadata sniffing unless inadequate.
- macOS arm64/x64 packaging validated.
- Signing/notarization impact understood.
- Large-image memory behavior measured.
- Safety thresholds documented and implemented.

### Gate G4: Extension UI Write/Timeout Semantics

**Target:** before M6.

Acceptance criteria:

- Fake RPC covers foreground dialog, background dialog red dot, timeout + grace, late-response suppression, worker exit before response, stdin write failure.
- Red dot clears only after successful enqueue/write or local timeout cleanup.
- Write failure sets session/request error with diagnostics.

## 4. Milestone Plan and Detailed Tasks

### M1. App Skeleton, Security Boundary, Binary Resolution

Goal: launch a secure Electron app shell and prove low-side-effect Pi RPC availability.

#### M1.1 Repository and Electron/TypeScript scaffold

- **Owner:** App/platform
- **Dependencies:** G0 initial project decisions
- **Tasks:**
  - Initialize Electron + TypeScript project structure.
  - Configure main, preload, renderer build pipeline.
  - Add lint/typecheck/test scripts.
  - Add app `userData` path helpers.
- **Acceptance criteria:**
  - App launches on macOS in dev mode.
  - Main/preload/renderer compile with strict TypeScript.
  - `npm test`, `npm run typecheck`, and lint script exist and pass for scaffold.

#### M1.2 Secure renderer/preload IPC foundation

- **Owner:** App/platform
- **Dependencies:** G0 IPC schema draft
- **Tasks:**
  - Enable `contextIsolation`, `nodeIntegration: false`, sandbox where practical, remote disabled.
  - Implement preload API exposing only typed IPC functions.
  - Add runtime validation for every IPC input/output.
  - Add strict CSP baseline.
- **Acceptance criteria:**
  - Renderer has no direct Node/fs/process access.
  - Invalid IPC payloads are rejected and logged without crashing main.
  - Security settings are covered by an automated smoke test or assertion.

#### M1.3 App-local settings and diagnostics storage

- **Owner:** Backend/platform
- **Dependencies:** M1.1
- **Tasks:**
  - Persist app settings under Electron `userData`.
  - Include Pi binary path, agentDir/sessionDir overrides, max running sessions, warm-worker limit, env-capture preference.
  - Create rolling diagnostics/log directory.
- **Acceptance criteria:**
  - Settings survive app restart.
  - Secrets are redacted in diagnostics previews.
  - Log retention target is implemented or tracked with test coverage.

#### M1.4 Pi binary resolution and version diagnostics

- **Owner:** Backend/integration
- **Dependencies:** M1.3
- **Tasks:**
  - Resolve Pi binary by app setting, inherited PATH, login shell lookup, common paths.
  - Canonicalize with `realpath`.
  - Run `pi --version`.
  - Show path/version/errors in diagnostics.
- **Acceptance criteria:**
  - Works when launched with minimal PATH if `pi` is in common Homebrew path or configured manually.
  - Broken/missing binary produces actionable UI diagnostic.

#### M1.5 Minimal RPC smoke test

- **Owner:** Backend/integration
- **Dependencies:** M1.4, WS2 JSONL starter
- **Tasks:**
  - Spawn minimal no-resource/no-session RPC process in temp cwd.
  - Send `get_state`, parse response, terminate process.
  - Cache result by binary path/version.
- **Acceptance criteria:**
  - Uses full canonical flags from G1.
  - Does not create persisted sessions.
  - Failure marks app unhealthy and shows stderr/exit diagnostics.

#### M1.6 Basic layout shell

- **Owner:** Frontend
- **Dependencies:** M1.2
- **Tasks:**
  - Build static layout: project/header area, session sidebar, chat pane, composer, model/thinking placeholders.
  - Add loading/error/empty states.
- **Acceptance criteria:**
  - Layout matches requirements structure.
  - No real Pi data required; uses mock data over fake IPC.

### M2. Single-Session RPC Adapter and Streaming Chat

Goal: one real Pi worker can start, receive prompts, stream messages, and abort.

#### M2.1 Strict JSONL transport

- **Owner:** Backend/integration
- **Dependencies:** G0 PiAdapter contract
- **Tasks:**
  - Implement LF-delimited JSONL parser without Node `readline`.
  - Support chunk boundaries and embedded Unicode separators inside JSON strings.
  - Maintain request map by command id.
  - Separate responses from async events.
  - Capture stderr per worker.
- **Acceptance criteria:**
  - Unit tests cover chunk splitting, multiple records per chunk, malformed JSON, U+2028/U+2029.
  - Request timeout applies to command response, not long-running agent work after prompt acceptance.

#### M2.2 Fake RPC subprocess/test harness

- **Owner:** Backend/QA
- **Dependencies:** M2.1 contract
- **Tasks:**
  - Build deterministic fake RPC executable/script.
  - Support responses for `get_state`, `get_messages`, `prompt`, `abort`.
  - Emit streaming `agent_start`, `message_update`, `agent_end`, tool/event fixtures later.
- **Acceptance criteria:**
  - Integration tests can run without real Pi.
  - Frontend/dev mode can point to fake backend data for UI work.

#### M2.3 Single PiWorker lifecycle

- **Owner:** Backend/integration
- **Dependencies:** M2.1, M1.5
- **Tasks:**
  - Spawn one real `pi --mode rpc` worker in selected cwd.
  - Implement `get_state`, `get_messages`, `prompt`, `abort`, `closeSession`.
  - Track PID, stderr, exit code, health.
- **Acceptance criteria:**
  - New session starts from a project cwd.
  - `get_state` returns session id/file/model/thinking where available.
  - Unexpected exit is surfaced as error if work was in flight.

#### M2.4 Basic chat timeline rendering

- **Owner:** Frontend
- **Dependencies:** M2.2 fake events, M1.6
- **Tasks:**
  - Render user and assistant messages.
  - Stream assistant updates.
  - Show basic error/diagnostic messages.
- **Acceptance criteria:**
  - Streaming output updates without full page reload.
  - Reopening selected session view renders `get_messages` result.
  - Markdown is sanitized; raw unsafe HTML does not execute.

#### M2.5 Composer prompt and abort UX

- **Owner:** Frontend + backend
- **Dependencies:** M2.3, M2.4
- **Tasks:**
  - Text composer sends prompt.
  - Abort button visible while working.
  - Disable invalid sends.
- **Acceptance criteria:**
  - User can send multiline text prompt.
  - Abort calls RPC and UI exits working state or shows error.

### M3. Project Picker, Session Repository, New/Resume Sessions

Goal: prior project sessions appear in sidebar and resume correctly.

#### M3.1 Project picker and recent projects

- **Owner:** Frontend + backend
- **Dependencies:** M1 settings/IPC
- **Tasks:**
  - Native directory picker for project.
  - Canonicalize project path.
  - Persist recent projects.
- **Acceptance criteria:**
  - User can select a project folder.
  - Recent projects show on restart.
  - Invalid/deleted project paths show recoverable error.

#### M3.2 EffectivePiConfig resolver

- **Owner:** Backend/platform
- **Dependencies:** M1.3, M1.4
- **Tasks:**
  - Resolve piBinary, environment, agentDir, sessionDir, image settings, trust override.
  - Implement narrow safe parser for `sessionDir`, `images.blockImages`, `images.autoResize` only.
  - Apply exact precedence from architecture.
- **Acceptance criteria:**
  - App `agentDir` maps to `PI_CODING_AGENT_DIR`.
  - App `sessionDir` maps to worker `--session-dir` and static indexing.
  - Project settings are authoritative only under **Trust this run**; candidates are diagnostic/manual.
  - Parse errors are diagnostics only.

#### M3.3 Static session repository scanning

- **Owner:** Backend
- **Dependencies:** M3.2
- **Tasks:**
  - Scan authoritative session dirs for `.jsonl` with configured bounds.
  - Parse headers/session info/timestamps/first-last messages safely.
  - Filter by current project cwd.
  - Support manual app sessionDir override.
- **Acceptance criteria:**
  - Sidebar lists prior sessions for current project.
  - Scan never follows symlink loops.
  - Hitting depth/file/byte/time bounds shows partial-results diagnostic.

#### M3.4 Candidate sessionDir handling

- **Owner:** Backend + frontend
- **Dependencies:** M3.2, M3.3
- **Tasks:**
  - Detect non-authoritative project sessionDir candidates.
  - Show warnings for absolute/outside-project paths.
  - Require explicit user enablement before candidate scanning.
  - Apply stricter candidate scan bounds.
- **Acceptance criteria:**
  - Candidate dirs are not scanned automatically.
  - User sees resolved candidate path and warnings before enabling.
  - Candidate scan respects max depth 3, 5k files, 100MB metadata, 5s.

#### M3.5 New session flow

- **Owner:** Backend + frontend
- **Dependencies:** M2.3, M3.1
- **Tasks:**
  - Create new worker in selected project cwd.
  - Call `get_state` and replace temporary runtime key with canonical session file.
  - Optional session naming support if RPC available.
- **Acceptance criteria:**
  - New session appears in sidebar after creation.
  - Session file canonical path becomes primary key once available.

#### M3.6 Resume existing session flow

- **Owner:** Backend/integration
- **Dependencies:** M3.3, G2
- **Tasks:**
  - Parse session header cwd.
  - Spawn `pi --mode rpc --session <sessionFile>` in header cwd.
  - Verify returned session file canonicalizes to requested file.
  - Load state/messages/models/commands/stats where available.
- **Acceptance criteria:**
  - Hard G2 gate passes.
  - Cwd mismatch prompts user before switching project context.
  - Missing/deleted file marks sidebar error and offers refresh.
  - Unsupported `--session` blocks resume with clear diagnostics.

#### M3.7 In-app session ownership lock

- **Owner:** Backend
- **Dependencies:** M3.5, M3.6
- **Tasks:**
  - Maintain lock map keyed by canonical session file.
  - Reuse/focus existing worker on duplicate open.
  - Dispose worker before releasing lock.
- **Acceptance criteria:**
  - Double-click/repeated open does not spawn duplicate worker.
  - Duplicate open while running focuses existing runtime.
  - External same-session modification remains diagnostics-only, no flaky user warnings.

### M4. Model, Thinking, Slash Commands, Attachments

Goal: Pi-native controls and basic attachment support are usable.

#### M4.1 Model list and switcher

- **Owner:** Backend + frontend
- **Dependencies:** M2/M3 worker state
- **Tasks:**
  - Implement `get_available_models`, `set_model`.
  - Display current provider/model at all times.
  - Show image/reasoning/context capabilities where available.
- **Acceptance criteria:**
  - User can switch model for active session.
  - Zero models/auth error state is clear and actionable.
  - Image support flag is available to attachment validation.

#### M4.2 Thinking-level switcher

- **Owner:** Backend + frontend
- **Dependencies:** M2/M3 worker state
- **Tasks:**
  - Implement `set_thinking_level`.
  - Display current thinking level.
  - Handle unsupported levels gracefully.
- **Acceptance criteria:**
  - User can change thinking level and setting is reflected in active session state.
  - Failure surfaces inline without losing session.

#### M4.3 Slash command picker

- **Owner:** Backend + frontend
- **Dependencies:** M2 worker, M4.1 optional
- **Tasks:**
  - Implement `get_commands`.
  - Render command picker/autocomplete for commands returned by active worker.
  - Scope copy to extension commands, prompt templates, skills.
  - Prevent known extension commands from being sent via steer/follow-up.
- **Acceptance criteria:**
  - `/` opens command list.
  - Selected command is sent through Pi `prompt`, not reimplemented.
  - TUI-only built-ins are not promised; unsupported command messaging is clear.

#### M4.4 Native attachment picker and token authority

- **Owner:** Backend + frontend/security
- **Dependencies:** G0 attachment contract, M1 IPC
- **Tasks:**
  - `+` button opens native file picker, multi-select.
  - Main returns opaque tokens and display metadata.
  - Renderer cannot request arbitrary file reads.
  - Validate path existence/readability before send.
- **Acceptance criteria:**
  - Selected files display as chips before sending.
  - Deleted/unreadable selected file blocks send until removed/reselected.
  - IPC cannot be used to base64 arbitrary unselected paths.

#### M4.5 Non-image referenced-path attachments

- **Owner:** Backend + frontend
- **Dependencies:** M4.4
- **Tasks:**
  - Classify non-images as text/binary/unknown path references.
  - Generate prompt prefix with relative paths for project-local files.
  - Warn for outside-project absolute paths.
  - Label chips `Referenced path`.
- **Acceptance criteria:**
  - UI never implies non-image file contents are uploaded/inlined.
  - Binary/PDF/notebook files show type warning but can be referenced.
  - Prompt prefix matches architecture wording.

#### M4.6 Image support, validation, and resizing spike

- **Owner:** Backend/platform + QA
- **Dependencies:** G3, M4.1, M4.4, M3.2 image settings
- **Tasks:**
  - Validate selected model supports images at send time.
  - Enforce `images.blockImages` before RPC.
  - Resize to 2000x2000 if effective `autoResize` true/unset.
  - Base64 encode sequentially in main process.
  - Detect MIME via extension + content sniffing where possible.
- **Acceptance criteria:**
  - Image with non-image model is blocked with options to remove/switch model.
  - Block-images setting prevents send.
  - Oversized image fixture is resized when autoResize enabled.
  - Large images are warned/rejected according to spike-defined safety threshold.

### M5. Concurrent Sessions, Scheduler, Intervention Controls

Goal: multiple sessions can run independently with visible state and controlled concurrency.

#### M5.1 Base state + overlays reducer

- **Owner:** Backend + frontend
- **Dependencies:** G0 runtime event contract, M2 events
- **Tasks:**
  - Implement reducer for `agent_start/end`, `message_update`, tool events, queue, compaction, retry, extension UI.
  - Keep base state separate from overlays.
  - Export selector for sidebar priority.
- **Acceptance criteria:**
  - Unit tests cover every event reduction rule from architecture §8.
  - Red dot has highest priority only for supported pending extension UI dialog.

#### M5.2 Multiple attached workers

- **Owner:** Backend
- **Dependencies:** M3 locks, M5.1
- **Tasks:**
  - Manage multiple `PiWorker` instances.
  - Route events by runtime/session id.
  - Keep background workers alive while switching visible session.
- **Acceptance criteria:**
  - Switching away from running session does not stop it.
  - Background session events update backend state and sidebar.
  - No event leakage between sessions.

#### M5.3 RunScheduler and concurrency cap

- **Owner:** Backend
- **Dependencies:** M5.2
- **Tasks:**
  - Implement `maxRunningSessions`, default 4, hard cap 20.
  - Count working/waiting/compacting/retrying workers as running.
  - Block sends by default when cap reached.
  - Add explicit local queued-start option.
- **Acceptance criteria:**
  - Cap cannot exceed 20.
  - Blocked send explains active count and options.
  - Queued starts are in-memory only, visible, and warned on quit.
  - Queued start revalidates attachments/session/model/thinking before execution.

#### M5.4 Steer/follow-up/abort controls

- **Owner:** Backend + frontend
- **Dependencies:** M2 abort, M5.1
- **Tasks:**
  - Implement `steer`, `follow_up`, `abort` adapter methods.
  - Composer switches to intervention mode while working.
  - Prevent unsupported extension command use in steer/follow-up.
- **Acceptance criteria:**
  - Working session primary action is `Steer`.
  - Follow-up queues after current work.
  - Abort stops current work or surfaces failure.
  - Queue counts update sidebar badges.

#### M5.5 Quit handling for active/queued work

- **Owner:** App/platform + backend
- **Dependencies:** M5.2, M5.3
- **Tasks:**
  - Detect running workers and local queued starts on quit.
  - Offer Cancel Quit or Abort Agents and Quit.
  - Attempt graceful abort/termination and clean process groups where possible.
- **Acceptance criteria:**
  - App does not intentionally leave orphan workers on normal quit.
  - Queued starts are explicitly warned as discarded.
  - Running worker quit behavior is tested with fake RPC.

### M6. Extension UI, Project Trust, Resource Panel

Goal: waiting sessions are visible and Pi resource/trust behavior is represented honestly.

#### M6.1 Project trust prompt

- **Owner:** Backend + frontend
- **Dependencies:** M3.2 EffectivePiConfig, M3.1 project picker
- **Tasks:**
  - Statically detect trust-gated resources.
  - Prompt wording: “This project contains Pi resources that may require trust.”
  - Offer Trust this run, Do not trust this run, Use Pi saved/default behavior.
  - Apply `--approve`, `--no-approve`, or no override to workers.
- **Acceptance criteria:**
  - No claim that trust is definitely required.
  - Persistent trust is not offered.
  - Choice is visible in diagnostics/effective config.

#### M6.2 Static Resource panel

- **Owner:** Backend + frontend
- **Dependencies:** M6.1, M4.3 commands
- **Tasks:**
  - Show context markdown, prompts, skills, extensions, protected resources from static discovery.
  - Show active worker commands from `get_commands`.
  - Show warnings/errors from discovery and worker diagnostics.
- **Acceptance criteria:**
  - Labels are exactly strict categories: `Discovered locally`, `Available command from active Pi worker`, `Possibly skipped / trust-gated`.
  - Avoids `Loaded` unless directly observed from active worker.
  - Resource inspection does not execute SDK loaders or extension code.

#### M6.3 Extension UI request handling

- **Owner:** Backend/integration
- **Dependencies:** M2 event routing, G4
- **Tasks:**
  - Parse supported dialog methods: `select`, `confirm`, `input`, `editor`.
  - Parse fire-and-forget: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.
  - Queue pending dialog requests per session.
  - Implement `respondToExtensionUi` stdin write semantics.
- **Acceptance criteria:**
  - Dialog event sets waiting state and needsUserInput.
  - Fire-and-forget never sets red dot.
  - Write failure marks request/session error.

#### M6.4 Extension UI frontend and red-dot UX

- **Owner:** Frontend
- **Dependencies:** M6.3, M5.1 sidebar priority
- **Tasks:**
  - Render foreground dialog inline/modal.
  - Background dialog shows red dot, no auto-switch.
  - Clicking red-dot session shows pending request.
  - Disable late response after local timeout.
- **Acceptance criteria:**
  - Background waiting session is obvious.
  - App never auto-switches sessions on input request.
  - Timeout state and diagnostics are visible.

### M7. Tool Visibility, Diagnostics, Polish, Release Readiness

Goal: agent work is understandable, recoverable, and ready for personal daily use.

#### M7.1 Tool execution cards

- **Owner:** Frontend + backend
- **Dependencies:** M5.1 tool event reducer
- **Tasks:**
  - Render compact expandable cards keyed by toolCallId.
  - Show status for start/update/end/error.
  - Bash cards show command, status, output.
  - Edit/write cards emphasize file paths.
- **Acceptance criteria:**
  - Tool output can be collapsed/expanded.
  - Large outputs do not freeze renderer; lazy/virtualized rendering where needed.
  - Rich diff is explicitly not required for MVP.

#### M7.2 Session stats and diagnostics panel

- **Owner:** Backend + frontend
- **Dependencies:** M3/M4 workers
- **Tasks:**
  - Implement `get_session_stats` where available.
  - Diagnostics panel shows binary path/version, EffectivePiConfig, smoke-test status, workers, recent errors.
  - Redact secrets.
- **Acceptance criteria:**
  - User can diagnose Pi path/auth/model/resource issues without TUI.
  - Prompt bodies are not logged by default outside Pi session files.

#### M7.3 Error recovery flows

- **Owner:** Backend + frontend
- **Dependencies:** M5/M6
- **Tasks:**
  - Reopen/reconnect after worker exit by terminating stale runtime and reopening session file.
  - Manual refresh session list.
  - Clear stale overlays after reconciliation with `get_messages`.
- **Acceptance criteria:**
  - Crashed worker does not poison future reopen.
  - After restart, sidebar rebuilds from session files and selected session reloads messages.
  - GUI-only partial unsaved streamed text may be lost, with Pi session file as source of truth.

#### M7.4 End-to-end release validation

- **Owner:** QA + all leads
- **Dependencies:** all M1-M7 features
- **Tasks:**
  - Run fake-RPC test suite.
  - Run real-Pi smoke matrix for binary, new session, resume, prompt, abort, model/thinking, slash commands, attachment basics, extension UI fixture.
  - Package dev/internal macOS build.
- **Acceptance criteria:**
  - All MVP success criteria in requirements §13 pass.
  - No known blocker against personal daily use.
  - Remaining limitations documented in release notes.

## 5. Parallelization Map

### Can run immediately after G0

- M1 Electron/security scaffold.
- M2 JSONL transport and fake RPC.
- M4/M5 frontend mock UI prototypes using fake IPC.
- Test fixture design for state reducer and fake RPC.
- EffectivePiConfig detailed implementation planning.

### Can run after M1 scaffold but before real Pi is stable

- Renderer layout/chat/sidebar with fake data.
- Attachment picker UI shell with fake tokens.
- Model/thinking/slash controls against fake backend.
- State reducer unit tests from documented event fixtures.
- Diagnostics panel shell.

### Must wait for real Pi integration

- Minimal RPC smoke acceptance.
- Real prompt/stream/abort behavior.
- Resume hard gate.
- Real `get_available_models`, `set_model`, `set_thinking_level`, `get_commands`.
- Real extension UI fixture validation.

### High-risk tasks to schedule earliest

1. M1.5 minimal RPC smoke test.
2. M2.1 strict JSONL transport.
3. M3.6 resume hard gate.
4. M3.2 EffectivePiConfig with sessionDir/image/trust ambiguity.
5. M4.6 image resizing/package spike.
6. M6.3 extension UI write-failure behavior.

## 6. Suggested Staffing Plan

| Role/team | Primary tasks | Secondary tasks |
|---|---|---|
| Backend/RPC engineer | M2.1-M2.3, M3.6, M6.3 | M4.1-M4.3 adapter methods |
| Backend/platform engineer | M1.3-M1.5, M3.2-M3.4, M5.3/M5.5 | Diagnostics/logging |
| Frontend engineer A | M1.6, M2.4-M2.5, chat/timeline | M7.1 tool cards |
| Frontend engineer B | M3 sidebar/project/session UI, M4 controls | M6 resource/trust/extension UI |
| Security/platform engineer | M1.2, attachment token authority, CSP, packaging | Image resizing spike |
| QA/test engineer | Fake RPC harness, reducer tests, smoke matrix | Release validation |
| Tech lead | G0-G4 gates, risk decisions, acceptance sign-off | Cross-stream integration reviews |

## 7. Cross-Team Interface Contracts to Review Weekly

- `PiAdapter` method signatures and error model.
- IPC schemas and renderer preload API.
- Runtime event normalization and reducer output.
- Timeline item schema and rendering responsibility split.
- `EffectivePiConfig` fields and diagnostics copy.
- Attachment token lifecycle and prompt payload conversion.
- Session key/canonical path semantics.

## 8. MVP Acceptance Checklist

The MVP is acceptable when all are true:

- App launches locally on macOS without Pi TUI.
- Pi binary path/version and minimal RPC health are visible.
- User can choose a project and see prior sessions for the project.
- User can create a new session and resume an existing session via verified `--session` behavior.
- Text prompts stream assistant output.
- User can abort, steer, and follow up while working.
- Multiple sessions can run concurrently, capped by configurable max with hard cap 20.
- Sidebar clearly shows idle, working, error, queued, compacting/retrying, and red-dot waiting input states.
- Model and thinking controls are visible and functional.
- RPC-supported slash commands from `get_commands` are discoverable and usable.
- `+` attachment picker supports multi-file selection.
- Non-image files are labeled `Referenced path` and sent as path references.
- Images are sent only when model/settings allow, with GUI-side block/resize enforcement.
- Project trust prompt uses per-run choices and avoids persistent trust claims.
- Resource panel uses strict labels and does not imply unobserved loaded state.
- Supported extension UI dialogs work in foreground/background without stale red dots.
- Tool calls/results are visible in expandable cards.
- Renderer is sandboxed; file reads require selected tokens or validated project/session context.
- Diagnostics are useful and redact secrets.
- App quit handles running/queued work explicitly.

## 9. Risk Register

| Risk | Impact | Mitigation / early task | Owner |
|---|---|---|---|
| `pi --mode rpc --session` unsupported or returns wrong session | Resume core requirement blocked | G2/M3.6 hard gate; pause architecture if fails | Backend/RPC |
| Finder-launched app cannot find API keys/Pi binary | App unusable outside terminal | M1.4 env/path diagnostics and login-shell lookup | Platform |
| JSONL framing bugs corrupt event stream | Chat/session state unreliable | M2.1 parser tests with chunk/unicode cases | Backend/RPC |
| Static sessionDir scanning misses or scans unsafe locations | Sidebar incomplete or slow | M3.2-M3.4 EffectivePiConfig and bounded scans | Backend/platform |
| Trust/resource behavior diverges from Pi | User confusion/security concern | M6.1-M6.2 strict copy/labels and per-run choices | Backend/frontend |
| Image resizing causes packaging/OOM issues | M4 slips or app unstable | G3/M4.6 spike before shipping images | Platform |
| Extension UI red dots become stale | Background sessions silently blocked or noisy | G4/M6.3 timeout/write-failure tests | Backend/frontend |
| Renderer content or IPC security bug | Local file/process exposure | M1.2 security defaults, token authority, schema validation | Security/platform |
| Concurrency creates duplicate writers | Session corruption | M3.7 canonical lock, duplicate open reuse | Backend |
| Tool output freezes UI | Poor daily usability | M7.1 lazy/virtualized expandable cards | Frontend |

## 10. Definition of Done for Each Task

Every task must include:

- Code implemented behind the agreed contract.
- Unit or integration tests where feasible.
- Fake-RPC fixture if behavior involves Pi events.
- User-visible errors/diagnostics for expected failure modes.
- No broadening of MVP scope without tech-lead approval.
- Documentation update if behavior affects requirements, architecture, or release notes.
