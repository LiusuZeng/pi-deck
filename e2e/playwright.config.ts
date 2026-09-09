import { defineConfig } from "@playwright/test";

const runRealPiSmoke = process.env.PI_DECK_E2E_REAL_SMOKE === "1";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  testIgnore: runRealPiSmoke ? [] : ["**/real-pi-smoke.e2e.ts"],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
