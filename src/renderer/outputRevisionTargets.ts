export interface OutputRevisionTarget {
  outputId: string;
  expectedRevisionId: string;
  title: string;
  displayNumber: number;
}

export interface OutputRevisionTargetSession {
  id: string;
  workspaceId: string;
  sessionFile?: string | undefined;
}

export function outputRevisionTargetKey(
  session: OutputRevisionTargetSession,
): string {
  if (session.sessionFile !== undefined) {
    // A native file is stable across runtime replacement. Workspace ownership
    // scopes it so a moved file or a same-path record in another workspace
    // cannot inherit this output's revision target.
    return `session:${JSON.stringify([session.workspaceId, session.sessionFile])}`;
  }
  return `runtime:${session.id}`;
}

export function outputRevisionTargetForSession(
  targets: Readonly<Record<string, OutputRevisionTarget>>,
  session: OutputRevisionTargetSession,
): OutputRevisionTarget | undefined {
  return targets[outputRevisionTargetKey(session)];
}

export function moveOutputRevisionTarget(
  targets: Readonly<Record<string, OutputRevisionTarget>>,
  from: OutputRevisionTargetSession,
  to: OutputRevisionTargetSession,
): Record<string, OutputRevisionTarget> {
  const fromKey = outputRevisionTargetKey(from);
  const target = targets[fromKey];
  if (target === undefined) return { ...targets };

  const toKey = outputRevisionTargetKey(to);
  const { [fromKey]: _moved, ...remaining } = targets;
  return { ...remaining, [toKey]: target };
}

export function removeOutputRevisionTarget(
  targets: Readonly<Record<string, OutputRevisionTarget>>,
  key: string,
): Record<string, OutputRevisionTarget> {
  if (targets[key] === undefined) return { ...targets };
  const { [key]: _removed, ...remaining } = targets;
  return remaining;
}
