import { describe, expect, it } from "vitest";
import {
  agentWorkflowsUnavailableMessage,
  initializeWorkflows,
  requireAgentWorkflows,
} from "./workflowAvailability.js";

describe("workflow availability", () => {
  it("exposes a successfully initialized workflow store", async () => {
    const initialization = await initializeWorkflows(async () => "store");

    expect(initialization).toEqual({ status: "available", value: "store" });
    expect(requireAgentWorkflows(initialization)).toBe("store");
  });

  it("preserves a failing initialization as an actionable unavailable state", async () => {
    const initialization = await initializeWorkflows(async () => {
      throw new Error("workflow metadata is malformed");
    });

    expect(initialization).toEqual({
      status: "unavailable",
      diagnostic:
        "Agent Workflows unavailable: workflow metadata could not be initialized. Existing workflow metadata was left unchanged. workflow metadata is malformed",
    });
    expect(() => requireAgentWorkflows(initialization)).toThrow(
      agentWorkflowsUnavailableMessage,
    );
  });

  it("rejects workflow calls before initialization", () => {
    expect(() => requireAgentWorkflows(undefined)).toThrow(
      agentWorkflowsUnavailableMessage,
    );
  });
});
