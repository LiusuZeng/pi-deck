import { describe, expect, it } from "vitest";
import {
  legacySynthesisDeliveryPayload,
  matchesSynthesisDeliveryReceipt,
  normalizedSynthesisDeliveryContent,
  synthesisDeliveryPayload,
} from "./taskSessionSynthesisDelivery.js";

const delivery = synthesisDeliveryPayload({
  id: "12345678-1234-1234-1234-123456789abc",
  attempt: 1,
  originalPrompt: "Reconcile the terminal task.",
  tasks: [
    {
      taskNumber: 1,
      generatedName: "terminal task",
      brief: "finish",
      lifecycle: "completed",
      attempt: 1,
      transitions: [{ lifecycle: "completed", attempt: 1 }],
      handoffSummary: "authoritative handoff",
    },
  ],
});

describe("matchesSynthesisDeliveryReceipt", () => {
  it("accepts only the exact persisted payload, including normalized text parts", () => {
    expect(matchesSynthesisDeliveryReceipt(delivery.payload, delivery)).toBe(
      true,
    );
    const split = [
      { type: "text", text: delivery.payload.slice(0, 47) },
      { type: "text", text: delivery.payload.slice(47) },
    ];
    expect(normalizedSynthesisDeliveryContent(split)).toBe(delivery.payload);
    expect(matchesSynthesisDeliveryReceipt(split, delivery)).toBe(true);
  });

  it("preserves the exact pre-outbox payload for legacy receipt reconciliation", () => {
    const legacy = legacySynthesisDeliveryPayload({
      attempt: 1,
      originalPrompt: "Reconcile the terminal task.",
      tasks: [
        {
          taskNumber: 1,
          generatedName: "terminal task",
          brief: "finish",
          lifecycle: "completed",
          attempt: 1,
          transitions: [{ lifecycle: "completed", attempt: 1 }],
          handoffSummary: "authoritative handoff",
        },
      ],
    });
    expect(legacy.payload).toBe(
      "Task-session synthesis for: Reconcile the terminal task.\n\n#1 terminal task: authoritative handoff",
    );
    expect(matchesSynthesisDeliveryReceipt(legacy.payload, legacy)).toBe(true);
  });

  it("rejects marker-only, copied-marker, and altered payload receipts", () => {
    const markerOnly = delivery.payload.slice(
      0,
      delivery.payload.indexOf("\n"),
    );
    const copiedMarkerPayload = delivery.payload.replace(
      "authoritative handoff",
      "copied marker with another handoff",
    );
    const alteredPayload = `${delivery.payload}\nextra unacknowledged content`;

    expect(matchesSynthesisDeliveryReceipt(markerOnly, delivery)).toBe(false);
    expect(matchesSynthesisDeliveryReceipt(copiedMarkerPayload, delivery)).toBe(
      false,
    );
    expect(matchesSynthesisDeliveryReceipt(alteredPayload, delivery)).toBe(
      false,
    );
  });

  it("rejects multipart copies with non-text or additional content", () => {
    expect(
      matchesSynthesisDeliveryReceipt(
        [
          { type: "text", text: delivery.payload },
          { type: "image", text: delivery.payload },
        ],
        delivery,
      ),
    ).toBe(false);
    expect(
      matchesSynthesisDeliveryReceipt(
        [{ type: "text", text: delivery.payload }, " altered"],
        delivery,
      ),
    ).toBe(false);
  });
});
