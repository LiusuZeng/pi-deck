# How to Run and Test Pi Deck

Status: v0.6.0 source-only pre-release run/test guide

The normative navigation path is **All Work → scoped Work → session detail**.
Local UI development uses deterministic fake Pi RPC; authenticated real-Pi commands
are separate release evidence. See [the release checklist](release-checklist.md).

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

Build once after a fresh checkout, and again whenever you want source changes in the local production build:

```bash
npm run build
```

Common starts:

```bash
# Real-Pi dogfood using the existing dist output (never rebuilds)
npm start
# or explicitly:
npm run deck:real -- /path/to/project

# Build and launch in one explicit development/CI command
npm run launch:build
npm run deck:real:build -- /path/to/project

# Real Pi backend with Vite renderer hot reload
npm run dev:real -- /path/to/project

# Deterministic fake-RPC development mode using the existing dist output
npm run deck:fake

# Launcher help / dry-run plan
npm run deck -- --help
npm run deck:real -- --dry-run /path/to/project
npm run deck -- --fake --build --dry-run
```

The launcher resolves and validates:

- project cwd, defaulting to the caller cwd;
- `pi` binary from `--pi`, `PI_DECK_PI_BINARY`, `PATH`, and common macOS install paths;
- real/fake backend env.

The old shell scripts still exist as compatibility wrappers:

```bash
scripts/dev-real-pi.sh [project-dir]
scripts/launch-real-pi.sh [project-dir]
```

## 3. Raw Development Launch

Use the raw Vite + Electron development loop for deterministic fake-RPC development only:

```bash
npm run dev
```

This builds the Electron main/preload code, starts the renderer dev server, and launches Electron against the local Vite URL. It does not select the real backend unless you set `PI_DECK_BACKEND=real` yourself; prefer `npm run dev:real -- /path/to/project` for real Pi dogfooding.

## 4. Raw Production-ish Local Launch

Launch Electron from an already-built main process without creating a DMG, signing, or notarizing:

```bash
npm run launch
```

This command deliberately does not build. It verifies that the main process, preload, renderer, and completed-build manifest exist and match; if they are missing, incomplete, or older than source/configuration, it prints the exact repair command instead of launching a broken or stale app.

### macOS launch caveat when running from Codex

The Electron binary is a macOS GUI process. On some macOS releases, launching
that binary from a sandboxed Codex shell can make LaunchServices abort before
Pi Deck's main process starts; macOS then shows an “Electron quit unexpectedly”
dialog. Pi Deck's development and E2E entrypoints detect Codex's Seatbelt
sandbox and stop before spawning Electron, with an actionable error instead of
triggering that dialog. Run the same command from Terminal/Finder, or approve
an unsandboxed GUI launch when validating locally. This is an
environment/launch-boundary failure, not a Pi Deck workspace or session error.

For development or CI, use the explicit build-and-launch command:

```bash
npm run launch:build
```

Equivalent expanded command:

```bash
npm run build && npm run launch
```

## 5. Automated Validation Commands

Run this required CI-equivalent validation before demo/release-readiness handoff:

```bash
npm run verify:ci
```

Real Pi smoke checks are separate because prompt smoke requires local Pi/model-provider auth. Before tagging a release, run the authenticated real-Pi GUI smoke too:

```bash
npm run test:e2e:real-smoke
```

See [the release checklist](release-checklist.md) for the mandatory user-journey and evidence requirements. The non-prompt smoke uses an isolated temp agent dir; prompt smoke uses Pi's default/user agent dir so auth is available:

```bash
# Starts a real temp pi --mode rpc session and checks get_state/get_messages.
npm run smoke:real

# Sends a tiny real prompt and waits for agent_end. Requires configured provider auth.
npm run smoke:real:prompt
```

The CI-equivalent gate covers the following. Record command results in the
[v0.6.0 validation record](reviews/v0.6-unified-work-release-validation.md)
before treating them as release evidence:

- Unit/integration tests, including fake RPC, platform, IPC, and renderer shell coverage.
- TypeScript checks for main/preload/shared and renderer code.
- Successful Electron main/preload and Vite renderer builds.
- Prettier formatting.
- Playwright Electron E2E coverage for fake launch, real startup failure labeling, real-mode no-fallback/send-enabled, and saved-session refresh/resume regressions.
- `npm run smoke:real` checking the installed real Pi RPC path without fake RPC; `npm run smoke:real:prompt` additionally checks a minimal real prompt round-trip when auth is configured.

## 6. Deterministic fake-Pi development checklist

Use the fake RPC worker path for local UI and regression checks that do not need
provider credentials. This section is development coverage, not evidence from
an actual Pi worker or a release acceptance record.

Suggested smoke flow:

1. Run `npm run deck:fake` for a deterministic fake-RPC launch, or `npm run dev` for raw fake dev mode.
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

The fixture flow above validates the fake-RPC development path only. It does not
establish authenticated real-Pi behavior or final release evidence. Native Finder
dialog interaction remains a separate hands-on check when validating picker UX.

## 7. Real-Pi validation posture

Fake RPC is the safest path for deterministic local UI work, but it is not actual
Pi evidence. `npm run dev` and `npm run deck:fake` use fake RPC; `npm start`,
`deck:real`, and `dev:real` use an actual Pi executable and may contact the
configured provider. Do not claim broad real-Pi GUI usability beyond the checks
that were actually run.

Current behavior:

- The development fake paths use the fake RPC worker.
- An opt-in real backend mode uses one actual `pi --mode rpc` worker.
- Real mode launches one real `pi --mode rpc` worker, loads `get_state` / `get_messages`, sends prompts through the existing GUI chat path, streams RPC events, supports `abort`, and closes the worker on app quit.
- Real Pi binary resolution, environment resolution, EffectivePiConfig, JSONL transport, and minimal RPC smoke-test foundations exist.
- Real Pi can create additional in-window sessions with the compact `+`, up to `maxRunningSessions`. Real mode scans the authoritative session directory for the selected project, clicking a saved row attempts `pi --mode rpc --session <file>` with canonical `get_state.sessionFile` verification, and the P0 restart/resume/project-handoff path is covered by `npm run test:e2e:real-smoke`. Candidate session dirs, refresh/error polish, project trust UX, and robust scheduler-backed multi-session orchestration remain future M3/M5+ work. Model/thinking controls are available in the composer for the active real worker with capability labels. Real slash commands use active-worker `get_commands` when available. Attachments include image capability gating and large-image blocking, while actual image resizing/package work remains future. Real-worker prewarming is disabled: current Pi can only create either a persisted session or an ephemeral `--no-session` worker, and cannot promote the latter when it is used.

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
5. Saved prior sessions for the launch project should appear in All Work or scoped Work; opening one should resume it or show a clear error.
6. Quitting the app should close/kill real workers; no `pi --mode rpc` process should intentionally remain.

For a release candidate, record exact real-Pi command output only after running
it on the final HEAD. Use the template in [the release checklist](release-checklist.md);
do not reuse historical validation records as final-candidate evidence.

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
