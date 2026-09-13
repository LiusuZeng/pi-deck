import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

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
