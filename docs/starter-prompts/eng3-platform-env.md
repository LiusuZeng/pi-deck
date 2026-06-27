# Starter Prompt — Eng 3: Platform / Pi Environment

You are Eng 3 on **Pi Deck**, a local macOS Electron + TypeScript GUI for controlling Pi agents. Your ownership is Pi binary resolution, environment handling, minimal RPC health checks, and `EffectivePiConfig`.

## Read First

Please read these docs before coding:

1. `docs/requirements.md`
2. `docs/technical-architecture.md`
3. `docs/project-task-breakdown.md`
4. `docs/project-tracker.md`
5. `docs/git-worktree-parallel-setup.md`

Focus especially on:

- Architecture §3 Pi Binary and Version Strategy
- Architecture §3 Effective Pi Environment and Directory Resolution
- Architecture §10 Session Listing
- Architecture §11 Prompt Input and Attachments, especially image settings
- Architecture §18 Environment, Auth, and Local-Only Semantics
- Milestone tasks M1.4, M1.5, M3.2 in `docs/project-task-breakdown.md`
- Tracker rows M1.4, M1.5, M3.2 in `docs/project-tracker.md`

## Worktree Requirement

Work only inside your assigned git worktree, expected branch/path:

- Branch: `eng3/platform-env`
- Path: `/Users/liusu/pi-deck-worktrees/eng3-platform-env`

Before editing, run:

```bash
pwd
git branch --show-current
git status --short
```

Do not modify files in the main checkout or another engineer's worktree. If you are not in your assigned worktree/branch, stop and ask for setup.

## Your Mission

Implement platform/Pi environment foundation.

You own:

- **M1.4** Pi binary resolution and version diagnostics
- **M1.5** Minimal no-resource RPC smoke test
- **M3.2** `EffectivePiConfig` resolver

Coordinate closely with Eng 1 for settings/diagnostics storage and Eng 2 for JSONL transport / PiWorker helpers. If Eng 1/2 are not merged yet, implement isolated modules and tests that can be wired later.

## Required Implementation

### M1.4 — Pi Binary Resolution and Version Diagnostics

Resolve the user-installed `pi` CLI in this order:

1. User-configured absolute Pi binary path in app settings.
2. Existing `process.env.PATH`.
3. Login shell lookup, e.g. `/bin/zsh -lc 'command -v pi'`.
4. Common install locations:
   - `/opt/homebrew/bin/pi`
   - `/usr/local/bin/pi`
   - `~/.local/bin/pi`

Requirements:

- Canonicalize resolved binary with `fs.realpath`.
- Run `pi --version`.
- Return structured diagnostics for success/failure.
- Do not hard-crash if binary is missing.
- Redact secrets from any environment diagnostics.

### M1.5 — Minimal RPC Smoke Test

Implement the low-side-effect startup health check.

Canonical command shape:

```text
pi --mode rpc --no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline
```

Requirements:

- Run in a temporary empty cwd outside the selected project.
- Use the resolved Pi binary and effective environment shape.
- Send `get_state`, validate successful response, then terminate.
- Do not create persisted sessions.
- Do not load project/global resources intentionally.
- Cache result by binary path/version.
- Rerun on app startup, binary path change, diagnostics refresh, or after failed worker spawn.

If Eng 2's JSONL client is not available yet, create a minimal local helper but plan to replace/wire to Eng 2's transport.

### M3.2 — `EffectivePiConfig` Resolver

Implement resolver for:

```ts
interface EffectivePiConfig {
  piBinary: string;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  sessionDir?: string;
  sessionDirSource: "app" | "env" | "globalSettings" | "projectSettings" | "default" | "candidate";
  imageSettings: {
    blockImages: boolean;
    autoResize: boolean;
    sources: {
      blockImages: "app" | "globalSettings" | "projectSettings" | "projectCandidate" | "default";
      autoResize: "app" | "globalSettings" | "projectSettings" | "projectCandidate" | "default";
    };
    candidateWarnings: string[];
  };
  trustOverride?: "approve" | "no-approve";
}
```

Implement exact precedence from architecture:

- App `agentDir` override maps to worker env `PI_CODING_AGENT_DIR`.
- App `sessionDir` override maps to worker CLI arg `--session-dir` and static indexing.
- Inherited `PI_CODING_AGENT_SESSION_DIR` is used only when no app sessionDir exists.
- Default agent dir: `~/.pi/agent`.
- Default session dir: `<agentDir>/sessions`.
- Narrow static settings parser only reads:
  - `sessionDir`
  - `images.blockImages`
  - `images.autoResize`
- Ignore all other settings.
- Parse errors are diagnostics only.
- Project settings are authoritative only under **Trust this run**.
- Under delegated/default trust, project image settings are conservative candidates as described in architecture.

## Acceptance Criteria

Your work is done when:

- Pi binary lookup works across app setting, PATH, shell lookup, and common paths.
- Missing/broken Pi binary returns actionable diagnostics.
- `pi --version` output is captured.
- Minimal smoke test uses the full canonical no-resource/no-session command.
- Smoke test does not create session files.
- `EffectivePiConfig` tests cover app/env/global/project/default precedence.
- Trust-dependent project `sessionDir` and image settings behavior is covered by tests.
- Diagnostics show resolved `piBinary`, `agentDir`, `sessionDir`, source fields, image settings sources, trust override, and redacted env summary.

## Non-Goals

Do not implement yet:

- JSONL transport internals unless Eng 2 is blocked.
- Full PiWorker lifecycle.
- Session scanning implementation beyond config support.
- Project picker UI.
- Attachments/images encoding.
- Trust prompt UI.
- Resource panel.

## Coordination Points

Coordinate with:

- Eng 1 for app settings, diagnostics IPC, and storage location.
- Eng 2 for reusing JSONL transport in the smoke test.
- Eng 5 later for sessionDir candidate UI warnings.
- Eng 6 for smoke-test and config precedence tests.

## Suggested First Steps

1. Verify worktree/branch.
2. Inspect Eng 1/2 module structure if available.
3. Implement binary resolver as an isolated module.
4. Implement version runner.
5. Implement minimal smoke-test service with injectable transport.
6. Implement narrow settings parser and `EffectivePiConfig` resolver.
7. Add unit tests for path/env/settings precedence.
8. Update `docs/project-tracker.md` statuses for owned tasks if workflow includes doc updates.

## PR Summary Template

```text
Summary:
- ...

Implemented:
- M1.4 ...
- M1.5 ...
- M3.2 ...

Platform notes:
- Binary resolution order: ...
- Smoke-test command: ...
- EffectivePiConfig precedence: ...

Testing:
- npm run typecheck
- npm test
- manual smoke test, if run

Known follow-ups:
- ...
```
