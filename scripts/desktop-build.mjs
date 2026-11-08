import { rm } from "node:fs/promises";

/** Start builds from generated output only, so retired entry points cannot ship again. */
export async function cleanDesktopBuild() {
  await rm(new URL("../packages/desktop/dist/", import.meta.url), { recursive: true, force: true });
}

export const mainBuild = {
  entry: [
    "packages/desktop/src/main/index.ts",
    "packages/desktop/src/main/diff-worker.ts",
    "packages/desktop/src/main/history-worker.ts",
  ],
  outDir: "packages/desktop/dist/main",
  format: ["esm"],
  bundle: true,
  splitting: false,
  sourcemap: true,
  noExternal: [
    "@zpi-dev/ai",
    "@zpi-dev/agent",
    "@zpi-dev/coding-agent",
    "@zpi-dev/builtin-plugins",
    "@zpi-dev/plugin-compat",
    "typebox",
    "openai",
    "ws",
    "https-proxy-agent",
    "socks-proxy-agent",
    "yaml",
    "diff",
    "ignore",
    "bmp-js",
  ],
  external: ["electron", "node-pty", "sharp"],
  target: "node24",
  esbuildOptions(options) {
    options.conditions = [...(options.conditions ?? []), "development"];
  },
  removeNodeProtocol: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
};
export const preloadBuild = {
  entry: ["packages/desktop/src/preload/index.ts"],
  outDir: "packages/desktop/dist/preload",
  format: ["cjs"],
  bundle: true,
  splitting: false,
  sourcemap: true,
  external: ["electron"],
  outExtension: () => ({ js: ".cjs" }),
  target: "node24",
  removeNodeProtocol: false,
};
