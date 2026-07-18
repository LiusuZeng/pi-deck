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

export function Menu(props: {
  label: string;
  children: ReactNode;
  className?: string;
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
        icon={Ellipsis}
        label={props.label}
        pressed={isOpen}
        size="sm"
        onClick={() => setIsOpen((value) => !value)}
      />
      {isOpen ? (
        <div
          className="ui-menu-popover"
          id={menuId}
          role={isMenu ? "menu" : undefined}
          onClick={isMenu ? () => setIsOpen(false) : undefined}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
