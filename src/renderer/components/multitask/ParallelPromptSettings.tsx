import type {
  ChatModelSummary,
  ParallelWorkerSettings,
} from "../../../shared/types.js";

export interface ParallelPromptSettingsProps {
  destination: "parent" | "newTaskSession";
  defaults: ParallelWorkerSettings;
  models: readonly ChatModelSummary[];
  thinkingLevels: readonly string[];
  overrides: ParallelWorkerSettings;
  onWorkInParent(): void;
  onOverrideModel(model: ParallelWorkerSettings["model"]): void;
  onOverrideThinking(thinkingLevel: string | undefined): void;
  onUpdateDefaults(settings: ParallelWorkerSettings): void;
}

export function ParallelPromptSettings({
  destination,
  defaults,
  models,
  thinkingLevels,
  overrides,
  onWorkInParent,
  onOverrideModel,
  onOverrideThinking,
  onUpdateDefaults,
}: ParallelPromptSettingsProps) {
  const modelValue = overrides.model
    ? `${overrides.model.provider}\u0000${overrides.model.modelId}`
    : "";
  return (
    <div
      className="parallel-prompt-settings"
      aria-label="Parallel task destination and worker overrides"
    >
      <span
        className="parallel-prompt-settings__destination"
        aria-live="polite"
      >
        {destination === "parent" ? "Work in parent" : "New task session"}
      </span>
      {destination === "newTaskSession" ? (
        <button type="button" onClick={onWorkInParent}>
          Work in parent once
        </button>
      ) : null}
      <label>
        Worker model{" "}
        <small>
          (prompt override; default:{" "}
          {defaults.model
            ? `${defaults.model.provider}/${defaults.model.modelId}`
            : "inherit parent"}
          )
        </small>
        <select
          aria-label="Worker model override"
          value={modelValue}
          onChange={(event) => {
            const [provider, modelId] = event.target.value.split("\u0000");
            onOverrideModel(
              provider && modelId ? { provider, modelId } : undefined,
            );
          }}
        >
          <option value="">Use persistent default</option>
          {models.flatMap((model) =>
            model.provider
              ? [
                  <option
                    key={`${model.provider}\u0000${model.id}`}
                    value={`${model.provider}\u0000${model.id}`}
                  >
                    {model.name ?? model.id}
                  </option>,
                ]
              : [],
          )}
        </select>
      </label>
      <label>
        Worker thinking{" "}
        <small>
          (prompt override; default:{" "}
          {defaults.thinkingLevel ?? "inherit parent"})
        </small>
        <select
          aria-label="Worker thinking override"
          value={overrides.thinkingLevel ?? ""}
          onChange={(event) =>
            onOverrideThinking(event.target.value || undefined)
          }
        >
          <option value="">Use persistent default</option>
          {thinkingLevels.map((level) => (
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
            value={
              defaults.model
                ? `${defaults.model.provider}\u0000${defaults.model.modelId}`
                : ""
            }
            onChange={(event) => {
              const [provider, modelId] = event.target.value.split("\u0000");
              onUpdateDefaults({
                ...defaults,
                ...(provider && modelId
                  ? { model: { provider, modelId } }
                  : { model: undefined }),
              });
            }}
          >
            <option value="">Inherit parent model</option>
            {models.flatMap((model) =>
              model.provider
                ? [
                    <option
                      key={`${model.provider}\u0000${model.id}`}
                      value={`${model.provider}\u0000${model.id}`}
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
            {thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </details>
    </div>
  );
}
