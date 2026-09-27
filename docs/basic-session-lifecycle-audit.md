# Basic session lifecycle audit

Code findings were audited at `e1bcc72`; the E2E additions are in [PR #154](https://github.com/LiusuZeng/pi-deck/pull/154). This audit traces normal desktop lifecycle and persistence, not authenticated provider behavior. Independent read-only reviews covered main-process lifecycle, persistence/recovery, and renderer/navigation; separate worktrees supplied the E2E additions.

## What currently happens

| Action | Runtime behavior | Persistence / recovery |
| --- | --- | --- |
| Close the last window, including on macOS | Quits the app; does **not** keep sessions running in the background. No active-work confirmation. | Already-written Pi JSONL history and app metadata remain. |
| Quit / Cmd+Q | Asynchronous cleanup requests direct RPC worker termination, waits for exit, and escalates SIGTERM to SIGKILL after the grace period. | Normal shutdown also retires private tasks and workflow runtimes. Repeated quit has a separate barrier defect (#148). |
| Relaunch after normal quit | Ordinary chats start as saved, unattached sessions; reopening starts a new worker on the existing session file. | Named active workspace, membership, titles, and written transcript survive in real mode. Not a checkpoint/resume of the interrupted computation. |
| Quit during an ordinary turn | Stops execution. | A persisted user message survives; incomplete assistant output may not. A fresh turn can be sent after reopening. No guarantee of automatically retrying the interrupted request. |
| Renderer reload | Main-process workers remain alive. | Existing runtime identity should remain accessible without a duplicate worker. Renderer-only drafts/selection are reconstructed, not restored. |
| Renderer crash | No explicit recovery handler. Main-process work can remain running behind a crashed window. | Needs a recovery/fallback policy (#151). |
| Main-process crash / forced termination | Normal quit hooks cannot be relied upon. | Cannot reconnect to the previous RPC process. Only durable session data can be reopened; orphan-process recovery remains a limitation. |
| Workspace switch | Changes the view; does not inherently terminate work in the previous workspace. | In-renderer drafts and attached runtimes are retained. |
| Workflow interruption | Scheduler shutdown/recovery persists interrupted/failed active occurrences rather than live-process snapshots. | Definitions/runs are durable; rehydration and retry semantics are separate from ordinary chat resume. |

### Where data lives

- Pi owns conversation JSONL files in its resolved session directory.
- `~/.pideck/workspaces.json` and `projects.json` retain organization, cached summaries, and title overrides, not a second authoritative transcript.
- `~/.pideck/workflows.json` retains workflow definitions and occurrence runs.
- Electron user-data holds settings, diagnostics, and bounded task-session recovery metadata. Unfinished private task runtimes are not resumed as live children after restart.
- Unsent composer text, selected attachment authority, and UI selection are not a durable draft store. Do not confuse persisted **sent** messages/images with unsent drafts.

Workspace/project/workflow stores use serialized persistence and temporary-file replacement. Settings currently overwrite the live file directly (#153). Atomic replacement is not a claim of fsync/power-loss durability.

## Findings filed

| Issue | Finding | Evidence level |
| --- | --- | --- |
| [#148](https://github.com/LiusuZeng/pi-deck/issues/148) | Repeated quit can bypass pending worker cleanup. | CI reproduced a live worker PID at final `will-quit`; `main.ts` sets the quit-bypass flag before cleanup completes. |
| [#149](https://github.com/LiusuZeng/pi-deck/issues/149) | Unsent drafts disappear on reload/restart. | React-only draft state and fresh bootstrap path; no durable storage or discard guard. |
| [#150](https://github.com/LiusuZeng/pi-deck/issues/150) | Last-window close silently stops active work. | Explicit close-last-window policy; shutdown E2E. UX/product-policy gap, not an accidental background-execution bug. |
| [#151](https://github.com/LiusuZeng/pi-deck/issues/151) | Renderer crash has no app-owned recovery path. | No `render-process-gone` handling. Crash/recovery E2E remains follow-up. |
| [#152](https://github.com/LiusuZeng/pi-deck/issues/152) | Fake/demo startup resets the saved active workspace. | CI reproduced default activation with the named workspace still persisted. Real mode is separately covered. |
| [#153](https://github.com/LiusuZeng/pi-deck/issues/153) | Interrupted settings writes can lose last-good preferences. | Direct overwrite plus corrupt-file fallback. Needs deterministic partial-write fault injection, not a timing-based kill test. |

Existing model-discovery subprocess ownership issue #144 is not duplicated.

### Important boundary: descendants

`PiWorker.closeAndWait()` proves the **direct** RPC child has exited. It does not signal a process group or enumerate tool/subagent descendants. A pure Node reproduction confirms killing a parent alone can leave a grandchild alive; that is not proof that real Pi's own SIGTERM handlers leak tools. Real-Pi descendant cleanup remains an explicit validation gap, not a claimed verified production defect.

## Added deterministic E2E coverage

`e2e/app-window-lifecycle.e2e.ts`:

1. Actual last `BrowserWindow.close()` during active work: direct workers are dead at `will-quit`.
2. `app.quit()` with a SIGTERM-ignoring worker: escalation occurs before Electron exits.
3. Repeated quit: desired shared shutdown barrier, linked expected failure for #148.
4. Renderer reload during a turn: same runtime/file, no duplicate session worker, and visible abort controls remain usable. Temporary `--no-session` model-discovery workers are tracked separately from session ownership.

`e2e/app-restart-persistence.e2e.ts`:

1. Completed chat in a named workspace: durable transcript/title/membership, real-mode active workspace, unattached restart, same-file resume and subsequent turn.
2. Fake-mode selected workspace survives restart: linked expected failure for #152.
3. Interrupted ordinary turn: durable user input survives, no automatic runtime resurrection, same-file resume and subsequent turn.

Known-failure annotations occur only immediately before the specific broken invariant is asserted. Setup/transport failures still fail CI. Fixing either issue requires removing its expected-failure annotation; unexpected passes are not silently accepted.

### Isolation and validation

Both suites force `PI_DECK_E2E_HIDE_WINDOWS=1` regardless of inherited headed settings and assert native windows are invisible. Electron still needs its platform GUI service; these are hidden-window tests, not a claim that Electron supports Chromium's browser-headless mode. They neither open an inspector nor allocate an interactive terminal. Remaining E2E execution is in GitHub CI, not the user's desktop.

Fixtures use isolated home/user-data/agent/project paths, a credential-free fake CLI behind the real adapter, and known-worker PID cleanup. Restart tests reuse the same isolated directories and never overwrite settings on the second launch. The wrapper answers version/model-list requests immediately and keeps temporary runtime discovery free of session-specific shutdown delays. Activity assertions use normalized `chat.getRuntimeStatus()`, not the optional `isAgentActive` field of raw Pi snapshots (which can report `isStreaming` instead).

The suites are automatically picked up by `npm run test:e2e`, already part of `npm run verify:ci`. The authoritative acceptance gate is **Verify desktop app** on the PR's current commit; provider-authenticated smoke tests remain release-only. Workflow quit/crash parity, renderer-crash recovery, durable draft recovery, and real tool-descendant cleanup are not covered by these new cases.
