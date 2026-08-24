# Real Pi Smoke-Test Matrix

Owner: Eng 6 / QA automation  
Status: active matrix; P0 GUI smoke has been automated. Do not run destructive tests against user sessions.

## Safety Rules

- Use a fresh temp project directory for every smoke run unless a row explicitly requires a controlled existing session fixture.
- Use an isolated `PI_CODING_AGENT_DIR` under the smoke temp root when possible. For authenticated prompt smoke, prefer an explicit temp `PI_CODING_AGENT_SESSION_DIR` so session files are isolated while normal provider auth remains available.
- Never point smoke tests at a user's active project/session store without explicit approval.
- Preserve stdout/stderr, Pi binary path, version, cwd, env summary with secrets redacted, and cleanup status as artifacts.

## Common Setup

```bash
ROOT="$(mktemp -d /tmp/pi-deck-smoke.XXXXXX)"
PROJECT="$ROOT/project"
AGENT_DIR="$ROOT/agent"
mkdir -p "$PROJECT" "$AGENT_DIR"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
```

The app's automated G1 health check must use:

```text
pi --mode rpc --no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline
```

## Matrix

| ID     | Area                                    | Command / interaction                                                                                                                                                | Expected result                                                                                                                                                                                                                                                  | Gate  |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| SM-001 | Binary resolution                       | Resolve configured binary, PATH, login shell lookup, common paths                                                                                                    | Canonical path and actionable diagnostic on failure                                                                                                                                                                                                              | G1    |
| SM-002 | Version                                 | `pi --version`                                                                                                                                                       | Version captured in diagnostics and cache key                                                                                                                                                                                                                    | G1    |
| SM-003 | Minimal no-resource RPC                 | Spawn canonical no-session/no-resource/offline args in temp cwd, send `get_state`                                                                                    | Successful response parsed; no `.jsonl` or `sessions` files created                                                                                                                                                                                              | G1    |
| SM-004 | New session                             | Spawn normal `pi --mode rpc` in temp project, send `get_state`                                                                                                       | Session id/file discovered under isolated agent/session dir                                                                                                                                                                                                      | M2/M3 |
| SM-005 | Prompt streaming                        | Send minimal prompt in temp project                                                                                                                                  | `agent_start`, one or more `message_update`, `agent_end`; persisted messages reload via `get_messages`                                                                                                                                                           | M2    |
| SM-006 | Abort                                   | Send long-running prompt or fake delayed tool fixture, then `abort`                                                                                                  | Work stops or returns clear abort error; final state not stuck working                                                                                                                                                                                           | M2/M5 |
| SM-007 | Resume hard gate                        | Create controlled session fixture, spawn `pi --mode rpc --session <file>`, send `get_state`                                                                          | Returned `sessionFile` canonical path equals requested file; no `switch_session` fallback                                                                                                                                                                        | G2    |
| SM-008 | Models                                  | `get_available_models`; optionally `set_model` to a known configured model                                                                                           | Model list/capabilities parsed; errors actionable when auth/model unavailable                                                                                                                                                                                    | M4    |
| SM-009 | Thinking levels                         | `set_thinking_level` for supported values                                                                                                                            | Supported values accepted or unsupported values produce non-fatal diagnostics                                                                                                                                                                                    | M4    |
| SM-010 | Commands                                | `get_commands`; send a harmless returned prompt template/skill only in isolated fixture                                                                              | Commands parsed and slash picker can use returned command text through `prompt`                                                                                                                                                                                  | M4    |
| SM-011 | Non-image attachments                   | Send prompt with generated referenced-path prefix for temp text/binary files                                                                                         | UI labels/path prefix are correct; Pi can use paths if it chooses                                                                                                                                                                                                | M4    |
| SM-012 | Image attachments                       | Use tiny generated PNG with image-capable model, plus non-image model negative case                                                                                  | Image sends only when model/settings allow; blocked otherwise                                                                                                                                                                                                    | G3/M4 |
| SM-013 | Extension UI fixture                    | Run a known local extension fixture that emits `confirm`/`input` dialog                                                                                              | Foreground renders; background session gets red dot; response write clears only after successful write                                                                                                                                                           | G4/M6 |
| SM-014 | Extension UI timeout                    | Fixture emits dialog with short timeout                                                                                                                              | Local timeout + grace clears stale red dot; late response suppressed                                                                                                                                                                                             | G4    |
| SM-015 | Extension UI write failure              | Fixture exits or closes stdin before response                                                                                                                        | Request/session error with diagnostics; red dot not cleared as success                                                                                                                                                                                           | G4    |
| SM-016 | Queue/steer/follow-up                   | During active run, send steer and follow-up                                                                                                                          | Queue counts update; follow-up runs after current work; extension commands not queued as steer/follow-up                                                                                                                                                         | M5    |
| SM-017 | Tool events                             | Prompt/fixture triggers tool execution                                                                                                                               | Tool start/update/end events produce expandable card data and clear running overlay                                                                                                                                                                              | M5/M7 |
| SM-018 | Compaction/retry                        | Fixture or controlled session triggers compaction/retry if supported                                                                                                 | Sidebar compacting/retrying indicators set/clear                                                                                                                                                                                                                 | M5    |
| SM-019 | Agent Workflow real worker              | Create and start a one-worker workflow through the canonical API, then restart Pi Deck                                                                               | Real Pi output, worker session file, completed graph, and run remain visible after restart                                                                                                                                                                       | M2    |
| SM-020 | Task-session bridge transport           | `npm run test:e2e:real-smoke` enables the legacy bridge harness and explicitly invokes `deck_delegate`                                                               | The real extension loader, authenticated bridge, and private child worker reach `completed`; parent-only status is visible, with no private session or controls rendered                                                                                         | M5    |
| SM-021 | Deterministic fake task-session routing | Run `e2e/pi-deck.e2e.ts` task-session acceptance with `e2e/fixtures/task-routing-contract.json`; select **New task session** after enabling Parallel                 | No bridge election; 12 planned tasks show 10 active plus queued excess, attempt-4 terminal failure, one-prompt parent override/reset, parent availability, inert flat rows, synthesis clearing, attachment privacy, and interrupted restart without child resume | M5    |
| SM-022 | Real model-backed task planning         | `npm run test:e2e:real-smoke` enables Parallel and sends an ordinary prompt explicitly containing three independent tasks, with no harness marker or routing fixture | The real private planner returns three task briefs, three `--no-session` workers complete, the parent synthesizes ALPHA/BETA/GAMMA, task rows clear after the report, and only the parent session persists                                                       | M5    |
| SM-023 | Parallel worker model selection         | Open a fresh real-Pi draft, enable Parallel, wait for runtime model discovery, and choose a per-prompt worker model                                                  | Multiple installed models populate the selector; the chosen DOM-safe value remains selected after React state updates, while worker thinking resets atomically                                                                                                   | M5    |

## Fake-RPC Coverage Mapping

The deterministic fake RPC harness covers pre-real-Pi automation for:

- `get_state` / `get_messages` success.
- `prompt` start/update/end streaming.
- `abort` aborted end behavior.
- malformed stdout.
- subprocess exit with pending request.
- stderr diagnostics.
- reducer extension events via `--prompt-scenario all`: tool, queue, compaction, retry, extension UI request.
- platform G1 smoke plumbing through a fake `pi` shim.

## Current Blockers / Manual Inputs

- P0 real GUI prompt/resume and one-worker Agent Workflow persistence paths are covered by `npm run test:e2e:real-smoke` against the installed Pi binary.
- The `PI_DECK_E2E_DELEGATE_HARNESS=1` companion extension remains a **separate bridge transport** test: with `PI_DECK_ENABLE_LEGACY_DELEGATE_BRIDGE=1` it confirms the tool is registered before invoking it, validates the real extension loader/authenticated bridge/private worker, then relaunches without the compatibility opt-in and confirms the model-visible tool is absent.
- SM-021 is ungated fake-RPC production-route coverage and deliberately does not use the bridge harness. Its test-only fixture controls bounded planning and child outcomes so capacity, retries, synthesis, attachment consumption/privacy, and restart interruption remain deterministic.
- SM-022 is authenticated real-Pi coverage of the production model-backed planner. It supplies no fixture and no `deck_delegate` marker, so a one-task fallback fails the test instead of masquerading as planner success.
- Broader M7.4 release matrix execution still needs planned pass/fail artifact collection across all rows.
- G3 release evidence must include platform packaging measurements for the implemented image UI.
- G4 release evidence must include a real or fake extension fixture covering the implemented extension UI backend IPC.
