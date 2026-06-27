# Pi Deck MVP Engineering Design Review Notes

Purpose: cooperative design-review notes for the engineering design owner/agent. These notes are meant to pressure-test `docs/technical-architecture.md` against `docs/requirements.md` and Pi's documented RPC/SDK/session/trust behavior.

The goal is not to block the design, but to make it implementation-ready: clear decisions, known tradeoffs, explicit MVP cut lines, and acceptance tests for risky areas.

## How to Use This Doc

For each section below, the design owner should either:

1. **Defend** the current design with concrete reasoning.
2. **Update** the architecture with a specific change.
3. **Defer** the issue with clear MVP/post-MVP rationale and risk.

Expected output from the design owner:

- Decision log.
- Specific edits to `docs/technical-architecture.md`.
- Any requirement clarifications needed in `docs/requirements.md`.
- Top risks and mitigations.
- Acceptance-test checklist for early milestones.

---

## 1. RPC vs SDK Boundary

The design uses RPC workers for execution, while session listing/resource inspection may use SDK APIs.

Questions:

- How do we guarantee the SDK and spawned `pi` CLI are the same version?
- What happens if globally installed `pi` differs from the bundled/imported SDK?
- Should MVP use only SDK or only RPC until parity/versioning is solved?
- If using global `pi`, how does the Electron app locate it when launched from Finder, where shell `PATH` may be missing?
- Do we need a configurable Pi binary path?
- Do we need to display Pi CLI/SDK versions in diagnostics?

Review target:

- Decide whether MVP bundles Pi SDK, shells out to global `pi`, or supports both with version checks.

---

## 2. Session Ownership and Duplicate Workers

The design assumes one RPC worker per active/open running session.

Questions:

- What prevents two workers from opening/writing the same session JSONL?
- What happens if the user double-clicks a session, opens it in two windows, or a stale worker still exists?
- Do we need a backend-level lock keyed by canonical `sessionFile`?
- What happens if the user also has Pi TUI open on the same session?
- Should duplicate opens focus/attach the existing worker rather than spawn another?
- How are session file paths canonicalized with symlinks?

Review target:

- Add explicit session ownership/locking rules.
- Define behavior for concurrent external modification as unsupported, detected, or warned.

---

## 3. Session Resume Correctness

The design says to prefer `pi --mode rpc --session <sessionFile>`, with fallback to starting in project cwd and issuing `switch_session`.

Questions:

- Has `pi --mode rpc --session <path>` been verified?
- If fallback starts a new session first and then switches, can extensions fire startup/new-session events incorrectly?
- Can fallback create extra empty session files?
- Can `switch_session` be cancelled by extensions, and how is that shown?
- What is the exact resume algorithm?
- What is the failure behavior if the session belongs to a different cwd than the selected project?

Review target:

- Define the exact attach/resume flow and error states.
- Verify CLI support early in M2/M3.

---

## 4. Project Trust Fidelity

The design proposes detecting trust-gated resources and launching workers with `--approve` or `--no-approve`.

Questions:

- Does custom detection match Pi's actual trust behavior, including saved parent-folder decisions?
- Are `AGENTS.md` and `CLAUDE.md` loaded regardless of project trust, as Pi docs describe?
- Does a GUI trust prompt bypass user/global extension `project_trust` handlers?
- Should the GUI rely on Pi itself to resolve trust instead of duplicating detection?
- Is per-run trust enough for MVP, or will users expect persistent “remember trust” behavior?
- If trust is denied, how clearly do we show skipped resources?

Review target:

- Align trust behavior with Pi docs.
- Avoid writing `trust.json` unless an official stable API/format is confirmed.
- Decide whether persistent trust is MVP or post-MVP.

---

## 5. ResourceInspector Safety

The design mentions SDK `DefaultResourceLoader` to display loaded resources.

Questions:

- Does `DefaultResourceLoader.reload()` execute extension code?
- If yes, is it safe to run inside Electron main only for inspection?
- Could project extensions execute twice: once in ResourceInspector and once in the RPC worker?
- Could ResourceInspector cause side effects, package installs, long startup delays, or security surprises?
- Should MVP avoid SDK resource inspection and show only:
  - static discovered files, and
  - active RPC `get_commands` output?

Review target:

- Decide if ResourceInspector is safe enough for MVP.
- If not, defer or limit to static file discovery plus RPC-observed command data.

---

## 6. Slash Command Behavior

Requirements say Pi slash commands must work in the GUI.

Known concern: `get_commands` includes extension commands, prompt templates, and skills, but not built-in TUI-only commands like `/settings` or `/hotkeys`.

Questions:

- Which slash commands are supported in GUI MVP?
- How do we communicate unsupported TUI-only commands?
- Do extension commands during streaming go through `prompt` rather than `steer`/`follow_up`?
- How does UI prevent invalid queued extension commands?
- Should GUI implement separate buttons for GUI-native equivalents such as new session, resume, model switch, compact, export?

Review target:

- Clarify slash-command scope in requirements and architecture.
- Avoid implying all TUI commands work unchanged.

---

## 7. Concurrent State Model

The state enum includes `working`, `streaming`, `toolRunning`, `waitingForInput`, `compacting`, `retrying`, `queued`, etc.

Questions:

- Are these mutually exclusive states or overlays?
- What is displayed when a session is both `toolRunning` and `waitingForInput`?
- What is displayed when `retrying` and queued follow-ups are present?
- What state has highest sidebar priority?
- Does the red dot mean only extension UI dialog waiting, or any user action needed?
- How are `agent_start`, `message_update`, `tool_execution_*`, `queue_update`, `compaction_*`, `auto_retry_*`, and `agent_end` reduced into state?

Suggested direction:

- Separate base state from overlays:
  - Base: `unloaded | attaching | idle | working | waitingForInput | error | exited`
  - Overlays/flags: `streaming`, `toolRunning`, `compacting`, `retrying`, `queuedMessageCount`, `needsUserInput`

Review target:

- Add exact state derivation and sidebar priority rules.

---

## 8. Local Queued Starts

The design stores prompts locally if max running sessions is reached.

Questions:

- Are queued starts persisted across app restart?
- If not, how is the user warned before quit?
- What happens if the target session file changes before queued prompt starts?
- Can queued messages include images/files whose paths disappear?
- Is local queueing better than attaching a worker and using Pi's own prompt queue?
- How does a queued start interact with user switching model/thinking before it runs?

Review target:

- Define persistence/loss semantics for local queues.
- Consider MVP simplification: block send when cap reached, or require user confirmation to queue locally.

---

## 9. Attachment Semantics

Requirements say selected files are shown as context attachments. The architecture maps non-image files to path references asking Pi to use the read tool.

Questions:

- Is path-reference behavior acceptable, or will users expect actual file contents to be sent?
- Should UI label non-image attachments as “referenced path” rather than “attached content”?
- What about outside-project files?
- What about paths with spaces, symlinks, deleted files, unreadable files, huge files, PDFs, notebooks, or binary blobs?
- Do absolute path references leak private filesystem structure to the model?
- Should MVP provide “send contents” vs “reference path”, or is that too much?
- How are attachment chips represented in resumed messages, if at all?

Review target:

- Clarify MVP attachment semantics in requirements.
- Make UI wording match actual behavior.

---

## 10. Image Handling

Images are base64 encoded for RPC.

Questions:

- Are Pi settings like `images.autoResize` and `images.blockImages` respected?
- Should the GUI resize before base64 to avoid huge memory usage?
- What is the memory/backpressure strategy for multiple large images?
- What happens if the model is switched after attachments are selected but before sending?
- Are MIME types reliably detected?
- How are unsupported images handled?

Review target:

- Define when image capability validation happens.
- Decide whether image preprocessing delegates to Pi or is performed in GUI backend.

---

## 11. Process Lifecycle and Crash Recovery

Questions:

- On app quit, should running agents be aborted by default, left running, or should the user choose?
- If the app sends `abort` then SIGTERM, can session files be corrupted or partial messages lost?
- Can the app reconnect to existing RPC workers after renderer/main crash? If not, state that explicitly.
- How are partial streamed assistant messages reconciled with `get_messages` after restart?
- Where are worker stderr diagnostics stored?
- How much diagnostic history is retained?
- How are zombie child processes prevented?

Review target:

- Define quit behavior and crash-recovery guarantees.
- Add diagnostics storage location and retention policy.

---

## 12. Extension UI Coverage

MVP claims extension UI is first-class.

Questions:

- Which methods are supported exactly?
  - Dialog: `select`, `confirm`, `input`, `editor`
  - Fire-and-forget: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
- How are timeouts displayed?
- What if a background session has multiple pending UI requests?
- Can Pi emit multiple dialog requests concurrently for one session, or only one blocking request?
- What happens if a stale response arrives after timeout?
- How do we expose degraded/no-op TUI-only extension APIs?
- Is “perfect custom UI rendering” explicitly post-MVP?

Review target:

- Define exact extension UI MVP subset and stale/timeout behavior.

---

## 13. Electron Security

The renderer has no direct Node/fs/process access.

Questions:

- What validation library/schema will be used for IPC payloads?
- Can the renderer request arbitrary file paths to be read/base64 encoded?
- Are file reads limited to paths selected via native picker or project roots?
- How do we prevent malicious rendered markdown/tool output from triggering unsafe links or IPC?
- Are file paths from tool output clickable? If yes, what is the safe open/reveal behavior?
- Do we need a strict Content Security Policy?
- Is remote content disabled?

Review target:

- Add explicit IPC validation and renderer hardening requirements.

---

## 14. Environment and Auth

Pi relies on env vars, auth files, OAuth tokens, proxies, offline flags, etc.

Questions:

- How does Electron inherit API keys when launched from Finder?
- Do we need macOS shell environment loading?
- How are `PI_OFFLINE`, proxy settings, telemetry/update-check settings respected?
- Is “local-only” compatible with Pi startup version checks/package checks unless offline is enabled?
- How are auth failures surfaced?
- Do we need a first-run diagnostics panel for missing API keys/model availability?

Review target:

- Define launch environment strategy.
- Clarify “local-only” as no GUI backend/cloud sync, while model providers still receive prompts/context through Pi as normal.

---

## 15. Packaging and Deployment

Questions:

- Does the app bundle Pi SDK, call global `pi`, or both?
- How are CLI and SDK version mismatches prevented?
- Is there a minimum supported Pi version?
- How are macOS permissions, code signing, app updates, and `userData` paths handled?
- How are logs/session-cache files cleaned up?
- Can users configure `PI_CODING_AGENT_DIR` or session dir?

Review target:

- Add packaging assumptions and MVP constraints.

---

## 16. MVP Scope Pressure

The MVP includes app shell, sessions, resume, streaming, attachments, model/thinking, slash commands, state indicators, concurrent sessions, steering/follow-up/abort, resource loading, and local-only operation.

Questions:

- Which features are truly required for first usable release?
- Should concurrent sessions, extension UI, ResourceInspector, and attachments all be MVP?
- What is the smallest end-to-end milestone that validates architecture?
- What can be deferred without violating the core product promise?

Suggested MVP validation path:

1. Single-session RPC worker.
2. Project picker.
3. New/resume session.
4. Streaming chat.
5. Abort.
6. Model/thinking display and switch.
7. Basic session sidebar.
8. Then add concurrency and attachments.

Review target:

- Tighten milestone definitions and prevent M1–M3 from depending on advanced features.

---

## 17. Suggested Acceptance Tests

### Early RPC / Worker Tests

- Spawn `pi --mode rpc` from Electron main with known cwd.
- Send `get_state`, verify `sessionFile`, `sessionId`, model, thinking level.
- Send prompt and receive `agent_start`, `message_update`, `agent_end`.
- Abort a long-running prompt and verify final state.
- Capture stderr diagnostics.
- Verify strict JSONL framing with embedded `U+2028` / `U+2029` inside JSON strings.

### Session Tests

- Create new session and verify session appears in sidebar.
- Resume session by file path.
- Confirm no duplicate worker is spawned for repeated open.
- Attempt duplicate open while running; verify existing worker is reused/focused.
- Verify external missing/deleted session file behavior.

### State Reducer Tests

- `agent_start` -> working.
- `message_update` text -> streaming overlay.
- `tool_execution_start` -> tool-running overlay.
- `queue_update` -> queued count.
- `extension_ui_request` dialog -> red dot / waiting for input.
- `compaction_start/end` and `auto_retry_start/end` overlays.
- `agent_end` clears working unless unresolved input/local queue remains.

### Attachment Tests

- Select image with image-capable model -> base64 image input.
- Select image with non-image model -> block/warn.
- Select text file -> path-reference prompt prefix.
- Select binary file -> path-reference with visible binary warning.
- Delete selected file before send -> clear error.

### Trust Tests

- Project with `.pi/settings.json` and no saved trust.
- Launch with approve and verify resources available.
- Launch with no-approve and verify protected resources skipped.
- Verify `AGENTS.md` / `CLAUDE.md` behavior matches Pi.

### Extension UI Tests

- Extension emits `confirm` while foreground -> dialog appears.
- Extension emits `confirm` while background -> sidebar red dot, no auto-switch.
- User responds -> worker continues.
- Timeout/stale response handled with diagnostic.

---

## 18. Highest-Risk Items to Resolve First

1. Version/path strategy for RPC CLI vs imported SDK.
2. Session-file ownership and duplicate-worker prevention.
3. Exact resume flow with `--session` vs `switch_session`.
4. Project trust fidelity and whether ResourceInspector can execute code.
5. State model: base state vs overlays and sidebar priority.
6. Finder-launched macOS environment/API-key availability.
7. Attachment semantics: path reference vs actual content.

---

## 19. Proposed Design Doc Updates

The design owner should consider adding these subsections to `docs/technical-architecture.md`:

- `Pi Version and Binary Resolution`
- `Session Ownership and Locking`
- `Exact Resume Algorithm`
- `Trust Resolution Strategy`
- `Resource Inspection Safety`
- `State Derivation and Sidebar Priority`
- `Local Queue Persistence Semantics`
- `Attachment Semantics and User-Facing Labels`
- `macOS Launch Environment and Auth`
- `Electron IPC Validation and CSP`
- `MVP Cut Line and Deferred Features`

---

## 20. Design Owner Response / Decision Log

Reviewed and incorporated into `docs/technical-architecture.md` v2. Valuable concerns changed the design in several places.

### Changes Made

1. **RPC/SDK boundary tightened**
   - Changed MVP to use **global Pi CLI RPC only** for execution and discovery-critical paths.
   - Removed MVP reliance on imported Pi SDK for session listing/resource inspection.
   - Added Pi binary resolution, configurable binary path, version display, and RPC smoke test.

2. **Session ownership/locking added**
   - Added canonical `sessionFile` realpath session keys.
   - Added in-memory main-process lock map to prevent duplicate GUI workers for the same session.
   - Defined duplicate open as focus/reuse existing worker.
   - Marked concurrent external Pi TUI/same-session modification as unsupported in MVP, with best-effort warning.

3. **Resume flow changed**
   - Removed fallback design that started a new RPC session then called `switch_session`.
   - MVP now requires `pi --mode rpc --session <sessionFile>` for resume.
   - If installed Pi does not support this, resume is blocked with diagnostics rather than risking extra session files or wrong extension startup events.
   - Added exact resume algorithm and cwd mismatch behavior.

4. **Project trust strategy clarified**
   - GUI does not parse or write `trust.json` in MVP.
   - Added per-run trust prompt choices: `--approve`, `--no-approve`, or no override to use Pi saved/default behavior.
   - Clarified `AGENTS.md` / `CLAUDE.md` are expected to load regardless of project trust unless Pi settings disable them.
   - Persistent “remember trust” deferred.

5. **ResourceInspector made safer**
   - Removed SDK `DefaultResourceLoader` from MVP Resource panel due possible extension/package side effects and duplicate execution.
   - MVP Resource panel now uses static filesystem discovery plus active RPC `get_commands` output only.
   - Static resources are labeled as discovered, not necessarily loaded.

6. **Slash-command scope clarified**
   - GUI MVP supports commands returned by `get_commands`: extension commands, prompt templates, skills.
   - Built-in TUI-only commands are explicitly unsupported as slash commands.
   - GUI-native equivalents should be buttons/menus.
   - Extension commands during streaming go through `prompt`, not `steer`/`follow_up`.

7. **State model changed**
   - Replaced single mutually exclusive state enum with base state plus overlays.
   - Added exact event reduction and sidebar priority rules.
   - Red dot is defined narrowly as supported extension UI dialog waiting for user input.

8. **Local queued-start semantics tightened**
   - No implicit queueing when concurrency cap is reached.
   - Default behavior blocks send and explains the cap.
   - User may explicitly queue a start; queued starts are in-memory only, warned on quit, and revalidated before running.

9. **Attachment semantics clarified**
   - Non-image files are now explicitly “referenced paths,” not attached/inlined contents.
   - Outside-project absolute paths require warning.
   - Deleted/unreadable files block send.
   - Attachment chips in resumed messages are best-effort only; Pi message text remains source of truth.

10. **Image handling clarified**
    - Validate model image capability at send time.
    - Main process encodes selected images sequentially.
    - No GUI hard size limit, but large-file warning is allowed.
    - GUI does not pre-resize in MVP unless smoke tests prove Pi RPC bypasses Pi image settings.

11. **Process lifecycle/crash recovery specified**
    - Quit prompts: Cancel Quit or Abort Agents and Quit.
    - No intentional orphan/background Pi workers after app quit.
    - No reconnect to existing RPC workers after main-process crash in MVP.
    - Logs go under Electron `userData` with rolling retention.

12. **Extension UI coverage specified**
    - Dialog methods: `select`, `confirm`, `input`, `editor`.
    - Fire-and-forget methods: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.
    - Multiple requests queue per session defensively.
    - Stale/timeout responses are ignored/logged if Pi rejects them.

13. **Electron security added**
    - Added `zod`/runtime schema validation requirement.
    - Renderer receives opaque attachment tokens, not arbitrary file read authority.
    - Added CSP, markdown sanitization, safe external links, and safe reveal-in-Finder behavior.

14. **Environment/auth added**
    - Added login-shell environment capture option for Finder-launched macOS apps.
    - Added auth/model diagnostics panel.
    - Clarified local-only means no GUI remote backend/sync; Pi/model providers still receive prompts/context per normal Pi behavior.

15. **MVP milestones tightened**
    - Added Pi binary resolution/smoke test to M1.
    - Kept one-session RPC path before session repository/resume.
    - Moved concurrency to M5.
    - Moved trust/resource panel to M6.

### Per-Section Reviewer Responses

This is the reviewer-facing response matrix. Each row states whether the design was changed, defended, or deferred, and where `docs/technical-architecture.md` was updated.

| # | Review area | Disposition | Response / decision |
|---:|---|---|---|
| 1 | RPC vs SDK Boundary | **Changed** | MVP now uses global Pi CLI RPC only. SDK use is removed from MVP runtime/discovery paths to avoid version skew. Added configurable Pi binary path, Finder-safe binary lookup, `pi --version`, and RPC smoke test. |
| 2 | Session Ownership and Duplicate Workers | **Changed** | Added canonical realpath session keys and a main-process lock map. Duplicate opens focus/reuse the existing worker. External same-session writers are unsupported in MVP and warned best-effort. |
| 3 | Session Resume Correctness | **Changed** | Removed `switch_session` fallback. Resume requires `pi --mode rpc --session <sessionFile>`. Exact attach algorithm verifies returned `sessionFile` matches requested canonical path. |
| 4 | Project Trust Fidelity | **Changed** | GUI does not write/parse `trust.json`. Trust prompt supports per-run `--approve`, per-run `--no-approve`, or no override to let Pi saved/default/user-global extension behavior apply. Persistent trust deferred. |
| 5 | ResourceInspector Safety | **Changed** | Removed SDK `DefaultResourceLoader` from MVP Resource panel because it can execute extension/package logic or duplicate side effects. MVP uses static discovery plus active RPC `get_commands`. |
| 6 | Slash Command Behavior | **Clarified** | GUI MVP supports commands returned by RPC `get_commands`: extension commands, prompt templates, skills. TUI-only built-ins are unsupported; GUI-native equivalents should be buttons/menus. Extension commands during streaming go through `prompt`. |
| 7 | Concurrent State Model | **Changed** | Replaced mutually exclusive state enum with base state plus overlays. Added event reducer rules and sidebar priority. Red dot means supported extension UI dialog waiting. |
| 8 | Local Queued Starts | **Changed** | No implicit local queueing. Cap reached blocks send by default; user can explicitly queue. Queued starts are in-memory only, warned on quit, and revalidated before execution. |
| 9 | Attachment Semantics | **Changed / requirement clarification recommended** | Non-image files are referenced paths, not inlined content. UI labels must say referenced path. Outside-project paths warn about absolute path exposure. Missing/unreadable files block send. |
| 10 | Image Handling | **Clarified** | Validate image support at send time against current model. Main process encodes images sequentially. No GUI hard size limit; large-file warning allowed. Pi image settings behavior must be smoke-tested. |
| 11 | Process Lifecycle and Crash Recovery | **Changed** | Quit offers Cancel or Abort Agents and Quit. No intentional orphan workers. No reconnect to existing RPC workers after main-process crash in MVP. Added log location/retention. |
| 12 | Extension UI Coverage | **Clarified** | MVP supports `select`, `confirm`, `input`, `editor`, plus fire-and-forget `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`. Custom/TUI-only UI rendering is post-MVP. |
| 13 | Electron Security | **Changed** | Added schema-validated IPC, opaque file tokens, no arbitrary renderer file reads, CSP, markdown sanitization, safe external links, and safe reveal-in-Finder behavior. |
| 14 | Environment and Auth | **Changed** | Added macOS login-shell environment capture option, Pi-relevant env preservation, auth/model diagnostics, and local-only clarification. |
| 15 | Packaging and Deployment | **Clarified / partially deferred** | MVP shells out to user-installed global Pi CLI. Bundled Pi/SDK and update machinery are deferred. Added binary path/version diagnostics and userData log/cache assumptions. |
| 16 | MVP Scope Pressure | **Changed** | Milestones tightened: M1/M2 prove binary/RPC/single-session first; concurrency waits until M5; trust/resource panel waits until M6. |
| 17 | Suggested Acceptance Tests | **Accepted** | Acceptance tests were incorporated into Testing Strategy, emphasizing binary resolution, RPC smoke, resume, duplicate worker prevention, state reducer, attachments, and resource labels. |
| 18 | Highest-Risk Items | **Accepted** | Risks are reflected in Key Risks and mitigations: Pi path/version, resume compatibility, duplicate writers, trust fidelity, resource side effects, Finder env, attachment expectations. |
| 19 | Proposed Design Doc Updates | **Accepted** | Corresponding sections were added throughout `docs/technical-architecture.md` v2. |

### Design Doc Update Mapping

For every review area where the answer changed or clarified the architecture, `docs/technical-architecture.md` was updated. Mapping:

| Review area | Design doc updated? | Updated sections |
|---|---:|---|
| 1. RPC vs SDK Boundary | Yes | §2, §3, §10, §14, §23 |
| 2. Session Ownership and Duplicate Workers | Yes | §4, §5, §23 |
| 3. Session Resume Correctness | Yes | §4, §5, §22, §23 |
| 4. Project Trust Fidelity | Yes | §13, §14, §22, §23 |
| 5. ResourceInspector Safety | Yes | §2, §10, §14, §23 |
| 6. Slash Command Behavior | Yes | §12 |
| 7. Concurrent State Model | Yes | §8, §9 |
| 8. Local Queued Starts | Yes | §6, §20 |
| 9. Attachment Semantics | Yes | §11, §17 |
| 10. Image Handling | Yes | §11, §20, §23 |
| 11. Process Lifecycle and Crash Recovery | Yes | §4, §19, §20 |
| 12. Extension UI Coverage | Yes | §8, §15 |
| 13. Electron Security | Yes | §17 |
| 14. Environment and Auth | Yes | §3, §18, §19 |
| 15. Packaging and Deployment | Yes | §3, §18, §19, §22 |
| 16. MVP Scope Pressure | Yes | §22 |
| 17. Suggested Acceptance Tests | Yes | §21 |
| 18. Highest-Risk Items | Yes | §23 |
| 19. Proposed Design Doc Updates | Yes | Added corresponding sections throughout v2 |

### Requirement Clarifications Recommended

These do not require changing `docs/requirements.md` immediately, but should be reflected if the product requirements are revised:

- “File attachments” in MVP should say non-image files are **referenced paths**, not guaranteed inlined contents.
- Slash commands should be scoped to RPC-supported commands returned by `get_commands`; TUI-only built-ins are excluded.
- Project trust persistence is post-MVP; per-run trust is MVP.
- Resource display in MVP is partly static discovery and partly active-worker observed data, not a guaranteed complete Pi resource loader mirror.

### Highest Remaining Risks

1. Verify real support for `pi --mode rpc --session <path>`.
2. Verify Pi image settings behavior in RPC mode (`images.blockImages`, `images.autoResize`).
3. Validate macOS Finder launch environment capture across common shell setups.
4. Decide minimum supported Pi version after smoke tests.
5. Determine how reliable external session modification detection can be without Pi-level locking.

### Early Acceptance Tests Added/Emphasized

- Pi binary path resolution from Finder launch.
- `pi --version` and RPC `get_state` smoke test.
- Resume session via `pi --mode rpc --session <path>` and verify returned session file.
- Duplicate GUI open reuses existing worker.
- State reducer base+overlay priority, especially red-dot waiting input.
- Non-image attachment chip says referenced path and generates path-reference prompt prefix.
- Resource panel labels static resources as discovered vs loaded-by-active-worker.

---

## 21. Reviewer Recheck After Architecture v2

Reviewer pass after reading updated `docs/technical-architecture.md` v2 and unchanged `docs/requirements.md`.

Overall assessment: v2 is materially stronger. The design now handles many original risks well: RPC/SDK boundary, duplicate workers, resume side effects, ResourceInspector safety, state overlays, attachment labeling, Electron IPC security, and macOS environment/auth. This is much closer to implementation-ready.

However, a few gaps remain. Please do one more focused design-owner pass on the items below.

### 21.1 Requirements Doc Is Now Stale vs Architecture

`docs/requirements.md` still states or implies broader behavior than architecture v2 now promises.

Examples:

- Slash commands: requirements say “Pi slash commands must work” broadly, while architecture v2 supports only RPC `get_commands` commands: extension commands, prompt templates, and skills. TUI-only built-ins are excluded.
- Resource display: requirements say the GUI should display “what context/resources were loaded,” while architecture v2 displays static discovered resources plus RPC-observed commands. Static discovered resources are not necessarily loaded.
- File attachments: requirements call non-image files “context attachments,” while architecture v2 says non-image files are referenced paths, not inlined contents.
- Open questions: requirements still says no major product-requirement questions remain, but v2 introduces clarified MVP limitations: no persistent trust, no TUI built-in slash commands, no guaranteed loaded-resource mirror.

Questions / requested action:

- Please update `docs/requirements.md` to v0.4 or add a clarification section that aligns with v2.
- Make explicit that non-image file attachments are **referenced paths** in MVP.
- Scope slash commands to RPC-supported commands returned by `get_commands`.
- Clarify that resource panel labels may be `discovered` vs `loaded by active worker`, and MVP does not guarantee perfect loaded-resource inventory.
- Clarify persistent project trust is post-MVP.

Blocking concern: without this, implementation may appear to violate requirements even if it follows architecture v2.

### 21.2 RPC Smoke Test May Create Junk Sessions

Architecture v2 says startup runs a cheap RPC smoke test: spawn `pi --mode rpc`, send `get_state`, terminate.

Concern:

- If smoke test runs without `--no-session`, it may create empty persisted sessions or touch normal session storage.
- If it runs in a real project cwd with default trust behavior, it may load project resources unnecessarily during a health check.

Questions / requested action:

- Should smoke test explicitly run with `--no-session`?
- Should it use `--no-approve` to avoid loading project-local protected resources?
- Should it run in a temp cwd rather than the selected project?
- Should it disable startup network operations if user has offline mode set?

Suggested design text:

```text
RPC smoke test spawns `pi --mode rpc --no-session --no-approve` in a temporary cwd, sends `get_state`, validates a response, then terminates. It uses the same resolved Pi binary and environment as real workers, but does not create sessions or trust/load project-local resources.
```

### 21.3 Session Listing and Custom `sessionDir`

Architecture v2 avoids SDK and uses static JSONL session listing. It says the backend locates effective session directory from app override, env, or default Pi storage.

Concern:

- Pi also supports `sessionDir` in settings, including project/global settings and relative paths.
- Without parsing Pi settings or asking Pi for listing, GUI may miss prior sessions for projects that use configured `sessionDir`.
- Session resume is a core requirement, so this limitation needs explicit handling.

Questions / requested action:

- Does MVP support `sessionDir` from Pi settings files?
- If yes, what is the exact merge/precedence behavior? Pi precedence is CLI `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.
- If no, should requirements/architecture state that MVP session listing supports only default, env, and app-configured session dirs?
- Can the app use a lightweight static settings parser for only `sessionDir`, without executing resource loaders/extensions?
- How are relative `sessionDir` paths resolved for global vs project settings?

Review target:

- Add a clear `sessionDir` support policy to architecture and requirements.

### 21.4 Extension UI Clearing, Timeout, and Stale Red Dots

Architecture v2 says pending UI clears on `extension_ui_response` success or timeout-observed command failure.

Concern:

- Pi RPC docs show `extension_ui_response` is written to stdin, but it is not clearly documented as returning a normal command `response`.
- Pi owns timeout resolution. It is unclear what event tells the GUI that a timed-out request is no longer pending.
- If the GUI cannot observe timeout resolution, red-dot waiting indicators may become stale.

Questions / requested action:

- Does Pi emit a response to `extension_ui_response`?
- If a dialog method times out Pi-side, does Pi emit any event or failed response the GUI can use to clear pending UI?
- If not, should the GUI set a local timer based on request `timeout`, clear the pending dialog after timeout + grace, and mark it as `timed out locally`?
- What happens if user responds after timeout? Should UI suppress response entirely once local timeout passes, or send and log rejection?
- Can multiple dialog requests be pending concurrently for one session in practice, or is the per-session queue purely defensive?

Review target:

- Define exact pending-extension-UI lifecycle and stale red-dot clearing behavior.
- Add fake-RPC tests for timeout/no-timeout/stale-response cases.

### 21.5 Image Settings Behavior Is Still Unverified

Architecture v2 says Pi settings like `images.blockImages` and `images.autoResize` “should be respected by Pi if applied in the RPC path.”

Concern:

- This is too uncertain for MVP image support.
- If RPC accepts already-base64 images and bypasses Pi image preprocessing/settings, GUI behavior may diverge from Pi CLI/TUI.

Questions / requested action:

- Verify whether RPC prompt image handling respects `images.blockImages`.
- Verify whether RPC prompt image handling respects `images.autoResize`.
- If `blockImages` is true, should GUI block image sends before RPC?
- If `autoResize` is true but RPC does not resize, should GUI implement equivalent resizing in main process or mark it post-MVP?
- How will tests detect this? Do we need fixture images above Pi's resize threshold?

Review target:

- Replace “should be respected” with either verified behavior or a concrete fallback.

### 21.6 `agentDir` and `sessionDir` Override Application Needs Exactness

Architecture v2 says app settings may provide `agentDir` and `sessionDir` overrides.

Concern:

- CLI exposes `PI_CODING_AGENT_DIR` for agent dir and `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` for sessions.
- The design should specify exact propagation so static indexing and workers agree.

Questions / requested action:

- Is `agentDir` override passed via worker env `PI_CODING_AGENT_DIR`?
- Is `sessionDir` override passed as `--session-dir` or env `PI_CODING_AGENT_SESSION_DIR`?
- Which has precedence if both env and app setting exist?
- Does static session listing use the exact same effective session dir as workers?
- Does the diagnostics panel show these resolved values?

Review target:

- Add an “Effective Pi Environment and Directory Resolution” subsection.

### 21.7 Resume Support Must Be a Hard Gate

Architecture v2 makes `pi --mode rpc --session <sessionFile>` required and removes `switch_session` fallback. This is good.

Requested action:

- Make this a hard M3 acceptance gate:

```text
Given an existing session file, spawning `pi --mode rpc --session <file>` and calling `get_state` must return a `sessionFile` that canonicalizes to the requested file. If not, M3 cannot ship.
```

### 21.8 Trust Prompt Wording Should Avoid False Certainty

Because MVP does not parse `trust.json`, GUI may detect protected resources even when Pi already has saved trust for the project or a parent directory.

Requested action:

- Use wording like: “This project contains Pi resources that may require trust.”
- Avoid: “Trust is required.”
- Explain the three choices accurately:
  - Trust this run: force `--approve`.
  - Do not trust this run: force `--no-approve`.
  - Use Pi saved/default behavior: no override.

### 21.9 Resource Panel Labels Must Stay Strict

Architecture v2 handles this correctly, but requirements and future UI copy need to follow it.

Requested labels:

- `Discovered locally`
- `Available command from active Pi worker`
- `Possibly skipped / trust-gated`
- Avoid `Loaded` unless directly observed from active Pi worker.

Question:

- Are context markdown files ever observable via RPC as loaded, or only statically discovered? If only static, label them accordingly.

### 21.10 External Same-Session Modification Warning May Be Flaky

Architecture v2 proposes warning if an attached session file's mtime changes unexpectedly while the worker is not known to have written.

Concern:

- Pi writes asynchronously; differentiating worker writes from external writes may be unreliable.
- Noisy false warnings would reduce trust in the GUI.

Questions / requested action:

- Is this detection reliable enough for MVP?
- Should external modification detection be deferred or diagnostics-only?
- If kept, what exact heuristic prevents warnings on normal worker writes?

### 21.11 Summary of Remaining Must-Fix Items

Please prioritize these updates:

1. Update `docs/requirements.md` so product scope matches architecture v2.
2. Clarify RPC smoke test flags/cwd so it does not create junk sessions or load project resources.
3. Define `sessionDir` support policy, especially Pi settings `sessionDir`.
4. Define extension UI timeout/clear behavior to avoid stale red dots.
5. Verify or add fallback for RPC image settings behavior.
6. Specify exact `agentDir` / `sessionDir` env and CLI propagation.

After these are resolved, the design will likely be ready for implementation planning.

---

## 22. Design Owner Follow-Up After Reviewer Recheck

Reviewed section 21 follow-ups and updated both `docs/technical-architecture.md` and `docs/requirements.md` where the reviewer identified stale or underspecified design.

### 22.1 Requirements Doc Is Now Stale vs Architecture

**Disposition: Changed.**

`docs/requirements.md` was updated from v0.3 to v0.4.

Changes made:

- Non-image file attachments are explicitly **referenced paths** in MVP, not guaranteed inlined contents.
- Slash commands are scoped to RPC-supported commands returned by `get_commands`; TUI-only built-ins are excluded.
- Resource display now distinguishes `Discovered locally`, `Available command from active Pi worker`, and `Possibly skipped / trust-gated`.
- Persistent project trust is explicitly post-MVP.
- The “no major questions remain” section was replaced with “MVP Clarifications and Known Cut Lines.”
- Success criteria now say file prompts must be accurately labeled and slash commands mean RPC-supported slash commands.

Design doc impact: requirements alignment only; architecture already had most of this in v2.

### 22.2 RPC Smoke Test May Create Junk Sessions

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §3.

Decision:

- RPC smoke test must spawn `pi --mode rpc --no-session --no-approve`.
- It runs in a temporary empty cwd outside the selected project.
- It sends `get_state`, validates a response, then terminates.
- It uses the same resolved Pi binary and effective environment as real workers.
- It preserves user offline/version-check env such as `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1`.

This avoids empty persisted sessions and avoids loading project-local protected resources during health checks.

### 22.3 Session Listing and Custom `sessionDir`

**Disposition: Changed / clarified with an MVP limitation.**

`docs/technical-architecture.md` was updated in §3 and §10. `docs/requirements.md` was updated in §12.

Decision:

- Added `EffectivePiConfig` shared by static indexing and worker spawning.
- App `sessionDir` override is highest and maps to worker `--session-dir`.
- Inherited `PI_CODING_AGENT_SESSION_DIR` is used when no app override exists.
- If neither exists, the GUI statically parses JSON settings only for `sessionDir`:
  - global settings relative paths resolve relative to `agentDir`;
  - project settings relative paths resolve relative to `<cwd>/.pi`.
- Project `sessionDir` is authoritative only when the user explicitly chooses **Trust this run**. If trust is delegated to Pi saved/default behavior, the project `sessionDir` is shown as a non-authoritative candidate because MVP does not parse `trust.json`.
- Manual app-level `sessionDir` override is available for unusual locations.

Tradeoff: exact parity for saved-trust project `sessionDir` is deferred unless Pi exposes a listing/config API or the GUI adopts a version-pinned SDK.

### 22.4 Extension UI Clearing, Timeout, and Stale Red Dots

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §8, §15, §20, and §21.

Decision:

- GUI does not rely on `extension_ui_response` returning a normal RPC response.
- After the user responds, the GUI writes to stdin and clears the red dot locally.
- If the request has `timeout`, GUI starts a local `timeout + graceMs` timer, default grace 1000 ms.
- When local timeout fires, the GUI marks the request `timedOutLocally`, clears the red dot, disables response controls, and logs a diagnostic.
- Late responses after local timeout are suppressed, not sent.
- No-timeout requests stay pending until user response, worker exit/session close, or impossible cleanup events, which log diagnostics.
- Multiple pending dialog requests are queued defensively, although normal Pi behavior should block on one at a time.
- Added fake-RPC tests for timeout, no-timeout, stale clearing, and late-response suppression.

### 22.5 Image Settings Behavior Is Still Unverified

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §11, §20, §21, §22, and §23.

Decision:

- MVP no longer depends on uncertain RPC-side image preprocessing.
- GUI statically resolves image settings with the same lightweight settings parser.
- If `images.blockImages` is true, GUI blocks image sends before RPC.
- If `images.autoResize` is true or unset, GUI performs main-process resize to a 2000x2000 max bounding box before base64 encoding.
- If `images.autoResize` is false, GUI sends original image bytes.
- Tests must include block-images behavior and fixture images above the resize threshold.

Open validation remains useful, but correctness no longer depends on it.

### 22.6 `agentDir` and `sessionDir` Override Application Needs Exactness

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §3, §18, and §19.

Decision:

- App `agentDir` overrides inherited env and is propagated to workers as `PI_CODING_AGENT_DIR`.
- App `sessionDir` overrides inherited env and is passed to workers as `--session-dir`.
- If no app sessionDir exists, inherited `PI_CODING_AGENT_SESSION_DIR` is preserved and used.
- Static session indexing, image setting resolution, and worker spawning must use the same `EffectivePiConfig`.
- Diagnostics show resolved Pi binary, agentDir, sessionDir, sessionDirSource, trust override, and redacted env summary.

### 22.7 Resume Support Must Be a Hard Gate

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §22.

M3 now has a hard acceptance gate:

> Given an existing session file, spawning `pi --mode rpc --session <file>` and calling `get_state` must return a `sessionFile` that canonicalizes to the requested file. If not, M3 cannot ship.

### 22.8 Trust Prompt Wording Should Avoid False Certainty

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §13.

Decision:

- Prompt wording: “This project contains Pi resources that may require trust.”
- Avoid “Trust is required.”
- Choices are explicitly described as force `--approve`, force `--no-approve`, or use Pi saved/default behavior with no override.

### 22.9 Resource Panel Labels Must Stay Strict

**Disposition: Changed / reinforced.**

`docs/technical-architecture.md` was updated in §14. `docs/requirements.md` was updated in R9.

Strict labels:

- `Discovered locally`
- `Available command from active Pi worker`
- `Possibly skipped / trust-gated`

Context markdown files are only statically discovered in MVP because RPC does not expose their loaded status directly. They must not be labeled as loaded unless a future API directly observes that fact.

### 22.10 External Same-Session Modification Warning May Be Flaky

**Disposition: Changed / deferred.**

`docs/technical-architecture.md` was updated in §4 and §23.

Decision:

- Proactive mtime-based user warnings are deferred for MVP.
- External same-session writes remain unsupported.
- Mtime/hash observations may be recorded as diagnostics only.
- User-visible behavior is manual refresh/reopen from Pi's persisted session file.

This avoids noisy false warnings from normal asynchronous Pi writes.

### 22.11 Summary of Must-Fix Items

All six must-fix items were addressed:

1. **Requirements updated**: `docs/requirements.md` v0.4 now matches architecture limitations.
2. **RPC smoke test clarified**: `--no-session --no-approve` in temp cwd.
3. **SessionDir policy defined**: `EffectivePiConfig`, static settings parser, clear trust-dependent limitation.
4. **Extension UI timeout clearing defined**: local timeout + grace prevents stale red dots.
5. **Image settings fallback added**: GUI enforces block/resize before RPC.
6. **agentDir/sessionDir propagation exactness added**: env/CLI precedence specified and diagnostics required.

### Updated Remaining Risks

- Exact saved-trust project `sessionDir` parity remains limited without parsing Pi trust or using version-pinned SDK/API.
- `pi --mode rpc --session <file>` canonical-return behavior remains the hard M3 gate.
- Main-process image resizing requires choosing and validating an implementation library/API during implementation.

---

## 23. Reviewer Recheck After Design Owner Follow-Up

Reviewer pass after reading updated `docs/technical-architecture.md` and `docs/requirements.md` v0.4.

Overall assessment: the major design/requirements alignment issues are now addressed. The remaining items below are not broad architecture blockers, but they should be clarified before or during M1–M4 implementation to prevent surprises.

### 23.1 RPC Smoke Test May Still Load Global/User Resources

The smoke test now uses `pi --mode rpc --no-session --no-approve` in a temporary cwd. This prevents persisted sessions and project-local trust/resource loading.

Concern:

- `--no-approve` only affects project trust. The smoke test may still load global/user extensions, skills, prompts, settings, packages, or other startup resources.
- Global extensions can have side effects, slow startup, network calls, or errors.
- A health check that runs at app startup should ideally be low-side-effect.

Questions / requested action:

- Should there be two smoke tests?
  1. **Minimal binary/RPC health test** with `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files` to verify RPC availability with minimal side effects.
  2. **Real worker startup diagnostics** when opening a project/session, using normal resources/settings.
- Or is it intentional that the startup smoke test exercises global user resources too?
- If intentional, how often does it run, and how are global-extension side effects explained/debugged?

Suggested direction:

- Use a minimal no-resource smoke test for M1 binary/RPC health.
- Let actual worker attach/open surface real resource-loading failures.

### 23.2 Trust-Dependent Project Settings Also Affect Image Settings

The design now statically parses safe settings including `sessionDir` and image settings. It defines cautious handling for project `sessionDir` when trust is delegated to Pi saved/default behavior.

Concern:

- The same trust ambiguity applies to project `images.blockImages` and `images.autoResize`.
- If the GUI does not parse Pi `trust.json`, it may not know whether project image settings are effective when user chooses “Use Pi saved/default behavior.”
- Because the GUI now enforces image blocking/resizing before RPC, incorrect effective image settings could diverge from Pi behavior.

Questions / requested action:

- Are project image settings authoritative only when user chooses **Trust this run**, same as project `sessionDir`?
- If trust is delegated/default, are project image settings ignored, treated as candidates, or applied conservatively?
- If `.pi/settings.json` says `images.blockImages: true` and trust is delegated, should GUI block images to be safe, or follow global/default because project trust is unresolved from GUI perspective?
- Should the diagnostics panel show the source of each effective image setting, not just the final value?

Review target:

- Extend the `EffectivePiConfig` rules to explicitly cover trust-dependent image settings, not only `sessionDir`.

### 23.3 Candidate `sessionDir` Scanning Needs Bounds

The design may include project `sessionDir` as a non-authoritative candidate when trust is delegated to Pi saved/default behavior.

Concern:

- A project-controlled `.pi/settings.json` could point `sessionDir` at a huge directory, a sensitive absolute path, a network mount, or `/`.
- Even static JSONL scanning can become expensive or surprising if unbounded.

Questions / requested action:

- Are candidate session directories scanned automatically, or only after user enables them?
- What bounds exist for candidate scanning: max files, max depth, max bytes, timeout, allowed directory shape?
- Are absolute candidate paths outside the project/agent dir shown with a warning before scanning?
- Should candidate dirs be listed but not scanned until user confirms?

Suggested direction:

- Authoritative session dirs may be scanned normally.
- Non-authoritative project-setting candidate dirs should require explicit user confirmation or be capped aggressively.

### 23.4 Extension UI Response Clearing Should Account for Write Failure

The design clears the red dot locally after writing an `extension_ui_response` to stdin and does not rely on a normal RPC response.

Concern:

- The stdin write can fail if the worker exited, stdin is closed, or the pipe errors.
- Clearing immediately on attempted write may hide a still-unresolved or failed response path.

Questions / requested action:

- Does `respondToExtensionUi` resolve only after the response is successfully queued/written to stdin?
- On EPIPE/closed worker/write failure, should the session go to `error` and keep/restore diagnostic UI rather than silently clearing?
- Should tests include worker exit before response and stdin write failure?

Suggested direction:

- Clear the red dot after the main process successfully enqueues the write while the worker is alive.
- If write/enqueue fails, mark the request/session error and show diagnostics.

### 23.5 Image Resizing Implementation Is an M4 Packaging Risk

The design now requires GUI-side resizing to 2000x2000 when `images.autoResize` is true/unset.

Concern:

- Image resizing in Electron main may require a native dependency such as `sharp`, which affects packaging, codesigning/notarization, app size, and architecture-specific builds.
- Pure JS libraries may be slower or memory-heavy for large images.

Questions / requested action:

- Which image library/API will be used for resizing in M4?
- Does it support macOS x64/arm64 Electron packaging reliably?
- What memory strategy is used for very large images if there is intentionally no hard GUI file-size limit?
- Is a large-image confirmation sufficient, or do we need a practical safety cap to avoid OOM despite the “no file-size limit” requirement?

Review target:

- Add an implementation note or spike in M4 for image resizing/package validation.

### 23.6 Settings Parser Scope Should Be Explicitly Narrow and Non-Authoritative

The design includes a lightweight static settings parser for safe scalar settings.

Concern:

- This can grow into a partial Pi settings implementation and drift from Pi behavior.
- Settings merge/trust behavior can be subtle.

Questions / requested action:

- Is the parser explicitly limited to `sessionDir` and `images.*` for MVP?
- Does it ignore all other settings even if present?
- Does it surface parse errors as diagnostics without blocking worker launch?
- Is the active worker still the source of truth for settings-driven behavior where RPC/Pi exposes it?

Suggested direction:

- Document that this parser is a narrow preflight helper, not a general Pi settings implementation.

### 23.7 Final Status

No current broad architecture blockers remain. The highest implementation-risk items are now:

1. Hard M3 verification of `pi --mode rpc --session <file>`.
2. Minimal-vs-real RPC smoke test decision.
3. Trust-dependent project image settings resolution.
4. Bounded candidate `sessionDir` scanning.
5. Extension UI write-failure handling.
6. Image resizing implementation/package spike.

---

## 24. Design Owner Follow-Up After Reviewer Recheck 23

Reviewed section 23 follow-ups and updated `docs/technical-architecture.md` and `docs/requirements.md` where needed. No broad architecture changes were required, but several implementation-critical details were tightened.

### 24.1 RPC Smoke Test May Still Load Global/User Resources

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §3.

Decision:

- M1 startup health uses a **minimal binary/RPC smoke test**, not a real-resource startup test.
- Command shape: `pi --mode rpc --no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline` in a temporary empty cwd.
- The test sends `get_state`, validates RPC responsiveness, then terminates.
- It intentionally does not exercise global/user extensions, skills, prompts, context files, package checks, or project resources.
- Real worker startup diagnostics happen when opening a project/session/new worker and use normal selected resources/trust behavior.
- Minimal smoke-test result is cached for the resolved binary/version and rerun on app startup, binary path changes, explicit diagnostics refresh, or after failed worker spawn.

### 24.2 Trust-Dependent Project Settings Also Affect Image Settings

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §3 and §23.

Decision:

- The same trust ambiguity now explicitly applies to project image settings.
- App/global image settings are authoritative.
- Project image settings are authoritative only for **Trust this run**.
- If trust is delegated/default and project settings are only candidates:
  - `images.blockImages: true` is applied conservatively because blocking is privacy-safe.
  - `images.blockImages: false` is ignored unless authoritative.
  - `images.autoResize: false` is ignored unless authoritative because disabling resize increases memory/provider risk.
  - `images.autoResize: true` may be applied conservatively; default remains `true`.
- `EffectivePiConfig.imageSettings` now carries per-setting sources and candidate warnings so diagnostics can show why a value was used.

### 24.3 Candidate `sessionDir` Scanning Needs Bounds

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §10 and §23.

Decision:

- Non-authoritative candidate session directories are **not scanned automatically**.
- User must explicitly enable scanning after seeing the resolved path and warnings.
- Candidate scanning bounds:
  - only `.jsonl` files;
  - max depth 3;
  - max 5,000 candidate files;
  - max 100 MB total file bytes read for headers/metadata;
  - max 5 seconds wall time per candidate dir;
  - canonicalize roots and avoid symlink loops.
- Absolute candidate paths outside the project or agent dir are shown with warning before scanning.
- Authoritative dirs are scanned automatically with normal safety bounds.

### 24.4 Extension UI Response Clearing Should Account for Write Failure

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §15, §20, and §21.

Decision:

- `respondToExtensionUi` resolves only after main process successfully queues/writes the response to worker stdin while the worker is alive.
- Red dot clears only after successful enqueue/write.
- On `EPIPE`, closed stdin, worker exit, or stream error, the pending request is marked failed, session base state becomes `error`, and diagnostics are shown.
- Tests now include worker exit before response and stdin write failure.

### 24.5 Image Resizing Implementation Is an M4 Packaging Risk

**Disposition: Changed / added M4 spike.**

`docs/technical-architecture.md` was updated in §11, §22, and §23. `docs/requirements.md` was also clarified to allow crash-prevention safety guards.

Decision:

- M4 now requires an image resizing/package spike before image support ships.
- Preferred implementation path is Electron/macOS-friendly and packaging-light: try Electron `nativeImage` plus a pure-JS metadata sniffer for PNG/JPEG/WebP; evaluate `sharp` only if built-in APIs cannot meet quality/format needs.
- The spike must validate macOS arm64/x64 packaging, signing/notarization impact, app size, and memory use on large images.
- Processing remains sequential.
- Requirements now clarify there is no low arbitrary product-level file-size limit, but the GUI may enforce crash-prevention safety guards to avoid OOM/instability.
- Initial implementation targets warnings above 25 MB compressed or 50 megapixels decoded, with rejection/manual override threshold to be validated in the spike.

### 24.6 Settings Parser Scope Should Be Explicitly Narrow and Non-Authoritative

**Disposition: Changed.**

`docs/technical-architecture.md` was updated in §3.

Decision:

- Lightweight settings parser is explicitly limited to `sessionDir`, `images.blockImages`, and `images.autoResize` for MVP.
- It ignores all other settings even if present.
- It is a narrow preflight helper, not a general Pi settings implementation.
- Parse errors are diagnostics only and do not block worker launch.
- The active Pi worker remains source of truth for settings-driven behavior exposed directly by RPC/Pi.

### 24.7 Final Status / Remaining Implementation Risks

No broad architecture blockers remain from this pass. Remaining implementation risks are now explicitly tracked:

1. Hard M3 verification of `pi --mode rpc --session <file>` canonical-return behavior.
2. Minimal smoke-test flags must be validated against the minimum supported Pi version.
3. Conservative image-setting behavior may intentionally differ from unresolved saved-trust project behavior, but diagnostics will explain candidate sources.
4. Candidate `sessionDir` scanning needs careful bounded implementation.
5. Extension UI stdin write-failure path needs fake-RPC coverage.
6. Image resizing/package spike must be completed before M4 image support ships.

---

## 25. Reviewer Sign-Off for Implementation Planning

Reviewer sign-off after reading the design owner follow-up in §24 plus updated `docs/technical-architecture.md` and `docs/requirements.md` v0.4.

### Sign-Off Status

**Approved for implementation planning.**

No broad architecture blockers remain. The design is now sufficiently explicit about MVP scope, RPC-first integration, session ownership, trust/resource limitations, attachment semantics, extension UI behavior, Electron security, and implementation milestones.

### Minor Implementation Notes to Track

These are not design blockers and can be handled during implementation:

1. **Doc consistency for smoke-test flags**
   - Architecture §3 specifies the full minimal smoke-test command with `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline`.
   - Some milestone/risk summaries still use shorthand like `--no-session --no-approve`; implementers should follow the full §3 command.

2. **Authoritative session-dir scan bounds**
   - Candidate session-dir scanning has explicit limits.
   - Implementation should also apply practical safety bounds to authoritative/default session dirs so very large session stores do not hang the UI.

3. **Trust-dependent image-setting divergence**
   - Conservative handling for unresolved project image settings is acceptable for MVP.
   - Diagnostics should clearly show effective values, sources, and candidate ignored/applied values.

4. **Image resizing/package spike**
   - Image support should not be considered shippable until the M4 spike validates resizing implementation, memory behavior, macOS arm64/x64 packaging, and signing/notarization impact.

5. **Hard M3 resume gate**
   - `pi --mode rpc --session <file>` canonical-return behavior remains the most important early technical gate.
   - If this fails, pause M3 and revisit resume architecture before continuing.

### Final Recommendation

Proceed with M1/M2 implementation. Keep the review notes open as an implementation checklist, but no further design-owner response is required before coding begins.

---

## 26. Design Owner Final Polish After Reviewer Sign-Off

Final pass requested after reviewer sign-off. No architecture changes were needed, but two reviewer minor implementation notes were converted into explicit design/doc tracking items.

### 26.1 Smoke-Test Flag Consistency

**Disposition: Documentation polish / tracked.**

`docs/technical-architecture.md` was updated in §21, §22, and §23 so milestone, testing, and risk summaries use the full minimal smoke-test command rather than shorthand.

Canonical minimal smoke-test flags are now consistently documented as:

```text
--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline
```

Implementation should follow §3 as the source of truth.

### 26.2 Authoritative Session-Dir Scan Bounds

**Disposition: Documentation polish / tracked.**

`docs/technical-architecture.md` was updated in §10 to add practical safety bounds for authoritative/default session directories as well as candidate directories.

Authoritative scan initial targets:

- `.jsonl` files only;
- max depth 4;
- max 20,000 candidate files;
- max 250 MB total header/metadata bytes read;
- max 15 seconds wall time per scan pass;
- canonicalize roots and avoid symlink loops;
- show partial-results diagnostics if limits are hit.

Candidate dirs remain stricter and require explicit user enablement.

### 26.3 Final Status

No new design risks were introduced. Reviewer sign-off remains valid. These final edits are implementation-checklist clarifications only.
