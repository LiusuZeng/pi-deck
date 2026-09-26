import { describe, expect, it } from "vitest";
import {
  createInterventionTimelineItem,
  interventionAccessibleLabel,
  markInterventionFailed,
  markInterventionQueued,
  matchDurableInterventionMessages,
  reconcileInterventionQueueEvidence,
  type InterventionTimelineItem,
} from "./interventions.js";

function intervention(
  id: string,
  content: string,
  interventionKind: "steer" | "followUp" = "steer",
): InterventionTimelineItem {
  return createInterventionTimelineItem({
    id,
    interventionKind,
    content,
    createdAt: "10:00",
  });
}

describe("intervention timeline model", () => {
  it("creates an immediate user-owned sending item with distinct semantics", () => {
    const steer = intervention("steer-1", "Focus the tests");
    const followUp = intervention(
      "follow-up-1",
      "Summarize afterward",
      "followUp",
    );

    expect(steer).toMatchObject({
      kind: "intervention",
      interventionKind: "steer",
      status: "sending",
      content: "Focus the tests",
    });
    expect(interventionAccessibleLabel(steer)).toBe("Steering sending");
    expect(interventionAccessibleLabel(followUp)).toBe("Follow-up sending");
  });

  it("shows queued only after acknowledgement or content-bearing queue evidence", () => {
    const sending = intervention("steer-1", "Focus the tests");
    expect(markInterventionQueued(sending).status).toBe("queued");
    expect(
      reconcileInterventionQueueEvidence([sending], {
        steer: ["Focus the tests"],
      })[0]?.status,
    ).toBe("queued");
  });

  it("does not infer consumption from queue disappearance", () => {
    const queued = markInterventionQueued(
      intervention("steer-1", "Focus the tests"),
    );
    const absent = reconcileInterventionQueueEvidence([queued], { steer: [] });

    expect(absent[0]?.status).toBe("accepted");
    expect(interventionAccessibleLabel(absent[0]!)).toContain(
      "confirming transcript receipt",
    );
  });

  it("keeps steering and follow-up queues independent and ordered", () => {
    const items = [
      intervention("steer-1", "First"),
      intervention("follow-up-1", "Later", "followUp"),
      intervention("steer-2", "Second"),
    ];
    const reconciled = reconcileInterventionQueueEvidence(items, {
      steer: ["First", "Second"],
      followUp: ["Later"],
    });

    expect(reconciled.map((item) => [item.id, item.status])).toEqual([
      ["steer-1", "queued"],
      ["follow-up-1", "queued"],
      ["steer-2", "queued"],
    ]);
  });

  it("does not deduplicate repeated identical instructions", () => {
    const first = markInterventionQueued(intervention("steer-1", "Repeat"));
    const second = markInterventionQueued(intervention("steer-2", "Repeat"));
    const afterOneLeavesQueue = reconcileInterventionQueueEvidence(
      [first, second],
      { steer: ["Repeat"] },
    );

    expect(afterOneLeavesQueue).toHaveLength(2);
    expect(afterOneLeavesQueue.map((item) => item.status)).toEqual([
      "accepted",
      "queued",
    ]);

    const matched = matchDurableInterventionMessages({
      interventions: afterOneLeavesQueue,
      existingUsers: [],
      durableUsers: [
        { id: "durable-1", content: "Repeat", createdAt: "10:01" },
      ],
    });
    expect(matched.interventions).toMatchObject([
      { id: "steer-1", status: "consumed", durableMessageId: "durable-1" },
      { id: "steer-2", status: "queued" },
    ]);
  });

  it("reconciles durable evidence into the same item instead of a duplicate", () => {
    const matched = matchDurableInterventionMessages({
      interventions: [
        markInterventionQueued(intervention("steer-1", "Focus the tests")),
      ],
      existingUsers: [{ id: "prompt-1", content: "Start work" }],
      durableUsers: [
        { id: "prompt-1", content: "Start work", createdAt: "09:59" },
        {
          id: "durable-steer-1",
          content: "Focus the tests",
          createdAt: "10:01",
        },
      ],
    });

    expect(matched.interventions).toMatchObject([
      {
        id: "steer-1",
        status: "consumed",
        durableMessageId: "durable-steer-1",
      },
    ]);
    expect(matched.unmatchedDurableMessages).toEqual([]);
  });

  it("reserves an older ordinary user occurrence before matching identical intervention text", () => {
    const matched = matchDurableInterventionMessages({
      interventions: [
        markInterventionQueued(intervention("steer-1", "Same text")),
      ],
      existingUsers: [{ id: "local-prompt", content: "Same text" }],
      durableUsers: [
        { id: "durable-prompt", content: "Same text", createdAt: "09:59" },
        { id: "durable-steer", content: "Same text", createdAt: "10:01" },
      ],
    });

    expect(matched.interventions[0]).toMatchObject({
      status: "consumed",
      durableMessageId: "durable-steer",
    });
  });

  it("keeps failed sends honest and unavailable for durable matching", () => {
    const failed = markInterventionFailed(
      intervention("steer-1", "Cannot send"),
      "RPC rejected",
    );
    const queuedEvidence = reconcileInterventionQueueEvidence([failed], {
      steer: ["Cannot send"],
    });
    const matched = matchDurableInterventionMessages({
      interventions: queuedEvidence,
      existingUsers: [],
      durableUsers: [
        { id: "other-user", content: "Cannot send", createdAt: "10:01" },
      ],
    });

    expect(matched.interventions[0]).toMatchObject({
      status: "failed",
      failureMessage: "RPC rejected",
    });
    expect(matched.unmatchedDurableMessages).toHaveLength(1);
  });
});
