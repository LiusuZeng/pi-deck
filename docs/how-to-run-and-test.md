# How to Run and Test Pi Deck

Status date: 2026-06-28  
Current demo readiness: fake-backend integrated shell accepted for Demo Slices 1 and 2.

## 1. Setup

From the repository root:

```bash
npm install
```

For clean CI-like installs, use:

```bash
npm ci
```

## 2. Starting Pi Deck

Pi Deck now has one formal launcher entrypoint:

```bash
npm run deck -- [options] [project-dir]
```

Common starts:

```bash
# Daily dogfood: real Pi backend, production-ish local Electron launch
npm start
# or explicitly:
npm run deck:real -- /path/to/project

# Real Pi backend with Vite renderer hot reload
npm run dev:real -- /path/to/project

# Safe fake backend demo mode
npm run deck:fake

# Launcher help / dry-run plan
npm run deck -- --help
npm run deck:real -- --dry-run /path/to/project
```

The launcher resolves and validates:

- project cwd, defaulting to the caller cwd;
- `pi` binary from `--pi`, `PI_DECK_PI_BINARY`, `PATH`, and common macOS install paths;
- real/fake backend env;
- optional `--no-prewarm` for disabling spare real-worker prewarm.

The old shell scripts still exist as compatibility wrappers:

```bash
scripts/dev-real-pi.sh [project-dir]
scripts/launch-real-pi.sh [project-dir]
```

## 3. Raw Development Launch

Use the raw Vite + Electron development loop for fake/local development only:

```bash
npm run dev
```

This builds the Electron main/preload code, starts the renderer dev server, and launches Electron against the local Vite URL. It does not select the real backend unless you set `PI_DECK_BACKEND=real` yourself; prefer `npm run dev:real -- /path/to/project` for real Pi dogfooding.

## 4. Raw Production-ish Local Launch

Build the app and launch Electron from the built main process without creating a DMG, signing, or notarizing:

```bash
npm run launch
```

Equivalent expanded command:

```bash
npm run build && electron dist/main/main.js
```

## 5. Automated Validation Commands

Run these before demo/release-readiness handoff:

```bash
npm test
npm run typecheck
npm run build
npm run format
npm run test:e2e
```

Real Pi smoke checks are separate because prompt smoke requires local Pi/model-provider auth. The non-prompt smoke uses an isolated temp agent dir; prompt smoke uses Pi's default/user agent dir so auth is available:

```bash
# Starts a real temp pi --mode rpc session and checks get_state/get_messages.
npm run smoke:real

# Sends a tiny real prompt and waits for agent_end. Requires configured provider auth.
npm run smoke:real:prompt
```

Current expected state on latest accepted main:

- Unit/integration tests pass, including fake RPC, platform, IPC, and renderer shell coverage.
- TypeScript checks pass for main/preload/shared and renderer code.
- Electron main/preload and Vite renderer build successfully.
- Prettier formatting check passes.
- Playwright Electron E2E checks fake launch, real startup failure labeling, real-mode no-fallback/send-enabled, and saved-session refresh/resume regressions when local Pi is available.
- `npm run smoke:real` checks the installed real Pi RPC path without fake RPC; `npm run smoke:real:prompt` additionally verifies the simplest real prompt round-trip when auth is configured.

## 6. Fake Pi Demo Checklist

The current GUI demo uses the fake RPC worker path. This is intentional for Demo Slices 1 and 2.

Suggested smoke flow:

1. Run `npm run deck:fake` for a production-ish fake launch, or `npm run dev` for raw fake dev mode.
2. Confirm the app window opens and the security/status badges render.
3. Confirm the fake backend session appears in the sidebar/header.
4. Send a multiline prompt.
5. Confirm the user message appears.
6. Confirm the assistant response streams back from the fake RPC worker.
7. While a response is streaming, click Abort and confirm the UI returns to an idle/aborted state.
8. Use sidebar fixture rows and confirm returning to the backend fake RPC session still allows prompt streaming.
9. Change model/thinking controls and confirm they do not break prompt send.
10. Type `/` in the composer and confirm the slash picker opens with fake supported commands and does not promise TUI-only commands like `/settings` or `/hotkeys`.
11. Confirm attachment examples label non-image files as `Referenced path`.
12. Quit the app and confirm no fake RPC worker remains intentionally running.

Demo Slice status:

- Demo Slice 1: accepted for local fake-agent chat loop.
- Demo Slice 2: accepted for the fake-backend integrated shell covering chat/sidebar/model/thinking/slash UI.
- Native Finder dialog hands-on validation for project and attachment picker cancel/select paths is deferred as user feedback/polish, not a blocker. The project picker and attachment picker code paths exist through preload/main APIs, but literal Finder dialog interaction was not hands-on validated in this demo pass.

## 7. Real Pi Current Status

Fake RPC remains the default and safest demo mode. Do not claim broad real Pi GUI usability yet.

Current reality:

- Default GUI chat uses the fake RPC worker.
- An opt-in real backend mode exists for the narrow Demo Slice 3 vertical slice.
- Real mode launches one real `pi --mode rpc` worker, loads `get_state` / `get_messages`, sends prompts through the existing GUI chat path, streams RPC events, supports `abort`, and closes the worker on app quit.
- Real Pi binary resolution, environment resolution, EffectivePiConfig, JSONL transport, and minimal RPC smoke-test foundations exist.
- Real Pi can create additional in-window sessions with the compact `+`. Real mode scans the authoritative session directory for the selected project, clicking a saved row attempts `pi --mode rpc --session <file>` with canonical `get_state.sessionFile` verification, and the P0 restart/resume/project-handoff path is covered by `npm run test:e2e:real-smoke`. Candidate session dirs, refresh/error polish, project trust UX, and robust scheduler-backed multi-session orchestration remain future M3/M5+ work. Model/thinking controls are available in the composer for the active real worker with capability labels. Real slash commands use active-worker `get_commands` when available. Attachments include image capability gating and large-image blocking, while actual image resizing/package work remains future. Pi Deck also prewarms one spare real worker unless `PI_DECK_DISABLE_PREWARM_REAL_WORKER=1` is set.

Real GUI chat launch:

```bash
npm start
# or:
npm run deck:real -- /path/to/project
```

Real GUI chat dev launch:

```bash
npm run dev:real -- /path/to/project
```

Optional overrides:

```bash
npm run deck:real -- --pi /absolute/path/to/pi /path/to/smoke/project
PI_CODING_AGENT_DIR=/tmp/pi-deck-agent npm run deck:real -- /path/to/smoke/project
```

Real mode expectations:

1. The renderer should show `Backend real Pi RPC session`.
2. Initial snapshot should come from real `get_state` / `get_messages` or show an actionable diagnostic if Pi cannot start.
3. Prompt send should call real RPC `prompt` and stream returned events into the chat timeline.
4. Abort should call real RPC `abort` and recover the UI or show a non-fatal error.
5. Saved prior sessions for the launch project should appear in the sidebar; clicking one should resume it or show a clear error.
6. Quitting the app should close/kill real workers; no `pi --mode rpc` process should intentionally remain.

Record real-mode validation evidence in `docs/real-pi-gui-chat-validation.md` before claiming this slice accepted.

## 8. Real Pi Smoke Commands

Prefer the scripted smoke checks:

```bash
npm run smoke:real
npm run smoke:real:prompt
npm run test:e2e:real-smoke
```

`npm run test:e2e:real-smoke` launches the GUI in real mode and validates the P0 restart/resume/project-handoff path. Use `npm run smoke:real -- --help` for options such as `--pi`, `--project`, `--prompt`, `--timeout-ms`, and `--keep-temp`.

## 9. Manual Real Pi Smoke Command

Use only controlled temp directories. Do not point smoke tests at active user sessions unless explicitly approved.

Basic binary/version check:

```bash
pi --version
```

Minimal no-resource/no-session RPC smoke process:

```bash
ROOT="$(mktemp -d /tmp/pi-deck-real-pi-smoke.XXXXXX)"
cd "$ROOT"
pi --mode rpc \
  --no-session \
  --no-approve \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  --offline
```

Then send this JSONL request to stdin:

```jsonl
{
  "id": "smoke-1",
  "type": "get_state"
}
```

Expected result:

- A JSONL `response` record for `smoke-1` is printed.
- No persisted session files are created in the temp directory.
- Any failure should be captured with stderr, Pi version, cwd, and environment summary with secrets redacted.

For the broader validation plan, see `docs/real-pi-smoke-test-matrix.md`.
