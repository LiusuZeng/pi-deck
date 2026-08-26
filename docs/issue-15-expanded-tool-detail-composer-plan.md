# Issue 15 fix plan: expanded tool/subagent detail panels must stay above the composer

## Issue summary

Expanding a tool/subagent detail box near the bottom of the session timeline can leave the newly revealed payload visually underneath the composer. The horizontal scrollbar for the expanded payload can also end up in the composer region, making it hard to use.

## Current code paths

- Timeline/detail rendering: `src/renderer/App.tsx`
  - `ChatTimeline` owns `.timeline-scroll`, bottom-stick auto-scroll, and the timeline rows.
  - `TimelineRow` renders native `<details>` for `thinking` rows and `tool` cards.
- Layout/styling: `src/renderer/styles.css`
  - `.session-content` is a two-row grid: `minmax(0, 1fr)` timeline + `auto` composer.
  - `.timeline-scroll` is the scroll container.
  - `.tool-card pre` is independently scrollable but has no max height.

## Likely root cause

`ChatTimeline` only auto-scrolls when React-observed timeline data changes (`timelineScrollMarker`). Expanding a native `<details>` element is a DOM-only height change, so no React effect recomputes the scroll position. If the card is near the bottom, the newly revealed content grows downward and can be obscured by the composer or leave the payload scrollbar at the bottom edge.

## Proposed fix

1. Add a generic reveal handler for timeline detail expansion.
   - Pass an `onDetailsToggle` callback from `ChatTimeline` to `TimelineRow`.
   - Wire it to both `thinking` and `tool` `<details>` elements so the fix is not tool-card-specific.
   - When a details element opens, schedule measurement after layout (`requestAnimationFrame`).
   - Compute the safe visible bottom as the lesser of `.timeline-scroll` bottom and the composer top minus a small gap.
   - If the opened panel bottom is below that safe bottom, call `scrollBy` on `.timeline-scroll` by the required delta. Also handle the top edge with `block: nearest`/manual scroll math.
   - Do nothing on collapse except allow normal layout; this avoids collapse jumps.

2. Make the behavior robust to dynamic payload size and window resizing.
   - Track the most recently opened details element.
   - Re-run the reveal measurement after resize and, if available, from a `ResizeObserver` on the opened details/payload while it remains open.
   - Keep the existing bottom-stick behavior for streaming/timeline data changes.

3. Harden CSS scroll boundaries.
   - Ensure `.session-content` clips overflow so timeline children cannot visually bleed into the composer grid row.
   - Add `scroll-padding-bottom`/bottom padding to `.timeline-scroll` so programmatic reveal leaves breathing room above the composer.
   - Give `.tool-card pre` a responsive `max-height` with `overflow: auto` so very large outputs keep their own scrollbars visible instead of making the card unbounded.

4. Add deterministic regression coverage.
   - Extend fake RPC or use an existing fake-real prompt scenario to emit a tall and wide tool/subagent detail payload.
   - Add a Playwright Electron test in `e2e/pi-deck.e2e.ts` that:
     1. launches Pi Deck in fake-real mode with a small window height;
     2. creates/opens a session and emits a tool card near the lower viewport;
     3. expands the card;
     4. asserts the expanded payload bottom is above the composer top / timeline visible bottom;
     5. asserts the payload scrollbar area remains visible and usable;
     6. collapses/re-expands and repeats after a resize.

## Validation commands

Targeted during development:

```bash
npm run format
npm run typecheck
npm test -- src/renderer/App.test.ts
npm run build
npx playwright test -c e2e/playwright.config.ts e2e/pi-deck.e2e.ts -g "expanded tool detail"
```

Before handoff:

```bash
npm run verify:ci
```

## Acceptance mapping

- Expanding near the bottom never places content under the composer: reveal handler + safe composer-aware bottom.
- Expanded panel can be fully scrolled into view: manual scroll delta and scroll padding.
- Payload scrollbars remain usable: `pre` max-height/overflow plus reveal-to-bottom assertions.
- Collapse/re-expand is stable: only scroll on open and measure after layout.
- Window resize works: resize/observer re-runs the reveal logic for the open panel.
