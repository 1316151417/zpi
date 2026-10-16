import { win32 as path } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  exec: vi.fn(),
  execSync: vi.fn(() => {
    throw new Error("Synchronous process launch is forbidden");
  }),
  exists: vi.fn(),
  readdir: vi.fn(),
  icon: vi.fn(async () => ({ toDataURL: () => "data:image/png;base64,icon" })),
}));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: fakes.exec }),
  execFileSync: fakes.execSync,
}));
vi.mock("node:fs", () => ({ existsSync: fakes.exists, readdirSync: fakes.readdir }));
vi.mock("electron", () => ({ app: { getFileIcon: fakes.icon }, nativeImage: {}, shell: {} }));

import {
  type EditorDef,
  getEditorDefsForCurrentPlatform,
  resolveEditorDefAppPath,
} from "../src/main/editor-definitions.ts";

const originalPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("ZPI_TEST_MODE", "0");
  vi.stubEnv("SystemDrive", "C:");
  vi.stubEnv("ProgramFiles", "C:\\Program Files");
  vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
  vi.stubEnv("LOCALAPPDATA", "C:\\Isolated\\Local");
  fakes.exists.mockReturnValue(false);
  fakes.readdir.mockReturnValue([]);
  fakes.exec.mockResolvedValue({ stdout: "" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetAllMocks();
  vi.resetModules();
});

const definition: EditorDef = {
  id: "vscode",
  name: "VS Code",
  appPath: "C:\\Preferred\\Code.exe",
  appPathCandidates: ["C:\\Alternate\\Code.exe"],
  command: "code",
  windowsCommandAppNames: ["Code.exe"],
};
const shim = "C:\\PathFirst\\bin\\code.cmd";
const derived = "C:\\PathFirst\\Code.exe";

test("asynchronous PATH probes preserve explicit candidates, shim output and app-root priority", async () => {
  const secondShim = "C:\\PathSecond\\bin\\code.cmd";
  const binApp = "C:\\PathFirst\\bin\\Code.exe";
  const candidates = [
    definition.appPath,
    ...(definition.appPathCandidates ?? []),
    binApp,
    derived,
    "C:\\PathSecond\\Code.exe",
  ];
  const available = new Set([shim, secondShim, ...candidates]);
  fakes.exists.mockImplementation((value) => available.has(value));
  fakes.exec.mockResolvedValue({ stdout: ` ${shim} \r\n\r\n${secondShim}\r\nC:\\Missing\\code.cmd\n` });
  for (const candidate of candidates) {
    expect(await resolveEditorDefAppPath(definition)).toBe(candidate);
    available.delete(candidate);
  }
  expect(await resolveEditorDefAppPath(definition)).toBeNull();
  expect(fakes.exec).toHaveBeenCalledWith("where.exe", ["code"], {
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true,
  });
  expect(fakes.execSync).not.toHaveBeenCalled();
});

test("all independent editor probes start before any completes, yielding while retaining definition order", async () => {
  const completions = new Map<string, (value: { stdout: string }) => void>();
  fakes.exec.mockImplementation(
    (_command, [name]) => new Promise((resolve) => completions.set(name, resolve)),
  );
  fakes.exists.mockReturnValue(true);
  fakes.icon.mockResolvedValue({ toDataURL: () => "data:image/png;base64,icon" });
  const { getInstalledEditors } = await import("../src/main/editors.ts");
  const pending = getInstalledEditors();
  expect([...completions.keys()]).toEqual(["code", "code-insiders", "cursor"]);
  // The event loop remains available while the mocked process callbacks are pending.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  completions.get("cursor")?.({ stdout: "" });
  completions.get("code-insiders")?.({ stdout: "" });
  completions.get("code")?.({ stdout: "" });
  expect((await pending).map((entry) => entry.id)).toEqual([
    "explorer",
    "vscode",
    "vscode-insiders",
    "cursor",
    "trae",
  ]);
  expect(fakes.execSync).not.toHaveBeenCalled();
});

test("failed or timed-out PATH probes retain installed-path fallback and absent-app behavior", async () => {
  fakes.exec.mockRejectedValue(new Error("timeout"));
  fakes.exists.mockImplementation((value) => value === definition.appPath);
  expect(await resolveEditorDefAppPath(definition)).toBe(definition.appPath);
  fakes.exists.mockReturnValue(false);
  expect(await resolveEditorDefAppPath(definition)).toBeNull();
});

test("command-only definitions retain PATH order and macOS never probes Windows commands", async () => {
  fakes.exec.mockResolvedValue({ stdout: `${shim}\n${derived}` });
  fakes.exists.mockReturnValue(true);
  expect(
    await resolveEditorDefAppPath({
      ...definition,
      appPath: "",
      appPathCandidates: [],
      windowsCommandAppNames: [],
    }),
  ).toBe(shim);
  fakes.exec.mockClear();
  Object.defineProperty(process, "platform", { value: "darwin" });
  expect(await resolveEditorDefAppPath(definition)).toBe(definition.appPath);
  expect(fakes.exec).not.toHaveBeenCalled();
});

test("JetBrains roots are enumerated once per build, keeping root and descending-version order without stale cache", () => {
  const firstRoot = "C:\\Program Files\\JetBrains";
  const entry = (name: string, directory = true) => ({ name, isDirectory: () => directory });
  fakes.readdir.mockImplementation((root) => {
    if (root === firstRoot)
      return [
        entry("WebStorm 2024"),
        entry("WebStorm 2025"),
        entry("IntelliJ IDEA 2025"),
        entry("WebStorm 2026", false),
      ];
    if (root.includes("(x86)")) return [entry("WebStorm 2026")];
    throw new Error("Missing optional root");
  });
  const defs = getEditorDefsForCurrentPlatform();
  expect(fakes.readdir).toHaveBeenCalledTimes(3);
  const webstorm = defs.find((def) => def.id === "webstorm");
  expect(webstorm).toBeDefined();
  expect([webstorm?.appPath, ...(webstorm?.appPathCandidates ?? [])]).toEqual([
    path.join(firstRoot, "WebStorm 2025", "bin", "webstorm64.exe"),
    path.join(firstRoot, "WebStorm 2024", "bin", "webstorm64.exe"),
    "C:\\Program Files (x86)\\JetBrains\\WebStorm 2026\\bin\\webstorm64.exe",
  ]);
  fakes.readdir.mockReturnValue([]);
  expect(getEditorDefsForCurrentPlatform().find((def) => def.id === "webstorm")?.appPath).toBe("");
  expect(fakes.readdir).toHaveBeenCalledTimes(6);
});
