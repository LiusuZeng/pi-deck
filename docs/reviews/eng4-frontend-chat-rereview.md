# Re-Review Feedback — Eng 4 Frontend Chat / Composer

Review date: 2026-06-27  
Reviewer: Orchestrator  
Branch/worktree: `eng4/frontend-chat` / `/Users/liusu/pi-deck-worktrees/eng4-frontend-chat`

## Summary

Thanks for addressing the review comments. The branch is now clean, committed, and based on current `main`.

Current branch head:

```text
6c0a1c7 Implement frontend chat shell
```

Current base includes:

```text
a6aaac5 Support Pi RPC command envelope for smoke test
```

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

## Requested Changes Verification

| Previous request | Status | Notes |
|---|---|---|
| Finish rebase onto current `main` | Pass | `main` is an ancestor of `HEAD`; final diff no longer includes unrelated Eng 3 changes. |
| Commit the work / clean worktree | Pass | Worktree is clean. |
| Add fake worker cleanup | Pass | `closeFakeChatWorker()` added and wired to `before-quit` with best-effort diagnostics. |
| Mark fake chat bridge as temporary | Pass | Comments added near chat IPC registration and `ensureChatAdapter()`. |
| Handle preload event parse errors defensively | Pass | `safeParse` + `console.warn` used instead of throwing in event callback. |

## Current Acceptance Status

| Area | Status | Notes |
|---|---|---|
| M1.6 Basic layout shell | Done | Header/sidebar/chat/composer shell implemented. |
| M2.4 Basic chat timeline rendering | Done | User/assistant/diagnostic/tool-placeholder rows; sanitized markdown; fake stream updates. |
| M2.5 Composer prompt and abort UX | Done for fake vertical slice | Multiline composer, send, backend fake prompt stream, abort call, error handling. |
| Renderer safety | Pass | Markdown parser treats raw HTML as text and restricts links to http/https/mailto. |
| Build/test/typecheck/format | Pass | All standard commands pass. |

## Integration Notes

This branch is approved for integration, but there is a major expected conflict with Eng 5's sessions/controls branch. Both modify:

```text
src/main/main.ts
src/preload/index.ts
src/renderer/App.tsx
src/renderer/styles.css
src/shared/ipcSchemas.ts
src/shared/types.ts
```

Recommended integration sequence:

1. Merge Eng 4 first because it owns chat/composer/timeline and is now clean.
2. Ask Eng 5 to rebase onto Eng 4 and preserve both API surfaces:
   - Eng 4 `chat:*` IPC/preload/types.
   - Eng 5 `project:*` and `attachments:*` IPC/preload/types.
3. During Eng 5 rebase, split UI into components if needed to avoid overwriting Eng 4's chat/composer implementation.

## Minor Non-Blocking Notes

- The fake chat bridge comments are duplicated near registration and `ensureChatAdapter()`. This is acceptable; future cleanup can consolidate.
- `before-quit` cleanup is sufficient for this fake vertical slice. Final quit behavior will be revisited in M5/M7.

## Verdict

**Approved for integration.**

No further Eng 4 changes requested for M1.6/M2.4/M2.5 scope.
