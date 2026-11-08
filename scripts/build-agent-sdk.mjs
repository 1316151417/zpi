import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "tsup";

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  entry: { index: `${root}packages/agent-sdk/src/index.ts`, host: `${root}packages/agent-sdk/src/host.ts` },
  outDir: `${root}packages/agent-sdk/dist`,
  format: ["esm"],
  target: "node24",
  bundle: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  external: ["sharp", "typebox", "typebox/value"],
  noExternal: [
    /^@zpi-dev\//,
    "yaml",
    "diff",
    "openai",
    "ws",
    "https-proxy-agent",
    "socks-proxy-agent",
    "bmp-js",
  ],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});

// TypeScript 7 emits declarations without requiring the legacy compiler API used by DTS bundlers.
const temporary = await mkdtemp(join(tmpdir(), "zpi-sdk-types-"));
try {
  const config = join(temporary, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        lib: ["ES2024", "DOM", "DOM.Iterable"],
        typeRoots: [join(root, "node_modules/@types")],
        rootDir: join(root, "packages"),
        outDir: join(temporary, "types"),
      },
      include: ["agent-sdk", "agent", "ai", "coding-agent", "plugin-compat"].map((name) =>
        join(root, `packages/${name}/src/**/*.ts`),
      ),
    }),
  );
  await promisify(execFile)(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", config], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const types = join(root, "packages/agent-sdk/dist/types");
  await cp(join(temporary, "types"), types, { recursive: true });
  const manifests = new Map();
  for (const directory of await readdir(join(root, "packages"))) {
    const manifest = JSON.parse(await readFile(join(root, "packages", directory, "package.json"), "utf8"));
    manifests.set(manifest.name, { directory, exports: manifest.exports });
  }
  async function rewrite(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await rewrite(path);
        continue;
      }
      if (!entry.name.endsWith(".d.ts")) continue;
      const content = (await readFile(path, "utf8"))
        .replace(/(["'])(@zpi-dev\/[^"']+)\1/g, (_match, quote, specifier) => {
          const parts = specifier.split("/"),
            name = parts.slice(0, 2).join("/"),
            subpath = parts.slice(2),
            manifest = manifests.get(name);
          if (!manifest) throw new Error(`Unknown SDK type dependency: ${name}`);
          let target = manifest.exports[subpath.length ? `./${subpath.join("/")}` : "."];
          if (typeof target !== "string") target = target.development;
          const file = join(types, manifest.directory, target.replace(/\.tsx?$/, ".js"));
          const importPath = relative(dirname(path), file).replaceAll("\\", "/");
          return `${quote}${importPath.startsWith(".") ? importPath : `./${importPath}`}${quote}`;
        })
        .replace(/(["'])(\.{1,2}\/[^"']+)\.tsx?\1/g, "$1$2.js$1");
      await writeFile(path, content);
    }
  }
  await rewrite(types);
  for (const entry of ["index", "host"])
    await writeFile(
      join(root, `packages/agent-sdk/dist/${entry}.d.ts`),
      `export * from "./types/agent-sdk/src/${entry}.js";\n`,
    );
  await mkdir(join(root, "packages/agent-sdk"), { recursive: true });
  await cp(join(root, "licenses/third-party-notices.txt"), join(root, "packages/agent-sdk/NOTICE"));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
