import {
  getQueuedCount,
  type BaseSessionState,
  type SessionOverlays,
} from "./sessionState.js";

export type ActivityStatus =
  | "needsAttention"
  | "failed"
  | "queued"
  | "inProgress"
  | "completed";

/** @deprecated Use ActivityStatus. */
export type ActivityKind = ActivityStatus;

export const ACTIVITY_STATUSES = [
  "needsAttention",
  "failed",
  "queued",
  "inProgress",
  "completed",
] as const satisfies readonly ActivityStatus[];

/** @deprecated Use ACTIVITY_STATUSES. */
export const ACTIVITY_KINDS = ACTIVITY_STATUSES;

export type ActivityTag =
  | `workspace:${string}`
  | `status:${ActivityStatus}`
  | "kind:session"
  | "visibility:archived";

export interface ActivityFilter {
  includeAll?: readonly ActivityTag[];
  exclude?: readonly ActivityTag[];
}

export type ActivityScope =
  | { type: "all" }
  | { type: "workspace"; workspaceId: string };

export interface ActivitySourceSession {
  /** Runtime id or stable saved-session id. */
  id: string;
  workspaceId: string;
  sessionFile?: string;
  sessionId?: string;
  runtimeId?: string;
  title: string;
  workspaceName: string;
  updatedAtMs: number;
  baseState: BaseSessionState;
  overlays: SessionOverlays;
  status?: string;
  completedAtMs?: number;
  lastError?: string;
  /** Unsaved composer/session draft; drafts are not activity items. */
  draftSession?: boolean;
  /** Present for either an archived session or archived workspace membership. */
  archivedAtMs?: number;
}

export interface ActivityItem {
  /** `activity:<workspaceId>:<sessionKey>`; stable across workspace renames. */
  id: string;
  /** sessionFile when available, otherwise the source id. */
  sessionKey: string;
  workspaceId: string;
  workspaceName: string;
  sessionFile?: string;
  sessionId?: string;
  runtimeId?: string;
  status: ActivityStatus;
  tags: readonly ActivityTag[];
  title: string;
  detail: string;
  updatedAtMs: number;
  completedAtMs?: number;
  actionLabel: string;
}

export interface ActivityInboxModel {
  items: ActivityItem[];
  groups: Record<ActivityStatus, ActivityItem[]>;
  counts: Record<ActivityStatus, number>;
  actionableCount: number;
  totalCount: number;
  /** Total non-archived items per workspace before scope/status filtering. */
  availableWorkspaceCounts: Readonly<Record<string, number>>;
}

const actionLabels: Record<ActivityStatus, string> = {
  needsAttention: "Respond",
  failed: "Review failure",
  queued: "View queued work",
  inProgress: "View progress",
  completed: "View result",
};

const archivedTag: ActivityTag = "visibility:archived";

export function buildActivityInbox(
  sources: readonly ActivitySourceSession[],
  filter: ActivityFilter = {},
): ActivityInboxModel {
  const normalizedItems = sources.flatMap((source) =>
    normalizeActivity(source),
  );
  const availableWorkspaceItems = filterActivityItems(
    normalizedItems,
    withDefaultArchiveExclusion({}),
  );
  const items = filterActivityItems(
    normalizedItems,
    withDefaultArchiveExclusion(filter),
  );
  const groups = createEmptyGroups();

  for (const item of items) {
    groups[item.status].push(item);
  }
  // Keep activity recency display-only for active supervision statuses.
  // Completed is an explicit follow-up queue ordered by completion time.
  for (const status of ACTIVITY_STATUSES) {
    groups[status].sort((left, right) =>
      compareActivityItemsForStatus(status, left, right),
    );
  }
  const counts = countActivityStatuses(items);
  const orderedItems = ACTIVITY_STATUSES.flatMap((status) => groups[status]);

  return {
    items: orderedItems,
    groups,
    counts,
    actionableCount: actionableActivityCount(counts),
    totalCount: orderedItems.length,
    availableWorkspaceCounts: countActivityWorkspaces(availableWorkspaceItems),
  };
}

/** Applies tag intersection filtering without mutating the source list. */
export function filterActivityItems(
  items: readonly ActivityItem[],
  filter: ActivityFilter = {},
): ActivityItem[] {
  const includeAll = filter.includeAll ?? [];
  const exclude = filter.exclude ?? [];
  return items.filter(
    (item) =>
      includeAll.every((tag) => item.tags.includes(tag)) &&
      !exclude.some((tag) => item.tags.includes(tag)),
  );
}

export function tagsForScope(scope: ActivityScope): ActivityFilter {
  return scope.type === "all"
    ? {}
    : { includeAll: [workspaceTag(scope.workspaceId)] };
}

export function tagsForStatus(status: ActivityStatus): ActivityFilter {
  return { includeAll: [statusTag(status)] };
}

export function workspaceTag(workspaceId: string): ActivityTag {
  return `workspace:${workspaceId}`;
}

export function statusTag(status: ActivityStatus): ActivityTag {
  return `status:${status}`;
}

export function classifyActivity(
  source: ActivitySourceSession,
): ActivityStatus | undefined {
  if (source.draftSession === true) {
    return undefined;
  }
  if (
    source.baseState === "waitingForInput" ||
    source.overlays.needsUserInput
  ) {
    return "needsAttention";
  }
  if (source.baseState === "error") {
    return "failed";
  }
  if (getQueuedCount(source.overlays) > 0) {
    return "queued";
  }
  if (isInProgress(source)) {
    return "inProgress";
  }
  if (hasCompletionTimestamp(source.completedAtMs)) {
    return "completed";
  }
  return undefined;
}

export function compareActivityItemsForStatus(
  status: ActivityStatus,
  left: ActivityItem,
  right: ActivityItem,
): number {
  if (status !== "completed") {
    return 0;
  }
  const leftCompletedAtMs = finiteTimestamp(left.completedAtMs);
  const rightCompletedAtMs = finiteTimestamp(right.completedAtMs);
  if (
    leftCompletedAtMs !== undefined &&
    rightCompletedAtMs !== undefined &&
    leftCompletedAtMs !== rightCompletedAtMs
  ) {
    return leftCompletedAtMs - rightCompletedAtMs;
  }
  if (leftCompletedAtMs !== undefined && rightCompletedAtMs === undefined) {
    return -1;
  }
  if (leftCompletedAtMs === undefined && rightCompletedAtMs !== undefined) {
    return 1;
  }
  return left.id.localeCompare(right.id);
}

export function countActivityStatuses(
  items: readonly ActivityItem[],
): Record<ActivityStatus, number> {
  const counts = Object.fromEntries(
    ACTIVITY_STATUSES.map((status) => [status, 0]),
  ) as Record<ActivityStatus, number>;
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}

export function actionableActivityCount(
  counts: Readonly<Record<ActivityStatus, number>>,
): number {
  return counts.needsAttention + counts.failed + counts.queued;
}

export function countActivityWorkspaces(
  items: readonly ActivityItem[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.workspaceId] = (counts[item.workspaceId] ?? 0) + 1;
  }
  return counts;
}

function normalizeActivity(source: ActivitySourceSession): ActivityItem[] {
  const status = classifyActivity(source);
  if (status === undefined) {
    return [];
  }
  const sessionKey = source.sessionFile ?? source.id;
  const completedAtMs =
    status === "completed" ? finiteTimestamp(source.completedAtMs) : undefined;
  return [
    {
      id: `activity:${source.workspaceId}:${sessionKey}`,
      sessionKey,
      workspaceId: source.workspaceId,
      workspaceName: source.workspaceName,
      ...(source.sessionFile === undefined
        ? {}
        : { sessionFile: source.sessionFile }),
      ...(source.sessionId === undefined
        ? {}
        : { sessionId: source.sessionId }),
      ...(source.runtimeId === undefined
        ? {}
        : { runtimeId: source.runtimeId }),
      status,
      tags: activityTags(source, status),
      title: source.title,
      detail: activityDetail(source, status),
      updatedAtMs: source.updatedAtMs,
      ...(completedAtMs === undefined ? {} : { completedAtMs }),
      actionLabel: actionLabels[status],
    },
  ];
}

export function activityTags(
  source: ActivitySourceSession,
  status: ActivityStatus,
): readonly ActivityTag[] {
  return [
    workspaceTag(source.workspaceId),
    statusTag(status),
    "kind:session",
    ...(source.archivedAtMs === undefined ? [] : [archivedTag]),
  ];
}

function withDefaultArchiveExclusion(filter: ActivityFilter): ActivityFilter {
  if (filter.includeAll?.includes(archivedTag)) {
    return filter;
  }
  return { ...filter, exclude: [...(filter.exclude ?? []), archivedTag] };
}

function createEmptyGroups(): Record<ActivityStatus, ActivityItem[]> {
  return {
    needsAttention: [],
    failed: [],
    queued: [],
    inProgress: [],
    completed: [],
  };
}

function isInProgress(source: ActivitySourceSession): boolean {
  return (
    source.baseState === "attaching" ||
    source.baseState === "working" ||
    source.overlays.streaming ||
    source.overlays.toolRunning ||
    source.overlays.compacting ||
    source.overlays.retrying ||
    ["starting", "sending", "reconnecting", "aborting", "working"].includes(
      source.status ?? "",
    )
  );
}

function hasCompletionTimestamp(value: number | undefined): boolean {
  return finiteTimestamp(value) !== undefined;
}

function finiteTimestamp(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function activityDetail(
  source: ActivitySourceSession,
  status: ActivityStatus,
): string {
  switch (status) {
    case "needsAttention":
      return "Waiting for your response";
    case "failed":
      return source.lastError ?? "The latest run failed";
    case "queued":
      return queuedDetail(source.overlays);
    case "inProgress":
      return inProgressDetail(source);
    case "completed":
      return "Latest turn completed";
  }
}

function queuedDetail(overlays: SessionOverlays): string {
  const details: string[] = [];
  if (overlays.localQueuedStartCount > 0) {
    details.push(quantity(overlays.localQueuedStartCount, "start"));
  }
  if (overlays.piQueuedSteeringCount > 0) {
    details.push(
      quantity(overlays.piQueuedSteeringCount, "steering instruction"),
    );
  }
  if (overlays.piQueuedFollowUpCount > 0) {
    details.push(quantity(overlays.piQueuedFollowUpCount, "follow-up"));
  }
  return details.join(" · ");
}

function quantity(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"} queued`;
}

function inProgressDetail(source: ActivitySourceSession): string {
  if (source.status === "starting" || source.baseState === "attaching") {
    return "Starting session";
  }
  if (source.status === "sending") {
    return "Sending message";
  }
  if (source.status === "reconnecting") {
    return "Reconnecting";
  }
  if (source.status === "aborting") {
    return "Aborting current turn";
  }
  if (source.overlays.compacting) {
    return "Compacting context";
  }
  if (source.overlays.retrying) {
    return "Retrying";
  }
  if (source.overlays.toolRunning) {
    return "Running a tool";
  }
  return "Working";
}
