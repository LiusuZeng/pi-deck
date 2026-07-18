#!/usr/bin/env node
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function usage() {
  console.log(`Pi Deck launcher

Usage:
  npm run deck:real -- [project-dir]
  npm run deck:fake
  npm run dev:real -- [project-dir]
  node scripts/start-pi-deck.mjs [--real|--fake] [--dev|--launch] [--build] [project-dir]

Options:
  --real              Launch against a real local pi --mode rpc worker.
  --fake              Launch local fake backend mode.
  --dev               Use Vite/Electron dev loop.
  --launch            Use the existing production build (default; does not rebuild).
  --build             Build before a production launch (for development/CI).
  --project <dir>     Project cwd for real Pi workers. Defaults to caller cwd.
  --pi <path>         Pi binary path. Defaults to PI_DECK_PI_BINARY or PATH/common locations.
  --dry-run           Print resolved launch plan without starting Electron.
  -h, --help          Show this help.

Environment overrides still work:
  PI_DECK_PI_BINARY, PI_DECK_PROJECT_CWD, PI_CODING_AGENT_DIR, PI_DECK_USER_DATA_DIR
`);
}

function parseArgs(argv) {
  const options = {
    backend: undefined,
    runMode: "launch",
    project: undefined,
    piBinary: undefined,
    dryRun: false,
    build: false,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--real") {
      options.backend = "real";
    } else if (arg === "--fake") {
      options.backend = "fake";
    } else if (arg === "--dev") {
      options.runMode = "dev";
    } else if (arg === "--launch") {
      options.runMode = "launch";
    } else if (arg === "--project") {
      options.project = requireValue(argv, ++index, "--project");
    } else if (arg === "--pi") {
      options.piBinary = requireValue(argv, ++index, "--pi");
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--build") {
      options.build = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (options.project === undefined && positional.length > 0) {
    options.project = positional[0];
  }
  if (positional.length > 1) {
    throw new Error(
      `Unexpected extra arguments: ${positional.slice(1).join(" ")}`,
    );
  }

  if (options.build && options.runMode === "dev") {
    throw new Error("--build is only valid with --launch, not --dev");
  }

  return options;
}

function requireValue(argv, index, optionName) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function realpathDirectory(input, label) {
  const resolved = path.resolve(input);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandInPath(command) {
  const result =
    process.platform === "win32"
      ? spawnSync("where", [command], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      : spawnSync("/bin/sh", ["-lc", `command -v ${command}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
  const first = result.stdout?.split(/\r?\n/).find(Boolean);
  return first && isExecutable(first) ? first : undefined;
}

function resolvePiBinary(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.PI_DECK_PI_BINARY,
    commandInPath("pi"),
    "/usr/local/bin/pi",
    "/opt/homebrew/bin/pi",
    path.join(process.env.HOME ?? "", ".local/bin/pi"),
  ].filter(
    (candidate) => typeof candidate === "string" && candidate.length > 0,
  );

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isExecutable(resolved)) {
      return realpathSync(resolved);
    }
  }

  throw new Error(
    "Could not find an executable pi binary. Install Pi or pass --pi /absolute/path/to/pi.",
  );
}

function printPlan(plan) {
  const runLabel = plan.runMode === "dev" ? "dev" : "production-ish";
  console.log(
    `${plan.backend === "real" ? "Real Pi backend" : "Fake backend"} Pi Deck ${runLabel} launch`,
  );
  console.log(`  Repo:    ${repoRoot}`);
  if (plan.projectCwd) {
    console.log(`  Project: ${plan.projectCwd}`);
  }
  if (plan.piBinary) {
    console.log(`  Pi:      ${plan.piBinary}`);
  }
  console.log(`  Command: npm --prefix ${repoRoot} run ${plan.npmScript}`);
  if (plan.runMode === "dev") {
    console.log(
      "  Reload:  renderer hot reload via Vite; main/preload changes need restart",
    );
  }
  console.log();
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      process.exit(0);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run with --help for usage.");
    process.exit(2);
  }

  const backend =
    options.backend ??
    (process.env.PI_DECK_BACKEND === "real" ? "real" : "fake");
  const callerCwd = process.env.INIT_CWD || process.cwd();
  const env = { ...process.env };
  let projectCwd;
  let piBinary;

  try {
    if (backend === "real") {
      projectCwd = realpathDirectory(
        options.project ?? process.env.PI_DECK_PROJECT_CWD ?? callerCwd,
        "Project directory",
      );
      piBinary = resolvePiBinary(options.piBinary);
      env.PI_DECK_BACKEND = "real";
      env.PI_DECK_PI_BINARY = piBinary;
      env.PI_DECK_PROJECT_CWD = projectCwd;
    } else {
      env.PI_DECK_BACKEND = "fake";
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const npmScript =
    options.runMode === "dev"
      ? "dev"
      : options.build
        ? "launch:build"
        : "launch";
  const plan = {
    backend,
    runMode: options.runMode,
    npmScript,
    projectCwd,
    piBinary,
  };
  printPlan(plan);

  if (options.dryRun) {
    return;
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["--prefix", repoRoot, "run", npmScript], {
    stdio: "inherit",
    env,
    cwd: repoRoot,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
