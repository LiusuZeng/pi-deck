import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

declare const canonicalFilesystemPathBrand: unique symbol;
declare const canonicalProjectPathBrand: unique symbol;
declare const canonicalSessionFilePathBrand: unique symbol;

/**
 * A normalized absolute filesystem identity. Existing paths use their realpath;
 * unavailable paths use path.resolve so callers still get one deterministic
 * fallback key without treating canonicalization failure as authorization.
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
  } catch {
    return resolved as CanonicalFilesystemPath;
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
  } catch {
    return resolved as CanonicalSessionFilePath;
  }
}
