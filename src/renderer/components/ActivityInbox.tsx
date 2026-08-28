import { useMemo, type KeyboardEvent } from "react";
import type { WorkspaceUsageTotals } from "../../shared/types.js";
import type {
  ActivityInboxModel,
  ActivityItem,
  ActivityScope,
  ActivityStatus,
} from "../activityInbox.js";
import {
  ACTIVITY_STATUSES,
  filterActivityItems,
  tagsForScope,
  tagsForStatus,
} from "../activityInbox.js";
import { Check, CircleAlert, CircleDot, LoaderCircle } from "./ui/icons.js";

export type ActivityInboxFilter = "all" | ActivityStatus;

const ALL_WORK_LABEL = "All Work";

export interface ActivityWorkspace {
  id: string;
  name: string;
}

const ACTIVITY_META: Record<
  ActivityStatus,
  { emptyLabel: string; label: string; Icon: typeof CircleDot }
> = {
  needsAttention: {
    emptyLabel: "Needs attention",
    label: "Needs attention",
    Icon: CircleDot,
  },
  failed: { emptyLabel: "Failed", label: "Failed", Icon: CircleAlert },
  pending: { emptyLabel: "Pending", label: "Pending", Icon: CircleDot },
  inProgress: {
    emptyLabel: "In progress",
    label: "In progress",
    Icon: LoaderCircle,
  },
  completed: { emptyLabel: "Completed", label: "Completed", Icon: Check },
  idle: { emptyLabel: "Idle", label: "Idle", Icon: CircleDot },
};

function formatRelativeTime(timestamp: number): string {
  const elapsedMinutes = Math.max(
    0,
    Math.round((Date.now() - timestamp) / 60_000),
  );
  if (elapsedMinutes < 1) return "Just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const hours = Math.round(elapsedMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function finiteTimestamp(timestamp: number | undefined): number | undefined {
  return timestamp !== undefined && Number.isFinite(timestamp)
    ? timestamp
    : undefined;
}

function activityRowTimestamp(item: ActivityItem): number {
  const completedAtMs = finiteTimestamp(item.completedAtMs);
  return item.status === "completed" && completedAtMs !== undefined
    ? completedAtMs
    : item.updatedAtMs;
}

function activityRowTimestampLabel(
  item: ActivityItem,
): "Completed" | "Updated" {
  return item.status === "completed" &&
    finiteTimestamp(item.completedAtMs) !== undefined
    ? "Completed"
    : "Updated";
}

function workScopeLabel(
  scope: ActivityScope,
  workspaceName: string | undefined,
): string {
  if (scope.type === "all") {
    return ALL_WORK_LABEL;
  }
  return workspaceName === undefined
    ? "Workspace Work"
    : `${workspaceName} Work`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${formatCompactNumber(tokens, 1_000_000)}M tokens`;
  if (tokens >= 1_000) return `${formatCompactNumber(tokens, 1_000)}K tokens`;
  return `${Math.round(tokens).toLocaleString()} tokens`;
}

function formatCompactNumber(value: number, divisor: number): string {
  const scaled = value / divisor;
  return scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
}

function formatExactTokens(tokens: number): string {
  return Math.round(tokens).toLocaleString();
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function costSummary(usage: WorkspaceUsageTotals): string {
  if (usage.contributorsWithCost === 0 && usage.contributorsWithoutCost === 0) {
    return "No reported cost yet";
  }
  if (usage.contributorsWithCost === 0) {
    return `${usage.contributorsWithoutCost.toLocaleString()} executions without cost data`;
  }
  if (usage.contributorsWithoutCost > 0) {
    return `${formatUsd(usage.knownCostUsd)} known cost · ${usage.contributorsWithoutCost.toLocaleString()} executions without cost data`;
  }
  return `${formatUsd(usage.knownCostUsd)} reported cost`;
}

function availableActivityCount(model: ActivityInboxModel): number {
  // The workspace map is intentionally computed before scope/status filters;
  // use it instead of model.items.length when App supplies a scoped model.
  const availableCount = Object.values(model.availableWorkspaceCounts).reduce(
    (total, count) => total + count,
    0,
  );
  return availableCount;
}

export interface ActivityInboxProps {
  model: ActivityInboxModel;
  scope: ActivityScope;
  workspaces: readonly ActivityWorkspace[];
  usage?: WorkspaceUsageTotals | undefined;
  onOpenActivityItem: (item: ActivityItem) => void;
  onScopeChange: (scope: ActivityScope) => void;
  selectedFilter: ActivityInboxFilter;
  onSelectedFilterChange: (filter: ActivityInboxFilter) => void;
  /** Optional for compatibility with pre-CTA embedders. */
  onNewSession?: () => void;
}

/** A scoped, presentational Work overview. Classification and tags remain domain-owned. */
export function ActivityInbox({
  model,
  scope,
  workspaces,
  usage,
  onOpenActivityItem,
  onScopeChange,
  selectedFilter,
  onSelectedFilterChange,
  onNewSession,
}: ActivityInboxProps) {
  const workspaceName =
    scope.type === "workspace"
      ? workspaces.find((workspace) => workspace.id === scope.workspaceId)?.name
      : undefined;
  // Keep this boundary compatible with both global and pre-scoped models:
  // applying the same tag twice is idempotent while App transitions to a
  // single unscoped source model.
  const scopedItems = useMemo(
    () => filterActivityItems(model.items, tagsForScope(scope)),
    [model.items, scope],
  );
  const counts = useMemo(
    () =>
      ACTIVITY_STATUSES.reduce(
        (result, kind) => {
          result[kind] = filterActivityItems(
            scopedItems,
            tagsForStatus(kind),
          ).length;
          return result;
        },
        {} as Record<ActivityStatus, number>,
      ),
    [scopedItems],
  );
  const availableCount = availableActivityCount(model);
  const scopeLabel = workScopeLabel(scope, workspaceName);
  const description =
    scope.type === "all"
      ? "Monitor work across active workspaces and jump to sessions that need you."
      : "Monitor work in this workspace and jump to sessions that need you.";
  // Preserve domain model order within a status. Active supervision statuses
  // retain stable source order; Completed is already queued by completion time.
  const groups = useMemo(
    () =>
      ACTIVITY_STATUSES.reduce(
        (result, kind) => {
          result[kind] = filterActivityItems(scopedItems, tagsForStatus(kind));
          return result;
        },
        {} as Record<ActivityStatus, ActivityItem[]>,
      ),
    [scopedItems],
  );
  const visibleKinds =
    selectedFilter === "all" ? ACTIVITY_STATUSES : [selectedFilter];
  const visibleItems = visibleKinds.flatMap((kind) => groups[kind]);
  const showWorkspaceControls = workspaces.length > 0;
  const showWorkspaceContext = scope.type === "all" && workspaces.length > 0;

  return (
    <main
      aria-describedby="activity-inbox-description"
      aria-labelledby="activity-inbox-title"
      className="activity-inbox"
    >
      <header className="activity-inbox-header">
        <div>
          <p className="activity-inbox-eyebrow">
            {scope.type === "all" ? ALL_WORK_LABEL : "Workspace Work"}
          </p>
          <h1 id="activity-inbox-title" tabIndex={-1}>
            {scopeLabel}
          </h1>
          <p
            className="activity-inbox-description"
            id="activity-inbox-description"
          >
            {description}
          </p>
          {scope.type === "workspace" && usage !== undefined ? (
            <details className="activity-inbox-usage">
              <summary>
                <span>Usage</span>
                <strong>{formatCompactTokens(usage.totalTokens)}</strong>
                <span>{costSummary(usage)}</span>
              </summary>
              <dl aria-label="Workspace usage breakdown">
                <div>
                  <dt>Total tokens</dt>
                  <dd>{formatExactTokens(usage.totalTokens)}</dd>
                </div>
                <div>
                  <dt>Input</dt>
                  <dd>{formatExactTokens(usage.inputTokens)}</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{formatExactTokens(usage.outputTokens)}</dd>
                </div>
                <div>
                  <dt>Cache read</dt>
                  <dd>{formatExactTokens(usage.cacheReadTokens)}</dd>
                </div>
                <div>
                  <dt>Cache write</dt>
                  <dd>{formatExactTokens(usage.cacheWriteTokens)}</dd>
                </div>
                <div>
                  <dt>Reported cost</dt>
                  <dd>{costSummary(usage)}</dd>
                </div>
              </dl>
            </details>
          ) : null}
        </div>
      </header>

      {showWorkspaceControls ? (
        <label
          className="activity-inbox-workspace-filter"
          htmlFor="activity-inbox-workspace-scope"
        >
          <span id="activity-inbox-workspace-scope-label">
            Current Work scope
          </span>
          <select
            aria-describedby="activity-inbox-scope-status"
            aria-label="Current Work scope"
            id="activity-inbox-workspace-scope"
            onChange={(event) =>
              onScopeChange(
                event.target.value === "all"
                  ? { type: "all" }
                  : { type: "workspace", workspaceId: event.target.value },
              )
            }
            value={scope.type === "workspace" ? scope.workspaceId : "all"}
          >
            <option value="all">
              {ALL_WORK_LABEL} ({availableCount})
            </option>
            {workspaces.map((workspace) => {
              const count = model.availableWorkspaceCounts[workspace.id] ?? 0;
              return (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name} ({count})
                </option>
              );
            })}
          </select>
        </label>
      ) : null}
      <span
        aria-live="polite"
        className="activity-inbox-scope-status sr-only"
        id="activity-inbox-scope-status"
      >
        Current scope: {scopeLabel}.
      </span>

      <div
        aria-controls="activity-inbox-content"
        aria-describedby="activity-inbox-scope-status"
        aria-label="Filter Work by status"
        className="activity-inbox-filters"
        role="group"
      >
        <button
          aria-pressed={selectedFilter === "all"}
          className="activity-inbox-filter"
          onClick={() => onSelectedFilterChange("all")}
          type="button"
        >
          <span>All</span>
          <span className="activity-inbox-filter-count">
            {scopedItems.length}
          </span>
        </button>
        {ACTIVITY_STATUSES.map((kind) => {
          const meta = ACTIVITY_META[kind];
          return (
            <button
              aria-pressed={selectedFilter === kind}
              className="activity-inbox-filter"
              key={kind}
              onClick={() => onSelectedFilterChange(kind)}
              type="button"
            >
              <span>{meta.label}</span>
              <span className="activity-inbox-filter-count">
                {counts[kind]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="activity-inbox-content" id="activity-inbox-content">
        {visibleItems.length === 0 ? (
          <EmptyState
            filter={selectedFilter}
            {...(onNewSession === undefined ? {} : { onNewSession })}
            scopeLabel={scopeLabel}
          />
        ) : (
          visibleKinds.map((kind) => {
            const items = groups[kind];
            return items.length > 0 ? (
              <ActivitySection
                items={items}
                showWorkspaceContext={showWorkspaceContext}
                key={kind}
                kind={kind}
                onOpenActivityItem={onOpenActivityItem}
              />
            ) : null;
          })
        )}
      </div>
    </main>
  );
}

function EmptyState({
  filter,
  onNewSession,
  scopeLabel,
}: {
  filter: ActivityInboxFilter;
  onNewSession?: () => void;
  scopeLabel: string;
}) {
  const message =
    filter === "all"
      ? `No work in ${scopeLabel}. Start a session to see it here.`
      : `No ${ACTIVITY_META[filter].emptyLabel.toLowerCase()} work in ${scopeLabel}.`;

  return (
    <div className="activity-inbox-empty" role="status">
      <h2>{filter === "all" ? "No work yet" : "No matching work"}</h2>
      <p>{message}</p>
      {filter === "all" && onNewSession !== undefined ? (
        <button
          className="activity-inbox-empty-action"
          onClick={onNewSession}
          type="button"
        >
          New session
        </button>
      ) : null}
    </div>
  );
}

function ActivitySection({
  items,
  kind,
  onOpenActivityItem,
  showWorkspaceContext,
}: {
  items: ActivityItem[];
  kind: ActivityStatus;
  onOpenActivityItem: (item: ActivityItem) => void;
  showWorkspaceContext: boolean;
}) {
  const { Icon, label } = ACTIVITY_META[kind];
  const headingId = `activity-inbox-${kind}`;

  return (
    <section className="activity-inbox-section" aria-labelledby={headingId}>
      <h2 id={headingId}>
        <Icon aria-hidden="true" focusable="false" />
        {label}
        <span className="activity-inbox-section-count">{items.length}</span>
      </h2>
      <div className="activity-inbox-list">
        {items.map((item) => (
          <ActivityRow
            item={item}
            showWorkspaceContext={showWorkspaceContext}
            key={item.id}
            onOpenActivityItem={onOpenActivityItem}
          />
        ))}
      </div>
    </section>
  );
}

function ActivityRow({
  item,
  onOpenActivityItem,
  showWorkspaceContext,
}: {
  item: ActivityItem;
  onOpenActivityItem: (item: ActivityItem) => void;
  showWorkspaceContext: boolean;
}) {
  const kind = item.status;
  const { Icon, label } = ACTIVITY_META[kind];
  const timestampMs = activityRowTimestamp(item);
  const timestampLabel = activityRowTimestampLabel(item);
  const relativeTime = formatRelativeTime(timestampMs);
  const workspaceContext = showWorkspaceContext
    ? `, ${item.workspaceName}`
    : "";
  const activate = () => onOpenActivityItem(item);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  };

  return (
    <button
      aria-label={`${label}: ${item.title}${workspaceContext}. ${item.detail}. ${timestampLabel} ${relativeTime}. ${item.actionLabel}.`}
      className={`activity-inbox-row activity-inbox-row--${kind}`}
      data-activity-item-id={item.id}
      onClick={activate}
      onKeyDown={onKeyDown}
      type="button"
    >
      <span className="activity-inbox-status" aria-hidden="true">
        <Icon focusable="false" />
        <span>{label}</span>
      </span>
      <span className="activity-inbox-row-copy">
        <span className="activity-inbox-row-title">{item.title}</span>
        {showWorkspaceContext ? (
          <span className="activity-inbox-row-context">
            {item.workspaceName}
          </span>
        ) : null}
        <span className="activity-inbox-row-detail">{item.detail}</span>
      </span>
      <span className="activity-inbox-row-meta">
        <time
          dateTime={new Date(timestampMs).toISOString()}
          title={formatTimestamp(timestampMs)}
        >
          {relativeTime}
        </time>
        <span className="activity-inbox-row-action">{item.actionLabel}</span>
      </span>
    </button>
  );
}
