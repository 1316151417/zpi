import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  backupMemorySummary,
  finishMemorySummary,
  memoryWorkspaceDiff,
  prepareMemoryWorkspace,
  recoverMemorySummary,
  replaceMemoryFile,
  resetMemoryBaseline,
  validateMemoryWorkspace,
} from "../src/main/memory/workspace.ts";

const exec = promisify(execFile);
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
const valid = (body = "") =>
  `v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n${body}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zpi-memory-workspace-"));
  paths.push(root);
  await prepareMemoryWorkspace(root);
  return root;
}

test("Git baseline detects additions, edits and source deletion, then resets to one commit", async () => {
  const root = await fixture();
  await writeFile(join(root, "rollout_summaries", "source.md"), "session_id: source\nOriginal evidence.");
  expect(await memoryWorkspaceDiff(root)).toContain("new file mode");
  await resetMemoryBaseline(root);
  expect(await memoryWorkspaceDiff(root)).toBe("");
  await writeFile(join(root, "rollout_summaries", "source.md"), "Corrected evidence.");
  expect(await memoryWorkspaceDiff(root)).toContain("-Original evidence.");
  await rm(join(root, "rollout_summaries", "source.md"));
  expect(await memoryWorkspaceDiff(root)).toContain("deleted file mode");
  await resetMemoryBaseline(root);
  const { stdout } = await exec("git", ["-C", root, "rev-list", "--count", "HEAD"]);
  expect(stdout.trim()).toBe("1");
  expect(await readdir(root)).not.toContain("generations");
});

test("rollback restores the previous summary after failure and after restart", async () => {
  const root = await fixture();
  await replaceMemoryFile(join(root, "memory_summary.md"), valid("Previous"));
  await backupMemorySummary(root);
  await replaceMemoryFile(join(root, "memory_summary.md"), "Incomplete output");
  await recoverMemorySummary(root);
  expect(await readFile(join(root, "memory_summary.md"), "utf8")).toBe(valid("Previous"));
  await expect(readFile(join(root, ".summary-backup.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("crash after committing state keeps the committed summary instead of rolling it back", async () => {
  const root = await fixture();
  await replaceMemoryFile(join(root, "memory_summary.md"), valid("Old"));
  await backupMemorySummary(root);
  await replaceMemoryFile(join(root, "memory_summary.md"), valid("Committed"));
  await recoverMemorySummary(root, valid("Committed"));
  expect(await readFile(join(root, "memory_summary.md"), "utf8")).toBe(valid("Committed"));
});

test("failed first generation removes its incomplete summary", async () => {
  const root = await fixture();
  await backupMemorySummary(root);
  await writeFile(join(root, "memory_summary.md"), "Incomplete");
  await recoverMemorySummary(root);
  await expect(readFile(join(root, "memory_summary.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("transient backup and diff files never become baseline history", async () => {
  const root = await fixture();
  await writeFile(join(root, "memory_summary.md"), valid());
  await backupMemorySummary(root);
  await writeFile(join(root, "phase2_workspace_diff.md"), "Temporary diff");
  await resetMemoryBaseline(root);
  const { stdout } = await exec("git", ["-C", root, "ls-tree", "-r", "--name-only", "HEAD"]);
  expect(stdout).not.toContain("backup");
  expect(stdout).not.toContain("phase2_workspace_diff");
  await finishMemorySummary(root);
});

test.each([
  "bad-header",
  "oversized",
  "missing-section",
  "deleted-source",
  "skills",
  "symlink",
  "source-modification",
])("rejects %s artifacts", async (kind) => {
  const root = await fixture();
  const source = { path: "rollout_summaries/source.md", content: "Source evidence" };
  await writeFile(join(root, source.path), source.content);
  await writeFile(join(root, "memory_summary.md"), valid("rollout_summaries/source.md"));
  if (kind === "bad-header") await writeFile(join(root, "memory_summary.md"), valid().replace("v1", "v2"));
  if (kind === "oversized") await writeFile(join(root, "memory_summary.md"), valid("x".repeat(10000)));
  if (kind === "missing-section") await writeFile(join(root, "memory_summary.md"), "v1\nOnly text");
  if (kind === "deleted-source")
    await writeFile(join(root, "memory_summary.md"), valid("rollout_summaries/deleted.md"));
  if (kind === "skills") await writeFile(join(root, "SKILL.md"), "Forbidden");
  if (kind === "symlink") {
    await rm(join(root, "memory_summary.md"));
    await symlink(join(root, source.path), join(root, "memory_summary.md"));
  }
  if (kind === "source-modification") await writeFile(join(root, source.path), "Rewritten source");
  await expect(validateMemoryWorkspace(root, [source])).rejects.toThrow();
});

test("an oversized failed worker output cannot prevent journal recovery", async () => {
  const root = await fixture();
  const previous = valid("Previous valid summary");
  await writeFile(join(root, "memory_summary.md"), previous);
  await backupMemorySummary(root);
  await writeFile(join(root, "memory_summary.md"), "x".repeat(20000));
  await recoverMemorySummary(root, previous);
  expect(await readFile(join(root, "memory_summary.md"), "utf8")).toBe(previous);
});
