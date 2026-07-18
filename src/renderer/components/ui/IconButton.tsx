import type { ButtonHTMLAttributes } from "react";
import { Tooltip } from "./Tooltip.js";
import type { LucideIcon } from "./icons.js";

type IconButtonVariant = "ghost" | "outline" | "solid" | "danger";
type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "aria-pressed" | "children" | "type"
> {
  icon: LucideIcon;
  label: string;
  loading?: boolean;
  pressed?: boolean;
  shortcut?: string;
  size?: IconButtonSize;
  type?: "button" | "submit" | "reset";
  variant?: IconButtonVariant;
}

/**
 * An icon-only control with a required accessible name and matching tooltip.
 * Loading leaves the icon in place so the control does not change dimensions.
 */
export function IconButton({
  className,
  disabled = false,
  icon: Icon,
  label,
  loading = false,
  pressed,
  shortcut,
  size = "md",
  type = "button",
  variant = "ghost",
  ...props
}: IconButtonProps) {
  const classes = [
    "ui-control",
    "ui-icon-button",
    `ui-control--${size}`,
    `ui-icon-button--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        {...props}
        aria-busy={loading || undefined}
        aria-label={label}
        aria-pressed={pressed}
        className={classes}
        data-loading={loading ? "true" : undefined}
        disabled={disabled || loading}
        type={type}
      >
        <Icon aria-hidden="true" focusable="false" strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}
