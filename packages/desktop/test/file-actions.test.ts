import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveLinkTarget } from "zpi-ui/links";
import { performFileAction } from "../src/main/file-actions.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-file-actions-")));
  directories.push(dir);
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const services = {
    openPath: vi.fn(async (_path: string) => ""),
    showItemInFolder: vi.fn((_path: string) => {}),
    writeText: vi.fn((_text: string) => {}),
  };
  return { dir, cwd, services };
}

test("default opening and Finder reveal receive literal file paths and propagate system errors", async () => {
  const { cwd, services } = await fixture();
  const name = "订单 %20 #1.txt";
  const path = join(cwd, name);
  await writeFile(path, "text");
  await performFileAction(cwd, name, "open", services);
  expect(services.openPath).toHaveBeenCalledWith(path);
  expect(services.showItemInFolder).not.toHaveBeenCalled();
  await performFileAction(cwd, path, "reveal", services);
  expect(services.showItemInFolder).toHaveBeenCalledWith(path);
  expect(services.openPath).toHaveBeenCalledTimes(1);
  services.openPath.mockResolvedValueOnce("没有可用的默认应用程序");
  await expect(performFileAction(cwd, path, "open", services)).rejects.toThrow("没有可用的默认应用程序");
});

test("copying paths is relative to the session workspace, including absolute paths outside it and removed files", async () => {
  const { dir, cwd, services } = await fixture();
  const path = join(cwd, "src", "removed.txt");
  await performFileAction(cwd, "src/removed.txt", "copy-absolute", services);
  expect(services.writeText).toHaveBeenLastCalledWith(path);
  await performFileAction(cwd, path, "copy-relative", services);
  expect(services.writeText).toHaveBeenLastCalledWith(join("src", "removed.txt"));
  const outside = join(dir, "outside.txt");
  await performFileAction(cwd, outside, "copy-relative", services);
  expect(services.writeText).toHaveBeenLastCalledWith(relative(cwd, outside));
  expect(services.openPath).not.toHaveBeenCalled();
  expect(services.showItemInFolder).not.toHaveBeenCalled();
});

test("folders open in Finder rather than revealing their parent, including paths with special characters", async () => {
  const { cwd, services } = await fixture();
  const folder = join(cwd, "资料 %20 #1");
  await mkdir(folder);
  await performFileAction(cwd, "资料 %20 #1", "reveal", services);
  expect(services.openPath).toHaveBeenLastCalledWith(folder);
  expect(services.showItemInFolder).not.toHaveBeenCalled();
  await performFileAction(cwd, folder, "open", services);
  expect(services.openPath).toHaveBeenCalledTimes(2);
  await performFileAction(cwd, folder, "copy-absolute", services);
  expect(services.writeText).toHaveBeenLastCalledWith(folder);
  await performFileAction(cwd, folder, "copy-relative", services);
  expect(services.writeText).toHaveBeenLastCalledWith("资料 %20 #1");
  await performFileAction(cwd, cwd, "copy-relative", services);
  expect(services.writeText).toHaveBeenLastCalledWith(".");
  services.openPath.mockResolvedValueOnce("无法打开 Finder");
  await expect(performFileAction(cwd, folder, "reveal", services)).rejects.toThrow("无法打开 Finder");
});

test("invalid actions, missing files and escaping relative paths never reach the system shell", async () => {
  const { dir, cwd, services } = await fixture();
  await writeFile(join(dir, "outside.txt"), "outside");
  await symlink(join(dir, "outside.txt"), join(cwd, "escape.txt"));
  await symlink(dir, join(cwd, "escape-folder"));
  for (const [path, action] of [
    ["", "open"],
    ["invalid\0path", "reveal"],
    ["file.txt", "unknown"],
    ["../outside.txt", "open"],
    ["../outside.txt", "copy-absolute"],
    ["escape.txt", "reveal"],
    ["escape-folder", "reveal"],
    ["missing.txt", "open"],
  ])
    await expect(performFileAction(cwd, path, action, services)).rejects.toThrow();
  expect(services.openPath).not.toHaveBeenCalled();
  expect(services.showItemInFolder).not.toHaveBeenCalled();
  expect(services.writeText).not.toHaveBeenCalled();
});

test("resolved Markdown links retain their relative boundary for Finder actions", async () => {
  const { dir, cwd, services } = await fixture();
  const outside = join(dir, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, join(cwd, "escape.txt"));
  const target = resolveLinkTarget("./escape.txt", { cwd });
  if (target?.kind !== "file") throw new Error("file target");
  const { kind: _kind, path, ...location } = target;
  await expect(performFileAction(cwd, path, "reveal", services, location)).rejects.toThrow("超出");
  expect(services.showItemInFolder).not.toHaveBeenCalled();
  await performFileAction(cwd, path, "reveal", services);
  expect(services.showItemInFolder).toHaveBeenCalledWith(path);
  await expect(performFileAction(cwd, path, "reveal", services, { relative: "yes" })).rejects.toThrow();
});
