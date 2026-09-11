export const piDeckApplicationName = "Pi Deck";

export interface AppIdentityTarget {
  getPath(name: "userData"): string;
  setName(name: string): void;
  setPath(name: "userData", value: string): void;
}

/**
 * Apply Pi Deck's Electron-internal application name without changing the
 * existing userData location. Source-run Electron otherwise identifies itself
 * as "Electron", and changing the name must not silently move dogfood state.
 */
export function initializeAppIdentity(app: AppIdentityTarget): void {
  const existingUserDataPath = app.getPath("userData");
  app.setName(piDeckApplicationName);
  app.setPath("userData", existingUserDataPath);
}
