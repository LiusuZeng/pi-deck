import { useEffect, useState } from "react";
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

function hasLiveElapsedClock(task: MultitaskTaskSummary): boolean {
  return (
    task.startedAtMs !== undefined &&
    !["completed", "failed", "interrupted"].includes(task.lifecycle)
  );
}

function displayedElapsedMs(task: MultitaskTaskSummary, nowMs: number): number {
  return hasLiveElapsedClock(task)
    ? Math.max(0, nowMs - task.startedAtMs!)
    : task.elapsedMs;
}

/** Safe, flat status projection for child task sessions; deliberately inert. */
export function TaskSessionPanel({
  activeCount,
  activeLimit,
  tasks,
}: TaskSessionPanelProps) {
  const [nowMs, setNowMs] = useState(Date.now);
  const hasLiveClock = tasks.some(hasLiveElapsedClock);

  useEffect(() => {
    if (!hasLiveClock) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasLiveClock]);

  if (tasks.length === 0) return null;
  return (
    <section className="task-session-panel" aria-label="Parallel task sessions">
      <header>
        <strong>Parallel tasks</strong>
        <span aria-live="polite">{`${activeCount} active of ${activeLimit}`}</span>
      </header>
      <div
        aria-label="Task session status"
        aria-live="polite"
        aria-relevant="all"
        role="list"
      >
        {tasks.map((task) => (
          <article key={task.taskNumber} role="listitem">
            <div className="task-session-panel__title">
              <strong title={`#${task.taskNumber} ${task.generatedName}`}>
                {`#${task.taskNumber} ${task.generatedName}`}
              </strong>
              <span data-lifecycle={task.lifecycle}>{task.lifecycle}</span>
            </div>
            <p className="task-session-panel__brief" title={task.brief}>
              {task.brief}
            </p>
            <small>{`Attempt ${task.attempt} · ${elapsedLabel(displayedElapsedMs(task, nowMs))}`}</small>
            {task.progress ? <small>{task.progress}</small> : null}
            {task.queueReason ? <small>{task.queueReason}</small> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
