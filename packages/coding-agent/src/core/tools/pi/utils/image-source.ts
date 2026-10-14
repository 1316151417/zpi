import bmp from "bmp-js";
import sharp, { type Sharp } from "sharp";
import { imageLimits } from "../../../image-limits.ts";
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

/** bmp-js reads immediately after a 40-byte DIB and does not validate bfOffBits. */
function validatedBmp(input: Buffer): Buffer {
  const invalid = () => new Error("invalid_input: BMP 文件结构无效或不支持此编码");
  if (input.length < 54) throw invalid();
  const headerSize = input.readUInt32LE(14);
  const offset = input.readUInt32LE(10);
  const declaredSize = input.readUInt32LE(2);
  const width = input.readInt32LE(18);
  const height = Math.abs(input.readInt32LE(22));
  const bits = input.readUInt16LE(28);
  const colors = input.readUInt32LE(46);
  if (width < 1 || height < 1 || width * height > imageLimits.pixels)
    throw new Error("invalid_input: 图片解码像素超限");
  // The decoder's 16-bit and bitfield paths do not reliably honor masks or alpha.
  // Reject these layouts rather than silently sending different pixels to the model.
  if (
    ![40, 52, 56, 108, 124].includes(headerSize) ||
    14 + headerSize > input.length ||
    input.readUInt16LE(26) !== 1 ||
    input.readUInt32LE(30) !== 0 ||
    ![1, 4, 8, 24, 32].includes(bits)
  )
    throw invalid();
  const paletteSize = bits <= 8 ? colors || 2 ** bits : colors;
  if (paletteSize > (bits <= 8 ? 2 ** bits : 256)) throw invalid();
  const paletteStart = 14 + headerSize;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const end = offset + stride * height;
  if (
    offset < paletteStart + paletteSize * 4 ||
    end > input.length ||
    (declaredSize !== 0 && (declaredSize < end || declaredSize > input.length))
  )
    throw invalid();
  if (bits <= 8) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = input[offset + y * stride + Math.floor((x * bits) / 8)];
        const index = (value >> (8 - bits - ((x * bits) % 8))) & ((1 << bits) - 1);
        if (index >= paletteSize) throw invalid();
      }
    }
  }
  // Strip extra DIB fields and the optional gap, retaining the actual palette/pixels.
  const header = Buffer.from(input.subarray(0, 54));
  header.writeUInt32LE(40, 14);
  const palette = bits <= 8 ? input.subarray(paletteStart, paletteStart + paletteSize * 4) : Buffer.alloc(0);
  const normalized = Buffer.concat([header, palette, input.subarray(offset, end)]);
  normalized.writeUInt32LE(normalized.length, 2);
  normalized.writeUInt32LE(54 + palette.length, 10);
  return normalized;
}

/** Decode the first frame with the same pixel guard for attachments and the read tool. */
export async function openImage(bytes: Uint8Array) {
  const format = imageFormat(bytes);
  if (!format) throw new Error("invalid_input: 仅支持真实 JPEG、PNG、GIF、WebP、BMP 图片");
  const input = Buffer.from(bytes);
  let pipeline: Sharp;
  if (format === "bmp") {
    const decoded = bmp.decode(validatedBmp(input));
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
