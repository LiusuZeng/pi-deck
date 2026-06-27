# Re-Review Feedback — Eng 5 Sessions / Controls UI

Review date: 2026-06-27  
Reviewer: Orchestrator  
Branch/worktree: `eng5/sessions-controls` / `/Users/liusu/pi-deck-worktrees/eng5-sessions-controls`

## Summary

Thanks for addressing the first review comments. The branch is now committed and several requested fixes are implemented:

- Project/attachment schema tests added.
- Preload validation tests added.
- Fake project/attachment fallback behavior no longer silently selects mock data on IPC failure.
- Attachment token limitation is clearly commented as UI-shell metadata only.
- Standard checks pass.

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
npm test: 49 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: passed
```

## Requested Changes Verification

| Previous request | Status | Notes |
|---|---|---|
| Commit work / clean worktree | Pass | Branch has commit `2890ca9 Implement sessions controls UI shell`; worktree is clean. |
| Add schema/preload tests | Pass | Added `src/shared/ipcSchemas.test.ts` coverage and `src/preload/index.test.ts`. |
| Avoid fake fallback masking IPC failures | Pass | Project/attachment picker failures now show error messages and do not add mock selections. |
| Clarify attachment tokens are shell metadata only | Pass | Comment added near `buildAttachmentDraft()`. |
| Rebase onto current main | Not yet | Branch is still based on pre-Eng4 main (`a6aaac5`) and does not include Eng 4's pushed chat work. |
| Coordinate with Eng 4 overlap | Still required | Eng 4 has now pushed to `origin/main`; this branch must rebase onto it and preserve both API/UI surfaces. |

## Current Acceptance Status

| Area | Status | Notes |
|---|---|---|
| Session/sidebar UI shell | Pass | Covers all sidebar priority states and tests selector behavior. |
| Project picker UI/native hook | Pass for shell | Preload/main hook exists; final persistence remains future M3 work. |
| Model/thinking controls | Pass for shell | Capability/unavailable/unsupported states represented. |
| Slash picker | Pass for shell | Copy correctly scopes to active-worker commands and excludes TUI-only promises. |
| Attachment picker/chips | Pass for shell | Native picker metadata/tokens; `Referenced path` labels; outside/missing states. |
| Build/test/typecheck/format | Pass | All standard checks pass. |

## Remaining Blocker Before Merge

### Must rebase onto Eng 4 / latest `origin/main`

Eng 4 has pushed the approved chat/composer/timeline work to `origin/main`:

```text
6c0a1c7 Implement frontend chat shell
2714619 Add Eng 4 rereview notes
```

Eng 5 is currently based on:

```text
a6aaac5 Support Pi RPC command envelope for smoke test
```

This means Eng 5 currently does **not** include Eng 4's chat/composer/timeline work. Since both branches modify the same files, merging Eng 5 as-is would overwrite or conflict with the demo chat loop.

Files with expected conflict:

```text
src/main/main.ts
src/preload/index.ts
src/renderer/App.tsx
src/renderer/styles.css
src/shared/ipcSchemas.ts
src/shared/types.ts
```

## Required Next Steps

1. Update/rebase onto latest `origin/main`.
2. Resolve conflicts by preserving both:
   - Eng 4 `chat:*` IPC/preload/types and fake chat/composer/timeline behavior.
   - Eng 5 `project:*` / `attachments:*` IPC/preload/types and session/control UI shells.
3. Do not break Demo Slice 1:
   - app launches,
   - fake backend session appears,
   - prompt sends,
   - assistant streams,
   - abort works,
   - fake worker cleanup remains.
4. Run full validation again:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

5. Report back with final commit hash and test output.

## Integration Guidance

The safest path is to split Eng 5 UI into components instead of replacing Eng 4's `App.tsx` wholesale:

- `SessionSidebar`
- `ProjectHeader`
- `ModelThinkingControls`
- `AttachmentPanel`
- `SlashPicker`
- `sessionState.ts`

Then wire those into Eng 4's existing app shell/chat flow.

Shared schemas/types should include both groups:

- Existing Eng 4:
  - `chatMessageSchema`
  - `chatStateSchema`
  - `chatSnapshotSchema`
  - `chatPromptRequestSchema`
  - `chatAbortRequestSchema`
  - `chatRuntimeEventSchema`
  - `chat:*` IPC channels

- Eng 5 additions:
  - `projectRefSchema`
  - `pickProjectResultSchema`
  - `attachmentPickerRequestSchema`
  - `attachmentDraftSchema`
  - `pickAttachmentsResultSchema`
  - `project:*` / `attachments:*` IPC channels

## Verdict

**Functionally approved, but not ready to merge until rebased onto Eng 4/latest main.**

The remaining work is integration conflict resolution, not feature correctness.

## Eng 5 Rebase Resolution Update

Update date: 2026-06-27  
Responder: Eng 5

Resolution summary:

- Rebased `eng5/sessions-controls` onto latest `origin/main` containing Eng 4 chat work (`2714619`).
- Resolved conflicts in shared IPC schemas/types/preload/main and renderer app/styles.
- Preserved Eng 4 Demo Slice 1 fake chat path:
  - `chat:*` IPC schemas/channels remain present.
  - `window.piDeck.chat` preload API remains present.
  - fake backend session snapshot, prompt streaming, abort, sanitized markdown timeline, and fake worker cleanup remain wired.
- Preserved Eng 5 sessions/controls work:
  - `project:*` and `attachments:*` IPC schemas/channels remain present.
  - `window.piDeck.projects` and `window.piDeck.attachments` preload APIs remain present.
  - session sidebar priority fixtures, model/thinking controls, project picker UI, slash picker, attachment chips, and referenced-path labels remain wired.

Validation after conflict resolution:

```text
npm test: 12 files passed, 53 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: passed
```
