# Pi Deck Phased Demo Plan

Status: draft  
Purpose: shift from parallel feature expansion to integrated, demo-able vertical slices.

## 1. Why This Plan Exists

We now have multiple parallel workstreams producing useful pieces:

- Eng 1: Electron/security/app foundation.
- Eng 2: JSONL RPC, fake RPC, single `PiWorker`.
- Eng 3: Pi binary/env/smoke-test/EffectivePiConfig.
- Eng 4: chat shell, fake RPC streaming, composer/abort.
- Eng 5: sessions/sidebar/model/thinking/slash/attachments UI shell.
- Eng 6: QA/automation setup.

The risk is that pieces continue to grow independently without proving they work together. This plan prioritizes stitched demos as integration checkpoints.

## 2. Demo Principles

1. **Demo slices before more surface area.** Prefer a narrow working loop over many disconnected controls.
2. **Fake backend is acceptable early.** Demo Slice 1 can use fake RPC as long as the path is representative of real IPC/backend flow.
3. **Preserve the vertical loop.** Once send → stream → abort works, later merges must not break it.
4. **One source of truth per layer.** Avoid competing App/preload/schema versions across branches.
5. **Every demo has a checklist.** Demo is not accepted only because tests pass; it must be manually launchable.

## 3. Demo Slice 1 — Local Fake-Agent Chat Loop

### Goal

A demo-able local app with one fake Pi worker wired through the real Electron/preload path.

```text
Launch Pi Deck
→ secure renderer loads
→ fake backend session appears
→ user sends prompt
→ assistant response streams
→ user can abort
→ diagnostics/settings remain visible
→ app quit cleans up fake worker
```

### Intended Audience

Internal personal MVP validation. This is not real Pi yet.

### Required Inputs

- Eng 1 merged.
- Eng 2 merged.
- Eng 3 merged.
- Eng 4 approved and merged.

### Scope

In scope:

- Electron app launch.
- Secure preload IPC.
- Fake RPC-backed chat snapshot.
- Prompt send.
- Streaming assistant markdown.
- Abort.
- Basic sidebar/session state display.
- Diagnostics/version/settings visibility.
- Safe markdown rendering.
- Fake worker cleanup on quit.

Out of scope:

- Real Pi binary selection.
- Real project session scan/resume.
- Real model/thinking switching.
- Real slash commands.
- Real attachment send.
- Multi-session concurrency.

### Acceptance Checklist

Automated:

- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm run format` passes.

Manual:

- [ ] `npm run dev` launches Pi Deck.
- [ ] Renderer shows no preload error.
- [ ] Renderer reports no `process` / `require` globals.
- [ ] Fake backend session appears.
- [ ] Sending a multiline prompt appends user message.
- [ ] Assistant response streams visibly.
- [ ] Markdown renders safely.
- [ ] Abort button sends abort and UI recovers.
- [ ] App quit does not intentionally leave fake worker running.
- [ ] Diagnostics/settings panel or badge still works.

### Owner

Integration owner / orchestrator, with Eng 4 on standby for chat fixes.

## 4. Demo Slice 2 — Controls + Chat Integrated Shell

### Goal

Merge Eng 5's session/control UI with Eng 4's working chat loop without breaking Demo Slice 1.

```text
Launch Pi Deck
→ see session sidebar and controls
→ fake chat loop still works
→ model/thinking/slash/attachment UI shells are visible
→ project picker and attachment picker use safe preload/main APIs
```

### Required Inputs

- Demo Slice 1 accepted.
- Eng 5 rebased onto Eng 4/main.

### Scope

In scope:

- Session sidebar visual states.
- Project picker UI and native dialog hook.
- Recent project UI shell.
- Model/thinking controls with fake capabilities.
- Slash command picker with fake `get_commands`-shaped data.
- Attachment picker/chips with `Referenced path` labels.
- Preserve Eng 4 chat/composer streaming.

Out of scope:

- Real session repository.
- Real model/thinking RPC calls.
- Real command discovery.
- Real attachment sending/base64 image processing.

### Acceptance Checklist

- [ ] All Demo Slice 1 checks still pass.
- [ ] Sidebar displays idle/working/waiting/error/queued/etc. states.
- [ ] Red-dot/needs-input state is visually obvious in fake data.
- [ ] Model/thinking controls are visible and non-destructive.
- [ ] Slash picker opens from `/` and excludes TUI-only promises.
- [ ] Attachment chips show `Referenced path` for non-images.
- [ ] Native picker returns metadata/tokens without renderer file reads.
- [ ] Chat prompt streaming still works after controls integration.

### Owner

Eng 5, with Eng 4 available for conflict resolution.

## 5. Demo Slice 3 — Real Pi Health + New Session Smoke

### Goal

Use Eng 3 platform work and Eng 2 RPC transport to prove real Pi can be detected and basic RPC health works.

```text
Launch Pi Deck
→ resolve Pi binary
→ show pi path/version
→ minimal no-resource smoke test passes
→ diagnostics display effective env/config
```

Optional stretch:

```text
Start a real new Pi RPC session in selected cwd
→ get_state/get_messages works
```

### Required Inputs

- Demo Slice 1 accepted.
- Eng 3 integrated.
- Diagnostics UI extended enough to show binary/smoke status.

### Scope

In scope:

- Pi binary resolution.
- `pi --version`.
- Minimal smoke test flags.
- Temp cwd / no session side-effect check.
- EffectivePiConfig display.

Out of scope:

- Resume existing sessions.
- Attachments/images.
- Multi-session concurrency.

### Acceptance Checklist

- [ ] Pi binary path shown or actionable missing-binary diagnostic shown.
- [ ] `pi --version` captured.
- [ ] Minimal smoke test uses full flags:
  `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline`.
- [ ] No persisted sessions created by smoke test.
- [ ] Smoke test result cached by binary/version.
- [ ] Diagnostics redact secrets.

## 6. Demo Slice 4 — Session Listing + Resume Gate

### Goal

Prove core session workflow:

```text
Select project
→ list prior sessions
→ resume session via --session
→ verify canonical session file
```

### Required Inputs

- Demo Slice 3 accepted.
- Session repository implementation.
- Resume hard gate implementation.

### Acceptance Checklist

- [ ] Project picker selects cwd.
- [ ] Authoritative session dir scan is bounded.
- [ ] Prior sessions for project appear.
- [ ] Clicking session launches `pi --mode rpc --session <file>`.
- [ ] `get_state.sessionFile` canonicalizes to requested file.
- [ ] Unsupported version blocks resume with diagnostics.

## 7. Demo Slice 5 — Multi-Session Control Plane

### Goal

Prove the core product promise:

```text
Multiple sessions exist
→ more than one can run in background
→ sidebar state updates
→ current session remains usable
→ steer/follow-up/abort available
```

### Acceptance Checklist

- [ ] Multiple workers can be attached.
- [ ] Switching away does not stop running worker.
- [ ] Background events update correct sidebar row.
- [ ] Max running sessions cap works, default 4, hard cap 20.
- [ ] Steer/follow-up/abort work while active.
- [ ] Local queue behavior is explicit and non-persistent.

## 8. Immediate Next Steps

1. Eng 4 pushes approved branch.
2. Merge Eng 4 to `main`.
3. Run Demo Slice 1 automated checks.
4. Manually run `npm run dev` and complete Demo Slice 1 checklist.
5. Only after Demo Slice 1 passes, ask Eng 5 to rebase onto `main` and integrate controls/sidebar without breaking chat.
6. Eng 6 creates/maintains demo checklist artifacts and regression coverage.

## 9. Team Directive

Until Demo Slice 1 passes:

- Do not start new broad feature branches.
- Prefer integration fixes, cleanup, and demo stabilization.
- Any merge must preserve the fake-agent chat loop.
- Update this plan if demo scope changes.
