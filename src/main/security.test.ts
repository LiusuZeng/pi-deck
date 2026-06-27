import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  buildSecureWebPreferences,
  isAllowedExternalUrl,
  shouldAllowNavigation,
} from "./security.js";

describe("Electron security defaults", () => {
  it("enables the secure BrowserWindow boundary", () => {
    expect(buildSecureWebPreferences("/tmp/preload.js")).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it("uses a strict production CSP baseline", () => {
    const csp = buildContentSecurityPolicy(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("https:");
    expect(csp).not.toContain("blob:");
  });

  it("allows only the dev capabilities Vite needs", () => {
    const csp = buildContentSecurityPolicy(true);
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain(
      "connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173",
    );
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toContain("https:");
  });

  it("restricts navigation and external link schemes", () => {
    expect(shouldAllowNavigation("https://example.com", "file://")).toBe(false);
    expect(shouldAllowNavigation("file:///tmp/other.html", "file://")).toBe(
      false,
    );
    expect(
      shouldAllowNavigation(
        "http://127.0.0.1:5173/page",
        "http://127.0.0.1:5173",
      ),
    ).toBe(true);
    expect(isAllowedExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
