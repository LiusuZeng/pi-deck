import type { ChatSessionSummary } from "../../shared/types.js";
import {
  readPiSessionSummary,
  type ReadPiSessionSummaryOptions,
  type ReadPiSessionSummaryResult,
} from "../pi/sessionRepository.js";
import type {
  WorkspaceRecord,
  WorkspaceSessionRef,
  WorkspaceStore,
} from "./workspaceStore.js";

interface WorkspaceSessionRecoveryStore extends Pick<
  WorkspaceStore,
  "getSessionRefs" | "upsertSessionRefs"
> {}

export interface RecoverMissingWorkspaceSessionsOptions {
  store: WorkspaceSessionRecoveryStore;
  workspace: WorkspaceRecord;
  includeArchived: boolean;
  sessionDir: string | undefined | (() => Promise<string | undefined>);
  diagnostics: string[];
  assertActive: () => void;
  readSessionSummary?: (
    options: ReadPiSessionSummaryOptions,
  ) => Promise<ReadPiSessionSummaryResult>;
  isSessionBlocked?: (sessionFile: string) => Promise<boolean>;
}

export async function recoverMissingWorkspaceSessionRefs(
  options: RecoverMissingWorkspaceSessionsOptions,
): Promise<number> {
  options.assertActive();
  const refs = await options.store.getSessionRefs(options.workspace.id);
  const candidates = refs.filter(
    (ref) =>
      ref.missingSinceMs !== undefined &&
      (options.includeArchived || ref.archivedAtMs === undefined),
  );
  if (candidates.length === 0) {
    return 0;
  }

  const sessionDir =
    typeof options.sessionDir === "function"
      ? await options.sessionDir()
      : options.sessionDir;
  options.assertActive();
  if (sessionDir === undefined) {
    return 0;
  }

  const summaries: ChatSessionSummary[] = [];
  const readSummary = options.readSessionSummary ?? readPiSessionSummary;
  const batchSize = 8;
  for (let index = 0; index < candidates.length; index += batchSize) {
    options.assertActive();
    const batch = candidates.slice(index, index + batchSize);
    const results = await Promise.all(
      batch.map(async (ref) => {
        if ((await options.isSessionBlocked?.(ref.sessionFile)) === true) {
          return {
            ref,
            blocked: true,
          };
        }
        return {
          ref,
          result: await readSummary({
            sessionFile: ref.sessionFile,
            sessionDir,
          }),
        };
      }),
    );
    options.assertActive();
    for (const item of results) {
      if ("blocked" in item) {
        options.diagnostics.push(
          `Fork cleanup blocks missing workspace session recovery: ${item.ref.sessionFile}`,
        );
        continue;
      }
      options.diagnostics.push(...item.result.diagnostics);
      const summary = item.result.summary;
      if (summary === undefined) {
        continue;
      }
      if (!isRecoveredSummaryForRef(item.ref, summary, options.diagnostics)) {
        continue;
      }
      summaries.push(summary);
    }
  }

  if (summaries.length === 0) {
    return 0;
  }

  options.assertActive();
  const recovered = await options.store.upsertSessionRefs(
    options.workspace.id,
    summaries,
    {
      requireMissingRefs: true,
      ...(options.workspace.archivedAtMs !== undefined
        ? { allowArchived: true }
        : {}),
    },
  );
  options.assertActive();
  return recovered.length;
}

function isRecoveredSummaryForRef(
  ref: WorkspaceSessionRef,
  summary: ChatSessionSummary,
  diagnostics: string[],
): boolean {
  if (summary.sessionFile !== ref.sessionFile) {
    diagnostics.push(
      `Rejected recovered workspace session with changed canonical path: ${ref.sessionFile}`,
    );
    return false;
  }
  if (
    ref.sessionId !== undefined &&
    summary.sessionId !== undefined &&
    summary.sessionId !== ref.sessionId
  ) {
    diagnostics.push(
      `Rejected recovered workspace session with changed session identity: ${ref.sessionFile}`,
    );
    return false;
  }
  return true;
}
