import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createEditTool, createWriteTool } from "../src/index.ts";
import { temp } from "./helpers/workspace-fixture.ts";

test("locked diffs record actual before/after for create, overwrite, no-op and concurrent edits; large patches are lazy", async () => {
  const cwd = await temp(),
    outputDir = join(cwd, "output"),
    write = createWriteTool(cwd, outputDir),
    edit = createEditTool(cwd, outputDir);
  const first = await write.execute("a", { path: "f.txt", content: "existing dirty text\n" });
  expect(first.details).toMatchObject({
    fileChange: { operation: "created", beforeHash: null, toolCallId: "a" },
  });
  const second = await write.execute("b", { path: "f.txt", content: "next text\n" });
  expect(second.details).toMatchObject({
    fileChange: { operation: "modified", patch: expect.stringContaining("-existing dirty text") },
  });
  expect((await write.execute("same", { path: "f.txt", content: "next text\n" })).details).toBeUndefined();
  const [one, two] = await Promise.all([
    edit.execute("c", { path: "f.txt", edits: [{ oldText: "text", newText: "edited" }] }),
    write.execute("d", { path: "f.txt", content: "final text\n" }),
  ]);
  const editChange = (one.details as { fileChange: { beforeHash: string; afterHash: string } }).fileChange;
  const writeChange = (two.details as { fileChange: { beforeHash: string; afterHash: string } }).fileChange;
  expect(
    editChange.afterHash === writeChange.beforeHash || writeChange.afterHash === editChange.beforeHash,
  ).toBe(true);
  const finalText = await readFile(join(cwd, "f.txt"), "utf8");
  expect(["final text\n", "final edited\n"]).toContain(finalText);
  await expect(
    edit.execute("bad", { path: "f.txt", edits: [{ oldText: "missing", newText: "x" }] }),
  ).rejects.toThrow("Could not find");
  expect(await readFile(join(cwd, "f.txt"), "utf8")).toBe(finalText);
  const large = await write.execute("large", {
    path: "large.txt",
    content: Array.from({ length: 15000 }, (_, i) => `line ${i}`).join("\n"),
  });
  const change = (large.details as { fileChange: { patchFile: string; patch?: string } }).fileChange;
  expect(change.patch).toBeUndefined();
  expect(await readFile(change.patchFile, "utf8")).toContain("+line 14999");
  expect(await realpath(join(cwd, "f.txt"))).toBe(
    (two.details as { fileChange: { path: string } }).fileChange.path,
  );
});
