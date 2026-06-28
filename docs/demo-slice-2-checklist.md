# Demo Slice 2 Checklist — Controls + Chat Integrated Shell

Status date: 2026-06-28  
Owner: Eng 4  
Source branch: `main`  
Validated commit: `fc6f2c3` (`origin/main` at start of this validation run)  
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

## 2. Manual Pass / Fail Matrix

Manual interaction was performed against the running Electron renderer using Chrome DevTools Protocol because macOS assistive-access UI scripting was unavailable in the API harness. Native Finder dialogs could not be completed through CDP and are marked failed until a hands-on Finder pass is recorded.

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
| Project picker cancel/select paths behave | Fail | Native Finder dialog cancel/select could not be completed through CDP; needs hands-on macOS dialog check. |
| Attachment picker cancel/select paths behave | Fail | Native Finder dialog cancel/select could not be completed through CDP; needs hands-on macOS dialog check. |
| Selected non-image files are labeled/referenced as path metadata | Fail | `Referenced path` labeling is visible in attachment examples, but actual native-selected non-image chip was not verified because file picker interaction could not be completed. |
| Missing attachment examples are non-selected and do not block default send | Pass | Attachment examples include missing/deleted fixture separately; default composer showed `No files selected` and prompt send worked. |
| Diagnostics/settings/version remain visible/stable | Pass | Version/security badge and composer diagnostic text remained visible. |
| Quitting app does not intentionally leave fake worker running | Pass | `Browser.close`/app quit completed; process check found no remaining `fakeRpcServer`. |
| No obvious console/security errors | Pass | CDP captured zero runtime exceptions and zero console errors. |

## 3. Blocking Issues

1. **Native Finder dialog E2E remains unverified.**
   - Project picker cancel/select paths could not be exercised from CDP.
   - Attachment picker cancel/select paths could not be exercised from CDP.
   - Actual native-selected non-image attachment chip labeling could not be verified.

No chat/sidebar/model/slash integration blocker was found.

## 4. Non-Blocking Polish Notes

- Add an Electron E2E strategy for native dialog stubbing or a documented hands-on macOS picker checklist.
- Consider splitting `src/renderer/App.tsx` into chat, sidebar, header controls, and composer components before further UI expansion.
- Keep temporary fake chat IPC clearly separated from future real session controller API.
- Auto-scroll timeline to streamed output for smoother demos.

## 5. Final Status

**Not accepted yet.**

Demo Slice 2 is ready for chat/sidebar/model/slash integration, but it is not fully accepted until native project picker and attachment picker cancel/select behavior are manually verified on macOS.
