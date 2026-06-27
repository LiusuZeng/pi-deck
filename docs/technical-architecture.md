# Pi Deck MVP Technical Architecture

Status: draft v2 after engineering review  
Target: macOS Electron + TypeScript personal MVP  
Source requirements: `docs/requirements.md`  
Review notes: `docs/engineering-design-review-notes.md`

## 1. Goals and Non-Goals

### Goals

- Build a local macOS GUI control plane for Pi agents without launching Pi's TUI.
- Preserve Pi-native behavior for sessions, models, thinking levels, slash commands, skills, project markdown, settings, trust, compaction, retry, and supported extension UI requests.
- Support multiple concurrently running Pi sessions with clear sidebar state.
- Keep a clean adapter boundary so execution can start with `pi --mode rpc` subprocesses and later move to the Pi SDK if needed.
- Keep source-code editing outside the app; the GUI observes and steers Pi work.

### Non-Goals for MVP

- No terminal/TUI wrapper.
- No remote backend, sync, or collaboration.
- No full IDE/editor features.
- No reimplementation of Pi internals beyond thin static indexing/inspection needed for GUI state.
- No advanced attachment UX beyond a `+` button and native file picker.
- No perfect rendering of TUI-only or custom extension UI components.

## 2. High-Level Architecture

```text
+----------------------------- Electron App -----------------------------+
|                                                                        |
|  Renderer process                                                       |
|  - React/TS UI                                                          |
|  - Chat timeline, composer, sidebar, model controls                    |
|  - No direct Node/fs/process access                                     |
|            | typed/schematized IPC via preload                          |
|            v                                                           |
|  Main process / local backend                                           |
|  - Project/session controller                                           |
|  - Run scheduler and canonical state store                              |
|  - PiAdapter facade                                                     |
|  - SessionRepository, StaticResourceIndex, AttachmentService            |
|            |                                                           |
|            v                                                           |
|  Pi RPC workers                                                         |
|  - One `pi --mode rpc` subprocess per attached/running session           |
|  - JSONL stdin/stdout protocol                                          |
|                                                                        |
|  Pi native storage                                                      |
|  - ~/.pi/agent/settings.json/auth.json/models.json/trust.json           |
|  - ~/.pi/agent/sessions/... or configured sessionDir                    |
|  - project .pi resources and AGENTS.md/CLAUDE.md                        |
+------------------------------------------------------------------------+
```

### Primary Decisions

1. **Execution uses RPC first.** The MVP controls Pi through `pi --mode rpc` subprocesses.
2. **No Pi SDK dependency in the MVP runtime path.** This avoids CLI/SDK version skew. Session/resource discovery starts with static JSONL/filesystem indexing plus RPC-observed data. SDK integration is post-MVP unless there is a pinned bundled distribution with version checks.
3. **Electron main is the local backend and source of truth for live state.** The renderer is a sandboxed client over typed IPC.
4. **One attached/running session maps to one Pi RPC worker.** No multiplexing of multiple running sessions through one Pi process.
5. **Pi session files remain the source of truth for conversation persistence.** The GUI stores only projections, caches, settings, and diagnostics.

## 3. Pi Binary and Version Strategy

### MVP Packaging Assumption

The MVP shells out to a user-installed global `pi` CLI. It does not bundle Pi itself.

### Binary Resolution

Because macOS Finder-launched apps may not inherit a shell `PATH`, main process resolves the Pi binary in this order:

1. User-configured absolute Pi binary path in app settings.
2. Existing `process.env.PATH`.
3. Login shell lookup, e.g. `/bin/zsh -lc 'command -v pi'`.
4. Common install locations: `/opt/homebrew/bin/pi`, `/usr/local/bin/pi`, `~/.local/bin/pi`.

The resolved path is canonicalized with `fs.realpath`. The diagnostics panel shows the resolved path and `pi --version` output.

### Version Checks and RPC Smoke Test

At startup and after binary-path changes:

- Run `pi --version`.
- Run a **minimal binary/RPC health smoke test** that cannot create persisted sessions and avoids user/project resource side effects:
  - Create a temporary empty cwd outside the selected project.
  - Spawn `pi --mode rpc --no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline` using the resolved binary and the same effective environment shape as real workers.
  - Send `get_state`, validate a successful response, then terminate the subprocess.
  - This test intentionally does not exercise global/user extensions, skills, prompts, context files, package checks, or project resources.
- Run **real worker startup diagnostics** only when opening a project/session/new worker. Real workers use normal selected resources/trust settings and surface resource-loading failures inline/diagnostics.
- Cache the minimal smoke-test result for the resolved binary/version and rerun only on app startup, binary-path changes, explicit diagnostics refresh, or after a failed worker spawn.
- Mark the app unhealthy if minimal RPC is unavailable.

Minimum supported Pi version is defined by the first release's smoke-test matrix. If a future SDK is imported, the app must compare SDK package version and CLI version and warn/block on mismatch.

### Effective Pi Environment and Directory Resolution

The main process computes one `EffectivePiConfig` used by both static indexing and worker spawning.

```ts
interface EffectivePiConfig {
  piBinary: string;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  sessionDir?: string;
  sessionDirSource: "app" | "env" | "globalSettings" | "projectSettings" | "default" | "candidate";
  imageSettings: {
    blockImages: boolean;
    autoResize: boolean;
    sources: {
      blockImages: "app" | "globalSettings" | "projectSettings" | "projectCandidate" | "default";
      autoResize: "app" | "globalSettings" | "projectSettings" | "projectCandidate" | "default";
    };
    candidateWarnings: string[];
  };
  trustOverride?: "approve" | "no-approve";
}
```

Rules:

1. **Agent dir**: app setting `agentDir` wins and is propagated to workers as `PI_CODING_AGENT_DIR`; otherwise preserve inherited `PI_CODING_AGENT_DIR`; otherwise default to `~/.pi/agent`.
2. **Session dir app override**: app setting `sessionDir` wins and is passed to workers as `--session-dir <path>` because Pi documents CLI `--session-dir` as highest precedence. Static indexing uses the same path.
3. **Session dir environment**: if no app override exists, inherited/constructed `PI_CODING_AGENT_SESSION_DIR` is preserved and used by static indexing.
4. **Safe static settings**: the app statically parses JSON settings only for safe preflight settings needed before worker launch, currently `sessionDir`, `images.blockImages`, and `images.autoResize`. It ignores every other setting even if present.
   - Global setting: `<agentDir>/settings.json`, relative paths resolve relative to `agentDir`.
   - Project setting: `<cwd>/.pi/settings.json`, relative paths resolve relative to `<cwd>/.pi`.
   - Project settings are authoritative only when the current trust choice is **Trust this run**. If trust behavior is delegated to Pi saved/default behavior, project settings are treated as non-authoritative candidates because the GUI does not parse Pi `trust.json`.
5. **Trust-dependent image settings**:
   - Authoritative global/app settings always apply.
   - Authoritative project image settings apply only for **Trust this run**.
   - For delegated/default trust, project `images.blockImages: true` is applied conservatively as an effective block because it is the privacy-safe choice; project `images.blockImages: false` is ignored unless authoritative.
   - For delegated/default trust, project `images.autoResize: false` is ignored unless authoritative because disabling resize can increase memory/provider risk; project `images.autoResize: true` may be applied conservatively. Default is `autoResize: true`.
   - Diagnostics show the source of each effective image setting and any ignored/applied candidate project values.
6. **Default session dir**: if no override/env/settings value applies, use Pi's default session storage under `<agentDir>/sessions`.
7. Diagnostics show resolved `piBinary`, `agentDir`, `sessionDir`, `sessionDirSource`, effective image settings and sources, and trust override, with secrets redacted from environment previews.

This lightweight settings parser is a narrow preflight helper, not a general Pi settings implementation. It must not execute resource loaders, extensions, package installation, or arbitrary code. Parse errors are diagnostics only and do not block worker launch; the active Pi worker remains the source of truth for all settings-driven behavior that RPC/Pi exposes directly.

## 4. Process, Session Ownership, and Locking

### Concepts

- **Project**: a local working directory (`cwd`) selected by the user.
- **Pi session file**: Pi-owned JSONL file. The GUI does not own this format.
- **Session summary**: sidebar metadata derived from Pi session files plus live runtime overlays.
- **Attached session**: a GUI session with a live `PiWorker` process.
- **Running session**: an attached session currently processing agent work, compaction, retry, or queued Pi follow-up execution.

### Session Identity

- Use canonical `sessionFile` realpath as the primary session key once available.
- For new sessions before Pi returns `sessionFile`, use a temporary runtime key and replace it after `get_state`.
- Session files and project directories are canonicalized with `fs.realpath` to avoid symlink duplicate keys.

### In-App Ownership Lock

Main process maintains an in-memory lock map:

```ts
Map<CanonicalSessionFile, RuntimeSessionId>
```

Rules:

1. Opening an already attached session focuses/reuses the existing worker; it never spawns a duplicate worker.
2. Double-clicks and repeated opens are idempotent by canonical session key.
3. MVP supports one app window. If multiple windows are added later, they share the same main-process lock map.
4. Stale attached workers are disposed before their lock is released.
5. External concurrent writes by Pi TUI or another process to the same session are unsupported in MVP. The GUI cannot prevent this because Pi's session files do not provide cross-process locking. MVP does not show proactive mtime-based user warnings because Pi writes asynchronously and false positives would be noisy. Mtime/hash observations may be recorded as diagnostics only. If the user manually refreshes or reopens after external edits, the GUI reloads from Pi's persisted session file.

### Worker Model

`PiWorker` wraps one `pi --mode rpc` subprocess:

- Spawned with the session/project `cwd`.
- Existing session: use `pi --mode rpc --session <sessionFile>`. This support must be verified in M2/M3. Resume is blocked with a clear incompatibility error if the installed Pi CLI does not support this; the previous fallback-to-`switch_session` design is removed from MVP because it may create extra sessions or fire incorrect startup events.
- New session: start `pi --mode rpc` in project cwd, optionally with `--name`, then call `get_state` to discover `sessionFile` and `sessionId`.
- One worker owns one session while attached. Running workers are never reused for another session.
- Switching away from a running session only changes the visible UI; the worker keeps running and streaming events into backend state.

### Lifecycle

```text
unloaded -> attaching -> idle -> working -> idle
                         |       |-> waitingForInput -> working/idle
                         |       |-> error
                         |-> exited
```

Overlays such as `streaming`, `toolRunning`, `compacting`, `retrying`, and queued counts are tracked separately from the base lifecycle state.

Key lifecycle rules:

1. Sidebar listing does not spawn workers for every prior session.
2. Opening/resuming a session attaches a worker, loads `get_state` and `get_messages`, and subscribes to events.
3. Idle workers may be kept warm for fast switching, subject to a configurable warm-worker limit.
4. Running workers are protected from idle eviction.
5. On app quit, if workers are running or local starts are queued, prompt the user. MVP choices: **Cancel Quit** or **Abort Agents and Quit**. The app does not leave orphan agents running intentionally.
6. Unexpected process exit marks the session `error` if work was in flight, otherwise `exited` with an exit diagnostic.

### Crash Recovery Guarantees

- The app cannot reconnect to already-running RPC workers after an Electron main-process crash. This is explicit MVP behavior.
- On restart, the app rebuilds sidebar and chat state from Pi session files and `get_messages` after reopening a session.
- Partial streamed messages are reconciled by trusting Pi's persisted session file; GUI-only partial text that was never saved by Pi may be lost.
- Child processes are spawned with tracked PIDs/process groups where possible and terminated on normal quit. Main-process crash may still leave child processes until OS/session cleanup; this is a known MVP limitation.

## 5. Exact Resume Algorithm

1. Canonicalize `sessionFile` with `fs.realpath` and acquire the in-app ownership lock.
2. Parse the session JSONL header to get `cwd`. If the header cwd exists, launch the worker in that cwd. If it differs from the currently selected project, show that the session belongs to another project and switch project context after user confirmation.
3. Spawn `pi --mode rpc --session <sessionFile>` with current trust override policy and the resolved `EffectivePiConfig` environment/directory options.
4. Send `get_state`.
5. Verify returned `sessionFile` canonicalizes to the requested path. If not, terminate worker and mark attach failed.
6. Send `get_messages`, `get_available_models`, `get_commands`, and optionally `get_session_stats`.
7. Subscribe/route events and mark base state `idle` unless `get_state.isStreaming` or pending requests imply otherwise.

Failure handling:

- Missing/deleted session file: remove live overlay, show sidebar error, offer to refresh list.
- Unsupported `--session`: show Pi version/path diagnostics and block resume.
- Session switch cancellation is not part of the MVP resume path because MVP does not use `switch_session` to resume.

## 6. Concurrency and Scheduling

- User setting: `maxRunningSessions`, default `4`, hard cap `20`.
- `RunScheduler` counts workers whose base state is `working` or `waitingForInput`, or which have active compaction/retry work.
- Steering/follow-up for an already running session is sent to that session's worker and does not consume a new slot.

### Local Queued Starts

MVP avoids implicit local queueing. If the cap is reached when the user tries to send a prompt to an idle/unattached session:

1. Default behavior is to block send and explain that the concurrency cap is reached.
2. The user may explicitly choose **Queue Start**.
3. Local queued starts are in-memory only and are not persisted across app restart.
4. On quit, queued starts trigger a warning and will be discarded if the user quits.
5. Before a queued start runs, attachments are revalidated, session file existence is checked, and model/thinking choices are applied from the queued snapshot if still valid. If invalid, the queued start is paused for user review.

This keeps the MVP honest about loss semantics while still supporting a visible `queued` sidebar indicator.

## 7. Pi RPC Adapter

### Adapter Boundary

```ts
interface PiAdapter {
  createSession(project: ProjectRef, options?: NewSessionOptions): Promise<RuntimeSession>;
  openSession(sessionFile: string): Promise<RuntimeSession>;
  closeSession(runtimeId: string): Promise<void>;

  getState(runtimeId: string): Promise<PiState>;
  getMessages(runtimeId: string): Promise<PiMessage[]>;
  getAvailableModels(runtimeId: string): Promise<ModelInfo[]>;
  getCommands(runtimeId: string): Promise<CommandInfo[]>;
  getSessionStats(runtimeId: string): Promise<SessionStats>;

  prompt(runtimeId: string, input: PromptInput): Promise<void>;
  steer(runtimeId: string, input: PromptInput): Promise<void>;
  followUp(runtimeId: string, input: PromptInput): Promise<void>;
  abort(runtimeId: string): Promise<void>;
  setModel(runtimeId: string, provider: string, modelId: string): Promise<ModelInfo>;
  setThinkingLevel(runtimeId: string, level: ThinkingLevel): Promise<void>;
  respondToExtensionUi(runtimeId: string, response: ExtensionUiResponse): Promise<void>;

  onEvent(listener: (event: RuntimeEvent) => void): Unsubscribe;
}
```

The UI and session controller depend on this interface, not on JSONL details.

### JSONL Transport Requirements

- Use strict LF-delimited JSONL parsing.
- Do not use Node `readline`; it can split on Unicode separators that are valid inside JSON strings.
- Maintain a request map keyed by command `id`.
- Treat `type: "response"` as command responses and all other records as async events.
- Capture stderr into per-worker diagnostic logs.
- Add timeouts only for command acceptance/response, not for long-running agent work after prompt acceptance.

## 8. State Model, Event Reduction, and Sidebar Priority

### Canonical Runtime State

Base state and overlays are separate.

```ts
type BaseSessionState =
  | "unloaded"
  | "attaching"
  | "idle"
  | "working"
  | "waitingForInput"
  | "error"
  | "exited";

interface SessionOverlays {
  streaming: boolean;
  toolRunning: boolean;
  compacting: boolean;
  retrying: boolean;
  localQueuedStartCount: number;
  piQueuedSteeringCount: number;
  piQueuedFollowUpCount: number;
  needsUserInput: boolean;
}
```

### Event Reduction

- `agent_start`: base `working`.
- `message_update`: set `streaming = true`; update partial assistant message. Clear streaming on `message_end`, `agent_end`, or delta `done/error`.
- `tool_execution_start`: `toolRunning = true`; create/update tool card.
- `tool_execution_update`: replace accumulated partial tool result for `toolCallId`.
- `tool_execution_end`: finalize card; clear `toolRunning` when no active tools remain.
- `queue_update`: update Pi steering/follow-up queue counts.
- `compaction_start/end`: set/clear `compacting`.
- `auto_retry_start/end`: set/clear `retrying`; on final failure, base `error`.
- `extension_ui_request` dialog methods: base `waitingForInput`, `needsUserInput = true`, store pending request.
- User response sent for pending extension dialog: clear pending request/red dot locally after writing response to stdin; return to `working` if agent is still active, else `idle`. Local timeout + grace also clears stale pending dialogs.
- `extension_error` or failed critical RPC response: base `error`.
- `agent_end`: base `idle` unless a dialog remains pending; clear streaming/tool overlays.

### Sidebar Priority

Display highest-priority indicator:

1. `waitingForInput` / `needsUserInput`: red dot.
2. `error`: error icon/text.
3. `attaching`: spinner.
4. `compacting`: compacting indicator.
5. `retrying`: retrying indicator.
6. `toolRunning`: working/tool indicator.
7. `streaming` or base `working`: working indicator.
8. Local queued starts or Pi queued messages: queued badge/count.
9. `idle`: neutral indicator.
10. `exited`/`unloaded`: muted indicator.

The red dot means a supported extension UI dialog is waiting for user input. It does not mean every possible user-action-needed state.

## 9. Data Model

Pi remains the source of truth for conversation/session persistence. The GUI maintains a projection for display and scheduling.

```ts
interface ProjectRecord {
  id: string;
  path: string;
  canonicalPath: string;
  displayName: string;
  lastOpenedAt: number;
}

interface SessionSummary {
  key: string;              // canonical sessionFile when available
  sessionFile?: string;
  sessionId?: string;
  projectPath: string;
  title: string;
  createdAt?: number;
  updatedAt: number;
  baseState: BaseSessionState;
  overlays: SessionOverlays;
  lastError?: string;
}

interface RuntimeSessionState {
  runtimeId: string;
  sessionKey: string;
  workerPid?: number;
  model?: ModelInfo;
  thinkingLevel?: ThinkingLevel;
  isAgentActive: boolean;
  pendingMessageCount: number;
  pendingExtensionUiQueue: ExtensionUiRequest[];
  messages: TimelineItem[];
  toolsByCallId: Record<string, ToolExecutionState>;
  diagnostics: string[];
}

interface AttachmentDraft {
  id: string;
  selectedPathToken: string; // renderer does not get arbitrary read authority
  path: string;              // main-process only canonical path
  fileName: string;
  mimeType?: string;
  size?: number;
  kind: "image" | "textFile" | "binaryFile";
  sendMode: "imageInput" | "pathReference";
}
```

### App-Local Persistence

Store only GUI metadata under Electron `app.getPath('userData')`:

- Recent projects.
- App settings such as Pi binary path, max running sessions, warm-worker limit, agent/session-dir overrides, and environment-loading preference.
- Cached session index metadata for fast sidebar startup.
- UI preferences such as sidebar width or tool-card expansion defaults.
- Rolling diagnostics/logs.

Do not duplicate Pi conversation history. Rebuild message state from `get_messages` and Pi session JSONL when needed.

## 10. Session Listing

RPC does not provide a session-list command. The backend uses `SessionRepository` separate from agent execution:

1. Resolve the effective session directory with `EffectivePiConfig` so static indexing and workers agree whenever the session directory is app/env/global-settings/default, and agree for project settings when the user explicitly chose **Trust this run**.
2. If project `.pi/settings.json` contains `sessionDir` but trust behavior is delegated to Pi saved/default behavior, list that directory as a non-authoritative candidate and show a diagnostic that the GUI cannot know whether Pi will trust and use it without parsing `trust.json`.
3. Authoritative session dirs are scanned automatically, but still with practical safety bounds so large stores do not hang the UI.
4. Non-authoritative candidate dirs are **not scanned automatically**. The user must explicitly enable scanning for that candidate after seeing its resolved path and warnings, especially for absolute paths outside the project or agent dir.
5. Session scanning is bounded: scan only `.jsonl` files. For authoritative dirs, initial targets are max depth 4, max 20,000 candidate files, max 250 MB total file bytes read for headers/metadata, and max 15 seconds wall time per scan pass. For candidate dirs, use stricter limits: max depth 3, max 5,000 candidate files, max 100 MB total file bytes read, and max 5 seconds wall time per candidate dir. Stop early and show a partial-results diagnostic if limits are hit. Never follow symlink loops; canonicalize roots before scanning.
6. Parse Pi JSONL session headers, `session_info` entries, timestamps, and first/last user messages for sessions under the current project from authoritative directories plus user-enabled candidate directories.
7. Merge static session summaries with live `RuntimeSessionState` overlays.
8. Provide a manual app-level `sessionDir` override for users whose sessions are stored in a location the static resolver cannot infer.
9. SDK `SessionManager.list` is deferred until a version-pinned SDK/CLI strategy exists.

## 11. Prompt Input and Attachments

### Text

Composer sends plain text to `prompt`, `steer`, or `follow_up` depending on agent state and user action.

### Non-Image Files

Pi RPC prompt supports text plus images, not arbitrary file blobs. MVP policy:

- Non-image attachments are **referenced paths**, not uploaded file contents.
- UI chips must say `Referenced path`, not imply contents have been attached.
- For project-local files, prefer relative paths in the generated prompt prefix.
- For outside-project files, show an explicit warning before send because an absolute path may expose local filesystem structure to the model/provider and may be outside Pi's normal working directory.
- Symlinks are resolved for validation; the displayed path may remain user-friendly, but the backend uses canonical paths to avoid duplicate/unsafe assumptions.
- Deleted, unreadable, or missing files block send until removed or reselected.
- Binary files, PDFs, notebooks, and unknown formats are still only path references with a visible type warning.
- Resumed messages are rendered from Pi messages; attachment chips are not guaranteed to reconstruct except as visible text in the generated prompt prefix.

Example generated context prefix:

```text
Files selected in the GUI as referenced paths, not inlined contents:
- src/foo.ts
- docs/design.pdf (binary/path reference only)

Use the read tool for text/code files when you need their contents.
```

### Images

- Image capability validation happens at send time against the current selected model (`input` contains `image`).
- If unsupported, block send and offer to remove images or switch model.
- Main process reads, optionally resizes, and base64-encodes selected images sequentially to reduce memory spikes.
- MIME type is detected from extension plus content sniffing when available; unsupported/unknown image types block send with a clear error.
- The GUI does not impose a low product-level file-size limit in MVP, but it may enforce crash-prevention safety guards for decoded image pixels/estimated memory. Very large images require confirmation and may be rejected if processing would risk renderer/main-process OOM. Pi/model/provider limits may still fail the request.
- The GUI statically resolves Pi image settings from the same lightweight settings parser used for directory resolution:
  - If `images.blockImages` is true in the effective settings, the GUI blocks image sends before RPC.
  - If `images.autoResize` is true or unset, the GUI performs Pi-equivalent main-process resizing to a 2000x2000 max bounding box before base64 encoding. This avoids relying on undocumented RPC-side preprocessing and makes GUI behavior consistent even if RPC accepts already-encoded images directly.
  - If `images.autoResize` is false, the GUI sends the original image bytes.
- Smoke tests must still verify whether Pi RPC enforces these settings itself, but MVP correctness does not depend on that verification because the GUI applies the relevant settings before sending.

Image resizing implementation note for M4:

- M4 includes a packaging spike before image support is considered shippable.
- Preferred implementation is Electron/macOS-friendly and packaging-light: use Electron `nativeImage` plus a small pure-JS metadata sniffer when sufficient for PNG/JPEG/WebP; evaluate `sharp` only if built-in APIs cannot meet quality/format needs.
- The spike must validate macOS arm64/x64 packaging, signing/notarization impact, memory use on large images, and behavior for unsupported formats/animated images.
- Processing is sequential with preflight metadata checks where possible. Initial safety guard target: warn above 25 MB compressed or 50 megapixels decoded; reject or require manual override above an implementation-defined OOM-risk threshold validated in the spike.

## 12. Model, Thinking, and Slash Commands

- `get_available_models` provides provider/model list and capabilities.
- `set_model` changes the current session model and records the change in Pi's session.
- `set_thinking_level` changes reasoning level.
- `get_commands` drives slash-command picker/autocomplete for extension commands, prompt templates, and `/skill:name` commands.
- Built-in TUI-only commands such as `/settings`, `/hotkeys`, and TUI-specific screens are not supported as slash commands in the GUI MVP.
- GUI-native equivalents should be buttons/menus where needed: new session, resume, model switch, thinking switch, compact/export later.
- Slash command execution is never reimplemented by the GUI; supported command text is sent through Pi `prompt`.
- During streaming, extension commands must go through `prompt` because Pi allows extension commands to execute immediately. `steer` and `follow_up` reject extension commands; the UI should prevent queuing known extension commands as steer/follow-up and show a clear message.

## 13. Project Trust Strategy

Pi RPC is non-interactive. If there is no saved trust decision and global `defaultProjectTrust` is `ask`, project-local protected resources are ignored unless the process is launched with `--approve`.

MVP behavior:

1. The GUI statically detects obvious trust-gated resources: `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and project `.agents/skills`.
2. If protected resources exist, show a project trust prompt worded as: "This project contains Pi resources that may require trust." Do not claim "trust is required" because Pi may already have a saved parent-folder decision that the GUI does not parse.
3. The prompt has three choices:
   - **Trust this run**: force `--approve` for workers.
   - **Do not trust this run**: force `--no-approve` for workers.
   - **Use Pi saved/default behavior**: launch with no trust override, allowing saved `trust.json`, global `defaultProjectTrust`, and user/global extension `project_trust` handlers to participate as Pi normally permits.
4. `AGENTS.md` and `CLAUDE.md` context files are described as loaded regardless of project trust unless Pi settings disable context loading.
5. Persistent "remember trust" is post-MVP until an official stable Pi API or trust-file contract is confirmed.
6. If trust is denied or Pi default skips protected resources, the Resource panel must make skipped project resources visible where statically detectable.

This design intentionally avoids parsing/writing `trust.json` in MVP and avoids claiming perfect parity with Pi's internal parent-folder trust resolution.

## 14. Resource Display and ResourceInspector Safety

The earlier design proposed SDK `DefaultResourceLoader` for inspection. That is removed from MVP because resource loading can execute extension code, install/load packages, cause side effects, or duplicate extension execution alongside the RPC worker.

MVP Resource panel uses only:

- Static filesystem discovery of likely context files, project prompts, skills, extensions, and protected resources.
- Active worker `get_commands` output for the commands Pi actually exposes.
- Worker diagnostics/stderr and command errors.

Strict MVP labels:

- `Discovered locally`: statically found files/resources, including context markdown files. Context markdown loaded status is not directly observable via RPC in MVP, so do not label these as loaded.
- `Available command from active Pi worker`: command returned by active worker `get_commands`.
- `Possibly skipped / trust-gated`: statically found protected project resources that may be skipped depending on Pi trust resolution.

Avoid the word `Loaded` unless the fact is directly observed from the active Pi worker.

## 15. Extension UI Coverage

Supported MVP subset:

- Dialog/blocking: `select`, `confirm`, `input`, `editor`.
- Fire-and-forget: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.

Pending-dialog lifecycle:

- Dialog requests are queued per session if more than one appears, though Pi is expected to block on one dialog at a time in normal flows. The queue is defensive.
- Foreground dialog renders inline/modal in the session view.
- Background dialog sets `needsUserInput = true` and red-dot sidebar priority; no auto-switch.
- The GUI does not rely on `extension_ui_response` producing a normal RPC command response.
- `respondToExtensionUi` resolves only after the main process successfully queues/writes the response to the worker stdin while the worker is still alive. Clear the red dot only after that successful enqueue/write.
- If stdin write/enqueue fails (`EPIPE`, closed stdin, exited worker, stream error), mark the pending request failed, set the session base state to `error`, show diagnostics in the session view, and do not silently clear as success.
- If a request includes `timeout`, the GUI starts a local timer for `timeout + graceMs` (default grace 1000 ms). If the timer fires before user response, mark the request `timedOutLocally`, clear the red dot, disable response controls, and keep a session diagnostic. Pi still owns authoritative timeout resolution; the local timer prevents stale waiting indicators.
- If no timeout is provided, the request remains pending until user response, worker exit, session close, or an impossible `agent_end` while still pending; those cleanup cases log diagnostics.
- Late user responses after local timeout are suppressed rather than sent. If a response was already sent and Pi rejects/ignores it, log the rejection without restoring the red dot.
- Fire-and-forget requests never set the red dot.
- TUI-only/no-op/degraded extension APIs are not rendered as custom UI in MVP. Perfect custom extension UI rendering is explicitly post-MVP.

## 16. Tool and Output Visibility

Timeline rendering model:

- User messages as chat bubbles with visible prompt prefix/chips where available.
- Assistant messages as streamed markdown blocks.
- Thinking blocks collapsible by default if present.
- Tool calls as compact cards keyed by `toolCallId`.
- Bash cards show command, running status, exit/error state, and streaming output.
- Edit/write cards emphasize file paths; rich diff rendering is post-MVP.
- Tool output is expandable/collapsible and can be lazily virtualized for large output.

## 17. Electron Security and IPC Validation

Security defaults:

- `contextIsolation: true`.
- `nodeIntegration: false`.
- Renderer sandbox enabled where practical.
- Remote module disabled.
- Strict Content Security Policy: no remote scripts, no inline script except hashed/bundled allowances if unavoidable.
- All IPC payloads validated in main process with `zod` schemas or equivalent runtime schemas.

File/path authority:

- Renderer cannot ask main to read arbitrary paths.
- Native file/directory pickers return opaque attachment/project tokens plus display metadata.
- Subsequent attachment send uses tokens; main process resolves them to previously selected canonical paths.
- Project operations are limited to selected project roots/session files discovered by the backend.

Rendering untrusted content:

- Markdown is sanitized; raw HTML disabled or sanitized.
- Links open via Electron `shell.openExternal` only after scheme allowlist (`http`, `https`, `mailto`) and no automatic navigation inside the app.
- File paths from tool output, if clickable, support safe `reveal in Finder` through a validated main-process IPC path under selected project/session context. They do not grant arbitrary file read.

## 18. Environment, Auth, and Local-Only Semantics

### Environment Strategy

- Main process builds the worker environment from `process.env` plus optional macOS login-shell environment capture.
- Provide a setting to disable login-shell environment capture if it causes slow startup or surprises.
- Preserve Pi-relevant variables such as API keys, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, proxy variables, and session-dir overrides unless app settings intentionally override them.
- Apply `agentDir` and `sessionDir` exactly as specified in `Effective Pi Environment and Directory Resolution` (§3): app `agentDir` maps to `PI_CODING_AGENT_DIR`; app `sessionDir` maps to worker `--session-dir`; inherited `PI_CODING_AGENT_SESSION_DIR` is used only when no app sessionDir exists.
- Static session indexing, image setting resolution, and worker spawning must use the same `EffectivePiConfig`.

### Auth and Diagnostics

- Missing API keys/OAuth/model availability errors surface in a first-run diagnostics panel and inline session errors.
- The model switcher should clearly show zero available models and link to Pi/auth setup guidance.

### Local-Only Clarification

"Local-only" means the GUI has no remote backend/server and does not sync app data. Pi may still contact configured model providers, perform version/package checks, or use user-enabled network tools according to Pi settings and environment. Users can use `PI_OFFLINE=1` / Pi settings to disable Pi startup network operations where supported.

## 19. Diagnostics and Log Retention

- Worker stderr and lifecycle diagnostics are written under `app.getPath('userData')/logs/`.
- Keep rolling logs by worker/session, e.g. 5 MB per log and 7 days retention for MVP.
- Diagnostics panel shows Pi binary path/version, resolved environment summary with secrets redacted, active workers, recent errors, and RPC smoke-test status.
- Never log prompt contents by default outside Pi's own session files. Event diagnostics should redact or avoid message bodies unless a debug setting is explicitly enabled.

## 20. Error Handling and Recovery

- Failed RPC command response: surface inline error and keep worker alive if possible.
- Parse error from worker output: log diagnostic, mark worker unhealthy, and offer reconnect/reopen after termination.
- Process crash during work: mark session error and preserve last known streamed content as partial until reconciled with Pi messages.
- Extension UI timeout/stale response: use local timeout + grace to clear stale red dots, suppress late responses after local timeout, and log any Pi-side rejection/late-response diagnostic. If response write/enqueue fails, mark the request/session error and show diagnostics.
- Model/image mismatch: block send until user removes images or switches model.
- Concurrency cap reached: block send by default; optional explicit local queue.

## 21. Testing Strategy

- Unit-test JSONL framing, including embedded Unicode separators and chunk boundaries.
- Unit-test state reducer from RPC events to base state plus overlays.
- Unit-test scheduler cap, explicit local queued-start behavior, and quit warnings.
- Unit-test attachment classification, path-token authority, path-reference prompt conversion, image capability checks, `images.blockImages`, and 2000x2000 auto-resize behavior.
- Integration-test against a fake RPC subprocess for deterministic streaming/events/errors/extension UI, including dialog timeout, no-timeout, local stale clearing, late-response suppression, worker exit before response, and stdin write failure.
- Smoke-test against real `pi --mode rpc` for binary resolution, `get_state`, full minimal smoke-test cleanliness (`--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline`), new session, resume via `--session`, prompt, steer, follow-up, abort, commands, models, and extension UI.
- Renderer tests for sidebar priority and red-dot waiting sessions.

## 22. Implementation Milestones

### M1. App Skeleton and Boundaries

- Electron + TypeScript app shell.
- Secure preload IPC contract with schema validation.
- Basic layout: project header, session sidebar, chat pane, composer.
- App-local settings and recent projects storage.
- Pi binary resolution, version display, and clean minimal RPC smoke test using `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline` in a temp cwd.

### M2. Single-Session RPC Adapter

- Spawn one Pi RPC worker.
- Implement strict JSONL client, request correlation, stderr diagnostics.
- Support `get_state`, `get_messages`, `prompt`, streaming assistant text, and `abort`.
- Render basic chat timeline.

### M3. Session Repository and Resume

- Project picker.
- Static JSONL session listing for current project.
- New session and resume existing session via `pi --mode rpc --session <sessionFile>`.
- **Hard M3 acceptance gate**: given an existing session file, spawning `pi --mode rpc --session <file>` and calling `get_state` must return a `sessionFile` that canonicalizes to the requested file. If not, M3 cannot ship.
- Session ownership lock and duplicate-open reuse.
- Session title/name, updated time, project path, idle/error state.

### M4. Model, Thinking, Commands, and Basic Attachments

- Model switcher with capability display.
- Thinking-level switcher.
- Slash command picker from `get_commands`, scoped to supported RPC commands.
- Native `+` attachment picker.
- Image input support with effective `images.blockImages` / `images.autoResize` enforcement, and non-image referenced-path support with accurate labels.
- Image resizing/package spike completed before image support ships: validate chosen library/API on macOS arm64/x64 Electron packaging, signing/notarization, and large-image memory behavior.

### M5. Concurrent Sessions and Intervention Controls

- Multiple attached workers.
- Configurable `maxRunningSessions` with hard cap 20.
- Background event tracking while switching sessions.
- Base-state/overlay sidebar indicators.
- Steer/follow-up/abort controls while working.
- Explicit non-persistent local queued-start option when cap is reached.

### M6. Extension UI and Trust

- Handle supported `extension_ui_request` dialog/fire-and-forget methods.
- Red-dot background sessions waiting for extension UI input.
- Project trust prompt worded as resources that may require trust, with per-run approve/no-approve/default choices.
- Static Resource panel plus active `get_commands` data.

### M7. Tool Visibility and Polish

- Tool execution cards with streaming updates.
- Bash output status.
- Edit/write file-path display.
- Session stats display.
- Robust reconnect/terminate flows and quit handling.

## 23. Key Risks and Mitigations

- **Global Pi path/version**: configurable binary path, login-shell/common-path lookup, visible diagnostics, clean minimal RPC smoke test with `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline`.
- **Resume compatibility**: `--session` canonical-return behavior is a hard M3 gate; block unsupported versions rather than using side-effect-prone fallback.
- **Session duplicate writers**: in-app canonical lock; external same-session editing is unsupported. Proactive modification warnings are deferred to avoid flaky false positives.
- **SessionDir parity**: static resolver handles app/env/global/default and explicitly trusted project settings; saved-trust/default project `sessionDir` remains candidate/manual override territory because MVP does not parse `trust.json`. Candidate dirs require explicit user-enabled bounded scanning.
- **Trust fidelity**: avoid writing/parsing trust store; let Pi default behavior run unless user explicitly chooses per-run approve/no-approve.
- **Resource inspection side effects**: no SDK `DefaultResourceLoader` in MVP; static discovery plus active RPC command data only.
- **Extension UI stale indicators**: local timeout + grace clears red dots when Pi-side timeout is not observable; stdin write failures mark session/request error instead of clearing as success.
- **Finder environment/auth**: login-shell env capture and first-run diagnostics.
- **Attachment expectations**: non-image UI says referenced path, not attached content.
- **Image settings parity**: enforce block/resize in GUI before RPC so MVP does not depend on undocumented RPC preprocessing; trust-dependent project image settings use conservative rules and per-setting source diagnostics.
