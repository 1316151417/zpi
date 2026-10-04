import { build } from "tsup";
import { build as viteBuild } from "vite";
import { mainBuild, preloadBuild } from "./desktop-build.mjs";

await build({ ...mainBuild, clean: true });
await build({ ...preloadBuild, clean: true });
await viteBuild({ configFile: "packages/desktop/vite.config.ts" });
