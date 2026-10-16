import { afterEach, expect, test, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  icon: vi.fn(),
  definitions: vi.fn(),
  resolveApp: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getFileIcon: fakes.icon },
  nativeImage: {},
  shell: {},
}));
vi.mock("../src/main/editor-definitions.ts", () => ({
  getEditorDefsForCurrentPlatform: fakes.definitions,
  resolveEditorDefAppPath: fakes.resolveApp,
}));
const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetModules();
  vi.resetAllMocks();
});
test("discovery excludes absent applications and missing icons, caching the same safe public records", async () => {
  vi.stubEnv("ZPI_TEST_MODE", "0");
  Object.defineProperty(process, "platform", { value: "win32" });
  fakes.definitions.mockReturnValue([
    { id: "vscode", name: "VS Code", appPath: "C:/Code.exe", command: "code" },
    { id: "missing", name: "Missing", appPath: "C:/Missing.exe", command: null },
    { id: "no-icon", name: "No Icon", appPath: "C:/NoIcon.exe", command: null },
  ]);
  fakes.resolveApp.mockImplementation((def) => (def.id === "missing" ? null : def.appPath));
  fakes.icon.mockImplementation(async (path) => {
    if (path.includes("NoIcon")) throw new Error("No icon");
    return { toDataURL: () => "data:image/png;base64,real-native-icon" };
  });
  const { getInstalledEditors } = await import("../src/main/editors.ts");
  const first = getInstalledEditors();
  const concurrent = getInstalledEditors();
  expect(first).toBe(concurrent);
  expect(await first).toEqual([
    { id: "vscode", name: "VS Code", iconDataUrl: "data:image/png;base64,real-native-icon" },
  ]);
  expect(await getInstalledEditors()).toEqual(await first);
  expect(fakes.definitions).toHaveBeenCalledTimes(1);
  expect(fakes.icon).toHaveBeenCalledTimes(2);
  expect(fakes.icon).toHaveBeenCalledWith("C:/Code.exe", { size: "normal" });
});
test("unsupported platforms with no editor definitions leave controls unavailable", async () => {
  fakes.definitions.mockReturnValue([]);
  const { getInstalledEditors } = await import("../src/main/editors.ts");
  expect(await getInstalledEditors()).toEqual([]);
  expect(fakes.icon).not.toHaveBeenCalled();
});

test("desktop test mode neither discovers native apps nor launches an external editor", async () => {
  vi.stubEnv("ZPI_TEST_MODE", "1");
  const { getInstalledEditors, openInEditor } = await import("../src/main/editors.ts");
  expect(await getInstalledEditors()).toEqual([]);
  await expect(openInEditor("/unused", "/unused", "vscode")).rejects.toThrow("Desktop test blocked");
  expect(fakes.definitions).not.toHaveBeenCalled();
  expect(fakes.icon).not.toHaveBeenCalled();
});
