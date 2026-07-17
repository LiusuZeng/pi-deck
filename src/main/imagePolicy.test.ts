import assert from "node:assert/strict";
import { it as test } from "vitest";
import { Buffer } from "node:buffer";
import {
  assertImagePromptPermitted,
  decodeImageBase64,
  inspectImage,
  MAX_IMAGE_PIXELS,
} from "./imagePolicy.js";

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

test("image policy sniffs PNG bytes rather than a caller MIME claim", () => {
  assert.deepEqual(inspectImage(png(640, 480)), {
    mimeType: "image/png",
    width: 640,
    height: 480,
  });
  assert.throws(
    () => inspectImage(Buffer.from("not actually an image")),
    /Unsupported/,
  );
});

test("image policy rejects malformed base64 and decoded pixel bombs", () => {
  assert.throws(() => decodeImageBase64("not-base64!"), /invalid/);
  const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS + 1));
  assert.throws(() => inspectImage(png(side, side)), /50 megapixel/);
});

test("main-process policy blocks effective settings and non-image models", () => {
  assert.throws(
    () =>
      assertImagePromptPermitted(
        { blockImages: true },
        { input: ["text", "image"] },
      ),
    /blockImages/,
  );
  assert.throws(
    () =>
      assertImagePromptPermitted({ blockImages: false }, { input: ["text"] }),
    /does not support image/,
  );
  assert.doesNotThrow(() =>
    assertImagePromptPermitted(
      { blockImages: false },
      { input: ["text", "image"] },
    ),
  );
});

test("image policy accepts canonical renderer base64", () => {
  const data = png(1, 1);
  assert.deepEqual(decodeImageBase64(data.toString("base64")), data);
});
