import type { MultitaskTaskSummary } from "../../../shared/types.js";

export interface TaskSessionPanelProps {
  activeCount: number;
  activeLimit: number;
  tasks: readonly MultitaskTaskSummary[];
}

function elapsedLabel(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Safe, flat status projection for child task sessions; deliberately inert. */
export function TaskSessionPanel({
  activeCount,
  activeLimit,
  tasks,
}: TaskSessionPanelProps) {
  if (tasks.length === 0) return null;
  return (
    <section className="task-session-panel" aria-label="Parallel task sessions">
      <header>
        <strong>Parallel tasks</strong>
        <span aria-live="polite">{`${activeCount} active of ${activeLimit}`}</span>
      </header>
      <div aria-label="Task session status" role="list">
        {tasks.map((task) => (
          <article key={task.taskNumber} role="listitem">
            <div className="task-session-panel__title">
              <strong>{`#${task.taskNumber} ${task.generatedName}`}</strong>
              <span data-lifecycle={task.lifecycle}>{task.lifecycle}</span>
            </div>
            <p>{task.brief}</p>
            <small>{`Attempt ${task.attempt} · ${elapsedLabel(task.elapsedMs)}`}</small>
            {task.progress ? <small>{task.progress}</small> : null}
            {task.queueReason ? <small>{task.queueReason}</small> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
