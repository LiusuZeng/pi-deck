import type {
  ChatModelSummary,
  ParallelWorkerSettings,
} from "../../../shared/types.js";
import { Menu } from "../ui/Menu.js";

export interface ParallelPromptSettingsProps {
  destination: "parent" | "newTaskSession";
  defaults: ParallelWorkerSettings;
  models: readonly ChatModelSummary[];
  thinkingLevels: readonly string[];
  overrides: ParallelWorkerSettings;
  onSetDestination(destination: "parent" | "newTaskSession"): void;
  onOverrideModel(model: ParallelWorkerSettings["model"]): void;
  onOverrideThinking(thinkingLevel: string | undefined): void;
  onUpdateDefaults(settings: ParallelWorkerSettings): void;
}

/** Compact prompt routing control; worker configuration lives in a popover. */
export function ParallelPromptSettings({
  destination,
  defaults,
  models,
  thinkingLevels,
  overrides,
  onSetDestination,
  onOverrideModel,
  onOverrideThinking,
  onUpdateDefaults,
}: ParallelPromptSettingsProps) {
  const modelValue = overrides.model ? encodeModelOption(overrides.model) : "";
  const promptThinkingLevels = thinkingLevelsForModel(
    overrides.model ?? defaults.model,
    models,
    thinkingLevels,
  );
  const defaultThinkingLevels = thinkingLevelsForModel(
    defaults.model,
    models,
    thinkingLevels,
  );
  return (
    <div className="parallel-prompt-settings">
      <label className="parallel-prompt-settings__destination">
        <span className="sr-only">Prompt destination</span>
        <select
          aria-label="Prompt destination"
          value={destination}
          onChange={(event) =>
            onSetDestination(event.target.value as "parent" | "newTaskSession")
          }
        >
          <option value="newTaskSession">New task session</option>
          <option value="parent">Work in parent</option>
        </select>
      </label>
      <Menu
        className="parallel-prompt-settings__menu"
        label="Parallel worker settings"
        menu={false}
        menuLabel="Parallel worker settings"
      >
        <div
          aria-label="Parallel worker settings"
          className="parallel-prompt-settings__popover"
        >
          <label>
            Worker model
            <select
              aria-label="Worker model override"
              value={modelValue}
              onChange={(event) => {
                onOverrideModel(decodeModelOption(event.target.value));
              }}
            >
              <option value="">Use persistent default</option>
              {models.flatMap((model) =>
                model.provider
                  ? [
                      <option
                        key={encodeModelOption({
                          provider: model.provider,
                          modelId: model.id,
                        })}
                        value={encodeModelOption({
                          provider: model.provider,
                          modelId: model.id,
                        })}
                      >
                        {model.name ?? model.id}
                      </option>,
                    ]
                  : [],
              )}
            </select>
          </label>
          <label>
            Worker thinking
            <select
              aria-label="Worker thinking override"
              value={overrides.thinkingLevel ?? ""}
              onChange={(event) =>
                onOverrideThinking(event.target.value || undefined)
              }
            >
              <option value="">Use persistent default</option>
              {promptThinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>Persistent worker defaults</summary>
            <label>
              Default model
              <select
                aria-label="Persistent worker model"
                value={defaults.model ? encodeModelOption(defaults.model) : ""}
                onChange={(event) => {
                  onUpdateDefaults({
                    ...defaults,
                    model: decodeModelOption(event.target.value),
                    thinkingLevel: undefined,
                  });
                }}
              >
                <option value="">Inherit parent model</option>
                {models.flatMap((model) =>
                  model.provider
                    ? [
                        <option
                          key={encodeModelOption({
                            provider: model.provider,
                            modelId: model.id,
                          })}
                          value={encodeModelOption({
                            provider: model.provider,
                            modelId: model.id,
                          })}
                        >
                          {model.name ?? model.id}
                        </option>,
                      ]
                    : [],
                )}
              </select>
            </label>
            <label>
              Default thinking
              <select
                aria-label="Persistent worker thinking"
                value={defaults.thinkingLevel ?? ""}
                onChange={(event) =>
                  onUpdateDefaults({
                    ...defaults,
                    ...(event.target.value
                      ? { thinkingLevel: event.target.value }
                      : { thinkingLevel: undefined }),
                  })
                }
              >
                <option value="">Inherit parent thinking</option>
                {defaultThinkingLevels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          </details>
        </div>
      </Menu>
    </div>
  );
}

type ModelSelection = NonNullable<ParallelWorkerSettings["model"]>;

/** JSON keeps arbitrary provider/model IDs reversible without DOM control bytes. */
function encodeModelOption(model: ModelSelection): string {
  return JSON.stringify([model.provider, model.modelId]);
}

function decodeModelOption(value: string): ModelSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      !parsed[0] ||
      typeof parsed[1] !== "string" ||
      !parsed[1]
    ) {
      return undefined;
    }
    const model = { provider: parsed[0], modelId: parsed[1] };
    return encodeModelOption(model) === value ? model : undefined;
  } catch {
    return undefined;
  }
}

function thinkingLevelsForModel(
  selected: ParallelWorkerSettings["model"],
  models: readonly ChatModelSummary[],
  fallback: readonly string[],
): readonly string[] {
  if (!selected) return fallback;
  const model = models.find(
    (candidate) =>
      candidate.provider === selected.provider &&
      candidate.id === selected.modelId,
  );
  if (!model) return fallback;
  if (model.reasoning === false) return ["off"];
  const mapped = Object.entries(model.thinkingLevelMap ?? {})
    .filter(([, providerLevel]) => providerLevel !== null)
    .map(([level]) => level);
  return mapped.length > 0 ? mapped : fallback;
}
