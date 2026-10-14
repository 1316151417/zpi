import { randomFillSync } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import bmp from "bmp-js";
import sharp from "sharp";
import { expect, test } from "vitest";
import { imageLimits } from "../src/core/image-limits.ts";
import { prepareInlineImage, processImage } from "../src/core/images.ts";
import { resizeImage } from "../src/core/tools/pi/utils/image-resize.ts";
import { detectSupportedImageMimeType } from "../src/core/tools/pi/utils/mime.ts";

async function image(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: "red" } })
    .png()
    .toBuffer();
}

test("source validation preserves JPEG bytes while inline preparation shares the read tool budget", async () => {
  const original = await sharp(randomFillSync(Buffer.alloc(1600 * 1600 * 3)), {
    raw: { width: 1600, height: 1600, channels: 3 },
  })
    .png()
    .toBuffer();
  expect(original.length).toBeGreaterThan(5 * 1024 * 1024);
  expect(original.length).toBeLessThan(imageLimits.sourceBytes);
  expect((await processImage(original)).bytes.equals(original)).toBe(true);
  const inline = await prepareInlineImage(original, "image/png");
  expect(inline.ok).toBe(true);
  if (!inline.ok) return;
  expect(inline.data.length).toBeLessThanOrEqual(4.5 * 1024 * 1024);
  expect(inline.mimeType).toBe("image/jpeg");
  expect(await sharp(Buffer.from(inline.data, "base64")).metadata()).toMatchObject({
    width: 1600,
    height: 1600,
  });
  expect(inline.hints.join("\n")).not.toContain("Multiply coordinates");

  const jpeg = await sharp(original).jpeg().toBuffer();
  const source = await processImage(jpeg);
  expect(source.bytes.equals(jpeg)).toBe(true);
  expect(source.image.mimeType).toBe("image/jpeg");
  const prepared = await prepareInlineImage(jpeg, "image/png");
  expect(prepared).toMatchObject({ ok: true, data: jpeg.toString("base64"), mimeType: "image/jpeg" });
});

test("inline resizing preserves lossless data that fits and clamps very thin images to one pixel", async () => {
  const small = await image(3, 2);
  expect(await prepareInlineImage(small, "image/png")).toMatchObject({
    ok: true,
    data: small.toString("base64"),
  });
  for (const [width, height] of [
    [6000, 1],
    [1, 6000],
  ]) {
    const prepared = await prepareInlineImage(await image(width, height), "image/png");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) continue;
    const metadata = await sharp(Buffer.from(prepared.data, "base64")).metadata();
    expect(metadata.width).toBe(width === 1 ? 1 : 2000);
    expect(metadata.height).toBe(height === 1 ? 1 : 2000);
    expect(prepared.hints.join("\n")).toContain("Multiply coordinates");
  }
});

test("EXIF orientation is physical in inline payloads while original bytes and displayed dimensions survive", async () => {
  const original = await sharp(await image(30, 20))
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  expect(await processImage(original)).toMatchObject({ bytes: original, width: 20, height: 30 });
  const prepared = await prepareInlineImage(original, "image/jpeg");
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  const metadata = await sharp(Buffer.from(prepared.data, "base64")).metadata();
  expect(metadata).toMatchObject({ width: 20, height: 30 });
  expect(metadata.orientation).toBeUndefined();
});

test.each([
  [1, 3, 2, [0, 1, 2, 3, 4, 5]],
  [2, 3, 2, [2, 1, 0, 5, 4, 3]],
  [3, 3, 2, [5, 4, 3, 2, 1, 0]],
  [4, 3, 2, [3, 4, 5, 0, 1, 2]],
  [5, 2, 3, [0, 3, 1, 4, 2, 5]],
  [6, 2, 3, [3, 0, 4, 1, 5, 2]],
  [7, 2, 3, [5, 2, 4, 1, 3, 0]],
  [8, 2, 3, [2, 5, 1, 4, 0, 3]],
] as const)(
  "inline pixels honor EXIF orientation %i, including mirrored orientations",
  async (orientation, width, height, order) => {
    const pixels = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [255, 0, 255],
      [0, 255, 255],
    ];
    const original = await sharp(Buffer.from(pixels.flat()), { raw: { width: 3, height: 2, channels: 3 } })
      .png()
      .withMetadata({ orientation })
      .toBuffer();
    expect(await processImage(original)).toMatchObject({ bytes: original, width, height });
    for (const autoResizeImages of [true, false]) {
      const prepared = await prepareInlineImage(original, "image/png", { autoResizeImages });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      const bytes = Buffer.from(prepared.data, "base64");
      expect(await sharp(bytes).metadata()).toMatchObject({ width, height });
      expect(await sharp(bytes).removeAlpha().raw().toBuffer()).toEqual(
        Buffer.from(order.flatMap((index) => pixels[index])),
      );
    }
  },
);

test("animated images preserve originals and only send a static first frame", async () => {
  const original = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
    raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
  })
    .gif({ delay: [100, 100], loop: 0 })
    .toBuffer();
  expect((await sharp(original).metadata()).pages).toBe(2);
  expect(await processImage(original)).toMatchObject({
    bytes: original,
    width: 1,
    height: 1,
    warning: "动画图片仅发送首帧",
  });
  const prepared = await prepareInlineImage(original, "image/gif");
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  expect(prepared.mimeType).toBe("image/png");
  expect(prepared.hints.join("\n")).toContain("only the first frame");
  expect(await sharp(Buffer.from(prepared.data, "base64")).removeAlpha().raw().toBuffer()).toEqual(
    Buffer.from([255, 0, 0]),
  );
});

test("BMP conversion, invalid images and resize settings use the same guarded pipeline", async () => {
  const original = bmp.encode({ data: Buffer.from([0, 0, 0, 255]), width: 1, height: 1 }).data;
  expect(await processImage(original)).toMatchObject({ bytes: original, width: 1, height: 1 });
  expect(await prepareInlineImage(original, "image/bmp")).toMatchObject({ ok: true, mimeType: "image/png" });
  await expect(processImage(Buffer.from("not an image"))).rejects.toThrow("仅支持真实");
  const png = await image(30, 20);
  const truncated = png.subarray(0, 40);
  await expect(processImage(truncated)).rejects.toThrow();
  expect(await prepareInlineImage(truncated, "image/png")).toMatchObject({ ok: false });
  expect(await prepareInlineImage(png, "image/png", { resizeOptions: { maxWidth: 0 } })).toMatchObject({
    ok: false,
  });
  expect(await resizeImage(png, "image/png", { maxBytes: png.toString("base64").length })).toMatchObject({
    data: png.toString("base64"),
    wasResized: false,
  });
});

test("BMP decoding honors pixel offsets, extended headers, indexed palettes and row direction", async () => {
  for (const headerSize of [40, 52, 56, 108, 124]) {
    for (const bits of [1, 4, 8, 24, 32]) {
      for (const signedHeight of [1, -1]) {
        const paletteSize = bits <= 8 ? 2 : 0;
        const offset = 14 + headerSize + paletteSize * 4 + 8;
        const original = Buffer.alloc(offset + 4);
        original.write("BM");
        original.writeUInt32LE(original.length, 2);
        original.writeUInt32LE(offset, 10);
        original.writeUInt32LE(headerSize, 14);
        original.writeInt32LE(1, 18);
        original.writeInt32LE(signedHeight, 22);
        original.writeUInt16LE(1, 26);
        original.writeUInt16LE(bits, 28);
        original.writeUInt32LE(paletteSize, 46);
        if (paletteSize) {
          original[14 + headerSize + 4 + 2] = 255;
          original[offset] = 1 << (8 - bits);
        } else original[offset + 2] = 255;
        expect((await processImage(original)).bytes.equals(original)).toBe(true);
        const prepared = await prepareInlineImage(original, "image/bmp");
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) continue;
        expect(await sharp(Buffer.from(prepared.data, "base64")).raw().toBuffer()).toEqual(
          Buffer.from([255, 0, 0, 255]),
        );
      }
    }
  }
});

test("BMP validation rejects truncated, malformed and unsupported layouts before decoding", async () => {
  const original = bmp.encode({ data: Buffer.from([0, 0, 0, 255]), width: 1, height: 1 }).data;
  const mutations: ((bytes: Buffer) => Buffer)[] = [
    (bytes) => bytes.subarray(0, bytes.length - 1),
    (bytes) => {
      bytes.writeUInt32LE(999, 10);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt32LE(53, 10);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt32LE(999, 30);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt32LE(3, 30);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt16LE(0, 26);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt16LE(16, 28);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt32LE(12, 14);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt32LE(124, 14);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt32LE(0xffffffff, 46);
      return bytes;
    },
    (bytes) => {
      bytes.writeUInt32LE(bytes.length - 1, 2);
      return bytes;
    },
  ];
  for (const mutate of mutations) {
    const malformed = mutate(Buffer.from(original));
    await expect(processImage(malformed)).rejects.toThrow("BMP");
    for (const autoResizeImages of [true, false]) {
      expect(await prepareInlineImage(malformed, "image/bmp", { autoResizeImages })).toMatchObject({
        ok: false,
      });
    }
  }
});

test("tight encoded payload budgets reduce dimensions or omit an image without losing the source", async () => {
  const original = await sharp(randomFillSync(Buffer.alloc(64 * 64 * 3)), {
    raw: { width: 64, height: 64, channels: 3 },
  })
    .png()
    .toBuffer();
  const resized = await resizeImage(original, "image/png", { maxBytes: 180 });
  expect(resized).not.toBeNull();
  if (!resized) return;
  expect(resized.data.length).toBeLessThanOrEqual(180);
  expect(resized.width).toBeGreaterThanOrEqual(1);
  expect(resized.height).toBeGreaterThanOrEqual(1);
  expect(resized.wasResized).toBe(true);
  expect(await sharp(Buffer.from(resized.data, "base64")).metadata()).toMatchObject({
    width: resized.width,
    height: resized.height,
  });
  expect(await resizeImage(original, "image/png", { maxBytes: 1 })).toBeNull();
  expect((await processImage(original)).bytes.equals(original)).toBe(true);
});

test("invalid budgets and corrupt or over-limit sources cannot become inline payloads", async () => {
  const original = await image(3, 2);
  for (const options of [
    { maxWidth: 0 },
    { maxHeight: -1 },
    { maxBytes: Number.NaN },
    { maxWidth: Number.POSITIVE_INFINITY },
    { maxBytes: 1.5 },
    { jpegQuality: 101 },
  ]) {
    expect(await resizeImage(original, "image/png", options)).toBeNull();
  }
  const corrupt = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  await expect(processImage(corrupt)).rejects.toThrow();
  for (const autoResizeImages of [true, false]) {
    expect(await prepareInlineImage(corrupt, "image/png", { autoResizeImages })).toMatchObject({ ok: false });
  }
  const oversizedBmp = bmp.encode({ data: Buffer.from([0, 0, 0, 255]), width: 1, height: 1 }).data;
  oversizedBmp.writeInt32LE(imageLimits.pixels + 1, 18);
  await expect(processImage(oversizedBmp)).rejects.toThrow("像素超限");
  expect(await prepareInlineImage(oversizedBmp, "image/bmp")).toMatchObject({ ok: false });
  await expect(processImage(Buffer.alloc(imageLimits.sourceBytes + 1))).rejects.toThrow("10 MiB");
});

test("compact JPEGs are not rejected because lossless expansion would exceed the import limit", async () => {
  const jpeg = await sharp(randomFillSync(Buffer.alloc(2000 * 2000 * 3)), {
    raw: { width: 2000, height: 2000, channels: 3 },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  expect((await sharp(jpeg).png().toBuffer()).length).toBeGreaterThan(imageLimits.sourceBytes);
  const source = await processImage(jpeg);
  expect(source.bytes.equals(jpeg)).toBe(true);
  expect(await prepareInlineImage(jpeg, "image/jpeg")).toMatchObject({
    ok: true,
    data: jpeg.toString("base64"),
    mimeType: "image/jpeg",
  });
});

test("inline metadata is stripped without changing the saved original or dimensions", async () => {
  const jpeg = await sharp(await image(30, 20))
    .jpeg()
    .withMetadata({ orientation: 1 })
    .toBuffer();
  expect((await sharp(jpeg).metadata()).exif).toBeDefined();
  expect((await processImage(jpeg)).bytes.equals(jpeg)).toBe(true);
  for (const autoResizeImages of [true, false]) {
    const prepared = await prepareInlineImage(jpeg, "image/jpeg", { autoResizeImages });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) continue;
    const metadata = await sharp(Buffer.from(prepared.data, "base64")).metadata();
    expect(metadata).toMatchObject({ width: 30, height: 20 });
    expect(metadata.exif).toBeUndefined();
  }
  const webp = await sharp(await image(30, 20))
    .webp({ lossless: true })
    .toBuffer();
  expect(await prepareInlineImage(webp, "image/webp")).toMatchObject({
    ok: true,
    data: webp.toString("base64"),
    mimeType: "image/webp",
  });
  expect(
    await prepareInlineImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"),
  ).toMatchObject({ ok: false });
});

test("animated PNGs are recognized even when the decoder reports only their first frame", async () => {
  const chunk = (type: string, data: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length);
    header.write(type, 4);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([header, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  const frame = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(1, 4);
    data.writeUInt32BE(1, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return chunk("fcTL", data);
  };
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(2);
  const original = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("acTL", animation),
    frame(0),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    frame(1),
    chunk("fdAT", Buffer.concat([sequence, deflateSync(Buffer.from([0, 0, 255, 0, 255]))])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(detectSupportedImageMimeType(original)).toBe("image/png");
  expect(await processImage(original)).toMatchObject({ warning: "动画图片仅发送首帧" });
  const prepared = await prepareInlineImage(original, "image/png");
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  const bytes = Buffer.from(prepared.data, "base64");
  expect(bytes.includes(Buffer.from("acTL"))).toBe(false);
  expect(await sharp(bytes).removeAlpha().raw().toBuffer()).toEqual(Buffer.from([255, 0, 0]));
});
