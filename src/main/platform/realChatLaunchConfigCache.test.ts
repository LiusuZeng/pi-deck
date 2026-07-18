import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it as test } from "vitest";
import { RealChatLaunchConfigCache } from "./realChatLaunchConfigCache.js";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function writeCountingPi(file: string, recordFile: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  fs.appendFileSync(${JSON.stringify(recordFile)}, "version\\n");
  console.log("pi cache-test");
  process.exit(0);
}
process.exit(2);
`,
    "utf8",
  );
  fs.chmodSync(file, 0o755);
}

function versionCount(recordFile: string): number {
  return fs.existsSync(recordFile)
    ? fs.readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean)
        .length
    : 0;
}

test("deduplicates Pi validation in flight and invalidates effective config inputs", async () => {
  const root = tempDir("pi-deck-launch-config-cache-");
  const piBinary = path.join(root, "pi");
  const versionRecord = path.join(root, "versions.log");
  const agentDir = path.join(root, "agent");
  const projectCwd = path.join(root, "project");
  writeCountingPi(piBinary, versionRecord);
  fs.mkdirSync(path.join(projectCwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ images: { blockImages: false } }),
  );

  const cache = new RealChatLaunchConfigCache();
  const options = {
    appSettings: { piBinaryPath: piBinary, agentDir },
    env: { PATH: process.env.PATH ?? "" },
    projectCwd,
  };
  const initial = await Promise.all([
    cache.resolve(options),
    cache.resolve(options),
    cache.resolve(options),
  ]);

  assert.equal(versionCount(versionRecord), 1);
  assert.equal(initial[0].config.imageSettings.blockImages, false);
  assert.strictEqual(initial[0], initial[1]);
  assert.strictEqual(await cache.resolve(options), initial[0]);
  assert.equal(versionCount(versionRecord), 1);

  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ images: { blockImages: true } }),
  );
  const afterGlobalSettingsChange = await cache.resolve(options);
  assert.equal(
    afterGlobalSettingsChange.config.imageSettings.blockImages,
    true,
  );
  assert.equal(versionCount(versionRecord), 1);

  const afterAppSettingsChange = await cache.resolve({
    ...options,
    appSettings: {
      ...options.appSettings,
      sessionDir: path.join(root, "sessions"),
    },
  });
  assert.equal(
    afterAppSettingsChange.config.sessionDir,
    path.join(root, "sessions"),
  );
  assert.equal(versionCount(versionRecord), 1);
});

test("revalidates Pi when the canonical binary identity changes", async () => {
  const root = tempDir("pi-deck-launch-config-binary-cache-");
  const piBinary = path.join(root, "pi");
  const versionRecord = path.join(root, "versions.log");
  const projectCwd = path.join(root, "project");
  writeCountingPi(piBinary, versionRecord);
  fs.mkdirSync(projectCwd, { recursive: true });

  const cache = new RealChatLaunchConfigCache();
  const options = {
    appSettings: { piBinaryPath: piBinary },
    env: { PATH: process.env.PATH ?? "" },
    projectCwd,
  };
  await cache.resolve(options);
  fs.appendFileSync(piBinary, "\n// replacement marker\n");
  await cache.resolve(options);

  assert.equal(versionCount(versionRecord), 2);
});
