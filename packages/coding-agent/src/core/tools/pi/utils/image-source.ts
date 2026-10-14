import bmp from "bmp-js";
import sharp, { type Sharp } from "sharp";
import { imageLimits } from "../../../image-limits.ts";
import { normalizeBmp } from "./bmp-source.ts";
import { isAnimatedPng } from "./mime.ts";

export function imageFormat(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpeg";
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return "gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
  if (b.subarray(0, 2).toString() === "BM") return "bmp";
  return undefined;
}

/** Decode the first frame with the same pixel guard for attachments and the read tool. */
export async function openImage(bytes: Uint8Array) {
  const format = imageFormat(bytes);
  if (!format) throw new Error("invalid_input: 仅支持真实 JPEG、PNG、GIF、WebP、BMP 图片");
  const input = Buffer.from(bytes);
  let pipeline: Sharp;
  if (format === "bmp") {
    const decoded = bmp.decode(normalizeBmp(input));
    // bmp-js produces ABGR; sharp expects RGBA.
    const rgba = Buffer.alloc(decoded.data.length);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = decoded.data[i + 3];
      rgba[i + 1] = decoded.data[i + 2];
      rgba[i + 2] = decoded.data[i + 1];
      // BI_RGB16 is RGB555. bmp-js drops the low three bits; replicate the high bits.
      if (decoded.bitPP === 16) {
        for (let channel = 0; channel < 3; channel++) rgba[i + channel] |= rgba[i + channel] >> 5;
      }
      rgba[i + 3] = 255;
    }
    pipeline = sharp(rgba, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
      limitInputPixels: imageLimits.pixels,
    });
  } else pipeline = sharp(input, { limitInputPixels: imageLimits.pixels, pages: 1, failOn: "error" });
  const metadata = await pipeline.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.pageHeight ?? metadata.height ?? 0;
  if (!width || !height || width * height > imageLimits.pixels)
    throw new Error("invalid_input: 图片尺寸无效或像素超限");
  const orientation = metadata.orientation ?? 1;
  return {
    pipeline,
    mimeType: `image/${format}`,
    width: orientation >= 5 ? height : width,
    height: orientation >= 5 ? width : height,
    orientation,
    hasMetadata: !!(metadata.exif || metadata.iptc || metadata.xmp),
    animated: (metadata.pages ?? 1) > 1 || (format === "png" && isAnimatedPng(input)),
  };
}
