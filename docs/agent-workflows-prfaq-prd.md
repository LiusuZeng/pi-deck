# Agent Workflows: reusable processes — PR/FAQ and PRD

**Status:** Proposed feature direction; not a shipped-feature announcement or release-date commitment.

## In a few sentences

Agent Workflows should let you define a repeatable process once and run it on different tasks, rather than coordinate agents manually each time. First, make processes easy to create and reuse; next, make review, feedback, and recovery reliable; then, connect external tools such as GitHub and CI.

Developing pi-deck from its open issues is one example—not the scope of the feature.

---

# Part I — PR/FAQ

## Draft press release

### Pi Deck turns your way of working into a reusable agent workflow

**Define the steps once. Bring a new task. Stay in control.**

Pi Deck's next evolution of Agent Workflows will help users save and repeat the processes they already follow. Instead of repeatedly telling agents what to do next, users will choose a workflow, provide the task, and follow its progress from one clear run view.

A developer could reuse “investigate → plan → approve → implement → review” for different issues. A researcher could reuse “gather sources → compare → draft → review” for different questions. Deck will carry the relevant results between stages and pause when a human decision is needed.

The feature will develop in three stages: easier creation and reuse; reliable review, feedback, and recovery; then external actions and waiting, including GitHub and CI. Users will be able to see what happened, what is blocked, and what needs their attention. New integrations will not be required to use ordinary workflows.

The goal is less coordination work—not more agents, a more elaborate graph, or unattended automation by default.

## Frequently asked questions

### 1. What problem does this solve?

Today, repeating a task often means repeating the coordination: restating the steps, copying results between agents, asking for review, and remembering what comes next. A workflow saves the process and makes each execution visible.

### 2. How is this different from a saved prompt, a session, or Parallel?

A saved prompt gives instructions. A session supports an open-ended conversation. Parallel distributes work. A workflow records an explicit process, hands results between stages, pauses for decisions, and tracks an individual run. It can use agents sequentially or in parallel, but multiple agents are not required.

### 3. Do I have to learn JSON or draw a graph?

No. Ordinary creation and reuse should work through stage cards, input fields, and clear next-step choices. Existing Graph and JSON views remain available for advanced users. They all describe the same workflow, not separate implementations.

### 4. Does this mean a built-in workflow specifically for fixing GitHub issues?

No. GitHub issue delivery is a dogfood case for general capabilities: reusable inputs, handoffs, approvals, execution context, and external waits. The same core should support investigation, research, writing, and review.

### 5. Can I change my mind or ask for revisions?

Yes. The reliable-review phase adds feedback and request-changes cycles, with decisions attached to the exact result reviewed. Retrying a failed stage and asking for a better result are different actions. Deck must make their effects clear.

### 6. Will it run unattended or merge code for me?

That is not the initial goal. Human checkpoints remain central. Later external integrations require explicit authorization for consequential actions. Automatic merge, automatic backlog execution, and scheduled triggers are outside the committed scope of this proposal.

### 7. What happens if Deck closes or something fails?

Existing persisted run/retry behavior is retained. The roadmap improves explanations and recovery: completed work stays recorded; interrupted agents are not silently described as still running; uncertain external actions are checked before being repeated. Stop does not promise rollback of files, commits, or remote changes.

### 8. Is a workspace or workflow a sandbox?

No. A workspace is organization, and instructions such as “read-only” are not enforced security controls. Later execution-context and capability features must state what they actually enforce. Git worktrees prevent accidental overlap; they are not an OS security boundary.

### 9. How does this relate to the Local Output Library in #141?

Workflows manage the process; Outputs manages durable user-facing deliverables. Selected workflow results may later be saved to Outputs. This feature must not wait for the entire library to ship, automatically publish every intermediate result, or treat accepting an output as answering a workflow checkpoint.

### 10. What will ship first, and when?

First: usable starter workflows, GUI input authoring, duplication/import/export, and clear start/progress views. Then: richer review/revision and recovery. External integrations follow their required safety contracts. Dates and release versions should be assigned after design and sizing, not promised by this planning issue.

---

# Part II — Product Requirements Document

## 1. Problem and goals

The current engine supports more than the current product experience makes easy to use. Users can assemble agents, but still lack a simple, dependable way to maintain a reusable working procedure.

**Primary user:** a Pi Deck user who repeats multi-step work and wants to stop manually coordinating each step. Initial dogfooding includes developing pi-deck with pi-deck and a non-coding research/review task.

**Goals:**

- G1: Create a process once and reuse it for different tasks without JSON or repeated process instructions.
- G2: Make stage inputs, outputs, decisions, progress, and blockers understandable.
- G3: Support feedback and recovery without losing history or silently repeating consequential work.
- G4: Extend to external systems without making GitHub or coding mandatory.

**Non-goals:** a new execution engine, more application-specific agent roles, a free-form editable graph canvas, an IDE, a public marketplace, cloud execution, autonomous merge, or unrestricted parallel code writers.

## 2. Current foundation versus new work

**Already present:** Worker/Decider/Orchestrator/Human roles; Build/Graph/JSON; branching; bounded loops/fan-out; Human input/approval/choice; Worker-text handoffs; immutable definition snapshots; occurrences; persistence; retries; recovery; Pi session drill-in.

**Not yet productized:** starter selection/import flow, GUI workflow-input definition editing, a complete feedback/revision experience, dependable execution-context ownership, host-verified external actions/waits, and user-facing workflow evolution/composition.

Build on existing code. Do not re-propose existing primitives as newly delivered capabilities.

## 3. User experience

1. Open Agent Workflows and select an existing workflow or **Use starter**.
2. Configure reusable stages and inputs; save the definition.
3. Start a run with a new task. Confirm its workspace/context and effective settings.
4. Follow stage progress and inspect results; open the associated Pi session when useful.
5. Answer checkpoints, provide feedback, or recover from a failure.
6. Review the outcome. Edit the workflow for future runs without changing earlier runs.

Later integrations extend this same experience with authorized actions and visible external waits—not a separate GitHub-only workflow product.

## 4. Delivery phases and requirements

### Phase 1 — Easy to create and reuse

**Promise:** “I can save a process and reuse it without rewriting prompts.”

- **P1-1 — Library and starters.** Add Use starter, Duplicate, Import, and Export. Include at least one coding and one non-coding starter. Starters use the existing canonical definition/runtime.
- **P1-2 — Input authoring.** Add GUI editing for input names/labels, types, and required status, initially using supported text/path inputs. Add help/defaults only through explicit schema evolution. Path inputs need an explicit selection/confirmation flow and main-process validation against the authorized resource before host use; invalid or unavailable paths fail visibly. A path input is context, not an implicit change of worker directory, permission grant, or sandbox for the agent's ordinary tools.
- **P1-3 — Stage authoring.** Show each stage's purpose, incoming result, expected result, and next outcome. Preserve existing branches, loops, fan-out, and role inspectors; never flatten or discard complex graph semantics.
- **P1-4 — Start and preflight.** Show resolved task inputs, workspace/project context, definition revision, and effective supported execution settings. Block invalid definitions or missing required inputs with actionable explanations. Starting a run is explicit; importing/opening a workflow never executes it.
- **P1-5 — Run clarity.** Show the current stage, blocker, results, decisions, errors, and session links. Retain existing stop/retry and Human controls. Distinguish waiting for input from model execution.
- **P1-6 — Reuse without mutation.** Each run preserves its definition and inputs. Editing the saved definition affects future runs only. Duplication creates independent identity and correctly remapped references; import collisions require an explicit resolution and cannot overwrite history silently.

**Boundary:** GitHub intake, PR publication, managed worktrees, and verified CI waiting are not required in Phase 1. A starter may describe manual checkpoints or use available agent tools, but must not present them as host-verified integrations. Concurrent writable coding runs are not safe merely because they use different Pi sessions; use separately prepared project contexts until managed isolation exists.

### Phase 2 — Reliable review, feedback, and recovery

**Promise:** “I can inspect, revise, and continue work without guessing what happened.”

- **P2-1 — Result identity.** Expose existing occurrence IDs and handoff lineage in the review experience; add the missing result-version and approval-binding semantics. Preserve readable Worker text; do not require users to design arbitrary schemas. References to files need authorized access and defined snapshot/integrity behavior before they can count as pinned evidence.
- **P2-2 — Review and feedback.** Add Approve, Request changes with feedback, and Stop at appropriate review checkpoints. Approval applies only to the presented result. A new revision does not inherit approval.
- **P2-3 — Bounded revision.** Pass feedback into an explicitly configured revision cycle. Preserve prior attempts and stop for attention when its limit is reached. Do not introduce arbitrary graph cycles or assume a model will obey a prompt-only iteration limit.
- **P2-4 — Honest rerun.** Distinguish retrying failure from revising completed work. Show affected downstream work and invalidate stale results/decisions before continuation. No general arbitrary rewind is required for the first version; support declared review cycles first.
- **P2-5 — Recovery.** After restart, show completed, waiting, and interrupted work accurately. Offer only supported continuation actions. Stop cancels owned work but does not promise to undo side effects. Uncertain agent-tool mutations require inspection or manual reconciliation, not blind automatic replay.
- **P2-6 — Evidence clarity.** Distinguish agent claims, observed tool/check results, and human approval. Execution completion alone is not proof that the task met its acceptance criteria.

**Boundary:** this is not a general artifact library or a guarantee of automatic recovery from arbitrary shell side effects.

### Phase 3 — External tools and durable execution

**Promise:** “The process can act on external systems, wait, and recover safely.”

- **P3-1 — Execution context.** Bind runs/steps to explicit authorized locations/resources through worker launch. The first Git adapter provides an owned branch/worktree, candidate identity, one writer per context, and explicit cleanup that preserves dirty work.
- **P3-2 — Authorized actions.** Introduce a narrow adapter contract for operations such as PR creation/update. Show proposed consequential actions and require authorization. Record host-observed receipts; an agent saying an action succeeded is not sufficient.
- **P3-3 — External waits.** Persist the target, expected condition, deadline, and observed state. Wait without consuming a model session. Handle offline/auth/rate-limit failures, cancellation, and restart. A local bounded polling adapter is sufficient initially; no cloud webhook service is required.
- **P3-4 — Reconcile before retry.** If an action's outcome is uncertain, inspect external state before repeating it. Reuse existing external identity where appropriate; do not promise exactly-once execution across GitHub and local storage.
- **P3-5 — Candidate-bound readiness.** GitHub checks/reviews must refer to the expected repository/PR/head. A changed candidate invalidates old readiness. Missing, pending, cancelled, or stale checks are not success.
- **P3-6 — Limits and escalation.** Enforce action retry, wait, and repair limits in the host. Expose exhaustion and request attention rather than looping indefinitely.

**Mandatory prerequisite before Phase 3 implementation:** agree the adapter/action/wait state contract, persisted representation, UI projection, and compatibility/migration approach. Decide whether this is a role-neutral execution capability or a canonical schema amendment. Any schema/role expansion requires an explicit design amendment and migration; do not disguise polling or verification as a Decider prompt.

**Boundary:** merging remains a human action initially. Worktree isolation and capability policies must not be advertised as a sandbox unless actually enforced.

### Later, only after repeated use

Workflow version comparison, repository packages, shared subworkflows, policy profiles, run comparison, schedules, dynamic fan-out, and agent-assisted workflow drafts. These are directions to evaluate, not prerequisites for the three phases above.

## 5. Acceptance scenarios

Each phase must satisfy its scenarios and preserve earlier ones.

| ID | Phase | Scenario | Required outcome |
| --- | --- | --- | --- |
| A1 | 1 | Create a workflow and input fields entirely in the GUI; run it for three different tasks. | No JSON editing or repeated process instructions; separate inputs and history for each run. |
| A2 | 1 | Duplicate, export/import, and edit a workflow; exercise an ID collision. | Valid independent references, explicit collision handling, no silent data loss or execution. |
| A3 | 1 | Edit a definition after starting a run; view a workflow with branches/loops. | Existing snapshot unchanged; complex semantics remain intact and understandable. |
| A4 | 1 | Omit a required input, encounter an invalid definition, or wait at a Human node. | Clear preflight/blocker; no ambiguous “running” state or unnecessary Pi session for a Human checkpoint. |
| A5 | 2 | Request changes on a coding plan and on a research report. | Feedback reaches the revision cycle; earlier result/decision remains inspectable; only the intended approved result advances. |
| A6 | 2 | Revise upstream work, exhaust a repair limit, or retry a failure. | Stale downstream decisions cannot advance the run; distinct actions and bounded escalation are visible. |
| A7 | 2 | Restart at a checkpoint or during an agent stage; stop and receive a late event. | Accurate recovery; no fabricated completion, lost approval, or resurrection of cancelled work. |
| A8 | 3 | Restart immediately after PR creation but before its receipt is saved. | Reconcile the existing PR; no duplicate publication from blind retry. |
| A9 | 3 | Wait for CI, lose connectivity, then observe a changed PR head. | Visible wait/error; old green checks cannot satisfy the new candidate. |
| A10 | 3 | Run coding work alongside user changes; stop and clean up. | Correct worker cwd/ownership; user checkout untouched; no silent loss of uncommitted work. |
| A11 | 3 | Use a non-GitHub command-backed procedure. | The same action/wait/evidence concepts work without GitHub-specific core roles. |
| A12 | All | Import untrusted content, navigate with keyboard, or load unsupported persisted data. | No implicit execution/authorization; accessible operation; preserve data and report limitations. |
| A13 | 1 | Select a path input; try a missing path or an unapproved replacement through IPC. | Clear selection/confirmation; main-process rejection before host use; input does not relocate the worker or authorize neighboring resources. |

## 6. Safety and compatibility

- Keep one canonical definition and existing Pi-native session ownership. Preserve immutable run snapshots, migration backups, unsupported data, and legacy readability.
- Treat issue text, imported workflows, tool output, and repository content as task data, not authority to override user/host policy.
- Keep secrets and unnecessary transcript/private worker content out of stored evidence. Bound retained output and diagnostics.
- Enforce path/resource validation in Electron main. Describe tool restrictions honestly, including shell/extension escape paths.
- For self-development, keep the controlling Deck app and candidate app/test data/processes separate. Testing a shutdown fix must not terminate the controller's work.

## 7. Success and validation

Before declaring Phase 1 useful, reuse a coding procedure and a non-coding procedure for at least three tasks each without JSON or manual stage-to-stage context copying. Observe where users still have to coordinate the process themselves.

For Phase 2, complete feedback/revision and restart-recovery scenarios for both kinds of work. For Phase 3, demonstrate external reconciliation and current-candidate evidence, not just the happy path.

Success means fewer repeated instructions, less manual handoff, understandable intervention, and trustworthy continuation—not more nodes or model calls.

- Add deterministic schema, runtime, persistence/migration, renderer, and fake-adapter Electron E2E coverage for the acceptance scenarios.
- `npm run verify:ci` remains the canonical validation contract; wire new deterministic commands into it if not already covered.
- Implementation PRs require the protected **Verify desktop app** check on the current commit. Inspect uploaded Playwright diagnostics on E2E failures; a retry alone is not evidence.
- Authenticated provider/model smoke remains release-only unless CI is explicitly given a safe credentialed environment. Unperformed real-provider acceptance stays visibly outstanding.

## 8. Implementation handoff

Split implementation into feature capabilities, not a series of issue-specific prompts:

1. Starter/library actions and GUI input authoring.
2. Preflight and run-stage clarity.
3. Result identity and review/revision contracts.
4. Recovery and downstream invalidation.
5. Execution-context ownership and external action/wait contracts.
6. Initial Git/GitHub adapter and failure-path coverage.

Agree shared contracts before parallel implementation. Use separate branches/worktrees for concurrent code changes; central integration owns combined validation.

Existing implementation seams: `src/shared/agentWorkflowSchemas.ts`, `src/main/workflows/`, `src/main/main.ts:createWorkflowOccurrenceScheduler`, and `src/renderer/components/workflows/`. Preserve the contract in `docs/agent-workflows-role-based-design.md`. The current `docs/examples/feature-delivery-workflow.json` is a starter example, not the complete product direction.

This issue requests product/design and phased implementation planning. It does not claim runtime changes, executed dogfood runs, or passing implementation CI.
