import { constants } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { desktopEnvironment, isolateDesktop } from "./desktop-isolation.ts";
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
  const env = desktopEnvironment({ dir, url, project, images });
  let executablePath: string | undefined;
  if (packaged) {
    const source = process.env.ZPI_TEST_PACKAGED_APP || resolve("release/mac-arm64/ZPI.app");
    const bundle = join(dir, basename(source));
    // Keep packaged tests outside the repository so missing dependencies cannot resolve from it.
    await cp(source, bundle, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    executablePath = join(bundle, "Contents", "MacOS", basename(source, ".app"));
  }
  const application = await electron.launch({
    args: packaged ? [] : [resolve("packages/desktop/dist/main/index.js")],
    ...(executablePath ? { executablePath } : {}),
    env,
  });
  try {
    await application.evaluate(isolateDesktop);
  } catch (error) {
    await application.close().catch(() => {});
    throw error;
  }
  return application;
}
