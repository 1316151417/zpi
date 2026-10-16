import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { app, nativeImage, shell } from "electron";
import type { EditorInfo } from "../shared/editors.ts";
import {
  type EditorDef,
  getEditorDefsForCurrentPlatform,
  resolveEditorDefAppPath,
} from "./editor-definitions.ts";
import { resolveLocalFilePath } from "./local-file-path.ts";

const exec = promisify(execFile);
let installed: Promise<EditorInfo[]> | undefined;

async function appIcon(path: string): Promise<string | null> {
  if (process.platform === "darwin") {
    let temporary: string | undefined;
    try {
      const { stdout } = await exec("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        join(path, "Contents/Info.plist"),
      ]);
      const plist = JSON.parse(stdout);
      const names = [
        plist.CFBundleIconFile,
        ...(plist.CFBundleIconFiles ?? []),
        ...(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ?? []),
        plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
        plist.CFBundleIconName,
      ].filter((name): name is string => typeof name === "string" && basename(name) === name);
      for (const name of names) {
        for (const filename of name.endsWith(".icns") ? [name] : [name, `${name}.icns`]) {
          const iconPath = join(path, "Contents/Resources", filename);
          if (!(await stat(iconPath).catch(() => null))?.isFile()) continue;
          temporary ??= await mkdtemp(join(tmpdir(), "zpi-editor-icon-"));
          const output = join(temporary, "icon.png");
          await exec("/usr/bin/sips", ["-s", "format", "png", iconPath, "--out", output]);
          const icon = nativeImage.createFromBuffer(await readFile(output));
          if (!icon.isEmpty()) return icon.resize({ width: 32, height: 32 }).toDataURL();
        }
      }
    } catch {
      // 原生 app 图标转换不可用时，与 ZCode 一样回退到系统 file icon。
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
  return app
    .getFileIcon(path, { size: "normal" })
    .then((icon) => icon.toDataURL())
    .catch(() => null);
}

export function getInstalledEditors(): Promise<EditorInfo[]> {
  if (process.env.ZPI_TEST_MODE === "1") return Promise.resolve([]);
  installed ??= Promise.all(
    getEditorDefsForCurrentPlatform().map(async (def) => {
      const path = await resolveEditorDefAppPath(def);
      if (!path) return null;
      const iconDataUrl = await appIcon(path);
      return iconDataUrl ? { id: def.id, name: def.name, iconDataUrl } : null;
    }),
  ).then((entries) => entries.filter((entry): entry is EditorInfo => entry !== null));
  return installed;
}

export interface EditorOpenServices {
  platform: string;
  definitions: EditorDef[];
  resolveApp(definition: EditorDef): Promise<string | null>;
  launch(command: string, args: string[]): Promise<void>;
  openPath(path: string): Promise<string>;
  reveal(path: string): void;
}

export async function openWorkspaceEditor(
  cwd: string,
  target: string,
  editorId: string,
  services: EditorOpenServices,
): Promise<void> {
  if (!target || target.length > 8192 || /[\0\r\n]/.test(target))
    throw new Error("invalid_input: 文件路径无效");
  const definition = services.definitions.find((entry) => entry.id === editorId);
  const appPath = definition && (await services.resolveApp(definition));
  if (!definition || !appPath) throw new Error("invalid_input: 编辑器未安装或不受支持");
  // 复用文件预览的路径边界，renderer 只能指定白名单 ID，不能传入可执行文件或命令参数。
  const path = await resolveLocalFilePath(cwd, target);
  const info = await stat(path);
  if (!info.isFile() && !info.isDirectory()) throw new Error("invalid_input: 仅支持文件及文件夹");
  if (editorId === "finder" || editorId === "explorer") {
    if (info.isFile()) services.reveal(path);
    else {
      const error = await services.openPath(path);
      if (error) throw new Error(error);
    }
    return;
  }
  if (definition.command) {
    try {
      await services.launch(definition.command, [path]);
      return;
    } catch {
      // ZCode 的 CLI 失败回退到同一个应用，不切换到系统默认编辑器。
    }
  }
  await services.launch(
    services.platform === "win32" ? appPath : "/usr/bin/open",
    services.platform === "win32" ? [path] : ["-a", appPath, path],
  );
}

export function openInEditor(cwd: string, path: string, editorId: string): Promise<void> {
  if (process.env.ZPI_TEST_MODE === "1")
    return Promise.reject(new Error("Desktop test blocked external editor launch"));
  return openWorkspaceEditor(cwd, path, editorId, {
    platform: process.platform,
    definitions: getEditorDefsForCurrentPlatform(),
    resolveApp: resolveEditorDefAppPath,
    launch: async (command, args) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      await exec(command, args, { env, windowsHide: true });
    },
    openPath: (target) => shell.openPath(target),
    reveal: (target) => shell.showItemInFolder(target),
  });
}
