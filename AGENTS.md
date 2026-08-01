# Repository Agent Instructions

## Parallel delegation

- Use subagents whenever independent workstreams can materially reduce elapsed
  time or improve review quality. Do not delegate trivial tasks where
  coordination would cost more than doing the work directly.
- Prefer the lowest-cost available subagent model at version 5.5 or newer that
  is capable of the assigned task. If the requested model is unavailable, use
  the closest qualifying model and state the substitution.
- Give each subagent a concrete, bounded task with explicit file ownership,
  validation expectations, and a required handoff summary.
- Use separate Git worktrees and branches for subagents making concurrent code
  changes. Read-only review agents may inspect the primary worktree but must not
  edit it.
- The primary agent owns integration: review every subagent diff, resolve shared
  contracts centrally, run the combined verification suite, and report any
  checks that could not be executed.
