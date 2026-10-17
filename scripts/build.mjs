import { build } from "tsup";
import { build as viteBuild } from "vite";
import { buildAppIcon } from "./app-icon.mjs";
import { mainBuild, preloadBuild } from "./desktop-build.mjs";
import { prepareTerminal } from "./prepare-terminal.ts";

await prepareTerminal();
await buildAppIcon();
await Promise.all([
  build({ ...mainBuild, clean: true }),
  build({ ...preloadBuild, clean: true }),
  viteBuild({ configFile: "packages/desktop/vite.config.ts" }),
]);
