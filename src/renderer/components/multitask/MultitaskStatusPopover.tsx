/** A renderer-safe snapshot of a task. Deliberately contains no task payload. */
export interface MultitaskTaskSummary {
  generatedName: string;
  taskNumber: number;
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
    <span className="multitask-status-popover">
      <span className="multitask-status-popover__heading">Task status</span>
      <span aria-label="Task statuses" role="list">
        {tasks.map((task) => (
          <span key={task.taskNumber} role="listitem">
            {`#${task.taskNumber} ${task.generatedName} — ${task.status}`}
          </span>
        ))}
      </span>
    </span>
  );
}
