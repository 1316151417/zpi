import { symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "tsup";
import { launchDesktop } from "./desktop.ts";

export async function launchQuickChatFixture(dir: string, url: string) {
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  await build({
    entry: ["tests/helpers/quick-chat-app.ts"],
    outDir: dir,
    format: ["esm"],
    bundle: true,
    splitting: false,
    target: "node24",
    removeNodeProtocol: false,
    noExternal: ["zpi-ai", "zpi-agent", "zpi-coding-agent", "typebox"],
    external: ["electron", "sharp", "node-pty"],
    silent: true,
    define: { "process.env.ZPI_QUICK_CHAT_FIXTURE_ASSETS": JSON.stringify(resolve("packages/desktop/dist")) },
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  return launchDesktop({ dir, url, entry: join(dir, "quick-chat-app.js") });
}
