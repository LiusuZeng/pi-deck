# Main-Branch Review — Eng 2 RPC Backend Foundation

Review date: 2026-06-27  
Reviewer: Orchestrator  
Commit reviewed: `be520ac Implement RPC backend foundation`  
Branch: `main` / `origin/main`

## Summary

Eng 2's RPC backend work is now on `main` and functionally looks good. The integrated branch includes:

- `src/main/pi/jsonlClient.ts`
- `src/main/pi/piWorker.ts`
- `src/main/pi/piAdapter.ts`
- `src/main/pi/types.ts`
- fake RPC harness under `src/main/pi/fakeRpc/`
- Vitest tests under `src/main/pi/*.test.ts`
- `docs/fake-rpc.md`
- prior review notes under `docs/reviews/`

The implementation successfully rebased onto Eng 1's Electron/Vitest scaffold.

## Validation Run

I ran from main:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

Results:

```text
npm test: 33 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: failed
```

Formatting failed on these files:

```text
src/main/pi/fakeRpc/fakeRpcServer.ts
src/main/pi/jsonlClient.test.ts
src/main/pi/jsonlClient.ts
src/main/pi/jsonlParser.test.ts
src/main/pi/piWorker.ts
src/main/pi/piWorkerFake.test.ts
```

## Acceptance Criteria Check

| Area | Status | Notes |
|---|---|---|
| M2.1 Strict JSONL transport | Pass | Tests cover chunk boundaries, malformed JSON, U+2028/U+2029, response/event routing, errors, timeouts. |
| M2.2 Fake RPC harness | Pass | Integrated under `src/main/pi/fakeRpc/`; documented in `docs/fake-rpc.md`. |
| M2.3 Single PiWorker lifecycle | Pass | Tests cover state/messages, prompt streaming, abort, intentional close, unexpected exit. |
| Integration with Eng 1 scaffold | Mostly pass | Uses Vitest and app tsconfig successfully. Formatting needs cleanup. |
| Build/typecheck | Pass | Both pass. |
| Formatting | Fail | Must run Prettier/write fix. |

## Required Follow-Up

### 1. Fix formatting on main

Run:

```bash
npm exec prettier -- --write \
  src/main/pi/fakeRpc/fakeRpcServer.ts \
  src/main/pi/jsonlClient.test.ts \
  src/main/pi/jsonlClient.ts \
  src/main/pi/jsonlParser.test.ts \
  src/main/pi/piWorker.ts \
  src/main/pi/piWorkerFake.test.ts
```

Then rerun:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

Acceptance:

- All four commands pass on `main`.
- Commit the formatting-only fix.

## Non-Blocking Notes

1. **Good integration choice:** Eng 2 adapted tests to Vitest instead of keeping the standalone Node test package.
2. **Future Eng 3 integration:** Eng 3's smoke test should reuse `JsonlRpcClient` where practical rather than keeping a duplicate minimal JSONL client.
3. **Future IPC wiring:** No renderer/preload exposure yet, which is correct for M2. Frontend should still use fake/local data until explicit IPC contracts are added.

## Verdict

**Functionally approved, but main currently needs a formatting fix.**

Once formatting is fixed and the standard validation commands pass, Eng 2's M2 scope can be considered complete on main.
