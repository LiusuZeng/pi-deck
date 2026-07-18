import {
  cloneElement,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

type TooltipTargetProps = {
  "aria-describedby"?: string;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
};

export interface TooltipProps {
  children: ReactElement<TooltipTargetProps>;
  content: ReactNode;
  delay?: number;
  shortcut?: string | undefined;
}

type TooltipPosition = {
  left: number;
  top: number;
};

/** A delayed hover tooltip that opens immediately for keyboard focus. */
export function Tooltip({
  children,
  content,
  delay = 500,
  shortcut,
}: TooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | undefined>();
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tooltipId = useId();

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // A fixed tooltip must not remain detached from its control after a scroll
    // or resize. It will reopen at the correct location on the next focus/hover.
    const close = () => setIsOpen(false);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [isOpen]);

  const clearOpenTimer = () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const setTooltipPosition = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setPosition({ left: rect.left + rect.width / 2, top: rect.top - 7 });
  };

  const openAfterDelay = (target: HTMLElement) => {
    clearOpenTimer();
    timerRef.current = setTimeout(() => {
      setTooltipPosition(target);
      setIsOpen(true);
      timerRef.current = undefined;
    }, delay);
  };

  const close = () => {
    clearOpenTimer();
    setIsOpen(false);
  };

  const target = children.props;
  const describedBy = isOpen
    ? [target["aria-describedby"], tooltipId].filter(Boolean).join(" ")
    : target["aria-describedby"];

  const tooltipTargetProps: TooltipTargetProps = {
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      target.onBlur?.(event);
      close();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      target.onFocus?.(event);
      clearOpenTimer();
      setTooltipPosition(event.currentTarget);
      setIsOpen(true);
    },
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      target.onMouseEnter?.(event);
      openAfterDelay(event.currentTarget);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      target.onMouseLeave?.(event);
      close();
    },
  };

  return (
    <>
      {cloneElement(children, tooltipTargetProps)}
      {isOpen && position !== undefined ? (
        <span
          className="ui-tooltip"
          id={tooltipId}
          role="tooltip"
          style={{ left: position.left, top: position.top }}
        >
          <span>{content}</span>
          {shortcut ? <kbd>{shortcut}</kbd> : null}
        </span>
      ) : null}
    </>
  );
}
