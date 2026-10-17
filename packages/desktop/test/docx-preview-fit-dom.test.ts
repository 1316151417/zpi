import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import DocxPreview from "../src/renderer/DocxPreview.tsx";
import LegacyDocPreview from "../src/renderer/LegacyDocPreview.tsx";

const documentRender = vi.hoisted(() => ({ pending: [] as (() => void)[], model: {} }));
vi.mock("docx-preview", () => ({
  renderAsync: () => new Promise<void>((resolve) => documentRender.pending.push(resolve)),
}));
vi.mock("@extend-ai/react-docx", () => ({
  setWasmSource: vi.fn(),
  useDocxModel: () => ({ model: documentRender.model, isLoading: false }),
  useDocxEditor: () => ({}),
  DocxEditorViewer: ({ pageVirtualization }: { pageVirtualization: { zoomScale: number } }) =>
    createElement("div", { "data-page-zoom": pageVirtualization.zoomScale }),
}));
vi.mock("../src/renderer/error-log.ts", () => ({ logRendererError: vi.fn() }));

class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  notify() {
    this.callback([], this as unknown as ResizeObserver);
  }
}
const observers: ResizeObserverStub[] = [];
let width: number;
let root: Root;
let container: HTMLDivElement;
const props = { buffer: new ArrayBuffer(0), sourcePath: "first.docx", errorMessage: "无法加载文档" };
function element(name: string): HTMLElement {
  const match = container.querySelector<HTMLElement>(`[data-docx-fit-${name}]`);
  if (!match) throw new Error(`Missing document fit ${name}`);
  return match;
}

beforeEach(() => {
  width = 400;
  observers.length = 0;
  documentRender.pending.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-docx-fit-viewport") ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1000);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("fits DOCX only after rendering, resizes its frame, and releases observers when changing documents", async () => {
  await act(async () => root.render(createElement(DocxPreview, props)));
  expect(observers).toHaveLength(0);
  expect(element("content").style.transform).toBe("");
  await act(async () => documentRender.pending.shift()?.());
  expect(element("frame").style.width).toBe("400px");
  expect(element("frame").style.height).toBe("500px");
  expect(element("content").style.transform).toBe("scale(0.5)");
  expect(observers[0].observe.mock.calls.map(([target]) => target)).toEqual([
    element("viewport"),
    element("content"),
  ]);

  width = 600;
  await act(async () => observers.at(-1)?.notify());
  expect(element("frame").style.width).toBe("600px");
  expect(element("frame").style.height).toBe("750px");
  expect(element("content").style.transform).toBe("scale(0.75)");

  await act(async () => root.render(createElement(DocxPreview, { ...props, sourcePath: "next.docx" })));
  expect(element("frame").style.width).toBe("");
  expect(element("content").style.transform).toBe("");
  expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
  await act(async () => documentRender.pending.shift()?.());
  expect(element("content").style.transform).toBe("scale(0.75)");
  await act(async () => root.render(null));
  expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
});

test("keeps legacy Word page virtualization aligned with the fitted scale and never enlarges paper", async () => {
  await act(async () => root.render(createElement(LegacyDocPreview, { ...props, sourcePath: "old.doc" })));
  expect(element("content").style.transform).toBe("scale(0.5)");
  expect(container.querySelector("[data-page-zoom]")?.getAttribute("data-page-zoom")).toBe("0.5");
  width = 1200;
  await act(async () => observers.at(-1)?.notify());
  expect(element("frame").style.width).toBe("800px");
  expect(element("frame").style.height).toBe("1000px");
  expect(element("content").style.transform).toBe("scale(1)");
  expect(container.querySelector("[data-page-zoom]")?.getAttribute("data-page-zoom")).toBe("1");
  await act(async () => root.render(null));
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
});
