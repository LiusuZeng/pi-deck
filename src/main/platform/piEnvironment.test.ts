import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it as test } from "vitest";
import * as platform from "./piEnvironment.js";
import {
  clearRpcSmokeTestCache,
  MINIMAL_RPC_SMOKE_ARGS,
  runMinimalRpcSmokeTest,
} from "./rpcSmokeTest.js";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function writeExecutable(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  fs.chmodSync(file, 0o755);
}

function fakePiScript(version: string): string {
  return fakePiScriptWithRecording(version);
}

function fakePiScriptWithRecording(
  version: string,
  argvRecordPath = "",
  payloadRecordPath = "",
): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const argvRecordPath = ${JSON.stringify(argvRecordPath)};
const payloadRecordPath = ${JSON.stringify(payloadRecordPath)};
if (process.argv.includes('--version')) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
if (process.argv.includes('--mode') && process.argv.includes('rpc')) {
  if (argvRecordPath) fs.writeFileSync(argvRecordPath, JSON.stringify(process.argv.slice(2)), 'utf8');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (payloadRecordPath) fs.writeFileSync(payloadRecordPath, JSON.stringify(msg), 'utf8');
    const command = msg.command || msg.type;
    if (command === 'get_state') {
      process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, success: true, data: { ok: true, sessionFile: undefined } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, success: false, error: 'unknown command' }) + '\\n');
    }
  });
} else {
  console.error('unexpected args', process.argv.slice(2).join(' '));
  process.exit(2);
}
`;
}

function fakeShellScript(piPath: string): string {
  return `#!${process.execPath}
if (process.argv[2] === '-lc' && process.argv[3] === 'command -v pi') {
  console.log(${JSON.stringify(piPath)});
  process.exit(0);
}
console.error('unexpected shell args', process.argv.slice(2).join(' '));
process.exit(2);
`;
}

test("resolvePiBinary honors configured app binary path, canonicalizes, captures version, and redacts env", async () => {
  const root = tempDir("pi-deck-bin-app-");
  const realPi = path.join(root, "real-pi");
  const linkPi = path.join(root, "pi-link");
  writeExecutable(realPi, fakePiScript("pi 1.2.3"));
  fs.symlinkSync(realPi, linkPi);

  const result = await platform.resolvePiBinary({
    appSettings: { piBinaryPath: linkPi },
    env: {
      PATH: process.env.PATH ?? "",
      OPENAI_API_KEY: "super-secret",
      NORMAL_VAR: "visible",
    },
    shellPath: "/bin/sh",
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "app");
  assert.equal(result.piBinary, fs.realpathSync(realPi));
  assert.equal(result.version, "pi 1.2.3");
  assert.equal(result.envSummary.keys.OPENAI_API_KEY, "<redacted>");
  assert.equal(result.envSummary.keys.NORMAL_VAR, "visible");
});

test("resolvePiBinary falls back through PATH and common paths", async () => {
  const pathRoot = tempDir("pi-deck-bin-path-");
  writeExecutable(path.join(pathRoot, "pi"), fakePiScript("pi path-version"));
  const pathResult = await platform.resolvePiBinary({
    env: { PATH: pathRoot + path.delimiter + (process.env.PATH ?? "") },
    shellPath: "/bin/sh",
  });
  assert.equal(pathResult.ok, true);
  assert.equal(pathResult.source, "path");
  assert.equal(pathResult.version, "pi path-version");

  const commonRoot = tempDir("pi-deck-bin-common-");
  const commonPi = path.join(commonRoot, "pi");
  writeExecutable(commonPi, fakePiScript("pi common-version"));
  const commonResult = await platform.resolvePiBinary({
    env: { PATH: "" },
    shellPath: "/bin/sh",
    commonPaths: [commonPi],
  });
  assert.equal(commonResult.ok, true);
  assert.equal(commonResult.source, "common");
  assert.equal(commonResult.version, "pi common-version");
});

test("resolvePiBinary uses login shell lookup when PATH lookup fails", async () => {
  const root = tempDir("pi-deck-bin-shell-");
  const piPath = path.join(root, "pi-from-shell");
  const shellPath = path.join(root, "fake-shell");
  writeExecutable(piPath, fakePiScript("pi shell-version"));
  writeExecutable(shellPath, fakeShellScript(piPath));

  const shellResult = await platform.resolvePiBinary({
    env: { PATH: "" },
    shellPath,
    commonPaths: [],
  });

  assert.equal(shellResult.ok, true);
  assert.equal(shellResult.source, "shell");
  assert.equal(shellResult.piBinary, fs.realpathSync(piPath));
  assert.equal(shellResult.version, "pi shell-version");
});

test("resolvePiBinary returns actionable diagnostics when missing or broken", async () => {
  const root = tempDir("pi-deck-bin-broken-");
  const broken = path.join(root, "pi");
  writeExecutable(broken, "#!/bin/sh\necho broken >&2\nexit 9\n");

  const result = await platform.resolvePiBinary({
    appSettings: { piBinaryPath: broken },
    env: { PATH: "" },
    shellPath: "/bin/sh",
    commonPaths: [],
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.attempts.some((attempt) =>
      String(attempt.error ?? "").includes("pi --version"),
    ),
  );
  assert.ok(
    result.diagnostics.some((diag) => diag.code === "PI_BINARY_NOT_FOUND"),
  );
});

test("resolveEffectivePiConfig maps app overrides and app image settings", async () => {
  const root = tempDir("pi-deck-config-app-");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const agent = path.join(root, "agent");
  const sessions = path.join(root, "sessions");

  const result = await platform.resolveEffectivePiConfig({
    piBinary: "/fake/pi",
    homeDir: home,
    cwd: path.join(root, "project"),
    env: {
      PI_CODING_AGENT_DIR: "/old/agent",
      PI_CODING_AGENT_SESSION_DIR: "/old/sessions",
    },
    appSettings: {
      agentDir: agent,
      sessionDir: sessions,
      images: { blockImages: false, autoResize: false },
    },
    trustOverride: "no-approve",
  });

  assert.equal(result.config.agentDir, agent);
  assert.equal(result.config.env.PI_CODING_AGENT_DIR, agent);
  assert.equal(result.config.sessionDir, sessions);
  assert.equal(result.config.sessionDirSource, "app");
  assert.deepEqual(result.workerArgs, ["--session-dir", sessions]);
  assert.equal(result.config.imageSettings.blockImages, false);
  assert.equal(result.config.imageSettings.autoResize, false);
  assert.equal(result.config.imageSettings.sources.blockImages, "app");
  assert.equal(result.config.trustOverride, "no-approve");
});

test("resolveEffectivePiConfig applies env, global, trusted project, and defaults with correct precedence", async () => {
  const root = tempDir("pi-deck-config-precedence-");
  const home = path.join(root, "home");
  const agent = path.join(home, ".pi", "agent");
  const project = path.join(root, "project");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(agent, "settings.json"),
    JSON.stringify({
      sessionDir: "global-sessions",
      images: { blockImages: true, autoResize: false },
      ignored: true,
    }),
  );
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({
      sessionDir: "project-sessions",
      images: { blockImages: false, autoResize: true },
    }),
  );

  const envResult = await platform.resolveEffectivePiConfig({
    piBinary: "/fake/pi",
    homeDir: home,
    cwd: project,
    env: { PI_CODING_AGENT_SESSION_DIR: path.join(root, "env-sessions") },
    trustOverride: "approve",
  });
  assert.equal(envResult.config.sessionDirSource, "env");

  const trustedResult = await platform.resolveEffectivePiConfig({
    piBinary: "/fake/pi",
    homeDir: home,
    cwd: project,
    env: {},
    trustOverride: "approve",
  });
  assert.equal(
    trustedResult.config.sessionDir,
    path.join(project, ".pi", "project-sessions"),
  );
  assert.equal(trustedResult.config.sessionDirSource, "projectSettings");
  assert.equal(trustedResult.config.imageSettings.blockImages, false);
  assert.equal(trustedResult.config.imageSettings.autoResize, true);
  assert.equal(
    trustedResult.config.imageSettings.sources.blockImages,
    "projectSettings",
  );

  const defaultHome = path.join(root, "default-home");
  const defaultResult = await platform.resolveEffectivePiConfig({
    piBinary: "/fake/pi",
    homeDir: defaultHome,
    cwd: path.join(root, "empty-project"),
    env: {},
  });
  assert.equal(
    defaultResult.config.sessionDir,
    path.join(defaultHome, ".pi", "agent", "sessions"),
  );
  assert.equal(defaultResult.config.sessionDirSource, "default");
});

test("resolveEffectivePiConfig treats delegated project settings as candidates and applies conservative image values", async () => {
  const root = tempDir("pi-deck-config-candidate-");
  const home = path.join(root, "home");
  const agent = path.join(home, ".pi", "agent");
  const project = path.join(root, "project");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(agent, "settings.json"),
    JSON.stringify({
      sessionDir: "global-sessions",
      images: { blockImages: false, autoResize: false },
    }),
  );
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({
      sessionDir: "/tmp/project-candidate-sessions",
      images: { blockImages: true, autoResize: false },
    }),
  );

  const result = await platform.resolveEffectivePiConfig({
    piBinary: "/fake/pi",
    homeDir: home,
    cwd: project,
    env: {},
  });

  assert.equal(result.config.sessionDir, path.join(agent, "global-sessions"));
  assert.equal(result.config.sessionDirSource, "globalSettings");
  assert.equal(
    result.projectSessionDirCandidate,
    "/tmp/project-candidate-sessions",
  );
  assert.ok(
    result.diagnostics.some(
      (diag) => diag.code === "PROJECT_SESSION_DIR_CANDIDATE",
    ),
  );
  assert.equal(result.config.imageSettings.blockImages, true);
  assert.equal(
    result.config.imageSettings.sources.blockImages,
    "projectCandidate",
  );
  assert.equal(result.config.imageSettings.autoResize, false);
  assert.equal(
    result.config.imageSettings.sources.autoResize,
    "globalSettings",
  );
  assert.ok(
    result.config.imageSettings.candidateWarnings.some((warning) =>
      warning.includes("blockImages=true"),
    ),
  );
});

test("settings parse errors are diagnostics only", async () => {
  const root = tempDir("pi-deck-config-parse-");
  const home = path.join(root, "home");
  const agent = path.join(home, ".pi", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "settings.json"), "{not valid json");

  const result = await platform.resolveEffectivePiConfig({
    piBinary: "/fake/pi",
    homeDir: home,
    cwd: path.join(root, "project"),
    env: {},
  });

  assert.equal(result.config.sessionDirSource, "default");
  assert.ok(
    result.diagnostics.some((diag) => diag.code === "SETTINGS_PARSE_ERROR"),
  );
});

test("runMinimalRpcSmokeTest uses canonical no-resource command, temp cwd, validates get_state, and caches by binary/version", async () => {
  clearRpcSmokeTestCache();
  const root = tempDir("pi-deck-smoke-");
  const pi = path.join(root, "pi");
  const argvRecord = path.join(root, "argv.json");
  const payloadRecord = path.join(root, "payload.json");
  writeExecutable(
    pi,
    fakePiScriptWithRecording("pi smoke-version", argvRecord, payloadRecord),
  );

  const first = await runMinimalRpcSmokeTest({
    config: { piBinary: pi, env: { PATH: process.env.PATH ?? "" } },
    version: "pi smoke-version",
    tempRoot: root,
    timeoutMs: 5_000,
  });

  assert.equal(first.ok, true);
  assert.equal(first.fromCache, false);
  assert.deepEqual(first.args, MINIMAL_RPC_SMOKE_ARGS);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(argvRecord, "utf8")),
    MINIMAL_RPC_SMOKE_ARGS,
  );
  assert.ok(first.tempCwd?.startsWith(root));
  assert.equal(first.noSessionFilesCreated, true);
  assert.deepEqual(first.createdFiles, []);
  assert.deepEqual(first.state, { ok: true });

  const payload = JSON.parse(fs.readFileSync(payloadRecord, "utf8"));
  assert.equal(payload.type, "get_state");
  assert.equal(payload.command, undefined);
  assert.equal(payload.params, undefined);

  const second = await runMinimalRpcSmokeTest({
    config: { piBinary: pi, env: { PATH: process.env.PATH ?? "" } },
    version: "pi smoke-version",
    tempRoot: root,
    timeoutMs: 5_000,
  });
  assert.equal(second.ok, true);
  assert.equal(second.fromCache, true);
  assert.equal(second.cacheKey, first.cacheKey);
});
