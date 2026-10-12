import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import type { FileLocation } from "zpi-ui/links";

// Launch Services opens IDEs without necessarily opening the requested file.
// Use the default IDE's own launcher, which also supports line navigation.
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

async function launch(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    // Electron/debugger flags belong to ZPI, not to the user's editor.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(command, args, { detached: true, stdio: "ignore", env });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
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
        return `无法使用默认编辑器打开文件：${error instanceof Error ? error.message : String(error)}`;
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
    openDefaultFile(path, location, { platform: process.platform, defaultApplication, launch, openPath });
}
