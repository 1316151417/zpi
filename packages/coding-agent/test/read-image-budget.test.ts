import { randomFillSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp, JimpMime } from "jimp";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { READ_IMAGE_EFFECTIVE_BASE64_BYTES, READ_IMAGE_MAX_INPUT_BYTES } from "../src/core/image-limits.ts";
import { prepareInlineImage } from "../src/core/images.ts";
import { createReadToolDefinition } from "../src/core/tools/pi/read.ts";
import {
  fitsImageBudget,
  imageBudget,
  readImageResizeOptions,
} from "../src/core/tools/pi/utils/image-budget.ts";
import * as processor from "../src/core/tools/pi/utils/image-process.ts";
import { resizeImageInProcess } from "../src/core/tools/pi/utils/image-resize-core.ts";

const readOptions = readImageResizeOptions();
async function png(width: number, height: number, noise = false) {
  return noise
    ? sharp(randomFillSync(Buffer.alloc(width * height * 3)), { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer()
    : sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .png()
        .toBuffer();
}
it("enforces three independent budgets at the exact 150,000 / 200,000 boundary", () => {
  const budget = imageBudget(readOptions);
  expect(READ_IMAGE_EFFECTIVE_BASE64_BYTES).toBe(200_000);
  expect(fitsImageBudget(Buffer.alloc(150_000), budget)).toBe(true);
  expect(fitsImageBudget(Buffer.alloc(150_001), budget)).toBe(false);
  expect(Math.ceil(150_001 / 3) * 4).toBe(200_004);
  expect(fitsImageBudget(Buffer.alloc(10), { ...budget, maxRawBytes: 9 })).toBe(false);
  expect(fitsImageBudget(Buffer.alloc(10), { ...budget, maxBase64Bytes: 15 })).toBe(false);
  expect(
    readImageResizeOptions({ maxBytes: 100_000_000, maxTokens: 384_000, tokenToBase64CharRatio: 0.001 }),
  ).toMatchObject({ maxBytes: 5 * 1024 * 1024, maxTokens: 25_000, tokenToBase64CharRatio: 0.125 });
});
it("compresses a noisy 320×2400 PNG to bounded JPEG, with no resized PNG candidate", async () => {
  const spy = vi.spyOn(Jimp.prototype, "getBuffer");
  try {
    const result = await resizeImageInProcess(await png(320, 2400, true), "image/png", readOptions);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data.length).toBeLessThanOrEqual(200_000);
    expect(Buffer.from(result.data, "base64").length).toBeLessThanOrEqual(150_000);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(2000);
    expect(spy.mock.calls.some(([mime]) => mime === JimpMime.png)).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
it("keeps fitting 64×32 originals byte-identical and gives PNG one original-size deflate attempt", async () => {
  const bytes = await png(64, 32);
  const result = await resizeImageInProcess(bytes, "image/png", readOptions);
  expect(result).toMatchObject({ strategy: "original", data: bytes.toString("base64") });
  const spy = vi.spyOn(Jimp.prototype, "getBuffer");
  try {
    await resizeImageInProcess(await png(320, 320, true), "image/png", readOptions);
    expect(spy.mock.calls.filter(([mime]) => mime === JimpMime.png)).toEqual([
      [JimpMime.png, { deflateLevel: 9, deflateStrategy: 3 }],
    ]);
  } finally {
    spy.mockRestore();
  }
});
it("passes oversized-dimension WebP through without decoding and reports unsupported above budget", async () => {
  const bytes = await sharp(await png(3000, 1))
    .webp()
    .toBuffer();
  expect(await resizeImageInProcess(bytes, "image/webp", readOptions)).toMatchObject({
    strategy: "original",
    data: bytes.toString("base64"),
    wasResized: false,
  });
  await expect(resizeImageInProcess(Buffer.alloc(150_001), "image/webp", readOptions)).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(await resizeImageInProcess(Buffer.from("webp-bytes"), "image/webp", readOptions)).toMatchObject({
    strategy: "original",
  });
});
it("preserves attachment bytes above Read's token cap while Read must compress the same input", async () => {
  const bytes = await png(400, 400, true);
  expect(bytes.toString("base64").length).toBeGreaterThan(200_000);
  const attachment = await prepareInlineImage(bytes, "image/png");
  expect(attachment).toMatchObject({ ok: true, strategy: "original", data: bytes.toString("base64") });
  expect((await resizeImageInProcess(bytes, "image/png", readOptions)).data.length).toBeLessThanOrEqual(
    200_000,
  );
  const wide = Buffer.alloc(((5 * 1024 * 1024) / 4) * 3);
  expect(await prepareInlineImage(wide, "image/webp")).toMatchObject({ ok: true, strategy: "original" });
});
it("uses black when transparent PNG must become JPEG", async () => {
  const result = await resizeImageInProcess(await png(2100, 10), "image/png", readOptions);
  expect(result.mimeType).toBe("image/jpeg");
  const { data } = await sharp(Buffer.from(result.data, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([...data.subarray(0, 3)]).toEqual([0, 0, 0]);
});
it("rejects source size before reading contents and catches adapters that violate the Read budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-image-budget-"));
  try {
    const path = join(dir, "huge.png");
    await writeFile(path, Buffer.alloc(READ_IMAGE_MAX_INPUT_BYTES + 1));
    await expect(
      createReadToolDefinition(dir, {
        operations: {
          access: async () => {},
          detectImageMimeType: async () => "image/png",
          readFile: async () => Buffer.alloc(READ_IMAGE_MAX_INPUT_BYTES + 1),
        },
      }).execute("large", { path }),
    ).rejects.toThrow("size limit");
    const bytes = await png(64, 32);
    await writeFile(path, bytes);
    const spy = vi.spyOn(processor, "processImage").mockResolvedValue({
      ok: true,
      data: Buffer.alloc(150_001).toString("base64"),
      mimeType: "image/png",
      hints: [],
    });
    try {
      const result = await createReadToolDefinition(dir).execute("adapter", { path });
      expect(result.content).toEqual([
        { type: "text", text: "Read image file [image/png]\n[Image omitted: read_image_budget_exceeded.]" },
      ]);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("tries the exact JPEG ladder, non-cumulative scales and original-based fallback edges", async () => {
  const bytes = await png(64, 32, true);
  const spy = vi.spyOn(Jimp.prototype, "getBuffer");
  try {
    await expect(
      resizeImageInProcess(bytes, "image/png", { ...readOptions, maxBytes: 1 }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(spy.mock.calls).toHaveLength(23);
    expect(spy.mock.calls.slice(1, 5).map((call) => call[1])).toEqual(
      [80, 60, 40, 20].map((quality) => ({ quality })),
    );
    expect([1, 5, 9, 13, 17].map((index) => spy.mock.contexts[index].bitmap.width)).toEqual([
      64, 48, 32, 16, 64,
    ]);
    expect(
      spy.mock.calls
        .slice(17)
        .every(
          (call) => call[0] === JimpMime.jpeg && JSON.stringify(call[1]) === JSON.stringify({ quality: 20 }),
        ),
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
