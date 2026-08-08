/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowV2Builder } from "./WorkflowV2Builder.js";
import {
  addRole,
  defaultV2Definition,
  setLoopDecider,
  setManagedWorkers,
  setOrchestratorMode,
  validateJsonDraft,
} from "../../workflows/workflowV2.js";

describe("WorkflowV2Builder", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });
  const render = (
    onSave: (definition: ReturnType<typeof defaultV2Definition>) => void = () =>
      undefined,
    initialDefinition?: ReturnType<typeof defaultV2Definition>,
  ) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        createElement(WorkflowV2Builder, {
          onSave,
          onCancel: () => undefined,
          initialDefinition,
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

  it("creates a schema-valid fixed-list fan-out canonical document", () => {
    const added = addRole(defaultV2Definition(), "orchestrator").definition;
    const canonical = {
      ...added,
      relationships: [
        { id: "start", from: "worker-1", to: { nodeId: "orchestrator-1" } },
        { id: "end", from: "orchestrator-1", to: { end: "completed" } },
      ],
    };
    expect(validateJsonDraft(JSON.stringify(canonical))).toMatchObject({
      definition: expect.anything(),
    });
    const orchestrator = canonical.nodes.find(
      (node) => node.role === "orchestrator",
    )!;
    const worker = canonical.nodes.find(
      (node) => node.managedBy === orchestrator.id,
    )!;
    expect(orchestrator.config.agents).toEqual([worker.id]);
  });

  it("uses collision-safe IDs and reconciles managed mode changes", () => {
    const base = {
      ...defaultV2Definition(),
      nodes: [
        {
          id: "worker-1",
          name: "First",
          role: "worker" as const,
          config: { instructions: "x" },
        },
        {
          id: "orchestrator-1",
          name: "Owner",
          role: "orchestrator" as const,
          config: {
            mode: "fanout" as const,
            agents: ["worker-1"],
            maxConcurrency: 1,
            completion: "all" as const,
          },
        },
      ],
    };
    const added = addRole(base, "orchestrator").definition;
    expect(new Set(added.nodes.map((node) => node.id)).size).toBe(
      added.nodes.length,
    );
    const loop = setOrchestratorMode(added, "orchestrator-2", "loop");
    const loopOwner = loop.nodes.find((node) => node.id === "orchestrator-2")!;
    expect(
      loopOwner.role === "orchestrator" && loopOwner.config.mode === "loop",
    ).toBe(true);
    const fanout = setOrchestratorMode(loop, "orchestrator-2", "fanout");
    expect(
      fanout.nodes.some(
        (node) =>
          node.role === "decider" && node.managedBy === "orchestrator-2",
      ),
    ).toBe(false);
  });

  it("updates ownership without mutating unrelated nodes", () => {
    const withWorker = addRole(defaultV2Definition(), "worker").definition;
    const withOrchestrator = addRole(withWorker, "orchestrator").definition;
    const result = setManagedWorkers(withOrchestrator, "orchestrator-1", [
      "worker-2",
    ]);
    expect(result.nodes.find((node) => node.id === "worker-1")).toEqual(
      withOrchestrator.nodes.find((node) => node.id === "worker-1"),
    );
    expect(result.nodes.find((node) => node.id === "worker-2")?.managedBy).toBe(
      "orchestrator-1",
    );
  });

  it("removes old loop decider routes when selecting another loop decider", () => {
    const withOwner = setOrchestratorMode(
      addRole(defaultV2Definition(), "orchestrator").definition,
      "orchestrator-1",
      "loop",
    );
    const candidate = addRole(withOwner, "decider").definition;
    const result = setLoopDecider(candidate, "orchestrator-1", "decider-2");
    expect(result.nodes.some((node) => node.name === "Loop completion")).toBe(
      false,
    );
    expect(
      result.nodes.find((node) => node.id === "decider-2")?.managedBy,
    ).toBe("orchestrator-1");
  });

  it("preserves Orchestrator input across both mode switches", () => {
    const fanout = addRole(defaultV2Definition(), "orchestrator").definition;
    const withInput = {
      ...fanout,
      nodes: fanout.nodes.map((node) =>
        node.role === "orchestrator"
          ? { ...node, config: { ...node.config, input: "request context" } }
          : node,
      ),
    };
    const loop = setOrchestratorMode(withInput, "orchestrator-1", "loop");
    const restored = setOrchestratorMode(loop, "orchestrator-1", "fanout");
    for (const definition of [loop, restored]) {
      const owner = definition.nodes.find(
        (node) => node.id === "orchestrator-1",
      );
      expect(owner?.role === "orchestrator" && owner.config.input).toBe(
        "request context",
      );
    }
  });

  it("offers Human approval, choice, and input-compatible routes", () => {
    render();
    click("+ Add step");
    click("Add checkpointApproval / input");
    expect(
      container!.querySelector('[aria-label="True destination"]'),
    ).not.toBeNull();
    const interaction = [...container!.querySelectorAll("select")].find(
      (select) => select.value === "approval",
    )!;
    act(() => {
      interaction.value = "choice";
      interaction.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container!.textContent).toContain("Option 1 destination");
    act(() => {
      interaction.value = "input";
      interaction.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      container!.querySelector('[aria-label="Connect selected role to"]'),
    ).not.toBeNull();
  });

  it("moves focus into the mobile inspector and restores the originating card", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    render();
    const card = container!.querySelector<HTMLButtonElement>(
      ".workflow-v2-step-card",
    )!;
    act(() => card.click());
    expect(document.activeElement?.textContent).toBe("Close inspector");
    click("Close inspector");
    expect(document.activeElement).toBe(card);
  });

  it("restores the selected Build card after opening it from the mobile Graph", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    render();
    click("GRAPH");
    const graphNode = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Read-only workflow graph"] article button',
    )!;
    act(() => graphNode.click());
    expect(document.activeElement?.textContent).toBe("Close inspector");
    click("Close inspector");
    expect((document.activeElement as HTMLElement).dataset.workflowNodeId).toBe(
      "worker-1",
    );
  });

  it("uses one friendly add-step picker and a focused inspector", () => {
    render();
    expect(
      container!.querySelector(".workflow-v2-add button")?.textContent,
    ).toBe("+ Add step");
    click("+ Add step");
    expect(
      [...container!.querySelectorAll('[role="menuitem"]')].map(
        (x) => x.textContent,
      ),
    ).toEqual([
      "Add agent taskAgent task",
      "Add decisionDecision",
      "Add coordinationCoordinate tasks",
      "Add checkpointApproval / input",
    ]);
    click("Add checkpointApproval / input");
    expect(
      container!.querySelector('[aria-label="Focused role inspector"]')
        ?.textContent,
    ).toContain("Approval / input");
  });
  it("dismisses the picker on an outside pointer interaction without changing the selected card", () => {
    render();
    const selectedBefore = container!.querySelector(
      ".workflow-v2-step-card.is-selected",
    );
    click("+ Add step");
    expect(container!.querySelector('[role="menu"]')).not.toBeNull();
    act(() =>
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    expect(container!.querySelector(".workflow-v2-step-card.is-selected")).toBe(
      selectedBefore,
    );
    expect(container!.querySelectorAll(".workflow-v2-step-card")).toHaveLength(
      1,
    );
  });

  it("toggles the picker closed from its trigger", () => {
    render();
    click("+ Add step");
    click("+ Add step");
    expect(container!.querySelector('[role="menu"]')).toBeNull();
  });

  it("moves menu focus with arrow keys", () => {
    render();
    click("+ Add step");
    const items =
      container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    act(() =>
      items[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(items[1]);
  });

  it("dismisses the picker with Escape without changing a step selection", () => {
    render();
    const addStep = container!.querySelector(
      ".workflow-v2-add button",
    ) as HTMLButtonElement;
    const selectedBefore = container!.querySelector(
      ".workflow-v2-step-card.is-selected",
    );
    act(() => addStep.focus());
    click("+ Add step");
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(addStep);
    expect(container!.querySelector(".workflow-v2-step-card.is-selected")).toBe(
      selectedBefore,
    );
    expect(container!.querySelectorAll(".workflow-v2-step-card")).toHaveLength(
      1,
    );
  });

  it("adds exactly one step and closes the picker after selecting a role", () => {
    render();
    const countBefore = container!.querySelectorAll(
      ".workflow-v2-step-card",
    ).length;
    click("+ Add step");
    click("Add decisionDecision");
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    expect(container!.querySelectorAll(".workflow-v2-step-card")).toHaveLength(
      countBefore + 1,
    );
  });

  it("uses theme tokens for picker contrast", () => {
    const styles = readFileSync(
      join(process.cwd(), "src/renderer/styles.css"),
      "utf8",
    );
    expect(styles).toMatch(
      /\.workflow-v2-step-picker\s*\{[^}]*color: var\(--color-text\);[^}]*background: var\(--color-surface-raised\);/,
    );
    expect(styles).toMatch(
      /\.workflow-v2-step-picker small\s*\{[^}]*color: var\(--color-text-muted\);/,
    );
  });

  it("closes the picker when leaving the Build view", () => {
    render();
    click("+ Add step");
    click("GRAPH");
    click("BUILD");
    expect(container!.querySelector('[role="menu"]')).toBeNull();
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
