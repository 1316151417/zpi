import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { pdfAssetsPlugin } from "./pdf-assets-plugin.ts";
export default defineConfig({
  root: "packages/desktop/src/renderer",
  base: "./",
  plugins: [
    tailwindcss(),
    pdfAssetsPlugin(),
    {
      name: "zpi-original-icon",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/icon.png") return next();
          res.setHeader("Content-Type", "image/png");
          res.end(readFileSync(resolve("icon.png")));
        });
      },
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "icon.png", source: readFileSync(resolve("icon.png")) });
      },
    },
  ],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: [
        resolve("packages/desktop/src/renderer/index.html"),
        resolve("packages/desktop/src/renderer/quick-chat.html"),
      ],
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  worker: {
    format: "es",
    plugins: () => [
      {
        name: "zpi-diff-worker-entry",
        enforce: "pre",
        async resolveId(source, importer) {
          if (source !== "@pierre/diffs/worker/worker.js") return;
          // 此依赖的 sideEffects 清单漏掉了 worker 入口；否则构建会输出 0 字节 worker，Diff 永远空白。
          const resolved = await this.resolve(source, importer, { skipSelf: true });
          return resolved ? { ...resolved, moduleSideEffects: true } : undefined;
        },
      },
    ],
  },
});
