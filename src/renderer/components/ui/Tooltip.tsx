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

/** A delayed hover tooltip that opens immediately for keyboard focus. */
export function Tooltip({
  children,
  content,
  delay = 500,
  shortcut,
}: TooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tooltipId = useId();

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const clearOpenTimer = () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const openAfterDelay = () => {
    clearOpenTimer();
    timerRef.current = setTimeout(() => {
      setIsOpen(true);
      timerRef.current = undefined;
    }, delay);
  };

  const close = () => {
    clearOpenTimer();
    setIsOpen(false);
  };

  const target = children.props;
  const describedBy = [target["aria-describedby"], tooltipId]
    .filter(Boolean)
    .join(" ");

  return (
    <span className="ui-tooltip-anchor">
      {cloneElement(children, {
        "aria-describedby": describedBy,
        onBlur: (event: FocusEvent<HTMLElement>) => {
          target.onBlur?.(event);
          close();
        },
        onFocus: (event: FocusEvent<HTMLElement>) => {
          target.onFocus?.(event);
          clearOpenTimer();
          setIsOpen(true);
        },
        onMouseEnter: (event: MouseEvent<HTMLElement>) => {
          target.onMouseEnter?.(event);
          openAfterDelay();
        },
        onMouseLeave: (event: MouseEvent<HTMLElement>) => {
          target.onMouseLeave?.(event);
          close();
        },
      })}
      {isOpen ? (
        <span className="ui-tooltip" id={tooltipId} role="tooltip">
          <span>{content}</span>
          {shortcut ? <kbd>{shortcut}</kbd> : null}
        </span>
      ) : null}
    </span>
  );
}
