import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkPreviewFiles } from "../src/main/preview-files.ts";

it("batch validates actual regular files without reading contents, rejecting malformed input", async () => {
  const root = await mkdtemp(join(tmpdir(), "ZPI-preview-stat-"));
  try {
    const path = join(root, "报告 空格.pdf");
    await writeFile(path, "pdf");
    await mkdir(join(root, "directory.pdf"));
    await symlink(path, join(root, "link.pdf"));
    expect(await checkPreviewFiles(root, [path, "missing.pdf", "directory.pdf", "link.pdf"])).toEqual([
      { path, exists: true },
      { path: "missing.pdf", exists: false },
      { path: "directory.pdf", exists: false },
      { path: "link.pdf", exists: true },
    ]);
    await expect(checkPreviewFiles(root, Array(16).fill(path))).rejects.toThrow("invalid_input");
    await expect(checkPreviewFiles(root, ["bad\0.pdf"])).rejects.toThrow("invalid_input");
    expect(await checkPreviewFiles(root, ["../outside.pdf"])).toEqual([
      { path: "../outside.pdf", exists: false },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
