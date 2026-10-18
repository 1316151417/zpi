import type { ImageContent } from "zpi-ai";
import { imageLimits } from "./image-limits.ts";
import { openImage } from "./tools/pi/utils/image-source.ts";

export { processImage as prepareInlineImage } from "./tools/pi/utils/image-process.ts";
export { imageFormat } from "./tools/pi/utils/image-source.ts";

/** Validate source bytes without creating a base64 copy for cache/import metadata. */
export async function validateImageSource(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > imageLimits.sourceBytes)
    throw new Error("invalid_input: 图片单张上限为 10 MiB");
  const source = await openImage(bytes);
  // Metadata alone can succeed for a truncated image; force a complete first-frame decode.
  await source.pipeline.stats();
  return {
    mimeType: source.mimeType,
    width: source.width,
    height: source.height,
    ...(source.animated ? { warning: "动画图片在压缩转换时仅保留首帧" } : {}),
  };
}

/** Validate and retain the source for previews. Use prepareInlineImage before sending to a model. */
export async function processImage(
  bytes: Uint8Array,
): Promise<{ bytes: Buffer; image: ImageContent; width: number; height: number; warning?: string }> {
  const { mimeType, ...metadata } = await validateImageSource(bytes);
  const input = Buffer.from(bytes);
  return {
    bytes: input,
    image: { type: "image", data: input.toString("base64"), mimeType },
    ...metadata,
  };
}
