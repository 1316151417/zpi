// Run after build and macOS packaging. Checks source, built and asar asset bytes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractFile } from "@electron/asar";

const reference = resolve(process.argv[2] ?? "/Users/jiezhou/VSCodeProjects/ZCode");
const archive = resolve(process.argv[3] ?? "release/mac-arm64/ZPI.app/Contents/Resources/app.asar");
const source = "packages/desktop/src/renderer/public/material-icons";
const built = "packages/desktop/dist/renderer/material-icons";
const files = (await readdir(source)).filter((file) => file.endsWith(".svg")).sort();
const digest = createHash("sha256");
for (const file of files) {
  const original = await readFile(join(reference, source, file));
  const local = await readFile(join(source, file));
  const dist = await readFile(join(built, file));
  const packed = extractFile(archive, `${built}/${file}`);
  if (![local, dist, packed].every((bytes) => bytes.equals(original)))
    throw new Error(`Asset mismatch: ${file}`);
  digest.update(file).update("\0").update(original);
}
const result = {
  referenceSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: reference, encoding: "utf8" }).trim(),
  source,
  built,
  archive,
  svgCount: files.length,
  allByteIdentical: true,
  manifestSha256: digest.digest("hex"),
};
const destination = "docs/evidence/preview-sidebar/assets.json";
await mkdir("docs/evidence/preview-sidebar", { recursive: true });
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`);
console.log(result);
