import { access, readFile, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { isolateUnitEnvironment } from "../../../tests/helpers/unit-environment.ts";
import { createBashToolDefinition } from "../src/core/tools/pi/bash.ts";

const importedTemp = tmpdir();
afterAll(async () => {
  // Isolation starts before module imports and outlives all test-owned hooks.
  expect(tmpdir()).toBe(importedTemp);
  expect(basename(dirname(importedTemp))).toMatch(/^zpi-unit-/);
  await access(importedTemp);
});

it("isolates shell homes, startup hooks and temp paths, then restores the inherited environment", async () => {
  const env = { HOME: "/original", TMP: "/old-temp", BASH_ENV: "/profile", ENV: "/startup", PATH: "/bin" };
  const original = { ...env };
  const isolated = isolateUnitEnvironment(env);
  try {
    expect(env).toMatchObject({
      HOME: join(isolated.root, "home"),
      USERPROFILE: join(isolated.root, "home"),
      ZDOTDIR: join(isolated.root, "home"),
      TMPDIR: join(isolated.root, "tmp"),
      TMP: join(isolated.root, "tmp"),
      TEMP: join(isolated.root, "tmp"),
      PATH: "/bin",
    });
    expect(env).not.toHaveProperty("BASH_ENV");
    expect(env).not.toHaveProperty("ENV");
  } finally {
    await isolated.close();
  }
  expect(env).toEqual(original);
  await expect(access(isolated.root)).rejects.toMatchObject({ code: "ENOENT" });
});

it("bash log pruning stays inside the private test temp directory even with mocked execution", async () => {
  const temp = tmpdir();
  const root = dirname(temp);
  // Fail before writing anything if the global test setup is accidentally removed.
  expect(basename(root)).toMatch(/^zpi-unit-/);
  expect(basename(temp)).toBe("tmp");
  expect(homedir()).toBe(join(root, "home"));
  const name = "zpi-bash-0123456789abcdef.log";
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const outside = join(root, name);
  const inside = join(temp, name);
  for (const file of [outside, inside]) {
    await writeFile(file, "owned test fixture");
    await utimes(file, expired, expired);
  }
  const tool = createBashToolDefinition(temp, { operations: { exec: async () => ({ exitCode: 0 }) } });
  await tool.execute("isolation", { command: "unused: execution is mocked" });
  await expect(access(inside)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(outside, "utf8")).toBe("owned test fixture");
});
