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
    expect(container.textContent).not.toContain("Open Pi session");
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
    expect(container.textContent).toContain("Iteration 1 · Attempt 1");
    expect(container.textContent).toContain("waitingHuman");
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    )!;
    await act(async () => approve.click());
    expect(onAnswer).toHaveBeenCalledWith(run.occurrences[0].id, true);
  });
});
