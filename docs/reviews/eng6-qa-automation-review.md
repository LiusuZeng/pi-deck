# Review Feedback — Eng 6 QA / Automation

Review date: 2026-06-27  
Reviewer: Orchestrator  
Branch/worktree: `eng6/qa-automation` / `/Users/liusu/pi-deck-worktrees/eng6-qa-automation`

## Summary

Good QA foundation pass. This branch adds useful test infrastructure and acceptance artifacts:

- Extended fake RPC scenarios for tool, queue, compaction, retry, and extension UI events.
- Shared fake RPC test harness under `src/test/fakeRpcHarness.ts`.
- Fake Pi shim that lets platform smoke-test code exercise the shared fake RPC implementation.
- Additional fake RPC fixture tests.
- Real Pi smoke-test matrix in `docs/real-pi-smoke-test-matrix.md`.
- State reducer fixture contract in `docs/state-reducer-fixtures.json`.
- Updated fake RPC documentation.
- Tracker updates for QA/gate coverage and blockers.

I ran:

```bash
cd /Users/liusu/pi-deck-worktrees/eng6-qa-automation
npm test
npm run typecheck
npm run build
npm run format
```

Result:

```text
npm test: 48 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: passed
```

## Acceptance Criteria Check

| Area | Status | Notes |
|---|---|---|
| Test infra support | Pass | Reuses existing Vitest setup; adds shared fake RPC helper. |
| Fake RPC fixtures | Pass | Extended prompt scenarios cover tool/queue/compaction/retry/extension UI request. |
| JSONL / transport coverage | Pass | Existing transport tests still pass; fake RPC failure fixtures covered. |
| Platform smoke fixture | Pass | `runMinimalRpcSmokeTest` runs against fake Pi shim. |
| State reducer fixtures | Pass as artifact | JSON fixtures drafted; will need wiring once reducer target lands. |
| Real Pi smoke matrix | Pass as artifact | Matrix covers G1-G4/MVP areas with safety rules. |
| Tracker updates | Pass with caveat | Good QA tracking, but branch is behind latest origin/main and uncommitted. |

## Requested Changes Before Merge

### 1. Commit the QA work

The worktree currently has uncommitted changes and untracked files:

```text
 M docs/fake-rpc.md
 M docs/project-tracker.md
 M src/main/pi/fakeRpc/fakeRpcServer.ts
 M src/main/pi/piWorkerFake.test.ts
?? docs/real-pi-smoke-test-matrix.md
?? docs/state-reducer-fixtures.json
?? src/main/pi/fakeRpcFixtures.test.ts
?? src/test/
```

Please commit the work on `eng6/qa-automation` after any final edits.

Acceptance:

- `git status --short` is clean.
- Commit message summarizes QA fixtures/smoke matrix work.

### 2. Rebase onto latest `origin/main` after Eng 4

This branch is currently based on `a6aaac5`. Eng 4 has since pushed chat work to `origin/main`:

```text
6c0a1c7 Implement frontend chat shell
2714619 Add Eng 4 rereview notes
```

Please rebase before merge so QA artifacts land on the current integrated app.

Acceptance:

- Branch includes latest `origin/main`.
- Full validation still passes.
- No conflicts/drop of Eng 4 chat tests or schemas.

### 3. Align fake RPC docs with built source path after integration

`docs/fake-rpc.md` still shows a build/run example using:

```bash
node dist/src/main/pi/fakeRpc/fakeRpcServer.js
```

But the current Electron build does not necessarily emit that path in the packaged/main build, and tests now use `src/test/fakeRpcHarness.ts` with esbuild. Please adjust the doc wording so it is clear that direct `dist/...` execution is a development-only example if available, and the canonical test path is the shared harness.

Acceptance:

- Docs do not imply a guaranteed `dist/src/main/...` path after Electron build.
- `src/test/fakeRpcHarness.ts` is documented as the reliable test helper.

### 4. Add a note that extension UI response/write-failure fixtures are not implemented yet

The fake RPC now emits `extension_ui_request`, which is good. It does not yet simulate `respondToExtensionUi`, timeout resolution, late response suppression, or stdin write failure. That is okay because the backend implementation is not present yet, but the docs/tracker should say this clearly.

Acceptance:

- `docs/fake-rpc.md` or tracker notes say extension UI request emission exists, but response/timeout/write-failure fixtures remain G4 follow-up.

## Non-Blocking Follow-Ups

These can wait until related implementation lands:

1. Wire `docs/state-reducer-fixtures.json` into actual reducer unit tests once M5 reducer exists.
2. Add Demo Slice 1 checklist automation/manual doc after Eng 4 is merged and stable.
3. Add renderer/UI tests after Eng 4/Eng 5 integration settles.
4. Run real Pi G1 smoke matrix in a controlled temp root once the team approves use of installed Pi.
5. Add extension UI timeout/write-failure fake scenarios once `respondToExtensionUi` backend exists.

## Files Reviewed

- `src/main/pi/fakeRpc/fakeRpcServer.ts`
- `src/main/pi/fakeRpcFixtures.test.ts`
- `src/main/pi/piWorkerFake.test.ts`
- `src/test/fakeRpcHarness.ts`
- `docs/fake-rpc.md`
- `docs/real-pi-smoke-test-matrix.md`
- `docs/state-reducer-fixtures.json`
- `docs/project-tracker.md`

## Verdict

**Approve after small changes.**

Functionally, this is a good QA automation foundation. Before merge, please:

1. Commit the work.
2. Rebase onto latest `origin/main` with Eng 4 included.
3. Clarify fake RPC docs around the reliable test harness and extension UI follow-ups.
4. Rerun:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

Then report back with summary and test output.
