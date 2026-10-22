import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { gitReview, gitReviewDiff, gitReviewPatch } from "../src/main/git-review.ts";
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
  expect(await gitReviewPatch(cwd, "staged", path)).toContain("-original\n+staged");
  expect(await gitReviewPatch(cwd, "unstaged", path)).toContain("-staged\n+working");
  expect(await gitReviewDiff(cwd, "staged", path)).toMatchObject({
    beforeContent: "original\n",
    afterContent: "staged\n",
    availability: "patch",
  });
  expect(await gitReviewDiff(cwd, "unstaged", path)).toMatchObject({
    beforeContent: "staged\n",
    afterContent: "working\n",
    availability: "patch",
  });
  expect(await gitReviewPatch(cwd, "unstaged", untracked)).toContain("+new\n+second");
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
  expect(await gitReviewPatch(cwd, "staged", renamed.path)).toContain("rename from file.txt");
  await rm(join(cwd, "renamed.txt"));
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
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
  expect(await gitReviewPatch(nested, "branch", join(nested, "inside.txt"))).toContain("+committed");
  expect(await gitReviewPatch(nested, "branch", join(nested, "inside.txt"))).not.toContain("uncommitted");
  await expect(gitReviewPatch(nested, "branch", join(cwd, "outside.txt"))).rejects.toThrow("invalid_input");
  await runGit(cwd, ["branch", "--unset-upstream"]);
  expect((await gitReview(cwd, "branch")).entries).toEqual([]);
});

test("returns non-repository state and rejects disappeared changes", async () => {
  const cwd = await repo();
  await expect(gitReviewPatch(cwd, "unstaged", join(cwd, "file.txt"))).rejects.toThrow("not_found");
  await rm(join(cwd, ".git"), { recursive: true });
  expect(await gitReview(cwd, "unstaged")).toEqual({ entries: [], isRepository: false });
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
  expect(entries[0]).toMatchObject({ patchAvailable: true });
  expect((await gitReviewDiff(cwd, "unstaged", entries[0].path)).availability).toBe("patch");
});
