import { describe, expect, it } from "vitest";
import {
  emptyOverlays,
  selectSidebarIndicator,
  type BaseSessionState,
  type SessionOverlays,
} from "./sessionState.js";

function overlays(patch: Partial<SessionOverlays>): SessionOverlays {
  return { ...emptyOverlays, ...patch };
}

describe("selectSidebarIndicator", () => {
  it("follows the documented sidebar priority order", () => {
    const cases: Array<{
      baseState: BaseSessionState;
      overlays: SessionOverlays;
      expected: string;
    }> = [
      {
        baseState: "working",
        overlays: overlays({ needsUserInput: true, toolRunning: true }),
        expected: "needsInput",
      },
      {
        baseState: "error",
        overlays: overlays({ compacting: true }),
        expected: "error",
      },
      {
        baseState: "attaching",
        overlays: overlays({ retrying: true }),
        expected: "attaching",
      },
      {
        baseState: "working",
        overlays: overlays({ compacting: true, retrying: true }),
        expected: "compacting",
      },
      {
        baseState: "working",
        overlays: overlays({ retrying: true, toolRunning: true }),
        expected: "retrying",
      },
      {
        baseState: "working",
        overlays: overlays({ toolRunning: true, streaming: true }),
        expected: "toolRunning",
      },
      {
        baseState: "working",
        overlays: overlays({ localQueuedStartCount: 2 }),
        expected: "working",
      },
      {
        baseState: "idle",
        overlays: overlays({
          localQueuedStartCount: 1,
          piQueuedFollowUpCount: 2,
        }),
        expected: "queued",
      },
      { baseState: "idle", overlays: emptyOverlays, expected: "idle" },
      { baseState: "unloaded", overlays: emptyOverlays, expected: "muted" },
    ];

    for (const testCase of cases) {
      expect(
        selectSidebarIndicator({
          baseState: testCase.baseState,
          overlays: testCase.overlays,
        }).kind,
      ).toBe(testCase.expected);
    }
  });

  it("reports combined queued counts", () => {
    expect(
      selectSidebarIndicator({
        baseState: "idle",
        overlays: overlays({
          localQueuedStartCount: 1,
          piQueuedSteeringCount: 2,
          piQueuedFollowUpCount: 3,
        }),
      }),
    ).toMatchObject({ kind: "queued", queuedCount: 6 });
  });
});
