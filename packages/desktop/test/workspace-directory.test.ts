import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import {
  ignoredWorkspacePaths,
  readWorkspaceDirectory,
  WorkspaceDirectoryWatchers,
  workspaceGitStatus,
} from "../src/main/workspace-directory.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zpi-directory-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout;
}

test("lists hidden entries, directories first and symlink types without walking children", async () => {
  const cwd = await fixture();
  await mkdir(join(cwd, "z-folder"));
  await writeFile(join(cwd, ".env"), "secret");
  await writeFile(join(cwd, "a.ts"), "code");
  await symlink(join(cwd, "z-folder"), join(cwd, "linked"));
  await symlink(cwd, join(cwd, "z-folder", "cycle"));
  await symlink(join(cwd, "missing"), join(cwd, "broken"));
  const entries = await readWorkspaceDirectory(cwd, cwd);
  expect(entries.map((entry) => entry.name)).toEqual(["linked", "z-folder", ".env", "a.ts"]);
  expect(entries[0]).toMatchObject({ type: "directory", isSymbolicLink: true });
  expect(entries.some((entry) => entry.name === "cycle")).toBe(false);
  for (const path of ["../outside", `${cwd}-outside`, "bad\0path"])
    await expect(readWorkspaceDirectory(cwd, path)).rejects.toThrow("invalid_input");
});

test("Git decorations preserve staged, unstaged, rename, delete, untracked and ignored paths", async () => {
  const cwd = await fixture();
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "test@example.test");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, ".gitignore"), "ignored/\n");
  for (const file of ["edit.ts", "delete.ts", "rename.ts"]) await writeFile(join(cwd, file), "first\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "seed");
  await writeFile(join(cwd, "edit.ts"), "changed\n");
  await rm(join(cwd, "delete.ts"));
  await git(cwd, "mv", "rename.ts", "renamed.ts");
  await writeFile(join(cwd, "added.ts"), "added\n");
  await git(cwd, "add", "added.ts");
  await mkdir(join(cwd, "nested"));
  await writeFile(join(cwd, "nested", "new.ts"), "new");
  await mkdir(join(cwd, "ignored"));
  await writeFile(join(cwd, "ignored", "data.txt"), "ignored");
  const result = await workspaceGitStatus(cwd);
  expect(result.summary.isRepository).toBe(true);
  expect(result.stagedChanges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: join(cwd, "added.ts"), kind: "added" }),
      expect.objectContaining({ path: join(cwd, "renamed.ts"), kind: "renamed" }),
    ]),
  );
  expect(result.unstagedChanges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: join(cwd, "edit.ts"), kind: "modified" }),
      expect.objectContaining({ path: join(cwd, "delete.ts"), kind: "deleted" }),
      expect.objectContaining({ path: join(cwd, "nested", "new.ts"), kind: "untracked" }),
    ]),
  );
  expect((await workspaceGitStatus(join(cwd, "nested"))).unstagedChanges).toEqual([
    expect.objectContaining({ path: join(cwd, "nested", "new.ts") }),
  ]);
  expect(await ignoredWorkspacePaths(cwd, [join(cwd, "ignored"), join(cwd, "edit.ts")])).toEqual([
    join(cwd, "ignored"),
  ]);
  expect(await ignoredWorkspacePaths(cwd, [])).toEqual([]);
});

test("non-repository workspaces do not offer Git filtering", async () => {
  expect((await workspaceGitStatus(await fixture())).summary.isRepository).toBe(false);
});

test("directory watches emit changes and release collapsed and closed registrations", async () => {
  const cwd = await fixture();
  const events = vi.fn();
  const watchers = new WorkspaceDirectoryWatchers(events);
  cleanups.push(() => watchers.close());
  const { id } = watchers.watch(cwd, cwd);
  await writeFile(join(cwd, "new.ts"), "new");
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith(id, cwd));
  watchers.unwatch(id);
  events.mockClear();
  await writeFile(join(cwd, "after-close.ts"), "closed");
  expect(Reflect.get(watchers, "watchers").size).toBe(0);
  expect(events).not.toHaveBeenCalled();
  watchers.watch(cwd, cwd);
  watchers.close();
  expect(Reflect.get(watchers, "watchers").size).toBe(0);
});
test("recursive review watches observe edits beneath already expanded workspace subdirectories", async () => {
  const cwd = await fixture();
  await mkdir(join(cwd, "nested"));
  const path = join(cwd, "nested", "inside.ts");
  await writeFile(path, "old");
  const changed = vi.fn();
  const watchers = new WorkspaceDirectoryWatchers(changed);
  cleanups.push(() => watchers.close());
  const { id } = watchers.watch(cwd, cwd, true);
  await writeFile(path, "next");
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(id, cwd));
  watchers.unwatch(id);
  expect(Reflect.get(watchers, "watchers").size).toBe(0);
});

test("unassigned drafts allocate unique workspace directories, persist them and retain explicit inherited cwd", async () => {
  const home = await fixture();
  const settings = new SettingsStore(join(home, "storage"), {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  const host = new SessionHost(join(home, "storage"), settings, home);
  cleanups.push(() => host.close());
  await host.init();
  const first = host.createSession(null),
    second = host.createSession(null);
  expect(first.cwd).toBe(join(home, ".zpi", "workspace", `draft-${first.id}`));
  expect(second.cwd).toBe(join(home, ".zpi", "workspace", `draft-${second.id}`));
  expect(host.listProjects()).toEqual([]);
  await writeFile(join(String(first.cwd), "keep.txt"), "first draft data");
  expect(host.createSession(null, { cwd: first.cwd, parentSessionId: first.id }).cwd).toBe(first.cwd);
  await host.close();
  const restarted = new SessionHost(join(home, "storage"), settings, home);
  cleanups.push(() => restarted.close());
  await restarted.init();
  expect(restarted.workspaceInfo(first.id).cwd).toBe(first.cwd);
  const moved = join(home, "moved-draft");
  await rename(String(first.cwd), moved);
  expect(restarted.workspaceInfo(first.id).cwd).toBe(first.cwd);
  await expect(readWorkspaceDirectory(String(first.cwd), String(first.cwd))).rejects.toThrow();
});
