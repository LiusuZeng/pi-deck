import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatCanonicalFileReference,
  sniffImageMimeType,
} from "./attachments.js";

describe("sniffImageMimeType", () => {
  it.each([
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    [[0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    [Array.from(Buffer.from("GIF89a")), "image/gif"],
    [
      [
        ...Array.from(Buffer.from("RIFF")),
        0,
        0,
        0,
        0,
        ...Array.from(Buffer.from("WEBP")),
      ],
      "image/webp",
    ],
  ] as const)("detects %s bytes as %s", (bytes, expected) => {
    expect(sniffImageMimeType(Uint8Array.from(bytes))).toBe(expected);
  });

  it("does not treat an image extension or a renderer MIME claim as evidence", () => {
    expect(sniffImageMimeType(Buffer.from("not really a PNG"))).toBeUndefined();
  });
});

describe("formatCanonicalFileReference", () => {
  const projectRoot = path.join(path.sep, "projects", "deck");

  it("uses a project-relative reference for a canonical project file", () => {
    expect(
      formatCanonicalFileReference(
        path.join(projectRoot, "src", "main.ts"),
        projectRoot,
      ),
    ).toBe(path.join("src", "main.ts"));
  });

  it("does not allow a sibling path with a shared prefix to escape absolute formatting", () => {
    const outside = path.join(path.sep, "projects", "deck-other", "secret.txt");
    expect(formatCanonicalFileReference(outside, projectRoot)).toBe(outside);
  });

  it("keeps outside-project and non-canonical references absolute", () => {
    const outside = path.join(path.sep, "tmp", "attachment.txt");
    expect(formatCanonicalFileReference(outside, projectRoot)).toBe(outside);
    expect(formatCanonicalFileReference("src/main.ts", projectRoot)).toBe(
      "src/main.ts",
    );
  });
});
