/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowV2Builder } from "./WorkflowV2Builder.js";
import { validateJsonDraft } from "../../workflows/workflowV2.js";

describe("WorkflowV2Builder", () => {
  let root: Root | undefined; let container: HTMLDivElement | undefined;
  afterEach(() => { act(() => root?.unmount()); container?.remove(); });
  it("has exactly four role templates and only applies valid JSON", () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    act(() => root?.render(createElement(WorkflowV2Builder, { onSave: () => undefined, onCancel: () => undefined })));
    expect(container.querySelectorAll(".workflow-v2-roles button")).toHaveLength(4);
    act(() => [...container!.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "JSON")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(validateJsonDraft("{").error).toContain("Invalid JSON");
    expect(container.textContent).toContain("JSON draft");
  });
  it("renders a derived read-only accessible graph", () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    act(() => root?.render(createElement(WorkflowV2Builder, { onSave: () => undefined, onCancel: () => undefined })));
    act(() => [...container!.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Graph")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[aria-label="Read-only workflow graph"]')).not.toBeNull();
    expect(container.textContent).toContain("No downstream step");
  });
});
