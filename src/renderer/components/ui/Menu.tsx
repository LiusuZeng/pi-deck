import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isMenu = props.menu !== false;

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const closeOnPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) {
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
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [isMenu, isOpen]);

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
      menuRef.current?.querySelectorAll<HTMLElement>(
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
      {isOpen ? (
        <div
          className="ui-menu-popover"
          id={menuId}
          aria-label={props.menuLabel}
          role={isMenu ? "menu" : undefined}
          onClick={isMenu ? () => setIsOpen(false) : undefined}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
