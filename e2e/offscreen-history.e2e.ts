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

test("heterogeneous contained history keeps the settled bottom reachable", async () => {
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
        const content = root.querySelector<HTMLElement>(".timeline-content");
        if (content === null) {
          throw new Error("Expected the observed timeline content wrapper.");
        }

        for (let index = 0; index < 120; index += 1) {
          const row = document.createElement("article");
          row.className = "timeline-row";
          row.dataset.syntheticHistory = String(index);
          const lineCount = [8, 36, 80, 17][index % 4] ?? 8;
          const lines = Array.from(
            { length: lineCount },
            (_, line) => `history ${index}, line ${line}`,
          ).join("<br>");
          row.innerHTML =
            index % 9 === 0
              ? `<details open><summary>Expanded history ${index}</summary><div>${lines}</div></details>`
              : `<div>${lines}</div>`;
          content.append(row);
        }

        const frame = (): Promise<void> =>
          new Promise((resolve) => requestAnimationFrame(() => resolve()));
        const sampleBottomSettling = async (): Promise<
          Array<{ distance: number; scrollHeight: number; scrollTop: number }>
        > => {
          const samples = [];
          for (let index = 0; index < 45; index += 1) {
            await frame();
            samples.push({
              distance: Math.max(
                0,
                root.scrollHeight - root.scrollTop - root.clientHeight,
              ),
              scrollHeight: root.scrollHeight,
              scrollTop: root.scrollTop,
            });
          }
          return samples;
        };
        const navigateToBottom = (): void => {
          root.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: 10_000 }),
          );
          root.scrollTop = root.scrollHeight;
          root.dispatchEvent(new Event("scroll", { bubbles: true }));
        };

        // Start as a history reader, then deliberately navigate to the end in
        // the same turn that Chromium must realize contained variable heights.
        root.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: -10_000 }),
        );
        root.scrollTop = 0;
        root.dispatchEvent(new Event("scroll", { bubbles: true }));
        navigateToBottom();
        const firstBottomSamples = await sampleBottomSettling();

        // Moving away must revoke follow ownership even when observed content
        // changes afterward.
        root.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: -2_000 }),
        );
        root.scrollTop = Math.max(0, root.scrollTop - root.clientHeight * 3);
        root.dispatchEvent(new Event("scroll", { bubbles: true }));
        const rowWhileReading = content.querySelector<HTMLElement>(
          '[data-synthetic-history="4"] > div',
        );
        if (rowWhileReading === null) {
          throw new Error("Expected a synthetic row to grow.");
        }
        rowWhileReading.append(
          ...Array.from({ length: 40 }, (_, index) => {
            const line = document.createElement("div");
            line.textContent = `late history line ${index}`;
            return line;
          }),
        );
        for (let index = 0; index < 8; index += 1) {
          await frame();
        }
        const readingDistance = Math.max(
          0,
          root.scrollHeight - root.scrollTop - root.clientHeight,
        );

        navigateToBottom();
        const secondBottomSamples = await sampleBottomSettling();
        const rows = Array.from(
          content.querySelectorAll<HTMLElement>(".timeline-row"),
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
          readingDistance,
          firstBottomSamples,
          secondBottomSamples,
        };
      });

    expect(result.count).toBeGreaterThan(120);
    expect(result.contentVisibility).toBe("auto");
    expect(result.intrinsicSize).toContain("120px");
    expect(result.firstIsAboveViewport).toBe(true);
    expect(result.lastIntersectsViewport).toBe(true);
    expect(result.readingDistance).toBeGreaterThan(80);
    for (const samples of [
      result.firstBottomSamples,
      result.secondBottomSamples,
    ]) {
      expect(samples.length).toBe(45);
      expect(samples.some((sample) => sample.scrollTop > 0)).toBe(true);
      // Assert sustained settled ownership, not one favorable animation frame.
      expect(samples.slice(-12).every((sample) => sample.distance <= 1)).toBe(
        true,
      );
    }
  } finally {
    await app.close();
  }
});
