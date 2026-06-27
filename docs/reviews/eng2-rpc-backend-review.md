# Review Feedback — Eng 2 RPC / Backend

Review date: 2026-06-26  
Reviewer: Orchestrator  
Branch/worktree: `eng2/rpc-backend` / `/Users/liusu/pi-deck-worktrees/eng2-rpc-backend`

## Summary

Good first pass. The M2 backend foundation is largely in place:

- Strict LF-delimited JSONL parser.
- Request/response correlation.
- Async event routing.
- Stderr diagnostic capture.
- Fake RPC process with deterministic prompt streaming.
- Single `PiWorker` wrapper.
- Minimal `SinglePiAdapter` that hides JSONL details.
- Automated tests pass locally.

I ran:

```bash
cd /Users/liusu/pi-deck-worktrees/eng2-rpc-backend
npm test
```

Result:

```text
13 tests passed
```

## Acceptance Criteria Check

| Area | Status | Notes |
|---|---|---|
| M2.1 JSONL transport | Pass | Parser covers split chunks, multiple records, malformed JSON, U+2028/U+2029, response/event routing. |
| M2.2 Fake RPC harness | Pass | Supports `get_state`, `get_messages`, `prompt`, `abort`; documented in `docs/fake-rpc.md`. |
| M2.3 Single PiWorker | Mostly pass | Works against fake RPC; lifecycle/diagnostics need one close-path adjustment before merge. |
| Tests | Pass | `npm test` passed. |
| Scope discipline | Pass | No project/session/model/attachment features added. |

## Requested Changes Before Merge

### 1. Fix expected close diagnostics in `PiWorker.closeSession()`

Current behavior likely emits an error diagnostic on intentional close because `SIGTERM` produces `code=null, signal=SIGTERM`, and the close handler treats all non-zero-code exits as error:

```ts
const level = code === 0 ? "info" : "error";
this.addDiagnostic(level, `RPC worker exited ...`);
```

But `closeSession()` intentionally sends `SIGTERM`. This will create noisy error diagnostics for normal shutdown and later confuse app quit/session close flows.

Please change behavior so intentional close is not treated as an error.

Suggested approach:

- Track an `isClosingIntentionally` flag.
- Set it before sending `SIGTERM` in `closeSession()`.
- In the `close` handler:
  - if intentional close, mark health `closed` and emit info-level diagnostic or suppress diagnostic;
  - if unexpected exit during active worker, mark `unhealthy` and emit error-level diagnostic.

Add/adjust test:

- Closing a healthy fake worker via `closeSession()` should not produce an error-level diagnostic.
- Unexpected fake worker exit should still produce an error diagnostic and reject pending requests.

### 2. Add one test for RPC error response handling

`JsonlRpcError` is implemented but not directly covered. Please add a test using fake RPC unknown command or a fixture response with `ok:false`.

Acceptance:

- `client.request("unknown_command")` rejects with `JsonlRpcError`.
- Error code/message from payload are preserved.

### 3. Add one test for command response timeout

The architecture explicitly calls out command response timeouts. Please add a deterministic timeout test.

Options:

- Add fake RPC flag like `--ignore-command <name>` or `--hang-first-command`.
- Or create a tiny test child that accepts stdin but never responds.

Acceptance:

- Request rejects with timeout error.
- Pending map is cleared.

## Non-Blocking Follow-Ups

These do not need to block merge unless they are easy to include now.

### A. Consider naming `model` shape compatibility

`PiState` currently uses:

```ts
model?: string;
provider?: string;
```

Architecture later expects richer model info. This is fine for M2, but note it for G0 contract freeze.

### B. Package/build coordination with Eng 1

This branch introduces `package.json`, `package-lock.json`, and `tsconfig.json`. Eng 1 is also likely touching project scaffold/build config.

Before merge, coordinate integration order:

1. If Eng 1's Electron scaffold lands first, rebase this branch and adapt paths/scripts.
2. If this branch lands first, Eng 1 should rebase and extend these scripts rather than replace them.

### C. Tracker status

The branch marks M2.1-M2.3 as `Done`. That is okay inside this worktree, but main tracker should only be considered final after requested changes and merge.

## Files Reviewed

- `package.json`
- `tsconfig.json`
- `src/main/pi/jsonlClient.ts`
- `src/main/pi/types.ts`
- `src/main/pi/piAdapter.ts`
- `src/main/pi/piWorker.ts`
- `src/main/pi/fakeRpc/fakeRpcServer.ts`
- `test/jsonlParser.test.ts`
- `test/jsonlClient.test.ts`
- `test/piWorkerFake.test.ts`
- `docs/fake-rpc.md`
- `docs/project-tracker.md`

## Implementer Response — 2026-06-26

Addressed all requested changes in this worktree.

### Requested Change 1 — Intentional close diagnostics

Updated `src/main/pi/piWorker.ts`:

- Added `isClosingIntentionally` tracking.
- `closeSession()` sets the flag before sending `SIGTERM`.
- Close handler now treats intentional close as normal shutdown:
  - marks health `closed`,
  - emits an info-level diagnostic (`RPC worker closed ...`),
  - does not emit an error diagnostic.
- Unexpected non-zero/non-clean worker exits still mark the worker unhealthy and emit error diagnostics.

Added tests in `test/piWorkerFake.test.ts`:

- `PiWorker intentional close does not create error diagnostic`
- `PiWorker unexpected exit rejects pending request and emits error diagnostic`

### Requested Change 2 — RPC error response handling test

Updated `test/jsonlClient.test.ts`:

- Added `JSONL RPC client rejects RPC error responses with code and message`.
- Uses fake RPC unknown command behavior.
- Verifies rejection is a `JsonlRpcError` and preserves:
  - `code: "FAKE_UNKNOWN_COMMAND"`,
  - message containing the unknown command name.

### Requested Change 3 — Command response timeout test

Updated `src/main/pi/fakeRpc/fakeRpcServer.ts`:

- Added deterministic fixture flag: `--ignore-command <name>`.
- The fake RPC accepts matching commands but intentionally never responds.

Updated `docs/fake-rpc.md`:

- Documented `--ignore-command <name>`.

Updated `test/jsonlClient.test.ts`:

- Added `JSONL RPC client times out command responses and clears pending request`.
- Verifies timeout rejection and `pendingCount === 0`.

### Validation

Ran:

```bash
npm run typecheck
npm test
```

Result:

```text
17 tests passed
0 failed
```

## Verdict

**Reviewer follow-up requested:** all three requested changes have been implemented and validated.
