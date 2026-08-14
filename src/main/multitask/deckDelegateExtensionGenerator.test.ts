import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DECK_DELEGATE_CAPABILITY_ENV,
  DECK_DELEGATE_ENDPOINT_ENV,
  DECK_DELEGATE_EXTENSION_SOURCE,
  DECK_DELEGATE_PROTOCOL_VERSION,
  writeDeckDelegateExtension,
} from "./deckDelegateExtensionGenerator.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Deck delegate extension source generator", () => {
  it("writes a self-contained Pi extension with the supported custom tool", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deck-extension-"));
    directories.push(directory);
    const output = path.join(directory, "generated", "deck-delegate.ts");

    await writeDeckDelegateExtension(output);

    expect(await fs.readFile(output, "utf8")).toBe(DECK_DELEGATE_EXTENSION_SOURCE);
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('from "@earendil-works/pi-coding-agent"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('from "typebox"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('name: "deck_delegate"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).not.toMatch(/from ["'][^"']*pi-deck/);
  });

  it("documents and enforces the versioned, capability-gated JSONL contract", () => {
    expect(DECK_DELEGATE_PROTOCOL_VERSION).toBe(1);
    expect(DECK_DELEGATE_ENDPOINT_ENV).toBe("DECK_DELEGATE_ENDPOINT");
    expect(DECK_DELEGATE_CAPABILITY_ENV).toBe("DECK_DELEGATE_CAPABILITY");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "delegate"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "lifecycle"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "result"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("MAX_LINE_BYTES");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('signal.addEventListener("abort"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("socket.destroy()");
  });

  it("queries capability-bound mode before every agent start and injects only parallel defaults", () => {
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('pi.on("before_agent_start"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "mode-query"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('type: "mode-state"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("queryMode(config.endpoint, config.capability)");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("By default, delegate substantive independent work with deck_delegate");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("explicitly asks you to handle the work directly");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("parallel multitasking is disabled. Do not delegate work with deck_delegate");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).not.toContain("assistant-text parsing");
  });

  it("proactively relays child input-needed and results through Pi", () => {
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("pi.sendMessage");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('event.status === "waiting-input"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("relay(pi, message)");
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain('"provide_input"');
    expect(DECK_DELEGATE_EXTENSION_SOURCE).toContain("taskNumber");
  });
});
