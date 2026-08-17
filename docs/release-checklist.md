# Release Checklist

A version tag is a release assertion, not merely a successful build. The release
owner records the command output and links the relevant CI run before creating a
tag.

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
6. Commit the release preparation, create an annotated SemVer tag, push `main`
   and the tag, publish the GitHub Release, and confirm the Pages deployment.

## Parallel multitasking acceptance criteria

The release owner must confirm all of the following in both the fake E2E run and
the authenticated real-Pi smoke run:

- A new draft visibly presents an enabled **Parallel: Off** control.
- Hover and keyboard focus explain what the control does, and the tooltip is
  visually anchored to that control.
- Selecting it visibly changes the state to **Parallel: On** and sets
  `aria-pressed`.
- The first prompt after opt-in can create a delegated child task.
- The parent conversation displays queued/running/completed task status while
  child sessions, controls, prompts, and output remain private.
- Sequential mode and an explicit direct-handling request do not delegate.
- Reopening a saved parent preserves its selected mode and task status.

## Enforcement

The `Verify desktop app` GitHub Actions check from `.github/workflows/ci.yml`
must be required by branch protection for `main`. The authenticated real-Pi
smoke remains a release-only gate because it needs local provider credentials;
its command output is mandatory release evidence.
