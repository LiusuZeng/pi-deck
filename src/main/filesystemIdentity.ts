import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

declare const canonicalFilesystemPathBrand: unique symbol;
declare const canonicalProjectPathBrand: unique symbol;
declare const canonicalSessionFilePathBrand: unique symbol;

/**
 * A normalized absolute filesystem identity. Existing paths use their realpath;
 * missing paths canonicalize their nearest existing ancestor before appending
 * the missing suffix. Other canonicalization failures use path.resolve so
 * callers still get one deterministic fallback key without treating failure as
 * authorization.
 */
export type CanonicalFilesystemPath = string & {
  readonly [canonicalFilesystemPathBrand]: true;
};

/** Canonical identity used when comparing project roots and session cwd. */
export type CanonicalProjectPath = CanonicalFilesystemPath & {
  readonly [canonicalProjectPathBrand]: true;
};

/** Canonical identity used when comparing or indexing Pi session files. */
export type CanonicalSessionFilePath = CanonicalFilesystemPath & {
  readonly [canonicalSessionFilePathBrand]: true;
};

export async function canonicalFilesystemPath(
  filePath: string,
): Promise<CanonicalFilesystemPath> {
  const resolved = path.resolve(filePath);
  try {
    return (await fs.realpath(resolved)) as CanonicalFilesystemPath;
  } catch (error) {
    if (!isMissingPathError(error)) {
      return resolved as CanonicalFilesystemPath;
    }
    return canonicalizeMissingPath(resolved);
  }
}

export async function canonicalProjectPath(
  projectPath: string,
): Promise<CanonicalProjectPath> {
  return (await canonicalFilesystemPath(projectPath)) as CanonicalProjectPath;
}

export async function canonicalSessionFilePath(
  sessionFile: string,
): Promise<CanonicalSessionFilePath> {
  return (await canonicalFilesystemPath(
    sessionFile,
  )) as CanonicalSessionFilePath;
}

/** Synchronous form for lock/reservation keys that must be claimed pre-await. */
export function canonicalSessionFilePathSync(
  sessionFile: string,
): CanonicalSessionFilePath {
  const resolved = path.resolve(sessionFile);
  try {
    return realpathSync.native(resolved) as CanonicalSessionFilePath;
  } catch (error) {
    if (!isMissingPathError(error)) {
      return resolved as CanonicalSessionFilePath;
    }
    return canonicalizeMissingPathSync(resolved) as CanonicalSessionFilePath;
  }
}

async function canonicalizeMissingPath(
  resolved: string,
): Promise<CanonicalFilesystemPath> {
  const suffix: string[] = [];
  let candidate = resolved;

  while (true) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return resolved as CanonicalFilesystemPath;
    }
    suffix.unshift(path.basename(candidate));
    candidate = parent;
    try {
      const canonicalAncestor = await fs.realpath(candidate);
      return path.join(canonicalAncestor, ...suffix) as CanonicalFilesystemPath;
    } catch (error) {
      // Only a missing ancestor warrants walking farther upward. Permission or
      // other filesystem errors fall back safely without probing broader paths.
      if (!isMissingPathError(error)) {
        return resolved as CanonicalFilesystemPath;
      }
    }
  }
}

function canonicalizeMissingPathSync(resolved: string): string {
  const suffix: string[] = [];
  let candidate = resolved;

  while (true) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return resolved;
    }
    suffix.unshift(path.basename(candidate));
    candidate = parent;
    try {
      return path.join(realpathSync.native(candidate), ...suffix);
    } catch (error) {
      if (!isMissingPathError(error)) {
        return resolved;
      }
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
