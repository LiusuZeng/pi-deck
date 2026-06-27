# Re-Review Feedback — Eng 2 RPC / Backend

Review date: 2026-06-26  
Reviewer: Orchestrator  
Branch/worktree: `eng2/rpc-backend` / `/Users/liusu/pi-deck-worktrees/eng2-rpc-backend`

## Summary

Thanks for addressing the first review comments. The requested changes are implemented and verified.

I ran:

```bash
cd /Users/liusu/pi-deck-worktrees/eng2-rpc-backend
npm test
```

Result:

```text
17 tests passed
```

## Requested Changes Verification

| Previous request | Status | Notes |
|---|---|---|
| Intentional `PiWorker.closeSession()` should not emit error diagnostics | Pass | `isClosingIntentionally` added; close emits info diagnostic. Test added. |
| Add RPC error response handling test | Pass | `unknown_command` now rejects with `JsonlRpcError`; code/message verified. |
| Add command response timeout test | Pass | Fake RPC supports `--ignore-command`; timeout clears pending request. |

## Current Acceptance Status

| Area | Status | Notes |
|---|---|---|
| M2.1 Strict JSONL transport | Done | Parser/client tests cover required framing, routing, timeout, errors, stderr. |
| M2.2 Fake RPC harness | Done | Deterministic fake process supports current needs and extension point for later cases. |
| M2.3 Single PiWorker lifecycle | Done | Fake-RPC integration tests cover state/messages, prompt streaming, abort, close, unexpected exit. |

## Remaining Integration Notes

No additional Eng 2 code changes are required for the standalone M2 scope.

Before merging to `main`, coordinate integration order with Eng 1 because both branches created project-level build/test config:

1. Prefer landing Eng 1 Electron scaffold first.
2. Rebase this branch onto Eng 1.
3. Move/adapt RPC modules into the merged project structure.
4. Standardize test runner/scripts so both Eng 1 and Eng 2 tests run from one root command.

Also coordinate with Eng 3 later so its smoke test can reuse this JSONL client rather than keeping a duplicate minimal JSONL client.

## Verdict

**Approved for integration.**

No further changes requested for Eng 2's M2 implementation, subject to the integration/rebase notes above.
