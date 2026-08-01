import { describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  effectiveWindowBackground,
  updateWindowBackground,
  windowBackgroundColors,
} from "./theme.js";

describe("application theme", () => {
  it("sets Electron's theme source from the persisted preference", () => {
    const nativeTheme = {
      themeSource: "system" as const,
      shouldUseDarkColors: false,
    };

    applyThemePreference(nativeTheme, "dark");

    expect(nativeTheme.themeSource).toBe("dark");
  });

  it("uses the effective native appearance for the window background", () => {
    expect(effectiveWindowBackground({ shouldUseDarkColors: false })).toBe(
      windowBackgroundColors.light,
    );
    expect(effectiveWindowBackground({ shouldUseDarkColors: true })).toBe(
      windowBackgroundColors.dark,
    );
  });

  it("updates an existing window when the effective appearance changes", () => {
    const window = { setBackgroundColor: vi.fn() };

    updateWindowBackground(window, { shouldUseDarkColors: true });

    expect(window.setBackgroundColor).toHaveBeenCalledWith(
      windowBackgroundColors.dark,
    );
  });
});
