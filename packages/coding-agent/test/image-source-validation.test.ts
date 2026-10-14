import sharp from "sharp";
import { expect, it } from "vitest";
import { imageLimits, processImage, validateImageSource } from "zpi-coding-agent";

it("source validation returns metadata without encoding or replacing original bytes", async () => {
  const original = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  expect(await validateImageSource(original)).toEqual({ mimeType: "image/png", width: 3, height: 2 });
  const processed = await processImage(original);
  expect(processed.bytes).toEqual(original);
  expect(Buffer.from(processed.image.data, "base64")).toEqual(original);
  await expect(validateImageSource(original.subarray(0, 40))).rejects.toThrow();
  await expect(validateImageSource(Buffer.alloc(0))).rejects.toThrow();
  const oversized = Buffer.alloc(imageLimits.sourceBytes + 1);
  original.copy(oversized);
  await expect(validateImageSource(oversized)).rejects.toThrow("10 MiB");
});
