import { Buffer } from "node:buffer";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 50_000_000;
export const MAX_IMAGE_DIMENSION = 2_000;

export type SupportedImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export interface ImageInspection {
  mimeType: SupportedImageMimeType;
  width: number;
  height: number;
}

export interface ImagePromptSettings {
  blockImages: boolean;
  autoResize: boolean;
}

/** Main-process gate before any file bytes are read or sent to Pi. */
export function assertImagePromptPermitted(
  settings: Pick<ImagePromptSettings, "blockImages">,
  activeModel: unknown,
): void {
  if (settings.blockImages) {
    throw new Error(
      "Image input is disabled by the effective Pi images.blockImages setting.",
    );
  }
  if (activeModel !== undefined && !modelSupportsImages(activeModel)) {
    throw new Error(
      "The active model does not support image input (or its capability could not be verified).",
    );
  }
}

function modelSupportsImages(model: unknown): boolean {
  if (!model || typeof model !== "object" || Array.isArray(model)) return false;
  const input = (model as { input?: unknown }).input;
  return (
    Array.isArray(input) &&
    input.some((value) => typeof value === "string" && /image/i.test(value))
  );
}

/** Decode renderer input strictly: Buffer.from otherwise silently accepts junk. */
export function decodeImageBase64(dataBase64: string): Buffer {
  if (
    dataBase64.length === 0 ||
    dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    dataBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      dataBase64,
    )
  ) {
    throw new Error("Image data is invalid or exceeds the 20 MB safety limit.");
  }
  const data = Buffer.from(dataBase64, "base64");
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    throw new Error("Image exceeds the 20 MB safety limit.");
  }
  return data;
}

/**
 * Detect from bytes, never from a renderer MIME claim or filename. Dimensions
 * are read before handing data to an image decoder to avoid decode bombs.
 */
export function inspectImage(data: Buffer): ImageInspection {
  const inspected = sniffImage(data);
  if (!inspected) {
    throw new Error("Unsupported or unrecognized image file contents.");
  }
  if (
    inspected.width < 1 ||
    inspected.height < 1 ||
    inspected.width * inspected.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error("Image dimensions exceed the 50 megapixel safety limit.");
  }
  return inspected;
}

export function sniffImage(data: Buffer): ImageInspection | undefined {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return {
      mimeType: "image/png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  }
  if (
    data.length >= 10 &&
    (data.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
      data.subarray(0, 6).equals(Buffer.from("GIF89a")))
  ) {
    return {
      mimeType: "image/gif",
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
    };
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    data.subarray(8, 12).equals(Buffer.from("WEBP"))
  ) {
    return sniffWebp(data);
  }
  if (
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return sniffJpeg(data);
  }
  return undefined;
}

function sniffJpeg(data: Buffer): ImageInspection | undefined {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return undefined;
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset++]!;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > data.length)
      return undefined;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return undefined;
    // Baseline/progressive/lossless Start Of Frame markers.
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) return undefined;
      return {
        mimeType: "image/jpeg",
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
}

function sniffWebp(data: Buffer): ImageInspection | undefined {
  if (data.length < 30) return undefined;
  const chunk = data.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && data.length >= 30) {
    return {
      mimeType: "image/webp",
      width: 1 + data.readUIntLE(24, 3),
      height: 1 + data.readUIntLE(27, 3),
    };
  }
  if (
    chunk === "VP8 " &&
    data.length >= 30 &&
    data[23] === 0x9d &&
    data[24] === 0x01 &&
    data[25] === 0x2a
  ) {
    return {
      mimeType: "image/webp",
      width: data.readUInt16LE(26) & 0x3fff,
      height: data.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && data.length >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return {
      mimeType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return undefined;
}
