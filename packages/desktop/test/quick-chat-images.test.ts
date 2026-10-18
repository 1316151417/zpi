import bmp from "bmp-js";
import sharp from "sharp";
import { afterEach, expect, test, vi } from "vitest";
import * as core from "zpi-coding-agent";
import { QuickChatAttachments } from "../src/main/quick-chat-attachments.ts";

afterEach(() => vi.restoreAllMocks());
const png = () =>
  sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } })
    .png()
    .toBuffer();

test.each(["png", "jpeg", "gif", "webp", "bmp"] as const)(
  "quick-chat detects and fully prepares actual %s bytes independently of their filename",
  async (format) => {
    const source =
      format === "bmp"
        ? bmp.encode({ data: Buffer.from([0, 0, 0, 255]), width: 1, height: 1 }).data
        : await sharp(await png())
            .toFormat(format)
            .toBuffer();
    const store = new QuickChatAttachments();
    const metadata = await store.import("fake.svg", source);
    expect(metadata.mimeType).toBe(`image/${format}`);
    expect(store.read(metadata.id)).toEqual({ metadata, data: source.toString("base64") });
    const loaded = store.load([metadata.id]);
    expect(loaded.images[0].type).toBe("image");
    expect(await sharp(Buffer.from(loaded.images[0].data, "base64")).stats()).toBeDefined();
    expect(loaded.images[0].mimeType).toBe(format === "bmp" ? "image/png" : metadata.mimeType);
  },
);

test("invalid, empty, oversize and metadata-only truncated sources never enter the cache", async () => {
  const store = new QuickChatAttachments();
  const source = await png();
  const truncated = source.subarray(0, source.length - 16);
  expect((await sharp(truncated).metadata()).width).toBe(3);
  for (const input of [
    Buffer.from("<svg/>"),
    Buffer.alloc(0),
    source.subarray(0, 40),
    truncated,
    Buffer.alloc(core.imageLimits.sourceBytes + 1),
  ])
    await expect(store.import("image.png", input)).rejects.toThrow("invalid_input:");
  await expect(store.import("", source)).rejects.toThrow("invalid_input:");
  await expect(store.import("x".repeat(251), source)).rejects.toThrow("invalid_input:");
  await expect(
    store.import("image.png", "data:image/png;base64,AA==" as unknown as Uint8Array),
  ).rejects.toThrow("invalid_input:");
  const image = await store.import("valid.png", source);
  expect(store.load([image.id]).metadata).toHaveLength(1);
});

test("the core rejects a source exceeding forty million pixels before decoding its raster", async () => {
  const source = bmp.encode({ data: Buffer.from([0, 0, 0, 255]), width: 1, height: 1 }).data;
  source.writeInt32LE(core.imageLimits.pixels + 1, 18);
  const store = new QuickChatAttachments();
  await expect(store.import("oversized.bmp", source)).rejects.toThrow(/像素|尺寸/);
});

test("concurrent draft admission caps eight imports and removals release unused entries", async () => {
  const store = new QuickChatAttachments();
  const source = await png();
  const pending = Array.from({ length: 8 }, (_, i) => store.import(`${i}.png`, source));
  await expect(store.import("ninth.png", source)).rejects.toThrow("最多 8");
  const images = await Promise.all(pending);
  expect(() => store.load([...images.map((image) => image.id), "ninth"])).toThrow("最多 8");
  expect(() => store.load([images[0].id, images[0].id])).toThrow("图片列表无效");
  expect(() => store.load(["missing"])).toThrow("not_found:");
  expect(() => store.read("../path")).toThrow("not_found:");
  expect(() => store.remove("missing")).toThrow("not_found:");
  store.remove(images[0].id);
  expect(() => store.read(images[0].id)).toThrow("not_found:");
  const replacement = await store.import("replacement.png", source);
  store.markUsed([replacement.id]);
  store.remove(replacement.id);
  expect(store.read(replacement.id).metadata).toEqual(replacement);
  await expect(store.import("next-draft.png", source)).resolves.toBeDefined();
});

test("source dimensions enforce the total per-message pixel limit before acceptance", async () => {
  vi.spyOn(core, "validateImageSource").mockResolvedValue({
    mimeType: "image/png",
    width: 10_000,
    height: 3_000,
  });
  const store = new QuickChatAttachments();
  const source = await png();
  const images = await Promise.all(Array.from({ length: 3 }, () => store.import("large.png", source)));
  expect(store.load(images.slice(0, 2).map((image) => image.id)).images).toHaveLength(2);
  expect(() => store.load(images.map((image) => image.id))).toThrow("总像素超限");
});

test("resize and animation hints are retained for model input alongside original preview metadata", async () => {
  const store = new QuickChatAttachments();
  const source = await sharp({ create: { width: 4000, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const image = await store.import("large.png", source);
  const loaded = store.load([image.id]);
  expect(image.width).toBe(4000);
  expect(loaded.context).toContain('Attached image "large.png"');
  expect(loaded.context).toContain("original 4000x2");
  expect(loaded.context).toContain("Multiply coordinates");
  const animated = Buffer.from(
    "R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAIfkEAAoAAAAsAAAAAAEAAQCBAAD/AAAAAAAAAAAACAQAAQQEADs=",
    "base64",
  );
  const gif = await store.import("animation.gif", animated);
  expect(gif.warning).toBe("动画图片仅发送首帧");
  expect(store.load([gif.id]).images[0]?.data).toBe(animated.toString("base64"));
});

test("reset during decode or preparation rejects late imports without repopulating the cache", async () => {
  const source = await png();
  for (const phase of ["validateImageSource", "prepareInlineImage"] as const) {
    const store = new QuickChatAttachments();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = phase === "validateImageSource" ? core.validateImageSource : core.prepareInlineImage;
    const spy = vi.spyOn(core, phase).mockImplementationOnce(async (...args: unknown[]) => {
      entered();
      await gate;
      return (original as (...args: unknown[]) => Promise<never>)(...args);
    });
    const pending = store.import("late.png", source);
    const rejection = expect(pending).rejects.toThrow("临时对话已结束");
    await started;
    store.clear();
    release();
    await rejection;
    spy.mockRestore();
    const fresh = await store.import("fresh.png", source);
    expect(store.load([fresh.id]).images).toHaveLength(1);
  }
});

test("imports decode serially, clear invalidates queued work, and input bytes are copied on admission", async () => {
  const source = await png();
  const original = Buffer.from(source);
  const store = new QuickChatAttachments();
  const validation = vi.spyOn(core, "validateImageSource");
  const pending = store.import("copied.png", source);
  source.fill(0);
  const image = await pending;
  expect(store.read(image.id).data).toBe(original.toString("base64"));
  expect(validation).toHaveBeenCalledTimes(1);
  const obsolete = store.import("obsolete.png", original);
  const rejection = expect(obsolete).rejects.toThrow("临时对话已结束");
  store.clear();
  await rejection;
  expect(validation).toHaveBeenCalledTimes(1);
  expect(() => store.read(image.id)).toThrow("not_found:");
});

test("prepared cache and repeated accepted history are bounded, with budget reclaimed on clear", async () => {
  // Fake a large prepared payload without decoding a huge raster in this accounting test.
  vi.spyOn(core, "prepareInlineImage").mockResolvedValue({
    ok: true,
    data: "a".repeat(8 * 1024 * 1024),
    mimeType: "image/png",
    hints: [],
  });
  const store = new QuickChatAttachments();
  const source = await png();
  const image = await store.import("image.png", source);
  for (let index = 0; index < 6; index++) {
    store.load([image.id]);
    store.markUsed([image.id]);
  }
  expect(() => store.load([image.id])).toThrow("内存已达上限");
  store.clearDraft();
  expect(() => store.load([image.id])).toThrow("内存已达上限");
  expect(store.read(image.id)).toBeDefined();
  await expect(store.import("too-large.png", source)).rejects.toThrow("内存已达上限");
  store.clear();
  await expect(store.import("fresh.png", source)).resolves.toBeDefined();
});

test("discarding a renderer draft frees its eight slots, preserves accepted images and rejects late imports", async () => {
  const store = new QuickChatAttachments();
  const source = await png();
  const accepted = await store.import("accepted.png", source);
  store.markUsed([accepted.id]);
  const drafts = await Promise.all(Array.from({ length: 8 }, () => store.import("draft.png", source)));
  store.clearDraft();
  for (const draft of drafts) expect(() => store.read(draft.id)).toThrow("not_found:");
  expect(store.read(accepted.id).metadata).toEqual(accepted);
  const obsolete = store.import("late.png", source);
  const rejection = expect(obsolete).rejects.toThrow("临时对话已结束");
  store.clearDraft();
  await rejection;
  const fresh = await Promise.all(Array.from({ length: 8 }, () => store.import("fresh.png", source)));
  expect(store.load(fresh.map((image) => image.id)).images).toHaveLength(8);
  expect(store.read(accepted.id).metadata).toEqual(accepted);
});
