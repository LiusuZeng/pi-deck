import { describe, expect, it } from "vitest";
import {
  moveOutputRevisionTarget,
  outputRevisionTargetForSession,
  outputRevisionTargetKey,
  removeOutputRevisionTarget,
  type OutputRevisionTarget,
} from "./outputRevisionTargets.js";

const target: OutputRevisionTarget = {
  outputId: "output-1",
  expectedRevisionId: "revision-1",
  title: "Release plan",
  displayNumber: 1,
};

const draft = { id: "draft-1", workspaceId: "workspace-a" };
const firstRuntime = {
  id: "runtime-1",
  workspaceId: "workspace-a",
  sessionFile: "/sessions/revision.jsonl",
};

describe("output revision targets", () => {
  it("migrates a draft target to the native session identity", () => {
    const temporaryKey = outputRevisionTargetKey(draft);
    const targets = moveOutputRevisionTarget(
      { [temporaryKey]: target },
      draft,
      firstRuntime,
    );

    expect(targets[temporaryKey]).toBeUndefined();
    expect(outputRevisionTargetForSession(targets, firstRuntime)).toEqual(
      target,
    );
  });

  it("retains a revision target after runtime replacement and renderer reload", () => {
    const targets = moveOutputRevisionTarget(
      { [outputRevisionTargetKey(draft)]: target },
      draft,
      firstRuntime,
    );
    const resumedRuntime = { ...firstRuntime, id: "runtime-after-restart" };

    expect(outputRevisionTargetKey(resumedRuntime)).toBe(
      outputRevisionTargetKey(firstRuntime),
    );
    expect(
      outputRevisionTargetForSession({ ...targets }, resumedRuntime),
    ).toEqual(target);
  });

  it("does not attach a target to a fork or a different workspace", () => {
    const targets = {
      [outputRevisionTargetKey(firstRuntime)]: target,
    };

    expect(
      outputRevisionTargetForSession(targets, {
        ...firstRuntime,
        id: "fork-runtime",
        sessionFile: "/sessions/fork.jsonl",
      }),
    ).toBeUndefined();
    expect(
      outputRevisionTargetForSession(targets, {
        ...firstRuntime,
        id: "other-workspace-runtime",
        workspaceId: "workspace-b",
      }),
    ).toBeUndefined();
  });

  it("removes only the saved revision target", () => {
    const targetKey = outputRevisionTargetKey(firstRuntime);
    const otherKey = outputRevisionTargetKey({
      ...firstRuntime,
      sessionFile: "/sessions/other.jsonl",
    });

    expect(
      removeOutputRevisionTarget(
        {
          [targetKey]: target,
          [otherKey]: { ...target, outputId: "output-2" },
        },
        targetKey,
      ),
    ).toEqual({ [otherKey]: { ...target, outputId: "output-2" } });
  });
});
