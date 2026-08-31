import path from "node:path";
import type { NativeImage } from "electron";

export const appIconFileName = "pi-deck-app-icon.png";

export interface AppIconPathOptions {
  isDev: boolean;
  appPath: string;
  mainDirectory: string;
}

/**
 * Uses the source raster while Vite serves the renderer, and the explicitly
 * copied raster beside the built renderer for normal `dist/main/main.js`
 * launches.
 */
export function resolveAppIconPath({
  isDev,
  appPath,
  mainDirectory,
}: AppIconPathOptions): string {
  return isDev
    ? path.join(appPath, "assets", "branding", appIconFileName)
    : path.join(mainDirectory, "..", "renderer", appIconFileName);
}

export interface MacOSDockIconOptions {
  platform: NodeJS.Platform;
  dock?: { setIcon(image: NativeImage): void };
  iconPath: string;
  nativeImage: { createFromPath(iconPath: string): NativeImage };
}

/** Sets the source-run Dock icon without touching macOS-only APIs elsewhere. */
export function initializeMacOSDockIcon(options: MacOSDockIconOptions): void {
  if (options.platform !== "darwin") {
    return;
  }

  const { dock } = options;
  if (!dock) {
    return;
  }

  try {
    const image = options.nativeImage.createFromPath(options.iconPath);
    if (!image.isEmpty()) {
      dock.setIcon(image);
    }
  } catch {
    // A missing native resource must not block development or app startup.
  }
}
