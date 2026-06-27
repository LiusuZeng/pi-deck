# Final Re-Review Feedback — Eng 5 Sessions / Controls UI

Review date: 2026-06-27  
Reviewer: Orchestrator  
Branch/worktree: `eng5/sessions-controls` / `/Users/liusu/pi-deck-worktrees/eng5-sessions-controls`

## Summary

Good integration progress. Eng 5 has now rebased onto Eng 4/latest `origin/main` and preserved both major surfaces:

- Eng 4 chat/composer/fake streaming path is still present.
- Eng 5 project picker, attachment picker/chips, session state/sidebar, model/thinking controls, slash command UI shells are integrated.
- Shared IPC/types now include both `chat:*` and `project:*` / `attachments:*` APIs.
- Worktree is clean and committed.

Current branch head:

```text
f62abab Implement sessions controls UI shell
```

Current base includes Eng 4:

```text
2714619 Add Eng 4 rereview notes
6c0a1c7 Implement frontend chat shell
```

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

## Requested Changes Verification

| Previous request | Status | Notes |
|---|---|---|
| Rebase onto Eng 4/latest main | Pass | `origin/main` is ancestor of branch; Eng 4 chat APIs/UI are preserved. |
| Preserve both API surfaces | Pass | `chat:*`, `project:*`, and `attachments:*` schemas/preload APIs are all present. |
| Commit work / clean worktree | Pass | Worktree is clean; commit `f62abab`. |
| Schema/preload tests | Pass | Tests cover project/attachment schemas and preload validation. |
| Fake fallback removal | Pass | Picker IPC errors show error messages rather than silently adding mock selections. |
| Attachment token limitation comment | Pass | Main code clearly marks token-shaped metadata as UI-shell only. |
| Full validation | Pass | Test/typecheck/build/format all pass. |

## Remaining Required Change Before Merge

### Demo Slice regression: default selected attachments block sending

The integrated app currently initializes composer attachments with `fakeAttachmentFixture`, which includes a missing/unreadable attachment:

```ts
const [attachments, setAttachments] = useState<AttachmentDraft[]>(
  fakeAttachmentFixture,
);
```

`fakeAttachmentFixture` includes:

```text
deleted.txt -> status: "missing"
```

`handleSend()` blocks when any attachment status is not `ready`:

```ts
if (hasBlockingAttachment) {
  setComposerError("Remove or reselect deleted/unreadable attachments before sending.");
  return;
}
```

This means the main Demo Slice chat path can be blocked on first launch unless the user notices and removes the fake missing attachment. That violates our immediate demo goal:

```text
Launch Pi Deck → type prompt → send → assistant streams
```

Please adjust this before merge.

Recommended fix:

- Initialize selected composer attachments to `[]` or only ready attachments.
- Keep missing/outside/binary examples visible in a separate non-selected fixture panel if you want to demonstrate those states.
- The default path should allow sending a prompt immediately.

Acceptance:

- On fresh app launch, user can type a prompt and send without first removing a fake missing attachment.
- Attachment warning/error states remain demonstrable somewhere in the UI or tests.
- `npm test`, `npm run typecheck`, `npm run build`, and `npm run format` still pass.

## Non-Blocking Notes

1. `Steer` and `Follow-up` buttons are disabled in the working fake slice. That is acceptable for the current UI shell; real behavior lands later.
2. Recent projects are still persisted in renderer `localStorage`; backend/app-local persistence can replace this in M3.
3. `App.tsx` is now large. Future cleanup should split major UI sections into components, but this does not block the demo if the send path is fixed.

## Verdict

**Almost approved; one demo-blocking fix required.**

Please fix the default missing attachment issue, rerun:

```bash
npm test
npm run typecheck
npm run build
npm run format
```

Then report back with the new commit hash and test output.

## Eng 5 Final Fix Update

Update date: 2026-06-27  
Responder: Eng 5

Resolution summary:

- Fixed the demo-blocking default attachment state.
- Composer now initializes with no selected attachments, so fresh launch supports:

```text
launch → type prompt → send → assistant streams
```

- Kept attachment warning/error examples visible as a non-selected `Attachment state examples` strip in the timeline. These examples demonstrate outside-project, binary/reference, image, and missing-file states without blocking the default chat send path.

Validation after fix:

```text
npm test: 12 files passed, 53 tests passed
npm run typecheck: passed
npm run build: passed
npm run format: passed
```
