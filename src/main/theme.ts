import type { ThemePreference } from "../shared/types.js";

interface NativeThemeController {
  themeSource: ThemePreference;
  shouldUseDarkColors: boolean;
}

interface ThemeWindow {
  setBackgroundColor(color: string): void;
}

// These colors must stay aligned with the renderer's --color-canvas token.
export const windowBackgroundColors = Object.freeze({
  light: "#ffffff",
  dark: "#171a1f",
});

export function applyThemePreference(
  nativeTheme: NativeThemeController,
  preference: ThemePreference,
): void {
  nativeTheme.themeSource = preference;
}

export function effectiveWindowBackground(
  nativeTheme: Pick<NativeThemeController, "shouldUseDarkColors">,
): string {
  return nativeTheme.shouldUseDarkColors
    ? windowBackgroundColors.dark
    : windowBackgroundColors.light;
}

export function updateWindowBackground(
  window: ThemeWindow | undefined,
  nativeTheme: Pick<NativeThemeController, "shouldUseDarkColors">,
): void {
  window?.setBackgroundColor(effectiveWindowBackground(nativeTheme));
}
