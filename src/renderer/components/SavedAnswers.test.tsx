// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PiDeckApi,
  SavedAnswerDetail,
  WorkspaceRef,
} from "../../shared/types.js";
import { SavedAnswers } from "./SavedAnswers.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workspaces: WorkspaceRef[] = [
  { id: "workspace-a", name: "Workspace A", lastOpenedAt: 1 },
  { id: "workspace-b", name: "Workspace B", lastOpenedAt: 1 },
];
const emptyList = { items: [], warnings: [] };

let root: Root | undefined;
let container: HTMLDivElement | undefined;

type SavedAnswersApi = PiDeckApi["savedAnswers"];

function detail(
  outputId: string,
  selectedRevisionId = "revision-1",
  workspaceId = "workspace-a",
): SavedAnswerDetail {
  const selectedDisplayNumber = selectedRevisionId === "revision-2" ? 2 : 1;
  return {
    outputId,
    revisionId: "revision-2",
    workspaceId,
    title: `Output ${outputId.slice(-1).toUpperCase()}`,
    createdAtMs: 1,
    updatedAtMs: 2,
    displayNumber: 2,
    revisionCount: 2,
    reviewState: "unreviewed",
    size: 24,
    origin: "manual-save",
    content: `Content for ${outputId} revision ${selectedDisplayNumber}`,
    selectedRevisionId,
    selectedDisplayNumber,
    revisions: [
      {
        revisionId: "revision-1",
        displayNumber: 1,
        createdAtMs: 1,
        size: 12,
        integrity: "available",
        reviewState: "unreviewed",
      },
      {
        revisionId: "revision-2",
        displayNumber: 2,
        createdAtMs: 2,
        size: 24,
        integrity: "available",
        reviewState: "unreviewed",
      },
    ],
    reviews: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installApi(overrides: Partial<SavedAnswersApi>): void {
  const api = {
    savedAnswers: {
      list: vi.fn(() => Promise.resolve(emptyList)),
      read: vi.fn((request: Parameters<SavedAnswersApi["read"]>[0]) =>
        Promise.resolve(
          detail(request.outputId, request.revisionId, request.workspaceId),
        ),
      ),
      review: vi.fn(() => Promise.resolve(detail("output-a"))),
      reveal: vi.fn(() => Promise.resolve({ revealed: true as const })),
      ...overrides,
    },
  };
  Object.defineProperty(window, "piDeck", {
    configurable: true,
    value: api as PiDeckApi,
  });
}

function render(
  selectedOutputId: string | undefined,
  workspaceId = "workspace-a",
): void {
  const selection = selectedOutputId === undefined ? {} : { selectedOutputId };
  act(() => {
    root?.render(
      <SavedAnswers
        workspaceId={workspaceId}
        workspaceName={
          workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
          "Workspace"
        }
        workspaces={workspaces}
        {...selection}
        onBack={vi.fn()}
        onRevise={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(label: string): void {
  const button = Array.from(container?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent === label,
  );
  expect(button).toBeDefined();
  act(() => button?.click());
}

function setFeedback(value: string): void {
  const feedback = container?.querySelector<HTMLTextAreaElement>("textarea");
  expect(feedback).toBeDefined();
  if (feedback === undefined || feedback === null) {
    throw new Error("Review feedback is unavailable");
  }
  act(() => {
    feedback.value = value;
    feedback.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectAllWorkspaces(): void {
  const scope = container?.querySelector<HTMLSelectElement>("select");
  expect(scope).toBeDefined();
  if (scope === undefined || scope === null) {
    throw new Error("Output scope is unavailable");
  }
  act(() => {
    scope.value = "all";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("SavedAnswers review mutations", () => {
  it("updates the current revision and refreshes the list after a review", async () => {
    const original = detail("output-a");
    const reviewed: SavedAnswerDetail = {
      ...original,
      reviewState: "accepted",
      revisions: original.revisions.map((revision, index) =>
        index === 0 ? { ...revision, reviewState: "accepted" } : revision,
      ),
    };
    const list = vi.fn(() => Promise.resolve(emptyList));
    const review = vi.fn(() => Promise.resolve(reviewed));
    installApi({ list, review });

    render("output-a");
    await flush();
    list.mockClear();
    click("Accept");
    await flush();

    expect(review).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      outputId: "output-a",
      revisionId: "revision-1",
      action: "accepted",
    });
    expect(container?.textContent).toContain("Accepted");
    expect(list).toHaveBeenCalledWith({ workspaceId: "workspace-a" });
  });

  it("does not replace B with A after a delayed review succeeds", async () => {
    const review = deferred<SavedAnswerDetail>();
    installApi({ review: vi.fn(() => review.promise) });

    render("output-a");
    await flush();
    click("Accept");
    render(undefined);
    await flush();
    render("output-b");
    await flush();

    expect(container?.querySelector("h1")?.textContent).toBe("Output B");
    expect(
      Array.from(container?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.textContent === "Accept",
      )?.disabled,
    ).toBe(false);

    await act(async () => {
      review.resolve(detail("output-a"));
      await review.promise;
    });
    await flush();

    expect(container?.querySelector("h1")?.textContent).toBe("Output B");
    expect(container?.querySelector("[role=alert]")).toBeNull();
  });

  it("does not show A's delayed review failure or clear B's feedback", async () => {
    const review = deferred<SavedAnswerDetail>();
    installApi({ review: vi.fn(() => review.promise) });

    render("output-a");
    await flush();
    click("Accept");
    render(undefined);
    await flush();
    render("output-b");
    await flush();
    setFeedback("Feedback for B");

    await act(async () => {
      review.reject(new Error("A review failed"));
      await Promise.resolve();
    });
    await flush();

    expect(container?.querySelector("h1")?.textContent).toBe("Output B");
    expect(container?.querySelector("[role=alert]")).toBeNull();
    expect(container?.querySelector("textarea")?.value).toBe("Feedback for B");
  });

  it("does not overwrite a newer revision with a delayed review response", async () => {
    const review = deferred<SavedAnswerDetail>();
    installApi({ review: vi.fn(() => review.promise) });

    render("output-a");
    await flush();
    click("Accept");
    click("Revision 2Unreviewed");
    await flush();
    setFeedback("Feedback for revision 2");

    await act(async () => {
      review.resolve(detail("output-a", "revision-1"));
      await review.promise;
    });
    await flush();

    expect(container?.textContent).toContain("Review revision 2");
    expect(container?.querySelector("textarea")?.value).toBe(
      "Feedback for revision 2",
    );
  });

  it("refreshes using the latest workspace and scope after navigation", async () => {
    const review = deferred<SavedAnswerDetail>();
    const list = vi.fn(() => Promise.resolve(emptyList));
    installApi({ list, review: vi.fn(() => review.promise) });

    render("output-a");
    await flush();
    click("Accept");
    render(undefined, "workspace-b");
    await flush();
    selectAllWorkspaces();
    await flush();
    list.mockClear();

    await act(async () => {
      review.resolve(detail("output-a"));
      await review.promise;
    });
    await flush();

    expect(list).toHaveBeenCalledWith({});
    expect(list).not.toHaveBeenCalledWith({ workspaceId: "workspace-a" });
  });

  it("does not refresh state after unmounting during a review", async () => {
    const review = deferred<SavedAnswerDetail>();
    const list = vi.fn(() => Promise.resolve(emptyList));
    installApi({ list, review: vi.fn(() => review.promise) });

    render("output-a");
    await flush();
    click("Accept");
    act(() => root?.unmount());
    root = undefined;
    list.mockClear();

    await act(async () => {
      review.resolve(detail("output-a"));
      await review.promise;
    });
    await flush();

    expect(list).not.toHaveBeenCalled();
  });
});
