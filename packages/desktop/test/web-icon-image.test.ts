import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeIconImage, iconImageFormat } from "../src/main/web-icon-image.ts";

type Frame = { body: Buffer; width: number; height: number; bits?: number };
function ico(frames: Frame[]): Buffer {
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  for (const [i, frame] of frames.entries()) {
    const entry = 6 + i * 16;
    directory[entry] = frame.width === 256 ? 0 : frame.width;
    directory[entry + 1] = frame.height === 256 ? 0 : frame.height;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(frame.bits ?? 32, entry + 6);
    directory.writeUInt32LE(frame.body.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.body.length;
  }
  return Buffer.concat([directory, ...frames.map((frame) => frame.body)]);
}

function dib(
  bits: number,
  options: {
    width?: number;
    height?: number;
    topDown?: boolean;
    alpha?: (x: number, y: number) => number;
    mask?: (x: number, y: number) => boolean;
    colors?: number;
  } = {},
): Frame {
  const { width = 32, height = 32, topDown = false } = options;
  const colors = bits <= 8 ? (options.colors ?? 2 ** bits) : 0;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const pixelsStart = 40 + colors * 4;
  const maskStart = pixelsStart + stride * height;
  const body = Buffer.alloc(maskStart + maskStride * height);
  body.writeUInt32LE(40, 0);
  body.writeInt32LE(width, 4);
  body.writeInt32LE(height * 2 * (topDown ? -1 : 1), 8);
  body.writeUInt16LE(1, 12);
  body.writeUInt16LE(bits, 14);
  if (options.colors !== undefined) body.writeUInt32LE(colors, 32);
  // Red and blue palette entries; the reserved byte is not alpha.
  if (colors) {
    body[42] = 255;
    body[43] = 7;
    if (colors > 1) body[44] = 255;
  }
  for (let y = 0; y < height; y++) {
    const sourceY = topDown ? y : height - 1 - y;
    const row = pixelsStart + sourceY * stride;
    for (let x = 0; x < width; x++) {
      const blue = y >= height / 2;
      if (bits <= 8) {
        body[row + Math.floor((x * bits) / 8)] |= Number(blue) << (8 - bits - ((x * bits) % 8));
      } else {
        const pixel = row + x * (bits / 8);
        body[pixel] = blue ? 255 : 0;
        body[pixel + 2] = blue ? 0 : 255;
        if (bits === 32) body[pixel + 3] = options.alpha?.(x, y) ?? 255;
      }
      if (options.mask?.(x, y)) body[maskStart + sourceY * maskStride + (x >> 3)] |= 0x80 >> (x % 8);
    }
  }
  return { body, width, height, bits };
}

async function png(width = 32, color = "red", height = width): Promise<Frame> {
  return {
    body: await sharp({ create: { width, height, channels: 4, background: color } })
      .png()
      .toBuffer(),
    width,
    height,
  };
}

async function pixels(body: Buffer): Promise<Buffer> {
  const output = await decodeIconImage(body, new AbortController().signal);
  expect(await sharp(output).metadata()).toMatchObject({ format: "png", width: 32, height: 32 });
  return sharp(output).ensureAlpha().raw().toBuffer();
}
function pixel(body: Buffer, x: number, y: number): number[] {
  return [...body.subarray((y * 32 + x) * 4, (y * 32 + x + 1) * 4)];
}

describe("source icon raster decoding", () => {
  it.each(["png", "jpeg", "gif", "webp"] as const)(
    "sniffs and normalizes %s without MIME",
    async (format) => {
      const input = await sharp({ create: { width: 16, height: 8, channels: 4, background: "red" } })
        .toFormat(format)
        .toBuffer();
      expect(iconImageFormat(input)).toBe(format);
      const output = await pixels(input);
      expect(pixel(output, 16, 16)[0]).toBeGreaterThan(240);
      expect(pixel(output, 16, 0)[3]).toBe(0);
    },
  );

  it.each([
    Buffer.alloc(0),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from("<html>not an image</html>"),
    Buffer.from("BM"),
    Buffer.from("II*\0"),
    Buffer.from([0, 0, 2, 0, 1, 0]),
    Buffer.from(Buffer.from("GIF89a").map((byte) => byte | 0x80)),
    Buffer.from(Buffer.from("RIFF0000WEBP").map((byte) => byte | 0x80)),
  ])("rejects non-allowlisted raster and active content %#", async (body) => {
    expect(iconImageFormat(body)).toBeUndefined();
    await expect(decodeIconImage(body, new AbortController().signal)).rejects.toThrow();
  });

  it("strips source metadata", async () => {
    const input = await sharp((await png()).body)
      .withMetadata({ density: 300 })
      .withExif({ IFD0: { Artist: "Private author" } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const output = await decodeIconImage(input, new AbortController().signal);
    const metadata = await sharp(output).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it("rejects over-limit compressed dimensions and input byte counts", async () => {
    const oversized = await png(1025);
    await expect(decodeIconImage(oversized.body, new AbortController().signal)).rejects.toThrow();
    const tooManyBytes = Buffer.concat([(await png()).body, Buffer.alloc(256 * 1024)]);
    await expect(decodeIconImage(tooManyBytes, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects before decoding an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(decodeIconImage((await png()).body, controller.signal)).rejects.toThrow("Icon unavailable");
  });

  it("promptly rejects cancellation during sharp decoding", async () => {
    const controller = new AbortController();
    const decoding = decodeIconImage((await png(1024)).body, controller.signal);
    controller.abort();
    await expect(decoding).rejects.toThrow("Icon unavailable");
  });
});

describe("bounded ICO frames", () => {
  it("decodes embedded PNG and prefers the smallest frame at least 32px", async () => {
    const input = ico([await png(64, "blue"), await png(16, "green"), await png(32)]);
    expect(iconImageFormat(input)).toBe("ico");
    expect(pixel(await pixels(input), 16, 16)).toEqual([255, 0, 0, 255]);
    expect(pixel(await pixels(ico([await png(48), await png(64, "blue")])), 16, 16)).toEqual([
      255, 0, 0, 255,
    ]);
  });

  it("uses the largest smaller frame when none reaches 32px", async () => {
    expect(pixel(await pixels(ico([await png(8, "blue"), await png(16)])), 16, 16)).toEqual([255, 0, 0, 255]);
  });

  it("accepts the ICO zero-byte dimension encoding for 256px PNG", async () => {
    expect(pixel(await pixels(ico([await png(256)])), 16, 16)).toEqual([255, 0, 0, 255]);
  });

  it.each([1, 4, 8, 24, 32])("decodes %ibpp BI_RGB colors, bottom-up rows, and AND mask", async (bits) => {
    const frame = dib(bits, { alpha: () => 0, mask: (x) => x === 0 });
    const output = await pixels(ico([frame]));
    expect(pixel(output, 16, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(output, 16, 31)).toEqual([0, 0, 255, 255]);
    expect(pixel(output, 0, 0)[3]).toBe(0);
  });

  it("preserves meaningful 32-bit alpha instead of applying the legacy AND mask", async () => {
    const frame = dib(32, { alpha: (x) => (x === 0 ? 0 : x === 1 ? 128 : 255), mask: () => true });
    const output = await pixels(ico([frame]));
    expect(pixel(output, 0, 0)[3]).toBe(0);
    expect(pixel(output, 1, 0)).toEqual([255, 0, 0, 128]);
    expect(pixel(output, 2, 0)).toEqual([255, 0, 0, 255]);
  });

  it.each([0, 2])("supports shortened palettes with directory color count %i", async (count) => {
    const body = ico([dib(8, { topDown: true, colors: 2 })]);
    body[8] = count;
    const output = await pixels(body);
    expect(pixel(output, 16, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(output, 16, 31)).toEqual([0, 0, 255, 255]);
  });

  it("handles packed palette bits and padded rows of non-aligned dimensions", async () => {
    for (const bits of [1, 4, 8, 24]) {
      const output = await pixels(ico([dib(bits, { width: 17, height: 17 })]));
      expect(pixel(output, 16, 0)).toEqual([255, 0, 0, 255]);
      expect(pixel(output, 16, 31)).toEqual([0, 0, 255, 255]);
    }
  });

  it.each([
    ["empty directory", (body: Buffer) => body.writeUInt16LE(0, 4)],
    ["excessive frame count", (body: Buffer) => body.writeUInt16LE(65, 4)],
    ["truncated directory", (body: Buffer) => body.writeUInt16LE(64, 4)],
    ["offset inside directory", (body: Buffer) => body.writeUInt32LE(6, 18)],
    ["offset outside file", (body: Buffer) => body.writeUInt32LE(0xffffffff, 18)],
    ["oversized frame", (body: Buffer) => body.writeUInt32LE(0xffffffff, 14)],
    ["reserved entry", (body: Buffer) => body.writeUInt8(1, 9)],
    ["multiple planes", (body: Buffer) => body.writeUInt16LE(2, 10)],
    ["unsupported DIB header", (body: Buffer) => body.writeUInt32LE(124, 22)],
    ["oversized DIB width", (body: Buffer) => body.writeInt32LE(0x7fffffff, 26)],
    ["oversized DIB height", (body: Buffer) => body.writeInt32LE(0x7fffffff, 30)],
    ["DIB directory dimension mismatch", (body: Buffer) => body.writeInt32LE(33, 26)],
    ["DIB height without mask", (body: Buffer) => body.writeInt32LE(32, 30)],
    ["invalid DIB planes", (body: Buffer) => body.writeUInt16LE(2, 34)],
    ["unsupported depth", (body: Buffer) => body.writeUInt16LE(16, 36)],
    ["compressed DIB", (body: Buffer) => body.writeUInt32LE(1, 38)],
    ["bitfield DIB", (body: Buffer) => body.writeUInt32LE(3, 38)],
    ["oversized palette", (body: Buffer) => body.writeUInt32LE(0xffffffff, 54)],
  ] as const)("rejects %s", async (_name, mutate) => {
    const body = ico([dib(32)]);
    mutate(body);
    await expect(decodeIconImage(body, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects truncated pixel/mask spans, even with a consistent directory size", async () => {
    for (const bits of [1, 4, 8, 24, 32]) {
      for (const length of [39, 40, 41, dib(bits).body.length - 1]) {
        const frame = dib(bits);
        frame.body = frame.body.subarray(0, length);
        await expect(decodeIconImage(ico([frame]), new AbortController().signal)).rejects.toThrow();
      }
    }
  });

  it("rejects a palette index outside the declared palette", async () => {
    const frame = dib(8, { colors: 1 });
    await expect(decodeIconImage(ico([frame]), new AbortController().signal)).rejects.toThrow();
  });

  it("rejects PNG frame dimensions inconsistent with the directory, including pixel bombs", async () => {
    for (const width of [33, 1025]) {
      const frame = await png(width);
      frame.width = 32;
      frame.height = 32;
      await expect(decodeIconImage(ico([frame]), new AbortController().signal)).rejects.toThrow();
    }
  });

  it("rejects truncated and invalid PNG frames", async () => {
    for (const length of [8, 32, 50]) {
      const frame = await png();
      frame.body = frame.body.subarray(0, length);
      await expect(decodeIconImage(ico([frame]), new AbortController().signal)).rejects.toThrow();
    }
  });

  it("validates offsets of every frame, even when another frame would be selected", async () => {
    const body = ico([await png(32), await png(64)]);
    body.writeUInt32LE(0xffffffff, 34);
    await expect(decodeIconImage(body, new AbortController().signal)).rejects.toThrow();
  });
});
