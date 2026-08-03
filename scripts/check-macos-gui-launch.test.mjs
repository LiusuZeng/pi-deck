import { describe, expect, it, vi } from "vitest";
import {
  checkMacOsGuiLaunch,
  macOsGuiLaunchBlockReason,
} from "./check-macos-gui-launch.mjs";

describe("macOS GUI launch guard", () => {
  it("blocks a GUI launch from Codex Seatbelt on macOS", () => {
    const reason = macOsGuiLaunchBlockReason({
      platform: "darwin",
      env: { CODEX_SANDBOX: "seatbelt" },
    });

    expect(reason).toContain("cannot start a macOS GUI process");
    expect(reason).toContain("outside the sandbox");
  });

  it.each([
    { platform: "darwin", env: {} },
    { platform: "darwin", env: { CODEX_SANDBOX: "other" } },
    { platform: "linux", env: { CODEX_SANDBOX: "seatbelt" } },
  ])("allows a launch outside macOS Seatbelt: %o", (options) => {
    expect(macOsGuiLaunchBlockReason(options)).toBeUndefined();
  });

  it("prints one actionable error when blocked", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      expect(
        checkMacOsGuiLaunch({
          platform: "darwin",
          env: { CODEX_SANDBOX: "seatbelt" },
        }),
      ).toBe(false);
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError.mock.calls[0]?.[0]).toContain("from Terminal");
    } finally {
      consoleError.mockRestore();
    }
  });
});
