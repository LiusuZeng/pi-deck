# Review Feedback — Eng 1 Electron / Security Foundation

Review date: 2026-06-26  
Reviewer: Orchestrator  
Branch/worktree: `eng1/electron-security` / `/Users/liusu/pi-deck-worktrees/eng1-electron-security`

## Summary

Strong first pass. The Electron app/security foundation is in place and generally matches M1.1-M1.3 scope:

- Electron + TypeScript + Vite/React scaffold.
- Main/preload/renderer separation.
- Secure `BrowserWindow` defaults centralized in `src/main/security.ts`.
- Narrow `window.piDeck` preload API.
- Runtime schema validation with zod on main IPC handlers and preload responses.
- App-local settings persistence under `userData`.
- Diagnostics/log directory foundation and redaction helper.
- Basic Pi Deck renderer shell with diagnostics/status display.
- Tests for security defaults, settings store, diagnostics, and IPC schemas.

I ran:

```bash
cd /Users/liusu/pi-deck-worktrees/eng1-electron-security
npm test
npm run typecheck
npm run build
npm run format
```

Result:

```text
npm test: 13 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: passed
```

## Acceptance Criteria Check

| Area | Status | Notes |
|---|---|---|
| M1.1 Electron + TS scaffold | Pass | Build/typecheck/tests pass. Dev launch verified in resolution update below. |
| M1.2 Secure preload IPC | Pass | Correct security defaults and narrow API. Dev CSP caveat resolved in update below. |
| M1.3 Settings/diagnostics | Pass | Defaults, persistence, corrupt-file recovery, diagnostics summary covered by tests. |
| Scope discipline | Pass | No Pi RPC/session/model/attachment implementation added. |
| Worktree discipline | Pass | Work isolated to assigned worktree. |

## Requested Changes Before Merge

### 1. Verify/fix CSP behavior in dev mode

There may be a CSP conflict between:

- dynamic CSP header from `buildContentSecurityPolicy(isDev)`, which allows dev websocket/inline styles; and
- static CSP meta tag in `index.html`, which is production-strict:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; ... connect-src 'self'; ..." />
```

Browsers enforce both policies if both are present. The stricter static meta policy may block Vite dev behavior such as HMR websocket or injected styles, even though the dynamic dev header allows them.

Please do one of the following:

- Run `npm run dev` and confirm the app launches cleanly with no CSP console errors; or
- Adjust the CSP strategy so dev and production both work predictably.

Acceptance:

- `npm run dev` launches Pi Deck successfully.
- No CSP errors block renderer load, Vite client, styles, or preload API calls.
- Production build still has strict CSP: no remote scripts, no unsafe navigation, no broad remote origins.

### 2. Add/confirm an invalid IPC payload test at the handler boundary

Schema tests are good, but M1.2 acceptance says invalid IPC payloads are rejected safely by the main-process IPC boundary.

Please add a small test around `registerValidatedIpc` if practical, or otherwise document why Electron `ipcMain` is not easily unit-tested yet and keep the schema tests as interim coverage.

Acceptance if implemented:

- Invalid `settings:update`-like payload returns `{ ok: false, error: { code: "VALIDATION_ERROR", ... } }`.
- Handler does not throw uncaught exception.
- Diagnostics recorder receives an error entry.

### 3. Dependency classification cleanup

`package.json` currently puts several build/dev tools in `dependencies`:

```json
"@vitejs/plugin-react", "electron", "vite"
```

Please move build/dev-only tooling to `devDependencies` where appropriate. Keep runtime libraries needed by unpackaged source runtime or packaged app in `dependencies`.

Suggested:

- `dependencies`: `react`, `react-dom`, `zod`
- `devDependencies`: `electron`, `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `esbuild`, `concurrently`, `wait-on`, types, prettier

This will reduce packaging confusion later.

## Resolution Update

Update date: 2026-06-27  
Implemented by: Eng 1

Requested changes addressed:

1. **CSP dev-mode behavior fixed and verified**
   - Removed the static CSP meta tag from source `index.html` so Vite dev mode is governed by the Electron-injected dev CSP header only.
   - Added a Vite `transformIndexHtml` plugin that injects the strict production CSP meta tag only during production builds.
   - Updated dev CSP to allow only the Vite-required development capabilities: inline Vite React preamble/scripts, inline styles, localhost dev websocket/http connection, and blob workers for Vite reconnect behavior.
   - Production CSP remains strict: no remote scripts, no `unsafe-inline`, no broad remote origins, no `blob:` worker source.
   - Verified `npm run dev` with `ELECTRON_ENABLE_LOGGING=1`; Pi Deck launched, Vite connected, and no CSP/refused/blocked/uncaught errors appeared before intentional shutdown.

2. **Invalid IPC payload handler-boundary test added**
   - Added `src/main/ipc/registerIpc.test.ts` with an Electron `ipcMain` mock.
   - Invalid `settings:update`-style payload returns `{ ok: false, error: { code: "VALIDATION_ERROR", ... } }`.
   - The registered handler is not invoked for invalid payloads.
   - Diagnostics recorder receives the rejection entry.

3. **Dependency classification cleaned up**
   - Moved `electron`, `vite`, and `@vitejs/plugin-react` to `devDependencies`.
   - Runtime `dependencies` now contain only `react`, `react-dom`, and `zod`.
   - Refreshed `package-lock.json`.

Validation rerun after changes:

```text
npm run format: passed
npm run typecheck: passed
npm test: 5 test files, 16 tests passed
npm run lint: passed
npm run build: passed
npm run dev: launched successfully; no CSP/refused/blocked/uncaught errors in Electron logging before intentional shutdown
```

## Integration Notes / Coordination Required

### A. Package/build config conflict with Eng 2

Eng 1 and Eng 2 both created initial `package.json`, `package-lock.json`, and TypeScript config independently.

Before merging both branches, we need one combined project config that supports:

- Electron/Vite app scripts from Eng 1.
- Backend/RPC source layout and tests from Eng 2.
- A test command that runs both Vitest tests and/or Node test suites, or standardizes on one runner.

Suggested merge order:

1. Land Eng 1 foundation first after requested changes.
2. Ask Eng 2 to rebase onto Eng 1 and adapt RPC tests/modules into the Electron project structure.
3. Standardize test runner/scripts during that rebase.

### B. Build artifacts are ignored, good

`dist/` and `node_modules/` are not tracked due `.gitignore`. Good. Keep them uncommitted.

### C. Renderer Node access check is useful but not a security test

The UI display of `process/require` absence is helpful for manual verification. Keep the actual security assertions in tests around `buildSecureWebPreferences`.

## Non-Blocking Follow-Ups

These can wait unless easy to include now:

1. Add a tiny `README.md` section for dev commands once the scaffold is merged.
2. Consider returning structured diagnostics categories later instead of plain `recentErrors: string[]`.
3. When Eng 3 lands Pi binary diagnostics, extend `DiagnosticsSummary` rather than creating a parallel diagnostics path.

## Files Reviewed

- `package.json`
- `tsconfig.base.json`
- `tsconfig.main.json`
- `tsconfig.renderer.json`
- `vite.config.ts`
- `vitest.config.ts`
- `index.html`
- `src/main/main.ts`
- `src/main/security.ts`
- `src/main/ipc/registerIpc.ts`
- `src/main/settings/settingsStore.ts`
- `src/main/diagnostics/diagnostics.ts`
- `src/preload/index.ts`
- `src/shared/ipcSchemas.ts`
- `src/shared/types.ts`
- `src/renderer/App.tsx`
- `src/renderer/main.tsx`
- `src/renderer/global.d.ts`
- `src/renderer/styles.css`
- Tests under `src/**/*.test.ts`
- `docs/project-tracker.md`

## Verdict

**Approve after small changes.**

Please address the three requested changes, rerun:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

Also manually verify or document `npm run dev` launch behavior. Then report back with summary and test output.
