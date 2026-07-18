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
}): ReactNode {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);

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

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setIsOpen(false);
    }
  }

  return (
    <div
      className={`ui-menu ${props.className ?? ""}`}
      ref={menuRef}
      onKeyDown={onKeyDown}
    >
      <IconButton
        aria-controls={menuId}
        aria-expanded={isOpen}
        icon={Ellipsis}
        label={props.label}
        pressed={isOpen}
        size="sm"
        onClick={() => setIsOpen((value) => !value)}
      />
      {isOpen ? (
        <div className="ui-menu-popover" id={menuId} role="menu">
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
