# Agent Workflows: from prompt graphs to repeatable issue delivery

**Status:** **UNAPPROVED** proposal for discussion, not an approved product contract or implementation claim.
**Scope:** Make developing pi-deck with pi-deck a first-class workflow use case. This is a use-case exploration, not the feature-wide roadmap; see [Agent Workflows — Feature Roadmap](agent-workflows-feature-roadmap.md) for the broader product direction.
**Evidence:** Current repository implementation, canonical workflow design, and open GitHub issues inspected during this review. Issue state may change.

## 1. Recommendation

Make **Deliver a GitHub issue** the flagship Agent Workflow. Start with one issue, one isolated worktree, a fixed process, and human decisions at meaningful boundaries. Prove that process before expanding the graph editor or building a general automation platform.

The product promise should be:

> Choose an issue and a delivery process. Deck preserves context, advances the work, verifies the required evidence, and asks for a decision when needed. You do not have to coordinate every agent or remember the next step.

A workflow is not valuable merely because several prompts execute in sequence. It becomes valuable when it reliably owns handoffs, execution context, evidence, recovery, and completion criteria.

## 2. What exists today

| Capability | Verified current behavior | Delivery implication |
| --- | --- | --- |
| Execution model | Worker, Decider, Orchestrator, Human; bounded loops and fan-out; explicit Worker-output bindings. | Reuse the engine. Planner, implementer, reviewer, and investigator are configurations, not new roles. |
| Human interaction | Input, approval, and choice checkpoints; revision-aware answers. | Useful foundation for plan and final review gates. A full request-changes/feedback/revision experience is not supplied by a yes/no checkpoint alone. |
| Persistence | Snapshotted definitions, occurrence records, store revisions, session references, recovery and explicit retries. | Substantial foundation, but not proof of safe replay of GitHub side effects or automatic continuation of interrupted agents. |
| Authoring | Build, Graph, and JSON views. | Advanced composition exists before an easy outcome-oriented starting point. |
| Inputs | Text/path schemas and run-input dialog; no dedicated input-definition editor in Build. | Users still need JSON to author reusable issue parameters. |
| Starter example | `docs/examples/feature-delivery-workflow.json`: plan → approve → implement; no declared inputs. | It teaches the graph mechanics, not end-to-end delivery. |
| Handoffs | Worker final-answer text, boolean Decider results, collected text outputs; `expectedOutput` is instructional text. | No validated issue, branch, review, PR, or check-result contract. |
| Execution location | Workflow sessions are created in the workspace's project context. | No workflow-owned worktree/branch contract. Parallel workers must not be assumed to have isolated files. |
| Permissions | Instructions can request read-only work. | Prompt instructions are not enforced tool permissions or an OS sandbox. |
| External systems | No first-class GitHub issue/PR/check integration in the workflow implementation reviewed. | An agent may invoke available CLI tools, but Deck cannot yet independently verify the delivery lifecycle. |

**Diagnosis:** the orchestration foundation is reasonably deep; the usable delivery process and its guarantees are shallow. More role types or a richer graph canvas would not address the central gap.

## 3. The fixed process to dogfood

### Entry

In the pi-deck workspace: **Run workflow → Deliver GitHub issue → paste issue URL**. An issue picker can follow later; it is not necessary for the first slice.

Before execution, show the resolved repository, issue, base branch, selected workflow revision, model policy, and external actions that may require approval. Detect existing runs/PRs for the issue and offer resume/link rather than silently creating competing work.

### Stages and exit conditions

| Stage | Work | Required result / gate |
| --- | --- | --- |
| 1. Intake and preflight | Fetch issue body and selected discussion; inspect repository instructions, relevant code, linked PRs, and acceptance criteria. | Persist issue snapshot and source links. Confirm repository identity, auth/capabilities, base ref, and an authorized working location. Block or ask for clarification if scope is ambiguous. |
| 2. Plan | Investigate/reproduce as appropriate; propose scope, files, risks, tests, and any manual acceptance. | Reviewable plan version with explicit acceptance checklist; distinguish a confirmed defect from an unverified report. |
| 3. Approve plan | User accepts, requests changes with feedback, or stops. | Approval refers to that plan version, not a floating latest answer. Material scope changes require renewed approval. |
| 4. Implement | Work in a run-owned branch/worktree; add regression coverage; run focused local checks when useful. | Candidate commit/diff, change summary, and actual validation receipts. Do not require the full local suite when CI supplies it. |
| 5. Independent review and repair | Another Worker reviews the candidate against the issue, plan, and repository policy. Repair and re-review within a configured limit. | Findings and review verdict tied to the candidate commit. Exhaustion requests human attention rather than pretending success. Start with sequential implementation and review. |
| 6. Publish PR | Present proposed external changes; on authorization, push and create or update a linked PR. | Host-confirmed repository, PR identity, head SHA, and URL; never infer success from prose. Prefer a draft PR while validation is outstanding. |
| 7. Wait for CI / repair | Wait without keeping a model session busy. On failure, collect diagnostics and perform bounded repairs, then review the changed candidate again. | Required **Verify desktop app** passes on the current PR head. Inspect Playwright artifacts for E2E failures; a rerun alone is not evidence. Missing, pending, cancelled, or stale checks are not success. |
| 8. Human handoff | Show issue acceptance, diff/commit, review, CI, and outstanding manual checks together. | Mark **Ready for human review**, not merged or issue resolved. Early releases leave merging to the user in GitHub. |
| 9. Reconcile outcome | Observe merge/closure or explicit abandonment; offer cleanup. | Record what actually happened. Do not automatically delete a dirty worktree or close an issue because an agent finished. |

“Fixed” means stable stages, gates, and responsibilities. It does not mean ignoring an unreproducible bug, an ambiguous requirement, or a failed experiment. These must be explicit blocked/clarification/manual-acceptance outcomes.

### Run experience

The primary run screen should answer:

- Which issue, repository, branch/worktree, candidate commit, and PR is this?
- What stage is it at, and what is blocking it?
- What decision does Deck need from me?
- Where are the plan, findings, diff, test/check evidence, and associated Pi sessions?
- What will Retry repeat, and what external effects have already happened?

Use a stage checklist and an evidence panel as the default presentation. Keep the existing graph as an advanced execution view, not the only way to understand delivery.

## 4. Phased roadmap

### Phase 0 — Prove the process with existing primitives

**Deliverable:** a repository-owned issue-delivery example, explicit issue/repository inputs, prompts grounded in `AGENTS.md`, and a dogfood runbook.

Use the existing Worker/Human/Loop machinery for intake, plan approval, implementation, review, and bounded repair. Where external actions or verification are not host-supported, use explicit manual checkpoints and label the limitations. Manually prepare an isolated worktree/project context; do not treat a path input as automatic session relocation.

Run a small issue through it and record every manual copy/paste, missing context handoff, and recovery problem. This is a process experiment, not a claim of automated GitHub delivery.

**Exit:** at least one real issue reaches a reviewed PR with current-head CI evidence, using the same reusable definition rather than rewriting a large prompt at every stage.

### Phase 1 — Make the process usable and safe for one issue

**Deliverables:**

- **Use template → Deliver GitHub issue**, plus GUI input authoring and a clear preflight/start summary.
- Run-owned repository/base/branch/worktree context; enforce the actual worker cwd through the session-launch contract.
- One implementation writer per run initially; independent review gets the exact candidate context without a competing writer.
- Stage/evidence view, plan approval, and request-changes feedback. Successful-but-rejected work needs an explicit new iteration, not misuse of “retry failed occurrence.”
- Persist and disclose resource ownership. Stop does not mean rollback; cleanup is explicit and preserves uncommitted work.
- Capability-policy design for investigation/review versus implementation versus publication. If read-only cannot be enforced, label it advisory; do not advertise a sandbox.

**Exit:** another run of the same template requires no JSON editing or manual prompt/context relay. User working-tree changes remain untouched. Restart clearly preserves checkpoints and identifies interrupted work.

**Scope control:** keep PR publishing and CI confirmation manual until Phase 2 contracts exist. Avoid parallel code writers in this slice.

### Phase 2 — Make GitHub delivery verifiable

**Deliverables:**

- A narrow host-owned Git/GitHub adapter, initially able to use an authenticated local `gh` installation with structured responses. No hosted webhook service is required.
- Durable action records and reconcile-before-retry semantics for branch/worktree preparation, push, PR creation/update, and check observation.
- Typed evidence references for issue snapshot, plan, candidate SHA, review, PR, CI run/check, and user decisions.
- Durable external waits with bounded polling/backoff, offline/auth-error states, deadlines, cancellation, and restart reconciliation.
- CI failure evidence collection; repair limits; escalation instead of endless reruns.
- Invalidate commit-bound review/approval/check readiness when the PR head changes. Stale completion events cannot advance a newer candidate.
- Explicit authorization before posting/pushing; keep merge outside the automatic path.

**Exit:** Deck can prove the current candidate passed the required check; restarting immediately after PR creation does not create a second PR; an old successful check cannot satisfy a new commit.

This is the milestone at which **issue → verified PR** becomes a credible product promise.

### Phase 3 — Scale the proven workflow

Only after single-issue delivery is reliable:

- Browse/filter open issues and launch the existing template from a selected issue.
- Multiple concurrent issue runs, each with independent worktree ownership and repository-level coordination where necessary.
- Parallel read-only investigations/reviews first; separate writable worktrees and a designated integrator before parallel implementation.
- Repository-versioned templates/policies with explicit import/update and immutable run snapshots. Loading a repository must not silently authorize workflow execution.
- Per-stage model choices, elapsed-time/cost visibility where supported, run-wide budgets, and repair ceilings.
- Additional fixed recipes: investigation-only, bug fix, feature delivery, review existing PR.
- Optional publication of selected plans/reports into the Local Output Library proposed in #141.

**Exit:** several issues can be delivered without cross-run file interference, duplicated PRs, lost approvals, or hidden intervention requirements.

## 5. Contracts to resolve before implementing automation

### Execution context is not a text input

Bind `run → repository → base commit → owned worktree/branch`, then bind each occurrence to the appropriate context. Validate paths in Electron main. Workspace membership is organizational, not a filesystem isolation or security boundary.

For self-development, also isolate the **controlling app** from the **app under test**: use a stable controller build and separate test application data/processes. Rebuilding or testing a candidate must not reset the controller's sessions, restart its renderer unexpectedly, or terminate its workers.

### Evidence is separate from narration

Keep bounded Worker text for human-readable handoff, but add validated references/receipts. An agent-generated JSON value alone is not proof of a remote action or test result. Store observed evidence with repository/commit/run identity and provenance. Human judgments and model judgments remain distinct from deterministic command/check outcomes.

Avoid building a universal artifact framework just for this workflow. The proposed Local Output Library can later retain user-facing plans/reports; delivery must not depend on that entire project shipping first. Output acceptance must not implicitly answer a workflow Human checkpoint.

### Deterministic actions and waits are not model decisions

The existing canonical design deliberately defines exactly four roles. Do not casually add “GitHub Agent,” “Tester,” or “CI Decider” roles. Preserve planner/reviewer/tester as Worker configurations.

However, external actions/waits are a real missing capability. Decide explicitly whether to represent them as execution hooks or a versioned system-action construct before implementing Phase 2; any canonical schema expansion needs a design amendment and migration. Do not hide the gap by asking a Decider model whether CI probably passed or by keeping a Worker polling indefinitely.

### Recovery must reconcile side effects

A repeated Pi prompt is not necessarily a safe retry. After uncertain outcomes, inspect whether a branch, commit, push, or PR already exists before repeating a mutation. Persist action identity and observations; do not promise global exactly-once execution across local storage and GitHub.

Distinguish retrying a failed attempt, revising a completed result, rechecking CI, and reconciling a completed external action. Changes invalidate affected downstream evidence; unrelated work should not be rerun blindly.

### Permissions and untrusted input

Issue bodies, comments, CI logs, and repository content are task data, not authority to alter workflow policy, publish secrets, or bypass human decisions. Keep secrets out of durable diagnostics. Tool restrictions must account for shell commands and installed extensions; hiding an edit tool while leaving unrestricted shell access is not read-only enforcement. Worktrees prevent accidental file overlap, not malicious access outside the directory.

## 6. Concrete pi-deck dogfood sequence

1. **[#153: atomic settings persistence](https://github.com/LiusuZeng/pi-deck/issues/153)** — best first process trial: bounded implementation, clear acceptance, deterministic fault-injection coverage. A useful plan should explicitly require fresh-store reload after partial-write failure and distinguish atomic replacement from power-loss durability.
2. **[#148: repeated quit bypasses shutdown barrier](https://github.com/LiusuZeng/pi-deck/issues/148)** — exercises lifecycle investigation, hidden-window E2E, diagnostics, and controller/test-process isolation. This is the higher-priority product defect; choosing #153 as a smaller workflow experiment is not a recommendation to delay #148.
3. **[#146: steering/follow-up delivery](https://github.com/LiusuZeng/pi-deck/issues/146)** — proves honest incomplete acceptance: deterministic coverage is not a substitute for the issue's real-provider verification. Capture build/Pi-version evidence and leave unperformed authenticated acceptance visibly outstanding.

Intake must also detect existing work. At inspection, #144 already had open PR #145; starting a duplicate implementation should not be the default.

## 7. Validation and success criteria

Deterministic contract tests should cover:

- Issue/repository mismatch, unavailable auth, existing PR/run, dirty checkout, and unsafe worktree paths.
- Worker cwd, resource ownership, stop/cleanup boundaries, and concurrent run isolation.
- Request-changes feedback, new candidate versions, and invalidation of downstream approvals/checks.
- Crash before/after external action acknowledgment; no duplicate PR after reconciliation.
- Offline/rate-limited waits, stale events, changed PR heads, failed/cancelled/missing checks.
- Bounded review/CI repair loops and explicit escalation.
- Restart at a human checkpoint and during CI waiting; no fabrication of completed work.
- Fake GitHub + fake Pi Electron E2E for the whole issue-to-handoff journey.

Wire new deterministic validation into `npm run verify:ci` where not already covered by test discovery. Implementation PRs require **Verify desktop app** on the current commit; inspect uploaded Playwright diagnostics on E2E failures. Authenticated provider/model acceptance remains release-only unless CI has a safe credentialed environment.

Measure success through completed dogfood runs, not graph complexity:

- No repeated process instructions or manual transfer of context between agents.
- Human attention concentrated on scope/approval, genuine blockers, and final review.
- No accidental edits to the user's checkout or duplicate external actions after retry.
- Every readiness claim links to the candidate and its actual evidence.
- Interrupted runs can be understood and continued without reconstructing the history manually.

## 8. What not to prioritize

An editable graph canvas, more application-specific role types, automatic backlog execution, autonomous merge, a generic integration marketplace, or unrestricted parallel code writers. None is required to prove the core use case.

## 9. Source map

- `docs/agent-workflows-role-based-design.md` — canonical role/graph constraints; historical sequence is not the new roadmap.
- `docs/examples/feature-delivery-workflow.json` — shipped three-stage example.
- `src/shared/agentWorkflowSchemas.ts` — current input, execution, output, and occurrence contracts.
- `src/main/workflows/agentWorkflowRuntime.ts` — transitions, handoffs, human answers, loops/fan-out.
- `src/main/workflows/workflowScheduler.ts` — Pi session execution, retry/stop fencing, terminal event handling.
- `src/main/workflows/workflowRehydration.ts` and `workflowStore.ts` — recovery and persistence.
- `src/main/main.ts:createWorkflowOccurrenceScheduler` — workspace-bound session allocation.
- `src/renderer/components/workflows/AgentWorkflowBuilder.tsx`, `AgentWorkflowHome.tsx`, `WorkflowOccurrenceRunView.tsx` — authoring/start/monitoring surfaces.
- `AGENTS.md`, `package.json`, `.github/workflows/ci.yml` — repository development and CI policy.

This review inspected source, existing test coverage, and GitHub issue/PR metadata. It did not run an actual delivery workflow, modify runtime code, create GitHub issues, or establish an implementation CI result.
