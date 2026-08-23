# Parallel Task Sessions Release Validation

Date: 2026-08-22  
Branch: `feature/parallel-task-sessions`  
Validated code commit: `59441171fae9ee425923bca3ee78882ee58fe79f`

This is integration evidence only. The branch has not been pushed, merged to
`main`, tagged, or released.

## CI-equivalent gate

Command:

```bash
npm run verify:ci
```

Result: **passed**

- Formatting: passed.
- Main/preload/shared and renderer typechecks: passed.
- Unit/integration: 68 files passed; 540 tests passed; 2 todo.
- Production build: passed.
- Site/version validation: passed for source version 0.5.4.
- Standard Electron E2E: 56 passed; 6 authenticated real-Pi tests skipped by
  the standard suite as intended.

The standard E2E includes deterministic production-route coverage for:

- 12 planned task sessions with 10 active and queued excess;
- three retries after the initial attempt and terminal attempt-4 failure;
- one-prompt **Work in parent** override and reset;
- continued parent composition while private tasks run;
- parent synthesis containing successful and failed task handoffs;
- transient row clearing after synthesis;
- task-panel visibility across mode changes and no direct task controls;
- private tasks absent from sidebar and Work inbox;
- opaque image materialization, one-time token consumption, child delivery, and
  no token/base64 persistence while the task remains active;
- restart recovery to interrupted trace with no additional private worker
  prompt after reopen.

## Authenticated real-Pi gate

Command:

```bash
npm run test:e2e:real-smoke
```

Result: **passed — 6 of 6**

1. Real-Pi worker model discovery and retained per-prompt model selection.
2. Real Pi Agent Workflow persistence across restart.
3. Explicitly opted-in compatibility `deck_delegate` bridge transport.
4. Ordinary real-Pi parent confirms the legacy tool is absent by default.
5. Draft Parallel opt-in through the explicitly enabled real bridge harness.
6. Production model-backed Parallel routing without a harness marker or test
   routing fixture.

The production planner test required an ordinary prompt to become exactly three
private task sessions, observed all three terminal completions, verified the
parent synthesized ALPHA/BETA/GAMMA, verified task rows cleared after the parent
report, verified no private session appeared in navigation, and verified only
the parent JSONL session persisted.

The real-smoke file now throws when the authenticated gate is requested without
an installed Pi binary; a skipped run is not accepted as release evidence.

## Review findings closed

Final review fixes included:

- no raw parent-transcript fallback when planner generation fails;
- compatibility bridge cannot bypass the parent task limit or overlap product
  task plans;
- full persisted-state validation before restore;
- mode-off task visibility and failed task-prompt preservation;
- request-ordered worker-default updates;
- accessible worker-settings dialog focus and model-aware thinking choices;
- active-parent synthesis failure propagation before task-row clearing;
- bounded planner cancellation/capacity waiting and private `--no-session`
  cleanup;
- long task-name/brief containment at narrow widths;
- continuously ticking task clocks and payload-free major-step progress;
- semantic, safe, narrow-layout Markdown tables;
- immediate planner acknowledgement, duplicate-submit protection, and safe
  failed-planning draft restoration;
- DOM-safe per-prompt and persistent worker-model selection with an atomic
  model/thinking update that cannot restore stale defaults;
- model-visible legacy `deck_delegate` disabled by default, with authenticated
  real-Pi coverage of both opt-in registration and ordinary-session absence.

## Remaining release actions

- Review the complete integration diff against `main`.
- Configure/confirm the GitHub `Verify desktop app` required branch check after
  the eventual push.
- Decide the patch version and prepare release metadata only after approval.
- Do not push, tag, or publish from this validation document alone.
