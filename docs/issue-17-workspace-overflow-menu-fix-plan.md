# Issue 17 fix plan: workspace overflow actions overlap

GitHub issue: https://github.com/LiusuZeng/pi-deck/issues/17  
Worktree: `pi-deck-issue-17`  
Branch: `fix/issue-17-workspace-overflow-menu`

## Problem summary

The sidebar workspace overflow (`…`) menu renders `View Work`, `Rename workspace`, and `Archive workspace` horizontally in a wide popover, allowing labels to collide. The expected behavior is a compact, anchored, vertical action menu with stable readable hit targets across workspace-name lengths and window/sidebar widths.

## Initial root-cause finding

`src/renderer/components/ui/Menu.tsx` applies `props.className` to both:

1. the trigger wrapper: `className="ui-menu ..."`; and
2. the portaled popover: `className="ui-menu-popover ..."`.

The workspace overflow passes `className="workspace-tree-actions"` from `src/renderer/App.tsx`. That class is intended for the sidebar row trigger container, but because it is also copied onto the popover, this rule in `src/renderer/styles.css` overrides the base popover grid layout:

```css
.workspace-tree-actions {
  display: flex;
  align-items: center;
  justify-content: center;
}
```

The portaled popover therefore becomes a horizontal flex container instead of the intended vertical/grid menu.

## Fix approach

1. **Separate Menu trigger and popover styling responsibilities**
   - Update `Menu` so the existing `className` remains wrapper/trigger-container scoped only.
   - Add an optional `popoverClassName` (or similarly named) prop for call sites that intentionally need popover-specific styling.
   - Apply `popoverClassName` to `ui-menu-popover`; do not apply wrapper layout classes to the portaled popover by default.

2. **Preserve existing intentional popover styling**
   - Audit existing `Menu` usages:
     - workspace actions: wrapper-only class (`workspace-tree-actions`) should no longer affect popover layout.
     - session actions: wrapper-only margin class should not affect popover.
     - appearance menu: if it needs popover-specific selectors, pass `popoverClassName="appearance-menu"` or adjust CSS to target the new prop.
     - parallel worker settings: ensure the non-menu popover still receives any needed popover-specific class only if required.

3. **Harden menu item geometry**
   - Keep `.ui-menu-popover` as a vertical layout (`display: grid` or column flex) with compact width bounds.
   - Ensure `.ui-menu-popover .ui-button`, `.ui-button--menuItem`, and danger buttons use full-width, left-aligned, non-overlapping layout.
   - Consider adding `min-width: max-content` with a safe viewport `max-width`, or retain current `min-width: 190px` if labels fit; avoid intrinsic width that sprawls into the main content.

4. **Add regression coverage**
   - Add/extend `src/renderer/components/ui/Menu.test.ts` to verify wrapper `className` is not copied to the portaled popover and optional `popoverClassName` is.
   - Add/extend an App/sidebar test that opens a workspace actions menu and asserts the popover/menu items are present as distinct menu items in DOM order.
   - If layout assertions are feasible in jsdom, verify the popover keeps `ui-menu-popover` without `workspace-tree-actions`; otherwise rely on class contract tests and component tests.

5. **Manual validation checklist**
   - Open a workspace overflow menu in real mode.
   - Verify `View Work`, `Rename workspace`, `Archive workspace` appear as a vertical compact list.
   - Repeat with a very long workspace name.
   - Test narrow and wide app windows/sidebar widths.
   - Keyboard through menu with ArrowDown/ArrowUp/Home/End/Escape; focus movement should not shift layout.
   - Confirm `Archive workspace` remains visually destructive but uses the same geometry as other menu items.

## Suggested verification commands

```bash
npm test -- src/renderer/components/ui/Menu.test.ts
npm test -- src/renderer/App.test.ts
npm run typecheck
```

If the project test runner does not support file filters exactly as above, use the closest Vitest invocation from `package.json`.
