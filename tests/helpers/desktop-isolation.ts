import { join } from "node:path";

export const automationContract = "zpi-desktop-isolation-v2";

export function desktopEnvironment(
  {
    dir,
    url,
    project,
    images = [],
    interactive = false,
  }: {
    dir: string;
    url: string;
    project?: string;
    images?: string[];
    interactive?: boolean;
  },
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Do not inherit credentials, dev/test switches, shell hooks, proxies or app data overrides.
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "LANG",
    "LC_ALL",
    "TZ",
  ])
    if (inherited[key] !== undefined) env[key] = inherited[key];
  return {
    ...env,
    ZPI_TEST_MODE: "1",
    ZPI_TEST_INTERACTIVE: interactive ? "1" : "0",
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
    SHELL: process.platform === "darwin" ? "/bin/zsh" : "/bin/sh",
    TMPDIR: dir,
    TMP: dir,
    TEMP: dir,
  };
}
