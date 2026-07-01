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

## 2. Development Launch

Use the Vite + Electron development loop:

```bash
npm run dev
```

This builds the Electron main/preload code, starts the renderer dev server, and launches Electron against the local Vite URL.

## 3. Production-ish Local Launch

Build the app and launch Electron from the built main process without creating a DMG, signing, or notarizing:

```bash
npm run launch
```

`npm run start` is an alias for the same local launch flow.

Equivalent expanded command:

```bash
npm run build && electron dist/main/main.js
```

## 4. Automated Validation Commands

Run these before demo/release-readiness handoff:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

Current expected state on latest accepted main:

- Unit/integration tests pass, including fake RPC, platform, IPC, and renderer shell coverage.
- TypeScript checks pass for main/preload/shared and renderer code.
- Electron main/preload and Vite renderer build successfully.
- Prettier formatting check passes.

## 5. Fake Pi Demo Checklist

The current GUI demo uses the fake RPC worker path. This is intentional for Demo Slices 1 and 2.

Suggested smoke flow:

1. Run `npm run dev` or `npm run launch`.
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

## 6. Real Pi Current Status

Fake RPC remains the default and safest demo mode. Do not claim broad real Pi GUI usability yet.

Current reality:

- Default GUI chat uses the fake RPC worker.
- An opt-in real backend mode exists for the narrow Demo Slice 3 vertical slice.
- Real mode launches one real `pi --mode rpc` worker, loads `get_state` / `get_messages`, sends prompts through the existing GUI chat path, streams RPC events, supports `abort`, and closes the worker on app quit.
- Real Pi binary resolution, environment resolution, EffectivePiConfig, JSONL transport, and minimal RPC smoke-test foundations exist.
- Real Pi can create additional in-window sessions with `+ New real session`, but session listing/repository persistence, resume via `--session`, project trust UX, model/thinking RPC controls, attachments, and robust multi-session orchestration remain future M3/M5+ work.

Opt-in real GUI chat launch:

```bash
PI_DECK_BACKEND=real npm run dev
```

Optional overrides:

```bash
PI_DECK_BACKEND=real \
PI_DECK_PI_BINARY=/absolute/path/to/pi \
PI_DECK_PROJECT_CWD=/path/to/smoke/project \
npm run dev
```

Real mode expectations:

1. The renderer should show `Backend real Pi RPC session`.
2. Initial snapshot should come from real `get_state` / `get_messages` or show an actionable diagnostic if Pi cannot start.
3. Prompt send should call real RPC `prompt` and stream returned events into the chat timeline.
4. Abort should call real RPC `abort` and recover the UI or show a non-fatal error.
5. Quitting the app should close/kill the real worker; no `pi --mode rpc` process should intentionally remain.

Record real-mode validation evidence in `docs/real-pi-gui-chat-validation.md` before claiming this slice accepted.

## 7. Manual Real Pi Smoke Command

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
