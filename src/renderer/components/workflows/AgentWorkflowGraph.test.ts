/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanonicalNodeOccurrence,
  WorkflowDefinition,
} from "../../../../shared/agentWorkflowSchemas.js";
import { AgentWorkflowGraph } from "./AgentWorkflowGraph.js";

const semanticGraphDefinition: WorkflowDefinition = {
  format: "pi-deck.agent-workflow",
  schemaVersion: 2,
  id: "00000000-0000-4000-8000-000000000501",
  revision: 1,
  name: "Semantic graph",
  inputs: [],
  entryNodeId: "00000000-0000-4000-8000-000000000502",
  nodes: [
    {
      id: "00000000-0000-4000-8000-000000000502",
      name: "Prepare",
      role: "worker",
      config: { instructions: "Prepare." },
    },
    {
      id: "00000000-0000-4000-8000-000000000503",
      name: "Iterate",
      role: "orchestrator",
      config: {
        mode: "loop",
        agents: ["00000000-0000-4000-8000-000000000504"],
        decider: "00000000-0000-4000-8000-000000000505",
        maxIterations: 3,
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000504",
      name: "Implement",
      role: "worker",
      managedBy: "00000000-0000-4000-8000-000000000503",
      config: { instructions: "Implement." },
    },
    {
      id: "00000000-0000-4000-8000-000000000505",
      name: "Ready?",
      role: "decider",
      managedBy: "00000000-0000-4000-8000-000000000503",
      config: { question: "Ready?" },
    },
    {
      id: "00000000-0000-4000-8000-000000000506",
      name: "Parallel review",
      role: "orchestrator",
      config: {
        mode: "fanout",
        agents: [
          "00000000-0000-4000-8000-000000000507",
          "00000000-0000-4000-8000-000000000508",
        ],
        maxConcurrency: 1,
        completion: "any",
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000507",
      name: "Review",
      role: "worker",
      managedBy: "00000000-0000-4000-8000-000000000506",
      config: { instructions: "Review." },
    },
    {
      id: "00000000-0000-4000-8000-000000000508",
      name: "Test",
      role: "worker",
      managedBy: "00000000-0000-4000-8000-000000000506",
      config: { instructions: "Test." },
    },
    {
      id: "00000000-0000-4000-8000-000000000509",
      name: "Approve",
      role: "human",
      config: { interaction: "approval", prompt: "Approve?" },
    },
    {
      id: "00000000-0000-4000-8000-000000000510",
      name: "Ship?",
      role: "decider",
      config: { question: "Ship?", trueLabel: "Ship", falseLabel: "Stop" },
    },
  ],
  relationships: [
    {
      id: "00000000-0000-4000-8000-000000000511",
      from: "00000000-0000-4000-8000-000000000502",
      to: { nodeId: "00000000-0000-4000-8000-000000000503" },
    },
    {
      id: "00000000-0000-4000-8000-000000000512",
      from: "00000000-0000-4000-8000-000000000503",
      to: { nodeId: "00000000-0000-4000-8000-000000000506" },
    },
    {
      id: "00000000-0000-4000-8000-000000000513",
      from: "00000000-0000-4000-8000-000000000506",
      to: { nodeId: "00000000-0000-4000-8000-000000000509" },
    },
    {
      id: "00000000-0000-4000-8000-000000000514",
      from: "00000000-0000-4000-8000-000000000509",
      when: { equals: true },
      to: { nodeId: "00000000-0000-4000-8000-000000000510" },
    },
    {
      id: "00000000-0000-4000-8000-000000000515",
      from: "00000000-0000-4000-8000-000000000509",
      when: { equals: false },
      to: { end: "rejected" },
    },
    {
      id: "00000000-0000-4000-8000-000000000516",
      from: "00000000-0000-4000-8000-000000000510",
      when: { equals: true },
      to: { end: "completed" },
    },
    {
      id: "00000000-0000-4000-8000-000000000517",
      from: "00000000-0000-4000-8000-000000000510",
      when: { equals: false },
      to: { end: "stopped" },
    },
  ],
};

describe("AgentWorkflowGraph", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onSelectNode = vi.fn();

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    onSelectNode.mockReset();
    vi.restoreAllMocks();
  });

  const render = (
    definition = semanticGraphDefinition,
    occurrences?: CanonicalNodeOccurrence[],
  ) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        createElement(AgentWorkflowGraph, {
          definition,
          occurrences,
          selectedNodeId: "00000000-0000-4000-8000-000000000502",
          onSelectNode,
        }),
      ),
    );
  };

  it("renders semantic loop, fan-out, human, decision routes, and terminals", () => {
    render();
    expect(container!.textContent).toContain("maximum 3 iterations");
    expect(container!.textContent).toContain(
      "completion Decider 00000000-0000-4000-8000-000000000505",
    );
    expect(container!.textContent).toContain("2 Workers");
    expect(container!.textContent).toContain("maximum concurrency 1");
    expect(container!.textContent).toContain("completes when any");
    expect(container!.textContent).toContain("Human interaction: approval");
    expect(container!.textContent).toContain("true (Ship)");
    expect(container!.textContent).toContain("false (Stop)");
    expect(
      container!.querySelector('[aria-label="Terminal outcomes"]')?.textContent,
    ).toContain("completed");
    expect(
      container!.querySelector('[aria-label="Workflow nodes"]')?.textContent,
    ).toContain("Managed by Iterate");
    expect(
      container!.querySelector('[aria-label="Workflow routes"]')?.textContent,
    ).toContain("next iteration");
    const routes = container!.querySelectorAll(
      ".agent-workflow-graph-links polyline",
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0]?.getAttribute("marker-end")).toBe(
      "url(#workflow-graph-arrow)",
    );
  });

  it("renders configured source annotations in the canvas and text alternative", () => {
    render({
      ...semanticGraphDefinition,
      nodes: semanticGraphDefinition.nodes.map((node) =>
        node.id === "00000000-0000-4000-8000-000000000503"
          ? {
              ...node,
              inputBindings: [
                {
                  sourceNodeId: "00000000-0000-4000-8000-000000000502",
                  sourceValue: "finalOutput" as const,
                  label: "Prepared input",
                },
              ],
            }
          : node,
      ),
    });

    const annotations = container!.querySelectorAll(
      '[aria-label="Configured input sources for Iterate"]',
    );
    expect(annotations).toHaveLength(2);
    for (const annotation of annotations) {
      expect(annotation.textContent).toContain("Prepared input");
      expect(annotation.textContent).toContain("Prepare");
      expect(annotation.textContent).toContain("final output");
      expect(annotation.textContent).toContain(
        "00000000-0000-4000-8000-000000000502",
      );
    }
  });

  it("relayouts measured long card content without canvas card intersections", () => {
    const long = "long configured card content ".repeat(80);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const height =
          this.classList.contains("agent-workflow-graph-canvas-node") &&
          this.textContent?.includes(long)
            ? 900
            : 200;
        return {
          bottom: height,
          height,
          left: 0,
          right: 240,
          top: 0,
          width: 240,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
    render({
      ...semanticGraphDefinition,
      nodes: semanticGraphDefinition.nodes.map((node) => {
        if (node.id === "00000000-0000-4000-8000-000000000502")
          return {
            ...node,
            name: long,
            config: { instructions: long },
          };
        if (node.id === "00000000-0000-4000-8000-000000000503")
          return {
            ...node,
            inputBindings: [
              {
                sourceNodeId: "00000000-0000-4000-8000-000000000502",
                sourceValue: "finalOutput" as const,
                label: long,
              },
            ],
          };
        if (node.id === "00000000-0000-4000-8000-000000000505")
          return { ...node, name: long, config: { question: long } };
        return node;
      }),
    });

    const cards = [
      ...container!.querySelectorAll<HTMLElement>(
        ".agent-workflow-graph-canvas-node",
      ),
    ].map((card) => {
      const article = card.querySelector<HTMLElement>(
        ".agent-workflow-graph-node",
      )!;
      return {
        id: card
          .querySelector("[data-workflow-node-id]")
          ?.getAttribute("data-workflow-node-id"),
        height: Number.parseFloat(article.style.minHeight),
        left: Number.parseFloat(card.style.left),
        top: Number.parseFloat(card.style.top),
        width: Number.parseFloat(card.style.width),
      };
    });
    expect(cards.some((card) => card.height === 900)).toBe(true);
    for (const [index, left] of cards.entries()) {
      for (const right of cards.slice(index + 1)) {
        const intersects =
          left.left < right.left + right.width &&
          left.left + left.width > right.left &&
          left.top < right.top + right.height &&
          left.top + left.height > right.top;
        expect(intersects, `${left.id} intersects ${right.id}`).toBe(false);
      }
    }
  });

  it("distinguishes in-progress execution from completed execution", () => {
    render(semanticGraphDefinition, [
      {
        id: "00000000-0000-4000-8000-000000000001",
        nodeId: "00000000-0000-4000-8000-000000000502",
        role: "worker",
        parentOccurrenceIds: [],
        context: [],
        iteration: 1,
        attempt: 1,
        status: "running",
        managedChildren: [],
        aggregation: [],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        nodeId: "00000000-0000-4000-8000-000000000503",
        role: "orchestrator",
        parentOccurrenceIds: [],
        context: [],
        iteration: 1,
        attempt: 1,
        status: "completed",
        managedChildren: [],
        aggregation: [],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    ]);

    const inProgress = container!.querySelector(
      ".agent-workflow-graph-node.is-in_progress",
    )!;
    const completed = container!.querySelector(
      ".agent-workflow-graph-node.is-completed",
    )!;
    expect(inProgress.getAttribute("aria-label")).toContain("In progress");
    expect(inProgress.textContent).toContain("Status: In progress");
    expect(completed.getAttribute("aria-label")).toContain("Completed");
    expect(completed.textContent).toContain("Status: Completed");
  });

  it("renders duplicate same-endpoint routes independently", () => {
    render({
      ...semanticGraphDefinition,
      relationships: [
        ...semanticGraphDefinition.relationships,
        {
          id: "00000000-0000-4000-8000-000000000518",
          from: "00000000-0000-4000-8000-000000000502",
          to: { nodeId: "00000000-0000-4000-8000-000000000503" },
        },
      ],
    });

    expect(
      [
        ...container!.querySelectorAll('[aria-label="Workflow routes"] li'),
      ].filter(
        (route) =>
          route.textContent?.includes("Prepare") &&
          route.textContent?.includes("Iterate"),
      ),
    ).toHaveLength(2);
  });

  it("renders Human choice option labels on their routes", () => {
    render({
      ...semanticGraphDefinition,
      nodes: semanticGraphDefinition.nodes.map((node) =>
        node.id === "00000000-0000-4000-8000-000000000509"
          ? {
              ...node,
              config: {
                interaction: "choice" as const,
                prompt: "Choose a disposition",
                options: ["Ship now", "Request changes"],
              },
            }
          : node,
      ),
      relationships: semanticGraphDefinition.relationships.map(
        (relationship) => {
          if (relationship.id === "00000000-0000-4000-8000-000000000514")
            return { ...relationship, when: { equals: "Ship now" } };
          if (relationship.id === "00000000-0000-4000-8000-000000000515")
            return { ...relationship, when: { equals: "Request changes" } };
          return relationship;
        },
      ),
    });

    const routes = container!.querySelector('[aria-label="Workflow routes"]');
    expect(routes?.textContent).toContain("Ship now");
    expect(routes?.textContent).toContain("Request changes");
    const canvasLabels = [
      ...container!.querySelectorAll(".agent-workflow-graph-edge-label"),
    ].map((label) => label.textContent);
    expect(canvasLabels).toContain("Ship now");
  });

  it("bounds long Human choice route labels while retaining their full text alternative", () => {
    const longLabel = "A long configured route label ".repeat(20).trim();
    render({
      ...semanticGraphDefinition,
      nodes: semanticGraphDefinition.nodes.map((node) =>
        node.id === "00000000-0000-4000-8000-000000000509"
          ? {
              ...node,
              config: {
                interaction: "choice" as const,
                prompt: "Choose a disposition",
                options: [longLabel, "Request changes"],
              },
            }
          : node,
      ),
      relationships: semanticGraphDefinition.relationships.map(
        (relationship) =>
          relationship.id === "00000000-0000-4000-8000-000000000514"
            ? { ...relationship, when: { equals: longLabel } }
            : relationship,
      ),
    });

    const label = [
      ...container!.querySelectorAll<HTMLElement>(
        ".agent-workflow-graph-edge-label",
      ),
    ].find((element) => element.getAttribute("title") === longLabel);
    expect(label).toBeDefined();
    const labelContainer = label?.parentElement!;
    const canvas = container!.querySelector(".agent-workflow-graph-links")!;
    const x = Number(labelContainer.getAttribute("x"));
    const y = Number(labelContainer.getAttribute("y"));
    const width = Number(labelContainer.getAttribute("width"));
    const height = Number(labelContainer.getAttribute("height"));
    expect(width).toBe(160);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(Number(canvas.getAttribute("width")));
    expect(y + height).toBeLessThanOrEqual(
      Number(canvas.getAttribute("height")),
    );
    expect(
      container!.querySelector('[aria-label="Workflow routes"]')?.textContent,
    ).toContain(longLabel);
  });

  it("moves focus and selection along connected graph nodes with arrow keys", () => {
    render();
    const prepare = [
      ...container!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Prepare")!;
    const iterate = [
      ...container!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Iterate")!;
    act(() => {
      prepare.focus();
      prepare.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(iterate);
    expect(onSelectNode).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000503",
    );
    act(() => {
      iterate.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(prepare);
  });

  it("provides selected routes, ownership, and occurrence details in the text alternative", () => {
    render(semanticGraphDefinition, [
      {
        id: "00000000-0000-4000-8000-000000000001",
        nodeId: "00000000-0000-4000-8000-000000000502",
        role: "worker",
        parentOccurrenceIds: [],
        context: [],
        iteration: 1,
        attempt: 2,
        status: "completed",
        output: true,
        managedChildren: [],
        aggregation: [],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        nodeId: "00000000-0000-4000-8000-000000000504",
        role: "worker",
        parentOccurrenceIds: [],
        context: [],
        iteration: 2,
        attempt: 1,
        status: "running",
        managedChildren: [],
        aggregation: [],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    ]);
    const alternative = container!.querySelector(
      ".agent-workflow-graph-text-alternative",
    )!;
    expect(alternative.textContent).toContain("Selected node");
    expect(alternative.textContent).toContain("Managed by Iterate");
    expect(alternative.textContent).toContain(
      "Occurrence 00000000-0000-4000-8000-000000000001",
    );
    expect(alternative.textContent).toContain("iteration 1, attempt 2");
    expect(alternative.textContent).toContain("Selected route");
    expect(alternative.textContent).toContain("State: taken");
  });
});
