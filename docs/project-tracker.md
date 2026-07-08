# Pi Deck MVP Tracker

Status: active implementation tracker  
Last updated: 2026-07-05  
Source plan: `docs/project-task-breakdown.md`  
Worktree setup: `docs/git-worktree-parallel-setup.md`  
Update cadence: daily during active implementation; weekly milestone review.

## Status Legend

| Status      | Meaning                                    |
| ----------- | ------------------------------------------ |
| Not Started | No implementation work yet                 |
| In Progress | Actively being implemented                 |
| Blocked     | Cannot proceed without decision/dependency |
| In Review   | PR/design/test review active               |
| Done        | Meets acceptance criteria                  |
| Deferred    | Explicitly moved out of MVP                |

## Current Dogfood TODO List — Source of Truth

This section supersedes stale milestone optimism below. Pi Deck is currently good enough for a **single active real Pi chat smoke**, not yet a daily-use multi-session control plane.

### Current working baseline

- [x] Secure Electron shell with sandboxed renderer/preload IPC.
- [x] Fake backend chat demo.
- [x] Opt-in real backend launch through `scripts/dev-real-pi.sh` / `scripts/launch-real-pi.sh`.
- [x] Single active real `pi --mode rpc` worker can load state/messages, stream prompts, abort, and clean up on quit.
- [x] Real mode hides fake/mock sessions and shows active worker model/thinking info instead of fake Claude placeholders.
- [x] Expected worker exits during close/reset no longer crash or poison closed windows.
- [x] Tool-like JSON payloads and Pi tool-execution lifecycle events render as expandable/running tool cards instead of looking stuck.
- [x] `+ New real session` creates another in-window real worker, shows an optimistic starting row, and keeps previous in-window session rows.
- [x] Real mode scans the authoritative session directory for prior sessions in the launch project.
- [x] Clicking a saved session attempts `pi --mode rpc --session <file>` and verifies `get_state.sessionFile`.
- [x] Playwright Electron E2E regression tests cover fake launch, real startup failure labeling, real no-fallback/send-enabled smoke, and saved-session refresh/resume.
- [x] Real-mode UI simplified: sidebar uses only the compact `+` for new sessions, saved rows are concise, model controls moved into the composer, and startup no longer flashes the legacy fake/local UI.
- [x] Real-mode sidebar shows the 5 most recent sessions first with relative timestamps; older sessions are behind a Browse older sessions control and hover shows a readable timestamp.
- [x] Real mode can list Pi models and switch model/thinking through RPC from the composer.
- [x] New real session creation shows an immediate optimistic starting row, returns before loading full messages, and prewarms one spare real worker.
- [x] Real-mode project picker resets the active real worker to the selected cwd, persists the selected cwd for later launches, and refreshes saved sessions for that project.
- [x] Authoritative session scanning can optionally include a project `sessionDir` candidate via explicit `PI_DECK_SCAN_PROJECT_SESSION_DIR_CANDIDATE=1` opt-in.
- [x] Real prompt attachments send through main-process-owned opaque tokens: image inputs are sent natively, non-image files are referenced by path.
- [x] Drag/drop and paste image attachments show thumbnails before send and in live conversation bubbles.
- [x] Drag/drop regular files are imported through preload-owned Electron file-path extraction, converted to opaque main-process tokens, and deduped in the composer.
- [x] Resumed sessions restore persisted image previews from Pi message content.
- [x] Session usage stats refresh after agent turns and display in a floating popover.
- [x] Saved sessions can be deleted individually or in bulk before or after resume; attached runtimes are closed first and files are moved to Trash when possible.
- [x] User-facing renderer copy no longer leaks internal Eng/worktree/default development state.
- [x] Starting experience formalized through `scripts/start-pi-deck.mjs` and npm aliases: `npm start`, `npm run deck:real -- <project>`, `npm run dev:real -- <project>`, and `npm run deck:fake`.
- [x] Real Pi smoke commands added: `npm run smoke:real` for get_state/get_messages and `npm run smoke:real:prompt` for a minimal authenticated prompt/agent_end round-trip.
- [x] Live working-session reconciliation added: renderer can request runtime-specific snapshots and clears stale working state from persisted Pi messages when completion events are missed.
- [x] Async provider/usage-limit errors emitted after prompt acceptance are surfaced as session errors instead of being treated as normal idle completion.
- [x] Long active runs with no visible output show elapsed time, last backend phase, and an explicit no-visible-output-yet explanation instead of a bare stuck-looking spinner.

### Immediate execution order — current priority stack

1. **P0 validation pass:** persistent new-session restart/resume, messy session-dir scanning, broader resume, multi-project project picker handoff.
2. **P0 multi-worker hardening:** per-runtime event routing, duplicate-open reuse, restart/resume/error stress coverage.
3. **M5 scheduler:** default concurrency cap 4, hard cap 20, blocked-send/explicit queue states.
4. **Active-run controls:** steer, follow-up, abort/queue count polish.
5. **Real slash commands:** active-worker `get_commands` picker/insertion, or hide real-mode slash UI until available.
6. **Tool lifecycle cards:** full start/update/end/error cards with large-output safety.
7. **Recovery/diagnostics:** worker reopen/retry, session reconciliation, binary/config/worker/stderr diagnostics panel.
8. **Attachment/image hardening:** image resize/package spike, large-file policy, provider validation.
9. **Trust/resource/extension UI:** per-run trust prompt, static resource panel, supported extension dialogs/red dots.
10. **Release readiness:** real Pi smoke matrix execution, limitations notes, expanded E2E coverage.

Latest implementation note: reducer/event overlay groundwork has started. `src/renderer/sessionState.ts` now has a documented event reducer with fixture-backed tests from `docs/state-reducer-fixtures.json`, and the renderer handles queue/compaction/retry/extension-waiting events for sidebar overlays. Initial backend adapter stress tests now cover concurrent fake workers, runtime-id event routing, and closing one runtime without dropping another; real Pi/project/session identity stress coverage remains. A real-mode fake-Pi E2E now verifies background-session events stay routed to the correct attached session while the user creates/prompts another session. Concurrent duplicate resume is guarded with a pending-resume lock and fake-Pi E2E coverage verifies duplicate resume calls return the same runtime. Session repository scan regression coverage now includes symlink/depth/file-count/total-byte/wall-time bounds, and real mode passes authoritative/candidate scan bounds explicitly. Real-mode project picker handoff now has E2E regressions using fake Pi that switch projects, reset the worker, verify selected cwd persistence across relaunch, and verify a prompted project-A session is resumable after switching to project B and back.

### P0 — Required before Pi Deck can be dogfooded comfortably

1. **Persistent/resume-backed real new-session flow**
   - Current behavior: `+ New real session` creates another in-window real worker, shows an optimistic row, and reports when Pi returns a backing `sessionFile`.
   - Regression coverage: fake-Pi E2E confirms a newly prompted session is visible/resumable after app restart.
   - Regression coverage: fake-Pi E2E confirms a prompted project-A session is hidden after switching to project B, then visible/resumable after switching back to project A.
   - Required before closing P0: hands-on confirmation that newly prompted sessions are visible/resumable after app restart and project switches on real Pi.

2. **Harden real session repository scanning**
   - Current behavior: scans authoritative session dir for current launch project, skips symlinks, and uses bounded depth/file/byte/time reads.
   - Current behavior: refresh button updates saved sessions without relaunch.
   - Current behavior: project `sessionDir` candidates can be scanned only with explicit `PI_DECK_SCAN_PROJECT_SESSION_DIR_CANDIDATE=1` opt-in and stricter bounds.
   - Regression coverage: messy dirs, symlink skip, depth cap, file-count cap, total-byte cap, and wall-time cap.
   - Required before closing P0: hands-on validation on messy real session dirs.

3. **Harden resume existing sessions**
   - Current behavior: clicking a saved row spawns `pi --mode rpc --session <sessionFile>` and verifies `get_state.sessionFile` canonicalizes to the requested file.
   - Current behavior: saved/resumed sessions remain deletable; attached runtime locks are closed before delete.
   - Current behavior: missing/unreadable saved-session files are removed from the visible list when resume fails.
   - Regression coverage: fake-Pi E2E covers successful resume and missing-file resume failure removal.
   - Required before closing P0: broader real Pi validation.

4. **Harden multiple real workers and event routing**
   - Basic multiple-worker support exists for in-window new sessions and resumed sessions; duplicate known session files reuse an attached worker.
   - Renderer reducer/sidebar overlay groundwork is in progress with fixture-backed tests.
   - Initial backend adapter stress coverage exists for concurrent fake workers, runtime-id routing, and one-runtime close isolation.
   - Regression coverage: real-mode fake-Pi E2E confirms a background session can finish streaming while another session is created/prompted, and each transcript remains on the correct sidebar row.
   - Regression coverage: concurrent duplicate resume calls for the same session file are collapsed through a pending-resume lock and return the same runtime.
   - Still required: real Pi multi-worker validation, scheduler integration, per-project/session identity stress tests, and no event leakage under restart/resume/error cases.

5. **Project picker → real session handoff**
   - Current behavior: in real mode, selecting/opening a project resets the worker, persists the selected cwd, and starts/lists sessions for that cwd.
   - Regression coverage: fake-Pi E2E switches from project A to project B through the project picker path and verifies project B persists across relaunch without `PI_DECK_PROJECT_CWD`.
   - Required before closing P0: real Pi hands-on validation across multiple projects and clearer trust/permission UX.

### P1 — Needed for practical daily use

6. **Harden real model list/switching and thinking controls**
   - Current behavior: composer lists real Pi models and thinking levels and calls `set_model` / `set_thinking_level`.
   - Remaining: capability-aware thinking labels and more validation across providers.

7. **Real attachment polish**
   - Implemented: native picker tokens, referenced-path sends, image sends, drag/drop/paste image import, drag/drop regular file import, composer dedupe, live/resumed thumbnails.
   - Remaining: image resizing/large-file policy and broader real-provider validation.

8. **Real slash commands**
   - Fake picker exists.
   - Need active worker command discovery/insertion, or hide in real mode until supported.

9. **Full tool cards**
   - Interim collapsed JSON cards exist.
   - Need real lifecycle cards: command/read/edit/write start, running, success/error, stdout/stderr/output.

10. **Error recovery**
    - Reopen/retry crashed workers.
    - Refresh session list and reconcile persisted messages after failures.

### P2 — MVP control-plane completion

11. Scheduler/concurrency cap with queue states.
12. Steer/follow-up controls while a run is active.
13. Explicit quit flow for running/queued sessions.
14. Diagnostics panel for Pi binary/config/workers/stderr/session files.
15. Project trust prompt and static resource panel.
16. Extension UI dialogs and background red-dot behavior.
17. Image validation/resizing/package spike and provider-specific attachment validation.
18. Release-readiness matrix execution and limitations notes.
19. Expand E2E coverage for tool collapse, attachment flows, session deletion, and close/cleanup regressions.

## 1. Critical Path Tracker

These items should be started earliest and reviewed frequently.

| ID    | Critical item                                                                 | Owner                | Status      | Target       | Blocker / note                                                                                                                                                                  |
| ----- | ----------------------------------------------------------------------------- | -------------------- | ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP-1  | G0 contract freeze: PiAdapter, IPC, events, state, timeline, attachment model | Tech Lead            | Not Started | Pre-M1       | Blocks broad parallel work                                                                                                                                                      |
| CP-2  | Pi binary resolution and version diagnostics                                  | Platform             | Done        | M1           | Implemented in `src/main/platform/piEnvironment.ts`; real Finder/Pi validation pending                                                                                          |
| CP-3  | Minimal no-resource RPC smoke test                                            | Backend/RPC          | Done        | M1           | Implemented in `src/main/platform/rpcSmokeTest.ts` using Eng 2 JSONL client; real Pi validation pending                                                                         |
| CP-4  | Strict JSONL transport                                                        | Backend/RPC          | Done        | M2           | Implemented in `src/main/pi/jsonlClient.ts` with parser/client tests                                                                                                            |
| CP-5  | Single PiWorker lifecycle                                                     | Backend/RPC          | Done        | M2           | Implemented in `src/main/pi/piWorker.ts` with fake-RPC integration tests                                                                                                        |
| CP-6  | Resume hard gate: `pi --mode rpc --session <file>`                            | Backend/RPC          | In Progress | M3           | Implemented in GUI resume path with canonical `get_state.sessionFile` check, resumed image preview restoration, and safe delete after resume; needs broader real-Pi validation. |
| CP-7  | Multiple workers and event routing                                            | Backend              | In Progress | M5           | Basic in-window multiple workers and known-session-file reuse exist; scheduler-grade routing/stress coverage remains.                                                           |
| CP-8  | Scheduler/concurrency cap                                                     | Backend              | Not Started | M5           | Required for multi-session MVP                                                                                                                                                  |
| CP-9  | End-to-end release validation                                                 | QA / All             | In Progress | M7           | Smoke matrix drafted in `docs/real-pi-smoke-test-matrix.md`; real Pi execution pending feature readiness                                                                        |
| CP-10 | Real Pi GUI chat vertical slice                                               | Orchestrator + Eng 6 | Done        | Demo Slice 3 | Narrow single-active-session real chat validated: state/messages, prompt streaming, abort, cleanup. Broader real-Pi usability is now tracked by P0/P1 above.                    |

## 2. Integration Gates

### G0. Contract Freeze

| Task                                  | Owner                | Status      | Acceptance                                                                                                                                                                                     |
| ------------------------------------- | -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Define `PiAdapter` interface          | Tech Lead / Backend  | Not Started | All backend/frontend leads approve                                                                                                                                                             |
| Define IPC channel list and schemas   | Tech Lead / Platform | Not Started | Renderer can use fake backend                                                                                                                                                                  |
| Define normalized runtime event model | Backend / Frontend   | Not Started | Reducer and UI can consume same model                                                                                                                                                          |
| Define timeline item schema           | Frontend / Backend   | Not Started | Chat/tool/diagnostic items covered                                                                                                                                                             |
| Define attachment token model         | Platform / Frontend  | Done        | Renderer uses opaque selected-file tokens; dropped/pasted images import via main-owned token records; regular drag/drop file paths are extracted in preload and converted to main-owned tokens |
| Define diagnostics/error envelope     | Platform / Backend   | Not Started | Errors can be surfaced consistently                                                                                                                                                            |

### G1. Minimal RPC Health Spike

| Task                                       | Owner       | Status | Acceptance                                                      |
| ------------------------------------------ | ----------- | ------ | --------------------------------------------------------------- |
| Resolve Pi binary from Finder-like env     | Platform    | Done   | Path/version shown or actionable error; fake-path tests added   |
| Run full minimal smoke-test command        | Backend/RPC | Done   | `get_state` succeeds in temp cwd with fake RPC; real Pi pending |
| Verify no smoke-test session files created | QA          | Done   | Temp cwd file check implemented; QA real Pi validation pending  |
| Cache smoke-test result by binary/version  | Backend     | Done   | Cache by binary/version implemented and tested                  |

### G1.5. Real Pi GUI Chat Smoke Gate

This gate closes the planning gap where Eng 2/3/4 delivered transport, environment, and fake-chat UI pieces, but no single owner was assigned to wire the GUI chat loop to a real Pi subprocess.

Owner: **Orchestrator + Eng 6**. Eng 6 implements and validates; orchestrator owns scope, review, and acceptance.

Non-goal: full session repository/resume/concurrency. This is a narrow real-Pi vertical slice.

| Task                                     | Owner                | Status | Acceptance                                                                                                              |
| ---------------------------------------- | -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Add explicit backend mode selection      | Orchestrator + Eng 6 | Done   | Fake remains default/safe; real mode enabled by `PI_DECK_BACKEND=real` and launch helpers; real UI hides mock sessions. |
| Resolve real Pi binary for GUI chat      | Eng 6                | Done   | Uses existing Pi resolver; supports `PI_DECK_PI_BINARY`; launch failure produces diagnostics.                           |
| Choose real session cwd                  | Eng 6                | Done   | Uses `PI_DECK_PROJECT_CWD`/launch cwd. In-app project handoff is P0.                                                    |
| Spawn real `pi --mode rpc` worker        | Eng 6                | Done   | `chat:getSnapshot` creates/attaches one real `PiWorker` using `pi --mode rpc` when real mode is enabled.                |
| Real `get_state` / `get_messages` bridge | Eng 6                | Done   | Snapshot loads real Pi state/messages for the active worker; diagnostics shown on failure.                              |
| Real prompt streaming                    | Eng 6                | Done   | GUI prompt uses real RPC `prompt` through existing `chat:event` path.                                                   |
| Real abort path                          | Eng 6                | Done   | Abort button sends real `abort`; behavior validated in narrow smoke.                                                    |
| Real worker cleanup                      | Eng 6                | Done   | Quit/window-close cleanup closes fake or real chat worker; stale renderer/window events are guarded.                    |
| Real-Pi user guide                       | Eng 6                | Done   | `docs/how-to-run-and-test.md` documents fake mode, real mode, launch helpers, expectations, and known limitations.      |
| Validation evidence                      | Eng 6                | Done   | `docs/real-pi-gui-chat-validation.md` records narrow real Pi GUI validation; ongoing dogfood gaps are P0/P1 above.      |

### G2. Resume Compatibility Hard Gate

| Task                                           | Owner              | Status      | Acceptance                                                            |
| ---------------------------------------------- | ------------------ | ----------- | --------------------------------------------------------------------- |
| Create/locate existing Pi session file fixture | QA / Backend       | Not Started | Fixture usable for real Pi test                                       |
| Spawn `pi --mode rpc --session <file>`         | Backend/RPC        | In Progress | GUI resume path spawns with `--session`; needs real matrix validation |
| Verify returned canonical `sessionFile`        | Backend/RPC        | In Progress | GUI resume path blocks if returned file differs                       |
| Add clear unsupported-version diagnostic       | Backend / Frontend | In Progress | Resume failures surface in sidebar/UI; copy still needs polish        |

### G3. Image Resizing / Packaging Spike

| Task                                                  | Owner         | Status      | Acceptance                                |
| ----------------------------------------------------- | ------------- | ----------- | ----------------------------------------- |
| Evaluate Electron `nativeImage` + JS metadata sniffer | Platform      | Not Started | PNG/JPEG/WebP feasibility known           |
| Validate macOS arm64/x64 packaging                    | Platform      | Not Started | Packaged builds work on both arch targets |
| Validate signing/notarization impact                  | Platform      | Not Started | No unresolved signing blocker             |
| Measure large-image memory behavior                   | QA / Platform | Not Started | Safety thresholds documented              |

### G4. Extension UI Semantics

| Task                           | Owner              | Status      | Acceptance                                                                                                                               |
| ------------------------------ | ------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Fake RPC dialog fixture        | QA / Backend       | In Progress | Fake RPC emits `extension_ui_request` via `--prompt-scenario extension-ui/all`; response/timeout/write-failure fixtures remain follow-up |
| Timeout + grace behavior       | Backend            | Not Started | Red dot clears locally after timeout; fake/backend fixture not implemented yet                                                           |
| Late-response suppression      | Backend / Frontend | Not Started | Late response cannot be sent; fake/backend fixture not implemented yet                                                                   |
| Worker exit/write failure path | Backend            | Not Started | Session/request becomes error with diagnostics; stdin write-failure fixture not implemented yet                                          |

## 3. Milestone Tracker

## M1. App Skeleton, Security Boundary, Binary Resolution

| ID   | Task                                 | Owner             | Status | Depends on         | Acceptance summary                                                                                        |
| ---- | ------------------------------------ | ----------------- | ------ | ------------------ | --------------------------------------------------------------------------------------------------------- |
| M1.1 | Electron + TypeScript scaffold       | Platform          | Done   | G0 draft           | App launches; typecheck/lint/test scripts pass                                                            |
| M1.2 | Secure preload IPC foundation        | Platform/Security | Done   | G0 IPC             | Renderer has no Node/fs/process access; schemas validate IPC                                              |
| M1.3 | App settings and diagnostics storage | Platform          | Done   | M1.1               | Settings persist; logs under `userData`; secrets redacted                                                 |
| M1.4 | Pi binary resolution/version         | Platform          | Done   | M1.3               | Config/PATH/shell/common paths implemented; diagnostics + tests added                                     |
| M1.5 | Minimal RPC smoke test               | Backend/RPC       | Done   | M1.4, M2.1 starter | Full no-resource command, temp cwd, get_state, cache implemented with Eng 2 JSONL client; real Pi pending |
| M1.6 | Basic layout shell                   | Frontend          | Done   | M1.2               | Header/sidebar/chat/composer visible; real mode now hides mock sessions.                                  |

## M2. Single-Session RPC Adapter and Streaming Chat

| ID   | Task                          | Owner                | Status | Depends on                   | Acceptance summary                                                                                                                         |
| ---- | ----------------------------- | -------------------- | ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| M2.1 | Strict JSONL transport        | Backend/RPC          | Done   | G0 PiAdapter                 | Parser tests cover chunks/malformed/unicode; request correlation works                                                                     |
| M2.2 | Fake RPC subprocess/harness   | Backend/QA           | Done   | M2.1                         | Deterministic tests can run without real Pi; Eng 6 added extended prompt scenarios and platform fake-shim coverage; see `docs/fake-rpc.md` |
| M2.3 | Single PiWorker lifecycle     | Backend/RPC          | Done   | M2.1, M1.5                   | `get_state`, `get_messages`, `prompt`, `abort`, exit handling covered against fake RPC                                                     |
| M2.4 | Basic chat timeline rendering | Frontend             | Done   | M2.2, M1.6                   | User/assistant messages stream; markdown sanitized; thinking separated; interim collapsed tool cards.                                      |
| M2.5 | Composer prompt and abort UX  | Frontend/Backend     | Done   | M2.3, M2.4                   | Multiline prompt sends; Enter-to-send option; abort works or errors clearly.                                                               |
| M2.6 | Real Pi GUI chat runtime mode | Orchestrator + Eng 6 | Done   | M1.4, M1.5, M2.3, M2.5, G1.5 | Narrow opt-in single active real backend mode works; broader multi-session usability moves to M3/M5/P0.                                    |

## M3. Project Picker, Session Repository, New/Resume Sessions

| ID   | Task                               | Owner            | Status      | Depends on  | Acceptance summary                                                                                                                                                                                                                          |
| ---- | ---------------------------------- | ---------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3.1 | Project picker/recent projects     | Frontend/Backend | In Progress | M1 settings | Picker IPC, renderer recents, real-mode selected-project handoff, and selected-cwd persistence exist; trust/permission UX still needs polish.                                                                                               |
| M3.2 | EffectivePiConfig resolver         | Backend/Platform | Done        | M1.3, M1.4  | Resolver implemented with app/env/settings/trust/image precedence tests                                                                                                                                                                     |
| M3.3 | Static session repository scanning | Backend          | In Progress | M3.2        | Scans authoritative session dir for project `.jsonl` files with depth/file/byte/time bounds and no symlink following; saved sessions can be deleted before/after resume; messy-dir regression coverage exists; hands-on validation remains. |
| M3.4 | Candidate sessionDir handling      | Backend/Frontend | In Progress | M3.2, M3.3  | Project candidate dirs are scanned only with explicit env opt-in and stricter depth/file/byte/time scanner bounds; hands-on validation still needed.                                                                                        |
| M3.5 | New session flow                   | Backend/Frontend | In Progress | M2.3, M3.1  | Real `+` creates an additional in-window worker with an optimistic row and reports Pi sessionFile backing when available; restart/resume validation still P0.                                                                               |
| M3.6 | Resume existing session flow       | Backend/RPC      | In Progress | M3.3, G2    | Clicking saved rows resumes with `--session`, verifies canonical file, restores image previews, keeps resumed sessions deletable, and removes missing files from the list; broader real-Pi validation remains.                              |
| M3.7 | In-app session ownership lock      | Backend          | In Progress | M3.5, M3.6  | Duplicate open of a known session file reuses the existing worker; scheduler-grade ownership locks remain.                                                                                                                                  |

## M4. Model, Thinking, Slash Commands, Attachments

| ID   | Task                            | Owner               | Status      | Depends on            | Acceptance summary                                                                                                                                                      |
| ---- | ------------------------------- | ------------------- | ----------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4.1 | Model list/switcher             | Backend/Frontend    | In Progress | M2/M3 worker          | Real composer lists Pi models and calls `set_model`; capability polish remains.                                                                                         |
| M4.2 | Thinking-level switcher         | Backend/Frontend    | Done        | M2/M3 worker          | Real composer calls `set_thinking_level`; provider-specific capability labels remain polish.                                                                            |
| M4.3 | Slash command picker            | Backend/Frontend    | In Progress | M2 worker             | Local picker exists; active-worker command discovery/insertion still needed or should be hidden in real mode.                                                           |
| M4.4 | Native attachment picker/tokens | Platform/Frontend   | Done        | G0 attachment, M1 IPC | Native picker returns opaque tokens; prompt send resolves tokens only in main.                                                                                          |
| M4.5 | Non-image referenced-path files | Backend/Frontend    | Done        | M4.4                  | Non-image picked or dropped files are sent as explicit referenced paths in the prompt.                                                                                  |
| M4.6 | Image support + resize spike    | Platform/Backend/QA | In Progress | G3, M4.1, M4.4, M3.2  | Image picker/drop/paste sends native Pi image inputs and renders thumbnails; regular file drops become path-reference tokens; resize/large-image package spike remains. |

## M5. Concurrent Sessions, Scheduler, Intervention Controls

| ID   | Task                             | Owner            | Status      | Depends on           | Acceptance summary                                                                                                                                             |
| ---- | -------------------------------- | ---------------- | ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M5.1 | Base state + overlays reducer    | Backend/Frontend | In Progress | G0 events, M2 events | Renderer reducer target and fixture-backed tests exist; backend/session-controller integration and full UI adoption remain.                                    |
| M5.2 | Multiple attached workers        | Backend          | In Progress | M3 locks, M5.1       | Adapter can host multiple workers; fake-worker routing/close-isolation tests exist. Scheduler, locks, repository identity, and real-Pi stress coverage remain. |
| M5.3 | RunScheduler and concurrency cap | Backend          | Not Started | M5.2                 | Default 4, hard cap 20; cap blocks or explicit queue                                                                                                           |
| M5.4 | Steer/follow-up/abort controls   | Backend/Frontend | Not Started | M2 abort, M5.1       | Composer intervention mode; queue counts update                                                                                                                |
| M5.5 | Quit handling                    | Platform/Backend | Not Started | M5.2, M5.3           | Cancel Quit or Abort Agents and Quit; queued starts warned                                                                                                     |

## M6. Extension UI, Project Trust, Resource Panel

| ID   | Task                          | Owner            | Status      | Depends on    | Acceptance summary                                        |
| ---- | ----------------------------- | ---------------- | ----------- | ------------- | --------------------------------------------------------- |
| M6.1 | Project trust prompt          | Backend/Frontend | Not Started | M3.2, M3.1    | Correct wording; per-run approve/no-approve/default only  |
| M6.2 | Static Resource panel         | Backend/Frontend | Not Started | M6.1, M4.3    | Strict labels; no SDK loader/extension execution          |
| M6.3 | Extension UI backend          | Backend/RPC      | Not Started | M2 events, G4 | Dialog/fire-and-forget handling; write failure errors     |
| M6.4 | Extension UI frontend/red dot | Frontend         | Not Started | M6.3, M5.1    | Background red dot; no auto-switch; timeout state visible |

## M7. Tool Visibility, Diagnostics, Polish, Release Readiness

| ID   | Task                                | Owner            | Status      | Depends on       | Acceptance summary                                                                                                        |
| ---- | ----------------------------------- | ---------------- | ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M7.1 | Tool execution cards                | Frontend/Backend | In Progress | M5.1 tool events | Interim collapsed cards for JSON command/read/edit payloads exist; full lifecycle/output cards still needed.              |
| M7.2 | Session stats and diagnostics panel | Backend/Frontend | In Progress | M3/M4 workers    | Usage stats popover refreshes after turns; full diagnostics panel for binary/config/workers/stderr/session files remains. |
| M7.3 | Error recovery flows                | Backend/Frontend | Not Started | M5/M6            | Reopen after worker exit; refresh session list; reconcile messages                                                        |
| M7.4 | End-to-end release validation       | QA/All           | In Progress | M1-M7            | Matrix drafted in `docs/real-pi-smoke-test-matrix.md`; execution waits for feature readiness and real Pi validation       |

## 4. Parallel Work Lanes and Worktrees

Use this section for standups and resource assignment. Each agent should work only in its assigned git worktree. See `docs/git-worktree-parallel-setup.md`.

| Lane                             | Current owner        | Branch                   | Worktree path                                           | Active tasks                  | Status      | Notes                                                                                                                                |
| -------------------------------- | -------------------- | ------------------------ | ------------------------------------------------------- | ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A. App/Security Foundation       | Eng 1                | `eng1/electron-security` | `/Users/liusu/pi-deck-worktrees/eng1-electron-security` | M1.1-M1.3                     | Not Started | Starts immediately after G0 draft                                                                                                    |
| B. RPC/Backend Integration       | Eng 2                | `eng2/rpc-backend`       | `/Users/liusu/pi-deck-worktrees/eng2-rpc-backend`       | M2.1-M2.3                     | Done        | JSONL client, fake RPC, PiWorker, and tests implemented                                                                              |
| C. Platform/Pi Env               | Eng 3                | `eng3/platform-env`      | `/Users/liusu/pi-deck-worktrees/eng3-platform-env`      | M1.4-M1.5, M3.2               | Done        | Platform env modules + tests implemented; real Pi validation pending                                                                 |
| D. Frontend Chat                 | Eng 4                | `eng4/frontend-chat`     | `/Users/liusu/pi-deck-worktrees/eng4-frontend-chat`     | M1.6, M2.4-M2.5               | In Review   | Renderer wired to backend fake RPC/preload stream with sanitized markdown                                                            |
| E. Sessions/Controls UI          | Eng 5                | `eng5/sessions-controls` | `/Users/liusu/pi-deck-worktrees/eng5-sessions-controls` | M3 UI, M4 controls            | In Progress | Integrated with Eng 4 chat shell; fake-data sidebar/project picker/model/thinking/slash/attachment shells awaiting real backend APIs |
| F. QA/Automation + Real Pi Slice | Eng 6 + Orchestrator | merged to `main`         | n/a                                                     | CP-10, G1.5, M2.6, tests/docs | Done        | Narrow single-active-session real Pi GUI chat is merged. Ongoing product gaps are tracked by P0/P1/P2 above.                         |
| G. State/Concurrency             | TBD                  | TBD                      | TBD                                                     | M5.1-M5.5                     | Not Started | Assign after M2/M3 foundations                                                                                                       |
| H. Trust/Resources/Extension UI  | TBD                  | TBD                      | TBD                                                     | M6.1-M6.4                     | Not Started | Assign after M3/M5 foundations                                                                                                       |
| I. Tool Visibility/Release       | TBD                  | TBD                      | TBD                                                     | M7.1-M7.4                     | Not Started | Depends on event coverage                                                                                                            |

## 5. Open Decisions / Consensus Items

| ID  | Decision                                              | Needed by           | Owner                | Status                    | Resolution                                                                                                                                   |
| --- | ----------------------------------------------------- | ------------------- | -------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Final `PiAdapter`/IPC/event schema approval           | G0                  | Tech Lead            | Open                      | TBD                                                                                                                                          |
| D-2 | Minimum supported Pi version after smoke/resume tests | M3                  | Backend/RPC          | Open                      | TBD                                                                                                                                          |
| D-3 | Image resizing implementation choice                  | M4.6                | Platform             | Open                      | TBD                                                                                                                                          |
| D-4 | Large-image warning/rejection thresholds              | M4.6                | Platform/QA          | Open                      | TBD                                                                                                                                          |
| D-5 | Fake RPC fixture format and location                  | M2.2                | QA/Backend           | Resolved                  | Source at `src/main/pi/fakeRpc/fakeRpcServer.ts`; shared test helper at `src/test/fakeRpcHarness.ts`; usage documented in `docs/fake-rpc.md` |
| D-6 | Release packaging/signing approach for internal MVP   | M7                  | Platform             | Open                      | TBD                                                                                                                                          |
| D-7 | Starter prompts prepared for all Eng 1-6              | Pre-M1              | Orchestrator         | Done                      | See `docs/starter-prompts/`                                                                                                                  |
| D-8 | Real Pi backend mode UX                               | Demo Slice 3 / M2.6 | Orchestrator + Eng 6 | Resolved for narrow slice | Fake remains default; real mode uses env/launch helpers first. In-app real project/session UX is P0.                                         |

## 6. Blocker Log

| Date       | Blocker                                                | Affected tasks                  | Owner                | Status | Next action                                                                                                                     |
| ---------- | ------------------------------------------------------ | ------------------------------- | -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-27 | Real Pi smoke execution not yet run in this branch     | G1-G2, M7.4                     | QA / Orchestrator    | Open   | Run `docs/real-pi-smoke-test-matrix.md` against installed Pi after backend/platform branches are merged/rebased                 |
| 2026-06-27 | Frontend/background UI targets not merged yet          | G4, M5/M6 renderer acceptance   | QA / Eng 4/5         | Open   | Rebase after Eng 4/5 merge and wire reducer/sidebar fixture tests to renderer targets                                           |
| 2026-06-28 | No owner was assigned for real Pi GUI chat integration | CP-10, G1.5, M2.6, Demo Slice 3 | Orchestrator + Eng 6 | Closed | Narrow real Pi GUI chat is implemented and validated. Broader daily-use gaps are explicitly tracked in the P0/P1/P2 list above. |

| 2026-06-29 | Tracker drift hid real product gaps | M3-M7, dogfooding | Orchestrator | Open | Keep Current Dogfood TODO section as source of truth; update immediately when user feedback exposes a gap. Latest: in-window new sessions started; persistent resume remains P0. |

## 7. Weekly Milestone Review Checklist

- [ ] Critical path items updated.
- [ ] Blockers have owners and next actions.
- [ ] G0-G4 gate status reviewed.
- [ ] Any contract changes documented and communicated.
- [ ] Fake-RPC and real-Pi test coverage reviewed.
- [ ] Risks updated in `docs/project-task-breakdown.md` if scope changes.
- [ ] Acceptance criteria for completed tasks verified, not just implementation merged.

## 8. MVP Final Acceptance Checklist

- [ ] App launches locally on macOS without Pi TUI.
- [ ] Pi binary path/version and minimal RPC health visible.
- [x] Opt-in real Pi backend mode runs GUI chat against `pi --mode rpc`.
- [ ] Project picker works and recent projects persist.
- [x] Prior sessions appear for current launch project from authoritative session dir. Polish/refresh/candidate dirs remain.
- [ ] New session works.
- [x] Resume via `pi --mode rpc --session <file>` includes canonical file check in GUI path; broader validation remains.
- [ ] Text prompt streams assistant output from fake backend for Demo Slice 1/2.
- [x] Text prompt streams assistant output from real Pi backend for Demo Slice 3.
- [x] Abort works for the current single active real/fake worker.
- [ ] Steer and follow-up work while session is active.
- [ ] Multiple sessions run concurrently in background.
- [ ] Configurable max running sessions defaults to 4 and hard-caps at 20.
- [ ] Sidebar indicators show idle, working, error, queued, compacting/retrying, waiting input red dot.
- [ ] Model switcher works and shows capabilities.
- [ ] Thinking-level switcher works.
- [ ] Slash picker uses active worker `get_commands`.
- [ ] Attachment picker supports multi-select.
- [ ] Non-image files are labeled `Referenced path` and sent as path references.
- [ ] Images respect model capability and effective image settings.
- [ ] Project trust prompt uses correct per-run choices.
- [ ] Resource panel uses strict labels and no unsafe inspection.
- [ ] Supported extension UI dialogs work, including background red-dot behavior.
- [ ] Tool calls/results render as full lifecycle expandable cards. Interim collapsed JSON cards exist.
- [ ] Renderer remains sandboxed and IPC validated.
- [ ] Diagnostics redact secrets.
- [ ] Quit flow handles running/queued work explicitly.
- [ ] Release notes document MVP limitations.
