import type { ImageContent } from "zpi-ai";
import { imageLimits } from "./image-limits.ts";
import { openImage } from "./tools/pi/utils/image-source.ts";

export { processImage as prepareInlineImage } from "./tools/pi/utils/image-process.ts";
export { imageFormat } from "./tools/pi/utils/image-source.ts";

/** Validate and retain the source for previews. Use prepareInlineImage before sending to a model. */
export async function processImage(
  bytes: Uint8Array,
): Promise<{ bytes: Buffer; image: ImageContent; width: number; height: number; warning?: string }> {
  if (!bytes.length || bytes.length > imageLimits.sourceBytes)
    throw new Error("invalid_input: 图片单张上限为 10 MiB");
  const source = await openImage(bytes);
  // Metadata alone can succeed for a truncated image; force a complete first-frame decode.
  await source.pipeline.stats();
  const input = Buffer.from(bytes);
  return {
    bytes: input,
    image: { type: "image", data: input.toString("base64"), mimeType: source.mimeType },
    width: source.width,
    height: source.height,
    ...(source.animated ? { warning: "动画图片仅发送首帧" } : {}),
  };
}
