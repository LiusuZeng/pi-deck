import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const productionCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig(({ command }) => ({
  plugins: [react(), productionCspMetaPlugin(command === "build")],
  root: ".",
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html",
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
}));

function productionCspMetaPlugin(enabled: boolean): Plugin {
  return {
    name: "pi-deck-production-csp-meta",
    transformIndexHtml(html) {
      if (!enabled) {
        return html;
      }

      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${productionCsp}" />`,
      );
    },
  };
}
