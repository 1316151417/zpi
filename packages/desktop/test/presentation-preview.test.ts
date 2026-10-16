import { describe, expect, it } from "vitest";
import {
  clampPresentationPageNumber,
  clampPresentationZoomPercent,
  safePresentationUrl,
} from "../src/renderer/presentation/controls.ts";
import {
  buildPresentationPageElements,
  hitTestPresentationElement,
} from "../src/renderer/presentation/element-model.ts";
import { resolvePrintableFontFamily } from "../src/renderer/presentation/print-export.ts";

describe("presentation preview controls", () => {
  it("bounds page navigation and resets invalid input", () => {
    expect(clampPresentationPageNumber(-2, 7)).toBe(1);
    expect(clampPresentationPageNumber(99, 7)).toBe(7);
    expect(clampPresentationPageNumber(Number.NaN, 7)).toBe(1);
    expect(clampPresentationPageNumber(2.6, 7)).toBe(3);
  });
  it("limits fit-relative zoom to 25–300 percent", () => {
    expect(clampPresentationZoomPercent(0)).toBe(25);
    expect(clampPresentationZoomPercent(400)).toBe(300);
    expect(clampPresentationZoomPercent(Number.NaN)).toBe(100);
  });
  it("blocks executable and local document links", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "java\nscript:alert(1)",
      "//example.com",
      "https://example.com/\u0000",
    ])
      expect(safePresentationUrl(url)).toBeNull();
    expect(safePresentationUrl("https://example.com/a#slide")).toBe("https://example.com/a#slide");
  });
  it("selects the topmost slide element and preserves its OOXML identity", () => {
    const elements = buildPresentationPageElements({
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      groupTextEntries: [],
      nodes: [
        {
          id: "1",
          name: "background",
          nodeType: "shape",
          position: { x: 0, y: 0 },
          size: { w: 100, h: 100 },
          text: "first",
        },
        {
          id: "2",
          name: "heading",
          nodeType: "shape",
          position: { x: 10, y: 10 },
          size: { w: 40, h: 40 },
          text: "second",
        },
      ],
    });
    expect(hitTestPresentationElement(elements, { x: 20, y: 20 })?.nodeId).toBe("2");
    expect(hitTestPresentationElement(elements, { x: 200, y: 200 })).toBeNull();
    expect(elements[0].slidePart).toBe("ppt/slides/slide1.xml");
  });
  it("does not replace already printable font stacks", () => {
    expect(resolvePrintableFontFamily("Arial, sans-serif", "Hello", () => true)).toBeNull();
  });
});
