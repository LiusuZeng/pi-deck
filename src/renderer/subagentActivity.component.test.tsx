import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentActivityGroup, SubagentActivityView } from "./App.js";
import type { SubagentActivity } from "./subagentActivity.js";

function render(activity: SubagentActivity): string {
  return renderToStaticMarkup(
    createElement(SubagentActivityView, { activity }),
  );
}

describe("SubagentActivityView", () => {
  it("renders an accessible read-only row per stable child index", () => {
    const markup = render({
      mode: "parallel",
      children: [
        {
          index: 0,
          agent: "worker",
          task: "Inspect the reducer",
          state: "Activity observed",
          latest: "Used read",
          lastObservedAtMs: 1,
          completedTurns: 1,
          usage: { totalTokens: 42 },
          model: "model-a",
          history: [
            { kind: "tool", label: "read" },
            { kind: "text", text: "Located the projection." },
          ],
        },
        {
          index: 1,
          agent: "worker",
          task: "Review the styles",
          state: "Waiting for activity",
          history: [],
        },
      ],
    });

    expect(markup).toContain(
      'class="subagent-activity" role="region" aria-label="Subagent activity"',
    );
    expect(markup).toContain('role="listitem" data-subagent-index="0"');
    expect(markup).toContain('role="listitem" data-subagent-index="1"');
    expect(markup.match(/<summary>View activity<\/summary>/g)).toHaveLength(2);
    expect(markup).toContain("Inspect the reducer");
    expect(markup).toContain("Review the styles");
    expect(markup).toContain("Activity observed");
    expect(markup).toContain("Waiting for activity");
    expect(markup).toContain("Last observed ");
    expect(markup).toContain("1 completed turn · 42 tokens · model-a");
    expect(markup).toContain("<strong>Tool</strong> read");
    expect(markup).toContain("No public activity has been observed.");
    expect(markup).not.toContain("button");
    expect(markup).not.toContain("textarea");
  });

  it("exposes child activity from the open group without opening raw milestones", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentActivityGroup, {
        group: {
          kind: "activity",
          id: "agent-activity-subagent-call",
          state: "running",
          items: [
            {
              id: "subagent-call",
              kind: "tool",
              title: "subagent",
              summary: "delegated work",
              details: "raw delegated input",
              status: "running",
              createdAt: "Now",
              subagentActivity: {
                mode: "single",
                children: [
                  {
                    index: 0,
                    agent: "worker",
                    task: "Inspect Electron markup",
                    state: "Waiting for activity",
                    history: [],
                  },
                ],
              },
            },
            {
              id: "read-call",
              kind: "tool",
              title: "read",
              summary: "src/renderer/App.tsx",
              details: "raw read output",
              status: "success",
              createdAt: "Now",
            },
          ],
        },
        open: true,
        onGroupFocus() {},
        onGroupSummaryClick() {},
        onGroupSummaryKeyDown() {},
        onGroupToggle() {},
        onDetailsSummaryClick() {},
        onDetailsToggle() {},
      } as any),
    );

    expect(markup).toContain('<details class="agent-activity-group" open="">');
    expect(markup).toMatch(
      /agent-activity-milestone running"><div class="agent-activity-milestone-static"[\s\S]*aria-label="Subagent activity"/,
    );
    expect(markup).not.toMatch(
      /agent-activity-milestone running"><details[^>]*>[\s\S]*aria-label="Subagent activity"/,
    );
    expect(markup).toMatch(/agent-activity-milestone completed"><details>/);
    expect(markup).toContain("Inspect Electron markup");
  });

  it("renders terminal chain semantics without using agent names as keys", () => {
    const markup = render({
      mode: "chain",
      children: [
        {
          index: 0,
          step: 1,
          agent: "worker",
          task: "First",
          state: "Failed",
          history: [{ kind: "error", text: "A bounded failure" }],
        },
        {
          index: 1,
          step: 2,
          agent: "worker",
          task: "Second",
          state: "Not run",
          history: [],
        },
      ],
    });

    expect(markup).toContain("Chain · 2 tasks");
    expect(markup).toContain("Step 1");
    expect(markup).toContain("Step 2");
    expect(markup).toContain("Failed");
    expect(markup).toContain("Not run");
  });
});
