import { describe, expect, it } from "vitest";

import {
  parsePiModelList,
  parsePiRuntimeModelDiscovery,
} from "./modelDiscovery.js";

describe("Pi model discovery", () => {
  it("parses the Pi model table into renderer model summaries", () => {
    const models = parsePiModelList(`
provider      model                context  max-out  thinking  images
openai-codex  gpt-5.4              272K     128K     yes       yes
local         text-model           32K      8K       no        no
`);

    expect(models).toEqual([
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "openai-codex",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 272000,
      },
      {
        id: "text-model",
        name: "text-model",
        provider: "local",
        reasoning: false,
        input: ["text"],
        contextWindow: 32000,
      },
    ]);
  });

  it("keeps Pi's active defaults and exact available thinking levels", () => {
    const result = parsePiRuntimeModelDiscovery(
      {
        model: {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai-codex",
          reasoning: true,
          thinkingLevelMap: {
            minimal: "low",
            xhigh: "xhigh",
            max: "max",
          },
        },
        thinkingLevel: "xhigh",
      },
      {
        models: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: "openai-codex",
            reasoning: true,
            thinkingLevelMap: {
              minimal: "low",
              xhigh: "xhigh",
              max: "max",
            },
          },
        ],
      },
      {
        levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
    );

    expect(result.activeModel?.id).toBe("gpt-5.6-sol");
    expect(result.thinkingLevel).toBe("xhigh");
    expect(result.thinkingLevels).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(result.models[0]?.thinkingLevelMap?.max).toBe("max");
  });

  it("ignores unrelated output instead of inventing models", () => {
    expect(parsePiModelList("extension log only")).toEqual([]);
  });
});
