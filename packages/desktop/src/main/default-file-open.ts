import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FileLocation } from "zpi-ui/links";

// Use the associated IDE's launcher for explicit file/line navigation.
// Keep the system opener as a fallback when that launcher is unavailable.
export function editorLaunch(app: string, path: string, location?: FileLocation) {
  const name = basename(app);
  if (/^(Visual Studio Code(?: - Insiders)?|Cursor|Windsurf)\.app$/i.test(name)) {
    const command = /Insiders/i.test(name)
      ? "code-insiders"
      : /Code/i.test(name)
        ? "code"
        : /Cursor/i.test(name)
          ? "cursor"
          : "windsurf";
    return {
      command: join(app, "Contents", "Resources", "app", "bin", command),
      args: location?.line ? ["--goto", `${path}:${location.line}:${location.column ?? 1}`] : [path],
    };
  }
  const jetbrains =
    /^(IntelliJ IDEA(?: CE)?|PyCharm(?: CE)?|WebStorm|GoLand|CLion|Rider|RubyMine|PhpStorm|DataGrip|RustRover)(?: \d[\w. -]*)?\.app$/i.exec(
      name,
    );
  if (!jetbrains) return undefined;
  const command = /^IntelliJ/i.test(jetbrains[1]) ? "idea" : jetbrains[1].replace(/ CE$/i, "").toLowerCase();
  return {
    command: join(app, "Contents", "MacOS", command),
    args: [...(location?.line ? ["--line", String(location.line)] : []), path],
  };
}

export async function launchEditor(command: string, args: string[], startupGraceMs = 5000): Promise<void> {
  await access(command, constants.X_OK);
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    // Electron/debugger flags belong to ZPI, not to the user's editor.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(command, args, { detached: true, stdio: "ignore", env });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    child.once("error", finish);
    child.once("exit", (code, signal) =>
      finish(code === 0 ? undefined : new Error(`编辑器启动器退出：${signal ?? code}`)),
    );
    child.once("spawn", () => {
      // CLI helpers report their exit status; a newly started IDE may remain alive.
      // Do not wait for the GUI to close, and never kill it on a startup timeout.
      timer = setTimeout(() => finish(), startupGraceMs);
    });
  });
}

interface OpenServices {
  platform: string;
  defaultApplication(path: string): Promise<string>;
  launch(command: string, args: string[]): Promise<void>;
  openPath(path: string): Promise<string>;
}

export async function openDefaultFile(
  path: string,
  location: FileLocation | undefined,
  services: OpenServices,
): Promise<string> {
  if (services.platform === "darwin") {
    // If association lookup is unavailable, retain the usual system opener.
    const app = await services.defaultApplication(path).catch(() => "");
    const target = editorLaunch(app, path, location);
    if (target) {
      try {
        await services.launch(target.command, target.args);
        return "";
      } catch (error) {
        const failure = await services
          .openPath(path)
          .catch((systemError) => String(systemError) || "系统打开异常");
        if (!failure) return "";
        const editorFailure = error instanceof Error ? error.message : String(error);
        return `默认编辑器启动失败：${editorFailure}；系统默认打开也失败：${failure}`;
      }
    }
  }
  return services.openPath(path);
}

export function defaultFileOpener(
  openPath: OpenServices["openPath"],
  defaultApplication: OpenServices["defaultApplication"],
) {
  return (path: string, location?: FileLocation) =>
    openDefaultFile(path, location, {
      platform: process.platform,
      defaultApplication,
      launch: launchEditor,
      openPath,
    });
}
