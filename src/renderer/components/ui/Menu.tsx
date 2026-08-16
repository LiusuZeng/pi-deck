import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "./icons.js";
import { IconButton } from "./IconButton.js";
import type { LucideIcon } from "./icons.js";

export function Menu(props: {
  label: string;
  children: ReactNode;
  className?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  loading?: boolean;
  menuLabel?: string;
  /** Use false for a non-interactive information popover rather than a menu. */
  menu?: boolean;
}): ReactNode {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>();
  const isMenu = props.menu !== false;

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const closeOnPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnPointerDown);
    return () => document.removeEventListener("mousedown", closeOnPointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isMenu) {
      return;
    }
    popoverRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]')
      ?.focus();
  }, [isMenu, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPopoverStyle(undefined);
      return;
    }

    const positionPopover = (): void => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) {
        return;
      }

      const margin = 8;
      const gap = 6;
      const triggerBounds = trigger.getBoundingClientRect();
      const popoverBounds = popover.getBoundingClientRect();
      const maxLeft = Math.max(
        margin,
        window.innerWidth - margin - popoverBounds.width,
      );
      const maxTop = Math.max(
        margin,
        window.innerHeight - margin - popoverBounds.height,
      );
      const below = triggerBounds.bottom + gap;
      const above = triggerBounds.top - gap - popoverBounds.height;
      const top =
        below + popoverBounds.height <= window.innerHeight - margin
          ? below
          : Math.min(maxTop, Math.max(margin, above));

      setPopoverStyle({
        position: "fixed",
        right: "auto",
        left: Math.min(
          maxLeft,
          Math.max(margin, triggerBounds.right - popoverBounds.width),
        ),
        top,
      });
    };

    positionPopover();
    window.addEventListener("resize", positionPopover);
    document.addEventListener("scroll", positionPopover, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      document.removeEventListener("scroll", positionPopover, true);
    };
  }, [isOpen]);

  function closeAndRestoreFocus(): void {
    setIsOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (!isOpen || !isMenu) {
      return;
    }

    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([disabled]):not([aria-disabled="true"])',
      ) ?? [],
    );
    if (items.length === 0) {
      return;
    }
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex =
        currentIndex < 0
          ? items.length - 1
          : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    }

    if (nextIndex !== undefined) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  }

  return (
    <div
      className={`ui-menu ${props.className ?? ""}`}
      ref={menuRef}
      onKeyDown={onKeyDown}
    >
      <IconButton
        ref={triggerRef}
        aria-controls={isOpen ? menuId : undefined}
        aria-expanded={isOpen}
        aria-haspopup={isMenu ? "menu" : undefined}
        disabled={props.disabled}
        icon={props.icon ?? Ellipsis}
        label={props.label}
        loading={props.loading ?? false}
        pressed={isOpen}
        size="sm"
        onClick={() => setIsOpen((value) => !value)}
      />
      {isOpen
        ? createPortal(
            <div
              className={`ui-menu-popover ${props.className ?? ""}`}
              id={menuId}
              aria-label={props.menuLabel}
              ref={popoverRef}
              role={isMenu ? "menu" : undefined}
              style={popoverStyle ?? { position: "fixed" }}
              onClick={isMenu ? closeAndRestoreFocus : undefined}
            >
              {props.children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
