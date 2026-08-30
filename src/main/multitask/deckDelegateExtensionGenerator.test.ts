import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DECK_DELEGATE_CAPABILITY_ENV,
  DECK_DELEGATE_ENDPOINT_ENV,
  DECK_DELEGATE_EXTENSION_SOURCE,
  DECK_DELEGATE_LEGACY_TOOL_ENV,
  DECK_DELEGATE_PROTOCOL_VERSION,
  writeDeckDelegateAcceptanceHarness,
  writeDeckDelegateExtension,
} from "./deckDelegateExtensionGenerator.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Deck delegate extension source generator", () => {
  it("writes a self-contained Pi extension with an opt-in compatibility tool", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-extension-"),
    );
    directories.push(directory);
    const output = path.join(directory, "generated", "deck-delegate.ts");

    await writeDeckDelegateExtension(output);

    expect(await fs.readFile(output, "utf8")).toBe(
      DECK_DELEGATE_EXTENSION_SOURCE,
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'from "@earendil-works/pi-coding-agent"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('from "typebox"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('name: "deck_delegate"');
    expect(DECK_DELEGATE_LEGACY_TOOL_ENV).toBe(
      "PI_DECK_ENABLE_LEGACY_DELEGATE_BRIDGE",
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'process.env[DECK_DELEGATE_LEGACY_TOOL_ENV] === "1"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      "pi.registerTool(createDeckDelegateTool(pi))",
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).not.toMatch(
      /from ["'][^"']*pi-deck/,
    );
  });

  it("writes an opt-in harness that calls the generated tool without fake RPC", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-deck-extension-"),
    );
    directories.push(directory);
    const delegate = path.join(directory, "deck-delegate.ts");
    const harness = path.join(directory, "deck-delegate-harness.ts");

    await writeDeckDelegateAcceptanceHarness(harness, delegate);

    const source = await fs.readFile(harness, "utf8");
    expect(source).toContain(`from ${JSON.stringify(delegate)}`);
    expect(source).toContain("createDeckDelegateTool(pi).execute");
    expect(source).toContain("PI_DECK_E2E_INVOKE_DECK_DELEGATE");
    expect(source).toContain("PI_DECK_E2E_ASSERT_DECK_DELEGATE_ABSENT");
    expect(source).toContain("PI_DECK_E2E_KEEP_PARENT_ACTIVE");
    expect(source).toContain("PI_DECK_E2E_PARENT_ACTIVE_STARTED");
    expect(source).toContain('pi.on("input"');
    expect(source).toContain('action: "handled"');
    expect(source).toContain("pi.getAllTools()");
    expect(source).toContain("PI_DECK_E2E_DECK_DELEGATE_NOT_REGISTERED");
  });

  it("documents and enforces the versioned, capability-gated JSONL contract", () => {
    expect(DECK_DELEGATE_PROTOCOL_VERSION).toBe(1);
    expect(DECK_DELEGATE_ENDPOINT_ENV).toBe("DECK_DELEGATE_ENDPOINT");
    expect(DECK_DELEGATE_CAPABILITY_ENV).toBe("DECK_DELEGATE_CAPABILITY");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "delegate"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "lifecycle"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "result"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("MAX_LINE_BYTES");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'signal.addEventListener("abort"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("socket.destroy()");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'JSON.stringify(value) + "\\n"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).not.toContain(
      'JSON.stringify(value) + "\\\\n"',
    );
  });

  it("queries capability-bound mode before every agent start and injects only parallel defaults", () => {
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'pi.on("before_agent_start"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "mode-query"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "mode-state"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'registerCommand("deck-task-prompt"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'appendEntry("deck_task_prompt"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'registerCommand("deck-e2e-parent-active-sleep"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      "PI_DECK_E2E_PARENT_ACTIVE_MARKER_FILE",
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      "queryMode(config.endpoint, config.capability)",
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      "manages Parallel mode task-session planning and routing outside this parent turn",
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      "Do not call deck_delegate for ordinary user prompts",
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      "Parallel mode is off. Do not call deck_delegate",
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).not.toContain(
      "assistant-text parsing",
    );
  });

  it("proactively relays child input-needed and results through Pi", () => {
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("pi.sendMessage");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain(
      'event.status === "waiting-input"',
    );
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("relay(pi, message)");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('"provide_input"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("taskNumber");
  });
});
