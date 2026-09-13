import { describe, expect, it, vi } from "vitest";
import {
  openPiCodexLoginTerminal,
  piCodexLoginAppleScript,
  piCodexLoginTerminalCommand,
} from "./openPiCodexLogin.js";

describe("Pi OpenAI Codex login terminal launcher", () => {
  const config = {
    piBinary: "/Applications/Pi App/bin/pi; ignored",
    agentDir: "/tmp/pi deck's agent",
  };

  it("guides the user to Pi's interactive OpenAI Codex login without credentials", () => {
    const command = piCodexLoginTerminalCommand(config);
    expect(command).toContain("/login openai-codex");
    expect(command).toContain("PI_CODING_AGENT_DIR");
    expect(command).toContain("ChatGPT subscription login");
    expect(command).not.toContain("auth.json");
    expect(command).not.toContain("token=");
    expect(command).toContain("'\\''");
  });

  it("quotes configured paths containing shell and AppleScript metacharacters", () => {
    const script = piCodexLoginAppleScript({
      piBinary: "/tmp/pi '; $HOME\\n next",
      agentDir: '/tmp/agent "quoted"; $(whoami)',
    });
    expect(script).toContain("do script");
    expect(script).toContain("'\\\\''");
    expect(script).toContain("$(whoami)");
    expect(script).not.toContain("do shell script");
  });

  it("uses only the fixed macOS launcher and does not interpolate AppleScript", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await openPiCodexLoginTerminal({ ...config, run });
    expect(run).toHaveBeenCalledWith("/usr/bin/osascript", [
      "-e",
      piCodexLoginAppleScript(config),
    ]);
  });
});
