import { describe, expect, it, vi } from "vitest";
import {
  appendSelection,
  buildSelectionPrompt,
  parseSelectionPrompt,
} from "../../ui/src/conversation-selections.ts";
import { exportPresentationPdf } from "../src/renderer/presentation/export.ts";
import { createPresentationSelection } from "../src/renderer/presentation/reference.ts";
import type { PresentationPreviewDocument } from "../src/renderer/presentation/types.ts";

const document = {} as PresentationPreviewDocument;
function services() {
  const dispose = vi.fn();
  return {
    document,
    fileName: "/project/slides.pptx",
    prepare: vi.fn(async () => ({ dispose })),
    print: vi.fn(async () => new Uint8Array([1, 2])),
    save: vi.fn(async () => ({ canceled: true })),
    dispose,
  };
}
describe("presentation PDF export lifecycle", () => {
  it("disposes before save and treats cancellation as success", async () => {
    const options = services();
    options.save.mockImplementation(async () => {
      expect(options.dispose).toHaveBeenCalledOnce();
      return { canceled: true };
    });
    expect(await exportPresentationPdf(options)).toEqual({ canceled: true });
    expect(options.save).toHaveBeenCalledWith(new Uint8Array([1, 2]), "slides.pdf");
  });
  it("cleans up after print failure and never saves", async () => {
    const options = services();
    options.print.mockRejectedValue(new Error("print failed"));
    await expect(exportPresentationPdf(options)).rejects.toThrow("print failed");
    expect(options.dispose).toHaveBeenCalledOnce();
    expect(options.save).not.toHaveBeenCalled();
    await expect(exportPresentationPdf(services())).resolves.toEqual({ canceled: true });
  });
  it("releases the window-wide lock after preparation or save failure", async () => {
    const options = services();
    options.prepare.mockRejectedValue(new Error("render failed"));
    await expect(exportPresentationPdf(options)).rejects.toThrow("render failed");
    const next = services();
    next.save.mockRejectedValue(new Error("disk full"));
    await expect(exportPresentationPdf(next)).rejects.toThrow("disk full");
    expect(next.dispose).toHaveBeenCalledOnce();
    await expect(exportPresentationPdf(services())).resolves.toEqual({ canceled: true });
  });
  it("rejects concurrent exports before creating another print host", async () => {
    let finish: (() => void) | undefined;
    const options = services();
    options.print.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return new Uint8Array([1]);
    });
    const first = exportPresentationPdf(options);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const second = services();
    await expect(exportPresentationPdf(second)).rejects.toThrow("正在导出");
    expect(second.prepare).not.toHaveBeenCalled();
    finish?.();
    await first;
  });
});

it("keeps exact element identity and comments in removable conversation context", async () => {
  const reference = await createPresentationSelection({
    path: "/project/slides.pptx",
    bytes: new Uint8Array([1, 2, 3]),
    comment: " 改成蓝色 ",
    element: {
      slideIndex: 2,
      slidePart: "ppt/slides/slide3.xml",
      nodeId: "shape42",
      nodePath: "slides/2/nodes/1",
      nodeName: "Title",
      nodeType: "shape",
      text: "Hello",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      zIndex: 1,
    },
  });
  expect(reference.text).toContain('"nodeId": "shape42"');
  expect(reference.text).toContain('"comment": "改成蓝色"');
  expect(reference.text).toMatch(/sha256:[0-9a-f]{64}/);
  const attachments = appendSelection([], reference);
  const prompt = buildSelectionPrompt("Please edit", attachments);
  expect(parseSelectionPrompt(prompt).selections[0]).toEqual({ path: reference.path, text: reference.text });
  const removed = attachments.filter((item) => item.id !== reference.id);
  expect(buildSelectionPrompt("Please edit", removed)).toBe("Please edit");
});
