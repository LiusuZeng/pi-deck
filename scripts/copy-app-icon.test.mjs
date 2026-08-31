import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copyAppIcon } from "./copy-app-icon.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceSvg = path.join(
  repoRoot,
  "assets",
  "branding",
  "pi-deck-app-icon.svg",
);
const sourceIcon = path.join(
  repoRoot,
  "assets",
  "branding",
  "pi-deck-app-icon.png",
);

describe("Pi Deck app icon build copy", () => {
  it("keeps the three-card SVG source and a non-empty 1024px PNG raster", async () => {
    const [svg, icon] = await Promise.all([
      readFile(sourceSvg, "utf8"),
      readFile(sourceIcon),
    ]);
    const iconStats = await stat(sourceIcon);

    expect(svg).toContain('width="1024" height="1024"');
    expect(svg.match(/<rect /g)).toHaveLength(4);
    expect(iconStats.isFile()).toBe(true);
    expect(iconStats.size).toBeGreaterThan(0);
    expect(icon.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(icon.readUInt32BE(16)).toBe(1024);
    expect(icon.readUInt32BE(20)).toBe(1024);
  });

  it("copies the runtime raster beside the built renderer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-deck-icon-"));
    try {
      const fixtureSource = path.join(
        root,
        "assets",
        "branding",
        "pi-deck-app-icon.png",
      );
      await mkdir(path.dirname(fixtureSource), { recursive: true });
      await writeFile(fixtureSource, await readFile(sourceIcon));

      const destination = await copyAppIcon(root);

      expect(destination).toBe(
        path.join(root, "dist", "renderer", "pi-deck-app-icon.png"),
      );
      expect(await readFile(destination)).toEqual(await readFile(sourceIcon));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
