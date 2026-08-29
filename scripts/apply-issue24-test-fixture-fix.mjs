import fs from "node:fs";

function replaceOnce(text, search, replacement, label) {
  const index = text.indexOf(search);
  if (index < 0) throw new Error(`Missing ${label}`);
  if (text.indexOf(search, index + search.length) >= 0) {
    throw new Error(`Expected one ${label}`);
  }
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}

const e2ePath = "e2e/pi-deck.e2e.ts";
let e2e = fs.readFileSync(e2ePath, "utf8");

const helperMatch = e2e.match(
  /function createSequencedFakePiBinary\([\s\S]*?\n}\n\nfunction fakeRealModeEnv/,
);
if (!helperMatch) throw new Error("Missing sequenced fake Pi helper");
e2e = e2e.replace(helperMatch[0], "function fakeRealModeEnv");

const binaryMatch = e2e.match(
  /PI_DECK_PI_BINARY: createSequencedFakePiBinary\(root, \[[\s\S]*?\]\),\n      PI_DECK_PROJECT_CWD/,
);
if (!binaryMatch) throw new Error("Missing sequenced All Work fixture");
e2e = e2e.replace(
  binaryMatch[0],
  `PI_DECK_PI_BINARY: createFakePiBinary(root, [\n        "--stream-delay-ms",\n        "120000",\n        "--prompt-error-prefix",\n        "count consistency failed",\n      ]),\n      PI_DECK_PROJECT_CWD`,
);
fs.writeFileSync(e2ePath, e2e);

const fakePath = "src/main/pi/fakeRpc/fakeRpcServer.ts";
let fake = fs.readFileSync(fakePath, "utf8");
fake = replaceOnce(
  fake,
  "  promptScenario: PromptScenario;\n  dropCompletionEvents: boolean;",
  "  promptScenario: PromptScenario;\n  /** Test-only selector for deterministic per-prompt provider failures. */\n  promptErrorPrefix?: string;\n  dropCompletionEvents: boolean;",
  "FakeOptions promptScenario field",
);
fake = replaceOnce(
  fake,
  '    } else if (arg === "--drop-completion-events") {',
  '    } else if (arg === "--prompt-error-prefix") {\n      const prefix = argv[index + 1];\n      if (prefix) options.promptErrorPrefix = prefix;\n      index += 1;\n    } else if (arg === "--drop-completion-events") {',
  "prompt error prefix parser insertion",
);
fake = replaceOnce(
  fake,
  '    if (this.options.promptScenario === "error") {',
  '    if (\n      this.options.promptScenario === "error" ||\n      (this.options.promptErrorPrefix !== undefined &&\n        text.startsWith(this.options.promptErrorPrefix))\n    ) {',
  "error prompt condition",
);
fs.writeFileSync(fakePath, fake);
