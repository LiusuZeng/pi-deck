import assert from "node:assert/strict";
import { it as test } from "vitest";
import { JsonlRpcDeliveryError, JsonlRpcError } from "./pi/jsonlClient.js";
import { coercePreDispatchPromptError } from "./promptDeliveryErrors.js";

test("pre-dispatch unknown RPC failures do not masquerade as prompt delivery uncertainty", () => {
  const original = new JsonlRpcDeliveryError(
    "RPC command timed out before response: get_state",
    "unknown",
  );

  assert.throws(
    () => coercePreDispatchPromptError(original),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof JsonlRpcDeliveryError));
      assert.match(error.message, /failed before dispatch/i);
      assert.match(error.message, /has not received the prompt command/i);
      assert.equal((error as Error & { cause?: unknown }).cause, original);
      assert.equal(
        (error as Error & { deliveryStatus?: unknown }).deliveryStatus,
        undefined,
      );
      return true;
    },
  );
});

test("pre-dispatch explicit RPC rejections keep the normal rejection path", () => {
  const explicit = new JsonlRpcError("Images are not allowed", "VALIDATION");

  assert.throws(
    () => coercePreDispatchPromptError(explicit),
    (error: unknown) => error === explicit,
  );
});
