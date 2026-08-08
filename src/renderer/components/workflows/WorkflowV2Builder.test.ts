/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowV2Builder } from "./WorkflowV2Builder.js";
import {
  defaultV2Definition,
  validateJsonDraft,
} from "../../workflows/workflowV2.js";

describe("WorkflowV2Builder", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });
  const render = (
    onSave: (definition: ReturnType<typeof defaultV2Definition>) => void = () =>
      undefined,
  ) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        createElement(WorkflowV2Builder, {
          onSave,
          onCancel: () => undefined,
        }),
      ),
    );
  };
  const click = (text: string) =>
    act(() =>
      [...container!.querySelectorAll("button")]
        .find((button) => button.textContent === text)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
  it("passes a canonical workflow to Save", async () => {
    const onSave = vi.fn();
    render(onSave);
    await act(async () => {
      container!
        .querySelectorAll("button")
        .forEach(
          (button) => button.textContent === "Save workflow" && button.click(),
        );
    });
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "pi-deck.agent-workflow",
        schemaVersion: 2,
        id: expect.stringMatching(/^workflow-/),
      }),
    );
  });

  it("offers exactly the four canonical roles and a focused inspector", () => {
    render();
    expect(
      [...container!.querySelectorAll(".workflow-v2-add button")].map(
        (x) => x.textContent,
      ),
    ).toEqual(["Add Worker", "Add Decider", "Add Orchestrator", "Add Human"]);
    click("Add Human");
    expect(
      container!.querySelector('[aria-label="Focused role inspector"]')
        ?.textContent,
    ).toContain("Human inspector");
  });
  it("does not replace last-valid state when JSON syntax or semantic validation fails", () => {
    render();
    click("JSON");
    const input = container!.querySelector("textarea")!;
    act(() => {
      input.value = "{";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click("Apply");
    expect(validateJsonDraft("{").error).toContain("Invalid JSON");
    expect(
      validateJsonDraft(
        JSON.stringify({ ...defaultV2Definition(), entryNodeId: "missing" }),
      ).error,
    ).toContain("Entry node");
  });
  it("derives keyboard-selectable graph nodes which focus Build", () => {
    render();
    click("GRAPH");
    const node = container!.querySelector(
      '[aria-label="Read-only workflow graph"] button',
    ) as HTMLButtonElement;
    expect(node).not.toBeNull();
    act(() => node.click());
    expect(
      container!.querySelector('[aria-label="Focused role inspector"]'),
    ).not.toBeNull();
  });
  it("rejects forbidden roles and illegal relationship cycles", () => {
    const badRole = {
      ...defaultV2Definition(),
      nodes: [{ id: "x", name: "X", role: "planner", config: {} }],
    };
    expect(validateJsonDraft(JSON.stringify(badRole)).error).toBeTruthy();
    const doc = defaultV2Definition();
    doc.relationships.push({
      id: "cycle",
      from: "worker-1",
      to: { nodeId: "worker-1" },
    });
    expect(validateJsonDraft(JSON.stringify(doc)).error).toContain("cycles");
  });
});
