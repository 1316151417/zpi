import { readdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Plugin } from "vite";

// Keep PDF fonts, CMaps and decoders local in development and packaged builds.
export function pdfAssetsPlugin(): Plugin {
  const root = resolve("node_modules/pdfjs-dist");
  const directories = ["cmaps", "standard_fonts", "wasm"];
  return {
    name: "zpi-pdf-assets",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split("?")[0];
        if (!pathname?.startsWith("/pdfjs/")) return next();
        const relative = pathname.slice("/pdfjs/".length);
        if (!directories.includes(relative.split("/")[0] ?? "")) return next();
        const path = resolve(root, relative);
        if (!path.startsWith(`${root}${sep}`)) return next();
        try {
          res.setHeader(
            "Content-Type",
            path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
          );
          res.end(await readFile(path));
        } catch {
          next();
        }
      });
    },
    async generateBundle() {
      for (const directory of directories) {
        for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${directory}/${entry.name}`,
            source: await readFile(resolve(root, directory, entry.name)),
          });
        }
      }
    },
  };
}
