# Parallel Task Sessions Design

Status: **Implemented on the dedicated feature branch; pending merge and release**

This document is the canonical product and engineering contract for ad-hoc
parallel work in Pi Deck. It is separate from Agent Workflows, which are saved,
explicit execution graphs.

## 1. Product model

Pi Deck uses the following user-facing terms:

- **Parent session:** the conversation the user opens and talks to directly.
- **Task session:** a private Pi session created by a parent to process one
  planned task brief independently.
- **Parallel mode:** the parent-session setting that controls the default
  destination of newly sent prompts.

Product UI and documentation should use **task session**, not **subagent**.
“Subagent” may still describe internal engineering processes, but it is not the
product abstraction presented to users.

A task session is a real isolated Pi session, not a tool call displayed inside
the parent's transcript. It has its own worker, lifecycle, and result, while
remaining owned and mediated by its parent.

## 2. Prompt-routing contract

Prompt routing is deterministic application behavior. It must not depend on the
model deciding whether a prompt is sufficiently complex or electing to call a
delegation tool.

### Parallel mode off

- A prompt is sent to the parent session.
- Pi Deck does not create a task session for that prompt.

### Parallel mode on

- Every prompt defaults to **New task session**.
- Before sending, the user may choose **Work in parent** for that prompt.
- **Work in parent** is a one-prompt override. The next prompt returns to the
  mode's default destination, **New task session**.
- A **New task session** prompt always enters the task-session planning path.
  The parent creates a structured plan containing one or more independent task
  briefs, and Pi Deck automatically starts or queues every task in that plan.
- No second approval is required: selecting parallel mode is the user's consent
  to automatic planning and task-session creation.
- Pi Deck deterministically selects the planning path before model execution.
  The parent model may decide how to decompose the work, but it cannot decide to
  bypass task sessions and run the prompt directly in the parent.

For example, “Find the hottest city in the US, Canada, and Mexico” should
normally produce three task sessions, one for each country. An indivisible
prompt produces one task session. A single prompt may therefore produce more
than one task session, and the parent may own tasks from multiple prompts at the
same time.

The parent remains conversational while its task sessions run. New prompts can
start additional task plans or can be directed to the parent with the per-prompt
override. If a parent turn is already active, an explicit **Work in parent**
prompt follows the parent's normal steer/follow-up behavior; it must not be
silently converted into a task session.

## 3. Composer UI

The parent composer must expose two distinct controls:

1. A persistent, explicit mode toggle: **Parallel: Off** / **Parallel: On**.
2. A per-prompt destination selector.

Destination behavior:

| Mode | Default destination | Available explicit destination |
| ---- | ------------------- | ------------------------------ |
| Off  | Work in parent      | Work in parent                 |
| On   | New task session    | Work in parent                 |

The selected destination must be visible before send. A user must not have to
infer routing from an icon, tooltip, model behavior, or activity appearing
afterward.

Changing the mode affects the default for subsequent prompts; it does not move,
cancel, or restart work already running.

Parallel mode has persistent worker defaults for model and thinking level. The
per-prompt destination UI also permits prompt-specific model and thinking
overrides. Settings resolve in this order: per-prompt override, persistent
parallel-worker default, then the parent model and thinking level.

## 4. Parent and task-session presentation

Task sessions appear in a dedicated task panel inside the parent conversation.
They are not nested in the session sidebar. The panel is a flat chronological
list for now; it does not visually group rows by originating prompt.

Each task-session row exposes only parent-safe metadata:

- stable task number and generated short name;
- one-line task brief;
- lifecycle status;
- elapsed time;
- current attempt/retry count;
- concise progress or failure message.

Required lifecycle states are:

- queued;
- running;
- waiting for input;
- completed;
- failed;
- cancelled or interrupted.

Task-session rows are informational only:

- users cannot open or expand a task session as a conversation;
- rows expose no input, cancellation, retry, navigation, or other intervention;
- users cannot address a private runtime or session directly;
- task prompts, transcripts, tool details, credentials, and raw outputs are not
  exposed as independent UI;
- task sessions do not appear as ordinary top-level sessions in the sidebar or
  Work inbox.

The UI must show simultaneous task-session states together. A serial list of
parent tool calls is not evidence that parallel task sessions are running.
After the parent reports a prompt's synthesized result, the associated rows are
cleared from the transient task panel. The durable result and trace summary
remain in the parent conversation and parent context.

## 5. Planning, context, and parent reporting

The parent is the sole user-facing surface for its task sessions.

For every **New task session** prompt, the parent produces a validated structured
plan. Each task session receives:

- a parent-generated context summary;
- the original user prompt;
- its assigned task brief;
- the resolved worker model, thinking level, project, and authorized runtime
  configuration.

Task sessions do not receive the full parent transcript. The context summary
must contain enough relevant history and constraints for independent work
without copying unrelated conversation content.

Task-session status and completion handoffs are delivered to the parent. When
all tasks created for a prompt reach a terminal state, the parent automatically
synthesizes their results and reports back to the user; the user does not need
to ask for the result. The parent must use an authoritative task registry and
trace rather than inventing status.

A failed task is retried automatically up to three times after its initial
attempt. Retries preserve the task identity and increment the visible attempt
count. After the third retry fails, the parent synthesizes the successful
results and explicitly reports the terminal failure instead of blocking the
whole prompt indefinitely.

Users may ask the parent about current task status, but no task session opens a
direct user-input or intervention surface.

## 6. Capacity and soft limit

A parent has a soft limit of **10 active task sessions**. Active means starting,
running, retrying, waiting for the parent, or waiting for an internal dependency.
Queued and terminal tasks do not consume active capacity. A waiting task never
opens direct user intervention; the parent remains its mediator.

When a plan would exceed 10 active task sessions:

- excess tasks queue automatically in plan order;
- a prompt whose destination is **New task session** remains task-session work
  and is never silently run in the parent;
- the composer and task panel explain why work is queued;
- the user can still explicitly choose **Work in parent** for another prompt;
- terminal rows are cleared after parent reporting and do not consume active
  capacity.

The per-parent soft limit is distinct from Pi Deck's global attached-worker
capacity. The global capacity setting still determines how many parent and task
workers can run simultaneously; excess task sessions remain visibly queued.

## 7. Lifecycle, persistence, and failure behavior

- The parent persists the plan, task identity, context-summary trace, attempt
  history, status transitions, and terminal handoffs needed to explain prior
  work and synthesize results.
- Reopening a parent restores its selected parallel mode and task trace.
- Unfinished task sessions never resume automatically after Pi Deck restarts.
  They are marked **interrupted**, and the parent resumes with enough context
  and tracing for the user to decide what to do next.
- The parent reports interruption honestly; it does not display stale work as
  running or silently recreate private sessions.
- A task-session failure does not fail or block unrelated task sessions or the
  parent conversation. Automatic retry follows the three-retry policy in
  Section 5.
- Parent close/delete behavior must explicitly account for active and queued
  task sessions and must not orphan private workers.

## 8. Architecture boundary

The renderer addresses only the parent runtime. It may request a prompt
destination and receive safe task-session summaries, but it must not receive
private child runtime IDs, session-file paths, prompts, transcripts, raw tool
output, or direct child controls.

Electron main owns deterministic routing and validated execution:

1. Receive the parent-scoped send request, selected destination, and any
   per-prompt worker overrides.
2. For **Work in parent**, use the existing parent prompt/intervention path.
3. For **New task session**, invoke the mandatory parent planning path and
   validate a bounded plan containing one or more task briefs. Planning may
   occupy its own short parent turn, but it must not wait for task completion;
   once the plan is accepted, the parent is available for additional prompts.
4. Resolve context summaries and worker settings, allocate stable task numbers,
   and record queued summaries before private worker creation.
5. Queue or start every planned task according to the per-parent soft limit and
   global worker capacity.
6. Retry failed tasks up to three times, preserving task identity.
7. Publish safe status projections and terminal handoffs to the parent.
8. Trigger parent synthesis after all tasks for the prompt are terminal, then
   clear their transient task-panel rows after the report is recorded.

The authenticated local delegation bridge may remain an internal transport, but
normal prompt routing must not require the parent model to call
`deck_delegate`. Model-elected delegation is not the product contract.

## 9. Security and privacy invariants

- Parent capability tokens cannot be used to address another parent's tasks.
- A renderer cannot enumerate or control private task runtimes.
- Persisted task state contains only the plan/trace summaries needed by the
  parent; it contains no private transcript, raw output, runtime ID, or child
  session-file path.
- Task sessions inherit only the project/runtime configuration authorized for
  their parent; they do not widen project or filesystem authority.
- Completion handoffs are treated as untrusted model output and rendered using
  the same sanitization rules as parent content.

## 10. Acceptance criteria

A feature or release claiming parallel task sessions must demonstrate all of
the following:

1. A fresh parent visibly defaults to **Parallel: Off** and **Work in parent**.
2. Enabling parallel mode visibly changes the default destination to
   **New task session**.
3. Sending a first prompt in parallel mode invokes mandatory planning and
   creates one or more private task sessions without relying on model tool
   election.
4. A decomposable prompt such as independent work for three countries produces
   multiple concurrent or queued task sessions automatically.
5. Choosing **Work in parent** sends only that prompt to the parent and the next
   prompt again defaults to **New task session**.
6. The task panel inside the parent shows a flat list with brief, status,
   elapsed time, attempt count, and concise progress; rows have no direct
   intervention or navigation.
7. The parent remains usable while task sessions run.
8. At 10 active task sessions, excess tasks queue automatically and never fall
   back silently to parent execution.
9. Task sessions do not appear as top-level sidebar or Work inbox sessions.
10. Task sessions inherit parent model/thinking settings unless persistent or
    per-prompt worker overrides are specified; per-prompt settings win.
11. Each task receives summarized parent context rather than the full
    transcript.
12. Failures retry up to three times after the initial attempt, after which the
    parent reports successful results and any terminal failures.
13. The parent automatically synthesizes and reports each prompt's results,
    then clears those task rows from the panel.
14. Restart recovery never resumes unfinished private sessions; the parent
    restores their context and trace and reports them as interrupted.

These criteria require fake deterministic E2E coverage and authenticated real-Pi
coverage. A test-only harness that directly invokes `deck_delegate` verifies the
bridge, but by itself does not verify deterministic product routing.

## 11. Integration status

The dedicated feature branch implements the contract above:

- production sends carry an explicit parent/task-session destination;
- a private real-Pi planner produces one or more validated task briefs without
  `deck_delegate` tool election;
- private planner/task workers use `--no-session` and never enter session
  navigation;
- the parent-scoped orchestrator enforces 10 active tasks, ordered queueing,
  three retries, synthesis, transient-row clearing, and interrupted restart;
- worker settings resolve per prompt, persistent parallel default, then parent;
- referenced paths and validated images are materialized once in main, cloned
  only into ephemeral private prompts, and excluded from durable task state;
- the in-conversation task panel is flat, informative, accessible, and inert.

The compatibility `deck_delegate` bridge remains only as a separately tested
transport. Generated parent instructions explicitly prohibit model-elected use
for ordinary prompts.

Release remains blocked until this branch is reviewed, merged deliberately into
the dedicated integration branch, and all CI plus authenticated real-Pi gates
are recorded. No changes have been pushed or published.
