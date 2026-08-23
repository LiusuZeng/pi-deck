# Release Checklist

A version tag is a release assertion, not merely a successful build. The release
owner records the command output and links the relevant CI run before creating a
tag. The final-candidate evidence template at the end of this document is only a
template; it becomes evidence only after its commands are run on the final HEAD.

## Required before every release

1. Confirm the target commit is on `main`, the worktree is clean, and required
   GitHub branch-protection checks are green.
2. Run `npm run verify:ci` on macOS. This includes formatting, typechecking,
   unit tests, build and site validation, and Electron fake-RPC E2E coverage.
3. Run `npm run test:e2e:real-smoke` with an authenticated real Pi setup. A
   skipped test is not release evidence; record why an exception was approved.
4. Review Playwright screenshots, traces, and the HTML report for any failed or
   retried test. Do not treat a DOM-only assertion as visual acceptance.
5. Update `CHANGELOG.md`, `package.json`, `package-lock.json`, and the release
   version in `site/index.html`; run `npm run check:site` after the update.
6. Confirm the v0.6 narrative describes All Work → scoped Work → session detail,
   keeps Work renderer-derived, and treats the persisted default workspace as an
   internal fallback rather than a removed entity.
7. Create a final-candidate validation record from the template below only after
   `npm run verify:ci` and `npm run test:e2e:real-smoke` have both run on the
   final candidate HEAD. Do not reuse historical integration or real-Pi records.
8. Commit the release preparation, create an annotated SemVer tag, push `main`
   and the tag, publish the GitHub Release, and confirm the Pages deployment.

## Parallel task-session acceptance criteria

The release owner must confirm the complete contract in
[`parallel-task-sessions-design.md`](parallel-task-sessions-design.md) in both
the fake E2E run and authenticated real-Pi smoke run:

- A new parent visibly presents **Parallel: Off** and **Work in parent**.
- Selecting **Parallel: On** visibly changes the default prompt destination to
  **New task session** and sets `aria-pressed`.
- The first default parallel prompt enters mandatory planning and creates one or
  more private task sessions through the production routing path without model
  tool election or a second approval.
- A clearly decomposable prompt produces multiple concurrent or queued task
  sessions automatically.
- **Work in parent** is a one-prompt override, after which the destination
  returns to **New task session**.
- The in-conversation task panel shows a flat, informational list with task
  brief, status, elapsed time, attempt count, and concise progress while the
  parent remains usable; it exposes no direct intervention.
- At 10 active task sessions, excess planned tasks queue automatically and do
  not fall back to the parent.
- Worker settings follow per-prompt override, persistent parallel default, then
  parent model/thinking settings; task context is summarized rather than copied
  as a full parent transcript.
- Failures retry up to three times after the initial attempt. The parent then
  synthesizes and reports results and clears the associated task rows.
- Private sessions, transcripts, and raw output remain inaccessible.
- Reopening a saved parent never resumes unfinished task sessions; it preserves
  enough plan/context trace to mark them interrupted and let the user decide
  what to do next.
- Workspace archive is denied when a workspace contains a parent with a pending
  Parallel planning submission or a nonterminal private task in `queued`,
  `starting`, `running`, `retrying`, or `waiting-parent`. The parent may be
  idle; closing it cancels children silently. The archive dialog explains the
  blocking reason, and the archive action rechecks eligibility.

A harness that invokes `deck_delegate` directly validates the bridge only. It
is not sufficient release evidence for deterministic prompt routing.

## Enforcement

The `Verify desktop app` GitHub Actions check from `.github/workflows/ci.yml`
must be required by branch protection for `main`. The authenticated real-Pi
smoke remains a release-only gate because it needs local provider credentials;
its command output is mandatory release evidence. The historical integration
record is [`reviews/parallel-task-sessions-release-validation.md`](reviews/parallel-task-sessions-release-validation.md); it is context only, is not v0.6 final-candidate evidence, and does not authorize a push or release by itself.

## Final-candidate evidence template

> Template only. Do not treat this section as a validation record or fill in
> results until the commands have run on the final candidate HEAD.

````md
# v0.6 RC Final-Candidate Validation

Date:
Candidate commit SHA (paste the output of `git rev-parse HEAD`):
Branch:
Working tree before validation (paste `git status --short` output):
Node/npm:
macOS:
Pi version and authenticated configuration: record with secrets redacted

## CI-equivalent gate

Command actually run:

```bash
npm run verify:ci
```

Result:
Verbatim stdout/stderr or immutable log artifact URL/hash:

## Authenticated real-Pi gate

Command actually run:

```bash
npm run test:e2e:real-smoke
```

Result:
Verbatim stdout/stderr or immutable log artifact URL/hash:
Artifacts, screenshots, traces, or report:
Exceptions approved: none / describe explicitly

## Candidate-specific task-session checks

- Production routing used instead of direct `deck_delegate`:
- Private task sessions absent from the sidebar, All Work, and scoped Work:
- Workspace archive blocked for pending planning and each nonterminal state
  (`queued`, `starting`, `running`, `retrying`, `waiting-parent`):
- Archive dialog named the blocker and archive action rechecked eligibility:
````
