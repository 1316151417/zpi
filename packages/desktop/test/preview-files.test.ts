import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractAssistantFileReferences } from "../../ui/src/preview/assistant-file-references.ts";
import { toFileUrl } from "../../ui/src/preview/path.ts";
import { checkPreviewFiles } from "../src/main/preview-files.ts";

it("finds preview files after decoding reserved filename characters from URLs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zpi-preview-url-"));
  try {
    for (const name of ["report#1.pdf", "report%23.pdf", "report+1.pdf"]) {
      const path = join(cwd, name);
      await writeFile(path, "preview existence check");
      const refs = extractAssistantFileReferences(`[report](${toFileUrl(path)})`, cwd);
      expect(
        await checkPreviewFiles(
          cwd,
          refs.map((ref) => ref.path),
        ),
      ).toEqual([{ path, exists: true }]);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("batch validates actual regular files without reading contents, rejecting malformed input", async () => {
  const root = await mkdtemp(join(tmpdir(), "zpi-preview-stat-"));
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
