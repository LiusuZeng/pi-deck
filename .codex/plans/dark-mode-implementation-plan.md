# Dark Mode Implementation Plan

Status: Implementation integrated after parallel worktree development and
independent static review. Automated and visual verification remain pending
because the current execution environment does not provide Node.js or npm.
This document remains the integration contract and acceptance checklist.

Implementation commits integrated into `main`:

- `d4dbcd5` — persisted setting and Electron native-theme foundation
- `70b7f69` — accessible renderer appearance control
- `1d42d98` — semantic light/dark renderer palette

The primary integration pass additionally removes the temporary renderer type
bridge, adds keyboard navigation and E2E persistence/relaunch coverage, restores
the exact historical light canvas/action colors, and fixes loading/empty-state
dark contrast misses found by review agents.

## Recommendation

Add a three-state appearance setting:

- `system` (default)
- `light`
- `dark`

This follows macOS conventions, uses Pi Deck's existing persisted settings path, and allows the Electron main process to select the effective theme before the window appears.

## Scope

In scope:

- A persisted application appearance preference with System, Light, and Dark choices.
- Native Electron/Chromium theme synchronization before the first window paint.
- A renderer control for changing the preference at runtime.
- Full light/dark color coverage for the existing UI.
- Unit, component, and Electron E2E coverage for the preference lifecycle.
- Documentation of the setting in the repository-local plan and, if needed,
  the user-facing README configuration section.

Out of scope:

- User-authored themes or arbitrary color customization.
- Per-project or per-session appearance settings.
- Importing Pi terminal themes into Pi Deck.
- Changing typography, spacing, layout, or component structure except where a
  compact appearance control requires it.
- Re-theming images or attachment previews.
- Introducing a general settings screen solely for this feature.

## Locked implementation decisions

These decisions should not be reopened during implementation unless a concrete
technical blocker is found:

1. The persisted field is `AppSettings.theme` with the exact values `system`,
   `light`, and `dark`.
2. `system` is the default for new and existing installations.
3. `SettingsStore` remains the single persisted source of truth. Do not add a
   second localStorage theme preference.
4. Electron `nativeTheme.themeSource` owns the effective preference. Renderer
   CSS consumes `prefers-color-scheme`; do not maintain a duplicate
   `data-theme` state machine.
5. The main process applies the saved preference before creating the first
   BrowserWindow to avoid an incorrect first paint.
6. The appearance control lives in the persistent top bar and uses radio menu
   semantics for the three mutually exclusive values.
7. Theme switching is a global application setting and must not create, close,
   restart, or reconfigure a Pi worker.
8. The existing light appearance is the visual-regression baseline. Tokenizing
   it must not deliberately redesign it.
9. Dark mode uses authored semantic colors. It must not be implemented with a
   global inversion/filter.
10. Existing status colors may preserve their hue identity, but each status
    must receive theme-appropriate text, background, and border values with
    sufficient contrast.

## Parallel ownership and integration order

Work is divided to minimize overlapping files:

| Slice | Branch | Owned files | Depends on |
| --- | --- | --- | --- |
| Settings/native foundation | `codex/dark-mode-foundation` | shared settings schema/tests, settings store/tests, Electron main theme application | none |
| Renderer control | `codex/dark-mode-renderer` | `App.tsx`, renderer UI icons/menu/tests | expected `AppSettings.theme` contract |
| CSS theme | `codex/dark-mode-styles` | `styles.css` | effective `prefers-color-scheme` supplied by Electron |

Integrate in this order:

1. Settings/native foundation.
2. Renderer control, removing any temporary type bridge used because the
   isolated renderer branch did not yet contain `AppSettings.theme`.
3. CSS theme.
4. Integration-only E2E fixture changes, documentation, and cleanup.
5. Full verification.

Do not merge branches blindly. Review each diff, then cherry-pick or reproduce
the commit in the primary worktree so unrelated branch changes are not pulled
in accidentally.

## Repository findings

- Electron loads `SettingsStore` before calling `createMainWindow()`, so it can configure the initial native theme without waiting for React bootstrap.
- `AppSettings` is already persisted, validated with Zod, exposed through validated IPC, and returned in `AppBootstrapState`.
- The renderer receives settings during bootstrap but does not currently expose a general settings or appearance control.
- The header's right side is always available, including when the session sidebar is hidden, and is the best location for a compact appearance menu.
- `styles.css` begins with semantic color variables, but the later "Chat-first layout" section overrides those variables and adds many fixed light colors. Changing only the existing variables would leave the top bar, sidebar states, composer, message bubbles, popovers, alerts, and code/tool surfaces inconsistent.
- Existing E2E coverage contains exact light-color assertions, so those tests must explicitly select light mode once the default becomes `system`.

## Implementation plan

### 1. Add the persisted appearance preference

- Add `theme: "system" | "light" | "dark"` to the shared `AppSettings` schema.
- Default it to `system` in the Zod schema and `defaultAppSettings`.
- Preserve backward compatibility so existing `settings.json` files acquire the new default instead of being treated as corrupt.
- Reuse the existing `settings.update()` IPC path; do not add a separate theme IPC channel.
- Prefer exporting a reusable `themePreferenceSchema` and inferred
  `ThemePreference` type if it removes duplicated unions across main and
  renderer code. Do not hand-maintain multiple slightly different unions.
- Keep `appSettingsPatchSchema` strict so misspelled or unknown theme values are
  rejected at the IPC boundary.
- Verify both parsing paths:
  - `appSettingsSchema.parse({})` yields `theme: "system"`.
  - a settings object created before this field existed is merged with the new
    default and is not backed up as corrupt.

Primary files:

- `src/shared/ipcSchemas.ts`
- `src/shared/types.ts` (the inferred type should update automatically)
- `src/main/settings/settingsStore.ts`

### 2. Apply the effective theme before showing the window

- Map the saved preference directly to Electron's `nativeTheme.themeSource`.
- Apply it after settings load and before `createMainWindow()`.
- Reapply it after a successful settings update that changes the theme.
- Give `BrowserWindow` an effective light/dark background color to prevent a white launch flash.
- Update the window background if the effective system appearance changes while `theme` is `system`.
- Let Chromium's `prefers-color-scheme` reflect Electron's effective theme so CSS handles explicit preferences and live system changes through one mechanism.
- Isolate the mapping/application logic in a small helper rather than scattering
  direct `nativeTheme` mutations across bootstrap, IPC, and window code.
- Startup sequence must be:
  1. `app.whenReady()` resolves.
  2. `SettingsStore` loads and validates settings.
  3. `nativeTheme.themeSource` is set from the saved preference.
  4. the BrowserWindow is constructed with the effective background color.
  5. renderer content is loaded.
- Runtime update sequence must be:
  1. validate the patch at IPC entry;
  2. persist it successfully;
  3. apply `nativeTheme.themeSource` if the returned theme changed;
  4. update the existing window background;
  5. return the authoritative updated settings object.
- If persistence fails, do not change the effective native theme.
- Attach at most one `nativeTheme.updated` listener. Ensure window recreation on
  macOS does not accumulate duplicate listeners.
- Use stable canvas colors shared conceptually with the CSS palette for the
  pre-render window background. Exact equality is preferred, but the hard
  requirement is no bright flash in dark mode.
- Do not add a renderer IPC event for system appearance changes: Chromium media
  queries should update automatically when `nativeTheme` changes.

Primary file:

- `src/main/main.ts`

### 3. Add an accessible appearance control

- Add a compact header menu with System, Light, and Dark radio-style options.
- Use the existing menu/button primitives and canonical Lucide icon layer.
- Add appropriate Sun, Moon, and Monitor icons to the shared icon module.
- Initialize the selected preference from `bootstrap.settings.theme`.
- Persist changes through `window.piDeck.settings.update()`.
- On failure, retain or restore the previous value and report the failure through the existing status-message mechanism.
- Provide keyboard navigation, visible focus, checked state, and descriptive accessible labels.
- Add renderer state with these responsibilities only:
  - current persisted preference;
  - whether a theme update is pending.
  The effective light/dark result remains owned by Electron/CSS.
- Initialize the preference to `system` for the loading shell, then replace it
  with `bootstrap.settings.theme` in the successful bootstrap path.
- On selection:
  1. ignore a selection equal to the current value;
  2. disable or guard duplicate requests while one update is pending;
  3. call `settings.update({ theme: nextTheme })`;
  4. commit the value returned by the main process, not merely the requested
     value;
  5. update any local ready-state settings snapshot so it does not become stale;
  6. announce success through concise status text;
  7. on rejection, preserve the previous value and announce the error;
  8. clear pending state in `finally`.
- The trigger label should communicate both purpose and current preference, for
  example `Appearance: System`.
- Menu items must use `role="menuitemradio"` and `aria-checked`.
- The selected option must have a visible non-color indicator such as a check.
- Opening the menu should focus a menu item; Escape should close it and restore
  trigger focus. If the shared Menu primitive is enhanced for arrow navigation,
  add component tests and preserve its current callers.
- Use Monitor/System, Sun/Light, and Moon/Dark icons. Keep icon imports flowing
  through `components/ui/icons.ts`.
- At widths where header space is constrained, keep the control icon-only with
  its accessible label/tooltip rather than adding a permanent text label.

Primary files:

- `src/renderer/App.tsx`
- `src/renderer/components/ui/icons.ts`
- `src/renderer/components/ui/Menu.tsx` only if its current API cannot express the desired trigger or radio semantics cleanly

### 4. Convert the stylesheet to semantic theme tokens

- Consolidate the competing root variable blocks into one light palette.
- Add a dark palette under `@media (prefers-color-scheme: dark)`.
- Set `color-scheme` appropriately so inputs, selects, scrollbars, and other native controls match.
- Add semantic variables for currently hard-coded surfaces and states:
  - canvas, workspace, sidebar, and elevated surfaces
  - translucent top bar and popover backgrounds
  - hover, active, selected, disabled, and focus states
  - user bubbles, composer, thinking sections, tool cards, and code blocks
  - information, warning, error, success, waiting, and working states
  - borders, shadows, overlays, inverse text, and placeholders
- Replace fixed light colors throughout the entire stylesheet, including the later Chat-first overrides.
- Preserve layout, spacing, and typography while changing color implementation.
- Keep code and tool-output surfaces intentionally distinct rather than applying a mechanical color inversion.
- Treat the final Chat-first rules as the active visual source of truth. After
  tokenization, there must be only one authoritative light token definition;
  later layout sections may consume tokens but must not redefine the palette.
- Minimum token families:
  - `--color-canvas`, `--color-surface`, `--color-surface-subtle`,
    `--color-surface-muted`, `--color-surface-elevated`;
  - `--color-text`, `--color-text-strong`, `--color-text-muted`,
    `--color-text-subtle`, `--color-on-accent`, `--color-inverse`;
  - `--color-border`, `--color-border-strong`;
  - `--color-hover`, `--color-active`, `--color-selected`;
  - `--color-accent`, `--color-accent-hover`, `--color-focus`;
  - semantic status foreground/surface/border tokens for danger, warning, info,
    success, and working;
  - code surface/text and tooltip surface/text;
  - top-bar/overlay surfaces and light/dark shadow tokens.
- Use alpha colors only when transparency is visually necessary. A translucent
  white value such as `rgb(255 255 255 / 94%)` must become a semantic overlay
  token with a dark counterpart.
- Audit these specific surfaces after replacement:
  - root/body/app shell and workspace;
  - sidebar, search, active row, hovered delete affordance, active-work group;
  - top bar, project switcher, usage panel, status toast;
  - starter heading and transcript loading state;
  - assistant/user messages, Markdown links, inline code, preformatted code,
    blockquotes, and tables if present;
  - thinking rows and every tool-card state;
  - retry/error/diagnostic/extension UI cards;
  - composer, attachments, slash menu, model/thinking menus, send/abort buttons;
  - generic Button, IconButton, Menu, Tooltip, focus rings, and disabled states.
- Remaining literal colors are allowed only when documented by purpose, such as
  stable status-dot hues, an image-independent brand mark, or deliberate code
  syntax/inverse colors. Run a final literal-color search and inspect every
  remaining match.

Primary file:

- `src/renderer/styles.css`

### 5. Add automated coverage

Unit tests:

- Verify the schema defaults theme to `system`.
- Verify invalid theme values are rejected.
- Verify `SettingsStore` persists each valid preference.
- Verify an older settings file without `theme` loads successfully with the default.

E2E tests:

- Explicitly pin existing exact-color tests to light mode.
- Launch with a persisted dark preference and check representative computed styles.
- Switch among System, Light, and Dark.
- Verify the selected preference survives an application relaunch.
- Verify System responds to an effective system appearance change.
- Verify keyboard access and radio/checked semantics for the appearance menu.
- Capture light and dark screenshots at the existing 900 x 600 viewport.
- Give E2E launches isolated user-data directories whenever they persist theme
  settings so one test cannot influence another.
- Add a helper that writes a complete valid `settings.json` fixture with an
  explicit theme; do not rely on the host machine's current appearance for
  exact-color assertions.
- For runtime switching, assert all three layers:
  - the selected menu item/accessible state;
  - representative computed colors or `color-scheme` in the renderer;
  - the persisted settings value after relaunch.
- Cover persistence failure only if it can be injected deterministically
  without weakening production security boundaries. Otherwise cover the
  renderer error/revert handler with a focused component/helper test.

Primary tests:

- `src/shared/ipcSchemas.test.ts`
- `src/main/settings/settingsStore.test.ts`
- `src/main/ipc/registerIpc.test.ts` if the main-process theme side effect is factored into the IPC path
- `e2e/pi-deck.e2e.ts`

Required commands during implementation:

```bash
npm run typecheck
npm test
npm run format
npm run test:e2e -- --grep "appearance|icon controls"
```

If the focused E2E invocation is not accepted by the current npm/Playwright
argument forwarding, run the equivalent direct Playwright command or the full
`npm run test:e2e` suite and record which was used.

### 6. Perform a visual and accessibility pass

Exercise both themes across:

- starter screen and populated transcript
- Markdown text, links, blockquotes, inline code, and code blocks
- running, successful, failed, and collapsed tool cards
- diagnostics, retry states, and extension-input cards
- attachment chips, configuration menus, project switcher, tooltip, and usage panel
- hover, focus-visible, pressed, selected, and disabled controls
- sidebar-visible and sidebar-hidden layouts
- responsive breakpoints around 760 px and 560 px

Check WCAG AA contrast for normal text and controls. Confirm that status meaning does not depend on color alone.

## Integration review checklist

Before verification:

- [x] Review `git diff` for each branch and ensure it stayed within ownership.
- [x] Remove renderer temporary types/casts made only because its worktree did
      not have the shared settings contract.
- [x] Confirm there is exactly one persisted source of truth for theme.
- [x] Confirm theme updates do not clear, restart, or allocate Pi workers.
- [x] Confirm main-process listener cleanup/lifetime is bounded.
- [x] Confirm the loading/error shells inherit the effective theme.
- [x] Confirm no light-only root override appears after the dark token block.
- [x] Confirm exact-color E2E tests are explicitly pinned to a theme.
- [x] Confirm no generated screenshots, build output, user-data fixtures, or
      worktree-only artifacts are included in the final diff.

Verification order:

1. Inspect the integrated diff and remaining literal colors.
2. Run Prettier on changed files, then `npm run format`.
3. Run `npm run typecheck`.
4. Run focused unit/component tests while iterating.
5. Run the complete `npm test` suite.
6. Build and run focused appearance E2E tests.
7. Run the full E2E suite if time/environment permits.
8. Manually inspect both themes at 1200 x 800, 900 x 600, 760 px, and 560 px.
9. Check restart persistence and live System-mode switching on macOS.

## Acceptance criteria

- First launch follows the current macOS appearance.
- Explicit Light or Dark choices persist across restarts.
- System mode responds live when macOS appearance changes.
- The app does not show a white flash when launching in effective dark mode.
- Every interactive, transient, and status surface remains readable and distinguishable in both themes.
- Theme changes do not affect sessions, workers, drafts, attachments, or project state.
- Theme controls work with mouse and keyboard and expose their selected state to assistive technology.
- Existing light-mode layout and behavior remain unchanged.
- Invalid persisted theme values follow the repository's existing corrupt
  settings recovery behavior and are surfaced through diagnostics.
- Existing settings files without a theme migrate implicitly to `system`
  without data loss or a corrupt-settings backup.
- Automated tests are deterministic regardless of the host/CI appearance.

## Definition of done

The feature is done only when implementation, automated tests, and manual
appearance checks all pass. A dark canvas with unresolved light controls does
not count as partial completion: all transient surfaces and interaction states
listed above are part of the feature.

## Main implementation risk

The principal risk is incomplete tokenization. The stylesheet currently has semantic variables and a later override layer with many literal light colors. A successful implementation should replace those literals systematically rather than adding a small dark override block that only covers the page background and primary text.
