import { execFile } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

export async function buildMacCapture() {
  if (process.platform !== "darwin") return;
  const output = resolve("packages/desktop/dist/native");
  await mkdir(output, { recursive: true });
  await promisify(execFile)("xcrun", [
    "clang",
    "-fobjc-arc",
    "-mmacosx-version-min=12.0",
    "-O2",
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "packages/desktop/native/copy-selection.m",
    "-o",
    `${output}/copy-selection.tmp`,
  ]);
  await rename(`${output}/copy-selection.tmp`, `${output}/copy-selection`);
  await rm(`${output}/selected-text`, { force: true });
}
