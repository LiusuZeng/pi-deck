# Review Feedback — Eng 4 Frontend Chat / Composer

Review date: 2026-06-27  
Reviewer: Orchestrator  
Branch/worktree: `eng4/frontend-chat` / `/Users/liusu/pi-deck-worktrees/eng4-frontend-chat`

## Summary

Good frontend vertical slice. The work adds a much more complete Pi Deck chat shell:

- Session sidebar with fake session states.
- Header model/thinking/status placeholders.
- Chat timeline with user, assistant, diagnostic, and placeholder tool rows.
- Multiline composer with Send / Abort behavior.
- Streamed assistant updates from backend fake RPC through preload IPC.
- Safe markdown parser/renderer that avoids raw HTML rendering.
- Basic markdown tests.

I ran:

```bash
cd /Users/liusu/pi-deck-worktrees/eng4-frontend-chat
npm test
npm run typecheck
npm run build
npm run format
```

Result:

```text
npm test: 46 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: passed
```

## Important Branch / Rebase Status

The worktree is **not clean** and is **not actually rebased onto current `main` yet**.

Current status:

```text
## eng4/frontend-chat
 M docs/project-tracker.md
 M src/main/main.ts
 M src/preload/index.ts
 M src/renderer/App.tsx
 M src/renderer/styles.css
 M src/shared/ipcSchemas.ts
 M src/shared/types.ts
?? src/renderer/markdown.test.ts
?? src/renderer/markdown.ts
```

Current HEAD:

```text
5d65f90 Implement platform environment foundation
```

Current main/origin-main base:

```text
a6aaac5 Support Pi RPC command envelope for smoke test
```

Because the branch is behind `main`, `git diff main` also shows unrelated Eng 3 differences in:

```text
src/main/pi/jsonlClient.ts
src/main/platform/piEnvironment.test.ts
src/main/platform/rpcSmokeTest.ts
```

Those are not Eng 4-owned files and should not appear in the final Eng 4 diff.

## Acceptance Criteria Check

| Area | Status | Notes |
|---|---|---|
| M1.6 Basic layout shell | Pass | Layout is much stronger than placeholder shell. |
| M2.4 Basic chat timeline rendering | Pass | User/assistant/diagnostic/tool-placeholder rows; streaming assistant updates. |
| Markdown sanitization | Pass | Raw HTML is treated as text; links restricted to http/https/mailto. |
| M2.5 Composer prompt and abort UX | Mostly pass | Composer works with fake backend stream; needs worker lifecycle cleanup and branch cleanup. |
| Build/test/typecheck/format | Pass | All standard checks pass locally. |
| Scope discipline | Mostly pass | Adds fake chat IPC/main wiring. Acceptable for vertical slice, but keep it explicitly fake/dev until real session controller lands. |

## Requested Changes Before Merge

### 1. Finish the rebase onto current `main`

Please rebase/stage so Eng 4's final diff is only Eng 4-owned frontend/chat changes.

Acceptance:

- Branch HEAD is based on current `main` (`a6aaac5` or newer).
- `git diff main...HEAD` or PR diff does **not** include unrelated Eng 3 changes to:
  - `src/main/pi/jsonlClient.ts`
  - `src/main/platform/piEnvironment.test.ts`
  - `src/main/platform/rpcSmokeTest.ts`
- Work is committed on `eng4/frontend-chat`; no uncommitted implementation files remain.

Suggested workflow:

```bash
git stash push -u -m eng4-chat-wip
git rebase main
git stash pop
# resolve conflicts, run checks, commit
```

### 2. Add fake worker cleanup on app quit / window lifecycle

`ensureChatAdapter()` starts a fake RPC worker via `SinglePiAdapter`, but there is no cleanup path for it. Even though this is a fake vertical slice, we should not establish a pattern that leaves child workers running.

Please add cleanup such as:

- `closeFakeChatWorker()` helper that calls `chatAdapter.closeSession(chatRuntimeId)` if present.
- Call it during app quit, e.g. `before-quit` / `will-quit` or equivalent safe path.
- Make cleanup best-effort and diagnostic-safe.

Acceptance:

- Fake worker is closed on normal app quit.
- Cleanup does not throw uncaught errors during quit.
- Existing tests/build still pass.

### 3. Label fake backend IPC clearly in code/comments

Eng 4 added `chat:getSnapshot`, `chat:prompt`, `chat:abort`, and `chat:event` IPC channels that spawn the fake RPC worker. This is useful for the vertical slice, but it must remain clear that this is **temporary fake-chat wiring**, not the final session controller API.

Please add a short comment near `ensureChatAdapter()` and/or IPC registration:

```ts
// M2/M2.5 temporary fake chat bridge for renderer development.
// Real project/session worker management lands in M3/M5.
```

Acceptance:

- Future engineers do not confuse this fake bridge with final session lifecycle architecture.

### 4. Optional but recommended: handle preload event parse errors defensively

In `preload/index.ts`, `chat.onEvent` currently parses incoming payload and directly calls the listener:

```ts
listener(chatRuntimeEventSchema.parse(payload));
```

If an invalid event somehow arrives, this throws in the renderer event callback. Consider `safeParse` and `console.warn` instead. This is not blocking, but improves resilience.

## Non-Blocking Follow-Ups

These can wait:

1. Add renderer/component tests once a renderer test environment is established.
2. Replace local fake sessions with real session repository state in M3.
3. Replace temporary fake-chat IPC with the real session controller API when M3/M5 lands.
4. Auto-scroll timeline to latest streamed message.
5. Keep coordinating with Eng 5 on sidebar/model/slash/attachment UI boundaries.

## Files Reviewed

- `src/renderer/App.tsx`
- `src/renderer/styles.css`
- `src/renderer/markdown.ts`
- `src/renderer/markdown.test.ts`
- `src/shared/ipcSchemas.ts`
- `src/shared/types.ts`
- `src/preload/index.ts`
- `src/main/main.ts`
- `docs/project-tracker.md`

## Verdict

**Approve after small changes.**

Functionally, this is a good M1.6/M2.4/M2.5 vertical slice. Before merge, please:

1. Finish rebase onto current `main` and commit the work.
2. Ensure the final diff does not include unrelated Eng 3 changes.
3. Add fake worker cleanup.
4. Add comments marking fake chat bridge as temporary.
5. Rerun:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

Then report back with summary and test output.

## Resolution — Eng 4

Updated after review on 2026-06-27:

- Rebased `eng4/frontend-chat` onto current `main` at `a6aaac5`.
- Verified final Eng 4 diff does not include unrelated Eng 3 files:
  - `src/main/pi/jsonlClient.ts`
  - `src/main/platform/piEnvironment.test.ts`
  - `src/main/platform/rpcSmokeTest.ts`
- Added best-effort fake chat worker cleanup on app quit via `closeFakeChatWorker()` and `before-quit`.
- Added comments marking chat IPC/main wiring as temporary M2/M2.5 fake chat bridge until real M3/M5 session lifecycle work lands.
- Changed preload chat event handling to `safeParse` and `console.warn` for invalid event payloads.
- Committed the addressed review changes on `eng4/frontend-chat`.

Validation rerun:

```text
npm run typecheck: passed
npm test: 46 tests passed
npm run build: passed
npm run format: passed
```
