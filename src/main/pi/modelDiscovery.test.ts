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

  it(
    "normalizes production supportedThinkingLevels when runtime levels are empty",
    () => {
      const result = parsePiRuntimeModelDiscovery(
        {
          model: {
            id: "gpt-5.6-sol",
          },
          provider: "openai-codex",
          thinkingLevel: "high",
        },
        {
          models: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              provider: "openai-codex",
              supportedThinkingLevels: [
                "off",
                "low",
                "medium",
                "high",
                "xhigh",
              ],
            },
          ],
        },
        { levels: [] },
      );

      expect(result.thinkingLevels).toEqual([]);
      expect(result.models[0]).toMatchObject({
        id: "gpt-5.6-sol",
        provider: "openai-codex",
        reasoning: true,
        thinkingLevelMap: {
          off: "off",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: null,
        },
      });
      expect(result.activeModel).toMatchObject({
        id: "gpt-5.6-sol",
        provider: "openai-codex",
        reasoning: true,
        thinkingLevelMap: {
          off: "off",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: null,
        },
      });
    },
  );

  it(
    "keeps Off-only for a model that explicitly reports no thinking levels",
    () => {
      const result = parsePiRuntimeModelDiscovery(
        {
          model: {
            id: "text-model",
          },
          provider: "local",
          thinkingLevel: "off",
        },
        {
          models: [
            {
              id: "text-model",
              provider: "local",
              supportedThinkingLevels: ["off"],
            },
          ],
        },
        { levels: [] },
      );

      expect(result.models[0]).toMatchObject({
        reasoning: false,
        thinkingLevelMap: {
          off: "off",
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
      });
      expect(result.activeModel?.reasoning).toBe(false);
    },
  );

  it("preserves Pi's explicit level remapping for supported levels", () => {
    const result = parsePiRuntimeModelDiscovery(
      {},
      {
        models: [
          {
            id: "mapped-model",
            provider: "provider",
            supportedThinkingLevels: [
              "off",
              "minimal",
              "low",
              "medium",
              "high",
            ],
            thinkingLevelMap: {
              minimal: "low",
            },
          },
        ],
      },
      { levels: [] },
    );

    expect(result.models[0]?.thinkingLevelMap).toMatchObject({
      off: "off",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("ignores unrelated output instead of inventing models", () => {
    expect(parsePiModelList("extension log only")).toEqual([]);
  });
});
