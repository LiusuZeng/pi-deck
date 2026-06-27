# Re-Review Feedback — Eng 3 Platform / Pi Environment

Review date: 2026-06-27  
Reviewer: Orchestrator  
Branch/worktree: `eng3/platform-env` / `/Users/liusu/pi-deck-worktrees/eng3-platform-env`

## Summary

Thanks for addressing the review comments. The requested changes are implemented and verified.

I ran:

```bash
cd /Users/liusu/pi-deck-worktrees/eng3-platform-env
npm test
npm run typecheck
```

Result:

```text
npm test: 9 tests passed
npm run typecheck: passed
```

## Requested Changes Verification

| Previous request | Status | Notes |
|---|---|---|
| Make shell fallback test prove `source === "shell"` | Pass | Added deterministic fake shell test with empty PATH and no common paths. |
| Verify smoke-test child receives full canonical flags | Pass | Fake Pi records `process.argv.slice(2)` and test asserts exact `MINIMAL_RPC_SMOKE_ARGS`. |
| Align smoke-test RPC command shape with Eng 2 protocol | Pass | Smoke client now sends `{ id, type: "command", command, params }`; test verifies payload. |
| Prepare for integration with Eng 1/2 structure | Acknowledged | Still needs rebase/adaptation after Eng 1/2 merge; no standalone merge over app scaffold. |

## Current Acceptance Status

| Area | Status | Notes |
|---|---|---|
| M1.4 Pi binary resolution/version | Done for implementation | App/PATH/shell/common resolution, version capture, missing/broken diagnostics, env redaction covered by tests. Real Finder/macOS manual validation still belongs to G1. |
| M1.5 Minimal RPC smoke test | Done for implementation | Full no-resource/no-session args, temp cwd, get_state, side-effect check, cache, and protocol payload covered with fake Pi. Real Pi validation still belongs to G1. |
| M3.2 EffectivePiConfig | Done for implementation | App/env/global/project/default precedence and trust-dependent image/sessionDir behavior covered. |

## Remaining Integration Notes

No additional standalone Eng 3 code changes are requested.

Before merging this work into `main`, integrate it into the unified app scaffold:

1. Merge Eng 1 first.
2. Rebase Eng 2 onto Eng 1 and integrate RPC transport/fake RPC.
3. Rebase Eng 3 after Eng 2 where possible.
4. Move these modules into the app structure, likely under `src/main/platform/` or `src/main/pi/`.
5. Replace local `node-shim.d.ts` / standalone package setup with the merged Electron/Node TypeScript config.
6. Prefer reusing Eng 2's `JsonlRpcClient` for the real smoke test instead of keeping a duplicate minimal JSONL client long-term.

## Verdict

**Approved for integration.**

No further changes requested for Eng 3's M1.4, M1.5, and M3.2 implementation scope, subject to the integration/rebase notes above.
