import type { ActivityScope } from "./activityInbox.js";

export type WorkScope = ActivityScope;

export type WorkflowSurface =
  | "agentHome"
  | "workflows"
  | "runs"
  | "builder"
  | "occurrenceRun"
  | "legacyRun";

export type WorkOrigin = {
  kind: "work";
  scope: WorkScope;
};

export type PrimaryView =
  | WorkOrigin
  | {
      kind: "session";
      sessionId: string;
      origin: WorkOrigin;
    }
  | {
      kind: "workflow";
      view: WorkflowSurface;
      origin: WorkOrigin;
    };

export function allWorkView(): WorkOrigin {
  return { kind: "work", scope: { type: "all" } };
}

export function isAllWorkPrimaryView(view: PrimaryView): boolean {
  return view.kind === "work" && view.scope.type === "all";
}

export function isWorkspaceWorkPrimaryView(
  view: PrimaryView,
  workspaceId: string,
): boolean {
  return (
    view.kind === "work" &&
    view.scope.type === "workspace" &&
    view.scope.workspaceId === workspaceId
  );
}

export function shouldFallbackToAllWorkAfterArchive(
  view: PrimaryView,
  archivedWorkspaceId: string,
  currentWorkspaceId: string,
): boolean {
  const origin =
    view.kind === "work"
      ? view
      : view.kind === "session" || view.kind === "workflow"
        ? view.origin
        : undefined;
  return (
    (origin !== undefined &&
      isWorkspaceWorkPrimaryView(origin, archivedWorkspaceId)) ||
    archivedWorkspaceId === currentWorkspaceId
  );
}

export function workspaceWorkView(workspaceId: string): WorkOrigin {
  return { kind: "work", scope: { type: "workspace", workspaceId } };
}

export function sessionView(
  sessionId: string,
  origin: WorkOrigin,
): Extract<PrimaryView, { kind: "session" }> {
  return { kind: "session", sessionId, origin };
}

export function workflowView(
  view: WorkflowSurface,
  origin: WorkOrigin,
): Extract<PrimaryView, { kind: "workflow" }> {
  return { kind: "workflow", view, origin };
}

export function workOriginForPrimaryView(
  view: PrimaryView,
  fallbackWorkspaceId: string,
): WorkOrigin {
  if (view.kind === "work") return view;
  if (view.kind === "session" || view.kind === "workflow") {
    return view.origin;
  }
  return workspaceWorkView(fallbackWorkspaceId);
}

export function workScopeForNewSession(
  view: PrimaryView,
  fallbackWorkspaceId: string,
): WorkScope {
  return workOriginForPrimaryView(view, fallbackWorkspaceId).scope;
}

export function backToWorkView(
  view: Extract<PrimaryView, { kind: "session" }>,
): WorkOrigin {
  return view.origin;
}

export function replaceSessionRouteId(
  view: PrimaryView,
  previousSessionId: string,
  nextSessionId: string,
): PrimaryView {
  return view.kind === "session" && view.sessionId === previousSessionId
    ? { ...view, sessionId: nextSessionId }
    : view;
}

export function workflowSidebarView(
  view: PrimaryView,
): WorkflowSurface | undefined {
  if (view.kind !== "workflow") return undefined;
  return view.view === "occurrenceRun" || view.view === "legacyRun"
    ? "runs"
    : view.view;
}

export function workScopeLabel(
  scope: WorkScope,
  workspaceNameById: Readonly<Record<string, string>> = {},
): string {
  if (scope.type === "all") return "All Work";
  return `Work · ${workspaceNameById[scope.workspaceId] ?? scope.workspaceId}`;
}
