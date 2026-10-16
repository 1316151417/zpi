import { describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({
  handles: [] as Array<{
    ready: Promise<void>;
    dispose: ReturnType<typeof vi.fn>;
    element: { remove: ReturnType<typeof vi.fn> };
  }>,
}));
vi.mock("@aiden0z/pptx-renderer/browser", () => ({
  RECOMMENDED_ZIP_LIMITS: {},
  parseZipLazyMedia: vi.fn(async () => ({})),
  buildPresentation: vi.fn(() => ({
    width: 960,
    height: 540,
    slides: [
      { slidePath: "ppt/slides/slide1.xml", nodes: [] },
      { slidePath: "ppt/slides/slide2.xml", nodes: [] },
    ],
  })),
  buildTextIndex: vi.fn(() => []),
  materializeSlideNodes: vi.fn(),
  renderSlide: vi.fn(() => {
    const handle = { ready: Promise.resolve(), dispose: vi.fn(), element: { remove: vi.fn() } };
    upstream.handles.push(handle);
    return handle;
  }),
}));

import { pptxRendererPreviewEngine } from "../src/renderer/presentation/pptx-engine.ts";

describe("presentation render lifecycle", () => {
  it("releases only the old page on a page change and all remaining handles on close", async () => {
    const document = await pptxRendererPreviewEngine.open(new ArrayBuffer(0));
    const mount = { append: vi.fn() } as unknown as HTMLElement;
    const first = document.renderPage(0, mount);
    await first.ready;
    first.dispose();
    first.dispose();
    const firstUpstream = upstream.handles.at(-1);
    expect(firstUpstream?.dispose).toHaveBeenCalledOnce();
    expect(firstUpstream?.element.remove).toHaveBeenCalledOnce();
    const second = document.renderPage(1, mount);
    await second.ready;
    const secondUpstream = upstream.handles.at(-1);
    document.dispose();
    document.dispose();
    expect(firstUpstream?.dispose).toHaveBeenCalledOnce();
    expect(secondUpstream?.dispose).toHaveBeenCalledOnce();
    expect(mount.append).toHaveBeenCalledTimes(2);
    expect(() => document.renderPage(1, mount)).toThrow("disposed");
  });
  it("rejects out-of-bounds pages before touching the DOM", async () => {
    const document = await pptxRendererPreviewEngine.open(new ArrayBuffer(0));
    const mount = { append: vi.fn() } as unknown as HTMLElement;
    expect(() => document.renderPage(2, mount)).toThrow(RangeError);
    expect(mount.append).not.toHaveBeenCalled();
    document.dispose();
  });
});
