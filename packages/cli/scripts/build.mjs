import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import manifest from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  entry: { zpi: `${root}src/cli.ts` },
  outDir: `${root}dist`,
  clean: true,
  bundle: true,
  splitting: true,
  removeNodeProtocol: false,
  format: ["esm"],
  target: "node24",
  external: Object.keys(manifest.dependencies),
  noExternal: [/^@zpi-dev\//],
  define: { ZPI_CLI_VERSION: JSON.stringify(manifest.version) },
});
await copyFile(`${root}../agent-sdk/NOTICE`, `${root}dist/ZPI-NOTICE`);
