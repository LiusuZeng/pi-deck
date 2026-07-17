import path from "node:path";

export type SupportedImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

/**
 * Identifies image input from its file signature, never a renderer MIME claim
 * or filename extension. This intentionally only recognizes formats Pi Deck
 * can send as native image inputs.
 */
export function sniffImageMimeType(
  data: Uint8Array,
): SupportedImageMimeType | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    ((data[0] === 0x47 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x38 &&
      data[4] === 0x37 &&
      data[5] === 0x61) ||
      (data[0] === 0x47 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x38 &&
        data[4] === 0x39 &&
        data[5] === 0x61))
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Formats a canonical file path for Pi. References in the worker's project
 * stay portable; anything else deliberately remains an absolute path.
 */
export function formatCanonicalFileReference(
  canonicalPath: string,
  canonicalProjectRoot: string | undefined,
): string {
  if (
    canonicalProjectRoot === undefined ||
    !path.isAbsolute(canonicalPath) ||
    !path.isAbsolute(canonicalProjectRoot) ||
    !isPathInside(canonicalPath, canonicalProjectRoot)
  ) {
    return canonicalPath;
  }

  return path.relative(canonicalProjectRoot, canonicalPath) || ".";
}

export function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
