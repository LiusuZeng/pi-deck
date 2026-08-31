import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appIconFileName,
  initializeMacOSDockIcon,
  resolveAppIconPath,
} from "./appIcon.js";

describe("Pi Deck app icon", () => {
  it("resolves the source icon for Vite development and renderer icon for built Electron", () => {
    expect(
      resolveAppIconPath({
        isDev: true,
        appPath: "/checkout/pi-deck",
        mainDirectory: "/checkout/pi-deck/dist/main",
      }),
    ).toBe(
      path.join("/checkout/pi-deck", "assets", "branding", appIconFileName),
    );
    expect(
      resolveAppIconPath({
        isDev: false,
        appPath: "/checkout/pi-deck",
        mainDirectory: "/checkout/pi-deck/dist/main",
      }),
    ).toBe(
      path.join(
        "/checkout/pi-deck/dist/main",
        "..",
        "renderer",
        appIconFileName,
      ),
    );
  });

  it("sets the macOS Dock icon when the native raster loads", () => {
    const image = { isEmpty: () => false } as never;
    const setIcon = vi.fn();
    const createFromPath = vi.fn(() => image);

    initializeMacOSDockIcon({
      platform: "darwin",
      dock: { setIcon },
      iconPath: "/icon.png",
      nativeImage: { createFromPath },
    });

    expect(createFromPath).toHaveBeenCalledWith("/icon.png");
    expect(setIcon).toHaveBeenCalledWith(image);
  });

  it("does not access the Dock or native image APIs outside macOS", () => {
    const createFromPath = vi.fn();
    const options = {
      platform: "linux" as NodeJS.Platform,
      iconPath: "/icon.png",
      nativeImage: { createFromPath },
    };
    Object.defineProperty(options, "dock", {
      get: () => {
        throw new Error("non-macOS must not access app.dock");
      },
    });

    expect(() => initializeMacOSDockIcon(options)).not.toThrow();
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it("tolerates an unavailable Dock API or an unreadable raster", () => {
    expect(() =>
      initializeMacOSDockIcon({
        platform: "darwin",
        iconPath: "/icon.png",
        nativeImage: {
          createFromPath: () => ({ isEmpty: () => false }) as never,
        },
      }),
    ).not.toThrow();
    expect(() =>
      initializeMacOSDockIcon({
        platform: "darwin",
        dock: { setIcon: vi.fn() },
        iconPath: "/icon.png",
        nativeImage: {
          createFromPath: () => {
            throw new Error("unreadable");
          },
        },
      }),
    ).not.toThrow();
  });
});
