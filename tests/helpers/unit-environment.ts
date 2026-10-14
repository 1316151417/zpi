import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each isolated test file owns its home and temp files, including shell-tool logs.
export function isolateUnitEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const root = mkdtempSync(join(tmpdir(), "zpi-unit-"));
  const home = join(root, "home");
  const temp = join(root, "tmp");
  mkdirSync(home);
  mkdirSync(temp);
  const overrides: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    ZDOTDIR: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    BASH_ENV: undefined,
    ENV: undefined,
  };
  const original = new Map(Object.keys(overrides).map((key) => [key, env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return {
    root,
    async close() {
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        for (const [key, value] of original) {
          if (value === undefined) delete env[key];
          else env[key] = value;
        }
      }
    },
  };
}
