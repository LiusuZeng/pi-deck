export type PromptHistoryDirection = "up" | "down";

export interface PromptHistoryState {
  /** null means the visible composer text is the live draft, not a history item. */
  index: number | null;
  /** Exact live draft captured when history browsing started. */
  draftBeforeHistory: string;
}

export interface TextNavigationTarget {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface PromptHistoryKeyEventLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

export function initialPromptHistoryState(): PromptHistoryState {
  return { index: null, draftBeforeHistory: "" };
}

export function submittedPromptHistory(
  timeline: readonly { kind: string; content?: string }[],
): string[] {
  return timeline
    .filter(
      (item): item is { kind: "user"; content: string } =>
        item.kind === "user" && typeof item.content === "string",
    )
    .map((item) => item.content)
    .filter((content) => content.length > 0);
}

export function promptHistoryDirectionForKeyEvent(
  event: PromptHistoryKeyEventLike,
): PromptHistoryDirection | undefined {
  if (event.defaultPrevented === true) return undefined;
  if (event.nativeEvent?.isComposing === true || event.isComposing === true) {
    return undefined;
  }
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return undefined;
  }
  if (event.key === "ArrowUp") return "up";
  if (event.key === "ArrowDown") return "down";
  return undefined;
}

export function canNavigatePromptHistoryUp(
  target: TextNavigationTarget,
): boolean {
  if (target.selectionStart !== target.selectionEnd) return false;
  const caret = clampCaret(target.selectionStart, target.value.length);
  if (target.value.length === 0) return true;

  const firstLineBreak = target.value.indexOf("\n");
  if (firstLineBreak === -1) {
    return caret === 0 || caret === target.value.length;
  }

  return caret <= firstLineBreak;
}

export function canNavigatePromptHistoryDown(
  target: TextNavigationTarget,
): boolean {
  if (target.selectionStart !== target.selectionEnd) return false;
  const caret = clampCaret(target.selectionStart, target.value.length);
  if (target.value.length === 0) return true;

  const lastLineBreak = target.value.lastIndexOf("\n");
  if (lastLineBreak === -1) {
    return caret === 0 || caret === target.value.length;
  }

  return caret > lastLineBreak;
}

export interface PromptHistoryNavigationResult {
  state: PromptHistoryState;
  text: string;
}

export function navigatePromptHistory(
  state: PromptHistoryState,
  history: readonly string[],
  currentText: string,
  direction: PromptHistoryDirection,
): PromptHistoryNavigationResult | undefined {
  if (history.length === 0) return undefined;

  if (direction === "up") {
    const nextIndex =
      state.index === null ? history.length - 1 : Math.max(0, state.index - 1);
    return {
      state: {
        index: nextIndex,
        draftBeforeHistory:
          state.index === null ? currentText : state.draftBeforeHistory,
      },
      text: history[nextIndex] ?? currentText,
    };
  }

  if (state.index === null) return undefined;
  const nextIndex = state.index + 1;
  if (nextIndex >= history.length) {
    return {
      state: initialPromptHistoryState(),
      text: state.draftBeforeHistory,
    };
  }

  return {
    state: { ...state, index: nextIndex },
    text: history[nextIndex] ?? currentText,
  };
}

function clampCaret(caret: number, textLength: number): number {
  if (!Number.isFinite(caret)) return 0;
  return Math.min(Math.max(Math.trunc(caret), 0), textLength);
}
