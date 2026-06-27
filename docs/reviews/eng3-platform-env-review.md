# Review Feedback — Eng 3 Platform / Pi Environment

Review date: 2026-06-26  
Reviewer: Orchestrator  
Branch/worktree: `eng3/platform-env` / `/Users/liusu/pi-deck-worktrees/eng3-platform-env`

## Summary

Good platform foundation. The branch implements the core pieces needed for M1.4, M1.5, and M3.2:

- Pi binary resolution across app setting, PATH, login shell, and common paths.
- `pi --version` capture with diagnostics.
- Environment redaction for diagnostics.
- Narrow settings parser for `sessionDir`, `images.blockImages`, and `images.autoResize` only.
- `EffectivePiConfig` resolver with app/env/global/project/default precedence.
- Trust-dependent project `sessionDir` candidate handling.
- Conservative trust-dependent image setting behavior.
- Minimal no-resource/no-session RPC smoke test with temp cwd, cache, and side-effect check.
- Tests for binary resolution, config precedence, settings parse errors, and fake smoke test.

I ran:

```bash
cd /Users/liusu/pi-deck-worktrees/eng3-platform-env
npm test
npm run typecheck
```

Result:

```text
npm test: 8 tests passed
npm run typecheck: passed
```

## Acceptance Criteria Check

| Area | Status | Notes |
|---|---|---|
| M1.4 Pi binary resolution/version | Mostly pass | App/PATH/common paths tested; shell fallback test needs to verify actual shell path source distinctly. |
| M1.5 Minimal RPC smoke test | Mostly pass | Full args are returned and fake smoke works; test should verify child actually receives full canonical flags and command payload should align with RPC client shape. |
| M3.2 EffectivePiConfig | Pass | Good coverage of app/env/global/project/default precedence and trust-dependent image/sessionDir behavior. |
| Diagnostics/redaction | Pass | Env redaction implemented and tested for API key. |
| Scope discipline | Pass | No session scanning/UI/attachments implemented. |

## Requested Changes Before Merge

### 1. Make shell fallback test prove `source === "shell"`

The current fallback test allows either `path` or `shell`:

```js
assert.ok(['path', 'shell'].includes(shellResult.source));
```

This does not prove the login-shell lookup path works. Please add a deterministic test where PATH lookup fails but the configured shell command returns a Pi path.

Suggested approach:

- Create a fake shell executable in a temp dir.
- When invoked as `fake-shell -lc 'command -v pi'`, print the fake Pi path.
- Call `resolvePiBinary({ env: { PATH: '' }, shellPath: fakeShell, commonPaths: [] })`.
- Assert `result.source === 'shell'`.

Acceptance:

- Test fails if shell lookup is broken.
- PATH/common paths are not involved in that specific test.

### 2. Verify smoke test child receives the full canonical flags

The smoke test result exposes `MINIMAL_RPC_SMOKE_ARGS`, and the test compares `first.args` to that constant. That verifies the result object, but not that the fake Pi process actually received the full flags.

Please add a fake Pi script variant that records `process.argv.slice(2)` to a temp file, then assert it received exactly:

```text
--mode rpc --no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline
```

Acceptance:

- Test proves spawned child saw the full no-resource/no-session command.
- This protects G1 against accidental smoke-test flag drift.

### 3. Align smoke-test RPC command shape with Eng 2 JSONL client / protocol

`MinimalJsonlRpcClient.request()` currently sends:

```ts
{ id, command, params }
```

Eng 2's JSONL client sends:

```ts
{ id, type: "command", command, params }
```

Please either:

- include `type: "command"` in the smoke-test command payload now; or
- after rebasing onto Eng 2, reuse Eng 2's `JsonlRpcClient` and remove the duplicate minimal client.

Preferred for merge: use the shared Eng 2 transport once Eng 2 lands. If this branch is updated before that integration, at least add `type: "command"` so the command shape is consistent.

Acceptance:

- Fake Pi smoke test still passes.
- Command payload is protocol-compatible with the backend JSONL client.

### 4. Prepare for integration with Eng 1/Eng 2 project structure

This branch currently creates a standalone root package:

```text
package.json
src/index.ts
src/platform/...
test/platform-env.test.js
```

Eng 1 and Eng 2 also created package/build/test scaffolds. Before merging to main, we need one integrated app structure.

Expected integration after Eng 1/2 merge:

- Move platform modules under the shared app structure, likely `src/main/platform/` or `src/main/pi/`.
- Reuse the root `package.json` / tsconfig from Eng 1.
- Reuse Eng 2 JSONL client for smoke test where practical.
- Replace local `node-shim.d.ts` with normal Node/Electron project typings from the merged scaffold.

This can happen during rebase/integration rather than in this standalone branch, but please be ready for it. Do not merge this branch directly over Eng 1's scaffold without reconciling package/tsconfig.

## Non-Blocking Follow-Ups

These do not need to block the current review unless easy to include:

1. Add tests for app `sessionDir` overriding inherited `PI_CODING_AGENT_SESSION_DIR` specifically.
2. Add tests that project-relative `sessionDir` resolves relative to `<cwd>/.pi` and global-relative resolves relative to `agentDir` in separate named cases.
3. Add a diagnostics test for candidate absolute path outside both project and agent dir.
4. Consider exposing structured worker spawn args separately from config: e.g. `{ args: ["--session-dir", ...], env }`.

## Files Reviewed

- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `src/platform/piEnvironment.ts`
- `src/platform/rpcSmokeTest.ts`
- `src/platform/node-shim.d.ts`
- `test/platform-env.test.js`
- `docs/project-tracker.md`

## Verdict

**Approve after small changes.**

Please address requested changes 1-3, rerun:

```bash
npm test
npm run typecheck
```

Then report back with summary and test output.

Requested change 4 is an integration warning: after Eng 1 and Eng 2 are merged, this branch should rebase and adapt to the shared project structure before final merge.
