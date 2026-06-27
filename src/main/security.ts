import type { WebPreferences } from "electron";

const allowedExternalSchemes = new Set(["http:", "https:", "mailto:"]);

export function buildSecureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: !isProduction(),
  };
}

export function buildContentSecurityPolicy(isDev: boolean): string {
  const connectSrc = isDev
    ? "'self' ws://127.0.0.1:5173 http://127.0.0.1:5173"
    : "'self'";
  const scriptSrc = isDev ? "'self' 'unsafe-inline'" : "'self'";
  const styleSrc = isDev ? "'self' 'unsafe-inline'" : "'self'";
  const workerSrc = isDev ? "'self' blob:" : "'self'";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    `worker-src ${workerSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return allowedExternalSchemes.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function shouldAllowNavigation(
  targetUrl: string,
  appOrigin: string,
): boolean {
  try {
    const target = new URL(targetUrl);
    if (target.protocol === "file:" || appOrigin === "file://") {
      return false;
    }
    return target.origin === appOrigin;
  } catch {
    return false;
  }
}

function isProduction(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VITE_DEV_SERVER_URL === undefined
  );
}
