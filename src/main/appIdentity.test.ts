import { describe, expect, it, vi } from "vitest";
import {
  initializeAppIdentity,
  piDeckApplicationName,
  type AppIdentityTarget,
} from "./appIdentity.js";

describe("app identity", () => {
  it("sets the Pi Deck name without moving existing user data", () => {
    const setName = vi.fn();
    const setPath = vi.fn();
    const app: AppIdentityTarget = {
      getPath: vi.fn(() => "/Users/test/Library/Application Support/Electron"),
      setName,
      setPath,
    };

    initializeAppIdentity(app);

    expect(setName).toHaveBeenCalledWith(piDeckApplicationName);
    expect(setPath).toHaveBeenCalledWith(
      "userData",
      "/Users/test/Library/Application Support/Electron",
    );
  });
});
