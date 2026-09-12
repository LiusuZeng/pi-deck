import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(repoRoot, "dist/main/main.js");

async function launchPiDeck(): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_DECK_BACKEND: "fake",
      PI_DECK_E2E_HIDE_WINDOWS: "1",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

test("long transcript rows enable offscreen rendering containment", async () => {
  const { app, page } = await launchPiDeck();
  try {
    await expect(
      page.locator('.workspace[data-load-state="ready"]'),
    ).toBeVisible();
    await page
      .getByLabel("Sessions", { exact: true })
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(page.getByLabel("Prompt text")).toBeVisible();

    await page.getByLabel("Prompt text").fill("offscreen containment probe");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(/Fake response to: offscreen containment probe/),
    ).toBeVisible();

    const result = await page
      .locator(".timeline-scroll")
      .evaluate(async (root) => {
        const source = root.querySelector<HTMLElement>(".timeline-row");
        if (source === null) {
          throw new Error("Expected a timeline row fixture.");
        }

        for (let index = 0; index < 500; index += 1) {
          root.append(source.cloneNode(true));
        }
        root.scrollTop = root.scrollHeight;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );

        const rows = Array.from(
          root.querySelectorAll<HTMLElement>(".timeline-row"),
        );
        const first = rows[0];
        const last = rows[rows.length - 1];
        if (first === undefined || last === undefined) {
          throw new Error("Expected synthetic long transcript rows.");
        }

        const firstStyle = getComputedStyle(first);
        const rootRect = root.getBoundingClientRect();
        const firstRect = first.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();

        return {
          count: rows.length,
          contentVisibility: firstStyle.contentVisibility,
          intrinsicSize: firstStyle.getPropertyValue("contain-intrinsic-size"),
          firstIsAboveViewport: firstRect.bottom < rootRect.top,
          lastIntersectsViewport:
            lastRect.bottom > rootRect.top && lastRect.top < rootRect.bottom,
          scrollTop: root.scrollTop,
          maxScrollTop: root.scrollHeight - root.clientHeight,
        };
      });

    expect(result.count).toBeGreaterThan(500);
    expect(result.contentVisibility).toBe("auto");
    expect(result.intrinsicSize).toContain("120px");
    expect(result.firstIsAboveViewport).toBe(true);
    expect(result.lastIntersectsViewport).toBe(true);
    expect(result.scrollTop).toBeGreaterThan(0);
    expect(result.scrollTop).toBeCloseTo(result.maxScrollTop, 0);
  } finally {
    await app.close();
  }
});
