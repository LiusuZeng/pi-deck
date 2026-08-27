import { describe, expect, it } from "vitest";
import {
  canNavigatePromptHistoryDown,
  canNavigatePromptHistoryUp,
  initialPromptHistoryState,
  navigatePromptHistory,
  promptHistoryDirectionForKeyEvent,
  submittedPromptHistory,
  type PromptHistoryState,
} from "./promptHistory.js";

function caret(
  value: string,
  selectionStart: number,
  selectionEnd = selectionStart,
) {
  return { value, selectionStart, selectionEnd };
}

describe("prompt history source", () => {
  it("derives text-only submitted user prompts from the current session timeline", () => {
    expect(
      submittedPromptHistory([
        { kind: "user", content: "first" },
        { kind: "assistant", content: "ignored" },
        { kind: "user", content: "" },
        { kind: "tool" },
        { kind: "user", content: "with attachments" },
      ]),
    ).toEqual(["first", "with attachments"]);
  });
});

describe("prompt history navigation state", () => {
  it("recalls the immediately previous prompt from an empty composer", () => {
    const result = navigatePromptHistory(
      initialPromptHistoryState(),
      ["first", "second"],
      "",
      "up",
    );

    expect(result).toEqual({
      state: { index: 1, draftBeforeHistory: "" },
      text: "second",
    });
  });

  it("repeated ArrowUp walks older prompts in order and stops at the oldest", () => {
    let state: PromptHistoryState = initialPromptHistoryState();
    const history = ["oldest", "middle", "newest"];

    let result = navigatePromptHistory(state, history, "draft", "up")!;
    expect(result.text).toBe("newest");
    state = result.state;

    result = navigatePromptHistory(state, history, result.text, "up")!;
    expect(result.text).toBe("middle");
    state = result.state;

    result = navigatePromptHistory(state, history, result.text, "up")!;
    expect(result.text).toBe("oldest");
    state = result.state;

    result = navigatePromptHistory(state, history, result.text, "up")!;
    expect(result.text).toBe("oldest");
    expect(result.state.index).toBe(0);
  });

  it("ArrowDown walks toward newer prompts", () => {
    const history = ["oldest", "middle", "newest"];
    const state: PromptHistoryState = { index: 0, draftBeforeHistory: "draft" };

    const result = navigatePromptHistory(state, history, "oldest", "down");

    expect(result).toEqual({
      state: { index: 1, draftBeforeHistory: "draft" },
      text: "middle",
    });
  });

  it("ArrowDown past the newest prompt restores the exact unsent draft", () => {
    const draft = "check the failing test but only...\nwith detail  ";
    let result = navigatePromptHistory(
      initialPromptHistoryState(),
      ["old", "new"],
      draft,
      "up",
    )!;
    expect(result.text).toBe("new");

    result = navigatePromptHistory(
      result.state,
      ["old", "new"],
      "new",
      "down",
    )!;

    expect(result.text).toBe(draft);
    expect(result.state).toEqual(initialPromptHistoryState());
  });

  it("does nothing for ArrowDown when not browsing history", () => {
    expect(
      navigatePromptHistory(
        initialPromptHistoryState(),
        ["old"],
        "draft",
        "down",
      ),
    ).toBeUndefined();
  });

  it("does nothing when the session has no previous user prompt", () => {
    expect(
      navigatePromptHistory(initialPromptHistoryState(), [], "draft", "up"),
    ).toBeUndefined();
  });
});

describe("prompt history boundary detection", () => {
  it("allows immediate ArrowUp recall from an empty prompt", () => {
    expect(canNavigatePromptHistoryUp(caret("", 0))).toBe(true);
  });

  it("keeps native editing for a single-line interior caret", () => {
    expect(canNavigatePromptHistoryUp(caret("abcdef", 3))).toBe(false);
    expect(canNavigatePromptHistoryDown(caret("abcdef", 3))).toBe(false);
  });

  it("allows single-line boundary navigation at the start or end", () => {
    expect(canNavigatePromptHistoryUp(caret("abcdef", 0))).toBe(true);
    expect(canNavigatePromptHistoryUp(caret("abcdef", 6))).toBe(true);
    expect(canNavigatePromptHistoryDown(caret("abcdef", 0))).toBe(true);
    expect(canNavigatePromptHistoryDown(caret("abcdef", 6))).toBe(true);
  });

  it("keeps native ArrowUp behavior when a multiline caret is not on the top line", () => {
    expect(canNavigatePromptHistoryUp(caret("line one\nline two", 12))).toBe(
      false,
    );
  });

  it("allows ArrowUp history navigation at the multiline top boundary", () => {
    expect(canNavigatePromptHistoryUp(caret("line one\nline two", 4))).toBe(
      true,
    );
  });

  it("keeps browsing a multiline recalled prompt until ArrowDown is at the bottom boundary", () => {
    expect(
      canNavigatePromptHistoryDown(caret("line one\nline two\nline three", 4)),
    ).toBe(false);
    expect(
      canNavigatePromptHistoryDown(caret("line one\nline two\nline three", 25)),
    ).toBe(true);
  });

  it("does not trigger history when text is selected", () => {
    expect(canNavigatePromptHistoryUp(caret("line", 0, 4))).toBe(false);
    expect(canNavigatePromptHistoryDown(caret("line", 0, 4))).toBe(false);
  });
});

describe("prompt history key filtering", () => {
  it("recognizes only unmodified ArrowUp and ArrowDown", () => {
    expect(promptHistoryDirectionForKeyEvent({ key: "ArrowUp" })).toBe("up");
    expect(promptHistoryDirectionForKeyEvent({ key: "ArrowDown" })).toBe(
      "down",
    );
    expect(promptHistoryDirectionForKeyEvent({ key: "Enter" })).toBeUndefined();
  });

  it("does not hijack Shift selection or Command/Ctrl/Option/Alt navigation", () => {
    for (const modifier of [
      "shiftKey",
      "metaKey",
      "ctrlKey",
      "altKey",
    ] as const) {
      expect(
        promptHistoryDirectionForKeyEvent({ key: "ArrowUp", [modifier]: true }),
      ).toBeUndefined();
      expect(
        promptHistoryDirectionForKeyEvent({
          key: "ArrowDown",
          [modifier]: true,
        }),
      ).toBeUndefined();
    }
  });

  it("does not hijack IME/composition events", () => {
    expect(
      promptHistoryDirectionForKeyEvent({
        key: "ArrowUp",
        nativeEvent: { isComposing: true },
      }),
    ).toBeUndefined();
    expect(
      promptHistoryDirectionForKeyEvent({
        key: "ArrowDown",
        isComposing: true,
      }),
    ).toBeUndefined();
  });
});
