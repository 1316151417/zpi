import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { build as viteBuild } from "vite";
import { buildAppIcon } from "./app-icon.mjs";
import { cleanDesktopBuild, mainBuild, preloadBuild } from "./desktop-build.mjs";
import { prepareTerminal } from "./prepare-terminal.ts";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));

await cleanDesktopBuild();
await prepareTerminal();
await buildAppIcon();
await Promise.all([
  build({ ...mainBuild, clean: true }),
  build({ ...preloadBuild, clean: true }),
  viteBuild({ configFile: "packages/desktop/vite.config.ts" }),
]);
await cp("licenses/third-party-notices.txt", "packages/desktop/NOTICE");
