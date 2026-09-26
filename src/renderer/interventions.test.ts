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
      localTimeline: afterOneLeavesQueue,
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
      localTimeline: [
        { id: "prompt-1", kind: "user", content: "Start work" },
        markInterventionQueued(intervention("steer-1", "Focus the tests")),
      ],
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
      localTimeline: [
        { id: "local-prompt", kind: "user", content: "Same text" },
        markInterventionQueued(intervention("steer-1", "Same text")),
      ],
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

  it("matches duplicate text in combined timeline order across a snapshot race", () => {
    const matched = matchDurableInterventionMessages({
      localTimeline: [
        { id: "local-old", kind: "user", content: "Same text" },
        markInterventionQueued(intervention("steer-1", "Same text")),
        // This optimistic prompt was appended after the snapshot request. It
        // must not reserve evidence for the earlier intervention.
        { id: "local-future", kind: "user", content: "Same text" },
      ],
      durableUsers: [
        { id: "durable-old", content: "Same text", createdAt: "09:59" },
        {
          id: "durable-intervention",
          content: "Same text",
          createdAt: "10:01",
        },
      ],
    });

    expect(matched.interventions[0]).toMatchObject({
      id: "steer-1",
      status: "consumed",
      durableMessageId: "durable-intervention",
    });
    expect(matched.unmatchedDurableMessages).toEqual([]);
  });

  it("uses normalized attachment evidence to disambiguate identical text", () => {
    const localImage = {
      id: "local-image",
      fileName: " chart.png ",
      kind: "image" as const,
      sendMode: "imageInput" as const,
      mimeType: "IMAGE/PNG",
      previewDataUrl: "data:image/png;base64,local",
    };
    const queued = markInterventionQueued({
      ...intervention("steer-image", "Describe this"),
      attachments: [localImage],
    });
    const matched = matchDurableInterventionMessages({
      localTimeline: [
        {
          id: "ordinary-other-image",
          kind: "user",
          content: "Describe this",
          attachments: [
            {
              ...localImage,
              fileName: "notes.txt",
              kind: "textFile",
              sendMode: "pathReference",
            },
          ],
        },
        queued,
      ],
      durableUsers: [
        {
          id: "durable-image",
          content: "Describe this",
          createdAt: "10:01",
          attachments: [
            {
              ...localImage,
              id: "durable-generated-id",
              fileName: "chart.png",
              mimeType: "image/png",
              previewDataUrl: "data:image/png;base64,durable",
            },
          ],
        },
      ],
    });

    expect(matched.interventions[0]).toMatchObject({
      status: "consumed",
      durableMessageId: "durable-image",
    });
    expect(matched.unmatchedDurableMessages).toEqual([]);
  });

  it("ignores duplicate durable rows instead of consuming duplicate locals", () => {
    const matched = matchDurableInterventionMessages({
      localTimeline: [
        { id: "ordinary", kind: "user", content: "Repeat" },
        markInterventionQueued(intervention("steer-1", "Repeat")),
      ],
      durableUsers: [
        { id: "durable-1", content: "Repeat", createdAt: "10:01" },
        { id: "durable-1", content: "Repeat", createdAt: "10:01" },
      ],
    });

    expect(matched.interventions[0]).toMatchObject({ status: "queued" });
    expect(matched.unmatchedDurableMessages).toEqual([]);
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
      localTimeline: queuedEvidence,
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
