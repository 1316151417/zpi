import { join } from "node:path";
import type * as Electron from "electron";

export function desktopEnvironment(
  { dir, url, project, images = [] }: { dir: string; url: string; project?: string; images?: string[] },
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (
      value !== undefined &&
      !key.startsWith("ZPI_TEST_") &&
      !["ZPI_DEV_URL", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "BASH_ENV", "ENV"].includes(key)
    )
      env[key] = value;
  }
  return {
    ...env,
    ZPI_TEST_MODE: "1",
    ZPI_TEST_SHOW_WINDOW: inherited.ZPI_TEST_SHOW_WINDOW === "1" ? "1" : "0",
    ZPI_TEST_AUTO_SELECTION: url ? "1" : "0",
    ZPI_TEST_DATA_DIR: dir,
    ZPI_TEST_BASE_URL: url,
    ZPI_TEST_IMAGE_FILES: JSON.stringify(images),
    ...(project ? { ZPI_TEST_PROJECT_DIR: project } : {}),
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: join(dir, "AppData", "Roaming"),
    LOCALAPPDATA: join(dir, "AppData", "Local"),
    XDG_CONFIG_HOME: join(dir, ".config"),
    XDG_DATA_HOME: join(dir, ".local", "share"),
    XDG_CACHE_HOME: join(dir, ".cache"),
    ZDOTDIR: dir,
  };
}

// This function is serialized by Playwright and runs in Electron's main process.
// Keep its implementation self-contained, with no module-scoped dependencies.
export function isolateDesktop({
  app,
  clipboard,
  shell,
}: {
  app: Pick<typeof Electron.app, "getApplicationInfoForProtocol">;
  clipboard: Pick<typeof Electron.clipboard, "readText" | "writeText">;
  shell: Pick<typeof Electron.shell, "openPath" | "openExternal" | "showItemInFolder">;
}): void {
  // Exercise renderer -> preload -> main copying without replacing the user's clipboard.
  const text = new Map<string, string>();
  clipboard.writeText = (value, type = "clipboard") => {
    text.set(type, value);
  };
  clipboard.readText = (type = "clipboard") => text.get(type) ?? "";

  // Tests that exercise native open actions must provide an explicit fake.
  app.getApplicationInfoForProtocol = async () => {
    throw new Error("No default application in desktop tests");
  };
  shell.openPath = async () => {
    throw new Error("Mock shell.openPath in desktop tests");
  };
  shell.openExternal = async () => {
    throw new Error("Mock shell.openExternal in desktop tests");
  };
  shell.showItemInFolder = () => {
    throw new Error("Mock shell.showItemInFolder in desktop tests");
  };
}
