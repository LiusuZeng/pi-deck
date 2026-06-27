# Final Re-Review — Eng 5 Sessions / Controls UI

Review date: 2026-06-28  
Reviewer: Orchestrator  
Branch/worktree: `eng5/sessions-controls` / `/Users/liusu/pi-deck-worktrees/eng5-sessions-controls`

## Summary

The demo-blocking attachment issue is fixed. The default selected attachments are now empty, so the primary demo flow is unblocked:

```text
Launch Pi Deck → type prompt → Send → assistant streams
```

The attachment edge-case examples, including missing/unreadable and outside-project files, are still visible in a separate non-selected example strip.

Current branch head at review time:

```text
0c49ed7 Implement sessions controls UI shell
```

Post-review demo note:

- During manual demo, clicking `+ New session` creates a UI-shell-only row (real new-session backend is not implemented yet). Eng 5 added a guard so sending from UI-only fixture rows shows a clear explanatory message instead of calling `chat:prompt` with a non-runtime id.

The branch is based on latest Eng 4 `origin/main` and preserves both:

- Eng 4 chat/composer/fake streaming path.
- Eng 5 sessions/sidebar/project/model/thinking/slash/attachment control shells.

## Validation

I ran:

```bash
cd /Users/liusu/pi-deck-worktrees/eng5-sessions-controls
npm test
npm run typecheck
npm run build
npm run format
```

Result:

```text
npm test: 53 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: passed
```

## Requested Fix Verification

| Issue | Status | Notes |
|---|---|---|
| Default missing attachment blocked fresh send | Fixed | `attachments` now initializes to `[]`. |
| Missing/outside attachment examples still demonstrable | Fixed | `AttachmentExampleStrip` shows examples as not selected. |
| Demo Slice chat path preserved | Pass | Chat prompt/stream/abort code remains integrated with Eng 4 fake backend. |
| Worktree clean | Pass at review time | No uncommitted changes at review time; post-review demo guard was added afterward. |

## Current Acceptance Status

| Area | Status | Notes |
|---|---|---|
| Session/sidebar UI shell | Done | Sidebar state priority fixtures and tests included. |
| Project picker UI/native hook | Done for shell | Safe preload/main picker path present. |
| Model/thinking controls | Done for shell | Capability/unavailable/unsupported states shown. |
| Slash command picker | Done for shell | Scoped copy to active-worker command data; TUI-only commands not promised. |
| Attachment picker/chips | Done for shell | Empty default selection; examples non-selected; chips say `Referenced path`. |
| Demo Slice 2 readiness | Ready for integration | Should merge after final approval and then run manual demo validation. |

## Merge Guidance

This branch is approved for integration. After merge, run the Demo Slice 2 validation:

```text
Launch Pi Deck
→ fake chat prompt still streams
→ abort still works
→ sidebar/control UI visible
→ project picker opens native directory picker
→ attachment picker opens native file picker
→ selected non-image files show Referenced path
```

## Verdict

**Approved for integration.**

No further Eng 5 changes requested for this scope.
