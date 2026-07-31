# Changelog

All notable changes to Pi Deck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/LiusuZeng/pi-deck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LiusuZeng/pi-deck/releases/tag/v0.1.0
