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
    loading = false,
    tasks,
    type = "button",
    ...props
  },
  ref,
) {
  const label = loading
    ? "Loading multitasking status"
    : error
      ? "Multitasking status unavailable"
      : enabled
        ? `Multitasking: ${tasks.length} task${tasks.length === 1 ? "" : "s"}`
        : "Multitasking unavailable";

  return (
    <Tooltip content={<MultitaskStatusPopover tasks={tasks} />}>
      <button
        {...props}
        ref={ref}
        aria-busy={loading || undefined}
        aria-invalid={error || undefined}
        aria-label={label}
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
