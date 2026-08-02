import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sourceUrl = new URL("../docs/assets/pi-deck-social-preview.svg", import.meta.url);
const outputPath = fileURLToPath(new URL("../site/assets/social-preview.png", import.meta.url));

execFileSync(
  chromePath,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1280,640",
    `--screenshot=${outputPath}`,
    sourceUrl.href
  ],
  { stdio: "inherit" }
);
