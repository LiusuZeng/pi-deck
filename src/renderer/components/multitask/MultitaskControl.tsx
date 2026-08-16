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
  /** An action-oriented accessible label for the control. */
  label?: string;
  /** Prevents repeated activation while a task is being started. */
  loading?: boolean;
  /** Indicates that the most recent multitasking action could not be completed. */
  error?: boolean;
  type?: "button" | "submit" | "reset";
}

/**
 * An accessible, icon-only entry point for multitasking work.
 * Its hover/focus tooltip is intentionally status-only.
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
    tasks,
    type = "button",
    unavailableMessage,
    ...props
  },
  ref,
) {
  const accessibleLabel = loading
    ? "Loading multitasking status"
    : error
      ? "Multitasking status unavailable"
      : enabled
        ? (label ??
          `Multitasking: ${tasks.length} task${tasks.length === 1 ? "" : "s"}`)
        : (unavailableMessage ?? "Multitasking unavailable");
  const tooltipContent =
    tasks.length > 0 ? (
      <MultitaskStatusPopover tasks={tasks} />
    ) : (
      <span>{unavailableMessage ?? "No delegated tasks yet."}</span>
    );

  return (
    <Tooltip content={tooltipContent}>
      <button
        {...props}
        ref={ref}
        aria-busy={loading || undefined}
        aria-invalid={error || undefined}
        aria-label={accessibleLabel}
        className={[
          "ui-control",
          "ui-icon-button",
          "ui-control--md",
          "ui-icon-button--ghost",
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
      </button>
    </Tooltip>
  );
});
