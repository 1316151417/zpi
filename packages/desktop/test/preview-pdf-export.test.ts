import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { maxPreviewPdfBytes, PreviewPdfExporter, previewPdfOptions } from "../src/main/preview-pdf-export.ts";

const pdf = () => new Uint8Array(Buffer.from("%PDF-1.7\nmock presentation\n%%EOF"));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function fixture() {
  const print = vi.fn(async () => pdf());
  const ready = vi.fn(async (_sessionId: string) => true);
  const chooseFile = vi.fn(
    async (_name: string): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true }),
  );
  const write = vi.fn(async (_path: string, _bytes: Uint8Array) => {});
  return {
    exporter: new PreviewPdfExporter({ ready, print, chooseFile, write }),
    ready,
    print,
    chooseFile,
    write,
  };
}
test("uses CSS paper size, backgrounds and zero margins as the reference", () => {
  expect(previewPdfOptions).toEqual({
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
});
test("saves exactly the generated PDF only to the mocked user-selected temporary path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-pdf-export-"));
  directories.push(dir);
  const chosen = join(dir, "chosen.pdf");
  const native = fixture();
  native.chooseFile.mockResolvedValue({ canceled: false, filePath: chosen });
  native.write.mockImplementation((path, bytes) => writeFile(path, bytes));
  const data = await native.exporter.print("session-a");
  expect(await native.exporter.save(data, "../../deck.pdf")).toEqual({ canceled: false, path: chosen });
  expect(native.chooseFile).toHaveBeenCalledExactlyOnceWith("deck.pdf");
  expect(await readFile(chosen)).toEqual(Buffer.from(data));
  await expect(native.exporter.save(data, "deck.pdf")).rejects.toThrow("不匹配");
  expect(native.write).toHaveBeenCalledTimes(1);
});
test("cancel closes the request without a write and next export works", async () => {
  const native = fixture();
  const data = await native.exporter.print("session-a");
  expect(await native.exporter.save(data, "deck.pptx")).toEqual({ canceled: true });
  expect(native.write).not.toHaveBeenCalled();
  await expect(native.exporter.save(data, "deck.pdf")).rejects.toThrow("不匹配");
  expect(await native.exporter.print("session-a")).toEqual(data);
});
test("rejects forged PDF, arbitrary bytes, oversized payloads, malformed names and save without print", async () => {
  const native = fixture();
  await expect(native.exporter.save(pdf(), "deck.pdf")).rejects.toThrow("不匹配");
  const data = await native.exporter.print("session-a");
  await expect(native.exporter.save(Buffer.from("%PDF-1.7 forged"), "deck.pdf")).rejects.toThrow("不匹配");
  await expect(native.exporter.save(new Uint8Array(10), "deck.pdf")).rejects.toThrow("只允许");
  await expect(native.exporter.save(new Uint8Array(maxPreviewPdfBytes + 1), "deck.pdf")).rejects.toThrow(
    "50 MiB",
  );
  await expect(native.exporter.save(data, "bad\0name")).rejects.toThrow("文件名");
  expect(native.chooseFile).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});
test("print failure clears the lock and never reuses a stale PDF", async () => {
  const native = fixture();
  const old = await native.exporter.print("session-a");
  native.print.mockRejectedValueOnce(new Error("print failed"));
  await expect(native.exporter.print("session-a")).rejects.toThrow("print failed");
  await expect(native.exporter.save(old, "deck.pdf")).rejects.toThrow("不匹配");
  expect(await native.exporter.print("session-a")).toEqual(old);
});
test("blocks repeated print and save while a print is in progress", async () => {
  const native = fixture();
  let resolve!: (value: Uint8Array<ArrayBuffer>) => void;
  native.print.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const first = native.exporter.print("session-a");
  await expect(native.exporter.print("session-a")).rejects.toThrow("正在导出");
  await expect(native.exporter.save(pdf(), "deck.pdf")).rejects.toThrow("正在导出");
  resolve(pdf());
  await first;
  expect(native.print).toHaveBeenCalledTimes(1);
});
test("blocks concurrent export while the dialog is open and recovers from write errors", async () => {
  const native = fixture();
  const data = await native.exporter.print("session-a");
  let resolve!: (value: { canceled: boolean; filePath?: string }) => void;
  native.chooseFile.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const saving = native.exporter.save(data, "deck.pdf");
  await expect(native.exporter.print("session-a")).rejects.toThrow("正在导出");
  await expect(native.exporter.save(data, "deck.pdf")).rejects.toThrow("正在导出");
  native.write.mockRejectedValueOnce(new Error("disk full"));
  resolve({ canceled: false, filePath: "/mock-only" });
  await expect(saving).rejects.toThrow("disk full");
  expect(await native.exporter.print("session-a")).toEqual(data);
});

test("an unready print host never invokes native printing and releases the lock", async () => {
  const native = fixture();
  native.ready.mockResolvedValueOnce(false);
  await expect(native.exporter.print("session-a")).rejects.toThrow("尚未就绪");
  expect(native.ready).toHaveBeenCalledWith("session-a");
  expect(native.print).not.toHaveBeenCalled();
  expect(await native.exporter.print("session-a")).toEqual(pdf());
});
