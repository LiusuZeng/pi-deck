# Real Pi GUI Chat Validation

Status date: 2026-07-09
Branch: `main`
Scope: real backend vertical slice plus P0 project/session restart-resume smoke.

## Scope Under Test

```text
PI_DECK_BACKEND=real npm run dev
→ launch real pi --mode rpc
→ GUI snapshot from get_state/get_messages
→ prompt streams real response
→ abort works
→ quit cleans worker
```

## Current Status

Implementation path is present behind `PI_DECK_BACKEND=real`. The narrow chat slice and the P0 project/session dogfood path have both been validated against the installed real Pi binary.

P0 coverage now includes a plus-created real session, prompt streaming, app restart, authoritative saved-session scan, project A/B/A handoff, click-to-resume, and transcript restoration. Initial P1 coverage now includes active-worker slash command IPC, model/thinking capability labels, active-real-model image gating, large-image blocking, tool-card lifecycle status/truncation, and worker-exit reopen recovery. Scheduler-backed queue/cap behavior, richer diagnostics, trust/resource UI, actual image resizing, and broader real-provider validation remain post-P1-baseline work.

## Environment to Record

| Item                  | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Commit                | local `main` worktree                                              |
| macOS version         | local macOS test host                                              |
| Node/npm version      | Node `v26.0.0`, npm `11.12.1`                                      |
| Pi binary path        | `/usr/local/bin/pi`                                                |
| `pi --version`        | `0.80.3`                                                           |
| `PI_DECK_PROJECT_CWD` | Temp roots under OS temp dir                                       |
| Session isolation     | Explicit temp `PI_CODING_AGENT_SESSION_DIR`; normal auth preserved |

## Automated Validation

| Command                       | Result | Notes                                                      |
| ----------------------------- | -----: | ---------------------------------------------------------- |
| `npm test`                    |   Pass | 19 test files, 101 tests passed.                           |
| `npm run typecheck`           |   Pass | Main/preload/shared and renderer TypeScript checks passed. |
| `npm run format`              |   Pass | Prettier check passed.                                     |
| `npm run test:e2e`            |   Pass | 14 passed, real smoke skipped by default.                  |
| `npm run test:e2e:real-smoke` |   Pass | Real Pi GUI P0 smoke passed against installed Pi.          |

## Manual Real GUI Chat Checklist

| Check                                           |  Result | Evidence / notes                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_DECK_BACKEND=real npm run dev` launches app | Partial | CDP validation used production-ish local Electron launch with `PI_DECK_BACKEND=real` and built assets so `--remote-debugging-port` could be passed directly. `npm run dev` real-mode launch remains a follow-up hands-on command check. |
| Renderer clearly shows real backend mode        |    Pass | CDP observed `Backend real Pi RPC session`.                                                                                                                                                                                             |
| Real `pi --mode rpc` process starts             |    Pass | Real mode snapshot loaded from `/usr/local/bin/pi`; CDP run used isolated temp project/agent dirs.                                                                                                                                      |
| Snapshot loads via `get_state` / `get_messages` |    Pass | CDP observed real-mode session and temp project cwd was visible; minimal RPC smoke separately confirmed `get_state` and `get_messages` success.                                                                                         |
| Prompt streams a real assistant response        |    Pass | CDP prompt `Reply with exactly: PI_DECK_REAL_SMOKE_OK` produced visible `PI_DECK_REAL_SMOKE_OK`; no `Prompt failed` diagnostic was visible.                                                                                             |
| Abort sends real `abort` and UI recovers        |    Pass | Second CDP pass clicked Abort immediately after sending a long prompt; abort evidence was visible and UI recovered.                                                                                                                     |
| App quit closes real worker                     |    Pass | After `Browser.close`, `ps` check found `LINGERING_MODE_RPC=0`.                                                                                                                                                                         |
| Failure diagnostics are actionable              |    Pass | No prompt failure was visible; Electron stderr tail was empty except DevTools listening line.                                                                                                                                           |

## CDP Real GUI Evidence

Two Chrome DevTools Protocol passes were run against built Electron assets with `PI_DECK_BACKEND=real`, isolated temp project directories, and isolated `PI_CODING_AGENT_DIR` values.

Prompt/stream pass output highlights:

```text
REAL_MODE_VISIBLE true
CWD_VISIBLE true
PROMPT_OK_VISIBLE true
PROMPT_FAILED_VISIBLE false
LINGERING_MODE_RPC=0
```

Abort pass output highlights:

```text
REAL_VISIBLE true
ABORT_CLICKED_IMMEDIATE true
ABORT_EVIDENCE true
LINGERING_MODE_RPC=0
```

Implementation note: this validation also verified real mode no longer falls back to the fake-specific `/local/fake-rpc-worker` placeholder. Main now sends the worker cwd in the snapshot when Pi does not report `cwd`; renderer real-mode fallback text is neutral (`Real Pi worker cwd unavailable`).

## Minimal Real Pi RPC Smoke Evidence

A no-resource/no-session RPC smoke command was run outside the GUI on 2026-06-28:

```bash
pi --version
# 0.80.2

printf '{"id":"smoke-state","type":"get_state"}\n{"id":"smoke-messages","type":"get_messages"}\n' | \
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

Result: Pass. `response` records for `smoke-state` and `smoke-messages` returned `success: true`; `get_messages` returned `{ "messages": [] }`, stderr was empty, and no files were created in the temp smoke root.

This proves local Pi RPC health only. It does not prove GUI real chat acceptance.

## Real GUI P0 Smoke Evidence

Automated real GUI P0 smoke was run on 2026-07-09:

```bash
npm run test:e2e:real-smoke
```

Result: Pass. The test launches Electron in real mode with `/usr/local/bin/pi`, uses temp projects A/B and an explicit temp `PI_CODING_AGENT_SESSION_DIR`, creates a new real session with the compact `+`, sends a prompt, verifies the assistant token, restarts the app, verifies the saved row, switches A → B → A, resumes the saved session, and verifies the transcript token is restored.

## Resume Smoke Evidence

A direct real Pi resume smoke was run on 2026-06-30 against an existing Pi Deck project session:

```bash
SESSION=$(find ~/.pi/agent/sessions/--Users-liusu-liusu_pi_gui-- -type f -name '*.jsonl' | sort | tail -1)
printf '{"id":"resume-smoke","type":"get_state"}\n' | /usr/local/bin/pi --mode rpc --session "$SESSION"
```

Result: Pass. `get_state` returned `success: true` and `data.sessionFile` matched the requested session file path. This validates the CLI hard gate for this installed Pi version; GUI click-to-resume is now also covered by `npm run test:e2e:real-smoke`.

## Known Limitations for This Slice

- Fake backend remains default.
- Real mode is env-var opt-in, not a finished settings UI.
- Real mode starts workers in `PI_DECK_PROJECT_CWD`, the selected project, or the app cwd; project/session controller polish can continue.
- Authoritative session-dir listing, project handoff, and click-to-resume are implemented and covered by smoke. Candidate-dir edge cases, refresh/error polish, cwd mismatch UX, trust UX, and robust scheduler-backed multi-session management remain incomplete.
