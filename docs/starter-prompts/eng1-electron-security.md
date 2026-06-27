# Starter Prompt — Eng 1: Electron / Security Foundation

You are Eng 1 on **Pi Deck**, a local macOS Electron + TypeScript GUI for controlling Pi agents. Your ownership is the Electron app foundation and secure renderer/main boundary.

## Read First

Please read these docs before coding:

1. `docs/requirements.md`
2. `docs/technical-architecture.md`
3. `docs/project-task-breakdown.md`
4. `docs/project-tracker.md`
5. `docs/git-worktree-parallel-setup.md`

Focus especially on:

- Architecture §2 High-Level Architecture
- Architecture §17 Electron Security and IPC Validation
- Architecture §19 Diagnostics and Log Retention
- Milestone tasks M1.1, M1.2, M1.3 in `docs/project-task-breakdown.md`
- Tracker rows M1.1, M1.2, M1.3 in `docs/project-tracker.md`

## Worktree Requirement

Work only inside your assigned git worktree, expected branch/path:

- Branch: `eng1/electron-security`
- Path: `/Users/liusu/pi-deck-worktrees/eng1-electron-security`

Before editing, run:

```bash
pwd
git branch --show-current
git status --short
```

Do not modify files in the main checkout or another engineer's worktree. If you are not in your assigned worktree/branch, stop and ask for setup.

## Your Mission

Implement the initial Electron + TypeScript foundation for Pi Deck.

You own:

- **M1.1** Electron + TypeScript scaffold
- **M1.2** Secure preload IPC foundation
- **M1.3** App-local settings and diagnostics storage

Do **not** implement Pi RPC yet. Eng 2/3 will handle RPC and binary resolution. Your job is to make sure the app shell and security boundary are solid enough for other engineers to build on.

## Product Context

Pi Deck is not an IDE and not a terminal wrapper. It is a local GUI control plane for Pi agents. The Electron main process is the local backend/source of truth. The renderer must be sandboxed and communicate only through typed, validated IPC exposed by preload.

## Required Implementation

### M1.1 — Electron + TypeScript Scaffold

Set up a working Electron app with:

- Main process TypeScript entrypoint.
- Preload TypeScript entrypoint.
- Renderer TypeScript/React entrypoint if React is used.
- Development launch script.
- Typecheck script.
- Test script placeholder or initial test setup.
- Lint/format script if project conventions exist or are easy to add.
- Clean directory structure suitable for future lanes.

Suggested structure, adjust if needed:

```text
src/
  main/
    main.ts
    ipc/
    settings/
    diagnostics/
  preload/
    index.ts
  renderer/
    App.tsx
    main.tsx
    styles.css
  shared/
    ipcSchemas.ts
    types.ts
```

### M1.2 — Secure Preload IPC Foundation

Electron security defaults must be enforced:

- `contextIsolation: true`
- `nodeIntegration: false`
- renderer sandbox enabled where practical
- remote module disabled / not used
- no direct renderer access to `fs`, `process`, `child_process`, or arbitrary Node APIs
- strict CSP baseline: no remote scripts, no unsafe navigation
- external links should not navigate inside the app

Create a small typed preload API, for example:

```ts
window.piDeck = {
  app: {
    getVersion(): Promise<string>;
    getDiagnosticsSummary(): Promise<DiagnosticsSummary>;
  },
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  }
}
```

IPC requirements:

- All IPC payloads must be runtime-validated in main process using `zod` or equivalent.
- Invalid payloads should reject with a structured error, not crash main.
- Keep schemas in `src/shared` so frontend/backend share types.
- Do not expose generic IPC send/invoke from preload.

### M1.3 — App Settings and Diagnostics Storage

Implement app-local persistence under Electron `app.getPath('userData')`.

Settings should include at least placeholders for:

```ts
interface AppSettings {
  piBinaryPath?: string;
  agentDir?: string;
  sessionDir?: string;
  maxRunningSessions: number; // default 4, hard cap eventually 20
  warmWorkerLimit: number;
  enableLoginShellEnvCapture: boolean;
}
```

Diagnostics/logging foundation:

- Create a logs directory under `userData`.
- Provide a diagnostics summary IPC method that returns:
  - app version
  - userData path
  - log path
  - current settings with secrets redacted if any are added later
- Do not log prompt contents.
- Make it easy for Eng 3 to later add Pi binary path/version/smoke-test status.

## Acceptance Criteria

Your work is done when:

### M1.1 Acceptance

- App launches locally in dev mode on macOS.
- Main/preload/renderer compile with strict TypeScript.
- `typecheck` passes.
- Test command exists and passes, even if initial coverage is minimal.

### M1.2 Acceptance

- Renderer has no direct Node/fs/process access.
- Preload exposes only a narrow typed API.
- IPC payloads are runtime-validated.
- Invalid IPC payloads are rejected safely.
- Security defaults are visible in BrowserWindow creation.
- CSP is configured.

### M1.3 Acceptance

- App settings are persisted under `userData`.
- Settings survive app restart.
- Defaults are applied when settings file is missing.
- Invalid/corrupt settings file is handled gracefully with diagnostics.
- Diagnostics summary is available through typed IPC.

## Non-Goals

Do not implement yet:

- Pi RPC worker spawning.
- JSONL transport.
- Pi binary resolution.
- Project picker.
- Session scanning.
- Attachment file reads.
- Model/thinking/slash command behavior.
- Extension UI.

You may add placeholder UI text for these, but no real implementation.

## Coordination Points

Before finalizing APIs, coordinate with:

- Eng 2 on how `PiAdapter` IPC will eventually fit behind the same pattern.
- Eng 3 on settings fields needed for Pi binary/env/sessionDir work.
- Frontend engineers on the preload API shape.

If you need to change shared schema shape, update docs or leave a clear note in your PR.

## Suggested First Steps

1. Inspect the current repo structure.
2. Initialize package/build tooling if missing.
3. Create Electron main/preload/renderer skeleton.
4. Add secure BrowserWindow configuration.
5. Add shared zod schemas and typed IPC helper pattern.
6. Add settings store and diagnostics summary.
7. Add a tiny renderer screen showing app name `Pi Deck`, settings summary, and diagnostics summary.
8. Run typecheck/test.
9. Update `docs/project-tracker.md` statuses for M1.1-M1.3 if your workflow includes doc updates.

## PR Summary Template

When submitting, include:

```text
Summary:
- ...

Implemented:
- M1.1 ...
- M1.2 ...
- M1.3 ...

Security notes:
- contextIsolation: ...
- nodeIntegration: ...
- sandbox: ...
- IPC validation: ...

Testing:
- npm run typecheck
- npm test
- npm run dev/manual launch

Known follow-ups:
- ...
```
