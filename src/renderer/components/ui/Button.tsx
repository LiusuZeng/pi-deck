import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type ButtonVariant = "subtle" | "solid" | "danger" | "menuItem";
type ControlSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> {
  children: ReactNode;
  loading?: boolean;
  size?: ControlSize;
  type?: "button" | "submit" | "reset";
  variant?: ButtonVariant;
}

/** A compact text control for actions whose wording is needed for comprehension. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      className,
      disabled = false,
      loading = false,
      size = "md",
      type = "button",
      variant = "subtle",
      ...props
    },
    ref,
  ) {
    const classes = [
      "ui-control",
      "ui-button",
      `ui-control--${size}`,
      `ui-button--${variant}`,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        {...props}
        ref={ref}
        aria-busy={loading || undefined}
        className={classes}
        data-loading={loading ? "true" : undefined}
        disabled={disabled || loading}
        type={type}
      >
        {children}
      </button>
    );
  },
);
