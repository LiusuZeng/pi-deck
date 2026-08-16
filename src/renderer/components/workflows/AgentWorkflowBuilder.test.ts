/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkflowBuilder } from "./AgentWorkflowBuilder.js";
import {
  addRole,
  defaultAgentWorkflowDefinition,
  setOrchestratorMode,
  validateJsonDraft,
} from "../../workflows/agentWorkflowDefinition.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("AgentWorkflowBuilder UUID identities", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });
  const render = (onSave = vi.fn()) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        createElement(AgentWorkflowBuilder, {
          onSave,
          onCancel: () => undefined,
        }),
      ),
    );
    return onSave;
  };
  const click = (text: string) =>
    act(() =>
      [...container!.querySelectorAll("button")]
        .find((button) => button.textContent === text)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

  it("keeps workflow and selected-step edits made in one React batch", async () => {
    const onSave = render();
    const inputs = container!.querySelectorAll<HTMLInputElement>("input");
    const workflowName = inputs[0]!;
    const stepName = inputs[1]!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    act(() => {
      setValue.call(workflowName, "Release checklist");
      workflowName.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(stepName, "Implement fix");
      stepName.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(workflowName.value).toBe("Release checklist");
    expect(stepName.value).toBe("Implement fix");
    await act(async () => click("Save workflow"));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Release checklist",
        nodes: [expect.objectContaining({ name: "Implement fix" })],
      }),
      null,
    );
  });

  it("creates a schema-valid default document with UUID workflow and node IDs", () => {
    const definition = defaultAgentWorkflowDefinition();
    expect(definition.id).toMatch(uuid);
    expect(definition.entryNodeId).toMatch(uuid);
    expect(definition.nodes[0]?.id).toBe(definition.entryNodeId);
    expect(
      validateJsonDraft(JSON.stringify(definition)).definition,
    ).toBeDefined();
  });

  it("generates UUID node IDs for added roles and their references", () => {
    const withOrchestrator = addRole(
      defaultAgentWorkflowDefinition(),
      "orchestrator",
    ).definition;
    const orchestrator = withOrchestrator.nodes.find(
      (node) => node.role === "orchestrator",
    )!;
    const worker = withOrchestrator.nodes.find(
      (node) => node.managedBy === orchestrator.id,
    )!;
    expect(orchestrator.id).toMatch(uuid);
    expect(worker.id).toMatch(uuid);
    expect(worker.managedBy).toBe(orchestrator.id);
    expect(orchestrator.config.agents).toEqual([worker.id]);

    const loop = setOrchestratorMode(withOrchestrator, orchestrator.id, "loop");
    const decider = loop.nodes.find((node) => node.role === "decider")!;
    expect(decider.id).toMatch(uuid);
    expect(decider.managedBy).toBe(orchestrator.id);
  });

  it("lists active workspace scopes, excludes archived choices supplied by App, and saves the selected ID", async () => {
    const onSave = render();
    act(() =>
      root?.render(
        createElement(AgentWorkflowBuilder, {
          workspaceChoices: [
            { id: "workspace-a", name: "Alpha" },
            { id: "workspace-b", name: "Beta" },
          ],
          onSave,
          onCancel: () => undefined,
        }),
      ),
    );
    const scope = container!.querySelector<HTMLSelectElement>(
      '[aria-label="Workflow scope"]',
    )!;
    expect([...scope.options].map((option) => option.textContent)).toEqual([
      "All workspaces (global)",
      "Alpha",
      "Beta",
    ]);
    expect([...scope.options].map((option) => option.value)).not.toContain(
      "archived-workspace",
    );
    act(() => {
      scope.value = "workspace-b";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => click("Save workflow"));
    expect(onSave.mock.calls[0]?.[1]).toBe("workspace-b");
  });

  it("defaults to global scope and retains an unavailable saved scope when editing", async () => {
    const globalSave = render();
    await act(async () => click("Save workflow"));
    expect(globalSave.mock.calls[0]?.[1]).toBeNull();

    act(() =>
      root?.render(
        createElement(AgentWorkflowBuilder, {
          key: "saved-scope",
          initialDefinition: defaultAgentWorkflowDefinition(),
          initialScopeWorkspaceId: "saved-workspace",
          workspaceChoices: [{ id: "workspace-a", name: "Alpha" }],
          onSave: vi.fn(),
          onCancel: () => undefined,
        }),
      ),
    );
    const scope = container!.querySelector<HTMLSelectElement>(
      '[aria-label="Workflow scope"]',
    )!;
    expect(scope.value).toBe("saved-workspace");
    expect(scope.selectedOptions[0]?.disabled).toBe(true);
    expect(scope.selectedOptions[0]?.textContent).toContain("Saved workspace");
  });

  it("generates a UUID relationship ID when a route is added", async () => {
    const onSave = render();
    click("+ Add step");
    click("Add agent taskAgent task");
    act(() =>
      container!
        .querySelector<HTMLButtonElement>(".agent-workflow-step-card")
        ?.click(),
    );
    const destination = container!.querySelector<HTMLSelectElement>(
      '[aria-label="Choose the next workflow step"]',
    )!;
    const target = [...destination.options].find((option) =>
      uuid.test(option.value),
    )?.value;
    expect(target).toMatch(uuid);
    act(() => {
      destination.value = target!;
      destination.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => click("Save workflow"));
    const saved = onSave.mock.calls[0]?.[0];
    expect(saved.relationships).toEqual([
      expect.objectContaining({ id: expect.stringMatching(uuid) }),
    ]);
    expect(validateJsonDraft(JSON.stringify(saved)).definition).toBeDefined();
  });
});
