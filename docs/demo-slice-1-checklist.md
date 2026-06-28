# Demo Slice 1 Checklist — Local Fake-Agent Chat Loop

Status date: 2026-06-28  
Owner: Eng 4  
Source branch: `main`  
Validated commit: `fc6f2c3` (`origin/main` at start of this validation run)  
Scope: Demo Slice 1 acceptance signoff for local fake-agent chat loop.

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
| `npm run dev` | Pass | Vite started, Electron launched, and renderer was exercised through Chrome DevTools Protocol. |

`npm run dev` / interactive harness highlights:

```text
VITE v8.1.0 ready
Local: http://127.0.0.1:5173/
Electron DevTools target: Pi Deck
CDP interactive checks: no runtime exceptions, no console errors
No fakeRpcServer process remained after Browser.close/app quit
```

## 2. Manual Pass / Fail Matrix

Manual interaction was performed against the running Electron renderer using Chrome DevTools Protocol because macOS assistive-access UI scripting was unavailable in the API harness.

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
| Diagnostics/settings/version remain visible/stable | Pass | Version/security badge and composer diagnostic text remained visible. |
| Quitting app does not intentionally leave fake worker running | Pass | `Browser.close`/app quit completed; process check found no remaining `fakeRpcServer`. |
| No obvious console/security errors | Pass | CDP captured zero runtime exceptions and zero console errors. |

## 3. Blocking Issues

None for Demo Slice 1.

## 4. Non-Blocking Polish Notes

- Keep the CDP script or convert it into Eng 6-owned regression automation so Demo Slice 1 can be rechecked without manual accessibility permissions.
- Auto-scroll to latest streamed message remains a useful follow-up.
- Final M5/M7 quit handling should replace this temporary fake worker cleanup path.

## 5. Final Status

**Accepted.**

Demo Slice 1 passes automated validation and interactive fake-agent chat-loop validation on latest `main`.
