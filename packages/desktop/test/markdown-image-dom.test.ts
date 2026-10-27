import { afterEach, expect, it } from "vitest";
import { readMarkdownImage } from "../src/renderer/markdown-image.ts";

afterEach(() => {
  Reflect.deleteProperty(window, "zpi");
});
it("rejects truncated SVG before creating a broken image URL", async () => {
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: {
      readFilePreview: async () => ({
        ok: true,
        value: { kind: "text", path: "/workspace/large.svg", truncated: true, text: "<svg" },
      }),
    },
  });
  await expect(readMarkdownImage("session", "large.svg")).rejects.toThrow("SVG 超过预览大小限制");
});
it("preserves complete SVG Unicode in the base64 image transport", async () => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg"><text>测试</text></svg>';
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: {
      readFilePreview: async () => ({
        ok: true,
        value: { kind: "text", path: "/workspace/image.svg", truncated: false, text },
      }),
    },
  });
  const url = await readMarkdownImage("session", "image.svg");
  expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(Buffer.from(url.split(",")[1], "base64").toString("utf8")).toBe(text);
});
