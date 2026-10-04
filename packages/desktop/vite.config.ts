import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
export default defineConfig({
  root: "packages/desktop/src/renderer",
  base: "./",
  plugins: [
    tailwindcss(),
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
  build: { outDir: "../../dist/renderer", emptyOutDir: true, sourcemap: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
