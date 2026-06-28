# Demo Slice 1 Checklist — Local Fake-Agent Chat Loop

Status date: 2026-06-28  
Owner: Eng 4  
Source branch: `main`  
Validated commit: `eac0e03` (`origin/main`)  
Scope: Demo Slice 1 acceptance signoff for local fake-agent chat loop.

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

`npm run dev` smoke log highlights:

```text
VITE v8.1.0 ready
Local: http://127.0.0.1:5173/
Electron process observed
```

## 2. Manual Pass / Fail Matrix

Legend:

- Pass: validated directly in this run.
- Partial: launch/process-level smoke only; not full user interaction.
- Blocked: could not be executed from this API/non-interactive harness.

| Checklist item | Status | Evidence / notes |
|---|---:|---|
| App launches locally on macOS | Partial | `npm run dev` started Vite and an `Electron` process was observed. |
| No preload/API errors | Partial | No preload/API errors appeared in captured dev stdout/stderr; renderer console was not accessible. |
| Renderer reports no direct Node/process/require access | Blocked | Requires visual/manual renderer confirmation or browser/electron automation. Existing Eng 1 security checks still pass. |
| Fake backend session appears | Blocked | Requires visual/manual renderer confirmation. |
| Fresh launch allows immediate prompt send | Blocked | Requires GUI interaction. |
| Sending multiline prompt appends user message | Blocked | Requires GUI interaction. |
| Assistant response streams visibly | Blocked | Requires GUI interaction. |
| Markdown renders safely | Partial | `src/renderer/markdown.test.ts` covers raw HTML-as-text and link scheme allowlist; visual confirmation blocked. |
| Abort works during streaming and UI recovers | Blocked | Requires GUI interaction. |
| Diagnostics/settings/version remain visible/stable | Blocked | Requires visual/manual renderer confirmation. |
| Quitting app does not intentionally leave fake worker running | Partial | Dev process was terminated cleanly for smoke; product quit path cleanup exists in code, but normal GUI quit was not manually verified. |
| No obvious console/security errors | Partial | No obvious errors in captured dev stdout/stderr; renderer console was not accessible. |

## 3. Blocking Issues

1. **Manual GUI validation was not completed in this harness.**
   - `npm run dev` launched the dev server and Electron process.
   - macOS UI automation was not available: `System Events` reported assistive access denial.
   - `screencapture` failed with `could not create image from display`.
   - Therefore prompt send/stream/abort and visual state checks remain unrecorded.

No implementation blocker was found by automated checks.

## 4. Non-Blocking Polish Notes

- Add a lightweight renderer/Electron E2E harness for the fake chat loop so future Demo Slice 1 signoff does not depend on manual accessibility permissions.
- Auto-scroll to latest streamed message remains a useful follow-up.
- Final M5/M7 quit handling should replace this temporary fake worker cleanup path.

## 5. Final Status

**Not accepted yet.**

Automated checks and launch smoke passed, but Demo Slice 1 still lacks a completed interactive manual E2E pass on latest `origin/main`.
