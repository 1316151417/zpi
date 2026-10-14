import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { expect, test } from "vitest";
import { mainBuild } from "../../../scripts/desktop-build.mjs";

test("desktop bundling retains node:sqlite's mandatory builtin namespace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zpi-sqlite-build-"));
  try {
    const entry = join(directory, "sqlite-probe.ts");
    await writeFile(
      entry,
      'import { DatabaseSync } from "node:sqlite"; export function probe() { const db = new DatabaseSync(":memory:"); try { return db.prepare("SELECT 42 AS value").get().value; } finally { db.close(); } }',
    );
    await build({
      ...mainBuild,
      entry: [entry],
      outDir: join(directory, "out"),
      format: ["cjs"],
      banner: undefined,
      sourcemap: false,
      silent: true,
    });
    const output = join(directory, "out", "sqlite-probe.cjs");
    expect(await readFile(output, "utf8")).toContain('require("node:sqlite")');
    expect(createRequire(import.meta.url)(output).probe()).toBe(42);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
