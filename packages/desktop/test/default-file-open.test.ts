import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { editorLaunch, launchEditor, openDefaultFile } from "../src/main/default-file-open.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-editor-launch-"));
  directories.push(dir);
  return dir;
}

function services(app = "/Applications/IntelliJ IDEA.app") {
  return {
    platform: "darwin",
    defaultApplication: vi.fn(async (_path: string) => app),
    launch: vi.fn(async (_command: string, _args: string[]) => {}),
    openPath: vi.fn(async (_path: string) => ""),
  };
}

test("Java files use the associated IntelliJ launcher, with or without a line", async () => {
  const native = services();
  const path = "/workspace/订单 %20 #1.java";
  await openDefaultFile(path, undefined, native);
  expect(native.defaultApplication).toHaveBeenCalledWith(path);
  expect(native.launch).toHaveBeenLastCalledWith("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", [
    path,
  ]);
  await openDefaultFile(path, { line: 80, column: 3 }, native);
  expect(native.launch).toHaveBeenLastCalledWith("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", [
    "--line",
    "80",
    path,
  ]);
  expect(native.openPath).not.toHaveBeenCalled();
});

test("VS Code uses goto with literal paths, line and column; the associated editor is not hardcoded", async () => {
  const native = services("/Applications/Visual Studio Code.app");
  const path = "/workspace/订单 #1.java";
  await openDefaultFile(path, { line: 20, column: 4 }, native);
  expect(native.launch).toHaveBeenCalledWith(
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ["--goto", `${path}:20:4`],
  );
  expect(editorLaunch("/Applications/Visual Studio Code - Insiders.app", path, { line: 2 })).toEqual({
    command: "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
    args: ["--goto", `${path}:2:1`],
  });
});

test("HTML, images, folders and other default apps retain the system opener and its errors", async () => {
  for (const app of ["/Applications/Google Chrome.app", "/System/Applications/Preview.app", ""]) {
    const native = services(app);
    native.openPath.mockResolvedValue("没有可用的默认应用程序");
    expect(await openDefaultFile("/workspace/file.html", { line: 2 }, native)).toBe("没有可用的默认应用程序");
    expect(native.openPath).toHaveBeenCalledWith("/workspace/file.html");
    expect(native.launch).not.toHaveBeenCalled();
  }
});

test("association lookup failure falls back to the system opener", async () => {
  const native = services();
  native.defaultApplication.mockRejectedValueOnce(new Error("lookup unavailable"));
  expect(await openDefaultFile("/workspace/Main.java", undefined, native)).toBe("");
  expect(native.openPath).toHaveBeenCalledWith("/workspace/Main.java");
  expect(native.launch).not.toHaveBeenCalled();
});

test.each(["ENOENT", "EACCES", "编辑器启动器退出：7"])(
  "editor failure (%s) falls back with the literal file path and suppresses the recovered error",
  async (failure) => {
    const native = services();
    native.launch.mockRejectedValueOnce(new Error(failure));
    expect(await openDefaultFile("/workspace/Main.java", { line: 3 }, native)).toBe("");
    expect(native.openPath).toHaveBeenCalledExactlyOnceWith("/workspace/Main.java");
  },
);

test.each([false, true])(
  "both failures are reported, including a rejecting system opener (%s)",
  async (rejects) => {
    const native = services();
    native.launch.mockRejectedValueOnce(new Error("ENOENT"));
    if (rejects) native.openPath.mockRejectedValueOnce(new Error("没有可用的默认应用程序"));
    else native.openPath.mockResolvedValueOnce("没有可用的默认应用程序");
    const failure = await openDefaultFile("/workspace/Main.java", undefined, native);
    expect(failure).toContain("ENOENT");
    expect(failure).toContain("没有可用的默认应用程序");
    expect(native.openPath).toHaveBeenCalledTimes(1);
  },
);

test("an empty system error is still a failed fallback, not a successful open", async () => {
  const native = services();
  native.launch.mockRejectedValueOnce(new Error("ENOENT"));
  native.openPath.mockRejectedValueOnce("");
  expect(await openDefaultFile("/workspace/Main.java", undefined, native)).toContain("系统打开异常");
});

test("launchers must exist and be executable before starting", async () => {
  const dir = await fixture();
  const command = join(dir, "idea");
  await expect(launchEditor(command, [])).rejects.toThrow("ENOENT");
  if (process.platform === "win32") return;
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o600);
  await expect(launchEditor(command, [])).rejects.toThrow("EACCES");
  await writeFile(command, "#!/zpi-missing-interpreter\n");
  await chmod(command, 0o755);
  await expect(launchEditor(command, [])).rejects.toThrow("ENOENT");
});

test("a spawned launcher that exits unsuccessfully is not mistaken for a successful open", async () => {
  await expect(launchEditor(process.execPath, ["-e", "process.exit(7)"])).rejects.toThrow("退出：7");
});

test("successful helpers do not inherit ZPI's Electron and debugger flags", async () => {
  vi.stubEnv("NODE_OPTIONS", "--invalid-debugger-option");
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  await expect(
    launchEditor(process.execPath, [
      "-e",
      "process.exit(process.env.NODE_OPTIONS || process.env.ELECTRON_RUN_AS_NODE ? 1 : 0)",
    ]),
  ).resolves.toBeUndefined();
});

test("a long-lived editor is not killed and opening does not wait for it to close", async () => {
  const marker = join(await fixture(), "completed");
  await launchEditor(
    process.execPath,
    ["-e", "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'done'), 300)", marker],
    20,
  );
  await expect(readFile(marker, "utf8")).rejects.toThrow("ENOENT");
  await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("done"));
});

test("non-macOS opening does not inspect macOS associations or launchers", async () => {
  const native = { ...services(), platform: "win32" };
  await openDefaultFile("C:/workspace/Main.java", { line: 3 }, native);
  expect(native.openPath).toHaveBeenCalledWith("C:/workspace/Main.java");
  expect(native.defaultApplication).not.toHaveBeenCalled();
  expect(native.launch).not.toHaveBeenCalled();
});
