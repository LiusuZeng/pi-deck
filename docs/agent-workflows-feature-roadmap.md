# Agent Workflows — Feature Roadmap

**Status:** Product proposal for discussion; not an approved implementation plan or release commitment.
**Relationship to earlier proposal:** The [issue-delivery roadmap](agent-workflows-issue-delivery-roadmap.md) is a possible validation scenario. It is not the roadmap for the whole feature. This document supplies that broader product direction.

## 1. Product thesis

Agent Workflows should let users turn a way of working into a repeatable, inspectable, improvable procedure.

> Define the process once. Supply a new task each time. Deck coordinates execution and handoffs, preserves evidence, and asks for human judgment at the right points.

Examples include delivering an issue, investigating a defect, reviewing an existing PR, producing a research report, or periodically comparing a set of sources. GitHub is one integration, not the workflow model.

Three concepts should remain distinct:

- **Session:** an open-ended conversation with an agent.
- **Parallel/delegation:** a way to distribute work within a task.
- **Workflow:** an explicit reusable procedure with inputs, stages, policies, decisions, and a recorded outcome.

A workflow need not contain many agents. Its value is a dependable process, not agent count or graph complexity. Preserve the current Worker, Decider, Orchestrator, and Human roles; planner/reviewer/tester are configured uses, not additional roles.

## 2. Current position

The engine already has canonical definitions, run snapshots, occurrences, loops, fan-out, human checkpoints, retries, recovery, and explicit Worker-text bindings. Build/Graph/JSON editing and session drill-in also exist.

The feature is weakest at the product lifecycle around that engine:

1. **Starting:** no outcome-oriented starter catalog; basic workflow input authoring still requires JSON.
2. **Defining a dependable process:** prompts and text handoffs carry responsibilities that should have explicit contracts.
3. **Running real work:** external actions, waits, execution locations, and resource ownership are not first-class workflow capabilities.
4. **Intervening:** yes/no gates and retry are not a complete review, feedback, revision, and recovery experience.
5. **Improving and reusing:** immutable snapshots exist, but a user-facing publish/version/compare/distribute lifecycle is not established.

The roadmap should address these gaps rather than rebuild existing orchestration primitives.

## 3. The desired lifecycle

```text
Choose or create a procedure
  → Configure inputs, stages, responsibilities, and policies
  → Validate and publish a reusable version
  → Start a run with a new task
  → Observe progress and inspect evidence
  → Approve, provide feedback, or recover when needed
  → Review the result
  → Improve the definition for future runs
```

A successful product supports this whole lifecycle. A powerful graph editor with fragile runs is incomplete; so is a robust runtime whose users must hand-edit JSON for ordinary work.

## 4. Roadmap milestones

These are capability milestones, not release dates. Scope releases after the safety-critical contracts have been demonstrated. Each milestone should ship a usable end-to-end improvement.

### Milestone 1 — Reusable procedures ordinary users can configure

**User promise:** “I can create a process once and run it for different tasks without rewriting prompts or editing JSON.”

#### Product capabilities

- A workflow library with owned definitions, descriptions, tags, and **Use starter / Duplicate / Import / Export** actions.
- A small built-in starter set spanning more than coding: investigate a problem, plan/implement/review, research/synthesize/review. Starters instantiate the same canonical model; they are not hardcoded alternate runtimes.
- First-class input-definition editing in Build: labels, descriptions, required values, defaults, and suitable input controls. Begin with existing text/path support; add types such as choice or resource reference only with validated runtime semantics. Descriptions/defaults are also new schema fields: evolve them through version-aware loading/migration while preserving existing definitions and run snapshots.
- A procedure-oriented default authoring view: ordered stage cards, purpose, input source, expected result, and next outcome. This is a projection of the existing definition, not a second format. Existing branching/managed-role graphs must not be flattened or lose semantics; complex sections remain visible and editable through their existing inspectors.
- Progressive disclosure for model selection, loops, fan-out, and execution policy. Graph and JSON remain advanced tools.
- Save-time diagnostics in user terms: missing input, unreachable stage, absent handoff, incomplete decision routes. Reuse existing shared validators rather than duplicate them in the renderer.
- A run-start summary showing bound inputs, workspace/context, definition revision, and relevant limits. Clear preflight for missing capabilities.
- Definition-level defaults with explicit per-run overrides for supported execution settings; show and snapshot the resolved configuration.

#### Completion test

Create a reusable investigation procedure entirely in the UI, run it against three different questions, and inspect each run's inputs and definition snapshot. No JSON editing or stage-to-stage copy/paste is required.

**Not sufficient:** shipping additional example JSON files alone.

### Milestone 2 — Evidence-based handoffs and human collaboration

**User promise:** “I can understand what each stage produced, give feedback, and know what the next stage will actually receive.”

#### Product capabilities

- An optional output contract alongside free text: initially a small set of useful kinds such as document, findings/checklist, structured result, and explicit resource reference. Avoid making ordinary users design JSON schemas.
- Host validation of declared shape and resource references; distinguish shape-valid, agent-claimed, externally observed, and human-approved. Schema validity is not proof of factual correctness.
- Explicit input selection from previous results with provenance and pinned result versions. Build on current bindings rather than replacing them with an expression language.
- Review checkpoints that present the exact result and support **Approve / Request changes with feedback / Stop**. Preserve input/choice checkpoints for other uses.
- A first-class revision cycle for completed work: feedback becomes input to a new occurrence/version; previous work remains inspectable. This is different from retrying a failed attempt.
- Dependency-aware rerun planning: show which downstream results or approvals become stale when an upstream result changes. Require confirmation before repeating costly or side-effecting work.
- A run detail organized around stages and evidence: current blocker, prior attempts, outputs, human decisions, and linked Pi sessions. Graph remains available for execution topology.
- Separate execution outcome, deliverable availability, validation, and human acceptance. “Agent finished” must not imply “the user’s objective was fulfilled.”

#### Completion test

Run the same review/revision mechanism for a coding plan and a research report. Request changes, produce a new result, and verify downstream work receives the intended version. Old approval cannot silently approve revised content.

**Dependency:** a result/evidence identity contract. The full proposed Local Output Library is not a prerequisite. Later integration may publish selected user-facing deliverables; it must not create a second conflicting revision/approval system.

### Milestone 3 — Durable execution with real-world actions

**User promise:** “My procedure can interact with tools and external systems, wait, and recover without relying on agent memory.”

This milestone has a generic execution core and optional adapters. GitHub is the first coding adapter, not a universal dependency.

#### Generic execution capabilities

- Explicit run/step execution context and resource ownership, passed through the real worker-launch boundary. A path in a prompt is not an execution context.
- Durable action receipts: requested, in progress, observed complete, failed, or outcome unknown. Reconcile uncertain side effects before retrying.
- External waits with persisted conditions, deadlines, bounded polling/backoff or event delivery, cancellation, and restart reconciliation. Waiting should not consume a model session.
- Clear failure policy: stop, bounded retry, ask a human, or take an explicit alternate route. Distinguish failure retry from content revision and from external-state reconciliation.
- Permission/capability declarations, preflight, and approval for consequential external actions. Be explicit about which restrictions are actually enforced; do not market prompt instructions as a sandbox.
- Enforced time/iteration/concurrency budgets and transparent exhaustion. Model cost limits require reliable metering and must disclose their precision.
- Recovery UI explaining what is safe to repeat, what has already happened, and what requires user confirmation.

#### Initial adapters

- **Git execution context:** run-owned worktree/branch and candidate commit references, safe cleanup, one writer per context, and isolation from the user's checkout.
- **GitHub:** fetch issue/PR context; authorized PR create/update; observe required checks and review state. Verify repository and head identity; stale results cannot satisfy a newer candidate.
- **Command evidence:** authorized bounded command execution with cwd, exit status, and bounded output/artifact references. Arbitrary shell execution is a serious capability, not an implicitly safe convenience.

#### Completion test

A GitHub delivery procedure and a non-GitHub command-backed procedure can wait or restart without duplicating side effects or fabricating success. A changed candidate invalidates its old readiness evidence. Offline/auth failures are visible and recoverable.

#### Required design decision

The current canonical contract has exactly four roles, all of which should remain meaningful. Decide how deterministic actions/waits fit—execution capabilities/hooks or an explicitly versioned system construct—before adding them. A canonical role/schema change requires a design amendment and migration, not a hidden reinterpretation of Worker/Decider prompts.

### Milestone 4 — Maintainable and shareable workflow systems

**User promise:** “I can improve and distribute my procedures without breaking old runs or copying the same logic everywhere.”

#### Product capabilities

- User-facing draft/published definition versions, changelogs, comparison, and explicit upgrade. Preserve existing immutable run snapshots.
- Repository-local and file-based workflow packages with explicit import/trust. Opening a repository must never automatically authorize execution of its workflows.
- Reusable subworkflows with declared inputs/outputs and pinned versions—for example, reuse one review-and-repair procedure across several delivery workflows.
- Shared policy profiles for models, limits, validation requirements, and publication approval. Show precedence and resolved policy; avoid invisible inheritance.
- Contract validation and test fixtures for workflows: representative inputs, mocked stage/action outcomes, expected routes, budget exhaustion, and invalid outputs. A mock run validates procedure behavior, not model quality.
- Run comparison: intervention count, duration, retries, recurring blockers, and supported cost data. Keep local by default; full transcripts are not required for these summaries.
- Explicitly reviewed “Improve this workflow from this run” suggestions. No autonomous mutation of the definition that governed an active run.

#### Completion test

Publish a shared review subworkflow, use it from two procedures, update it, and explicitly migrate only one consumer. Existing runs remain reproducible at the definition/evidence level. Do not promise identical model outputs on replay.

**Scope control:** no public marketplace, enterprise team service, or cloud execution dependency is required.

### Milestone 5 — Controlled scale and adaptive procedures

**User promise:** “I can safely run many instances and use bounded adaptation without losing control of the process.”

#### Product capabilities

- Queueing and admission control across runs, with visible resource/cost budgets and priorities.
- Parallel read-only work first; isolated writable contexts plus explicit integration ownership before parallel implementation.
- Item-based fan-out over typed inputs with item identity, aggregation, partial-failure policy, and bounded size/concurrency.
- Optional schedules and event triggers with explicit authorization, duplicate suppression, missed-event handling, and pause/disable controls. Unattended execution must inherit proven permission and recovery contracts.
- Bounded agent-proposed plans within a declared stage or approved subworkflow set, not unconstrained rewriting of the process.
- Promotion of a proven ad-hoc procedure into an editable workflow draft, followed by human review. Do not pretend a transcript can be converted into a correct executable process automatically.

#### Completion test

Several concurrent coding and non-coding runs remain attributable, isolated, bounded, and recoverable. A stopped trigger or revoked capability cannot be bypassed by queued or late work.

**Defer until evidence warrants it:** automatic backlog processing and autonomous merge. Neither is necessary for the core feature to be successful.

## 5. Cross-cutting requirements

These are requirements for each milestone, not a final hardening phase:

- **Compatibility:** canonical definition migration, unsupported-version preservation, immutable run snapshots, and legacy run readability.
- **Safety:** treat imported definitions, issue text, tool output, and external content as untrusted. Host policy and user authorization cannot be replaced by instructions found in task data.
- **Truthful status:** distinguish queued, executing, waiting on a human, waiting externally, blocked, failed, cancelled, and complete. Avoid making every wait look like active model work.
- **Accessibility:** full keyboard operation, non-color status, accessible evidence and decision controls, no graph-only requirements.
- **Privacy:** retain bounded evidence and appropriate provenance, not unnecessary secrets, hidden reasoning, or private delegated transcripts.
- **Observability:** show decision reasons/provenance that are safe to expose, resource ownership, and actionable failures.
- **Testing:** deterministic schema/state-machine/migration tests and fake-provider/adapter E2E; authenticated real-model behavior remains a distinct acceptance layer.

## 6. Prioritization and implementation dependencies

Recommended product sequence:

1. **Near term:** Milestone 1, paired with the minimum result/review experience from Milestone 2 needed to complete a useful procedure. Improve the normal UI path before adding graph sophistication.
2. **Next:** complete Milestone 2 and build Milestone 3's execution-context/action/wait contracts. The first GitHub adapter becomes a proving ground for general capabilities.
3. **After repeated use:** Milestone 4. Introduce subworkflow composition when duplicated real procedures demonstrate its value.
4. **Later:** Milestone 5, after permission, recovery, and resource ownership are trustworthy.

Design work need not be strictly serial. Result identity, action identity, and execution-context contracts should be explored early so Milestone 1 UI work does not encode incompatible assumptions. Parallel implementation should follow agreed shared contracts; renderer, runtime, adapters, and validation are then separable workstreams.

The near-term build backlog should be framed as feature capabilities, not issue-specific prompts:

- Workflow library/start-from-starter and GUI input authoring.
- Resolved run configuration and preflight.
- Stage/result/decision inspection.
- Result versioning, request-changes, and explicit rerun semantics.
- Execution-context ownership and capability policy.
- Durable actions/waits and adapter contract.

Avoid committing dates or patch-version promises before sizing these slices.

## 7. How the pi-deck issue example tests the roadmap

| Desired experience | General feature capability being tested |
| --- | --- |
| Use the same procedure for many issues | Parameterized definitions, starters, run snapshots. |
| Follow a fixed set of steps | Explicit stage contracts, routing, limits, and completion conditions. |
| Approve a plan or request changes | Version-bound human review and feedback/revision cycles. |
| Implement without damaging other work | Execution-context/resource ownership and capability boundaries. |
| Review/fix until acceptable | Bounded iteration with structured findings and evidence. |
| Open a PR and wait for CI | Authorized external actions, durable waits, observed receipts. |
| Continue after restart | Recovery and side-effect reconciliation. |
| Improve the process after several issues | Definition versioning, run comparison, reusable components. |

For pi-deck, the required **Verify desktop app** check must pass on the current PR commit before integration handoff. Inspect uploaded Playwright diagnostics on E2E failure rather than treating a retry as evidence. Keep required authenticated acceptance visibly outstanding when not executed.

Pair this coding test case with a non-coding research/review procedure. If the feature only works by hardcoding GitHub concepts into core roles, the abstraction is wrong.

## 8. Success measures

Evaluate the feature through repeated use:

- Can a user author, run, and revise a procedure without JSON or repeated process instructions?
- How much manual context copying and “what happens next?” coordination remains?
- Are interventions meaningful decisions rather than repairs to missing plumbing?
- Can users identify what produced a result and exactly what they approved?
- Can interrupted runs be recovered without guessing about side effects?
- Can one procedure be reused across tasks and improved without altering old runs?
- Can the same core capabilities serve both coding and non-coding work?

Measure these through dogfood observation before setting numerical targets. Number of nodes, model calls, or templates is not evidence of usefulness.

## 9. Validation and source grounding

The current-state assessment is grounded in `src/shared/agentWorkflowSchemas.ts`, `src/main/workflows/`, `src/renderer/components/workflows/`, the canonical [role-based design](agent-workflows-role-based-design.md), and the shipped [feature-delivery example](examples/feature-delivery-workflow.json).

New deterministic checks should participate in `npm run verify:ci`. Implementation PRs require the protected **Verify desktop app** check on their current commit. Authenticated provider/model smoke remains release-only unless CI has a safe credentialed environment.

This is a feature roadmap, not a claim that these capabilities have shipped or that an implementation has passed CI.
