import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceFileSearches } from "../src/main/workspace-file-searches.ts";
import { searchFiles, WorkspaceFileSearch } from "../src/main/workspace-files.ts";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "zpi-file-search-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each([false, true])(
  "query searches files beyond the former 15000-candidate index (git: %s)",
  async (git) => {
    const root = await workspace();
    // The target sorts after every filler; the previous empty-query index omitted it.
    for (let start = 0; start < 15010; start += 100)
      await Promise.all(
        Array.from({ length: Math.min(100, 15010 - start) }, (_, offset) =>
          writeFile(join(root, `filler-${String(start + offset).padStart(5, "0")}.txt`), ""),
        ),
      );
    await writeFile(join(root, "zz-unique-final-target.ts"), "target");
    if (git) await promisify(execFile)("git", ["init", "-q"], { cwd: root });
    const searches = new WorkspaceFileSearches();
    const input = { query: "zz-unique-final-target.ts", requestId: "large-workspace", filesOnly: true };
    try {
      let result = await searches.search(1, "task", root, input);
      for (let count = 0; result.continuation && count < 100; count++)
        result = await searches.search(1, "task", root, { ...input, continuation: result.continuation });
      expect(result.continuation).toBeUndefined();
      expect(result.incomplete).toBe(false);
      expect(result.entries.map((entry) => entry.path)).toContain("zz-unique-final-target.ts");
      expect(await searchFiles(root, input.query)).toEqual(result.entries);
    } finally {
      await searches.close();
    }
  },
  30_000,
);

test("non-git scanning resumes after a bounded batch and searches deeper than 20 directories", async () => {
  const root = await workspace();
  const nested = Array.from({ length: 25 }, (_, i) => `level-${i}`).join("/");
  await mkdir(join(root, nested), { recursive: true });
  await writeFile(join(root, nested, "needle.ts"), "");
  const scan = new WorkspaceFileSearch(root, "needle.ts");
  try {
    let result = await scan.nextBatch(5, Number.POSITIVE_INFINITY);
    expect(result.done).toBe(false);
    expect(result.entries).toEqual([]);
    while (!result.done) result = await scan.nextBatch(5, Number.POSITIVE_INFINITY);
    expect(result.entries[0]?.path).toBe(`${nested}/needle.ts`);
    expect(result.incomplete).toBe(false);
  } finally {
    await scan.close();
  }
});

test("bounded results keep the best fuzzy matches instead of the first traversed candidates", async () => {
  const root = await workspace();
  for (const name of ["z-other-needle.ts", "a-other-needle.ts", "needle.ts", "needle-test.ts"])
    await writeFile(join(root, name), "");
  const scan = new WorkspaceFileSearch(root, "needle", undefined, 2, true);
  try {
    let result = await scan.nextBatch(1, Number.POSITIVE_INFINITY);
    while (!result.done) result = await scan.nextBatch(1, Number.POSITIVE_INFINITY);
    expect(result.entries.map((entry) => entry.name)).toEqual(["needle.ts", "needle-test.ts"]);
    expect(result.truncated).toBe(true);
  } finally {
    await scan.close();
  }
});

test("search request identifiers and continuation scopes are validated", async () => {
  const root = await workspace();
  const searches = new WorkspaceFileSearches();
  const input = { query: "needle", requestId: "request" };
  await expect(searches.search(1, "task", root, { ...input, requestId: "../bad" })).rejects.toThrow("标识");
  await expect(searches.search(1, "task", root, { ...input, rootPath: "relative" })).rejects.toThrow(
    "工作目录",
  );
  await expect(searches.search(2, "task", root, { ...input, continuation: "missing" })).rejects.toThrow(
    "过期",
  );
  await searches.close();
});

test("cancellation aborts a scan before it can return stale results", async () => {
  const root = await workspace();
  await writeFile(join(root, "needle.ts"), "");
  const controller = new AbortController();
  const scan = new WorkspaceFileSearch(root, "needle", controller.signal);
  controller.abort();
  await expect(scan.nextBatch()).rejects.toMatchObject({ name: "AbortError" });
  await scan.close();
});

test("continuations are isolated by renderer and scope; cancellation releases the scan", async () => {
  const root = await workspace();
  const searches = new WorkspaceFileSearches();
  const next = vi.spyOn(WorkspaceFileSearch.prototype, "nextBatch").mockResolvedValue({
    entries: [],
    truncated: false,
    incomplete: false,
    done: false,
  });
  const close = vi.spyOn(WorkspaceFileSearch.prototype, "close");
  const input = { query: "needle", requestId: "same-request" };
  try {
    for (const limit of [0, 1001, 1.5, Number.NaN])
      await expect(searches.search(1, "task", root, { ...input, limit })).rejects.toThrow("数量");
    const first = await searches.search(1, "task", root, input);
    await searches.cancel(2, input.requestId);
    expect(close).not.toHaveBeenCalled();
    await expect(
      searches.search(2, "task", root, { ...input, continuation: first.continuation }),
    ).rejects.toThrow("过期");
    await expect(
      searches.search(1, "other-task", root, { ...input, continuation: first.continuation }),
    ).rejects.toThrow("过期");
    const second = await searches.search(1, "task", root, { ...input, continuation: first.continuation });
    expect(second.continuation).not.toBe(first.continuation);
    await searches.cancel(1, input.requestId);
    expect(close).toHaveBeenCalledOnce();
    await expect(
      searches.search(1, "task", root, { ...input, continuation: second.continuation }),
    ).rejects.toThrow("过期");
  } finally {
    await searches.close();
    next.mockRestore();
    close.mockRestore();
  }
});
