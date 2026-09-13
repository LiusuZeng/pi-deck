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
