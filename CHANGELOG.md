# Changelog

All notable changes to Pi Deck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.4] - 2026-08-16

### Fixed

- Allowed parallel multitasking to be enabled in a new draft session before its
  first prompt, then applied that mode during parent-worker creation so the
  first prompt can delegate work.
- Preserved the selected draft mode as its session becomes runtime-backed and
  persisted it with the newly created Pi session.

### Tests

- Updated clean-profile Electron coverage to prove that a first prompt can
  delegate after parallel multitasking is enabled in a draft.

## [0.5.3] - 2026-08-16

### Fixed

- Kept the parallel multitasking control visible in a new draft session, with a
  clear explanation that Pi must first be started with a prompt.
- Improved the control's empty-state tooltip and accessible label so users can
  discover and enable parallel multitasking without guessing.

### Tests

- Added clean-profile Electron coverage for multitasking control visibility and
  its pre-runtime guidance.

## [0.5.2] - 2026-08-16

### Fixed

- Prevented sidebar and archived-session lists, action menus, attachment rows,
  chat messages, composer controls, and model choices from clipping, overlapping,
  or overflowing at supported window sizes.
- Made workflow input and compact inspector overlays keyboard-safe, and kept
  workflow builder, graph cards, route labels, run output, and human controls
  within their intended bounds.
- Restored initial keyboard focus for portalled menus, including Appearance.
- Enlarged Work Inbox close and filter hit targets without changing visual density.

### Tests

- Added renderer and Electron regressions for long content, responsive layout,
  menu placement and focus, workflow graph geometry, modal focus handling, and
  control hit areas.

## [0.5.1] - 2026-08-16

### Fixed

- Restored workflow-builder interactivity after editing workflow and step names.
- Prevented stale workflow refreshes from blocking newly started live-run monitoring.
- Restored visible delegated-task status snapshots when live multitask events are missed.
- Serialized concurrent fan-out occurrence completions so no child completion is lost.

### Tests

- Added real-Pi UI coverage for workflow editing, live monitoring, and delegated task status.
- Added a deterministic regression for concurrent fan-out completion.

## [0.5.0] - 2026-08-15

Major feature release adding Agent Workflows and interactive multitasking.

### Added

- Added persistent, role-based Agent Workflows with Workers, Deciders,
  Orchestrators, Human checkpoints, graph authoring, canonical JSON, scoped
  templates, live run monitoring, retries, and restart recovery.
- Added accessible static and live execution graphs with deterministic layout,
  keyboard traversal, text alternatives, workflow-state updates, input-source
  annotations, fan-out and loop progress, and Pi-session drill-in.
- Added explicit, persisted workflow input-source bindings with deterministic
  retry, loop, and fan-out lineage resolution.
- Added interactive multitasking: a parent Pi session can delegate isolated
  child tasks through an authenticated local bridge, monitor their status, and
  safely resume persisted delegated work.
- Added real-Pi, workflow, multitask, recovery, concurrency, graph
  accessibility, and restart end-to-end coverage.

### Changed

- Workflow nodes now use stable opaque UUIDs rather than mutable display names;
  existing persisted workflow data is migrated with recovery backups.
- Agent Workflow scope selection now supports every active workspace while
  preserving global and previously saved scopes.

### Fixed

- Restored persisted real-Pi message content correctly after session restart.
- Resolved managed-runtime project lookup for delegated real-Pi child workers.
- Prevented cancelled or stale workflow occurrences from being resurrected
  during restart/retry races.

## [0.4.0] - 2026-08-03

Feature release adding a unified Work inbox for parallel session management.

### Added

- Added a global Work inbox covering all workspaces and workspace-scoped views.
- Added tag-based workspace and status filtering for needs attention, failed,
  pending, in progress, completed, and idle sessions.
- Added idle saved-session rows so existing sessions remain discoverable from
  the inbox without increasing actionable counts.

### Changed

- Renamed the sidebar entry to Work inbox and compacted workspace actions into
  overflow menus to keep the workspace tree readable.

### Fixed

- Starting a new session now exits the Work inbox and immediately shows the
  new session composer.

### Tests

- Added domain, renderer, and Electron end-to-end coverage for scoped inbox
  filtering, idle sessions, draft exclusion, and new-session navigation.

## [0.3.0] - 2026-08-03

Feature release introducing grouped workspaces and a more resilient,
keyboard-accessible session management experience.

### Added

- Added directory-independent workspaces for grouping related Pi sessions by topic.
- Added sidebar workspace navigation with session browsing, workspace creation
  and renaming, session add/move/remove/delete actions, and workspace/session
  archive and restore flows.
- Added a default workspace for ungrouped sessions and managed runtime context
  under Pi Deck's metadata directory.
- Added active-workspace, keyboard-navigation, and error-announcement
  accessibility coverage.

### Changed

- Made the sidebar the primary workspace navigator and clarified the active
  workspace with a compact checkmark indicator.
- Kept workspace membership independent from Pi JSONL files and working folders, including across relaunches.
- Made runtime shutdown internal to session lifecycle management rather than a user-facing workspace action.

### Fixed

- Prevented sandboxed macOS GUI launches from surfacing avoidable Electron crash dialogs during development.
- Preserved workspace and session metadata when saved-session titles or archived state refresh.
- Made slash-command and model/thinking menus keyboard accessible with reliable focus restoration.
- Announced composer, extension, timeline, and provider errors to assistive technologies.

### Tests

- Added workspace lifecycle, relaunch, archive/restore, membership, and directory-independent E2E coverage.
- Added keyboard accessibility regressions for slash commands, menus, focus restoration, and active-workspace state.

## [0.2.0] - 2026-08-01

Feature release adding a persistent, accessible appearance system across the
Electron shell and complete Pi Deck interface.

### Added

- Added a persisted System, Light, and Dark appearance preference that applies
  through Electron before the first window paint and follows live macOS changes
  in System mode.
- Added a keyboard-accessible header appearance menu and semantic dark colors
  for the complete chat, session, composer, tool, diagnostic, attachment, and
  extension-request interface.
- Added settings migration, native-theme helper, menu-navigation, and Electron
  persistence/relaunch coverage for appearance changes.

## [0.1.1] - 2026-07-31

Patch release aligning Pi Deck with production Pi RPC lifecycle events and
hardening project, worker, attachment, and session metadata boundaries.

### Fixed

- Correctly handled production-shaped provider errors, `agent_end` retry state,
  retry completion/failure, final retry messages, and user cancellation during
  retry backoff without exposing idle controls while Pi is still busy.
- Reclaimed workers, runtime maps, locks, and capacity when initial snapshots or
  draft model/thinking setup fail, while preserving accepted prompts.
- Preserved session titles, transcripts, identity, and cached metadata when
  model or thinking changes return metadata-only snapshots, including Pi's
  `sessionName` field.
- Preserved composer text and attachment authority across failed and partial
  session deletion, including failures after an attached runtime has closed.
- Removed a full-suite race in fake worker terminal-event coverage.

### Security

- Treated renderer-supplied project IDs as opaque `ProjectStore` references and
  revalidated canonical selected roots before model discovery, scans, worker
  creation, resume, and deletion.
- Replaced unbounded attachment payload retention with a count- and byte-bounded,
  expiring store that consumes tokens only after successful delivery and
  releases them on removal, owner teardown, runtime exit, deletion, and reset.
- Separated one-use attachment owner generations from stable session IDs so
  late picker results cannot resurrect discarded authority while legitimate
  project navigation, renderer reload, and session resume remain usable.

### Tests

- Added production-shaped fake RPC fixtures and focused unit/Electron E2E
  regressions for retry/abort behavior, project authorization, worker cleanup,
  metadata refresh, attachment lifecycle, and transactional deletion failures.

## [0.1.0] - 2026-07-30

Initial source release of Pi Deck, a local macOS Electron control plane for Pi
coding-agent sessions.

### Added

- Real and deterministic fake Pi backends, with an isolated `pi --mode rpc`
  worker and event stream for each attached session.
- Project and session management: native folder selection, recent projects,
  project-scoped session discovery, lazy session drafts, resume, refresh,
  search, runtime close, and safe session deletion.
- Multi-session workflows with configurable worker capacity, background workers
  that remain attached across project navigation, attention-first ordering, and
  duplicate-resume protection.
- Streaming chat with safe Markdown, collapsible thinking, tool lifecycle cards,
  elapsed activity status, abort, steer, queued follow-up, retry, and runtime
  recovery controls.
- Per-session model and thinking controls, model capability discovery, Pi slash
  command discovery, and token, context, cache, and cost statistics when Pi
  reports them.
- Native file picking, drag and drop, pasted images, resumed image previews, and
  explicit project-relative path references for non-image files.
- PNG, JPEG, WebP, and GIF inputs with model/settings gates, content sniffing,
  20 MB and 50-megapixel safety limits, and optional resizing to a 2000 x 2000
  bounding box.
- Desktop responses for Pi extension `select`, `confirm`, `input`, and `editor`
  requests, including background attention state and stale-response rejection.
- Production-style and development launchers, stale-build detection, a fake RPC
  harness, unit/integration coverage, Electron end-to-end tests, and opt-in real
  Pi smoke tests.

### Changed

- The chat workspace and session sidebar use compact, shared controls with
  responsive layouts, per-session composer drafts, and keyboard-accessible
  session actions.
- Existing build output launches without an implicit rebuild; explicit build
  commands now produce and validate a build manifest.
- Startup creates a lightweight draft shell and defers Pi worker creation until
  the first prompt or an explicit session resume.
- Pi launch configuration, project-session persistence, runtime status polling,
  JSONL framing, and renderer stream updates are cached, bounded, batched, or
  coalesced to reduce startup and streaming overhead.

### Fixed

- Preserved the correct session state and event routing during project switches,
  background activity, asynchronous actions, stale renderer requests, and
  missed completion events.
- Surfaced startup, worker-exit, provider, usage-limit, resume, and attachment
  failures without silently falling back to a fake or idle state.
- Prevented duplicate session resumes, stale warm workers, worker-capacity races,
  and stale runtime/session locks.
- Validated recent project folders and saved Pi sessions before navigation or
  resume, and kept deletion authority scoped to canonical, indexed session
  files.
- Corrected attachment MIME detection, file-path references, image-policy
  enforcement, resumed image previews, and deletion of attached or resumed
  sessions.
- Improved icon and session-control accessibility and removed overlapping
  sidebar actions.

### Security

- Sandboxed the renderer with context isolation, Node integration disabled, a
  strict production Content Security Policy, and validated typed IPC at the
  preload/main boundary.
- Kept filesystem and subprocess authority in Electron main, using opaque
  attachment tokens instead of renderer-controlled read paths.
- Added canonical path, extension, header, project, and session-directory checks
  before session resume or deletion; deleted files are moved to Trash when
  possible.
- Restricted external links to approved protocols and added image
  signature/dimension validation before decoding or forwarding data to Pi.
- Bounded JSONL records, buffered transport data, and session-directory scans to
  limit malformed-input and resource-exhaustion risk.

### Requirements

- macOS.
- Node.js 22.12 or newer and npm.
- A working Pi executable with RPC-mode support and provider authentication for
  real prompts.

### Known limitations

- This release runs from source; it does not include a packaged, signed, or
  notarized macOS installer.
- Worker capacity is enforced, but starts are blocked rather than queued when
  capacity is reached.
- Full settings, diagnostics, project-trust, and resource-inspection screens are
  not yet available; advanced configuration remains environment- or file-driven.
- Extension interfaces beyond `select`, `confirm`, `input`, and `editor` do not
  have bespoke desktop controls.
- Tool cards do not yet provide rich diffs, output search, or advanced filtering.
- Concurrent external writes to the same Pi session are unsupported.
- Pi Deck cannot reconnect to an RPC subprocess after an Electron main-process
  crash; persisted sessions can be reopened, but unsaved partial stream text may
  be lost.

[Unreleased]: https://github.com/LiusuZeng/pi-deck/compare/v0.5.4...HEAD
[0.5.4]: https://github.com/LiusuZeng/pi-deck/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/LiusuZeng/pi-deck/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/LiusuZeng/pi-deck/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/LiusuZeng/pi-deck/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/LiusuZeng/pi-deck/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/LiusuZeng/pi-deck/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LiusuZeng/pi-deck/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LiusuZeng/pi-deck/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/LiusuZeng/pi-deck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/LiusuZeng/pi-deck/releases/tag/v0.1.0
