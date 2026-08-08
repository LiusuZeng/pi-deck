# Agent Workflows — Product Feedback and Continuation Notes

**Status:** prompt-first v1 simplification integrated, validated, and pushed<br>
**Feedback captured:** 2026-08-07<br>
**Continuation branch:** `dev/agent-workflows-prompt-first`

This is the working product-feedback log for Agent Workflows. Keep new UX findings,
implementation decisions, and validation notes here so the work can continue from
another laptop without relying on chat history.

## Latest product direction

The first version should feel like a prompt editor, not a workflow programming
language.

- A workflow step is primarily **one prompt/instructions field**.
- Shared context is **one shared prompt plus “Don’t do”**.
- Do not expose separate Objective, Constraints, Relevant paths, Standards, or
  explicit file/link/path inputs in the first version.
- Handoffs should be implicit. Agents work in the same local workspace and should
  discover/read local files as needed; do not make users compose structured
  previous-result handoff chips.
- Keep the workflow/skills distinction: workflows coordinate; skills remain
  Pi-native agent capabilities.
- Model override and thinking level should use dropdown choices matching the
  normal Pi Deck session prompt controls, not free-form text fields.
- Keep first-version run inputs prompt/text-only. Defer file, URL, and link input
  types.
- Clicking **Start run** on a workflow with no inputs should launch immediately.
  Only workflows with actual inputs need a setup form before launch.

## Feedback tracker

- [x] Simplify the shared-context editor to Prompt + Don’t do.
- [x] Simplify each agent step to Instructions; remove structured handoff UI.
- [x] Make model and thinking overrides dropdowns using session-style choices.
- [x] Limit new run inputs to text/prompt values; defer path/file/link UX.
- [x] Avoid the empty second “Start workflow” screen for no-input workflows.
- [x] Recheck copy, spacing, and mobile layout after the simplification.
- [x] Add/update renderer and backend compatibility tests.
- [x] Push the continuation branch and isolated implementation branches; run final validation.

## Captured screenshots

These are copies of the screenshots supplied during feedback, stored in Git so
future workstations can inspect the original UI context:

1. [Shared context](assets/agent-workflows-feedback/shared-context.png)
2. [Empty reusable inputs](assets/agent-workflows-feedback/run-inputs-empty.png)
3. [Agent step editor](assets/agent-workflows-feedback/agent-step-editor.png)
4. [Workflow home](assets/agent-workflows-feedback/workflow-home.png)
5. [Run start form](assets/agent-workflows-feedback/run-start-form.png)

## Compatibility policy

Existing workflow JSON may contain the richer pre-feedback fields and handoff
parts. The first-version editor should stop creating new instances of those
concepts without making old saved templates unreadable. Backend parsing/rendering
should keep a safe compatibility fallback while the new UI writes the simpler
shape.

## Current implementation context

The feature is centered in:

- `src/shared/workflowSchemas.ts` — template/run contracts and validation.
- `src/main/workflows/workflowStore.ts` — persisted templates and runs.
- `src/main/workflows/workflowEngine.ts` — graph execution and state changes.
- `src/main/workflows/workflowScheduler.ts` — Pi worker scheduling/capacity.
- `src/main/workflows/workflowPromptRenderer.ts` — prompt/context rendering.
- `src/main/workflows/workflowRehydration.ts` — startup/workspace recovery.
- `src/main/main.ts` — workflow IPC/runtime integration and path authorization.
- `src/preload/index.ts` — validated renderer bridge.
- `src/renderer/App.tsx` — workflow view state and session integration.
- `src/renderer/components/workflows/` — home, builder, step, transition, and run UI.

Related design/implementation documents:

- `docs/agent-workflows-design.md`
- `docs/agent-workflows-design.html`
- `docs/agent-workflows-parallel-implementation-plan.md`

The underlying orchestration implementation already includes persistent global or
workspace-scoped templates, normal Pi sessions per step, transitions/conditions,
manual gates, retries/overrides, capacity handling, transcript/runtime recovery,
workspace/path guards, and stop-race protection. This feedback pass is a UX
simplification, not a request to remove those runtime safety guarantees.

## Resume on another laptop

```bash
git clone https://github.com/LiusuZeng/pi-deck.git
cd pi-deck
git fetch origin
git switch --track origin/dev/agent-workflows-prompt-first
npm ci
npm run typecheck
npm test
npm run deck:fake:build
```

The fake launch is the safest first demo and does not require Pi provider
credentials. For real local Pi:

```bash
npm run deck:real:build -- /absolute/path/to/project
```

Requirements are macOS, Node.js 22.12+, npm, and a working authenticated `pi`
installation for real mode.

## Validation record

Before this feedback pass, the integrated workflow feature had passed:

- 363 unit/renderer tests, with 2 intentional TODOs.
- Main and renderer TypeScript checks.
- Production main/preload/renderer build.
- Prettier format check.
- Full Playwright E2E: 35 passed, 3 environment-skipped.
- Independent backend and UI blocker-only reviews.

Prompt-first implementation commits currently include:

- `674e289` — App model/thinking choice derivation and workflow-editor props.
- `011a8cf` — Prompt-first context schema/rendering compatibility.
- `19299a8` — Prompt-first renderer editor and run-flow UX.
- `ac05e11` — Parent integration fixes for choice types and compatibility fields.

The continuation branch is pushed at:
`origin/dev/agent-workflows-prompt-first`

The isolated implementation branches are also pushed for review/recovery:

- `origin/aw/v1-ux`
- `origin/aw/v1-contracts`
- `origin/aw/v1-app`

Final validation after integration: 372 tests passed, 2 intentional TODOs;
typecheck, build, format, and diff checks passed. Full Playwright E2E passed 35
with 3 environment-skipped. Backend compatibility review approved; the final
UX blocker about the shared prompt label was fixed and pushed in `3d6e024`.
Do not push unrelated site/screenshot work; that work remains isolated in the
local `pi-deck-site-capture` worktree.
