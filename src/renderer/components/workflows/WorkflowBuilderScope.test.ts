/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorkflowTemplate,
  WorkflowTemplateDefinition,
} from "../../../shared/workflowSchemas.js";
import { WorkflowBuilder } from "./WorkflowBuilder.js";

const activeWorkspaceChoices = [
  { id: "workspace-default", name: "Default workspace" },
  { id: "workspace-project", name: "liusu_pi_gui" },
];

function scopedTemplate(workspaceId: string): WorkflowTemplate {
  return {
    id: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
    name: "Scoped workflow",
    workspaceId,
    inputs: [],
    steps: [
      {
        id: "worker",
        name: "Worker",
        kind: "agent",
        promptParts: [{ type: "text", text: "Run the terminal check." }],
        inputPolicy: {
          includeWorkflowContext: true,
          includeParentFinalAnswer: false,
          includeParentSummary: false,
          includeParentTranscript: false,
        },
        startPolicy: "auto",
      },
    ],
    transitions: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function enterInstructions(container: HTMLDivElement): void {
  const prompt = container.querySelector(
    'textarea[aria-label="Instructions"]',
  ) as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setValue.call(prompt, "Run the terminal check.");
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
}

async function saveWorkflow(container: HTMLDivElement): Promise<void> {
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Save workflow",
  ) as HTMLButtonElement;
  save.click();
}

describe("WorkflowBuilder template scope", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("saves a new template as global even when opened in a workspace", async () => {
    let saved: WorkflowTemplateDefinition | undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowBuilder, {
          workspaceChoices: activeWorkspaceChoices,
          onSave: (definition) => {
            saved = definition;
          },
          onCancel: () => undefined,
        }),
      );
    });

    act(() => enterInstructions(container!));
    await act(async () => saveWorkflow(container!));

    expect(saved).toBeDefined();
    expect(saved?.workspaceId).toBeUndefined();
  });

  it("lists every active workspace and persists a selected workspace ID", async () => {
    let saved: WorkflowTemplateDefinition | undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowBuilder, {
          workspaceChoices: activeWorkspaceChoices,
          onSave: (definition) => {
            saved = definition;
          },
          onCancel: () => undefined,
        }),
      );
    });

    const scope = container.querySelector(
      'select[aria-label="Workflow scope"]',
    ) as HTMLSelectElement;
    expect(
      [...scope.options].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ["", "All workspaces (global)"],
      ["workspace-default", "Default workspace"],
      ["workspace-project", "liusu_pi_gui"],
    ]);

    act(() => {
      scope.value = "workspace-project";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
      enterInstructions(container!);
    });
    await act(async () => saveWorkflow(container!));

    expect(saved?.workspaceId).toBe("workspace-project");
  });

  it("shows an active saved scope by name and preserves it while editing", async () => {
    let saved: WorkflowTemplateDefinition | undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowBuilder, {
          initialTemplate: scopedTemplate("workspace-project"),
          workspaceChoices: activeWorkspaceChoices,
          onSave: (definition) => {
            saved = definition;
          },
          onCancel: () => undefined,
        }),
      );
    });

    const scope = container.querySelector(
      'select[aria-label="Workflow scope"]',
    ) as HTMLSelectElement;
    expect(scope.value).toBe("workspace-project");
    expect(scope.selectedOptions[0]?.textContent).toBe("liusu_pi_gui");
    expect(container.textContent).toContain("Scope: liusu_pi_gui");

    await act(async () => saveWorkflow(container!));
    expect(saved?.workspaceId).toBe("workspace-project");
  });

  it("does not list archived workspaces unless preserving the template's saved scope", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(WorkflowBuilder, {
          initialTemplate: scopedTemplate("workspace-archived"),
          workspaceChoices: activeWorkspaceChoices,
          onSave: () => undefined,
          onCancel: () => undefined,
        }),
      );
    });

    const scope = container.querySelector(
      'select[aria-label="Workflow scope"]',
    ) as HTMLSelectElement;
    expect([...scope.options].map((option) => option.value)).toEqual([
      "",
      "workspace-default",
      "workspace-project",
      "workspace-archived",
    ]);
    expect(scope.value).toBe("workspace-archived");
    expect(scope.selectedOptions[0]?.textContent).toBe(
      "workspace-archived (saved scope)",
    );
  });
});
