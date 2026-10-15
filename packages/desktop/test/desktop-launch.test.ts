import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { closeDesktops, launchDesktop } from "../../../tests/helpers/desktop.ts";
import { automationContract } from "../../../tests/helpers/desktop-isolation.ts";

const electron = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@playwright/test", () => ({ _electron: electron }));
vi.mock("../../../tests/helpers/electron-executable.ts", () => ({
  electronExecutable: async (_dir: string, main: string) => {
    const { readFile } = await import("node:fs/promises");
    if (!(await readFile(main, "utf8")).includes("zpi-desktop-isolation-v2"))
      throw new Error("automation contract");
    return { args: [main] };
  },
}));
afterEach(() => vi.resetAllMocks());
async function fixture() {
  const scope = await mkdtemp(join(tmpdir(), "launch-"));
  const dir = await mkdtemp(join(scope, "data-"));
  const entry = join(scope, "main.cjs");
  await writeFile(entry, automationContract);
  vi.stubEnv("ZPI_TEST_SCOPE", scope);
  return { dir, url: "", entry };
}

test("refuses data outside the owned scope before starting Electron", async () => {
  const input = await fixture();
  await expect(launchDesktop({ ...input, dir: tmpdir() })).rejects.toThrow("inside the current test scope");
  expect(electron.launch).not.toHaveBeenCalled();
});

test("rejects stale entry points before starting Electron", async () => {
  const input = await fixture();
  await writeFile(input.entry, "old build");
  await expect(launchDesktop(input)).rejects.toThrow("automation contract");
  expect(electron.launch).not.toHaveBeenCalled();
});

test("verifies startup isolation and automatically closes each launch once", async () => {
  const input = await fixture();
  const close = vi.fn();
  const application = {
    evaluate: vi.fn().mockResolvedValueOnce(automationContract).mockResolvedValue([]),
    close,
  };
  electron.launch.mockResolvedValue(application);
  expect(await launchDesktop(input)).toBe(application);
  expect(electron.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: input.dir,
      timeout: 15000,
      env: expect.objectContaining({ HOME: input.dir, ZPI_TEST_MODE: "1", ZPI_TEST_INTERACTIVE: "0" }),
    }),
  );
  await closeDesktops();
  await application.close();
  expect(close).toHaveBeenCalledTimes(1);
});

test("failed startup verification closes Electron and preserves the setup error", async () => {
  const error = new Error("isolation failed");
  const close = vi.fn().mockRejectedValue(new Error("already exited"));
  electron.launch.mockResolvedValue({ evaluate: vi.fn().mockRejectedValue(error), close });
  await expect(launchDesktop(await fixture())).rejects.toBe(error);
  expect(close).toHaveBeenCalledOnce();
});

test("caught native-action violations still fail cleanup", async () => {
  const close = vi.fn();
  electron.launch.mockResolvedValue({
    evaluate: vi.fn().mockResolvedValueOnce(automationContract).mockResolvedValue(["window.show"]),
    close,
  });
  await launchDesktop(await fixture());
  await expect(closeDesktops()).rejects.toThrow("Desktop cleanup failed");
  expect(close).toHaveBeenCalledOnce();
});
