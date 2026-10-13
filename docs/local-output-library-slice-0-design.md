# Local Output Library — manual text-deliverables MVP

Status: customer-usable manual Outputs MVP plus the durable storage foundation for #141; not the complete automatic Local Output Library.

This document records the safety boundary exercised by `src/main/outputs/` and the first complete customer loop. A user can save a completed visible parent-assistant response, find it later by title or body text, review an immutable revision, and open a new session with that exact revision and its feedback prepared for revision. The resulting completed response can be saved as the next revision of the same output.

The renderer never supplies a source path. Electron main re-reads the attached parent transcript, requires an exact assistant-text/message match, and publishes main-owned text. Read, review, reveal, and revision operations are authorized against active workspace ownership and opaque IDs.

This MVP deliberately does **not** expose automatic/required output policy, a Pi publication tool, arbitrary or multi-file agent deliverables, rich previews, workflow publication, or private Parallel-child publication. It is a manual text-deliverables MVP, not automatic output management or the complete #141 release.

## Customer contract

- **Produce:** Save a completed parent assistant response as a named text output without another model call. A stable request ID makes retry idempotent.
- **Find:** Browse the current workspace or all active workspaces and perform bounded, case-insensitive all-term search over verified current titles and body text.
- **Review:** Add notes or mark an exact revision Accepted, Changes requested, or Unreviewed. Decisions never silently carry to a new revision.
- **Revise:** Start an owner-workspace draft containing the selected immutable revision and its recorded feedback. The draft visibly identifies the revision target. Saving the completed response uses expected-head fencing to create the next immutable revision or report a conflict.
- **Inspect:** Open every intact revision independently and reveal its managed package in the OS file browser.
- **Recover:** Rebuild list/detail state from package metadata after restart. The source chat is not required. Missing or hash-mismatched content is blocked from display, review, search, and reuse.

## Storage contract

- `output.json`, `revision.json`, `reviews.json`, and `.staging/<attempt>/attempt.json` have strict version-1 schemas. IDs are UUIDs allocated by the host store; title, paths, hashes, display number, and ownership are not accepted as agent authority.
- An attempt is bound to a workspace and safe parent source descriptor (`normal-parent` or `parallel-parent`, plus opaque runtime ID). There is no child-session descriptor or transcript/prompt field in durable metadata.
- A new publication copies declared regular files into private staging, builds a complete output package, and renames that package into `outputs/<id>`. It cannot expose a half-built package as current.
- For a later revision, the immutable revision directory is installed before `output.json` advances its pointer. Publication fences on workspace and expected head. A loser remains staged with `conflict` state rather than replacing newer work.
- Replaying a saved attempt returns its original receipt. `recoverAttempt()` derives a committed receipt from a revision's durable `publicationAttemptId` when acknowledgement was interrupted.
- Review events are user-authored, append-only records tied to `outputId + revisionId`. Main verifies revision integrity before accepting a review mutation.
- Rebuild reports malformed or damaged packages without deleting, resetting, or repairing them. Per-revision manifests are checked against private anchors outside the revealed package, then file hashes/sizes are verified before display, search, review, reveal, or revision reuse.
- File bytes and metadata are synced before commit renames; containing directories are synced after atomic pointer/package installation on the supported macOS target.
- A durable first-use marker distinguishes a new library from an initialized library whose root disappeared. Missing storage remains visibly unavailable instead of silently becoming an empty replacement.

## Security and durability boundary

The implementation uses a process-wide publication lock, 100 MiB-per-file / 250 MiB-per-revision store limits, a 2 MiB text-output limit, and a trusted-private-root policy. Managed path components are revalidated, symlinks and group/other-writable roots are rejected, and final file opens use `O_NOFOLLOW` where available.

This is not an OS sandbox or a defense against a malicious process running as the library owner, which could modify both packages and their local anchors. Integrity checks protect against missing files and ordinary/coherent edits to a revealed package. Descriptor-relative traversal should replace pathname validation where the supported platform/runtime permits. Interrupted staging has no dedicated reconciliation UI yet.

The manual-save bridge resolves only an attached normal parent runtime and exact visible assistant text. Automatic publication requires a separately capability-authenticated managed-parent bridge. Private Parallel children must remain unable to publish or query the library.

## Deterministic evidence

- `outputLibraryStore.test.ts` covers atomic visibility, idempotent replay/recovery, expected-head conflict retention, rebuild/integrity behavior, limits, and path/symlink rejection.
- `savedAnswerService.test.ts` covers restart persistence, workspace scope, body search, per-revision review state, immutable revision history, stale-head conflict, mutation blocking, retry idempotency, and missing-root behavior.
- `savedAnswerSelection.test.ts` covers main-owned completed-transcript selection.
- Shared-schema and preload tests cover strict, pathless renderer contracts.
- `e2e/saved-answers.e2e.ts` exercises authorization rejection, manual save, review, new-session revision context, next-revision save, body search after restart, old-revision review history, and tamper hiding.

## Remaining #141 work

The complete #141 release still requires managed Pi capability/version detection; Automatic/Require output/Chat-only policy; authenticated normal and Parallel-parent publication across restart; arbitrary multi-file packages and previews; a durable search index for larger libraries; lifecycle actions such as rename/archive/Trash/import; explicit staged-conflict recovery UI; workflow publication; and broader crash fixtures at every filesystem boundary.
