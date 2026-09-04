import type { ChatModelSummary } from "../shared/types.js";

export interface ModelPickerLabelParts {
  primary: string;
  secondary?: string;
  identity: string;
  compact: string;
}

/**
 * Pi's TUI separates friendly names from selectable identity (`id [provider]`).
 * Deck menus need the same identity visible so same-named aliases, snapshots,
 * and gateway-backed models never collapse into indistinguishable rows.
 */
export function modelPickerLabelParts(
  model: Pick<ChatModelSummary, "id" | "name" | "provider">,
): ModelPickerLabelParts {
  const id = model.id.trim() || model.id;
  const name = model.name?.trim();
  const provider = model.provider?.trim();
  const identity = provider ? `${id} [${provider}]` : id;
  const hasFriendlyName = name !== undefined && name.length > 0 && name !== id;
  const primary = hasFriendlyName ? name : id;
  const secondary = hasFriendlyName
    ? provider
      ? `${id} · ${provider}`
      : id
    : provider;
  return {
    primary,
    ...(secondary !== undefined && secondary.length > 0 ? { secondary } : {}),
    identity,
    compact: hasFriendlyName ? `${primary} — ${identity}` : identity,
  };
}
