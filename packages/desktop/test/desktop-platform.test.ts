import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("the desktop launcher rejects Windows before loading Electron or application data", () => {
  const launcher = new URL("../bin/cli.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `Object.defineProperty(process, "platform", { value: "win32" }); await import(${JSON.stringify(launcher)});`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe(
    "zpi-desktop does not support Windows. The Agent SDK remains cross-platform.",
  );
});
