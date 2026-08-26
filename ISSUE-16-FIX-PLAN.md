# Issue 16 Fix Plan: Stable Work Card Ordering

## Implementation status

Implemented in this worktree. Validation completed:

- `npm test -- activityInbox`
- `npm test`
- `npm run typecheck`
- `npm run format`
- `npm run test:e2e -- e2e/pi-deck.e2e.ts -g "Unified Work keeps in-progress card order stable during runtime updates"`

## Issue summary

Work cards currently reorder inside each status group whenever `updatedAtMs` changes. In active supervision, ordinary runtime/progress updates refresh `updatedAtMs`, so two `In progress` sessions can repeatedly swap positions even though neither changed status.

Issue: https://github.com/LiusuZeng/pi-deck/issues/16

## Relevant code

- `src/renderer/activityInbox.ts`
  - `buildActivityInbox()` groups items by status, then sorts every group by `right.updatedAtMs - left.updatedAtMs`.
- `src/renderer/components/ActivityInbox.tsx`
  - The component rebuilds scoped `groups` and sorts each status group by `updatedAtMs` again.
- Tests to extend:
  - `src/renderer/activityInbox.test.ts`
  - `src/renderer/components/ActivityInbox.test.tsx`

## Proposed approach

Separate recency display from layout ordering.

1. Stop using `updatedAtMs` as the Work card layout key.
   - Remove the `updatedAtMs` group sorts from both `buildActivityInbox()` and `ActivityInbox`'s derived `groups`.
   - Preserve the existing status-section precedence from `ACTIVITY_STATUSES`.
   - Preserve source/model order within each status as the deterministic stable order.

2. If source-order preservation is insufficient during validation, add a small presentation-level stable-order helper/hook.
   - Track `item.id -> { status, ordinal }` in a `useRef` at the `ActivityInbox` boundary.
   - Assign an ordinal when an item first appears in a status.
   - Keep the ordinal unchanged for same-status updates.
   - Assign a new ordinal when the item enters a different status group.
   - Prune ids no longer present.
   - Tie-break by stable `item.id` only, never by `updatedAtMs`.

3. Keep recency visible.
   - Leave `ActivityRow`'s `<time>` rendering, `title`, and aria label based on `item.updatedAtMs` unchanged.
   - Updates should refresh the visible relative time without changing same-status card position.

4. Preserve existing Work behavior.
   - Status transitions still move cards because grouping still depends on `item.status`.
   - Apply stable ordering before/while deriving scoped groups so All Work and workspace-scoped Work use consistent item order.
   - Keep `item.id` and row keys unchanged to avoid disrupting focus/scroll restoration behavior.

## Test plan

1. Add a model-level test in `activityInbox.test.ts`:
   - Build two `inProgress` items in source order A, B.
   - Give B a newer `updatedAtMs` than A.
   - Assert group/item order remains A, B.

2. Add a component rerender test in `components/ActivityInbox.test.tsx`:
   - Render two `In progress` rows.
   - Rerender with the same ids/statuses but inverted/newer `updatedAtMs` values.
   - Assert DOM row order remains stable while the row time metadata updates.

3. Add/extend a status-transition test:
   - Rerender one item from `inProgress` to `needsAttention` or `failed`.
   - Assert it moves to the new status section immediately.

4. Add scoped coverage:
   - Include active sessions from two workspaces.
   - Assert both All Work and a workspace-scoped Work view keep same-status order stable after ordinary updates.

5. Regression checks:
   - `npm test -- activityInbox`
   - `npm run typecheck`
   - If time permits, full `npm test`.

## Acceptance mapping

- Same-status progress updates no longer swap cards: layout ordering does not use `updatedAtMs`.
- Meaningful status transitions still move cards: grouping still uses `item.status`.
- Recency remains visible: row time rendering still uses `updatedAtMs`.
- Deterministic rerenders/data refreshes: source/model order or explicit stable ordinal is used with stable id tie-breaks.
- All Work and scoped Work: ordering is applied to the common model items before scope/status filtering.
- Filter/focus/scroll: stable row ids/keys are preserved.
