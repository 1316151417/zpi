import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createEditTool, type FileChange } from "zpi-coding-agent";
import { applyFileRewind, planFileRewind } from "../src/main/file-rewind.ts";
import { fixture } from "./helpers/context-fixture.ts";

it("restores a BOM file byte-for-byte from an edit checkpoint", async () => {
  const f = await fixture();
  const cwd = await realpath(f.workspace);
  const path = join(cwd, "bom.txt");
  const snapshots = join(f.dir, "snapshots");
  const before = Buffer.from("\uFEFFold text\r\n");
  await writeFile(path, before);
  const result = await createEditTool(cwd, snapshots).execute("edit", {
    path,
    edits: [{ oldText: "old", newText: "new" }],
  });
  const change = (result.details as unknown as { fileChange: FileChange }).fileChange;
  expect(await readFile(change.beforeFile as string)).toEqual(before);
  expect(await readFile(change.afterFile as string)).toEqual(await readFile(path));
  const plan = await planFileRewind([change], snapshots, cwd);
  expect(plan.conflicts).toEqual([]);
  expect(await applyFileRewind(plan, () => {})).toEqual([]);
  expect(await readFile(path)).toEqual(before);
});

it("file reset rolls back all files if transcript commit fails, and rechecks concurrent edits before any write", async () => {
  const f = await fixture();
  const workspace = await realpath(f.workspace),
    root = join(f.dir, "snapshots");
  await mkdir(root);
  const modified = join(workspace, "modified.txt"),
    created = join(workspace, "created.txt"),
    before = join(root, "before");
  await writeFile(modified, "agent");
  await writeFile(created, "created");
  await writeFile(before, "original");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const plan = await planFileRewind(
    [
      {
        path: modified,
        operation: "modified",
        toolCallId: "modify",
        beforeHash: hash("original"),
        afterHash: hash("agent"),
        beforeFile: before,
      },
      {
        path: created,
        operation: "created",
        toolCallId: "create",
        beforeHash: null,
        afterHash: hash("created"),
      },
    ],
    root,
    workspace,
  );
  expect(plan.conflicts).toEqual([]);
  await expect(
    applyFileRewind(plan, async () => {
      expect(readFileSync(modified, "utf8")).toBe("original");
      expect(existsSync(created)).toBe(false);
      await Promise.resolve();
      throw new Error("transcript disk full");
    }),
  ).rejects.toThrow("disk full");
  expect(await readFile(modified, "utf8")).toBe("agent");
  expect(await readFile(created, "utf8")).toBe("created");
  await writeFile(modified, "external");
  const commit = vi.fn();
  expect(await applyFileRewind(plan, commit)).toEqual([{ path: modified, reason: "当前文件已被外部修改" }]);
  expect(commit).not.toHaveBeenCalled();
  expect(await readFile(modified, "utf8")).toBe("external");
  expect(await readFile(created, "utf8")).toBe("created");
});
