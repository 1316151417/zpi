// Adapted from ZCode main/editors.ts; see THIRD_PARTY_NOTICES.md.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { win32 as pathWin32 } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const WINDOWS_EXPLORER_PATH = pathWin32.join(process.env.WINDIR ?? "C:/Windows", "explorer.exe");

export interface EditorDef {
  id: string;
  name: string;
  /** macOS .app bundle 路径 */
  appPath: string;
  appPathCandidates?: string[];
  windowsCommandAppNames?: string[];
  /** CLI 命令名（如果有）。用于 open folder；null 则 fallback 到 `open -a` */
  command: string | null;
}

const MAC_EDITOR_DEFS: EditorDef[] = [
  // 代码编辑器
  {
    id: "vscode",
    name: "VS Code",
    appPath: "/Applications/Visual Studio Code.app",
    command: "code",
  },
  // 这里之前只登记了稳定版 VS Code，`getInstalledEditors()` 又完全依赖这份静态白名单做 existsSync 过滤。
  // 用户安装的是 `Visual Studio Code - Insiders.app` 时，主进程根本不会把它纳入候选列表，UI 自然也就显示不出来。
  // 补上独立定义后，既能识别 Insiders，也能复用现有的 `code-insiders` CLI / `open -a` 降级打开链路。
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    appPath: "/Applications/Visual Studio Code - Insiders.app",
    command: "code-insiders",
  },
  { id: "cursor", name: "Cursor", appPath: "/Applications/Cursor.app", command: "cursor" },
  { id: "trae", name: "Trae", appPath: "/Applications/Trae.app", command: null },
  { id: "zed", name: "Zed", appPath: "/Applications/Zed.app", command: "zed" },
  {
    id: "sublime",
    name: "Sublime Text",
    appPath: "/Applications/Sublime Text.app",
    command: "subl",
  },
  { id: "codebuddy", name: "CodeBuddy", appPath: "/Applications/CodeBuddy.app", command: null },
  { id: "qoder", name: "Qoder", appPath: "/Applications/Qoder.app", command: null },
  // JetBrains 系列
  {
    id: "idea",
    name: "IntelliJ IDEA",
    appPath: "/Applications/IntelliJ IDEA.app",
    command: "idea",
  },
  {
    id: "idea-ce",
    name: "IntelliJ IDEA CE",
    appPath: "/Applications/IntelliJ IDEA CE.app",
    command: "idea",
  },
  { id: "webstorm", name: "WebStorm", appPath: "/Applications/WebStorm.app", command: "webstorm" },
  { id: "pycharm", name: "PyCharm", appPath: "/Applications/PyCharm.app", command: "pycharm" },
  { id: "goland", name: "GoLand", appPath: "/Applications/GoLand.app", command: "goland" },
  { id: "phpstorm", name: "PhpStorm", appPath: "/Applications/PhpStorm.app", command: "phpstorm" },
  { id: "rider", name: "Rider", appPath: "/Applications/Rider.app", command: "rider" },
  { id: "clion", name: "CLion", appPath: "/Applications/CLion.app", command: "clion" },
  { id: "rubymine", name: "RubyMine", appPath: "/Applications/RubyMine.app", command: "rubymine" },
  { id: "datagrip", name: "DataGrip", appPath: "/Applications/DataGrip.app", command: "datagrip" },
  // 终端（macOS 新版系统 Terminal 在 /System/Applications 下）
  {
    id: "terminal",
    name: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    command: null,
  },
  { id: "iterm2", name: "iTerm", appPath: "/Applications/iTerm.app", command: null },
  { id: "ghostty", name: "Ghostty", appPath: "/Applications/Ghostty.app", command: null },
  { id: "warp", name: "Warp", appPath: "/Applications/Warp.app", command: null },
  // 文件管理器
  {
    id: "finder",
    name: "Finder",
    appPath: "/System/Library/CoreServices/Finder.app",
    command: null,
  },
  // 功能扩展：QSpace / QSpace Pro 是 macOS 第三方文件管理器，默认没有 CLI，复用 open -a app bundle 打开路径。
  {
    id: "qspace",
    name: "QSpace",
    appPath: "/Applications/QSpace.app",
    command: null,
  },
  {
    id: "qspace-pro",
    name: "QSpace Pro",
    appPath: "/Applications/QSpace Pro.app",
    command: null,
  },
];

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)),
  );
}

function getWindowsProgramFilesRoots(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  return uniquePaths([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ]);
}

function getWindowsLocalProgramsRoot(): string {
  const systemDrive = process.env.SystemDrive || "C:";
  return pathWin32.join(
    process.env.LOCALAPPDATA || `${systemDrive}\\Users\\Default\\AppData\\Local`,
    "Programs",
  );
}

function windowsLocalProgramCandidate(...segments: string[]): string {
  return pathWin32.join(getWindowsLocalProgramsRoot(), ...segments);
}

function windowsProgramFilesCandidates(...segments: string[]): string[] {
  return getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, ...segments));
}

function findWindowsJetBrainsDirectories(): string[] {
  const roots = uniquePaths([
    ...getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, "JetBrains")),
    pathWin32.join(getWindowsLocalProgramsRoot(), "JetBrains"),
  ]);
  const directories: string[] = [];
  for (const root of roots) {
    try {
      const entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));
      directories.push(...entries.map((entry) => pathWin32.join(root, entry)));
    } catch {
      // JetBrains products are optional; missing roots are expected.
    }
  }
  return directories;
}

function findWindowsJetBrainsExecutableCandidates(
  directories: string[],
  productDirPrefix: string,
  executableName: string,
): string[] {
  return directories
    .filter((directory) =>
      pathWin32.basename(directory).toLowerCase().startsWith(productDirPrefix.toLowerCase()),
    )
    .map((directory) => pathWin32.join(directory, "bin", executableName));
}

function createWindowsEditorDef(
  id: string,
  name: string,
  appPathCandidates: string[],
  command: string | null = null,
  windowsCommandAppNames: string[] = [],
): EditorDef {
  const candidates = uniquePaths(appPathCandidates);
  return {
    id,
    name,
    appPath: candidates[0] ?? "",
    appPathCandidates: candidates.slice(1),
    windowsCommandAppNames,
    command,
  };
}

async function resolveWindowsCommandPaths(command: string): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const { stdout: output } = await exec("where.exe", [command], {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

async function deriveWindowsAppPathsFromCommand(command: string, appNames: string[]): Promise<string[]> {
  const candidates: string[] = [];

  for (const commandPath of await resolveWindowsCommandPaths(command)) {
    const commandDir = pathWin32.dirname(commandPath);
    for (const appRoot of uniquePaths([commandDir, pathWin32.dirname(commandDir)])) {
      for (const appName of appNames) {
        candidates.push(pathWin32.join(appRoot, appName));
      }
    }
  }

  // Windows PATH 常见的是 bin\code.cmd 这类 shim，真实 exe 才能提供和 mac 一致的应用图标。
  return uniquePaths(candidates).filter((candidate) => existsSync(candidate));
}

const WINDOWS_EDITOR_DEFS: EditorDef[] = [
  // Workspace 顶部“Open in Editor”以前只把真正的 IDE 暴露给 UI，
  // Windows 用户缺少最基础的“在资源管理器里打开”入口，只能回到其它菜单操作。
  // 这里把系统文件管理器也作为 editor 列表的一员，让 macOS Finder / Windows 资源管理器体验对齐。
  { id: "explorer", name: "资源管理器", appPath: WINDOWS_EXPLORER_PATH, command: null },
];

function windowsAdditionalEditorDefs(): EditorDef[] {
  const jetBrainsDirectories = findWindowsJetBrainsDirectories();
  return [
    createWindowsEditorDef(
      "vscode",
      "VS Code",
      [
        windowsLocalProgramCandidate("Microsoft VS Code", "Code.exe"),
        ...windowsProgramFilesCandidates("Microsoft VS Code", "Code.exe"),
      ],
      "code",
      ["Code.exe"],
    ),
    createWindowsEditorDef(
      "vscode-insiders",
      "VS Code Insiders",
      [
        windowsLocalProgramCandidate("Microsoft VS Code Insiders", "Code - Insiders.exe"),
        ...windowsProgramFilesCandidates("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      ],
      "code-insiders",
      ["Code - Insiders.exe"],
    ),
    createWindowsEditorDef(
      "cursor",
      "Cursor",
      [
        windowsLocalProgramCandidate("Cursor", "Cursor.exe"),
        ...windowsProgramFilesCandidates("Cursor", "Cursor.exe"),
      ],
      "cursor",
      ["Cursor.exe"],
    ),
    createWindowsEditorDef("trae", "Trae", [
      windowsLocalProgramCandidate("Trae", "Trae.exe"),
      windowsLocalProgramCandidate("Trae CN", "Trae.exe"),
      windowsLocalProgramCandidate("Trae CN", "Trae CN.exe"),
      ...windowsProgramFilesCandidates("Trae", "Trae.exe"),
      ...windowsProgramFilesCandidates("Trae CN", "Trae.exe"),
      ...windowsProgramFilesCandidates("Trae CN", "Trae CN.exe"),
    ]),
    createWindowsEditorDef("idea", "IntelliJ IDEA", [
      ...findWindowsJetBrainsExecutableCandidates(jetBrainsDirectories, "IntelliJ IDEA", "idea64.exe"),
    ]),
    createWindowsEditorDef("webstorm", "WebStorm", [
      ...findWindowsJetBrainsExecutableCandidates(jetBrainsDirectories, "WebStorm", "webstorm64.exe"),
    ]),
    createWindowsEditorDef("pycharm", "PyCharm", [
      ...findWindowsJetBrainsExecutableCandidates(jetBrainsDirectories, "PyCharm", "pycharm64.exe"),
    ]),
    createWindowsEditorDef("goland", "GoLand", [
      ...findWindowsJetBrainsExecutableCandidates(jetBrainsDirectories, "GoLand", "goland64.exe"),
    ]),
    createWindowsEditorDef("clion", "CLion", [
      ...findWindowsJetBrainsExecutableCandidates(jetBrainsDirectories, "CLion", "clion64.exe"),
    ]),
  ];
}

export function getEditorDefsForCurrentPlatform(): EditorDef[] {
  if (process.platform === "darwin") {
    return MAC_EDITOR_DEFS;
  }

  if (process.platform === "win32") {
    return [...WINDOWS_EDITOR_DEFS, ...windowsAdditionalEditorDefs()];
  }

  return [];
}

/** Recheck availability on every resolution, including each open request. */
export async function resolveEditorDefAppPath(def: EditorDef): Promise<string | null> {
  const commandAppPaths =
    def.command && def.windowsCommandAppNames?.length
      ? await deriveWindowsAppPathsFromCommand(def.command, def.windowsCommandAppNames)
      : [];
  const commandPaths =
    process.platform === "win32" && def.windowsCommandAppNames?.length
      ? []
      : def.command
        ? await resolveWindowsCommandPaths(def.command)
        : [];
  const candidatePaths = uniquePaths([
    def.appPath,
    ...(def.appPathCandidates ?? []),
    ...commandAppPaths,
    ...commandPaths,
  ]);
  return candidatePaths.find((candidate) => existsSync(candidate)) ?? null;
}
