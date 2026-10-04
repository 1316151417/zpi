import { constants } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
export async function launchDesktop({
  dir,
  url,
  project,
  images = [],
  packaged = false,
}: {
  dir: string;
  url: string;
  project?: string;
  images?: string[];
  packaged?: boolean;
}) {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    ZPI_TEST_MODE: "1",
    ZPI_TEST_AUTO_SELECTION: url ? "1" : "0",
    ZPI_TEST_DATA_DIR: dir,
    ZPI_TEST_BASE_URL: url,
    ZPI_TEST_IMAGE_FILES: JSON.stringify(images),
    ZDOTDIR: dir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ZPI_TEST_PROJECT_DIR;
  if (project) env.ZPI_TEST_PROJECT_DIR = project;
  let executablePath: string | undefined;
  if (packaged) {
    const source = process.env.ZPI_TEST_PACKAGED_APP || resolve("release/mac-arm64/zpi.app");
    const bundle = join(dir, basename(source));
    // Keep packaged tests outside the repository so missing dependencies cannot resolve from it.
    await cp(source, bundle, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    executablePath = join(bundle, "Contents", "MacOS", basename(source, ".app"));
  }
  return electron.launch({
    args: packaged ? [] : [resolve("packages/desktop/dist/main/index.js")],
    ...(executablePath ? { executablePath } : {}),
    env,
  });
}
