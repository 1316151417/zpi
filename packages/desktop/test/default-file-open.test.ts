import { expect, test, vi } from "vitest";
import { editorLaunch, openDefaultFile } from "../src/main/default-file-open.ts";

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

test("association lookup failure falls back; editor launch failures are visible without a misleading retry", async () => {
  const native = services();
  native.defaultApplication.mockRejectedValueOnce(new Error("lookup unavailable"));
  expect(await openDefaultFile("/workspace/Main.java", undefined, native)).toBe("");
  expect(native.openPath).toHaveBeenCalledTimes(1);
  native.launch.mockRejectedValueOnce(new Error("ENOENT"));
  expect(await openDefaultFile("/workspace/Main.java", { line: 3 }, native)).toContain("ENOENT");
  expect(native.openPath).toHaveBeenCalledTimes(1);
});

test("non-macOS opening does not inspect macOS associations or launchers", async () => {
  const native = { ...services(), platform: "win32" };
  await openDefaultFile("C:/workspace/Main.java", { line: 3 }, native);
  expect(native.openPath).toHaveBeenCalledWith("C:/workspace/Main.java");
  expect(native.defaultApplication).not.toHaveBeenCalled();
  expect(native.launch).not.toHaveBeenCalled();
});
