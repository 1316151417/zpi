import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import { afterEach, expect, test, vi } from "vitest";
import { openProjectFromDialog } from "../src/main/project-picker.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zpi-project-picker-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsStore(home, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  const workspace = join(home, "default-workspace");
  const host = new SessionHost(home, settings, home, workspace);
  await host.init();
  cleanup.push(() => host.close());
  const showDialog = vi.fn(
    async (_options: OpenDialogOptions): Promise<OpenDialogReturnValue> => ({
      canceled: true,
      filePaths: [],
    }),
  );
  return { home, workspace, host, settings, showDialog };
}

test("the picker uses the assigned project root, including drafts and worktree tasks", async () => {
  const f = await fixture();
  const projectPath = join(f.home, "project");
  const worktree = join(f.home, "worktree");
  await Promise.all([mkdir(projectPath), mkdir(worktree), mkdir(f.workspace)]);
  const project = await f.host.addProject(projectPath);
  const sessions = [
    await f.host.createSession(project.id),
    await f.host.createSession(project.id, { cwd: worktree }),
    // Synthetic mismatch guards project precedence; normal project drafts already use the project root.
    await f.host.createSession(project.id, { cwd: f.workspace }),
  ];
  for (const session of sessions) {
    const originalCwd = f.host.workspaceInfo(session.id).cwd;
    await openProjectFromDialog(session.id, f.host, f.showDialog, f.home);
    expect(f.showDialog).toHaveBeenLastCalledWith({
      properties: ["openDirectory"],
      defaultPath: projectPath,
    });
    expect(f.host.workspaceInfo(session.id).cwd).toBe(originalCwd);
  }
});

test("a task still bound to a hidden project uses its root without unhiding it", async () => {
  const f = await fixture();
  const projectPath = join(f.home, "hidden-project");
  const worktree = join(f.home, "worktree");
  await Promise.all([mkdir(projectPath), mkdir(worktree)]);
  const project = await f.host.addProject(projectPath);
  const session = await f.host.createSession(project.id, { cwd: worktree });
  f.host.removeProject(project.id);
  await openProjectFromDialog(session.id, f.host, f.showDialog, f.home);
  expect(f.showDialog).toHaveBeenLastCalledWith({ properties: ["openDirectory"], defaultPath: projectPath });
  expect(f.host.listProjects()).toEqual([]);
  expect(f.host.workspaceInfo(session.id).cwd).toBe(worktree);
});

test("restored ordinary project drafts resolve the project root even with a different historical header cwd", async () => {
  const f = await fixture();
  const projectPath = join(f.home, "project");
  await Promise.all([mkdir(projectPath), mkdir(f.workspace)]);
  const project = await f.host.addProject(projectPath);
  const draft = await f.host.createSession(project.id, { cwd: f.workspace });
  const persisted = f.settings.state.getTask(draft.id);
  if (!persisted) throw new Error("Missing task fixture");
  f.settings.state.upsertTask({ ...persisted, cwd: projectPath });
  await f.host.close();
  const restored = new SessionHost(f.home, f.settings, f.home, f.workspace);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.workspaceInfo(draft.id)).toMatchObject({ projectId: project.id, cwd: projectPath });
  await openProjectFromDialog(draft.id, restored, f.showDialog, f.home);
  expect(f.showDialog).toHaveBeenLastCalledWith({ properties: ["openDirectory"], defaultPath: projectPath });
});

test("unassigned tasks retain their actual cwd rather than an unrelated project", async () => {
  const f = await fixture();
  const projectPath = join(f.home, "other-project");
  const customPath = join(f.home, "custom-task");
  await mkdir(projectPath);
  await f.host.addProject(projectPath);
  for (const session of [
    await f.host.createSession(null),
    await f.host.createSession(null, { cwd: customPath }),
  ]) {
    await openProjectFromDialog(session.id, f.host, f.showDialog, f.home);
    expect(f.showDialog).toHaveBeenLastCalledWith({
      properties: ["openDirectory"],
      defaultPath: session.cwd,
    });
  }
});

test("a deleted project root falls back to home rather than a worktree or default workspace", async () => {
  const f = await fixture();
  const projectPath = join(f.home, "deleted-project");
  const worktree = join(f.home, "worktree");
  await Promise.all([mkdir(projectPath), mkdir(worktree)]);
  const project = await f.host.addProject(projectPath);
  const session = await f.host.createSession(project.id, { cwd: worktree });
  await rm(projectPath, { recursive: true });
  await openProjectFromDialog(session.id, f.host, f.showDialog, f.home);
  expect(f.showDialog).toHaveBeenLastCalledWith({ properties: ["openDirectory"], defaultPath: f.home });
  expect(f.host.workspaceInfo(session.id).cwd).toBe(worktree);
});

test("no current task or a stale session falls back to home without creating a default workspace", async () => {
  const f = await fixture();
  for (const id of [null, "missing-session"]) await openProjectFromDialog(id, f.host, f.showDialog, f.home);
  expect(f.showDialog.mock.calls.map(([options]) => options.defaultPath)).toEqual([f.home, f.home]);
  expect(f.host.listRecentSessions()).toEqual([]);
  expect(f.host.listProjects()).toEqual([]);
  expect(existsSync(f.workspace)).toBe(false);
  await openProjectFromDialog(null, f.host, f.showDialog);
  expect(f.showDialog).toHaveBeenLastCalledWith({ properties: ["openDirectory"], defaultPath: homedir() });
});

test("missing, deleted, file and relative cwd candidates fall back to home", async () => {
  const f = await fixture();
  const deleted = join(f.home, "deleted");
  const file = join(f.home, "file.txt");
  await mkdir(deleted);
  await rm(deleted, { recursive: true });
  await writeFile(file, "not a directory");
  const workspaceInfo = vi.spyOn(f.host, "workspaceInfo");
  for (const cwd of [join(f.home, "missing"), deleted, file, ".", "", "invalid\0path"]) {
    workspaceInfo.mockReturnValue({ cwd, home: f.home, projectName: "project", projectId: null });
    await openProjectFromDialog("session", f.host, f.showDialog, f.home);
    expect(f.showDialog).toHaveBeenLastCalledWith({ properties: ["openDirectory"], defaultPath: f.home });
  }
});

test("cancel and empty selections never add a project or task, even with a stale canceled path", async () => {
  const f = await fixture();
  const addProject = vi.spyOn(f.host, "addProject");
  for (const result of [
    { canceled: true, filePaths: [] },
    { canceled: true, filePaths: [f.home] },
    { canceled: false, filePaths: [] },
  ]) {
    f.showDialog.mockResolvedValueOnce(result);
    await expect(openProjectFromDialog(null, f.host, f.showDialog, f.home)).resolves.toBeNull();
  }
  expect(addProject).not.toHaveBeenCalled();
  expect(f.host.listRecentSessions()).toEqual([]);
});

test("only the chosen directory is saved, and native dialog failures propagate", async () => {
  const f = await fixture();
  const chosen = join(f.home, "chosen");
  await mkdir(chosen);
  f.showDialog.mockResolvedValueOnce({ canceled: false, filePaths: [chosen] });
  const project = await openProjectFromDialog(null, f.host, f.showDialog, f.home);
  expect(project?.path).toBe(chosen);
  expect(f.host.listProjects()).toEqual([project]);
  expect(f.host.listRecentSessions()).toEqual([]);
  f.showDialog.mockRejectedValueOnce(new Error("dialog unavailable"));
  await expect(openProjectFromDialog(null, f.host, f.showDialog, f.home)).rejects.toThrow(
    "dialog unavailable",
  );
});
