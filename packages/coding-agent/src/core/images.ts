import bmp from "bmp-js";
import sharp, { type Sharp } from "sharp";
import type { ImageContent } from "zpi-ai";
import { imageLimits } from "./image-limits.ts";
export function imageFormat(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpeg";
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return "gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
  if (b.subarray(0, 2).toString() === "BM") return "bmp";
  return undefined;
}
export async function processImage(
  bytes: Uint8Array,
): Promise<{ bytes: Buffer; image: ImageContent; width: number; height: number; warning?: string }> {
  if (!bytes.length || bytes.length > imageLimits.sourceBytes)
    throw new Error("invalid_input: 图片单张上限为 10 MiB");
  const format = imageFormat(bytes);
  if (!format) throw new Error("invalid_input: 仅支持真实 JPEG、PNG、GIF、WebP、BMP 图片");
  let input = Buffer.from(bytes);
  let pipeline: Sharp;
  if (format === "bmp") {
    if (input.length < 54) throw new Error("invalid_input: BMP 文件不完整");
    const w = input.readInt32LE(18),
      h = Math.abs(input.readInt32LE(22));
    if (w < 1 || h < 1 || w * h > imageLimits.pixels) throw new Error("invalid_input: 图片解码像素超限");
    const decoded = bmp.decode(input);
    // bmp-js produces ABGR; sharp expects RGBA.
    const rgba = Buffer.alloc(decoded.data.length);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = decoded.data[i + 3];
      rgba[i + 1] = decoded.data[i + 2];
      rgba[i + 2] = decoded.data[i + 1];
      rgba[i + 3] = 255;
    }
    pipeline = sharp(rgba, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
      limitInputPixels: imageLimits.pixels,
    });
  } else pipeline = sharp(input, { limitInputPixels: imageLimits.pixels, pages: 1, failOn: "error" });
  const metadata = await pipeline.metadata();
  const width = metadata.width ?? 0,
    height = metadata.pageHeight ?? metadata.height ?? 0;
  if (!width || !height || width * height > imageLimits.pixels)
    throw new Error("invalid_input: 图片尺寸无效或像素超限");
  const animated = (metadata.pages ?? 1) > 1;
  // Normalize all formats to a validated, single-frame PNG, removing irrelevant metadata.
  input = await pipeline.rotate().png().toBuffer();
  if (input.length > imageLimits.sourceBytes) throw new Error("invalid_input: 转换后的图片超过 10 MiB");
  const normalized = await sharp(input).metadata();
  return {
    bytes: input,
    image: { type: "image", data: input.toString("base64"), mimeType: "image/png" },
    width: normalized.width ?? width,
    height: normalized.height ?? height,
    ...(animated ? { warning: "动画图片仅发送首帧" } : {}),
  };
}
