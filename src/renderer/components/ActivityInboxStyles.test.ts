import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps the workspace New session action responsive and theme-token based", () => {
  const styles = readFileSync(
    resolve(process.cwd(), "src/renderer/styles.css"),
    "utf8",
  );

  expect(styles).toContain(
    ".activity-inbox-header {\n  display: flex;\n  align-items: flex-start;\n  justify-content: space-between;",
  );
  expect(styles).toContain(
    ".activity-inbox-header-action {\n  flex: 0 0 auto;\n  min-height: 36px;\n  border: 1px solid var(--color-border-strong);",
  );
  expect(styles).toContain(
    "color: var(--action-solid-fg);\n  background: var(--action-solid-bg);",
  );
  expect(styles).toContain(
    ".activity-inbox-header {\n    flex-direction: column;\n    gap: 14px;\n  }",
  );
});

it("spins active Work row icons and disables the animation for reduced motion", () => {
  const styles = readFileSync(
    resolve(process.cwd(), "src/renderer/styles.css"),
    "utf8",
  );

  expect(styles).toContain(
    ".activity-inbox-row--inProgress .activity-inbox-status-icon--active {\n  animation: ui-control-spin 1.2s linear infinite;\n}",
  );
  expect(styles).toContain(
    '.ui-icon-button[data-loading="true"] svg,\n  .activity-inbox-row--inProgress .activity-inbox-status-icon--active {\n    animation: none;\n  }',
  );
});
