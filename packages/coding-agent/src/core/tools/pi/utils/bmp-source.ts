import { imageLimits } from "../../../image-limits.ts";

const invalid = () => new Error("invalid_input: BMP 文件结构无效或数据不完整");
const unsupported = () =>
  new Error(
    "invalid_input: BMP 仅支持 Windows BI_RGB（1/4/8/16/24/32 位）和 BI_RLE4/BI_RLE8，不支持位域或嵌入式编码",
  );

/** Normalize validated Windows BMPs to the uncompressed layout bmp-js reliably decodes. */
export function normalizeBmp(input: Buffer): Buffer {
  if (input.length < 54) throw invalid();
  const headerSize = input.readUInt32LE(14);
  const offset = input.readUInt32LE(10);
  const declaredSize = input.readUInt32LE(2);
  const width = input.readInt32LE(18);
  const signedHeight = input.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const bits = input.readUInt16LE(28);
  const compression = input.readUInt32LE(30);
  const rawSize = input.readUInt32LE(34);
  const colors = input.readUInt32LE(46);
  if (width < 1 || height < 1 || width * height > imageLimits.pixels)
    throw new Error("invalid_input: 图片解码像素超限");
  if (![40, 52, 56, 108, 124].includes(headerSize) || ![1, 4, 8, 16, 24, 32].includes(bits))
    throw unsupported();
  if (![0, 1, 2].includes(compression)) throw unsupported();
  if (
    14 + headerSize > input.length ||
    input.readUInt16LE(26) !== 1 ||
    (compression === 1 && bits !== 8) ||
    (compression === 2 && bits !== 4) ||
    (compression !== 0 && signedHeight < 0)
  )
    throw invalid();
  const paletteSize = bits <= 8 ? colors || 2 ** bits : colors;
  if (paletteSize > (bits <= 8 ? 2 ** bits : 256)) throw invalid();
  const paletteStart = 14 + headerSize;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const sourceEnd = declaredSize || input.length;
  if (offset < paletteStart + paletteSize * 4 || offset > sourceEnd || sourceEnd > input.length)
    throw invalid();
  let pixels: Buffer;
  if (compression === 0) {
    const end = offset + stride * height;
    if (end > sourceEnd) throw invalid();
    pixels = input.subarray(offset, end);
    if (bits <= 8) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const value = pixels[y * stride + Math.floor((x * bits) / 8)];
          const index = (value >> (8 - bits - ((x * bits) % 8))) & ((1 << bits) - 1);
          if (index >= paletteSize) throw invalid();
        }
      }
    }
  } else {
    const end = rawSize ? offset + rawSize : sourceEnd;
    if (end > sourceEnd) throw invalid();
    pixels = expandRle(input.subarray(offset, end), width, height, bits, stride, paletteSize);
  }
  // bmp-js ignores bfOffBits and extended DIB fields. Give it a canonical 40-byte header.
  const header = Buffer.from(input.subarray(0, 54));
  header.writeUInt32LE(40, 14);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(pixels.length, 34);
  const palette = bits <= 8 ? input.subarray(paletteStart, paletteStart + paletteSize * 4) : Buffer.alloc(0);
  const normalized = Buffer.concat([header, palette, pixels]);
  normalized.writeUInt32LE(normalized.length, 2);
  normalized.writeUInt32LE(54 + palette.length, 10);
  return normalized;
}

/** RLE rows are bottom-up. Expand indices first, avoiding bmp-js's RLE row/delta handling. */
function expandRle(
  source: Buffer,
  width: number,
  height: number,
  bits: number,
  stride: number,
  paletteSize: number,
): Buffer {
  // Dimensions were guarded before reaching this allocation; gaps use palette entry zero.
  const pixels = Buffer.alloc(stride * height);
  let position = 0;
  let x = 0;
  let y = 0;
  const requireBytes = (count: number) => {
    if (position + count > source.length) throw invalid();
  };
  const writeIndex = (index: number) => {
    if (index >= paletteSize) throw invalid();
    const offset = y * stride + Math.floor((x * bits) / 8);
    if (bits === 8) pixels[offset] = index;
    else pixels[offset] |= index << (x % 2 === 0 ? 4 : 0);
    x++;
  };
  while (position < source.length) {
    requireBytes(2);
    const count = source[position++];
    const value = source[position++];
    if (count === 0 && value === 1) return pixels;
    if (count === 0 && value === 0) {
      x = 0;
      if (++y > height) throw invalid();
      continue;
    }
    if (count === 0 && value === 2) {
      requireBytes(2);
      x += source[position++];
      y += source[position++];
      if (x >= width || y >= height) throw invalid();
      continue;
    }
    const run = count || value;
    if (y >= height || x + run > width) throw invalid();
    if (count) {
      for (let i = 0; i < run; i++) writeIndex(bits === 8 ? value : (value >> (i % 2 === 0 ? 4 : 0)) & 15);
    } else {
      const bytes = Math.ceil((run * bits) / 8);
      const paddedBytes = bytes + (bytes % 2);
      requireBytes(paddedBytes);
      for (let i = 0; i < run; i++) {
        const packed = source[position + Math.floor((i * bits) / 8)];
        writeIndex(bits === 8 ? packed : (packed >> (i % 2 === 0 ? 4 : 0)) & 15);
      }
      position += paddedBytes;
    }
  }
  throw invalid(); // A compressed bitmap must terminate with an end-of-bitmap marker.
}
