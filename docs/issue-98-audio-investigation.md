# Issue #98 audio investigation

## Scope and conclusion

Pi Deck owns a Web Audio session-cue path, so this change prevents that path from
being initialized by ordinary pointer/keyboard input when both cues are disabled.
It also retires a JavaScript-failed context before a later cue can replace it.

This is **not** evidence of a native Electron, Chromium, or CoreAudio root cause.
The reported `MixableOutputStream: Error during independent playback` diagnostic
was not reproduced in the available environment, and Chromium stderr is neither
filtered nor suppressed.

## 2026-09-13 macOS source-run A/B

Environment:

- Pi Deck checkout at `7cbe1fb` plus this working-tree patch.
- Electron `42.5.0` (the repository-pinned version).
- macOS x86_64; raw Electron runtime and the repository's rebranded runtime.
- Default output: `DELL S2721D` HDMI, 2 channels, 48 kHz. Built-in MacBook Pro
  speakers, DisplayLink USB outputs, Teams/Zoom virtual devices were enumerated,
  but were not selected/tested. No Bluetooth output was available for the run.

The repository has no distributable app/DMG packaging pipeline. Its “built app”
is a source-run `dist/` layout. The closest available bundle A/B was:

1. raw `node_modules/electron/dist/Electron.app/.../Electron`;
2. `node_modules/electron/dist/Pi Deck.app/.../Electron`, the source-run clone
   produced by `preparePiDeckElectronExecutable()`.

For each side, a fresh fake-backend profile was launched, renderer readiness was
awaited, one Playwright mouse click and one key press were sent, then stderr was
captured for 1.5 seconds. Both default-enabled and persisted-both-disabled
profiles were tested. Results were exact:

| Runtime | Preferences | `MixableOutputStream` | Captured stderr |
| --- | --- | --- | --- |
| raw Electron.app | enabled | no | none |
| raw Electron.app | both disabled | no | none |
| rebranded Pi Deck.app | enabled | no | none |
| rebranded Pi Deck.app | both disabled | no | none |

Thus this environment cannot establish launch identity, Electron `42.5.0`, or
Pi Deck session sounds as the native-error cause. It only establishes that the
error did not occur under this HDMI route and short first-gesture probe.

## 2026-09-13 built-app follow-up matrix

Environment and commands:

- Commit `08f4db0710b1`; macOS `26.5.2` (`25F84`), `x86_64`; Node `v26.0.0`;
  repository-pinned Electron `42.5.0`.
- Default output was `DELL S2721D`, HDMI, two channels at 48 kHz.
- `npm run build`, then an ad-hoc Playwright driver launched
  `node_modules/electron/dist/Pi Deck.app/Contents/MacOS/Electron` with the
  built `dist/main/main.js`, `PI_DECK_BACKEND=fake`, a fresh profile, and
  `PI_DECK_E2E_HIDE_WINDOWS=1`.
- For each profile, the driver wrapped the renderer `AudioContext` constructor
  before the first real mouse click and `Tab` key press, then captured the
  Electron child-process stderr without filtering until exit. For the enabled
  profile it also clicked both in-app Play buttons. This is automation evidence
  that the cue requests were issued, **not** a human audibility result.

| Runtime | Preferences before first gesture | Result | Unfiltered captured stderr |
| --- | --- | --- | --- |
| rebranded `Pi Deck.app` | both disabled | 0 `AudioContext` constructions after mouse + key; no cue requested | `<empty>` |
| rebranded `Pi Deck.app` | both enabled | 1 `AudioContext` construction after mouse + key; Needs attention and Completed Play buttons clicked | `<empty>` |

This is a source-run branded Electron bundle, not a signed/notarized packaged
application. The selected HDMI device was not changed during the run; no
Bluetooth device was available. The driver cannot establish behavior on
built-in, Bluetooth, or other external routes, nor behavior during a live
output-device switch.

## Diagnostics boundary

`SessionSoundPlayerOptions.onDiagnostic` is an optional, non-logging callback
for tests and diagnostic-build injection only. It reports bounded lifecycle
state (context creation/resume, cue scheduling/failure, invalidation, and
retirement); callback failures are ignored. Pi Deck currently has no bounded
production diagnostics surface for these events, so this branch intentionally
does not wire it to production logging or add console/stderr noise. A future
production integration must first define retention, redaction, rate bounds, and
an operator-visible consumer.

## Scope verification

The task-fanout prompt-sizing concern is pre-existing and out of scope for
#98. On this branch, `git diff --exit-code main --
src/main/multitask/taskSessionPlanner.ts
src/main/multitask/taskSessionPlanner.test.ts` exits `0`; both planner blobs
are `8c5adbc4f895b761a5e7c4bf7a2dcd4196b7438e`. The #98 range changes only
this investigation, session-sound renderer code/tests, and the audio E2E.

## Remaining manual matrix

Repeat against the issue reporter's terminal built-app launch on the final commit:

1. enabled/disabled before first interaction, then no interaction vs exactly one
   pointer or key gesture;
2. one Needs attention cue and one Completed cue, with stderr timestamps;
3. built-in speakers, Bluetooth/external route, and default-output-device switch
   while the app is open;
4. pre-session-sound commit `9dbb5e8` vs current code; and
5. Electron `42.5.0` vs a deliberately selected compatible newer 42.x patch.

Record the selected device, Electron version, launch command, audio audibility,
and unfiltered stderr for every cell. Only a repeated A/B result should be used
to attribute a native failure upstream or to a Pi Deck code path.
