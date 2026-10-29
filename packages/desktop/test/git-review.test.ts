import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { gitReview, gitReviewDiff } from "../src/main/git-review.ts";
import { runGit } from "../src/main/workspace-files.ts";
import { reviewPatchStats } from "../src/shared/review.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function repo() {
  const path = await mkdtemp(join(tmpdir(), "zpi-git-review-"));
  directories.push(path);
  await runGit(path, ["init", "-b", "main"]);
  await runGit(path, ["config", "user.name", "Review Test"]);
  await runGit(path, ["config", "user.email", "review@example.invalid"]);
  await writeFile(join(path, "file.txt"), "original\n");
  await runGit(path, ["add", "."]);
  await runGit(path, ["commit", "-m", "Initial"]);
  return path;
}

test("separates index from working copy and includes literal untracked names without eager patches", async () => {
  const cwd = await repo();
  const path = join(cwd, "file.txt");
  await writeFile(path, "staged\n");
  await runGit(cwd, ["add", "."]);
  await writeFile(path, "working\n");
  const untracked = join(cwd, ":[new]\tfile.txt");
  await writeFile(untracked, "new\nsecond\n");
  const staged = await gitReview(cwd, "staged");
  const unstaged = await gitReview(cwd, "unstaged");
  expect(staged.entries).toMatchObject([{ path, added: 1, removed: 1, patchAvailable: true }]);
  expect(unstaged.entries).toHaveLength(2);
  expect(unstaged.entries.every((entry) => entry.patch === undefined)).toBe(true);
  expect(unstaged.entries.find((entry) => entry.path === untracked)).toMatchObject({
    status: "created",
    added: 2,
    removed: 0,
  });
  expect(await gitReviewDiff(cwd, "staged", path)).toMatchObject({
    patch: expect.stringContaining("-original\n+staged"),
    beforeContent: "original\n",
    afterContent: "staged\n",
    availability: "patch",
  });
  expect(await gitReviewDiff(cwd, "unstaged", path)).toMatchObject({
    patch: expect.stringContaining("-staged\n+working"),
    beforeContent: "staged\n",
    afterContent: "working\n",
    availability: "patch",
  });
  expect((await gitReviewDiff(cwd, "unstaged", untracked)).patch).toContain("+new\n+second");
});

test("preserves renames, deleted files and binary fallbacks", async () => {
  const cwd = await repo();
  await rename(join(cwd, "file.txt"), join(cwd, "renamed.txt"));
  await runGit(cwd, ["add", "-A"]);
  const renamed = (await gitReview(cwd, "staged")).entries[0];
  expect(renamed).toMatchObject({
    path: join(cwd, "renamed.txt"),
    oldPath: join(cwd, "file.txt"),
    status: "renamed",
  });
  expect(await gitReviewDiff(cwd, "staged", renamed.path)).toMatchObject({
    patch: expect.stringContaining("rename from file.txt"),
    beforeContent: "original\n",
    afterContent: "original\n",
  });
  await rm(join(cwd, "renamed.txt"));
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
  await runGit(cwd, ["add", "binary.dat"]);
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 3, 4]));
  const unstaged = (await gitReview(cwd, "unstaged")).entries;
  expect(unstaged.find((entry) => entry.status === "deleted")).toBeDefined();
  expect(unstaged.find((entry) => entry.path.endsWith("binary.dat"))).toMatchObject({
    patchAvailable: false,
    reason: expect.any(String),
  });
});

test("compares upstream merge base to HEAD and keeps subtree scope", async () => {
  const cwd = await repo();
  await runGit(cwd, ["checkout", "-b", "feature"]);
  await runGit(cwd, ["branch", "--set-upstream-to=main"]);
  await mkdir(join(cwd, "nested"));
  await writeFile(join(cwd, "nested", "inside.txt"), "committed\n");
  await writeFile(join(cwd, "outside.txt"), "outside\n");
  await runGit(cwd, ["add", "."]);
  await runGit(cwd, ["commit", "-m", "Feature"]);
  await writeFile(join(cwd, "nested", "inside.txt"), "uncommitted\n");
  const nested = join(cwd, "nested");
  expect((await gitReview(nested, "branch")).entries).toMatchObject([
    { path: join(nested, "inside.txt"), added: 1 },
  ]);
  const diff = await gitReviewDiff(nested, "branch", join(nested, "inside.txt"));
  expect(diff.patch).toContain("+committed");
  expect(diff.patch).not.toContain("uncommitted");
  await expect(gitReviewDiff(nested, "branch", join(cwd, "outside.txt"))).rejects.toThrow("invalid_input");
  await runGit(cwd, ["branch", "--unset-upstream"]);
  expect((await gitReview(cwd, "branch")).entries).toEqual([]);
});

test("returns non-repository state and marks disappeared changes unavailable", async () => {
  const cwd = await repo();
  expect(await gitReviewDiff(cwd, "unstaged", join(cwd, "file.txt"))).toMatchObject({
    availability: "unavailable",
    patch: null,
  });
  await rm(join(cwd, ".git"), { recursive: true });
  expect(await gitReview(cwd, "unstaged")).toEqual({ entries: [], isRepository: false });
});
test("branch renames read the original blob path and ignore later working copy edits", async () => {
  const cwd = await repo();
  await runGit(cwd, ["checkout", "-b", "feature"]);
  await runGit(cwd, ["branch", "--set-upstream-to=main"]);
  const path = join(cwd, "renamed.txt");
  await rename(join(cwd, "file.txt"), path);
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "Rename"]);
  await writeFile(path, "working copy\n");
  expect(await gitReviewDiff(cwd, "branch", path)).toMatchObject({
    availability: "patch",
    beforeContent: "original\n",
    afterContent: "original\n",
  });
});
test("counts hunk lines beginning with diff header characters", () => {
  expect(reviewPatchStats("--- old\n+++ new\n@@ -1 +1 @@\n---old content\n+++new content\n")).toEqual({
    added: 1,
    removed: 1,
  });
});
test("keeps one unresolved merge row and preserves its combined patch for the reference fallback", async () => {
  const cwd = await repo();
  await runGit(cwd, ["checkout", "-b", "feature"]);
  await writeFile(join(cwd, "file.txt"), "feature\n");
  await runGit(cwd, ["commit", "-am", "Feature"]);
  await runGit(cwd, ["checkout", "main"]);
  await writeFile(join(cwd, "file.txt"), "main\n");
  await runGit(cwd, ["commit", "-am", "Main"]);
  await expect(runGit(cwd, ["merge", "feature"])).rejects.toThrow();
  const { entries } = await gitReview(cwd, "unstaged");
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ patchAvailable: true, added: 0, removed: 0, area: "conflicted" });
  expect((await gitReview(cwd, "staged")).entries).toEqual([]);
  expect((await gitReviewDiff(cwd, "unstaged", entries[0].path)).availability).toBe("patch");
});

test("orders tracked, untracked and conflicted sections and excludes unreviewable untracked files", async () => {
  const cwd = await repo();
  await writeFile(join(cwd, "z-tracked.txt"), "initial\n");
  await runGit(cwd, ["add", "."]);
  await runGit(cwd, ["commit", "-m", "Track last path"]);
  await runGit(cwd, ["checkout", "-b", "feature"]);
  await writeFile(join(cwd, "file.txt"), "feature\n");
  await runGit(cwd, ["commit", "-am", "Feature"]);
  await runGit(cwd, ["checkout", "main"]);
  await writeFile(join(cwd, "file.txt"), "main\n");
  await runGit(cwd, ["commit", "-am", "Main"]);
  await expect(runGit(cwd, ["merge", "feature"])).rejects.toThrow();
  await writeFile(join(cwd, "z-tracked.txt"), "modified\n");
  await writeFile(join(cwd, "a-untracked.txt"), "new\n");
  await writeFile(join(cwd, "empty.txt"), "");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1]));
  await writeFile(join(cwd, "oversized.txt"), "x".repeat(1024 * 1024 + 1));
  const { entries } = await gitReview(cwd, "unstaged");
  expect(entries.map((entry) => entry.path)).toEqual([
    join(cwd, "z-tracked.txt"),
    join(cwd, "a-untracked.txt"),
    join(cwd, "file.txt"),
  ]);
});

test("branch status comes from Git for pure additions, removals, empty files and binaries", async () => {
  const cwd = await repo();
  await writeFile(join(cwd, "remove-lines.txt"), "first\nlast\n");
  await writeFile(join(cwd, "delete.txt"), "delete\n");
  await runGit(cwd, ["add", "."]);
  await runGit(cwd, ["commit", "-m", "Base files"]);
  await runGit(cwd, ["checkout", "-b", "feature"]);
  await runGit(cwd, ["branch", "--set-upstream-to=main"]);
  await writeFile(join(cwd, "file.txt"), "original\nadded\n");
  await writeFile(join(cwd, "remove-lines.txt"), "first\n");
  await rm(join(cwd, "delete.txt"));
  await writeFile(join(cwd, "empty.txt"), "");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1]));
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "One-sided edits"]);
  const entries = (await gitReview(cwd, "branch")).entries;
  for (const [name, status, added, removed] of [
    ["file.txt", "modified", 1, 0],
    ["remove-lines.txt", "modified", 0, 1],
    ["delete.txt", "deleted", 0, 1],
    ["empty.txt", "created", 0, 0],
    ["binary.dat", "created", 0, 0],
  ] as const)
    expect(entries.find((entry) => entry.path === join(cwd, name))).toMatchObject({ status, added, removed });
});
