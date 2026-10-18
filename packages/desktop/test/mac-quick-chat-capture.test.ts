import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { macQuickChatCapture } from "../src/main/mac-quick-chat-capture.ts";

function fixture() {
  const image = {
    isEmpty: () => true,
    getSize: () => ({ width: 1, height: 1 }),
    toPNG: () => Buffer.from("image"),
  };
  const options: Parameters<typeof macQuickChatCapture>[0] = {
    platform: "darwin",
    testMode: false,
    temporaryDirectory: tmpdir(),
    selectionHelper: "/fake/selected-text",
    clipboard: { readText: vi.fn(() => "clipboard"), readImage: vi.fn(() => image as never) },
    accessibilityAccess: () => true,
    run: vi.fn(async () => ({ stdout: JSON.stringify({ text: "selection" }) })),
  };
  const signal = new AbortController().signal;
  return {
    options,
    image,
    signal,
    read: (kind: "clipboard" | "selection" | "screenshot") => macQuickChatCapture(options)(kind, signal),
  };
}
test("clipboard reads text or prefers a bounded image without writing or simulating copy", async () => {
  const f = fixture();
  expect(f.read("clipboard")).toEqual({ text: "clipboard" });
  f.image.isEmpty = () => false;
  expect(f.read("clipboard")).toEqual({ image: { name: "剪贴板.png", bytes: Buffer.from("image") } });
  expect(f.options.run).not.toHaveBeenCalled();
  f.image.getSize = () => ({ width: 10000, height: 10000 });
  expect(() => f.read("clipboard")).toThrow("像素");
  f.image.isEmpty = () => true;
  f.options.clipboard.readText = () => "x".repeat(32_001);
  expect(() => f.read("clipboard")).toThrow("32000");
});
test("missing accessibility permission does not launch a helper; unsupported selections are explicit", async () => {
  const f = fixture();
  f.options.accessibilityAccess = () => false;
  await expect(f.read("selection")).rejects.toThrow("辅助功能");
  expect(f.options.run).not.toHaveBeenCalled();
  f.options.accessibilityAccess = () => true;
  expect(await f.read("selection")).toEqual({ text: "selection" });
  f.options.run = vi.fn(async () => ({ stdout: '{"error":"unavailable"}' }));
  await expect(f.read("selection")).rejects.toThrow("复制");
});
test("an empty native selection result gives an actionable error and permits a retry", async () => {
  const f = fixture();
  f.options.run = vi.fn(async () => ({ stdout: "" }));
  await expect(f.read("selection")).rejects.toThrow("未返回结果");
  f.options.run = vi.fn(async () => ({ stdout: '{"text":"retry"}' }));
  expect(await f.read("selection")).toEqual({ text: "retry" });
});
test.each(["capture", "escape", "failure"] as const)(
  "interactive screenshot %s cleans up its isolated temporary files",
  async (action) => {
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), "zpi-capture-test-"));
    f.options.temporaryDirectory = root;
    f.options.run = vi.fn(async (command, args) => {
      expect(command).toBe("/usr/sbin/screencapture");
      expect(args.slice(0, -1)).toEqual(["-i", "-s", "-x", "-t", "png"]);
      if (action === "failure") throw new Error("failed");
      if (action === "escape") throw Object.assign(new Error("cancelled"), { code: 1 });
      await writeFile(args.at(-1) as string, "png");
      return { stdout: "" };
    });
    try {
      if (action === "failure") await expect(f.read("screenshot")).rejects.toThrow("系统截图");
      else
        expect(await f.read("screenshot")).toEqual(
          action === "escape" ? undefined : { image: { name: "截图.png", bytes: Buffer.from("png") } },
        );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test.each(["clipboard", "selection", "screenshot"] as const)("test mode blocks real %s access", (kind) => {
  const f = fixture();
  f.options.testMode = true;
  expect(() => f.read(kind)).toThrow("unavailable");
  expect(f.options.clipboard.readText).not.toHaveBeenCalled();
  expect(f.options.clipboard.readImage).not.toHaveBeenCalled();
  expect(f.options.run).not.toHaveBeenCalled();
});
