# Pi Deck MVP Tracker

Status: planning tracker  
Source plan: `docs/project-task-breakdown.md`  
Update cadence: daily during active implementation; weekly milestone review.

## Status Legend

| Status | Meaning |
|---|---|
| Not Started | No implementation work yet |
| In Progress | Actively being implemented |
| Blocked | Cannot proceed without decision/dependency |
| In Review | PR/design/test review active |
| Done | Meets acceptance criteria |
| Deferred | Explicitly moved out of MVP |

## 1. Critical Path Tracker

These items should be started earliest and reviewed frequently.

| ID | Critical item | Owner | Status | Target | Blocker / note |
|---|---|---|---|---|---|
| CP-1 | G0 contract freeze: PiAdapter, IPC, events, state, timeline, attachment model | Tech Lead | Not Started | Pre-M1 | Blocks broad parallel work |
| CP-2 | Pi binary resolution and version diagnostics | Platform | Not Started | M1 | Required before real RPC |
| CP-3 | Minimal no-resource RPC smoke test | Backend/RPC | Not Started | M1 | Must not create sessions/resources |
| CP-4 | Strict JSONL transport | Backend/RPC | Not Started | M2 | Foundation for all Pi RPC |
| CP-5 | Single PiWorker lifecycle | Backend/RPC | Not Started | M2 | Enables first vertical slice |
| CP-6 | Resume hard gate: `pi --mode rpc --session <file>` | Backend/RPC | Not Started | M3 | If fails, pause architecture |
| CP-7 | Multiple workers and event routing | Backend | Not Started | M5 | Required for concurrency |
| CP-8 | Scheduler/concurrency cap | Backend | Not Started | M5 | Required for multi-session MVP |
| CP-9 | End-to-end release validation | QA / All | Not Started | M7 | Final MVP gate |

## 2. Integration Gates

### G0. Contract Freeze

| Task | Owner | Status | Acceptance |
|---|---|---|---|
| Define `PiAdapter` interface | Tech Lead / Backend | Not Started | All backend/frontend leads approve |
| Define IPC channel list and schemas | Tech Lead / Platform | Not Started | Renderer can use fake backend |
| Define normalized runtime event model | Backend / Frontend | Not Started | Reducer and UI can consume same model |
| Define timeline item schema | Frontend / Backend | Not Started | Chat/tool/diagnostic items covered |
| Define attachment token model | Platform / Frontend | Not Started | Renderer has no arbitrary file-read authority |
| Define diagnostics/error envelope | Platform / Backend | Not Started | Errors can be surfaced consistently |

### G1. Minimal RPC Health Spike

| Task | Owner | Status | Acceptance |
|---|---|---|---|
| Resolve Pi binary from Finder-like env | Platform | Not Started | Path/version shown or actionable error |
| Run full minimal smoke-test command | Backend/RPC | Not Started | `get_state` succeeds in temp cwd |
| Verify no smoke-test session files created | QA | Not Started | No persisted session side effects |
| Cache smoke-test result by binary/version | Backend | Not Started | Reruns only on defined triggers |

### G2. Resume Compatibility Hard Gate

| Task | Owner | Status | Acceptance |
|---|---|---|---|
| Create/locate existing Pi session file fixture | QA / Backend | Not Started | Fixture usable for real Pi test |
| Spawn `pi --mode rpc --session <file>` | Backend/RPC | Not Started | Worker starts without extra session fallback |
| Verify returned canonical `sessionFile` | Backend/RPC | Not Started | Equals requested canonical file |
| Add clear unsupported-version diagnostic | Backend / Frontend | Not Started | User sees path/version and blocking reason |

### G3. Image Resizing / Packaging Spike

| Task | Owner | Status | Acceptance |
|---|---|---|---|
| Evaluate Electron `nativeImage` + JS metadata sniffer | Platform | Not Started | PNG/JPEG/WebP feasibility known |
| Validate macOS arm64/x64 packaging | Platform | Not Started | Packaged builds work on both arch targets |
| Validate signing/notarization impact | Platform | Not Started | No unresolved signing blocker |
| Measure large-image memory behavior | QA / Platform | Not Started | Safety thresholds documented |

### G4. Extension UI Semantics

| Task | Owner | Status | Acceptance |
|---|---|---|---|
| Fake RPC dialog fixture | QA / Backend | Not Started | Foreground/background dialog events covered |
| Timeout + grace behavior | Backend | Not Started | Red dot clears locally after timeout |
| Late-response suppression | Backend / Frontend | Not Started | Late response cannot be sent |
| Worker exit/write failure path | Backend | Not Started | Session/request becomes error with diagnostics |

## 3. Milestone Tracker

## M1. App Skeleton, Security Boundary, Binary Resolution

| ID | Task | Owner | Status | Depends on | Acceptance summary |
|---|---|---|---|---|---|
| M1.1 | Electron + TypeScript scaffold | Platform | Not Started | G0 draft | App launches; typecheck/lint/test scripts pass |
| M1.2 | Secure preload IPC foundation | Platform/Security | Not Started | G0 IPC | Renderer has no Node/fs/process access; schemas validate IPC |
| M1.3 | App settings and diagnostics storage | Platform | Not Started | M1.1 | Settings persist; logs under `userData`; secrets redacted |
| M1.4 | Pi binary resolution/version | Platform | Not Started | M1.3 | Config/PATH/shell/common paths work; diagnostics visible |
| M1.5 | Minimal RPC smoke test | Backend/RPC | Not Started | M1.4, M2.1 starter | Full no-resource command succeeds; no sessions created |
| M1.6 | Basic layout shell | Frontend | Not Started | M1.2 | Header/sidebar/chat/composer visible with mock data |

## M2. Single-Session RPC Adapter and Streaming Chat

| ID | Task | Owner | Status | Depends on | Acceptance summary |
|---|---|---|---|---|---|
| M2.1 | Strict JSONL transport | Backend/RPC | Not Started | G0 PiAdapter | Parser tests cover chunks/malformed/unicode; request correlation works |
| M2.2 | Fake RPC subprocess/harness | Backend/QA | Not Started | M2.1 | Deterministic tests can run without real Pi |
| M2.3 | Single PiWorker lifecycle | Backend/RPC | Not Started | M2.1, M1.5 | `get_state`, `get_messages`, `prompt`, `abort`, exit handling |
| M2.4 | Basic chat timeline rendering | Frontend | Not Started | M2.2, M1.6 | User/assistant messages stream; markdown sanitized |
| M2.5 | Composer prompt and abort UX | Frontend/Backend | Not Started | M2.3, M2.4 | Multiline prompt sends; abort works or errors clearly |

## M3. Project Picker, Session Repository, New/Resume Sessions

| ID | Task | Owner | Status | Depends on | Acceptance summary |
|---|---|---|---|---|---|
| M3.1 | Project picker/recent projects | Frontend/Backend | Not Started | M1 settings | Native directory picker; recent projects persist |
| M3.2 | EffectivePiConfig resolver | Backend/Platform | Not Started | M1.3, M1.4 | agentDir/sessionDir/image/trust resolution matches architecture |
| M3.3 | Static session repository scanning | Backend | Not Started | M3.2 | Lists project sessions; bounded scanning; no symlink loops |
| M3.4 | Candidate sessionDir handling | Backend/Frontend | Not Started | M3.2, M3.3 | Candidate dirs require explicit enablement and strict bounds |
| M3.5 | New session flow | Backend/Frontend | Not Started | M2.3, M3.1 | New session appears in sidebar with canonical key |
| M3.6 | Resume existing session flow | Backend/RPC | Not Started | M3.3, G2 | Hard resume gate passes; cwd mismatch handled |
| M3.7 | In-app session ownership lock | Backend | Not Started | M3.5, M3.6 | Duplicate open reuses existing worker |

## M4. Model, Thinking, Slash Commands, Attachments

| ID | Task | Owner | Status | Depends on | Acceptance summary |
|---|---|---|---|---|---|
| M4.1 | Model list/switcher | Backend/Frontend | Not Started | M2/M3 worker | Current model visible; switch works; capabilities shown |
| M4.2 | Thinking-level switcher | Backend/Frontend | Not Started | M2/M3 worker | Current level visible; switch works/fails gracefully |
| M4.3 | Slash command picker | Backend/Frontend | Not Started | M2 worker | Uses `get_commands`; TUI-only commands not promised |
| M4.4 | Native attachment picker/tokens | Platform/Frontend | Not Started | G0 attachment, M1 IPC | Multi-select; opaque tokens; no arbitrary read IPC |
| M4.5 | Non-image referenced-path files | Backend/Frontend | Not Started | M4.4 | Chips say `Referenced path`; prefix generated; outside-project warning |
| M4.6 | Image support + resize spike | Platform/Backend/QA | Not Started | G3, M4.1, M4.4, M3.2 | Model/settings validation; resize/block behavior; safety thresholds |

## M5. Concurrent Sessions, Scheduler, Intervention Controls

| ID | Task | Owner | Status | Depends on | Acceptance summary |
|---|---|---|---|---|---|
| M5.1 | Base state + overlays reducer | Backend/Frontend | Not Started | G0 events, M2 events | Unit tests cover all reducer rules; sidebar priority selector works |
| M5.2 | Multiple attached workers | Backend | Not Started | M3 locks, M5.1 | Background events update correct session; no event leakage |
| M5.3 | RunScheduler and concurrency cap | Backend | Not Started | M5.2 | Default 4, hard cap 20; cap blocks or explicit queue |
| M5.4 | Steer/follow-up/abort controls | Backend/Frontend | Not Started | M2 abort, M5.1 | Composer intervention mode; queue counts update |
| M5.5 | Quit handling | Platform/Backend | Not Started | M5.2, M5.3 | Cancel Quit or Abort Agents and Quit; queued starts warned |

## M6. Extension UI, Project Trust, Resource Panel

| ID | Task | Owner | Status | Depends on | Acceptance summary |
|---|---|---|---|---|---|
| M6.1 | Project trust prompt | Backend/Frontend | Not Started | M3.2, M3.1 | Correct wording; per-run approve/no-approve/default only |
| M6.2 | Static Resource panel | Backend/Frontend | Not Started | M6.1, M4.3 | Strict labels; no SDK loader/extension execution |
| M6.3 | Extension UI backend | Backend/RPC | Not Started | M2 events, G4 | Dialog/fire-and-forget handling; write failure errors |
| M6.4 | Extension UI frontend/red dot | Frontend | Not Started | M6.3, M5.1 | Background red dot; no auto-switch; timeout state visible |

## M7. Tool Visibility, Diagnostics, Polish, Release Readiness

| ID | Task | Owner | Status | Depends on | Acceptance summary |
|---|---|---|---|---|---|
| M7.1 | Tool execution cards | Frontend/Backend | Not Started | M5.1 tool events | Expand/collapse; bash status/output; edit/write paths |
| M7.2 | Session stats and diagnostics panel | Backend/Frontend | Not Started | M3/M4 workers | Binary/config/workers/errors visible; secrets redacted |
| M7.3 | Error recovery flows | Backend/Frontend | Not Started | M5/M6 | Reopen after worker exit; refresh session list; reconcile messages |
| M7.4 | End-to-end release validation | QA/All | Not Started | M1-M7 | MVP acceptance checklist passes; limitations documented |

## 4. Parallel Work Lanes

Use this section for standups and resource assignment.

| Lane | Current owner | Active tasks | Status | Notes |
|---|---|---|---|---|
| A. App/Security Foundation | TBD | M1.1-M1.5 | Not Started | Starts immediately after G0 draft |
| B. RPC/Backend Integration | TBD | M2.1-M2.3 | Not Started | Start JSONL/fake RPC immediately |
| C. Frontend Shell/Mock UI | TBD | M1.6, M2.4 | Not Started | Can use fake IPC/RPC |
| D. Session Repository/Resume | TBD | M3.1-M3.7 | Not Started | M3.6 is hard gate |
| E. State/Concurrency | TBD | M5.1-M5.5 | Not Started | Reducer tests can start early |
| F. Controls/Attachments | TBD | M4.1-M4.6 | Not Started | Image spike is separate platform risk |
| G. Trust/Resources/Extension UI | TBD | M6.1-M6.4 | Not Started | Use strict resource labels |
| H. Tool Visibility/Release | TBD | M7.1-M7.4 | Not Started | Depends on event coverage |

## 5. Open Decisions / Consensus Items

| ID | Decision | Needed by | Owner | Status | Resolution |
|---|---|---|---|---|---|
| D-1 | Final `PiAdapter`/IPC/event schema approval | G0 | Tech Lead | Open | TBD |
| D-2 | Minimum supported Pi version after smoke/resume tests | M3 | Backend/RPC | Open | TBD |
| D-3 | Image resizing implementation choice | M4.6 | Platform | Open | TBD |
| D-4 | Large-image warning/rejection thresholds | M4.6 | Platform/QA | Open | TBD |
| D-5 | Fake RPC fixture format and location | M2.2 | QA/Backend | Open | TBD |
| D-6 | Release packaging/signing approach for internal MVP | M7 | Platform | Open | TBD |

## 6. Blocker Log

| Date | Blocker | Affected tasks | Owner | Status | Next action |
|---|---|---|---|---|---|
| TBD | TBD | TBD | TBD | Open | TBD |

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
- [ ] Project picker works and recent projects persist.
- [ ] Prior sessions appear for current project.
- [ ] New session works.
- [ ] Resume via `pi --mode rpc --session <file>` passes canonical file check.
- [ ] Text prompt streams assistant output.
- [ ] Abort works.
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
- [ ] Tool calls/results render as expandable cards.
- [ ] Renderer remains sandboxed and IPC validated.
- [ ] Diagnostics redact secrets.
- [ ] Quit flow handles running/queued work explicitly.
- [ ] Release notes document MVP limitations.
