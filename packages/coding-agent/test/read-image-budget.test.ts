import { randomFillSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bmp from "bmp-js";
import sharp, { type JpegOptions } from "sharp";
import { expect, it, vi } from "vitest";
import { SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
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
  const source = await png(320, 2400, true);
  const spy = vi.spyOn(sharp.prototype, "png");
  try {
    const result = await resizeImageInProcess(source, "image/png", readOptions);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data.length).toBeLessThanOrEqual(200_000);
    expect(Buffer.from(result.data, "base64").length).toBeLessThanOrEqual(150_000);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(2000);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
it("keeps fitting 64×32 originals byte-identical and gives PNG one original-size lossless attempt", async () => {
  const bytes = await png(64, 32);
  const result = await resizeImageInProcess(bytes, "image/png", readOptions);
  expect(result).toMatchObject({ strategy: "original", data: bytes.toString("base64") });
  const source = await png(320, 320, true);
  const spy = vi.spyOn(sharp.prototype, "png");
  const resize = vi.spyOn(sharp.prototype, "resize");
  const jpeg = vi.spyOn(sharp.prototype, "jpeg");
  try {
    await resizeImageInProcess(source, "image/png", readOptions);
    expect(spy).toHaveBeenCalledExactlyOnceWith({ compressionLevel: 9, adaptiveFiltering: true });
    expect(resize.mock.contexts).not.toContain(spy.mock.contexts[0]);
    expect(jpeg).toHaveBeenCalledExactlyOnceWith({ quality: 80 });
  } finally {
    spy.mockRestore();
    resize.mockRestore();
    jpeg.mockRestore();
  }
});
it("stops at a fitting lossless PNG candidate and preserves alpha and pixels", async () => {
  const pixels = Buffer.from([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 0, 64]);
  const source = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
    .png()
    .toBuffer();
  const jpeg = vi.spyOn(sharp.prototype, "jpeg");
  try {
    const result = await resizeImageInProcess(Buffer.concat([source, Buffer.alloc(1024)]), "image/png", {
      ...readOptions,
      maxBytes: 512,
    });
    expect(result).toMatchObject({ strategy: "png-optimized", width: 2, height: 2, mimeType: "image/png" });
    expect(result.data.length).toBeLessThanOrEqual(512);
    expect(await sharp(Buffer.from(result.data, "base64")).raw().toBuffer()).toEqual(pixels);
    expect(jpeg).not.toHaveBeenCalled();
  } finally {
    jpeg.mockRestore();
  }
});
it("accepts fully decodable PNGs with trailing bytes without changing the compression ladder", async () => {
  for (const noise of [false, true]) {
    const source = await png(noise ? 320 : 64, noise ? 320 : 32, noise);
    const padded = Buffer.concat([source, Buffer.from([0])]);
    const result = await resizeImageInProcess(padded, "image/png", readOptions);
    expect(result.data.length).toBeLessThanOrEqual(200_000);
    if (noise) expect(result.mimeType).toBe("image/jpeg");
    else expect(Buffer.from(result.data, "base64")).toEqual(padded);
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

it.each([64, 2400])(
  "tries the exact JPEG ladder, non-cumulative scales and original-based edges (%ipx)",
  async (width) => {
    const bytes = await png(width, width / 2);
    const jpeg = vi.spyOn(sharp.prototype, "jpeg");
    const lossless = vi.spyOn(sharp.prototype, "png");
    const resize = vi.spyOn(sharp.prototype, "resize");
    const buffers = vi.spyOn(sharp.prototype, "toBuffer");
    try {
      await expect(
        resizeImageInProcess(bytes, "image/png", { ...readOptions, maxBytes: 1 }),
      ).rejects.toMatchObject({ code: "too_large" });
      expect(lossless.mock.calls).toHaveLength(width <= 2000 ? 1 : 0);
      expect(jpeg.mock.calls.map(([options]) => (options as JpegOptions | undefined)?.quality)).toEqual([
        ...Array.from({ length: 4 }, () => [80, 60, 40, 20]).flat(),
        ...Array(6).fill(20),
      ]);
      const outputs: unknown[] = await Promise.all(buffers.mock.results.map((call) => call.value));
      const metadata = await Promise.all(
        outputs.filter(Buffer.isBuffer).map((bytes) => sharp(bytes).metadata()),
      );
      const widths = metadata.filter((info) => info.format === "jpeg").map((info) => info.width);
      const bounded = Math.min(width, 2000);
      expect(widths).toEqual([
        ...[1, 0.75, 0.5, 0.25].flatMap((scale) => Array(4).fill(Math.round(bounded * scale))),
        ...[1000, 800, 600, 400, 300, 200].map((edge) => Math.min(bounded, edge)),
      ]);
      expect(resize).toHaveBeenCalledTimes(width <= 2000 ? 3 : 10);
    } finally {
      jpeg.mockRestore();
      lossless.mockRestore();
      resize.mockRestore();
      buffers.mockRestore();
    }
  },
);

it.each(["jpeg", "gif", "bmp"] as const)(
  "retains format-preserving candidates in their original order for %s",
  async (format) => {
    const source =
      format === "bmp"
        ? bmp.encode({ data: Buffer.alloc(16 * 8 * 4), width: 16, height: 8 }).data
        : await sharp(await png(16, 8))
            .toFormat(format)
            .toBuffer();
    const jpeg = vi.spyOn(sharp.prototype, "jpeg");
    const pngEncoder = vi.spyOn(sharp.prototype, "png");
    const gif = vi.spyOn(sharp.prototype, "gif");
    try {
      await expect(
        resizeImageInProcess(source, `image/${format}`, {
          ...readOptions,
          maxWidth: 8,
          maxHeight: 8,
          maxBytes: 1,
        }),
      ).rejects.toMatchObject({ code: "too_large" });
      const attempts = [
        ...jpeg.mock.calls.map(([options], index) => ({
          order: jpeg.mock.invocationCallOrder[index],
          name: `jpeg:${(options as JpegOptions | undefined)?.quality}`,
        })),
        ...pngEncoder.mock.calls.map((_, index) => ({
          order: pngEncoder.mock.invocationCallOrder[index],
          name: "png",
        })),
        ...gif.mock.calls.map((_, index) => ({ order: gif.mock.invocationCallOrder[index], name: "gif" })),
      ]
        .sort((a, b) => a.order - b.order)
        .map((attempt) => attempt.name);
      const qualities = ["jpeg:80", "jpeg:60", "jpeg:40", "jpeg:20"];
      const preserve = format === "jpeg" ? qualities : [format === "bmp" ? "png" : "gif"];
      expect(attempts).toEqual([
        format === "jpeg" ? "jpeg:100" : preserve[0],
        ...preserve,
        ...qualities,
        ...Array.from({ length: 3 }, () => [...preserve, ...qualities]).flat(),
        ...Array(6).fill("jpeg:20"),
      ]);
    } finally {
      jpeg.mockRestore();
      pngEncoder.mockRestore();
      gif.mockRestore();
    }
  },
);

it("uses one resize snapshot for processing and the defensive budget check", async () => {
  const readProfile = vi.fn().mockReturnValueOnce({ maxBytes: 200 }).mockReturnValue({ maxBytes: 500 });
  const model = {
    ...fakeModel(""),
    inputLimits: {
      images: {
        get resize() {
          return readProfile();
        },
      },
    },
  };
  const processSpy = vi.spyOn(processor, "processImage").mockResolvedValue({
    ok: true,
    data: Buffer.alloc(300).toString("base64"),
    mimeType: "image/png",
    hints: [],
  });
  try {
    const read = createReadToolDefinition(process.cwd(), {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => "image/png",
        readFile: async () => Buffer.alloc(1),
      },
    });
    const result = await read.execute("profile", { path: "image.png" }, undefined, undefined, {
      cwd: process.cwd(),
      model,
      sessionManager: SessionManager.inMemory(),
    });
    expect(result.content).toEqual([
      { type: "text", text: "Read image file [image/png]\n[Image omitted: read_image_budget_exceeded.]" },
    ]);
    expect(readProfile).toHaveBeenCalledOnce();
    expect(processSpy).toHaveBeenCalledWith(
      expect.anything(),
      "image/png",
      expect.objectContaining({ resizeOptions: expect.objectContaining({ maxBytes: 200 }) }),
    );
  } finally {
    processSpy.mockRestore();
  }
});
