import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readFilePreview, readPreviewRange } from "../src/main/file-preview.ts";
import {
  calculateDocxPreviewFit,
  isSameDocxPreviewFit,
  sanitizeDocumentHref,
} from "../src/renderer/office-preview-model.ts";
import { readPdfRange } from "../src/renderer/pdf-range.ts";
import { clampScale, getPdfPageDisplaySize } from "../src/renderer/pdf-zoom.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zpi-preview-formats-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each([
  ["DOCX", "docx"],
  ["doc", "doc"],
  ["xlsx", "xlsx"],
  ["XLSM", "xlsx"],
  ["xls", "xlsx"],
  ["pptx", "pptx"],
  ["pdf", "pdf"],
  ["apng", "image"],
  ["ico", "image"],
  ["mp4", "media"],
  ["flac", "media"],
])("routes %s to a local binary renderer", async (extension, kind) => {
  await writeFile(join(root, `file.${extension}`), new Uint8Array([1, 0, 2]));
  expect(await readFilePreview(root, `file.${extension}`)).toMatchObject({
    kind,
    bytes: new Uint8Array([1, 0, 2]),
  });
});
test("keeps SVG and HTML source available and does not pretend legacy PPT is supported", async () => {
  for (const extension of ["svg", "html", "md"]) {
    await writeFile(join(root, `file.${extension}`), "<p>content</p>");
    expect(await readFilePreview(root, `file.${extension}`)).toMatchObject({ kind: "text" });
  }
  await writeFile(join(root, "old.ppt"), new Uint8Array([1, 0, 2]));
  expect(await readFilePreview(root, "old.ppt")).toMatchObject({ kind: "unsupported" });
});
test("large PDFs load only their first chunk, then bounded ranges", async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(17);
  await writeFile(join(root, "large.pdf"), bytes);
  const preview = await readFilePreview(root, "large.pdf");
  expect(preview).toMatchObject({ kind: "pdf", totalBytes: bytes.length });
  expect("bytes" in preview && preview.bytes.length).toBe(256 * 1024);
  expect(await readPreviewRange(root, "large.pdf", 500, 100)).toEqual(bytes.slice(500, 600));
  for (const [offset, length] of [
    [-1, 1],
    [0, 0],
    [0, 2 * 1024 * 1024],
    [bytes.length, 1],
  ]) {
    await expect(readPreviewRange(root, "large.pdf", offset, length)).rejects.toThrow("范围");
  }
  await expect(readPreviewRange(root, "../escape.pdf", 0, 1)).rejects.toThrow();
  await writeFile(join(root, "secret.txt"), "secret");
  await expect(readPreviewRange(root, "secret.txt", 0, 1)).rejects.toThrow("PDF");
});
test("office fit only shrinks paper and validates sizes", () => {
  expect(calculateDocxPreviewFit({ availableWidth: 400, naturalWidth: 800, naturalHeight: 1000 })).toEqual({
    scale: 0.5,
    width: 400,
    height: 500,
  });
  expect(
    calculateDocxPreviewFit({ availableWidth: 1000, naturalWidth: 800, naturalHeight: 1000 })?.scale,
  ).toBe(1);
  expect(calculateDocxPreviewFit({ availableWidth: 0, naturalWidth: 800, naturalHeight: 1000 })).toBeNull();
});
test.each([
  [null, false],
  [{ scale: 0, width: 400, height: 500 }, true],
  [{ scale: 0.0009, width: 400.49, height: 499.51 }, true],
  [{ scale: 0.001, width: 400, height: 500 }, false],
  [{ scale: -0.001, width: 400, height: 500 }, false],
  [{ scale: 0, width: 400.5, height: 500 }, false],
  [{ scale: 0, width: 399.5, height: 500 }, false],
  [{ scale: 0, width: 400, height: 500.5 }, false],
  [{ scale: 0, width: 400, height: 499.5 }, false],
])("retains Word fit only within every strict jitter tolerance (%j)", (current, expected) => {
  expect(isSameDocxPreviewFit(current, { scale: 0, width: 400, height: 500 })).toBe(expected);
});
test.each([
  "javascript:alert(1)",
  "java\nscript:alert(1)",
  "file:///secret",
  "data:text/html,test",
  "//example.com",
  "#bad anchor",
])("rejects unsafe document URL %s", (href) => {
  expect(sanitizeDocumentHref(href)).toBeNull();
});
test("preserves only document anchors and ordinary web links", () => {
  expect(sanitizeDocumentHref("#heading")).toBe("#heading");
  expect(sanitizeDocumentHref(" https://example.com/page ")).toBe("https://example.com/page");
  expect(clampScale(10)).toBe(4);
  expect(clampScale(0.01)).toBe(0.25);
  expect(getPdfPageDisplaySize({ width: 600, height: 800 }, 0.5)).toEqual({ width: 300, height: 400 });
});

test("splits aggregated PDF requests at the IPC allocation limit", async () => {
  const calls: number[][] = [];
  const bytes = await readPdfRange(123, 2 * 1024 * 1024 + 5, async (offset, length) => {
    calls.push([offset, length]);
    return new Uint8Array(length).fill(7);
  });
  expect(calls).toEqual([
    [123, 1024 * 1024],
    [123 + 1024 * 1024, 1024 * 1024],
    [123 + 2 * 1024 * 1024, 5],
  ]);
  expect(bytes.length).toBe(2 * 1024 * 1024 + 5);
  expect(bytes.at(-1)).toBe(7);
  await expect(readPdfRange(0, 5, async () => new Uint8Array(2))).rejects.toThrow("变化");
});

test.each([
  ["preview.docx", "docx", "word/document.xml"],
  ["references.xlsx", "xlsx", "xl/workbook.xml"],
])("preserves complete real Office package %s for the renderer", async (name, kind, xmlPath) => {
  const bytes = await readFile(resolve("tests/fixtures", name));
  await writeFile(join(root, name), bytes);
  const preview = await readFilePreview(root, name);
  expect(preview.kind).toBe(kind);
  if (!("bytes" in preview)) throw new Error("Missing binary preview");
  expect(Buffer.from(preview.bytes)).toEqual(bytes);
  const archive = await JSZip.loadAsync(preview.bytes);
  expect(await archive.file(xmlPath)?.async("string")).toContain("schemas.openxmlformats.org");
  expect(archive.file("[Content_Types].xml")).not.toBeNull();
});

test("closing a PDF stops subsequent range chunks", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(
    readPdfRange(
      0,
      2 * 1024 * 1024,
      async (_offset, length) => {
        calls += 1;
        controller.abort();
        return new Uint8Array(length);
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
