import { afterEach, expect, test, vi } from "vitest";
import { launchDesktop } from "../../../tests/helpers/desktop.ts";
import { isolateDesktop } from "../../../tests/helpers/desktop-isolation.ts";

const electron = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@playwright/test", () => ({ _electron: electron }));
afterEach(() => vi.resetAllMocks());

test("desktop launching installs isolation before returning the application", async () => {
  vi.stubEnv("ZPI_TEST_SHOW_WINDOW", "0");
  const application = { evaluate: vi.fn(), close: vi.fn() };
  electron.launch.mockResolvedValue(application);
  expect(await launchDesktop({ dir: "/tmp/desktop", url: "" })).toBe(application);
  expect(electron.launch).toHaveBeenCalledExactlyOnceWith({
    args: [expect.stringMatching(/packages[/\\]desktop[/\\]dist[/\\]main[/\\]index\.js$/)],
    env: expect.objectContaining({
      ZPI_TEST_MODE: "1",
      ZPI_TEST_SHOW_WINDOW: "0",
      ZPI_TEST_DATA_DIR: "/tmp/desktop",
      HOME: "/tmp/desktop",
    }),
  });
  expect(application.evaluate).toHaveBeenCalledExactlyOnceWith(isolateDesktop);
  expect(application.close).not.toHaveBeenCalled();
});

test("failed isolation closes the launched process and preserves the setup error", async () => {
  const error = new Error("isolation failed");
  const application = {
    evaluate: vi.fn().mockRejectedValue(error),
    close: vi.fn().mockRejectedValue(new Error("process already exited")),
  };
  electron.launch.mockResolvedValue(application);
  await expect(launchDesktop({ dir: "/tmp/desktop", url: "" })).rejects.toBe(error);
  expect(application.close).toHaveBeenCalledExactlyOnceWith();
});
