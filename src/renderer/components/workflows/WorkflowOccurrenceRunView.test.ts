/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act, createElement } from "react";
import { WorkflowOccurrenceRunView } from "./WorkflowOccurrenceRunView.js";
import { createWorkflowRoleRun } from "../../../main/workflows/agentWorkflowRuntime.js";

describe("WorkflowOccurrenceRunView", () => {
  it("passes the complete occurrence reference when opening a Pi session", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "worker",
      revision: 1,
      name: "Worker flow",
      inputs: [],
      entryNodeId: "work",
      nodes: [
        {
          id: "work",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "Work." },
        },
      ],
      relationships: [{ id: "end", from: "work", to: { end: "completed" } }],
    };
    const initial = createWorkflowRoleRun(definition, "workspace");
    const run = {
      ...initial,
      occurrences: initial.occurrences.map((occurrence) => ({
        ...occurrence,
        status: "running" as const,
        runtimeId: "runtime-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
      })),
    };
    const onOpenSession = vi.fn();
    const container = document.createElement("div");
    await act(async () =>
      createRoot(container).render(
        createElement(WorkflowOccurrenceRunView, {
          run,
          onBack: vi.fn(),
          onStop: vi.fn(),
          onRetry: vi.fn(),
          onAnswer: vi.fn(),
          onOpenSession,
        }),
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      ".workflow-run-node-toggle",
    )!;
    await act(async () => toggle.click());
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Open Pi session",
    )!;
    await act(async () => open.click());
    expect(onOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "runtime-1",
        sessionFile: "/tmp/session-1.jsonl",
      }),
    );
  });

  it("renders occurrence details and submits Human approval without a session", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "human",
      revision: 1,
      name: "Human flow",
      inputs: [],
      entryNodeId: "ask",
      nodes: [
        {
          id: "ask",
          name: "Approve",
          role: "human" as const,
          config: { interaction: "approval" as const, prompt: "Approve this?" },
        },
      ],
      relationships: [
        {
          id: "yes",
          from: "ask",
          when: { equals: true },
          to: { end: "completed" },
        },
        {
          id: "no",
          from: "ask",
          when: { equals: false },
          to: { end: "rejected" },
        },
      ],
    };
    const run = createWorkflowRoleRun(definition, "workspace");
    const onAnswer = vi.fn();
    const container = document.createElement("div");
    await act(async () =>
      createRoot(container).render(
        createElement(WorkflowOccurrenceRunView, {
          run,
          onBack: vi.fn(),
          onStop: vi.fn(),
          onRetry: vi.fn(),
          onAnswer,
        }),
      ),
    );
    expect(container.textContent).toContain("Waiting for your input");
    expect(container.textContent).toContain("Logical execution");
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    )!;
    await act(async () => approve.click());
    expect(onAnswer).toHaveBeenCalledWith(run.occurrences[0].id, true);
  });

  it("summarizes logical nodes and reveals raw attempts with keyboard selection", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "retry",
      revision: 1,
      name: "Retry flow",
      inputs: [],
      entryNodeId: "work",
      nodes: [
        {
          id: "work",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "Do the raw work." },
        },
      ],
      relationships: [{ id: "end", from: "work", to: { end: "completed" } }],
    };
    const initial = createWorkflowRoleRun(definition, "workspace");
    const first = {
      ...initial.occurrences[0],
      status: "skipped" as const,
      attempt: 1,
      error: "First attempt failed",
    };
    const second = {
      ...first,
      id: "second-attempt",
      status: "completed" as const,
      attempt: 2,
      output: "Raw worker output",
      updatedAtMs: first.updatedAtMs + 1,
    };
    const run = {
      ...initial,
      status: "completed" as const,
      terminalOutcome: "completed",
      occurrences: [first, second],
    };
    const container = document.createElement("div");
    await act(async () =>
      createRoot(container).render(
        createElement(WorkflowOccurrenceRunView, {
          run,
          onBack: vi.fn(),
          onStop: vi.fn(),
          onRetry: vi.fn(),
          onAnswer: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain("1 logical node");
    expect(container.textContent).toContain("Path: Work → completed");
    expect(container.textContent).toContain("1 retry");
    expect(container.textContent).not.toContain("Raw worker output");
    const toggle = container.querySelector<HTMLButtonElement>(
      ".workflow-run-node-toggle",
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () =>
      toggle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Prompt: Do the raw work.");
    expect(container.textContent).toContain("Raw worker output");
    expect(container.textContent).toContain("Iteration 1 · Attempt 1");
    expect(container.textContent).toContain("Iteration 1 · Attempt 2");
  });
});
