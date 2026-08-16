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
      id: "00000000-0000-4000-8000-000000000301",
      revision: 1,
      name: "Worker flow",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000302",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000302",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "Work." },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000303",
          from: "00000000-0000-4000-8000-000000000302",
          to: { end: "completed" },
        },
      ],
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

  it("offers a completed occurrence's saved session but not sessionId alone", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000301",
      revision: 1,
      name: "Worker flow",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000302",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000302",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "Work." },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000303",
          from: "00000000-0000-4000-8000-000000000302",
          to: { end: "completed" },
        },
      ],
    };
    const initial = createWorkflowRoleRun(definition, "workspace");
    const completed = {
      ...initial,
      status: "completed" as const,
      occurrences: initial.occurrences.map((occurrence) => ({
        ...occurrence,
        status: "completed" as const,
        sessionId: "not-a-reopen-reference",
        sessionFile: "/tmp/completed.jsonl",
      })),
    };
    const container = document.createElement("div");
    await act(async () =>
      createRoot(container).render(
        createElement(WorkflowOccurrenceRunView, {
          run: completed,
          onBack: vi.fn(),
          onStop: vi.fn(),
          onRetry: vi.fn(),
          onAnswer: vi.fn(),
        }),
      ),
    );
    const completedToggle = container.querySelector<HTMLButtonElement>(
      ".workflow-run-node-toggle",
    )!;
    await act(async () => completedToggle.click());
    expect(container.textContent).toContain("Open Pi session");

    const noReference = {
      ...completed,
      occurrences: completed.occurrences.map((occurrence) => {
        const { sessionFile: _sessionFile, ...withoutSessionFile } = occurrence;
        return withoutSessionFile;
      }),
    };
    await act(async () =>
      createRoot(container).render(
        createElement(WorkflowOccurrenceRunView, {
          run: noReference,
          onBack: vi.fn(),
          onStop: vi.fn(),
          onRetry: vi.fn(),
          onAnswer: vi.fn(),
        }),
      ),
    );
    const noReferenceToggle = container.querySelector<HTMLButtonElement>(
      ".workflow-run-node-toggle",
    )!;
    await act(async () => noReferenceToggle.click());
    expect(container.textContent).not.toContain("Open Pi session");
  });

  it("renders occurrence details and submits Human approval without a session", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000304",
      revision: 1,
      name: "Human flow",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000305",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000305",
          name: "Approve",
          role: "human" as const,
          config: { interaction: "approval" as const, prompt: "Approve this?" },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000306",
          from: "00000000-0000-4000-8000-000000000305",
          when: { equals: true },
          to: { end: "completed" },
        },
        {
          id: "00000000-0000-4000-8000-000000000307",
          from: "00000000-0000-4000-8000-000000000305",
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
    const reject = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reject",
    )!;
    expect(approve.classList.contains("workflow-primary-button")).toBe(true);
    expect(reject.classList.contains("workflow-secondary-button")).toBe(true);
    await act(async () => approve.click());
    expect(onAnswer).toHaveBeenCalledWith(run.occurrences[0].id, true);
  });

  it("summarizes logical nodes and reveals raw attempts on intentional selection", async () => {
    const definition = {
      format: "pi-deck.agent-workflow" as const,
      schemaVersion: 2 as const,
      id: "00000000-0000-4000-8000-000000000308",
      revision: 1,
      name: "Retry flow",
      inputs: [],
      entryNodeId: "00000000-0000-4000-8000-000000000302",
      nodes: [
        {
          id: "00000000-0000-4000-8000-000000000302",
          name: "Work",
          role: "worker" as const,
          config: { instructions: "Do the raw work." },
        },
      ],
      relationships: [
        {
          id: "00000000-0000-4000-8000-000000000303",
          from: "00000000-0000-4000-8000-000000000302",
          to: { end: "completed" },
        },
      ],
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
      id: "00000000-0000-4000-8000-000000000309",
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
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Prompt: Do the raw work.");
    expect(container.textContent).toContain("Raw worker output");
    expect(container.textContent).toContain("Iteration 1 · Attempt 1");
    expect(container.textContent).toContain("Iteration 1 · Attempt 2");
  });
});
