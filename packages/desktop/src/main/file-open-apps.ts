// Local open-with targets from ZCode editors.ts/openWithEditors.ts (Apache-2.0).
// Keep discovery and process launch behind IPC; no remote/editor orchestration.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, shell } from "electron";
import type { FileOpenApp } from "../shared/bridge.ts";
import { resolveLocalFilePath } from "./local-file-path.ts";

const definitions = [
  ["finder", "Finder", "/System/Library/CoreServices/Finder.app"],
  ["qspace", "QSpace"],
  ["qspace-pro", "QSpace Pro"],
  ["vscode", "VS Code", "/Applications/Visual Studio Code.app"],
  ["vscode-insiders", "VS Code Insiders", "/Applications/Visual Studio Code - Insiders.app"],
  ["cursor", "Cursor"],
  ["trae", "Trae"],
  ["zed", "Zed"],
  ["sublime", "Sublime Text"],
  ["codebuddy", "CodeBuddy"],
  ["qoder", "Qoder"],
  ["idea", "IntelliJ IDEA"],
  ["idea-ce", "IntelliJ IDEA CE"],
  ["webstorm", "WebStorm"],
  ["pycharm", "PyCharm"],
  ["goland", "GoLand"],
  ["phpstorm", "PhpStorm"],
  ["rider", "Rider"],
  ["clion", "CLion"],
  ["rubymine", "RubyMine"],
  ["datagrip", "DataGrip"],
  ["terminal", "Terminal", "/System/Applications/Utilities/Terminal.app"],
  ["iterm2", "iTerm"],
  ["ghostty", "Ghostty"],
  ["warp", "Warp"],
].map(([id, name, path]) => ({ id, name, path: path ?? `/Applications/${name}.app` }));
let cached: Promise<FileOpenApp[]> | undefined;
export function listFileOpenApps(): Promise<FileOpenApp[]> {
  cached ??= (async () => {
    const targets =
      process.platform === "darwin"
        ? definitions
        : process.platform === "win32"
          ? [
              {
                id: "explorer",
                name: "资源管理器",
                path: join(process.env.WINDIR ?? "C:/Windows", "explorer.exe"),
              },
            ]
          : [];
    const found = await Promise.all(
      targets.map(async ({ id, name, path }) => {
        try {
          await stat(path);
          const icon = await app.getFileIcon(path, { size: "normal" });
          return icon.isEmpty() ? null : { id, name, iconDataUrl: icon.toDataURL() };
        } catch {
          return null;
        }
      }),
    );
    return found.filter((entry): entry is FileOpenApp => entry !== null);
  })();
  return cached;
}
export async function openFileWith(cwd: string, target: string, id: string) {
  if (!target || target.length > 8192 || /[\0\r\n]/.test(target))
    throw new Error("invalid_input: 文件路径无效");
  if (!(await listFileOpenApps()).some((item) => item.id === id))
    throw new Error("invalid_input: 打开方式不可用");
  const path = await resolveLocalFilePath(cwd, target);
  if (!(await stat(path)).isFile()) throw new Error("invalid_input: 仅支持文件");
  if (id === "finder" || id === "explorer") {
    shell.showItemInFolder(path);
    return;
  }
  const definition = definitions.find((item) => item.id === id);
  if (!definition || process.platform !== "darwin") throw new Error("invalid_input: 打开方式不可用");
  await promisify(execFile)("/usr/bin/open", ["-a", definition.path, path]);
}
