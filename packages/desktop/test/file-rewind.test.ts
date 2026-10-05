import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { applyFileRewind, planFileRewind } from "../src/main/file-rewind.ts";
import { fixture } from "./helpers/context-fixture.ts";

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
  expect(() =>
    applyFileRewind(plan, () => {
      expect(readFileSync(modified, "utf8")).toBe("original");
      expect(existsSync(created)).toBe(false);
      throw new Error("transcript disk full");
    }),
  ).toThrow("disk full");
  expect(await readFile(modified, "utf8")).toBe("agent");
  expect(await readFile(created, "utf8")).toBe("created");
  await writeFile(modified, "external");
  const commit = vi.fn();
  expect(applyFileRewind(plan, commit)).toEqual([{ path: modified, reason: "当前文件已被外部修改" }]);
  expect(commit).not.toHaveBeenCalled();
  expect(await readFile(modified, "utf8")).toBe("external");
  expect(await readFile(created, "utf8")).toBe("created");
});
