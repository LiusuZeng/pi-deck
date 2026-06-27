# Starter Prompt — Eng 2: RPC / Backend Integration

You are Eng 2 on **Pi Deck**, a local macOS Electron + TypeScript GUI for controlling Pi agents. Your ownership is the Pi RPC integration foundation.

## Read First

Please read these docs before coding:

1. `docs/requirements.md`
2. `docs/technical-architecture.md`
3. `docs/project-task-breakdown.md`
4. `docs/project-tracker.md`
5. `docs/git-worktree-parallel-setup.md`

Focus especially on:

- Architecture §2 High-Level Architecture
- Architecture §4 Process, Session Ownership, and Locking
- Architecture §7 Pi RPC Adapter
- Architecture §8 State Model, Event Reduction, and Sidebar Priority
- Architecture §19 Diagnostics and Log Retention
- Architecture §20 Error Handling and Recovery
- Architecture §21 Testing Strategy
- Milestone tasks M2.1, M2.2, M2.3 in `docs/project-task-breakdown.md`
- Tracker rows M2.1, M2.2, M2.3 in `docs/project-tracker.md`

## Worktree Requirement

Work only inside your assigned git worktree, expected branch/path:

- Branch: `eng2/rpc-backend`
- Path: `/Users/liusu/pi-deck-worktrees/eng2-rpc-backend`

Before editing, run:

```bash
pwd
git branch --show-current
git status --short
```

Do not modify files in the main checkout or another engineer's worktree. If you are not in your assigned worktree/branch, stop and ask for setup.

## Your Mission

Implement the backend/RPC foundation for Pi Deck.

You own:

- **M2.1** Strict JSONL transport
- **M2.2** Fake RPC subprocess/test harness
- **M2.3** Single PiWorker lifecycle

Coordinate closely with Eng 1 on IPC/settings structure and Eng 3 on Pi binary resolution / smoke test. If Eng 1 has not finished the Electron scaffold yet, implement your code in isolated backend/shared modules that can be wired into Electron main later.

## Product Context

Pi Deck talks to Pi through `pi --mode rpc` subprocesses. The GUI must not use Pi TUI and must not reimplement Pi internals. The backend must provide a clean adapter boundary so the renderer never depends on JSONL/protocol details.

## Required Implementation

### M2.1 — Strict JSONL Transport

Implement a reusable JSONL RPC client for a child process with stdin/stdout/stderr.

Requirements:

- Parse strict LF-delimited JSONL.
- Do **not** use Node `readline`; it can split on Unicode separators that are valid inside JSON strings.
- Correctly handle:
  - chunk boundaries in the middle of JSON records,
  - multiple records in one chunk,
  - embedded `U+2028` / `U+2029` inside JSON strings,
  - malformed JSON records.
- Maintain request map keyed by command `id`.
- Treat `type: "response"` as command responses.
- Treat all other records as async events.
- Capture stderr into diagnostics/log buffer.
- Add timeouts only for command acceptance/response, not for long-running agent work after prompt acceptance.

Suggested modules:

```text
src/main/pi/jsonlClient.ts
src/main/pi/piWorker.ts
src/main/pi/piAdapter.ts
src/main/pi/types.ts
src/main/pi/fakeRpc/
```

Adjust paths to match Eng 1 scaffold if needed.

### M2.2 — Fake RPC Subprocess / Test Harness

Build a deterministic fake RPC process or test harness.

It should support at least:

- `get_state`
- `get_messages`
- `prompt`
- `abort`

It should be able to emit async events like:

- `agent_start`
- `message_update`
- `agent_end`
- simple error event / malformed output fixture

The goal is to let backend and frontend integration tests run without a real installed Pi binary.

Fake RPC should be easy to extend later for:

- tool execution events,
- queue updates,
- compaction/retry,
- extension UI requests,
- stdin write failure / process exit cases.

### M2.3 — Single PiWorker Lifecycle

Implement a single-session worker wrapper around `pi --mode rpc`.

For now, support only one newly started worker in a selected cwd. Resume/session listing are M3 and should not be implemented here except for clean extension points.

Required methods, aligned with `PiAdapter`:

```ts
getState(runtimeId: string): Promise<PiState>;
getMessages(runtimeId: string): Promise<PiMessage[]>;
prompt(runtimeId: string, input: PromptInput): Promise<void>;
abort(runtimeId: string): Promise<void>;
closeSession(runtimeId: string): Promise<void>;
onEvent(listener: (event: RuntimeEvent) => void): Unsubscribe;
```

If the exact shared interface does not exist yet, create a minimal one and mark it for G0 contract review.

Worker lifecycle requirements:

- Spawn process with configured binary/cwd/env provided by caller.
- Track PID, runtime id, session state basics, stderr diagnostics, exit code/signal.
- On unexpected process exit:
  - mark worker unhealthy,
  - reject pending requests,
  - emit diagnostic/error event.
- On close:
  - attempt graceful termination,
  - avoid orphaning process where practical.

Do **not** implement yet:

- multiple workers,
- session locks,
- resume via `--session`,
- scheduler/concurrency cap,
- model/thinking/slash command methods beyond stubs if needed.

## Acceptance Criteria

Your work is done when:

### M2.1 Acceptance

- JSONL parser has unit tests covering:
  - split records across chunks,
  - multiple records in one chunk,
  - embedded `U+2028` / `U+2029`,
  - malformed JSON,
  - response vs async event routing.
- Request correlation by id works.
- Pending requests are rejected on process exit.
- stderr is captured for diagnostics.

### M2.2 Acceptance

- Fake RPC can be launched by tests or dev tooling.
- Fake RPC returns deterministic `get_state` and `get_messages` responses.
- Fake RPC accepts `prompt` and emits basic streaming events.
- Fake RPC accepts `abort` and emits a sensible stop/end state.
- Fake RPC is documented enough for frontend/dev usage.

### M2.3 Acceptance

- A single real or fake PiWorker can be created in a cwd.
- `get_state`, `get_messages`, `prompt`, and `abort` methods work against fake RPC.
- Real Pi path is injectable but actual binary resolution is owned by Eng 3.
- Worker stderr/exit diagnostics are observable.
- No renderer-facing security boundary is bypassed.

## Testing Requirements

Add automated tests for:

- JSONL framing.
- Request/response matching.
- Async event delivery.
- Worker exit with pending requests.
- Fake RPC prompt streaming.
- Abort path.

If the repo test framework is not yet set up, coordinate with Eng 1. If blocked, add a minimal test setup rather than leaving behavior untested.

## Non-Goals

Do not implement yet:

- Pi binary resolution / Finder PATH lookup. That is Eng 3.
- Minimal smoke test. That is Eng 3, though it will use your JSONL client.
- Project picker.
- Session scanning.
- Resume via `--session`.
- Multiple concurrent workers.
- Scheduler/concurrency cap.
- Attachments/images.
- Model/thinking/slash command UI.
- Extension UI rendering.

## Coordination Points

Coordinate with:

- **Eng 1** for Electron main/preload folder structure, IPC patterns, settings/log directories.
- **Eng 3** for binary path/env injection and minimal smoke test use of JSONL transport.
- **Frontend engineers** for fake event fixtures needed by chat timeline.
- **Orchestrator/tech lead** before changing shared `PiAdapter`/event schema.

## Suggested First Steps

1. Inspect current repo structure and Eng 1 scaffold if present.
2. Create or align shared RPC/types module.
3. Implement low-level JSONL parser independent of child process.
4. Unit-test parser thoroughly.
5. Implement request/response client wrapper.
6. Implement fake RPC process/harness.
7. Implement `PiWorker` using injectable command/path/env/cwd.
8. Add integration tests against fake RPC.
9. Update `docs/project-tracker.md` statuses for M2.1-M2.3 if your workflow includes doc updates.

## PR Summary Template

When submitting, include:

```text
Summary:
- ...

Implemented:
- M2.1 ...
- M2.2 ...
- M2.3 ...

RPC notes:
- JSONL framing approach: ...
- Request correlation: ...
- Event routing: ...
- Process exit behavior: ...

Testing:
- npm run typecheck
- npm test
- fake RPC integration test command

Known follow-ups:
- ...
```
