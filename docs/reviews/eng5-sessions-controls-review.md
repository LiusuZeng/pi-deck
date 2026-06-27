# Review Feedback — Eng 5 Sessions / Controls UI

Review date: 2026-06-27  
Reviewer: Orchestrator  
Branch/worktree: `eng5/sessions-controls` / `/Users/liusu/pi-deck-worktrees/eng5-sessions-controls`

## Summary

Good UI-shell pass for session/sidebar and Pi-native controls. The branch adds:

- Project picker UI and preload/main native directory picker hook.
- Recent project UI, including invalid/deleted project visual state.
- Session sidebar fixture covering idle, working, waiting input, error, attaching, compacting, retrying, tool-running, queued, exited, unloaded.
- Sidebar priority selector in `sessionState.ts` with tests.
- Model and thinking-level UI shells with capability/unavailable states.
- Slash command picker shell scoped to active-worker `get_commands`-style data.
- Attachment picker/chips UI with native file picker hook, opaque token-shaped metadata, outside-project warning, missing/unreadable state, and `Referenced path` labels.
- Composer intervention-mode shell: Send / Steer / Follow-up / Abort.

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
npm test: 35 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: passed
```

## Important Branch / Rebase Status

The worktree is not clean and is not based on current `main`.

Current status:

```text
## eng5/sessions-controls
 M docs/project-tracker.md
 M src/main/main.ts
 M src/preload/index.ts
 M src/renderer/App.tsx
 M src/renderer/styles.css
 M src/shared/ipcSchemas.ts
 M src/shared/types.ts
?? src/renderer/sessionState.test.ts
?? src/renderer/sessionState.ts
```

Current HEAD:

```text
22759f5 Format RPC backend files
```

Current local/main includes Eng 3:

```text
a6aaac5 Support Pi RPC command envelope for smoke test
```

So the branch needs a rebase before it can merge. After rebasing, the final diff should not include unrelated Eng 3 files/changes.

## Acceptance Criteria Check

| Area | Status | Notes |
|---|---|---|
| Project picker / recent project UI | Mostly pass | UI and preload/main picker hook exist. Persistence is renderer `localStorage` for now; final app-local persistence remains backend/settings work. |
| Session sidebar UI | Pass | Covers all required state priorities with fixtures and tests. |
| Model/thinking controls | Pass for UI shell | Shows current values, capabilities, unavailable state, unsupported thinking. Real backend APIs still future. |
| Slash command picker UI | Pass for UI shell | Correctly scopes copy to `get_commands` output and excludes TUI-only promises. |
| Attachment picker/chips UI | Mostly pass | Chips label non-images as `Referenced path`; native picker returns token-shaped metadata. Needs schema tests and clearer temporary-token caveat. |
| Renderer security posture | Mostly pass | Renderer does not read files directly. Main does metadata/stat classification only. Need avoid masking IPC failures with fake fallback in production path. |
| Build/test/typecheck/format | Pass | All standard commands pass locally. |

## Requested Changes Before Merge

### 1. Rebase onto current `main` and commit the work

Please finish the branch hygiene before merge.

Acceptance:

- Branch is based on current `main` (`a6aaac5` or newer).
- Work is committed on `eng5/sessions-controls`; no uncommitted implementation files remain.
- Final diff does not include unrelated Eng 3 changes.
- Standard checks still pass.

Suggested workflow:

```bash
git stash push -u -m eng5-sessions-controls-wip
git rebase main
git stash pop
# resolve conflicts, run checks, commit
```

### 2. Coordinate with Eng 4 before final merge

Eng 4 and Eng 5 both heavily modify these files:

```text
src/main/main.ts
src/preload/index.ts
src/renderer/App.tsx
src/renderer/styles.css
src/shared/ipcSchemas.ts
src/shared/types.ts
```

This will be a real integration conflict. Eng 4 owns chat/composer/timeline; Eng 5 owns sessions/controls/sidebar/model/slash/attachments.

Acceptance:

- Before merge, rebase on whichever frontend branch lands first.
- Preserve Eng 4 chat/composer streaming behavior and Eng 5 session/control components.
- Do not replace Eng 4's `chat:*` IPC schemas/preload APIs with Eng 5's project/attachment APIs, or vice versa. The final shared API must include both sets if both features land.
- Consider splitting Eng 5 UI into smaller components (`SessionSidebar`, `ModelThinkingControls`, `AttachmentPanel`, `SlashPicker`, `ProjectHeader`) to make conflict resolution safer.

### 3. Add schema/preload boundary tests for new project/attachment contracts

You added new IPC schemas and preload API surface. Please add focused tests, similar to Eng 1's schema/IPC tests.

Minimum acceptance:

- `projectRefSchema` / `pickProjectResultSchema` accepts valid project metadata and rejects unknown/invalid fields.
- `attachmentDraftSchema` requires `selectedPathToken`, `sendMode`, `status`, and rejects invalid `kind`/`sendMode`.
- `attachmentPickerRequestSchema` rejects unknown fields.
- If practical, add a preload-side validation test or document why it is deferred.

### 4. Make fake fallback behavior explicitly dev/demo-only or remove it

In `handlePickProject()` and `handlePickAttachments()`, IPC errors currently fall back to mock project/attachment data. That is helpful during UI prototyping, but it can mask real main/preload/security failures.

Please either:

- remove the fake fallback and show an error message instead; or
- gate it behind an explicit local/demo condition and add comments that it is temporary UI-shell behavior.

Acceptance:

- Real IPC failures are not silently treated as successful user selections in production-looking code.
- UI still has static fixture data for visual coverage if needed.

### 5. Clarify attachment token limitations

`buildAttachmentDraft()` returns `selectedPathToken: randomUUID()`, but there is no main-process token registry yet. That is okay for UI shell, but future engineers could mistake it for real token authority.

Please add a comment near `buildAttachmentDraft()` or schema usage:

```ts
// M4 UI shell only: token-shaped metadata is returned for renderer authority shape.
// Real token registry/path validation for sending is implemented in AttachmentService later.
```

Acceptance:

- The current code does not imply attachment send authority is implemented.

## Non-Blocking Follow-Ups

These can wait:

1. Move recent project persistence from renderer `localStorage` to app-local settings/backend when M3 project repository lands.
2. Add native dialog main-handler tests if/when Electron IPC/dialog test harness exists.
3. Replace fake model/thinking/slash fixtures with active-worker APIs after M4 backend methods land.
4. Replace fake session fixtures with `SessionRepository` output after M3.
5. Add more accessibility tests for slash picker/listbox behavior later.

## Files Reviewed

- `src/renderer/App.tsx`
- `src/renderer/styles.css`
- `src/renderer/sessionState.ts`
- `src/renderer/sessionState.test.ts`
- `src/shared/ipcSchemas.ts`
- `src/shared/types.ts`
- `src/preload/index.ts`
- `src/main/main.ts`
- `docs/project-tracker.md`

## Verdict

**Approve after changes.**

Functionally, this is a good sessions/controls UI shell. Before merge, please:

1. Rebase onto current `main` and commit the work.
2. Coordinate/merge safely with Eng 4's overlapping frontend changes.
3. Add schema tests for new project/attachment IPC contracts.
4. Avoid or clearly gate fake fallback behavior.
5. Add comments clarifying attachment tokens are currently shell metadata only.
6. Rerun:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

Then report back with summary and test output.

## Eng 5 Resolution Update

Update date: 2026-06-27  
Responder: Eng 5

Requested changes addressed in commit:

```text
2890ca9 Implement sessions controls UI shell
```

Resolution summary:

1. **Rebase / branch hygiene** — Done.
   - Branch `eng5/sessions-controls` is rebased onto current `main` at `a6aaac5`.
   - Implementation work is committed.
   - Worktree was clean after the commit.

2. **Eng 4 coordination** — Still a merge-order coordination item.
   - Eng 4 branch was not yet merged to `main` when this update was made.
   - Final integration should preserve both Eng 4 chat/composer APIs and Eng 5 project/session/control APIs.

3. **Schema/preload boundary tests** — Done.
   - Added project/attachment schema coverage in `src/shared/ipcSchemas.test.ts`.
   - Added preload request/response validation coverage in `src/preload/index.test.ts`.

4. **Fake fallback behavior** — Done.
   - Removed mock-success fallbacks from picker IPC failure paths.
   - Project/attachment picker failures now surface an error message and do not select/add fake data.
   - Static fixtures remain only for visual UI coverage.

5. **Attachment token limitations** — Done.
   - Added explicit comment near `buildAttachmentDraft()` clarifying token-shaped metadata is M4 UI shell only.
   - Real token registry/path validation is left for future `AttachmentService` work.

Additional fix:

- Fixed a flaky fake-RPC abort test by subscribing for the abort event before invoking `abort()`.

Validation after changes:

```text
npm run typecheck: passed
npm test: 11 files passed, 49 tests passed
npm run build: passed
npm run format: passed
```
