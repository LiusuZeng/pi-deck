# Demo Slice 2 Checklist — Controls + Chat Integrated Shell

Status date: 2026-06-28  
Owner: Eng 6 taking over demo/release readiness  
Source branch: `main`  
Validated commit: `e81396e` before demo-readiness doc update  
Scope: E2E integration readiness for Eng 4 chat loop plus Eng 5 sidebar/sessions/controls/project picker/attachment picker/model-thinking/slash UI.

## 1. Automated Command Results

Commands requested for latest `main`:

| Command | Result | Notes |
|---|---:|---|
| `git fetch origin` | Pass | Fetched latest refs before validation. |
| `git checkout main` | Pass | Performed in main checkout `/Users/liusu/liusu_pi_gui`; main is checked out there. |
| `git pull origin main` | Pass | Already up to date. |
| `npm ci` | Pass | 127 packages installed; 0 vulnerabilities. |
| `npm test` | Pass | 13 test files passed; 59 tests passed. |
| `npm run typecheck` | Pass | Main and renderer TypeScript checks passed. |
| `npm run build` | Pass | Main/preload and Vite renderer build passed. |
| `npm run format` | Pass | Prettier check passed. |
| `npm run dev` | Pass | Vite started, Electron launched, and integrated shell was exercised through Chrome DevTools Protocol. |

## 2. Manual Pass / Deferred Matrix

Manual interaction was performed against the running Electron renderer using Chrome DevTools Protocol because macOS assistive-access UI scripting was unavailable in the API harness. Native Finder dialogs could not be completed through CDP. Per user decision, the remaining literal Finder dialog hands-on validation is deferred user feedback/polish and is not a blocker for Demo Slice 2 acceptance.

| Checklist item | Status | Evidence / notes |
|---|---:|---|
| App launches locally on macOS | Pass | `npm run dev` launched Vite and Electron; renderer DOM reached ready state. |
| No preload/API errors | Pass | `window.piDeck` exposed app/settings/chat/projects/attachments APIs; no preload errors observed. |
| Renderer reports no direct Node/process/require access | Pass | CDP check: `globalThis.process` and `globalThis.require` were both absent; badge showed secure renderer. |
| Fake backend session appears | Pass | `Backend fake RPC session` visible in sidebar/header. |
| Fresh launch allows immediate prompt send | Pass | Sent prompt immediately on fresh backend runtime session. |
| Sending multiline prompt appends user message | Pass | Multiline prompt appeared in user bubble. |
| Assistant response streams visibly | Pass | Backend fake RPC assistant response appeared after prompt send. |
| Markdown renders safely | Pass | Unsafe `<script>window.__pideckUnsafe=1</script>` remained literal text; no assistant `<script>` node and no unsafe global execution. |
| Abort works during streaming and UI recovers | Pass | Abort button appeared during stream; click returned UI to aborted idle state. |
| Sidebar/controls from Eng 5 do not break the active fake chat session | Pass | Sidebar fixture states and model/thinking controls were visible while backend chat loop worked. |
| Selecting fixture/sidebar sessions does not permanently break active backend chat | Pass | Fixture row showed expected UI-shell guard; returning to backend fake RPC session allowed prompt streaming again. |
| Model/thinking controls render and do not break send | Pass | Model and thinking selects were changed; subsequent prompt send succeeded. |
| Slash picker opens for `/` and does not promise unsupported TUI-only commands | Pass | Slash picker opened and showed `/skill:frontend-polish`, `/review`, `/extension:open-pr`; no `/settings` or `/hotkeys` promises. |
| Project picker cancel/select paths behave | Deferred | Project picker code path exists through the preload/main native dialog API. Literal Finder dialog cancel/select hands-on validation was deferred by user decision. |
| Attachment picker cancel/select paths behave | Deferred | Attachment picker code path exists through the preload/main native dialog API. Literal Finder dialog cancel/select hands-on validation was deferred by user decision. |
| Selected non-image files are labeled/referenced as path metadata | Deferred | `Referenced path` labeling is visible in attachment examples. Actual native-selected non-image chip labeling remains part of deferred Finder hands-on validation. |
| Missing attachment examples are non-selected and do not block default send | Pass | Attachment examples include missing/deleted fixture separately; default composer showed `No files selected` and prompt send worked. |
| Diagnostics/settings/version remain visible/stable | Pass | Version/security badge and composer diagnostic text remained visible. |
| Quitting app does not intentionally leave fake worker running | Pass | `Browser.close`/app quit completed; process check found no remaining `fakeRpcServer`. |
| No obvious console/security errors | Pass | CDP captured zero runtime exceptions and zero console errors. |

## 3. Blocking Issues

None for Demo Slice 2.

Chat/sidebar/model/thinking/slash integration passed. The only remaining unchecked item was literal native Finder dialog hands-on validation for project and attachment picker cancel/select paths, and the user explicitly deferred that as feedback/polish rather than a release blocker.

## 4. Deferred / User Feedback / Known Limitation

**Native Finder dialog hands-on validation is deferred.**

- Project picker and attachment picker code paths exist through safe preload/main APIs.
- CDP-based validation could not complete native macOS Finder dialogs.
- User decision: skip remaining native Finder dialog hands-on validation for now and treat it as deferred user feedback/polish, not a blocker.
- Follow-up: add an Electron E2E strategy for native dialog stubbing or record a hands-on macOS picker checklist when desired.

## 5. Non-Blocking Polish Notes

- Consider splitting `src/renderer/App.tsx` into chat, sidebar, header controls, and composer components before further UI expansion.
- Keep temporary fake chat IPC clearly separated from future real session controller API.
- Auto-scroll timeline to streamed output for smoother demos.

## 6. Final Status

**Accepted for the fake-backend integrated shell.**

Demo Slice 2 passes chat/sidebar/model/thinking/slash integration and preserves the fake-agent chat loop. Native Finder dialog hands-on validation is deferred by user decision and is not a blocker.
