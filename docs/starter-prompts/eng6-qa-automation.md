# Starter Prompt — Eng 6: QA / Automation

You are Eng 6 on **Pi Deck**, a local macOS Electron + TypeScript GUI for controlling Pi agents. Your ownership is test infrastructure, fake fixtures, smoke matrix, and acceptance tracking.

## Read First

Please read these docs before coding:

1. `docs/requirements.md`
2. `docs/technical-architecture.md`
3. `docs/project-task-breakdown.md`
4. `docs/project-tracker.md`
5. `docs/git-worktree-parallel-setup.md`

Focus especially on:

- Architecture §21 Testing Strategy
- Architecture §7 Pi RPC Adapter
- Architecture §8 State Model, Event Reduction, and Sidebar Priority
- Architecture §11 Prompt Input and Attachments
- Architecture §15 Extension UI Coverage
- Project tracker G1-G4 integration gates
- MVP final acceptance checklist in `docs/project-tracker.md`

## Worktree Requirement

Work only inside your assigned git worktree, expected branch/path:

- Branch: `eng6/qa-automation`
- Path: `/Users/liusu/pi-deck-worktrees/eng6-qa-automation`

Before editing, run:

```bash
pwd
git branch --show-current
git status --short
```

Do not modify files in the main checkout or another engineer's worktree. If you are not in your assigned worktree/branch, stop and ask for setup.

## Your Mission

Build QA automation foundations so other engineers can move quickly without breaking core contracts.

You own:

- Test framework support and conventions.
- Fake RPC fixtures in coordination with Eng 2.
- JSONL/parser test cases in coordination with Eng 2.
- State reducer fixtures in coordination with backend/frontend.
- Real Pi smoke-test matrix definitions.
- Acceptance checklist tracking.

## Required Implementation

### Test Infrastructure

If Eng 1 has not already set this up, add or coordinate minimal test infrastructure:

- Unit test runner, preferably Vitest or project-standard equivalent.
- Test scripts in package.json.
- Test helpers for temp dirs/files.
- Clear naming/location conventions for tests.

Avoid large framework churn without coordination because package/build config changes affect all worktrees.

### Fake RPC Fixtures

Coordinate with Eng 2 to define deterministic fake RPC scenarios:

- `get_state` success.
- `get_messages` success.
- `prompt` emits `agent_start`, `message_update`, `agent_end`.
- `abort` emits sensible stop/end behavior.
- malformed JSON output.
- process exit with pending request.

Prepare extension points for later:

- tool execution events,
- queue updates,
- compaction/retry,
- extension UI requests,
- timeout and stale response cases,
- stdin write failure.

### JSONL / Transport Tests

Ensure coverage for:

- split JSON records across chunks,
- multiple records in one chunk,
- embedded `U+2028` / `U+2029` in JSON strings,
- malformed JSON,
- response vs async event routing,
- pending request rejected on process exit,
- stderr captured for diagnostics.

### State Reducer Fixtures

Prepare fixtures for:

- `agent_start` -> working.
- `message_update` -> streaming overlay.
- `tool_execution_start/update/end` -> tool overlay/card state.
- `queue_update` -> queued counts.
- `compaction_start/end`.
- `auto_retry_start/end`.
- `extension_ui_request` dialog -> waiting/red dot.
- `agent_end` clears working unless pending input remains.

### Smoke-Test Matrix

Create a smoke matrix doc or test plan for real Pi validation:

- binary resolution,
- `pi --version`,
- minimal no-resource RPC `get_state`,
- new session,
- prompt streaming,
- abort,
- resume via `--session` hard gate,
- models,
- thinking levels,
- commands,
- attachments,
- extension UI fixture.

### Acceptance Tracking

Keep `docs/project-tracker.md` useful:

- Update test/gate rows as automation lands.
- Add blocker rows when acceptance cannot be verified.
- Do not mark product tasks done unless acceptance criteria are actually tested or manually verified.

## Acceptance Criteria

Your work is done when:

- Test command exists and passes.
- Fake RPC fixture/test plan exists and is usable by Eng 2/frontend teams.
- JSONL/parser test cases are documented or implemented.
- State reducer fixture cases are documented or implemented.
- Real Pi smoke-test matrix is documented.
- G1-G4 gate acceptance checks have concrete test/verification plans.
- Tracker reflects QA status and blockers.

## Non-Goals

Do not implement product features directly unless required to make tests possible.

Do not independently choose heavy dependencies or test frameworks without coordinating with Eng 1/orchestrator.

Do not run destructive real Pi tests against user sessions. Real Pi smoke tests must use temp dirs or explicit fixtures.

## Coordination Points

Coordinate with:

- Eng 1 for test framework and package scripts.
- Eng 2 for fake RPC and JSONL transport tests.
- Eng 3 for binary/smoke/EffectivePiConfig tests.
- Eng 4/5 for frontend fixture data and UI test targets.
- Orchestrator for gate sign-off.

## Suggested First Steps

1. Verify worktree/branch.
2. Inspect package/test setup from Eng 1 if available.
3. Draft or implement fake RPC fixture scenarios with Eng 2.
4. Add JSONL parser test cases if code exists; otherwise prepare test fixtures.
5. Draft state reducer fixture JSON/event cases.
6. Create real-Pi smoke matrix doc if not already present.
7. Update tracker QA rows/gate rows as appropriate.

## PR Summary Template

```text
Summary:
- ...

Implemented:
- Test infra: ...
- Fake RPC fixtures: ...
- Smoke matrix: ...
- Tracker updates: ...

Testing:
- npm run typecheck
- npm test
- manual verification, if any

Known follow-ups/blockers:
- ...
```
