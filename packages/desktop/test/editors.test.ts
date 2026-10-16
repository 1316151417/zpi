import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, nativeImage: {}, shell: {} }));

import { type EditorOpenServices, openWorkspaceEditor } from "../src/main/editors.ts";
import { readEditorPreference, saveEditorPreference } from "../src/renderer/editor-preference-storage.ts";
import { type EditorInfo, selectedEditor, sortEditors } from "../src/shared/editors.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-preferred-editor-"));
  directories.push(dir);
  const path = join(dir, "-file ' $(echo nope) & 中文.ts");
  await writeFile(path, "text");
  return { dir, path };
}
function services(platform = "darwin"): EditorOpenServices & {
  launch: ReturnType<typeof vi.fn<EditorOpenServices["launch"]>>;
  openPath: ReturnType<typeof vi.fn<EditorOpenServices["openPath"]>>;
  reveal: ReturnType<typeof vi.fn<EditorOpenServices["reveal"]>>;
} {
  return {
    platform,
    definitions: [
      { id: "vscode", name: "VS Code", appPath: "/Applications/Visual Studio Code.app", command: "code" },
      { id: "finder", name: "Finder", appPath: "/System/Finder.app", command: null },
      { id: "explorer", name: "Explorer", appPath: "C:/Windows/explorer.exe", command: null },
      { id: "qspace", name: "QSpace", appPath: "/Applications/QSpace.app", command: null },
    ],
    resolveApp: async (def) => def.appPath,
    launch: vi.fn(async () => {}),
    openPath: vi.fn(async () => ""),
    reveal: vi.fn<EditorOpenServices["reveal"]>(),
  };
}
test("passes literal absolute file paths as one CLI argument", async () => {
  const { dir, path } = await fixture();
  const native = services();
  await openWorkspaceEditor(dir, path, "vscode", native);
  expect(native.launch).toHaveBeenCalledExactlyOnceWith("code", [path]);
  expect(native.openPath).not.toHaveBeenCalled();
});
test.each(["darwin", "win32"])(
  "CLI failure falls back to the same selected application on %s",
  async (platform) => {
    const { dir, path } = await fixture();
    const native = services(platform);
    native.launch.mockRejectedValueOnce(new Error("CLI unavailable"));
    await openWorkspaceEditor(dir, path, "vscode", native);
    expect(native.launch).toHaveBeenLastCalledWith(
      platform === "darwin" ? "/usr/bin/open" : "/Applications/Visual Studio Code.app",
      platform === "darwin" ? ["-a", "/Applications/Visual Studio Code.app", path] : [path],
    );
    expect(native.openPath).not.toHaveBeenCalled();
  },
);
test("a failed selected application never silently opens the system default", async () => {
  const { dir, path } = await fixture();
  const native = services();
  native.launch.mockRejectedValue(new Error("launch failed"));
  await expect(openWorkspaceEditor(dir, path, "vscode", native)).rejects.toThrow("launch failed");
  expect(native.openPath).not.toHaveBeenCalled();
});
test.each(["finder", "explorer"])("%s reveals files and opens directories", async (id) => {
  const { dir, path } = await fixture();
  const native = services();
  await openWorkspaceEditor(dir, path, id, native);
  expect(native.reveal).toHaveBeenCalledExactlyOnceWith(path);
  await openWorkspaceEditor(dir, ".", id, native);
  expect(native.openPath).toHaveBeenCalledExactlyOnceWith(dir);
  expect(native.launch).not.toHaveBeenCalled();
});
test("QSpace uses its own app instead of Finder or system default", async () => {
  const { dir, path } = await fixture();
  const native = services();
  await openWorkspaceEditor(dir, path, "qspace", native);
  expect(native.launch).toHaveBeenCalledExactlyOnceWith("/usr/bin/open", [
    "-a",
    "/Applications/QSpace.app",
    path,
  ]);
  expect(native.openPath).not.toHaveBeenCalled();
});
test("rejects arbitrary executable IDs, malformed paths, traversal and symlink escapes before launch", async () => {
  const { dir, path } = await fixture();
  const outside = await fixture();
  const native = services();
  await symlink(outside.dir, join(dir, "outside"));
  await expect(openWorkspaceEditor(dir, path, "/bin/sh", native)).rejects.toThrow("编辑器");
  for (const target of ["", "bad\0name", "../escape", "outside"]) {
    await expect(openWorkspaceEditor(dir, target, "vscode", native)).rejects.toThrow();
  }
  expect(native.launch).not.toHaveBeenCalled();
  expect(native.openPath).not.toHaveBeenCalled();
});
test("rejects unavailable editors", async () => {
  const { dir, path } = await fixture();
  const native = services();
  native.resolveApp = async () => null;
  await expect(openWorkspaceEditor(dir, path, "vscode", native)).rejects.toThrow("未安装");
  expect(native.launch).not.toHaveBeenCalled();
});
test("each open awaits a fresh installation check and rejects an editor removed since the previous open", async () => {
  const { dir, path } = await fixture();
  const native = services();
  const resolveApp = vi
    .fn<EditorOpenServices["resolveApp"]>()
    .mockResolvedValueOnce("/Applications/Visual Studio Code.app")
    .mockResolvedValueOnce(null);
  native.resolveApp = resolveApp;
  await openWorkspaceEditor(dir, path, "vscode", native);
  await expect(openWorkspaceEditor(dir, path, "vscode", native)).rejects.toThrow("未安装");
  expect(resolveApp).toHaveBeenCalledTimes(2);
  expect(native.launch).toHaveBeenCalledTimes(1);
});
const editor = (id: string): EditorInfo => ({ id, name: id, iconDataUrl: "data:image/png;base64,test" });
test("pins file managers in reference order and respects an available preference", () => {
  const installed = ["vscode", "explorer", "qspace-pro", "finder", "cursor", "qspace"].map(editor);
  expect(sortEditors(installed).map((item) => item.id)).toEqual([
    "finder",
    "qspace",
    "qspace-pro",
    "explorer",
    "vscode",
    "cursor",
  ]);
  expect(selectedEditor(installed, "cursor")?.id).toBe("cursor");
  expect(selectedEditor(installed, "uninstalled")?.id).toBe("finder");
  expect(selectedEditor([], "cursor")).toBeNull();
});
test("only explicit preference writes persist; fallback leaves it intact", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  expect(readEditorPreference(storage)).toBeNull();
  saveEditorPreference("cursor", storage);
  expect(selectedEditor([editor("finder")], readEditorPreference(storage))?.id).toBe("finder");
  expect(readEditorPreference(storage)).toBe("cursor");
  expect(selectedEditor([editor("finder"), editor("cursor")], readEditorPreference(storage))?.id).toBe(
    "cursor",
  );
});
test("denied browser storage does not break editor controls", () => {
  const storage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(readEditorPreference(storage)).toBeNull();
  expect(() => saveEditorPreference("cursor", storage)).not.toThrow();
});
