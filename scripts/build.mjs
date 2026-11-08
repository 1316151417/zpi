import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildAppIcon } from "./app-icon.mjs";
import { cleanDesktopBuild, mainBuild, preloadBuild } from "./desktop-build.mjs";
import { prepareTerminal } from "./prepare-terminal.ts";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
// tsup captures its working directory when imported, including during workspace prepack.
const [{ build }, { build: viteBuild }] = await Promise.all([import("tsup"), import("vite")]);

await cleanDesktopBuild();
await prepareTerminal();
await buildAppIcon();
await Promise.all([
  build({ ...mainBuild, clean: true }),
  build({ ...preloadBuild, clean: true }),
  viteBuild({ configFile: "packages/desktop/vite.config.ts" }),
]);
await cp("licenses/third-party-notices.txt", "packages/desktop/NOTICE");
