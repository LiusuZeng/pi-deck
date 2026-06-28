# Demo Slice 2 Checklist — Controls + Chat Integrated Shell

Status date: 2026-06-28  
Owner: Eng 4  
Source branch: `main`  
Validated commit: `eac0e03` (`origin/main`)  
Scope: E2E integration readiness for Eng 4 chat loop plus Eng 5 sidebar/sessions/controls/project picker/attachment picker/model-thinking/slash UI.

## 1. Automated Command Results

Commands requested for latest `main`:

| Command | Result | Notes |
|---|---:|---|
| `git fetch origin` | Pass | Fetched latest refs before validation. |
| `git checkout main` | Pass | Performed in main checkout `/Users/liusu/liusu_pi_gui`; main is checked out there. |
| `git pull origin main` | Pass | Already up to date at validation start. |
| `npm ci` | Pass | 127 packages installed; 0 vulnerabilities. |
| `npm test` | Pass | 13 test files passed; 59 tests passed. |
| `npm run typecheck` | Pass | Main and renderer TypeScript checks passed. |
| `npm run build` | Pass | Main/preload and Vite renderer build passed. |
| `npm run format` | Pass | Prettier check passed. |
| `npm run dev` | Partial | Dev server started and Electron process appeared; interactive GUI validation could not be completed from this non-interactive harness. |

## 2. Manual Pass / Fail Matrix

Legend:

- Pass: validated directly in this run.
- Partial: launch/process-level smoke, automated test, or code-path evidence only.
- Blocked: requires interactive GUI/manual validation that could not be executed from this harness.

| Checklist item | Status | Evidence / notes |
|---|---:|---|
| App launches locally on macOS | Partial | `npm run dev` started Vite and an `Electron` process was observed. |
| No preload/API errors | Partial | No preload/API errors appeared in captured dev stdout/stderr; renderer console was not accessible. |
| Renderer reports no direct Node/process/require access | Blocked | Requires visual/manual renderer confirmation or browser/electron automation. Existing security checks pass. |
| Fake backend session appears | Blocked | Requires visual/manual renderer confirmation. |
| Fresh launch allows immediate prompt send | Blocked | Requires GUI interaction. |
| Sending multiline prompt appends user message | Blocked | Requires GUI interaction. |
| Assistant response streams visibly | Blocked | Requires GUI interaction. |
| Markdown renders safely | Partial | Markdown unit tests cover raw HTML-as-text and link scheme allowlist; visual confirmation blocked. |
| Abort works during streaming and UI recovers | Blocked | Requires GUI interaction. |
| Sidebar/controls from Eng 5 do not break the active fake chat session | Blocked | Requires integrated GUI interaction. No automated/type/build regressions observed. |
| Selecting fixture/sidebar sessions does not permanently break active backend chat | Blocked | Requires GUI interaction across fixture sessions and backend session. |
| Model/thinking controls render and do not break send | Blocked | Requires GUI interaction. Types/build indicate integrated code compiles. |
| Slash picker opens for `/` and does not promise unsupported TUI-only commands | Blocked | Requires GUI interaction. Static fixture commands are scoped to skill/prompt-template/extension labels. |
| Project picker cancel/select paths behave | Blocked | Requires native dialog interaction. Main/preload project APIs compile and tests pass. |
| Attachment picker cancel/select paths behave | Blocked | Requires native dialog interaction. Main/preload attachment APIs compile and tests pass. |
| Selected non-image files are labeled/referenced as path metadata | Blocked | Requires GUI/native picker interaction. Static code includes `Referenced path` attachment chip labeling. |
| Missing attachment examples are non-selected and do not block default send | Blocked | Requires GUI interaction. |
| Diagnostics/settings/version remain visible/stable | Blocked | Requires visual/manual renderer confirmation. |
| Quitting app does not intentionally leave fake worker running | Partial | Dev process was terminated cleanly for smoke; product quit path cleanup exists in code, but normal GUI quit was not manually verified. |
| No obvious console/security errors | Partial | No obvious errors in captured dev stdout/stderr; renderer console was not accessible. |

## 3. Blocking Issues

1. **Interactive E2E validation was not completed in this harness.**
   - `npm run dev` launched the dev server and Electron process.
   - macOS UI automation was not available: `System Events` reported assistive access denial.
   - `screencapture` failed with `could not create image from display`.
   - Native project/attachment picker cancel/select paths could not be exercised.

2. **Demo Slice 2 depends on Demo Slice 1 manual acceptance.**
   - Demo Slice 1 automated checks and launch smoke passed, but interactive prompt/stream/abort remains unrecorded.

No implementation blocker was found by automated checks.

## 4. Non-Blocking Polish Notes

- Add renderer/Electron E2E automation for chat + controls integration once Eng 6 QA lane rebases.
- Consider splitting `src/renderer/App.tsx` into chat, sidebar, header controls, and composer components before further UI expansion.
- Keep temporary fake chat IPC clearly separated from future real session controller API.
- Auto-scroll timeline to streamed output for smoother manual demo.

## 5. Final Status

**Not accepted yet.**

The integrated Eng 4 + Eng 5 shell is automated-check clean and launches to an Electron process, but Demo Slice 2 E2E readiness still needs a completed interactive manual pass for chat, sidebar/controls, slash, project picker, and attachment picker behavior.
