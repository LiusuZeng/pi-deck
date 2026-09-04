import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import type { ChatModelSummary } from "../../shared/types.js";
import { modelPickerLabelParts } from "../modelPickerLabels.js";
import { Button } from "./ui/Button.js";
import { Check, ChevronDown, ChevronRight } from "./ui/icons.js";

export function nextMenuItemIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | undefined {
  if (itemCount === 0) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return (currentIndex + 1 + itemCount) % itemCount;
  if (key === "ArrowUp") return (currentIndex - 1 + itemCount) % itemCount;
  return undefined;
}

function directMenuItems(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return [];
  return Array.from(menu.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.getAttribute("role") === "menuitem" ||
        child.getAttribute("role") === "menuitemradio"),
  );
}

function focusMenuItem(
  menu: HTMLElement,
  currentTarget: EventTarget | null,
  key: string,
): void {
  const items = directMenuItems(menu);
  const currentIndex = items.indexOf(currentTarget as HTMLElement);
  const nextIndex = nextMenuItemIndex(key, currentIndex, items.length);
  if (nextIndex !== undefined) items[nextIndex]?.focus();
}

/** Shared model/thinking control used by sessions and model-backed workflow steps. */
export function PiModelThinkingMenu(props: {
  models: ChatModelSummary[];
  selectedModel: ChatModelSummary | undefined;
  thinkingLevels: string[];
  selectedThinking: string | undefined;
  disabled: boolean;
  onSelectModel(provider: string, modelId: string): void;
  onSelectThinking(level: string): void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPlacement, setModelMenuPlacement] = useState<{
    direction: "above" | "below";
    maxHeight: number;
  }>({ direction: "above", maxHeight: 280 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const focusModelMenuOnOpenRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (open) directMenuItems(popoverRef.current)[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!modelMenuOpen || !focusModelMenuOnOpenRef.current) return;
    focusModelMenuOnOpenRef.current = false;
    directMenuItems(modelMenuRef.current)[0]?.focus();
  }, [modelMenuOpen]);

  useLayoutEffect(() => {
    if (!modelMenuOpen) return;
    const updateModelMenuPlacement = (): void => {
      const popover = popoverRef.current;
      if (popover === null) return;
      const rect = popover.getBoundingClientRect();
      const gap = 6;
      // Narrow layouts place the submenu above the upward-opening popover.
      // Wider layouts retain the side-by-side menu placement.
      const aboveBoundary = window.matchMedia("(max-width: 560px)").matches
        ? rect.top
        : rect.bottom;
      const above = Math.max(0, Math.floor(aboveBoundary - gap));
      const below = Math.max(
        0,
        Math.floor(window.innerHeight - rect.bottom - gap),
      );
      const maxHeight = Math.min(280, Math.max(above, below));
      setModelMenuPlacement({
        direction: above >= below ? "above" : "below",
        maxHeight,
      });
    };

    updateModelMenuPlacement();
    window.addEventListener("resize", updateModelMenuPlacement);
    window.addEventListener("scroll", updateModelMenuPlacement, true);
    return () => {
      window.removeEventListener("resize", updateModelMenuPlacement);
      window.removeEventListener("scroll", updateModelMenuPlacement, true);
    };
  }, [modelMenuOpen]);

  function close(restoreFocus = false): void {
    setOpen(false);
    setModelMenuOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function openModelMenu(focusFirstItem: boolean): void {
    if (focusFirstItem && modelMenuOpen) {
      directMenuItems(modelMenuRef.current)[0]?.focus();
      return;
    }
    focusModelMenuOnOpenRef.current = focusFirstItem;
    setModelMenuOpen(true);
  }

  const selectedModelLabel = props.selectedModel
    ? modelPickerLabelParts(props.selectedModel)
    : undefined;
  const modelName = selectedModelLabel?.compact ?? "Model";
  const thinkingName = props.selectedThinking ?? "Thinking";

  return (
    <div
      className="pi-configuration-menu"
      ref={rootRef}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (modelMenuOpen) {
            setModelMenuOpen(false);
            modelTriggerRef.current?.focus();
          } else close(true);
          return;
        }
        if (
          event.key === "ArrowRight" &&
          event.target === modelTriggerRef.current
        ) {
          event.preventDefault();
          openModelMenu(true);
          return;
        }
        if (
          event.key === "ArrowLeft" &&
          (event.target as HTMLElement).closest(".pi-model-submenu")
        ) {
          event.preventDefault();
          setModelMenuOpen(false);
          modelTriggerRef.current?.focus();
          return;
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const menu = (event.target as HTMLElement).closest<HTMLElement>(
            "[role='menu']",
          );
          if (
            menu !== null &&
            (menu === popoverRef.current || menu === modelMenuRef.current)
          ) {
            event.preventDefault();
            focusMenuItem(menu, event.target, event.key);
          }
        }
      }}
    >
      <Button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Model and thinking. Current model: ${modelName}. Current thinking: ${thinkingName}.`}
        className="pi-configuration-trigger"
        data-model-id={props.selectedModel?.id}
        data-model-provider={props.selectedModel?.provider}
        data-thinking-level={props.selectedThinking}
        disabled={props.disabled}
        size="sm"
        title={`Model: ${modelName}; thinking: ${thinkingName}`}
        onClick={() => {
          setOpen((value) => !value);
          setModelMenuOpen(false);
        }}
      >
        <span>{thinkingName}</span>
        <ChevronDown aria-hidden="true" size={13} strokeWidth={1.75} />
      </Button>
      {open ? (
        <div
          aria-label="Model and thinking options"
          className="pi-configuration-popover"
          ref={popoverRef}
          role="menu"
        >
          <span className="pi-configuration-heading">Thinking</span>
          {props.thinkingLevels.map((level) => {
            const selected = level === props.selectedThinking;
            return (
              <Button
                aria-checked={selected}
                className="pi-configuration-option"
                data-thinking-level={level}
                key={level}
                role="menuitemradio"
                size="sm"
                variant="menuItem"
                onClick={() => {
                  close(true);
                  if (!selected) props.onSelectThinking(level);
                }}
              >
                <span>{level}</span>
                <Check
                  aria-hidden="true"
                  size={14}
                  strokeWidth={1.75}
                  visibility={selected ? "visible" : "hidden"}
                />
              </Button>
            );
          })}
          {props.models.length > 0 ? (
            <>
              <div className="pi-configuration-divider" />
              <Button
                ref={modelTriggerRef}
                aria-expanded={modelMenuOpen}
                aria-haspopup="menu"
                className="pi-configuration-option model"
                role="menuitem"
                size="sm"
                variant="menuItem"
                onClick={() => openModelMenu(true)}
                onMouseEnter={() => openModelMenu(false)}
              >
                <span title={modelName}>{modelName}</span>
                <ChevronRight aria-hidden="true" size={14} strokeWidth={1.75} />
              </Button>
              {modelMenuOpen ? (
                <div
                  aria-label="Available Pi models"
                  className={`pi-model-submenu pi-model-submenu--${modelMenuPlacement.direction}`}
                  ref={modelMenuRef}
                  style={
                    {
                      "--pi-model-submenu-max-height": `${modelMenuPlacement.maxHeight}px`,
                    } as CSSProperties
                  }
                  role="menu"
                >
                  {props.models.map((model) => {
                    const selected =
                      model.id === props.selectedModel?.id &&
                      model.provider === props.selectedModel?.provider;
                    const label = modelPickerLabelParts(model);
                    return (
                      <Button
                        aria-checked={selected}
                        aria-label={label.compact}
                        className="pi-configuration-option model-choice"
                        data-model-id={model.id}
                        data-model-provider={model.provider}
                        key={`${model.provider ?? ""}/${model.id}`}
                        role="menuitemradio"
                        size="sm"
                        variant="menuItem"
                        onClick={() => {
                          close(true);
                          if (!selected && model.provider)
                            props.onSelectModel(model.provider, model.id);
                        }}
                      >
                        <span
                          className="pi-model-choice-label"
                          title={label.compact}
                        >
                          <span className="pi-model-choice-label__primary">
                            {label.primary}
                          </span>
                          {label.secondary !== undefined ? (
                            <span className="pi-model-choice-label__secondary">
                              {label.secondary}
                            </span>
                          ) : null}
                        </span>
                        <Check
                          aria-hidden="true"
                          size={14}
                          strokeWidth={1.75}
                          visibility={selected ? "visible" : "hidden"}
                        />
                      </Button>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
