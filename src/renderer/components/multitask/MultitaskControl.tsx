import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Tooltip } from "../ui/Tooltip.js";
import { Multitask } from "../ui/icons.js";
import {
  MultitaskStatusPopover,
  type MultitaskTaskSummary,
} from "./MultitaskStatusPopover.js";

export interface MultitaskControlProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children" | "disabled" | "type"
> {
  /** A renderer-safe summary only; do not pass task content or result data. */
  tasks: readonly MultitaskTaskSummary[];
  /** Whether starting multitasking work is currently available. */
  enabled?: boolean;
  /** Explains why multitasking is unavailable, when applicable. */
  unavailableMessage?: string;
  /**
   * The current multitasking mode. Supplying this is preferred; `label` is
   * retained temporarily so existing callers can continue to convey the mode.
   */
  mode?: "parallel" | "sequential";
  /** @deprecated Pass `mode` instead. */
  label?: string;
  /** Prevents repeated activation while a task is being started. */
  loading?: boolean;
  /** Indicates that the most recent multitasking action could not be completed. */
  error?: boolean;
  type?: "button" | "submit" | "reset";
}

/**
 * An explicit parallel-mode toggle. Its hover/focus tooltip explains the mode
 * when no work has been delegated and presents task progress separately.
 */
export const MultitaskControl = forwardRef<
  HTMLButtonElement,
  MultitaskControlProps
>(function MultitaskControl(
  {
    className,
    enabled = true,
    error = false,
    label,
    loading = false,
    mode,
    tasks,
    type = "button",
    unavailableMessage,
    ...props
  },
  ref,
) {
  // `label` was the original action label ("Turn off…" / "Turn on…").
  // Read it only as a compatibility fallback while callers migrate to `mode`.
  const parallel =
    mode === "parallel" ||
    (mode === undefined && label?.toLowerCase().includes("turn off") === true);
  const modeState = parallel ? "On" : "Off";
  const accessibleLabel = `Parallel multitasking: ${modeState}`;
  const tooltipContent =
    tasks.length > 0 ? (
      <MultitaskStatusPopover tasks={tasks} />
    ) : (
      <span>
        {enabled
          ? parallel
            ? "Parallel multitasking is on. Pi can delegate independent work from your next prompt."
            : "Parallel multitasking is off. Enable it to let Pi delegate independent work."
          : (unavailableMessage ?? "Multitasking is unavailable.")}
      </span>
    );

  return (
    <Tooltip content={tooltipContent}>
      <button
        {...props}
        ref={ref}
        aria-busy={loading || undefined}
        aria-invalid={error || undefined}
        aria-label={accessibleLabel}
        aria-pressed={parallel}
        className={[
          "ui-control",
          "ui-control--md",
          "multitask-mode-control",
          "multitask-control",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        data-error={error ? "true" : undefined}
        data-loading={loading ? "true" : undefined}
        disabled={!enabled || loading}
        type={type}
      >
        <Multitask aria-hidden="true" focusable="false" strokeWidth={1.75} />
        <span>Parallel: {modeState}</span>
      </button>
    </Tooltip>
  );
});
