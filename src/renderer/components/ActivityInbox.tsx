import { useMemo, useState, type KeyboardEvent } from "react";
import type {
  ActivityInboxModel,
  ActivityItem,
  ActivityScope,
  ActivityStatus,
} from "../activityInbox.js";
import { ACTIVITY_STATUSES, workspaceTag } from "../activityInbox.js";
import { Check, CircleAlert, CircleDot, LoaderCircle, X } from "./ui/icons.js";

type ActivityFilter = "all" | ActivityStatus;

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

export interface ActivityInboxProps {
  model: ActivityInboxModel;
  scope: ActivityScope;
  workspaces: readonly ActivityWorkspace[];
  onOpenActivityItem: (item: ActivityItem) => void;
  onScopeChange: (scope: ActivityScope) => void;
  onClose: () => void;
}

/** A scoped, presentational activity feed. Classification and tags remain domain-owned. */
export function ActivityInbox({
  model,
  scope,
  workspaces,
  onOpenActivityItem,
  onScopeChange,
  onClose,
}: ActivityInboxProps) {
  const [selectedFilter, setSelectedFilter] = useState<ActivityFilter>("all");
  const workspaceName =
    scope.type === "workspace"
      ? workspaces.find((workspace) => workspace.id === scope.workspaceId)?.name
      : undefined;
  const scopedItems = useMemo(
    () =>
      model.items.filter(
        (item) =>
          scope.type === "all" ||
          item.tags.includes(workspaceTag(scope.workspaceId)),
      ),
    [model.items, scope],
  );
  const counts = useMemo(
    () =>
      ACTIVITY_STATUSES.reduce(
        (result, kind) => {
          result[kind] = scopedItems.filter(
            (item) => item.status === kind,
          ).length;
          return result;
        },
        {} as Record<ActivityStatus, number>,
      ),
    [scopedItems],
  );
  const groups = useMemo(
    () =>
      ACTIVITY_STATUSES.reduce(
        (result, kind) => {
          result[kind] = scopedItems
            .filter((item) => item.status === kind)
            .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs);
          return result;
        },
        {} as Record<ActivityStatus, ActivityItem[]>,
      ),
    [scopedItems],
  );
  const visibleKinds =
    selectedFilter === "all" ? ACTIVITY_STATUSES : [selectedFilter];
  const visibleItems = visibleKinds.flatMap((kind) => groups[kind]);
  const scopeLabel = workspaceName ?? "All workspaces";

  return (
    <main className="activity-inbox" aria-labelledby="activity-inbox-title">
      <header className="activity-inbox-header">
        <div>
          <p className="activity-inbox-eyebrow">
            {scope.type === "all" ? "All workspaces" : "Workspace activity"}
          </p>
          <h1 id="activity-inbox-title">
            {workspaceName ? `Activity · ${workspaceName}` : "Activity"}
          </h1>
          <p className="activity-inbox-description">
            Monitor work in progress and jump to sessions that need you.
          </p>
        </div>
        <button
          aria-label="Close activity inbox"
          className="activity-inbox-close"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" focusable="false" />
        </button>
      </header>

      <label className="activity-inbox-workspace-filter">
        <span>Workspace</span>
        <select
          aria-label="Activity workspace"
          onChange={(event) =>
            onScopeChange(
              event.target.value === "all"
                ? { type: "all" }
                : { type: "workspace", workspaceId: event.target.value },
            )
          }
          value={scope.type === "workspace" ? scope.workspaceId : "all"}
        >
          <option value="all">All workspaces ({model.items.length})</option>
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

      <div
        className="activity-inbox-filters"
        aria-label="Filter activity status"
      >
        <button
          aria-pressed={selectedFilter === "all"}
          className="activity-inbox-filter"
          onClick={() => setSelectedFilter("all")}
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
              onClick={() => setSelectedFilter(kind)}
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

      <div className="activity-inbox-content">
        {visibleItems.length === 0 ? (
          <EmptyState filter={selectedFilter} scopeLabel={scopeLabel} />
        ) : (
          visibleKinds.map((kind) => {
            const items = groups[kind];
            return items.length > 0 ? (
              <ActivitySection
                isGlobalScope={scope.type === "all"}
                items={items}
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
  scopeLabel,
}: {
  filter: ActivityFilter;
  scopeLabel: string;
}) {
  const message =
    filter === "all"
      ? `No activity in ${scopeLabel}. Start work in a session to see it here.`
      : `No ${ACTIVITY_META[filter].emptyLabel.toLowerCase()} activity in ${scopeLabel}.`;

  return (
    <div className="activity-inbox-empty" role="status">
      <h2>{filter === "all" ? "No activity yet" : "Nothing here"}</h2>
      <p>{message}</p>
    </div>
  );
}

function ActivitySection({
  isGlobalScope,
  items,
  kind,
  onOpenActivityItem,
}: {
  isGlobalScope: boolean;
  items: ActivityItem[];
  kind: ActivityStatus;
  onOpenActivityItem: (item: ActivityItem) => void;
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
            isGlobalScope={isGlobalScope}
            item={item}
            key={item.id}
            onOpenActivityItem={onOpenActivityItem}
          />
        ))}
      </div>
    </section>
  );
}

function ActivityRow({
  isGlobalScope,
  item,
  onOpenActivityItem,
}: {
  isGlobalScope: boolean;
  item: ActivityItem;
  onOpenActivityItem: (item: ActivityItem) => void;
}) {
  const kind = item.status;
  const { Icon, label } = ACTIVITY_META[kind];
  const relativeTime = formatRelativeTime(item.updatedAtMs);
  const activate = () => onOpenActivityItem(item);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  };

  return (
    <button
      aria-label={`${label}: ${item.title}, ${item.workspaceName}. ${item.actionLabel}.`}
      className={`activity-inbox-row activity-inbox-row--${kind}`}
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
        {isGlobalScope ? (
          <span className="activity-inbox-row-context">
            {item.workspaceName}
          </span>
        ) : null}
        <span className="activity-inbox-row-detail">{item.detail}</span>
      </span>
      <span className="activity-inbox-row-meta">
        <time
          dateTime={new Date(item.updatedAtMs).toISOString()}
          title={formatTimestamp(item.updatedAtMs)}
        >
          {relativeTime}
        </time>
        <span className="activity-inbox-row-action">{item.actionLabel}</span>
      </span>
    </button>
  );
}
