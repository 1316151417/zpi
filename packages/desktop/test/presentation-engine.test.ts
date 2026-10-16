import { readFile } from "node:fs/promises";
import { DOMParser as XmlParser } from "@xmldom/xmldom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pptxRendererPreviewEngine } from "../src/renderer/presentation/pptx-engine.ts";

// XML-only DOM adapter: exercise the real ZIP/OOXML parser without pretending to render pixels.
class TestXmlParser {
  parseFromString(source: string, mime: "application/xml") {
    const document = new XmlParser().parseFromString(source, mime);
    Object.defineProperty(document, "querySelector", {
      value: (selector: string) => document.getElementsByTagName(selector)[0] ?? null,
    });
    const nodes = document.getElementsByTagName("*");
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      Object.defineProperty(node, "children", {
        get: () => Array.from(node.childNodes).filter((child) => child.nodeType === 1),
      });
    }
    return document;
  }
}
afterEach(() => vi.unstubAllGlobals());
describe("real PPTX document parsing", () => {
  it("opens a real OOXML deck, lazily indexes slide elements and disposes idempotently", async () => {
    vi.stubGlobal("DOMParser", TestXmlParser);
    const bytes = await readFile(new URL("./fixtures/presentation-preview.pptx", import.meta.url));
    const document = await pptxRendererPreviewEngine.open(new Uint8Array(bytes).buffer);
    expect(document.pageCount).toBeGreaterThan(0);
    expect(document.pageSize.width).toBeGreaterThan(0);
    const elements = document.getPageElements(0);
    expect(elements.length).toBeGreaterThan(0);
    expect(document.getPageElements(0)).toBe(elements);
    expect(elements.some((element) => element.text?.trim())).toBe(true);
    expect(() => document.getPageElements(document.pageCount)).toThrow(RangeError);
    document.dispose();
    document.dispose();
    expect(() => document.getPageElements(0)).toThrow("disposed");
    expect(() => document.renderPage(0, {} as HTMLElement)).toThrow("disposed");
  });
  it("rejects invalid bytes instead of displaying an empty successful preview", async () => {
    await expect(
      pptxRendererPreviewEngine.open(new TextEncoder().encode("not a PPTX").buffer),
    ).rejects.toThrow();
  });
});
