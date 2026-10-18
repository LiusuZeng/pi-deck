import { isUnknownJsonlRpcDeliveryError } from "./pi/jsonlClient.js";

/**
 * Convert failures that happen before the prompt command is dispatched into a
 * regular rejection. A timeout while preparing image policy/model metadata is
 * uncertain for that preparatory RPC, but it is not evidence that Pi received
 * the user's prompt.
 */
export function coercePreDispatchPromptError(error: unknown): never {
  if (isUnknownJsonlRpcDeliveryError(error)) {
    throw new Error(
      `Prompt preparation failed before dispatch; Pi has not received the prompt command: ${error.message}`,
      { cause: error },
    );
  }
  throw error;
}
