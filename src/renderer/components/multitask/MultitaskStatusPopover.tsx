/** A renderer-safe snapshot of a task. Deliberately contains no task payload. */
export interface MultitaskTaskSummary {
  name: string;
  number: number;
  status: string;
}

export interface MultitaskStatusPopoverProps {
  /** Tasks to show, including tasks whose status is `queued`. */
  tasks: readonly MultitaskTaskSummary[];
}

/**
 * Presentational content for the multitasking hover/focus popover.
 *
 * This component intentionally has no focusable descendants or event handlers:
 * task status is informational only and cannot navigate into a task.
 */
export function MultitaskStatusPopover({ tasks }: MultitaskStatusPopoverProps) {
  return (
    <span
      className="multitask-status-popover"
      aria-label="Task statuses"
      role="list"
    >
      {tasks.map((task) => (
        <span key={task.number} role="listitem">
          {`#${task.number} ${task.name} — ${task.status}`}
        </span>
      ))}
    </span>
  );
}
